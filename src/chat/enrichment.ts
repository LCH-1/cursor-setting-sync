import { stat } from "node:fs/promises";
import type { SyncRepository } from "../protocol/repository";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import {
  JSON_STRUCTURE_MAX_DEPTH,
  JSON_STRUCTURE_MAX_TOKENS,
} from "../protocol/jsonStructure";
import type { JsonValue, ResourceSnapshot, ResourceTip } from "../types";
import { openDatabase, type DatabaseSync } from "../platform/sqlite";
import {
  effectiveSyncOrigin,
  effectiveTipProducer,
  producerAsMetadata,
} from "../sync/versionPolicy";
import {
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  scanPortableChatConversationStates,
  type PortableAgentKvPayload,
  type PortableChatSnapshot,
  type PortableChatSnapshotV2,
} from "./stateVscdb";
import {
  AGENT_KV_BLOB_PREFIX,
  DEFAULT_AGENT_KV_WALK_LIMITS,
  extractAgentKvRootIds,
  walkAgentKvReachability,
  type AgentKvBlobLookup,
} from "./agentKv";
import { verifyPortableChatContinuationClosure } from "./continuationClosure";

/**
 * Repository chat payloads inspected in one synchronization cycle.
 *
 * A real repository can contain thousands of conversations and each payload
 * must be decrypted before its v1/v2 status can be confirmed. Keeping this
 * deliberately small prevents migration work from recreating the periodic
 * CPU/RAM spikes that the bounded chat scanner avoids.
 */
export const CHAT_TIP_ENRICHMENT_BATCH_SIZE = 2;

/** Metadata candidates examined from a cached graph index in one cycle. */
export const CHAT_TIP_ENRICHMENT_CANDIDATE_PROBES_PER_CYCLE = 64;

/** No-op attempt identities retained without growing with total chat count. */
const CHAT_TIP_ENRICHMENT_ATTEMPT_CACHE_ENTRIES = 4_096;

/** Indexed lookups admitted for one chat during the one-time migration pass. */
export const CHAT_TIP_ENRICHMENT_MAX_NODES = 4_096;

/**
 * Fixed extension-host work envelope for one enrichment cycle. The configured
 * repository limit can be 512 MiB, but parsing and rebuilding even one payload
 * that large creates several simultaneous Buffers/JSON object graphs. Count
 * the authenticated source bytes plus retained enriched outputs and defer work
 * that cannot fit this small interactive budget.
 */
export const CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES = 32 * 1024 * 1024;

/** Keep bounded exact SQLite probes from monopolizing the extension host. */
const CHAT_TIP_ENRICHMENT_YIELD_EVERY_NODES = 64;

export interface ChatTipEnrichmentCursor {
  /** Last selected resource ID; selection resumes strictly after it. */
  afterResourceId: string | null;
  /** Next slot in a generation-keyed, prebuilt candidate index. */
  nextIndex?: number;
  candidateGeneration?: number;
}

export interface ChatTipAgentKvCollection {
  /**
   * Complete v2 payload after retaining repository blobs and adding local
   * ones. `null` is used only when a transient lookup prevented the walker
   * from producing a safe referenced-ID partition.
   */
  agentKv: PortableAgentKvPayload | null;
  /**
   * At least one exact-key lookup failed before SQLite could say whether the
   * row was present. The manager must not cache this attempt as an idle no-op.
   */
  retryable?: boolean;
  /**
   * The outcome depends only on this immutable tip and the configured payload
   * policy (for example an unreadable source state or a structural safety
   * limit), not on the live DB/WAL generation.
   */
  cacheUntilTipOrPolicyChanges?: boolean;
  /**
   * Sorted unique source `missingIds` whose exact live-DB lookup returned
   * `missing`. Only these IDs may be pruned from a portable source; omitted,
   * over-budget, unreadable and raced probes never grant prune authority.
   */
  provenAbsentSourceMissingIds?: readonly string[];
}

export interface ChatTipAgentKvContext {
  /** Exact decrypted current-tip payload size before enrichment. */
  sourceContentBytes: number;
  maxPayloadBytes: number;
  /** Preflighted once and shared by the empty-graph and live collectors. */
  conversationStates?: readonly string[];
}

/**
 * Reads only content-addressed blobs reachable from the exact repository
 * snapshot supplied here. Implementations must not substitute the local chat
 * core: that computer may already have fewer bubbles than the repository tip.
 */
export type CollectChatTipAgentKv = (
  snapshot: PortableChatSnapshot,
  context: ChatTipAgentKvContext,
) => Promise<ChatTipAgentKvCollection | null>;

export interface ChatTipEnrichmentOptions {
  cursor: ChatTipEnrichmentCursor;
  maxPayloadBytes: number;
  collectAgentKv: CollectChatTipAgentKv;
  /** Applies the normal database compatibility/policy gate to the source tip. */
  tipAllowed?: (tip: ResourceTip) => boolean;
  /** Test seam for a newer-tip race between planning and publication. */
  beforePublish?: () => void | Promise<void>;
  batchSize?: number;
  /**
   * Resource -> last `(tip, live DB generation, policy)` attempt. Owned by the
   * manager so an idle 30-second cycle does not decrypt and walk the same v1
   * tip forever on a computer that has no blobs to contribute.
   */
  attemptCache?: Map<string, string>;
  databaseGeneration?: string;
  forceRetry?: boolean;
  /**
   * Built alongside reconciliation and reused while its graph generation is
   * stable. This avoids enumerating and sorting every repository resource on
   * each idle 30-second poll.
   */
  candidateIndex?: readonly ChatTipEnrichmentCandidate[];
  candidateGeneration?: number;
}

export interface ChatTipEnrichmentResult {
  attempted: number;
  published: number;
  cursor: ChatTipEnrichmentCursor;
  warnings: string[];
  publishedResourceIds: string[];
}

export interface ChatTipEnrichmentCandidate {
  resourceId: string;
  tip: ResourceTip;
  expectedTipIds: string[];
}

interface PlannedEnrichment {
  candidate: ChatTipEnrichmentCandidate;
  snapshot: ResourceSnapshot;
}

/**
 * Adds locally available agentKv blobs to a bounded round-robin batch of the
 * repository's current chat tips.
 *
 * The repository payload, not the adapter's local scan, is the source of the
 * header/composerData/bubbles. This is the important migration invariant: a
 * machine whose live chat has been pruned from 115 bubbles to 111 can still
 * contribute hash-addressed blobs without publishing the 111-bubble core over
 * the newer repository version.
 */
export async function enrichCurrentChatTips(
  repository: SyncRepository,
  options: ChatTipEnrichmentOptions,
): Promise<ChatTipEnrichmentResult> {
  const indexedSelection =
    options.candidateIndex === undefined
      ? null
      : selectIndexedChatTipEnrichmentCandidates(
          options.candidateIndex,
          options.cursor,
          options.candidateGeneration ?? 0,
          options.batchSize,
          (candidate) => enrichmentAttemptDue(candidate, options),
        );
  const candidates =
    indexedSelection?.candidates ??
    selectChatTipEnrichmentCandidates(
      repository.state.tips,
      options.cursor,
      options.batchSize,
      (candidate) => enrichmentAttemptDue(candidate, options),
    );
  const cursor =
    indexedSelection?.cursor ??
    ({
      afterResourceId:
        candidates.at(-1)?.resourceId ??
        (candidates.length === 0 ? null : options.cursor.afterResourceId),
    } satisfies ChatTipEnrichmentCursor);
  const warnings: string[] = [];
  const plans: PlannedEnrichment[] = [];
  let retainedPlanBytes = 0;

  for (const candidate of candidates) {
    if (options.tipAllowed?.(candidate.tip) === false) {
      continue;
    }
    rememberEnrichmentAttempt(candidate, options);
    const declaredSourceBytes = candidate.tip.payload?.plainBytes;
    const availableWorkBytes =
      CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES - retainedPlanBytes;
    if (
      declaredSourceBytes === undefined ||
      declaredSourceBytes >= Math.ceil(availableWorkBytes / 2)
    ) {
      const permanentlyTooLarge =
        declaredSourceBytes === undefined ||
        declaredSourceBytes >=
          Math.ceil(CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES / 2);
      if (permanentlyTooLarge) {
        rememberPolicyStableEnrichmentAttempt(candidate, options);
      } else {
        // This tip can fit when it gets an empty cycle rather than behind the
        // prior plan. Keep it eligible for its next round-robin turn.
        forgetEnrichmentAttempt(candidate, options);
      }
      warnings.push(
        `Deferred agent blob enrichment for ${candidate.resourceId}: its authenticated source and rebuilt payload cannot fit the fixed ${CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES}-byte interactive work budget. The visible chat remains synchronized, but continuation enrichment needs a smaller source snapshot or a future bounded offline migration.`,
      );
      continue;
    }
    const plan = await planChatTipEnrichment(
      repository,
      candidate,
      options,
      warnings,
      availableWorkBytes - declaredSourceBytes,
    );
    if (plan !== null) {
      plans.push(plan);
      retainedPlanBytes += plan.snapshot.content.byteLength;
    }
  }

  if (plans.length === 0) {
    return {
      attempted: candidates.length,
      published: 0,
      cursor,
      warnings,
      publishedResourceIds: [],
    };
  }
  await options.beforePublish?.();
  const freshPlans = plans.filter(({ candidate }) =>
    sameCurrentTips(
      repository.state.tips[candidate.resourceId] ?? [],
      candidate.expectedTipIds,
    ),
  );
  if (freshPlans.length === 0) {
    return {
      attempted: candidates.length,
      published: 0,
      cursor,
      warnings,
      publishedResourceIds: [],
    };
  }
  try {
    const result = await repository.publish(
      freshPlans.map(({ snapshot }) => snapshot),
      [],
    );
    return {
      attempted: candidates.length,
      published: result.eventHash === null ? 0 : freshPlans.length,
      cursor,
      warnings,
      publishedResourceIds:
        result.eventHash === null
          ? []
          : freshPlans.map(({ candidate }) => candidate.resourceId),
    };
  } catch (error) {
    for (const { candidate } of freshPlans) {
      options.attemptCache?.delete(candidate.resourceId);
    }
    warnings.push(
      `Agent blob enrichment could not be published: ${formatError(error)}`,
    );
    return {
      attempted: candidates.length,
      published: 0,
      cursor,
      warnings,
      publishedResourceIds: [],
    };
  }
}

/**
 * Builds the priority order only when the authenticated repository graph
 * changes. Callers retain the result and page it with the function below.
 */
export function buildChatTipEnrichmentCandidateIndex(
  tipsByResource: Readonly<Record<string, ResourceTip[]>>,
): ChatTipEnrichmentCandidate[] {
  const candidates: ChatTipEnrichmentCandidate[] = [];
  for (const resourceId in tipsByResource) {
    if (!Object.prototype.hasOwnProperty.call(tipsByResource, resourceId)) {
      continue;
    }
    const tips = tipsByResource[resourceId] ?? [];
    if (tips.length !== 1) {
      continue;
    }
    const tip = tips[0];
    if (tip === undefined || !tipNeedsAgentKvEnrichment(tip)) {
      continue;
    }
    candidates.push({
      resourceId,
      tip,
      expectedTipIds: [tip.versionId],
    });
  }
  candidates.sort(compareChatTipEnrichmentPriority);
  return candidates;
}

function selectIndexedChatTipEnrichmentCandidates(
  index: readonly ChatTipEnrichmentCandidate[],
  cursor: ChatTipEnrichmentCursor,
  candidateGeneration: number,
  requestedBatchSize = CHAT_TIP_ENRICHMENT_BATCH_SIZE,
  include: (candidate: ChatTipEnrichmentCandidate) => boolean = () => true,
): {
  candidates: ChatTipEnrichmentCandidate[];
  cursor: ChatTipEnrichmentCursor;
} {
  if (index.length === 0) {
    return {
      candidates: [],
      cursor: { afterResourceId: null, nextIndex: 0, candidateGeneration },
    };
  }
  const batchSize = Math.max(
    1,
    Math.min(
      CHAT_TIP_ENRICHMENT_BATCH_SIZE,
      Number.isSafeInteger(requestedBatchSize)
        ? requestedBatchSize
        : CHAT_TIP_ENRICHMENT_BATCH_SIZE,
    ),
  );
  const start =
    cursor.candidateGeneration === candidateGeneration &&
    Number.isSafeInteger(cursor.nextIndex) &&
    (cursor.nextIndex ?? -1) >= 0
      ? (cursor.nextIndex ?? 0) % index.length
      : 0;
  const candidates: ChatTipEnrichmentCandidate[] = [];
  const probeLimit = Math.min(
    index.length,
    CHAT_TIP_ENRICHMENT_CANDIDATE_PROBES_PER_CYCLE,
  );
  let inspected = 0;
  let lastInspected: ChatTipEnrichmentCandidate | undefined;
  while (inspected < probeLimit && candidates.length < batchSize) {
    const candidate = index[(start + inspected) % index.length];
    inspected += 1;
    if (candidate === undefined) {
      continue;
    }
    lastInspected = candidate;
    if (include(candidate)) {
      candidates.push(candidate);
    }
  }
  return {
    candidates,
    cursor: {
      afterResourceId: lastInspected?.resourceId ?? null,
      nextIndex: (start + inspected) % index.length,
      candidateGeneration,
    },
  };
}

/**
 * Deterministic bounded round-robin selection without decrypting every tip.
 *
 * A newly upgraded repository can contain thousands of legacy chat tips. The
 * first pass starts with the most recently updated conversations so a manual
 * Sync Now reaches the chat the user is actively trying to recover, instead
 * of spending hours walking lexicographically earlier history. The cursor
 * resumes after the exact last resource in this stable priority order, so
 * unchanged/no-op tips still give every older chat a turn.
 */
export function selectChatTipEnrichmentCandidates(
  tipsByResource: Readonly<Record<string, ResourceTip[]>>,
  cursor: ChatTipEnrichmentCursor,
  requestedBatchSize = CHAT_TIP_ENRICHMENT_BATCH_SIZE,
  include: (candidate: ChatTipEnrichmentCandidate) => boolean = () => true,
): ChatTipEnrichmentCandidate[] {
  const batchSize = Math.max(
    1,
    Math.min(
      CHAT_TIP_ENRICHMENT_BATCH_SIZE,
      Number.isSafeInteger(requestedBatchSize)
        ? requestedBatchSize
        : CHAT_TIP_ENRICHMENT_BATCH_SIZE,
    ),
  );
  const eligible = buildChatTipEnrichmentCandidateIndex(tipsByResource).filter(
    include,
  );
  if (eligible.length <= batchSize) {
    return eligible;
  }
  let start = 0;
  if (cursor.afterResourceId !== null) {
    const index = eligible.findIndex(
      (candidate) => candidate.resourceId === cursor.afterResourceId,
    );
    start = index < 0 ? 0 : (index + 1) % eligible.length;
  }
  const selected: ChatTipEnrichmentCandidate[] = [];
  for (let offset = 0; offset < batchSize; offset += 1) {
    const candidate = eligible[(start + offset) % eligible.length];
    if (candidate !== undefined) {
      selected.push(candidate);
    }
  }
  return selected;
}

function compareChatTipEnrichmentPriority(
  left: ChatTipEnrichmentCandidate,
  right: ChatTipEnrichmentCandidate,
): number {
  const leftUpdatedAt = validTipLastUpdatedAt(left.tip);
  const rightUpdatedAt = validTipLastUpdatedAt(right.tip);
  if (leftUpdatedAt !== null && rightUpdatedAt !== null) {
    if (leftUpdatedAt !== rightUpdatedAt) {
      return leftUpdatedAt > rightUpdatedAt ? -1 : 1;
    }
  } else if (leftUpdatedAt !== null) {
    return -1;
  } else if (rightUpdatedAt !== null) {
    return 1;
  }
  return compareStrings(left.resourceId, right.resourceId);
}

function validTipLastUpdatedAt(tip: ResourceTip): number | null {
  const value = tip.metadata?.lastUpdatedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tipNeedsAgentKvEnrichment(tip: ResourceTip): boolean {
  const origin = effectiveSyncOrigin(tip.metadata);
  if (
    tip.kind !== "chat" ||
    tip.operation !== "put" ||
    tip.payload === undefined ||
    origin === "automatic-chat-repair"
  ) {
    return false;
  }
  const schemaVersion = tip.metadata?.chatSnapshotSchemaVersion;
  const missing = tip.metadata?.agentKvMissingCount;
  return (
    (isCoreMigrationSourceTip(tip) &&
      schemaVersion === 2 &&
      missing === 0) ||
    schemaVersion !== 2 ||
    typeof missing !== "number" ||
    !Number.isSafeInteger(missing) ||
    missing > 0
  );
}

async function planChatTipEnrichment(
  repository: SyncRepository,
  candidate: ChatTipEnrichmentCandidate,
  options: ChatTipEnrichmentOptions,
  warnings: string[],
  maxEnrichedWorkBytes = options.maxPayloadBytes,
): Promise<PlannedEnrichment | null> {
  const declaredSourceBytes = candidate.tip.payload?.plainBytes;
  if (
    declaredSourceBytes !== undefined &&
    declaredSourceBytes >= options.maxPayloadBytes
  ) {
    // The authenticated object reference is available without decrypting the
    // payload. A v2 envelope can only make an at-limit source larger, so avoid
    // both object decryption and opening state.vscdb for a permanently
    // ineligible tip. Keep the attempt cached until the tip/policy/DB changes.
    warnings.push(
      `Skipped agent blob enrichment for ${candidate.resourceId}: source payload is ${declaredSourceBytes} bytes, leaving no room below the configured ${options.maxPayloadBytes}-byte limit.`,
    );
    rememberPolicyStableEnrichmentAttempt(candidate, options);
    return null;
  }

  let content: Buffer;
  let source: PortableChatSnapshot;
  let sourceCoreHash: string;
  let sourceConversationStates: readonly string[];
  try {
    const data = await repository.tryReadVersion(candidate.tip.versionId);
    if (
      data === null ||
      data.content === null ||
      data.change.resourceId !== candidate.resourceId ||
      data.change.kind !== "chat" ||
      data.change.operation !== "put" ||
      data.change.semanticHash !== candidate.tip.semanticHash
    ) {
      // A payload object can still be hydrating through the shared folder.
      // Do not turn that transient absence into an idle no-op cache entry.
      forgetEnrichmentAttempt(candidate, options);
      return null;
    }
    content = data.content;
    if (sha256(content) !== candidate.tip.semanticHash) {
      throw new Error("tip semantic hash does not match its payload");
    }
    source = parsePortableChatSnapshot(content);
    if (candidate.resourceId !== `chat/${source.composerId}`) {
      throw new Error("tip composer ID does not match its resource ID");
    }
    sourceCoreHash = portableChatCoreHash(source);
    const stateScan = scanPortableChatConversationStates(source);
    if (stateScan.status === "structure-limit") {
      throw new Error(enrichmentJsonStructureLimit("decoded row"));
    }
    sourceConversationStates = stateScan.states;
  } catch (error) {
    // The version ID authenticates immutable source bytes. A malformed or
    // unreadable source cannot become structurally valid because unrelated
    // rows appended to the live WAL; retry only when the tip/policy changes or
    // a manual forceRetry explicitly asks for another attempt.
    rememberPolicyStableEnrichmentAttempt(candidate, options);
    warnings.push(
      `Skipped agent blob enrichment for ${candidate.resourceId}: ${formatError(error)}.`,
    );
    return null;
  }

  if (isSamePayloadCoreMigration(candidate.tip, source)) {
    const closure = await verifyEnrichmentContinuationClosure(source);
    if (closure.status === "complete") {
      return plannedEnrichment(
        candidate,
        content,
        source,
        sourceCoreHash,
        true,
      );
    }
    // A legacy blob-only tip whose aggregate missing count is zero can still
    // omit a reachable descendant. Fall through to the normal collector so a
    // source device that owns that exact blob may complete it. Never publish
    // the core-applying marker from metadata alone.
  }

  const safelyEmptyLegacyGraph = emptyLegacyAgentKvPayload(
    source,
    sourceConversationStates,
  );
  let collected: ChatTipAgentKvCollection | null;
  const effectiveMaxPayloadBytes = Math.min(
    options.maxPayloadBytes,
    maxEnrichedWorkBytes,
  );
  try {
    collected = await options.collectAgentKv(source, {
      sourceContentBytes: content.byteLength,
      maxPayloadBytes: effectiveMaxPayloadBytes,
      conversationStates: sourceConversationStates,
    });
  } catch (error) {
    forgetEnrichmentAttempt(candidate, options);
    warnings.push(
      `Skipped agent blob enrichment for ${candidate.resourceId}: ${formatError(error)}.`,
    );
    return null;
  }
  if (collected === null) {
    return null;
  }
  if (collected.retryable === true) {
    // SQLITE_BUSY/IOERR and invalid lookup responses are not evidence that a
    // content-addressed row is genuinely absent. Let the next poll try again
    // even when this pass found no new materialized blob.
    forgetEnrichmentAttempt(candidate, options);
  } else if (collected.cacheUntilTipOrPolicyChanges === true) {
    rememberPolicyStableEnrichmentAttempt(candidate, options);
  }
  if (collected.agentKv === null) {
    return null;
  }
  const pruneProof = validateSourceMissingPruneProof(
    source,
    collected.agentKv,
    collected.provenAbsentSourceMissingIds,
  );
  if (!pruneProof.valid) {
    rememberPolicyStableEnrichmentAttempt(candidate, options);
    warnings.push(
      `Skipped agent blob enrichment for ${candidate.resourceId}: ${pruneProof.reason}.`,
    );
    return null;
  }
  const previousBlobIds = new Set(
    isPortableChatSnapshotV2(source)
      ? source.agentKv.blobs.map(agentKvBlobId)
      : [],
  );
  const addedBlobCount = collected.agentKv.blobs.reduce(
    (count, row) => count + (previousBlobIds.has(agentKvBlobId(row)) ? 0 : 1),
    0,
  );
  // A non-empty graph with no materialized blob must remain eligible for a
  // device that can contribute it. Only the independently audited empty
  // legacy graph is useful as a blob-free, one-time v2 publication.
  const publishesAuditedEmptyGraph =
    safelyEmptyLegacyGraph !== null &&
    collected.agentKv.blobs.length === 0 &&
    collected.agentKv.referencedIds.length === 0 &&
    collected.agentKv.missingIds.length === 0;
  const publishesOrphanCanonicalization = pruneProof.droppedIds.length > 0;
  const publishesCorrectedCoreMigrationPartition =
    isPortableChatSnapshotV2(source) &&
    source.agentKv.missingIds.length === 0 &&
    isCoreMigrationSourceTip(candidate.tip) &&
    !sameAgentKvPayload(source.agentKv, collected.agentKv);
  if (
    addedBlobCount === 0 &&
    !publishesAuditedEmptyGraph &&
    !publishesOrphanCanonicalization &&
    !publishesCorrectedCoreMigrationPartition
  ) {
    return null;
  }

  let enrichedContent: Buffer;
  let enriched: PortableChatSnapshotV2;
  let appliesCore: boolean;
  try {
    const candidateSnapshot: PortableChatSnapshotV2 = {
      ...source,
      schemaVersion: 2,
      agentKv: collected.agentKv,
    };
    enrichedContent = canonicalBytes(candidateSnapshot);
    const parsed = parsePortableChatSnapshot(enrichedContent);
    if (!isPortableChatSnapshotV2(parsed)) {
      throw new Error("enriched payload did not validate as chat schema v2");
    }
    const enrichedCoreHash = portableChatCoreHash(parsed);
    if (enrichedCoreHash !== sourceCoreHash) {
      throw new Error("enrichment changed the repository chat core");
    }
    enriched = parsed;
    const closure = await verifyEnrichmentContinuationClosure(enriched);
    if (closure.status === "invalid" || closure.status === "unknown") {
      throw new Error(
        `enriched continuation closure is ${closure.status}: ${closure.reason}`,
      );
    }
    const activeClosureComplete = closure.status === "complete";
    appliesCore =
      enriched.agentKv.missingIds.length === 0 && activeClosureComplete;
    if (enriched.agentKv.missingIds.length === 0 && !appliesCore) {
      throw new Error("enriched continuation closure is incomplete");
    }
    // An active-closure-complete payload may safely remove only source IDs
    // whose exact local lookup proved absent. Retained unprobed IDs keep this
    // child blob-only and eligible for the next bounded pass.
    assertAgentKvMonotonic(
      source,
      enriched,
      activeClosureComplete
        ? new Set(pruneProof.droppedIds)
        : new Set<string>(),
    );
  } catch (error) {
    rememberPolicyStableEnrichmentAttempt(candidate, options);
    warnings.push(
      `Skipped agent blob enrichment for ${candidate.resourceId}: ${formatError(error)}.`,
    );
    return null;
  }
  if (enrichedContent.byteLength > effectiveMaxPayloadBytes) {
    if (enrichedContent.byteLength > options.maxPayloadBytes) {
      rememberPolicyStableEnrichmentAttempt(candidate, options);
    } else {
      forgetEnrichmentAttempt(candidate, options);
    }
    warnings.push(
      `Skipped agent blob enrichment for ${candidate.resourceId}: enriched payload is ${enrichedContent.byteLength} bytes, above the active ${effectiveMaxPayloadBytes}-byte payload/work limit.`,
    );
    return null;
  }

  return plannedEnrichment(
    candidate,
    enrichedContent,
    enriched,
    sourceCoreHash,
    appliesCore,
  );
}

function isSamePayloadCoreMigration(
  tip: ResourceTip,
  source: PortableChatSnapshot,
): source is PortableChatSnapshotV2 {
  return (
    isCoreMigrationSourceTip(tip) &&
    isPortableChatSnapshotV2(source) &&
    source.agentKv.missingIds.length === 0
  );
}

function isCoreMigrationSourceTip(tip: ResourceTip): boolean {
  const origin = effectiveSyncOrigin(tip.metadata);
  return (
    origin === "auto-merge" ||
    origin === "version-restore" ||
    origin === "conflict-resolution" ||
    (origin === "agent-kv-enrichment" &&
      tip.metadata?.agentKvEnrichmentAppliesCore !== true)
  );
}

function sameAgentKvPayload(
  left: PortableAgentKvPayload,
  right: PortableAgentKvPayload,
): boolean {
  return (
    sameStrings(left.referencedIds, right.referencedIds) &&
    sameStrings(left.missingIds, right.missingIds) &&
    left.blobs.length === right.blobs.length &&
    left.blobs.every((blob, index) => {
      const other = right.blobs[index];
      return (
        other !== undefined &&
        blob.key === other.key &&
        blob.valueBase64 === other.valueBase64 &&
        blob.valueType === other.valueType
      );
    })
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function verifyEnrichmentContinuationClosure(
  snapshot: PortableChatSnapshotV2,
) {
  return verifyPortableChatContinuationClosure(snapshot, {
    limits: {
      maxNodes: Math.min(
        CHAT_TIP_ENRICHMENT_MAX_NODES,
        DEFAULT_AGENT_KV_WALK_LIMITS.maxNodes,
      ),
      maxBytes: Math.min(
        CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES,
        DEFAULT_AGENT_KV_WALK_LIMITS.maxBytes,
      ),
      maxDepth: DEFAULT_AGENT_KV_WALK_LIMITS.maxDepth,
      maxProtobufDepth: DEFAULT_AGENT_KV_WALK_LIMITS.maxProtobufDepth,
    },
  });
}

function plannedEnrichment(
  candidate: ChatTipEnrichmentCandidate,
  content: Buffer,
  snapshot: PortableChatSnapshotV2,
  coreHash: string,
  appliesCore: boolean,
): PlannedEnrichment {
  const originalProducer = effectiveTipProducer(candidate.tip);
  const metadata: Record<string, JsonValue> = {
    ...(candidate.tip.metadata ?? {}),
    chatSnapshotSchemaVersion: 2,
    agentKvBlobCount: snapshot.agentKv.blobs.length,
    agentKvReferencedCount: snapshot.agentKv.referencedIds.length,
    agentKvMissingCount: snapshot.agentKv.missingIds.length,
    chatCoreHash: coreHash,
    syncOrigin: "agent-kv-enrichment",
    // Only a bounded, closure-complete payload may replace the chat core on a
    // peer that never applied its parent. Partial children remain blob-only
    // and eligible for a later source device to finish.
    agentKvEnrichmentAppliesCore: appliesCore,
    enrichedFromVersionId: candidate.tip.versionId,
    enrichedFromSemanticHash: candidate.tip.semanticHash,
    ...(originalProducer === undefined
      ? {}
      : { originalProducer: producerAsMetadata(originalProducer) }),
  };
  return {
    candidate,
    snapshot: {
      resourceId: candidate.resourceId,
      kind: "chat",
      content,
      semanticHash: sha256(content),
      parents: [...candidate.expectedTipIds],
      metadata,
    },
  };
}

function enrichmentAttemptDue(
  candidate: ChatTipEnrichmentCandidate,
  options: ChatTipEnrichmentOptions,
): boolean {
  if (
    options.forceRetry === true ||
    options.attemptCache === undefined
  ) {
    return true;
  }
  const remembered = options.attemptCache.get(candidate.resourceId);
  if (remembered === enrichmentPolicyAttemptKey(candidate, options)) {
    return false;
  }
  if (options.databaseGeneration === undefined) {
    return true;
  }
  return (
    remembered !== enrichmentAttemptKey(candidate, options)
  );
}

function rememberEnrichmentAttempt(
  candidate: ChatTipEnrichmentCandidate,
  options: ChatTipEnrichmentOptions,
): void {
  if (
    options.attemptCache === undefined ||
    options.databaseGeneration === undefined
  ) {
    return;
  }
  rememberBoundedEnrichmentAttempt(
    options.attemptCache,
    candidate.resourceId,
    enrichmentAttemptKey(candidate, options),
  );
}

function forgetEnrichmentAttempt(
  candidate: ChatTipEnrichmentCandidate,
  options: ChatTipEnrichmentOptions,
): void {
  if (
    options.attemptCache?.get(candidate.resourceId) ===
    enrichmentAttemptKey(candidate, options)
  ) {
    options.attemptCache.delete(candidate.resourceId);
  }
}

function rememberPolicyStableEnrichmentAttempt(
  candidate: ChatTipEnrichmentCandidate,
  options: ChatTipEnrichmentOptions,
): void {
  if (options.attemptCache === undefined) {
    return;
  }
  rememberBoundedEnrichmentAttempt(
    options.attemptCache,
    candidate.resourceId,
    enrichmentPolicyAttemptKey(candidate, options),
  );
}

function rememberBoundedEnrichmentAttempt(
  cache: Map<string, string>,
  resourceId: string,
  attemptKey: string,
): void {
  cache.delete(resourceId);
  cache.set(resourceId, attemptKey);
  while (cache.size > CHAT_TIP_ENRICHMENT_ATTEMPT_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function enrichmentAttemptKey(
  candidate: ChatTipEnrichmentCandidate,
  options: ChatTipEnrichmentOptions,
): string {
  return `${candidate.tip.versionId}\n${options.databaseGeneration ?? ""}\n${options.maxPayloadBytes}\n${CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES}`;
}

function enrichmentPolicyAttemptKey(
  candidate: ChatTipEnrichmentCandidate,
  options: ChatTipEnrichmentOptions,
): string {
  return `tip-policy\n${candidate.tip.versionId}\n${options.maxPayloadBytes}\n${CHAT_TIP_ENRICHMENT_MAX_WORK_BYTES}`;
}

function emptyLegacyAgentKvPayload(
  snapshot: PortableChatSnapshot,
  states: readonly string[],
): PortableAgentKvPayload | null {
  if (isPortableChatSnapshotV2(snapshot)) {
    return null;
  }
  if (states.length > 0) {
    const roots = extractAgentKvRootIds(states);
    if (!roots.complete || roots.roots.length > 0) {
      return null;
    }
  }
  return { blobs: [], referencedIds: [], missingIds: [] };
}

function assertAgentKvMonotonic(
  source: PortableChatSnapshot,
  enriched: PortableChatSnapshotV2,
  allowedPrunedSourceMissing: ReadonlySet<string>,
): void {
  if (!isPortableChatSnapshotV2(source)) {
    return;
  }
  const enrichedReferences = new Set(enriched.agentKv.referencedIds);
  const sourceMissing = new Set(source.agentKv.missingIds);
  for (const id of source.agentKv.referencedIds) {
    if (
      !enrichedReferences.has(id) &&
      !(sourceMissing.has(id) && allowedPrunedSourceMissing.has(id))
    ) {
      throw new Error("enrichment dropped a repository agentKv reference");
    }
  }
  const enrichedBlobs = new Map(
    enriched.agentKv.blobs.map((blob) => [blob.key, blob]),
  );
  for (const sourceBlob of source.agentKv.blobs) {
    const retained = enrichedBlobs.get(sourceBlob.key);
    if (
      retained === undefined ||
      retained.valueBase64 !== sourceBlob.valueBase64 ||
      retained.valueType !== sourceBlob.valueType
    ) {
      throw new Error("enrichment changed or dropped a repository agentKv blob");
    }
  }
  const enrichedMissing = new Set(enriched.agentKv.missingIds);
  for (const id of source.agentKv.missingIds) {
    if (
      !enrichedMissing.has(id) &&
      !enrichedBlobs.has(`${AGENT_KV_BLOB_PREFIX}${id}`) &&
      (!allowedPrunedSourceMissing.has(id) || enrichedReferences.has(id))
    ) {
      throw new Error(
        "enrichment left an unresolved repository agentKv reference unpartitioned",
      );
    }
  }
}

type SourceMissingPruneProof =
  | { valid: true; droppedIds: string[] }
  | { valid: false; reason: string };

function validateSourceMissingPruneProof(
  source: PortableChatSnapshot,
  enriched: PortableAgentKvPayload,
  declaredProof: readonly string[] | undefined,
): SourceMissingPruneProof {
  const proof = declaredProof ?? [];
  for (let index = 0; index < proof.length; index += 1) {
    const id = proof[index];
    const previous = proof[index - 1];
    if (
      typeof id !== "string" ||
      (previous !== undefined && compareStrings(previous, id) >= 0)
    ) {
      return {
        valid: false,
        reason: "source-missing absence proof is not sorted and unique",
      };
    }
  }
  if (!isPortableChatSnapshotV2(source)) {
    return proof.length === 0
      ? { valid: true, droppedIds: [] }
      : {
          valid: false,
          reason: "a legacy source carried an inapplicable absence proof",
        };
  }

  const sourceMissing = new Set(source.agentKv.missingIds);
  const references = new Set(enriched.referencedIds);
  const missing = new Set(enriched.missingIds);
  const blobs = new Set(enriched.blobs.map(agentKvBlobId));
  const droppedIds = source.agentKv.missingIds.filter(
    (id) => !references.has(id) && !missing.has(id) && !blobs.has(id),
  );
  const dropped = new Set(droppedIds);
  const proven = new Set(proof);
  if (proof.some((id) => !sourceMissing.has(id))) {
    return {
      valid: false,
      reason: "source-missing absence proof names an ID outside the source",
    };
  }
  if (droppedIds.some((id) => !proven.has(id))) {
    return {
      valid: false,
      reason: "an unresolved source ID was pruned without exact absence proof",
    };
  }
  if (proof.some((id) => !dropped.has(id) && !blobs.has(id))) {
    return {
      valid: false,
      reason: "source-missing absence proof was neither pruned nor materialized",
    };
  }
  return { valid: true, droppedIds };
}

function sameCurrentTips(
  current: readonly ResourceTip[],
  expectedTipIds: readonly string[],
): boolean {
  const actual = current.map((tip) => tip.versionId).sort(compareStrings);
  const expected = [...expectedTipIds].sort(compareStrings);
  return (
    actual.length === expected.length &&
    actual.every((versionId, index) => versionId === expected[index])
  );
}

function agentKvBlobId(row: { key: string }): string {
  return row.key.slice("agentKv:blob:".length);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function enrichmentJsonStructureLimit(stage: string): string {
  return `${stage} chat JSON exceeds the fixed ${JSON_STRUCTURE_MAX_TOKENS}-token/${JSON_STRUCTURE_MAX_DEPTH}-depth structural safety limit`;
}

function conversationStatesForEnrichment(
  snapshot: PortableChatSnapshot,
  preflighted: readonly string[] | undefined,
): readonly string[] {
  if (preflighted !== undefined) {
    return preflighted;
  }
  const scan = scanPortableChatConversationStates(snapshot);
  if (scan.status === "structure-limit") {
    throw new Error(enrichmentJsonStructureLimit("decoded row"));
  }
  return scan.states;
}

/** Options for the production live-database wrapper used by SyncManager. */
export type LiveChatTipEnrichmentOptions = Omit<
  ChatTipEnrichmentOptions,
  "collectAgentKv" | "databaseGeneration"
>;

/**
 * Production entry point: lazily opens state.vscdb read-only only when an
 * uncached candidate actually reaches collection, and shares one connection
 * across the bounded batch.
 */
export async function enrichCurrentChatTipsFromLiveDatabase(
  repository: SyncRepository,
  databasePath: string,
  options: LiveChatTipEnrichmentOptions,
): Promise<ChatTipEnrichmentResult> {
  const databaseGeneration = await agentKvDatabaseGeneration(databasePath);
  // An object cell keeps TypeScript's control-flow analysis honest across the
  // awaited collector callback, which may lazily assign the connection.
  const connection: { current: DatabaseSync | null } = { current: null };
  try {
    return await enrichCurrentChatTips(repository, {
      ...options,
      databaseGeneration,
      collectAgentKv: async (snapshot, context) => {
        const states = conversationStatesForEnrichment(
          snapshot,
          context.conversationStates,
        );
        const emptyGraph = emptyLegacyAgentKvPayload(snapshot, states);
        if (emptyGraph !== null) {
          // The exact repository core proves there is no reachable root. A
          // database generation can therefore never contribute a blob, and
          // the one-time empty v2 marker needs no SQLite connection at all.
          return { agentKv: emptyGraph };
        }
        if (connection.current === null) {
          connection.current = openDatabase(databasePath, { readOnly: true });
          connection.current.exec("PRAGMA busy_timeout=2000");
          connection.current.exec("PRAGMA query_only=ON");
        }
        return collectLiveAgentKv(
          connection.current,
          snapshot,
          context,
        );
      },
    });
  } finally {
    connection.current?.close();
  }
}

async function collectLiveAgentKv(
  database: DatabaseSync,
  snapshot: PortableChatSnapshot,
  context: ChatTipAgentKvContext,
): Promise<ChatTipAgentKvCollection | null> {
  const states = conversationStatesForEnrichment(
    snapshot,
    context.conversationStates,
  );
  const existing = new Map(
    (isPortableChatSnapshotV2(snapshot) ? snapshot.agentKv.blobs : []).map(
      (row) => [row.key, row],
    ),
  );
  const rowMetadataStatement = database.prepare(
    `SELECT key,
            typeof(value) AS valueType,
            length(CAST(value AS BLOB)) AS valueBytes
       FROM cursorDiskKV
      WHERE key = ?`,
  );
  const rowValueStatement = database.prepare(
    `SELECT key, value, typeof(value) AS valueType
       FROM cursorDiskKV
      WHERE key = ?
        AND typeof(value) = ?
        AND length(CAST(value AS BLOB)) = ?`,
  );
  const existingRawBytes = [...existing.values()].reduce(
    (total, row) => total + decodedBase64Length(row.valueBase64),
    0,
  );
  const seedBytes = states.reduce(
    (total, state) =>
      total +
      (state.startsWith("~") ? decodedBase64Length(state.slice(1)) : 0),
    0,
  );
  const encodedRoom = Math.max(
    0,
    context.maxPayloadBytes - context.sourceContentBytes,
  );
  const jsonReserve = Math.min(
    1024 * 1024,
    Math.max(16 * 1024, Math.floor(encodedRoom / 10)),
  );
  const additionalRawBudget = Math.floor(
    Math.max(0, encodedRoom - jsonReserve) * (3 / 4),
  );
  const walkByteBudget = Math.min(
    DEFAULT_AGENT_KV_WALK_LIMITS.maxBytes,
    seedBytes + existingRawBytes + additionalRawBudget,
  );
  if (walkByteBudget <= seedBytes + existingRawBytes) {
    return {
      agentKv: null,
      cacheUntilTipOrPolicyChanges: true,
    };
  }
  let databaseRowOverBudget = false;
  const lookupExactBlob: AgentKvBlobLookup = (key, remainingBytes) => {
    const retained = existing.get(key);
    if (retained !== undefined) {
      return {
        status: "found",
        key,
        bytes: Buffer.from(retained.valueBase64, "base64"),
        valueType: retained.valueType === "text" ? "text" : "blob",
      };
    }
    const metadata = rowMetadataStatement.get(key) as
      | {
          key?: unknown;
          valueType?: unknown;
          valueBytes?: unknown;
        }
      | undefined;
    if (metadata === undefined) {
      return { status: "missing" };
    }
    if (
      metadata.key !== key ||
      (metadata.valueType !== "text" && metadata.valueType !== "blob") ||
      typeof metadata.valueBytes !== "number" ||
      !Number.isSafeInteger(metadata.valueBytes) ||
      metadata.valueBytes < 0
    ) {
      return {
        status: "unreadable",
        reason:
          "SQLite row has an unsupported key, storage class, or byte length.",
      };
    }
    if (metadata.valueBytes > remainingBytes) {
      // This is a property of the current live row, not of the immutable
      // repository source or the configured policy. Cursor may replace a
      // corrupt/partial oversized row in a later DB/WAL generation.
      databaseRowOverBudget = true;
      return { status: "over-budget" };
    }
    const row = rowValueStatement.get(
      key,
      metadata.valueType,
      metadata.valueBytes,
    ) as
      | { key?: unknown; value?: unknown; valueType?: unknown }
      | undefined;
    // Cursor can update cursorDiskKV between the bounded metadata probe and
    // the guarded value SELECT. Treat that race as a retryable lookup error,
    // not as evidence that the content-addressed row is missing.
    if (row === undefined) {
      throw new Error("SQLite row changed during bounded agent blob lookup.");
    }
    if (
      row.key !== key ||
      row.valueType !== metadata.valueType ||
      (typeof row.value !== "string" && !(row.value instanceof Uint8Array))
    ) {
      return {
        status: "unreadable",
        reason: "SQLite row changed to an unsupported storage class.",
      };
    }
    const bytes =
      typeof row.value === "string"
        ? Buffer.from(row.value, "utf8")
        : row.value;
    if (bytes.byteLength !== metadata.valueBytes) {
      throw new Error("SQLite row changed during bounded agent blob lookup.");
    }
    return {
      status: "found",
      key,
      bytes,
      valueType: metadata.valueType,
    };
  };
  const maxNodes = Math.min(
    CHAT_TIP_ENRICHMENT_MAX_NODES,
    DEFAULT_AGENT_KV_WALK_LIMITS.maxNodes,
  );
  const walked = await walkAgentKvReachability(
    states,
    lookupExactBlob,
    {
      limits: {
        maxNodes,
        maxBytes: Math.min(
          walkByteBudget,
          DEFAULT_AGENT_KV_WALK_LIMITS.maxBytes,
        ),
      },
    },
  );
  let retryableLookupFailure = walked.unreadable.some(
    (issue) =>
      issue.source === "blob" &&
      (issue.reason === "lookup-failed" ||
        issue.reason === "invalid-lookup-result"),
  );
  // A limit means some reachable IDs were never even scheduled, so publishing
  // would falsely claim a complete `referencedIds` partition. Missing,
  // tampered and unreadable exact blob IDs are safe to retain as `missingIds`;
  // an unreadable seed is not, because its roots are unknown.
  if (
    walked.limitReasons.length > 0 ||
    walked.unreadable.some((issue) => issue.source === "conversation-state")
  ) {
    return retryableLookupFailure
      ? { agentKv: null, retryable: true }
      : databaseRowOverBudget
        ? { agentKv: null }
      : {
          agentKv: null,
          cacheUntilTipOrPolicyChanges: true,
        };
  }

  const blobs = new Map(existing);
  let additionalRawBytes = 0;
  for (const blob of walked.blobs) {
    if (!existing.has(blob.key)) {
      additionalRawBytes += blob.bytes.byteLength;
    }
    blobs.set(blob.key, {
      key: blob.key,
      valueBase64: blob.bytes.toString("base64"),
      valueType: blob.valueType === "text" ? "text" : "blob",
    });
  }
  // A v2 merge can retain an unresolved ID from a losing core even when the
  // winning/current core no longer reaches it. The graph walk above therefore
  // never asks SQLite for that exact content-addressed row. Probe those source
  // missing IDs separately, but debit the same node and raw-byte budgets; a
  // large or corrupt local row is rejected by the same metadata-first guarded
  // SELECT used by the graph walker before its value can be materialized.
  const provenAbsentSourceMissingIds = new Set<string>();
  if (isPortableChatSnapshotV2(snapshot)) {
    const walkedIds = new Set([
      ...walked.blobs.map((blob) => blob.id),
      ...walked.unavailableIds,
    ]);
    let remainingNodes = Math.max(0, maxNodes - walked.visitedNodes);
    let remainingRawBytes = Math.max(
      0,
      additionalRawBudget - additionalRawBytes,
    );
    let probedMissingIds = 0;
    for (const id of snapshot.agentKv.missingIds) {
      const key = `${AGENT_KV_BLOB_PREFIX}${id}`;
      if (blobs.has(key) || walkedIds.has(id)) {
        continue;
      }
      if (remainingNodes === 0) {
        break;
      }
      remainingNodes -= 1;
      probedMissingIds += 1;
      if (
        probedMissingIds % CHAT_TIP_ENRICHMENT_YIELD_EVERY_NODES ===
        0
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      let result: Awaited<ReturnType<AgentKvBlobLookup>>;
      try {
        result = await lookupExactBlob(key, remainingRawBytes);
      } catch {
        retryableLookupFailure = true;
        continue;
      }
      if (result.status === "missing") {
        provenAbsentSourceMissingIds.add(id);
        continue;
      }
      if (
        result.status !== "found" ||
        result.key !== key ||
        !(result.bytes instanceof Uint8Array) ||
        (result.valueType !== "text" && result.valueType !== "blob") ||
        result.bytes.byteLength > remainingRawBytes ||
        sha256(result.bytes) !== id
      ) {
        continue;
      }
      blobs.set(key, {
        key,
        valueBase64: Buffer.from(
          result.bytes.buffer,
          result.bytes.byteOffset,
          result.bytes.byteLength,
        ).toString("base64"),
        valueType: result.valueType,
      });
      additionalRawBytes += result.bytes.byteLength;
      remainingRawBytes -= result.bytes.byteLength;
    }
  }
  // Canonical references consist of the elected core's active closure plus
  // every blob row we actually retain. A prior merge may have carried an
  // unresolved losing-core ID forever even though the elected core cannot
  // reach it; dropping that declaration is safe. Materialized losing-core
  // extras remain both as blobs and references so no recovered bytes vanish.
  const referencedIds = new Set(
    [...blobs.keys()].map((key) => key.slice(AGENT_KV_BLOB_PREFIX.length)),
  );
  for (const id of [
    ...walked.roots,
    ...walked.blobs.map((blob) => blob.id),
    ...walked.unavailableIds,
  ]) {
    referencedIds.add(id);
  }
  if (isPortableChatSnapshotV2(snapshot)) {
    const activeClosureFullyWalked =
      walked.missing.length === 0 &&
      walked.tampered.length === 0 &&
      walked.unreadable.length === 0;
    for (const id of snapshot.agentKv.missingIds) {
      // A missing exact-key result proves this losing-core declaration has no
      // bytes to retain on this source. Unprobed, over-budget, unreadable, or
      // raced IDs remain unresolved so exhausting a fixed probe budget never
      // silently discards a potentially recoverable blob.
      if (
        !activeClosureFullyWalked ||
        !provenAbsentSourceMissingIds.has(id)
      ) {
        referencedIds.add(id);
      }
    }
  }
  const materializedIds = new Set(
    [...blobs.keys()].map((key) => key.slice(AGENT_KV_BLOB_PREFIX.length)),
  );
  const sortedReferences = [...referencedIds].sort(compareStrings);
  const appliedAbsenceProof = [...provenAbsentSourceMissingIds]
    .filter((id) => !referencedIds.has(id) && !materializedIds.has(id))
    .sort(compareStrings);
  return {
    agentKv: {
      blobs: [...blobs.values()].sort((left, right) =>
        compareStrings(left.key, right.key),
      ),
      referencedIds: sortedReferences,
      missingIds: sortedReferences.filter((id) => !materializedIds.has(id)),
    },
    ...(appliedAbsenceProof.length === 0
      ? {}
      : { provenAbsentSourceMissingIds: appliedAbsenceProof }),
    ...(retryableLookupFailure ? { retryable: true } : {}),
  };
}

/** Narrow test seam for bounded live-database lookup behavior. */
export const __testing = Object.freeze({
  collectLiveAgentKv,
  selectIndexedChatTipEnrichmentCandidates,
});

/** Cheap DB+WAL identity used only to suppress unchanged migration attempts. */
export async function agentKvDatabaseGeneration(
  databasePath: string,
): Promise<string> {
  const [main, wal] = await Promise.all([
    fileGeneration(databasePath, false),
    fileGeneration(`${databasePath}-wal`, true),
  ]);
  return sha256(`${main}\n${wal}`);
}

async function fileGeneration(path: string, optional: boolean): Promise<string> {
  try {
    const value = await stat(path, { bigint: true });
    return [
      value.dev,
      value.ino,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
      value.birthtimeNs,
    ].join(":");
  } catch (error) {
    if (optional && errorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function decodedBase64Length(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}
