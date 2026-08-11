import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyncRepository } from "../src/protocol/repository";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import type { StoredEvent, StoredObject } from "../src/types";

describe("repository stream rollback protection", () => {
  it("preserves the projections generation across an unchanged refresh", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-refresh-identity-"),
    );
    try {
      const repository = await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      const projections = repository.state.projections;

      await repository.refreshState();

      expect(repository.state.projections).toBe(projections);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("does not decrease its own head when a previously published tail disappears", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-rollback-"),
    );
    try {
      const repository = await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      const first = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      const second = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "16")],
        [],
      );
      expect(first.eventHash).not.toBeNull();
      expect(second.eventHash).not.toBeNull();
      expect(second.eventPath).not.toBeNull();

      const retiredReader = await SyncRepository.openWithMasterKey(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage-retired-reader"),
        repository.repository,
        Buffer.from(repository.masterKey),
        1024 * 1024,
        producer,
      );
      retiredReader.state.streams[repository.state.device.deviceId] = {
        lastSequence: 1,
        lastEventHash: first.eventHash ?? "",
      };
      retiredReader.state.retiredDevices.push(repository.state.device.deviceId);
      expect(
        (await retiredReader.listEvents()).map(
          (event) => event.stored.header.sequence,
        ),
      ).toEqual([1]);

      const pinnedHead = second.eventHash;
      const hiddenEvent = `${second.eventPath ?? ""}.hidden`;
      await rename(second.eventPath ?? "", hiddenEvent);

      await expect(repository.refreshState()).rejects.toThrow(
        /own-stream rollback detected.*event 2/i,
      );
      expect(repository.state.nextSequence).toBe(3);
      expect(repository.state.ownStreamHead).toBe(pinnedHead);
      expect(
        repository.state.streams[repository.state.device.deviceId],
      ).toEqual({
        lastSequence: 2,
        lastEventHash: pinnedHead,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("requires an empty folder when creating a repository", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-create-"),
    );
    try {
      const repositoryRoot = join(temporaryRoot, "repository");
      await mkdir(repositoryRoot, { recursive: true });
      const sentinel = join(repositoryRoot, "keep.txt");
      await writeFile(sentinel, "do not replace", "utf8");

      await expect(
        SyncRepository.create(
          repositoryRoot,
          join(temporaryRoot, "storage"),
          "a sufficiently long test passphrase",
          1024 * 1024,
          producer,
        ),
      ).rejects.toThrow(/requires an empty folder/i);
      expect(await readFile(sentinel, "utf8")).toBe("do not replace");
      await expect(
        readFile(join(repositoryRoot, "repo.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects hash-renamed envelopes with unknown fields", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-envelope-"),
    );
    try {
      const repositoryRoot = join(temporaryRoot, "repository");
      const repository = await SyncRepository.create(
        repositoryRoot,
        join(temporaryRoot, "storage-writer"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      const published = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      const eventPath = published.eventPath;
      expect(eventPath).not.toBeNull();
      const events = await repository.listEvents();
      const reference = events[0]?.manifest.changes[0]?.payload;
      expect(reference).toBeDefined();
      if (eventPath === null || reference === undefined) {
        throw new Error("Test repository did not publish its payload.");
      }

      const objectPath = join(
        repositoryRoot,
        "devices",
        reference.deviceId,
        "blobs",
        "sha256",
        reference.objectId.slice(0, 2),
        `${reference.objectId}.cso`,
      );
      const originalObject = JSON.parse(
        await readFile(objectPath, "utf8"),
      ) as StoredObject;
      await writeFile(
        objectPath,
        canonicalBytes({ ...originalObject, unexpected: true }),
      );
      await expect(repository.readObject(reference)).rejects.toThrow(
        /Object envelope is invalid/i,
      );
      await writeFile(objectPath, canonicalBytes(originalObject));

      const originalEvent = JSON.parse(
        await readFile(eventPath, "utf8"),
      ) as StoredEvent;
      const alteredEvent = { ...originalEvent, unexpected: true };
      const alteredHash = sha256(canonicalBytes(alteredEvent));
      const alteredPath = join(
        dirname(eventPath),
        `${String(originalEvent.header.sequence).padStart(16, "0")}-${alteredHash}.cse`,
      );
      await writeFile(alteredPath, canonicalBytes(alteredEvent));
      await rm(eventPath);

      const reader = await SyncRepository.openWithMasterKey(
        repositoryRoot,
        join(temporaryRoot, "storage-reader"),
        repository.repository,
        Buffer.from(repository.masterKey),
        1024 * 1024,
        producer,
      );
      await expect(reader.listEvents()).rejects.toThrow(
        /Event envelope is invalid/i,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("bounds an object envelope from its authenticated compressed size", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-object-bound-"),
    );
    try {
      const repositoryRoot = join(temporaryRoot, "repository");
      const repository = await SyncRepository.create(
        repositoryRoot,
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      const reference = (await repository.listEvents())[0]?.manifest.changes[0]
        ?.payload;
      expect(reference).toBeDefined();
      if (reference === undefined) {
        throw new Error("Test repository did not publish its payload.");
      }
      const objectPath = join(
        repositoryRoot,
        "devices",
        reference.deviceId,
        "blobs",
        "sha256",
        reference.objectId.slice(0, 2),
        `${reference.objectId}.cso`,
      );
      await writeFile(objectPath, "");
      await truncate(objectPath, 2 * 1024 * 1024);

      await expect(repository.readObject(reference)).rejects.toThrow(
        /Object envelope exceeds its size limit/i,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("bounds an event through the opened handle before parsing it", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-event-bound-"),
    );
    try {
      const repositoryRoot = join(temporaryRoot, "repository");
      const repository = await SyncRepository.create(
        repositoryRoot,
        join(temporaryRoot, "storage-writer"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      const published = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      expect(published.eventPath).not.toBeNull();
      if (published.eventPath === null) {
        throw new Error("Test repository did not publish an event.");
      }
      await truncate(published.eventPath, 9 * 1024 * 1024);
      const reader = await SyncRepository.openWithMasterKey(
        repositoryRoot,
        join(temporaryRoot, "storage-reader"),
        repository.repository,
        Buffer.from(repository.masterKey),
        1024 * 1024,
        producer,
      );

      await expect(reader.listEvents()).rejects.toThrow(
        /exceeds its size limit/i,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("repository checkpoint rollback protection", () => {
  it("fail-stops when the absorbed checkpoint disappears from shared and local storage", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-checkpoint-rollback-"),
    );
    try {
      const repository = await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      await repository.createCheckpoint(true);

      await rm(join(temporaryRoot, "repository", "checkpoints"), {
        recursive: true,
        force: true,
      });
      await rm(repository.localCheckpointsRoot, { recursive: true, force: true });
      await expect(repository.refreshState()).rejects.toThrow(
        /Checkpoint rollback detected/,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fail-stops when local state regressed below the checkpoint cursor without corroboration", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-regressed-"),
    );
    try {
      const repository = await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      const deviceId = repository.state.device.deviceId;
      const first = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      const second = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "16")],
        [],
      );
      await repository.createCheckpoint(true);

      await regressState(temporaryRoot, repository, {
        lastSequence: 1,
        lastEventHash: first.eventHash,
      });
      await rm(join(temporaryRoot, "repository", "devices", deviceId, "head.json"), {
        force: true,
      });
      await rm(first.eventPath ?? "", { force: true });
      await rm(second.eventPath ?? "", { force: true });

      await expect(
        SyncRepository.openWithMasterKey(
          join(temporaryRoot, "repository"),
          join(temporaryRoot, "storage"),
          repository.repository,
          Buffer.from(repository.masterKey),
          1024 * 1024,
          producer,
        ),
      ).rejects.toThrow(/older than the repository checkpoint/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("adopts the checkpoint cursor when head.json corroborates the regressed state", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-corroborated-"),
    );
    try {
      const repository = await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      const deviceId = repository.state.device.deviceId;
      const first = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      const second = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "16")],
        [],
      );
      await repository.createCheckpoint(true);

      await regressState(temporaryRoot, repository, {
        lastSequence: 1,
        lastEventHash: first.eventHash,
      });
      await rm(first.eventPath ?? "", { force: true });
      await rm(second.eventPath ?? "", { force: true });

      const reopened = await SyncRepository.openWithMasterKey(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        repository.repository,
        Buffer.from(repository.masterKey),
        1024 * 1024,
        producer,
      );
      expect(reopened.pendingRecoveryError).toBeNull();
      expect(reopened.state.nextSequence).toBe(3);
      expect(reopened.state.ownStreamHead).toBe(second.eventHash);
      expect(reopened.state.streams[deviceId]).toEqual({
        lastSequence: 2,
        lastEventHash: second.eventHash,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fail-stops when head.json records publishes beyond the visible walk end", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-walk-end-"),
    );
    try {
      const repository = await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );
      const deviceId = repository.state.device.deviceId;
      const first = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      const second = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "16")],
        [],
      );
      const third = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "18")],
        [],
      );
      repository.state.streams[deviceId] = {
        lastSequence: 2,
        lastEventHash: second.eventHash,
      };
      await repository.createCheckpoint(true);

      await regressState(temporaryRoot, repository, {
        lastSequence: 1,
        lastEventHash: first.eventHash,
      });
      const walkable = await SyncRepository.openWithMasterKey(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        repository.repository,
        Buffer.from(repository.masterKey),
        1024 * 1024,
        producer,
      );
      expect(walkable.state.nextSequence).toBe(4);
      expect(walkable.state.ownStreamHead).toBe(third.eventHash);

      await regressState(temporaryRoot, repository, {
        lastSequence: 1,
        lastEventHash: first.eventHash,
      });
      await rm(third.eventPath ?? "", { force: true });
      await expect(
        SyncRepository.openWithMasterKey(
          join(temporaryRoot, "repository"),
          join(temporaryRoot, "storage"),
          repository.repository,
          Buffer.from(repository.masterKey),
          1024 * 1024,
          producer,
        ),
      ).rejects.toThrow(/older than the repository checkpoint/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("repository creation in a git transport shell", () => {
  it("creates a repository in a folder that only holds .git", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-git-shell-"),
    );
    try {
      const root = join(temporaryRoot, "repository");
      await mkdir(join(root, ".git", "objects"), { recursive: true });

      const repository = await SyncRepository.create(
        root,
        join(temporaryRoot, "storage"),
        "a sufficiently long test passphrase",
        1024 * 1024,
        producer,
      );

      expect(repository.repository.repositoryId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("still refuses a folder that holds unrelated content", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-git-shell-"),
    );
    try {
      const root = join(temporaryRoot, "repository");
      await mkdir(join(root, ".git"), { recursive: true });
      await writeFile(join(root, "notes.txt"), "unrelated", "utf8");

      await expect(
        SyncRepository.create(
          root,
          join(temporaryRoot, "storage"),
          "a sufficiently long test passphrase",
          1024 * 1024,
          producer,
        ),
      ).rejects.toThrow("requires an empty folder");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

const producer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

function snapshot(resourceId: string, value: string) {
  const content = Buffer.from(value, "utf8");
  return {
    resourceId,
    kind: "settings" as const,
    content,
    semanticHash: sha256(content),
  };
}

async function regressState(
  temporaryRoot: string,
  repository: SyncRepository,
  cursor: { lastSequence: number; lastEventHash: string | null },
): Promise<void> {
  const path = join(
    temporaryRoot,
    "storage",
    `sync-state-${repository.repository.repositoryId}.json`,
  );
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  raw.nextSequence = cursor.lastSequence + 1;
  raw.ownStreamHead = cursor.lastEventHash;
  const streams = raw.streams as Record<string, unknown>;
  if (cursor.lastSequence === 0) {
    delete streams[repository.state.device.deviceId];
  } else {
    streams[repository.state.device.deviceId] = cursor;
  }
  await writeFile(path, JSON.stringify(raw), "utf8");
}
