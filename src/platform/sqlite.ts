import { createRequire } from "node:module";
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
