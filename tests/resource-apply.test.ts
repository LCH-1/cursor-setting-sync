import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import type { CursorPaths } from "../src/platform/paths";
import type { JsonValue } from "../src/types";
import type { PreparedHelperChange } from "../src/helper/database";
import type { HelperBackup, HelperRequest } from "../src/helper/types";
import {
  applyNonGlobalChanges,
  CursorReopenedError,
} from "../src/helper/resourceApply";
import { readStoreSnapshot } from "../src/chat/storeDb";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import {
  captureWorkspaceDatabaseSnapshot,
  serializeWorkspaceDatabaseSnapshot,
} from "../src/helper/workspaceDatabaseMerge";
import { workspaceStorageResourceId } from "../src/resources/workspaceStorage";

const temporaryRoots: string[] = [];
const { DatabaseSync } = sqlite;
const describeWithBackup =
  typeof sqlite.backup === "function" ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("non-global resource apply", () => {
  it("skips a failing change and still applies the rest of the batch", async () => {
    const fixture = await createFixture();
    const badResourceId = `chat-transcript/${encodeURIComponent("a/b.txt")}`;
    const storeRelativePath = "chats/session-a/store.db";
    const storeResourceId = `chat-store/${encodeURIComponent(storeRelativePath)}`;

    const result = await applyNonGlobalChanges(fixture.request, [
      {
        change: {
          eventHash: "1".repeat(64),
          changeIndex: 0,
          resourceId: badResourceId,
          kind: "chat-transcript",
          operation: "put",
          semanticHash: "hash",
          metadata: { relativePath: "a/b.txt" },
        },
        content: Buffer.from("transcript", "utf8"),
      },
      storeChange(storeResourceId, storeRelativePath, [
        { key: "shared", value: { type: "text", value: "remote" } },
      ]),
    ]);

    expect(result.applied).toEqual([storeResourceId]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain(badResourceId);
    expect(result.skipped[0]).toContain("not allowlisted");
    const storePath = join(
      fixture.paths.cursorHome,
      ...storeRelativePath.split("/"),
    );
    expect(readMetaValue(storePath, "shared")).toBe("remote");
  });

  it("skips unsafe workspaceStorage metadata without applying or writing", async () => {
    const fixture = await createFixture();
    const relativePath = "workspace-a/../outside.json";

    const result = await applyNonGlobalChanges(fixture.request, [
      {
        change: {
          eventHash: "5".repeat(64),
          changeIndex: 0,
          resourceId: workspaceStorageResourceId(relativePath),
          kind: "workspace-storage",
          operation: "put",
          semanticHash: "hash",
          metadata: { relativePath, workspaceId: "workspace-a" },
        },
        content: Buffer.from("outside", "utf8"),
      },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("workspaceStorage metadata does not match");
    await expect(
      stat(join(fixture.paths.userDataRoot, "outside.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts without swallowing the error when Cursor is reopened", async () => {
    const fixture = await createFixture();
    const storeRelativePath = "chats/session-a/store.db";
    const storeResourceId = `chat-store/${encodeURIComponent(storeRelativePath)}`;

    await expect(
      applyNonGlobalChanges(
        fixture.request,
        [
          storeChange(storeResourceId, storeRelativePath, [
            { key: "shared", value: { type: "text", value: "remote" } },
          ]),
        ],
        async () => {
          throw new CursorReopenedError("Cursor was reopened before offline changes could be applied.");
        },
      ),
    ).rejects.toThrow("Cursor was reopened");

    const storePath = join(
      fixture.paths.cursorHome,
      ...storeRelativePath.split("/"),
    );
    await expect(stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not retain a local hash when the applied store equals the snapshot", async () => {
    const fixture = await createFixture();
    const storeRelativePath = "chats/session-a/store.db";
    const storeResourceId = `chat-store/${encodeURIComponent(storeRelativePath)}`;

    const result = await applyNonGlobalChanges(fixture.request, [
      storeChange(storeResourceId, storeRelativePath, [
        { key: "alpha", value: { type: "text", value: "one" } },
        { key: "beta", value: { type: "text", value: "two" } },
      ]),
    ]);

    expect(result.applied).toEqual([storeResourceId]);
    expect(result.retainedLocal).toEqual([]);
    expect(result.retainedLocalHashes).toEqual({});
  });

  it("treats uninstalling an absent extension as applied and isolates other CLI failures", async () => {
    const fixture = await createFixture();
    fixture.request.cursorExecutable = process.execPath;
    await mkdir(join(fixture.paths.appRoot, "out"), { recursive: true });
    await writeFile(
      join(fixture.paths.appRoot, "out", "cli.js"),
      [
        "const args = process.argv.slice(2);",
        "const id = args[args.indexOf('--uninstall-extension') + 1];",
        "if (id === 'not.installed') {",
        "  process.stderr.write(\"Extension 'not.installed' is not installed.\\n\");",
        "  process.exit(1);",
        "}",
        "process.stderr.write('marketplace unreachable\\n');",
        "process.exit(2);",
      ].join("\n"),
      "utf8",
    );
    const absentResourceId = "extension/default/not.installed";
    const brokenResourceId = "extension/default/broken.cli";

    const result = await applyNonGlobalChanges(fixture.request, [
      extensionDelete(absentResourceId, "not.installed"),
      extensionDelete(brokenResourceId, "broken.cli"),
    ]);

    expect(result.applied).toEqual([absentResourceId]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain(brokenResourceId);
    expect(result.skipped[0]).toContain("marketplace unreachable");
  });

  it("skips an invalid extension change and still applies the rest of the batch", async () => {
    const fixture = await createFixture();
    fixture.request.cursorExecutable = process.execPath;
    await mkdir(join(fixture.paths.appRoot, "out"), { recursive: true });
    await writeFile(
      join(fixture.paths.appRoot, "out", "cli.js"),
      [
        "process.stderr.write(\"Extension 'not.installed' is not installed.\\n\");",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );
    const invalidResourceId = "extension/default/invalid..id";
    const absentResourceId = "extension/default/not.installed";

    const result = await applyNonGlobalChanges(fixture.request, [
      extensionDelete(invalidResourceId, "invalid..id"),
      extensionDelete(absentResourceId, "not.installed"),
    ]);

    expect(result.applied).toEqual([absentResourceId]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain(invalidResourceId);
    expect(result.skipped[0]).toContain("Invalid extension identifier");
  });

  it("re-checks exclusivity before the enablement write and aborts fatally", async () => {
    const fixture = await createFixture();
    fixture.request.cursorExecutable = process.execPath;
    await mkdir(join(fixture.paths.appRoot, "out"), { recursive: true });
    await writeFile(
      join(fixture.paths.appRoot, "out", "cli.js"),
      "process.exit(0);",
      "utf8",
    );
    let exclusiveChecks = 0;

    await expect(
      applyNonGlobalChanges(
        fixture.request,
        [extensionPut("extension/default/some.extension", "some.extension")],
        async () => {
          exclusiveChecks += 1;
          if (exclusiveChecks > 1) {
            throw new CursorReopenedError(
              "Cursor was reopened before offline changes could be applied.",
            );
          }
        },
      ),
    ).rejects.toThrow("Cursor was reopened");

    expect(exclusiveChecks).toBe(2);
  });
});

describeWithBackup("extension enablement over a NULL disabled list", () => {
  it("applies enablement and leaves an untouched NULL row alone", async () => {
    const fixture = await createFixture();
    await createProfileDatabase(fixture.paths.globalDatabase, null);
    await stubCursorCli(fixture);
    const resourceId = "extension/default/some.extension";

    const result = await applyNonGlobalChanges(fixture.request, [
      extensionPut(resourceId, "some.extension"),
    ]);

    expect(result.applied).toEqual([resourceId]);
    expect(
      readItemTableType(
        fixture.paths.globalDatabase,
        "extensionsIdentifiers/disabled",
      ),
    ).toBe("null");
  });

  it("writes a real JSON array when disabling over a NULL row", async () => {
    const fixture = await createFixture();
    await createProfileDatabase(fixture.paths.globalDatabase, null);
    await stubCursorCli(fixture);
    const resourceId = "extension/default/some.extension";

    const result = await applyNonGlobalChanges(fixture.request, [
      extensionPut(resourceId, "some.extension", false),
    ]);

    expect(result.applied).toEqual([resourceId]);
    expect(
      readItemTableValue(
        fixture.paths.globalDatabase,
        "extensionsIdentifiers/disabled",
      ),
    ).toBe(JSON.stringify([{ id: "some.extension" }]));
  });

  it("takes no database backup when the row already says what is being applied", async () => {
    // `backupDatabase` copies the whole file - 1,239 MiB on a real user's
    // global database - and this ran once per extension inside the install
    // loop, before even reading the row it might change. A request touching a
    // dozen extensions therefore wrote a dozen full copies and blew the entire
    // 2 GiB retention budget, evicting the global apply's own backup with it.
    // Almost none of them protected anything: an extension arrives enabled and
    // is simply absent from the disabled list, so there was nothing to change.
    const fixture = await createFixture();
    await createProfileDatabase(fixture.paths.globalDatabase, null);
    await stubCursorCli(fixture);

    const result = await applyNonGlobalChanges(fixture.request, [
      extensionPut("extension/default/some.extension", "some.extension"),
    ]);

    expect(result.applied).toEqual(["extension/default/some.extension"]);
    expect(result.backups).toEqual([]);
  });

  it("still takes one when the row does have to change", async () => {
    const fixture = await createFixture();
    await createProfileDatabase(fixture.paths.globalDatabase, null);
    await stubCursorCli(fixture);

    const result = await applyNonGlobalChanges(fixture.request, [
      extensionPut("extension/default/some.extension", "some.extension", false),
    ]);

    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]?.targetPath).toBe(fixture.paths.globalDatabase);
  });
});

describeWithBackup("non-global resource apply with backups", () => {
  it("records the union hash when a store apply retains local-only rows", async () => {
    const fixture = await createFixture();
    const storeRelativePath = "chats/session-a/store.db";
    const storeResourceId = `chat-store/${encodeURIComponent(storeRelativePath)}`;
    const storePath = join(
      fixture.paths.cursorHome,
      ...storeRelativePath.split("/"),
    );
    await createStoreDatabase(storePath, [
      ["local-only", "preserved"],
      ["shared", "local"],
    ]);

    const result = await applyNonGlobalChanges(fixture.request, [
      storeChange(storeResourceId, storeRelativePath, [
        { key: "shared", value: { type: "text", value: "remote" } },
      ]),
    ]);

    expect(result.applied).toEqual([storeResourceId]);
    expect(result.retainedLocal).toContain(storeResourceId);
    const unionHash = sha256(
      canonicalBytes(readStoreSnapshot(storePath, storeRelativePath)),
    );
    expect(result.retainedLocalHashes[storeResourceId]).toBe(unionHash);
    expect(readMetaValue(storePath, "local-only")).toBe("preserved");
    expect(readMetaValue(storePath, "shared")).toBe("remote");
  });

  it("keeps backup names unique when two remote workspaces map to one local workspace", async () => {
    const fixture = await createFixture();
    fixture.request.workspaceMappings = {
      "remote-a": "workspace-local",
      "remote-b": "workspace-local",
    };
    const targetPath = join(
      fixture.paths.workspaceStorageRoot,
      "workspace-local",
      "state.vscdb",
    );
    await mkdir(join(targetPath, ".."), { recursive: true });
    await writeFile(
      join(fixture.paths.workspaceStorageRoot, "workspace-local", "workspace.json"),
      JSON.stringify({ folder: "file:///C:/projects/local" }),
      "utf8",
    );
    await createWorkspaceDatabase(targetPath, "local-key", "kept");

    // Portable ItemTable keys: chrome would be filtered before the write, and
    // this test needs each apply to leave a visible row behind.
    const result = await applyNonGlobalChanges(fixture.request, [
      await workspaceDatabaseChange(fixture, "remote-a", "notepadData"),
      await workspaceDatabaseChange(fixture, "remote-b", "interactive.sessions"),
    ]);

    expect(result.applied).toEqual([
      workspaceStorageResourceId("remote-a/state.vscdb"),
      workspaceStorageResourceId("remote-b/state.vscdb"),
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.backups).toHaveLength(2);
    const backupPaths = result.backups.map((backup) => backup.backupPath);
    expect(new Set(backupPaths).size).toBe(2);
    for (const backupPath of backupPaths) {
      await expect(stat(backupPath)).resolves.toBeDefined();
    }
    expect(readItemTableValue(targetPath, "local-key")).toBe("kept");
    expect(readItemTableValue(targetPath, "notepadData")).toBe("value");
    expect(readItemTableValue(targetPath, "interactive.sessions")).toBe("value");
  });

  it("registers earlier backups with the caller before a mid-batch abort", async () => {
    const fixture = await createFixture();
    const firstRelativePath = "chats/session-a/store.db";
    const firstResourceId = `chat-store/${encodeURIComponent(firstRelativePath)}`;
    const secondRelativePath = "chats/session-b/store.db";
    const secondResourceId = `chat-store/${encodeURIComponent(secondRelativePath)}`;
    const firstStorePath = join(
      fixture.paths.cursorHome,
      ...firstRelativePath.split("/"),
    );
    await createStoreDatabase(firstStorePath, [["shared", "local"]]);
    const collected: HelperBackup[] = [];
    let exclusiveChecks = 0;

    await expect(
      applyNonGlobalChanges(
        fixture.request,
        [
          storeChange(firstResourceId, firstRelativePath, [
            { key: "shared", value: { type: "text", value: "remote" } },
          ]),
          storeChange(secondResourceId, secondRelativePath, [
            { key: "shared", value: { type: "text", value: "remote" } },
          ]),
        ],
        async () => {
          exclusiveChecks += 1;
          if (exclusiveChecks > 1) {
            throw new CursorReopenedError(
              "Cursor was reopened before offline changes could be applied.",
            );
          }
        },
        (backup) => collected.push(backup),
      ),
    ).rejects.toThrow("Cursor was reopened");

    expect(collected).toHaveLength(1);
    expect(collected[0]?.contract).toBe("store");
    expect(collected[0]?.targetPath).toBe(firstStorePath);
    await expect(stat(collected[0]?.backupPath ?? "")).resolves.toBeDefined();
  });
});

interface StoreMetaRow {
  key: string;
  value: { type: "text"; value: string };
}

function storeChange(
  resourceId: string,
  relativePath: string,
  meta: StoreMetaRow[],
): PreparedHelperChange {
  const snapshot = {
    schemaVersion: 1,
    relativePath,
    meta,
    blobs: [],
  };
  const content = canonicalBytes(snapshot);
  return {
    change: {
      eventHash: "2".repeat(64),
      changeIndex: 0,
      resourceId,
      kind: "chat-store",
      operation: "put",
      semanticHash: sha256(content),
    },
    content,
  };
}

function extensionDelete(
  resourceId: string,
  extensionId: string,
): PreparedHelperChange {
  return {
    change: {
      eventHash: "3".repeat(64),
      changeIndex: 0,
      resourceId,
      kind: "extension",
      operation: "delete",
      semanticHash: "hash",
      metadata: {
        extensionId,
        profileId: "default",
        profileName: "Default",
      } satisfies Record<string, JsonValue>,
    },
  };
}

function extensionPut(
  resourceId: string,
  extensionId: string,
  enabled = true,
): PreparedHelperChange {
  return {
    change: {
      eventHash: "6".repeat(64),
      changeIndex: 0,
      resourceId,
      kind: "extension",
      operation: "put",
      semanticHash: "hash",
      metadata: {
        extensionId,
        profileId: "default",
        profileName: "Default",
      } satisfies Record<string, JsonValue>,
    },
    content: Buffer.from(
      JSON.stringify({
        id: extensionId,
        version: "latest",
        installed: true,
        enabled,
        preRelease: false,
        pinned: false,
      }),
      "utf8",
    ),
  };
}

async function workspaceDatabaseChange(
  fixture: { request: HelperRequest; paths: CursorPaths },
  workspaceId: string,
  key: string,
): Promise<PreparedHelperChange> {
  const sourcePath = join(
    fixture.paths.extensionStorage,
    `incoming-${workspaceId}.vscdb`,
  );
  await createWorkspaceDatabase(sourcePath, key, "value");
  const content = serializeWorkspaceDatabaseSnapshot(
    captureWorkspaceDatabaseSnapshot(sourcePath, { workspaceId }).snapshot,
  );
  const relativePath = `${workspaceId}/state.vscdb`;
  return {
    change: {
      eventHash: "4".repeat(64),
      changeIndex: 0,
      resourceId: workspaceStorageResourceId(relativePath),
      kind: "workspace-storage",
      operation: "put",
      semanticHash: "hash",
      metadata: { relativePath, workspaceId },
    },
    content,
  };
}

async function createStoreDatabase(
  path: string,
  rows: Array<[string, string]>,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    for (const [key, value] of rows) {
      database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(key, value);
    }
  } finally {
    database.close();
  }
}

async function createWorkspaceDatabase(
  path: string,
  key: string,
  value: string,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    database.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    database.prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)").run(key, value);
  } finally {
    database.close();
  }
}

function readMetaValue(path: string, key: string): string | null {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: Uint8Array | string } | undefined;
    return row?.value === undefined
      ? null
      : typeof row.value === "string"
        ? row.value
        : Buffer.from(row.value).toString("utf8");
  } finally {
    database.close();
  }
}

async function createProfileDatabase(
  path: string,
  disabled: string | null,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("extensionsIdentifiers/disabled", disabled);
  } finally {
    database.close();
  }
}

async function stubCursorCli(fixture: {
  request: HelperRequest;
  paths: CursorPaths;
}): Promise<void> {
  fixture.request.cursorExecutable = process.execPath;
  await mkdir(join(fixture.paths.appRoot, "out"), { recursive: true });
  await writeFile(
    join(fixture.paths.appRoot, "out", "cli.js"),
    "process.exit(0);",
    "utf8",
  );
}

function readItemTableType(path: string, key: string): string | undefined {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT typeof(value) AS type FROM ItemTable WHERE key = ?")
      .get(key) as { type?: string } | undefined;
    return row?.type;
  } finally {
    database.close();
  }
}

function readItemTableValue(path: string, key: string): string | null {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(key) as { value?: Uint8Array | string } | undefined;
    return row?.value === undefined
      ? null
      : typeof row.value === "string"
        ? row.value
        : Buffer.from(row.value).toString("utf8");
  } finally {
    database.close();
  }
}

async function createFixture(): Promise<{
  request: HelperRequest;
  paths: CursorPaths;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-resource-apply-test-"));
  temporaryRoots.push(root);
  const userDataRoot = join(root, "User");
  const cursorHome = join(root, ".cursor");
  const extensionStorage = join(root, "extension-storage");
  await mkdir(extensionStorage, { recursive: true });
  await mkdir(cursorHome, { recursive: true });
  const paths: CursorPaths = {
    appRoot: root,
    userDataRoot,
    globalStorageRoot: join(userDataRoot, "globalStorage"),
    globalDatabase: join(userDataRoot, "globalStorage", "state.vscdb"),
    workspaceStorageRoot: join(userDataRoot, "workspaceStorage"),
    profilesRoot: join(userDataRoot, "profiles"),
    snippetsRoot: join(userDataRoot, "snippets"),
    promptsRoot: join(userDataRoot, "prompts"),
    userTasks: join(userDataRoot, "tasks.json"),
    userMcp: join(userDataRoot, "mcp.json"),
    cursorHome,
    cursorMcp: join(cursorHome, "mcp.json"),
    cursorCliConfig: join(cursorHome, "cli-config.json"),
    cursorCommands: join(cursorHome, "commands"),
    cursorSkills: join(cursorHome, "skills"),
    cursorRules: join(cursorHome, "rules"),
    cursorProjects: join(cursorHome, "projects"),
    cursorChats: join(cursorHome, "chats"),
    cursorAcpSessions: join(cursorHome, "acp-sessions"),
    cursorExtensionsManifest: join(cursorHome, "extensions", "extensions.json"),
    extensionStorage,
    helperScript: join(root, "helper.js"),
  };
  const request: HelperRequest = {
    version: 1,
    requestId: "00000000-0000-4000-8000-000000000030",
    mode: "apply-and-restart",
    createdAt: "2026-07-21T00:00:00.000Z",
    repositoryRoot: join(root, "repository"),
    storageRoot: extensionStorage,
    cursorExecutable: "Cursor.exe",
    extensionHostPid: 1,
    restart: false,
    expectedCursorVersion: "3.11.19",
    expectedVscodeVersion: "1.125.0",
    extensionVersion: "0.0.1",
    paths,
    changes: [],
    workspaceMappings: {},
    syncOptions: {
      ignoredSettings: [],
      ignoredExtensions: [],
      machineScopedSettings: [],
      syncChat: true,
      syncWorkspaceStorage: true,
      maxPayloadBytes: 128 * 1024 * 1024,
    },
  };
  return { request, paths };
}
