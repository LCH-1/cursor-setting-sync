import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyncRepository } from "../src/protocol/repository";
import { EventReconciler } from "../src/protocol/reconciler";
import { isSyntheticTip } from "../src/sync/versionPolicy";
import { sha256 } from "../src/protocol/canonical";
import type { ResourceKind, ResourceTip } from "../src/types";

const producer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

const PEER_CHAT = "chat/00000000-0000-4000-8000-000000000001";

describe("the checkpoint marker re-asserts a tip this device may never have applied", () => {
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
