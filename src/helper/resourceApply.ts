import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync, SqliteStorageValue } from "../platform/sqlite";
import {
  backupDatabase,
  openDatabase,
  sealBackupFile,
  sqliteStorageText,
} from "../platform/sqlite";
import { dirname, join, relative } from "node:path";
import { utimes } from "node:fs/promises";
import type { JsonValue } from "../types";
import type { HelperBackup, HelperRequest } from "./types";
import type { PreparedHelperChange } from "./database";
import { enforceBackupRetention } from "./backupRetention";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import {
  assertSafeRelativePath,
  assertSafeRelativePathOnDisk,
  ensureDirectory,
  normalizeResourcePath,
  pathExists,
  prepareFilePathWithinRoot,
  writeFileAtomicWithinRoot,
} from "../platform/files";
import {
  parsePortableStoreSnapshot,
  readStoreSnapshot,
  type PortableStoreValue,
} from "../chat/storeDb";
import { EXTENSION_ID } from "../constants";
import { createExtensionIgnoreMatcher } from "../resources/extensions";
import { semanticHash } from "../resources/jsonc";
import { assertValidProfileId } from "../resources/profilePaths";
import {
  discoverWorkspaces,
  resolveTargetWorkspace,
} from "../chat/workspace";
import {
  isBackedUpWorkspaceStorageFile,
  isWorkspaceStateDatabasePath,
  validateWorkspaceStorageRelativePath,
  workspaceStorageResourceId,
} from "../resources/workspaceStorage";
import {
  applyWorkspaceDatabaseSnapshot,
  parseWorkspaceDatabaseSnapshot,
} from "./workspaceDatabaseMerge";
import { filterPortableWorkspaceRows } from "../resources/workspaceStatePolicy";

const execFileAsync = promisify(execFile);

export class CursorReopenedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorReopenedError";
  }
}

export interface NonGlobalApplyResult {
  applied: string[];
  skipped: string[];
  /** The subset of skipped that is a real failure, promoted to warnings. */
  failures: string[];
  backupPaths: string[];
  backups: HelperBackup[];
  retainedLocal: string[];
  retainedLocalHashes: Record<string, string>;
}

export async function applyNonGlobalChanges(
  request: HelperRequest,
  prepared: PreparedHelperChange[],
  ensureExclusiveAccess: () => Promise<void> = async () => {},
  onBackup: (backup: HelperBackup) => void = () => {},
  /** See {@link applyGlobalDatabaseChanges}: keeps the caller's lock alive. */
  heartbeat: () => void = () => {},
  /**
   * Backups taken earlier in the same request, typically the pre-apply global
   * snapshot. Every retention pass in this batch exempts them: a pass that
   * exempted only its own newest backup was able to evict the same request's
   * pre-apply recovery point while the request was still running.
   */
  priorBackups: () => readonly string[] = () => [],
): Promise<NonGlobalApplyResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const backups: HelperBackup[] = [];
  // Registers each backup with the caller as soon as it exists so a mid-batch
  // abort cannot discard the record of backups already created.
  const registerBackup = (backup: HelperBackup): void => {
    backups.push(backup);
    onBackup(backup);
  };
  const exemptBackupPaths = (): string[] => [
    ...priorBackups(),
    ...backups.map((backup) => backup.backupPath),
  ];
  const retainedLocal: string[] = [];
  const retainedLocalHashes: Record<string, string> = {};
  const failures: string[] = [];
  const localWorkspaces =
    request.syncOptions.syncWorkspaceStorage &&
    prepared.some((item) => item.change.kind === "workspace-storage")
      ? await discoverWorkspaces(request.paths)
      : [];

  for (const item of prepared) {
    heartbeat();
    const { change, content } = item;
    try {
      if (change.kind === "workspace-storage") {
        if (!request.syncOptions.syncWorkspaceStorage) {
          skipped.push(`${change.resourceId}: workspaceStorage sync is disabled`);
          continue;
        }
        const relativePath = metadataString(change.metadata, "relativePath");
        const workspaceId = metadataString(change.metadata, "workspaceId");
        if (
          !isBackedUpWorkspaceStorageFile(relativePath) ||
          validateWorkspaceStorageRelativePath(
            request.paths.workspaceStorageRoot,
            relativePath,
          ) !== workspaceId ||
          change.resourceId !== workspaceStorageResourceId(relativePath)
        ) {
          throw new Error(`workspaceStorage metadata does not match ${change.resourceId}.`);
        }
        const workspaceUri = metadataStringOrNull(change.metadata, "workspaceUri");
        if (change.operation === "delete") {
          // Retained, not deleted - so the projection has to record a
          // retained-local hash, exactly like the ignored-extension branch
          // below. Without it the next scan finds the file still present with
          // a hash matching neither the projection nor any tip and republishes
          // it, resurrecting what the other device deleted.
          skipped.push(`${change.resourceId}: workspaceStorage tombstone retained`);
          applied.push(change.resourceId);
          retainedLocal.push(change.resourceId);
          continue;
        }
        const mappedWorkspaceId = resolveTargetWorkspace(
          workspaceId,
          workspaceUri,
          localWorkspaces,
          request.workspaceMappings,
        );
        if (mappedWorkspaceId === null) {
          skipped.push(`${change.resourceId}: workspace mapping required`);
          continue;
        }
        const segments = relativePath.split("/");
        const targetRelativePath = [mappedWorkspaceId, ...segments.slice(1)].join("/");
        validateWorkspaceStorageRelativePath(
          request.paths.workspaceStorageRoot,
          targetRelativePath,
        );
        const target = assertSafeRelativePath(
          request.paths.workspaceStorageRoot,
          targetRelativePath,
        );
        if (content === undefined) {
          throw new Error(`workspaceStorage payload is missing: ${change.resourceId}`);
        }
        const workspaceDatabase = isWorkspaceStateDatabasePath(targetRelativePath);
        if (workspaceDatabase) {
          await assertSafeRelativePathOnDisk(
            request.paths.workspaceStorageRoot,
            targetRelativePath,
            { finalType: "file" },
          );
          await ensureExclusiveAccess();
          await mergeWorkspaceStateDatabase(
            request,
            target,
            mappedWorkspaceId,
            workspaceId,
            change.resourceId,
            content,
            registerBackup,
            exemptBackupPaths,
          );
        } else {
          // Plain files get the same re-check as every database branch: the
          // batch can run for minutes, and a notepads.json replaced under a
          // relaunched Cursor is a live file swapped out from beneath it.
          await ensureExclusiveAccess();
          await writeFileAtomicWithinRoot(
            request.paths.workspaceStorageRoot,
            targetRelativePath,
            content,
          );
        }
        const lastUpdatedAt = change.metadata?.lastUpdatedAt;
        if (
          typeof lastUpdatedAt === "number" &&
          Number.isFinite(lastUpdatedAt) &&
          lastUpdatedAt >= 0 &&
          !workspaceDatabase
        ) {
          const timestamp = new Date(lastUpdatedAt);
          await utimes(target, timestamp, timestamp);
        }
        applied.push(change.resourceId);
        continue;
      }

      if (change.kind === "chat-transcript") {
        if (change.operation === "delete") {
          skipped.push(`${change.resourceId}: transcript tombstone retained`);
          applied.push(change.resourceId);
          retainedLocal.push(change.resourceId);
          continue;
        }
        if (content === undefined) {
          throw new Error(`Transcript payload is missing: ${change.resourceId}`);
        }
        const relativePath = metadataString(change.metadata, "relativePath");
        if (
          change.resourceId !==
          `chat-transcript/${encodeURIComponent(relativePath)}`
        ) {
          throw new Error(`Transcript metadata does not match ${change.resourceId}.`);
        }
        const transcriptSegments = relativePath.split("/");
        if (
          transcriptSegments.length < 3 ||
          !transcriptSegments.slice(1, -1).includes("agent-transcripts") ||
          !/\.(jsonl|txt)$/i.test(transcriptSegments.at(-1) ?? "")
        ) {
          throw new Error(`Transcript path is not allowlisted: ${relativePath}`);
        }
        const target = assertSafeRelativePath(request.paths.cursorProjects, relativePath);
        // Cursor appends to live transcripts; writing one under a relaunched
        // Cursor would truncate a session it is still recording.
        await ensureExclusiveAccess();
        await writeFileAtomicWithinRoot(
          request.paths.cursorHome,
          normalizeResourcePath(relative(request.paths.cursorHome, target)),
          content,
        );
        applied.push(change.resourceId);
        continue;
      }

      if (change.kind === "chat-store") {
        if (change.operation === "delete") {
          skipped.push(`${change.resourceId}: store tombstone retained`);
          applied.push(change.resourceId);
          retainedLocal.push(change.resourceId);
          continue;
        }
        if (content === undefined) {
          throw new Error(`Chat store payload is missing: ${change.resourceId}`);
        }
        const snapshot = parsePortableStoreSnapshot(content);
        if (
          change.resourceId !==
          `chat-store/${encodeURIComponent(snapshot.relativePath)}`
        ) {
          throw new Error(`Chat store payload does not match ${change.resourceId}.`);
        }
        const storeSegments = snapshot.relativePath.split("/");
        if (
          storeSegments.length < 3 ||
          !["chats", "acp-sessions"].includes(storeSegments[0] ?? "") ||
          storeSegments.at(-1)?.toLowerCase() !== "store.db"
        ) {
          throw new Error(`Chat store path is not allowlisted: ${snapshot.relativePath}`);
        }
        const lexicalTarget = assertSafeRelativePath(
          request.paths.cursorHome,
          snapshot.relativePath,
        );
        const target = await prepareFilePathWithinRoot(
          request.paths.cursorHome,
          normalizeResourcePath(
            relative(request.paths.cursorHome, lexicalTarget),
          ),
        );
        await ensureExclusiveAccess();
        await applyStoreSnapshot(
          target,
          snapshot,
          request.storageRoot,
          request.requestId,
          registerBackup,
          exemptBackupPaths,
        );
        const appliedHash = sha256(
          canonicalBytes(readStoreSnapshot(target, snapshot.relativePath)),
        );
        if (appliedHash !== change.semanticHash) {
          // The upsert-only merge retained target-only rows; remember the
          // union hash so the next scan does not republish it (ping-pong).
          retainedLocal.push(change.resourceId);
          retainedLocalHashes[change.resourceId] = appliedHash;
        }
        applied.push(change.resourceId);
      }
    } catch (error) {
      if (error instanceof CursorReopenedError) {
        throw error;
      }
      // Each database merge is transactional, so one corrupt or drifted
      // resource is skipped and stays pending without aborting the batch. It
      // is ALSO a failure: folded into skipped alone it sat between routine
      // "tombstone retained" lines inside a green success result, and a
      // resource that failed the same way on every apply was never surfaced.
      const line = `${change.resourceId}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      skipped.push(line);
      failures.push(`Applying ${line}`);
    }
  }

  const extensionResult = await applyExtensionChanges(
    request,
    prepared,
    ensureExclusiveAccess,
    registerBackup,
    heartbeat,
    exemptBackupPaths,
  );
  applied.push(...extensionResult.applied);
  skipped.push(...extensionResult.skipped);
  retainedLocal.push(...extensionResult.retainedLocal);
  Object.assign(retainedLocalHashes, extensionResult.retainedLocalHashes);
  return {
    applied,
    skipped,
    failures,
    backupPaths: backups.map((backup) => backup.backupPath),
    backups,
    retainedLocal,
    retainedLocalHashes,
  };
}

async function mergeWorkspaceStateDatabase(
  request: HelperRequest,
  target: string,
  targetWorkspaceId: string,
  sourceWorkspaceId: string,
  resourceId: string,
  content: Buffer,
  registerBackup: (backup: HelperBackup) => void,
  exemptBackupPaths: () => readonly string[] = () => [],
): Promise<void> {
  const parsed = parseWorkspaceDatabaseSnapshot(content);
  if (parsed.workspaceId !== sourceWorkspaceId) {
    throw new Error("Workspace database payload does not match its workspace metadata.");
  }
  // Events published before the portable-rows policy carry machine chrome from
  // the other computer; writing it would overwrite this machine's live layout
  // with rows the scan no longer even publishes back. Skipped, not fatal - the
  // events are immutable and this extension wrote them.
  const incoming = filterPortableWorkspaceRows(parsed);
  const backupRoot = join(request.storageRoot, "backups");
  await ensureDirectory(backupRoot);
  // The resource digest keeps names unique when two remote workspaces resolve
  // to the same local workspace within one request.
  const backupPath = join(
    backupRoot,
    `workspace-${targetWorkspaceId}-${request.requestId}-${sha256(resourceId).slice(0, 12)}.vscdb`,
  );
  await applyWorkspaceDatabaseSnapshot({
    targetPath: target,
    backupPath,
    targetWorkspaceId,
    incoming,
    hooks: {
      afterBackupValidated: async () => {
        await enforceBackupRetention(request.storageRoot, {
          exemptPaths: [...exemptBackupPaths(), backupPath],
        });
        registerBackup({ backupPath, contract: "workspace", targetPath: target });
      },
    },
  });
}

async function applyStoreSnapshot(
  target: string,
  snapshot: ReturnType<typeof parsePortableStoreSnapshot>,
  storageRoot: string,
  requestId: string,
  registerBackup: (backup: HelperBackup) => void,
  exemptBackupPaths: () => readonly string[] = () => [],
): Promise<void> {
  await ensureDirectory(dirname(target));
  if (await pathExists(target)) {
    const backupRoot = join(storageRoot, "backups");
    await ensureDirectory(backupRoot);
    const backupPath = join(
      backupRoot,
      `store-${requestId}-${Buffer.from(snapshot.relativePath).toString("base64url")}.db`,
    );
    const source = openDatabase(target, { readOnly: true });
    try {
      source.exec("PRAGMA query_only=ON");
      assertStoreSchema(source);
      assertIntegrity(source);
      await backupDatabase(source, backupPath, { rate: 100 });
    } finally {
      source.close();
    }
    await sealBackupFile(backupPath);
    const backup = openDatabase(backupPath, { readOnly: true });
    try {
      backup.exec("PRAGMA query_only=ON");
      assertStoreSchema(backup);
      assertIntegrity(backup);
    } finally {
      backup.close();
    }
    await enforceBackupRetention(storageRoot, {
      exemptPaths: [...exemptBackupPaths(), backupPath],
    });
    // Retention is contractually unable to touch an exempt backup, so
    // existence is the only thing left to confirm; the full re-verification
    // this used to run bought nothing.
    if (!(await pathExists(backupPath))) {
      throw new Error(`The store backup disappeared during retention: ${backupPath}`);
    }
    registerBackup({ backupPath, contract: "store", targetPath: target });
  }

  const database = openDatabase(target);
  let transactionStarted = false;
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    // No declared type on the value columns, which gives them BLOB affinity:
    // SQLite then stores whatever storage class is bound. A `value TEXT`
    // column would silently coerce a restored INTEGER or REAL to text, so the
    // immediate read-back would disagree with the source and the resource
    // would be stuck as retained-local forever. Cursor's own schema leaves
    // these untyped for the same reason.
    database.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value)",
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data)",
    );
    assertStoreSchema(database);
    const upsertMeta = database.prepare(
      `INSERT INTO meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const upsertBlob = database.prepare(
      `INSERT INTO blobs(id, data) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    );
    for (const row of snapshot.meta) {
      upsertMeta.run(row.key, restoreStoreValue(row.value));
    }
    for (const row of snapshot.blobs) {
      upsertBlob.run(row.id, restoreStoreValue(row.data));
    }
    assertIntegrity(database);
    database.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

async function applyExtensionChanges(
  request: HelperRequest,
  prepared: PreparedHelperChange[],
  ensureExclusiveAccess: () => Promise<void>,
  registerBackup: (backup: HelperBackup) => void,
  heartbeat: () => void = () => {},
  exemptBackupPaths: () => readonly string[] = () => [],
): Promise<{
  applied: string[];
  skipped: string[];
  retainedLocal: string[];
  retainedLocalHashes: Record<string, string>;
}> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const retainedLocal: string[] = [];
  const retainedLocalHashes: Record<string, string> = {};
  const ignoredExtensions = createExtensionIgnoreMatcher(
    request.syncOptions.ignoredExtensions,
  );
  // A Linux AppImage unmounts its application root once Cursor exits, so the
  // CLI can be gone by the time the helper runs. Deferring keeps the changes
  // pending for a run where it is reachable instead of failing them.
  let cliPath: string | null | undefined;
  const cursorCliPath = async (): Promise<string | null> => {
    if (cliPath === undefined) {
      const candidate =
        typeof request.paths.appRoot === "string" &&
        request.paths.appRoot.length > 0
          ? join(request.paths.appRoot, "out", "cli.js")
          : null;
      cliPath =
        candidate !== null && (await pathExists(candidate)) ? candidate : null;
    }
    return cliPath;
  };
  for (const item of prepared.filter(
    (candidate) => candidate.change.kind === "extension",
  )) {
    const { change, content } = item;
    try {
      const extensionId = metadataString(change.metadata, "extensionId").toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i.test(extensionId)) {
        throw new Error(`Invalid extension identifier: ${extensionId}`);
      }
      const profileId = metadataString(change.metadata, "profileId");
      assertValidProfileId(profileId);
      const profileName = metadataString(change.metadata, "profileName");
      assertSafeProfileName(profileName);
      if (
        change.resourceId !==
        `extension/${encodeURIComponent(profileId)}/${encodeURIComponent(extensionId)}`
      ) {
        throw new Error(`Extension metadata does not match ${change.resourceId}.`);
      }
      if (extensionId === EXTENSION_ID.toLowerCase()) {
        skipped.push(`${change.resourceId}: synchronization extension is protected`);
        retainedLocal.push(change.resourceId);
        applied.push(change.resourceId);
        continue;
      }
      if (ignoredExtensions.matches(extensionId)) {
        skipped.push(`${change.resourceId}: extension is ignored on this device`);
        retainedLocal.push(change.resourceId);
        applied.push(change.resourceId);
        continue;
      }
      const profileArgs =
        profileId === "default" ? [] : ["--profile", profileName];
      const cli = await cursorCliPath();
      if (cli === null) {
        skipped.push(
          `${change.resourceId}: the Cursor CLI is unavailable in this session; the extension change stays pending`,
        );
        continue;
      }

      if (change.operation === "delete") {
        await ensureExclusiveAccess();
        try {
          await execFileAsync(
            request.cursorExecutable,
            [
              cli,
              "--uninstall-extension",
              extensionId,
              ...profileArgs,
            ],
            {
              windowsHide: true,
              timeout: 120_000,
              maxBuffer: 10 * 1024 * 1024,
              env: cliEnvironment(),
            },
          );
        } catch (error) {
          // Uninstalling an extension that is already absent is a success.
          if (!isNotInstalledCliFailure(error)) {
            skipped.push(`${change.resourceId}: ${cliFailureText(error)}`);
            continue;
          }
        }
        applied.push(change.resourceId);
        continue;
      }
      if (content === undefined) {
        throw new Error(`Extension payload is missing: ${change.resourceId}`);
      }
      const desired = parseExtensionDesiredState(content, extensionId);
      const { version, pinned, preRelease } = desired;
      const installTarget = pinned && version !== "latest"
        ? `${extensionId}@${version}`
        : extensionId;
      const args = ["--install-extension", installTarget, "--force", ...profileArgs];
      if (preRelease) {
        args.push("--pre-release");
      }
      await ensureExclusiveAccess();
      try {
        await execFileAsync(
          request.cursorExecutable,
          [cli, ...args],
          {
            windowsHide: true,
            timeout: 180_000,
            maxBuffer: 10 * 1024 * 1024,
            env: cliEnvironment(),
          },
        );
        // The CLI install is network-bound and can take minutes, so re-check
        // exclusivity right before writing to the enablement database.
        await ensureExclusiveAccess();
        await updateExtensionEnablement(
          request,
          profileId,
          extensionId,
          desired.enabled,
          registerBackup,
          heartbeat,
          exemptBackupPaths,
        );
      } catch (error) {
        if (error instanceof CursorReopenedError) {
          throw error;
        }
        skipped.push(`${change.resourceId}: ${cliFailureText(error)}`);
        continue;
      }
      if (installTarget === extensionId) {
        // A non-pinned install asks this machine's resolver for its own
        // engine-compatible "latest", which on a Cursor version skew is NOT
        // the version the other machine published. The next scan would then
        // republish this machine's version as a fresh change, the peer would
        // install ITS latest and republish, and the pair ping-ponged one
        // event per cycle indefinitely. Recording the hash of what was
        // actually installed lets the scan recognize it as the applied state.
        const actualVersion = await installedExtensionVersion(
          request,
          cli,
          profileArgs,
          extensionId,
        );
        if (actualVersion !== null && actualVersion !== version) {
          retainedLocal.push(change.resourceId);
          retainedLocalHashes[change.resourceId] = semanticHash({
            id: extensionId,
            version: actualVersion,
            installed: true,
            enabled: desired.enabled,
            preRelease: desired.preRelease,
            pinned: desired.pinned,
          });
        }
      }
      applied.push(change.resourceId);
    } catch (error) {
      if (error instanceof CursorReopenedError) {
        throw error;
      }
      // One invalid extension change is skipped and stays pending without
      // aborting the batch or the projection state save.
      skipped.push(
        `${change.resourceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { applied, skipped, retainedLocal, retainedLocalHashes };
}

/**
 * The version the CLI actually installed for this profile, or null when the
 * listing cannot be read - in which case no retained hash is recorded and the
 * next scan simply republishes, the pre-existing behavior.
 */
async function installedExtensionVersion(
  request: HelperRequest,
  cli: string,
  profileArgs: readonly string[],
  extensionId: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      request.cursorExecutable,
      [cli, "--list-extensions", "--show-versions", ...profileArgs],
      {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: cliEnvironment(),
      },
    );
    const prefix = `${extensionId.toLowerCase()}@`;
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith(prefix)) {
        return trimmed.slice(prefix.length);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function cliFailureText(error: unknown): string {
  const failure = error as { stderr?: unknown; stdout?: unknown };
  const output = [failure.stderr, failure.stdout]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  return output ?? (error instanceof Error ? error.message : String(error));
}

function isNotInstalledCliFailure(error: unknown): boolean {
  const failure = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return [failure.stderr, failure.stdout, failure.message].some(
    (value) => typeof value === "string" && /not installed/i.test(value),
  );
}

async function updateExtensionEnablement(
  request: HelperRequest,
  profileId: string,
  extensionId: string,
  enabled: boolean,
  registerBackup: (backup: HelperBackup) => void,
  heartbeat: () => void = () => {},
  exemptBackupPaths: () => readonly string[] = () => [],
): Promise<void> {
  const databasePath =
    profileId === "default"
      ? request.paths.globalDatabase
      : join(
          request.paths.profilesRoot,
          profileId,
          "globalStorage",
          "state.vscdb",
        );
  if (!(await pathExists(databasePath))) {
    return;
  }
  await assertSafeRelativePathOnDisk(
    request.paths.userDataRoot,
    normalizeResourcePath(relative(request.paths.userDataRoot, databasePath)),
    { finalType: "file" },
  );
  // Read before backing up. `backupDatabase` copies the whole file - 1.2 GiB on
  // a real user's global database - and this runs once per extension inside the
  // install loop, so a request touching a dozen extensions wrote a dozen full
  // copies and blew the entire 2 GiB retention budget, evicting the global
  // apply's own backup with it. Almost none of those copies protected anything:
  // an extension that arrives enabled is simply absent from the disabled list,
  // so there was nothing to change. Nothing below this point writes, so nothing
  // below this point needs a backup.
  if (!(await enablementWouldChange(databasePath, extensionId, enabled))) {
    return;
  }
  const backupRoot = join(request.storageRoot, "backups");
  await ensureDirectory(backupRoot);
  // Named per database and request, NOT per extension: the rollback point for
  // this request's enablement writes is the database before its FIRST such
  // write, and one 1.3 GiB copy per extension was how three default-profile
  // extensions blew the byte budget and evicted the same request's pre-apply
  // global backup - the exact data loss the budget exists to prevent.
  const backupPath = join(
    backupRoot,
    `extensions-${profileId}-${request.requestId}.vscdb`,
  );
  const backupAlreadyTaken = await pathExists(backupPath);
  const database = openDatabase(databasePath);
  let transactionStarted = false;
  try {
    database.exec("PRAGMA busy_timeout=5000");
    assertItemTableSchema(database);
    if (!backupAlreadyTaken) {
      // The integrity pass over a possibly multi-GiB file is synchronous and
      // starves the lock heartbeat; refresh it explicitly on either side.
      heartbeat();
      assertIntegrity(database);
      await backupDatabase(database, backupPath, { rate: 100 });
      await sealBackupFile(backupPath);
      heartbeat();
      const backup = openDatabase(backupPath, { readOnly: true });
      try {
        backup.exec("PRAGMA query_only=ON");
        assertItemTableSchema(backup);
        assertIntegrity(backup);
      } finally {
        backup.close();
      }
      heartbeat();
      await enforceBackupRetention(request.storageRoot, {
        exemptPaths: [...exemptBackupPaths(), backupPath],
      });
      if (!(await pathExists(backupPath))) {
        throw new Error(
          `The enablement backup disappeared during retention: ${backupPath}`,
        );
      }
      registerBackup({ backupPath, contract: "item-table", targetPath: databasePath });
    }
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("extensionsIdentifiers/disabled") as
      | { value?: SqliteStorageValue }
      | undefined;
    const raw = row?.value;
    const disabled = parseDisabledExtensions(raw);
    const existingEntry = disabled.find(
      (item) => disabledExtensionId(item)?.toLowerCase() === extensionId,
    );
    const filtered = disabled.filter(
      (item) => disabledExtensionId(item)?.toLowerCase() !== extensionId,
    );
    if (!enabled) {
      filtered.push(existingEntry ?? { id: extensionId });
    }
    // A no-op enable must not gratuitously replace an absent or NULL row with
    // the string "[]" in the user's live database.
    if (filtered.length > 0 || (raw !== undefined && raw !== null)) {
      database
        .prepare(
          `INSERT INTO ItemTable(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run("extensionsIdentifiers/disabled", JSON.stringify(filtered));
    }
    assertIntegrity(database);
    database.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

/**
 * Whether writing the enablement row would actually change it.
 *
 * Deliberately mirrors the write below rather than approximating it: the same
 * `parseDisabledExtensions`, the same case-folded identifier match, and the
 * same "a no-op enable must not replace an absent or NULL row with `[]`" rule.
 * A read-only connection, so it cannot be the thing that needs a backup.
 */
async function enablementWouldChange(
  databasePath: string,
  extensionId: string,
  enabled: boolean,
): Promise<boolean> {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database.exec("PRAGMA query_only=ON");
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("extensionsIdentifiers/disabled") as
      | { value?: SqliteStorageValue }
      | undefined;
    const raw = row?.value;
    const disabled = parseDisabledExtensions(raw);
    const listed = disabled.some(
      (item) => disabledExtensionId(item)?.toLowerCase() === extensionId,
    );
    // The list records what is DISABLED, so the two agree exactly when work is
    // needed: enabled-and-listed has to be removed from it, disabled-and-absent
    // has to be added to it. The other two combinations rewrite what is already
    // there, which is the common case after an install - a freshly installed
    // extension arrives enabled and is simply not in the list.
    return enabled === listed;
  } catch {
    // An unreadable or unexpected database is exactly when the backup earns its
    // keep; fall through to the guarded write path rather than skipping it.
    return true;
  } finally {
    database.close();
  }
}

function parseDisabledExtensions(
  value: SqliteStorageValue | undefined,
): unknown[] {
  // A NULL disabled list means "nothing is disabled", exactly like an absent
  // row; the caller writes a real JSON array back when it needs to change it.
  if (value === undefined || value === null) {
    return [];
  }
  const text = sqliteStorageText(value, "Disabled extension state");
  if (text.trim().length === 0) {
    return [];
  }
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Disabled extension state must be an array.");
  }
  if (parsed.length > 100_000) {
    throw new Error("Disabled extension state contains too many entries.");
  }
  return parsed;
}

function disabledExtensionId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

interface ExtensionDesiredState {
  id: string;
  version: string;
  installed: true;
  enabled: boolean;
  preRelease: boolean;
  pinned: boolean;
}

function parseExtensionDesiredState(
  content: Buffer,
  expectedExtensionId: string,
): ExtensionDesiredState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("Extension desired state is not valid JSON.", {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extension desired state must be an object.");
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    value.id.toLowerCase() !== expectedExtensionId ||
    typeof value.version !== "string" ||
    !/^(?:latest|[0-9][0-9A-Za-z.+_-]{0,127})$/.test(value.version) ||
    value.installed !== true ||
    typeof value.enabled !== "boolean" ||
    typeof value.preRelease !== "boolean" ||
    typeof value.pinned !== "boolean"
  ) {
    throw new Error("Extension desired state fields are invalid or inconsistent.");
  }
  return {
    id: value.id.toLowerCase(),
    version: value.version,
    installed: true,
    enabled: value.enabled,
    preRelease: value.preRelease,
    pinned: value.pinned,
  };
}

function assertSafeProfileName(profileName: string): void {
  if (
    profileName.length === 0 ||
    profileName.length > 256 ||
    profileName.startsWith("-") ||
    [...profileName].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("Extension profile name is unsafe for the Cursor CLI.");
  }
}

function restoreStoreValue(
  value: PortableStoreValue,
): null | string | Buffer | number | bigint {
  if (value.type === "null") {
    return null;
  }
  if (value.type === "text") {
    return String(value.value);
  }
  if (value.type === "blob") {
    return Buffer.from(String(value.value), "base64");
  }
  if (value.type === "integer") {
    return BigInt(String(value.value));
  }
  return Number(value.value);
}

function assertIntegrity(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA integrity_check").get() as
    | { integrity_check?: string }
    | undefined;
  if (row?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${String(row?.integrity_check)}`);
  }
}

function assertStoreSchema(database: DatabaseSync): void {
  for (const [table, expected] of [
    ["meta", ["key", "value"]],
    ["blobs", ["id", "data"]],
  ] as const) {
    const columns = database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => String(row.name));
    if (!expected.every((column) => columns.includes(column))) {
      throw new Error(`Chat store schema mismatch for ${table}.`);
    }
  }
}

function assertItemTableSchema(database: DatabaseSync): void {
  const columns = database
    .prepare('PRAGMA table_info("ItemTable")')
    .all()
    .map((row) => String(row.name));
  if (!["key", "value"].every((column) => columns.includes(column))) {
    throw new Error("Extension enablement database schema mismatch for ItemTable.");
  }
}

function metadataString(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string {
  const value = metadata?.[key];
  if (typeof value !== "string") {
    throw new Error(`Helper change metadata is missing ${key}.`);
  }
  return value;
}

function metadataStringOrNull(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Helper change metadata ${key} must be a string or null.`);
  }
  return value;
}

function cliEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
  };
}
