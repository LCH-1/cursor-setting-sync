import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ window: {}, extensions: { all: [] } }));

import { portableChatCoreHash, type PortableChatSnapshotV2 } from "../src/chat/stateVscdb";
import { acquireFileLockWithin, type FileLock } from "../src/platform/lock";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository, type CheckpointCreateResult, type PruneResult } from "../src/protocol/repository";
import { SyncManager } from "../src/sync/manager";
import { PERMANENT_EXCLUSION_REASONS } from "../src/sync/resourcePolicy";
import { absorbedCheckpointManifest, formatBytes } from "../src/sync/versionPolicy";
import type { PendingDatabaseChange, ResourceSnapshot } from "../src/types";

const roots: string[] = [];
const producer = { extensionVersion: "1.0.7", cursorVersion: "3.19.13", vscodeVersion: "1.128.0" };
const composerId = "45454545-4545-4545-8545-454545454545";
const resourceId = `chat/${composerId}`;
const maxBytes = 1024 * 1024;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("manual checkpoint maintenance with unapplied local chat versions", () => {
  it.each([
    { existingCheckpoint: false, blockedReason: undefined },
    { existingCheckpoint: true, blockedReason: undefined },
    { existingCheckpoint: false, blockedReason: "Chat continuation is incomplete" },
    { existingCheckpoint: true, blockedReason: "Chat continuation is incomplete" },
  ])("preserves local provenance after reloading a pending queue ($existingCheckpoint / $blockedReason)", async ({ existingCheckpoint, blockedReason }) => {
    const fixture = await createFixture(existingCheckpoint);
    const { repository, staleRepository, originalVersionId, originalMetadata, pending, storageRoot } = fixture;
    expect(staleRepository.state.pendingDatabaseChanges).toEqual([]);
    repository.state.pendingDatabaseChanges = [...permanentExclusions(), {
      ...pending, ...(blockedReason === undefined ? {} : { blockedReason }),
    }];
    await repository.saveState();

    const manager = maintenanceHarness(storageRoot);
    const create = vi.spyOn(staleRepository, "createCheckpoint");
    const prune = vi.spyOn(staleRepository, "pruneWithGates");
    const compact = vi.spyOn(staleRepository, "compactOwnOrphans");
    let failure: unknown;
    try {
      await manager.checkpointPhases(staleRepository, true, () => {});
    } catch (error) {
      failure = error;
    }

    expect(await staleRepository.tryReadVersionMetadata(originalVersionId)).toEqual(originalMetadata);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("pending database changes");
    expect(staleRepository.state.pendingDatabaseChanges).toEqual(repository.state.pendingDatabaseChanges);
    expect(create).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    const unlocked = await acquireFileLockWithin(join(storageRoot, "sync.lock"), 100);
    expect(unlocked).not.toBeNull();
    await unlocked?.release();
  });

  it("still prunes when only permanent machine-local exclusions remain", async () => {
    const fixture = await createFixture(false);
    const { repository, pending, storageRoot, originalVersionId } = fixture;
    const latest = repository.state.tips[resourceId]![0]!;
    repository.state.projections[resourceId] = { resourceId, kind: "chat",
      semanticHash: latest.semanticHash, versionId: `${pending.eventHash}#${pending.changeIndex}` };
    repository.state.pendingDatabaseChanges = permanentExclusions();
    await repository.saveState();

    const outcome = await maintenanceHarness(storageRoot).checkpointPhases(repository, true, () => {});

    expect(outcome.created).not.toBeNull();
    expect(outcome.prune?.status).toBe("pruned");
    expect(outcome.prune?.eventsDeleted).toBe(2);
    expect(await repository.tryReadVersionMetadata(originalVersionId)).toBeNull();
    expect(repository.state.pendingDatabaseChanges).toEqual(permanentExclusions());
  });

  it("reports the measured object bytes as well as history bytes in the maintenance log", async () => {
    const { repository, storageRoot, originalMetadata } = await createFixture(true);
    const oldPayload = originalMetadata.change.payload!;
    const oldObject = join(repository.root, "devices", oldPayload.deviceId, "blobs", "sha256",
      oldPayload.objectId.slice(0, 2), `${oldPayload.objectId}.cso`);
    const objectBytes = (await stat(oldObject)).size;
    const eventSizes = await Promise.all((await repository.listEvents()).map(async event => (await stat(event.path)).size));
    const historyBytes = eventSizes.reduce((sum, size) => sum + size, 0);
    const manager = maintenanceHarness(storageRoot);
    const log = vi.fn<(message: string) => void>();
    manager.status.log = log;
    manager.repository = repository;
    manager.maintenanceRequested = true;
    let outcome: MaintenanceOutcome | undefined;
    manager.runCheckpointPhases = async (selected, overrideAgeGate) => {
      outcome = await manager.checkpointPhases(selected, overrideAgeGate, () => {});
      return outcome;
    };
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 48 * 60 * 60 * 1000);

    await manager.runRequestedMaintenance();

    expect(outcome?.prune?.reclaimedBytes).toBe(historyBytes);
    expect(outcome?.compaction).toEqual({ removedFiles: 1, reclaimedBytes: objectBytes });
    await expect(stat(oldObject)).rejects.toMatchObject({ code: "ENOENT" });
    const summary = log.mock.calls.map(([message]) => message).join("\n");
    expect(summary).toContain(`compacted 1 object file(s) (${formatBytes(objectBytes)})`);
    expect(summary).toContain(`reclaimed ${formatBytes(historyBytes + objectBytes)} in total`);
  });

  it("does not report object compaction when the checkpoint age gate defers pruning", async () => {
    const { repository, storageRoot } = await createFixture(true);
    const manager = maintenanceHarness(storageRoot);
    const compact = vi.spyOn(repository, "compactOwnOrphans");

    const outcome = await manager.checkpointPhases(repository, false, () => {});

    expect(outcome.prune?.status).toBe("aborted");
    expect(outcome.compaction).toBeNull();
    expect(compact).not.toHaveBeenCalled();
  });

  it("reports why an incomplete chat keeps its recovery history after maintenance", async () => {
    const { repository, storageRoot, originalVersionId } = await createFixture(true);
    const missingId = sha256("missing continuation content");
    const partial = JSON.parse(snapshot("incomplete conversation", 3).content.toString()) as PortableChatSnapshotV2;
    const state = `~${Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(missingId, "hex")]).toString("base64")}`;
    partial.bubbles[0]!.valueBase64 = Buffer.from(JSON.stringify({ text: "incomplete conversation", conversationState: state })).toString("base64");
    partial.agentKv = { blobs: [], referencedIds: [missingId], missingIds: [missingId] };
    const content = canonicalBytes(partial);
    await repository.publish([{ resourceId, kind: "chat", content, semanticHash: sha256(content), metadata: {
      chatSnapshotSchemaVersion: 2, chatCoreHash: portableChatCoreHash(partial),
      agentKvBlobCount: 0, agentKvReferencedCount: 1, agentKvMissingCount: 1,
    } }], []);
    await reconcile(repository);
    await repository.saveState();
    const manager = maintenanceHarness(storageRoot);
    const log = vi.fn<(message: string) => void>();
    manager.status.log = log;
    manager.repository = repository;
    manager.maintenanceRequested = true;
    let outcome: MaintenanceOutcome | undefined;
    manager.runCheckpointPhases = async (selected, overrideAgeGate) => {
      outcome = await manager.checkpointPhases(selected, overrideAgeGate, () => {});
      return outcome;
    };
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 48 * 60 * 60 * 1000);

    await manager.runRequestedMaintenance();

    const warning = outcome?.prune?.warnings.find(message => message.includes("incomplete-continuation"));
    expect(warning).toBeDefined();
    expect(await repository.tryReadVersionMetadata(originalVersionId)).not.toBeNull();
    expect(log.mock.calls.map(([message]) => message).join("\n")).toContain(warning);
  });
});

interface MaintenanceOutcome {
  created: CheckpointCreateResult | null;
  prune: PruneResult | null;
  compaction: { removedFiles: number; reclaimedBytes: number } | null;
}

interface MaintenanceHarness {
  takeCommandLock(repository: SyncRepository, report: (message: string) => void): Promise<FileLock>;
  openGitWindow(repository: SyncRepository): Promise<boolean>;
  commitGitWindow(active: boolean, root: string, message: string): Promise<boolean>;
  status: { log(message: string): void };
  repository: SyncRepository | null;
  maintenanceRequested: boolean;
  runRequestedMaintenance(): Promise<void>;
  runCheckpointPhases(repository: SyncRepository, overrideAgeGate: boolean): Promise<MaintenanceOutcome>;
  checkpointPhases(repository: SyncRepository, overrideAgeGate: boolean, report: (message: string) => void):
    Promise<MaintenanceOutcome>;
}

function maintenanceHarness(storageRoot: string): MaintenanceHarness {
  const manager = Object.create(SyncManager.prototype) as MaintenanceHarness;
  manager.takeCommandLock = async repository => {
    const lock = await acquireFileLockWithin(join(storageRoot, "sync.lock"), 1000);
    if (lock === null) throw new Error("Test synchronization lock is unavailable");
    await repository.ensureInitialized();
    return lock;
  };
  manager.openGitWindow = async () => false;
  manager.commitGitWindow = async () => false;
  manager.status = { log: () => {} };
  return manager;
}

async function createFixture(existingCheckpoint: boolean) {
  const root = await mkdtemp(join(tmpdir(), "maintenance-pending-"));
  roots.push(root);
  const storageRoot = join(root, "storage");
  const repository = await SyncRepository.create(join(root, "repository"), storageRoot,
    "a sufficiently long maintenance test passphrase", maxBytes, producer);
  const original = snapshot("local original", 1);
  const published = await repository.publish([original], []);
  const originalVersionId = `${published.eventHash}#0`;
  await reconcile(repository);
  repository.state.projections[resourceId] = { resourceId, kind: "chat",
    semanticHash: original.semanticHash, versionId: originalVersionId };
  const incoming = await repository.publish([{ ...snapshot("incoming resolved message", 2),
    parents: [originalVersionId] }], []);
  await reconcile(repository);
  if (existingCheckpoint) await repository.createCheckpoint(true);
  await repository.saveState();
  const originalMetadata = await repository.readVersionMetadata(originalVersionId);
  const staleRepository = await SyncRepository.openWithMasterKey(repository.root, storageRoot,
    repository.repository, Buffer.from(repository.masterKey), maxBytes, producer);
  const pending: PendingDatabaseChange = { resourceId, kind: "chat", eventHash: incoming.eventHash!, changeIndex: 0 };
  return { repository, staleRepository, originalVersionId, originalMetadata, pending, storageRoot };
}

async function reconcile(repository: SyncRepository): Promise<void> {
  const checkpoint = await absorbedCheckpointManifest(repository);
  const result = new EventReconciler().reconcile(await repository.listReconciliationEvents(checkpoint), repository.state, checkpoint);
  expect(result.warnings).toEqual([]);
  expect(result.conflicts).toEqual([]);
}

function permanentExclusions(): PendingDatabaseChange[] {
  return PERMANENT_EXCLUSION_REASONS.map((blockedReason, changeIndex) => ({
    resourceId: `workspace-storage/excluded-${changeIndex}`, kind: "workspace-storage", eventHash: "e".repeat(64),
    changeIndex, blockedReason,
  }));
}

function snapshot(text: string, time: number): ResourceSnapshot {
  const row = (key: string, value: unknown) => ({ key, valueType: "text" as const,
    valueBase64: Buffer.from(JSON.stringify(value)).toString("base64") });
  const portable: PortableChatSnapshotV2 = {
    schemaVersion: 2, composerId,
    header: { composerId, workspaceId: null, createdAt: 1, lastUpdatedAt: time, isArchived: 0,
      isSubagent: 0, recency: 0, checkpointAt: null, value: JSON.stringify({ name: "maintenance test" }) },
    composerData: row(`composerData:${composerId}`, { fullConversationHeadersOnly: [{ bubbleId: "active" }] }),
    bubbles: [row(`bubbleId:${composerId}:active`, { text })],
    agentKv: { blobs: [], referencedIds: [], missingIds: [] },
  };
  const content = canonicalBytes(portable);
  return { resourceId, kind: "chat", content, semanticHash: sha256(content), metadata: {
    chatSnapshotSchemaVersion: 2, chatCoreHash: portableChatCoreHash(portable),
    agentKvBlobCount: 0, agentKvReferencedCount: 0, agentKvMissingCount: 0,
  } };
}
