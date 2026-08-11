import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../src/protocol/canonical";
import { LocalStateStore } from "../src/protocol/localState";
import { EventReconciler } from "../src/protocol/reconciler";
import {
  type RepositoryDiagnostics,
  SyncRepository,
} from "../src/protocol/repository";

const temporaryRoots: string[] = [];
const producer = {
  extensionVersion: "0.0.63",
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

describe("repository idle refresh generations", () => {
  it("opens no event files and does no local-state body work on the second unchanged poll", async () => {
    const root = await temporaryRoot("unchanged");
    const counts = {
      eventDirectoryReads: 0,
      eventFileStats: 0,
      checkpointDirectoryReads: 0,
      stateReads: 0,
      stateParses: 0,
      stateStringifies: 0,
    };
    const diagnostics: RepositoryDiagnostics = {
      onEventDirectoryRead: () => {
        counts.eventDirectoryReads += 1;
      },
      onEventFileStat: () => {
        counts.eventFileStats += 1;
      },
      onCheckpointDirectoryRead: () => {
        counts.checkpointDirectoryReads += 1;
      },
      localState: {
        onRead: () => {
          counts.stateReads += 1;
        },
        onParse: () => {
          counts.stateParses += 1;
        },
        onStringify: () => {
          counts.stateStringifies += 1;
        },
      },
    };
    const repository = await SyncRepository.create(
      join(root, "repository"),
      join(root, "storage"),
      "a sufficiently long test passphrase",
      1024 * 1024,
      producer,
      diagnostics,
    );
    await repository.publish([snapshot("settings/default/test", "one")], []);
    new EventReconciler().reconcile(
      await repository.listEvents(),
      repository.state,
      null,
    );
    const checkpoint = await repository.createCheckpoint(true);
    await repository.refreshState();
    await repository.listEvents();
    const checkpointBytes = await readFile(checkpoint.filePath);
    await writeFile(checkpoint.filePath, "{", "utf8");
    repository.invalidateSharedGraphObservation();
    await expect(repository.refreshState()).rejects.toThrow();
    await writeFile(checkpoint.filePath, checkpointBytes);
    repository.invalidateSharedGraphObservation();
    await repository.refreshState();
    await repository.listEvents();
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[key] = 0;
    }
    const projections = repository.state.projections;
    const sharedGeneration = repository.sharedGraphGeneration;
    const localGeneration = repository.localStateGeneration;

    await repository.refreshState();
    await repository.listEvents();

    expect(counts).toEqual({
      eventDirectoryReads: 0,
      eventFileStats: 0,
      checkpointDirectoryReads: 0,
      stateReads: 0,
      stateParses: 0,
      stateStringifies: 0,
    });
    expect(repository.state.projections).toBe(projections);
    expect(repository.sharedGraphGeneration).toBe(sharedGeneration);
    expect(repository.localStateGeneration).toBe(localGeneration);
  });

  it("keeps a populated large-history cache after confirming only its own publish", async () => {
    // This deliberately performs 96 real atomic publishes. Leave enough
    // headroom for filesystem contention when the full suite runs in parallel.
    const root = await temporaryRoot("self-publish");
    const counts = { eventDirectoryReads: 0, eventFileStats: 0 };
    const repository = await SyncRepository.create(
      join(root, "repository"),
      join(root, "storage"),
      "a sufficiently long test passphrase",
      1024 * 1024,
      producer,
      {
        onEventDirectoryRead: () => {
          counts.eventDirectoryReads += 1;
        },
        onEventFileStat: () => {
          counts.eventFileStats += 1;
        },
      },
    );
    await repository.listEvents();
    for (let index = 0; index < 95; index += 1) {
      await repository.publish(
        [snapshot(`settings/default/history-${index}`, String(index))],
        [],
      );
    }
    await repository.refreshState();
    await repository.listEvents();
    await repository.publish(
      [snapshot("settings/default/history-95", "95")],
      [],
    );
    const readEvent = vi.spyOn(
      repository as unknown as {
        readEvent: (...args: unknown[]) => Promise<unknown>;
      },
      "readEvent",
    );
    counts.eventDirectoryReads = 0;
    counts.eventFileStats = 0;
    const generation = repository.sharedGraphGeneration;

    await repository.refreshState();
    await expect(repository.listEvents()).resolves.toHaveLength(96);

    expect(counts).toEqual({ eventDirectoryReads: 0, eventFileStats: 0 });
    expect(readEvent).not.toHaveBeenCalled();
    expect(repository.sharedGraphGeneration).toBe(generation);
  }, 15_000);

  it("does not let self-publish confirmation hide a concurrent peer event", async () => {
    const root = await temporaryRoot("self-and-peer");
    const repositoryRoot = join(root, "repository");
    const writer = await SyncRepository.create(
      repositoryRoot,
      join(root, "storage-writer"),
      "a sufficiently long test passphrase",
      1024 * 1024,
      producer,
    );
    let eventFileStats = 0;
    const reader = await SyncRepository.openWithMasterKey(
      repositoryRoot,
      join(root, "storage-reader"),
      writer.repository,
      Buffer.from(writer.masterKey),
      1024 * 1024,
      producer,
      {
        onEventFileStat: () => {
          eventFileStats += 1;
        },
      },
    );
    await reader.listEvents();
    const own = await reader.publish(
      [snapshot("settings/default/own", "own")],
      [],
    );
    const generationAfterSelfPublish = reader.sharedGraphGeneration;
    const peer = await writer.publish(
      [snapshot("settings/default/peer", "peer")],
      [],
    );
    eventFileStats = 0;

    await reader.refreshState();
    const hashes = (await reader.listEvents()).map((event) => event.eventHash);

    expect(hashes).toEqual(expect.arrayContaining([own.eventHash, peer.eventHash]));
    expect(eventFileStats).toBeGreaterThan(0);
    expect(reader.sharedGraphGeneration).toBe(generationAfterSelfPublish + 1);
  });

  it("detects external event and local-state changes without false generation bumps", async () => {
    const root = await temporaryRoot("external");
    const repositoryRoot = join(root, "repository");
    const writer = await SyncRepository.create(
      repositoryRoot,
      join(root, "storage-writer"),
      "a sufficiently long test passphrase",
      1024 * 1024,
      producer,
    );
    const reader = await SyncRepository.openWithMasterKey(
      repositoryRoot,
      join(root, "storage-reader"),
      writer.repository,
      Buffer.from(writer.masterKey),
      1024 * 1024,
      producer,
    );
    await reader.listEvents();
    const sharedBefore = reader.sharedGraphGeneration;
    const published = await writer.publish(
      [snapshot("settings/default/external", "two")],
      [],
    );

    await reader.refreshState();

    expect((await reader.listEvents()).map((event) => event.eventHash)).toContain(
      published.eventHash,
    );
    expect(reader.sharedGraphGeneration).toBe(sharedBefore + 1);

    const sharedAfterEvent = reader.sharedGraphGeneration;
    const localBefore = reader.localStateGeneration;
    const reconciliationBefore = reader.reconciliationInputGeneration;
    const externalState = new LocalStateStore(join(root, "storage-reader"));
    const state = await externalState.load(reader.repository.repositoryId);
    state.lastError = "written by another process";
    await externalState.save(state);

    // A manual/shared-file audit must still pick up another window's atomic
    // local-state replacement, without forcing a duplicate body read when its
    // strong identity has not changed.
    await reader.refreshState({ forceAudit: true });

    expect(reader.state.lastError).toBe("written by another process");
    expect(reader.localStateGeneration).toBe(localBefore + 1);
    expect(reader.sharedGraphGeneration).toBe(sharedAfterEvent);
    expect(reader.reconciliationInputGeneration).toBe(reconciliationBefore);

    await reader.saveState();
    expect(reader.localStateGeneration).toBe(localBefore + 1);
    reader.state.lastError = null;
    await reader.saveState();
    expect(reader.localStateGeneration).toBe(localBefore + 2);
    expect(reader.reconciliationInputGeneration).toBe(reconciliationBefore);
    reader.state.lamport += 1;
    await reader.saveState();
    expect(reader.localStateGeneration).toBe(localBefore + 3);
    expect(reader.reconciliationInputGeneration).toBe(
      reconciliationBefore + 1,
    );
  });

  it("forces a full immutable-file audit even when metadata looks unchanged", async () => {
    const root = await temporaryRoot("force-audit");
    const repository = await SyncRepository.create(
      join(root, "repository"),
      join(root, "storage"),
      "a sufficiently long test passphrase",
      1024 * 1024,
      producer,
    );
    const published = await repository.publish(
      [snapshot("settings/default/corrupt", "three")],
      [],
    );
    if (published.eventPath === null) {
      throw new Error("Test publish did not create an event file.");
    }
    await repository.refreshState();
    await repository.listEvents();
    const original = await readFile(published.eventPath);
    await writeFile(published.eventPath, "{", "utf8");

    repository.invalidateSharedGraphObservation();
    await expect(repository.refreshState()).rejects.toThrow();

    await writeFile(published.eventPath, original);
    repository.invalidateSharedGraphObservation();
    await repository.refreshState();
    await writeFile(published.eventPath, "{", "utf8");

    await repository.refreshState();
    await expect(repository.listEvents()).resolves.toHaveLength(1);
    await expect(
      repository.refreshState({ forceAudit: true }),
    ).rejects.toThrow();
  });
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), `cursor-setting-sync-idle-${label}-`),
  );
  temporaryRoots.push(root);
  return root;
}

function snapshot(resourceId: string, value: string) {
  const content = Buffer.from(value, "utf8");
  return {
    resourceId,
    kind: "settings" as const,
    content,
    semanticHash: sha256(content),
  };
}
