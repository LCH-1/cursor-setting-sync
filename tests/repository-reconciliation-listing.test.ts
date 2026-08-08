import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventReconciler } from "../src/protocol/reconciler";
import {
  type DecryptedEvent,
  SyncRepository,
} from "../src/protocol/repository";
import { sha256 } from "../src/protocol/canonical";
import type { CheckpointManifest } from "../src/types";

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

describe("checkpoint-aware repository event listing", () => {
  it("reconciles identically from the full history and the checkpoint subset", async () => {
    const fixture = await checkpointFixture("equivalent");
    const postCheckpoint = await fixture.repository.publish(
      [snapshot("settings/default/test.after", "three")],
      [],
    );

    const full = await fixture.repository.listEvents();
    const subset = await fixture.repository.listReconciliationEvents(
      fixture.checkpoint,
    );

    expect(full.map(sequenceOf)).toEqual([1, 2, 3]);
    expect(subset.map(sequenceOf)).toEqual([3]);
    expect(subset[0]?.eventHash).toBe(postCheckpoint.eventHash);

    const fullState = structuredClone(fixture.repository.state);
    const subsetState = structuredClone(fixture.repository.state);
    const fullResult = new EventReconciler().reconcile(
      full,
      fullState,
      fixture.checkpoint,
    );
    const subsetResult = new EventReconciler().reconcile(
      subset,
      subsetState,
      fixture.checkpoint,
    );

    expect(subsetResult).toEqual(fullResult);
    expect(subsetState).toEqual(fullState);
  });

  it("skips deleted and corrupt covered events before decrypting them", async () => {
    const fixture = await checkpointFixture("covered-corrupt");
    const postCheckpoint = await fixture.repository.publish(
      [snapshot("settings/default/test.after", "three")],
      [],
    );
    if (
      fixture.first.eventPath === null ||
      fixture.second.eventPath === null
    ) {
      throw new Error("Test publish did not produce event paths.");
    }
    await rm(fixture.first.eventPath, { force: true });
    await writeFile(fixture.second.eventPath, "{", "utf8");
    const readEvent = spyOnReadEvent(fixture.repository);

    const subset = await fixture.repository.listReconciliationEvents(
      fixture.checkpoint,
    );

    expect(subset.map((event) => event.eventHash)).toEqual([
      postCheckpoint.eventHash,
    ]);
    expect(readEvent).not.toHaveBeenCalled();
  });

  it("appends a local publish to an already populated subset cache", async () => {
    const fixture = await checkpointFixture("publish-cache");
    await expect(
      fixture.repository.listReconciliationEvents(fixture.checkpoint),
    ).resolves.toEqual([]);
    const readEvent = spyOnReadEvent(fixture.repository);

    const published = await fixture.repository.publish(
      [snapshot("settings/default/test.after", "three")],
      [],
    );
    const listed = await fixture.repository.listReconciliationEvents(
      fixture.checkpoint,
    );

    expect(listed.map((event) => event.eventHash)).toEqual([
      published.eventHash,
    ]);
    expect(readEvent).not.toHaveBeenCalled();
  });

  it("keeps full history available after a checkpoint-filtered scan", async () => {
    const fixture = await checkpointFixture("full-history");
    await fixture.repository.publish(
      [snapshot("settings/default/test.after", "three")],
      [],
    );

    expect(
      (
        await fixture.repository.listReconciliationEvents(fixture.checkpoint)
      ).map(sequenceOf),
    ).toEqual([3]);
    expect((await fixture.repository.listEvents()).map(sequenceOf)).toEqual([
      1, 2, 3,
    ]);
  });

  it("detects a post-checkpoint event after refresh invalidates the subset cache", async () => {
    const fixture = await checkpointFixture("post-checkpoint");
    await expect(
      fixture.repository.listReconciliationEvents(fixture.checkpoint),
    ).resolves.toEqual([]);
    const published = await fixture.repository.publish(
      [snapshot("settings/default/test.after", "three")],
      [],
    );
    await fixture.repository.refreshState();

    const listed = await fixture.repository.listReconciliationEvents(
      fixture.checkpoint,
    );
    expect(listed.map((event) => event.eventHash)).toEqual([
      published.eventHash,
    ]);
  });

  it("still rejects a corrupt event newer than the checkpoint", async () => {
    const fixture = await checkpointFixture("post-checkpoint-corrupt");
    const published = await fixture.repository.publish(
      [snapshot("settings/default/test.after", "three")],
      [],
    );
    if (published.eventPath === null) {
      throw new Error("Test publish did not produce an event path.");
    }
    await fixture.repository.refreshState();
    await writeFile(published.eventPath, "{", "utf8");

    await expect(
      fixture.repository.listReconciliationEvents(fixture.checkpoint),
    ).rejects.toThrow();
  });

  it("counts valid event filenames without decrypting and honors a retired cursor", async () => {
    const temporaryRoot = await makeTemporaryRoot("count");
    const repository = await createRepository(temporaryRoot);
    await repository.publish(
      [snapshot("settings/default/test.one", "one")],
      [],
    );
    const second = await repository.publish(
      [snapshot("settings/default/test.two", "two")],
      [],
    );
    await repository.publish(
      [snapshot("settings/default/test.three", "three")],
      [],
    );
    const deviceId = repository.state.device.deviceId;
    const eventRoot = join(
      temporaryRoot,
      "repository",
      "devices",
      deviceId,
      "events",
    );
    await writeFile(join(eventRoot, "not-an-event.cse"), "ignored", "utf8");
    await writeFile(
      join(eventRoot, `${"0".repeat(16)}-${"e".repeat(64)}.cse`),
      "invalid zero sequence",
      "utf8",
    );
    await mkdir(
      join(
        eventRoot,
        `${String(99).padStart(16, "0")}-${"f".repeat(64)}.cse`,
      ),
    );
    repository.state.retiredDevices = [deviceId];
    repository.state.streams[deviceId] = {
      lastSequence: 2,
      lastEventHash: second.eventHash,
    };
    const readEvent = spyOnReadEvent(repository);

    await expect(repository.countEvents()).resolves.toBe(2);
    expect(readEvent).not.toHaveBeenCalled();
  });
});

interface CheckpointFixture {
  repository: SyncRepository;
  checkpoint: CheckpointManifest;
  first: Awaited<ReturnType<SyncRepository["publish"]>>;
  second: Awaited<ReturnType<SyncRepository["publish"]>>;
}

async function checkpointFixture(label: string): Promise<CheckpointFixture> {
  const temporaryRoot = await makeTemporaryRoot(label);
  const repository = await createRepository(temporaryRoot);
  const first = await repository.publish(
    [snapshot("settings/default/test.one", "one")],
    [],
  );
  const second = await repository.publish(
    [snapshot("settings/default/test.two", "two")],
    [],
  );
  new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  );
  await repository.createCheckpoint(true);
  const checkpoint = await repository.loadAbsorbedCheckpointManifest();
  if (checkpoint === null) {
    throw new Error("Test repository did not absorb its checkpoint.");
  }
  return { repository, checkpoint, first, second };
}

async function makeTemporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), `cursor-setting-sync-reconcile-list-${label}-`),
  );
  temporaryRoots.push(root);
  return root;
}

async function createRepository(root: string): Promise<SyncRepository> {
  return SyncRepository.create(
    join(root, "repository"),
    join(root, "storage"),
    "a sufficiently long test passphrase",
    1024 * 1024,
    producer,
  );
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

function sequenceOf(event: DecryptedEvent): number {
  return event.stored.header.sequence;
}

function spyOnReadEvent(repository: SyncRepository) {
  return vi.spyOn(
    repository as unknown as {
      readEvent: (...args: unknown[]) => Promise<DecryptedEvent>;
    },
    "readEvent",
  );
}
