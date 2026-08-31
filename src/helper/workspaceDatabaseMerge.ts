import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "../platform/sqlite";
import {
  backupDatabase,
  openDatabase,
  sealBackupFile,
} from "../platform/sqlite";
import {
  ensureDirectory,
  isCaseInsensitivePathPlatform,
  pathExists,
} from "../platform/files";
import { isCanonicalBase64Text } from "../protocol/canonical";
import {
  buffersFitJsonStructureBudget,
  PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
} from "../protocol/jsonStructure";

export const WORKSPACE_DATABASE_SNAPSHOT_FORMAT =
  "cursor-setting-sync.workspace-database" as const;
export const WORKSPACE_DATABASE_SNAPSHOT_VERSION = 1 as const;

export const WORKSPACE_DATABASE_MAX_ROWS = 16_384;

const DEFAULT_LIMITS: WorkspaceDatabaseLimits = {
  maxRows: WORKSPACE_DATABASE_MAX_ROWS,
  maxPlainBytes: 256 * 1024 * 1024,
  maxKeyBytes: 64 * 1024,
};
const MIN_SQLITE_INTEGER = -(2n ** 63n);
const MAX_SQLITE_INTEGER = 2n ** 63n - 1n;

const TABLE_DESCRIPTORS = [
  {
    name: "ItemTable",
    keyColumn: "key",
    valueColumns: ["value"],
    required: true,
  },
  {
    name: "cursorDiskKV",
    keyColumn: "key",
    valueColumns: ["value"],
    required: true,
  },
  {
    name: "composerHeaders",
    keyColumn: "composerId",
    valueColumns: [
      "workspaceId",
      "createdAt",
      "lastUpdatedAt",
      "isArchived",
      "isSubagent",
      "recency",
      "checkpointAt",
      "value",
    ],
    required: false,
  },
] as const satisfies readonly TableDescriptor[];

type KnownTableName = (typeof TABLE_DESCRIPTORS)[number]["name"];
type SqliteValue = null | string | number | bigint | Uint8Array;

interface TableDescriptor {
  name: string;
  keyColumn: string;
  valueColumns: readonly string[];
  required: boolean;
}

interface TableSchema {
  descriptor: TableDescriptor;
  extraColumns: string[];
  requiredExtraColumns: string[];
}

interface TableReadPreflight {
  descriptor: (typeof TABLE_DESCRIPTORS)[number];
  rowCount: number;
  plainBytes: bigint;
  skippedRows: bigint;
}

interface SqlByteExpression {
  sql: string;
  parameters: Array<string | bigint>;
}

interface MergeOperation {
  kind: "insert" | "update" | "delete";
  descriptor: TableDescriptor;
  key: string;
  row?: WorkspaceDatabaseRow;
}

interface MergePlan {
  operations: MergeOperation[];
  unchanged: number;
  conflicts: WorkspaceDatabaseConflict[];
}

export interface WorkspaceDatabaseLimits {
  maxRows: number;
  maxPlainBytes: number;
  maxKeyBytes: number;
}

export type PortableSqliteValue =
  | { type: "null" }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string }
  | { type: "integer"; value: string }
  | { type: "real"; value: number };

export interface WorkspaceDatabaseRow {
  key: string;
  values: PortableSqliteValue[];
}

export interface WorkspaceDatabaseTable {
  name: KnownTableName;
  keyColumn: string;
  columns: string[];
  rows: WorkspaceDatabaseRow[];
}

export interface WorkspaceDatabaseSnapshot {
  format: typeof WORKSPACE_DATABASE_SNAPSHOT_FORMAT;
  version: typeof WORKSPACE_DATABASE_SNAPSHOT_VERSION;
  workspaceId: string;
  sqliteUserVersion: number;
  tables: WorkspaceDatabaseTable[];
}

export interface CaptureWorkspaceDatabaseOptions {
  workspaceId: string;
  databaseWorkspaceId?: string;
  includeComposerHeaders?: boolean;
  limits?: Partial<WorkspaceDatabaseLimits>;
}

export interface CaptureWorkspaceDatabaseResult {
  snapshot: WorkspaceDatabaseSnapshot;
  warnings: string[];
}

export type WorkspaceDatabaseConflictReason =
  | "concurrent-update"
  | "concurrent-delete"
  | "unsafe-schema-delete";

export interface WorkspaceDatabaseConflict {
  table: KnownTableName;
  keyDigest: string;
  reason: WorkspaceDatabaseConflictReason;
}

export interface WorkspaceDatabaseSnapshotMergeResult {
  status: "merged" | "conflict";
  snapshot?: WorkspaceDatabaseSnapshot;
  conflicts: WorkspaceDatabaseConflict[];
}

export interface ApplyWorkspaceDatabaseOptions {
  targetPath: string;
  backupPath: string;
  targetWorkspaceId: string;
  incoming: WorkspaceDatabaseSnapshot;
  base?: WorkspaceDatabaseSnapshot;
  limits?: Partial<WorkspaceDatabaseLimits>;
  hooks?: {
    /** Runs after the read-only backup is verified and before any write transaction. */
    afterBackupValidated?: () => Promise<void>;
    /** Re-checks external write authority immediately before the transaction. */
    beforeDestructiveWrite?: () => Promise<void>;
  };
}

export interface ApplyWorkspaceDatabaseResult {
  backupPath: string;
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
  warnings: string[];
}

export class WorkspaceDatabaseMergeConflictError extends Error {
  readonly conflicts: readonly WorkspaceDatabaseConflict[];

  constructor(conflicts: readonly WorkspaceDatabaseConflict[]) {
    super(
      `Workspace database has ${conflicts.length} concurrent per-key conflict(s).`,
    );
    this.name = "WorkspaceDatabaseMergeConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * Reads only the explicitly supported tables and converts SQLite storage classes
 * to a deterministic, portable representation. The source connection is always
 * read-only and observes committed WAL content through SQLite itself.
 */
export function captureWorkspaceDatabaseSnapshot(
  path: string,
  options: CaptureWorkspaceDatabaseOptions,
): CaptureWorkspaceDatabaseResult {
  const limits = normalizedLimits(options.limits);
  assertWorkspaceId(options.workspaceId, "snapshot workspace ID");
  const databaseWorkspaceId =
    options.databaseWorkspaceId ?? options.workspaceId;
  assertWorkspaceId(databaseWorkspaceId, "database workspace ID");
  const database = openDatabase(path, { readOnly: true });
  let transactionOpen = false;
  try {
    database.exec("PRAGMA query_only=ON");
    database.exec("BEGIN");
    transactionOpen = true;
    assertCheck(database, "quick_check");
    const captured = captureFromOpenDatabase(
      database,
      options.workspaceId,
      databaseWorkspaceId,
      limits,
      "source",
      undefined,
      options.includeComposerHeaders === true,
    );
    database.exec("COMMIT");
    transactionOpen = false;
    return captured;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the capture failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

export function serializeWorkspaceDatabaseSnapshot(
  snapshot: WorkspaceDatabaseSnapshot,
  limits?: Partial<WorkspaceDatabaseLimits>,
): Buffer {
  assertWorkspaceSnapshotStructuralUpperBound(snapshot);
  const normalized = normalizedLimits(limits);
  const canonical = canonicalSnapshot(snapshot, normalized);
  const content = Buffer.from(JSON.stringify(canonical), "utf8");
  if (content.byteLength > normalized.maxPlainBytes) {
    throw new Error("Workspace database snapshot exceeds the payload limit.");
  }
  if (
    !buffersFitJsonStructureBudget([content], {
      maxStructuralTokens: PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
    })
  ) {
    throw new Error(
      "Workspace database snapshot exceeds the structural JSON limit.",
    );
  }
  return content;
}

export function parseWorkspaceDatabaseSnapshot(
  content: Uint8Array,
  limits?: Partial<WorkspaceDatabaseLimits>,
): WorkspaceDatabaseSnapshot {
  const normalized = normalizedLimits(limits);
  if (content.byteLength > normalized.maxPlainBytes) {
    throw new Error("Workspace database snapshot exceeds the payload limit.");
  }
  if (
    !buffersFitJsonStructureBudget([content], {
      maxStructuralTokens: PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
    })
  ) {
    throw new Error(
      "Workspace database snapshot exceeds the structural JSON limit.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("Workspace database snapshot is not valid JSON.", {
      cause: error,
    });
  }
  return canonicalSnapshot(parsed, normalized);
}

export function workspaceDatabaseSnapshotHash(
  snapshot: WorkspaceDatabaseSnapshot,
  limits?: Partial<WorkspaceDatabaseLimits>,
): string {
  return createHash("sha256")
    .update(serializeWorkspaceDatabaseSnapshot(snapshot, limits))
    .digest("hex");
}

/**
 * Performs a row-level three-way merge suitable for resolving repository DAG
 * conflicts. A row deletion is accepted only when the other side still equals
 * the base row. No conflicted snapshot is returned.
 */
export function mergeWorkspaceDatabaseSnapshots(
  base: WorkspaceDatabaseSnapshot,
  local: WorkspaceDatabaseSnapshot,
  remote: WorkspaceDatabaseSnapshot,
  limits?: Partial<WorkspaceDatabaseLimits>,
): WorkspaceDatabaseSnapshotMergeResult {
  const normalized = normalizedLimits(limits);
  const canonicalBase = canonicalSnapshot(base, normalized);
  const canonicalLocal = canonicalSnapshot(local, normalized);
  const canonicalRemote = canonicalSnapshot(remote, normalized);
  if (
    canonicalBase.workspaceId !== canonicalLocal.workspaceId ||
    canonicalBase.workspaceId !== canonicalRemote.workspaceId
  ) {
    throw new Error("Workspace database snapshots belong to different workspaces.");
  }

  const tables: WorkspaceDatabaseTable[] = [];
  const conflicts: WorkspaceDatabaseConflict[] = [];
  for (const descriptor of TABLE_DESCRIPTORS) {
    const baseTable = tableByName(canonicalBase, descriptor.name);
    const localTable = tableByName(canonicalLocal, descriptor.name);
    const remoteTable = tableByName(canonicalRemote, descriptor.name);
    if (localTable === undefined && remoteTable === undefined) {
      continue;
    }
    if (localTable === undefined || remoteTable === undefined) {
      // A snapshot that lacks the table entirely came from a Cursor whose
      // schema does not have it. That is no opinion about its rows - not a
      // deletion of every one of them, which is what the three-way walk below
      // would infer: each row equal to base on the present side would take the
      // absent side's "row", dropping the whole table from the merge.
      const present = localTable ?? remoteTable;
      const presentRows = rowsByKey(present);
      const passthrough: WorkspaceDatabaseRow[] = [];
      for (const key of [...presentRows.keys()].sort(compareText)) {
        const row = presentRows.get(key);
        if (row !== undefined) {
          passthrough.push(cloneRow(row));
        }
      }
      tables.push({
        name: descriptor.name,
        keyColumn: descriptor.keyColumn,
        columns: [...descriptor.valueColumns],
        rows: passthrough,
      });
      continue;
    }
    const baseRows = rowsByKey(baseTable);
    const localRows = rowsByKey(localTable);
    const remoteRows = rowsByKey(remoteTable);
    const mergedRows: WorkspaceDatabaseRow[] = [];
    const keys = new Set([
      ...baseRows.keys(),
      ...localRows.keys(),
      ...remoteRows.keys(),
    ]);
    for (const key of [...keys].sort(compareText)) {
      const baseRow = baseRows.get(key);
      const localRow = localRows.get(key);
      const remoteRow = remoteRows.get(key);
      let merged: WorkspaceDatabaseRow | undefined;
      if (rowsEqual(localRow, remoteRow)) {
        merged = localRow;
      } else if (rowsEqual(localRow, baseRow)) {
        merged = remoteRow;
      } else if (rowsEqual(remoteRow, baseRow)) {
        merged = localRow;
      } else {
        conflicts.push({
          table: descriptor.name,
          keyDigest: keyDigest(descriptor.name, key),
          reason:
            localRow === undefined || remoteRow === undefined
              ? "concurrent-delete"
              : "concurrent-update",
        });
      }
      if (merged !== undefined) {
        mergedRows.push(cloneRow(merged));
      }
    }
    tables.push({
      name: descriptor.name,
      keyColumn: descriptor.keyColumn,
      columns: [...descriptor.valueColumns],
      rows: mergedRows,
    });
  }

  if (conflicts.length > 0) {
    return { status: "conflict", conflicts };
  }
  return {
    status: "merged",
    snapshot: canonicalSnapshot(
      {
        format: WORKSPACE_DATABASE_SNAPSHOT_FORMAT,
        version: WORKSPACE_DATABASE_SNAPSHOT_VERSION,
        workspaceId: canonicalLocal.workspaceId,
        sqliteUserVersion: Math.max(
          canonicalLocal.sqliteUserVersion,
          canonicalRemote.sqliteUserVersion,
        ),
        tables,
      },
      normalized,
    ),
    conflicts: [],
  };
}

/**
 * Unions two snapshots of one workspace that share NO common ancestor.
 *
 * This is what two computers meeting for the first time produce: each has its
 * own state.vscdb for a workspace both of them have open (every Remote-SSH
 * project the user works from both machines), and neither snapshot descends
 * from the other, so the three-way walk above has nothing to compare against
 * and reports every differing row as a conflict. Left there, the first sync
 * between two machines raised one unresolvable manual conflict PER SHARED
 * WORKSPACE - and the manual resolver can only offer whole-snapshot
 * either/or, which discards the losing machine's rows wholesale.
 *
 * A union is strictly better than that choice: with no base there are no
 * deletions to honour, so every row either machine has is a row someone
 * wrote and nobody deleted. Only a key BOTH sides hold with different values
 * has to be decided, and it is decided by `preferred` - the caller passes the
 * replicated-newest tip, so both machines compute byte-identical output.
 */
export function unionWorkspaceDatabaseSnapshots(
  preferred: WorkspaceDatabaseSnapshot,
  other: WorkspaceDatabaseSnapshot,
  limits?: Partial<WorkspaceDatabaseLimits>,
): WorkspaceDatabaseSnapshot {
  const normalized = normalizedLimits(limits);
  const canonicalPreferred = canonicalSnapshot(preferred, normalized);
  const canonicalOther = canonicalSnapshot(other, normalized);
  if (canonicalPreferred.workspaceId !== canonicalOther.workspaceId) {
    throw new Error("Workspace database snapshots belong to different workspaces.");
  }
  const tables: WorkspaceDatabaseTable[] = [];
  for (const descriptor of TABLE_DESCRIPTORS) {
    const preferredTable = tableByName(canonicalPreferred, descriptor.name);
    const otherTable = tableByName(canonicalOther, descriptor.name);
    if (preferredTable === undefined && otherTable === undefined) {
      continue;
    }
    const merged = rowsByKey(otherTable);
    for (const [key, row] of rowsByKey(preferredTable)) {
      merged.set(key, row);
    }
    const rows: WorkspaceDatabaseRow[] = [];
    for (const key of [...merged.keys()].sort(compareText)) {
      const row = merged.get(key);
      if (row !== undefined) {
        rows.push(cloneRow(row));
      }
    }
    tables.push({
      name: descriptor.name,
      keyColumn: descriptor.keyColumn,
      columns: [...descriptor.valueColumns],
      rows,
    });
  }
  return canonicalSnapshot(
    {
      format: WORKSPACE_DATABASE_SNAPSHOT_FORMAT,
      version: WORKSPACE_DATABASE_SNAPSHOT_VERSION,
      workspaceId: canonicalPreferred.workspaceId,
      sqliteUserVersion: Math.max(
        canonicalPreferred.sqliteUserVersion,
        canonicalOther.sqliteUserVersion,
      ),
      tables,
    },
    normalized,
  );
}

/**
 * Applies a portable snapshot without replacing, renaming, or copying the live
 * database file. With no base this is an upsert-only overlay. With a base,
 * deletes and updates use a conservative three-way policy. The verified backup
 * is retained as a read-only recovery source. All checks that can invalidate
 * the write run before COMMIT; a post-COMMIT checkpoint is advisory only.
 */
export async function applyWorkspaceDatabaseSnapshot(
  options: ApplyWorkspaceDatabaseOptions,
): Promise<ApplyWorkspaceDatabaseResult> {
  const limits = normalizedLimits(options.limits);
  const incoming = canonicalSnapshot(options.incoming, limits);
  const base =
    options.base === undefined
      ? undefined
      : canonicalSnapshot(options.base, limits);
  assertWorkspaceId(options.targetWorkspaceId, "target workspace ID");
  if (base !== undefined && base.workspaceId !== incoming.workspaceId) {
    throw new Error("Base and incoming workspace database snapshots do not match.");
  }
  if (!(await pathExists(options.targetPath))) {
    throw new Error(
      "Target workspace database does not exist; refusing to create or replace it.",
    );
  }
  const targetInfo = await lstat(options.targetPath);
  if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
    throw new Error("Target workspace database must be a regular non-symlink file.");
  }
  assertDistinctPaths(options.targetPath, options.backupPath);
  if (await pathExists(options.backupPath)) {
    throw new Error(`Workspace database backup already exists: ${options.backupPath}`);
  }
  await ensureDirectory(dirname(options.backupPath));

  const preflightSchemas = new Map<KnownTableName, TableSchema>();
  const includeComposerHeaders =
    tableByName(incoming, "composerHeaders") !== undefined;
  const preflightDatabase = openDatabase(options.targetPath, { readOnly: true });
  let preflight: CaptureWorkspaceDatabaseResult;
  let preflightTransactionOpen = false;
  try {
    preflightDatabase.exec("PRAGMA query_only=ON");
    preflightDatabase.exec("BEGIN");
    preflightTransactionOpen = true;
    assertCheck(preflightDatabase, "quick_check");
    preflight = captureFromOpenDatabase(
      preflightDatabase,
      options.targetWorkspaceId,
      options.targetWorkspaceId,
      limits,
      "target",
      preflightSchemas,
      includeComposerHeaders,
    );
    preflightDatabase.exec("COMMIT");
    preflightTransactionOpen = false;
  } catch (error) {
    if (preflightTransactionOpen) {
      try {
        preflightDatabase.exec("ROLLBACK");
      } catch {
        // Preserve the preflight failure.
      }
    }
    throw error;
  } finally {
    preflightDatabase.close();
  }
  const preflightPlan = planDatabaseMerge(
    incoming,
    base,
    preflight.snapshot,
    options.targetWorkspaceId,
    preflightSchemas,
  );
  if (preflightPlan.conflicts.length > 0) {
    throw new WorkspaceDatabaseMergeConflictError(preflightPlan.conflicts);
  }
  const preflightHash = workspaceDatabaseSnapshotHash(preflight.snapshot, limits);

  const backupSource = openDatabase(options.targetPath, { readOnly: true });
  try {
    backupSource.exec("PRAGMA query_only=ON");
    await backupDatabase(backupSource, options.backupPath, { rate: 100 });
  } finally {
    backupSource.close();
  }
  await sealBackupFile(options.backupPath);
  const backupSnapshot = captureWorkspaceDatabaseSnapshot(options.backupPath, {
    workspaceId: options.targetWorkspaceId,
    includeComposerHeaders,
    limits,
  }).snapshot;
  const backupHash = workspaceDatabaseSnapshotHash(backupSnapshot, limits);
  if (backupHash !== preflightHash) {
    throw new Error(
      "Target workspace database changed while its backup was being created.",
    );
  }
  await options.hooks?.afterBackupValidated?.();
  if (!(await pathExists(options.backupPath))) {
    throw new Error(
      "Verified workspace database backup disappeared before the write transaction.",
    );
  }
  const retainedBackupHash = workspaceDatabaseSnapshotHash(
    captureWorkspaceDatabaseSnapshot(options.backupPath, {
      workspaceId: options.targetWorkspaceId,
      includeComposerHeaders,
      limits,
    }).snapshot,
    limits,
  );
  if (retainedBackupHash !== backupHash) {
    throw new Error(
      "Verified workspace database backup changed before the write transaction.",
    );
  }

  await options.hooks?.beforeDestructiveWrite?.();
  const database = openDatabase(options.targetPath);
  let transactionOpen = false;
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    assertCheck(database, "quick_check");
    const transactionSchemas = new Map<KnownTableName, TableSchema>();
    const transactionTarget = captureFromOpenDatabase(
      database,
      options.targetWorkspaceId,
      options.targetWorkspaceId,
      limits,
      "target",
      transactionSchemas,
      includeComposerHeaders,
    );
    if (
      workspaceDatabaseSnapshotHash(transactionTarget.snapshot, limits) !==
      backupHash
    ) {
      throw new Error(
        "Target workspace database changed after the verified backup was created.",
      );
    }
    const plan = planDatabaseMerge(
      incoming,
      base,
      transactionTarget.snapshot,
      options.targetWorkspaceId,
      transactionSchemas,
    );
    if (plan.conflicts.length > 0) {
      throw new WorkspaceDatabaseMergeConflictError(plan.conflicts);
    }
    executeOperations(database, plan.operations, transactionSchemas);
    assertForeignKeys(database);
    assertCheck(database, "integrity_check");
    database.exec("COMMIT");
    transactionOpen = false;
    const checkpointWarning = passiveCheckpointWarning(database);

    return {
      backupPath: options.backupPath,
      inserted: countOperations(plan.operations, "insert"),
      updated: countOperations(plan.operations, "update"),
      deleted: countOperations(plan.operations, "delete"),
      unchanged: plan.unchanged,
      warnings: [
        ...preflight.warnings,
        ...(checkpointWarning === null ? [] : [checkpointWarning]),
      ],
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // SQLite may already have closed the transaction after a fatal error.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function captureFromOpenDatabase(
  database: DatabaseSync,
  snapshotWorkspaceId: string,
  databaseWorkspaceId: string,
  limits: WorkspaceDatabaseLimits,
  role: "source" | "target",
  schemas?: Map<KnownTableName, TableSchema>,
  includeComposerHeaders = false,
): CaptureWorkspaceDatabaseResult {
  const warnings: string[] = [];
  const knownNames = new Set<string>(TABLE_DESCRIPTORS.map((item) => item.name));
  const actualNames = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
  const ignoredTables = actualNames.filter((name) => !knownNames.has(name));
  if (ignoredTables.length > 0) {
    warnings.push(
      `Ignored ${ignoredTables.length} unknown workspace database table(s).`,
    );
  }

  // Inspect every selected table before selecting a single value. In
  // particular, SQLite evaluates length()/typeof() internally for this pass,
  // so an oversized zeroblob never crosses the native/JS boundary merely to
  // discover that the portable snapshot cannot be admitted.
  const preflights: TableReadPreflight[] = [];
  let rowCount = 0n;
  let plainBytes = 0n;
  for (const descriptor of TABLE_DESCRIPTORS) {
    if (descriptor.name === "composerHeaders" && !includeComposerHeaders) {
      continue;
    }
    const exists = actualNames.includes(descriptor.name);
    if (!exists) {
      if (descriptor.required) {
        throw new Error(
          `Workspace database schema mismatch: ${descriptor.name} is missing.`,
        );
      }
      continue;
    }
    const schema = inspectTableSchema(database, descriptor, role);
    schemas?.set(descriptor.name, schema);
    if (schema.extraColumns.length > 0) {
      warnings.push(
        `Ignored ${schema.extraColumns.length} unknown column(s) in ${descriptor.name}.`,
      );
    }
    const preflight = preflightTableRows(
      database,
      descriptor,
      snapshotWorkspaceId,
      databaseWorkspaceId,
      limits,
      BigInt(limits.maxRows) - rowCount,
      BigInt(limits.maxPlainBytes) - plainBytes,
    );
    rowCount += BigInt(preflight.rowCount);
    if (rowCount > BigInt(limits.maxRows)) {
      throw new Error("Workspace database snapshot exceeds the row limit.");
    }
    plainBytes += preflight.plainBytes;
    if (plainBytes > BigInt(limits.maxPlainBytes)) {
      throw new Error("Workspace database snapshot exceeds the payload limit.");
    }
    if (preflight.skippedRows > 0n) {
      warnings.push(
        `Skipped ${preflight.skippedRows} row(s) with a non-text key in ${descriptor.name}.`,
      );
    }
    preflights.push(preflight);
  }

  assertWorkspacePreflightsStructuralUpperBound(preflights);

  const tables: WorkspaceDatabaseTable[] = [];
  for (const preflight of preflights) {
    const descriptor = preflight.descriptor;
    const rows = readTableRows(
      database,
      descriptor,
      snapshotWorkspaceId,
      databaseWorkspaceId,
      limits,
      preflight,
    );
    tables.push({
      name: descriptor.name,
      keyColumn: descriptor.keyColumn,
      columns: [...descriptor.valueColumns],
      rows,
    });
  }
  const userVersionRow = database.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return {
    snapshot: canonicalSnapshot(
      {
        format: WORKSPACE_DATABASE_SNAPSHOT_FORMAT,
        version: WORKSPACE_DATABASE_SNAPSHOT_VERSION,
        workspaceId: snapshotWorkspaceId,
        sqliteUserVersion: userVersionRow?.user_version ?? 0,
        tables,
      },
      limits,
    ),
    warnings,
  };
}

function assertWorkspacePreflightsStructuralUpperBound(
  preflights: readonly TableReadPreflight[],
): void {
  let tokens = 14;
  for (const preflight of preflights) {
    tokens = checkedStructuralAdd(
      tokens,
      workspaceTableStructuralUpperBound(
        preflight.descriptor.valueColumns.length,
        preflight.rowCount,
      ),
    );
  }
  if (tokens > PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS) {
    throw new Error(
      "Workspace database snapshot exceeds the structural JSON limit.",
    );
  }
}

function assertWorkspaceSnapshotStructuralUpperBound(
  snapshot: WorkspaceDatabaseSnapshot,
): void {
  if (!Array.isArray(snapshot.tables)) {
    return;
  }
  let tokens = 14;
  for (const table of snapshot.tables) {
    const descriptor = descriptorFor(table.name);
    if (descriptor === undefined || !Array.isArray(table.rows)) {
      continue;
    }
    tokens = checkedStructuralAdd(
      tokens,
      workspaceTableStructuralUpperBound(
        descriptor.valueColumns.length,
        table.rows.length,
      ),
    );
  }
  if (tokens > PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS) {
    throw new Error(
      "Workspace database snapshot exceeds the structural JSON limit.",
    );
  }
}

function workspaceTableStructuralUpperBound(
  valueColumns: number,
  rows: number,
): number {
  if (!Number.isSafeInteger(rows) || rows < 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  // Table/object/column punctuation is 13 + valueColumns. Each row needs at
  // most 7 + 6 * valueColumns tokens including its array separator and the
  // two-field representation of every portable SQLite value.
  const rowTokens = 7 + 6 * valueColumns;
  const total = 13 + valueColumns + rows * rowTokens;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}

function checkedStructuralAdd(left: number, right: number): number {
  const total = left + right;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}

/**
 * Computes the exact portable row/count budget using SQLite metadata only.
 * The first query deliberately avoids touching value columns at all so a row
 * limit rejects cheaply. The second asks SQLite for storage lengths, not
 * values, and therefore remains bounded even for very large blobs.
 */
function preflightTableRows(
  database: DatabaseSync,
  descriptor: (typeof TABLE_DESCRIPTORS)[number],
  snapshotWorkspaceId: string,
  databaseWorkspaceId: string,
  limits: WorkspaceDatabaseLimits,
  remainingRows: bigint,
  remainingPlainBytes: bigint,
): TableReadPreflight {
  const key = quoteIdentifier(descriptor.keyColumn);
  const keyBytes = `length(CAST(${key} AS BLOB))`;
  const countStatement = database.prepare(
    `SELECT
      COUNT(*) AS total_rows,
      COALESCE(SUM(CASE WHEN typeof(${key}) = 'text' THEN 1 ELSE 0 END), 0) AS usable_rows,
      MIN(CASE WHEN typeof(${key}) = 'text' THEN ${keyBytes} ELSE NULL END) AS min_key_bytes,
      MAX(CASE WHEN typeof(${key}) = 'text' THEN ${keyBytes} ELSE NULL END) AS max_key_bytes
    FROM ${quoteIdentifier(descriptor.name)}`,
  );
  countStatement.setReadBigInts(true);
  const counts = countStatement.get() as
    | {
        total_rows?: unknown;
        usable_rows?: unknown;
        min_key_bytes?: unknown;
        max_key_bytes?: unknown;
      }
    | undefined;
  const totalRows = sqliteNonNegativeInteger(
    counts?.total_rows,
    `${descriptor.name} row count`,
  );
  const usableRows = sqliteNonNegativeInteger(
    counts?.usable_rows,
    `${descriptor.name} usable row count`,
  );
  const minKeyBytes = sqliteNullableNonNegativeInteger(
    counts?.min_key_bytes,
    `${descriptor.name} minimum key length`,
  );
  const maxKeyBytes = sqliteNullableNonNegativeInteger(
    counts?.max_key_bytes,
    `${descriptor.name} maximum key length`,
  );
  if (usableRows > remainingRows) {
    throw new Error("Workspace database snapshot exceeds the row limit.");
  }
  if (
    usableRows > 0n &&
    (minKeyBytes === null ||
      maxKeyBytes === null ||
      minKeyBytes === 0n ||
      maxKeyBytes > BigInt(limits.maxKeyBytes))
  ) {
    throw new Error(`Workspace database key length is invalid in ${descriptor.name}.`);
  }

  const byteExpression = portableRowByteExpression(
    descriptor,
    snapshotWorkspaceId,
    databaseWorkspaceId,
  );
  const byteStatement = database.prepare(
    `SELECT COALESCE(SUM(${byteExpression.sql}), 0) AS plain_bytes
     FROM ${quoteIdentifier(descriptor.name)}
     WHERE typeof(${key}) = 'text'`,
  );
  byteStatement.setReadBigInts(true);
  let byteRow: { plain_bytes?: unknown } | undefined;
  try {
    byteRow = byteStatement.get(...byteExpression.parameters);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("integer overflow")
    ) {
      throw new Error("Workspace database snapshot exceeds the payload limit.", {
        cause: error,
      });
    }
    throw error;
  }
  const plainBytes = sqliteNonNegativeInteger(
    byteRow?.plain_bytes,
    `${descriptor.name} portable byte count`,
  );
  if (plainBytes > remainingPlainBytes) {
    throw new Error("Workspace database snapshot exceeds the payload limit.");
  }
  if (usableRows > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Workspace database snapshot exceeds the row limit.");
  }
  return {
    descriptor,
    rowCount: Number(usableRows),
    plainBytes,
    skippedRows: totalRows - usableRows,
  };
}

function portableRowByteExpression(
  descriptor: TableDescriptor,
  snapshotWorkspaceId: string,
  databaseWorkspaceId: string,
): SqlByteExpression {
  const parameters: Array<string | bigint> = [];
  const byteExpressions = [
    `length(CAST(${quoteIdentifier(descriptor.keyColumn)} AS BLOB))`,
    ...descriptor.valueColumns.map((column) => {
      const quoted = quoteIdentifier(column);
      if (descriptor.name === "composerHeaders" && column === "workspaceId") {
        parameters.push(
          databaseWorkspaceId,
          BigInt(Buffer.byteLength(snapshotWorkspaceId, "utf8")),
        );
        return `CASE
          WHEN typeof(${quoted}) = 'text' AND ${quoted} = ? THEN ?
          ${portableSqliteValueByteCases(quoted)}
        END`;
      }
      return `CASE ${portableSqliteValueByteCases(quoted)} END`;
    }),
  ];
  return {
    sql: byteExpressions.map((expression) => `(${expression})`).join(" + "),
    parameters,
  };
}

function portableSqliteValueByteCases(quotedColumn: string): string {
  return `WHEN typeof(${quotedColumn}) = 'null' THEN 0
          WHEN typeof(${quotedColumn}) = 'text' THEN length(CAST(${quotedColumn} AS BLOB))
          WHEN typeof(${quotedColumn}) = 'blob' THEN length(${quotedColumn})
          WHEN typeof(${quotedColumn}) = 'integer' THEN length(CAST(${quotedColumn} AS BLOB))
          WHEN typeof(${quotedColumn}) = 'real' THEN 8
          ELSE 0`;
}

function sqliteNullableNonNegativeInteger(
  value: unknown,
  label: string,
): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  return sqliteNonNegativeInteger(value, label);
}

function sqliteNonNegativeInteger(value: unknown, label: string): bigint {
  const integer =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : null;
  if (integer === null || integer < 0n) {
    throw new Error(`Workspace database returned an invalid ${label}.`);
  }
  return integer;
}

function inspectTableSchema(
  database: DatabaseSync,
  descriptor: TableDescriptor,
  role: "source" | "target",
): TableSchema {
  const columns = database
    .prepare(`PRAGMA table_info(${quoteIdentifier(descriptor.name)})`)
    .all() as Array<{
    name?: unknown;
    notnull?: unknown;
    dflt_value?: unknown;
    pk?: unknown;
  }>;
  const byName = new Map(columns.map((row) => [String(row.name), row]));
  for (const required of [descriptor.keyColumn, ...descriptor.valueColumns]) {
    if (!byName.has(required)) {
      throw new Error(
        `Workspace database schema mismatch: ${descriptor.name}.${required} is missing.`,
      );
    }
  }
  if (!hasUniqueKey(database, descriptor, byName.get(descriptor.keyColumn))) {
    throw new Error(
      `Workspace database schema mismatch: ${descriptor.name}.${descriptor.keyColumn} is not unique.`,
    );
  }
  if (role === "target") {
    const triggers = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? LIMIT 1",
      )
      .all(descriptor.name);
    if (triggers.length > 0) {
      throw new Error(
        `Workspace database table ${descriptor.name} has unsupported triggers.`,
      );
    }
  }
  const knownColumns = new Set([
    descriptor.keyColumn,
    ...descriptor.valueColumns,
  ]);
  const extra = columns.filter((row) => !knownColumns.has(String(row.name)));
  return {
    descriptor,
    extraColumns: extra.map((row) => String(row.name)),
    requiredExtraColumns: extra
      .filter(
        (row) =>
          Number(row.notnull) === 1 &&
          row.dflt_value === null &&
          Number(row.pk) === 0,
      )
      .map((row) => String(row.name)),
  };
}

function hasUniqueKey(
  database: DatabaseSync,
  descriptor: TableDescriptor,
  keyColumn: { pk?: unknown } | undefined,
): boolean {
  if (Number(keyColumn?.pk) > 0) {
    return true;
  }
  const indexes = database
    .prepare(`PRAGMA index_list(${quoteIdentifier(descriptor.name)})`)
    .all() as Array<{ name?: unknown; unique?: unknown }>;
  return indexes.some((index) => {
    if (Number(index.unique) !== 1 || typeof index.name !== "string") {
      return false;
    }
    // An expression index reports a NULL column name; narrowing keeps it from
    // being compared as the literal string "null".
    const indexedColumns = database
      .prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`)
      .all()
      .map((row) => (typeof row.name === "string" ? row.name : null));
    return (
      indexedColumns.length === 1 &&
      indexedColumns[0] === descriptor.keyColumn
    );
  });
}

function readTableRows(
  database: DatabaseSync,
  descriptor: TableDescriptor,
  snapshotWorkspaceId: string,
  databaseWorkspaceId: string,
  limits: WorkspaceDatabaseLimits,
  preflight: TableReadPreflight,
): WorkspaceDatabaseRow[] {
  const columns = [descriptor.keyColumn, ...descriptor.valueColumns];
  const projection = columns.flatMap((column, index) => [
    `${quoteIdentifier(column)} AS ${quoteIdentifier(`value_${index}`)}`,
    `typeof(${quoteIdentifier(column)}) AS ${quoteIdentifier(`type_${index}`)}`,
  ]);
  const key = quoteIdentifier(descriptor.keyColumn);
  const byteExpression = portableRowByteExpression(
    descriptor,
    snapshotWorkspaceId,
    databaseWorkspaceId,
  );
  const statement = database.prepare(
    `SELECT ${projection.join(", ")}
     FROM ${quoteIdentifier(descriptor.name)}
     WHERE typeof(${key}) = 'text'
       AND length(CAST(${key} AS BLOB)) BETWEEN 1 AND ${limits.maxKeyBytes}
       AND (${byteExpression.sql}) <= ${limits.maxPlainBytes}
     LIMIT ${preflight.rowCount + 1}`,
  );
  statement.setReadBigInts(true);
  const rows: WorkspaceDatabaseRow[] = [];
  const seen = new Set<string>();
  let plainBytes = 0n;
  for (const raw of statement.iterate(...byteExpression.parameters)) {
    const keyValue = toPortableValue(
      raw.value_0 as SqliteValue,
      raw.type_0,
      `${descriptor.name}.${descriptor.keyColumn}`,
    );
    if (keyValue.type !== "text") {
      throw new Error(`Workspace database changed while reading ${descriptor.name}.`);
    }
    if (seen.has(keyValue.value)) {
      throw new Error(`Workspace database contains a duplicate key in ${descriptor.name}.`);
    }
    seen.add(keyValue.value);
    const values = descriptor.valueColumns.map((column, valueIndex) => {
      const index = valueIndex + 1;
      const portable = toPortableValue(
        raw[`value_${index}`] as SqliteValue,
        raw[`type_${index}`],
        `${descriptor.name}.${column}`,
      );
      if (
        descriptor.name === "composerHeaders" &&
        column === "workspaceId" &&
        portable.type === "text" &&
        portable.value === databaseWorkspaceId
      ) {
        return { type: "text", value: snapshotWorkspaceId } as const;
      }
      return portable;
    });
    plainBytes += BigInt(Buffer.byteLength(keyValue.value, "utf8"));
    for (const value of values) {
      plainBytes += BigInt(portableValueBytes(value));
    }
    if (
      rows.length >= preflight.rowCount ||
      plainBytes > preflight.plainBytes ||
      plainBytes > BigInt(limits.maxPlainBytes)
    ) {
      throw new Error(`Workspace database changed while reading ${descriptor.name}.`);
    }
    rows.push({ key: keyValue.value, values });
  }
  if (
    rows.length !== preflight.rowCount ||
    plainBytes !== preflight.plainBytes
  ) {
    throw new Error(`Workspace database changed while reading ${descriptor.name}.`);
  }
  return rows.sort((left, right) => compareText(left.key, right.key));
}

function toPortableValue(
  value: SqliteValue,
  sqliteType: unknown,
  label: string,
): PortableSqliteValue {
  if (sqliteType === "null" && value === null) {
    return { type: "null" };
  }
  if (sqliteType === "text" && typeof value === "string") {
    return { type: "text", value };
  }
  if (sqliteType === "blob" && value instanceof Uint8Array) {
    return { type: "blob", base64: Buffer.from(value).toString("base64") };
  }
  if (
    sqliteType === "integer" &&
    (typeof value === "bigint" ||
      (typeof value === "number" && Number.isSafeInteger(value)))
  ) {
    return { type: "integer", value: BigInt(value).toString() };
  }
  if (sqliteType === "real" && typeof value === "number" && Number.isFinite(value)) {
    return { type: "real", value: Object.is(value, -0) ? 0 : value };
  }
  throw new Error(`Unsupported SQLite value in ${label}: ${String(sqliteType)}.`);
}

function canonicalSnapshot(
  value: unknown,
  limits: WorkspaceDatabaseLimits,
): WorkspaceDatabaseSnapshot {
  if (!isRecord(value)) {
    throw new Error("Workspace database snapshot must be an object.");
  }
  if (value.format !== WORKSPACE_DATABASE_SNAPSHOT_FORMAT) {
    throw new Error("Unsupported workspace database snapshot format.");
  }
  if (value.version !== WORKSPACE_DATABASE_SNAPSHOT_VERSION) {
    throw new Error("Unsupported workspace database snapshot version.");
  }
  if (typeof value.workspaceId !== "string") {
    throw new Error("Workspace database snapshot is missing workspaceId.");
  }
  assertWorkspaceId(value.workspaceId, "snapshot workspace ID");
  if (
    typeof value.sqliteUserVersion !== "number" ||
    !Number.isSafeInteger(value.sqliteUserVersion) ||
    value.sqliteUserVersion < 0 ||
    value.sqliteUserVersion > 0x7fff_ffff
  ) {
    throw new Error("Workspace database snapshot has an invalid user_version.");
  }
  if (!Array.isArray(value.tables)) {
    throw new Error("Workspace database snapshot is missing tables.");
  }

  const tableMap = new Map<KnownTableName, WorkspaceDatabaseTable>();
  let rows = 0;
  let plainBytes = 0;
  for (const rawTable of value.tables) {
    if (!isRecord(rawTable) || typeof rawTable.name !== "string") {
      throw new Error("Workspace database snapshot contains an invalid table.");
    }
    const descriptor = descriptorFor(rawTable.name);
    if (descriptor === undefined) {
      throw new Error(`Unsupported workspace database table: ${rawTable.name}.`);
    }
    if (tableMap.has(descriptor.name)) {
      throw new Error(`Duplicate workspace database table: ${descriptor.name}.`);
    }
    if (rawTable.keyColumn !== descriptor.keyColumn) {
      throw new Error(`Workspace database key contract changed for ${descriptor.name}.`);
    }
    if (
      !Array.isArray(rawTable.columns) ||
      rawTable.columns.length !== descriptor.valueColumns.length ||
      !rawTable.columns.every(
        (column, index) => column === descriptor.valueColumns[index],
      )
    ) {
      throw new Error(`Workspace database column contract changed for ${descriptor.name}.`);
    }
    if (!Array.isArray(rawTable.rows)) {
      throw new Error(`Workspace database rows are invalid for ${descriptor.name}.`);
    }
    const tableRows: WorkspaceDatabaseRow[] = [];
    const keys = new Set<string>();
    for (const rawRow of rawTable.rows) {
      if (
        !isRecord(rawRow) ||
        typeof rawRow.key !== "string" ||
        !Array.isArray(rawRow.values) ||
        rawRow.values.length !== descriptor.valueColumns.length
      ) {
        throw new Error(`Workspace database row is invalid for ${descriptor.name}.`);
      }
      const keyBytes = Buffer.byteLength(rawRow.key, "utf8");
      if (keyBytes === 0 || keyBytes > limits.maxKeyBytes) {
        throw new Error(`Workspace database key length is invalid in ${descriptor.name}.`);
      }
      if (keys.has(rawRow.key)) {
        throw new Error(`Duplicate workspace database key in ${descriptor.name}.`);
      }
      keys.add(rawRow.key);
      const values = rawRow.values.map((item) => canonicalPortableValue(item));
      rows += 1;
      plainBytes += keyBytes + values.reduce(
        (total, item) => total + portableValueBytes(item),
        0,
      );
      if (rows > limits.maxRows || plainBytes > limits.maxPlainBytes) {
        throw new Error("Workspace database snapshot exceeds configured limits.");
      }
      tableRows.push({ key: rawRow.key, values });
    }
    tableMap.set(descriptor.name, {
      name: descriptor.name,
      keyColumn: descriptor.keyColumn,
      columns: [...descriptor.valueColumns],
      rows: tableRows.sort((left, right) => compareText(left.key, right.key)),
    });
  }
  for (const descriptor of TABLE_DESCRIPTORS) {
    if (descriptor.required && !tableMap.has(descriptor.name)) {
      throw new Error(`Workspace database snapshot is missing ${descriptor.name}.`);
    }
  }
  return {
    format: WORKSPACE_DATABASE_SNAPSHOT_FORMAT,
    version: WORKSPACE_DATABASE_SNAPSHOT_VERSION,
    workspaceId: value.workspaceId,
    sqliteUserVersion: value.sqliteUserVersion,
    tables: TABLE_DESCRIPTORS.flatMap((descriptor) => {
      const table = tableMap.get(descriptor.name);
      return table === undefined ? [] : [table];
    }),
  };
}

function canonicalPortableValue(value: unknown): PortableSqliteValue {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Workspace database snapshot contains an invalid SQLite value.");
  }
  if (value.type === "null") {
    return { type: "null" };
  }
  if (value.type === "text" && typeof value.value === "string") {
    return { type: "text", value: value.value };
  }
  if (value.type === "blob" && typeof value.base64 === "string") {
    if (!isCanonicalBase64(value.base64)) {
      throw new Error("Workspace database snapshot contains invalid base64.");
    }
    return { type: "blob", base64: value.base64 };
  }
  if (value.type === "integer" && typeof value.value === "string") {
    if (!/^-?(0|[1-9][0-9]*)$/.test(value.value)) {
      throw new Error("Workspace database snapshot contains an invalid integer.");
    }
    const integer = BigInt(value.value);
    if (integer < MIN_SQLITE_INTEGER || integer > MAX_SQLITE_INTEGER) {
      throw new Error("Workspace database snapshot integer is outside SQLite range.");
    }
    return { type: "integer", value: integer.toString() };
  }
  if (
    value.type === "real" &&
    typeof value.value === "number" &&
    Number.isFinite(value.value)
  ) {
    return { type: "real", value: Object.is(value.value, -0) ? 0 : value.value };
  }
  throw new Error("Workspace database snapshot contains an invalid SQLite value.");
}

function planDatabaseMerge(
  incomingSnapshot: WorkspaceDatabaseSnapshot,
  baseSnapshot: WorkspaceDatabaseSnapshot | undefined,
  targetSnapshot: WorkspaceDatabaseSnapshot,
  targetWorkspaceId: string,
  targetSchemas: ReadonlyMap<KnownTableName, TableSchema>,
): MergePlan {
  const incoming = mapSnapshotWorkspaceId(incomingSnapshot, targetWorkspaceId);
  const base =
    baseSnapshot === undefined
      ? undefined
      : mapSnapshotWorkspaceId(baseSnapshot, targetWorkspaceId);
  const operations: MergeOperation[] = [];
  const conflicts: WorkspaceDatabaseConflict[] = [];
  let unchanged = 0;
  for (const descriptor of TABLE_DESCRIPTORS) {
    const incomingTable = tableByName(incoming, descriptor.name);
    if (incomingTable === undefined) {
      continue;
    }
    const targetTable = tableByName(targetSnapshot, descriptor.name);
    if (targetTable === undefined) {
      if (incomingTable.rows.length === 0) {
        continue;
      }
      throw new Error(
        `Target workspace database does not support ${descriptor.name}.`,
      );
    }
    const schema = targetSchemas.get(descriptor.name);
    if (schema === undefined) {
      throw new Error(`Target workspace database schema was not inspected: ${descriptor.name}.`);
    }
    const incomingRows = rowsByKey(incomingTable);
    const targetRows = rowsByKey(targetTable);
    const baseRows = rowsByKey(tableByName(base, descriptor.name));

    for (const [key, incomingRow] of incomingRows) {
      const targetRow = targetRows.get(key);
      if (base === undefined) {
        if (targetRow === undefined) {
          ensureInsertSupported(schema);
          operations.push({ kind: "insert", descriptor, key, row: incomingRow });
        } else if (rowsEqual(targetRow, incomingRow)) {
          unchanged += 1;
        } else {
          operations.push({ kind: "update", descriptor, key, row: incomingRow });
        }
        continue;
      }

      const baseRow = baseRows.get(key);
      if (baseRow === undefined) {
        if (targetRow === undefined) {
          ensureInsertSupported(schema);
          operations.push({ kind: "insert", descriptor, key, row: incomingRow });
        } else if (rowsEqual(targetRow, incomingRow)) {
          unchanged += 1;
        } else {
          conflicts.push(conflict(descriptor, key, "concurrent-update"));
        }
      } else if (rowsEqual(baseRow, incomingRow)) {
        unchanged += 1;
      } else if (targetRow === undefined) {
        conflicts.push(conflict(descriptor, key, "concurrent-delete"));
      } else if (rowsEqual(targetRow, incomingRow)) {
        unchanged += 1;
      } else if (rowsEqual(targetRow, baseRow)) {
        operations.push({ kind: "update", descriptor, key, row: incomingRow });
      } else {
        conflicts.push(conflict(descriptor, key, "concurrent-update"));
      }
    }

    if (base !== undefined) {
      for (const [key, baseRow] of baseRows) {
        if (incomingRows.has(key)) {
          continue;
        }
        const targetRow = targetRows.get(key);
        if (targetRow === undefined) {
          unchanged += 1;
        } else if (!rowsEqual(targetRow, baseRow)) {
          conflicts.push(conflict(descriptor, key, "concurrent-delete"));
        } else if (schema.extraColumns.length > 0) {
          conflicts.push(conflict(descriptor, key, "unsafe-schema-delete"));
        } else {
          operations.push({ kind: "delete", descriptor, key });
        }
      }
    }
  }
  return { operations, unchanged, conflicts };
}

function executeOperations(
  database: DatabaseSync,
  operations: readonly MergeOperation[],
  schemas: ReadonlyMap<KnownTableName, TableSchema>,
): void {
  for (const operation of operations) {
    const descriptor = operation.descriptor;
    const schema = schemas.get(descriptor.name as KnownTableName);
    if (schema === undefined) {
      throw new Error(`Missing target schema for ${descriptor.name}.`);
    }
    if (operation.kind === "delete") {
      if (schema.extraColumns.length > 0) {
        throw new Error(`Refused unsafe delete from drifted table ${descriptor.name}.`);
      }
      database
        .prepare(
          `DELETE FROM ${quoteIdentifier(descriptor.name)} WHERE ${quoteIdentifier(descriptor.keyColumn)} = ?`,
        )
        .run(operation.key);
      continue;
    }
    if (operation.row === undefined) {
      throw new Error(`Workspace database ${operation.kind} is missing a row.`);
    }
    const boundValues = operation.row.values.map(fromPortableValue);
    if (operation.kind === "insert") {
      ensureInsertSupported(schema);
      const columns = [descriptor.keyColumn, ...descriptor.valueColumns];
      database
        .prepare(
          `INSERT INTO ${quoteIdentifier(descriptor.name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(operation.key, ...boundValues);
      continue;
    }
    const result = database
      .prepare(
        `UPDATE ${quoteIdentifier(descriptor.name)} SET ${descriptor.valueColumns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ")} WHERE ${quoteIdentifier(descriptor.keyColumn)} = ?`,
      )
      .run(...boundValues, operation.key);
    if (result.changes !== 1) {
      throw new Error(
        `Workspace database row changed during apply: ${descriptor.name}.`,
      );
    }
  }
}

function mapSnapshotWorkspaceId(
  snapshot: WorkspaceDatabaseSnapshot,
  targetWorkspaceId: string,
): WorkspaceDatabaseSnapshot {
  if (snapshot.workspaceId === targetWorkspaceId) {
    return snapshot;
  }
  return {
    ...snapshot,
    workspaceId: targetWorkspaceId,
    tables: snapshot.tables.map((table) => {
      if (table.name !== "composerHeaders") {
        return table;
      }
      const workspaceIndex = table.columns.indexOf("workspaceId");
      return {
        ...table,
        rows: table.rows.map((row) => ({
          key: row.key,
          values: row.values.map((value, index) =>
            index === workspaceIndex &&
            value?.type === "text" &&
            value.value === snapshot.workspaceId
              ? { type: "text", value: targetWorkspaceId }
              : value,
          ),
        })),
      };
    }),
  };
}

function tableByName(
  snapshot: WorkspaceDatabaseSnapshot | undefined,
  name: string,
): WorkspaceDatabaseTable | undefined {
  return snapshot?.tables.find((table) => table.name === name);
}

function rowsByKey(
  table: WorkspaceDatabaseTable | undefined,
): Map<string, WorkspaceDatabaseRow> {
  return new Map(table?.rows.map((row) => [row.key, row]) ?? []);
}

function rowsEqual(
  left: WorkspaceDatabaseRow | undefined,
  right: WorkspaceDatabaseRow | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.key === right.key &&
    left.values.length === right.values.length &&
    left.values.every((value, index) =>
      portableValuesEqual(value, right.values[index]),
    )
  );
}

function portableValuesEqual(
  left: PortableSqliteValue,
  right: PortableSqliteValue | undefined,
): boolean {
  if (right === undefined || left.type !== right.type) {
    return false;
  }
  if (left.type === "null" && right.type === "null") {
    return true;
  }
  if (left.type === "blob" && right.type === "blob") {
    return left.base64 === right.base64;
  }
  if (left.type === "text" && right.type === "text") {
    return left.value === right.value;
  }
  if (left.type === "integer" && right.type === "integer") {
    return left.value === right.value;
  }
  return left.type === "real" && right.type === "real" && left.value === right.value;
}

function cloneRow(row: WorkspaceDatabaseRow): WorkspaceDatabaseRow {
  return {
    key: row.key,
    values: row.values.map((value) => ({ ...value })),
  };
}

function fromPortableValue(value: PortableSqliteValue): SqliteValue {
  if (value.type === "null") {
    return null;
  }
  if (value.type === "text" || value.type === "real") {
    return value.value;
  }
  if (value.type === "integer") {
    return BigInt(value.value);
  }
  return Buffer.from(value.base64, "base64");
}

function portableValueBytes(value: PortableSqliteValue): number {
  if (value.type === "null") {
    return 0;
  }
  if (value.type === "blob") {
    if (value.base64.length === 0) {
      return 0;
    }
    const padding = value.base64.endsWith("==")
      ? 2
      : value.base64.endsWith("=")
        ? 1
        : 0;
    return (value.base64.length / 4) * 3 - padding;
  }
  if (value.type === "real") {
    return 8;
  }
  return Buffer.byteLength(value.value, "utf8");
}

function ensureInsertSupported(schema: TableSchema): void {
  if (schema.requiredExtraColumns.length > 0) {
    throw new Error(
      `Cannot insert into ${schema.descriptor.name}; unknown required columns are present.`,
    );
  }
}

function conflict(
  descriptor: TableDescriptor,
  key: string,
  reason: WorkspaceDatabaseConflictReason,
): WorkspaceDatabaseConflict {
  return {
    table: descriptor.name as KnownTableName,
    keyDigest: keyDigest(descriptor.name, key),
    reason,
  };
}

function keyDigest(table: string, key: string): string {
  return createHash("sha256").update(table).update("\0").update(key).digest("hex");
}

function countOperations(
  operations: readonly MergeOperation[],
  kind: MergeOperation["kind"],
): number {
  return operations.filter((operation) => operation.kind === kind).length;
}

function descriptorFor(name: string): (typeof TABLE_DESCRIPTORS)[number] | undefined {
  return TABLE_DESCRIPTORS.find((descriptor) => descriptor.name === name);
}

function normalizedLimits(
  limits: Partial<WorkspaceDatabaseLimits> | undefined,
): WorkspaceDatabaseLimits {
  const normalized = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Workspace database limit ${name} must be a positive integer.`);
    }
  }
  return normalized;
}

function assertWorkspaceId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

export function assertDistinctPaths(
  targetPath: string,
  backupPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const comparisonPath = (path: string): string =>
    isCaseInsensitivePathPlatform(platform)
      ? resolve(path).toLowerCase()
      : resolve(path);
  if (comparisonPath(targetPath) === comparisonPath(backupPath)) {
    throw new Error("Workspace database backup path must differ from the live database.");
  }
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (!isCanonicalBase64Text(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertCheck(
  database: DatabaseSync,
  pragma: "quick_check" | "integrity_check",
): void {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (row?.[pragma] !== "ok") {
    throw new Error(`SQLite ${pragma} failed: ${String(row?.[pragma])}`);
  }
}

function assertForeignKeys(database: DatabaseSync): void {
  if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("SQLite foreign_key_check failed after workspace database merge.");
  }
}

function passiveCheckpointWarning(database: DatabaseSync): string | null {
  try {
    const row = database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as
      | { busy?: number | bigint }
      | undefined;
    return Number(row?.busy) === 0
      ? null
      : "Workspace database WAL checkpoint is busy; committed changes were retained.";
  } catch (error) {
    return `Workspace database WAL checkpoint was deferred: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
