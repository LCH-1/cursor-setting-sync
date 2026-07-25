import { canonicalBytes, sha256 } from "../protocol/canonical";
import type { MergeOutcome } from "../types";
import type { PortableChatSnapshot, PortableKvRow } from "./stateVscdb";
import { parsePortableChatSnapshot } from "./stateVscdb";

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
 *    "resolving a chat conflict deletes half a conversation". With a base, a
 *    key the base had and one side dropped is a real deletion and is honoured.
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
}

export function mergeChatSnapshotBuffers(
  base: Buffer | null,
  ordered: readonly [Buffer, Buffer],
): ChatMergeResult {
  const [first, second] = ordered;
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
  // Checked after the parse, not before it: an equality shortcut in front would
  // report two byte-identical payloads this build cannot read as a clean
  // "unchanged" and hand them on to be published.
  if (first.equals(second)) {
    return {
      status: "unchanged",
      content: first,
      semanticHash: sha256(first),
      winner: 0,
    };
  }
  const baseSnapshot = parseBaseSnapshot(base, firstSnapshot.composerId);
  // `lastUpdatedAt` comes out of the payloads both devices read, so electing on
  // it is as replicated as electing on the tip order and it is better data: it
  // names the newer capture of the conversation rather than the later publish.
  // A `null` timestamp carries no ordering information, so it never outranks a
  // real one; two nulls, or a tie, fall back to the replicated tip order.
  const winnerIndex = compareLastUpdatedAt(firstSnapshot, secondSnapshot) >= 0 ? 0 : 1;
  const winner = winnerIndex === 0 ? firstSnapshot : secondSnapshot;
  let merged: PortableChatSnapshot;
  let content: Buffer;
  try {
    merged = {
      schemaVersion: 1,
      composerId: winner.composerId,
      header: winner.header,
      composerData: winner.composerData,
      bubbles: mergeBubbles(baseSnapshot, firstSnapshot, secondSnapshot, winner),
    };
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
  } catch {
    return { status: "conflict" };
  }
  return {
    status: "merged",
    content,
    semanticHash: sha256(content),
    winner: winnerIndex,
    bubbleCount: merged.bubbles.length,
  };
}

/**
 * A base that cannot be parsed is treated as no base at all rather than as a
 * failure: without it the merge degrades from "honour deletions" to "union",
 * which keeps more of the conversation, never less.
 */
function parseBaseSnapshot(
  base: Buffer | null,
  composerId: string,
): PortableChatSnapshot | null {
  if (base === null) {
    return null;
  }
  try {
    const parsed = parsePortableChatSnapshot(base);
    return parsed.composerId === composerId ? parsed : null;
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
  winner: PortableChatSnapshot,
): PortableKvRow[] {
  const baseRows = indexBubbles(base?.bubbles ?? []);
  const firstRows = indexBubbles(first.bubbles);
  const secondRows = indexBubbles(second.bubbles);
  const winnerRows = winner === first ? firstRows : secondRows;
  const merged: PortableKvRow[] = [];
  for (const key of [...new Set([...firstRows.keys(), ...secondRows.keys()])].sort(
    compareStrings,
  )) {
    const inFirst = firstRows.get(key);
    const inSecond = secondRows.get(key);
    if (inFirst !== undefined && inSecond !== undefined) {
      // Present on both sides. Identical rows are the overwhelming case; a row
      // that genuinely differs is one side re-encoding the same message, so the
      // winner's copy is taken for the same reason its `composerData` is.
      merged.push(sameRow(inFirst, inSecond) ? inFirst : winnerRows.get(key) ?? inFirst);
      continue;
    }
    // Present on one side only: an addition when the base never had it, and a
    // deletion by the other side when it did.
    if (base !== null && baseRows.has(key)) {
      continue;
    }
    merged.push((inFirst ?? inSecond) as PortableKvRow);
  }
  return merged;
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
