import { stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
  LocalProjection,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeIdentifier,
  assertSafeRelativePath,
  isMissingPathError,
  normalizeResourcePath,
  pathExists,
  readFileWithinRoot,
} from "../platform/files";
import { sha256 } from "../protocol/canonical";
import { buffersFitJsonStructureBudget } from "../protocol/jsonStructure";
import { EMPTY_IGNORE_MATCHER, type IgnoreMatcher } from "./ignorePatterns";
import type {
  OversizedSnapshotSettlement,
  ResourceAdapter,
  ResourceApplyInput,
  ResourceScanStatus,
} from "./resource";
import {
  captureWorkspaceDatabaseSnapshot,
  serializeWorkspaceDatabaseSnapshot,
} from "../helper/workspaceDatabaseMerge";
import { filterPortableWorkspaceRows } from "./workspaceStatePolicy";
import { DEFAULT_MAX_PAYLOAD_MIB } from "../constants";
import {
  CHAT_AUXILIARY_MAX_RESOURCES_PER_SCAN,
  CHAT_AUXILIARY_MAX_RETAINED_BYTES_PER_SCAN,
  BoundedAuxiliaryOversizedSettlements,
  auxiliaryOversizedObservation,
  auxiliaryOversizedWarning,
  auxiliaryResourceLimit,
  type AuxiliaryOversizedObservation,
} from "../chat/auxiliaryScan";
import {
  AUXILIARY_DIRECTORY_MATCHES_PER_SCAN,
  AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN,
  BoundedFileTreeWalker,
} from "../chat/boundedFileTree";

interface WorkspaceStorageCandidate {
  actualWorkspaceId: string;
  actualRelativePath: string;
  canonicalRelativePath: string;
  path: string;
  priority: number;
  workspaceUri: string | null;
}

interface WorkspacePageMetadata {
  readable: boolean;
  uri: string | null;
}

const WORKSPACE_PAGE_METADATA_MAX_BYTES = 1024 * 1024;
const WORKSPACE_PAGE_METADATA_MEMO_ENTRIES = 256;
export const WORKSPACE_DATABASE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_DATABASE_MAX_INSPECTIONS_PER_SCAN = 4;
export const WORKSPACE_DATABASE_MAX_PHYSICAL_BYTES_PER_SCAN =
  WORKSPACE_DATABASE_MAX_FILE_BYTES;

interface WorkspacePageMetadataMemo {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  metadata: WorkspacePageMetadata;
}

const workspacePageMetadataMemo = new Map<
  string,
  WorkspacePageMetadataMemo
>();

export interface WorkspaceStorageAdapterOptions {
  maxResourcesPerScan?: number;
  maxRetainedBytesPerScan?: number;
  maxEnumerationWorkspacesPerScan?: number;
  maxEnumerationWorkItemsPerScan?: number;
  enumerationIntervalMs?: number;
  maxMetadataChecksPerScan?: number;
  maxOversizedSettlements?: number;
  maxDatabaseInspectionsPerScan?: number;
  maxDatabasePhysicalBytesPerScan?: number;
  metadataIntervalMs?: number;
  now?: () => number;
  onFileRead?: (path: string) => void;
  onMetadataCheck?: (path: string) => void;
  onWorkspaceEnumerate?: (workspaceId: string) => void;
  onEnumerationWork?: (path: string) => void;
  forceVerificationResourceIds?: ReadonlySet<string>;
}

export class WorkspaceStorageAdapter implements ResourceAdapter {
  readonly id = "workspace-storage";
  readonly kinds = ["workspace-storage"] as const;
  readonly appliesWhileRunning = false;
  /**
   * True in the extension host, where the scan is restricted to the files
   * Cursor is not holding open. See {@link imagesOnly}.
   */
  readonly scanWhileRunning: boolean;
  private lastScanStatus: ResourceScanStatus = {
    complete: true,
    deferredResourceIds: [],
  };
  private readonly oversized: BoundedAuxiliaryOversizedSettlements;
  private readonly pendingCandidates = new Map<
    string,
    WorkspaceStorageCandidate
  >();
  private readonly failedCandidates = new Map<
    string,
    WorkspaceStorageCandidate
  >();
  private failedCandidateOverflow = false;
  private readonly workspaceWalker = new BoundedFileTreeWalker();
  private enumerationActive = false;
  private nextEnumerationAt = 0;
  private progressRevision = 0;

  constructor(
    private readonly paths: CursorPaths,
    private readonly workspaceMappings: Record<string, string> = {},
    /**
     * The publish limit. Capturing a database larger than what can ever be
     * published only burns minutes of IO before the publish side skips it, so
     * the capture stops at the same number.
     */
    private maxPayloadBytes: number | undefined = undefined,
    /**
     * Workspaces this computer stays out of, matched against the workspace URI.
     * A workspace with no URI is never excluded: the entry would be matched on
     * nothing, and dropping a backup on the strength of missing metadata is the
     * wrong direction to fail in.
     */
    private readonly ignoredWorkspaces: IgnoreMatcher = EMPTY_IGNORE_MATCHER,
    /**
     * Scan only `images/`, and do it while Cursor is running.
     *
     * The whole adapter used to wait for shutdown, because `state.vscdb` is a
     * database Cursor holds open and reading it mid-write is how you capture a
     * torn snapshot. Chat images are not that: each is written once under a
     * fresh UUID and never touched again, and the chat that references them is
     * published within thirty seconds of being written.
     *
     * Holding the images to shutdown meant a conversation could arrive on the
     * other computer whole while its screenshots did not exist there — and
     * Cursor cannot continue a chat whose image is missing. It reports
     * "Couldn't process image ..." and then fails the turn outright. The user
     * hit exactly that: the chat had crossed, the PNG was still sitting on the
     * machine that took it, waiting for a quit that had not happened.
     */
    private readonly imagesOnly = false,
    private readonly options: WorkspaceStorageAdapterOptions = {},
  ) {
    this.scanWhileRunning = imagesOnly;
    this.oversized = new BoundedAuxiliaryOversizedSettlements(
      options.maxOversizedSettlements,
    );
  }

  setMaxPayloadBytes(maxPayloadBytes: number): void {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
      throw new Error("workspaceStorage payload limit must be a positive integer.");
    }
    if (this.maxPayloadBytes !== maxPayloadBytes) {
      this.maxPayloadBytes = maxPayloadBytes;
      this.oversized.clear();
    }
  }

  /** Closes any native workspaceStorage cursor retained between pages. */
  async dispose(): Promise<void> {
    await this.workspaceWalker.clear();
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
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    // Workspace identity is loaded only for workspace IDs in this bounded
    // path page. An unreadable workspace.json is unknown, never folderless.
    const workspaceMetadata = new Map<string, WorkspacePageMetadata>();
    const mappingTargets = new Set(Object.values(this.workspaceMappings));
    const silenced = new Set<string>();
    const folderless = new Set<string>();

    const maxPending = Math.min(
      this.options.maxMetadataChecksPerScan ?? 64,
      AUXILIARY_DIRECTORY_MATCHES_PER_SCAN,
    );
    this.promoteFailedCandidate(maxPending);
    const listed = await this.discoverBackedUpWorkspaceStoragePaths(
      Math.max(0, maxPending - this.pendingCandidates.size),
    );
    warnings.push(...listed.warnings);

    for (const path of listed.paths) {
      try {
        const actualRelativePath = normalizeResourcePath(
          relative(this.paths.workspaceStorageRoot, path),
        );
        const actualWorkspaceId = validateWorkspaceStorageRelativePath(
          this.paths.workspaceStorageRoot,
          actualRelativePath,
        );
        if (!isBackedUpWorkspaceStorageFile(actualRelativePath)) {
          continue;
        }
        // While Cursor runs, only the write-once files. `state.vscdb` is open
        // and `notepads.json` is rewritten as the user types; both wait for
        // the shutdown export, which is the pass that has Cursor to itself.
        if (this.imagesOnly && !isWorkspaceImagePath(actualRelativePath)) {
          continue;
        }
        const canonicalWorkspaceId = canonicalWorkspaceStorageId(
          actualWorkspaceId,
          this.workspaceMappings,
        );
        const canonicalRelativePath = [
          canonicalWorkspaceId,
          ...actualRelativePath.split("/").slice(1),
        ].join("/");
        const resourceId = workspaceStorageResourceId(canonicalRelativePath);
        let metadata = workspaceMetadata.get(actualWorkspaceId);
        if (metadata === undefined) {
          metadata = await readWorkspacePageMetadata(
            this.paths,
            actualWorkspaceId,
          );
          workspaceMetadata.set(actualWorkspaceId, metadata);
        }
        if (metadata.readable && metadata.uri === null) {
          // A directory with no folder URI belongs to a window that had nothing
          // open - `discoverWorkspaces` lists only those with a folder or a
          // .code-workspace file. VS Code names those after the millisecond the
          // window was created, so the name identifies a window on this
          // computer and can identify nothing on any other. Publishing one only
          // ever produced a change the far side could not place.
          //
          // Gated on a non-empty map so a discovery that failed or found
          // nothing excludes nothing: a workspace missing from a map that was
          // never built is not evidence about that workspace, and dropping a
          // backup on that basis is the one mistake this adapter must not make.
          if (known[resourceId] !== undefined) {
            folderless.add(actualWorkspaceId);
          }
          continue;
        }
        if (
            isIgnoredWorkspaceUri(
            metadata.uri,
            this.ignoredWorkspaces,
          )
        ) {
          // A workspace that was being backed up until the exclusion covered it
          // otherwise stops travelling in total silence - no tombstone, no
          // status change, a green check mark - and the user only finds out
          // when they need the backup. Same reasoning as the built-in
          // machine-specific settings defaults.
          if (known[resourceId] !== undefined) {
            silenced.add(actualWorkspaceId);
          }
          continue;
        }
        const candidate: WorkspaceStorageCandidate = {
          actualWorkspaceId,
          actualRelativePath,
          canonicalRelativePath,
          path,
          priority: mappingTargets.has(actualWorkspaceId)
            ? 2
            : actualWorkspaceId === canonicalWorkspaceId
              ? 1
              : 0,
          workspaceUri: metadata.uri,
        };
        const current = this.pendingCandidates.get(resourceId);
        if (current === undefined) {
          this.pendingCandidates.set(resourceId, candidate);
        } else {
          const preferred =
            candidate.priority > current.priority ||
            (candidate.priority === current.priority &&
              candidate.path.localeCompare(current.path) < 0)
              ? candidate
              : current;
          const discarded = preferred === candidate ? current : candidate;
          // The losing directory is excluded from backup; surfacing the
          // collision keeps that exclusion visible instead of silent.
          warnings.push(
            `workspaceStorage directories ${discarded.actualWorkspaceId} and ${preferred.actualWorkspaceId} collide on ${preferred.canonicalRelativePath}; backing up ${preferred.actualWorkspaceId} only.`,
          );
          this.pendingCandidates.set(resourceId, preferred);
        }
      } catch (error) {
        warnings.push(formatScanWarning(path, error));
      }
    }

    const candidateEntries = [...this.pendingCandidates.entries()].slice(
      0,
      this.options.maxMetadataChecksPerScan ?? 64,
    );
    const oversizedWarnings: AuxiliaryOversizedObservation[] = [];
    const configuredLimit =
      this.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_MIB * 1024 * 1024;
    const resourceLimit = auxiliaryResourceLimit(configuredLimit);
    const maxResources =
      this.options.maxResourcesPerScan ??
      CHAT_AUXILIARY_MAX_RESOURCES_PER_SCAN;
    const retainedLimit =
      this.options.maxRetainedBytesPerScan ??
      CHAT_AUXILIARY_MAX_RETAINED_BYTES_PER_SCAN;
    let retainedBytes = 0;
    let materialized = 0;
    let databaseInspections = 0;
    let inspectedDatabasePhysicalBytes = 0;
    const maxDatabaseInspections = Math.max(
      1,
      this.options.maxDatabaseInspectionsPerScan ??
        WORKSPACE_DATABASE_MAX_INSPECTIONS_PER_SCAN,
    );
    const maxDatabasePhysicalBytes = Math.max(
      1,
      this.options.maxDatabasePhysicalBytesPerScan ??
        WORKSPACE_DATABASE_MAX_PHYSICAL_BYTES_PER_SCAN,
    );

    for (
      let candidateIndex = 0;
      candidateIndex < candidateEntries.length;
      candidateIndex += 1
    ) {
      const entry = candidateEntries[candidateIndex];
      if (entry === undefined) {
        continue;
      }
      const [resourceId, candidate] = entry;
      let observedIdentity: string | null = null;
      let observedDatabasePhysicalBytes: number;
      try {
        this.options.onMetadataCheck?.(candidate.path);
        const database = isWorkspaceStateDatabasePath(
          candidate.canonicalRelativePath,
        );
        const databaseObservation = database
          ? await workspaceDatabaseObservation(candidate.path)
          : null;
        const observedTimestamp =
          databaseObservation?.lastUpdatedAt ??
          (await workspaceStorageTimestamp(candidate.path, false));
        observedDatabasePhysicalBytes =
          databaseObservation?.physicalBytes ?? 0;
        observedIdentity = databaseObservation?.identity ??
          `file:${observedTimestamp}`;
        if (
          !this.options.forceVerificationResourceIds?.has(resourceId) &&
          known[resourceId]?.sourceTimestamp === observedTimestamp
        ) {
          this.oversized.delete(resourceId);
          this.pendingCandidates.delete(resourceId);
          this.failedCandidates.delete(resourceId);
          this.progressRevision += 1;
          continue;
        }
        const priorSettlement = this.oversized.get(resourceId);
        if (database && priorSettlement?.identity === observedIdentity) {
          this.pendingCandidates.delete(resourceId);
          this.failedCandidates.delete(resourceId);
          this.progressRevision += 1;
          continue;
        }
        if (database) {
          this.oversized.delete(resourceId);
        }
        if (materialized >= maxResources) {
          break;
        }
        if (!database) {
          const fileStat = await stat(candidate.path);
          const identity = `${fileStat.size}:${fileStat.mtimeMs}`;
          observedIdentity = identity;
          const settlement = this.oversized.get(resourceId);
          if (settlement?.identity === identity) {
            this.pendingCandidates.delete(resourceId);
            this.failedCandidates.delete(resourceId);
            this.progressRevision += 1;
            continue;
          }
          this.oversized.delete(resourceId);
          if (fileStat.size > resourceLimit) {
            const observation = auxiliaryOversizedObservation(
              resourceId,
              identity,
              fileStat.size,
              configuredLimit,
            );
            this.oversized.set(
              resourceId,
              observation,
            );
            oversizedWarnings.push(observation);
            this.pendingCandidates.delete(resourceId);
            this.failedCandidates.delete(resourceId);
            this.progressRevision += 1;
            continue;
          }
          if (
            snapshots.length > 0 &&
            retainedBytes + fileStat.size > retainedLimit
          ) {
            break;
          }
        } else {
          if (
            observedDatabasePhysicalBytes > WORKSPACE_DATABASE_MAX_FILE_BYTES
          ) {
            const observation = auxiliaryOversizedObservation(
              resourceId,
              observedIdentity,
              observedDatabasePhysicalBytes,
              configuredLimit,
            );
            this.oversized.set(resourceId, observation);
            oversizedWarnings.push(observation);
            this.pendingCandidates.delete(resourceId);
            this.failedCandidates.delete(resourceId);
            this.progressRevision += 1;
            continue;
          }
          if (
            databaseInspections >= maxDatabaseInspections ||
            (databaseInspections > 0 &&
              inspectedDatabasePhysicalBytes +
                observedDatabasePhysicalBytes >
                maxDatabasePhysicalBytes)
          ) {
            break;
          }
          if (snapshots.length > 0 && retainedBytes >= retainedLimit) {
            break;
          }
          databaseInspections += 1;
          inspectedDatabasePhysicalBytes += observedDatabasePhysicalBytes;
        }
        materialized += 1;
        if (database) {
          this.options.onFileRead?.(candidate.path);
        }
        const captured = database
          ? await snapshotWorkspaceDatabase(
              candidate.path,
              candidate.canonicalRelativePath.split("/")[0] ?? "",
              candidate.actualWorkspaceId,
              resourceLimit,
              WORKSPACE_DATABASE_MAX_FILE_BYTES,
            )
          : await readStableFile(
              this.paths.workspaceStorageRoot,
              candidate.actualRelativePath,
              candidate.path,
              resourceLimit,
              () => this.options.onFileRead?.(candidate.path),
            );
        warnings.push(
          ...captured.warnings.map(
            (warning) => `${candidate.canonicalRelativePath}: ${warning}`,
          ),
        );
        if (
          snapshots.length > 0 &&
          retainedBytes + captured.content.byteLength > retainedLimit
        ) {
          break;
        }
        snapshots.push({
          resourceId,
          kind: "workspace-storage",
          content: captured.content,
          semanticHash: sha256(captured.content),
          metadata: {
            relativePath: candidate.canonicalRelativePath,
            workspaceId:
              candidate.canonicalRelativePath.split("/")[0] ?? "",
            workspaceUri:
              candidate.workspaceUri,
            lastUpdatedAt: captured.mtimeMs,
            plainBytes: captured.content.byteLength,
          },
        });
        retainedBytes += captured.content.byteLength;
        this.pendingCandidates.delete(resourceId);
        this.failedCandidates.delete(resourceId);
        this.progressRevision += 1;
      } catch (error) {
        if (
          observedIdentity !== null &&
          isWorkspaceSnapshotPolicyLimitError(error)
        ) {
          const observation = auxiliaryOversizedObservation(
            resourceId,
            observedIdentity,
            resourceLimit + 1,
            configuredLimit,
          );
          this.oversized.set(
            resourceId,
            observation,
          );
          oversizedWarnings.push(observation);
          this.pendingCandidates.delete(resourceId);
          this.failedCandidates.delete(resourceId);
          this.progressRevision += 1;
        } else if (isMissingPathError(error)) {
          this.pendingCandidates.delete(resourceId);
          this.failedCandidates.delete(resourceId);
          this.progressRevision += 1;
        } else {
          warnings.push(formatScanWarning(candidate.path, error));
          this.pendingCandidates.delete(resourceId);
          this.rememberFailedCandidate(resourceId, candidate, maxPending);
        }
      }
    }

    if (listed.completedGeneration) {
      this.oversized.completeGeneration();
    }

    const enumerationDeferred = listed.deferredWorkspaces.map(
      (workspaceId) =>
        `workspace-storage-enumeration/${encodeURIComponent(workspaceId)}`,
    );
    const metadataDeferred = new Set([
      ...this.pendingCandidates.keys(),
      ...this.failedCandidates.keys(),
    ]);
    this.lastScanStatus = {
      complete:
        metadataDeferred.size === 0 &&
        !this.failedCandidateOverflow &&
        !this.oversized.overflowed &&
        enumerationDeferred.length === 0,
      deferredResourceIds: [
        ...metadataDeferred,
        ...(this.failedCandidateOverflow
          ? ["workspace-storage-scope/untracked-read-failures"]
          : []),
        ...(this.oversized.overflowed
          ? ["workspace-storage-scope/untracked-oversized-resources"]
          : []),
        ...enumerationDeferred,
      ],
      progressToken:
        this.progressRevision + this.workspaceWalker.progressToken(),
    };
    for (const observation of oversizedWarnings) {
      if (observation.fixedWorkLimit) {
        warnings.push(
          auxiliaryOversizedWarning("workspaceStorage file", observation),
        );
      }
    }
    if (this.oversized.overflowed) {
      warnings.push(
        `workspaceStorage oversized settlement tracking exceeded its fixed limit; ${this.oversized.overflowCount} additional resource(s) remain local and incoming workspace changes stay deferred until a later complete sweep.`,
      );
    }

    const notices: string[] = [];
    if (folderless.size > 0) {
      notices.push(
        `${folderless.size} workspaceStorage director(ies) belong to windows with no folder open and are no longer backed up: ${[
          ...folderless,
        ]
          .sort()
          .slice(0, 10)
          .join(", ")}. They are named after the moment the window was created, so no other computer could place them.`,
      );
    }
    if (silenced.size > 0) {
      notices.push(
        `${silenced.size} workspace(s) this device had already backed up are now excluded from workspaceStorage sync: ${[
          ...silenced,
        ]
          .sort()
          .slice(0, 10)
          .join(", ")}. Their existing backups stay in the repository; set cursorSettingSync.syncLocalWorkspaces to true, or narrow cursorSettingSync.ignoredWorkspaces, to keep backing them up.`,
      );
    }
    return { snapshots, deletions: [], warnings, notices };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("workspaceStorage files must be applied by the offline helper.");
  }

  private promoteFailedCandidate(maxPending: number): void {
    if (this.pendingCandidates.size >= maxPending) {
      return;
    }
    const next = this.failedCandidates.entries().next().value;
    if (next === undefined) {
      return;
    }
    const [resourceId, candidate] = next;
    this.failedCandidates.delete(resourceId);
    this.pendingCandidates.set(resourceId, candidate);
  }

  private rememberFailedCandidate(
    resourceId: string,
    candidate: WorkspaceStorageCandidate,
    maxPending: number,
  ): void {
    this.failedCandidates.delete(resourceId);
    while (this.failedCandidates.size >= maxPending) {
      const oldest = this.failedCandidates.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.failedCandidates.delete(oldest);
      this.failedCandidateOverflow = true;
    }
    this.failedCandidates.set(resourceId, candidate);
  }

  private async discoverBackedUpWorkspaceStoragePaths(
    maxMatches: number,
  ): Promise<{
    paths: string[];
    warnings: string[];
    deferredWorkspaces: string[];
    completedGeneration: boolean;
  }> {
    const root = this.paths.workspaceStorageRoot;
    const now = (this.options.now ?? Date.now)();
    let completedGeneration = false;
    if (!this.enumerationActive && now >= this.nextEnumerationAt) {
      this.enumerationActive = true;
      this.failedCandidateOverflow = false;
      this.oversized.beginGeneration();
    }
    const warnings: string[] = [];
    const paths: string[] = [];
    if (this.enumerationActive && maxMatches > 0) {
      try {
        const page = await this.workspaceWalker.advance(root, {
          maxWorkItems:
            this.options.maxEnumerationWorkItemsPerScan ??
            AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN,
          maxMatches,
          maxDirectoryMatches:
            this.options.maxEnumerationWorkspacesPerScan ?? 16,
          includeDirectory: (_path, relativePath) => {
            const segments = normalizeResourcePath(relativePath).split("/");
            if (segments.length !== 1) {
              return false;
            }
            this.options.onWorkspaceEnumerate?.(segments[0] ?? "");
            return true;
          },
          includeFile: (_path, relativePath) => {
            const actualRelativePath = normalizeResourcePath(relativePath);
            return (
              isBackedUpWorkspaceStorageFile(actualRelativePath) &&
              (!this.imagesOnly || isWorkspaceImagePath(actualRelativePath))
            );
          },
          descendIntoDirectory: (_path, relativePath) => {
            const segments = normalizeResourcePath(relativePath).split("/");
            return (
              segments.length === 1 ||
              (segments.length >= 2 &&
                segments[1]?.toLowerCase() === "images")
            );
          },
          onWorkItem: this.options.onEnumerationWork,
        });
        paths.push(...page.files);
        if (page.complete) {
          this.enumerationActive = false;
          completedGeneration = true;
          this.nextEnumerationAt =
            now + (this.options.enumerationIntervalMs ?? 30 * 1000);
        }
      } catch (error) {
        warnings.push(formatScanWarning(root, error));
      }
    }
    const deferredWorkspaces = this.enumerationActive ? [root] : [];
    return {
      paths,
      warnings,
      deferredWorkspaces,
      completedGeneration,
    };
  }
}

async function readWorkspacePageMetadata(
  paths: CursorPaths,
  workspaceId: string,
): Promise<WorkspacePageMetadata> {
  const relativePath = `${workspaceId}/workspace.json`;
  try {
    const metadataPath = join(
      paths.workspaceStorageRoot,
      workspaceId,
      "workspace.json",
    );
    const metadataStat = await stat(metadataPath);
    if (metadataStat.size > WORKSPACE_PAGE_METADATA_MAX_BYTES) {
      throw new Error("workspace metadata exceeds its read limit");
    }
    const memoKey = `${paths.workspaceStorageRoot}\0${workspaceId}`;
    const cached = workspacePageMetadataMemo.get(memoKey);
    if (
      cached !== undefined &&
      cached.size === metadataStat.size &&
      cached.mtimeMs === metadataStat.mtimeMs &&
      cached.ctimeMs === metadataStat.ctimeMs
    ) {
      workspacePageMetadataMemo.delete(memoKey);
      workspacePageMetadataMemo.set(memoKey, cached);
      return cached.metadata;
    }
    const bytes = await readFileWithinRoot(
      paths.workspaceStorageRoot,
      relativePath,
      WORKSPACE_PAGE_METADATA_MAX_BYTES,
    );
    if (!buffersFitJsonStructureBudget([bytes])) {
      const metadata = { readable: false, uri: null };
      rememberWorkspacePageMetadata(memoKey, metadataStat, metadata);
      return metadata;
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      folder?: unknown;
      workspace?: unknown;
    };
    const uri =
      typeof parsed.folder === "string"
        ? parsed.folder
        : typeof parsed.workspace === "string"
          ? parsed.workspace
          : null;
    const metadata = {
      readable: true,
      uri: uri !== null && uri.length > 0 ? uri : null,
    };
    rememberWorkspacePageMetadata(memoKey, metadataStat, metadata);
    return metadata;
  } catch {
    return { readable: false, uri: null };
  }
}

function rememberWorkspacePageMetadata(
  key: string,
  info: { size: number; mtimeMs: number; ctimeMs: number },
  metadata: WorkspacePageMetadata,
): void {
  workspacePageMetadataMemo.delete(key);
  while (workspacePageMetadataMemo.size >= WORKSPACE_PAGE_METADATA_MEMO_ENTRIES) {
    const oldest = workspacePageMetadataMemo.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    workspacePageMetadataMemo.delete(oldest);
  }
  workspacePageMetadataMemo.set(key, {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    metadata,
  });
}

function isWorkspaceSnapshotPolicyLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Workspace database snapshot exceeds the payload limit") ||
    message.includes("Workspace database snapshot exceeds the row limit") ||
    message.includes("Workspace database snapshot exceeds the structural JSON limit") ||
    message.includes("Workspace database snapshot exceeds the physical file limit") ||
    message.includes("the snapshot serializes to")
  );
}

/**
 * Whether `cursorSettingSync.ignoredWorkspaces` covers this workspace.
 *
 * Both halves of the sync consult this - the scan, so an excluded workspace is
 * never backed up, and the apply side, so an incoming one is never written and
 * never raises the mapping prompt. A workspace whose URI is unknown is left in,
 * because the pattern would be matched against nothing and silently dropping a
 * backup is the worse of the two mistakes.
 */
export function isIgnoredWorkspaceUri(
  uri: string | null | undefined,
  ignored: IgnoreMatcher,
): boolean {
  if (typeof uri !== "string" || uri.length === 0) {
    return false;
  }
  return ignored.matches(uri) || ignored.matches(decodeWorkspaceUriSafely(uri));
}

/**
 * `file://*` has to match a URI Cursor stored as `file:///c%3A/...`, and a user
 * writing a path pattern will write the readable form, so both spellings are
 * offered to the matcher.
 */
function decodeWorkspaceUriSafely(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

export function validateWorkspaceStorageRelativePath(
  root: string,
  relativePath: string,
): string {
  assertSafeRelativePath(root, relativePath);
  const segments = relativePath.split("/");
  if (segments.length < 2) {
    throw new Error(`workspaceStorage path must include a workspace ID: ${relativePath}`);
  }
  return assertSafeIdentifier(segments[0] ?? "", "workspaceStorage workspace ID");
}

export function workspaceStorageResourceId(relativePath: string): string {
  const resourceId = `workspace-storage/${encodeURIComponent(relativePath)}`;
  if (resourceId.length > 4096) {
    throw new Error(`workspaceStorage resource path is too long: ${relativePath}`);
  }
  return resourceId;
}

export function canonicalWorkspaceStorageId(
  localWorkspaceId: string,
  workspaceMappings: Record<string, string>,
): string {
  assertSafeIdentifier(localWorkspaceId, "workspaceStorage workspace ID");
  const related = new Set([localWorkspaceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [source, target] of Object.entries(workspaceMappings)) {
      if (!isWorkspaceStorageId(source) || !isWorkspaceStorageId(target)) {
        continue;
      }
      if (!related.has(source) && !related.has(target)) {
        continue;
      }
      if (!related.has(source)) {
        related.add(source);
        changed = true;
      }
      if (!related.has(target)) {
        related.add(target);
        changed = true;
      }
    }
  }
  return [...related].sort()[0] ?? localWorkspaceId;
}

export function isTransientWorkspaceStorageFile(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  return (
    name.endsWith("-wal") ||
    name.endsWith("-shm") ||
    name.endsWith("-journal") ||
    name.endsWith(".lock") ||
    name.endsWith(".partial") ||
    name.endsWith(".tmp")
  );
}

export function isBackedUpWorkspaceStorageFile(relativePath: string): boolean {
  if (isTransientWorkspaceStorageFile(relativePath)) {
    return false;
  }
  const segments = relativePath.split("/");
  const nestedPath = segments.slice(1);
  if (nestedPath.length === 1) {
    return ["state.vscdb", "notepads.json"].includes(
      nestedPath[0]?.toLowerCase() ?? "",
    );
  }
  return nestedPath.length >= 2 && nestedPath[0]?.toLowerCase() === "images";
}

export function isWorkspaceStateDatabasePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return (
    segments.length === 2 &&
    segments[1]?.toLowerCase() === "state.vscdb"
  );
}

/** `<workspaceId>/images/<name>` — chat attachments, written once and never edited. */
export function isWorkspaceImagePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.length >= 3 && segments[1]?.toLowerCase() === "images";
}

/** `<workspaceId>/notepads.json` — the one workspace file that is a JSON list. */
export function isWorkspaceNotepadsPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.length === 2 && segments[1]?.toLowerCase() === "notepads.json";
}

async function snapshotWorkspaceDatabase(
  path: string,
  canonicalWorkspaceId: string,
  databaseWorkspaceId: string,
  maxPayloadBytes: number | undefined,
  maxPhysicalBytes: number,
): Promise<{ content: Buffer; mtimeMs: number; warnings: string[] }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await workspaceDatabaseObservation(path);
    if (before.physicalBytes > maxPhysicalBytes) {
      throw new Error(
        `Workspace database snapshot exceeds the physical file limit: ${before.physicalBytes} bytes is above ${maxPhysicalBytes}.`,
      );
    }
    const captured = captureWorkspaceDatabaseSnapshot(path, {
      workspaceId: canonicalWorkspaceId,
      databaseWorkspaceId,
      includeComposerHeaders: true,
      ...(maxPayloadBytes === undefined
        ? {}
        : { limits: { maxPlainBytes: maxPayloadBytes } }),
    });
    // Machine-local UI rows stay on this machine; see workspaceStatePolicy.
    // Filtering before serializing also keeps the published bytes stable while
    // Cursor churns chrome rows, so an open workspace stops republishing.
    const content = serializeWorkspaceDatabaseSnapshot(
      filterPortableWorkspaceRows(captured.snapshot),
    );
    // The capture limit counts DECODED bytes, but the payload is base64 inside
    // JSON — roughly 4/3 of the blobs plus structure. A database that passed
    // capture can therefore still be far above the publish limit, and letting
    // it reach `publish` used to throw away the entire shutdown export. Only
    // the serialized buffer can be compared against the limit that matters.
    if (maxPayloadBytes !== undefined && content.byteLength > maxPayloadBytes) {
      throw new Error(
        `the snapshot serializes to ${content.byteLength} bytes, above the ${maxPayloadBytes} byte payload limit. ` +
          'Raise "cursorSettingSync.maxPayloadMiB" to cover it, or set ' +
          '"cursorSettingSync.syncWorkspaceStorage" to false. Everything else in this export still synchronized.',
      );
    }
    const after = await workspaceDatabaseObservation(path);
    if (before.identity === after.identity) {
      return {
        content,
        mtimeMs: after.lastUpdatedAt,
        warnings: captured.warnings,
      };
    }
  }
  throw new Error(`Workspace database changed while being backed up: ${path}`);
}

async function readStableFile(
  root: string,
  relativePath: string,
  path: string,
  maxBytes: number | undefined,
  onFileRead: () => void,
): Promise<{ content: Buffer; mtimeMs: number; warnings: string[] }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await stat(path);
    onFileRead();
    const content = await readFileWithinRoot(root, relativePath, maxBytes);
    const after = await stat(path);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { content, mtimeMs: after.mtimeMs, warnings: [] };
    }
  }
  throw new Error(`workspaceStorage file changed while being read: ${path}`);
}

async function workspaceStorageTimestamp(
  path: string,
  database: boolean,
): Promise<number> {
  const main = await stat(path);
  if (!database) {
    return main.mtimeMs;
  }
  const walPath = `${path}-wal`;
  if (!(await pathExists(walPath))) {
    return main.mtimeMs;
  }
  return Math.max(main.mtimeMs, (await stat(walPath)).mtimeMs);
}

async function workspaceDatabaseObservation(
  path: string,
): Promise<{ lastUpdatedAt: number; identity: string; physicalBytes: number }> {
  const main = await stat(path);
  const walPath = `${path}-wal`;
  if (!(await pathExists(walPath))) {
    return {
      lastUpdatedAt: main.mtimeMs,
      identity: `db:${main.size}:${main.mtimeMs}:0:0`,
      physicalBytes: main.size,
    };
  }
  const wal = await stat(walPath);
  const physicalBytes = main.size + wal.size;
  if (!Number.isSafeInteger(physicalBytes)) {
    throw new Error("workspaceStorage database size exceeds the safe integer range.");
  }
  return {
    lastUpdatedAt: Math.max(main.mtimeMs, wal.mtimeMs),
    identity: `db:${main.size}:${main.mtimeMs}:${wal.size}:${wal.mtimeMs}`,
    physicalBytes,
  };
}

function isWorkspaceStorageId(value: string): boolean {
  try {
    assertSafeIdentifier(value, "workspaceStorage workspace ID");
    return true;
  } catch {
    return false;
  }
}

function formatScanWarning(path: string, error: unknown): string {
  return `Unable to back up workspaceStorage file ${path}: ${
    error instanceof Error ? error.message : String(error)
  }`;
}
