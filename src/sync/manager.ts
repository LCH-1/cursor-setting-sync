import { basename, isAbsolute, join, relative } from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import * as vscode from "vscode";
import {
  AUTOMATIC_CHECKPOINT_COOLDOWN_MS,
  AUTOMATIC_CHECKPOINT_EVENT_THRESHOLD,
  BACKUP_DIRECTORY,
  COMMAND_LOCK_WAIT_MS,
  CONFLICT_APPLY_LOCK_WAIT_MS,
  CONFLICTED_REPUBLISH_INTERVAL_MS,
  LOCK_SKIP_REMINDER_MS,
  MAX_APPLY_BATCH_BYTES,
  QUIT_START_GRACE_MS,
  REPOSITORY_FILE,
  RESTART_TO_APPLY_COMMAND,
  RESTART_TO_APPLY_TITLE,
  SYNC_INDICATOR_DELAY_MS,
} from "../constants";
import type {
  AbsorbedCheckpoint,
  CompatibilityReport,
  DiagnosticSnapshot,
  EventProducer,
  LocalProjection,
  MergeOutcome,
  PendingDatabaseChange,
  RepositoryFile,
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
  copyFileAtomic,
  directorySize,
  ensureDirectory,
  isMissingPathError,
  listFilesRecursively,
  pathExists,
  readJsonFile,
} from "../platform/files";
import {
  acquireFileLock,
  acquireFileLockWithin,
  reportLockHolder,
} from "../platform/lock";
import type { FileLock, LockHolderReport } from "../platform/lock";
import {
  GitError,
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
import { SyncRepository } from "../protocol/repository";
import type {
  CheckpointCreateResult,
  PruneResult,
} from "../protocol/repository";
import {
  EventReconciler,
  compareTips,
  parentsForLocalChange,
  type ResourceProjection,
} from "../protocol/reconciler";
import type {
  ResourceAdapter,
  ResourceApplyInput,
  ResourceApplyResult,
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
  isPolicyExcludedUiStateKey,
  normalizeIgnoredUiStateKeys,
} from "../resources/uiStatePolicy";
import {
  ExtensionsAdapter,
  createExtensionIgnoreMatcher,
} from "../resources/extensions";
import {
  WorkspaceStorageAdapter,
  isIgnoredWorkspaceUri,
  isWorkspaceStateDatabasePath,
} from "../resources/workspaceStorage";
import {
  createIgnoreMatcher,
  type IgnoreMatcher,
} from "../resources/ignorePatterns";
import { StateVscdbChatAdapter } from "../chat/stateVscdb";
import { mergeChatSnapshotBuffers } from "../chat/chatMerge";
import { ChatTranscriptsAdapter } from "../chat/transcripts";
import { StoreDbChatAdapter } from "../chat/storeDb";
import {
  discoverWorkspaces,
  resolveTargetWorkspace,
} from "../chat/workspace";
import { HelperLauncher } from "../helper/launcher";
import type { HelperSyncOptions } from "../helper/launcher";
import type { HelperRequest } from "../helper/types";
import type { DatabaseContract } from "../helper/database";
import type { HelperChange, HelperResult } from "../helper/types";
import {
  mergeWorkspaceDatabaseSnapshots,
  parseWorkspaceDatabaseSnapshot,
  serializeWorkspaceDatabaseSnapshot,
} from "../helper/workspaceDatabaseMerge";
import type { StatusController, SyncStatus } from "../ui/status";
import type {
  ConflictController,
  ConflictResolutionResult,
} from "../ui/conflicts";
import { mergeJsoncBuffers, parseJsonc } from "../resources/jsonc";
import { mergeTextBuffers } from "../resources/text";
import { sha256 } from "../protocol/canonical";
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
import {
  isChatResourceKind,
  resourceConfigurationBlockReason,
} from "./resourcePolicy";

const LAST_HELPER_BACKUPS_KEY = "lastHelperBackups";

interface StoredHelperBackup {
  backupPath: string;
  contract: DatabaseContract;
  targetPath: string;
  recordedAt: string;
}

export interface AdapterScanIndex {
  snapshots: Map<string, ResourceSnapshot>;
  deletions: Map<string, ResourceDeletion>;
}

export type SyntheticApplyDecision =
  | { action: "apply" }
  | { action: "already-applied"; live: ResourceSnapshot }
  | { action: "drift" };

export class SyncManager implements vscode.Disposable {
  private repository: SyncRepository | null = null;
  private masterKey: Buffer | null = null;
  private adapters: ResourceAdapter[] = [];
  private repositoryWatcher: RepositoryWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private chatPollTimer: NodeJS.Timeout | null = null;
  private watcherDebounce: NodeJS.Timeout | null = null;
  private syncPromise: Promise<void> | null = null;
  private readonly pendingSyncScopes = new Set<SyncScope>();
  private pendingManualSync = false;
  private readonly helper: HelperLauncher;
  private readonly producer: EventProducer;
  private readonly historyDocuments = new Map<string, string>();
  private readonly historyPreviewRegistration: vscode.Disposable;
  private readonly gitWarningsShown = new Set<GitErrorKind>();
  private readonly warnings = new StandingWarningRegistry();
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
  private automaticMaintenanceAt = 0;
  private maintenanceRequested = false;
  private largeFileCheckAt = 0;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly paths: CursorPaths,
    private readonly compatibility: CompatibilityReport,
    private readonly configuration: ExtensionConfiguration,
    private readonly status: StatusController,
    private readonly conflicts: ConflictController,
  ) {
    this.helper = new HelperLauncher(paths, compatibility);
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
    await this.openConfiguredRepository(masterKey);
    if (!this.configuration.enabled) {
      // Configured, unlocked, and deliberately paused. Leaving the constructor
      // default in place made the status bar read "Setup" on every restart and
      // sent a click into the first-run wizard.
      this.status.setStatus("disabled");
      return;
    }
    await this.syncNow(false);
    await this.startFinalizer();
    this.startWatching();
  }

  async configurationChanged(): Promise<void> {
    this.refreshAdapters();
    if (this.repository !== null) {
      this.syncRepositoryLimit(this.repository);
    }
    if (!this.configuration.enabled) {
      this.disposeRuntime();
      await this.helper.cancelFinalizers();
      this.status.setStatus("disabled");
      return;
    }
    await this.startFinalizer();
    this.startWatching();
    await this.syncNow(false);
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

    this.disposeRuntime();
    this.masterKey?.fill(0);
    try {
      this.repository = await this.withProgress(
        "Cursor Setting Sync: Setup",
        async (report) => {
          report(
            exists
              ? "Unlocking the repository (deriving the encryption key)..."
              : "Creating the repository (deriving the encryption key)...",
          );
          return exists
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
              );
        },
      );
    } catch (error) {
      // Leaving the git shell behind would make the folder non-empty, so a
      // retry could never reach the storage-mode picker again.
      if (preparedGitRoot !== null) {
        await rm(join(preparedGitRoot, ".git"), {
          recursive: true,
          force: true,
        });
      }
      throw error;
    }
    this.masterKey = Buffer.from(this.repository.masterKey);
    await this.configuration.setRepository(
      root,
      this.repository.repository.repositoryId,
      this.masterKey,
    );
    this.refreshAdapters();
    await this.withProgress("Cursor Setting Sync: Setup", async (report) => {
      if (await this.gitModeFor(root)) {
        report("Committing the initial repository...");
        await this.commitGitWindow(true, root, "initial sync repository");
      }
      report("Scanning local resources and synchronizing...");
      await this.syncNow(true);
      report("Preparing the offline helper...");
      await this.startFinalizer();
    });
    this.startWatching();
    const configured =
      'Cursor Setting Sync is configured. The check mark confirms a local shared-folder write, not OneDrive cloud upload completion. The encrypted sync set includes ~/.cursor/mcp.json and cli-config.json, which may contain API keys - add them to "cursorSettingSync.ignoredUserFiles" to keep them on this device only.';
    // Also to the channel: the offer below can quit Cursor within seconds, and
    // this notice names files that may carry API keys.
    this.status.log(configured);
    void vscode.window.showInformationMessage(configured);
    await this.offerFirstApply();
  }

  /**
   * Offers the apply straight after setup, so joining is one flow.
   *
   * A computer that has just joined necessarily has a full queue - extensions,
   * profiles, chats and UI state all arrive at once, and none of them can be
   * written while Cursor runs. Ending setup with a toast and leaving the user
   * to discover a second command is the friction people report: they set the
   * thing up, nothing appears, and nothing says why.
   *
   * Deliberately not called from anywhere else. `setup()` is also the documented
   * way to unlock an established device, and on that device the queue is the
   * ordinary flow of incoming chats rather than a one-time cost of joining.
   */
  private async offerFirstApply(): Promise<void> {
    const repository = this.repository;
    if (repository === null) {
      return;
    }
    const pending = repository.state.pendingDatabaseChanges.filter(
      (change) => change.blockedReason === undefined,
    );
    if (pending.length === 0) {
      return;
    }
    const action = "Apply now";
    const choice = await vscode.window.showWarningMessage(
      `${pending.length} change(s) from your other computers (${summarizePendingKinds(pending)}) are waiting. ` +
        "They live in databases Cursor keeps open, so they can only be written while it is closed: choosing to apply saves your editors, quits Cursor, writes them and reopens it. " +
        "A large queue may need more than one pass; the status bar says so if any remain. You can also do this later from the status bar.",
      { modal: true },
      action,
    );
    if (choice !== action) {
      return;
    }
    // Delegated rather than inlined so this shares the workspace mapping, the
    // quit-stall warning and the finalizer re-arm with the command itself.
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
    await this.withProgress("Cursor Setting Sync: Setup", async (report) => {
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

  /** The `cursorSync.syncNow` command: a manual sync with visible progress. */
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
        'Cursor Setting Sync is not connected to a repository, so there is nothing to disconnect. Run "Cursor Setting Sync: Setup" to connect one.',
      );
      return;
    }
    const proceed = "Disconnect";
    const confirmed = await vscode.window.showWarningMessage(
      `Stop synchronizing with ${this.configuration.repositoryPath}? The shared folder and its history are left untouched; this device forgets the repository, its encryption key and its workspace mappings. Run Setup again to reconnect.`,
      { modal: true },
      proceed,
    );
    if (confirmed !== proceed) {
      return;
    }
    // Stop the timers first, then let an in-flight cycle finish before the
    // repository is dropped. Tearing down underneath it would publish into the
    // shared folder after the user was told this device had disconnected.
    this.disposeRuntime();
    try {
      await this.syncPromise;
    } catch {
      // A failing final cycle has already recorded its own error; it must not
      // block the disconnect the user asked for.
    }
    await this.helper.cancelFinalizers();
    this.repository = null;
    this.masterKey?.fill(0);
    this.masterKey = null;
    this.adapters = [];
    this.warnings.clear();
    await this.configuration.clearRepository();
    this.status.setStatus("unconfigured");
    this.status.log("Disconnected from the synchronization repository.");
    void vscode.window.showInformationMessage(
      "Cursor Setting Sync is disconnected. Run \"Cursor Setting Sync: Setup\" to connect again.",
    );
  }

  async syncNow(
    manual = true,
    scope: SyncScope = "all",
  ): Promise<void> {
    this.pendingSyncScopes.add(scope);
    this.pendingManualSync ||= manual;
    if (this.syncPromise === null) {
      this.syncPromise = this.drainSyncQueue().finally(() => {
        this.syncPromise = null;
      });
    }
    await this.syncPromise;
  }

  private async drainSyncQueue(): Promise<void> {
    while (this.pendingSyncScopes.size > 0) {
      const scope = mergeSyncScopes(this.pendingSyncScopes);
      const manual = this.pendingManualSync;
      this.pendingSyncScopes.clear();
      this.pendingManualSync = false;
      await this.performSync(manual, scope);
    }
    // Outside the cycle, because the maintenance phases take the same lock the
    // cycle holds.
    await this.runRequestedMaintenance();
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
      repository.state.pendingDatabaseChanges.length > 0 ||
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

  async restartToApply(): Promise<void> {
    const repository = this.requireRepository();
    const masterKey = this.requireMasterKey();
    assertCompatibleForDatabaseWrite(this.compatibility);
    await this.syncNow(true);
    // The sync above releases the lock, so this races the background cycle for
    // it a moment later - which is how the command the user asked for failed
    // with "another Cursor window is synchronizing" about this window's own
    // poll. Waiting is shown rather than silent, because it can take a cycle.
    const lock = await this.withProgress(
      RESTART_TO_APPLY_TITLE,
      async (report) => this.takeCommandLock(report),
    );
    let changes: HelperChange[];
    try {
      await this.openGitWindow(repository);
      await repository.refreshState();
      await this.applyPendingRunningResources(repository);
      await this.ensureWorkspaceMappings(repository);
      changes = pendingHelperChanges(repository);
    } finally {
      await lock.release();
    }
    if (changes.length === 0) {
      const blocked = repository.state.pendingDatabaseChanges.filter(
        (change) => change.blockedReason !== undefined,
      );
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
    // The retry the failure asked for is under way, so the red bar has served
    // its purpose; leaving it latched would outlive the thing it described.
    // Cleared here rather than on entry because everything above can throw or
    // return early, and a burnt latch would hide a failure still in force.
    this.helperFailure = null;
    await this.helper.applyAndRestart(
      this.configuration.repositoryPath ?? repository.root,
      masterKey,
      changes,
      this.configuration.workspaceMappings,
      this.helperSyncOptions(),
      async () => {
        // The quit was vetoed, so the helper is about to give up and write a
        // failure nobody would otherwise read until the next launch. The
        // consume is best-effort because `scheduleQuitVetoCheck` invokes this
        // with `void`: a throw here would go unhandled AND cost the session its
        // shutdown export, which is the only workspaceStorage backup there is.
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
            // The window may be mid-teardown; the output-channel line above is
            // the durable record either way.
          },
        );
      },
    );
  }

  async resolveConflicts(): Promise<void> {
    const repository = this.requireRepository();
    const refreshLock = await this.takeCommandLock();
    try {
      await this.openGitWindow(repository);
      await repository.refreshState();
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
          const result = reconciler.reconcile(
            await repository.listEvents(),
            repository.state,
            await absorbedCheckpointManifest(repository),
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

  async restoreVersion(): Promise<void> {
    const repository = this.requireRepository();
    const refreshLock = await this.takeCommandLock();
    try {
      await this.openGitWindow(repository);
      await repository.refreshState();
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
    const resourceItems = resourceIds.map((resourceId) => {
      const kind =
        repository.state.tips[resourceId]?.[0]?.kind ??
        repository.state.projections[resourceId]?.kind;
      const blockedReason = conflictedResources.has(resourceId)
        ? "Resolve the conflict first."
        : kind === undefined
          ? "The resource kind is unknown."
          : resourceConfigurationBlockReason(kind, {
              syncChat: this.configuration.syncChat,
              syncWorkspaceStorage: this.configuration.syncWorkspaceStorage,
            });
      return {
        label:
          blockedReason === null
            ? resourceId
            : `$(circle-slash) ${resourceId}`,
        ...(blockedReason === null ? {} : { description: blockedReason }),
        resourceId,
        blockedReason,
      };
    });
    const selectedResource = await vscode.window.showQuickPick(resourceItems, {
      title: "Select a resource whose version history should be restored",
      placeHolder:
        "Resources with an active conflict or a disabled kind cannot be restored.",
      ignoreFocusOut: true,
      matchOnDescription: true,
    });
    if (selectedResource === undefined) {
      return;
    }
    if (selectedResource.blockedReason !== null) {
      void vscode.window.showWarningMessage(
        `${selectedResource.resourceId}: ${selectedResource.blockedReason}`,
      );
      return;
    }
    const resourceId = selectedResource.resourceId;
    const history = await repository.listResourceHistory(resourceId);
    if (history.length === 0) {
      void vscode.window.showInformationMessage(
        `No version history is available for ${resourceId}.`,
      );
      return;
    }
    const tips = repository.state.tips[resourceId] ?? [];
    const expectedTipIds = tips.map((tip) => tip.versionId).sort();
    const currentTipIds = new Set(expectedTipIds);
    const versionItems = history.map((summary, index) => {
      const isCurrent = currentTipIds.has(summary.versionId);
      const blockedReason = isCurrent
        ? "This version is already the current content."
        : summary.operation === "delete"
          ? "A deletion cannot be restored."
          : databaseApplyBlockReason(
              summary.kind,
              effectiveVersionProducer(summary.metadata, summary.producer),
              this.compatibility,
            );
      return {
        label: `${blockedReason === null ? "" : "$(circle-slash) "}v${
          history.length - index
        } ${new Date(summary.createdAt).toLocaleString()}${
          isCurrent ? " (current)" : ""
        }`,
        description: `${summary.deviceId.slice(0, 8)} · ${summary.operation} · ${
          summary.plainBytes === null
            ? "no payload"
            : formatBytes(summary.plainBytes)
        }${summary.fromCheckpoint ? " · checkpoint" : ""}`,
        ...(blockedReason === null ? {} : { detail: blockedReason }),
        summary,
        blockedReason,
      };
    });
    const selectedVersion = await vscode.window.showQuickPick(versionItems, {
      title: `Restore a version of ${resourceId}`,
      placeHolder:
        "Newest first. Current, deleted, and version-gated entries cannot be restored.",
      ignoreFocusOut: true,
    });
    if (selectedVersion === undefined) {
      return;
    }
    if (selectedVersion.blockedReason !== null) {
      void vscode.window.showWarningMessage(
        `${resourceId}: ${selectedVersion.blockedReason}`,
      );
      return;
    }
    await this.showHistoryPreview(
      repository,
      resourceId,
      tips,
      selectedVersion.summary,
    );
    const confirmed = await vscode.window.showWarningMessage(
      `Publish the selected version of ${resourceId} as the new current content? History is not rewritten; the old content becomes a new version on top of it.`,
      { modal: true },
      "Restore Version",
    );
    if (confirmed !== "Restore Version") {
      return;
    }
    const lock = await this.takeCommandLock();
    try {
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      const freshTipIds = (repository.state.tips[resourceId] ?? [])
        .map((tip) => tip.versionId)
        .sort();
      const conflicted = repository.state.conflicts.some(
        (conflict) =>
          conflict.resourceId === resourceId &&
          conflict.resolvedAt === undefined,
      );
      if (
        conflicted ||
        freshTipIds.length !== expectedTipIds.length ||
        !freshTipIds.every(
          (versionId, index) => versionId === expectedTipIds[index],
        )
      ) {
        void vscode.window.showWarningMessage(
          `${resourceId} changed while the version was being selected; run Restore Version History again.`,
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
      const tipProducer = (repository.state.tips[resourceId] ?? []).find(
        (tip) => tip.producer !== undefined,
      )?.producer;
      // A restore of a restore keeps stamping the effective ORIGINAL producer
      // instead of the intermediate restorer's manifest producer.
      const originalProducer = effectiveVersionProducer(
        data.change.metadata,
        data.producer ?? selectedVersion.summary.producer ?? tipProducer,
      );
      const snapshot: ResourceSnapshot = {
        resourceId,
        kind: selectedVersion.summary.kind,
        content: data.content,
        semanticHash: data.change.semanticHash,
        metadata: {
          ...(data.change.metadata ?? {}),
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
        `The restored version of ${resourceId} is queued for the offline helper. Run "Cursor Setting Sync: Restart to Apply" to write it into the Cursor databases.`,
      );
    } else {
      void vscode.window.showInformationMessage(
        `Restored ${resourceId}; the selected version is published as the new current content.`,
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
      const current =
        currentTip === undefined
          ? null
          : await repository.tryReadVersion(currentTip.versionId);
      const selected = await repository.tryReadVersion(summary.versionId);
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
          : historyPreviewText(currentTip.operation, current?.content ?? null),
      );
      this.historyDocuments.set(
        selectedUri.toString(),
        historyPreviewText(summary.operation, selected?.content ?? null),
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
        this.gitWarningsShown.size > 0
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
    const masterKey = this.requireMasterKey();
    assertCompatibleForDatabaseWrite(this.compatibility);
    const backupRoot = join(this.paths.extensionStorage, BACKUP_DIRECTORY);
    const backups = (await listFilesRecursively(backupRoot)).filter((path) => {
      const name = basename(path).toLowerCase();
      return (
        (name.startsWith("state-") || name.startsWith("pre-restore-")) &&
        name.endsWith(".vscdb")
      );
    });
    const items: Array<{
      label: string;
      description: string;
      path: string;
      restoreTarget?: { targetPath: string; contract: DatabaseContract };
    }> = backups
      .sort((left, right) => right.localeCompare(left))
      .map((path) => ({ label: basename(path), description: path, path }));
    const recorded = this.context.globalState.get<StoredHelperBackup[]>(
      LAST_HELPER_BACKUPS_KEY,
      [],
    );
    for (const entry of recorded) {
      if (entry.contract === "global" || !(await pathExists(entry.backupPath))) {
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
      "Cursor will quit and import the selected backup's managed tables with a SQLite transaction. The live database file is not replaced; rows absent from those backed-up tables are removed.",
      { modal: true },
      "Import and Restart",
    );
    if (confirmed !== "Import and Restart") {
      return;
    }
    await this.helper.restoreAndRestart(
      repository.root,
      masterKey,
      selected.path,
      this.helperSyncOptions(),
      selected.restoreTarget,
      async () => {
        await this.startFinalizer();
      },
    );
  }

  async forgetDevice(): Promise<void> {
    const repository = this.requireRepository();
    const firstLock = await this.takeCommandLock();
    let candidates: Array<{
      label: string;
      description?: string;
      deviceId: string;
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
          ...(streamDevices.has(deviceId)
            ? {}
            : { description: "(no published events)" }),
          deviceId,
        }));
    } finally {
      await firstLock.release();
    }
    const selected = await vscode.window.showQuickPick(candidates, {
      title: "Forget a retired synchronization device",
      placeHolder: "Its immutable files remain in the repository.",
    });
    if (selected === undefined) {
      return;
    }
    const secondLock = await this.takeCommandLock();
    try {
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      if (!repository.state.retiredDevices.includes(selected.deviceId)) {
        repository.state.retiredDevices.push(selected.deviceId);
      }
      await repository.saveState();
      await this.commitGitWindow(
        gitActive,
        repository.root,
        `forget-device ${selected.deviceId.slice(0, 8)}`,
      );
    } finally {
      await secondLock.release();
    }
    void vscode.window.showInformationMessage(
      `Device ${selected.deviceId} is now retired.`,
    );
  }

  async showRepositoryUsage(): Promise<void> {
    const repository = this.requireRepository();
    const bytes = await directorySize(repository.root);
    void vscode.window.showInformationMessage(
      `Cursor Setting Sync repository uses ${formatBytes(bytes)}. v1 does not automatically delete immutable events or tombstones.`,
    );
    if (await this.gitModeFor(repository.root)) {
      await this.warnAboutLargeFiles(repository.root, false);
    }
  }

  async compactRepository(): Promise<void> {
    await this.withProgress(
      "Cursor Setting Sync: Compact Safe Orphans",
      async (report) => {
        report("Reading the repository...");
        await this.compactSafeOrphans();
      },
    );
  }

  private async compactSafeOrphans(): Promise<void> {
    const repository = this.requireRepository();
    const lock = await this.takeCommandLock();
    try {
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      const reconciler = new EventReconciler();
      const result = reconciler.reconcile(
        await repository.listEvents(),
        repository.state,
        await absorbedCheckpointManifest(repository),
      );
      if (result.warnings.length > 0) {
        throw new Error(
          `Compaction requires a fully propagated repository; resolve this stream warning first: ${result.warnings[0]}`,
        );
      }
      const compacted = await repository.compactOwnOrphans(true);
      await this.commitGitWindow(gitActive, repository.root, "compact");
      void vscode.window.showInformationMessage(
        `Removed ${compacted.removedFiles} safe staging/orphan file(s) and reclaimed ${formatBytes(compacted.reclaimedBytes)}. Finalized events, tombstones, and checkpoint-referenced objects were retained.`,
      );
    } finally {
      await lock.release();
    }
  }

  async checkpointRepository(): Promise<void> {
    const repository = this.requireRepository();
    // The full sync throws on any rollback error; residual stream warnings are
    // caught by the reconcile gate inside each phase run.
    await this.syncNow(true);
    let outcome = await this.runCheckpointPhases(repository, false);
    if (isAgeGateAbort(outcome.prune)) {
      const confirmed = await vscode.window.showWarningMessage(
        "Every visible device has absorbed the checkpoint, but it is younger than 24 hours. A device that has not appeared in the shared folder yet would fall back to the checkpoint content and lose granular history. Prune now anyway?",
        { modal: true },
        "Prune Now Anyway",
      );
      if (confirmed === "Prune Now Anyway") {
        const second = await this.runCheckpointPhases(repository, true);
        outcome = {
          created: outcome.created ?? second.created,
          prune: second.prune,
          gitSquash: second.gitSquash ?? outcome.gitSquash,
        };
      }
    }
    this.reportCheckpointOutcome(outcome);
  }

  private async runCheckpointPhases(
    repository: SyncRepository,
    overrideAgeGate: boolean,
  ): Promise<CheckpointCommandOutcome> {
    return this.withProgress(
      "Cursor Setting Sync: Checkpoint & Prune History",
      async (report) => this.checkpointPhases(repository, overrideAgeGate, report),
    );
  }

  private async checkpointPhases(
    repository: SyncRepository,
    overrideAgeGate: boolean,
    report: (message: string) => void,
  ): Promise<CheckpointCommandOutcome> {
    const lock = await this.takeCommandLock(report);
    try {
      report("Reading the repository...");
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      const reconciler = new EventReconciler();
      const result = reconciler.reconcile(
        await repository.listEvents(),
        repository.state,
        await absorbedCheckpointManifest(repository),
      );
      if (result.warnings.length > 0) {
        throw new Error(
          `Checkpointing requires a fully propagated repository; resolve this stream warning first: ${result.warnings[0]}`,
        );
      }
      report("Folding the current tips into a checkpoint...");
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
      if (
        !checkpointCoversStreams(
          repository.state.checkpoint,
          repository.state.streams,
        )
      ) {
        created = await repository.createCheckpoint(true);
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
        // A warning or rollback in the post-prune reconcile skips compaction
        // for this run instead of failing the already completed prune.
        let compactionBlocked: string | null = null;
        try {
          const postResult = reconciler.reconcile(
            await repository.listEvents(),
            repository.state,
            await absorbedCheckpointManifest(repository),
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

  private reportCheckpointOutcome(outcome: CheckpointCommandOutcome): void {
    const { created, prune, gitSquash } = outcome;
    const parts: string[] = [];
    if (created !== null) {
      parts.push(
        `Checkpoint ${created.checkpointHash.slice(0, 12)} created with ${created.resourceCount} folded resource(s) (${formatBytes(created.fileBytes)}).`,
      );
    }
    if (prune === null) {
      void vscode.window.showInformationMessage(
        created === null
          ? "The repository has no events to checkpoint yet."
          : parts.join(" "),
      );
      return;
    }
    if (prune.status === "pruned") {
      for (const warning of prune.warnings) {
        this.status.log(`Warning: ${warning}`);
      }
      parts.push(
        `Pruned ${prune.eventsDeleted} event file(s), removed ${prune.checkpointFilesDeleted} superseded checkpoint file(s), and reclaimed ${formatBytes(prune.reclaimedBytes)}.`,
      );
      if (
        gitSquash !== null &&
        gitSquash.bytesBefore !== null &&
        gitSquash.bytesAfter !== null
      ) {
        parts.push(
          `Git history squashed, reclaiming ${formatBytes(
            Math.max(0, gitSquash.bytesBefore - gitSquash.bytesAfter),
          )}.`,
        );
      }
      void vscode.window.showInformationMessage(parts.join(" "));
      return;
    }
    const lagging =
      prune.laggingDevices.length === 0
        ? ""
        : ` Lagging device(s): ${prune.laggingDevices.join("; ")}.`;
    void vscode.window.showWarningMessage(
      `${parts.length === 0 ? "" : `${parts.join(" ")} `}Pruning was skipped: ${
        prune.reason ?? "unknown reason"
      }${lagging}`,
    );
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
      "Cursor Setting Sync: Archive Repository",
      async (report) => {
        report("Enumerating repository files...");
        const sources = await listFilesRecursively(repository.root);
        let copied = 0;
        for (const source of sources) {
          const relativePath = relative(repository.root, source);
          await copyFileAtomic(source, join(destination, relativePath));
          copied += 1;
          report(`Copying ${copied}/${sources.length} files...`);
        }
      },
    );
    void vscode.window.showInformationMessage(`Repository archived to ${destination}`);
  }

  dispose(): void {
    this.disposed = true;
    this.disposeRuntime();
    this.warnings.clear();
    this.historyPreviewRegistration.dispose();
    this.helper.dispose();
    this.masterKey?.fill(0);
    this.masterKey = null;
  }

  private async performSync(manual: boolean, scope: SyncScope): Promise<void> {
    const repository = this.repository;
    if (repository === null) {
      const unconfigured = this.configuration.repositoryPath === null;
      this.status.setStatus(unconfigured ? "unconfigured" : "locked");
      if (manual) {
        void vscode.window.showInformationMessage(
          unconfigured
            ? "Cursor Setting Sync is not configured yet. Run \"Cursor Setting Sync: Setup\" first."
            : "Cursor Setting Sync is locked. Run \"Cursor Setting Sync: Setup\" and enter your passphrase to unlock it.",
        );
      }
      return;
    }
    this.syncRepositoryLimit(repository);
    const lock = await acquireFileLock(this.syncLockPath());
    if (lock === null) {
      await this.noteLockSkipped(manual);
      // The other holder may own the lock continuously, so this window would
      // otherwise keep displaying whatever it last computed — including a
      // stale "up-to-date" while conflicts are outstanding.
      this.updateStatus(repository);
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
      // Inside the lock so two cycling windows do not both report - and both
      // delete - the same result. A helper that fails while Cursor is still
      // running (a vetoed quit, or the exit wait expiring) leaves its result
      // here and nothing restarts, so the startup consume never arrives.
      await this.consumeHelperResults({ atStartup: false });
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      const checkpoint = await absorbedCheckpointManifest(repository);
      const reconciler = new EventReconciler();
      // Auto-merge runs on every cycle regardless of scope, so its bucket is
      // always observed, exactly like the reconciler's.
      const mergeWarnings: string[] = [];
      const noteMergeWarning = (warning: string): void => {
        mergeWarnings.push(warning);
      };
      let preResult = reconciler.reconcile(
        await repository.listEvents(),
        repository.state,
        checkpoint,
      );
      if (
        await autoMergeConflicts(
          repository,
          preResult.conflicts,
          (tips) =>
            tips.every(
              (tip) => this.resourceApplyBlockReason(tip) === null,
            ),
          noteMergeWarning,
        )
      ) {
        preResult = reconciler.reconcile(
          await repository.listEvents(),
          repository.state,
          checkpoint,
        );
      }
      const syntheticSkips = await this.applySyntheticProjectionsBeforeScan(
        repository,
        preResult.projections,
      );
      preResult = reconciler.reconcile(
        await repository.listEvents(),
        repository.state,
        checkpoint,
      );
      const requiredKinds = new Set(
        preResult.projections
          .filter((projection) => projection.changed)
          .map((projection) => projection.tip.kind),
      );
      const scan = await this.scanLocalResources(
        repository.state.projections,
        manual ? "all" : scope,
        requiredKinds,
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
      ).map((snapshot) => ({
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
        changedSnapshots,
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
      const publishedCount =
        publishable.snapshots.length + publishable.deletions.length;
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

      let result = reconciler.reconcile(
        await repository.listEvents(),
        repository.state,
        checkpoint,
      );
      if (
        await autoMergeConflicts(
          repository,
          result.conflicts,
          (tips) =>
            tips.every(
              (tip) => this.resourceApplyBlockReason(tip) === null,
            ),
          noteMergeWarning,
        )
      ) {
        result = reconciler.reconcile(
          await repository.listEvents(),
          repository.state,
          checkpoint,
        );
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
      prunePending(repository, result.projections);
      await this.applyProjections(
        repository,
        result.projections,
        localSnapshots,
        manual,
      );
      repository.state.lastSyncAt = new Date().toISOString();
      repository.state.lastError = null;
      await repository.saveState();
      await repository.writeAck();
      await this.commitGitWindow(
        gitActive,
        repository.root,
        `sync(${repository.state.device.deviceId.slice(0, 8)}): ${publishedCount} change(s)`,
      );
      if (gitActive && publishedCount > 0) {
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
          return vscode.commands.executeCommand(RESTART_TO_APPLY_COMMAND);
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
  ): Promise<LocalScanResult> {
    return scanAdapters(this.adapters, known, scope, requiredKinds);
  }

  private async applyProjections(
    repository: SyncRepository,
    projections: ResourceProjection[],
    localSnapshots: Map<string, ResourceSnapshot>,
    manual: boolean,
  ): Promise<void> {
    const scannedByAdapter = new Map<string, AdapterScanIndex | null>();
    for (const projection of projections.filter((candidate) => candidate.changed)) {
      const tip = projection.tip;
      const local = localSnapshots.get(projection.resourceId);
      if (
        (tip.deviceId === repository.state.device.deviceId &&
          !isSyntheticTip(tip)) ||
        local?.semanticHash === tip.semanticHash
      ) {
        markProjection(repository, projection, local);
        continue;
      }
      if (
        ["chat", "chat-transcript", "chat-store", "workspace-storage"].includes(
          tip.kind,
        ) &&
        tip.operation === "delete"
      ) {
        markProjection(repository, projection, local);
        continue;
      }
      if (isPolicyExcludedUiStateResource(projection.resourceId, tip.kind)) {
        // A peer running 0.0.1-0.0.3 published this key before it was excluded.
        // Accept the version without writing it: the helper would skip it
        // anyway, and queueing it only makes the user restart for a change that
        // will never be applied.
        this.status.log(
          `Skipped ${projection.resourceId}: this key is excluded from ` +
            "synchronization because it accumulates one dead entry per AI chat panel.",
        );
        markProjection(repository, projection, local);
        continue;
      }
      const blockedReason = this.resourceApplyBlockReason(tip);
      if (blockedReason !== null) {
        queuePending(repository, projection, blockedReason);
        continue;
      }
      const adapter = this.adapterFor(tip.kind);
      if (adapter.appliesWhileRunning && (this.configuration.autoApplyFiles || manual)) {
        if (isSyntheticTip(tip) && local === undefined) {
          // The adapter was not scanned this cycle, so the local state is
          // unknown; a merge result must not overwrite unpublished edits.
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
            queuePending(repository, projection);
            continue;
          }
          if (decision.action === "already-applied") {
            markProjection(repository, projection, decision.live);
            continue;
          }
        }
        const applyResult = await adapter.apply(
          await projectionInput(repository, projection),
        );
        markProjection(repository, projection, undefined, applyResult);
      } else {
        queuePending(repository, projection);
      }
    }
  }

  private async applySyntheticProjectionsBeforeScan(
    repository: SyncRepository,
    projections: ResourceProjection[],
  ): Promise<Set<string>> {
    const driftSkipped = new Set<string>();
    const scannedByAdapter = new Map<string, AdapterScanIndex | null>();
    for (const projection of projections) {
      if (!projection.changed || !isSyntheticTip(projection.tip)) {
        continue;
      }
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
      const applyResult = await adapter.apply(
        await projectionInput(repository, projection),
      );
      markProjection(repository, projection, undefined, applyResult);
    }
    await repository.saveState();
    return driftSkipped;
  }

  private async scanAdapterForDrift(
    adapter: ResourceAdapter,
    known: Record<string, LocalProjection>,
    cache: Map<string, AdapterScanIndex | null>,
  ): Promise<AdapterScanIndex | null> {
    let scanned = cache.get(adapter.id);
    if (scanned === undefined) {
      try {
        const result = await adapter.scan(known);
        scanned = {
          snapshots: new Map(
            result.snapshots.map((snapshot) => [snapshot.resourceId, snapshot]),
          ),
          deletions: new Map(
            result.deletions.map((deletion) => [deletion.resourceId, deletion]),
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
      const tip = findTip(repository, item.eventHash, item.changeIndex);
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
      const projection: ResourceProjection = {
        resourceId: item.resourceId,
        tip,
        changed: true,
      };
      if (isSyntheticTip(tip)) {
        const scanned = await this.scanAdapterForDrift(
          adapter,
          repository.state.projections,
          scannedByAdapter,
        );
        const decision = syntheticApplyDecision(
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
      }
      const applyResult = await adapter.apply(
        await projectionInput(repository, projection),
      );
      markProjection(repository, projection, undefined, applyResult);
      repository.state.pendingDatabaseChanges =
        repository.state.pendingDatabaseChanges.filter(
          (candidate) =>
            candidate.eventHash !== item.eventHash ||
            candidate.changeIndex !== item.changeIndex,
        );
    }
    await repository.saveState();
  }

  private async ensureWorkspaceMappings(repository: SyncRepository): Promise<void> {
    const localWorkspaces = await discoverWorkspaces(this.paths);
    const workspaceMappings = Object.assign(
      Object.create(null) as Record<string, string>,
      this.configuration.workspaceMappings,
    );
    const handled = new Set<string>();
    let skipRemainingPrompts = false;
    // Recently updated workspaces are prompted first so stale ones can be
    // skipped in one action.
    const pendingChanges = repository.state.pendingDatabaseChanges
      .map((pending) => ({
        pending,
        lastUpdatedAt: pendingLastUpdatedAt(repository, pending),
      }))
      .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt)
      .map((entry) => entry.pending);
    for (const pending of pendingChanges) {
      if (pending.kind !== "chat" && pending.kind !== "workspace-storage") {
        continue;
      }
      const tip = findTip(repository, pending.eventHash, pending.changeIndex);
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
        // NULL workspaceId straight back.
        delete pending.blockedReason;
        continue;
      }
      if (typeof sourceWorkspaceId !== "string") {
        pending.blockedReason = "Incoming workspace metadata is missing a workspace ID.";
        continue;
      }
      const resolved = resolveTargetWorkspace(
        sourceWorkspaceId,
        typeof sourceWorkspaceUri === "string" ? sourceWorkspaceUri : null,
        localWorkspaces,
        workspaceMappings,
      );
      if (resolved !== null) {
        if (
          workspaceMappings[sourceWorkspaceId] === undefined &&
          resolved !== sourceWorkspaceId
        ) {
          await this.configuration.setWorkspaceMapping(
            sourceWorkspaceId,
            resolved,
          );
          workspaceMappings[sourceWorkspaceId] = resolved;
        }
        this.updateWorkspaceMappingBlocks(
          repository,
          sourceWorkspaceId,
          null,
        );
        continue;
      }
      if (typeof sourceWorkspaceUri !== "string") {
        // A workspaceStorage directory with no folder URI belongs to a window
        // that had nothing open. Its name is the millisecond it was created, so
        // it names a window on one computer and can never name one here - and
        // the prompt for it listed every local workspace under a bare number,
        // with no correct answer anywhere in the list, forever.
        pending.blockedReason =
          "This workspace storage belongs to a window with no folder open, so it has no counterpart on this computer.";
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
        delete pending.blockedReason;
        continue;
      }
      if (handled.has(sourceWorkspaceId)) {
        continue;
      }
      handled.add(sourceWorkspaceId);
      // Only workspaceStorage reaches here; chats returned above.
      const resourceLabel = "workspace storage";
      const items: Array<{
        label: string;
        description: string;
        workspaceId: string | null;
      }> = [
        ...localWorkspaces.map((workspace) => ({
          label: workspace.basename,
          description: workspace.uri,
          workspaceId: workspace.id,
        })),
        {
          label: "$(close) Skip all remaining workspaces",
          description: "Leave the remaining incoming changes blocked for this run.",
          workspaceId: null,
        },
      ];
      const selected: (typeof items)[number] | undefined = skipRemainingPrompts
        ? undefined
        : await vscode.window.showQuickPick(items, {
            title: `Map incoming ${resourceLabel} workspace ${
              typeof sourceWorkspaceUri === "string"
                ? sourceWorkspaceUri
                : sourceWorkspaceId
            }`,
            placeHolder: `Select the local workspace where this ${resourceLabel} should appear.`,
            ignoreFocusOut: true,
          });
      if (selected === undefined || selected.workspaceId === null) {
        skipRemainingPrompts ||= selected !== undefined;
        this.updateWorkspaceMappingBlocks(
          repository,
          sourceWorkspaceId,
          `Workspace mapping is required for incoming ${resourceLabel}.`,
        );
        continue;
      }
      await this.configuration.setWorkspaceMapping(
        sourceWorkspaceId,
        selected.workspaceId,
      );
      workspaceMappings[sourceWorkspaceId] = selected.workspaceId;
      this.updateWorkspaceMappingBlocks(repository, sourceWorkspaceId, null);
    }
  }

  private updateWorkspaceMappingBlocks(
    repository: SyncRepository,
    sourceWorkspaceId: string,
    reason: string | null,
  ): void {
    for (const pending of repository.state.pendingDatabaseChanges) {
      if (pending.kind !== "chat" && pending.kind !== "workspace-storage") {
        continue;
      }
      const tip = findTip(repository, pending.eventHash, pending.changeIndex);
      if (
        tip?.metadata?.workspaceId !== sourceWorkspaceId ||
        this.resourceApplyBlockReason(tip) !== null
      ) {
        continue;
      }
      if (reason === null) {
        delete pending.blockedReason;
      } else if (pending.kind === "workspace-storage") {
        // Only workspaceStorage is held back for a missing mapping. A chat is
        // written under the workspace ID it came with, so declining to map a
        // workspace must not also withhold the conversations from it.
        pending.blockedReason = reason;
      }
    }
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
    // reaches `ensureWorkspaceMappings`, whose prompt is the whole point of
    // excluding it: a local folder from another computer has no answer on this
    // one, and the modal has to be answered before anything else can apply.
    if (
      tip.kind === "workspace-storage" &&
      isIgnoredWorkspaceUri(
        typeof tip.metadata?.workspaceUri === "string"
          ? tip.metadata.workspaceUri
          : null,
        this.ignoredWorkspaceMatcher(),
      )
    ) {
      return "This workspace is excluded by cursorSettingSync.ignoredWorkspaces on this computer.";
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
  }

  /**
   * Rebuilds the adapter set and drops warning buckets whose adapter no longer
   * exists. Turning off chat sync or losing database compatibility removes
   * adapters, and nothing would ever clear their standing warnings again.
   */
  private refreshAdapters(): void {
    this.adapters = this.createAdapters();
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

  private async openConfiguredRepository(masterKey: Buffer): Promise<void> {
    const root = this.configuration.repositoryPath;
    if (root === null) {
      return;
    }
    await assertSafeRepositoryLocation(root, this.synchronizedSourceRoots());
    const repositoryFile = await readJsonFile<RepositoryFile>(
      join(root, REPOSITORY_FILE),
    );
    if (
      this.configuration.repositoryId !== null &&
      repositoryFile.repositoryId !== this.configuration.repositoryId
    ) {
      throw new Error(
        "The configured folder now contains a different repository. Point Setup at the original folder, or run \"Cursor Setting Sync: Disconnect\" to clear the stored repository and connect to this one.",
      );
    }
    this.masterKey?.fill(0);
    this.masterKey = Buffer.from(masterKey);
    this.repository = await SyncRepository.openWithMasterKey(
      root,
      this.paths.extensionStorage,
      repositoryFile,
      this.masterKey,
      this.configuration.maxPayloadBytes,
      this.producer,
    );
    this.refreshAdapters();
  }

  private synchronizedSourceRoots(): Array<{ label: string; path: string }> {
    return [
      { label: "Cursor user data", path: this.paths.userDataRoot },
      { label: "the .cursor user directory", path: this.paths.cursorHome },
      { label: "extension local storage", path: this.paths.extensionStorage },
    ];
  }

  private async startFinalizer(): Promise<void> {
    if (
      this.repository === null ||
      this.masterKey === null ||
      !this.compatibility.compatible ||
      !(await pathExists(this.paths.helperScript))
    ) {
      return;
    }
    await this.helper.restartFinalizer(
      this.repository.root,
      this.masterKey,
      this.configuration.workspaceMappings,
      this.helperSyncOptions(),
    );
  }

  private startWatching(): void {
    const root = this.configuration.repositoryPath;
    if (root === null || this.disposed) {
      return;
    }
    this.disposeRuntime();
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
        if (
          this.repository?.wroteRecently(
            repositoryPayloadFileName(fileName),
          ) === true
        ) {
          return;
        }
        if (this.watcherDebounce !== null) {
          clearTimeout(this.watcherDebounce);
        }
        this.watcherDebounce = setTimeout(() => {
          this.scheduleAutomaticSync("remote");
        }, 1000);
      },
      (message) => {
        this.status.log(`Repository watcher error: ${message}`);
      },
    );
    this.pollTimer = setInterval(
      () => this.scheduleAutomaticSync("files"),
      this.configuration.pollIntervalSeconds * 1000,
    );
    if (this.configuration.syncChat) {
      this.chatPollTimer = setInterval(
        () => this.scheduleAutomaticSync("chat"),
        this.configuration.chatPollIntervalSeconds * 1000,
      );
    }
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
      maxPayloadBytes: this.configuration.maxPayloadBytes,
      gitSync: this.configuration.gitSync,
    };
  }

  private scheduleAutomaticSync(scope: SyncScope): void {
    void this.syncNow(false, scope).catch((error: unknown) => {
      this.status.log(
        `Queued automatic synchronization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private disposeRuntime(): void {
    this.repositoryWatcher?.close();
    this.repositoryWatcher = null;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.chatPollTimer !== null) {
      clearInterval(this.chatPollTimer);
      this.chatPollTimer = null;
    }
    if (this.watcherDebounce !== null) {
      clearTimeout(this.watcherDebounce);
      this.watcherDebounce = null;
    }
    this.clearSyncIndicator();
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
    } else if (repository.state.pendingDatabaseChanges.length > 0) {
      this.status.setStatus(
        "pending-restart",
        pendingRestartDetail(repository.state.pendingDatabaseChanges),
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
    for (const name of names) {
      const path = join(this.paths.extensionStorage, name);
      let result: HelperResult;
      try {
        result = await readJsonFile<HelperResult>(path);
      } catch (error) {
        if (isMissingPathError(error)) {
          // Another window consumed it between the listing and the read.
          continue;
        }
        // A truncated result never becomes readable, so leaving it would
        // rethrow on every cycle from here on.
        this.status.log(
          `Discarded an unreadable helper result (${name}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await rm(path, { force: true });
        continue;
      }
      consumed.push(result);
      await this.recordHelperBackups(result);
      if (result.success) {
        this.status.log(
          `Helper ${result.requestId} applied ${result.applied.length} resource(s).`,
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
        // been dealt with; without this the bar stays red until a reload.
        this.helperFailure = null;
      } else {
        this.status.log(`Helper ${result.requestId} failed: ${result.error ?? "unknown"}`);
        this.helperFailure = helperFailureDetail(result.error);
        this.status.setStatus("error", this.helperFailure);
        this.announceHelperFailure(this.helperFailure);
      }
      await rm(path, { force: true });
    }
    if (!options.atStartup) {
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
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const requestPath = join(this.paths.extensionStorage, name);
      const logPath = `${requestPath}.stderr.log`;
      let scriptMissing = false;
      try {
        const request = await readJsonFile<HelperRequest>(requestPath);
        scriptMissing = !(await pathExists(request.paths.helperScript));
      } catch {
        // An unreadable request is itself worth reporting.
      }
      let stderr = "";
      try {
        stderr = (await readFile(logPath, "utf8")).trim();
      } catch {
        // No log: this predates the change that captures one.
      }
      if (!scriptMissing) {
        this.status.log(
          `The offline helper for ${name} never reported a result.${
            stderr.length === 0 ? "" : ` It wrote: ${stderr.slice(0, 2000)}`
          }`,
        );
      }
      await rm(requestPath, { force: true });
      await rm(logPath, { force: true });
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
  private async openGitWindow(repository: SyncRepository): Promise<boolean> {
    if (!(await this.gitModeFor(repository.root))) {
      return false;
    }
    try {
      await pullLatest(repository.root);
      return true;
    } catch (error) {
      if (error instanceof GitError && error.kind === "conflict") {
        throw error;
      }
      this.degradeGit(error);
      return false;
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
      return true;
    } catch (error) {
      if (error instanceof GitError && error.kind === "conflict") {
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
    if (this.gitWarningsShown.has(kind)) {
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
   * `configurationChanged` refreshes the adapters but never reopens the
   * repository, and `openConfiguredRepository` is only reached from
   * `initialize` and `setup`. Without this the repository kept enforcing
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

export type SyncScope = "all" | "files" | "chat" | "remote";

export interface LocalScanResult {
  snapshots: ResourceSnapshot[];
  deletions: ResourceDeletion[];
  /**
   * Keyed by adapter id. Present and empty means the adapter ran and produced
   * nothing; absent means it did not run this cycle. The warning registry
   * relies on that distinction to leave an unrun adapter's bucket alone.
   */
  warningsBySource: Map<string, string[]>;
}

export async function scanAdapters(
  adapters: readonly ResourceAdapter[],
  known: Record<string, LocalProjection>,
  scope: SyncScope,
  requiredKinds: ReadonlySet<ResourceKind>,
): Promise<LocalScanResult> {
  const snapshots: ResourceSnapshot[] = [];
  const deletions: ResourceDeletion[] = [];
  const warningsBySource = new Map<string, string[]>();
  for (const adapter of adapters.filter((candidate) =>
    shouldScanAdapter(candidate, scope, requiredKinds),
  )) {
    // A failing adapter must not abort the whole cycle; deletions come only
    // from completed scans, so skipping the adapter is safe.
    try {
      const result = await adapter.scan(known);
      snapshots.push(...result.snapshots);
      deletions.push(...result.deletions);
      warningsBySource.set(adapter.id, [...result.warnings]);
    } catch (error) {
      warningsBySource.set(adapter.id, [
        `Adapter ${adapter.id} scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]);
    }
  }
  return { snapshots, deletions, warningsBySource };
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
    detail: `${details.join(" ")} Run "Cursor Setting Sync: Show Diagnostics".`,
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

/**
 * One actionable sentence from whatever the helper died of.
 *
 * `HelperResult.error` is `error.stack ?? error.message`, so what arrives is a
 * class name followed by frames of `helper.js` line numbers. That was the whole
 * of the user-facing text, in a status bar tooltip, on a device where the
 * failure meant 146 incoming chats stayed unwritten.
 */
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
): string {
  const ready = pending.filter((change) => change.blockedReason === undefined);
  const deferred = pending.filter((change) => change.blockedReason !== undefined);
  return [
    ready.length === 0
      ? ""
      : `${ready.length} change(s) from another device (${summarizePendingKinds(ready)}) are queued. ` +
        `Run "${RESTART_TO_APPLY_TITLE}" to write them - quitting and reopening Cursor does not.`,
    deferred.length === 0
      ? ""
      : `${deferred.length} change(s) are deferred: ${commonestBlockedReason(deferred)}`,
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
  pending: readonly PendingDatabaseChange[],
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
      [...new Set(reported.flatMap((result) => result.warnings ?? []))],
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

function mergeSyncScopes(scopes: ReadonlySet<SyncScope>): SyncScope {
  if (
    scopes.has("all") ||
    (scopes.has("files") && scopes.has("chat"))
  ) {
    return "all";
  }
  if (scopes.has("files")) {
    return "files";
  }
  if (scopes.has("chat")) {
    return "chat";
  }
  return "remote";
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

function isAgeGateAbort(prune: PruneResult | null): boolean {
  return (
    prune !== null &&
    prune.status === "aborted" &&
    (prune.reason?.includes("younger than 24 hours") ?? false)
  );
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
  if (content.byteLength > 1024 * 1024) {
    return `[Payload is ${content.byteLength} bytes; preview omitted]\n`;
  }
  const text = content.toString("utf8");
  return text.includes("\uFFFD")
    ? `[Binary payload]\n${content.toString("base64")}`
    : text;
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
  // Neither a snapshot nor a deletion for a resource the projection expects
  // means the file failed scan validation; treat as drift, not clean.
  return known === undefined ? { action: "apply" } : { action: "drift" };
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
    ...(typeof tip.metadata?.lastUpdatedAt === "number"
      ? { sourceTimestamp: tip.metadata.lastUpdatedAt }
      : {}),
  };
  repository.state.pendingDatabaseChanges =
    repository.state.pendingDatabaseChanges.filter(
      (pending) =>
        pending.eventHash !== tip.eventHash ||
        pending.changeIndex !== tip.changeIndex,
    );
}

/**
 * True for an inbound ui-state resource this build declines to synchronize.
 *
 * Read from the resource ID rather than the tip metadata: the ID is what the
 * helper validates the metadata against, and events written by 0.0.1-0.0.3
 * are the ones this has to recognize.
 */
function isPolicyExcludedUiStateResource(
  resourceId: string,
  kind: ResourceKind,
): boolean {
  const prefix = "ui-state/";
  if (kind !== "ui-state" || !resourceId.startsWith(prefix)) {
    return false;
  }
  let key: string;
  try {
    key = decodeURIComponent(resourceId.slice(prefix.length));
  } catch {
    return false;
  }
  return isPolicyExcludedUiStateKey(key);
}

function queuePending(
  repository: SyncRepository,
  projection: ResourceProjection,
  blockedReason?: string,
): void {
  const tip = projection.tip;
  if (isPolicyExcludedUiStateResource(projection.resourceId, tip.kind)) {
    // Never hand the helper a change it is only going to skip. Any entry an
    // earlier run of this build already queued is dropped here too, so an
    // existing repository stops asking for a restart that would do nothing.
    repository.state.pendingDatabaseChanges =
      repository.state.pendingDatabaseChanges.filter(
        (pending) =>
          pending.eventHash !== tip.eventHash ||
          pending.changeIndex !== tip.changeIndex,
      );
    return;
  }
  const existing = repository.state.pendingDatabaseChanges.find(
    (pending) =>
      pending.eventHash === tip.eventHash &&
      pending.changeIndex === tip.changeIndex,
  );
  if (existing !== undefined) {
    if (blockedReason === undefined) {
      delete existing.blockedReason;
    } else {
      existing.blockedReason = blockedReason;
    }
    return;
  }
  repository.state.pendingDatabaseChanges.push({
    eventHash: tip.eventHash,
    changeIndex: tip.changeIndex,
    resourceId: projection.resourceId,
    kind: tip.kind,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  });
}

function prunePending(
  repository: SyncRepository,
  projections: ResourceProjection[],
): void {
  const active = new Set(
    projections.map(
      (projection) => `${projection.tip.eventHash}#${projection.tip.changeIndex}`,
    ),
  );
  repository.state.pendingDatabaseChanges =
    repository.state.pendingDatabaseChanges.filter((pending) =>
      active.has(`${pending.eventHash}#${pending.changeIndex}`),
    );
}

function pendingHelperChanges(repository: SyncRepository): HelperChange[] {
  const changes: HelperChange[] = [];
  let totalBytes = 0;
  for (const pending of repository.state.pendingDatabaseChanges) {
      if (pending.blockedReason !== undefined) {
        continue;
      }
      // Last gate before the helper. `queuePending` already refuses these, but
      // a repository written by an earlier run of this build can still hold the
      // entry, and the helper is the place where getting it wrong cost the user
      // every other resource in the request.
      if (isPolicyExcludedUiStateResource(pending.resourceId, pending.kind)) {
        continue;
      }
      const tip = findTip(repository, pending.eventHash, pending.changeIndex);
      if (tip === undefined) {
        continue;
      }
      const payloadBytes = tip.payload?.plainBytes ?? 0;
      if (totalBytes + payloadBytes > MAX_APPLY_BATCH_BYTES) {
        continue;
      }
      const change: HelperChange = {
        eventHash: tip.eventHash,
        changeIndex: tip.changeIndex,
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
      totalBytes += payloadBytes;
  }
  return changes;
}

function pendingLastUpdatedAt(
  repository: SyncRepository,
  pending: PendingDatabaseChange,
): number {
  const lastUpdatedAt = findTip(
    repository,
    pending.eventHash,
    pending.changeIndex,
  )?.metadata?.lastUpdatedAt;
  return typeof lastUpdatedAt === "number" ? lastUpdatedAt : 0;
}

function findTip(
  repository: SyncRepository,
  eventHash: string,
  changeIndex: number,
): ResourceTip | undefined {
  for (const tips of Object.values(repository.state.tips)) {
    const match = tips.find(
      (tip) =>
        tip.eventHash === eventHash && tip.changeIndex === changeIndex,
    );
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
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
      if (
        conflict.resolvedAt !== undefined ||
        conflict.tipVersionIds.length !== 2
      ) {
        continue;
      }
      const tips = repository.state.tips[conflict.resourceId] ?? [];
      if (tips.length !== 2 || !canMerge(tips)) {
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
      // A base folded away by a checkpoint reads as null; the conflict then
      // degrades to manual resolution instead of throwing mid-sync.
      const base = await repository.tryReadVersion(conflict.baseVersionId);
      if (base === null) {
        continue;
      }
      // A tip that merely re-asserts the base (e.g. a checkpoint marker
      // concurrent with an unpublished edit) carries no change of its own, so
      // the other tip wins for every kind before kind-specific merge policy.
      if (
        await resolveTrivialConflict(
          repository,
          conflict,
          tips,
          base.change,
          onWarning,
        )
      ) {
        mergedAny = true;
        continue;
      }
      const workspaceDatabase =
        conflict.kind === "workspace-storage" &&
        isWorkspaceDatabaseTipMetadata(tips[0]?.metadata);
      if (
        tips.some((tip) => tip.operation !== "put") ||
        !(workspaceDatabase || isAutoMergeKind(conflict.kind, tips[0]?.metadata))
      ) {
        continue;
      }
      const localTip =
        tips.find((tip) => tip.deviceId === repository.state.device.deviceId) ??
        tips[0];
      const remoteTip = tips.find((tip) => tip.versionId !== localTip?.versionId);
      if (localTip === undefined || remoteTip === undefined) {
        continue;
      }
      const [local, remote] = await Promise.all([
        repository.readVersion(localTip.versionId),
        repository.readVersion(remoteTip.versionId),
      ]);
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
      const chatOutcome =
        conflict.kind === "chat" &&
        newestTip !== undefined &&
        olderTip !== undefined
          ? mergeChatSnapshotBuffers(base.content, [
              contentOf(newestTip),
              contentOf(olderTip),
            ])
          : undefined;
      // chat is its own branch rather than a `??` in front of the chain, so it
      // can never reach the diff3 fallback: a line-based merge of two chat
      // snapshots can produce syntactically valid JSON that describes a
      // conversation neither device has.
      const outcome: MergeOutcome =
        conflict.kind === "chat"
          ? chatOutcome ?? { status: "conflict" }
          : workspaceDatabase
            ? mergeWorkspaceDatabaseBuffers(base.content, local.content, remote.content)
            : conflict.kind === "ui-state"
              ? mergeUiStateBuffers(base.content, local.content, remote.content)
              : isJsonMergeKind(conflict.kind, localTip.metadata)
                ? mergeJsoncBuffers(base.content, local.content, remote.content)
                : validatedTextMergeOutcome(
                    conflict.kind,
                    mergeTextBuffers(base.content, local.content, remote.content),
                  );
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
      const snapshot: ResourceSnapshot = {
        resourceId: conflict.resourceId,
        kind: conflict.kind,
        content: resolved.content,
        semanticHash: resolved.semanticHash ?? sha256(resolved.content),
        metadata: {
          ...(metadataTip.metadata ?? {}),
          // The union of both sides' bubbles is what was published, so the count
          // that travels with it has to describe the union, not the winner.
          ...(chatOutcome?.bubbleCount === undefined
            ? {}
            : { bubbleCount: chatOutcome.bubbleCount }),
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
        }), so the conflict is waiting for "Cursor Setting Sync: Resolve Conflicts".`,
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
  const [firstData, secondData] = await Promise.all([
    repository.tryReadVersion(first.versionId),
    repository.tryReadVersion(second.versionId),
  ]);
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
  ]);
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
          ...(winnerTip.metadata ?? {}),
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
          'Sync: Resolve Conflicts".',
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
      }), so the conflict is waiting for "Cursor Setting Sync: Resolve Conflicts".`,
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
  const matching = tips.filter(
    (tip) =>
      tip.operation === base.operation &&
      tip.semanticHash === base.semanticHash,
  );
  if (matching.length !== 1) {
    return false;
  }
  const survivor = tips.find((tip) => tip !== matching[0]);
  if (survivor === undefined) {
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

function isWorkspaceDatabaseTipMetadata(
  metadata: ResourceTip["metadata"],
): boolean {
  const relativePath = metadata?.relativePath;
  return (
    typeof relativePath === "string" &&
    isWorkspaceStateDatabasePath(relativePath)
  );
}

function mergeWorkspaceDatabaseBuffers(
  base: Buffer,
  local: Buffer,
  remote: Buffer,
): MergeOutcome {
  try {
    const merged = mergeWorkspaceDatabaseSnapshots(
      parseWorkspaceDatabaseSnapshot(base),
      parseWorkspaceDatabaseSnapshot(local),
      parseWorkspaceDatabaseSnapshot(remote),
    );
    if (merged.status !== "merged" || merged.snapshot === undefined) {
      return { status: "conflict" };
    }
    return {
      status: "merged",
      content: serializeWorkspaceDatabaseSnapshot(merged.snapshot),
    };
  } catch {
    // Unparseable or mismatched snapshots fall back to manual resolution.
    return { status: "conflict" };
  }
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

