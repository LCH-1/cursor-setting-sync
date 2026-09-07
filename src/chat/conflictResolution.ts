import { MAX_HELPER_SINGLE_CHAT_BYTES, MAX_PARENTS_PER_CHANGE } from "../constants";
import { compareCodeUnits, sha256 } from "../protocol/canonical";
import { compareTips } from "../protocol/reconciler";
import type { ResourceVersionMetadata, ResourceVersionOrdering, SyncRepository } from "../protocol/repository";
import { effectiveSyncOrigin } from "../sync/versionPolicy";
import type { JsonValue, ResourceSnapshot, ResourceTip, SyncConflict } from "../types";
import {
  CHAT_AUTO_MERGE_MAX_WORK_BYTES,
  CHAT_OFFLINE_MERGE_MAX_WORK_BYTES,
  buildChatContinuationCandidate,
  isPortableChatCoreUsable,
  mergeChatSnapshotBuffers,
  mergeOfflineChatSnapshotBuffers,
} from "./chatMerge";
import { verifyPortableChatContinuationClosure } from "./continuationClosure";
import { parsePortableChatSnapshot, portableChatCoreHash, type PortableChatSnapshot } from "./stateVscdb";
import { chatHeaderTitle } from "./title";

const MAX_RESOLUTION_SOURCES = 16;
const MAX_ORIGIN_VERSIONS = 64;

interface ResolutionOptions {
  offline: boolean;
  tipsAllowed(tips: ResourceTip[]): boolean;
  onWarning?(message: string): void;
}

interface Candidate {
  tip: ResourceTip;
  data: ResourceVersionMetadata;
  origin: ResourceVersionOrdering;
  content?: Buffer;
  snapshot?: PortableChatSnapshot;
}

/** Both execution modes use one policy; a work-limit refusal stays offline work. */
export async function prepareChatConflictResolution(
  repository: SyncRepository,
  conflict: SyncConflict,
  options: ResolutionOptions,
): Promise<ResourceSnapshot | null> {
  const tips = [...(repository.state.tips[conflict.resourceId] ?? [])].sort(compareTips);
  if (tips.length < 2 || tips.length > MAX_PARENTS_PER_CHANGE ||
    !options.tipsAllowed(tips) || tips.some(tip =>
      tip.kind !== "chat" || tip.operation !== "put" || !supportsResolution(tip.metadata))) {
    return null;
  }
  const unique = [...new Map([...tips].reverse().map(tip => [tip.semanticHash, tip])).values()]
    .sort(compareTips);
  const maxInput = Math.min(repository.maxPayloadBytes,
    options.offline ? MAX_HELPER_SINGLE_CHAT_BYTES : CHAT_AUTO_MERGE_MAX_WORK_BYTES);
  const workBytes = options.offline ? CHAT_OFFLINE_MERGE_MAX_WORK_BYTES : maxInput;
  const metadata = new Map<string, ResourceVersionMetadata | null>();
  const origins = new Map<string, ResourceVersionOrdering | null>();
  const readMetadata = async (version: string): Promise<ResourceVersionMetadata | null> => {
    if (!metadata.has(version)) {
      if (metadata.size >= MAX_ORIGIN_VERSIONS) {
        throw new Error("Chat resolution origin history exceeds its bounded lookup limit.");
      }
      metadata.set(version, await repository.tryReadVersionMetadata(version));
    }
    return metadata.get(version) ?? null;
  };
  const candidates: Candidate[] = [];
  for (const tip of unique) {
    const data = await readMetadata(tip.versionId);
    if (data === null || data.change.resourceId !== conflict.resourceId ||
      data.change.kind !== "chat" || data.change.operation !== "put" ||
      data.change.semanticHash !== tip.semanticHash) {
      return null;
    }
    const origin = await originalOrdering(data, orderingOfTip(tip), conflict.resourceId, readMetadata, new Set(), origins);
    if (origin === null) {
      options.onWarning?.(`Chat ${conflict.resourceId} is waiting for authenticated original version ordering.`);
      return null;
    }
    candidates.push({ tip, data, origin });
  }
  candidates.sort((left, right) => compareOrdering(left.origin, right.origin) || compareTips(left.tip, right.tip));
  const latest = candidates[0];
  if (latest === undefined) {
    return null;
  }
  const baseData = conflict.baseVersionId === null ? null : await readMetadata(conflict.baseVersionId);
  const baseUsable = conflict.baseVersionId === null || (baseData !== null &&
    baseData.change.resourceId === conflict.resourceId && baseData.change.kind === "chat" &&
    baseData.change.operation === "put");
  const sourceSizes = candidates.map(candidate => candidate.data.change.payload?.plainBytes);
  const baseBytes = conflict.baseVersionId === null ? 0 : baseData?.change.payload?.plainBytes;
  const canAttemptMerge = baseUsable && candidates.length <= MAX_RESOLUTION_SOURCES &&
    declaredInputsFit([...sourceSizes, baseBytes], maxInput, workBytes);
  if (baseUsable && !canAttemptMerge && !options.offline &&
    (!declaredInputsFit([...sourceSizes, baseBytes], maxInput, workBytes) || candidates.length > MAX_RESOLUTION_SOURCES)) {
    options.onWarning?.(`Chat ${conflict.resourceId} exceeds the interactive merge work limit; the offline helper will merge it or retain its latest version.`);
    return null;
  }
  const load = async (candidate: Candidate): Promise<boolean> => {
    if (candidate.content !== undefined) {
      return true;
    }
    if (!declaredInputsFit([candidate.data.change.payload?.plainBytes], maxInput, maxInput)) {
      return false;
    }
    const data = await repository.tryReadVersion(candidate.tip.versionId).catch(() => null);
    if (data?.content === null || data?.content === undefined ||
      data.content.byteLength > maxInput || data.content.byteLength !== candidate.data.change.payload?.plainBytes ||
      sha256(data.content) !== candidate.tip.semanticHash) {
      return false;
    }
    let snapshot: PortableChatSnapshot;
    try {
      snapshot = parsePortableChatSnapshot(data.content);
    } catch {
      return false;
    }
    if (`chat/${snapshot.composerId}` !== conflict.resourceId || !isPortableChatCoreUsable(snapshot, maxInput) ||
      (candidate.data.change.metadata?.chatResolutionOrigin !== undefined &&
        candidate.data.change.metadata.chatResolutionCoreHash !== portableChatCoreHash(snapshot))) {
      return false;
    }
    if (snapshot.schemaVersion === 2) {
      const closure = await verifyPortableChatContinuationClosure(snapshot);
      if (closure.status === "invalid" || closure.status === "unknown") {
        return false;
      }
    }
    candidate.content = data.content;
    candidate.snapshot = snapshot;
    return true;
  };
  if (canAttemptMerge) {
    let loaded = true;
    for (const candidate of candidates) {
      if (!(await load(candidate))) {
        loaded = false;
      }
    }
    let base: Buffer | null = null;
    if (loaded && conflict.baseVersionId !== null) {
      const data = await repository.tryReadVersion(conflict.baseVersionId).catch(() => null);
      if (data?.content === null || data?.content === undefined ||
        data.content.byteLength !== baseBytes || sha256(data.content) !== baseData?.change.semanticHash) {
        loaded = false;
      } else {
        base = data.content;
      }
    }
    if (loaded) {
      let content: Buffer | undefined = latest.content;
      let inherited = latest.tip.metadata;
      for (const candidate of candidates.slice(1)) {
        if (content === undefined) {
          break;
        }
        const result = options.offline
          ? mergeOfflineChatSnapshotBuffers(base, [content, candidate.content!])
          : mergeChatSnapshotBuffers(base, [content, candidate.content!], maxInput);
        content = result.content;
        if (result.winner === 1) {
          inherited = candidate.tip.metadata;
        }
      }
      if (content !== undefined && content.byteLength <= maxInput) {
        const snapshot = parsePortableChatSnapshot(content);
        const exact = candidates.find(candidate => candidate.content!.equals(content));
        const keepsContract = exact !== undefined || candidates.every(candidate =>
          effectiveSyncOrigin(candidate.tip.metadata) !== "agent-kv-enrichment" ||
          candidate.tip.metadata?.agentKvEnrichmentAppliesCore === true);
        const closure = snapshot.schemaVersion === 2 ? await verifyPortableChatContinuationClosure(snapshot) : null;
        const complete = snapshot.schemaVersion === 2 && snapshot.agentKv.missingIds.length === 0 &&
          closure?.status === "complete";
        const preservesLatestCore = exact !== undefined && snapshot.schemaVersion === 2 &&
          (closure?.status === "complete" || closure?.status === "incomplete") &&
          latest.snapshot !== undefined && portableChatCoreHash(snapshot) === portableChatCoreHash(latest.snapshot);
        if (keepsContract && (complete || preservesLatestCore) && isPortableChatCoreUsable(snapshot, maxInput)) {
          return resolutionSnapshot(conflict.resourceId, tips, content, snapshot,
            exact?.tip.metadata ?? inherited, exact?.origin ?? latest.origin, "merged", exact !== undefined);
        }
      }
    }
  }
  if (!(await load(latest))) {
    options.onWarning?.(`Chat ${conflict.resourceId} could not validate its latest version; the original forks remain available.`);
    return null;
  }
  if (canAttemptMerge && (effectiveSyncOrigin(latest.tip.metadata) !== "agent-kv-enrichment" ||
    latest.tip.metadata?.agentKvEnrichmentAppliesCore === true)) {
    const sources = candidates.flatMap(candidate => candidate.snapshot === undefined ? [] : [candidate.snapshot]);
    const content = buildChatContinuationCandidate(latest.snapshot!, sources, maxInput);
    if (content !== null) {
      const snapshot = parsePortableChatSnapshot(content);
      if (snapshot.schemaVersion === 2 && snapshot.agentKv.missingIds.length === 0 &&
        portableChatCoreHash(snapshot) === portableChatCoreHash(latest.snapshot!) &&
        (await verifyPortableChatContinuationClosure(snapshot)).status === "complete") {
        return resolutionSnapshot(conflict.resourceId, tips, content, snapshot,
          latest.tip.metadata, latest.origin, "latest", content.equals(latest.content!));
      }
    }
  }
  return resolutionSnapshot(conflict.resourceId, tips, latest.content!, latest.snapshot!,
    latest.tip.metadata, latest.origin, "latest", true);
}

function resolutionSnapshot(
  resourceId: string,
  tips: ResourceTip[],
  content: Buffer,
  snapshot: PortableChatSnapshot,
  inherited: Record<string, JsonValue> | undefined,
  origin: ResourceVersionOrdering,
  strategy: "merged" | "latest",
  exact: boolean,
): ResourceSnapshot {
  const preserveRecipe = exact && effectiveSyncOrigin(inherited) === "agent-kv-enrichment";
  const metadata = chatMetadataForExactSnapshot(inherited, snapshot);
  for (const key of ["checkpointedSyncOrigin", "checkpointedVersionId", "checkpointedProducer", "checkpointedSourceDeviceId"]) {
    delete metadata[key];
  }
  return {
    resourceId, kind: "chat", content, semanticHash: sha256(content),
    parents: tips.map(tip => tip.versionId).sort(),
    metadata: {
      ...metadata,
      syncOrigin: preserveRecipe ? "agent-kv-enrichment" : "auto-merge",
      chatResolutionStrategy: strategy,
      chatResolutionOrigin: { ...origin },
      chatResolutionCoreHash: portableChatCoreHash(snapshot),
    },
  };
}

export function chatMetadataForExactSnapshot(
  inherited: Record<string, JsonValue> | undefined,
  snapshot: PortableChatSnapshot,
): Record<string, JsonValue> {
  const metadata = { ...inherited };
  for (const key of ["composerId", "workspaceId", "lastUpdatedAt", "bubbleCount", "title",
    "chatCoreHash", "chatSnapshotSchemaVersion", "agentKvBlobCount", "agentKvReferencedCount", "agentKvMissingCount"]) {
    delete metadata[key];
  }
  Object.assign(metadata, {
    composerId: snapshot.composerId, workspaceId: snapshot.header.workspaceId,
    lastUpdatedAt: snapshot.header.lastUpdatedAt, bubbleCount: snapshot.bubbles.length,
    chatCoreHash: portableChatCoreHash(snapshot), chatSnapshotSchemaVersion: snapshot.schemaVersion,
  });
  if (snapshot.schemaVersion === 2) {
    Object.assign(metadata, { agentKvBlobCount: snapshot.agentKv.blobs.length,
      agentKvReferencedCount: snapshot.agentKv.referencedIds.length, agentKvMissingCount: snapshot.agentKv.missingIds.length });
  }
  const title = chatHeaderTitle(snapshot.header.value);
  if (title !== null) {
    metadata.title = title;
  }
  return metadata;
}

function declaredInputsFit(sizes: readonly (number | undefined)[], single: number, aggregate: number): boolean {
  let remaining = aggregate;
  for (const size of sizes) {
    if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > single || size > remaining) {
      return false;
    }
    remaining -= size;
  }
  return true;
}

function supportsResolution(metadata: Record<string, JsonValue> | undefined): boolean {
  const origin = effectiveSyncOrigin(metadata);
  return origin === undefined || origin === "auto-merge" || origin === "conflict-resolution" ||
    origin === "agent-kv-enrichment" || origin === "agent-kv-recapture" || origin === "checkpoint-marker";
}

function orderingOfTip(tip: ResourceTip): ResourceVersionOrdering {
  return { versionId: tip.versionId, eventHash: tip.eventHash, lamport: tip.lamport, deviceId: tip.deviceId,
    ...(tip.createdAt === undefined ? {} : { createdAt: tip.createdAt }) };
}

function compareOrdering(left: ResourceVersionOrdering, right: ResourceVersionOrdering): number {
  return right.lamport - left.lamport || compareCodeUnits(right.deviceId, left.deviceId) ||
    compareCodeUnits(right.eventHash, left.eventHash) || compareCodeUnits(right.versionId, left.versionId);
}

async function originalOrdering(
  data: ResourceVersionMetadata,
  own: ResourceVersionOrdering,
  resourceId: string,
  read: (version: string) => Promise<ResourceVersionMetadata | null>,
  visiting: Set<string>,
  memo: Map<string, ResourceVersionOrdering | null>,
): Promise<ResourceVersionOrdering | null> {
  if (memo.has(own.versionId)) {
    return memo.get(own.versionId) ?? null;
  }
  if (visiting.has(own.versionId)) {
    return null;
  }
  const stored = parseOrdering(data.change.metadata?.chatResolutionOrigin);
  if (stored !== null && stored.lamport <= own.lamport &&
    typeof data.change.metadata?.chatResolutionCoreHash === "string") {
    memo.set(own.versionId, stored);
    return stored;
  }
  if (data.change.metadata?.chatResolutionOrigin !== undefined) {
    return null;
  }
  const origin = effectiveSyncOrigin(data.change.metadata);
  const marker = data.change.metadata?.syncOrigin === "checkpoint-marker";
  if (!marker && origin !== "agent-kv-enrichment" && origin !== "auto-merge") {
    const result = data.ordering ?? own;
    memo.set(own.versionId, result);
    return result;
  }
  visiting.add(own.versionId);
  const enriched = data.change.metadata?.enrichedFromVersionId;
  const checkpointed = data.change.metadata?.checkpointedVersionId;
  const parents = marker
    ? typeof checkpointed === "string" ? [checkpointed] : []
    : origin === "agent-kv-enrichment" && typeof enriched === "string"
      ? [enriched] : data.change.parents;
  const originals: ResourceVersionOrdering[] = [];
  const parentData: ResourceVersionMetadata[] = [];
  for (const version of parents) {
    const parent = await read(version);
    if (parent === null || parent.change.resourceId !== resourceId || parent.change.kind !== "chat" ||
      parent.ordering === undefined) {
      return null;
    }
    parentData.push(parent);
  }
  const exactParents = origin === "auto-merge" && !marker
    ? parentData.filter(parent => parent.change.semanticHash === data.change.semanticHash)
    : [];
  const coreHash = data.change.metadata?.chatCoreHash;
  const coreParents = origin === "auto-merge" && !marker && typeof coreHash === "string" && /^[a-f0-9]{64}$/.test(coreHash)
    ? parentData.filter(parent => parent.change.metadata?.chatCoreHash === coreHash ||
      (parent.change.metadata?.chatSnapshotSchemaVersion === 1 && parent.change.semanticHash === coreHash))
    : [];
  const contributors = exactParents.length > 0 ? exactParents : coreParents.length > 0 ? coreParents : parentData;
  for (const parent of contributors) {
    const result = await originalOrdering(parent, parent.ordering!, resourceId, read, visiting, memo);
    if (result === null) {
      return null;
    }
    originals.push(result);
  }
  visiting.delete(own.versionId);
  const result = originals.sort(compareOrdering)[0] ?? null;
  memo.set(own.versionId, result);
  return result;
}

function parseOrdering(value: JsonValue | undefined): ResourceVersionOrdering | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { versionId, eventHash, deviceId, lamport, createdAt } = value;
  if (typeof versionId !== "string" || !/^[a-f0-9]{64}#\d+$/.test(versionId) ||
    typeof eventHash !== "string" || !versionId.startsWith(`${eventHash}#`) ||
    typeof deviceId !== "string" || deviceId.length === 0 ||
    typeof lamport !== "number" || !Number.isSafeInteger(lamport) || lamport < 1 ||
    (createdAt !== undefined && (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))))) {
    return null;
  }
  return { versionId, eventHash, deviceId, lamport, ...(createdAt === undefined ? {} : { createdAt }) };
}
