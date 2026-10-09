import type { CompatibilityReport, EventProducer, ResourceTip } from "../types";
import type { CursorField, CursorSchemaSnapshot } from "../monitor/cursorSchema";
import legacySchemas from "../platform/legacyCursorSchemas.json";
import { decodeCursorDataSchema } from "../platform/cursorDataSchema";
import { compareVersions } from "../platform/compatibility";
import { AGENT_KV_SCHEMAS, type AgentKvWalkOptions } from "./agentKv";
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
  return {
    reason: () => failure,
    onField(schema, no) {
      const name = schema === "selected-image-with-data" ? "agent.v1.SelectedImage.BlobIdWithData" : CURSOR_MESSAGE_NAMES[schema];
      const key = `${name}#${no}`;
      if (checked.has(key) || failure !== null) return;
      checked.add(key);
      const a: CursorField | undefined = source.messages[name]?.find(f => f.no === no), b = target.messages[name]?.find(f => f.no === no);
      if (a === undefined || b === undefined || canonical(a) !== canonical(b)) { failure = `The installed Cursor cannot read ${key} with the source field definition`; return; }
      const action = schema === "selected-image-with-data" ? undefined : AGENT_KV_SCHEMAS[schema].fields[no]?.action;
      const traversed = action?.kind === "message" || action?.kind === "map-message" || action?.kind === "selected-image-with-data";
      if (!traversed) {
        const type = typeof a.T === "string" ? a.T : typeof a.V === "object" && typeof a.V.T === "string" ? a.V.T : undefined;
        if (type !== undefined && !sameOpaqueType(type)) failure = `The installed Cursor cannot read the nested ${type} used by ${key}`;
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
