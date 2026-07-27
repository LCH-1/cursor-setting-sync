import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SyncRepository } from "../src/protocol/repository";
import { restoreDatabaseBackup } from "../src/helper/database";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
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
        : execFileSync("ps", ["-axo", "comm="]).toString();
    return parseCursorProcessIds(listing, process.platform).length > 0;
  } catch {
    return true;
  }
}

const runnable = existsSync(HELPER) && !cursorIsRunning();
const describeBuilt = runnable ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describeBuilt("the offline helper, end to end", () => {
  it("applies a peer's chat, backs the database up first, and restores cleanly", async () => {
    const fixture = await createFixture();

    // A change published by "the other computer".
    const body = canonicalBytes(chatSnapshot());
    const published = await fixture.repository.publish(
      [
        {
          resourceId: `chat/${COMPOSER}`,
          kind: "chat",
          content: body,
          semanticHash: sha256(body),
          metadata: { composerId: COMPOSER, workspaceId: null },
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
    expect(readComposerIds(result.backupPath ?? "")).not.toContain(COMPOSER);

    // And restoring it rolls the apply back, which is the whole point of taking
    // it: an apply nobody can undo is not one anybody should run.
    await restoreDatabaseBackup(
      fixture.databasePath,
      result.backupPath ?? "",
      fixture.request.storageRoot,
    );
    expect(readComposerIds(fixture.databasePath)).not.toContain(COMPOSER);
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

function chatSnapshot() {
  return {
    schemaVersion: 1 as const,
    composerId: COMPOSER,
    header: {
      composerId: COMPOSER,
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
      key: `composerData:${COMPOSER}`,
      valueBase64: Buffer.from("{}", "utf8").toString("base64"),
      valueType: "text" as const,
    },
    bubbles: [],
  };
}
