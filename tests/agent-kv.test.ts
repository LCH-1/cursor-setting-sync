import { describe, expect, it, vi } from "vitest";
import {
  AGENT_KV_BLOB_PREFIX,
  extractAgentKvRootIds,
  walkAgentKvReachability,
  type AgentKvBlobLookup,
  type AgentKvBlobLookupResult,
} from "../src/chat/agentKv";
import { sha256 } from "../src/protocol/canonical";

describe("agentKv conversation graph", () => {
  it("walks nested protobuf references and retains opaque leaves", async () => {
    const leaf = Buffer.from("opaque JSON or text leaf", "utf8");
    const leafId = sha256(leaf);
    const child = bytesField(2, Buffer.from(leafId, "hex"));
    const childId = sha256(child);
    const serializedState = state(bytesField(9, bytesField(4, Buffer.from(childId, "hex"))));
    const rows = new Map<string, AgentKvBlobLookupResult>([
      [
        key(childId),
        { status: "found", key: key(childId), bytes: child, valueType: "blob" },
      ],
      [
        key(leafId),
        { status: "found", key: key(leafId), bytes: leaf, valueType: "text" },
      ],
    ]);

    const result = await walkAgentKvReachability(
      serializedState,
      lookupFrom(rows),
    );

    expect(result.roots).toEqual([childId]);
    expect(result.blobs.map(({ id, depth, valueType }) => ({ id, depth, valueType }))).toEqual(
      [
        { id: childId, depth: 0, valueType: "blob" },
        { id: leafId, depth: 1, valueType: "text" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(result.blobs.find((blob) => blob.id === leafId)?.bytes).toEqual(leaf);
    expect(result.complete).toBe(true);
    expect(result.unavailableIds).toEqual([]);
  });

  it("deduplicates repeated roots, edges, and fan-in before exact lookup", async () => {
    // A true hash-valid cycle would require a SHA-256 fixed point/collision.
    // Repeated roots and diamond fan-in exercise the same visited-set guard.
    const shared = Buffer.from([0xff]);
    const sharedId = sha256(shared);
    const first = Buffer.concat([
      bytesField(1, Buffer.from(sharedId, "hex")),
      bytesField(2, Buffer.from(sharedId, "hex")),
    ]);
    const second = bytesField(3, Buffer.from(sharedId, "hex"));
    const firstId = sha256(first);
    const secondId = sha256(second);
    const firstState = state(bytesField(1, Buffer.from(firstId, "hex")));
    const combinedState = state(
      Buffer.concat([
        bytesField(2, Buffer.from(secondId, "hex")),
        bytesField(3, Buffer.from(firstId, "hex")),
      ]),
    );
    const rows = new Map<string, AgentKvBlobLookupResult>([
      [key(firstId), { status: "found", key: key(firstId), bytes: first }],
      [key(secondId), { status: "found", key: key(secondId), bytes: second }],
      [key(sharedId), { status: "found", key: key(sharedId), bytes: shared }],
    ]);
    const lookup = vi.fn(lookupFrom(rows));

    const result = await walkAgentKvReachability(
      [firstState, firstState, combinedState],
      lookup,
    );

    expect(result.roots).toEqual([firstId, secondId].sort());
    expect(result.visitedNodes).toBe(3);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(new Set(lookup.mock.calls.map(([requested]) => requested)).size).toBe(3);
    expect(result.blobs.find((blob) => blob.id === sharedId)?.depth).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("reports missing and tampered rows as distinct unavailable IDs", async () => {
    const missingId = "11".repeat(32);
    const tamperedId = "22".repeat(32);
    const tamperedBytes = Buffer.from("not the addressed value", "utf8");
    const serializedState = state(
      Buffer.concat([
        bytesField(1, Buffer.from(missingId, "hex")),
        bytesField(2, Buffer.from(tamperedId, "hex")),
      ]),
    );

    const result = await walkAgentKvReachability(serializedState, (requested) => {
      if (requested === key(missingId)) {
        return { status: "missing" };
      }
      return {
        status: "found",
        key: key(tamperedId),
        bytes: tamperedBytes,
      };
    });

    expect(result.missing).toEqual([
      { id: missingId, key: key(missingId), depth: 0 },
    ]);
    expect(result.tampered).toEqual([
      {
        id: tamperedId,
        key: key(tamperedId),
        depth: 0,
        actualHash: sha256(tamperedBytes),
      },
    ]);
    expect(result.unavailableIds).toEqual([missingId, tamperedId]);
    expect(result.complete).toBe(false);
  });

  it("charges tampered rows against the cumulative materialization budget", async () => {
    const firstId = "10".repeat(32);
    const secondId = "20".repeat(32);
    const serializedState = state(
      Buffer.concat([
        bytesField(1, Buffer.from(firstId, "hex")),
        bytesField(2, Buffer.from(secondId, "hex")),
      ]),
    );
    const seedBytes = Buffer.from(serializedState.slice(1), "base64").byteLength;
    const wrong = Buffer.alloc(60, 0x7f);
    const remaining: number[] = [];
    const lookup = vi.fn<AgentKvBlobLookup>((requested, allowed) => {
      remaining.push(allowed);
      if (allowed < wrong.byteLength) {
        return { status: "over-budget" };
      }
      return { status: "found", key: requested, bytes: wrong };
    });

    const result = await walkAgentKvReachability(serializedState, lookup, {
      limits: { maxBytes: seedBytes + 100 },
    });

    expect(remaining).toEqual([100, 40]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.tampered).toHaveLength(1);
    expect(result.blobs).toEqual([]);
    expect(result.totalBytes).toBe(seedBytes);
    expect(result.examinedBytes).toBe(seedBytes + wrong.byteLength);
    expect(result.limitReasons).toContain("bytes");
    expect(result.complete).toBe(false);
  });

  it("distinguishes malformed seeds and lookup failures", async () => {
    const unreadableId = "33".repeat(32);
    const throwingId = "44".repeat(32);
    const serializedState = state(
      Buffer.concat([
        bytesField(1, Buffer.from(unreadableId, "hex")),
        bytesField(2, Buffer.from(throwingId, "hex")),
      ]),
    );

    const result = await walkAgentKvReachability(
      [
        "not-prefixed",
        "~Q===",
        state(Buffer.from([0x0a, 0x02, 0x01])),
        serializedState,
      ],
      (requested) => {
        if (requested === key(unreadableId)) {
          return { status: "unreadable", reason: "sqlite read failed" };
        }
        throw new Error("database unavailable");
      },
    );

    expect(result.unreadable.map((issue) => issue.reason)).toEqual([
      "missing-tilde-prefix",
      "invalid-base64",
      "invalid-protobuf",
      "lookup-unreadable",
      "lookup-failed",
    ]);
    expect(result.unavailableIds).toEqual([unreadableId, throwingId]);
    expect(result.complete).toBe(false);
  });

  it("keeps a hash-valid malformed protobuf blob as an opaque leaf", async () => {
    const malformedLeaf = Buffer.from([0x0a, 0x80]);
    const leafId = sha256(malformedLeaf);

    const result = await walkAgentKvReachability(
      state(bytesField(1, Buffer.from(leafId, "hex"))),
      () => ({ status: "found", key: key(leafId), bytes: malformedLeaf }),
    );

    expect(result.blobs).toHaveLength(1);
    expect(result.blobs[0]?.bytes).toEqual(malformedLeaf);
    expect(result.unreadable).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("extracts roots synchronously with strict tilde/base64 validation", () => {
    const firstId = "aa".repeat(32);
    const secondId = "bb".repeat(32);
    const valid = state(
      Buffer.concat([
        bytesField(2, Buffer.from(secondId, "hex")),
        bytesField(1, Buffer.from(firstId, "hex")),
        bytesField(3, Buffer.from(firstId, "hex")),
      ]),
    );

    const extracted = extractAgentKvRootIds([valid, valid]);

    expect(extracted.roots).toEqual([firstId, secondId]);
    expect(extracted.seedBytes).toBe(Buffer.from(valid.slice(1), "base64").length);
    expect(extracted.complete).toBe(true);
  });

  it("recognizes Cursor's direct and fileStatesV2 map-shaped blob routes", () => {
    const promptId = "01".repeat(32);
    const todoId = "02".repeat(32);
    const turnId = "03".repeat(32);
    const contentId = "04".repeat(32);
    const initialContentId = "05".repeat(32);
    const fileStateV2 = Buffer.concat([
      bytesField(1, Buffer.from(contentId, "hex")),
      bytesField(2, Buffer.from(initialContentId, "hex")),
    ]);
    const mapEntry = Buffer.concat([
      bytesField(1, Buffer.from("src/example.ts", "utf8")),
      bytesField(2, fileStateV2),
    ]);
    const serializedState = state(
      Buffer.concat([
        bytesField(1, Buffer.from(promptId, "hex")),
        bytesField(3, Buffer.from(todoId, "hex")),
        bytesField(8, Buffer.from(turnId, "hex")),
        bytesField(15, mapEntry),
        // A syntactically valid opaque scalar payload is not a candidate.
        bytesField(20, Buffer.alloc(31, 0x7f)),
      ]),
    );

    expect(extractAgentKvRootIds(serializedState).roots).toEqual(
      [promptId, todoId, turnId, contentId, initialContentId].sort(),
    );
  });

  it("reports node, byte, graph-depth, and protobuf-depth bounds", async () => {
    const leaf = Buffer.from([0xff]);
    const leafId = sha256(leaf);
    const root = bytesField(1, Buffer.from(leafId, "hex"));
    const rootId = sha256(root);
    const serializedState = state(bytesField(1, Buffer.from(rootId, "hex")));
    const rows = new Map<string, AgentKvBlobLookupResult>([
      [key(rootId), { status: "found", key: key(rootId), bytes: root }],
      [key(leafId), { status: "found", key: key(leafId), bytes: leaf }],
    ]);

    const depthLimited = await walkAgentKvReachability(
      serializedState,
      lookupFrom(rows),
      { limits: { maxDepth: 0 } },
    );
    expect(depthLimited.limitReasons).toEqual(["depth"]);
    expect(depthLimited.visitedNodes).toBe(1);
    expect(depthLimited.complete).toBe(false);

    const twoRoots = state(
      Buffer.concat([
        bytesField(1, Buffer.from(rootId, "hex")),
        bytesField(2, Buffer.from(leafId, "hex")),
      ]),
    );
    const nodeLimited = await walkAgentKvReachability(
      twoRoots,
      lookupFrom(rows),
      { limits: { maxNodes: 1 } },
    );
    expect(nodeLimited.limitReasons).toEqual(["nodes"]);
    expect(nodeLimited.visitedNodes).toBe(1);
    expect(nodeLimited.complete).toBe(false);

    const seedBytes = Buffer.from(serializedState.slice(1), "base64").length;
    const byteLimited = await walkAgentKvReachability(
      serializedState,
      lookupFrom(rows),
      { limits: { maxBytes: seedBytes + root.byteLength - 1 } },
    );
    expect(byteLimited.limitReasons).toEqual(["bytes"]);
    expect(byteLimited.blobs).toEqual([]);
    expect(byteLimited.complete).toBe(false);

    const preflight = vi.fn<AgentKvBlobLookup>((requested, remainingBytes) => {
      expect(requested).toBe(key(rootId));
      expect(remainingBytes).toBe(root.byteLength - 1);
      return { status: "over-budget" };
    });
    const preflightLimited = await walkAgentKvReachability(
      serializedState,
      preflight,
      { limits: { maxBytes: seedBytes + root.byteLength - 1 } },
    );
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(preflightLimited.limitReasons).toEqual(["bytes"]);
    expect(preflightLimited.blobs).toEqual([]);
    expect(preflightLimited.unavailableIds).toEqual([]);

    const nestedSeed = state(
      bytesField(1, bytesField(2, Buffer.from(rootId, "hex"))),
    );
    const protobufLimited = extractAgentKvRootIds(nestedSeed, {
      limits: { maxProtobufDepth: 0 },
    });
    expect(protobufLimited.roots).toEqual([]);
    expect(protobufLimited.limitReasons).toEqual(["protobuf-depth"]);
    expect(protobufLimited.complete).toBe(false);
  });

  it("bounds root candidate discovery inside one adversarial protobuf seed", () => {
    const ids = Array.from({ length: 4_096 }, (_, index) =>
      distinctId(index + 1),
    );
    const serializedState = state(
      Buffer.concat(
        ids.map((id) => bytesField(1, Buffer.from(id, "hex"))),
      ),
    );

    const first = extractAgentKvRootIds(serializedState, {
      limits: { maxNodes: 7 },
    });
    const second = extractAgentKvRootIds(serializedState, {
      limits: { maxNodes: 7 },
    });

    expect(first.roots).toEqual(ids.slice(0, 7));
    expect(first.roots).toHaveLength(7);
    expect(first.limitReasons).toEqual(["nodes"]);
    expect(first.complete).toBe(false);
    expect(second).toEqual(first);
  });

  it("bounds child discovery and scheduling inside one adversarial blob", async () => {
    const childIds = Array.from({ length: 4_096 }, (_, index) =>
      distinctId(index + 10_000),
    );
    const root = Buffer.concat(
      childIds.map((id) => bytesField(1, Buffer.from(id, "hex"))),
    );
    const rootId = sha256(root);
    const lookup = vi.fn<AgentKvBlobLookup>((requested) =>
      requested === key(rootId)
        ? { status: "found", key: key(rootId), bytes: root }
        : { status: "missing" },
    );

    const result = await walkAgentKvReachability(
      state(bytesField(1, Buffer.from(rootId, "hex"))),
      lookup,
      { limits: { maxNodes: 4 } },
    );

    expect(result.roots).toEqual([rootId]);
    expect(result.blobs.map((blob) => blob.id)).toEqual([rootId]);
    expect(result.missing.map((blob) => blob.id)).toEqual(
      childIds.slice(0, 3),
    );
    expect(result.visitedNodes).toBe(4);
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(result.limitReasons).toEqual(["nodes"]);
    expect(result.complete).toBe(false);
  });

  it("cooperatively yields during a long run of synchronous SQLite-style lookups", async () => {
    const ids = Array.from({ length: 65 }, (_, index) => distinctId(index + 1));
    const serializedState = state(
      Buffer.concat(
        ids.map((id) => bytesField(1, Buffer.from(id, "hex"))),
      ),
    );
    let lookupCount = 0;
    let yieldedAfterLookups: number | null = null;
    setImmediate(() => {
      yieldedAfterLookups = lookupCount;
    });

    const result = await walkAgentKvReachability(serializedState, () => {
      lookupCount += 1;
      return { status: "missing" };
    });

    expect(result.visitedNodes).toBe(65);
    expect(yieldedAfterLookups).not.toBeNull();
    expect(yieldedAfterLookups).toBeLessThanOrEqual(63);
  });

  it("rejects non-exact keys and invalid configured limits", async () => {
    const id = "55".repeat(32);
    const serializedState = state(bytesField(1, Buffer.from(id, "hex")));

    const result = await walkAgentKvReachability(serializedState, () => ({
      status: "found",
      key: `${key(id)}-suffix`,
      bytes: Buffer.alloc(0),
    }));
    expect(result.unreadable).toMatchObject([
      { source: "blob", id, reason: "unexpected-key" },
    ]);
    expect(result.unavailableIds).toEqual([id]);

    expect(() =>
      extractAgentKvRootIds(serializedState, { limits: { maxBytes: 0 } }),
    ).toThrow(RangeError);
  });
});

function lookupFrom(
  rows: ReadonlyMap<string, AgentKvBlobLookupResult>,
): AgentKvBlobLookup {
  return (requested) => rows.get(requested) ?? { status: "missing" };
}

function key(id: string): string {
  return `${AGENT_KV_BLOB_PREFIX}${id}`;
}

function state(bytes: Uint8Array): string {
  return `~${Buffer.from(bytes).toString("base64")}`;
}

function bytesField(fieldNumber: number, payload: Uint8Array): Buffer {
  return Buffer.concat([
    varint(BigInt(fieldNumber * 8 + 2)),
    varint(BigInt(payload.byteLength)),
    Buffer.from(payload),
  ]);
}

function varint(input: bigint): Buffer {
  let value = input;
  const bytes: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value !== 0n);
  return Buffer.from(bytes);
}

function distinctId(index: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index, 28);
  return bytes.toString("hex");
}
