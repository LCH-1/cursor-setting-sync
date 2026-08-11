import { relative } from "node:path";
import { stat } from "node:fs/promises";
import type {
  JsonValue,
  LocalProjection,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeRelativePath,
  isCaseInsensitivePathPlatform,
  normalizeResourcePath,
  pathExists,
  readFileWithinRoot,
  removeFileWithinRoot,
  writeFileAtomicWithinRoot,
} from "../platform/files";
import { sha256 } from "../protocol/canonical";
import type {
  OversizedSnapshotSettlement,
  ResourceAdapter,
  ResourceApplyInput,
  ResourceApplyResult,
  ResourceScanStatus,
} from "./resource";
import { isDeletion } from "./resource";
import { parseJsonc } from "./jsonc";
import type { IgnoreMatcher } from "./ignorePatterns";
import { createIgnoreMatcher } from "./ignorePatterns";
import { DEFAULT_MAX_PAYLOAD_MIB } from "../constants";
import {
  GENERAL_MAX_RESOURCES_PER_SCAN,
  GENERAL_MAX_RETAINED_BYTES_PER_SCAN,
  generalOversizedObservation,
  generalOversizedWarning,
  generalResourceLimit,
  rememberGeneralOversizedObservation,
  type GeneralOversizedObservation,
} from "./boundedScan";
import {
  AUXILIARY_DIRECTORY_MATCHES_PER_SCAN,
  AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN,
  BoundedFileTreeWalker,
  type BoundedFileTreeStat,
} from "../chat/boundedFileTree";

/** One remembered file: the identity that proves it, plus what it produced. */
interface UserFileMemo {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Optional body cache; identity and hash remain useful when it is omitted. */
  content?: Buffer;
  semanticHash: string;
}

/**
 * Bounds on what the scan memo keeps in memory. A single oversized file, or a
 * very large skills tree, falls back to re-reading rather than growing the
 * extension host without limit.
 */
const MAX_MEMO_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MEMO_TOTAL_BYTES = GENERAL_MAX_RETAINED_BYTES_PER_SCAN;
const MAX_MEMO_ENTRIES = 64;
export const CURSOR_HELPER_DIRECTORY_WORK_ITEMS_PER_SCAN = 512;

export interface CursorUserFilesAdapterOptions {
  maxResourcesPerScan?: number;
  maxRetainedBytesPerScan?: number;
  maxMetadataChecksPerScan?: number;
  metadataIntervalMs?: number;
  maxEnumerationRootsPerScan?: number;
  maxEnumerationWorkItemsPerScan?: number;
  maxEnumerationMatchesPerScan?: number;
  enumerationIntervalMs?: number;
  now?: () => number;
  onFileRead?: (path: string) => void;
  onMetadataCheck?: (path: string) => void;
  onRootEnumerate?: (root: string) => void;
  /** Narrow fixed-envelope test seam. */
  onEnumerationPage?: (page: {
    workItems: number;
    matches: number;
    retainedPathCount: number;
  }) => void;
  /** Narrow fixed-envelope test seam. */
  onPendingDescriptorCount?: (count: number) => void;
  forceVerificationResourceIds?: ReadonlySet<string>;
}

interface UserFileDescriptor {
  path: string;
  relativePath: string;
  resourceId: string;
}

export class CursorUserFilesAdapter implements ResourceAdapter {
  readonly id = "cursor-user-files";
  readonly kinds = ["cursor-user-file"] as const;
  readonly appliesWhileRunning = true;

  /**
   * Files whose size and mtime are unchanged since the previous scan.
   *
   * This adapter runs on the 30-second files poll and used to re-run the
   * hardened path walk (an lstat and a realpath per path segment), a full read
   * and a sha256 for every file under ~/.cursor/{commands,skills,rules} every
   * time, producing an identical answer. A skills tree of a few hundred files
   * made that minutes of pointless IO per hour. Every other frequently polled
   * adapter here already memoizes on mtime; this one now does too.
   */
  private readonly scanMemo = new Map<string, UserFileMemo>();
  private memoBytes = 0;
  private maxPayloadBytes = DEFAULT_MAX_PAYLOAD_MIB * 1024 * 1024;
  private lastScanStatus: ResourceScanStatus = {
    complete: true,
    deferredResourceIds: [],
  };
  private readonly oversized = new Map<string, GeneralOversizedObservation>();
  private oversizedOverflow = false;
  /** At most one bounded walker page plus failed/unacknowledged descriptors. */
  private readonly pendingDescriptors = new Map<string, UserFileDescriptor>();
  /**
   * Failed reads are retried round-robin without occupying the discovery
   * page. Keeping the two bounded queues separate prevents a permanently
   * unreadable first page from pinning the native walker before later files.
   */
  private readonly failedDescriptors = new Map<string, UserFileDescriptor>();
  private failedDescriptorOverflow = false;
  private readonly fileTreeWalker = new BoundedFileTreeWalker();
  private enumerationActive = false;
  private enumerationFixedIndex = 0;
  private enumerationRootIndex = 0;
  private progressRevision = 0;
  private enumerationFailure = false;
  private readonly matchedIgnorePatterns = new Set<string>();
  private nextEnumerationAt = 0;

  // Relative paths that are neither published nor applied, so secret-bearing
  // files can be kept local. Entries may be a canonical path ("mcp.json"), a
  // directory covering everything under it ("rules"), or a glob
  // ("skills/**/secret.md"). On case-insensitive platforms the entries are
  // case-folded so a configured entry matches regardless of on-disk casing; on
  // Linux paths differing only in case are distinct files, so case matters.
  constructor(
    private readonly paths: CursorPaths,
    private readonly ignoredFiles: IgnoreMatcher = createIgnoreMatcher([]),
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly options: CursorUserFilesAdapterOptions = {},
  ) {}

  setMaxPayloadBytes(maxPayloadBytes: number): void {
    generalResourceLimit(maxPayloadBytes);
    if (this.maxPayloadBytes !== maxPayloadBytes) {
      this.maxPayloadBytes = maxPayloadBytes;
      this.oversized.clear();
      this.oversizedOverflow = false;
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

  /** Closes native directory cursors when a bounded helper session is retired. */
  async dispose(): Promise<void> {
    await this.fileTreeWalker.clear();
  }

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const now = (this.options.now ?? Date.now)();
    if (!this.enumerationActive && now >= this.nextEnumerationAt) {
      this.beginEnumeration();
    }
    const resourceLimit = generalResourceLimit(this.maxPayloadBytes);
    const maxResources =
      this.options.maxResourcesPerScan ?? GENERAL_MAX_RESOURCES_PER_SCAN;
    const retainedLimit =
      this.options.maxRetainedBytesPerScan ??
      GENERAL_MAX_RETAINED_BYTES_PER_SCAN;
    const maxPending = Math.max(
      1,
      Math.min(
        this.options.maxEnumerationMatchesPerScan ??
          AUXILIARY_DIRECTORY_MATCHES_PER_SCAN,
        AUXILIARY_DIRECTORY_MATCHES_PER_SCAN,
      ),
    );
    this.promoteFailedDescriptor(maxPending);
    const maxMetadataChecks = Math.max(
      1,
      this.options.maxMetadataChecksPerScan ?? 64,
    );
    const budget = {
      workItems:
        this.options.maxEnumerationWorkItemsPerScan ??
        AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN,
      metadataChecks: maxMetadataChecks,
    };
    const processed = new Set<string>();
    let retainedBytes = 0;
    let verifiedBytes = 0;
    let canContinue = true;
    while (canContinue) {
      canContinue = false;
      if (
        this.enumerationActive &&
        this.pendingDescriptors.size < maxPending &&
        budget.workItems > 0
      ) {
        const before = this.pendingDescriptors.size;
        await this.discoverIntoPending(
          known,
          warnings,
          maxPending,
          budget,
          now,
        );
        canContinue ||= this.pendingDescriptors.size > before;
      }
      for (const [resourceId, descriptor] of this.pendingDescriptors) {
        if (
          processed.has(resourceId) ||
          budget.metadataChecks <= 0
        ) {
          continue;
        }
        processed.add(resourceId);
        budget.metadataChecks -= 1;
        try {
          this.options.onMetadataCheck?.(descriptor.path);
          const info = await fileIdentity(descriptor.path);
          if (info === null) {
            throw new Error(`Unable to stat Cursor user file: ${descriptor.path}`);
          }
          const projection = known[resourceId];
          const memo = this.scanMemo.get(descriptor.relativePath);
          if (
            memo !== undefined &&
            memo.size === info.size &&
            memo.mtimeMs === info.mtimeMs &&
            memo.ctimeMs === info.ctimeMs &&
            !this.options.forceVerificationResourceIds?.has(resourceId) &&
            projectionMatchesSemantic(projection, memo.semanticHash)
          ) {
            this.pendingDescriptors.delete(resourceId);
            this.failedDescriptors.delete(resourceId);
            this.progressRevision += 1;
            this.oversized.delete(resourceId);
            this.scanMemo.delete(descriptor.relativePath);
            this.scanMemo.set(descriptor.relativePath, memo);
            canContinue = true;
            continue;
          }
          if (info.size > resourceLimit) {
            if (
              !rememberGeneralOversizedObservation(
                this.oversized,
                generalOversizedObservation(
                resourceId,
                `${info.size}:${info.mtimeMs}`,
                info.size,
                this.maxPayloadBytes,
              ),
              )
            ) {
              this.oversizedOverflow = true;
            }
            this.pendingDescriptors.delete(resourceId);
            this.failedDescriptors.delete(resourceId);
            this.progressRevision += 1;
            canContinue = true;
            continue;
          }
          if (
            snapshots.length >= maxResources ||
            (snapshots.length > 0 && retainedBytes + info.size > retainedLimit)
          ) {
            continue;
          }
          let content: Buffer;
          let semantic: string;
          const cached = this.scanMemo.get(descriptor.relativePath);
          if (
            cached !== undefined &&
            cached.size === info.size &&
            cached.mtimeMs === info.mtimeMs &&
            cached.ctimeMs === info.ctimeMs &&
            cached.content !== undefined
          ) {
            // Refresh LRU order without allocating another payload.
            this.scanMemo.delete(descriptor.relativePath);
            this.scanMemo.set(descriptor.relativePath, cached);
            content = cached.content;
            semantic = cached.semanticHash;
          } else {
            if (
              verifiedBytes > 0 &&
              verifiedBytes + info.size > retainedLimit
            ) {
              continue;
            }
            this.options.onFileRead?.(descriptor.path);
            content = await readFileWithinRoot(
              this.paths.cursorHome,
              descriptor.relativePath,
              resourceLimit,
            );
            verifiedBytes += content.byteLength;
            if (
              descriptor.relativePath === "mcp.json" ||
              descriptor.relativePath === "cli-config.json"
            ) {
              parseJsonc(content.toString("utf8"), descriptor.path);
            }
            semantic = sha256(content);
            this.remember(descriptor.relativePath, {
              size: info.size,
              mtimeMs: info.mtimeMs,
              ctimeMs: info.ctimeMs,
              content,
              semanticHash: semantic,
            });
          }
          if (projectionMatchesSemantic(projection, semantic)) {
            this.pendingDescriptors.delete(resourceId);
            this.failedDescriptors.delete(resourceId);
            this.progressRevision += 1;
            this.oversized.delete(resourceId);
            canContinue = true;
            continue;
          }
          snapshots.push({
            resourceId,
            kind: "cursor-user-file",
            content,
            semanticHash: semantic,
            metadata: {
              relativePath: descriptor.relativePath,
              lastUpdatedAt: info.mtimeMs,
              sourceFileSize: info.size,
              sourceFileCtimeMs: info.ctimeMs,
            },
          });
          retainedBytes += content.byteLength;
          this.failedDescriptors.delete(resourceId);
          // Keep the descriptor until `known` acknowledges this exact mtime.
          this.oversized.delete(resourceId);
        } catch (error) {
          this.forget(descriptor.relativePath);
          this.pendingDescriptors.delete(resourceId);
          this.rememberFailedDescriptor(resourceId, descriptor, maxPending);
          canContinue = true;
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
      this.options.onPendingDescriptorCount?.(
        this.pendingDescriptors.size + this.failedDescriptors.size,
      );
      if (
        canContinue &&
        budget.metadataChecks > 0 &&
        snapshots.length < maxResources &&
        this.pendingDescriptors.size < maxPending
      ) {
        continue;
      }
      break;
    }

    const metadataDeferred = new Set([
      ...this.pendingDescriptors.keys(),
      ...this.failedDescriptors.keys(),
    ]);
    this.lastScanStatus = {
      complete:
        metadataDeferred.size === 0 &&
        !this.failedDescriptorOverflow &&
        !this.oversizedOverflow &&
        !this.enumerationFailure &&
        !this.enumerationActive,
      deferredResourceIds: [
        ...metadataDeferred,
        ...(this.failedDescriptorOverflow
          ? ["cursor-user-file-scope/untracked-read-failures"]
          : []),
        ...(this.oversizedOverflow
          ? ["cursor-user-file-scope/untracked-oversized-resources"]
          : []),
        ...(this.enumerationFailure
          ? ["cursor-user-file-scope/unreadable-root"]
          : []),
        ...(this.enumerationActive
          ? [
              `cursor-user-file-scope/${encodeURIComponent(
                this.enumerationScope(),
              )}`,
            ]
          : []),
      ],
      progressToken:
        this.progressRevision + this.fileTreeWalker.progressToken(),
    };
    for (const observation of this.oversized.values()) {
      warnings.push(generalOversizedWarning("Cursor user file", observation));
    }

    // Silence here means the user believes a private file is excluded when it
    // is still being published, so an entry that matched nothing is reported.
    // It is deliberately not phrased as "your file is being published": the
    // same entry matches nothing when the file simply does not exist yet,
    // which is the normal case for someone who excludes mcp.json up front.
    if (!this.enumerationActive) {
      for (const pattern of this.ignoredFiles.patterns) {
        if (this.matchedIgnorePatterns.has(pattern)) {
          continue;
        }
        warnings.push(
          `cursorSettingSync.ignoredUserFiles entry "${pattern}" matched no file under the Cursor home directory, so it is excluding nothing. That is expected if the file does not exist yet; otherwise correct the pattern.`,
        );
      }
    }

    return {
      snapshots,
      // Streaming traversal deliberately retains no whole-tree identity set.
      // Therefore absence is not a stable deletion proof; additive-only is
      // safer than unlinking a peer file after a partial/mutating walk.
      deletions: [],
      warnings,
    };
  }

  async apply(input: ResourceApplyInput): Promise<ResourceApplyResult> {
    const relativePath = metadataString(input.metadata, "relativePath");
    if (input.resourceId !== cursorUserResourceId(relativePath)) {
      throw new Error(`Cursor user metadata does not match ${input.resourceId}.`);
    }
    if (!isAllowedCursorRelativePath(relativePath)) {
      throw new Error(`Cursor user path is not allowlisted: ${relativePath}`);
    }
    assertSafeRelativePath(this.paths.cursorHome, relativePath);
    if (this.ignoredFiles.matches(foldResourcePathCase(relativePath, this.platform))) {
      return {
        status: "retained-local",
        semanticHash: await this.localSemanticHash(relativePath, input.resourceId),
      };
    }
    if (isDeletion(input)) {
      await removeFileWithinRoot(this.paths.cursorHome, relativePath);
      return;
    }
    if (input.content.byteLength > generalResourceLimit(this.maxPayloadBytes)) {
      throw new Error(`Cursor user file exceeds the automatic apply work limit: ${input.resourceId}`);
    }
    if (relativePath === "mcp.json" || relativePath === "cli-config.json") {
      parseJsonc(input.content.toString("utf8"), input.resourceId);
    }
    await writeFileAtomicWithinRoot(
      this.paths.cursorHome,
      relativePath,
      input.content,
    );
  }

  private remember(relativePath: string, memo: UserFileMemo): void {
    this.forget(relativePath);
    const content = memo.content;
    const retained =
      content !== undefined && content.byteLength <= MAX_MEMO_FILE_BYTES
        ? memo
        : {
            size: memo.size,
            mtimeMs: memo.mtimeMs,
            ctimeMs: memo.ctimeMs,
            semanticHash: memo.semanticHash,
          };
    const retainedBytes = retained.content?.byteLength ?? 0;
    while (
      this.scanMemo.size >= MAX_MEMO_ENTRIES ||
      this.memoBytes + retainedBytes > MAX_MEMO_TOTAL_BYTES
    ) {
      const oldest = this.scanMemo.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.forget(oldest);
    }
    this.scanMemo.set(relativePath, retained);
    this.memoBytes += retainedBytes;
  }

  private forget(relativePath: string): void {
    const memo = this.scanMemo.get(relativePath);
    if (memo === undefined) {
      return;
    }
    this.scanMemo.delete(relativePath);
    this.memoBytes -= memo.content?.byteLength ?? 0;
  }

  private async localSemanticHash(
    relativePath: string,
    resourceId: string,
  ): Promise<string> {
    try {
      return sha256(
        await readFileWithinRoot(
          this.paths.cursorHome,
          relativePath,
          generalResourceLimit(this.maxPayloadBytes),
        ),
      );
    } catch {
      // An ignored file that cannot be read locally is projected with the
      // deletion marker used for absent resources.
      return sha256(`deleted:${resourceId}`);
    }
  }

  private beginEnumeration(): void {
    this.enumerationActive = true;
    this.enumerationFixedIndex = 0;
    this.enumerationRootIndex = 0;
    this.matchedIgnorePatterns.clear();
    this.enumerationFailure = false;
    // A new whole-tree generation can prove that a previously unretained
    // failure disappeared. Retained failures remain queued until a read
    // succeeds, so resetting only the overflow sentinel is fail-closed.
    this.failedDescriptorOverflow = false;
    // Until this sweep finishes the adapter kind is incomplete, so rebuilding
    // the bounded oversized observations cannot expose an incoming overwrite.
    this.oversized.clear();
    this.oversizedOverflow = false;
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
    descriptor: UserFileDescriptor,
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

  private async discoverIntoPending(
    known: Readonly<Record<string, LocalProjection>>,
    warnings: string[],
    maxPending: number,
    budget: { workItems: number },
    now: number,
  ): Promise<void> {
    const fixed = [this.paths.cursorMcp, this.paths.cursorCliConfig];
    const roots = [
      this.paths.cursorCommands,
      this.paths.cursorSkills,
      this.paths.cursorRules,
    ];
    while (
      this.enumerationActive &&
      this.pendingDescriptors.size < maxPending &&
      budget.workItems > 0
    ) {
      if (this.enumerationFixedIndex < fixed.length) {
        const path = fixed[this.enumerationFixedIndex]!;
        this.enumerationFixedIndex += 1;
        this.progressRevision += 1;
        if (await pathExists(path)) {
          this.addPendingDescriptor(path, warnings);
        }
        continue;
      }
      if (this.enumerationRootIndex >= roots.length) {
        this.enumerationActive = false;
        this.progressRevision += 1;
        const metadataInterval = this.options.metadataIntervalMs ?? 30 * 1000;
        const enumerationInterval =
          this.options.enumerationIntervalMs ?? 5 * 60 * 1000;
        this.nextEnumerationAt =
          now + Math.min(metadataInterval, enumerationInterval);
        return;
      }
      const root = roots[this.enumerationRootIndex]!;
      try {
        this.options.onRootEnumerate?.(root);
        const page = await this.fileTreeWalker.advance(root, {
          maxWorkItems: budget.workItems,
          maxMatches: maxPending - this.pendingDescriptors.size,
          includeFile: (path, _relativePath, observed) => {
            const relativePath = normalizeResourcePath(
              relative(this.paths.cursorHome, path),
            );
            const caseKey = foldResourcePathCase(relativePath, this.platform);
            this.rememberIgnoreMatches(caseKey);
            if (this.ignoredFiles.matches(caseKey)) {
              return false;
            }
            const resourceId = cursorUserResourceId(relativePath);
            if (
              !this.options.forceVerificationResourceIds?.has(resourceId) &&
              projectionMatchesFileIdentity(known[resourceId], observed)
            ) {
              this.oversized.delete(resourceId);
              return false;
            }
            return true;
          },
        });
        budget.workItems -= page.workItems;
        this.options.onEnumerationPage?.({
          workItems: page.workItems,
          matches: page.files.length,
          retainedPathCount: page.retainedPathCount,
        });
        for (const path of page.files) {
          this.addPendingDescriptor(path, warnings);
        }
        if (page.complete) {
          this.enumerationRootIndex += 1;
          this.progressRevision += 1;
          continue;
        }
        return;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        this.enumerationFailure = true;
        this.enumerationRootIndex += 1;
        this.progressRevision += 1;
      }
    }
  }

  private addPendingDescriptor(path: string, warnings: string[]): void {
    const relativePath = normalizeResourcePath(
      relative(this.paths.cursorHome, path),
    );
    const caseKey = foldResourcePathCase(relativePath, this.platform);
    this.rememberIgnoreMatches(caseKey);
    if (this.ignoredFiles.matches(caseKey)) {
      return;
    }
    for (const existing of this.pendingDescriptors.values()) {
      if (
        existing.relativePath !== relativePath &&
        foldResourcePathCase(existing.relativePath, this.platform) === caseKey
      ) {
        warnings.push(
          `Case-insensitive path conflict: ${existing.relativePath} and ${relativePath}`,
        );
        return;
      }
    }
    const resourceId = cursorUserResourceId(relativePath);
    this.pendingDescriptors.set(resourceId, {
      path,
      relativePath,
      resourceId,
    });
  }

  private rememberIgnoreMatches(candidate: string): void {
    if (this.ignoredFiles.patterns.length === 0) {
      return;
    }
    const unmatched = new Set(this.ignoredFiles.unmatched([candidate]));
    for (const pattern of this.ignoredFiles.patterns) {
      if (!unmatched.has(pattern)) {
        this.matchedIgnorePatterns.add(pattern);
      }
    }
  }

  private enumerationScope(): string {
    if (this.enumerationFixedIndex < 2) {
      return "root-files";
    }
    return ["commands", "skills", "rules"][this.enumerationRootIndex] ??
      "cursor-home";
  }
}

/**
 * Builds the `ignoredUserFiles` matcher. Entries are relative Cursor-home
 * paths: `mcp.json`, a directory such as `rules` or `rules/` (which now really
 * does cover everything under it), or a glob such as `rules/*.md`. On Windows
 * and macOS the comparison folds case, the way the filesystem does.
 */
export function normalizeIgnoredUserFiles(
  entries: readonly string[],
  platform: NodeJS.Platform = process.platform,
): IgnoreMatcher {
  const normalized: string[] = [];
  for (const entry of entries) {
    try {
      let path = normalizeResourcePath(entry);
      if (path.startsWith("./")) {
        path = path.slice(2);
      }
      if (path.replace(/\/+$/, "").length === 0) {
        continue;
      }
      normalized.push(path);
    } catch {
      // A malformed ignore entry must not break adapter construction.
    }
  }
  return createIgnoreMatcher(normalized, {
    separator: "/",
    caseFold: isCaseInsensitivePathPlatform(platform),
  });
}

async function fileIdentity(
  path: string,
): Promise<{ size: number; mtimeMs: number; ctimeMs: number } | null> {
  try {
    const info = await stat(path);
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    };
  } catch {
    // Without an identity the file is simply read the slow way.
    return null;
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

function projectionMatchesFileIdentity(
  projection: LocalProjection | undefined,
  observed: BoundedFileTreeStat,
): boolean {
  return (
    projection !== undefined &&
    typeof observed.size === "number" &&
    typeof observed.mtimeMs === "number" &&
    typeof observed.ctimeMs === "number" &&
    projection.sourceFileSize === observed.size &&
    projection.sourceTimestamp === observed.mtimeMs &&
    projection.sourceFileCtimeMs === observed.ctimeMs
  );
}

function foldResourcePathCase(path: string, platform: NodeJS.Platform): string {
  return isCaseInsensitivePathPlatform(platform)
    ? path.toLocaleLowerCase("en-US")
    : path;
}

function cursorUserResourceId(relativePath: string): string {
  return `cursor-user-file/${encodeURIComponent(relativePath)}`;
}

function isAllowedCursorRelativePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return (
    relativePath === "mcp.json" ||
    relativePath === "cli-config.json" ||
    (segments.length > 1 &&
      ["commands", "skills", "rules"].includes(segments[0] ?? ""))
  );
}

function metadataString(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string {
  const value = metadata?.[key];
  if (typeof value !== "string") {
    throw new Error(`Resource metadata is missing ${key}.`);
  }
  return value;
}
