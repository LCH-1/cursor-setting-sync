import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("vscode", () => ({ window: {}, extensions: { all: [] } }));
import { captureChunkedChat, chunkedChatMetadata, parseChunkedChat, stageChunkedChat,
  assertChunkedChatMetadata, type ChatChunkStore, type ChunkedChatManifest } from "../src/chat/chunked";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { portableChatCoreHash, type PortableComposerHeader, type PortableKvRow } from "../src/chat/stateVscdb";
import { SyncRepository } from "../src/protocol/repository";
import { chatContinuationApplyBlockReason } from "../src/sync/chatContinuationPolicy";
import { prepareChanges } from "../src/helper/main";
import { EventReconciler } from "../src/protocol/reconciler";
import { decodeCursorDataSchema, encodeCursorDataSchema } from "../src/platform/cursorDataSchema";
import legacySchemas from "../src/platform/legacyCursorSchemas.json";
import { CURSOR_MESSAGE_NAMES } from "../src/chat/cursorMessageNames";

const id = "11111111-2222-4333-8444-555555555555";
const header: PortableComposerHeader = { composerId: id, workspaceId: null, createdAt: 1, lastUpdatedAt: 2,
  isArchived: 0, isSubagent: 0, recency: 0, checkpointAt: null, value: '{"name":"Long history"}' };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
function storeFixture() {
  const objects = new Map<string, Buffer>();
  let largest = 0;
  const store: ChatChunkStore = { maxPayloadBytes: 1024 * 1024,
    async writeChatChunk(content) { largest = Math.max(largest, content.byteLength); const objectId = sha256(content);
      objects.set(objectId, content); return { deviceId: "test-device", objectId, plainBytes: content.byteLength, compressedBytes: content.byteLength }; },
    async readObject(ref) { const found = objects.get(ref.objectId); if (found === undefined) { throw new Error("missing chunk"); } return found; },
  };
  return { store, objects, largest: () => largest };
}
function databaseFixture(count: number) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB)");
  const composer = JSON.stringify({ fullConversationHeadersOnly: [...new Set(["00000000", String(count - 1).padStart(8, "0")])].map(bubbleId => ({ bubbleId })) });
  const insert = db.prepare("INSERT INTO cursorDiskKV VALUES(?,?)");
  insert.run(`composerData:${id}`, composer);
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) { insert.run(`bubbleId:${id}:${String(i).padStart(8, "0")}`, JSON.stringify({ text: `message ${i}` })); }
  db.exec("COMMIT"); return db;
}
async function captured(count = 1) {
  const db = databaseFixture(count); const fixture = storeFixture();
  try { const manifest = await captureChunkedChat(db, header, fixture.store); return { ...fixture, manifest }; }
  finally { db.close(); }
}
function replacePart(fixture: Awaited<ReturnType<typeof captured>>, edit: (rows: PortableKvRow[]) => void): ChunkedChatManifest {
  const manifest = structuredClone(fixture.manifest); const part = manifest.parts[0]!;
  const payload = JSON.parse(fixture.objects.get(part.payload.objectId)!.toString("utf8")) as { rows: PortableKvRow[] };
  edit(payload.rows); const bytes = canonicalBytes(payload); part.hash = sha256(bytes);
  part.payload = { ...part.payload, objectId: part.hash, plainBytes: bytes.byteLength, compressedBytes: bytes.byteLength };
  fixture.objects.set(part.hash, bytes); return manifest;
}

describe("bounded chunked chat transfer", () => {
  it.each([false, true])("verifies cross-version fields while staging schema-v3 before preparing a write (changed: %s)", async changed => {
    const root = await mkdtemp(join(tmpdir(), "cross-version-chunks-")); roots.push(root);
    const repository = await SyncRepository.create(join(root, "repo"), join(root, "local"), "a long test passphrase", 1024 * 1024,
      { extensionVersion: "1.0.20", cursorVersion: "3.24.9", vscodeVersion: "1.105.0", cursorDataSchema: legacySchemas["3.24.9"] });
    const db = databaseFixture(1);
    try {
      db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "00000000" }], conversationState: `~${Buffer.from([0xb2, 0x02, 0x01, 0x61]).toString("base64")}` }), `composerData:${id}`);
      const manifest = await captureChunkedChat(db, header, repository);
      const content = canonicalBytes(manifest);
      await repository.publish([{ resourceId: `chat/${id}`, kind: "chat", content, semanticHash: sha256(content), metadata: chunkedChatMetadata(manifest) }], []);
      new EventReconciler().reconcile(await repository.listEvents(), repository.state, null);
      const tip = repository.state.tips[`chat/${id}`]![0]!;
      const schema = structuredClone(decodeCursorDataSchema(legacySchemas["3.23.23"]));
      if (changed) schema.messages[CURSOR_MESSAGE_NAMES["conversation-state"]]!.find(f => f.no === 38)!.name = "different";
      const result = await prepareChanges(repository, [{ ...tip, resourceId: `chat/${id}` }], {
        extensionVersion: "1.0.19", cursorVersion: "3.23.23", vscodeVersion: "1.105.0", cursorDataSchema: encodeCursorDataSchema(schema),
      });
      expect(result.prepared).toHaveLength(changed ? 0 : 1);
      expect(result.failureByResourceId[`chat/${id}`]).toEqual(changed ? expect.stringContaining("#38") : undefined);
      for (const row of result.prepared) await row.chunkedChat?.dispose();
    } finally { db.close(); }
  });
  it("preserves more than 16,384 rows with bounded parts and a verified staged core", async () => {
    const fixture = await captured(17_000);
    expect(fixture.manifest.bubbleCount).toBe(17_000);
    expect(fixture.largest()).toBeLessThanOrEqual(1024 * 1024);
    expect(fixture.manifest.parts.length).toBeGreaterThan(30);
    const stage = await stageChunkedChat(fixture.store, parseChunkedChat(canonicalBytes(fixture.manifest)));
    try { expect(stage.database.prepare("SELECT count(*) AS n FROM kv").get()!.n).toBe(17_001); }
    finally { await stage.dispose(); }
    expect(chatContinuationApplyBlockReason({ kind: "chat", operation: "put", metadata: chunkedChatMetadata(fixture.manifest) })).toBeUndefined();
  }, 30_000);

  it("keeps the exact existing core hash for TEXT, BLOB and SQL NULL rows", async () => {
    const db = databaseFixture(2); const fixture = storeFixture();
    db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(Buffer.from('{"text":"blob"}'), `bubbleId:${id}:00000001`);
    db.prepare("INSERT INTO cursorDiskKV VALUES(?,NULL)").run(`bubbleId:${id}:unreferenced-null`);
    try {
      const manifest = await captureChunkedChat(db, header, fixture.store);
      const rows = [...db.prepare("SELECT key,value,typeof(value) AS t FROM cursorDiskKV ORDER BY key").iterate()]
        .map(row => ({ key: row.key as string, valueType: row.t as "text" | "blob" | "null",
          valueBase64: row.value === null ? "" : Buffer.from(row.value as string | Uint8Array).toString("base64") }));
      const composerData = rows.find(row => row.key.startsWith("composerData:"))!;
      expect(manifest.chatCoreHash).toBe(portableChatCoreHash({ schemaVersion: 1, composerId: id, header,
        composerData, bubbles: rows.filter(row => row.key.startsWith("bubbleId:")) }));
      const stage = await stageChunkedChat(fixture.store, manifest);
      try { expect(stage.database.prepare("SELECT valueType FROM kv WHERE key=?").get(`bubbleId:${id}:unreferenced-null`)!.valueType).toBe("null"); }
      finally { await stage.dispose(); }
    } finally { db.close(); }
  });

  it("streams hash-valid continuation blobs instead of retaining the whole graph", async () => {
    const db = databaseFixture(1); const fixture = storeFixture();
    const blob = Buffer.from("immutable content"); const hash = sha256(blob);
    const state = `~${Buffer.concat([Buffer.from([10,32]), Buffer.from(hash,"hex")]).toString("base64")}`;
    db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "00000000" }], conversationState: state }), `composerData:${id}`);
    db.prepare("INSERT INTO cursorDiskKV VALUES(?,?)").run(`agentKv:blob:${hash}`, blob);
    try {
      const manifest = await captureChunkedChat(db, header, fixture.store);
      expect(manifest.continuationComplete).toBe(true); expect(manifest.agentKvBlobCount).toBe(1);
      const stage = await stageChunkedChat(fixture.store, manifest);
      try { expect(Buffer.from(stage.database.prepare("SELECT value FROM kv WHERE key=?").get(`agentKv:blob:${hash}`)!.value as Uint8Array)).toEqual(blob); }
      finally { await stage.dispose(); }
    } finally { db.close(); }
  });

  it.each(["missing", "tampered", "foreign", "duplicate", "core-hash", "visible-missing"])("refuses %s chunks before the destination is opened", async reason => {
    const fixture = await captured(); let manifest = fixture.manifest;
    if (reason === "missing") { fixture.objects.delete(manifest.parts[0]!.payload.objectId); }
    if (reason === "tampered") { fixture.objects.set(manifest.parts[0]!.payload.objectId, Buffer.from("corrupt")); }
    if (reason === "foreign") { manifest = replacePart(fixture, rows => { rows[1]!.key = "bubbleId:other-composer:00000000"; }); }
    if (reason === "duplicate") { manifest = replacePart(fixture, rows => { rows[1]!.key = rows[0]!.key; }); }
    if (reason === "core-hash") { manifest = { ...manifest, chatCoreHash: "a".repeat(64) }; }
    if (reason === "visible-missing") { manifest = replacePart(fixture, rows => { rows[1]!.key = `bubbleId:${id}:other-message`; }); }
    await expect(stageChunkedChat(fixture.store, manifest)).rejects.toThrow();
  });

  it("binds part references to authenticated metadata and rejects oversized manifests", async () => {
    const fixture = await captured(); const metadata = chunkedChatMetadata(fixture.manifest);
    assertChunkedChatMetadata(fixture.manifest, metadata);
    expect(() => assertChunkedChatMetadata(fixture.manifest, { ...metadata, chatChunks: [] })).toThrow();
    expect(() => parseChunkedChat(canonicalBytes({ ...fixture.manifest, parts: [{ ...fixture.manifest.parts[0], payload: {
      ...fixture.manifest.parts[0]!.payload, plainBytes: 512 * 1024 * 1024 } }] }))).toThrow();
  });

  it("retains encrypted chunks during orphan compaction even when only their manifest is an event payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "chunked-chat-repository-")); roots.push(root);
    const repository = await SyncRepository.create(join(root,"repo"),join(root,"local"),"a long test passphrase",1024*1024,
      { extensionVersion: "1.0.16", cursorVersion: "3.22.12", vscodeVersion: "1.128.0" });
    const db = databaseFixture(1);
    try {
      const manifest = await captureChunkedChat(db, header, repository);
      const content = canonicalBytes(manifest);
      await repository.publish([{ resourceId: `chat/${id}`, kind: "chat", content, semanticHash: sha256(content), metadata: chunkedChatMetadata(manifest) }], []);
      await repository.createCheckpoint(true);
      const result = await repository.compactOwnOrphans(true);
      expect(result.removedFiles).toBe(0);
      const stage = await stageChunkedChat(repository, manifest); await stage.dispose();
    } finally { db.close(); }
  });

  it("does not declare incomplete continuation data ready to apply", async () => {
    const db = databaseFixture(1); const fixture = storeFixture(); const hash = createHash("sha256").update("missing").digest("hex");
    const state = `~${Buffer.concat([Buffer.from([10,32]), Buffer.from(hash,"hex")]).toString("base64")}`;
    db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "00000000" }], conversationState: state }), `composerData:${id}`);
    try { const manifest = await captureChunkedChat(db, header, fixture.store);
      expect(manifest.continuationComplete).toBe(false);
      expect(chatContinuationApplyBlockReason({ kind: "chat", operation: "put", metadata: chunkedChatMetadata(manifest) })).toBeDefined();
      await expect(stageChunkedChat(fixture.store, manifest)).rejects.toThrow("incomplete");
    } finally { db.close(); }
  });
});
