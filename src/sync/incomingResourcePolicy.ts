import { isSyncableComposerId } from "../chat/stateVscdb";
import { isPolicyExcludedUiStateKey } from "../resources/uiStatePolicy";
import type { ResourceKind, ResourceTip } from "../types";

export function isOfflineApplyExcludedIncomingResource(
  resourceId: string,
  kind: ResourceKind,
  metadata: ResourceTip["metadata"],
): boolean {
  return (
    isPolicyExcludedUiStateResource(resourceId, kind) ||
    isUnscannableIncomingResource(resourceId, kind, metadata)
  );
}

export function isUnscannableIncomingResource(
  resourceId: string,
  kind: ResourceKind,
  metadata: ResourceTip["metadata"],
): boolean {
  if (kind === "workspace-storage") {
    return typeof metadata?.workspaceUri !== "string";
  }
  if (kind !== "chat") {
    return false;
  }
  const prefix = "chat/";
  if (!resourceId.startsWith(prefix)) {
    return false;
  }
  let composerId: string;
  try {
    composerId = decodeURIComponent(resourceId.slice(prefix.length));
  } catch {
    return false;
  }
  return !isSyncableComposerId(composerId);
}

export function isPolicyExcludedUiStateResource(
  resourceId: string,
  kind: ResourceKind,
): boolean {
  const prefix = "ui-state/";
  if (kind !== "ui-state" || !resourceId.startsWith(prefix)) {
    return false;
  }
  let key: string;
  try {
    key = decodeURIComponent(resourceId.slice(prefix.length));
  } catch {
    return true;
  }
  return isPolicyExcludedUiStateKey(key);
}
