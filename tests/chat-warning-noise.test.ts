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
const COMPOSER_A = "00000000-0000-4000-8000-00000000000a";
const COMPOSER_B = "00000000-0000-4000-8000-00000000000b";
const COMPOSER_C = "00000000-0000-4000-8000-00000000000c";
const BODYLESS_TAIL =
  "Expected when Cursor prunes a conversation and keeps its list entry; if you still expect one of these chats, its body was lost locally.";

function bodyless(count: number, sample: string, remainder = 0): string {
  return `Skipped ${count} chat(s) whose conversation body is not in the database: ${sample}${
    remainder === 0 ? "" : ` and ${remainder} more`
  }. ${BODYLESS_TAIL}`;
}

function composerId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("chat headers whose conversation body was pruned", () => {
  it("aggregates one warning instead of naming the chat, and publishes no deletion", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, { composerId: COMPOSER_A });
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChats(COMPOSER_A),
    );

    expect(result.notices).toEqual([bodyless(1, COMPOSER_A)]);
    expect(result.warnings).toEqual([]);
    expect(result.snapshots).toEqual([]);
    expect(result.deletions).toEqual([]);
  });

  it("counts every bodyless chat into a single warning", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, { composerId: COMPOSER_A });
    insertHeader(database, { composerId: COMPOSER_B });
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChats(COMPOSER_A, COMPOSER_B),
    );

    expect(result.notices).toEqual([
      bodyless(2, `${COMPOSER_A}, ${COMPOSER_B}`),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.deletions).toEqual([]);
  });

  it("bounds the sample of composer IDs so a mass loss is still diagnosable", async () => {
    const { paths, database } = await createGlobalDatabase();
    const composerIds = Array.from({ length: 7 }, (_, index) =>
      composerId(index),
    );
    for (const id of composerIds) {
      insertHeader(database, { composerId: id });
    }
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChats(...composerIds),
    );

    expect(result.notices).toEqual([
      bodyless(7, composerIds.slice(0, 5).join(", "), 2),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps the per-chat warning for a genuinely broken row alongside the aggregate", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, { composerId: COMPOSER_A });
    insertKv(database, `composerData:${COMPOSER_A}`, 5);
    insertHeader(database, { composerId: COMPOSER_B });
    insertHeader(database, { composerId: COMPOSER_C });
    insertKv(database, `composerData:${COMPOSER_C}`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChats(COMPOSER_A, COMPOSER_B, COMPOSER_C),
    );

    // A broken row is a warning; a pruned body is not. They are reported on
    // separate channels precisely so one cannot make the other look like a
    // failure to save.
    expect(result.warnings).toEqual([
      `Skipped chat ${COMPOSER_A}: cursorDiskKV key composerData:${COMPOSER_A} has an unsupported SQLite storage class: real.`,
    ]);
    expect(result.notices).toEqual([bodyless(1, COMPOSER_B)]);
    expect(result.snapshots.map((item) => item.resourceId)).toEqual([
      `chat/${COMPOSER_C}`,
    ]);
    expect(result.deletions).toEqual([]);
  });
});

describe("a composer header whose composerId has BLOB affinity", () => {
  it("recovers the chat ID from the bytes and publishes no deletion", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertBlobHeader(database, COMPOSER_A);
    insertKv(database, `composerData:${COMPOSER_A}`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChats(COMPOSER_A),
    );

    expect(result.deletions).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.snapshots.map((item) => item.resourceId)).toEqual([
      `chat/${COMPOSER_A}`,
    ]);
  });

  it("suppresses every chat deletion when the identity cannot be recovered", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertBlobHeader(database, "not-a-chat-id");
    // COMPOSER_B is genuinely gone, but with an unidentifiable row in the same
    // table a tombstone might just as well be for the chat we could not read.
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChats(COMPOSER_B),
    );

    expect(result.deletions).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped a composer header whose composerId is neither text nor a UTF-8 encoded chat ID; no chat deletions are published from this scan.",
    ]);
  });
});

describe("a composer row whose ID is not a chat ID", () => {
  it("is not published, because no device could ever apply it", async () => {
    // Cursor keeps `empty-state-draft` permanently. Publishing it cost an
    // event, a payload, a pending change that never clears and — once the other
    // machine published its own copy — a conflict with no automatic resolution
    // and nothing a person could adjudicate from a diff.
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, { composerId: "empty-state-draft" });
    insertKv(database, "composerData:empty-state-draft", "{}");
    insertHeader(database, { composerId: COMPOSER_A });
    insertKv(database, `composerData:${COMPOSER_A}`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChats(COMPOSER_A),
    );

    expect(result.snapshots.map((item) => item.resourceId)).toEqual([
      `chat/${COMPOSER_A}`,
    ]);
    // Silence, not a warning on every poll: this row is a normal thing for
    // Cursor to hold, not a fault worth reporting.
    expect(result.warnings).toEqual([]);
  });

  it("is never published as a deletion once a previous release published it", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, { composerId: "empty-state-draft" });
    insertKv(database, "composerData:empty-state-draft", "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan(
      knownChats("empty-state-draft"),
    );

    // A tombstone would be a claim about the resource; this build has nothing
    // to say about it, which is not the same thing.
    expect(result.deletions).toEqual([]);
    expect(result.snapshots).toEqual([]);
  });
});

function knownChats(
  ...composerIds: string[]
): Record<string, LocalProjection> {
  return Object.fromEntries(
    composerIds.map((composerId) => [
      `chat/${composerId}`,
      {
        resourceId: `chat/${composerId}`,
        kind: "chat",
        semanticHash: "hash",
        versionId: null,
      } satisfies LocalProjection,
    ]),
  );
}

async function createGlobalDatabase(): Promise<{
  paths: CursorPaths;
  database: InstanceType<typeof DatabaseSync>;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-sync-noise-"));
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
  header: { composerId: string },
): void {
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, 'workspace-a', 1, 2, 0, 0, 0, 0, '{}')`,
    )
    .run(header.composerId);
}

/**
 * TEXT affinity does not convert a BLOB, so the stored composerId reads back as
 * a Uint8Array — exactly what Cursor's own database has been observed to hold.
 */
function insertBlobHeader(
  database: InstanceType<typeof DatabaseSync>,
  composerId: string,
): void {
  database.exec(
    `INSERT INTO composerHeaders(
      composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
      isSubagent, recency, checkpointAt, value
    ) VALUES (CAST('${composerId}' AS BLOB), 'workspace-a', 1, 2, 0, 0, 0, 0, '{}')`,
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
