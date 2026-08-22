import type { ResourceTip } from "../types";
import { effectiveSyncOrigin } from "./versionPolicy";

/**
 * A renderable chat body is not necessarily resumable. Cursor's next turn also
 * needs the content-addressed continuation graph rooted by composerData and its
 * bubbles, so ordinary cross-device applies must wait for a complete v2
 * snapshot instead of materializing a legacy body that will fail on submit.
 */
export const INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON =
  'Waiting for a complete synchronized continuation snapshot. On a PC where this original chat can still continue, let automatic synchronization finish or open "Cursor Setting Sync: Manage" and choose "Sync & Apply Now".';

export function chatContinuationApplyBlockReason(
  tip: Pick<ResourceTip, "kind" | "operation" | "metadata">,
): string | undefined {
  const origin = effectiveSyncOrigin(tip.metadata);
  if (
    tip.kind !== "chat" ||
    tip.operation !== "put" ||
    origin === "automatic-chat-repair" ||
    (origin === "agent-kv-enrichment" &&
      tip.metadata?.agentKvEnrichmentAppliesCore !== true)
  ) {
    return undefined;
  }
  return tip.metadata?.chatSnapshotSchemaVersion === 2 &&
    tip.metadata.agentKvMissingCount === 0
    ? undefined
    : INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON;
}
