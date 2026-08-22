import type { DatabaseSync, SqliteStorageValue } from "../platform/sqlite";
import {
  backupDatabase,
  openDatabase,
  sealBackupFile,
  sqliteStorageText,
} from "../platform/sqlite";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  BACKUP_DIRECTORY,
  CURSOR_USER_RULES_KEY,
  TARGET_STORAGE_MARKER,
  USER_STORAGE_TARGET,
} from "../constants";
import type { ApplyJournal, JsonValue } from "../types";
import type { HelperChange, HelperRequest } from "./types";
import { enforceBackupRetention } from "./backupRetention";
import {
  ensureDirectory,
  assertSafeIdentifier,
  isMissingPathError,
  pathExists,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/files";
import {
  bubbleKeyRange,
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  type PortableAgentKvPayload,
  type PortableChatSnapshot,
  type PortableChatSnapshotV2,
  type PortableKvRow,
} from "../chat/stateVscdb";
import { updatePortableComposerHeaderHash } from "../chat/headerCanonical";
import {
  DEFAULT_BROKEN_CHAT_INSPECTION_LIMITS,
  auditChatReferences,
  readPortableChatSnapshotBounded,
} from "../chat/repair";
import {
  lookupWorkspaceIdentityReferences,
  resolveTargetWorkspace,
  type WorkspaceIdentity,
} from "../chat/workspace";
import {
  normalizeProfile,
  parsePortableProfiles,
  type PortableProfile,
} from "../resources/profiles";
import {
  assertBoundedJsoncStructure,
  semanticHash,
} from "../resources/jsonc";
import {
  inspectSqliteValue,
  readSqliteValue,
} from "../resources/boundedScan";
import {
  canonicalBytes,
  canonicalJson,
  compareCodeUnits,
  sha256,
} from "../protocol/canonical";
import {
  effectiveSourceDeviceId,
  effectiveSyncOrigin,
} from "../sync/versionPolicy";
import {
  isIgnoredUiStateKey,
  isPolicyExcludedUiStateKey,
  isSecurityDeniedUiStateKey,
  normalizeIgnoredUiStateKeys,
  MAX_TARGET_STORAGE_MARKER_BYTES,
  parseTargetStorageMarker,
  serializeTargetStorageMarker,
} from "../resources/uiStatePolicy";
import type { IgnoreMatcher } from "../resources/ignorePatterns";
import { isRemoteTargetsKey } from "../resources/remoteTargets";

const MAX_STORED_PROFILE_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface PreparedHelperChange {
  change: HelperChange;
  content?: Buffer;
}

export interface DatabaseApplyResult {
  backupPath: string;
  applied: string[];
  skipped: string[];
  /** Automatic repairs that failed safely and must not retry every shutdown. */
  failureByResourceId: Record<string, string>;
  /** Resources whose bytes on disk differ from the published version. */
  retainedLocal: string[];
  /** What the next scan of those resources will hash to. */
  retainedLocalHashes: Record<string, string>;
  /**
   * Blob-only enrichment core shortcut: the verified source-equal hash, or
   * null when the preserved local core is partial or divergent.
   */
  localChatCoreHashes: Record<string, string | null>;
}

interface RestoreJournal {
  version: 1 | 2 | 3;
  requestId: string;
  status: string;
  databasePath: string;
  backupPath: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  contract: DatabaseContract;
  /** Added in version 3; older journals do not record a pre-restore backup. */
  preRestoreBackupPath?: string | null;
}

export type DatabaseContract =
  | "global"
  | "store"
  | "item-table"
  | "workspace"
  | "integrity";

const COMPLETED_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long after its start an interrupted restore is still replayed. Beyond
 * this the replay would rewind days of use to a stale backup - the user
 * re-runs Restore Backup deliberately instead.
 */
const RESTORE_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function recoverInterruptedApplyJournals(
  storageRoot: string,
  databasePath: string,
  /**
   * Re-verifies that Cursor is still closed; its throw aborts the whole run
   * with the pending journal intact, to be replayed by the next closed-Cursor
   * helper. Every other replay failure is recorded on its own journal and the
   * loop continues - one journal whose backup no longer validates must not
   * take down every later apply and every shutdown export forever.
   */
  ensureCursorStillClosed: () => Promise<void> = async () => {},
  registerBackup: (backup: {
    backupPath: string;
    contract: DatabaseContract;
    targetPath: string;
  }) => void = () => {},
  notice: (message: string) => void = () => {},
): Promise<void> {
  const journalPaths = await listJournalFiles(storageRoot);
  for (const path of journalPaths) {
    const name = basename(path);
    if (!name.startsWith("restore-") || !name.endsWith(".json")) {
      continue;
    }
    const journal = await readJournalOrQuarantine<RestoreJournal>(path);
    if (journal === null) {
      continue;
    }
    if (journal.completedAt !== null) {
      await removeExpiredJournal(path, journal.completedAt);
      continue;
    }
    await recoverRestoreJournal(
      path,
      journal,
      ensureCursorStillClosed,
      registerBackup,
      notice,
    );
  }
  for (const path of journalPaths) {
    const name = basename(path);
    if (!name.startsWith("apply-") || !name.endsWith(".json")) {
      continue;
    }
    const journal = await readJournalOrQuarantine<ApplyJournal>(path);
    if (journal === null) {
      continue;
    }
    if (journal.completedAt !== null) {
      await removeExpiredJournal(path, journal.completedAt);
      continue;
    }
    if (journal.status === "committed") {
      validateDatabaseFile(databasePath, "global");
      journal.status = "verified";
      journal.error = "Verified a committed database apply after an interrupted journal update.";
    } else if (journal.status === "applying") {
      // The global apply is a single BEGIN IMMEDIATE ... COMMIT transaction,
      // so an interrupted apply left the live database either fully pre-apply
      // or fully post-apply. Restoring the backup here would destroy every
      // write made since it was taken.
      validateDatabaseFile(databasePath, "global");
      journal.status = "failed";
      journal.error =
        "Interrupted during the apply transaction; SQLite transactional atomicity kept the live database consistent and un-applied changes remain queued in pendingDatabaseChanges for re-apply.";
    } else {
      validateDatabaseFile(databasePath, "global");
      journal.status = "failed";
      journal.error = "Interrupted before the database transaction began; the live database is healthy.";
    }
    journal.completedAt = new Date().toISOString();
    await writeJsonAtomic(path, journal);
    if (journal.status === "verified") {
      await rm(path, { force: true });
    }
  }
  for (const path of journalPaths) {
    const name = basename(path);
    if (
      (!name.startsWith("restore-") && !name.startsWith("apply-")) ||
      !name.endsWith(".corrupt")
    ) {
      continue;
    }
    const info = await stat(path).catch(() => null);
    if (
      info !== null &&
      Date.now() - info.mtimeMs > COMPLETED_JOURNAL_RETENTION_MS
    ) {
      await rm(path, { force: true });
    }
  }
}

/**
 * Journals live directly in the storage root; never walk into the potentially
 * multi-GiB backups directory below it.
 */
async function listJournalFiles(storageRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(storageRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(storageRoot, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

async function readJournalOrQuarantine<T>(path: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(path);
  } catch (error) {
    // One corrupt journal must not permanently fail every helper run, but a
    // transient filesystem error (EBUSY/EPERM/EACCES) must not orphan a
    // pending journal either; only proven parse failures are quarantined.
    if (error instanceof SyntaxError) {
      try {
        await rename(path, `${path}.corrupt`);
      } catch {
        // Leave it in place; it is skipped for this run.
      }
    }
    return null;
  }
}

async function removeExpiredJournal(
  path: string,
  completedAt: string,
): Promise<void> {
  const completedMs = Date.parse(completedAt);
  if (
    Number.isFinite(completedMs) &&
    Date.now() - completedMs <= COMPLETED_JOURNAL_RETENTION_MS
  ) {
    return;
  }
  await rm(path, { force: true });
}

export async function applyGlobalDatabaseChanges(
  request: HelperRequest,
  prepared: PreparedHelperChange[],
  /**
   * Called between changes so the caller can keep its lock alive.
   *
   * `node:sqlite` is synchronous, so a large apply holds the event loop for
   * minutes and the lock's heartbeat - an interval timer - never gets to run.
   * The lock file's mtime then stops advancing, and after the staleness TTL
   * another process concludes the holder has died and takes the lock over while
   * this one is still writing to the database. `FileLock.refresh` is
   * synchronous for exactly this reason.
   */
  heartbeat: () => void = () => {},
  /**
   * Awaited immediately before the write transaction opens. The backup, seal,
   * validation and retention above it take minutes on a multi-GiB database -
   * long enough for the user to relaunch Cursor, whose in-memory write-back
   * at its next quit would silently revert a commit made under it while the
   * changes were already marked applied and de-queued. A throw here aborts
   * with the live database untouched and the changes still pending.
   */
  beforeDestructiveWrite: () => Promise<void> = async () => {},
  /** Backups earlier steps of the same run took; retention must spare them. */
  priorBackups: () => readonly string[] = () => [],
  /** Repository device that owns this local database. Required for repairs. */
  localDeviceId?: string,
): Promise<DatabaseApplyResult> {
  const localWorkspaces = await preflightGlobalChanges(request, prepared);
  const databasePath = request.paths.globalDatabase;
  const backupRoot = join(request.storageRoot, BACKUP_DIRECTORY);
  await ensureDirectory(backupRoot);
  const backupPath = join(
    backupRoot,
    `state-${new Date().toISOString().replaceAll(":", "-")}-${request.requestId}.vscdb`,
  );
  const journalPath = join(request.storageRoot, `apply-${request.requestId}.json`);
  const journal: ApplyJournal = {
    version: 1,
    requestId: request.requestId,
    status: "pending",
    databasePath,
    backupPath: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
  await writeJsonAtomic(journalPath, journal);

  const database = openDatabase(databasePath);
  let committed = false;
  try {
    database.exec("PRAGMA busy_timeout=5000");
    assertGlobalSchema(database);
    assertCheck(database, "quick_check");

    const backupSource = openDatabase(databasePath, { readOnly: true });
    try {
      backupSource.exec("PRAGMA query_only=ON");
      await backupDatabase(backupSource, backupPath, { rate: 100 });
    } finally {
      backupSource.close();
    }
    await sealBackupFile(backupPath);
    validateDatabaseFile(backupPath, "global");
    await enforceBackupRetention(request.storageRoot, {
      exemptPath: backupPath,
      exemptPaths: priorBackups(),
    });
    // Retention is contractually unable to touch the exempt backup, so a
    // second full integrity pass over a possibly multi-GiB file bought
    // nothing; existence is the only thing left to confirm.
    if (!(await pathExists(backupPath))) {
      throw new Error(`The pre-apply backup disappeared during retention: ${backupPath}`);
    }
    journal.status = "backed-up";
    journal.backupPath = backupPath;
    await writeJsonAtomic(journalPath, journal);

    journal.status = "applying";
    await writeJsonAtomic(journalPath, journal);
    await beforeDestructiveWrite();
    database.exec("BEGIN IMMEDIATE");
    const result = applyPreparedChanges(
      database,
      request,
      prepared,
      localWorkspaces,
      heartbeat,
      localDeviceId,
    );
    assertCheck(database, "integrity_check");
    database.exec("COMMIT");
    committed = true;
    journal.status = "committed";
    await writeJsonAtomic(journalPath, journal);

    // A busy checkpoint is not corruption. The committed WAL remains valid and
    // SQLite will checkpoint it later, so do not turn that into a failed apply.
    checkpointBestEffort(database);
    journal.status = "verified";
    journal.completedAt = new Date().toISOString();
    await writeJsonAtomic(journalPath, journal);
    return { backupPath, ...result };
  } catch (error) {
    if (!committed) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction may not have started.
      }
    }
    database.close();
    let validationError: unknown = null;
    try {
      validateDatabaseFile(databasePath, "global");
    } catch (caught) {
      validationError = caught;
    }
    journal.status = committed ? "committed" : "failed";
    const originalMessage = formatUnknownError(error);
    journal.error = validationError === null
      ? originalMessage
      : `${originalMessage}\nDatabase validation also failed: ${formatUnknownError(
          validationError,
        )}`;
    journal.completedAt = new Date().toISOString();
    await writeJsonAtomic(journalPath, journal);
    if (validationError !== null) {
      throw new AggregateError(
        [error, validationError],
        "Database apply failed and the live database did not pass validation.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    try {
      database.close();
    } catch {
      // It may already be closed by the recovery path.
    }
  }
}

export async function restoreDatabaseBackup(
  databasePath: string,
  backupPath: string,
  storageRoot: string,
  requestId: string = randomUUID(),
  contract: DatabaseContract = "global",
  /**
   * Called immediately before the destructive DELETE+INSERT. Everything above
   * it - validating a multi-GiB backup, capturing the pre-restore snapshot -
   * takes minutes, and a restore committed after Cursor was relaunched is
   * silently undone by Cursor's in-memory write-back at its next quit. Throw
   * to abort with the live database untouched.
   */
  beforeDestructiveWrite: () => Promise<void> = async () => {},
): Promise<string> {
  if (!(await pathExists(backupPath))) {
    throw new Error(`Backup does not exist: ${backupPath}`);
  }
  if (!(await pathExists(databasePath))) {
    throw new Error(
      `Target database does not exist; refusing to replace it with a file: ${databasePath}`,
    );
  }
  await ensureDirectory(storageRoot);
  await ensureDirectory(dirname(databasePath));
  const journalPath = join(storageRoot, `restore-${requestId}.json`);
  const journal: RestoreJournal = {
    version: 3,
    requestId,
    status: "preparing",
    databasePath,
    backupPath,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    contract,
    preRestoreBackupPath: null,
  };
  await writeJsonAtomic(journalPath, journal);
  try {
    validateDatabaseFile(backupPath, contract);
    validateDatabaseFile(databasePath, contract);
    journal.status = "source-validated";
    await writeJsonAtomic(journalPath, journal);

    // A restore destructively rewrites the allowlisted tables, so capture the
    // live database first; a mistaken restore stays recoverable.
    const preRestoreBackupPath = await createPreRestoreBackup(
      databasePath,
      storageRoot,
      requestId,
      contract,
    );
    journal.status = "pre-restore-backed-up";
    journal.preRestoreBackupPath = preRestoreBackupPath;
    await writeJsonAtomic(journalPath, journal);

    await beforeDestructiveWrite();
    journal.status = "applying";
    await writeJsonAtomic(journalPath, journal);
    // The re-check runs again INSIDE, immediately before the transaction: the
    // source integrity_check between here and the DELETE+INSERT takes minutes
    // on a multi-GiB backup, which is its own reopen window.
    await restoreKnownTablesWithQueries(
      databasePath,
      backupPath,
      contract,
      beforeDestructiveWrite,
    );
    validateDatabaseFile(databasePath, contract);
    journal.status = "verified";
    journal.completedAt = new Date().toISOString();
    await writeJsonAtomic(journalPath, journal);
    return preRestoreBackupPath;
  } catch (error) {
    journal.status = "failed";
    journal.completedAt = new Date().toISOString();
    journal.error = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeJsonAtomic(journalPath, journal);
    throw error;
  }
}

async function createPreRestoreBackup(
  databasePath: string,
  storageRoot: string,
  requestId: string,
  contract: DatabaseContract,
  nameSuffix = "",
): Promise<string> {
  const backupRoot = join(storageRoot, BACKUP_DIRECTORY);
  await ensureDirectory(backupRoot);
  const preRestoreBackupPath = join(
    backupRoot,
    `pre-restore-${requestId}${nameSuffix}.vscdb`,
  );
  const preRestoreSource = openDatabase(databasePath, { readOnly: true });
  try {
    preRestoreSource.exec("PRAGMA query_only=ON");
    await backupDatabase(preRestoreSource, preRestoreBackupPath, { rate: 100 });
  } finally {
    preRestoreSource.close();
  }
  await sealBackupFile(preRestoreBackupPath);
  validateDatabaseFile(preRestoreBackupPath, contract);
  return preRestoreBackupPath;
}

/**
 * Restores only the allowlisted logical tables. The backup is attached as a
 * read source; the live database file and its WAL/SHM sidecars are never
 * copied, renamed, or replaced.
 */
async function restoreKnownTablesWithQueries(
  databasePath: string,
  backupPath: string,
  contract: DatabaseContract,
  /**
   * Awaited immediately before the DELETE+INSERT transaction. The
   * integrity_check of a multi-GiB restore source above it takes minutes -
   * long enough for Cursor to be relaunched, whose in-memory write-back
   * would undo the restore while it was reported successful. Checking here,
   * after every read-only preparation, shrinks the unguarded window to the
   * transaction itself.
   */
  beforeDestructiveWrite: () => Promise<void> = async () => {},
): Promise<void> {
  const tables = restoreTablesForContract(contract);
  const database = openDatabase(databasePath);
  let attached = false;
  let transactionStarted = false;
  try {
    database.exec("PRAGMA busy_timeout=5000");
    assertDatabaseContract(database, contract, "main");
    database.prepare("ATTACH DATABASE ? AS restore_source").run(backupPath);
    attached = true;
    assertCheck(database, "integrity_check", "restore_source");
    assertDatabaseContract(database, contract, "restore_source");

    const plans = tables.map((table) => {
      const targetColumns = readTableColumns(database, "main", table);
      const sourceColumns = readTableColumns(
        database,
        "restore_source",
        table,
      );
      if (
        targetColumns.length !== sourceColumns.length ||
        targetColumns.some((column, index) => column !== sourceColumns[index])
      ) {
        throw new Error(
          `Refused logical restore because ${table} schemas differ between the live database and backup.`,
        );
      }
      return { table, columns: targetColumns };
    });

    await beforeDestructiveWrite();
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    for (const { table, columns } of plans) {
      const quotedTable = quoteIdentifier(table);
      const quotedColumns = columns.map(quoteIdentifier).join(", ");
      database.exec(`DELETE FROM "main".${quotedTable}`);
      database.exec(
        `INSERT INTO "main".${quotedTable} (${quotedColumns}) ` +
          `SELECT ${quotedColumns} FROM "restore_source".${quotedTable}`,
      );
    }
    assertCheck(database, "integrity_check", "main");
    database.exec("COMMIT");
    transactionStarted = false;
    checkpointBestEffort(database);
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original restore error.
      }
    }
    throw error;
  } finally {
    if (attached) {
      try {
        database.exec("DETACH DATABASE restore_source");
      } catch {
        // Closing the connection also detaches the read-only source.
      }
    }
    database.close();
  }
}

function restoreTablesForContract(contract: DatabaseContract): string[] {
  if (contract === "global") {
    return ["ItemTable", "cursorDiskKV", "composerHeaders"];
  }
  if (contract === "store") {
    return ["meta", "blobs"];
  }
  if (contract === "workspace") {
    return ["ItemTable", "cursorDiskKV"];
  }
  if (contract === "item-table") {
    return ["ItemTable"];
  }
  throw new Error("An integrity-only database has no allowlisted tables to restore.");
}

function readTableColumns(
  database: DatabaseSync,
  schema: "main" | "restore_source",
  table: string,
): string[] {
  return database
    .prepare(`PRAGMA ${schema}.table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => String(row.name));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function checkpointBestEffort(database: DatabaseSync): void {
  try {
    database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
  } catch {
    // Checkpointing is maintenance, not part of transaction correctness. A
    // valid committed WAL is left for SQLite to checkpoint later.
  }
}

function validateDatabaseFile(
  path: string,
  contract: DatabaseContract = "integrity",
): void {
  const database = openDatabase(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    assertCheck(database, "integrity_check");
    assertDatabaseContract(database, contract);
  } finally {
    database.close();
  }
}

async function recoverRestoreJournal(
  journalPath: string,
  journal: RestoreJournal,
  ensureCursorStillClosed: () => Promise<void> = async () => {},
  registerBackup: (backup: {
    backupPath: string;
    contract: DatabaseContract;
    targetPath: string;
  }) => void = () => {},
  notice: (message: string) => void = () => {},
): Promise<void> {
  const contract = journal.contract ?? "global";
  if (!(await pathExists(journal.backupPath))) {
    validateDatabaseFile(journal.databasePath, contract);
    journal.status = "failed";
    journal.error = "Interrupted restore source is missing; the live database was left untouched.";
  } else if (
    Date.now() - Date.parse(journal.startedAt) > RESTORE_REPLAY_WINDOW_MS
  ) {
    // A destructive replay is only what the user still wants while the
    // interruption is fresh. Days later the machine has been used, other
    // machines have synced, and silently rewinding the database to a
    // days-old backup is a data-loss surprise, not a recovery. The journal
    // closes with instructions instead.
    validateDatabaseFile(journal.databasePath, contract);
    journal.status = "failed";
    journal.error =
      "An interrupted restore was found more than a day after it started and was NOT replayed; open \"Cursor Setting Sync: Manage\", choose \"Restore Data…\", then \"Restore a Local Database Backup (Emergency)\" if you still want it. The live database was left untouched.";
    notice(journal.error);
  } else {
    try {
      validateDatabaseFile(journal.backupPath, contract);
    } catch (error) {
      // A source that stopped validating - damaged since the interruption, or
      // written for a schema Cursor has since changed - is a permanent fact
      // about this journal. It used to throw out of the recovery loop, and
      // because every helper run recovers journals first, one bad journal
      // failed every later apply AND every shutdown export, forever.
      journal.status = "failed";
      journal.error = `The interrupted restore's source no longer validates and was not replayed: ${formatUnknownError(error)}. The live database was left untouched.`;
      journal.completedAt = new Date().toISOString();
      await writeJsonAtomic(journalPath, journal);
      return;
    }
    // Recovery may run long after the interruption, so the journal's original
    // pre-restore backup is stale; replaying the destructive restore without a
    // fresh one would discard everything written since.
    let preRestoreBackupPath: string;
    try {
      preRestoreBackupPath = await createPreRestoreBackup(
        journal.databasePath,
        dirname(journalPath),
        journal.requestId,
        contract,
        "-recovery",
      );
    } catch (error) {
      journal.status = "failed";
      journal.error = `Skipped replaying an interrupted restore because a fresh pre-restore backup could not be created: ${formatUnknownError(error)}`;
      journal.completedAt = new Date().toISOString();
      await writeJsonAtomic(journalPath, journal);
      return;
    }
    journal.preRestoreBackupPath = preRestoreBackupPath;
    await writeJsonAtomic(journalPath, journal);
    // Registered with the run so every later retention pass exempts it - the
    // recovery backup used to be the one backup of the run that retention
    // could evict minutes after it was taken, while it was the only capture
    // of the pre-replay state.
    registerBackup({
      backupPath: preRestoreBackupPath,
      contract,
      targetPath: journal.databasePath,
    });
    // Deliberately outside the catch below: Cursor having reopened is not a
    // fact about this journal, so it aborts the run and leaves the journal
    // pending for the next closed-Cursor helper.
    await ensureCursorStillClosed();
    try {
      await restoreKnownTablesWithQueries(
        journal.databasePath,
        journal.backupPath,
        contract,
        ensureCursorStillClosed,
      );
      validateDatabaseFile(journal.databasePath, contract);
    } catch (error) {
      // The replay transaction rolled back, so the live database holds what
      // it held before; prove that before recording the failure, because a
      // database that no longer validates must abort the run loudly instead.
      validateDatabaseFile(journal.databasePath, contract);
      journal.status = "failed";
      journal.error = `Replaying the interrupted restore failed and was not retried: ${formatUnknownError(error)}. The live database was validated and left as it is; the pre-restore backup captures its current state.`;
      journal.completedAt = new Date().toISOString();
      await writeJsonAtomic(journalPath, journal);
      return;
    }
    journal.status = "verified";
    journal.error = "Recovered an interrupted logical restore with a SQL transaction.";
    // A destructive replay the user never watched must not be invisible: the
    // notice rides the helper result into the output channel and the standing
    // warnings, naming the state it rewound and where the pre-replay copy is.
    notice(
      `Completed an interrupted restore from ${journal.startedAt} (source ${journal.backupPath}); the pre-replay state was saved to ${preRestoreBackupPath}.`,
    );
  }
  journal.completedAt = new Date().toISOString();
  await writeJsonAtomic(journalPath, journal);
  if (journal.status === "verified") {
    await rm(journalPath, { force: true });
  }
}

async function preflightGlobalChanges(
  request: HelperRequest,
  prepared: PreparedHelperChange[],
): Promise<WorkspaceIdentity[]> {
  const localWorkspaces = prepared.some((item) => item.change.kind === "chat")
    ? await lookupWorkspaceIdentityReferences(
        request.paths,
        preparedWorkspaceIds(prepared, "chat"),
        request.workspaceMappings,
      )
    : [];
  for (const item of prepared) {
    if (
      item.change.kind !== "profile" ||
      item.change.operation === "delete"
    ) {
      continue;
    }
    if (item.content === undefined) {
      throw new Error("Profile manifest payload is missing.");
    }
    const profiles = parsePortableProfiles(item.content);
    for (const profile of profiles) {
      portableToStoredProfile(profile, request.paths.profilesRoot);
      await mkdir(join(request.paths.profilesRoot, profile.id), {
        recursive: true,
      });
    }
  }
  return localWorkspaces;
}

function* preparedWorkspaceIds(
  prepared: readonly PreparedHelperChange[],
  kind: "chat" | "workspace-storage",
): Iterable<string> {
  for (const item of prepared) {
    if (item.change.kind !== kind) {
      continue;
    }
    const workspaceId = item.change.metadata?.workspaceId;
    if (typeof workspaceId === "string") {
      yield workspaceId;
      continue;
    }
    if (kind === "chat" && item.content !== undefined) {
      const payloadWorkspaceId = portableChatWorkspaceId(item.content);
      if (payloadWorkspaceId !== null && payloadWorkspaceId !== undefined) {
        yield payloadWorkspaceId;
      }
    }
  }
}

/**
 * Reads only the small header workspace ID from a retained chat Buffer. This
 * preserves legacy events whose metadata omitted workspaceId without parsing
 * and retaining a second potentially 32 MiB chat object graph in preflight.
 */
function portableChatWorkspaceId(
  content: Buffer,
): string | null | undefined {
  const key = Buffer.from("workspaceId", "ascii");
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x22) {
      continue;
    }
    const start = index + 1;
    let escaped = false;
    let end = start;
    for (; end < content.length; end += 1) {
      const byte = content[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (byte === 0x5c) {
        escaped = true;
        continue;
      }
      if (byte === 0x22) {
        break;
      }
    }
    if (end >= content.length) {
      return undefined;
    }
    index = end;
    if (
      end - start !== key.length ||
      !content.subarray(start, end).equals(key)
    ) {
      continue;
    }
    let cursor = end + 1;
    while (cursor < content.length && isJsonWhitespace(content[cursor]!)) {
      cursor += 1;
    }
    if (content[cursor] !== 0x3a) {
      continue;
    }
    cursor += 1;
    while (cursor < content.length && isJsonWhitespace(content[cursor]!)) {
      cursor += 1;
    }
    if (content.subarray(cursor, cursor + 4).toString("ascii") === "null") {
      return null;
    }
    if (content[cursor] !== 0x22) {
      return undefined;
    }
    const valueStart = cursor;
    escaped = false;
    cursor += 1;
    for (; cursor < content.length; cursor += 1) {
      const byte = content[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (byte === 0x5c) {
        escaped = true;
        continue;
      }
      if (byte !== 0x22) {
        continue;
      }
      if (cursor - valueStart > 1024) {
        return undefined;
      }
      try {
        const value = JSON.parse(
          content.subarray(valueStart, cursor + 1).toString("utf8"),
        ) as unknown;
        return typeof value === "string"
          ? assertSafeIdentifier(value, "workspace ID")
          : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  return undefined;
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * A violation that must abort the whole apply instead of degrading into a
 * per-change skip, because continuing would act on untrusted input.
 */
class FatalApplyError extends Error {}

/**
 * A repair-specific refusal. The savepoint still rolls back this resource,
 * but the caller records a durable pending block so the same stale recipe
 * does not take a multi-gigabyte backup again on every Cursor shutdown.
 */
class AutomaticChatRepairApplyError extends Error {}

type ChangeOutcome =
  | {
      status: "applied";
      /**
       * Present when what was WRITTEN differs from what was published - a
       * chat whose workspaceId was remapped to this machine's id, a profile
       * manifest merged with local-only profiles. The next scan hashes the
       * written form; without recording it here the mismatch republished the
       * resource every cycle, and on a two-machine pair each apply fed the
       * other's next publish forever.
       */
      retainedLocalHash?: string;
      /** Blob-only enrichment kept this exact local core instead of the tip's. */
      localChatCoreHash?: string | null;
    }
  | { status: "ignored" }
  /**
   * The local value wins and nothing was written, but the change is still
   * accounted for so it stops being pending — the same shape the ignored
   * extension and the retained tombstone branches use in `resourceApply`.
   */
  | {
      status: "retained-local";
      reason: string;
      localChatCoreHash?: string | null;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

function applyPreparedChanges(
  database: DatabaseSync,
  request: HelperRequest,
  prepared: PreparedHelperChange[],
  localWorkspaces: WorkspaceIdentity[],
  heartbeat: () => void = () => {},
  localDeviceId?: string,
): {
  applied: string[];
  skipped: string[];
  failureByResourceId: Record<string, string>;
  retainedLocal: string[];
  retainedLocalHashes: Record<string, string>;
  localChatCoreHashes: Record<string, string | null>;
} {
  const applied: string[] = [];
  const skipped: string[] = [];
  const failureByResourceId: Record<string, string> = {};
  const retainedLocal: string[] = [];
  const retainedLocalHashes: Record<string, string> = {};
  const localChatCoreHashes: Record<string, string | null> = {};
  const marker: MarkerState = {
    entries: null,
    serialized: null,
    dirty: false,
  };
  const ignoredUiStateKeys = normalizeIgnoredUiStateKeys(
    request.syncOptions.ignoredUiStateKeys ?? [],
  );

  for (const item of prepared) {
    heartbeat();
    // A savepoint keeps a rejected change from leaving partial writes behind,
    // so one unparseable snapshot never discards the rest of the batch.
    database.exec("SAVEPOINT cursor_sync_change");
    let outcome: ChangeOutcome;
    try {
      outcome = applyPreparedChange(
        database,
        request,
        item,
        localWorkspaces,
        marker,
        ignoredUiStateKeys,
        localDeviceId,
      );
      database.exec("RELEASE cursor_sync_change");
    } catch (error) {
      database.exec("ROLLBACK TO cursor_sync_change");
      database.exec("RELEASE cursor_sync_change");
      if (error instanceof FatalApplyError) {
        throw error;
      }
      outcome = {
        status: error instanceof AutomaticChatRepairApplyError
          ? "failed"
          : "skipped",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (outcome.status === "applied") {
      applied.push(item.change.resourceId);
      if (outcome.retainedLocalHash !== undefined) {
        retainedLocal.push(item.change.resourceId);
        retainedLocalHashes[item.change.resourceId] = outcome.retainedLocalHash;
      }
      if (outcome.localChatCoreHash !== undefined) {
        localChatCoreHashes[item.change.resourceId] = outcome.localChatCoreHash;
      }
    } else if (outcome.status === "retained-local") {
      skipped.push(`${item.change.resourceId}: ${outcome.reason}`);
      applied.push(item.change.resourceId);
      if (outcome.localChatCoreHash !== undefined) {
        localChatCoreHashes[item.change.resourceId] = outcome.localChatCoreHash;
      }
    } else if (outcome.status === "skipped") {
      skipped.push(`${item.change.resourceId}: ${outcome.reason}`);
    } else if (outcome.status === "failed") {
      skipped.push(`${item.change.resourceId}: ${outcome.reason}`);
      failureByResourceId[item.change.resourceId] = outcome.reason;
    }
  }

  // Rewriting an untouched marker would replace a NULL or absent row with the
  // literal "{}" on every apply, including batches that never read UI state.
  if (marker.dirty) {
    if (marker.entries === null) {
      throw new Error("Dirty target marker state was never loaded.");
    }
    const serializedMarker =
      marker.serialized ?? serializeTargetStorageMarker(marker.entries);
    database
      .prepare(
        `INSERT INTO ItemTable(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(TARGET_STORAGE_MARKER, serializedMarker);
  }
  return {
    applied,
    skipped,
    failureByResourceId,
    retainedLocal,
    retainedLocalHashes,
    localChatCoreHashes,
  };
}

function applyPreparedChange(
  database: DatabaseSync,
  request: HelperRequest,
  item: PreparedHelperChange,
  localWorkspaces: WorkspaceIdentity[],
  marker: MarkerState,
  ignoredUiStateKeys: IgnoreMatcher,
  localDeviceId?: string,
): ChangeOutcome {
  const { change, content } = item;
  if (change.kind === "chat") {
    if (change.operation === "delete") {
      return { status: "skipped", reason: "tombstone retained without hard delete" };
    }
    if (content === undefined) {
      throw new Error(`Chat payload is missing: ${change.resourceId}`);
    }
    const automaticRepair =
      effectiveSyncOrigin(change.metadata) === "automatic-chat-repair";
    const agentKvEnrichment = isAgentKvEnrichmentMetadata(change.metadata);
    let snapshot: PortableChatSnapshot;
    try {
      if (
        (automaticRepair || agentKvEnrichment) &&
        sha256(content) !== change.semanticHash
      ) {
        throw new Error(
          automaticRepair
            ? "Automatic chat repair payload hash does not match its event."
            : "Chat enrichment payload hash does not match its event.",
        );
      }
      snapshot = parsePortableChatSnapshot(content);
      if (change.resourceId !== `chat/${snapshot.composerId}`) {
        throw new Error(`Chat payload does not match ${change.resourceId}.`);
      }
      if (agentKvEnrichment) {
        if (!isPortableChatSnapshotV2(snapshot)) {
          throw new Error("Chat enrichment requires a schema v2 snapshot.");
        }
        if (!metadataBoolean(change.metadata, "agentKvEnrichmentAppliesCore")) {
          return applyAgentKvEnrichment(database, request, snapshot);
        }
      }
      if (automaticRepair) {
        const repairOriginDeviceId = assertSafeIdentifier(
          metadataString(change.metadata, "repairOriginDeviceId"),
          "repair origin device ID",
        );
        const effectiveSource = effectiveSourceDeviceId(
          change.metadata,
          change.sourceDeviceId,
        );
        if (
          effectiveSource === undefined ||
          repairOriginDeviceId !== effectiveSource
        ) {
          throw new Error(
            "Automatic chat repair origin does not match its trusted event device.",
          );
        }
        if (localDeviceId === undefined) {
          throw new Error(
            "Automatic chat repair cannot identify the local repository device.",
          );
        }
        return repairUnavailableChatBubbles(
          database,
          request,
          localWorkspaces,
          snapshot,
          change.metadata,
          metadataString(change.metadata, "repairFingerprint"),
          repairOriginDeviceId,
          localDeviceId,
          change.semanticHash,
        );
      }
    } catch (error) {
      if (automaticRepair) {
        throw new AutomaticChatRepairApplyError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    const sourceWorkspaceId = snapshot.header.workspaceId;
    if (sourceWorkspaceId === null) {
      // A workspace-less composer round-trips as workspace-less; there is
      // nothing to map and no local workspace it belongs to.
      const writtenHash = upsertChat(
        database,
        snapshot,
        null,
        request.syncOptions.maxPayloadBytes,
      );
      return chatAppliedOutcome(change.semanticHash, writtenHash);
    }
    const sourceWorkspaceUri = metadataStringOrNull(
      change.metadata,
      "workspaceUri",
    );
    const targetWorkspaceId = resolveTargetWorkspace(
      sourceWorkspaceId,
      sourceWorkspaceUri,
      localWorkspaces,
      request.workspaceMappings,
    );
    if (targetWorkspaceId === null) {
      // No local counterpart, so the chat is written under the workspace ID it
      // was created with rather than dropped. Skipping it meant a conversation
      // that exists on one computer never reached the other at all, for the
      // whole class of projects that live on one machine - and the workspace ID
      // is a hash of the folder URI, so if this computer ever opens that folder
      // at the same path the chat is already where Cursor will look for it.
      // Writing a workspace ID that names nothing local is a state Cursor
      // already handles: it is what a deleted workspace folder leaves behind.
      const writtenHash = upsertChat(
        database,
        snapshot,
        sourceWorkspaceId,
        request.syncOptions.maxPayloadBytes,
      );
      return chatAppliedOutcome(change.semanticHash, writtenHash);
    }
    const writtenHash = upsertChat(
      database,
      snapshot,
      targetWorkspaceId,
      request.syncOptions.maxPayloadBytes,
    );
    return chatAppliedOutcome(change.semanticHash, writtenHash);
  }

  if (
    change.kind === "ui-state" ||
    change.kind === "cursor-user-rules" ||
    change.kind === "remote-targets"
  ) {
    const key = metadataString(change.metadata, "key");
    if (change.resourceId !== `${change.kind}/${encodeURIComponent(key)}`) {
      throw new Error(`UI state metadata does not match ${change.resourceId}.`);
    }
    if (!isSafeUiStateKey(key, change.kind)) {
      throw new FatalApplyError(`Refused unsafe UI state key: ${key}`);
    }
    // A kind this build declines to synchronize as a matter of policy, not
    // safety. Every release up to 0.0.41 published these, so repositories in
    // the field carry immutable events for them; failing the request would
    // abort the whole apply — including chat, profiles, extensions, user files
    // and the workspaceStorage restore — on every shutdown forever, because the
    // event can never be superseded. Skipped and accounted for instead, exactly
    // like an ignored key.
    if (change.kind === "ui-state" && isPolicyExcludedUiStateKey(key)) {
      return {
        status: "retained-local",
        reason:
          "window layout is kept local to each computer; the local value is kept and nothing is deleted on other devices",
      };
    }
    // "cursorSettingSync.ignoredUiStateKeys" is honored on both sides, exactly
    // like the settings, user-file and extension ignore lists. Publishing-side
    // only was worse than not honoring it at all: a peer's put overwrote the
    // layout the user declared machine-local, and a peer's tombstone deleted
    // it outright. cursor-user-rules is excluded here for the same reason the
    // scan excludes it — its key is fixed and never matched against the list.
    if (
      change.kind === "ui-state" &&
      isIgnoredUiStateKey(key, ignoredUiStateKeys)
    ) {
      return {
        status: "retained-local",
        reason:
          "UI state key is ignored on this device; remove it from cursorSettingSync.ignoredUiStateKeys to accept changes for it",
      };
    }
    const markerEntries =
      marker.entries ?? (marker.entries = readTargetMarker(database));
    let nextMarker:
      | { entries: Record<string, number>; serialized: string }
      | null = null;
    if (change.operation === "delete" && Object.hasOwn(markerEntries, key)) {
      const entries = Object.assign(
        Object.create(null) as Record<string, number>,
        markerEntries,
      );
      delete entries[key];
      nextMarker = {
        entries,
        serialized: serializeTargetStorageMarker(entries),
      };
    } else if (
      change.operation !== "delete" &&
      metadataBoolean(change.metadata, "registeredUserTarget") &&
      markerEntries[key] !== USER_STORAGE_TARGET
    ) {
      const entries = Object.assign(
        Object.create(null) as Record<string, number>,
        markerEntries,
      );
      entries[key] = USER_STORAGE_TARGET;
      nextMarker = {
        entries,
        serialized: serializeTargetStorageMarker(entries),
      };
    }
    if (change.operation === "delete") {
      database.prepare("DELETE FROM ItemTable WHERE key = ?").run(key);
    } else {
      if (content === undefined) {
        throw new Error(`UI state payload is missing: ${change.resourceId}`);
      }
      database
        .prepare(
          `INSERT INTO ItemTable(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, uiStateValue(change.metadata, content));
    }
    if (nextMarker !== null) {
      marker.entries = nextMarker.entries;
      marker.serialized = nextMarker.serialized;
      marker.dirty = true;
    }
    return { status: "applied" };
  }

  if (change.kind === "profile") {
    if (change.resourceId !== "profile/manifest") {
      throw new Error(`Unexpected profile resource: ${change.resourceId}`);
    }
    if (change.operation === "delete") {
      return { status: "skipped", reason: "profile manifest deletion ignored" };
    }
    if (content === undefined) {
      throw new Error("Profile manifest payload is missing.");
    }
    const profiles = parsePortableProfiles(content);
    const stored = mergeStoredProfiles(
      database,
      profiles,
      request.paths.profilesRoot,
    );
    const serializedProfiles = JSON.stringify(stored);
    if (stored.length > 1_000) {
      throw new Error("Updated stored profile manifest exceeds its entry limit.");
    }
    if (
      Buffer.byteLength(serializedProfiles, "utf8") >
      MAX_STORED_PROFILE_MANIFEST_BYTES
    ) {
      throw new Error("Updated stored profile manifest exceeds its byte limit.");
    }
    assertBoundedJsoncStructure(
      serializedProfiles,
      "Updated stored profile manifest",
    );
    database
      .prepare(
        `INSERT INTO ItemTable(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("userDataProfiles", serializedProfiles);
    // The merge is union-only, so a manifest with local-only profiles hashes
    // differently from the published one. The next scan reads exactly what
    // was written: recording that hash keeps the union from being republished
    // as a fresh change - which the peer merged and republished in turn, one
    // echo per apply, resurrecting every deletion forever.
    const written = stored
      .map(normalizeProfile)
      .sort((left, right) => left.id.localeCompare(right.id));
    const writtenHash = semanticHash(written as unknown as JsonValue);
    return {
      status: "applied",
      ...(writtenHash === change.semanticHash
        ? {}
        : { retainedLocalHash: writtenHash }),
    };
  }

  return { status: "ignored" };
}

/**
 * The applied outcome for a chat, carrying the written form's hash when the
 * remapped workspaceId (or any other normalization) made it differ from the
 * published bytes. The scan serializes with `canonicalBytes` and hashes those
 * bytes, so this must mirror it exactly.
 */
function chatAppliedOutcome(
  publishedHash: string,
  writtenHash: string,
): ChangeOutcome {
  return {
    status: "applied",
    ...(writtenHash === publishedHash ? {} : { retainedLocalHash: writtenHash }),
  };
}

function updatePortableAgentKvHash(
  hash: ReturnType<typeof createHash>,
  payload: PortableAgentKvPayload,
  writtenValueTypes: readonly ("text" | "blob")[],
): void {
  hash.update('{"blobs":[');
  updatePortableRowsHash(hash, payload.blobs, writtenValueTypes);
  hash.update('],"missingIds":[');
  updateCanonicalStringArrayHash(hash, payload.missingIds);
  hash.update('],"referencedIds":[');
  updateCanonicalStringArrayHash(hash, payload.referencedIds);
  hash.update("]}");
}

function updatePortableRowsHash(
  hash: ReturnType<typeof createHash>,
  rows: readonly PortableKvRow[],
  writtenValueTypes: readonly NonNullable<PortableKvRow["valueType"]>[],
): void {
  if (rows.length !== writtenValueTypes.length) {
    throw new Error("Chat write normalization does not match its rows.");
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0) {
      hash.update(",");
    }
    updatePortableRowHash(
      hash,
      rows[index]!,
      writtenValueTypes[index]!,
    );
  }
}

function updatePortableRowHash(
  hash: ReturnType<typeof createHash>,
  row: PortableKvRow,
  writtenValueType: NonNullable<PortableKvRow["valueType"]>,
): void {
  hash.update('{"key":');
  hash.update(canonicalJson(row.key));
  // Canonical Base64 contains no JSON escape characters. Stream the existing
  // string directly instead of JSON.stringify allocating an equally large one.
  hash.update(',"valueBase64":"');
  hash.update(row.valueBase64);
  hash.update('","valueType":');
  hash.update(canonicalJson(writtenValueType));
  hash.update("}");
}

function updateCanonicalStringArrayHash(
  hash: ReturnType<typeof createHash>,
  values: readonly string[],
): void {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) {
      hash.update(",");
    }
    hash.update(canonicalJson(values[index]!));
  }
}

/**
 * Applies a repository-tip enrichment without rolling a locally pruned or
 * independently growing conversation back to the repository's core rows.
 * The synthetic event exists only to carry newly recovered content-addressed
 * blobs. It never writes header/composerData/bubble rows, even when the chat is
 * wholly absent: only an authenticated enrichment with
 * `agentKvEnrichmentAppliesCore: true` reaches ordinary core apply above.
 */
function applyAgentKvEnrichment(
  database: DatabaseSync,
  request: HelperRequest,
  snapshot: PortableChatSnapshotV2,
): ChangeOutcome {
  const presence = chatRowPresence(database, snapshot.composerId);
  const hasLocalCore =
    presence.header || presence.composerData || presence.bubble;
  let localChatCoreHash: string | null = null;
  if (hasLocalCore) {
    const current = readSyntheticApplyLocalChat(
      database,
      request,
      snapshot.composerId,
      "Chat enrichment",
    );
    const sourceCoreHash = portableChatCoreHash(snapshot);
    const observedLocalCoreHash =
      current === null ? null : portableChatCoreHash(current);
    // Persisting a divergent local hash as an exact-observation shortcut would
    // hide same-count/same-timestamp core edits forever. Only an identical core
    // is safe to remember. A pruned B111 copy remains protected by its lower
    // bubble count, while an equal-count divergence is deliberately re-read
    // and republished on the next deep verification pass.
    localChatCoreHash =
      observedLocalCoreHash === sourceCoreHash ? sourceCoreHash : null;
  }
  // Blob-only enrichment never serializes a written chat snapshot. Building
  // an "effective" payload here would Base64-encode every hash-valid local
  // blob only to discard it, multiplying peak memory for large conversations.
  const result = upsertAgentKvBlobs(
    database,
    snapshot.agentKv,
    request.syncOptions.maxPayloadBytes,
  );
  return result.changed > 0
    ? { status: "applied", localChatCoreHash }
    : {
        status: "retained-local",
        reason: hasLocalCore
          ? "the local conversation core was preserved and every supplied agentKv blob was already valid"
          : "the absent conversation core was not materialized and every supplied agentKv blob was already valid",
        localChatCoreHash,
      };
}

function isAgentKvEnrichmentMetadata(
  metadata: Record<string, JsonValue> | undefined,
): boolean {
  return effectiveSyncOrigin(metadata) === "agent-kv-enrichment";
}

/**
 * Applies an automatic chat repair without rolling the live conversation back.
 *
 * The command publishes a complete synthesized snapshot so older extension
 * versions still have a safe payload, but this build treats it as a repair
 * recipe: preserve an existing live header and composerData, and write only
 * rows that composerData still references but cannot currently read. On the
 * originating device the fingerprint is rechecked after every Cursor process
 * has exited, inside the same transaction as the write. A peer may materialize
 * only a truly absent chat, or repair an existing chat with identical
 * composerData from its own fresh audit.
 */
function repairUnavailableChatBubbles(
  database: DatabaseSync,
  request: HelperRequest,
  localWorkspaces: WorkspaceIdentity[],
  source: PortableChatSnapshot,
  sourceMetadata: Record<string, JsonValue> | undefined,
  expectedFingerprint: string,
  repairOriginDeviceId: string,
  localDeviceId: string,
  publishedHash: string,
): ChangeOutcome {
  const sourceAudit = auditChatReferences(source);
  if (
    sourceAudit.status !== "known" ||
    sourceAudit.unavailableBubbleKeys.length > 0
  ) {
    throw new Error("The automatic repair payload is not a complete conversation.");
  }
  const current = readSyntheticApplyLocalChat(
    database,
    request,
    source.composerId,
    "Automatic chat repair",
  );
  if (current === null) {
    const presence = chatRowPresence(database, source.composerId);
    if (localDeviceId === repairOriginDeviceId) {
      throw new Error(
        "The originating chat disappeared before its automatic repair was applied.",
      );
    }
    if (presence.header || presence.composerData || presence.bubble) {
      throw new Error(
        "Automatic chat repair found a partial local conversation and refused to replace it.",
      );
    }
    const sourceWorkspaceId = source.header.workspaceId;
    let targetWorkspaceId: string | null = null;
    if (sourceWorkspaceId !== null) {
      targetWorkspaceId = resolveTargetWorkspace(
        sourceWorkspaceId,
        metadataStringOrNull(sourceMetadata, "workspaceUri"),
        localWorkspaces,
        request.workspaceMappings,
      ) ?? sourceWorkspaceId;
    }
    const writtenHash = upsertChat(
      database,
      source,
      targetWorkspaceId,
      request.syncOptions.maxPayloadBytes,
    );
    const materialized = readSyntheticApplyLocalChat(
      database,
      request,
      source.composerId,
      "Automatic chat repair",
    );
    if (materialized === null) {
      throw new Error("The complete repair snapshot could not be materialized.");
    }
    const materializedAudit = auditChatReferences(materialized);
    if (
      materializedAudit.status !== "known" ||
      materializedAudit.unavailableBubbleKeys.length > 0
    ) {
      throw new Error("The materialized repair snapshot is incomplete.");
    }
    return chatAppliedOutcome(publishedHash, writtenHash);
  }
  const currentAudit = auditChatReferences(current);
  if (currentAudit.status !== "known") {
    throw new Error(`Automatic chat repair is ambiguous: ${currentAudit.reason}.`);
  }
  const sourceRows = new Map(source.bubbles.map((row) => [row.key, row]));
  const currentRows = new Map(current.bubbles.map((row) => [row.key, row]));
  if (currentAudit.unavailableBubbleKeys.length === 0) {
    let addedBubbleCount = 0;
    if (
      canonicalBytes(current.composerData).equals(
        canonicalBytes(source.composerData),
      )
    ) {
      const insert = database.prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
      );
      for (const [key, row] of sourceRows) {
        if (currentRows.has(key)) {
          continue;
        }
        insert.run(key, portableKvValue(row));
        currentRows.set(key, row);
        addedBubbleCount += 1;
      }
    }
    let addedAgentKvCount = 0;
    if (isPortableChatSnapshotV2(source)) {
      const result = upsertAgentKvBlobs(
        database,
        source.agentKv,
        request.syncOptions.maxPayloadBytes,
      );
      addedAgentKvCount = result.changed;
    }
    if (addedBubbleCount > 0 || addedAgentKvCount > 0) {
      const updated = readSyntheticApplyLocalChat(
        database,
        request,
        source.composerId,
        "Automatic chat repair",
      );
      if (updated === null) {
        throw new Error("The chat disappeared while its repair was being applied.");
      }
      const sourceCoreHash = portableChatCoreHash(source);
      const localChatCoreHash =
        portableChatCoreHash(updated) === sourceCoreHash ? sourceCoreHash : null;
      return { status: "applied", localChatCoreHash };
    }
    const sourceCoreHash = portableChatCoreHash(source);
    const localChatCoreHash =
      portableChatCoreHash(current) === sourceCoreHash ? sourceCoreHash : null;
    return {
      status: "retained-local",
      reason: isPortableChatSnapshotV2(source)
        ? "the local conversation is already complete and every supplied repair row was already valid"
        : "the local conversation is already complete",
      localChatCoreHash,
    };
  }
  const isOrigin = localDeviceId === repairOriginDeviceId;
  if (isOrigin && currentAudit.fingerprint !== expectedFingerprint) {
    throw new Error(
      'The chat changed after repair was planned; open "Cursor Setting Sync: Manage", choose "Recover Chats…", then "Check and Recover Current Chats" again.',
    );
  }
  if (
    !canonicalBytes(current.composerData).equals(
      canonicalBytes(source.composerData),
    )
  ) {
    throw new Error(
      isOrigin
        ? "The live composerData no longer matches the repair plan."
        : "The peer conversation has different composerData and was left unchanged.",
    );
  }
  const insert = database.prepare(
    "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
  );
  const replace = database.prepare(
    "UPDATE cursorDiskKV SET value = ? WHERE key = ?",
  );
  for (const key of currentAudit.unavailableBubbleKeys) {
    const recovered = sourceRows.get(key);
    if (recovered === undefined) {
      throw new Error(`The repair payload does not carry referenced bubble ${key}.`);
    }
    const value = portableKvValue(recovered);
    if (currentRows.has(key)) {
      // The row exists but the fresh in-transaction audit proved it is not
      // lossless JSON. The origin additionally matches the planned
      // fingerprint; a peer must match composerData. A valid row is never
      // overwritten by this path.
      replace.run(value, key);
    } else {
      insert.run(key, value);
    }
    currentRows.set(key, recovered);
  }
  // The repair event's bubbleCount describes the trusted historical union,
  // not just the currently referenced damaged rows. Materialize every absent
  // source row additively so projection learning cannot mistake the next local
  // messages for pruning until it catches up with a larger synthetic count.
  // Existing rows, including inert/orphan rows, are never overwritten.
  for (const [key, row] of sourceRows) {
    if (currentRows.has(key)) {
      continue;
    }
    insert.run(key, portableKvValue(row));
    currentRows.set(key, row);
  }
  const repaired = readSyntheticApplyLocalChat(
    database,
    request,
    source.composerId,
    "Automatic chat repair",
  );
  if (repaired === null) {
    throw new Error("The chat disappeared while its repair was being applied.");
  }
  const repairedAudit = auditChatReferences(repaired);
  if (
    repairedAudit.status !== "known" ||
    repairedAudit.unavailableBubbleKeys.length > 0
  ) {
    throw new Error("Automatic chat repair did not satisfy every live reference.");
  }
  if (isPortableChatSnapshotV2(source)) {
    upsertAgentKvBlobs(
      database,
      source.agentKv,
      request.syncOptions.maxPayloadBytes,
    );
  }
  const sourceCoreHash = portableChatCoreHash(source);
  const localChatCoreHash =
    portableChatCoreHash(repaired) === sourceCoreHash ? sourceCoreHash : null;
  // Existing conversations are never made to pretend that their complete
  // local form byte-matches the originating device. The next scan is allowed
  // to publish any surviving local divergence on top of the repair event.
  return {
    status: "applied",
    localChatCoreHash,
  };
}

/**
 * Synthetic chat recipes inspect the live core before deciding what they may
 * add. Keep that inspection below the repair command's 64 MiB safety policy
 * and below the repository's configured one-payload policy. The bounded
 * reader performs its aggregate SQLite metadata preflight before returning
 * any bubble value; a rejected change is rolled back by the caller's per-item
 * savepoint and remains queued with this reason visible to the user.
 */
function readSyntheticApplyLocalChat(
  database: DatabaseSync,
  request: HelperRequest,
  composerId: string,
  recipe: "Automatic chat repair" | "Chat enrichment",
): PortableChatSnapshot | null {
  const limit = Math.min(
    DEFAULT_BROKEN_CHAT_INSPECTION_LIMITS.maxRetainedBytes,
    request.syncOptions.maxPayloadBytes,
  );
  const result = readPortableChatSnapshotBounded(database, composerId, limit);
  if (result.status === "known") {
    return result.snapshot;
  }
  if (result.limitReached) {
    throw new Error(
      `${recipe} deferred: the local conversation exceeds the bounded ` +
        `${limit}-byte inspection limit; no database rows were changed.`,
    );
  }
  return null;
}

function chatRowPresence(
  database: DatabaseSync,
  composerId: string,
): { header: boolean; composerData: boolean; bubble: boolean } {
  const header = database
    .prepare(
      "SELECT 1 AS present FROM composerHeaders WHERE CAST(composerId AS TEXT) = ? LIMIT 1",
    )
    .get(composerId);
  const composerData = database
    .prepare("SELECT 1 AS present FROM cursorDiskKV WHERE key = ? LIMIT 1")
    .get(`composerData:${composerId}`);
  const [lower, upper] = bubbleKeyRange(composerId);
  const bubble = database
    .prepare(
      "SELECT 1 AS present FROM cursorDiskKV WHERE key >= ? AND key < ? LIMIT 1",
    )
    .get(lower, upper);
  return {
    header: header !== undefined,
    composerData: composerData !== undefined,
    bubble: bubble !== undefined,
  };
}

/**
 * ItemTable values are TEXT in practice; binding a Buffer would store a BLOB
 * and break VS Code's strict string comparisons. Events published before
 * valueType was captured decode to TEXT only when the decode is lossless, so
 * non-UTF-8 legacy BLOBs keep their bytes. An unrecognised class must fail
 * closed rather than silently degrade to an empty or re-encoded value.
 */
function uiStateValue(
  metadata: Record<string, JsonValue> | undefined,
  content: Buffer,
): string | Buffer {
  const valueType = metadataStringOrNull(metadata, "valueType");
  if (valueType === "blob") {
    return content;
  }
  if (valueType === "text") {
    return content.toString("utf8");
  }
  if (valueType !== null) {
    throw new Error(`Unsupported UI state storage class: ${valueType}`);
  }
  return legacyStorageValue(content);
}

function upsertChat(
  database: DatabaseSync,
  snapshot: ReturnType<typeof parsePortableChatSnapshot>,
  workspaceId: string | null,
  maxAgentKvBytes: number,
): string {
  // Hash the normalized rows while they are written. This mirrors what the
  // next live scanner will observe without re-reading the database or building
  // a second whole-chat canonical buffer.
  const hash = createHash("sha256");
  hash.update("{");
  if (isPortableChatSnapshotV2(snapshot)) {
    const agentKvResult = upsertAgentKvBlobs(
      database,
      snapshot.agentKv,
      maxAgentKvBytes,
    );
    hash.update('"agentKv":');
    updatePortableAgentKvHash(
      hash,
      snapshot.agentKv,
      agentKvResult.writtenValueTypes,
    );
    hash.update(",");
  }

  const insertKv = database.prepare(
    `INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const orderedBubbles = portableRowsInDatabaseOrder(snapshot.bubbles);
  hash.update('"bubbles":[');
  for (let index = 0; index < orderedBubbles.length; index += 1) {
    const bubble = orderedBubbles[index]!;
    const write = portableKvWrite(bubble);
    insertKv.run(bubble.key, write.value);
    if (index > 0) {
      hash.update(",");
    }
    updatePortableRowHash(hash, bubble, write.valueType);
  }
  hash.update('],"composerData":');
  const composerDataWrite = portableKvWrite(snapshot.composerData);
  insertKv.run(snapshot.composerData.key, composerDataWrite.value);
  updatePortableRowHash(
    hash,
    snapshot.composerData,
    composerDataWrite.valueType,
  );
  // Bubbles present here and absent from the snapshot are LEFT ALONE.
  //
  // This used to delete them, on the rule that a message removed on the source
  // should not survive on the target. There is no such removal: Cursor gives
  // nobody a way to delete one message, and every disappearance is Cursor
  // pruning a conversation body on that computer alone. Replicating it turned
  // one machine's housekeeping into the other machine's data loss, and because
  // the emptied side then published its own empty capture, a chat pruned on
  // either computer ended up empty on BOTH - the conversation rendering up to
  // a point and then failing with "Conversation data missing". Measured on the
  // real pair: five chats holding 377 messages between them, every one of them
  // an all-or-nothing loss rather than a partial one.
  //
  // Keeping them costs storage and nothing else: `composerData`'s
  // `fullConversationHeadersOnly` decides what the conversation contains, so a
  // row it does not reference is inert - the same reason the conflict merge
  // unions bubbles instead of choosing between them.
  const header = snapshot.header;
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(composerId) DO UPDATE SET
        workspaceId = excluded.workspaceId,
        createdAt = excluded.createdAt,
        lastUpdatedAt = excluded.lastUpdatedAt,
        isArchived = excluded.isArchived,
        isSubagent = excluded.isSubagent,
        recency = excluded.recency,
        checkpointAt = excluded.checkpointAt,
        value = excluded.value`,
    )
    .run(
      header.composerId,
      workspaceId,
      header.createdAt,
      header.lastUpdatedAt,
      header.isArchived,
      header.isSubagent,
      header.recency,
      header.checkpointAt,
      header.value,
    );

  hash.update(',"composerId":');
  hash.update(canonicalJson(snapshot.composerId));
  hash.update(',"header":');
  // Use only columns actually written to composerHeaders. Incoming snapshots
  // may contain forward fields that this Cursor database cannot preserve.
  updatePortableComposerHeaderHash(hash, {
    checkpointAt: header.checkpointAt,
    composerId: header.composerId,
    createdAt: header.createdAt,
    isArchived: header.isArchived,
    isSubagent: header.isSubagent,
    lastUpdatedAt: header.lastUpdatedAt,
    recency: header.recency,
    value: header.value,
    workspaceId,
  });
  hash.update(',"schemaVersion":');
  hash.update(String(snapshot.schemaVersion));
  hash.update("}");
  return hash.digest("hex");
}

function portableRowsInDatabaseOrder(
  rows: readonly PortableKvRow[],
): readonly PortableKvRow[] {
  for (let index = 1; index < rows.length; index += 1) {
    if (compareCodeUnits(rows[index - 1]!.key, rows[index]!.key) > 0) {
      return [...rows].sort((left, right) =>
        compareCodeUnits(left.key, right.key),
      );
    }
  }
  return rows;
}

/**
 * Inserts absent content-addressed blobs and repairs rows whose bytes no
 * longer match their key. A row that already hashes to its ID is immutable:
 * even a different but equivalent SQLite TEXT/BLOB representation from the
 * incoming payload must not overwrite it.
 */
function upsertAgentKvBlobs(
  database: DatabaseSync,
  payload: PortableAgentKvPayload,
  maxIncomingBytes: number,
): { changed: number; writtenValueTypes: ("text" | "blob")[] } {
  const readMetadata = database.prepare(
    "SELECT typeof(value) AS valueType, " +
      "length(CAST(value AS BLOB)) AS valueBytes " +
      "FROM cursorDiskKV WHERE key = ?",
  );
  const readValue = database.prepare(
    "SELECT value, typeof(value) AS valueType FROM cursorDiskKV " +
      "WHERE key = ? AND typeof(value) = ? " +
      "AND length(CAST(value AS BLOB)) = ?",
  );
  const write = database.prepare(
    "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  let changed = 0;
  const writtenValueTypes: ("text" | "blob")[] = [];
  for (const incoming of payload.blobs) {
    const id = incoming.key.slice("agentKv:blob:".length);
    const incomingBytes = decodedBase64ByteLength(incoming.valueBase64);
    const validExisting = readValidExistingAgentKvBlob(
      readMetadata,
      readValue,
      incoming.key,
      id,
      Math.min(maxIncomingBytes, incomingBytes),
    );
    if (validExisting !== null) {
      writtenValueTypes.push(validExisting.valueType);
      continue;
    }
    const incomingWrite = portableKvWrite(incoming);
    if (
      incomingWrite.valueType !== "text" &&
      incomingWrite.valueType !== "blob"
    ) {
      throw new Error("agentKv blobs must use TEXT or BLOB storage.");
    }
    write.run(incoming.key, incomingWrite.value);
    writtenValueTypes.push(incomingWrite.valueType);
    changed += 1;
  }
  // `missingIds` describe bytes unavailable to the publishing device. Rows
  // already present locally stay in SQLite, but ordinary apply deliberately
  // does not read/Base64-copy them into an effective payload. The live scan's
  // bounded enrichment path owns discovering and publishing that richer form.
  return { changed, writtenValueTypes };
}

interface ValidExistingAgentKvBlob {
  valueType: "text" | "blob";
}

function readValidExistingAgentKvBlob(
  metadataStatement: ReturnType<DatabaseSync["prepare"]>,
  valueStatement: ReturnType<DatabaseSync["prepare"]>,
  key: string,
  id: string,
  maxBytes: number,
): ValidExistingAgentKvBlob | null {
  const metadata = metadataStatement.get(key) as
    | { valueType?: unknown; valueBytes?: unknown }
    | undefined;
  if (
    metadata === undefined ||
    (metadata.valueType !== "text" && metadata.valueType !== "blob") ||
    typeof metadata.valueBytes !== "number" ||
    !Number.isSafeInteger(metadata.valueBytes) ||
    metadata.valueBytes < 0 ||
    metadata.valueBytes > maxBytes
  ) {
    return null;
  }
  const row = valueStatement.get(
    key,
    metadata.valueType,
    metadata.valueBytes,
  ) as { value?: SqliteStorageValue; valueType?: unknown } | undefined;
  return validExistingAgentKvBlob(id, row);
}

function validExistingAgentKvBlob(
  id: string,
  row: { value?: SqliteStorageValue; valueType?: unknown } | undefined,
): ValidExistingAgentKvBlob | null {
  if (row === undefined) {
    return null;
  }
  let bytes: Uint8Array;
  let valueType: "text" | "blob";
  if (row.valueType === "text" && typeof row.value === "string") {
    bytes = Buffer.from(row.value, "utf8");
    valueType = "text";
  } else if (row.valueType === "blob" && row.value instanceof Uint8Array) {
    // Hash node:sqlite's returned bytes directly. Buffer.from(row.value)
    // duplicates a potentially very large blob before the hash sees it.
    bytes = row.value;
    valueType = "blob";
  } else {
    return null;
  }
  if (sha256(bytes) !== id) {
    return null;
  }
  return { valueType };
}

function decodedBase64ByteLength(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

interface PortableKvWrite {
  value: string | Buffer | null;
  valueType: NonNullable<PortableKvRow["valueType"]>;
}

function portableKvWrite(row: PortableKvRow): PortableKvWrite {
  // node:sqlite binds a JS null to SQL NULL, so a captured NULL is restored
  // exactly instead of becoming an empty string or a zero-length blob.
  if (row.valueType === "null") {
    if (row.valueBase64.length !== 0) {
      throw new Error("A NULL cursorDiskKV row cannot contain encoded bytes.");
    }
    return { value: null, valueType: "null" };
  }
  const value = Buffer.from(row.valueBase64, "base64");
  if (row.valueType === "blob") {
    return { value, valueType: "blob" };
  }
  if (row.valueType === "text") {
    const text = value.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(value)) {
      throw new Error("A TEXT cursorDiskKV row is not valid UTF-8.");
    }
    return { value: text, valueType: "text" };
  }
  // cursorDiskKV chat values are TEXT in practice; snapshots published before
  // valueType existed decode to TEXT only when the decode is lossless.
  const legacy = legacyStorageValue(value);
  return typeof legacy === "string"
    ? { value: legacy, valueType: "text" }
    : { value: legacy, valueType: "blob" };
}

function portableKvValue(row: PortableKvRow): string | Buffer | null {
  return portableKvWrite(row).value;
}

function legacyStorageValue(content: Buffer): string | Buffer {
  const text = content.toString("utf8");
  return Buffer.compare(Buffer.from(text, "utf8"), content) === 0
    ? text
    : content;
}

export function portableToStoredProfile(
  profile: PortableProfile,
  profilesRoot: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  if (!/^[a-zA-Z0-9._-]+$/.test(profile.id)) {
    throw new Error(`Invalid profile ID: ${profile.id}`);
  }
  // POSIX paths may legally contain backslashes, so only Windows separators
  // are rewritten into URI form; a POSIX absolute path is used verbatim.
  const profilePath =
    platform === "win32"
      ? win32.join(profilesRoot, profile.id).replaceAll("\\", "/")
      : posix.join(profilesRoot, profile.id);
  const uriPath = profilePath.startsWith("/") ? profilePath : `/${profilePath}`;
  const stored: Record<string, unknown> = {
    location: {
      $mid: 1,
      scheme: "file",
      path: uriPath,
    },
    name: profile.name,
  };
  if (profile.icon !== undefined) {
    stored.icon = profile.icon;
  }
  if (profile.useDefaultFlags !== undefined) {
    stored.useDefaultFlags = profile.useDefaultFlags;
  }
  return stored;
}

function mergeStoredProfiles(
  database: DatabaseSync,
  incoming: PortableProfile[],
  profilesRoot: string,
  onValueRead?: () => void,
): Array<Record<string, unknown>> {
  const metadata = inspectSqliteValue(database, "userDataProfiles");
  if (
    metadata.byteLength !== null &&
    metadata.byteLength > MAX_STORED_PROFILE_MANIFEST_BYTES
  ) {
    throw new Error(
      `Stored profile manifest is ${metadata.byteLength} bytes, above the ${MAX_STORED_PROFILE_MANIFEST_BYTES}-byte read limit.`,
    );
  }
  onValueRead?.();
  const current = parseStoredProfileArray(
    readSqliteValue(database, "userDataProfiles"),
  );
  const positions = new Map<string, number>();
  current.forEach((profile, index) => {
    const id = storedProfileId(profile);
    if (id !== null && !positions.has(id)) {
      positions.set(id, index);
    }
  });

  for (const profile of incoming) {
    const portable = portableToStoredProfile(profile, profilesRoot);
    const position = positions.get(profile.id);
    if (position === undefined) {
      positions.set(profile.id, current.length);
      current.push(portable);
      continue;
    }
    const existing = current[position] ?? {};
    const merged = { ...existing, ...portable };
    if (profile.icon === undefined) {
      delete merged.icon;
    }
    if (profile.useDefaultFlags === undefined) {
      delete merged.useDefaultFlags;
    }
    current[position] = merged;
  }
  return current;
}

function parseStoredProfileArray(
  value: SqliteStorageValue | undefined,
): Array<Record<string, unknown>> {
  // A NULL manifest reads the same as an absent one; the caller then writes a
  // real JSON array back, and the merge is additive so nothing can be lost.
  if (value === undefined || value === null) {
    return [];
  }
  const text = sqliteStorageText(value, "Stored profile manifest");
  if (text.trim().length === 0) {
    return [];
  }
  if (Buffer.byteLength(text, "utf8") > MAX_STORED_PROFILE_MANIFEST_BYTES) {
    throw new Error("Stored profile manifest exceeds its byte limit.");
  }
  assertBoundedJsoncStructure(text, "Stored profile manifest");
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 1_000) {
    throw new Error("Stored profile manifest is invalid.");
  }
  return parsed.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Stored profile manifest contains an invalid entry.");
    }
    return { ...(entry as Record<string, unknown>) };
  });
}

function storedProfileId(profile: Record<string, unknown>): string | null {
  const location = profile.location;
  const path = typeof location === "string"
    ? location
    : location !== null && typeof location === "object"
      ? (location as Record<string, unknown>).path
      : undefined;
  if (typeof path !== "string") {
    return null;
  }
  const id = basename(path.replaceAll("\\", "/"));
  return /^[a-zA-Z0-9._-]+$/.test(id) ? id : null;
}

interface MarkerState {
  entries: Record<string, number> | null;
  serialized: string | null;
  dirty: boolean;
}

function readTargetMarker(
  database: DatabaseSync,
  onValueRead?: () => void,
): Record<string, number> {
  const metadata = inspectSqliteValue(database, TARGET_STORAGE_MARKER);
  if (
    metadata.byteLength !== null &&
    metadata.byteLength > MAX_TARGET_STORAGE_MARKER_BYTES
  ) {
    throw new Error(
      `Target storage marker is ${metadata.byteLength} bytes, above the ${MAX_TARGET_STORAGE_MARKER_BYTES}-byte read limit.`,
    );
  }
  onValueRead?.();
  return parseTargetStorageMarker(readSqliteValue(database, TARGET_STORAGE_MARKER));
}

/** Narrow preflight seams; callbacks fire only immediately before body SELECT. */
export const __testing = Object.freeze({
  mergeStoredProfiles,
  readTargetMarker,
});

function assertGlobalSchema(
  database: DatabaseSync,
  schema: "main" | "restore_source" = "main",
): void {
  const expected: Record<string, string[]> = {
    ItemTable: ["key", "value"],
    cursorDiskKV: ["key", "value"],
    composerHeaders: [
      "composerId",
      "workspaceId",
      "createdAt",
      "lastUpdatedAt",
      "isArchived",
      "isSubagent",
      "recency",
      "checkpointAt",
      "value",
    ],
  };
  for (const [table, columns] of Object.entries(expected)) {
    const actual = readTableColumns(database, schema, table);
    if (!columns.every((column) => actual.includes(column))) {
      throw new Error(`Global database schema mismatch for ${table}.`);
    }
  }
}

function assertDatabaseContract(
  database: DatabaseSync,
  contract: DatabaseContract,
  schema: "main" | "restore_source" = "main",
): void {
  if (contract === "integrity") {
    return;
  }
  if (contract === "global") {
    assertGlobalSchema(database, schema);
    return;
  }
  const expected =
    contract === "store"
      ? { meta: ["key", "value"], blobs: ["id", "data"] }
      : contract === "workspace"
        ? {
            ItemTable: ["key", "value"],
            cursorDiskKV: ["key", "value"],
          }
        : { ItemTable: ["key", "value"] };
  for (const [table, columns] of Object.entries(expected)) {
    const actual = readTableColumns(database, schema, table);
    if (!columns.every((column) => actual.includes(column))) {
      throw new Error(`Database schema mismatch for ${table}.`);
    }
  }
}

function assertCheck(
  database: DatabaseSync,
  pragma: "quick_check" | "integrity_check",
  schema: "main" | "restore_source" = "main",
): void {
  const row = database.prepare(`PRAGMA ${schema}.${pragma}`).get() as
    | Record<string, unknown>
    | undefined;
  if (row?.[pragma] !== "ok") {
    throw new Error(`SQLite ${pragma} failed: ${String(row?.[pragma])}`);
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
  return typeof value === "string" ? value : null;
}

function metadataBoolean(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): boolean {
  return metadata?.[key] === true;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? typeof error;
  } catch {
    return typeof error;
  }
}

/**
 * Only the security half of the policy. A key excluded for churn reasons is
 * *safe*; it is simply not wanted, and is skipped by the caller instead of
 * aborting the transaction.
 */
function isSafeUiStateKey(
  key: string,
  kind: "ui-state" | "cursor-user-rules" | "remote-targets",
): boolean {
  if (kind === "cursor-user-rules") {
    return key === CURSOR_USER_RULES_KEY;
  }
  if (kind === "remote-targets") {
    // Pinned to the allowlist, not merely "not denied": this kind exists to
    // carry two known keys, and a peer naming a third under it is claiming a
    // write this build never intended to grant.
    return isRemoteTargetsKey(key);
  }
  return !isSecurityDeniedUiStateKey(key);
}
