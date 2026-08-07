import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SyncRepository } from "../src/protocol/repository";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { decryptAead, deriveSubkey, encryptAead } from "../src/protocol/crypto";
import {
  CHECKPOINT_ENVELOPE_VERSION,
  CHECKPOINT_EXTENSION,
  CHECKPOINTED_EVENT_PROTOCOL_VERSION,
  MAX_CHECKPOINT_FILE_BYTES,
  PROTOCOL_VERSION,
} from "../src/constants";
import type {
  CheckpointManifest,
  ResourceKind,
  ResourceTip,
  StoredCheckpoint,
  StoredEvent,
} from "../src/types";

describe("repository checkpoints", () => {
  it("collects selected resource histories with one event traversal", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-history-"));
    try {
      const repository = await createRepository(temporaryRoot);
      await repository.publish(
        [
          snapshot("settings/default/editor.fontSize", "14"),
          snapshot("settings/default/editor.tabSize", "2"),
        ],
        [],
      );
      await repository.publish(
        [
          snapshot("settings/default/editor.fontSize", "16"),
          snapshot("settings/default/editor.wordWrap", "on"),
        ],
        [],
      );
      const listEvents = vi.spyOn(repository, "listEvents");

      const histories = await repository.listResourceHistories(
        new Set([
          "settings/default/editor.fontSize",
          "settings/default/editor.tabSize",
          "settings/default/missing",
        ]),
      );

      expect(listEvents).toHaveBeenCalledTimes(1);
      expect(histories.get("settings/default/editor.fontSize")).toHaveLength(2);
      expect(histories.get("settings/default/editor.tabSize")).toHaveLength(1);
      expect(histories.has("settings/default/editor.wordWrap")).toBe(false);
      expect(histories.has("settings/default/missing")).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("limits restore history to trusted ancestors of the reconciled tip", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-ancestors-"));
    try {
      const repository = await createRepository(temporaryRoot);
      const resourceId = "settings/default/editor.fontSize";
      const first = await repository.publish(
        [{ ...snapshot(resourceId, "14"), parents: [] }],
        [],
      );
      const firstVersion = `${first.eventHash}#0`;
      const second = await repository.publish(
        [{ ...snapshot(resourceId, "16"), parents: [firstVersion] }],
        [],
      );
      const secondVersion = `${second.eventHash}#0`;
      const sibling = await repository.publish(
        [{ ...snapshot(resourceId, "15"), parents: [firstVersion] }],
        [],
      );
      const siblingVersion = `${sibling.eventHash}#0`;
      const trusted = new Set([
        first.eventHash ?? "",
        second.eventHash ?? "",
        sibling.eventHash ?? "",
      ]);

      const histories = await repository.listReachableResourceHistories(
        new Set([resourceId]),
        new Map([[resourceId, [secondVersion]]]),
        trusted,
        null,
      );

      expect(histories.get(resourceId)?.map((entry) => entry.versionId)).toEqual([
        secondVersion,
        firstVersion,
      ]);
      expect(histories.get(resourceId)?.some(
        (entry) => entry.versionId === siblingVersion,
      )).toBe(false);

      const unacceptedRoot = await repository.listReachableResourceHistories(
        new Set([resourceId]),
        new Map([[resourceId, [siblingVersion]]]),
        new Set([first.eventHash ?? "", second.eventHash ?? ""]),
        null,
      );
      expect(unacceptedRoot.has(resourceId)).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps visible pre-checkpoint ancestors on the checkpoint's pinned stream", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-folded-history-"));
    try {
      const repository = await createRepository(temporaryRoot);
      const resourceId = "settings/default/editor.fontSize";
      const first = await repository.publish(
        [{ ...snapshot(resourceId, "14"), parents: [] }],
        [],
      );
      const firstVersion = `${first.eventHash}#0`;
      const second = await repository.publish(
        [{ ...snapshot(resourceId, "16"), parents: [firstVersion] }],
        [],
      );
      const secondVersion = `${second.eventHash}#0`;
      await adoptTips(repository);
      await repository.createCheckpoint(true);
      const checkpoint = await repository.loadAbsorbedCheckpointManifest();

      const histories = await repository.listReachableResourceHistories(
        new Set([resourceId]),
        new Map([[resourceId, [secondVersion]]]),
        new Set(),
        checkpoint,
      );

      expect(histories.get(resourceId)?.map((entry) => entry.versionId)).toEqual([
        secondVersion,
        firstVersion,
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("folds active tips and cursors into a checkpoint, absorbs it, and switches to v2 events", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-checkpoint-"));
    try {
      const repository = await createRepository(temporaryRoot);
      const first = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      await repository.publish(
        [
          snapshot("settings/default/editor.fontSize", "16"),
          snapshot("settings/default/editor.tabSize", "2"),
        ],
        [],
      );
      await repository.publish(
        [],
        [
          {
            resourceId: "settings/default/editor.wordWrap",
            kind: "settings" as const,
            semanticHash: sha256(Buffer.from("", "utf8")),
          },
        ],
      );
      await adoptTips(repository);
      const tipsAtCreate = JSON.parse(
        JSON.stringify(repository.state.tips),
      ) as Record<string, ResourceTip[]>;
      const streamsAtCreate = JSON.parse(JSON.stringify(repository.state.streams)) as Record<
        string,
        { lastSequence: number; lastEventHash: string }
      >;
      const lamportBefore = repository.state.lamport;

      const created = await repository.createCheckpoint(true);
      expect(created.lamport).toBe(lamportBefore + 1);
      expect(created.resourceCount).toBe(3);
      expect(repository.state.checkpoint?.hash).toBe(created.checkpointHash);
      expect(repository.state.checkpoint?.lamport).toBe(created.lamport);
      expect(repository.state.checkpoint?.streams).toEqual(streamsAtCreate);
      expect(repository.state.lamport).toBe(created.lamport);

      const shared = await readSharedCheckpoints(
        join(temporaryRoot, "repository"),
        repository,
      );
      expect(shared).toHaveLength(1);
      const manifest = shared[0]?.manifest;
      expect(shared[0]?.hash).toBe(created.checkpointHash);
      expect(manifest?.predecessorHash).toBeNull();
      expect(manifest?.streams).toEqual(streamsAtCreate);
      expect(manifest?.resources.map((resource) => resource.resourceId)).toEqual([
        "settings/default/editor.fontSize",
        "settings/default/editor.tabSize",
        "settings/default/editor.wordWrap",
      ]);
      const foldedFontSize = manifest?.resources[0];
      const fontSizeTip = tipsAtCreate["settings/default/editor.fontSize"]?.[0];
      expect(foldedFontSize?.versionId).toBe(fontSizeTip?.versionId);
      expect(foldedFontSize?.operation).toBe("put");
      expect(foldedFontSize?.semanticHash).toBe(sha256(Buffer.from("16", "utf8")));
      expect(foldedFontSize?.lamport).toBe(fontSizeTip?.lamport);
      expect(foldedFontSize?.payload).toEqual(fontSizeTip?.payload);
      const foldedWordWrap = manifest?.resources[2];
      expect(foldedWordWrap?.operation).toBe("delete");
      expect(foldedWordWrap?.payload).toBeUndefined();

      expect(await readdir(repository.localCheckpointsRoot)).toContain(
        `${created.checkpointHash}${CHECKPOINT_EXTENSION}`,
      );
      const acks = await repository.readDeviceAcks(repository.state.device.deviceId);
      expect(acks?.absorbedCheckpoint).toEqual({
        hash: created.checkpointHash,
        lamport: created.lamport,
      });

      const fourth = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "18")],
        [],
      );
      const firstHeader = (
        JSON.parse(await readFile(first.eventPath ?? "", "utf8")) as StoredEvent
      ).header;
      const fourthHeader = (
        JSON.parse(await readFile(fourth.eventPath ?? "", "utf8")) as StoredEvent
      ).header;
      expect(firstHeader.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(fourthHeader.protocolVersion).toBe(CHECKPOINTED_EVENT_PROTOCOL_VERSION);
      expect(await repository.listEvents()).toHaveLength(4);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("prunes only events at or below the checkpoint cursors and publishes an equivalent v2 marker", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-prune-"));
    try {
      const repository = await createRepository(temporaryRoot);
      const deviceId = repository.state.device.deviceId;
      const first = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      const second = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "16")],
        [],
      );
      await adoptTips(repository);
      const older = await repository.createCheckpoint(true);
      await repository.publish([snapshot("settings/default/editor.tabSize", "4")], []);
      await adoptTips(repository);
      const newest = await repository.createCheckpoint(true);
      const fourth = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "18")],
        [],
      );
      await adoptTips(repository);

      const preHistory = await repository.listResourceHistory(
        "settings/default/editor.fontSize",
      );
      expect(preHistory.map((entry) => entry.fromCheckpoint)).toEqual([
        false,
        false,
        false,
      ]);
      expect(
        preHistory.filter((entry) => entry.versionId === `${second.eventHash}#0`),
      ).toHaveLength(1);

      const payloadByContent = new Map<string, string>();
      for (const event of await repository.listEvents()) {
        for (const change of event.manifest.changes) {
          if (change.payload !== undefined) {
            payloadByContent.set(change.semanticHash, change.payload.objectId);
          }
        }
      }

      const result = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(result.status).toBe("pruned");
      expect(result.eventsDeleted).toBe(3);
      expect(result.checkpointFilesDeleted).toBe(1);
      expect(result.markerEventHash).not.toBeNull();

      const eventFiles = await readdir(
        join(temporaryRoot, "repository", "devices", deviceId, "events"),
      );
      expect(eventFiles.map((file) => Number(file.slice(0, 16))).sort()).toEqual([4, 5]);
      const sharedFiles = await readdir(join(temporaryRoot, "repository", "checkpoints"));
      expect(sharedFiles).toHaveLength(1);
      expect(sharedFiles[0]).toContain(newest.checkpointHash);
      expect(sharedFiles[0]).not.toContain(older.checkpointHash);

      const marker = (await repository.listEvents()).find(
        (event) => event.eventHash === result.markerEventHash,
      );
      expect(marker?.stored.header.protocolVersion).toBe(
        CHECKPOINTED_EVENT_PROTOCOL_VERSION,
      );
      const markerChange = marker?.manifest.changes[0];
      expect(markerChange?.resourceId).toBe("settings/default/editor.fontSize");
      expect(markerChange?.operation).toBe("put");
      expect(markerChange?.semanticHash).toBe(sha256(Buffer.from("18", "utf8")));
      expect(markerChange?.parents).toEqual([`${fourth.eventHash}#0`]);
      expect(markerChange?.metadata?.syncOrigin).toBe("checkpoint-marker");

      const folded = await repository.readVersion(`${second.eventHash}#0`);
      expect(folded.content?.toString("utf8")).toBe("16");
      expect(folded.change.parents).toEqual([]);
      expect(await repository.tryReadVersion(`${first.eventHash}#0`)).toBeNull();
      expect(await repository.tryReadVersion(`${"a".repeat(64)}#0`)).toBeNull();

      const postHistory = await repository.listResourceHistory(
        "settings/default/editor.fontSize",
      );
      expect(postHistory.map((entry) => entry.fromCheckpoint)).toEqual([
        false,
        false,
        true,
      ]);
      expect(postHistory[0]?.versionId).toBe(`${result.markerEventHash}#0`);
      expect(postHistory[1]?.versionId).toBe(`${fourth.eventHash}#0`);
      expect(postHistory[2]?.versionId).toBe(`${second.eventHash}#0`);

      await repository.compactOwnOrphans(true);
      const blobRoot = join(
        temporaryRoot,
        "repository",
        "devices",
        deviceId,
        "blobs",
        "sha256",
      );
      const orphanId = payloadByContent.get(sha256(Buffer.from("14", "utf8"))) ?? "";
      const retainedIds = ["16", "4", "18"].map(
        (content) => payloadByContent.get(sha256(Buffer.from(content, "utf8"))) ?? "",
      );
      expect(await fileExists(join(blobRoot, orphanId.slice(0, 2), `${orphanId}.cso`))).toBe(
        false,
      );
      for (const retained of retainedIds) {
        expect(
          await fileExists(join(blobRoot, retained.slice(0, 2), `${retained}.cso`)),
        ).toBe(true);
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("re-opens after its own events were pruned by absorbing the checkpoint first", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-reopen-"));
    try {
      const repository = await createRepository(temporaryRoot);
      const deviceId = repository.state.device.deviceId;
      await repository.publish([snapshot("settings/default/editor.fontSize", "14")], []);
      await repository.publish([snapshot("settings/default/editor.fontSize", "16")], []);
      await adoptTips(repository);
      const created = await repository.createCheckpoint(true);

      const eventRoot = join(temporaryRoot, "repository", "devices", deviceId, "events");
      for (const file of await readdir(eventRoot)) {
        await rm(join(eventRoot, file), { force: true });
      }
      const statePath = stateFilePath(temporaryRoot, repository.repository.repositoryId);
      const rawState = JSON.parse(await readFile(statePath, "utf8")) as Record<
        string,
        unknown
      >;
      delete rawState.checkpoint;
      await writeFile(statePath, JSON.stringify(rawState), "utf8");

      const reopened = await reopen(temporaryRoot, repository);
      expect(reopened.pendingRecoveryError).toBeNull();
      expect(reopened.state.nextSequence).toBe(3);
      expect(reopened.state.checkpoint?.hash).toBe(created.checkpointHash);
      const published = await reopened.publish(
        [snapshot("settings/default/editor.fontSize", "18")],
        [],
      );
      const header = (
        JSON.parse(await readFile(published.eventPath ?? "", "utf8")) as StoredEvent
      ).header;
      expect(header.sequence).toBe(3);
      expect(header.protocolVersion).toBe(CHECKPOINTED_EVENT_PROTOCOL_VERSION);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("degrades instead of wedging when own events vanish before their checkpoint arrives", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-degraded-"));
    try {
      const repository = await createRepository(temporaryRoot);
      const deviceId = repository.state.device.deviceId;
      const first = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      await rm(first.eventPath ?? "", { force: true });

      const reopened = await reopen(temporaryRoot, repository);
      expect(reopened.pendingRecoveryError).not.toBeNull();
      expect(reopened.pendingRecoveryError?.message).toMatch(
        /own-stream rollback detected/i,
      );
      await expect(
        reopened.publish([snapshot("settings/default/editor.fontSize", "16")], []),
      ).rejects.toThrow(/own-stream rollback detected/i);
      await expect(reopened.refreshState()).rejects.toThrow(
        /own-stream rollback detected/i,
      );

      const crafted = craftCheckpoint(reopened, {
        checkpointVersion: 1,
        createdAt: new Date().toISOString(),
        deviceId: "deviceB",
        lamport: 2,
        predecessorHash: null,
        streams: {
          [deviceId]: { lastSequence: 1, lastEventHash: first.eventHash ?? "" },
        },
        resources: [],
      });
      await mkdir(join(temporaryRoot, "repository", "checkpoints"), { recursive: true });
      await writeFile(
        join(temporaryRoot, "repository", "checkpoints", crafted.fileName),
        crafted.bytes,
      );
      await reopened.refreshState();
      expect(reopened.pendingRecoveryError).toBeNull();
      expect(reopened.state.checkpoint?.hash).toBe(crafted.hash);
      const published = await reopened.publish(
        [snapshot("settings/default/editor.fontSize", "16")],
        [],
      );
      const header = (
        JSON.parse(await readFile(published.eventPath ?? "", "utf8")) as StoredEvent
      ).header;
      expect(header.sequence).toBe(2);
      expect(header.previousEventHash).toBe(first.eventHash);
      expect(header.protocolVersion).toBe(CHECKPOINTED_EVENT_PROTOCOL_VERSION);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("never adopts its own cursor from an absorbed checkpoint", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-own-cursor-"));
    try {
      const repository = await createRepository(temporaryRoot);
      const deviceId = repository.state.device.deviceId;
      const first = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      const second = await repository.publish(
        [snapshot("settings/default/editor.fontSize", "16")],
        [],
      );
      const crafted = craftCheckpoint(repository, {
        checkpointVersion: 1,
        createdAt: new Date().toISOString(),
        deviceId: "deviceB",
        lamport: 5,
        predecessorHash: null,
        streams: {
          [deviceId]: { lastSequence: 1, lastEventHash: first.eventHash ?? "" },
        },
        resources: [],
      });
      await mkdir(join(temporaryRoot, "repository", "checkpoints"), { recursive: true });
      await writeFile(
        join(temporaryRoot, "repository", "checkpoints", crafted.fileName),
        crafted.bytes,
      );

      await repository.refreshState();
      expect(repository.state.checkpoint?.hash).toBe(crafted.hash);
      expect(repository.state.checkpoint?.streams[deviceId]).toEqual({
        lastSequence: 1,
        lastEventHash: first.eventHash,
      });
      expect(repository.state.streams[deviceId]).toEqual({
        lastSequence: 2,
        lastEventHash: second.eventHash,
      });
      expect(repository.state.nextSequence).toBe(3);
      expect(repository.state.lamport).toBe(5);

      await writeFile(first.eventPath ?? "", await readFile(second.eventPath ?? ""));
      await repository.refreshState();
      const listed = await repository.listEvents();
      expect(listed.map((event) => event.stored.header.sequence)).toEqual([2]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("gates pruning on every visible device's absorbed checkpoint lineage", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-gates-"));
    try {
      const repository = await createRepository(temporaryRoot);
      const deviceId = repository.state.device.deviceId;
      await repository.publish([snapshot("settings/default/editor.fontSize", "14")], []);
      await adoptTips(repository);
      const created = await repository.createCheckpoint(true);
      const sharedRoot = join(temporaryRoot, "repository", "checkpoints");

      await mkdir(join(temporaryRoot, "repository", "devices", "deviceB"), {
        recursive: true,
      });
      const missingAcks = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(missingAcks.status).toBe("aborted");
      expect(missingAcks.laggingDevices).toEqual([
        "deviceB: no absorbed checkpoint recorded",
      ]);

      await writeDeviceAcks(temporaryRoot, "deviceB", {
        hash: "ab".repeat(32),
        lamport: 99,
      });
      const unknownAck = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(unknownAck.status).toBe("aborted");
      expect(unknownAck.laggingDevices[0]).toMatch(/acknowledges unknown checkpoint/);

      const concurrent = craftCheckpointWithHashBelow(
        repository,
        {
          checkpointVersion: 1,
          createdAt: new Date().toISOString(),
          deviceId: "deviceB",
          lamport: created.lamport,
          predecessorHash: null,
          streams: {},
          resources: [],
        },
        created.checkpointHash,
      );
      await writeFile(join(sharedRoot, concurrent.fileName), concurrent.bytes);
      await writeDeviceAcks(temporaryRoot, "deviceB", {
        hash: concurrent.hash,
        lamport: created.lamport,
      });
      const sameLamport = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(sameLamport.status).toBe("aborted");
      expect(sameLamport.laggingDevices[0]).toMatch(/has not absorbed checkpoint/);

      await writeDeviceAcks(temporaryRoot, "deviceB", {
        hash: created.checkpointHash,
        lamport: created.lamport,
      });
      const ageGated = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
      });
      expect(ageGated.status).toBe("aborted");
      expect(ageGated.reason).toMatch(/younger than 24 hours/);

      const successor = craftCheckpoint(repository, {
        checkpointVersion: 1,
        createdAt: new Date().toISOString(),
        deviceId: "deviceB",
        lamport: 1,
        predecessorHash: created.checkpointHash,
        streams: {},
        resources: [],
      });
      await writeFile(join(sharedRoot, successor.fileName), successor.bytes);
      await writeDeviceAcks(temporaryRoot, "deviceB", {
        hash: successor.hash,
        lamport: 1,
      });
      const pruned = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(pruned.status).toBe("pruned");
      expect(pruned.eventsDeleted).toBe(1);
      expect(pruned.checkpointFilesDeleted).toBe(2);
      expect(pruned.markerEventHash).not.toBeNull();
      const eventFiles = await readdir(
        join(temporaryRoot, "repository", "devices", deviceId, "events"),
      );
      expect(eventFiles.map((file) => Number(file.slice(0, 16)))).toEqual([2]);
      const sharedFiles = await readdir(sharedRoot);
      expect(sharedFiles).toHaveLength(1);
      expect(sharedFiles[0]).toContain(created.checkpointHash);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("falls through to the next marker candidate when a tip payload is unreadable", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-marker-"));
    try {
      const repository = await createRepository(temporaryRoot);
      const deviceId = repository.state.device.deviceId;
      await repository.publish(
        [
          snapshot("settings/default/editor.fontSize", "14"),
          snapshot("settings/default/editor.tabSize", "2"),
        ],
        [],
      );
      await adoptTips(repository);
      await repository.createCheckpoint(true);
      const unreadable =
        repository.state.tips["settings/default/editor.fontSize"]?.[0]?.payload;
      if (unreadable === undefined) {
        throw new Error("Test repository did not adopt its tip payload.");
      }
      await rm(blobPath(temporaryRoot, deviceId, unreadable.objectId), {
        force: true,
      });

      const result = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(result.status).toBe("pruned");
      expect(result.eventsDeleted).toBe(1);
      expect(result.markerEventHash).not.toBeNull();
      const marker = (await repository.listEvents()).find(
        (event) => event.eventHash === result.markerEventHash,
      );
      const markerChange = marker?.manifest.changes[0];
      expect(markerChange?.resourceId).toBe("settings/default/editor.tabSize");
      expect(markerChange?.semanticHash).toBe(sha256(Buffer.from("2", "utf8")));
      expect(markerChange?.metadata?.syncOrigin).toBe("checkpoint-marker");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("aborts the prune before deleting anything when no marker content is readable", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-marker-abort-"),
    );
    try {
      const repository = await createRepository(temporaryRoot);
      const deviceId = repository.state.device.deviceId;
      await repository.publish(
        [snapshot("settings/default/editor.fontSize", "14")],
        [],
      );
      await adoptTips(repository);
      await repository.createCheckpoint(true);
      const payload =
        repository.state.tips["settings/default/editor.fontSize"]?.[0]?.payload;
      if (payload === undefined) {
        throw new Error("Test repository did not adopt its tip payload.");
      }
      await rm(blobPath(temporaryRoot, deviceId, payload.objectId), {
        force: true,
      });
      const eventRoot = join(
        temporaryRoot,
        "repository",
        "devices",
        deviceId,
        "events",
      );
      const eventFilesBefore = (await readdir(eventRoot)).sort();

      const result = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        overrideAgeGate: true,
      });
      expect(result.status).toBe("aborted");
      expect(result.reason).toMatch(/marker content is not readable/);
      expect(result.eventsDeleted).toBe(0);
      expect(result.markerEventHash).toBeNull();
      expect((await readdir(eventRoot)).sort()).toEqual(eventFilesBefore);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails checkpoint creation with a distinct error when the manifest exceeds the size limit", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-setting-sync-too-large-"));
    try {
      const repository = await createRepository(temporaryRoot);
      await repository.publish([snapshot("settings/default/editor.fontSize", "14")], []);
      await adoptTips(repository);
      const tip = repository.state.tips["settings/default/editor.fontSize"]?.[0];
      if (tip === undefined) {
        throw new Error("Test repository did not adopt its tip.");
      }
      tip.metadata = { pad: "x".repeat(MAX_CHECKPOINT_FILE_BYTES) };
      await expect(repository.createCheckpoint(true)).rejects.toThrow(
        /Checkpoint exceeds/,
      );
      expect(
        await fileExists(join(temporaryRoot, "repository", "checkpoints")),
      ).toBe(false);
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

async function createRepository(temporaryRoot: string): Promise<SyncRepository> {
  return SyncRepository.create(
    join(temporaryRoot, "repository"),
    join(temporaryRoot, "storage"),
    "a sufficiently long test passphrase",
    1024 * 1024,
    producer,
  );
}

async function reopen(
  temporaryRoot: string,
  repository: SyncRepository,
): Promise<SyncRepository> {
  return SyncRepository.openWithMasterKey(
    join(temporaryRoot, "repository"),
    join(temporaryRoot, "storage"),
    repository.repository,
    Buffer.from(repository.masterKey),
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

function stateFilePath(temporaryRoot: string, repositoryId: string): string {
  return join(temporaryRoot, "storage", `sync-state-${repositoryId}.json`);
}

function blobPath(
  temporaryRoot: string,
  deviceId: string,
  objectId: string,
): string {
  return join(
    temporaryRoot,
    "repository",
    "devices",
    deviceId,
    "blobs",
    "sha256",
    objectId.slice(0, 2),
    `${objectId}.cso`,
  );
}

function craftCheckpoint(
  repository: SyncRepository,
  manifest: CheckpointManifest,
): { fileName: string; bytes: Buffer; hash: string } {
  const header = {
    protocolVersion: PROTOCOL_VERSION,
    envelopeVersion: CHECKPOINT_ENVELOPE_VERSION,
    repositoryId: repository.repository.repositoryId,
    deviceId: manifest.deviceId,
    lamport: manifest.lamport,
  };
  const key = deriveSubkey(repository.masterKey, "checkpoint-encryption");
  const stored = {
    header,
    ...encryptAead(key, canonicalBytes(manifest), canonicalBytes(header)),
  };
  const bytes = canonicalBytes(stored);
  const hash = sha256(bytes);
  return {
    fileName: `${String(manifest.lamport).padStart(16, "0")}-${hash}${CHECKPOINT_EXTENSION}`,
    bytes,
    hash,
  };
}

function craftCheckpointWithHashBelow(
  repository: SyncRepository,
  manifest: CheckpointManifest,
  upperHash: string,
): { fileName: string; bytes: Buffer; hash: string } {
  for (let attempt = 0; attempt < 1024; attempt += 1) {
    const crafted = craftCheckpoint(repository, manifest);
    if (crafted.hash < upperHash) {
      return crafted;
    }
  }
  throw new Error("Could not craft a checkpoint below the target hash.");
}

async function readSharedCheckpoints(
  repositoryRoot: string,
  repository: SyncRepository,
): Promise<Array<{ fileName: string; hash: string; manifest: CheckpointManifest }>> {
  const key = deriveSubkey(repository.masterKey, "checkpoint-encryption");
  const checkpoints: Array<{
    fileName: string;
    hash: string;
    manifest: CheckpointManifest;
  }> = [];
  for (const fileName of (await readdir(join(repositoryRoot, "checkpoints"))).sort()) {
    const stored = JSON.parse(
      await readFile(join(repositoryRoot, "checkpoints", fileName), "utf8"),
    ) as StoredCheckpoint;
    const manifest = JSON.parse(
      decryptAead(key, stored, canonicalBytes(stored.header)).toString("utf8"),
    ) as CheckpointManifest;
    checkpoints.push({ fileName, hash: sha256(canonicalBytes(stored)), manifest });
  }
  return checkpoints;
}

async function writeDeviceAcks(
  temporaryRoot: string,
  deviceId: string,
  absorbedCheckpoint: unknown,
): Promise<void> {
  await mkdir(join(temporaryRoot, "repository", "devices", deviceId), {
    recursive: true,
  });
  await writeFile(
    join(temporaryRoot, "repository", "devices", deviceId, "acks.json"),
    JSON.stringify({
      deviceId,
      updatedAt: new Date().toISOString(),
      streams: {},
      absorbedCheckpoint,
    }),
    "utf8",
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
