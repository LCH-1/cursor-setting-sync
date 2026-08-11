import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type {
  LocalProjection,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  isMissingPathError,
  normalizeResourcePath,
  readFileWithinRoot,
} from "../platform/files";
import { sha256 } from "../protocol/canonical";
import { DEFAULT_MAX_PAYLOAD_MIB } from "../constants";
import type {
  OversizedSnapshotSettlement,
  ResourceAdapter,
  ResourceApplyInput,
  ResourceScanStatus,
} from "../resources/resource";
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
} from "./boundedFileTree";

/** Where Cursor keeps a project's transcripts, relative to the project root. */
const TRANSCRIPT_DIRECTORY = "agent-transcripts";

export interface ChatTranscriptsAdapterOptions {
  maxResourcesPerScan?: number;
  maxRetainedBytesPerScan?: number;
  maxEnumerationProjectsPerScan?: number;
  maxEnumerationWorkItemsPerScan?: number;
  enumerationIntervalMs?: number;
  maxMetadataChecksPerScan?: number;
  maxOversizedSettlements?: number;
  metadataIntervalMs?: number;
  now?: () => number;
  onFileRead?: (path: string) => void;
  onMetadataCheck?: (path: string) => void;
  onProjectEnumerate?: (project: string) => void;
  onEnumerationWork?: (path: string) => void;
  forceVerificationResourceIds?: ReadonlySet<string>;
}

interface TranscriptCandidate {
  path: string;
  relativePath: string;
  homeRelativePath: string;
  resourceId: string;
  projectSlug: string;
  size: number;
  mtimeMs: number;
  identity: string;
}

interface TranscriptDescriptor {
  path: string;
  relativePath: string;
  homeRelativePath: string;
  resourceId: string;
  projectSlug: string;
}

export class ChatTranscriptsAdapter implements ResourceAdapter {
  readonly id = "chat-transcripts";
  readonly kinds = ["chat-transcript"] as const;
  readonly appliesWhileRunning = false;

  private maxPayloadBytes = DEFAULT_MAX_PAYLOAD_MIB * 1024 * 1024;
  private lastScanStatus: ResourceScanStatus = {
    complete: true,
    deferredResourceIds: [],
  };
  private readonly oversized: BoundedAuxiliaryOversizedSettlements;
  private readonly pendingDescriptors = new Map<string, TranscriptDescriptor>();
  private readonly failedDescriptors = new Map<string, TranscriptDescriptor>();
  private failedDescriptorOverflow = false;
  private readonly transcriptWalker = new BoundedFileTreeWalker();
  private enumerationActive = false;
  private nextEnumerationAt = 0;
  private progressRevision = 0;

  constructor(
    private readonly paths: CursorPaths,
    private readonly options: ChatTranscriptsAdapterOptions = {},
  ) {
    this.oversized = new BoundedAuxiliaryOversizedSettlements(
      options.maxOversizedSettlements,
    );
  }

  setMaxPayloadBytes(maxPayloadBytes: number): void {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
      throw new Error("Transcript payload limit must be a positive integer.");
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

  /** Closes any native transcript-directory cursor retained between pages. */
  async dispose(): Promise<void> {
    await this.transcriptWalker.clear();
  }

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const maxPending = Math.min(
      this.options.maxMetadataChecksPerScan ?? 64,
      AUXILIARY_DIRECTORY_MATCHES_PER_SCAN,
    );
    this.promoteFailedDescriptor(maxPending);
    const discovered = await this.discoverTranscripts(
      warnings,
      Math.max(0, maxPending - this.pendingDescriptors.size),
    );
    for (const path of discovered.files) {
      try {
        const relativePath = normalizeResourcePath(
          relative(this.paths.cursorProjects, path),
        );
        const resourceId = `chat-transcript/${encodeURIComponent(relativePath)}`;
        this.pendingDescriptors.set(resourceId, {
          path,
          relativePath,
          homeRelativePath: normalizeResourcePath(
            relative(this.paths.cursorHome, path),
          ),
          resourceId,
          projectSlug: relativePath.split("/")[0] ?? "",
        });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    const metadataIds = [...this.pendingDescriptors.keys()]
      .slice(0, this.options.maxMetadataChecksPerScan ?? 64);
    const candidates: TranscriptCandidate[] = [];
    for (const resourceId of metadataIds) {
      const descriptor = this.pendingDescriptors.get(resourceId);
      if (descriptor === undefined) {
        continue;
      }
      try {
        this.options.onMetadataCheck?.(descriptor.path);
        const currentStat = await stat(descriptor.path);
        if (
          !this.options.forceVerificationResourceIds?.has(resourceId) &&
          known[resourceId]?.sourceTimestamp === currentStat.mtimeMs
        ) {
          this.oversized.delete(resourceId);
          this.pendingDescriptors.delete(resourceId);
          this.failedDescriptors.delete(resourceId);
          this.progressRevision += 1;
          continue;
        }
        const identity = `${currentStat.size}:${currentStat.mtimeMs}`;
        const settlement = this.oversized.get(resourceId);
        if (settlement?.identity === identity) {
          this.pendingDescriptors.delete(resourceId);
          this.failedDescriptors.delete(resourceId);
          this.progressRevision += 1;
          continue;
        }
        this.oversized.delete(resourceId);
        candidates.push({
          path: descriptor.path,
          relativePath: descriptor.relativePath,
          homeRelativePath: descriptor.homeRelativePath,
          resourceId,
          projectSlug: descriptor.projectSlug,
          size: currentStat.size,
          mtimeMs: currentStat.mtimeMs,
          identity,
        });
      } catch (error) {
        if (isMissingPathError(error)) {
          this.pendingDescriptors.delete(resourceId);
          this.failedDescriptors.delete(resourceId);
          this.progressRevision += 1;
        } else {
          warnings.push(error instanceof Error ? error.message : String(error));
          this.pendingDescriptors.delete(resourceId);
          this.rememberFailedDescriptor(resourceId, descriptor, maxPending);
        }
      }
    }
    const oversizedWarnings: AuxiliaryOversizedObservation[] = [];
    const resourceLimit = auxiliaryResourceLimit(this.maxPayloadBytes);
    const maxResources =
      this.options.maxResourcesPerScan ??
      CHAT_AUXILIARY_MAX_RESOURCES_PER_SCAN;
    const retainedLimit =
      this.options.maxRetainedBytesPerScan ??
      CHAT_AUXILIARY_MAX_RETAINED_BYTES_PER_SCAN;
    let retainedBytes = 0;
    let materialized = 0;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate === undefined) {
        continue;
      }
      if (
        materialized >= maxResources ||
        (snapshots.length > 0 && retainedBytes + candidate.size > retainedLimit)
      ) {
        break;
      }
      if (candidate.size > resourceLimit) {
        const observation = auxiliaryOversizedObservation(
          candidate.resourceId,
          candidate.identity,
          candidate.size,
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
      try {
        materialized += 1;
        this.options.onFileRead?.(candidate.path);
        const stable = await readStableFile(
          this.paths.cursorHome,
          candidate.homeRelativePath,
          candidate.path,
          resourceLimit,
        );
        snapshots.push({
          resourceId: candidate.resourceId,
          kind: "chat-transcript",
          content: stable.content,
          semanticHash: sha256(stable.content),
          metadata: {
            relativePath: candidate.relativePath,
            projectSlug: candidate.projectSlug,
            lastUpdatedAt: stable.mtimeMs,
          },
        });
        retainedBytes += stable.content.byteLength;
        this.pendingDescriptors.delete(candidate.resourceId);
        this.failedDescriptors.delete(candidate.resourceId);
        this.progressRevision += 1;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        this.pendingDescriptors.delete(candidate.resourceId);
        this.rememberFailedDescriptor(
          candidate.resourceId,
          {
            path: candidate.path,
            relativePath: candidate.relativePath,
            homeRelativePath: candidate.homeRelativePath,
            resourceId: candidate.resourceId,
            projectSlug: candidate.projectSlug,
          },
          maxPending,
        );
      }
    }

    if (discovered.completedGeneration) {
      this.oversized.completeGeneration();
    }

    const enumerationDeferred = discovered.deferredProjects.map(
      (project) => `chat-transcript-project/${encodeURIComponent(project)}`,
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
          ? ["chat-transcript-scope/untracked-read-failures"]
          : []),
        ...(this.oversized.overflowed
          ? ["chat-transcript-scope/untracked-oversized-resources"]
          : []),
        ...enumerationDeferred,
      ],
      progressToken:
        this.progressRevision + this.transcriptWalker.progressToken(),
    };
    for (const observation of oversizedWarnings) {
      if (observation.fixedWorkLimit) {
        warnings.push(auxiliaryOversizedWarning("Transcript", observation));
      }
    }
    if (this.oversized.overflowed) {
      warnings.push(
        `Transcript oversized settlement tracking exceeded its fixed limit; ${this.oversized.overflowCount} additional resource(s) remain local and incoming transcript changes stay deferred until a later complete sweep.`,
      );
    }
    return {
      snapshots,
      // Transcript recovery is additive. A bounded nested-tree page cannot
      // prove a stable whole-tree generation, so absence never emits a
      // tombstone that could delete recovery material on another computer.
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
    descriptor: TranscriptDescriptor,
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

  private async discoverTranscripts(
    warnings: string[],
    maxMatches: number,
  ): Promise<{
    files: string[];
    deferredProjects: string[];
    completedGeneration: boolean;
  }> {
    const files: string[] = [];
    const now = (this.options.now ?? Date.now)();
    let completedGeneration = false;
    if (!this.enumerationActive && now >= this.nextEnumerationAt) {
      this.enumerationActive = true;
      this.failedDescriptorOverflow = false;
      this.oversized.beginGeneration();
    }
    const maxProjects = this.options.maxEnumerationProjectsPerScan ?? 16;
    if (this.enumerationActive && maxMatches > 0) {
      try {
        const page = await this.transcriptWalker.advance(
          this.paths.cursorProjects,
          {
            maxWorkItems:
              this.options.maxEnumerationWorkItemsPerScan ??
              AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN,
            maxMatches,
            maxDirectoryMatches: maxProjects,
            includeDirectory: (_path, relativePath) => {
              const segments = normalizeResourcePath(relativePath).split("/");
              if (segments.length !== 1) {
                return false;
              }
              this.options.onProjectEnumerate?.(segments[0] ?? "");
              return true;
            },
            includeFile: (path, relativePath) => {
              const segments = normalizeResourcePath(relativePath).split("/");
              return (
                segments.length >= 3 &&
                segments[1]?.toLowerCase() === TRANSCRIPT_DIRECTORY &&
                /\.(jsonl|txt)$/i.test(path)
              );
            },
            descendIntoDirectory: (_path, relativePath) => {
              const segments = normalizeResourcePath(relativePath).split("/");
              return (
                segments.length === 1 ||
                (segments.length >= 2 &&
                  segments[1]?.toLowerCase() === TRANSCRIPT_DIRECTORY)
              );
            },
            onWorkItem: this.options.onEnumerationWork,
          },
        );
        files.push(...page.files);
        if (page.complete) {
          this.enumerationActive = false;
          completedGeneration = true;
          this.nextEnumerationAt =
            now + (this.options.enumerationIntervalMs ?? 5 * 60 * 1000);
        }
      } catch (error) {
        warnings.push(
          `Unable to enumerate transcripts below ${this.paths.cursorProjects}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const deferredProjects = this.enumerationActive
      ? [this.paths.cursorProjects]
      : [];
    return { files, deferredProjects, completedGeneration };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Chat transcripts must be applied by the offline helper.");
  }
}

async function readStableFile(
  root: string,
  relativePath: string,
  path: string,
  maxBytes: number,
): Promise<{ content: Buffer; mtimeMs: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await stat(path);
    const content = await readFileWithinRoot(root, relativePath, maxBytes);
    const after = await stat(path);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { content, mtimeMs: after.mtimeMs };
    }
  }
  throw new Error(`Transcript changed while being read: ${path}`);
}
