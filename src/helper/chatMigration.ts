import {
  buildChatTipEnrichmentCandidateIndex,
  enrichCurrentChatTipsFromLiveDatabase,
} from "../chat/enrichment";
import { MAX_HELPER_SINGLE_CHAT_BYTES } from "../constants";
import { compareVersions } from "../platform/compatibility";
import { EventReconciler } from "../protocol/reconciler";
import type { SyncRepository } from "../protocol/repository";
import { absorbedCheckpointManifest, effectiveTipProducer } from "../sync/versionPolicy";
import { chatContinuationApplyBlockReason } from "../sync/chatContinuationPolicy";
import type { ResourceTip } from "../types";
import type { HelperRequest } from "./types";

export function helperAcceptsChatProducer(tip: ResourceTip, request: HelperRequest): boolean {
  const producer = effectiveTipProducer(tip);
  return producer !== undefined && ([
    [producer.extensionVersion, request.extensionVersion],
    [producer.cursorVersion, request.expectedCursorVersion],
    [producer.vscodeVersion, request.expectedVscodeVersion],
  ] as const).every(([incoming, local]) => {
    const comparison = compareVersions(incoming, local);
    return comparison !== null && comparison <= 0;
  });
}

/** Each authenticated source is attempted once; no payload survives into the next iteration. */
export async function migrateOfflineChatTips(
  repository: SyncRepository,
  request: HelperRequest,
  beforeCandidate: () => Promise<void>,
  heartbeat: () => void,
): Promise<{ published: number; warnings: string[] }> {
  const warnings: string[] = [];
  const publishedIds = new Set<string>();
  const candidates = buildChatTipEnrichmentCandidateIndex(repository.state.tips);
  for (const candidate of candidates) {
    if (!helperAcceptsChatProducer(candidate.tip, request)) {
      continue;
    }
    await beforeCandidate();
    const result = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      request.paths.globalDatabase,
      {
        offline: true,
        cursor: { afterResourceId: null },
        candidateIndex: [candidate],
        batchSize: 1,
        maxPayloadBytes: Math.min(request.syncOptions.maxPayloadBytes, MAX_HELPER_SINGLE_CHAT_BYTES),
        tipAllowed: (tip) => helperAcceptsChatProducer(tip, request),
      },
    ).catch((error: unknown) => {
      warnings.push(`Offline chat migration for ${candidate.resourceId} was deferred: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    heartbeat();
    if (result === null) {
      continue;
    }
    warnings.push(...result.warnings);
    for (const id of result.publishedResourceIds) {
      publishedIds.add(id);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (publishedIds.size > 0) {
    const checkpoint = await absorbedCheckpointManifest(repository);
    const reconciled = new EventReconciler().reconcile(
      await repository.listReconciliationEvents(checkpoint), repository.state, checkpoint,
    );
    const conflicts = new Set(reconciled.conflicts.map((item) => item.resourceId));
    for (const { resourceId, tip } of reconciled.projections) {
      if (!publishedIds.has(resourceId) || conflicts.has(resourceId)) {
        continue;
      }
      repository.state.pendingDatabaseChanges = repository.state.pendingDatabaseChanges.filter(
        (pending) => pending.resourceId !== resourceId,
      );
      const blockedReason = chatContinuationApplyBlockReason(tip);
      repository.state.pendingDatabaseChanges.push({
        resourceId,
        kind: tip.kind,
        eventHash: tip.eventHash,
        changeIndex: tip.changeIndex,
        ...(blockedReason === undefined ? {} : { blockedReason }),
      });
    }
    await repository.saveState();
    await repository.writeAck();
  }
  return { published: publishedIds.size, warnings };
}
