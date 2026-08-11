import { basename, relative } from "node:path";
import { stat } from "node:fs/promises";
import type {
  JsonValue,
  LocalProjection,
  ResourceKind,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeRelativePath,
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
  ResourceScanStatus,
} from "./resource";
import { isDeletion } from "./resource";
import { parseJsonc } from "./jsonc";
import {
  ProfileResourcePathPager,
  profilePathById,
  type ProfileResourcePaths,
} from "./profilePaths";
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

interface ProfileFileCandidate {
  kind: ResourceKind;
  profileId: string;
  path: string;
  relativePath: string;
  validateJsonc: boolean;
}

interface ProfileFileMemo {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Optional body cache; identity and hash remain useful when it is omitted. */
  content?: Buffer;
  semanticHash: string;
}

const MAX_PROFILE_FILE_MEMO_ENTRIES = 64;
const MAX_PROFILE_FILE_MEMO_BYTES = GENERAL_MAX_RETAINED_BYTES_PER_SCAN;
export const PROFILE_HELPER_DIRECTORY_WORK_ITEMS_PER_SCAN = 512;

export interface ProfileFilesAdapterOptions {
  maxResourcesPerScan?: number;
  maxRetainedBytesPerScan?: number;
  maxMetadataChecksPerScan?: number;
  metadataIntervalMs?: number;
  maxEnumerationScopesPerScan?: number;
  maxEnumerationWorkItemsPerScan?: number;
  maxEnumerationMatchesPerScan?: number;
  enumerationIntervalMs?: number;
  now?: () => number;
  onFileRead?: (path: string) => void;
  onMetadataCheck?: (path: string) => void;
  onScopeEnumerate?: (scope: string) => void;
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

interface ActiveProfileEnumeration {
  profile: ProfileResourcePaths;
  fixedIndex: number;
  scopeIndex: number;
}

export class ProfileFilesAdapter implements ResourceAdapter {
  readonly id = "profile-files";
  readonly kinds = [
    "keybindings",
    "snippet",
    "task",
    "prompt",
    "mcp",
  ] as const;
  readonly appliesWhileRunning = true;

  private maxPayloadBytes = DEFAULT_MAX_PAYLOAD_MIB * 1024 * 1024;
  private lastScanStatus: ResourceScanStatus = {
    complete: true,
    deferredResourceIds: [],
  };
  private readonly oversized = new Map<string, GeneralOversizedObservation>();
  private oversizedOverflow = false;
  private readonly pendingCandidates = new Map<string, ProfileFileCandidate>();
  /** Failed candidates retry independently so discovery always has a page. */
  private readonly failedCandidates = new Map<string, ProfileFileCandidate>();
  private failedCandidateOverflow = false;
  private readonly scanMemo = new Map<string, ProfileFileMemo>();
  private scanMemoBytes = 0;
  private readonly fileTreeWalker = new BoundedFileTreeWalker();
  private readonly profilePager = new ProfileResourcePathPager();
  private readonly profileQueue: ProfileResourcePaths[] = [];
  private activeProfile: ActiveProfileEnumeration | null = null;
  private enumerationActive = false;
  private nextEnumerationAt = 0;
  private progressRevision = 0;
  private enumerationFailure = false;

  constructor(
    private readonly paths: CursorPaths,
    private readonly options: ProfileFilesAdapterOptions = {},
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

  /** Closes both resumable directory cursors owned by this adapter. */
  async dispose(): Promise<void> {
    await Promise.all([
      this.fileTreeWalker.clear(),
      this.profilePager.dispose(),
    ]);
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
    this.promoteFailedCandidate(maxPending);
    const budget = {
      workItems:
        this.options.maxEnumerationWorkItemsPerScan ??
        AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN,
      metadataChecks: Math.max(
        1,
        this.options.maxMetadataChecksPerScan ?? 64,
      ),
    };
    const processed = new Set<string>();
    let retainedBytes = 0;
    let verifiedBytes = 0;
    let materialized = 0;
    let canContinue = true;
    while (canContinue) {
      canContinue = false;
      if (
        this.enumerationActive &&
        this.pendingCandidates.size < maxPending &&
        budget.workItems > 0
      ) {
        const before = this.pendingCandidates.size;
        await this.discoverIntoPending(
          known,
          warnings,
          maxPending,
          budget,
          now,
        );
        canContinue ||= this.pendingCandidates.size > before;
      }
      for (const [resourceId, candidate] of this.pendingCandidates) {
        if (processed.has(resourceId) || budget.metadataChecks <= 0) {
          continue;
        }
        processed.add(resourceId);
        budget.metadataChecks -= 1;
        try {
          this.options.onMetadataCheck?.(candidate.path);
          const info = await stat(candidate.path);
          if (!info.isFile()) {
            throw new Error(`Profile resource is not a file: ${candidate.path}`);
          }
          const cached = this.scanMemo.get(resourceId);
          if (
            cached !== undefined &&
            cached.size === info.size &&
            cached.mtimeMs === info.mtimeMs &&
            cached.ctimeMs === info.ctimeMs &&
            !this.options.forceVerificationResourceIds?.has(resourceId) &&
            projectionMatchesSemantic(known[resourceId], cached.semanticHash)
          ) {
            this.scanMemo.delete(resourceId);
            this.scanMemo.set(resourceId, cached);
            this.pendingCandidates.delete(resourceId);
            this.failedCandidates.delete(resourceId);
            this.progressRevision += 1;
            this.oversized.delete(resourceId);
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
            this.pendingCandidates.delete(resourceId);
            this.failedCandidates.delete(resourceId);
            this.progressRevision += 1;
            canContinue = true;
            continue;
          }
          let content: Buffer;
          let semantic: string;
          if (
            cached !== undefined &&
            cached.size === info.size &&
            cached.mtimeMs === info.mtimeMs &&
            cached.ctimeMs === info.ctimeMs &&
            cached.content !== undefined
          ) {
            this.scanMemo.delete(resourceId);
            this.scanMemo.set(resourceId, cached);
            content = cached.content;
            semantic = cached.semanticHash;
          } else {
            if (
              verifiedBytes > 0 &&
              verifiedBytes + info.size > retainedLimit
            ) {
              continue;
            }
            this.options.onFileRead?.(candidate.path);
            content = await readFileWithinRoot(
              this.paths.userDataRoot,
              normalizeResourcePath(
                relative(this.paths.userDataRoot, candidate.path),
              ),
              resourceLimit,
            );
            verifiedBytes += content.byteLength;
            semantic = sha256(content);
            this.rememberFile(resourceId, {
              size: info.size,
              mtimeMs: info.mtimeMs,
              ctimeMs: info.ctimeMs,
              content,
              semanticHash: semantic,
            });
          }
          if (projectionMatchesSemantic(known[resourceId], semantic)) {
            this.pendingCandidates.delete(resourceId);
            this.failedCandidates.delete(resourceId);
            this.progressRevision += 1;
            this.oversized.delete(resourceId);
            canContinue = true;
            continue;
          }
          if (
            materialized >= maxResources ||
            (snapshots.length > 0 && retainedBytes + info.size > retainedLimit)
          ) {
            continue;
          }
          materialized += 1;
          if (candidate.validateJsonc) {
            parseJsonc(content.toString("utf8"), candidate.path);
          }
          snapshots.push({
            resourceId,
            kind: candidate.kind,
            content,
            semanticHash: semantic,
            metadata: {
              profileId: candidate.profileId,
              relativePath: candidate.relativePath,
              lastUpdatedAt: info.mtimeMs,
              sourceFileSize: info.size,
              sourceFileCtimeMs: info.ctimeMs,
            },
          });
          retainedBytes += content.byteLength;
          this.failedCandidates.delete(resourceId);
          // Kept pending until `known` acknowledges the emitted timestamp.
          this.oversized.delete(resourceId);
        } catch (error) {
          this.pendingCandidates.delete(resourceId);
          this.rememberFailedCandidate(resourceId, candidate, maxPending);
          canContinue = true;
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
      this.options.onPendingDescriptorCount?.(
        this.pendingCandidates.size + this.failedCandidates.size,
      );
      if (
        canContinue &&
        budget.metadataChecks > 0 &&
        materialized < maxResources &&
        this.pendingCandidates.size < maxPending
      ) {
        continue;
      }
      break;
    }
    const metadataDeferred = new Set([
      ...this.pendingCandidates.keys(),
      ...this.failedCandidates.keys(),
    ]);
    this.lastScanStatus = {
      complete:
        metadataDeferred.size === 0 &&
        !this.failedCandidateOverflow &&
        !this.oversizedOverflow &&
        !this.enumerationFailure &&
        !this.enumerationActive,
      deferredResourceIds: [
        ...metadataDeferred,
        ...(this.failedCandidateOverflow
          ? ["profile-file-scope/untracked-read-failures"]
          : []),
        ...(this.oversizedOverflow
          ? ["profile-file-scope/untracked-oversized-resources"]
          : []),
        ...(this.enumerationFailure
          ? ["profile-file-scope/unreadable-root"]
          : []),
        ...(this.enumerationActive
          ? [
              `profile-file-scope/${encodeURIComponent(
                this.currentEnumerationScope(),
              )}`,
            ]
          : []),
      ],
      progressToken:
        this.progressRevision + this.fileTreeWalker.progressToken(),
    };
    for (const observation of this.oversized.values()) {
      warnings.push(generalOversizedWarning("Profile file", observation));
    }
    return {
      snapshots,
      // A bounded streaming walk cannot retain a stable whole-tree absence
      // proof. Preserve peer files rather than publishing destructive guesses.
      deletions: [],
      warnings,
    };
  }

  async apply(input: ResourceApplyInput): Promise<void> {
    const profileId = metadataString(input.metadata, "profileId");
    const relativePath = metadataString(input.metadata, "relativePath");
    const expectedResourceId = `${input.kind}/${encodeURIComponent(profileId)}/${encodeURIComponent(relativePath)}`;
    if (input.resourceId !== expectedResourceId) {
      throw new Error(`Profile file metadata does not match ${input.resourceId}.`);
    }
    assertAllowedProfileRelativePath(input.kind, relativePath);
    const root = rootForKind(this.paths, input.kind, profileId);
    const target = assertSafeRelativePath(root, relativePath);
    const targetFromUserData = normalizeResourcePath(
      relative(this.paths.userDataRoot, target),
    );
    if (isDeletion(input)) {
      await removeFileWithinRoot(this.paths.userDataRoot, targetFromUserData);
      return;
    }
    if (input.content.byteLength > generalResourceLimit(this.maxPayloadBytes)) {
      throw new Error(`Profile file exceeds the automatic apply work limit: ${input.resourceId}`);
    }
    if (["keybindings", "snippet", "task", "mcp"].includes(input.kind)) {
      parseJsonc(input.content.toString("utf8"), input.resourceId);
    }
    await writeFileAtomicWithinRoot(
      this.paths.userDataRoot,
      targetFromUserData,
      input.content,
    );
  }

  private beginEnumeration(): void {
    this.enumerationActive = true;
    this.profilePager.restart();
    this.profileQueue.length = 0;
    this.activeProfile = null;
    this.failedCandidateOverflow = false;
    this.enumerationFailure = false;
    this.oversized.clear();
    this.oversizedOverflow = false;
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
    candidate: ProfileFileCandidate,
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

  private async discoverIntoPending(
    known: Readonly<Record<string, LocalProjection>>,
    warnings: string[],
    maxPending: number,
    budget: { workItems: number },
    now: number,
  ): Promise<void> {
    while (
      this.enumerationActive &&
      this.pendingCandidates.size < maxPending &&
      budget.workItems > 0
    ) {
      if (this.activeProfile === null) {
        if (this.profileQueue.length === 0) {
          const maxScopes = this.options.maxEnumerationScopesPerScan ?? 16;
          const page = await this.profilePager.advance(this.paths, {
            maxProfiles: Math.max(1, Math.floor(maxScopes / 2)),
            maxWorkItems: budget.workItems,
          });
          budget.workItems -= page.workItems;
          this.progressRevision += page.workItems;
          this.options.onEnumerationPage?.({
            workItems: page.workItems,
            matches: page.profiles.length,
            retainedPathCount: page.retainedPathCount,
          });
          this.profileQueue.push(...page.profiles);
          if (this.profileQueue.length === 0) {
            if (page.complete) {
              this.finishEnumeration(now);
            }
            return;
          }
        }
        this.activeProfile = {
          profile: this.profileQueue.shift()!,
          fixedIndex: 0,
          scopeIndex: 0,
        };
        this.progressRevision += 1;
      }
      const active = this.activeProfile;
      const fixed: Array<{
        kind: ResourceKind;
        path: string;
        validateJsonc: boolean;
      }> = [
        {
          kind: "keybindings",
          path: active.profile.keybindings,
          validateJsonc: true,
        },
        { kind: "task", path: active.profile.tasks, validateJsonc: true },
        { kind: "mcp", path: active.profile.mcp, validateJsonc: true },
      ];
      if (active.fixedIndex < fixed.length) {
        const file = fixed[active.fixedIndex]!;
        active.fixedIndex += 1;
        this.progressRevision += 1;
        if (await pathExists(file.path)) {
          this.addPendingCandidate({
            ...file,
            profileId: active.profile.profileId,
            relativePath: basename(file.path),
          });
        }
        continue;
      }
      const scopes: Array<{
        kind: "snippet" | "prompt";
        root: string;
        validateJsonc: boolean;
      }> = [
        {
          kind: "snippet",
          root: active.profile.snippets,
          validateJsonc: true,
        },
        {
          kind: "prompt",
          root: active.profile.prompts,
          validateJsonc: false,
        },
      ];
      if (active.scopeIndex < scopes.length) {
        const scope = scopes[active.scopeIndex]!;
        try {
          this.options.onScopeEnumerate?.(
            scanScope(scope.kind, active.profile.profileId),
          );
          const page = await this.fileTreeWalker.advance(scope.root, {
            maxWorkItems: budget.workItems,
            maxMatches: maxPending - this.pendingCandidates.size,
            includeFile: (path, relativePath, observed) => {
              if (
                scope.kind === "snippet" &&
                !/\.(json|code-snippets)$/i.test(path)
              ) {
                return false;
              }
              const candidate: ProfileFileCandidate = {
                kind: scope.kind,
                profileId: active.profile.profileId,
                path,
                relativePath: normalizeResourcePath(relativePath),
                validateJsonc: scope.validateJsonc,
              };
              const resourceId = resourceIdFor(candidate);
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
            this.addPendingCandidate({
              kind: scope.kind,
              profileId: active.profile.profileId,
              path,
              relativePath: normalizeResourcePath(
                relative(scope.root, path),
              ),
              validateJsonc: scope.validateJsonc,
            });
          }
          if (page.complete) {
            active.scopeIndex += 1;
            this.progressRevision += 1;
            continue;
          }
          return;
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
          this.enumerationFailure = true;
          active.scopeIndex += 1;
          this.progressRevision += 1;
          continue;
        }
      }
      this.activeProfile = null;
      this.progressRevision += 1;
      if (
        this.profileQueue.length === 0 &&
        !this.profilePager.active
      ) {
        this.finishEnumeration(now);
      }
    }
  }

  private addPendingCandidate(candidate: ProfileFileCandidate): void {
    this.pendingCandidates.set(resourceIdFor(candidate), candidate);
  }

  private rememberFile(resourceId: string, memo: ProfileFileMemo): void {
    const previous = this.scanMemo.get(resourceId);
    if (previous !== undefined) {
      this.scanMemoBytes -= previous.content?.byteLength ?? 0;
      this.scanMemo.delete(resourceId);
    }
    const content = memo.content;
    const retained =
      content !== undefined && content.byteLength <= MAX_PROFILE_FILE_MEMO_BYTES
        ? memo
        : {
            size: memo.size,
            mtimeMs: memo.mtimeMs,
            ctimeMs: memo.ctimeMs,
            semanticHash: memo.semanticHash,
          };
    const retainedBytes = retained.content?.byteLength ?? 0;
    while (
      this.scanMemo.size >= MAX_PROFILE_FILE_MEMO_ENTRIES ||
      this.scanMemoBytes + retainedBytes > MAX_PROFILE_FILE_MEMO_BYTES
    ) {
      const oldest = this.scanMemo.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      const removed = this.scanMemo.get(oldest);
      this.scanMemo.delete(oldest);
      if (removed !== undefined) {
        this.scanMemoBytes -= removed.content?.byteLength ?? 0;
      }
    }
    this.scanMemo.set(resourceId, retained);
    this.scanMemoBytes += retainedBytes;
  }

  private finishEnumeration(now: number): void {
    this.enumerationActive = false;
    this.progressRevision += 1;
    const metadataInterval = this.options.metadataIntervalMs ?? 30 * 1000;
    const enumerationInterval =
      this.options.enumerationIntervalMs ?? 5 * 60 * 1000;
    this.nextEnumerationAt =
      now + Math.min(metadataInterval, enumerationInterval);
  }

  private currentEnumerationScope(): string {
    const active = this.activeProfile;
    if (active === null) {
      return "profiles";
    }
    return active.scopeIndex === 0
      ? `profile/${active.profile.profileId}`
      : scanScope(
          active.scopeIndex === 1 ? "snippet" : "prompt",
          active.profile.profileId,
        );
  }
}

function scanScope(kind: ResourceKind, profileId: string): string {
  return `${kind}/${profileId}`;
}

function assertAllowedProfileRelativePath(
  kind: ResourceKind,
  relativePath: string,
): void {
  const exact: Partial<Record<ResourceKind, string>> = {
    keybindings: "keybindings.json",
    task: "tasks.json",
    mcp: "mcp.json",
  };
  const expected = exact[kind];
  if (expected !== undefined && relativePath !== expected) {
    throw new Error(`Unexpected ${kind} path: ${relativePath}`);
  }
  if (
    kind === "snippet" &&
    !/\.(json|code-snippets)$/i.test(relativePath)
  ) {
    throw new Error(`Unexpected snippet path: ${relativePath}`);
  }
}

function resourceIdFor(candidate: ProfileFileCandidate): string {
  return `${candidate.kind}/${encodeURIComponent(candidate.profileId)}/${encodeURIComponent(
    candidate.relativePath,
  )}`;
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

function rootForKind(
  paths: CursorPaths,
  kind: ResourceKind,
  profileId: string,
): string {
  const profile = profilePathById(paths, profileId);
  switch (kind) {
    case "snippet":
      return profile.snippets;
    case "prompt":
      return profile.prompts;
    case "keybindings":
    case "task":
    case "mcp":
      return profile.root;
    default:
      throw new Error(`Unsupported profile file kind: ${kind}`);
  }
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
