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
const COMPOSER = "00000000-0000-4000-8000-00000000000b";
const TIMESTAMP = 1785492730565;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("a conversation Cursor pruned on this computer alone", () => {
  it("is not published over the fuller copy in the shared folder", async () => {
    // The loss this pins, measured on the real pair: five chats holding 377
    // messages between them, every one of them an all-or-nothing loss. Cursor
    // prunes conversation bodies per computer. Publishing the pruned capture
    // made this device's housekeeping the shared truth, the other computer's
    // copy was overwritten with the empty one, and the conversation then
    // rendered up to a point and failed with "Conversation data missing" on
    // BOTH machines - which is exactly what the user saw.
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    // Cursor kept the list entry and the composerData and took the messages.
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChat({ sourceTimestamp: TIMESTAMP, sourceBubbleCount: 167 }),
    );

    expect(result.snapshots).toEqual([]);
    // Not a deletion either - that would take the chat off the other computer
    // just as thoroughly.
    expect(result.deletions).toEqual([]);
    expect(result.notices?.join(" ")).toContain("Held back 1 chat(s)");
    expect(result.notices?.join(" ")).toContain("167 -> 0");
  });

  it("holds back a partial loss too, not only a total one", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    for (let index = 0; index < 40; index += 1) {
      insertKv(database, `bubbleId:${COMPOSER}:b${index}`, `{"i":${index}}`);
    }
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChat({ sourceTimestamp: TIMESTAMP, sourceBubbleCount: 63 }),
    );

    expect(result.snapshots).toEqual([]);
  });

  it("still publishes a conversation that grew", async () => {
    // The rule is about shrinking only. Growth is the normal case and must not
    // be caught by it, or 0.0.53's fix is undone.
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    for (let index = 0; index < 63; index += 1) {
      insertKv(database, `bubbleId:${COMPOSER}:b${index}`, `{"i":${index}}`);
    }
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChat({ sourceTimestamp: TIMESTAMP, sourceBubbleCount: 1 }),
    );

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.metadata?.bubbleCount).toBe(63);
  });

  it("publishes a chat this device has never published", async () => {
    // No recorded count is "unknown", not "zero": a first capture of a chat
    // that legitimately has few messages must not read as a loss.
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});

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
  const root = await mkdtemp(join(tmpdir(), "cursor-sync-pruning-"));
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(composerId, null, 1, lastUpdatedAt, 0, 0, 0, 0, "{}");
}

function insertKv(
  database: InstanceType<typeof DatabaseSync>,
  key: string,
  value: string,
): void {
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(key, value);
}
