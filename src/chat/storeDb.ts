import { relative } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "../platform/sqlite";
import { openDatabase } from "../platform/sqlite";
import { stat } from "node:fs/promises";
import type {
  LocalProjection,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeRelativePathOnDisk,
  isMissingPathError,
  normalizeResourcePath,
  pathExists,
} from "../platform/files";
import {
  canonicalBytes,
  isCanonicalBase64Text,
  sha256,
} from "../protocol/canonical";
import {
  buffersFitJsonStructureBudget,
  PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
} from "../protocol/jsonStructure";
import { DEFAULT_MAX_PAYLOAD_MIB } from "../constants";
import type {
  OversizedSnapshotSettlement,
  ResourceAdapter,
  ResourceApplyInput,
  ResourceScanStatus,
} from "../resources/resource";
import {
  updateCanonicalJsonString,
  type CanonicalHashUpdater,
} from "./headerCanonical";
import {
  CHAT_AUXILIARY_MAX_RESOURCES_PER_SCAN,
  CHAT_AUXILIARY_MAX_RETAINED_BYTES_PER_SCAN,
  BoundedAuxiliaryOversizedSettlements,
  auxiliaryOversizedObservation,
  auxiliaryOversizedWarning,
  auxiliaryResourceLimit,
  type AuxiliaryOversizedObservation,
} from "./auxiliaryScan";
import {
  AUXILIARY_DIRECTORY_MATCHES_PER_SCAN,
  AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN,
  BoundedFileTreeWalker,
  BoundedFileTreeWalkError,
} from "./boundedFileTree";

export type PortableStoreValue =
  | { type: "null" }
  | { type: "text"; value: string }
  | { type: "blob"; value: string }
  | { type: "integer"; value: string }
  | { type: "real"; value: number };

export interface PortableStoreSnapshot {
  schemaVersion: 1;
  relativePath: string;
  meta: Array<{ key: string; value: PortableStoreValue }>;
  blobs: Array<{ id: string; data: PortableStoreValue }>;
}

export interface StoreDbChatAdapterOptions {
  maxResourcesPerScan?: number;
  maxRetainedBytesPerScan?: number;
  maxEnumerationRootsPerScan?: number;
  maxEnumerationWorkItemsPerScan?: number;
  enumerationIntervalMs?: number;
  maxMetadataChecksPerScan?: number;
  maxOversizedSettlements?: number;
  maxInspectionsPerScan?: number;
  maxInspectedPhysicalBytesPerScan?: number;
  metadataIntervalMs?: number;
  now?: () => number;
  onValueMaterialize?: (path: string) => void;
  onInspect?: (path: string) => void;
  onMetadataCheck?: (path: string) => void;
  onRootEnumerate?: (path: string) => void;
  onEnumerationWork?: (path: string) => void;
  forceVerificationResourceIds?: ReadonlySet<string>;
}

export interface StoreSnapshotReadOptions {
  maxRawBytes?: number;
  maxCanonicalBytes?: number;
  onValueMaterialize?: () => void;
}

export interface StoreSnapshotInspection {
  metaCount: number;
  blobCount: number;
  skippedRows: number;
  rawBytes: number;
  minimumCanonicalBytes: number;
}

interface StoreCandidate {
  path: string;
  relativePath: string;
  resourceId: string;
  lastUpdatedAt: number;
  identity: string;
  physicalBytes: number;
}

interface StoreDescriptor {
  path: string;
  relativePath: string;
  resourceId: string;
}

export const STORE_DB_MAX_MATERIALIZED_RAW_BYTES = 24 * 1024 * 1024;
export const STORE_DB_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const STORE_DB_MAX_INSPECTIONS_PER_SCAN = 4;
export const STORE_DB_MAX_INSPECTED_PHYSICAL_BYTES_PER_SCAN =
  STORE_DB_MAX_FILE_BYTES;
export const STORE_DB_MAX_TOTAL_ROWS = 20_000;

export class StoreDbChatAdapter implements ResourceAdapter {
  readonly id = "chat-store-db";
  readonly kinds = ["chat-store"] as const;
  readonly appliesWhileRunning = false;

  private maxPayloadBytes = DEFAULT_MAX_PAYLOAD_MIB * 1024 * 1024;
  private lastScanStatus: ResourceScanStatus = {
    complete: true,
    deferredResourceIds: [],
  };
  private readonly oversized: BoundedAuxiliaryOversizedSettlements;
  private readonly pendingDescriptors = new Map<string, StoreDescriptor>();
  private readonly failedDescriptors = new Map<string, StoreDescriptor>();
  private failedDescriptorOverflow = false;
  private readonly storeWalker = new BoundedFileTreeWalker();
  private enumerationRemaining: Set<string> | null = null;
  private nextEnumerationAt = 0;
  private progressRevision = 0;

  constructor(
    private readonly paths: CursorPaths,
    private readonly options: StoreDbChatAdapterOptions = {},
  ) {
    this.oversized = new BoundedAuxiliaryOversizedSettlements(
      options.maxOversizedSettlements,
    );
  }

  setMaxPayloadBytes(maxPayloadBytes: number): void {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
      throw new Error("Chat store payload limit must be a positive integer.");
    }
    if (this.maxPayloadBytes !== maxPayloadBytes) {
      this.maxPayloadBytes = maxPayloadBytes;
      this.oversized.clear();
    }
  }

  scanStatus(): ResourceScanStatus {
    return this.lastScanStatus;
  }

  oversizedSnapshotSettlements(
    _maxPayloadBytes: number,
  ): readonly OversizedSnapshotSettlement[] {
    return [...this.oversized.values()];
  }

  /** Closes any native store-directory cursor retained between pages. */
  async dispose(): Promise<void> {
    await this.storeWalker.clear();
  }

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const candidates: StoreCandidate[] = [];
    const maxPending = Math.min(
      this.options.maxMetadataChecksPerScan ?? 64,
      AUXILIARY_DIRECTORY_MATCHES_PER_SCAN,
    );
    this.promoteFailedDescriptor(maxPending);
    const discovered = await this.discoverStoreFiles(
      warnings,
      Math.max(0, maxPending - this.pendingDescriptors.size),
    );
    for (const path of discovered.files) {
      try {
        const relativePath = normalizeResourcePath(
          relative(this.paths.cursorHome, path),
        );
        const resourceId = `chat-store/${encodeURIComponent(relativePath)}`;
        this.pendingDescriptors.set(resourceId, {
          path,
          relativePath,
          resourceId,
        });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    const metadataIds = [...this.pendingDescriptors.keys()]
      .slice(0, this.options.maxMetadataChecksPerScan ?? 64);
    for (const resourceId of metadataIds) {
      const descriptor = this.pendingDescriptors.get(resourceId);
      if (descriptor === undefined) {
        continue;
      }
      try {
        this.options.onMetadataCheck?.(descriptor.path);
        await assertSafeRelativePathOnDisk(
          this.paths.cursorHome,
          descriptor.relativePath,
          { finalType: "file" },
        );
        const observed = await storeFileObservation(descriptor.path);
        const lastUpdatedAt = observed.lastUpdatedAt;
        if (
          !this.options.forceVerificationResourceIds?.has(resourceId) &&
          known[resourceId]?.sourceTimestamp === lastUpdatedAt
        ) {
          this.oversized.delete(resourceId);
          this.pendingDescriptors.delete(resourceId);
          this.failedDescriptors.delete(resourceId);
          this.progressRevision += 1;
          continue;
        }
        const settlement = this.oversized.get(resourceId);
        if (settlement?.identity === observed.identity) {
          this.pendingDescriptors.delete(resourceId);
          this.failedDescriptors.delete(resourceId);
          this.progressRevision += 1;
          continue;
        }
        this.oversized.delete(resourceId);
        candidates.push({
          path: descriptor.path,
          relativePath: descriptor.relativePath,
          resourceId,
          lastUpdatedAt,
          identity: observed.identity,
          physicalBytes: observed.physicalBytes,
        });
      } catch (error) {
        if (isMissingPathError(error)) {
          this.pendingDescriptors.delete(resourceId);
          this.failedDescriptors.delete(resourceId);
          this.progressRevision += 1;
        } else {
          warnings.push(error instanceof Error ? error.message : String(error));
          // A permanently busy/corrupt first database must not consume the
          // physical-work budget ahead of every healthy sibling forever.
          // Keep it deferred, but rotate its descriptor to the retry tail;
          // only a later successful ACK/settlement counts as scan progress.
          this.pendingDescriptors.delete(resourceId);
          this.rememberFailedDescriptor(resourceId, descriptor, maxPending);
        }
      }
    }
    const oversizedWarnings: AuxiliaryOversizedObservation[] = [];
    const resourceLimit = auxiliaryResourceLimit(this.maxPayloadBytes);
    const rawLimit = Math.min(
      STORE_DB_MAX_MATERIALIZED_RAW_BYTES,
      resourceLimit,
    );
    const maxResources =
      this.options.maxResourcesPerScan ??
      CHAT_AUXILIARY_MAX_RESOURCES_PER_SCAN;
    const retainedLimit =
      this.options.maxRetainedBytesPerScan ??
      CHAT_AUXILIARY_MAX_RETAINED_BYTES_PER_SCAN;
    let retainedBytes = 0;
    let materialized = 0;
    let inspections = 0;
    let inspectedPhysicalBytes = 0;
    const maxInspections = Math.max(
      1,
      this.options.maxInspectionsPerScan ??
        STORE_DB_MAX_INSPECTIONS_PER_SCAN,
    );
    const maxInspectedPhysicalBytes = Math.max(
      1,
      this.options.maxInspectedPhysicalBytesPerScan ??
        STORE_DB_MAX_INSPECTED_PHYSICAL_BYTES_PER_SCAN,
    );

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate === undefined) {
        continue;
      }
      if (materialized >= maxResources) {
        break;
      }
      try {
        if (candidate.physicalBytes > STORE_DB_MAX_FILE_BYTES) {
          const observation = auxiliaryOversizedObservation(
            candidate.resourceId,
            candidate.identity,
            candidate.physicalBytes,
            this.maxPayloadBytes,
          );
          this.oversized.set(
            candidate.resourceId,
            observation,
          );
          oversizedWarnings.push(observation);
          this.pendingDescriptors.delete(candidate.resourceId);
          this.failedDescriptors.delete(candidate.resourceId);
          this.progressRevision += 1;
          continue;
        }
        if (
          inspections >= maxInspections ||
          (inspections > 0 &&
            inspectedPhysicalBytes + candidate.physicalBytes >
              maxInspectedPhysicalBytes)
        ) {
          break;
        }
        inspections += 1;
        inspectedPhysicalBytes = checkedAdd(
          inspectedPhysicalBytes,
          candidate.physicalBytes,
        );
        this.options.onInspect?.(candidate.path);
        const inspection = inspectStoreSnapshot(
          candidate.path,
          candidate.relativePath,
        );
        if (
          inspection.rawBytes > rawLimit ||
          inspection.minimumCanonicalBytes > resourceLimit
        ) {
          const observation = auxiliaryOversizedObservation(
            candidate.resourceId,
            candidate.identity,
            Math.max(
              inspection.minimumCanonicalBytes,
              inspection.rawBytes,
              resourceLimit + 1,
            ),
            this.maxPayloadBytes,
          );
          this.oversized.set(
            candidate.resourceId,
            observation,
          );
          oversizedWarnings.push(observation);
          this.pendingDescriptors.delete(candidate.resourceId);
          this.failedDescriptors.delete(candidate.resourceId);
          this.progressRevision += 1;
          continue;
        }
        if (
          snapshots.length > 0 &&
          retainedBytes + inspection.minimumCanonicalBytes > retainedLimit
        ) {
          break;
        }
        materialized += 1;
        const snapshot = readStoreSnapshot(
          candidate.path,
          candidate.relativePath,
          warnings,
          {
            maxRawBytes: rawLimit,
            maxCanonicalBytes: resourceLimit,
            onValueMaterialize: () =>
              this.options.onValueMaterialize?.(candidate.path),
          },
        );
        const byteLength = portableStoreSnapshotCanonicalByteLength(snapshot);
        if (snapshots.length > 0 && retainedBytes + byteLength > retainedLimit) {
          break;
        }
        const content = serializePortableStoreSnapshot(snapshot);
        snapshots.push({
          resourceId: candidate.resourceId,
          kind: "chat-store",
          content,
          semanticHash: sha256(content),
          metadata: {
            relativePath: candidate.relativePath,
            metaCount: snapshot.meta.length,
            blobCount: snapshot.blobs.length,
            lastUpdatedAt: candidate.lastUpdatedAt,
          },
        });
        retainedBytes += content.byteLength;
        this.pendingDescriptors.delete(candidate.resourceId);
        this.failedDescriptors.delete(candidate.resourceId);
        this.progressRevision += 1;
      } catch (error) {
        if (error instanceof StoreSnapshotLimitError) {
          const observation = auxiliaryOversizedObservation(
            candidate.resourceId,
            candidate.identity,
            Math.max(error.observedBytes, resourceLimit + 1),
            this.maxPayloadBytes,
          );
          this.oversized.set(
            candidate.resourceId,
            observation,
          );
          oversizedWarnings.push(observation);
          this.pendingDescriptors.delete(candidate.resourceId);
          this.failedDescriptors.delete(candidate.resourceId);
          this.progressRevision += 1;
        } else {
          warnings.push(error instanceof Error ? error.message : String(error));
          // Consume this attempt's aggregate work, but retry it after healthy
          // siblings on the next scan instead of pinning the Map head.
          this.pendingDescriptors.delete(candidate.resourceId);
          this.rememberFailedDescriptor(
            candidate.resourceId,
            {
              path: candidate.path,
              relativePath: candidate.relativePath,
              resourceId: candidate.resourceId,
            },
            maxPending,
          );
        }
      }
    }

    if (discovered.completedGeneration) {
      this.oversized.completeGeneration();
    }

    const enumerationDeferred = discovered.deferredRoots.map(
      (path) => `chat-store-root/${encodeURIComponent(path)}`,
    );
    const metadataDeferred = new Set([
      ...this.pendingDescriptors.keys(),
      ...this.failedDescriptors.keys(),
    ]);
    this.lastScanStatus = {
      complete:
        metadataDeferred.size === 0 &&
        !this.failedDescriptorOverflow &&
        !this.oversized.overflowed &&
        enumerationDeferred.length === 0,
      deferredResourceIds: [
        ...metadataDeferred,
        ...(this.failedDescriptorOverflow
          ? ["chat-store-scope/untracked-read-failures"]
          : []),
        ...(this.oversized.overflowed
          ? ["chat-store-scope/untracked-oversized-resources"]
          : []),
        ...enumerationDeferred,
      ],
      progressToken:
        this.progressRevision + this.storeWalker.progressToken(),
    };
    for (const observation of oversizedWarnings) {
      if (observation.fixedWorkLimit) {
        warnings.push(auxiliaryOversizedWarning("Chat store", observation));
      }
    }
    if (this.oversized.overflowed) {
      warnings.push(
        `Chat store oversized settlement tracking exceeded its fixed limit; ${this.oversized.overflowCount} additional resource(s) remain local and incoming store changes stay deferred until a later complete sweep.`,
      );
    }

    return {
      snapshots,
      // Cursor prunes auxiliary store directories as local housekeeping and
      // the offline helper deliberately retains store tombstones. Publishing
      // a deletion from an incomplete/bounded directory sweep can therefore
      // only discard recovery material; store resources are additive.
      deletions: [],
      warnings,
    };
  }

  private promoteFailedDescriptor(maxPending: number): void {
    if (this.pendingDescriptors.size >= maxPending) {
      return;
    }
    const next = this.failedDescriptors.entries().next().value;
    if (next === undefined) {
      return;
    }
    const [resourceId, descriptor] = next;
    this.failedDescriptors.delete(resourceId);
    this.pendingDescriptors.set(resourceId, descriptor);
  }

  private rememberFailedDescriptor(
    resourceId: string,
    descriptor: StoreDescriptor,
    maxPending: number,
  ): void {
    this.failedDescriptors.delete(resourceId);
    while (this.failedDescriptors.size >= maxPending) {
      const oldest = this.failedDescriptors.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.failedDescriptors.delete(oldest);
      this.failedDescriptorOverflow = true;
    }
    this.failedDescriptors.set(resourceId, descriptor);
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Chat store databases must be applied by the offline helper.");
  }

  private async discoverStoreFiles(
    warnings: string[],
    maxMatches: number,
  ): Promise<{
    files: string[];
    deferredRoots: string[];
    completedGeneration: boolean;
  }> {
    const files: string[] = [];
    const roots = [this.paths.cursorChats, this.paths.cursorAcpSessions];
    const now = (this.options.now ?? Date.now)();
    let completedGeneration = false;
    if (
      this.enumerationRemaining === null &&
      now >= this.nextEnumerationAt
    ) {
      this.enumerationRemaining = new Set(roots);
      this.failedDescriptorOverflow = false;
      this.oversized.beginGeneration();
    }
    const selected = [...(this.enumerationRemaining ?? [])].slice(
      0,
      this.options.maxEnumerationRootsPerScan ?? 16,
    );
    let remainingWork =
      this.options.maxEnumerationWorkItemsPerScan ??
      AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN;
    for (const root of selected) {
      if (remainingWork <= 0 || files.length >= maxMatches || maxMatches <= 0) {
        break;
      }
      try {
        this.options.onRootEnumerate?.(root);
        const page = await this.storeWalker.advance(root, {
          maxWorkItems: remainingWork,
          maxMatches: maxMatches - files.length,
          includeFile: (path) => /[\\/]store\.db$/i.test(path),
          onWorkItem: this.options.onEnumerationWork,
        });
        remainingWork -= page.workItems;
        files.push(...page.files);
        if (page.complete) {
          this.enumerationRemaining?.delete(root);
        }
      } catch (error) {
        if (error instanceof BoundedFileTreeWalkError) {
          remainingWork -= error.workItems;
        }
        warnings.push(
          `Unable to enumerate chat store databases below ${root}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const deferredRoots = [...(this.enumerationRemaining ?? [])];
    if (deferredRoots.length === 0 && this.enumerationRemaining !== null) {
      this.enumerationRemaining = null;
      completedGeneration = true;
      this.nextEnumerationAt =
        now + (this.options.enumerationIntervalMs ?? 5 * 60 * 1000);
    }
    return {
      files,
      deferredRoots,
      completedGeneration,
    };
  }
}

export function parsePortableStoreSnapshot(content: Buffer): PortableStoreSnapshot {
  if (
    !buffersFitJsonStructureBudget([content], {
      maxStructuralTokens: PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
    })
  ) {
    throw new Error("Chat store snapshot exceeds the structural JSON limit.");
  }
  const snapshot = JSON.parse(content.toString("utf8")) as PortableStoreSnapshot;
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.relativePath !== "string" ||
    !Array.isArray(snapshot.meta) ||
    !Array.isArray(snapshot.blobs)
  ) {
    throw new Error("Unsupported or invalid chat store snapshot.");
  }
  if (snapshot.meta.length > 250_000 || snapshot.blobs.length > 250_000) {
    throw new Error("Chat store snapshot contains too many rows.");
  }
  if (
    snapshot.meta.some(
      (row) =>
        row === null ||
        typeof row !== "object" ||
        typeof row.key !== "string" ||
        !isPortableStoreValue(row.value),
    ) ||
    snapshot.blobs.some(
      (row) =>
        row === null ||
        typeof row !== "object" ||
        typeof row.id !== "string" ||
        !isPortableStoreValue(row.data),
    )
  ) {
    throw new Error("Chat store snapshot contains invalid rows.");
  }
  if (
    new Set(snapshot.meta.map((row) => row.key)).size !== snapshot.meta.length ||
    new Set(snapshot.blobs.map((row) => row.id)).size !== snapshot.blobs.length
  ) {
    throw new Error("Chat store snapshot contains duplicate row identifiers.");
  }
  return snapshot;
}

/**
 * Serializes an adapter-produced store snapshot with the same fixed
 * structural ceiling enforced by the reader. The row-count proof runs before
 * canonical materialization; the exact scan is retained as a fail-safe if the
 * portable shape evolves without updating that proof.
 */
export function serializePortableStoreSnapshot(
  snapshot: PortableStoreSnapshot,
): Buffer {
  const rows = checkedAdd(snapshot.meta.length, snapshot.blobs.length);
  if (rows > STORE_DB_MAX_TOTAL_ROWS) {
    throw new StoreSnapshotLimitError(
      rows,
      STORE_DB_MAX_TOTAL_ROWS,
      "aggregate row count",
      "rows",
    );
  }
  // Root/object/array punctuation needs at most 14 tokens. Each row and its
  // nested portable value need at most 10, plus one array separator.
  const structuralUpperBound = checkedAdd(14, rows * 11);
  if (structuralUpperBound > PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS) {
    throw new StoreSnapshotLimitError(
      structuralUpperBound,
      PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
      "canonical structural work",
      "tokens",
    );
  }
  const content = canonicalBytes(snapshot);
  if (
    !buffersFitJsonStructureBudget([content], {
      maxStructuralTokens: PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
    })
  ) {
    throw new StoreSnapshotLimitError(
      PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS + 1,
      PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
      "canonical structural work",
      "tokens",
    );
  }
  return content;
}

function isPortableStoreValue(value: unknown): value is PortableStoreValue {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as { type?: unknown; value?: unknown };
  if (candidate.type === "null") {
    return candidate.value === undefined;
  }
  if (candidate.type === "text") {
    return typeof candidate.value === "string";
  }
  if (candidate.type === "integer") {
    return (
      typeof candidate.value === "string" &&
      /^-?(?:0|[1-9][0-9]*)$/.test(candidate.value) &&
      BigInt(candidate.value) >= -(2n ** 63n) &&
      BigInt(candidate.value) <= 2n ** 63n - 1n
    );
  }
  if (candidate.type === "real") {
    return typeof candidate.value === "number" && Number.isFinite(candidate.value);
  }
  return (
    candidate.type === "blob" &&
    typeof candidate.value === "string" &&
    isCanonicalBase64Text(candidate.value) &&
    Buffer.from(candidate.value, "base64").toString("base64") === candidate.value
  );
}

export function readStoreSnapshot(
  path: string,
  relativePath: string,
  warnings?: string[],
  options: StoreSnapshotReadOptions = {},
): PortableStoreSnapshot {
  const database = openDatabase(path, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=2000");
    database.exec("PRAGMA query_only=ON");
    assertStoreSchema(database);
    database.exec("BEGIN");
    try {
      const snapshot = readStoreSnapshotFromDatabase(
        database,
        relativePath,
        warnings,
        options,
      );
      database.exec("COMMIT");
      return snapshot;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function readStoreSnapshotFromDatabase(
  database: DatabaseSync,
  relativePath: string,
  warnings?: string[],
  options: StoreSnapshotReadOptions = {},
): PortableStoreSnapshot {
  assertStoreSchema(database);
  const inspection = inspectStoreDatabase(database, relativePath);
  if (
    options.maxRawBytes !== undefined &&
    inspection.rawBytes > options.maxRawBytes
  ) {
    throw new StoreSnapshotLimitError(
      inspection.rawBytes,
      options.maxRawBytes,
      "raw SQLite value",
    );
  }
  if (
    options.maxCanonicalBytes !== undefined &&
    inspection.minimumCanonicalBytes > options.maxCanonicalBytes
  ) {
    throw new StoreSnapshotLimitError(
      inspection.minimumCanonicalBytes,
      options.maxCanonicalBytes,
      "canonical snapshot",
    );
  }
  options.onValueMaterialize?.();
  const meta: PortableStoreSnapshot["meta"] = [];
  const blobs: PortableStoreSnapshot["blobs"] = [];
  for (const raw of database
    .prepare(
      "SELECT key, value, typeof(value) AS valueType FROM meta ORDER BY key",
    )
    .iterate()) {
    const row = raw as {
      key: Uint8Array | string | number | bigint | null;
      value: Uint8Array | string | number | bigint | null;
      valueType: string;
    };
    if (typeof row.key === "string") {
      meta.push({
        key: row.key,
        value: portableValue(row.value, row.valueType),
      });
    }
  }
  for (const raw of database
    .prepare(
      "SELECT id, data, typeof(data) AS dataType FROM blobs ORDER BY id",
    )
    .iterate()) {
    const row = raw as {
      id: Uint8Array | string | number | bigint | null;
      data: Uint8Array | string | number | bigint | null;
      dataType: string;
    };
    if (typeof row.id === "string") {
      blobs.push({
        id: row.id,
        data: portableValue(row.data, row.dataType),
      });
    }
  }
  const snapshot: PortableStoreSnapshot = {
    schemaVersion: 1,
    relativePath,
    meta,
    blobs,
  };
  const canonicalByteLength = portableStoreSnapshotCanonicalByteLength(snapshot);
  if (
    options.maxCanonicalBytes !== undefined &&
    canonicalByteLength > options.maxCanonicalBytes
  ) {
    throw new StoreSnapshotLimitError(
      canonicalByteLength,
      options.maxCanonicalBytes,
      "canonical snapshot",
    );
  }
  // SQLite permits NULL in a non-INTEGER PRIMARY KEY column. Such a row has no
  // usable identity, so it is dropped instead of becoming a literal "null" key
  // on every peer.
  if (inspection.skippedRows > 0) {
    warnings?.push(
      `Skipped ${inspection.skippedRows} store.db row(s) without a text key in ${relativePath}.`,
    );
  }
  return snapshot;
}

export function inspectStoreSnapshot(
  path: string,
  relativePath: string,
): StoreSnapshotInspection {
  const database = openDatabase(path, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=2000");
    database.exec("PRAGMA query_only=ON");
    assertStoreSchema(database);
    database.exec("BEGIN");
    try {
      const result = inspectStoreDatabase(database, relativePath);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function inspectStoreDatabase(
  database: DatabaseSync,
  relativePath: string,
): StoreSnapshotInspection {
  const meta = inspectStoreTable(
    database,
    "meta",
    "key",
    "value",
    STORE_DB_MAX_TOTAL_ROWS,
  );
  const blobs = inspectStoreTable(
    database,
    "blobs",
    "id",
    "data",
    STORE_DB_MAX_TOTAL_ROWS - meta.total,
  );
  if (meta.invalidValues + blobs.invalidValues > 0) {
    throw new Error(
      `Unsupported SQLite value storage class in ${relativePath}.`,
    );
  }
  const totalRows = checkedAdd(meta.total, blobs.total);
  if (totalRows > STORE_DB_MAX_TOTAL_ROWS) {
    throw new StoreSnapshotLimitError(
      totalRows,
      STORE_DB_MAX_TOTAL_ROWS,
      "aggregate row count",
      "rows",
    );
  }
  const rawBytes = checkedAdd(
    meta.identityBytes,
    meta.valueBytes,
    blobs.identityBytes,
    blobs.valueBytes,
  );
  // All JSON punctuation and escaping only increase this lower bound.  BLOB
  // values use their exact Base64 expansion so a zeroblob is rejected before
  // the SELECT that would materialize it.
  const minimumCanonicalBytes = checkedAdd(
    Buffer.byteLength(
      '{"blobs":[],"meta":[],"relativePath":,"schemaVersion":1}',
    ),
    Buffer.byteLength(relativePath),
    meta.minimumEncodedBytes,
    blobs.minimumEncodedBytes,
    (meta.valid + blobs.valid) * 20,
  );
  return {
    metaCount: meta.valid,
    blobCount: blobs.valid,
    skippedRows: meta.skipped + blobs.skipped,
    rawBytes,
    minimumCanonicalBytes,
  };
}

interface StoreTableInspection {
  total: number;
  valid: number;
  skipped: number;
  invalidValues: number;
  identityBytes: number;
  valueBytes: number;
  minimumEncodedBytes: number;
}

function inspectStoreTable(
  database: DatabaseSync,
  table: "meta" | "blobs",
  identityColumn: "key" | "id",
  valueColumn: "value" | "data",
  maxRows: number,
): StoreTableInspection {
  const boundedTotal = safeAggregateNumber(
    (
      database
        .prepare(
          `SELECT COUNT(*) AS total FROM (` +
            `SELECT 1 FROM ${table} LIMIT ?` +
            `)`,
        )
        .get(maxRows + 1) as
        | { total?: unknown }
        | undefined
    )?.total,
  );
  if (boundedTotal > maxRows) {
    throw new StoreSnapshotLimitError(
      boundedTotal,
      maxRows,
      `${table} row count`,
      "rows",
    );
  }
  const row = database
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN typeof(${identityColumn}) = 'text' THEN 1 ELSE 0 END), 0) AS valid,
         COALESCE(SUM(CASE WHEN typeof(${identityColumn}) = 'text' THEN 0 ELSE 1 END), 0) AS skipped,
         COALESCE(SUM(CASE
           WHEN typeof(${identityColumn}) = 'text'
            AND typeof(${valueColumn}) NOT IN ('null','text','blob','integer','real')
           THEN 1 ELSE 0 END), 0) AS invalidValues,
         COALESCE(SUM(CASE WHEN typeof(${identityColumn}) = 'text'
           THEN length(CAST(${identityColumn} AS BLOB)) ELSE 0 END), 0) AS identityBytes,
         COALESCE(SUM(CASE WHEN typeof(${identityColumn}) = 'text' THEN
           CASE typeof(${valueColumn})
             WHEN 'null' THEN 0
             ELSE length(CAST(${valueColumn} AS BLOB))
           END ELSE 0 END), 0) AS valueBytes,
         COALESCE(SUM(CASE WHEN typeof(${identityColumn}) = 'text' THEN
           length(CAST(${identityColumn} AS BLOB)) +
           CASE typeof(${valueColumn})
             WHEN 'null' THEN 4
             WHEN 'blob' THEN 4 * ((length(${valueColumn}) + 2) / 3)
             ELSE length(CAST(${valueColumn} AS BLOB))
           END ELSE 0 END), 0) AS minimumEncodedBytes
       FROM ${table}`,
    )
    .get() as Record<string, unknown> | undefined;
  return {
    total: safeAggregateNumber(row?.total),
    valid: safeAggregateNumber(row?.valid),
    skipped: safeAggregateNumber(row?.skipped),
    invalidValues: safeAggregateNumber(row?.invalidValues),
    identityBytes: safeAggregateNumber(row?.identityBytes),
    valueBytes: safeAggregateNumber(row?.valueBytes),
    minimumEncodedBytes: safeAggregateNumber(row?.minimumEncodedBytes),
  };
}

function safeAggregateNumber(value: unknown): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof numeric !== "number" ||
    !Number.isSafeInteger(numeric) ||
    numeric < 0
  ) {
    throw new Error("Chat store size metadata exceeds the safe integer range.");
  }
  return numeric;
}

function checkedAdd(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new Error("Chat store size metadata exceeds the safe integer range.");
    }
  }
  return total;
}

class StoreSnapshotLimitError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly limitBytes: number,
    description: string,
    unit = "bytes",
  ) {
    super(
      `Chat store ${description} requires at least ${observedBytes} ${unit}, above the ${limitBytes} ${unit} bounded capture limit.`,
    );
  }
}

function assertStoreSchema(database: DatabaseSync): void {
  for (const [table, columns] of [
    ["meta", ["key", "value"]],
    ["blobs", ["id", "data"]],
  ] as const) {
    const actual = database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => String(row.name));
    if (!columns.every((column) => actual.includes(column))) {
      throw new Error(`Unsupported store.db schema for ${table}.`);
    }
  }
}

function portableValue(
  value: Uint8Array | string | number | bigint | null,
  sqliteType: string,
): PortableStoreValue {
  if (sqliteType === "null" && value === null) {
    return { type: "null" };
  }
  if (sqliteType === "text" && typeof value === "string") {
    return { type: "text", value };
  }
  if (sqliteType === "blob" && value instanceof Uint8Array) {
    return { type: "blob", value: Buffer.from(value).toString("base64") };
  }
  if (
    sqliteType === "integer" &&
    ((typeof value === "number" && Number.isSafeInteger(value)) ||
      typeof value === "bigint")
  ) {
    return { type: "integer", value: String(value) };
  }
  if (sqliteType === "real" && typeof value === "number" && Number.isFinite(value)) {
    return { type: "real", value: Object.is(value, -0) ? 0 : value };
  }
  throw new Error(`Unsupported SQLite value in store.db: ${sqliteType}.`);
}

export function portableStoreSnapshotCanonicalByteLength(
  snapshot: PortableStoreSnapshot,
): number {
  const counter = new CanonicalByteCounter();
  updatePortableStoreSnapshotCanonical(counter, snapshot);
  return counter.byteLength;
}

export function portableStoreSnapshotSemanticHash(
  snapshot: PortableStoreSnapshot,
): string {
  const hash = createHash("sha256");
  updatePortableStoreSnapshotCanonical(hash, snapshot);
  return hash.digest("hex");
}

function updatePortableStoreSnapshotCanonical(
  hash: CanonicalHashUpdater,
  snapshot: PortableStoreSnapshot,
): void {
  hash.update('{"blobs":[');
  for (let index = 0; index < snapshot.blobs.length; index += 1) {
    if (index > 0) {
      hash.update(",");
    }
    const row = snapshot.blobs[index];
    if (row === undefined) {
      throw new Error("Chat store blob row is missing.");
    }
    hash.update('{"data":');
    updatePortableStoreValueCanonical(hash, row.data);
    hash.update(',"id":');
    updateCanonicalJsonString(hash, row.id);
    hash.update("}");
  }
  hash.update('],"meta":[');
  for (let index = 0; index < snapshot.meta.length; index += 1) {
    if (index > 0) {
      hash.update(",");
    }
    const row = snapshot.meta[index];
    if (row === undefined) {
      throw new Error("Chat store metadata row is missing.");
    }
    hash.update('{"key":');
    updateCanonicalJsonString(hash, row.key);
    hash.update(',"value":');
    updatePortableStoreValueCanonical(hash, row.value);
    hash.update("}");
  }
  hash.update('],"relativePath":');
  updateCanonicalJsonString(hash, snapshot.relativePath);
  hash.update(',"schemaVersion":1}');
}

function updatePortableStoreValueCanonical(
  hash: CanonicalHashUpdater,
  value: PortableStoreValue,
): void {
  hash.update('{"type":');
  updateCanonicalJsonString(hash, value.type);
  if (value.type !== "null") {
    hash.update(',"value":');
    if (value.type === "real") {
      if (!Number.isFinite(value.value)) {
        throw new Error("Chat store real value must be finite.");
      }
      hash.update(JSON.stringify(Object.is(value.value, -0) ? 0 : value.value));
    } else {
      updateCanonicalJsonString(hash, value.value);
    }
  }
  hash.update("}");
}

class CanonicalByteCounter implements CanonicalHashUpdater {
  byteLength = 0;

  update(data: string | Uint8Array): this {
    this.byteLength +=
      typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (!Number.isSafeInteger(this.byteLength)) {
      throw new Error("Chat store canonical size exceeds the safe integer range.");
    }
    return this;
  }
}

async function storeFileObservation(
  path: string,
): Promise<{ lastUpdatedAt: number; identity: string; physicalBytes: number }> {
  const main = await stat(path);
  const walPath = `${path}-wal`;
  if (!(await pathExists(walPath))) {
    return {
      lastUpdatedAt: main.mtimeMs,
      identity: `${main.size}:${main.mtimeMs}:0:0`,
      physicalBytes: main.size,
    };
  }
  const wal = await stat(walPath);
  return {
    lastUpdatedAt: Math.max(main.mtimeMs, wal.mtimeMs),
    identity: `${main.size}:${main.mtimeMs}:${wal.size}:${wal.mtimeMs}`,
    physicalBytes: checkedAdd(main.size, wal.size),
  };
}
