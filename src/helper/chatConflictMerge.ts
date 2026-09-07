import { CHAT_OFFLINE_MERGE_MAX_WORK_BYTES, mergeOfflineChatSnapshotBuffers } from "../chat/chatMerge";
import { MAX_HELPER_SINGLE_CHAT_BYTES } from "../constants";
import { sha256 } from "../protocol/canonical";
import { compareTips, EventReconciler } from "../protocol/reconciler";
import type { SyncRepository } from "../protocol/repository";
import { chatContinuationApplyBlockReason } from "../sync/chatContinuationPolicy";
import { absorbedCheckpointManifest } from "../sync/versionPolicy";
import type { ResourceSnapshot, ResourceTip, SyncConflict } from "../types";
import { helperAcceptsChatProducer } from "./chatMigration";
import type { HelperRequest } from "./types";

/** Prove that one existing payload contains the merge, preserving its apply contract. */
export async function mergeOfflineChatConflicts(
  repository: SyncRepository,
  request: HelperRequest,
  ensureExclusiveAccess: () => Promise<void>,
  heartbeat: () => void,
): Promise<{ published: number; warnings: string[] }> {
  const warnings: string[] = [];
  const checkpoint = await absorbedCheckpointManifest(repository);
  const reconciler = new EventReconciler();
  const reconciled = reconciler.reconcile(
    await repository.listReconciliationEvents(checkpoint), repository.state, checkpoint,
  );
  const publishedIds = new Set<string>();
  for (const conflict of reconciled.conflicts) {
    if (conflict.kind !== "chat" || conflict.resolvedAt !== undefined) {
      continue;
    }
    await ensureExclusiveAccess();
    const snapshot = await prepareMerge(repository, request, conflict).catch((error: unknown) => {
      warnings.push(`Offline chat merge for ${conflict.resourceId} was deferred: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    heartbeat();
    if (snapshot !== null) {
      await ensureExclusiveAccess();
      try {
        await repository.publish([snapshot], []);
        publishedIds.add(conflict.resourceId);
      } catch (error) {
        warnings.push(`Offline chat merge for ${conflict.resourceId} could not be published: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (publishedIds.size > 0) {
    const result = reconciler.reconcile(
      await repository.listReconciliationEvents(checkpoint), repository.state, checkpoint,
    );
    const conflicts = new Set(result.conflicts.map((conflict) => conflict.resourceId));
    for (const { resourceId, tip } of result.projections) {
      if (!publishedIds.has(resourceId) || conflicts.has(resourceId)) {
        continue;
      }
      repository.state.pendingDatabaseChanges = repository.state.pendingDatabaseChanges.filter(
        (pending) => pending.resourceId !== resourceId,
      );
      const blockedReason = chatContinuationApplyBlockReason(tip);
      repository.state.pendingDatabaseChanges.push({
        resourceId, kind: "chat", eventHash: tip.eventHash, changeIndex: tip.changeIndex,
        ...(blockedReason === undefined ? {} : { blockedReason }),
      });
    }
    await repository.saveState();
    await repository.writeAck();
  }
  return { published: publishedIds.size, warnings };
}

async function prepareMerge(
  repository: SyncRepository,
  request: HelperRequest,
  conflict: SyncConflict,
): Promise<ResourceSnapshot | null> {
  const currentTips = [...(repository.state.tips[conflict.resourceId] ?? [])].sort(compareTips);
  if (currentTips.length < 2 || currentTips.some((tip) =>
    tip.kind !== "chat" || tip.operation !== "put" ||
    !helperAcceptsChatProducer(tip, request) || !supportsExactMerge(tip))) {
    return null;
  }
  const distinct = new Map<string, ResourceTip>();
  for (const tip of currentTips) {
    if (!distinct.has(tip.semanticHash)) {
      distinct.set(tip.semanticHash, tip);
    }
  }
  const tips = [...distinct.values()];
  if (tips.length !== 2) {
    return null;
  }
  const versions = [tips[0]!.versionId, tips[1]!.versionId,
    ...(conflict.baseVersionId === null ? [] : [conflict.baseVersionId])];
  let remaining = CHAT_OFFLINE_MERGE_MAX_WORK_BYTES;
  for (const version of versions) {
    const { change } = await repository.readVersionMetadata(version);
    const bytes = change.payload?.plainBytes;
    if (change.resourceId !== conflict.resourceId || change.kind !== "chat" ||
      change.operation !== "put" || bytes === undefined ||
      !Number.isSafeInteger(bytes) || bytes <= 0 ||
      bytes > Math.min(repository.maxPayloadBytes, MAX_HELPER_SINGLE_CHAT_BYTES, remaining)) {
      return null;
    }
    remaining -= bytes;
  }
  const contents: Buffer[] = [];
  for (const version of versions) {
    const { content, change } = await repository.readVersion(version);
    if (content === null || sha256(content) !== change.semanticHash) {
      return null;
    }
    contents.push(content);
  }
  const merged = mergeOfflineChatSnapshotBuffers(contents[2] ?? null, [contents[0]!, contents[1]!]);
  if (merged.content === undefined || merged.content.byteLength > repository.maxPayloadBytes) {
    return null;
  }
  const survivorIndex = contents.slice(0, 2).findIndex((content) => content.equals(merged.content!));
  if (survivorIndex === -1) {
    // A novel union needs a new apply recipe. This path only republishes a
    // proven complete existing version, including blob-only enrichment rules.
    return null;
  }
  const survivor = tips[survivorIndex]!;
  return {
    resourceId: conflict.resourceId, kind: "chat", content: merged.content,
    semanticHash: survivor.semanticHash,
    parents: currentTips.map((tip) => tip.versionId).sort(),
    metadata: {
      ...survivor.metadata,
      syncOrigin: survivor.metadata?.syncOrigin === "agent-kv-enrichment"
        ? "agent-kv-enrichment" : "auto-merge",
    },
  };
}

function supportsExactMerge(tip: ResourceTip): boolean {
  const origin = tip.metadata?.syncOrigin;
  return origin === undefined || origin === "auto-merge" ||
    origin === "conflict-resolution" || origin === "agent-kv-enrichment";
}
