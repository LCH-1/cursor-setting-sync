import { describe, expect, it } from "vitest";
import { verifyPortableChatContinuationClosure } from "../src/chat/continuationClosure";
import {
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  type PortableChatSnapshotV2,
  type PortableKvRow,
} from "../src/chat/stateVscdb";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";

const COMPOSER = "11111111-1111-4111-8111-111111111111";

describe("portable v2 continuation closure", () => {
  it("verifies a complete multi-level graph from the elected core", async () => {
    const leaf = assistantStep("continuation leaf");
    const leafId = sha256(leaf);
    const root = agentTurn([leafId]);
    const rootId = sha256(root);
    const snapshot = portableV2(turnStateFor(rootId), [
      blob(rootId, root),
      blob(leafId, leaf),
    ]);

    await expect(verifyPortableChatContinuationClosure(snapshot)).resolves.toEqual({
      status: "complete",
      declaredBlobCount: 2,
      declaredReferencedCount: 2,
      declaredMissingCount: 0,
      activeReachableCount: 2,
      activeMaterializedCount: 2,
      activeUnavailableCount: 0,
      visitedNodeCount: 2,
    });
  });

  it("rejects a missing0 payload that omits the elected core root", async () => {
    const omittedRoot = sha256("omitted elected root");
    const snapshot = portableV2(stateFor(omittedRoot), []);

    await expect(verifyPortableChatContinuationClosure(snapshot)).resolves.toMatchObject({
      status: "invalid",
      reason: "reachable-id-not-declared",
      declaredMissingCount: 0,
      activeReachableCount: 1,
      activeUnavailableCount: 1,
    });
  });

  it("rejects a missing0 payload whose root omits a referenced descendant", async () => {
    const omittedLeaf = assistantStep("omitted descendant");
    const omittedLeafId = sha256(omittedLeaf);
    const root = agentTurn([omittedLeafId]);
    const rootId = sha256(root);
    // The portable parser accepts this partition: it cannot discover edges
    // inside the hash-valid root. The closure verifier must not.
    const snapshot = portableV2(turnStateFor(rootId), [blob(rootId, root)]);

    await expect(verifyPortableChatContinuationClosure(snapshot)).resolves.toMatchObject({
      status: "invalid",
      reason: "reachable-id-not-declared",
      declaredMissingCount: 0,
      activeReachableCount: 2,
      activeMaterializedCount: 1,
      activeUnavailableCount: 1,
    });
  });

  it("accepts retained unreachable blobs and missing IDs from losing cores", async () => {
    const active = Buffer.from("active opaque root", "utf8");
    const activeId = sha256(active);
    const retained = Buffer.from("retained losing-core blob", "utf8");
    const retainedId = sha256(retained);
    const retainedMissingId = sha256("retained losing-core missing row");
    const snapshot = portableV2(
      stateFor(activeId),
      [blob(activeId, active), blob(retainedId, retained)],
      [retainedMissingId],
    );

    await expect(verifyPortableChatContinuationClosure(snapshot)).resolves.toMatchObject({
      status: "complete",
      declaredBlobCount: 2,
      declaredReferencedCount: 3,
      declaredMissingCount: 1,
      activeReachableCount: 1,
      activeMaterializedCount: 1,
      activeUnavailableCount: 0,
    });
  });

  it("reports a declared missing active root as incomplete", async () => {
    const missingRoot = sha256("declared active missing root");
    const snapshot = portableV2(stateFor(missingRoot), [], [missingRoot]);

    await expect(verifyPortableChatContinuationClosure(snapshot)).resolves.toMatchObject({
      status: "incomplete",
      reason: "reachable-content-missing",
      activeReachableCount: 1,
      activeUnavailableCount: 1,
    });
  });

  it("fails closed on malformed conversation state and traversal bounds", async () => {
    const malformed = portableV2("~not-canonical-base64", []);
    await expect(verifyPortableChatContinuationClosure(malformed)).resolves.toMatchObject({
      status: "unknown",
      reason: "conversation-state-unreadable",
    });

    const leaf = assistantStep("bounded leaf");
    const leafId = sha256(leaf);
    const root = agentTurn([leafId]);
    const rootId = sha256(root);
    const bounded = portableV2(turnStateFor(rootId), [
      blob(rootId, root),
      blob(leafId, leaf),
    ]);
    await expect(
      verifyPortableChatContinuationClosure(bounded, {
        limits: { maxNodes: 1 },
      }),
    ).resolves.toMatchObject({ status: "unknown", reason: "walk-limit" });
  });
});

function portableV2(
  conversationState: string,
  blobs: PortableKvRow[],
  missingIds: string[] = [],
): PortableChatSnapshotV2 {
  const blobIds = blobs.map((row) => row.key.slice("agentKv:blob:".length));
  const parsed = parsePortableChatSnapshot(
    canonicalBytes({
      schemaVersion: 2,
      composerId: COMPOSER,
      header: {
        composerId: COMPOSER,
        workspaceId: "workspace-a",
        createdAt: 1,
        lastUpdatedAt: 2,
        isArchived: 0,
        isSubagent: 0,
        recency: 0,
        checkpointAt: null,
        value: JSON.stringify({ name: "Closure fixture" }),
      },
      composerData: {
        key: `composerData:${COMPOSER}`,
        valueBase64: Buffer.from(
          JSON.stringify({ conversationState }),
          "utf8",
        ).toString("base64"),
        valueType: "text",
      },
      bubbles: [],
      agentKv: {
        blobs: [...blobs].sort((left, right) => left.key.localeCompare(right.key)),
        referencedIds: [...new Set([...blobIds, ...missingIds])].sort(),
        missingIds: [...missingIds].sort(),
      },
    }),
  );
  if (!isPortableChatSnapshotV2(parsed)) {
    throw new Error("Expected a portable v2 fixture.");
  }
  return parsed;
}

function blob(id: string, bytes: Buffer): PortableKvRow {
  return {
    key: `agentKv:blob:${id}`,
    valueBase64: bytes.toString("base64"),
    valueType: "blob",
  };
}

function stateFor(rootId: string): string {
  return `~${bytesField(1, Buffer.from(rootId, "hex")).toString("base64")}`;
}

function turnStateFor(turnId: string): string {
  return `~${bytesField(8, Buffer.from(turnId, "hex")).toString("base64")}`;
}

function agentTurn(stepIds: readonly string[]): Buffer {
  return bytesField(
    1,
    Buffer.concat(
      stepIds.map((id) => bytesField(2, Buffer.from(id, "hex"))),
    ),
  );
}

function assistantStep(text: string): Buffer {
  return bytesField(1, bytesField(1, Buffer.from(text, "utf8")));
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
