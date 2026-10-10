import type { CompatibilityReport, EventProducer, ResourceTip } from "../types";
import type { CursorField, CursorSchemaSnapshot } from "../monitor/cursorSchema";
import legacySchemas from "../platform/legacyCursorSchemas.json";
import { decodeCursorDataSchema } from "../platform/cursorDataSchema";
import { compareVersions } from "../platform/compatibility";
import { AGENT_KV_SCHEMAS, readVarint, scanProtobufMessage, type AgentKvWalkOptions } from "./agentKv";
import { CURSOR_MESSAGE_NAMES } from "./cursorMessageNames";
import { parsePortableChatSnapshot } from "./stateVscdb";
import { verifyPortableChatContinuationClosure } from "./continuationClosure";
import { APPLY_FAILURE_BLOCK_PREFIX } from "../constants";
import { sha256 } from "../protocol/canonical";
export type ChatCompatibilityTarget = Pick<CompatibilityReport, "cursorVersion" | "vscodeVersion" | "extensionVersion" | "cursorDataSchema">;

export function chatCompatibilityTargetFingerprint(local: ChatCompatibilityTarget): string {
  return sha256(JSON.stringify([local.cursorVersion, local.vscodeVersion, local.extensionVersion, local.cursorDataSchema ?? null]));
}

export function isVersionCompatibilityBlock(reason: string): boolean {
  if (reason.startsWith(`${APPLY_FAILURE_BLOCK_PREFIX}: `)) reason = reason.slice(APPLY_FAILURE_BLOCK_PREFIX.length + 2);
  return ["Created by newer ", "Unable to compare the incoming ", "The installed Cursor cannot read ", "Cross-version chat "].some(prefix => reason.startsWith(prefix));
}

export function requiresCrossVersionInspection(producer: EventProducer | undefined, local: ChatCompatibilityTarget): boolean {
  return producer !== undefined && (([
    [producer.cursorVersion, local.cursorVersion], [producer.vscodeVersion, local.vscodeVersion], [producer.extensionVersion, local.extensionVersion],
  ] as const).some(([incoming, current]) => (compareVersions(incoming, current) ?? 1) > 0) ||
    (producer.cursorVersion !== local.cursorVersion && canInspectChatCompatibility(producer, local)));
}

function schemas(producer: EventProducer, local: Pick<CompatibilityReport, "cursorVersion" | "cursorDataSchema">): [CursorSchemaSnapshot, CursorSchemaSnapshot] {
  const source = producer.cursorDataSchema ?? (legacySchemas as Record<string, string>)[producer.cursorVersion];
  // A target always comes from its installed files, never from a publisher's claim.
  if (source === undefined || local.cursorDataSchema === undefined) throw new Error("Source or installed Cursor data schema is unavailable");
  return [decodeCursorDataSchema(source), decodeCursorDataSchema(local.cursorDataSchema)];
}

export function canInspectChatCompatibility(producer: EventProducer | undefined, local: Pick<CompatibilityReport, "cursorVersion" | "cursorDataSchema">): boolean {
  if (producer === undefined) return false;
  try { schemas(producer, local); return true; } catch { return false; }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function chatCompatibilityFieldObserver(producer: EventProducer, local: Pick<CompatibilityReport, "cursorVersion" | "cursorDataSchema">): { onField: NonNullable<AgentKvWalkOptions["onField"]>; reason: () => string | null } {
  const [source, target] = schemas(producer, local);
  const checked = new Set<string>();
  let failure: string | null = null;
  const identicalTypes = new Map<string, boolean>();
  let inspectedBytes = 0;
  let inspectedFields = 0;
  const sameOpaqueType = (name: string, visiting = new Set<string>()): boolean => {
    if (visiting.size >= 256) return false;
    if (visiting.has(name)) return true;
    visiting.add(name);
    const a = source.messages[name] ?? source.enums?.[name], b = target.messages[name] ?? target.enums?.[name];
    if (a === undefined || b === undefined || canonical(a) !== canonical(b)) return false;
    return a.every(field => Object.entries(field).every(([key, value]) => {
      if (key === "T" && typeof value === "string") return sameOpaqueType(value, visiting);
      if (key === "V" && value !== null && typeof value === "object" && "T" in value && typeof value.T === "string") return sameOpaqueType(value.T, visiting);
      return true;
    }));
  };
  const identicalType = (name: string): boolean => {
    let identical = identicalTypes.get(name);
    if (identical === undefined) { identical = sameOpaqueType(name); identicalTypes.set(name, identical); }
    return identical;
  };
  const inspectEnum = (name: string, value: bigint): boolean => {
    const no = Number(BigInt.asIntN(32, value));
    const a = source.enums?.[name]?.find(f => f.no === no), b = target.enums?.[name]?.find(f => f.no === no);
    if (a === undefined || b === undefined || canonical(a) !== canonical(b)) {
      failure = `The installed Cursor cannot read ${name} value ${no} with the source enum definition`;
      return false;
    }
    return true;
  };
  const inspectField = (field: CursorField, wire: number, payload: Uint8Array | undefined, depth: number, value?: bigint): boolean => {
    if (!["message", "map", "enum", "scalar"].includes(field.kind) ||
      (field.kind === "scalar" && ![1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 15, 16, 17, 18].includes(Number(field.T)))) return false;
    const expectedWire = field.kind === "message" || field.kind === "map" ? 2 : field.kind === "enum" ? 0 :
      [1, 6, 16].includes(Number(field.T)) ? 1 : [2, 7, 15].includes(Number(field.T)) ? 5 : [9, 12].includes(Number(field.T)) ? 2 : 0;
    if (wire !== expectedWire && !(wire === 2 && field.repeated === true && expectedWire !== 2)) return false;
    if (field.kind === "message") return typeof field.T === "string" && payload !== undefined && inspectMessage(field.T, payload, depth);
    if (field.kind === "enum") {
      if (typeof field.T !== "string") return false;
      if (identicalType(field.T)) return true;
      if (wire === 0) return value !== undefined && inspectEnum(field.T, value);
      if (payload === undefined) return false;
      let offset = 0;
      while (offset < payload.byteLength) {
        const entry = readVarint(payload, offset);
        if (entry === undefined || ++inspectedFields > 1_000_000 || !inspectEnum(field.T, entry.value)) return false;
        offset = entry.nextOffset;
      }
      return true;
    }
    if (field.kind !== "map") {
      if (wire !== 2 || expectedWire === 2) return true;
      if (payload === undefined) return false;
      if (expectedWire === 1 || expectedWire === 5) return payload.byteLength % (expectedWire === 1 ? 8 : 4) === 0;
      let offset = 0;
      while (offset < payload.byteLength) {
        const entry = readVarint(payload, offset);
        if (entry === undefined || ++inspectedFields > 1_000_000) return false;
        offset = entry.nextOffset;
      }
      return true;
    }
    if (payload === undefined) return false;
    const mapValue = field.V;
    if (typeof mapValue !== "object") return false;
    return scanProtobufMessage(payload, (no, entryWire, entryPayload, entryValue) => {
      if (++inspectedFields > 1_000_000) { failure = "Cross-version chat nested inspection exceeds its work limit"; return false; }
      if (no !== 1 && no !== 2) { failure = "Cross-version chat contains an unknown nested map field"; return false; }
      const descriptor = no === 1 ? { kind: "scalar", T: field.K } : mapValue;
      if (!inspectField({ ...descriptor, no, name: no === 1 ? "key" : "value" } as CursorField, entryWire, entryPayload, depth + 1, entryValue)) {
        failure ??= "Cross-version chat nested map data cannot be verified";
        return false;
      }
      return true;
    }) && failure === null;
  };
  const inspectMessage = (name: string, payload: Uint8Array, depth: number): boolean => {
    if (depth > 64 || (inspectedBytes += payload.byteLength) > 128 * 1024 * 1024) return false;
    const a = source.messages[name], b = target.messages[name];
    if (a === undefined || b === undefined) return false;
    // Unused descriptor changes cannot make compatible stored bytes unreadable.
    return scanProtobufMessage(payload, (no, wire, bytes, value) => {
      if (++inspectedFields > 1_000_000) { failure = "Cross-version chat nested inspection exceeds its work limit"; return false; }
      const incoming = a.find(f => f.no === no), installed = b.find(f => f.no === no);
      if (incoming === undefined || installed === undefined || canonical(incoming) !== canonical(installed)) {
        failure = `The installed Cursor cannot read ${name}#${no} with the source field definition`;
        return false;
      }
      if (!inspectField(incoming, wire, bytes, depth + 1, value)) { failure ??= `Cross-version chat nested ${name}#${no} data cannot be verified`; return false; }
      return true;
    }) && failure === null;
  };
  return {
    reason: () => failure,
    onField(schema, no, wire, payload, value) {
      const name = schema === "selected-image-with-data" ? "agent.v1.SelectedImage.BlobIdWithData" : CURSOR_MESSAGE_NAMES[schema];
      const key = `${name}#${no}`;
      if (failure !== null) return;
      const a: CursorField | undefined = source.messages[name]?.find(f => f.no === no), b = target.messages[name]?.find(f => f.no === no);
      if (!checked.has(key)) {
        if (a === undefined || b === undefined || canonical(a) !== canonical(b)) { failure = `The installed Cursor cannot read ${key} with the source field definition`; return; }
        checked.add(key);
      }
      if (a === undefined) return;
      const action = schema === "selected-image-with-data" ? undefined : AGENT_KV_SCHEMAS[schema].fields[no]?.action;
      const traversed = action?.kind === "message" || action?.kind === "map-message" || action?.kind === "selected-image-with-data";
      if (!traversed) {
        const type = typeof a.T === "string" ? a.T : typeof a.V === "object" && typeof a.V.T === "string" ? a.V.T : undefined;
        if (type !== undefined && !identicalType(type) && !inspectField(a, wire, payload, 0, value)) {
          failure ??= `The installed Cursor cannot read the nested ${type} used by ${key}`;
        }
      }
    },
  };
}

export async function crossVersionChatBlockReason(content: Buffer, tip: Pick<ResourceTip, "metadata">, producer: EventProducer, local: ChatCompatibilityTarget): Promise<string | null> {
  try {
    const observer = chatCompatibilityFieldObserver(producer, local);
    const snapshot = parsePortableChatSnapshot(content);
    if (snapshot.schemaVersion !== 2) return "Cross-version chat requires a complete supported continuation snapshot";
    if (tip.metadata?.chatSnapshotSchemaVersion !== undefined && tip.metadata.chatSnapshotSchemaVersion !== snapshot.schemaVersion) return "Cross-version chat schema does not match its authenticated metadata";
    if (snapshot.agentKv.missingIds.length !== 0) return "Cross-version chat continuation data is missing";
    const closure = await verifyPortableChatContinuationClosure(snapshot, {
      limits: { maxNodes: 4096, maxBytes: 128 * 1024 * 1024 }, onField: observer.onField,
    });
    if (observer.reason() !== null) return observer.reason();
    if (closure.status !== "complete") return `Cross-version chat continuation cannot be verified: ${closure.reason}`;
    return null;
  } catch (error) {
    return `Cross-version chat compatibility cannot be verified: ${error instanceof Error ? error.message : String(error)}`;
  }
}
