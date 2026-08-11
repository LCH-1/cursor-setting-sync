import type { DatabaseSync, SqliteStorageValue } from "../platform/sqlite";
import { openDatabase } from "../platform/sqlite";
import type { CursorPaths } from "../platform/paths";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import {
  bubbleKeyRange,
  isSyncableComposerId,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  scanPortableChatConversationStates,
  type PortableChatSnapshot,
  type PortableComposerHeader,
  type PortableKvRow,
} from "./stateVscdb";
import {
  extractAgentKvRootIds,
  walkAgentKvReachability,
  type AgentKvBlobLookup,
  type AgentKvBlobLookupResult,
} from "./agentKv";
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

interface RawKvMetadataRow {
  key: SqliteStorageValue;
  valueType: SqliteStorageValue;
  valueBytes: SqliteStorageValue;
}

interface RawKvMetadataSummary {
  rawBytes: SqliteStorageValue;
}

interface RawKvGuardedRow extends RawKvRow {
  valueBytes: SqliteStorageValue;
}

interface RawComposerHeaderGuarded extends RawComposerHeader {
  headerValueType: SqliteStorageValue;
  headerValueBytes: SqliteStorageValue;
  workspaceIdType: SqliteStorageValue;
  workspaceIdBytes: SqliteStorageValue;
}

interface RawBrokenComposerMetadata extends RawKvMetadataRow {
  composerId: SqliteStorageValue;
  headerValueType: SqliteStorageValue;
  headerValueBytes: SqliteStorageValue;
  workspaceIdType: SqliteStorageValue;
  workspaceIdBytes: SqliteStorageValue;
}

interface RawAgentKvProbeRow {
  key: SqliteStorageValue;
  value: SqliteStorageValue;
  valueType: SqliteStorageValue;
  valueBytes: SqliteStorageValue;
}

const REPAIR_ROW_JSON_MAX_STRUCTURAL_TOKENS = 262_144;
const REPAIR_ROW_JSON_MAX_NESTING_DEPTH = 256;
const REPAIR_ROW_JSON_STRUCTURE_LIMIT_REASON =
  "chat row JSON structural work limit was reached";

type RepairRowJsonInspection =
  | { status: "usable"; value: unknown }
  | { status: "unusable" }
  | { status: "unknown"; reason: string };

interface PortableRowJsonCacheEntry {
  valueBase64: string;
  valueType: NonNullable<PortableKvRow["valueType"]>;
  inspection: RepairRowJsonInspection;
}

interface RepairRowJsonWork {
  remainingStructuralTokens: number;
  structuralLimitReached: boolean;
  /** Multiple stored versions may reuse a key with different row contents. */
  portableByKey: Map<string, PortableRowJsonCacheEntry[]>;
  /** A read transaction makes one live cursorDiskKV value stable by exact key. */
  rawByKey: Map<string, RepairRowJsonInspection>;
}

type ReferencedBubbleKeysResult =
  | { status: "known"; keys: string[] }
  | { status: "unknown"; reason: string };

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
  /** Exact canonical bytes retained by `broken` snapshots. */
  retainedSnapshotBytes: number;
  /** Damaged conversations proved by their references but not materialized. */
  deferredBrokenChats: number;
  /** Conversations skipped before value reads because one snapshot cannot fit. */
  oversizedChats: number;
  /** Exact hard byte bound used for one materialized portable snapshot. */
  snapshotByteLimit: number;
  /** True when a fixed byte, count, or JSON-structure bound made work unknown. */
  limitReached: boolean;
  broken: BrokenChatObservation[];
}

export interface BrokenChatInspectionLimits {
  /** Maximum full damaged-chat snapshots retained by one command run. */
  maxRetainedChats: number;
  /** Maximum exact canonical snapshot bytes retained across the command. */
  maxRetainedBytes: number;
}

export const DEFAULT_BROKEN_CHAT_INSPECTION_LIMITS: Readonly<
  BrokenChatInspectionLimits
> = Object.freeze({
  maxRetainedChats: 8,
  maxRetainedBytes: 64 * 1024 * 1024,
});

export interface BrokenChatInspectionOptions {
  limits?: Partial<BrokenChatInspectionLimits>;
  /** Optional exact resource scope, used by the post-confirmation recheck. */
  resourceIds?: ReadonlySet<string>;
}

export interface ChatContinuationAuditLimits {
  /** Maximum syncable composer bodies materialized by one command run. */
  maxChats: number;
  /** Maximum canonical portable chat bytes materialized for one conversation. */
  maxSnapshotBytesPerChat: number;
  /** Maximum exact agentKv key lookups across the complete command run. */
  maxRootProbes: number;
  /** Maximum reachable graph nodes inspected for one conversation. */
  maxRootsPerChat: number;
  /** Maximum decoded conversationState plus graph bytes per conversation. */
  maxSeedBytesPerChat: number;
  /** Maximum content-addressed graph-edge depth inspected per conversation. */
  maxGraphDepth: number;
  /** Maximum nested protobuf depth inspected inside conversationState. */
  maxProtobufDepth: number;
}

export const DEFAULT_CHAT_CONTINUATION_AUDIT_LIMITS: Readonly<
  ChatContinuationAuditLimits
> = Object.freeze({
  maxChats: 10_000,
  maxSnapshotBytesPerChat:
    DEFAULT_BROKEN_CHAT_INSPECTION_LIMITS.maxRetainedBytes,
  maxRootProbes: 100_000,
  maxRootsPerChat: 10_000,
  maxSeedBytesPerChat: 32 * 1024 * 1024,
  maxGraphDepth: 256,
  maxProtobufDepth: 64,
});

export interface ChatContinuationAuditOptions {
  limits?: Partial<ChatContinuationAuditLimits>;
}

export type ChatContinuationRootProbeResult = AgentKvBlobLookupResult;

export type ChatContinuationRootProbe = AgentKvBlobLookup;

export type ChatContinuationRootAudit =
  | {
      status: "known";
      conversationStateCount: number;
      /** Historical name: every discovered reachable content ID, including descendants. */
      referencedRootIds: string[];
      /** Historical name: every missing, tampered, or unreadable reachable content ID. */
      unavailableRootIds: string[];
      probedRootCount: number;
      fingerprint: string;
    }
  | {
      status: "unknown";
      conversationStateCount: number;
      referencedRootCount: number;
      probedRootCount: number;
      reason:
        | "conversation-state-json-structure-limit"
        | "conversation-state-unreadable"
        | "conversation-state-limit"
        | "roots-per-chat-limit"
        | "root-probe-budget"
        | "graph-limit"
        | "root-probe-failed";
    };

export interface BrokenChatContinuationObservation {
  resourceId: string;
  composerId: string;
  title: string | null;
  workspaceId: string | null;
  lastUpdatedAt: number | null;
  conversationStateCount: number;
  referencedRootCount: number;
  unavailableRootCount: number;
  /**
   * Internal recovery identities for all unavailable reachable nodes, not just
   * top-level roots. Do not interpolate these into UI strings.
   */
  unavailableRootIds: string[];
  /** Hash of the exact live header/composerData/bubbles audited for this chat. */
  chatCoreHash: string;
  fingerprint: string;
}

export interface BrokenChatContinuationInspection {
  examinedChats: number;
  auditedChats: number;
  unknownChats: number;
  probedRootCount: number;
  /** True when a configured command bound prevented a complete inspection. */
  limitReached: boolean;
  broken: BrokenChatContinuationObservation[];
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
  options?: BrokenChatInspectionOptions,
): Promise<BrokenChatInspection> {
  const database = openDatabase(paths.globalDatabase, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=2000");
    database.exec("PRAGMA query_only=ON");
    return inspectBrokenChatsInDatabase(database, options);
  } finally {
    database.close();
  }
}

/**
 * Finds conversations whose Cursor conversationState graph is not fully
 * reachable through hash-valid agentKv rows. The command performs only exact,
 * indexed key lookups and bounds graph nodes, bytes, and depth. This detects a
 * missing descendant and a hash-corrupt row even when every top-level key is
 * present, without scanning the shared content-addressed store.
 */
export async function inspectBrokenCursorChatContinuations(
  paths: CursorPaths,
  options?: ChatContinuationAuditOptions,
): Promise<BrokenChatContinuationInspection> {
  const database = openDatabase(paths.globalDatabase, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=2000");
    database.exec("PRAGMA query_only=ON");
    return await inspectBrokenChatContinuationsInDatabase(database, options);
  } finally {
    database.close();
  }
}

/**
 * Read-only database form used by the command and isolated scenario tests.
 * Peak retained state is one bounded graph walk for one portable conversation;
 * observations retain only metadata and bounded content IDs. Blob payloads are
 * released before the next conversation and never escape this function.
 */
export async function inspectBrokenChatContinuationsInDatabase(
  database: DatabaseSync,
  options?: ChatContinuationAuditOptions,
): Promise<BrokenChatContinuationInspection> {
  const limits = normalizeChatContinuationAuditLimits(options);
  database.exec("BEGIN");
  try {
    let examinedChats = 0;
    let auditedChats = 0;
    let unknownChats = 0;
    let probedRootCount = 0;
    let limitReached = false;
    const broken: BrokenChatContinuationObservation[] = [];
    const composers = database.prepare(
      `SELECT h.composerId AS composerId
         FROM composerHeaders h
         JOIN cursorDiskKV d
           ON d.key = 'composerData:' || CAST(h.composerId AS TEXT)
        WHERE COALESCE(h.isSubagent, 0) = 0
        ORDER BY CASE
                   WHEN typeof(h.lastUpdatedAt) IN ('integer', 'real')
                     THEN h.lastUpdatedAt
                   ELSE NULL
                 END DESC,
                 CAST(h.composerId AS TEXT)`,
    );
    const rootProbe = database.prepare(
      "SELECT key, " +
        "CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value ELSE NULL END AS value, " +
        "typeof(value) AS valueType, length(CAST(value AS BLOB)) AS valueBytes " +
        "FROM cursorDiskKV WHERE key = ?",
    );

    for (const row of composers.iterate() as Iterable<{
      composerId: SqliteStorageValue;
    }>) {
      const composerId = sqliteText(row.composerId);
      if (composerId === null || !isSyncableComposerId(composerId)) {
        continue;
      }
      if (examinedChats >= limits.maxChats) {
        limitReached = true;
        break;
      }
      examinedChats += 1;

      let boundedSnapshot: BoundedPortableChatReadResult;
      try {
        boundedSnapshot = readPortableChatSnapshotBounded(
          database,
          composerId,
          limits.maxSnapshotBytesPerChat,
        );
      } catch {
        boundedSnapshot = { status: "unknown", limitReached: false };
      }
      if (boundedSnapshot.status === "unknown") {
        unknownChats += 1;
        limitReached ||= boundedSnapshot.limitReached;
        continue;
      }
      const snapshot = boundedSnapshot.snapshot;

      const remainingRootProbes = limits.maxRootProbes - probedRootCount;
      const audit = await auditChatContinuationRootsWithLimits(
        snapshot,
        (key, remainingBytes) =>
          probeAgentKvRootStorage(rootProbe, key, remainingBytes),
        limits,
        remainingRootProbes,
      );
      probedRootCount += audit.probedRootCount;
      if (audit.status === "unknown") {
        unknownChats += 1;
        if (
          audit.reason === "conversation-state-limit" ||
          audit.reason === "roots-per-chat-limit" ||
          audit.reason === "root-probe-budget" ||
          audit.reason === "graph-limit"
        ) {
          limitReached = true;
        }
        if (audit.reason === "root-probe-budget") {
          break;
        }
        continue;
      }
      auditedChats += 1;
      if (audit.unavailableRootIds.length === 0) {
        continue;
      }
      broken.push({
        resourceId: `chat/${composerId}`,
        composerId,
        title: chatHeaderTitle(snapshot.header.value),
        workspaceId: snapshot.header.workspaceId,
        lastUpdatedAt: snapshot.header.lastUpdatedAt,
        conversationStateCount: audit.conversationStateCount,
        referencedRootCount: audit.referencedRootIds.length,
        unavailableRootCount: audit.unavailableRootIds.length,
        unavailableRootIds: audit.unavailableRootIds,
        chatCoreHash: portableChatCoreHash(snapshot),
        fingerprint: audit.fingerprint,
      });
    }

    database.exec("COMMIT");
    return {
      examinedChats,
      auditedChats,
      unknownChats,
      probedRootCount,
      limitReached,
      broken: broken.sort(
        (left, right) =>
          right.unavailableRootCount - left.unavailableRootCount ||
          compareText(left.resourceId, right.resourceId),
      ),
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Pure, bounded reachability audit. Unknown/unsupported conversationState
 * input is not classified as damaged: callers can report it separately without
 * offering a destructive or ineffective repair.
 */
export async function auditChatContinuationRoots(
  snapshot: PortableChatSnapshot,
  probe: ChatContinuationRootProbe,
  options?: ChatContinuationAuditOptions,
): Promise<ChatContinuationRootAudit> {
  const limits = normalizeChatContinuationAuditLimits(options);
  return auditChatContinuationRootsWithLimits(
    snapshot,
    probe,
    limits,
    limits.maxRootProbes,
  );
}

async function auditChatContinuationRootsWithLimits(
  snapshot: PortableChatSnapshot,
  probe: ChatContinuationRootProbe,
  limits: Readonly<ChatContinuationAuditLimits>,
  remainingRootProbes: number,
): Promise<ChatContinuationRootAudit> {
  const stateScan = scanPortableChatConversationStates(snapshot);
  if (stateScan.status === "structure-limit") {
    return {
      status: "unknown",
      conversationStateCount: 0,
      referencedRootCount: 0,
      probedRootCount: 0,
      reason: "conversation-state-json-structure-limit",
    };
  }
  const states = stateScan.states;
  if (states.length === 0) {
    return {
      status: "known",
      conversationStateCount: 0,
      referencedRootIds: [],
      unavailableRootIds: [],
      probedRootCount: 0,
      fingerprint: sha256(
        canonicalBytes({
          auditVersion: 2,
          composerId: snapshot.composerId,
          conversationStateHashes: [],
          graph: [],
        }),
      ),
    };
  }
  const extracted = extractAgentKvRootIds(states, {
    limits: {
      maxNodes: Math.max(1, limits.maxRootsPerChat),
      maxBytes: limits.maxSeedBytesPerChat,
      maxProtobufDepth: limits.maxProtobufDepth,
    },
  });
  if (extracted.unreadable.length > 0) {
    return {
      status: "unknown",
      conversationStateCount: states.length,
      referencedRootCount: extracted.roots.length,
      probedRootCount: 0,
      reason: "conversation-state-unreadable",
    };
  }
  if (
    !extracted.complete &&
    extracted.limitReasons.some((reason) => reason !== "nodes")
  ) {
    return {
      status: "unknown",
      conversationStateCount: states.length,
      referencedRootCount: extracted.roots.length,
      probedRootCount: 0,
      reason: "conversation-state-limit",
    };
  }
  if (
    extracted.limitReasons.includes("nodes") ||
    extracted.roots.length > limits.maxRootsPerChat
  ) {
    return {
      status: "unknown",
      conversationStateCount: states.length,
      referencedRootCount: extracted.roots.length,
      probedRootCount: 0,
      reason: "roots-per-chat-limit",
    };
  }
  if (extracted.roots.length > remainingRootProbes) {
    return {
      status: "unknown",
      conversationStateCount: states.length,
      referencedRootCount: extracted.roots.length,
      probedRootCount: 0,
      reason: "root-probe-budget",
    };
  }
  if (extracted.roots.length === 0) {
    return {
      status: "known",
      conversationStateCount: states.length,
      referencedRootIds: [],
      unavailableRootIds: [],
      probedRootCount: 0,
      fingerprint: sha256(
        canonicalBytes({
          auditVersion: 2,
          composerId: snapshot.composerId,
          conversationStateHashes: states.map((state) => sha256(state)),
          graph: [],
        }),
      ),
    };
  }

  let walked: Awaited<ReturnType<typeof walkAgentKvReachability>>;
  try {
    walked = await walkAgentKvReachability(states, probe, {
      limits: {
        maxNodes: Math.min(limits.maxRootsPerChat, remainingRootProbes),
        maxBytes: limits.maxSeedBytesPerChat,
        maxDepth: limits.maxGraphDepth,
        maxProtobufDepth: limits.maxProtobufDepth,
      },
    });
  } catch {
    return {
      status: "unknown",
      conversationStateCount: states.length,
      referencedRootCount: extracted.roots.length,
      probedRootCount: 0,
      reason: "root-probe-failed",
    };
  }
  if (walked.limitReasons.length > 0) {
    const nodeLimitedByGlobalBudget =
      walked.limitReasons.includes("nodes") &&
      remainingRootProbes < limits.maxRootsPerChat;
    return {
      status: "unknown",
      conversationStateCount: states.length,
      referencedRootCount: new Set([
        ...walked.blobs.map((blob) => blob.id),
        ...walked.unavailableIds,
      ]).size,
      probedRootCount: walked.visitedNodes,
      reason: nodeLimitedByGlobalBudget
        ? "root-probe-budget"
        : walked.limitReasons.length === 1 &&
            walked.limitReasons[0] === "nodes"
          ? "roots-per-chat-limit"
          : "graph-limit",
    };
  }
  if (
    walked.unreadable.some((issue) => issue.source === "conversation-state")
  ) {
    return {
      status: "unknown",
      conversationStateCount: states.length,
      referencedRootCount: walked.roots.length,
      probedRootCount: walked.visitedNodes,
      reason: "conversation-state-unreadable",
    };
  }
  const referencedRootIds = [
    ...new Set([
      ...walked.blobs.map((blob) => blob.id),
      ...walked.unavailableIds,
    ]),
  ].sort(compareText);
  const unavailableRootIds = [...walked.unavailableIds];
  return {
    status: "known",
    conversationStateCount: states.length,
    referencedRootIds,
    unavailableRootIds,
    probedRootCount: walked.visitedNodes,
    fingerprint: sha256(
      canonicalBytes({
        auditVersion: 2,
        composerId: snapshot.composerId,
        conversationStateHashes: states.map((state) => sha256(state)),
        roots: walked.roots,
        materialized: walked.blobs.map((blob) => blob.id),
        missing: walked.missing.map((blob) => blob.id),
        tampered: walked.tampered.map((blob) => ({
          id: blob.id,
          actualHash: blob.actualHash,
        })),
        unreadable: walked.unreadable
          .filter((issue) => issue.source === "blob")
          .map((issue) => ({
            id: issue.id,
            reason: issue.reason,
          })),
      }),
    ),
  };
}

function probeAgentKvRootStorage(
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
    return {
      status: "unreadable",
      reason: "agentKv value length is unavailable",
    };
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
      bytes: row.value,
      valueType: "blob",
    };
  }
  return {
    status: "unreadable",
    reason: `unsupported SQLite storage class: ${String(row.valueType)}`,
  };
}

export function inspectBrokenChatsInDatabase(
  database: DatabaseSync,
  options?: BrokenChatInspectionOptions,
): BrokenChatInspection {
  const limits = normalizeBrokenChatInspectionLimits(options);
  database.exec("BEGIN");
  try {
    const broken: BrokenChatObservation[] = [];
    let examinedChats = 0;
    let retainedSnapshotBytes = 0;
    let deferredBrokenChats = 0;
    let oversizedChats = 0;
    let limitReached = false;
    const rawValueLimit = portableRawValueLimit(limits.maxRetainedBytes);
    const composerStatement = database.prepare(
      `SELECT h.composerId AS composerId,
              typeof(h.value) AS headerValueType,
              length(CAST(h.value AS BLOB)) AS headerValueBytes,
              typeof(h.workspaceId) AS workspaceIdType,
              length(CAST(h.workspaceId AS BLOB)) AS workspaceIdBytes,
              d.key AS key, typeof(d.value) AS valueType,
              length(CAST(d.value AS BLOB)) AS valueBytes
         FROM composerHeaders h
         JOIN cursorDiskKV d
           ON d.key = 'composerData:' || CAST(h.composerId AS TEXT)
        WHERE COALESCE(h.isSubagent, 0) = 0
        ORDER BY CASE
                   WHEN typeof(h.lastUpdatedAt) IN ('integer', 'real')
                     THEN h.lastUpdatedAt
                   ELSE NULL
                 END DESC,
                 CAST(h.composerId AS TEXT)`,
    );
    const headerStatement = database.prepare(
      `SELECT composerId,
              CASE
                WHEN typeof(workspaceId) = 'null' OR
                     length(CAST(workspaceId AS BLOB)) <= ?
                  THEN workspaceId
                ELSE NULL
              END AS workspaceId,
              typeof(workspaceId) AS workspaceIdType,
              length(CAST(workspaceId AS BLOB)) AS workspaceIdBytes,
              createdAt, lastUpdatedAt, isArchived,
              isSubagent, recency, checkpointAt,
              CASE
                WHEN typeof(value) = 'null' OR length(CAST(value AS BLOB)) <= ?
                  THEN value
                ELSE NULL
              END AS value,
              typeof(value) AS headerValueType,
              length(CAST(value AS BLOB)) AS headerValueBytes
         FROM composerHeaders
        WHERE CAST(composerId AS TEXT) = ? AND COALESCE(isSubagent, 0) = 0`,
    );
    const composerDataStatement = database.prepare(
      `SELECT key,
              CASE
                WHEN typeof(value) = 'null' OR length(CAST(value AS BLOB)) <= ?
                  THEN value
                ELSE NULL
              END AS value,
              typeof(value) AS valueType,
              length(CAST(value AS BLOB)) AS valueBytes
         FROM cursorDiskKV
        WHERE key = ?`,
    );
    const bubbleMetadataStatement = database.prepare(
      `SELECT key, typeof(value) AS valueType,
              length(CAST(value AS BLOB)) AS valueBytes
         FROM cursorDiskKV
        WHERE key >= ? AND key < ?
        ORDER BY key`,
    );
    const referencedBubbleStatement = database.prepare(
      `SELECT key,
              CASE
                WHEN typeof(value) = 'null' OR length(CAST(value AS BLOB)) <= ?
                  THEN value
                ELSE NULL
              END AS value,
              typeof(value) AS valueType,
              length(CAST(value AS BLOB)) AS valueBytes
         FROM cursorDiskKV
        WHERE key = ?`,
    );
    for (const row of composerStatement.iterate() as Iterable<RawBrokenComposerMetadata>) {
      // One malformed composer must not hide every repairable conversation.
      // This command exists for a damaged database, so per-chat isolation is a
      // correctness property rather than merely defensive logging.
      try {
        const composerId = sqliteText(row.composerId);
        if (composerId === null || !isSyncableComposerId(composerId)) {
          continue;
        }
        const resourceId = `chat/${composerId}`;
        if (
          options?.resourceIds !== undefined &&
          !options.resourceIds.has(resourceId)
        ) {
          continue;
        }
        // One chat shares one fixed budget across composerData, its referenced
        // raw rows, and the optional full snapshot recheck. A hostile newest
        // chat cannot permanently starve every older conversation on reruns.
        const rowJsonWork = createRepairRowJsonWork();
        const composerData = guardedPortableRow(
          composerDataStatement,
          row.key,
          row.valueType,
          row.valueBytes,
          rawValueLimit,
        );
        if (composerData === null) {
          // Unknown/unreadable composerData is not proof of missing messages.
          // The continuation audit records the same conversation as bounded
          // unknown without letting its value cross into JavaScript.
          continue;
        }
        const referenceKeys = referencedBubbleKeys(
          composerId,
          composerData,
          rowJsonWork,
        );
        if (referenceKeys.status === "unknown") {
          if (referenceKeys.reason === REPAIR_ROW_JSON_STRUCTURE_LIMIT_REASON) {
            limitReached = true;
          }
          continue;
        }
        const references = referenceKeys.keys;
        examinedChats += 1;
        const referenceAudit = referencedBubbleDamage(
          referencedBubbleStatement,
          references,
          rawValueLimit,
          rowJsonWork,
        );
        if (!referenceAudit.damaged) {
          if (referenceAudit.unknown) {
            limitReached = true;
          }
          // Orphan rows are not part of Cursor's conversation. In particular,
          // a huge inert orphan must not turn a healthy chat into a damaged
          // one or prevent the separate continuation audit from running.
          continue;
        }
        const headerValueBytes = portableHeaderTextByteLength(
          row.headerValueType,
          row.headerValueBytes,
        );
        const workspaceIdBytes = portableHeaderTextByteLength(
          row.workspaceIdType,
          row.workspaceIdBytes,
        );
        if (headerValueBytes === null || workspaceIdBytes === null) {
          continue;
        }
        if (
          headerValueBytes >= limits.maxRetainedBytes ||
          workspaceIdBytes >= limits.maxRetainedBytes ||
          headerValueBytes >= limits.maxRetainedBytes - workspaceIdBytes
        ) {
          oversizedChats += 1;
          limitReached = true;
          continue;
        }
        const header = guardedPortableHeader(
          headerStatement,
          composerId,
          row.headerValueType,
          row.headerValueBytes,
          row.workspaceIdType,
          row.workspaceIdBytes,
          limits.maxRetainedBytes,
        );
        if (header === null) {
          continue;
        }
        const headerBytes = portableHeaderCanonicalByteLength(header);
        if (headerBytes >= limits.maxRetainedBytes) {
          oversizedChats += 1;
          limitReached = true;
          continue;
        }
        const preflight = portableSnapshotBubbleLowerBound(
          bubbleMetadataStatement,
          composerId,
          composerData,
          limits.maxRetainedBytes,
          headerBytes,
        );
        if (preflight.exceedsLimit) {
          // This is a hard single-item refusal, not the resumable aggregate
          // batch bound below. No bubble value has crossed the JS/SQLite
          // boundary, no Base64 string or `bubbles.all()` array was created,
          // and rerunning the same command cannot make the payload fit.
          oversizedChats += 1;
          limitReached = true;
          continue;
        }
        // Once a bound is full, the lightweight indexed reference check above
        // still counts later damage, but no further full snapshot is created.
        // This keeps peak retained RAM at the admitted batch plus at most one
        // candidate considered while there is remaining byte headroom.
        if (
          broken.length >= limits.maxRetainedChats ||
          (broken.length > 0 &&
            retainedSnapshotBytes + preflight.lowerBoundBytes >=
              limits.maxRetainedBytes)
        ) {
          deferredBrokenChats += 1;
          limitReached = true;
          continue;
        }
        const snapshot = readPortableChatSnapshot(database, composerId);
        if (snapshot === null) {
          continue;
        }
        const audit = auditChatReferencesWithWork(
          snapshot,
          rowJsonWork,
          true,
        );
        if (
          audit.status === "unknown" &&
          audit.reason === REPAIR_ROW_JSON_STRUCTURE_LIMIT_REASON
        ) {
          limitReached = true;
        }
        if (
          audit.status !== "known" ||
          audit.unavailableBubbleKeys.length === 0
        ) {
          continue;
        }
        const snapshotBytes = canonicalBytes(snapshot).byteLength;
        // The metadata-only lower bound above normally rejects this before
        // materialization. Keep an exact hard guard for pathological numbers
        // of tiny keys or unusually large header metadata that the lower bound
        // deliberately did not need to retain.
        if (snapshotBytes > limits.maxRetainedBytes) {
          oversizedChats += 1;
          limitReached = true;
          continue;
        }
        if (
          broken.length > 0 &&
          retainedSnapshotBytes + snapshotBytes > limits.maxRetainedBytes
        ) {
          deferredBrokenChats += 1;
          limitReached = true;
          continue;
        }
        broken.push({
          resourceId,
          composerId,
          title: chatHeaderTitle(snapshot.header.value),
          workspaceId: snapshot.header.workspaceId,
          lastUpdatedAt: snapshot.header.lastUpdatedAt,
          referencedBubbleCount: audit.referencedBubbleKeys.length,
          unavailableBubbleKeys: audit.unavailableBubbleKeys,
          fingerprint: audit.fingerprint,
          snapshot,
        });
        retainedSnapshotBytes += snapshotBytes;
      } catch {
        // The other composer rows remain independently auditable. Unsupported
        // storage classes cannot be represented in a portable repair payload,
        // so guessing a replacement here would be less safe than skipping it.
      }
    }
    database.exec("COMMIT");
    return {
      examinedChats,
      retainedSnapshotBytes,
      deferredBrokenChats,
      oversizedChats,
      snapshotByteLimit: limits.maxRetainedBytes,
      limitReached,
      // The SQL order is deliberate: partial command batches repair the most
      // recently active damaged conversations before older ones.
      broken,
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
function referencedBubbleDamage(
  statement: ReturnType<DatabaseSync["prepare"]>,
  references: readonly string[],
  rawValueLimit: number,
  rowJsonWork: RepairRowJsonWork,
): { damaged: boolean; unknown: boolean } {
  let unknown = false;
  for (const key of references) {
    const row = statement.get(rawValueLimit, key) as
      | RawKvGuardedRow
      | undefined;
    if (row === undefined || row.key !== key) {
      return { damaged: true, unknown };
    }
    try {
      const valueType = portableValueType(row.valueType);
      const valueBytes =
        valueType === "null" ? 0 : sqliteNonnegativeNumber(row.valueBytes);
      if (valueBytes === null) {
        return { damaged: true, unknown };
      }
      if (valueBytes > rawValueLimit) {
        unknown = true;
        continue;
      }
      const inspection = inspectRawJsonRow(row, rowJsonWork);
      if (inspection.status === "unknown") {
        // The row may be perfectly usable. A bounded preflight refusal can
        // never be converted into evidence of chat damage.
        return { damaged: false, unknown: true };
      }
      if (inspection.status === "unusable") {
        return { damaged: true, unknown };
      }
    } catch {
      return { damaged: true, unknown };
    }
  }
  return { damaged: false, unknown };
}

function guardedPortableRow(
  statement: ReturnType<DatabaseSync["prepare"]>,
  key: SqliteStorageValue,
  valueTypeValue: SqliteStorageValue,
  valueBytesValue: SqliteStorageValue,
  rawValueLimit: number,
): PortableKvRow | null {
  if (typeof key !== "string") {
    return null;
  }
  let valueType: PortableKvRow["valueType"];
  try {
    valueType = portableValueType(valueTypeValue);
  } catch {
    return null;
  }
  const valueBytes =
    valueType === "null" ? 0 : sqliteNonnegativeNumber(valueBytesValue);
  if (valueBytes === null || valueBytes > rawValueLimit) {
    return null;
  }
  const row = statement.get(rawValueLimit, key) as
    | RawKvGuardedRow
    | undefined;
  if (row === undefined || row.key !== key || row.valueType !== valueTypeValue) {
    return null;
  }
  try {
    return portableRow(row);
  } catch {
    return null;
  }
}

function guardedPortableHeader(
  statement: ReturnType<DatabaseSync["prepare"]>,
  composerId: string,
  headerValueType: SqliteStorageValue,
  headerValueBytesValue: SqliteStorageValue,
  workspaceIdType: SqliteStorageValue,
  workspaceIdBytesValue: SqliteStorageValue,
  rawValueLimit: number,
): PortableComposerHeader | null {
  const headerValueBytes =
    headerValueType === "null"
      ? 0
      : sqliteNonnegativeNumber(headerValueBytesValue);
  const workspaceIdBytes =
    workspaceIdType === "null"
      ? 0
      : sqliteNonnegativeNumber(workspaceIdBytesValue);
  if (
    headerValueBytes === null ||
    workspaceIdBytes === null ||
    headerValueBytes > rawValueLimit ||
    workspaceIdBytes > rawValueLimit
  ) {
    return null;
  }
  const row = statement.get(rawValueLimit, rawValueLimit, composerId) as
    | RawComposerHeaderGuarded
    | undefined;
  if (
    row === undefined ||
    row.headerValueType !== headerValueType ||
    row.workspaceIdType !== workspaceIdType
  ) {
    return null;
  }
  try {
    return portableHeader(row, composerId);
  } catch {
    return null;
  }
}

function portableHeaderTextByteLength(
  valueType: SqliteStorageValue,
  valueBytes: SqliteStorageValue,
): number | null {
  if (valueType === "null") {
    return 0;
  }
  return valueType === "text" ? sqliteNonnegativeNumber(valueBytes) : null;
}

/** Exact canonical bytes for the header without constructing escaped copies. */
function portableHeaderCanonicalByteLength(
  header: PortableComposerHeader,
): number {
  const emptyStrings: PortableComposerHeader = {
    ...header,
    workspaceId: header.workspaceId === null ? null : "",
    value: header.value === null ? null : "",
  };
  let bytes = canonicalBytes(emptyStrings).byteLength;
  if (header.workspaceId !== null) {
    bytes += jsonStringContentByteLength(header.workspaceId);
  }
  if (header.value !== null) {
    bytes += jsonStringContentByteLength(header.value);
  }
  return Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER;
}

/** Mirrors JSON.stringify string escaping while retaining no escaped string. */
function jsonStringContentByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (!Number.isSafeInteger(bytes)) {
      return Number.MAX_SAFE_INTEGER;
    }
  }
  return bytes;
}

function createRepairRowJsonWork(): RepairRowJsonWork {
  return {
    remainingStructuralTokens: REPAIR_ROW_JSON_MAX_STRUCTURAL_TOKENS,
    structuralLimitReached: false,
    portableByKey: new Map(),
    rawByKey: new Map(),
  };
}

function inspectRawJsonRow(
  row: RawKvRow,
  rowJsonWork: RepairRowJsonWork,
): RepairRowJsonInspection {
  if (typeof row.key !== "string") {
    return { status: "unusable" };
  }
  const cached = rowJsonWork.rawByKey.get(row.key);
  if (cached !== undefined) {
    return cached;
  }
  const limitWasAlreadyReached = rowJsonWork.structuralLimitReached;
  let bytes: Buffer;
  if (row.valueType === "text" && typeof row.value === "string") {
    bytes = Buffer.from(row.value, "utf8");
  } else if (row.valueType === "blob" && row.value instanceof Uint8Array) {
    bytes = Buffer.from(row.value);
  } else {
    const inspection = { status: "unusable" } as const;
    rowJsonWork.rawByKey.set(row.key, inspection);
    return inspection;
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    const inspection = { status: "unusable" } as const;
    rowJsonWork.rawByKey.set(row.key, inspection);
    return inspection;
  }
  const inspection = inspectJsonText(text, rowJsonWork);
  // Once the aggregate budget is latched, every unseen row is unknown without
  // allocating a cache entry. The one row that exhausted it remains cached so
  // repeated checks of that exact row still have explicit tri-state identity.
  if (!limitWasAlreadyReached) {
    rowJsonWork.rawByKey.set(row.key, inspection);
  }
  return inspection;
}

function inspectPortableJsonRow(
  row: PortableKvRow,
  rowJsonWork: RepairRowJsonWork,
  trustRawCache: boolean,
): RepairRowJsonInspection {
  if (trustRawCache) {
    const raw = rowJsonWork.rawByKey.get(row.key);
    if (raw !== undefined) {
      return raw;
    }
  }
  const valueType = row.valueType ?? "text";
  const cached = rowJsonWork.portableByKey.get(row.key)?.find((entry) =>
    entry.valueType === valueType && entry.valueBase64 === row.valueBase64
  );
  if (cached !== undefined) {
    return cached.inspection;
  }
  const limitWasAlreadyReached = rowJsonWork.structuralLimitReached;
  let inspection: RepairRowJsonInspection;
  if (valueType === "null") {
    inspection = { status: "unusable" };
  } else {
    const bytes = Buffer.from(row.valueBase64, "base64");
    const text = bytes.toString("utf8");
    inspection = Buffer.from(text, "utf8").equals(bytes)
      ? inspectJsonText(text, rowJsonWork)
      : { status: "unusable" };
  }
  if (!limitWasAlreadyReached) {
    const entries = rowJsonWork.portableByKey.get(row.key);
    const entry = {
      valueBase64: row.valueBase64,
      valueType,
      inspection,
    };
    if (entries === undefined) {
      rowJsonWork.portableByKey.set(row.key, [entry]);
    } else {
      entries.push(entry);
    }
  }
  return inspection;
}

function inspectJsonText(
  text: string,
  rowJsonWork: RepairRowJsonWork,
): RepairRowJsonInspection {
  const structure = consumeRepairJsonStructure(text, rowJsonWork);
  if (structure === "limit") {
    return {
      status: "unknown",
      reason: REPAIR_ROW_JSON_STRUCTURE_LIMIT_REASON,
    };
  }
  if (structure === "malformed") {
    return { status: "unusable" };
  }
  try {
    return { status: "usable", value: JSON.parse(text) as unknown };
  } catch {
    return { status: "unusable" };
  }
}

/**
 * Debits strict JSON punctuation before JSON.parse while distinguishing a
 * fixed safety refusal from ordinary malformed data. That distinction keeps
 * malformed bubbles repairable and prevents a budget refusal from ever being
 * mislabeled as damage.
 */
function consumeRepairJsonStructure(
  input: string,
  rowJsonWork: RepairRowJsonWork,
): "fits" | "malformed" | "limit" {
  if (
    rowJsonWork.structuralLimitReached ||
    rowJsonWork.remainingStructuralTokens <= 0
  ) {
    rowJsonWork.structuralLimitReached = true;
    return "limit";
  }
  rowJsonWork.remainingStructuralTokens -= 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (code === 0x5c) {
        escaped = true;
      } else if (code === 0x22) {
        inString = false;
      }
      continue;
    }
    if (code === 0x22) {
      inString = true;
      continue;
    }
    const opens = code === 0x7b || code === 0x5b;
    const closes = code === 0x7d || code === 0x5d;
    if (!opens && !closes && code !== 0x2c && code !== 0x3a) {
      continue;
    }
    if (rowJsonWork.remainingStructuralTokens <= 0) {
      rowJsonWork.structuralLimitReached = true;
      return "limit";
    }
    rowJsonWork.remainingStructuralTokens -= 1;
    if (opens) {
      depth += 1;
      if (depth > REPAIR_ROW_JSON_MAX_NESTING_DEPTH) {
        rowJsonWork.structuralLimitReached = true;
        return "limit";
      }
    } else if (closes) {
      depth -= 1;
      if (depth < 0) {
        return "malformed";
      }
    }
  }
  return depth === 0 && !inString ? "fits" : "malformed";
}

function portableRawValueLimit(snapshotByteLimit: number): number {
  return Math.max(0, Math.floor(snapshotByteLimit / 4) * 3);
}

interface PortableSnapshotBubblePreflight {
  lowerBoundBytes: number;
  exceedsLimit: boolean;
}

/**
 * Computes a portable JSON lower bound using only SQLite type/length metadata.
 *
 * Base64 contributes four bytes for every three raw bytes and can never be
 * escaped by canonical JSON. The per-row skeleton accounts for the exact key
 * and storage-class fields. Header/outer-object bytes are intentionally
 * omitted, so crossing this bound proves the real snapshot cannot fit while a
 * value below it remains only a candidate for the later exact guard.
 */
function portableSnapshotBubbleLowerBound(
  statement: ReturnType<DatabaseSync["prepare"]>,
  composerId: string,
  composerData: PortableKvRow,
  limit: number,
  baseLowerBoundBytes = 0,
): PortableSnapshotBubblePreflight {
  let lowerBoundBytes =
    baseLowerBoundBytes +
    portableRowLowerBound(
      composerData.key,
      composerData.valueType,
      composerData.valueBase64.length,
    );
  if (lowerBoundBytes >= limit) {
    return { lowerBoundBytes: limit, exceedsLimit: true };
  }
  const [lower, upper] = bubbleKeyRange(composerId);
  for (const row of statement.iterate(lower, upper) as Iterable<RawKvMetadataRow>) {
    if (typeof row.key !== "string") {
      throw new Error("A cursorDiskKV key is not text.");
    }
    const valueType = portableValueType(row.valueType);
    const valueBytes =
      valueType === "null" ? 0 : sqliteNonnegativeNumber(row.valueBytes);
    if (valueBytes === null) {
      throw new Error(`cursorDiskKV key ${row.key} has no finite value length.`);
    }
    const encodedValueBytes = Math.ceil(valueBytes / 3) * 4;
    const rowBytes = portableRowLowerBound(
      row.key,
      valueType,
      encodedValueBytes,
    );
    if (
      rowBytes >= limit - lowerBoundBytes ||
      !Number.isSafeInteger(lowerBoundBytes + rowBytes)
    ) {
      return { lowerBoundBytes: limit, exceedsLimit: true };
    }
    lowerBoundBytes += rowBytes;
  }
  return { lowerBoundBytes, exceedsLimit: false };
}

function portableRowLowerBound(
  key: string,
  valueType: PortableKvRow["valueType"],
  encodedValueBytes: number,
): number {
  const skeletonBytes = canonicalBytes({
    key,
    valueBase64: "",
    valueType,
  }).byteLength;
  if (!Number.isSafeInteger(encodedValueBytes + skeletonBytes)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return encodedValueBytes + skeletonBytes;
}

function portableValueType(
  value: SqliteStorageValue,
): PortableKvRow["valueType"] {
  if (value === "text" || value === "blob" || value === "null") {
    return value;
  }
  throw new Error(`Unsupported SQLite storage class: ${String(value)}.`);
}

export type BoundedPortableChatReadResult =
  | { status: "known"; snapshot: PortableChatSnapshot }
  | { status: "unknown"; limitReached: boolean };

/**
 * Reads at most one portable chat under a hard canonical-size policy.
 * Metadata and guarded CASE expressions are evaluated before any potentially
 * large composerData or bubble value crosses the SQLite/JS boundary.
 */
export function readPortableChatSnapshotBounded(
  database: DatabaseSync,
  composerId: string,
  snapshotByteLimit: number,
): BoundedPortableChatReadResult {
  if (!isSyncableComposerId(composerId)) {
    return { status: "unknown", limitReached: false };
  }
  const rawValueLimit = portableRawValueLimit(snapshotByteLimit);
  const headerMetadata = database
    .prepare(
      `SELECT typeof(workspaceId) AS workspaceIdType,
              length(CAST(workspaceId AS BLOB)) AS workspaceIdBytes,
              typeof(value) AS headerValueType,
              length(CAST(value AS BLOB)) AS headerValueBytes
         FROM composerHeaders
        WHERE CAST(composerId AS TEXT) = ? AND COALESCE(isSubagent, 0) = 0`,
    )
    .get(composerId) as
    | Pick<
        RawComposerHeaderGuarded,
        | "workspaceIdType"
        | "workspaceIdBytes"
        | "headerValueType"
        | "headerValueBytes"
      >
    | undefined;
  if (headerMetadata === undefined) {
    return { status: "unknown", limitReached: false };
  }
  const headerValueBytes = portableHeaderTextByteLength(
    headerMetadata.headerValueType,
    headerMetadata.headerValueBytes,
  );
  const workspaceIdBytes = portableHeaderTextByteLength(
    headerMetadata.workspaceIdType,
    headerMetadata.workspaceIdBytes,
  );
  if (headerValueBytes === null || workspaceIdBytes === null) {
    return { status: "unknown", limitReached: false };
  }
  if (
    headerValueBytes >= snapshotByteLimit ||
    workspaceIdBytes >= snapshotByteLimit ||
    headerValueBytes >= snapshotByteLimit - workspaceIdBytes
  ) {
    return { status: "unknown", limitReached: true };
  }
  const composerDataKey = `composerData:${composerId}`;
  const composerDataMetadata = database
    .prepare(
      `SELECT key, typeof(value) AS valueType,
              length(CAST(value AS BLOB)) AS valueBytes
         FROM cursorDiskKV
        WHERE key = ?`,
    )
    .get(composerDataKey) as RawKvMetadataRow | undefined;
  if (composerDataMetadata === undefined) {
    return { status: "unknown", limitReached: false };
  }
  if (typeof composerDataMetadata.key !== "string") {
    return { status: "unknown", limitReached: false };
  }
  let composerDataValueType: PortableKvRow["valueType"];
  try {
    composerDataValueType = portableValueType(composerDataMetadata.valueType);
  } catch {
    return { status: "unknown", limitReached: false };
  }
  const composerDataValueBytes =
    composerDataValueType === "null"
      ? 0
      : sqliteNonnegativeNumber(composerDataMetadata.valueBytes);
  if (composerDataValueBytes === null) {
    return { status: "unknown", limitReached: false };
  }
  const composerDataEncodedBytes = Math.ceil(composerDataValueBytes / 3) * 4;
  let metadataLowerBound =
    headerValueBytes +
    workspaceIdBytes +
    portableRowLowerBound(
      composerDataMetadata.key,
      composerDataValueType,
      composerDataEncodedBytes,
    );
  if (
    !Number.isSafeInteger(metadataLowerBound) ||
    metadataLowerBound >= snapshotByteLimit
  ) {
    return { status: "unknown", limitReached: true };
  }
  const [bubbleLower, bubbleUpper] = bubbleKeyRange(composerId);
  const bubbleSummary = database
    .prepare(
      `SELECT COALESCE(
                SUM(length(CAST(key AS BLOB)) +
                    COALESCE(length(CAST(value AS BLOB)), 0)),
                0
              ) AS rawBytes
         FROM cursorDiskKV
        WHERE key >= ? AND key < ?`,
    )
    .get(bubbleLower, bubbleUpper) as RawKvMetadataSummary | undefined;
  if (bubbleSummary === undefined) {
    return { status: "unknown", limitReached: false };
  }
  const bubbleRawBytes = sqliteNonnegativeNumber(bubbleSummary.rawBytes);
  if (bubbleRawBytes === null) {
    return { status: "unknown", limitReached: false };
  }
  if (bubbleRawBytes >= snapshotByteLimit - metadataLowerBound) {
    // This cheap aggregate is deliberately first. It keeps a single enormous
    // key/value from crossing the SQLite/JS boundary even for the more exact
    // per-row metadata pass below.
    return { status: "unknown", limitReached: true };
  }
  const bubbleMetadataStatement = database.prepare(
    `SELECT key, typeof(value) AS valueType,
            length(CAST(value AS BLOB)) AS valueBytes
       FROM cursorDiskKV
      WHERE key >= ? AND key < ?
      ORDER BY key`,
  );
  for (const row of bubbleMetadataStatement.iterate(
    bubbleLower,
    bubbleUpper,
  ) as Iterable<RawKvMetadataRow>) {
    if (typeof row.key !== "string") {
      return { status: "unknown", limitReached: false };
    }
    let valueType: PortableKvRow["valueType"];
    try {
      valueType = portableValueType(row.valueType);
    } catch {
      return { status: "unknown", limitReached: false };
    }
    const valueBytes =
      valueType === "null" ? 0 : sqliteNonnegativeNumber(row.valueBytes);
    if (valueBytes === null) {
      return { status: "unknown", limitReached: false };
    }
    const rowBytes = portableRowLowerBound(
      row.key,
      valueType,
      Math.ceil(valueBytes / 3) * 4,
    );
    if (
      rowBytes >= snapshotByteLimit - metadataLowerBound ||
      !Number.isSafeInteger(metadataLowerBound + rowBytes)
    ) {
      return { status: "unknown", limitReached: true };
    }
    metadataLowerBound += rowBytes;
  }

  const rawHeader = database
    .prepare(
      `SELECT composerId,
              CASE
                WHEN typeof(workspaceId) = 'null' OR
                     length(CAST(workspaceId AS BLOB)) <= ?
                  THEN workspaceId
                ELSE NULL
              END AS workspaceId,
              typeof(workspaceId) AS workspaceIdType,
              length(CAST(workspaceId AS BLOB)) AS workspaceIdBytes,
              createdAt, lastUpdatedAt, isArchived,
              isSubagent, recency, checkpointAt,
              CASE
                WHEN typeof(value) = 'null' OR length(CAST(value AS BLOB)) <= ?
                  THEN value
                ELSE NULL
              END AS value,
              typeof(value) AS headerValueType,
              length(CAST(value AS BLOB)) AS headerValueBytes
         FROM composerHeaders
        WHERE CAST(composerId AS TEXT) = ? AND COALESCE(isSubagent, 0) = 0`,
    )
    .get(snapshotByteLimit, snapshotByteLimit, composerId) as
    | RawComposerHeaderGuarded
    | undefined;
  if (rawHeader === undefined) {
    return { status: "unknown", limitReached: false };
  }
  if (
    (rawHeader.headerValueType === "text"
      ? typeof rawHeader.value !== "string"
      : rawHeader.headerValueType === "null"
        ? rawHeader.value !== null
        : true) ||
    (rawHeader.workspaceIdType === "text"
      ? typeof rawHeader.workspaceId !== "string"
      : rawHeader.workspaceIdType === "null"
        ? rawHeader.workspaceId !== null
        : true)
  ) {
    return { status: "unknown", limitReached: false };
  }
  const header = portableHeader(rawHeader, composerId);
  const headerBytes = portableHeaderCanonicalByteLength(header);
  if (headerBytes >= snapshotByteLimit) {
    return { status: "unknown", limitReached: true };
  }

  const composerDataStatement = database.prepare(
    `SELECT key,
            CASE
              WHEN typeof(value) = 'null' OR length(CAST(value AS BLOB)) <= ?
                THEN value
              ELSE NULL
            END AS value,
            typeof(value) AS valueType,
            length(CAST(value AS BLOB)) AS valueBytes
       FROM cursorDiskKV
      WHERE key = ?`,
  );
  const composerData = guardedPortableRow(
    composerDataStatement,
    composerDataMetadata.key,
    composerDataMetadata.valueType,
    composerDataMetadata.valueBytes,
    rawValueLimit,
  );
  if (composerData === null) {
    const valueBytes = sqliteNonnegativeNumber(composerDataMetadata.valueBytes);
    return {
      status: "unknown",
      limitReached: valueBytes !== null && valueBytes > rawValueLimit,
    };
  }

  const bubbles: PortableKvRow[] = [];
  for (const row of database
    .prepare(
      `SELECT key, value, typeof(value) AS valueType
         FROM cursorDiskKV
        WHERE key >= ? AND key < ?
        ORDER BY key`,
    )
    .iterate(bubbleLower, bubbleUpper) as Iterable<RawKvRow>) {
    bubbles.push(portableRow(row));
  }
  const candidate: PortableChatSnapshot = {
    schemaVersion: 1,
    composerId,
    header,
    composerData,
    bubbles,
  };
  const content = canonicalBytes(candidate);
  if (content.byteLength > snapshotByteLimit) {
    return { status: "unknown", limitReached: true };
  }
  return {
    status: "known",
    snapshot: parsePortableChatSnapshot(content),
  };
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
  return auditChatReferencesWithWork(
    snapshot,
    createRepairRowJsonWork(),
    false,
  );
}

function auditChatReferencesWithWork(
  snapshot: PortableChatSnapshot,
  rowJsonWork: RepairRowJsonWork,
  trustRawCache: boolean,
): ChatReferenceAudit {
  const referenceKeys = referencedBubbleKeys(
    snapshot.composerId,
    snapshot.composerData,
    rowJsonWork,
  );
  if (referenceKeys.status === "unknown") {
    return {
      status: "unknown",
      reason: referenceKeys.reason,
    };
  }
  const references = referenceKeys.keys;
  const rows = new Map(snapshot.bubbles.map((row) => [row.key, row]));
  const unavailable: string[] = [];
  const usability = new Map<string, "usable" | "unusable">();
  for (const key of references) {
    const row = rows.get(key);
    if (row === undefined) {
      unavailable.push(key);
      continue;
    }
    const inspection = inspectPortableJsonRow(
      row,
      rowJsonWork,
      trustRawCache,
    );
    if (inspection.status === "unknown") {
      return { status: "unknown", reason: inspection.reason };
    }
    usability.set(key, inspection.status);
    if (inspection.status === "unusable") {
      unavailable.push(key);
    }
  }
  return {
    status: "known",
    referencedBubbleKeys: references,
    unavailableBubbleKeys: unavailable,
    fingerprint: referenceFingerprint(snapshot, references, rows, usability),
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
  const rowJsonWork = createRepairRowJsonWork();
  const localAudit = auditChatReferencesWithWork(local, rowJsonWork, false);
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
    let containsEveryUnavailable = true;
    for (const key of unavailable) {
      const row = rows.get(key);
      if (row === undefined) {
        containsEveryUnavailable = false;
        break;
      }
      const inspection = inspectPortableJsonRow(row, rowJsonWork, false);
      if (inspection.status === "unknown") {
        return { status: "unavailable", reason: inspection.reason };
      }
      if (inspection.status === "unusable") {
        containsEveryUnavailable = false;
        break;
      }
    }
    if (containsEveryUnavailable) {
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
      const newerInspection = newerRow === undefined
        ? undefined
        : inspectPortableJsonRow(newerRow, rowJsonWork, false);
      if (newerInspection?.status === "unknown") {
        return { status: "unavailable", reason: newerInspection.reason };
      }
      if (
        newerRow !== undefined &&
        selectedRow !== undefined &&
        newerInspection?.status === "usable" &&
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
      if (existing === undefined) {
        repairedRows.set(row.key, row);
        continue;
      }
      const existingInspection = inspectPortableJsonRow(
        existing,
        rowJsonWork,
        false,
      );
      if (existingInspection.status === "unknown") {
        return { status: "unavailable", reason: existingInspection.reason };
      }
      if (existingInspection.status === "unusable") {
        const rowInspection = inspectPortableJsonRow(row, rowJsonWork, false);
        if (rowInspection.status === "unknown") {
          return { status: "unavailable", reason: rowInspection.reason };
        }
        if (rowInspection.status === "usable") {
          repairedRows.set(row.key, row);
        }
      }
    }
  }
  for (const row of local.bubbles) {
    const inspection = inspectPortableJsonRow(row, rowJsonWork, false);
    if (inspection.status === "unknown") {
      return { status: "unavailable", reason: inspection.reason };
    }
    if (inspection.status === "usable" || !repairedRows.has(row.key)) {
      repairedRows.set(row.key, row);
    }
  }
  for (const key of unavailable) {
    const row = repairedRows.get(key);
    if (row === undefined) {
      return { status: "unavailable", reason: "a recovery row disappeared" };
    }
    const inspection = inspectPortableJsonRow(row, rowJsonWork, false);
    if (inspection.status === "unknown") {
      return { status: "unavailable", reason: inspection.reason };
    }
    if (inspection.status === "unusable") {
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
  const repairedAudit = auditChatReferencesWithWork(
    snapshot,
    rowJsonWork,
    false,
  );
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
  return (
    metadata?.syncOrigin === "automatic-chat-repair" ||
    (metadata?.syncOrigin === "checkpoint-marker" &&
      metadata.checkpointedSyncOrigin === "automatic-chat-repair")
  );
}

function referencedBubbleKeys(
  composerId: string,
  composerData: PortableKvRow,
  rowJsonWork: RepairRowJsonWork,
): ReferencedBubbleKeysResult {
  const inspection = inspectPortableJsonRow(
    composerData,
    rowJsonWork,
    false,
  );
  if (inspection.status === "unknown") {
    return inspection;
  }
  const value = inspection.status === "usable" ? inspection.value : undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: "unknown",
      reason: "composerData does not expose a recognized conversation header list",
    };
  }
  const headers = (value as Record<string, unknown>).fullConversationHeadersOnly;
  if (!Array.isArray(headers) || headers.length > 250_000) {
    return {
      status: "unknown",
      reason: "composerData does not expose a recognized conversation header list",
    };
  }
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of headers) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return {
        status: "unknown",
        reason: "composerData does not expose a recognized conversation header list",
      };
    }
    const bubbleId = (item as Record<string, unknown>).bubbleId;
    if (typeof bubbleId !== "string" || bubbleId.length === 0 || seen.has(bubbleId)) {
      return {
        status: "unknown",
        reason: "composerData does not expose a recognized conversation header list",
      };
    }
    seen.add(bubbleId);
    keys.push(`bubbleId:${composerId}:${bubbleId}`);
  }
  return { status: "known", keys };
}

function referenceFingerprint(
  snapshot: PortableChatSnapshot,
  references: readonly string[],
  rows: ReadonlyMap<string, PortableKvRow>,
  usability: ReadonlyMap<string, "usable" | "unusable">,
): string {
  return sha256(
    canonicalBytes({
      composerId: snapshot.composerId,
      composerData: snapshot.composerData,
      references: references.map((key) => {
        const row = rows.get(key);
        return row === undefined
          ? { key, state: "missing" }
          : usability.get(key) === "usable"
            ? { key, state: "usable", rowHash: sha256(canonicalBytes(row)) }
            : { key, state: "unreadable", rowHash: sha256(canonicalBytes(row)) };
      }),
    }),
  );
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

function sqliteNonnegativeNumber(value: SqliteStorageValue): number | null {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number >= 0
    ? number
    : null;
}

function normalizeBrokenChatInspectionLimits(
  options: BrokenChatInspectionOptions | undefined,
): Readonly<BrokenChatInspectionLimits> {
  const configured = options?.limits;
  return {
    maxRetainedChats: auditLimit(
      "maxRetainedChats",
      configured?.maxRetainedChats ??
        DEFAULT_BROKEN_CHAT_INSPECTION_LIMITS.maxRetainedChats,
      1,
    ),
    maxRetainedBytes: auditLimit(
      "maxRetainedBytes",
      configured?.maxRetainedBytes ??
        DEFAULT_BROKEN_CHAT_INSPECTION_LIMITS.maxRetainedBytes,
      1,
    ),
  };
}

function normalizeChatContinuationAuditLimits(
  options: ChatContinuationAuditOptions | undefined,
): Readonly<ChatContinuationAuditLimits> {
  const configured = options?.limits;
  return {
    maxChats: auditLimit(
      "maxChats",
      configured?.maxChats ?? DEFAULT_CHAT_CONTINUATION_AUDIT_LIMITS.maxChats,
      1,
    ),
    maxSnapshotBytesPerChat: auditLimit(
      "maxSnapshotBytesPerChat",
      configured?.maxSnapshotBytesPerChat ??
        DEFAULT_CHAT_CONTINUATION_AUDIT_LIMITS.maxSnapshotBytesPerChat,
      1,
    ),
    maxRootProbes: auditLimit(
      "maxRootProbes",
      configured?.maxRootProbes ??
        DEFAULT_CHAT_CONTINUATION_AUDIT_LIMITS.maxRootProbes,
      0,
    ),
    maxRootsPerChat: auditLimit(
      "maxRootsPerChat",
      configured?.maxRootsPerChat ??
        DEFAULT_CHAT_CONTINUATION_AUDIT_LIMITS.maxRootsPerChat,
      0,
    ),
    maxSeedBytesPerChat: auditLimit(
      "maxSeedBytesPerChat",
      configured?.maxSeedBytesPerChat ??
        DEFAULT_CHAT_CONTINUATION_AUDIT_LIMITS.maxSeedBytesPerChat,
      1,
    ),
    maxGraphDepth: auditLimit(
      "maxGraphDepth",
      configured?.maxGraphDepth ??
        DEFAULT_CHAT_CONTINUATION_AUDIT_LIMITS.maxGraphDepth,
      0,
    ),
    maxProtobufDepth: auditLimit(
      "maxProtobufDepth",
      configured?.maxProtobufDepth ??
        DEFAULT_CHAT_CONTINUATION_AUDIT_LIMITS.maxProtobufDepth,
      0,
    ),
  };
}

function auditLimit(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
