import type { DatabaseSync } from "../platform/sqlite";
import { openDatabase } from "../platform/sqlite";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type {
  LocalProjection,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  canonicalBytes,
  canonicalJson,
  isCanonicalBase64Text,
  sha256,
} from "../protocol/canonical";
import {
  buffersFitJsonStructureBudget,
  createJsonStructureBudget,
  JSON_STRUCTURE_MAX_DEPTH,
  PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
  type JsonStructureBudget,
} from "../protocol/jsonStructure";
import type {
  OversizedSnapshotSettlement,
  ResourceAdapter,
  ResourceApplyInput,
  ResourceScanStatus,
} from "../resources/resource";
import { lookupWorkspaceIdentitiesById } from "./workspace";
import { chatHeaderTitle } from "./title";
import {
  AGENT_KV_BLOB_PREFIX,
  walkAgentKvReachability,
  type AgentKvBlobLookupResult,
} from "./agentKv";
import {
  canonicalJsonStringByteLength,
  portableComposerHeaderCanonicalByteLength,
  updateCanonicalJsonString,
  updatePortableComposerHeaderHash,
} from "./headerCanonical";

export interface PortableComposerHeader {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  isArchived: number | null;
  isSubagent: number | null;
  recency: number | null;
  checkpointAt: number | null;
  value: string | null;
}

export interface PortableKvRow {
  key: string;
  valueBase64: string;
  /** SQLite storage class; absent in older snapshots, which are TEXT. */
  valueType?: "text" | "blob" | "null";
}

type SqliteRowValue = Uint8Array | string | number | bigint | null;

type RawComposerHeader = {
  composerId: SqliteRowValue;
  workspaceId: SqliteRowValue;
  createdAt: SqliteRowValue;
  lastUpdatedAt: SqliteRowValue;
  isArchived: SqliteRowValue;
  isSubagent: SqliteRowValue;
  recency: SqliteRowValue;
  checkpointAt: SqliteRowValue;
  value: SqliteRowValue;
};

/** Compact listing row: large TEXT/BLOB header fields never leave SQLite. */
type RawComposerHeaderMetadata = {
  composerId: SqliteRowValue;
  composerIdType: SqliteRowValue;
  composerIdBytes: SqliteRowValue;
  workspaceIdType: SqliteRowValue;
  workspaceIdBytes: SqliteRowValue;
  createdAt: SqliteRowValue;
  createdAtType: SqliteRowValue;
  lastUpdatedAt: SqliteRowValue;
  lastUpdatedAtType: SqliteRowValue;
  isArchived: SqliteRowValue;
  isArchivedType: SqliteRowValue;
  isSubagent: SqliteRowValue;
  isSubagentType: SqliteRowValue;
  recency: SqliteRowValue;
  recencyType: SqliteRowValue;
  checkpointAt: SqliteRowValue;
  checkpointAtType: SqliteRowValue;
  valueType: SqliteRowValue;
  valueBytes: SqliteRowValue;
};

type RawPagedComposerHeaderMetadata = RawComposerHeaderMetadata & {
  headerRowId: SqliteRowValue;
};

type RawBoundedComposerHeader = RawComposerHeader &
  RawComposerHeaderMetadata & {
    headerWithinBound: SqliteRowValue;
  };

type RawKvRow = {
  key: SqliteRowValue;
  value: SqliteRowValue;
  valueType: SqliteRowValue;
  valueBytes?: SqliteRowValue;
};

type RawKvMetadata = {
  key: SqliteRowValue;
  valueType: SqliteRowValue;
  valueBytes: SqliteRowValue;
};

type RawKvMetadataSummary = {
  total: SqliteRowValue;
  rawBytes: SqliteRowValue;
};

type ChatStatement = ReturnType<DatabaseSync["prepare"]>;

interface ChatStatements {
  header: ChatStatement;
  data: ChatStatement;
  dataMetadata: ChatStatement;
  bubbles: ChatStatement;
  bubbleMetadata: ChatStatement;
  bubbleMetadataSummary: ChatStatement;
  valueChunk: ChatStatement;
  bubbleCount: ChatStatement;
  agentKv: ChatStatement;
}

interface AgentKvScanBudget {
  remainingGraphCaptures: number;
  /** Slots ordinary first-time captures must leave for repair recaptures. */
  reservedRecaptureGraphCaptures: number;
  /** Fresh repositories reserve their two graph walks for recent chats. */
  initialGraphPriorityResourceIds: Set<string> | null;
}

interface ChatIdentity {
  /** Resolved UUID text, used for resource IDs and cursorDiskKV key prefixes. */
  composerId: string;
  /** The raw column value, used to bind the composerHeaders lookup. */
  headerKey: SqliteRowValue;
}

interface SettledChatScan {
  /** Main database plus WAL identity captured before the successful scan. */
  databaseFingerprint: string;
  /** Stable informational notices still need to remain visible to the UI. */
  notices: readonly string[];
}

interface DeepVerificationSweep {
  /** Last compact header row examined in this newest-first pass. */
  nextCursor: HeaderMetadataCursor | null;
  /** Settlements captured during this pass already prove their exact core. */
  startedAt: number;
  /** Last fingerprints observed, so new changes do not restart this pass. */
  databaseFingerprint: string;
}

interface BubbleCountAuditSweep {
  /** Cursor in the stable newest-first compact-header order. */
  nextCursor: HeaderMetadataCursor | null;
  /** A mutation during this pass requires one more complete pass. */
  needsAnotherPass: boolean;
  /** Last fingerprints observed, so changes queue a follow-up instead of restart. */
  databaseFingerprint: string;
}

interface CompletedBubbleCountAudit {
  databaseFingerprint: string;
}

interface HeaderMaterializationSweep {
  /** Last fully processed row in the stable newest-first metadata listing. */
  nextCursor: HeaderMetadataCursor | null;
  /** A mutation during the finite pass queues one fresh follow-up pass. */
  needsAnotherPass: boolean;
  databaseFingerprint: string;
}

interface HeaderMetadataCursor {
  rowId: number | bigint;
}

interface PendingChatSnapshot {
  semanticHash: string;
  /** Database generation from which the returned snapshot was captured. */
  databaseFingerprint: string;
  sourceTimestamp: number | null;
  sourceBubbleCount: number;
  sourceChatCoreHash: string;
  sourceHeaderFingerprint: string;
  sourceHeaderMetadataFingerprint: string;
  coreVerifiedAt: number;
  /**
   * Set only after the post-close fingerprint proves this exact capture came
   * from one stable database generation. Oversize acknowledgement is per item:
   * a later chat may still be deferred by the aggregate capture budget.
   */
  settleableDatabaseFingerprint?: string;
}

interface OversizedChatSettlement extends OversizedSnapshotSettlement {
  /** Stable DB generation whose exact core or bounded header proof exceeded policy. */
  databaseFingerprint: string;
  /** Header-only lower-bound settlements deliberately carry no fabricated core. */
  headerMetadataOnly: boolean;
  /** Per-chat identity survives unrelated writes elsewhere in state.vscdb. */
  sourceTimestamp: number | null;
  sourceBubbleCount: number;
  sourceChatCoreHash: string;
  sourceHeaderFingerprint: string;
  sourceHeaderMetadataFingerprint: string;
  coreVerifiedAt: number;
  /** Full header generation in which this exact local resource was observed. */
  observedHeaderGeneration: number;
}

interface OversizedSettlementOverflow {
  /** Number of exact settlements omitted in the last bounded pass so far. */
  omittedCount: number;
  /** Bounded examples for one aggregate standing warning. */
  sampleResourceIds: string[];
}

type ChatCapture =
  | { kind: "missing" }
  | {
      kind: "unchanged";
      notice?: string;
      /** The durable projection flag remains set for the next bounded pass. */
      agentKvRecaptureDeferred?: true;
    }
  | { kind: "incomplete" }
  | { kind: "pruned"; had: number; has: number }
  | {
      kind: "oversized";
      semanticHash: string;
      byteLength: number;
      header: PortableComposerHeader;
      bubbleCount: number;
      coreHash: string;
      /** Fixed live-work guard, rather than only configured payload policy. */
      warning?: string;
    }
  | {
      kind: "captured";
      snapshot: PortableChatSnapshot;
      coreHash: string;
      agentKvRecaptureAttempted?: boolean;
      notice?: string;
    };

interface PortableChatSnapshotBase {
  composerId: string;
  header: PortableComposerHeader;
  composerData: PortableKvRow;
  bubbles: PortableKvRow[];
}

export interface PortableChatSnapshotV1 extends PortableChatSnapshotBase {
  schemaVersion: 1;
}

/**
 * The content-addressed Cursor blobs reachable from this conversation.
 *
 * `referencedIds` is the complete reachability set observed by the capture.
 * It is partitioned exactly into materialized `blobs` and `missingIds`, which
 * lets a repository-side enrichment pass fill holes without guessing whether
 * a partial walk was meant to be complete.
 */
export interface PortableAgentKvPayload {
  blobs: PortableKvRow[];
  referencedIds: string[];
  missingIds: string[];
}

export interface PortableChatSnapshotV2 extends PortableChatSnapshotBase {
  schemaVersion: 2;
  agentKv: PortableAgentKvPayload;
}

export type PortableChatSnapshot =
  | PortableChatSnapshotV1
  | PortableChatSnapshotV2;

export interface StateVscdbChatAdapterOptions {
  /** Narrow performance-test seam; production leaves this undefined. */
  onBubbleCountProbe?: () => void;
  /** Narrow idle-fast-path test seam; production leaves this undefined. */
  onDatabaseOpen?: () => void;
  /** Narrow body-materialization test seam; production leaves this undefined. */
  onChatBodyCapture?: (resourceId: string) => void;
  /** Narrow full-snapshot allocation seam; production leaves this undefined. */
  onChatSnapshotMaterialize?: (resourceId: string) => void;
  /** Narrow oversized-core event-loop yield seam; production leaves undefined. */
  onChatCoreHashYield?: () => void;
  /** Narrow streamed-value read seam; production leaves this undefined. */
  onChatCoreValueChunkRead?: () => void;
  /** Narrow core-metadata iteration seam; production leaves this undefined. */
  onChatCoreMetadataRow?: () => void;
  /** Narrow guarded-header materialization seam; production leaves undefined. */
  onHeaderValueMaterialize?: (resourceId: string) => void;
  /** Narrow compact-row paging seam; production leaves this undefined. */
  onHeaderMetadataRow?: (
    phase: "header" | "bubble-count" | "deep-verification",
  ) => void;
  /** Narrow retained-state seam; production leaves this undefined. */
  onBubbleCountMismatchRetained?: (retainedCount: number) => void;
  /** Narrow retained-state seam; production leaves this undefined. */
  onOversizedSettlementRetained?: (retainedCount: number) => void;
  /** Narrow periodic-verification clock seam; production uses Date.now. */
  now?: () => number;
  /**
   * Fresh one-shot helper exports rely on header/count change detection and
   * must not start a full equal-count audit of every historical chat.
   */
  periodicDeepVerification?: boolean;
  /**
   * Exact incoming chat resources that the offline helper may overwrite.
   * They receive one bounded full-core verification even when Cursor kept the
   * same timestamp and bubble count, so a last-millisecond local edit is
   * published/conflicted before the queued write is considered.
   */
  forceCoreVerificationResourceIds?: readonly string[];
}

export function isPortableChatSnapshotV2(
  snapshot: PortableChatSnapshot,
): snapshot is PortableChatSnapshotV2 {
  return snapshot.schemaVersion === 2;
}

export type PortableChatConversationStateScan =
  | { status: "complete"; states: string[] }
  | { status: "structure-limit" };

export class ChatJsonStructureLimitError extends Error {}

/**
 * Extracts Cursor's serialized conversation-state roots from the exact core
 * rows in a portable snapshot. The field is schema-owned and top-level; a
 * recursive search for arbitrary `~...` strings would turn unrelated message
 * text into false reachability roots.
 */
export function portableChatConversationStates(
  snapshot: PortableChatSnapshot,
): string[] {
  const scan = scanPortableChatConversationStates(snapshot);
  if (scan.status === "structure-limit") {
    throw new Error(
      "Chat conversation-state JSON exceeds the fixed structural safety limit.",
    );
  }
  return scan.states;
}

/**
 * Distinguishes an ordinary malformed/non-JSON row from an otherwise compact
 * row whose JSON graph would exceed automatic parser allocation limits.
 */
export function scanPortableChatConversationStates(
  snapshot: PortableChatSnapshot,
): PortableChatConversationStateScan {
  const states: string[] = [];
  const budget = createJsonStructureBudget();
  if (!appendPortableConversationState(snapshot.composerData, budget, states)) {
    return { status: "structure-limit" };
  }
  for (const row of snapshot.bubbles) {
    if (!appendPortableConversationState(row, budget, states)) {
      return { status: "structure-limit" };
    }
  }
  return { status: "complete", states };
}

/**
 * Stable hash of the legacy/core-only chat representation. Repository
 * projections retain this separately from the v2 semantic hash so periodic
 * deep verification can prove the renderable core unchanged without walking
 * hundreds of MiB of immutable content-addressed blobs again.
 */
export function portableChatCoreHash(snapshot: PortableChatSnapshot): string {
  const hash = createHash("sha256");
  hash.update('{"bubbles":[');
  snapshot.bubbles.forEach((bubble, index) => {
    if (index > 0) {
      hash.update(",");
    }
    hash.update(canonicalJson(bubble));
  });
  hash.update('],"composerData":');
  hash.update(canonicalJson(snapshot.composerData));
  hash.update(',"composerId":');
  updateCanonicalJsonString(hash, snapshot.composerId);
  hash.update(',"header":');
  updatePortableComposerHeaderHash(hash, snapshot.header);
  hash.update(',"schemaVersion":1}');
  return hash.digest("hex");
}

function appendPortableConversationState(
  row: PortableKvRow,
  budget: JsonStructureBudget,
  states: string[],
): boolean {
  if (row.valueType === "null") {
    return true;
  }
  const bytes = Buffer.from(row.valueBase64, "base64");
  if (!budget.consume(bytes)) {
    return false;
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return true;
  }
  const state = conversationStateFromJsonText(text);
  if (state !== null) {
    states.push(state);
  }
  return true;
}

function conversationStateFromJsonText(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.hasOwn(parsed, "conversationState")
    ) {
      const state = (parsed as { conversationState?: unknown })
        .conversationState;
      return typeof state === "string" ? state : null;
    }
  } catch {
    // A non-JSON or independently corrupt bubble can still be preserved by
    // the legacy core snapshot. It simply contributes no agentKv root.
  }
  return null;
}

export class StateVscdbChatAdapter implements ResourceAdapter {
  readonly id = "state-vscdb-chat";
  readonly kinds = ["chat"] as const;
  readonly appliesWhileRunning = false;

  /** Last stable full header observation, whether or not it emitted work. */
  /** Observation eligible for the zero-SQLite idle shortcut. */
  private settledScan: SettledChatScan | null = null;
  /** Equal-count body verification, spread across bounded polling cycles. */
  private deepVerificationSweep: DeepVerificationSweep | null = null;
  /** Completed full-core passes are independent of unrelated WAL generations. */
  private nextDeepVerificationAt = 0;
  /** Last body capture attempted; changed/unprojected chats resume after it. */
  private bodyCaptureCursor: string | null = null;
  /** Finite exact-header pass, resumed under its own count/byte budget. */
  private headerMaterializationSweep: HeaderMaterializationSweep | null = null;
  /** Finite cheap count pass, resumed newest-first across bounded polls. */
  private bubbleCountAuditSweep: BubbleCountAuditSweep | null = null;
  /** Generation already covered by a complete cheap count pass. */
  private completedBubbleCountAudit: CompletedBubbleCountAudit | null = null;
  /** Count mismatches awaiting their bounded full-body capture. */
  private readonly pendingBubbleCountMismatches = new Set<string>();
  /** Snapshots returned to the manager but not yet reflected by `known`. */
  private readonly pendingSnapshots = new Map<string, PendingChatSnapshot>();
  /** Exact oversized snapshots deliberately filtered by the manager. */
  private readonly oversizedSettlements = new Map<
    string,
    OversizedChatSettlement
  >();
  /** Fail-closed marker when exact oversized identities exceed the fixed cap. */
  private oversizedSettlementOverflow: OversizedSettlementOverflow | null = null;
  /** Monotonic full-header generation used for bounded stale settlement cleanup. */
  private oversizedSettlementHeaderGeneration = 0;
  /** Omitted identities observed in the currently active full-header pass. */
  private activeOversizedSettlementOverflow: OversizedSettlementOverflow = {
    omittedCount: 0,
    sampleResourceIds: [],
  };
  /** Publish policy against which the lightweight settlements were made. */
  private maxPayloadBytes: number | null = null;
  /** Exact chats still waiting behind one of this adapter's bounded cursors. */
  private deferredResourceIds = new Set<string>();
  /**
   * Bounded per-resource repository identities. This preserves the useful
   * "known changed" signal without rebuilding/sorting every chat projection
   * on every 64-row SQLite page.
   */
  private readonly projectionFingerprintMemo = new Map<string, string>();
  /** O(1) invalidation when the repository swaps its projection view. */
  private lastKnownReference: Record<string, LocalProjection> | null = null;
  /** One-shot exact verifications requested by the offline helper. */
  private readonly forcedCoreVerificationResourceIds: Set<string>;
  /** Bounded newest-first graph preference learned once on a fresh adapter. */
  private initialGraphPriorityResourceIds: Set<string> | null = null;
  private initialGraphPriorityLoaded = false;

  constructor(
    private readonly paths: CursorPaths,
    private readonly options: StateVscdbChatAdapterOptions = {},
  ) {
    this.forcedCoreVerificationResourceIds = new Set(
      options.forceCoreVerificationResourceIds ?? [],
    );
  }

  setMaxPayloadBytes(maxPayloadBytes: number): void {
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
      throw new Error("The maximum payload size must be a positive safe integer.");
    }
    if (this.maxPayloadBytes === null) {
      this.maxPayloadBytes = maxPayloadBytes;
      return;
    }
    if (this.maxPayloadBytes === maxPayloadBytes) {
      return;
    }
    this.maxPayloadBytes = maxPayloadBytes;
    // The same bytes may be publishable under the new policy. Re-queue only
    // the lightweight identity: the next scan reconstructs from SQLite rather
    // than retaining a potentially hundreds-of-megabytes Buffer in memory.
    for (const [resourceId, settlement] of this.oversizedSettlements) {
      if (settlement.headerMetadataOnly) {
        continue;
      }
      this.pendingSnapshots.set(resourceId, {
        semanticHash: settlement.semanticHash,
        databaseFingerprint: settlement.databaseFingerprint,
        sourceTimestamp: settlement.sourceTimestamp,
        sourceBubbleCount: settlement.sourceBubbleCount,
        sourceChatCoreHash: settlement.sourceChatCoreHash,
        sourceHeaderFingerprint: settlement.sourceHeaderFingerprint,
        sourceHeaderMetadataFingerprint:
          settlement.sourceHeaderMetadataFingerprint,
        coreVerifiedAt: settlement.coreVerifiedAt,
      });
    }
    this.oversizedSettlements.clear();
    this.options.onOversizedSettlementRetained?.(0);
    this.headerMaterializationSweep = null;
    this.settledScan = null;
  }

  settleOversizedSnapshot(
    snapshot: ResourceSnapshot,
    maxPayloadBytes: number,
  ): boolean {
    this.setMaxPayloadBytes(maxPayloadBytes);
    if (
      snapshot.kind !== "chat" ||
      snapshot.content.byteLength <= maxPayloadBytes
    ) {
      return false;
    }
    return this.settlePendingOversizedSnapshot(
      snapshot.resourceId,
      snapshot.semanticHash,
      snapshot.content.byteLength,
      maxPayloadBytes,
    );
  }

  private settlePendingOversizedSnapshot(
    resourceId: string,
    semanticHash: string,
    byteLength: number,
    maxPayloadBytes: number,
    warning?: string,
  ): boolean {
    const pending = this.pendingSnapshots.get(resourceId);
    if (
      pending === undefined ||
      pending.semanticHash !== semanticHash ||
      pending.settleableDatabaseFingerprint !== pending.databaseFingerprint
    ) {
      return false;
    }
    this.retainOversizedSettlement({
      resourceId,
      semanticHash,
      byteLength,
      maxPayloadBytes,
      ...(warning === undefined ? {} : { warning }),
      databaseFingerprint: pending.databaseFingerprint,
      headerMetadataOnly: false,
      sourceTimestamp: pending.sourceTimestamp,
      sourceBubbleCount: pending.sourceBubbleCount,
      sourceChatCoreHash: pending.sourceChatCoreHash,
      sourceHeaderFingerprint: pending.sourceHeaderFingerprint,
      sourceHeaderMetadataFingerprint:
        pending.sourceHeaderMetadataFingerprint,
      coreVerifiedAt: pending.coreVerifiedAt,
      observedHeaderGeneration: this.oversizedSettlementHeaderGeneration,
    });
    this.pendingSnapshots.delete(resourceId);
    // The completed item capture already proved both fingerprints stable. The
    // whole scan may still have deferred another large chat, so it is not safe
    // to depend on (or synthesize) a globally settled scan here.
    return true;
  }

  oversizedSnapshotSettlements(
    maxPayloadBytes: number,
  ): readonly OversizedSnapshotSettlement[] {
    if (this.maxPayloadBytes !== maxPayloadBytes) {
      return [];
    }
    const sorted = [...this.oversizedSettlements.values()]
      .sort((left, right) =>
        left.resourceId < right.resourceId
          ? -1
          : left.resourceId > right.resourceId
            ? 1
            : 0,
      );
    const overflow = this.oversizedSettlementOverflow;
    const visible =
      overflow === null
        ? sorted
        : sorted.slice(0, MAX_CHAT_OVERSIZED_WARNING_SAMPLES);
    const settlements = visible.map(
      ({
        databaseFingerprint: _databaseFingerprint,
        headerMetadataOnly: _headerMetadataOnly,
        sourceTimestamp: _sourceTimestamp,
        sourceBubbleCount: _sourceBubbleCount,
        sourceChatCoreHash: _sourceChatCoreHash,
        sourceHeaderFingerprint: _sourceHeaderFingerprint,
        sourceHeaderMetadataFingerprint: _sourceHeaderMetadataFingerprint,
        coreVerifiedAt: _coreVerifiedAt,
        observedHeaderGeneration: _observedHeaderGeneration,
        ...settlement
      }) => settlement,
    );
    if (overflow === null) {
      return settlements;
    }
    const representedCount =
      this.oversizedSettlements.size + overflow.omittedCount;
    const examples = overflow.sampleResourceIds.join(", ");
    settlements.push({
      resourceId: CHAT_OVERSIZED_SETTLEMENT_OVERFLOW_RESOURCE_ID,
      semanticHash: sha256(
        `oversized-settlement-overflow-v1\0${representedCount}\0${examples}`,
      ),
      byteLength: maxPayloadBytes + 1,
      maxPayloadBytes,
      warning:
        `At least ${representedCount} local chat snapshots exceed the active ` +
        `capture or repository limit. Only ${MAX_CHAT_OVERSIZED_SETTLEMENTS} ` +
        `exact settlements are retained; ${overflow.omittedCount} additional ` +
        `chat(s) are represented by this aggregate warning` +
        (examples.length === 0 ? "." : ` (examples: ${examples}).`) +
        " Chat synchronization remains incomplete until a stable full pass fits within the bound.",
    });
    return settlements;
  }

  scanStatus(): ResourceScanStatus {
    const deferred = new Set(this.deferredResourceIds);
    for (const resourceId of this.forcedCoreVerificationResourceIds) {
      deferred.add(resourceId);
    }
    for (const resourceId of this.pendingSnapshots.keys()) {
      deferred.add(resourceId);
    }
    for (const resourceId of this.pendingBubbleCountMismatches) {
      deferred.add(resourceId);
    }
    if (this.oversizedSettlementOverflow !== null) {
      for (const resourceId of this.oversizedSettlements.keys()) {
        deferred.add(resourceId);
      }
      deferred.add(CHAT_OVERSIZED_SETTLEMENT_OVERFLOW_RESOURCE_ID);
    }
    return {
      complete:
        deferred.size === 0 &&
        this.oversizedSettlementOverflow === null &&
        this.bubbleCountAuditSweep === null &&
        this.headerMaterializationSweep === null,
      deferredResourceIds: [...deferred].sort(),
    };
  }

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const knownReferenceChanged = this.lastKnownReference !== known;
    this.lastKnownReference = known;
    const databaseFingerprint = await stateVscdbFingerprint(
      this.paths.globalDatabase,
    );
    for (const [resourceId, settlement] of this.oversizedSettlements) {
      const projection = known[resourceId];
      const representedByRepository =
        projection?.kind === "chat" &&
        (projection.semanticHash === settlement.semanticHash ||
          projection.retainedLocalHash === settlement.semanticHash);
      if (representedByRepository) {
        this.oversizedSettlements.delete(resourceId);
        this.settledScan = null;
      }
    }
    const acknowledgedPendingSnapshots = new Set<string>();
    for (const [resourceId, pending] of this.pendingSnapshots) {
      const projection = known[resourceId];
      if (
        projection?.kind === "chat" &&
        (projection.semanticHash === pending.semanticHash ||
          projection.retainedLocalHash === pending.semanticHash)
      ) {
        acknowledgedPendingSnapshots.add(resourceId);
        this.pendingSnapshots.delete(resourceId);
      }
    }
    const settledScan = this.settledScan;
    const now = this.options.now?.() ?? Date.now();
    const periodicDeepVerification =
      this.options.periodicDeepVerification !== false;
    const deepVerificationBatchDue =
      periodicDeepVerification && now >= this.nextDeepVerificationAt;
    if (
      this.pendingSnapshots.size === 0 &&
      this.pendingBubbleCountMismatches.size === 0 &&
      this.forcedCoreVerificationResourceIds.size === 0 &&
      this.bubbleCountAuditSweep === null &&
      this.headerMaterializationSweep === null &&
      !deepVerificationBatchDue &&
      !knownReferenceChanged &&
      settledScan?.databaseFingerprint === databaseFingerprint
    ) {
      // A successful settled scan produced neither snapshots nor deletions. If
      // neither side of that comparison moved, repeating synchronous SQLite
      // work cannot produce a different answer. In particular this avoids
      // waking a multi-gigabyte state.vscdb every thirty seconds while Cursor
      // is idle. Notices are repeated because the standing-notice registry
      // expects adapters to keep reporting conditions that remain true.
      this.deferredResourceIds.clear();
      return {
        snapshots: [],
        deletions: [],
        warnings: [],
        notices: [...settledScan.notices],
      };
    }
    // A scan that is about to touch SQLite invalidates the idle shortcut. The
    // last stable observation remains available for narrow header/projection
    // comparisons even when the preceding scan emitted a snapshot.
    this.settledScan = null;
    if (
      periodicDeepVerification &&
      this.deepVerificationSweep === null &&
      deepVerificationBatchDue
    ) {
      this.deepVerificationSweep = {
        nextCursor: null,
        startedAt: now,
        databaseFingerprint,
      };
    }
    const completedBubbleCountAudit = this.completedBubbleCountAudit;
    if (
      this.bubbleCountAuditSweep === null &&
      completedBubbleCountAudit?.databaseFingerprint !== databaseFingerprint
    ) {
      this.bubbleCountAuditSweep = {
        nextCursor: null,
        needsAnotherPass: false,
        databaseFingerprint,
      };
    }
    const activeSweep = this.deepVerificationSweep;
    if (
      activeSweep !== null &&
      activeSweep.databaseFingerprint !== databaseFingerprint
    ) {
      // Keep the current round-robin position. Header changes and count
      // mismatches are handled immediately; equal-count core verification is
      // periodic, so unrelated WAL churn must not queue another full pass.
      activeSweep.databaseFingerprint = databaseFingerprint;
    }
    const activeBubbleCountSweep = this.bubbleCountAuditSweep;
    if (
      activeBubbleCountSweep !== null &&
      activeBubbleCountSweep.databaseFingerprint !== databaseFingerprint
    ) {
      activeBubbleCountSweep.needsAnotherPass = true;
      activeBubbleCountSweep.databaseFingerprint = databaseFingerprint;
    }
    if (this.headerMaterializationSweep === null) {
      this.beginOversizedSettlementHeaderGeneration();
      this.headerMaterializationSweep = {
        nextCursor: null,
        needsAnotherPass: false,
        databaseFingerprint,
      };
    }
    const activeHeaderSweep = this.headerMaterializationSweep;
    if (
      activeHeaderSweep.databaseFingerprint !== databaseFingerprint
    ) {
      activeHeaderSweep.needsAnotherPass = true;
      activeHeaderSweep.databaseFingerprint = databaseFingerprint;
    }
    this.options.onDatabaseOpen?.();
    const database = openDatabase(this.paths.globalDatabase, { readOnly: true });
    const snapshots: ResourceSnapshot[] = [];
    const deferredResourceIds = new Set<string>();
    const oversizedCandidates = new Map<
      string,
      {
        semanticHash: string;
        byteLength: number;
        maxPayloadBytes: number;
        warning?: string;
      }
    >();
    const headerOversizedCandidates = new Map<
      string,
      {
        semanticHash: string;
        byteLength: number;
        maxPayloadBytes: number;
        warning?: string;
        sourceTimestamp: number | null;
        sourceHeaderFingerprint: string;
      }
    >();
    const warnings: string[] = [];
    const notices: string[] = [];
    const bodyless: string[] = [];
    const pruned: string[] = [];
    const nonReconstructablePendingSnapshots = new Set<string>();
    const completedForcedVerifications = new Set<string>();
    let identityUnknown = false;
    let headerPageReachedEnd: boolean;
    let headerLastProcessedCursor = activeHeaderSweep.nextCursor;
    let bubblePageReachedEnd = activeBubbleCountSweep === null;
    let bubbleNextCursor = activeBubbleCountSweep?.nextCursor ?? null;
    let deepPageReachedEnd: boolean;
    let deepNextCursor = activeSweep?.nextCursor ?? null;
    let deepVerificationBatchCompleted: boolean;
    let headerSweepEndIndex = 0;
    let captureWorkDeferred = false;
    try {
      // Cursor writes to this database while it runs; wait out short lock
      // bursts instead of failing the whole sync cycle with SQLITE_BUSY.
      database.exec("PRAGMA busy_timeout=2000");
      database.exec("PRAGMA query_only=ON");
      if (!this.initialGraphPriorityLoaded) {
        this.initialGraphPriorityResourceIds =
          readInitialGraphPriorityResourceIds(database);
        this.initialGraphPriorityLoaded = true;
      }
      // Every listing is deliberately metadata-only and keyset-paged. Cursor
      // normally keeps this table small, but imported/corrupt histories can
      // contain tens of thousands of headers. The old unbounded `.all()` plus
      // JavaScript sort retained every row before any body/header budget could
      // run. SQL now follows SQLite's indexed rowid in fixed pages for each
      // persistent sweep. A separate one-shot recent-row window above reserves
      // the two graph slots; routine audit pages never sort the whole table.
      //
      // Do not filter isSubagent in SQL. An invalid/oversized value in that
      // column must remain visible so its resource ID is kept current instead
      // of being mistaken for an absent chat and published as a tombstone.
      const headers = readComposerHeaderMetadataPage(
        database,
        activeHeaderSweep.nextCursor,
        "header",
        this.options.onHeaderMetadataRow,
      );
      for (const rawHeader of headers) {
        const composerId = composerIdText(rawHeader.composerId);
        if (composerId === null) {
          identityUnknown = true;
          continue;
        }
        if (headerIsMainComposer(rawHeader) !== false) {
          // Compact listing metadata is sufficient proof of existence. Chat
          // resources are additive-only, so partial identity pages never emit
          // tombstones and do not need an O(total chats) identity set.
        }
      }
      if (identityUnknown) {
        warnings.push(
          "Skipped a composer header whose composerId is neither text nor a UTF-8 encoded chat ID; no chat deletions are published from this scan.",
        );
      }

      const deepHeaders =
        activeSweep === null || !deepVerificationBatchDue
          ? []
          : readComposerHeaderMetadataPage(
              database,
              activeSweep.nextCursor,
              "deep-verification",
              this.options.onHeaderMetadataRow,
            );
      const deepVerificationIds = new Set<string>();
      let deepRowsExamined = 0;
      for (const rawHeader of deepHeaders) {
        deepRowsExamined += 1;
        deepNextCursor = headerMetadataCursor(rawHeader);
        const composerId = composerIdText(rawHeader.composerId);
        if (
          composerId !== null &&
          COMPOSER_ID_PATTERN.test(composerId) &&
          headerIsMainComposer(rawHeader) === true
        ) {
          deepVerificationIds.add(`chat/${composerId}`);
          if (deepVerificationIds.size >= DEEP_VERIFICATION_BATCH_SIZE) {
            break;
          }
        }
      }
      deepPageReachedEnd =
        deepRowsExamined === deepHeaders.length &&
        deepHeaders.length < MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE;
      const processedDeepVerificationIds = new Set<string>();
      const bubbleAuditCandidates: Array<{
        composerId: string;
        resourceId: string;
        expectedBubbleCount: number;
      }> = [];
      const bubbleAuditCapacity = Math.min(
        MAX_CHAT_BUBBLE_COUNT_PROBES_PER_SCAN,
        MAX_CHAT_PENDING_BUBBLE_COUNT_MISMATCHES -
          this.pendingBubbleCountMismatches.size,
      );
      const bubbleHeaders =
        activeBubbleCountSweep === null || bubbleAuditCapacity === 0
          ? []
          : readComposerHeaderMetadataPage(
              database,
              activeBubbleCountSweep.nextCursor,
              "bubble-count",
              this.options.onHeaderMetadataRow,
            );
      let bubbleRowsExamined = 0;
      if (activeBubbleCountSweep !== null && bubbleAuditCapacity > 0) {
        for (const rawHeader of bubbleHeaders) {
          bubbleRowsExamined += 1;
          bubbleNextCursor = headerMetadataCursor(rawHeader);
          const composerId = composerIdText(rawHeader.composerId);
          if (
            composerId === null ||
            !COMPOSER_ID_PATTERN.test(composerId) ||
            headerIsMainComposer(rawHeader) !== true
          ) {
            continue;
          }
          const resourceId = `chat/${composerId}`;
          const projection = known[resourceId];
          const settlement = this.oversizedSettlements.get(resourceId);
          if (settlement?.headerMetadataOnly) {
            continue;
          }
          const listedTimestamp = plainNumber(rawHeader.lastUpdatedAt);
          const priorityBodyRead =
            this.pendingSnapshots.has(resourceId) ||
            this.pendingBubbleCountMismatches.has(resourceId) ||
            (settlement === undefined &&
              (this.forcedCoreVerificationResourceIds.has(resourceId) ||
                projection?.requiresAgentKvRecapture === true));
          const sourceTimestamp =
            settlement?.sourceTimestamp ??
            (projection?.kind === "chat"
              ? projection.sourceTimestamp
              : undefined);
          const sourceBubbleCount =
            settlement?.sourceBubbleCount ??
            (projection?.kind === "chat"
              ? projection.sourceBubbleCount
              : undefined);
          const sourceHeaderMatches =
            settlement !== undefined
              ? settlement.sourceTimestamp === listedTimestamp
              : listedTimestamp !== null &&
                projection?.kind === "chat" &&
                sourceTimestamp === listedTimestamp;
          if (
            priorityBodyRead ||
            !sourceHeaderMatches ||
            typeof sourceBubbleCount !== "number"
          ) {
            continue;
          }
          bubbleAuditCandidates.push({
            composerId,
            resourceId,
            expectedBubbleCount: sourceBubbleCount,
          });
          if (bubbleAuditCandidates.length >= bubbleAuditCapacity) {
            break;
          }
        }
        bubblePageReachedEnd =
          bubbleRowsExamined === bubbleHeaders.length &&
          bubbleHeaders.length < MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE;
      }
      const headerSweepHeaders = headers;
      const headerSweepStartIndex = 0;
      const statements: ChatStatements = {
        header: database.prepare(BOUNDED_COMPOSER_HEADER_SQL),
        data: database.prepare(
          "SELECT key, value, typeof(value) AS valueType FROM cursorDiskKV WHERE key = ?",
        ),
        dataMetadata: database.prepare(
          "SELECT key, typeof(value) AS valueType, length(CAST(value AS BLOB)) AS valueBytes " +
            "FROM cursorDiskKV WHERE key = ?",
        ),
        bubbles: database.prepare(
          "SELECT key, value, typeof(value) AS valueType FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key",
        ),
        bubbleMetadata: database.prepare(
          "SELECT key, typeof(value) AS valueType, length(CAST(value AS BLOB)) AS valueBytes " +
            "FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key",
        ),
        bubbleMetadataSummary: database.prepare(
          "SELECT COUNT(*) AS total, " +
            "COALESCE(SUM(length(CAST(key AS BLOB)) + " +
            "COALESCE(length(CAST(value AS BLOB)), 0)), 0) AS rawBytes " +
            "FROM cursorDiskKV WHERE key >= ? AND key < ?",
        ),
        valueChunk: database.prepare(
          "SELECT substr(CAST(value AS BLOB), ?, ?) AS value " +
            "FROM cursorDiskKV WHERE key = ?",
        ),
        bubbleCount: database.prepare(
          "SELECT COUNT(*) AS total FROM (" +
            "SELECT 1 FROM cursorDiskKV WHERE key >= ? AND key < ? LIMIT ?" +
            ")",
        ),
        agentKv: database.prepare(
          "SELECT key, " +
            "CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value ELSE NULL END AS value, " +
            "typeof(value) AS valueType, length(CAST(value AS BLOB)) AS valueBytes " +
            "FROM cursorDiskKV WHERE key = ?",
        ),
      };
      for (const candidate of bubbleAuditCandidates) {
        const observedBubbleCount = currentBubbleCount(
          statements.bubbleCount,
          candidate.composerId,
          this.options.onBubbleCountProbe,
        );
        if (observedBubbleCount !== candidate.expectedBubbleCount) {
          this.retainBubbleCountMismatch(candidate.resourceId);
        }
      }
      const agentKvBudget: AgentKvScanBudget = {
        remainingGraphCaptures: MAX_AGENT_KV_GRAPH_CAPTURES_PER_SCAN,
        reservedRecaptureGraphCaptures: Math.min(
          MAX_AGENT_KV_GRAPH_CAPTURES_PER_SCAN,
          headers.reduce((count, rawHeader) => {
            const composerId = composerIdText(rawHeader.composerId);
            return composerId !== null &&
              known[`chat/${composerId}`]?.requiresAgentKvRecapture === true
              ? count + 1
              : count;
          }, 0),
        ),
        initialGraphPriorityResourceIds:
          this.initialGraphPriorityResourceIds,
      };
      let bodyCaptureAttempts = 0;
      let retainedSnapshotBytes = 0;
      let bodyCaptureBudgetExhausted = false;
      let lastCompletedBodyCapture = this.bodyCaptureCursor;
      let headerMaterializationCount = 0;
      let headerMaterializationBytes = 0;
      for (
        let headerIndex = headerSweepStartIndex;
        headerIndex < headerSweepHeaders.length;
        headerIndex += 1
      ) {
        headerSweepEndIndex = headerIndex + 1;
        const rawHeader = headerSweepHeaders[headerIndex]!;
        const composerId = composerIdText(rawHeader.composerId);
        if (composerId === null) {
          continue;
        }
        const resourceId = `chat/${composerId}`;
        const headerKind = headerIsMainComposer(rawHeader);
        if (headerKind === false) {
          // A valid non-zero isSubagent row is intentionally outside the
          // portable chat set, matching the old SQL predicate.
          continue;
        }
        // A composer whose ID is not a chat ID cannot be synchronized at all:
        // `parsePortableChatSnapshot` is the apply-side gate as well, so every
        // device that received one would reject it. Publishing it anyway cost
        // an event, a payload object, a permanently pending change and — once
        // the other machine published its own copy — a conflict that no
        // automatic path could resolve and no person could adjudicate. Cursor
        // keeps at least one of these permanently (`empty-state-draft`).
        //
        // It stays in `current` so it is never published as a deletion: a
        // tombstone would be a claim about the resource rather than silence
        // about it, and this build simply has nothing to say.
        if (!COMPOSER_ID_PATTERN.test(composerId)) {
          continue;
        }
        // The complete header listing proves this resource currently exists.
        // A per-scan body budget may defer its snapshot, but that must never be
        // mistaken for absence and turned into a destructive tombstone.
        if (headerKind === null) {
          warnings.push(
            `Skipped chat ${composerId}: composerHeaders.isSubagent has an unsupported SQLite value; the chat remains current and no tombstone is published.`,
          );
          if (deepVerificationIds.has(resourceId)) {
            processedDeepVerificationIds.add(resourceId);
          }
          continue;
        }
        const projection = known[resourceId];
        let settlement = this.oversizedSettlements.get(resourceId);
        let metadata: HeaderMetadataPreflight;
        try {
          metadata = preflightHeaderMetadata(rawHeader, composerId);
        } catch (error) {
          warnings.push(
            `Skipped chat ${composerId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (deepVerificationIds.has(resourceId)) {
            processedDeepVerificationIds.add(resourceId);
          }
          continue;
        }
        const listedTimestamp = metadata.header.lastUpdatedAt;
        const maxPayloadBytes = this.maxPayloadBytes;
        const headerMaterializationLimit = Math.min(
          maxPayloadBytes ?? MAX_UNCONFIGURED_HEADER_MATERIALIZE_BYTES,
          MAX_CHAT_INTERACTIVE_CAPTURE_BYTES,
        );
        if (
          maxPayloadBytes !== null &&
          metadata.canonicalByteLowerBound > headerMaterializationLimit
        ) {
          const headerFingerprint = metadata.fingerprint;
          const semanticHash = sha256(
            `oversized-header-metadata-v1\0${resourceId}\0${headerFingerprint}`,
          );
          const byteLength = Math.max(
            headerMaterializationLimit + 1,
            metadata.canonicalByteLowerBound,
          );
          headerOversizedCandidates.set(resourceId, {
            semanticHash,
            byteLength,
            maxPayloadBytes: headerMaterializationLimit,
            ...(headerMaterializationLimit < maxPayloadBytes
              ? {
                  warning: interactiveChatCaptureWarning(
                    resourceId,
                    byteLength,
                  ),
                }
              : {}),
            sourceTimestamp: listedTimestamp,
            sourceHeaderFingerprint: headerFingerprint,
          });
          if (
            settlement === undefined ||
            !settlement.headerMetadataOnly ||
            settlement.sourceHeaderFingerprint !== headerFingerprint
          ) {
            this.oversizedSettlements.delete(resourceId);
            settlement = undefined;
          }
          this.pendingSnapshots.delete(resourceId);
          this.pendingBubbleCountMismatches.delete(resourceId);
          if (deepVerificationIds.has(resourceId)) {
            processedDeepVerificationIds.add(resourceId);
          }
          lastCompletedBodyCapture = resourceId;
          continue;
        }
        if (
          metadata.canonicalByteLowerBound > headerMaterializationLimit
        ) {
          warnings.push(
            `Skipped chat ${composerId}: its header exceeds the bounded ${headerMaterializationLimit}-byte live-scan safety limit. Configure a repository payload limit before scanning it.`,
          );
          if (deepVerificationIds.has(resourceId)) {
            processedDeepVerificationIds.add(resourceId);
          }
          continue;
        }
        if (settlement?.headerMetadataOnly) {
          this.oversizedSettlements.delete(resourceId);
          settlement = undefined;
        }
        const deepVerificationRequired =
          deepVerificationIds.has(resourceId) &&
          (activeSweep === null ||
            settlement === undefined ||
            settlement.coreVerifiedAt < activeSweep.startedAt);
        const exactCoreVerificationRequired =
          settlement === undefined &&
          (this.forcedCoreVerificationResourceIds.has(resourceId) ||
            projection?.requiresAgentKvRecapture === true);
        if (
          settlement !== undefined &&
          settlement.sourceHeaderMetadataFingerprint ===
            metadata.fingerprint &&
          settlement.sourceTimestamp === listedTimestamp &&
          !deepVerificationRequired &&
          !this.pendingSnapshots.has(resourceId) &&
          !this.pendingBubbleCountMismatches.has(resourceId)
        ) {
          settlement.observedHeaderGeneration =
            this.oversizedSettlementHeaderGeneration;
          if (this.forcedCoreVerificationResourceIds.has(resourceId)) {
            completedForcedVerifications.add(resourceId);
          }
          continue;
        }
        const aggregateHeaderBytes =
          headerMaterializationBytes + metadata.materializationBytes;
        if (
          headerMaterializationCount >=
            MAX_CHAT_HEADER_MATERIALIZATIONS_PER_SCAN ||
          (headerMaterializationCount > 0 &&
            aggregateHeaderBytes > MAX_CHAT_HEADER_BYTES_PER_SCAN)
        ) {
          headerSweepEndIndex = headerIndex;
          captureWorkDeferred = true;
          for (const deferredHeader of headerSweepHeaders.slice(headerIndex)) {
            const deferredComposerId = composerIdText(
              deferredHeader.composerId,
            );
            if (
              deferredComposerId !== null &&
              COMPOSER_ID_PATTERN.test(deferredComposerId) &&
              headerIsMainComposer(deferredHeader) === true
            ) {
              deferredResourceIds.add(`chat/${deferredComposerId}`);
            }
          }
          break;
        }
        headerMaterializationCount += 1;
        headerMaterializationBytes = aggregateHeaderBytes;
        let boundedHeader: PortableComposerHeader;
        try {
          this.options.onHeaderValueMaterialize?.(resourceId);
          boundedHeader = readBoundedHeader(
            statements.header,
            rawHeader.composerId,
            composerId,
            headerMaterializationLimit,
          );
        } catch (error) {
          warnings.push(
            `Skipped chat ${composerId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (deepVerificationIds.has(resourceId)) {
            processedDeepVerificationIds.add(resourceId);
          }
          continue;
        }
        const headerFingerprint = portableHeaderFingerprint(boundedHeader);
        if (
          projection?.kind === "chat" &&
          projection.sourceHeaderFingerprint === undefined &&
          listedTimestamp !== null &&
          projection.sourceTimestamp === listedTimestamp &&
          typeof projection.sourceBubbleCount === "number"
        ) {
          // Upgrade an old projection with the small header baseline in place.
          // A queued overwrite is still protected by forced full-core
          // verification; learning here avoids a one-time full-body read of
          // every historical chat merely for the new optimization field.
          projection.sourceHeaderFingerprint = headerFingerprint;
        }
        const projectionChangedSinceObserved =
          !acknowledgedPendingSnapshots.has(resourceId) &&
          this.observeProjectionFingerprint(resourceId, projection);
        if (acknowledgedPendingSnapshots.has(resourceId)) {
          // Still refresh the bounded memo to the acknowledged repository
          // form; only the expensive body read is suppressed.
          this.observeProjectionFingerprint(resourceId, projection);
        }
        // Only a timestamp that is a real number carries change information, and
        // the projection has to already be a chat for the comparison to mean
        // anything. Anything else falls through to the transactional capture,
        // which is where the authoritative comparison still lives.
        if (
          deepVerificationIds.has(resourceId) &&
          !deepVerificationRequired
        ) {
          processedDeepVerificationIds.add(resourceId);
        }
        const headerChangedSinceProjection =
          settlement !== undefined
            ? settlement.sourceHeaderFingerprint !== headerFingerprint
            : projection?.kind === "chat" &&
              projection.sourceHeaderFingerprint !== headerFingerprint;
        const bodyMustBeRead =
          this.pendingSnapshots.has(resourceId) ||
          this.pendingBubbleCountMismatches.has(resourceId) ||
          exactCoreVerificationRequired ||
          deepVerificationRequired ||
          projectionChangedSinceObserved ||
          headerChangedSinceProjection;
        const sourceTimestamp =
          settlement?.sourceTimestamp ??
          (projection?.kind === "chat" ? projection.sourceTimestamp : undefined);
        const sourceBubbleCount =
          settlement?.sourceBubbleCount ??
          (projection?.kind === "chat"
            ? projection.sourceBubbleCount
            : undefined);
        const sourceHeaderMatches =
          settlement !== undefined
            ? settlement.sourceHeaderFingerprint === headerFingerprint &&
              settlement.sourceTimestamp === listedTimestamp
            : listedTimestamp !== null &&
              projection?.kind === "chat" &&
              sourceTimestamp === listedTimestamp &&
              projection.sourceHeaderFingerprint === headerFingerprint;
        // Cursor usually advances lastUpdatedAt with a header edit, but not for
        // every column in every release. A changed row fingerprint must
        // therefore fall through to the transactional capture even if its
        // timestamp and bubble count still match the projection.
        if (
          !bodyMustBeRead &&
          sourceHeaderMatches &&
          typeof sourceBubbleCount === "number"
        ) {
          continue;
        }
        if (
          bodyCaptureBudgetExhausted ||
          bodyCaptureAttempts >= MAX_CHAT_BODY_CAPTURES_PER_SCAN
        ) {
          bodyCaptureBudgetExhausted = true;
          captureWorkDeferred = true;
          headerSweepEndIndex = headerIndex;
          for (const deferredHeader of headerSweepHeaders.slice(headerIndex)) {
            const deferredComposerId = composerIdText(
              deferredHeader.composerId,
            );
            if (
              deferredComposerId !== null &&
              COMPOSER_ID_PATTERN.test(deferredComposerId) &&
              headerIsMainComposer(deferredHeader) === true
            ) {
              deferredResourceIds.add(`chat/${deferredComposerId}`);
            }
          }
          break;
        }
        bodyCaptureAttempts += 1;
        const deepVerification = deepVerificationRequired;
        this.options.onChatBodyCapture?.(resourceId);
        let captured: ChatCapture;
        try {
          captured = await captureChat(
            database,
            statements,
            { composerId, headerKey: rawHeader.composerId },
            settlementProjection(resourceId, projection, settlement),
            agentKvBudget,
            headerMaterializationLimit,
            headerMaterializationLimit,
            bodyMustBeRead,
            this.options.onChatSnapshotMaterialize,
            this.options.onBubbleCountProbe,
            this.options.onChatCoreHashYield,
            this.options.onChatCoreValueChunkRead,
            this.options.onChatCoreMetadataRow,
          );
          // Deep verification can materialize several megabytes of SQLite
          // text and canonical JSON for one conversation. Yield between those
          // exceptional body reads so the shared extension host can service
          // Cursor and the other extensions instead of appearing frozen for
          // one long synchronous burst.
          if (bodyMustBeRead) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } catch (error) {
          // One unusable row must never take the whole adapter down. The
          // resource stays in `current` so it is not published as a deletion.
          warnings.push(
            `Skipped chat ${composerId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          lastCompletedBodyCapture = resourceId;
          if (deepVerification) {
            processedDeepVerificationIds.add(resourceId);
          }
          continue;
        }
        if (deepVerification) {
          processedDeepVerificationIds.add(resourceId);
        }
        if (captured.kind === "missing") {
          this.oversizedSettlements.delete(resourceId);
          this.pendingBubbleCountMismatches.delete(resourceId);
          lastCompletedBodyCapture = resourceId;
          continue;
        }
        if ("notice" in captured && captured.notice !== undefined) {
          notices.push(`${composerId}: ${captured.notice}`);
        }
        if (captured.kind === "unchanged") {
          if (captured.agentKvRecaptureDeferred === true) {
            // No graph slot was available after honoring earlier durable
            // repair requests. Keep this exact ID outstanding and leave the
            // metadata/body cursor before it, so the next bounded pass reaches it first
            // instead of publishing a v1 fallback that clears the one-shot.
            captureWorkDeferred = true;
            headerSweepEndIndex = headerIndex;
            for (const deferredHeader of headerSweepHeaders.slice(headerIndex)) {
              const deferredComposerId = composerIdText(
                deferredHeader.composerId,
              );
              if (
                deferredComposerId !== null &&
                COMPOSER_ID_PATTERN.test(deferredComposerId) &&
                headerIsMainComposer(deferredHeader) === true
              ) {
                deferredResourceIds.add(`chat/${deferredComposerId}`);
              }
            }
            break;
          }
          // A previously emitted snapshot can be superseded locally before the
          // manager acknowledges it (for example Cursor/undo restores the
          // repository version). Forced streaming verification proved the
          // current bytes equal that known version, so the obsolete retry must
          // not keep the zero-SQLite idle path disabled forever.
          this.pendingSnapshots.delete(resourceId);
          this.pendingBubbleCountMismatches.delete(resourceId);
          if (settlement !== undefined) {
            settlement.observedHeaderGeneration =
              this.oversizedSettlementHeaderGeneration;
          }
          if (this.forcedCoreVerificationResourceIds.has(resourceId)) {
            completedForcedVerifications.add(resourceId);
          }
          lastCompletedBodyCapture = resourceId;
          continue;
        }
        if (captured.kind === "oversized") {
          const maxPayloadBytes = headerMaterializationLimit;
          if (settlement?.semanticHash !== captured.semanticHash) {
            this.oversizedSettlements.delete(resourceId);
          }
          this.pendingSnapshots.set(resourceId, {
            semanticHash: captured.semanticHash,
            databaseFingerprint,
            sourceTimestamp: captured.header.lastUpdatedAt,
            sourceBubbleCount: captured.bubbleCount,
            sourceChatCoreHash: captured.coreHash,
            sourceHeaderFingerprint: headerFingerprint,
            sourceHeaderMetadataFingerprint: metadata.fingerprint,
            coreVerifiedAt: now,
          });
          oversizedCandidates.set(resourceId, {
            semanticHash: captured.semanticHash,
            byteLength: captured.byteLength,
            maxPayloadBytes,
            ...(captured.warning !== undefined
              ? { warning: captured.warning }
              : this.maxPayloadBytes !== null &&
                  maxPayloadBytes < this.maxPayloadBytes
                ? {
                    warning: interactiveChatCaptureWarning(
                      resourceId,
                      captured.byteLength,
                    ),
                  }
                : {}),
          });
          this.pendingBubbleCountMismatches.delete(resourceId);
          if (this.forcedCoreVerificationResourceIds.has(resourceId)) {
            completedForcedVerifications.add(resourceId);
          }
          lastCompletedBodyCapture = resourceId;
          continue;
        }
        // Aggregated rather than warned per chat: a body that never arrives is
        // never publishable, so a per-chat line would repeat on every poll
        // forever. The IDs still travel with the count, because a body-less
        // header is also what a mass loss looks like.
        if (captured.kind === "incomplete") {
          // A previously returned put can no longer be reconstructed from this
          // database. Keep the repository's older complete copy and allow the
          // adapter to settle instead of forcing this body-less row forever.
          if (this.pendingSnapshots.has(resourceId)) {
            nonReconstructablePendingSnapshots.add(resourceId);
          }
          this.oversizedSettlements.delete(resourceId);
          bodyless.push(composerId);
          this.pendingBubbleCountMismatches.delete(resourceId);
          if (this.forcedCoreVerificationResourceIds.has(resourceId)) {
            // There is no complete local core for the queued version to
            // overwrite. Allow the incoming copy to reconstruct it.
            completedForcedVerifications.add(resourceId);
          }
          lastCompletedBodyCapture = resourceId;
          continue;
        }
        // Aggregated for the same reason, and a notice rather than a warning:
        // the repository still holds the full conversation, so nothing was
        // lost that this device can act on - it is the other computer's copy
        // being protected from this one's pruning.
        if (captured.kind === "pruned") {
          if (this.pendingSnapshots.has(resourceId)) {
            nonReconstructablePendingSnapshots.add(resourceId);
          }
          this.oversizedSettlements.delete(resourceId);
          pruned.push(`${composerId} (${captured.had} -> ${captured.has})`);
          this.pendingBubbleCountMismatches.delete(resourceId);
          if (this.forcedCoreVerificationResourceIds.has(resourceId)) {
            // Cursor-local pruning is not a user edit; the richer queued core
            // is precisely what should be allowed to restore these rows.
            completedForcedVerifications.add(resourceId);
          }
          lastCompletedBodyCapture = resourceId;
          continue;
        }
        const snapshot = captured.snapshot;
        const workspaceId = snapshot.header.workspaceId;
        const title = chatHeaderTitle(snapshot.header.value);
        const content = canonicalBytes(snapshot);
        const semanticHash = sha256(content);
        const pendingSnapshot: PendingChatSnapshot = {
          semanticHash,
          databaseFingerprint,
          sourceTimestamp: snapshot.header.lastUpdatedAt,
          sourceBubbleCount: snapshot.bubbles.length,
          sourceChatCoreHash: captured.coreHash,
          sourceHeaderFingerprint: headerFingerprint,
          sourceHeaderMetadataFingerprint: metadata.fingerprint,
          coreVerifiedAt: now,
        };
        if (
          !buffersFitJsonStructureBudget([content], {
            maxStructuralTokens:
              PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
          })
        ) {
          const maxPayloadBytes =
            this.maxPayloadBytes ?? headerMaterializationLimit;
          this.pendingSnapshots.set(resourceId, pendingSnapshot);
          oversizedCandidates.set(resourceId, {
            semanticHash,
            byteLength: content.byteLength,
            maxPayloadBytes,
            warning: interactiveChatStructureWarning(resourceId),
          });
          this.pendingBubbleCountMismatches.delete(resourceId);
          lastCompletedBodyCapture = resourceId;
          continue;
        }
        if (
          projection?.kind === "chat" &&
          captured.agentKvRecaptureAttempted !== true &&
          (projection.semanticHash === semanticHash ||
            projection.retainedLocalHash === semanticHash)
        ) {
          // A forced body verification must read exact bytes, but it need not
          // retain and hand the unchanged (potentially huge) snapshot to the
          // manager. The manager's publish policy makes the same two checks.
          rememberObservedChatSource(
            projection,
            snapshot.header.lastUpdatedAt,
            snapshot.bubbles.length,
            captured.coreHash,
            headerFingerprint,
          );
          this.pendingSnapshots.delete(resourceId);
          this.pendingBubbleCountMismatches.delete(resourceId);
          if (this.forcedCoreVerificationResourceIds.has(resourceId)) {
            completedForcedVerifications.add(resourceId);
          }
          lastCompletedBodyCapture = resourceId;
          continue;
        }
        if (
          settlement !== undefined &&
          settlement.semanticHash !== semanticHash
        ) {
          this.oversizedSettlements.delete(resourceId);
        }
        if (
          this.maxPayloadBytes !== null &&
          content.byteLength > this.maxPayloadBytes
        ) {
          // Once the manager has supplied its exact repository policy, an
          // unpublishable chat need not consume the retained-result budget or
          // starve later small chats in a one-shot helper scan. Settlement is
          // finalized only after the post-close DB fingerprint proves this
          // capture stable.
          this.pendingSnapshots.set(resourceId, pendingSnapshot);
          oversizedCandidates.set(resourceId, {
            semanticHash,
            byteLength: content.byteLength,
            maxPayloadBytes: this.maxPayloadBytes,
          });
          this.pendingBubbleCountMismatches.delete(resourceId);
          lastCompletedBodyCapture = resourceId;
          continue;
        }
        if (
          snapshots.length > 0 &&
          retainedSnapshotBytes + content.byteLength >
            MAX_CHAT_SNAPSHOT_BYTES_PER_SCAN
        ) {
          // The exact bytes were needed to prove this chat changed, but
          // retaining them beside earlier large snapshots would recreate the
          // aggregate RAM spike. Leave the cursor immediately before this chat
          // so the next scan admits it first (even when it alone exceeds the
          // soft byte budget) and every later listed header stays `current`.
          bodyCaptureBudgetExhausted = true;
          captureWorkDeferred = true;
          headerSweepEndIndex = headerIndex;
          for (const deferredHeader of headerSweepHeaders.slice(headerIndex)) {
            const deferredComposerId = composerIdText(
              deferredHeader.composerId,
            );
            if (
              deferredComposerId !== null &&
              COMPOSER_ID_PATTERN.test(deferredComposerId) &&
              headerIsMainComposer(deferredHeader) === true
            ) {
              deferredResourceIds.add(`chat/${deferredComposerId}`);
            }
          }
          break;
        }
        this.pendingSnapshots.set(resourceId, pendingSnapshot);
        const workspaceUri =
          workspaceId === null
            ? null
            : (
                await lookupWorkspaceIdentitiesById(
                  this.paths,
                  [workspaceId],
                  { maxLookups: 1 },
                )
              ).get(workspaceId)?.uri ?? null;
        snapshots.push({
          resourceId,
          kind: "chat",
          content,
          semanticHash,
          metadata: {
            composerId: snapshot.header.composerId,
            workspaceId,
            workspaceUri,
            lastUpdatedAt: snapshot.header.lastUpdatedAt,
            bubbleCount: snapshot.bubbles.length,
            chatCoreHash: captured.coreHash,
            headerFingerprint,
            chatSnapshotSchemaVersion: snapshot.schemaVersion,
            ...(isPortableChatSnapshotV2(snapshot)
              ? {
                  agentKvBlobCount: snapshot.agentKv.blobs.length,
                  agentKvReferencedCount:
                    snapshot.agentKv.referencedIds.length,
                  agentKvMissingCount: snapshot.agentKv.missingIds.length,
                }
              : {}),
            ...(captured.agentKvRecaptureAttempted === true
              ? { syncOrigin: "agent-kv-recapture" }
              : {}),
            ...(title === null ? {} : { title }),
          },
        });
        if (this.forcedCoreVerificationResourceIds.has(resourceId)) {
          completedForcedVerifications.add(resourceId);
        }
        retainedSnapshotBytes += content.byteLength;
        this.pendingBubbleCountMismatches.delete(resourceId);
        if (retainedSnapshotBytes >= MAX_CHAT_SNAPSHOT_BYTES_PER_SCAN) {
          bodyCaptureBudgetExhausted = true;
        }
        lastCompletedBodyCapture = resourceId;
      }
      if (headerSweepEndIndex > 0) {
        headerLastProcessedCursor = headerMetadataCursor(
          headerSweepHeaders[headerSweepEndIndex - 1]!,
        );
      }
      headerPageReachedEnd =
        headerSweepEndIndex === headerSweepHeaders.length &&
        headerSweepHeaders.length < MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE;
      if (!headerPageReachedEnd) {
        captureWorkDeferred = true;
      }
      this.bodyCaptureCursor = lastCompletedBodyCapture;
      deepVerificationBatchCompleted = [...deepVerificationIds].every((id) =>
        processedDeepVerificationIds.has(id),
      );
      if (
        activeSweep !== null &&
        deepVerificationBatchDue &&
        !deepVerificationBatchCompleted
      ) {
        for (const resourceId of deepVerificationIds) {
          if (processedDeepVerificationIds.has(resourceId)) {
            continue;
          }
          deferredResourceIds.add(resourceId);
        }
      }
      if (bodyless.length > 0) {
        notices.push(bodylessChatsWarning(bodyless));
      }
      if (pruned.length > 0) {
        notices.push(prunedChatsNotice(pruned));
      }
    } finally {
      database.close();
    }

    // Cursor has no reliable, stable deletion generation for this table while
    // it is live. A multi-page pass can race pruning/recreation, and retaining
    // every current ID merely to manufacture tombstones is both destructive
    // and O(total chats). Chat synchronization is therefore additive-only:
    // explicit repository history/repair retains old chats, while local row
    // absence never deletes another device's recoverable conversation.
    const candidateDeletions: ResourceDeletion[] = [];
    let afterDatabaseFingerprint: string | null = null;
    let databaseStable = false;
    try {
      afterDatabaseFingerprint = await stateVscdbFingerprint(
        this.paths.globalDatabase,
      );
      databaseStable = afterDatabaseFingerprint === databaseFingerprint;
    } catch {
      // Replacing or temporarily hiding the database after the header listing
      // is indistinguishable from a concurrent mutation. Fail closed below.
    }
    if (databaseStable) {
      for (const [resourceId, candidate] of headerOversizedCandidates) {
        this.retainOversizedSettlement({
          resourceId,
          semanticHash: candidate.semanticHash,
          byteLength: candidate.byteLength,
          maxPayloadBytes: candidate.maxPayloadBytes,
          ...(candidate.warning === undefined
            ? {}
            : { warning: candidate.warning }),
          databaseFingerprint,
          headerMetadataOnly: true,
          sourceTimestamp: candidate.sourceTimestamp,
          sourceBubbleCount: -1,
          sourceChatCoreHash: "",
          sourceHeaderFingerprint: candidate.sourceHeaderFingerprint,
          sourceHeaderMetadataFingerprint:
            candidate.sourceHeaderFingerprint,
          coreVerifiedAt: now,
          observedHeaderGeneration: this.oversizedSettlementHeaderGeneration,
        });
      }
      for (const [resourceId, semanticHash] of [
        ...snapshots.map(
          (snapshot) => [snapshot.resourceId, snapshot.semanticHash] as const,
        ),
        ...[...oversizedCandidates].map(
          ([resourceId, candidate]) =>
            [resourceId, candidate.semanticHash] as const,
        ),
      ]) {
        const pending = this.pendingSnapshots.get(resourceId);
        if (
          pending?.semanticHash === semanticHash &&
          pending.databaseFingerprint === databaseFingerprint
        ) {
          pending.settleableDatabaseFingerprint = databaseFingerprint;
        }
      }
      for (const [resourceId, candidate] of oversizedCandidates) {
        this.settlePendingOversizedSnapshot(
          resourceId,
          candidate.semanticHash,
          candidate.byteLength,
          candidate.maxPayloadBytes,
          candidate.warning,
        );
      }
      for (const resourceId of nonReconstructablePendingSnapshots) {
        this.pendingSnapshots.delete(resourceId);
      }
      for (const deletion of candidateDeletions) {
        if (this.forcedCoreVerificationResourceIds.has(deletion.resourceId)) {
          completedForcedVerifications.add(deletion.resourceId);
        }
      }
      for (const resourceId of completedForcedVerifications) {
        this.forcedCoreVerificationResourceIds.delete(resourceId);
      }
    }
    if (!databaseStable) {
      activeHeaderSweep.needsAnotherPass = true;
    }
    activeHeaderSweep.databaseFingerprint =
      afterDatabaseFingerprint ?? databaseFingerprint;
    activeHeaderSweep.nextCursor = headerLastProcessedCursor;
    if (headerPageReachedEnd) {
      if (activeHeaderSweep.needsAnotherPass) {
        activeHeaderSweep.nextCursor = null;
        activeHeaderSweep.needsAnotherPass = false;
        this.beginOversizedSettlementHeaderGeneration();
        captureWorkDeferred = true;
      } else {
        const overflowNeedsOneFittingRebuild =
          this.finishOversizedSettlementHeaderGeneration();
        if (overflowNeedsOneFittingRebuild) {
          // Stale entries consumed slots before this pass reached a current
          // omitted identity. One bounded rebuild can now admit it into the
          // space just released by stable-generation cleanup.
          activeHeaderSweep.nextCursor = null;
          this.beginOversizedSettlementHeaderGeneration();
          captureWorkDeferred = true;
        } else {
          this.headerMaterializationSweep = null;
        }
      }
    } else {
      captureWorkDeferred = true;
    }

    if (activeSweep !== null && deepVerificationBatchDue) {
      activeSweep.databaseFingerprint =
        afterDatabaseFingerprint ?? databaseFingerprint;
      if (!deepVerificationBatchCompleted) {
        // The bounded header/body page has not reached every selected member.
        // Keep the metadata cursor so the same four are retried while the
        // independent header cursor advances toward them.
      } else if (deepPageReachedEnd) {
        this.deepVerificationSweep = null;
        this.nextDeepVerificationAt =
          now + CHAT_DEEP_VERIFICATION_INTERVAL_MS;
      } else {
        activeSweep.nextCursor = deepNextCursor;
        this.nextDeepVerificationAt =
          now + CHAT_DEEP_VERIFICATION_INTERVAL_MS;
      }
    }
    if (activeBubbleCountSweep !== null) {
      if (!databaseStable) {
        activeBubbleCountSweep.needsAnotherPass = true;
      }
      activeBubbleCountSweep.databaseFingerprint =
        afterDatabaseFingerprint ?? databaseFingerprint;
      activeBubbleCountSweep.nextCursor = bubbleNextCursor;
      if (bubblePageReachedEnd) {
        if (activeBubbleCountSweep.needsAnotherPass) {
          activeBubbleCountSweep.nextCursor = null;
          activeBubbleCountSweep.needsAnotherPass = false;
          captureWorkDeferred = true;
        } else {
          this.completedBubbleCountAudit = {
            databaseFingerprint: activeBubbleCountSweep.databaseFingerprint,
          };
          this.bubbleCountAuditSweep = null;
        }
      } else {
        captureWorkDeferred = true;
      }
    }
    const result: ResourceScanResult = {
      snapshots,
      // A header inserted after the initial listing otherwise looks deleted.
      // Tombstones are destructive and may only come from one settled view of
      // the database; snapshots remain safe to publish from per-chat read
      // transactions and are rechecked by semantic hash downstream.
      deletions: databaseStable ? candidateDeletions : [],
      warnings,
      notices,
    };
    const scanIsQuiet =
      result.snapshots.length === 0 &&
      result.deletions.length === 0 &&
      result.warnings.length === 0 &&
      !captureWorkDeferred;
    let stableObservation: SettledChatScan | null = null;
    if (databaseStable) {
      stableObservation = {
        databaseFingerprint,
        notices: [...notices],
      };
    }
    if (
      scanIsQuiet &&
      (!periodicDeepVerification ||
        this.deepVerificationSweep === null ||
        now < this.nextDeepVerificationAt) &&
      this.bubbleCountAuditSweep === null &&
      stableObservation !== null
    ) {
      // Fingerprint again after closing SQLite. If Cursor committed during the
      // scan, caching the later file state against an earlier DB snapshot could
      // hide that commit forever. Only equal before/after fingerprints are a
      // settled observation; otherwise the next poll deliberately scans again.
      this.settledScan = stableObservation;
    }
    this.deferredResourceIds = deferredResourceIds;
    return result;
  }

  private retainBubbleCountMismatch(resourceId: string): boolean {
    if (this.pendingBubbleCountMismatches.has(resourceId)) {
      return true;
    }
    if (
      this.pendingBubbleCountMismatches.size >=
      MAX_CHAT_PENDING_BUBBLE_COUNT_MISMATCHES
    ) {
      return false;
    }
    this.pendingBubbleCountMismatches.add(resourceId);
    this.options.onBubbleCountMismatchRetained?.(
      this.pendingBubbleCountMismatches.size,
    );
    return true;
  }

  private retainOversizedSettlement(
    settlement: OversizedChatSettlement,
  ): boolean {
    if (
      !this.oversizedSettlements.has(settlement.resourceId) &&
      this.oversizedSettlements.size >= MAX_CHAT_OVERSIZED_SETTLEMENTS
    ) {
      this.recordOversizedSettlementOverflow(settlement.resourceId);
      this.settledScan = null;
      return false;
    }
    this.oversizedSettlements.set(settlement.resourceId, settlement);
    this.options.onOversizedSettlementRetained?.(
      this.oversizedSettlements.size,
    );
    return true;
  }

  private recordOversizedSettlementOverflow(resourceId: string): void {
    this.activeOversizedSettlementOverflow.omittedCount += 1;
    if (
      this.activeOversizedSettlementOverflow.sampleResourceIds.length <
        MAX_CHAT_OVERSIZED_WARNING_SAMPLES &&
      !this.activeOversizedSettlementOverflow.sampleResourceIds.includes(
        resourceId,
      )
    ) {
      this.activeOversizedSettlementOverflow.sampleResourceIds.push(resourceId);
    }
    this.oversizedSettlementOverflow = {
      omittedCount: this.activeOversizedSettlementOverflow.omittedCount,
      sampleResourceIds: [
        ...this.activeOversizedSettlementOverflow.sampleResourceIds,
      ],
    };
  }

  private beginOversizedSettlementHeaderGeneration(): void {
    this.oversizedSettlementHeaderGeneration += 1;
    this.activeOversizedSettlementOverflow = {
      omittedCount: 0,
      sampleResourceIds: [],
    };
  }

  /**
   * Finalizes only after one complete, stable header generation. Entries not
   * observed in that generation are stale local proofs and can be discarded
   * without publishing tombstones. An earlier overflow is cleared only when
   * the same proof establishes that every active settlement fit in memory.
   * A permanently oversized active set settles into a zero-SQLite fail-closed
   * state; a database generation change starts the next bounded rebuild.
   */
  private finishOversizedSettlementHeaderGeneration(): boolean {
    let changed = false;
    for (const [resourceId, settlement] of this.oversizedSettlements) {
      if (
        settlement.observedHeaderGeneration ===
        this.oversizedSettlementHeaderGeneration
      ) {
        continue;
      }
      this.oversizedSettlements.delete(resourceId);
      changed = true;
    }
    if (changed) {
      this.options.onOversizedSettlementRetained?.(
        this.oversizedSettlements.size,
      );
    }
    if (this.activeOversizedSettlementOverflow.omittedCount === 0) {
      this.oversizedSettlementOverflow = null;
      return false;
    }
    this.oversizedSettlementOverflow = {
      omittedCount: this.activeOversizedSettlementOverflow.omittedCount,
      sampleResourceIds: [
        ...this.activeOversizedSettlementOverflow.sampleResourceIds,
      ],
    };
    return this.oversizedSettlements.size < MAX_CHAT_OVERSIZED_SETTLEMENTS;
  }

  private observeProjectionFingerprint(
    resourceId: string,
    projection: LocalProjection | undefined,
  ): boolean {
    const fingerprint = projectionObservationFingerprint(projection);
    const previous = this.projectionFingerprintMemo.get(resourceId);
    // Refresh insertion order so active/recent chats survive bounded eviction.
    this.projectionFingerprintMemo.delete(resourceId);
    this.projectionFingerprintMemo.set(resourceId, fingerprint);
    while (
      this.projectionFingerprintMemo.size >
      MAX_CHAT_PROJECTION_FINGERPRINT_MEMO
    ) {
      const oldest = this.projectionFingerprintMemo.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.projectionFingerprintMemo.delete(oldest);
    }
    return previous !== undefined && previous !== fingerprint;
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Chat snapshots must be applied by the offline helper.");
  }
}

export function parsePortableChatSnapshot(content: Buffer): PortableChatSnapshot {
  if (
    !buffersFitJsonStructureBudget([content], {
      maxStructuralTokens: PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS,
    })
  ) {
    throw new ChatJsonStructureLimitError(
      `Chat snapshot JSON exceeds the fixed ${PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS}-token/${JSON_STRUCTURE_MAX_DEPTH}-depth structural parser safety limit.`,
    );
  }
  const value = JSON.parse(content.toString("utf8")) as PortableChatSnapshot;
  if (
    value === null ||
    typeof value !== "object" ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    typeof value.composerId !== "string" ||
    value.header === null ||
    typeof value.header !== "object" ||
    value.header.composerId !== value.composerId ||
    value.composerData === null ||
    typeof value.composerData !== "object" ||
    !Array.isArray(value.bubbles)
  ) {
    throw new Error("Unsupported or invalid chat snapshot.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.composerId)) {
    throw new Error("Chat snapshot composer ID is invalid.");
  }
  if (value.composerData.key !== `composerData:${value.composerId}`) {
    throw new Error("Chat snapshot composerData key does not match its composer ID.");
  }
  if (
    !isValidBase64(value.composerData.valueBase64) ||
    !isNullableText(value.header.workspaceId) ||
    !isNullableText(value.header.value) ||
    ![
      value.header.createdAt,
      value.header.lastUpdatedAt,
      value.header.isArchived,
      value.header.isSubagent,
      value.header.recency,
      value.header.checkpointAt,
    ].every(
      (item) =>
        item === null || (typeof item === "number" && Number.isFinite(item)),
    ) ||
    value.bubbles.length > 250_000
  ) {
    throw new Error("Chat snapshot fields are invalid.");
  }
  if (
    value.bubbles.some(
      (bubble) =>
        bubble === null ||
        typeof bubble !== "object" ||
        typeof bubble.key !== "string" ||
        bubble.key.length <= `bubbleId:${value.composerId}:`.length ||
        !bubble.key.startsWith(`bubbleId:${value.composerId}:`) ||
        !isValidBase64(bubble.valueBase64),
    )
  ) {
    throw new Error("Chat snapshot contains a bubble for another composer.");
  }
  if (new Set(value.bubbles.map((bubble) => bubble.key)).size !== value.bubbles.length) {
    throw new Error("Chat snapshot contains duplicate bubble keys.");
  }
  if (
    !isValidKvValueType(value.composerData.valueType) ||
    value.bubbles.some((bubble) => !isValidKvValueType(bubble.valueType))
  ) {
    throw new Error("Chat snapshot contains an invalid value storage class.");
  }
  if (value.schemaVersion === 2) {
    validatePortableAgentKvPayload(value.agentKv);
  }
  return value;
}

function validatePortableAgentKvPayload(value: unknown): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("Chat snapshot agentKv payload is invalid.");
  }
  const payload = value as Partial<PortableAgentKvPayload>;
  if (
    !Array.isArray(payload.blobs) ||
    !Array.isArray(payload.referencedIds) ||
    !Array.isArray(payload.missingIds) ||
    payload.blobs.length > MAX_AGENT_KV_ENTRIES ||
    payload.referencedIds.length > MAX_AGENT_KV_ENTRIES ||
    payload.missingIds.length > MAX_AGENT_KV_ENTRIES
  ) {
    throw new Error("Chat snapshot agentKv payload exceeds its bounds.");
  }
  if (
    !isSortedUniqueAgentKvIds(payload.referencedIds) ||
    !isSortedUniqueAgentKvIds(payload.missingIds)
  ) {
    throw new Error("Chat snapshot agentKv references are invalid or non-deterministic.");
  }
  const referenced = new Set(payload.referencedIds);
  const missing = new Set(payload.missingIds);
  const materialized = new Set<string>();
  let totalBytes = 0;
  let previousKey: string | null = null;
  for (const blob of payload.blobs) {
    if (
      blob === null ||
      typeof blob !== "object" ||
      typeof blob.key !== "string" ||
      !AGENT_KV_BLOB_KEY_PATTERN.test(blob.key) ||
      !isValidBase64(blob.valueBase64) ||
      (blob.valueType !== "text" && blob.valueType !== "blob") ||
      (previousKey !== null && previousKey >= blob.key)
    ) {
      throw new Error("Chat snapshot contains an invalid agentKv blob.");
    }
    previousKey = blob.key;
    const id = blob.key.slice(AGENT_KV_BLOB_PREFIX.length);
    const bytes = Buffer.from(blob.valueBase64, "base64");
    totalBytes += bytes.length;
    if (
      totalBytes > MAX_AGENT_KV_TOTAL_BYTES ||
      (blob.valueType === "text" &&
        !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) ||
      sha256(bytes) !== id ||
      materialized.has(id) ||
      !referenced.has(id) ||
      missing.has(id)
    ) {
      throw new Error("Chat snapshot agentKv content address is invalid.");
    }
    materialized.add(id);
  }
  if (
    payload.referencedIds.some(
      (id) => !materialized.has(id) && !missing.has(id),
    ) ||
    payload.missingIds.some((id) => !referenced.has(id)) ||
    materialized.size + missing.size !== referenced.size
  ) {
    throw new Error("Chat snapshot agentKv reachability set is incomplete.");
  }
}

function isSortedUniqueAgentKvIds(value: readonly unknown[]): value is string[] {
  let previous: string | null = null;
  for (const id of value) {
    if (
      typeof id !== "string" ||
      !AGENT_KV_ID_PATTERN.test(id) ||
      (previous !== null && previous >= id)
    ) {
      return false;
    }
    previous = id;
  }
  return true;
}

function isValidKvValueType(value: unknown): value is PortableKvRow["valueType"] {
  return (
    value === undefined ||
    value === "text" ||
    value === "blob" ||
    value === "null"
  );
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isValidBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isCanonicalBase64Text(value) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function settlementProjection(
  resourceId: string,
  projection: LocalProjection | undefined,
  settlement: OversizedChatSettlement | undefined,
): LocalProjection | undefined {
  if (settlement === undefined) {
    return projection;
  }
  return {
    resourceId,
    kind: "chat",
    semanticHash: settlement.semanticHash,
    versionId: projection?.versionId ?? null,
    ...(settlement.sourceTimestamp === null
      ? {}
      : { sourceTimestamp: settlement.sourceTimestamp }),
    sourceBubbleCount: settlement.sourceBubbleCount,
    sourceChatCoreHash: settlement.sourceChatCoreHash,
    sourceHeaderFingerprint: settlement.sourceHeaderFingerprint,
  };
}

function resolveInitialGraphPriority(
  budget: AgentKvScanBudget,
  resourceId: string,
): void {
  budget.initialGraphPriorityResourceIds?.delete(resourceId);
}

async function captureChat(
  database: DatabaseSync,
  statements: ChatStatements,
  identity: ChatIdentity,
  projection: LocalProjection | undefined,
  agentKvBudget: AgentKvScanBudget,
  maxPayloadBytes: number | null,
  headerMaterializationLimit: number,
  forceCapture = false,
  onSnapshotMaterialize?: (resourceId: string) => void,
  onBubbleCountProbe?: () => void,
  onCoreHashYield?: () => void,
  onCoreValueChunkRead?: () => void,
  onCoreMetadataRow?: () => void,
): Promise<ChatCapture> {
  database.exec("BEGIN");
  try {
    // Bound with the raw value, not the decoded text: SQLite never considers a
    // BLOB equal to a TEXT, so a BLOB-affinity composerId would miss its own
    // row and read as a chat that had disappeared.
    const currentHeader = statements.header.get(
      headerMaterializationLimit,
      identity.headerKey,
    ) as RawBoundedComposerHeader | undefined;
    if (currentHeader === undefined) {
      resolveInitialGraphPriority(
        agentKvBudget,
        `chat/${identity.composerId}`,
      );
      database.exec("COMMIT");
      return { kind: "missing" };
    }
    const header = normalizeBoundedHeader(currentHeader, identity.composerId);
    const resourceId = `chat/${header.composerId}`;
    // A null timestamp carries no change information, so it must never
    // short-circuit against a projection that simply recorded none either.
    // Same two-part signal as the listing pass; see
    // `LocalProjection.sourceBubbleCount` for why the timestamp alone is not
    // enough. Counted inside the transaction so it agrees with the rows the
    // capture below would read.
    const bubbleRange = bubbleKeyRange(header.composerId);
    const composerDataMetadata = statements.dataMetadata.get(
      `composerData:${header.composerId}`,
    ) as RawKvMetadata | undefined;
    // Cursor prunes the conversation body but leaves the list entry behind,
    // so a header without composerData is expected, not a broken row.
    if (composerDataMetadata === undefined) {
      resolveInitialGraphPriority(agentKvBudget, resourceId);
      database.exec("COMMIT");
      return { kind: "incomplete" };
    }
    const boundedBubbleCount = currentBubbleCount(
      statements.bubbleCount,
      header.composerId,
      onBubbleCountProbe,
    );
    if (
      boundedBubbleCount !== null &&
      boundedBubbleCount > MAX_CHAT_CORE_METADATA_ROWS
    ) {
      const oversized = opaqueOversizedChatCore(
        header,
        composerDataMetadata,
        boundedBubbleCount,
        MAX_CHAT_INTERACTIVE_CAPTURE_BYTES + 1,
        interactiveChatRowWorkWarning(resourceId, boundedBubbleCount),
      );
      resolveInitialGraphPriority(agentKvBudget, resourceId);
      database.exec("COMMIT");
      return oversized;
    }
    const liveBubbleCount = boundedBubbleCount;
    if (
      !forceCapture &&
      header.lastUpdatedAt !== null &&
      projection?.kind === "chat" &&
      projection.sourceTimestamp === header.lastUpdatedAt &&
      projection.sourceBubbleCount === (liveBubbleCount ?? 0)
    ) {
      resolveInitialGraphPriority(agentKvBudget, resourceId);
      database.exec("COMMIT");
      return { kind: "unchanged" };
    }
    // A conversation that has LOST messages since this device last published
    // it is not a change to propagate.
    //
    // Cursor prunes conversation bodies on its own schedule, per computer.
    // Publishing the pruned capture made this device's housekeeping the shared
    // truth and emptied the other computer's copy of a conversation it still
    // held in full. Messages are immutable and append-only - Cursor offers no
    // way to delete one - so a shrink is never the user's doing, and the
    // richer version already in the repository is the one worth keeping.
    // Holding back also leaves that version available to be written back here.
    const knownCount = projection?.sourceBubbleCount;
    if (
      projection?.kind === "chat" &&
      typeof knownCount === "number" &&
      (liveBubbleCount ?? 0) < knownCount
    ) {
      resolveInitialGraphPriority(agentKvBudget, resourceId);
      database.exec("COMMIT");
      return { kind: "pruned", had: knownCount, has: liveBubbleCount ?? 0 };
    }
    let coreByteLengthForGraphBudget = 0;
    if (maxPayloadBytes !== null) {
      const metadataSummary = statements.bubbleMetadataSummary.get(
        ...bubbleRange,
      ) as RawKvMetadataSummary | undefined;
      const rawCoreLowerBound = portableChatCoreRawLowerBound(
        header,
        composerDataMetadata,
        metadataSummary,
        liveBubbleCount ?? 0,
      );
      if (rawCoreLowerBound > MAX_CHAT_INTERACTIVE_CAPTURE_BYTES) {
        const oversized = opaqueOversizedChatCore(
          header,
          composerDataMetadata,
          liveBubbleCount ?? 0,
          rawCoreLowerBound,
          interactiveChatCaptureWarning(resourceId, rawCoreLowerBound),
        );
        resolveInitialGraphPriority(agentKvBudget, resourceId);
        database.exec("COMMIT");
        return oversized;
      }
      const coreByteLength = portableChatCoreByteLength(
        header,
        composerDataMetadata,
        statements.bubbleMetadata.iterate(
          ...bubbleRange,
        ) as Iterable<RawKvMetadata>,
        onCoreMetadataRow,
      );
      coreByteLengthForGraphBudget = coreByteLength;
      if (
        rawCoreLowerBound > maxPayloadBytes ||
        coreByteLength > maxPayloadBytes
      ) {
        const coreHash = await streamPortableChatCoreHash(
          statements.valueChunk,
          header,
          composerDataMetadata,
          statements.bubbleMetadata.iterate(
            ...bubbleRange,
          ) as Iterable<RawKvMetadata>,
          onCoreHashYield,
          onCoreValueChunkRead,
          onCoreMetadataRow,
        );
        if (forceCapture && projectionRepresentsChatCore(projection, coreHash)) {
          resolveInitialGraphPriority(agentKvBudget, resourceId);
          database.exec("COMMIT");
          rememberObservedChatSource(
            projection,
            header.lastUpdatedAt,
            liveBubbleCount ?? 0,
            coreHash,
            portableHeaderFingerprint(header),
          );
          return { kind: "unchanged" };
        }
        resolveInitialGraphPriority(agentKvBudget, resourceId);
        database.exec("COMMIT");
        return {
          kind: "oversized",
          semanticHash: coreHash,
          byteLength: coreByteLength,
          header,
          bubbleCount: liveBubbleCount ?? 0,
          coreHash,
        };
      }
    }
    const composerDataRow = statements.data.get(
      `composerData:${header.composerId}`,
    ) as RawKvRow | undefined;
    if (composerDataRow === undefined) {
      resolveInitialGraphPriority(agentKvBudget, resourceId);
      database.exec("COMMIT");
      return { kind: "incomplete" };
    }
    let bubbleRows: RawKvRow[] | null = null;
    if (!forceCapture) {
      onSnapshotMaterialize?.(resourceId);
      bubbleRows = statements.bubbles.all(...bubbleRange) as RawKvRow[];
    }
    const coreRows: Iterable<RawKvRow> = forceCapture
      ? (statements.bubbles.iterate(...bubbleRange) as Iterable<RawKvRow>)
      : bubbleRows!;
    const core = analyzeChatCore(header, composerDataRow, coreRows);
    if (
      forceCapture &&
      projection?.kind === "chat" &&
      projection.requiresAgentKvRecapture !== true
    ) {
      // The mutable/renderable core is streamed once. Reachable agentKv rows
      // are content-addressed and immutable; repository-side enrichment owns
      // filling a v2 tip's missing IDs when the DB generation changes. Once a
      // projection remembers this exact core hash, reopening and retaining a
      // potentially 512 MiB graph on every fallback sweep would only recreate
      // the CPU/RAM spike this bounded verifier exists to prevent.
      if (
        projection.sourceChatCoreHash === core.coreHash ||
        projection.semanticHash === core.coreHash ||
        projection.retainedLocalHash === core.coreHash
      ) {
        resolveInitialGraphPriority(agentKvBudget, resourceId);
        database.exec("COMMIT");
        rememberObservedChatSource(
          projection,
          header.lastUpdatedAt,
          liveBubbleCount ?? 0,
          core.coreHash,
          portableHeaderFingerprint(header),
        );
        return { kind: "unchanged" };
      }
    }
    const agentKvRecaptureRequested =
      projection?.requiresAgentKvRecapture === true;
    const initialGraphPriority =
      agentKvBudget.initialGraphPriorityResourceIds;
    const initialGraphPriorityAdmitted =
      initialGraphPriority === null ||
      initialGraphPriority.size === 0 ||
      initialGraphPriority.has(resourceId);
    const graphCaptureAdmitted = agentKvRecaptureRequested
      ? agentKvBudget.remainingGraphCaptures > 0
      : initialGraphPriorityAdmitted &&
        agentKvBudget.remainingGraphCaptures >
          agentKvBudget.reservedRecaptureGraphCaptures;
    if (agentKvRecaptureRequested && !graphCaptureAdmitted) {
      database.exec("COMMIT");
      return {
        kind: "unchanged",
        agentKvRecaptureDeferred: true,
        notice:
          "Deferred its one-shot agentKv recapture to the next bounded scan pass.",
      };
    }
    if (bubbleRows === null) {
      onSnapshotMaterialize?.(resourceId);
      bubbleRows = statements.bubbles.all(...bubbleRange) as RawKvRow[];
    }
    // Parse conversationState directly from the raw SQLite values only when a
    // graph walk can actually be admitted. The old path Base64-encoded every
    // core row for hashing, decoded it again, then JSON-parsed every bubble —
    // even after the two-graph budget was exhausted and during a forced hash
    // verification that returned unchanged above.
    const states =
      graphCaptureAdmitted
        ? collectRawConversationStates(composerDataRow, bubbleRows)
        : null;
    const agentKv = await captureAgentKvPayload(
      statements.agentKv,
      states,
      agentKvBudget,
      agentKvRecaptureRequested,
      maxPayloadBytes === null
        ? MAX_AGENT_KV_BYTES_PER_CHAT
        : Math.max(
            0,
            Math.floor(
              Math.max(
                0,
                maxPayloadBytes -
                  coreByteLengthForGraphBudget -
                  CHAT_AGENT_KV_CANONICAL_HEADROOM_BYTES,
              ) *
                (3 / 4),
            ),
          ),
    );
    resolveInitialGraphPriority(agentKvBudget, resourceId);
    const coreSnapshot = {
      composerId: header.composerId,
      header,
      composerData: portableRow(composerDataRow),
      bubbles: bubbleRows.map(portableRow),
    };
    const snapshot: PortableChatSnapshot =
      agentKv.kind === "v2"
        ? {
            ...coreSnapshot,
            schemaVersion: 2,
            agentKv: agentKv.payload,
          }
        : { ...coreSnapshot, schemaVersion: 1 };
    database.exec("COMMIT");
    return {
      kind: "captured",
      snapshot,
      coreHash: core.coreHash,
      ...(projection?.requiresAgentKvRecapture === true
        ? { agentKvRecaptureAttempted: true }
        : {}),
      ...(agentKv.kind === "fallback" ? { notice: agentKv.notice } : {}),
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

interface ChatCoreAnalysis {
  coreHash: string;
}

interface PortableKvMetadata {
  key: string;
  valueType: "text" | "blob" | "null";
  valueBytes: number;
}

function projectionRepresentsChatCore(
  projection: LocalProjection | undefined,
  coreHash: string,
): projection is LocalProjection {
  return (
    projection?.kind === "chat" &&
    projection.requiresAgentKvRecapture !== true &&
    (projection.sourceChatCoreHash === coreHash ||
      projection.semanticHash === coreHash ||
      projection.retainedLocalHash === coreHash)
  );
}

function portableChatCoreByteLength(
  header: PortableComposerHeader,
  composerData: RawKvMetadata,
  bubbles: Iterable<RawKvMetadata>,
  onMetadataRow?: () => void,
): number {
  const composerMetadata = normalizeKvMetadata(composerData);
  let bytes = Buffer.byteLength('{"bubbles":[');
  let bubbleCount = 0;
  for (const bubble of bubbles) {
    onMetadataRow?.();
    if (bubbleCount > 0) {
      bytes += 1;
    }
    bytes += portableKvRowByteLength(normalizeKvMetadata(bubble));
    bubbleCount += 1;
  }
  bytes += Buffer.byteLength('],"composerData":');
  bytes += portableKvRowByteLength(composerMetadata);
  bytes += Buffer.byteLength(',"composerId":');
  bytes += canonicalJsonStringByteLength(header.composerId);
  bytes += Buffer.byteLength(',"header":');
  bytes += portableComposerHeaderCanonicalByteLength(header);
  bytes += Buffer.byteLength(',"schemaVersion":1}');
  if (!Number.isSafeInteger(bytes)) {
    throw new Error("Chat core encoded length exceeds the safe integer range.");
  }
  return bytes;
}

function portableChatCoreRawLowerBound(
  header: PortableComposerHeader,
  composerData: RawKvMetadata,
  summary: RawKvMetadataSummary | undefined,
  expectedBubbleCount: number,
): number {
  const composerMetadata = normalizeKvMetadata(composerData);
  const total = sqliteNonnegativeSafeInteger(summary?.total, "bubble count");
  const bubbleRawBytes = sqliteNonnegativeSafeInteger(
    summary?.rawBytes,
    "bubble raw bytes",
  );
  if (total !== expectedBubbleCount) {
    throw new Error("Chat bubble metadata count changed during capture.");
  }
  const lowerBound =
    portableComposerHeaderCanonicalByteLength(header) +
    Buffer.byteLength(composerMetadata.key) +
    composerMetadata.valueBytes +
    bubbleRawBytes;
  if (!Number.isSafeInteger(lowerBound)) {
    throw new Error("Chat core raw length exceeds the safe integer range.");
  }
  return lowerBound;
}

/**
 * Stable, lightweight identity for a core that is deliberately not read.
 * Same-length mutations remain protected by the standing settlement and are
 * reconsidered on the bounded periodic audit; they can never be published or
 * treated as an all-clear from this metadata proof alone.
 */
function opaqueOversizedChatCore(
  header: PortableComposerHeader,
  composerData: RawKvMetadata,
  bubbleCount: number,
  byteLength: number,
  warning: string,
): ChatCapture {
  const composer = normalizeKvMetadata(composerData);
  const coreHash = sha256(
    [
      "opaque-live-chat-core-v1",
      header.composerId,
      portableHeaderFingerprint(header),
      composer.key,
      composer.valueType,
      String(composer.valueBytes),
      String(bubbleCount),
      String(byteLength),
    ].join("\0"),
  );
  return {
    kind: "oversized",
    semanticHash: coreHash,
    byteLength,
    header,
    bubbleCount,
    coreHash,
    warning,
  };
}

function sqliteNonnegativeSafeInteger(
  value: SqliteRowValue | undefined,
  label: string,
): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 0
  ) {
    throw new Error(`Chat ${label} is invalid.`);
  }
  return number;
}

function portableKvRowByteLength(metadata: PortableKvMetadata): number {
  return (
    Buffer.byteLength(`{"key":${canonicalJson(metadata.key)},"valueBase64":"`) +
    4 * Math.ceil(metadata.valueBytes / 3) +
    Buffer.byteLength(`","valueType":${canonicalJson(metadata.valueType)}}`)
  );
}

async function streamPortableChatCoreHash(
  valueChunk: ChatStatement,
  header: PortableComposerHeader,
  composerData: RawKvMetadata,
  bubbles: Iterable<RawKvMetadata>,
  onYield?: () => void,
  onValueChunkRead?: () => void,
  onMetadataRow?: () => void,
): Promise<string> {
  const hash = createHash("sha256");
  const yieldState: StreamHashYieldState = {
    streamedBytes: 0,
    nextYieldAt: CHAT_VALUE_STREAM_YIELD_BYTES,
    ...(onYield === undefined ? {} : { onYield }),
    ...(onValueChunkRead === undefined ? {} : { onValueChunkRead }),
  };
  hash.update('{"bubbles":[');
  let bubbleCount = 0;
  for (const bubble of bubbles) {
    onMetadataRow?.();
    if (bubbleCount > 0) {
      hash.update(",");
    }
    await updatePortableKvRowHash(
      hash,
      valueChunk,
      normalizeKvMetadata(bubble),
      yieldState,
    );
    bubbleCount += 1;
  }
  hash.update('],"composerData":');
  await updatePortableKvRowHash(
    hash,
    valueChunk,
    normalizeKvMetadata(composerData),
    yieldState,
  );
  hash.update(',"composerId":');
  updateCanonicalJsonString(hash, header.composerId);
  hash.update(',"header":');
  updatePortableComposerHeaderHash(hash, header);
  hash.update(',"schemaVersion":1}');
  return hash.digest("hex");
}

async function updatePortableKvRowHash(
  hash: ReturnType<typeof createHash>,
  valueChunk: ChatStatement,
  metadata: PortableKvMetadata,
  yieldState: StreamHashYieldState,
): Promise<void> {
  hash.update(`{"key":${canonicalJson(metadata.key)},"valueBase64":"`);
  let rowStreamedBytes = 0;
  for (
    let offset = 1;
    rowStreamedBytes < metadata.valueBytes;
    offset += CHAT_VALUE_STREAM_CHUNK_BYTES
  ) {
    const expectedBytes = Math.min(
      CHAT_VALUE_STREAM_CHUNK_BYTES,
      metadata.valueBytes - rowStreamedBytes,
    );
    yieldState.onValueChunkRead?.();
    const row = valueChunk.get(
      offset,
      expectedBytes,
      metadata.key,
    ) as { value?: SqliteRowValue } | undefined;
    if (!(row?.value instanceof Uint8Array)) {
      throw new Error(`Could not stream cursorDiskKV value ${metadata.key}.`);
    }
    const chunk = Buffer.from(row.value);
    if (chunk.byteLength !== expectedBytes) {
      throw new Error(`cursorDiskKV value ${metadata.key} changed while streaming.`);
    }
    hash.update(chunk.toString("base64"));
    rowStreamedBytes += chunk.byteLength;
    yieldState.streamedBytes += chunk.byteLength;
    if (yieldState.streamedBytes >= yieldState.nextYieldAt) {
      do {
        yieldState.nextYieldAt += CHAT_VALUE_STREAM_YIELD_BYTES;
      } while (yieldState.nextYieldAt <= yieldState.streamedBytes);
      yieldState.onYield?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  hash.update(`","valueType":${canonicalJson(metadata.valueType)}}`);
}

interface StreamHashYieldState {
  streamedBytes: number;
  nextYieldAt: number;
  onYield?: () => void;
  onValueChunkRead?: () => void;
}

function normalizeKvMetadata(metadata: RawKvMetadata): PortableKvMetadata {
  if (typeof metadata.key !== "string") {
    throw new Error("A cursorDiskKV key is not text.");
  }
  if (metadata.valueType === "null" && metadata.valueBytes === null) {
    return { key: metadata.key, valueType: "null", valueBytes: 0 };
  }
  if (metadata.valueType !== "text" && metadata.valueType !== "blob") {
    throw new Error(
      `cursorDiskKV key ${metadata.key} has an unsupported SQLite storage class: ${String(
        metadata.valueType,
      )}.`,
    );
  }
  const valueBytes =
    typeof metadata.valueBytes === "bigint"
      ? Number(metadata.valueBytes)
      : metadata.valueBytes;
  if (
    typeof valueBytes !== "number" ||
    !Number.isSafeInteger(valueBytes) ||
    valueBytes < 0
  ) {
    throw new Error(`cursorDiskKV value ${metadata.key} has an invalid length.`);
  }
  return { key: metadata.key, valueType: metadata.valueType, valueBytes };
}

function analyzeChatCore(
  header: PortableComposerHeader,
  composerData: RawKvRow,
  bubbles: Iterable<RawKvRow>,
): ChatCoreAnalysis {
  const composerPortable = portableRow(composerData);
  const hash = createHash("sha256");
  hash.update('{"bubbles":[');
  let first = true;
  for (const bubble of bubbles) {
    const portable = portableRow(bubble);
    if (!first) {
      hash.update(",");
    }
    first = false;
    hash.update(canonicalJson(portable));
  }
  hash.update('],"composerData":');
  hash.update(canonicalJson(composerPortable));
  hash.update(',"composerId":');
  updateCanonicalJsonString(hash, header.composerId);
  hash.update(',"header":');
  updatePortableComposerHeaderHash(hash, header);
  hash.update(',"schemaVersion":1}');
  return { coreHash: hash.digest("hex") };
}

function collectRawConversationStates(
  composerData: RawKvRow,
  bubbles: readonly RawKvRow[],
): PortableChatConversationStateScan {
  const states: string[] = [];
  const budget = createJsonStructureBudget();
  if (!appendRawConversationState(composerData, budget, states)) {
    return { status: "structure-limit" };
  }
  for (const row of bubbles) {
    if (!appendRawConversationState(row, budget, states)) {
      return { status: "structure-limit" };
    }
  }
  return { status: "complete", states };
}

function appendRawConversationState(
  row: RawKvRow,
  budget: JsonStructureBudget,
  states: string[],
): boolean {
  let text: string;
  if (row.valueType === "text" && typeof row.value === "string") {
    if (!budget.consume(row.value)) {
      return false;
    }
    text = row.value;
  } else if (row.valueType === "blob" && row.value instanceof Uint8Array) {
    const bytes = Buffer.from(
      row.value.buffer,
      row.value.byteOffset,
      row.value.byteLength,
    );
    if (!budget.consume(bytes)) {
      return false;
    }
    text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(row.value)) {
      return true;
    }
  } else {
    return true;
  }
  const state = conversationStateFromJsonText(text);
  if (state !== null) {
    states.push(state);
  }
  return true;
}

type AgentKvCapture =
  | { kind: "v2"; payload: PortableAgentKvPayload }
  | { kind: "fallback"; notice: string };

async function captureAgentKvPayload(
  statement: ChatStatement,
  stateScan: PortableChatConversationStateScan | null,
  budget: AgentKvScanBudget,
  recaptureRequested = false,
  maxGraphBytes = MAX_AGENT_KV_BYTES_PER_CHAT,
): Promise<AgentKvCapture> {
  if (stateScan === null) {
    return {
      kind: "fallback",
      notice:
        "Kept one chat on schema v1 because this scan reached its bounded agentKv graph-work budget; repository enrichment can upgrade it later.",
    };
  }
  if (stateScan.status === "structure-limit") {
    return {
      kind: "fallback",
      notice:
        "Kept one chat on schema v1 because its decoded conversation JSON exceeds the fixed structural parser safety limit; its core conversation remains synchronized.",
    };
  }
  const states = stateScan.states;
  if (states.length === 0) {
    if (recaptureRequested) {
      budget.reservedRecaptureGraphCaptures = Math.max(
        0,
        budget.reservedRecaptureGraphCaptures - 1,
      );
    }
    return {
      kind: "v2",
      payload: { blobs: [], referencedIds: [], missingIds: [] },
    };
  }
  if (maxGraphBytes <= 0) {
    return {
      kind: "fallback",
      notice:
        "Kept one chat on schema v1 because its mutable core left no room inside the fixed live-capture work budget for agentKv blobs; use a bounded offline recovery for that unusually large conversation.",
    };
  }
  // `states` is collected only while this predicate is true. Keep the check as
  // a defensive invariant for future callers and concurrent refactors.
  if (budget.remainingGraphCaptures <= 0) {
    throw new Error("agentKv graph capture exceeded its per-scan budget");
  }
  if (
    !recaptureRequested &&
    budget.remainingGraphCaptures <= budget.reservedRecaptureGraphCaptures
  ) {
    throw new Error("agentKv graph capture consumed a reserved recapture slot");
  }
  if (recaptureRequested) {
    budget.reservedRecaptureGraphCaptures = Math.max(
      0,
      budget.reservedRecaptureGraphCaptures - 1,
    );
  }
  budget.remainingGraphCaptures -= 1;
  const walked = await walkAgentKvReachability(states, (key, remainingBytes) =>
    lookupAgentKvBlob(statement, key, remainingBytes),
    {
      limits: {
        maxNodes: MAX_AGENT_KV_NODES_PER_CHAT,
        maxBytes: Math.min(MAX_AGENT_KV_BYTES_PER_CHAT, maxGraphBytes),
      },
    },
  );
  if (walked.limitReasons.length > 0) {
    return {
      kind: "fallback",
      notice: `Kept one chat on schema v1 because its agentKv reachability exceeded the ${walked.limitReasons.join(", ")} safety limit; its core conversation remains synchronized.`,
    };
  }
  if (
    walked.unreadable.some((issue) => issue.source === "conversation-state")
  ) {
    return {
      kind: "fallback",
      notice:
        "Kept one chat on schema v1 because its conversationState format is not safely readable; its core conversation remains synchronized.",
    };
  }
  const blobs: PortableKvRow[] = walked.blobs.map((blob) => {
    if (blob.valueType !== "text" && blob.valueType !== "blob") {
      throw new Error(`agentKv blob ${blob.key} lost its SQLite storage class.`);
    }
    return {
      key: blob.key,
      valueBase64: blob.bytes.toString("base64"),
      valueType: blob.valueType,
    };
  });
  const referencedIds = [
    ...new Set([
      ...walked.blobs.map((blob) => blob.id),
      ...walked.unavailableIds,
    ]),
  ].sort();
  const missingIds = [...walked.unavailableIds].sort();
  return {
    kind: "v2",
    payload: { blobs, referencedIds, missingIds },
  };
}

function lookupAgentKvBlob(
  statement: ChatStatement,
  key: string,
  remainingBytes: number,
): AgentKvBlobLookupResult {
  const row = statement.get(remainingBytes, key) as RawKvRow | undefined;
  if (row === undefined) {
    return { status: "missing" };
  }
  if (typeof row.key !== "string") {
    return { status: "unreadable", reason: "agentKv key is not text" };
  }
  const valueBytes = plainNumber(row.valueBytes ?? null);
  if (valueBytes === null || valueBytes < 0) {
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
      key: row.key,
      bytes: Buffer.from(row.value, "utf8"),
      valueType: "text",
    };
  }
  if (row.valueType === "blob" && row.value instanceof Uint8Array) {
    return {
      status: "found",
      key: row.key,
      // The walker makes the one stable copy it retains. Copying here as well
      // doubles peak memory for every admitted SQLite BLOB.
      bytes: row.value,
      valueType: "blob",
    };
  }
  return {
    status: "unreadable",
    reason: `unsupported SQLite storage class: ${String(row.valueType)}`,
  };
}

/**
 * Index-friendly bounds for every bubble row belonging to one composer.
 *
 * Cursor's keys use `bubbleId:<uuid>:<bubble>`. `:` and its immediate ASCII
 * successor `;` form an exact half-open prefix range under SQLite's default
 * BINARY collation. Unlike `LIKE ?`, this remains an index range when the
 * prefix is bound at runtime and avoids scanning the 1+ GiB cursorDiskKV
 * covering index on every poll.
 */
export function bubbleKeyRange(composerId: string): [string, string] {
  return [`bubbleId:${composerId}:`, `bubbleId:${composerId};`];
}

function currentBubbleCount(
  statement: ChatStatement,
  composerId: string,
  onProbe?: () => void,
): number {
  onProbe?.();
  const total = plainNumber(
    (
      statement.get(
        ...bubbleKeyRange(composerId),
        MAX_CHAT_CORE_METADATA_ROWS + 1,
      ) as
        | { total?: SqliteRowValue }
        | undefined
    )?.total ?? 0,
  );
  return total ?? 0;
}

/**
 * Records a cheap future change signal only after exact semantic bytes were
 * proven equal to the projection. This upgrades legacy projections in place
 * without publishing hundreds of duplicate multi-megabyte chat snapshots.
 */
function rememberObservedChatSource(
  projection: LocalProjection,
  lastUpdatedAt: number | null,
  bubbleCount: number,
  coreHash: string,
  headerFingerprint: string,
): void {
  if (lastUpdatedAt === null) {
    delete projection.sourceTimestamp;
  } else {
    projection.sourceTimestamp = lastUpdatedAt;
  }
  projection.sourceBubbleCount = bubbleCount;
  projection.sourceChatCoreHash = coreHash;
  projection.sourceHeaderFingerprint = headerFingerprint;
}

/**
 * O(1) change signal for the live SQLite file.
 *
 * Cursor uses WAL mode, so looking only at state.vscdb misses nearly every
 * running-session commit. Size plus nanosecond timestamps and file identity for
 * both files catches WAL append/reset/checkpoint and database replacement
 * without opening SQLite or reading the multi-gigabyte database. `-shm` is
 * deliberately absent: readers update it for lock coordination without
 * changing durable data, which would defeat the idle fast path.
 */
async function stateVscdbFingerprint(databasePath: string): Promise<string> {
  const [database, wal] = await Promise.all([
    fileFingerprint(databasePath, false, 100),
    fileFingerprint(`${databasePath}-wal`, true, 32),
  ]);
  return sha256(`${database}\n${wal}`);
}

async function fileFingerprint(
  path: string,
  optional: boolean,
  headerLength: number,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const before = await handle.stat({ bigint: true });
    const header = Buffer.allocUnsafe(headerLength);
    let bytesRead = 0;
    while (bytesRead < headerLength) {
      const result = await handle.read(
        header,
        bytesRead,
        headerLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    return [
      before.dev,
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
      before.birthtimeNs,
      after.size,
      after.mtimeNs,
      after.ctimeNs,
      sha256(header.subarray(0, bytesRead)),
    ].join(":");
  } catch (error) {
    if (optional && errorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function projectionObservationFingerprint(
  projection: LocalProjection | undefined,
): string {
  if (projection?.kind !== "chat") {
    return "absent";
  }
  return sha256(
    [
      projection.semanticHash,
      projection.retainedLocalHash ?? "",
      projection.versionId ?? "",
      projection.sourceTimestamp?.toString() ?? "",
      projection.sourceBubbleCount?.toString() ?? "",
      projection.sourceChatCoreHash ?? "",
      projection.sourceHeaderFingerprint ?? "",
      projection.requiresAgentKvRecapture === true ? "1" : "0",
    ].join("\0"),
  );
}

interface HeaderMetadataPreflight {
  /** Numeric/small fields normalized without fetching workspaceId or value. */
  header: PortableComposerHeader;
  /** Exact for scalar fields, conservative for unescaped TEXT fields. */
  canonicalByteLowerBound: number;
  /** Raw workspace/value bytes crossing the SQLite boundary on exact fetch. */
  materializationBytes: number;
  /** Bounded identity for retaining a header-only oversized observation. */
  fingerprint: string;
}

function preflightHeaderMetadata(
  metadata: RawComposerHeaderMetadata,
  composerId: string,
): HeaderMetadataPreflight {
  const composerIdBytes = sqliteNonnegativeSafeInteger(
    metadata.composerIdBytes,
    "composer header ID length",
  );
  if (
    (metadata.composerIdType !== "text" &&
      metadata.composerIdType !== "blob") ||
    composerIdBytes > MAX_COMPOSER_ID_BYTES
  ) {
    throw new Error("composerHeaders.composerId is not a bounded TEXT/BLOB ID.");
  }
  const workspaceBytes = nullableHeaderTextBytes(
    metadata.workspaceIdType,
    metadata.workspaceIdBytes,
    "workspaceId",
  );
  const valueBytes = nullableHeaderTextBytes(
    metadata.valueType,
    metadata.valueBytes,
    "value",
  );
  const header: PortableComposerHeader = {
    composerId,
    workspaceId: null,
    createdAt: metadataHeaderNumber(
      metadata.createdAt,
      metadata.createdAtType,
      "createdAt",
    ),
    lastUpdatedAt: metadataHeaderNumber(
      metadata.lastUpdatedAt,
      metadata.lastUpdatedAtType,
      "lastUpdatedAt",
    ),
    isArchived: metadataHeaderNumber(
      metadata.isArchived,
      metadata.isArchivedType,
      "isArchived",
    ),
    isSubagent: metadataHeaderNumber(
      metadata.isSubagent,
      metadata.isSubagentType,
      "isSubagent",
    ),
    recency: metadataHeaderNumber(
      metadata.recency,
      metadata.recencyType,
      "recency",
    ),
    checkpointAt: metadataHeaderNumber(
      metadata.checkpointAt,
      metadata.checkpointAtType,
      "checkpointAt",
    ),
    value: null,
  };
  let canonicalByteLowerBound =
    portableComposerHeaderCanonicalByteLength(header);
  if (workspaceBytes !== null) {
    canonicalByteLowerBound += workspaceBytes + 2 - 4;
  }
  if (valueBytes !== null) {
    canonicalByteLowerBound += valueBytes + 2 - 4;
  }
  if (!Number.isSafeInteger(canonicalByteLowerBound)) {
    throw new Error("Composer header raw length exceeds the safe integer range.");
  }
  const hash = createHash("sha256");
  hash.update("composer-header-metadata-v1\0");
  for (const part of [
    metadata.composerIdType,
    composerIdBytes,
    composerId,
    metadata.workspaceIdType,
    workspaceBytes,
    header.createdAt,
    metadata.createdAtType,
    header.lastUpdatedAt,
    metadata.lastUpdatedAtType,
    header.isArchived,
    metadata.isArchivedType,
    header.isSubagent,
    metadata.isSubagentType,
    header.recency,
    metadata.recencyType,
    header.checkpointAt,
    metadata.checkpointAtType,
    metadata.valueType,
    valueBytes,
  ] satisfies readonly SqliteRowValue[]) {
    hash.update(sqliteFingerprintPart(part));
    hash.update("\0");
  }
  return {
    header,
    canonicalByteLowerBound,
    materializationBytes: (workspaceBytes ?? 0) + (valueBytes ?? 0),
    fingerprint: `metadata:${hash.digest("hex")}`,
  };
}

function portableHeaderFingerprint(header: PortableComposerHeader): string {
  const hash = createHash("sha256");
  updatePortableComposerHeaderHash(hash, header);
  return hash.digest("hex");
}

function readBoundedHeader(
  statement: ChatStatement,
  headerKey: SqliteRowValue,
  composerId: string,
  maxHeaderBytes: number,
): PortableComposerHeader {
  const row = statement.get(maxHeaderBytes, headerKey) as
    | RawBoundedComposerHeader
    | undefined;
  if (row === undefined) {
    throw new Error("composer header disappeared during its bounded fetch.");
  }
  return normalizeBoundedHeader(row, composerId);
}

function normalizeBoundedHeader(
  header: RawBoundedComposerHeader,
  composerId: string,
): PortableComposerHeader {
  if (header.headerWithinBound !== 1) {
    throw new Error(
      "composer header changed, has invalid storage classes, or exceeds the bounded value-fetch limit.",
    );
  }
  if (headerIsMainComposer(header) !== true) {
    throw new Error("composer header is no longer a supported main chat.");
  }
  // Revalidate all compact metadata from the same SQLite statement. This
  // catches a type/length mutation between the listing and guarded fetch.
  preflightHeaderMetadata(header, composerId);
  return normalizeHeader(header, composerId);
}

function headerIsMainComposer(
  header: Pick<
    RawComposerHeaderMetadata,
    "isSubagent" | "isSubagentType"
  >,
): boolean | null {
  try {
    const value = metadataHeaderNumber(
      header.isSubagent,
      header.isSubagentType,
      "isSubagent",
    );
    return value === null || value === 0;
  } catch {
    return null;
  }
}

function nullableHeaderTextBytes(
  valueType: SqliteRowValue,
  valueBytes: SqliteRowValue,
  column: string,
): number | null {
  if (valueType === "null" && valueBytes === null) {
    return null;
  }
  if (valueType !== "text") {
    throw new Error(
      `composerHeaders.${column} has an unsupported SQLite storage class.`,
    );
  }
  return sqliteNonnegativeSafeInteger(
    valueBytes,
    `composer header ${column} length`,
  );
}

function metadataHeaderNumber(
  value: SqliteRowValue,
  valueType: SqliteRowValue,
  column: string,
): number | null {
  if (valueType === "null" && value === null) {
    return null;
  }
  if (valueType === "integer") {
    const normalized = typeof value === "bigint" ? Number(value) : value;
    if (
      typeof normalized === "number" &&
      Number.isSafeInteger(normalized)
    ) {
      return normalized;
    }
  } else if (
    valueType === "real" &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }
  throw new Error(
    `composerHeaders.${column} has an unsupported or unsafe SQLite value.`,
  );
}

function sqliteFingerprintPart(value: SqliteRowValue): string {
  if (value === null) {
    return "null";
  }
  if (value instanceof Uint8Array) {
    return `blob:${Buffer.from(value).toString("base64")}`;
  }
  if (typeof value === "bigint") {
    return `bigint:${value.toString()}`;
  }
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? "-0" : value.toString()}`;
  }
  return `text:${value}`;
}

function normalizeHeader(
  header: RawComposerHeader,
  composerId: string,
): PortableComposerHeader {
  return {
    // The caller resolved this from the raw column value; a BLOB-affinity
    // composerId carries the same UUID text as every other reference to it.
    composerId,
    workspaceId: nullableText(header.workspaceId, "workspaceId"),
    createdAt: nullableNumber(header.createdAt, "createdAt"),
    lastUpdatedAt: nullableNumber(header.lastUpdatedAt, "lastUpdatedAt"),
    isArchived: nullableNumber(header.isArchived, "isArchived"),
    isSubagent: nullableNumber(header.isSubagent, "isSubagent"),
    recency: nullableNumber(header.recency, "recency"),
    checkpointAt: nullableNumber(header.checkpointAt, "checkpointAt"),
    value: nullableText(header.value, "value"),
  };
}

// Coercing an unexpected storage class here would publish fabricated data: a
// BLOB would become its comma-joined bytes, and a non-numeric value would
// become NaN, which canonicalization turns into a NULL that overwrites the
// target's real value. Rejecting instead lets the caller skip the composer.
function nullableText(value: SqliteRowValue, column: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      `composerHeaders.${column} has an unsupported SQLite storage class.`,
    );
  }
  return value;
}

function nullableNumber(value: SqliteRowValue, column: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `composerHeaders.${column} has an unsupported SQLite storage class.`,
    );
  }
  return value;
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
    `cursorDiskKV key ${row.key} has an unsupported SQLite storage class: ${String(
      row.valueType,
    )}.`,
  );
}

/** A SQLite value usable as a change timestamp, or null if it is not one. */
function plainNumber(value: SqliteRowValue): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readComposerHeaderMetadataPage(
  database: DatabaseSync,
  cursor: HeaderMetadataCursor | null,
  phase: "header" | "bubble-count" | "deep-verification",
  onRow?: StateVscdbChatAdapterOptions["onHeaderMetadataRow"],
): RawPagedComposerHeaderMetadata[] {
  const statement = database.prepare(
    cursor === null
      ? COMPOSER_HEADER_METADATA_FIRST_PAGE_SQL
      : COMPOSER_HEADER_METADATA_AFTER_CURSOR_SQL,
  );
  const rows: RawPagedComposerHeaderMetadata[] = [];
  const arguments_: [number | bigint, number] =
    cursor === null
      ? [MIN_SQLITE_ROWID, MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE]
      : [cursor.rowId, MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE];
  for (const row of statement.iterate(...arguments_)) {
    onRow?.(phase);
    rows.push(row as RawPagedComposerHeaderMetadata);
  }
  return rows;
}

function readInitialGraphPriorityResourceIds(
  database: DatabaseSync,
): Set<string> {
  const rows = [
    ...database
      .prepare(COMPOSER_HEADER_RECENT_PAGE_SQL)
      .iterate(MAX_SQLITE_ROWID, MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE),
  ] as RawPagedComposerHeaderMetadata[];
  rows.sort(compareChatHeadersForCapture);
  const resourceIds: string[] = [];
  for (const row of rows) {
    const composerId = composerIdText(row.composerId);
    if (
      composerId === null ||
      !COMPOSER_ID_PATTERN.test(composerId) ||
      headerIsMainComposer(row) !== true
    ) {
      continue;
    }
    resourceIds.push(`chat/${composerId}`);
    if (resourceIds.length >= MAX_AGENT_KV_GRAPH_CAPTURES_PER_SCAN) {
      break;
    }
  }
  return new Set(resourceIds);
}

function compareChatHeadersForCapture(
  left: RawComposerHeaderMetadata,
  right: RawComposerHeaderMetadata,
): number {
  const leftUpdatedAt = plainNumber(left.lastUpdatedAt);
  const rightUpdatedAt = plainNumber(right.lastUpdatedAt);
  if (leftUpdatedAt !== null && rightUpdatedAt !== null) {
    if (leftUpdatedAt !== rightUpdatedAt) {
      return leftUpdatedAt > rightUpdatedAt ? -1 : 1;
    }
  } else if (leftUpdatedAt !== null) {
    return -1;
  } else if (rightUpdatedAt !== null) {
    return 1;
  }
  const leftId =
    composerIdText(left.composerId) ?? sqliteFingerprintPart(left.composerId);
  const rightId =
    composerIdText(right.composerId) ?? sqliteFingerprintPart(right.composerId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function headerMetadataCursor(
  header: RawPagedComposerHeaderMetadata,
): HeaderMetadataCursor {
  const rowId = header.headerRowId;
  if (
    (typeof rowId !== "number" || !Number.isSafeInteger(rowId)) &&
    typeof rowId !== "bigint"
  ) {
    throw new Error("composer header row ID is invalid.");
  }
  return { rowId };
}

const MAX_COMPOSER_ID_BYTES = 128;
/** Compact composerHeaders rows crossing the native boundary per SQL page. */
export const MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE = 64;
const MAX_CHAT_PROJECTION_FINGERPRINT_MEMO = 4_096;
const MIN_SQLITE_ROWID = -9_223_372_036_854_775_808n;
const MAX_SQLITE_ROWID = 9_223_372_036_854_775_807n;

const COMPOSER_HEADER_METADATA_COLUMNS_SQL =
  "rowid AS headerRowId, " +
  "CASE WHEN typeof(composerId) IN ('text', 'blob') " +
  `AND length(CAST(composerId AS BLOB)) <= ${MAX_COMPOSER_ID_BYTES} ` +
  "THEN composerId ELSE NULL END AS composerId, " +
  "typeof(composerId) AS composerIdType, " +
  "length(CAST(composerId AS BLOB)) AS composerIdBytes, " +
  "typeof(workspaceId) AS workspaceIdType, " +
  "length(CAST(workspaceId AS BLOB)) AS workspaceIdBytes, " +
  `${boundedHeaderNumberSql("createdAt")} AS createdAt, ` +
  "typeof(createdAt) AS createdAtType, " +
  `${boundedHeaderNumberSql("lastUpdatedAt")} AS lastUpdatedAt, ` +
  "typeof(lastUpdatedAt) AS lastUpdatedAtType, " +
  `${boundedHeaderNumberSql("isArchived")} AS isArchived, ` +
  "typeof(isArchived) AS isArchivedType, " +
  `${boundedHeaderNumberSql("isSubagent")} AS isSubagent, ` +
  "typeof(isSubagent) AS isSubagentType, " +
  `${boundedHeaderNumberSql("recency")} AS recency, ` +
  "typeof(recency) AS recencyType, " +
  `${boundedHeaderNumberSql("checkpointAt")} AS checkpointAt, ` +
  "typeof(checkpointAt) AS checkpointAtType, " +
  "typeof(value) AS valueType, " +
  "length(CAST(value AS BLOB)) AS valueBytes";

const COMPOSER_HEADER_METADATA_FIRST_PAGE_SQL =
  `SELECT ${COMPOSER_HEADER_METADATA_COLUMNS_SQL} ` +
  "FROM composerHeaders WHERE rowid >= ?1 " +
  "ORDER BY rowid ASC LIMIT ?2";

/** Exported narrowly so regression tests can pin the indexed query plan. */
export const COMPOSER_HEADER_METADATA_AFTER_CURSOR_SQL =
  `SELECT ${COMPOSER_HEADER_METADATA_COLUMNS_SQL} ` +
  "FROM composerHeaders WHERE rowid > ?1 " +
  "ORDER BY rowid ASC LIMIT ?2";

/** One bounded recent-insertion window used only for fresh graph priority. */
export const COMPOSER_HEADER_RECENT_PAGE_SQL =
  `SELECT ${COMPOSER_HEADER_METADATA_COLUMNS_SQL} ` +
  "FROM composerHeaders WHERE rowid <= ?1 " +
  "ORDER BY rowid DESC LIMIT ?2";

function boundedHeaderNumberSql(column: string): string {
  return (
    `CASE WHEN typeof(${column}) = 'null' THEN NULL ` +
    `WHEN typeof(${column}) = 'integer' ` +
    `AND ${column} BETWEEN -9007199254740991 AND 9007199254740991 ` +
    `THEN ${column} WHEN typeof(${column}) = 'real' ` +
    `AND ${column} >= -1.7976931348623157e308 ` +
    `AND ${column} <= 1.7976931348623157e308 THEN ${column} ` +
    "ELSE NULL END"
  );
}
/** Safety ceiling used only by callers that have not supplied repository policy. */
const MAX_UNCONFIGURED_HEADER_MATERIALIZE_BYTES = 8 * 1024 * 1024;

const BOUNDED_HEADER_CONDITION =
  "typeof(composerId) IN ('text', 'blob') " +
  `AND length(CAST(composerId AS BLOB)) <= ${MAX_COMPOSER_ID_BYTES} ` +
  "AND typeof(workspaceId) IN ('text', 'null') " +
  "AND typeof(createdAt) IN ('integer', 'real', 'null') " +
  "AND typeof(lastUpdatedAt) IN ('integer', 'real', 'null') " +
  "AND typeof(isArchived) IN ('integer', 'real', 'null') " +
  "AND typeof(isSubagent) IN ('integer', 'real', 'null') " +
  "AND typeof(recency) IN ('integer', 'real', 'null') " +
  "AND typeof(checkpointAt) IN ('integer', 'real', 'null') " +
  "AND typeof(value) IN ('text', 'null') " +
  "AND COALESCE(length(CAST(workspaceId AS BLOB)), 0) + " +
  "COALESCE(length(CAST(value AS BLOB)), 0) <= ?1";

/**
 * One-row exact fetch whose CASE guards are evaluated inside SQLite. Neither
 * large text field crosses the native boundary unless their aggregate raw
 * bytes are within the caller's payload-derived budget.
 */
const BOUNDED_COMPOSER_HEADER_SQL =
  "SELECT composerId, " +
  "typeof(composerId) AS composerIdType, length(CAST(composerId AS BLOB)) AS composerIdBytes, " +
  `CASE WHEN ${BOUNDED_HEADER_CONDITION} THEN workspaceId ELSE NULL END AS workspaceId, ` +
  "typeof(workspaceId) AS workspaceIdType, length(CAST(workspaceId AS BLOB)) AS workspaceIdBytes, " +
  "CASE WHEN typeof(createdAt) IN ('integer', 'real', 'null') THEN createdAt ELSE NULL END AS createdAt, " +
  "typeof(createdAt) AS createdAtType, " +
  "CASE WHEN typeof(lastUpdatedAt) IN ('integer', 'real', 'null') THEN lastUpdatedAt ELSE NULL END AS lastUpdatedAt, " +
  "typeof(lastUpdatedAt) AS lastUpdatedAtType, " +
  "CASE WHEN typeof(isArchived) IN ('integer', 'real', 'null') THEN isArchived ELSE NULL END AS isArchived, " +
  "typeof(isArchived) AS isArchivedType, " +
  "CASE WHEN typeof(isSubagent) IN ('integer', 'real', 'null') THEN isSubagent ELSE NULL END AS isSubagent, " +
  "typeof(isSubagent) AS isSubagentType, " +
  "CASE WHEN typeof(recency) IN ('integer', 'real', 'null') THEN recency ELSE NULL END AS recency, " +
  "typeof(recency) AS recencyType, " +
  "CASE WHEN typeof(checkpointAt) IN ('integer', 'real', 'null') THEN checkpointAt ELSE NULL END AS checkpointAt, " +
  "typeof(checkpointAt) AS checkpointAtType, " +
  `CASE WHEN ${BOUNDED_HEADER_CONDITION} THEN value ELSE NULL END AS value, ` +
  "typeof(value) AS valueType, length(CAST(value AS BLOB)) AS valueBytes, " +
  `CASE WHEN ${BOUNDED_HEADER_CONDITION} THEN 1 ELSE 0 END AS headerWithinBound ` +
  "FROM composerHeaders WHERE composerId = ?2";

const COMPOSER_ID_PATTERN =
  /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const AGENT_KV_ID_PATTERN = /^[0-9a-f]{64}$/;
const AGENT_KV_BLOB_KEY_PATTERN = /^agentKv:blob:[0-9a-f]{64}$/;
/** Parser-side hard stop; upstream payload limits are normally much lower. */
const MAX_AGENT_KV_ENTRIES = 250_000;
const MAX_AGENT_KV_TOTAL_BYTES = 512 * 1024 * 1024;
/**
 * Initial sync can discover hundreds of unprojected chats at once. Only two
 * content graphs are retained in one adapter result, and each graph has a much
 * smaller live-capture cap than the parser's compatibility ceiling. Remaining
 * chats still publish safe v1 cores and can be upgraded by bounded enrichment.
 */
const MAX_AGENT_KV_GRAPH_CAPTURES_PER_SCAN = 2;
const MAX_AGENT_KV_NODES_PER_CHAT = 4_096;
const MAX_AGENT_KV_BYTES_PER_CHAT = 32 * 1024 * 1024;
/**
 * Hard per-conversation extension-host work bound, independent of the
 * repository's configurable publish ceiling (which may be as high as 512 MiB).
 * Larger cores are streamed into a lightweight settlement and never cross the
 * SQLite value boundary as one retained bubble array.
 */
export const MAX_CHAT_INTERACTIVE_CAPTURE_BYTES = 32 * 1024 * 1024;
/** Prevents a corrupt/tiny-row DB from turning one scan into an unbounded loop. */
export const MAX_CHAT_CORE_METADATA_ROWS = 16_384;
/** JSON keys, referenced-ID arrays and Base64 expansion room for a v2 graph. */
const CHAT_AGENT_KV_CANONICAL_HEADROOM_BYTES = 2 * 1024 * 1024;
/**
 * Bounds full mutable-core reads that can otherwise all miss the cheap header
 * fast path together after setup, upgrade, or a repository-side projection
 * change. The cursor above makes this a throughput cap, not starvation.
 */
export const MAX_CHAT_BODY_CAPTURES_PER_SCAN = 32;
/** Exact header fetches are independently bounded before any body-work cap. */
export const MAX_CHAT_HEADER_MATERIALIZATIONS_PER_SCAN = 64;
/**
 * Aggregate raw workspace/value bytes crossing SQLite in one poll. One header
 * is always admitted, so an individually large but policy-valid row advances
 * the persistent cursor instead of starving forever.
 */
export const MAX_CHAT_HEADER_BYTES_PER_SCAN = 8 * 1024 * 1024;
/** Indexed range counts spread across polls after a DB/WAL generation change. */
export const MAX_CHAT_BUBBLE_COUNT_PROBES_PER_SCAN = 64;
/** Backpressure boundary between the cheap COUNT cursor and body capture. */
export const MAX_CHAT_PENDING_BUBBLE_COUNT_MISMATCHES = 64;
/** Exact lightweight oversized identities retained across live polls. */
export const MAX_CHAT_OVERSIZED_SETTLEMENTS = 64;
/** Per-resource examples emitted before one aggregate overflow warning. */
export const MAX_CHAT_OVERSIZED_WARNING_SAMPLES = 5;
/** Internal deferred marker; it is never a publishable chat resource. */
export const CHAT_OVERSIZED_SETTLEMENT_OVERFLOW_RESOURCE_ID =
  "chat/__oversized-settlement-overflow__";
/**
 * Soft aggregate cap for canonical snapshots retained in one adapter result.
 * One chat is always admitted so an individually large but publishable
 * conversation cannot starve forever; later chats resume on the next scan.
 */
export const MAX_CHAT_SNAPSHOT_BYTES_PER_SCAN = 8 * 1024 * 1024;
const BODYLESS_SAMPLE_SIZE = 5;
/**
 * Bounds the fallback audit for equal-timestamp/equal-count edits.
 *
 * Normal chat growth is selected immediately by its header or bubble count.
 * This round-robin exists only for the rare in-place edit that changes neither.
 * Sixteen real conversations could allocate hundreds of MiB and monopolize an
 * extension-host core for most of a 30-second poll; four retains eventual full
 * coverage while keeping each burst small enough for interactive Cursor use.
 */
const DEEP_VERIFICATION_BATCH_SIZE = 4;

/** Equal-count core auditing cadence after one complete bounded pass. */
export const CHAT_DEEP_VERIFICATION_INTERVAL_MS = 15 * 60 * 1000;

/** Divisible by three so independently encoded chunks concatenate as Base64. */
const CHAT_VALUE_STREAM_CHUNK_BYTES = 192 * 1024;
const CHAT_VALUE_STREAM_YIELD_BYTES = CHAT_VALUE_STREAM_CHUNK_BYTES * 32;

/**
 * Whether a composer ID names a chat this build can carry between devices.
 *
 * The scan already refuses to publish anything else; exported so the inbound
 * side can refuse the same set, which it has to, because a resource the scan
 * will not produce is one nothing can ever observe as applied.
 */
export function isSyncableComposerId(composerId: string): boolean {
  return COMPOSER_ID_PATTERN.test(composerId);
}

/**
 * Resolves the identity of a composer header row. SQLite column affinity does
 * not stop a BLOB from landing in `composerHeaders.composerId`, and node:sqlite
 * hands those back as a Uint8Array; the bytes are the same UUID text Cursor
 * writes everywhere else, so decoding them recovers a usable identity. Anything
 * that is not a chat ID afterwards is not something we can match against the
 * known projections, and the caller must not guess.
 */
function composerIdText(value: SqliteRowValue): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    const decoded = Buffer.from(value).toString("utf8");
    return COMPOSER_ID_PATTERN.test(decoded) ? decoded : null;
  }
  return null;
}

/**
 * A header with no `composerData` row is usually Cursor keeping a list entry
 * after pruning the conversation, but a helper that wrote headers and then died
 * before the bodies looks exactly the same. The message therefore states what
 * was observed and carries IDs, so a mass loss is diagnosable instead of
 * reading as one reassuring line.
 */
function bodylessChatsWarning(composerIds: readonly string[]): string {
  const sample = composerIds.slice(0, BODYLESS_SAMPLE_SIZE).join(", ");
  const remainder = composerIds.length - Math.min(
    composerIds.length,
    BODYLESS_SAMPLE_SIZE,
  );
  return `Skipped ${composerIds.length} chat(s) whose conversation body is not in the database: ${sample}${
    remainder === 0 ? "" : ` and ${remainder} more`
  }. Expected when Cursor prunes a conversation and keeps its list entry; if you still expect one of these chats, its body was lost locally.`;
}

function interactiveChatCaptureWarning(
  resourceId: string,
  byteLength: number,
): string {
  const measuredMiB = (byteLength / 1024 / 1024).toFixed(1);
  const limitMiB = MAX_CHAT_INTERACTIVE_CAPTURE_BYTES / 1024 / 1024;
  return (
    `${resourceId} is at least ${measuredMiB} MiB and exceeds the fixed ` +
    `${limitMiB} MiB live chat-capture safety budget, so it was not ` +
    "materialized or published automatically. Other resources still sync. " +
    "Use the bounded Repair/Restore workflow for this unusually large chat, " +
    'or disable "cursorSettingSync.syncChat" if it should remain local.'
  );
}

function interactiveChatRowWorkWarning(
  resourceId: string,
  observedRows: number,
): string {
  return (
    `${resourceId} has more than ${MAX_CHAT_CORE_METADATA_ROWS.toLocaleString("en-US")} ` +
    `conversation rows (at least ${observedRows.toLocaleString("en-US")} observed) ` +
    "and exceeds the fixed live chat-capture work budget, so its values were " +
    "not read or published automatically. Other resources still sync. Use the " +
    "bounded Repair/Restore workflow for this unusually large chat, or disable " +
    '"cursorSettingSync.syncChat" if it should remain local.'
  );
}

function interactiveChatStructureWarning(resourceId: string): string {
  return (
    `${resourceId} exceeds the fixed ` +
    `${PORTABLE_RESOURCE_JSON_MAX_STRUCTURAL_TOKENS.toLocaleString("en-US")}-token ` +
    "portable chat JSON safety limit, so it was not published automatically. " +
    "Other resources still sync. Reduce or split this unusually large chat " +
    "before publishing it."
  );
}

/**
 * Says which conversations this computer stopped publishing because they shrank.
 *
 * Not a warning: nothing is broken and there is nothing to fix. It is the
 * record of this device declining to make its own pruning everyone's, and the
 * counts are what make a slow local erosion visible before the repository is
 * the only copy left.
 */
function prunedChatsNotice(entries: readonly string[]): string {
  const sample = entries.slice(0, BODYLESS_SAMPLE_SIZE).join(", ");
  const remainder = entries.length - Math.min(entries.length, BODYLESS_SAMPLE_SIZE);
  return `Held back ${entries.length} chat(s) that lost messages on this computer: ${sample}${
    remainder === 0 ? "" : ` and ${remainder} more`
  }. Cursor prunes conversation bodies per computer and messages are never deleted individually, so the fuller copy already in the shared folder is kept instead of being overwritten with this one.`;
}
