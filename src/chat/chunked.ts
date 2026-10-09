import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DatabaseSync } from "../platform/sqlite";
import { canonicalBytes, canonicalJson, isCanonicalBase64Text, sha256 } from "../protocol/canonical";
import { buffersFitJsonStructureBudget } from "../protocol/jsonStructure";
import type { JsonValue, ObjectReference } from "../types";
import type { PortableComposerHeader, PortableKvRow } from "./stateVscdb";
import { updatePortableComposerHeaderHash } from "./headerCanonical";
import { walkAgentKvReachability, type AgentKvBlobLookupResult, type AgentKvWalkOptions } from "./agentKv";

export const CHAT_CHUNK_BYTES = 8 * 1024 * 1024;
export const CHUNKED_CHAT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const CHUNKED_CHAT_MAX_ROWS = 250_000;
const MAX_PARTS = 4_096;
const MAX_CHUNK_ROWS = 512;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

export interface ChatChunkStore {
  writeChatChunk(content: Buffer): Promise<ObjectReference>;
  readObject(reference: ObjectReference): Promise<Buffer>;
  readonly maxPayloadBytes: number;
}
interface ChatPart {
  payload: ObjectReference;
  hash: string;
  rows: number;
  kind: "core" | "agent-kv";
}
export interface ChunkedChatManifest {
  schemaVersion: 3;
  composerId: string;
  header: PortableComposerHeader;
  parts: ChatPart[];
  bubbleCount: number;
  agentKvBlobCount: number;
  agentKvMissingCount: number;
  continuationComplete: boolean;
  chatCoreHash: string;
}
interface RawRow { key: string; value: string | Uint8Array | null; valueType: string; valueBytes: number }

function portable(row: RawRow): PortableKvRow {
  if (!["text", "blob", "null"].includes(row.valueType) || row.valueBytes > CHAT_CHUNK_BYTES ||
      (row.valueType !== "null" && row.value === null)) {
    throw new Error("A chat row exceeds the fixed chunk work limit or has an unsupported storage class.");
  }
  return { key: row.key, valueType: row.valueType as "text" | "blob" | "null",
    valueBase64: row.value === null ? "" : Buffer.from(row.value).toString("base64") };
}
function boundedRowQuery(database: DatabaseSync) {
  return database.prepare("SELECT key, typeof(value) AS valueType, length(CAST(value AS BLOB)) AS valueBytes, " +
    "CASE WHEN length(CAST(value AS BLOB)) <= ?2 THEN value ELSE NULL END AS value FROM cursorDiskKV WHERE key = ?1");
}
function readRow(database: DatabaseSync, key: string): PortableKvRow | undefined {
  const raw = boundedRowQuery(database).get(key, CHAT_CHUNK_BYTES) as RawRow | undefined;
  return raw === undefined ? undefined : portable(raw);
}
function jsonRow(row: PortableKvRow): Record<string, unknown> {
  const bytes = Buffer.from(row.valueBase64, "base64");
  if (row.valueType === "null" || !buffersFitJsonStructureBudget([bytes], { maxStructuralTokens: 1_048_576 })) {
    throw new Error("Chat continuation JSON exceeds the bounded per-row work limit.");
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Chat continuation JSON is unreadable.");
  }
  return parsed as Record<string, unknown>;
}
function visibleIds(composer: PortableKvRow): Set<string> | null {
  const parsed = jsonRow(composer);
  if (!Object.hasOwn(parsed, "fullConversationHeadersOnly")) { return null; }
  const headers = parsed.fullConversationHeadersOnly;
  if (!Array.isArray(headers) || headers.length > CHUNKED_CHAT_MAX_ROWS) {
    throw new Error("Chat visible message index is invalid.");
  }
  const ids = new Set<string>();
  for (const header of headers) {
    const id = header !== null && typeof header === "object" ? (header as Record<string, unknown>).bubbleId : undefined;
    if (typeof id !== "string" || id.length === 0 || id.length > 1_024 || ids.has(id)) {
      throw new Error("Chat visible message index is invalid.");
    }
    ids.add(id);
  }
  return ids;
}
interface ContinuationSeeds { values: Set<string>; bytes: number }
function addState(row: PortableKvRow, states: ContinuationSeeds): void {
  const parsed = jsonRow(row);
  if (!Object.hasOwn(parsed, "conversationState")) { return; }
  if (typeof parsed.conversationState !== "string" || parsed.conversationState.length === 0) {
    throw new Error("Chat continuation state is invalid.");
  }
  if (states.values.has(parsed.conversationState)) { return; }
  states.bytes += parsed.conversationState.length;
  if (states.bytes > 32 * 1024 * 1024 || states.values.size >= 50_000) {
    throw new Error("Chat continuation roots exceed the fixed memory work limit.");
  }
  states.values.add(parsed.conversationState);
}
function finishCoreHash(hash: ReturnType<typeof createHash>, composer: PortableKvRow, header: PortableComposerHeader): string {
  hash.update('],"composerData":'); hash.update(canonicalJson(composer));
  hash.update(',"composerId":'); hash.update(canonicalJson(header.composerId));
  hash.update(',"header":'); updatePortableComposerHeaderHash(hash, header);
  hash.update(',"schemaVersion":1}');
  return hash.digest("hex");
}

/** The caller holds a SQLite read transaction, so every part belongs to one generation. */
export async function captureChunkedChat(
  database: DatabaseSync, header: PortableComposerHeader, store: ChatChunkStore,
): Promise<ChunkedChatManifest> {
  const composer = readRow(database, `composerData:${header.composerId}`);
  if (composer === undefined) { throw new Error("Chat composer data disappeared."); }
  const visible = visibleIds(composer);
  const remainingVisible = visible === null ? null : new Set(visible);
  const states: ContinuationSeeds = { values: new Set(), bytes: 0 }; addState(composer, states);
  const parts: ChatPart[] = [];
  const limit = Math.min(CHAT_CHUNK_BYTES, store.maxPayloadBytes);
  let rows: PortableKvRow[] = []; let bytes = 256; let total = 0;
  let kind: ChatPart["kind"] = "core";
  const flush = async () => {
    if (rows.length === 0) { return; }
    const content = canonicalBytes({ schemaVersion: 1, composerId: header.composerId, kind, rows });
    total += content.byteLength;
    if (content.byteLength > limit || total > CHUNKED_CHAT_MAX_BYTES || parts.length >= MAX_PARTS) {
      throw new Error("Chunked chat exceeds its bounded transfer work limit.");
    }
    parts.push({ payload: await store.writeChatChunk(content), hash: sha256(content), rows: rows.length, kind });
    rows = []; bytes = 256;
  };
  const append = async (row: PortableKvRow) => {
    const size = canonicalBytes(row).byteLength + 1;
    if (size + 256 > limit) { throw new Error("A chat row exceeds the configured per-chunk payload limit."); }
    if (bytes + size > limit || rows.length >= MAX_CHUNK_ROWS) { await flush(); }
    rows.push(row); bytes += size;
  };
  await append(composer);
  const hash = createHash("sha256"); hash.update('{"bubbles":[');
  const prefix = `bubbleId:${header.composerId}:`;
  const query = database.prepare("SELECT key, typeof(value) AS valueType, length(CAST(value AS BLOB)) AS valueBytes, " +
    "CASE WHEN length(CAST(value AS BLOB)) <= ?3 THEN value ELSE NULL END AS value " +
    "FROM cursorDiskKV WHERE key >= ?1 AND key < ?2 ORDER BY key LIMIT ?4");
  let count = 0;
  for (const raw of query.iterate(prefix, `bubbleId:${header.composerId};`, CHAT_CHUNK_BYTES, CHUNKED_CHAT_MAX_ROWS + 1)) {
    if (count >= CHUNKED_CHAT_MAX_ROWS) { throw new Error("Chat row count exceeds the chunked transfer limit."); }
    const row = portable(raw as unknown as RawRow);
    if (count++ > 0) { hash.update(","); } hash.update(canonicalJson(row));
    const id = row.key.slice(prefix.length);
    if (visible === null || visible.has(id)) { remainingVisible?.delete(id); addState(row, states); }
    await append(row);
  }
  if (remainingVisible !== null && remainingVisible.size > 0) { throw new Error("Chat visible messages are missing locally."); }
  await flush(); kind = "agent-kv";
  const coreHash = finishCoreHash(hash, composer, header);
  const graph = await walkAgentKvReachability([...states.values], (key, remainingBytes) => {
    const row = readRow(database, key);
    if (row === undefined) { return { status: "missing" }; }
    if (row.valueType === "null") { return { status: "unreadable", reason: "A continuation blob cannot be SQL NULL." }; }
    const value = Buffer.from(row.valueBase64, "base64");
    if (value.byteLength > remainingBytes) { return { status: "over-budget" }; }
    return { status: "found", key, bytes: value, valueType: row.valueType === "blob" ? "blob" : "text" };
  }, { limits: { maxNodes: 50_000, maxBytes: CHUNKED_CHAT_MAX_BYTES, maxDepth: 256, maxProtobufDepth: 64 },
    blobSink: async (blob) => append({ key: blob.key, valueType: blob.valueType ?? "text", valueBase64: blob.bytes.toString("base64") }) });
  await flush();
  return { schemaVersion: 3, composerId: header.composerId, header, parts, bubbleCount: count,
    agentKvBlobCount: graph.streamedBlobIds?.length ?? 0, agentKvMissingCount: graph.unavailableIds.length,
    continuationComplete: graph.complete, chatCoreHash: coreHash };
}

function validateReference(value: unknown): asserts value is ObjectReference {
  const r = value as ObjectReference | null;
  if (r === null || typeof r !== "object" || typeof r.deviceId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.deviceId) || !HASH.test(r.objectId) ||
      !Number.isSafeInteger(r.plainBytes) || r.plainBytes <= 0 || r.plainBytes > CHAT_CHUNK_BYTES ||
      !Number.isSafeInteger(r.compressedBytes) || r.compressedBytes <= 0 || r.compressedBytes > CHAT_CHUNK_BYTES + 65_536) {
    throw new Error("Invalid chat chunk object reference.");
  }
}
export function chunkReferences(metadata: Record<string, JsonValue> | undefined): ObjectReference[] {
  if (metadata?.chatSnapshotSchemaVersion !== 3) { return []; }
  const values = metadata.chatChunks;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_PARTS) { throw new Error("Chat chunk index is invalid."); }
  return values.map(value => { validateReference(value); return value; });
}
export function parseChunkedChat(content: Buffer): ChunkedChatManifest {
  if (content.byteLength > CHAT_CHUNK_BYTES || !buffersFitJsonStructureBudget([content], { maxStructuralTokens: 262_144 })) {
    throw new Error("Chat chunk manifest exceeds its parser work limit.");
  }
  const m = JSON.parse(content.toString("utf8")) as ChunkedChatManifest;
  if (m === null || typeof m !== "object" || m.schemaVersion !== 3 || !ID.test(m.composerId) ||
      m.header === null || typeof m.header !== "object" || m.header.composerId !== m.composerId ||
      ![m.header.workspaceId, m.header.value].every(v => v === null || typeof v === "string") ||
      ![m.header.createdAt, m.header.lastUpdatedAt, m.header.isArchived, m.header.isSubagent, m.header.recency, m.header.checkpointAt]
        .every(v => v === null || (typeof v === "number" && Number.isFinite(v))) ||
      typeof m.continuationComplete !== "boolean" || !HASH.test(m.chatCoreHash) ||
      ![m.bubbleCount, m.agentKvBlobCount, m.agentKvMissingCount].every(v => Number.isSafeInteger(v) && v >= 0 && v <= CHUNKED_CHAT_MAX_ROWS) ||
      !Array.isArray(m.parts) || m.parts.length === 0 || m.parts.length > MAX_PARTS) {
    throw new Error("Invalid chunked chat manifest.");
  }
  let total = 0;
  for (const p of m.parts) {
    if (p === null || typeof p !== "object" || !HASH.test(p.hash) || !["core", "agent-kv"].includes(p.kind) ||
        !Number.isSafeInteger(p.rows) || p.rows <= 0 || p.rows > MAX_CHUNK_ROWS) { throw new Error("Invalid chat chunk descriptor."); }
    validateReference(p.payload); total += p.payload.plainBytes;
  }
  if (total > CHUNKED_CHAT_MAX_BYTES || m.parts.reduce((n, p) => n + p.rows, 0) !== m.bubbleCount + m.agentKvBlobCount + 1) {
    throw new Error("Chat chunk counts or transfer size are invalid.");
  }
  return m;
}
export function chunkedChatMetadata(m: ChunkedChatManifest): Record<string, JsonValue> {
  return { chatSnapshotSchemaVersion: 3, chatCoreHash: m.chatCoreHash, bubbleCount: m.bubbleCount,
    composerId: m.composerId, workspaceId: m.header.workspaceId, lastUpdatedAt: m.header.lastUpdatedAt,
    agentKvBlobCount: m.agentKvBlobCount, agentKvReferencedCount: m.agentKvBlobCount + m.agentKvMissingCount,
    agentKvMissingCount: m.agentKvMissingCount, continuationComplete: m.continuationComplete,
    chatChunks: m.parts.map(p => ({ ...p.payload })) };
}
export function assertChunkedChatMetadata(m: ChunkedChatManifest, metadata: Record<string, JsonValue> | undefined): void {
  if (canonicalJson(chunkReferences(metadata)) !== canonicalJson(m.parts.map(p => p.payload)) ||
      metadata?.chatCoreHash !== m.chatCoreHash || metadata.bubbleCount !== m.bubbleCount ||
      metadata.composerId !== m.composerId || metadata.workspaceId !== m.header.workspaceId ||
      metadata.agentKvBlobCount !== m.agentKvBlobCount || metadata.agentKvMissingCount !== m.agentKvMissingCount ||
      metadata.continuationComplete !== m.continuationComplete) { throw new Error("Chat manifest does not match authenticated metadata."); }
}

export interface StagedChunkedChat {
  manifest: ChunkedChatManifest;
  database: DatabaseSync;
  dispose(): Promise<void>;
}
export async function stageChunkedChat(store: ChatChunkStore, m: ChunkedChatManifest, onField?: AgentKvWalkOptions["onField"]): Promise<StagedChunkedChat> {
  if (!m.continuationComplete || m.agentKvMissingCount !== 0) { throw new Error("Chat continuation snapshot is incomplete."); }
  const root = await mkdtemp(join(tmpdir(), "cursor-sync-chat-"));
  const database = openDatabase(join(root, "stage.sqlite"));
  const dispose = async () => { database.close(); await rm(root, { recursive: true, force: true }); };
  try {
    database.exec("CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB, valueType TEXT, kind TEXT); BEGIN");
    const insert = database.prepare("INSERT INTO kv VALUES(?,?,?,?)");
    const prefix = `bubbleId:${m.composerId}:`;
    for (const part of m.parts) {
      const content = await store.readObject(part.payload);
      if (content.byteLength !== part.payload.plainBytes || content.byteLength > CHAT_CHUNK_BYTES || sha256(content) !== part.hash ||
          !buffersFitJsonStructureBudget([content])) { throw new Error("Chat chunk authentication or parser limit failed."); }
      const parsed = JSON.parse(content.toString("utf8")) as { schemaVersion: number; composerId: string; kind: string; rows: PortableKvRow[] };
      if (parsed?.schemaVersion !== 1 || parsed.composerId !== m.composerId || parsed.kind !== part.kind ||
          !Array.isArray(parsed.rows) || parsed.rows.length !== part.rows) { throw new Error("Chat chunk does not match its descriptor."); }
      for (const row of parsed.rows) {
        const allowed = part.kind === "core" ? row.key === `composerData:${m.composerId}` ||
          (typeof row.key === "string" && row.key.startsWith(prefix) && row.key.length > prefix.length) :
          typeof row.key === "string" && /^agentKv:blob:[a-f0-9]{64}$/.test(row.key);
        if (!allowed || row.key.length > 1_200 || !isCanonicalBase64Text(row.valueBase64) ||
            !["text", "blob", "null"].includes(row.valueType ?? "text")) { throw new Error("Invalid chat chunk row."); }
        const value = Buffer.from(row.valueBase64, "base64");
        if (value.toString("base64") !== row.valueBase64 || (row.valueType === "null" && value.byteLength !== 0) ||
            (row.valueType === "text" && !Buffer.from(value.toString("utf8")).equals(value)) ||
            (part.kind === "agent-kv" && (row.valueType === "null" || sha256(value) !== row.key.slice("agentKv:blob:".length)))) { throw new Error("Chat chunk row content is invalid."); }
        insert.run(row.key, value, row.valueType ?? "text", part.kind);
      }
    }
    database.exec("COMMIT");
    const composer = stagedRow(database, `composerData:${m.composerId}`);
    if (composer === undefined) { throw new Error("Chat chunk composer data is missing."); }
    const visible = visibleIds(composer); const remaining = visible === null ? null : new Set(visible);
    const states: ContinuationSeeds = { values: new Set(), bytes: 0 }; addState(composer, states);
    const hash = createHash("sha256"); hash.update('{"bubbles":['); let count = 0;
    for (const raw of database.prepare("SELECT key,value,valueType FROM kv WHERE kind='core' AND key>=? AND key<? ORDER BY key").iterate(prefix, `bubbleId:${m.composerId};`)) {
      const row = stagedPortable(raw);
      if (count++ > 0) { hash.update(","); } hash.update(canonicalJson(row));
      const id = row.key.slice(prefix.length);
      if (visible === null || visible.has(id)) { remaining?.delete(id); addState(row, states); }
    }
    const blobCount = database.prepare("SELECT count(*) AS n FROM kv WHERE kind='agent-kv'").get()!.n;
    if (count !== m.bubbleCount || blobCount !== m.agentKvBlobCount || remaining?.size ||
        finishCoreHash(hash, composer, m.header) !== m.chatCoreHash) { throw new Error("Chat chunk core is incomplete or has an invalid hash."); }
    const graph = await walkAgentKvReachability([...states.values], key => stagedBlobLookup(database, key), {
      limits: { maxNodes: 50_000, maxBytes: CHUNKED_CHAT_MAX_BYTES, maxDepth: 256, maxProtobufDepth: 64 }, blobSink: async () => {},
      ...(onField === undefined ? {} : { onField }),
    });
    if (!graph.complete) { throw new Error("Chat chunk continuation closure could not be verified."); }
    return { manifest: m, database, dispose };
  } catch (error) { await dispose(); throw error; }
}
export function stagedPortable(raw: Record<string, unknown>): PortableKvRow {
  return { key: raw.key as string, valueType: raw.valueType as "text" | "blob" | "null", valueBase64: Buffer.from(raw.value as Uint8Array).toString("base64") };
}
export function stagedRow(database: DatabaseSync, key: string): PortableKvRow | undefined {
  const row = database.prepare("SELECT key,value,valueType FROM kv WHERE key=?").get(key);
  return row === undefined ? undefined : stagedPortable(row);
}
function stagedBlobLookup(database: DatabaseSync, key: string): AgentKvBlobLookupResult {
  const row = database.prepare("SELECT value,valueType FROM kv WHERE key=? AND kind='agent-kv'").get(key);
  return row === undefined ? { status: "missing" } : { status: "found", key, bytes: row.value as Uint8Array,
    valueType: row.valueType === "blob" ? "blob" : "text" };
}
