import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  extensions: { all: [] },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  },
  window: {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  },
}));
import {
  __testing as chatEnrichmentTesting,
  buildChatTipEnrichmentCandidateIndex,
  CHAT_TIP_ENRICHMENT_CANDIDATE_PROBES_PER_CYCLE,
  CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES,
  enrichCurrentChatTips,
  enrichCurrentChatTipsFromLiveDatabase,
  type ChatTipEnrichmentCursor,
} from "../src/chat/enrichment";
import {
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  type PortableAgentKvPayload,
  type PortableChatSnapshot,
  type PortableChatSnapshotV1,
  type PortableChatSnapshotV2,
  type PortableKvRow,
} from "../src/chat/stateVscdb";
import { databaseApplyBlockReason } from "../src/platform/compatibility";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import { SyncManager } from "../src/sync/manager";
import {
  effectiveTipProducer,
  isSyntheticTip,
} from "../src/sync/versionPolicy";
import type {
  CompatibilityReport,
  EventProducer,
  JsonValue,
  ResourceSnapshot,
  ResourceTip,
} from "../src/types";
import type { ExtensionConfiguration } from "../src/config";
import type { CursorPaths } from "../src/platform/paths";
import type { ResourceAdapter } from "../src/resources/resource";
import type { ConflictController } from "../src/ui/conflicts";
import type { StatusController } from "../src/ui/status";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.63",
  cursorVersion: "3.15.6",
  vscodeVersion: "1.125.0",
};
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("manager repository-tip chat enrichment", () => {
  it("does not replace an automatic repair recipe with blob-only enrichment", async () => {
    const repository = await createRepository();
    const composerId = composer(99);
    const repairTip = await publishChat(repository, legacyChat(composerId, 3), {
      syncOrigin: "automatic-chat-repair",
      repairOriginDeviceId: "device-a",
      repairFingerprint: "repair-fingerprint",
    });
    const collectAgentKv = vi.fn(async () => ({
      agentKv: payload([], [], []),
    }));

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv,
    });

    expect(result).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(collectAgentKv).not.toHaveBeenCalled();
    expect(onlyTip(repository, `chat/${composerId}`).versionId).toBe(
      repairTip.versionId,
    );
  });

  it("upgrades a legacy tip without changing its repository chat core", async () => {
    const repository = await createRepository();
    const composerId = composer(1);
    const source = legacyChat(composerId, 5);
    const oldTip = await publishChat(repository, source);
    const blob = agentBlob("legacy-available");

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        agentKv: payload([blob], [], [blob.id]),
      }),
    });

    expect(result).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);
    const tip = onlyTip(repository, `chat/${composerId}`);
    expect(tip.parents).toEqual([oldTip.versionId]);
    expect(tip.metadata).toMatchObject({
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 1,
      agentKvMissingCount: 0,
      syncOrigin: "agent-kv-enrichment",
      agentKvEnrichmentAppliesCore: true,
      enrichedFromVersionId: oldTip.versionId,
      enrichedFromSemanticHash: oldTip.semanticHash,
    });
    expect(isSyntheticTip(tip)).toBe(true);
    const enriched = parsePortableChatSnapshot(
      (await repository.readVersion(tip.versionId)).content ?? Buffer.alloc(0),
    );
    expect(isPortableChatSnapshotV2(enriched)).toBe(true);
    expect(core(enriched)).toEqual(core(source));
  });

  it("republishes a complete legacy blob-only enrichment as a core-applying child", async () => {
    const repository = await createRepository();
    const composerId = composer(60);
    const root = agentBlob("legacy-complete-core-root");
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 4),
      schemaVersion: 2,
      agentKv: payload([root], [], [root.id]),
    };
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(root.id) }),
    );
    const oldTip = await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 1,
      agentKvMissingCount: 0,
      syncOrigin: "agent-kv-enrichment",
    });
    const collectAgentKv = vi.fn(async () => ({
      agentKv: source.agentKv,
    }));

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv,
    });

    expect(result).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    expect(collectAgentKv).not.toHaveBeenCalled();
    await reconcile(repository);
    const tip = onlyTip(repository, `chat/${composerId}`);
    expect(tip.parents).toEqual([oldTip.versionId]);
    expect(tip.semanticHash).toBe(oldTip.semanticHash);
    expect(tip.metadata).toMatchObject({
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 1,
      agentKvMissingCount: 0,
      syncOrigin: "agent-kv-enrichment",
      agentKvEnrichmentAppliesCore: true,
      enrichedFromVersionId: oldTip.versionId,
      enrichedFromSemanticHash: oldTip.semanticHash,
    });
    expect(
      (await repository.readVersion(tip.versionId)).content,
    ).toEqual((await repository.readVersion(oldTip.versionId)).content);
  });

  it("keeps a partial legacy enrichment blob-only until its closure is filled", async () => {
    const repository = await createRepository();
    const composerId = composer(61);
    const root = agentBlob("legacy-partial-core-root");
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 4),
      schemaVersion: 2,
      agentKv: payload([], [root.id], [root.id]),
    };
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(root.id) }),
    );
    const oldTip = await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 0,
      agentKvReferencedCount: 1,
      agentKvMissingCount: 1,
      syncOrigin: "agent-kv-enrichment",
      agentKvEnrichmentAppliesCore: false,
    });

    const stillPartial = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({ agentKv: source.agentKv }),
    });

    expect(stillPartial).toMatchObject({
      attempted: 1,
      published: 0,
      warnings: [],
    });
    expect(onlyTip(repository, `chat/${composerId}`).versionId).toBe(
      oldTip.versionId,
    );

    const filled = await enrichCurrentChatTips(repository, {
      cursor: stillPartial.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        agentKv: payload([root], [], [root.id]),
      }),
    });

    expect(filled).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);
    expect(onlyTip(repository, `chat/${composerId}`).metadata).toMatchObject({
      agentKvBlobCount: 1,
      agentKvMissingCount: 0,
      agentKvEnrichmentAppliesCore: true,
    });
  });

  it("does not mark a legacy missing-zero payload whose closure omits a descendant", async () => {
    const repository = await createRepository();
    const composerId = composer(64);
    const child = agentStepBlob("omitted-legacy-child");
    const parent = agentBlobLinking(child.id);
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 4),
      schemaVersion: 2,
      // The aggregate metadata says complete, but the parent reaches a child
      // that is neither declared nor materialized in this portable payload.
      agentKv: payload([parent], [], [parent.id]),
    };
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedTurnRoot(parent.id) }),
    );
    const oldTip = await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 1,
      agentKvMissingCount: 0,
      syncOrigin: "agent-kv-enrichment",
    });
    const collectAgentKv = vi.fn(async () => ({
      agentKv: source.agentKv,
    }));

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv,
    });

    expect(result).toMatchObject({ attempted: 1, published: 0, warnings: [] });
    expect(collectAgentKv).toHaveBeenCalledOnce();
    expect(onlyTip(repository, `chat/${composerId}`).versionId).toBe(
      oldTip.versionId,
    );
  });

  it("canonicalizes an unreachable absent orphan from an auto-merged tip", async () => {
    const repository = await createRepository();
    const composerId = composer(66);
    const active = agentBlob("auto-merge-active-root");
    const orphan = agentBlob("auto-merge-unreachable-absent-orphan");
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 4),
      schemaVersion: 2,
      agentKv: payload(
        [active],
        [orphan.id],
        [active.id, orphan.id],
      ),
    };
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(active.id) }),
    );
    const oldTip = await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 1,
      syncOrigin: "auto-merge",
    });
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    const databasePath = join(root, "absent-orphan-state.vscdb");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)",
      );
    } finally {
      database.close();
    }

    const result = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
      },
    );

    expect(result).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);
    const tip = onlyTip(repository, `chat/${composerId}`);
    expect(tip.parents).toEqual([oldTip.versionId]);
    expect(tip.metadata).toMatchObject({
      agentKvBlobCount: 1,
      agentKvReferencedCount: 1,
      agentKvMissingCount: 0,
      syncOrigin: "agent-kv-enrichment",
      agentKvEnrichmentAppliesCore: true,
    });
    const normalized = parsePortableChatSnapshot(
      (await repository.readVersion(tip.versionId)).content ?? Buffer.alloc(0),
    );
    expect(isPortableChatSnapshotV2(normalized) && normalized.agentKv).toEqual(
      payload([active], [], [active.id]),
    );
    expect(core(normalized)).toEqual(core(source));
  });

  it("normalizes legacy Calendar phantom missing IDs after exact absence proof", async () => {
    const repository = await createRepository();
    const composerId = composer(73);
    const embeddedMatch32 = protobufBytesField(2, Buffer.alloc(30, 0x61));
    const content32 = Buffer.alloc(32, 0x62);
    expect(embeddedMatch32).toHaveLength(32);
    const grepFileMatch = Buffer.concat([
      protobufBytesField(2, embeddedMatch32),
      protobufBytesField(2, protobufBytesField(2, content32)),
    ]);
    const step = agentBlobFromBytes(
      protobufBytesField(
        2,
        protobufBytesField(
          5,
          protobufBytesField(
            2,
            protobufBytesField(
              1,
              protobufBytesField(
                4,
                protobufBytesField(
                  2,
                  protobufBytesField(
                    3,
                    protobufBytesField(1, grepFileMatch),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    const turn = agentBlobLinking(step.id);
    const phantomIds = [
      embeddedMatch32.toString("hex"),
      content32.toString("hex"),
    ].sort();
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 4),
      schemaVersion: 2,
      agentKv: payload(
        [turn, step],
        phantomIds,
        [turn.id, step.id, ...phantomIds],
      ),
    };
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedTurnRoot(turn.id) }),
    );
    const oldTip = await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 2,
      agentKvReferencedCount: 4,
      agentKvMissingCount: 2,
      syncOrigin: "agent-kv-enrichment",
      agentKvEnrichmentAppliesCore: false,
    });
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    const databasePath = join(root, "calendar-phantom-state.vscdb");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)",
      );
    } finally {
      database.close();
    }

    const result = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
      },
    );

    expect(result).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);
    const tip = onlyTip(repository, `chat/${composerId}`);
    expect(tip.parents).toEqual([oldTip.versionId]);
    expect(tip.metadata).toMatchObject({
      agentKvBlobCount: 2,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 0,
      agentKvEnrichmentAppliesCore: true,
    });
    const normalized = parsePortableChatSnapshot(
      (await repository.readVersion(tip.versionId)).content ?? Buffer.alloc(0),
    );
    expect(isPortableChatSnapshotV2(normalized) && normalized.agentKv).toEqual(
      payload([turn, step], [], [turn.id, step.id]),
    );
    expect(core(normalized)).toEqual(core(source));
  });

  it("rejects an injected collector that prunes an orphan without exact absence proof", async () => {
    const repository = await createRepository();
    const composerId = composer(72);
    const active = agentBlob("malicious-prune-active-root");
    const orphan = agentBlob("malicious-prune-unproven-orphan");
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 3),
      schemaVersion: 2,
      agentKv: payload(
        [active],
        [orphan.id],
        [active.id, orphan.id],
      ),
    };
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(active.id) }),
    );
    const oldTip = await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 1,
      syncOrigin: "auto-merge",
    });

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        agentKv: payload([active], [], [active.id]),
      }),
    });

    expect(result).toMatchObject({ attempted: 1, published: 0 });
    expect(result.warnings.join(" ")).toContain(
      "pruned without exact absence proof",
    );
    expect(onlyTip(repository, `chat/${composerId}`).versionId).toBe(
      oldTip.versionId,
    );
  });

  it("corrects then fills an omitted descendant from a missing-zero auto-merge tip", async () => {
    const repository = await createRepository();
    const composerId = composer(67);
    const child = agentStepBlob("auto-merge-omitted-active-child");
    const parent = agentBlobLinking(child.id);
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 4),
      schemaVersion: 2,
      agentKv: payload([parent], [], [parent.id]),
    };
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedTurnRoot(parent.id) }),
    );
    await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 1,
      agentKvMissingCount: 0,
      syncOrigin: "auto-merge",
    });

    const corrected = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        agentKv: payload(
          [parent],
          [child.id],
          [parent.id, child.id],
        ),
      }),
    });

    expect(corrected).toMatchObject({
      attempted: 1,
      published: 1,
      warnings: [],
    });
    await reconcile(repository);
    expect(onlyTip(repository, `chat/${composerId}`).metadata).toMatchObject({
      agentKvBlobCount: 1,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 1,
      agentKvEnrichmentAppliesCore: false,
    });

    const filled = await enrichCurrentChatTips(repository, {
      cursor: corrected.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        agentKv: payload(
          [parent, child],
          [],
          [parent.id, child.id],
        ),
      }),
    });

    expect(filled).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);
    expect(onlyTip(repository, `chat/${composerId}`).metadata).toMatchObject({
      agentKvBlobCount: 2,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 0,
      agentKvEnrichmentAppliesCore: true,
    });
  });

  it.each([
    ["version restore", composer(69), { syncOrigin: "version-restore" }],
    [
      "conflict resolution",
      composer(70),
      { syncOrigin: "conflict-resolution" },
    ],
    [
      "checkpointed version restore",
      composer(71),
      {
        syncOrigin: "checkpoint-marker",
        checkpointedSyncOrigin: "version-restore",
      },
    ],
  ] as const)(
    "audits and fills a false-complete %s tip",
    async (_label, composerId, originMetadata) => {
      const repository = await createRepository();
      const child = agentStepBlob(`${_label}-omitted-active-child`);
      const parent = agentBlobLinking(child.id);
      const source: PortableChatSnapshotV2 = {
        ...legacyChat(composerId, 3),
        schemaVersion: 2,
        agentKv: payload([parent], [], [parent.id]),
      };
      source.composerData = row(
        `composerData:${composerId}`,
        JSON.stringify({ conversationState: serializedTurnRoot(parent.id) }),
      );
      await publishChat(repository, source, {
        chatSnapshotSchemaVersion: 2,
        agentKvBlobCount: 1,
        agentKvReferencedCount: 1,
        agentKvMissingCount: 0,
        ...originMetadata,
      });
      const collectAgentKv = vi.fn(async () => ({
        agentKv: payload(
          [parent, child],
          [],
          [parent.id, child.id],
        ),
      }));

      const result = await enrichCurrentChatTips(repository, {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        collectAgentKv,
      });

      expect(result).toMatchObject({
        attempted: 1,
        published: 1,
        warnings: [],
      });
      expect(collectAgentKv).toHaveBeenCalledOnce();
      await reconcile(repository);
      expect(onlyTip(repository, `chat/${composerId}`).metadata).toMatchObject({
        syncOrigin: "agent-kv-enrichment",
        agentKvBlobCount: 2,
        agentKvReferencedCount: 2,
        agentKvMissingCount: 0,
        agentKvEnrichmentAppliesCore: true,
      });
    },
  );

  it("treats an already core-applying enrichment tip as terminal", async () => {
    const repository = await createRepository();
    const composerId = composer(62);
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 2),
      schemaVersion: 2,
      agentKv: payload([], [], []),
    };
    await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 0,
      agentKvReferencedCount: 0,
      agentKvMissingCount: 0,
      syncOrigin: "agent-kv-enrichment",
      agentKvEnrichmentAppliesCore: true,
    });
    const collectAgentKv = vi.fn(async () => ({
      agentKv: source.agentKv,
    }));

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv,
    });

    expect(result).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(collectAgentKv).not.toHaveBeenCalled();
  });

  it("continues filling historical partial tips that were flagged too early", async () => {
    const repository = await createRepository();
    const composerId = composer(65);
    const root = agentBlob("historical-partial-flagged-root");
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 2),
      schemaVersion: 2,
      agentKv: payload([], [root.id], [root.id]),
    };
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(root.id) }),
    );
    await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 0,
      agentKvReferencedCount: 1,
      agentKvMissingCount: 1,
      syncOrigin: "agent-kv-enrichment",
      // Pre-migration producers attached this to partial children too.
      agentKvEnrichmentAppliesCore: true,
    });

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        agentKv: payload([root], [], [root.id]),
      }),
    });

    expect(result).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);
    expect(onlyTip(repository, `chat/${composerId}`).metadata).toMatchObject({
      agentKvMissingCount: 0,
      agentKvEnrichmentAppliesCore: true,
    });
  });

  it("stays idle after reconciling a legacy core-applying upgrade", async () => {
    const repository = await createRepository();
    const composerId = composer(63);
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 2),
      schemaVersion: 2,
      agentKv: payload([], [], []),
    };
    await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 0,
      agentKvReferencedCount: 0,
      agentKvMissingCount: 0,
      syncOrigin: "agent-kv-enrichment",
    });
    const collectAgentKv = vi.fn(async () => ({
      agentKv: source.agentKv,
    }));
    const read = vi.spyOn(repository, "tryReadVersion");

    const upgraded = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv,
    });
    expect(upgraded.published).toBe(1);
    await reconcile(repository);
    const idle = await enrichCurrentChatTips(repository, {
      cursor: upgraded.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv,
    });

    expect(idle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(collectAgentKv).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });

  it("fills an incomplete v2 tip and publishes only newly materialized blobs", async () => {
    const repository = await createRepository();
    const composerId = composer(2);
    const first = agentBlob("already-in-repository");
    const second = agentBlob("available-on-this-device");
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 4),
      schemaVersion: 2,
      agentKv: payload([first], [second.id], [first.id, second.id]),
    };
    const oldTip = await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 1,
    });

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        agentKv: payload([first, second], [], [first.id, second.id]),
      }),
    });

    expect(result.published).toBe(1);
    await reconcile(repository);
    const tip = onlyTip(repository, `chat/${composerId}`);
    expect(tip.parents).toEqual([oldTip.versionId]);
    expect(tip.metadata?.agentKvBlobCount).toBe(2);
    expect(tip.metadata?.agentKvMissingCount).toBe(0);
    const enriched = parsePortableChatSnapshot(
      (await repository.readVersion(tip.versionId)).content ?? Buffer.alloc(0),
    );
    expect(isPortableChatSnapshotV2(enriched) && enriched.agentKv.blobs).toHaveLength(
      2,
    );
    expect(core(enriched)).toEqual(core(source));
  });

  it("recovers a source-missing blob that the winning core no longer reaches, then stays idle", async () => {
    const repository = await createRepository();
    const composerId = composer(42);
    const winningRoot = agentBlob("winning-core-root-a");
    const losingOrphan = agentBlob("losing-core-orphan-b");
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 2),
      schemaVersion: 2,
      agentKv: payload(
        [winningRoot],
        [losingOrphan.id],
        [winningRoot.id, losingOrphan.id],
      ),
    };
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(winningRoot.id) }),
    );
    await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 1,
    });
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    const databasePath = join(root, "orphan-missing-state.vscdb");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)",
      );
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(
          losingOrphan.row.key,
          Buffer.from(losingOrphan.row.valueBase64, "base64"),
        );
    } finally {
      database.close();
    }
    const attempts = new Map<string, string>();
    const read = vi.spyOn(repository, "tryReadVersion");

    const recovered = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: attempts,
      },
    );

    expect(recovered).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);
    const tip = onlyTip(repository, `chat/${composerId}`);
    expect(tip.metadata).toMatchObject({
      agentKvBlobCount: 2,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 0,
    });
    const enriched = parsePortableChatSnapshot(
      (await repository.readVersion(tip.versionId)).content ?? Buffer.alloc(0),
    );
    expect(isPortableChatSnapshotV2(enriched)).toBe(true);
    expect(
      isPortableChatSnapshotV2(enriched) && enriched.agentKv,
    ).toEqual(
      payload(
        [winningRoot, losingOrphan],
        [],
        [winningRoot.id, losingOrphan.id],
      ),
    );
    expect(core(enriched)).toEqual(core(source));

    // Change the live DB generation after the repair. A complete v2 tip is no
    // longer a candidate, so it must not be decrypted or reopened just because
    // unrelated SQLite state changed.
    const changed = new DatabaseSync(databasePath);
    try {
      changed
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run("unrelated-generation-change", "x");
    } finally {
      changed.close();
    }
    const idle = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: recovered.cursor,
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: attempts,
      },
    );

    expect(idle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(read).toHaveBeenCalledOnce();
  });

  it("does not publish a schema marker when no local blob is available", async () => {
    const repository = await createRepository();
    const composerId = composer(3);
    const source = legacyChat(composerId, 3);
    const oldTip = await publishChat(repository, source);
    const missing = sha256(Buffer.from("not-on-this-device", "utf8"));

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        agentKv: payload([], [missing], [missing]),
      }),
    });

    expect(result).toMatchObject({ attempted: 1, published: 0, warnings: [] });
    expect(onlyTip(repository, `chat/${composerId}`).versionId).toBe(
      oldTip.versionId,
    );
  });

  it("publishes audited empty graphs once without opening SQLite on later DB generations", async () => {
    const repository = await createRepository();
    const withoutState = legacyChat(composer(40), 2);
    const emptyState = legacyChat(composer(41), 2);
    emptyState.composerData = row(
      `composerData:${emptyState.composerId}`,
      JSON.stringify({ conversationState: "~" }),
    );
    await publishChat(repository, withoutState);
    await publishChat(repository, emptyState);
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    // Both cores prove that their graph has no roots before the lazy
    // connection is needed. This deliberately invalid file makes any SQLite
    // open fail the test while still supplying a generation identity.
    const databasePath = join(root, "empty-graph-not-sqlite.vscdb");
    await writeFile(databasePath, "first generation", "utf8");
    const attempts = new Map<string, string>();
    const read = vi.spyOn(repository, "tryReadVersion");

    const first = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: attempts,
      },
    );

    expect(first).toMatchObject({ attempted: 2, published: 2, warnings: [] });
    expect(read).toHaveBeenCalledTimes(2);
    await reconcile(repository);
    for (const source of [withoutState, emptyState]) {
      const tip = onlyTip(repository, `chat/${source.composerId}`);
      expect(tip.metadata).toMatchObject({
        chatSnapshotSchemaVersion: 2,
        agentKvBlobCount: 0,
        agentKvReferencedCount: 0,
        agentKvMissingCount: 0,
      });
      const upgraded = parsePortableChatSnapshot(
        (await repository.readVersion(tip.versionId)).content ?? Buffer.alloc(0),
      );
      expect(isPortableChatSnapshotV2(upgraded)).toBe(true);
      expect(isPortableChatSnapshotV2(upgraded) && upgraded.agentKv).toEqual({
        blobs: [],
        referencedIds: [],
        missingIds: [],
      });
      expect(core(upgraded)).toEqual(core(source));
    }

    // Even a changed DB generation cannot make the complete v2 tips eligible
    // again, so an idle cycle performs neither decryption nor SQLite work.
    await writeFile(databasePath, "a distinct second generation", "utf8");
    const idle = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: first.cursor,
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: attempts,
      },
    );

    expect(idle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not decrypt or walk the same no-op tip on every idle cycle", async () => {
    const repository = await createRepository();
    const composerId = composer(30);
    await publishChat(repository, legacyChat(composerId, 3));
    const attempts = new Map<string, string>();
    const collect = vi.fn(async () => null);
    const read = vi.spyOn(repository, "tryReadVersion");

    const first = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "stable-db-generation",
    });
    const idle = await enrichCurrentChatTips(repository, {
      cursor: first.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "stable-db-generation",
    });

    expect(first.attempted).toBe(1);
    expect(idle.attempted).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(collect).toHaveBeenCalledOnce();

    await enrichCurrentChatTips(repository, {
      cursor: idle.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "changed-db-generation",
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("retries a tip whose repository payload was still hydrating", async () => {
    const repository = await createRepository();
    const composerId = composer(32);
    await publishChat(repository, legacyChat(composerId, 2));
    const attempts = new Map<string, string>();
    const actualRead = repository.tryReadVersion.bind(repository);
    const read = vi
      .spyOn(repository, "tryReadVersion")
      .mockResolvedValueOnce(null)
      .mockImplementation(actualRead);
    const collect = vi.fn(async () => null);

    const first = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "same-db-generation",
    });
    const retry = await enrichCurrentChatTips(repository, {
      cursor: first.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "same-db-generation",
    });

    expect(first.attempted).toBe(1);
    expect(retry.attempted).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledOnce();
  });

  it("does not cache a no-op caused by a transient exact-key lookup failure", async () => {
    const repository = await createRepository();
    const composerId = composer(35);
    const blob = agentBlob("available-after-transient-lookup-failure");
    const source = legacyChat(composerId, 2);
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(blob.id) }),
    );
    await publishChat(repository, source);
    const attempts = new Map<string, string>();
    const metadataGet = vi.fn(() => ({
      key: blob.row.key,
      valueType: "blob",
      valueBytes: Buffer.from(blob.row.valueBase64, "base64").byteLength,
    }));
    const valueGet = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("database is temporarily busy"), {
          code: "SQLITE_BUSY",
        });
      })
      .mockImplementation(() => ({
        key: blob.row.key,
        value: Buffer.from(blob.row.valueBase64, "base64"),
        valueType: "blob",
      }));
    const database = fakeAgentKvDatabase(metadataGet, valueGet);
    const collect = vi.fn(
      (
        snapshot: PortableChatSnapshot,
        context: Parameters<
          typeof chatEnrichmentTesting.collectLiveAgentKv
        >[2],
      ) =>
        chatEnrichmentTesting.collectLiveAgentKv(database, snapshot, context),
    );

    const first = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "unchanged-live-database",
    });
    const retry = await enrichCurrentChatTips(repository, {
      cursor: first.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "unchanged-live-database",
    });

    expect(first).toMatchObject({ attempted: 1, published: 0, warnings: [] });
    expect(retry).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    expect(collect).toHaveBeenCalledTimes(2);
    expect(metadataGet).toHaveBeenCalledTimes(2);
    expect(valueGet).toHaveBeenCalledTimes(2);
  });

  it("caches genuine missing and unsupported exact rows as stable no-ops", async () => {
    const repository = await createRepository();
    const missingBlob = agentBlob("genuinely-missing-row");
    const unsupportedBlob = agentBlob("unsupported-storage-row");
    for (const [index, blob] of [missingBlob, unsupportedBlob].entries()) {
      const composerId = composer(38 + index);
      const source = legacyChat(composerId, 1);
      source.composerData = row(
        `composerData:${composerId}`,
        JSON.stringify({ conversationState: serializedRoot(blob.id) }),
      );
      await publishChat(repository, source);
    }
    const metadataGet = vi.fn((key: unknown) =>
      key === missingBlob.row.key
        ? undefined
        : {
            key,
            valueType: "integer",
            valueBytes: 8,
          },
    );
    const valueGet = vi.fn(() => {
      throw new Error("missing or unsupported rows must not be materialized");
    });
    const database = fakeAgentKvDatabase(metadataGet, valueGet);
    const attempts = new Map<string, string>();
    const collect = vi.fn(
      (
        snapshot: PortableChatSnapshot,
        context: Parameters<
          typeof chatEnrichmentTesting.collectLiveAgentKv
        >[2],
      ) =>
        chatEnrichmentTesting.collectLiveAgentKv(database, snapshot, context),
    );

    const first = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "stable-missing-and-unsupported-db",
    });
    const idle = await enrichCurrentChatTips(repository, {
      cursor: first.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "stable-missing-and-unsupported-db",
    });

    expect(first).toMatchObject({ attempted: 2, published: 0, warnings: [] });
    expect(idle.attempted).toBe(0);
    expect(metadataGet).toHaveBeenCalledTimes(2);
    expect(valueGet).not.toHaveBeenCalled();
  });

  it("keeps a structural source-state refusal cached across unrelated DB generations", async () => {
    const repository = await createRepository();
    const composerId = composer(43);
    const source = legacyChat(composerId, 1);
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: "not-a-tilde-state" }),
    );
    await publishChat(repository, source);
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    const databasePath = join(root, "structural-state-cache.vscdb");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)",
      );
    } finally {
      database.close();
    }
    const attempts = new Map<string, string>();
    const read = vi.spyOn(repository, "tryReadVersion");

    const first = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: attempts,
      },
    );
    // If the policy-stable cache incorrectly includes the WAL/main generation,
    // the second call will try to open this replacement as SQLite and fail.
    await writeFile(databasePath, "unrelated non-SQLite generation", "utf8");
    const idle = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: first.cursor,
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: attempts,
      },
    );

    expect(first).toMatchObject({ attempted: 1, published: 0, warnings: [] });
    expect(idle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(read).toHaveBeenCalledOnce();
  });

  it("caches an at-limit source before decrypting it or opening SQLite", async () => {
    const repository = await createRepository();
    const composerId = composer(36);
    const oldTip = await publishChat(repository, legacyChat(composerId, 2));
    const declaredBytes = oldTip.payload?.plainBytes;
    if (declaredBytes === undefined) {
      throw new Error("Published chat tip has no payload reference");
    }
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    // Generation probing can stat this path, but any attempt to open it as a
    // SQLite database would fail the test.
    const databasePath = join(root, "deliberately-not-sqlite.vscdb");
    await writeFile(databasePath, "not a sqlite database", "utf8");
    const attempts = new Map<string, string>();
    const read = vi.spyOn(repository, "tryReadVersion");

    const first = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: declaredBytes,
        attemptCache: attempts,
      },
    );
    await writeFile(
      databasePath,
      "an unrelated DB generation that is still deliberately not SQLite",
      "utf8",
    );
    const idle = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: first.cursor,
        maxPayloadBytes: declaredBytes,
        attemptCache: attempts,
      },
    );

    expect(first.attempted).toBe(1);
    expect(first.published).toBe(0);
    expect(first.warnings[0]).toContain("source payload is");
    expect(idle.attempted).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("defers an interactive-oversized source before decrypt, collect, or publish", async () => {
    const repository = await createRepository();
    const composerId = composer(361);
    const tip = await publishChat(repository, legacyChat(composerId, 2));
    if (tip.payload === undefined) {
      throw new Error("Published chat tip has no payload reference");
    }
    // Object references are authenticated by the event manifest. Inflating
    // this declared size exercises the pre-decrypt policy without allocating
    // a real 16 MiB JSON fixture in every test process.
    tip.payload.plainBytes = Math.ceil(
      CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES / 2,
    );
    const read = vi.spyOn(repository, "tryReadVersion");
    const publish = vi.spyOn(repository, "publish");
    const collect = vi.fn(async () => ({
      agentKv: payload([], [], []),
    }));

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES * 4,
      collectAgentKv: collect,
    });

    expect(result).toMatchObject({ attempted: 1, published: 0 });
    expect(result.warnings.join(" ")).toContain("interactive work budget");
    expect(read).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    [
      "many-token",
      () => {
        const source = legacyChat(composer(362), 1) as PortableChatSnapshot & {
          future?: unknown;
        };
        source.future = Array.from({ length: 90_000 }, () => ({}));
        return source;
      },
    ],
    [
      "deep",
      () => {
        const source = legacyChat(composer(363), 1) as PortableChatSnapshot & {
          future?: unknown;
        };
        let nested: unknown = "leaf";
        for (let depth = 0; depth < 257; depth += 1) {
          nested = [nested];
        }
        source.future = nested;
        return source;
      },
    ],
  ])(
    "policy-stably defers a compact %s source before snapshot parse, collect, or publish",
    async (_shape, createSource) => {
      const repository = await createRepository();
      const source = createSource();
      await publishChat(repository, source);
      const attempts = new Map<string, string>();
      const read = vi.spyOn(repository, "tryReadVersion");
      const publish = vi.spyOn(repository, "publish");
      const collect = vi.fn(async () => ({
        agentKv: payload([], [], []),
      }));
      const parse = vi.spyOn(JSON, "parse");
      try {
        const first = await enrichCurrentChatTips(repository, {
          cursor: initialCursor(),
          maxPayloadBytes: repository.maxPayloadBytes,
          collectAgentKv: collect,
          attemptCache: attempts,
          databaseGeneration: "first-generation",
        });
        const idle = await enrichCurrentChatTips(repository, {
          cursor: first.cursor,
          maxPayloadBytes: repository.maxPayloadBytes,
          collectAgentKv: collect,
          attemptCache: attempts,
          databaseGeneration: "unrelated-generation",
        });

        expect(first).toMatchObject({ attempted: 1, published: 0 });
        expect(first.warnings.join(" ")).toContain(
          "structural parser safety limit",
        );
        expect(idle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
        expect(read).toHaveBeenCalledOnce();
        expect(collect).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(
          parse.mock.calls.filter(
            ([value]) =>
              typeof value === "string" &&
              value.includes('"bubbles":') &&
              value.includes(`"composerId":"${source.composerId}"`),
          ),
        ).toHaveLength(0);
      } finally {
        parse.mockRestore();
      }
    },
  );

  it.each([
    [
      "deep decoded row",
      () => {
        let nested = "0";
        for (let depth = 0; depth < 257; depth += 1) {
          nested = `[${nested}]`;
        }
        const source = legacyChat(composer(364), 0);
        source.composerData = row(
          `composerData:${source.composerId}`,
          nested,
        );
        return source;
      },
    ],
    [
      "aggregate many-small decoded rows",
      () => {
        const source = legacyChat(composer(365), 4_000);
        const minified = `[${Array.from({ length: 20 }, () => "0").join(",")}]`;
        source.bubbles = source.bubbles.map((bubble) =>
          row(bubble.key, minified)
        );
        return source;
      },
    ],
  ])(
    "policy-stably defers %s before collect or publish",
    async (_shape, createSource) => {
      const repository = await createRepository();
      const source = createSource();
      await publishChat(repository, source);
      const attempts = new Map<string, string>();
      const read = vi.spyOn(repository, "tryReadVersion");
      const publish = vi.spyOn(repository, "publish");
      const collect = vi.fn(async () => ({
        agentKv: payload([], [], []),
      }));

      const first = await enrichCurrentChatTips(repository, {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        collectAgentKv: collect,
        attemptCache: attempts,
        databaseGeneration: "first-generation",
      });
      const idle = await enrichCurrentChatTips(repository, {
        cursor: first.cursor,
        maxPayloadBytes: repository.maxPayloadBytes,
        collectAgentKv: collect,
        attemptCache: attempts,
        databaseGeneration: "unrelated-generation",
      });

      expect(first).toMatchObject({ attempted: 1, published: 0 });
      expect(first.warnings.join(" ")).toContain(
        "decoded row chat JSON exceeds",
      );
      expect(idle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
      expect(read).toHaveBeenCalledOnce();
      expect(collect).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("preflights an over-budget exact row without materializing its value", async () => {
    const composerId = composer(37);
    const blob = agentBlob("small hash identity with a huge declared row");
    const source = legacyChat(composerId, 1);
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(blob.id) }),
    );
    const metadataGet = vi.fn(() => ({
      key: blob.row.key,
      valueType: "blob",
      valueBytes: 128 * 1024 * 1024,
    }));
    const valueGet = vi.fn(() => {
      throw new Error("oversized value SELECT must not run");
    });
    const database = fakeAgentKvDatabase(metadataGet, valueGet);
    const sourceBytes = canonicalBytes(source).byteLength;

    const result = await chatEnrichmentTesting.collectLiveAgentKv(
      database,
      source,
      {
        sourceContentBytes: sourceBytes,
        maxPayloadBytes: sourceBytes + 64 * 1024,
      },
    );

    expect(result).toEqual({ agentKv: null });
    expect(metadataGet).toHaveBeenCalledOnce();
    expect(valueGet).not.toHaveBeenCalled();
  });

  it("still proves a later orphan absent after the raw materialization budget reaches zero", async () => {
    const composerId = composer(73);
    const bytes = Buffer.alloc(3_072, 0x5a);
    const materializedId = sha256(bytes);
    const absentId = sha256(Buffer.from("zero-budget-absent-orphan", "utf8"));
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 1),
      schemaVersion: 2,
      agentKv: {
        blobs: [],
        // Keep the materialized row first to drive remainingRawBytes to zero
        // before the exact metadata-only absence probe.
        referencedIds: [materializedId, absentId],
        missingIds: [materializedId, absentId],
      },
    };
    const materializedKey = `agentKv:blob:${materializedId}`;
    const absentKey = `agentKv:blob:${absentId}`;
    const metadataGet = vi.fn((key: unknown) =>
      key === materializedKey
        ? { key, valueType: "blob", valueBytes: bytes.byteLength }
        : undefined,
    );
    const valueGet = vi.fn((key: unknown) =>
      key === materializedKey
        ? { key, value: bytes, valueType: "blob" }
        : undefined,
    );

    const result = await chatEnrichmentTesting.collectLiveAgentKv(
      fakeAgentKvDatabase(metadataGet, valueGet),
      source,
      {
        sourceContentBytes: 100,
        // Encoded room 20 KiB => 16 KiB JSON reserve and exactly 3 KiB raw.
        maxPayloadBytes: 100 + 20 * 1024,
      },
    );

    expect(metadataGet).toHaveBeenNthCalledWith(1, materializedKey);
    expect(metadataGet).toHaveBeenNthCalledWith(2, absentKey);
    expect(valueGet).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      agentKv: {
        referencedIds: [materializedId],
        missingIds: [],
      },
      provenAbsentSourceMissingIds: [absentId],
    });
  });

  it("retries an over-budget live row after the database generation changes", async () => {
    const repository = await createRepository();
    const composerId = composer(45);
    const blob = agentBlob("valid after an oversized live-row generation");
    const source = legacyChat(composerId, 1);
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(blob.id) }),
    );
    await publishChat(repository, source);
    const bytes = Buffer.from(blob.row.valueBase64, "base64");
    let oversized = true;
    const metadataGet = vi.fn(() => ({
      key: blob.row.key,
      valueType: "blob",
      valueBytes: oversized ? 128 * 1024 * 1024 : bytes.byteLength,
    }));
    const valueGet = vi.fn(() => ({
      key: blob.row.key,
      value: bytes,
      valueType: "blob",
    }));
    const database = fakeAgentKvDatabase(metadataGet, valueGet);
    const attempts = new Map<string, string>();
    const collect = (
      snapshot: PortableChatSnapshot,
      context: Parameters<typeof chatEnrichmentTesting.collectLiveAgentKv>[2],
    ) => chatEnrichmentTesting.collectLiveAgentKv(database, snapshot, context);

    const first = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "oversized-row-generation",
    });
    const sameGeneration = await enrichCurrentChatTips(repository, {
      cursor: first.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "oversized-row-generation",
    });
    oversized = false;
    const recovered = await enrichCurrentChatTips(repository, {
      cursor: sameGeneration.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      attemptCache: attempts,
      databaseGeneration: "valid-row-generation",
    });

    expect(first).toMatchObject({ attempted: 1, published: 0, warnings: [] });
    expect(sameGeneration).toMatchObject({
      attempted: 0,
      published: 0,
      warnings: [],
    });
    expect(recovered).toMatchObject({
      attempted: 1,
      published: 1,
      warnings: [],
    });
    expect(metadataGet).toHaveBeenCalledTimes(2);
    expect(valueGet).toHaveBeenCalledOnce();
  });

  it("yields to timers while probing many source-retained missing IDs", async () => {
    const composerId = composer(44);
    const orphanBlobs = Array.from({ length: 65 }, (_, index) =>
      agentBlob(`orphan-yield-${index}`),
    );
    const byKey = new Map(
      orphanBlobs.map((blob) => [
        blob.row.key,
        Buffer.from(blob.row.valueBase64, "base64"),
      ]),
    );
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 1),
      schemaVersion: 2,
      agentKv: payload(
        [],
        orphanBlobs.map((blob) => blob.id),
        orphanBlobs.map((blob) => blob.id),
      ),
    };
    const database = fakeAgentKvDatabase(
      (key) => {
        const bytes = byKey.get(String(key));
        return bytes === undefined
          ? undefined
          : { key, valueType: "blob", valueBytes: bytes.byteLength };
      },
      (key) => {
        const bytes = byKey.get(String(key));
        return bytes === undefined
          ? undefined
          : { key, value: bytes, valueType: "blob" };
      },
    );
    const yielded = vi.spyOn(globalThis, "setImmediate");
    try {
      const result = await chatEnrichmentTesting.collectLiveAgentKv(
        database,
        source,
        {
          sourceContentBytes: canonicalBytes(source).byteLength,
          maxPayloadBytes: 4 * 1024 * 1024,
        },
      );

      expect(result?.agentKv?.blobs).toHaveLength(65);
      expect(result?.agentKv?.missingIds).toEqual([]);
      expect(yielded).toHaveBeenCalled();
    } finally {
      yielded.mockRestore();
    }
  });

  it("prunes proven-absent orphans in bounded passes without starving an unprobed tail blob", async () => {
    const repository = await createRepository();
    const composerId = composer(68);
    const orphans = Array.from({ length: 4_098 }, (_, index) =>
      agentBlob(`bounded-orphan-${index}`),
    ).sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    const tailBlob = orphans.at(-1);
    if (tailBlob === undefined) {
      throw new Error("Missing tail blob fixture");
    }
    const missingIds = orphans.map((blob) => blob.id);
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 1),
      schemaVersion: 2,
      agentKv: {
        blobs: [],
        referencedIds: missingIds,
        missingIds,
      },
    };
    await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 0,
      agentKvReferencedCount: missingIds.length,
      agentKvMissingCount: missingIds.length,
      syncOrigin: "auto-merge",
    });
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    const databasePath = join(root, "bounded-orphan-tail.vscdb");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)",
      );
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(
          tailBlob.row.key,
          Buffer.from(tailBlob.row.valueBase64, "base64"),
        );
    } finally {
      database.close();
    }

    const first = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
      },
    );

    expect(first).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);
    const partialTip = onlyTip(repository, `chat/${composerId}`);
    expect(partialTip.metadata).toMatchObject({
      agentKvBlobCount: 0,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 2,
      agentKvEnrichmentAppliesCore: false,
    });
    const partial = parsePortableChatSnapshot(
      (await repository.readVersion(partialTip.versionId)).content ??
        Buffer.alloc(0),
    );
    expect(isPortableChatSnapshotV2(partial) && partial.agentKv.missingIds).toEqual(
      missingIds.slice(4_096),
    );

    const second = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: first.cursor,
        maxPayloadBytes: repository.maxPayloadBytes,
      },
    );

    expect(second).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);
    const completeTip = onlyTip(repository, `chat/${composerId}`);
    expect(completeTip.metadata).toMatchObject({
      agentKvBlobCount: 1,
      agentKvReferencedCount: 1,
      agentKvMissingCount: 0,
      agentKvEnrichmentAppliesCore: true,
    });
    const complete = parsePortableChatSnapshot(
      (await repository.readVersion(completeTip.versionId)).content ??
        Buffer.alloc(0),
    );
    expect(isPortableChatSnapshotV2(complete) && complete.agentKv).toEqual(
      payload([tailBlob], [], [tailBlob.id]),
    );
  });

  it("enriches the repository tip even when the live DB has no copy of its core", async () => {
    const repository = await createRepository();
    const composerId = composer(33);
    const blob = agentBlob("content-addressed-live-row");
    const source = legacyChat(composerId, 5);
    // Only the repository's fifth bubble carries this root. The live database
    // below intentionally contains no composerData/header/bubble rows at all,
    // which is stronger than the measured A115/B111 pruning mismatch.
    source.bubbles[4] = row(
      `bubbleId:${composerId}:bubble-4`,
      JSON.stringify({ conversationState: serializedRoot(blob.id) }),
    );
    await publishChat(repository, source);
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    const databasePath = join(root, "state.vscdb");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)",
      );
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(blob.row.key, Buffer.from(blob.row.valueBase64, "base64"));
    } finally {
      database.close();
    }

    const result = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      databasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: new Map(),
      },
    );

    expect(result.published).toBe(1);
    await reconcile(repository);
    const tip = onlyTip(repository, `chat/${composerId}`);
    const enriched = parsePortableChatSnapshot(
      (await repository.readVersion(tip.versionId)).content ?? Buffer.alloc(0),
    );
    expect(isPortableChatSnapshotV2(enriched)).toBe(true);
    expect(core(enriched)).toEqual(core(source));
    expect(isPortableChatSnapshotV2(enriched) && enriched.agentKv.blobs).toHaveLength(
      1,
    );
  });

  it("runs enrichment inside a normal manager cycle and queues blob-only apply", async () => {
    const repository = await createRepository();
    const composerId = composer(34);
    const blob = agentBlob("manager-cycle-agent-blob");
    const source = legacyChat(composerId, 4);
    source.composerData = row(
      `composerData:${composerId}`,
      JSON.stringify({ conversationState: serializedRoot(blob.id) }),
    );
    await publishChat(repository, source);
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    const databasePath = join(root, "manager-state.vscdb");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)",
      );
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(blob.row.key, Buffer.from(blob.row.valueBase64, "base64"));
    } finally {
      database.close();
    }
    const extensionStorage = join(root, "manager-storage");
    await mkdir(extensionStorage, { recursive: true });
    const statusLog = vi.fn();
    const status = {
      log: statusLog,
      setStatus: vi.fn(),
    } as unknown as StatusController;
    const manager = new SyncManager(
      {} as never,
      {
        globalDatabase: databasePath,
        extensionStorage,
        helperScript: join(root, "helper.js"),
      } as unknown as CursorPaths,
      compatibility("0.0.63", "3.15.6", "1.125.0"),
      {
        gitSync: false,
        enabled: true,
        syncChat: true,
        syncWorkspaceStorage: false,
        maxPayloadBytes: repository.maxPayloadBytes,
        autoApplyFiles: false,
        applyOnShutdown: false,
        effectiveIgnoredWorkspaces: [],
      } as unknown as ExtensionConfiguration,
      status,
      {} as ConflictController,
    );
    const adapter: ResourceAdapter = {
      id: "test-chat",
      kinds: ["chat"],
      appliesWhileRunning: false,
      scan: async () => ({
        snapshots: [],
        deletions: [],
        warnings: [],
      }),
      apply: async () => {
        throw new Error("offline-only adapter must not apply while running");
      },
    };
    const internals = manager as unknown as {
      repository: SyncRepository;
      adapters: ResourceAdapter[];
      performSync(manual: boolean, scope: "all"): Promise<void>;
    };
    internals.repository = repository;
    internals.adapters = [adapter];
    try {
      await internals.performSync(false, "all");
      const tip = onlyTip(repository, `chat/${composerId}`);
      expect(tip.metadata?.syncOrigin).toBe("agent-kv-enrichment");
      expect(repository.state.pendingDatabaseChanges).toEqual([
        expect.objectContaining({
          resourceId: `chat/${composerId}`,
          eventHash: tip.eventHash,
          changeIndex: tip.changeIndex,
        }),
      ]);
      expect(statusLog).not.toHaveBeenCalledWith(
        expect.stringContaining("offline-only adapter"),
      );
    } finally {
      await manager.shutdown();
    }
  });

  it("continues a manual enrichment batch on later automatic cycles", async () => {
    const repository = await createRepository();
    const chats = Array.from({ length: 5 }, (_, index) => {
      const composerId = composer(370 + index);
      const blob = agentBlob(`manager-resume-agent-blob-${index}`);
      const source = legacyChat(composerId, 1);
      source.composerData = row(
        `composerData:${composerId}`,
        JSON.stringify({ conversationState: serializedRoot(blob.id) }),
      );
      return { composerId, blob, source };
    });
    for (const { source } of chats) {
      await publishChat(repository, source);
    }
    const root = temporaryRoots.at(-1);
    if (root === undefined) {
      throw new Error("Missing temporary root");
    }
    const databasePath = join(root, "manager-resume-state.vscdb");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)",
      );
      const insert = database.prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
      );
      for (const { blob } of chats) {
        insert.run(blob.row.key, Buffer.from(blob.row.valueBase64, "base64"));
      }
    } finally {
      database.close();
    }
    const extensionStorage = join(root, "manager-resume-storage");
    await mkdir(extensionStorage, { recursive: true });
    const manager = new SyncManager(
      {} as never,
      {
        globalDatabase: databasePath,
        extensionStorage,
        helperScript: join(root, "helper.js"),
      } as unknown as CursorPaths,
      compatibility("0.0.63", "3.15.6", "1.125.0"),
      {
        gitSync: false,
        enabled: true,
        syncChat: true,
        syncWorkspaceStorage: false,
        maxPayloadBytes: repository.maxPayloadBytes,
        autoApplyFiles: false,
        applyOnShutdown: false,
        effectiveIgnoredWorkspaces: [],
      } as unknown as ExtensionConfiguration,
      {
        log: vi.fn(),
        setStatus: vi.fn(),
      } as unknown as StatusController,
      {} as ConflictController,
    );
    const adapter: ResourceAdapter = {
      id: "test-chat-resume",
      kinds: ["chat"],
      appliesWhileRunning: false,
      scan: async () => ({
        snapshots: [],
        deletions: [],
        warnings: [],
      }),
      apply: async () => {
        throw new Error("offline-only adapter must not apply while running");
      },
    };
    const internals = manager as unknown as {
      repository: SyncRepository;
      adapters: ResourceAdapter[];
      performSync(manual: boolean, scope: "all"): Promise<void>;
    };
    internals.repository = repository;
    internals.adapters = [adapter];
    const enrichedCount = (): number =>
      chats.filter(
        ({ composerId }) =>
          onlyTip(repository, `chat/${composerId}`).metadata?.syncOrigin ===
          "agent-kv-enrichment",
      ).length;

    try {
      await internals.performSync(true, "all");
      expect(enrichedCount()).toBe(2);

      await internals.performSync(false, "all");
      expect(enrichedCount()).toBe(4);

      await internals.performSync(false, "all");
      expect(enrichedCount()).toBe(5);
      for (const { composerId } of chats) {
        expect(onlyTip(repository, `chat/${composerId}`).metadata).toMatchObject({
          chatSnapshotSchemaVersion: 2,
          agentKvMissingCount: 0,
          agentKvEnrichmentAppliesCore: true,
        });
      }
    } finally {
      await manager.shutdown();
    }
  });

  it("refuses a collector result that drops existing v2 graph data", async () => {
    const repository = await createRepository();
    const composerId = composer(31);
    const retained = agentBlob("must-stay");
    const missing = agentBlob("was-missing");
    const added = agentBlob("new-but-not-at-the-cost-of-old");
    const source: PortableChatSnapshotV2 = {
      ...legacyChat(composerId, 2),
      schemaVersion: 2,
      agentKv: payload(
        [retained],
        [missing.id],
        [retained.id, missing.id],
      ),
    };
    const oldTip = await publishChat(repository, source, {
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 1,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 1,
    });

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        // Adds one valid blob but maliciously/incorrectly drops both the
        // source materialized blob and the old unresolved reference.
        agentKv: payload([added], [], [added.id]),
      }),
    });

    expect(result.published).toBe(0);
    expect(result.warnings[0]).toContain(
      "pruned without exact absence proof",
    );
    expect(onlyTip(repository, `chat/${composerId}`).versionId).toBe(
      oldTip.versionId,
    );
  });

  it("drops a prepared enrichment when a newer repository tip wins the race", async () => {
    const repository = await createRepository();
    const composerId = composer(4);
    const resourceId = `chat/${composerId}`;
    const oldTip = await publishChat(repository, legacyChat(composerId, 2));
    const blob = agentBlob("race-blob");
    let newerVersionId = "";

    const result = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: async () => ({
        agentKv: payload([blob], [], [blob.id]),
      }),
      beforePublish: async () => {
        const newer = legacyChat(composerId, 6);
        const published = await repository.publish(
          [snapshot(newer, [oldTip.versionId])],
          [],
        );
        newerVersionId = `${published.eventHash ?? ""}#0`;
        await reconcile(repository);
      },
    });

    expect(result.published).toBe(0);
    expect(onlyTip(repository, resourceId).versionId).toBe(newerVersionId);
    expect((await repository.listEvents()).at(-1)?.manifest.changes[0]?.metadata)
      .not.toMatchObject({ syncOrigin: "agent-kv-enrichment" });
  });

  it("starts with recent chats, then advances fairly through the stable priority order", async () => {
    const repository = await createRepository();
    const updatedAt: readonly JsonValue[] = [
      null,
      "not-a-timestamp",
      10,
      20,
      20,
      10_000,
    ];
    for (let index = 1; index <= updatedAt.length; index += 1) {
      await publishChat(repository, legacyChat(composer(index), 1), {
        lastUpdatedAt: updatedAt[index - 1]!,
      });
    }
    const inspected: string[] = [];
    const collect = async (snapshot: PortableChatSnapshot) => {
      inspected.push(snapshot.composerId);
      return null;
    };
    const first = await enrichCurrentChatTips(repository, {
      cursor: initialCursor(),
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      batchSize: 99,
    });
    const second = await enrichCurrentChatTips(repository, {
      cursor: first.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      batchSize: 99,
    });
    const third = await enrichCurrentChatTips(repository, {
      cursor: second.cursor,
      maxPayloadBytes: repository.maxPayloadBytes,
      collectAgentKv: collect,
      batchSize: 99,
    });

    expect(first.attempted).toBe(2);
    expect(second.attempted).toBe(2);
    expect(third.attempted).toBe(2);
    // The newest chat sorts ahead of five lexicographically earlier tips.
    // Equal valid timestamps use the resource ID, and null/invalid metadata
    // remain deterministic at the end instead of blocking fair progress.
    expect(inspected).toEqual([
      composer(6),
      composer(4),
      composer(5),
      composer(3),
      composer(1),
      composer(2),
    ]);
  });

  it(
    "indexes a large stable tip graph once and pages no-op candidate checks",
    () => {
      const tips: Record<string, ResourceTip[]> = {};
      const tip = (index: number, complete: boolean): ResourceTip => ({
        versionId: `version-${index}`,
        eventHash: `event-${index}`,
        changeIndex: 0,
        kind: "chat",
        lamport: index + 1,
        deviceId: "device-a",
        operation: "put",
        semanticHash: `semantic-${index}`,
        payload: {
          deviceId: "device-a",
          objectId: `object-${index}`,
          compressedBytes: 1,
          plainBytes: 1,
        },
        parents: [],
        metadata: complete
          ? {
              chatSnapshotSchemaVersion: 2,
              agentKvMissingCount: 0,
            }
          : { lastUpdatedAt: index },
      });
      for (let index = 0; index < 100_000; index += 1) {
        tips[`chat/complete-${index}`] = [tip(index, true)];
      }
      // Only actual migration candidates are retained. A mature 100k-chat
      // repository therefore adds no second full-resource structure.
      expect(buildChatTipEnrichmentCandidateIndex(tips)).toEqual([]);

      const candidates = Array.from({ length: 10_000 }, (_, index) => ({
        resourceId: `chat/legacy-${index}`,
        tip: tip(index, false),
        expectedTipIds: [`version-${index}`],
      }));
      const inspected: string[] = [];
      const first =
        chatEnrichmentTesting.selectIndexedChatTipEnrichmentCandidates(
          candidates,
          initialCursor(),
          7,
          2,
          (candidate) => {
            inspected.push(candidate.resourceId);
            return false;
          },
        );
      expect(first.candidates).toEqual([]);
      expect(inspected).toHaveLength(
        CHAT_TIP_ENRICHMENT_CANDIDATE_PROBES_PER_CYCLE,
      );
      const secondInspected: string[] = [];
      chatEnrichmentTesting.selectIndexedChatTipEnrichmentCandidates(
        candidates,
        first.cursor,
        7,
        2,
        (candidate) => {
          secondInspected.push(candidate.resourceId);
          return false;
        },
      );
      expect(secondInspected).toHaveLength(
        CHAT_TIP_ENRICHMENT_CANDIDATE_PROBES_PER_CYCLE,
      );
      expect(secondInspected[0]).not.toBe(inspected[0]);
    },
    20_000,
  );

  it("keeps the v2 extension gate while retaining the source core's Cursor gate", () => {
    const original: EventProducer = {
      extensionVersion: "0.0.62",
      cursorVersion: "3.16.0",
      vscodeVersion: "1.126.0",
    };
    const tip = {
      kind: "chat",
      operation: "put",
      producer: PRODUCER,
      metadata: {
        syncOrigin: "agent-kv-enrichment",
        originalProducer: original,
      },
    } as unknown as ResourceTip;
    const effective = effectiveTipProducer(tip);

    expect(effective).toEqual({
      extensionVersion: "0.0.63",
      cursorVersion: "3.16.0",
      vscodeVersion: "1.126.0",
    });
    expect(
      databaseApplyBlockReason("chat", effective, compatibility("0.0.62", "3.16.0", "1.126.0")),
    ).toContain("newer extension 0.0.63");
    expect(
      databaseApplyBlockReason("chat", effective, compatibility("0.0.63", "3.15.6", "1.126.0")),
    ).toContain("newer Cursor 3.16.0");

    const checkpointed = effectiveTipProducer({
      ...tip,
      producer: {
        extensionVersion: "0.0.63",
        cursorVersion: "3.15.6",
        vscodeVersion: "1.126.0",
      },
      metadata: {
        ...tip.metadata,
        syncOrigin: "checkpoint-marker",
        checkpointedSyncOrigin: "agent-kv-enrichment",
      },
    });
    expect(checkpointed).toEqual({
      extensionVersion: "0.0.63",
      cursorVersion: "3.16.0",
      vscodeVersion: "1.126.0",
    });
  });
});

function initialCursor(): ChatTipEnrichmentCursor {
  return { afterResourceId: null };
}

function fakeAgentKvDatabase(
  metadataGet: (...parameters: unknown[]) => unknown,
  valueGet: (...parameters: unknown[]) => unknown,
): DatabaseSync {
  return {
    prepare: (sql: string) => {
      if (sql.includes("AS valueBytes")) {
        return { get: metadataGet };
      }
      if (sql.includes("SELECT key, value")) {
        return { get: valueGet };
      }
      throw new Error(`Unexpected agentKv query: ${sql}`);
    },
  } as unknown as DatabaseSync;
}

function composer(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function legacyChat(
  composerId: string,
  bubbleCount: number,
): PortableChatSnapshotV1 {
  return {
    schemaVersion: 1,
    composerId,
    header: {
      composerId,
      workspaceId: null,
      createdAt: 1,
      lastUpdatedAt: 2,
      isArchived: 0,
      isSubagent: 0,
      recency: 3,
      checkpointAt: null,
      value: "repository core",
    },
    composerData: row(`composerData:${composerId}`, "composer-data"),
    bubbles: Array.from({ length: bubbleCount }, (_, index) =>
      row(`bubbleId:${composerId}:bubble-${index}`, `bubble-${index}`),
    ),
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

function row(key: string, text: string): PortableKvRow {
  return {
    key,
    valueBase64: Buffer.from(text, "utf8").toString("base64"),
    valueType: "text",
  };
}

function agentBlob(text: string): { id: string; row: PortableKvRow } {
  return agentBlobFromBytes(Buffer.from(text, "utf8"));
}

function agentBlobFromBytes(bytes: Buffer): { id: string; row: PortableKvRow } {
  const id = sha256(bytes);
  return {
    id,
    row: {
      key: `agentKv:blob:${id}`,
      valueBase64: bytes.toString("base64"),
      valueType: "blob",
    },
  };
}

function agentStepBlob(text: string): { id: string; row: PortableKvRow } {
  const bytes = protobufBytesField(
    1,
    protobufBytesField(1, Buffer.from(text, "utf8")),
  );
  const id = sha256(bytes);
  return {
    id,
    row: {
      key: `agentKv:blob:${id}`,
      valueBase64: bytes.toString("base64"),
      valueType: "blob",
    },
  };
}

function agentBlobLinking(id: string): { id: string; row: PortableKvRow } {
  const bytes = protobufBytesField(
    1,
    protobufBytesField(2, Buffer.from(id, "hex")),
  );
  const blobId = sha256(bytes);
  return {
    id: blobId,
    row: {
      key: `agentKv:blob:${blobId}`,
      valueBase64: bytes.toString("base64"),
      valueType: "blob",
    },
  };
}

function serializedRoot(id: string): string {
  return `~${protobufBytesField(1, Buffer.from(id, "hex")).toString("base64")}`;
}

function serializedTurnRoot(id: string): string {
  return `~${protobufBytesField(8, Buffer.from(id, "hex")).toString("base64")}`;
}

function protobufBytesField(
  fieldNumber: number,
  payloadBytes: Uint8Array,
): Buffer {
  return Buffer.concat([
    protobufVarint(BigInt(fieldNumber * 8 + 2)),
    protobufVarint(BigInt(payloadBytes.byteLength)),
    Buffer.from(payloadBytes),
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

function payload(
  blobs: readonly { id: string; row: PortableKvRow }[],
  missingIds: readonly string[],
  referencedIds: readonly string[],
): PortableAgentKvPayload {
  return {
    blobs: blobs.map(({ row: value }) => value).sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    ),
    missingIds: [...missingIds].sort(),
    referencedIds: [...referencedIds].sort(),
  };
}

async function createRepository(): Promise<SyncRepository> {
  const root = await mkdtemp(join(tmpdir(), "cursor-chat-enrichment-"));
  temporaryRoots.push(root);
  return SyncRepository.create(
    join(root, "repository"),
    join(root, "storage"),
    PASSPHRASE,
    4 * 1024 * 1024,
    PRODUCER,
  );
}

async function publishChat(
  repository: SyncRepository,
  chat: PortableChatSnapshot,
  metadata: Record<string, JsonValue> = {},
): Promise<ResourceTip> {
  await repository.publish(
    [
      {
        ...snapshot(chat, []),
        metadata: {
          composerId: chat.composerId,
          bubbleCount: chat.bubbles.length,
          ...metadata,
        },
      },
    ],
    [],
  );
  await reconcile(repository);
  return onlyTip(repository, `chat/${chat.composerId}`);
}

function snapshot(
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
  new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  );
}

function onlyTip(repository: SyncRepository, resourceId: string): ResourceTip {
  const tips = repository.state.tips[resourceId] ?? [];
  expect(tips).toHaveLength(1);
  const tip = tips[0];
  if (tip === undefined) {
    throw new Error(`Missing tip for ${resourceId}`);
  }
  return tip;
}

function compatibility(
  extensionVersion: string,
  cursorVersion: string,
  vscodeVersion: string,
): CompatibilityReport {
  return {
    compatible: true,
    extensionVersion,
    cursorVersion,
    vscodeVersion,
    nodeVersion: process.version,
    sqliteAvailable: true,
    sqliteBackupAvailable: true,
    globalDatabasePath: "state.vscdb",
    databaseCapabilities: {
      "global-item-table": { available: true, reasons: [] },
      "global-chat": { available: true, reasons: [] },
      "sqlite-files": { available: true, reasons: [] },
    },
    reasons: [],
    warnings: [],
  };
}
