import { basename, isAbsolute, join, relative } from "node:path";
import { readdir, rm } from "node:fs/promises";
import * as vscode from "vscode";
import {
  BACKUP_DIRECTORY,
  MAX_APPLY_BATCH_BYTES,
  REPOSITORY_FILE,
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
  listFilesRecursively,
  pathExists,
  readJsonFile,
} from "../platform/files";
import { acquireFileLock } from "../platform/lock";
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
  parentsForLocalChange,
  type ResourceProjection,
} from "../protocol/reconciler";
import type {
  ResourceAdapter,
  ResourceApplyInput,
  ResourceApplyResult,
} from "../resources/resource";
import { SettingsAdapter, collectMachineScopedSettings } from "../resources/settings";
import { ProfileFilesAdapter } from "../resources/profileFiles";
import {
  CursorUserFilesAdapter,
  normalizeIgnoredUserFiles,
} from "../resources/cursorUserFiles";
import { ProfilesAdapter } from "../resources/profiles";
import { UiStateAdapter } from "../resources/uiState";
import { ExtensionsAdapter } from "../resources/extensions";
import {
  WorkspaceStorageAdapter,
  isWorkspaceStateDatabasePath,
} from "../resources/workspaceStorage";
import { StateVscdbChatAdapter } from "../chat/stateVscdb";
import { ChatTranscriptsAdapter } from "../chat/transcripts";
import { StoreDbChatAdapter } from "../chat/storeDb";
import {
  discoverWorkspaces,
  resolveTargetWorkspace,
} from "../chat/workspace";
import { HelperLauncher } from "../helper/launcher";
import type { HelperSyncOptions } from "../helper/launcher";
import type { DatabaseContract } from "../helper/database";
import type { HelperChange, HelperResult } from "../helper/types";
import {
  mergeWorkspaceDatabaseSnapshots,
  parseWorkspaceDatabaseSnapshot,
  serializeWorkspaceDatabaseSnapshot,
} from "../helper/workspaceDatabaseMerge";
import type { StatusController } from "../ui/status";
import type {
  ConflictController,
  ConflictResolutionResult,
} from "../ui/conflicts";
import { mergeJsoncBuffers, parseJsonc } from "../resources/jsonc";
import { mergeTextBuffers } from "../resources/text";
import { sha256 } from "../protocol/canonical";
import { isRepositoryPayloadFile } from "./watch";
import {
  createRepositoryWatcher,
  type RepositoryWatcher,
} from "./repositoryWatcher";
import {
  absorbedCheckpointManifest,
  effectiveTipProducer,
  effectiveVersionProducer,
  isSyntheticTip,
  producerAsMetadata,
  shouldPublishSnapshot,
} from "./versionPolicy";
import { assertSafeRepositoryLocation } from "./repositoryPath";
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
    if (this.configuration.enabled) {
      await this.syncNow(false);
      await this.startFinalizer();
      this.startWatching();
    }
  }

  async configurationChanged(): Promise<void> {
    this.adapters = this.createAdapters();
    if (!this.configuration.enabled) {
      this.disposeRuntime();
      await this.helper.cancelFinalizers();
      this.status.setStatus("up-to-date", "Automatic synchronization is disabled.");
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
        "Use the same passphrase on every PC. It is not stored in the shared folder.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.length < 12 ? "Use at least 12 characters." : undefined,
    });
    if (passphrase === undefined) {
      return;
    }

    this.disposeRuntime();
    this.masterKey?.fill(0);
    try {
      this.repository = exists
        ? await SyncRepository.open(
            root,
            this.paths.extensionStorage,
            passphrase,
            this.configuration.maxPayloadBytes,
            this.producer,
          )
        : await SyncRepository.create(
            root,
            this.paths.extensionStorage,
            passphrase,
            this.configuration.maxPayloadBytes,
            this.producer,
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
    this.adapters = this.createAdapters();
    if (await this.gitModeFor(root)) {
      await this.commitGitWindow(true, root, "initial sync repository");
    }
    await this.syncNow(true);
    await this.startFinalizer();
    this.startWatching();
    void vscode.window.showInformationMessage(
      "Cursor Setting Sync is configured. The check mark confirms a local shared-folder write, not OneDrive cloud upload completion. The encrypted sync set includes ~/.cursor/mcp.json and cli-config.json, which may contain API keys.",
    );
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
          label: "$(repo-clone) Clone an existing git repository",
          description: "Join a sync repository other devices already push to",
          value: "clone" as const,
        },
        {
          label: "$(repo-create) New git repository with remote",
          description: "Initialize git here; the remote URL may stay empty",
          value: "init" as const,
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
    if (choice.value === "clone") {
      await cloneRepository(remoteUrl, root);
    } else {
      await initRepository(root, remoteUrl.length === 0 ? null : remoteUrl);
    }
    return true;
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
  }

  async restartToApply(): Promise<void> {
    const repository = this.requireRepository();
    const masterKey = this.requireMasterKey();
    assertCompatibleForDatabaseWrite(this.compatibility);
    await this.syncNow(true);
    const lock = await acquireFileLock(join(this.paths.extensionStorage, "sync.lock"));
    if (lock === null) {
      throw new Error("Synchronization is currently busy.");
    }
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
    await this.helper.applyAndRestart(
      this.configuration.repositoryPath ?? repository.root,
      masterKey,
      changes,
      this.configuration.workspaceMappings,
      this.helperSyncOptions(),
      async () => {
        await this.startFinalizer();
      },
    );
  }

  async resolveConflicts(): Promise<void> {
    const repository = this.requireRepository();
    const refreshLock = await acquireFileLock(
      join(this.paths.extensionStorage, "sync.lock"),
    );
    if (refreshLock === null) {
      throw new Error("Synchronization is currently busy.");
    }
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
      const lock = await acquireFileLock(
        join(this.paths.extensionStorage, "sync.lock"),
      );
      if (lock === null) {
        throw new Error("Synchronization is currently busy.");
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
    if (resolution.resolved > 0) {
      await this.syncNow(true);
    } else if (resolution.deferred.length > 0) {
      void vscode.window.showWarningMessage(
        `${resolution.deferred.length} conflict(s) are deferred. ${resolution.deferred[0]}`,
      );
    } else {
      void vscode.window.showInformationMessage(
        "There are no synchronization conflicts to resolve.",
      );
    }
  }

  async restoreVersion(): Promise<void> {
    const repository = this.requireRepository();
    const refreshLock = await acquireFileLock(
      join(this.paths.extensionStorage, "sync.lock"),
    );
    if (refreshLock === null) {
      throw new Error("Synchronization is currently busy.");
    }
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
    const lock = await acquireFileLock(
      join(this.paths.extensionStorage, "sync.lock"),
    );
    if (lock === null) {
      throw new Error("Synchronization is currently busy.");
    }
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
      conflicts:
        repository?.state.conflicts.filter(
          (conflict) => conflict.resolvedAt === undefined,
        ).length ?? 0,
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
    const firstLock = await acquireFileLock(
      join(this.paths.extensionStorage, "sync.lock"),
    );
    if (firstLock === null) {
      throw new Error("Synchronization is currently busy.");
    }
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
    const secondLock = await acquireFileLock(
      join(this.paths.extensionStorage, "sync.lock"),
    );
    if (secondLock === null) {
      throw new Error("Synchronization is currently busy.");
    }
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
    const repository = this.requireRepository();
    const lock = await acquireFileLock(join(this.paths.extensionStorage, "sync.lock"));
    if (lock === null) {
      throw new Error("Synchronization is currently busy.");
    }
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
    const lock = await acquireFileLock(
      join(this.paths.extensionStorage, "sync.lock"),
    );
    if (lock === null) {
      throw new Error("Synchronization is currently busy.");
    }
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
    for (const source of await listFilesRecursively(repository.root)) {
      const relativePath = relative(repository.root, source);
      await copyFileAtomic(source, join(destination, relativePath));
    }
    void vscode.window.showInformationMessage(`Repository archived to ${destination}`);
  }

  dispose(): void {
    this.disposed = true;
    this.disposeRuntime();
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
    const lock = await acquireFileLock(join(this.paths.extensionStorage, "sync.lock"));
    if (lock === null) {
      this.status.log("Skipped sync because another extension host or helper owns the lock.");
      return;
    }
    this.status.setStatus("syncing");
    try {
      const gitActive = await this.openGitWindow(repository);
      await repository.refreshState();
      const checkpoint = await absorbedCheckpointManifest(repository);
      const reconciler = new EventReconciler();
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
      const snapshots = scan.snapshots.filter(
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
      const publishedCount = snapshots.length + deletions.length;
      await repository.publish(snapshots, deletions);

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
        )
      ) {
        result = reconciler.reconcile(
          await repository.listEvents(),
          repository.state,
          checkpoint,
        );
      }
      for (const warning of [
        ...preResult.warnings,
        ...scan.warnings,
        ...result.warnings,
      ]) {
        this.status.log(`Warning: ${warning}`);
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
      this.updateStatus(repository);
    } catch (error) {
      repository.state.lastError =
        error instanceof Error ? error.stack ?? error.message : String(error);
      await repository.saveState();
      this.status.log(`Error: ${repository.state.lastError}`);
      this.status.setStatus("error", repository.state.lastError);
      if (manual) {
        throw error;
      }
    } finally {
      await lock.release();
    }
  }

  private async scanLocalResources(
    known: Record<string, LocalProjection>,
    scope: SyncScope = "all",
    requiredKinds: ReadonlySet<ResourceKind> = new Set(),
  ): Promise<{
    snapshots: ResourceSnapshot[];
    deletions: ResourceDeletion[];
    warnings: string[];
  }> {
    const snapshots: ResourceSnapshot[] = [];
    const deletions: ResourceDeletion[] = [];
    const warnings: string[] = [];
    for (const adapter of this.adapters.filter((candidate) =>
      shouldScanAdapter(candidate, scope, requiredKinds),
    )) {
      // A failing adapter must not abort the whole cycle; deletions come only
      // from completed scans, so skipping the adapter is safe.
      try {
        const result = await adapter.scan(known);
        snapshots.push(...result.snapshots);
        deletions.push(...result.deletions);
        warnings.push(...result.warnings);
      } catch (error) {
        warnings.push(
          `Adapter ${adapter.id} scan failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { snapshots, deletions, warnings };
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
      if (typeof sourceWorkspaceId !== "string") {
        pending.blockedReason = "Incoming workspace metadata is missing a workspace ID.";
        continue;
      }
      if (handled.has(sourceWorkspaceId)) {
        continue;
      }
      handled.add(sourceWorkspaceId);
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
      const resourceLabel =
        pending.kind === "workspace-storage" ? "workspace storage" : "chat";
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
      } else {
        pending.blockedReason = reason;
      }
    }
  }

  private resourceApplyBlockReason(tip: ResourceTip): string | null {
    const configuredBlock = resourceConfigurationBlockReason(tip.kind, {
      syncChat: this.configuration.syncChat,
      syncWorkspaceStorage: this.configuration.syncWorkspaceStorage,
    });
    if (configuredBlock !== null) {
      return configuredBlock;
    }
    return databaseApplyBlockReason(
      tip.kind,
      effectiveTipProducer(tip),
      this.compatibility,
    );
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

  private createAdapters(): ResourceAdapter[] {
    const packageJson: unknown[] = vscode.extensions.all.map(
      (extension): unknown => extension.packageJSON as unknown,
    );
    const adapters: ResourceAdapter[] = [
      new SettingsAdapter(
        this.paths,
        new Set(this.configuration.ignoredSettings),
        collectMachineScopedSettings(packageJson),
      ),
      new ProfileFilesAdapter(this.paths),
      new CursorUserFilesAdapter(
        this.paths,
        normalizeIgnoredUserFiles(this.configuration.ignoredUserFiles),
      ),
      new WorkspaceStorageAdapter(
        this.paths,
        this.configuration.workspaceMappings,
      ),
    ];
    if (this.compatibility.compatible) {
      adapters.push(
        new ProfilesAdapter(this.paths),
        new UiStateAdapter(this.paths),
        new ExtensionsAdapter(
          this.paths,
          new Set(
            this.configuration.ignoredExtensions.map((id) => id.toLowerCase()),
          ),
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
      throw new Error("The configured folder now contains a different repository.");
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
    this.adapters = this.createAdapters();
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
    const packageJson: unknown[] = vscode.extensions.all.map(
      (extension): unknown => extension.packageJSON as unknown,
    );
    return {
      ignoredSettings: this.configuration.ignoredSettings,
      ignoredExtensions: this.configuration.ignoredExtensions,
      ignoredUserFiles: this.configuration.ignoredUserFiles,
      machineScopedSettings: [
        ...collectMachineScopedSettings(packageJson),
      ],
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
  }

  private updateStatus(repository: SyncRepository): void {
    const activeConflicts = repository.state.conflicts.filter(
      (conflict) => conflict.resolvedAt === undefined,
    );
    if (activeConflicts.length > 0) {
      this.status.setStatus(
        "conflict",
        `${activeConflicts.length} synchronization conflict(s) require attention.`,
      );
    } else if (repository.state.pendingDatabaseChanges.length > 0) {
      const blocked = repository.state.pendingDatabaseChanges.filter(
        (change) => change.blockedReason !== undefined,
      ).length;
      const ready = repository.state.pendingDatabaseChanges.length - blocked;
      this.status.setStatus(
        "pending-restart",
        [
          ready > 0 ? `${ready} change(s) are waiting for restart.` : "",
          blocked > 0
            ? `${blocked} newer-version database change(s) are deferred.`
            : "",
        ].filter((message) => message.length > 0).join(" "),
      );
    } else {
      this.status.setStatus("up-to-date");
    }
  }

  private async consumeHelperResults(): Promise<void> {
    for (const path of await listFilesRecursively(this.paths.extensionStorage)) {
      if (!basename(path).startsWith("helper-result-")) {
        continue;
      }
      const result = await readJsonFile<HelperResult>(path);
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
      } else {
        this.status.log(`Helper ${result.requestId} failed: ${result.error ?? "unknown"}`);
        this.status.setStatus("error", result.error ?? "Offline helper failed.");
      }
      await rm(path, { force: true });
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
    return this.repository;
  }

  private requireMasterKey(): Buffer {
    if (this.masterKey === null) {
      throw new Error("Cursor Setting Sync repository is locked.");
    }
    return this.masterKey;
  }
}

type SyncScope = "all" | "files" | "chat" | "remote";

function shouldScanAdapter(
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
  const retainedLocalHash =
    applyResult === undefined
      ? undefined
      : applyResult.semanticHash;
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
      : ["chat", "chat-transcript", "chat-store", "workspace-storage"].includes(
            tip.kind,
          ) &&
          tip.operation === "delete" &&
          retainedLocal !== undefined
        ? { retainedLocalHash: retainedLocal.semanticHash }
        : {}),
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

function queuePending(
  repository: SyncRepository,
  projection: ResourceProjection,
  blockedReason?: string,
): void {
  const tip = projection.tip;
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

export async function autoMergeConflicts(
  repository: SyncRepository,
  conflicts: SyncConflict[],
  canMerge: (tips: ResourceTip[]) => boolean = () => true,
): Promise<boolean> {
  let mergedAny = false;
  for (const conflict of conflicts) {
    if (
      conflict.resolvedAt !== undefined ||
      conflict.tipVersionIds.length !== 2 ||
      conflict.baseVersionId === null
    ) {
      continue;
    }
    const tips = repository.state.tips[conflict.resourceId] ?? [];
    if (tips.length !== 2 || !canMerge(tips)) {
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
    if (await resolveTrivialConflict(repository, conflict, tips, base.change)) {
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
    const outcome = workspaceDatabase
      ? mergeWorkspaceDatabaseBuffers(base.content, local.content, remote.content)
      : isJsonMergeKind(conflict.kind, localTip.metadata)
        ? mergeJsoncBuffers(base.content, local.content, remote.content)
        : validatedTextMergeOutcome(
            conflict.kind,
            mergeTextBuffers(base.content, local.content, remote.content),
          );
    if (
      outcome.status === "conflict" ||
      outcome.content === undefined
    ) {
      continue;
    }
    const snapshot: ResourceSnapshot = {
      resourceId: conflict.resourceId,
      kind: conflict.kind,
      content: outcome.content,
      semanticHash: outcome.semanticHash ?? sha256(outcome.content),
      metadata: {
        ...(localTip.metadata ?? {}),
        syncOrigin: "auto-merge",
      },
    };
    await repository.publish([snapshot], []);
    conflict.resolvedAt = new Date().toISOString();
    mergedAny = true;
  }
  return mergedAny;
}

async function resolveTrivialConflict(
  repository: SyncRepository,
  conflict: SyncConflict,
  tips: ResourceTip[],
  base: ResourceChange,
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
    await repository.publish(
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
    );
  } else {
    await repository.publish(
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
    );
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
  if (
    ["snippet", "task", "mcp", "prompt", "chat-transcript", "keybindings"].includes(
      kind,
    )
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
