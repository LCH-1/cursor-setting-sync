import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncRepository } from "../src/protocol/repository";

const temporaryRoots: string[] = [];
const producer = {
  extensionVersion: "0.0.62",
  cursorVersion: "3.15.6",
  vscodeVersion: "1.125.0",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("deferred repository open", () => {
  it("skips shared recovery, reloads fresh local state under the lock, and initializes once", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-repository-deferred-"));
    temporaryRoots.push(temporaryRoot);
    const storageRoot = join(temporaryRoot, "storage");
    const original = await SyncRepository.create(
      join(temporaryRoot, "repository"),
      storageRoot,
      "a sufficiently long test passphrase",
      4 * 1024 * 1024,
      producer,
    );
    const initializeDevice = vi.spyOn(
      SyncRepository.prototype as unknown as {
        initializeDevice(): Promise<void>;
      },
      "initializeDevice",
    );
    const deferred = await SyncRepository.openDeferredWithMasterKey(
      original.root,
      storageRoot,
      original.repository,
      Buffer.from(original.masterKey),
      4 * 1024 * 1024,
      producer,
    );

    expect(deferred.isInitialized).toBe(false);
    expect(initializeDevice).not.toHaveBeenCalled();

    // Optional fields absent from the newer atomic snapshot must be removed,
    // not retained by an Object.assign overlay from this stale instance.
    deferred.state.checkpoint = {
      hash: "b".repeat(64),
      lamport: 1,
      streams: {},
    };
    const newerSyncAt = "2026-08-08T12:34:56.000Z";
    original.state.lastSyncAt = newerSyncAt;
    await original.saveState();

    await Promise.all([
      deferred.ensureInitialized(),
      deferred.ensureInitialized(),
    ]);

    expect(deferred.isInitialized).toBe(true);
    expect(deferred.state.lastSyncAt).toBe(newerSyncAt);
    expect(deferred.state.checkpoint).toBeUndefined();
    expect(initializeDevice).toHaveBeenCalledOnce();

    await deferred.ensureInitialized();
    expect(initializeDevice).toHaveBeenCalledOnce();
  });

  it("defers missing device-state recovery until initialization under the lock", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-repository-load-only-"));
    temporaryRoots.push(temporaryRoot);
    const original = await SyncRepository.create(
      join(temporaryRoot, "repository"),
      join(temporaryRoot, "original-storage"),
      "a sufficiently long test passphrase",
      4 * 1024 * 1024,
      producer,
    );
    const freshStorage = join(temporaryRoot, "fresh-storage");

    const first = await SyncRepository.openDeferredWithMasterKey(
      original.root,
      freshStorage,
      original.repository,
      Buffer.from(original.masterKey),
      4 * 1024 * 1024,
      producer,
    );
    const follower = await SyncRepository.openDeferredWithMasterKey(
      original.root,
      freshStorage,
      original.repository,
      Buffer.from(original.masterKey),
      4 * 1024 * 1024,
      producer,
    );

    expect(first.isInitialized).toBe(false);
    expect(follower.isInitialized).toBe(false);

    // These calls model separate windows entering one at a time while holding
    // sync.lock. The first creates the replacement identity; the next reloads
    // it instead of persisting its own provisional identity.
    await first.ensureInitialized();
    await follower.ensureInitialized();

    expect(first.isInitialized).toBe(true);
    expect(follower.isInitialized).toBe(true);
    expect(follower.state.device.deviceId).toBe(first.state.device.deviceId);

    const full = await SyncRepository.openWithMasterKey(
      original.root,
      join(temporaryRoot, "full-open-storage"),
      original.repository,
      Buffer.from(original.masterKey),
      4 * 1024 * 1024,
      producer,
    );
    expect(full.isInitialized).toBe(true);
  });
});
