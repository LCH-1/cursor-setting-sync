import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKPOINT_EXTENSION,
  EVENT_EXTENSION,
} from "../src/constants";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { deriveSubkey, encryptAead } from "../src/protocol/crypto";
import { SyncRepository } from "../src/protocol/repository";
import type {
  JsonValue,
  ResourceDeletion,
  ResourceTip,
  StoredCheckpoint,
  StoredEvent,
} from "../src/types";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("repository JSON structural preflight", () => {
  it("rejects a structurally amplified event envelope before JSON.parse on every read", async () => {
    const fixture = await createPublishedFixture("event-envelope");
    await writeFile(fixture.eventPath, structurallyAmplifiedJson(22_000));
    const reader = await openReader(fixture, "event-envelope-reader");
    const parse = vi.spyOn(JSON, "parse");

    await expect(reader.listEvents()).rejects.toThrow(
      "Event envelope JSON exceeds the fixed structural safety limit.",
    );
    await expect(reader.listEvents()).rejects.toThrow(
      "Event envelope JSON exceeds the fixed structural safety limit.",
    );

    expect(parse).not.toHaveBeenCalled();
  });

  it("decrypts but rejects a structurally amplified event manifest before its JSON.parse", async () => {
    const fixture = await createPublishedFixture("event-manifest");
    const original = JSON.parse(
      await readFile(fixture.eventPath, "utf8"),
    ) as StoredEvent;
    const key = deriveSubkey(fixture.repository.masterKey, "event-encryption");
    const stored: StoredEvent = {
      header: original.header,
      ...encryptAead(
        key,
        structurallyAmplifiedJson(350_000),
        canonicalBytes(original.header),
      ),
    };
    const bytes = canonicalBytes(stored);
    const hash = sha256(bytes);
    const replacementPath = join(
      dirname(fixture.eventPath),
      `${String(original.header.sequence).padStart(16, "0")}-${hash}${EVENT_EXTENSION}`,
    );
    await writeFile(replacementPath, bytes);
    await rm(fixture.eventPath);
    const reader = await openReader(fixture, "event-manifest-reader");
    const parse = vi.spyOn(JSON, "parse");

    await expect(reader.listEvents()).rejects.toThrow(
      "Event manifest JSON exceeds the fixed structural safety limit.",
    );
    await expect(reader.listEvents()).rejects.toThrow(
      "Event manifest JSON exceeds the fixed structural safety limit.",
    );

    // Each attempt parses only the small outer envelope. The authenticated
    // hostile plaintext never reaches JSON.parse or manifest validation.
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("rejects a structurally amplified checkpoint envelope before JSON.parse on every read", async () => {
    const fixture = await createCheckpointFixture("checkpoint-envelope");
    await writeFile(
      fixture.checkpoint.filePath,
      structurallyAmplifiedJson(22_000),
    );
    const parse = vi.spyOn(JSON, "parse");

    await expect(
      readCheckpointFile(
        fixture.repository,
        fixture.checkpoint.filePath,
        fixture.checkpoint.checkpointHash,
        fixture.checkpoint.lamport,
      ),
    ).rejects.toThrow(
      "Checkpoint envelope JSON exceeds the fixed structural safety limit.",
    );
    await expect(
      readCheckpointFile(
        fixture.repository,
        fixture.checkpoint.filePath,
        fixture.checkpoint.checkpointHash,
        fixture.checkpoint.lamport,
      ),
    ).rejects.toThrow(
      "Checkpoint envelope JSON exceeds the fixed structural safety limit.",
    );

    expect(parse).not.toHaveBeenCalled();
  });

  it("decrypts but rejects a structurally amplified checkpoint manifest before its JSON.parse", async () => {
    const fixture = await createCheckpointFixture("checkpoint-manifest");
    const original = JSON.parse(
      await readFile(fixture.checkpoint.filePath, "utf8"),
    ) as StoredCheckpoint;
    const key = deriveSubkey(
      fixture.repository.masterKey,
      "checkpoint-encryption",
    );
    const stored: StoredCheckpoint = {
      header: original.header,
      ...encryptAead(
        key,
        structurallyAmplifiedJson(350_000),
        canonicalBytes(original.header),
      ),
    };
    const bytes = canonicalBytes(stored);
    const hash = sha256(bytes);
    const path = join(
      dirname(fixture.checkpoint.filePath),
      `${String(original.header.lamport).padStart(16, "0")}-${hash}${CHECKPOINT_EXTENSION}`,
    );
    await writeFile(path, bytes);
    const parse = vi.spyOn(JSON, "parse");

    await expect(
      readCheckpointFile(
        fixture.repository,
        path,
        hash,
        original.header.lamport,
      ),
    ).rejects.toThrow(
      "Checkpoint manifest JSON exceeds the fixed structural safety limit.",
    );
    await expect(
      readCheckpointFile(
        fixture.repository,
        path,
        hash,
        original.header.lamport,
      ),
    ).rejects.toThrow(
      "Checkpoint manifest JSON exceeds the fixed structural safety limit.",
    );

    // Each attempt parses only the outer envelope. The decrypted hostile
    // manifest is rejected before its object graph can be materialized.
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("keeps large scalar event ciphertext and manifest strings readable", async () => {
    const root = await trackedTemporaryRoot("large-scalar");
    const repositoryRoot = join(root, "repository");
    const repository = await SyncRepository.create(
      repositoryRoot,
      join(root, "storage-writer"),
      "a sufficiently long test passphrase",
      1024 * 1024,
      producer,
    );
    const content = Buffer.from("14", "utf8");
    const pad = "x".repeat(256 * 1024);
    await repository.publish(
      [
        {
          resourceId: "settings/default/editor.fontSize",
          kind: "settings",
          content,
          semanticHash: sha256(content),
          metadata: { pad },
        },
      ],
      [],
    );
    const reader = await SyncRepository.openWithMasterKey(
      repositoryRoot,
      join(root, "storage-reader"),
      repository.repository,
      Buffer.from(repository.masterKey),
      1024 * 1024,
      producer,
    );

    const events = await reader.listEvents();

    expect(events).toHaveLength(1);
    expect(events[0]?.manifest.changes[0]?.metadata?.pad).toBe(pad);
  });

  it("refuses an over-depth producer event before writing an event or mutating stream state", async () => {
    const root = await trackedTemporaryRoot("producer-event-refusal");
    const repositoryRoot = join(root, "repository");
    const repository = await SyncRepository.create(
      repositoryRoot,
      join(root, "storage"),
      "a sufficiently long test passphrase",
      1024 * 1024,
      producer,
    );
    const content = Buffer.from("14", "utf8");
    const before = {
      lamport: repository.state.lamport,
      nextSequence: repository.state.nextSequence,
      ownStreamHead: repository.state.ownStreamHead,
      stream: repository.state.streams[repository.state.device.deviceId],
    };

    await expect(
      repository.publish(
        [
          {
            resourceId: "settings/default/editor.fontSize",
            kind: "settings",
            content,
            semanticHash: sha256(content),
            metadata: { hostile: deeplyNestedJson(260) },
          },
        ],
        [],
      ),
    ).rejects.toThrow(
      "Event manifest JSON exceeds the fixed structural safety limit.",
    );

    expect(repository.state.lamport).toBe(before.lamport);
    expect(repository.state.nextSequence).toBe(before.nextSequence);
    expect(repository.state.ownStreamHead).toBe(before.ownStreamHead);
    expect(repository.state.streams[repository.state.device.deviceId]).toBe(
      before.stream,
    );
    await expect(eventFileNames(repositoryRoot, repository)).resolves.toEqual(
      [],
    );
  });

  it("refuses an over-depth producer checkpoint before writing a checkpoint or mutating checkpoint state", async () => {
    const fixture = await createPublishedFixture("producer-checkpoint-refusal");
    const event = (await fixture.repository.listEvents())[0];
    if (event === undefined) {
      throw new Error("Test repository did not retain its event.");
    }
    const tip = tipFromEvent(event, 0);
    tip.metadata = { hostile: deeplyNestedJson(260) };
    fixture.repository.state.tips = {
      "settings/default/editor.fontSize": [tip],
    };
    const before = {
      checkpoint: fixture.repository.state.checkpoint,
      lamport: fixture.repository.state.lamport,
      nextSequence: fixture.repository.state.nextSequence,
      ownStreamHead: fixture.repository.state.ownStreamHead,
    };

    await expect(fixture.repository.createCheckpoint(true)).rejects.toThrow(
      "Checkpoint manifest JSON exceeds the fixed structural safety limit.",
    );

    expect(fixture.repository.state.checkpoint).toBe(before.checkpoint);
    expect(fixture.repository.state.lamport).toBe(before.lamport);
    expect(fixture.repository.state.nextSequence).toBe(before.nextSequence);
    expect(fixture.repository.state.ownStreamHead).toBe(before.ownStreamHead);
    await expect(checkpointFileNames(fixture.repositoryRoot)).resolves.toEqual(
      [],
    );
  });

  it("round-trips one maximum-count 10,000-change ordinary event", async () => {
    const root = await trackedTemporaryRoot("ten-thousand-event");
    const repositoryRoot = join(root, "repository");
    const repository = await SyncRepository.create(
      repositoryRoot,
      join(root, "storage-writer"),
      "a sufficiently long test passphrase",
      1024 * 1024,
      producer,
    );
    const semanticHash = sha256(Buffer.alloc(0));
    const deletions: ResourceDeletion[] = Array.from(
      { length: 10_000 },
      (_, index) => ({
        resourceId: `settings/default/key-${String(index).padStart(5, "0")}`,
        kind: "settings",
        semanticHash,
        parents: [],
      }),
    );

    await repository.publish([], deletions);
    const reader = await SyncRepository.openWithMasterKey(
      repositoryRoot,
      join(root, "storage-reader"),
      repository.repository,
      Buffer.from(repository.masterKey),
      1024 * 1024,
      producer,
    );
    const events = await reader.listEvents();

    expect(events).toHaveLength(1);
    expect(events[0]?.manifest.changes).toHaveLength(10_000);
  });

  it("round-trips one 10,000-resource ordinary checkpoint", async () => {
    const root = await trackedTemporaryRoot("ten-thousand-checkpoint");
    const repositoryRoot = join(root, "repository");
    const repository = await SyncRepository.create(
      repositoryRoot,
      join(root, "storage-writer"),
      "a sufficiently long test passphrase",
      1024 * 1024,
      producer,
    );
    const eventHash = "a".repeat(64);
    const semanticHash = sha256(Buffer.alloc(0));
    const deviceId = repository.state.device.deviceId;
    const tips: Record<string, ResourceTip[]> = {};
    for (let index = 0; index < 10_000; index += 1) {
      const resourceId = `settings/default/key-${String(index).padStart(5, "0")}`;
      tips[resourceId] = [
        {
          versionId: `${eventHash}#${index}`,
          eventHash,
          changeIndex: index,
          kind: "settings",
          lamport: 1,
          deviceId,
          operation: "delete",
          semanticHash,
          parents: [],
        },
      ];
    }
    repository.state.tips = tips;

    const created = await repository.createCheckpoint(true);
    const reader = await SyncRepository.openWithMasterKey(
      repositoryRoot,
      join(root, "storage-reader"),
      repository.repository,
      Buffer.from(repository.masterKey),
      1024 * 1024,
      producer,
    );
    const manifest = await reader.loadAbsorbedCheckpointManifest();

    expect(created.resourceCount).toBe(10_000);
    expect(manifest?.resources).toHaveLength(10_000);
  });
});

const producer = {
  extensionVersion: "0.0.63",
  cursorVersion: "3.16.0",
  vscodeVersion: "1.126.0",
};

interface PublishedFixture {
  root: string;
  repositoryRoot: string;
  repository: SyncRepository;
  eventPath: string;
}

async function createPublishedFixture(label: string): Promise<PublishedFixture> {
  const root = await trackedTemporaryRoot(label);
  const repositoryRoot = join(root, "repository");
  const repository = await SyncRepository.create(
    repositoryRoot,
    join(root, "storage-writer"),
    "a sufficiently long test passphrase",
    1024 * 1024,
    producer,
  );
  const content = Buffer.from("14", "utf8");
  const published = await repository.publish(
    [
      {
        resourceId: "settings/default/editor.fontSize",
        kind: "settings",
        content,
        semanticHash: sha256(content),
      },
    ],
    [],
  );
  if (published.eventPath === null) {
    throw new Error("Test repository did not publish an event.");
  }
  return {
    root,
    repositoryRoot,
    repository,
    eventPath: published.eventPath,
  };
}

async function openReader(
  fixture: PublishedFixture,
  storageName: string,
): Promise<SyncRepository> {
  return SyncRepository.openWithMasterKey(
    fixture.repositoryRoot,
    join(fixture.root, storageName),
    fixture.repository.repository,
    Buffer.from(fixture.repository.masterKey),
    1024 * 1024,
    producer,
  );
}

async function createCheckpointFixture(label: string): Promise<{
  repository: SyncRepository;
  checkpoint: Awaited<ReturnType<SyncRepository["createCheckpoint"]>>;
}> {
  const fixture = await createPublishedFixture(label);
  const checkpoint = await fixture.repository.createCheckpoint(true);
  return { repository: fixture.repository, checkpoint };
}

function readCheckpointFile(
  repository: SyncRepository,
  path: string,
  expectedHash: string,
  expectedLamport: number | null,
): Promise<unknown> {
  return (
    repository as unknown as {
      readCheckpointFile(
        filePath: string,
        hash: string,
        lamport: number | null,
      ): Promise<unknown>;
    }
  ).readCheckpointFile(path, expectedHash, expectedLamport);
}

function tipFromEvent(
  event: Awaited<ReturnType<SyncRepository["listEvents"]>>[number],
  changeIndex: number,
): ResourceTip {
  const change = event.manifest.changes[changeIndex];
  if (change === undefined) {
    throw new Error("Test event does not contain the requested change.");
  }
  const tip: ResourceTip = {
    versionId: `${event.eventHash}#${changeIndex}`,
    eventHash: event.eventHash,
    changeIndex,
    kind: change.kind as ResourceTip["kind"],
    lamport: event.manifest.lamport,
    createdAt: event.manifest.createdAt,
    deviceId: event.stored.header.deviceId,
    operation: change.operation,
    semanticHash: change.semanticHash,
    parents: [...change.parents],
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
  return tip;
}

function deeplyNestedJson(depth: number): JsonValue {
  let value: JsonValue = 0;
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

function structurallyAmplifiedJson(objectCount: number): Buffer {
  const tinyObjects = Array.from({ length: objectCount }, () => "{}").join(",");
  return Buffer.from(`[${tinyObjects}]`, "utf8");
}

async function eventFileNames(
  repositoryRoot: string,
  repository: SyncRepository,
): Promise<string[]> {
  return directoryFileNames(
    join(
      repositoryRoot,
      "devices",
      repository.state.device.deviceId,
      "events",
    ),
  );
}

async function checkpointFileNames(repositoryRoot: string): Promise<string[]> {
  return directoryFileNames(join(repositoryRoot, "checkpoints"));
}

async function directoryFileNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function trackedTemporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `repository-json-${label}-`));
  temporaryRoots.push(root);
  return root;
}
