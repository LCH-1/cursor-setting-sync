import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { portableChatCoreHash, type PortableChatSnapshot } from "../src/chat/stateVscdb";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";

const roots: string[] = [];
const composerId = "73737373-7373-4373-8373-737373737373";
const resourceId = `chat/${composerId}`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("recovery history arriving during checkpoint pruning", () => {
  it.each(["event", "checkpoint"])("preserves a previously absent %s arriving after the protection scan", async generation => {
    const root = await mkdtemp(join(tmpdir(), "checkpoint-arrival-race-"));
    roots.push(root);
    const repository = await SyncRepository.create(join(root, "repo"), join(root, "local"),
      "sufficiently long arrival race test passphrase", 1024 * 1024,
      { extensionVersion: "1.0.7", cursorVersion: "3.11.19", vscodeVersion: "1.125.0" });
    const available = Buffer.from("historical continuation body");
    const availableId = sha256(available);
    const missingId = sha256("unavailable continuation body");
    const historical: PortableChatSnapshot = {
      schemaVersion: 2,
      composerId,
      header: { composerId, workspaceId: null, createdAt: 1, lastUpdatedAt: 2,
        isArchived: 0, isSubagent: 0, recency: 0, checkpointAt: null, value: "{}" },
      composerData: { key: `composerData:${composerId}`, valueType: "text", valueBase64: Buffer.from("{}").toString("base64") },
      bubbles: [],
      agentKv: { blobs: [{ key: `agentKv:blob:${availableId}`, valueType: "blob", valueBase64: available.toString("base64") }],
        referencedIds: [availableId], missingIds: [] },
    };
    const original = await publish(repository, historical);
    const originalTip = repository.state.tips[resourceId]![0]!;
    const oldCheckpoint = generation === "checkpoint" ? await repository.createCheckpoint(true) : null;
    const latest: PortableChatSnapshot = {
      schemaVersion: 1, composerId, header: historical.header, bubbles: [],
      composerData: { ...historical.composerData, valueBase64: Buffer.from(JSON.stringify({
        conversationState: `~${Buffer.concat([availableId, missingId].map(id =>
          Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")]))).toString("base64")}`,
      })).toString("base64") },
    };
    await publish(repository, latest, [originalTip.versionId]);
    await repository.createCheckpoint(true);
    const delayedPath = oldCheckpoint?.filePath ?? original.eventPath!;
    const delayedBytes = await readFile(delayedPath);
    await rm(original.eventPath!);
    if (oldCheckpoint !== null) {
      await rm(delayedPath);
    }
    const internals = repository as unknown as { prepareCheckpointMarker(): Promise<unknown> };
    const prepare = internals.prepareCheckpointMarker.bind(repository);
    vi.spyOn(internals, "prepareCheckpointMarker").mockImplementationOnce(async () => {
      const marker = await prepare();
      await writeFile(delayedPath, delayedBytes);
      return marker;
    });

    const pruned = await repository.pruneWithGates({ reconciledWithoutWarnings: true, overrideAgeGate: true });
    await reconcile(repository);
    const compacted = await repository.compactOwnOrphans(true);

    expect(pruned.status).toBe("pruned");
    expect(pruned.warnings.some(warning => warning.includes("incomplete-continuation"))).toBe(true);
    expect(await stat(delayedPath)).toBeDefined();
    expect(compacted.removedFiles).toBe(0);
    expect(await repository.readObject(originalTip.payload!)).toEqual(canonicalBytes(historical));
    const active = repository.state.tips[resourceId]![0]!;
    expect(await repository.readObject(active.payload!)).toEqual(canonicalBytes(latest));
  });
});

async function publish(repository: SyncRepository, snapshot: PortableChatSnapshot, parents: string[] = []) {
  const content = canonicalBytes(snapshot);
  const published = await repository.publish([{ resourceId, kind: "chat", content, semanticHash: sha256(content), parents,
    metadata: { chatCoreHash: portableChatCoreHash(snapshot), chatSnapshotSchemaVersion: snapshot.schemaVersion } }], []);
  await reconcile(repository);
  return published;
}

async function reconcile(repository: SyncRepository): Promise<void> {
  const checkpoint = await repository.loadAbsorbedCheckpointManifest();
  const result = new EventReconciler().reconcile(await repository.listReconciliationEvents(checkpoint), repository.state, checkpoint);
  expect(result.warnings).toEqual([]);
}
