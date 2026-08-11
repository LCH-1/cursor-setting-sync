import { canonicalBytes, sha256 } from "../protocol/canonical";
import type { MergeOutcome } from "../types";
import type {
  PortableAgentKvPayload,
  PortableChatSnapshot,
  PortableChatSnapshotV1,
  PortableChatSnapshotV2,
  PortableKvRow,
} from "./stateVscdb";
import {
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  scanPortableChatConversationStates,
} from "./stateVscdb";
import { extractAgentKvRootIds } from "./agentKv";
import {
  canonicalJsonStringByteLength,
  portableComposerHeaderCanonicalByteLength,
} from "./headerCanonical";

const CHAT_CORE_AGENT_KV_MAX_NODES = 4_096;
const CHAT_CORE_AGENT_KV_MAX_BYTES = 32 * 1024 * 1024;
/**
 * An automatic conflict merge runs on Cursor's interactive extension host.
 * Keep the whole parse/union/serialize working set far below the repository's
 * normal 128 MiB per-resource allowance; larger conversations remain intact as
 * a manual conflict instead of briefly multiplying into several hundred MiB.
 */
export const CHAT_AUTO_MERGE_MAX_WORK_BYTES = 32 * 1024 * 1024;
/** Maps, sets and sort scratch scale with row count even when values are tiny. */
const CHAT_AUTO_MERGE_MAX_BUBBLE_ROW_WORK = 16_384;
/** JSON.parse object/array work must be bounded before it materializes nodes. */
const CHAT_AUTO_MERGE_MAX_JSON_STRUCTURAL_TOKENS = 65_536;
const CHAT_AUTO_MERGE_MAX_JSON_NESTING_DEPTH = 256;
/** Fixed punctuation/headroom for the conservative pre-Map output estimate. */
const CHAT_AUTO_MERGE_CANONICAL_OVERHEAD_BYTES = 4 * 1024;

class ChatMergeWorkBudgetError extends Error {}

/**
 * Merges two forks of one chat.
 *
 * A chat snapshot is not an opaque payload: it is a header, one `composerData`
 * row and a list of `bubbleId:` rows that carry the conversation itself. The
 * bubbles are keyed, so the two sides of a fork can be combined element by
 * element instead of one side being thrown away — which is what made chat the
 * one content-bearing kind that could not resolve on its own.
 *
 * Two rules do all the work:
 *
 *  - **The bubbles are unioned.** A bubble is an immutable message; a key only
 *    one side has is a message only that side captured, and keeping both sides'
 *    keys is the difference between "a chat conflict costs you nothing" and
 *    "resolving a chat conflict deletes half a conversation". Cursor exposes
 *    no per-message deletion; a row missing from one device is local pruning,
 *    so even a key present in the base remains in the additive union. When the
 *    same key has different bytes, the base must identify exactly one changed
 *    side; a base-free or two-sided disagreement remains manual.
 *  - **The header and `composerData` come from one side whole.** They describe
 *    the conversation's shape — its title, ordering and checkpoint — and half of
 *    one plus half of the other describes no conversation at all. The side that
 *    wins is the one with the greater `header.lastUpdatedAt`, which is the
 *    newer capture of the same conversation. Orphaned bubbles that the winning
 *    `composerData` does not reference are inert rows, so a union costs storage,
 *    never correctness.
 *
 * `ordered` must already be in the caller's replicated tip order (newest
 * first). Both devices sort the same two tips with the same comparator and hand
 * them over in the same order, so both compute the same winner from the same
 * bytes and publish a byte-identical result that the reconciler collapses into
 * one version. Nothing here may look at which side is "local": an asymmetric
 * rule would make the two devices publish different bytes and re-conflict
 * immediately.
 */
export interface ChatMergeResult extends MergeOutcome {
  /**
   * Index into `ordered` of the side whose header and `composerData` were
   * adopted. The caller publishes that tip's metadata with the merged content:
   * the reconciler collapses two events on operation plus semanticHash alone,
   * so metadata that disagreed between the devices would be decided by whichever
   * published last.
   */
  winner?: 0 | 1;
  /** Bubble count of the merged snapshot, for the published tip metadata. */
  bubbleCount?: number;
  /** Lets the caller explain a deliberate bounded-work refusal to the user. */
  workBudgetExceeded?: true;
}

export function mergeChatSnapshotBuffers(
  base: Buffer | null,
  ordered: readonly [Buffer, Buffer],
  maxWorkBytes = CHAT_AUTO_MERGE_MAX_WORK_BYTES,
): ChatMergeResult {
  const [first, second] = ordered;
  const workBudget = normalizedChatMergeWorkBudget(maxWorkBytes);
  if (
    workBudget === null ||
    !buffersFitMergeBudget(base, first, second, workBudget) ||
    !buffersFitChatJsonStructureBudget(base, first, second)
  ) {
    return workBudgetConflict();
  }
  let firstSnapshot: PortableChatSnapshot;
  let secondSnapshot: PortableChatSnapshot;
  try {
    firstSnapshot = parsePortableChatSnapshot(first);
    secondSnapshot = parsePortableChatSnapshot(second);
  } catch {
    // Not a snapshot this build understands - a future schema version, or one
    // of the non-UUID composer rows Cursor keeps (`empty-state-draft`) that the
    // parser rejects. Manual resolution is the honest answer.
    return { status: "conflict" };
  }
  if (firstSnapshot.composerId !== secondSnapshot.composerId) {
    return { status: "conflict" };
  }
  // The shared parser deliberately tolerates unknown fields for forward
  // compatibility. An automatic merge cannot: carrying them into the recursive
  // canonical serializer makes both its memory cost and nesting depth
  // unbounded. Manual resolution preserves the original tips verbatim.
  if (
    !hasExactMergeSafeSnapshotShape(firstSnapshot) ||
    !hasExactMergeSafeSnapshotShape(secondSnapshot)
  ) {
    return { status: "conflict" };
  }
  const baseSnapshot = parseBaseSnapshot(base, firstSnapshot.composerId);
  if (base !== null && baseSnapshot === null) {
    // A genuine three-way base is authoritative input, not an optional hint.
    // Treating an invalid, wrong-composer or forward-shaped base as "absent"
    // silently drops rows both tips pruned. Preserve all three versions for
    // manual resolution instead.
    return { status: "conflict" };
  }
  // `lastUpdatedAt` comes out of the payloads both devices read, so electing on
  // it is as replicated as electing on the tip order and it is better data: it
  // names the newer capture of the conversation rather than the later publish.
  // A `null` timestamp carries no ordering information, so it never outranks a
  // real one; two nulls, or a tie, fall back to the replicated tip order.
  const winnerIndex = compareLastUpdatedAt(firstSnapshot, secondSnapshot) >= 0 ? 0 : 1;
  const winner = winnerIndex === 0 ? firstSnapshot : secondSnapshot;
  const emitsV2 =
    (baseSnapshot !== null && isPortableChatSnapshotV2(baseSnapshot)) ||
    isPortableChatSnapshotV2(firstSnapshot) ||
    isPortableChatSnapshotV2(secondSnapshot);
  // This scan is deliberately conservative and happens before the first merge
  // Map/Set. Disjoint but individually valid tips can otherwise allocate the
  // three indexes, a union Set, sorted arrays and a canonical copy before the
  // final repository payload check notices that the result is too large.
  if (
    !chatMergeStructureFitsBudget(
      baseSnapshot,
      firstSnapshot,
      secondSnapshot,
      winner,
      emitsV2,
      workBudget,
    )
  ) {
    return workBudgetConflict();
  }
  let merged: PortableChatSnapshot;
  let content: Buffer;
  try {
    const bubbles = mergeBubbles(
      baseSnapshot,
      firstSnapshot,
      secondSnapshot,
    );
    if (bubbles === null) {
      return { status: "conflict" };
    }
    const core = {
      composerId: winner.composerId,
      header: winner.header,
      composerData: winner.composerData,
      bubbles,
    };
    const coreSnapshot = {
      ...core,
      schemaVersion: 1,
    } satisfies PortableChatSnapshotV1;
    if (emitsV2) {
      const stateScan = scanPortableChatConversationStates(coreSnapshot);
      if (stateScan.status === "structure-limit") {
        return workBudgetConflict();
      }
      const coreRoots = extractBoundedChatCoreAgentKvRootsFromStates(
        stateScan.states,
      );
      if (coreRoots === null) {
        return { status: "conflict" };
      }
      merged = {
        ...core,
        schemaVersion: 2,
        agentKv: mergeAgentKvPayload(
          baseSnapshot,
          firstSnapshot,
          secondSnapshot,
          coreRoots,
        ),
      } satisfies PortableChatSnapshotV2;
    } else {
      merged = coreSnapshot;
    }
    // Exact non-allocating size check after deduplication. The conservative
    // gate above bounded the Map/Set work; this one proves canonicalBytes will
    // not allocate a result beyond the same interactive cap.
    if (portableChatCanonicalByteLength(merged) > workBudget) {
      return workBudgetConflict();
    }
    // `StateVscdbChatAdapter.scan` publishes `canonicalBytes(snapshot)` and
    // hashes those same bytes, so the merge has to produce both the same way or
    // the next scan computes a hash the tip does not carry and republishes
    // forever.
    //
    // Inside the guard, not after it: `parsePortableChatSnapshot` validates the
    // fields this format defines but does not strip the ones it does not, so a
    // peer can attach a deeply nested extra property that survives validation
    // and overflows the stack in the recursive canonical serializer. An error
    // escaping from here reaches `autoMergeConflicts`, which runs before the
    // scan, the publish and the apply — one throw there aborts the whole cycle,
    // and since events are immutable the next poll would rebuild the identical
    // conflict and throw again, permanently.
    content = canonicalBytes(merged);
  } catch (error) {
    return error instanceof ChatMergeWorkBudgetError
      ? workBudgetConflict()
      : { status: "conflict" };
  }
  // Validate and normalize identical tips through the same path as a real
  // fork. A readable base may still contribute a row both tips pruned (or v2
  // graph data both dropped), so equality of the tips alone is not enough to
  // declare the merge unchanged.
  if (first.equals(second) && content.equals(first)) {
    return {
      status: "unchanged",
      content: first,
      semanticHash: sha256(first),
      winner: 0,
    };
  }
  return {
    status: "merged",
    content,
    semanticHash: sha256(content),
    winner: winnerIndex,
    bubbleCount: merged.bubbles.length,
  };
}

function workBudgetConflict(): ChatMergeResult {
  return { status: "conflict", workBudgetExceeded: true };
}

/**
 * Content-addressed rows are immutable, so unlike bubbles they are always an
 * additive union. A blob supplied by either side satisfies the other side's
 * missing reference; only references absent from both payloads remain missing.
 */
function mergeAgentKvPayload(
  base: PortableChatSnapshot | null,
  first: PortableChatSnapshot,
  second: PortableChatSnapshot,
  coreRoots: readonly string[],
): PortableAgentKvPayload {
  const referenced = new Set<string>();
  const blobs = new Map<string, PortableKvRow>();
  let decodedBlobBytes = 0;
  for (const snapshot of [base, first, second]) {
    if (snapshot === null || !isPortableChatSnapshotV2(snapshot)) {
      continue;
    }
    for (const id of snapshot.agentKv.referencedIds) {
      addBoundedAgentKvReference(referenced, id);
    }
    for (const blob of snapshot.agentKv.blobs) {
      // The parser proved both values hash to the ID. Keeping the first storage
      // representation makes the result deterministic in replicated tip order
      // even when one SQLite database stored the same bytes as TEXT and the
      // other stored them as BLOB.
      if (!blobs.has(blob.key)) {
        if (blobs.size >= CHAT_CORE_AGENT_KV_MAX_NODES) {
          throw new ChatMergeWorkBudgetError(
            "Merged agentKv blob count exceeds its safety limit.",
          );
        }
        const blobBytes = decodedBase64Bytes(blob.valueBase64);
        if (blobBytes > CHAT_CORE_AGENT_KV_MAX_BYTES - decodedBlobBytes) {
          throw new ChatMergeWorkBudgetError(
            "Merged agentKv blob bytes exceed their safety limit.",
          );
        }
        blobs.set(blob.key, blob);
        decodedBlobBytes += blobBytes;
      }
    }
  }
  for (const id of coreRoots) {
    addBoundedAgentKvReference(referenced, id);
  }
  const sortedReferenced = [...referenced].sort(compareStrings);
  const sortedBlobs = [...blobs.values()].sort((left, right) =>
    compareStrings(left.key, right.key),
  );
  return {
    blobs: sortedBlobs,
    referencedIds: sortedReferenced,
    missingIds: sortedReferenced.filter(
      (id) => !blobs.has(`agentKv:blob:${id}`),
    ),
  };
}

function addBoundedAgentKvReference(
  referenced: Set<string>,
  id: string,
): void {
  if (referenced.has(id)) {
    return;
  }
  // Check before insertion: even adversarial, individually valid inputs can
  // have almost-disjoint graphs, and the merge must never construct an
  // over-limit Set only to reject it after sorting or serialization.
  if (referenced.size >= CHAT_CORE_AGENT_KV_MAX_NODES) {
    throw new ChatMergeWorkBudgetError(
      "Merged agentKv reference count exceeds its safety limit.",
    );
  }
  referenced.add(id);
}

/** Exact decoded length of parser-validated canonical Base64, without decoding. */
function decodedBase64Bytes(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/**
 * Extracts the exact top-level continuation roots named by the core that will
 * be published. A v2 payload is a complete materialized/missing partition, so
 * an unreadable or truncated core must not inherit another version's graph and
 * falsely claim that nothing is missing.
 */
export function extractBoundedChatCoreAgentKvRoots(
  snapshot: PortableChatSnapshot,
): string[] | null {
  const stateScan = scanPortableChatConversationStates(snapshot);
  return stateScan.status === "structure-limit"
    ? null
    : extractBoundedChatCoreAgentKvRootsFromStates(stateScan.states);
}

function extractBoundedChatCoreAgentKvRootsFromStates(
  states: readonly string[],
): string[] | null {
  const extracted = extractAgentKvRootIds(
    states,
    {
      limits: {
        maxNodes: CHAT_CORE_AGENT_KV_MAX_NODES,
        maxBytes: CHAT_CORE_AGENT_KV_MAX_BYTES,
      },
    },
  );
  return extracted.complete ? extracted.roots : null;
}

/** A non-null base must parse exactly; the caller fails closed otherwise. */
function parseBaseSnapshot(
  base: Buffer | null,
  composerId: string,
): PortableChatSnapshot | null {
  if (base === null) {
    return null;
  }
  try {
    const parsed = parsePortableChatSnapshot(base);
    return parsed.composerId === composerId && hasExactMergeSafeSnapshotShape(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function compareLastUpdatedAt(
  left: PortableChatSnapshot,
  right: PortableChatSnapshot,
): number {
  const leftAt = left.header.lastUpdatedAt;
  const rightAt = right.header.lastUpdatedAt;
  if (leftAt === rightAt) {
    return 0;
  }
  if (leftAt === null) {
    return -1;
  }
  if (rightAt === null) {
    return 1;
  }
  return leftAt < rightAt ? -1 : 1;
}

/**
 * Three-way merge of the bubble rows, keyed by `key`.
 *
 * Ordering is by key ascending, which is what `StateVscdbChatAdapter.scan`
 * reads back (`ORDER BY key`); any other order would hash differently on the
 * next scan and republish.
 */
function mergeBubbles(
  base: PortableChatSnapshot | null,
  first: PortableChatSnapshot,
  second: PortableChatSnapshot,
): PortableKvRow[] | null {
  const baseRows =
    base === null
      ? new Map<string, PortableKvRow>()
      : indexBubbles(base.bubbles);
  const firstRows = indexBubbles(first.bubbles);
  const secondRows = indexBubbles(second.bubbles);
  const merged: PortableKvRow[] = [];
  const keySet = new Set<string>();
  for (const rows of [baseRows, firstRows, secondRows]) {
    for (const key of rows.keys()) {
      keySet.add(key);
    }
  }
  for (const key of [...keySet].sort(compareStrings)) {
    const inFirst = firstRows.get(key);
    const inSecond = secondRows.get(key);
    if (inFirst !== undefined && inSecond !== undefined) {
      if (sameRow(inFirst, inSecond)) {
        merged.push(inFirst);
        continue;
      }
      // A same-key disagreement is not safely coupled to header recency. In a
      // three-way merge, only the side that differs from the base can be known
      // to have changed the row; if both differ (or there is no base), choosing
      // either would silently discard the other message representation.
      const inBase = baseRows.get(key);
      if (inBase === undefined) {
        return null;
      }
      const firstMatchesBase = sameRow(inFirst, inBase);
      const secondMatchesBase = sameRow(inSecond, inBase);
      if (firstMatchesBase === secondMatchesBase) {
        return null;
      }
      merged.push(firstMatchesBase ? inSecond : inFirst);
      continue;
    }
    // Present on one tip only, or only in the readable base. Cursor has no
    // per-message delete operation; disappearance from one or both device
    // databases is pruning, and the winning composerData decides whether this
    // retained inert row is visible. A tip copy outranks the base copy because
    // it may carry a newer storage representation of the same immutable row.
    merged.push((inFirst ?? inSecond ?? baseRows.get(key)) as PortableKvRow);
  }
  return merged;
}

function normalizedChatMergeWorkBudget(value: number): number | null {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return Math.min(value, CHAT_AUTO_MERGE_MAX_WORK_BYTES);
}

function buffersFitMergeBudget(
  base: Buffer | null,
  first: Buffer,
  second: Buffer,
  budget: number,
): boolean {
  let remaining = budget;
  for (const content of [base, first, second]) {
    if (content === null) {
      continue;
    }
    if (content.byteLength > remaining) {
      return false;
    }
    remaining -= content.byteLength;
  }
  return true;
}

/**
 * Scans the strict-JSON snapshot bytes before `toString`/`JSON.parse` can turn
 * a compact array into hundreds of thousands of objects. Structural
 * punctuation counts every object property and array item without allocating
 * strings or token arrays; nesting is bounded independently to protect the
 * recursive validators and canonical serializer. The budget is aggregate
 * across the base and both tips because all parsed graphs would coexist.
 */
function buffersFitChatJsonStructureBudget(
  base: Buffer | null,
  first: Buffer,
  second: Buffer,
): boolean {
  let remaining = CHAT_AUTO_MERGE_MAX_JSON_STRUCTURAL_TOKENS;
  for (const content of [base, first, second]) {
    if (content === null) {
      continue;
    }
    // Count a scalar root even when it has no structural punctuation.
    if (remaining <= 0) {
      return false;
    }
    remaining -= 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const byte of content) {
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (byte === 0x5c) {
          escaped = true;
        } else if (byte === 0x22) {
          inString = false;
        }
        continue;
      }
      if (byte === 0x22) {
        inString = true;
        continue;
      }
      const opens = byte === 0x7b || byte === 0x5b;
      const closes = byte === 0x7d || byte === 0x5d;
      if (!opens && !closes && byte !== 0x2c && byte !== 0x3a) {
        continue;
      }
      if (remaining <= 0) {
        return false;
      }
      remaining -= 1;
      if (opens) {
        depth += 1;
        if (depth > CHAT_AUTO_MERGE_MAX_JSON_NESTING_DEPTH) {
          return false;
        }
      } else if (closes) {
        // Malformed syntax is left to the existing parser path; unmatched
        // closers do not create recursive work and cannot evade token debit.
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return true;
}

/**
 * Bounds the row-index and canonical-output work before constructing any of
 * the merge's Maps/Sets. Counts are intentionally occurrence counts, not
 * unique counts: duplicate keys still have to be indexed on each input side.
 */
function chatMergeStructureFitsBudget(
  base: PortableChatSnapshot | null,
  first: PortableChatSnapshot,
  second: PortableChatSnapshot,
  winner: PortableChatSnapshot,
  emitsV2: boolean,
  budget: number,
): boolean {
  const snapshots = base === null ? [first, second] : [base, first, second];
  const bubbleOccurrences = snapshots.reduce(
    (count, snapshot) => count + snapshot.bubbles.length,
    0,
  );
  if (bubbleOccurrences > CHAT_AUTO_MERGE_MAX_BUBBLE_ROW_WORK) {
    return false;
  }

  let work = CHAT_AUTO_MERGE_CANONICAL_OVERHEAD_BYTES;
  const add = (bytes: number): boolean => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget - work) {
      return false;
    }
    work += bytes;
    return true;
  };
  try {
    if (
      !add(portableComposerHeaderCanonicalByteLength(winner.header)) ||
      !add(portableKvRowCanonicalByteLength(winner.composerData)) ||
      !add(canonicalJsonStringByteLength(winner.composerId))
    ) {
      return false;
    }
    for (const snapshot of snapshots) {
      for (const bubble of snapshot.bubbles) {
        // One comma is a safe upper bound on this row's array separator.
        if (!add(portableKvRowCanonicalByteLength(bubble) + 1)) {
          return false;
        }
      }
    }
    if (!emitsV2) {
      return true;
    }
    for (const snapshot of snapshots) {
      if (!isPortableChatSnapshotV2(snapshot)) {
        continue;
      }
      for (const blob of snapshot.agentKv.blobs) {
        if (!add(portableKvRowCanonicalByteLength(blob) + 1)) {
          return false;
        }
      }
      // The output carries every unique reference once and at most the same
      // set again as missing. Counting every occurrence twice is conservative
      // and avoids allocating a preflight Set.
      for (const id of snapshot.agentKv.referencedIds) {
        const encoded = canonicalJsonStringByteLength(id) + 1;
        if (!add(encoded) || !add(encoded)) {
          return false;
        }
      }
    }
    // A winning v1 core may introduce roots absent from every v2 payload.
    // Reserve the full graph node limit twice (referenced + possibly missing)
    // before extracting or allocating the exact union.
    const rootIdBytes = canonicalJsonStringByteLength("0".repeat(64)) + 1;
    return (
      add(CHAT_CORE_AGENT_KV_MAX_NODES * rootIdBytes) &&
      add(CHAT_CORE_AGENT_KV_MAX_NODES * rootIdBytes)
    );
  } catch {
    return false;
  }
}

/** Exact canonical size of the normalized snapshot the merge constructs. */
function portableChatCanonicalByteLength(
  snapshot: PortableChatSnapshot,
): number {
  let bytes = Buffer.byteLength('{"bubbles":[');
  if (isPortableChatSnapshotV2(snapshot)) {
    bytes = Buffer.byteLength('{"agentKv":{"blobs":[');
    bytes = addCanonicalArrayBytes(bytes, snapshot.agentKv.blobs, portableKvRowCanonicalByteLength);
    bytes += Buffer.byteLength('],"missingIds":[');
    bytes = addCanonicalArrayBytes(bytes, snapshot.agentKv.missingIds, canonicalJsonStringByteLength);
    bytes += Buffer.byteLength('],"referencedIds":[');
    bytes = addCanonicalArrayBytes(bytes, snapshot.agentKv.referencedIds, canonicalJsonStringByteLength);
    bytes += Buffer.byteLength(']},"bubbles":[');
  }
  bytes = addCanonicalArrayBytes(bytes, snapshot.bubbles, portableKvRowCanonicalByteLength);
  bytes += Buffer.byteLength('],"composerData":');
  bytes += portableKvRowCanonicalByteLength(snapshot.composerData);
  bytes += Buffer.byteLength(',"composerId":');
  bytes += canonicalJsonStringByteLength(snapshot.composerId);
  bytes += Buffer.byteLength(',"header":');
  bytes += portableComposerHeaderCanonicalByteLength(snapshot.header);
  bytes += Buffer.byteLength(',"schemaVersion":1}');
  if (!Number.isSafeInteger(bytes)) {
    throw new Error("Merged chat canonical length exceeds the safe integer range.");
  }
  return bytes;
}

function addCanonicalArrayBytes<T>(
  initial: number,
  values: readonly T[],
  byteLength: (value: T) => number,
): number {
  let bytes = initial;
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) {
      bytes += 1;
    }
    bytes += byteLength(values[index] as T);
    if (!Number.isSafeInteger(bytes)) {
      throw new Error("Merged chat canonical length exceeds the safe integer range.");
    }
  }
  return bytes;
}

function portableKvRowCanonicalByteLength(row: PortableKvRow): number {
  let bytes = Buffer.byteLength('{"key":');
  bytes += canonicalJsonStringByteLength(row.key);
  bytes += Buffer.byteLength(',"valueBase64":');
  // The parser already proved this is canonical Base64: its alphabet is ASCII
  // and contains neither quote nor backslash, so its JSON-string size is exact
  // without rescanning a multi-megabyte value character by character.
  bytes += row.valueBase64.length + 2;
  if (row.valueType !== undefined) {
    bytes += Buffer.byteLength(',"valueType":');
    bytes += canonicalJsonStringByteLength(row.valueType);
  }
  return bytes + 1;
}

function hasExactMergeSafeSnapshotShape(
  snapshot: PortableChatSnapshot,
): boolean {
  const expectedSnapshotKeys = isPortableChatSnapshotV2(snapshot)
    ? ["agentKv", "bubbles", "composerData", "composerId", "header", "schemaVersion"]
    : ["bubbles", "composerData", "composerId", "header", "schemaVersion"];
  if (
    !hasExactKeys(snapshot, expectedSnapshotKeys) ||
    !hasExactKeys(snapshot.header, [
      "checkpointAt",
      "composerId",
      "createdAt",
      "isArchived",
      "isSubagent",
      "lastUpdatedAt",
      "recency",
      "value",
      "workspaceId",
    ]) ||
    !hasExactPortableRowShape(snapshot.composerData) ||
    snapshot.bubbles.some((row) => !hasExactPortableRowShape(row))
  ) {
    return false;
  }
  return (
    !isPortableChatSnapshotV2(snapshot) ||
    (hasExactKeys(snapshot.agentKv, ["blobs", "missingIds", "referencedIds"]) &&
      snapshot.agentKv.blobs.every((row) => hasExactPortableRowShape(row)))
  );
}

function hasExactPortableRowShape(row: PortableKvRow): boolean {
  return hasExactKeys(
    row,
    row.valueType === undefined
      ? ["key", "valueBase64"]
      : ["key", "valueBase64", "valueType"],
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function indexBubbles(rows: readonly PortableKvRow[]): Map<string, PortableKvRow> {
  const index = new Map<string, PortableKvRow>();
  for (const row of rows) {
    index.set(row.key, row);
  }
  return index;
}

function sameRow(left: PortableKvRow, right: PortableKvRow): boolean {
  return (
    left.valueBase64 === right.valueBase64 && left.valueType === right.valueType
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
