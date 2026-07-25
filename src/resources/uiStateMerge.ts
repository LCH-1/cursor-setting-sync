import { canonicalBytes, canonicalJson } from "../protocol/canonical";
import type { JsonValue, MergeOutcome } from "../types";

export interface UiStateMergeResult {
  /** Undefined means the key or element is absent from the merged value. */
  value: JsonValue | undefined;
  /** True when the three inputs have no merge this function can prove. */
  conflict: boolean;
}

const DECLINED: UiStateMergeResult = { value: undefined, conflict: true };

/**
 * The first of these fields carried by every element of the base array names
 * the element identity. VS Code writes `id` for the pinned-panel and hidden-
 * view arrays; the other two spellings cover the same shape elsewhere.
 */
const ID_FIELDS = ["id", "identifier", "key"] as const;

/**
 * Three-way merge for a `ui-state` value read verbatim out of `ItemTable`.
 *
 * Every branch below is symmetric in `local` and `remote`. The two devices
 * that produced the fork swap those two arguments, so an asymmetric branch
 * would make them publish different bytes and immediately re-conflict. The
 * merged value is additionally serialized canonically, which pins the byte
 * representation even when a subtree is adopted wholesale from one side. That
 * byte identity is the requirement: a ui-state semantic hash is sha256 of the
 * raw content, so only identical bytes let the reconciler collapse the two
 * independent merge events without another round trip.
 *
 * Anything this function cannot prove symmetric reports a conflict instead of
 * guessing.
 */
export function mergeUiStateBuffers(
  base: Buffer,
  local: Buffer,
  remote: Buffer,
): MergeOutcome {
  if (local.equals(remote)) {
    return { status: "unchanged", content: local };
  }
  if (local.equals(base)) {
    return { status: "merged", content: remote };
  }
  if (remote.equals(base)) {
    return { status: "merged", content: local };
  }
  let merged: UiStateMergeResult;
  try {
    merged = mergeUiStateValues(
      parseUiStateValue(base),
      parseUiStateValue(local),
      parseUiStateValue(remote),
    );
  } catch {
    // Not JSON at all: several live USER-target keys hold a bare string such
    // as "default" or a version number, which has no structure to merge.
    return { status: "conflict" };
  }
  if (merged.conflict || merged.value === undefined) {
    return { status: "conflict" };
  }
  // No semanticHash, so the caller hashes the raw bytes exactly the way
  // UiStateAdapter.scan hashes the row when it next reads the value back.
  return { status: "merged", content: canonicalBytes(merged.value) };
}

function mergeUiStateValues(
  base: JsonValue | undefined,
  local: JsonValue | undefined,
  remote: JsonValue | undefined,
): UiStateMergeResult {
  if (deepEqual(local, remote)) {
    return { value: local, conflict: false };
  }
  if (deepEqual(local, base)) {
    return { value: remote, conflict: false };
  }
  if (deepEqual(remote, base)) {
    return { value: local, conflict: false };
  }
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    return mergeIdentifiedArrays(base, local, remote);
  }
  if (isObject(base) && isObject(local) && isObject(remote)) {
    // Mirrors the object branch of mergeJsonValues, but recurses back through
    // this function so an identified array nested inside an object merges
    // structurally instead of aborting the whole value.
    const output = Object.create(null) as Record<string, JsonValue>;
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);
    for (const key of [...keys].sort(compareStrings)) {
      const merged = mergeUiStateValues(base[key], local[key], remote[key]);
      if (merged.conflict) {
        return DECLINED;
      }
      if (merged.value !== undefined) {
        output[key] = merged.value;
      }
    }
    return { value: output, conflict: false };
  }
  return DECLINED;
}

/**
 * Merges two divergent versions of an array whose elements are objects keyed
 * by a stable id — `workbench.activity.pinnedViewlets2` and every
 * `*.state.hidden` list. Anything that does not match that shape exactly
 * declines the merge.
 *
 * `workbench.auxiliarybar.pinnedPanels` is deliberately *not* in that list even
 * though it has the shape and the conflict prompt for it is what prompted this
 * merger: `uiStatePolicy` excludes the key, so this device never writes the
 * result. The merge still runs for it, because a fork published by a peer on
 * 0.0.1-0.0.3 has to resolve deterministically or the conflict sits in the
 * repository forever — the merged value goes back to the peers that still want
 * it, and the union of both machines' dead chat-panel GUIDs never lands here.
 */
function mergeIdentifiedArrays(
  base: JsonValue[],
  local: JsonValue[],
  remote: JsonValue[],
): UiStateMergeResult {
  const field = identityField(base, local, remote);
  if (field === undefined) {
    return DECLINED;
  }
  const baseEntries = indexById(base, field);
  const localEntries = indexById(local, field);
  const remoteEntries = indexById(remote, field);
  if (
    baseEntries === undefined ||
    localEntries === undefined ||
    remoteEntries === undefined
  ) {
    return DECLINED;
  }
  const merged = new Map<string, JsonValue>();
  const ids = new Set([
    ...baseEntries.keys(),
    ...localEntries.keys(),
    ...remoteEntries.keys(),
  ]);
  for (const id of ids) {
    const element = mergeUiStateValues(
      baseEntries.get(id),
      localEntries.get(id),
      remoteEntries.get(id),
    );
    if (element.conflict) {
      return DECLINED;
    }
    if (element.value !== undefined) {
      merged.set(id, element.value);
    }
  }
  // Array order is user-visible — it is the pin order — so it has to come from
  // inputs both devices share. Ids the base already had keep the base order;
  // ids either side added are appended by their own `order` field and then by
  // id, never by which side happens to be "local" on this device.
  const survivors = [...baseEntries.keys()].filter((id) => merged.has(id));
  const added = [...merged.keys()]
    .filter((id) => !baseEntries.has(id))
    .sort((left, right) => compareAddedIds(left, right, merged));
  return {
    value: [...survivors, ...added].map((id) => merged.get(id) as JsonValue),
    conflict: false,
  };
}

function identityField(
  base: JsonValue[],
  local: JsonValue[],
  remote: JsonValue[],
): string | undefined {
  // Read from the base whenever it has elements, so both devices choose the
  // same field from the same bytes; an empty base needs the two sides to agree.
  const sources = base.length > 0 ? [base] : [local, remote];
  return ID_FIELDS.find((field) =>
    sources.every(
      (elements) =>
        elements.length > 0 &&
        elements.every(
          (element) => isObject(element) && typeof element[field] === "string",
        ),
    ),
  );
}

function indexById(
  elements: JsonValue[],
  field: string,
): Map<string, JsonValue> | undefined {
  const index = new Map<string, JsonValue>();
  for (const element of elements) {
    if (!isObject(element) || typeof element[field] !== "string") {
      return undefined;
    }
    const id = element[field];
    if (index.has(id)) {
      // A duplicate id makes "the element with this id" ambiguous, and a merge
      // that silently drops one of them is worse than a manual resolution.
      return undefined;
    }
    index.set(id, element);
  }
  return index;
}

function compareAddedIds(
  left: string,
  right: string,
  merged: Map<string, JsonValue>,
): number {
  const order = elementOrder(merged.get(left)) - elementOrder(merged.get(right));
  return order !== 0 ? order : compareStrings(left, right);
}

function elementOrder(element: JsonValue | undefined): number {
  if (isObject(element) && typeof element.order === "number") {
    return element.order;
  }
  return Number.MAX_SAFE_INTEGER;
}

function parseUiStateValue(content: Buffer): JsonValue {
  return JSON.parse(content.toString("utf8")) as JsonValue;
}

function deepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return canonicalJson(left) === canonicalJson(right);
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== undefined && value !== null && !Array.isArray(value) && typeof value === "object";
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
