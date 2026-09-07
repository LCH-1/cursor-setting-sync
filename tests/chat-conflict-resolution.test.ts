import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareChatConflictResolution } from "../src/chat/conflictResolution";
import { mergeChatSnapshotBuffers } from "../src/chat/chatMerge";
import { verifyPortableChatContinuationClosure } from "../src/chat/continuationClosure";
import { parsePortableChatSnapshot, portableChatCoreHash, type PortableChatSnapshot, type PortableChatSnapshotV1, type PortableChatSnapshotV2 } from "../src/chat/stateVscdb";
import { mergeOfflineChatConflicts } from "../src/helper/chatConflictMerge";
import type { HelperRequest } from "../src/helper/types";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import type { JsonValue, ResourceTip, SyncConflict } from "../src/types";

const roots: string[] = [];
const producer = { extensionVersion: "1.0.6", cursorVersion: "3.11.19", vscodeVersion: "1.125.0" };
const options = { offline: true, tipsAllowed: () => true };
const id = "62626262-6262-4262-8262-626262626262";
const resourceId = `chat/${id}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("the shared chat merge and latest policy", () => {
  it("publishes a complete novel union before considering latest fallback", async () => {
    const repository = await fixture();
    const first = chat("shared");
    const second = chat("shared");
    first.bubbles.push(row("extra-a", { text: "retained A" }));
    second.bubbles.push(row("extra-b", { text: "retained B" }));
    await publish(repository, first);
    await publish(repository, second);
    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);
    expect(result?.metadata?.chatResolutionStrategy).toBe("merged");
    expect(parsePortableChatSnapshot(result!.content).bubbles).toHaveLength(3);
    expect(result!.content.equals(canonicalBytes(first))).toBe(false);
    expect(result!.content.equals(canonicalBytes(second))).toBe(false);
    expect(result?.parents).toHaveLength(2);
    expect(result?.metadata?.chatCoreHash).toBe(portableChatCoreHash(parsePortableChatSnapshot(result!.content)));
  });

  it.each([false, true])("retains exact latest bytes despite wall-clock skew (offline %s)", async (offline) => {
    const repository = await fixture();
    await publish(repository, chat("older authored message", 9_999_999));
    const latest = chat("newest authored message", 1);
    const latestTip = await publish(repository, latest);
    const result = await prepareChatConflictResolution(repository, await conflict(repository), { ...options, offline });
    expect(result?.metadata?.chatResolutionStrategy).toBe("latest");
    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(result?.metadata?.chatResolutionOrigin).toMatchObject({ versionId: latestTip.versionId, lamport: latestTip.lamport });
  });

  it.each(["auto-merge", "agent-kv-enrichment"])("does not let later %s bookkeeping outrank a newer authored version", async (origin) => {
    const repository = await fixture();
    const old = chat("old authored message");
    const original = await publish(repository, old);
    const latest = chat("new authored message");
    const newest = await publish(repository, latest);
    await publish(repository, old, [original.versionId], { syncOrigin: origin,
      ...(origin === "agent-kv-enrichment" ? { agentKvEnrichmentAppliesCore: true,
        enrichedFromVersionId: original.versionId, originalProducer: producer } : {}) });
    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);
    expect(result?.metadata?.chatResolutionStrategy).toBe("latest");
    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(result?.metadata?.chatResolutionOrigin).toMatchObject({ versionId: newest.versionId, lamport: newest.lamport });
  });

  it.each([false, true])("does not promote a legacy merge through an unchanged losing parent (upgraded envelope %s)", async (upgradedEnvelope) => {
    const repository = await fixture();
    const base = chat("base");
    const baseTip = await publish(repository, base);
    const old = chat("earlier actual edit");
    const { agentKv: _agentKv, ...legacyCore } = old;
    void _agentKv;
    const oldCapture: PortableChatSnapshot = upgradedEnvelope
      ? { ...legacyCore, schemaVersion: 1 }
      : old;
    const original = await publish(repository, oldCapture, [baseTip.versionId]);
    const latest = chat("later actual edit");
    const newest = await publish(repository, latest, [baseTip.versionId]);
    const unchanged = await publish(repository, base, [baseTip.versionId]);
    const legacyMerge = mergeChatSnapshotBuffers(
      canonicalBytes(base),
      [canonicalBytes(base), canonicalBytes(oldCapture)],
    );
    expect(legacyMerge.status).toBe("merged");
    expect(portableChatCoreHash(parsePortableChatSnapshot(legacyMerge.content!))).toBe(portableChatCoreHash(oldCapture));
    expect(legacyMerge.content!.equals(canonicalBytes(oldCapture))).toBe(!upgradedEnvelope);
    await publish(repository, parsePortableChatSnapshot(legacyMerge.content!),
      [original.versionId, unchanged.versionId], { syncOrigin: "auto-merge" });

    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);

    expect(result?.metadata?.chatResolutionStrategy).toBe("latest");
    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(result?.metadata?.chatResolutionOrigin).toMatchObject({
      versionId: newest.versionId,
      lamport: newest.lamport,
    });
  });

  it("records the exact survivor's origin when an unchanged newer capture contributes nothing", async () => {
    const repository = await fixture();
    const base = chat("base");
    const baseTip = await publish(repository, base);
    const edited = chat("actual edit");
    const editedTip = await publish(repository, edited, [baseTip.versionId]);
    await publish(repository, base, [baseTip.versionId]);

    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);

    expect(result?.metadata?.chatResolutionStrategy).toBe("merged");
    expect(result?.content.equals(canonicalBytes(edited))).toBe(true);
    expect(result?.metadata?.chatResolutionOrigin).toMatchObject({
      versionId: editedTip.versionId,
      lamport: editedTip.lamport,
    });
  });

  it.each([[false, true], [false, false], [true, true]] as const)("keeps original latest ordering after pruning twice and receiving an offline peer fork (resolved source %s, known core %s)", async (resolvedSource, knownCore) => {
    const repository = await fixture();
    const old = chat("older capture");
    const original = await publish(repository, old, [], knownCore ? {} : { chatCoreHash: null });
    const offlineRoot = await mkdtemp(join(tmpdir(), "chat-resolution-offline-"));
    roots.push(offlineRoot);
    await cp(repository.root, join(offlineRoot, "repo"), { recursive: true });
    const peer = await SyncRepository.open(join(offlineRoot, "repo"), join(offlineRoot, "storage"),
      "sufficiently long conflict policy passphrase", 128 * 1024 * 1024, producer);
    new EventReconciler().reconcile(await peer.listEvents(), peer.state, null);
    const latest = chat("later offline authored capture");
    const latestTip = await publish(peer, latest, [original.versionId]);
    if (resolvedSource) {
      await publish(repository, old, [original.versionId], { syncOrigin: "auto-merge",
        chatResolutionCoreHash: portableChatCoreHash(old),
        chatResolutionOrigin: { versionId: original.versionId, eventHash: original.eventHash,
          lamport: original.lamport, deviceId: original.deviceId } });
    }
    for (let pass = 0; pass < 2; pass += 1) {
      await repository.refreshState();
      const checkpoint = await repository.loadAbsorbedCheckpointManifest();
      new EventReconciler().reconcile(await repository.listReconciliationEvents(checkpoint), repository.state, checkpoint);
      await repository.createCheckpoint(true);
      expect((await repository.pruneWithGates({ reconciledWithoutWarnings: true, overrideAgeGate: true })).status).toBe("pruned");
    }
    expect(await repository.tryReadVersionMetadata(original.versionId)).toBeNull();
    await cp(join(peer.root, "devices", peer.state.device.deviceId),
      join(repository.root, "devices", peer.state.device.deviceId), { recursive: true });
    await repository.refreshState();
    const checkpoint = await repository.loadAbsorbedCheckpointManifest();
    const current = new EventReconciler().reconcile(await repository.listReconciliationEvents(checkpoint), repository.state, checkpoint);
    expect(current.warnings).toEqual([]);
    expect(repository.state.tips[resourceId]!.some(tip => tip.lamport > latestTip.lamport)).toBe(true);

    const result = await prepareChatConflictResolution(repository, current.conflicts[0]!, options);

    expect(result?.metadata?.chatResolutionStrategy).toBe("latest");
    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(result?.metadata?.chatResolutionOrigin).toMatchObject({ versionId: latestTip.versionId, lamport: latestTip.lamport });
  });

  it("preserves the exact partial blob-only contract when it contains the latest core", async () => {
    const repository = await fixture();
    const complete = chat("same local core");
    const { agentKv: _agentKv, ...core } = complete;
    void _agentKv;
    const legacy = { ...core, schemaVersion: 1 as const };
    const original = await publish(repository, legacy);
    const partial = { ...complete, agentKv: { blobs: [], referencedIds: ["a".repeat(64)], missingIds: ["a".repeat(64)] } };
    await publish(repository, partial, [original.versionId], { syncOrigin: "agent-kv-enrichment",
      agentKvEnrichmentAppliesCore: false, enrichedFromVersionId: original.versionId, originalProducer: producer });
    await publish(repository, legacy, [original.versionId]);
    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);
    expect(result?.content.equals(canonicalBytes(partial))).toBe(true);
    expect(result?.metadata).toMatchObject({ syncOrigin: "agent-kv-enrichment", agentKvEnrichmentAppliesCore: false,
      enrichedFromVersionId: original.versionId, agentKvMissingCount: 1 });
  });

  it("resolves more than two distinct forks deterministically and closes every duplicate parent", async () => {
    const repository = await fixture();
    await publish(repository, chat("first"));
    await publish(repository, chat("second"));
    const latest = chat("third");
    await publish(repository, latest);
    await publish(repository, latest);
    const current = await conflict(repository);
    const parents = repository.state.tips[resourceId]!.map(tip => tip.versionId).sort();
    const forward = await prepareChatConflictResolution(repository, current, options);
    repository.state.tips[resourceId]!.reverse();
    const reversed = await prepareChatConflictResolution(repository, current, options);
    expect(forward?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(forward?.parents).toEqual(parents);
    expect(reversed).toEqual(forward);
  });

  it.each(["missing-visible-row", "invalid-json"])("retains the forks when the latest payload has %s", async (problem) => {
    const repository = await fixture();
    await publish(repository, chat("valid older copy"));
    const invalid = chat("invalid latest copy");
    invalid.bubbles = [];
    if (problem === "invalid-json") {
      const content = Buffer.from("{}");
      await repository.publish([{ resourceId, kind: "chat", content, semanticHash: sha256(content), parents: [] }], []);
    } else {
      await publish(repository, invalid);
    }
    const current = await conflict(repository);
    const head = repository.state.ownStreamHead;
    expect(await prepareChatConflictResolution(repository, current, options)).toBeNull();
    expect(repository.state.ownStreamHead).toEqual(head);
    expect(repository.state.tips[resourceId]).toHaveLength(2);
  });

  it.each(["core-hash", "future-ordering"])("does not trust a resolution memo with mismatched %s", async (problem) => {
    const repository = await fixture();
    await publish(repository, chat("older version"));
    const latest = chat("latest version");
    const original = await publish(repository, latest);
    const metadata = { syncOrigin: "auto-merge", chatResolutionStrategy: "latest",
      chatResolutionCoreHash: problem === "core-hash" ? "0".repeat(64) : portableChatCoreHash(latest),
      chatResolutionOrigin: { versionId: original.versionId, eventHash: original.eventHash,
        deviceId: original.deviceId, lamport: problem === "future-ordering" ? original.lamport + 100 : original.lamport } };
    await publish(repository, latest, [original.versionId], metadata);
    expect(await prepareChatConflictResolution(repository, await conflict(repository), options)).toBeNull();
    expect(repository.state.tips[resourceId]).toHaveLength(2);
  });

  it.each(["invalid", "unknown"] as const)("retains forks when the latest continuation graph is %s", async (status) => {
    const repository = await fixture();
    await publish(repository, chat("valid older copy"));
    const latest = chat("latest copy with an unreadable graph");
    const state = status === "invalid"
      ? `~${Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from("a".repeat(64), "hex")]).toString("base64")}`
      : "~not-canonical-base64";
    latest.composerData.valueBase64 = Buffer.from(JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "active" }], conversationState: state,
    })).toString("base64");
    expect((await verifyPortableChatContinuationClosure(latest)).status).toBe(status);
    await publish(repository, latest);
    const current = await conflict(repository);
    const head = repository.state.ownStreamHead;

    expect(await prepareChatConflictResolution(repository, current, options)).toBeNull();
    expect(repository.state.ownStreamHead).toEqual(head);
    expect(repository.state.tips[resourceId]).toHaveLength(2);
  });

  it("retains a valid latest payload when an older fork is malformed", async () => {
    const repository = await fixture();
    const malformed = Buffer.from("{}");
    await repository.publish([{ resourceId, kind: "chat", content: malformed,
      semanticHash: sha256(malformed), parents: [] }], []);
    const latest = chat("valid latest copy");
    const selected = await publish(repository, latest);

    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);

    expect(result?.metadata?.chatResolutionStrategy).toBe("latest");
    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(result?.metadata?.chatResolutionOrigin).toMatchObject({ versionId: selected.versionId });
    expect(result?.parents).toHaveLength(2);
  });

  it("retains a valid latest payload when an older fork cannot be authenticated or decrypted", async () => {
    const repository = await fixture();
    const olderTip = await publish(repository, chat("older unavailable payload"));
    const latest = chat("valid latest authored copy");
    const selected = await publish(repository, latest);
    const read = repository.tryReadVersion.bind(repository);
    vi.spyOn(repository, "tryReadVersion").mockImplementation(async version => {
      if (version === olderTip.versionId) {
        throw new Error("simulated source decryption failure");
      }
      return read(version);
    });

    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);

    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(result?.metadata).toMatchObject({ chatResolutionStrategy: "latest",
      chatResolutionOrigin: { versionId: selected.versionId } });
    expect(result?.parents).toHaveLength(2);
  });

  it("rejects incompatible tips before reading authenticated metadata or payloads", async () => {
    const repository = await fixture();
    await publish(repository, chat("first"));
    await publish(repository, chat("second"));
    const current = await conflict(repository);
    const metadata = vi.spyOn(repository, "tryReadVersionMetadata");
    const body = vi.spyOn(repository, "tryReadVersion");
    expect(await prepareChatConflictResolution(repository, current, { ...options, tipsAllowed: () => false })).toBeNull();
    expect(metadata).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });

  it.each([false, true])("preflights the individual payload limit before reads (offline %s)", async (offline) => {
    const repository = await fixture();
    await publish(repository, chat("first"));
    await publish(repository, chat("second"));
    const current = await conflict(repository);
    repository.setMaxPayloadBytes(100);
    const body = vi.spyOn(repository, "tryReadVersion");
    expect(await prepareChatConflictResolution(repository, current, { ...options, offline })).toBeNull();
    expect(body).not.toHaveBeenCalled();
  });

  it("defers aggregate overflow online and reads only the latest candidate offline", async () => {
    const repository = await fixture();
    const base = await publish(repository, chat("base"));
    await publish(repository, chat("first"), [base.versionId]);
    const latest = chat("second");
    const selected = await publish(repository, latest, [base.versionId]);
    const current = await conflict(repository);
    const readMetadata = repository.tryReadVersionMetadata.bind(repository);
    vi.spyOn(repository, "tryReadVersionMetadata").mockImplementation(async version => {
      const value = (await readMetadata(version))!;
      return version === selected.versionId ? value : { ...value,
        change: { ...value.change, payload: { ...value.change.payload!, plainBytes: 128 * 1024 * 1024 } } };
    });
    const body = vi.spyOn(repository, "tryReadVersion");
    expect(await prepareChatConflictResolution(repository, current, { ...options, offline: false })).toBeNull();
    expect(body).not.toHaveBeenCalled();
    const result = await prepareChatConflictResolution(repository, current, options);
    expect(result?.metadata?.chatResolutionStrategy).toBe("latest");
    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(body.mock.calls).toEqual([[selected.versionId]]);
    expect(result?.parents).toHaveLength(2);
  });

  it("continues resolving other chats after one authenticated source read fails", async () => {
    const repository = await fixture();
    await publish(repository, chat("bad first"));
    await publish(repository, chat("bad second"));
    const otherId = "63636363-6363-4363-8363-636363636363";
    await publish(repository, chat("healthy first", 2, otherId));
    await publish(repository, chat("healthy second", 2, otherId));
    await conflict(repository);
    const readMetadata = repository.tryReadVersionMetadata.bind(repository);
    vi.spyOn(repository, "tryReadVersionMetadata").mockImplementation(async version => {
      const value = await readMetadata(version);
      if (value?.change.resourceId === resourceId) {
        throw new Error("simulated authenticated source failure");
      }
      return value;
    });
    const request = { extensionVersion: producer.extensionVersion, expectedCursorVersion: producer.cursorVersion,
      expectedVscodeVersion: producer.vscodeVersion } as HelperRequest;
    const result = await mergeOfflineChatConflicts(repository, request, async () => {}, () => {});
    expect(result.published).toBe(1);
    expect(result.warnings.some(warning => warning.includes("simulated authenticated source failure"))).toBe(true);
    expect(repository.state.tips[resourceId]).toHaveLength(2);
    expect(repository.state.tips[`chat/${otherId}`]).toHaveLength(1);
  });

  it("isolates an exhausted origin-history budget and still resolves the next chat", async () => {
    const repository = await fixture();
    const old = chat("old capture behind a long wrapper history");
    let wrapper = await publish(repository, old);
    for (let index = 0; index < 64; index += 1) {
      wrapper = await publish(repository, old, [wrapper.versionId], { syncOrigin: "auto-merge" });
    }
    await publish(repository, chat("unresolved fork"));
    const otherId = "63636363-6363-4363-8363-636363636363";
    await publish(repository, chat("healthy first", 2, otherId));
    const healthyLatest = chat("healthy latest", 2, otherId);
    await publish(repository, healthyLatest);
    await conflict(repository);
    const readMetadata = vi.spyOn(repository, "tryReadVersionMetadata");
    const request = { extensionVersion: producer.extensionVersion, expectedCursorVersion: producer.cursorVersion,
      expectedVscodeVersion: producer.vscodeVersion } as HelperRequest;

    const result = await mergeOfflineChatConflicts(repository, request, async () => {}, () => {});

    expect(result.published).toBe(1);
    expect(result.warnings.some(warning => warning.includes("bounded lookup limit"))).toBe(true);
    expect(repository.state.tips[resourceId]).toHaveLength(2);
    expect(repository.state.tips[`chat/${otherId}`]).toHaveLength(1);
    expect(repository.state.tips[`chat/${otherId}`]![0]!.semanticHash).toBe(sha256(canonicalBytes(healthyLatest)));
    expect(readMetadata.mock.calls.length).toBeLessThanOrEqual(66);
  });
});

describe("completing the latest core from historical continuation blobs", () => {
  it("combines distinct older graphs while keeping every latest core byte and its authored origin", async () => {
    const repository = await fixture();
    const leaf = Buffer.from([0x0a, 0x04, 0x0a, 0x02, 0x6f, 0x6b]);
    const leafId = sha256(leaf);
    const root = Buffer.concat([Buffer.from([0x0a, 0x22, 0x12, 0x20]), Buffer.from(leafId, "hex")]);
    const first = historicalGraph("older branch containing the root", [root]);
    const second = historicalGraph("other older branch containing the leaf", [leaf]);
    const latest = legacyChat("latest authored reply", [sha256(root)], 8);
    latest.header.lastUpdatedAt = 1;
    latest.header.value = JSON.stringify({ name: "latest authored title" });
    await publish(repository, first);
    await publish(repository, second);
    const latestTip = await publish(repository, latest, [], { agentKvBlobCount: 90,
      agentKvReferencedCount: 91, agentKvMissingCount: 92, bubbleCount: 93, title: "stale metadata title" });

    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);

    expect(result).not.toBeNull();
    const selected = parsePortableChatSnapshot(result!.content);
    expect(result?.metadata?.chatResolutionStrategy).toBe("latest");
    expect(selected.schemaVersion).toBe(2);
    if (selected.schemaVersion !== 2) {
      throw new Error("expected the complete latest continuation graph");
    }
    expect(selected.header).toEqual(latest.header);
    expect(selected.composerData).toEqual(latest.composerData);
    expect(selected.bubbles).toEqual(latest.bubbles);
    expect(portableChatCoreHash(selected)).toBe(portableChatCoreHash(latest));
    expect(result?.metadata).toMatchObject({ chatSnapshotSchemaVersion: 2, bubbleCount: 1,
      agentKvBlobCount: 2, agentKvReferencedCount: 2, agentKvMissingCount: 0,
      title: "latest authored title", lastUpdatedAt: 1,
      chatCoreHash: portableChatCoreHash(latest), chatResolutionCoreHash: portableChatCoreHash(latest),
      chatResolutionOrigin: { versionId: latestTip.versionId, lamport: latestTip.lamport } });
    expect(result?.parents).toHaveLength(3);
    await expect(verifyPortableChatContinuationClosure(selected)).resolves.toMatchObject({
      status: "complete", activeReachableCount: 2, activeMaterializedCount: 2 });
  });

  it("keeps the exact latest v1 when historical blobs cannot close its graph", async () => {
    const repository = await fixture();
    const missingLeaf = sha256("unavailable descendant");
    const root = Buffer.concat([Buffer.from([0x0a, 0x22, 0x12, 0x20]), Buffer.from(missingLeaf, "hex")]);
    await publish(repository, historicalGraph("older root-only branch", [root]));
    const latest = legacyChat("latest reply with a missing descendant", [sha256(root)], 8);
    const latestTip = await publish(repository, latest, [], { agentKvBlobCount: 90,
      agentKvReferencedCount: 91, agentKvMissingCount: 92 });

    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);

    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(result?.metadata).toMatchObject({ chatResolutionStrategy: "latest", chatSnapshotSchemaVersion: 1,
      chatCoreHash: portableChatCoreHash(latest), chatResolutionCoreHash: portableChatCoreHash(latest),
      chatResolutionOrigin: { versionId: latestTip.versionId } });
    expect(result?.metadata).not.toHaveProperty("agentKvBlobCount");
    expect(result?.metadata).not.toHaveProperty("agentKvReferencedCount");
    expect(result?.metadata).not.toHaveProperty("agentKvMissingCount");
    expect(result?.parents).toHaveLength(2);
  });

  it("keeps bounded exact latest bytes when complete historical enrichment would exceed the output limit", async () => {
    const repository = await fixture();
    const blobs = [Buffer.alloc(2_048, 0x61), Buffer.alloc(2_048, 0x62)];
    const sources = blobs.map((blob, index) => historicalGraph(`older branch ${index}`, [blob]));
    const latest = legacyChat("latest reply", blobs.map(blob => sha256(blob)));
    for (const source of sources) {
      await publish(repository, source);
    }
    const latestTip = await publish(repository, latest);
    const limit = Math.max(...[...sources, latest].map(snapshot => canonicalBytes(snapshot).byteLength)) + 64;
    const complete: PortableChatSnapshotV2 = { ...latest, schemaVersion: 2, agentKv: {
      blobs: sources.flatMap(source => source.agentKv.blobs),
      referencedIds: blobs.map(blob => sha256(blob)).sort(), missingIds: [] } };
    expect(canonicalBytes(complete).byteLength).toBeGreaterThan(limit);
    await expect(verifyPortableChatContinuationClosure(complete)).resolves.toMatchObject({ status: "complete" });
    repository.setMaxPayloadBytes(limit);

    const result = await prepareChatConflictResolution(repository, await conflict(repository), options);

    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(result!.content.byteLength).toBeLessThanOrEqual(limit);
    expect(result?.metadata).toMatchObject({ chatResolutionStrategy: "latest", chatSnapshotSchemaVersion: 1,
      chatCoreHash: portableChatCoreHash(latest), chatResolutionOrigin: { versionId: latestTip.versionId } });
    expect(result?.metadata).not.toHaveProperty("agentKvBlobCount");
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chat-resolution-"));
  roots.push(root);
  return SyncRepository.create(join(root, "repo"), join(root, "storage"),
    "sufficiently long conflict policy passphrase", 128 * 1024 * 1024, producer);
}

async function conflict(repository: SyncRepository): Promise<SyncConflict> {
  const reconciled = new EventReconciler().reconcile(await repository.listEvents(), repository.state, null);
  return reconciled.conflicts.find(item => item.resourceId === resourceId)!;
}

async function publish(repository: SyncRepository, snapshot: PortableChatSnapshot, parents: string[] = [], metadata: Record<string, JsonValue> = {}): Promise<ResourceTip> {
  const content = canonicalBytes(snapshot);
  const resource = `chat/${snapshot.composerId}`;
  const result = await repository.publish([{ resourceId: resource, kind: "chat", content,
    semanticHash: sha256(content), parents, metadata: { chatSnapshotSchemaVersion: snapshot.schemaVersion,
      chatCoreHash: portableChatCoreHash(snapshot), bubbleCount: snapshot.bubbles.length,
      lastUpdatedAt: snapshot.header.lastUpdatedAt,
      ...(snapshot.schemaVersion === 2 ? { agentKvBlobCount: snapshot.agentKv.blobs.length,
        agentKvReferencedCount: snapshot.agentKv.referencedIds.length, agentKvMissingCount: snapshot.agentKv.missingIds.length } : {}),
      ...metadata } }], []);
  new EventReconciler().reconcile(await repository.listEvents(), repository.state, null);
  return repository.state.tips[resource]!.find(tip => tip.eventHash === result.eventHash)!;
}

function row(bubbleId: string, value: unknown, composerId = id) {
  return { key: `bubbleId:${composerId}:${bubbleId}`, valueType: "text" as const,
    valueBase64: Buffer.from(JSON.stringify(value)).toString("base64") };
}

function chat(text: string, timestamp = 2, composerId = id): PortableChatSnapshotV2 {
  return { schemaVersion: 2, composerId,
    header: { composerId, workspaceId: null, createdAt: 1, lastUpdatedAt: timestamp,
      isArchived: 0, isSubagent: 0, recency: 0, checkpointAt: null, value: JSON.stringify({ name: "shared session" }) },
    composerData: { key: `composerData:${composerId}`, valueType: "text",
      valueBase64: Buffer.from(JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "active" }] })).toString("base64") },
    bubbles: [row("active", { text }, composerId)], agentKv: { blobs: [], referencedIds: [], missingIds: [] } };
}

function historicalGraph(text: string, values: Buffer[]): PortableChatSnapshotV2 {
  return { ...chat(text), agentKv: {
    blobs: values.map(value => ({ key: `agentKv:blob:${sha256(value)}`, valueType: "blob" as const,
      valueBase64: value.toString("base64") })).sort((left, right) => left.key.localeCompare(right.key)),
    referencedIds: values.map(value => sha256(value)).sort(), missingIds: [] } };
}

function legacyChat(text: string, rootIds: string[], field = 1): PortableChatSnapshotV1 {
  const source = chat(text);
  return { schemaVersion: 1, composerId: source.composerId, header: source.header, bubbles: source.bubbles,
    composerData: { ...source.composerData, valueBase64: Buffer.from(JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "active" }],
      conversationState: `~${Buffer.concat(rootIds.map(rootId =>
        Buffer.concat([Buffer.from([field * 8 + 2, 32]), Buffer.from(rootId, "hex")]))).toString("base64")}`,
    })).toString("base64") } };
}
