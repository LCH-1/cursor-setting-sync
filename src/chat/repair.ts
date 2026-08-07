import type { DatabaseSync, SqliteStorageValue } from "../platform/sqlite";
import { openDatabase } from "../platform/sqlite";
import type { CursorPaths } from "../platform/paths";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import {
  bubbleKeyRange,
  isSyncableComposerId,
  parsePortableChatSnapshot,
  type PortableChatSnapshot,
  type PortableComposerHeader,
  type PortableKvRow,
} from "./stateVscdb";
import { chatHeaderTitle } from "./title";

interface RawComposerHeader {
  composerId: SqliteStorageValue;
  workspaceId: SqliteStorageValue;
  createdAt: SqliteStorageValue;
  lastUpdatedAt: SqliteStorageValue;
  isArchived: SqliteStorageValue;
  isSubagent: SqliteStorageValue;
  recency: SqliteStorageValue;
  checkpointAt: SqliteStorageValue;
  value: SqliteStorageValue;
}

interface RawKvRow {
  key: SqliteStorageValue;
  value: SqliteStorageValue;
  valueType: SqliteStorageValue;
}

export interface BrokenChatObservation {
  resourceId: string;
  composerId: string;
  title: string | null;
  workspaceId: string | null;
  lastUpdatedAt: number | null;
  referencedBubbleCount: number;
  unavailableBubbleKeys: string[];
  fingerprint: string;
  snapshot: PortableChatSnapshot;
}

export interface BrokenChatInspection {
  examinedChats: number;
  broken: BrokenChatObservation[];
}

export type ChatReferenceAudit =
  | {
      status: "known";
      referencedBubbleKeys: string[];
      unavailableBubbleKeys: string[];
      fingerprint: string;
    }
  | { status: "unknown"; reason: string };

export interface ChatRepairCandidate {
  versionId: string;
  snapshot: PortableChatSnapshot;
}

export type ChatRepairBuildResult =
  | {
      status: "repairable";
      snapshot: PortableChatSnapshot;
      sourceVersionId: string;
      repairedBubbleCount: number;
    }
  | { status: "unavailable"; reason: string };

/**
 * Finds only the strong form of local chat damage: composerData still names a
 * message, but its bubble row is absent or no longer valid JSON. A body-less
 * header is deliberately ignored because Cursor routinely keeps one after
 * pruning an old chat.
 *
 * This is command-only work. It walks each composer's indexed key range with
 * memory bounded to that conversation, then materializes full snapshots only
 * for the few that fail; it must never join the background poll on a large DB.
 */
export async function inspectBrokenCursorChats(
  paths: CursorPaths,
): Promise<BrokenChatInspection> {
  const database = openDatabase(paths.globalDatabase, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=2000");
    database.exec("PRAGMA query_only=ON");
    return inspectBrokenChatsInDatabase(database);
  } finally {
    database.close();
  }
}

export function inspectBrokenChatsInDatabase(
  database: DatabaseSync,
): BrokenChatInspection {
  database.exec("BEGIN");
  try {
    const broken: BrokenChatObservation[] = [];
    let examinedChats = 0;
    const composerStatement = database.prepare(
      `SELECT h.composerId AS composerId,
              d.key AS key, d.value AS value, typeof(d.value) AS valueType
         FROM composerHeaders h
         JOIN cursorDiskKV d
           ON d.key = 'composerData:' || CAST(h.composerId AS TEXT)
        WHERE COALESCE(h.isSubagent, 0) = 0
        ORDER BY CAST(h.composerId AS TEXT)`,
    );
    const bubbleStatement = database.prepare(
      `SELECT key, value, typeof(value) AS valueType
         FROM cursorDiskKV
        WHERE key >= ? AND key < ?
        ORDER BY key`,
    );
    for (const row of composerStatement.iterate() as Iterable<
      RawKvRow & { composerId: SqliteStorageValue }
    >) {
      // One malformed composer must not hide every repairable conversation.
      // This command exists for a damaged database, so per-chat isolation is a
      // correctness property rather than merely defensive logging.
      try {
        const composerId = sqliteText(row.composerId);
        if (composerId === null || !isSyncableComposerId(composerId)) {
          continue;
        }
        const composerData = portableRow(row);
        const references = referencedBubbleKeys(composerId, composerData);
        if (references === null) {
          continue;
        }
        examinedChats += 1;
        if (
          unavailableReferencesInDatabase(
            bubbleStatement,
            composerId,
            references,
          ).length === 0
        ) {
          continue;
        }
        const snapshot = readPortableChatSnapshot(database, composerId);
        if (snapshot === null) {
          continue;
        }
        const audit = auditChatReferences(snapshot);
        if (
          audit.status !== "known" ||
          audit.unavailableBubbleKeys.length === 0
        ) {
          continue;
        }
        broken.push({
          resourceId: `chat/${composerId}`,
          composerId,
          title: chatHeaderTitle(snapshot.header.value),
          workspaceId: snapshot.header.workspaceId,
          lastUpdatedAt: snapshot.header.lastUpdatedAt,
          referencedBubbleCount: audit.referencedBubbleKeys.length,
          unavailableBubbleKeys: audit.unavailableBubbleKeys,
          fingerprint: audit.fingerprint,
          snapshot,
        });
      } catch {
        // The other composer rows remain independently auditable. Unsupported
        // storage classes cannot be represented in a portable repair payload,
        // so guessing a replacement here would be less safe than skipping it.
      }
    }
    database.exec("COMMIT");
    return {
      examinedChats,
      broken: broken.sort((left, right) =>
        right.unavailableBubbleKeys.length - left.unavailableBubbleKeys.length ||
        compareText(left.resourceId, right.resourceId)
      ),
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Checks one composer's referenced rows with bounded memory.
 *
 * The previous implementation retained every bubble key in the global DB in a
 * JavaScript Set. Besides scaling with the whole multi-GiB database, a key-only
 * pass treated an existing but invalid JSON row as healthy. Walking one indexed
 * composer range at a time bounds peak state to that conversation's reference
 * list and validates only rows Cursor says belong to the conversation.
 */
function unavailableReferencesInDatabase(
  statement: ReturnType<DatabaseSync["prepare"]>,
  composerId: string,
  references: readonly string[],
): string[] {
  const referenced = new Set(references);
  const unavailable = new Set(references);
  const [lower, upper] = bubbleKeyRange(composerId);
  for (const row of statement.iterate(lower, upper) as Iterable<RawKvRow>) {
    if (typeof row.key !== "string" || !referenced.has(row.key)) {
      continue;
    }
    try {
      if (isUsableBubble(portableRow(row))) {
        unavailable.delete(row.key);
      }
    } catch {
      // An unsupported value class is unavailable too. The later portable
      // snapshot read may decline to repair it, but it must not be called
      // healthy merely because the key exists.
    }
  }
  return references.filter((key) => unavailable.has(key));
}

/** Reads one complete local chat inside the caller's SQLite transaction. */
export function readPortableChatSnapshot(
  database: DatabaseSync,
  composerId: string,
): PortableChatSnapshot | null {
  if (!isSyncableComposerId(composerId)) {
    return null;
  }
  const rawHeader = database
    .prepare(
      `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
              isSubagent, recency, checkpointAt, value
         FROM composerHeaders
        WHERE CAST(composerId AS TEXT) = ? AND COALESCE(isSubagent, 0) = 0`,
    )
    .get(composerId) as RawComposerHeader | undefined;
  if (rawHeader === undefined) {
    return null;
  }
  const rawData = database
    .prepare(
      "SELECT key, value, typeof(value) AS valueType FROM cursorDiskKV WHERE key = ?",
    )
    .get(`composerData:${composerId}`) as RawKvRow | undefined;
  if (rawData === undefined) {
    return null;
  }
  const [lower, upper] = bubbleKeyRange(composerId);
  const bubbles = database
    .prepare(
      "SELECT key, value, typeof(value) AS valueType FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key",
    )
    .all(lower, upper) as unknown as RawKvRow[];
  const snapshot: PortableChatSnapshot = {
    schemaVersion: 1,
    composerId,
    header: portableHeader(rawHeader, composerId),
    composerData: portableRow(rawData),
    bubbles: bubbles.map(portableRow),
  };
  // Reuse the same structural gate every inbound chat passes.
  return parsePortableChatSnapshot(canonicalBytes(snapshot));
}

/**
 * Audits the references Cursor treats as the conversation contents. Orphaned
 * bubble rows are intentionally irrelevant; only a referenced missing or
 * unreadable row makes a conversation unavailable.
 */
export function auditChatReferences(
  snapshot: PortableChatSnapshot,
): ChatReferenceAudit {
  const references = referencedBubbleKeys(
    snapshot.composerId,
    snapshot.composerData,
  );
  if (references === null) {
    return {
      status: "unknown",
      reason: "composerData does not expose a recognized conversation header list",
    };
  }
  const rows = new Map(snapshot.bubbles.map((row) => [row.key, row]));
  const unavailable = references.filter((key) => {
    const row = rows.get(key);
    return row === undefined || !isUsableBubble(row);
  });
  return {
    status: "known",
    referencedBubbleKeys: references,
    unavailableBubbleKeys: unavailable,
    fingerprint: referenceFingerprint(snapshot, references, rows),
  };
}

/**
 * Recovers unavailable rows from one newest trusted version that contains all
 * of them. The current header, composerData and every usable local bubble win;
 * no whole historical conversation is selected and no local row is removed.
 */
export function buildChatRepairSnapshot(
  local: PortableChatSnapshot,
  candidates: readonly ChatRepairCandidate[],
): ChatRepairBuildResult {
  const localAudit = auditChatReferences(local);
  if (localAudit.status !== "known") {
    return { status: "unavailable", reason: localAudit.reason };
  }
  if (localAudit.unavailableBubbleKeys.length === 0) {
    return { status: "unavailable", reason: "the conversation is already complete" };
  }
  const unavailable = new Set(localAudit.unavailableBubbleKeys);
  let selectedIndex = -1;
  let selectedRows: Map<string, PortableKvRow> | null = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined || candidate.snapshot.composerId !== local.composerId) {
      continue;
    }
    const rows = new Map(candidate.snapshot.bubbles.map((row) => [row.key, row]));
    if ([...unavailable].every((key) => {
      const row = rows.get(key);
      return row !== undefined && isUsableBubble(row);
    })) {
      selectedIndex = index;
      selectedRows = rows;
      break;
    }
  }
  const selected = candidates[selectedIndex];
  if (selected === undefined || selectedRows === null) {
    return {
      status: "unavailable",
      reason: "no trusted stored version contains every unavailable message",
    };
  }
  // A newer partial version may carry a later value for a message while not
  // carrying every missing message. Refuse to mix an older value over it.
  for (let index = 0; index < selectedIndex; index += 1) {
    const newer = candidates[index];
    if (newer === undefined || newer.snapshot.composerId !== local.composerId) {
      continue;
    }
    const rows = new Map(newer.snapshot.bubbles.map((row) => [row.key, row]));
    for (const key of unavailable) {
      const newerRow = rows.get(key);
      const selectedRow = selectedRows.get(key);
      if (
        newerRow !== undefined &&
        selectedRow !== undefined &&
        isUsableBubble(newerRow) &&
        portableRowIdentity(newerRow) !== portableRowIdentity(selectedRow)
      ) {
        return {
          status: "unavailable",
          reason: "trusted versions disagree about an unavailable message",
        };
      }
    }
  }
  // The published repair is a new canonical child, not merely a local helper
  // recipe. It must therefore retain every row carried by the chosen complete
  // source and every newer trusted version; otherwise a row that is inert under
  // THIS device's composerData disappears from checkpoints and can never be
  // materialized on a new peer whose composerData does reference it.
  //
  // Candidates arrive newest first. Keep the newest usable trusted value for a
  // collision, falling back to an older usable value when the newest copy is
  // unreadable. A usable live row wins over every stored row, while an unusable
  // live row only survives when history has no usable replacement.
  const repairedRows = new Map<string, PortableKvRow>();
  for (let index = 0; index <= selectedIndex; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined || candidate.snapshot.composerId !== local.composerId) {
      continue;
    }
    for (const row of candidate.snapshot.bubbles) {
      const existing = repairedRows.get(row.key);
      if (
        existing === undefined ||
        (!isUsableBubble(existing) && isUsableBubble(row))
      ) {
        repairedRows.set(row.key, row);
      }
    }
  }
  for (const row of local.bubbles) {
    if (isUsableBubble(row) || !repairedRows.has(row.key)) {
      repairedRows.set(row.key, row);
    }
  }
  for (const key of unavailable) {
    const row = repairedRows.get(key);
    if (row === undefined || !isUsableBubble(row)) {
      return { status: "unavailable", reason: "a recovery row disappeared" };
    }
  }
  const snapshot = parsePortableChatSnapshot(
    canonicalBytes({
      ...local,
      bubbles: [...repairedRows.values()].sort((left, right) =>
        compareText(left.key, right.key)
      ),
    }),
  );
  const repairedAudit = auditChatReferences(snapshot);
  if (
    repairedAudit.status !== "known" ||
    repairedAudit.unavailableBubbleKeys.length > 0
  ) {
    return {
      status: "unavailable",
      reason: "the synthesized conversation still has unavailable messages",
    };
  }
  return {
    status: "repairable",
    snapshot,
    sourceVersionId: selected.versionId,
    repairedBubbleCount: unavailable.size,
  };
}

export function isAutomaticChatRepairMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.syncOrigin === "automatic-chat-repair";
}

function referencedBubbleKeys(
  composerId: string,
  composerData: PortableKvRow,
): string[] | null {
  const value = parseJsonRow(composerData);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const headers = (value as Record<string, unknown>).fullConversationHeadersOnly;
  if (!Array.isArray(headers) || headers.length > 250_000) {
    return null;
  }
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of headers) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const bubbleId = (item as Record<string, unknown>).bubbleId;
    if (typeof bubbleId !== "string" || bubbleId.length === 0 || seen.has(bubbleId)) {
      return null;
    }
    seen.add(bubbleId);
    keys.push(`bubbleId:${composerId}:${bubbleId}`);
  }
  return keys;
}

function referenceFingerprint(
  snapshot: PortableChatSnapshot,
  references: readonly string[],
  rows: ReadonlyMap<string, PortableKvRow>,
): string {
  return sha256(
    canonicalBytes({
      composerId: snapshot.composerId,
      composerData: snapshot.composerData,
      references: references.map((key) => {
        const row = rows.get(key);
        return row === undefined
          ? { key, state: "missing" }
          : isUsableBubble(row)
            ? { key, state: "usable", rowHash: sha256(canonicalBytes(row)) }
            : { key, state: "unreadable", rowHash: sha256(canonicalBytes(row)) };
      }),
    }),
  );
}

function isUsableBubble(row: PortableKvRow): boolean {
  return parseJsonRow(row) !== undefined;
}

/** null is valid JSON; undefined means the row is not lossless JSON. */
function parseJsonRow(row: PortableKvRow): unknown {
  if (row.valueType === "null") {
    return undefined;
  }
  const bytes = Buffer.from(row.valueBase64, "base64");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function portableRowIdentity(row: PortableKvRow): string {
  const effectiveType = row.valueType ??
    (losslessUtf8(Buffer.from(row.valueBase64, "base64")) ? "text" : "blob");
  return `${effectiveType}:${row.valueBase64}`;
}

function portableHeader(
  row: RawComposerHeader,
  composerId: string,
): PortableComposerHeader {
  return {
    composerId,
    workspaceId: nullableText(row.workspaceId, "workspaceId"),
    createdAt: nullableNumber(row.createdAt, "createdAt"),
    lastUpdatedAt: nullableNumber(row.lastUpdatedAt, "lastUpdatedAt"),
    isArchived: nullableNumber(row.isArchived, "isArchived"),
    isSubagent: nullableNumber(row.isSubagent, "isSubagent"),
    recency: nullableNumber(row.recency, "recency"),
    checkpointAt: nullableNumber(row.checkpointAt, "checkpointAt"),
    value: nullableText(row.value, "value"),
  };
}

function portableRow(row: RawKvRow): PortableKvRow {
  if (typeof row.key !== "string") {
    throw new Error("A cursorDiskKV key is not text.");
  }
  if (row.valueType === "null" && row.value === null) {
    return { key: row.key, valueBase64: "", valueType: "null" };
  }
  if (row.valueType === "text" && typeof row.value === "string") {
    return {
      key: row.key,
      valueBase64: Buffer.from(row.value, "utf8").toString("base64"),
      valueType: "text",
    };
  }
  if (row.valueType === "blob" && row.value instanceof Uint8Array) {
    return {
      key: row.key,
      valueBase64: Buffer.from(row.value).toString("base64"),
      valueType: "blob",
    };
  }
  throw new Error(
    `cursorDiskKV key ${row.key} has an unsupported SQLite storage class.`,
  );
}

function sqliteText(value: SqliteStorageValue): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    const text = bytes.toString("utf8");
    return Buffer.from(text, "utf8").equals(bytes) ? text : null;
  }
  return null;
}

function nullableText(value: SqliteStorageValue, column: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`composerHeaders.${column} is not text.`);
  }
  return value;
}

function nullableNumber(value: SqliteStorageValue, column: string): number | null {
  if (value === null) {
    return null;
  }
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new Error(`composerHeaders.${column} is not numeric.`);
  }
  return number;
}

function losslessUtf8(bytes: Buffer): boolean {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
