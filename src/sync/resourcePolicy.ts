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

export function resourceConfigurationBlockReason(
  kind: ResourceKind,
  options: ResourceSyncOptions,
): string | null {
  if (isChatResourceKind(kind) && !options.syncChat) {
    return "Chat synchronization is disabled in settings.";
  }
  if (kind === "workspace-storage" && !options.syncWorkspaceStorage) {
    return "workspaceStorage synchronization is disabled in settings.";
  }
  return null;
}
