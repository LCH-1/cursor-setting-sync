import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fixture from "./fixtures/chat-snapshot.json";
import {
  bubbleKeyRange,
  parsePortableChatSnapshot,
  portableChatConversationStates,
  portableChatCoreHash,
} from "../src/chat/stateVscdb";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import {
  portableComposerHeaderCanonicalByteLength,
  updatePortableComposerHeaderHash,
} from "../src/chat/headerCanonical";

describe("chat bubble index range", () => {
  it("covers exactly one composer's bubble prefix", () => {
    const composerId = "11111111-1111-4111-8111-111111111111";
    const [lower, upper] = bubbleKeyRange(composerId);
    const belongs = `bubbleId:${composerId}:message-a`;

    expect(belongs >= lower && belongs < upper).toBe(true);
    expect(`bubbleId:${composerId}9:message` >= lower).toBe(false);
    const composerRow = `composerData:${composerId}`;
    expect(composerRow >= lower && composerRow < upper).toBe(false);
  });
});

describe("portable chat snapshot", () => {
  it("streams exact canonical header bytes across escapes and surrogate boundaries", () => {
    const pairAcrossChunkBoundary = `${"a".repeat(16 * 1024 - 1)}😀tail`;
    const header = {
      composerId: fixture.composerId,
      workspaceId: `workspace-\u0000-\n-\\-"-${pairAcrossChunkBoundary}`,
      createdAt: 1,
      lastUpdatedAt: -0,
      isArchived: 0,
      isSubagent: null,
      recency: 1.25e21,
      checkpointAt: null,
      value: `left-\ud800-middle-\udfff-right-${"\u0001".repeat(4096)}`,
    };
    const expected = canonicalBytes(header);
    const hash = createHash("sha256");

    updatePortableComposerHeaderHash(hash, header);

    expect(hash.digest("hex")).toBe(sha256(expected));
    expect(portableComposerHeaderCanonicalByteLength(header)).toBe(
      expected.byteLength,
    );
  });

  it("keeps the streaming core hash equal to the canonical v1 snapshot", () => {
    const snapshot = parsePortableChatSnapshot(
      canonicalBytes({
        ...fixture,
        header: {
          ...fixture.header,
          workspaceId: `${"x".repeat(16 * 1024 - 1)}😀`,
          value: `\ud800${"\\\"\n".repeat(1024)}`,
        },
      }),
    );
    const canonicalCore = canonicalBytes({
      schemaVersion: 1,
      composerId: snapshot.composerId,
      header: snapshot.header,
      composerData: snapshot.composerData,
      bubbles: snapshot.bubbles,
    });

    expect(portableChatCoreHash(snapshot)).toBe(sha256(canonicalCore));
  });

  it("accepts an anonymous valid fixture", () => {
    const parsed = parsePortableChatSnapshot(
      Buffer.from(JSON.stringify(fixture), "utf8"),
    );

    expect(parsed.bubbles).toHaveLength(1);
    expect(parsed.header.workspaceId).toBe("anonymous-workspace");
  });

  it("round-trips the full live-capture bubble budget", () => {
    const snapshot = structuredClone(fixture);
    snapshot.bubbles = Array.from({ length: 16_384 }, (_, index) => ({
      key: `bubbleId:${fixture.composerId}:${index.toString(16).padStart(4, "0")}`,
      valueBase64: Buffer.from("{}", "utf8").toString("base64"),
      valueType: "text",
    }));

    const parsed = parsePortableChatSnapshot(canonicalBytes(snapshot));

    expect(parsed.bubbles).toHaveLength(16_384);
  });

  it("rejects a bubble belonging to another conversation", () => {
    const invalid = structuredClone(fixture);
    invalid.bubbles[0]!.key =
      "bubbleId:11111111-1111-4111-8111-111111111111:message";

    expect(() =>
      parsePortableChatSnapshot(Buffer.from(JSON.stringify(invalid), "utf8")),
    ).toThrow("another composer");
  });

  it("accepts and preserves per-row storage classes", () => {
    const typed = structuredClone(fixture);
    (typed.composerData as Record<string, unknown>).valueType = "text";
    (typed.bubbles[0] as Record<string, unknown>).valueType = "blob";

    const parsed = parsePortableChatSnapshot(
      Buffer.from(JSON.stringify(typed), "utf8"),
    );

    expect(parsed.composerData.valueType).toBe("text");
    expect(parsed.bubbles[0]?.valueType).toBe("blob");
  });

  it("rejects an unknown storage class", () => {
    const invalid = structuredClone(fixture);
    (invalid.bubbles[0] as Record<string, unknown>).valueType = "integer";

    expect(() =>
      parsePortableChatSnapshot(Buffer.from(JSON.stringify(invalid), "utf8")),
    ).toThrow("storage class");
  });

  it("accepts a deterministic, content-address-verified v2 agentKv payload", () => {
    const bytes = Buffer.from("reachable blob", "utf8");
    const blobId = sha256(bytes);
    const missingId = "f".repeat(64);
    const parsed = parsePortableChatSnapshot(
      canonicalBytes({
        ...fixture,
        schemaVersion: 2,
        agentKv: {
          blobs: [
            {
              key: `agentKv:blob:${blobId}`,
              valueBase64: bytes.toString("base64"),
              valueType: "blob",
            },
          ],
          referencedIds: [blobId, missingId].sort(),
          missingIds: [missingId],
        },
      }),
    );

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.schemaVersion === 2 && parsed.agentKv.missingIds).toEqual([
      missingId,
    ]);
  });

  it("rejects v2 blobs whose key, bytes, or reachability partition disagree", () => {
    const bytes = Buffer.from("real bytes", "utf8");
    const id = sha256(bytes);
    const valid = {
      ...fixture,
      schemaVersion: 2,
      agentKv: {
        blobs: [
          {
            key: `agentKv:blob:${id}`,
            valueBase64: bytes.toString("base64"),
            valueType: "text",
          },
        ],
        referencedIds: [id],
        missingIds: [],
      },
    };
    const wrongHash = structuredClone(valid);
    wrongHash.agentKv.blobs[0]!.valueBase64 = Buffer.from("tampered").toString(
      "base64",
    );
    const missingPartition = structuredClone(valid);
    missingPartition.agentKv.referencedIds = [];
    const duplicate = structuredClone(valid);
    duplicate.agentKv.blobs.push({ ...duplicate.agentKv.blobs[0]! });

    for (const invalid of [wrongHash, missingPartition, duplicate]) {
      expect(() => parsePortableChatSnapshot(canonicalBytes(invalid))).toThrow();
    }
  });

  it("rejects non-UTF-8 agentKv bytes declared as SQLite TEXT", () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    const id = sha256(bytes);
    expect(() =>
      parsePortableChatSnapshot(
        canonicalBytes({
          ...fixture,
          schemaVersion: 2,
          agentKv: {
            blobs: [
              {
                key: `agentKv:blob:${id}`,
                valueBase64: bytes.toString("base64"),
                valueType: "text",
              },
            ],
            referencedIds: [id],
            missingIds: [],
          },
        }),
      ),
    ).toThrow("content address");
  });

  it("extracts only top-level conversationState roots from core rows", () => {
    const snapshot = parsePortableChatSnapshot(
      canonicalBytes({
        ...fixture,
        composerData: {
          key: `composerData:${fixture.composerId}`,
          valueBase64: Buffer.from(
            JSON.stringify({ conversationState: "~root-a" }),
          ).toString("base64"),
          valueType: "text",
        },
        bubbles: [
          {
            key: `bubbleId:${fixture.composerId}:one`,
            valueBase64: Buffer.from(
              JSON.stringify({ conversationState: "~root-b" }),
            ).toString("base64"),
            valueType: "text",
          },
          {
            key: `bubbleId:${fixture.composerId}:two`,
            valueBase64: Buffer.from(
              JSON.stringify({ nested: { conversationState: "~false-root" } }),
            ).toString("base64"),
            valueType: "text",
          },
        ],
      }),
    );

    expect(portableChatConversationStates(snapshot)).toEqual([
      "~root-a",
      "~root-b",
    ]);
  });
});
