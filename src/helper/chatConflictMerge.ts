import { prepareChatConflictResolution } from "../chat/conflictResolution";
import { EventReconciler } from "../protocol/reconciler";
import type { SyncRepository } from "../protocol/repository";
import { chatContinuationApplyBlockReason } from "../sync/chatContinuationPolicy";
import { absorbedCheckpointManifest } from "../sync/versionPolicy";
import { helperAcceptsChatProducer } from "./chatMigration";
import type { HelperRequest } from "./types";

/** Publish the same merge/latest policy after the final local export is safe. */
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
    const snapshot = await prepareChatConflictResolution(repository, conflict, {
      offline: true,
      tipsAllowed: (tips) => tips.every((tip) => helperAcceptsChatProducer(tip, request)),
      onWarning: (message) => warnings.push(message),
    }).catch((error: unknown) => {
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
