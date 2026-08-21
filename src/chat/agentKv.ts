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
  | "protobuf-depth"
  /** The bytes use a protobuf route not covered by the pinned Cursor schema. */
  | "schema";

export type AgentKvSeedLimitReason = Extract<
  AgentKvLimitReason,
  "nodes" | "bytes" | "protobuf-depth" | "schema"
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
  candidates: Map<string, Set<AgentKvMessageType>>;
  depthLimited: boolean;
  candidateLimited: boolean;
  schemaUnsupported: boolean;
}

interface VarintRead {
  value: bigint;
  nextOffset: number;
}

type AgentKvMessageType =
  | "conversation-state"
  | "conversation-turn"
  | "user-message"
  | "conversation-step"
  | "subagent-state"
  | "opaque";

interface PendingReference {
  id: string;
  type: AgentKvMessageType;
  depth: number;
}

interface InternalRootExtractionResult extends AgentKvRootExtractionResult {
  rootTypes: Map<string, Set<AgentKvMessageType>>;
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
  const extracted = extractRootsWithLimits(
    serializedState,
    limits,
  );
  return {
    roots: extracted.roots,
    unreadable: extracted.unreadable,
    seedBytes: extracted.seedBytes,
    complete: extracted.complete,
    limitReasons: extracted.limitReasons,
  };
}

/**
 * Walk Cursor's content-addressed conversation graph.
 *
 * References are collected only from blob-bearing fields in Cursor 3.17's
 * conversation schema. A generic "every 32-byte protobuf field" scan is not
 * safe: ordinary strings and complete embedded messages can both happen to be
 * 32 bytes long. Nested references are inspected only after the containing
 * blob's exact key and SHA-256 have both been verified. Known opaque values are
 * retained without parsing because Cursor stores JSON and text leaves in the
 * same key space. Unknown schema routes fail closed.
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
  const scheduledIds = new Set<string>(extracted.roots);
  const scheduledReferences = new Set<string>();
  const pending: PendingReference[] = [];
  const schedule = (
    id: string,
    type: AgentKvMessageType,
    depth: number,
  ): void => {
    const identity = `${id}:${type}`;
    if (scheduledReferences.has(identity)) {
      return;
    }
    scheduledReferences.add(identity);
    pending.push({ id, type, depth });
  };
  for (const id of extracted.roots) {
    const types = extracted.rootTypes.get(id) ?? new Set(["opaque"] as const);
    for (const type of [...types].sort(compareCodeUnits)) {
      schedule(id, type, 0);
    }
  }
  const resolved = new Map<string, AgentKvReachableBlob | null>();
  let visitedNodes = 0;
  let totalBytes = extracted.seedBytes;
  let examinedBytes = extracted.seedBytes;

  walk:
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    if (current === undefined) {
      break;
    }
    let blob = resolved.get(current.id);
    if (!resolved.has(current.id)) {
      if (visitedNodes >= limits.maxNodes) {
        limitReasons.add("nodes");
        break;
      }
      const key = `${AGENT_KV_BLOB_PREFIX}${current.id}`;
      visitedNodes += 1;
      if (visitedNodes % COOPERATIVE_YIELD_EVERY_NODES === 0) {
        // node:sqlite's exact-key reads are synchronous. `await` on their plain
        // return value only advances the microtask queue, so a bounded graph
        // could still monopolize an extension host.
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
        resolved.set(current.id, null);
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
        resolved.set(current.id, null);
        continue;
      }

      if (rawResult.status === "missing") {
        missing.push({ id: current.id, key, depth: current.depth });
        unavailableIds.add(current.id);
        resolved.set(current.id, null);
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
        resolved.set(current.id, null);
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
        // corrupt row is just as expensive to read/copy/hash as a valid one.
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
        resolved.set(current.id, null);
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
        resolved.set(current.id, null);
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
        resolved.set(current.id, null);
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
        resolved.set(current.id, null);
        continue;
      }

      blob = {
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
      resolved.set(current.id, blob);
    }

    if (blob === null || blob === undefined || current.type === "opaque") {
      continue;
    }
    const parsed = parseProtobuf(
      blob.bytes,
      current.type,
      limits.maxProtobufDepth,
      scheduledIds,
      limits.maxNodes - scheduledIds.size,
      limits.maxNodes,
    );
    if (!parsed.valid) {
      limitReasons.add("schema");
      continue;
    }
    if (parsed.schemaUnsupported) {
      limitReasons.add("schema");
    }
    if (parsed.depthLimited) {
      limitReasons.add("protobuf-depth");
    }
    if (parsed.candidateLimited) {
      limitReasons.add("nodes");
    }

    const children = [...parsed.candidates.entries()].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    );
    if (current.depth >= limits.maxDepth) {
      if (children.length > 0 || parsed.candidateLimited) {
        limitReasons.add("depth");
      }
      continue;
    }
    for (const [id, types] of children) {
      if (!scheduledIds.has(id)) {
        if (scheduledIds.size >= limits.maxNodes) {
          limitReasons.add("nodes");
          break walk;
        }
        scheduledIds.add(id);
      }
      for (const type of [...types].sort(compareCodeUnits)) {
        schedule(id, type, current.depth + 1);
      }
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
): InternalRootExtractionResult {
  const states =
    typeof serializedState === "string" ? [serializedState] : serializedState;
  const seenStates = new Set<string>();
  const roots = new Set<string>();
  const rootTypes = new Map<string, Set<AgentKvMessageType>>();
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
      "conversation-state",
      limits.maxProtobufDepth,
      roots,
      limits.maxNodes - roots.size,
      limits.maxNodes,
    );
    if (!parsed.valid) {
      unreadable.push({
        source: "conversation-state",
        seedIndex,
        reason: "invalid-protobuf",
      });
      continue;
    }
    for (const [candidate, types] of parsed.candidates) {
      roots.add(candidate);
      const retained = rootTypes.get(candidate);
      if (retained === undefined) {
        rootTypes.set(candidate, new Set(types));
      } else {
        for (const type of types) {
          retained.add(type);
        }
      }
    }
    if (parsed.candidateLimited) {
      limitReasons.add("nodes");
    }
    if (parsed.depthLimited) {
      limitReasons.add("protobuf-depth");
    }
    if (parsed.schemaUnsupported) {
      limitReasons.add("schema");
    }
    if (parsed.candidateLimited) {
      break;
    }
  }

  unreadable.sort(compareUnreadable);
  const sortedLimits = [...limitReasons].sort(compareCodeUnits);
  return {
    roots: [...roots].sort(compareCodeUnits),
    rootTypes,
    unreadable,
    seedBytes,
    complete: unreadable.length === 0 && sortedLimits.length === 0,
    limitReasons: sortedLimits,
  };
}

function parseProtobuf(
  bytes: Uint8Array,
  type: AgentKvMessageType,
  maxProtobufDepth: number,
  knownCandidates: ReadonlySet<string>,
  maxNewCandidates: number,
  maxMapEntries: number,
): ParsedProtobuf {
  if (type === "opaque") {
    return {
      valid: true,
      candidates: new Map<string, Set<AgentKvMessageType>>(),
      depthLimited: false,
      candidateLimited: false,
      schemaUnsupported: false,
    };
  }
  const context: SemanticParseContext = {
    candidates: new Map<string, Set<AgentKvMessageType>>(),
    newCandidateIds: new Set<string>(),
    knownCandidates,
    maxNewCandidates,
    maxMapEntries,
    mapEntries: 0,
    maxProtobufDepth,
    valid: true,
    depthLimited: false,
    candidateLimited: false,
    schemaUnsupported: false,
  };
  walkSchemaMessage(bytes, 0, type, context);
  return {
    valid: context.valid,
    candidates: context.candidates,
    depthLimited: context.depthLimited,
    candidateLimited: context.candidateLimited,
    schemaUnsupported: context.schemaUnsupported,
  };
}

type AgentKvSchemaName =
  | Exclude<AgentKvMessageType, "opaque">
  | "file-state"
  | "agent-turn"
  | "shell-turn"
  | "selected-context"
  | "selected-image"
  | "extra-context-entry"
  | "invocation-context"
  | "selected-pull-request"
  | "selected-git-pr-diff"
  | "tool-call"
  | "read-tool-call"
  | "read-tool-result"
  | "read-tool-success"
  | "task-tool-call"
  | "task-result"
  | "task-success"
  | "truncated-tool-call";

type SchemaFieldAction =
  | { kind: "reference"; target: AgentKvMessageType }
  | { kind: "message"; schema: AgentKvSchemaName }
  | { kind: "map-reference"; target: AgentKvMessageType }
  | { kind: "map-message"; schema: AgentKvSchemaName }
  | { kind: "selected-image-with-data" };

interface SchemaFieldRule {
  wire: number | readonly number[];
  action?: SchemaFieldAction;
  oneof?: string;
  repeated?: boolean;
}

interface AgentKvSchema {
  fields: Readonly<{ [fieldNumber: number]: SchemaFieldRule }>;
}

interface DeferredSchemaField {
  rule: SchemaFieldRule;
  payload: Uint8Array;
}

interface SemanticParseContext {
  candidates: Map<string, Set<AgentKvMessageType>>;
  newCandidateIds: Set<string>;
  knownCandidates: ReadonlySet<string>;
  maxNewCandidates: number;
  maxMapEntries: number;
  mapEntries: number;
  maxProtobufDepth: number;
  valid: boolean;
  depthLimited: boolean;
  candidateLimited: boolean;
  schemaUnsupported: boolean;
}

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

const lengthField = (
  action?: SchemaFieldAction,
  options?: Pick<SchemaFieldRule, "oneof" | "repeated">,
): SchemaFieldRule => ({
  wire: WIRE_LENGTH_DELIMITED,
  ...(action === undefined ? {} : { action }),
  ...(options?.oneof === undefined ? {} : { oneof: options.oneof }),
  ...(options?.repeated === undefined ? {} : { repeated: options.repeated }),
});

const varintField = (repeated = false): SchemaFieldRule => ({
  wire: repeated ? [WIRE_VARINT, WIRE_LENGTH_DELIMITED] : WIRE_VARINT,
  ...(repeated ? { repeated: true } : {}),
});

const reference = (target: AgentKvMessageType): SchemaFieldAction => ({
  kind: "reference",
  target,
});

const message = (schema: AgentKvSchemaName): SchemaFieldAction => ({
  kind: "message",
  schema,
});

const conversationStateFields: { [fieldNumber: number]: SchemaFieldRule } = {
  1: lengthField(reference("opaque"), { repeated: true }),
  3: lengthField(reference("opaque"), { repeated: true }),
  4: lengthField(),
  5: lengthField(),
  6: lengthField(reference("opaque")),
  7: lengthField(reference("opaque")),
  8: lengthField(reference("conversation-turn"), { repeated: true }),
  9: lengthField(),
  10: varintField(),
  11: lengthField(reference("opaque")),
  12: lengthField({ kind: "map-reference", target: "opaque" }, {
    repeated: true,
  }),
  13: lengthField(reference("opaque"), { repeated: true }),
  14: lengthField(),
  15: lengthField({ kind: "map-message", schema: "file-state" }, {
    repeated: true,
  }),
  16: lengthField({ kind: "map-message", schema: "subagent-state" }, {
    repeated: true,
  }),
  17: varintField(),
  18: lengthField(),
  19: lengthField(),
  20: lengthField(),
  21: lengthField(),
  22: lengthField(),
  23: lengthField(),
  24: lengthField(),
  25: lengthField(),
  26: varintField(),
  27: lengthField(),
  28: lengthField(),
  29: lengthField(),
  30: lengthField(),
  31: lengthField({ kind: "map-reference", target: "subagent-state" }, {
    repeated: true,
  }),
  32: lengthField(),
  33: varintField(),
  34: lengthField(),
  35: lengthField(),
  36: lengthField(),
};

const selectedContextFields = opaqueLengthFields([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 24, 25, 26, 27, 34,
]);
selectedContextFields[1] = lengthField(message("selected-image"), {
  repeated: true,
});
selectedContextFields[2] = lengthField(message("invocation-context"));
selectedContextFields[16] = lengthField(message("extra-context-entry"), {
  repeated: true,
});
selectedContextFields[20] = lengthField(message("selected-git-pr-diff"), {
  repeated: true,
});
selectedContextFields[21] = lengthField(message("selected-pull-request"), {
  repeated: true,
});

const toolCallFields = opaqueOneofLengthFields(
  [
    1, 3, 4, 5, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    23, 24, 25, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41,
    42, 43, 44, 45, 46, 48, 49, 50, 51, 52, 53, 55, 56, 58, 61, 62, 63,
    64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78,
  ],
  "tool",
);
toolCallFields[8] = lengthField(message("read-tool-call"), { oneof: "tool" });
toolCallFields[19] = lengthField(message("task-tool-call"), {
  oneof: "tool",
});
toolCallFields[34] = lengthField(message("truncated-tool-call"), {
  oneof: "tool",
});
toolCallFields[54] = lengthField(undefined, { repeated: true });
toolCallFields[57] = lengthField();
toolCallFields[59] = varintField();
toolCallFields[60] = varintField();

const AGENT_KV_SCHEMAS: Readonly<Record<AgentKvSchemaName, AgentKvSchema>> = {
  "conversation-state": { fields: conversationStateFields },
  "file-state": {
    fields: {
      1: lengthField(reference("opaque")),
      2: lengthField(reference("opaque")),
    },
  },
  "subagent-state": {
    fields: {
      1: lengthField(message("conversation-state")),
      2: varintField(),
      3: varintField(),
      4: lengthField(),
      5: lengthField(),
      6: varintField(),
      7: lengthField(),
      8: lengthField(),
      9: lengthField(),
      10: lengthField(),
    },
  },
  "conversation-turn": {
    fields: {
      1: lengthField(message("agent-turn"), { oneof: "turn" }),
      2: lengthField(message("shell-turn"), { oneof: "turn" }),
    },
  },
  "agent-turn": {
    fields: {
      1: lengthField(reference("user-message")),
      2: lengthField(reference("conversation-step"), { repeated: true }),
      3: lengthField(),
      4: lengthField(),
      5: varintField(),
      6: varintField(true),
    },
  },
  "shell-turn": {
    fields: {
      1: lengthField(reference("opaque")),
      2: lengthField(reference("opaque")),
    },
  },
  "user-message": {
    fields: {
      1: lengthField(),
      2: lengthField(),
      3: lengthField(message("selected-context")),
      4: varintField(),
      5: varintField(),
      6: lengthField(),
      7: varintField(),
      8: lengthField(),
      9: varintField(),
      10: lengthField(reference("conversation-state")),
      11: lengthField(),
      13: lengthField(),
      14: lengthField(),
      15: lengthField(),
      16: lengthField(),
      17: lengthField(),
      // Cursor 3.17's own continuation walker does not retain text/rich-text
      // fallback IDs. They are known fields, not graph edges for this walk.
      18: lengthField(),
      19: lengthField(),
      21: lengthField(undefined, { repeated: true }),
      22: lengthField(),
      23: lengthField(),
      24: varintField(),
    },
  },
  "selected-context": { fields: selectedContextFields },
  "selected-image": {
    fields: {
      1: lengthField(reference("opaque"), { oneof: "data" }),
      2: lengthField(),
      3: lengthField(),
      4: lengthField(),
      7: lengthField(),
      8: lengthField(undefined, { oneof: "data" }),
      9: lengthField({ kind: "selected-image-with-data" }, { oneof: "data" }),
      10: lengthField(undefined, { oneof: "data" }),
    },
  },
  "extra-context-entry": {
    fields: {
      1: lengthField(undefined, { oneof: "data" }),
      2: lengthField(reference("opaque"), { oneof: "data" }),
    },
  },
  "invocation-context": {
    fields: {
      1: lengthField(undefined, { oneof: "data" }),
      2: lengthField(undefined, { oneof: "data" }),
      3: lengthField(undefined, { oneof: "data" }),
      4: lengthField(undefined, { oneof: "data" }),
      10: lengthField(reference("opaque"), { oneof: "data" }),
    },
  },
  "selected-pull-request": {
    fields: {
      1: varintField(),
      2: lengthField(),
      3: lengthField(),
      4: lengthField(),
      5: lengthField(),
      6: lengthField(),
      7: lengthField(reference("opaque")),
    },
  },
  "selected-git-pr-diff": {
    fields: {
      1: lengthField(),
      2: lengthField(),
      3: varintField(),
      4: varintField(),
      5: lengthField(),
      6: lengthField(reference("opaque")),
    },
  },
  "conversation-step": {
    fields: {
      1: lengthField(undefined, { oneof: "message" }),
      2: lengthField(message("tool-call"), { oneof: "message" }),
      3: lengthField(undefined, { oneof: "message" }),
    },
  },
  "tool-call": { fields: toolCallFields },
  "read-tool-call": {
    fields: {
      1: lengthField(),
      2: lengthField(message("read-tool-result")),
    },
  },
  "read-tool-result": {
    fields: {
      1: lengthField(message("read-tool-success"), { oneof: "result" }),
      2: lengthField(undefined, { oneof: "result" }),
    },
  },
  "read-tool-success": {
    fields: {
      1: lengthField(undefined, { oneof: "output" }),
      2: varintField(),
      3: varintField(),
      4: varintField(),
      5: varintField(),
      6: lengthField(undefined, { oneof: "output" }),
      7: lengthField(),
      8: lengthField(),
      9: lengthField(reference("opaque"), { oneof: "output" }),
      10: lengthField(reference("opaque"), { oneof: "output" }),
      11: varintField(),
      12: lengthField(undefined, { repeated: true }),
      13: lengthField(undefined, { repeated: true }),
    },
  },
  "task-tool-call": {
    fields: {
      1: lengthField(),
      2: lengthField(message("task-result")),
      3: lengthField(),
    },
  },
  "task-result": {
    fields: {
      1: lengthField(message("task-success"), { oneof: "result" }),
      2: lengthField(undefined, { oneof: "result" }),
    },
  },
  "task-success": {
    fields: {
      1: lengthField(message("conversation-step"), { repeated: true }),
      2: lengthField(),
      3: varintField(),
      4: varintField(),
      5: lengthField(),
      6: varintField(),
      7: lengthField(),
    },
  },
  "truncated-tool-call": {
    fields: {
      1: lengthField(reference("conversation-step")),
      2: lengthField(),
      3: lengthField(),
    },
  },
};

function opaqueLengthFields(
  fieldNumbers: readonly number[],
): { [fieldNumber: number]: SchemaFieldRule } {
  const fields: { [fieldNumber: number]: SchemaFieldRule } = {};
  for (const fieldNumber of fieldNumbers) {
    fields[fieldNumber] = lengthField();
  }
  return fields;
}

function opaqueOneofLengthFields(
  fieldNumbers: readonly number[],
  oneof: string,
): { [fieldNumber: number]: SchemaFieldRule } {
  const fields: { [fieldNumber: number]: SchemaFieldRule } = {};
  for (const fieldNumber of fieldNumbers) {
    fields[fieldNumber] = lengthField(undefined, { oneof });
  }
  return fields;
}

function walkSchemaMessage(
  bytes: Uint8Array,
  depth: number,
  schemaName: AgentKvSchemaName,
  context: SemanticParseContext,
): void {
  if (context.candidateLimited || !context.valid) {
    return;
  }
  if (!scanProtobufMessage(bytes)) {
    context.valid = false;
    return;
  }
  const schema = AGENT_KV_SCHEMAS[schemaName];
  const singular = new Map<number, DeferredSchemaField>();
  const oneofs = new Map<string, DeferredSchemaField>();
  const maps = new Map<
    number,
    { action: SchemaFieldAction; values: Map<string, Uint8Array> }
  >();

  scanProtobufMessage(bytes, (fieldNumber, wireType, payload) => {
    const rule = schema.fields[fieldNumber];
    if (rule === undefined) {
      context.schemaUnsupported = true;
      return true;
    }
    if (!acceptsWire(rule, wireType)) {
      context.schemaUnsupported = true;
      return true;
    }
    if (payload === undefined || rule.action === undefined) {
      if (rule.oneof !== undefined && payload !== undefined) {
        oneofs.set(rule.oneof, { rule, payload });
      }
      return true;
    }
    const deferred = { rule, payload };
    if (rule.oneof !== undefined) {
      oneofs.set(rule.oneof, deferred);
      return true;
    }
    if (
      rule.action.kind === "map-reference" ||
      rule.action.kind === "map-message"
    ) {
      let retained = maps.get(fieldNumber);
      if (retained === undefined) {
        retained = { action: rule.action, values: new Map() };
        maps.set(fieldNumber, retained);
      }
      const entry = parseMapEntry(payload, depth, context);
      if (entry !== undefined) {
        if (!retained.values.has(entry.key)) {
          if (context.mapEntries >= context.maxMapEntries) {
            context.candidateLimited = true;
            return false;
          }
          context.mapEntries += 1;
        }
        retained.values.set(entry.key, entry.value);
      }
      return !context.candidateLimited && context.valid;
    }
    if (rule.repeated === true) {
      processSchemaAction(rule.action, payload, depth, context);
      return !context.candidateLimited && context.valid;
    }
    singular.set(fieldNumber, deferred);
    return true;
  });

  for (const { rule, payload } of singular.values()) {
    if (rule.action !== undefined) {
      processSchemaAction(rule.action, payload, depth, context);
    }
  }
  for (const { rule, payload } of oneofs.values()) {
    if (rule.action !== undefined) {
      processSchemaAction(rule.action, payload, depth, context);
    }
  }
  for (const { action, values } of maps.values()) {
    for (const payload of values.values()) {
      if (action.kind === "map-reference") {
        addCandidate(payload, action.target, context);
      } else if (action.kind === "map-message") {
        descendSchemaMessage(payload, action.schema, depth + 1, context);
      }
    }
  }
}

function processSchemaAction(
  action: SchemaFieldAction,
  payload: Uint8Array,
  depth: number,
  context: SemanticParseContext,
): void {
  if (action.kind === "reference") {
    addCandidate(payload, action.target, context);
    return;
  }
  if (action.kind === "message") {
    descendSchemaMessage(payload, action.schema, depth, context);
    return;
  }
  if (action.kind === "selected-image-with-data") {
    parseSelectedImageWithData(payload, depth, context);
  }
}

function descendSchemaMessage(
  payload: Uint8Array,
  schema: AgentKvSchemaName,
  depth: number,
  context: SemanticParseContext,
): void {
  if (depth >= context.maxProtobufDepth) {
    context.depthLimited = true;
    return;
  }
  walkSchemaMessage(payload, depth + 1, schema, context);
}

function parseMapEntry(
  payload: Uint8Array,
  depth: number,
  context: SemanticParseContext,
): { key: string; value: Uint8Array } | undefined {
  if (depth >= context.maxProtobufDepth) {
    context.depthLimited = true;
    return undefined;
  }
  if (!scanProtobufMessage(payload)) {
    context.valid = false;
    return undefined;
  }
  let key: Uint8Array | undefined;
  let value: Uint8Array | undefined;
  scanProtobufMessage(payload, (fieldNumber, wireType, fieldPayload) => {
    if (
      (fieldNumber !== 1 && fieldNumber !== 2) ||
      wireType !== WIRE_LENGTH_DELIMITED ||
      fieldPayload === undefined
    ) {
      context.schemaUnsupported = true;
      return true;
    }
    if (fieldNumber === 1) {
      key = fieldPayload;
    } else {
      value = fieldPayload;
    }
    return true;
  });
  return {
    key: Buffer.from(key ?? []).toString("utf8"),
    value: value ?? new Uint8Array(0),
  };
}

function parseSelectedImageWithData(
  payload: Uint8Array,
  depth: number,
  context: SemanticParseContext,
): void {
  if (depth >= context.maxProtobufDepth) {
    context.depthLimited = true;
    return;
  }
  if (!scanProtobufMessage(payload)) {
    context.valid = false;
    return;
  }
  let blobId: Uint8Array | undefined;
  let data: Uint8Array | undefined;
  scanProtobufMessage(payload, (fieldNumber, wireType, fieldPayload) => {
    if (
      (fieldNumber !== 1 && fieldNumber !== 2) ||
      wireType !== WIRE_LENGTH_DELIMITED ||
      fieldPayload === undefined
    ) {
      context.schemaUnsupported = true;
      return true;
    }
    if (fieldNumber === 1) {
      blobId = fieldPayload;
    } else {
      data = fieldPayload;
    }
    return true;
  });
  if (blobId !== undefined && (data === undefined || data.byteLength === 0)) {
    addCandidate(blobId, "opaque", context);
  }
}

function addCandidate(
  payload: Uint8Array,
  type: AgentKvMessageType,
  context: SemanticParseContext,
): void {
  if (payload.byteLength === 0) {
    return;
  }
  if (payload.byteLength !== 32) {
    context.schemaUnsupported = true;
    return;
  }
  const id = Buffer.from(payload).toString("hex");
  let types = context.candidates.get(id);
  if (types === undefined) {
    if (
      !context.knownCandidates.has(id) &&
      context.newCandidateIds.size >= context.maxNewCandidates
    ) {
      context.candidateLimited = true;
      return;
    }
    types = new Set<AgentKvMessageType>();
    context.candidates.set(id, types);
    if (!context.knownCandidates.has(id)) {
      context.newCandidateIds.add(id);
    }
  }
  types.add(type);
}

function acceptsWire(rule: SchemaFieldRule, wireType: number): boolean {
  return typeof rule.wire === "number"
    ? rule.wire === wireType
    : rule.wire.includes(wireType);
}

/**
 * Validate one protobuf message and optionally visit its fields. Semantic
 * callers perform a validation pass first, so returning false from the visitor
 * can stop the second pass without accepting a partially parsed message.
 */
function scanProtobufMessage(
  bytes: Uint8Array,
  visitField?: (
    fieldNumber: number,
    wireType: number,
    payload: Uint8Array | undefined,
  ) => boolean,
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
      if (
        visitField !== undefined &&
        !visitField(Number(fieldNumber), wireType, undefined)
      ) {
        return true;
      }
      continue;
    }
    if (wireType === 1) {
      if (bytes.byteLength - offset < 8) {
        return false;
      }
      offset += 8;
      if (
        visitField !== undefined &&
        !visitField(Number(fieldNumber), wireType, undefined)
      ) {
        return true;
      }
      continue;
    }
    if (wireType === 5) {
      if (bytes.byteLength - offset < 4) {
        return false;
      }
      offset += 4;
      if (
        visitField !== undefined &&
        !visitField(Number(fieldNumber), wireType, undefined)
      ) {
        return true;
      }
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
    if (
      visitField !== undefined &&
      !visitField(Number(fieldNumber), wireType, payload)
    ) {
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
