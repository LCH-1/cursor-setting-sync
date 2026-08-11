import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyncRepository } from "../src/protocol/repository";
import { classifyLegacyCheckpointMarker } from "../src/protocol/checkpointMarker";
import { EventReconciler } from "../src/protocol/reconciler";
import {
  effectiveSyncOrigin,
  effectiveVersionProducer,
  isSyntheticTip,
} from "../src/sync/versionPolicy";
import { sha256 } from "../src/protocol/canonical";
import type { ResourceKind, ResourceTip } from "../src/types";

const producer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

const PEER_CHAT = "chat/00000000-0000-4000-8000-000000000001";

describe("the checkpoint marker re-asserts a tip this device may never have applied", () => {
  it("upgrades an ordinary v0.0.59 marker to explicit provenance", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-legacy-marker-"),
    );
    try {
      const legacyMarkerProducer = {
        extensionVersion: "0.0.59",
        cursorVersion: "3.15.6",
        vscodeVersion: "1.125.0",
      };
      const currentMarkerProducer = {
        extensionVersion: "0.0.63",
        cursorVersion: "3.14.0",
        vscodeVersion: "1.124.0",
      };
      const repositoryRoot = join(temporaryRoot, "repository");
      const legacyDevice = await SyncRepository.create(
        repositoryRoot,
        join(temporaryRoot, "storage-legacy"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        legacyMarkerProducer,
      );
      const currentDevice = await SyncRepository.open(
        repositoryRoot,
        join(temporaryRoot, "storage-current"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        currentMarkerProducer,
      );
      const content = Buffer.from("ordinary legacy database tip", "utf8");
      const ordinaryMetadata = {
        composerId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "workspace",
        lastUpdatedAt: 59,
        bubbleCount: 1,
      };
      const base = await legacyDevice.publish(
        [
          {
            resourceId: PEER_CHAT,
            kind: "chat",
            content,
            semanticHash: sha256(content),
            metadata: ordinaryMetadata,
          },
        ],
        [],
      );
      const baseVersionId = `${base.eventHash ?? ""}#0`;
      // This is the exact v0.0.59 producer shape: spread the active metadata,
      // replace syncOrigin, and retain only the real parent edge.
      const legacyMarker = await legacyDevice.publish(
        [
          {
            resourceId: PEER_CHAT,
            kind: "chat",
            content,
            semanticHash: sha256(content),
            metadata: { ...ordinaryMetadata, syncOrigin: "checkpoint-marker" },
            parents: [baseVersionId],
          },
        ],
        [],
      );
      const legacyVersionId = `${legacyMarker.eventHash ?? ""}#0`;
      const legacyChange = (await legacyDevice.listEvents()).find(
        (event) => event.eventHash === legacyMarker.eventHash,
      )?.manifest.changes[0];
      expect(classifyLegacyCheckpointMarker(legacyChange?.metadata)).toBe(
        "ordinary",
      );
      expect(
        effectiveVersionProducer(legacyChange?.metadata, legacyMarkerProducer),
      ).toEqual(legacyMarkerProducer);

      await reconcileRepository(currentDevice);
      currentDevice.state.retiredDevices = [legacyDevice.state.device.deviceId];
      await currentDevice.saveState();
      await currentDevice.createCheckpoint(true);
      const prune = await currentDevice.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(prune.status).toBe("pruned");
      const upgraded = (await currentDevice.listEvents()).find(
        (event) => event.eventHash === prune.markerEventHash,
      )?.manifest.changes[0];
      expect(upgraded?.parents).toEqual([legacyVersionId]);
      expect(upgraded?.metadata).toMatchObject({
        syncOrigin: "checkpoint-marker",
        checkpointedSourceDeviceId: legacyDevice.state.device.deviceId,
        checkpointedVersionId: legacyVersionId,
        checkpointedProducer: legacyMarkerProducer,
      });
      expect(upgraded?.metadata).not.toHaveProperty("checkpointedSyncOrigin");
      expect(
        effectiveVersionProducer(upgraded?.metadata, currentMarkerProducer),
      ).toEqual({
        extensionVersion: currentMarkerProducer.extensionVersion,
        cursorVersion: legacyMarkerProducer.cursorVersion,
        vscodeVersion: legacyMarkerProducer.vscodeVersion,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("distinguishes ordinary v0.0.59 markers from retained special recipes", () => {
    const markerProducer = {
      extensionVersion: "0.0.59",
      cursorVersion: "3.15.6",
      vscodeVersion: "1.125.0",
    };
    const originalProducer = {
      extensionVersion: "0.0.58",
      cursorVersion: "3.16.0",
      vscodeVersion: "1.126.0",
    };
    const ordinary = {
      syncOrigin: "checkpoint-marker",
      composerId: "00000000-0000-4000-8000-000000000001",
      lastUpdatedAt: 59,
      bubbleCount: 1,
    };
    expect(classifyLegacyCheckpointMarker(ordinary)).toBe("ordinary");
    expect(effectiveVersionProducer(ordinary, markerProducer)).toEqual(
      markerProducer,
    );

    const repair = {
      ...ordinary,
      repairOriginDeviceId: "repair-source",
      repairFingerprint: "a".repeat(64),
    };
    expect(classifyLegacyCheckpointMarker(repair)).toBe(
      "automatic-chat-repair",
    );
    expect(effectiveSyncOrigin(repair)).toBe("automatic-chat-repair");
    expect(effectiveVersionProducer(repair, markerProducer)).toBeUndefined();

    const enrichment = {
      ...ordinary,
      chatSnapshotSchemaVersion: 2,
      chatCoreHash: "b".repeat(64),
      agentKvBlobCount: 2,
      agentKvReferencedCount: 2,
      agentKvMissingCount: 0,
      enrichedFromVersionId: `${"c".repeat(64)}#0`,
      enrichedFromSemanticHash: "d".repeat(64),
      originalProducer,
    };
    expect(classifyLegacyCheckpointMarker(enrichment)).toBe(
      "agent-kv-enrichment",
    );
    expect(effectiveSyncOrigin(enrichment)).toBe("agent-kv-enrichment");
    expect(effectiveVersionProducer(enrichment, markerProducer)).toEqual({
      extensionVersion: markerProducer.extensionVersion,
      cursorVersion: originalProducer.cursorVersion,
      vscodeVersion: originalProducer.vscodeVersion,
    });

    const restore = { ...ordinary, originalProducer };
    expect(classifyLegacyCheckpointMarker(restore)).toBe("version-restore");
    expect(effectiveSyncOrigin(restore)).toBe("version-restore");
    expect(effectiveVersionProducer(restore, markerProducer)).toEqual({
      extensionVersion: markerProducer.extensionVersion,
      cursorVersion: originalProducer.cursorVersion,
      vscodeVersion: originalProducer.vscodeVersion,
    });

    const partialNewMarker = {
      ...ordinary,
      checkpointedVersionId: `${"e".repeat(64)}#0`,
    };
    expect(classifyLegacyCheckpointMarker(partialNewMarker)).toBeNull();
    expect(
      effectiveVersionProducer(partialNewMarker, markerProducer),
    ).toBeUndefined();
  });

  it("preserves an automatic repair's source through marker generations", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-marker-provenance-"),
    );
    try {
      const newerSourceProducer = {
        extensionVersion: "0.0.62",
        cursorVersion: "3.16.0",
        vscodeVersion: "1.126.0",
      };
      const olderMarkerProducer = {
        extensionVersion: "0.0.63",
        cursorVersion: "3.15.6",
        vscodeVersion: "1.125.0",
      };
      const repositoryRoot = join(temporaryRoot, "repository");
      const deviceA = await SyncRepository.create(
        repositoryRoot,
        join(temporaryRoot, "storage-a"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        newerSourceProducer,
      );
      const deviceB = await SyncRepository.open(
        repositoryRoot,
        join(temporaryRoot, "storage-b"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        olderMarkerProducer,
      );
      expect(deviceA.state.device.deviceId).not.toBe(
        deviceB.state.device.deviceId,
      );
      const content = Buffer.from("complete automatic repair", "utf8");
      const direct = await deviceA.publish(
        [
          {
            resourceId: PEER_CHAT,
            kind: "chat",
            content,
            semanticHash: sha256(content),
            metadata: {
              syncOrigin: "automatic-chat-repair",
              repairOriginDeviceId: deviceA.state.device.deviceId,
              repairFingerprint: "f".repeat(64),
            },
          },
        ],
        [],
      );
      const directVersionId = `${direct.eventHash ?? ""}#0`;

      await reconcileRepository(deviceB);
      // The source device is intentionally offline for this maintenance run;
      // retiring it removes the unrelated all-devices checkpoint ACK gate so
      // this test can isolate marker provenance.
      deviceB.state.retiredDevices = [deviceA.state.device.deviceId];
      await deviceB.saveState();
      await deviceB.createCheckpoint(true);
      const firstPrune = await deviceB.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(firstPrune.status).toBe("pruned");
      const firstMarkerVersionId = `${firstPrune.markerEventHash ?? ""}#0`;
      const firstMarker = (await deviceB.listEvents()).find(
        (event) => event.eventHash === firstPrune.markerEventHash,
      )?.manifest.changes[0];
      expect(firstMarker?.parents).toEqual([directVersionId]);
      expect(firstMarker?.metadata).toMatchObject({
        syncOrigin: "checkpoint-marker",
        checkpointedSyncOrigin: "automatic-chat-repair",
        checkpointedSourceDeviceId: deviceA.state.device.deviceId,
        checkpointedVersionId: directVersionId,
        checkpointedProducer: newerSourceProducer,
        repairOriginDeviceId: deviceA.state.device.deviceId,
      });
      expect(
        effectiveVersionProducer(
          firstMarker?.metadata,
          olderMarkerProducer,
        ),
      ).toEqual({
        extensionVersion: olderMarkerProducer.extensionVersion,
        cursorVersion: newerSourceProducer.cursorVersion,
        vscodeVersion: newerSourceProducer.vscodeVersion,
      });

      await reconcileRepository(deviceB);
      await deviceB.createCheckpoint(true);
      const secondPrune = await deviceB.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(secondPrune.status).toBe("pruned");
      const secondMarker = (await deviceB.listEvents()).find(
        (event) => event.eventHash === secondPrune.markerEventHash,
      )?.manifest.changes[0];
      expect(secondMarker?.parents).toEqual([firstMarkerVersionId]);
      expect(secondMarker?.metadata).toMatchObject({
        syncOrigin: "checkpoint-marker",
        checkpointedSyncOrigin: "automatic-chat-repair",
        // Marker-of-marker keeps A as the effective source even though B
        // published both transport markers.
        checkpointedSourceDeviceId: deviceA.state.device.deviceId,
        // The immediate provenance edge advances to the first marker.
        checkpointedVersionId: firstMarkerVersionId,
        checkpointedProducer: newerSourceProducer,
        repairOriginDeviceId: deviceA.state.device.deviceId,
      });
      expect(
        effectiveVersionProducer(
          secondMarker?.metadata,
          olderMarkerProducer,
        ),
      ).toEqual({
        extensionVersion: olderMarkerProducer.extensionVersion,
        cursorVersion: newerSourceProducer.cursorVersion,
        vscodeVersion: newerSourceProducer.vscodeVersion,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  /**
   * Pruning republishes one current tip as a v2 marker event so old builds fail
   * loudly. The content comes out of the repository blob, not off this disk, so
   * on a device that has not applied that resource yet the marker is a claim
   * about someone else's content wearing this device's deviceId.
   *
   * `applyProjections` short-circuits on `tip.deviceId === self && !synthetic`,
   * which is how it avoids re-applying its own scans. A marker that is not
   * classified as synthetic therefore takes that branch and is recorded as
   * applied without anything being written - and the resource kinds that
   * cannot be applied while Cursor runs are exactly the ones that arrive this
   * way.
   */
  it("marks the marker tip synthetic so it is not mistaken for this device's own scan", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-marker-"),
    );
    try {
      const repository = await createRepository(temporaryRoot);
      const content = Buffer.from("a chat body only the other device has", "utf8");
      const published = await repository.publish(
        [
          {
            resourceId: PEER_CHAT,
            kind: "chat" as const,
            content,
            semanticHash: sha256(content),
            metadata: {
              syncOrigin: "agent-kv-enrichment",
              originalProducer: {
                extensionVersion: "0.0.62",
                cursorVersion: "3.16.0",
                vscodeVersion: "1.126.0",
              },
            },
          },
        ],
        [],
      );
      await adoptTips(repository);
      await repository.createCheckpoint(true);
      const prune = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(prune.status).toBe("pruned");
      expect(prune.markerEventHash).not.toBeNull();

      const reconciled = new EventReconciler().reconcile(
        await repository.listEvents(),
        repository.state,
        await repository.loadAbsorbedCheckpointManifest(),
      );
      const projection = reconciled.projections.find(
        (candidate) => candidate.resourceId === PEER_CHAT,
      );
      // The marker superseded the original event, so the tip the next cycle
      // sees is the marker itself, published under this device's identity.
      expect(projection?.tip.versionId).toBe(`${prune.markerEventHash}#0`);
      expect(projection?.tip.deviceId).toBe(repository.state.device.deviceId);
      expect(projection?.tip.metadata?.syncOrigin).toBe("checkpoint-marker");
      expect(projection?.tip.metadata?.checkpointedSyncOrigin).toBe(
        "agent-kv-enrichment",
      );
      expect(projection?.tip.semanticHash).toBe(sha256(content));
      expect(published.eventHash).not.toBe(prune.markerEventHash);

      expect(isSyntheticTip(projection?.tip as ResourceTip)).toBe(true);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  /**
   * Classifying the marker as synthetic keeps it out of the own-scan
   * short-circuit, but `applySyntheticProjectionsBeforeScan` then queues any
   * synthetic tip whose adapter cannot apply while Cursor runs - so a marker on
   * a chat manufactures a pending change, and a "Restart to Apply" prompt, for
   * bytes that are already on disk. Every prune, on every device.
   */
  it("re-asserts a resource the running Cursor can write instead of a chat", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-marker-kind-"),
    );
    try {
      const repository = await createRepository(temporaryRoot);
      const chatBody = Buffer.from("a chat body", "utf8");
      await repository.publish(
        [
          {
            resourceId: PEER_CHAT,
            kind: "chat" as const,
            content: chatBody,
            semanticHash: sha256(chatBody),
          },
          {
            resourceId: "settings/default/editor.fontSize",
            kind: "settings" as const,
            content: Buffer.from("16", "utf8"),
            semanticHash: sha256(Buffer.from("16", "utf8")),
          },
        ],
        [],
      );
      await adoptTips(repository);
      await repository.createCheckpoint(true);
      const prune = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(prune.status).toBe("pruned");

      const marker = (await repository.listEvents()).find(
        (event) => event.eventHash === prune.markerEventHash,
      );
      // "chat/" sorts ahead of "settings/", so the first readable put is the
      // chat - which is exactly what the marker used to pick.
      expect(marker?.manifest.changes[0]?.resourceId).toBe(
        "settings/default/editor.fontSize",
      );
      expect(marker?.manifest.changes).toHaveLength(1);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

async function createRepository(temporaryRoot: string): Promise<SyncRepository> {
  return SyncRepository.create(
    join(temporaryRoot, "repository"),
    join(temporaryRoot, "storage"),
    "a sufficiently long test passphrase",
    1024 * 1024,
    producer,
  );
}

async function adoptTips(repository: SyncRepository): Promise<void> {
  const tips: Record<string, ResourceTip[]> = {};
  for (const event of await repository.listEvents()) {
    event.manifest.changes.forEach((change, changeIndex) => {
      const tip: ResourceTip = {
        versionId: `${event.eventHash}#${changeIndex}`,
        eventHash: event.eventHash,
        changeIndex,
        kind: change.kind as ResourceKind,
        lamport: event.manifest.lamport,
        deviceId: event.stored.header.deviceId,
        operation: change.operation,
        semanticHash: change.semanticHash,
        parents: change.parents,
      };
      if (change.payload !== undefined) {
        tip.payload = change.payload;
      }
      if (change.metadata !== undefined) {
        tip.metadata = change.metadata;
      }
      if (event.manifest.producer !== undefined) {
        tip.producer = event.manifest.producer;
      }
      tips[change.resourceId] = [tip];
    });
  }
  repository.state.tips = tips;
}

async function reconcileRepository(repository: SyncRepository): Promise<void> {
  await repository.refreshState();
  new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    await repository.loadAbsorbedCheckpointManifest(),
  );
}
