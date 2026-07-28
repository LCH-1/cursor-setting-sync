import { createRequire } from "node:module";
import { rm, stat } from "node:fs/promises";
import type {
  DatabaseSync as NodeDatabaseSync,
  backup as nodeBackup,
} from "node:sqlite";

type SqliteModule = {
  DatabaseSync: typeof NodeDatabaseSync;
  backup?: typeof nodeBackup;
};

let cached: SqliteModule | null | undefined;

export type DatabaseSync = NodeDatabaseSync;

/** Every storage class node:sqlite can hand back for a column value. */
export type SqliteStorageValue = Uint8Array | string | number | bigint | null;

/**
 * Decodes a TEXT or BLOB column that is expected to hold text. INTEGER and
 * REAL have no faithful text form for these payloads, so they are rejected
 * instead of coerced; SQL NULL is the caller's decision and never reaches here.
 */
export function sqliteStorageText(
  value: Exclude<SqliteStorageValue, null>,
  label: string,
): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  throw new Error(
    `${label} has an unsupported SQLite storage class: ${typeof value}.`,
  );
}

export function openDatabase(
  ...arguments_: ConstructorParameters<typeof NodeDatabaseSync>
): NodeDatabaseSync {
  const module = loadSqlite();
  if (module === null) {
    throw new Error("This Cursor runtime does not provide node:sqlite.");
  }
  return new module.DatabaseSync(...arguments_);
}

export const backupDatabase: typeof nodeBackup = async (...arguments_) => {
  const backup = loadSqlite()?.backup;
  if (backup === undefined) {
    throw new Error("This Cursor runtime does not provide node:sqlite backup.");
  }
  return backup(...arguments_);
};

/**
 * Turns a freshly written backup into a single self-contained file.
 *
 * `backup()` gives the destination the journal mode of its source, so a backup
 * of a live Cursor database is itself in WAL mode. Every later read-only open
 * of it - the post-backup validation, a restore's ATTACH - then recreates
 * `-wal` and `-shm` beside it and cannot remove them again on close, because a
 * read-only connection may not run the closing checkpoint. Those sidecars
 * outlived the backups they belonged to and, being written last, were the
 * newest files in the directory, so retention kept them and evicted real
 * snapshots to stay inside its budget.
 *
 * A snapshot has no concurrent readers to coordinate with and no use for a
 * write-ahead log, so it is stored in rollback-journal mode instead.
 *
 * Housekeeping only. The backup is already written by the time this runs and
 * is valid either way, so a failure here must never abort an apply.
 */
export async function sealBackupFile(path: string): Promise<void> {
  try {
    const database = openDatabase(path);
    try {
      // Checkpoints the log into the file and unlinks both sidecars.
      database.exec("PRAGMA journal_mode=DELETE");
    } finally {
      database.close();
    }
  } catch {
    return;
  }
  await removeSpentSidecar(`${path}-wal`);
  await removeSpentSidecar(`${path}-shm`);
}

async function removeSpentSidecar(path: string): Promise<void> {
  try {
    // The mode change already removed these; anything still here is a
    // leftover the filesystem would not let SQLite unlink. A log with content
    // is left alone rather than guessed about.
    if (path.endsWith("-shm") || (await stat(path)).size === 0) {
      await rm(path, { force: true });
    }
  } catch {
    // Missing is the expected case.
  }
}

export function inspectSqliteCapabilities(): {
  database: boolean;
  backup: boolean;
} {
  const module = loadSqlite();
  return {
    database: module !== null && typeof module.DatabaseSync === "function",
    backup: module !== null && typeof module.backup === "function",
  };
}

function loadSqlite(): SqliteModule | null {
  if (cached !== undefined) {
    return cached;
  }
  try {
    const requireFromHere = createRequire(__filename);
    const moduleName = ["node", "sqlite"].join(":");
    cached = requireFromHere(moduleName) as SqliteModule;
  } catch {
    cached = null;
  }
  return cached;
}
