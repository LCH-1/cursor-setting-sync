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
