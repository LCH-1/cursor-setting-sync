import type { DatabaseSync, SqliteStorageValue } from "../platform/sqlite";
import {
  backupDatabase,
  openDatabase,
  sealBackupFile,
  sqliteStorageText,
} from "../platform/sqlite";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
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
  isMissingPathError,
  pathExists,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/files";
import {
  parsePortableChatSnapshot,
  type PortableKvRow,
} from "../chat/stateVscdb";
import {
  discoverWorkspaces,
  resolveTargetWorkspace,
} from "../chat/workspace";
import {
  parsePortableProfiles,
  type PortableProfile,
} from "../resources/profiles";
import {
  isIgnoredUiStateKey,
  isPolicyExcludedUiStateKey,
  isSecurityDeniedUiStateKey,
  normalizeIgnoredUiStateKeys,
  parseTargetStorageMarker,
} from "../resources/uiStatePolicy";
import type { IgnoreMatcher } from "../resources/ignorePatterns";

export interface PreparedHelperChange {
  change: HelperChange;
  content?: Buffer;
}

export interface DatabaseApplyResult {
  backupPath: string;
  applied: string[];
  skipped: string[];
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
    await recoverRestoreJournal(path, journal, ensureCursorStillClosed);
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
    await enforceBackupRetention(request.storageRoot, { exemptPath: backupPath });
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
    database.exec("BEGIN IMMEDIATE");
    const result = applyPreparedChanges(
      database,
      request,
      prepared,
      localWorkspaces,
      heartbeat,
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
    restoreKnownTablesWithQueries(databasePath, backupPath, contract);
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
function restoreKnownTablesWithQueries(
  databasePath: string,
  backupPath: string,
  contract: DatabaseContract,
): void {
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
): Promise<void> {
  const contract = journal.contract ?? "global";
  if (!(await pathExists(journal.backupPath))) {
    validateDatabaseFile(journal.databasePath, contract);
    journal.status = "failed";
    journal.error = "Interrupted restore source is missing; the live database was left untouched.";
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
    // Deliberately outside the catch below: Cursor having reopened is not a
    // fact about this journal, so it aborts the run and leaves the journal
    // pending for the next closed-Cursor helper.
    await ensureCursorStillClosed();
    try {
      restoreKnownTablesWithQueries(
        journal.databasePath,
        journal.backupPath,
        contract,
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
): Promise<Awaited<ReturnType<typeof discoverWorkspaces>>> {
  const localWorkspaces = prepared.some((item) => item.change.kind === "chat")
    ? await discoverWorkspaces(request.paths)
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

/**
 * A violation that must abort the whole apply instead of degrading into a
 * per-change skip, because continuing would act on untrusted input.
 */
class FatalApplyError extends Error {}

type ChangeOutcome =
  | { status: "applied" }
  | { status: "ignored" }
  /**
   * The local value wins and nothing was written, but the change is still
   * accounted for so it stops being pending — the same shape the ignored
   * extension and the retained tombstone branches use in `resourceApply`.
   */
  | { status: "retained-local"; reason: string }
  | { status: "skipped"; reason: string };

function applyPreparedChanges(
  database: DatabaseSync,
  request: HelperRequest,
  prepared: PreparedHelperChange[],
  localWorkspaces: Awaited<ReturnType<typeof discoverWorkspaces>>,
  heartbeat: () => void = () => {},
): { applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  const marker: MarkerState = {
    entries: readTargetMarker(database),
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
      );
      database.exec("RELEASE cursor_sync_change");
    } catch (error) {
      database.exec("ROLLBACK TO cursor_sync_change");
      database.exec("RELEASE cursor_sync_change");
      if (error instanceof FatalApplyError) {
        throw error;
      }
      outcome = {
        status: "skipped",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (outcome.status === "applied") {
      applied.push(item.change.resourceId);
    } else if (outcome.status === "retained-local") {
      skipped.push(`${item.change.resourceId}: ${outcome.reason}`);
      applied.push(item.change.resourceId);
    } else if (outcome.status === "skipped") {
      skipped.push(`${item.change.resourceId}: ${outcome.reason}`);
    }
  }

  // Rewriting an untouched marker would replace a NULL or absent row with the
  // literal "{}" on every apply, including batches that never read UI state.
  if (marker.dirty) {
    database
      .prepare(
        `INSERT INTO ItemTable(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(TARGET_STORAGE_MARKER, JSON.stringify(marker.entries));
  }
  return { applied, skipped };
}

function applyPreparedChange(
  database: DatabaseSync,
  request: HelperRequest,
  item: PreparedHelperChange,
  localWorkspaces: Awaited<ReturnType<typeof discoverWorkspaces>>,
  marker: MarkerState,
  ignoredUiStateKeys: IgnoreMatcher,
): ChangeOutcome {
  const { change, content } = item;
  if (change.kind === "chat") {
    if (change.operation === "delete") {
      return { status: "skipped", reason: "tombstone retained without hard delete" };
    }
    if (content === undefined) {
      throw new Error(`Chat payload is missing: ${change.resourceId}`);
    }
    const snapshot = parsePortableChatSnapshot(content);
    if (change.resourceId !== `chat/${snapshot.composerId}`) {
      throw new Error(`Chat payload does not match ${change.resourceId}.`);
    }
    const sourceWorkspaceId = snapshot.header.workspaceId;
    if (sourceWorkspaceId === null) {
      // A workspace-less composer round-trips as workspace-less; there is
      // nothing to map and no local workspace it belongs to.
      upsertChat(database, snapshot, null);
      return { status: "applied" };
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
      upsertChat(database, snapshot, sourceWorkspaceId);
      return { status: "applied" };
    }
    upsertChat(database, snapshot, targetWorkspaceId);
    return { status: "applied" };
  }

  if (change.kind === "ui-state" || change.kind === "cursor-user-rules") {
    const key = metadataString(change.metadata, "key");
    if (change.resourceId !== `${change.kind}/${encodeURIComponent(key)}`) {
      throw new Error(`UI state metadata does not match ${change.resourceId}.`);
    }
    if (!isSafeUiStateKey(key, change.kind)) {
      throw new FatalApplyError(`Refused unsafe UI state key: ${key}`);
    }
    // A key this build declines to synchronize as a matter of policy, not
    // safety. Every release up to 0.0.3 published these, so repositories in the
    // field carry immutable events for them; failing the request would abort
    // the whole apply — including chat, profiles, extensions, user files and
    // the workspaceStorage restore — on every shutdown forever, because the
    // event can never be superseded. Skipped and accounted for instead, exactly
    // like an ignored key.
    if (change.kind === "ui-state" && isPolicyExcludedUiStateKey(key)) {
      return {
        status: "retained-local",
        reason:
          "UI state key is excluded from synchronization by this version; the local value is kept and nothing is deleted on other devices",
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
    if (change.operation === "delete") {
      database.prepare("DELETE FROM ItemTable WHERE key = ?").run(key);
      if (Object.hasOwn(marker.entries, key)) {
        delete marker.entries[key];
        marker.dirty = true;
      }
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
      if (
        metadataBoolean(change.metadata, "registeredUserTarget") &&
        marker.entries[key] !== USER_STORAGE_TARGET
      ) {
        marker.entries[key] = USER_STORAGE_TARGET;
        marker.dirty = true;
      }
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
    database
      .prepare(
        `INSERT INTO ItemTable(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("userDataProfiles", JSON.stringify(stored));
    return { status: "applied" };
  }

  return { status: "ignored" };
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
): void {
  const insertKv = database.prepare(
    `INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  insertKv.run(snapshot.composerData.key, portableKvValue(snapshot.composerData));
  const incomingBubbleKeys = new Set(
    snapshot.bubbles.map((bubble) => bubble.key),
  );
  for (const bubble of snapshot.bubbles) {
    insertKv.run(bubble.key, portableKvValue(bubble));
  }
  // Bubbles deleted on the source must not persist on the target. The
  // composer ID is UUID-validated, so the LIKE prefix contains no wildcards.
  const existingBubbleRows = database
    .prepare("SELECT key FROM cursorDiskKV WHERE key LIKE ?")
    .all(`bubbleId:${snapshot.composerId}:%`) as Array<{ key: string }>;
  const deleteKv = database.prepare("DELETE FROM cursorDiskKV WHERE key = ?");
  for (const row of existingBubbleRows) {
    if (!incomingBubbleKeys.has(row.key)) {
      deleteKv.run(row.key);
    }
  }
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
}

function portableKvValue(row: PortableKvRow): string | Buffer | null {
  // node:sqlite binds a JS null to SQL NULL, so a captured NULL is restored
  // exactly instead of becoming an empty string or a zero-length blob.
  if (row.valueType === "null") {
    return null;
  }
  const value = Buffer.from(row.valueBase64, "base64");
  if (row.valueType === "blob") {
    return value;
  }
  if (row.valueType === "text") {
    return value.toString("utf8");
  }
  // cursorDiskKV chat values are TEXT in practice; snapshots published before
  // valueType existed decode to TEXT only when the decode is lossless.
  return legacyStorageValue(value);
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
): Array<Record<string, unknown>> {
  const row = database
    .prepare("SELECT value FROM ItemTable WHERE key = ?")
    .get("userDataProfiles") as { value?: SqliteStorageValue } | undefined;
  const current = parseStoredProfileArray(row?.value);
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
  entries: Record<string, number>;
  dirty: boolean;
}

function readTargetMarker(database: DatabaseSync): Record<string, number> {
  const row = database
    .prepare("SELECT value FROM ItemTable WHERE key = ?")
    .get(TARGET_STORAGE_MARKER) as
    | { value?: SqliteStorageValue }
    | undefined;
  return parseTargetStorageMarker(row?.value);
}

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
  kind: "ui-state" | "cursor-user-rules",
): boolean {
  if (kind === "cursor-user-rules") {
    return key === CURSOR_USER_RULES_KEY;
  }
  return !isSecurityDeniedUiStateKey(key);
}
