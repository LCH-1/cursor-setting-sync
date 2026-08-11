import { stat } from "node:fs/promises";
import type { DatabaseSync, SqliteStorageValue } from "../platform/sqlite";
import { isMissingPathError } from "../platform/files";
import { sha256 } from "../protocol/canonical";
import type { OversizedSnapshotSettlement } from "./resource";

/** Fixed extension-host envelope for ordinary (non-chat) resources. */
export const GENERAL_MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
export const GENERAL_MAX_RETAINED_BYTES_PER_SCAN = 8 * 1024 * 1024;
export const GENERAL_MAX_RESOURCES_PER_SCAN = 32;
/** Persistent protection samples stay fixed even for very large file trees. */
export const GENERAL_MAX_OVERSIZED_SETTLEMENTS = 64;

export interface GeneralOversizedObservation
  extends OversizedSnapshotSettlement {
  identity: string;
  fixedWorkLimit: boolean;
}

export interface SqliteValueMetadata {
  present: boolean;
  storageClass: string | null;
  byteLength: number | null;
}

export class OversizedSqliteValueError extends Error {
  constructor(
    readonly key: string,
    readonly byteLength: number,
    readonly maxBytes: number,
  ) {
    super(
      `SQLite value ${key} is ${byteLength} bytes, above the ${maxBytes}-byte read limit.`,
    );
    this.name = "OversizedSqliteValueError";
  }
}

export function generalResourceLimit(maxPayloadBytes: number): number {
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    throw new Error("Resource payload limit must be a positive integer.");
  }
  return Math.min(maxPayloadBytes, GENERAL_MAX_RESOURCE_BYTES);
}

export function generalOversizedObservation(
  resourceId: string,
  identity: string,
  byteLength: number,
  maxPayloadBytes: number,
): GeneralOversizedObservation {
  const limit = generalResourceLimit(maxPayloadBytes);
  return {
    resourceId,
    semanticHash: sha256(`oversized:${resourceId}:${identity}:${byteLength}`),
    byteLength,
    maxPayloadBytes: limit,
    identity,
    fixedWorkLimit: limit < maxPayloadBytes,
  };
}

export function generalOversizedWarning(
  label: string,
  observation: GeneralOversizedObservation,
): string {
  const reason = observation.fixedWorkLimit
    ? `the fixed ${formatBytes(observation.maxPayloadBytes)} automatic-capture work limit`
    : `the configured ${formatBytes(observation.maxPayloadBytes)} payload limit`;
  return `${label} ${observation.resourceId} is ${formatBytes(
    observation.byteLength,
  )}, above ${reason}. It remains local and protected from incoming replacement; smaller resources continue synchronizing.`;
}

/**
 * Retains a bounded exact-ID protection sample. `false` means the caller must
 * keep the whole adapter kind incomplete until a new full generation proves
 * that every oversized resource can be represented again.
 */
export function rememberGeneralOversizedObservation(
  observations: Map<string, GeneralOversizedObservation>,
  observation: GeneralOversizedObservation,
): boolean {
  if (observations.has(observation.resourceId)) {
    observations.set(observation.resourceId, observation);
    return true;
  }
  if (observations.size >= GENERAL_MAX_OVERSIZED_SETTLEMENTS) {
    return false;
  }
  observations.set(observation.resourceId, observation);
  return true;
}

/**
 * Reads only SQLite metadata. `length(CAST(... AS BLOB))` never hands the value
 * to JavaScript, so a huge BLOB/TEXT row can be rejected before node:sqlite
 * allocates it.
 */
export function inspectSqliteValue(
  database: DatabaseSync,
  key: string,
): SqliteValueMetadata {
  const row = database
    .prepare(
      "SELECT typeof(value) AS storageClass, length(CAST(value AS BLOB)) AS byteLength FROM ItemTable WHERE key = ? LIMIT 1",
    )
    .get(key) as
    | { storageClass?: unknown; byteLength?: unknown }
    | undefined;
  if (row === undefined) {
    return { present: false, storageClass: null, byteLength: null };
  }
  const storageClass =
    typeof row.storageClass === "string" ? row.storageClass : null;
  const byteLength =
    typeof row.byteLength === "number" &&
    Number.isSafeInteger(row.byteLength) &&
    row.byteLength >= 0
      ? row.byteLength
      : null;
  return { present: true, storageClass, byteLength };
}

export function readSqliteValue(
  database: DatabaseSync,
  key: string,
): SqliteStorageValue | undefined {
  const row = database
    .prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1")
    .get(key) as { value?: SqliteStorageValue } | undefined;
  return row?.value;
}

/** Main/WAL identity suitable for idle memoization and source timestamps. */
export async function sqliteDatabaseTimestamp(
  databasePath: string,
): Promise<number | null> {
  const main = await mtimeOrNull(databasePath);
  if (main === null) {
    return null;
  }
  const wal = await mtimeOrNull(`${databasePath}-wal`);
  return wal === null ? main : Math.max(main, wal);
}

async function mtimeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
