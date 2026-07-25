import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import {
  parsePortableChatSnapshot,
  StateVscdbChatAdapter,
  type PortableChatSnapshot,
} from "../src/chat/stateVscdb";
import { readStoreSnapshot } from "../src/chat/storeDb";
import { captureWorkspaceDatabaseSnapshot } from "../src/helper/workspaceDatabaseMerge";
import type { CursorPaths } from "../src/platform/paths";
import {
  ExtensionsAdapter,
  createExtensionIgnoreMatcher,
} from "../src/resources/extensions";
import { readPortableProfiles } from "../src/resources/profiles";
import { UiStateAdapter } from "../src/resources/uiState";
import { parseTargetStorageMarker } from "../src/resources/uiStatePolicy";
import type { LocalProjection } from "../src/types";

const { DatabaseSync } = sqlite;
const temporaryRoots: string[] = [];
const COMPOSER_A = "00000000-0000-4000-8000-00000000000a";
const COMPOSER_B = "00000000-0000-4000-8000-00000000000b";
const COMPOSER_C = "00000000-0000-4000-8000-00000000000c";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("chat scan over NULL SQLite values", () => {
  it("captures a NULL cursorDiskKV value instead of failing the whole scan", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, { composerId: COMPOSER_A });
    insertKv(database, `composerData:${COMPOSER_A}`, null);
    insertKv(database, `bubbleId:${COMPOSER_A}:1`, null);
    insertKv(database, `bubbleId:${COMPOSER_A}:2`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});

    expect(result.warnings).toEqual([]);
    expect(result.snapshots).toHaveLength(1);
    const snapshot = parsePortableChatSnapshot(result.snapshots[0]!.content);
    expect(snapshot.composerData).toEqual({
      key: `composerData:${COMPOSER_A}`,
      valueBase64: "",
      valueType: "null",
    });
    expect(snapshot.bubbles.map((bubble) => bubble.valueType)).toEqual([
      "null",
      "text",
    ]);
  });

  it("captures NULL composerHeaders columns as null rather than 0 or 'null'", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, {
      composerId: COMPOSER_A,
      workspaceId: null,
      createdAt: null,
      lastUpdatedAt: null,
      isArchived: null,
      recency: null,
      checkpointAt: null,
      value: null,
    });
    insertKv(database, `composerData:${COMPOSER_A}`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});

    const snapshot = parsePortableChatSnapshot(result.snapshots[0]!.content);
    expect(snapshot.header).toEqual({
      composerId: COMPOSER_A,
      workspaceId: null,
      createdAt: null,
      lastUpdatedAt: null,
      isArchived: null,
      isSubagent: 0,
      recency: null,
      checkpointAt: null,
      value: null,
    });
    expect(result.snapshots[0]!.metadata).toEqual({
      composerId: COMPOSER_A,
      workspaceId: null,
      workspaceUri: null,
      lastUpdatedAt: null,
      bubbleCount: 0,
    });
  });

  it("scans composers whose late-added isSubagent column is still NULL", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, { composerId: COMPOSER_A, isSubagent: null });
    insertKv(database, `composerData:${COMPOSER_A}`, "{}");
    insertHeader(database, { composerId: COMPOSER_B, isSubagent: 1 });
    insertKv(database, `composerData:${COMPOSER_B}`, "{}");
    database.close();

    const known: Record<string, LocalProjection> = {
      [`chat/${COMPOSER_A}`]: {
        resourceId: `chat/${COMPOSER_A}`,
        kind: "chat",
        semanticHash: "hash",
        versionId: null,
      },
    };
    const result = await new StateVscdbChatAdapter(paths).scan(known);

    expect(result.snapshots.map((item) => item.resourceId)).toEqual([
      `chat/${COMPOSER_A}`,
    ]);
    expect(result.deletions).toEqual([]);
  });

  it("skips an unsupported storage class without publishing a deletion", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, { composerId: COMPOSER_A });
    insertKv(database, `composerData:${COMPOSER_A}`, 5);
    insertHeader(database, { composerId: COMPOSER_B });
    insertKv(database, `composerData:${COMPOSER_B}`, "{}");
    insertHeader(database, { composerId: COMPOSER_C });
    database.close();

    const known: Record<string, LocalProjection> = {
      [`chat/${COMPOSER_A}`]: {
        resourceId: `chat/${COMPOSER_A}`,
        kind: "chat",
        semanticHash: "hash",
        versionId: null,
      },
      [`chat/${COMPOSER_C}`]: {
        resourceId: `chat/${COMPOSER_C}`,
        kind: "chat",
        semanticHash: "hash",
        versionId: null,
      },
    };
    const result = await new StateVscdbChatAdapter(paths).scan(known);

    expect(result.snapshots.map((item) => item.resourceId)).toEqual([
      `chat/${COMPOSER_B}`,
    ]);
    expect(result.deletions).toEqual([]);
    expect(result.warnings).toEqual([
      `Skipped chat ${COMPOSER_A}: cursorDiskKV key composerData:${COMPOSER_A} has an unsupported SQLite storage class: real.`,
      `Skipped 1 chat(s) whose conversation body is not in the database: ${COMPOSER_C}. Expected when Cursor prunes a conversation and keeps its list entry; if you still expect one of these chats, its body was lost locally.`,
    ]);
  });

  it("re-scans a chat whose lastUpdatedAt is NULL instead of matching a timestamp-less projection", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, { composerId: COMPOSER_A, lastUpdatedAt: null });
    insertKv(database, `composerData:${COMPOSER_A}`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({
      [`chat/${COMPOSER_A}`]: {
        resourceId: `chat/${COMPOSER_A}`,
        kind: "chat",
        semanticHash: "hash",
        versionId: null,
      },
    });

    expect(result.snapshots).toHaveLength(1);
  });
});

describe("portable chat snapshot NULL compatibility", () => {
  it("accepts nulls and the null storage class", () => {
    const snapshot = {
      schemaVersion: 1,
      composerId: COMPOSER_A,
      header: {
        composerId: COMPOSER_A,
        workspaceId: null,
        createdAt: null,
        lastUpdatedAt: null,
        isArchived: null,
        isSubagent: null,
        recency: null,
        checkpointAt: null,
        value: null,
      },
      composerData: {
        key: `composerData:${COMPOSER_A}`,
        valueBase64: "",
        valueType: "null",
      },
      bubbles: [],
    };

    const parsed = parsePortableChatSnapshot(
      Buffer.from(JSON.stringify(snapshot), "utf8"),
    );

    expect(parsed.header.workspaceId).toBeNull();
    expect(parsed.composerData.valueType).toBe("null");
  });

  it("still parses a snapshot published before valueType existed", () => {
    const snapshot = {
      schemaVersion: 1,
      composerId: COMPOSER_A,
      header: {
        composerId: COMPOSER_A,
        workspaceId: "workspace",
        createdAt: 1,
        lastUpdatedAt: 2,
        isArchived: 0,
        isSubagent: 0,
        recency: 0,
        checkpointAt: 0,
        value: "{}",
      },
      composerData: {
        key: `composerData:${COMPOSER_A}`,
        valueBase64: "e30=",
      },
      bubbles: [],
    };

    const parsed = parsePortableChatSnapshot(
      Buffer.from(JSON.stringify(snapshot), "utf8"),
    );

    expect(parsed.composerData.valueType).toBeUndefined();
  });
});

describe("ui-state scan over NULL SQLite values", () => {
  it("tolerates a NULL target storage marker", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertItem(database, "__$__targetStorageMarker", null);
    insertItem(database, "aicontext.personalContext", "rules");
    database.close();

    const result = await new UiStateAdapter(paths).scan({});

    expect(result.warnings).toEqual([]);
    expect(result.snapshots.map((item) => item.resourceId)).toEqual([
      "cursor-user-rules/aicontext.personalContext",
    ]);
  });

  it("skips a NULL value with a warning and never publishes it as a deletion", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertItem(database, "aicontext.personalContext", null);
    database.close();

    const resourceId = "cursor-user-rules/aicontext.personalContext";
    const result = await new UiStateAdapter(paths).scan({
      [resourceId]: {
        resourceId,
        kind: "cursor-user-rules",
        semanticHash: "hash",
        versionId: null,
      },
    });

    expect(result.snapshots).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(result.warnings).toEqual([
      "ui-state aicontext.personalContext: skipped an unusable SQLite value (NULL).",
    ]);
  });
});

describe("target storage marker parsing", () => {
  it("treats NULL, absent, and empty markers as no registered targets", () => {
    for (const value of [null, undefined, "", "   "]) {
      expect(parseTargetStorageMarker(value)).toEqual({});
    }
  });

  it("still rejects a present but unparseable marker", () => {
    expect(() => parseTargetStorageMarker("not json")).toThrow();
    expect(() => parseTargetStorageMarker("[]")).toThrow("must be an object");
  });
});

describe("profile manifest reads over NULL SQLite values", () => {
  it("treats a NULL userDataProfiles row as no profiles", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertItem(database, "userDataProfiles", null);
    database.close();

    expect(readPortableProfiles(paths.globalDatabase)).toEqual([]);
  });
});

describe("extensions scan when the profile manifest is unreadable", () => {
  it("degrades to the default profile with a warning instead of failing the adapter", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertItem(database, "userDataProfiles", "{ not json");
    database.close();

    const result = await new ExtensionsAdapter(paths, createExtensionIgnoreMatcher([])).scan({});

    expect(result.snapshots).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(result.warnings[0]).toContain("Unable to enumerate profiles");
  });

  it("treats a NULL profile manifest as no profiles", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertItem(database, "userDataProfiles", null);
    database.close();

    const result = await new ExtensionsAdapter(paths, createExtensionIgnoreMatcher([])).scan({});

    expect(
      result.warnings.some((warning) =>
        warning.includes("Unable to enumerate profiles"),
      ),
    ).toBe(false);
  });
});

describe("store.db snapshots over NULL identifiers", () => {
  it("skips a row whose key is NULL and warns instead of publishing it", async () => {
    const root = await temporaryRoot();
    const path = join(root, "store.db");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(null, "orphan");
    database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("kept", null);
    database.close();

    const warnings: string[] = [];
    const snapshot = readStoreSnapshot(path, "chats/session/store.db", warnings);

    expect(snapshot.meta).toEqual([{ key: "kept", value: { type: "null" } }]);
    expect(warnings).toEqual([
      "Skipped 1 store.db row(s) without a text key in chats/session/store.db.",
    ]);
  });
});

describe("workspace database capture over NULL keys", () => {
  it("skips a NULL key row instead of dropping the whole database from backup", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.vscdb");
    const database = new DatabaseSync(path);
    database.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database.exec(
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    const insert = database.prepare(
      "INSERT INTO ItemTable(key, value) VALUES (?, ?)",
    );
    insert.run(null, "orphan");
    insert.run("kept", null);
    database.close();

    const captured = captureWorkspaceDatabaseSnapshot(path, {
      workspaceId: "workspace-a",
    });

    const itemTable = captured.snapshot.tables.find(
      (table) => table.name === "ItemTable",
    );
    expect(itemTable?.rows).toEqual([
      { key: "kept", values: [{ type: "null" }] },
    ]);
    expect(captured.warnings).toEqual([
      "Skipped 1 row(s) with a non-text key in ItemTable.",
    ]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cursor-sync-null-"));
  temporaryRoots.push(root);
  return root;
}

async function createGlobalDatabase(): Promise<{
  paths: CursorPaths;
  database: InstanceType<typeof DatabaseSync>;
}> {
  const root = await temporaryRoot();
  const globalDatabase = join(root, "state.vscdb");
  const database = new DatabaseSync(globalDatabase);
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
  return {
    paths: {
      appRoot: root,
      globalDatabase,
      workspaceStorageRoot: join(root, "workspaceStorage"),
      profilesRoot: join(root, "profiles"),
      cursorHome: join(root, ".cursor"),
      cursorExtensionsManifest: join(root, ".cursor", "extensions", "extensions.json"),
    } as CursorPaths,
    database,
  };
}

function insertHeader(
  database: InstanceType<typeof DatabaseSync>,
  header: { composerId: string } & Partial<
    Record<keyof PortableChatSnapshot["header"], string | number | null>
  >,
): void {
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      header.composerId,
      header.workspaceId === undefined ? "workspace-a" : header.workspaceId,
      header.createdAt === undefined ? 1 : header.createdAt,
      header.lastUpdatedAt === undefined ? 2 : header.lastUpdatedAt,
      header.isArchived === undefined ? 0 : header.isArchived,
      header.isSubagent === undefined ? 0 : header.isSubagent,
      header.recency === undefined ? 0 : header.recency,
      header.checkpointAt === undefined ? 0 : header.checkpointAt,
      header.value === undefined ? "{}" : header.value,
    );
}

function insertKv(
  database: InstanceType<typeof DatabaseSync>,
  key: string,
  value: string | number | null,
): void {
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(key, value);
}

function insertItem(
  database: InstanceType<typeof DatabaseSync>,
  key: string,
  value: string | null,
): void {
  database
    .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
    .run(key, value);
}
