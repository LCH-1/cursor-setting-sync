import { openDatabase } from "../platform/sqlite";
import {
  CURSOR_USER_RULES_KEY,
  TARGET_STORAGE_MARKER,
  USER_STORAGE_TARGET,
} from "../constants";
import type {
  LocalProjection,
  ResourceKind,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import { sha256 } from "../protocol/canonical";
import type {
  OversizedSnapshotSettlement,
  ResourceAdapter,
  ResourceApplyInput,
  ResourceScanStatus,
} from "./resource";
import {
  isDeniedUiStateKey,
  isIgnoredUiStateKey,
  MAX_TARGET_STORAGE_MARKER_BYTES,
  parseTargetStorageMarker,
} from "./uiStatePolicy";
import type { IgnoreMatcher } from "./ignorePatterns";
import { createIgnoreMatcher } from "./ignorePatterns";
import { isRemoteTargetsKey, remoteTargetsKeys } from "./remoteTargets";
import { DEFAULT_MAX_PAYLOAD_MIB } from "../constants";
import {
  GENERAL_MAX_RESOURCES_PER_SCAN,
  GENERAL_MAX_RETAINED_BYTES_PER_SCAN,
  generalOversizedObservation,
  generalOversizedWarning,
  generalResourceLimit,
  inspectSqliteValue,
  readSqliteValue,
  rememberGeneralOversizedObservation,
  sqliteDatabaseTimestamp,
  type GeneralOversizedObservation,
} from "./boundedScan";

export interface UiStateAdapterOptions {
  maxResourcesPerScan?: number;
  maxRetainedBytesPerScan?: number;
  onValueRead?: (key: string) => void;
  onMetadataRead?: (key: string) => void;
  maxMetadataChecksPerScan?: number;
  forceVerificationResourceIds?: ReadonlySet<string>;
}

export class UiStateAdapter implements ResourceAdapter {
  readonly id = "ui-state";
  readonly kinds = ["ui-state", "cursor-user-rules", "remote-targets"] as const;
  readonly appliesWhileRunning = false;

  private maxPayloadBytes = DEFAULT_MAX_PAYLOAD_MIB * 1024 * 1024;
  private lastScanStatus: ResourceScanStatus = {
    complete: true,
    deferredResourceIds: [],
  };
  private readonly oversized = new Map<string, GeneralOversizedObservation>();
  private oversizedOverflow = false;
  private pendingKeys: Set<string> | null = null;
  private readonly failedKeys = new Map<string, string>();
  private failedKeyOverflow = false;
  private readonly cycleCurrent = new Set<string>();
  private readonly cycleProcessed = new Set<string>();
  private lastCompleteDatabaseTimestamp: number | null = null;
  private progressRevision = 0;
  private lastEmittedPageFingerprint: string | null = null;

  constructor(
    private readonly paths: CursorPaths,
    private readonly ignoredKeys: IgnoreMatcher = createIgnoreMatcher([]),
    private readonly options: UiStateAdapterOptions = {},
  ) {}

  setMaxPayloadBytes(maxPayloadBytes: number): void {
    generalResourceLimit(maxPayloadBytes);
    if (this.maxPayloadBytes !== maxPayloadBytes) {
      this.maxPayloadBytes = maxPayloadBytes;
      this.oversized.clear();
      this.oversizedOverflow = false;
      this.pendingKeys = null;
      this.cycleCurrent.clear();
      this.cycleProcessed.clear();
      this.failedKeys.clear();
      this.failedKeyOverflow = false;
      this.lastCompleteDatabaseTimestamp = null;
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

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const databaseTimestamp = await sqliteDatabaseTimestamp(
      this.paths.globalDatabase,
    );
    if (
      this.pendingKeys === null &&
      (this.options.forceVerificationResourceIds?.size ?? 0) === 0 &&
      databaseTimestamp !== null &&
      databaseTimestamp === this.lastCompleteDatabaseTimestamp
    ) {
      this.lastScanStatus = {
        complete: true,
        deferredResourceIds: [],
        progressToken: this.progressRevision,
      };
      return { snapshots: [], deletions: [], warnings: [] };
    }
    const database = openDatabase(this.paths.globalDatabase, { readOnly: true });
    try {
      // Cursor writes to this database while it runs; wait out short lock
      // bursts instead of failing the whole sync cycle with SQLITE_BUSY.
      database.exec("PRAGMA busy_timeout=2000");
      database.exec("PRAGMA query_only=ON");
      const scanWarnings: string[] = [];
      const resourceLimit = generalResourceLimit(this.maxPayloadBytes);
      this.options.onMetadataRead?.(TARGET_STORAGE_MARKER);
      const markerMetadata = inspectSqliteValue(
        database,
        TARGET_STORAGE_MARKER,
      );
      // An unreadable marker must not take down the whole adapter: without it
      // no key is known to be USER-target, but cursor-user-rules still syncs.
      //
      // It must not produce deletions either. Without the marker `keys`
      // collapses to cursor-user-rules alone, so every ui-state resource this
      // device ever projected would look absent and be published as a
      // tombstone — the peers would then delete their live UI state. The scan
      // is incomplete, and an incomplete scan never deletes; this mirrors
      // `scannedProfiles` in the settings and extension adapters.
      let targets: Record<string, number> = {};
      let markerReadable = true;
      try {
        if (
          markerMetadata.byteLength !== null &&
          markerMetadata.byteLength >
            Math.min(resourceLimit, MAX_TARGET_STORAGE_MARKER_BYTES)
        ) {
          const markerLimit = Math.min(
            resourceLimit,
            MAX_TARGET_STORAGE_MARKER_BYTES,
          );
          throw new Error(
            `UI state target marker is ${markerMetadata.byteLength} bytes, above the ${markerLimit}-byte read limit.`,
          );
        }
        this.options.onValueRead?.(TARGET_STORAGE_MARKER);
        targets = parseTargetStorageMarker(
          readSqliteValue(database, TARGET_STORAGE_MARKER),
        );
      } catch (error) {
        markerReadable = false;
        scanWarnings.push(
          `Unable to read the UI state target marker, so no UI state deletions are published from this scan: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const keys = Object.entries(targets)
        .filter(([, target]) => target === USER_STORAGE_TARGET)
        .map(([key]) => key)
        .filter(
          (key) =>
            !isDeniedUiStateKey(key) && !isIgnoredUiStateKey(key, this.ignoredKeys),
        );
      if (!keys.includes(CURSOR_USER_RULES_KEY)) {
        keys.push(CURSOR_USER_RULES_KEY);
      }
      // Appended unconditionally, exactly like the user rules: these are
      // MACHINE-target, so they never appear in the marker this loop reads and
      // would otherwise be invisible to the scan. See remoteTargets.ts for why
      // a machine-target key is nonetheless the same on both computers.
      for (const key of remoteTargetsKeys()) {
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
      for (const resourceId of this.options.forceVerificationResourceIds ?? []) {
        const key = uiStateKeyFromResourceId(resourceId);
        if (key !== null && !keys.includes(key)) {
          keys.push(key);
        }
      }

      const snapshots: ResourceSnapshot[] = [];
      const warnings: string[] = [...scanWarnings];
      const sortedKeys = keys.sort((left, right) => left.localeCompare(right));
      const listedKeys = new Set(sortedKeys);
      if (this.pendingKeys === null) {
        this.pendingKeys = new Set(sortedKeys);
        this.failedKeys.clear();
        this.failedKeyOverflow = false;
        this.oversized.clear();
        this.oversizedOverflow = false;
        this.progressRevision += 1;
        this.lastEmittedPageFingerprint = null;
      }
      for (const pending of [...this.pendingKeys]) {
        if (!listedKeys.has(pending)) {
          this.pendingKeys.delete(pending);
        }
      }
      for (const key of sortedKeys) {
        if (!this.cycleProcessed.has(key) && !this.failedKeys.has(key)) {
          this.pendingKeys.add(key);
        }
      }
      const retry = this.failedKeys.entries().next().value;
      if (retry !== undefined) {
        const [key] = retry;
        this.failedKeys.delete(key);
        this.pendingKeys.add(key);
      }
      const maxResources =
        this.options.maxResourcesPerScan ?? GENERAL_MAX_RESOURCES_PER_SCAN;
      const retainedLimit =
        this.options.maxRetainedBytesPerScan ??
        GENERAL_MAX_RETAINED_BYTES_PER_SCAN;
      let retainedBytes = 0;
      let materialized = 0;
      let metadataChecks = 0;
      const maxMetadataChecks = Math.max(
        1,
        this.options.maxMetadataChecksPerScan ?? 64,
      );
      for (const key of this.pendingKeys) {
        if (metadataChecks >= maxMetadataChecks) {
          break;
        }
        metadataChecks += 1;
        const kind: ResourceKind =
          kindForKey(key);
        const resourceId = uiStateResourceId(kind, key);
        if (
          databaseTimestamp !== null &&
          !this.options.forceVerificationResourceIds?.has(resourceId) &&
          known[resourceId]?.sourceTimestamp === databaseTimestamp
        ) {
          this.cycleCurrent.add(resourceId);
          this.cycleProcessed.add(key);
          this.pendingKeys.delete(key);
          this.failedKeys.delete(key);
          this.oversized.delete(resourceId);
          this.progressRevision += 1;
          continue;
        }
        if (materialized >= maxResources) {
          break;
        }
        this.options.onMetadataRead?.(key);
        let valueMetadata;
        try {
          valueMetadata = inspectSqliteValue(database, key);
        } catch (error) {
          this.pendingKeys.delete(key);
          this.rememberFailedKey(key, resourceId, maxMetadataChecks);
          warnings.push(error instanceof Error ? error.message : String(error));
          continue;
        }
        if (!valueMetadata.present) {
          this.pendingKeys.delete(key);
          this.failedKeys.delete(key);
          this.cycleProcessed.add(key);
          this.oversized.delete(resourceId);
          this.progressRevision += 1;
          continue;
        }
        this.cycleCurrent.add(resourceId);
        if (
          valueMetadata.byteLength !== null &&
          valueMetadata.byteLength > resourceLimit
        ) {
          const observation = generalOversizedObservation(
            resourceId,
            `${databaseTimestamp ?? "missing"}:${valueMetadata.storageClass}:${valueMetadata.byteLength}`,
            valueMetadata.byteLength,
            this.maxPayloadBytes,
          );
          const remembered = rememberGeneralOversizedObservation(
            this.oversized,
            observation,
          );
          if (!remembered) {
            this.oversizedOverflow = true;
          }
          if (remembered) {
            warnings.push(generalOversizedWarning("UI state", observation));
          }
          this.pendingKeys.delete(key);
          this.failedKeys.delete(key);
          this.cycleProcessed.add(key);
          this.progressRevision += 1;
          continue;
        }
        if (
          materialized > 0 &&
          retainedBytes + (valueMetadata.byteLength ?? 0) > retainedLimit
        ) {
          break;
        }
        let raw;
        try {
          materialized += 1;
          this.options.onValueRead?.(key);
          raw = readSqliteValue(database, key);
        } catch (error) {
          this.pendingKeys.delete(key);
          this.rememberFailedKey(key, resourceId, maxMetadataChecks);
          warnings.push(error instanceof Error ? error.message : String(error));
          continue;
        }
        if (typeof raw !== "string" && !(raw instanceof Uint8Array)) {
          // The wire format has no NULL storage class, and publishing empty
          // content would overwrite a peer's real value. The row is still in
          // `current` so a present-but-unusable value is not a deletion.
          this.pendingKeys.delete(key);
          this.rememberFailedKey(key, resourceId, maxMetadataChecks);
          warnings.push(
            `ui-state ${key}: skipped an unusable SQLite value (${
              raw === null ? "NULL" : typeof raw
            }).`,
          );
          continue;
        }
        const content = toBuffer(raw);
        if (content.byteLength > resourceLimit) {
          const observation = generalOversizedObservation(
            resourceId,
            `${databaseTimestamp ?? "missing"}:${valueMetadata.storageClass}:${content.byteLength}`,
            content.byteLength,
            this.maxPayloadBytes,
          );
          const remembered = rememberGeneralOversizedObservation(
            this.oversized,
            observation,
          );
          if (!remembered) {
            this.oversizedOverflow = true;
          }
          if (remembered) {
            warnings.push(generalOversizedWarning("UI state", observation));
          }
          this.pendingKeys.delete(key);
          this.failedKeys.delete(key);
          this.cycleProcessed.add(key);
          this.progressRevision += 1;
          continue;
        }
        this.oversized.delete(resourceId);
        const contentSemanticHash = sha256(content);
        if (projectionMatchesSemantic(known[resourceId], contentSemanticHash)) {
          this.cycleProcessed.add(key);
          this.pendingKeys.delete(key);
          this.failedKeys.delete(key);
          this.progressRevision += 1;
          continue;
        }
        snapshots.push({
          resourceId,
          kind,
          content,
          semanticHash: contentSemanticHash,
          metadata: {
            key,
            registeredUserTarget: targets[key] === USER_STORAGE_TARGET,
            // SQLite storage class; the apply side must bind TEXT as a string
            // or VS Code's strict string comparisons silently reset UI state.
            valueType: typeof raw === "string" ? "text" : "blob",
            ...(databaseTimestamp === null
              ? {}
              : { lastUpdatedAt: databaseTimestamp }),
          },
        });
        retainedBytes += content.byteLength;
        // Kept pending until the emitted database timestamp is acknowledged.
      }
      if (snapshots.length > 0) {
        const fingerprint = snapshots
          .map((snapshot) => `${snapshot.resourceId}:${snapshot.semanticHash}`)
          .join("\0");
        if (fingerprint !== this.lastEmittedPageFingerprint) {
          this.progressRevision += 1;
          this.lastEmittedPageFingerprint = fingerprint;
        }
      }
      for (const resourceId of [...this.oversized.keys()]) {
        if (!this.cycleCurrent.has(resourceId)) {
          this.oversized.delete(resourceId);
        }
      }
      const pendingResourceIds = [...this.pendingKeys].map((key) =>
        uiStateResourceId(kindForKey(key), key),
      );
      const markerDeferred = markerReadable ? [] : ["ui-state/target-marker"];
      const failedResourceIds = [...this.failedKeys.values()];
      const overflowRecoveryReady =
        pendingResourceIds.length === 0 &&
        failedResourceIds.length === 0 &&
        markerReadable;
      const overflowWasPresent = this.failedKeyOverflow;
      const oversizedOverflowWasPresent = this.oversizedOverflow;
      this.lastScanStatus = {
        complete:
          pendingResourceIds.length === 0 &&
          failedResourceIds.length === 0 &&
          !this.failedKeyOverflow &&
          !this.oversizedOverflow &&
          markerDeferred.length === 0,
        deferredResourceIds: [
          ...new Set([
            ...pendingResourceIds,
            ...failedResourceIds,
            ...(this.failedKeyOverflow
              ? ["ui-state-scope/untracked-read-failures"]
              : []),
            ...(this.oversizedOverflow
              ? ["ui-state-scope/untracked-oversized-resources"]
              : []),
            ...markerDeferred,
          ]),
        ],
        progressToken: this.progressRevision,
      };
      if (
        pendingResourceIds.length === 0 &&
        failedResourceIds.length === 0 &&
        markerReadable
      ) {
        this.pendingKeys = null;
        this.cycleCurrent.clear();
        this.cycleProcessed.clear();
        if (!overflowWasPresent && !oversizedOverflowWasPresent) {
          this.lastCompleteDatabaseTimestamp = databaseTimestamp;
        }
      }
      if (overflowRecoveryReady && overflowWasPresent) {
        // At least one failed key fell out of the bounded retry queue. Once the
        // tracked work has recovered, close this generation as incomplete and
        // clear only the sentinel. The next scan must enumerate the readable
        // marker from scratch (lastCompleteDatabaseTimestamp is deliberately
        // not updated above) before the adapter can report complete again.
        this.failedKeyOverflow = false;
      }
      return {
        snapshots,
        // Fixed-envelope marker paging does not retain an all-known absence
        // proof. Existing remote tombstones still apply, but this device does
        // not originate destructive UI-state guesses from a partial view.
        deletions: [],
        warnings,
      };
    } finally {
      database.close();
    }
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("UI state must be applied by the offline helper.");
  }

  private rememberFailedKey(
    key: string,
    resourceId: string,
    maxFailed: number,
  ): void {
    this.failedKeys.delete(key);
    while (this.failedKeys.size >= maxFailed) {
      const oldest = this.failedKeys.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.failedKeys.delete(oldest);
      this.failedKeyOverflow = true;
    }
    this.failedKeys.set(key, resourceId);
    this.lastEmittedPageFingerprint = null;
  }
}

function projectionMatchesSemantic(
  projection: LocalProjection | undefined,
  semanticHash: string,
): boolean {
  return (
    projection?.semanticHash === semanticHash ||
    projection?.retainedLocalHash === semanticHash
  );
}

function kindForKey(key: string): ResourceKind {
  return key === CURSOR_USER_RULES_KEY
    ? "cursor-user-rules"
    : isRemoteTargetsKey(key)
      ? "remote-targets"
      : "ui-state";
}

function uiStateKeyFromResourceId(resourceId: string): string | null {
  const separator = resourceId.indexOf("/");
  if (separator <= 0) {
    return null;
  }
  const kind = resourceId.slice(0, separator);
  if (!["ui-state", "cursor-user-rules", "remote-targets"].includes(kind)) {
    return null;
  }
  try {
    return decodeURIComponent(resourceId.slice(separator + 1));
  } catch {
    return null;
  }
}

function uiStateResourceId(kind: ResourceKind, key: string): string {
  return `${kind}/${encodeURIComponent(key)}`;
}

function toBuffer(value: Uint8Array | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}
