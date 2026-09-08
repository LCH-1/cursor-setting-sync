import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { deriveSubkey, encryptAead } from "../src/protocol/crypto";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import type { EventHeader, EventManifest, ObjectReference, StoredCheckpoint, StoredEvent } from "../src/types";

const roots: string[] = [];
const producer = { extensionVersion: "1.0.7", cursorVersion: "3.18.9", vscodeVersion: "1.126.0" };
const passphrase = "a sufficiently long test passphrase";
const resourceId = "settings/default/editor.fontSize";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("checkpoint payload protection during object compaction", () => {
  it("keeps a shared predecessor readable to an offline peer until that checkpoint is pruned", async () => {
    const { a, b, oldCheckpoint, newCheckpoint, oldPayload, currentPayload } = await fixture();
    expect(b.state.checkpoint?.hash).toBe(oldCheckpoint.checkpointHash);

    const first = await a.compactOwnOrphans(true);

    expect(first.removedFiles).toBe(0);
    expect((await b.readObject(oldPayload)).toString()).toBe("14");
    expect((await a.readObject(currentPayload)).toString()).toBe("16");
    expect(await stat(oldCheckpoint.filePath)).toBeDefined();
    expect((await a.pruneWithGates({ reconciledWithoutWarnings: true, overrideAgeGate: true })).status).toBe("aborted");

    await b.refreshState();
    await reconcile(b);
    await b.writeAck();
    expect(b.state.checkpoint?.hash).toBe(newCheckpoint.checkpointHash);
    expect((await a.pruneWithGates({ reconciledWithoutWarnings: true, overrideAgeGate: true })).status).toBe("pruned");
    await reconcile(a);

    const final = await a.compactOwnOrphans(true);

    expect(final.removedFiles).toBe(1);
    expect(final.reclaimedBytes).toBeGreaterThan(0);
    await expect(a.readObject(oldPayload)).rejects.toThrow();
    expect((await a.readObject(currentPayload)).toString()).toBe("16");
    expect((await b.readObject(currentPayload)).toString()).toBe("16");
  });

  it.each(["hash-mismatch", "invalid-tag", "disappeared"])("deletes no objects if a remaining checkpoint is %s", async (problem) => {
    const { a, oldCheckpoint, oldPayload, currentPayload } = await fixture();
    const before = await stat(objectPath(a, oldPayload.deviceId, oldPayload.objectId));
    if (problem === "disappeared") {
      const internals = a as unknown as {
        readCheckpointFile(path: string, hash: string, lamport: number | null): Promise<unknown>;
      };
      const read = internals.readCheckpointFile.bind(a);
      vi.spyOn(internals, "readCheckpointFile").mockImplementation(async (path, hash, lamport) => {
        if (path === oldCheckpoint.filePath) {
          await rm(path);
        }
        return read(path, hash, lamport);
      });
    } else {
      const stored = JSON.parse(await readFile(oldCheckpoint.filePath, "utf8")) as StoredCheckpoint;
      stored.tag = Buffer.alloc(16).toString("base64");
      const content = canonicalBytes(stored);
      const path = problem === "hash-mismatch" ? oldCheckpoint.filePath
        : join(dirname(oldCheckpoint.filePath), `${String(stored.header.lamport).padStart(16, "0")}-${sha256(content)}.csc`);
      await writeFile(path, content);
    }

    await expect(a.compactOwnOrphans(true)).rejects.toThrow();

    expect((await stat(objectPath(a, oldPayload.deviceId, oldPayload.objectId))).size).toBe(before.size);
    expect((await a.readObject(oldPayload)).toString()).toBe("14");
    expect((await a.readObject(currentPayload)).toString()).toBe("16");
  });

  it.each(["covered", "current"])("authenticates %s event bytes again before deleting objects even when its file metadata is unchanged", async (generation) => {
    const a = await singleRepository();
    const first = await a.publish([snapshot("14")], []);
    await reconcile(a);
    await a.createCheckpoint(true);
    const second = await a.publish([snapshot("16")], []);
    await reconcile(a);
    const orphan = await writeUnreferencedObject(a);
    const eventPath = (generation === "covered" ? first : second).eventPath!;
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    await utimes(eventPath, fixedTime, fixedTime);
    await a.refreshState({ forceAudit: true });
    await a.listEvents();
    const identity = await stat(eventPath);
    const original = await readFile(eventPath);
    const stored = JSON.parse(original.toString()) as StoredEvent;
    stored.ciphertext = `${stored.ciphertext[0] === "A" ? "B" : "A"}${stored.ciphertext.slice(1)}`;
    const changed = canonicalBytes(stored);
    expect(changed.byteLength).toBe(original.byteLength);
    await writeFile(eventPath, changed);
    await utimes(eventPath, identity.atime, identity.mtime);
    expect((await stat(eventPath)).mtimeMs).toBe(identity.mtimeMs);

    await expect(a.compactOwnOrphans(true)).rejects.toThrow(/Event file hash mismatch/);

    expect((await a.readObject(orphan)).toString()).toBe("unpublished object");
  });

  it.each([false, true])("protects physically present retired events beyond the accepted cursor (known cursor %s)", async (knownCursor) => {
    const a = await singleRepository();
    await a.publish([snapshot("16")], []);
    await reconcile(a);
    const retained = await writeUnreferencedObject(a);
    const retiredId = "retired-device";
    const cursorHash = "a".repeat(64);
    a.state.retiredDevices.push(retiredId);
    if (knownCursor) {
      a.state.streams[retiredId] = { lastSequence: 1, lastEventHash: cursorHash };
    }
    await writeRetiredEvent(a, retiredId, retained, knownCursor ? cursorHash : null);
    expect((await a.listEvents()).some(event => event.stored.header.deviceId === retiredId)).toBe(false);

    const result = await a.compactOwnOrphans(true);

    expect(result.removedFiles).toBe(0);
    expect((await a.readObject(retained)).toString()).toBe("unpublished object");
  });

  it("deletes no objects when an otherwise ignored retired event cannot be authenticated", async () => {
    const a = await singleRepository();
    await a.publish([snapshot("16")], []);
    await reconcile(a);
    const retained = await writeUnreferencedObject(a);
    a.state.retiredDevices.push("retired-device");
    await writeRetiredEvent(a, "retired-device", retained, null, true);
    await a.listEvents();

    await expect(a.compactOwnOrphans(true)).rejects.toThrow();

    expect((await a.readObject(retained)).toString()).toBe("unpublished object");
  });
});

async function singleRepository(): Promise<SyncRepository> {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-compaction-"));
  roots.push(root);
  return SyncRepository.create(join(root, "repo"), join(root, "a"), passphrase, 1024 * 1024, producer);
}

async function writeUnreferencedObject(repository: SyncRepository): Promise<ObjectReference> {
  const writer = repository as unknown as { writeObject(content: Buffer): Promise<ObjectReference> };
  return writer.writeObject(Buffer.from("unpublished object"));
}

async function writeRetiredEvent(
  repository: SyncRepository,
  deviceId: string,
  payload: ObjectReference,
  previousHash: string | null,
  corruptTag = false,
): Promise<void> {
  const header: EventHeader = { protocolVersion: 1, envelopeVersion: 1,
    repositoryId: repository.repository.repositoryId, deviceId,
    sequence: previousHash === null ? 1 : 2, previousEventHash: previousHash };
  const manifest: EventManifest = { eventVersion: 1, createdAt: new Date().toISOString(),
    lamport: repository.state.lamport + 1, producer,
    changes: [{ resourceId: "settings/default/retired-reference", kind: "settings", operation: "put", parents: [],
      semanticHash: sha256(Buffer.from("unpublished object")), payload }] };
  const encrypted = encryptAead(deriveSubkey(repository.masterKey, "event-encryption"), canonicalBytes(manifest), canonicalBytes(header));
  const stored: StoredEvent = { header, ...encrypted, ...(corruptTag ? { tag: Buffer.alloc(16).toString("base64") } : {}) };
  const content = canonicalBytes(stored);
  const root = join(repository.root, "devices", deviceId, "events");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${String(header.sequence).padStart(16, "0")}-${sha256(content)}.cse`), content);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-compaction-"));
  roots.push(root);
  const a = await SyncRepository.create(join(root, "repo"), join(root, "a"), passphrase, 1024 * 1024, producer);
  await a.publish([snapshot("14")], []);
  await reconcile(a);
  const oldCheckpoint = await a.createCheckpoint(true);
  const b = await SyncRepository.open(a.root, join(root, "b"), passphrase, 1024 * 1024, producer);
  await reconcile(b);
  await b.writeAck();
  const oldPayload = (await b.loadAbsorbedCheckpointManifest())!.resources[0]!.payload!;
  await a.publish([snapshot("16")], []);
  await reconcile(a);
  expect((await a.pruneWithGates({ reconciledWithoutWarnings: true, overrideAgeGate: true })).status).toBe("pruned");
  await reconcile(a);
  const newCheckpoint = await a.createCheckpoint(true);
  await reconcile(a);
  const currentPayload = (await a.loadAbsorbedCheckpointManifest())!.resources[0]!.payload!;
  return { a, b, oldCheckpoint, newCheckpoint, oldPayload, currentPayload };
}

async function reconcile(repository: SyncRepository): Promise<void> {
  const checkpoint = await repository.loadAbsorbedCheckpointManifest();
  const result = new EventReconciler().reconcile(await repository.listReconciliationEvents(checkpoint), repository.state, checkpoint);
  expect(result.warnings).toEqual([]);
  await repository.saveState();
}

function snapshot(value: string) {
  const content = Buffer.from(value);
  return { resourceId, kind: "settings" as const, content, semanticHash: sha256(content) };
}

function objectPath(repository: SyncRepository, deviceId: string, objectId: string): string {
  return join(repository.root, "devices", deviceId, "blobs", "sha256", objectId.slice(0, 2), `${objectId}.cso`);
}
