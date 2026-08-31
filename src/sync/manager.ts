import { basename, isAbsolute, join, relative } from "node:path";
import type { Dirent } from "node:fs";
import {
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  APPLY_FAILURE_BLOCK_PREFIX,
  AUTOMATIC_CHECKPOINT_COOLDOWN_MS,
  AUTOMATIC_CHECKPOINT_EVENT_THRESHOLD,
  BACKUP_DIRECTORY,
  COMMAND_LOCK_WAIT_MS,
  CONFLICT_APPLY_LOCK_WAIT_MS,
  CONFLICTED_REPUBLISH_INTERVAL_MS,
  CHECKPOINT_EXTENSION,
  EVENT_EXTENSION,
  LOCK_SKIP_REMINDER_MS,
  MAX_HELPER_APPLY_WORK_BYTES,
  MAX_RUNNING_APPLY_PAYLOAD_BYTES,
  QUIT_START_GRACE_MS,
  REPOSITORY_FILE,
  RESTART_TO_APPLY_COMMAND,
  RESTART_TO_APPLY_HEARTBEAT_MS,
  RESTART_TO_APPLY_TITLE,
  SLOW_SYNC_CYCLE_MS,
  SYNC_INDICATOR_DELAY_MS,
} from "../constants";
import type {
  AbsorbedCheckpoint,
  CheckpointManifest,
  CompatibilityReport,
  DiagnosticSnapshot,
  EventProducer,
  JsonValue,
  LocalProjection,
  MergeOutcome,
  PendingDatabaseChange,
  ResourceChange,
  ResourceDeletion,
  ResourceKind,
  ResourceOperation,
  ResourceSnapshot,
  ResourceTip,
  ResourceVersionSummary,
  StreamCursor,
  SyncConflict,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  openDatabase,
  type DatabaseSync,
} from "../platform/sqlite";
import {
  copyFileAtomic,
  directorySize,
  ensureDirectory,
  isMissingPathError,
  listFilesRecursively,
  pathExists,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/files";
import {
  acquireFileLock,
  acquireFileLockWithin,
  reportLockHolder,
} from "../platform/lock";
import type { FileLock, LockHolderReport } from "../platform/lock";
import {
  GitError,
  clearCloneStaging,
  cloneRepository,
  commitAndPush,
  detectGit,
  initRepository,
  isGitRepository,
  largeFileWarnings,
  pullLatest,
  squashHistory,
} from "../platform/git";
import type { GitErrorKind, SquashHistoryResult } from "../platform/git";
import {
  assertCompatibleForDatabaseWrite,
  databaseApplyBlockReason,
  isDatabaseBackedKind,
} from "../platform/compatibility";
import type { ExtensionConfiguration } from "../config";
import {
  readRepositoryManifest,
  SyncRepository,
} from "../protocol/repository";
import type {
  CheckpointCreateResult,
  PruneResult,
  ResourceHistoryEntry,
} from "../protocol/repository";
import {
  EventReconciler,
  compareTips,
  parentsForLocalChange,
  type ReconcileResult,
  type ResourceProjection,
} from "../protocol/reconciler";
import {
  disposeResourceAdapters,
  type ResourceAdapter,
  type ResourceApplyInput,
  type ResourceApplyResult,
} from "../resources/resource";
import {
  DEFAULT_IGNORED_SETTINGS,
  SettingsAdapter,
  collectMachineScopedSettings,
  createSettingsIgnoreMatcher,
} from "../resources/settings";
import { ProfileFilesAdapter } from "../resources/profileFiles";
import {
  CursorUserFilesAdapter,
  normalizeIgnoredUserFiles,
} from "../resources/cursorUserFiles";
import { ProfilesAdapter } from "../resources/profiles";
import { UiStateAdapter } from "../resources/uiState";
import { mergeUiStateBuffers } from "../resources/uiStateMerge";
import {
  normalizeIgnoredUiStateKeys,
} from "../resources/uiStatePolicy";
import {
  ExtensionsAdapter,
  createExtensionIgnoreMatcher,
} from "../resources/extensions";
import {
  WorkspaceStorageAdapter,
  isIgnoredWorkspaceUri,
  isWorkspaceNotepadsPath,
  isWorkspaceStateDatabasePath,
} from "../resources/workspaceStorage";
import {
  mergeNotepadBuffers,
  unionNotepadBuffers,
} from "../resources/notepadMerge";
import { mergeRemoteTargetsBuffers } from "../resources/remoteTargets";
import { filterPortableWorkspaceRows } from "../resources/workspaceStatePolicy";
import {
  createIgnoreMatcher,
  type IgnoreMatcher,
} from "../resources/ignorePatterns";
import {
  StateVscdbChatAdapter,
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  type PortableAgentKvPayload,
  type PortableKvRow,
} from "../chat/stateVscdb";
import { AGENT_KV_BLOB_PREFIX } from "../chat/agentKv";
import { verifyPortableChatContinuationClosure } from "../chat/continuationClosure";
import {
  CHAT_AUTO_MERGE_MAX_WORK_BYTES,
  extractBoundedChatCoreAgentKvRoots,
  mergeChatSnapshotBuffers,
} from "../chat/chatMerge";
import { ChatTranscriptsAdapter } from "../chat/transcripts";
import { StoreDbChatAdapter } from "../chat/storeDb";
import { chatHeaderTitle, chatSnapshotTitle } from "../chat/title";
import {
  buildChatTipEnrichmentCandidateIndex,
  enrichCurrentChatTipsFromLiveDatabase,
  type ChatTipEnrichmentCandidate,
  type ChatTipEnrichmentCursor,
} from "../chat/enrichment";
import {
  DEFAULT_BROKEN_CHAT_INSPECTION_LIMITS,
  buildChatRepairSnapshot,
  composerCursorFromStorageClass,
  composerCursorStorageClass,
  inspectBrokenChatContinuationsInDatabase,
  inspectBrokenCursorChatContinuations,
  inspectBrokenCursorChats,
  isAutomaticChatRepairMetadata,
  type BrokenChatObservation,
  type BrokenChatContinuationObservation,
  type BrokenChatInspectionCursor,
  type ChatContinuationUnknownReasonCounts,
  type ChatRepairCandidate,
  type ComposerIdStorageClass,
} from "../chat/repair";
import {
  extractVisibleChatRecoveryTranscript,
  prepareVisibleRecoveryAgent,
  writeVisibleChatRecoveryArtifact,
  type VisibleChatRecoveryArtifact,
  type VisibleChatRecoveryTranscript,
} from "../chat/visibleRecovery";
import {
  RECOVERY_CATALOG_LIMITS,
  RecoveryCatalogInventoryCancelledError,
  RecoveryCatalogLimitError,
  acquireRecoveryCatalogBuildSession,
  readRecoveryCatalog,
  recoveryCatalogEntryArtifactPaths,
  upsertRecoveryCatalogEntries,
  type RecoveryCatalogReadyEntry,
  type RecoveryCatalogBuildSession,
  type RecoveryCatalogLimitReason,
  type RecoveryCatalogResult,
  type RecoveryCatalogStatus,
  type RecoveryCatalogUpsertInput,
} from "../chat/recoveryCatalog";
import {
  RecoveryStagingError,
  stageRecoveryArtifacts,
  verifyStagedRecovery,
  type RecoveryStagingBridge,
  type RecoveryStagingResult,
  type RecoveryStagingSource,
  type RecoveryStagingUri,
} from "../chat/recoveryStaging";
import {
  WORKSPACE_IDENTITY_LOOKUPS_PER_PAGE,
  discoverWorkspacesDetailed,
  lookupWorkspaceIdentitiesById,
  resolveTargetWorkspace,
  type WorkspaceIdentity,
  workspaceUriMatchesAny,
} from "../chat/workspace";
import { HelperLauncher } from "../helper/launcher";
import type {
  FinalizerReplaceOutcome,
  HelperSyncOptions,
} from "../helper/launcher";
import type { HelperRequest } from "../helper/types";
import type { DatabaseContract } from "../helper/database";
import type { HelperChange, HelperResult } from "../helper/types";
import {
  mergeWorkspaceDatabaseSnapshots,
  parseWorkspaceDatabaseSnapshot,
  serializeWorkspaceDatabaseSnapshot,
  unionWorkspaceDatabaseSnapshots,
} from "../helper/workspaceDatabaseMerge";
import type { StatusController, SyncStatus } from "../ui/status";
import type {
  ConflictController,
  ConflictResolutionResult,
} from "../ui/conflicts";
import {
  buildRestoreKindChoices,
  buildRestoreResourceChoices,
  buildRestoreScopeChoices,
  restorablePutVersions,
  restoreTargetIsUnchanged,
  restoreKindLabel,
  type RestoreResourceDescriptor,
} from "../ui/resourceHistory";
import { mergeJsoncBuffers, parseJsonc } from "../resources/jsonc";
import { mergeTextBuffers } from "../resources/text";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import { buffersFitJsonStructureBudget } from "../protocol/jsonStructure";
import {
  isRepositoryPayloadFile,
  repositoryPayloadFileName,
} from "./watch";
import {
  createRepositoryWatcher,
  type RepositoryWatcher,
} from "./repositoryWatcher";
import {
  absorbedCheckpointManifest,
  effectiveSyncOrigin,
  effectiveTipProducer,
  effectiveVersionProducer,
  filterPublishableChanges,
  formatBytes,
  isSyntheticTip,
  oversizedPayloadWarning,
  producerAsMetadata,
  publishInBatches,
  shouldPublishSnapshot,
} from "./versionPolicy";
import {
  chatContinuationApplyBlockReason,
  INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON,
} from "./chatContinuationPolicy";
export {
  chatContinuationApplyBlockReason,
  INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON,
} from "./chatContinuationPolicy";
import {
  isOfflineApplyExcludedIncomingResource,
  isPolicyExcludedUiStateResource,
} from "./incomingResourcePolicy";
export { isUnscannableIncomingResource } from "./incomingResourcePolicy";
import { assertSafeRepositoryLocation } from "./repositoryPath";
import {
  AUTO_MERGE_WARNING_SOURCE,
  HELPER_WARNING_SOURCE,
  PUBLISH_WARNING_SOURCE,
  RECONCILER_WARNING_SOURCE,
  StandingWarningRegistry,
  formatWarningLine,
  isPublishWarningSource,
  publishWarningSource,
  standingWarningDiagnostics,
} from "./warningLog";
import { SyncCycleQueue } from "./cycleQueue";
import type { SyncScope } from "./cycleQueue";
import { BackgroundCoordinator } from "./backgroundCoordinator";
import { createPollPlan, type PollPlanEntry } from "./pollPlan";
import {
  PERMANENT_EXCLUSION_REASONS,
  isChatResourceKind,
  isPermanentExclusionReason,
  resourceConfigurationBlockReason,
} from "./resourcePolicy";

const LAST_HELPER_BACKUPS_KEY = "lastHelperBackups";
const ALWAYS_RELEVANT_FINALIZER = (): boolean => true;
const LIVE_APPLY_PAYLOAD_BLOCK_PREFIX =
  "This resource exceeds the live apply memory limit";
const HISTORY_PREVIEW_MAX_PAYLOAD_BYTES = 1024 * 1024;
const RESTORE_VERSION_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
/**
 * Git repositories need a remote probe because a fetch does not produce a
 * filesystem event until it updates the worktree. Doing that probe on every
 * thirty-second resource poll, however, turns an idle extension into a steady
 * stream of git processes and network requests. User commands still force a
 * pull; this only spaces the fallback background probe.
 */
export const BACKGROUND_GIT_PULL_INTERVAL_MS = 5 * 60_000;
const OPEN_LOCK_WAIT_SLICE_MS = 1_000;
const OPEN_LOCK_LOG_INTERVAL_MS = 60_000;

export interface BackgroundGitPullAttempt {
  root: string;
  attemptedAt: number;
}

interface StoredHelperBackup {
  backupPath: string;
  contract: DatabaseContract;
  targetPath: string;
  recordedAt: string;
}

interface PlannedChatRepair {
  resourceId: string;
  label: string;
  expectedTipIds: string[];
  fingerprint: string;
  /** Newest-first trusted candidates through and including the complete source. */
  candidateVersions: Array<{ versionId: string; plainBytes: number }>;
  sourceVersionId: string;
  repairedBubbleCount: number;
}

interface ChatRepairAuditProgress {
  examinedChats: number;
  unavailableWithoutSource: number;
  oversizedChats: number;
  historyBudgetDeferred: number;
  unresolvedLimitReached: boolean;
}

/**
 * Runs a state-mutating repository open only after its machine-wide lock is
 * actually held.
 *
 * Each acquisition attempt may itself wait for a bounded interval so callers
 * can report progress, but a timeout starts another attempt rather than
 * silently converting the operation into an unlocked write. An operational
 * acquire error is deliberately propagated: failing closed is safer than the
 * stale-state overwrite this guard exists to prevent.
 */
export async function withRequiredFileLock<T>(
  acquire: () => Promise<FileLock | null>,
  run: () => Promise<T>,
  shouldContinue: () => boolean = () => true,
): Promise<T> {
  for (;;) {
    if (!shouldContinue()) {
      throw new Error("Repository opening was cancelled before the synchronization lock became available.");
    }
    const lock = await acquire();
    if (lock === null) {
      continue;
    }
    if (!shouldContinue()) {
      await lock.release();
      throw new Error("Repository opening was cancelled before the synchronization lock became available.");
    }
    try {
      return await run();
    } finally {
      await lock.release();
    }
  }
}

/** Whether the fallback background Git probe is due for this repository. */
export function backgroundGitPullDue(
  previous: BackgroundGitPullAttempt | null,
  root: string,
  now: number,
  intervalMs = BACKGROUND_GIT_PULL_INTERVAL_MS,
): boolean {
  return (
    previous === null ||
    previous.root !== root ||
    now < previous.attemptedAt ||
    now - previous.attemptedAt >= intervalMs
  );
}

export interface AdapterScanIndex {
  snapshots: Map<string, ResourceSnapshot>;
  deletions: Map<string, ResourceDeletion>;
  complete: boolean;
  deferredResourceIds: Set<string>;
}

export type SyntheticApplyDecision =
  | { action: "apply" }
  | { action: "already-applied"; live: ResourceSnapshot }
  | { action: "drift" };

interface PendingWorkspaceMappingChoice {
  sourceWorkspaceId: string;
  sourceWorkspaceUri: string;
}

interface WorkspaceMappingSelection extends PendingWorkspaceMappingChoice {
  automatic: boolean;
  targetWorkspaceId: string;
  targetWorkspaceUri: string;
}

interface WorkspaceMappingPassResult {
  automaticMappings: number;
  localWorkspaces: WorkspaceIdentity[];
  mappingStateChanged: boolean;
  pendingWorkspaceStorage: number;
  unreadableLocalWorkspaceIds: string[];
  unreadableLocalWorkspaces: number;
  unresolved: PendingWorkspaceMappingChoice[];
}

interface CollectedWorkspaceMappings {
  selections: WorkspaceMappingSelection[];
  skipped: number;
}

export class SyncManager implements vscode.Disposable {
  private repository: SyncRepository | null = null;
  private masterKey: Buffer | null = null;
  /** Invalidates a configured deferred-open that a newer lifecycle won. */
  private configuredOpenGeneration = 0;
  /**
   * Coalesces leadership and command activation for one configured repository.
   * A manual command can arrive while the elected background window is still
   * unlocking; without this seam both paths read and parse the same (possibly
   * very large) local-state file before one of them loses the generation race.
   */
  private configuredOpenInFlight: {
    root: string;
    repositoryId: string | null;
    promise: Promise<boolean>;
  } | null = null;
  private adapters: ResourceAdapter[] = [];
  /** Active operations that may still hold one adapter generation's cursors. */
  private adapterUseCount = 0;
  private readonly adapterUseIdleResolvers: Array<() => void> = [];
  /** Blocks new users while queued adapter generations are being retired. */
  private adapterReplacementBarrier: Promise<void> | null = null;
  private repositoryWatcher: RepositoryWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private chatPollTimer: NodeJS.Timeout | null = null;
  private watcherDebounce: NodeJS.Timeout | null = null;
  private automaticSyncRequest: Promise<void> | null = null;
  /** Only one Cursor window owns repository watches and automatic polling. */
  private readonly backgroundCoordinator: BackgroundCoordinator;
  private finalizerRetryTimer: NodeJS.Timeout | null = null;
  private finalizerRetryGuard: (() => boolean) | null = null;
  private reconnectProbeTimer: NodeJS.Timeout | null = null;
  /** The nonce of the apply/restore claim this window currently holds. */
  private activeApplyClaim: string | null = null;
  private finalizerStartInFlight: Promise<void> | null = null;
  private finalizerRestartRequested = false;
  private finalizerRestartGuard: (() => boolean) | null = null;
  /** Resources whose payload has not crossed the shared folder yet, to log once. */
  private readonly deferredApplyNoted = new Set<string>();
  private readonly cycles = new SyncCycleQueue({
    runCycle: async (manual, scope) => {
      const startedAt = Date.now();
      try {
        await this.withAdapterUse(() => this.performSync(manual, scope));
      } finally {
        const took = Date.now() - startedAt;
        if (took >= SLOW_SYNC_CYCLE_MS) {
          // Silent otherwise, and it is the number that explains a repository
          // where commands wait on the lock and the CPU never idles: a cycle
          // longer than the poll interval means the next one starts the
          // moment this ends.
          this.status.log(
            `Synchronization cycle (${scope}) took ${formatDuration(took)}.`,
          );
        }
      }
    },
    runMaintenance: () => this.runRequestedMaintenance(),
    onAutomaticFailure: (error: unknown) => {
      this.status.log(
        `Queued automatic synchronization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });
  private readonly helper: HelperLauncher;
  private readonly producer: EventProducer;
  private readonly historyDocuments = new Map<string, string>();
  private readonly historyPreviewRegistration: vscode.Disposable;
  private readonly gitWarningsShown = new Set<GitErrorKind>();
  /** The LAST git window's outcome; recovers on success, unlike the toast set. */
  private lastGitWindowDegraded = false;
  /** Last remote probe, shared by both background poll scopes in this window. */
  private backgroundGitPullAttempt: BackgroundGitPullAttempt | null = null;
  /** Avoids a `git rev-parse` subprocess on every throttled background poll. */
  private backgroundGitModeCheck: {
    root: string;
    checkedAt: number;
    active: boolean;
  } | null = null;
  /** A known-diverged worktree must stay fail-closed until a pull succeeds. */
  private readonly backgroundGitConflicts = new Map<string, GitError>();
  private readonly warnings = new StandingWarningRegistry();
  /**
   * Deliberate exclusions, kept in their own registry.
   *
   * Sharing the one above meant `standingFor` counted them, `settledStatus`
   * turned amber on them, and a device that had done nothing but accept the
   * defaults read "Partial - some resources were not saved to the repository"
   * on every cycle for as long as it stayed configured that way. The user still
   * has to be able to find out why a workspace or a settings key stopped
   * travelling, so they are logged and listed - just never counted.
   */
  private readonly notices = new StandingWarningRegistry();
  /**
   * Resource id -> epoch ms of the last time this device republished its own
   * tip while that resource was in an unresolved conflict. See
   * {@link throttleConflictedRepublish}. Deliberately in memory only: the loop
   * it bounds is a steady state inside one long-lived extension host, and a
   * window reload costs at most one extra event per conflicted resource, which
   * is not worth a local-state schema change and its migration.
   */
  private readonly conflictedRepublishAt = new Map<string, number>();
  private syncIndicatorTimer: NodeJS.Timeout | null = null;
  /** The run of consecutive polls that could not take the sync lock, if any. */
  private lockSkip: LockSkipState | null = null;
  /**
   * The last offline-helper failure nothing has superseded.
   *
   * A bare `setStatus("error", ...)` did not survive one cycle: `updateStatus`
   * runs in performSync's finally block and rebuilds the status from repository
   * state alone, so a failed "Restart to Apply" was repainted with the queue
   * that same failure had left behind - the command that had just failed,
   * offered again as if nothing happened. In memory only: the result file is
   * deleted on consumption, so nothing could re-derive it after a reload, and
   * the retry it asks for is what clears it.
   */
  private helperFailure: string | null = null;
  /**
   * Whether the previous shutdown apply was cut short by Cursor reopening.
   * Re-enables the queued-apply offer for this session; see where it is read.
   */
  private shutdownApplyInterrupted = false;
  /** Launch-time queue offer waits until deferred state has been refreshed. */
  private launchApplyOfferPending = false;
  /**
   * Whether the queued-apply offer has already been turned down this session.
   *
   * The offer is shown once per window launch and never again after a "no": it
   * exists to make the queue impossible to miss, not to argue about it. Nothing
   * persists it, so the next launch asks again - which is right, because the
   * queue is still there and the answer "not now" was about now.
   */
  private queuedApplyDeclined = false;
  private automaticMaintenanceAt = 0;
  /** Round-robin and no-op suppression for the bounded v1 -> v2 chat sweep. */
  private chatTipEnrichmentCursor: ChatTipEnrichmentCursor = {
    afterResourceId: null,
  };
  private readonly chatTipEnrichmentAttempts = new Map<string, string>();
  private chatTipEnrichmentIndex: {
    repository: SyncRepository;
    sharedGraphGeneration: number;
    candidates: ChatTipEnrichmentCandidate[];
  } | null = null;
  private readonly eventReconciler = new EventReconciler();
  private readonly adapterScanCursorByScope = new Map<SyncScope, string>();
  /**
   * Reconciliation is a graph compile over the complete accepted event log.
   * Keep the exact result while neither the authenticated shared graph nor
   * local state changed; an idle poll can then avoid iterating thousands of
   * immutable events merely to rebuild the same tips and conflicts.
   */
  private reconciliationCache: {
    repository: SyncRepository;
    sharedGraphGeneration: number;
    reconciliationInputGeneration: number;
    result: ReconcileResult;
  } | null = null;
  private maintenanceRequested = false;
  private largeFileCheckAt = 0;
  private disposed = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly paths: CursorPaths,
    private readonly compatibility: CompatibilityReport,
    private readonly configuration: ExtensionConfiguration,
    private readonly status: StatusController,
    private readonly conflicts: ConflictController,
  ) {
    this.helper = new HelperLauncher(paths, compatibility);
    this.backgroundCoordinator = new BackgroundCoordinator({
      acquire: () => acquireFileLock(this.backgroundRoleLockPath()),
      activate: async (runInitialSync, isCurrent) => {
        // Standby windows deliberately carry no SyncRepository. Only the
        // elected owner pays for reading, parsing and hashing local state.
        if (!(await this.ensureConfiguredRepositoryOpen()) || !isCurrent()) {
          return;
        }
        // The shutdown finalizer is machine-wide too. Only the elected window
        // replaces it, avoiding one cancel/wait/spawn sequence per open window.
        await this.startFinalizer(isCurrent);
        if (!isCurrent()) {
          return;
        }
        if (runInitialSync) {
          await this.syncNow(false);
          if (!isCurrent()) {
            return;
          }
        }
        this.startBackgroundRuntime(isCurrent);
      },
      deactivate: () => this.disposeBackgroundRuntime(),
      onError: (error) => {
        this.status.log(
          `Background coordinator failed: ${
            error instanceof Error ? error.message : String(error)
          }. Retrying shortly.`,
        );
      },
    });
    this.producer = {
      extensionVersion: compatibility.extensionVersion,
      cursorVersion: compatibility.cursorVersion,
      vscodeVersion: compatibility.vscodeVersion,
    };
    this.historyPreviewRegistration =
      vscode.workspace.registerTextDocumentContentProvider(
        "cursor-sync-history",
        {
          provideTextDocumentContent: (uri) =>
            this.historyDocuments.get(uri.toString()) ??
            "History content is unavailable.",
        },
      );
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.paths.extensionStorage);
    await this.consumeHelperResults();
    if (this.configuration.repositoryPath === null) {
      this.status.setStatus("unconfigured");
      return;
    }
    const masterKey = await this.configuration.getMasterKey();
    if (masterKey === null) {
      this.status.setStatus("locked");
      return;
    }
    // This is only an availability check. Holding the decoded key or opening
    // local state in every restored Cursor window defeats leader election's
    // memory bound; the elected owner (or an explicit command) opens later.
    masterKey.fill(0);
    if (!this.configuration.enabled) {
      // Configured, unlocked, and deliberately paused. Leaving the constructor
      // default in place made the status bar read "Setup" on every restart and
      // sent a click into the first-run wizard.
      this.status.setStatus("disabled");
      return;
    }
    this.launchApplyOfferPending = true;
    await this.startWatching(true);
    await this.maybeOfferQueuedApplyAtLaunch();
  }

  async configurationChanged(): Promise<void> {
    await this.refreshAdapters();
    if (this.repository !== null) {
      this.syncRepositoryLimit(this.repository);
    }
    if (!this.configuration.enabled) {
      await this.backgroundCoordinator.stop();
      await this.helper.cancelFinalizers();
      this.status.setStatus("disabled");
      return;
    }
    await this.startWatching(true);
    await this.maybeOfferQueuedApplyAtLaunch();
  }

  async setup(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Use as Cursor Setting Sync folder",
      title: "Select a OneDrive, Syncthing, or other shared folder",
    });
    const root = selected?.[0]?.fsPath;
    if (root === undefined) {
      return;
    }
    await ensureDirectory(root);
    await assertSafeRepositoryLocation(root, this.synchronizedSourceRoots());
    const repositoryPath = join(root, REPOSITORY_FILE);
    let exists = await pathExists(repositoryPath);
    let action: "join" | "create" | "cancel";
    let preparedGitRoot: string | null = null;
    if (!exists) {
      // A folder holding only debris from this machine's earlier failed
      // clone must count as empty, or the clone path is unreachable forever
      // and the picker below offers only creating a DIVERGENT repository.
      await clearCloneStaging(root);
    }
    if (exists) {
      action = "join";
    } else if ((await readdir(root)).length === 0) {
      if (!(await this.prepareEmptyRepositoryFolder(root))) {
        return;
      }
      // A clone can materialize an existing repository into the empty folder.
      exists = await pathExists(repositoryPath);
      action = exists ? "join" : "create";
      if (await pathExists(join(root, ".git"))) {
        preparedGitRoot = root;
      }
    } else {
      action = await vscode.window.showQuickPick(
        [
          {
            label: "$(new-folder) Create encrypted repository",
            value: "create" as const,
          },
          {
            label: "$(close) Cancel",
            value: "cancel" as const,
          },
        ],
        { title: "No repository exists in the selected folder" },
      ).then((item) => item?.value ?? "cancel");
    }
    if (action === "cancel") {
      return;
    }

    const passphrase = await vscode.window.showInputBox({
      title: exists ? "Unlock synchronization repository" : "Create repository passphrase",
      prompt:
        "Use the same passphrase on every PC. Leave it empty to skip the passphrase. It is not stored in the shared folder.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.length === 0 || value.length >= 12
          ? undefined
          : "Use at least 12 characters, or leave it empty for no passphrase.",
    });
    if (passphrase === undefined) {
      return;
    }
    if (!exists && passphrase.length === 0) {
      const proceed = "Create without a passphrase";
      const confirmed = await vscode.window.showWarningMessage(
        "Without a passphrase, the encryption key is stored inside the repository, next to the data. Anyone who can read the shared folder or git remote can then decrypt everything. Only skip the passphrase for a private local folder or a fully trusted private remote.",
        { modal: true },
        proceed,
      );
      if (confirmed !== proceed) {
        return;
      }
    }

    // The replacement is opened before anything running is torn down. Setup
    // used to dispose the runtime and zero the master key first, so a wrong
    // passphrase on a re-run left sync silently stopped with a zeroed but
    // non-null key still in place - which a later Restart to Apply would quit
    // Cursor for and hand to the helper as an all-zero key.
    let openedRepository: SyncRepository;
    try {
      openedRepository = await this.withProgress(
        "Cursor Setting Sync: Setup or Reconfigure",
        async (report) => {
          report(
            exists
              ? "Unlocking the repository (deriving the encryption key)..."
              : "Creating the repository (deriving the encryption key)...",
          );
          return this.withOpenLock(() =>
            exists
              ? SyncRepository.open(
                  root,
                  this.paths.extensionStorage,
                  passphrase,
                  this.configuration.maxPayloadBytes,
                  this.producer,
                )
              : SyncRepository.create(
                  root,
                  this.paths.extensionStorage,
                  passphrase,
                  this.configuration.maxPayloadBytes,
                  this.producer,
                ),
          );
        },
      );
    } catch (error) {
      // Leaving the git shell behind would make the folder non-empty, so a
      // retry could never reach the storage-mode picker again. The running
      // state was never touched, so the previous repository - if any - keeps
      // synchronizing exactly as before this attempt.
      if (preparedGitRoot !== null) {
        await rm(join(preparedGitRoot, ".git"), {
          recursive: true,
          force: true,
        });
      }
      throw error;
    }
    ++this.configuredOpenGeneration;
    await this.backgroundCoordinator.stop();
    try {
      // A polling cycle can already be past its timer callback when teardown
      // closes the runtime. Let it finish against the old repository before
      // replacing the repository and key underneath it.
      await this.cycles.settled();
    } catch {
      // The cycle reported its own failure; Setup can still install the newly
      // opened repository and let its explicit first sync report live errors.
    }
    this.masterKey?.fill(0);
    this.repository = openedRepository;
    this.masterKey = Buffer.from(this.repository.masterKey);
    await this.configuration.setRepository(
      root,
      this.repository.repository.repositoryId,
      this.masterKey,
    );
    // The swap starts this repository's story fresh, the same trade
    // Disconnect->Setup already makes: the old repository's latched failure
    // must not paint the new one red, a decline given to the OLD queue must
    // not suppress the setup-time offer for the new one, and the old
    // repository's standing helper warnings must not report the NEW one as
    // "Partial" for the rest of the session (no cycle on the new repository
    // ever re-observes that bucket; the sync below re-derives live ones).
    this.helperFailure = null;
    this.notices.clear();
    this.warnings.clear();
    this.queuedApplyDeclined = false;
    // Reconnecting also supersedes any standing disconnect marker for this
    // repository, so sibling windows resume normally.
    await rm(
      this.disconnectMarkerPath(this.repository.repository.repositoryId),
      { force: true },
    ).catch(() => {});
    await this.refreshAdapters();
    await this.withProgress("Cursor Setting Sync: Setup or Reconfigure", async (report) => {
      if (await this.gitModeFor(root)) {
        report("Committing the initial repository...");
        await this.commitGitWindow(true, root, "initial sync repository");
      }
      report("Scanning local resources and synchronizing...");
      try {
        await this.syncNow(true);
      } catch (error) {
        // The first sync failing (a OneDrive hiccup, one unreadable file)
        // must not leave the freshly configured session with no shutdown
        // exporter and no polling until the next launch: arm and watch, then
        // surface the sync error as what it is.
        await this.startWatching();
        throw error;
      }
    });
    await this.startWatching();
    const configured =
      'Cursor Setting Sync is configured. The check mark confirms a local shared-folder write, not OneDrive cloud upload completion. The encrypted sync set includes ~/.cursor/mcp.json and cli-config.json, which may contain API keys - add them to "cursorSettingSync.ignoredUserFiles" to keep them on this device only.';
    // Also to the channel: the offer below can quit Cursor within seconds, and
    // this notice names files that may carry API keys.
    this.status.log(configured);
    void vscode.window.showInformationMessage(configured);
    this.launchApplyOfferPending = false;
    await this.offerQueuedApply("setup");
  }

  /**
   * Offers to apply the queue, after setup and again on every launch that finds
   * one waiting.
   *
   * A computer that has just joined necessarily has a full queue - extensions,
   * profiles, chats and UI state all arrive at once, and none of them can be
   * written while Cursor runs. Ending setup with a toast and leaving the user
   * to discover a second command is the friction people report: they set the
   * thing up, nothing appears, and nothing says why.
   *
   * The launch case is the same failure one restart later, and it was the worse
   * one, because the user has every reason to believe they already did the
   * thing. Quitting and reopening Cursor is exactly what the queue is waiting
   * for and exactly what does not drain it - only the command does - so a
   * device could sit at "Queued" indefinitely while its owner restarted over
   * and over. Nothing else was going to say so: the status item deliberately
   * does not run the apply on a click, since quitting Cursor is too large a
   * thing to sit one misclick away from the item beside it.
   *
   * Self-limiting rather than rate-limited: it can only appear while something
   * is genuinely waiting, and applying is what makes it stop.
   */
  private async maybeOfferQueuedApplyAtLaunch(): Promise<void> {
    const repository = this.repository;
    if (
      !this.launchApplyOfferPending ||
      !this.backgroundCoordinator.active ||
      repository === null ||
      !repository.isInitialized
    ) {
      return;
    }
    // One attempt per launch. A stale deferred snapshot never reaches the
    // prompt; a first cycle skipped on a busy sync.lock leaves the flag armed
    // and the next successful owner cycle retries after releasing that lock.
    this.launchApplyOfferPending = false;
    try {
      await this.offerQueuedApply("launch");
    } catch (error) {
      this.status.log(
        `Could not offer to apply the queued changes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async offerQueuedApply(occasion: "setup" | "launch"): Promise<void> {
    const repository = this.repository;
    if (repository === null || this.queuedApplyDeclined) {
      return;
    }
    // Nothing to offer when quitting will do it. The modal exists because the
    // queue needs a closed Cursor and the user had no other way to give it one;
    // with the finalizer applying, asking them to quit the editor they just
    // opened is asking for something they were going to do anyway, at the one
    // moment it interrupts them most.
    //
    // Unless the last shutdown pass was cut short by the editor reopening. The
    // offer is the only path that controls the quit itself, so without this a
    // user who reopens quickly every time gets no successful shutdown apply
    // AND no prompt, and the queue never drains.
    if (this.configuration.applyOnShutdown && !this.shutdownApplyInterrupted) {
      return;
    }
    if (await this.applyAlreadyInProgress()) {
      // A sibling window committed to an apply and the offer lock is free
      // again because its dialog was answered - but its syncNow, git pull and
      // quit can take tens of seconds. A second modal over the same queue in
      // that window started a SECOND helper against the same batch.
      this.status.log(
        "Skipped the apply offer: another window already started this apply.",
      );
      return;
    }
    // Counted the way the command counts it, rather than off the raw queue.
    // "Unblocked" is not the same question as "would the helper be given this":
    // an entry can be dropped on arrival, or fall outside the batch, and a queue
    // made entirely of those raised a modal about work that did not exist - once
    // for real, seconds before the entries were dropped. Asking the same
    // question as `restartToApply` makes the offer and the command agree by
    // construction, so the dialog can no longer describe a queue the command
    // would then report as empty.
    const batch = pendingHelperBatch(repository);
    const pending = batch.changes;
    if (pending.length === 0) {
      return;
    }
    // Every window runs its own extension host and would otherwise raise its
    // own modal over the same queue. Whoever claims this first speaks for the
    // session; the rest stay quiet rather than stacking dialogs that all quit
    // the same application. Held across the dialog, so the claim lasts as long
    // as the question is on screen.
    const lock = await acquireFileLock(
      join(this.paths.extensionStorage, "apply-offer.lock"),
    );
    if (lock === null) {
      return;
    }
    let choice: string | undefined;
    try {
      const action = "Apply now";
      choice = await vscode.window.showWarningMessage(
        queuedApplyPrompt(pending, batch.deferredForBatchLimit),
        { modal: true },
        action,
      );
      if (choice !== action) {
        this.queuedApplyDeclined = true;
        this.status.log(
          `${pending.length} queued change(s) were left unapplied at the user's request; run "${RESTART_TO_APPLY_TITLE}" to apply them.`,
        );
        return;
      }
    } finally {
      await lock.release();
    }
    // Delegated rather than inlined so this shares the workspace mapping, the
    // quit-stall warning and the finalizer re-arm with the command itself.
    // Released above first: `restartToApply` quits Cursor on success, and a
    // lock still held at that point would outlive the process that took it.
    this.status.log(
      `Applying ${pending.length} queued change(s) offered at ${occasion}.`,
    );
    await this.restartToApply();
  }

  /**
   * Offers git preparation for an empty setup folder. Returns false when the
   * user cancelled; on success the folder is either still plain, freshly
   * cloned from a remote, or an initialized empty git repository.
   */
  private async prepareEmptyRepositoryFolder(root: string): Promise<boolean> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(folder) Plain shared folder",
          description: "OneDrive, Syncthing, or another synchronized folder",
          value: "plain" as const,
        },
        {
          label: "$(repo-create) New git repository with remote",
          description: "Initialize git here; the remote URL may stay empty",
          value: "init" as const,
        },
        {
          label: "$(repo-clone) Clone an existing git repository",
          description: "Join a sync repository other devices already push to",
          value: "clone" as const,
        },
      ],
      { title: "Choose how the empty folder stores the repository" },
    );
    if (choice === undefined) {
      return false;
    }
    if (choice.value === "plain") {
      return true;
    }
    const url = await vscode.window.showInputBox({
      title:
        choice.value === "clone"
          ? "Git repository URL to clone"
          : "Git remote URL (leave empty for a local-only git history)",
      prompt:
        "The system git CLI and its configured credentials are used; interactive prompts are disabled.",
      ignoreFocusOut: true,
      validateInput: (value) =>
        choice.value === "clone" && value.trim().length === 0
          ? "A repository URL is required."
          : undefined,
    });
    if (url === undefined) {
      return false;
    }
    const detection = await detectGit();
    if (!detection.available) {
      void vscode.window.showWarningMessage(
        "The git executable was not found on PATH. Install git (https://git-scm.com) or add it to PATH; setup continues with a plain shared folder.",
      );
      return true;
    }
    const remoteUrl = url.trim();
    await this.withProgress("Cursor Setting Sync: Setup or Reconfigure", async (report) => {
      if (choice.value === "clone") {
        report(`Cloning ${remoteUrl}...`);
        await cloneRepository(remoteUrl, root);
        return;
      }
      report("Initializing the git repository...");
      await initRepository(root, remoteUrl.length === 0 ? null : remoteUrl);
    });
    return true;
  }

  /**
   * Runs `task` behind a notification progress indicator.
   *
   * Setup can clone a multi-gigabyte git repository, derive a scrypt key at
   * N=131072 and then run a full first sync; archiving copies the repository
   * file by file. All of that used to happen between a closing input box and a
   * completion toast, with nothing on screen in between, which is exactly how
   * a user concludes the command failed and restarts Cursor mid-clone.
   */
  private async withProgress<T>(
    title: string,
    task: (report: (message: string) => void) => Promise<T>,
  ): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
      },
      async (progress) =>
        task((message: string) => {
          progress.report({ message });
        }),
    );
  }

  /** A status-bar one-shot sync with visible progress and no forced quit. */
  async syncNowCommand(): Promise<void> {
    await this.withProgress("Cursor Setting Sync", async (report) => {
      report("Synchronizing...");
      await this.syncNow(true);
    });
  }

  /**
   * Clears the local configuration: the stored master key, the repository path
   * and ID, and the workspace mappings. Nothing in the shared folder is
   * touched.
   *
   * Without this there was no way to stop syncing, switch repositories, or
   * recover from a stored key that no longer matches the folder - that last
   * one failed at every startup with "The configured folder now contains a
   * different repository." and no stated remedy.
   */
  async disconnect(): Promise<void> {
    if (this.configuration.repositoryPath === null) {
      void vscode.window.showInformationMessage(
        'Cursor Setting Sync is not connected to a repository, so there is nothing to disconnect. Open "Cursor Setting Sync: Manage", choose "Repository & Devices…", then "Setup or Reconfigure This PC…" to connect one.',
      );
      return;
    }
    const proceed = "Disconnect This PC";
    const confirmed = await vscode.window.showWarningMessage(
      `Disconnect this PC from ${this.configuration.repositoryPath}? Synchronization stops in every Cursor window on this PC, and this PC's stored repository path, encryption key, and workspace mappings are cleared. The shared repository, its history, and this PC's existing device stream remain unchanged. To reconnect, open Cursor Setting Sync: Manage, choose Repository & Devices…, then Setup or Reconfigure This PC….`,
      { modal: true },
      proceed,
    );
    if (confirmed !== proceed) {
      return;
    }
    // Stop the timers first, then let an in-flight cycle finish before the
    // repository is dropped. Tearing down underneath it would publish into the
    // shared folder after the user was told this device had disconnected.
    ++this.configuredOpenGeneration;
    await this.backgroundCoordinator.stop();
    if (this.reconnectProbeTimer !== null) {
      clearTimeout(this.reconnectProbeTimer);
      this.reconnectProbeTimer = null;
    }
    try {
      // Safe to await the whole drain here only because the background
      // coordinator above stopped the timers and closed the watcher, so
      // nothing can put another scope in front of it.
      await this.cycles.settled();
    } catch {
      // A failing final cycle has already recorded its own error; it must not
      // block the disconnect the user asked for.
    }
    await this.helper.cancelFinalizers();
    // Disconnect is a statement about THIS DEVICE, but every open window runs
    // its own extension host and none of them observe globalState changes.
    // Without a machine-wide signal, sibling windows kept publishing into the
    // folder - green check mark and all - after the user was told the device
    // had disconnected. The marker is checked at the top of every sync cycle
    // and before every finalizer arm; Setup removes it on reconnect.
    const repositoryId =
      this.repository?.repository.repositoryId ??
      this.configuration.repositoryId;
    if (repositoryId !== null) {
      await writeJsonAtomic(
        this.disconnectMarkerPath(repositoryId),
        { disconnectedAt: new Date().toISOString(), pid: process.pid },
      ).catch(() => {});
    }
    this.repository = null;
    this.masterKey?.fill(0);
    this.masterKey = null;
    await this.replaceAdapters([]);
    this.warnings.clear();
    // Everything else that describes the departed repository goes with it: a
    // helper failure, notices, and a declined offer all prescribe actions
    // against a queue that no longer exists.
    this.helperFailure = null;
    this.notices.clear();
    this.queuedApplyDeclined = false;
    await this.configuration.clearRepository();
    this.status.setStatus("unconfigured");
    this.status.log("Disconnected from the synchronization repository.");
    void vscode.window.showInformationMessage(
      'Cursor Setting Sync is disconnected. Open "Cursor Setting Sync: Manage", choose "Repository & Devices…", then "Setup or Reconfigure This PC…" to connect again.',
    );
  }

  async syncNow(
    manual = true,
    scope: SyncScope = "all",
  ): Promise<void> {
    if (manual) {
      await this.ensureConfiguredRepositoryOpen();
    }
    await this.cycles.request(manual, scope);
  }

  /**
   * Opens a configured repository for an explicit command in a standby
   * window. Commands that inspect mutable repository state still initialize
   * it under their normal command lock; this method only removes the eager
   * activation cost while keeping command entry points uniform.
   */
  async prepareForRepositoryCommand(): Promise<void> {
    await this.ensureConfiguredRepositoryOpen();
  }

  /**
   * Decides whether the repository has accumulated enough history to fold.
   *
   * Checkpointing used to be reachable only from a command nothing scheduled,
   * so an active user's event log and blob store grew without bound and every
   * cycle got slower as they did - and the only hint was a line in "Show
   * Repository Usage". The gates the manual path uses (a warning-free
   * reconcile, no unresolved conflicts, every device acked, a 24-hour-old
   * checkpoint) all still apply; this only decides when to try.
   */
  private async noteMaintenanceNeed(
    repository: SyncRepository,
    reconcileWarnings: readonly string[],
  ): Promise<void> {
    if (
      this.maintenanceRequested ||
      reconcileWarnings.length > 0 ||
      unresolvedConflicts(repository).length > 0 ||
      pendingDatabaseChangesBlockMaintenance(
        repository.state.pendingDatabaseChanges,
      ) ||
      Date.now() - this.automaticMaintenanceAt < AUTOMATIC_CHECKPOINT_COOLDOWN_MS
    ) {
      return;
    }
    if (
      (await repository.countEvents()) < AUTOMATIC_CHECKPOINT_EVENT_THRESHOLD
    ) {
      return;
    }
    this.maintenanceRequested = true;
  }

  private async runRequestedMaintenance(): Promise<void> {
    if (!this.maintenanceRequested || this.disposed) {
      return;
    }
    this.maintenanceRequested = false;
    const repository = this.repository;
    if (repository === null) {
      return;
    }
    // The clock starts whether or not the attempt succeeds: every phase is
    // gated on conditions this device cannot force, and retrying them on the
    // next poll would be the same work for the same answer.
    this.automaticMaintenanceAt = Date.now();
    this.status.log(
      "Automatic repository maintenance: folding history into a checkpoint.",
    );
    try {
      const outcome = await this.runCheckpointPhases(repository, false);
      this.status.log(
        `Automatic repository maintenance: ${describeCheckpointOutcome(outcome)}`,
      );
    } catch (error) {
      this.status.log(
        `Automatic repository maintenance was skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Explicitly opens the manual workspace-mapping flow.
   *
   * Ordinary synchronization never asks the user to place workspaceStorage:
   * exact identities are resolved automatically and everything else remains
   * deferred. This separate entry point is the only path allowed to offer an
   * unmatched workspace, after bounded discovery of every readable local
   * identity; unreadable metadata stays omitted and explicitly reported.
   */
  async mapPendingWorkspaces(): Promise<void> {
    const repository = this.requireRepository();
    const expectedRepositoryId = this.configuration.repositoryId;
    const expectedRepositoryPath = this.configuration.repositoryPath;
    const initial = await this.cycles.withCommandFloor(async () => {
      const initialLock = await this.withProgress(
        "Cursor Setting Sync",
        async (report) => {
          report("Reading pending workspace mappings...");
          return this.takeCommandLock(repository, report);
        },
      );
      try {
        await this.openGitWindow(repository);
        await repository.refreshState();
        const pass = await this.ensureWorkspaceMappings(repository);
        await repository.saveState();
        this.updateStatus(repository);
        return pass;
      } finally {
        await initialLock.release();
      }
    });
    if (initial.automaticMappings > 0 || initial.mappingStateChanged) {
      await this.refreshWorkspaceMappingConsumers();
    }

    if (initial.unresolved.length === 0) {
      if (initial.automaticMappings > 0) {
        void vscode.window.showInformationMessage(
          `${initial.automaticMappings} pending workspace mapping(s) were verified automatically. No manual choice is needed.`,
        );
      } else {
        void vscode.window.showInformationMessage(
          initial.pendingWorkspaceStorage === 0
            ? "There are no pending workspace-storage changes to map."
            : "No pending workspace-storage change needs a manual mapping.",
        );
      }
      return;
    }

    const manualPass = await this.expandWorkspaceMappingCandidates(initial);
    if (manualPass.localWorkspaces.length === 0) {
      const incomplete =
        manualPass.unreadableLocalWorkspaces === 0
          ? ""
          : ` ${manualPass.unreadableLocalWorkspaces} local workspace identity file(s) could not be read.`;
      void vscode.window.showWarningMessage(
        `${manualPass.unresolved.length} incoming workspace(s) still need a mapping, but no readable local workspace candidate is available.${incomplete} Open the intended project in Cursor, then run Map Pending Workspaces again.`,
      );
      return;
    }

    const automaticSelections =
      this.automaticWorkspaceMappingSelections(manualPass);
    const automaticSources = new Set(
      automaticSelections.map((selection) => selection.sourceWorkspaceId),
    );
    const interactivePass: WorkspaceMappingPassResult = {
      ...manualPass,
      unresolved: manualPass.unresolved.filter(
        (source) => !automaticSources.has(source.sourceWorkspaceId),
      ),
    };
    // QuickPicks can remain open indefinitely. No synchronization lock is
    // held while the user reads or answers them; the selected identities are
    // treated only as proposals and rebound to fresh state below.
    const collected =
      interactivePass.unresolved.length === 0
        ? { selections: [], skipped: 0 }
        : await this.collectWorkspaceMappingSelections(interactivePass);
    const proposedSelections = [
      ...automaticSelections,
      ...collected.selections,
    ];
    if (proposedSelections.length === 0) {
      void vscode.window.showInformationMessage(
        `${initial.unresolved.length} incoming workspace mapping(s) remain deferred. Nothing was mapped manually.`,
      );
      return;
    }

    if (
      !this.workspaceMappingCommandIsCurrent(
        repository,
        expectedRepositoryId,
        expectedRepositoryPath,
      )
    ) {
      void vscode.window.showWarningMessage(
        "Workspace mapping was cancelled because this PC's synchronization repository changed while the choices were open.",
      );
      return;
    }

    const outcome = await this.cycles.withCommandFloor(async () => {
      const applyLock = await this.withProgress(
        "Cursor Setting Sync",
        async (report) => {
          report("Verifying the selected workspace mappings...");
          return this.takeCommandLock(repository, report);
        },
      );
      let applied = 0;
      let stale = 0;
      let automaticMappings = 0;
      let mappingStateChanged = false;
      let remaining = initial.unresolved.length;
      let commandStillCurrent: boolean;
      try {
        commandStillCurrent = this.workspaceMappingCommandIsCurrent(
          repository,
          expectedRepositoryId,
          expectedRepositoryPath,
        );
        if (commandStillCurrent) {
          await this.openGitWindow(repository);
          await repository.refreshState();
          commandStillCurrent = this.workspaceMappingCommandIsCurrent(
            repository,
            expectedRepositoryId,
            expectedRepositoryPath,
          );
        }
        if (commandStillCurrent) {
          const fresh = await this.ensureWorkspaceMappings(repository);
          automaticMappings += fresh.automaticMappings;
          mappingStateChanged ||= fresh.mappingStateChanged;
          commandStillCurrent = this.workspaceMappingCommandIsCurrent(
            repository,
            expectedRepositoryId,
            expectedRepositoryPath,
          );
          if (commandStillCurrent) {
            const freshBySource = new Map(
              fresh.unresolved.map((choice) => [
                choice.sourceWorkspaceId,
                choice,
              ]),
            );
            const freshTargetById = await this.lookupWorkspaceIdentitiesInPages(
              proposedSelections.map(
                (selection) => selection.targetWorkspaceId,
              ),
            );
            for (const selection of proposedSelections) {
              const source = freshBySource.get(selection.sourceWorkspaceId);
              const target = freshTargetById.get(selection.targetWorkspaceId);
              if (
                source === undefined ||
                target === undefined ||
                !workspaceUriMatchesAny(selection.sourceWorkspaceUri, [
                  source.sourceWorkspaceUri,
                ]) ||
                !workspaceUriMatchesAny(selection.targetWorkspaceUri, [
                  target.uri,
                ]) ||
                (selection.automatic &&
                  selection.targetWorkspaceId !==
                    selection.sourceWorkspaceId &&
                  !workspaceUriMatchesAny(source.sourceWorkspaceUri, [
                    target.uri,
                  ]))
              ) {
                stale += 1;
                continue;
              }
              await this.configuration.setWorkspaceMapping(
                selection.sourceWorkspaceId,
                selection.targetWorkspaceId,
              );
              mappingStateChanged =
                this.updateWorkspaceMappingBlocks(
                  repository,
                  selection.sourceWorkspaceId,
                  null,
                ) || mappingStateChanged;
              applied += 1;
            }
            remaining = Math.max(0, fresh.unresolved.length - applied);
            await repository.saveState();
            this.updateStatus(repository);
          }
        }
      } finally {
        await applyLock.release();
      }
      return {
        applied,
        stale,
        automaticMappings,
        mappingStateChanged,
        remaining,
        commandStillCurrent,
      };
    });
    const {
      applied,
      stale,
      automaticMappings,
      mappingStateChanged,
      remaining,
      commandStillCurrent,
    } = outcome;

    if (!commandStillCurrent) {
      void vscode.window.showWarningMessage(
        "Workspace mapping was cancelled because this PC's synchronization repository changed while the choices were open.",
      );
      return;
    }
    if (automaticMappings + applied > 0 || mappingStateChanged) {
      await this.refreshWorkspaceMappingConsumers();
    }
    const incomplete =
      manualPass.unreadableLocalWorkspaces === 0
        ? ""
        : ` ${manualPass.unreadableLocalWorkspaces} unreadable local workspace identity file(s) were omitted from the candidate list.`;
    void vscode.window.showInformationMessage(
      `Mapped ${applied} workspace(s); ${remaining} remain deferred${
        stale === 0 ? "" : ` and ${stale} stale selection(s) were ignored`
      }.${incomplete}`,
    );
  }

  private workspaceMappingCommandIsCurrent(
    repository: SyncRepository,
    repositoryId: string | null,
    repositoryPath: string | null,
  ): boolean {
    return (
      !this.disposed &&
      this.repository === repository &&
      this.configuration.repositoryId === repositoryId &&
      this.configuration.repositoryPath === repositoryPath
    );
  }

  private async refreshWorkspaceMappingConsumers(): Promise<void> {
    await this.refreshAdapters();
    await this.startFinalizer();
  }

  private automaticWorkspaceMappingSelections(
    pass: WorkspaceMappingPassResult,
  ): WorkspaceMappingSelection[] {
    if (pass.unreadableLocalWorkspaces > 0) {
      return [];
    }
    const localWorkspaceById = new Map(
      pass.localWorkspaces.map((workspace) => [workspace.id, workspace]),
    );
    const noExplicitMappings = Object.create(null) as Record<string, string>;
    const selections: WorkspaceMappingSelection[] = [];
    for (const source of pass.unresolved) {
      const targetWorkspaceId = resolveTargetWorkspace(
        source.sourceWorkspaceId,
        source.sourceWorkspaceUri,
        pass.localWorkspaces,
        noExplicitMappings,
      );
      if (targetWorkspaceId === null) {
        continue;
      }
      const target = localWorkspaceById.get(targetWorkspaceId);
      if (target === undefined) {
        continue;
      }
      selections.push({
        ...source,
        automatic: true,
        targetWorkspaceId,
        targetWorkspaceUri: target.uri,
      });
    }
    return selections;
  }

  private async collectWorkspaceMappingSelections(
    pass: WorkspaceMappingPassResult,
  ): Promise<CollectedWorkspaceMappings> {
    const selections: WorkspaceMappingSelection[] = [];
    const incompleteDescription =
      pass.unreadableLocalWorkspaces === 0
        ? ""
        : ` ${pass.unreadableLocalWorkspaces} unreadable local workspace identity file(s) are omitted.`;
    for (let index = 0; index < pass.unresolved.length; index += 1) {
      const source = pass.unresolved[index];
      if (source === undefined) {
        continue;
      }
      const items: Array<{
        label: string;
        description: string;
        workspaceId: string | null;
        workspaceUri: string | null;
      }> = [
        {
          label: "$(close) Skip all remaining workspaces",
          description: `Safe default: leave incoming workspace storage deferred.${incompleteDescription}`,
          workspaceId: null,
          workspaceUri: null,
        },
        ...pass.localWorkspaces.map((workspace) => ({
          label: workspace.basename,
          description: workspace.uri,
          workspaceId: workspace.id,
          workspaceUri: workspace.uri,
        })),
      ];
      const selected = await vscode.window.showQuickPick(items, {
        title: `Map incoming workspace storage ${source.sourceWorkspaceUri}`,
        placeHolder:
          pass.unreadableLocalWorkspaces === 0
            ? "Select only a local workspace known to be the same project."
            : `Select only a known match; ${pass.unreadableLocalWorkspaces} unreadable local identity file(s) are omitted.`,
        ignoreFocusOut: true,
      });
      if (
        selected === undefined ||
        selected.workspaceId === null ||
        selected.workspaceUri === null
      ) {
        return {
          selections,
          skipped: pass.unresolved.length - selections.length,
        };
      }
      selections.push({
        ...source,
        automatic: false,
        targetWorkspaceId: selected.workspaceId,
        targetWorkspaceUri: selected.workspaceUri,
      });
    }
    return { selections, skipped: 0 };
  }

  async restartToApply(): Promise<void> {
    const repository = this.requireRepository();
    // A copy, not the live reference: Disconnect or a Setup re-run zeroes
    // this.masterKey in place, and this command parks for tens of seconds in
    // sync, lock waits and workspace mapping checks before the key is
    // serialized to the helper - a zeroed shared Buffer there meant the helper
    // opened the repository with an all-zero key and failed after quitting
    // Cursor.
    const masterKey = Buffer.from(this.requireMasterKey());
    try {
      await this.cycles.withCommandFloor(() =>
        this.restartToApplyWithKey(repository, masterKey),
      );
    } finally {
      masterKey.fill(0);
    }
  }

  private async restartToApplyWithKey(
    repository: SyncRepository,
    masterKey: Buffer,
  ): Promise<void> {
    assertCompatibleForDatabaseWrite(this.compatibility);
    if (await this.applyAlreadyInProgress()) {
      const message =
        "Another window already started this apply; Cursor will quit when it is ready.";
      this.status.log(message);
      void vscode.window.showInformationMessage(message);
      return;
    }
    // Claimed BEFORE the multi-ten-second sync below, not after: the check
    // above and a marker written only at the end left the whole preparation
    // window open for a second window to commit to the same apply - two
    // helpers then each counted the other as a live Cursor and both timed
    // out having applied nothing.
    const claim = await this.markApplyInProgress();
    let committed = false;
    try {
      // One progress notification across the WHOLE preparation, and a line per
      // phase in the output channel.
      //
      // Only the lock wait used to be shown, and it disappears the moment the
      // lock is taken - after which the synchronize, the git fetch, the state
      // reload and the mapping pass ran in silence. On a repository of any
      // size that is minutes of a command that has visibly done nothing, with
      // no way to tell it apart from one that has hung. The log lines carry
      // elapsed times and survive the quit, so the record is still there when
      // Cursor comes back.
      const startedAt = Date.now();
      const elapsed = (): string =>
        `${Math.round((Date.now() - startedAt) / 1000)}s`;
      // A phase logs when it STARTS, so a phase that runs long writes nothing
      // until the next one begins - which is exactly the case the user is
      // staring at the log for. The heartbeat says the same phase is still
      // running rather than leaving the last line an hour old.
      let current: string | null = null;
      const heartbeat = setInterval(() => {
        if (current !== null) {
          this.status.log(
            `Restart to Apply [${elapsed()}]: still working on: ${current}`,
          );
        }
      }, RESTART_TO_APPLY_HEARTBEAT_MS);
      const phase = (
        report: (message: string) => void,
        message: string,
      ): void => {
        current = message;
        report(message);
        this.status.log(`Restart to Apply [${elapsed()}]: ${message}`);
      };
      const batch = await this.withProgress(
        RESTART_TO_APPLY_TITLE,
        async (report) => {
          phase(report, "Synchronizing before the apply...");
          await this.syncNow(true);
          // The sync above releases the lock, so this races the background
          // cycle for it a moment later - which is how the command the user
          // asked for failed with "another Cursor window is synchronizing"
          // about this window's own poll. Waiting is shown rather than silent.
          phase(report, "Taking the synchronization lock...");
          const lock = await this.takeCommandLock(repository, (message) =>
            phase(report, message),
          );
          try {
            phase(report, "Fetching the shared folder...");
            await this.openGitWindow(repository);
            phase(report, "Reading the queue...");
            await repository.refreshState();
            phase(report, "Writing what can be applied while Cursor runs...");
            await this.withAdapterUse(() =>
              this.applyPendingRunningResources(repository),
            );
            // The user asked for this apply, so the previous one's failures get
            // another try. The helper blocks what it could not write so the
            // OFFER stops repeating on its own; deliberately running the
            // command is the retry, and it re-blocks anything that fails again.
            this.clearApplyFailureBlocks(repository);
            phase(report, "Verifying queued conversations...");
            await this.protectQueuedChatsBeforeOfflineApply(repository);
            phase(report, "Checking workspace mappings...");
            await this.ensureWorkspaceMappings(repository);
            // Both of the above only touched memory. Everything else that
            // blocks a queued change is derived from the synchronous
            // `resourceApplyBlockReason` and reaches disk through the poll's
            // own save - but workspace mappings are exactly what that function
            // cannot see, so the automatic resolution and any mapping-owned
            // blocks must be durable before the process exits seconds later.
            await repository.saveState();
            phase(report, "Preparing the batch...");
            return pendingHelperBatch(repository);
          } finally {
            await lock.release();
          }
        },
      ).finally(() => {
        clearInterval(heartbeat);
        current = null;
      });
      if (this.disposed || this.repository !== repository || this.masterKey === null) {
        // Disconnect or Setup ran while this command was parked in waits;
        // quitting every window to apply into a repository this device just
        // left is not what anyone asked for.
        this.status.log(
          "Restart to Apply was abandoned: the synchronization configuration changed while it was being prepared. Nothing was applied.",
        );
        return;
      }
      // The preparation above can include an unbounded maintenance checkpoint
      // inside the sync while the claim's TTL is not.
      // Re-stamp so a live preparer's marker never ages out mid-flight, and
      // verify no other window took the claim over in the meantime - if one
      // did, IT is committing this apply and this attempt must stand down.
      try {
        const marker = await readJsonFile<{ nonce?: string }>(
          this.applyInProgressPath(),
        );
        if (typeof marker.nonce === "string" && marker.nonce !== claim) {
          this.status.log(
            "Another window took over this apply while it was being prepared; standing down.",
          );
          return;
        }
      } catch {
        // Marker expired or was swept; re-claim below.
      }
      await this.markApplyInProgress(claim);
      const changes = batch.changes;
      if (changes.length === 0) {
        const blocked = repository.state.pendingDatabaseChanges.filter(
          (change) => change.blockedReason !== undefined,
        );
        // An empty queue means the work the failure described no longer
        // exists; a red bar surviving it prescribes a retry that cannot clear.
        this.helperFailure = null;
        this.updateStatus(repository);
        if (blocked.length > 0) {
          void vscode.window.showWarningMessage(
            `${blocked.length} database change(s) are deferred. ${blocked[0]?.blockedReason ?? "Update Cursor and try again."}`,
          );
        } else {
          void vscode.window.showInformationMessage("There are no database changes to apply.");
        }
        return;
      }
      // The retry the failure asked for is under way, so the red bar has
      // served its purpose; leaving it latched would outlive the thing it
      // described. Cleared here rather than on entry because everything above
      // can throw or return early.
      this.helperFailure = null;
      if (batch.deferredForBatchLimit > 0) {
        // Durable, because the toast below dies with the window this is about
        // to quit. Without it the queue comes back smaller than promised.
        this.status.log(
          `Applying ${changes.length} initial change(s); ${batch.deferredForBatchLimit} additional ready change(s) will be drained automatically in successive bounded pages during this same offline run.`,
        );
      }
      // The last thing written before the window goes away, and the first
      // thing the user reads when it comes back. The offline pass runs with
      // Cursor closed, so there is no UI it could report into: this line plus
      // the completion line the result produces are the whole record of a
      // stretch that takes minutes on a large queue.
      this.status.log(
        `Applying ${changes.length} change(s) offline (${summarizePendingKinds(changes)}). ` +
          "Cursor closes now, the helper writes them with the editor shut, and Cursor reopens by itself. " +
          "Reopening it by hand before that finishes cancels the pass and leaves the queue for next time.",
      );
      committed = true;
      await this.launchApplyHelper(repository, masterKey, changes, claim);
    } finally {
      if (!committed) {
        // Every early return and throw above must release the claim, or a
        // batch that turned out empty blocks the next window's offer for the
        // marker's whole TTL. Nonce-scoped: a successor's claim survives.
        await this.clearApplyInProgress(claim);
      }
    }
  }

  private async launchApplyHelper(
    repository: SyncRepository,
    masterKey: Buffer,
    changes: HelperChange[],
    claim: string,
  ): Promise<void> {
    try {
      await this.helper.applyAndRestart(
        this.configuration.repositoryPath ?? repository.root,
        masterKey,
        changes,
        this.configuration.workspaceMappings,
        this.helperSyncOptions(),
        async () => {
          await this.clearApplyInProgress(claim);
          // The quit was vetoed, so the helper is about to give up and write a
          // failure nobody would otherwise read until the next launch. The
          // consume is best-effort because `scheduleQuitVetoCheck` invokes this
          // with `void`: a throw here would go unhandled AND cost the session
          // its shutdown export, which is the only workspaceStorage backup
          // there is.
          try {
            await this.consumeHelperResults({ atStartup: false });
          } catch (error) {
            this.status.log(
              `Could not read the offline helper's result: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          await this.startFinalizer();
        },
        () => {
          this.status.log(QUIT_STALLED_MESSAGE);
          void vscode.window.showWarningMessage(QUIT_STALLED_MESSAGE).then(
            () => {},
            () => {
              // The window may be mid-teardown; the output-channel line above
              // is the durable record either way.
            },
          );
        },
      );
    } catch (error) {
      // applyAndRestart cancels the standing finalizer BEFORE it spawns the
      // apply helper, so a launch that throws - the helper bundle mid-update,
      // a spawn failure - would otherwise leave the session with no shutdown
      // export at all and nothing scheduled to notice.
      await this.clearApplyInProgress(claim);
      await this.startFinalizer();
      throw error;
    }
  }

  private applyInProgressPath(): string {
    return join(this.paths.extensionStorage, "apply-in-progress.json");
  }

  private disconnectMarkerPath(repositoryId: string): string {
    return join(this.paths.extensionStorage, `disconnected-${repositoryId}.json`);
  }

  /**
   * Whether another window disconnected this device from the repository this
   * window still holds open - and if so, the same teardown disconnect()
   * performs locally. Extension hosts observe no globalState events, so
   * without this check a sibling window kept publishing into the folder,
   * green check mark and all, after the user was told the device had
   * disconnected.
   */
  private async disconnectedElsewhere(): Promise<boolean> {
    const repository = this.repository;
    if (repository === null) {
      return false;
    }
    if (
      !(await pathExists(
        this.disconnectMarkerPath(repository.repository.repositoryId),
      ))
    ) {
      return false;
    }
    // This path can be reached from the coordinator's own activation cycle.
    // Invalidating it is synchronous; awaiting here would queue behind the
    // activation that is currently waiting for us and deadlock.
    void this.backgroundCoordinator.stop();
    // The disconnecting window cancelled the finalizer it knew about, but an
    // arm in flight in THIS window at that moment survives it; without a
    // second cancel from whoever observes the marker, that exporter performs
    // one final export into a repository the device just left.
    await this.helper.cancelFinalizers();
    ++this.configuredOpenGeneration;
    this.repository = null;
    this.masterKey?.fill(0);
    this.masterKey = null;
    // This can run inside performSync, whose adapter-use lease is still held.
    // Queue retirement now and let the cycle release that lease on return.
    void this.replaceAdapters([]);
    this.warnings.clear();
    this.helperFailure = null;
    this.notices.clear();
    this.queuedApplyDeclined = false;
    this.status.setStatus("unconfigured");
    this.status.log(
      "Another window disconnected this device from the synchronization repository; this window stopped synchronizing too.",
    );
    // A later Setup in some window removes the marker; this window must come
    // back on its own rather than sitting dark until a manual reload while
    // the device is in fact configured and syncing.
    this.scheduleReconnectProbe(repository.repository.repositoryId);
    return true;
  }

  private scheduleReconnectProbe(repositoryId: string): void {
    if (this.reconnectProbeTimer !== null || this.disposed) {
      return;
    }
    this.reconnectProbeTimer = setTimeout(() => {
      this.reconnectProbeTimer = null;
      void (async () => {
        if (this.disposed || this.repository !== null) {
          return;
        }
        if (!this.configuration.enabled) {
          // The user turned sync off while this window waited to reconnect;
          // resuming the watcher and publish cycles under a "disabled" status
          // bar is exactly what the setting says must not happen. The probe
          // chain stays ALIVE though - configurationChanged cannot restart a
          // window whose repository is null, so ending the chain here left
          // disable-then-re-enable stranded until a manual reload.
          this.status.setStatus("disabled");
          this.scheduleReconnectProbe(repositoryId);
          return;
        }
        if (await pathExists(this.disconnectMarkerPath(repositoryId))) {
          this.scheduleReconnectProbe(repositoryId);
          return;
        }
        // Marker gone: a Setup reconnected the device. Reopen from the
        // stored configuration; failing that (stale memento, different
        // repository), tell the user what to do instead of showing a wrong
        // "unconfigured".
        try {
          const root = this.configuration.repositoryPath;
          if (
            root !== null &&
            (await this.ensureConfiguredRepositoryOpen())
          ) {
            await this.startWatching(true);
            this.status.log(
              "Reconnected after another window's Setup; synchronization resumed in this window.",
            );
            return;
          }
        } catch (error) {
          this.status.log(
            `This window could not rejoin the reconnected repository: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        this.status.setStatus(
          "error",
          "This device reconnected in another window; reload this window to resume synchronizing here.",
        );
      })();
    }, RECONNECT_PROBE_INTERVAL_MS);
  }

  /**
   * Whether a sibling window committed to an apply recently enough that it may
   * still be between its dialog and the quit. The budget is the helper's exit
   * wait plus its lock wait plus margin; a marker older than that is a vetoed
   * or crashed run whose cleanup never happened, and must not block the user.
   */
  private async applyAlreadyInProgress(): Promise<boolean> {
    try {
      const marker = await readJsonFile<{ createdAt?: string }>(
        this.applyInProgressPath(),
      );
      const createdAt = Date.parse(marker.createdAt ?? "");
      return (
        Number.isFinite(createdAt) &&
        Date.now() - createdAt < APPLY_IN_PROGRESS_TTL_MS
      );
    } catch {
      return false;
    }
  }

  /**
   * Writes (or re-stamps) the claim and returns its nonce. Every clear is
   * nonce-scoped: a leftover veto timer from a superseded attempt, or a stale
   * consumed result, must never erase a SUCCESSOR's live claim - pid alone
   * cannot tell two attempts from the same window apart.
   */
  private async markApplyInProgress(nonce?: string): Promise<string> {
    const claim = nonce ?? randomUUID();
    this.activeApplyClaim = claim;
    await writeJsonAtomic(this.applyInProgressPath(), {
      createdAt: new Date().toISOString(),
      pid: process.pid,
      nonce: claim,
    });
    return claim;
  }

  /** Removes the marker only while it still carries the given claim. */
  private async clearApplyInProgress(nonce?: string): Promise<void> {
    if (nonce !== undefined) {
      try {
        const marker = await readJsonFile<{ nonce?: string }>(
          this.applyInProgressPath(),
        );
        if (typeof marker.nonce === "string" && marker.nonce !== nonce) {
          // A successor attempt owns the marker now; leave it standing.
          return;
        }
      } catch {
        // Missing or unreadable: nothing to protect.
      }
    }
    if (this.activeApplyClaim === nonce || nonce === undefined) {
      this.activeApplyClaim = null;
    }
    await rm(this.applyInProgressPath(), { force: true });
  }

  /**
   * Clears the marker unless it belongs to another window that is still
   * alive, or to THIS window's currently held claim - either way that apply
   * may be mid-flight, and erasing its claim re-admits a concurrent apply
   * against the same quit. A dead owner's marker and an unowned own-pid
   * marker clear as usual; the TTL remains the backstop.
   */
  private async clearApplyInProgressUnlessForeign(): Promise<void> {
    try {
      const marker = await readJsonFile<{ pid?: number; nonce?: string }>(
        this.applyInProgressPath(),
      );
      const pid = marker.pid;
      if (typeof pid === "number" && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          return;
        } catch {
          // Owner gone; fall through to the clear.
        }
      }
      if (
        typeof marker.nonce === "string" &&
        this.activeApplyClaim === marker.nonce
      ) {
        // This window's own LIVE claim - a stale result consumed during the
        // claim-holder's pre-quit sync must not strip it mid-preparation.
        return;
      }
    } catch {
      // Unreadable or missing marker clears unconditionally.
    }
    await this.clearApplyInProgress();
  }

  async resolveConflicts(): Promise<void> {
    const repository = this.requireRepository();
    // Wrapped in progress because this is the one command reached by CLICKING a
    // warning in the status bar, and the lock it needs is routinely held by this
    // window's own poll for a good part of a minute. Taking it bare meant the
    // click produced nothing at all - no notification, no spinner - for up to
    // COMMAND_LOCK_WAIT_MS, which reads as a dead button on the very item that
    // just asked for attention. `takeCommandLock` has always accepted a
    // reporter for exactly this reason; this call site never passed one.
    const refreshLock = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report("Opening the conflict resolver...");
        return this.takeCommandLock(repository, report);
      },
    );
    try {
      await this.openGitWindow(repository);
      await repository.refreshState({ forceAudit: true });
    } finally {
      await refreshLock.release();
    }
    // The QuickPick can stay open indefinitely, so selections are collected
    // without the lock and verified against fresh tips before publishing.
    const collected = await this.conflicts.collectSelections(
      repository,
      (tips) => {
        for (const tip of tips) {
          const reason = this.resourceApplyBlockReason(tip);
          if (reason !== null) {
            return reason;
          }
        }
        return null;
      },
      (resourceId, kind) => this.liveResourceSnapshot(resourceId, kind),
    );
    const resolution: ConflictResolutionResult = {
      resolved: 0,
      deferred: [...collected.deferred],
    };
    if (collected.selections.length > 0) {
      // The answers are already in hand, so this waits for a busy poll instead
      // of failing. Losing a set of decisions to a routine 30-second cycle -
      // which is what happened, because the prompt above deliberately runs
      // without the lock - is never what the user would have chosen.
      const lock = await this.withProgress(
        "Cursor Setting Sync",
        async (report) => {
          report("Applying conflict resolutions...");
          return acquireFileLockWithin(
            this.syncLockPath(),
            CONFLICT_APPLY_LOCK_WAIT_MS,
            () => {
              report("Waiting for the current synchronization to finish...");
            },
          );
        },
      );
      if (lock === null) {
        throw await this.synchronizationBusyError();
      }
      try {
        await repository.ensureInitialized();
        const gitActive = await this.openGitWindow(repository);
        await repository.refreshState();
        const applied = await this.conflicts.applySelections(
          repository,
          collected.selections,
        );
        resolution.resolved = applied.resolved;
        resolution.deferred.push(...applied.deferred);
        if (applied.resolved > 0) {
          const reconciler = new EventReconciler();
          const checkpoint = await absorbedCheckpointManifest(repository);
          const result = reconciler.reconcile(
            await repository.listReconciliationEvents(checkpoint),
            repository.state,
            checkpoint,
          );
          await this.applySyntheticProjectionsBeforeScan(
            repository,
            result.projections,
          );
          await this.commitGitWindow(
            gitActive,
            repository.root,
            `sync(${repository.state.device.deviceId.slice(0, 8)}): ${applied.resolved} conflict resolution(s)`,
          );
        }
      } finally {
        await lock.release();
      }
    }
    // Reported whether or not anything else resolved. A bulk answer routinely
    // covers most of the list and leaves a few out — a conflict between two
    // *other* devices has no "this PC" side — and those used to disappear in
    // silence whenever at least one conflict had been resolved alongside them.
    if (resolution.deferred.length > 0) {
      for (const entry of resolution.deferred) {
        this.status.log(`Conflict deferred: ${entry}`);
      }
      void vscode.window.showWarningMessage(
        `${resolution.deferred.length} conflict(s) are deferred. ${resolution.deferred[0]}`,
      );
    }
    if (resolution.resolved > 0) {
      await this.syncNow(true);
    } else if (resolution.deferred.length === 0) {
      void vscode.window.showInformationMessage(
        "There are no synchronization conflicts to resolve.",
      );
    }
  }

  /**
   * Repairs every conversation whose live composerData references bubble rows
   * that are no longer present, and diagnoses the separate case where the
   * renderable rows exist but Cursor's reachable continuation graph does not.
   * There is deliberately no per-chat or per-version picker: trusted history supplies
   * only missing rows, while continuation damage is either applied from an
   * already-queued complete v2 tip or left untouched with recovery guidance.
   */
  async repairUnavailableChats(): Promise<void> {
    const auditProgress: ChatRepairAuditProgress = {
      examinedChats: 0,
      unavailableWithoutSource: 0,
      oversizedChats: 0,
      historyBudgetDeferred: 0,
      unresolvedLimitReached: false,
    };
    let after: BrokenChatInspectionCursor | undefined;
    for (;;) {
      const next = await this.repairUnavailableChatsPage(after, auditProgress);
      if (next === undefined) {
        return;
      }
      after = next;
    }
  }

  /**
   * Preserves a continuation-damaged chat as read-only Markdown context and
   * opens a new, empty Agent. The original composer and live DB are never
   * written.
   */
  async continueUnavailableChatSafely(
    knownDamage?: readonly BrokenChatContinuationObservation[],
  ): Promise<void> {
    let inspectionUnknownChats = 0;
    let inspectionLimitReached = false;
    let damage: readonly BrokenChatContinuationObservation[];
    if (knownDamage !== undefined) {
      damage = knownDamage;
    } else {
      const inspection = await this.withProgress(
        "Cursor Setting Sync",
        async (report) => {
          report("Checking unavailable chat continuation data...");
          return inspectBrokenCursorChatContinuations(this.paths, {
            limits: { maxSnapshotBytesPerChat: 32 * 1024 * 1024 },
          });
        },
      );
      damage = inspection.broken;
      inspectionUnknownChats = inspection.unknownChats;
      inspectionLimitReached = inspection.limitReached;
    }
    if (damage.length === 0) {
      if (inspectionUnknownChats > 0 || inspectionLimitReached) {
        void vscode.window.showWarningMessage(
          `The continuation audit was inconclusive: ${inspectionUnknownChats} conversation(s) could not be verified${
            inspectionLimitReached ? ", and a bounded safety limit was reached" : ""
          }. No recovery file or new Agent was created; this is not an all-clear result.`,
        );
      } else {
        void vscode.window.showInformationMessage(
          "No continuation-damaged conversation with complete visible messages was found.",
        );
      }
      return;
    }
    let selected = damage[0];
    if (damage.length > 1) {
      const choice = await vscode.window.showQuickPick(
        damage.map((observation) => ({
          label: observation.title ?? "Untitled conversation",
          description: observation.composerId,
          observation,
        })),
        {
          title: "Choose a Conversation for Safe Recovery",
          placeHolder:
            "Choose a conversation to preserve as context in a new Agent",
        },
      );
      if (choice === undefined) {
        return;
      }
      selected = choice.observation;
    }
    if (selected === undefined) {
      return;
    }
    const inspectedSelection = selected;
    const transcript = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report("Verifying visible messages in one read-only transaction...");
        return extractVisibleChatRecoveryTranscript(
          this.paths.globalDatabase,
          inspectedSelection.composerId,
          {
            chatCoreHash: inspectedSelection.chatCoreHash,
            composerCursor: inspectedSelection.composerCursor,
          },
        );
      },
    );
    const openWorkspaceUri = matchingOpenWorkspaceUri(transcript.workspaceUri);
    if (openWorkspaceUri === null) {
      throw new Error(
        'Open the conversation\'s original workspace in this Cursor window, then open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats", and select the safe successor fallback again.',
      );
    }
    const artifact = await writeVisibleChatRecoveryArtifact(
      this.paths.extensionStorage,
      this.paths.workspaceStorageRoot,
      transcript,
    );
    const transcriptInfo = await stat(artifact.path);
    if (!transcriptInfo.isFile()) {
      throw new Error("The verified recovery transcript is not a regular file.");
    }
    const localPaths = [
      artifact.path,
      ...artifact.imageAttachments.map((image) => image.path),
    ];
    const prepared = await prepareRecoveryResources(
      openWorkspaceUri,
      localPaths,
      stagingSourcesForVisibleArtifact(artifact, transcriptInfo.size),
    );
    if (prepared === null) {
      return;
    }
    if (
      prepared.remoteStaging !== null &&
      !(await reverifyRemoteStagingBeforeAgent(prepared.remoteStaging))
    ) {
      return;
    }
    const freshness = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report("Rechecking the selected continuation immediately before recovery...");
        return inspectBrokenCursorChatContinuations(this.paths, {
          composerCursor: inspectedSelection.composerCursor,
          limits: { maxSnapshotBytesPerChat: 32 * 1024 * 1024 },
        });
      },
    );
    const freshDamage = freshness.broken[0];
    if (freshDamage === undefined) {
      if (
        freshness.auditedChats === 1 &&
        freshness.unknownChats === 0 &&
        !freshness.limitReached
      ) {
        void vscode.window.showInformationMessage(
          `The selected conversation's continuation data is now complete. No new Agent was created and nothing was attached or sent. The verified local recovery files remain in the local recovery-transcripts folder until you explicitly delete them.${remoteStagingRetention(prepared.remoteStaging)}`,
        );
        return;
      }
      void vscode.window.showWarningMessage(
        `The selected conversation could not be safely rechecked. No new Agent was created and nothing was attached or sent.${remoteStagingRetention(prepared.remoteStaging)}`,
      );
      return;
    }
    if (
      freshDamage.chatCoreHash !== inspectedSelection.chatCoreHash ||
      freshDamage.fingerprint !== inspectedSelection.fingerprint
    ) {
      void vscode.window.showWarningMessage(
        `The selected conversation changed after inspection; open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats", and select the safe successor fallback again. No new Agent was created and nothing was attached or sent.${remoteStagingRetention(prepared.remoteStaging)}`,
      );
      return;
    }
    const freshWorkspaceUri = matchingOpenWorkspaceUri(transcript.workspaceUri);
    if (
      freshWorkspaceUri === null ||
      freshWorkspaceUri.scheme !== openWorkspaceUri.scheme ||
      freshWorkspaceUri.authority !== openWorkspaceUri.authority
    ) {
      void vscode.window.showWarningMessage(
        `The conversation's original workspace changed or closed during verification. Open it in this Cursor window, then open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats", and select the safe successor fallback again. No new Agent was created and nothing was attached or sent.${remoteStagingRetention(prepared.remoteStaging)}`,
      );
      return;
    }
    const mode = await prepareVisibleRecoveryAgent(
      vscode.commands,
      prepared.resources,
    );
    const summary = `${transcript.userRecordCount} user message(s), ${transcript.assistantTextRecordCount} assistant text message(s), ${transcript.toolCallCount} inert tool-call summary record(s), and ${artifact.imageAttachments.length} verified selected image(s)`;
    if (prepared.remoteStaging !== null && mode !== "manual") {
      void vscode.window.showInformationMessage(
        `Cursor opened a new Agent and was asked to attach the verified remote START-HERE.md and recovery transcript (${summary}). The selected PNGs were copied to the same remote staging directory and are listed by exact remote path in START-HERE.md; they were not attached as generic file chips. Verify the two Markdown attachment chips before continuing. Nothing was sent, and this extension did not rewrite the original conversation; Cursor may persist the newly opened empty Agent.${remoteStagingRetention(prepared.remoteStaging)}`,
      );
      return;
    }
    if (mode === "glass") {
      void vscode.window.showInformationMessage(
        `Cursor opened a new Agent and was asked to attach the verified Markdown recovery context and selected images (${summary}). Verify that its .md and image attachment chips are visible. The suggested continuation instruction is embedded near the top of the transcript; nothing was sent, and the original conversation was not changed. The plaintext files remain in the local recovery-transcripts folder until you explicitly delete those recovery files.`,
      );
      return;
    }
    if (mode === "classic") {
      void vscode.window.showInformationMessage(
        `Cursor opened a new Agent and was asked to attach the verified Markdown recovery context and selected images (${summary}). Verify that its .md and image attachment chips are visible. The suggested continuation instruction is embedded near the top of the transcript; nothing was sent, and the original conversation was not changed. The plaintext files remain in the local recovery-transcripts folder until you explicitly delete those recovery files.`,
      );
      return;
    }
    const open = "Open Recovery Transcript";
    const choice = await vscode.window.showWarningMessage(
      prepared.remoteStaging === null
        ? `Cursor's supported new-Agent context command was unavailable or rejected on this build. The verified Markdown recovery context and selected images were saved locally (${summary}); open the Markdown file and attach it plus every image listed in its verified attachment manifest to a new Agent. Its suggested continuation instruction is embedded near the top. Nothing was sent, the original conversation was not changed, and the plaintext files remain in the local recovery-transcripts folder until you explicitly delete those recovery files.`
        : `Cursor's supported new-Agent context command was unavailable or rejected on this build. It may have partially opened an empty Agent or attached only some files before rejecting. Open the remote START-HERE.md and attach it plus the remote transcript manually; selected PNGs are listed there by exact remote path and should not be attached as generic file chips. Nothing was sent, and this extension did not rewrite the original conversation; Cursor may have persisted a partially prepared Agent.${remoteStagingRetention(prepared.remoteStaging)}`,
      open,
    );
    if (choice === open) {
      await vscode.commands.executeCommand(
        "vscode.open",
        prepared.primaryResource,
      );
    }
  }

  /**
   * Builds a resumable local catalog for every continuation-damaged chat that
   * can be preserved without changing Cursor's databases. Work is checkpointed
   * after each small audit page, and cancellation is observed only between
   * items so an artifact/catalog pair is never intentionally left half-made.
   */
  async preserveAllUnavailableChatsSafely(): Promise<void> {
    const preserve = "Preserve All Safely";
    const confirmation = await vscode.window.showWarningMessage(
      "Preserve all recoverable continuation-damaged chats as plaintext in a local recovery catalog? This includes message text, tool inputs/results/status, source selections and URIs, todos/new-file/work state, and selected images, which may contain source code or secrets.",
      {
        modal: true,
        detail:
          "The recovered data is stored as plaintext in this extension's local recovery-transcripts folder until you explicitly delete those recovery files. This handles only definite continuation damage whose visible message bodies can still be verified; missing message-body chats reported separately by the current-chat recovery audit still require a source PC or backup. This does not repair or change the original chats, create Agents, attach files to Agents, or send prompts.",
      },
      preserve,
    );
    if (confirmation !== preserve) {
      return;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Cursor Setting Sync: Building Recovery Catalog",
        cancellable: true,
      },
      async (progress, cancellationToken) =>
        this.buildUnavailableChatRecoveryCatalog(
          progress,
          cancellationToken,
        ),
    );
    if (result === null) {
      void vscode.window.showInformationMessage(
        'Another Cursor window is already building the recovery catalog. Let it finish, then open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats", and select "Preserve All Safely".',
      );
      return;
    }
    const summary = recoveryCatalogCompletionSummary(result);
    if (result.indexPath === null) {
      if (
        result.cancelled ||
        result.incomplete ||
        result.auditUnknownChats > 0
      ) {
        void vscode.window.showWarningMessage(summary);
      } else {
        void vscode.window.showInformationMessage(summary);
      }
      return;
    }
    const openCatalog = "Open Recovery Catalog";
    const choice =
      result.cancelled ||
      result.incomplete ||
      result.counts["skipped-limit"] > 0 ||
      result.counts["skipped-body"] > 0 ||
      result.counts.changed > 0 ||
      result.counts.unknown > 0 ||
      result.auditUnknownChats > 0
        ? await vscode.window.showWarningMessage(summary, openCatalog)
        : await vscode.window.showInformationMessage(summary, openCatalog);
    if (choice === openCatalog) {
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(result.indexPath),
      );
    }
  }

  /** Opens one verified catalog artifact in a new, empty Agent without send. */
  async openRecoveredChatSafely(): Promise<void> {
    const catalog = await readRecoveryCatalog(this.paths.extensionStorage);
    const ready = catalog.manifest.entries.filter(
      (entry): entry is RecoveryCatalogReadyEntry =>
        entry.status === "ready",
    );
    if (ready.length === 0) {
      void vscode.window.showInformationMessage(
        'The local recovery catalog has no verified chat artifact ready to open. Open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats", and select "Preserve All Safely" first.',
      );
      return;
    }
    const items: Array<vscode.QuickPickItem & {
      entry: RecoveryCatalogReadyEntry;
    }> = ready.map((entry) => ({
        label: entry.title ?? "Untitled conversation",
        description: `${entry.composerId} (${entry.composerStorageClass})`,
        ...(
          entry.lastUpdatedAt === null || entry.lastUpdatedAt === undefined
            ? {}
            : { detail: new Date(entry.lastUpdatedAt).toLocaleString() }
        ),
        entry,
      }));
    const choice = await vscode.window.showQuickPick(items,
      {
        title: "Open a Preserved Chat Safely",
        placeHolder:
          "Choose one verified recovery artifact to attach to a new Agent",
      },
    );
    if (choice === undefined) {
      return;
    }
    const composerCursor = composerCursorFromStorageClass(
      choice.entry.composerId,
      choice.entry.composerStorageClass,
    );
    if (composerCursor === null) {
      throw new Error(
        "The recovery catalog contains an invalid exact conversation identity.",
      );
    }
    const paths = await recoveryCatalogEntryArtifactPaths(
      this.paths.extensionStorage,
      choice.entry,
    );
    const transcript = extractVisibleChatRecoveryTranscript(
      this.paths.globalDatabase,
      choice.entry.composerId,
      {
        chatCoreHash: choice.entry.chatCoreHash,
        composerCursor,
      },
    );
    const openWorkspaceUri = matchingOpenWorkspaceUri(transcript.workspaceUri);
    if (openWorkspaceUri === null) {
      void vscode.window.showWarningMessage(
        'Open the recovered conversation\'s original workspace in this Cursor window, then open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Open a Preserved Chat" again. No Agent was created and nothing was attached or sent.',
      );
      return;
    }
    const prepared = await prepareRecoveryResources(
      openWorkspaceUri,
      paths,
      stagingSourcesForCatalogEntry(choice.entry, paths),
    );
    if (prepared === null) {
      return;
    }
    if (
      prepared.remoteStaging !== null &&
      !(await reverifyRemoteStagingBeforeAgent(prepared.remoteStaging))
    ) {
      return;
    }
    // This is deliberately the final awaited preflight. Artifact reads and
    // transcript extraction and optional remote staging may take time; a
    // Cursor write during any of them must be observed before a new Agent is
    // prepared.
    const freshness = await inspectBrokenCursorChatContinuations(this.paths, {
      composerCursor,
      limits: { maxSnapshotBytesPerChat: 32 * 1024 * 1024 },
    });
    const freshDamage = freshness.broken[0];
    if (
      freshDamage === undefined ||
      freshDamage.chatCoreHash !== choice.entry.chatCoreHash ||
      freshDamage.fingerprint !== choice.entry.damageFingerprint
    ) {
      const detail =
        freshDamage === undefined &&
        (freshness.unknownChats > 0 || freshness.limitReached)
          ? "The selected conversation could not be safely re-audited."
          : "The selected conversation is now complete or changed since this catalog entry was created.";
      void vscode.window.showWarningMessage(
        `${detail} This preserved entry remains in the catalog, but it cannot be opened automatically. No Agent was created and nothing was attached or sent.${remoteStagingRetention(prepared.remoteStaging)}`,
      );
      return;
    }
    const freshWorkspaceUri = matchingOpenWorkspaceUri(transcript.workspaceUri);
    if (
      freshWorkspaceUri === null ||
      freshWorkspaceUri.scheme !== openWorkspaceUri.scheme ||
      freshWorkspaceUri.authority !== openWorkspaceUri.authority
    ) {
      void vscode.window.showWarningMessage(
        `The recovered conversation's original workspace changed or closed during verification. Open it in this Cursor window, then open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Open a Preserved Chat" again. No Agent was created and nothing was attached or sent.${remoteStagingRetention(prepared.remoteStaging)}`,
      );
      return;
    }
    const mode = await prepareVisibleRecoveryAgent(
      vscode.commands,
      prepared.resources,
    );
    if (mode !== "manual") {
      void vscode.window.showInformationMessage(
        prepared.remoteStaging === null
          ? "Cursor opened a new Agent and was asked to attach the verified recovery transcript and images. Verify the attachment chips before continuing. Nothing was sent, and the original chat was not changed."
          : `Cursor opened a new Agent and was asked to attach the verified remote START-HERE.md and recovery transcript. Selected PNGs were staged on the same remote authority and are listed by exact remote path in START-HERE.md; they were not attached as generic file chips. Verify the two Markdown attachment chips before continuing. Nothing was sent, and this extension did not rewrite the original chat; Cursor may persist the newly opened empty Agent.${remoteStagingRetention(prepared.remoteStaging)}`,
      );
      return;
    }
    const openTranscript =
      prepared.remoteStaging === null
        ? "Open Recovery Transcript"
        : "Open Remote START-HERE";
    const manualChoice = await vscode.window.showWarningMessage(
      prepared.remoteStaging === null
        ? "Cursor's supported new-Agent context command was unavailable or rejected on this build. It may have partially opened an empty Agent or attached only some files before rejecting. The catalog artifact was reverified and nothing was sent; inspect the current Agent before opening the transcript, then attach the transcript plus every listed image exactly once."
        : `Cursor's supported new-Agent context command was unavailable or rejected on this build. It may have partially opened an empty Agent or attached only some files before rejecting. The remote staged files were reverified and nothing was sent; inspect the current Agent before opening START-HERE.md, then attach START-HERE.md and the transcript only. Read selected PNGs through the exact remote paths listed there instead of attaching generic image file chips.${remoteStagingRetention(prepared.remoteStaging)}`,
      openTranscript,
    );
    if (manualChoice === openTranscript) {
      await vscode.commands.executeCommand(
        "vscode.open",
        prepared.primaryResource,
      );
    }
  }

  private async buildUnavailableChatRecoveryCatalog(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    cancellationToken: vscode.CancellationToken | undefined,
  ): Promise<RecoveryCatalogBuildResult | null> {
    let buildSession: RecoveryCatalogBuildSession | null;
    try {
      buildSession = await acquireRecoveryCatalogBuildSession(
        this.paths.extensionStorage,
        () => recoveryCatalogCancellationRequested(cancellationToken),
      );
    } catch (error) {
      if (!(error instanceof RecoveryCatalogInventoryCancelledError)) {
        throw error;
      }
      const catalog = await readRecoveryCatalog(this.paths.extensionStorage);
      return {
        counts: emptyRecoveryCatalogCounts(),
        examinedChats: 0,
        auditUnknownChats: 0,
        cancelled: true,
        incomplete: false,
        databaseChanged: false,
        retiredEntries: 0,
        ...recoveryCatalogState(catalog),
        quotaReached: null,
        indexPath: catalog.indexPath,
      };
    }
    if (buildSession === null) {
      return null;
    }
    let generationMonitor: CursorDatabaseGenerationMonitor | undefined;
    try {
      generationMonitor = await openCursorDatabaseGenerationMonitor(
        this.paths.globalDatabase,
      );
      return await this.buildUnavailableChatRecoveryCatalogPages(
        progress,
        cancellationToken,
        generationMonitor,
        buildSession,
      );
    } finally {
      try {
        generationMonitor?.database.close();
      } finally {
        try {
          await generationMonitor?.file.close();
        } finally {
          await buildSession.release();
        }
      }
    }
  }

  private async buildUnavailableChatRecoveryCatalogPages(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    cancellationToken: vscode.CancellationToken | undefined,
    generationMonitor: CursorDatabaseGenerationMonitor,
    buildSession: RecoveryCatalogBuildSession,
  ): Promise<RecoveryCatalogBuildResult> {
    const counts = emptyRecoveryCatalogCounts();
    let after: BrokenChatInspectionCursor | undefined;
    let examinedChats = 0;
    let auditUnknownChats = 0;
    let catalog = await readRecoveryCatalog(this.paths.extensionStorage);
    let indexPath: string | null = catalog.indexPath;
    const incomplete = false;
    const observedBrokenIdentities = new Set<string>();
    const pageSize = 4;
    for (;;) {
      if (recoveryCatalogCancellationRequested(cancellationToken)) {
        return {
          counts,
          examinedChats,
          auditUnknownChats,
          cancelled: true,
          incomplete,
          databaseChanged: false,
          retiredEntries: 0,
          ...recoveryCatalogState(catalog),
          quotaReached: null,
          indexPath,
        };
      }
      progress.report({
        message: `Auditing chats (${recoveryCatalogProcessedCount(counts)} catalogued)...`,
      });
      const inspection = await inspectBrokenChatContinuationsInDatabase(
        generationMonitor.database,
        {
          ...(after === undefined ? {} : { after }),
          pageAtRetentionLimit: true,
          isCancelled: () =>
            recoveryCatalogCancellationRequested(cancellationToken),
          limits: {
            maxRetainedChats: pageSize,
            maxChats: 64,
            maxSnapshotBytesPerChat: 32 * 1024 * 1024,
            maxRootProbes: 4_096,
          },
        },
      );
      examinedChats += inspection.examinedChats;
      auditUnknownChats += inspection.unknownChats;
      let quotaReached: RecoveryCatalogLimitReason | null = null;
      for (const observation of inspection.broken) {
        if (recoveryCatalogCancellationRequested(cancellationToken)) {
          break;
        }
        const composerStorageClass = composerCursorStorageClass(
          observation.composerCursor,
        );
        if (composerStorageClass === null) {
          auditUnknownChats += 1;
          this.status.log(
            `Recovery catalog skipped ${observation.composerId}: its exact SQLite identity was not safely persistable.`,
          );
          continue;
        }
        const exactIdentity = `${composerStorageClass}\0${observation.composerId}`;
        const existing = catalog.manifest.entries.find(
          (entry) =>
            entry.composerId === observation.composerId &&
            entry.composerStorageClass === composerStorageClass,
        );
        let existingReadyVerified = false;
        let existingReadyCorrupt = false;
        if (
          !observedBrokenIdentities.has(exactIdentity) &&
          observedBrokenIdentities.size >= RECOVERY_CATALOG_LIMITS.maxEntries
        ) {
          quotaReached = "entries";
          break;
        }
        observedBrokenIdentities.add(exactIdentity);
        if (existing?.status === "ready") {
          try {
            await recoveryCatalogEntryArtifactPaths(
              this.paths.extensionStorage,
              existing,
            );
            existingReadyVerified = true;
            if (
              existing.chatCoreHash === observation.chatCoreHash &&
              existing.damageFingerprint === observation.fingerprint
            ) {
              counts.ready += 1;
              continue;
            }
          } catch (error) {
            existingReadyCorrupt = true;
            this.status.log(
              `Recovery catalog will rebuild ${observation.composerId} because its current ready artifact failed verification: ${recoveryCatalogErrorMessage(error)}`,
            );
          }
        }
        if (
          existing === undefined && catalog.capacity.remainingEntries === 0
        ) {
          quotaReached = "entries";
          break;
        }
        if (
          catalog.capacity.remainingReadyArtifactBytes === 0 &&
          existing?.status !== "ready"
        ) {
          quotaReached = "artifact-bytes";
          break;
        }
        progress.report({
          message: `Preserving ${recoveryCatalogProcessedCount(counts) + 1}: ${observation.title ?? "Untitled conversation"}`,
        });
        let entry: RecoveryCatalogUpsertInput;
        try {
          entry = await this.preserveRecoveryCatalogObservation(
            observation,
            composerStorageClass,
            buildSession,
          );
        } catch (error) {
          if (error instanceof RecoveryCatalogLimitError) {
            if (existingReadyCorrupt) {
              catalog = await upsertRecoveryCatalogEntries(
                this.paths.extensionStorage,
                [
                  {
                    composerId: observation.composerId,
                    composerStorageClass,
                    chatCoreHash: observation.chatCoreHash,
                    damageFingerprint: observation.fingerprint,
                    title: observation.title,
                    lastUpdatedAt: recoveryCatalogLastUpdatedAt(
                      observation.lastUpdatedAt,
                    ),
                    status: "skipped-limit",
                  },
                ],
              );
              indexPath = catalog.indexPath;
              counts["skipped-limit"] += 1;
            }
            quotaReached = error.reason;
            break;
          }
          throw error;
        }
        if (existingReadyVerified && entry.status !== "ready") {
          counts[entry.status] += 1;
          this.status.log(
            `Recovery catalog retained the prior verified artifact for ${observation.composerId}; the current recheck returned ${entry.status}.`,
          );
          continue;
        }
        try {
          catalog = await upsertRecoveryCatalogEntries(
            this.paths.extensionStorage,
            [entry],
          );
          indexPath = catalog.indexPath;
          counts[entry.status] += 1;
        } catch (error) {
          if (error instanceof RecoveryCatalogLimitError) {
            if (existingReadyCorrupt) {
              catalog = await upsertRecoveryCatalogEntries(
                this.paths.extensionStorage,
                [
                  {
                    composerId: observation.composerId,
                    composerStorageClass,
                    chatCoreHash: observation.chatCoreHash,
                    damageFingerprint: observation.fingerprint,
                    title: observation.title,
                    lastUpdatedAt: recoveryCatalogLastUpdatedAt(
                      observation.lastUpdatedAt,
                    ),
                    status: "skipped-limit",
                  },
                ],
              );
              indexPath = catalog.indexPath;
              counts["skipped-limit"] += 1;
            }
            quotaReached = error.reason;
            break;
          }
          throw error;
        }
      }
      if (quotaReached !== null) {
        return {
          counts,
          examinedChats,
          auditUnknownChats,
          cancelled: false,
          incomplete: true,
          databaseChanged: false,
          retiredEntries: 0,
          ...recoveryCatalogState(catalog),
          quotaReached,
          indexPath,
        };
      }
      if (recoveryCatalogCancellationRequested(cancellationToken)) {
        return {
          counts,
          examinedChats,
          auditUnknownChats,
          cancelled: true,
          incomplete,
          databaseChanged: false,
          retiredEntries: 0,
          ...recoveryCatalogState(catalog),
          quotaReached: null,
          indexPath,
        };
      }
      if (inspection.complete === true) {
        let databaseChanged = true;
        try {
          databaseChanged =
            await cursorDatabaseGenerationMonitorChanged(generationMonitor);
        } catch (error) {
          this.status.log(
            `Recovery catalog could not verify that Cursor's database stayed unchanged: ${recoveryCatalogErrorMessage(error)}`,
          );
        }
        return {
          counts,
          examinedChats,
          auditUnknownChats,
          cancelled: false,
          incomplete: incomplete || databaseChanged,
          databaseChanged,
          retiredEntries: 0,
          ...recoveryCatalogState(catalog),
          quotaReached: null,
          indexPath,
        };
      }
      const next = inspection.resumeAfter;
      if (
        next === undefined ||
        next === null ||
        sameBrokenChatInspectionCursor(after, next)
      ) {
        throw new Error(
          "The bounded continuation audit did not provide a safe advancing cursor. Existing recovery catalog checkpoints were kept.",
        );
      }
      after = next;
    }
  }

  private async preserveRecoveryCatalogObservation(
    observation: BrokenChatContinuationObservation,
    composerStorageClass: ComposerIdStorageClass,
    buildSession: RecoveryCatalogBuildSession,
  ): Promise<RecoveryCatalogUpsertInput> {
    const base = {
      composerId: observation.composerId,
      composerStorageClass,
      chatCoreHash: observation.chatCoreHash,
      damageFingerprint: observation.fingerprint,
      title: observation.title,
      lastUpdatedAt: recoveryCatalogLastUpdatedAt(observation.lastUpdatedAt),
    };
    let transcript: VisibleChatRecoveryTranscript;
    try {
      transcript = extractVisibleChatRecoveryTranscript(
        this.paths.globalDatabase,
        observation.composerId,
        {
          chatCoreHash: observation.chatCoreHash,
          composerCursor: observation.composerCursor,
        },
      );
    } catch (error) {
      const status = recoveryCatalogExtractionFailureStatus(error);
      this.status.log(
        `Recovery catalog skipped ${observation.composerId} (${status}): ${recoveryCatalogErrorMessage(error)}`,
      );
      return { ...base, status };
    }

    let freshInspection: {
      damage: BrokenChatContinuationObservation | undefined;
      auditedChats: number;
      unknownChats: number;
      limitReached: boolean;
    };
    try {
      const freshness = await inspectBrokenCursorChatContinuations(this.paths, {
        composerCursor: observation.composerCursor,
        limits: { maxSnapshotBytesPerChat: 32 * 1024 * 1024 },
      });
      freshInspection = {
        damage: freshness.broken[0],
        auditedChats: freshness.auditedChats,
        unknownChats: freshness.unknownChats,
        limitReached: freshness.limitReached,
      };
    } catch (error) {
      this.status.log(
        `Recovery catalog could not recheck ${observation.composerId} (unknown): ${recoveryCatalogErrorMessage(error)}`,
      );
      return { ...base, status: "unknown" };
    }
    if (freshInspection.damage === undefined) {
      const status: RecoveryCatalogStatus =
        freshInspection.auditedChats === 1 &&
        freshInspection.unknownChats === 0 &&
        !freshInspection.limitReached
          ? "changed"
          : freshInspection.limitReached
            ? "skipped-limit"
            : "unknown";
      return { ...base, status };
    }
    if (
      freshInspection.damage.chatCoreHash !== observation.chatCoreHash ||
      freshInspection.damage.fingerprint !== observation.fingerprint
    ) {
      return { ...base, status: "changed" };
    }
    try {
      const artifact = await writeVisibleChatRecoveryArtifact(
        this.paths.extensionStorage,
        this.paths.workspaceStorageRoot,
        transcript,
        {
          namespace: "catalog",
          composerStorageClass,
          beforeCatalogWrite: (totalBytes, fileCount) =>
            buildSession.reserveArtifact(totalBytes, fileCount),
        },
      );
      return { ...base, status: "ready", artifact };
    } catch (error) {
      if (error instanceof RecoveryCatalogLimitError) {
        throw error;
      }
      const status = recoveryCatalogArtifactFailureStatus(error);
      this.status.log(
        `Recovery catalog could not materialize ${observation.composerId} (${status}): ${recoveryCatalogErrorMessage(error)}`,
      );
      return { ...base, status };
    }
  }

  private async repairUnavailableChatsPage(
    after: BrokenChatInspectionCursor | undefined,
    auditProgress: ChatRepairAuditProgress,
  ): Promise<BrokenChatInspectionCursor | undefined> {
    const repository = this.requireRepository();
    const configuredBlock = resourceConfigurationBlockReason("chat", {
      syncChat: this.configuration.syncChat,
      syncWorkspaceStorage: this.configuration.syncWorkspaceStorage,
    });
    if (configuredBlock !== null) {
      void vscode.window.showWarningMessage(
        `Unavailable chat repair is disabled: ${configuredBlock}`,
      );
      return;
    }
    assertCompatibleForDatabaseWrite(this.compatibility);
    const chatRepairInspectionLimits = {
      // A portable repair candidate is fully materialized in the extension
      // host. Refuse one item at the smaller of the command RAM bound and the
      // repository's publish policy; a snapshot that cannot be published must
      // never be built merely to discover that fact afterwards.
      maxRetainedBytes: Math.min(
        DEFAULT_BROKEN_CHAT_INSPECTION_LIMITS.maxRetainedBytes,
        repository.maxPayloadBytes,
      ),
    };
    const repairHistorySourceByteLimit = Math.min(
      MAX_CHAT_REPAIR_HISTORY_SOURCE_BYTES,
      repository.maxPayloadBytes,
    );
    const repairHistoryAggregateByteLimit =
      MAX_CHAT_REPAIR_HISTORY_AGGREGATE_BYTES;
    const repairOutputByteLimit = Math.min(
      MAX_CHAT_REPAIR_OUTPUT_AGGREGATE_BYTES,
      repository.maxPayloadBytes,
    );

    // The live database walk can take minutes on a multi-gigabyte state.vscdb
    // and does not touch repository state. Keep it outside sync.lock so other
    // windows can continue their normal cycles while this command only reads.
    const inspection = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report("Checking which chat messages are unavailable...");
        return inspectBrokenCursorChats(this.paths, {
          limits: chatRepairInspectionLimits,
          ...(after === undefined ? {} : { after }),
          pageAtRetentionLimit: true,
        });
      },
    );
    auditProgress.examinedChats += inspection.examinedChats;
    auditProgress.oversizedChats += inspection.oversizedChats;
    auditProgress.unresolvedLimitReached ||=
      inspection.unresolvedLimitReached;
    const observations = inspection.broken;
    const bubbleIncompleteDetail = chatRepairDeferredInspectionDetail(
      inspection.deferredBrokenChats,
      0,
      inspection.snapshotByteLimit,
      inspection.resumeAfter !== null,
    );
    if (observations.length === 0) {
      // A chat can render every legacy bubble and still be impossible to
      // continue because pre-v2 sync omitted Cursor's content-addressed
      // conversation graph. Run this second, more expensive pass only after
      // the legacy repair path has proved there are no bubble repairs to plan.
      const continuationInspection = await this.withProgress(
        "Cursor Setting Sync",
        async (report) => {
          report("Checking chat continuation data...");
          return inspectBrokenCursorChatContinuations(this.paths, {
            limits: {
              maxSnapshotBytesPerChat:
                chatRepairInspectionLimits.maxRetainedBytes,
            },
          });
        },
      );
      const continuationDamage = continuationInspection.broken;
      const incompleteDetail = [
        chatRepairAuditProgressDetail(
          auditProgress,
          inspection.snapshotByteLimit,
        ),
        continuationAuditIncompleteDetail(
          continuationInspection.unknownChats,
          continuationInspection.unknownReasonCounts,
          continuationInspection.limitReached,
        ),
      ]
        .filter((detail) => detail.length > 0)
        .join(" ");
      if (continuationDamage.length === 0) {
        if (
          auditProgress.unavailableWithoutSource > 0 ||
          auditProgress.oversizedChats > 0 ||
          auditProgress.historyBudgetDeferred > 0 ||
          auditProgress.unresolvedLimitReached ||
          continuationInspection.unknownChats > 0 ||
          continuationInspection.limitReached
        ) {
          const hadMessageBodyFinding =
            auditProgress.unavailableWithoutSource > 0 ||
            auditProgress.oversizedChats > 0 ||
            auditProgress.historyBudgetDeferred > 0 ||
            auditProgress.unresolvedLimitReached;
          void vscode.window.showWarningMessage(
            `${
              hadMessageBodyFinding
                ? "The bounded audit found no chat repair it can safely apply"
                : "No definite unavailable chat data was found"
            } after checking ${auditProgress.examinedChats} message bodies and ${continuationInspection.examinedChats} continuation records. ${incompleteDetail} Nothing was changed, and this is not an all-clear result.`,
          );
          return;
        }
        void vscode.window.showInformationMessage(
          `Checked ${auditProgress.examinedChats} Cursor conversation message bodies and ${continuationInspection.auditedChats} continuation records. No referenced chat message rows or reachable continuation blobs are unavailable.`,
        );
        return;
      }

      const completePendingResourceIds = new Set<string>();
      const oversizedContinuationSourceResourceIds = new Set<string>();
      const continuationSourceLock = await this.withProgress(
        "Cursor Setting Sync",
        async (report) => {
          report("Checking synchronized continuation recovery data...");
          return this.takeCommandLock(repository, report);
        },
      );
      try {
        await this.openGitWindow(repository);
        await repository.refreshState();
        const checkpoint = await absorbedCheckpointManifest(repository);
        const freshState = structuredClone(repository.state);
        const reconciliation = new EventReconciler().reconcile(
          await repository.listEvents(),
          freshState,
          checkpoint,
        );
        if (reconciliation.warnings.length === 0) {
          Object.assign(repository.state, freshState);
          for (const observation of continuationDamage) {
            const currentTips =
              repository.state.tips[observation.resourceId] ?? [];
            const tip = currentTips.length === 1 ? currentTips[0] : undefined;
            if (
              tip === undefined ||
              tip.kind !== "chat" ||
              tip.operation !== "put" ||
              tip.payload === undefined ||
              tip.metadata?.chatSnapshotSchemaVersion !== 2 ||
              tip.metadata?.agentKvMissingCount !== 0 ||
              this.resourceApplyBlockReason(tip) !== null
            ) {
              continue;
            }
            const declaredSourceBytes = tip.payload.plainBytes;
            if (
              !Number.isSafeInteger(declaredSourceBytes) ||
              declaredSourceBytes < 0 ||
              declaredSourceBytes > repairHistorySourceByteLimit
            ) {
              // The payload reference is authenticated by its event. Gate on
              // that declaration before tryReadVersion decrypts/allocates a
              // potentially repository-sized complete-v2 snapshot.
              oversizedContinuationSourceResourceIds.add(
                observation.resourceId,
              );
              continue;
            }
            try {
              const source = await repository.tryReadVersion(tip.versionId);
              if (
                source === null ||
                source.content === null ||
                source.change.resourceId !== observation.resourceId ||
                source.change.kind !== "chat" ||
                source.change.operation !== "put" ||
                source.change.semanticHash !== tip.semanticHash ||
                sha256(source.content) !== source.change.semanticHash ||
                databaseApplyBlockReason(
                  "chat",
                  effectiveVersionProducer(
                    source.change.metadata,
                    source.producer,
                  ),
                  this.compatibility,
                ) !== null
              ) {
                continue;
              }
              const snapshot = parsePortableChatSnapshot(source.content);
              if (
                snapshot.composerId !== observation.composerId ||
                !isPortableChatSnapshotV2(snapshot) ||
                snapshot.agentKv.missingIds.length !== 0
              ) {
                continue;
              }
              const continuationClosure =
                await verifyPortableChatContinuationClosure(snapshot, {
                  limits: {
                    maxNodes: MAX_CHAT_REPAIR_AGENT_KV_IDS,
                    maxBytes: MAX_CHAT_REPAIR_AGENT_KV_BYTES,
                    maxDepth: 256,
                    maxProtobufDepth: 64,
                  },
                });
              if (continuationClosure.status !== "complete") {
                continue;
              }
              const sourceOrigin = effectiveSyncOrigin(source.change.metadata);
              if (
                sourceOrigin !== "agent-kv-enrichment" &&
                sourceOrigin !== "automatic-chat-repair"
              ) {
                const declaredCoreHash = source.change.metadata?.chatCoreHash;
                if (
                  typeof declaredCoreHash !== "string" ||
                  declaredCoreHash !== observation.chatCoreHash ||
                  declaredCoreHash !== portableChatCoreHash(snapshot)
                ) {
                  continue;
                }
              }
              const materializedIds = new Set(
                snapshot.agentKv.blobs.map((blob) =>
                  blob.key.slice(AGENT_KV_BLOB_PREFIX.length),
                ),
              );
              if (
                !observation.unavailableRootIds.every((id) =>
                  materializedIds.has(id),
                )
              ) {
                continue;
              }
              queuePending(repository, {
                resourceId: observation.resourceId,
                tip,
                changed: true,
              });
              completePendingResourceIds.add(observation.resourceId);
            } catch {
              // A metadata claim without a readable, matching payload is not a
              // recovery source. The source-PC guidance below remains safe.
            }
          }
          if (completePendingResourceIds.size > 0) {
            await repository.saveState();
          }
        } else {
          this.status.log(
            `Continuation recovery source check was deferred by repository stream warning: ${reconciliation.warnings[0]}`,
          );
        }
      } finally {
        await continuationSourceLock.release();
      }
      const unavailableRootCount = continuationDamage.reduce(
        (total, observation) => total + observation.unavailableRootCount,
        0,
      );
      const damageSummary = `${continuationDamage.length} Cursor conversation${
        continuationDamage.length === 1 ? " has" : "s have"
      } ${unavailableRootCount} unavailable continuation blob${
        unavailableRootCount === 1 ? "" : "s"
      }`;
      if (completePendingResourceIds.size === continuationDamage.length) {
        const restart = "Restart to Apply";
        const choice = await vscode.window.showInformationMessage(
          `${damageSummary}. Every affected conversation already has a complete synchronized v2 copy queued on this PC. Choose Restart to Apply to write it transactionally.${
            incompleteDetail.length === 0 ? "" : ` ${incompleteDetail}`
          }`,
          restart,
        );
        if (choice === restart) {
          await this.restartToApply();
        }
        return;
      }

      const lackingSourceCount =
        continuationDamage.length - completePendingResourceIds.size;
      const oversizedSourceDetail =
        oversizedContinuationSourceResourceIds.size === 0
          ? ""
          : ` ${oversizedContinuationSourceResourceIds.size} synchronized complete-v2 source${
              oversizedContinuationSourceResourceIds.size === 1 ? "" : "s"
            } exceeded the bounded ${formatBytes(
              repairHistorySourceByteLimit,
            )} repair source limit (or lacked a trustworthy declared size) and ${
              oversizedContinuationSourceResourceIds.size === 1 ? "was" : "were"
            } not read.`;
      const incompleteSourceWarning = `${damageSummary}. ${lackingSourceCount} affected conversation${
          lackingSourceCount === 1 ? "" : "s"
        } ${lackingSourceCount === 1 ? "does" : "do"} not have a complete synchronized v2 copy queued here: this PC and the synchronized legacy history lack the continuation blobs needed to resume ${
          lackingSourceCount === 1 ? "it" : "them"
        }. Nothing was changed.${oversizedSourceDetail} Update Cursor Setting Sync on a PC where the affected chat still continues and let its automatic cycle finish (or choose Manage → Sync & Apply Now); then let this PC synchronize and close Cursor normally to apply, or choose Manage → Sync & Apply Now. Preserve All Safely catalogs only definite continuation-damaged chats whose visible message bodies can still be verified; separately reported missing message-body chats still require a source PC or database backup.${
          incompleteDetail.length === 0 ? "" : ` ${incompleteDetail}`
        }`;
      const continueSafely = "Continue Safely in New Agent";
      const preserveAllSafely = "Preserve All Safely";
      const lackingSourceDamage = continuationDamage.filter(
        (observation) =>
          !completePendingResourceIds.has(observation.resourceId),
      );
      if (completePendingResourceIds.size === 0) {
        const choice = await vscode.window.showWarningMessage(
          incompleteSourceWarning,
          preserveAllSafely,
          continueSafely,
        );
        if (choice === preserveAllSafely) {
          await this.preserveAllUnavailableChatsSafely();
        } else if (choice === continueSafely) {
          await this.continueUnavailableChatSafely(lackingSourceDamage);
        }
        return;
      }
      const restart = "Restart to Apply";
      const choice = await vscode.window.showWarningMessage(
        `${incompleteSourceWarning} ${completePendingResourceIds.size} other affected conversation${
          completePendingResourceIds.size === 1 ? " already has" : "s already have"
        } a verified complete v2 copy queued and can be applied now.`,
        restart,
        preserveAllSafely,
        continueSafely,
      );
      if (choice === restart) {
        await this.restartToApply();
      } else if (choice === preserveAllSafely) {
        await this.preserveAllUnavailableChatsSafely();
      } else if (choice === continueSafely) {
        await this.continueUnavailableChatSafely(lackingSourceDamage);
      }
      return;
    }

    const deferredInspectionDetail = bubbleIncompleteDetail;

    const plans: PlannedChatRepair[] = [];
    let alreadyQueued = 0;
    const historyBudgetDeferredResourceIds = new Set<string>();
    let historyCheckpoint: CheckpointManifest | null;
    let acceptedHistoryEventHashes: Set<string>;
    const historyResourceIds = new Set<string>();
    const historyRoots = new Map<string, string[]>();
    const eligibleTips = new Map<string, ResourceTip[]>();
    const inspectionLock = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report("Refreshing synchronized chat history...");
        return this.takeCommandLock(repository, report);
      },
    );
    try {
      await this.openGitWindow(repository);
      await repository.refreshState();
      historyCheckpoint = await absorbedCheckpointManifest(repository);
      const reconciledState = structuredClone(repository.state);
      const reconciliation = new EventReconciler().reconcile(
        await repository.listEvents(),
        reconciledState,
        historyCheckpoint,
      );
      if (reconciliation.warnings.length > 0) {
        this.status.log(
          `Unavailable chat repair blocked by repository stream warning: ${reconciliation.warnings[0]}`,
        );
        void vscode.window.showWarningMessage(
          `Chats cannot be repaired while the repository event stream is incomplete. Synchronize again after the shared folder settles. ${reconciliation.warnings[0]}`,
        );
        return;
      }
      Object.assign(repository.state, reconciledState);
      acceptedHistoryEventHashes = new Set(reconciliation.acceptedEventHashes);
      const conflicted = new Set(
        repository.state.conflicts
          .filter((conflict) => conflict.resolvedAt === undefined)
          .map((conflict) => conflict.resourceId),
      );
      for (const observation of observations) {
        const tips = repository.state.tips[observation.resourceId] ?? [];
        const tip = tips.length === 1 ? tips[0] : undefined;
        if (
          tip === undefined ||
          tip.kind !== "chat" ||
          tip.operation !== "put" ||
          conflicted.has(observation.resourceId) ||
          databaseApplyBlockReason(
              tip.kind,
              effectiveTipProducer(tip),
              this.compatibility,
            ) !== null
        ) {
          continue;
        }
        if (
          isAutomaticChatRepairMetadata(tip.metadata) &&
          tip.metadata?.repairFingerprint === observation.fingerprint
        ) {
          queuePending(repository, {
            resourceId: observation.resourceId,
            tip,
            changed: true,
          });
          alreadyQueued += 1;
          continue;
        }
        // Capture immutable identities under the lock. History events and
        // payload objects are content-addressed, so their comparatively slow
        // traversal can run after release; the second phase revalidates these
        // exact tips and the live damage fingerprint before publishing.
        const capturedTips = [...tips];
        eligibleTips.set(observation.resourceId, capturedTips);
        historyResourceIds.add(observation.resourceId);
        historyRoots.set(
          observation.resourceId,
          capturedTips.map((candidate) => candidate.versionId),
        );
      }
      if (alreadyQueued > 0) {
        await repository.saveState();
      }
    } finally {
      await inspectionLock.release();
    }

    // Walking every accepted event and decrypting candidate payloads is the
    // expensive half of planning. It is read-only and bounded to the captured
    // roots above, so it belongs outside the machine-wide write lock.
    const histories =
      historyResourceIds.size === 0
        ? new Map<string, ResourceHistoryEntry[]>()
        : await repository.listReachableResourceHistories(
            historyResourceIds,
            historyRoots,
            acceptedHistoryEventHashes,
            historyCheckpoint,
          );
    for (const observation of observations) {
      const tips = eligibleTips.get(observation.resourceId);
      if (tips === undefined) {
        continue;
      }
      // Histories are newest-first. Keep only the unavailable rows carried by
      // newer partial versions, then stop as soon as the first version carrying
      // every unavailable row is found. Reading older payloads cannot improve
      // that choice, and retaining whole chat snapshots here made a long
      // conversation's complete history a temporary RAM copy.
      const unavailableKeys = new Set(observation.unavailableBubbleKeys);
      const newerPartialCandidates: ChatRepairCandidate[] = [];
      const newerPartialVersions: Array<{
        versionId: string;
        plainBytes: number;
      }> = [];
      const compatibleHistory = (
        histories.get(observation.resourceId) ?? []
      ).filter(
        (summary) =>
          summary.kind === "chat" &&
          summary.operation === "put" &&
          databaseApplyBlockReason(
            summary.kind,
            effectiveVersionProducer(summary.metadata, summary.producer),
            this.compatibility,
          ) === null,
      );
      let retainedCandidateRows = 0;
      let retainedCandidateBytes = 0;
      let historyDeferred = false;
      let repair: Extract<
        ReturnType<typeof buildChatRepairSnapshot>,
        { status: "repairable" }
      > | null = null;
      for (const summary of compatibleHistory) {
        const sourcePlainBytes = summary.plainBytes;
        if (
          sourcePlainBytes === null ||
          !Number.isSafeInteger(sourcePlainBytes) ||
          sourcePlainBytes < 0 ||
          sourcePlainBytes > repairHistorySourceByteLimit
        ) {
          // Bound each sequential source, not the sum of sources already read
          // and released. A 40 MiB partial followed by a 30 MiB partial and a
          // 1 MiB complete source must be able to make progress without a
          // persistent history cursor. The retained candidate union below is
          // the aggregate that determines peak memory.
          historyBudgetDeferredResourceIds.add(observation.resourceId);
          historyDeferred = true;
          break;
        }
        const data = await repository.tryReadVersion(summary.versionId);
        if (
          data === null ||
          data.content === null ||
          data.change.resourceId !== observation.resourceId ||
          data.change.kind !== "chat" ||
          data.change.operation !== "put" ||
          data.change.payload?.plainBytes !== sourcePlainBytes ||
          sha256(data.content) !== data.change.semanticHash
        ) {
          continue;
        }
        try {
          const candidate = chatRepairCandidateForUnavailableRows(
            summary.versionId,
            data.content,
            observation,
            unavailableKeys,
          );
          if (candidate === null) {
            continue;
          }
          let candidateBytes =
            Buffer.byteLength(summary.versionId, "utf8") + 64;
          for (const row of candidate.snapshot.bubbles) {
            candidateBytes += canonicalBytes(row).byteLength + 1;
          }
          if (
            retainedCandidateRows + candidate.snapshot.bubbles.length >
              MAX_CHAT_REPAIR_BUBBLE_ROWS ||
            retainedCandidateBytes + candidateBytes >
              repairHistoryAggregateByteLimit
          ) {
            historyBudgetDeferredResourceIds.add(observation.resourceId);
            historyDeferred = true;
            break;
          }
          retainedCandidateRows += candidate.snapshot.bubbles.length;
          retainedCandidateBytes += candidateBytes;
          const candidateAlone = buildChatRepairSnapshot(
            observation.snapshot,
            [candidate],
          );
          if (candidateAlone.status !== "repairable") {
            newerPartialCandidates.push(candidate);
            newerPartialVersions.push({
              versionId: summary.versionId,
              plainBytes: sourcePlainBytes,
            });
            continue;
          }
          newerPartialCandidates.push(candidate);
          newerPartialVersions.push({
            versionId: summary.versionId,
            plainBytes: sourcePlainBytes,
          });
          const withNewerDisagreementCheck = buildChatRepairSnapshot(
            observation.snapshot,
            newerPartialCandidates,
          );
          if (withNewerDisagreementCheck.status === "repairable") {
            repair = withNewerDisagreementCheck;
          }
          // This is the newest complete source. If a newer partial version
          // disagreed, older versions cannot make that ambiguity safe.
          break;
        } catch {
          // An unreadable historical payload is not a recovery source. The
          // next trusted version may still contain every missing row.
        }
      }
      if (historyDeferred || repair === null) {
        continue;
      }
      plans.push({
        resourceId: observation.resourceId,
        label: chatRepairLabel(observation),
        expectedTipIds: tips.map((candidate) => candidate.versionId).sort(),
        fingerprint: observation.fingerprint,
        candidateVersions: newerPartialVersions,
        sourceVersionId: repair.sourceVersionId,
        repairedBubbleCount: repair.repairedBubbleCount,
      });
    }

    const historyBudgetDeferredDetail =
      historyBudgetDeferredResourceIds.size === 0
        ? ""
        : `${historyBudgetDeferredResourceIds.size} damaged conversation${
            historyBudgetDeferredResourceIds.size === 1 ? " was" : "s were"
          } deferred because synchronized repair history exceeded the bounded ${formatBytes(
            repairHistorySourceByteLimit,
          )} per-source or ${formatBytes(
            repairHistoryAggregateByteLimit,
          )} retained-candidate memory limit. A source known from authenticated metadata to be oversized was not read; over-budget retained candidates were discarded. Nothing was changed for those conversations, and this is not an all-clear result.`;

    if (plans.length === 0) {
      auditProgress.historyBudgetDeferred +=
        historyBudgetDeferredResourceIds.size;
      auditProgress.unavailableWithoutSource += Math.max(
        0,
        observations.length -
          alreadyQueued -
          historyBudgetDeferredResourceIds.size,
      );
      if (alreadyQueued > 0) {
        const restart = "Restart to Apply";
        const choice = await vscode.window.showInformationMessage(
          `${alreadyQueued} chat repair${alreadyQueued === 1 ? " is" : "s are"} already queued.${
            deferredInspectionDetail.length === 0
              ? ""
              : ` ${deferredInspectionDetail}`
          }${
            historyBudgetDeferredDetail.length === 0
              ? ""
              : ` ${historyBudgetDeferredDetail}`
          }`,
          restart,
        );
        if (choice === restart) {
          await this.restartToApply();
        }
        return;
      }
      const next = inspection.resumeAfter ?? inspection.scannedThrough;
      if (next !== null && !sameBrokenChatInspectionCursor(after, next)) {
        if (inspection.resumeAfter !== null) {
          // The retention-boundary chat was reference-audited on this page but
          // deliberately not retained. The next page starts with that same
          // chat, so count it there instead of reporting a duplicate audit.
          auditProgress.examinedChats = Math.max(
            0,
            auditProgress.examinedChats - 1,
          );
        }
        return next;
      }
      void vscode.window.showWarningMessage(
        `${chatRepairAuditProgressDetail(
          auditProgress,
          inspection.snapshotByteLimit,
        )} Nothing was changed.`,
      );
      return;
    }

    const skipped =
      auditProgress.unavailableWithoutSource +
      observations.length -
      plans.length -
      alreadyQueued;
    const detailLines = plans.slice(0, 8).map(
      (plan) =>
        `• ${plan.label}: ${plan.repairedBubbleCount} unavailable message${
          plan.repairedBubbleCount === 1 ? "" : "s"
        }`,
    );
    if (plans.length > detailLines.length) {
      detailLines.push(`• and ${plans.length - detailLines.length} more`);
    }
    const repairNow = "Repair and Restart";
    const queueRepair = "Queue Repair";
    const choice = await vscode.window.showWarningMessage(
      `Repair ${plans.length} unavailable Cursor conversation${plans.length === 1 ? "" : "s"}?`,
      {
        modal: true,
        detail: `${detailLines.join("\n")}${
          skipped <= 0
            ? ""
            : `\n\n${skipped} additional damaged conversation${skipped === 1 ? " has" : "s have"} no unambiguous synchronized source and will be left unchanged.`
        }${
          deferredInspectionDetail.length === 0
            ? ""
            : `\n\n${deferredInspectionDetail}`
        }${
          historyBudgetDeferredDetail.length === 0
            ? ""
            : `\n\n${historyBudgetDeferredDetail}`
        }\n\nOnly referenced missing or unreadable message rows are recovered. Existing valid messages, the live conversation header and composerData are not replaced. Cursor must be closed for the transactional write; a database backup is created first.`,
      },
      repairNow,
      queueRepair,
    );
    if (choice !== repairNow && choice !== queueRepair) {
      return;
    }

    // Re-read the live database after the modal, but do not monopolize the
    // repository lock while SQLite walks it. The originating offline helper
    // performs the definitive fingerprint check again in the write
    // transaction, so a chat changing after this read still fails closed.
    const plannedResourceIds = new Set(
      plans.map((plan) => plan.resourceId),
    );
    const freshInspection = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report("Rechecking unavailable chat messages...");
        return inspectBrokenCursorChats(this.paths, {
          resourceIds: plannedResourceIds,
          limits: chatRepairInspectionLimits,
        });
      },
    );
    const freshInspectionDetail = chatRepairFreshInspectionDetail(
      freshInspection.deferredBrokenChats,
      freshInspection.oversizedChats,
      freshInspection.snapshotByteLimit,
      freshInspection.unresolvedLimitReached,
    );
    const freshByResource = new Map(
      freshInspection.broken.map((observation) => [
        observation.resourceId,
        observation,
      ]),
    );
    const publishedRepairResourceIds: string[] = [];
    let changedWhileConfirming = 0;
    const applyLock = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report("Rechecking chat repairs before publishing...");
        return this.takeCommandLock(repository, report);
      },
    );
    try {
      if (this.repository !== repository) {
        void vscode.window.showWarningMessage(
          "Chat repair stopped because the synchronization repository changed while confirmation was open.",
        );
        return;
      }
      const freshConfiguredBlock = resourceConfigurationBlockReason("chat", {
        syncChat: this.configuration.syncChat,
        syncWorkspaceStorage: this.configuration.syncWorkspaceStorage,
      });
      if (freshConfiguredBlock !== null) {
        void vscode.window.showWarningMessage(
          `Chat repair is no longer available: ${freshConfiguredBlock}`,
        );
        return;
      }
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      const checkpoint = await absorbedCheckpointManifest(repository);
      const freshState = structuredClone(repository.state);
      const reconciliation = new EventReconciler().reconcile(
        await repository.listEvents(),
        freshState,
        checkpoint,
      );
      if (reconciliation.warnings.length > 0) {
        void vscode.window.showWarningMessage(
          `Chat repair stopped because the repository event stream is incomplete. Synchronize again after the shared folder settles. ${reconciliation.warnings[0]}`,
        );
        return;
      }
      Object.assign(repository.state, freshState);
      const snapshots: ResourceSnapshot[] = [];
      let retainedRepairOutputBytes = 0;
      let confirmationBudgetDeferred = 0;
      for (const plan of plans) {
        const observation = freshByResource.get(plan.resourceId);
        const freshTips = repository.state.tips[plan.resourceId] ?? [];
        const conflict = repository.state.conflicts.some(
          (item) =>
            item.resourceId === plan.resourceId && item.resolvedAt === undefined,
        );
        if (
          observation === undefined ||
          observation.fingerprint !== plan.fingerprint ||
          !restoreTargetIsUnchanged(
            plan.expectedTipIds,
            freshTips,
            "chat",
            conflict,
          )
        ) {
          changedWhileConfirming += 1;
          continue;
        }
        let planHistoryFits = true;
        for (const candidate of plan.candidateVersions) {
          if (
            !Number.isSafeInteger(candidate.plainBytes) ||
            candidate.plainBytes < 0 ||
            candidate.plainBytes > repairHistorySourceByteLimit
          ) {
            planHistoryFits = false;
            break;
          }
        }
        if (!planHistoryFits) {
          // Preflight the complete plan before reading its first object. This
          // avoids retaining a partial union after a source whose authenticated
          // declared size can never fit the per-source work budget.
          confirmationBudgetDeferred += 1;
          changedWhileConfirming += 1;
          continue;
        }
        const candidates: ChatRepairCandidate[] = [];
        const retainedRows = createChatRepairBubbleAccumulator(
          repairOutputByteLimit,
        );
        const retainedAgentKv = createChatRepairAgentKvAccumulator();
        const unavailableKeys = new Set(observation.unavailableBubbleKeys);
        let candidateInvalid = false;
        for (const candidateVersion of plan.candidateVersions) {
          const source = await repository.tryReadVersion(
            candidateVersion.versionId,
          );
          if (
            source === null ||
            source.content === null ||
            source.change.resourceId !== plan.resourceId ||
            source.change.kind !== "chat" ||
            source.change.operation !== "put" ||
            source.change.payload?.plainBytes !==
              candidateVersion.plainBytes ||
            sha256(source.content) !== source.change.semanticHash ||
            databaseApplyBlockReason(
              "chat",
              effectiveVersionProducer(source.change.metadata, source.producer),
              this.compatibility,
            ) !== null
          ) {
            candidateInvalid = true;
            break;
          }
          try {
            // Parse one full payload at a time. The decision candidates retain
            // only missing keys, while a single newest-usable Map preserves
            // the full trusted union required by new peers and checkpoints.
            // Peak memory is therefore the final union plus one parsed payload,
            // not candidate count times the entire conversation size.
            const parsed = parseChatRepairCandidate(
              candidateVersion.versionId,
              source.content,
              observation,
              unavailableKeys,
            );
            if (parsed === null) {
              candidateInvalid = true;
              break;
            }
            if (!retainNewestUsableChatRows(retainedRows, parsed.rows)) {
              confirmationBudgetDeferred += 1;
              candidateInvalid = true;
              break;
            }
            if (
              parsed.agentKv !== null &&
              !retainChatRepairAgentKv(
                retainedAgentKv,
                parsed.agentKv,
                retainedRows,
              )
            ) {
              confirmationBudgetDeferred += 1;
              candidateInvalid = true;
              break;
            }
            candidates.push(parsed.candidate);
          } catch {
            candidateInvalid = true;
            break;
          }
        }
        const decision = candidateInvalid
          ? null
          : buildChatRepairSnapshot(observation.snapshot, candidates);
        if (
          decision === null ||
          decision.status !== "repairable" ||
          decision.sourceVersionId !== plan.sourceVersionId
        ) {
          changedWhileConfirming += 1;
          continue;
        }
        const rebuilt = buildChatRepairSnapshot(observation.snapshot, [
          {
            versionId: decision.sourceVersionId,
            snapshot: {
              ...observation.snapshot,
              bubbles: [...retainedRows.rows.values()],
            },
          },
        ]);
        if (
          rebuilt.status !== "repairable" ||
          rebuilt.sourceVersionId !== plan.sourceVersionId
        ) {
          changedWhileConfirming += 1;
          continue;
        }
        if (retainedAgentKv.sawV2) {
          const coreRoots = extractBoundedChatCoreAgentKvRoots(
            rebuilt.snapshot,
          );
          if (
            coreRoots === null ||
            !retainChatRepairAgentKv(
              retainedAgentKv,
              {
                blobs: [],
                referencedIds: coreRoots,
                missingIds: coreRoots,
              },
              retainedRows,
            )
          ) {
            if (coreRoots !== null) {
              confirmationBudgetDeferred += 1;
            }
            changedWhileConfirming += 1;
            continue;
          }
        }
        const repairSnapshot = retainedAgentKv.sawV2
          ? parsePortableChatSnapshot(
              canonicalBytes({
                ...rebuilt.snapshot,
                schemaVersion: 2,
                agentKv: materializeChatRepairAgentKv(retainedAgentKv),
              }),
            )
          : rebuilt.snapshot;
        const content = canonicalBytes(repairSnapshot);
        if (
          content.byteLength > repairOutputByteLimit ||
          retainedRepairOutputBytes + content.byteLength >
            MAX_CHAT_REPAIR_OUTPUT_AGGREGATE_BYTES
        ) {
          confirmationBudgetDeferred += 1;
          changedWhileConfirming += 1;
          continue;
        }
        retainedRepairOutputBytes += content.byteLength;
        const currentTip = freshTips[0];
        snapshots.push({
          resourceId: plan.resourceId,
          kind: "chat",
          content,
          semanticHash: sha256(content),
          parents: freshTips.map((tip) => tip.versionId),
          metadata: {
            ...chatMetadataForExactPayload(currentTip?.metadata, content),
            syncOrigin: "automatic-chat-repair",
            repairOriginDeviceId: repository.state.device.deviceId,
            repairFingerprint: observation.fingerprint,
            repairedBubbleCount: rebuilt.repairedBubbleCount,
          },
        });
      }
      if (snapshots.length === 0) {
        void vscode.window.showWarningMessage(
          `The damaged chats or synchronized versions changed while confirmation was open${
            confirmationBudgetDeferred === 0
              ? ""
              : `, or ${confirmationBudgetDeferred} repair${confirmationBudgetDeferred === 1 ? " exceeded" : "s exceeded"} the bounded history/output memory limit`
          }. Nothing was changed; open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats" again.${
            freshInspectionDetail.length === 0
              ? ""
              : ` ${freshInspectionDetail}`
          }`,
        );
        return;
      }
      await publishInBatches(repository, snapshots, []);
      publishedRepairResourceIds.push(
        ...snapshots.map((snapshot) => snapshot.resourceId),
      );
      await this.commitGitWindow(
        gitActive,
        repository.root,
        `sync(${repository.state.device.deviceId.slice(0, 8)}): repair ${snapshots.length} chat(s)`,
      );
    } finally {
      await applyLock.release();
    }

    await this.syncNow(true);
    if (choice === repairNow) {
      if (freshInspectionDetail.length > 0) {
        void vscode.window.showWarningMessage(freshInspectionDetail);
      }
      await this.restartToApply();
      return;
    }
    void vscode.window.showInformationMessage(
      `${publishedRepairResourceIds.length} chat repair${publishedRepairResourceIds.length === 1 ? " is" : "s are"} queued${
        changedWhileConfirming === 0
          ? "."
          : `; ${changedWhileConfirming} changed or exceeded a bounded repair memory limit during confirmation and was left untouched.`
      } Open "${RESTART_TO_APPLY_TITLE}" when you are ready to close Cursor and apply the transactional repair.${
        [
          deferredInspectionDetail,
          freshInspectionDetail,
          historyBudgetDeferredDetail,
          chatRepairAuditProgressDetail(
            auditProgress,
            inspection.snapshotByteLimit,
          ),
        ]
          .filter((detail) => detail.length > 0)
          .map((detail) => ` ${detail}`)
          .join("")
      }`,
    );
  }

  async restoreVersion(): Promise<void> {
    const repository = this.requireRepository();
    let historyCheckpoint: CheckpointManifest | null = null;
    let acceptedHistoryEventHashes = new Set<string>();
    const refreshLock = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report("Reading version history...");
        return this.takeCommandLock(repository, report);
      },
    );
    try {
      await this.openGitWindow(repository);
      await repository.refreshState();
      historyCheckpoint = await absorbedCheckpointManifest(repository);
      const reconciledState = structuredClone(repository.state);
      const reconciled = new EventReconciler().reconcile(
        await repository.listEvents(),
        reconciledState,
        historyCheckpoint,
      );
      if (reconciled.warnings.length > 0) {
        this.status.log(
          `Restore Version History blocked by repository stream warning: ${reconciled.warnings[0]}`,
        );
        void vscode.window.showWarningMessage(
          `Version history cannot be restored while the repository event stream is incomplete. Synchronize again after the shared folder settles. ${reconciled.warnings[0]}`,
        );
        return;
      }
      Object.assign(repository.state, reconciledState);
      acceptedHistoryEventHashes = new Set(reconciled.acceptedEventHashes);
    } finally {
      await refreshLock.release();
    }
    // The QuickPicks can stay open indefinitely, so the version is selected
    // without the lock and re-verified against fresh tips before publishing.
    const resourceIds = [
      ...new Set([
        ...Object.keys(repository.state.tips),
        ...Object.keys(repository.state.projections),
      ]),
    ].sort();
    if (resourceIds.length === 0) {
      void vscode.window.showInformationMessage(
        "There are no synchronized resources to restore.",
      );
      return;
    }
    const conflictedResources = new Set(
      repository.state.conflicts
        .filter((conflict) => conflict.resolvedAt === undefined)
        .map((conflict) => conflict.resourceId),
    );
    const resources: RestoreResourceDescriptor[] = [];
    const historyRoots = new Map<string, string[]>();
    let unknownResourceCount = 0;
    for (const resourceId of resourceIds) {
      const projection = repository.state.projections[resourceId];
      const resourceTips = repository.state.tips[resourceId] ?? [];
      const tip = [...resourceTips].sort(compareTips)[0];
      const kind = tip?.kind ?? projection?.kind;
      if (kind === undefined) {
        unknownResourceCount += 1;
        continue;
      }
      historyRoots.set(
        resourceId,
        resourceTips.map((candidate) => candidate.versionId),
      );
      resources.push({
        resourceId,
        kind,
        metadata: tip?.metadata,
        sourceTimestamp: projection?.sourceTimestamp,
        eventCreatedAt: tip?.createdAt,
        blockedReason: conflictedResources.has(resourceId)
          ? "Resolve the conflict first."
          : resourceTips.length === 0
            ? "No current repository tip is available for this resource."
          : resourceConfigurationBlockReason(kind, {
              syncChat: this.configuration.syncChat,
              syncWorkspaceStorage: this.configuration.syncWorkspaceStorage,
            }),
      });
    }
    if (unknownResourceCount > 0) {
      this.status.log(
        `Restore Version History omitted ${unknownResourceCount} resource(s) whose kind is unknown.`,
      );
    }
    const kindItems = buildRestoreKindChoices(resources);
    if (kindItems.length === 0) {
      void vscode.window.showInformationMessage(
        "There are no recognized synchronized resources to restore.",
      );
      return;
    }
    const selectedKind = await vscode.window.showQuickPick(kindItems, {
      title: "Restore Version History: choose a data type",
      placeHolder:
        "For a missing chat, choose Cursor conversations — Agent transcripts are separate files.",
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (selectedKind === undefined) {
      return;
    }
    if (selectedKind.blockedReason !== null) {
      void vscode.window.showWarningMessage(
        `${restoreKindLabel(selectedKind.resourceKind)}: ${selectedKind.blockedReason}`,
      );
      return;
    }
    const resourcesOfKind = resources.filter(
      (resource) => resource.kind === selectedKind.resourceKind,
    );
    const histories = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report(`Reading ${restoreKindLabel(selectedKind.resourceKind)} history...`);
        return repository.listReachableResourceHistories(
          new Set(resourcesOfKind.map((resource) => resource.resourceId)),
          historyRoots,
          acceptedHistoryEventHashes,
          historyCheckpoint,
        );
      },
    );
    const restorableHistory = new Map<string, ResourceHistoryEntry[]>();
    const restorableResources: RestoreResourceDescriptor[] = [];
    for (const resource of resourcesOfKind) {
      if (resource.blockedReason !== null) {
        continue;
      }
      const history = histories.get(resource.resourceId) ?? [];
      const currentTipIds = new Set(
        (repository.state.tips[resource.resourceId] ?? []).map(
          (tip) => tip.versionId,
        ),
      );
      const eligible = restorablePutVersions(
        history,
        currentTipIds,
        (summary) =>
          summary.resourceId !== resource.resourceId ||
          summary.kind !== resource.kind
            ? "The history entry does not match this resource."
            : databaseApplyBlockReason(
                summary.kind,
                effectiveVersionProducer(summary.metadata, summary.producer),
                this.compatibility,
              ),
      );
      if (eligible.length === 0) {
        continue;
      }
      restorableHistory.set(resource.resourceId, eligible);
      const newestRestorable = eligible[0];
      restorableResources.push({
        ...resource,
        metadata: {
          ...(newestRestorable?.metadata ?? {}),
          ...(resource.metadata ?? {}),
        },
        eventCreatedAt:
          resource.eventCreatedAt ?? newestRestorable?.createdAt,
      });
    }
    if (restorableResources.length === 0) {
      void vscode.window.showInformationMessage(
        `No earlier restorable versions are available for ${restoreKindLabel(
          selectedKind.resourceKind,
        )}. Current-only, conflicting, disabled, and incompatible entries are omitted.`,
      );
      return;
    }
    const scopeItems = buildRestoreScopeChoices(restorableResources);
    const selectedScope = scopeItems.length <= 1
      ? scopeItems[0]
      : await vscode.window.showQuickPick(scopeItems, {
          title: `Restore Version History: choose a workspace or project`,
          placeHolder: "Most recently updated first. Search by workspace or project name.",
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
        });
    if (selectedScope === undefined) {
      return;
    }
    const scopedResourceIds = new Set(selectedScope.resourceIds);
    const scopedResources = restorableResources.filter((resource) =>
      scopedResourceIds.has(resource.resourceId),
    );
    const resourceItems = buildRestoreResourceChoices(scopedResources);
    const omitted = resourcesOfKind.length - restorableResources.length;
    const kindLabel = restoreKindLabel(selectedKind.resourceKind);
    const scopeSuffix = selectedScope.label === kindLabel
      ? ""
      : ` — ${selectedScope.label}`;
    const selectedResource = await vscode.window.showQuickPick(resourceItems, {
      title: `Restore Version History: ${kindLabel}${scopeSuffix}`,
      placeHolder: `Newest first. Search by title, workspace, date, message count, path, or ID.${
        omitted === 0 ? "" : ` ${omitted} unavailable item(s) are hidden.`
      }`,
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (selectedResource === undefined) {
      return;
    }
    const resourceId = selectedResource.resourceId;
    const history = histories.get(resourceId) ?? [];
    const eligibleHistory = restorableHistory.get(resourceId) ?? [];
    if (history.length === 0 || eligibleHistory.length === 0) {
      void vscode.window.showInformationMessage(
        `No earlier restorable version is available for ${selectedResource.label}.`,
      );
      return;
    }
    const tips = repository.state.tips[resourceId] ?? [];
    const expectedTipIds = tips.map((tip) => tip.versionId).sort();
    const historyIndex = new Map(
      history.map((summary, index) => [summary.versionId, index]),
    );
    const versionItems = eligibleHistory.map((summary) => {
      const index = historyIndex.get(summary.versionId);
      return {
        label: `${new Date(summary.createdAt).toLocaleString()}${
          versionMessageCount(summary.metadata)
        }`,
        description: `${summary.deviceId.slice(0, 8)} · ${summary.operation} · ${
          summary.plainBytes === null
            ? "no payload"
            : formatBytes(summary.plainBytes)
        }${
          summary.fromCheckpoint ? " · checkpoint" : ""
        }`,
        detail: index === undefined
          ? "Stored version"
          : `Stored version v${history.length - index}`,
        summary,
      };
    });
    const selectedVersion = await vscode.window.showQuickPick(versionItems, {
      title: `Restore a version of ${selectedResource.label}`,
      placeHolder: "Newest restorable versions first. Select one to preview.",
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (selectedVersion === undefined) {
      return;
    }
    const restorePayloadBlock = restoreVersionPayloadBlockReason(
      selectedVersion.summary,
      repository.maxPayloadBytes,
    );
    if (restorePayloadBlock !== null) {
      void vscode.window.showWarningMessage(restorePayloadBlock);
      return;
    }
    await this.showHistoryPreview(
      repository,
      resourceId,
      tips,
      selectedVersion.summary,
    );
    const confirmed = await vscode.window.showWarningMessage(
      `Restore "${selectedResource.label}"?`,
      {
        modal: true,
        detail: `${restoreKindLabel(selectedVersion.summary.kind)} · ${
          selectedVersion.label
        }\n${selectedVersion.description}\n${selectedResource.detail}\n\nHistory is not rewritten. The selected content is published as a new version on top.`,
      },
      "Restore Version",
    );
    if (confirmed !== "Restore Version") {
      return;
    }
    const lock = await this.takeCommandLock(repository);
    try {
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      const freshCheckpoint = await absorbedCheckpointManifest(repository);
      const freshState = structuredClone(repository.state);
      const freshReconciliation = new EventReconciler().reconcile(
        await repository.listEvents(),
        freshState,
        freshCheckpoint,
      );
      if (freshReconciliation.warnings.length > 0) {
        this.status.log(
          `Restore Version History stopped by repository stream warning: ${freshReconciliation.warnings[0]}`,
        );
        void vscode.window.showWarningMessage(
          `Restore stopped because the repository event stream is incomplete. Synchronize again after the shared folder settles. ${freshReconciliation.warnings[0]}`,
        );
        return;
      }
      Object.assign(repository.state, freshState);
      const freshTips = repository.state.tips[resourceId] ?? [];
      const conflicted = repository.state.conflicts.some(
        (conflict) =>
          conflict.resourceId === resourceId &&
          conflict.resolvedAt === undefined,
      );
      const configuredBlock = resourceConfigurationBlockReason(
        selectedVersion.summary.kind,
        {
          syncChat: this.configuration.syncChat,
          syncWorkspaceStorage: this.configuration.syncWorkspaceStorage,
        },
      );
      const compatibilityBlock = databaseApplyBlockReason(
        selectedVersion.summary.kind,
        effectiveVersionProducer(
          selectedVersion.summary.metadata,
          selectedVersion.summary.producer,
        ),
        this.compatibility,
      );
      if (configuredBlock !== null || compatibilityBlock !== null) {
        void vscode.window.showWarningMessage(
          `Restore is no longer available: ${configuredBlock ?? compatibilityBlock}`,
        );
        return;
      }
      if (
        !restoreTargetIsUnchanged(
          expectedTipIds,
          freshTips,
          selectedVersion.summary.kind,
          conflicted,
        )
      ) {
        void vscode.window.showWarningMessage(
          `${resourceId} changed while the version was being selected; open "Cursor Setting Sync: Manage", choose "Restore Data…", then "Restore a Synchronized Version" again.`,
        );
        return;
      }
      const data = await repository.tryReadVersion(
        selectedVersion.summary.versionId,
      );
      if (data === null || data.content === null) {
        void vscode.window.showWarningMessage(
          "That version was compacted by another device — refresh the history and pick again.",
        );
        return;
      }
      if (
        selectedResource.resourceKind !== selectedVersion.summary.kind ||
        data.change.resourceId !== resourceId ||
        data.change.kind !== selectedVersion.summary.kind ||
        data.change.operation !== "put"
      ) {
        void vscode.window.showWarningMessage(
          "The selected history entry no longer matches this resource; refresh the history and pick again.",
        );
        return;
      }
      const tipProducer = (repository.state.tips[resourceId] ?? []).find(
        (tip) => tip.producer !== undefined,
      )?.producer;
      // A restore of a restore keeps stamping the effective ORIGINAL producer
      // instead of the intermediate restorer's manifest producer.
      const originalProducer = effectiveVersionProducer(
        data.change.metadata,
        data.producer ?? selectedVersion.summary.producer ?? tipProducer,
      );
      const existingChatTitle =
        typeof data.change.metadata?.title === "string"
          ? data.change.metadata.title
          : null;
      const restoredChatTitle =
        selectedVersion.summary.kind !== "chat"
          ? null
          : data.content.byteLength <= HISTORY_PREVIEW_MAX_PAYLOAD_BYTES
            ? chatSnapshotTitle(data.content) ?? existingChatTitle
            : existingChatTitle;
      const restoredMetadata = { ...(data.change.metadata ?? {}) };
      if (selectedVersion.summary.kind === "chat") {
        delete restoredMetadata.title;
      }
      const snapshot: ResourceSnapshot = {
        resourceId,
        kind: selectedVersion.summary.kind,
        content: data.content,
        semanticHash: data.change.semanticHash,
        metadata: {
          ...restoredMetadata,
          ...(restoredChatTitle === null ? {} : { title: restoredChatTitle }),
          syncOrigin: "version-restore",
          ...(originalProducer === undefined
            ? {}
            : { originalProducer: producerAsMetadata(originalProducer) }),
        },
      };
      await repository.publish([snapshot], []);
      await this.commitGitWindow(
        gitActive,
        repository.root,
        `sync(${repository.state.device.deviceId.slice(0, 8)}): restore ${resourceId}`,
      );
    } finally {
      await lock.release();
    }
    await this.syncNow(true);
    if (isDatabaseBackedKind(selectedVersion.summary.kind)) {
      void vscode.window.showInformationMessage(
        `The restored version of "${selectedResource.label}" is queued for the offline helper. Open "${RESTART_TO_APPLY_TITLE}" to write it into the Cursor databases.`,
      );
    } else {
      void vscode.window.showInformationMessage(
        `Restored "${selectedResource.label}"; the selected version is published as the new current content.`,
      );
    }
  }

  private async showHistoryPreview(
    repository: SyncRepository,
    resourceId: string,
    tips: ResourceTip[],
    summary: ResourceVersionSummary,
  ): Promise<void> {
    try {
      const currentTip =
        tips.find((tip) => tip.operation === "put") ?? tips[0];
      const currentFitsPreview =
        currentTip !== undefined &&
        declaredHistoryPreviewFits(
          currentTip.operation,
          currentTip.payload?.plainBytes ?? null,
        );
      const current =
        currentTip === undefined ||
        currentTip.operation === "delete" ||
        !currentFitsPreview
          ? null
          : await repository.tryReadVersion(currentTip.versionId);
      const selectedFitsPreview = declaredHistoryPreviewFits(
        summary.operation,
        summary.plainBytes,
      );
      const selected =
        selectedFitsPreview && summary.operation !== "delete"
        ? await repository.tryReadVersion(summary.versionId)
        : null;
      // VS Code caches provider content per URI, so the version IDs are part
      // of the path; otherwise a second preview of the same resource would
      // show the first preview's cached documents.
      const token = encodeURIComponent(resourceId);
      const currentUri = vscode.Uri.parse(
        `cursor-sync-history:${token}/current/${encodeURIComponent(
          currentTip?.versionId ?? "none",
        )}`,
      );
      const selectedUri = vscode.Uri.parse(
        `cursor-sync-history:${token}/selected/${encodeURIComponent(
          summary.versionId,
        )}`,
      );
      // Superseded entries are dropped so the backing map stays bounded to
      // the latest preview pair.
      this.historyDocuments.clear();
      this.historyDocuments.set(
        currentUri.toString(),
        currentTip === undefined
          ? "[No current version]\n"
          : currentFitsPreview
            ? historyPreviewText(
                currentTip.operation,
                current?.content ?? null,
              )
            : historyPreviewOmittedText(
                currentTip.operation,
                currentTip.payload?.plainBytes ?? null,
              ),
      );
      this.historyDocuments.set(
        selectedUri.toString(),
        selectedFitsPreview
          ? historyPreviewText(summary.operation, selected?.content ?? null)
          : historyPreviewOmittedText(summary.operation, summary.plainBytes),
      );
      await vscode.commands.executeCommand(
        "vscode.diff",
        currentUri,
        selectedUri,
        `Cursor Setting Sync History: ${resourceId}`,
        { preview: true },
      );
    } catch (error) {
      // The preview is best-effort; a failed diff must not block restoring.
      this.status.log(
        `History preview failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async showDiagnostics(): Promise<void> {
    // A standby window has intentionally not loaded local state. Diagnostics
    // is an explicit state-reading command, so hydrate its first snapshot
    // under sync.lock instead of silently reporting a placeholder device and
    // zero pending changes/conflicts.
    await this.ensureRepositoryInitializedForRead();
    const repository = this.repository;
    const snapshot: DiagnosticSnapshot = {
      generatedAt: new Date().toISOString(),
      compatibility: this.compatibility,
      configured: repository !== null,
      repositoryPath: this.configuration.repositoryPath,
      deviceId: repository?.state.device.deviceId ?? null,
      pendingDatabaseChanges:
        repository?.state.pendingDatabaseChanges.length ?? 0,
      // The counts alone were undebuggable: "3 deferred" with no way to learn
      // which resources, why, or which PC to update.
      pending: (repository?.state.pendingDatabaseChanges ?? []).map(
        (pending) => ({
          resourceId: pending.resourceId,
          kind: pending.kind,
          blockedReason: pending.blockedReason ?? null,
        }),
      ),
      conflicts:
        repository?.state.conflicts.filter(
          (conflict) => conflict.resolvedAt === undefined,
        ).length ?? 0,
      conflictResourceIds:
        repository === null
          ? []
          : unresolvedConflicts(repository).map(
              (conflict) => conflict.resourceId,
            ),
      effectiveConfiguration: {
        enabled: this.configuration.enabled,
        pollIntervalSeconds: this.configuration.pollIntervalSeconds,
        chatPollIntervalSeconds: this.configuration.chatPollIntervalSeconds,
        autoApplyFiles: this.configuration.autoApplyFiles,
        syncChat: this.configuration.syncChat,
        syncWorkspaceStorage: this.configuration.syncWorkspaceStorage,
        applyOnShutdown: this.configuration.applyOnShutdown,
        gitSync: this.configuration.gitSync,
        maxPayloadMiB: Math.round(
          this.configuration.maxPayloadBytes / (1024 * 1024),
        ),
        useDefaultIgnoredSettings: this.configuration.useDefaultIgnoredSettings,
        ignoredSettings: this.configuration.ignoredSettings,
        ignoredExtensions: this.configuration.ignoredExtensions,
        ignoredUserFiles: this.configuration.ignoredUserFiles,
        ignoredUiStateKeys: this.configuration.ignoredUiStateKeys,
      },
      defaultIgnoredSettings: this.configuration.useDefaultIgnoredSettings
        ? [...DEFAULT_IGNORED_SETTINGS]
        : [],
      machineScopedSettings: this.machineSpecificSettingPatterns().sort(
        (left, right) => left.localeCompare(right),
      ),
      gitMode:
        this.lastGitWindowDegraded
          ? "degraded"
          : this.configuration.gitSync
            ? "enabled"
            : "off",
      workspaceMappings: this.configuration.workspaceMappings,
      adapters: this.adapters.map((adapter) => adapter.id).sort(),
      standingWarnings: standingWarningDiagnostics(
        this.warnings.standing(),
        Date.now(),
      ),
      // Listed separately, and named for what they are. These are the things
      // this device is deliberately not synchronizing; the answer to "why did
      // that stop travelling" lives here rather than under a heading that calls
      // it a warning.
      deliberateExclusions: standingWarningDiagnostics(
        this.notices.standing(),
        Date.now(),
      ),
      lastSyncAt: repository?.state.lastSyncAt ?? null,
      lastError: repository?.state.lastError ?? null,
      ...(repository === null
        ? {}
        : { repositoryBytes: await directorySize(repository.root) }),
    };
    const document = await vscode.workspace.openTextDocument({
      language: "json",
      content: `${JSON.stringify(snapshot, null, 2)}\n`,
    });
    await vscode.window.showTextDocument(document, { preview: true });
    this.status.show();
  }

  async restoreBackup(): Promise<void> {
    const repository = this.requireRepository();
    // Copied for the same reason as restartToApply: this command parks in
    // pickers and a modal, and a Disconnect meanwhile zeroes the live Buffer.
    const masterKey = Buffer.from(this.requireMasterKey());
    try {
      await this.restoreBackupWithKey(repository, masterKey);
    } finally {
      masterKey.fill(0);
    }
  }

  private async restoreBackupWithKey(
    repository: SyncRepository,
    masterKey: Buffer,
  ): Promise<void> {
    assertCompatibleForDatabaseWrite(this.compatibility);
    const backupRoot = join(this.paths.extensionStorage, BACKUP_DIRECTORY);
    const backups = (await listFilesRecursively(backupRoot)).filter((path) => {
      const name = basename(path).toLowerCase();
      return (
        (name.startsWith("state-") || name.startsWith("pre-restore-")) &&
        name.endsWith(".vscdb")
      );
    });
    const recorded = this.context.globalState.get<StoredHelperBackup[]>(
      LAST_HELPER_BACKUPS_KEY,
      [],
    );
    const recordedByPath = new Map(
      recorded.map((entry) => [entry.backupPath.toLowerCase(), entry]),
    );
    const items: Array<{
      label: string;
      description: string;
      path: string;
      restoreTarget?: { targetPath: string; contract: DatabaseContract };
    }> = [];
    for (const path of backups.sort((left, right) => right.localeCompare(left))) {
      const name = basename(path);
      const record = recordedByPath.get(path.toLowerCase());
      if (name.toLowerCase().startsWith("pre-restore-")) {
        // A pre-restore snapshot is named identically for EVERY contract, but
        // the picker's bare entries restore as GLOBAL. Offering a workspace
        // or store snapshot that way quit Cursor only to fail (or, for a
        // workspace database that happens to carry composerHeaders, import
        // the wrong content wholesale). Only a snapshot whose recorded entry
        // names its contract is offered; the record IS the label.
        if (record === undefined) {
          this.status.log(
            `Restore Backup: skipped ${name} - its origin record has rotated out, so its target database cannot be determined.`,
          );
          continue;
        }
        items.push({
          label: `${record.contract} ${basename(record.targetPath)}`,
          description: path,
          path,
          ...(record.contract === "global"
            ? {}
            : {
                restoreTarget: {
                  targetPath: record.targetPath,
                  contract: record.contract,
                },
              }),
        });
        continue;
      }
      // state-* files are always the helper's pre-apply GLOBAL snapshots.
      items.push({ label: name, description: path, path });
    }
    for (const entry of recorded) {
      if (
        entry.contract === "global" ||
        backups.some(
          (path) => path.toLowerCase() === entry.backupPath.toLowerCase(),
        ) ||
        !(await pathExists(entry.backupPath))
      ) {
        // Non-global backups living OUTSIDE the scanned tree (workspace and
        // store snapshots in other directories) still come from the records;
        // ones inside it were already listed above with their contract.
        continue;
      }
      items.push({
        label: `${entry.contract} ${basename(entry.targetPath)}`,
        description: entry.backupPath,
        path: entry.backupPath,
        restoreTarget: {
          targetPath: entry.targetPath,
          contract: entry.contract,
        },
      });
    }
    const selected = await vscode.window.showQuickPick(items, {
      title: "Select a Cursor database backup to restore",
    });
    if (selected === undefined) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      "Cursor will quit and import the selected backup's managed tables with a SQLite transaction. The live database file is not replaced; rows absent from those backed-up tables are removed. " +
        "After the restart, synchronization publishes the restored state as the newest version, so other computers converge on it too - this restore is not local-only.",
      { modal: true },
      "Import and Restart",
    );
    if (confirmed !== "Import and Restart") {
      return;
    }
    if (this.disposed || this.repository !== repository || this.masterKey === null) {
      // Same guard restartToApply has: the picker and the modal park for as
      // long as the user thinks, and a Disconnect or Setup re-run meanwhile
      // makes "quit every window and restore" the wrong thing to do - and
      // the modal's propagation sentence stale.
      this.status.log(
        "Restore Backup was abandoned: the synchronization configuration changed while the backup was being chosen. Nothing was restored.",
      );
      return;
    }
    if (await this.applyAlreadyInProgress()) {
      const message =
        "Another window already started an apply or restore; wait for Cursor to quit, then try again.";
      this.status.log(message);
      void vscode.window.showInformationMessage(message);
      return;
    }
    const claim = await this.markApplyInProgress();
    try {
      await this.helper.restoreAndRestart(
        repository.root,
        masterKey,
        selected.path,
        this.helperSyncOptions(),
        selected.restoreTarget,
        async () => {
          await this.clearApplyInProgress(claim);
          await this.startFinalizer();
        },
        () => {
          this.status.log(QUIT_STALLED_MESSAGE);
          void vscode.window.showWarningMessage(QUIT_STALLED_MESSAGE).then(
            () => {},
            () => {
              // The window may be mid-teardown; the output-channel line above
              // is the durable record either way.
            },
          );
        },
      );
    } catch (error) {
      // Same as restartToApply: the restore flow cancelled the standing
      // finalizer before launching, so a failed launch must re-arm it.
      await this.clearApplyInProgress(claim);
      await this.startFinalizer();
      throw error;
    }
  }

  async forgetDevice(): Promise<void> {
    const repository = this.requireRepository();
    const firstLock = await this.withProgress(
      "Cursor Setting Sync",
      async (report) => {
        report("Reading the device list...");
        return this.takeCommandLock(repository, report);
      },
    );
    let candidates: Array<{
      label: string;
      description?: string;
      deviceId: string;
      action: "forget" | "unforget";
    }>;
    try {
      await this.openGitWindow(repository);
      await repository.refreshState();
      // A directory created by a setup that never synced has no stream entry
      // but still blocks the prune gate, so the directory listing is unioned
      // into the candidates.
      const streamDevices = new Set(Object.keys(repository.state.streams));
      const directoryDevices = await repository.listVisibleDeviceIds();
      candidates = [...new Set([...streamDevices, ...directoryDevices])]
        .filter(
          (deviceId) =>
            deviceId !== repository.state.device.deviceId &&
            !repository.state.retiredDevices.includes(deviceId),
        )
        .sort((left, right) => left.localeCompare(right))
        .map((deviceId) => ({
          label: deviceId,
          // "(no published events)" is also what a computer that is STILL
          // JOINING looks like under cloud-sync lag; the description says so
          // rather than reading like an invitation to clean it up.
          ...(streamDevices.has(deviceId)
            ? {}
            : {
                description:
                  "(no published events - may be a computer still joining)",
              }),
          deviceId,
          action: "forget" as const,
        }));
      // Retiring used to be irreversible; a mistaken pick silently blinded
      // this machine to a real peer forever. The same picker restores.
      for (const deviceId of [...repository.state.retiredDevices].sort()) {
        candidates.push({
          label: `$(history) Restore retired device ${deviceId}`,
          description: "start reading this device's events again",
          deviceId,
          action: "unforget",
        });
      }
    } finally {
      await firstLock.release();
    }
    const selected = await vscode.window.showQuickPick(candidates, {
      title: "Retire or Restore Another Device",
      placeHolder: "This changes which peer streams this PC reads.",
    });
    if (selected === undefined) {
      return;
    }
    if (selected.action === "forget") {
      const proceed = "Retire Device";
      const confirmed = await vscode.window.showWarningMessage(
        `Stop reading new events from device ${selected.deviceId} on this PC? ` +
          "Shared repository files remain unchanged, and you can restore the device later. " +
          "If it is still joining or only temporarily offline, its future changes will not arrive on this PC. " +
          "Retiring it can also allow automatic maintenance on this PC to prune older shared history once the remaining safety gates pass.",
        { modal: true },
        proceed,
      );
      if (confirmed !== proceed) {
        return;
      }
    }
    const secondLock = await this.takeCommandLock(repository);
    try {
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      if (selected.action === "forget") {
        if (!repository.state.retiredDevices.includes(selected.deviceId)) {
          repository.state.retiredDevices.push(selected.deviceId);
        }
      } else {
        repository.state.retiredDevices =
          repository.state.retiredDevices.filter(
            (deviceId) => deviceId !== selected.deviceId,
          );
      }
      await repository.saveState();
      await this.commitGitWindow(
        gitActive,
        repository.root,
        `${selected.action}-device ${selected.deviceId.slice(0, 8)}`,
      );
    } finally {
      await secondLock.release();
    }
    void vscode.window.showInformationMessage(
      selected.action === "forget"
        ? `Device ${selected.deviceId} is now retired on this PC.`
        : `Device ${selected.deviceId} is active on this PC again; its available events are picked up on the next sync.`,
    );
  }

  private async runCheckpointPhases(
    repository: SyncRepository,
    overrideAgeGate: boolean,
  ): Promise<CheckpointCommandOutcome> {
    return this.withProgress(
      "Cursor Setting Sync: Automatic Repository Maintenance",
      async (report) => this.checkpointPhases(repository, overrideAgeGate, report),
    );
  }

  private async checkpointPhases(
    repository: SyncRepository,
    overrideAgeGate: boolean,
    report: (message: string) => void,
  ): Promise<CheckpointCommandOutcome> {
    const lock = await this.takeCommandLock(repository, report);
    try {
      report("Reading the repository...");
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      const reconciler = new EventReconciler();
      const checkpoint = await absorbedCheckpointManifest(repository);
      const result = reconciler.reconcile(
        await repository.listReconciliationEvents(checkpoint),
        repository.state,
        checkpoint,
      );
      if (result.warnings.length > 0) {
        throw new Error(
          `Checkpointing requires a fully propagated repository; resolve this stream warning first: ${result.warnings[0]}`,
        );
      }
      if (
        repository.state.conflicts.some(
          (conflict) => conflict.resolvedAt === undefined,
        )
      ) {
        throw new Error(
          "Resolve all synchronization conflicts before creating a checkpoint.",
        );
      }
      let created: CheckpointCreateResult | null = null;
      const checkpointAtStart = repository.state.checkpoint;
      const checkpointWasBehind =
        checkpointAtStart !== undefined &&
        !checkpointCoversStreams(
          checkpointAtStart,
          repository.state.streams,
        );
      // Asked before writing, not after. A checkpoint is 2.6 MB in the shared
      // folder and only a prune past the lagging-device and 24-hour gates ever
      // deletes one. More subtly, replacing a YOUNG checkpoint before asking
      // the age gate resets its age to zero: one event in every six-hour
      // maintenance window then creates checkpoints forever and no checkpoint
      // ever reaches the required day. Existing history is therefore pruned
      // first; only a successful prune may be followed by a fresher fold.
      const lagging = await repository.laggingDeviceReasons();
      if (checkpointAtStart === undefined) {
        report("Folding the current tips into the first checkpoint...");
        created = await repository.createCheckpoint(true);
      } else if (lagging.length > 0) {
        report("Waiting for every device to absorb the current checkpoint...");
        this.status.log(
          `Kept the existing checkpoint rather than adding another: ${lagging.join("; ")}. ` +
          'For a computer that is permanently gone, open "Cursor Setting Sync: Manage", choose "Repository & Devices…", then "Retire or Restore Another Device…".',
        );
      }
      if (created === null && repository.state.checkpoint === undefined) {
        return { created: null, prune: null, gitSquash: null };
      }
      report("Pruning superseded history...");
      const prune = await repository.pruneWithGates({
        reconciledWithoutWarnings: true,
        ...(overrideAgeGate ? { overrideAgeGate: true } : {}),
      });
      if (prune.status === "pruned") {
        if (checkpointWasBehind) {
          report("Folding changes newer than the pruned checkpoint...");
          created = await repository.createCheckpoint(true);
        }
        // A warning or rollback in the post-prune reconcile skips compaction
        // for this run instead of failing the already completed prune.
        let compactionBlocked: string | null = null;
        try {
          const postCheckpoint = await absorbedCheckpointManifest(repository);
          const postResult = reconciler.reconcile(
            await repository.listReconciliationEvents(postCheckpoint),
            repository.state,
            postCheckpoint,
          );
          compactionBlocked = postResult.warnings[0] ?? null;
        } catch (error) {
          compactionBlocked =
            error instanceof Error ? error.message : String(error);
        }
        if (compactionBlocked === null) {
          await repository.compactOwnOrphans(true);
        } else {
          prune.warnings.push(
            `Object compaction was skipped: ${compactionBlocked}`,
          );
        }
        await repository.saveState();
      }
      let gitSquash: SquashHistoryResult | null = null;
      if (created !== null || prune.status === "pruned") {
        const checkpointHash = (
          created?.checkpointHash ??
          repository.state.checkpoint?.hash ??
          "unknown"
        ).slice(0, 12);
        const committed = await this.commitGitWindow(
          gitActive,
          repository.root,
          `checkpoint ${checkpointHash}`,
        );
        if (committed && prune.status === "pruned") {
          // Pruning deleted event files that git history still retains; the
          // squash rewrites the transport history so the space is reclaimed.
          try {
            gitSquash = await squashHistory(
              repository.root,
              `checkpoint ${checkpointHash} squash`,
            );
          } catch (error) {
            this.degradeGit(error);
          }
        }
      }
      return { created, prune, gitSquash };
    } finally {
      await lock.release();
    }
  }

  async archiveRepository(): Promise<void> {
    const repository = this.requireRepository();
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Archive Here",
      title: "Select a destination outside the live sync repository",
    });
    const parent = selected?.[0]?.fsPath;
    if (parent === undefined) {
      return;
    }
    const destination = join(
      parent,
      `cursor-sync-archive-${new Date().toISOString().replaceAll(":", "-")}`,
    );
    const relativeToRepository = relative(repository.root, destination);
    if (
      relativeToRepository === "" ||
      (!relativeToRepository.startsWith("..") &&
        !isAbsolute(relativeToRepository))
    ) {
      throw new Error("The archive destination must be outside the live repository.");
    }
    await this.withProgress(
      "Cursor Setting Sync: Archiving Repository",
      async (report) => {
        // Held for the whole copy: without it this window's own 30-second
        // poll, automatic maintenance, or the offline helper deletes event
        // files mid-enumeration and the archive dies on ENOENT halfway - or
        // worse, completes while silently missing what was pruned under it.
        const lock = await this.takeCommandLock(repository, report);
        try {
          report("Enumerating repository files...");
          const sources = await listFilesRecursively(repository.root);
          let copied = 0;
          for (const source of sources) {
            const relativePath = relative(repository.root, source);
            await copyFileAtomic(source, join(destination, relativePath));
            copied += 1;
            report(`Copying ${copied}/${sources.length} files...`);
          }
        } finally {
          await lock.release();
        }
      },
    );
    void vscode.window.showInformationMessage(`Repository archived to ${destination}`);
  }

  dispose(): void {
    void this.shutdown();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    this.disposed = true;
    this.cycles.close();
    if (this.finalizerRetryTimer !== null) {
      clearTimeout(this.finalizerRetryTimer);
      this.finalizerRetryTimer = null;
      this.finalizerRetryGuard = null;
    }
    if (this.reconnectProbeTimer !== null) {
      clearTimeout(this.reconnectProbeTimer);
      this.reconnectProbeTimer = null;
    }
    const coordinatorShutdown = this.backgroundCoordinator.dispose();
    this.shutdownPromise = (async () => {
      try {
        await coordinatorShutdown;
        // A timeout callback may already have entered the queue when runtime
        // teardown clears it. Keep the repository, helper and key alive until
        // that final protected cycle has released sync.lock.
        await this.cycles.settled();
      } catch {
        // A failed final cycle already reported its own diagnostic. Teardown
        // must still release every in-process resource below.
      } finally {
        await this.replaceAdapters([]);
        this.warnings.clear();
        this.historyPreviewRegistration.dispose();
        this.helper.dispose();
        this.masterKey?.fill(0);
        this.masterKey = null;
      }
    })();
    return this.shutdownPromise;
  }

  private async reconcileCurrentRepository(
    repository: SyncRepository,
    checkpoint: CheckpointManifest | null,
  ): Promise<ReconcileResult> {
    const sharedGraphGeneration = repository.sharedGraphGeneration;
    const reconciliationInputGeneration =
      repository.reconciliationInputGeneration;
    const cached = this.reconciliationCache;
    if (
      cached?.repository === repository &&
      cached.sharedGraphGeneration === sharedGraphGeneration &&
      cached.reconciliationInputGeneration === reconciliationInputGeneration
    ) {
      return cached.result;
    }
    const result = this.eventReconciler.reconcile(
      await repository.listReconciliationEvents(checkpoint),
      repository.state,
      checkpoint,
    );
    this.reconciliationCache = {
      repository,
      sharedGraphGeneration,
      reconciliationInputGeneration,
      result,
    };
    return result;
  }

  private canReuseCurrentReconciliation(repository: SyncRepository): boolean {
    const cached = this.reconciliationCache;
    return (
      cached?.repository === repository &&
      cached.sharedGraphGeneration === repository.sharedGraphGeneration &&
      cached.reconciliationInputGeneration ===
        repository.reconciliationInputGeneration
    );
  }

  private alignCurrentReconciliationCache(repository: SyncRepository): void {
    const cached = this.reconciliationCache;
    if (
      cached?.repository === repository &&
      cached.sharedGraphGeneration === repository.sharedGraphGeneration
    ) {
      cached.reconciliationInputGeneration =
        repository.reconciliationInputGeneration;
    }
  }

  private currentChatTipEnrichmentIndex(
    repository: SyncRepository,
  ): readonly ChatTipEnrichmentCandidate[] {
    const sharedGraphGeneration = repository.sharedGraphGeneration;
    const cached = this.chatTipEnrichmentIndex;
    if (
      cached?.repository === repository &&
      cached.sharedGraphGeneration === sharedGraphGeneration
    ) {
      return cached.candidates;
    }
    const candidates = buildChatTipEnrichmentCandidateIndex(
      repository.state.tips,
    );
    this.chatTipEnrichmentIndex = {
      repository,
      sharedGraphGeneration,
      candidates,
    };
    this.chatTipEnrichmentCursor = { afterResourceId: null };
    return candidates;
  }

  private async performSync(manual: boolean, scope: SyncScope): Promise<void> {
    const repository = this.repository;
    if (repository === null) {
      const unconfigured = this.configuration.repositoryPath === null;
      this.status.setStatus(unconfigured ? "unconfigured" : "locked");
      if (manual) {
        void vscode.window.showInformationMessage(
          unconfigured
            ? 'Cursor Setting Sync is not configured yet. Open "Cursor Setting Sync: Manage", choose "Repository & Devices…", then "Setup or Reconfigure This PC…" first.'
            : 'Cursor Setting Sync is locked. Open "Cursor Setting Sync: Manage", choose "Repository & Devices…", then "Setup or Reconfigure This PC…" and enter your passphrase to unlock it.',
        );
      }
      return;
    }
    if (await this.disconnectedElsewhere()) {
      return;
    }
    this.syncRepositoryLimit(repository);
    let lock: FileLock | null;
    try {
      lock = await acquireFileLock(this.syncLockPath());
    } catch (error) {
      // Antivirus or cloud-sync tooling touching the lock file can turn the
      // open("wx")/read into a transient EPERM. That is "the lock is busy
      // this instant", not a broken configuration - and on the activation
      // path an escape here used to kill the whole window. The next poll
      // retries; a persistent cause keeps logging and stays visible.
      this.status.log(
        `Skipped this cycle: the sync lock could not be probed (${
          error instanceof Error ? error.message : String(error)
        }).`,
      );
      lock = null;
    }
    if (lock === null) {
      await this.noteLockSkipped(manual);
      // The other holder may own the lock continuously, so this window would
      // otherwise keep displaying whatever it last computed — including a
      // stale "up-to-date" while conflicts are outstanding.
      if (repository.isInitialized) {
        this.updateStatus(repository);
      } else {
        // Envelope-only open carries a deliberately empty placeholder. Never
        // turn that into a green zero-conflict/zero-queue claim merely because
        // another window or helper still owns the initialization lock.
        this.status.setStatus(
          "syncing",
          "Another Cursor window or the offline helper is synchronizing. Local repository state will load when the lock is available.",
        );
      }
      return;
    }
    const resumed = lockSkipResumedLine(this.lockSkip);
    this.lockSkip = null;
    if (resumed !== null) {
      this.status.log(resumed);
    }
    let failed = false;
    this.beginSyncIndicator();
    try {
      // Deferred activation is envelope-only. The elected owner (or an
      // explicit follower command) loads local state, absorbs checkpoints and
      // recovers its own stream only after taking the same machine-wide lock
      // as the rest of the cycle.
      await repository.ensureInitialized();
      // Inside the lock so two cycling windows do not both report - and both
      // delete - the same result. A helper that fails while Cursor is still
      // running (a vetoed quit, or the exit wait expiring) leaves its result
      // here and nothing restarts, so the startup consume never arrives.
      await this.consumeHelperResults({ atStartup: false });
      // Commands are an explicit request for the freshest remote state.
      // Background polls use the same local Git write window but space the
      // expensive fetch/merge probe; returning an active window when that
      // probe is skipped preserves immediate commit/push of local publishes.
      const pullAttemptBefore = this.backgroundGitPullAttempt;
      const gitActive = await this.openGitWindow(repository, manual);
      const probeAttempted =
        this.backgroundGitPullAttempt !== pullAttemptBefore;
      await repository.refreshState({ forceAudit: manual });
      const checkpoint = await absorbedCheckpointManifest(repository);
      const initialReconciliationWasCached =
        this.canReuseCurrentReconciliation(repository);
      const pendingCountBefore =
        repository.state.pendingDatabaseChanges.length;
      // Auto-merge runs on every cycle regardless of scope, so its bucket is
      // always observed, exactly like the reconciler's.
      const mergeWarnings: string[] = [];
      const noteMergeWarning = (warning: string): void => {
        mergeWarnings.push(warning);
      };
      let preResult = await this.reconcileCurrentRepository(
        repository,
        checkpoint,
      );
      let autoMergedPublished = await autoMergeConflicts(
        repository,
        preResult.conflicts,
        (tips) =>
          tips.every(
            (tip) => this.resourceApplyBlockReason(tip) === null,
          ),
        noteMergeWarning,
      );
      if (autoMergedPublished) {
        preResult = await this.reconcileCurrentRepository(
          repository,
          checkpoint,
        );
      }
      let agentKvEnrichedCount = 0;
      if (
        this.configuration.syncChat &&
        this.compatibility.databaseCapabilities["global-chat"].available
      ) {
        try {
          const enriched = await enrichCurrentChatTipsFromLiveDatabase(
            repository,
            this.paths.globalDatabase,
            {
              cursor: this.chatTipEnrichmentCursor,
              candidateIndex: this.currentChatTipEnrichmentIndex(repository),
              candidateGeneration: repository.sharedGraphGeneration,
              maxPayloadBytes: repository.maxPayloadBytes,
              attemptCache: this.chatTipEnrichmentAttempts,
              forceRetry: manual,
              tipAllowed: (tip) => this.resourceApplyBlockReason(tip) === null,
            },
          );
          this.chatTipEnrichmentCursor = enriched.cursor;
          agentKvEnrichedCount = enriched.published;
          for (const warning of enriched.warnings) {
            this.status.log(warning);
          }
          if (agentKvEnrichedCount > 0) {
            preResult = await this.reconcileCurrentRepository(
              repository,
              checkpoint,
            );
            if (this.chatTipEnrichmentIndex?.repository === repository) {
              const publishedResourceIds = new Set(
                enriched.publishedResourceIds,
              );
              this.chatTipEnrichmentIndex.candidates =
                this.chatTipEnrichmentIndex.candidates.filter(
                  (candidate) =>
                    !publishedResourceIds.has(candidate.resourceId),
                );
              const refreshedTips = Object.create(null) as Record<
                string,
                ResourceTip[]
              >;
              for (const resourceId of publishedResourceIds) {
                refreshedTips[resourceId] =
                  repository.state.tips[resourceId] ?? [];
              }
              // A partial enrichment remains eligible. Re-evaluate only the
              // exact published IDs after reconciliation and append their new
              // immutable tips; rebuilding/sorting every chat after each
              // two-item migration batch would recreate the O(N) poll spike.
              this.chatTipEnrichmentIndex.candidates.push(
                ...buildChatTipEnrichmentCandidateIndex(refreshedTips),
              );
              this.chatTipEnrichmentIndex.sharedGraphGeneration =
                repository.sharedGraphGeneration;
            }
          }
        } catch (error) {
          // Migration is opportunistic and must never stop ordinary settings,
          // chat-core, or inbound synchronization. A changed DB generation or
          // a manual sync retries it.
          this.status.log(
            `Agent blob enrichment was skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const synthetic = await this.applySyntheticProjectionsBeforeScan(
        repository,
        preResult.projections,
      );
      const syntheticSkips = synthetic.driftSkipped;
      if (synthetic.changed) {
        preResult = await this.reconcileCurrentRepository(
          repository,
          checkpoint,
        );
      }
      const requiredKinds = new Set(
        preResult.projections
          .filter((projection) => projection.changed)
          .map((projection) => projection.tip.kind),
      );
      const scan = await this.scanLocalResources(
        repository.state.projections,
        manual ? "all" : scope,
        requiredKinds,
        repository.maxPayloadBytes,
      );
      const localSnapshots = new Map(
        scan.snapshots.map((snapshot) => [snapshot.resourceId, snapshot]),
      );
      const conflictedResources = new Set(
        repository.state.conflicts
          .filter((conflict) => conflict.resolvedAt === undefined)
          .map((conflict) => conflict.resourceId),
      );
      const protectedSyntheticResources = new Set(
        preResult.projections
          .filter(
            (projection) =>
              projection.changed &&
              isSyntheticTip(projection.tip) &&
              !syntheticSkips.has(projection.resourceId),
          )
          .map((projection) => projection.resourceId),
      );
      const changedSnapshots = scan.snapshots.filter(
        (snapshot) =>
          !protectedSyntheticResources.has(snapshot.resourceId) &&
          shouldPublishSnapshot(
            repository.state.projections[snapshot.resourceId],
            snapshot,
            repository.state.tips[snapshot.resourceId] ?? [],
          ),
      );
      // A suppressed snapshot is already represented either by the projection
      // or by a current PUT tip. Record that exact local version and its source
      // metadata so stateful adapters can acknowledge their emitted snapshot.
      // Without this, helper APPLY clock differences and unresolved conflicts
      // both caused a full re-read and re-hash on every poll forever.
      const published = new Set(changedSnapshots.map((s) => s.resourceId));
      let suppressedProjectionChanged = false;
      for (const snapshot of scan.snapshots) {
        if (
          published.has(snapshot.resourceId) ||
          protectedSyntheticResources.has(snapshot.resourceId)
        ) {
          continue;
        }
        if (
          markSuppressedSnapshotProjection(
            repository.state.projections,
            snapshot,
            repository.state.tips[snapshot.resourceId] ?? [],
          )
        ) {
          suppressedProjectionChanged = true;
        }
      }
      const publishableSnapshots = changedSnapshots.map((snapshot) => ({
        ...snapshot,
        parents: conflictedResources.has(snapshot.resourceId)
          ? parentsWithOwnConflictTips(
              repository.state.projections[snapshot.resourceId],
              repository.state.tips[snapshot.resourceId] ?? [],
              repository.state.device.deviceId,
              snapshot.semanticHash,
            )
          : parentsForLocalChange(
              repository.state.projections[snapshot.resourceId],
              repository.state.tips[snapshot.resourceId] ?? [],
            ),
      }));
      // A conflicted resource is excluded from the deletions filter below but
      // not from this one, deliberately: the conflicted side keeps publishing
      // its own tip. Volatile content turned that into one new event per poll
      // forever, so the republish is rate-limited per resource.
      const throttled = throttleConflictedRepublish(
        publishableSnapshots,
        conflictedResources,
        this.conflictedRepublishAt,
        Date.now(),
        CONFLICTED_REPUBLISH_INTERVAL_MS,
      );
      // Nothing is logged for a deferred resource: it would print on every
      // poll for as long as the conflict stands, which is the log flood the
      // standing-warning registry exists to prevent. The conflict itself is
      // already on the status bar and in diagnostics.
      const snapshots = throttled.publish;
      const deletions = scan.deletions.filter(
        (deletion) =>
          !conflictedResources.has(deletion.resourceId) &&
          !protectedSyntheticResources.has(deletion.resourceId) &&
          !(repository.state.tips[deletion.resourceId] ?? []).some(
            (tip) =>
              tip.operation === "delete" &&
              tip.semanticHash === deletion.semanticHash,
          ) &&
          repository.state.projections[deletion.resourceId]?.semanticHash !==
          deletion.semanticHash,
      ).map((deletion) => ({
        ...deletion,
        parents: parentsForLocalChange(
          repository.state.projections[deletion.resourceId],
          repository.state.tips[deletion.resourceId] ?? [],
        ),
      }));
      // The guard has to be keyed to the number `publish` will actually
      // enforce, not to a second live read of the setting. `syncRepositoryLimit`
      // above has already pushed the current setting into the repository, so
      // these are the same value by construction.
      const publishable = filterPublishableChanges(
        snapshots,
        deletions,
        repository.maxPayloadBytes,
        (snapshot) => this.publishWarningSourceFor(snapshot.kind),
      );
      mergeWarningBuckets(
        publishable,
        settleOversizedSnapshots(
          this.adapters,
          scan.warningsBySource.keys(),
          publishableSnapshots,
          repository.maxPayloadBytes,
        ),
      );
      const publishedCount =
        publishable.snapshots.length + publishable.deletions.length;
      let totalPublishedCount = publishedCount + agentKvEnrichedCount;
      // A publish failure must not stop this device from *receiving*. The
      // publish call used to sit in front of applyProjections, so one
      // unpublishable resource stopped every other device's changes from being
      // applied here as well, on every cycle, forever. The error is carried to
      // the end of the cycle instead and rethrown once the inbound half is
      // done.
      let publishError: Error | null = null;
      try {
        await publishInBatches(
          repository,
          publishable.snapshots,
          publishable.deletions,
        );
      } catch (error) {
        publishError = error instanceof Error ? error : new Error(String(error));
      }

      // Recomputed only when this cycle actually added something to the log.
      // A reconcile walks every event to rebuild every resource's version
      // graph - 13,628 events and 2,235 resources on the repository this was
      // measured against - and with nothing published since `preResult` it
      // reads the same files and reaches the same answer. The common cycle
      // publishes nothing, so this was a second full pass, every thirty
      // seconds, in every open window.
      let result =
        publishedCount > 0
          ? await this.reconcileCurrentRepository(repository, checkpoint)
          : preResult;
      const postPublishAutoMerged = await autoMergeConflicts(
        repository,
        result.conflicts,
        (tips) =>
          tips.every(
            (tip) => this.resourceApplyBlockReason(tip) === null,
          ),
        noteMergeWarning,
      );
      autoMergedPublished ||= postPublishAutoMerged;
      if (postPublishAutoMerged) {
        result = await this.reconcileCurrentRepository(repository, checkpoint);
      }
      // Enrichment normally runs before the local scan so an old v1 tip can be
      // upgraded without re-reading every chat. A brand-new/changed chat does
      // not have a repository tip at that point: the old ordering published a
      // renderable v1 body, returned from Sync Now, and left its continuation
      // graph for the *next* cycle. A peer could apply that intermediate tip
      // first and create the exact "conversation renders, next prompt fails"
      // state this transport is meant to prevent.
      //
      // Revisit only the chats this cycle successfully published. A failed
      // batch can leave the repository tip at an older version; enriching
      // that tip would not complete the chat this scan tried to publish and
      // would make the same-cycle guarantee/reporting false.
      //
      // existing enrichment gate keeps complete v2 tips out, caps the batch at
      // two recent chats/32 MiB, reads the repository core rather than a local
      // substitute, and publishes only hash-verified reachable blobs. Larger
      // backlogs remain on the normal resumable round-robin; the active chat
      // becomes complete in the same manual/background cycle whenever B still
      // owns its graph.
      const justPublishedChatIds = new Set(
        publishable.snapshots
          .filter((snapshot) => snapshot.kind === "chat")
          .map((snapshot) => snapshot.resourceId),
      );
      if (
        publishError === null &&
        justPublishedChatIds.size > 0 &&
        this.configuration.syncChat &&
        this.compatibility.databaseCapabilities["global-chat"].available
      ) {
        const tips = Object.create(null) as Record<string, ResourceTip[]>;
        for (const resourceId of justPublishedChatIds) {
          tips[resourceId] = repository.state.tips[resourceId] ?? [];
        }
        const candidateIndex = buildChatTipEnrichmentCandidateIndex(tips);
        if (candidateIndex.length > 0) {
          try {
            const enriched = await enrichCurrentChatTipsFromLiveDatabase(
              repository,
              this.paths.globalDatabase,
              {
                cursor: { afterResourceId: null },
                candidateIndex,
                candidateGeneration: repository.sharedGraphGeneration,
                maxPayloadBytes: repository.maxPayloadBytes,
                attemptCache: this.chatTipEnrichmentAttempts,
                forceRetry: manual,
                tipAllowed: (tip) =>
                  this.resourceApplyBlockReason(tip) === null,
              },
            );
            for (const warning of enriched.warnings) {
              this.status.log(warning);
            }
            if (enriched.published > 0) {
              agentKvEnrichedCount += enriched.published;
              totalPublishedCount += enriched.published;
              // The child tips changed both the shared graph and the exact
              // projections A will queue. Reconcile before any apply decision;
              // a later poll must never be required merely to see this cycle's
              // complete v2 child.
              result = await this.reconcileCurrentRepository(
                repository,
                checkpoint,
              );
              this.chatTipEnrichmentIndex = null;
              this.chatTipEnrichmentCursor = { afterResourceId: null };
            }
          } catch (error) {
            // The ordinary chat body is already durable. Keep synchronization
            // moving, but the receiving-side completeness block below ensures
            // no peer materializes this intermediate tip as resume-ready.
            this.status.log(
              `Post-publish agent blob enrichment was skipped: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
      // Warnings are deduped per source. A cycle that did not run an adapter
      // leaves that adapter's bucket untouched, so an alternating files/chat
      // poll no longer makes every warning look fresh. The reconciler and
      // auto-merge buckets are always observed because both are computed on
      // every cycle regardless of scope; the publish buckets are not, because
      // an oversized resource can only be re-observed by the adapter that owns
      // it, so they are keyed and scoped per adapter.
      const observed = new Map<string, readonly string[]>([
        [
          RECONCILER_WARNING_SOURCE,
          [...new Set([...preResult.warnings, ...result.warnings])],
        ],
        [AUTO_MERGE_WARNING_SOURCE, mergeWarnings],
        ...publishWarningObservation(
          scan.warningsBySource.keys(),
          publishable.warningsBySource,
        ),
        ...scan.warningsBySource,
      ]);
      for (const entry of this.warnings.observe({
        sources: observed,
        now: Date.now(),
        force: manual,
      })) {
        this.status.log(formatWarningLine(entry));
      }
      // Logged through the same registry, so they are deduplicated the same way
      // and do not repeat every thirty seconds - but kept out of `observed`, so
      // nothing here can make the status item amber. A notice is the scan doing
      // what it was configured to do.
      for (const entry of this.notices.observe({
        sources: scan.noticesBySource,
        now: Date.now(),
        force: manual,
      })) {
        this.status.log(formatWarningLine(entry));
      }
      const pendingPruned = prunePending(repository, result.projections);
      const appliedProjectionStateChanged = await this.applyProjections(
        repository,
        result.projections,
        localSnapshots,
        manual,
        scan.deferredAdapterIds,
        scan.adapterIndexes,
      );
      const successfulActivity =
        manual ||
        totalPublishedCount > 0 ||
        autoMergedPublished ||
        synthetic.changed ||
        suppressedProjectionChanged ||
        pendingPruned ||
        appliedProjectionStateChanged ||
        repository.state.pendingDatabaseChanges.length !== pendingCountBefore ||
        repository.state.lastError !== null;
      const stateNeedsPersist =
        !initialReconciliationWasCached || successfulActivity;
      if (stateNeedsPersist) {
        // `lastSyncAt` is status metadata, not a 30-second heartbeat. Rewriting
        // it on a truly idle poll forced a full local-state stringify/write
        // and invalidated the graph cache forever. Record user-visible or
        // state-changing work; a cache miss alone may only be the first
        // compile of an otherwise unchanged repository.
        if (successfulActivity) {
          repository.state.lastSyncAt = new Date().toISOString();
        }
        repository.state.lastError = null;
        await repository.saveState();
        // Reconcile mutates streams/tips/conflicts, and successful projection
        // handling above flips each cached `changed` item to false. Once that
        // exact output is durable, the cached result belongs to the new local
        // input generation; otherwise every real publish pays one redundant
        // full graph compile on the following poll.
        this.alignCurrentReconciliationCache(repository);
      }
      const ackWritten = await repository.writeAck();
      if (
        manual ||
        probeAttempted ||
        totalPublishedCount > 0 ||
        autoMergedPublished ||
        ackWritten
      ) {
        await this.commitGitWindow(
          gitActive,
          repository.root,
          `sync(${repository.state.device.deviceId.slice(0, 8)}): ${totalPublishedCount} change(s)`,
        );
      }
      if (gitActive && totalPublishedCount > 0) {
        await this.warnAboutLargeFiles(repository.root, true);
      }
      await this.noteMaintenanceNeed(repository, result.warnings);
      if (publishError !== null) {
        throw publishError;
      }
    } catch (error) {
      failed = true;
      const message =
        error instanceof Error ? error.stack ?? error.message : String(error);
      // Only the error field is persisted: the failed operation may have left
      // `repository.state` half-mutated, and writing that out is how a
      // transient fault became a permanent fail-stop.
      await repository.recordError(message);
      this.status.log(`Error: ${message}`);
      this.status.setStatus("error", message);
      if (manual) {
        throw error;
      }
    } finally {
      // The terminal status is restored here rather than at the end of the try
      // block so that no future early return can leave the spinner standing.
      this.clearSyncIndicator();
      if (!failed) {
        this.updateStatus(repository);
      }
      await lock.release();
    }
    if (!failed) {
      // The offer can enter Restart to Apply, which queues another cycle. Do
      // not await it from the cycle that must return before that request can
      // start, or accepting the launch prompt self-deadlocks the queue.
      void this.maybeOfferQueuedApplyAtLaunch();
    }
  }

  /**
   * Arms the spinner instead of showing it. A cycle that finishes promptly
   * never displaces the status the user can act on, and a conflict or a pending
   * restart is never displaced at all — those outrank "work is happening".
   */
  private beginSyncIndicator(): void {
    this.clearSyncIndicator();
    // A conflict or a queued change used to suppress this outright, so that a
    // status the user can act on was never displaced by one they cannot. On a
    // repository whose cycles run for minutes that reads as nothing happening
    // at all - which is precisely the state someone waiting for their chats
    // needs to be able to tell apart from a stall. The delay below already
    // keeps a short cycle from touching the item, and the actionable status
    // returns the moment the cycle ends.
    this.syncIndicatorTimer = setTimeout(() => {
      this.syncIndicatorTimer = null;
      if (!this.disposed) {
        this.status.setStatus("syncing");
      }
    }, SYNC_INDICATOR_DELAY_MS);
  }

  private clearSyncIndicator(): void {
    if (this.syncIndicatorTimer !== null) {
      clearTimeout(this.syncIndicatorTimer);
      this.syncIndicatorTimer = null;
    }
  }

  private syncLockPath(): string {
    return join(this.paths.extensionStorage, "sync.lock");
  }

  private backgroundRoleLockPath(): string {
    return join(this.paths.extensionStorage, "background-role.lock");
  }

  /**
   * Raises a helper failure where the user is looking.
   *
   * The status item's "error" presentation points at Show Diagnostics, so
   * latching the failure takes away the one-click path to the retry the text
   * itself asks for. The action puts it back.
   */
  private announceHelperFailure(detail: string): void {
    void vscode.window
      .showErrorMessage(detail, RESTART_TO_APPLY_TITLE)
      .then((choice) => {
        if (choice === RESTART_TO_APPLY_TITLE) {
          return vscode.commands.executeCommand(
            RESTART_TO_APPLY_COMMAND,
            "apply",
          );
        }
        return undefined;
      });
  }

  /**
   * Records a poll that could not take the sync lock, saying so only when the
   * situation has actually changed; see {@link noteLockSkip}.
   */
  private async noteLockSkipped(manual: boolean): Promise<void> {
    let holder: LockHolderReport;
    try {
      holder = await reportLockHolder(this.syncLockPath());
    } catch {
      // `readLock` rethrows anything that is not a missing or malformed file,
      // and EPERM/EBUSY against a lock another process is rewriting is routine
      // on Windows. A skipped poll must not become a failed cycle over it, and
      // carrying the previous PID forward keeps the transient error from
      // reading as a change of holder and re-opening the log.
      holder = {
        pid: this.lockSkip?.pid ?? null,
        description:
          "Another Cursor window or the offline helper is synchronizing. " +
          `Lock file: ${this.syncLockPath()}.`,
      };
    }
    const decision = noteLockSkip(this.lockSkip, holder, Date.now(), manual);
    if (decision.line !== null) {
      this.status.log(decision.line);
    }
    this.lockSkip = decision.state;
  }

  /**
   * The message every command shows when it cannot take the sync lock. It names
   * the holder, its age and the file, so "busy" is something the user can act
   * on rather than a dead end.
   */
  /**
   * Takes the synchronization lock on behalf of a command the user invoked,
   * waiting out a poll instead of failing on one; see
   * {@link COMMAND_LOCK_WAIT_MS}. `report` says what the wait is for, so the
   * command does not simply appear frozen.
   */
  private async takeCommandLock(
    expectedRepository: SyncRepository,
    report: (message: string) => void = () => {},
  ): Promise<FileLock> {
    const lock = await acquireFileLockWithin(
      this.syncLockPath(),
      COMMAND_LOCK_WAIT_MS,
      () => {
        report("Waiting for the current synchronization to finish...");
      },
    );
    if (lock === null) {
      throw await this.synchronizationBusyError();
    }
    try {
      if (this.repository !== expectedRepository) {
        throw new Error(
          "The synchronization repository changed while this command was waiting. Run the command again.",
        );
      }
      // Commands may run in a standby window whose activation intentionally
      // skipped shared-folder recovery. Initialize the snapshot it captured
      // only now, while the command owns sync.lock.
      await expectedRepository.ensureInitialized();
      if (this.repository !== expectedRepository) {
        throw new Error(
          "The synchronization repository changed while this command was opening it. Run the command again.",
        );
      }
    } catch (error) {
      await lock.release();
      throw error;
    }
    return lock;
  }

  private async synchronizationBusyError(): Promise<Error> {
    const holder = await reportLockHolder(this.syncLockPath());
    if (holder.pid === process.pid) {
      // "Another Cursor window or the offline helper" sent people hunting for a
      // window that was not there: the holder is this window's own background
      // cycle, which is also the only case a command can do nothing about by
      // closing something.
      return new Error(
        "This window's own background synchronization is still running and did not finish in time. " +
          "It is a long cycle rather than a second window; try the command again in a moment.",
      );
    }
    return new Error(holder.description);
  }

  private async scanLocalResources(
    known: Record<string, LocalProjection>,
    scope: SyncScope = "all",
    requiredKinds: ReadonlySet<ResourceKind> = new Set(),
    maxPayloadBytes?: number,
  ): Promise<LocalScanResult> {
    const result = await scanAdapters(
      this.adapters,
      known,
      scope,
      requiredKinds,
      maxPayloadBytes,
      { startAfterAdapterId: this.adapterScanCursorByScope.get(scope) ?? null },
    );
    if (result.cursorAfterAdapterId === null) {
      this.adapterScanCursorByScope.delete(scope);
    } else {
      this.adapterScanCursorByScope.set(scope, result.cursorAfterAdapterId);
    }
    return result;
  }

  private async applyProjections(
    repository: SyncRepository,
    projections: ResourceProjection[],
    localSnapshots: Map<string, ResourceSnapshot>,
    manual: boolean,
    deferredAdapterIds: ReadonlySet<string> = new Set(),
    adapterScanIndexes: ReadonlyMap<string, AdapterScanIndex> = new Map(),
  ): Promise<boolean> {
    const scannedByAdapter = new Map<string, AdapterScanIndex | null>();
    let stateChanged = false;
    for (const projection of projections.filter((candidate) => candidate.changed)) {
      const tip = projection.tip;
      const local = localSnapshots.get(projection.resourceId);
      if (
        (tip.deviceId === repository.state.device.deviceId &&
          !isSyntheticTip(tip)) ||
        local?.semanticHash === tip.semanticHash
      ) {
        markProjection(repository, projection, local);
        stateChanged = true;
        continue;
      }
      if (
        ["chat", "chat-transcript", "chat-store", "workspace-storage"].includes(
          tip.kind,
        ) &&
        tip.operation === "delete"
      ) {
        markProjection(repository, projection, local);
        stateChanged = true;
        continue;
      }
      if (isPolicyExcludedUiStateResource(projection.resourceId, tip.kind)) {
        // A peer running an older build published this key before the kind was
        // excluded. Accept the version without writing it: the helper would
        // skip it anyway, and queueing it only makes the user restart for a
        // change that will never be applied.
        this.status.log(
          `Skipped ${projection.resourceId}: window layout is kept local to ` +
            "each computer and is no longer synchronized.",
        );
        markProjection(repository, projection, local);
        stateChanged = true;
        continue;
      }
      const blockedReason = this.resourceApplyBlockReason(tip);
      if (blockedReason !== null) {
        if (queuePending(repository, projection, blockedReason)) {
          stateChanged = true;
        }
        continue;
      }
      const adapter = this.adapterFor(tip.kind);
      if (adapter.appliesWhileRunning && (this.configuration.autoApplyFiles || manual)) {
        const liveApplyBlock = runningApplyPayloadBlockReason(
          projection.resourceId,
          tip,
          repository.maxPayloadBytes,
        );
        if (liveApplyBlock !== null) {
          if (queuePending(repository, projection, liveApplyBlock)) {
            stateChanged = true;
          }
          continue;
        }
        // Every inbound live write, not only a synthetic merge, is checked
        // against a bounded local observation. A scan failure/incomplete page
        // or an unpublished edit must never be overwritten merely because the
        // resource was not in this cycle's retained snapshot page.
        const scanned =
          local === undefined
            ? (adapterScanIndexes.get(adapter.id) ??
              (deferredAdapterIds.has(adapter.id)
                ? incompleteScanIndex()
                : await this.scanAdapterForDrift(
                    adapter,
                    repository.state.projections,
                    scannedByAdapter,
                  )))
            : singleSnapshotScanIndex(local);
        const decision = isSyntheticTip(tip)
          ? syntheticApplyDecision(
              scanned,
              projection.resourceId,
              tip,
              repository.state.projections[projection.resourceId],
            )
          : ordinaryApplyDecision(
              scanned,
              projection.resourceId,
              tip,
              repository.state.projections[projection.resourceId],
            );
        if (decision.action === "drift") {
          if (queuePending(repository, projection)) {
            stateChanged = true;
          }
          continue;
        }
        if (decision.action === "already-applied") {
          markProjection(repository, projection, decision.live);
          stateChanged = true;
          continue;
        }
        if (await this.applyProjectionGuarded(repository, adapter, projection)) {
          stateChanged = true;
        }
      } else {
        if (queuePending(repository, projection)) {
          stateChanged = true;
        }
      }
    }
    return stateChanged;
  }

  /**
   * Applies one projection so that its failure defers only itself.
   *
   * An unguarded apply used to poison the whole batch: one blob whose event
   * had crossed the shared folder ahead of its payload threw out of the loop,
   * discarding every sibling apply, the ack and the publish - cycle after
   * cycle until the file finished hydrating. The projection is left unmarked
   * on failure, so the reconciler re-derives it and the apply retries every
   * cycle until it lands; the missing-payload case logs once per resource,
   * anything else logs every cycle, which is what keeps a genuine failure
   * visible.
   */
  private async applyProjectionGuarded(
    repository: SyncRepository,
    adapter: ResourceAdapter,
    projection: Parameters<typeof projectionInput>[1],
  ): Promise<boolean> {
    try {
      const applyResult = await adapter.apply(
        await projectionInput(repository, projection),
      );
      markProjection(repository, projection, undefined, applyResult);
      this.deferredApplyNoted.delete(projection.resourceId);
      return true;
    } catch (error) {
      if (isMissingPathError(error)) {
        if (!this.deferredApplyNoted.has(projection.resourceId)) {
          this.deferredApplyNoted.add(projection.resourceId);
          this.status.log(
            `Deferred ${projection.resourceId}: its data has not reached this computer through the shared folder yet; retrying every cycle.`,
          );
        }
        return false;
      }
      this.status.log(
        `Applying ${projection.resourceId} failed and will be retried next cycle: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async applySyntheticProjectionsBeforeScan(
    repository: SyncRepository,
    projections: ResourceProjection[],
  ): Promise<SyntheticApplyResult> {
    const driftSkipped = new Set<string>();
    const scannedByAdapter = new Map<string, AdapterScanIndex | null>();
    // Whether this pass touched the state at all. The caller re-reconciles
    // afterwards, which on the measured repository walks 13,628 events to
    // rebuild 2,235 version graphs - so doing it after a pass that changed
    // nothing is a second full reconcile for no new information, on every
    // poll, in every window. Synthetic tips are rare; the usual answer is
    // that there were none.
    let changed = false;
    for (const projection of projections) {
      if (!projection.changed || !isSyntheticTip(projection.tip)) {
        continue;
      }
      changed = true;
      const tip = projection.tip;
      if (
        tip.operation === "delete" &&
        ["chat", "chat-transcript", "chat-store", "workspace-storage"].includes(
          tip.kind,
        )
      ) {
        continue;
      }
      const blockedReason = this.resourceApplyBlockReason(tip);
      if (blockedReason !== null) {
        queuePending(repository, projection, blockedReason);
        continue;
      }
      const adapter = this.adapterFor(tip.kind);
      if (!adapter.appliesWhileRunning) {
        queuePending(repository, projection);
        continue;
      }
      const liveApplyBlock = runningApplyPayloadBlockReason(
        projection.resourceId,
        tip,
        repository.maxPayloadBytes,
      );
      if (liveApplyBlock !== null) {
        queuePending(repository, projection, liveApplyBlock);
        continue;
      }
      const scanned = await this.scanAdapterForDrift(
        adapter,
        repository.state.projections,
        scannedByAdapter,
      );
      const decision = syntheticApplyDecision(
        scanned,
        projection.resourceId,
        tip,
        repository.state.projections[projection.resourceId],
      );
      if (decision.action === "drift") {
        driftSkipped.add(projection.resourceId);
        continue;
      }
      if (decision.action === "already-applied") {
        markProjection(repository, projection, decision.live);
        continue;
      }
      await this.applyProjectionGuarded(repository, adapter, projection);
    }
    if (changed) {
      await repository.saveState();
    }
    return { driftSkipped, changed };
  }

  private async scanAdapterForDrift(
    adapter: ResourceAdapter,
    known: Record<string, LocalProjection>,
    cache: Map<string, AdapterScanIndex | null>,
  ): Promise<AdapterScanIndex | null> {
    let scanned = cache.get(adapter.id);
    if (scanned === undefined) {
      try {
        adapter.setMaxPayloadBytes?.(this.configuration.maxPayloadBytes);
        const result = await adapter.scan(known);
        const status = adapter.scanStatus?.();
        const settledOversized = adapter.oversizedSnapshotSettlements?.(
          this.configuration.maxPayloadBytes,
        ) ?? [];
        scanned = {
          snapshots: new Map(
            result.snapshots.map((snapshot) => [snapshot.resourceId, snapshot]),
          ),
          deletions: new Map(
            result.deletions.map((deletion) => [deletion.resourceId, deletion]),
          ),
          complete: status?.complete ?? true,
          deferredResourceIds: new Set(
            [
              ...(status?.deferredResourceIds ?? []),
              ...settledOversized.map((settlement) => settlement.resourceId),
            ],
          ),
        };
      } catch (error) {
        this.status.log(
          `Warning: Adapter ${adapter.id} scan failed before applying a merge result: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        scanned = null;
      }
      cache.set(adapter.id, scanned);
    }
    return scanned;
  }

  private async applyPendingRunningResources(
    repository: SyncRepository,
  ): Promise<void> {
    const pending = [...repository.state.pendingDatabaseChanges];
    const scannedByAdapter = new Map<string, AdapterScanIndex | null>();
    for (const item of pending) {
      const tip = findTip(
        repository,
        item.resourceId,
        item.eventHash,
        item.changeIndex,
      );
      if (tip === undefined) {
        continue;
      }
      const blockedReason = this.resourceApplyBlockReason(tip);
      if (blockedReason !== null) {
        item.blockedReason = blockedReason;
        continue;
      }
      const adapter = this.adapterFor(tip.kind);
      if (!adapter.appliesWhileRunning) {
        continue;
      }
      const liveApplyBlock = runningApplyPayloadBlockReason(
        item.resourceId,
        tip,
        repository.maxPayloadBytes,
      );
      if (liveApplyBlock !== null) {
        item.blockedReason = liveApplyBlock;
        continue;
      }
      const projection: ResourceProjection = {
        resourceId: item.resourceId,
        tip,
        changed: true,
      };
      const scanned = await this.scanAdapterForDrift(
        adapter,
        repository.state.projections,
        scannedByAdapter,
      );
      const decision = isSyntheticTip(tip)
        ? syntheticApplyDecision(
            scanned,
            item.resourceId,
            tip,
            repository.state.projections[item.resourceId],
          )
        : ordinaryApplyDecision(
            scanned,
            item.resourceId,
            tip,
            repository.state.projections[item.resourceId],
          );
      if (decision.action === "drift") {
        continue;
      }
      if (decision.action === "already-applied") {
        markProjection(repository, projection, decision.live);
        continue;
      }
      const applied = await this.applyProjectionGuarded(
        repository,
        adapter,
        projection,
      );
      if (!applied) {
        continue;
      }
      repository.state.pendingDatabaseChanges =
        repository.state.pendingDatabaseChanges.filter(
          (candidate) =>
            candidate.eventHash !== item.eventHash ||
            candidate.changeIndex !== item.changeIndex,
        );
    }
    await repository.saveState();
  }

  /**
   * Forces a bounded full-core observation of every queued chat immediately
   * before the offline helper is allowed to overwrite the live database.
   * Cursor can change a chat core without moving its timestamp or bubble
   * count; the ordinary poll fast path cannot prove those bytes unchanged.
   */
  private async protectQueuedChatsBeforeOfflineApply(
    repository: SyncRepository,
  ): Promise<void> {
    const queued = repository.state.pendingDatabaseChanges.filter(
      (pending) => pending.kind === "chat" && pending.blockedReason === undefined,
    );
    if (queued.length === 0) {
      return;
    }
    const targetIds = new Set(queued.map((pending) => pending.resourceId));
    const scanKnown = projectionOverlayForBoundedScan(
      repository.state.projections,
    );
    const adapter = new StateVscdbChatAdapter(this.paths, {
      periodicDeepVerification: false,
      forceCoreVerificationResourceIds: [...targetIds],
    });
    adapter.setMaxPayloadBytes(repository.maxPayloadBytes);
    const verified = new Set<string>();
    const block = (resourceId: string, detail: string): void => {
      const pending = repository.state.pendingDatabaseChanges.find(
        (item) => item.kind === "chat" && item.resourceId === resourceId,
      );
      if (pending !== undefined) {
        pending.blockedReason = `${APPLY_FAILURE_BLOCK_PREFIX}: ${detail}`;
      }
    };
    try {
      for (let pass = 0; pass < 32 && verified.size < targetIds.size; pass += 1) {
        const result = await adapter.scan(scanKnown);
        for (const snapshot of result.snapshots) {
          rememberTemporarySnapshotProjection(scanKnown, snapshot);
          if (!targetIds.has(snapshot.resourceId)) {
            continue;
          }
          const pending = repository.state.pendingDatabaseChanges.find(
            (item) => item.kind === "chat" && item.resourceId === snapshot.resourceId,
          );
          const tip =
            pending === undefined
              ? undefined
              : findTip(
                  repository,
                  pending.resourceId,
                  pending.eventHash,
                  pending.changeIndex,
                );
          const known = repository.state.projections[snapshot.resourceId];
          if (tip === undefined) {
            verified.add(snapshot.resourceId);
            continue;
          }
          if (snapshot.semanticHash === tip.semanticHash) {
            markProjection(
              repository,
              { resourceId: snapshot.resourceId, tip, changed: true },
              snapshot,
            );
            verified.add(snapshot.resourceId);
            continue;
          }
          if (
            snapshot.semanticHash === known?.semanticHash ||
            snapshot.semanticHash === known?.retainedLocalHash
          ) {
            verified.add(snapshot.resourceId);
            continue;
          }
          try {
            await repository.publish(
              [
                {
                  ...snapshot,
                  parents: parentsForLocalChange(
                    known,
                    repository.state.tips[snapshot.resourceId] ?? [],
                  ),
                },
              ],
              [],
            );
            block(
              snapshot.resourceId,
              `A local edit to ${snapshot.resourceId} was captured before the queued database write. Synchronize again and resolve the resulting conversation conflict before retrying Cursor Setting Sync: Manage → Sync & Apply Now.`,
            );
          } catch (error) {
            block(
              snapshot.resourceId,
              `The final local verification for ${snapshot.resourceId} could not be published: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          verified.add(snapshot.resourceId);
        }
        for (const deletion of result.deletions) {
          if (targetIds.has(deletion.resourceId)) {
            verified.add(deletion.resourceId);
          }
        }
        const status = adapter.scanStatus();
        const deferred = new Set(status.deferredResourceIds);
        for (const resourceId of targetIds) {
          if (!verified.has(resourceId) && !deferred.has(resourceId)) {
            verified.add(resourceId);
          }
        }
        if (status.complete) {
          break;
        }
      }
    } catch (error) {
      for (const resourceId of targetIds) {
        if (!verified.has(resourceId)) {
          block(
            resourceId,
            `The final local verification for ${resourceId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    for (const resourceId of targetIds) {
      if (!verified.has(resourceId)) {
        block(
          resourceId,
          `The final local verification for ${resourceId} did not finish within the bounded scan. Retry after the current synchronization completes.`,
        );
      }
    }
    await repository.saveState();
  }

  /**
   * Drops the blocks the last apply's failures left behind, so an apply the
   * user deliberately started tries them once more.
   *
   * Only from `restartToApply`. The queued-apply modal reaches the same command,
   * but it can only appear when something UNBLOCKED is waiting - so a queue
   * whose every entry failed goes quiet instead of quitting Cursor on a loop.
   */
  private clearApplyFailureBlocks(repository: SyncRepository): void {
    for (const pending of repository.state.pendingDatabaseChanges) {
      if (pending.blockedReason?.startsWith(APPLY_FAILURE_BLOCK_PREFIX)) {
        delete pending.blockedReason;
      }
    }
  }

  private async lookupWorkspaceIdentitiesInPages(
    workspaceIds: Iterable<string>,
  ): Promise<Map<string, WorkspaceIdentity>> {
    const ids = [...new Set(workspaceIds)];
    const resolved = new Map<string, WorkspaceIdentity>();
    for (
      let offset = 0;
      offset < ids.length;
      offset += WORKSPACE_IDENTITY_LOOKUPS_PER_PAGE
    ) {
      const page = ids.slice(
        offset,
        offset + WORKSPACE_IDENTITY_LOOKUPS_PER_PAGE,
      );
      const identities = await lookupWorkspaceIdentitiesById(
        this.paths,
        page,
        { maxLookups: page.length },
      );
      for (const [workspaceId, identity] of identities) {
        resolved.set(workspaceId, identity);
      }
    }
    return resolved;
  }

  private async expandWorkspaceMappingCandidates(
    pass: WorkspaceMappingPassResult,
  ): Promise<WorkspaceMappingPassResult> {
    if (pass.unreadableLocalWorkspaceIds.length === 0) {
      return pass;
    }
    // Manual discovery is read-only and runs without sync.lock or the command
    // floor. Every cold identity gets one bounded direct lookup, so hundreds
    // of historical workspaces do not require repeatedly invoking the command;
    // genuinely unreadable files remain omitted and explicitly counted.
    const recovered = await this.lookupWorkspaceIdentitiesInPages(
      pass.unreadableLocalWorkspaceIds,
    );
    const localWorkspaceById = new Map(
      pass.localWorkspaces.map((workspace) => [workspace.id, workspace]),
    );
    for (const [workspaceId, workspace] of recovered) {
      localWorkspaceById.set(workspaceId, workspace);
    }
    const unreadableLocalWorkspaceIds =
      pass.unreadableLocalWorkspaceIds.filter(
        (workspaceId) => !recovered.has(workspaceId),
      );
    return {
      ...pass,
      localWorkspaces: [...localWorkspaceById.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      unreadableLocalWorkspaceIds,
      unreadableLocalWorkspaces: unreadableLocalWorkspaceIds.length,
    };
  }

  private async ensureWorkspaceMappings(
    repository: SyncRepository,
  ): Promise<WorkspaceMappingPassResult> {
    const workspaceMappings = Object.assign(
      Object.create(null) as Record<string, string>,
      this.configuration.workspaceMappings,
    );
    const pendingChanges = repository.state.pendingDatabaseChanges
      .map((pending) => ({
        pending,
        lastUpdatedAt: pendingLastUpdatedAt(repository, pending),
      }))
      .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt)
      .map((entry) => entry.pending);

    // Resolve every authenticated pending reference in fixed-size pages. A
    // hard cap here stranded entries after the first 512 forever because the
    // same newest entries occupied every later pass.
    const targetedWorkspaceIds = new Set<string>();
    for (const kind of ["workspace-storage", "chat"] as const) {
      for (const pending of pendingChanges) {
        if (pending.kind !== kind) {
          continue;
        }
        const tip = findTip(
          repository,
          pending.resourceId,
          pending.eventHash,
          pending.changeIndex,
        );
        const sourceWorkspaceId = tip?.metadata?.workspaceId;
        if (
          tip === undefined ||
          tip.operation === "delete" ||
          typeof sourceWorkspaceId !== "string"
        ) {
          continue;
        }
        targetedWorkspaceIds.add(sourceWorkspaceId);
        const storedTarget = workspaceMappings[sourceWorkspaceId];
        if (typeof storedTarget === "string") {
          targetedWorkspaceIds.add(storedTarget);
        }
      }
    }

    const discovery = await discoverWorkspacesDetailed(this.paths);
    const targetedWorkspaces = await this.lookupWorkspaceIdentitiesInPages(
      targetedWorkspaceIds,
    );
    const localWorkspaceById = new Map<string, WorkspaceIdentity>(
      discovery.workspaces.map((workspace) => [workspace.id, workspace]),
    );
    // The targeted lookup checks ctime as well as mtime and therefore wins over
    // a healthy discovery memo if workspace.json was rewritten in place.
    for (const [workspaceId, workspace] of targetedWorkspaces) {
      localWorkspaceById.set(workspaceId, workspace);
    }
    const unreadableLocalWorkspaceIds = discovery.unreadableIds.filter(
      (workspaceId) => !targetedWorkspaces.has(workspaceId),
    );
    // A prior healthy memo is retained when workspace.json is torn. It is
    // useful to the next scan, but not safe to offer as a current manual
    // target until the direct read succeeds again.
    for (const workspaceId of unreadableLocalWorkspaceIds) {
      localWorkspaceById.delete(workspaceId);
    }
    const localWorkspaces = [...localWorkspaceById.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const unresolved = new Map<string, PendingWorkspaceMappingChoice>();
    let automaticMappings = 0;
    let mappingStateChanged = false;
    let pendingWorkspaceStorage = 0;
    for (const pending of pendingChanges) {
      if (pending.kind !== "chat" && pending.kind !== "workspace-storage") {
        continue;
      }
      if (pending.kind === "workspace-storage") {
        pendingWorkspaceStorage += 1;
      }
      const tip = findTip(
        repository,
        pending.resourceId,
        pending.eventHash,
        pending.changeIndex,
      );
      if (tip === undefined || tip.operation === "delete") {
        continue;
      }
      const configuredBlock = this.resourceApplyBlockReason(tip);
      if (configuredBlock !== null) {
        pending.blockedReason = configuredBlock;
        continue;
      }
      const sourceWorkspaceId = tip.metadata?.workspaceId;
      const sourceWorkspaceUri = tip.metadata?.workspaceUri;
      if (pending.kind === "chat" && sourceWorkspaceId === null) {
        // A workspace-less composer has nothing to map; the helper writes its
        // NULL workspaceId straight back. Mapping is resolved, but continuation
        // completeness is an independent apply gate and must survive.
        const previous = pending.blockedReason;
        clearWorkspaceMappingOwnedBlock(pending, tip);
        mappingStateChanged ||= pending.blockedReason !== previous;
        continue;
      }
      if (typeof sourceWorkspaceId !== "string") {
        pending.blockedReason = "Incoming workspace metadata is missing a workspace ID.";
        continue;
      }
      const exactSourceUri =
        unreadableLocalWorkspaceIds.length === 0 &&
        typeof sourceWorkspaceUri === "string"
          ? sourceWorkspaceUri
          : null;
      const resolved = resolveTargetWorkspace(
        sourceWorkspaceId,
        exactSourceUri,
        localWorkspaces,
        workspaceMappings,
      );
      if (resolved !== null) {
        const storedTarget = workspaceMappings[sourceWorkspaceId];
        const mappingChanged =
          storedTarget === undefined
            ? resolved !== sourceWorkspaceId
            : storedTarget !== resolved;
        if (mappingChanged) {
          await this.configuration.setWorkspaceMapping(
            sourceWorkspaceId,
            resolved,
          );
          workspaceMappings[sourceWorkspaceId] = resolved;
          automaticMappings += 1;
        }
        mappingStateChanged =
          this.updateWorkspaceMappingBlocks(
            repository,
            sourceWorkspaceId,
            null,
          ) || mappingStateChanged;
        continue;
      }
      if (pending.kind === "workspace-storage" && typeof sourceWorkspaceUri !== "string") {
        // A workspaceStorage directory with no folder URI belongs to a window
        // that had nothing open. Its name is the millisecond it was created, so
        // it names a window on one computer and can never name one here - and
        // the prompt for it listed every local workspace under a bare number,
        // with no correct answer anywhere in the list, forever.
        //
        // Only workspaceStorage. Without that guard this caught chats too, and
        // a chat carrying a workspace ID whose URI never travelled was deferred
        // with a message about workspace storage - 69 conversations held back
        // by a rule that was never about them, reported under a reason that
        // could not be acted on.
        if (pending.blockedReason !== PERMANENT_EXCLUSION_REASONS[3]) {
          pending.blockedReason = PERMANENT_EXCLUSION_REASONS[3];
          mappingStateChanged = true;
        }
        continue;
      }
      if (pending.kind === "chat") {
        // A chat is content, not per-workspace scaffolding: it is worth having
        // on this computer whether or not the folder it was written in exists
        // here. The helper writes it under the workspace ID it came with, so a
        // question with no answerable option is never asked - and asking it was
        // not free, because the modal had to be answered before ANY queued
        // change could apply. On a two-machine setup that is how 146 incoming
        // conversations stayed undelivered behind a list of unrelated projects.
        const previous = pending.blockedReason;
        clearWorkspaceMappingOwnedBlock(pending, tip);
        mappingStateChanged ||= pending.blockedReason !== previous;
        continue;
      }
      if (typeof sourceWorkspaceUri !== "string") {
        continue;
      }
      mappingStateChanged =
        this.updateWorkspaceMappingBlocks(
          repository,
          sourceWorkspaceId,
          WORKSPACE_MAPPING_BLOCK_REASON,
        ) || mappingStateChanged;
      if (!unresolved.has(sourceWorkspaceId)) {
        unresolved.set(sourceWorkspaceId, {
          sourceWorkspaceId,
          sourceWorkspaceUri,
        });
      }
    }

    return {
      automaticMappings,
      localWorkspaces,
      mappingStateChanged,
      pendingWorkspaceStorage,
      unreadableLocalWorkspaceIds,
      unreadableLocalWorkspaces: unreadableLocalWorkspaceIds.length,
      unresolved: [...unresolved.values()],
    };
  }

  private updateWorkspaceMappingBlocks(
    repository: SyncRepository,
    sourceWorkspaceId: string,
    reason: string | null,
  ): boolean {
    let changed = false;
    for (const pending of repository.state.pendingDatabaseChanges) {
      if (pending.kind !== "chat" && pending.kind !== "workspace-storage") {
        continue;
      }
      const tip = findTip(
        repository,
        pending.resourceId,
        pending.eventHash,
        pending.changeIndex,
      );
      if (
        tip?.metadata?.workspaceId !== sourceWorkspaceId ||
        this.resourceApplyBlockReason(tip) !== null
      ) {
        continue;
      }
      if (reason === null) {
        const previous = pending.blockedReason;
        clearWorkspaceMappingOwnedBlock(pending, tip);
        changed ||= pending.blockedReason !== previous;
      } else if (pending.kind === "workspace-storage") {
        // Only workspaceStorage is held back for a missing mapping. A chat is
        // written under the workspace ID it came with, so declining to map a
        // workspace must not also withhold the conversations from it.
        if (pending.blockedReason !== reason) {
          pending.blockedReason = reason;
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * Rebuilt only when the patterns change: this is consulted once per changed
   * projection per cycle, and compiling a pattern list on a repository with
   * thousands of workspaceStorage resources is not free.
   */
  private ignoredWorkspaceCache: { key: string; matcher: IgnoreMatcher } | null =
    null;

  private ignoredWorkspaceMatcher(): IgnoreMatcher {
    const patterns = this.configuration.effectiveIgnoredWorkspaces;
    const key = patterns.join("\u0000");
    if (this.ignoredWorkspaceCache?.key !== key) {
      this.ignoredWorkspaceCache = {
        key,
        matcher: createIgnoreMatcher(patterns),
      };
    }
    return this.ignoredWorkspaceCache.matcher;
  }

  private resourceApplyBlockReason(tip: ResourceTip): string | null {
    const configuredBlock = resourceConfigurationBlockReason(tip.kind, {
      syncChat: this.configuration.syncChat,
      syncWorkspaceStorage: this.configuration.syncWorkspaceStorage,
    });
    if (configuredBlock !== null) {
      return configuredBlock;
    }
    // Checked before the capability reasons so an excluded workspace never
    // reaches `ensureWorkspaceMappings`: a local folder from another computer
    // has no answer on this one, and it should stay out of both automatic and
    // explicitly requested candidate resolution.
    if (
      tip.kind === "workspace-storage" &&
      isIgnoredWorkspaceUri(
        typeof tip.metadata?.workspaceUri === "string"
          ? tip.metadata.workspaceUri
          : null,
        this.ignoredWorkspaceMatcher(),
      )
    ) {
      return PERMANENT_EXCLUSION_REASONS[2];
    }
    return databaseApplyBlockReason(
      tip.kind,
      effectiveTipProducer(tip),
      this.compatibility,
    );
  }

  /**
   * The warning bucket an oversized resource of this kind belongs to: the
   * adapter that produces it, because only a cycle that scans that adapter can
   * ever report the resource as no longer oversized.
   */
  private publishWarningSourceFor(kind: ResourceKind): string {
    const adapter = this.adapters.find((candidate) =>
      candidate.kinds.includes(kind),
    );
    return publishWarningSource(adapter?.id ?? kind);
  }

  private adapterFor(kind: ResourceKind): ResourceAdapter {
    const adapter = this.adapters.find((candidate) =>
      candidate.kinds.includes(kind),
    );
    if (adapter === undefined) {
      throw new Error(`No resource adapter is registered for ${kind}.`);
    }
    return adapter;
  }

  private async liveResourceSnapshot(
    resourceId: string,
    kind: ResourceKind,
  ): Promise<ResourceSnapshot | undefined> {
    return this.withAdapterUse(async () => {
      const adapter = this.adapters.find((candidate) =>
        candidate.kinds.includes(kind),
      );
      if (adapter === undefined || adapter.scanWhileRunning === false) {
        return undefined;
      }
      try {
        const scan = await adapter.scan({});
        return scan.snapshots.find(
          (snapshot) => snapshot.resourceId === resourceId,
        );
      } catch {
        // Without a readable live snapshot the keep-local option is omitted.
        return undefined;
      }
    });
  }

  /**
   * Rebuilds the adapter set and drops warning buckets whose adapter no longer
   * exists. Turning off chat sync or losing database compatibility removes
   * adapters, and nothing would ever clear their standing warnings again.
   */
  private async refreshAdapters(): Promise<void> {
    await this.replaceAdapters(this.createAdapters());
    this.adapterScanCursorByScope.clear();
    this.warnings.retainSources(
      new Set([
        RECONCILER_WARNING_SOURCE,
        AUTO_MERGE_WARNING_SOURCE,
        PUBLISH_WARNING_SOURCE,
        // Not tied to any adapter: the helper reports for a process that has
        // already exited, and turning an adapter off cannot make what it found
        // untrue.
        HELPER_WARNING_SOURCE,
        ...this.adapters.flatMap((adapter) => [
          adapter.id,
          publishWarningSource(adapter.id),
        ]),
      ]),
    );
    // Notices are keyed by adapter id alone; without this, a notice raised by
    // an adapter that was then turned off (the bodyless-chats note after
    // syncChat goes false) stood in diagnostics and re-logged on every manual
    // sync until the window reloaded.
    this.notices.retainSources(
      new Set(this.adapters.map((adapter) => adapter.id)),
    );
  }

  /**
   * Runs against one stable adapter generation. A replacement installs its
   * barrier synchronously, so no new scan can enter between the idle check and
   * disposal of the old generation.
   */
  private async withAdapterUse<T>(run: () => Promise<T>): Promise<T> {
    while (this.adapterReplacementBarrier !== null) {
      await this.adapterReplacementBarrier;
    }
    this.adapterUseCount += 1;
    try {
      return await run();
    } finally {
      this.adapterUseCount -= 1;
      if (this.adapterUseCount === 0) {
        for (const resolve of this.adapterUseIdleResolvers.splice(0)) {
          resolve();
        }
      }
    }
  }

  private waitForAdapterUsesToSettle(): Promise<void> {
    return this.adapterUseCount === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          this.adapterUseIdleResolvers.push(resolve);
        });
  }

  /**
   * Serializes generation swaps, waits for old scans/applies, then disposes
   * every retired adapter exactly once. New users wait behind the whole queue.
   */
  private async replaceAdapters(next: ResourceAdapter[]): Promise<void> {
    let releaseReplacement!: () => void;
    const replacement = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const predecessor = this.adapterReplacementBarrier;
    const barrier = (predecessor ?? Promise.resolve()).then(() => replacement);
    this.adapterReplacementBarrier = barrier;
    try {
      await predecessor;
      await this.waitForAdapterUsesToSettle();
      const previous = this.adapters;
      const install = this.disposed ? [] : next;
      this.adapters = install;
      const retired = this.disposed ? [...previous, ...next] : previous;
      try {
        await disposeResourceAdapters(retired);
      } catch (error) {
        // Teardown remains best-effort across native close errors, but never
        // silently: all disposers were attempted by disposeResourceAdapters.
        this.status.log(
          `Retiring resource adapters failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } finally {
      releaseReplacement();
      if (this.adapterReplacementBarrier === barrier) {
        this.adapterReplacementBarrier = null;
      }
    }
  }

  /**
   * Every setting key this device refuses to publish because it describes the
   * machine rather than a preference: the built-in default list plus whatever
   * the installed extensions declare as `machine`-scoped. The defaults matter
   * because VS Code registers `window.zoomLevel`, the terminal profiles, the
   * proxy keys and `remote.SSH.*` in workbench code, where no package.json
   * scan can ever see them.
   */
  machineSpecificSettingPatterns(): string[] {
    const packageJson: unknown[] = vscode.extensions.all.map(
      (extension): unknown => extension.packageJSON as unknown,
    );
    return [
      ...(this.configuration.useDefaultIgnoredSettings
        ? DEFAULT_IGNORED_SETTINGS
        : []),
      ...collectMachineScopedSettings(packageJson),
    ];
  }

  private createAdapters(): ResourceAdapter[] {
    const adapters: ResourceAdapter[] = [
      new SettingsAdapter(
        this.paths,
        createSettingsIgnoreMatcher(this.configuration.ignoredSettings),
        createSettingsIgnoreMatcher(this.machineSpecificSettingPatterns()),
        createSettingsIgnoreMatcher(
          this.configuration.useDefaultIgnoredSettings
            ? [...DEFAULT_IGNORED_SETTINGS]
            : [],
        ),
      ),
      new ProfileFilesAdapter(this.paths),
      new CursorUserFilesAdapter(
        this.paths,
        normalizeIgnoredUserFiles(this.configuration.ignoredUserFiles),
      ),
      new WorkspaceStorageAdapter(
        this.paths,
        this.configuration.workspaceMappings,
        this.configuration.maxPayloadBytes,
        this.ignoredWorkspaceMatcher(),
        // Images only, and live. A chat is published within thirty seconds of
        // being written; its screenshots used to wait for the next shutdown,
        // so the other computer received a conversation it could not open -
        // Cursor refuses a turn whose image is missing. The databases still
        // wait for the shutdown export, which is the pass that has Cursor to
        // itself. The helper builds its own adapter without this flag.
        true,
      ),
    ];
    if (this.compatibility.compatible) {
      adapters.push(
        new ProfilesAdapter(this.paths),
        new UiStateAdapter(
          this.paths,
          normalizeIgnoredUiStateKeys(this.configuration.ignoredUiStateKeys),
        ),
        new ExtensionsAdapter(
          this.paths,
          createExtensionIgnoreMatcher(this.configuration.ignoredExtensions),
        ),
      );
    }
    if (this.configuration.syncChat) {
      adapters.push(new ChatTranscriptsAdapter(this.paths));
      if (this.compatibility.compatible) {
        adapters.push(
          new StateVscdbChatAdapter(this.paths),
          new StoreDbChatAdapter(this.paths),
        );
      }
    }
    return adapters;
  }

  private async openConfiguredRepository(masterKey: Buffer): Promise<boolean> {
    const root = this.configuration.repositoryPath;
    if (root === null) {
      return false;
    }
    const expectedRepositoryId = this.configuration.repositoryId;
    const current = this.repository;
    if (
      current !== null &&
      current.root === root &&
      (expectedRepositoryId === null ||
        current.repository.repositoryId === expectedRepositoryId)
    ) {
      return true;
    }
    const generation = ++this.configuredOpenGeneration;
    await assertSafeRepositoryLocation(root, this.synchronizedSourceRoots());
    const repositoryFile = await readRepositoryManifest(root);
    if (
      expectedRepositoryId !== null &&
      repositoryFile.repositoryId !== expectedRepositoryId
    ) {
      throw new Error(
        'The configured folder now contains a different repository. Open "Cursor Setting Sync: Manage", choose "Repository & Devices…", then use "Setup or Reconfigure This PC…" to point at the original folder or "Disconnect This PC" to clear this PC\'s stored repository configuration before connecting to this one.',
      );
    }
    // Keep the candidate key private to this attempt. Publishing it on the
    // manager before the awaits below let an overlapping open zero the Buffer
    // while this repository was still deriving its subkeys.
    const openingKey = Buffer.from(masterKey);
    let opened: SyncRepository;
    try {
      opened = await SyncRepository.openDeferredWithMasterKey(
        root,
        this.paths.extensionStorage,
        repositoryFile,
        openingKey,
        this.configuration.maxPayloadBytes,
        this.producer,
      );
    } catch (error) {
      openingKey.fill(0);
      throw error;
    }
    const stillRelevant =
      !this.disposed &&
      generation === this.configuredOpenGeneration &&
      this.configuration.repositoryPath === root &&
      this.configuration.repositoryId === expectedRepositoryId;
    if (!stillRelevant) {
      openingKey.fill(0);
      const winner = this.repository;
      return (
        winner !== null &&
        winner.root === this.configuration.repositoryPath &&
        (this.configuration.repositoryId === null ||
          winner.repository.repositoryId === this.configuration.repositoryId)
      );
    }
    this.masterKey?.fill(0);
    this.masterKey = openingKey;
    this.repository = opened;
    await this.refreshAdapters();
    return true;
  }

  /**
   * Opens the currently configured repository at most once across overlapping
   * leadership and command requests.
   *
   * The decoded key returned by configuration belongs to this attempt and is
   * always wiped; openConfiguredRepository keeps its own private copy only if
   * the same configuration is still current when the open completes.
   */
  private async ensureConfiguredRepositoryOpen(): Promise<boolean> {
    const root = this.configuration.repositoryPath;
    const expectedRepositoryId = this.configuration.repositoryId;
    if (root === null || this.disposed) {
      if (root === null) {
        this.status.setStatus("unconfigured");
      }
      return false;
    }
    const current = this.repository;
    if (
      current !== null &&
      current.root === root &&
      (expectedRepositoryId === null ||
        current.repository.repositoryId === expectedRepositoryId)
    ) {
      return true;
    }

    const pending = this.configuredOpenInFlight;
    if (pending !== null) {
      if (
        pending.root === root &&
        pending.repositoryId === expectedRepositoryId
      ) {
        return pending.promise;
      }
      // A configuration replacement can overlap an old unlock. Let the old
      // attempt observe its generation mismatch, then open the new target.
      await pending.promise.catch(() => {});
      return this.ensureConfiguredRepositoryOpen();
    }

    const promise = (async (): Promise<boolean> => {
      const masterKey = await this.configuration.getMasterKey();
      if (masterKey === null) {
        this.status.setStatus("locked");
        return false;
      }
      try {
        if (
          this.configuration.repositoryPath !== root ||
          this.configuration.repositoryId !== expectedRepositoryId
        ) {
          return false;
        }
        return await this.openConfiguredRepository(masterKey);
      } finally {
        masterKey.fill(0);
      }
    })();
    const attempt = { root, repositoryId: expectedRepositoryId, promise };
    this.configuredOpenInFlight = attempt;
    try {
      return await promise;
    } finally {
      if (this.configuredOpenInFlight === attempt) {
        this.configuredOpenInFlight = null;
      }
    }
  }

  /** Completes a lazy command read under the same lock used by mutators. */
  private async ensureRepositoryInitializedForRead(): Promise<void> {
    if (!(await this.ensureConfiguredRepositoryOpen())) {
      return;
    }
    const repository = this.repository;
    if (repository === null || repository.isInitialized) {
      return;
    }
    const lock = await this.takeCommandLock(repository);
    try {
      await this.openGitWindow(repository);
      await repository.refreshState();
    } finally {
      await lock.release();
    }
  }

  /**
   * Runs a state-mutating repository create/join under sync.lock.
   *
   * Configured activation uses `openDeferredWithMasterKey` and completes its
   * recovery inside the first cycle instead. Setup still creates or joins with
   * the full API, whose checkpoint absorption and own-stream recovery SAVE the
   * state file. A long offline export or repair can legitimately hold the lock
   * for more than a minute, so a bounded wait is repeated until it is actually
   * available rather than falling through to an unsafe unlocked write.
   */
  private async withOpenLock<T>(run: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    let lastWaitLogAt: number | null = null;
    return withRequiredFileLock(
      () =>
        acquireFileLockWithin(this.syncLockPath(), OPEN_LOCK_WAIT_SLICE_MS, () => {
          const now = Date.now();
          if (
            lastWaitLogAt !== null &&
            now - lastWaitLogAt < OPEN_LOCK_LOG_INTERVAL_MS
          ) {
            return;
          }
          this.status.log(
            lastWaitLogAt === null
              ? "Waiting for another Cursor window or the offline helper before opening the synchronization repository."
              : `Still waiting to open the synchronization repository safely (${Math.max(1, Math.floor((now - startedAt) / 60_000))} minute(s)).`,
          );
          lastWaitLogAt = now;
        }),
      run,
      () => !this.disposed,
    );
  }

  private synchronizedSourceRoots(): Array<{ label: string; path: string }> {
    return [
      { label: "Cursor user data", path: this.paths.userDataRoot },
      { label: "the .cursor user directory", path: this.paths.cursorHome },
      { label: "extension local storage", path: this.paths.extensionStorage },
    ];
  }

  /**
   * Arms this window's shutdown finalizer. Never throws: activation and the
   * quit-vetoed callbacks call this bare, and a window whose activation died
   * over a redundant finalizer does nothing at all - the 0.0.31 seven-window
   * restore produced exactly that. Failures and stalls schedule a retry.
   *
   * Serialized per window: the configuration-change handler is registered
   * before initialize() is awaited, so two invocations can overlap. The
   * follow-up flag ensures the LAST request's configuration wins.
   */
  private async startFinalizer(
    retryGuard: () => boolean = ALWAYS_RELEVANT_FINALIZER,
  ): Promise<void> {
    if (this.disposed || !retryGuard()) {
      return;
    }
    if (this.finalizerStartInFlight !== null) {
      this.finalizerRestartRequested = true;
      // Configuration updates can overlap activation. The newest request's
      // generation decides whether the serialized follow-up is still useful.
      this.finalizerRestartGuard = retryGuard;
      return this.finalizerStartInFlight;
    }
    const run = this.startFinalizerOnce(retryGuard).finally(() => {
      this.finalizerStartInFlight = null;
      const restart = this.finalizerRestartRequested;
      const nextGuard =
        this.finalizerRestartGuard ?? ALWAYS_RELEVANT_FINALIZER;
      this.finalizerRestartRequested = false;
      this.finalizerRestartGuard = null;
      if (restart && !this.disposed && nextGuard()) {
        void this.startFinalizer(nextGuard);
      }
    });
    this.finalizerStartInFlight = run;
    return run;
  }

  private async startFinalizerOnce(
    retryGuard: () => boolean,
  ): Promise<void> {
    if (this.finalizerRetryTimer !== null) {
      clearTimeout(this.finalizerRetryTimer);
      this.finalizerRetryTimer = null;
      this.finalizerRetryGuard = null;
    }
    try {
      if (!retryGuard()) {
        return;
      }
      if (await this.disconnectedElsewhere()) {
        return;
      }
      if (
        this.disposed ||
        !this.configuration.enabled ||
        this.repository === null ||
        this.masterKey === null ||
        !retryGuard() ||
        !this.compatibility.compatible ||
        !(await pathExists(this.paths.helperScript))
      ) {
        // Disable cancels finalizers; an in-flight arm resolving after it
        // must not quietly re-install an exporter the user just turned off.
        return;
      }
      // A copy, and the repository captured: a Setup re-run during the arm's
      // up-to-30s replacement wait zeroes this.masterKey IN PLACE, and the
      // launcher serializes the key only at spawn time - after the wait - so
      // the finalizer received 32 zero bytes and failed at its first decrypt.
      const repository = this.repository;
      const masterKey = Buffer.from(this.masterKey);
      let outcome: FinalizerReplaceOutcome;
      try {
        outcome = await this.helper.restartFinalizer(
          repository.root,
          masterKey,
          this.configuration.workspaceMappings,
          this.helperSyncOptions(),
        );
      } finally {
        masterKey.fill(0);
      }
      if (!retryGuard()) {
        // The finalizer just installed is machine-wide and remains useful, but
        // this former leader must not replace or retry it again.
        return;
      }
      if (outcome === "adopted") {
        // Another window installed a fresh finalizer after this window asked
        // for the replacement. It covers the shutdown export - and it belongs
        // to that window, so no re-check below may cancel it: this window
        // being disposed or disconnected says nothing about the sibling's.
        this.status.log(
          "Another window installed the shutdown finalizer; this window uses it.",
        );
        return;
      }
      if (this.disposed) {
        // Window teardown mid-arm. The exporter just armed IS the machine's
        // shutdown coverage; cancelling it here silently cost the session its
        // final export. Leave it running - the same policy
        // HelperLauncher.dispose() follows by not killing the child.
        return;
      }
      if (
        !this.configuration.enabled ||
        this.repository === null ||
        (await this.disconnectedElsewhere())
      ) {
        // Disable or Disconnect (this window's or a sibling's, via the
        // machine-wide marker) landed while the arm was inside its wait; the
        // wait's own cancel-marker removal overrode that stand-down, so an
        // exporter would now be armed for a sync the user just turned off.
        // The fresh marker postdates the new request, so the finalizer honors
        // it even without a live process handle.
        await this.helper.cancelFinalizers();
        return;
      }
      if (outcome === "stalled") {
        // Typically a finalizer mid-export from the previous quit, which
        // cannot read its cancel marker until it finishes. It exits on its
        // own; retry until this session's finalizer lands.
        if (this.scheduleFinalizerRetry(retryGuard)) {
          this.status.log(
            "The previous shutdown finalizer is still busy, likely finishing an export; retrying in a minute.",
          );
        }
      }
    } catch (error) {
      // A spawn that failed (helper bundle mid-update, a transient EPERM on
      // the lock file) leaves the session without a shutdown export unless it
      // is retried - and must never take the caller down with it.
      if (this.scheduleFinalizerRetry(retryGuard)) {
        this.status.log(
          `Arming the shutdown finalizer failed (retrying in a minute): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private scheduleFinalizerRetry(retryGuard: () => boolean): boolean {
    if (this.disposed || !retryGuard()) {
      return false;
    }
    if (this.finalizerRetryTimer !== null) {
      if (this.finalizerRetryGuard?.() !== false) {
        return true;
      }
      clearTimeout(this.finalizerRetryTimer);
      this.finalizerRetryTimer = null;
    }
    this.finalizerRetryGuard = retryGuard;
    this.finalizerRetryTimer = setTimeout(() => {
      this.finalizerRetryTimer = null;
      this.finalizerRetryGuard = null;
      if (
        this.disposed ||
        !this.configuration.enabled ||
        !retryGuard()
      ) {
        return;
      }
      void this.startFinalizer(retryGuard);
    }, FINALIZER_RETRY_DELAY_MS);
    this.finalizerRetryTimer.unref();
    return true;
  }

  private async startWatching(runInitialSync = false): Promise<void> {
    const root = this.configuration.repositoryPath;
    if (root === null || this.disposed || !this.configuration.enabled) {
      await this.backgroundCoordinator.stop();
      return;
    }
    await this.backgroundCoordinator.start(runInitialSync);
    if (!this.backgroundCoordinator.active) {
      if (this.repository?.isInitialized === true) {
        this.updateStatus(this.repository);
      } else {
        this.status.setStatus(
          "up-to-date",
          'Another Cursor window owns background synchronization. Open "Cursor Setting Sync: Manage" and choose "Sync & Apply Now" to load state in this window.',
        );
      }
    }
  }

  private startBackgroundRuntime(isCurrent: () => boolean): void {
    if (!isCurrent()) {
      return;
    }
    const root = this.configuration.repositoryPath;
    if (root === null || this.disposed || !this.configuration.enabled) {
      throw new Error("background synchronization is no longer enabled");
    }
    // Git remotes emit no filesystem events; incoming remote commits are
    // detected by the poll timers below, not by this watcher.
    this.repositoryWatcher = createRepositoryWatcher(
      root,
      process.platform,
      (fileName) => {
        if (!isRepositoryPayloadFile(fileName)) {
          return;
        }
        // A publish writes an event and one blob per changed resource into the
        // watched tree, and the watcher reports them back. Reacting would run a
        // second full cycle - state reload, full reconcile, state writes, an
        // acks upload - for a change this device already applied.
        const payloadFileName = repositoryPayloadFileName(fileName);
        if (this.repository?.wroteRecently(payloadFileName) === true) {
          return;
        }
        // A cloud client can hydrate or replace an immutable payload in place
        // without changing its parent directory or device head metadata. The
        // watcher is the authoritative signal for that case: make the next
        // refresh re-authenticate event/checkpoint bytes instead of trusting
        // the idle generation fingerprint forever.
        const normalizedPayloadName = payloadFileName.toLowerCase();
        if (
          normalizedPayloadName.endsWith(EVENT_EXTENSION) ||
          normalizedPayloadName.endsWith(CHECKPOINT_EXTENSION)
        ) {
          this.repository?.invalidateSharedGraphObservation();
        }
        if (this.watcherDebounce !== null) {
          clearTimeout(this.watcherDebounce);
        }
        this.watcherDebounce = setTimeout(() => {
          this.watcherDebounce = null;
          if (
            !isCurrent() ||
            !this.backgroundCoordinator.validateOwnership()
          ) {
            return;
          }
          this.scheduleAutomaticSync("remote");
        }, 1000);
        this.watcherDebounce.unref();
      },
      (message) => {
        if (isCurrent()) {
          this.status.log(`Repository watcher error: ${message}`);
        }
      },
    );
    const filesInterval = this.configuration.pollIntervalSeconds * 1000;
    const chatInterval = this.configuration.chatPollIntervalSeconds * 1000;
    const plan = createPollPlan(
      filesInterval,
      chatInterval,
      this.configuration.syncChat,
    );
    const slots: Array<"pollTimer" | "chatPollTimer"> = [
      "pollTimer",
      "chatPollTimer",
    ];
    for (const [index, entry] of plan.entries()) {
      const slot = slots[index];
      if (slot !== undefined) {
        this.startPollingLoop(slot, entry, isCurrent);
      }
    }
  }

  private startPollingLoop(
    slot: "pollTimer" | "chatPollTimer",
    entry: PollPlanEntry,
    isCurrent: () => boolean,
  ): void {
    const scheduleNext = (): void => {
      if (!isCurrent() || this.disposed || !this.configuration.enabled) {
        return;
      }
      const timer = setTimeout(() => {
        if (this[slot] === timer) {
          this[slot] = null;
        }
        if (
          !isCurrent() ||
          !this.backgroundCoordinator.validateOwnership()
        ) {
          return;
        }
        // Start the next interval only after this request settles. Slow cycles
        // therefore create a cooldown instead of a permanent timer backlog.
        void this.cycles
          .requestPolling(entry.scope)
          .catch((error: unknown) => {
            this.status.log(
              `Queued polling synchronization failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          })
          .finally(scheduleNext);
      }, entry.intervalMs);
      timer.unref();
      this[slot] = timer;
    };
    scheduleNext();
  }

  private scheduleAutomaticSync(scope: SyncScope): void {
    const request = this.cycles.requestAutomatic(scope);
    if (request === this.automaticSyncRequest) {
      return;
    }
    this.automaticSyncRequest = request;
    void request
      .catch((error: unknown) => {
        this.status.log(
          `Queued automatic synchronization failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        if (this.automaticSyncRequest === request) {
          this.automaticSyncRequest = null;
        }
      });
  }

  private disposeBackgroundRuntime(): void {
    this.repositoryWatcher?.close();
    this.repositoryWatcher = null;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.chatPollTimer !== null) {
      clearTimeout(this.chatPollTimer);
      this.chatPollTimer = null;
    }
    if (this.watcherDebounce !== null) {
      clearTimeout(this.watcherDebounce);
      this.watcherDebounce = null;
    }
    if (
      this.finalizerRetryTimer !== null &&
      this.finalizerRetryGuard?.() === false
    ) {
      clearTimeout(this.finalizerRetryTimer);
      this.finalizerRetryTimer = null;
      this.finalizerRetryGuard = null;
    }
    this.automaticSyncRequest = null;
    // The reconnect probe deliberately survives this: background teardown also
    // runs on configuration changes seen by every window. The probe dies only
    // with dispose() and disconnect(), the explicit ends of participation.
    this.clearSyncIndicator();
  }

  private helperSyncOptions(): HelperSyncOptions {
    return {
      ignoredSettings: this.configuration.ignoredSettings,
      ignoredExtensions: this.configuration.ignoredExtensions,
      ignoredUserFiles: this.configuration.ignoredUserFiles,
      ignoredUiStateKeys: this.configuration.ignoredUiStateKeys,
      // The resolved list, not the raw setting: the shutdown export is the only
      // path that scans workspaceStorage, so it has to see the built-in
      // local-workspace exclusion too or the two halves disagree.
      ignoredWorkspaces: this.configuration.effectiveIgnoredWorkspaces,
      // Already includes the built-in defaults, so the helper applies exactly
      // the same exclusions the extension host does.
      machineScopedSettings: this.machineSpecificSettingPatterns(),
      syncChat: this.configuration.syncChat,
      syncWorkspaceStorage: this.configuration.syncWorkspaceStorage,
      applyOnShutdown: this.configuration.applyOnShutdown,
      maxPayloadBytes: this.configuration.maxPayloadBytes,
      gitSync: this.configuration.gitSync,
    };
  }

  private updateStatus(repository: SyncRepository): void {
    if (this.disposed || this.repository !== repository) {
      // A cycle can still be draining when the extension host tears down, or
      // after Disconnect swapped the repository out from under it. Reporting
      // that stale repository's state would flip the status item back off
      // "unconfigured" and offer commands the device can no longer run.
      return;
    }
    const activeConflicts = unresolvedConflicts(repository);
    if (activeConflicts.length > 0) {
      this.status.setStatus(
        "conflict",
        `${activeConflicts.length} synchronization conflict(s) require attention.`,
      );
    } else if (this.helperFailure !== null) {
      // Ranked above the queue and below conflicts: a conflict blocks the apply
      // this failure is about, so resolving it comes first - but the queue on
      // its own must never repaint over the news that writing it just failed.
      this.status.setStatus("error", this.helperFailure);
    } else if (
      // Counted on what is actually outstanding. A queue made entirely of
      // changes this computer has decided not to write is not "Queued": it
      // needs no restart and no decision, and painting the badge for it told
      // a correctly configured machine it had 234 things left to do.
      repository.state.pendingDatabaseChanges.some(
        (change) => !isPermanentExclusionReason(change.blockedReason),
      )
    ) {
      this.status.setStatus(
        "pending-restart",
        pendingRestartDetail(
          repository.state.pendingDatabaseChanges,
          this.configuration.applyOnShutdown,
        ),
      );
    } else if (!this.configuration.enabled) {
      this.status.setStatus("disabled");
    } else {
      // Nothing here is a hard failure, but "everything is fine" still has to
      // account for every standing warning; see {@link settledStatus}.
      const settled = settledStatus({
        streamWarnings: this.warnings.standingFor(RECONCILER_WARNING_SOURCE)
          .length,
        publishWarnings: this.warnings.standingMatching(isPublishWarningSource)
          .length,
        helperWarnings: this.warnings.standingFor(HELPER_WARNING_SOURCE).length,
        disabledKinds: this.disabledResourceKindSummary(),
      });
      this.status.setStatus(settled.status, settled.detail);
    }
  }

  /**
   * What is not synchronizing on this device at all, as one sentence. Empty
   * when everything the configuration asks for is covered.
   */
  private disabledResourceKindSummary(): string {
    if (this.compatibility.compatible) {
      return "";
    }
    return (
      "Profiles, UI state, extensions and chat are not synchronizing because " +
      `this Cursor build does not support the required database access: ${
        this.compatibility.reasons[0] ?? "unknown reason"
      }`
    );
  }

  /**
   * Reads whatever the offline helper left behind.
   *
   * `atStartup` is false on the sync-cycle path, and it gates the two halves
   * that are only correct once. The warning half must not run per cycle because
   * `startFinalizer` supersedes the waiting finalizer, which then writes a
   * success result with `warnings: []` - and an empty structured warnings array
   * is how `helperWarningObservation` says "the helper ran and found nothing",
   * which deletes the bucket. That bucket is the only signal that a shutdown
   * export dropped workspaceStorage, the one path that ever backs it up.
   */
  private async consumeHelperResults(
    options: { atStartup: boolean } = { atStartup: true },
  ): Promise<void> {
    const consumed: HelperResult[] = [];
    let names: string[];
    try {
      names = (
        await readdir(this.paths.extensionStorage, { withFileTypes: true })
      )
        .filter((entry) => entry.isFile() && isHelperResultFileName(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissingPathError(error)) {
        // `listFilesRecursively` tolerated a missing root; a bare readdir does
        // not, and this now runs inside a sync cycle whose failure is recorded
        // against the repository.
        return;
      }
      throw error;
    }
    // A window that claimed a result and died before deleting it left a
    // .claimed file no listing ever matched again - the result's warnings and
    // backups were lost to every surviving window. An hour is far beyond any
    // consume, so CLAIM age alone is proof of orphanhood - and the claim age
    // is embedded in the name at rename time, because mtime is the RESULT's
    // age (rename preserves it) and a post-rename utimes left a gap in which
    // a sibling's sweep destroyed a freshly claimed overnight result.
    try {
      for (const entry of await readdir(this.paths.extensionStorage)) {
        if (!/\.claimed$/.test(entry) || !entry.includes("helper-result-")) {
          continue;
        }
        const orphanPath = join(this.paths.extensionStorage, entry);
        const embedded = /\.(\d{10,16})\.claimed$/.exec(entry);
        const claimedAtMs =
          embedded === null ? null : Number.parseInt(embedded[1] ?? "", 10);
        let ageBasisMs = claimedAtMs;
        if (ageBasisMs === null || !Number.isFinite(ageBasisMs)) {
          // Old-format leftover from a prior version: mtime is all there is.
          const info = await stat(orphanPath).catch(() => null);
          ageBasisMs = info?.mtimeMs ?? null;
        }
        if (ageBasisMs !== null && Date.now() - ageBasisMs > 60 * 60_000) {
          this.status.log(
            `Discarded a helper result another window claimed but never processed (${entry}).`,
          );
          await rm(orphanPath, { force: true });
        }
      }
    } catch {
      // Listing is best-effort; the next consume retries.
    }
    for (const name of names) {
      const path = join(this.paths.extensionStorage, name);
      // Claim before reading: startup runs this in EVERY restoring window at
      // once, and two windows that both read a result before either deleted
      // it reported it twice and raced the backup-record update. The rename
      // is atomic, so exactly one window owns each result - and the claim
      // instant rides in the name, atomically with the claim itself.
      const claimedPath = `${path}.${process.pid}.${Date.now()}.claimed`;
      try {
        await rename(path, claimedPath);
      } catch (error) {
        if (isMissingPathError(error)) {
          // Another window claimed it between the listing and the rename.
          continue;
        }
        throw error;
      }
      let result: HelperResult;
      try {
        result = await readJsonFile<HelperResult>(claimedPath);
      } catch (error) {
        // A truncated result never becomes readable, so leaving it would
        // rethrow on every cycle from here on.
        this.status.log(
          `Discarded an unreadable helper result (${name}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await rm(claimedPath, { force: true });
        continue;
      }
      consumed.push(result);
      if (result.mode !== "final-export") {
        // The apply this marker described has reported; a sibling window may
        // offer again if anything is still queued. But a STALE result - one
        // orphaned by a partial quit and consumed much later - must not erase
        // a marker a DIFFERENT window wrote for an apply still in flight, so
        // the clear is skipped while the marker names another live process.
        await this.clearApplyInProgressUnlessForeign();
      }
      await this.recordHelperBackups(result);
      if (result.success) {
        this.status.log(
          `Helper ${result.requestId} applied ${result.applied.length} resource(s)` +
            `${helperRunDuration(result)}.`,
        );
        if (result.skipped.length > 0) {
          const details = result.skipped.slice(0, 20).join(" | ");
          const remainder = Math.max(0, result.skipped.length - 20);
          this.status.log(
            `Helper ${result.requestId} reported ${result.skipped.length} warning(s) or skipped resource(s): ${details}${
              remainder === 0 ? "" : ` | ... and ${remainder} more`
            }`,
          );
        }
        // A later success is the only evidence that whatever failed before has
        // been dealt with; without this the bar stays red until a reload. A
        // final-export success is NOT that evidence - the routine shutdown
        // exporter succeeding says nothing about the apply that failed, and
        // letting it clear the bar hid real apply failures behind a green
        // status every time the session quit cleanly.
        if (result.mode !== "final-export") {
          this.helperFailure = null;
        }
      } else if (isInterruptedResult(result)) {
        // Cursor was open again before the bounded drain completed. Earlier
        // pages can already be committed and dequeued; the in-flight page can
        // also have idempotent physical writes without its queue checkpoint.
        // The structured result preserves only fully checkpointed progress.
        //
        // The offer is re-enabled for the session, though. Without it a user
        // who always reopens quickly would get neither a successful shutdown
        // apply nor a prompt, and the queue would never drain.
        this.status.log(interruptedHelperResultLog(result));
        this.shutdownApplyInterrupted = true;
      } else {
        this.status.log(`Helper ${result.requestId} failed: ${result.error ?? "unknown"}`);
        this.helperFailure = helperFailureDetail(result.error);
        this.status.setStatus("error", this.helperFailure);
        this.announceHelperFailure(this.helperFailure);
        // Any consumed failure re-arms the finalizer: the flow that failed
        // cancelled the standing one first, and its own recovery lives in
        // whichever window launched it - a window that may be gone. Whoever
        // consumes the failure is alive; restartFinalizer's outcomes make
        // this safe when several windows race to do the same.
        void this.startFinalizer();
      }
      await rm(claimedPath, { force: true });
      const stderrLogPath = helperStderrLogPathForResult(
        this.paths.extensionStorage,
        name,
        result.requestId,
      );
      if (stderrLogPath !== null) {
        // A successful helper removes its request in `finally`, but the
        // launcher's stderr capture is a sibling file owned by the extension
        // host. Without this, every clean finalizer left another zero-byte log
        // in global storage forever. Only remove it after the structured result
        // was processed and claimed away, so a crash result still has its log
        // available to the abandoned-helper diagnostics until then.
        await rm(stderrLogPath, { force: true }).catch((error: unknown) => {
          this.status.log(
            `Could not remove helper stderr log ${basename(stderrLogPath)}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    }
    if (!options.atStartup) {
      // The result file is already deleted, so skipping observation here
      // DESTROYED any warnings it carried - a quit-vetoed final-export's
      // "these resources were not exported" landed in no window at all. Only
      // results actually carrying warnings observe mid-session, merged with
      // what already stands so a bare mid-cycle observe cannot clear a
      // bucket a startup consume raised.
      const carrying = consumed.filter(
        (result) => (result.warnings?.length ?? 0) > 0,
      );
      if (carrying.length > 0) {
        const standing = this.warnings
          .standingFor(HELPER_WARNING_SOURCE)
          .map((entry) => entry.warning);
        for (const entry of this.warnings.observe({
          sources: helperWarningObservation(carrying, standing),
          now: Date.now(),
        })) {
          this.status.log(formatWarningLine(entry));
        }
      }
      return;
    }
    await this.reportAbandonedHelpers();
    // The result file is deleted above, so this is the only chance to record
    // what the helper reported. A warning raised here stands until a later
    // helper run reports it gone: nothing else re-derives it, because nothing
    // else can look at what a process that is no longer running found.
    for (const entry of this.warnings.observe({
      sources: helperWarningObservation(consumed),
      now: Date.now(),
    })) {
      this.status.log(formatWarningLine(entry));
    }
    const helperWarnings = this.warnings.standingFor(
      HELPER_WARNING_SOURCE,
    ).length;
    if (helperWarnings > 0 && this.helperFailure === null) {
      // `initialize` consumes results before the repository is open, so the
      // "partial" that `updateStatus` would set has to wait for the first
      // successful cycle — and never arrives at all on a device that is locked
      // or unconfigured. A failed result has already set "error", which is the
      // more severe of the two and must not be downgraded here.
      const settled = settledStatus({
        streamWarnings: 0,
        publishWarnings: 0,
        helperWarnings,
        disabledKinds: "",
      });
      this.status.setStatus(settled.status, settled.detail);
    }
  }

  /**
   * Reports helpers that were launched and never reported back.
   *
   * The helper deletes its own request file in a `finally` that survives almost
   * everything, so a surviving request means the process never reached `run` at
   * all - and until now the only trace was a queue that did not shrink. The
   * commonest cause is an upgrade: the request records the helper script inside
   * the version that wrote it, and installing a new version deletes that
   * directory, so a finalizer armed moments earlier points at a file that no
   * longer exists. That one is harmless and is cleared silently; anything else
   * is named, together with whatever the process managed to write to stderr.
   */
  private async reportAbandonedHelpers(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.paths.extensionStorage)).filter((name) =>
        name.startsWith("helper-request-"),
      );
    } catch {
      return;
    }
    // A shutdown finalizer deliberately waits days for Cursor to exit, holding
    // its lock with a once-a-minute heartbeat the whole time. Its request file
    // is the helper's input, not litter; deleting it starved the export.
    let finalizerAlive = false;
    try {
      const lockStat = await stat(
        join(this.paths.extensionStorage, "shutdown-finalizer.lock"),
      );
      finalizerAlive = Date.now() - lockStat.mtimeMs < ABANDONED_HELPER_MIN_AGE_MS;
    } catch {
      // No lock: no live finalizer to protect.
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const requestPath = join(this.paths.extensionStorage, name);
      const logPath = `${requestPath}.stderr.log`;
      let scriptMissing = false;
      let request: HelperRequest | null = null;
      try {
        request = await readJsonFile<HelperRequest>(requestPath);
        scriptMissing = !(await pathExists(request.paths.helperScript));
      } catch {
        // An unreadable request is itself worth reporting.
      }
      if (request !== null) {
        if (request.mode === "final-export" && finalizerAlive) {
          continue;
        }
        const ageMs = Date.now() - Date.parse(request.createdAt);
        if (Number.isFinite(ageMs) && ageMs < ABANDONED_HELPER_MIN_AGE_MS) {
          // Younger than the exit-wait plus lock-wait budget: a helper may
          // still be legitimately waiting on it. "Never reported a result"
          // must not describe a helper that has not had time to.
          continue;
        }
      }
      let stderr = "";
      try {
        stderr = (await readFile(logPath, "utf8")).trim();
      } catch {
        // No log: this predates the change that captures one.
      }
      if (!scriptMissing) {
        const detail = `The offline helper for ${name} never reported a result.${
          stderr.length === 0 ? "" : ` It wrote: ${stderr.slice(0, 2000)}`
        }`;
        this.status.log(detail);
        // A helper that died without a result is exactly how a hard-crashed
        // shutdown export looks: nothing red anywhere, one Output line the
        // user never opens. For a final-export or restore that silence is a
        // missed backup or a restore that did not happen - say so out loud.
        if (request?.mode === "final-export") {
          void vscode.window.showWarningMessage(
            "The previous session's shutdown export never completed, so its final workspaceStorage backup was skipped. The next quit exports everything current.",
          );
        } else if (request?.mode === "restore-backup") {
          void vscode.window.showWarningMessage(
            'The requested restore never reported a result and may not have run. Check the data, then open "Cursor Setting Sync: Manage", choose "Restore Data…", then "Restore a Local Database Backup (Emergency)" again if needed.',
          );
        }
      } else {
        // The upgrade case is routine, but a silent delete of a RESTORE the
        // user explicitly confirmed is not: name it even then.
        if (request?.mode === "restore-backup") {
          this.status.log(
            `Cleared a queued restore (${name}) whose helper was removed by an extension update; open "Cursor Setting Sync: Manage", choose "Restore Data…", then "Restore a Local Database Backup (Emergency)" again.`,
          );
        }
      }
      await rm(requestPath, { force: true });
      await rm(logPath, { force: true });
    }
    try {
      const removedLogs = await removeAbandonedHelperStderrLogs(
        this.paths.extensionStorage,
      );
      if (removedLogs > 0) {
        this.status.log(
          `Removed ${removedLogs} abandoned offline-helper stderr log(s).`,
        );
      }
    } catch (error) {
      // Historical log cleanup is housekeeping. A transient EPERM from an
      // antivirus or another window must not fail extension activation.
      this.status.log(
        `Could not clean abandoned offline-helper stderr logs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async recordHelperBackups(result: HelperResult): Promise<void> {
    const backups = result.backups ?? [];
    if (backups.length === 0) {
      return;
    }
    const recordedAt = new Date().toISOString();
    const entries: StoredHelperBackup[] = backups.map((backup) => ({
      backupPath: backup.backupPath,
      contract: backup.contract,
      targetPath: backup.targetPath,
      recordedAt,
    }));
    const existing = this.context.globalState.get<StoredHelperBackup[]>(
      LAST_HELPER_BACKUPS_KEY,
      [],
    );
    await this.context.globalState.update(
      LAST_HELPER_BACKUPS_KEY,
      [...entries, ...existing].slice(0, 50),
    );
  }

  /**
   * Evaluates git mode once for the current lock window and pulls the latest
   * remote state before the caller reads the repository. A merge conflict is
   * rethrown as a hard failure; every other git failure degrades the window
   * to plain shared-folder mode so the local repository keeps working.
   */
  private async openGitWindow(
    repository: SyncRepository,
    forcePull = true,
  ): Promise<boolean> {
    if (!this.configuration.gitSync) {
      return false;
    }
    let now = Date.now();
    const cachedMode = this.backgroundGitModeCheck;
    if (
      !forcePull &&
      cachedMode !== null &&
      cachedMode.root === repository.root &&
      now >= cachedMode.checkedAt &&
      now - cachedMode.checkedAt < BACKGROUND_GIT_PULL_INTERVAL_MS
    ) {
      const conflict = this.backgroundGitConflicts.get(repository.root);
      if (conflict !== undefined) {
        throw conflict;
      }
      if (!cachedMode.active) {
        return false;
      }
      if (
        !backgroundGitPullDue(
          this.backgroundGitPullAttempt,
          repository.root,
          now,
        )
      ) {
        return true;
      }
    }
    const gitMode = await this.gitModeFor(repository.root);
    now = Date.now();
    this.backgroundGitModeCheck = {
      root: repository.root,
      checkedAt: now,
      active: gitMode,
    };
    if (!gitMode) {
      const conflict = this.backgroundGitConflicts.get(repository.root);
      if (conflict !== undefined) {
        throw conflict;
      }
      return false;
    }
    if (
      !forcePull &&
      !backgroundGitPullDue(
        this.backgroundGitPullAttempt,
        repository.root,
        now,
      )
    ) {
      const conflict = this.backgroundGitConflicts.get(repository.root);
      if (conflict !== undefined) {
        throw conflict;
      }
      // Git is still the active transport for this lock window. In particular,
      // commitGitWindow must remain enabled so a local change discovered by an
      // otherwise throttled poll is pushed immediately.
      return true;
    }
    // Stamp attempts, not only successes. An offline remote must not turn the
    // thirty-second poll into a network-error subprocess loop; manual commands
    // bypass the interval and can retry immediately.
    const attempt: BackgroundGitPullAttempt = {
      root: repository.root,
      attemptedAt: now,
    };
    this.backgroundGitPullAttempt = attempt;
    try {
      await pullLatest(repository.root);
      this.backgroundGitConflicts.delete(repository.root);
      this.lastGitWindowDegraded = false;
      return true;
    } catch (error) {
      if (error instanceof GitError && error.kind === "conflict") {
        this.backgroundGitConflicts.set(repository.root, error);
        throw error;
      }
      const knownConflict = this.backgroundGitConflicts.get(repository.root);
      if (knownConflict !== undefined) {
        this.degradeGit(error);
        throw knownConflict;
      }
      this.degradeGit(error);
      return false;
    } finally {
      // Slow commands and timeouts are throttled from completion, not start;
      // otherwise a five-minute failure immediately launches another probe.
      attempt.attemptedAt = Date.now();
      this.backgroundGitModeCheck = {
        root: repository.root,
        checkedAt: attempt.attemptedAt,
        active: true,
      };
    }
  }

  private async gitModeFor(root: string): Promise<boolean> {
    if (!this.configuration.gitSync) {
      return false;
    }
    try {
      return await isGitRepository(root);
    } catch (error) {
      this.degradeGit(error);
      return false;
    }
  }

  private async commitGitWindow(
    active: boolean,
    root: string,
    message: string,
  ): Promise<boolean> {
    if (!active) {
      return false;
    }
    try {
      await commitAndPush(root, message);
      // Health is the LAST window's outcome, not history: one offline minute
      // weeks ago must not keep diagnostics reporting "degraded" about a
      // transport that has pushed cleanly ever since.
      this.lastGitWindowDegraded = false;
      return true;
    } catch (error) {
      if (error instanceof GitError && error.kind === "conflict") {
        this.backgroundGitConflicts.set(root, error);
        throw error;
      }
      // The local write is already on disk; the next successful commit window
      // stages it again, so degrading never loses data.
      this.degradeGit(error);
      return false;
    }
  }

  private degradeGit(error: unknown): void {
    const kind: GitErrorKind =
      error instanceof GitError ? error.kind : "command";
    const message = error instanceof Error ? error.message : String(error);
    this.status.log(`Git transport degraded (${kind}): ${message}`);
    this.lastGitWindowDegraded = true;
    if (this.gitWarningsShown.has(kind)) {
      // The toast dedupe set is deliberately never cleared; health reporting
      // lives in lastGitWindowDegraded, which recovers with the next window.
      return;
    }
    this.gitWarningsShown.add(kind);
    void vscode.window.showWarningMessage(
      `Cursor Setting Sync: git transport is unavailable and synchronization continues through the shared folder alone. ${message}`,
    );
  }

  private async warnAboutLargeFiles(
    root: string,
    throttled: boolean,
  ): Promise<void> {
    if (throttled) {
      const now = Date.now();
      if (now - this.largeFileCheckAt < 60 * 60 * 1000) {
        return;
      }
      this.largeFileCheckAt = now;
    }
    try {
      const largest = (await largeFileWarnings(root))[0];
      if (largest !== undefined) {
        void vscode.window.showWarningMessage(
          `Cursor Setting Sync: ${largest.path} is ${formatBytes(largest.sizeBytes)}. GitHub rejects files over 100 MB — lower cursorSettingSync.maxPayloadMiB or disable chat sync for this repository.`,
        );
      }
    } catch (error) {
      // The size guard is advisory and must never block a sync cycle.
      this.status.log(
        `Large-file scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private requireRepository(): SyncRepository {
    if (this.repository === null) {
      throw new Error("Cursor Setting Sync is not configured or unlocked.");
    }
    return this.syncRepositoryLimit(this.repository);
  }

  /**
   * Pushes the current `cursorSettingSync.maxPayloadMiB` into the open
   * repository.
   *
   * `configurationChanged` refreshes the adapters but never reopens an
   * already matching repository. Without this the repository kept enforcing
   * whatever the setting was when Cursor started, while every guard read the
   * setting live — so raising the limit (the remedy the oversized-payload
   * warning names) made the guard admit a payload `publish` then rejected, on
   * every poll, until Cursor was restarted.
   */
  private syncRepositoryLimit(repository: SyncRepository): SyncRepository {
    repository.setMaxPayloadBytes(this.configuration.maxPayloadBytes);
    return repository;
  }

  private requireMasterKey(): Buffer {
    if (this.masterKey === null) {
      throw new Error("Cursor Setting Sync repository is locked.");
    }
    return this.masterKey;
  }
}

/** One-line summary of a checkpoint run, for the output channel. */
function describeCheckpointOutcome(outcome: CheckpointCommandOutcome): string {
  const parts: string[] = [];
  if (outcome.created !== null) {
    parts.push(
      `created checkpoint ${outcome.created.checkpointHash.slice(0, 12)} folding ${outcome.created.resourceCount} resource(s)`,
    );
  }
  if (outcome.prune === null) {
    parts.push("nothing to prune");
  } else if (outcome.prune.status === "pruned") {
    parts.push(
      `pruned ${outcome.prune.eventsDeleted} event file(s) and reclaimed ${formatBytes(outcome.prune.reclaimedBytes)}`,
    );
  } else {
    parts.push(`pruning skipped (${outcome.prune.reason ?? "unknown reason"})`);
  }
  return `${parts.join("; ")}.`;
}

function unresolvedConflicts(repository: SyncRepository): SyncConflict[] {
  return repository.state.conflicts.filter(
    (conflict) => conflict.resolvedAt === undefined,
  );
}

export type { SyncScope };

export interface LocalScanResult {
  snapshots: ResourceSnapshot[];
  deletions: ResourceDeletion[];
  /** Adapters whose absence cannot be interpreted as a clean local delete. */
  deferredAdapterIds: Set<string>;
  /** Last adapter attempted, used to rotate bounded retention fairly. */
  cursorAfterAdapterId: string | null;
  retainedSnapshotBytes: number;
  /** Reuses the bounded scan for inbound drift checks without a second read. */
  adapterIndexes: Map<string, AdapterScanIndex>;
  /**
   * Keyed by adapter id. Present and empty means the adapter ran and produced
   * nothing; absent means it did not run this cycle. The warning registry
   * relies on that distinction to leave an unrun adapter's bucket alone.
   */
  warningsBySource: Map<string, string[]>;
  /**
   * Deliberate exclusions, keyed the same way. Logged so the user can find out
   * why something stopped travelling, but never promoted to a standing warning:
   * the scan re-derives them every cycle and none of them is a failure.
   */
  noticesBySource: Map<string, string[]>;
}

export const MAX_SYNC_SCAN_RETAINED_BYTES = 32 * 1024 * 1024;

export interface ScanAdapterBudget {
  maxRetainedBytes?: number;
  startAfterAdapterId?: string | null;
}

export async function scanAdapters(
  adapters: readonly ResourceAdapter[],
  known: Record<string, LocalProjection>,
  scope: SyncScope,
  requiredKinds: ReadonlySet<ResourceKind>,
  maxPayloadBytes?: number,
  budget: ScanAdapterBudget = {},
): Promise<LocalScanResult> {
  const snapshots: ResourceSnapshot[] = [];
  const deletions: ResourceDeletion[] = [];
  const deferredAdapterIds = new Set<string>();
  const adapterIndexes = new Map<string, AdapterScanIndex>();
  const warningsBySource = new Map<string, string[]>();
  const noticesBySource = new Map<string, string[]>();
  const requestedRetainedBytes =
    budget.maxRetainedBytes ?? MAX_SYNC_SCAN_RETAINED_BYTES;
  const maxRetainedBytes =
    Number.isSafeInteger(requestedRetainedBytes) && requestedRetainedBytes >= 0
      ? Math.min(requestedRetainedBytes, MAX_SYNC_SCAN_RETAINED_BYTES)
      : MAX_SYNC_SCAN_RETAINED_BYTES;
  let retainedSnapshotBytes = 0;
  let cursorAfterAdapterId: string | null = null;
  const eligible = adapters.filter((candidate) =>
    shouldScanAdapter(candidate, scope, requiredKinds),
  );
  const previousIndex = eligible.findIndex(
    (adapter) => adapter.id === budget.startAfterAdapterId,
  );
  const ordered =
    previousIndex < 0
      ? eligible
      : [
          ...eligible.slice(previousIndex + 1),
          ...eligible.slice(0, previousIndex + 1),
        ];
  for (let index = 0; index < ordered.length; index += 1) {
    const adapter = ordered[index];
    if (adapter === undefined) {
      continue;
    }
    if (retainedSnapshotBytes >= maxRetainedBytes) {
      for (const deferred of ordered.slice(index)) {
        deferredAdapterIds.add(deferred.id);
      }
      break;
    }
    cursorAfterAdapterId = adapter.id;
    // A failing adapter must not abort the whole cycle; deletions come only
    // from completed scans, so skipping the adapter is safe.
    try {
      if (maxPayloadBytes !== undefined) {
        adapter.setMaxPayloadBytes?.(maxPayloadBytes);
      }
      const result = await adapter.scan(known);
      const status = adapter.scanStatus?.();
      let managerDeferred = false;
      const retainedForAdapter: ResourceSnapshot[] = [];
      const managerDeferredResourceIds = new Set<string>();
      for (const snapshot of result.snapshots) {
        if (
          snapshot.content.byteLength >
          maxRetainedBytes - retainedSnapshotBytes
        ) {
          managerDeferred = true;
          managerDeferredResourceIds.add(snapshot.resourceId);
          continue;
        }
        snapshots.push(snapshot);
        retainedForAdapter.push(snapshot);
        retainedSnapshotBytes += snapshot.content.byteLength;
      }
      const complete = status?.complete ?? true;
      const safeDeletions =
        complete && !managerDeferred ? result.deletions : [];
      if (!complete || managerDeferred) {
        deferredAdapterIds.add(adapter.id);
      } else {
        deletions.push(...safeDeletions);
      }
      adapterIndexes.set(adapter.id, {
        snapshots: new Map(
          retainedForAdapter.map((snapshot) => [snapshot.resourceId, snapshot]),
        ),
        deletions: new Map(
          safeDeletions.map((deletion) => [deletion.resourceId, deletion]),
        ),
        complete: complete && !managerDeferred,
        deferredResourceIds: new Set([
          ...(status?.deferredResourceIds ?? []),
          ...managerDeferredResourceIds,
        ]),
      });
      warningsBySource.set(adapter.id, [...result.warnings]);
      noticesBySource.set(adapter.id, [...(result.notices ?? [])]);
      if (managerDeferred) {
        for (const deferred of ordered.slice(index + 1)) {
          deferredAdapterIds.add(deferred.id);
        }
        break;
      }
    } catch (error) {
      deferredAdapterIds.add(adapter.id);
      adapterIndexes.set(adapter.id, incompleteScanIndex());
      warningsBySource.set(adapter.id, [
        `Adapter ${adapter.id} scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]);
    }
  }
  return {
    snapshots,
    deletions,
    deferredAdapterIds,
    cursorAfterAdapterId,
    retainedSnapshotBytes,
    adapterIndexes,
    warningsBySource,
    noticesBySource,
  };
}

/**
 * Lets a stateful adapter forget the bytes of an exact snapshot that the
 * repository policy deliberately rejected, while replaying a lightweight
 * standing warning on later scans. Only adapters that actually ran may update
 * their publish-warning bucket; partitioned polls must leave the other buckets
 * untouched.
 */
export function settleOversizedSnapshots(
  adapters: readonly ResourceAdapter[],
  ranAdapterIds: Iterable<string>,
  snapshots: readonly ResourceSnapshot[],
  maxPayloadBytes: number,
): Map<string, string[]> {
  const ran = new Set(ranAdapterIds);
  for (const snapshot of snapshots) {
    if (snapshot.content.byteLength <= maxPayloadBytes) {
      continue;
    }
    const owner = adapters.find((adapter) =>
      adapter.kinds.includes(snapshot.kind),
    );
    if (owner !== undefined && ran.has(owner.id)) {
      owner.settleOversizedSnapshot?.(snapshot, maxPayloadBytes);
    }
  }

  const warningsBySource = new Map<string, string[]>();
  for (const adapter of adapters) {
    if (!ran.has(adapter.id)) {
      continue;
    }
    const warnings = (
      adapter.oversizedSnapshotSettlements?.(maxPayloadBytes) ?? []
    )
      .filter(
        (settlement) =>
          settlement.maxPayloadBytes <= maxPayloadBytes &&
          settlement.byteLength > settlement.maxPayloadBytes,
      )
      .map((settlement) =>
        settlement.warning ??
        oversizedPayloadWarning(
          settlement.resourceId,
          settlement.byteLength,
          settlement.maxPayloadBytes,
        ),
      );
    if (warnings.length > 0) {
      warningsBySource.set(publishWarningSource(adapter.id), [
        ...new Set(warnings),
      ]);
    }
  }
  return warningsBySource;
}

function mergeWarningBuckets(
  target: {
    warnings: string[];
    warningsBySource: Map<string, string[]>;
  },
  additions: ReadonlyMap<string, readonly string[]>,
): void {
  for (const [source, warnings] of additions) {
    target.warningsBySource.set(source, [
      ...new Set([...(target.warningsBySource.get(source) ?? []), ...warnings]),
    ]);
  }
  target.warnings.splice(
    0,
    target.warnings.length,
    ...new Set([
      ...target.warnings,
      ...[...additions.values()].flatMap((warnings) => [...warnings]),
    ]),
  );
}

/**
 * The status bar for a cycle with no conflict, no pending restart and sync
 * switched on.
 *
 * A standing warning is not visible anywhere else once its log line scrolls
 * away, so "everything is fine" has to account for every kind of them: a stream
 * warning blocks compaction and checkpointing; an oversized resource never
 * reaches the other devices; a whole resource kind can be switched off because
 * the database capability is missing; and a helper warning means the shutdown
 * half of the cycle dropped something — for workspaceStorage, the only backup
 * path there is. A green check mark over any of those is the failure the user
 * only notices weeks later.
 */
export function settledStatus(input: {
  streamWarnings: number;
  publishWarnings: number;
  helperWarnings: number;
  disabledKinds: string;
}): { status: SyncStatus; detail?: string } {
  const details = [
    input.streamWarnings === 0
      ? ""
      : `${input.streamWarnings} stream warning(s) standing; compaction and checkpointing stay blocked.`,
    input.publishWarnings === 0
      ? ""
      : `${input.publishWarnings} resource(s) are too large to publish.`,
    input.helperWarnings === 0
      ? ""
      : `${input.helperWarnings} warning(s) from the last offline helper run; some resources were not saved to the repository.`,
    input.disabledKinds,
  ].filter((message) => message.length > 0);
  if (details.length === 0) {
    return { status: "up-to-date" };
  }
  return {
    // A stream warning alone stays green-with-a-tooltip: it clears itself once
    // the missing events propagate. The other three mean data is not moving.
    status:
      input.disabledKinds.length > 0 ||
      input.publishWarnings > 0 ||
      input.helperWarnings > 0
        ? "partial"
        : "up-to-date",
    detail: `${details.join(" ")} Open "Cursor Setting Sync: Manage" and choose "Show Diagnostics".`,
  };
}

/**
 * What the user is told when the automatic quit did not take effect.
 *
 * Deliberately does not mention killing anything: the offline helper is itself
 * a `Cursor.exe`, and so is a shutdown finalizer whose only job is the
 * workspaceStorage backup - "end all Cursor.exe tasks" destroys the very thing
 * the user is trying to move. Closing windows is enough, because the helper
 * waits on the process list rather than on the command it issued.
 */
/**
 * How old a helper request must be before "never reported a result" can be
 * true of it: the 3-minute exit wait, the 3-minute lock wait, and margin for
 * the apply itself. The shutdown finalizer is recognized by its heartbeated
 * lock instead - it waits for days by design.
 */
const ABANDONED_HELPER_MIN_AGE_MS = 15 * 60_000;

/**
 * How long a window waits before trying again to install its shutdown
 * finalizer after finding the previous one busy - typically mid-export from
 * the prior quit. Exports usually take seconds; a minute keeps the retry from
 * hammering the lock while still landing this session's finalizer promptly.
 */
const FINALIZER_RETRY_DELAY_MS = 60_000;

/**
 * How long an apply-in-progress marker blocks other windows from starting a
 * second apply over the same queue: the helper's 3-minute exit wait, its lock
 * wait, and margin for the pre-quit sync. A marker older than this belongs to
 * a run that ended without cleanup and is ignored.
 */
const APPLY_IN_PROGRESS_TTL_MS = 210_000;

/** How often a window torn down by a sibling's disconnect probes for a reconnect. */
const RECONNECT_PROBE_INTERVAL_MS = 60_000;

export const QUIT_STALLED_MESSAGE =
  `Cursor Setting Sync asked Cursor to close ${Math.round(QUIT_START_GRACE_MS / 1000)} seconds ago and it is still open, so the queued changes have not been written. ` +
  "Closing Cursor yourself in the next couple of minutes still completes it - the offline helper is waiting for the windows to go away, not for the command it sent - " +
  "and it will then write the changes and reopen Cursor. Nothing is lost if you would rather keep working; the queue stays where it is.";

/**
 * Whether a file in the extension storage root is a helper result.
 *
 * `writeFileAtomic` writes `<path>.<pid>.<uuid>.partial` and then renames, and
 * that temp file starts with the result prefix too. Matching it meant parsing a
 * half-written buffer; from the only caller there used to be that threw out of
 * `initialize()` and reached the user as "activation failed" and nothing else.
 * Consuming on every sync cycle would have made it routine.
 */
export function isHelperResultFileName(name: string): boolean {
  return name.startsWith("helper-result-") && name.endsWith(".json");
}

const HELPER_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface HelperStderrLogPaths {
  requestPath: string;
  stderrLogPath: string;
}

/** Safe paths named by one canonical helper stderr-log basename. */
export function helperStderrLogPaths(
  storageRoot: string,
  stderrLogFileName: string,
): HelperStderrLogPaths | null {
  const prefix = "helper-request-";
  const suffix = ".json.stderr.log";
  if (
    !stderrLogFileName.startsWith(prefix) ||
    !stderrLogFileName.endsWith(suffix)
  ) {
    return null;
  }
  const requestId = stderrLogFileName.slice(
    prefix.length,
    -suffix.length,
  );
  if (!HELPER_REQUEST_ID_PATTERN.test(requestId)) {
    return null;
  }
  return {
    requestPath: join(storageRoot, `helper-request-${requestId}.json`),
    stderrLogPath: join(storageRoot, stderrLogFileName),
  };
}

/**
 * Removes old stderr captures whose helper request no longer exists.
 *
 * The helper writes its request before the launcher opens this log, and keeps
 * the request until its run finishes. The age gate covers the small interval
 * after that final removal, while the repeated request/mtime checks keep a
 * concurrent startup or final write from being mistaken for historical litter.
 */
export async function removeAbandonedHelperStderrLogs(
  storageRoot: string,
  now = Date.now(),
): Promise<number> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(storageRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return 0;
    }
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const paths = helperStderrLogPaths(storageRoot, entry.name);
    if (paths === null || (await pathExists(paths.requestPath))) {
      continue;
    }
    let info;
    try {
      info = await stat(paths.stderrLogPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }
    if (now - info.mtimeMs <= ABANDONED_HELPER_MIN_AGE_MS) {
      continue;
    }
    // Re-check both facts immediately before deletion. A helper cannot
    // legitimately own a log without its request, and any recent write makes
    // the log young again even if the initial directory snapshot was stale.
    if (await pathExists(paths.requestPath)) {
      continue;
    }
    try {
      info = await stat(paths.stderrLogPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }
    if (now - info.mtimeMs <= ABANDONED_HELPER_MIN_AGE_MS) {
      continue;
    }
    await rm(paths.stderrLogPath, { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * The stderr capture belonging to one claimed helper result, when its identity
 * is safe and self-consistent.
 *
 * Result JSON is external process output and therefore untrusted at runtime;
 * its TypeScript `requestId: string` annotation is not validation. Requiring
 * the canonical UUID produced by `randomUUID()` prevents path separators,
 * absolute paths and dot segments, while matching the result file name stops a
 * malformed result from deleting another still-running helper's log.
 */
export function helperStderrLogPathForResult(
  storageRoot: string,
  resultFileName: string,
  requestId: unknown,
): string | null {
  if (
    typeof requestId !== "string" ||
    !HELPER_REQUEST_ID_PATTERN.test(requestId) ||
    resultFileName !== `helper-result-${requestId}.json`
  ) {
    return null;
  }
  return join(storageRoot, `helper-request-${requestId}.json.stderr.log`);
}

/**
 * One actionable sentence from whatever the helper died of.
 *
 * `HelperResult.error` is `error.stack ?? error.message`, so what arrives is a
 * class name followed by frames of `helper.js` line numbers. That was the whole
 * of the user-facing text, in a status bar tooltip, on a device where the
 * failure meant 146 incoming chats stayed unwritten.
 */
/**
 * A run that stopped because Cursor was open again, rather than one that
 * failed.
 *
 * Prefers the structured flag and falls back to the message, because a helper
 * armed before 0.0.54 is still the one that runs at the first shutdown after
 * an update - the finalizer process is spawned at startup and holds that
 * build's code - so the very upgrade that introduces the flag reports without
 * it exactly once.
 */
export function isInterruptedResult(result: {
  interrupted?: boolean;
  error?: string | null;
}): boolean {
  return (
    result.interrupted === true ||
    (result.error ?? "").includes(
      "Cursor was reopened before offline changes could be applied",
    )
  );
}

export function interruptedHelperResultLog(result: {
  requestId: string;
  applied: readonly string[];
}): string {
  return result.applied.length === 0
    ? `Helper ${result.requestId} was interrupted before any page completion was recorded; the in-flight page remains queued for safe replay, and some idempotent writes may already have occurred.`
    : `Helper ${result.requestId} was interrupted after recording ${result.applied.length} applied resource(s); completed pages remain applied, while the in-flight page and remaining queue stay queued for safe replay and may include idempotent writes already made.`;
}

/**
 * " · 167 messages" for a chat version, and nothing for anything else.
 *
 * Restoring a conversation is the one case where the user has to tell two
 * versions of the same resource apart on content, and bytes are a poor proxy:
 * a pruned capture and a full one differ by orders of magnitude, but nothing
 * on the line said which number meant "the conversation is still in here".
 */
function versionMessageCount(
  metadata: Record<string, JsonValue> | undefined,
): string {
  const count = metadata?.["bubbleCount"];
  if (typeof count !== "number") {
    return "";
  }
  return ` · ${count} message${count === 1 ? "" : "s"}`;
}

/**
 * Converts one trusted full chat payload into the bounded candidate shape the
 * repair decision actually consumes.
 *
 * The live envelope is shared rather than copied and only unavailable bubble
 * rows survive. This preserves composer identity and value-disagreement checks
 * while allowing the parsed historical snapshot (and its often enormous set
 * of unrelated rows) to be collected before the next candidate is read.
 */
export function chatRepairCandidateForUnavailableRows(
  versionId: string,
  content: Buffer,
  observation: BrokenChatObservation,
  unavailableKeys: ReadonlySet<string>,
): ChatRepairCandidate | null {
  return parseChatRepairCandidate(
    versionId,
    content,
    observation,
    unavailableKeys,
  )?.candidate ?? null;
}

interface ParsedChatRepairCandidate {
  candidate: ChatRepairCandidate;
  rows: PortableKvRow[];
  /** Shared only until this candidate has been folded into the bounded union. */
  agentKv: PortableAgentKvPayload | null;
}

function parseChatRepairCandidate(
  versionId: string,
  content: Buffer,
  observation: BrokenChatObservation,
  unavailableKeys: ReadonlySet<string>,
): ParsedChatRepairCandidate | null {
  const stored = parsePortableChatSnapshot(content);
  if (stored.composerId !== observation.composerId) {
    return null;
  }
  return {
    candidate: {
      versionId,
      snapshot: {
        ...observation.snapshot,
        bubbles: stored.bubbles.filter((row) => unavailableKeys.has(row.key)),
      },
    },
    rows: stored.bubbles,
    agentKv: isPortableChatSnapshotV2(stored) ? stored.agentKv : null,
  };
}

/**
 * Repair history is an interactive, extension-host operation. The repository
 * may accept payloads as large as 512 MiB, but decrypting and JSON-parsing one
 * of those snapshots (or retaining a union of many smaller ones) has much
 * larger in-memory amplification. Keep every sequential source and the
 * retained candidate/output aggregates at the same fixed bound used by the
 * live broken-chat inspection. Released source buffers are deliberately not
 * accumulated: without a persistent cursor that would permanently starve an
 * older complete source behind several individually bounded partial sources.
 */
const MAX_CHAT_REPAIR_HISTORY_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_REPAIR_HISTORY_AGGREGATE_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_REPAIR_OUTPUT_AGGREGATE_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_REPAIR_BUBBLE_ROWS = 250_000;
const MIN_CHAT_REPAIR_PAYLOAD_HEADROOM_BYTES = 64 * 1024;

interface ChatRepairBubbleAccumulator {
  rows: Map<string, PortableKvRow>;
  canonicalBytesByKey: Map<string, number>;
  canonicalBytes: number;
  /** Conservative canonical work retained by the v2 continuation union. */
  agentCanonicalBytes: number;
  maxCanonicalBytes: number;
}

/**
 * Leaves room for the live header/composerData, JSON framing and (for v2)
 * continuation graph. The exact completed payload is checked again before it
 * is queued, while this earlier bound prevents a disjoint history union from
 * consuming unbounded RAM just to discover that it cannot be published.
 */
function createChatRepairBubbleAccumulator(
  maxPayloadBytes: number,
): ChatRepairBubbleAccumulator {
  const headroom = Math.min(
    maxPayloadBytes,
    Math.max(
      MIN_CHAT_REPAIR_PAYLOAD_HEADROOM_BYTES,
      Math.ceil(maxPayloadBytes / 10),
    ),
  );
  return {
    rows: new Map(),
    canonicalBytesByKey: new Map(),
    canonicalBytes: 0,
    agentCanonicalBytes: 0,
    maxCanonicalBytes: Math.max(0, maxPayloadBytes - headroom),
  };
}

/**
 * Accumulates one newest-first candidate atomically using the repair union
 * rule. Row count and exact canonical row bytes are checked before the Map is
 * mutated, so an oversized candidate cannot leave a partial trusted union for
 * the subsequent repair decision.
 */
function retainNewestUsableChatRows(
  retained: ChatRepairBubbleAccumulator,
  rows: readonly PortableKvRow[],
): boolean {
  const updates: Array<{ row: PortableKvRow; canonicalBytes: number }> = [];
  let nextCount = retained.rows.size;
  let nextCanonicalBytes = retained.canonicalBytes;
  for (const row of rows) {
    const existing = retained.rows.get(row.key);
    if (
      existing === undefined ||
      (!isUsableChatBubble(existing) && isUsableChatBubble(row))
    ) {
      const rowCanonicalBytes = canonicalBytes(row).byteLength;
      if (existing === undefined) {
        nextCount += 1;
      } else {
        nextCanonicalBytes -=
          retained.canonicalBytesByKey.get(row.key) ?? 0;
      }
      nextCanonicalBytes += rowCanonicalBytes;
      if (
        nextCount > MAX_CHAT_REPAIR_BUBBLE_ROWS ||
        nextCanonicalBytes + retained.agentCanonicalBytes >
          retained.maxCanonicalBytes
      ) {
        return false;
      }
      updates.push({ row, canonicalBytes: rowCanonicalBytes });
    }
  }
  for (const update of updates) {
    retained.rows.set(update.row.key, update.row);
    retained.canonicalBytesByKey.set(
      update.row.key,
      update.canonicalBytes,
    );
  }
  retained.canonicalBytes = nextCanonicalBytes;
  return true;
}

/**
 * Automatic bubble repair normally sees graphs produced by the bounded v2
 * capture/enrichment paths (4,096 nodes / 32 MiB). Refuse an unexpectedly
 * larger historical union instead of turning a command into unbounded RAM
 * growth or publishing a truncated reachability partition.
 */
const MAX_CHAT_REPAIR_AGENT_KV_IDS = 4_096;
const MAX_CHAT_REPAIR_AGENT_KV_BYTES = 32 * 1024 * 1024;

interface ChatRepairAgentKvAccumulator {
  sawV2: boolean;
  blobs: Map<string, PortableKvRow>;
  referencedIds: Set<string>;
  blobBytes: number;
}

function createChatRepairAgentKvAccumulator(): ChatRepairAgentKvAccumulator {
  return {
    sawV2: false,
    blobs: new Map(),
    referencedIds: new Set(),
    blobBytes: 0,
  };
}

/**
 * Folds one newest-first v2 graph into the repair graph without retaining the
 * candidate's full snapshot. The check is atomic: an overflowing candidate
 * leaves the accumulator unchanged and causes the repair to be deferred.
 */
function retainChatRepairAgentKv(
  retained: ChatRepairAgentKvAccumulator,
  incoming: PortableAgentKvPayload,
  sharedBudget: ChatRepairBubbleAccumulator,
): boolean {
  const newReferencedIds = incoming.referencedIds.filter(
    (id) => !retained.referencedIds.has(id),
  );
  if (
    retained.referencedIds.size + newReferencedIds.length >
    MAX_CHAT_REPAIR_AGENT_KV_IDS
  ) {
    return false;
  }

  const newBlobs = incoming.blobs.filter(
    (blob) => !retained.blobs.has(blob.key),
  );
  const additionalBlobBytes = newBlobs.reduce(
    (total, blob) => total + Buffer.byteLength(blob.valueBase64, "base64"),
    0,
  );
  // Charge the retained Base64/key representation, not only decoded bytes.
  // Referenced IDs can also appear in missingIds, so debit each new ID twice;
  // later materialization may remove one occurrence but never increases this
  // conservative bound.
  const additionalCanonicalBytes =
    newBlobs.reduce(
      (total, blob) => total + canonicalBytes(blob).byteLength + 1,
      0,
    ) +
    newReferencedIds.reduce(
      (total, id) =>
        total + 2 * Buffer.byteLength(JSON.stringify(id), "utf8") + 2,
      0,
    );
  if (
    retained.blobBytes + additionalBlobBytes >
      MAX_CHAT_REPAIR_AGENT_KV_BYTES ||
    sharedBudget.canonicalBytes +
      sharedBudget.agentCanonicalBytes +
      additionalCanonicalBytes >
      sharedBudget.maxCanonicalBytes
  ) {
    return false;
  }

  retained.sawV2 = true;
  for (const id of newReferencedIds) {
    retained.referencedIds.add(id);
  }
  for (const blob of newBlobs) {
    retained.blobs.set(blob.key, blob);
  }
  retained.blobBytes += additionalBlobBytes;
  sharedBudget.agentCanonicalBytes += additionalCanonicalBytes;
  return true;
}

function materializeChatRepairAgentKv(
  retained: ChatRepairAgentKvAccumulator,
): PortableAgentKvPayload {
  const blobs = [...retained.blobs.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  const referencedIds = [...retained.referencedIds].sort();
  const materializedIds = new Set(
    blobs.map((blob) => blob.key.slice(AGENT_KV_BLOB_PREFIX.length)),
  );
  return {
    blobs,
    referencedIds,
    missingIds: referencedIds.filter((id) => !materializedIds.has(id)),
  };
}

/** Mirrors the repair builder's lossless-JSON bubble validity check. */
function isUsableChatBubble(row: PortableKvRow): boolean {
  if (row.valueType === "null") {
    return false;
  }
  const bytes = Buffer.from(row.valueBase64, "base64");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function chatRepairLabel(observation: BrokenChatObservation): string {
  if (observation.title !== null) {
    return observation.title;
  }
  const workspace = observation.workspaceId?.trim();
  return workspace === undefined || workspace.length === 0
    ? `Cursor conversation ${observation.composerId.slice(0, 8)}`
    : `${workspace} · ${observation.composerId.slice(0, 8)}`;
}

function chatRepairDeferredInspectionDetail(
  deferredBrokenChats: number,
  oversizedChats: number,
  snapshotByteLimit: number,
  limitReached: boolean,
): string {
  if (deferredBrokenChats === 0 && oversizedChats === 0 && !limitReached) {
    return "";
  }
  const detail: string[] = [];
  if (deferredBrokenChats > 0 || (limitReached && oversizedChats === 0)) {
    const deferred =
      deferredBrokenChats === 0
        ? "The audit reached its command memory safety limit before every damaged conversation could be retained."
        : `${deferredBrokenChats} additional damaged conversation${
            deferredBrokenChats === 1 ? " was" : "s were"
          } deferred by the command memory safety limit.`;
    detail.push(
      `${deferred} Apply or otherwise resolve this batch, then open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats" again to inspect the next batch.`,
    );
  }
  if (oversizedChats > 0) {
    detail.push(
      `${oversizedChats} conversation${oversizedChats === 1 ? "" : "s"} exceeded the hard ${formatBytes(snapshotByteLimit)} repair snapshot limit and ${oversizedChats === 1 ? "was" : "were"} not materialized or repaired automatically. Rerunning alone cannot make ${oversizedChats === 1 ? "it" : "them"} fit; use Restore Data… for manual recovery, or raise the repository payload limit when it is the smaller bound.`,
    );
  }
  return detail.join(" ");
}

function sameBrokenChatInspectionCursor(
  left: BrokenChatInspectionCursor | undefined,
  right: BrokenChatInspectionCursor,
): boolean {
  if (left === undefined) {
    return false;
  }
  const leftId = left.composerId;
  const rightId = right.composerId;
  if (leftId instanceof Uint8Array && rightId instanceof Uint8Array) {
    return Buffer.from(leftId).equals(Buffer.from(rightId));
  }
  return leftId === rightId;
}

type RecoveryCatalogCounts = Record<RecoveryCatalogStatus, number>;

interface RecoveryCatalogBuildResult {
  counts: RecoveryCatalogCounts;
  examinedChats: number;
  auditUnknownChats: number;
  cancelled: boolean;
  incomplete: boolean;
  databaseChanged: boolean;
  retiredEntries: number;
  catalogEntryCount: number;
  catalogReadyEntries: number;
  catalogReadyArtifactBytes: number;
  quotaReached: RecoveryCatalogLimitReason | null;
  indexPath: string | null;
}

function recoveryCatalogState(catalog: RecoveryCatalogResult): {
  catalogEntryCount: number;
  catalogReadyEntries: number;
  catalogReadyArtifactBytes: number;
} {
  return {
    catalogEntryCount: catalog.capacity.entryCount,
    catalogReadyEntries: catalog.manifest.entries.filter(
      (entry) => entry.status === "ready",
    ).length,
    catalogReadyArtifactBytes: catalog.capacity.readyArtifactBytes,
  };
}

function emptyRecoveryCatalogCounts(): RecoveryCatalogCounts {
  return {
    ready: 0,
    "skipped-limit": 0,
    "skipped-body": 0,
    changed: 0,
    unknown: 0,
  };
}

function recoveryCatalogProcessedCount(
  counts: RecoveryCatalogCounts,
): number {
  return (
    counts.ready +
    counts["skipped-limit"] +
    counts["skipped-body"] +
    counts.changed +
    counts.unknown
  );
}

function recoveryCatalogCompletionSummary(
  result: RecoveryCatalogBuildResult,
): string {
  const processed = recoveryCatalogProcessedCount(result.counts);
  const prefix = result.cancelled
    ? `Cancelled at an item boundary after cataloguing ${processed} conversation${processed === 1 ? "" : "s"}. Completed catalog checkpoints were kept.`
    : result.quotaReached !== null
      ? `Stopped cleanly at the bounded recovery catalog ${recoveryCatalogQuotaLabel(result.quotaReached)} quota after cataloguing ${processed} conversation${processed === 1 ? "" : "s"}. Completed catalog checkpoints were kept.${recoveryCatalogQuotaDetail(result.quotaReached)}`
      : result.databaseChanged
        ? `Cursor's live chat database changed during the multi-page audit. ${processed} verified catalog checkpoint${processed === 1 ? " was" : "s were"} kept, but the result is intentionally incomplete; open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats", and select "Preserve All Safely" for a stable full pass.`
      : result.incomplete
      ? `Stopped at the bounded bulk command limit after cataloguing ${processed} conversation${processed === 1 ? "" : "s"}. Completed catalog checkpoints were kept.`
      : `Finished the bounded audit of ${result.examinedChats} continuation record${result.examinedChats === 1 ? "" : "s"} and catalogued ${processed} definite continuation-damaged conversation${processed === 1 ? "" : "s"}.`;
  const details = [
    `${result.counts.ready} ready`,
    `${result.counts["skipped-limit"]} skipped by a recovery safety limit`,
    `${result.counts["skipped-body"]} skipped because visible message bodies were not safely recoverable`,
    `${result.counts.changed} changed during verification`,
    `${result.counts.unknown} failed closed for another reason`,
  ];
  const auditUnknown =
    result.auditUnknownChats === 0
      ? ""
      : ` The continuation audit could not safely classify ${result.auditUnknownChats} additional record${result.auditUnknownChats === 1 ? "" : "s"}; they were not treated as healthy or catalogued.`;
  const retired =
    result.retiredEntries === 0
      ? ""
      : ` ${result.retiredEntries} previously cataloged entr${result.retiredEntries === 1 ? "y was" : "ies were"} retired because a stable full pass no longer found definite continuation damage.`;
  const storage =
    result.catalogReadyEntries === 0
      ? ` The local catalog currently has ${result.catalogEntryCount} entr${result.catalogEntryCount === 1 ? "y" : "ies"} and no ready plaintext artifact.`
      : ` The local catalog currently has ${result.catalogReadyEntries} ready plaintext artifact${result.catalogReadyEntries === 1 ? "" : "s"} (${formatBytes(result.catalogReadyArtifactBytes)} currently referenced) across ${result.catalogEntryCount} entr${result.catalogEntryCount === 1 ? "y" : "ies"}. Catalog artifacts and any obsolete content-addressed derivatives remain in the local recovery-transcripts folder until you explicitly delete those recovery files. The original chats were not changed and no Agent or prompt was created.`;
  return `${prefix} ${details.join(", ")}.${auditUnknown}${retired}${storage}`;
}

function recoveryCatalogQuotaDetail(
  reason: RecoveryCatalogLimitReason,
): string {
  switch (reason) {
    case "artifact-bytes":
      return " This quota counts files referenced by the current ready catalog; obsolete or rejected content-addressed derivatives may remain in the local recovery-transcripts folder until you explicitly delete those recovery files.";
    case "physical-artifact-bytes":
    case "physical-artifact-files":
    case "physical-inventory":
      return " This physical quota counts all final, obsolete/rejected, and recognized atomic-partial files in the isolated catalog artifact tree.";
    case "metadata-partial-bytes":
    case "metadata-partial-files":
      return " This separate quota bounds retained manifest/index atomic-write partials; remove those recovery-transcripts files explicitly if you no longer need them.";
    case "entries":
    case "manifest-bytes":
    case "manifest-structure":
      return "";
  }
}

function recoveryCatalogQuotaLabel(
  reason: RecoveryCatalogLimitReason,
): string {
  switch (reason) {
    case "entries":
      return `${RECOVERY_CATALOG_LIMITS.maxEntries}-entry`;
    case "artifact-bytes":
      return formatBytes(RECOVERY_CATALOG_LIMITS.maxReadyArtifactBytes);
    case "manifest-bytes":
      return formatBytes(RECOVERY_CATALOG_LIMITS.maxManifestBytes);
    case "manifest-structure":
      return "manifest-structure";
    case "physical-artifact-bytes":
      return `${formatBytes(RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes)} physical-artifact`;
    case "physical-artifact-files":
      return `${RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactFiles}-physical-file`;
    case "physical-inventory":
      return "physical-inventory safety";
    case "metadata-partial-bytes":
      return `${formatBytes(RECOVERY_CATALOG_LIMITS.maxMetadataPartialBytes)} metadata-partial`;
    case "metadata-partial-files":
      return `${RECOVERY_CATALOG_LIMITS.maxMetadataPartialFiles}-metadata-partial-file`;
  }
}

function recoveryCatalogExtractionFailureStatus(
  error: unknown,
): RecoveryCatalogStatus {
  const message = recoveryCatalogErrorMessage(error).toLowerCase();
  if (message.includes("changed")) {
    return "changed";
  }
  if (
    message.includes("limit") ||
    message.includes("exceed") ||
    message.includes("oversized")
  ) {
    return "skipped-limit";
  }
  if (
    message.includes("visible") ||
    message.includes("referenced") ||
    message.includes("message") ||
    message.includes("recoverable user")
  ) {
    return "skipped-body";
  }
  return "unknown";
}

function recoveryCatalogArtifactFailureStatus(
  error: unknown,
): RecoveryCatalogStatus {
  const message = recoveryCatalogErrorMessage(error).toLowerCase();
  if (message.includes("changed") || message.includes("disappeared")) {
    return "changed";
  }
  if (
    message.includes("limit") ||
    message.includes("exceed") ||
    message.includes("oversized")
  ) {
    return "skipped-limit";
  }
  return "unknown";
}

function recoveryCatalogErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryCatalogCancellationRequested(
  token: vscode.CancellationToken | undefined,
): boolean {
  return token?.isCancellationRequested === true;
}

function recoveryCatalogLastUpdatedAt(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
    ? value
    : null;
}

interface CursorDatabaseGenerationMonitor {
  database: DatabaseSync;
  databasePath: string;
  file: FileHandle;
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  initialDataVersion: number;
}

async function openCursorDatabaseGenerationMonitor(
  databasePath: string,
): Promise<CursorDatabaseGenerationMonitor> {
  const file = await openFile(databasePath, "r");
  let database: DatabaseSync | undefined;
  try {
    const identity = await file.stat({ bigint: true });
    database = openDatabase(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout=2000");
    database.exec("PRAGMA query_only=ON");
    return {
      database,
      databasePath,
      file,
      device: identity.dev,
      inode: identity.ino,
      size: identity.size,
      mtimeNs: identity.mtimeNs,
      ctimeNs: identity.ctimeNs,
      initialDataVersion: readCursorDatabaseDataVersion(database),
    };
  } catch (error) {
    database?.close();
    await file.close();
    throw error;
  }
}

async function cursorDatabaseGenerationMonitorChanged(
  monitor: CursorDatabaseGenerationMonitor,
): Promise<boolean> {
  const [held, current] = await Promise.all([
    monitor.file.stat({ bigint: true }),
    stat(monitor.databasePath, { bigint: true }),
  ]);
  return (
    readCursorDatabaseDataVersion(monitor.database) !==
      monitor.initialDataVersion ||
    held.dev !== monitor.device ||
    held.ino !== monitor.inode ||
    held.size !== monitor.size ||
    held.mtimeNs !== monitor.mtimeNs ||
    held.ctimeNs !== monitor.ctimeNs ||
    current.dev !== monitor.device ||
    current.ino !== monitor.inode ||
    current.size !== monitor.size ||
    current.mtimeNs !== monitor.mtimeNs ||
    current.ctimeNs !== monitor.ctimeNs
  );
}

function readCursorDatabaseDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as
    | Record<string, unknown>
    | undefined;
  const raw = row?.data_version;
  const value =
    typeof raw === "bigint" &&
    raw <= BigInt(Number.MAX_SAFE_INTEGER) &&
    raw >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(raw)
      : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Cursor's chat database generation could not be read safely.");
  }
  return value;
}

function chatRepairAuditProgressDetail(
  progress: ChatRepairAuditProgress,
  snapshotByteLimit: number,
): string {
  const detail: string[] = [];
  if (progress.unavailableWithoutSource > 0) {
    detail.push(
      `${progress.unavailableWithoutSource} unavailable message-body conversation${
        progress.unavailableWithoutSource === 1 ? " has" : "s have"
      } no warning-free compatible synchronized source and ${
        progress.unavailableWithoutSource === 1 ? "was" : "were"
      } left unchanged. Recovery requires a known-good source PC or database backup.`,
    );
  }
  if (progress.historyBudgetDeferred > 0) {
    detail.push(
      `${progress.historyBudgetDeferred} conversation${
        progress.historyBudgetDeferred === 1 ? " was" : "s were"
      } deferred because synchronized repair history exceeded the bounded repair memory limit. A source known from authenticated metadata to be oversized was not read; it was left unchanged.`,
    );
  }
  if (progress.oversizedChats > 0) {
    detail.push(
      `${progress.oversizedChats} conversation${
        progress.oversizedChats === 1 ? " exceeded" : "s exceeded"
      } the hard ${formatBytes(snapshotByteLimit)} repair snapshot limit. Rerunning alone cannot make ${
        progress.oversizedChats === 1 ? "it" : "them"
      } fit.`,
    );
  }
  if (progress.unresolvedLimitReached) {
    detail.push(
      "At least one conversation could not be classified within a per-conversation JSON or metadata safety bound; rerunning alone does not advance past that condition.",
    );
  }
  return detail.join(" ");
}

function chatRepairFreshInspectionDetail(
  deferredBrokenChats: number,
  oversizedChats: number,
  snapshotByteLimit: number,
  unresolvedLimitReached: boolean,
): string {
  if (
    deferredBrokenChats === 0 &&
    oversizedChats === 0 &&
    !unresolvedLimitReached
  ) {
    return "";
  }
  const detail: string[] = [];
  if (deferredBrokenChats > 0) {
    const deferred = `${deferredBrokenChats} planned damaged conversation${
      deferredBrokenChats === 1 ? "" : "s"
    }`;
    detail.push(
      `The final memory-bounded recheck deferred ${deferred}; ${
        deferredBrokenChats === 1 ? "it was" : "they were"
      } left unchanged. Open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats" again to re-evaluate ${
        deferredBrokenChats === 1 ? "it" : "them"
      }.`,
    );
  }
  if (unresolvedLimitReached) {
    detail.push(
      "The final recheck could not safely classify one or more planned conversations within a per-conversation JSON or metadata safety bound; they were left unchanged. Rerunning alone does not advance past that condition.",
    );
  }
  if (oversizedChats > 0) {
    detail.push(
      `The final recheck found ${oversizedChats} planned conversation${oversizedChats === 1 ? "" : "s"} above the hard ${formatBytes(snapshotByteLimit)} repair snapshot limit; ${oversizedChats === 1 ? "it was" : "they were"} left unchanged without materializing the bubble values. Rerunning alone cannot repair ${oversizedChats === 1 ? "it" : "them"}; use Restore Data… for manual recovery.`,
    );
  }
  return detail.join(" ");
}

function continuationAuditIncompleteDetail(
  unknownChats: number,
  unknownReasonCounts: ChatContinuationUnknownReasonCounts,
  limitReached: boolean,
): string {
  if (unknownChats === 0 && !limitReached) {
    return "";
  }
  const details: string[] = [];
  const addReason = (
    count: number,
    singular: string,
    plural: string,
  ): void => {
    if (count > 0) {
      details.push(`${count} ${count === 1 ? singular : plural}`);
    }
  };
  addReason(
    unknownReasonCounts.structuralWorkLimit,
    "continuation record exceeded the conversation-state JSON structural-work limit",
    "continuation records exceeded the conversation-state JSON structural-work limit",
  );
  addReason(
    unknownReasonCounts.snapshotSizeLimit,
    "continuation record exceeded the bounded snapshot-size limit",
    "continuation records exceeded the bounded snapshot-size limit",
  );
  addReason(
    unknownReasonCounts.otherSafetyLimit,
    "continuation record exceeded another continuation safety limit",
    "continuation records exceeded other continuation safety limits",
  );
  addReason(
    unknownReasonCounts.unreadable,
    "continuation record was not safely readable",
    "continuation records were not safely readable",
  );
  const bounded = limitReached
    ? "the continuation audit also reached a safety bound before every conversation could be verified"
    : "";
  if (bounded.length > 0) {
    details.push(bounded);
  }
  return `${details.join("; ")}.`;
}

/** "3m 12s", or "7s" under a minute. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0
    ? `${seconds}s`
    : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** " in 3m 12s", or nothing when the helper did not report a start time. */
export function helperRunDuration(result: {
  startedAt?: string;
  completedAt?: string;
}): string {
  const started = Date.parse(result.startedAt ?? "");
  const completed = Date.parse(result.completedAt ?? "");
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    return "";
  }
  return ` in ${formatDuration(completed - started)}`;
}

export function helperFailureDetail(error: string | null): string {
  const summary = (error ?? "")
    .split("\n")[0]
    ?.trim()
    .replace(/^[A-Za-z]*Error:\s*/, "") ?? "";
  const retry = `Close every other Cursor window and run "${RESTART_TO_APPLY_TITLE}" again.`;
  return summary.length === 0
    ? `The offline helper failed. ${retry}`
    : `${summary} Nothing was applied, so the queued changes are still here. ${retry}`;
}

/** Permanent machine-local exclusions are not outstanding repository work. */
export function pendingDatabaseChangesBlockMaintenance(
  pending: readonly PendingDatabaseChange[],
): boolean {
  return pending.some(
    (change) => !isPermanentExclusionReason(change.blockedReason),
  );
}

/**
 * What the status bar says while database changes sit in the queue.
 *
 * The old text was "N change(s) are waiting for restart." A user with 146
 * incoming chats read that as an instruction to restart Cursor, did exactly
 * that - repeatedly, eventually force-quitting every process - and the queue
 * was untouched each time, because the shutdown finalizer exports without
 * applying and only the command writes anything. So the sentence names the
 * command and says outright that a restart is not it.
 *
 * The per-kind breakdown is what makes the number recognizable: "175 chat"
 * tells the user which of their data is missing, where "227 change(s)" does
 * not.
 */
export function pendingRestartDetail(
  pending: readonly PendingDatabaseChange[],
  applyOnShutdown = false,
): string {
  const ready = pending.filter((change) => change.blockedReason === undefined);
  // Split three ways, not two. A change held by a standing decision of this
  // computer is not waiting for anything and nobody needs to act on it, so
  // counting it beside a compatibility hold turned a correctly configured
  // machine into an alarming "234 change(s) are deferred" - which is what the
  // other computer's local-only folders look like when the policy that is
  // meant to exclude them is working exactly as intended.
  const excluded = pending.filter((change) =>
    isPermanentExclusionReason(change.blockedReason),
  );
  const deferred = pending.filter(
    (change) =>
      change.blockedReason !== undefined &&
      !isPermanentExclusionReason(change.blockedReason),
  );
  return [
    ready.length === 0
      ? ""
      : applyOnShutdown
        ? `${ready.length} change(s) from another device (${summarizePendingKinds(ready)}) are queued. ` +
          `They are written the next time you close Cursor - no restart needed. ` +
          `Run "${RESTART_TO_APPLY_TITLE}" to write them now instead.`
        : `${ready.length} change(s) from another device (${summarizePendingKinds(ready)}) are queued. ` +
          `Run "${RESTART_TO_APPLY_TITLE}" to write them - quitting and reopening Cursor does not.`,
    deferred.length === 0
      ? ""
      : `${deferred.length} change(s) are deferred: ${commonestBlockedReason(deferred)}`,
    excluded.length === 0
      ? ""
      : `${excluded.length} change(s) are excluded by this computer's settings and are not waiting for anything: ${commonestBlockedReason(excluded)}`,
  ]
    .filter((message) => message.length > 0)
    .join(" ");
}

/**
 * Deferrals used to be reported as "newer-version database change(s)", which
 * was the only reason there was. A workspace excluded on this computer is now
 * another, and a count with the wrong explanation attached is worse than a
 * count with none - so the reason is read off the entries themselves.
 */
function commonestBlockedReason(
  deferred: readonly PendingDatabaseChange[],
): string {
  const counts = new Map<string, number>();
  for (const change of deferred) {
    const reason = change.blockedReason ?? "";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const [reason] = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0] ?? [""];
  return reason.length === 0 ? "Update Cursor and try again." : reason;
}

function summarizePendingKinds(
  pending: readonly { kind: string }[],
): string {
  const counts = new Map<string, number>();
  for (const change of pending) {
    counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
}

/**
 * What the queued-apply offer says.
 *
 * The third sentence is the one that had to be added. The queue is written by
 * an offline helper that runs while Cursor is closed, so every part of the
 * description - "waiting", "can only be written while it is closed" - reads as
 * an instruction to close Cursor, and closing Cursor is precisely what does not
 * write it. A user acting on the obvious reading restarts, sees the same queue,
 * and concludes the feature is broken. Say it outright instead.
 */
export function queuedApplyPrompt(
  pending: readonly { kind: string }[],
  deferredForBatchLimit = 0,
): string {
  return (
    `${pending.length} change(s) from your other computers (${summarizePendingKinds(pending)}) are waiting. ` +
    "They live in databases Cursor keeps open, so they can only be written while it is closed: choosing to apply saves your editors, quits Cursor, writes them and reopens it. " +
    "Restarting Cursor yourself does not write them - only this does." +
    // Said exactly, or not at all. The old text hedged that a large queue
    // "may need more than one pass" on every queue alike, which was noise on
    // the ones that fit and no help on the ones that did not.
    (deferredForBatchLimit > 0
      ? ` ${deferredForBatchLimit} more will be processed automatically in successive bounded pages during the same apply.`
      : "")
  );
}

/** What the poll path remembers about a sync lock it keeps failing to take. */
export interface LockSkipState {
  pid: number | null;
  loggedAt: number;
  skipped: number;
}

/**
 * Whether a poll that could not take the sync lock should say so again.
 *
 * A held lock is the ordinary state while a long cycle or the offline helper
 * runs, and every skipped poll wrote its own line. At a thirty-second poll, per
 * window, that is two lines a minute for as long as it lasts: a real session
 * buried its standing warnings under the repetition, which is the one thing the
 * output channel exists to show. Suppression keys on the holder's PID rather
 * than on the sentence, because the sentence carries an age that changes every
 * minute and so never repeats exactly.
 *
 * Silence is not the goal — a lock held for an hour is something the user has
 * to be able to see — so a new holder or {@link LOCK_SKIP_REMINDER_MS} says it
 * again, and a manual sync always answers the person who asked.
 */
export function noteLockSkip(
  previous: LockSkipState | null,
  holder: LockHolderReport,
  now: number,
  manual: boolean,
): { line: string | null; state: LockSkipState } {
  const skipped = (previous?.skipped ?? 0) + 1;
  if (
    previous !== null &&
    !manual &&
    previous.pid === holder.pid &&
    now - previous.loggedAt < LOCK_SKIP_REMINDER_MS
  ) {
    return {
      line: null,
      state: { pid: holder.pid, loggedAt: previous.loggedAt, skipped },
    };
  }
  // The count only means something while it is the same holder still working;
  // across a change of holder it would read as one long wait that never was.
  const repetition =
    previous !== null && previous.pid === holder.pid && skipped > 1
      ? ` (${skipped} cycle(s) skipped so far)`
      : "";
  return {
    line: `Skipped sync${repetition}: ${holder.description}`,
    state: { pid: holder.pid, loggedAt: now, skipped },
  };
}

/**
 * Closes out a run of skipped polls. Without it the last thing the channel says
 * about a lock is that sync was skipped, which reads as still-stuck long after
 * the cycle recovered.
 */
export function lockSkipResumedLine(
  previous: LockSkipState | null,
): string | null {
  // A single poll losing a race to a neighbouring window mid-cycle is the
  // ordinary case and already cost one line; adding a second saying it is over
  // would double the volume this change exists to cut.
  return previous === null || previous.skipped < 2
    ? null
    : `Synchronization resumed after ${previous.skipped} skipped cycle(s).`;
}

/**
 * The warning bucket a batch of consumed helper results is entitled to write.
 *
 * The offline helper is the only path that ever backs up workspaceStorage, and
 * it runs after the extension host is gone, so a resource it drops for
 * exceeding the payload limit is invisible unless the result carries the news
 * back. A successful result used to produce a single output-channel line and a
 * green check mark, which is quieter than the hard failure that guard replaced:
 * the same workspace database was dropped on every shutdown, indefinitely.
 *
 * Returns an empty map — meaning "this source did not run, leave its bucket
 * alone" — when no result in the batch reports warnings in the structured
 * field. Results written by helpers older than 0.0.5 have no such field, and
 * their `skipped` list mixes real problems with routine entries, so guessing
 * would either invent warnings or clear standing ones that are still true.
 */
export function helperWarningObservation(
  results: readonly HelperResult[],
  /**
   * Warning texts already standing, merged in when a mid-session result must
   * ADD to the bucket without being entitled to clear it - the startup path
   * omits this so a clean run still clears.
   */
  alsoStanding: readonly string[] = [],
): Map<string, readonly string[]> {
  const reported = results.filter((result) => result.warnings !== undefined);
  if (reported.length === 0) {
    return new Map();
  }
  // One bucket for the whole batch: a later helper run reporting no warnings
  // is exactly what clears an earlier run's standing warning.
  return new Map([
    [
      HELPER_WARNING_SOURCE,
      [
        ...new Set([
          ...alsoStanding,
          ...reported.flatMap((result) => result.warnings ?? []),
        ]),
      ],
    ],
  ]);
}

/**
 * The publish warning buckets this cycle is entitled to overwrite.
 *
 * `filterPublishableChanges` can only raise a warning for a resource the scan
 * just produced, so a cycle that did not run an adapter cannot say anything
 * about that adapter's oversized resources. Reporting one global publish bucket
 * made every "chat" cycle clear the warning a "files" cycle had just raised,
 * which flipped the status back to green and re-logged the identical line as
 * new every 60 seconds. Each adapter that ran gets its own bucket — empty when
 * it produced no oversized resource, which is the signal that the warning
 * genuinely cleared — and an adapter that did not run is simply absent.
 */
export function publishWarningObservation(
  ranAdapterIds: Iterable<string>,
  warningsBySource: ReadonlyMap<string, readonly string[]>,
): Map<string, readonly string[]> {
  const observation = new Map<string, readonly string[]>();
  for (const adapterId of ranAdapterIds) {
    observation.set(publishWarningSource(adapterId), []);
  }
  for (const [source, warnings] of warningsBySource) {
    observation.set(source, warnings);
  }
  return observation;
}

export function shouldScanAdapter(
  adapter: ResourceAdapter,
  scope: SyncScope,
  requiredKinds: ReadonlySet<ResourceKind>,
): boolean {
  if (adapter.scanWhileRunning === false) {
    return false;
  }
  if (adapter.kinds.some((kind) => requiredKinds.has(kind))) {
    return true;
  }
  if (scope === "all") {
    return true;
  }
  const chatAdapter = adapter.kinds.every(isChatResourceKind);
  if (scope === "chat") {
    return chatAdapter;
  }
  if (scope === "files") {
    return !chatAdapter;
  }
  return false;
}


/** What the pre-scan synthetic apply did, and whether it changed anything. */
interface SyntheticApplyResult {
  driftSkipped: Set<string>;
  changed: boolean;
}

interface CheckpointCommandOutcome {
  created: CheckpointCreateResult | null;
  prune: PruneResult | null;
  gitSquash: SquashHistoryResult | null;
}

function checkpointCoversStreams(
  checkpoint: AbsorbedCheckpoint | undefined,
  streams: Record<string, StreamCursor>,
): boolean {
  if (checkpoint === undefined) {
    return Object.keys(streams).length === 0;
  }
  const deviceIds = new Set([
    ...Object.keys(checkpoint.streams),
    ...Object.keys(streams),
  ]);
  for (const deviceId of deviceIds) {
    const folded = checkpoint.streams[deviceId];
    const current = streams[deviceId];
    if (
      folded?.lastSequence !== current?.lastSequence ||
      folded?.lastEventHash !== current?.lastEventHash
    ) {
      return false;
    }
  }
  return true;
}

function historyPreviewText(
  operation: ResourceOperation,
  content: Buffer | null,
): string {
  if (operation === "delete") {
    return "[Deleted]\n";
  }
  if (content === null) {
    return "[Payload content is unavailable; it may have been compacted]\n";
  }
  if (content.byteLength > HISTORY_PREVIEW_MAX_PAYLOAD_BYTES) {
    return `[Payload is ${content.byteLength} bytes; preview omitted]\n`;
  }
  const text = content.toString("utf8");
  return text.includes("\uFFFD")
    ? `[Binary payload]\n${content.toString("base64")}`
    : text;
}

function declaredHistoryPreviewFits(
  operation: ResourceOperation,
  plainBytes: number | null,
): boolean {
  return (
    operation === "delete" ||
    (typeof plainBytes === "number" &&
      Number.isSafeInteger(plainBytes) &&
      plainBytes >= 0 &&
      plainBytes <= HISTORY_PREVIEW_MAX_PAYLOAD_BYTES)
  );
}

function historyPreviewOmittedText(
  operation: ResourceOperation,
  plainBytes: number | null,
): string {
  if (operation === "delete") {
    return "[Deleted]\n";
  }
  return typeof plainBytes === "number" &&
    Number.isSafeInteger(plainBytes) &&
    plainBytes >= 0
    ? `[Payload is ${formatBytes(plainBytes)}; preview omitted before reading]\n`
    : "[Payload preview omitted before reading because its declared size is missing or invalid]\n";
}

function restoreVersionPayloadBlockReason(
  summary: ResourceVersionSummary,
  repositoryMaxPayloadBytes: number,
): string | null {
  if (summary.operation === "delete") {
    return null;
  }
  if (
    !Number.isSafeInteger(repositoryMaxPayloadBytes) ||
    repositoryMaxPayloadBytes <= 0
  ) {
    return (
      "The repository payload policy is missing or invalid, so this version cannot be restored safely. " +
      "Nothing was read or changed; correct cursorSettingSync.maxPayloadMiB and try again."
    );
  }
  const plainBytes = summary.plainBytes;
  const limit = Math.min(
    repositoryMaxPayloadBytes,
    RESTORE_VERSION_MAX_PAYLOAD_BYTES,
  );
  if (
    typeof plainBytes === "number" &&
    Number.isSafeInteger(plainBytes) &&
    plainBytes >= 0 &&
    plainBytes <= limit
  ) {
    return null;
  }
  const declared =
    typeof plainBytes === "number" &&
    Number.isSafeInteger(plainBytes) &&
    plainBytes >= 0
      ? formatBytes(plainBytes)
      : "no trustworthy plaintext size";
  return (
    `The selected version declares ${declared}, above the bounded ${formatBytes(
      limit,
    )} restore limit (the lower of the repository payload policy and fixed interactive memory cap), or its declared size is invalid. ` +
    "Nothing was read or changed; choose a smaller stored version."
  );
}

export function syntheticApplyDecision(
  scanned: AdapterScanIndex | null,
  resourceId: string,
  tip: ResourceTip,
  known: LocalProjection | undefined,
): SyntheticApplyDecision {
  if (scanned === null) {
    return { action: "drift" };
  }
  const live = scanned.snapshots.get(resourceId);
  if (live !== undefined) {
    if (live.semanticHash === tip.semanticHash) {
      return { action: "already-applied", live };
    }
    // Unpublished local edits exist; skip so the normal scan publishes
    // them as a tip instead of overwriting them with the merge result.
    return live.semanticHash === known?.semanticHash
      ? { action: "apply" }
      : { action: "drift" };
  }
  const deletion = scanned.deletions.get(resourceId);
  if (deletion !== undefined) {
    // A deletion whose hash the projection does not record is an unpublished
    // local delete; applying the merge result would silently resurrect it.
    return deletion.semanticHash === known?.semanticHash
      ? { action: "apply" }
      : { action: "drift" };
  }
  if (!scanned.complete || scanned.deferredResourceIds.has(resourceId)) {
    return { action: "drift" };
  }
  // Neither a snapshot nor a deletion for a resource the projection expects
  // means the file failed scan validation; treat as drift, not clean.
  return known === undefined ? { action: "apply" } : { action: "drift" };
}

/**
 * Drift decision for an ordinary replicated tip.
 *
 * A complete adapter scan may intentionally omit a known unchanged resource
 * after proving its file/database identity. Unlike a synthetic merge, that is
 * safe to replace with an ordinary remote successor. An incomplete scan is
 * never such proof, even when the target is not one of the exact IDs a bounded
 * enumerator already knows it deferred.
 */
export function ordinaryApplyDecision(
  scanned: AdapterScanIndex | null,
  resourceId: string,
  tip: ResourceTip,
  known: LocalProjection | undefined,
): SyntheticApplyDecision {
  if (scanned === null) {
    return { action: "drift" };
  }
  const live = scanned.snapshots.get(resourceId);
  if (live !== undefined) {
    if (live.semanticHash === tip.semanticHash) {
      return { action: "already-applied", live };
    }
    return live.semanticHash === known?.semanticHash
      ? { action: "apply" }
      : { action: "drift" };
  }
  const deletion = scanned.deletions.get(resourceId);
  if (deletion !== undefined) {
    return deletion.semanticHash === known?.semanticHash
      ? { action: "apply" }
      : { action: "drift" };
  }
  return scanned.complete && !scanned.deferredResourceIds.has(resourceId)
    ? { action: "apply" }
    : { action: "drift" };
}

function singleSnapshotScanIndex(snapshot: ResourceSnapshot): AdapterScanIndex {
  return {
    snapshots: new Map([[snapshot.resourceId, snapshot]]),
    deletions: new Map(),
    complete: true,
    deferredResourceIds: new Set(),
  };
}

function incompleteScanIndex(): AdapterScanIndex {
  return {
    snapshots: new Map(),
    deletions: new Map(),
    complete: false,
    deferredResourceIds: new Set(),
  };
}

export function parentsWithOwnConflictTips(
  projection: LocalProjection | undefined,
  tips: ResourceTip[],
  deviceId: string,
  semanticHash: string,
): string[] {
  // While a conflict is active, reconciliation emits no projection, so the
  // stale projection alone would pin every successive local edit to the same
  // parent and accumulate sibling tips. Superseding this device's own tips
  // keeps its edits a chain.
  const parents = new Set(parentsForLocalChange(projection, tips));
  for (const tip of tips) {
    if (tip.deviceId === deviceId && tip.semanticHash !== semanticHash) {
      parents.add(tip.versionId);
    }
  }
  return [...parents].sort();
}

/**
 * Bounds how often a resource in an unresolved conflict may republish this
 * device's tip. Returns the snapshots that may publish now, and the resource
 * ids held back for this cycle.
 *
 * The conflicted side must keep publishing — {@link parentsWithOwnConflictTips}
 * exists precisely so that successive local edits chain onto this device's own
 * tip instead of fanning out into siblings, and so the fork stays representable
 * with what is really on this machine. What must not happen is that publishing
 * becomes *unconditional*. A conflicted resource gets no projection from the
 * reconciler, so the projection short-circuit in `shouldPublishSnapshot` can
 * never fire for it again; only the "matches an existing tip" clause can, and
 * that one is useless for a value Cursor rewrites every few seconds. The result
 * is one brand-new event per poll per conflicted volatile resource, forever.
 *
 * A rate limit is the fix rather than "suppress when the content already
 * matches this device's own conflict tip", because that second option is
 * already implemented — `shouldPublishSnapshot` returns false when any tip is a
 * put with the same `semanticHash` — and it demonstrably does not bound a
 * volatile resource, whose hash is different every time. Only a time bound
 * does.
 *
 * `lastRepublishAt` is mutated: entries for resources that are no longer
 * conflicted are dropped, so it cannot outgrow the conflict set, and a resource
 * whose conflict is resolved and later reappears publishes immediately.
 */
export function throttleConflictedRepublish<T extends { resourceId: string }>(
  snapshots: readonly T[],
  conflictedResources: ReadonlySet<string>,
  lastRepublishAt: Map<string, number>,
  now: number,
  intervalMs: number,
): { publish: T[]; deferred: string[] } {
  for (const resourceId of [...lastRepublishAt.keys()]) {
    if (!conflictedResources.has(resourceId)) {
      lastRepublishAt.delete(resourceId);
    }
  }
  const publish: T[] = [];
  const deferred: string[] = [];
  for (const snapshot of snapshots) {
    if (!conflictedResources.has(snapshot.resourceId)) {
      publish.push(snapshot);
      continue;
    }
    const previous = lastRepublishAt.get(snapshot.resourceId);
    // The first observation of a fork always publishes, so a conflict that has
    // just appeared is represented by this device's real content at once.
    if (previous !== undefined && now - previous < intervalMs) {
      deferred.push(snapshot.resourceId);
      continue;
    }
    lastRepublishAt.set(snapshot.resourceId, now);
    publish.push(snapshot);
  }
  return { publish, deferred };
}

async function projectionInput(
  repository: SyncRepository,
  projection: ResourceProjection,
): Promise<ResourceApplyInput> {
  const tip = projection.tip;
  if (tip.operation === "delete") {
    return {
      resourceId: projection.resourceId,
      kind: tip.kind,
      semanticHash: tip.semanticHash,
      ...(tip.metadata === undefined ? {} : { metadata: tip.metadata }),
    };
  }
  if (tip.payload === undefined) {
    throw new Error(`Projection payload is missing: ${tip.versionId}`);
  }
  return {
    resourceId: projection.resourceId,
    kind: tip.kind,
    content: await repository.readObject(tip.payload),
    semanticHash: tip.semanticHash,
    ...(tip.metadata === undefined ? {} : { metadata: tip.metadata }),
  };
}

/**
 * Refuses a live extension-host materialization from authenticated manifest
 * metadata before readObject allocates it. The change stays visibly queued so
 * a source-device replacement below the fixed limit can supersede it; neither
 * the extension host nor the similarly bounded helper promises to materialize
 * this oversized version.
 */
function runningApplyPayloadBlockReason(
  resourceId: string,
  tip: ResourceTip,
  repositoryMaxPayloadBytes: number,
): string | null {
  if (tip.operation === "delete") {
    return null;
  }
  const limit = Math.min(
    repositoryMaxPayloadBytes,
    MAX_RUNNING_APPLY_PAYLOAD_BYTES,
  );
  const declaredBytes = tip.payload?.plainBytes;
  if (
    typeof declaredBytes === "number" &&
    Number.isSafeInteger(declaredBytes) &&
    declaredBytes >= 0 &&
    declaredBytes <= limit
  ) {
    return null;
  }
  const declared =
    typeof declaredBytes !== "number" ||
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes < 0
      ? "no trustworthy plaintext size"
      : formatBytes(declaredBytes);
  return (
    `${LIVE_APPLY_PAYLOAD_BLOCK_PREFIX}: ${resourceId} declares ${declared}, ` +
    `above the bounded ${formatBytes(limit)} live-apply memory limit. ` +
    "Reduce or replace the source payload below this fixed limit and synchronize again; this queued version was not read."
  );
}

/**
 * Records a local snapshot that did not need a new event.
 *
 * Usually its bytes already match the projection. During an unresolved
 * conflict, however, the local bytes can match a different current PUT tip.
 * `shouldPublishSnapshot` correctly suppresses that duplicate, but leaving the
 * old/absent projection behind makes stateful adapters treat the snapshot as
 * unacknowledged and re-read it forever. Selecting the exact matching tip is a
 * truthful local projection; it neither resolves nor removes the conflict.
 */
export function markSuppressedSnapshotProjection(
  projections: Record<string, LocalProjection>,
  snapshot: ResourceSnapshot,
  tips: readonly ResourceTip[],
): boolean {
  const current = projections[snapshot.resourceId];
  if (
    current !== undefined &&
    (current.semanticHash === snapshot.semanticHash ||
      current.retainedLocalHash === snapshot.semanticHash)
  ) {
    return rememberSnapshotSource(current, snapshot);
  }
  const matchingTip = tips
    .filter(
      (tip) =>
        tip.kind === snapshot.kind &&
        tip.operation === "put" &&
        tip.semanticHash === snapshot.semanticHash,
    )
    .sort(compareTips)[0];
  if (matchingTip === undefined) {
    return false;
  }
  const learned: LocalProjection = {
    resourceId: snapshot.resourceId,
    kind: matchingTip.kind,
    semanticHash: matchingTip.semanticHash,
    versionId: matchingTip.versionId,
    ...(matchingTip.payload === undefined
      ? {}
      : { payloadObjectId: matchingTip.payload.objectId }),
  };
  rememberSnapshotSource(learned, snapshot);
  projections[snapshot.resourceId] = learned;
  return true;
}

function rememberTemporarySnapshotProjection(
  projections: Record<string, LocalProjection>,
  snapshot: ResourceSnapshot,
): void {
  const previous = projections[snapshot.resourceId];
  projections[snapshot.resourceId] = {
    resourceId: snapshot.resourceId,
    kind: snapshot.kind,
    semanticHash: snapshot.semanticHash,
    versionId: previous?.versionId ?? null,
    ...(previous?.payloadObjectId === undefined
      ? {}
      : { payloadObjectId: previous.payloadObjectId }),
    ...(typeof snapshot.metadata?.lastUpdatedAt === "number"
      ? { sourceTimestamp: snapshot.metadata.lastUpdatedAt }
      : {}),
    ...(validFileSize(snapshot.metadata?.sourceFileSize)
      ? { sourceFileSize: snapshot.metadata.sourceFileSize }
      : {}),
    ...(validFileTime(snapshot.metadata?.sourceFileCtimeMs)
      ? { sourceFileCtimeMs: snapshot.metadata.sourceFileCtimeMs }
      : {}),
    ...(typeof snapshot.metadata?.bubbleCount === "number"
      ? { sourceBubbleCount: snapshot.metadata.bubbleCount }
      : {}),
    ...(typeof snapshot.metadata?.chatCoreHash === "string"
      ? { sourceChatCoreHash: snapshot.metadata.chatCoreHash }
      : {}),
    ...(typeof snapshot.metadata?.headerFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(snapshot.metadata.headerFingerprint)
      ? { sourceHeaderFingerprint: snapshot.metadata.headerFingerprint }
      : {}),
  };
}

/**
 * Copy-on-read projection view for bounded targeted scans. The state chat
 * adapter mutates only the handful of source hints it actually observes; a
 * full clone here made one queued chat allocate every historical projection.
 */
export function projectionOverlayForBoundedScan(
  projections: Readonly<Record<string, LocalProjection>>,
): Record<string, LocalProjection> {
  const overlay = Object.create(null) as Record<string, LocalProjection>;
  return new Proxy(overlay, {
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      if (Object.hasOwn(target, property)) {
        return target[property];
      }
      const source = projections[property];
      if (source === undefined) {
        return undefined;
      }
      const learned = { ...source };
      target[property] = learned;
      return learned;
    },
    has(target, property) {
      return (
        Reflect.has(target, property) ||
        (typeof property === "string" && projections[property] !== undefined)
      );
    },
    // Deliberately expose only touched entries. Targeted scans use exact ID
    // lookup and must not turn Object.keys/values into an O(total state) copy.
    ownKeys: (target) => Reflect.ownKeys(target),
    getOwnPropertyDescriptor(target, property) {
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}

function rememberSnapshotSource(
  projection: LocalProjection,
  snapshot: ResourceSnapshot,
): boolean {
  let changed = false;
  const capturedTimestamp = snapshot.metadata?.lastUpdatedAt;
  if (
    typeof capturedTimestamp === "number" &&
    Number.isFinite(capturedTimestamp)
  ) {
    if (projection.sourceTimestamp !== capturedTimestamp) {
      projection.sourceTimestamp = capturedTimestamp;
      changed = true;
    }
  } else if (
    projection.kind === "chat" &&
    capturedTimestamp === null &&
    projection.sourceTimestamp !== undefined
  ) {
    delete projection.sourceTimestamp;
    changed = true;
  }
  const capturedBubbleCount = snapshot.metadata?.bubbleCount;
  const capturedFileSize = snapshot.metadata?.sourceFileSize;
  const capturedFileCtimeMs = snapshot.metadata?.sourceFileCtimeMs;
  if (validFileSize(capturedFileSize) && validFileTime(capturedFileCtimeMs)) {
    if (projection.sourceFileSize !== capturedFileSize) {
      projection.sourceFileSize = capturedFileSize;
      changed = true;
    }
    if (projection.sourceFileCtimeMs !== capturedFileCtimeMs) {
      projection.sourceFileCtimeMs = capturedFileCtimeMs;
      changed = true;
    }
  }
  if (
    projection.kind === "chat" &&
    typeof capturedBubbleCount === "number" &&
    Number.isSafeInteger(capturedBubbleCount) &&
    capturedBubbleCount >= 0
  ) {
    if (projection.sourceBubbleCount !== capturedBubbleCount) {
      projection.sourceBubbleCount = capturedBubbleCount;
      changed = true;
    }
  }
  const capturedCoreHash = snapshot.metadata?.chatCoreHash;
  if (
    projection.kind === "chat" &&
    typeof capturedCoreHash === "string" &&
    /^[0-9a-f]{64}$/.test(capturedCoreHash)
  ) {
    if (projection.sourceChatCoreHash !== capturedCoreHash) {
      projection.sourceChatCoreHash = capturedCoreHash;
      changed = true;
    }
  }
  const capturedHeaderFingerprint = snapshot.metadata?.headerFingerprint;
  if (
    projection.kind === "chat" &&
    typeof capturedHeaderFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(capturedHeaderFingerprint)
  ) {
    if (projection.sourceHeaderFingerprint !== capturedHeaderFingerprint) {
      projection.sourceHeaderFingerprint = capturedHeaderFingerprint;
      changed = true;
    }
  }
  return changed;
}

function markProjection(
  repository: SyncRepository,
  projection: ResourceProjection,
  retainedLocal?: ResourceSnapshot,
  applyResult?: ResourceApplyResult,
): void {
  const tip = projection.tip;
  const previous = repository.state.projections[projection.resourceId];
  const retainedLocalHash =
    applyResult === undefined
      ? undefined
      : applyResult.semanticHash;
  // A tombstone for these kinds is honored by *keeping* the local copy, so the
  // projection has to carry a hash that stands for "what is still on disk".
  // `retainedLocal` only exists when the adapter emitted a snapshot this
  // cycle, which it does not for an unchanged chat and never for
  // workspaceStorage (that adapter is not scanned while Cursor runs). With the
  // field left unset the next scan saw a hash matching neither the projection
  // nor any tip and republished the resource, silently reverting the other
  // device's delete. The helper's markAppliedProjections has always carried
  // this fallback chain; the extension host now does too.
  const retainedTombstoneHash =
    ["chat", "chat-transcript", "chat-store", "workspace-storage"].includes(
      tip.kind,
    ) && tip.operation === "delete"
      ? retainedLocal?.semanticHash ??
        previous?.retainedLocalHash ??
        previous?.semanticHash ??
        sha256(`retained-local:${projection.resourceId}`)
      : undefined;
  repository.state.projections[projection.resourceId] = {
    resourceId: projection.resourceId,
    kind: tip.kind,
    semanticHash: tip.semanticHash,
    versionId: tip.versionId,
    ...(tip.payload === undefined
      ? {}
      : { payloadObjectId: tip.payload.objectId }),
    ...(retainedLocalHash !== undefined
      ? { retainedLocalHash }
      : retainedTombstoneHash === undefined
        ? {}
        : { retainedLocalHash: retainedTombstoneHash }),
    // Recorded beside the timestamp because for a chat the timestamp alone is
    // not a change signal; see LocalProjection.sourceBubbleCount.
    ...(typeof tip.metadata?.bubbleCount === "number"
      ? { sourceBubbleCount: tip.metadata.bubbleCount }
      : {}),
    ...(typeof tip.metadata?.lastUpdatedAt === "number"
      ? { sourceTimestamp: tip.metadata.lastUpdatedAt }
      : {}),
    ...(retainedLocal !== undefined &&
    validFileSize(retainedLocal.metadata?.sourceFileSize)
      ? { sourceFileSize: retainedLocal.metadata.sourceFileSize }
      : {}),
    ...(retainedLocal !== undefined &&
    validFileTime(retainedLocal.metadata?.sourceFileCtimeMs)
      ? { sourceFileCtimeMs: retainedLocal.metadata.sourceFileCtimeMs }
      : {}),
    ...(typeof tip.metadata?.chatCoreHash === "string" &&
    /^[0-9a-f]{64}$/.test(tip.metadata.chatCoreHash)
      ? { sourceChatCoreHash: tip.metadata.chatCoreHash }
      : {}),
    ...(typeof tip.metadata?.headerFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(tip.metadata.headerFingerprint)
      ? { sourceHeaderFingerprint: tip.metadata.headerFingerprint }
      : {}),
  };
  repository.state.pendingDatabaseChanges =
    repository.state.pendingDatabaseChanges.filter(
      (pending) =>
        pending.eventHash !== tip.eventHash ||
        pending.changeIndex !== tip.changeIndex,
    );
  projection.changed = false;
}

function validFileSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validFileTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The two reasons owned by {@link SyncManager.ensureWorkspaceMappings} rather
 * than by `resourceApplyBlockReason`.
 *
 * Whether an incoming workspaceStorage change has a local counterpart is an
 * answer only workspace discovery and the user's mapping list can give, and both
 * are asynchronous. `resourceApplyBlockReason` is synchronous and consulted once
 * per changed projection per cycle, so it deliberately does not know — which
 * makes these blocks something it must not overrule. See
 * {@link isWorkspaceMappingBlockReason}.
 *
 * The prefix is the stable part and the only thing recognition may depend on:
 * every release up to 0.0.42 wrote "…for incoming workspace storage." with no
 * follow-up sentence, and those entries are sitting in real repositories now.
 */
const WORKSPACE_MAPPING_BLOCK_PREFIX =
  "Workspace mapping is required for incoming";

export const WORKSPACE_MAPPING_BLOCK_REASON =
  `${WORKSPACE_MAPPING_BLOCK_PREFIX} workspace storage. ` +
  "An exact local workspace has not been verified on this computer; its workspace storage remains deferred while conversations continue independently. " +
  'To map it deliberately, open "Cursor Setting Sync: Manage" → "Repository & Devices…" → "Map Pending Workspaces…".';

const FOLDERLESS_WORKSPACE_BLOCK_REASON = PERMANENT_EXCLUSION_REASONS[3];

/**
 * Clears only the block owned by workspace mapping.
 *
 * Chat continuation completeness is independent of where the chat is stored.
 * The mapping pass used to delete that derived block for workspace-less,
 * unmapped, and successfully mapped chats immediately before persisting the
 * offline queue. Re-derive it here so every mapping-clear path has the same
 * fail-closed result.
 */
function clearWorkspaceMappingOwnedBlock(
  pending: PendingDatabaseChange,
  tip: ResourceTip,
): void {
  const current = pending.blockedReason;
  if (
    current !== undefined &&
    !current.startsWith(WORKSPACE_MAPPING_BLOCK_PREFIX) &&
    current !== FOLDERLESS_WORKSPACE_BLOCK_REASON &&
    current !== INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON
  ) {
    // Apply failures, live-payload failures and other owners survive a mapping
    // pass. Resolving a workspace must not silently re-offer a change whose
    // prior database write failed.
    return;
  }
  const continuationBlock = chatContinuationApplyBlockReason(tip);
  if (continuationBlock === undefined) {
    delete pending.blockedReason;
  } else {
    pending.blockedReason = continuationBlock;
  }
}

/**
 * True for a block the workspace-mapping pass set, which the per-cycle queueing
 * pass must leave alone.
 *
 * Without this the modal came back every thirty seconds, forever. The sequence:
 * `ensureWorkspaceMappings` blocks an unmappable change, so it leaves the batch
 * and the offer goes quiet — and then the next poll re-queues the same entry,
 * `resourceApplyBlockReason` reports "nothing wrong" because it cannot see
 * mappings, and {@link queuePending} deletes the block. The change is ready
 * again, the modal quits Cursor again, the helper skips it again ("workspace
 * mapping required", which does not mark it applied, so it stays queued), and
 * the whole thing repeats on every launch. The user's second computer sat in
 * exactly that cycle: one workspace-storage change, re-offered after every
 * restart, that no restart could ever write.
 */
function isWorkspaceMappingBlockReason(reason: string | undefined): boolean {
  if (reason === undefined) {
    return false;
  }
  // Matched on the PREFIX, never on the whole sentence. These reasons are
  // persisted in the repository state, so the strings this build compares
  // against are strings OLDER builds wrote — and 0.0.43 itself appended a
  // sentence to this one. Exact equality would have failed to recognize every
  // block written before the upgrade, un-blocked it on the first poll, and put
  // the very computer this was written for straight back into the loop. The
  // reason text is user-facing prose and will be reworded again; the prefix is
  // the part that identifies who owns the block.
  return (
    reason.startsWith(WORKSPACE_MAPPING_BLOCK_PREFIX) ||
    reason.startsWith(APPLY_FAILURE_BLOCK_PREFIX) ||
    reason.startsWith(LIVE_APPLY_PAYLOAD_BLOCK_PREFIX) ||
    reason === FOLDERLESS_WORKSPACE_BLOCK_REASON
  );
}

export function queuePending(
  repository: SyncRepository,
  projection: ResourceProjection,
  blockedReason?: string,
): boolean {
  const tip = projection.tip;
  const effectiveBlockedReason =
    blockedReason ?? chatContinuationApplyBlockReason(tip);
  if (
    isOfflineApplyExcludedIncomingResource(
      projection.resourceId,
      tip.kind,
      tip.metadata,
    )
  ) {
    // Never hand the helper a change it is only going to skip. Any entry an
    // earlier run of this build already queued is dropped here too, so an
    // existing repository stops asking for a restart that would do nothing.
    const before = repository.state.pendingDatabaseChanges.length;
    repository.state.pendingDatabaseChanges =
      repository.state.pendingDatabaseChanges.filter(
        (pending) =>
          pending.eventHash !== tip.eventHash ||
          pending.changeIndex !== tip.changeIndex,
      );
    return repository.state.pendingDatabaseChanges.length !== before;
  }
  const existing = repository.state.pendingDatabaseChanges.find(
    (pending) =>
      pending.eventHash === tip.eventHash &&
      pending.changeIndex === tip.changeIndex,
  );
  if (existing !== undefined) {
    if (effectiveBlockedReason === undefined) {
      // A workspace-mapping block outlives this pass; only the mapping pass
      // clears it, and it does so the moment the workspace resolves. See
      // isWorkspaceMappingBlockReason for what deleting it here used to cost.
      if (!isWorkspaceMappingBlockReason(existing.blockedReason)) {
        if (existing.blockedReason === undefined) {
          return false;
        }
        delete existing.blockedReason;
        return true;
      }
    } else {
      if (existing.blockedReason === effectiveBlockedReason) {
        return false;
      }
      existing.blockedReason = effectiveBlockedReason;
      return true;
    }
    return false;
  }
  repository.state.pendingDatabaseChanges.push({
    eventHash: tip.eventHash,
    changeIndex: tip.changeIndex,
    resourceId: projection.resourceId,
    kind: tip.kind,
    ...(effectiveBlockedReason === undefined
      ? {}
      : { blockedReason: effectiveBlockedReason }),
  });
  return true;
}

/**
 * Never materialize an ordinary cross-device chat before its continuation
 * graph is complete. A legacy/v1 or partial-v2 body can render perfectly while
 * Cursor rejects the very next prompt with `Conversation data missing`; the
 * complete child tip supersedes this blocked entry as soon as the source PC
 * publishes its hash-verified graph.
 *
 * Automatic message-body repair is deliberately exempt. It repairs a chat
 * that is already unavailable and the helper records a one-shot live graph
 * recapture request for that exact core.
 */
function prunePending(
  repository: SyncRepository,
  projections: ResourceProjection[],
): boolean {
  const active = new Set(
    projections.map(
      (projection) => `${projection.tip.eventHash}#${projection.tip.changeIndex}`,
    ),
  );
  const previous = repository.state.pendingDatabaseChanges;
  const retained = previous.filter((pending) =>
      active.has(`${pending.eventHash}#${pending.changeIndex}`),
    );
  if (retained.length === previous.length) {
    return false;
  }
  repository.state.pendingDatabaseChanges = retained;
  return true;
}

/**
 * What the extension-host handoff can carry, and what the helper reads itself.
 *
 * The batch limit exists so a single request cannot ask the helper to hold
 * half a gigabyte of payloads in memory at once, but a change that falls
 * outside it used to be dropped from the request without a word. The offline
 * helper now reconciles the durable queue and drains successive bounded pages
 * in the same run; the count remains useful for accurately describing that
 * work before Cursor closes.
 */
interface PendingHelperBatch {
  changes: HelperChange[];
  /** Applicable now, but outside the initial handoff page; this run drains them. */
  deferredForBatchLimit: number;
}

export function pendingHelperBatch(repository: SyncRepository): PendingHelperBatch {
  const changes: HelperChange[] = [];
  let totalBytes = 0;
  let deferredForBatchLimit = 0;
  for (const pending of repository.state.pendingDatabaseChanges) {
      if (pending.blockedReason !== undefined) {
        continue;
      }
      const tip = findTip(
        repository,
        pending.resourceId,
        pending.eventHash,
        pending.changeIndex,
      );
      if (tip === undefined) {
        continue;
      }
      if (chatContinuationApplyBlockReason(tip) !== undefined) {
        // A stale state file from an older build can still contain an
        // unblocked v1/partial-v2 entry. This last gate keeps it out of the
        // offline helper even before the next normal reconciliation rewrites
        // its queued block reason.
        continue;
      }
      // Last gate before the helper. `queuePending` already refuses these, but
      // a repository written by an earlier build can still hold the entry.
      if (
        isOfflineApplyExcludedIncomingResource(
          pending.resourceId,
          tip.kind,
          tip.metadata,
        )
      ) {
        continue;
      }
      const payloadBytes = tip.payload?.plainBytes ?? 0;
      if (
        changes.length >= 256 ||
        (payloadBytes <= MAX_HELPER_APPLY_WORK_BYTES &&
          totalBytes + payloadBytes > MAX_HELPER_APPLY_WORK_BYTES)
      ) {
        // Counted rather than silently skipped: the caller says so, while the
        // offline helper reads it from the durable queue on a later page in
        // this same run.
        deferredForBatchLimit += 1;
        continue;
      }
      const change: HelperChange = {
        eventHash: tip.eventHash,
        changeIndex: tip.changeIndex,
        sourceDeviceId: tip.deviceId,
        resourceId: pending.resourceId,
        kind: tip.kind,
        operation: tip.operation,
        semanticHash: tip.semanticHash,
      };
      if (tip.payload !== undefined) {
        change.payload = tip.payload;
      }
      if (tip.metadata !== undefined) {
        change.metadata = tip.metadata;
      }
      changes.push(change);
      // A single authenticated oversized object is deliberately included so
      // the helper can turn it into a visible per-resource blocked failure
      // without reading the payload. Aggregate overflow alone is deferred.
      if (payloadBytes <= MAX_HELPER_APPLY_WORK_BYTES) {
        totalBytes += payloadBytes;
      }
  }
  return { changes, deferredForBatchLimit };
}

function pendingLastUpdatedAt(
  repository: SyncRepository,
  pending: PendingDatabaseChange,
): number {
  const lastUpdatedAt = findTip(
    repository,
    pending.resourceId,
    pending.eventHash,
    pending.changeIndex,
  )?.metadata?.lastUpdatedAt;
  return typeof lastUpdatedAt === "number" ? lastUpdatedAt : 0;
}

function findTip(
  repository: SyncRepository,
  resourceId: string,
  eventHash: string,
  changeIndex: number,
): ResourceTip | undefined {
  return repository.state.tips[resourceId]?.find(
    (tip) => tip.eventHash === eventHash && tip.changeIndex === changeIndex,
  );
}

/**
 * Resolves what can be resolved without asking, and never throws for one
 * conflict it could not publish.
 *
 * This runs before the scan, the publish batch and applyProjections, so an
 * escaping error aborts the entire cycle: nothing published, nothing inbound
 * applied, no ack written. The events are immutable, so the next poll would
 * re-derive the identical conflict and throw again — the device would stop
 * synchronizing permanently. A three-way merge is the union of both sides'
 * additions and is routinely LARGER than either tip, so two individually
 * publishable tips really can merge into a payload `publish` rejects. Anything
 * that cannot be published degrades to manual resolution: the conflict is left
 * unresolved and `onWarning` names the resource.
 *
 * A conflict with no common ancestor cannot be three-way merged, but it is not
 * therefore unresolvable — see {@link resolveBaseFreeConflict}.
 */
export async function autoMergeConflicts(
  repository: SyncRepository,
  conflicts: SyncConflict[],
  canMerge: (tips: ResourceTip[]) => boolean = () => true,
  onWarning: (warning: string) => void = () => {},
): Promise<boolean> {
  let mergedAny = false;
  for (const conflict of conflicts) {
    // Nothing one conflict does may end the cycle. This function runs before
    // the scan, the publish and applyProjections, so an escaping error means
    // nothing published, nothing inbound applied and no ack written - and
    // because the events are immutable the next poll rebuilds the identical
    // conflict and throws again, permanently. Every failure mode reachable
    // here was meant to be handled below; this is the guard for the ones that
    // were not, and 0.0.6 shipped exactly such a case (a RangeError out of the
    // base64 validator on a multi-megabyte chat payload).
    try {
      if (conflict.resolvedAt !== undefined) {
        continue;
      }
      const tips = repository.state.tips[conflict.resourceId] ?? [];
      if (tips.length < 2 || !canMerge(tips)) {
        continue;
      }
      if (
        conflict.kind === "ui-state" &&
        (tips.length > 2 ||
          isPolicyExcludedUiStateResource(conflict.resourceId, conflict.kind))
      ) {
        // Two escapes that share one answer, last-writer-wins:
        // - A fork with THREE or more tips (several windows or machines each
        //   published a merge of a different pair) has no three-way shape, so
        //   the two-tip machinery below skipped it forever - and an
        //   unresolved conflict refuses every checkpoint, so the repository
        //   could never prune again.
        // - A policy-excluded key (the reactive-storage blob) is churn no
        //   side should win on merit; re-merging it against a peer still
        //   publishing it re-derived the fork every cycle. One LWW
        //   resolution ends the chain: the scan never publishes the key
        //   again, and the apply side accepts the resolution without
        //   writing it.
        if (await resolveBaseFreeConflict(repository, conflict, tips, onWarning)) {
          conflict.resolvedAt = new Date().toISOString();
          mergedAny = true;
        }
        continue;
      }
      if (tips.length !== 2 || conflict.tipVersionIds.length !== 2) {
        continue;
      }
      if (conflict.baseVersionId === null) {
        // No common ancestor, so no three-way merge is possible — but a
        // last-writer-wins pick never needed one. Skipping these outright left
        // every base-free fork unresolved forever: the user's live repository
        // carried 23 of them, all ui-state, all re-prompting on every cycle.
        if (await resolveBaseFreeConflict(repository, conflict, tips, onWarning)) {
          conflict.resolvedAt = new Date().toISOString();
          mergedAny = true;
        }
        continue;
      }
      const autoMergeWorkBudget = Math.min(
        repository.maxPayloadBytes,
        CHAT_AUTO_MERGE_MAX_WORK_BYTES,
      );
      const workspaceDatabase =
        conflict.kind === "workspace-storage" &&
        isWorkspaceDatabaseTipMetadata(tips[0]?.metadata);
      const notepads =
        conflict.kind === "workspace-storage" &&
        isNotepadsTipMetadata(tips[0]?.metadata);
      const allTipsArePuts = tips.every((tip) => tip.operation === "put");
      const structuralThreeWay =
        allTipsArePuts &&
        (workspaceDatabase ||
          notepads ||
          isAutoMergeKind(conflict.kind, tips[0]?.metadata));
      // Every based conflict is classified from the authenticated manifest
      // record first. Unsupported authored kinds used to decrypt a potentially
      // 512 MiB base on every cycle only to discover below that they had no
      // automatic merge policy at all.
      const baseMetadata = await repository.tryReadVersionMetadata(
        conflict.baseVersionId,
      );
      if (
        baseMetadata === null ||
        baseMetadata.change.resourceId !== conflict.resourceId ||
        baseMetadata.change.kind !== conflict.kind
      ) {
        if (structuralThreeWay) {
          warnAutoMergeWorkDeferred(
            conflict.resourceId,
            autoMergeWorkBudget,
            onWarning,
          );
        }
        continue;
      }
      const trivialSurvivor = findTrivialConflictSurvivor(
        tips,
        baseMetadata.change,
      );
      if (
        trivialSurvivor !== undefined &&
        isProtectedTrivialConflictSurvivor(trivialSurvivor)
      ) {
        continue;
      }
      if (
        trivialSurvivor?.operation === "put" &&
        !declaredAutoMergeWorkFits(
          [trivialSurvivor],
          0,
          autoMergeWorkBudget,
        )
      ) {
        // Trivial means no structural parse is necessary, but the survivor is
        // still materialized and republished. Apply the same authenticated
        // fixed bound before that read; otherwise a base reassertion beside a
        // 512 MiB ordinary survivor bypasses the interactive merge budget.
        warnAutoMergeWorkDeferred(
          conflict.resourceId,
          autoMergeWorkBudget,
          onWarning,
        );
        continue;
      }
      if (
        await resolveTrivialConflict(
          repository,
          conflict,
          tips,
          baseMetadata.change,
          onWarning,
        )
      ) {
        mergedAny = true;
        continue;
      }
      if (!structuralThreeWay) {
        continue;
      }
      const basePlainBytes = baseMetadata.change.payload?.plainBytes;
      if (
        baseMetadata.change.operation !== "put" ||
        basePlainBytes === undefined ||
        !declaredAutoMergeWorkFits(
          tips,
          basePlainBytes,
          autoMergeWorkBudget,
        )
      ) {
        warnAutoMergeWorkDeferred(
          conflict.resourceId,
          autoMergeWorkBudget,
          onWarning,
        );
        continue;
      }
      // Only supported, aggregate-bounded structural merges reach payload
      // materialization. Reads stay sequential and the three retained buffers
      // together are bounded by the authenticated plaintext sum above.
      const base = await repository.tryReadVersion(conflict.baseVersionId);
      if (base === null || base.content === null) {
        warnAutoMergeWorkDeferred(
          conflict.resourceId,
          autoMergeWorkBudget,
          onWarning,
        );
        continue;
      }
      const localTip =
        tips.find((tip) => tip.deviceId === repository.state.device.deviceId) ??
        tips[0];
      const remoteTip = tips.find((tip) => tip.versionId !== localTip?.versionId);
      if (localTip === undefined || remoteTip === undefined) {
        continue;
      }
      // Keep only the first materialized tip beside the base while the second
      // is decrypted. Chat's declared aggregate was bounded above; other kinds
      // also avoid a needless simultaneous decompression burst.
      const local = await repository.readVersion(localTip.versionId);
      const remote = await repository.readVersion(remoteTip.versionId);
      if (
        base.content === null ||
        local.content === null ||
        remote.content === null
      ) {
        continue;
      }
      // Replicated tip order, newest first: the one ordering of the two sides
      // that does not depend on which device is running this.
      const orderedTips = [...tips].sort(compareTips);
      const newestTip = orderedTips[0];
      const contentOf = (tip: ResourceTip): Buffer =>
        tip.versionId === localTip.versionId
          ? (local.content as Buffer)
          : (remote.content as Buffer);
      const olderTip = orderedTips[1];
      const jsoncMerge = isJsonMergeKind(
        conflict.kind,
        localTip.metadata,
      );
      const textMerge =
        conflict.kind !== "chat" &&
        conflict.kind !== "remote-targets" &&
        !workspaceDatabase &&
        !notepads &&
        conflict.kind !== "ui-state" &&
        !jsoncMerge;
      if (
        textMerge &&
        !buffersFitAutoMergeLineBudget([
          base.content,
          local.content,
          remote.content,
        ])
      ) {
        warnAutoMergeWorkDeferred(
          conflict.resourceId,
          autoMergeWorkBudget,
          onWarning,
        );
        continue;
      }
      const structuralJsonBuffers =
        conflict.kind === "remote-targets"
          ? [local.content, remote.content]
          : notepads || conflict.kind === "ui-state" || jsoncMerge
            ? [base.content, local.content, remote.content]
            : undefined;
      if (
        structuralJsonBuffers !== undefined &&
        !buffersFitAutoMergeJsonStructureBudget(structuralJsonBuffers)
      ) {
        warnAutoMergeWorkDeferred(
          conflict.resourceId,
          autoMergeWorkBudget,
          onWarning,
        );
        continue;
      }
      const chatOutcome =
        conflict.kind === "chat" &&
        newestTip !== undefined &&
        olderTip !== undefined
            ? mergeChatSnapshotBuffers(base.content, [
              contentOf(newestTip),
              contentOf(olderTip),
            ], autoMergeWorkBudget)
          : undefined;
      if (chatOutcome?.workBudgetExceeded === true) {
        warnAutoMergeWorkDeferred(
          conflict.resourceId,
          autoMergeWorkBudget,
          onWarning,
        );
      }
      // chat is its own branch rather than a `??` in front of the chain, so it
      // can never reach the diff3 fallback: a line-based merge of two chat
      // snapshots can produce syntactically valid JSON that describes a
      // conversation neither device has.
      // notepads takes the newest/older ordering rather than local/remote for
      // the same reason chat does: the merge has a preferred side, and reading
      // it off `localTip` would make the two computers prefer each other and
      // publish two different "resolutions" of one fork.
      const notepadOutcome =
        notepads && newestTip !== undefined && olderTip !== undefined
          ? mergeNotepadBuffers(
              base.content,
              contentOf(newestTip),
              contentOf(olderTip),
            )
          : undefined;
      // Union, not election: a folder one computer has opened on a host and
      // the other has not is a fact about the server, not a disagreement. The
      // newest tip only decides the order the tree shows.
      const remoteTargetsOutcome =
        conflict.kind === "remote-targets" &&
        newestTip !== undefined &&
        olderTip !== undefined
          ? mergeRemoteTargetsBuffers(
              contentOf(newestTip),
              contentOf(olderTip),
            )
          : undefined;
      const outcome: MergeOutcome =
        conflict.kind === "chat"
          ? chatOutcome ?? { status: "conflict" }
          : conflict.kind === "remote-targets"
            ? remoteTargetsOutcome ?? { status: "conflict" }
            : notepads
            ? notepadOutcome ?? { status: "conflict" }
            : workspaceDatabase
              ? mergeWorkspaceDatabaseBuffers(
                  base.content,
                  local.content,
                  remote.content,
                  autoMergeWorkBudget,
                )
              : conflict.kind === "ui-state"
                ? mergeUiStateBuffers(base.content, local.content, remote.content)
                : jsoncMerge
                  ? mergeJsoncBuffers(base.content, local.content, remote.content)
                  : validatedTextMergeOutcome(
                      conflict.kind,
                      mergeTextBuffers(base.content, local.content, remote.content),
                    );
      if (
        "workBudgetExceeded" in outcome &&
        outcome.workBudgetExceeded === true
      ) {
        warnAutoMergeWorkDeferred(
          conflict.resourceId,
          autoMergeWorkBudget,
          onWarning,
        );
      }
      // A ui-state value with no structural merge still resolves without asking:
      // both devices sort the same two tips with the same replicated comparator,
      // so both republish the same side's bytes and the reconciler collapses the
      // two merge events. This last-writer-wins step is deliberately restricted
      // to ui-state, where the value is machine-local chrome that Cursor rewrites
      // continuously and where the manual resolver could only ever have offered
      // the same whole-tip either/or. It must never reach a kind whose loser
      // holds authored content — cursor-user-rules, settings, chat.
      const lastWriter =
        conflict.kind === "ui-state" && outcome.status === "conflict"
          ? newestTip
          : undefined;
      const resolved: MergeOutcome =
        lastWriter === undefined
          ? outcome
          : {
              status: "merged",
              content:
                lastWriter.versionId === localTip.versionId
                  ? local.content
                  : remote.content,
            };
      if (
        resolved.status === "conflict" ||
        resolved.content === undefined
      ) {
        continue;
      }
      if (resolved.content.byteLength > autoMergeWorkBudget) {
        warnAutoMergeWorkDeferred(
          conflict.resourceId,
          autoMergeWorkBudget,
          onWarning,
        );
        continue;
      }
      // The merged content is a deterministic function of the tips, and the
      // metadata has to be one too. `localTip` is whichever tip this device
      // happens to own, so using it made two devices attach DIFFERENT metadata to
      // byte-identical content; the reconciler collapses those two events on
      // operation plus semanticHash alone, and an arbitrary tip pick then decided
      // ui-state's `valueType` — the storage class the helper binds, TEXT or BLOB
      // — for both devices. Every candidate below is elected the same way on every
      // device: `newestTip` from the replicated comparator, and the chat winner
      // from `lastUpdatedAt` inside the two payloads both devices read.
      const metadataTip =
        chatOutcome?.winner === undefined
          ? lastWriter ?? newestTip ?? localTip
          : orderedTips[chatOutcome.winner] ?? newestTip ?? localTip;
      const mergedMetadata =
        conflict.kind === "chat"
          ? chatMetadataForExactPayload(
              metadataTip.metadata,
              resolved.content,
            )
          : { ...(metadataTip.metadata ?? {}) };
      const snapshot: ResourceSnapshot = {
        resourceId: conflict.resourceId,
        kind: conflict.kind,
        content: resolved.content,
        semanticHash: resolved.semanticHash ?? sha256(resolved.content),
        metadata: {
          ...mergedMetadata,
          // The union of both sides' bubbles is what was published, so the count
          // that travels with it has to describe the union, not the winner.
          ...(chatOutcome?.bubbleCount === undefined
            ? {}
            : { bubbleCount: chatOutcome.bubbleCount }),
          // Same reasoning for the size workspace-storage carries: a merge is
          // routinely larger than either side, so inheriting the winner's byte
          // count would describe a payload nobody published. Only overridden
          // where the scan sets it, so no other kind gains a field.
          ...(typeof metadataTip.metadata?.["plainBytes"] === "number"
            ? { plainBytes: resolved.content.byteLength }
            : {}),
          syncOrigin: "auto-merge",
        },
      };
      if (
        !(await publishAutoMerge(repository, conflict, [snapshot], [], onWarning))
      ) {
        continue;
      }
      conflict.resolvedAt = new Date().toISOString();
      mergedAny = true;
    } catch (error) {
      onWarning(
        `The automatic merge of ${conflict.resourceId} failed (${
          error instanceof Error ? error.message : String(error)
        }), so the conflict is waiting for "Cursor Setting Sync: Manage" → "Resolve Conflicts".`,
      );
      continue;
    }
  }
  return mergedAny;
}

/**
 * Kinds whose base-free forks are resolved by last-writer-wins instead of being
 * left for the user.
 *
 * A conflict with no common ancestor cannot be three-way merged, but picking a
 * winner never required a base.
 *
 * ui-state is here because a ui-state value is machine-local chrome — a
 * timestamp, a health-check result, a panel position — that Cursor rewrites on
 * its own on both machines, so the losing side costs a piece of layout state
 * that the next interaction regenerates.
 *
 * Every kind that carries something the user authored (`cursor-user-rules`,
 * `settings`, `cursor-user-file`, `chat`, ...) is absent on purpose: there,
 * silently discarding the losing tip destroys content, and an unresolved
 * conflict is the correct outcome. chat reaches an automatic resolution by a
 * different route — {@link resolveBaseFreeChatConflict} combines the two sides
 * instead of electing between them — and falls back to asking, not to an
 * election, when it cannot.
 */
const BASE_FREE_LAST_WRITER_KINDS: readonly ResourceKind[] = ["ui-state"];

/**
 * Resolves a base-free chat fork by merging the two snapshots structurally.
 *
 * A chat is the one content-bearing kind whose payload can be combined rather
 * than chosen between: the conversation lives in keyed `bubbleId:` rows, so the
 * union of both sides keeps every message either device captured, and no side
 * has to be discarded for the conflict to clear. See
 * {@link mergeChatSnapshotBuffers} for the election and ordering rules.
 *
 * The live repository that prompted this carried 36 base-free chat forks, 32 of
 * which held the same conversation on both sides — identical bubble counts and
 * identical `lastUpdatedAt` — and differed only in machine-local header fields.
 * Asking a person to adjudicate those was the bug.
 *
 * Returns false — never throws — when either payload is unreadable or is not a
 * snapshot this build can parse. The conflict then stays unresolved rather than
 * falling back to an election that would throw a side away.
 */
async function resolveBaseFreeChatConflict(
  repository: SyncRepository,
  conflict: SyncConflict,
  orderedPuts: readonly ResourceTip[],
  onWarning: (warning: string) => void,
): Promise<boolean> {
  const [first, second] = orderedPuts;
  if (first === undefined || second === undefined) {
    return false;
  }
  const workBudget = Math.min(
    repository.maxPayloadBytes,
    CHAT_AUTO_MERGE_MAX_WORK_BYTES,
  );
  // ResourceTip carries the authenticated plaintext length. Reject the pair
  // before decrypting either object: two individually publishable near-limit
  // tips must not become a 256 MiB interactive extension-host spike.
  if (!declaredAutoMergeWorkFits([first, second], 0, workBudget)) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  const firstData = await repository.tryReadVersion(first.versionId);
  const secondData = await repository.tryReadVersion(second.versionId);
  if (
    firstData === null ||
    secondData === null ||
    firstData.content === null ||
    secondData.content === null
  ) {
    return false;
  }
  const outcome = mergeChatSnapshotBuffers(null, [
    firstData.content,
    secondData.content,
  ], workBudget);
  if (outcome.workBudgetExceeded === true) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
  }
  if (outcome.content === undefined || outcome.winner === undefined) {
    return false;
  }
  const winnerTip = outcome.winner === 0 ? first : second;
  return publishAutoMerge(
    repository,
    conflict,
    [
      {
        resourceId: conflict.resourceId,
        kind: conflict.kind,
        content: outcome.content,
        semanticHash: outcome.semanticHash ?? sha256(outcome.content),
        metadata: {
          ...chatMetadataForExactPayload(
            winnerTip.metadata,
            outcome.content,
          ),
          ...(outcome.bubbleCount === undefined
            ? {}
            : { bubbleCount: outcome.bubbleCount }),
          syncOrigin: "auto-merge",
        },
      },
    ],
    [],
    onWarning,
  );
}

/**
 * Rebuilds every chat-format metadata field from the exact bytes being
 * published by an automatic merge.
 *
 * A v2 merge can upgrade a v1 winner, materialize one side's missing blob, or
 * add a reference carried only by the other side. Inheriting the winner's
 * schema/count/core fields therefore describes a payload that was never
 * published; most importantly, a stale missing count of zero suppresses the
 * bounded enrichment pass forever. Non-format metadata such as workspaceUri
 * is retained from the deterministic winner.
 */
function chatMetadataForExactPayload(
  inherited: Record<string, JsonValue> | undefined,
  content: Buffer,
): Record<string, JsonValue> {
  const snapshot = parsePortableChatSnapshot(content);
  const metadata: Record<string, JsonValue> = { ...(inherited ?? {}) };
  for (const key of [
    "composerId",
    "workspaceId",
    "lastUpdatedAt",
    "bubbleCount",
    "title",
    "chatCoreHash",
    "chatSnapshotSchemaVersion",
    "agentKvBlobCount",
    "agentKvReferencedCount",
    "agentKvMissingCount",
  ]) {
    delete metadata[key];
  }
  metadata.composerId = snapshot.composerId;
  metadata.workspaceId = snapshot.header.workspaceId;
  metadata.lastUpdatedAt = snapshot.header.lastUpdatedAt;
  metadata.bubbleCount = snapshot.bubbles.length;
  metadata.chatCoreHash = portableChatCoreHash(snapshot);
  metadata.chatSnapshotSchemaVersion = snapshot.schemaVersion;
  if (isPortableChatSnapshotV2(snapshot)) {
    metadata.agentKvBlobCount = snapshot.agentKv.blobs.length;
    metadata.agentKvReferencedCount = snapshot.agentKv.referencedIds.length;
    metadata.agentKvMissingCount = snapshot.agentKv.missingIds.length;
  }
  const title = chatHeaderTitle(snapshot.header.value);
  if (title !== null) {
    metadata.title = title;
  }
  return metadata;
}

/**
 * Resolves a base-free workspace-database fork by unioning the two snapshots.
 *
 * The union is computed with the replicated-newest tip preferred, so both
 * machines produce byte-identical bytes and the reconciler collapses their
 * two merge events into one. Returns false - never throws - when either
 * payload is unreadable or is not a snapshot this build can parse, leaving
 * the conflict for the manual resolver rather than inventing a result.
 */
async function resolveBaseFreeWorkspaceDatabaseConflict(
  repository: SyncRepository,
  conflict: SyncConflict,
  orderedPuts: readonly ResourceTip[],
  onWarning: (warning: string) => void,
): Promise<boolean> {
  const [newest, older] = orderedPuts;
  if (newest === undefined || older === undefined) {
    return false;
  }
  const workBudget = Math.min(
    repository.maxPayloadBytes,
    CHAT_AUTO_MERGE_MAX_WORK_BYTES,
  );
  if (!declaredAutoMergeWorkFits([newest, older], 0, workBudget)) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  const newestData = await repository.tryReadVersion(newest.versionId);
  const olderData = await repository.tryReadVersion(older.versionId);
  if (
    newestData === null ||
    olderData === null ||
    newestData.content === null ||
    olderData.content === null
  ) {
    return false;
  }
  let content: Buffer;
  try {
    const limits = {
      maxPlainBytes: workBudget,
      maxRows: AUTO_MERGE_MAX_STRUCTURAL_ROWS,
    };
    content = serializeWorkspaceDatabaseSnapshot(
      unionWorkspaceDatabaseSnapshots(
        parseWorkspaceDatabaseSnapshot(newestData.content, limits),
        parseWorkspaceDatabaseSnapshot(olderData.content, limits),
        limits,
      ),
      limits,
    );
  } catch (error) {
    // A payload this build cannot read - a future schema, a snapshot for a
    // different workspace - stays a conflict instead of losing a side.
    if (isWorkspaceDatabaseMergeBudgetError(error)) {
      warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    }
    return false;
  }
  if (content.byteLength > workBudget) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  return publishAutoMerge(
    repository,
    conflict,
    [
      {
        resourceId: conflict.resourceId,
        kind: conflict.kind,
        content,
        semanticHash: sha256(content),
        metadata: {
          ...(newest.metadata ?? {}),
          plainBytes: content.byteLength,
          syncOrigin: "auto-merge",
        },
      },
    ],
    [],
    onWarning,
  );
}

/**
 * Resolves a base-free SSH-targets fork by unioning both computers' host and
 * folder lists. See {@link mergeRemoteTargetsBuffers}.
 */
async function resolveBaseFreeRemoteTargetsConflict(
  repository: SyncRepository,
  conflict: SyncConflict,
  orderedPuts: readonly ResourceTip[],
  onWarning: (warning: string) => void,
): Promise<boolean> {
  const [newest, older] = orderedPuts;
  if (newest === undefined || older === undefined) {
    return false;
  }
  const workBudget = Math.min(
    repository.maxPayloadBytes,
    CHAT_AUTO_MERGE_MAX_WORK_BYTES,
  );
  if (!declaredAutoMergeWorkFits([newest, older], 0, workBudget)) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  const newestData = await repository.tryReadVersion(newest.versionId);
  const olderData = await repository.tryReadVersion(older.versionId);
  if (
    newestData === null ||
    olderData === null ||
    newestData.content === null ||
    olderData.content === null
  ) {
    return false;
  }
  if (
    !buffersFitAutoMergeJsonStructureBudget([
      newestData.content,
      olderData.content,
    ])
  ) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  const outcome = mergeRemoteTargetsBuffers(
    newestData.content,
    olderData.content,
  );
  if (outcome.status !== "merged" || outcome.content === undefined) {
    return false;
  }
  const content = outcome.content;
  if (content.byteLength > workBudget) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  return publishAutoMerge(
    repository,
    conflict,
    [
      {
        resourceId: conflict.resourceId,
        kind: conflict.kind,
        content,
        semanticHash: outcome.semanticHash ?? sha256(content),
        metadata: { ...(newest.metadata ?? {}), syncOrigin: "auto-merge" },
      },
    ],
    [],
    onWarning,
  );
}

/**
 * Resolves a base-free `notepads.json` fork by unioning the two lists by
 * notepad id. See {@link unionNotepadBuffers} for the per-notepad rules.
 *
 * Returns false — never throws — when either payload is unreadable or is not a
 * list this build can key. The conflict then stays unresolved rather than
 * electing one whole file and discarding the other's notepads.
 */
async function resolveBaseFreeNotepadsConflict(
  repository: SyncRepository,
  conflict: SyncConflict,
  orderedPuts: readonly ResourceTip[],
  onWarning: (warning: string) => void,
): Promise<boolean> {
  const [newest, older] = orderedPuts;
  if (newest === undefined || older === undefined) {
    return false;
  }
  const workBudget = Math.min(
    repository.maxPayloadBytes,
    CHAT_AUTO_MERGE_MAX_WORK_BYTES,
  );
  if (!declaredAutoMergeWorkFits([newest, older], 0, workBudget)) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  const newestData = await repository.tryReadVersion(newest.versionId);
  const olderData = await repository.tryReadVersion(older.versionId);
  if (
    newestData === null ||
    olderData === null ||
    newestData.content === null ||
    olderData.content === null
  ) {
    return false;
  }
  if (
    !buffersFitAutoMergeJsonStructureBudget([
      newestData.content,
      olderData.content,
    ])
  ) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  const outcome = unionNotepadBuffers(newestData.content, olderData.content);
  if (outcome.status !== "merged" || outcome.content === undefined) {
    return false;
  }
  const content = outcome.content;
  if (content.byteLength > workBudget) {
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  return publishAutoMerge(
    repository,
    conflict,
    [
      {
        resourceId: conflict.resourceId,
        kind: conflict.kind,
        content,
        semanticHash: outcome.semanticHash ?? sha256(content),
        metadata: {
          ...(newest.metadata ?? {}),
          plainBytes: content.byteLength,
          syncOrigin: "auto-merge",
        },
      },
    ],
    [],
    onWarning,
  );
}

/**
 * Resolves a fork with no common ancestor by republishing the winning tip
 * verbatim.
 *
 * Both devices see the same two tips and sort them with the same replicated
 * comparator ({@link compareTips}: Lamport, then deviceId, then eventHash), so
 * both elect the same winner, republish that tip's own bytes under that tip's
 * own `semanticHash`, and carry that tip's own metadata. Byte-identical content
 * AND identical metadata is the requirement, not a nicety: the reconciler
 * collapses two tips on operation plus semanticHash alone, so a device-dependent
 * metadata pick would leave ui-state's `valueType` — the storage class
 * `uiStateValue` binds, TEXT or BLOB — decided by whichever device published
 * last.
 *
 * Put-vs-delete rule: **a put always beats a delete, whatever the comparator
 * says**; the comparator only breaks ties within the surviving operation. This
 * mirrors `chooseActiveTip`, which already prefers puts when it elects the
 * active tip, and it is the recoverable direction — a losing delete just means
 * the key is written back and the deleting side can remove it again, while a
 * losing put destroys the only copy of the value. Two deletes are ordered by
 * the comparator like any other pair.
 */
async function resolveBaseFreeConflict(
  repository: SyncRepository,
  conflict: SyncConflict,
  tips: ResourceTip[],
  onWarning: (warning: string) => void,
): Promise<boolean> {
  const puts = tips.filter((tip) => tip.operation === "put");
  // A chat is combined, never chosen between: it takes the structural path or
  // no automatic path at all. It is deliberately not in
  // BASE_FREE_LAST_WRITER_KINDS, so a payload the merge cannot read — a future
  // schema, a composer row whose ID is not a UUID — stays a conflict instead of
  // silently losing a side.
  if (conflict.kind === "chat") {
    return (
      puts.length === 2 &&
      puts.length === tips.length &&
      (await resolveBaseFreeChatConflict(
        repository,
        conflict,
        [...puts].sort(compareTips),
        onWarning,
      ))
    );
  }
  // A workspace database is combined for the same reason a chat is: its rows
  // are keyed, so two machines meeting for the first time can keep every row
  // either of them has. Without this, the first sync between two computers
  // raised one manual conflict for EVERY workspace both had open, and the
  // only answer the manual resolver could offer - one whole snapshot or the
  // other - discarded the losing machine's notepads and sessions outright.
  if (
    conflict.kind === "workspace-storage" &&
    isWorkspaceDatabaseTipMetadata(tips[0]?.metadata)
  ) {
    return (
      puts.length === 2 &&
      puts.length === tips.length &&
      (await resolveBaseFreeWorkspaceDatabaseConflict(
        repository,
        conflict,
        [...puts].sort(compareTips),
        onWarning,
      ))
    );
  }
  // notepads.json is the same shape of problem one level up: a JSON array keyed
  // by notepad id, so first contact between two computers keeps every notepad
  // either of them wrote instead of asking a person to pick one file and lose
  // the other's notes wholesale.
  if (
    conflict.kind === "workspace-storage" &&
    isNotepadsTipMetadata(tips[0]?.metadata)
  ) {
    return (
      puts.length === 2 &&
      puts.length === tips.length &&
      (await resolveBaseFreeNotepadsConflict(
        repository,
        conflict,
        [...puts].sort(compareTips),
        onWarning,
      ))
    );
  }
  // First contact between two computers that already reach the same servers:
  // each has its own folder history and neither descends from the other, so
  // the union is the whole answer and nothing has to be discarded.
  if (conflict.kind === "remote-targets") {
    return (
      puts.length === 2 &&
      puts.length === tips.length &&
      (await resolveBaseFreeRemoteTargetsConflict(
        repository,
        conflict,
        [...puts].sort(compareTips),
        onWarning,
      ))
    );
  }
  if (!BASE_FREE_LAST_WRITER_KINDS.includes(conflict.kind)) {
    return false;
  }
  const winner = [...(puts.length > 0 ? puts : tips)].sort(compareTips)[0];
  if (winner === undefined) {
    return false;
  }
  const metadata = { ...(winner.metadata ?? {}), syncOrigin: "auto-merge" };
  if (winner.operation === "delete") {
    return publishAutoMerge(
      repository,
      conflict,
      [],
      [
        {
          resourceId: conflict.resourceId,
          kind: conflict.kind,
          semanticHash: winner.semanticHash,
          metadata,
        },
      ],
      onWarning,
    );
  }
  const workBudget = Math.min(
    repository.maxPayloadBytes,
    CHAT_AUTO_MERGE_MAX_WORK_BYTES,
  );
  if (!declaredAutoMergeWorkFits([winner], 0, workBudget)) {
    // This path also handles ui-state conflicts with three or more tips. Only
    // the elected winner is materialized, but without a per-winner gate one
    // ordinary 512 MiB PUT still blocks the shared extension host.
    warnAutoMergeWorkDeferred(conflict.resourceId, workBudget, onWarning);
    return false;
  }
  // A payload compacted out from under the winner degrades to manual
  // resolution rather than resolving to the loser, which would not be the
  // same answer on a device that can still read it.
  const data = await repository.tryReadVersion(winner.versionId);
  if (data === null || data.content === null) {
    return false;
  }
  return publishAutoMerge(
    repository,
    conflict,
    [
      {
        resourceId: conflict.resourceId,
        kind: conflict.kind,
        content: data.content,
        semanticHash: winner.semanticHash,
        metadata,
      },
    ],
    [],
    onWarning,
  );
}

/**
 * Publishes one auto-merge result, or explains why it could not and leaves the
 * conflict for the manual resolver. Returns false without throwing in both
 * failure cases.
 */
async function publishAutoMerge(
  repository: SyncRepository,
  conflict: SyncConflict,
  snapshots: ResourceSnapshot[],
  deletions: ResourceDeletion[],
  onWarning: (warning: string) => void,
): Promise<boolean> {
  for (const snapshot of snapshots) {
    if (snapshot.content.byteLength > repository.maxPayloadBytes) {
      onWarning(
        `${oversizedPayloadWarning(
          conflict.resourceId,
          snapshot.content.byteLength,
          repository.maxPayloadBytes,
        )} The automatic merge of ${conflict.resourceId} produced more than ` +
          'either side did, so the conflict is waiting for "Cursor Setting ' +
          'Sync: Manage" → "Resolve Conflicts".',
      );
      return false;
    }
  }
  try {
    await repository.publish(snapshots, deletions);
    return true;
  } catch (error) {
    onWarning(
      `The automatic merge of ${conflict.resourceId} could not be published (${
        error instanceof Error ? error.message : String(error)
      }), so the conflict is waiting for "Cursor Setting Sync: Manage" → "Resolve Conflicts".`,
    );
    return false;
  }
}

async function resolveTrivialConflict(
  repository: SyncRepository,
  conflict: SyncConflict,
  tips: ResourceTip[],
  base: ResourceChange,
  onWarning: (warning: string) => void,
): Promise<boolean> {
  const survivor = findTrivialConflictSurvivor(tips, base);
  if (survivor === undefined) {
    return false;
  }
  if (isProtectedTrivialConflictSurvivor(survivor)) {
    // Republishing a helper recipe as an ordinary auto-merge launders away
    // the source/provenance fields that make additive repair, blob-only
    // enrichment and version restore safe. Leave the authenticated survivor
    // available to the manual resolver instead.
    return false;
  }
  if (survivor.operation === "put") {
    const data = await repository.tryReadVersion(survivor.versionId);
    if (data === null || data.content === null) {
      return false;
    }
    if (
      !(await publishAutoMerge(
        repository,
        conflict,
        [
          {
            resourceId: conflict.resourceId,
            kind: conflict.kind,
            content: data.content,
            semanticHash: survivor.semanticHash,
            metadata: {
              ...(survivor.metadata ?? {}),
              syncOrigin: "auto-merge",
            },
          },
        ],
        [],
        onWarning,
      ))
    ) {
      return false;
    }
  } else if (
    !(await publishAutoMerge(
      repository,
      conflict,
      [],
      [
        {
          resourceId: conflict.resourceId,
          kind: conflict.kind,
          semanticHash: survivor.semanticHash,
          metadata: {
            ...(survivor.metadata ?? {}),
            syncOrigin: "auto-merge",
          },
        },
      ],
      onWarning,
    ))
  ) {
    return false;
  }
  conflict.resolvedAt = new Date().toISOString();
  return true;
}

function findTrivialConflictSurvivor(
  tips: readonly ResourceTip[],
  base: ResourceChange,
): ResourceTip | undefined {
  const matching = tips.filter(
    (tip) =>
      tip.operation === base.operation &&
      tip.semanticHash === base.semanticHash,
  );
  return matching.length === 1
    ? tips.find((tip) => tip !== matching[0])
    : undefined;
}

function isProtectedTrivialConflictSurvivor(survivor: ResourceTip): boolean {
  const survivorOrigin = effectiveSyncOrigin(survivor.metadata);
  return (
    survivor.metadata?.syncOrigin === "checkpoint-marker" ||
    survivorOrigin === "automatic-chat-repair" ||
    survivorOrigin === "agent-kv-enrichment" ||
    survivorOrigin === "version-restore"
  );
}

function declaredAutoMergeWorkFits(
  tips: readonly ResourceTip[],
  alreadyMaterializedBytes: number,
  workBudget: number,
): boolean {
  if (
    !Number.isSafeInteger(alreadyMaterializedBytes) ||
    alreadyMaterializedBytes < 0 ||
    alreadyMaterializedBytes > workBudget
  ) {
    return false;
  }
  let remaining = workBudget - alreadyMaterializedBytes;
  for (const tip of tips) {
    const plainBytes = tip.payload?.plainBytes;
    if (
      tip.operation !== "put" ||
      plainBytes === undefined ||
      !Number.isSafeInteger(plainBytes) ||
      plainBytes < 0 ||
      plainBytes > remaining
    ) {
      return false;
    }
    remaining -= plainBytes;
  }
  return true;
}

/** Map/Set/sort object work can amplify tiny structural rows far beyond JSON bytes. */
const AUTO_MERGE_MAX_STRUCTURAL_ROWS = 16_384;
const AUTO_MERGE_MAX_LINE_OCCURRENCES = 65_536;

/** Counts line-split work without allocating strings or an array of lines. */
function buffersFitAutoMergeLineBudget(buffers: readonly Buffer[]): boolean {
  let remaining = AUTO_MERGE_MAX_LINE_OCCURRENCES;
  for (const buffer of buffers) {
    // `split("\n")` creates one element even when no newline is present.
    if (remaining <= 0) {
      return false;
    }
    remaining -= 1;
    for (const byte of buffer) {
      if (byte !== 0x0a) {
        continue;
      }
      if (remaining <= 0) {
        return false;
      }
      remaining -= 1;
    }
  }
  return true;
}

/**
 * Bounds JSON/JSONC object work before `toString`, parse, recursive merge and
 * Map/Set/sort allocation. Counting punctuation outside strings and comments
 * also counts every item in a minified array through its commas, so a small
 * byte payload cannot turn into millions of JS nodes. The scan is allocation-
 * free and shared across every input retained by one interactive merge.
 */
function buffersFitAutoMergeJsonStructureBudget(
  buffers: readonly Buffer[],
): boolean {
  return buffersFitJsonStructureBudget(buffers, { allowComments: true });
}

function warnAutoMergeWorkDeferred(
  resourceId: string,
  workBudget: number,
  onWarning: (warning: string) => void,
): void {
  onWarning(
    `The automatic merge of ${resourceId} exceeded the bounded ${formatBytes(
      workBudget,
    )} interactive merge budget (or lacked a trustworthy declared payload size), so no over-budget result was published.${
      workBudget < CHAT_AUTO_MERGE_MAX_WORK_BYTES
        ? " Increase cursorSettingSync.maxPayloadMiB only if you intend to allow larger per-resource work; the fixed interactive cap still applies."
        : ""
    } The conflict is waiting for "Cursor Setting Sync: Manage" → "Resolve Conflicts".`,
  );
}

function isWorkspaceDatabaseTipMetadata(
  metadata: ResourceTip["metadata"],
): boolean {
  const relativePath = metadata?.relativePath;
  return (
    typeof relativePath === "string" &&
    isWorkspaceStateDatabasePath(relativePath)
  );
}

function isNotepadsTipMetadata(metadata: ResourceTip["metadata"]): boolean {
  const relativePath = metadata?.relativePath;
  return (
    typeof relativePath === "string" && isWorkspaceNotepadsPath(relativePath)
  );
}

interface PreparedRecoveryResources {
  readonly resources: readonly vscode.Uri[];
  readonly primaryResource: vscode.Uri;
  readonly remoteStaging: RecoveryStagingResult | null;
}

async function prepareRecoveryResources(
  workspaceUri: vscode.Uri,
  localPaths: readonly string[],
  stagingSources: readonly RecoveryStagingSource[],
): Promise<PreparedRecoveryResources | null> {
  if (workspaceUri.scheme === "file") {
    const resources = localPaths.map((path) => vscode.Uri.file(path));
    const primaryResource = resources[0];
    if (primaryResource === undefined) {
      throw new Error("The verified recovery artifact has no transcript.");
    }
    return { resources, primaryResource, remoteStaging: null };
  }

  const selected = await vscode.window.showOpenDialog({
    // The extension runs in the local UI host. Supplying the recovered
    // workspace URI is what selects the remote filesystem provider instead of
    // opening a native local file dialog. A second modal protects against
    // accidentally keeping the chosen destination inside the workspace.
    defaultUri: workspaceUri,
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Choose Remote Staging Folder",
    title: "Choose a Remote Recovery Staging Folder",
  });
  const selectedRemoteBaseUri = selected?.[0];
  if (selectedRemoteBaseUri === undefined) {
    return null;
  }
  if (
    selected?.length !== 1 ||
    selectedRemoteBaseUri.scheme !== workspaceUri.scheme ||
    selectedRemoteBaseUri.authority !== workspaceUri.authority
  ) {
    await vscode.window.showWarningMessage(
      `The selected folder is not on the recovered workspace's exact remote authority (${workspaceUri.scheme}://${workspaceUri.authority}). No recovery files were copied, no Agent was created, and nothing was attached or sent.`,
    );
    return null;
  }

  const sourceBytes = stagingSources.reduce((total, source) => {
    if (
      !Number.isSafeInteger(source.byteLength) ||
      source.byteLength < 0 ||
      total > Number.MAX_SAFE_INTEGER - source.byteLength
    ) {
      throw new Error("Recovery staging source bytes are invalid.");
    }
    return total + source.byteLength;
  }, 0);
  const stage = "Stage Recovery Files";
  const confirmation = await vscode.window.showWarningMessage(
    `Copy exactly ${sourceBytes} bytes (${formatBytes(sourceBytes)}) of verified recovery source data as plaintext to remote authority ${JSON.stringify(selectedRemoteBaseUri.authority)} under path ${JSON.stringify(selectedRemoteBaseUri.path)}? Choose a private remote folder whose permissions you trust: this extension cannot verify or enforce remote permissions or ACLs, and any account or process with access to that path may read the copies.`,
    {
      modal: true,
      detail:
        "Cursor Setting Sync will create one new isolated recovery subfolder containing content-addressed transcript and PNG files, START-HERE.md, and a small ownership record. The plaintext may contain source code or secrets and remains on that remote host until you explicitly delete the staging folder. The remote provider controls permissions and ACLs; the extension cannot make the selected parent private. Only START-HERE.md and the transcript will be attached to a new Agent; no prompt is sent, this extension does not rewrite the original conversation, and Cursor may persist the newly opened empty Agent.",
    },
    stage,
  );
  if (confirmation !== stage) {
    return null;
  }

  if (remoteFolderIsInsideOpenWorkspace(selectedRemoteBaseUri)) {
    const insideWorkspace = "Stage inside workspace anyway";
    const insideConfirmation = await vscode.window.showWarningMessage(
      `The selected remote folder ${JSON.stringify(selectedRemoteBaseUri.path)} is inside an open workspace. Recovery plaintext could be indexed, committed, or read by workspace tools.`,
      {
        modal: true,
        detail:
          "Choose this only if you accept storing the recovery transcript and selected images inside the workspace. Nothing has been written yet.",
      },
      insideWorkspace,
    );
    if (insideConfirmation !== insideWorkspace) {
      return null;
    }
  }

  let remoteStaging: RecoveryStagingResult;
  try {
    remoteStaging = await stageRecoveryArtifacts({
      workspaceUri,
      selectedRemoteBaseUri,
      sources: stagingSources,
      bridge: createRecoveryStagingBridge(),
    });
  } catch (error) {
    const possibleDirectory =
      error instanceof RecoveryStagingError
        ? error.possiblyWrittenDirectory
        : null;
    const retention =
      possibleDirectory === null
        ? ""
        : ` Plaintext or a bounded partial file may remain on remote authority ${JSON.stringify(possibleDirectory.authority)} under path ${JSON.stringify(possibleDirectory.path)}; inspect that exact path before deleting it.`;
    await vscode.window.showWarningMessage(
      `Remote recovery staging failed before an Agent was created: ${recoveryCatalogErrorMessage(error)}.${retention} Nothing was attached or sent, and this extension did not write Cursor's database.`,
    );
    return null;
  }
  const resources = remoteStaging.agentResources.map((resource) =>
    vscode.Uri.parse(resource.toString(), true),
  );
  const primaryResource = resources[0];
  if (primaryResource === undefined) {
    throw new Error("Remote recovery staging returned no start document.");
  }
  return { resources, primaryResource, remoteStaging };
}

function createRecoveryStagingBridge(): RecoveryStagingBridge {
  return {
    joinPath: (base, ...segments) =>
      vscode.Uri.joinPath(vscode.Uri.parse(base.toString(), true), ...segments),
    stat: async (uri) => {
      const result = await vscode.workspace.fs.stat(toVscodeUri(uri));
      return { kind: recoveryStagingFileKind(result.type), size: result.size };
    },
    createDirectory: async (uri) => {
      await vscode.workspace.fs.createDirectory(toVscodeUri(uri));
    },
    readFile: async (uri) => vscode.workspace.fs.readFile(toVscodeUri(uri)),
    writeFile: async (uri, bytes) => {
      await vscode.workspace.fs.writeFile(toVscodeUri(uri), bytes);
    },
    rename: async (source, target, options) => {
      await vscode.workspace.fs.rename(
        toVscodeUri(source),
        toVscodeUri(target),
        options,
      );
    },
    delete: async (uri, options) => {
      await vscode.workspace.fs.delete(toVscodeUri(uri), options);
    },
    readDirectory: async (uri) =>
      (await vscode.workspace.fs.readDirectory(toVscodeUri(uri))).map(
        ([name, type]) => ({ name, kind: recoveryStagingFileKind(type) }),
      ),
  };
}

async function reverifyRemoteStagingBeforeAgent(
  staging: RecoveryStagingResult,
): Promise<boolean> {
  try {
    await verifyStagedRecovery(staging, createRecoveryStagingBridge());
    return true;
  } catch (error) {
    await vscode.window.showWarningMessage(
      `The remote recovery staging files changed or failed final read-back verification. No Agent was created and nothing was attached or sent. Inspect the exact remote directory at ${JSON.stringify(staging.directory.path)} on authority ${JSON.stringify(staging.directory.authority)} before deleting it. ${recoveryCatalogErrorMessage(error)}`,
    );
    return false;
  }
}

function toVscodeUri(uri: RecoveryStagingUri): vscode.Uri {
  return vscode.Uri.parse(uri.toString(), true);
}

function recoveryStagingFileKind(
  type: vscode.FileType,
): "file" | "directory" | "symbolic-link" | "other" {
  if ((type & vscode.FileType.SymbolicLink) !== 0) {
    return "symbolic-link";
  }
  if ((type & vscode.FileType.File) !== 0) {
    return "file";
  }
  if ((type & vscode.FileType.Directory) !== 0) {
    return "directory";
  }
  return "other";
}

function remoteFolderIsInsideOpenWorkspace(selected: vscode.Uri): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some(({ uri }) => {
    if (
      uri.scheme !== selected.scheme ||
      uri.authority !== selected.authority
    ) {
      return false;
    }
    const rootPath = uri.path.replace(/\/+$/u, "") || "/";
    const selectedPath = selected.path.replace(/\/+$/u, "") || "/";
    return (
      selectedPath === rootPath ||
      (rootPath === "/"
        ? selectedPath.startsWith("/")
        : selectedPath.startsWith(`${rootPath}/`))
    );
  });
}

function remoteStagingRetention(result: RecoveryStagingResult | null): string {
  return result === null
    ? ""
    : ` The remote plaintext staging directory on authority ${JSON.stringify(result.directory.authority)} at path ${JSON.stringify(result.directory.path)} remains until you explicitly delete it.`;
}

function stagingSourcesForVisibleArtifact(
  artifact: VisibleChatRecoveryArtifact,
  transcriptByteLength: number,
): RecoveryStagingSource[] {
  return [
    {
      kind: "transcript",
      localPath: artifact.path,
      sha256: artifact.transcriptHash,
      byteLength: transcriptByteLength,
      mimeType: "text/markdown",
    },
    ...artifact.imageAttachments.map((image) => ({
      kind: "image" as const,
      localPath: image.path,
      sha256: image.hash,
      byteLength: image.byteLength,
      mimeType: "image/png" as const,
    })),
  ];
}

function stagingSourcesForCatalogEntry(
  entry: RecoveryCatalogReadyEntry,
  paths: readonly string[],
): RecoveryStagingSource[] {
  const transcriptPath = paths[0];
  if (transcriptPath === undefined) {
    throw new Error("The verified recovery catalog entry has no transcript.");
  }
  if (paths.length !== entry.artifact.images.length + 1) {
    throw new Error("The recovery catalog artifact list is inconsistent.");
  }
  return [
    {
      kind: "transcript",
      localPath: transcriptPath,
      sha256: entry.artifact.transcript.sha256,
      byteLength: entry.artifact.transcript.byteLength,
      mimeType: "text/markdown",
    },
    ...entry.artifact.images.map((image, index) => {
      const localPath = paths[index + 1];
      if (localPath === undefined) {
        throw new Error("The recovery catalog image list is inconsistent.");
      }
      return {
        kind: "image" as const,
        localPath,
        sha256: image.sha256,
        byteLength: image.byteLength,
        mimeType: "image/png" as const,
      };
    }),
  ];
}

function matchingOpenWorkspaceUri(expected: string | null): vscode.Uri | null {
  if (expected === null) {
    return null;
  }
  let expectedUri: vscode.Uri;
  try {
    expectedUri = vscode.Uri.parse(expected, true);
  } catch {
    return null;
  }
  return (
    (vscode.workspace.workspaceFolders ?? []).find((folder) =>
      workspaceUriMatchesAny(
        expectedUri.toString(),
        [folder.uri.toString()],
      ),
    )?.uri ?? null
  );
}

function mergeWorkspaceDatabaseBuffers(
  base: Buffer,
  local: Buffer,
  remote: Buffer,
  workBudget: number,
): MergeOutcome & { workBudgetExceeded?: true } {
  try {
    const limits = {
      maxPlainBytes: workBudget,
      maxRows: AUTO_MERGE_MAX_STRUCTURAL_ROWS,
    };
    // All three sides drop non-portable rows before the walk. A base or tip an
    // older build published still carries machine chrome, and against a
    // filtered tip every such row would read as a deletion - one side changing
    // it becomes a concurrent-delete conflict this merge exists to avoid.
    const merged = mergeWorkspaceDatabaseSnapshots(
      filterPortableWorkspaceRows(
        parseWorkspaceDatabaseSnapshot(base, limits),
      ),
      filterPortableWorkspaceRows(
        parseWorkspaceDatabaseSnapshot(local, limits),
      ),
      filterPortableWorkspaceRows(
        parseWorkspaceDatabaseSnapshot(remote, limits),
      ),
      limits,
    );
    if (merged.status !== "merged" || merged.snapshot === undefined) {
      return { status: "conflict" };
    }
    return {
      status: "merged",
      content: serializeWorkspaceDatabaseSnapshot(merged.snapshot, limits),
    };
  } catch (error) {
    // Unparseable or mismatched snapshots fall back to manual resolution.
    return isWorkspaceDatabaseMergeBudgetError(error)
      ? { status: "conflict", workBudgetExceeded: true }
      : { status: "conflict" };
  }
}

function isWorkspaceDatabaseMergeBudgetError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("exceeds the row limit") ||
      error.message.includes("exceeds the payload limit") ||
      error.message.includes("exceeds configured limits"))
  );
}

function isAutoMergeKind(
  kind: ResourceKind,
  metadata: ResourceTip["metadata"],
): boolean {
  // keybindings.json is a top-level JSON array, which merges better line-based
  // than atomically, so it takes the diff3 text path and not the JSON path.
  //
  // ui-state is here but cursor-user-rules is not, even though one adapter
  // produces both. A ui-state value is UI chrome — pinned view containers,
  // hidden views, MRU caches — that Cursor rewrites on its own on both
  // machines, so a wrong merge costs a panel in the wrong place and is undone
  // the next time the user drags something. cursor-user-rules is prose the
  // user typed; a wrong merge there destroys authored content, so it keeps
  // asking.
  //
  // chat is here for the opposite reason to ui-state: not because losing a side
  // is cheap, but because no side has to be lost. Its merge unions the keyed
  // `bubbleId:` rows, so it is the one content-bearing kind where an automatic
  // resolution keeps every message both devices captured.
  if (
    [
      "snippet",
      "task",
      "mcp",
      "prompt",
      "chat",
      "chat-transcript",
      "keybindings",
      "ui-state",
      // Unioned rather than merged textually; see mergeRemoteTargetsBuffers.
      "remote-targets",
    ].includes(kind)
  ) {
    return true;
  }
  if (kind === "cursor-user-file") {
    const relativePath = metadata?.relativePath;
    return typeof relativePath === "string" && !/\.(png|jpe?g|gif|webp|zip|gz)$/i.test(relativePath);
  }
  return false;
}

export function validatedTextMergeOutcome(
  kind: ResourceKind,
  outcome: MergeOutcome,
): MergeOutcome {
  // keybindings.json must stay parseable JSONC even though it merges on the
  // text path; diff3 can splice a clean merge into syntactically invalid
  // JSONC, which every device would then fail to apply.
  if (
    kind !== "keybindings" ||
    outcome.status === "conflict" ||
    outcome.content === undefined
  ) {
    return outcome;
  }
  try {
    parseJsonc(outcome.content.toString("utf8"), kind);
  } catch {
    return { status: "conflict" };
  }
  return outcome;
}

function isJsonMergeKind(
  kind: ResourceKind,
  metadata: ResourceTip["metadata"],
): boolean {
  if (["snippet", "task", "mcp"].includes(kind)) {
    return true;
  }
  if (kind === "cursor-user-file") {
    const relativePath = metadata?.relativePath;
    return typeof relativePath === "string" && /\.jsonc?$/i.test(relativePath);
  }
  return false;
}
