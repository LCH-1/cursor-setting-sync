import { openDatabase } from "../platform/sqlite";
import type { DatabaseSync, SqliteStorageValue } from "../platform/sqlite";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import {
  auditChatContinuationRoots,
  auditChatReferences,
  readPortableChatSnapshotBounded,
  type ChatContinuationRootProbeResult,
} from "./repair";
import {
  isSyncableComposerId,
  portableChatCoreHash,
  type PortableChatSnapshot,
  type PortableKvRow,
} from "./stateVscdb";

const DEFAULT_SNAPSHOT_BYTE_LIMIT = 64 * 1024 * 1024;
const DEFAULT_MAX_SUCCESSOR_CANDIDATES = 32;

interface RawAgentKvProbeRow {
  key: SqliteStorageValue;
  value: SqliteStorageValue;
  valueType: SqliteStorageValue;
  valueBytes: SqliteStorageValue;
}

interface RawSuccessorCandidate {
  composerId: SqliteStorageValue;
}

export interface ChatRecoveryProbeOptions {
  snapshotByteLimit?: number;
}

export interface ChatRecoverySuccessorOptions extends ChatRecoveryProbeOptions {
  createdAfter: number;
  expectedUserTextHashes?: readonly string[];
  maxCandidates?: number;
}

export interface RecoveryRoleProbe {
  referencedUser: number;
  referencedAssistant: number;
  recoverableUserRecords: number;
  recoverableAssistantRecords: number;
  toolUseCount: number;
  validToolUseCount: number;
  rawToolNameCounts: Record<string, number>;
  skippedEmptyAssistantRows: number;
  unrecoverableUserRows: number;
  unsupportedRoleRows: number;
  unreadableRows: number;
}

export interface RecoveryMarkerProbe {
  timerOrTimepicker: boolean;
  timerOrTimepickerHits: number;
  hieungIeung: boolean;
  hieungIeungHits: number;
}

export interface RecoveryTailProbe {
  referenceIndex: number;
  recoverable: boolean;
  hasText: boolean;
  hasToolUse: boolean;
}

export interface ChatRecoveryProbe {
  composerId: string;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  workspaceFingerprint: string;
  headerFingerprint: string;
  composerDataFingerprint: string;
  referenceFingerprint: string;
  coreFingerprint: string;
  probeFingerprint: string;
  visible: {
    referencedCount: number;
    presentReferencedCount: number;
    unavailableReferencedCount: number;
    storedBubbleCount: number;
  };
  roles: RecoveryRoleProbe;
  markers: RecoveryMarkerProbe;
  tail: {
    lastUser: RecoveryTailProbe | null;
    lastAssistant: RecoveryTailProbe | null;
    assistantFollowsLastUser: boolean;
  };
  agentKv:
    | {
        status: "known";
        conversationStateCount: number;
        referencedCount: number;
        foundCount: number;
        unavailableCount: number;
        probedCount: number;
        complete: boolean;
        fingerprint: string;
      }
    | {
        status: "unknown";
        conversationStateCount: number;
        referencedCount: number;
        probedCount: number;
        reason: string;
      };
}

export interface ChatRecoverySuccessorProbe {
  originalComposerId: string;
  createdAfter: number;
  candidateCount: number;
  candidateLimitReached: boolean;
  matchingCandidateCount: number;
  identifiedComposerId: string | null;
  successor: ChatRecoveryProbe | null;
}

interface CapturedRecoveryProbe {
  probe: ChatRecoveryProbe;
  /** Kept in process only for unambiguous successor selection; never output. */
  userTextHashes: string[];
}

/**
 * Produces a content-free fingerprint of one live chat. The SQLite connection
 * is read-only and query_only, and all related rows are observed in one read
 * transaction so a concurrent Cursor append cannot create a mixed snapshot.
 */
export async function captureChatRecoveryProbe(
  databasePath: string,
  composerId: string,
  options: ChatRecoveryProbeOptions = {},
): Promise<ChatRecoveryProbe> {
  assertComposerId(composerId);
  const snapshotByteLimit = normalizePositiveLimit(
    "snapshotByteLimit",
    options.snapshotByteLimit ?? DEFAULT_SNAPSHOT_BYTE_LIMIT,
  );
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    enableReadOnlyTransaction(database);
    try {
      const captured = await captureInTransaction(
        database,
        composerId,
        snapshotByteLimit,
      );
      database.exec("COMMIT");
      return captured.probe;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

/**
 * Identifies a newly created successor without exposing message text. A
 * candidate must be in the original workspace, be created/updated after the
 * supplied anchor, and end with the expected user-text SHA-256 sequence.
 */
export async function findChatRecoverySuccessor(
  databasePath: string,
  originalComposerId: string,
  options: ChatRecoverySuccessorOptions,
): Promise<ChatRecoverySuccessorProbe> {
  assertComposerId(originalComposerId);
  if (!Number.isSafeInteger(options.createdAfter) || options.createdAfter < 0) {
    throw new Error("createdAfter must be a non-negative epoch millisecond.");
  }
  const snapshotByteLimit = normalizePositiveLimit(
    "snapshotByteLimit",
    options.snapshotByteLimit ?? DEFAULT_SNAPSHOT_BYTE_LIMIT,
  );
  const maxCandidates = normalizePositiveLimit(
    "maxCandidates",
    options.maxCandidates ?? DEFAULT_MAX_SUCCESSOR_CANDIDATES,
  );
  const expectedHashes = [...(options.expectedUserTextHashes ?? [])];
  for (const hash of expectedHashes) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error("Expected user-text hashes must be lowercase SHA-256.");
    }
  }

  const database = openDatabase(databasePath, { readOnly: true });
  try {
    enableReadOnlyTransaction(database);
    try {
      const original = readSnapshot(
        database,
        originalComposerId,
        snapshotByteLimit,
      );
      const candidates = database
        .prepare(
          `SELECT composerId
             FROM composerHeaders
            WHERE COALESCE(isSubagent, 0) = 0
              AND CAST(composerId AS TEXT) <> ?
              AND ((? IS NULL AND workspaceId IS NULL) OR
                   CAST(workspaceId AS TEXT) = ?)
              AND ((typeof(createdAt) IN ('integer', 'real') AND createdAt >= ?) OR
                   (typeof(lastUpdatedAt) IN ('integer', 'real') AND
                    lastUpdatedAt >= ?))
            ORDER BY CASE
                       WHEN typeof(createdAt) IN ('integer', 'real') THEN createdAt
                       ELSE lastUpdatedAt
                     END,
                     CAST(composerId AS TEXT)
            LIMIT ?`,
        )
        .all(
          originalComposerId,
          original.header.workspaceId,
          original.header.workspaceId,
          options.createdAfter,
          options.createdAfter,
          maxCandidates + 1,
        ) as unknown as RawSuccessorCandidate[];
      const candidateLimitReached = candidates.length > maxCandidates;
      const retainedCandidates = candidates.slice(0, maxCandidates);
      const matches: ChatRecoveryProbe[] = [];
      for (const row of retainedCandidates) {
        if (
          typeof row.composerId !== "string" ||
          !isSyncableComposerId(row.composerId)
        ) {
          continue;
        }
        let captured: CapturedRecoveryProbe;
        try {
          captured = await captureInTransaction(
            database,
            row.composerId,
            snapshotByteLimit,
          );
        } catch {
          continue;
        }
        if (endsWith(collapseRuns(captured.userTextHashes), expectedHashes)) {
          matches.push(captured.probe);
        }
      }
      database.exec("COMMIT");
      const successor =
        !candidateLimitReached && matches.length === 1 ? matches[0]! : null;
      return {
        originalComposerId,
        createdAfter: options.createdAfter,
        candidateCount: retainedCandidates.length,
        candidateLimitReached,
        matchingCandidateCount: matches.length,
        identifiedComposerId: successor?.composerId ?? null,
        successor,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function enableReadOnlyTransaction(database: DatabaseSync): void {
  database.exec("PRAGMA busy_timeout=2000");
  database.exec("PRAGMA query_only=ON");
  database.exec("BEGIN");
}

async function captureInTransaction(
  database: DatabaseSync,
  composerId: string,
  snapshotByteLimit: number,
): Promise<CapturedRecoveryProbe> {
  const snapshot = readSnapshot(database, composerId, snapshotByteLimit);
  const referenceAudit = auditChatReferences(snapshot);
  if (referenceAudit.status !== "known") {
    throw new Error(`Visible-row audit is unknown: ${referenceAudit.reason}.`);
  }
  const graphStatement = database.prepare(
    `SELECT key,
            CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value ELSE NULL END AS value,
            typeof(value) AS valueType,
            length(CAST(value AS BLOB)) AS valueBytes
       FROM cursorDiskKV
      WHERE key = ?`,
  );
  const graphAudit = await auditChatContinuationRoots(
    snapshot,
    (key, remainingBytes) =>
      probeAgentKvRow(graphStatement, key, remainingBytes),
  );
  const visible = inspectVisibleRows(
    snapshot,
    referenceAudit.referencedBubbleKeys,
  );
  const agentKv: ChatRecoveryProbe["agentKv"] =
    graphAudit.status === "known"
      ? {
          status: "known",
          conversationStateCount: graphAudit.conversationStateCount,
          referencedCount: graphAudit.referencedRootIds.length,
          foundCount:
            graphAudit.referencedRootIds.length -
            graphAudit.unavailableRootIds.length,
          unavailableCount: graphAudit.unavailableRootIds.length,
          probedCount: graphAudit.probedRootCount,
          complete: graphAudit.unavailableRootIds.length === 0,
          fingerprint: graphAudit.fingerprint,
        }
      : {
          status: "unknown",
          conversationStateCount: graphAudit.conversationStateCount,
          referencedCount: graphAudit.referencedRootCount,
          probedCount: graphAudit.probedRootCount,
          reason: graphAudit.reason,
        };
  const headerFingerprint = sha256(canonicalBytes(snapshot.header));
  const composerDataFingerprint = sha256(
    canonicalBytes(snapshot.composerData),
  );
  const coreFingerprint = portableChatCoreHash(snapshot);
  const workspaceFingerprint = sha256(snapshot.header.workspaceId ?? "null");
  const stableProbe = {
    composerId,
    headerFingerprint,
    composerDataFingerprint,
    referenceFingerprint: referenceAudit.fingerprint,
    coreFingerprint,
    visible: {
      referencedCount: referenceAudit.referencedBubbleKeys.length,
      presentReferencedCount:
        referenceAudit.referencedBubbleKeys.length -
        referenceAudit.unavailableBubbleKeys.length,
      unavailableReferencedCount: referenceAudit.unavailableBubbleKeys.length,
      storedBubbleCount: snapshot.bubbles.length,
    },
    roles: visible.roles,
    markers: visible.markers,
    tail: visible.tail,
    agentKv,
  };
  return {
    probe: {
      createdAt: snapshot.header.createdAt,
      lastUpdatedAt: snapshot.header.lastUpdatedAt,
      workspaceFingerprint,
      ...stableProbe,
      probeFingerprint: sha256(canonicalBytes(stableProbe)),
    },
    userTextHashes: visible.userTextHashes,
  };
}

function readSnapshot(
  database: DatabaseSync,
  composerId: string,
  snapshotByteLimit: number,
): PortableChatSnapshot {
  const bounded = readPortableChatSnapshotBounded(
    database,
    composerId,
    snapshotByteLimit,
  );
  if (bounded.status !== "known") {
    throw new Error(
      bounded.limitReached
        ? "The composer exceeds the bounded probe snapshot limit."
        : "The composer is missing or unreadable.",
    );
  }
  return bounded.snapshot;
}

function inspectVisibleRows(
  snapshot: PortableChatSnapshot,
  references: readonly string[],
): {
  roles: RecoveryRoleProbe;
  markers: RecoveryMarkerProbe;
  tail: ChatRecoveryProbe["tail"];
  userTextHashes: string[];
} {
  const rows = new Map(snapshot.bubbles.map((row) => [row.key, row]));
  const roles: RecoveryRoleProbe = {
    referencedUser: 0,
    referencedAssistant: 0,
    recoverableUserRecords: 0,
    recoverableAssistantRecords: 0,
    toolUseCount: 0,
    validToolUseCount: 0,
    rawToolNameCounts: {},
    skippedEmptyAssistantRows: 0,
    unrecoverableUserRows: 0,
    unsupportedRoleRows: 0,
    unreadableRows: 0,
  };
  const markers: RecoveryMarkerProbe = {
    timerOrTimepicker: false,
    timerOrTimepickerHits: 0,
    hieungIeung: false,
    hieungIeungHits: 0,
  };
  const userTextHashes: string[] = [];
  let lastUser: RecoveryTailProbe | null = null;
  let lastAssistant: RecoveryTailProbe | null = null;

  for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex += 1) {
    const key = references[referenceIndex];
    if (key === undefined) {
      continue;
    }
    const row = rows.get(key);
    if (row === undefined) {
      continue;
    }
    let value: Record<string, unknown>;
    try {
      value = parseJsonRow(row);
    } catch {
      roles.unreadableRows += 1;
      continue;
    }
    const type = value.type;
    if (type !== 1 && type !== 2) {
      roles.unsupportedRoleRows += 1;
      continue;
    }
    const text = visibleText(value, type);
    const hasText = text.length > 0;
    const hasToolUse = type === 2 && value.toolFormerData !== undefined;
    const validToolUse = hasToolUse && isValidToolUse(value.toolFormerData);
    const recoverable = hasText || hasToolUse;
    const textHash = hasText ? sha256(text) : null;
    if (hasText) {
      const timerHits = markerHitCount(text, [
        "timer",
        "timepicker",
        "time picker",
        "타이머",
        "타임피커",
      ]);
      markers.timerOrTimepickerHits += timerHits;
      markers.timerOrTimepicker ||= timerHits > 0;
      const hieungIeungHits = literalHitCount(text, "ㅎㅇ");
      markers.hieungIeungHits += hieungIeungHits;
      markers.hieungIeung ||= hieungIeungHits > 0;
    }
    const tail: RecoveryTailProbe = {
      referenceIndex,
      recoverable,
      hasText,
      hasToolUse,
    };
    if (type === 1) {
      roles.referencedUser += 1;
      lastUser = tail;
      if (recoverable) {
        roles.recoverableUserRecords += 1;
      } else {
        roles.unrecoverableUserRows += 1;
      }
      if (textHash !== null) {
        userTextHashes.push(textHash);
      }
      continue;
    }
    roles.referencedAssistant += 1;
    lastAssistant = tail;
    if (hasToolUse) {
      roles.toolUseCount += 1;
      const rawName = rawToolName(value.toolFormerData);
      if (rawName !== null) {
        roles.rawToolNameCounts[rawName] =
          (roles.rawToolNameCounts[rawName] ?? 0) + 1;
      }
      if (validToolUse) {
        roles.validToolUseCount += 1;
      }
    }
    if (recoverable) {
      roles.recoverableAssistantRecords += 1;
    } else {
      roles.skippedEmptyAssistantRows += 1;
    }
  }
  return {
    roles,
    markers,
    tail: {
      lastUser,
      lastAssistant,
      assistantFollowsLastUser:
        lastUser !== null &&
        lastAssistant !== null &&
        lastAssistant.referenceIndex > lastUser.referenceIndex &&
        lastAssistant.recoverable,
    },
    userTextHashes,
  };
}

function probeAgentKvRow(
  statement: ReturnType<DatabaseSync["prepare"]>,
  expectedKey: string,
  remainingBytes: number,
): ChatContinuationRootProbeResult {
  const row = statement.get(
    remainingBytes,
    expectedKey,
  ) as RawAgentKvProbeRow | undefined;
  if (row === undefined) {
    return { status: "missing" };
  }
  if (row.key !== expectedKey) {
    return { status: "unreadable", reason: "agentKv key is not exact text" };
  }
  const valueBytes = sqliteNonnegativeNumber(row.valueBytes);
  if (valueBytes === null) {
    return { status: "unreadable", reason: "agentKv length is unavailable" };
  }
  if (valueBytes > remainingBytes) {
    return { status: "over-budget" };
  }
  if (row.valueType === "text" && typeof row.value === "string") {
    return {
      status: "found",
      key: expectedKey,
      bytes: Buffer.from(row.value, "utf8"),
      valueType: "text",
    };
  }
  if (row.valueType === "blob" && row.value instanceof Uint8Array) {
    return {
      status: "found",
      key: expectedKey,
      bytes: Buffer.from(row.value),
      valueType: "blob",
    };
  }
  return { status: "unreadable", reason: "agentKv value is not text/blob" };
}

function parseJsonRow(row: PortableKvRow): Record<string, unknown> {
  if (row.valueType !== "text" && row.valueType !== "blob") {
    throw new Error("row is not JSON text");
  }
  const bytes = Buffer.from(row.valueBase64, "base64");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("row is not lossless UTF-8");
  }
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("row is not a JSON object");
  }
  return value as Record<string, unknown>;
}

function visibleText(value: Record<string, unknown>, type: 1 | 2): string {
  if (typeof value.text === "string" && value.text.length > 0) {
    return value.text;
  }
  return type === 1 && typeof value.richText === "string" ? value.richText : "";
}

function isValidToolUse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const tool = value as Record<string, unknown>;
  if (
    typeof tool.name !== "string" ||
    tool.name.length === 0 ||
    typeof tool.params !== "string"
  ) {
    return false;
  }
  try {
    const parameters = JSON.parse(tool.params) as unknown;
    return parameters !== null && typeof parameters === "object";
  } catch {
    return false;
  }
}

function rawToolName(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function markerHitCount(text: string, markers: readonly string[]): number {
  const lower = text.toLocaleLowerCase("en-US");
  return markers.reduce(
    (total, marker) => total + literalHitCount(lower, marker),
    0,
  );
}

function literalHitCount(text: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - marker.length) {
    const found = text.indexOf(marker, offset);
    if (found < 0) {
      break;
    }
    count += 1;
    offset = found + marker.length;
  }
  return count;
}

function endsWith(values: readonly string[], suffix: readonly string[]): boolean {
  if (suffix.length === 0 || suffix.length > values.length) {
    return false;
  }
  const offset = values.length - suffix.length;
  return suffix.every((value, index) => values[offset + index] === value);
}

function collapseRuns(values: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const value of values) {
    if (collapsed[collapsed.length - 1] !== value) {
      collapsed.push(value);
    }
  }
  return collapsed;
}

function sqliteNonnegativeNumber(value: SqliteStorageValue): number | null {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number >= 0
    ? number
    : null;
}

function assertComposerId(composerId: string): void {
  if (!isSyncableComposerId(composerId)) {
    throw new Error("Composer ID must be a canonical UUID.");
  }
}

function normalizePositiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}
