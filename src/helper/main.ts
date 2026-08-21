import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { inspectSqliteCapabilities, openDatabase } from "../platform/sqlite";
import {
  cursorExitTimeoutDetail,
  cursorLaunchCommand,
  parseCursorProcessIds,
} from "../platform/compatibility";
import {
  CURSOR_EXIT_WAIT_MS,
  FINALIZER_EXIT_WAIT_MS,
  FINALIZER_LOCK_TRUST_MS,
  APPLY_FAILURE_BLOCK_PREFIX,
  HELPER_REQUEST_VERSION,
  MAX_HELPER_APPLY_WORK_BYTES,
  RESTART_TO_APPLY_TITLE,
} from "../constants";
import { GLOBAL_DATABASE_KINDS } from "../types";
import type {
  LocalProjection,
  ResourceDeletion,
  ResourceKind,
  ResourceScanResult,
  ResourceSnapshot,
  ResourceTip,
} from "../types";
import {
  isMissingPathError,
  pathExists,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/files";
import { commitAndPush, isGitRepository, pullLatest } from "../platform/git";
import { acquireFileLock, type FileLock } from "../platform/lock";
import {
  readRepositoryManifest,
  SyncRepository,
} from "../protocol/repository";
import { classifyLegacyCheckpointMarker } from "../protocol/checkpointMarker";
import { EventReconciler, parentsForLocalChange } from "../protocol/reconciler";
import type { ResourceProjection } from "../protocol/reconciler";
import {
  absorbedCheckpointManifest,
  effectiveSourceDeviceId,
  effectiveSyncOrigin,
  effectiveTipProducer,
  filterPublishableChanges,
  oversizedPayloadWarning,
  publishInBatches,
  shouldPublishSnapshot,
} from "../sync/versionPolicy";
import { chatContinuationApplyBlockReason } from "../sync/chatContinuationPolicy";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import {
  StateVscdbChatAdapter,
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  type PortableChatSnapshot,
} from "../chat/stateVscdb";
import { verifyPortableChatContinuationClosure } from "../chat/continuationClosure";
import { ChatTranscriptsAdapter } from "../chat/transcripts";
import { StoreDbChatAdapter } from "../chat/storeDb";
import {
  lookupWorkspaceIdentityReferences,
  resolveTargetWorkspace,
  selectWorkspaceMappingsForReferences,
} from "../chat/workspace";
import {
  SettingsAdapter,
  createSettingsIgnoreMatcher,
} from "../resources/settings";
import {
  PROFILE_HELPER_DIRECTORY_WORK_ITEMS_PER_SCAN,
  ProfileFilesAdapter,
} from "../resources/profileFiles";
import {
  CURSOR_HELPER_DIRECTORY_WORK_ITEMS_PER_SCAN,
  CursorUserFilesAdapter,
  normalizeIgnoredUserFiles,
} from "../resources/cursorUserFiles";
import { ProfilesAdapter } from "../resources/profiles";
import { UiStateAdapter } from "../resources/uiState";
import { normalizeIgnoredUiStateKeys } from "../resources/uiStatePolicy";
import {
  ExtensionsAdapter,
  createExtensionIgnoreMatcher,
} from "../resources/extensions";
import { WorkspaceStorageAdapter } from "../resources/workspaceStorage";
import { createIgnoreMatcher } from "../resources/ignorePatterns";
import {
  disposeResourceAdapters,
  type ResourceAdapter,
} from "../resources/resource";
import {
  applyGlobalDatabaseChanges,
  recoverInterruptedApplyJournals,
  restoreDatabaseBackup,
  type PreparedHelperChange,
} from "./database";
import { applyNonGlobalChanges, CursorReopenedError } from "./resourceApply";
import type { HelperBackup, HelperChange, HelperRequest, HelperResult } from "./types";
import {
  cursorProcessListingDecision,
  type CursorProcessListingState,
} from "./processListingCadence";

const execFileAsync = promisify(execFile);
const MAX_FINAL_EXPORT_CHAT_SCAN_PASSES = 32;
const MAX_FINAL_EXPORT_PROFILE_SCAN_PASSES = 256;

function finalExportPassLimit(adapter: ResourceAdapter): number {
  return adapter.id === "settings" || adapter.id === "extensions"
    ? MAX_FINAL_EXPORT_PROFILE_SCAN_PASSES
    : MAX_FINAL_EXPORT_CHAT_SCAN_PASSES;
}

/**
 * Stamped once at process start so every result can say how long the offline
 * pass took. Cursor is closed for the whole of one, so the completion line is
 * the only place that duration is ever visible.
 */
const HELPER_STARTED_AT = new Date().toISOString();

interface CollectedBackups {
  backupPath: string | null;
  backups: HelperBackup[];
}

class CursorExitTimeoutError extends Error {
  constructor(detail: string) {
    super(`Timed out waiting for Cursor to exit. ${detail}`);
    this.name = "CursorExitTimeoutError";
  }
}


void run();

async function run(): Promise<void> {
  const requestPath = process.argv[2];
  if (requestPath === undefined) {
    process.stderr.write("A helper request path is required.\n");
    process.exitCode = 2;
    return;
  }

  let masterKey: Buffer | null = null;
  let request: HelperRequest | null = null;
  let cursorExitConfirmed = false;
  let finalizerLock: FileLock | null = null;
  const collected: CollectedBackups = { backupPath: null, backups: [] };
  try {
    request = await readJsonFile<HelperRequest>(requestPath);
    validateRequest(request);
    masterKey = Buffer.from((await readStdin()).trim(), "base64");
    if (masterKey.byteLength !== 32) {
      throw new Error("The helper received an invalid repository key.");
    }
    await assertRuntimeVersion(request);
    if (request.mode === "final-export") {
      finalizerLock = await acquireFileLock(
        join(request.storageRoot, "shutdown-finalizer.lock"),
      );
      if (finalizerLock === null) {
        await writeResult(
          request,
          successResult(
            request,
            [],
            ["Another shutdown finalizer is already active."],
            null,
          ),
        );
        return;
      }
    }
    const cancelled = await waitForCursorExit(
      request,
      request.mode === "final-export"
        ? FINALIZER_EXIT_WAIT_MS
        : CURSOR_EXIT_WAIT_MS,
    );
    if (cancelled) {
      await writeResult(
        request,
        successResult(request, [], ["Final export was superseded."], null),
      );
      return;
    }
    cursorExitConfirmed = true;
    const lock = await acquireSyncLock(request.storageRoot, 180_000);

    try {
      // The exit wait finished before the lock wait began, and the lock can
      // take minutes when a finalizer is mid-export - long enough for the
      // user to have relaunched Cursor. Every destructive write below
      // re-checks through this rather than trusting the wait above.
      const cursorRequest = request;
      const ensureCursorStillClosed = async (): Promise<void> => {
        if (!(await noOtherCursorProcesses(cursorRequest))) {
          throw new CursorReopenedError(
            "Cursor was reopened before offline changes could be applied. Close Cursor and try again.",
          );
        }
      };
      const recoveryNotices: string[] = [];
      await recoverInterruptedApplyJournals(
        request.storageRoot,
        request.paths.globalDatabase,
        ensureCursorStillClosed,
        (backup) => collected.backups.push(backup),
        (message) => recoveryNotices.push(message),
      );
      const result = await executeRequest(
        request,
        masterKey,
        collected,
        () => {
          lock.refresh();
        },
        recoveryNotices,
      );
      await writeResult(request, result);
      if (request.restart && result.success) {
        restartCursor(request.cursorExecutable);
      }
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (request !== null) {
      const result: HelperResult = {
        requestId: request.requestId,
        mode: request.mode,
        success: false,
        // Not a failure the user has to act on; see HelperResult.interrupted.
        ...(error instanceof CursorReopenedError ? { interrupted: true } : {}),
        startedAt: HELPER_STARTED_AT,
        completedAt: new Date().toISOString(),
        applied: [],
        skipped: [],
        backupPath: collected.backupPath,
        ...(collected.backups.length === 0 ? {} : { backups: collected.backups }),
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      };
      await writeResult(request, result);
      // When Cursor is already running again, spawning another instance would
      // only multiply windows; restart applies to a fully closed Cursor.
      // `cursorExitConfirmed` covers every failure thrown before the exit
      // wait finished - enumerating error classes did not, so a validation
      // error during the wait relaunched Cursor beside the one still open.
      const cursorStillRunning =
        error instanceof CursorReopenedError ||
        error instanceof CursorExitTimeoutError;
      if (
        request.restart &&
        cursorExitConfirmed &&
        !cursorStillRunning &&
        (await databaseIsHealthy(request.paths.globalDatabase))
      ) {
        restartCursor(request.cursorExecutable);
      }
    } else {
      process.stderr.write(
        `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
    }
    process.exitCode = 1;
  } finally {
    await finalizerLock?.release();
    masterKey?.fill(0);
    await rm(requestPath, { force: true });
  }
}

async function executeRequest(
  request: HelperRequest,
  masterKey: Buffer,
  collected: CollectedBackups,
  /**
   * Keeps `sync.lock` alive across the apply. The writes are synchronous, so
   * the lock's own heartbeat timer cannot run and the file goes stale under a
   * holder that is very much alive - after which another process takes it over
   * mid-write.
   */
  heartbeat: () => void = () => {},
  /**
   * What journal recovery did before this request ran - a replayed or
   * refused interrupted restore. Folded into the result's warnings so a
   * destructive replay the user never watched is impossible to miss.
   */
  recoveryNotices: readonly string[] = [],
): Promise<HelperResult> {
  const gitWarnings: string[] = [...recoveryNotices];
  // A restore reads no events and publishes none, so the network pull is pure
  // window: up to ten minutes during which Cursor is visibly closed and the
  // user has every reason to reopen it before the destructive write begins.
  const gitActive =
    request.mode === "restore-backup"
      ? false
      : await beginGitTransport(request, gitWarnings);
  const repositoryFile = await readRepositoryManifest(request.repositoryRoot);
  const repository = await SyncRepository.openWithMasterKey(
    request.repositoryRoot,
    request.storageRoot,
    repositoryFile,
    masterKey,
    request.syncOptions.maxPayloadBytes,
    {
      extensionVersion: request.extensionVersion,
      cursorVersion: request.expectedCursorVersion,
      vscodeVersion: request.expectedVscodeVersion,
    },
  );
  const ensureExclusiveAccess = async (): Promise<void> => {
    if (!(await noOtherCursorProcesses(request))) {
      throw new CursorReopenedError(
        "Cursor was reopened before offline changes could be applied. Close Cursor and try again.",
      );
    }
  };
  // A restore the user confirmed but whose helper has not run yet names a
  // backup file as its source; an apply interleaving before it must not let
  // retention evict that file, or the restore fails on a source this
  // extension deleted seconds earlier.
  const pendingRestoreSources = await pendingRestoreSourceBackups(
    request.storageRoot,
  );
  const priorBackupPaths = (): string[] => [
    ...collected.backups.map((backup) => backup.backupPath),
    ...pendingRestoreSources,
  ];

  if (request.mode === "restore-backup") {
    if (request.backupToRestore === undefined) {
      throw new Error("Restore request does not specify a backup.");
    }
    const restoreTargetPath =
      request.restoreTargetPath ?? request.paths.globalDatabase;
    const restoreContract = request.restoreContract ?? "global";
    const preRestoreBackupPath = await restoreDatabaseBackup(
      restoreTargetPath,
      request.backupToRestore,
      request.storageRoot,
      request.requestId,
      restoreContract,
      // Re-checked immediately before the DELETE+INSERT, not just at the exit
      // wait: validating a 1.3 GiB backup and capturing the pre-restore
      // snapshot takes minutes, and a restore committed under a relaunched
      // Cursor is silently undone by its in-memory write-back at quit.
      ensureExclusiveAccess,
    );
    collected.backups.push({
      backupPath: preRestoreBackupPath,
      contract: restoreContract,
      targetPath: restoreTargetPath,
    });
    return successResult(
      request,
      [],
      gitWarnings,
      request.backupToRestore,
      collected.backups,
      gitWarnings,
    );
  }

  const exported = await exportFinalChanges(request, repository, heartbeat);
  // Everything that means a resource did NOT reach the repository: a git
  // transport failure, an adapter that threw during the shutdown scan, or a
  // snapshot dropped for exceeding the payload limit. These are reported apart
  // from the routine `skipped` entries so the extension host can raise a
  // standing warning for them without also flagging every deliberately
  // retained tombstone and every superseded change.
  const warnings = [...gitWarnings, ...exported.warnings];
  // The shutdown finalizer applies the queue too, when the user has left that
  // on. This is the moment the queue was always waiting for - Cursor is closed
  // because the user closed it - and it costs them nothing: no modal, no
  // second quit, no relaunch (`request.restart` is false for this mode). The
  // alternative they lived with was a dialog on every launch offering to quit
  // the editor they had just opened.
  const shutdownApply =
    request.mode === "final-export" &&
    request.syncOptions.applyOnShutdown !== false;
  if (request.mode === "final-export" && !shutdownApply) {
    await finishGitTransport(
      gitActive,
      request.repositoryRoot,
      `shutdown export (${repository.state.device.deviceId.slice(0, 8)})`,
      warnings,
    );
    return successResult(
      request,
      [],
      [...warnings, ...exported.notices],
      null,
      [],
      warnings,
    );
  }
  await ensureExclusiveAccess();

  const reconciler = new EventReconciler();
  const checkpoint = await absorbedCheckpointManifest(repository);
  const reconcileResult = reconciler.reconcile(
    await repository.listReconciliationEvents(checkpoint),
    repository.state,
    checkpoint,
  );
  // Read from the queue for a shutdown, handed over for an explicit apply; see
  // {@link shutdownApplyBatch} for why the finalizer cannot use a list decided
  // at arm time.
  const requestedChanges = shutdownApply
    ? shutdownApplyBatch(repository, reconcileResult.projections)
    : request.changes;
  const pageVerifiedChanges = intersectVerifiedApplyPage(
    requestedChanges,
    exported.verifiedApplyVersionIds,
  );
  const exportBlockReasons = new Map(
    pageVerifiedChanges.flatMap((change) => {
      const reason = finalExportApplyBlockReason(change, exported);
      return reason === null ? [] : [[change.resourceId, reason] as const];
    }),
  );
  for (const [resourceId, reason] of exportBlockReasons) {
    warnings.push(`Applying ${resourceId} was deferred: ${reason}`);
  }
  const eligible = pageVerifiedChanges.filter(
    (change) =>
      !exportBlockReasons.has(change.resourceId) &&
      isEligible(
        change,
        reconcileResult.projections,
        repository.state.conflicts,
      ),
  );
  const skipped = [
    ...pageVerifiedChanges
    .filter((change) => !eligible.includes(change))
    .map((change) => {
      const exportBlock = exportBlockReasons.get(change.resourceId);
      return exportBlock === undefined
        ? `${change.resourceId}: superseded or conflicted`
        : `${change.resourceId}: ${exportBlock}`;
    }),
  ];
  const preparation = await prepareChanges(repository, eligible);
  skipped.push(...preparation.skipped);
  // A payload this computer cannot read is a real failure, not a routine skip:
  // it never heals on its own, so it has to be visible and it has to stop
  // being offered. "Not yet synced" is deliberately not in this map - that one
  // does heal, and blocking it would make the user run the command by hand for
  // a file the shared folder is about to deliver.
  for (const [resourceId, message] of Object.entries(
    preparation.failureByResourceId,
  )) {
    warnings.push(`Preparing ${resourceId}: ${message}`);
  }
  const prepared = preparation.prepared;

  // Every kind that lives in the global `state.vscdb`. Missing one here does
  // not fail loudly: the change is prepared, routed to neither applier, and
  // dropped - so it is never marked applied and sits in the queue forever,
  // re-offered on every launch and applied by nothing. `remote-targets` was
  // added in 0.0.48 with its write path in the database layer but not with
  // this list, and the SSH folder history it carries never once landed on
  // either computer.
  const globalPrepared = prepared.filter((item) =>
    GLOBAL_DATABASE_KINDS.includes(item.change.kind),
  );
  let backupPath: string | null = null;
  const applied: string[] = [];
  const retainedLocal = new Set<string>();
  const globalRetainedHashes: Record<string, string> = {};
  const globalLocalChatCoreHashes: Record<string, string | null> = {};
  const globalFailureByResourceId: Record<string, string> = {};
  if (globalPrepared.length > 0) {
    await ensureExclusiveAccess();
    const globalResult = await applyGlobalDatabaseChanges(
      request,
      globalPrepared,
      heartbeat,
      ensureExclusiveAccess,
      priorBackupPaths,
      repository.state.device.deviceId,
    );
    backupPath = globalResult.backupPath;
    collected.backupPath = backupPath;
    collected.backups.push({
      backupPath,
      contract: "global",
      targetPath: request.paths.globalDatabase,
    });
    applied.push(...globalResult.applied);
    skipped.push(...globalResult.skipped);
    Object.assign(
      globalFailureByResourceId,
      globalResult.failureByResourceId,
    );
    for (const [resourceId, message] of Object.entries(
      globalResult.failureByResourceId,
    )) {
      warnings.push(`Applying ${resourceId}: ${message}`);
    }
    for (const resourceId of globalResult.retainedLocal) {
      retainedLocal.add(resourceId);
    }
    Object.assign(globalRetainedHashes, globalResult.retainedLocalHashes);
    Object.assign(
      globalLocalChatCoreHashes,
      globalResult.localChatCoreHashes,
    );
  }

  const nonGlobalResult = await applyNonGlobalChanges(
    request,
    prepared,
    ensureExclusiveAccess,
    (backup) => collected.backups.push(backup),
    heartbeat,
    // The pre-apply global snapshot above must survive every retention pass
    // the non-global applies run - it is the request's only pre-apply
    // recovery point for the global database - and so must any queued
    // restore's source.
    priorBackupPaths,
  );
  applied.push(...nonGlobalResult.applied);
  skipped.push(...nonGlobalResult.skipped);
  // Real per-resource failures ride the warnings channel: warnings become
  // standing in the extension host, so a resource that fails every apply is
  // visible instead of buried between routine skip lines in a green result.
  warnings.push(...nonGlobalResult.failures);
  for (const resourceId of nonGlobalResult.retainedLocal) {
    retainedLocal.add(resourceId);
  }
  markAppliedProjections(
    repository,
    eligible,
    applied,
    retainedLocal,
    { ...globalRetainedHashes, ...nonGlobalResult.retainedLocalHashes },
    globalLocalChatCoreHashes,
    {
      ...preparation.failureByResourceId,
      ...globalFailureByResourceId,
      ...nonGlobalResult.failureByResourceId,
    },
  );
  await repository.saveState();
  await finishGitTransport(
    gitActive,
    request.repositoryRoot,
    shutdownApply
      ? `shutdown export and apply (${repository.state.device.deviceId.slice(0, 8)})`
      : `apply (${request.requestId.slice(0, 8)})`,
    warnings,
  );
  return successResult(
    request,
    applied,
    [...warnings, ...skipped, ...exported.notices],
    backupPath,
    collected.backups,
    warnings,
  );
}

async function beginGitTransport(
  request: HelperRequest,
  warnings: string[],
): Promise<boolean> {
  if (request.syncOptions.gitSync === false) {
    return false;
  }
  try {
    if (!(await isGitRepository(request.repositoryRoot))) {
      return false;
    }
    await pullLatest(request.repositoryRoot);
    return true;
  } catch (error) {
    // A git failure must never fail the local apply or export; the warning
    // line surfaces through the helper result on the next activation.
    warnings.push(
      `git pull skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function finishGitTransport(
  active: boolean,
  repositoryRoot: string,
  message: string,
  warnings: string[],
): Promise<void> {
  if (!active) {
    return;
  }
  try {
    await commitAndPush(repositoryRoot, message);
  } catch (error) {
    warnings.push(
      `git push skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface FinalExportOutcome {
  warnings: string[];
  notices: string[];
  /** Exact local resources whose current state was not safe to publish. */
  protectedLocalResourceIds: string[];
  /** Adapter kinds whose final local state could not be identified exactly. */
  incompleteKinds: ResourceKind[];
  /** Authenticated versions whose exact local targets this pass verified. */
  verifiedApplyVersionIds: string[];
}

async function exportFinalChanges(
  request: HelperRequest,
  repository: SyncRepository,
  heartbeat: () => void = () => {},
): Promise<FinalExportOutcome> {
  const reconciler = new EventReconciler();
  const checkpoint = await absorbedCheckpointManifest(repository);
  const preResult = reconciler.reconcile(
    await repository.listReconciliationEvents(checkpoint),
    repository.state,
    checkpoint,
  );
  const targetChanges = finalExportTargetPage(
    request,
    repository,
    preResult.projections,
  );
  const conflictedResources = new Set(
    repository.state.conflicts
      .filter((conflict) => conflict.resolvedAt === undefined)
      .map((conflict) => conflict.resourceId),
  );
  const protectedSyntheticResources = new Set(
    targetChanges
      .filter((change) => isSyntheticChange(change))
      .map((change) => change.resourceId),
  );
  const forceCoreVerificationResourceIds = targetChanges
    .filter(
      (change) => chatTipMayReplaceLocalCore(change),
    )
    .map((change) => change.resourceId);
  // A queued incoming tip may overwrite a local edit whose mtime was restored
  // by a copy/sync tool. Timestamp and persisted file identity shortcuts are
  // disabled for these exact targets during the pre-apply export.
  const forceTargetVerificationResourceIds = new Set(
    targetChanges.map((change) => change.resourceId),
  );
  const workspaceMappings = await resolveWorkspaceStorageMappings(
    request,
    targetChanges,
  );
  const adapters: ResourceAdapter[] = [
    new SettingsAdapter(
      request.paths,
      createSettingsIgnoreMatcher(request.syncOptions.ignoredSettings),
      createSettingsIgnoreMatcher(request.syncOptions.machineScopedSettings),
    ),
    new ProfileFilesAdapter(request.paths, {
      forceVerificationResourceIds: forceTargetVerificationResourceIds,
      maxEnumerationWorkItemsPerScan:
        PROFILE_HELPER_DIRECTORY_WORK_ITEMS_PER_SCAN,
    }),
    new CursorUserFilesAdapter(
      request.paths,
      normalizeIgnoredUserFiles(request.syncOptions.ignoredUserFiles ?? []),
      process.platform,
      {
        maxEnumerationWorkItemsPerScan:
          CURSOR_HELPER_DIRECTORY_WORK_ITEMS_PER_SCAN,
        forceVerificationResourceIds: forceTargetVerificationResourceIds,
      },
    ),
    new ProfilesAdapter(request.paths, {
      forceVerificationResourceIds: forceTargetVerificationResourceIds,
    }),
    new UiStateAdapter(
      request.paths,
      normalizeIgnoredUiStateKeys(request.syncOptions.ignoredUiStateKeys ?? []),
      { forceVerificationResourceIds: forceTargetVerificationResourceIds },
    ),
    new ExtensionsAdapter(
      request.paths,
      createExtensionIgnoreMatcher(request.syncOptions.ignoredExtensions),
    ),
  ];
  if (request.syncOptions.syncWorkspaceStorage) {
    adapters.push(
      new WorkspaceStorageAdapter(
        request.paths,
        workspaceMappings,
        request.syncOptions.maxPayloadBytes,
        createIgnoreMatcher(request.syncOptions.ignoredWorkspaces ?? []),
        false,
        { forceVerificationResourceIds: forceTargetVerificationResourceIds },
      ),
    );
  }
  let stateChatAdapter: StateVscdbChatAdapter | null = null;
  if (request.syncOptions.syncChat) {
    stateChatAdapter = new StateVscdbChatAdapter(request.paths, {
      // A fresh shutdown helper must verify changed headers and message counts,
      // but it must not start the extension host's periodic equal-count sweep
      // from zero on every launch. That full sweep is stateful polling work.
      periodicDeepVerification: false,
      // One concurrent database generation gets a fresh stable pass. If an
      // external writer keeps changing the supposedly offline database, the
      // monotonic frontier then stabilizes and the 32-pass guard fails closed.
      maxProgressDatabaseGenerationRestarts: 1,
      forceCoreVerificationResourceIds,
    });
    adapters.push(
      stateChatAdapter,
      new ChatTranscriptsAdapter(request.paths, {
        forceVerificationResourceIds: forceTargetVerificationResourceIds,
      }),
      new StoreDbChatAdapter(request.paths, {
        forceVerificationResourceIds: forceTargetVerificationResourceIds,
      }),
    );
  }
  try {
  const snapshots: ResourceSnapshot[] = [];
  const deletions: ResourceDeletion[] = [];
  const warnings: string[] = [];
  // Deliberate exclusions, kept out of `warnings` so a device that has merely
  // been configured does not sit permanently at "Partial - some resources were
  // not saved to the repository". They are re-derived on every run and none of
  // them is a failure.
  const notices: string[] = [];
  const protectedLocalResourceIds = new Set<string>();
  const incompleteKinds = new Set<ResourceKind>();
  const publishedEventHashes = new Set<string>();
  for (const adapter of adapters) {
    adapter.setMaxPayloadBytes?.(request.syncOptions.maxPayloadBytes);
    const drainsBounded = typeof adapter.scanStatus === "function";
    let scanKnown = drainsBounded
      ? localProjectionOverlay(repository.state.projections)
      : repository.state.projections;
    const passLimit = drainsBounded ? finalExportPassLimit(adapter) : 1;
    let pass = 0;
    let lastProgressToken: number | undefined;
    let stagnantPasses = 0;
    while (true) {
      pass += 1;
      let result: ResourceScanResult;
      try {
        result = await adapter.scan(scanKnown);
      } catch (error) {
        // One failing adapter must not abort the whole shutdown export, but an
        // incoming write of that kind cannot safely follow an unknown final
        // local observation in the same helper run.
        warnings.push(
          `${adapter.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        for (const kind of adapter.kinds) {
          incompleteKinds.add(kind);
        }
        break;
      }
      warnings.push(...result.warnings);
      notices.push(...(result.notices ?? []));
      const prepared = prepareFinalExportScanChanges(
        result,
        scanKnown,
        repository,
        conflictedResources,
        protectedSyntheticResources,
      );

      // The configured chat adapter normally settles oversized snapshots
      // inside scan() so they never consume the 8 MiB retained-result budget.
      // Keep the external hook as a fail-safe for any adapter that returns one.
      for (const snapshot of result.snapshots) {
        if (
          snapshot.content.byteLength > request.syncOptions.maxPayloadBytes &&
          adapter.settleOversizedSnapshot?.(
            snapshot,
            request.syncOptions.maxPayloadBytes,
          ) === true
        ) {
          protectedLocalResourceIds.add(snapshot.resourceId);
        }
      }
      for (
        const settlement of
        adapter.oversizedSnapshotSettlements?.(
          request.syncOptions.maxPayloadBytes,
        ) ?? []
      ) {
        protectedLocalResourceIds.add(settlement.resourceId);
        warnings.push(
          settlement.warning ??
            oversizedPayloadWarning(
              settlement.resourceId,
              settlement.byteLength,
              settlement.maxPayloadBytes,
            ),
        );
      }

      if (!drainsBounded) {
        snapshots.push(...prepared.snapshots);
        deletions.push(...prepared.deletions);
        break;
      }

      // Publish each bounded chat result before asking the same stateful
      // adapter for another page. This releases payload buffers between passes
      // and lets the provisional `known` view acknowledge returned snapshots;
      // otherwise pendingSnapshots makes scanStatus incomplete forever.
      const publishable = filterPublishableChanges(
        prepared.snapshots,
        prepared.deletions,
        request.syncOptions.maxPayloadBytes,
      );
      warnings.push(...publishable.warnings);
      for (const eventHash of await publishInBatches(
        repository,
        publishable.snapshots,
        publishable.deletions,
      )) {
        publishedEventHashes.add(eventHash);
      }
      const status = adapter.scanStatus?.();
      const progressToken = status?.progressToken;
      const progressAware = progressToken !== undefined;
      const pageNeedsAcknowledgement =
        result.snapshots.length > 0 || result.deletions.length > 0;
      // Keep the exact same overlay identity on a zero-emission page. Bounded
      // adapters use reference identity to distinguish a repository ACK from
      // another look at the same local failure. Rebuilding the proxy every
      // pass made a permanent oversized overflow start a fresh header sweep,
      // manufacture a new progress token, and bypass the 32-stagnant-pass
      // fail-closed guard forever.
      const nextPageKnown =
        progressAware && pageNeedsAcknowledgement
          ? localProjectionOverlay(repository.state.projections)
          : scanKnown;
      for (const snapshot of result.snapshots) {
        const provisional = provisionalLocalProjection(
          snapshot,
          scanKnown[snapshot.resourceId],
        );
        if (progressAware) {
          repository.state.projections[snapshot.resourceId] = provisional;
        } else {
          nextPageKnown[snapshot.resourceId] = provisional;
        }
      }
      for (const deletion of result.deletions) {
        const provisional = provisionalLocalProjection(
          deletion,
          scanKnown[deletion.resourceId],
        );
        if (progressAware) {
          repository.state.projections[deletion.resourceId] = provisional;
        } else {
          nextPageKnown[deletion.resourceId] = provisional;
        }
      }

      if (status === undefined || status.complete) {
        if (adapter === stateChatAdapter) {
          rememberLearnedChatProjectionSources(
            repository.state.projections,
            scanKnown,
          );
        }
        break;
      }
      if (progressAware) {
        const tokenAdvanced =
          lastProgressToken === undefined ||
          progressToken > lastProgressToken;
        lastProgressToken = progressToken;
        stagnantPasses = tokenAdvanced ? 0 : stagnantPasses + 1;
        if (stagnantPasses < MAX_FINAL_EXPORT_CHAT_SCAN_PASSES) {
          // Only the just-published page is needed to acknowledge the next
          // scan. Rebuilding the lazy overlay here prevents a 100k tree drain
          // from retaining 100k provisional projections.
          scanKnown = nextPageKnown;
          heartbeat();
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
      } else if (pass < passLimit) {
        continue;
      }
      for (const resourceId of status.deferredResourceIds) {
        protectedLocalResourceIds.add(resourceId);
      }
      // A bounded enumeration can know that an unvisited directory exists
      // without knowing the resource IDs it contains.  Exact deferred IDs are
      // still useful diagnostics, but after the finite helper drain every kind
      // owned by that adapter must fail closed for this run.
      for (const kind of adapter.kinds) {
        incompleteKinds.add(kind);
      }
      warnings.push(
        `The final ${adapter.id} export remained incomplete after ${
          progressAware
            ? `${stagnantPasses} consecutive no-progress passes`
            : `${passLimit} bounded passes`
        }; ${
          status.deferredResourceIds.length === 0
            ? "incoming changes of this kind"
            : `${status.deferredResourceIds.length} deferred local resource(s)`
        } will not be applied in this helper run.`,
      );
      if (adapter === stateChatAdapter) {
        rememberLearnedChatProjectionSources(
          repository.state.projections,
          scanKnown,
        );
      }
      break;
    }
  }
  // This is the ONLY path that backs up workspaceStorage, so it must survive an
  // oversized or oversized-in-count batch instead of losing the whole export.
  // A resource above the payload limit is dropped with a warning that names it;
  // more than MAX_EVENT_CHANGES changes are split across several events.
  const publishable = filterPublishableChanges(
    snapshots,
    deletions,
    request.syncOptions.maxPayloadBytes,
  );
  warnings.push(...publishable.warnings);
  for (const eventHash of await publishInBatches(
    repository,
    publishable.snapshots,
    publishable.deletions,
  )) {
    publishedEventHashes.add(eventHash);
  }
  const result = reconciler.reconcile(
    await repository.listReconciliationEvents(checkpoint),
    repository.state,
    checkpoint,
  );
  for (const projection of result.projections) {
    if (
      publishedEventHashes.has(projection.tip.eventHash) &&
      projection.tip.deviceId === repository.state.device.deviceId &&
      !result.conflicts.some(
        (conflict) => conflict.resourceId === projection.resourceId,
      )
    ) {
      repository.state.projections[projection.resourceId] = {
        resourceId: projection.resourceId,
        kind: projection.tip.kind,
        semanticHash: projection.tip.semanticHash,
        versionId: projection.tip.versionId,
        ...(projection.tip.payload === undefined
          ? {}
          : { payloadObjectId: projection.tip.payload.objectId }),
        ...(typeof projection.tip.metadata?.bubbleCount === "number"
          ? { sourceBubbleCount: projection.tip.metadata.bubbleCount }
          : {}),
        ...(typeof projection.tip.metadata?.lastUpdatedAt === "number"
          ? { sourceTimestamp: projection.tip.metadata.lastUpdatedAt }
          : {}),
        ...(validFileSize(projection.tip.metadata?.sourceFileSize)
          ? { sourceFileSize: projection.tip.metadata.sourceFileSize }
          : {}),
        ...(validFileTime(projection.tip.metadata?.sourceFileCtimeMs)
          ? { sourceFileCtimeMs: projection.tip.metadata.sourceFileCtimeMs }
          : {}),
        ...(isChatCoreHash(projection.tip.metadata?.chatCoreHash)
          ? { sourceChatCoreHash: projection.tip.metadata.chatCoreHash }
          : {}),
        ...(isChatCoreHash(projection.tip.metadata?.headerFingerprint)
          ? {
              sourceHeaderFingerprint:
                projection.tip.metadata.headerFingerprint,
            }
          : {}),
      };
    }
  }
  await repository.saveState();
  await repository.writeAck();
  return {
    warnings: [...new Set(warnings)],
    notices: [...new Set(notices)],
    protectedLocalResourceIds: [...protectedLocalResourceIds].sort(),
    incompleteKinds: [...incompleteKinds].sort(),
    verifiedApplyVersionIds: targetChanges.map(helperChangeVersionId),
  };
  } finally {
    // A bounded scan normally finishes by closing its last directory. Error,
    // no-progress, and pass-limit exits do not, so the one-shot helper must
    // retire every adapter generation explicitly before its process can linger.
    await disposeResourceAdapters(adapters);
  }
}

function helperChangeVersionId(change: HelperChange): string {
  return `${change.eventHash}#${change.changeIndex}`;
}

function intersectVerifiedApplyPage(
  changes: readonly HelperChange[],
  verifiedVersionIds: readonly string[],
): HelperChange[] {
  const verified = new Set(verifiedVersionIds);
  return changes.filter((change) =>
    verified.has(helperChangeVersionId(change)),
  );
}

function prepareFinalExportScanChanges(
  result: ResourceScanResult,
  known: Readonly<Record<string, LocalProjection>>,
  repository: SyncRepository,
  conflictedResources: ReadonlySet<string>,
  protectedSyntheticResources: ReadonlySet<string>,
): { snapshots: ResourceSnapshot[]; deletions: ResourceDeletion[] } {
  const snapshots = result.snapshots
    .filter((snapshot) => {
      if (conflictedResources.has(snapshot.resourceId)) {
        return false;
      }
      const projection = known[snapshot.resourceId];
      if (
        protectedSyntheticResources.has(snapshot.resourceId) &&
        projection !== undefined &&
        (projection.semanticHash === snapshot.semanticHash ||
          projection.retainedLocalHash === snapshot.semanticHash)
      ) {
        // The synthetic tip is still waiting to apply and this is merely the
        // same pre-apply local form the projection already describes. Do not
        // publish it on top of the queued operation. A genuinely newer local
        // snapshot is different from both hashes and must be published now;
        // otherwise the same shutdown would apply the stale synthetic tip and
        // overwrite an edit made after it was queued.
        return false;
      }
      return shouldPublishSnapshot(
        projection,
        snapshot,
        repository.state.tips[snapshot.resourceId] ?? [],
      );
    })
    .map((snapshot) => ({
      ...snapshot,
      parents: parentsForLocalChange(
        repository.state.projections[snapshot.resourceId],
        repository.state.tips[snapshot.resourceId] ?? [],
      ),
    }));
  const deletions = result.deletions
    .filter(
      (deletion) => {
        if (conflictedResources.has(deletion.resourceId)) {
          return false;
        }
        const projection = known[deletion.resourceId];
        if (
          protectedSyntheticResources.has(deletion.resourceId) &&
          projection !== undefined &&
          (projection.semanticHash === deletion.semanticHash ||
            projection.retainedLocalHash === deletion.semanticHash)
        ) {
          return false;
        }
        return (
          !(repository.state.tips[deletion.resourceId] ?? []).some(
          (tip) =>
            tip.operation === "delete" &&
            tip.semanticHash === deletion.semanticHash,
          ) && projection?.semanticHash !== deletion.semanticHash
        );
      },
    )
    .map((deletion) => ({
      ...deletion,
      parents: parentsForLocalChange(
        repository.state.projections[deletion.resourceId],
        repository.state.tips[deletion.resourceId] ?? [],
      ),
    }));
  return { snapshots, deletions };
}

function localProjectionOverlay(
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
      // Adapters treat `known` as read-only. Returning the base projection
      // directly keeps a settings page that checks 4k old keys from cloning
      // all 4k into the overlay; only explicit page ACK writes enter `target`.
      return source;
    },
    has(target, property) {
      return (
        Reflect.has(target, property) ||
        (typeof property === "string" && projections[property] !== undefined)
      );
    },
    // Object.keys/entries intentionally expose only the bounded touched delta;
    // adapters must never turn a page lookup into an O(all projections) copy.
    ownKeys: (target) => Reflect.ownKeys(target),
    getOwnPropertyDescriptor(target, property) {
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}

function provisionalLocalProjection(
  change: ResourceSnapshot | ResourceDeletion,
  previous: LocalProjection | undefined,
): LocalProjection {
  return {
    resourceId: change.resourceId,
    kind: change.kind,
    semanticHash: change.semanticHash,
    versionId: previous?.versionId ?? null,
    ...(previous?.payloadObjectId === undefined
      ? {}
      : { payloadObjectId: previous.payloadObjectId }),
    ...(typeof change.metadata?.lastUpdatedAt === "number"
      ? { sourceTimestamp: change.metadata.lastUpdatedAt }
      : {}),
    ...(validFileSize(change.metadata?.sourceFileSize)
      ? { sourceFileSize: change.metadata.sourceFileSize }
      : {}),
    ...(validFileTime(change.metadata?.sourceFileCtimeMs)
      ? { sourceFileCtimeMs: change.metadata.sourceFileCtimeMs }
      : {}),
    ...(typeof change.metadata?.bubbleCount === "number"
      ? { sourceBubbleCount: change.metadata.bubbleCount }
      : {}),
    ...(isChatCoreHash(change.metadata?.chatCoreHash)
      ? { sourceChatCoreHash: change.metadata.chatCoreHash }
      : {}),
    ...(isChatCoreHash(change.metadata?.headerFingerprint)
      ? { sourceHeaderFingerprint: change.metadata.headerFingerprint }
      : {}),
  };
}

function rememberLearnedChatProjectionSources(
  persistent: Record<string, LocalProjection>,
  observed: Readonly<Record<string, LocalProjection>>,
): void {
  for (const [resourceId, projection] of Object.entries(observed)) {
    const target = persistent[resourceId];
    if (
      target?.kind !== "chat" ||
      projection.kind !== "chat" ||
      target.semanticHash !== projection.semanticHash
    ) {
      continue;
    }
    if (projection.sourceTimestamp !== undefined) {
      target.sourceTimestamp = projection.sourceTimestamp;
    }
    if (projection.sourceBubbleCount !== undefined) {
      target.sourceBubbleCount = projection.sourceBubbleCount;
    }
    if (projection.sourceChatCoreHash !== undefined) {
      target.sourceChatCoreHash = projection.sourceChatCoreHash;
    }
    if (projection.sourceHeaderFingerprint !== undefined) {
      target.sourceHeaderFingerprint = projection.sourceHeaderFingerprint;
    }
    if (projection.requiresAgentKvRecapture === true) {
      target.requiresAgentKvRecapture = true;
    }
  }
}

function chatTipMayReplaceLocalCore(
  tip: Pick<ResourceTip, "kind" | "operation" | "metadata">,
): boolean {
  if (tip.kind !== "chat") {
    return false;
  }
  if (tip.operation === "delete") {
    return true;
  }
  const origin = effectiveSyncOrigin(tip.metadata);
  if (origin === "automatic-chat-repair") {
    return false;
  }
  if (origin === "agent-kv-enrichment") {
    return tip.metadata?.agentKvEnrichmentAppliesCore === true;
  }
  return true;
}

function isSyntheticChange(change: HelperChange): boolean {
  const origin = change.metadata?.syncOrigin;
  return (
    origin === "conflict-resolution" ||
    origin === "auto-merge" ||
    origin === "version-restore" ||
    origin === "automatic-chat-repair" ||
    origin === "agent-kv-enrichment" ||
    origin === "checkpoint-marker"
  );
}

function finalExportApplyBlockReason(
  change: Pick<HelperChange, "resourceId" | "kind">,
  outcome: Pick<
    FinalExportOutcome,
    "protectedLocalResourceIds" | "incompleteKinds"
  >,
): string | null {
  if (outcome.protectedLocalResourceIds.includes(change.resourceId)) {
    return "the exact final local resource was oversized or remained budget-deferred, so the queued incoming change was left untouched";
  }
  if (outcome.incompleteKinds.includes(change.kind)) {
    return "the final local scan for this resource kind was incomplete, so the queued incoming change was left untouched";
  }
  return null;
}

async function resolveWorkspaceStorageMappings(
  request: HelperRequest,
  changes: readonly HelperChange[],
): Promise<Record<string, string>> {
  const workspaceIds = [...workspaceChangeIds(changes)];
  const mappings = selectWorkspaceMappingsForReferences(
    workspaceIds,
    request.workspaceMappings,
  );
  if (!request.syncOptions.syncWorkspaceStorage) {
    return mappings;
  }
  const localWorkspaces = await lookupWorkspaceIdentityReferences(
    request.paths,
    workspaceIds,
    mappings,
  );
  for (const change of changes) {
    if (change.kind !== "workspace-storage" || change.operation === "delete") {
      continue;
    }
    const sourceWorkspaceId = change.metadata?.workspaceId;
    if (typeof sourceWorkspaceId !== "string") {
      continue;
    }
    const sourceWorkspaceUri = change.metadata?.workspaceUri;
    const resolved = resolveTargetWorkspace(
      sourceWorkspaceId,
      typeof sourceWorkspaceUri === "string" ? sourceWorkspaceUri : null,
      localWorkspaces,
      mappings,
    );
    if (resolved !== null && resolved !== sourceWorkspaceId) {
      mappings[sourceWorkspaceId] = resolved;
    }
  }
  return mappings;
}

function* workspaceChangeIds(
  changes: readonly HelperChange[],
): Iterable<string> {
  for (const change of changes) {
    if (change.kind !== "workspace-storage" || change.operation === "delete") {
      continue;
    }
    const workspaceId = change.metadata?.workspaceId;
    if (typeof workspaceId === "string") {
      yield workspaceId;
    }
  }
}

function finalExportTargetPage(
  request: HelperRequest,
  repository: SyncRepository,
  projections: ResourceProjection[],
): HelperChange[] {
  if (request.mode === "apply-and-restart") {
    return boundedHelperTargetPage(request.changes);
  }
  if (
    request.mode === "final-export" &&
    request.syncOptions.applyOnShutdown !== false
  ) {
    return boundedHelperTargetPage(
      shutdownApplyBatch(repository, projections),
    );
  }
  return [];
}

/** Mirrors the buffers `prepareChanges` can retain, without reading payloads. */
function boundedHelperTargetPage(
  changes: readonly HelperChange[],
): HelperChange[] {
  const selected: HelperChange[] = [];
  let totalBytes = 0;
  for (const change of changes) {
    if (selected.length >= 256) {
      break;
    }
    if (change.operation === "put") {
      const declaredBytes = change.payload?.plainBytes;
      if (
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes === undefined ||
        declaredBytes < 0 ||
        declaredBytes > MAX_HELPER_APPLY_WORK_BYTES ||
        totalBytes + declaredBytes > MAX_HELPER_APPLY_WORK_BYTES
      ) {
        continue;
      }
      totalBytes += declaredBytes;
    }
    selected.push(change);
  }
  return selected;
}

export async function prepareChanges(
  repository: SyncRepository,
  changes: HelperChange[],
): Promise<{
  prepared: PreparedHelperChange[];
  skipped: string[];
  failureByResourceId: Record<string, string>;
}> {
  const prepared: PreparedHelperChange[] = [];
  const skipped: string[] = [];
  const failureByResourceId: Record<string, string> = {};
  let totalBytes = 0;
  let preparedCount = 0;
  const batchLimit = MAX_HELPER_APPLY_WORK_BYTES;
  for (const change of changes) {
    if (change.operation === "put") {
      if (change.payload === undefined) {
        // Not fatal for the same reason a damaged object is not: one malformed
        // change must not cost every sibling in the request.
        const message = "the event carries no payload reference";
        skipped.push(`${change.resourceId}: ${message}`);
        failureByResourceId[change.resourceId] = message;
        continue;
      }
      const declaredBytes = change.payload.plainBytes;
      if (
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes < 0 ||
        declaredBytes > batchLimit
      ) {
        const message = `the authenticated payload size ${declaredBytes} exceeds the fixed ${batchLimit} byte helper work limit`;
        skipped.push(`${change.resourceId}: ${message}`);
        failureByResourceId[change.resourceId] = message;
        continue;
      }
      if (preparedCount >= 256 || totalBytes + declaredBytes > batchLimit) {
        skipped.push(
          `${change.resourceId}: deferred to a later bounded helper apply page; it stays queued`,
        );
        continue;
      }
      let content: Buffer;
      try {
        content = await repository.readObject(change.payload);
      } catch (error) {
        if (isMissingPathError(error)) {
          // The event arrived through the shared folder before its payload
          // did. That is one change not yet appliable, not a failed batch:
          // failing here used to write a failure result and drop every
          // sibling change on the floor for a file OneDrive delivers a
          // minute later. The change stays queued and rides the next apply.
          skipped.push(
            `${change.resourceId}: payload not yet synced to this computer; it stays queued`,
          );
          continue;
        }
        // Present but unreadable: a cloud placeholder that materialized as
        // zero bytes, a truncated write, bit rot, a size or HMAC mismatch.
        // Rethrowing killed the WHOLE request - nothing applied, nothing
        // dequeued, nothing blocked - and since the bytes never heal on their
        // own, every later apply died the same way while the modal kept
        // offering the queue and quitting Cursor to retry it. Deferring the
        // one change is the same treatment its siblings get for every other
        // per-resource failure.
        const message = error instanceof Error ? error.message : String(error);
        skipped.push(`${change.resourceId}: ${message}`);
        failureByResourceId[change.resourceId] = message;
        continue;
      }
      const continuationFailure = await preparedChatContinuationFailure(
        change,
        content,
      );
      if (continuationFailure !== null) {
        skipped.push(`${change.resourceId}: ${continuationFailure}`);
        failureByResourceId[change.resourceId] = continuationFailure;
        continue;
      }
      totalBytes += declaredBytes;
      prepared.push({
        change,
        content,
      });
      preparedCount += 1;
    } else {
      if (preparedCount >= 256) {
        skipped.push(
          `${change.resourceId}: deferred to a later bounded helper apply page; it stays queued`,
        );
        continue;
      }
      prepared.push({ change });
      preparedCount += 1;
    }
  }
  return { prepared, skipped, failureByResourceId };
}

/**
 * Authenticated event metadata is an index, not proof that the payload closes
 * over Cursor's continuation graph. Re-parse and walk the exact object before
 * it can enter the offline database transaction. This also protects a stale
 * helper hand-off produced before the extension-host queue gate existed.
 */
async function preparedChatContinuationFailure(
  change: HelperChange,
  content: Buffer,
): Promise<string | null> {
  if (change.kind !== "chat" || change.operation !== "put") {
    return null;
  }
  if (sha256(content) !== change.semanticHash) {
    return "the chat payload hash does not match its authenticated event semantic hash";
  }
  const origin = effectiveSyncOrigin(change.metadata);
  if (
    origin === "automatic-chat-repair" ||
    (origin === "agent-kv-enrichment" &&
      change.metadata?.agentKvEnrichmentAppliesCore !== true)
  ) {
    // These recipes do not replace an existing live core. Automatic repair
    // has its own exact fingerprint/race checks; legacy enrichment writes only
    // hash-valid blob rows.
    return null;
  }

  let snapshot: PortableChatSnapshot;
  try {
    snapshot = parsePortableChatSnapshot(content);
  } catch {
    return "the chat continuation snapshot is not a valid portable payload";
  }
  if (!isPortableChatSnapshotV2(snapshot)) {
    return "the chat has no complete schema-v2 continuation snapshot";
  }
  const metadata = change.metadata;
  if (
    metadata?.chatSnapshotSchemaVersion !== 2 ||
    metadata.agentKvBlobCount !== snapshot.agentKv.blobs.length ||
    metadata.agentKvReferencedCount !== snapshot.agentKv.referencedIds.length ||
    metadata.agentKvMissingCount !== snapshot.agentKv.missingIds.length ||
    metadata.chatCoreHash !== portableChatCoreHash(snapshot)
  ) {
    return "the authenticated chat continuation metadata does not match its payload";
  }
  if (snapshot.agentKv.missingIds.length !== 0) {
    return "the chat continuation snapshot still declares unavailable content";
  }
  const closure = await verifyPortableChatContinuationClosure(snapshot, {
    limits: {
      maxNodes: 4_096,
      maxBytes: MAX_HELPER_APPLY_WORK_BYTES,
      maxDepth: 256,
      maxProtobufDepth: 64,
    },
  });
  return closure.status === "complete"
    ? null
    : `the chat continuation closure could not be verified (${closure.status}/${closure.reason})`;
}

/**
 * What the shutdown finalizer applies: the queue as it stands right now.
 *
 * The apply-and-restart path is handed its change list by the extension host,
 * which built it seconds earlier. The finalizer cannot work that way — it is
 * armed when Cursor STARTS and runs whenever Cursor exits, so anything decided
 * at arm time is stale by the time it matters. It reads the queue itself
 * instead, from the state it has just reconciled.
 *
 * Mirrors `pendingHelperBatch` in the extension host: blocked entries are
 * skipped, entries whose tip is gone are skipped, and the batch stops at the
 * same fixed work ceiling so one shutdown cannot retain hundreds of MiB of
 * payload buffers while their appliers allocate parse/SQLite copies. Whatever
 * does not fit stays queued for the next pass.
 */
function shutdownApplyBatch(
  repository: SyncRepository,
  projections: ResourceProjection[],
): HelperChange[] {
  const tipByVersionId = new Map<string, ResourceProjection>();
  for (const projection of projections) {
    tipByVersionId.set(projection.tip.versionId, projection);
  }
  const changes: HelperChange[] = [];
  let totalBytes = 0;
  for (const pending of repository.state.pendingDatabaseChanges) {
    if (pending.blockedReason !== undefined) {
      continue;
    }
    const projection = tipByVersionId.get(
      `${pending.eventHash}#${pending.changeIndex}`,
    );
    if (projection === undefined) {
      continue;
    }
    const tip = projection.tip;
    if (chatContinuationApplyBlockReason(tip) !== undefined) {
      // A repository state written by an older extension can still contain an
      // unblocked legacy/partial chat. The shutdown helper independently
      // rebuilds its page from that durable queue, so it needs the same final
      // continuation gate as the live extension host.
      continue;
    }
    const payloadBytes = tip.payload?.plainBytes ?? 0;
    if (
      changes.length >= 256 ||
      (payloadBytes <= MAX_HELPER_APPLY_WORK_BYTES &&
        totalBytes + payloadBytes > MAX_HELPER_APPLY_WORK_BYTES)
    ) {
      continue;
    }
    const change: HelperChange = {
      eventHash: tip.eventHash,
      changeIndex: tip.changeIndex,
      sourceDeviceId: tip.deviceId,
      resourceId: projection.resourceId,
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
    if (payloadBytes <= MAX_HELPER_APPLY_WORK_BYTES) {
      totalBytes += payloadBytes;
    }
  }
  return changes;
}

function isEligible(
  change: HelperChange,
  projections: ResourceProjection[],
  conflicts: Array<{ resourceId: string; resolvedAt?: string }>,
): boolean {
  const versionId = `${change.eventHash}#${change.changeIndex}`;
  if (
    conflicts.some(
      (conflict) =>
        conflict.resourceId === change.resourceId &&
        conflict.resolvedAt === undefined,
    )
  ) {
    return false;
  }
  const projection = projections.find(
    (candidate) =>
      candidate.resourceId === change.resourceId &&
      candidate.tip.versionId === versionId,
  );
  if (projection === undefined) {
    return false;
  }

  const tip = projection.tip;
  if (chatContinuationApplyBlockReason(tip) !== undefined) {
    // The hand-off request is not authority. Re-bind it to the freshly
    // reconciled tip and refuse an incomplete ordinary chat even if an older
    // extension wrote an unblocked request before this helper started.
    return false;
  }
  if (
    tip.kind !== change.kind ||
    tip.operation !== change.operation ||
    tip.semanticHash !== change.semanticHash ||
    !canonicalBytes(tip.payload ?? null).equals(
      canonicalBytes(change.payload ?? null),
    ) ||
    !canonicalBytes(tip.metadata ?? null).equals(
      canonicalBytes(change.metadata ?? null),
    )
  ) {
    return false;
  }
  if (
    tip.metadata?.syncOrigin === "checkpoint-marker" &&
    (typeof change.sourceDeviceId !== "string" ||
      tip.deviceId !== change.sourceDeviceId ||
      !validCheckpointMarkerProvenance(tip))
  ) {
    return false;
  }

  // A helper request is a local hand-off file, not the authenticated event.
  // Re-bind automatic repair authority to the freshly reconciled projection
  // before allowing the request metadata to reach the database layer.
  const requestedAutomatic =
    effectiveSyncOrigin(change.metadata) === "automatic-chat-repair";
  const projectedAutomatic =
    effectiveSyncOrigin(tip.metadata) === "automatic-chat-repair";
  if (requestedAutomatic || projectedAutomatic) {
    const requestedOrigin = change.metadata?.repairOriginDeviceId;
    const requestedSource = effectiveSourceDeviceId(
      change.metadata,
      change.sourceDeviceId,
    );
    const projectedSource = effectiveSourceDeviceId(
      tip.metadata,
      tip.deviceId,
    );
    return (
      requestedAutomatic &&
      projectedAutomatic &&
      typeof change.sourceDeviceId === "string" &&
      tip.deviceId === change.sourceDeviceId &&
      typeof requestedOrigin === "string" &&
      tip.metadata?.repairOriginDeviceId === requestedOrigin &&
      requestedSource !== undefined &&
      projectedSource === requestedSource &&
      requestedOrigin === requestedSource
    );
  }
  return true;
}

function validCheckpointMarkerProvenance(tip: ResourceTip): boolean {
  const legacyKind = classifyLegacyCheckpointMarker(tip.metadata);
  if (legacyKind !== null) {
    // v0.0.59 always emitted one real parent but did not copy its version into
    // metadata. Only its exact ordinary shape is grandfathered. Repair,
    // enrichment, and restore recipes need the new source/version provenance
    // (or a later marker that safely reconstructed it) before the helper may
    // write database state.
    return (
      legacyKind === "ordinary" &&
      tip.parents.length === 1 &&
      /^[a-f0-9]{64}#\d+$/.test(tip.parents[0] ?? "") &&
      effectiveTipProducer(tip) !== undefined
    );
  }
  const checkpointedVersionId = tip.metadata?.checkpointedVersionId;
  return (
    typeof checkpointedVersionId === "string" &&
    /^[a-f0-9]{64}#\d+$/.test(checkpointedVersionId) &&
    tip.parents.length === 1 &&
    tip.parents[0] === checkpointedVersionId &&
    effectiveSourceDeviceId(tip.metadata, tip.deviceId) !== undefined &&
    effectiveTipProducer(tip) !== undefined
  );
}

/** Narrow seams for authenticated helper/final-export regressions. */
export const __testing = Object.freeze({
  boundedHelperTargetPage,
  exportFinalChanges,
  finalExportTargetPage,
  intersectVerifiedApplyPage,
  finalExportApplyBlockReason,
  isEligible,
  rememberLearnedChatProjectionSources,
  shutdownApplyBatch,
});

export function markAppliedProjections(
  repository: SyncRepository,
  eligible: HelperChange[],
  appliedResourceIds: string[],
  retainedLocalResourceIds: ReadonlySet<string>,
  retainedLocalHashes: Readonly<Record<string, string>> = {},
  localChatCoreHashes: Readonly<Record<string, string | null>> = {},
  failureByResourceId: Readonly<Record<string, string>> = {},
): void {
  const applied = new Set(appliedResourceIds);
  for (const change of eligible) {
    if (!applied.has(change.resourceId)) {
      continue;
    }
    const previous = repository.state.projections[change.resourceId];
    const hasLocalChatCoreHash = Object.hasOwn(
      localChatCoreHashes,
      change.resourceId,
    );
    const localChatCoreHash = localChatCoreHashes[change.resourceId];
    const requiresAgentKvRecapture =
      change.kind === "chat" &&
      effectiveSyncOrigin(change.metadata) === "automatic-chat-repair" &&
      !(
        change.metadata?.chatSnapshotSchemaVersion === 2 &&
        change.metadata.agentKvMissingCount === 0
      );
    repository.state.projections[change.resourceId] = {
      resourceId: change.resourceId,
      kind: change.kind,
      semanticHash: change.semanticHash,
      versionId: `${change.eventHash}#${change.changeIndex}`,
      ...(change.payload === undefined
        ? {}
        : { payloadObjectId: change.payload.objectId }),
      ...(typeof change.metadata?.bubbleCount === "number"
        ? { sourceBubbleCount: change.metadata.bubbleCount }
        : {}),
      ...(typeof change.metadata?.lastUpdatedAt === "number"
        ? { sourceTimestamp: change.metadata.lastUpdatedAt }
        : {}),
      ...(hasLocalChatCoreHash
        ? isChatCoreHash(localChatCoreHash)
          ? { sourceChatCoreHash: localChatCoreHash }
          : {}
        : isChatCoreHash(change.metadata?.chatCoreHash)
          ? { sourceChatCoreHash: change.metadata.chatCoreHash }
          : {}),
      ...(requiresAgentKvRecapture
        ? { requiresAgentKvRecapture: true }
        : {}),
      ...(retainedLocalResourceIds.has(change.resourceId)
        ? {
            retainedLocalHash:
              retainedLocalHashes[change.resourceId] ??
              previous?.retainedLocalHash ??
              previous?.semanticHash ??
              sha256(`retained-local:${change.resourceId}`),
          }
        : {}),
    };
  }
  repository.state.pendingDatabaseChanges =
    repository.state.pendingDatabaseChanges.filter(
      (pending) => !applied.has(pending.resourceId),
    );
  // A change that was tried and failed stays queued - one corrupt database must
  // not cost the batch - but it stops being OFFERED. Without this it counted
  // toward the modal that quits Cursor to write it, so a resource that fails
  // identically every time re-offered itself after every restart forever. See
  // APPLY_FAILURE_BLOCK_PREFIX.
  for (const pending of repository.state.pendingDatabaseChanges) {
    const failure = failureByResourceId[pending.resourceId];
    if (failure === undefined) {
      continue;
    }
    pending.blockedReason = `${APPLY_FAILURE_BLOCK_PREFIX}: ${failure} Run "${RESTART_TO_APPLY_TITLE}" to try it again.`;
  }
}

function isChatCoreHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validFileSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validFileTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function assertRuntimeVersion(request: HelperRequest): Promise<void> {
  const sqlite = inspectSqliteCapabilities();
  if (!sqlite.database || !sqlite.backup) {
    throw new Error(
      `Unsupported helper Node runtime: ${process.version}; node:sqlite with backup support is required.`,
    );
  }
  let productContent: string;
  try {
    productContent = await readFile(
      join(request.paths.appRoot, "product.json"),
      "utf8",
    );
  } catch (error) {
    // A Linux AppImage unmounts its appRoot together with the Cursor process
    // that created the request, so an unreadable product.json downgrades the
    // version re-check to the versions captured at request creation.
    process.stderr.write(
      `Skipping the Cursor version re-check; product.json is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return;
  }
  let product: { version?: string; vscodeVersion?: string };
  try {
    product = JSON.parse(productContent) as {
      version?: string;
      vscodeVersion?: string;
    };
  } catch (error) {
    // Same downgrade as an unreadable file, for the same reason: a torn or
    // half-written product.json is a fact about the installation, not about
    // whether these changes are safe to apply. Letting `JSON.parse` throw here
    // took the whole helper down before it had applied anything, and before
    // stderr was captured that failure was completely silent.
    process.stderr.write(
      `Skipping the Cursor version re-check; product.json is unparseable: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return;
  }
  if (
    product.version !== request.expectedCursorVersion ||
    product.vscodeVersion !== request.expectedVscodeVersion
  ) {
    throw new Error(
      `Cursor changed after the helper request was created: ${String(
        product.version,
      )}/${String(product.vscodeVersion)}`,
    );
  }
}

/**
 * Backups that queued restore-backup requests still intend to read. The scan
 * is over the storage root only, never the backups tree, and tolerates any
 * unreadable request - a missing exemption falls back to the old behavior.
 */
async function pendingRestoreSourceBackups(
  storageRoot: string,
): Promise<string[]> {
  const sources: string[] = [];
  let names: string[];
  try {
    names = await readdir(storageRoot);
  } catch {
    return sources;
  }
  for (const name of names) {
    if (!name.startsWith("helper-request-") || !name.endsWith(".json")) {
      continue;
    }
    try {
      const pending = await readJsonFile<HelperRequest>(join(storageRoot, name));
      if (
        pending.mode === "restore-backup" &&
        typeof pending.backupToRestore === "string"
      ) {
        sources.push(pending.backupToRestore);
      }
    } catch {
      // Unreadable or mid-write; the next run sees it settled.
    }
  }
  return sources;
}

async function waitForCursorExit(
  request: HelperRequest,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  // The extension-host pid check is only a cheap gate in front of the process
  // listing, and Windows recycles pids: a recycled pid belonging to some
  // unrelated long-lived process read as "Cursor still open" and held this
  // wait for its whole timeout - thirty days for a finalizer. The listing is
  // authoritative, so it runs regardless on a slower cadence.
  let listingState: CursorProcessListingState = {
    lastListingAt: null,
    hostGone: false,
  };
  let listingEverSucceeded = false;
  let consecutiveListingFailures = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (
      request.mode === "final-export" &&
      (await isFinalizerCancelled(request))
    ) {
      return true;
    }
    const listing = cursorProcessListingDecision(
      listingState,
      Date.now(),
      !isProcessAlive(request.extensionHostPid),
    );
    listingState = listing.state;
    if (listing.due) {
      try {
        const noOthers = await noOtherCursorProcesses(request);
        listingEverSucceeded = true;
        consecutiveListingFailures = 0;
        if (noOthers) {
          return false;
        }
      } catch (error) {
        // A transient tasklist failure is not evidence about Cursor: erring
        // toward waiting matches inertCursorProcessIds' policy, and letting
        // the throw escape killed the session's only shutdown exporter over
        // one hiccup. But an environment where the listing has NEVER worked
        // would otherwise wait out the full timeout - thirty days for a
        // finalizer - in perfect silence, losing every quit's export with
        // green status. A listing that never succeeded fails loudly instead,
        // which the launcher's stderr log and the consume path surface.
        consecutiveListingFailures += 1;
        process.stderr.write(
          `Cursor process listing failed (${consecutiveListingFailures}): ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        if (!listingEverSucceeded && consecutiveListingFailures >= 10) {
          throw error;
        }
      }
    }
    await delay(500);
  }
  let survivors: number[] | null = null;
  try {
    survivors = await otherCursorProcessIds(request);
  } catch {
    // The listing is a nicety on this path; failing it must not replace the
    // timeout with a different error.
  }
  throw new CursorExitTimeoutError(
    cursorExitTimeoutDetail(survivors, await shutdownFinalizerPid(request)),
  );
}

/**
 * The pid of a shutdown finalizer, if one holds the lock. It is a headless
 * `Cursor.exe` of this extension's own making, so it must never be reported as
 * a window the user should close.
 */
async function shutdownFinalizerPid(request: HelperRequest): Promise<number | null> {
  try {
    const raw = await readFile(
      join(request.storageRoot, "shutdown-finalizer.lock"),
      "utf8",
    );
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

async function isFinalizerCancelled(request: HelperRequest): Promise<boolean> {
  const path = join(request.storageRoot, "cancel-finalizers");
  if (!(await pathExists(path))) {
    return false;
  }
  // The marker itself is a bare ISO timestamp - the format every fielded
  // finalizer can parse. A 0.0.33 build briefly shipped "iso\npid" here, which
  // a still-running 0.0.32 finalizer read as NaN and therefore NEVER stood
  // down for; the writer identity lives in a sidecar now so the marker bytes
  // stay backward-parseable forever.
  const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/);
  const timestamp = Date.parse(lines[0] ?? "");
  if (!Number.isFinite(timestamp) || timestamp < Date.parse(request.createdAt)) {
    return false;
  }
  // A cancel is a promise that its writer follows through - with a quit, or
  // with a replacement finalizer. What a dead writer means depends on which:
  //  - a "quit" handoff's writer is EXPECTED to die (the window is closing),
  //    so the marker stays valid for the grace window;
  //  - a "restart" handoff's writer dying means no replacement will ever be
  //    armed, so honoring its marker would strip the session of its only
  //    exporter - the marker is void the moment the writer is gone.
  const owner = await readCancelOwner(request);
  if (
    owner !== null &&
    Number.isFinite(owner.pid) &&
    (owner.stamp === undefined || owner.stamp === lines[0])
  ) {
    // A sidecar bound to a DIFFERENT marker is a stranded leftover (its
    // writer crashed between the sidecar and marker writes) and must not
    // speak for the marker actually present - fall through to the legacy
    // reading instead.
    if (isProcessAlive(owner.pid)) {
      return true;
    }
    if (owner.kind === "restart") {
      return false;
    }
    return Date.now() - timestamp < CANCEL_MARKER_GRACE_MS;
  }
  // Legacy two-line marker or no sidecar (a 0.0.32 writer): pid from line 2
  // when present, otherwise the grace window alone.
  const legacyPid = Number.parseInt(lines[1] ?? "", 10);
  if (Number.isFinite(legacyPid) && isProcessAlive(legacyPid)) {
    return true;
  }
  return Date.now() - timestamp < CANCEL_MARKER_GRACE_MS;
}

async function readCancelOwner(
  request: HelperRequest,
): Promise<{ pid: number; kind: "restart" | "quit"; stamp?: string } | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(request.storageRoot, "cancel-finalizers-owner"), "utf8"),
    ) as { pid?: unknown; kind?: unknown; stamp?: unknown };
    if (
      typeof raw.pid !== "number" ||
      (raw.kind !== "restart" && raw.kind !== "quit")
    ) {
      return null;
    }
    return {
      pid: raw.pid,
      kind: raw.kind,
      ...(typeof raw.stamp === "string" ? { stamp: raw.stamp } : {}),
    };
  } catch {
    return null;
  }
}

/** How long an unowned cancel marker is still trusted; a live handoff takes seconds. */
const CANCEL_MARKER_GRACE_MS = 60_000;

async function acquireSyncLock(
  storageRoot: string,
  timeoutMs: number,
): Promise<FileLock> {
  const startedAt = Date.now();
  const path = join(storageRoot, "sync.lock");
  while (Date.now() - startedAt < timeoutMs) {
    const lock = await acquireFileLock(path);
    if (lock !== null) {
      return lock;
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the synchronization lock.");
}

async function noOtherCursorProcesses(request: HelperRequest): Promise<boolean> {
  return (await otherCursorProcessIds(request)).length === 0;
}

/**
 * The shutdown finalizer's pid, when one holds a live lock.
 *
 * A finalizer is a headless `Cursor.exe` of this extension's own making, and
 * once it is past its own wait it stops re-checking the cancel file - so it
 * stays in the process table for as long as its export takes, which on a
 * repository with a thousand workspaceStorage resources is minutes. An apply
 * helper counted it as a running Cursor and gave up after its 180 seconds,
 * reporting "1 Cursor process(es) are still running" about a process the user
 * cannot close and must not kill.
 *
 * Excluding it is safe because it is not what the wait is for: exclusivity
 * against a real Cursor is unaffected, and the two helpers still serialize
 * against each other on `sync.lock`, which is the actual mutex.
 *
 * The lock's own liveness rule is applied before trusting the pid, because a
 * stale lock naming a recycled pid would remove a genuine Cursor from the list.
 */
async function liveFinalizerPid(request: HelperRequest): Promise<number | null> {
  const path = join(request.storageRoot, "shutdown-finalizer.lock");
  try {
    const [raw, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (Date.now() - stats.mtimeMs > FINALIZER_LOCK_TRUST_MS) {
      return null;
    }
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    return typeof pid === "number" && isProcessAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Every live Cursor process except this helper, which is itself spawned as
 * `Cursor.exe` with ELECTRON_RUN_AS_NODE and would otherwise wait for itself.
 */
async function otherCursorProcessIds(
  request: HelperRequest,
): Promise<number[]> {
  const platform = process.platform;
  const finalizerPid = await liveFinalizerPid(request);
  const { stdout } =
    platform === "win32"
      ? await execFileAsync(
          "tasklist",
          ["/FI", "IMAGENAME eq Cursor.exe", "/FO", "CSV", "/NH"],
          { windowsHide: true, timeout: 10_000 },
        )
      : await execFileAsync("ps", ["-axo", "pid=,comm="], { timeout: 10_000 });
  const survivors = parseCursorProcessIds(stdout, platform).filter(
    (pid) => pid !== process.pid && pid !== finalizerPid,
  );
  if (survivors.length === 0) {
    return survivors;
  }
  const inert = await inertCursorProcessIds(survivors, platform);
  return survivors.filter((pid) => !inert.has(pid));
}

/**
 * Cursor processes that are not Cursor: children that share the executable name
 * but hold nothing and can outlive the application.
 *
 * `crashpad-handler` is the one that matters. It exists to catch a crash during
 * shutdown, so it is deliberately among the last to go and on Windows it is
 * routinely orphaned entirely - one machine sat with a single crashpad-handler
 * and no window at all, and every helper waited its whole budget for a process
 * that was never going to exit. It opens no database; treating it as a running
 * Cursor is simply wrong.
 *
 * The classification needs command lines, which `tasklist` does not give, so it
 * is done only once survivors exist - the ordinary case is none - and the
 * answer is cached for the rest of this process's wait, since a pid that is a
 * crash handler does not become something else.
 */
const inertCursorPids = new Set<number>();
const classifiedCursorPids = new Set<number>();

async function inertCursorProcessIds(
  survivors: readonly number[],
  platform: NodeJS.Platform,
): Promise<Set<number>> {
  if (survivors.every((pid) => classifiedCursorPids.has(pid))) {
    return inertCursorPids;
  }
  try {
    const { stdout } =
      platform === "win32"
        ? await execFileAsync(
            "powershell",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
            ],
            { windowsHide: true, timeout: 15_000 },
          )
        : await execFileAsync("ps", ["-axo", "pid=,command="], {
            timeout: 15_000,
          });
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      const pid = Number(match?.[1]);
      if (!Number.isSafeInteger(pid) || pid === 0) {
        continue;
      }
      classifiedCursorPids.add(pid);
      if (INERT_CURSOR_PROCESS.test(match?.[2] ?? "")) {
        inertCursorPids.add(pid);
      }
    }
  } catch {
    // Without command lines every survivor keeps counting, which is the
    // behaviour that existed before this and errs towards waiting rather than
    // towards writing while Cursor is alive.
  }
  return inertCursorPids;
}

const INERT_CURSOR_PROCESS = /--type=crashpad-handler\b/;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function restartCursor(cursorExecutable: string): void {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const launch = cursorLaunchCommand(cursorExecutable);
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: environment,
  });
  child.unref();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer: Buffer = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(String(chunk), "utf8");
    size += buffer.byteLength;
    if (size > 4096) {
      throw new Error("Helper key input is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeResult(
  request: HelperRequest,
  result: HelperResult,
): Promise<void> {
  await writeJsonAtomic(
    join(request.storageRoot, `helper-result-${request.requestId}.json`),
    result,
  );
}

function successResult(
  request: HelperRequest,
  applied: string[],
  skipped: string[],
  backupPath: string | null,
  backups: HelperBackup[] = [],
  warnings: string[] = [],
): HelperResult {
  return {
    requestId: request.requestId,
    mode: request.mode,
    success: true,
    startedAt: HELPER_STARTED_AT,
    completedAt: new Date().toISOString(),
    applied,
    skipped,
    // Always present on a 0.0.5 result, empty included: an empty array is what
    // tells the extension host a previous run's standing warning has cleared.
    warnings: [...warnings],
    backupPath,
    ...(backups.length === 0 ? {} : { backups }),
    error: null,
  };
}

function validateRequest(request: HelperRequest): void {
  if (request.version !== HELPER_REQUEST_VERSION) {
    throw new Error(`Unsupported helper request version: ${request.version}`);
  }
  if (!Number.isSafeInteger(request.extensionHostPid)) {
    throw new Error("Helper request extension host PID is invalid.");
  }
  if (
    !isRequestVersion(request.extensionVersion) ||
    !isRequestVersion(request.expectedCursorVersion) ||
    !isRequestVersion(request.expectedVscodeVersion)
  ) {
    throw new Error("Helper request version metadata is invalid.");
  }
}

function isRequestVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function databaseIsHealthy(path: string): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }
  try {
    const database = openDatabase(path, { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const row = database.prepare("PRAGMA quick_check").get() as
        | { quick_check?: string }
        | undefined;
      return row?.quick_check === "ok";
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}
