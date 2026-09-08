import { MAX_HELPER_SINGLE_CHAT_BYTES } from "../constants";
import { sha256 } from "../protocol/canonical";
import type { ResourceVersionMetadata, SyncRepository } from "../protocol/repository";
import type { JsonValue, ResourceTip } from "../types";
import { hasIndependentChatOrdering, readOriginalChatOrdering } from "./conflictResolution";
import { verifyPortableChatContinuationClosure } from "./continuationClosure";
import { parsePortableChatSnapshot, portableChatCoreHash } from "./stateVscdb";

export const CHAT_CHECKPOINT_MAX_WORK_BYTES = 256 * 1024 * 1024;
const MAX_METADATA_READS = 512;
const MAX_CACHED_CORES = 1_024;

export interface ChatCheckpointCoreInspection {
  coreHash: string;
  continuationComplete: boolean;
}

export interface ChatCheckpointWorkBudget {
  remainingBytes: number;
  remainingMetadataReads: number;
  metadata: Map<string, ResourceVersionMetadata | null>;
  authenticatedPayloads: Map<string, ChatCheckpointCoreInspection>;
}

export interface ChatCheckpointSafety {
  metadata: Record<string, JsonValue> | undefined;
  preserveHistory: boolean;
  reason?: "work-limit" | "unreadable-core" | "dependent-origin" | "incomplete-continuation";
}

export function createChatCheckpointWorkBudget(): ChatCheckpointWorkBudget {
  return { remainingBytes: CHAT_CHECKPOINT_MAX_WORK_BYTES, remainingMetadataReads: MAX_METADATA_READS,
    metadata: new Map(), authenticatedPayloads: new Map() };
}

export async function inspectChatCheckpointSafety(
  repository: SyncRepository,
  resourceId: string,
  tip: ResourceTip,
  budget: ChatCheckpointWorkBudget,
  cache: Map<string, ChatCheckpointCoreInspection>,
  captureOrigin: boolean,
): Promise<ChatCheckpointSafety> {
  if (tip.kind !== "chat" || tip.operation !== "put") {
    return { metadata: tip.metadata, preserveHistory: false };
  }
  const cacheKey = `${resourceId}:${tip.semanticHash}`;
  const payloadKey = `${cacheKey}:${tip.payload?.deviceId}:${tip.payload?.objectId}:${tip.payload?.plainBytes}:${tip.payload?.compressedBytes}`;
  let core = budget.authenticatedPayloads.get(payloadKey);
  if (core === undefined) {
    core = cache.get(cacheKey);
    const size = tip.payload?.plainBytes;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0 ||
      size > MAX_HELPER_SINGLE_CHAT_BYTES || size > budget.remainingBytes) {
      return { metadata: tip.metadata, preserveHistory: true, reason: "work-limit" };
    }
    budget.remainingBytes -= size;
    try {
      const content = await repository.readObject(tip.payload!);
      if (content.byteLength !== size || sha256(content) !== tip.semanticHash) {
        return { metadata: tip.metadata, preserveHistory: true, reason: "unreadable-core" };
      }
      if (core === undefined) {
        const snapshot = parsePortableChatSnapshot(content);
        if (`chat/${snapshot.composerId}` !== resourceId) {
          return { metadata: tip.metadata, preserveHistory: true, reason: "unreadable-core" };
        }
        const closure = await verifyPortableChatContinuationClosure(snapshot.schemaVersion === 2 ? snapshot : {
          ...snapshot, schemaVersion: 2, agentKv: { blobs: [], referencedIds: [], missingIds: [] },
        });
        core = { coreHash: portableChatCoreHash(snapshot), continuationComplete: closure.status === "complete" };
        if (cache.size >= MAX_CACHED_CORES) {
          cache.delete(cache.keys().next().value!);
        }
        cache.set(cacheKey, core);
      }
      budget.authenticatedPayloads.set(payloadKey, core);
    } catch {
      return { metadata: tip.metadata, preserveHistory: true, reason: "unreadable-core" };
    }
  }
  let metadata = tip.metadata;
  let independentOrigin = hasIndependentChatOrdering(tip, core.coreHash);
  if (!independentOrigin && metadata?.chatResolutionOrigin !== undefined) {
    return { metadata, preserveHistory: true, reason: "dependent-origin" };
  }
  if (captureOrigin && !independentOrigin) {
    const read = async (version: string): Promise<ResourceVersionMetadata | null> => {
      if (!budget.metadata.has(version)) {
        if (budget.remainingMetadataReads <= 0) {
          return null;
        }
        budget.remainingMetadataReads -= 1;
        budget.metadata.set(version, await repository.tryReadVersionMetadata(version).catch(() => null));
      }
      return budget.metadata.get(version) ?? null;
    };
    const origin = await readOriginalChatOrdering(resourceId, tip, read);
    if (origin !== null) {
      metadata = { ...metadata, chatResolutionOrigin: { ...origin }, chatResolutionCoreHash: core.coreHash };
      independentOrigin = true;
    }
  }
  if (!independentOrigin) {
    return { metadata, preserveHistory: true,
      reason: budget.remainingMetadataReads <= 0 ? "work-limit" : "dependent-origin" };
  }
  return core.continuationComplete ? { metadata, preserveHistory: false }
    : { metadata, preserveHistory: true, reason: "incomplete-continuation" };
}
