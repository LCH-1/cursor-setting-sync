import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyncRepository } from "../src/protocol/repository";
import { filterPublishableChanges } from "../src/sync/versionPolicy";
import { sha256 } from "../src/protocol/canonical";
import type { ResourceSnapshot } from "../src/types";

const producer = {
  extensionVersion: "0.0.5",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

const SMALL_LIMIT = 1024 * 1024;
const RAISED_LIMIT = 4 * 1024 * 1024;

describe("the publish size guard and publish itself", () => {
  it("stay consistent when the configured limit changes mid-session", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-limit-"),
    );
    try {
      const repository = await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        SMALL_LIMIT,
        producer,
      );
      // Comfortably over the small limit, comfortably under the raised one.
      const oversized = snapshot("chat-store/store.db", 2 * 1024 * 1024);

      // Before: the guard holds it back and publish would have rejected it.
      const held = guard(repository, oversized);
      expect(held.snapshots).toEqual([]);
      expect(held.warningsBySource.size).toBeGreaterThan(0);
      await expect(repository.publish([oversized], [])).rejects.toThrow(
        "Payload exceeds configured limit",
      );

      // The user follows the warning and raises cursorSettingSync.maxPayloadMiB.
      // No reopen happens: configurationChanged() only refreshes adapters.
      repository.setMaxPayloadBytes(RAISED_LIMIT);

      // After: the guard admits it and publish accepts it. Before the fix the
      // repository still held the value captured at open, so publish threw and
      // the error re-surfaced on every poll until Cursor restarted.
      const admitted = guard(repository, oversized);
      expect(admitted.snapshots).toHaveLength(1);
      expect(admitted.warningsBySource.size).toBe(0);
      const published = await repository.publish([oversized], []);
      expect(published.changeCount).toBe(1);

      // ...and lowering it again is equally consistent in the other direction.
      repository.setMaxPayloadBytes(SMALL_LIMIT);
      expect(guard(repository, oversized).snapshots).toEqual([]);
      await expect(repository.publish([oversized], [])).rejects.toThrow(
        "Payload exceeds configured limit",
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps history readable for a device whose limit is lower than the publisher's", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-limit-"),
    );
    try {
      const publisher = await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage-a"),
        "a sufficiently long test passphrase",
        RAISED_LIMIT,
        producer,
      );
      const large = snapshot("chat-store/store.db", 2 * 1024 * 1024);
      await publisher.publish([large], []);

      // Device B never raised its setting. What A already published is history
      // now; judging it by B's live limit failed every one of B's cycles with
      // "Object reference is invalid", and settings sync could not repair it
      // because settings ride the same wedged event log.
      const reader = await SyncRepository.open(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage-b"),
        "a sufficiently long test passphrase",
        SMALL_LIMIT,
        producer,
      );
      const events = await reader.listEvents();
      const resourceIds = events.flatMap((event) =>
        event.manifest.changes.map((change) => change.resourceId),
      );
      expect(resourceIds).toContain("chat-store/store.db");

      // B's own publishes stay bounded by B's own limit.
      await expect(
        reader.publish([snapshot("chat-store/other.db", 2 * 1024 * 1024)], []),
      ).rejects.toThrow("Payload exceeds configured limit");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

/** Exactly what performSync does: guard against the repository's own limit. */
function guard(repository: SyncRepository, ...snapshots: ResourceSnapshot[]) {
  return filterPublishableChanges(
    snapshots,
    [],
    repository.maxPayloadBytes,
    (snapshot) => `publish:${snapshot.kind}`,
  );
}

function snapshot(resourceId: string, byteLength: number): ResourceSnapshot {
  const content = Buffer.alloc(byteLength, "x");
  return {
    resourceId,
    kind: "chat-store",
    content,
    semanticHash: sha256(content),
  };
}
