import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import {
  CHAT_DEEP_VERIFICATION_INTERVAL_MS,
  CHAT_OVERSIZED_SETTLEMENT_OVERFLOW_RESOURCE_ID,
  COMPOSER_HEADER_METADATA_AFTER_CURSOR_SQL,
  COMPOSER_HEADER_RECENT_PAGE_SQL,
  MAX_CHAT_BODY_CAPTURES_PER_SCAN,
  MAX_CHAT_BUBBLE_COUNT_PROBES_PER_SCAN,
  MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE,
  MAX_CHAT_CORE_METADATA_ROWS,
  MAX_CHAT_INTERACTIVE_CAPTURE_BYTES,
  MAX_CHAT_OVERSIZED_SETTLEMENTS,
  MAX_CHAT_OVERSIZED_WARNING_SAMPLES,
  MAX_CHAT_PENDING_BUBBLE_COUNT_MISMATCHES,
  MAX_CHAT_SNAPSHOT_BYTES_PER_SCAN,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  StateVscdbChatAdapter,
} from "../src/chat/stateVscdb";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import { shouldPublishSnapshot } from "../src/sync/versionPolicy";
import type { CursorPaths } from "../src/platform/paths";
import type { LocalProjection, ResourceSnapshot, ResourceTip } from "../src/types";

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

  it("captures only the transitive agentKv graph reachable from conversationState", async () => {
    const { paths, database } = await createGlobalDatabase();
    const leaf = Buffer.from("opaque text leaf", "utf8");
    const leafId = sha256(leaf);
    const root = bytesField(2, Buffer.from(leafId, "hex"));
    const rootId = sha256(root);
    const unreachable = Buffer.from("unrelated global blob", "utf8");
    const unreachableId = sha256(unreachable);
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({
        conversationState: state(bytesField(1, Buffer.from(rootId, "hex"))),
      }),
    );
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${rootId}`, root);
    insertKv(database, `agentKv:blob:${leafId}`, leaf.toString("utf8"));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${unreachableId}`, unreachable);
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});
    const snapshot = parsePortableChatSnapshot(result.snapshots[0]!.content);
    expect(snapshot.schemaVersion).toBe(2);
    if (snapshot.schemaVersion !== 2) {
      throw new Error("expected a v2 chat snapshot");
    }
    expect(snapshot.agentKv.blobs.map((row) => row.key)).toEqual(
      [leafId, rootId].sort().map((id) => `agentKv:blob:${id}`),
    );
    expect(snapshot.agentKv.blobs.map((row) => row.valueType).sort()).toEqual([
      "blob",
      "text",
    ]);
    expect(snapshot.agentKv.referencedIds).toEqual([leafId, rootId].sort());
    expect(snapshot.agentKv.missingIds).toEqual([]);
    expect(result.snapshots[0]?.metadata).toMatchObject({
      chatSnapshotSchemaVersion: 2,
      chatCoreHash: portableChatCoreHash(snapshot),
      agentKvBlobCount: 2,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 0,
    });
  });

  it("spends the two initial graph captures on the newest chats with an ID tie-break", async () => {
    const { paths, database } = await createGlobalDatabase();
    const chats = [
      { suffix: 0x86, lastUpdatedAt: null },
      { suffix: 0x80, lastUpdatedAt: FROZEN_TIMESTAMP - 10 },
      { suffix: 0x83, lastUpdatedAt: FROZEN_TIMESTAMP + 100 },
      { suffix: 0x81, lastUpdatedAt: FROZEN_TIMESTAMP + 100 },
      { suffix: 0x82, lastUpdatedAt: FROZEN_TIMESTAMP + 100 },
      { suffix: 0x84, lastUpdatedAt: FROZEN_TIMESTAMP },
    ] as const;
    for (const [index, chat] of chats.entries()) {
      const composerId = composerIdFor(chat.suffix);
      const blob = Buffer.from(`bounded-blob-${index}`, "utf8");
      const id = sha256(blob);
      insertHeader(database, composerId, chat.lastUpdatedAt);
      insertKv(
        database,
        `composerData:${composerId}`,
        JSON.stringify({
          conversationState: state(bytesField(1, Buffer.from(id, "hex"))),
        }),
      );
      insertKv(database, `bubbleId:${composerId}:b0`, "{}");
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(`agentKv:blob:${id}`, blob);
    }
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});
    expect(result.snapshots).toHaveLength(6);
    const versions = result.snapshots.map(
      (item) => parsePortableChatSnapshot(item.content).schemaVersion,
    );
    expect(versions.filter((version) => version === 2)).toHaveLength(2);
    expect(versions.filter((version) => version === 1)).toHaveLength(4);
    expect(
      result.snapshots
        .filter(
          (item) => parsePortableChatSnapshot(item.content).schemaVersion === 2,
        )
        .map((item) => item.resourceId),
    ).toEqual([
      `chat/${composerIdFor(0x81)}`,
      `chat/${composerIdFor(0x82)}`,
    ]);
    expect(
      result.snapshots.reduce(
        (total, item) => {
          const snapshot = parsePortableChatSnapshot(item.content);
          return (
            total +
            (snapshot.schemaVersion === 2 ? snapshot.agentKv.blobs.length : 0)
          );
        },
        0,
      ),
    ).toBe(2);
    expect(result.notices?.join(" ")).toContain("graph-work budget");
  });

  it("falls back to v1 when one graph exceeds the per-chat node cap", async () => {
    const { paths, database } = await createGlobalDatabase();
    const ids = Array.from({ length: 4_097 }, (_, index) =>
      sha256(`bounded-missing-${index}`),
    );
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({
        conversationState: state(
          Buffer.concat(
            ids.map((id) => bytesField(1, Buffer.from(id, "hex"))),
          ),
        ),
      }),
    );
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});
    expect(
      parsePortableChatSnapshot(result.snapshots[0]!.content).schemaVersion,
    ).toBe(1);
    expect(result.notices?.join(" ")).toContain("nodes safety limit");
  });

  it("checks an oversized agentKv row length before materializing its value", async () => {
    const { paths, database } = await createGlobalDatabase();
    const oversizedId = "ab".repeat(32);
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({
        conversationState: state(
          bytesField(1, Buffer.from(oversizedId, "hex")),
        ),
      }),
    );
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(33554433))",
      )
      .run(`agentKv:blob:${oversizedId}`);
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});

    expect(
      parsePortableChatSnapshot(result.snapshots[0]!.content).schemaVersion,
    ).toBe(1);
    expect(result.notices?.join(" ")).toContain("bytes safety limit");
  });

  it("records missing and hash-invalid reachable rows as missing IDs", async () => {
    const { paths, database } = await createGlobalDatabase();
    const missingId = "1".repeat(64);
    const tamperedId = "2".repeat(64);
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({
        conversationState: state(
          Buffer.concat([
            bytesField(1, Buffer.from(missingId, "hex")),
            bytesField(2, Buffer.from(tamperedId, "hex")),
          ]),
        ),
      }),
    );
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    insertKv(database, `agentKv:blob:${tamperedId}`, "wrong bytes");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});
    const snapshot = parsePortableChatSnapshot(result.snapshots[0]!.content);
    expect(snapshot.schemaVersion).toBe(2);
    if (snapshot.schemaVersion === 2) {
      expect(snapshot.agentKv.blobs).toEqual([]);
      expect(snapshot.agentKv.referencedIds).toEqual([missingId, tamperedId]);
      expect(snapshot.agentKv.missingIds).toEqual([missingId, tamperedId]);
    }
  });

  it("falls back to a renderable v1 core for an unknown conversationState", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({ conversationState: "legacy-not-tilde" }),
    );
    insertKv(database, `bubbleId:${COMPOSER}:b0`, '{"text":"still synced"}');
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});
    expect(
      parsePortableChatSnapshot(result.snapshots[0]!.content).schemaVersion,
    ).toBe(1);
    expect(result.notices?.join(" ")).toContain("schema v1");
    expect(result.warnings).toEqual([]);
  });

  it("falls back to v1 when decoded conversation JSON exceeds the structural limit", async () => {
    const { paths, database } = await createGlobalDatabase();
    let nested = "0";
    for (let depth = 0; depth < 257; depth += 1) {
      nested = `[${nested}]`;
    }
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, nested);
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();

    const result = await new StateVscdbChatAdapter(paths).scan({});

    expect(
      parsePortableChatSnapshot(result.snapshots[0]!.content).schemaVersion,
    ).toBe(1);
    expect(result.notices?.join(" ")).toContain(
      "decoded conversation JSON exceeds",
    );
    expect(result.warnings).toEqual([]);
  });

  it("learns a byte-equal legacy core hash without walking agentKv", async () => {
    const { paths, database } = await createGlobalDatabase();
    const unavailableId = "a".repeat(64);
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({
        conversationState: state(
          bytesField(1, Buffer.from(unavailableId, "hex")),
        ),
      }),
    );
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();

    const baseline = await new StateVscdbChatAdapter(paths).scan({});
    const v2 = parsePortableChatSnapshot(baseline.snapshots[0]!.content);
    const legacy = canonicalBytes({
      schemaVersion: 1,
      composerId: v2.composerId,
      header: v2.header,
      composerData: v2.composerData,
      bubbles: v2.bubbles,
    });
    const known = knownChat({
      semanticHash: sha256(legacy),
      sourceTimestamp: FROZEN_TIMESTAMP,
      sourceBubbleCount: 1,
    });

    const verified = await new StateVscdbChatAdapter(paths).scan(known);
    expect(verified.snapshots).toEqual([]);
    expect(known[`chat/${COMPOSER}`]?.sourceChatCoreHash).toBe(sha256(legacy));
  });

  it("walks agentKv once after an incomplete automatic repair projection", async () => {
    const { paths, database } = await createGlobalDatabase();
    const blob = Buffer.from("repair continuation", "utf8");
    const id = sha256(blob);
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({
        conversationState: state(bytesField(1, Buffer.from(id, "hex"))),
      }),
    );
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${id}`, blob);
    database.close();

    const baseline = await new StateVscdbChatAdapter(paths).scan({});
    const complete = parsePortableChatSnapshot(baseline.snapshots[0]!.content);
    const legacy = canonicalBytes({
      schemaVersion: 1,
      composerId: complete.composerId,
      header: complete.header,
      composerData: complete.composerData,
      bubbles: complete.bubbles,
    });
    const known = knownChat({
      semanticHash: sha256(legacy),
      sourceTimestamp: FROZEN_TIMESTAMP,
      sourceBubbleCount: 1,
      sourceChatCoreHash: sha256(legacy),
      requiresAgentKvRecapture: true,
    });

    const recovered = await new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
    }).scan(known);

    expect(recovered.snapshots).toHaveLength(1);
    expect(recovered.snapshots[0]?.metadata?.syncOrigin).toBe(
      "agent-kv-recapture",
    );
    const snapshot = parsePortableChatSnapshot(recovered.snapshots[0]!.content);
    expect(snapshot.schemaVersion).toBe(2);
    if (snapshot.schemaVersion === 2) {
      expect(snapshot.agentKv.missingIds).toEqual([]);
      expect(snapshot.agentKv.blobs.map((row) => row.key)).toEqual([
        `agentKv:blob:${id}`,
      ]);
    }
    // The source projection keeps the request until the v2 child is actually
    // acknowledged. A publish failure followed by process restart therefore
    // performs the bounded recapture again instead of falling back forever to
    // the repaired v1 core shortcut.
    expect(known[`chat/${COMPOSER}`]?.requiresAgentKvRecapture).toBe(true);
    const retried = await new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
    }).scan(known);
    expect(retried.snapshots).toHaveLength(1);
    const acknowledged = projectionFromSnapshot(recovered.snapshots[0]!);
    expect(
      (
        await new StateVscdbChatAdapter(paths, {
          periodicDeepVerification: false,
        }).scan(acknowledged)
      ).snapshots,
    ).toEqual([]);
  });

  it("defers excess repair recaptures instead of consuming their one-shot as v1", async () => {
    const { paths, database } = await createGlobalDatabase();
    const composerIds = [0x91, 0x92, 0x93].map(composerIdFor);
    for (const [index, composerId] of composerIds.entries()) {
      const blob = Buffer.from(`repair continuation ${index}`, "utf8");
      const id = sha256(blob);
      insertHeader(database, composerId, FROZEN_TIMESTAMP);
      insertKv(
        database,
        `composerData:${composerId}`,
        JSON.stringify({
          conversationState: state(bytesField(1, Buffer.from(id, "hex"))),
        }),
      );
      insertKv(database, `bubbleId:${composerId}:b0`, "{}");
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(`agentKv:blob:${id}`, blob);
    }
    database.close();

    const baseline = await new StateVscdbChatAdapter(paths).scan({});
    expect(baseline.snapshots).toHaveLength(3);
    const known: Record<string, LocalProjection> = {};
    for (const item of baseline.snapshots) {
      const parsed = parsePortableChatSnapshot(item.content);
      const legacy = canonicalBytes({
        schemaVersion: 1,
        composerId: parsed.composerId,
        header: parsed.header,
        composerData: parsed.composerData,
        bubbles: parsed.bubbles,
      });
      known[item.resourceId] = {
        resourceId: item.resourceId,
        kind: "chat",
        semanticHash: sha256(legacy),
        versionId: null,
        sourceTimestamp: FROZEN_TIMESTAMP,
        sourceBubbleCount: 1,
        sourceChatCoreHash: sha256(legacy),
        requiresAgentKvRecapture: true,
      };
    }

    const materialized: string[] = [];
    const adapter = new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
      onChatSnapshotMaterialize: (resourceId) => materialized.push(resourceId),
    });
    const first = await adapter.scan(known);
    expect(first.snapshots).toHaveLength(2);
    expect(materialized).toEqual(
      first.snapshots.map((snapshot) => snapshot.resourceId),
    );
    expect(adapter.scanStatus().complete).toBe(false);
    for (const item of first.snapshots) {
      expect(item.metadata?.syncOrigin).toBe("agent-kv-recapture");
      expect(parsePortableChatSnapshot(item.content).schemaVersion).toBe(2);
      Object.assign(known, projectionFromSnapshot(item));
    }

    const second = await adapter.scan(known);
    expect(second.snapshots).toHaveLength(1);
    expect(materialized).toEqual(
      [...first.snapshots, ...second.snapshots].map(
        (snapshot) => snapshot.resourceId,
      ),
    );
    expect(second.snapshots[0]?.metadata?.syncOrigin).toBe(
      "agent-kv-recapture",
    );
    expect(
      parsePortableChatSnapshot(second.snapshots[0]!.content).schemaVersion,
    ).toBe(2);
    expect(
      new Set(
        [...first.snapshots, ...second.snapshots].map(
          (snapshot) => snapshot.resourceId,
        ),
      ),
    ).toEqual(new Set(composerIds.map((id) => `chat/${id}`)));
  });

  it("reasserts a byte-identical incomplete repair as an ordinary recapture", async () => {
    const { paths, database } = await createGlobalDatabase();
    const missingId = "7a".repeat(32);
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({
        conversationState: state(
          bytesField(1, Buffer.from(missingId, "hex")),
        ),
      }),
    );
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();

    const baseline = await new StateVscdbChatAdapter(paths).scan({});
    const known = projectionFromSnapshot(baseline.snapshots[0]!);
    known[`chat/${COMPOSER}`]!.requiresAgentKvRecapture = true;
    const repairTip: ResourceTip = {
      versionId: `${"a".repeat(64)}#0`,
      eventHash: "a".repeat(64),
      changeIndex: 0,
      kind: "chat",
      lamport: 1,
      deviceId: "repair-device",
      operation: "put",
      semanticHash: baseline.snapshots[0]!.semanticHash,
      parents: [],
      metadata: { syncOrigin: "automatic-chat-repair" },
    };

    const recaptured = await new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
    }).scan(known);

    expect(recaptured.snapshots).toHaveLength(1);
    expect(recaptured.snapshots[0]?.semanticHash).toBe(repairTip.semanticHash);
    expect(recaptured.snapshots[0]?.metadata?.syncOrigin).toBe(
      "agent-kv-recapture",
    );
    expect(
      shouldPublishSnapshot(
        known[`chat/${COMPOSER}`],
        recaptured.snapshots[0]!,
        [repairTip],
      ),
    ).toBe(true);
    expect(known[`chat/${COMPOSER}`]?.requiresAgentKvRecapture).toBe(true);
    expect(
      shouldPublishSnapshot(
        known[`chat/${COMPOSER}`],
        recaptured.snapshots[0]!,
        [
          repairTip,
          {
            ...repairTip,
            versionId: `${"b".repeat(64)}#0`,
            eventHash: "b".repeat(64),
            deviceId: "ordinary-device",
            metadata: { syncOrigin: "agent-kv-recapture" },
          },
        ],
      ),
    ).toBe(false);
  });

  it("force-verifies an exact queued chat despite equal timestamp and count", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, '{"text":"before"}');
    database.close();

    const baseline = await new StateVscdbChatAdapter(paths).scan({});
    const known = projectionFromSnapshot(baseline.snapshots[0]!);
    const changed = new DatabaseSync(paths.globalDatabase);
    changed
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"after!"}', `bubbleId:${COMPOSER}:b0`);
    changed.close();

    const result = await new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
      forceCoreVerificationResourceIds: [`chat/${COMPOSER}`],
    }).scan(known);

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.semanticHash).not.toBe(
      baseline.snapshots[0]?.semanticHash,
    );
  });

  it("uses the remembered core hash without rereading changed agentKv blobs", async () => {
    const { paths, database } = await createGlobalDatabase();
    const blob = Buffer.from("stable addressed blob", "utf8");
    const id = sha256(blob);
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({
        conversationState: state(bytesField(1, Buffer.from(id, "hex"))),
      }),
    );
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${id}`, blob);

    const adapter = new StateVscdbChatAdapter(paths);
    const baseline = await adapter.scan({});
    const known = projectionFromSnapshot(baseline.snapshots[0]!);
    known[`chat/${COMPOSER}`]!.sourceChatCoreHash = baseline.snapshots[0]!
      .metadata!.chatCoreHash as string;
    // A changed database generation starts another bounded verification, but
    // content-addressed enrichment is separate from mutable core verification.
    // If this path queried/walked the blob, the now-invalid row would turn the
    // v2 payload into a missing ID and emit a different snapshot.
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run("corrupt replacement", `agentKv:blob:${id}`);

    expect((await adapter.scan(known)).snapshots).toEqual([]);
    database.close();
  });

  it("does not JSON-parse every bubble during an unchanged forced verification", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      JSON.stringify({ conversationState: "~" }),
    );
    for (let index = 0; index < 128; index += 1) {
      insertKv(
        database,
        `bubbleId:${COMPOSER}:b${String(index).padStart(3, "0")}`,
        JSON.stringify({ text: `bubble-${index}` }),
      );
    }
    database.close();

    const baseline = await new StateVscdbChatAdapter(paths).scan({});
    const known = projectionFromSnapshot(baseline.snapshots[0]!);
    known[`chat/${COMPOSER}`]!.sourceChatCoreHash = baseline.snapshots[0]!
      .metadata!.chatCoreHash as string;
    const parse = vi.spyOn(JSON, "parse");
    try {
      const verified = await new StateVscdbChatAdapter(paths).scan(known);
      expect(verified.snapshots).toEqual([]);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
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

    let now = 1_000;
    const adapter = new StateVscdbChatAdapter(paths, { now: () => now });
    const known = await settleKnownChat(adapter);
    try {
      database
        .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
        .run("[]", `bubbleId:${COMPOSER}:b0`);

      now += CHAT_DEEP_VERIFICATION_INTERVAL_MS;
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

    let now = 1_000;
    const adapter = new StateVscdbChatAdapter(paths, { now: () => now });
    const known = await settleKnownChat(adapter);
    try {
      database
        .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
        .run('{"b":2}', `composerData:${COMPOSER}`);

      now += CHAT_DEEP_VERIFICATION_INTERVAL_MS;
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
        sourceChatCoreHash: "f".repeat(64),
      },
    });
    expect(result.snapshots).toHaveLength(1);
  });

  it("republishes same-count divergence when enrichment stored no core shortcut", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, '{"side":"local"}');
    insertKv(database, `bubbleId:${COMPOSER}:b0`, '{"text":"local"}');
    database.close();

    const known = knownChat({
      semanticHash: "repository-enrichment-with-different-core",
      sourceTimestamp: FROZEN_TIMESTAMP,
      sourceBubbleCount: 1,
      // Intentionally absent: helper enrichment may preserve a complete local
      // core only when it differs from the repository core. Remembering that
      // divergent local hash here would exact-fast-skip it forever.
    });
    const result = await new StateVscdbChatAdapter(paths).scan(known);

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.semanticHash).not.toBe(
      known[`chat/${COMPOSER}`]?.semanticHash,
    );
  });

  it("keeps a repository chat when its local header disappears", async () => {
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
      expect(result.deletions).toEqual([]);
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

    let now = 1_000;
    const bodies = vi.fn();
    const opens = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      now: () => now,
      onChatBodyCapture: bodies,
      onDatabaseOpen: opens,
    });
    const acknowledgedKnown = { ...known };
    const emitted = new Set<string>();
    const batchSizes: number[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      if (pass > 0) {
        now += CHAT_DEEP_VERIFICATION_INTERVAL_MS;
      }
      const result = await adapter.scan(acknowledgedKnown);
      batchSizes.push(result.snapshots.length);
      for (const snapshot of result.snapshots) {
        emitted.add(snapshot.resourceId);
        acknowledgedKnown[snapshot.resourceId] = {
          ...acknowledgedKnown[snapshot.resourceId]!,
          semanticHash: snapshot.semanticHash,
        };
      }
      if (pass === 0) {
        bodies.mockClear();
        expect((await adapter.scan(acknowledgedKnown)).snapshots).toEqual([]);
        expect(bodies).not.toHaveBeenCalled();
        opens.mockClear();
        expect((await adapter.scan(acknowledgedKnown)).snapshots).toEqual([]);
        expect(opens).not.toHaveBeenCalled();
      }
    }

    expect(batchSizes).toEqual([4, 4, 4, 4, 1]);
    expect(emitted.size).toBe(17);
  });

  it("bounds bubble COUNT probes across thousands of known chats and eventually finds growth", async () => {
    const { paths, database } = await createGlobalDatabase();
    const known: Record<string, LocalProjection> = {};
    const chatCount = 1_024;
    let targetComposerId = "";
    // Fixture construction is not the behavior under test. Avoid thousands of
    // durable autocommits so the timeout measures the bounded scan itself.
    database.exec("BEGIN");
    for (let index = 0; index < chatCount; index += 1) {
      const composerId = composerIdFor(index + 0x1000);
      insertHeader(database, composerId, FROZEN_TIMESTAMP);
      insertKv(database, `composerData:${composerId}`, "{}");
      insertKv(database, `bubbleId:${composerId}:b0`, "{}");
      const projection = projectionFor(composerId, `known-${index}`);
      projection.sourceChatCoreHash = oneBubbleCoreHash(composerId);
      known[`chat/${composerId}`] = projection;
      targetComposerId = composerId;
    }
    insertKv(database, `bubbleId:${targetComposerId}:b1`, '{"new":true}');
    database.exec("COMMIT");
    database.close();

    const probes = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onBubbleCountProbe: probes,
    });
    const targetResourceId = `chat/${targetComposerId}`;
    let found = false;
    for (let pass = 0; pass < 20; pass += 1) {
      probes.mockClear();
      const result = await adapter.scan(known);
      // 64 rotating fast counts, four deep-verification counts, and at most
      // one second transactional count when this pass finds the changed chat.
      expect(probes.mock.calls.length).toBeLessThanOrEqual(
        MAX_CHAT_BUBBLE_COUNT_PROBES_PER_SCAN + 5,
      );
      expect(result.deletions).toEqual([]);
      for (const item of result.snapshots) {
        Object.assign(known, projectionFromSnapshot(item));
      }
      if (result.snapshots.some((item) => item.resourceId === targetResourceId)) {
        found = true;
        break;
      }
    }

    expect(found).toBe(true);
  }, 15_000);

  it("finishes a multi-poll count audit and returns to the zero-SQLite idle path", async () => {
    const { paths, database } = await createGlobalDatabase();
    const known: Record<string, LocalProjection> = {};
    for (let index = 0; index < 70; index += 1) {
      const composerId = composerIdFor(index + 0x2000);
      insertHeader(database, composerId, FROZEN_TIMESTAMP);
      insertKv(database, `composerData:${composerId}`, "{}");
      insertKv(database, `bubbleId:${composerId}:b0`, "{}");
      const projection = projectionFor(composerId, `known-${index}`);
      projection.sourceChatCoreHash = oneBubbleCoreHash(composerId);
      known[`chat/${composerId}`] = projection;
    }
    database.close();

    const probes = vi.fn();
    const opens = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onBubbleCountProbe: probes,
      onDatabaseOpen: opens,
    });
    for (let pass = 0; pass < 20; pass += 1) {
      const before = probes.mock.calls.length;
      const result = await adapter.scan(known);
      expect(result.snapshots).toEqual([]);
      expect(result.deletions).toEqual([]);
      expect(probes.mock.calls.length - before).toBeLessThanOrEqual(
        MAX_CHAT_BUBBLE_COUNT_PROBES_PER_SCAN + 4,
      );
    }
    expect(opens).toHaveBeenCalled();

    probes.mockClear();
    opens.mockClear();
    const idle = await adapter.scan(known);
    expect(idle.snapshots).toEqual([]);
    expect(idle.deletions).toEqual([]);
    expect(probes).not.toHaveBeenCalled();
    expect(opens).not.toHaveBeenCalled();
  });

  it("backpressures count mismatches until slower body capture drains them", async () => {
    const { paths, database } = await createGlobalDatabase();
    const known: Record<string, LocalProjection> = {};
    const expected = new Set<string>();
    const chatCount = MAX_CHAT_PENDING_BUBBLE_COUNT_MISMATCHES * 3 + 7;
    for (let index = 0; index < chatCount; index += 1) {
      const composerId = composerIdFor(index + 0x22_000);
      const resourceId = `chat/${composerId}`;
      insertHeader(database, composerId, FROZEN_TIMESTAMP);
      insertKv(database, `composerData:${composerId}`, "{}");
      insertKv(database, `bubbleId:${composerId}:b0`, `{"index":${index}}`);
      known[resourceId] = {
        ...projectionFor(composerId, `known-${index}`),
        sourceBubbleCount: 0,
      };
      expected.add(resourceId);
    }
    database.close();

    const retainedCounts: number[] = [];
    const bodyCaptures = vi.fn();
    const opens = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
      onBubbleCountMismatchRetained: (count) => retainedCounts.push(count),
      onChatBodyCapture: bodyCaptures,
      onDatabaseOpen: opens,
    });
    const emitted = new Set<string>();
    let settled = false;
    for (let pass = 0; pass < 40; pass += 1) {
      const bodyCapturesBefore = bodyCaptures.mock.calls.length;
      const result = await adapter.scan(known);
      expect(result.deletions).toEqual([]);
      expect(
        bodyCaptures.mock.calls.length - bodyCapturesBefore,
      ).toBeLessThanOrEqual(MAX_CHAT_BODY_CAPTURES_PER_SCAN);
      for (const snapshot of result.snapshots) {
        emitted.add(snapshot.resourceId);
        Object.assign(known, projectionFromSnapshot(snapshot));
      }
      if (adapter.scanStatus().complete && result.snapshots.length === 0) {
        settled = true;
        break;
      }
    }

    expect(settled).toBe(true);
    expect(emitted).toEqual(expected);
    expect(Math.max(...retainedCounts)).toBe(
      MAX_CHAT_PENDING_BUBBLE_COUNT_MISMATCHES,
    );
    expect(
      retainedCounts.every(
        (count) => count <= MAX_CHAT_PENDING_BUBBLE_COUNT_MISMATCHES,
      ),
    ).toBe(true);

    opens.mockClear();
    expect(await adapter.scan(known)).toMatchObject({
      snapshots: [],
      deletions: [],
    });
    expect(opens).not.toHaveBeenCalled();
  }, 30_000);

  it("bounds many large changed snapshots per scan and publishes them round-robin", async () => {
    const { paths, database } = await createGlobalDatabase();
    const known: Record<string, LocalProjection> = {};
    const expected = new Set<string>();
    const largeBubble = JSON.stringify({ text: "x".repeat(1024 * 1024) });
    for (let index = 0; index < 9; index += 1) {
      const composerId = composerIdFor(index + 0x90);
      const resourceId = `chat/${composerId}`;
      insertHeader(database, composerId, FROZEN_TIMESTAMP);
      insertKv(database, `composerData:${composerId}`, "{}");
      insertKv(database, `bubbleId:${composerId}:b0`, largeBubble);
      known[resourceId] = projectionFor(composerId, `stale-${index}`);
      known[resourceId].sourceTimestamp = FROZEN_TIMESTAMP - 1;
      expected.add(resourceId);
    }
    database.close();

    const now = 1_000;
    const adapter = new StateVscdbChatAdapter(paths, { now: () => now });
    const emitted = new Set<string>();
    const batchSizes: number[] = [];
    for (let pass = 0; pass < 9 && emitted.size < expected.size; pass += 1) {
      const result = await adapter.scan(known);
      expect(result.deletions).toEqual([]);
      const retainedBytes = result.snapshots.reduce(
        (total, item) => total + item.content.byteLength,
        0,
      );
      expect(retainedBytes).toBeLessThanOrEqual(
        MAX_CHAT_SNAPSHOT_BYTES_PER_SCAN,
      );
      batchSizes.push(result.snapshots.length);
      for (const item of result.snapshots) {
        emitted.add(item.resourceId);
        Object.assign(known, projectionFromSnapshot(item));
      }
    }

    expect(batchSizes[0]).toBeGreaterThan(0);
    expect(batchSizes[0]).toBeLessThan(expected.size);
    expect(emitted).toEqual(expected);
  });

  it("settles one exact oversized chat without rereading it until its own state or policy changes", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(
      database,
      `bubbleId:${COMPOSER}:b0`,
      JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) }),
    );
    const opens = vi.fn();
    const bodies = vi.fn();
    const countProbes = vi.fn();
    let now = 1_000;
    const adapter = new StateVscdbChatAdapter(paths, {
      onDatabaseOpen: opens,
      onChatBodyCapture: bodies,
      onBubbleCountProbe: countProbes,
      now: () => now,
    });
    const known = knownChat({
      sourceTimestamp: FROZEN_TIMESTAMP - 1,
      sourceBubbleCount: 1,
    });

    const changed = await adapter.scan(known);
    expect(changed.snapshots).toHaveLength(1);
    const snapshot = changed.snapshots[0]!;
    const limit = snapshot.content.byteLength - 1;
    expect(adapter.settleOversizedSnapshot(snapshot, limit)).toBe(true);
    expect(adapter.oversizedSnapshotSettlements(limit)).toEqual([
      {
        resourceId: snapshot.resourceId,
        semanticHash: snapshot.semanticHash,
        byteLength: snapshot.content.byteLength,
        maxPayloadBytes: limit,
      },
    ]);

    opens.mockClear();
    bodies.mockClear();
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(bodies).not.toHaveBeenCalled();
    expect(opens).toHaveBeenCalledTimes(1);
    opens.mockClear();
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(opens).not.toHaveBeenCalled();

    // A WAL/file generation change elsewhere requires a cheap header/count
    // observation, but the settled multi-megabyte body remains untouched.
    insertKv(database, "unrelated:setting", "changed");
    opens.mockClear();
    bodies.mockClear();
    countProbes.mockClear();
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(opens).toHaveBeenCalledTimes(1);
    expect(countProbes).toHaveBeenCalled();
    expect(bodies).not.toHaveBeenCalled();

    // A real edit to this chat invalidates the old per-chat observation and is
    // materialized once. The still-low policy settles the replacement locally.
    database
      .prepare("UPDATE composerHeaders SET value = ? WHERE composerId = ?")
      .run('{"name":"renamed"}', COMPOSER);
    bodies.mockClear();
    const previousHash = snapshot.semanticHash;
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(bodies).toHaveBeenCalledTimes(1);
    const replacement = adapter.oversizedSnapshotSettlements(limit)[0]!;
    expect(replacement.semanticHash).not.toBe(previousHash);

    // Raising the exact policy requeues only the lightweight identity, then
    // reconstructs and returns the chat so it can finally be published.
    now += 1;
    adapter.setMaxPayloadBytes(replacement.byteLength + 1024);
    bodies.mockClear();
    const raised = await adapter.scan(known);
    expect(bodies).toHaveBeenCalledTimes(1);
    expect(raised.snapshots).toHaveLength(1);
    expect(raised.snapshots[0]?.semanticHash).toBe(replacement.semanticHash);
    database.close();
  });

  it("settles two individually sub-budget oversized chats once without aggregate alternation", async () => {
    const { paths, database } = await createGlobalDatabase();
    const known: Record<string, LocalProjection> = {};
    const resourceIds: string[] = [];
    const largeBubble = JSON.stringify({ text: "x".repeat(5 * 1024 * 1024) });
    for (let index = 0; index < 2; index += 1) {
      const composerId = composerIdFor(index + 0x500);
      const resourceId = `chat/${composerId}`;
      insertHeader(database, composerId, FROZEN_TIMESTAMP - index);
      insertKv(database, `composerData:${composerId}`, "{}");
      insertKv(database, `bubbleId:${composerId}:b0`, largeBubble);
      known[resourceId] = {
        ...projectionFor(composerId, `stale-${index}`),
        sourceTimestamp: FROZEN_TIMESTAMP - index - 1,
      };
      resourceIds.push(resourceId);
    }
    const capturedResourceIds: string[] = [];
    const opens = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onChatBodyCapture: (resourceId) => capturedResourceIds.push(resourceId),
      onDatabaseOpen: opens,
      now: () => 1_000,
    });
    const limit = 1024 * 1024;
    adapter.setMaxPayloadBytes(limit);

    const result = await adapter.scan(known);
    expect(result.snapshots).toEqual([]);
    expect(capturedResourceIds.sort()).toEqual([...resourceIds].sort());
    expect(adapter.oversizedSnapshotSettlements(limit)).toHaveLength(2);
    expect(adapter.scanStatus()).toEqual({
      complete: true,
      deferredResourceIds: [],
    });

    capturedResourceIds.length = 0;
    opens.mockClear();
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(capturedResourceIds).toEqual([]);
    expect(opens).not.toHaveBeenCalled();
    expect(adapter.oversizedSnapshotSettlements(limit)).toHaveLength(2);
    database.close();
  }, 15_000);

  it("lists many huge headers as compact metadata and settles them without tombstones", async () => {
    const { paths, database } = await createGlobalDatabase();
    const known: Record<string, LocalProjection> = {};
    const resourceIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const composerId = composerIdFor(index + 0x700);
      const resourceId = `chat/${composerId}`;
      insertHeader(database, composerId, FROZEN_TIMESTAMP - index);
      database
        .prepare(
          "UPDATE composerHeaders SET " +
            "workspaceId = replace(hex(zeroblob(131072)), '00', 'w'), " +
            "value = replace(hex(zeroblob(131072)), '00', 'v') " +
            "WHERE composerId = ?",
        )
        .run(composerId);
      known[resourceId] = projectionFor(composerId, `older-${index}`);
      resourceIds.push(resourceId);
    }
    const headerMaterializations = vi.fn();
    const bodyMaterializations = vi.fn();
    const opens = vi.fn();
    const limit = 64 * 1024;
    const adapter = new StateVscdbChatAdapter(paths, {
      onHeaderValueMaterialize: headerMaterializations,
      onChatBodyCapture: bodyMaterializations,
      onDatabaseOpen: opens,
      periodicDeepVerification: false,
    });
    adapter.setMaxPayloadBytes(limit);

    const first = await adapter.scan(known);

    expect(first.snapshots).toEqual([]);
    expect(first.deletions).toEqual([]);
    expect(headerMaterializations).not.toHaveBeenCalled();
    expect(bodyMaterializations).not.toHaveBeenCalled();
    expect(
      adapter
        .oversizedSnapshotSettlements(limit)
        .map((settlement) => settlement.resourceId)
        .sort(),
    ).toEqual([...resourceIds].sort());
    expect(
      adapter
        .oversizedSnapshotSettlements(limit)
        .every((settlement) => settlement.byteLength > limit),
    ).toBe(true);
    expect(adapter.scanStatus()).toEqual({
      complete: true,
      deferredResourceIds: [],
    });

    opens.mockClear();
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(opens).not.toHaveBeenCalled();
    expect(headerMaterializations).not.toHaveBeenCalled();
    database.close();
  }, 15_000);

  it("caps oversized settlements and clears overflow only after a stable fitting rebuild", async () => {
    const { paths, database } = await createGlobalDatabase();
    const known: Record<string, LocalProjection> = {};
    const resourceIds: string[] = [];
    const composerIds: string[] = [];
    const chatCount = MAX_CHAT_OVERSIZED_SETTLEMENTS + 6;
    for (let index = 0; index < chatCount; index += 1) {
      const composerId = composerIdFor(index + 0x23_000);
      const resourceId = `chat/${composerId}`;
      insertHeader(database, composerId, FROZEN_TIMESTAMP - index);
      database
        .prepare(
          "UPDATE composerHeaders SET value = " +
            "replace(hex(zeroblob(2048)), '00', 'h') WHERE composerId = ?",
        )
        .run(composerId);
      known[resourceId] = projectionFor(composerId, `known-${index}`);
      resourceIds.push(resourceId);
      composerIds.push(composerId);
    }

    const retainedCounts: number[] = [];
    const opens = vi.fn();
    const limit = 1024;
    const adapter = new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
      onDatabaseOpen: opens,
      onOversizedSettlementRetained: (count) => retainedCounts.push(count),
    });
    adapter.setMaxPayloadBytes(limit);

    for (let pass = 0; pass < 4; pass += 1) {
      const result = await adapter.scan(known);
      expect(result.snapshots).toEqual([]);
      expect(result.deletions).toEqual([]);
      if (
        adapter
          .oversizedSnapshotSettlements(limit)
          .some(
            (settlement) =>
              settlement.resourceId ===
              CHAT_OVERSIZED_SETTLEMENT_OVERFLOW_RESOURCE_ID,
          )
      ) {
        break;
      }
    }

    expect(Math.max(...retainedCounts)).toBe(MAX_CHAT_OVERSIZED_SETTLEMENTS);
    expect(
      retainedCounts.every(
        (count) => count <= MAX_CHAT_OVERSIZED_SETTLEMENTS,
      ),
    ).toBe(true);
    const overflowSettlements = adapter.oversizedSnapshotSettlements(limit);
    expect(overflowSettlements).toHaveLength(
      MAX_CHAT_OVERSIZED_WARNING_SAMPLES + 1,
    );
    const overflow = overflowSettlements.find(
      (settlement) =>
        settlement.resourceId ===
        CHAT_OVERSIZED_SETTLEMENT_OVERFLOW_RESOURCE_ID,
    );
    expect(overflow?.warning).toContain(`At least ${chatCount}`);
    expect(overflow?.warning).toContain("remains incomplete");
    expect(adapter.scanStatus().complete).toBe(false);
    opens.mockClear();
    expect(await adapter.scan(known)).toMatchObject({
      snapshots: [],
      deletions: [],
    });
    expect(opens).not.toHaveBeenCalled();
    expect(adapter.scanStatus().complete).toBe(false);

    // Removing ten local headers publishes no tombstones. A stable full
    // generation first discards four stale retained proofs, then proves all 60
    // remaining oversized chats fit and clears the overflow sentinel.
    const deleteHeader = database.prepare(
      "DELETE FROM composerHeaders WHERE composerId = ?",
    );
    for (const composerId of composerIds.slice(-10)) {
      deleteHeader.run(composerId);
    }
    let settled = false;
    for (let pass = 0; pass < 8; pass += 1) {
      const result = await adapter.scan(known);
      expect(result.snapshots).toEqual([]);
      expect(result.deletions).toEqual([]);
      if (adapter.scanStatus().complete) {
        settled = true;
        break;
      }
    }

    expect(settled).toBe(true);
    expect(adapter.oversizedSnapshotSettlements(limit)).toHaveLength(
      chatCount - 10,
    );
    expect(
      adapter
        .oversizedSnapshotSettlements(limit)
        .some(
          (settlement) =>
            settlement.resourceId ===
            CHAT_OVERSIZED_SETTLEMENT_OVERFLOW_RESOURCE_ID,
        ),
    ).toBe(false);
    expect(resourceIds).toHaveLength(chatCount);

    opens.mockClear();
    expect(await adapter.scan(known)).toMatchObject({
      snapshots: [],
      deletions: [],
    });
    expect(opens).not.toHaveBeenCalled();
    database.close();
  }, 30_000);

  it("keyset-pages many headers without false tombstones and settles to zero opens", async () => {
    const { paths, database } = await createGlobalDatabase();
    const chatCount = MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE * 2 + 7;
    const known: Record<string, LocalProjection> = {};
    const expected = new Set<string>();
    for (let index = 0; index < chatCount; index += 1) {
      const composerId = composerIdFor(index + 0x9000);
      const resourceId = `chat/${composerId}`;
      insertHeader(database, composerId, FROZEN_TIMESTAMP + 10_000 - index);
      insertKv(database, `composerData:${composerId}`, "{}");
      insertKv(database, `bubbleId:${composerId}:b0`, `{"index":${index}}`);
      known[resourceId] = {
        ...projectionFor(composerId, `stale-${index}`),
        sourceTimestamp: FROZEN_TIMESTAMP - 1,
      };
      expected.add(resourceId);
    }
    // Non-chat draft rows share the table in real Cursor databases. They must
    // consume the same bounded metadata pages without becoming resources.
    for (let index = 0; index < 9; index += 1) {
      insertHeader(
        database,
        `draft-${index.toString().padStart(2, "0")}`,
        FROZEN_TIMESTAMP + 20_000 - index,
      );
    }
    const ghostId = composerIdFor(0xf000);
    const ghostResourceId = `chat/${ghostId}`;
    known[ghostResourceId] = projectionFor(ghostId, "deleted-locally");
    database.close();

    const opens = vi.fn();
    let phaseRows: Record<
      "header" | "bubble-count" | "deep-verification",
      number
    > = { header: 0, "bubble-count": 0, "deep-verification": 0 };
    const adapter = new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
      onDatabaseOpen: opens,
      onHeaderMetadataRow: (phase) => {
        phaseRows[phase] += 1;
      },
    });
    const emissions = new Map<string, number>();
    let settled = false;
    for (let pass = 0; pass < 40; pass += 1) {
      phaseRows = {
        header: 0,
        "bubble-count": 0,
        "deep-verification": 0,
      };
      const result = await adapter.scan(known);
      for (const count of Object.values(phaseRows)) {
        expect(count).toBeLessThanOrEqual(
          MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE,
        );
      }
      for (const snapshot of result.snapshots) {
        emissions.set(
          snapshot.resourceId,
          (emissions.get(snapshot.resourceId) ?? 0) + 1,
        );
        Object.assign(known, projectionFromSnapshot(snapshot));
      }
      // Chat rows are additive-only. A multi-page live SQLite traversal has no
      // stable deletion generation, so even a genuinely absent local header
      // cannot erase the recoverable repository copy.
      expect(result.deletions).toEqual([]);
      if (
        adapter.scanStatus().complete &&
        result.snapshots.length === 0 &&
        result.deletions.length === 0
      ) {
        settled = true;
        break;
      }
    }

    expect(settled).toBe(true);
    expect(new Set(emissions.keys())).toEqual(expected);
    expect([...emissions.values()].every((count) => count === 1)).toBe(true);

    opens.mockClear();
    phaseRows = { header: 0, "bubble-count": 0, "deep-verification": 0 };
    const idle = await adapter.scan(known);
    expect(idle.snapshots).toEqual([]);
    expect(idle.deletions).toEqual([]);
    expect(opens).not.toHaveBeenCalled();
    expect(Object.values(phaseRows)).toEqual([0, 0, 0]);
  }, 30_000);

  it("uses the rowid index for forward audit and recent-priority pages", async () => {
    const { database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);

    const forward = database
      .prepare(`EXPLAIN QUERY PLAN ${COMPOSER_HEADER_METADATA_AFTER_CURSOR_SQL}`)
      .all(0, MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE) as Array<{
      detail?: unknown;
    }>;
    const recent = database
      .prepare(`EXPLAIN QUERY PLAN ${COMPOSER_HEADER_RECENT_PAGE_SQL}`)
      .all(9_223_372_036_854_775_807n, MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE) as Array<{
      detail?: unknown;
    }>;
    const forwardDetails = forward.map((row) => String(row.detail));
    const recentDetails = recent.map((row) => String(row.detail));

    expect(forwardDetails.join(" ")).toMatch(
      /SEARCH composerHeaders USING INTEGER PRIMARY KEY \(rowid>\?\)/,
    );
    expect(recentDetails.join(" ")).toMatch(
      /SEARCH composerHeaders USING INTEGER PRIMARY KEY \(rowid<\?\)/,
    );
    expect([...forwardDetails, ...recentDetails].join(" ")).not.toContain(
      "USE TEMP B-TREE",
    );
    database.close();
  });

  it("looks up known chat projections per page without enumerating the whole repository", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();
    const resourceId = `chat/${COMPOSER}`;
    const known = new Proxy<Record<string, LocalProjection>>(
      {
        [resourceId]: projectionFor(COMPOSER, "known"),
      },
      {
        ownKeys: () => {
          throw new Error("chat scan enumerated the whole known projection set");
        },
      },
    );
    const adapter = new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
    });

    await expect(adapter.scan(known)).resolves.toMatchObject({
      deletions: [],
    });
  });

  it("stays zero-open after an unchanged repository state refresh", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, "{}");
    database.close();
    const repository = await SyncRepository.create(
      join(paths.appRoot, "repository"),
      join(paths.appRoot, "extension-storage"),
      "a sufficiently long state refresh passphrase",
      1024 * 1024,
      {
        extensionVersion: "0.0.63",
        cursorVersion: "3.11.19",
        vscodeVersion: "1.125.0",
      },
    );
    const opens = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
      onDatabaseOpen: opens,
    });
    const baseline = await adapter.scan({});
    Object.assign(
      repository.state.projections,
      projectionFromSnapshot(baseline.snapshots[0]!),
    );
    await repository.saveState();
    await adapter.scan(repository.state.projections);
    await adapter.scan(repository.state.projections);
    opens.mockClear();

    await repository.refreshState();
    expect((await adapter.scan(repository.state.projections)).snapshots).toEqual(
      [],
    );
    expect(opens).not.toHaveBeenCalled();
  });

  it("finishes a 100k-row indexed identity sweep and returns to zero opens", async () => {
    const { paths, database } = await createGlobalDatabase();
    const syntheticRows = 100_000;
    database.exec(`
      WITH RECURSIVE digit(value) AS (
        SELECT 0
        UNION ALL
        SELECT value + 1 FROM digit WHERE value < 9
      ), seq(value) AS (
        SELECT ones.value + 10 * tens.value + 100 * hundreds.value +
          1000 * thousands.value + 10000 * tenThousands.value
        FROM digit AS ones, digit AS tens, digit AS hundreds,
          digit AS thousands, digit AS tenThousands
      )
      INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      )
      SELECT printf('draft-%06d', value), 'workspace-a', 1,
        ${FROZEN_TIMESTAMP}, 0, 1, 0, 0, '{}'
      FROM seq WHERE value < ${syntheticRows}
    `);
    const tailId = composerIdFor(0x1_0000);
    const tailResourceId = `chat/${tailId}`;
    insertHeader(database, tailId, FROZEN_TIMESTAMP);
    database.close();

    const known: Record<string, LocalProjection> = {
      [tailResourceId]: {
        resourceId: tailResourceId,
        kind: "chat",
        semanticHash: "known-tail",
        versionId: null,
        sourceTimestamp: FROZEN_TIMESTAMP,
        sourceBubbleCount: 0,
      },
    };
    const opens = vi.fn();
    const materialized: string[] = [];
    let phaseRows: Record<
      "header" | "bubble-count" | "deep-verification",
      number
    > = { header: 0, "bubble-count": 0, "deep-verification": 0 };
    const adapter = new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
      onDatabaseOpen: opens,
      onHeaderValueMaterialize: (resourceId) => materialized.push(resourceId),
      onHeaderMetadataRow: (phase) => {
        phaseRows[phase] += 1;
      },
    });
    const maxPasses =
      Math.ceil((syntheticRows + 1) / MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE) +
      3;
    let completed = false;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      phaseRows = {
        header: 0,
        "bubble-count": 0,
        "deep-verification": 0,
      };
      const result = await adapter.scan(known);
      expect(result.snapshots).toEqual([]);
      expect(result.deletions).toEqual([]);
      for (const count of Object.values(phaseRows)) {
        expect(count).toBeLessThanOrEqual(
          MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE,
        );
      }
      if (adapter.scanStatus().complete) {
        completed = true;
        break;
      }
    }

    expect(completed).toBe(true);
    expect(materialized).toEqual([tailResourceId]);
    expect(opens).toHaveBeenCalled();
    opens.mockClear();
    phaseRows = { header: 0, "bubble-count": 0, "deep-verification": 0 };
    expect(await adapter.scan(known)).toMatchObject({
      snapshots: [],
      deletions: [],
    });
    expect(opens).not.toHaveBeenCalled();
    expect(Object.values(phaseRows)).toEqual([0, 0, 0]);
  }, 120_000);

  it("resumes many under-policy large header fetches with a finite aggregate cursor", async () => {
    const { paths, database } = await createGlobalDatabase();
    const known: Record<string, LocalProjection> = {};
    const resourceIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const composerId = composerIdFor(index + 0x780);
      const resourceId = `chat/${composerId}`;
      const timestamp = FROZEN_TIMESTAMP - index;
      insertHeader(database, composerId, timestamp);
      database
        .prepare(
          "UPDATE composerHeaders SET value = " +
            "replace(hex(zeroblob(5242880)), '00', 'h') " +
            "WHERE composerId = ?",
        )
        .run(composerId);
      known[resourceId] = {
        resourceId,
        kind: "chat",
        semanticHash: `known-${index}`,
        versionId: null,
        sourceTimestamp: timestamp,
        sourceBubbleCount: 0,
      };
      resourceIds.push(resourceId);
    }
    const materialized: string[] = [];
    const opens = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onHeaderValueMaterialize: (resourceId) =>
        materialized.push(resourceId),
      onDatabaseOpen: opens,
      periodicDeepVerification: false,
    });
    adapter.setMaxPayloadBytes(16 * 1024 * 1024);

    for (let pass = 0; pass < 8; pass += 1) {
      const before = materialized.length;
      const result = await adapter.scan(known);
      expect(result.snapshots).toEqual([]);
      expect(result.deletions).toEqual([]);
      expect(materialized.length - before).toBeLessThanOrEqual(1);
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(adapter.scanStatus()).toEqual({
      complete: true,
      deferredResourceIds: [],
    });
    expect([...new Set(materialized)].sort()).toEqual([...resourceIds].sort());
    expect(materialized).toHaveLength(resourceIds.length);
    opens.mockClear();
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(opens).not.toHaveBeenCalled();
    database.close();
  }, 30_000);

  it("fails closed on an invalid huge header field without deleting its chat", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    database
      .prepare(
        "UPDATE composerHeaders SET workspaceId = zeroblob(8388608) WHERE composerId = ?",
      )
      .run(COMPOSER);
    const headerMaterializations = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onHeaderValueMaterialize: headerMaterializations,
      periodicDeepVerification: false,
    });
    adapter.setMaxPayloadBytes(1024 * 1024);

    const result = await adapter.scan(
      knownChat({
        sourceTimestamp: FROZEN_TIMESTAMP,
        sourceBubbleCount: 0,
      }),
    );

    expect(result.snapshots).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(result.warnings.join(" ")).toContain("workspaceId");
    expect(result.warnings.join(" ")).toContain("storage class");
    expect(headerMaterializations).not.toHaveBeenCalled();
    database.close();
  });

  it("preflights an oversized bubble without allocating a full portable snapshot", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    database
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(12582912))",
      )
      .run(`bubbleId:${COMPOSER}:b0`);
    const materializations = vi.fn();
    const bodies = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onChatBodyCapture: bodies,
      onChatSnapshotMaterialize: materializations,
      periodicDeepVerification: false,
    });
    const limit = 1024 * 1024;
    adapter.setMaxPayloadBytes(limit);

    const result = await adapter.scan({});

    expect(result.snapshots).toEqual([]);
    expect(bodies).toHaveBeenCalledTimes(1);
    expect(materializations).not.toHaveBeenCalled();
    const settlements = adapter.oversizedSnapshotSettlements(limit);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.resourceId).toBe(`chat/${COMPOSER}`);
    expect(settlements[0]?.maxPayloadBytes).toBe(limit);
    expect(settlements[0]?.byteLength).toBeGreaterThan(limit);
    expect(adapter.scanStatus().complete).toBe(true);
    database.close();
  }, 15_000);

  it("keeps one chat below the fixed live-capture budget even when repository policy is larger", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    database
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(37748736))",
      )
      .run(`bubbleId:${COMPOSER}:b0`);
    const materializations = vi.fn();
    const valueChunkReads = vi.fn();
    const countProbes = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onBubbleCountProbe: countProbes,
      onChatCoreValueChunkRead: valueChunkReads,
      onChatSnapshotMaterialize: materializations,
      periodicDeepVerification: false,
    });
    const repositoryLimit = 128 * 1024 * 1024;
    adapter.setMaxPayloadBytes(repositoryLimit);

    const result = await adapter.scan({});

    expect(result.snapshots).toEqual([]);
    expect(materializations).not.toHaveBeenCalled();
    expect(valueChunkReads).not.toHaveBeenCalled();
    const settlements = adapter.oversizedSnapshotSettlements(repositoryLimit);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.resourceId).toBe(`chat/${COMPOSER}`);
    expect(settlements[0]?.maxPayloadBytes).toBe(
      MAX_CHAT_INTERACTIVE_CAPTURE_BYTES,
    );
    expect(settlements[0]?.byteLength).toBeGreaterThan(
      MAX_CHAT_INTERACTIVE_CAPTURE_BYTES,
    );
    expect(settlements[0]?.warning).toContain(
      "fixed 32 MiB live chat-capture safety budget",
    );
    expect(adapter.scanStatus()).toEqual({
      complete: true,
      deferredResourceIds: [],
    });
    countProbes.mockClear();
    insertKv(database, "unrelated:wal-generation", "changed");
    expect((await adapter.scan({})).snapshots).toEqual([]);
    // A generation audit may re-check this chat, but the production statement
    // itself stops at MAX_CHAT_CORE_METADATA_ROWS + 1 rather than COUNTing an
    // adversarial table to completion.
    expect(countProbes.mock.calls.length).toBeLessThanOrEqual(1);
    expect(valueChunkReads).not.toHaveBeenCalled();
    expect(
      adapter.oversizedSnapshotSettlements(repositoryLimit)[0]?.warning,
    ).toContain("fixed 32 MiB live chat-capture safety budget");
    database.close();
  }, 20_000);

  it("yields while streaming an oversized core split across many smaller rows", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    const insertBubble = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(1048576))",
    );
    for (let index = 0; index < 24; index += 1) {
      insertBubble.run(`bubbleId:${COMPOSER}:b${index}`);
    }
    const yields = vi.fn();
    const materializations = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onChatCoreHashYield: yields,
      onChatSnapshotMaterialize: materializations,
      periodicDeepVerification: false,
    });
    adapter.setMaxPayloadBytes(1024 * 1024);

    expect((await adapter.scan({})).snapshots).toEqual([]);
    expect(materializations).not.toHaveBeenCalled();
    expect(yields).toHaveBeenCalled();
    expect(yields.mock.calls.length).toBeGreaterThanOrEqual(4);
    database.close();
  }, 30_000);

  it("bounds metadata work for a corrupt chat with very many tiny rows", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    const insertBubble = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, NULL)",
    );
    database.exec("BEGIN");
    try {
      for (let index = 0; index <= MAX_CHAT_CORE_METADATA_ROWS; index += 1) {
        insertBubble.run(
          `bubbleId:${COMPOSER}:${index.toString().padStart(6, "0")}`,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const metadataRows = vi.fn();
    const valueChunkReads = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onChatCoreMetadataRow: metadataRows,
      onChatCoreValueChunkRead: valueChunkReads,
      periodicDeepVerification: false,
    });
    adapter.setMaxPayloadBytes(128 * 1024 * 1024);

    expect((await adapter.scan({})).snapshots).toEqual([]);
    expect(metadataRows).not.toHaveBeenCalled();
    expect(valueChunkReads).not.toHaveBeenCalled();
    const [settlement] = adapter.oversizedSnapshotSettlements(
      128 * 1024 * 1024,
    );
    expect(settlement?.warning).toContain(
      "fixed live chat-capture work budget",
    );
    database.close();
  }, 30_000);

  it("streams the exact canonical core hash and byte length across mixed row boundaries", async () => {
    const { paths, database } = await createGlobalDatabase();
    const escapedHeader = `${"a".repeat(16 * 1024 - 1)}😀${
      '"\\\n\u0001'.repeat(32 * 1024)
    }`;
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP, escapedHeader);
    insertKv(
      database,
      `composerData:${COMPOSER}`,
      `prefix-${"한".repeat(70 * 1024)}`,
    );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `bubbleId:${COMPOSER}:b0`,
        Buffer.alloc(192 * 1024 + 2, 0xab),
      );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, NULL)")
      .run(`bubbleId:${COMPOSER}:b1`);
    insertKv(database, `bubbleId:${COMPOSER}:b2`, 'quote-"-\\-끝');

    const full = await new StateVscdbChatAdapter(paths, {
      periodicDeepVerification: false,
    }).scan({});
    const portable = parsePortableChatSnapshot(full.snapshots[0]!.content);
    const canonicalCore = canonicalBytes({
      schemaVersion: 1,
      composerId: portable.composerId,
      header: portable.header,
      composerData: portable.composerData,
      bubbles: portable.bubbles,
    });
    const expectedHash = portableChatCoreHash(portable);
    const headerMaterializations = vi.fn();
    const snapshotMaterializations = vi.fn();
    const rawHeaderBytes = Buffer.byteLength(escapedHeader);
    const lowLimit = Math.floor(
      (rawHeaderBytes + canonicalCore.byteLength) / 2,
    );
    const streamed = new StateVscdbChatAdapter(paths, {
      onHeaderValueMaterialize: headerMaterializations,
      onChatSnapshotMaterialize: snapshotMaterializations,
      periodicDeepVerification: false,
    });
    streamed.setMaxPayloadBytes(lowLimit);

    expect((await streamed.scan({})).snapshots).toEqual([]);
    // One bounded header fetch is expected; the full portable core is not.
    expect(headerMaterializations).toHaveBeenCalledTimes(1);
    expect(snapshotMaterializations).not.toHaveBeenCalled();
    expect(streamed.oversizedSnapshotSettlements(lowLimit)).toEqual([
      {
        resourceId: `chat/${COMPOSER}`,
        semanticHash: expectedHash,
        byteLength: canonicalCore.byteLength,
        maxPayloadBytes: lowLimit,
      },
    ]);
    insertKv(database, "unrelated:after-large-header", "changed");
    expect((await streamed.scan({})).snapshots).toEqual([]);
    expect(headerMaterializations).toHaveBeenCalledTimes(1);
    expect(snapshotMaterializations).not.toHaveBeenCalled();
    database.close();
  });

  it("iterates metadata for many small bubbles without retaining the row set", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    database.exec(`
      WITH RECURSIVE digit(value) AS (
        SELECT 0
        UNION ALL
        SELECT value + 1 FROM digit WHERE value < 9
      ), seq(value) AS (
        SELECT ones.value + 10 * tens.value + 100 * hundreds.value +
          1000 * thousands.value
        FROM digit AS ones, digit AS tens, digit AS hundreds,
          digit AS thousands
      )
      INSERT INTO cursorDiskKV(key, value)
      SELECT printf('bubbleId:${COMPOSER}:b%05d', value), 'tiny'
      FROM seq WHERE value < 2048
    `);
    const materializations = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onChatSnapshotMaterialize: materializations,
      periodicDeepVerification: false,
    });
    const limit = 64 * 1024;
    adapter.setMaxPayloadBytes(limit);

    expect((await adapter.scan({})).snapshots).toEqual([]);
    expect(materializations).not.toHaveBeenCalled();
    expect(adapter.oversizedSnapshotSettlements(limit)[0]?.byteLength).toBeGreaterThan(
      limit,
    );
    database.close();
  }, 15_000);

  it("rate-limits equal-count core verification across unrelated DB churn", async () => {
    const { paths, database } = await createGlobalDatabase();
    insertHeader(database, COMPOSER, FROZEN_TIMESTAMP);
    insertKv(database, `composerData:${COMPOSER}`, "{}");
    insertKv(database, `bubbleId:${COMPOSER}:b0`, '{"text":"old"}');
    let now = 5_000;
    const bodies = vi.fn();
    const countProbes = vi.fn();
    const adapter = new StateVscdbChatAdapter(paths, {
      onChatBodyCapture: bodies,
      onBubbleCountProbe: countProbes,
      now: () => now,
    });
    const baseline = await adapter.scan({});
    const known = projectionFromSnapshot(baseline.snapshots[0]!);
    known[`chat/${COMPOSER}`]!.sourceChatCoreHash = baseline.snapshots[0]!
      .metadata!.chatCoreHash as string;
    expect((await adapter.scan(known)).snapshots).toEqual([]);

    insertKv(database, "unrelated:one", "1");
    bodies.mockClear();
    countProbes.mockClear();
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(countProbes).toHaveBeenCalled();
    expect(bodies).not.toHaveBeenCalled();

    // Cursor can rewrite a bubble without advancing either timestamp or count.
    // Before the cadence expires this still remains a cheap COUNT-only pass.
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"same-count-new"}', `bubbleId:${COMPOSER}:b0`);
    bodies.mockClear();
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(bodies).not.toHaveBeenCalled();

    now += CHAT_DEEP_VERIFICATION_INTERVAL_MS;
    const audited = await adapter.scan(known);
    expect(bodies).toHaveBeenCalledTimes(1);
    expect(audited.snapshots).toHaveLength(1);
    database.close();
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

    let now = 1_000;
    const adapter = new StateVscdbChatAdapter(paths, { now: () => now });
    const baseline = await adapter.scan({});
    expect(baseline.snapshots).toHaveLength(17);
    const known: Record<string, LocalProjection> = {};
    for (const snapshot of baseline.snapshots) {
      Object.assign(known, projectionFromSnapshot(snapshot));
    }
    // Acknowledge the baseline; the remaining equal-count audit batches are
    // intentionally scheduled rather than run on every 30-second poll.
    expect((await adapter.scan(known)).snapshots).toEqual([]);

    const changedComposerId = composerIdFor(0x30);
    const changedResourceId = `chat/${changedComposerId}`;
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"new"}', `bubbleId:${changedComposerId}:b0`);

    // The first four IDs were audited with the baseline. Three later slots are
    // deliberately quiet before the fourth reaches ID seventeen and emits it.
    for (let pass = 0; pass < 3; pass += 1) {
      now += CHAT_DEEP_VERIFICATION_INTERVAL_MS;
      expect((await adapter.scan(known)).snapshots).toEqual([]);
    }
    now += CHAT_DEEP_VERIFICATION_INTERVAL_MS;
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

    let now = 1_000;
    const adapter = new StateVscdbChatAdapter(paths, { now: () => now });
    const known = await settleKnownChat(adapter);
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"new"}', `bubbleId:${COMPOSER}:b0`);
    now += CHAT_DEEP_VERIFICATION_INTERVAL_MS;
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

    let now = 1_000;
    const adapter = new StateVscdbChatAdapter(paths, { now: () => now });
    const known = await settleKnownChat(adapter);
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"new"}', `bubbleId:${COMPOSER}:b0`);
    now += CHAT_DEEP_VERIFICATION_INTERVAL_MS;
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
      ...(typeof snapshot.metadata?.chatCoreHash === "string"
        ? { sourceChatCoreHash: snapshot.metadata.chatCoreHash }
        : {}),
      ...(typeof snapshot.metadata?.headerFingerprint === "string"
        ? { sourceHeaderFingerprint: snapshot.metadata.headerFingerprint }
        : {}),
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

function oneBubbleCoreHash(composerId: string): string {
  const textRow = (key: string) => ({
    key,
    valueBase64: Buffer.from("{}", "utf8").toString("base64"),
    valueType: "text" as const,
  });
  return portableChatCoreHash({
    schemaVersion: 1,
    composerId,
    header: {
      composerId,
      workspaceId: "workspace-a",
      createdAt: 1,
      lastUpdatedAt: FROZEN_TIMESTAMP,
      isArchived: 0,
      isSubagent: 0,
      recency: 0,
      checkpointAt: 0,
      value: "{}",
    },
    composerData: textRow(`composerData:${composerId}`),
    bubbles: [textRow(`bubbleId:${composerId}:b0`)],
  });
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
  lastUpdatedAt: number | null,
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

function state(bytes: Uint8Array): string {
  return `~${Buffer.from(bytes).toString("base64")}`;
}

function bytesField(fieldNumber: number, payload: Uint8Array): Buffer {
  return Buffer.concat([
    varint(BigInt(fieldNumber * 8 + 2)),
    varint(BigInt(payload.byteLength)),
    Buffer.from(payload),
  ]);
}

function varint(input: bigint): Buffer {
  let value = input;
  const bytes: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value !== 0n);
  return Buffer.from(bytes);
}
