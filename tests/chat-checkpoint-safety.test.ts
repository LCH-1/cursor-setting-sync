import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as checkpointSafety from "../src/chat/checkpointSafety";
import { prepareChatConflictResolution } from "../src/chat/conflictResolution";
import { verifyPortableChatContinuationClosure } from "../src/chat/continuationClosure";
import { portableChatCoreHash, type PortableChatSnapshot, type PortableChatSnapshotV1, type PortableChatSnapshotV2 } from "../src/chat/stateVscdb";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import type { JsonValue, ResourceTip } from "../src/types";

const roots: string[] = [];
const id = "73737373-7373-4373-8373-737373737373";
const resourceId = `chat/${id}`;
const producer = { extensionVersion: "1.0.7", cursorVersion: "3.11.19", vscodeVersion: "1.125.0" };
const policy = { offline: true, tipsAllowed: () => true };
const pruneOptions = { reconciledWithoutWarnings: true, overrideAgeGate: true };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("chat recovery history during checkpoint pruning", () => {
  it.each(["agent-kv-enrichment", "auto-merge"])("captures independent %s ordering before deleting its original events", async origin => {
    const repository = await fixture();
    const old = chat("older authored core");
    const original = await publish(repository, old);
    await publish(repository, old, [original.versionId], { syncOrigin: origin,
      ...(origin === "agent-kv-enrichment" ? { enrichedFromVersionId: original.versionId, agentKvEnrichmentAppliesCore: true } : {}) });
    for (let pass = 0; pass < 2; pass += 1) {
      await repository.createCheckpoint(true);
      const manifest = (await repository.loadAbsorbedCheckpointManifest())!;
      expect(manifest.resources.find(resource => resource.resourceId === resourceId)?.metadata).toMatchObject({
        chatResolutionOrigin: { versionId: original.versionId, lamport: original.lamport },
        chatResolutionCoreHash: portableChatCoreHash(old),
      });
      expect((await repository.pruneWithGates(pruneOptions)).status).toBe("pruned");
      await reconcile(repository);
    }
    expect(await repository.tryReadVersionMetadata(original.versionId)).toBeNull();
    const latest = chat("new authored fork");
    const authored = await publish(repository, latest);
    const current = await reconcile(repository);
    const result = await prepareChatConflictResolution(repository, current.conflicts[0]!, policy);
    expect(result?.content.equals(canonicalBytes(latest))).toBe(true);
    expect(result?.metadata?.chatResolutionOrigin).toMatchObject({ versionId: authored.versionId });
  });

  it("preserves a legacy checkpoint's dependent origins while pruning unrelated history", async () => {
    const repository = await fixture();
    const old = chat("older authored core");
    const original = await publish(repository, old);
    await publish(repository, old, [original.versionId], { syncOrigin: "agent-kv-enrichment",
      enrichedFromVersionId: original.versionId, agentKvEnrichmentAppliesCore: true });
    const settings = await repository.publish([{ resourceId: "settings/user", kind: "settings",
      content: Buffer.from("{}"), semanticHash: sha256("{}"), parents: [] }], []);
    await reconcile(repository);
    const read = vi.spyOn(repository, "readObject").mockRejectedValue(new Error("legacy checkpoint did not inspect chat bodies"));
    await repository.createCheckpoint(true);
    read.mockRestore();

    const result = await repository.pruneWithGates(pruneOptions);

    expect(result.status).toBe("pruned");
    expect(result.eventsDeleted).toBeGreaterThan(0);
    expect(result.warnings.some(warning => warning.includes("dependent-origin"))).toBe(true);
    expect(await repository.tryReadVersionMetadata(original.versionId)).not.toBeNull();
    expect((await repository.listEvents()).some(event => event.eventHash === settings.eventHash)).toBe(false);
    await repository.refreshState({ forceAudit: true });
    expect((await reconcile(repository)).warnings).toEqual([]);
    await publish(repository, chat("new authored fork"));
    const current = await reconcile(repository);
    expect(await prepareChatConflictResolution(repository, current.conflicts[0]!, policy)).not.toBeNull();
  });

  it("pins partial latest history through prune and GC, then releases it when the active graph becomes complete", async () => {
    const repository = await fixture();
    const available = Buffer.from("historical continuation blob");
    const missing = Buffer.from("later recovered continuation blob");
    const old = chat("old branch");
    old.agentKv = graph([available]);
    const historical = await publish(repository, old);
    const historicalObject = historical.payload!;
    const latest = legacyChat("latest branch", [sha256(available), sha256(missing)]);
    await publish(repository, latest);
    const current = await reconcile(repository);
    const resolution = (await prepareChatConflictResolution(repository, current.conflicts[0]!, policy))!;
    expect(resolution.metadata?.chatSnapshotSchemaVersion).toBe(1);
    expect(resolution.metadata?.chatCoreHash).toBe(portableChatCoreHash(latest));
    await repository.publish([resolution], []);
    await reconcile(repository);
    await repository.createCheckpoint(true);
    const first = await repository.pruneWithGates(pruneOptions);
    expect(first.warnings.some(warning => warning.includes("incomplete-continuation"))).toBe(true);
    await reconcile(repository);
    await repository.compactOwnOrphans(true);
    expect(await repository.readObject(historicalObject)).toEqual(canonicalBytes(old));
    expect(await repository.tryReadVersionMetadata(historical.versionId)).not.toBeNull();
    await repository.refreshState({ forceAudit: true });
    expect((await reconcile(repository)).warnings).toEqual([]);

    const complete: PortableChatSnapshotV2 = { ...latest, schemaVersion: 2, agentKv: graph([available, missing]) };
    await expect(verifyPortableChatContinuationClosure(complete)).resolves.toMatchObject({ status: "complete" });
    await publish(repository, complete, repository.state.tips[resourceId]!.map(tip => tip.versionId));
    await repository.createCheckpoint(true);
    const second = await repository.pruneWithGates(pruneOptions);
    expect(second.warnings).toEqual([]);
    expect(second.eventsDeleted).toBeGreaterThan(0);
    await reconcile(repository);
    expect((await repository.compactOwnOrphans(true)).removedFiles).toBeGreaterThan(0);
    expect(await repository.tryReadVersionMetadata(historical.versionId)).toBeNull();
    await expect(repository.readObject(historicalObject)).rejects.toThrow();
    const survivor = await repository.readVersion(repository.state.tips[resourceId]![0]!.versionId);
    expect(survivor.content).toEqual(canonicalBytes(complete));
  });

  it("does not pin every v1 chat when its actual continuation graph is empty", async () => {
    const repository = await fixture();
    const original = await publish(repository, legacyChat("old core", []));
    const latest = legacyChat("latest core", []);
    await publish(repository, latest, [original.versionId]);
    await repository.createCheckpoint(true);
    const result = await repository.pruneWithGates(pruneOptions);
    expect(result.warnings).toEqual([]);
    expect(result.eventsDeleted).toBeGreaterThan(0);
    expect(await repository.tryReadVersionMetadata(original.versionId)).toBeNull();
  });

  it("retains an older checkpoint when it is the only root of a partial chat's recovery payload", async () => {
    const repository = await fixture();
    const available = Buffer.from("recovery bytes rooted only by the prior checkpoint");
    const old = chat("old complete core");
    old.agentKv = graph([available]);
    const historical = await publish(repository, old);
    await repository.publish([{ resourceId: "settings/user", kind: "settings", content: Buffer.from("{}"),
      semanticHash: sha256("{}"), parents: [] }], []);
    await reconcile(repository);
    const prior = await repository.createCheckpoint(true);
    expect((await repository.pruneWithGates(pruneOptions)).status).toBe("pruned");
    await reconcile(repository);
    expect((await repository.listEvents()).some(event => event.eventHash === historical.eventHash)).toBe(false);
    const latest = legacyChat("latest partial core", [sha256(available), sha256("not recovered yet")]);
    await publish(repository, latest, [historical.versionId]);
    await repository.createCheckpoint(true);

    const result = await repository.pruneWithGates(pruneOptions);
    await reconcile(repository);
    await repository.compactOwnOrphans(true);

    expect(result.status).toBe("pruned");
    expect(result.checkpointFilesDeleted).toBe(0);
    await expect(readFile(prior.filePath)).resolves.toBeInstanceOf(Buffer);
    await expect(repository.readObject(historical.payload!)).resolves.toEqual(canonicalBytes(old));
    const active = await repository.readVersion(repository.state.tips[resourceId]![0]!.versionId);
    expect(active.content).toEqual(canonicalBytes(latest));
  });

  it("preserves unverified history when the aggregate work budget is exhausted", async () => {
    const repository = await fixture();
    const original = await publish(repository, chat("old core"));
    await publish(repository, chat("latest core"), [original.versionId]);
    vi.spyOn(checkpointSafety, "createChatCheckpointWorkBudget").mockImplementation(() => ({
      remainingBytes: 0, remainingMetadataReads: 0, metadata: new Map(), authenticatedPayloads: new Map(),
    }));
    await repository.createCheckpoint(true);
    const result = await repository.pruneWithGates(pruneOptions);
    expect(result.status).toBe("pruned");
    expect(result.warnings.some(warning => warning.includes("work-limit"))).toBe(true);
    expect(await repository.tryReadVersionMetadata(original.versionId)).not.toBeNull();
    expect(result.eventsDeleted).toBe(0);
  });

  it("re-authenticates cached complete payloads before deleting their history", async () => {
    const repository = await fixture();
    const original = await publish(repository, chat("old core"));
    const latest = await publish(repository, chat("latest core"), [original.versionId]);
    await repository.publish([{ resourceId: "settings/user", kind: "settings", content: Buffer.from("{}"),
      semanticHash: sha256("{}"), parents: [] }], []);
    await reconcile(repository);
    await repository.createCheckpoint(true);
    const reference = latest.payload!;
    const path = join(repository.root, "devices", reference.deviceId, "blobs", "sha256",
      reference.objectId.slice(0, 2), `${reference.objectId}.cso`);
    const originalBytes = await readFile(path);
    const info = await stat(path);
    const corrupted = Buffer.from(originalBytes);
    corrupted[Math.floor(corrupted.byteLength / 2)]! ^= 1;
    await writeFile(path, corrupted);
    await utimes(path, info.atime, info.mtime);

    const result = await repository.pruneWithGates(pruneOptions);

    expect(result.status).toBe("pruned");
    expect(result.warnings.some(warning => warning.includes("unreadable-core"))).toBe(true);
    expect(await repository.tryReadVersionMetadata(original.versionId)).not.toBeNull();
    await expect(repository.readObject(original.payload!)).resolves.toEqual(canonicalBytes(chat("old core")));
  });

  it("advances bounded verification to later chats while preserving skipped histories", async () => {
    const repository = await fixture();
    const ids = [id, "74747474-7474-4474-8474-747474747474", "75757575-7575-4575-8575-757575757575"];
    const originals: ResourceTip[] = [];
    for (const composerId of ids) {
      const original = await publish(repository, chat("old core", composerId));
      originals.push(original);
      await publish(repository, chat("latest core", composerId), [original.versionId]);
    }
    const single = canonicalBytes(chat("latest core")).byteLength;
    vi.spyOn(checkpointSafety, "createChatCheckpointWorkBudget").mockImplementation(() => ({
      remainingBytes: single, remainingMetadataReads: 512, metadata: new Map(), authenticatedPayloads: new Map(),
    }));
    await repository.createCheckpoint(true);
    for (let pass = 0; pass < ids.length; pass += 1) {
      const result = await repository.pruneWithGates(pruneOptions);
      expect(result.status).toBe("pruned");
      await reconcile(repository);
    }
    for (const original of originals) {
      expect(await repository.tryReadVersionMetadata(original.versionId)).toBeNull();
    }
    await repository.refreshState({ forceAudit: true });
    expect((await reconcile(repository)).warnings).toEqual([]);
  });

  it("does not protect identical semantic tips as an unresolved conflict", async () => {
    const repository = await fixture();
    const duplicate = chat("identical captures");
    await publish(repository, duplicate);
    await publish(repository, duplicate);
    expect(repository.state.tips[resourceId]).toHaveLength(2);
    expect((await reconcile(repository)).conflicts).toEqual([]);
    await repository.createCheckpoint(true);
    const result = await repository.pruneWithGates(pruneOptions);
    expect(result.status).toBe("pruned");
    expect(result.warnings).toEqual([]);
    expect(result.eventsDeleted).toBeGreaterThan(0);
  });
});

async function fixture(): Promise<SyncRepository> {
  const root = await mkdtemp(join(tmpdir(), "chat-checkpoint-safety-"));
  roots.push(root);
  return SyncRepository.create(join(root, "repo"), join(root, "storage"),
    "sufficiently long checkpoint safety passphrase", 128 * 1024 * 1024, producer);
}

async function reconcile(repository: SyncRepository) {
  const checkpoint = await repository.loadAbsorbedCheckpointManifest();
  return new EventReconciler().reconcile(await repository.listReconciliationEvents(checkpoint), repository.state, checkpoint);
}

async function publish(repository: SyncRepository, snapshot: PortableChatSnapshot, parents: string[] = [], metadata: Record<string, JsonValue> = {}): Promise<ResourceTip> {
  const content = canonicalBytes(snapshot);
  const target = `chat/${snapshot.composerId}`;
  const result = await repository.publish([{ resourceId: target, kind: "chat", content, semanticHash: sha256(content), parents,
    metadata: { chatCoreHash: portableChatCoreHash(snapshot), chatSnapshotSchemaVersion: snapshot.schemaVersion, ...metadata } }], []);
  await reconcile(repository);
  return repository.state.tips[target]!.find(tip => tip.eventHash === result.eventHash)!;
}

function graph(values: Buffer[]): PortableChatSnapshotV2["agentKv"] {
  return { blobs: values.map(value => ({ key: `agentKv:blob:${sha256(value)}`, valueType: "blob" as const,
    valueBase64: value.toString("base64") })).sort((a, b) => a.key.localeCompare(b.key)),
    referencedIds: values.map(value => sha256(value)).sort(), missingIds: [] };
}

function chat(text: string, composerId = id): PortableChatSnapshotV2 {
  return { schemaVersion: 2, composerId,
    header: { composerId, workspaceId: null, createdAt: 1, lastUpdatedAt: 2,
      isArchived: 0, isSubagent: 0, recency: 0, checkpointAt: null, value: "{}" },
    composerData: { key: `composerData:${composerId}`, valueType: "text",
      valueBase64: Buffer.from(JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "active" }] })).toString("base64") },
    bubbles: [{ key: `bubbleId:${composerId}:active`, valueType: "text", valueBase64: Buffer.from(JSON.stringify({ text })).toString("base64") }],
    agentKv: graph([]) };
}

function legacyChat(text: string, rootIds: string[]): PortableChatSnapshotV1 {
  const { agentKv, ...source } = chat(text);
  void agentKv;
  return { ...source, schemaVersion: 1, composerData: { ...source.composerData,
    valueBase64: Buffer.from(JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "active" }],
      ...(rootIds.length === 0 ? {} : { conversationState: `~${Buffer.concat(rootIds.map(rootId =>
        Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(rootId, "hex")]))).toString("base64")}` }),
    })).toString("base64") } };
}
