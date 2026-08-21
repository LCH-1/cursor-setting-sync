import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import {
  enrichCurrentChatTipsFromLiveDatabase,
  type ChatTipEnrichmentCursor,
} from "../src/chat/enrichment";
import {
  auditChatContinuationRoots,
  readPortableChatSnapshot,
  type ChatContinuationRootAudit,
  type ChatContinuationRootProbe,
} from "../src/chat/repair";
import {
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  StateVscdbChatAdapter,
  type PortableChatSnapshot,
  type PortableChatSnapshotV1,
  type PortableChatSnapshotV2,
  type PortableKvRow,
} from "../src/chat/stateVscdb";
import {
  applyGlobalDatabaseChanges,
  type PreparedHelperChange,
} from "../src/helper/database";
import { markAppliedProjections, prepareChanges } from "../src/helper/main";
import type { HelperRequest } from "../src/helper/types";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import {
  EventReconciler,
  type ReconcileResult,
} from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import {
  autoMergeConflicts,
  pendingHelperBatch,
  queuePending,
} from "../src/sync/manager";
import type {
  EventProducer,
  JsonValue,
  ResourceSnapshot,
  ResourceTip,
} from "../src/types";

const { DatabaseSync } = sqlite;
const PASSPHRASE = "a sufficiently long continuation recovery passphrase";
const COMPOSER_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const TITLE = "Calendar selection logic";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.63",
  cursorVersion: "3.15.6",
  vscodeVersion: "1.125.0",
};
const temporaryRoots: string[] = [];
const describeWithBackup =
  typeof sqlite.backup === "function" ? describe : describe.skip;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describeWithBackup("cross-device chat continuation recovery", () => {
  it("enriches a newer A core from both devices and repairs A additively", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-recovery-e2e-"));
    temporaryRoots.push(root);
    const repository = await SyncRepository.create(
      join(root, "repository"),
      join(root, "repository-state"),
      PASSPHRASE,
      4 * 1024 * 1024,
      PRODUCER,
    );
    const aDatabasePath = join(root, "device-a-state.vscdb");
    const bDatabasePath = join(root, "device-b-state.vscdb");
    createGlobalDatabase(aDatabasePath);
    createGlobalDatabase(bDatabasePath);

    const aLeaf = contentBlob(conversationStepBytes("A-only continuation leaf"));
    const aRoot = contentBlob(conversationTurnBytes([aLeaf.id]));
    const bLeaf = contentBlob(
      conversationStepBytes("B healthy continuation leaf"),
    );
    const bRoot = contentBlob(conversationTurnBytes([bLeaf.id]));
    const aCore = chatSnapshot({
      bubbleCount: 5,
      composerRootId: bRoot.id,
      errorBubbleRootId: aRoot.id,
      label: "A-newer",
    });
    const bCore = chatSnapshot({
      bubbleCount: 3,
      composerRootId: bRoot.id,
      label: "B-shorter",
    });
    seedChat(aDatabasePath, aCore, [aRoot, aLeaf]);
    seedChat(bDatabasePath, bCore, [bRoot, bLeaf]);

    const initialA = await auditDatabaseChat(aDatabasePath);
    expectKnownAudit(initialA.audit);
    expect(initialA.audit.unavailableRootIds).toEqual([bRoot.id]);
    const initialB = await auditDatabaseChat(bDatabasePath);
    expectKnownAudit(initialB.audit);
    expect(initialB.audit).toMatchObject({
      unavailableRootIds: [],
      probedRootCount: 2,
    });

    const legacyTip = await publishChat(repository, aCore);
    expect(legacyTip.metadata?.chatSnapshotSchemaVersion).toBeUndefined();

    const bResult = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      bDatabasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: new Map(),
      },
    );
    expect(bResult).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);

    const partialTip = onlyTip(repository);
    const partial = await readTipChat(repository, partialTip);
    expect(isPortableChatSnapshotV2(partial)).toBe(true);
    if (!isPortableChatSnapshotV2(partial)) {
      throw new Error("B enrichment did not produce chat schema v2");
    }
    expect(core(partial)).toEqual(core(aCore));
    expect(partial.agentKv).toMatchObject({
      referencedIds: [aRoot.id, bLeaf.id, bRoot.id].sort(),
      missingIds: [aRoot.id],
    });
    expect(partial.agentKv.blobs.map(blobId)).toEqual(
      [bLeaf.id, bRoot.id].sort(),
    );
    expect(partialTip.metadata).toMatchObject({
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 2,
      agentKvReferencedCount: 3,
      agentKvMissingCount: 1,
      chatCoreHash: portableChatCoreHash(aCore),
      syncOrigin: "agent-kv-enrichment",
    });
    expect(portableChatCoreHash(readDatabaseChat(bDatabasePath))).toBe(
      portableChatCoreHash(bCore),
    );

    const aResult = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      aDatabasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: new Map(),
      },
    );
    expect(aResult).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);

    const finalTip = onlyTip(repository);
    const finalSnapshot = await readTipChat(repository, finalTip);
    expect(isPortableChatSnapshotV2(finalSnapshot)).toBe(true);
    if (!isPortableChatSnapshotV2(finalSnapshot)) {
      throw new Error("A enrichment did not retain chat schema v2");
    }
    expect(core(finalSnapshot)).toEqual(core(aCore));
    expect(finalSnapshot.agentKv).toMatchObject({
      referencedIds: [aLeaf.id, aRoot.id, bLeaf.id, bRoot.id].sort(),
      missingIds: [],
    });
    expect(finalSnapshot.agentKv.blobs.map(blobId)).toEqual(
      [aLeaf.id, aRoot.id, bLeaf.id, bRoot.id].sort(),
    );
    expect(finalTip.parents).toEqual([partialTip.versionId]);
    expect(finalTip.metadata).toMatchObject({
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 4,
      agentKvReferencedCount: 4,
      agentKvMissingCount: 0,
      chatCoreHash: portableChatCoreHash(aCore),
      syncOrigin: "agent-kv-enrichment",
    });

    const aCoreBeforeApply = readDatabaseChat(aDatabasePath);
    const applyResult = await applyGlobalDatabaseChanges(
      helperRequest(root, aDatabasePath),
      [await preparedTipChange(repository, finalTip)],
    );
    expect(applyResult.applied).toEqual([`chat/${COMPOSER_ID}`]);
    expect(applyResult.skipped).toEqual([]);

    const aCoreAfterApply = readDatabaseChat(aDatabasePath);
    expect(core(aCoreAfterApply)).toEqual(core(aCoreBeforeApply));
    expect(core(aCoreAfterApply)).toEqual(core(aCore));
    expect(portableChatCoreHash(aCoreAfterApply)).toBe(
      portableChatCoreHash(aCore),
    );
    expect(JSON.parse(aCoreAfterApply.header.value ?? "null") as unknown).toEqual(
      { name: TITLE },
    );

    const repairedA = await auditDatabaseChat(aDatabasePath);
    expectKnownAudit(repairedA.audit);
    expect(repairedA.audit).toMatchObject({
      unavailableRootIds: [],
      probedRootCount: 4,
    });
    expect(repairedA.audit.referencedRootIds).toEqual(
      [aLeaf.id, aRoot.id, bLeaf.id, bRoot.id].sort(),
    );

    // A complete v2 tip is not an enrichment candidate. The deliberately
    // invalid SQLite sentinel would throw if the lazy wrapper opened it, while
    // spying on the repository proves an idle pass does not decrypt the tip.
    const invalidIdleDatabase = join(root, "must-not-open.vscdb");
    await writeFile(invalidIdleDatabase, "not a sqlite database", "utf8");
    const readVersion = vi.spyOn(repository, "tryReadVersion");
    const idleCache = new Map<string, string>();
    const firstIdle = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      invalidIdleDatabase,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: idleCache,
      },
    );
    const secondIdle = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      invalidIdleDatabase,
      {
        cursor: firstIdle.cursor,
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: idleCache,
      },
    );
    expect(firstIdle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(secondIdle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(readVersion).not.toHaveBeenCalled();
  });

  it("carries a complete frozen-timestamp B continuation through the repository and resumes the same A composer", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-same-core-e2e-"));
    temporaryRoots.push(root);
    const repositoryRoot = join(root, "repository");
    const firstDevice = await SyncRepository.create(
      repositoryRoot,
      join(root, "repository-state-first"),
      PASSPHRASE,
      4 * 1024 * 1024,
      PRODUCER,
    );
    const aDatabasePath = join(root, "device-a-state.vscdb");
    createGlobalDatabase(aDatabasePath);

    const frozenTimestamp = 1_700_000_000_000;
    const baseLeaf = contentBlob(
      conversationStepBytes("shared base continuation leaf"),
    );
    const baseRoot = contentBlob(conversationTurnBytes([baseLeaf.id]));
    const bLeaf = contentBlob(
      conversationStepBytes("B continued conversation leaf"),
    );
    const bRoot = contentBlob(conversationTurnBytes([bLeaf.id]));
    const baseCore = chatSnapshot({
      bubbleCount: 1,
      composerRootId: baseRoot.id,
      label: "shared-base",
      lastUpdatedAt: frozenTimestamp,
      recency: 1,
    });
    const bCore = chatSnapshot({
      bubbleCount: 3,
      composerRootId: bRoot.id,
      label: "B-complete",
      lastUpdatedAt: frozenTimestamp,
      recency: 3,
    });
    const baseV2 = completeChatSnapshot(baseCore, [baseRoot, baseLeaf]);
    const bV2 = completeChatSnapshot(bCore, [bRoot, bLeaf]);
    const staleAFork: PortableChatSnapshotV2 = {
      ...baseV2,
      header: {
        ...baseV2.header,
        // Make A's stale fork byte-distinct and replicated-newest without
        // changing its visible sequence or Cursor's frozen update timestamp.
        recency: 99,
      },
    };
    seedChat(aDatabasePath, baseCore, [baseRoot, baseLeaf]);

    const baseVersionId = await publishExactChat(firstDevice, baseV2, []);
    await reconcileResult(firstDevice);

    const secondDevice = await SyncRepository.openWithMasterKey(
      repositoryRoot,
      join(root, "repository-state-second"),
      firstDevice.repository,
      Buffer.from(firstDevice.masterKey),
      4 * 1024 * 1024,
      PRODUCER,
    );
    expect(secondDevice.state.device.deviceId).not.toBe(
      firstDevice.state.device.deviceId,
    );
    await reconcileResult(secondDevice);

    // Replicated tips with equal Lamports sort by descending device ID. Give
    // the stale target side that deterministic first position so this test
    // fails under the old "first equal-timestamp tip wins" behavior no matter
    // which random device IDs the repositories received.
    const [deviceA, deviceB] =
      firstDevice.state.device.deviceId > secondDevice.state.device.deviceId
        ? [firstDevice, secondDevice]
        : [secondDevice, firstDevice];
    const bVersionId = await publishExactChat(deviceB, bV2, [baseVersionId]);

    // A has not reconciled B's event, so both children of the shared base are
    // concurrent at the same Lamport. A's stale child nevertheless sorts
    // first by the deterministic device-ID tie-break established above.
    const staleAVersionId = await publishExactChat(deviceA, staleAFork, [
      baseVersionId,
    ]);
    await deviceA.refreshState();
    const fork = await reconcileResult(deviceA);
    const forkTips = deviceA.state.tips[`chat/${COMPOSER_ID}`] ?? [];
    expect(forkTips.map((tip) => tip.versionId)).toEqual([
      staleAVersionId,
      bVersionId,
    ]);
    expect(fork.conflicts).toHaveLength(1);
    expect(fork.conflicts[0]?.baseVersionId).toBe(baseVersionId);
    expect(forkTips[0]?.metadata?.lastUpdatedAt).toBe(frozenTimestamp);
    expect(forkTips[1]?.metadata?.lastUpdatedAt).toBe(frozenTimestamp);

    expect(await autoMergeConflicts(deviceA, fork.conflicts)).toBe(true);
    const mergedResult = await reconcileResult(deviceA);
    expect(mergedResult.conflicts).toEqual([]);
    const mergedProjection = mergedResult.projections.find(
      (projection) => projection.resourceId === `chat/${COMPOSER_ID}`,
    );
    expect(mergedProjection).toBeDefined();
    if (mergedProjection === undefined) {
      throw new Error("Missing merged chat projection");
    }
    expect(mergedProjection.changed).toBe(true);

    const mergedTip = onlyTip(deviceA);
    expect(new Set(mergedTip.parents)).toEqual(
      new Set([bVersionId, staleAVersionId]),
    );
    const merged = await readTipChat(deviceA, mergedTip);
    expect(isPortableChatSnapshotV2(merged)).toBe(true);
    if (!isPortableChatSnapshotV2(merged)) {
      throw new Error("Frozen-timestamp merge did not retain chat schema v2");
    }
    expect(core(merged)).toEqual(core(bCore));
    expect(merged.agentKv).toMatchObject({ missingIds: [] });
    expect(merged.agentKv.referencedIds).toEqual(
      [baseLeaf.id, baseRoot.id, bLeaf.id, bRoot.id].sort(),
    );
    expect(merged.agentKv.blobs.map(blobId)).toEqual(
      [baseLeaf.id, baseRoot.id, bLeaf.id, bRoot.id].sort(),
    );
    expect(mergedTip.metadata).toMatchObject({
      composerId: COMPOSER_ID,
      lastUpdatedAt: frozenTimestamp,
      bubbleCount: 3,
      chatCoreHash: portableChatCoreHash(bCore),
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 4,
      agentKvReferencedCount: 4,
      agentKvMissingCount: 0,
    });

    expect(queuePending(deviceA, mergedProjection)).toBe(true);
    expect(deviceA.state.pendingDatabaseChanges).toHaveLength(1);
    expect(
      deviceA.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
    const batch = pendingHelperBatch(deviceA);
    expect(batch.deferredForBatchLimit).toBe(0);
    expect(batch.changes.map((change) => change.resourceId)).toEqual([
      `chat/${COMPOSER_ID}`,
    ]);

    const request = helperRequest(root, aDatabasePath);
    const prepared = await prepareChanges(deviceA, batch.changes);
    expect(prepared.skipped).toEqual([]);
    expect(prepared.failureByResourceId).toEqual({});
    expect(prepared.prepared.map(({ change }) => change.resourceId)).toEqual([
      `chat/${COMPOSER_ID}`,
    ]);
    const applyResult = await applyGlobalDatabaseChanges(
      request,
      prepared.prepared,
    );
    expect(applyResult.applied).toEqual([`chat/${COMPOSER_ID}`]);
    expect(applyResult.skipped).toEqual([]);
    expect(applyResult.failureByResourceId).toEqual({});
    markAppliedProjections(
      deviceA,
      batch.changes,
      applyResult.applied,
      new Set(applyResult.retainedLocal),
      applyResult.retainedLocalHashes,
      applyResult.localChatCoreHashes,
      applyResult.failureByResourceId,
    );
    expect(deviceA.state.pendingDatabaseChanges).toEqual([]);

    expect(readComposerIds(aDatabasePath)).toEqual([COMPOSER_ID]);
    const appliedA = readDatabaseChat(aDatabasePath);
    expect(appliedA.composerId).toBe(COMPOSER_ID);
    expect(core(appliedA)).toEqual(core(bCore));
    expect(portableChatCoreHash(appliedA)).toBe(portableChatCoreHash(bCore));
    const resumedA = await auditDatabaseChat(aDatabasePath);
    expectKnownAudit(resumedA.audit);
    expect(resumedA.audit).toMatchObject({
      unavailableRootIds: [],
      probedRootCount: 2,
    });
    expect(resumedA.audit.referencedRootIds).toEqual(
      [bLeaf.id, bRoot.id].sort(),
    );

    const adapter = new StateVscdbChatAdapter(request.paths, {
      periodicDeepVerification: false,
    });
    adapter.setMaxPayloadBytes(deviceA.maxPayloadBytes);
    const firstIdle = await adapter.scan(deviceA.state.projections);
    const secondIdle = await adapter.scan(deviceA.state.projections);
    expect(firstIdle.snapshots).toEqual([]);
    expect(firstIdle.deletions).toEqual([]);
    expect(secondIdle.snapshots).toEqual([]);
    expect(secondIdle.deletions).toEqual([]);
    expect(adapter.scanStatus().complete).toBe(true);

    const quiet = await reconcileResult(deviceA);
    const quietProjection = quiet.projections.find(
      (projection) => projection.resourceId === `chat/${COMPOSER_ID}`,
    );
    expect(quietProjection?.changed).toBe(false);
    for (const projection of quiet.projections.filter(
      (candidate) => candidate.changed,
    )) {
      queuePending(deviceA, projection);
    }
    expect(deviceA.state.pendingDatabaseChanges).toEqual([]);
    expect(pendingHelperBatch(deviceA)).toEqual({
      changes: [],
      deferredForBatchLimit: 0,
    });
  });
});

interface ContentBlob {
  id: string;
  bytes: Buffer;
  row: PortableKvRow;
}

function contentBlob(value: string | Buffer): ContentBlob {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const id = sha256(bytes);
  return {
    id,
    bytes,
    row: {
      key: `agentKv:blob:${id}`,
      valueBase64: bytes.toString("base64"),
      valueType: "blob",
    },
  };
}

function conversationTurnBytes(stepIds: readonly string[]): Buffer {
  return protobufBytesField(
    1,
    Buffer.concat(
      stepIds.map((id) => protobufBytesField(2, Buffer.from(id, "hex"))),
    ),
  );
}

function conversationStepBytes(text: string): Buffer {
  return protobufBytesField(
    1,
    protobufBytesField(1, Buffer.from(text, "utf8")),
  );
}

function protobufBytesField(
  fieldNumber: number,
  payload: Uint8Array,
): Buffer {
  return Buffer.concat([
    protobufVarint(BigInt(fieldNumber * 8 + 2)),
    protobufVarint(BigInt(payload.byteLength)),
    Buffer.from(payload),
  ]);
}

function protobufVarint(input: bigint): Buffer {
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

function protobufIds(ids: readonly string[]): Buffer {
  return Buffer.concat(
    ids.map((id) => protobufBytesField(8, Buffer.from(id, "hex"))),
  );
}

function serializedConversationState(id: string): string {
  return `~${protobufIds([id]).toString("base64")}`;
}

function chatSnapshot(options: {
  bubbleCount: number;
  composerRootId: string;
  errorBubbleRootId?: string;
  label: string;
  lastUpdatedAt?: number;
  recency?: number;
}): PortableChatSnapshotV1 {
  const bubbleIds = Array.from(
    { length: options.bubbleCount },
    (_, index) => `bubble-${index}`,
  );
  return {
    schemaVersion: 1,
    composerId: COMPOSER_ID,
    header: {
      composerId: COMPOSER_ID,
      workspaceId: "workspace",
      createdAt: 1,
      lastUpdatedAt: options.lastUpdatedAt ?? options.bubbleCount,
      isArchived: 0,
      isSubagent: 0,
      recency: options.recency ?? options.bubbleCount,
      checkpointAt: null,
      value: JSON.stringify({ name: TITLE }),
    },
    composerData: jsonRow(`composerData:${COMPOSER_ID}`, {
      fullConversationHeadersOnly: bubbleIds.map((bubbleId) => ({ bubbleId })),
      conversationState: serializedConversationState(options.composerRootId),
    }),
    bubbles: bubbleIds.map((bubbleId, index) =>
      jsonRow(`bubbleId:${COMPOSER_ID}:${bubbleId}`, {
        bubbleId,
        text:
          index === options.bubbleCount - 1 &&
          options.errorBubbleRootId !== undefined
            ? "Conversation data missing"
            : `${options.label} message ${index}`,
        ...(index === options.bubbleCount - 1 &&
        options.errorBubbleRootId !== undefined
          ? {
              conversationState: serializedConversationState(
                options.errorBubbleRootId,
              ),
            }
          : {}),
      }),
    ),
  };
}

function completeChatSnapshot(
  snapshot: PortableChatSnapshotV1,
  blobs: readonly ContentBlob[],
): PortableChatSnapshotV2 {
  const rows = blobs
    .map((blob) => blob.row)
    .sort((left, right) => left.key.localeCompare(right.key));
  const referencedIds = rows.map(blobId).sort();
  return {
    ...snapshot,
    schemaVersion: 2,
    agentKv: {
      blobs: rows,
      referencedIds,
      missingIds: [],
    },
  };
}

function jsonRow(key: string, value: unknown): PortableKvRow {
  return {
    key,
    valueBase64: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
    valueType: "text",
  };
}

function core(snapshot: PortableChatSnapshot): unknown {
  return {
    composerId: snapshot.composerId,
    header: snapshot.header,
    composerData: snapshot.composerData,
    bubbles: snapshot.bubbles,
  };
}

function blobId(row: PortableKvRow): string {
  return row.key.slice("agentKv:blob:".length);
}

function createGlobalDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode=WAL");
    database.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database.exec(
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database.exec(`CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
      recency INTEGER, checkpointAt INTEGER, value TEXT
    )`);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("existing", "preserved");
  } finally {
    database.close();
  }
}

function seedChat(
  databasePath: string,
  snapshot: PortableChatSnapshotV1,
  blobs: readonly ContentBlob[],
): void {
  const database = new DatabaseSync(databasePath);
  try {
    const header = snapshot.header;
    database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        header.composerId,
        header.workspaceId,
        header.createdAt,
        header.lastUpdatedAt,
        header.isArchived,
        header.isSubagent,
        header.recency,
        header.checkpointAt,
        header.value,
      );
    const insert = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
    );
    insert.run(
      snapshot.composerData.key,
      Buffer.from(snapshot.composerData.valueBase64, "base64").toString("utf8"),
    );
    for (const bubble of snapshot.bubbles) {
      insert.run(
        bubble.key,
        Buffer.from(bubble.valueBase64, "base64").toString("utf8"),
      );
    }
    for (const blob of blobs) {
      insert.run(blob.row.key, blob.bytes);
    }
  } finally {
    database.close();
  }
}

function readDatabaseChat(databasePath: string): PortableChatSnapshot {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const snapshot = readPortableChatSnapshot(database, COMPOSER_ID);
    if (snapshot === null) {
      throw new Error(`Missing test chat in ${databasePath}`);
    }
    return snapshot;
  } finally {
    database.close();
  }
}

function readComposerIds(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT composerId FROM composerHeaders ORDER BY composerId")
      .all() as Array<{ composerId?: unknown }>;
    return rows.map((row) => {
      if (typeof row.composerId !== "string") {
        throw new Error("Invalid composer ID in test database");
      }
      return row.composerId;
    });
  } finally {
    database.close();
  }
}

async function auditDatabaseChat(
  databasePath: string,
): Promise<{ snapshot: PortableChatSnapshot; audit: ChatContinuationRootAudit }> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const snapshot = readPortableChatSnapshot(database, COMPOSER_ID);
    if (snapshot === null) {
      throw new Error(`Missing test chat in ${databasePath}`);
    }
    return {
      snapshot,
      audit: await auditChatContinuationRoots(snapshot, sqliteProbe(database), {
        limits: {
          maxRootProbes: 8,
          maxRootsPerChat: 8,
          maxSeedBytesPerChat: 4 * 1024,
          maxGraphDepth: 4,
          maxProtobufDepth: 4,
        },
      }),
    };
  } finally {
    database.close();
  }
}

function sqliteProbe(database: sqlite.DatabaseSync): ChatContinuationRootProbe {
  const statement = database.prepare(
    `SELECT key, value, typeof(value) AS valueType,
            length(CAST(value AS BLOB)) AS valueBytes
       FROM cursorDiskKV
      WHERE key = ?`,
  );
  return (key, remainingBytes) => {
    const row = statement.get(key) as
      | {
          key?: unknown;
          value?: unknown;
          valueType?: unknown;
          valueBytes?: unknown;
        }
      | undefined;
    if (row === undefined) {
      return { status: "missing" };
    }
    if (
      row.key !== key ||
      typeof row.valueBytes !== "number" ||
      !Number.isSafeInteger(row.valueBytes) ||
      row.valueBytes < 0
    ) {
      return { status: "unreadable", reason: "invalid SQLite row metadata" };
    }
    if (row.valueBytes > remainingBytes) {
      return { status: "over-budget" };
    }
    if (row.valueType === "text" && typeof row.value === "string") {
      return {
        status: "found",
        key,
        bytes: Buffer.from(row.value, "utf8"),
        valueType: "text",
      };
    }
    if (row.valueType === "blob" && row.value instanceof Uint8Array) {
      return {
        status: "found",
        key,
        bytes: Buffer.from(row.value),
        valueType: "blob",
      };
    }
    return { status: "unreadable", reason: "unsupported SQLite storage" };
  };
}

function expectKnownAudit(
  audit: ChatContinuationRootAudit,
): asserts audit is Extract<ChatContinuationRootAudit, { status: "known" }> {
  expect(audit.status).toBe("known");
  if (audit.status !== "known") {
    throw new Error(`Continuation audit was unknown: ${audit.reason}`);
  }
}

function initialCursor(): ChatTipEnrichmentCursor {
  return { afterResourceId: null };
}

async function publishChat(
  repository: SyncRepository,
  chat: PortableChatSnapshot,
): Promise<ResourceTip> {
  await repository.publish(
    [
      {
        ...resourceSnapshot(chat, []),
        metadata: {
          composerId: chat.composerId,
          workspaceId: chat.header.workspaceId,
          bubbleCount: chat.bubbles.length,
          title: TITLE,
          chatCoreHash: portableChatCoreHash(chat),
        },
      },
    ],
    [],
  );
  await reconcile(repository);
  return onlyTip(repository);
}

function resourceSnapshot(
  chat: PortableChatSnapshot,
  parents: string[],
): ResourceSnapshot {
  const content = canonicalBytes(chat);
  return {
    resourceId: `chat/${chat.composerId}`,
    kind: "chat",
    content,
    semanticHash: sha256(content),
    parents,
  };
}

async function reconcile(repository: SyncRepository): Promise<void> {
  await reconcileResult(repository);
}

async function reconcileResult(
  repository: SyncRepository,
): Promise<ReconcileResult> {
  return new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  );
}

async function publishExactChat(
  repository: SyncRepository,
  chat: PortableChatSnapshot,
  parents: string[],
): Promise<string> {
  const published = await repository.publish(
    [
      {
        ...resourceSnapshot(chat, parents),
        metadata: exactChatMetadata(chat),
      },
    ],
    [],
  );
  if (published.eventHash === null) {
    throw new Error("Exact chat publish did not create an event");
  }
  return `${published.eventHash}#0`;
}

function exactChatMetadata(
  chat: PortableChatSnapshot,
): Record<string, JsonValue> {
  const metadata: Record<string, JsonValue> = {
    composerId: chat.composerId,
    workspaceId: chat.header.workspaceId,
    workspaceUri: null,
    lastUpdatedAt: chat.header.lastUpdatedAt,
    bubbleCount: chat.bubbles.length,
    title: TITLE,
    chatCoreHash: portableChatCoreHash(chat),
    chatSnapshotSchemaVersion: chat.schemaVersion,
  };
  if (isPortableChatSnapshotV2(chat)) {
    metadata.agentKvBlobCount = chat.agentKv.blobs.length;
    metadata.agentKvReferencedCount = chat.agentKv.referencedIds.length;
    metadata.agentKvMissingCount = chat.agentKv.missingIds.length;
  }
  return metadata;
}

function onlyTip(repository: SyncRepository): ResourceTip {
  const tips = repository.state.tips[`chat/${COMPOSER_ID}`] ?? [];
  expect(tips).toHaveLength(1);
  const tip = tips[0];
  if (tip === undefined) {
    throw new Error("Missing chat tip");
  }
  return tip;
}

async function readTipChat(
  repository: SyncRepository,
  tip: ResourceTip,
): Promise<PortableChatSnapshot> {
  const data = await repository.readVersion(tip.versionId);
  if (data.content === null) {
    throw new Error(`Chat tip ${tip.versionId} has no content`);
  }
  return parsePortableChatSnapshot(data.content);
}

async function preparedTipChange(
  repository: SyncRepository,
  tip: ResourceTip,
): Promise<PreparedHelperChange> {
  const data = await repository.readVersion(tip.versionId);
  if (data.content === null) {
    throw new Error(`Chat tip ${tip.versionId} has no content`);
  }
  return {
    change: {
      eventHash: tip.eventHash,
      changeIndex: tip.changeIndex,
      sourceDeviceId: tip.deviceId,
      resourceId: `chat/${COMPOSER_ID}`,
      kind: "chat",
      operation: "put",
      semanticHash: tip.semanticHash,
      ...(tip.payload === undefined ? {} : { payload: tip.payload }),
      ...(tip.metadata === undefined ? {} : { metadata: tip.metadata }),
    },
    content: data.content,
  };
}

function helperRequest(root: string, databasePath: string): HelperRequest {
  const cursorHome = join(root, ".cursor");
  const userDataRoot = join(root, "User");
  const extensionStorage = join(root, "helper-storage");
  return {
    version: 1,
    requestId: "12345678-9abc-4def-8abc-123456789abc",
    mode: "apply-and-restart",
    createdAt: "2026-08-11T00:00:00.000Z",
    repositoryRoot: join(root, "repository"),
    storageRoot: extensionStorage,
    cursorExecutable: "Cursor.exe",
    extensionHostPid: 1,
    restart: false,
    expectedCursorVersion: PRODUCER.cursorVersion,
    expectedVscodeVersion: PRODUCER.vscodeVersion,
    extensionVersion: PRODUCER.extensionVersion,
    paths: {
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
      extensionStorage,
      helperScript: join(root, "helper.js"),
    },
    changes: [],
    workspaceMappings: {},
    syncOptions: {
      ignoredSettings: [],
      ignoredExtensions: [],
      machineScopedSettings: [],
      syncChat: true,
      syncWorkspaceStorage: true,
      maxPayloadBytes: 4 * 1024 * 1024,
    },
  };
}
