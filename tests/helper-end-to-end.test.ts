import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SyncRepository } from "../src/protocol/repository";
import { EventReconciler } from "../src/protocol/reconciler";
import { restoreDatabaseBackup } from "../src/helper/database";
import { withReadableBackup } from "../src/helper/compressedBackups";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { portableChatCoreHash, StateVscdbChatAdapter } from "../src/chat/stateVscdb";
import { captureChunkedChat, chunkedChatMetadata, CHAT_CHUNK_BYTES } from "../src/chat/chunked";
import { pathExists, readJsonFile, writeJsonAtomic } from "../src/platform/files";
import type { HelperChange, HelperRequest, HelperResult } from "../src/helper/types";
import type { CursorPaths } from "../src/platform/paths";
import { parseCursorProcessIds } from "../src/platform/compatibility";

/**
 * Drives the built `dist/helper.js` the way the extension does - a request file
 * on disk, the repository key on stdin, a detached process - and checks that a
 * change published by another device reaches this device's database, that the
 * pre-apply backup exists, and that restoring it rolls the write back.
 *
 * Every unit test in this suite exercises the apply functions directly, which
 * is why none of them caught anything this series went wrong with: the failures
 * were all in the orchestration around those functions - the exit wait, what
 * counts as a running Cursor, the lock, the request/result files - and nothing
 * ran the bundle end to end. This does.
 */
const HELPER = join(__dirname, "..", "dist", "helper.js");
const COMPOSER = "3f8f0a52-2f21-4a53-9f6b-1a2b3c4d5e6f";
const temporaryRoots: string[] = [];

/**
 * The helper's first act is to wait for every Cursor process to exit, so this
 * can only run on a machine where Cursor is closed - on a developer's machine
 * it would otherwise sit in that wait until the timeout, which is the helper
 * behaving correctly rather than a failure. Run `npm test` with Cursor closed
 * to include it.
 */
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
        : execFileSync("ps", ["-axo", "pid=,comm="]).toString();
    return parseCursorProcessIds(listing, process.platform).length > 0;
  } catch {
    return true;
  }
}

const releaseRun =
  process.env.CI === "true" || process.env.REQUIRE_SQLITE_BACKUP === "1";
const cursorRunning = cursorIsRunning();
const runnable = existsSync(HELPER) && !cursorRunning;
const describeBuilt = runnable ? describe : describe.skip;

// A silent skip here restores the exact blind spot this file documents: every
// orchestration failure in the series shipped because nothing ran the bundle.
// A release run has to opt in and then cannot miss a skipped-because-missing
// bundle; a running Cursor is still a legitimate reason to skip.
describe("helper end-to-end prerequisites", () => {
  it("has the built bundle when a release run demands it", () => {
    if (!releaseRun || existsSync(HELPER)) {
      return;
    }
    throw new Error(
      `dist/helper.js is missing, so the end-to-end helper suite was silently skipped. Run "npm run build" before the suite, or clear CI/REQUIRE_SQLITE_BACKUP to accept the gap locally.`,
    );
  });

  it("has no running Cursor process when a release run demands the helper suite", () => {
    if (!releaseRun || !cursorRunning) {
      return;
    }
    throw new Error(
      "Cursor is running, so the end-to-end helper suite would be silently skipped. Close Cursor before a release run.",
    );
  });
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!existsSync(HELPER))("live helper, end to end", () => {
  it("settles existing blobs with a live host PID without quitting or writing the database", async () => {
    const f = await createFixture();
    const snapshot = chatSnapshot();
    const content = canonicalBytes(snapshot);
    const event = await f.repository.publish([{
      resourceId: `chat/${COMPOSER}`, kind: "chat", content, semanticHash: sha256(content),
      metadata: { chatSnapshotSchemaVersion: 2, syncOrigin: "agent-kv-enrichment", agentKvEnrichmentAppliesCore: false },
    }], []);
    new EventReconciler().reconcile(await f.repository.listEvents(), f.repository.state, null);
    const tip = f.repository.state.tips[`chat/${COMPOSER}`]![0]!;
    f.request.mode = "verify-live";
    f.request.extensionHostPid = process.pid;
    f.request.changes = [{ ...tip, resourceId: `chat/${COMPOSER}` }];
    f.repository.state.pendingDatabaseChanges = [{ resourceId: `chat/${COMPOSER}`, kind: "chat", eventHash: event.eventHash!, changeIndex: 0 }];
    await f.repository.saveState();
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare("INSERT INTO composerHeaders VALUES (?,NULL,1,2,0,0,0,NULL,?)").run(COMPOSER, snapshot.header.value);
      db.prepare("INSERT INTO cursorDiskKV VALUES (?,?)").run(snapshot.composerData.key, "{}");
      const result = await runHelper(f);
      expect(result).toMatchObject({ success: true, mode: "verify-live", applied: [`chat/${COMPOSER}`], backupPath: null });
      expect(await pathExists(join(f.request.storageRoot, "backups"))).toBe(false);
      expect(db.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(snapshot.composerData.key)?.value).toBe("{}");
      await f.repository.refreshState();
      expect(f.repository.state.pendingDatabaseChanges).toEqual([]);
    } finally { db.close(); }
  }, 15_000);
});

describeBuilt("the offline helper, end to end", () => {
  it("restores a chunked peer chat beyond both old limits and preserves its backup and workspace mapping", async () => {
    const f = await createFixture();
    const sourcePath = join(f.request.storageRoot, "peer.sqlite");
    const source = new DatabaseSync(sourcePath);
    source.exec("CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB)");
    const bubbleCount = 17_000;
    const blob = Buffer.from("immutable peer continuation");
    const blobId = sha256(blob);
    const conversationState = `~${Buffer.concat([Buffer.from([10, 32]), Buffer.from(blobId, "hex")]).toString("base64")}`;
    const composer = JSON.stringify({ workspaceIdentifier: { id: "peer-workspace" }, conversationState,
      fullConversationHeadersOnly: Array.from({ length: bubbleCount }, (_, index) => ({ bubbleId: String(index).padStart(8, "0") })) });
    const insert = source.prepare("INSERT INTO cursorDiskKV VALUES(?,?)");
    source.exec("BEGIN");
    insert.run(`composerData:${COMPOSER}`, composer);
    insert.run(`agentKv:blob:${blobId}`, blob);
    for (let index = 0; index < bubbleCount; index++) {
      insert.run(`bubbleId:${COMPOSER}:${String(index).padStart(8, "0")}`, JSON.stringify({ text: "x".repeat(8_192), index }));
    }
    source.exec("COMMIT");
    let manifest;
    try {
      source.exec("BEGIN");
      manifest = await captureChunkedChat(source, { ...chatSnapshot().header, workspaceId: "peer-workspace",
        value: '{"workspaceIdentifier":{"id":"peer-workspace"},"name":"Large peer chat"}' }, f.repository);
      source.exec("ROLLBACK");
    } finally { source.close(); }
    expect(manifest.bubbleCount).toBe(bubbleCount);
    expect(manifest.parts.reduce((n, part) => n + part.payload.plainBytes, 0)).toBeGreaterThan(128 * 1024 * 1024);
    expect(Math.max(...manifest.parts.map(part => part.payload.plainBytes))).toBeLessThanOrEqual(CHAT_CHUNK_BYTES);
    const content = canonicalBytes(manifest);
    const siblingId = "3f8f0a52-2f21-4a53-9f6b-1a2b3c4d5e60";
    const sibling = chatSnapshot(siblingId);
    const siblingContent = canonicalBytes(sibling);
    await f.repository.publish([{ resourceId: `chat/${COMPOSER}`, kind: "chat", content,
      semanticHash: sha256(content), metadata: chunkedChatMetadata(manifest) }, {
      resourceId: `chat/${siblingId}`, kind: "chat", content: siblingContent, semanticHash: sha256(siblingContent),
      metadata: { chatSnapshotSchemaVersion: 2, agentKvBlobCount: 0, agentKvReferencedCount: 0,
        agentKvMissingCount: 0, chatCoreHash: portableChatCoreHash(sibling) },
    }], []);
    new EventReconciler().reconcile(await f.repository.listEvents(), f.repository.state, null);
    f.request.changes = [COMPOSER, siblingId].map(id => ({ ...f.repository.state.tips[`chat/${id}`]![0]!, resourceId: `chat/${id}` }));
    f.repository.state.pendingDatabaseChanges = f.request.changes.map(change => ({
      resourceId: change.resourceId, kind: "chat", eventHash: change.eventHash, changeIndex: change.changeIndex,
    }));
    f.request.workspaceMappings = { "peer-workspace": "local-workspace" };
    f.request.extensionVersion = "1.0.16";
    await mkdir(join(f.request.paths.workspaceStorageRoot, "local-workspace"), { recursive: true });
    await writeFile(join(f.request.paths.workspaceStorageRoot, "local-workspace", "workspace.json"), '{"folder":"file:///local-project"}');
    const target = new DatabaseSync(f.databasePath);
    target.prepare("INSERT INTO cursorDiskKV VALUES(?,?)").run(`agentKv:blob:${blobId}`, blob.toString("utf8"));
    target.close();
    await f.repository.saveState();
    const result = await runHelper(f);
    expect(result).toMatchObject({ success: true, error: null });
    expect(result.applied).toEqual(expect.arrayContaining([`chat/${COMPOSER}`, `chat/${siblingId}`]));
    const received = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      expect(received.prepare("SELECT count(*) AS n FROM cursorDiskKV WHERE key LIKE ?").get(`bubbleId:${COMPOSER}:%`)!.n).toBe(bubbleCount);
      expect(received.prepare("SELECT workspaceId FROM composerHeaders WHERE composerId=?").get(COMPOSER)!.workspaceId).toBe("local-workspace");
      const restored = JSON.parse(received.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`composerData:${COMPOSER}`)!.value as string) as { workspaceIdentifier: { id: string } };
      expect(restored.workspaceIdentifier.id).toBe("local-workspace");
      expect(received.prepare("SELECT typeof(value) AS t FROM cursorDiskKV WHERE key=?").get(`agentKv:blob:${blobId}`)!.t).toBe("text");
    } finally { received.close(); }
    await f.repository.refreshState();
    const adapter = new StateVscdbChatAdapter(f.request.paths, { forceCoreVerificationResourceIds: [`chat/${COMPOSER}`] });
    adapter.setChatChunkStore(f.repository);
    const afterApply = await adapter.scan(f.repository.state.projections);
    expect(afterApply.snapshots.filter(snapshot => snapshot.resourceId === `chat/${COMPOSER}`)).toEqual([]);
    await withReadableBackup(result.backupPath!, async path => expect(readComposerIds(path)).not.toContain(COMPOSER));
    await restoreDatabaseBackup(f.databasePath, result.backupPath!, f.request.storageRoot);
    expect(readComposerIds(f.databasePath)).not.toContain(COMPOSER);
    const peer = new DatabaseSync(sourcePath, { readOnly: true });
    try { expect(peer.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`composerData:${COMPOSER}`)!.value).toBe(composer); }
    finally { peer.close(); }
  }, 120_000);

  it("applies a peer's chat, backs the database up first, and restores cleanly", async () => {
    const fixture = await createFixture();

    // A change published by "the other computer".
    const snapshot = chatSnapshot();
    const body = canonicalBytes(snapshot);
    const published = await fixture.repository.publish(
      [
        {
          resourceId: `chat/${COMPOSER}`,
          kind: "chat",
          content: body,
          semanticHash: sha256(body),
          metadata: {
            composerId: COMPOSER,
            workspaceId: null,
            chatSnapshotSchemaVersion: 2,
            agentKvBlobCount: 0,
            agentKvReferencedCount: 0,
            agentKvMissingCount: 0,
            chatCoreHash: portableChatCoreHash(snapshot),
          },
        },
      ],
      [],
    );
    const event = (await fixture.repository.listEvents()).find(
      (candidate) => candidate.eventHash === published.eventHash,
    );
    const change = event?.manifest.changes[0];
    expect(change).toBeDefined();
    const eventHash = published.eventHash ?? "";
    expect(eventHash).not.toBe("");

    fixture.request.changes = [
      {
        eventHash,
        changeIndex: 0,
        resourceId: `chat/${COMPOSER}`,
        kind: "chat",
        operation: "put",
        semanticHash: change?.semanticHash ?? "",
        ...(change?.payload === undefined ? {} : { payload: change.payload }),
        ...(change?.metadata === undefined ? {} : { metadata: change.metadata }),
      } satisfies HelperChange,
    ];
    await fixture.repository.saveState();

    const result = await runHelper(fixture);

    expect(result.error).toBeNull();
    expect(result.success).toBe(true);
    expect(result.applied).toContain(`chat/${COMPOSER}`);

    // The row is really in the database the extension would read.
    expect(readComposerIds(fixture.databasePath)).toContain(COMPOSER);

    // The pre-apply backup exists and still holds the state before the write.
    const backups = await readdir(join(fixture.request.storageRoot, "backups"));
    expect(backups.length).toBeGreaterThan(0);
    expect(result.backupPath).not.toBeNull();
    await withReadableBackup(result.backupPath ?? "", async source => expect(readComposerIds(source)).not.toContain(COMPOSER));

    // And restoring it rolls the apply back, which is the whole point of taking
    // it: an apply nobody can undo is not one anybody should run.
    await restoreDatabaseBackup(
      fixture.databasePath,
      result.backupPath ?? "",
      fixture.request.storageRoot,
    );
    expect(readComposerIds(fixture.databasePath)).not.toContain(COMPOSER);
  }, 120_000);

  it("drains more than one shutdown page with one global backup", async () => {
    const fixture = await createFixture();
    const pending: HelperChange[] = [];
    const snapshots = Array.from({ length: 300 }, (_unused, index) => {
      const composerId = `00000000-0000-4000-8000-${index
        .toString()
        .padStart(12, "0")}`;
      const snapshot = chatSnapshot(composerId);
      const body = canonicalBytes(snapshot);
      return {
        resourceId: `chat/${composerId}`,
        kind: "chat" as const,
        content: body,
        semanticHash: sha256(body),
        metadata: {
          composerId,
          workspaceId: null,
          lastUpdatedAt: snapshot.header.lastUpdatedAt,
          bubbleCount: snapshot.bubbles.length,
          chatSnapshotSchemaVersion: 2,
          agentKvBlobCount: 0,
          agentKvReferencedCount: 0,
          agentKvMissingCount: 0,
          chatCoreHash: portableChatCoreHash(snapshot),
        },
      };
    });
    for (let offset = 0; offset < snapshots.length; offset += 200) {
      const published = await fixture.repository.publish(
        snapshots.slice(offset, offset + 200),
        [],
      );
      const event = (await fixture.repository.listEvents()).find(
        (candidate) => candidate.eventHash === published.eventHash,
      );
      expect(event).toBeDefined();
      if (event === undefined) {
        throw new Error("Published drain fixture event was not found.");
      }
      for (const [changeIndex, change] of event.manifest.changes.entries()) {
        pending.push({
          eventHash: event.eventHash,
          changeIndex,
          sourceDeviceId: event.stored.header.deviceId,
          resourceId: change.resourceId,
          kind: "chat",
          operation: "put",
          semanticHash: change.semanticHash,
          ...(change.payload === undefined ? {} : { payload: change.payload }),
          ...(change.metadata === undefined ? {} : { metadata: change.metadata }),
        });
      }
    }
    fixture.repository.state.pendingDatabaseChanges = pending.map((change) => ({
      resourceId: change.resourceId,
      kind: change.kind,
      eventHash: change.eventHash,
      changeIndex: change.changeIndex,
    }));
    await fixture.repository.saveState();
    fixture.request.mode = "final-export";
    fixture.request.restart = false;
    fixture.request.syncOptions.applyOnShutdown = true;

    const result = await runHelper(fixture);

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(new Set(result.applied)).toEqual(
      new Set(snapshots.map((snapshot) => snapshot.resourceId)),
    );
    const backupFiles = await readdir(
      join(fixture.request.storageRoot, "backups"),
    );
    expect(
      backupFiles.filter(
        (name) => name.startsWith("state-") && name.endsWith(".vscdb.gz"),
      ),
    ).toHaveLength(1);
    const reopened = await SyncRepository.open(
      fixture.request.repositoryRoot,
      fixture.request.storageRoot,
      "a sufficiently long end to end passphrase",
      fixture.request.syncOptions.maxPayloadBytes,
      {
        extensionVersion: fixture.request.extensionVersion,
        cursorVersion: fixture.request.expectedCursorVersion,
        vscodeVersion: fixture.request.expectedVscodeVersion,
      },
    );
    expect(reopened.state.pendingDatabaseChanges).toEqual([]);
  }, 120_000);

  it("restores a backup through the bundle the way the command does", async () => {
    // restoreDatabaseBackup is covered directly, but nothing had ever run the
    // helper in restore-backup mode - the mode Cursor Setting Sync: Restore
    // Backup actually launches. Its request carries fields no other mode uses,
    // and a typo in any of them fails only here.
    const fixture = await createFixture();
    await fixture.repository.saveState();

    const before = readComposerIds(fixture.databasePath);
    const backupPath = join(fixture.request.storageRoot, "backups", "chosen.vscdb");
    await mkdir(join(fixture.request.storageRoot, "backups"), { recursive: true });
    const source = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      await backup(source, backupPath, { rate: 100 });
    } finally {
      source.close();
    }

    // Something lands in the database after that backup was taken.
    const live = new DatabaseSync(fixture.databasePath);
    live.exec(
      `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt,
        isArchived, isSubagent, recency, checkpointAt, value)
       VALUES ('${COMPOSER}', NULL, 1, 2, 0, 0, 0, NULL, '{}')`,
    );
    live.close();
    expect(readComposerIds(fixture.databasePath)).toContain(COMPOSER);

    fixture.request.mode = "restore-backup";
    fixture.request.backupToRestore = backupPath;
    const result = await runHelper(fixture);

    expect(result.error).toBeNull();
    expect(result.success).toBe(true);
    // The write is rolled back, and the state before it is captured first so
    // the restore is itself undoable.
    expect(readComposerIds(fixture.databasePath)).toEqual(before);
    const preRestore = (
      await readdir(join(fixture.request.storageRoot, "backups"))
    ).filter((name) => name.startsWith("pre-restore-") && name.endsWith(".vscdb.gz"));
    expect(preRestore).toHaveLength(1);
    await withReadableBackup(join(fixture.request.storageRoot, "backups", preRestore[0] ?? ""),
      async source => expect(readComposerIds(source)).toContain(COMPOSER));
  }, 120_000);

  it("consumes its request file and reports rather than vanishing", async () => {
    // A helper that dies without deleting its request is how a queue silently
    // stopped draining for a whole day, so the contract is worth pinning: the
    // request goes away and a result takes its place.
    const fixture = await createFixture();
    await fixture.repository.saveState();

    const result = await runHelper(fixture);

    expect(result.success).toBe(true);
    expect(await pathExists(fixture.requestPath)).toBe(false);
  }, 120_000);

  it("exports workspaceStorage in final-export mode", async () => {
    // final-export is the ONLY path that ever backs up workspaceStorage, and
    // nothing had ever run the bundle in that mode: a regression anywhere in
    // it makes every shutdown export a silent no-op, indefinitely, with all
    // tests green.
    const fixture = await createFixture();
    await fixture.repository.saveState();
    const workspaceId = "fe1a6c7f473850204df9f61b8a9f6a82";
    const workspaceRoot = join(
      fixture.request.paths.workspaceStorageRoot,
      workspaceId,
    );
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, "workspace.json"),
      JSON.stringify({
        folder:
          "vscode-remote://ssh-remote%2Bgeekdive_local2/home/ubuntu/server/backend",
      }),
      "utf8",
    );
    const workspaceDatabase = new DatabaseSync(join(workspaceRoot, "state.vscdb"));
    workspaceDatabase.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    workspaceDatabase.exec(
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    workspaceDatabase.exec("INSERT INTO ItemTable(key, value) VALUES ('k', 'v')");
    workspaceDatabase.close();

    fixture.request.mode = "final-export";
    fixture.request.restart = false;
    fixture.request.syncOptions.syncWorkspaceStorage = true;
    const result = await runHelper(fixture);

    expect(result.error).toBeNull();
    expect(result.success).toBe(true);
    const events = await fixture.repository.listEvents();
    const exportedKinds = events.flatMap((event) =>
      event.manifest.changes.map((change) => change.kind),
    );
    expect(exportedKinds).toContain("workspace-storage");
    const exportedIds = events.flatMap((event) =>
      event.manifest.changes.map((change) => change.resourceId),
    );
    expect(exportedIds.some((id) => id.includes(workspaceId))).toBe(true);
  }, 120_000);

  it("applies healthy workspace images while retaining a corrupt database and its queue entry", async () => {
    const fixture = await createFixture();
    const snapshots = [];
    const broken = Buffer.from("corrupt database must remain byte-identical");
    for (const workspaceId of ["broken", "healthy"]) {
      const directory = join(fixture.request.paths.workspaceStorageRoot, workspaceId);
      await mkdir(directory, { recursive: true });
      const workspaceUri = `file:///project-${workspaceId}`;
      await writeFile(join(directory, "workspace.json"), JSON.stringify({ folder: workspaceUri }));
      const files = workspaceId === "broken" ? ["state.vscdb", "images/remote.png"] : ["images/remote.png"];
      for (const file of files) {
        const relativePath = `${workspaceId}/${file}`;
        const content = Buffer.from(`incoming ${relativePath}`);
        snapshots.push({ resourceId: `workspace-storage/${encodeURIComponent(relativePath)}`,
          kind: "workspace-storage" as const, content, semanticHash: sha256(content),
          metadata: { relativePath, workspaceId, workspaceUri } });
      }
      if (workspaceId === "broken") await writeFile(join(directory, "state.vscdb"), broken);
    }
    await fixture.repository.publish(snapshots, []);
    new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    fixture.request.changes = snapshots.map(snapshot => ({ ...fixture.repository.state.tips[snapshot.resourceId]![0]!, resourceId: snapshot.resourceId }));
    fixture.repository.state.pendingDatabaseChanges = fixture.request.changes.map(change => ({
      resourceId: change.resourceId, kind: change.kind, eventHash: change.eventHash, changeIndex: change.changeIndex,
    }));
    fixture.request.syncOptions.syncWorkspaceStorage = true;
    fixture.request.syncOptions.syncChat = false;
    await fixture.repository.saveState();
    const result = await runHelper(fixture);
    expect(result.success, result.error ?? "").toBe(true);
    expect(result.applied).toHaveLength(2);
    expect(await readFile(join(fixture.request.paths.workspaceStorageRoot, "broken", "state.vscdb"))).toEqual(broken);
    for (const workspaceId of ["broken", "healthy"]) {
      expect(await readFile(join(fixture.request.paths.workspaceStorageRoot, workspaceId, "images", "remote.png"), "utf8"))
        .toBe(`incoming ${workspaceId}/images/remote.png`);
    }
    const durable = await fixture.repository.stateStore.loadOrCreate(fixture.repository.repository.repositoryId);
    expect(durable.pendingDatabaseChanges.map(change => change.resourceId)).toEqual(["workspace-storage/broken%2Fstate.vscdb"]);
  }, 120_000);

  it("supersedes a final export when a newer session cancelled it", async () => {
    const fixture = await createFixture();
    await fixture.repository.saveState();
    fixture.request.mode = "final-export";
    fixture.request.restart = false;
    // The cancel file records when the finalizers were superseded; a stamp
    // after this request's createdAt means a newer session took over.
    await writeFile(
      join(fixture.request.storageRoot, "cancel-finalizers"),
      new Date(Date.now() + 1_000).toISOString(),
      "utf8",
    );

    const result = await runHelper(fixture);

    expect(result.success).toBe(true);
    expect(result.skipped).toContain("Final export was superseded.");
    expect(await fixture.repository.listEvents()).toEqual([]);
  }, 120_000);
});

interface Fixture {
  repository: SyncRepository;
  request: HelperRequest;
  requestPath: string;
  databasePath: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "cursor-sync-e2e-"));
  temporaryRoots.push(root);
  const databasePath = join(root, "state.vscdb");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  database.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  database.exec(
    `CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
      recency INTEGER, checkpointAt INTEGER, value TEXT
    )`,
  );
  database.close();

  const storageRoot = join(root, "extension-storage");
  const repositoryRoot = join(root, "repository");
  const userDataRoot = join(root, "User");
  const cursorHome = join(root, ".cursor");
  await mkdir(storageRoot, { recursive: true });
  await mkdir(userDataRoot, { recursive: true });
  await writeFile(
    join(root, "product.json"),
    JSON.stringify({ version: "3.11.19", vscodeVersion: "1.125.0" }),
    "utf8",
  );

  const repository = await SyncRepository.create(
    repositoryRoot,
    storageRoot,
    "a sufficiently long end to end passphrase",
    128 * 1024 * 1024,
    { extensionVersion: "0.0.1", cursorVersion: "3.11.19", vscodeVersion: "1.125.0" },
  );

  const paths: CursorPaths = {
    appRoot: root,
    userDataRoot,
    globalStorageRoot: root,
    globalDatabase: databasePath,
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
    extensionStorage: storageRoot,
    helperScript: HELPER,
  };

  const requestId = "11111111-2222-4333-8444-555555555555";
  const request: HelperRequest = {
    version: 1,
    requestId,
    mode: "apply-and-restart",
    createdAt: new Date().toISOString(),
    repositoryRoot,
    storageRoot,
    cursorExecutable: process.execPath,
    // A pid that is not alive, so the exit wait is satisfied immediately.
    extensionHostPid: 0x7ffffffe,
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
      syncWorkspaceStorage: false,
      maxPayloadBytes: 128 * 1024 * 1024,
      gitSync: false,
    },
  };
  return {
    repository,
    request,
    requestPath: join(storageRoot, `helper-request-${requestId}.json`),
    databasePath,
  };
}

async function runHelper(fixture: Fixture): Promise<HelperResult> {
  await writeJsonAtomic(fixture.requestPath, fixture.request);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HELPER, fixture.requestPath],
      { timeout: 110_000 },
      (error) => {
        // A non-zero exit still writes a result, which the assertions read.
        if (error && !isReportedFailure(error)) {
          reject(error instanceof Error ? error : new Error("helper failed"));
          return;
        }
        resolve();
      },
    );
    child.stdin?.end(
      `${Buffer.from(fixture.repository.masterKey).toString("base64")}\n`,
    );
  });
  return readJsonFile<HelperResult>(
    join(fixture.request.storageRoot, `helper-result-${fixture.request.requestId}.json`),
  );
}

/** A helper that failed still reports; only a crash without a result is fatal. */
function isReportedFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === 1
  );
}

function readComposerIds(databasePath: string): string[] {
  if (databasePath.length === 0) {
    return [];
  }
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

function chatSnapshot(composerId = COMPOSER) {
  return {
    schemaVersion: 2 as const,
    composerId,
    header: {
      composerId,
      workspaceId: null,
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
    agentKv: {
      blobs: [],
      referencedIds: [],
      missingIds: [],
    },
  };
}
