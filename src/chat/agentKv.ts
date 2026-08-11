import { compareCodeUnits, isCanonicalBase64Text, sha256 } from "../protocol/canonical";

export const AGENT_KV_BLOB_PREFIX = "agentKv:blob:";

export interface AgentKvWalkLimits {
  /** Maximum number of distinct content IDs for which lookup may be called. */
  maxNodes: number;
  /** Maximum decoded bytes retained across unique seeds and valid blobs. */
  maxBytes: number;
  /** Maximum blob-edge depth. Root blobs are at depth zero. */
  maxDepth: number;
  /** Maximum nested length-delimited protobuf message depth to inspect. */
  maxProtobufDepth: number;
}

export const DEFAULT_AGENT_KV_WALK_LIMITS: Readonly<AgentKvWalkLimits> =
  Object.freeze({
    maxNodes: 50_000,
    maxBytes: 512 * 1024 * 1024,
    maxDepth: 256,
    maxProtobufDepth: 64,
  });

export interface AgentKvWalkOptions {
  limits?: Partial<AgentKvWalkLimits>;
}

export type AgentKvValueType = "text" | "blob";

export type AgentKvBlobLookupResult =
  | {
      status: "found";
      /** Must be the exact key requested by the walker. */
      key: string;
      /** Lossless bytes: UTF-8 encoded when SQLite stored a TEXT value. */
      bytes: Uint8Array;
      /** Propagated so callers can preserve SQLite's storage class. */
      valueType?: AgentKvValueType;
    }
  | { status: "missing" }
  /** The exact row exists, but materializing it would exceed this walk's remaining byte budget. */
  | { status: "over-budget" }
  | { status: "unreadable"; reason: string };

export type AgentKvBlobLookup = (
  key: string,
  /** Maximum decoded bytes the walker can still retain for this exact row. */
  remainingBytes: number,
) => AgentKvBlobLookupResult | Promise<AgentKvBlobLookupResult>;

export interface AgentKvReachableBlob {
  id: string;
  key: string;
  depth: number;
  /** A stable copy, suitable for conversion to a PortableKvRow. */
  bytes: Buffer;
  valueType?: AgentKvValueType;
}

export interface AgentKvMissingBlob {
  id: string;
  key: string;
  depth: number;
}

export interface AgentKvTamperedBlob {
  id: string;
  key: string;
  depth: number;
  actualHash: string;
}

export interface AgentKvConversationStateIssue {
  source: "conversation-state";
  seedIndex: number;
  reason:
    | "missing-tilde-prefix"
    | "invalid-base64"
    | "invalid-protobuf";
}

export interface AgentKvBlobIssue {
  source: "blob";
  id: string;
  key: string;
  depth: number;
  reason:
    | "lookup-failed"
    | "lookup-unreadable"
    | "invalid-lookup-result"
    | "unexpected-key"
    | "invalid-bytes"
    | "invalid-value-type";
  detail?: string;
}

export type AgentKvUnreadableIssue =
  | AgentKvConversationStateIssue
  | AgentKvBlobIssue;

export type AgentKvLimitReason =
  | "nodes"
  | "bytes"
  | "depth"
  | "protobuf-depth";

export type AgentKvSeedLimitReason = Extract<
  AgentKvLimitReason,
  "nodes" | "bytes" | "protobuf-depth"
>;

export interface AgentKvRootExtractionResult {
  /** Sorted, unique SHA-256 IDs found directly in the supplied states. */
  roots: string[];
  unreadable: AgentKvConversationStateIssue[];
  /** Decoded bytes across unique, canonical seeds accepted by the byte bound. */
  seedBytes: number;
  complete: boolean;
  limitReasons: AgentKvSeedLimitReason[];
}

export interface AgentKvReachabilityResult {
  roots: string[];
  blobs: AgentKvReachableBlob[];
  missing: AgentKvMissingBlob[];
  tampered: AgentKvTamperedBlob[];
  unreadable: AgentKvUnreadableIssue[];
  /** Sorted union of missing, tampered, and blob-unreadable content IDs. */
  unavailableIds: string[];
  seedBytes: number;
  /** Seed bytes plus bytes of hash-valid blobs retained in `blobs`. */
  totalBytes: number;
  /**
   * Seed bytes plus every found row materialized for validation, including a
   * hash-mismatching/tampered row. This is the hard lookup/hash work budget.
   */
  examinedBytes: number;
  /** Number of distinct IDs for which the exact-key lookup was attempted. */
  visitedNodes: number;
  /** False for any unavailable data, bad seed, or traversal limit. */
  complete: boolean;
  limitReasons: AgentKvLimitReason[];
}

interface ParsedProtobuf {
  valid: boolean;
  candidates: Set<string>;
  depthLimited: boolean;
  candidateLimited: boolean;
}

interface VarintRead {
  value: bigint;
  nextOffset: number;
}

interface PendingId {
  id: string;
  depth: number;
}

const MAX_PROTOBUF_FIELD_NUMBER = 0x1fff_ffffn;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const COOPERATIVE_YIELD_EVERY_NODES = 64;

/**
 * Extract the content-addressed roots without consulting SQLite. This is the
 * cheap audit primitive: callers can probe only the returned exact keys before
 * deciding whether a full graph walk is necessary.
 */
export function extractAgentKvRootIds(
  serializedState: string | readonly string[],
  options?: AgentKvWalkOptions,
): AgentKvRootExtractionResult {
  const limits = normalizeLimits(options);
  return extractRootsWithLimits(serializedState, limits);
}

/**
 * Walk Cursor's content-addressed conversation graph.
 *
 * Candidate IDs are protobuf length-delimited fields whose payload is exactly
 * 32 bytes. Nested candidates are discovered only after the containing blob's
 * exact key and SHA-256 have both been verified. Hash-valid values that are not
 * protobuf are deliberately retained as opaque leaves because Cursor stores
 * JSON and text leaves in the same key space.
 */
export async function walkAgentKvReachability(
  serializedState: string | readonly string[],
  lookup: AgentKvBlobLookup,
  options?: AgentKvWalkOptions,
): Promise<AgentKvReachabilityResult> {
  const limits = normalizeLimits(options);
  const extracted = extractRootsWithLimits(serializedState, limits);
  const blobs: AgentKvReachableBlob[] = [];
  const missing: AgentKvMissingBlob[] = [];
  const tampered: AgentKvTamperedBlob[] = [];
  const unreadable: AgentKvUnreadableIssue[] = [...extracted.unreadable];
  const unavailableIds = new Set<string>();
  const limitReasons = new Set<AgentKvLimitReason>(extracted.limitReasons);
  const scheduled = new Set<string>(extracted.roots);
  const pending: PendingId[] = extracted.roots.map((id) => ({ id, depth: 0 }));
  let visitedNodes = 0;
  let totalBytes = extracted.seedBytes;
  let examinedBytes = extracted.seedBytes;

  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    if (visitedNodes >= limits.maxNodes) {
      limitReasons.add("nodes");
      break;
    }

    const current = pending[cursor];
    if (current === undefined) {
      break;
    }
    const key = `${AGENT_KV_BLOB_PREFIX}${current.id}`;
    visitedNodes += 1;
    if (visitedNodes % COOPERATIVE_YIELD_EVERY_NODES === 0) {
      // node:sqlite's exact-key reads are synchronous. `await` on their plain
      // return value only advances the microtask queue, so a bounded 4,096-node
      // graph could still monopolize an extension host. Yield to timers and UI
      // work at a fixed cadence without changing traversal order or bounds.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    let rawResult: unknown;
    try {
      rawResult = await lookup(key, limits.maxBytes - examinedBytes);
    } catch (error) {
      unreadable.push({
        source: "blob",
        id: current.id,
        key,
        depth: current.depth,
        reason: "lookup-failed",
        detail: errorDetail(error),
      });
      unavailableIds.add(current.id);
      continue;
    }

    if (!isLookupResult(rawResult)) {
      unreadable.push({
        source: "blob",
        id: current.id,
        key,
        depth: current.depth,
        reason: "invalid-lookup-result",
      });
      unavailableIds.add(current.id);
      continue;
    }

    if (rawResult.status === "missing") {
      missing.push({ id: current.id, key, depth: current.depth });
      unavailableIds.add(current.id);
      continue;
    }
    if (rawResult.status === "over-budget") {
      limitReasons.add("bytes");
      break;
    }
    if (rawResult.status === "unreadable") {
      unreadable.push({
        source: "blob",
        id: current.id,
        key,
        depth: current.depth,
        reason: "lookup-unreadable",
        detail: rawResult.reason,
      });
      unavailableIds.add(current.id);
      continue;
    }
    if (
      rawResult.bytes instanceof Uint8Array &&
      rawResult.bytes.byteLength > limits.maxBytes - examinedBytes
    ) {
      limitReasons.add("bytes");
      break;
    }
    if (rawResult.bytes instanceof Uint8Array) {
      // Debit bytes before validating their key, storage class, or SHA. A
      // corrupt row is just as expensive to read/copy/hash as a valid one and
      // must not receive a fresh maxBytes allowance for every referenced ID.
      examinedBytes += rawResult.bytes.byteLength;
    }
    if (typeof rawResult.key !== "string" || rawResult.key !== key) {
      unreadable.push({
        source: "blob",
        id: current.id,
        key,
        depth: current.depth,
        reason: "unexpected-key",
      });
      unavailableIds.add(current.id);
      continue;
    }
    if (!(rawResult.bytes instanceof Uint8Array)) {
      unreadable.push({
        source: "blob",
        id: current.id,
        key,
        depth: current.depth,
        reason: "invalid-bytes",
      });
      unavailableIds.add(current.id);
      continue;
    }
    if (
      rawResult.valueType !== undefined &&
      rawResult.valueType !== "text" &&
      rawResult.valueType !== "blob"
    ) {
      unreadable.push({
        source: "blob",
        id: current.id,
        key,
        depth: current.depth,
        reason: "invalid-value-type",
      });
      unavailableIds.add(current.id);
      continue;
    }

    const bytes = Buffer.from(rawResult.bytes);
    const actualHash = sha256(bytes);
    if (actualHash !== current.id) {
      tampered.push({
        id: current.id,
        key,
        depth: current.depth,
        actualHash,
      });
      unavailableIds.add(current.id);
      continue;
    }

    const blob: AgentKvReachableBlob = {
      id: current.id,
      key,
      depth: current.depth,
      bytes,
    };
    if (rawResult.valueType !== undefined) {
      blob.valueType = rawResult.valueType;
    }
    blobs.push(blob);
    totalBytes += bytes.byteLength;

    const parsed = parseProtobuf(
      bytes,
      limits.maxProtobufDepth,
      scheduled,
      limits.maxNodes - scheduled.size,
    );
    if (!parsed.valid) {
      continue;
    }
    if (parsed.depthLimited) {
      limitReasons.add("protobuf-depth");
    }
    if (parsed.candidateLimited) {
      limitReasons.add("nodes");
    }

    const children = [...parsed.candidates].sort(compareCodeUnits);
    if (current.depth >= limits.maxDepth) {
      if (children.length > 0 || parsed.candidateLimited) {
        limitReasons.add("depth");
      }
      continue;
    }
    for (const id of children) {
      scheduled.add(id);
      pending.push({ id, depth: current.depth + 1 });
    }
  }

  blobs.sort(compareById);
  missing.sort(compareById);
  tampered.sort(compareById);
  unreadable.sort(compareUnreadable);
  const sortedLimitReasons = [...limitReasons].sort(compareCodeUnits);

  return {
    roots: [...extracted.roots],
    blobs,
    missing,
    tampered,
    unreadable,
    unavailableIds: [...unavailableIds].sort(compareCodeUnits),
    seedBytes: extracted.seedBytes,
    totalBytes,
    examinedBytes,
    visitedNodes,
    complete:
      missing.length === 0 &&
      tampered.length === 0 &&
      unreadable.length === 0 &&
      sortedLimitReasons.length === 0,
    limitReasons: sortedLimitReasons,
  };
}

function extractRootsWithLimits(
  serializedState: string | readonly string[],
  limits: Readonly<AgentKvWalkLimits>,
): AgentKvRootExtractionResult {
  const states =
    typeof serializedState === "string" ? [serializedState] : serializedState;
  const seenStates = new Set<string>();
  const roots = new Set<string>();
  const unreadable: AgentKvConversationStateIssue[] = [];
  const limitReasons = new Set<AgentKvSeedLimitReason>();
  let seedBytes = 0;

  for (let seedIndex = 0; seedIndex < states.length; seedIndex += 1) {
    const state = states[seedIndex];
    if (state === undefined || seenStates.has(state)) {
      continue;
    }
    seenStates.add(state);

    if (!state.startsWith("~")) {
      unreadable.push({
        source: "conversation-state",
        seedIndex,
        reason: "missing-tilde-prefix",
      });
      continue;
    }

    const encoded = state.slice(1);
    if (!isCanonicalBase64Text(encoded)) {
      unreadable.push({
        source: "conversation-state",
        seedIndex,
        reason: "invalid-base64",
      });
      continue;
    }

    const decodedLength = decodedBase64Length(encoded);
    if (decodedLength > limits.maxBytes - seedBytes) {
      limitReasons.add("bytes");
      break;
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      unreadable.push({
        source: "conversation-state",
        seedIndex,
        reason: "invalid-base64",
      });
      continue;
    }
    seedBytes += bytes.byteLength;

    const parsed = parseProtobuf(
      bytes,
      limits.maxProtobufDepth,
      roots,
      limits.maxNodes - roots.size,
    );
    if (!parsed.valid) {
      unreadable.push({
        source: "conversation-state",
        seedIndex,
        reason: "invalid-protobuf",
      });
      continue;
    }
    for (const candidate of parsed.candidates) {
      roots.add(candidate);
    }
    if (parsed.candidateLimited) {
      limitReasons.add("nodes");
    }
    if (parsed.depthLimited) {
      limitReasons.add("protobuf-depth");
    }
    if (parsed.candidateLimited) {
      break;
    }
  }

  unreadable.sort(compareUnreadable);
  const sortedLimits = [...limitReasons].sort(compareCodeUnits);
  return {
    roots: [...roots].sort(compareCodeUnits),
    unreadable,
    seedBytes,
    complete: unreadable.length === 0 && sortedLimits.length === 0,
    limitReasons: sortedLimits,
  };
}

function parseProtobuf(
  bytes: Uint8Array,
  maxProtobufDepth: number,
  knownCandidates: ReadonlySet<string>,
  maxNewCandidates: number,
): ParsedProtobuf {
  if (!scanProtobufMessage(bytes)) {
    return {
      valid: false,
      candidates: new Set<string>(),
      depthLimited: false,
      candidateLimited: false,
    };
  }
  const candidates = new Set<string>();
  const status = collectMessageCandidates(
    bytes,
    0,
    maxProtobufDepth,
    knownCandidates,
    candidates,
    maxNewCandidates,
  );
  return {
    valid: true,
    candidates,
    depthLimited: status.depthLimited,
    candidateLimited: status.candidateLimited,
  };
}

function collectMessageCandidates(
  bytes: Uint8Array,
  depth: number,
  maxDepth: number,
  knownCandidates: ReadonlySet<string>,
  candidates: Set<string>,
  maxNewCandidates: number,
): { depthLimited: boolean; candidateLimited: boolean } {
  let depthLimited = false;
  let candidateLimited = false;
  scanProtobufMessage(bytes, (payload) => {
    if (payload.byteLength === 32) {
      const candidate = Buffer.from(payload).toString("hex");
      if (knownCandidates.has(candidate) || candidates.has(candidate)) {
        return true;
      }
      if (candidates.size >= maxNewCandidates) {
        candidateLimited = true;
        return false;
      }
      candidates.add(candidate);
      return true;
    }
    if (payload.byteLength === 0) {
      return true;
    }
    if (depth >= maxDepth) {
      // It may be text rather than a message, but not inspecting it is still a
      // conservative completeness boundary.
      depthLimited = true;
      return true;
    }
    if (!scanProtobufMessage(payload)) {
      return true;
    }
    const nested = collectMessageCandidates(
      payload,
      depth + 1,
      maxDepth,
      knownCandidates,
      candidates,
      maxNewCandidates,
    );
    depthLimited ||= nested.depthLimited;
    candidateLimited ||= nested.candidateLimited;
    return !candidateLimited;
  });

  return { depthLimited, candidateLimited };
}

/**
 * Validate one protobuf message and optionally visit its length-delimited
 * fields. Callers that collect nested candidates first validate the nested
 * payload, so an opaque string cannot contribute candidates from a partial
 * parse. Returning false from `visitPayload` stops the already-validated scan
 * without allocating anything else.
 */
function scanProtobufMessage(
  bytes: Uint8Array,
  visitPayload?: (payload: Uint8Array) => boolean,
): boolean {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    if (tag === undefined) {
      return false;
    }
    offset = tag.nextOffset;
    const wireType = Number(tag.value & 0x7n);
    const fieldNumber = tag.value >> 3n;
    if (fieldNumber === 0n || fieldNumber > MAX_PROTOBUF_FIELD_NUMBER) {
      return false;
    }

    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      if (value === undefined) {
        return false;
      }
      offset = value.nextOffset;
      continue;
    }
    if (wireType === 1) {
      if (bytes.byteLength - offset < 8) {
        return false;
      }
      offset += 8;
      continue;
    }
    if (wireType === 5) {
      if (bytes.byteLength - offset < 4) {
        return false;
      }
      offset += 4;
      continue;
    }
    if (wireType !== 2) {
      // Cursor's generated proto3 messages do not use deprecated groups.
      return false;
    }

    const encodedLength = readVarint(bytes, offset);
    if (
      encodedLength === undefined ||
      encodedLength.value > MAX_SAFE_BIGINT
    ) {
      return false;
    }
    offset = encodedLength.nextOffset;
    const length = Number(encodedLength.value);
    if (length > bytes.byteLength - offset) {
      return false;
    }
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    if (visitPayload !== undefined && !visitPayload(payload)) {
      return true;
    }
  }
  return true;
}

function readVarint(bytes: Uint8Array, offset: number): VarintRead | undefined {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) {
      return undefined;
    }
    if (index === 9 && (byte & 0xfe) !== 0) {
      return undefined;
    }
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset + index + 1 };
    }
  }
  return undefined;
}

function decodedBase64Length(encoded: string): number {
  if (encoded.length === 0) {
    return 0;
  }
  let padding = 0;
  if (encoded.endsWith("=")) {
    padding = encoded.endsWith("==") ? 2 : 1;
  }
  return (encoded.length / 4) * 3 - padding;
}

function normalizeLimits(
  options: AgentKvWalkOptions | undefined,
): Readonly<AgentKvWalkLimits> {
  const configured = options?.limits;
  return {
    maxNodes: validLimit(
      "maxNodes",
      configured?.maxNodes ?? DEFAULT_AGENT_KV_WALK_LIMITS.maxNodes,
      1,
    ),
    maxBytes: validLimit(
      "maxBytes",
      configured?.maxBytes ?? DEFAULT_AGENT_KV_WALK_LIMITS.maxBytes,
      1,
    ),
    maxDepth: validLimit(
      "maxDepth",
      configured?.maxDepth ?? DEFAULT_AGENT_KV_WALK_LIMITS.maxDepth,
      0,
    ),
    maxProtobufDepth: validLimit(
      "maxProtobufDepth",
      configured?.maxProtobufDepth ??
        DEFAULT_AGENT_KV_WALK_LIMITS.maxProtobufDepth,
      0,
    ),
  };
}

function validLimit(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function isLookupResult(value: unknown): value is AgentKvBlobLookupResult {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const status = (value as { status?: unknown }).status;
  if (
    status === "missing" ||
    status === "found" ||
    status === "over-budget"
  ) {
    return true;
  }
  return (
    status === "unreadable" &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

function compareById(left: { id: string }, right: { id: string }): number {
  return compareCodeUnits(left.id, right.id);
}

function compareUnreadable(
  left: AgentKvUnreadableIssue,
  right: AgentKvUnreadableIssue,
): number {
  if (left.source !== right.source) {
    return left.source === "conversation-state" ? -1 : 1;
  }
  if (left.source === "conversation-state") {
    return left.seedIndex - (right as AgentKvConversationStateIssue).seedIndex;
  }
  return compareCodeUnits(left.id, (right as AgentKvBlobIssue).id);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
