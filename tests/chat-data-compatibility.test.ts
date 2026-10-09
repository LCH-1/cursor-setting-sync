import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { crossVersionChatBlockReason, chatCompatibilityFieldObserver, canInspectChatCompatibility, isVersionCompatibilityBlock, requiresCrossVersionInspection } from "../src/chat/dataCompatibility";
import { APPLY_FAILURE_BLOCK_PREFIX } from "../src/constants";
import { decodeCursorDataSchema, encodeCursorDataSchema, MAX_CURSOR_SCHEMA_BYTES } from "../src/platform/cursorDataSchema";
import legacy from "../src/platform/legacyCursorSchemas.json";
import { CURSOR_MESSAGE_NAMES } from "../src/chat/cursorMessageNames";
import { effectiveVersionProducer, producerAsMetadata } from "../src/sync/versionPolicy";
import type { PortableChatSnapshotV2 } from "../src/chat/stateVscdb";
import type { EventProducer } from "../src/types";

const producer: EventProducer = { cursorVersion: "3.24.9", vscodeVersion: "1.105.0", extensionVersion: "1.0.20" };
const target = { cursorVersion: "3.23.23", vscodeVersion: "1.105.0", extensionVersion: "1.0.19", cursorDataSchema: legacy["3.23.23"] };
const conversation = CURSOR_MESSAGE_NAMES["conversation-state"];

function varint(value: number): Buffer {
  const bytes = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value > 0 ? 128 : 0)); } while (value > 0);
  return Buffer.from(bytes);
}
function bytesField(no: number, bytes: Buffer): Buffer { return Buffer.concat([varint(no * 8 + 2), varint(bytes.length), bytes]); }
function snapshot(state: Buffer, blobs: Buffer[] = []): PortableChatSnapshotV2 {
  const composerId = "00000000-0000-4000-8000-000000000020";
  return {
    schemaVersion: 2, composerId,
    header: { composerId, workspaceId: "workspace", createdAt: 1, lastUpdatedAt: 2, isArchived: 0, isSubagent: 0, recency: 1, checkpointAt: null, value: "{}" },
    composerData: { key: `composerData:${composerId}`, valueType: "text", valueBase64: Buffer.from(JSON.stringify({ fullConversationHeadersOnly: [], conversationState: `~${state.toString("base64")}` })).toString("base64") },
    bubbles: [], agentKv: { blobs: blobs.map(bytes => ({ key: `agentKv:blob:${sha256(bytes)}`, valueType: "blob", valueBase64: bytes.toString("base64") })), referencedIds: blobs.map(sha256).sort(), missingIds: [] },
  };
}
async function reason(state: Buffer, options: { targetSchema?: string; source?: EventProducer; blobs?: Buffer[] } = {}) {
  return crossVersionChatBlockReason(canonicalBytes(snapshot(state, options.blobs)), { metadata: { chatSnapshotSchemaVersion: 2 } }, options.source ?? producer,
    { ...target, ...(options.targetSchema === undefined ? {} : { cursorDataSchema: options.targetSchema }) });
}

describe("actual cross-version chat data compatibility", () => {
  it("rechecks compatibility failures from the offline helper without retrying corruption or exclusions", () => {
    expect(isVersionCompatibilityBlock(`${APPLY_FAILURE_BLOCK_PREFIX}: The installed Cursor cannot read field. Run apply to retry.`)).toBe(true);
    expect(isVersionCompatibilityBlock(`${APPLY_FAILURE_BLOCK_PREFIX}: Cross-version chat compatibility cannot be verified`)).toBe(true);
    expect(isVersionCompatibilityBlock(`${APPLY_FAILURE_BLOCK_PREFIX}: database corrupt`)).toBe(false);
    expect(isVersionCompatibilityBlock("This workspace is excluded")).toBe(false);
  });
  it("inspects older data too when both actual schemas are available", () => {
    expect(requiresCrossVersionInspection({ ...producer, cursorVersion: "3.23.23" }, { ...target, cursorVersion: "3.24.9", cursorDataSchema: legacy["3.24.9"] })).toBe(true);
  });
  it("accepts the 3.24 to 3.23 case when new fields are unused, despite newer extension version", async () => {
    expect(await reason(bytesField(38, Buffer.from("recent-id")))).toBeNull();
  });
  it("rejects a newly used field absent from the target", async () => {
    expect(await reason(bytesField(42, Buffer.from("agent-id")))).toContain(`${conversation}#42`);
  });
  it.each([{ T: 12 }, { name: "changed_meaning" }, { repeated: false }, { oneof: "selection" }])("rejects a changed used field definition %j", async change => {
    const changed = structuredClone(decodeCursorDataSchema(target.cursorDataSchema));
    Object.assign(changed.messages[conversation]!.find(f => f.no === 38)!, change);
    expect(await reason(bytesField(38, Buffer.from("id")), { targetSchema: encodeCursorDataSchema(changed) })).toContain("source field definition");
  });
  it("checks fields in hash-referenced nested turns", async () => {
    const turn = bytesField(1, bytesField(9, Buffer.from("tool-name")));
    const state = bytesField(8, Buffer.from(sha256(turn), "hex"));
    expect(await reason(state, { blobs: [turn] })).toBeNull();
    const changed = structuredClone(decodeCursorDataSchema(target.cursorDataSchema));
    changed.messages[CURSOR_MESSAGE_NAMES["agent-turn"]]!.find(f => f.no === 9)!.name = "different";
    expect(await reason(state, { blobs: [turn], targetSchema: encodeCursorDataSchema(changed) })).toContain("AgentConversationTurnStructure#9");
  });
  it("rejects opaque nested message and enum changes, including unchanged wire types", async () => {
    for (const [no, type] of [[5, "agent.v1.ConversationTokenDetails"], [10, "agent.v1.AgentMode"]] as const) {
      const changed = structuredClone(decodeCursorDataSchema(target.cursorDataSchema));
      if (no === 5) changed.messages[type]![0]!.name = "different";
      else changed.enums![type]![0]!.name = "different";
      const observer = chatCompatibilityFieldObserver(producer, { ...target, cursorDataSchema: encodeCursorDataSchema(changed) });
      observer.onField("conversation-state", no, no === 10 ? 0 : 2);
      expect(observer.reason()).toContain(`nested ${type}`);
    }
  });
  it("checks an actual new producer schema instead of guessing from the version", async () => {
    expect(await reason(bytesField(38, Buffer.from("id")), { source: { ...producer, cursorVersion: "8.0.0", cursorDataSchema: legacy["3.24.9"] } })).toBeNull();
    expect(await reason(Buffer.alloc(0), { source: { ...producer, cursorVersion: "8.0.0" } })).toContain("unavailable");
  });
  it("fails closed without the installed target descriptors", () => {
    expect(canInspectChatCompatibility(producer, { cursorVersion: "3.23.23" })).toBe(false);
  });
  it("preserves unknown-field protection even when both profiles contain it", async () => {
    expect(await reason(bytesField(42, Buffer.from("id")), { targetSchema: legacy["3.24.9"] })).toContain("cannot be verified");
  });
  it("keeps missing and damaged continuation blobs blocked", async () => {
    const missing = Buffer.from("a".repeat(64), "hex");
    expect(await reason(bytesField(8, missing))).toContain("cannot be verified");
    const data = snapshot(bytesField(8, missing));
    data.agentKv.blobs.push({ key: `agentKv:blob:${missing.toString("hex")}`, valueType: "blob", valueBase64: Buffer.from("wrong hash").toString("base64") });
    expect(await crossVersionChatBlockReason(canonicalBytes(data), {}, producer, target)).not.toBeNull();
    const partial = snapshot(Buffer.alloc(0)); partial.agentKv.missingIds.push(missing.toString("hex")); partial.agentKv.referencedIds.push(missing.toString("hex"));
    expect(await crossVersionChatBlockReason(canonicalBytes(partial), {}, producer, target)).toContain("missing");
  });
  it("rejects authenticated outer schema mismatch", async () => {
    expect(await crossVersionChatBlockReason(canonicalBytes(snapshot(Buffer.alloc(0))), { metadata: { chatSnapshotSchemaVersion: 3 } }, producer, target)).toContain("authenticated metadata");
  });
  it("bounds compressed schema input and rejects malformed descriptors", () => {
    expect(() => decodeCursorDataSchema(gzipSync(Buffer.alloc(MAX_CURSOR_SCHEMA_BYTES + 1)).toString("base64"))).toThrow();
    const changed = structuredClone(decodeCursorDataSchema(target.cursorDataSchema));
    changed.messages[conversation]!.push(changed.messages[conversation]![0]!);
    expect(() => decodeCursorDataSchema(encodeCursorDataSchema(changed))).toThrow("field");
    expect(() => decodeCursorDataSchema(gzipSync(Buffer.from('{"formatVersion":1,"messages":{}}')).toString("base64"))).toThrow("Missing");
  });
  it.each(["version-restore", "agent-kv-enrichment", "checkpoint-marker"])("preserves the original schema across %s", origin => {
    const original = { ...producer, cursorDataSchema: legacy["3.24.9"] };
    const publisher = { ...producer, cursorVersion: "3.23.23", cursorDataSchema: legacy["3.23.23"] };
    const metadata = { syncOrigin: origin, originalProducer: producerAsMetadata(original), checkpointedProducer: producerAsMetadata(original) };
    expect(effectiveVersionProducer(metadata, publisher)?.cursorDataSchema).toBe(original.cursorDataSchema);
  });
});
