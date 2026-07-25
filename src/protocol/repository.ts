import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import {
  CHECKPOINT_ENVELOPE_VERSION,
  CHECKPOINT_EXTENSION,
  CHECKPOINTED_EVENT_PROTOCOL_VERSION,
  DEVICE_FILE,
  EVENT_ENVELOPE_VERSION,
  EVENT_EXTENSION,
  MAX_CHECKPOINT_FILE_BYTES,
  MAX_EVENT_CHANGES,
  MAX_EVENT_FILE_BYTES,
  MAX_OBJECT_ENVELOPE_BYTES,
  MAX_PARENTS_PER_CHANGE,
  OBJECT_ENVELOPE_VERSION,
  OBJECT_EXTENSION,
  PARTIAL_EXTENSION,
  PROTOCOL_VERSION,
  REPOSITORY_FILE,
} from "../constants";
import type {
  CheckpointHeader,
  CheckpointIdentity,
  CheckpointManifest,
  CheckpointResource,
  DeviceAcks,
  EventHeader,
  EventManifest,
  EventProducer,
  JsonValue,
  LocalSyncState,
  ObjectReference,
  RepositoryFile,
  ResourceChange,
  ResourceDeletion,
  ResourceSnapshot,
  ResourceTip,
  ResourceVersionSummary,
  StreamCursor,
  StoredCheckpoint,
  StoredEvent,
  StoredObject,
} from "../types";
import { isSupportedResourceKind } from "../types";
import {
  assertSafeIdentifier,
  assertRealDirectory,
  ensureDirectory,
  isMissingPathError,
  listFilesRecursively,
  pathExists,
  readFileResilient,
  readFileWithinRoot,
  readJsonFile,
  statResilient,
  writeFileAtomic,
  writeJsonAtomic,
} from "../platform/files";
import {
  canonicalBytes,
  hashesEqual,
  hasExactObjectKeys,
  hmacSha256,
  sha256,
} from "./canonical";
import {
  createEncryptedRepository,
  decryptAead,
  deriveSubkey,
  encryptAead,
  unlockRepository,
  validateRepositoryFile,
} from "./crypto";
import { LocalStateStore } from "./localState";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const EVENT_FILE_PATTERN = /^(\d{16})-([a-f0-9]{64})\.cse$/;
const CHECKPOINT_FILE_PATTERN = /^(\d{16})-([a-f0-9]{64})\.csc$/;
const LOCAL_CHECKPOINT_FILE_PATTERN = /^([a-f0-9]{64})\.csc$/;
const MAX_REPOSITORY_FILE_BYTES = 64 * 1024;
const PRUNE_AGE_GATE_MS = 24 * 60 * 60 * 1000;

export interface DecryptedEvent {
  path: string;
  fileName: string;
  eventHash: string;
  stored: StoredEvent;
  manifest: EventManifest;
}

export interface PublishResult {
  eventHash: string | null;
  eventPath: string | null;
  changeCount: number;
}

export interface ResourceVersionData {
  change: ResourceChange;
  content: Buffer | null;
  producer?: EventProducer;
}

export interface ResourceHistoryEntry extends ResourceVersionSummary {
  metadata?: Record<string, JsonValue>;
}

interface PreparedCheckpointMarker {
  snapshots: ResourceSnapshot[];
  deletions: ResourceDeletion[];
}

export interface LoadedCheckpoint {
  hash: string;
  bytes: Buffer;
  stored: StoredCheckpoint;
  manifest: CheckpointManifest;
}

export interface CheckpointCreateResult {
  checkpointHash: string;
  lamport: number;
  filePath: string;
  fileBytes: number;
  resourceCount: number;
}

export interface PruneOptions {
  reconciledWithoutWarnings: boolean;
  overrideAgeGate?: boolean;
}

export interface PruneResult {
  status: "pruned" | "aborted";
  reason: string | null;
  laggingDevices: string[];
  eventsDeleted: number;
  checkpointFilesDeleted: number;
  reclaimedBytes: number;
  markerEventHash: string | null;
  warnings: string[];
}

export class SyncRepository {
  private readonly eventKey: Buffer;
  private readonly objectKey: Buffer;
  private readonly objectIdKey: Buffer;
  private readonly checkpointKey: Buffer;
  private eventsCache: DecryptedEvent[] | null = null;
  private checkpointManifestCache: { hash: string; manifest: CheckpointManifest } | null = null;
  private pendingRecovery: Error | null = null;

  private constructor(
    readonly root: string,
    readonly repository: RepositoryFile,
    readonly masterKey: Buffer,
    readonly stateStore: LocalStateStore,
    readonly state: LocalSyncState,
    private readonly maxPayloadBytes: number,
    private readonly producer: EventProducer,
  ) {
    this.eventKey = deriveSubkey(masterKey, "event-encryption");
    this.objectKey = deriveSubkey(masterKey, "object-encryption");
    this.objectIdKey = deriveSubkey(masterKey, "object-id");
    this.checkpointKey = deriveSubkey(masterKey, "checkpoint-encryption");
  }

  get pendingRecoveryError(): Error | null {
    return this.pendingRecovery;
  }

  get localCheckpointsRoot(): string {
    return join(
      this.stateStore.storageRoot,
      "checkpoints",
      this.repository.repositoryId,
    );
  }

  private get sharedCheckpointsRoot(): string {
    return join(this.root, "checkpoints");
  }

  static async create(
    root: string,
    storageRoot: string,
    passphrase: string,
    maxPayloadBytes: number,
    producer: EventProducer,
  ): Promise<SyncRepository> {
    await ensureDirectory(root);
    await assertRealDirectory(root);
    const repositoryPath = join(root, REPOSITORY_FILE);
    // A lone .git directory is the transport shell prepared during setup, not
    // repository content, so it must not block creation.
    const existingEntries = (await readdir(root)).filter(
      (entry) => entry !== ".git",
    );
    if (existingEntries.length > 0) {
      throw new Error(
        existingEntries.includes(REPOSITORY_FILE)
          ? "A synchronization repository already exists in this folder."
          : "A new synchronization repository requires an empty folder.",
      );
    }

    const created = await createEncryptedRepository(passphrase, randomUUID());
    try {
      await writeFileAtomic(
        repositoryPath,
        Buffer.from(`${JSON.stringify(created.repository, null, 2)}\n`, "utf8"),
        false,
      );
      const stateStore = new LocalStateStore(storageRoot);
      const state = await stateStore.loadOrCreate(created.repository.repositoryId);
      const instance = new SyncRepository(
        root,
        created.repository,
        created.masterKey,
        stateStore,
        state,
        maxPayloadBytes,
        producer,
      );
      await instance.initializeDevice();
      return instance;
    } catch (error) {
      created.masterKey.fill(0);
      if (isAlreadyExistsError(error)) {
        throw new Error(
          "Another device created a synchronization repository in this folder. Join the existing repository instead.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  static async open(
    root: string,
    storageRoot: string,
    passphrase: string,
    maxPayloadBytes: number,
    producer: EventProducer,
  ): Promise<SyncRepository> {
    await assertRealDirectory(root);
    const repository = JSON.parse(
      (
        await readFileWithinRoot(
          root,
          REPOSITORY_FILE,
          MAX_REPOSITORY_FILE_BYTES,
        )
      ).toString("utf8"),
    ) as RepositoryFile;
    const masterKey = await unlockRepository(passphrase, repository);
    return SyncRepository.openWithMasterKey(
      root,
      storageRoot,
      repository,
      masterKey,
      maxPayloadBytes,
      producer,
    );
  }

  static async openWithMasterKey(
    root: string,
    storageRoot: string,
    repository: RepositoryFile,
    masterKey: Buffer,
    maxPayloadBytes: number,
    producer: EventProducer,
  ): Promise<SyncRepository> {
    await assertRealDirectory(root);
    validateRepositoryFile(repository);
    if (masterKey.byteLength !== 32) {
      throw new Error("Repository master key has an invalid length.");
    }
    const stateStore = new LocalStateStore(storageRoot);
    const state = await stateStore.loadOrCreate(repository.repositoryId);
    const instance = new SyncRepository(
      root,
      repository,
      masterKey,
      stateStore,
      state,
      maxPayloadBytes,
      producer,
    );
    await instance.initializeDevice();
    return instance;
  }

  async publish(
    snapshots: ResourceSnapshot[],
    deletions: ResourceDeletion[],
  ): Promise<PublishResult> {
    if (this.pendingRecovery !== null) {
      throw this.pendingRecovery;
    }
    if (snapshots.length === 0 && deletions.length === 0) {
      return { eventHash: null, eventPath: null, changeCount: 0 };
    }
    if (snapshots.length + deletions.length > MAX_EVENT_CHANGES) {
      throw new Error(`Too many changes for one event: ${snapshots.length + deletions.length}`);
    }

    const changes: ResourceChange[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.content.byteLength > this.maxPayloadBytes) {
        throw new Error(
          `Payload exceeds configured limit for ${snapshot.resourceId}: ${snapshot.content.byteLength}`,
        );
      }
      const payload = await this.writeObject(snapshot.content);
      const change: ResourceChange = {
        resourceId: snapshot.resourceId,
        kind: snapshot.kind,
        operation: "put",
        parents:
          snapshot.parents === undefined
            ? this.currentParents(snapshot.resourceId)
            : snapshot.parents,
        semanticHash: snapshot.semanticHash,
        payload,
      };
      if (snapshot.metadata !== undefined) {
        change.metadata = snapshot.metadata;
      }
      changes.push(change);
    }

    for (const deletion of deletions) {
      const change: ResourceChange = {
        resourceId: deletion.resourceId,
        kind: deletion.kind,
        operation: "delete",
        parents:
          deletion.parents === undefined
            ? this.currentParents(deletion.resourceId)
            : deletion.parents,
        semanticHash: deletion.semanticHash,
      };
      if (deletion.metadata !== undefined) {
        change.metadata = deletion.metadata;
      }
      changes.push(change);
    }

    changes.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
    const header: EventHeader = {
      protocolVersion:
        this.state.checkpoint === undefined
          ? PROTOCOL_VERSION
          : CHECKPOINTED_EVENT_PROTOCOL_VERSION,
      envelopeVersion: EVENT_ENVELOPE_VERSION,
      repositoryId: this.repository.repositoryId,
      deviceId: this.state.device.deviceId,
      sequence: this.state.nextSequence,
      previousEventHash: this.state.ownStreamHead,
    };
    const manifest: EventManifest = {
      eventVersion: EVENT_ENVELOPE_VERSION,
      createdAt: new Date().toISOString(),
      lamport: this.state.lamport + 1,
      producer: this.producer,
      changes,
    };
    validateEventManifest(manifest, this.maxPayloadBytes);
    const encrypted = encryptAead(
      this.eventKey,
      canonicalBytes(manifest),
      canonicalBytes(header),
    );
    const stored: StoredEvent = { header, ...encrypted };
    const storedBytes = canonicalBytes(stored);
    if (storedBytes.byteLength > MAX_EVENT_FILE_BYTES) {
      throw new Error(`Event envelope exceeds ${MAX_EVENT_FILE_BYTES} bytes.`);
    }
    const eventHash = sha256(storedBytes);
    const eventFileName = `${String(header.sequence).padStart(16, "0")}-${eventHash}${EVENT_EXTENSION}`;
    const eventPath = join(this.eventsRoot(header.deviceId), eventFileName);
    if (await pathExists(eventPath)) {
      throw new Error(`Event already exists: ${eventFileName}`);
    }
    await writeFileAtomic(eventPath, storedBytes, false);
    this.eventsCache = null;

    this.state.nextSequence += 1;
    this.state.lamport = manifest.lamport;
    this.state.ownStreamHead = eventHash;
    this.state.streams[header.deviceId] = {
      lastSequence: header.sequence,
      lastEventHash: eventHash,
    };
    await this.stateStore.save(this.state);
    await writeJsonAtomic(join(this.deviceRoot(header.deviceId), "head.json"), {
      deviceId: header.deviceId,
      sequence: header.sequence,
      eventHash,
      lamport: manifest.lamport,
      updatedAt: new Date().toISOString(),
    });
    return { eventHash, eventPath, changeCount: changes.length };
  }

  async listEvents(): Promise<DecryptedEvent[]> {
    if (this.eventsCache !== null) {
      return [...this.eventsCache];
    }
    const devicesRoot = join(this.root, "devices");
    if (!(await pathExists(devicesRoot))) {
      return [];
    }
    const deviceEntries = await readdir(devicesRoot, { withFileTypes: true });
    const events: DecryptedEvent[] = [];
    for (const deviceEntry of deviceEntries) {
      if (
        !deviceEntry.isDirectory() ||
        !isSafeIdentifier(deviceEntry.name)
      ) {
        continue;
      }
      const retiredCursor = this.state.retiredDevices.includes(deviceEntry.name)
        ? this.state.streams[deviceEntry.name]
        : undefined;
      if (
        this.state.retiredDevices.includes(deviceEntry.name) &&
        retiredCursor === undefined
      ) {
        continue;
      }
      const eventRoot = this.eventsRoot(deviceEntry.name);
      if (!(await pathExists(eventRoot))) {
        continue;
      }
      const checkpointCursor = this.state.checkpoint?.streams[deviceEntry.name];
      const files = await readdir(eventRoot, { withFileTypes: true });
      for (const file of files) {
        if (
          !file.isFile() ||
          file.name.endsWith(PARTIAL_EXTENSION) ||
          file.name.includes("sync-conflict")
        ) {
          continue;
        }
        const match = EVENT_FILE_PATTERN.exec(file.name);
        if (match === null) {
          continue;
        }
        const fileSequence = Number(match[1]);
        if (
          retiredCursor !== undefined &&
          fileSequence > retiredCursor.lastSequence
        ) {
          continue;
        }
        try {
          events.push(
            await this.readEvent(
              join(eventRoot, file.name),
              file.name,
              deviceEntry.name,
            ),
          );
        } catch (error) {
          // Files at or below the absorbed checkpoint cursor may be deleted or
          // partially propagated by another device's prune while this listing
          // runs; the checkpoint already covers their content.
          if (
            checkpointCursor !== undefined &&
            fileSequence <= checkpointCursor.lastSequence &&
            isTolerablePrunedEventError(error)
          ) {
            continue;
          }
          throw error;
        }
      }
    }
    const sorted = events.sort((left, right) => {
      const deviceOrder = left.stored.header.deviceId.localeCompare(
        right.stored.header.deviceId,
      );
      if (deviceOrder !== 0) {
        return deviceOrder;
      }
      return left.stored.header.sequence - right.stored.header.sequence;
    });
    this.eventsCache = sorted;
    return [...sorted];
  }

  async readObject(reference: ObjectReference): Promise<Buffer> {
    validateObjectReference(reference, this.maxPayloadBytes);
    const path = this.objectPath(reference.deviceId, reference.objectId);
    const fileInfo = await statResilient(path);
    const envelopeLimit = Math.min(
      MAX_OBJECT_ENVELOPE_BYTES,
      Math.ceil(this.maxPayloadBytes * 1.5) + 1024 * 1024,
    );
    if (fileInfo.size > envelopeLimit) {
      throw new Error(`Object envelope exceeds its size limit: ${reference.objectId}`);
    }
    const stored = await readJsonFile<StoredObject>(path);
    validateStoredObjectEnvelope(stored, reference);
    validateObjectHeader(stored, this.repository.repositoryId, reference);
    const header = objectHeader(stored);
    const compressed = decryptAead(this.objectKey, stored, canonicalBytes(header));
    if (!hashesEqual(hmacSha256(this.objectIdKey, compressed), reference.objectId)) {
      throw new Error(`Object HMAC mismatch: ${reference.objectId}`);
    }
    if (compressed.byteLength !== reference.compressedBytes) {
      throw new Error(`Object compressed size mismatch: ${reference.objectId}`);
    }
    const plain = await gunzipAsync(compressed, {
      maxOutputLength: this.maxPayloadBytes,
    });
    if (plain.byteLength !== reference.plainBytes) {
      throw new Error(`Object plain size mismatch: ${reference.objectId}`);
    }
    if (plain.byteLength > this.maxPayloadBytes) {
      throw new Error(`Object exceeds configured payload limit: ${reference.objectId}`);
    }
    return plain;
  }

  async readVersion(versionId: string): Promise<ResourceVersionData> {
    const separator = versionId.lastIndexOf("#");
    if (separator <= 0) {
      throw new Error(`Invalid resource version ID: ${versionId}`);
    }
    const eventHash = versionId.slice(0, separator);
    const changeIndex = Number(versionId.slice(separator + 1));
    const event = (await this.listEvents()).find(
      (candidate) => candidate.eventHash === eventHash,
    );
    const change = event?.manifest.changes[changeIndex];
    if (event === undefined || change === undefined) {
      return this.readCheckpointVersion(versionId);
    }
    const data: ResourceVersionData = {
      change,
      content:
        change.operation === "put" && change.payload !== undefined
          ? await this.readObject(change.payload)
          : null,
    };
    if (event.manifest.producer !== undefined) {
      data.producer = event.manifest.producer;
    }
    return data;
  }

  async tryReadVersion(versionId: string): Promise<ResourceVersionData | null> {
    try {
      return await this.readVersion(versionId);
    } catch (error) {
      if (
        isMissingPathError(error) ||
        (error instanceof Error &&
          (error.message.startsWith("Resource version is unavailable") ||
            error.message.startsWith("Invalid resource version ID")))
      ) {
        return null;
      }
      throw error;
    }
  }

  async listResourceHistory(resourceId: string): Promise<ResourceHistoryEntry[]> {
    const summaries = new Map<string, ResourceHistoryEntry>();
    const manifest = await this.loadAbsorbedCheckpointManifest();
    if (manifest !== null) {
      const folded = manifest.resources.find(
        (resource) => resource.resourceId === resourceId,
      );
      if (folded !== undefined && isSupportedResourceKind(folded.kind)) {
        const summary: ResourceHistoryEntry = {
          versionId: folded.versionId,
          resourceId,
          kind: folded.kind,
          operation: folded.operation,
          semanticHash: folded.semanticHash,
          lamport: folded.lamport,
          createdAt: manifest.createdAt,
          deviceId: folded.deviceId,
          plainBytes: folded.payload?.plainBytes ?? null,
          fromCheckpoint: true,
        };
        if (folded.producer !== undefined) {
          summary.producer = folded.producer;
        }
        if (folded.metadata !== undefined) {
          summary.metadata = folded.metadata;
        }
        summaries.set(folded.versionId, summary);
      }
    }
    for (const event of await this.listEvents()) {
      event.manifest.changes.forEach((change, changeIndex) => {
        if (change.resourceId !== resourceId || !isSupportedResourceKind(change.kind)) {
          return;
        }
        const versionId = `${event.eventHash}#${changeIndex}`;
        const summary: ResourceHistoryEntry = {
          versionId,
          resourceId,
          kind: change.kind,
          operation: change.operation,
          semanticHash: change.semanticHash,
          lamport: event.manifest.lamport,
          createdAt: event.manifest.createdAt,
          deviceId: event.stored.header.deviceId,
          plainBytes: change.payload?.plainBytes ?? null,
          fromCheckpoint: false,
        };
        if (event.manifest.producer !== undefined) {
          summary.producer = event.manifest.producer;
        }
        if (change.metadata !== undefined) {
          summary.metadata = change.metadata;
        }
        summaries.set(versionId, summary);
      });
    }
    return [...summaries.values()].sort(compareVersionSummaries);
  }

  private async readCheckpointVersion(versionId: string): Promise<ResourceVersionData> {
    const manifest = await this.loadAbsorbedCheckpointManifest();
    const folded = manifest?.resources.find(
      (resource) => resource.versionId === versionId,
    );
    if (folded === undefined) {
      throw new Error(`Resource version is unavailable: ${versionId}`);
    }
    const change: ResourceChange = {
      resourceId: folded.resourceId,
      kind: folded.kind,
      operation: folded.operation,
      parents: [],
      semanticHash: folded.semanticHash,
    };
    if (folded.payload !== undefined) {
      change.payload = folded.payload;
    }
    if (folded.metadata !== undefined) {
      change.metadata = folded.metadata;
    }
    const data: ResourceVersionData = {
      change,
      content:
        folded.operation === "put" && folded.payload !== undefined
          ? await this.readObject(folded.payload)
          : null,
    };
    if (folded.producer !== undefined) {
      data.producer = folded.producer;
    }
    return data;
  }

  async saveState(): Promise<void> {
    await this.stateStore.save(this.state);
  }

  async refreshState(): Promise<void> {
    this.eventsCache = null;
    const latest = await this.stateStore.load(this.repository.repositoryId);
    Object.assign(this.state, latest);
    await this.absorbNewestCheckpoint();
    try {
      await this.recoverOwnStream();
      this.pendingRecovery = null;
    } catch (error) {
      if (error instanceof OwnStreamPendingRecoveryError) {
        this.pendingRecovery = error;
      }
      throw error;
    }
  }

  async writeAck(): Promise<void> {
    await writeJsonAtomic(
      join(this.deviceRoot(this.state.device.deviceId), "acks.json"),
      {
        deviceId: this.state.device.deviceId,
        updatedAt: new Date().toISOString(),
        streams: this.state.streams,
        absorbedCheckpoint:
          this.state.checkpoint === undefined
            ? null
            : {
                hash: this.state.checkpoint.hash,
                lamport: this.state.checkpoint.lamport,
              },
      },
    );
  }

  async readDeviceAcks(deviceId: string): Promise<DeviceAcks | null> {
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(
        join(this.deviceRoot(deviceId), "acks.json"),
      );
    } catch {
      return null;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    if (record.deviceId !== deviceId || typeof record.updatedAt !== "string") {
      return null;
    }
    const streams: Record<string, StreamCursor> = {};
    if (
      record.streams !== null &&
      typeof record.streams === "object" &&
      !Array.isArray(record.streams)
    ) {
      for (const [streamDevice, cursor] of Object.entries(
        record.streams as Record<string, unknown>,
      )) {
        if (isSafeIdentifier(streamDevice) && isValidStreamCursor(cursor)) {
          streams[streamDevice] = {
            lastSequence: cursor.lastSequence,
            lastEventHash: cursor.lastEventHash,
          };
        }
      }
    }
    return {
      deviceId,
      updatedAt: record.updatedAt,
      streams,
      absorbedCheckpoint: parseCheckpointIdentity(record.absorbedCheckpoint),
    };
  }

  async createCheckpoint(
    reconciledWithoutWarnings: boolean,
  ): Promise<CheckpointCreateResult> {
    if (this.pendingRecovery !== null) {
      throw this.pendingRecovery;
    }
    if (reconciledWithoutWarnings !== true) {
      throw new Error(
        "Checkpoint creation requires a completed reconcile without stream warnings.",
      );
    }
    if (
      this.state.conflicts.some((conflict) => conflict.resolvedAt === undefined)
    ) {
      throw new Error(
        "Resolve all synchronization conflicts before creating a checkpoint.",
      );
    }
    const lamport = this.state.lamport + 1;
    const resources: CheckpointResource[] = [];
    for (const resourceId of Object.keys(this.state.tips).sort()) {
      const active = chooseCheckpointTip(this.state.tips[resourceId] ?? []);
      if (active === undefined) {
        continue;
      }
      const resource: CheckpointResource = {
        resourceId,
        kind: active.kind,
        operation: active.operation,
        semanticHash: active.semanticHash,
        versionId: active.versionId,
        lamport: active.lamport,
        deviceId: active.deviceId,
      };
      if (active.payload !== undefined) {
        resource.payload = active.payload;
      }
      if (active.metadata !== undefined) {
        resource.metadata = active.metadata;
      }
      if (active.producer !== undefined) {
        resource.producer = active.producer;
      }
      resources.push(resource);
    }
    const manifest: CheckpointManifest = {
      checkpointVersion: 1,
      createdAt: new Date().toISOString(),
      deviceId: this.state.device.deviceId,
      lamport,
      predecessorHash: this.state.checkpoint?.hash ?? null,
      streams: cloneStreams(this.state.streams),
      resources,
    };
    const header: CheckpointHeader = {
      protocolVersion: PROTOCOL_VERSION,
      envelopeVersion: CHECKPOINT_ENVELOPE_VERSION,
      repositoryId: this.repository.repositoryId,
      deviceId: this.state.device.deviceId,
      lamport,
    };
    const manifestBytes = canonicalBytes(manifest);
    if (manifestBytes.byteLength > MAX_CHECKPOINT_FILE_BYTES) {
      throw checkpointTooLargeError();
    }
    const encrypted = encryptAead(
      this.checkpointKey,
      manifestBytes,
      canonicalBytes(header),
    );
    const stored: StoredCheckpoint = { header, ...encrypted };
    const storedBytes = canonicalBytes(stored);
    if (storedBytes.byteLength > MAX_CHECKPOINT_FILE_BYTES) {
      throw checkpointTooLargeError();
    }
    const hash = sha256(storedBytes);
    const fileName = `${String(lamport).padStart(16, "0")}-${hash}${CHECKPOINT_EXTENSION}`;
    const filePath = join(this.sharedCheckpointsRoot, fileName);
    await writeFileAtomic(filePath, storedBytes, false);
    try {
      await this.readCheckpointFile(filePath, hash, lamport);
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
    const localPath = join(
      this.localCheckpointsRoot,
      `${hash}${CHECKPOINT_EXTENSION}`,
    );
    if (!(await pathExists(localPath))) {
      await writeFileAtomic(localPath, storedBytes);
    }
    await this.absorbNewestCheckpoint();
    await this.writeAck();
    return {
      checkpointHash: hash,
      lamport,
      filePath,
      fileBytes: storedBytes.byteLength,
      resourceCount: resources.length,
    };
  }

  async pruneWithGates(options: PruneOptions): Promise<PruneResult> {
    if (this.pendingRecovery !== null) {
      throw this.pendingRecovery;
    }
    if (options.reconciledWithoutWarnings !== true) {
      throw new Error(
        "Pruning requires a completed reconcile without stream warnings.",
      );
    }
    const previousHash = this.state.checkpoint?.hash ?? null;
    await this.absorbNewestCheckpoint();
    const checkpoint = this.state.checkpoint;
    if (checkpoint === undefined) {
      return abortedPrune("No checkpoint exists yet; create one first.", []);
    }
    await this.writeAck();
    if (previousHash !== checkpoint.hash) {
      return abortedPrune(
        "A newer checkpoint was absorbed; prune again after every device has absorbed it.",
        [],
      );
    }
    const manifest = await this.loadAbsorbedCheckpointManifest();
    if (manifest === null) {
      throw checkpointRollbackError(checkpoint.hash);
    }
    const laggingDevices: string[] = [];
    const ancestryCache = new Map<string, CheckpointManifest | null>();
    ancestryCache.set(checkpoint.hash, manifest);
    for (const deviceId of await this.listVisibleDeviceIds()) {
      if (this.state.retiredDevices.includes(deviceId)) {
        continue;
      }
      const acks = await this.readDeviceAcks(deviceId);
      const absorbed = acks?.absorbedCheckpoint ?? null;
      if (absorbed === null) {
        laggingDevices.push(`${deviceId}: no absorbed checkpoint recorded`);
        continue;
      }
      const verdict = await this.ackCoversCheckpoint(
        absorbed.hash,
        checkpoint.hash,
        ancestryCache,
      );
      if (verdict !== null) {
        laggingDevices.push(`${deviceId}: ${verdict}`);
      }
    }
    if (laggingDevices.length > 0) {
      return abortedPrune(
        "Every device must absorb the checkpoint before pruning.",
        laggingDevices,
      );
    }
    const ageMs = Date.now() - Date.parse(manifest.createdAt);
    if (!(ageMs >= PRUNE_AGE_GATE_MS) && options.overrideAgeGate !== true) {
      return abortedPrune(
        "The checkpoint is younger than 24 hours; wait for invisible devices or confirm an immediate prune.",
        [],
      );
    }
    // The marker content is materialized before any deletion so that a tip
    // blob that has not propagated yet aborts the prune cleanly instead of
    // failing after the irreversible deletions already happened.
    const warnings: string[] = [];
    const marker = await this.prepareCheckpointMarker();
    if (marker === null) {
      if (
        Object.values(this.state.tips).some(
          (tips) => chooseCheckpointTip(tips) !== undefined,
        )
      ) {
        return abortedPrune(
          "The checkpoint marker content is not readable yet; wait for the shared folder to deliver the tip payloads before pruning.",
          [],
        );
      }
      warnings.push(
        "No current tips exist, so the checkpoint marker event was skipped; " +
          "old builds will not fail loudly until the next publish.",
      );
    }
    let eventsDeleted = 0;
    let reclaimedBytes = 0;
    for (const [deviceId, cursor] of Object.entries(checkpoint.streams)) {
      const eventRoot = this.eventsRoot(deviceId);
      if (!(await pathExists(eventRoot))) {
        continue;
      }
      for (const file of await readdir(eventRoot)) {
        const match = EVENT_FILE_PATTERN.exec(file);
        if (match === null || Number(match[1]) > cursor.lastSequence) {
          continue;
        }
        const removedBytes = await removeFileReclaiming(join(eventRoot, file));
        if (removedBytes !== null) {
          eventsDeleted += 1;
          reclaimedBytes += removedBytes;
        }
      }
    }
    this.eventsCache = null;
    this.checkpointManifestCache = null;
    let checkpointFilesDeleted = 0;
    if (await pathExists(this.sharedCheckpointsRoot)) {
      for (const file of await readdir(this.sharedCheckpointsRoot)) {
        const match = CHECKPOINT_FILE_PATTERN.exec(file);
        if (match === null) {
          continue;
        }
        const identity: CheckpointIdentity = {
          lamport: Number(match[1]),
          hash: match[2] ?? "",
        };
        if (compareCheckpointIdentity(identity, checkpoint) >= 0) {
          continue;
        }
        const removedBytes = await removeFileReclaiming(
          join(this.sharedCheckpointsRoot, file),
        );
        if (removedBytes !== null) {
          checkpointFilesDeleted += 1;
          reclaimedBytes += removedBytes;
        }
      }
    }
    let markerEventHash: string | null = null;
    if (marker !== null) {
      // The deletions already happened, so a failed marker publish must not
      // discard the prune counts; the next successful prune or publish still
      // writes a v2 event.
      try {
        markerEventHash = (
          await this.publish(marker.snapshots, marker.deletions)
        ).eventHash;
      } catch (error) {
        warnings.push(
          "The checkpoint marker publish failed after pruning: " +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "The next successful prune or publish writes the v2 marker event.",
        );
      }
    }
    return {
      status: "pruned",
      reason: null,
      laggingDevices: [],
      eventsDeleted,
      checkpointFilesDeleted,
      reclaimedBytes,
      markerEventHash,
      warnings,
    };
  }

  async compactOwnOrphans(
    reconciledWithoutWarnings: boolean,
  ): Promise<{ removedFiles: number; reclaimedBytes: number }> {
    if (this.pendingRecovery !== null) {
      throw this.pendingRecovery;
    }
    if (reconciledWithoutWarnings !== true) {
      throw new Error(
        "Repository compaction requires a completed reconcile without stream warnings.",
      );
    }
    const referenced = new Set<string>();
    for (const event of await this.listEvents()) {
      for (const change of event.manifest.changes) {
        if (change.payload !== undefined) {
          referenced.add(`${change.payload.deviceId}/${change.payload.objectId}`);
        }
      }
    }
    const manifest = await this.loadAbsorbedCheckpointManifest();
    if (manifest !== null) {
      for (const resource of manifest.resources) {
        if (resource.payload !== undefined) {
          referenced.add(
            `${resource.payload.deviceId}/${resource.payload.objectId}`,
          );
        }
      }
    }

    let removedFiles = 0;
    let reclaimedBytes = 0;
    const ownDeviceId = this.state.device.deviceId;
    for (const path of await listFilesRecursively(this.deviceRoot(ownDeviceId))) {
      const fileName = path.split(/[\\/]/).at(-1) ?? "";
      const info = await stat(path);
      if (fileName.endsWith(PARTIAL_EXTENSION)) {
        if (Date.now() - info.mtimeMs >= 24 * 60 * 60 * 1000) {
          await rm(path, { force: true });
          removedFiles += 1;
          reclaimedBytes += info.size;
        }
        continue;
      }
      if (!fileName.endsWith(OBJECT_EXTENSION)) {
        continue;
      }
      const objectId = fileName.slice(0, -OBJECT_EXTENSION.length);
      if (!referenced.has(`${ownDeviceId}/${objectId}`)) {
        await rm(path, { force: true });
        removedFiles += 1;
        reclaimedBytes += info.size;
      }
    }
    return { removedFiles, reclaimedBytes };
  }

  private async initializeDevice(): Promise<void> {
    await ensureDirectory(this.eventsRoot(this.state.device.deviceId));
    await ensureDirectory(this.blobsRoot(this.state.device.deviceId));
    const devicePath = join(this.deviceRoot(this.state.device.deviceId), DEVICE_FILE);
    if (!(await pathExists(devicePath))) {
      await writeJsonAtomic(devicePath, this.state.device);
    }
    await this.absorbNewestCheckpoint();
    try {
      await this.recoverOwnStream();
      this.pendingRecovery = null;
    } catch (error) {
      // Own events pruned before their checkpoint file arrived must not wedge
      // the open path; publishing stays blocked until a later refresh absorbs
      // the checkpoint that covers them.
      if (error instanceof OwnStreamPendingRecoveryError) {
        this.pendingRecovery = error;
        return;
      }
      throw error;
    }
  }

  private async recoverOwnStream(): Promise<void> {
    const deviceId = this.state.device.deviceId;
    const eventRoot = this.eventsRoot(deviceId);
    const pinned = pinnedOwnStream(this.state);
    const checkpointCursor = this.state.checkpoint?.streams[deviceId];
    const allFiles = (await readdir(eventRoot))
      .map((file) => ({ file, match: EVENT_FILE_PATTERN.exec(file) }))
      .filter(
        (entry): entry is { file: string; match: RegExpExecArray } =>
          entry.match !== null,
      )
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
    if (
      checkpointCursor !== undefined &&
      pinned.lastSequence < checkpointCursor.lastSequence
    ) {
      await this.adoptCheckpointOwnCursor(allFiles, checkpointCursor);
      return;
    }
    if (
      checkpointCursor !== undefined &&
      pinned.lastSequence === checkpointCursor.lastSequence &&
      pinned.lastEventHash !== checkpointCursor.lastEventHash
    ) {
      throw ownStreamRollbackError(
        deviceId,
        `the absorbed checkpoint records a different hash for previously published event ${pinned.lastSequence}`,
      );
    }
    const coveredSequence = checkpointCursor?.lastSequence ?? 0;
    const files = allFiles.filter(
      (entry) => Number(entry.match[1]) > coveredSequence,
    );
    if (files.length === 0) {
      if (pinned.lastSequence > coveredSequence) {
        throw new OwnStreamPendingRecoveryError(
          deviceId,
          `previously published event ${pinned.lastSequence} is no longer visible`,
        );
      }
      return;
    }
    let previousHash: string | null = checkpointCursor?.lastEventHash ?? null;
    let expectedSequence = coveredSequence + 1;
    let observedLamport = this.state.lamport;
    for (const entry of files) {
      const event = await this.readEvent(
        join(eventRoot, entry.file),
        entry.file,
        deviceId,
      );
      if (event.stored.header.sequence !== expectedSequence) {
        if (expectedSequence <= pinned.lastSequence) {
          throw new OwnStreamPendingRecoveryError(
            deviceId,
            `previously published event ${expectedSequence} is missing`,
          );
        }
        throw ownStreamRollbackError(
          deviceId,
          `event stream has a sequence gap at ${entry.file}`,
        );
      }
      if (event.stored.header.previousEventHash !== previousHash) {
        throw ownStreamRollbackError(
          deviceId,
          `event stream chain is broken at ${entry.file}`,
        );
      }
      if (
        expectedSequence === pinned.lastSequence &&
        event.eventHash !== pinned.lastEventHash
      ) {
        throw ownStreamRollbackError(
          deviceId,
          `previously published event ${expectedSequence} has a different hash`,
        );
      }
      previousHash = event.eventHash;
      observedLamport = Math.max(
        observedLamport,
        event.manifest.lamport,
      );
      expectedSequence += 1;
    }
    if (expectedSequence - 1 < pinned.lastSequence) {
      throw new OwnStreamPendingRecoveryError(
        deviceId,
        `stream ended before previously published event ${pinned.lastSequence}`,
      );
    }
    this.state.lamport = observedLamport;
    this.state.nextSequence = expectedSequence;
    this.state.ownStreamHead = previousHash;
    this.state.streams[deviceId] = {
      lastSequence: expectedSequence - 1,
      lastEventHash: previousHash,
    };
    await this.stateStore.save(this.state);
  }

  private async adoptCheckpointOwnCursor(
    allFiles: Array<{ file: string; match: RegExpExecArray }>,
    checkpointCursor: StreamCursor,
  ): Promise<void> {
    const deviceId = this.state.device.deviceId;
    const eventRoot = this.eventsRoot(deviceId);
    const headSequence = await this.readOwnHeadSequence();
    const files = allFiles.filter(
      (entry) => Number(entry.match[1]) > checkpointCursor.lastSequence,
    );
    const fileAtCursor = allFiles.find(
      (entry) =>
        Number(entry.match[1]) === checkpointCursor.lastSequence &&
        (entry.match[2] ?? "") === checkpointCursor.lastEventHash,
    );
    let corroborated =
      fileAtCursor !== undefined ||
      (headSequence !== null && headSequence >= checkpointCursor.lastSequence);
    let previousHash = checkpointCursor.lastEventHash;
    let expectedSequence = checkpointCursor.lastSequence + 1;
    let observedLamport = this.state.lamport;
    for (const entry of files) {
      const event = await this.readEvent(
        join(eventRoot, entry.file),
        entry.file,
        deviceId,
      );
      if (event.stored.header.sequence !== expectedSequence) {
        throw ownStreamRollbackError(
          deviceId,
          `event stream has a sequence gap at ${entry.file}`,
        );
      }
      if (event.stored.header.previousEventHash !== previousHash) {
        throw ownStreamRollbackError(
          deviceId,
          `event stream chain is broken at ${entry.file}`,
        );
      }
      corroborated = true;
      previousHash = event.eventHash;
      observedLamport = Math.max(observedLamport, event.manifest.lamport);
      expectedSequence += 1;
    }
    const walkEnd = expectedSequence - 1;
    if (!corroborated || (headSequence !== null && walkEnd < headSequence)) {
      throw new Error(
        "Local sync state is older than the repository checkpoint; " +
          "refusing to publish to avoid duplicate sequence numbers.",
      );
    }
    this.state.lamport = observedLamport;
    this.state.nextSequence = walkEnd + 1;
    this.state.ownStreamHead = previousHash;
    this.state.streams[deviceId] = {
      lastSequence: walkEnd,
      lastEventHash: previousHash,
    };
    await this.stateStore.save(this.state);
  }

  private async readOwnHeadSequence(): Promise<number | null> {
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(
        join(this.deviceRoot(this.state.device.deviceId), "head.json"),
      );
    } catch {
      return null;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    if (
      record.deviceId !== this.state.device.deviceId ||
      !Number.isSafeInteger(record.sequence) ||
      (record.sequence as number) < 1
    ) {
      return null;
    }
    return record.sequence as number;
  }

  private async absorbNewestCheckpoint(): Promise<void> {
    const winner = await this.loadNewestCheckpoint();
    const current = this.state.checkpoint;
    if (winner === null) {
      if (current !== undefined) {
        throw checkpointRollbackError(current.hash);
      }
      return;
    }
    if (current !== undefined) {
      const order = compareCheckpointIdentity(
        { lamport: winner.manifest.lamport, hash: winner.hash },
        current,
      );
      if (order < 0) {
        throw checkpointRollbackError(current.hash);
      }
      if (order === 0) {
        await this.persistLocalCheckpointCopy(winner);
        return;
      }
    }
    await this.persistLocalCheckpointCopy(winner);
    const ownDeviceId = this.state.device.deviceId;
    for (const [deviceId, cursor] of Object.entries(winner.manifest.streams)) {
      // The own cursor is never adopted here; recoverOwnStream owns the
      // (nextSequence, ownStreamHead, streams[own]) triple and adopting one
      // leg alone would desynchronize pinnedOwnStream and wedge publishing.
      if (deviceId === ownDeviceId) {
        continue;
      }
      const local = this.state.streams[deviceId];
      if (local === undefined || local.lastSequence < cursor.lastSequence) {
        this.state.streams[deviceId] = {
          lastSequence: cursor.lastSequence,
          lastEventHash: cursor.lastEventHash,
        };
      } else if (
        local.lastSequence === cursor.lastSequence &&
        local.lastEventHash !== cursor.lastEventHash
      ) {
        throw checkpointStreamRollbackError(deviceId, cursor.lastSequence);
      }
    }
    this.state.checkpoint = {
      hash: winner.hash,
      lamport: winner.manifest.lamport,
      streams: cloneStreams(winner.manifest.streams),
    };
    this.state.lamport = Math.max(this.state.lamport, winner.manifest.lamport);
    this.eventsCache = null;
    this.checkpointManifestCache = {
      hash: winner.hash,
      manifest: winner.manifest,
    };
    await this.stateStore.save(this.state);
    await this.cleanupLocalCheckpointCopies(
      winner.hash,
      winner.manifest.predecessorHash,
    );
  }

  private async loadNewestCheckpoint(): Promise<LoadedCheckpoint | null> {
    let winner: LoadedCheckpoint | null = null;
    const consider = (candidate: LoadedCheckpoint): void => {
      if (
        winner === null ||
        compareCheckpointIdentity(
          { lamport: candidate.manifest.lamport, hash: candidate.hash },
          { lamport: winner.manifest.lamport, hash: winner.hash },
        ) > 0
      ) {
        winner = candidate;
      }
    };
    if (await pathExists(this.sharedCheckpointsRoot)) {
      const entries = await readdir(this.sharedCheckpointsRoot, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (
          !entry.isFile() ||
          entry.name.endsWith(PARTIAL_EXTENSION) ||
          entry.name.includes("sync-conflict")
        ) {
          continue;
        }
        const match = CHECKPOINT_FILE_PATTERN.exec(entry.name);
        if (match === null) {
          continue;
        }
        try {
          consider(
            await this.readCheckpointFile(
              join(this.sharedCheckpointsRoot, entry.name),
              match[2] ?? "",
              Number(match[1]),
            ),
          );
        } catch (error) {
          // A listed shared file that vanished mid-scan was deleted by another
          // device's prune; every other failure on a well-named shared
          // checkpoint is a fail-stop.
          if (isMissingPathError(error)) {
            continue;
          }
          throw error;
        }
      }
    }
    if (await pathExists(this.localCheckpointsRoot)) {
      for (const file of await readdir(this.localCheckpointsRoot)) {
        const match = LOCAL_CHECKPOINT_FILE_PATTERN.exec(file);
        if (match === null) {
          continue;
        }
        try {
          consider(
            await this.readCheckpointFile(
              join(this.localCheckpointsRoot, file),
              match[1] ?? "",
              null,
            ),
          );
        } catch {
          // A damaged local copy is not authoritative; the rollback fail-stop
          // in absorbNewestCheckpoint reports the loss if nothing covers it.
          continue;
        }
      }
    }
    return winner;
  }

  private async readCheckpointFile(
    path: string,
    expectedHash: string,
    expectedLamport: number | null,
  ): Promise<LoadedCheckpoint> {
    const fileInfo = await statResilient(path);
    if (fileInfo.size > MAX_CHECKPOINT_FILE_BYTES) {
      throw new Error(
        `Checkpoint file exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes: ${path}`,
      );
    }
    const bytes = await readFileResilient(path);
    const stored = JSON.parse(bytes.toString("utf8")) as StoredCheckpoint;
    validateStoredCheckpointEnvelope(stored);
    validateCheckpointHeader(stored.header, this.repository.repositoryId);
    if (expectedLamport !== null && stored.header.lamport !== expectedLamport) {
      throw new Error(`Checkpoint lamport does not match its filename: ${path}`);
    }
    const actualHash = sha256(canonicalBytes(stored));
    if (!hashesEqual(expectedHash, actualHash)) {
      throw new Error(`Checkpoint file hash mismatch: ${path}`);
    }
    const plaintext = decryptAead(
      this.checkpointKey,
      stored,
      canonicalBytes(stored.header),
    );
    const manifest = JSON.parse(plaintext.toString("utf8")) as CheckpointManifest;
    validateCheckpointManifest(manifest, stored.header, this.maxPayloadBytes);
    return { hash: actualHash, bytes, stored, manifest };
  }

  async loadAbsorbedCheckpointManifest(): Promise<CheckpointManifest | null> {
    const checkpoint = this.state.checkpoint;
    if (checkpoint === undefined) {
      return null;
    }
    if (this.checkpointManifestCache?.hash === checkpoint.hash) {
      return this.checkpointManifestCache.manifest;
    }
    const manifest = await this.loadCheckpointManifestByHash(checkpoint.hash);
    if (manifest === null) {
      throw checkpointRollbackError(checkpoint.hash);
    }
    this.checkpointManifestCache = { hash: checkpoint.hash, manifest };
    return manifest;
  }

  private async loadCheckpointManifestByHash(
    hash: string,
  ): Promise<CheckpointManifest | null> {
    const localPath = join(
      this.localCheckpointsRoot,
      `${hash}${CHECKPOINT_EXTENSION}`,
    );
    if (await pathExists(localPath)) {
      try {
        return (await this.readCheckpointFile(localPath, hash, null)).manifest;
      } catch {
        // Fall through to the shared copies.
      }
    }
    if (!(await pathExists(this.sharedCheckpointsRoot))) {
      return null;
    }
    for (const file of await readdir(this.sharedCheckpointsRoot)) {
      const match = CHECKPOINT_FILE_PATTERN.exec(file);
      if (match === null || (match[2] ?? "") !== hash) {
        continue;
      }
      try {
        const loaded = await this.readCheckpointFile(
          join(this.sharedCheckpointsRoot, file),
          hash,
          Number(match[1]),
        );
        await this.persistLocalCheckpointCopy(loaded);
        return loaded.manifest;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async persistLocalCheckpointCopy(
    checkpoint: LoadedCheckpoint,
  ): Promise<void> {
    const path = join(
      this.localCheckpointsRoot,
      `${checkpoint.hash}${CHECKPOINT_EXTENSION}`,
    );
    if (!(await pathExists(path))) {
      await writeFileAtomic(path, checkpoint.bytes);
    }
  }

  private async cleanupLocalCheckpointCopies(
    keepHash: string,
    keepPredecessorHash: string | null,
  ): Promise<void> {
    if (!(await pathExists(this.localCheckpointsRoot))) {
      return;
    }
    for (const file of await readdir(this.localCheckpointsRoot)) {
      const match = LOCAL_CHECKPOINT_FILE_PATTERN.exec(file);
      if (match === null) {
        continue;
      }
      const hash = match[1] ?? "";
      if (hash === keepHash || hash === keepPredecessorHash) {
        continue;
      }
      await rm(join(this.localCheckpointsRoot, file), { force: true });
    }
  }

  private async ackCoversCheckpoint(
    ackHash: string,
    targetHash: string,
    cache: Map<string, CheckpointManifest | null>,
  ): Promise<string | null> {
    const visited = new Set<string>();
    let cursor: string | null = ackHash;
    while (cursor !== null && !visited.has(cursor)) {
      if (cursor === targetHash) {
        return null;
      }
      visited.add(cursor);
      let manifest = cache.get(cursor);
      if (manifest === undefined) {
        manifest = await this.loadCheckpointManifestByHash(cursor);
        cache.set(cursor, manifest);
      }
      if (manifest === null) {
        return `acknowledges unknown checkpoint ${cursor}`;
      }
      cursor = manifest.predecessorHash;
    }
    return `has not absorbed checkpoint ${targetHash}`;
  }

  private async prepareCheckpointMarker(): Promise<PreparedCheckpointMarker | null> {
    let tombstone: { resourceId: string; tip: ResourceTip } | null = null;
    for (const resourceId of Object.keys(this.state.tips).sort()) {
      const active = chooseCheckpointTip(this.state.tips[resourceId] ?? []);
      if (active === undefined) {
        continue;
      }
      if (active.operation === "put" && active.payload !== undefined) {
        let content: Buffer;
        try {
          content = await this.readObject(active.payload);
        } catch {
          // A tip blob that has not propagated yet falls through to the next
          // candidate (or the tombstone re-assert) instead of losing the
          // always-one-v2-event marker.
          continue;
        }
        return {
          snapshots: [
            {
              resourceId,
              kind: active.kind,
              content,
              semanticHash: active.semanticHash,
              metadata: { ...active.metadata, syncOrigin: "checkpoint-marker" },
              parents: [active.versionId],
            },
          ],
          deletions: [],
        };
      }
      if (tombstone === null) {
        tombstone = { resourceId, tip: active };
      }
    }
    if (tombstone !== null) {
      return {
        snapshots: [],
        deletions: [
          {
            resourceId: tombstone.resourceId,
            kind: tombstone.tip.kind,
            semanticHash: tombstone.tip.semanticHash,
            metadata: {
              ...tombstone.tip.metadata,
              syncOrigin: "checkpoint-marker",
            },
            parents: [tombstone.tip.versionId],
          },
        ],
      };
    }
    return null;
  }

  async listVisibleDeviceIds(): Promise<string[]> {
    const devicesRoot = join(this.root, "devices");
    if (!(await pathExists(devicesRoot))) {
      return [];
    }
    const entries = await readdir(devicesRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isSafeIdentifier(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async readEvent(
    path: string,
    fileName: string,
    expectedDeviceId: string,
  ): Promise<DecryptedEvent> {
    const fileInfo = await statResilient(path);
    if (fileInfo.size > MAX_EVENT_FILE_BYTES) {
      throw new Error(`Event file exceeds its size limit: ${fileName}`);
    }
    const bytes = await readFileResilient(path);
    const stored = JSON.parse(bytes.toString("utf8")) as StoredEvent;
    validateStoredEventEnvelope(stored);
    validateEventHeader(stored.header, this.repository.repositoryId);
    if (stored.header.deviceId !== expectedDeviceId) {
      throw new Error(`Event device does not match its directory: ${fileName}`);
    }
    const actualHash = sha256(canonicalBytes(stored));
    const match = EVENT_FILE_PATTERN.exec(fileName);
    if (match === null || !hashesEqual(match[2] ?? "", actualHash)) {
      throw new Error(`Event file hash mismatch: ${fileName}`);
    }
    if (Number(match[1]) !== stored.header.sequence) {
      throw new Error(`Event sequence does not match its filename: ${fileName}`);
    }
    const plaintext = decryptAead(this.eventKey, stored, canonicalBytes(stored.header));
    const manifest = JSON.parse(plaintext.toString("utf8")) as EventManifest;
    validateEventManifest(manifest, this.maxPayloadBytes);
    return { path, fileName, eventHash: actualHash, stored, manifest };
  }

  private async writeObject(content: Buffer): Promise<ObjectReference> {
    const compressed = await gzipAsync(content, { level: 9 });
    const objectId = hmacSha256(this.objectIdKey, compressed);
    const reference: ObjectReference = {
      deviceId: this.state.device.deviceId,
      objectId,
      compressedBytes: compressed.byteLength,
      plainBytes: content.byteLength,
    };
    const destination = this.objectPath(reference.deviceId, objectId);
    if (await pathExists(destination)) {
      return reference;
    }
    const header = {
      protocolVersion: PROTOCOL_VERSION,
      envelopeVersion: OBJECT_ENVELOPE_VERSION,
      repositoryId: this.repository.repositoryId,
      deviceId: reference.deviceId,
      objectId,
    };
    const encrypted = encryptAead(this.objectKey, compressed, canonicalBytes(header));
    const stored: StoredObject = { ...header, ...encrypted };
    await ensureDirectory(join(this.blobsRoot(reference.deviceId), objectId.slice(0, 2)));
    await writeFileAtomic(destination, canonicalBytes(stored), false);
    return reference;
  }

  private currentParents(resourceId: string): string[] {
    return (this.state.tips[resourceId] ?? [])
      .map((tip) => tip.versionId)
      .sort((left, right) => left.localeCompare(right));
  }

  private deviceRoot(deviceId: string): string {
    return join(this.root, "devices", deviceId);
  }

  private eventsRoot(deviceId: string): string {
    return join(this.deviceRoot(deviceId), "events");
  }

  private blobsRoot(deviceId: string): string {
    return join(this.deviceRoot(deviceId), "blobs", "sha256");
  }

  private objectPath(deviceId: string, objectId: string): string {
    return join(
      this.blobsRoot(deviceId),
      objectId.slice(0, 2),
      `${objectId}${OBJECT_EXTENSION}`,
    );
  }
}

function pinnedOwnStream(state: LocalSyncState): StreamCursor {
  const lastSequence = state.nextSequence - 1;
  const lastEventHash = state.ownStreamHead;
  const cursor = state.streams[state.device.deviceId];
  if (
    !Number.isSafeInteger(state.nextSequence) ||
    state.nextSequence < 1 ||
    (lastSequence === 0
      ? lastEventHash !== null
      : typeof lastEventHash !== "string" || !isSha256(lastEventHash)) ||
    (cursor === undefined
      ? lastSequence !== 0
      : cursor.lastSequence !== lastSequence ||
        cursor.lastEventHash !== lastEventHash)
  ) {
    throw new Error("Local own-stream cursor is inconsistent; refusing to publish.");
  }
  return { lastSequence, lastEventHash };
}

function ownStreamRollbackError(deviceId: string, detail: string): Error {
  return new Error(
    `Repository own-stream rollback detected for device ${deviceId}: ${detail}. ` +
      "Wait for the shared-folder provider to restore the missing immutable events before publishing.",
  );
}

class OwnStreamPendingRecoveryError extends Error {
  constructor(deviceId: string, detail: string) {
    super(
      `Repository own-stream rollback detected for device ${deviceId}: ${detail}. ` +
        "Waiting for the shared-folder provider to restore the missing immutable events " +
        "or to deliver the checkpoint file that pruned them before publishing.",
    );
  }
}

function checkpointRollbackError(hash: string): Error {
  return new Error(
    `Checkpoint rollback detected — waiting for the shared folder to deliver checkpoint ${hash}.`,
  );
}

function checkpointTooLargeError(): Error {
  return new Error(
    `Checkpoint exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes and cannot be written; ` +
      "the repository is too large to fold into one checkpoint.",
  );
}

function checkpointStreamRollbackError(deviceId: string, sequence: number): Error {
  return new Error(
    `Repository stream rollback detected for device ${deviceId}: ` +
      `the absorbed checkpoint records a different hash for event ${sequence}. ` +
      "Wait for the shared-folder provider to restore the missing immutable events before synchronizing.",
  );
}

function isTolerablePrunedEventError(error: unknown): boolean {
  return (
    isMissingPathError(error) ||
    (error instanceof Error && error.message.startsWith("Event file hash mismatch"))
  );
}

function abortedPrune(reason: string, laggingDevices: string[]): PruneResult {
  return {
    status: "aborted",
    reason,
    laggingDevices,
    eventsDeleted: 0,
    checkpointFilesDeleted: 0,
    reclaimedBytes: 0,
    markerEventHash: null,
    warnings: [],
  };
}

async function removeFileReclaiming(path: string): Promise<number | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
  await rm(path, { force: true });
  return size;
}

function compareCheckpointIdentity(
  left: CheckpointIdentity,
  right: CheckpointIdentity,
): number {
  if (left.lamport !== right.lamport) {
    return left.lamport - right.lamport;
  }
  return left.hash.localeCompare(right.hash);
}

function cloneStreams(
  streams: Record<string, StreamCursor>,
): Record<string, StreamCursor> {
  const cloned: Record<string, StreamCursor> = {};
  for (const [deviceId, cursor] of Object.entries(streams)) {
    cloned[deviceId] = {
      lastSequence: cursor.lastSequence,
      lastEventHash: cursor.lastEventHash,
    };
  }
  return cloned;
}

// Mirrors the reconciler's active-tip selection; kept local so the protocol
// layer does not depend on the reconciler.
function chooseCheckpointTip(tips: ResourceTip[]): ResourceTip | undefined {
  if (tips.length === 0) {
    return undefined;
  }
  const updates = tips.filter((tip) => tip.operation === "put");
  const candidates = updates.length > 0 ? updates : tips;
  return [...candidates].sort(compareCheckpointTips)[0];
}

function compareCheckpointTips(left: ResourceTip, right: ResourceTip): number {
  if (left.lamport !== right.lamport) {
    return right.lamport - left.lamport;
  }
  const deviceOrder = right.deviceId.localeCompare(left.deviceId);
  if (deviceOrder !== 0) {
    return deviceOrder;
  }
  return right.eventHash.localeCompare(left.eventHash);
}

function compareVersionSummaries(
  left: ResourceVersionSummary,
  right: ResourceVersionSummary,
): number {
  if (left.lamport !== right.lamport) {
    return right.lamport - left.lamport;
  }
  const createdOrder = right.createdAt.localeCompare(left.createdAt);
  if (createdOrder !== 0) {
    return createdOrder;
  }
  return right.versionId.localeCompare(left.versionId);
}

function parseCheckpointIdentity(value: unknown): CheckpointIdentity | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !isSha256(record.hash) ||
    !Number.isSafeInteger(record.lamport) ||
    (record.lamport as number) < 1
  ) {
    return null;
  }
  return { hash: record.hash, lamport: record.lamport as number };
}

function isValidStreamCursor(value: unknown): value is StreamCursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(cursor.lastSequence) &&
    (cursor.lastSequence as number) >= 1 &&
    isSha256(cursor.lastEventHash)
  );
}

function validateStoredCheckpointEnvelope(stored: StoredCheckpoint): void {
  if (
    !hasExactObjectKeys(stored, ["header", "nonce", "ciphertext", "tag"]) ||
    !hasExactObjectKeys(stored.header, [
      "protocolVersion",
      "envelopeVersion",
      "repositoryId",
      "deviceId",
      "lamport",
    ]) ||
    !isCanonicalBase64(stored.nonce, 12) ||
    !isCanonicalBase64(stored.tag, 16) ||
    !isCanonicalBase64(stored.ciphertext)
  ) {
    throw new Error("Checkpoint envelope is invalid.");
  }
}

function validateCheckpointHeader(
  header: CheckpointHeader,
  repositoryId: string,
): void {
  if (
    header.protocolVersion !== PROTOCOL_VERSION ||
    header.envelopeVersion !== CHECKPOINT_ENVELOPE_VERSION
  ) {
    throw new Error("Unsupported checkpoint envelope version.");
  }
  if (header.repositoryId !== repositoryId) {
    throw new Error("Checkpoint belongs to a different repository.");
  }
  assertSafeIdentifier(header.deviceId, "checkpoint device ID");
  if (!Number.isSafeInteger(header.lamport) || header.lamport < 1) {
    throw new Error("Checkpoint Lamport value is invalid.");
  }
}

function validateCheckpointManifest(
  manifest: CheckpointManifest,
  header: CheckpointHeader,
  maxPayloadBytes: number,
): void {
  if (
    !hasExactObjectKeys(manifest, [
      "checkpointVersion",
      "createdAt",
      "deviceId",
      "lamport",
      "predecessorHash",
      "streams",
      "resources",
    ])
  ) {
    throw new Error("Checkpoint manifest contains unknown or missing fields.");
  }
  if (manifest.checkpointVersion !== 1) {
    throw new Error(
      `Unsupported checkpoint manifest version: ${String(manifest.checkpointVersion)}`,
    );
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("Checkpoint creation time is invalid.");
  }
  if (
    manifest.deviceId !== header.deviceId ||
    manifest.lamport !== header.lamport
  ) {
    throw new Error("Checkpoint manifest does not match its header.");
  }
  if (manifest.predecessorHash !== null && !isSha256(manifest.predecessorHash)) {
    throw new Error("Checkpoint predecessor hash is invalid.");
  }
  if (
    manifest.streams === null ||
    typeof manifest.streams !== "object" ||
    Array.isArray(manifest.streams)
  ) {
    throw new Error("Checkpoint stream cursors are invalid.");
  }
  for (const [deviceId, cursor] of Object.entries(manifest.streams)) {
    assertSafeIdentifier(deviceId, "checkpoint stream device ID");
    if (!isValidStreamCursor(cursor)) {
      throw new Error(`Checkpoint stream cursor is invalid for device ${deviceId}.`);
    }
  }
  if (!Array.isArray(manifest.resources)) {
    throw new Error("Checkpoint resources are invalid.");
  }
  let previousResourceId: string | null = null;
  for (const resource of manifest.resources) {
    validateCheckpointResource(resource, maxPayloadBytes);
    if (previousResourceId !== null && resource.resourceId <= previousResourceId) {
      throw new Error("Checkpoint resources are not sorted by resource ID.");
    }
    previousResourceId = resource.resourceId;
  }
}

const CHECKPOINT_RESOURCE_REQUIRED_KEYS = [
  "resourceId",
  "kind",
  "operation",
  "semanticHash",
  "versionId",
  "lamport",
  "deviceId",
] as const;
const CHECKPOINT_RESOURCE_OPTIONAL_KEYS = ["payload", "metadata", "producer"] as const;

function validateCheckpointResource(
  resource: CheckpointResource,
  maxPayloadBytes: number,
): void {
  if (
    resource === null ||
    typeof resource !== "object" ||
    Array.isArray(resource) ||
    !CHECKPOINT_RESOURCE_REQUIRED_KEYS.every((key) => Object.hasOwn(resource, key)) ||
    !Object.keys(resource).every(
      (key) =>
        (CHECKPOINT_RESOURCE_REQUIRED_KEYS as readonly string[]).includes(key) ||
        (CHECKPOINT_RESOURCE_OPTIONAL_KEYS as readonly string[]).includes(key),
    )
  ) {
    throw new Error("Checkpoint resource contains unknown or missing fields.");
  }
  if (
    typeof resource.resourceId !== "string" ||
    resource.resourceId.length === 0 ||
    resource.resourceId.length > 4096 ||
    resource.resourceId.includes("\0") ||
    typeof resource.kind !== "string" ||
    resource.kind.length > 64 ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(resource.kind) ||
    !resource.resourceId.startsWith(`${resource.kind}/`) ||
    (resource.operation !== "put" && resource.operation !== "delete") ||
    !isSha256(resource.semanticHash) ||
    !/^[a-f0-9]{64}#\d+$/.test(resource.versionId) ||
    !Number.isSafeInteger(resource.lamport) ||
    resource.lamport < 1
  ) {
    throw new Error(`Checkpoint resource is invalid: ${String(resource.resourceId)}`);
  }
  assertSafeIdentifier(resource.deviceId, "checkpoint resource device ID");
  if (resource.operation === "put") {
    if (resource.payload === undefined) {
      throw new Error(`Checkpoint put resource has no payload: ${resource.resourceId}`);
    }
    validateObjectReference(resource.payload, maxPayloadBytes);
  } else if (resource.payload !== undefined) {
    throw new Error(
      `Checkpoint delete resource unexpectedly has a payload: ${resource.resourceId}`,
    );
  }
  if (
    resource.metadata !== undefined &&
    (resource.metadata === null ||
      Array.isArray(resource.metadata) ||
      typeof resource.metadata !== "object")
  ) {
    throw new Error(`Checkpoint resource metadata is invalid: ${resource.resourceId}`);
  }
  if (resource.producer !== undefined) {
    validateEventProducer(resource.producer);
  }
}

function objectHeader(stored: StoredObject): Omit<StoredObject, "nonce" | "ciphertext" | "tag"> {
  return {
    protocolVersion: stored.protocolVersion,
    envelopeVersion: stored.envelopeVersion,
    repositoryId: stored.repositoryId,
    deviceId: stored.deviceId,
    objectId: stored.objectId,
  };
}

function validateEventHeader(header: EventHeader, repositoryId: string): void {
  if (
    !hasExactObjectKeys(header, [
      "protocolVersion",
      "envelopeVersion",
      "repositoryId",
      "deviceId",
      "sequence",
      "previousEventHash",
    ])
  ) {
    throw new Error("Event header contains unknown or missing fields.");
  }
  if (
    (header.protocolVersion !== PROTOCOL_VERSION &&
      header.protocolVersion !== CHECKPOINTED_EVENT_PROTOCOL_VERSION) ||
    header.envelopeVersion !== EVENT_ENVELOPE_VERSION
  ) {
    throw new Error("Unsupported event envelope version.");
  }
  if (header.repositoryId !== repositoryId) {
    throw new Error("Event belongs to a different repository.");
  }
  assertSafeIdentifier(header.deviceId, "event device ID");
  if (
    header.previousEventHash !== null &&
    !isSha256(header.previousEventHash)
  ) {
    throw new Error("Event previous hash is invalid.");
  }
  if (header.sequence < 1 || !Number.isSafeInteger(header.sequence)) {
    throw new Error("Event sequence is invalid.");
  }
}

export function validateEventManifest(
  manifest: EventManifest,
  maxPayloadBytes: number,
): void {
  if (manifest.eventVersion !== EVENT_ENVELOPE_VERSION) {
    throw new Error(`Unsupported event manifest version: ${manifest.eventVersion}`);
  }
  if (!Number.isSafeInteger(manifest.lamport) || manifest.lamport < 1) {
    throw new Error("Event Lamport value is invalid.");
  }
  if (
    !Array.isArray(manifest.changes) ||
    manifest.changes.length === 0 ||
    manifest.changes.length > MAX_EVENT_CHANGES
  ) {
    throw new Error("Event does not contain resource changes.");
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("Event creation time is invalid.");
  }
  if (manifest.producer !== undefined) {
    validateEventProducer(manifest.producer);
  }
  for (const change of manifest.changes) {
    validateResourceChange(change, maxPayloadBytes);
  }
}

function validateEventProducer(producer: EventProducer): void {
  if (
    producer === null ||
    typeof producer !== "object" ||
    !isBoundedVersion(producer.extensionVersion) ||
    !isBoundedVersion(producer.cursorVersion) ||
    !isBoundedVersion(producer.vscodeVersion)
  ) {
    throw new Error("Event producer metadata is invalid.");
  }
}

function isBoundedVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validateResourceChange(
  change: ResourceChange,
  maxPayloadBytes: number,
): void {
  if (
    typeof change.resourceId !== "string" ||
    change.resourceId.length === 0 ||
    change.resourceId.length > 4096 ||
    change.resourceId.includes("\0") ||
    typeof change.kind !== "string" ||
    change.kind.length > 64 ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(change.kind) ||
    !change.resourceId.startsWith(`${change.kind}/`) ||
    (change.operation !== "put" && change.operation !== "delete") ||
    !isSha256(change.semanticHash)
  ) {
    throw new Error("Event contains an invalid resource change.");
  }
  if (
    !Array.isArray(change.parents) ||
    change.parents.length > MAX_PARENTS_PER_CHANGE ||
    change.parents.some((parent) => !/^[a-f0-9]{64}#\d+$/.test(parent))
  ) {
    throw new Error(`Resource parents are invalid: ${change.resourceId}`);
  }
  if (new Set(change.parents).size !== change.parents.length) {
    throw new Error(`Resource parents contain duplicates: ${change.resourceId}`);
  }
  if (change.operation === "put") {
    if (change.payload === undefined) {
      throw new Error(`Put resource has no payload: ${change.resourceId}`);
    }
    validateObjectReference(change.payload, maxPayloadBytes);
  } else if (change.payload !== undefined) {
    throw new Error(`Delete resource unexpectedly has a payload: ${change.resourceId}`);
  }
  if (
    change.metadata !== undefined &&
    (change.metadata === null ||
      Array.isArray(change.metadata) ||
      typeof change.metadata !== "object")
  ) {
    throw new Error(`Resource metadata is invalid: ${change.resourceId}`);
  }
}

function validateObjectReference(
  reference: ObjectReference,
  maxPayloadBytes: number,
): void {
  assertSafeIdentifier(reference.deviceId, "object device ID");
  if (
    !isSha256(reference.objectId) ||
    !Number.isSafeInteger(reference.compressedBytes) ||
    reference.compressedBytes < 0 ||
    reference.compressedBytes > maxPayloadBytes + 1024 * 1024 ||
    !Number.isSafeInteger(reference.plainBytes) ||
    reference.plainBytes < 0 ||
    reference.plainBytes > maxPayloadBytes
  ) {
    throw new Error("Object reference is invalid.");
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isSafeIdentifier(value: string): boolean {
  try {
    assertSafeIdentifier(value, "repository identifier");
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function validateObjectHeader(
  stored: StoredObject,
  repositoryId: string,
  reference: ObjectReference,
): void {
  if (
    stored.protocolVersion !== PROTOCOL_VERSION ||
    stored.envelopeVersion !== OBJECT_ENVELOPE_VERSION
  ) {
    throw new Error("Unsupported object envelope version.");
  }
  if (
    stored.repositoryId !== repositoryId ||
    stored.deviceId !== reference.deviceId ||
    stored.objectId !== reference.objectId
  ) {
    throw new Error(`Object header mismatch: ${reference.objectId}`);
  }
}

function validateStoredEventEnvelope(stored: StoredEvent): void {
  if (
    !hasExactObjectKeys(stored, ["header", "nonce", "ciphertext", "tag"]) ||
    !hasExactObjectKeys(stored.header, [
      "protocolVersion",
      "envelopeVersion",
      "repositoryId",
      "deviceId",
      "sequence",
      "previousEventHash",
    ]) ||
    !isCanonicalBase64(stored.nonce, 12) ||
    !isCanonicalBase64(stored.tag, 16) ||
    !isCanonicalBase64(stored.ciphertext)
  ) {
    throw new Error("Event envelope is invalid.");
  }
}

function validateStoredObjectEnvelope(
  stored: StoredObject,
  reference: ObjectReference,
): void {
  if (
    !hasExactObjectKeys(stored, [
      "protocolVersion",
      "envelopeVersion",
      "repositoryId",
      "deviceId",
      "objectId",
      "nonce",
      "ciphertext",
      "tag",
    ]) ||
    !isCanonicalBase64(stored.nonce, 12) ||
    !isCanonicalBase64(stored.tag, 16) ||
    !isCanonicalBase64(stored.ciphertext, reference.compressedBytes)
  ) {
    throw new Error(`Object envelope is invalid: ${reference.objectId}`);
  }
}

function isCanonicalBase64(value: unknown, expectedBytes?: number): value is string {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return expectedBytes === undefined || decoded.byteLength === expectedBytes;
}
