import {
  walkAgentKvReachability,
  type AgentKvWalkOptions,
} from "./agentKv";
import {
  scanPortableChatConversationStates,
  type PortableChatSnapshotV2,
  type PortableKvRow,
} from "./stateVscdb";

export type PortableChatContinuationClosureReason =
  | "conversation-json-structure-limit"
  | "conversation-state-unreadable"
  | "walk-limit"
  | "reachable-id-not-declared"
  | "reachable-content-invalid"
  | "reachable-content-not-declared-missing"
  | "reachable-content-missing";

interface PortableChatContinuationClosureCounts {
  /** All graph IDs/blobs declared by the portable payload, including retained extras. */
  declaredBlobCount: number;
  declaredReferencedCount: number;
  declaredMissingCount: number;
  /** IDs actually reached from conversationState in the elected portable core. */
  activeReachableCount: number;
  activeMaterializedCount: number;
  activeUnavailableCount: number;
  visitedNodeCount: number;
}

/**
 * Bounded proof that the elected chat core's continuation graph is closed.
 *
 * Portable merge/enrichment deliberately retains graph rows from losing or
 * older cores. Those extra declarations are valid and are not required to be
 * reachable from the elected core. The verifier only requires every ID that
 * is reachable from the elected core to be declared and, for a `complete`
 * result, present with hash-valid bytes. Callers must still apply their own
 * policy to the payload's aggregate `missingIds` (for example, a repair source
 * may require it to be empty).
 *
 * The input is expected to have passed `parsePortableChatSnapshot` first. The
 * walk nevertheless fails closed on malformed states, invalid reachable bytes,
 * and fixed work bounds.
 */
export type PortableChatContinuationClosureResult =
  | (PortableChatContinuationClosureCounts & { status: "complete" })
  | (PortableChatContinuationClosureCounts & {
      status: "incomplete";
      reason: "reachable-content-missing";
    })
  | (PortableChatContinuationClosureCounts & {
      status: "invalid";
      reason:
        | "reachable-id-not-declared"
        | "reachable-content-invalid"
        | "reachable-content-not-declared-missing";
    })
  | (PortableChatContinuationClosureCounts & {
      status: "unknown";
      reason:
        | "conversation-json-structure-limit"
        | "conversation-state-unreadable"
        | "walk-limit";
    });

export async function verifyPortableChatContinuationClosure(
  snapshot: PortableChatSnapshotV2,
  options?: AgentKvWalkOptions,
): Promise<PortableChatContinuationClosureResult> {
  const stateScan = scanPortableChatConversationStates(snapshot);
  if (stateScan.status === "structure-limit") {
    return closureResult(snapshot, null, {
      status: "unknown",
      reason: "conversation-json-structure-limit",
    });
  }

  const rows = new Map(snapshot.agentKv.blobs.map((row) => [row.key, row]));
  const walked = await walkAgentKvReachability(
    stateScan.states,
    (key, remainingBytes) => portableBlobLookup(rows, key, remainingBytes),
    options,
  );
  const counts = closureCounts(snapshot, walked);

  if (walked.limitReasons.length > 0) {
    return { ...counts, status: "unknown", reason: "walk-limit" };
  }
  if (walked.unreadable.some((issue) => issue.source === "conversation-state")) {
    return {
      ...counts,
      status: "unknown",
      reason: "conversation-state-unreadable",
    };
  }

  const declaredReferences = new Set(snapshot.agentKv.referencedIds);
  const activeReachableIds = new Set([
    ...walked.blobs.map((blob) => blob.id),
    ...walked.unavailableIds,
  ]);
  if (
    [...activeReachableIds].some((id) => !declaredReferences.has(id))
  ) {
    return {
      ...counts,
      status: "invalid",
      reason: "reachable-id-not-declared",
    };
  }
  if (
    walked.tampered.length > 0 ||
    walked.unreadable.some((issue) => issue.source === "blob")
  ) {
    return {
      ...counts,
      status: "invalid",
      reason: "reachable-content-invalid",
    };
  }

  const declaredMissing = new Set(snapshot.agentKv.missingIds);
  if (walked.missing.some(({ id }) => !declaredMissing.has(id))) {
    return {
      ...counts,
      status: "invalid",
      reason: "reachable-content-not-declared-missing",
    };
  }
  if (walked.missing.length > 0) {
    return {
      ...counts,
      status: "incomplete",
      reason: "reachable-content-missing",
    };
  }
  return { ...counts, status: "complete" };
}

type AgentKvWalk = Awaited<ReturnType<typeof walkAgentKvReachability>>;

function closureResult(
  snapshot: PortableChatSnapshotV2,
  walked: AgentKvWalk | null,
  result:
    | {
        status: "unknown";
        reason:
          | "conversation-json-structure-limit"
          | "conversation-state-unreadable"
          | "walk-limit";
      }
    | {
        status: "invalid";
        reason:
          | "reachable-id-not-declared"
          | "reachable-content-invalid"
          | "reachable-content-not-declared-missing";
      },
): PortableChatContinuationClosureResult {
  return { ...closureCounts(snapshot, walked), ...result };
}

function closureCounts(
  snapshot: PortableChatSnapshotV2,
  walked: AgentKvWalk | null,
): PortableChatContinuationClosureCounts {
  const activeReachableIds =
    walked === null
      ? new Set<string>()
      : new Set([
          ...walked.blobs.map((blob) => blob.id),
          ...walked.unavailableIds,
        ]);
  return {
    declaredBlobCount: snapshot.agentKv.blobs.length,
    declaredReferencedCount: snapshot.agentKv.referencedIds.length,
    declaredMissingCount: snapshot.agentKv.missingIds.length,
    activeReachableCount: activeReachableIds.size,
    activeMaterializedCount: walked?.blobs.length ?? 0,
    activeUnavailableCount: walked?.unavailableIds.length ?? 0,
    visitedNodeCount: walked?.visitedNodes ?? 0,
  };
}

function portableBlobLookup(
  rows: ReadonlyMap<string, PortableKvRow>,
  key: string,
  remainingBytes: number,
) {
  const row = rows.get(key);
  if (row === undefined) {
    return { status: "missing" } as const;
  }
  const decodedBytes = decodedBase64ByteLength(row.valueBase64);
  if (decodedBytes > remainingBytes) {
    return { status: "over-budget" } as const;
  }
  const valueType = row.valueType;
  if (valueType !== "text" && valueType !== "blob") {
    return {
      status: "unreadable",
      reason: "portable agentKv row has an invalid storage class",
    } as const;
  }
  return {
    status: "found",
    key,
    bytes: Buffer.from(row.valueBase64, "base64"),
    valueType,
  } as const;
}

/** Input has already passed the portable parser's canonical-Base64 check. */
function decodedBase64ByteLength(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
