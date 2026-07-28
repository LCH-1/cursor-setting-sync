import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, stat } from "node:fs/promises";
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
  HELPER_REQUEST_VERSION,
  MAX_APPLY_BATCH_BYTES,
  REPOSITORY_FILE,
} from "../constants";
import type {
  RepositoryFile,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
  ResourceTip,
} from "../types";
import { pathExists, readJsonFile, writeJsonAtomic } from "../platform/files";
import { commitAndPush, isGitRepository, pullLatest } from "../platform/git";
import { acquireFileLock, type FileLock } from "../platform/lock";
import { SyncRepository } from "../protocol/repository";
import { EventReconciler, parentsForLocalChange } from "../protocol/reconciler";
import {
  absorbedCheckpointManifest,
  filterPublishableChanges,
  isSyntheticTip,
  publishInBatches,
} from "../sync/versionPolicy";
import { sha256 } from "../protocol/canonical";
import { StateVscdbChatAdapter } from "../chat/stateVscdb";
import { ChatTranscriptsAdapter } from "../chat/transcripts";
import { StoreDbChatAdapter } from "../chat/storeDb";
import {
  discoverWorkspaces,
  resolveTargetWorkspace,
} from "../chat/workspace";
import {
  SettingsAdapter,
  createSettingsIgnoreMatcher,
} from "../resources/settings";
import { ProfileFilesAdapter } from "../resources/profileFiles";
import {
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
import type { ResourceAdapter } from "../resources/resource";
import {
  applyGlobalDatabaseChanges,
  recoverInterruptedApplyJournals,
  restoreDatabaseBackup,
  type PreparedHelperChange,
} from "./database";
import { applyNonGlobalChanges, CursorReopenedError } from "./resourceApply";
import type { HelperBackup, HelperChange, HelperRequest, HelperResult } from "./types";

const execFileAsync = promisify(execFile);

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
    const lock = await acquireSyncLock(request.storageRoot, 180_000);

    try {
      await recoverInterruptedApplyJournals(
        request.storageRoot,
        request.paths.globalDatabase,
      );
      const result = await executeRequest(request, masterKey, collected, () => {
        lock.refresh();
      });
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
        success: false,
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
      const cursorStillRunning =
        error instanceof CursorReopenedError ||
        error instanceof CursorExitTimeoutError;
      if (
        request.restart &&
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
): Promise<HelperResult> {
  const gitWarnings: string[] = [];
  const gitActive = await beginGitTransport(request, gitWarnings);
  const repositoryFile = await readJsonFile<RepositoryFile>(
    join(request.repositoryRoot, REPOSITORY_FILE),
  );
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

  const exported = await exportFinalChanges(request, repository);
  // Everything that means a resource did NOT reach the repository: a git
  // transport failure, an adapter that threw during the shutdown scan, or a
  // snapshot dropped for exceeding the payload limit. These are reported apart
  // from the routine `skipped` entries so the extension host can raise a
  // standing warning for them without also flagging every deliberately
  // retained tombstone and every superseded change.
  const warnings = [...gitWarnings, ...exported.warnings];
  if (request.mode === "final-export") {
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
  const ensureExclusiveAccess = async (): Promise<void> => {
    if (!(await noOtherCursorProcesses(request))) {
      throw new CursorReopenedError(
        "Cursor was reopened before offline changes could be applied. Close Cursor and try again.",
      );
    }
  };
  await ensureExclusiveAccess();

  const reconciler = new EventReconciler();
  const reconcileResult = reconciler.reconcile(
    await repository.listEvents(),
    repository.state,
    await absorbedCheckpointManifest(repository),
  );
  const eligible = request.changes.filter((change) =>
    isEligible(change, reconcileResult.projections, repository.state.conflicts),
  );
  const skipped = [
    ...request.changes
    .filter((change) => !eligible.includes(change))
    .map((change) => `${change.resourceId}: superseded or conflicted`),
  ];
  const prepared = await prepareChanges(repository, eligible);

  const globalPrepared = prepared.filter((item) =>
    ["chat", "ui-state", "cursor-user-rules", "profile"].includes(
      item.change.kind,
    ),
  );
  let backupPath: string | null = null;
  const applied: string[] = [];
  const retainedLocal = new Set<string>();
  if (globalPrepared.length > 0) {
    await ensureExclusiveAccess();
    const globalResult = await applyGlobalDatabaseChanges(
      request,
      globalPrepared,
      heartbeat,
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
  }

  const nonGlobalResult = await applyNonGlobalChanges(
    request,
    prepared,
    ensureExclusiveAccess,
    (backup) => collected.backups.push(backup),
    heartbeat,
  );
  applied.push(...nonGlobalResult.applied);
  skipped.push(...nonGlobalResult.skipped);
  for (const resourceId of nonGlobalResult.retainedLocal) {
    retainedLocal.add(resourceId);
  }
  markAppliedProjections(
    repository,
    eligible,
    applied,
    retainedLocal,
    nonGlobalResult.retainedLocalHashes,
  );
  await repository.saveState();
  await finishGitTransport(
    gitActive,
    request.repositoryRoot,
    `apply (${request.requestId.slice(0, 8)})`,
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

async function exportFinalChanges(
  request: HelperRequest,
  repository: SyncRepository,
): Promise<{ warnings: string[]; notices: string[] }> {
  const reconciler = new EventReconciler();
  const preResult = reconciler.reconcile(
    await repository.listEvents(),
    repository.state,
    await absorbedCheckpointManifest(repository),
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
          projection.changed && isSyntheticTip(projection.tip),
      )
      .map((projection) => projection.resourceId),
  );
  const workspaceMappings = await resolveWorkspaceStorageMappings(
    request,
    preResult.projections,
  );
  const adapters: ResourceAdapter[] = [
    new SettingsAdapter(
      request.paths,
      createSettingsIgnoreMatcher(request.syncOptions.ignoredSettings),
      createSettingsIgnoreMatcher(request.syncOptions.machineScopedSettings),
    ),
    new ProfileFilesAdapter(request.paths),
    new CursorUserFilesAdapter(
      request.paths,
      normalizeIgnoredUserFiles(request.syncOptions.ignoredUserFiles ?? []),
    ),
    new ProfilesAdapter(request.paths),
    new UiStateAdapter(
      request.paths,
      normalizeIgnoredUiStateKeys(request.syncOptions.ignoredUiStateKeys ?? []),
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
      ),
    );
  }
  if (request.syncOptions.syncChat) {
    adapters.push(
      new StateVscdbChatAdapter(request.paths),
      new ChatTranscriptsAdapter(request.paths),
      new StoreDbChatAdapter(request.paths),
    );
  }
  const snapshots: ResourceSnapshot[] = [];
  const deletions: ResourceDeletion[] = [];
  const warnings: string[] = [];
  // Deliberate exclusions, kept out of `warnings` so a device that has merely
  // been configured does not sit permanently at "Partial - some resources were
  // not saved to the repository". They are re-derived on every run and none of
  // them is a failure.
  const notices: string[] = [];
  for (const adapter of adapters) {
    let result: ResourceScanResult;
    try {
      result = await adapter.scan(repository.state.projections);
    } catch (error) {
      // One failing adapter must not abort the whole shutdown export.
      warnings.push(
        `${adapter.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    warnings.push(...result.warnings);
    notices.push(...(result.notices ?? []));
    snapshots.push(
      ...result.snapshots.filter(
        (snapshot) => {
          if (conflictedResources.has(snapshot.resourceId)) {
            return false;
          }
          if (protectedSyntheticResources.has(snapshot.resourceId)) {
            return false;
          }
          const projection = repository.state.projections[snapshot.resourceId];
          if (
            projection !== undefined &&
            [
              "chat",
              "chat-transcript",
              "chat-store",
              "workspace-storage",
            ].includes(projection.kind) &&
            projection.retainedLocalHash === snapshot.semanticHash
          ) {
            return false;
          }
          if (
            (repository.state.tips[snapshot.resourceId] ?? []).some(
              (tip) =>
                tip.operation === "put" &&
                tip.semanticHash === snapshot.semanticHash,
            )
          ) {
            return false;
          }
          return projection?.semanticHash !== snapshot.semanticHash;
        },
      ).map((snapshot) => ({
        ...snapshot,
        parents: parentsForLocalChange(
          repository.state.projections[snapshot.resourceId],
          repository.state.tips[snapshot.resourceId] ?? [],
        ),
      })),
    );
    deletions.push(
      ...result.deletions.filter(
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
      })),
    );
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
  const publishedEventHashes = await publishInBatches(
    repository,
    publishable.snapshots,
    publishable.deletions,
  );
  const result = reconciler.reconcile(
    await repository.listEvents(),
    repository.state,
    await absorbedCheckpointManifest(repository),
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
        ...(typeof projection.tip.metadata?.lastUpdatedAt === "number"
          ? { sourceTimestamp: projection.tip.metadata.lastUpdatedAt }
          : {}),
      };
    }
  }
  await repository.saveState();
  await repository.writeAck();
  return { warnings, notices };
}

async function resolveWorkspaceStorageMappings(
  request: HelperRequest,
  projections: Array<{ tip: ResourceTip }>,
): Promise<Record<string, string>> {
  const mappings = Object.assign(
    Object.create(null) as Record<string, string>,
    request.workspaceMappings,
  );
  if (!request.syncOptions.syncWorkspaceStorage) {
    return mappings;
  }
  const localWorkspaces = await discoverWorkspaces(request.paths);
  for (const { tip } of projections) {
    if (tip.kind !== "workspace-storage" || tip.operation === "delete") {
      continue;
    }
    const sourceWorkspaceId = tip.metadata?.workspaceId;
    if (typeof sourceWorkspaceId !== "string") {
      continue;
    }
    const sourceWorkspaceUri = tip.metadata?.workspaceUri;
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

async function prepareChanges(
  repository: SyncRepository,
  changes: HelperChange[],
): Promise<PreparedHelperChange[]> {
  const prepared: PreparedHelperChange[] = [];
  let totalBytes = 0;
  const batchLimit = MAX_APPLY_BATCH_BYTES;
  for (const change of changes) {
    if (change.operation === "put") {
      if (change.payload === undefined) {
        throw new Error(`Payload reference is missing: ${change.resourceId}`);
      }
      const content = await repository.readObject(change.payload);
      totalBytes += content.byteLength;
      if (totalBytes > batchLimit) {
        throw new Error(
          `Helper apply batch exceeds ${batchLimit} bytes; apply fewer changes at once.`,
        );
      }
      prepared.push({
        change,
        content,
      });
    } else {
      prepared.push({ change });
    }
  }
  return prepared;
}

function isEligible(
  change: HelperChange,
  projections: Array<{ resourceId: string; tip: { versionId: string } }>,
  conflicts: Array<{ resourceId: string; resolvedAt?: string }>,
): boolean {
  const versionId = `${change.eventHash}#${change.changeIndex}`;
  return (
    !conflicts.some(
      (conflict) =>
        conflict.resourceId === change.resourceId &&
        conflict.resolvedAt === undefined,
    ) &&
    projections.some(
      (projection) =>
        projection.resourceId === change.resourceId &&
        projection.tip.versionId === versionId,
    )
  );
}

function markAppliedProjections(
  repository: SyncRepository,
  eligible: HelperChange[],
  appliedResourceIds: string[],
  retainedLocalResourceIds: ReadonlySet<string>,
  retainedLocalHashes: Readonly<Record<string, string>> = {},
): void {
  const applied = new Set(appliedResourceIds);
  for (const change of eligible) {
    if (!applied.has(change.resourceId)) {
      continue;
    }
    const previous = repository.state.projections[change.resourceId];
    repository.state.projections[change.resourceId] = {
      resourceId: change.resourceId,
      kind: change.kind,
      semanticHash: change.semanticHash,
      versionId: `${change.eventHash}#${change.changeIndex}`,
      ...(change.payload === undefined
        ? {}
        : { payloadObjectId: change.payload.objectId }),
      ...(typeof change.metadata?.lastUpdatedAt === "number"
        ? { sourceTimestamp: change.metadata.lastUpdatedAt }
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

async function waitForCursorExit(
  request: HelperRequest,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (
      request.mode === "final-export" &&
      (await isFinalizerCancelled(request))
    ) {
      return true;
    }
    if (
      !isProcessAlive(request.extensionHostPid) &&
      (await noOtherCursorProcesses(request))
    ) {
      return false;
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
  const timestamp = Date.parse((await readFile(path, "utf8")).trim());
  return Number.isFinite(timestamp) && timestamp >= Date.parse(request.createdAt);
}

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
    success: true,
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
