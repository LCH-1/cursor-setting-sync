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
    const child = shellTurn({ commandId: leafId });
    const childId = sha256(child);
    const serializedState = state(
      bytesField(8, Buffer.from(childId, "hex")),
    );
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
    const sharedStep = assistantStep(shared);
    const sharedId = sha256(sharedStep);
    const first = agentTurn([sharedId], "first");
    const second = agentTurn([sharedId], "second");
    const firstId = sha256(first);
    const secondId = sha256(second);
    const firstState = state(bytesField(8, Buffer.from(firstId, "hex")));
    const combinedState = state(
      Buffer.concat([
        bytesField(8, Buffer.from(secondId, "hex")),
        bytesField(8, Buffer.from(firstId, "hex")),
      ]),
    );
    const rows = new Map<string, AgentKvBlobLookupResult>([
      [key(firstId), { status: "found", key: key(firstId), bytes: first }],
      [key(secondId), { status: "found", key: key(secondId), bytes: second }],
      [
        key(sharedId),
        { status: "found", key: key(sharedId), bytes: sharedStep },
      ],
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
        bytesField(3, Buffer.from(tamperedId, "hex")),
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
        bytesField(3, Buffer.from(secondId, "hex")),
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
        bytesField(3, Buffer.from(throwingId, "hex")),
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
        bytesField(1, Buffer.from(secondId, "hex")),
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

  it("does not turn Calendar's 32-byte Grep, Shell, or token payloads into blob edges", async () => {
    const embeddedMatch32 = bytesField(2, Buffer.alloc(30, 0x61));
    expect(embeddedMatch32).toHaveLength(32);
    const content32 = Buffer.alloc(32, 0x62);
    const grepFileMatch = Buffer.concat([
      bytesField(2, embeddedMatch32),
      bytesField(2, bytesField(2, content32)),
    ]);
    const grepStep = toolStep(
      5,
      bytesField(
        2,
        bytesField(
          1,
          bytesField(
            4,
            mapEntry(
              "workspace",
              bytesField(3, bytesField(1, grepFileMatch)),
            ),
          ),
        ),
      ),
    );
    const shellScalar32 = Buffer.alloc(32, 0x63);
    const shellStep = toolStep(
      1,
      bytesField(1, bytesField(8, bytesField(2, bytesField(2, shellScalar32)))),
    );
    const opaqueAssistantStep = assistantStep(Buffer.alloc(32, 0x64));
    const steps = [grepStep, shellStep, opaqueAssistantStep].map((bytes) => ({
      bytes,
      id: sha256(bytes),
    }));
    const turn = agentTurn(steps.map(({ id }) => id));
    const turnId = sha256(turn);

    const tokenCategory32 = bytesField(1, Buffer.alloc(30, 0x65));
    expect(tokenCategory32).toHaveLength(32);
    const serializedState = state(
      Buffer.concat([
        bytesField(8, Buffer.from(turnId, "hex")),
        bytesField(5, bytesField(3, bytesField(3, tokenCategory32))),
      ]),
    );
    const rows = new Map<string, AgentKvBlobLookupResult>([
      [key(turnId), { status: "found", key: key(turnId), bytes: turn }],
      ...steps.map(
        ({ id, bytes }) =>
          [key(id), { status: "found", key: key(id), bytes }] as const,
      ),
    ]);
    const lookup = vi.fn(lookupFrom(rows));

    const result = await walkAgentKvReachability(serializedState, lookup);

    expect(result.roots).toEqual([turnId]);
    expect(result.blobs.map(({ id }) => id).sort()).toEqual(
      [turnId, ...steps.map(({ id }) => id)].sort(),
    );
    expect(result.missing).toEqual([]);
    expect(result.limitReasons).toEqual([]);
    expect(result.complete).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(4);
    for (const falseId of [
      embeddedMatch32.toString("hex"),
      content32.toString("hex"),
      shellScalar32.toString("hex"),
      tokenCategory32.toString("hex"),
    ]) {
      expect(lookup).not.toHaveBeenCalledWith(key(falseId), expect.anything());
    }
  });

  it("walks typed read, truncated, and nested task references and keeps true missing IDs", async () => {
    const readMissingId = "71".repeat(32);
    const truncatedMissingId = "72".repeat(32);
    const taskMissingId = "73".repeat(32);
    const readStep = readBlobStep(readMissingId);
    const truncatedStep = toolStep(
      34,
      bytesField(1, Buffer.from(truncatedMissingId, "hex")),
    );
    const taskStep = toolStep(
      19,
      bytesField(
        2,
        bytesField(1, bytesField(1, readBlobStep(taskMissingId))),
      ),
    );
    const steps = [readStep, truncatedStep, taskStep].map((bytes) => ({
      bytes,
      id: sha256(bytes),
    }));
    const turn = agentTurn(steps.map(({ id }) => id));
    const turnId = sha256(turn);
    const rows = new Map<string, AgentKvBlobLookupResult>([
      [key(turnId), { status: "found", key: key(turnId), bytes: turn }],
      ...steps.map(
        ({ id, bytes }) =>
          [key(id), { status: "found", key: key(id), bytes }] as const,
      ),
    ]);

    const result = await walkAgentKvReachability(
      state(bytesField(8, Buffer.from(turnId, "hex"))),
      lookupFrom(rows),
    );

    expect(result.missing).toEqual(
      [readMissingId, taskMissingId, truncatedMissingId]
        .sort()
        .map((id) => ({ id, key: key(id), depth: 2 })),
    );
    expect(result.unavailableIds).toEqual(
      [readMissingId, taskMissingId, truncatedMissingId].sort(),
    );
    expect(result.limitReasons).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it("preserves selected-context, subagent, map, and oneof reference semantics", async () => {
    const overwrittenImage = opaqueFixture("overwritten image");
    const selectedImage = opaqueFixture("selected image");
    const inlineImage = opaqueFixture("inline image fallback");
    const invocation = opaqueFixture("invocation");
    const extra = opaqueFixture("extra context");
    const pullRequest = opaqueFixture("pull request");
    const gitDiff = opaqueFixture("git diff");
    const snapshot = { bytes: Buffer.alloc(0), id: sha256(Buffer.alloc(0)) };
    const selectedContext = Buffer.concat([
      bytesField(
        1,
        Buffer.concat([
          bytesField(1, Buffer.from(overwrittenImage.id, "hex")),
          bytesField(8, Buffer.from("inline", "utf8")),
        ]),
      ),
      bytesField(
        1,
        bytesField(9, bytesField(1, Buffer.from(selectedImage.id, "hex"))),
      ),
      bytesField(
        1,
        bytesField(
          9,
          Buffer.concat([
            bytesField(1, Buffer.from(inlineImage.id, "hex")),
            bytesField(2, Buffer.from("present", "utf8")),
          ]),
        ),
      ),
      bytesField(2, bytesField(10, Buffer.from(invocation.id, "hex"))),
      bytesField(16, bytesField(2, Buffer.from(extra.id, "hex"))),
      bytesField(20, bytesField(6, Buffer.from(gitDiff.id, "hex"))),
      bytesField(21, bytesField(7, Buffer.from(pullRequest.id, "hex"))),
    ]);
    const user = Buffer.concat([
      bytesField(3, selectedContext),
      bytesField(10, Buffer.from(snapshot.id, "hex")),
    ]);
    const userId = sha256(user);
    const turn = bytesField(
      1,
      bytesField(1, Buffer.from(userId, "hex")),
    );
    const turnId = sha256(turn);

    const overwrittenMap = opaqueFixture("overwritten map value");
    const retainedMap = opaqueFixture("retained map value");
    const fileContent = opaqueFixture("file content");
    const initialContent = opaqueFixture("initial content");
    const embeddedSubagent = opaqueFixture("embedded subagent state value");
    const referencedSubagent = opaqueFixture("referenced subagent state value");
    const subagentState = bytesField(
      1,
      bytesField(3, Buffer.from(referencedSubagent.id, "hex")),
    );
    const subagentStateId = sha256(subagentState);
    const serializedState = state(
      Buffer.concat([
        bytesField(8, Buffer.from(turnId, "hex")),
        bytesField(
          12,
          mapEntry("same.ts", Buffer.from(overwrittenMap.id, "hex")),
        ),
        bytesField(
          12,
          mapEntry("same.ts", Buffer.from(retainedMap.id, "hex")),
        ),
        bytesField(
          15,
          mapEntry(
            "file.ts",
            Buffer.concat([
              bytesField(1, Buffer.from(fileContent.id, "hex")),
              bytesField(2, Buffer.from(initialContent.id, "hex")),
            ]),
          ),
        ),
        bytesField(
          16,
          mapEntry(
            "inline-subagent",
            bytesField(
              1,
              bytesField(1, Buffer.from(embeddedSubagent.id, "hex")),
            ),
          ),
        ),
        bytesField(
          31,
          mapEntry("subagent-ref", Buffer.from(subagentStateId, "hex")),
        ),
      ]),
    );
    const materialized = [
      { id: turnId, bytes: turn },
      { id: userId, bytes: user },
      snapshot,
      selectedImage,
      invocation,
      extra,
      gitDiff,
      pullRequest,
      retainedMap,
      fileContent,
      initialContent,
      embeddedSubagent,
      { id: subagentStateId, bytes: subagentState },
      referencedSubagent,
    ];
    const rows = new Map<string, AgentKvBlobLookupResult>(
      materialized.map(({ id, bytes }) => [
        key(id),
        { status: "found", key: key(id), bytes },
      ]),
    );
    const lookup = vi.fn(lookupFrom(rows));

    const result = await walkAgentKvReachability(serializedState, lookup);

    expect(result.roots).toEqual(
      [
        turnId,
        retainedMap.id,
        fileContent.id,
        initialContent.id,
        embeddedSubagent.id,
        subagentStateId,
      ].sort(),
    );
    expect(result.blobs.map(({ id }) => id).sort()).toEqual(
      materialized.map(({ id }) => id).sort(),
    );
    expect(result.complete).toBe(true);
    for (const ignored of [overwrittenImage, inlineImage, overwrittenMap]) {
      expect(lookup).not.toHaveBeenCalledWith(key(ignored.id), expect.anything());
    }
  });

  it("retains the full graph with Cursor 3.18 compaction and user-message timestamps", async () => {
    const leaf = opaqueFixture("retained conversation context");
    const priorState = bytesField(1, Buffer.from(leaf.id, "hex"));
    const priorStateId = sha256(priorState);
    const user = Buffer.concat([
      bytesField(10, Buffer.from(priorStateId, "hex")),
      varint(25n * 8n),
      varint(1788500000000n),
      varint(26n * 8n),
      varint(1788500237755n),
    ]);
    const userId = sha256(user);
    const turn = bytesField(1, bytesField(1, Buffer.from(userId, "hex")));
    const turnId = sha256(turn);
    const serializedState = state(Buffer.concat([
      bytesField(8, Buffer.from(turnId, "hex")),
      varint(37n * 8n),
      varint(967n),
    ]));
    const materialized = [
      leaf,
      { id: priorStateId, bytes: priorState },
      { id: userId, bytes: user },
      { id: turnId, bytes: turn },
    ];
    const lookup = vi.fn(lookupFrom(new Map(
      materialized.map(({ id, bytes }) => [
        key(id), { status: "found", key: key(id), bytes },
      ]),
    )));

    const result = await walkAgentKvReachability(serializedState, lookup);

    expect(result.complete).toBe(true);
    expect(result.limitReasons).toEqual([]);
    expect(result.blobs.map(({ id }) => id).sort()).toEqual(
      materialized.map(({ id }) => id).sort(),
    );
    expect(lookup).toHaveBeenCalledTimes(materialized.length);
  });

  it.each([37, 38])("refuses non-scalar or unknown conversation field %i", (field) => {
    const result = extractAgentKvRootIds(state(bytesField(field, Buffer.alloc(32))));

    expect(result.complete).toBe(false);
    expect(result.limitReasons).toEqual(["schema"]);
    expect(result.roots).toEqual([]);
  });

  it.each([25, 26, 27])("refuses non-scalar or unknown user-message field %i", async (field) => {
    const user = bytesField(field, Buffer.alloc(32));
    const userId = sha256(user);
    const turn = bytesField(1, bytesField(1, Buffer.from(userId, "hex")));
    const turnId = sha256(turn);
    const result = await walkAgentKvReachability(
      state(bytesField(8, Buffer.from(turnId, "hex"))),
      lookupFrom(new Map([
        [key(turnId), { status: "found", key: key(turnId), bytes: turn }],
        [key(userId), { status: "found", key: key(userId), bytes: user }],
      ])),
    );

    expect(result.complete).toBe(false);
    expect(result.limitReasons).toEqual(["schema"]);
    expect(result.visitedNodes).toBe(2);
  });

  it("fails closed on an unknown conversation schema field without fabricating an ID", () => {
    const arbitrary32 = Buffer.alloc(32, 0x7a);

    const result = extractAgentKvRootIds(state(bytesField(99, arbitrary32)));

    expect(result.roots).toEqual([]);
    expect(result.limitReasons).toEqual(["schema"]);
    expect(result.complete).toBe(false);
  });

  it("reports node, byte, graph-depth, and protobuf-depth bounds", async () => {
    const leaf = Buffer.from([0xff]);
    const leafId = sha256(leaf);
    const root = shellTurn({ commandId: leafId });
    const rootId = sha256(root);
    const serializedState = state(bytesField(8, Buffer.from(rootId, "hex")));
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
        bytesField(3, Buffer.from(leafId, "hex")),
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
      bytesField(
        15,
        mapEntry("src/depth.ts", bytesField(1, Buffer.from(rootId, "hex"))),
      ),
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
    const root = agentTurn(childIds);
    const rootId = sha256(root);
    const lookup = vi.fn<AgentKvBlobLookup>((requested) =>
      requested === key(rootId)
        ? { status: "found", key: key(rootId), bytes: root }
        : { status: "missing" },
    );

    const result = await walkAgentKvReachability(
      state(bytesField(8, Buffer.from(rootId, "hex"))),
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

function agentTurn(stepIds: readonly string[], requestId?: string): Buffer {
  const fields = stepIds.map((id) => bytesField(2, Buffer.from(id, "hex")));
  if (requestId !== undefined) {
    fields.push(bytesField(3, Buffer.from(requestId, "utf8")));
  }
  return bytesField(1, Buffer.concat(fields));
}

function shellTurn(options: {
  commandId?: string;
  outputId?: string;
}): Buffer {
  const fields: Buffer[] = [];
  if (options.commandId !== undefined) {
    fields.push(bytesField(1, Buffer.from(options.commandId, "hex")));
  }
  if (options.outputId !== undefined) {
    fields.push(bytesField(2, Buffer.from(options.outputId, "hex")));
  }
  return bytesField(2, Buffer.concat(fields));
}

function assistantStep(text: Uint8Array): Buffer {
  return bytesField(1, bytesField(1, text));
}

function toolStep(toolFieldNumber: number, toolCall: Uint8Array): Buffer {
  return bytesField(2, bytesField(toolFieldNumber, toolCall));
}

function readBlobStep(id: string): Buffer {
  return toolStep(
    8,
    bytesField(
      2,
      bytesField(1, bytesField(10, Buffer.from(id, "hex"))),
    ),
  );
}

function opaqueFixture(label: string): { bytes: Buffer; id: string } {
  const bytes = Buffer.from(label, "utf8");
  return { bytes, id: sha256(bytes) };
}

function mapEntry(keyText: string, value: Uint8Array): Buffer {
  return Buffer.concat([
    bytesField(1, Buffer.from(keyText, "utf8")),
    bytesField(2, value),
  ]);
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
