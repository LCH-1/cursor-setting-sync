import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import type { PreparedHelperChange } from "../src/helper/database";
import { applyNonGlobalChanges } from "../src/helper/resourceApply";
import type { HelperRequest } from "../src/helper/types";
import type { CursorPaths } from "../src/platform/paths";
import {
  isBackedUpWorkspaceStorageFile,
  isTransientWorkspaceStorageFile,
  validateWorkspaceStorageRelativePath,
  WorkspaceStorageAdapter,
  workspaceStorageResourceId,
} from "../src/resources/workspaceStorage";
import type { JsonValue, LocalProjection } from "../src/types";
import {
  normalizeWorkspaceUri,
  resolveTargetWorkspace,
} from "../src/chat/workspace";
import {
  captureWorkspaceDatabaseSnapshot,
  parseWorkspaceDatabaseSnapshot,
  serializeWorkspaceDatabaseSnapshot,
} from "../src/helper/workspaceDatabaseMerge";

const temporaryRoots: string[] = [];
const describeWithSqliteBackup =
  typeof sqlite.backup === "function" ? describe : describe.skip;
const describeWithSqlite =
  typeof sqlite.DatabaseSync === "function" ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("workspaceStorage backup boundaries", () => {
  it.each([
    "workspace-a/state.vscdb",
    "workspace-a/notepads.json",
    "workspace-a/images/image.png",
    "workspace-a/images/nested/image.png",
  ])("backs up allowlisted file %s", (relativePath) => {
    expect(isBackedUpWorkspaceStorageFile(relativePath)).toBe(true);
  });

  it.each([
    "workspace-a/state.vscdb-wal",
    "workspace-a/state.vscdb-shm",
    "workspace-a/state.vscdb-journal",
    "workspace-a/state.vscdb.backup",
    "workspace-a/workspace.json",
    "workspace-a/workspace.json.tmp",
    "workspace-a/anysphere.cursor-browser-extension/session.json",
    "workspace-a/anysphere.cursor-retrieval/cache.bin",
    "workspace-a/ms-vscode.js-debug/debug.json",
  ])("excludes transient or non-allowlisted file %s", (relativePath) => {
    expect(isBackedUpWorkspaceStorageFile(relativePath)).toBe(false);
  });

  it.each([
    "../outside.json",
    "workspace-a/../outside.json",
    "workspace-a\\workspace.json",
    "workspace-a//workspace.json",
    "workspace-a/CON.txt",
    "invalid workspace/workspace.json",
  ])("rejects unsafe workspace path %s", (relativePath) => {
    expect(() =>
      validateWorkspaceStorageRelativePath("C:/Cursor/User/workspaceStorage", relativePath),
    ).toThrow();
  });

  it("identifies transient database sidecars and temporary files", () => {
    expect(isTransientWorkspaceStorageFile("workspace-a/state.vscdb-wal")).toBe(true);
    expect(isTransientWorkspaceStorageFile("workspace-a/file.partial")).toBe(true);
    expect(isTransientWorkspaceStorageFile("workspace-a/notepads.json")).toBe(false);
  });
});

describe("workspace identity mapping", () => {
  const local = [
    {
      id: "local-workspace",
      uri: "file:///D:/personal/demo",
      basename: "demo",
    },
  ];

  it("maps only exact URIs or explicit IDs", () => {
    expect(
      resolveTargetWorkspace(
        "remote-workspace",
        "file:///D:/personal/demo",
        local,
        {},
      ),
    ).toBe("local-workspace");
    expect(
      resolveTargetWorkspace(
        "remote-workspace",
        "file:///C:/client/demo",
        local,
        { "remote-workspace": "local-workspace" },
      ),
    ).toBe("local-workspace");
  });

  it("never guesses from a matching basename", () => {
    expect(
      resolveTargetWorkspace(
        "remote-workspace",
        "file:///C:/client/demo",
        local,
        {},
      ),
    ).toBeNull();
  });

  it("normalizes workspace URIs per platform", () => {
    expect(normalizeWorkspaceUri("file:///C:\\Projects\\App/", "win32")).toBe(
      "file:///c:/projects/app",
    );
    expect(normalizeWorkspaceUri("file:///Users/U/App/", "darwin")).toBe(
      "file:///users/u/app",
    );
    expect(normalizeWorkspaceUri("file:///Users/A\\B", "darwin")).toBe(
      "file:///users/a\\b",
    );
    expect(normalizeWorkspaceUri("file:///home/U/App/", "linux")).toBe(
      "file:///home/U/App",
    );
    expect(normalizeWorkspaceUri("file:///home/u/a\\b", "linux")).toBe(
      "file:///home/u/a\\b",
    );
  });

  it("matches workspace URIs case-sensitively on Linux only", () => {
    const linuxLocal = [
      { id: "linux-workspace", uri: "file:///home/user/demo", basename: "demo" },
    ];
    expect(
      resolveTargetWorkspace(
        "remote-workspace",
        "file:///home/USER/demo",
        linuxLocal,
        {},
        "linux",
      ),
    ).toBeNull();
    expect(
      resolveTargetWorkspace(
        "remote-workspace",
        "file:///home/user/demo",
        linuxLocal,
        {},
        "linux",
      ),
    ).toBe("linux-workspace");
    expect(
      resolveTargetWorkspace(
        "remote-workspace",
        "file:///home/USER/demo",
        linuxLocal,
        {},
        "darwin",
      ),
    ).toBe("linux-workspace");
  });
});

describe("workspaceStorage adapter", () => {
  it("scans only portable workspace state and never emits deletions", async () => {
    const fixture = await createFixture();
    const workspaceRoot = fixture.paths.workspaceStorageRoot;
    await writeFixtureFile(workspaceRoot, "workspace-a/workspace.json", "workspace");
    await writeFixtureFile(workspaceRoot, "workspace-a/notepads.json", "notepads");
    await writeFixtureFile(workspaceRoot, "workspace-a/images/image.png", "png");
    await writeFixtureFile(workspaceRoot, "workspace-a/state.vscdb-wal", "wal");
    await writeFixtureFile(
      workspaceRoot,
      "workspace-a/state.vscdb.backup",
      "backup",
    );
    await writeFixtureFile(
      workspaceRoot,
      "workspace-a/anysphere.cursor-browser-extension/session.json",
      "session",
    );
    const removedRelativePath = "workspace-old/notepads.json";
    const removedResourceId = workspaceStorageResourceId(removedRelativePath);
    const known: Record<string, LocalProjection> = {
      [removedResourceId]: {
        resourceId: removedResourceId,
        kind: "workspace-storage",
        semanticHash: "a".repeat(64),
        versionId: "b".repeat(64),
      },
      "settings/default/editor.fontSize": {
        resourceId: "settings/default/editor.fontSize",
        kind: "settings",
        semanticHash: "c".repeat(64),
        versionId: "d".repeat(64),
      },
    };

    const adapter = new WorkspaceStorageAdapter(fixture.paths);
    const result = await adapter.scan(known);

    expect(adapter.appliesWhileRunning).toBe(false);
    expect(adapter.scanWhileRunning).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(
      result.snapshots.map((snapshot) => snapshot.metadata?.relativePath).sort(),
    ).toEqual([
      "workspace-a/images/image.png",
      "workspace-a/notepads.json",
    ]);
    expect(result.snapshots.map((snapshot) => snapshot.content.toString("utf8")).sort()).toEqual([
      "notepads",
      "png",
    ]);
    expect(result.deletions).toEqual([]);
  });

  it("skips unchanged plain files by source timestamp", async () => {
    const fixture = await createFixture();
    const relativePath = "workspace-a/notepads.json";
    const filePath = await writeFixtureFile(
      fixture.paths.workspaceStorageRoot,
      relativePath,
      "notepads",
    );
    const resourceId = workspaceStorageResourceId(relativePath);
    const known: Record<string, LocalProjection> = {
      [resourceId]: {
        resourceId,
        kind: "workspace-storage",
        semanticHash: "a".repeat(64),
        versionId: "b".repeat(64),
        sourceTimestamp: (await stat(filePath)).mtimeMs,
      },
    };

    const result = await new WorkspaceStorageAdapter(fixture.paths).scan(known);

    expect(result.snapshots).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("canonicalizes mapped workspace IDs and carries identity URI metadata", async () => {
    const fixture = await createFixture();
    const workspaceRoot = fixture.paths.workspaceStorageRoot;
    await writeFixtureFile(
      workspaceRoot,
      "workspace-a/workspace.json",
      JSON.stringify({ folder: "file:///D:/source/demo" }),
    );
    await writeFixtureFile(
      workspaceRoot,
      "workspace-a/notepads.json",
      "source copy",
    );
    await writeFixtureFile(
      workspaceRoot,
      "workspace-b/workspace.json",
      JSON.stringify({ folder: "file:///C:/projects/demo" }),
    );
    await writeFixtureFile(
      workspaceRoot,
      "workspace-b/notepads.json",
      "mapped target copy",
    );

    const result = await new WorkspaceStorageAdapter(fixture.paths, {
      "workspace-a": "workspace-b",
    }).scan({});

    expect(result.warnings).toEqual([
      "workspaceStorage directories workspace-a and workspace-b collide on workspace-a/notepads.json; backing up workspace-b only.",
    ]);
    expect(result.deletions).toEqual([]);
    expect(result.snapshots).toHaveLength(1);
    const snapshot = result.snapshots[0];
    expect(snapshot?.resourceId).toBe(
      workspaceStorageResourceId("workspace-a/notepads.json"),
    );
    expect(snapshot?.kind).toBe("workspace-storage");
    expect(snapshot?.content).toEqual(Buffer.from("mapped target copy", "utf8"));
    expect(snapshot?.metadata?.relativePath).toBe(
      "workspace-a/notepads.json",
    );
    expect(snapshot?.metadata?.workspaceId).toBe("workspace-a");
    expect(snapshot?.metadata?.workspaceUri).toBe("file:///C:/projects/demo");
  });
});

describeWithSqlite("workspaceStorage database snapshot", () => {
  it("captures a consistent state.vscdb snapshot while the source is open", async () => {
    const fixture = await createFixture();
    const relativePath = "workspace-a/state.vscdb";
    const databasePath = join(
      fixture.paths.workspaceStorageRoot,
      "workspace-a",
      "state.vscdb",
    );
    await mkdir(join(databasePath, ".."), { recursive: true });
    const source = new sqlite.DatabaseSync(databasePath);
    source.exec("PRAGMA journal_mode=WAL");
    source.exec("PRAGMA wal_autocheckpoint=0");
    source.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    source.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    source
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("workspace-key", "workspace-value");

    let result;
    try {
      result = await new WorkspaceStorageAdapter(fixture.paths).scan({});
    } finally {
      source.close();
    }

    expect(result.warnings).toEqual([]);
    expect(result.snapshots).toHaveLength(1);
    const snapshot = result.snapshots[0];
    expect(snapshot?.resourceId).toBe(workspaceStorageResourceId(relativePath));
    expect(snapshot?.metadata).toEqual(
      expect.objectContaining({
        relativePath,
        workspaceId: "workspace-a",
        plainBytes: snapshot?.content.byteLength,
      }),
    );

    const captured = parseWorkspaceDatabaseSnapshot(
      snapshot?.content ?? Buffer.alloc(0),
    );
    expect(captured.workspaceId).toBe("workspace-a");
    expect(
      captured.tables
        .find((table) => table.name === "ItemTable")
        ?.rows.find((row) => row.key === "workspace-key"),
    ).toEqual({
      key: "workspace-key",
      values: [{ type: "text", value: "workspace-value" }],
    });
    expect(snapshot?.content.subarray(0, 15).toString("utf8")).not.toContain(
      "SQLite format 3",
    );
  });
});

describe("workspaceStorage offline restore", () => {
  it("atomically restores an allowlisted file and retains it on tombstones", async () => {
    const fixture = await createFixture();
    await writeFixtureFile(
      fixture.paths.workspaceStorageRoot,
      "workspace-a/workspace.json",
      JSON.stringify({ folder: "file:///C:/projects/workspace-a" }),
    );
    const relativePath = "workspace-a/notepads.json";
    const resourceId = workspaceStorageResourceId(relativePath);
    const targetPath = join(
      fixture.paths.workspaceStorageRoot,
      "workspace-a",
      "notepads.json",
    );
    const lastUpdatedAt = Date.UTC(2026, 6, 20, 1, 2, 3);
    const put = preparedChange(relativePath, "put", Buffer.from("restored", "utf8"), {
      lastUpdatedAt,
    });

    const putResult = await applyNonGlobalChanges(fixture.request, [put]);

    expect(putResult.applied).toEqual([resourceId]);
    expect(await readFile(targetPath, "utf8")).toBe("restored");
    expect((await stat(targetPath)).mtimeMs).toBeCloseTo(lastUpdatedAt, -1);

    const deleteResult = await applyNonGlobalChanges(fixture.request, [
      preparedChange(relativePath, "delete"),
    ]);

    expect(deleteResult.applied).toEqual([resourceId]);
    expect(deleteResult.skipped).toEqual([
      `${resourceId}: workspaceStorage tombstone retained`,
    ]);
    expect(await readFile(targetPath, "utf8")).toBe("restored");
  });

  it("maps incoming state while using workspace.json only as local identity", async () => {
    const fixture = await createFixture();
    fixture.request.workspaceMappings = { "workspace-a": "workspace-b" };
    const targetWorkspaceJson = await writeFixtureFile(
      fixture.paths.workspaceStorageRoot,
      "workspace-b/workspace.json",
      JSON.stringify({ folder: "file:///C:/projects/workspace-b" }),
    );

    const result = await applyNonGlobalChanges(fixture.request, [
      preparedChange(
        "workspace-a/notepads.json",
        "put",
        Buffer.from("remote notepads", "utf8"),
      ),
    ]);

    expect(JSON.parse(await readFile(targetWorkspaceJson, "utf8"))).toEqual({
      folder: "file:///C:/projects/workspace-b",
    });
    expect(
      await readFile(
        join(fixture.paths.workspaceStorageRoot, "workspace-b", "notepads.json"),
        "utf8",
      ),
    ).toBe("remote notepads");
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("skips disabled workspace sync without marking the change applied", async () => {
    const fixture = await createFixture();
    fixture.request.syncOptions.syncWorkspaceStorage = false;
    const relativePath = "workspace-a/notepads.json";
    const targetPath = await writeFixtureFile(
      fixture.paths.workspaceStorageRoot,
      relativePath,
      "local",
    );

    const result = await applyNonGlobalChanges(fixture.request, [
      preparedChange(relativePath, "put", Buffer.from("remote", "utf8")),
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      `${workspaceStorageResourceId(relativePath)}: workspaceStorage sync is disabled`,
    ]);
    expect(await readFile(targetPath, "utf8")).toBe("local");
  });

  it("rejects traversal, unsupported files, and mismatched resource IDs", async () => {
    const fixture = await createFixture();
    const attempts: PreparedHelperChange[] = [
      preparedChange(
        "workspace-a/../outside.json",
        "put",
        Buffer.from("outside", "utf8"),
      ),
      preparedChange(
        "workspace-a/anysphere.cursor-browser-extension/session.json",
        "put",
        Buffer.from("session", "utf8"),
      ),
      preparedChange(
        "workspace-a/workspace.json",
        "put",
        Buffer.from("identity", "utf8"),
      ),
      {
        ...preparedChange(
          "workspace-a/notepads.json",
          "put",
          Buffer.from("notepads", "utf8"),
        ),
        change: {
          ...preparedChange("workspace-a/notepads.json", "delete").change,
          resourceId: "workspace-storage/wrong",
        },
      },
    ];

    for (const attempt of attempts) {
      const result = await applyNonGlobalChanges(fixture.request, [attempt]);
      expect(result.applied).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toContain(
        "workspaceStorage metadata does not match",
      );
    }
    await expect(
      stat(join(fixture.paths.userDataRoot, "outside.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describeWithSqliteBackup("workspaceStorage database merge", () => {
  it("updates rows with SQL while preserving local-only rows and the live file", async () => {
    const fixture = await createFixture();
    const relativePath = "workspace-a/state.vscdb";
    const targetPath = join(
      fixture.paths.workspaceStorageRoot,
      "workspace-a",
      "state.vscdb",
    );
    await writeFixtureFile(
      fixture.paths.workspaceStorageRoot,
      "workspace-a/workspace.json",
      JSON.stringify({ folder: "file:///C:/projects/workspace-a" }),
    );
    await createWorkspaceDatabase(targetPath, "local");
    const existingConnection = new sqlite.DatabaseSync(targetPath);
    existingConnection
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("local-only", "preserved");
    const incomingPath = join(fixture.paths.extensionStorage, "incoming.vscdb");
    await createWorkspaceDatabase(incomingPath, "remote");
    const incomingDatabase = new sqlite.DatabaseSync(incomingPath);
    incomingDatabase
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("remote-only", "added");
    incomingDatabase.close();
    const incoming = serializeWorkspaceDatabaseSnapshot(
      captureWorkspaceDatabaseSnapshot(incomingPath, {
        workspaceId: "workspace-a",
      }).snapshot,
    );

    const result = await applyNonGlobalChanges(fixture.request, [
      preparedChange(relativePath, "put", incoming),
    ]);

    expect(result.applied).toEqual([workspaceStorageResourceId(relativePath)]);
    expect(readWorkspaceDatabaseItem(existingConnection, "workspace-key")).toBe(
      "remote",
    );
    expect(readWorkspaceDatabaseItem(existingConnection, "local-only")).toBe(
      "preserved",
    );
    expect(readWorkspaceDatabaseItem(existingConnection, "remote-only")).toBe(
      "added",
    );
    existingConnection.close();
    expect(result.backupPaths).toHaveLength(1);
    await expect(stat(result.backupPaths[0] ?? "")).resolves.toBeDefined();
  });

  it("skips an invalid logical payload and preserves the local database", async () => {
    const fixture = await createFixture();
    const relativePath = "workspace-a/state.vscdb";
    const targetPath = join(
      fixture.paths.workspaceStorageRoot,
      "workspace-a",
      "state.vscdb",
    );
    await writeFixtureFile(
      fixture.paths.workspaceStorageRoot,
      "workspace-a/workspace.json",
      JSON.stringify({ folder: "file:///C:/projects/workspace-a" }),
    );
    await createWorkspaceDatabase(targetPath, "local");

    const result = await applyNonGlobalChanges(fixture.request, [
      preparedChange(relativePath, "put", Buffer.from("{}", "utf8")),
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain(
      "Unsupported workspace database snapshot format",
    );
    expect(readWorkspaceDatabaseValue(targetPath)).toBe("local");
    await expect(stat(join(fixture.request.storageRoot, "quarantine"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("applies a snapshot captured with composer headers present", async () => {
    const fixture = await createFixture();
    const relativePath = "workspace-a/state.vscdb";
    const targetPath = join(
      fixture.paths.workspaceStorageRoot,
      "workspace-a",
      "state.vscdb",
    );
    await writeFixtureFile(
      fixture.paths.workspaceStorageRoot,
      "workspace-a/workspace.json",
      JSON.stringify({ folder: "file:///C:/projects/workspace-a" }),
    );
    await createWorkspaceDatabase(targetPath, "local");
    addComposerHeadersTable(targetPath);
    const incomingPath = join(fixture.paths.extensionStorage, "incoming.vscdb");
    await createWorkspaceDatabase(incomingPath, "remote");
    const composerId = "00000000-0000-4000-8000-0000000000ab";
    addComposerHeadersTable(incomingPath, composerId);
    const incoming = serializeWorkspaceDatabaseSnapshot(
      captureWorkspaceDatabaseSnapshot(incomingPath, {
        workspaceId: "workspace-a",
        includeComposerHeaders: true,
      }).snapshot,
    );

    const result = await applyNonGlobalChanges(fixture.request, [
      preparedChange(relativePath, "put", incoming),
    ]);

    expect(result.skipped).toEqual([]);
    expect(result.applied).toEqual([workspaceStorageResourceId(relativePath)]);
    expect(result.backups).toHaveLength(1);
    const target = new sqlite.DatabaseSync(targetPath, { readOnly: true });
    try {
      const header = target
        .prepare(
          "SELECT workspaceId, value FROM composerHeaders WHERE composerId = ?",
        )
        .get(composerId) as
        | { workspaceId?: string; value?: string }
        | undefined;
      expect(header?.workspaceId).toBe("workspace-a");
      expect(header?.value).toBe("{}");
      expect(readWorkspaceDatabaseItem(target, "workspace-key")).toBe("remote");
    } finally {
      target.close();
    }
  });
});

async function createFixture(): Promise<{
  request: HelperRequest;
  paths: CursorPaths;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-workspace-storage-test-"));
  temporaryRoots.push(root);
  const userDataRoot = join(root, "User");
  const cursorHome = join(root, ".cursor");
  const extensionStorage = join(root, "extension-storage");
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
    requestId: "00000000-0000-4000-8000-000000000020",
    mode: "apply-and-restart",
    createdAt: "2026-07-20T00:00:00.000Z",
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

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = join(root, ...relativePath.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}

function preparedChange(
  relativePath: string,
  operation: "put" | "delete",
  content?: Buffer,
  extraMetadata: Record<string, JsonValue> = {},
): PreparedHelperChange {
  const workspaceId = relativePath.split("/")[0] ?? "";
  const change = {
    eventHash: "a".repeat(64),
    changeIndex: 0,
    resourceId: workspaceStorageResourceId(relativePath),
    kind: "workspace-storage" as const,
    operation,
    semanticHash: "b".repeat(64),
    metadata: {
      relativePath,
      workspaceId,
      ...extraMetadata,
    },
  };
  return content === undefined ? { change } : { change, content };
}

async function createWorkspaceDatabase(
  path: string,
  value: string,
  includeCursorDiskKv = true,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const database = new sqlite.DatabaseSync(path);
  try {
    database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    if (includeCursorDiskKv) {
      database.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    }
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("workspace-key", value);
  } finally {
    database.close();
  }
}

function addComposerHeadersTable(path: string, composerId?: string): void {
  const database = new sqlite.DatabaseSync(path);
  try {
    database.exec(
      `CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
        lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
        recency INTEGER, checkpointAt INTEGER, value TEXT
      )`,
    );
    if (composerId !== undefined) {
      database
        .prepare(
          `INSERT INTO composerHeaders(
            composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
            isSubagent, recency, checkpointAt, value
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(composerId, "workspace-a", 1, 2, 0, 0, 0, 0, "{}");
    }
  } finally {
    database.close();
  }
}

function readWorkspaceDatabaseValue(path: string): string | null {
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    return readWorkspaceDatabaseItem(database, "workspace-key");
  } finally {
    database.close();
  }
}

function readWorkspaceDatabaseItem(
  database: InstanceType<typeof sqlite.DatabaseSync>,
  key: string,
): string | null {
  const row = database
    .prepare("SELECT value FROM ItemTable WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}
