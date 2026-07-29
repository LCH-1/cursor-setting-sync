import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  commands: {},
  workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }) },
  extensions: { all: [] },
}));

import { SyncRepository } from "../src/protocol/repository";
import { EventReconciler } from "../src/protocol/reconciler";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { readJsonFile, writeJsonAtomic } from "../src/platform/files";
import {
  autoMergeConflicts,
  isUnscannableIncomingResource,
} from "../src/sync/manager";
import { filterPortableWorkspaceRows } from "../src/resources/workspaceStatePolicy";
import { resolveTargetWorkspace, discoverWorkspaces } from "../src/chat/workspace";
import { workspaceStorageResourceId } from "../src/resources/workspaceStorage";
import {
  captureWorkspaceDatabaseSnapshot,
  serializeWorkspaceDatabaseSnapshot,
} from "../src/helper/workspaceDatabaseMerge";
import { parseCursorProcessIds } from "../src/platform/compatibility";
import type { HelperChange, HelperRequest, HelperResult } from "../src/helper/types";
import type { CursorPaths } from "../src/platform/paths";
import type { ResourceSnapshot } from "../src/types";

/**
 * The second computer joining, end to end, against the real helper bundle.
 *
 * Modelled on what the first device actually published: Remote-SSH workspace
 * storage written under the hex spelling of the host, local `file://` storage
 * that predates the default that excludes it, storage from a window with no
 * folder open, `empty-state-draft`, and ordinary chats. The joining device sees
 * the same remote folders under the *other* host spelling, which is the state
 * two real machines are in.
 *
 * The assertions are the three ways this has actually failed: a resource that
 * cannot be placed, a resource that is written but keeps being offered, and a
 * queue that refills itself after a successful apply.
 */
const HELPER = join(__dirname, "..", "dist", "helper.js");
const PASSPHRASE = "a sufficiently long second device passphrase";
const PRODUCER = {
  extensionVersion: "0.0.26",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

// The same remote folder, spelled the two ways Cursor stores it.
const HOST_HEX = "7b22686f73744e616d65223a226765656b646976655f6c6f63616c32227d";
const URI_A = `vscode-remote://ssh-remote%2B${HOST_HEX}/home/ubuntu/server/backend`;
const URI_B =
  "vscode-remote://ssh-remote%2Bgeekdive_local2/home/ubuntu/server/backend";
const WORKSPACE_A = "fe1a6c7f473850204df9f61b8a9f6a82";
const WORKSPACE_B = "9c1d4e2ab8734f5061e2c7d3a4b5e6f7";
const CHAT_PLACED = "3f8f0a52-2f21-4a53-9f6b-1a2b3c4d5e6f";
const CHAT_UNPLACEABLE = "8c2e1b74-5a63-4d19-b0f2-77e9a1c4d3b8";

const temporaryRoots: string[] = [];

function cursorIsRunning(): boolean {
  try {
    const listing =
      process.platform === "win32"
        ? execFileSync("tasklist", [
            "/FI",
            "IMAGENAME eq Cursor.exe",
            "/FO",
            "CSV",
            "/NH",
          ]).toString()
        : execFileSync("ps", ["-axo", "comm="]).toString();
    return parseCursorProcessIds(listing, process.platform).length > 0;
  } catch {
    return true;
  }
}

const describeBuilt = existsSync(HELPER) && !cursorIsRunning() ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describeBuilt("a second computer joining and merging", () => {
  it("places what it can, drops what it cannot, and does not ask twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-join-"));
    temporaryRoots.push(root);

    // ---- the first computer publishes what this repository actually holds ----
    const repositoryRoot = join(root, "repository");
    const deviceA = await SyncRepository.create(
      repositoryRoot,
      join(root, "storage-a"),
      PASSPHRASE,
      128 * 1024 * 1024,
      PRODUCER,
    );
    await deviceA.publish(
      [
        workspaceStorageSnapshot(root, WORKSPACE_A, URI_A, "remote"),
        workspaceStorageSnapshot(root, "empty-window", null, "folderless"),
        workspaceStorageSnapshot(
          root,
          "b3c4d5e6f708192a3b4c5d6e7f809192",
          "file:///c%3A/Users/someone/project",
          "local",
        ),
        chatSnapshot(CHAT_PLACED, WORKSPACE_A),
        chatSnapshot(CHAT_UNPLACEABLE, "1785164815421"),
        emptyStateDraftSnapshot(),
        textSnapshot("settings/default/editor.fontSize", "14"),
      ],
      [],
    );

    // ---- the second computer joins ----
    const deviceB = await SyncRepository.openWithMasterKey(
      repositoryRoot,
      join(root, "storage-b"),
      deviceA.repository,
      Buffer.from(deviceA.masterKey),
      128 * 1024 * 1024,
      PRODUCER,
    );
    expect(deviceB.state.device.deviceId).not.toBe(deviceA.state.device.deviceId);

    const paths = await buildDevicePaths(root);
    const localWorkspaces = await discoverWorkspaces(paths);
    expect(localWorkspaces.map((workspace) => workspace.id)).toEqual([WORKSPACE_B]);

    await deviceB.refreshState();
    const projections = new EventReconciler().reconcile(
      await deviceB.listEvents(),
      deviceB.state,
      await deviceB.loadAbsorbedCheckpointManifest(),
    ).projections;
    expect(projections).toHaveLength(7);

    // ---- triage, the way the manager does it ----
    const dropped: string[] = [];
    const changes: HelperChange[] = [];
    for (const projection of projections) {
      const tip = projection.tip;
      if (
        isUnscannableIncomingResource(projection.resourceId, tip.kind, tip.metadata)
      ) {
        dropped.push(projection.resourceId);
        continue;
      }
      changes.push({
        eventHash: tip.eventHash,
        changeIndex: tip.changeIndex,
        resourceId: projection.resourceId,
        kind: tip.kind,
        operation: tip.operation,
        semanticHash: tip.semanticHash,
        ...(tip.payload === undefined ? {} : { payload: tip.payload }),
        ...(tip.metadata === undefined ? {} : { metadata: tip.metadata }),
      });
    }

    // Storage from a folderless window and the scratch composer are refused on
    // arrival. Deferring them instead is what left three entries that no number
    // of applies could drain, re-offered on every launch.
    expect(dropped.sort()).toEqual(
      [
        "chat/empty-state-draft",
        workspaceStorageResourceId("empty-window/state.vscdb"),
      ].sort(),
    );

    // The remote folder is placed under *this* device's directory id even though
    // the two computers spell the host differently.
    expect(
      resolveTargetWorkspace(WORKSPACE_A, URI_A, localWorkspaces, {}),
    ).toBe(WORKSPACE_B);
    // A chat whose workspace never travelled still applies - the helper writes
    // its source workspace id straight back rather than holding the chat.
    expect(
      resolveTargetWorkspace("1785164815421", null, localWorkspaces, {}),
    ).toBeNull();

    // ---- the real helper writes them ----
    const result = await runHelper(root, repositoryRoot, paths, deviceB, changes);
    expect(result.error).toBeNull();
    expect(result.success).toBe(true);

    const composers = readComposerIds(paths.globalDatabase);
    expect(composers).toContain(CHAT_PLACED);
    expect(composers).toContain(CHAT_UNPLACEABLE);
    expect(composers).not.toContain("empty-state-draft");

    // Placed under B's own workspace id, not A's, and merged into the database
    // that was already there rather than replacing it.
    const merged = readItemTable(
      join(paths.workspaceStorageRoot, WORKSPACE_B, "state.vscdb"),
    );
    expect(merged["only-on-this-computer"]).toBe("kept");
    expect(merged["notepadData"]).toBe("remote");
    // The other computer's chrome row is not written here.
    expect(merged["only-on-the-other-computer"]).toBeUndefined();
    expect(existsSync(join(paths.workspaceStorageRoot, WORKSPACE_A))).toBe(false);
    // The local `file://` workspace is not carried between computers by default.
    expect(
      existsSync(
        join(paths.workspaceStorageRoot, "b3c4d5e6f708192a3b4c5d6e7f809192"),
      ),
    ).toBe(false);
    expect(result.backupPath).not.toBeNull();

    // ---- and the queue does not refill ----
    // Re-running the identical triage over the same repository has to produce
    // the same two drops and nothing new to ask about, which is the property
    // that "Apply now" reappearing after every restart was violating.
    const second = new EventReconciler().reconcile(
      await deviceB.listEvents(),
      deviceB.state,
      await deviceB.loadAbsorbedCheckpointManifest(),
    ).projections;
    const stillDropped = second.filter((projection) =>
      isUnscannableIncomingResource(
        projection.resourceId,
        projection.tip.kind,
        projection.tip.metadata,
      ),
    );
    expect(stillDropped).toHaveLength(2);
  }, 180_000);

  it("two computers working the same workspace converge and then go quiet", async () => {
    // The scenario the whole extension exists for, end to end through the real
    // helper bundle on both sides: each computer writes a different chat in
    // the same remote workspace and touches the same workspace database, both
    // "quit" (publish their exports as concurrent forks of a shared base),
    // both auto-resolve, both apply the other's work - and then NOTHING
    // republishes, because a pair that converges loudly once and then keeps
    // echoing is the failure mode 0.0.31 and 0.0.32 were about.
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-pair-"));
    temporaryRoots.push(root);
    const repositoryRoot = join(root, "repository");
    const deviceA = await SyncRepository.create(
      repositoryRoot,
      join(root, "storage-a"),
      PASSPHRASE,
      128 * 1024 * 1024,
      PRODUCER,
    );
    const deviceB = await SyncRepository.openWithMasterKey(
      repositoryRoot,
      join(root, "storage-b"),
      deviceA.repository,
      Buffer.from(deviceA.masterKey),
      128 * 1024 * 1024,
      PRODUCER,
    );
    await mkdir(join(root, "pc-a"), { recursive: true });
    await mkdir(join(root, "pc-b"), { recursive: true });
    const pathsA = await buildDevicePaths(join(root, "pc-a"));
    const pathsB = await buildDevicePaths(join(root, "pc-b"));
    const CHAT_X = "11111111-aaaa-4aaa-8aaa-111111111111";
    const CHAT_Y = "22222222-bbbb-4bbb-8bbb-222222222222";

    // A shared base version of the workspace database, then a concurrent fork:
    // each side changes a different portable row and adds its own chat.
    const base = portableWorkspaceSnapshot(root, "base", [
      ["notepadData", "shared-note"],
    ]);
    const published = await deviceA.publish([base], []);
    const parents = [`${published.eventHash}#0`];
    await deviceA.publish(
      [
        {
          ...portableWorkspaceSnapshot(root, "side-a", [
            ["notepadData", "from-a"],
          ]),
          parents,
        },
        chatSnapshot(CHAT_X, WORKSPACE_B),
      ],
      [],
    );
    await deviceB.refreshState();
    await deviceB.publish(
      [
        {
          ...portableWorkspaceSnapshot(root, "side-b", [
            ["notepadData", "shared-note"],
            ["interactive.sessions", "from-b"],
          ]),
          parents,
        },
        chatSnapshot(CHAT_Y, WORKSPACE_B),
      ],
      [],
    );

    // The first device to look sees the fork and resolves it; the second sees
    // the published resolution and has nothing left to resolve - the order two
    // real machines actually converge in. Neither may be left with an open
    // conflict.
    let resolvedBy = 0;
    for (const device of [deviceA, deviceB]) {
      await device.refreshState();
      const conflicts = new EventReconciler()
        .reconcile(
          await device.listEvents(),
          device.state,
          await device.loadAbsorbedCheckpointManifest(),
        )
        .conflicts.filter((conflict) => conflict.resolvedAt === undefined);
      if (conflicts.length > 0) {
        expect(conflicts).toHaveLength(1);
        expect(await autoMergeConflicts(device, conflicts)).toBe(true);
        await device.saveState();
        resolvedBy += 1;
      }
    }
    expect(resolvedBy).toBeGreaterThanOrEqual(1);
    await deviceA.refreshState();
    await deviceB.refreshState();
    const wsResourceId = workspaceStorageResourceId(
      `${WORKSPACE_B}/state.vscdb`,
    );
    const reconcileFor = async (device: SyncRepository) =>
      new EventReconciler().reconcile(
        await device.listEvents(),
        device.state,
        await device.loadAbsorbedCheckpointManifest(),
      );
    expect((await reconcileFor(deviceA)).conflicts).toHaveLength(0);
    expect((await reconcileFor(deviceB)).conflicts).toHaveLength(0);
    const tipA = deviceA.state.tips[wsResourceId] ?? [];
    const tipB = deviceB.state.tips[wsResourceId] ?? [];
    expect(tipA).toHaveLength(1);
    // Byte-identical merges collapse to the same version on both devices.
    expect(tipA[0]?.versionId).toBe(tipB[0]?.versionId);

    // Each side applies the other's chat and the merged workspace through the
    // real helper bundle.
    for (const [paths, device, deviceRoot] of [
      [pathsA, deviceA, join(root, "pc-a")],
      [pathsB, deviceB, join(root, "pc-b")],
    ] as const) {
      const projections = (await reconcileFor(device)).projections.filter(
        (projection) =>
          projection.resourceId.startsWith("chat/") ||
          projection.resourceId === wsResourceId,
      );
      const changes: HelperChange[] = projections.map((projection) => ({
        eventHash: projection.tip.eventHash,
        changeIndex: projection.tip.changeIndex,
        resourceId: projection.resourceId,
        kind: projection.tip.kind,
        operation: projection.tip.operation,
        semanticHash: projection.tip.semanticHash,
        ...(projection.tip.payload === undefined
          ? {}
          : { payload: projection.tip.payload }),
        ...(projection.tip.metadata === undefined
          ? {}
          : { metadata: projection.tip.metadata }),
      }));
      const result = await runHelper(
        deviceRoot,
        repositoryRoot,
        paths,
        device,
        changes,
      );
      expect(result.error).toBeNull();
      expect(result.success).toBe(true);
    }

    // Convergence: both conversations exist on both computers, the workspace
    // database carries both sides' portable rows plus the local-only row, and
    // no chrome travelled.
    for (const paths of [pathsA, pathsB]) {
      const composers = readComposerIds(paths.globalDatabase);
      expect(composers).toContain(CHAT_X);
      expect(composers).toContain(CHAT_Y);
      const merged = readItemTable(
        join(paths.workspaceStorageRoot, WORKSPACE_B, "state.vscdb"),
      );
      expect(merged["notepadData"]).toBe("from-a");
      expect(merged["interactive.sessions"]).toBe("from-b");
      expect(merged["only-on-this-computer"]).toBe("kept");
      expect(merged["only-on-the-other-computer"]).toBeUndefined();
    }

    // Quiet: re-capturing each side's workspace database exactly as the scan
    // does hashes to the merged tip, so neither computer would publish again.
    const mergedHash = tipA[0]?.semanticHash;
    for (const paths of [pathsA, pathsB]) {
      const recaptured = serializeWorkspaceDatabaseSnapshot(
        filterPortableWorkspaceRows(
          captureWorkspaceDatabaseSnapshot(
            join(paths.workspaceStorageRoot, WORKSPACE_B, "state.vscdb"),
            { workspaceId: WORKSPACE_B, includeComposerHeaders: true },
          ).snapshot,
        ),
      );
      expect(sha256(recaptured)).toBe(mergedHash);
    }
  }, 300_000);
});

async function buildDevicePaths(root: string): Promise<CursorPaths> {
  const databasePath = join(root, "state.vscdb");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode=WAL");
  database.exec(
    "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  database.exec(
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  database.exec(
    `CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
      recency INTEGER, checkpointAt INTEGER, value TEXT
    )`,
  );
  database.close();

  const userDataRoot = join(root, "User");
  const cursorHome = join(root, ".cursor");
  const workspaceStorageRoot = join(userDataRoot, "workspaceStorage");
  await mkdir(join(workspaceStorageRoot, WORKSPACE_B), { recursive: true });
  // This computer has the same remote folder open, spelled the other way, and
  // therefore already has its own state for it. The apply merges into that
  // database rather than replacing it, so it has to be a real one.
  await writeFile(
    join(workspaceStorageRoot, WORKSPACE_B, "workspace.json"),
    JSON.stringify({ folder: URI_B }),
    "utf8",
  );
  const localState = new DatabaseSync(
    join(workspaceStorageRoot, WORKSPACE_B, "state.vscdb"),
  );
  localState.exec(
    "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  localState.exec(
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  localState
    .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
    .run("only-on-this-computer", "kept");
  localState.close();
  await mkdir(join(root, "extension-storage"), { recursive: true });
  await writeFile(
    join(root, "product.json"),
    JSON.stringify({ version: "3.11.19", vscodeVersion: "1.125.0" }),
    "utf8",
  );

  return {
    appRoot: root,
    userDataRoot,
    globalStorageRoot: root,
    globalDatabase: databasePath,
    workspaceStorageRoot,
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
    extensionStorage: join(root, "extension-storage"),
    helperScript: HELPER,
  };
}

async function runHelper(
  root: string,
  repositoryRoot: string,
  paths: CursorPaths,
  repository: SyncRepository,
  changes: HelperChange[],
): Promise<HelperResult> {
  const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const request: HelperRequest = {
    version: 1,
    requestId,
    mode: "apply-and-restart",
    createdAt: new Date().toISOString(),
    repositoryRoot,
    storageRoot: paths.extensionStorage,
    cursorExecutable: process.execPath,
    extensionHostPid: 0x7ffffffe,
    restart: false,
    expectedCursorVersion: "3.11.19",
    expectedVscodeVersion: "1.125.0",
    extensionVersion: "0.0.26",
    paths,
    changes,
    workspaceMappings: {},
    syncOptions: {
      ignoredSettings: [],
      ignoredExtensions: [],
      machineScopedSettings: [],
      syncChat: true,
      syncWorkspaceStorage: true,
      maxPayloadBytes: 128 * 1024 * 1024,
      gitSync: false,
    },
  };
  const requestPath = join(paths.extensionStorage, `helper-request-${requestId}.json`);
  await writeJsonAtomic(requestPath, request);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HELPER, requestPath],
      { timeout: 150_000, cwd: root },
      (error) => {
        if (error && (error as { code?: unknown }).code !== 1) {
          reject(error instanceof Error ? error : new Error("helper failed"));
          return;
        }
        resolve();
      },
    );
    child.stdin?.end(
      `${Buffer.from(repository.masterKey).toString("base64")}\n`,
    );
  });
  return readJsonFile<HelperResult>(
    join(paths.extensionStorage, `helper-result-${requestId}.json`),
  );
}

function readItemTable(databasePath: string): Record<string, string> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT key, value FROM ItemTable")
      .all() as Array<{ key: string; value: unknown }>;
    return Object.fromEntries(
      rows.map((row) => [
        row.key,
        row.value instanceof Uint8Array
          ? Buffer.from(row.value).toString("utf8")
          : String(row.value),
      ]),
    );
  } finally {
    database.close();
  }
}

function readComposerIds(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (
      database.prepare("SELECT composerId FROM composerHeaders").all() as Array<{
        composerId: string;
      }>
    ).map((row) => row.composerId);
  } finally {
    database.close();
  }
}

function workspaceStorageSnapshot(
  root: string,
  workspaceId: string,
  workspaceUri: string | null,
  marker: string,
): ResourceSnapshot {
  const relativePath = `${workspaceId}/state.vscdb`;
  // Captured and serialized exactly as the scan does it: the payload is a
  // canonical snapshot of the tables, not the database file.
  const path = join(root, `fixture-${marker}.vscdb`);
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  database.exec(
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  const insert = database.prepare(
    "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
  );
  // One portable row that must arrive, one chrome row that must not.
  insert.run("notepadData", marker);
  insert.run("only-on-the-other-computer", marker);
  database.close();
  const content = serializeWorkspaceDatabaseSnapshot(
    captureWorkspaceDatabaseSnapshot(path, { workspaceId }).snapshot,
  );
  return {
    resourceId: workspaceStorageResourceId(relativePath),
    kind: "workspace-storage",
    content,
    semanticHash: sha256(content),
    metadata: {
      relativePath,
      workspaceId,
      workspaceUri,
      plainBytes: content.length,
      lastUpdatedAt: 1_785_165_284_786,
    },
  };
}

/**
 * A workspace-database snapshot the 0.0.32 scan would publish: captured from a
 * real fixture database and restricted to portable rows, with one chrome row
 * present pre-filter to prove the filter ran.
 */
function portableWorkspaceSnapshot(
  root: string,
  marker: string,
  rows: Array<[string, string]>,
): ResourceSnapshot {
  const relativePath = `${WORKSPACE_B}/state.vscdb`;
  const path = join(root, `fixture-portable-${marker}.vscdb`);
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  database.exec(
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  const insert = database.prepare(
    "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
  );
  for (const [key, value] of rows) {
    insert.run(key, value);
  }
  insert.run("only-on-the-other-computer", marker);
  database.close();
  const content = serializeWorkspaceDatabaseSnapshot(
    filterPortableWorkspaceRows(
      captureWorkspaceDatabaseSnapshot(path, {
        workspaceId: WORKSPACE_B,
        includeComposerHeaders: true,
      }).snapshot,
    ),
  );
  return {
    resourceId: workspaceStorageResourceId(relativePath),
    kind: "workspace-storage",
    content,
    semanticHash: sha256(content),
    metadata: {
      relativePath,
      workspaceId: WORKSPACE_B,
      workspaceUri: URI_B,
      plainBytes: content.length,
      lastUpdatedAt: 1_785_165_284_786,
    },
  };
}

function chatSnapshot(composerId: string, workspaceId: string): ResourceSnapshot {
  const body = canonicalBytes({
    schemaVersion: 1 as const,
    composerId,
    header: {
      composerId,
      workspaceId,
      createdAt: 1,
      lastUpdatedAt: 2,
      isArchived: 0,
      isSubagent: 0,
      recency: 0,
      checkpointAt: null,
      value: JSON.stringify({ name: "written on the other computer" }),
    },
    composerData: {
      key: `composerData:${composerId}`,
      valueBase64: Buffer.from("{}", "utf8").toString("base64"),
      valueType: "text" as const,
    },
    bubbles: [],
  });
  return {
    resourceId: `chat/${composerId}`,
    kind: "chat",
    content: body,
    semanticHash: sha256(body),
    metadata: { composerId, workspaceId },
  };
}

/** The non-UUID composer row every Cursor installation keeps. */
function emptyStateDraftSnapshot(): ResourceSnapshot {
  const body = canonicalBytes({ schemaVersion: 1 as const, draft: true });
  return {
    resourceId: "chat/empty-state-draft",
    kind: "chat",
    content: body,
    semanticHash: sha256(body),
    metadata: {
      composerId: "empty-state-draft",
      workspaceId: "empty-window",
      bubbleCount: 0,
    },
  };
}

function textSnapshot(resourceId: string, text: string): ResourceSnapshot {
  const content = Buffer.from(text, "utf8");
  return {
    resourceId,
    kind: "settings",
    content,
    semanticHash: sha256(content),
  };
}
