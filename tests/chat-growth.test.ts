import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { StateVscdbChatAdapter } from "../src/chat/stateVscdb";
import { sha256 } from "../src/protocol/canonical";
import type { CursorPaths } from "../src/platform/paths";
import type { LocalProjection, ResourceSnapshot } from "../src/types";

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

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);
    const result = await adapter.scan(known);

    expect(result.snapshots).toEqual([]);
    expect(result.deletions).toEqual([]);
  });

  it("stream-verifies mixed SQLite value types against canonical snapshots", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(
      database,
      COMPOSER,
      FROZEN_TIMESTAMP,
      JSON.stringify({ name: 'Escaped "title" \\ 한글' }),
    );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${COMPOSER}`, Buffer.from([0, 1, 2, 254, 255]));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${COMPOSER}:a`, 'text with "quotes" and \\ slashes');
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${COMPOSER}:b`, Buffer.from([255, 0, 127, 128]));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, NULL)")
      .run(`bubbleId:${COMPOSER}:c`);
    database.close();

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);

    expect((await adapter.scan(known)).snapshots).toEqual([]);
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

  it("learns a legacy projection's message count after exact verification", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, '{"text":"unchanged"}');
    database.close();

    const baseline = await new StateVscdbChatAdapter(paths).scan({});
    const known = projectionFromSnapshot(baseline.snapshots[0]!);
    const projection = known[`chat/${COMPOSER}`]!;
    delete projection.sourceBubbleCount;

    const adapter = new StateVscdbChatAdapter(paths);
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(projection.sourceTimestamp).toBe(FROZEN_TIMESTAMP);
    expect(projection.sourceBubbleCount).toBe(1);

    const blocker = new DatabaseSync(paths.globalDatabase);
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      // The learned count participates in the settled fingerprint, so this
      // scan must not reopen SQLite merely to relearn the same metadata.
      expect((await adapter.scan(known)).snapshots).toEqual([]);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("does not repeat a multi-batch sweep after learning legacy counts", async () => {
    const { paths, database } = await createGlobalDatabase();
    for (let index = 0; index < 9; index += 1) {
      const composerId = composerIdFor(index + 0x40);
      insertHeader(database, composerId, FROZEN_TIMESTAMP);
      insertKv(database, `composerData:${composerId}`, "{}");
      insertKv(database, `bubbleId:${composerId}:b0`, "{}");
    }
    database.close();

    const baseline = await new StateVscdbChatAdapter(paths).scan({});
    const known: Record<string, LocalProjection> = {};
    for (const snapshot of baseline.snapshots) {
      Object.assign(known, projectionFromSnapshot(snapshot));
      delete known[snapshot.resourceId]!.sourceBubbleCount;
    }

    const adapter = new StateVscdbChatAdapter(paths);
    // The first pass learns every legacy count; three bounded batches still
    // complete the nine-chat deep sweep (4 + 4 + 1).
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await adapter.scan(known)).snapshots).toEqual([]);
    }
    expect(
      Object.values(known).every(
        (projection) => projection.sourceBubbleCount === 1,
      ),
    ).toBe(true);

    const blocker = new DatabaseSync(paths.globalDatabase);
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      // A stale pre-learning sweep fingerprint would start a redundant second
      // sweep here and attempt to reopen the exclusively locked database.
      expect((await adapter.scan(known)).snapshots).toEqual([]);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("publishes the Cursor conversation title as lightweight restore metadata", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(
      database,
      COMPOSER,
      FROZEN_TIMESTAMP,
      JSON.stringify({ name: "Fix Restore Version History" }),
    );
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});

    expect(result.snapshots[0]?.metadata?.title).toBe(
      "Fix Restore Version History",
    );
  });

  it("does not reopen SQLite when the database, WAL and projection are unchanged", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);

    // BEGIN EXCLUSIVE changes no durable bytes but prevents a second SQLite
    // connection from reading this rollback-journal database. The follow-up
    // scan can succeed only by taking the stat-fingerprint fast path.
    const blocker = new DatabaseSync(paths.globalDatabase);
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      const result = await adapter.scan(known);
      expect(result.snapshots).toEqual([]);
      expect(result.deletions).toEqual([]);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("invalidates the fast path when only the WAL receives a new bubble", async () => {
    const { paths, database } = await createGlobalDatabase();
    database.exec("PRAGMA journal_mode=WAL");
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);

    try {
      insertKv(database, `bubbleId:${COMPOSER}:b1`, "{}");
      const result = await adapter.scan(known);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]?.metadata?.bubbleCount).toBe(2);
    } finally {
      database.close();
    }
  });

  it("detects a pruned bubble after a settled WAL scan", async () => {
    const { paths, database } = await createGlobalDatabase();
    database.exec("PRAGMA journal_mode=WAL");
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b1`, "{}");

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);

    try {
      database
        .prepare("DELETE FROM cursorDiskKV WHERE key = ?")
        .run(`bubbleId:${COMPOSER}:b1`);
      const result = await adapter.scan(known);
      expect(result.snapshots).toEqual([]);
      expect(result.notices?.join(" ")).toContain("2 -> 1");
    } finally {
      database.close();
    }
  });

  it("detects a header edit even when lastUpdatedAt stays frozen", async () => {
    const { paths, database } = await createGlobalDatabase();
    database.exec("PRAGMA journal_mode=WAL");
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);

    try {
      database
        .prepare("UPDATE composerHeaders SET value = ? WHERE composerId = ?")
        .run(JSON.stringify({ name: "Header changed" }), COMPOSER);
      const result = await adapter.scan(known);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]?.metadata?.title).toBe("Header changed");
    } finally {
      database.close();
    }
  });

  it("detects an in-place bubble update with the same key and count", async () => {
    const { paths, database } = await createGlobalDatabase();
    database.exec("PRAGMA journal_mode=WAL");
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);
    try {
      database
        .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
        .run("[]", `bubbleId:${COMPOSER}:b0`);

      const result = await adapter.scan(known);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]?.semanticHash).not.toBe(
        known[`chat/${COMPOSER}`]?.semanticHash,
      );
      expect(result.snapshots[0]?.metadata?.bubbleCount).toBe(1);
    } finally {
      database.close();
    }
  });

  it("detects an in-place composerData update with unchanged metadata", async () => {
    const { paths, database } = await createGlobalDatabase();
    database.exec("PRAGMA journal_mode=WAL");
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, '{"a":1}');
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);
    try {
      database
        .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
        .run('{"b":2}', `composerData:${COMPOSER}`);

      const result = await adapter.scan(known);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]?.semanticHash).not.toBe(
        known[`chat/${COMPOSER}`]?.semanticHash,
      );
      expect(result.snapshots[0]?.metadata?.bubbleCount).toBe(1);
    } finally {
      database.close();
    }
  });

  it("finds a frozen-timestamp header edit after the adapter is recreated", async () => {
    const { paths, database } = await createGlobalDatabase();
    database.exec("PRAGMA journal_mode=WAL");
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");

    const oldAdapter = new StateVscdbChatAdapter(paths);
    const baseline = await oldAdapter.scan({});
    const known = projectionFromSnapshot(baseline.snapshots[0]!);
    database
      .prepare("UPDATE composerHeaders SET value = ? WHERE composerId = ?")
      .run(JSON.stringify({ name: "Changed before restart" }), COMPOSER);

    try {
      const result = await new StateVscdbChatAdapter(paths).scan(known);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]?.metadata?.title).toBe(
        "Changed before restart",
      );
    } finally {
      database.close();
    }
  });

  it("invalidates the fast path when the known chat projection changes", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);
    const projection = known[`chat/${COMPOSER}`]!;
    const result = await adapter.scan({
      [`chat/${COMPOSER}`]: {
        ...projection,
        semanticHash: "repository-hash-changed-without-a-database-write",
      },
    });
    expect(result.snapshots).toHaveLength(1);
  });

  it("detects a deleted header after a settled scan", async () => {
    const { paths, database } = await createGlobalDatabase();
    database.exec("PRAGMA journal_mode=WAL");
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);
    expect((await adapter.scan(known)).deletions).toEqual([]);

    try {
      database
        .prepare("DELETE FROM composerHeaders WHERE composerId = ?")
        .run(COMPOSER);
      const result = await adapter.scan(known);
      expect(result.deletions.map((item) => item.resourceId)).toEqual([
        `chat/${COMPOSER}`,
      ]);
    } finally {
      database.close();
    }
  });

  it("settles when the known projection is already the chat tombstone", async () => {
    const { paths, database } = await createGlobalDatabase();
    database.close();
    const resourceId = `chat/${COMPOSER}`;
    const known = knownChat({
      semanticHash: sha256(`deleted:${resourceId}`),
      sourceTimestamp: FROZEN_TIMESTAMP,
      sourceBubbleCount: 1,
    });
    const adapter = new StateVscdbChatAdapter(paths);

    expect((await adapter.scan(known)).deletions).toEqual([]);

    const blocker = new DatabaseSync(paths.globalDatabase);
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      const result = await adapter.scan(known);
      expect(result.snapshots).toEqual([]);
      expect(result.deletions).toEqual([]);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("does not delete a chat committed after the header listing", async () => {
    const sentinel = "00000000-0000-4000-8000-00000000000b";
    const target = "00000000-0000-4000-8000-00000000000c";
    const { paths, database } = await createGlobalDatabase();
    database.exec("PRAGMA journal_mode=WAL");
    insertHeader(database, sentinel, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${sentinel}`, "{}");
    insertKv(database, `bubbleId:${sentinel}:b0`, "{}");

    const targetResourceId = `chat/${target}`;
    const known = {
      [targetResourceId]: projectionFor(target, "target-known-hash"),
    } as Record<string, LocalProjection>;
    const sentinelProjection = projectionFor(sentinel, "sentinel-known-hash");
    let sentinelReads = 0;
    let targetCommitted = false;
    Object.defineProperty(known, `chat/${sentinel}`, {
      enumerable: true,
      get(): LocalProjection {
        sentinelReads += 1;
        // Object.values() reads once while fingerprints are built. The second
        // read occurs in the composer loop, after SELECT ... composerHeaders
        // has already materialized its complete header list.
        if (sentinelReads === 2) {
          database.exec("BEGIN IMMEDIATE");
          try {
            insertHeader(database, target, FROZEN_TIMESTAMP);
            insertKv(database, `composerData:${target}`, "{}");
            insertKv(database, `bubbleId:${target}:b0`, "{}");
            database.exec("COMMIT");
            targetCommitted = true;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        }
        return sentinelProjection;
      },
    });

    try {
      const result = await new StateVscdbChatAdapter(paths).scan(known);
      expect(targetCommitted).toBe(true);
      expect(result.deletions).toEqual([]);
      expect(
        database
          .prepare("SELECT 1 AS present FROM composerHeaders WHERE composerId = ?")
          .get(target),
      ).toEqual({ present: 1 });
    } finally {
      database.close();
    }
  });

  it("bounds fallback semantic verification to four chats per poll", async () => {
    const { paths, database } = await createGlobalDatabase();
    const known: Record<string, LocalProjection> = {};
    for (let index = 0; index < 17; index += 1) {
      const composerId = composerIdFor(index + 0x20);
      insertHeader(database, composerId, FROZEN_TIMESTAMP);
      insertKv(database, `composerData:${composerId}`, "{}");
      insertKv(database, `bubbleId:${composerId}:b0`, "{}");
      known[`chat/${composerId}`] = projectionFor(composerId, `old-${index}`);
    }
    database.close();

    const adapter = new StateVscdbChatAdapter(paths);
    const acknowledgedKnown = { ...known };
    const emitted = new Set<string>();
    const batchSizes: number[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      const result = await adapter.scan(acknowledgedKnown);
      batchSizes.push(result.snapshots.length);
      for (const snapshot of result.snapshots) {
        emitted.add(snapshot.resourceId);
        acknowledgedKnown[snapshot.resourceId] = {
          ...acknowledgedKnown[snapshot.resourceId]!,
          semanticHash: snapshot.semanticHash,
        };
      }
    }

    expect(batchSizes).toEqual([4, 4, 4, 4, 1]);
    expect(emitted.size).toBe(17);
  });

  it("re-emits a late-sweep snapshot until the known projection acknowledges it", async () => {
    const { paths, database } = await createGlobalDatabase();
    database.exec("PRAGMA journal_mode=WAL");
    for (let index = 0; index < 17; index += 1) {
      const composerId = composerIdFor(index + 0x20);
      insertHeader(database, composerId, FROZEN_TIMESTAMP);
      insertKv(database, `composerData:${composerId}`, "{}");
      insertKv(database, `bubbleId:${composerId}:b0`, '{"text":"old"}');
    }

    const adapter = new StateVscdbChatAdapter(paths);
    const baseline = await adapter.scan({});
    expect(baseline.snapshots).toHaveLength(17);
    const known: Record<string, LocalProjection> = {};
    for (const snapshot of baseline.snapshots) {
      Object.assign(known, projectionFromSnapshot(snapshot));
    }
    // The empty -> populated projection transition requests a follow-up pass;
    // complete it so the mutation below begins from a genuinely idle adapter.
    for (let pass = 0; pass < 9; pass += 1) {
      expect((await adapter.scan(known)).snapshots).toEqual([]);
    }

    const changedComposerId = composerIdFor(0x30);
    const changedResourceId = `chat/${changedComposerId}`;
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"new"}', `bubbleId:${changedComposerId}:b0`);

    // The changed chat is seventeenth in sorted order. Four bounded batches
    // are deliberately quiet before the fifth reaches and emits it.
    for (let pass = 0; pass < 4; pass += 1) {
      expect((await adapter.scan(known)).snapshots).toEqual([]);
    }
    const emitted = await adapter.scan(known);
    expect(emitted.snapshots.map((item) => item.resourceId)).toEqual([
      changedResourceId,
    ]);

    // Simulate publish failure by leaving `known` untouched. The next poll must
    // retry the exact local value instead of accepting the preceding quiet
    // batch as proof that the database is settled.
    const retry = await adapter.scan(known);
    expect(retry.snapshots.map((item) => item.resourceId)).toEqual([
      changedResourceId,
    ]);
    expect(retry.snapshots[0]?.semanticHash).toBe(
      emitted.snapshots[0]?.semanticHash,
    );

    const acknowledged = {
      ...known,
      [changedResourceId]: {
        ...known[changedResourceId]!,
        semanticHash: emitted.snapshots[0]!.semanticHash,
      },
    };
    expect((await adapter.scan(acknowledged)).snapshots).toEqual([]);
    expect((await adapter.scan(acknowledged)).snapshots).toEqual([]);
    database.close();
  });

  it("drops a pending snapshot when Cursor prunes its body before retry", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, '{"text":"old"}');

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"new"}', `bubbleId:${COMPOSER}:b0`);
    expect((await adapter.scan(known)).snapshots).toHaveLength(1);

    database
      .prepare("DELETE FROM cursorDiskKV WHERE key = ?")
      .run(`composerData:${COMPOSER}`);
    const pruned = await adapter.scan(known);
    expect(pruned.snapshots).toEqual([]);
    expect(pruned.notices?.join(" ")).toContain("body is not in the database");

    database.close();
    const blocker = new DatabaseSync(paths.globalDatabase);
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      // The pending put is no longer reconstructable. Reopening SQLite here
      // would wait on the exclusive lock and fail; the settled fast path proves
      // the obsolete retry marker was cleared.
      expect((await adapter.scan(known)).snapshots).toEqual([]);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("drops a pending snapshot when the local chat reverts before acknowledgement", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, '{"text":"old"}');

    const adapter = new StateVscdbChatAdapter(paths);
    const known = await settleKnownChat(adapter);
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"new"}', `bubbleId:${COMPOSER}:b0`);
    expect((await adapter.scan(known)).snapshots).toHaveLength(1);

    // Simulate a local undo before the emitted put reaches repository state.
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"old"}', `bubbleId:${COMPOSER}:b0`);
    expect((await adapter.scan(known)).snapshots).toEqual([]);

    database.close();
    const blocker = new DatabaseSync(paths.globalDatabase);
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      // The reverted pending marker was cleared, so the settled fingerprint
      // path does not reopen the exclusively locked database.
      expect((await adapter.scan(known)).snapshots).toEqual([]);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });
});

async function settleKnownChat(
  adapter: StateVscdbChatAdapter,
): Promise<Record<string, LocalProjection>> {
  const baseline = await adapter.scan({});
  expect(baseline.snapshots).toHaveLength(1);
  const known = projectionFromSnapshot(baseline.snapshots[0]!);
  expect((await adapter.scan(known)).snapshots).toEqual([]);
  return known;
}

function projectionFromSnapshot(
  snapshot: ResourceSnapshot,
): Record<string, LocalProjection> {
  return {
    [snapshot.resourceId]: {
      resourceId: snapshot.resourceId,
      kind: "chat",
      semanticHash: snapshot.semanticHash,
      versionId: null,
      sourceTimestamp: snapshot.metadata?.lastUpdatedAt as number,
      sourceBubbleCount: snapshot.metadata?.bubbleCount as number,
    },
  };
}

function projectionFor(
  composerId: string,
  semanticHash: string,
): LocalProjection {
  return {
    resourceId: `chat/${composerId}`,
    kind: "chat",
    semanticHash,
    versionId: null,
    sourceTimestamp: FROZEN_TIMESTAMP,
    sourceBubbleCount: 1,
  };
}

function composerIdFor(suffix: number): string {
  return `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;
}

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
  value = "{}",
): void {
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, 'workspace-a', 1, ?, 0, 0, 0, 0, ?)`,
    )
    .run(composerId, lastUpdatedAt, value);
}

function insertKv(
  database: InstanceType<typeof DatabaseSync>,
  key: string,
  value: string,
): void {
  database.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)").run(key, value);
}
