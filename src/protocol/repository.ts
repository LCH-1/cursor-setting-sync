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
  MAX_APPLY_BATCH_BYTES,
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
  ResourceKind,
  ResourceSnapshot,
  ResourceTip,
  ResourceVersionSummary,
  StreamCursor,
  StoredCheckpoint,
  StoredEvent,
  StoredObject,
} from "../types";
import { HELPER_APPLIED_KINDS, isSupportedResourceKind } from "../types";
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
  compareCodeUnits,
  hashesEqual,
  hasExactObjectKeys,
  hmacSha256,
  isCanonicalBase64Text,
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
/**
 * How long an unchanged acks.json may go without a refreshed timestamp. Short
 * enough that a device that has been quiet still looks alive to a peer reading
 * the file, long enough that an idle repository is not a continuous upload.
 */
const ACK_HEARTBEAT_MS = 15 * 60 * 1000;
/**
 * How long a file this device wrote keeps suppressing the watcher. Comfortably
 * longer than the watcher's own one-second debounce, short enough that a peer
 * republishing byte-identical content is not ignored for long.
 */
const SELF_WRITE_MEMORY_MS = 10_000;
const PRUNE_AGE_GATE_MS = 24 * 60 * 60 * 1000;

export interface DecryptedEvent {
  path: string;
  fileName: string;
  eventHash: string;
  stored: StoredEvent;
  manifest: EventManifest;
}

/** A decoded event plus the file identity that proved it is still current. */
interface CachedEvent {
  event: DecryptedEvent;
  size: number;
  mtimeMs: number;
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
  /** Per-cycle memo of the sorted listing; cleared whenever state reloads. */
  private eventsCache: DecryptedEvent[] | null = null;
  /**
   * Every event file this process has already read, verified and decrypted,
   * keyed by `<deviceId>/<fileName>`. Event files are immutable and content
   * addressed — the filename carries both the sequence and the sha256 — so a
   * file that was verified once never needs to be stat'd, read, hashed and
   * AES-decrypted again. Only an actual deletion (prune) invalidates an entry,
   * which is why `refreshState` does not clear this.
   */
  private readonly decodedEvents = new Map<string, CachedEvent>();
  private checkpointManifestCache: { hash: string; manifest: CheckpointManifest } | null = null;
  private lastWrittenAck: { payload: string; writtenAt: number } | null = null;
  /**
   * File names this device just wrote into the shared folder. The recursive
   * watcher cannot tell its own process's writes from a peer's, so every
   * publish used to schedule a second, entirely redundant sync cycle one
   * second later. Event and object file names are content addressed and
   * therefore unique, so the base name alone identifies the write.
   */
  private readonly selfWritten = new Map<string, number>();
  private pendingRecovery: Error | null = null;

  private constructor(
    readonly root: string,
    readonly repository: RepositoryFile,
    readonly masterKey: Buffer,
    readonly stateStore: LocalStateStore,
    readonly state: LocalSyncState,
    private effectiveMaxPayloadBytes: number,
    private readonly producer: EventProducer,
  ) {
    this.eventKey = deriveSubkey(masterKey, "event-encryption");
    this.objectKey = deriveSubkey(masterKey, "object-encryption");
    this.objectIdKey = deriveSubkey(masterKey, "object-id");
    this.checkpointKey = deriveSubkey(masterKey, "checkpoint-encryption");
  }

  /**
   * The limit {@link publish} enforces. Readable from outside so a caller can
   * decline to build a payload it already knows `publish` would reject, instead
   * of letting the throw abort the cycle.
   */
  get maxPayloadBytes(): number {
    return this.effectiveMaxPayloadBytes;
  }

  /**
   * Tracks `cursorSettingSync.maxPayloadMiB`, which is a live setting.
   *
   * The limit used to be frozen at open, while the publish guard read the
   * setting on every cycle. Raising the setting is exactly the remedy the
   * oversized-payload warning tells the user to apply, so the guard would start
   * admitting a snapshot that `publish` still rejected against the stale
   * captured value — and the resulting error re-threw on every poll until
   * Cursor was restarted. The two must be the same number.
   */
  setMaxPayloadBytes(maxPayloadBytes: number): void {
    this.effectiveMaxPayloadBytes = maxPayloadBytes;
  }

  get pendingRecoveryError(): Error | null {
    return this.pendingRecovery;
  }

  /** True when this device wrote `fileName` moments ago. */
  wroteRecently(fileName: string): boolean {
    const writtenAt = this.selfWritten.get(fileName);
    return (
      writtenAt !== undefined && Date.now() - writtenAt <= SELF_WRITE_MEMORY_MS
    );
  }

  private noteSelfWrite(fileName: string): void {
    const now = Date.now();
    for (const [name, writtenAt] of this.selfWritten) {
      if (now - writtenAt > SELF_WRITE_MEMORY_MS) {
        this.selfWritten.delete(name);
      }
    }
    this.selfWritten.set(fileName, now);
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

    changes.sort((left, right) => compareCodeUnits(left.resourceId, right.resourceId));
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
    const sequencePrefix = `${String(header.sequence).padStart(16, "0")}-`;
    const eventFileName = `${sequencePrefix}${eventHash}${EVENT_EXTENSION}`;
    const eventPath = join(this.eventsRoot(header.deviceId), eventFileName);
    // ANY file at this sequence refuses the publish, not just the exact
    // hash-qualified name: a device whose state was restored from an OS
    // backup can believe a sequence is free while its own older publication
    // of that sequence is still hydrating from the cloud - writing a second
    // file there forks the immutable stream and fail-stops every machine.
    try {
      const siblings = await readdir(this.eventsRoot(header.deviceId));
      const occupied = siblings.find(
        (name) => name.startsWith(sequencePrefix) && name.endsWith(EVENT_EXTENSION),
      );
      if (occupied !== undefined) {
        throw new Error(
          `Event sequence ${header.sequence} is already occupied by ${occupied}; ` +
            "this device's local state appears older than its published stream (was it restored from a backup?). " +
            "Waiting for the shared folder to finish delivering this device's own events.",
        );
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      // First publish for this device: the directory does not exist yet.
    }
    await writeFileAtomic(eventPath, storedBytes, false);
    this.noteSelfWrite(eventFileName);
    // The event just written is already fully decoded in memory, so it is
    // added to both caches rather than discarding them and forcing the rest of
    // the cycle to re-read and re-decrypt the entire log.
    const published: DecryptedEvent = {
      path: eventPath,
      fileName: eventFileName,
      eventHash,
      stored,
      manifest,
    };
    this.decodedEvents.set(`${header.deviceId}/${eventFileName}`, {
      event: published,
      size: storedBytes.byteLength,
      mtimeMs: (await statResilient(eventPath)).mtimeMs,
    });
    if (this.eventsCache !== null) {
      this.eventsCache = [...this.eventsCache, published].sort(
        compareDecryptedEvents,
      );
    }

    this.state.nextSequence += 1;
    this.state.lamport = manifest.lamport;
    this.state.ownStreamHead = eventHash;
    this.state.streams[header.deviceId] = {
      lastSequence: header.sequence,
      lastEventHash: eventHash,
    };
    await this.stateStore.save(this.state);
    try {
      await writeJsonAtomic(join(this.deviceRoot(header.deviceId), "head.json"), {
        deviceId: header.deviceId,
        sequence: header.sequence,
        eventHash,
        lamport: manifest.lamport,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // head.json is advisory - its reader already tolerates absence and
      // damage. The event and state writes above ARE the publish; reporting
      // it failed over a hint file made a durably committed publish retry
      // and duplicate.
    }
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
    const seen = new Set<string>();
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
        const eventPath = join(eventRoot, file.name);
        const cacheKey = `${deviceEntry.name}/${file.name}`;
        try {
          // One stat decides whether the already-verified decode can be reused.
          // Event files are immutable, so an unchanged size and mtime means the
          // bytes are the ones that were hashed, decrypted and validated
          // earlier; only a file that actually changed pays that cost again.
          const info = await statResilient(eventPath);
          const cached = this.decodedEvents.get(cacheKey);
          if (
            cached !== undefined &&
            cached.size === info.size &&
            cached.mtimeMs === info.mtimeMs
          ) {
            seen.add(cacheKey);
            events.push(cached.event);
            continue;
          }
          const read = await this.readEvent(eventPath, file.name, deviceEntry.name);
          this.decodedEvents.set(cacheKey, {
            event: read,
            size: info.size,
            mtimeMs: info.mtimeMs,
          });
          seen.add(cacheKey);
          events.push(read);
        } catch (error) {
          this.decodedEvents.delete(cacheKey);
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
    // Entries whose file is gone were pruned by this or another device.
    for (const key of [...this.decodedEvents.keys()]) {
      if (!seen.has(key)) {
        this.decodedEvents.delete(key);
      }
    }
    const sorted = events.sort(compareDecryptedEvents);
    this.eventsCache = sorted;
    return [...sorted];
  }

  /** How many event files are currently visible, for the maintenance trigger. */
  async countEvents(): Promise<number> {
    return (await this.listEvents()).length;
  }

  async readObject(reference: ObjectReference): Promise<Buffer> {
    // `maxPayloadBytes` bounds what this device *publishes*. Reads are bounded
    // by the reference itself (capped by the absolute apply ceiling), because
    // lowering `cursorSettingSync.maxPayloadMiB` below something already in the
    // repository must not make that resource permanently unreadable.
    const readLimit = Math.min(
      MAX_APPLY_BATCH_BYTES,
      Math.max(this.maxPayloadBytes, reference.plainBytes),
    );
    validateObjectReference(reference, readLimit);
    const path = this.objectPath(reference.deviceId, reference.objectId);
    const fileInfo = await statResilient(path);
    const envelopeLimit = Math.min(
      MAX_OBJECT_ENVELOPE_BYTES,
      Math.ceil(readLimit * 1.5) + 1024 * 1024,
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
      maxOutputLength: readLimit,
    });
    if (plain.byteLength !== reference.plainBytes) {
      throw new Error(`Object plain size mismatch: ${reference.objectId}`);
    }
    if (plain.byteLength > readLimit) {
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

  /**
   * Persists only `lastError`.
   *
   * A cycle that threw may have left `this.state` half-mutated - a checkpoint
   * absorb that adopted two device cursors and then hit a rollback on the
   * third, for example. Flushing that to disk turns a transient fault into a
   * permanent fail-stop, so the on-disk state is reloaded first and the error
   * recorded on top of it. The in-memory copy is reset to match, so nothing
   * downstream keeps using the abandoned mutations.
   */
  async recordError(message: string): Promise<void> {
    try {
      const persisted = await this.stateStore.load(this.repository.repositoryId);
      persisted.lastError = message;
      Object.assign(this.state, persisted);
      await this.stateStore.save(persisted);
      return;
    } catch {
      // The state file itself is unreadable; fall back to what is in memory so
      // the error is at least recorded somewhere.
    }
    this.state.lastError = message;
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

  /**
   * Records this device's cursors for the prune gate.
   *
   * The payload used to carry a fresh `updatedAt` on every call, so the file
   * changed on every cycle even when nothing had moved and the cloud client
   * uploaded it (plus a `.partial` create and delete) around 2,900 times a day
   * for data that changes a few times an hour. The timestamp now moves only
   * when the cursors move, or on a slow heartbeat so a long-idle device still
   * looks alive.
   */
  async writeAck(): Promise<void> {
    const body = {
      deviceId: this.state.device.deviceId,
      streams: this.state.streams,
      absorbedCheckpoint:
        this.state.checkpoint === undefined
          ? null
          : {
              hash: this.state.checkpoint.hash,
              lamport: this.state.checkpoint.lamport,
            },
    };
    const payload = canonicalBytes(body).toString("utf8");
    const now = Date.now();
    if (
      this.lastWrittenAck !== null &&
      this.lastWrittenAck.payload === payload &&
      now - this.lastWrittenAck.writtenAt < ACK_HEARTBEAT_MS
    ) {
      return;
    }
    await writeJsonAtomic(
      join(this.deviceRoot(this.state.device.deviceId), "acks.json"),
      { ...body, updatedAt: new Date(now).toISOString() },
    );
    this.lastWrittenAck = { payload, writtenAt: now };
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

  /**
   * Throws when the visible event log or the absorbed checkpoint carries a
   * resource kind this build does not know. Folding or pruning around such a
   * kind silently destroys a newer build's data; the remedy is updating the
   * extension, and the message says so.
   */
  private async assertNoUnknownResourceKinds(action: string): Promise<void> {
    const unknown = new Set<string>();
    for (const event of await this.listEvents()) {
      for (const change of event.manifest.changes) {
        if (!isSupportedResourceKind(change.kind)) {
          unknown.add(String(change.kind));
        }
      }
    }
    const manifest = await this.loadAbsorbedCheckpointManifest();
    for (const resource of manifest?.resources ?? []) {
      if (!isSupportedResourceKind(resource.kind)) {
        unknown.add(String(resource.kind));
      }
    }
    if (unknown.size > 0) {
      throw new Error(
        `Refused to ${action}: the repository contains resource kinds this extension version does not understand (${[...unknown].sort().join(", ")}). Update Cursor Setting Sync on this computer first - folding or pruning around them would silently destroy the newer computer's data.`,
      );
    }
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
    // Forward-compatibility fail-safe: a future release that adds a resource
    // kind syncs fine through THIS build (kind is just a validated string),
    // but folding history would silently OMIT every such resource from the
    // checkpoint - reconciliation skips unknown kinds - and the prune that
    // follows would then delete the only events carrying them. Refusing here
    // is the one chance a fielded build has to protect data a newer build
    // published.
    await this.assertNoUnknownResourceKinds("create a checkpoint");
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
    // Same suppression publish and writeObject use: the watcher forwards
    // checkpoint files, and without this the device schedules a redundant
    // cycle over its own checkpoint.
    this.noteSelfWrite(fileName);
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
    try {
      await this.assertNoUnknownResourceKinds("prune history");
    } catch (error) {
      return abortedPrune(
        error instanceof Error ? error.message : String(error),
        [],
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
    this.decodedEvents.clear();
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
    // Two files at one sequence in the device's OWN stream is a fork this
    // device minted - the OS-restore scenario where local state and the local
    // cloud replica rolled back together and a publish beat rehydration. The
    // walk below filters to sequences above the verified head and would
    // silently keep extending one branch; every peer meanwhile fail-stops.
    // The owner is the one device that can see and name the problem.
    for (let index = 1; index < allFiles.length; index += 1) {
      const current = allFiles[index];
      const previous = allFiles[index - 1];
      if (
        current !== undefined &&
        previous !== undefined &&
        current.match[1] === previous.match[1]
      ) {
        throw ownStreamRollbackError(
          deviceId,
          `two events exist at sequence ${Number(current.match[1])} (${previous.file} and ${current.file}) - this device's stream has forked, most likely after restoring this computer from a backup. Keep the file every OTHER computer already accepted (check their warnings for the expected hash) and move the other one out of the folder`,
        );
      }
    }
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
    // Only events above the pinned cursor are decrypted. Everything at or below
    // it was walked and verified on an earlier run and event files are
    // immutable, so re-reading the whole stream every 30 seconds proves nothing
    // new. What still has to be checked is that the pinned event is *there*,
    // and the filename carries both the sequence and the sha256 the walk would
    // have compared, so `readdir` alone answers that.
    if (pinned.lastSequence > coveredSequence) {
      const pinnedFile = allFiles.find(
        (entry) =>
          Number(entry.match[1]) === pinned.lastSequence &&
          (entry.match[2] ?? "") === pinned.lastEventHash,
      );
      if (pinnedFile === undefined) {
        throw new OwnStreamPendingRecoveryError(
          deviceId,
          `previously published event ${pinned.lastSequence} is no longer visible`,
        );
      }
    }
    const verifiedSequence = Math.max(coveredSequence, pinned.lastSequence);
    const files = allFiles.filter(
      (entry) => Number(entry.match[1]) > verifiedSequence,
    );
    let previousHash: string | null =
      pinned.lastSequence >= coveredSequence
        ? pinned.lastEventHash
        : checkpointCursor?.lastEventHash ?? null;
    let expectedSequence = verifiedSequence + 1;
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
    // The pinned cursor is only what THIS state file remembers - and a state
    // file restored from an OS backup remembers less than the device actually
    // published. head.json in the shared folder records the real head; while
    // the cloud is still hydrating the newer event files, publishing would
    // mint a sequence that already exists out there with different bytes,
    // forking the immutable own stream and fail-stopping every machine. Wait
    // instead, exactly like the checkpoint branch already does.
    const headSequence = await this.readOwnHeadSequence();
    if (headSequence !== null && expectedSequence - 1 < headSequence) {
      throw new OwnStreamPendingRecoveryError(
        deviceId,
        `this device's own head records event ${headSequence}, which has not finished arriving from the shared folder`,
      );
    }
    const cursor = this.state.streams[deviceId];
    // A device that has published nothing has no pinned cursor at all. The
    // (nextSequence, ownStreamHead, streams[own]) triple encodes "empty
    // stream" as an *absent* entry — that is exactly what `pinnedOwnStream`
    // requires — and `{lastSequence: 0, lastEventHash: null}` is a cursor no
    // validator accepts: `validatePinnedStreamCursor` rejects it outright, so
    // writing one made a device that had merely joined an existing repository
    // throw on its first reconcile, before it had ever published.
    const expectedCursor: StreamCursor | undefined =
      previousHash === null || expectedSequence - 1 < 1
        ? undefined
        : { lastSequence: expectedSequence - 1, lastEventHash: previousHash };
    if (
      this.state.lamport === observedLamport &&
      this.state.nextSequence === expectedSequence &&
      this.state.ownStreamHead === previousHash &&
      cursor?.lastSequence === expectedCursor?.lastSequence &&
      cursor?.lastEventHash === expectedCursor?.lastEventHash
    ) {
      // Nothing moved, and only this process appends to its own stream, so
      // rewriting the whole state file would be a pure cost.
      return;
    }
    this.state.lamport = observedLamport;
    this.state.nextSequence = expectedSequence;
    this.state.ownStreamHead = previousHash;
    if (expectedCursor === undefined) {
      // Also repairs a `{0, null}` entry an earlier build of this release
      // persisted, so an already-wedged device recovers on its next refresh.
      delete this.state.streams[deviceId];
    } else {
      this.state.streams[deviceId] = expectedCursor;
    }
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
    const current = this.state.checkpoint;
    // The filename carries the (lamport, hash) pair that decides the winner, so
    // the winner is known from `readdir` alone. When it is the checkpoint this
    // device already absorbed there is nothing to do, and opening, hashing,
    // decrypting and revalidating a multi-megabyte manifest twice a minute to
    // conclude that would be pure waste. A local copy can never be newer than
    // the absorbed checkpoint, so it needs no look either.
    const sharedCandidates = await this.sharedCheckpointCandidates();
    const sharedWinner = sharedCandidates[0];
    if (
      current !== undefined &&
      sharedWinner !== undefined &&
      sharedWinner.hash === current.hash &&
      sharedWinner.lamport === current.lamport
    ) {
      await this.ensureLocalCheckpointCopy(sharedWinner);
      return;
    }
    const winner = await this.loadNewestCheckpoint(sharedCandidates);
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
    // Built to the side and installed only once every device agreed. Mutating
    // `this.state.streams` in place let a rollback thrown halfway through leave
    // some cursors adopted from the checkpoint while `state.checkpoint` stayed
    // behind, and the error path then persisted exactly that, wedging the
    // device in a fail-stop no later cycle could clear.
    const nextStreams: Record<string, StreamCursor> = cloneStreams(
      this.state.streams,
    );
    for (const [deviceId, cursor] of Object.entries(winner.manifest.streams)) {
      // The own cursor is never adopted here; recoverOwnStream owns the
      // (nextSequence, ownStreamHead, streams[own]) triple and adopting one
      // leg alone would desynchronize pinnedOwnStream and wedge publishing.
      if (deviceId === ownDeviceId) {
        continue;
      }
      const local = nextStreams[deviceId];
      if (local === undefined || local.lastSequence < cursor.lastSequence) {
        nextStreams[deviceId] = {
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
    this.state.streams = nextStreams;
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

  /**
   * Shared checkpoint files that could win, newest first. The ordering key
   * `(lamport, hash)` comes straight out of the filename, and
   * `readCheckpointFile` rejects any file whose contents disagree with its
   * name, so this ordering is the ordering of the decoded manifests.
   */
  private async sharedCheckpointCandidates(): Promise<
    Array<CheckpointIdentity & { path: string }>
  > {
    if (!(await pathExists(this.sharedCheckpointsRoot))) {
      return [];
    }
    const candidates: Array<CheckpointIdentity & { path: string }> = [];
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
      candidates.push({
        lamport: Number(match[1]),
        hash: match[2] ?? "",
        path: join(this.sharedCheckpointsRoot, entry.name),
      });
    }
    return candidates.sort((left, right) =>
      compareCheckpointIdentity(right, left),
    );
  }

  /**
   * Writes the local copy of an already-absorbed checkpoint if it is missing,
   * decoding nothing when the copy is already there.
   */
  private async ensureLocalCheckpointCopy(
    identity: CheckpointIdentity & { path: string },
  ): Promise<void> {
    const localPath = join(
      this.localCheckpointsRoot,
      `${identity.hash}${CHECKPOINT_EXTENSION}`,
    );
    if (await pathExists(localPath)) {
      return;
    }
    try {
      await this.persistLocalCheckpointCopy(
        await this.readCheckpointFile(
          identity.path,
          identity.hash,
          identity.lamport,
        ),
      );
    } catch (error) {
      // The shared copy vanishing mid-cycle is another device's prune, and a
      // torn read is the same file mid-propagation; the absorbed manifest
      // stays reachable through the manifest loader, and the local copy is
      // retried on a later cycle.
      if (
        !isMissingPathError(error) &&
        !isTolerableTornCheckpointError(error)
      ) {
        throw error;
      }
    }
  }

  private async loadNewestCheckpoint(
    sharedCandidates: ReadonlyArray<CheckpointIdentity & { path: string }>,
  ): Promise<LoadedCheckpoint | null> {
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
    for (const candidate of sharedCandidates) {
      try {
        consider(
          await this.readCheckpointFile(
            candidate.path,
            candidate.hash,
            candidate.lamport,
          ),
        );
        // The list is ordered by the key the winner is chosen with, so the
        // first file that reads cleanly is the shared winner.
        break;
      } catch (error) {
        // A listed shared file that vanished mid-scan was deleted by another
        // device's prune, and one that reads torn - zero bytes, truncated
        // JSON, a hash or auth check over half-transferred content - is
        // mid-propagation from the other machine: checkpoints run tens of
        // MiB, and the cloud client materializes the name before the bytes.
        // Both mean "not arrived yet", not corruption; the next candidate (or
        // the local copy of the previous winner) covers this cycle and the
        // 30-second poll retries the file. Failing hard here took every cycle
        // down for the whole hydration window - the exact shape 0.0.32
        // declared a bug when EVENT files produced it.
        if (
          isMissingPathError(error) ||
          isTolerableTornCheckpointError(error)
        ) {
          continue;
        }
        throw error;
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
    // The ceiling, not the live setting - same reasoning as readEvent: a
    // checkpoint folded under a larger limit must stay readable after the
    // setting shrinks, or the failure surfaces as a spurious "checkpoint
    // rollback detected" that tells the user to wait for nothing.
    validateCheckpointManifest(manifest, stored.header, MAX_APPLY_BATCH_BYTES);
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

  /**
   * Chooses the tip pruning republishes so old builds meet a v2 event.
   *
   * Whichever resource is chosen gets a new version that this device did not
   * write, and every device - including this one - then sees an incoming change
   * for it. For a kind the running Cursor can write itself that costs nothing.
   * For a kind only the offline helper can apply it costs a permanent
   * `pendingDatabaseChanges` entry and a "Restart to Apply" prompt, on every
   * device, for a resource whose bytes are already on disk - and the marker
   * used to pick one of those every time, because `chat-store/`,
   * `chat-transcript/` and `chat/` sort ahead of `settings/`.
   *
   * So the helper-applied kinds are considered only when nothing else is
   * available; the marker still gets published, which is what the v2 guarantee
   * needs.
   */
  private async prepareCheckpointMarker(): Promise<PreparedCheckpointMarker | null> {
    return (
      (await this.checkpointMarkerFrom((kind) => !HELPER_APPLIED_KINDS.has(kind))) ??
      (await this.checkpointMarkerFrom(() => true))
    );
  }

  private async checkpointMarkerFrom(
    accepts: (kind: ResourceKind) => boolean,
  ): Promise<PreparedCheckpointMarker | null> {
    let tombstone: { resourceId: string; tip: ResourceTip } | null = null;
    for (const resourceId of Object.keys(this.state.tips).sort()) {
      const active = chooseCheckpointTip(this.state.tips[resourceId] ?? []);
      if (active === undefined || !accepts(active.kind)) {
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
      .sort(compareCodeUnits);
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
    // Validated against the absolute ceiling, not this device's live
    // maxPayloadBytes: an event already in the log was published under
    // whatever limit its producer had, and a device whose setting is lower
    // must still be able to READ it - the same widening readObject applies.
    // Judging history by the current setting wedged every cycle on device B
    // the moment device A raised its limit and published something large,
    // and settings sync could not fix it because settings ride the same log.
    validateEventManifest(manifest, MAX_APPLY_BATCH_BYTES);
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
    this.noteSelfWrite(`${objectId}${OBJECT_EXTENSION}`);
    return reference;
  }

  private currentParents(resourceId: string): string[] {
    return (this.state.tips[resourceId] ?? [])
      .map((tip) => tip.versionId)
      .sort(compareCodeUnits);
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

/** Stable listing order: by device, then by sequence within that device. */
function compareDecryptedEvents(
  left: DecryptedEvent,
  right: DecryptedEvent,
): number {
  const deviceOrder = compareCodeUnits(
    left.stored.header.deviceId,
    right.stored.header.deviceId,
  );
  if (deviceOrder !== 0) {
    return deviceOrder;
  }
  return left.stored.header.sequence - right.stored.header.sequence;
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

/**
 * Whether a failure to read an event file is tolerable for a file the absorbed
 * checkpoint already covers. Only such files ever reach this test - the caller
 * gates on `fileSequence <= checkpointCursor.lastSequence` - so skipping loses
 * no content; the question is only which failure SHAPES a mid-prune or
 * mid-propagation file can produce. A cloud-synced folder produces more than
 * ENOENT: a zero-byte or truncated placeholder parses as a SyntaxError, a
 * partially propagated envelope fails validation ("Event ..." messages), and a
 * torn ciphertext fails authentication. All of them once threw out of
 * listEvents and killed every cycle on the reading machine until the file
 * finished hydrating - for content the checkpoint already carried.
 */
function isTolerablePrunedEventError(error: unknown): boolean {
  if (isMissingPathError(error) || error instanceof SyntaxError) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.message.startsWith("Event ") ||
      error.message.startsWith("Unsupported state authentication") ||
      error.message.includes("Unsupported state or unable to authenticate data"))
  );
}

/**
 * The checkpoint analog of {@link isTolerablePrunedEventError}: the failure
 * shapes a well-named checkpoint file shows while the cloud client is still
 * transferring its bytes. Only used where another candidate or the local copy
 * of the previous winner can cover the cycle.
 *
 * Deliberately ENUMERATED rather than prefix-matched: half-transferred bytes
 * fail the JSON parse, the file hash, the filename cross-checks, or the AEAD
 * authentication - all BEFORE the content is trusted. A checkpoint that
 * authenticates and then fails validation is complete and genuinely invalid
 * (another build wrote something this one cannot fold), which must fail
 * loudly, not be skipped forever as "still arriving".
 */
function isTolerableTornCheckpointError(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.message.startsWith("Checkpoint file hash mismatch") ||
      error.message.startsWith("Checkpoint lamport does not match") ||
      error.message.startsWith("Checkpoint envelope") ||
      error.message.startsWith("Unsupported state authentication") ||
      error.message.includes("Unsupported state or unable to authenticate data"))
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
  return compareCodeUnits(left.hash, right.hash);
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
  // Code-unit order: replicated elections must sort identically everywhere.
  const deviceOrder = compareCodeUnits(right.deviceId, left.deviceId);
  if (deviceOrder !== 0) {
    return deviceOrder;
  }
  return compareCodeUnits(right.eventHash, left.eventHash);
}

function compareVersionSummaries(
  left: ResourceVersionSummary,
  right: ResourceVersionSummary,
): number {
  if (left.lamport !== right.lamport) {
    return right.lamport - left.lamport;
  }
  const createdOrder = compareCodeUnits(right.createdAt, left.createdAt);
  if (createdOrder !== 0) {
    return createdOrder;
  }
  return compareCodeUnits(right.versionId, left.versionId);
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
    throw new Error(
      "Event belongs to a different repository. This usually means Setup ran on two computers against the same folder before the cloud sync had copied either one's repository files: each created its own repository, and the folder now holds both. Keep one computer's setup, run \"Cursor Setting Sync: Disconnect\" on the other, delete the other device's folder under devices/ (its repo.json conflict copy too, if the cloud client made one), and run Setup there again pointing at this folder.",
    );
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
  if (typeof value !== "string" || !isCanonicalBase64Text(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return expectedBytes === undefined || decoded.byteLength === expectedBytes;
}
