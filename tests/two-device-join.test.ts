import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyncRepository } from "../src/protocol/repository";
import { EventReconciler } from "../src/protocol/reconciler";
import { sha256 } from "../src/protocol/canonical";

const producer = {
  extensionVersion: "0.0.5",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

describe("a second device joining an existing repository", () => {
  it("completes its first cycle and receives the first device's resources", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-join-"),
    );
    try {
      const root = join(temporaryRoot, "repository");
      const deviceA = await SyncRepository.create(
        root,
        join(temporaryRoot, "storage-a"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      await deviceA.publish([snapshot("settings/default/editor.fontSize", "14")], []);

      const deviceB = await SyncRepository.openWithMasterKey(
        root,
        join(temporaryRoot, "storage-b"),
        deviceA.repository,
        Buffer.from(deviceA.masterKey),
        1024 * 1024,
        producer,
      );
      expect(deviceB.state.device.deviceId).not.toBe(deviceA.state.device.deviceId);

      // The production order in performSync.
      await deviceB.refreshState();
      const events = await deviceB.listEvents();
      const result = new EventReconciler().reconcile(
        events,
        deviceB.state,
        await deviceB.loadAbsorbedCheckpointManifest(),
      );

      expect(result.projections.map((entry) => entry.resourceId)).toEqual([
        "settings/default/editor.fontSize",
      ]);
      expect(result.projections[0]?.changed).toBe(true);
      // A device that has published nothing must carry no pinned cursor for
      // itself at all; `{lastSequence: 0, lastEventHash: null}` is the invalid
      // shape every validator rejects.
      expect(deviceB.state.streams[deviceB.state.device.deviceId]).toBeUndefined();

      // ...and it can still publish afterwards, which is what turns the absent
      // cursor into a real one.
      await deviceB.publish([snapshot("settings/default/editor.tabSize", "2")], []);
      await deviceB.refreshState();
      expect(
        deviceB.state.streams[deviceB.state.device.deviceId],
      ).toMatchObject({ lastSequence: 1 });

      await deviceA.refreshState();
      const backAtA = new EventReconciler().reconcile(
        await deviceA.listEvents(),
        deviceA.state,
        await deviceA.loadAbsorbedCheckpointManifest(),
      );
      expect(backAtA.projections.map((entry) => entry.resourceId)).toContain(
        "settings/default/editor.tabSize",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("repairs a zero cursor an earlier build persisted for its own stream", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-join-repair-"),
    );
    try {
      const root = join(temporaryRoot, "repository");
      const repository = await SyncRepository.create(
        root,
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      const deviceId = repository.state.device.deviceId;
      repository.state.streams[deviceId] = {
        lastSequence: 0,
        lastEventHash: null,
      };
      await repository.stateStore.save(repository.state);
      await repository.refreshState();
      expect(repository.state.streams[deviceId]).toBeUndefined();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function snapshot(resourceId: string, value: string) {
  const content = Buffer.from(value, "utf8");
  return {
    resourceId,
    kind: "settings" as const,
    content,
    semanticHash: sha256(content),
  };
}
