import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { StateVscdbChatAdapter } from "../src/chat/stateVscdb";
import type { CursorPaths } from "../src/platform/paths";
import type { LocalProjection } from "../src/types";

const { DatabaseSync } = sqlite;
const temporaryRoots: string[] = [];
const COMPOSER = "00000000-0000-4000-8000-00000000000a";
/** Cursor stamps this once, near the start, and then leaves it alone. */
const FROZEN_TIMESTAMP = 1785492730565;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("a conversation that grows after its header stops changing", () => {
  it("republishes when messages are added under an unchanged timestamp", async () => {
    // The bug this pins, measured on the real pair: Cursor writes
    // composerHeaders.lastUpdatedAt once near the start of a conversation and
    // then streams the rest of the messages into cursorDiskKV without touching
    // it. A scan that ran while the chat had one message published one message
    // and recorded that timestamp; every later scan compared equal and skipped
    // the chat, so the conversation stayed frozen at its first message in the
    // repository however long it went on. A chat with 63 messages on disk was
    // published with one, and the second computer showed exactly that one.
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    for (let index = 0; index < 63; index += 1) {
      insertKv(database, `bubbleId:${COMPOSER}:b${index}`, `{"i":${index}}`);
    }
    database.close();

    // What the projection looks like after publishing at one message: the same
    // timestamp the header still carries.
    const known = knownChat({ sourceTimestamp: FROZEN_TIMESTAMP, sourceBubbleCount: 1 });

    const result = await new StateVscdbChatAdapter(paths).scan(known);

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.metadata?.bubbleCount).toBe(63);
  });

  it("still skips a conversation that really has not moved", async () => {
    // The fast path has to survive: this runs for every chat on every poll,
    // against a database Cursor is concurrently writing to.
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    for (let index = 0; index < 63; index += 1) {
      insertKv(database, `bubbleId:${COMPOSER}:b${index}`, `{"i":${index}}`);
    }
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChat({ sourceTimestamp: FROZEN_TIMESTAMP, sourceBubbleCount: 63 }),
    );

    expect(result.snapshots).toEqual([]);
    expect(result.deletions).toEqual([]);
  });

  it("publishes a chat whose projection predates the message count", async () => {
    // Upgrade path: projections written before 0.0.53 carry no bubble count, so
    // the comparison must treat "absent" as "unknown" and re-read rather than
    // as a match. Otherwise every chat frozen by the old bug stays frozen.
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChat({ sourceTimestamp: FROZEN_TIMESTAMP }),
    );

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.metadata?.bubbleCount).toBe(1);
  });
});

function knownChat(
  extra: Partial<LocalProjection>,
): Record<string, LocalProjection> {
  return {
    [`chat/${COMPOSER}`]: {
      resourceId: `chat/${COMPOSER}`,
      kind: "chat",
      semanticHash: "hash",
      versionId: null,
      ...extra,
    },
  };
}

async function createGlobalDatabase(): Promise<{
  paths: CursorPaths;
  database: InstanceType<typeof DatabaseSync>;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-sync-growth-"));
  temporaryRoots.push(root);
  const globalDatabase = join(root, "state.vscdb");
  const database = new DatabaseSync(globalDatabase);
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
  composerId: string,
  lastUpdatedAt: number,
): void {
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, 'workspace-a', 1, ?, 0, 0, 0, 0, '{}')`,
    )
    .run(composerId, lastUpdatedAt);
}

function insertKv(
  database: InstanceType<typeof DatabaseSync>,
  key: string,
  value: string,
): void {
  database.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)").run(key, value);
}
