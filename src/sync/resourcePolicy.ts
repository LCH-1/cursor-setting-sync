import type { ResourceKind } from "../types";

const CHAT_RESOURCE_KINDS = new Set<ResourceKind>([
  "chat",
  "chat-transcript",
  "chat-store",
]);

export interface ResourceSyncOptions {
  syncChat: boolean;
  syncWorkspaceStorage: boolean;
}

export function isChatResourceKind(kind: ResourceKind): boolean {
  return CHAT_RESOURCE_KINDS.has(kind);
}

/**
 * Reasons that describe a standing decision this computer has made, rather than
 * something that is about to resolve.
 *
 * A queued change is normally a promise: it is going to be written, and the
 * status bar says so. These are the opposite - the change is here, it is
 * understood, and it is never being written while the setting stands. Counting
 * them as "deferred" alongside a compatibility hold made a correctly configured
 * computer report "234 change(s) are deferred", which reads as a backlog and a
 * problem when it is neither: on the real pair those were the other machine's
 * 193 local-only folders, held back by exactly the policy that is supposed to
 * hold them back.
 */
export const PERMANENT_EXCLUSION_REASONS = [
  "Chat synchronization is disabled in settings.",
  "workspaceStorage synchronization is disabled in settings.",
  "This workspace is excluded by cursorSettingSync.ignoredWorkspaces on this computer.",
  "This workspace storage belongs to a window with no folder open, so it has no counterpart on this computer.",
] as const;

/** True for a hold that only a settings change will lift. */
export function isPermanentExclusionReason(reason: string | undefined): boolean {
  return (
    reason !== undefined &&
    (PERMANENT_EXCLUSION_REASONS as readonly string[]).includes(reason)
  );
}

export function resourceConfigurationBlockReason(
  kind: ResourceKind,
  options: ResourceSyncOptions,
): string | null {
  if (isChatResourceKind(kind) && !options.syncChat) {
    return PERMANENT_EXCLUSION_REASONS[0];
  }
  if (kind === "workspace-storage" && !options.syncWorkspaceStorage) {
    return PERMANENT_EXCLUSION_REASONS[1];
  }
  return null;
}
