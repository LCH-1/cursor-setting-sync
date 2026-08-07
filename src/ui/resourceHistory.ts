import type { JsonValue, ResourceKind } from "../types";

const FUTURE_CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export interface RestoreResourceDescriptor {
  resourceId: string;
  kind: ResourceKind;
  metadata: Record<string, JsonValue> | undefined;
  sourceTimestamp: number | undefined;
  eventCreatedAt: string | undefined;
  blockedReason: string | null;
}

export interface RestoreKindChoice {
  resourceKind: ResourceKind;
  label: string;
  description: string;
  detail: string;
  blockedReason: string | null;
}

export interface RestoreResourceChoice {
  resourceId: string;
  resourceKind: ResourceKind;
  label: string;
  description: string;
  detail: string;
  blockedReason: string | null;
  updatedAt: number | null;
}

export interface RestoreScopeChoice {
  scopeKey: string;
  label: string;
  description: string;
  detail: string;
  resourceIds: string[];
  updatedAt: number | null;
}

export interface RestoreHistoryVersion {
  versionId: string;
  operation: "put" | "delete";
}

export interface RestoreTipIdentity {
  versionId: string;
  kind: ResourceKind;
}

interface KindPresentation {
  label: string;
  detail: string;
  priority: number;
}

interface ResourceChoiceOptions {
  now?: number;
  formatDate?: (timestamp: number) => string;
}

/** One row per resource kind, ordered by what people most often recover. */
export function buildRestoreKindChoices(
  resources: readonly RestoreResourceDescriptor[],
): RestoreKindChoice[] {
  const byKind = new Map<ResourceKind, RestoreResourceDescriptor[]>();
  for (const resource of resources) {
    const group = byKind.get(resource.kind) ?? [];
    group.push(resource);
    byKind.set(resource.kind, group);
  }
  return [...byKind].map(([kind, group]) => {
    const presentation = restoreKindPresentation(kind);
    const available = group.filter(
      (resource) => resource.blockedReason === null,
    ).length;
    const blockedReason = available === 0
      ? group[0]?.blockedReason ?? "No items of this type are currently available."
      : null;
    return {
      resourceKind: kind,
      label:
        blockedReason === null
          ? presentation.label
          : `$(circle-slash) ${presentation.label}`,
      description:
        available === group.length
          ? itemCount(group.length)
          : `${itemCount(group.length)} · ${available} currently available`,
      detail: presentation.detail,
      blockedReason,
    };
  }).sort((left, right) => {
    const priority =
      restoreKindPresentation(left.resourceKind).priority -
      restoreKindPresentation(right.resourceKind).priority;
    return priority !== 0 ? priority : compareText(left.label, right.label);
  });
}

/**
 * Human-readable rows for the second picker. The immutable resource ID stays
 * on the returned object for write decisions without filling the visible
 * detail line with its percent-encoded transport form.
 */
export function buildRestoreResourceChoices(
  resources: readonly RestoreResourceDescriptor[],
  options: ResourceChoiceOptions = {},
): RestoreResourceChoice[] {
  const now = options.now ?? Date.now();
  const formatDate = options.formatDate ?? ((timestamp: number) =>
    new Date(timestamp).toLocaleString());
  return resources.map((resource) => {
    const updatedAt = displayTimestamp(resource, now);
    const rendered = renderResource(resource, updatedAt, formatDate);
    return {
      resourceId: resource.resourceId,
      resourceKind: resource.kind,
      label:
        resource.blockedReason === null
          ? rendered.label
          : `$(circle-slash) ${rendered.label}`,
      description:
        resource.blockedReason === null
          ? rendered.description
          : resource.blockedReason,
      detail: rendered.detail,
      blockedReason: resource.blockedReason,
      updatedAt,
    };
  }).sort((left, right) => {
    if ((left.blockedReason === null) !== (right.blockedReason === null)) {
      return left.blockedReason === null ? -1 : 1;
    }
    const timeOrder = (right.updatedAt ?? -Infinity) - (left.updatedAt ?? -Infinity);
    if (timeOrder !== 0) {
      return timeOrder;
    }
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0
      ? labelOrder
      : compareText(left.resourceId, right.resourceId);
  });
}

/** Workspace/project narrowing for kinds that commonly contain hundreds of rows. */
export function buildRestoreScopeChoices(
  resources: readonly RestoreResourceDescriptor[],
  options: ResourceChoiceOptions = {},
): RestoreScopeChoice[] {
  const now = options.now ?? Date.now();
  const formatDate = options.formatDate ?? ((timestamp: number) =>
    new Date(timestamp).toLocaleString());
  const groups = new Map<
    string,
    { label: string; detail: string; resources: RestoreResourceDescriptor[] }
  >();
  for (const resource of resources) {
    const scope = resourceScope(resource);
    const group = groups.get(scope.key) ?? {
      label: scope.label,
      detail: scope.detail,
      resources: [],
    };
    group.resources.push(resource);
    groups.set(scope.key, group);
  }
  return [...groups].map(([scopeKey, group]) => {
    let updatedAt: number | null = null;
    for (const resource of group.resources) {
      const timestamp = displayTimestamp(resource, now);
      if (timestamp !== null && (updatedAt === null || timestamp > updatedAt)) {
        updatedAt = timestamp;
      }
    }
    return {
      scopeKey,
      label: group.label,
      description: compactParts([
        itemCount(group.resources.length),
        updatedAt === null ? null : `Latest ${formatDate(updatedAt)}`,
      ]),
      detail: group.detail,
      resourceIds: group.resources.map((resource) => resource.resourceId),
      updatedAt,
    };
  }).sort((left, right) => {
    const timeOrder = (right.updatedAt ?? -Infinity) - (left.updatedAt ?? -Infinity);
    if (timeOrder !== 0) {
      return timeOrder;
    }
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0 ? labelOrder : compareText(left.scopeKey, right.scopeKey);
  });
}

/** Keeps only non-current put versions that pass the caller's compatibility gate. */
export function restorablePutVersions<T extends RestoreHistoryVersion>(
  history: readonly T[],
  currentTipIds: ReadonlySet<string>,
  blockReason: (version: T) => string | null,
): T[] {
  return history.filter(
    (version) =>
      !currentTipIds.has(version.versionId) &&
      version.operation === "put" &&
      blockReason(version) === null,
  );
}

/** Final race check after a potentially long-lived picker closes. */
export function restoreTargetIsUnchanged(
  expectedTipIds: readonly string[],
  freshTips: readonly RestoreTipIdentity[],
  selectedKind: ResourceKind,
  conflicted: boolean,
): boolean {
  if (conflicted || freshTips.some((tip) => tip.kind !== selectedKind)) {
    return false;
  }
  const expected = [...expectedTipIds].sort(compareText);
  const fresh = freshTips.map((tip) => tip.versionId).sort(compareText);
  return expected.length === fresh.length &&
    fresh.every((versionId, index) => versionId === expected[index]);
}

export function restoreKindLabel(kind: ResourceKind): string {
  return restoreKindPresentation(kind).label;
}

function restoreKindPresentation(kind: ResourceKind): KindPresentation {
  switch (kind) {
    case "chat":
      return {
        label: "Cursor conversations",
        detail: "Main conversations shown in Cursor. Choose this for a missing chat.",
        priority: 0,
      };
    case "settings":
      return { label: "Settings", detail: "Editor and workbench settings.", priority: 10 };
    case "keybindings":
      return { label: "Keyboard shortcuts", detail: "User keybindings files.", priority: 11 };
    case "snippet":
      return { label: "Snippets", detail: "User and profile code snippets.", priority: 12 };
    case "task":
      return { label: "Tasks", detail: "User and profile task definitions.", priority: 13 };
    case "prompt":
      return { label: "Prompts", detail: "User and profile prompt files.", priority: 14 };
    case "mcp":
      return { label: "MCP configuration", detail: "User and profile MCP files.", priority: 15 };
    case "cursor-user-file":
      return { label: "Cursor user files", detail: "Rules, skills, and other synchronized user files.", priority: 16 };
    case "cursor-user-rules":
      return { label: "Cursor rules", detail: "Rules stored in Cursor's global database.", priority: 17 };
    case "extension":
      return { label: "Extensions", detail: "Installed, enabled, and pinned extension state.", priority: 20 };
    case "profile":
      return { label: "Profiles", detail: "Cursor profile definitions.", priority: 21 };
    case "remote-targets":
      return { label: "Remote SSH targets", detail: "Cursor's remembered remote targets.", priority: 22 };
    case "ui-state":
      return { label: "Historical UI state", detail: "Legacy synchronized UI-state entries.", priority: 70 };
    case "chat-transcript":
      return {
        label: "Agent transcripts",
        detail: "Raw agent-run transcript files, not the main Cursor conversation list.",
        priority: 80,
      };
    case "chat-store":
      return {
        label: "Chat data stores",
        detail: "Low-level chat database files. Usually restore Cursor conversations instead.",
        priority: 81,
      };
    case "workspace-storage":
      return {
        label: "Workspace data",
        detail: "Low-level state attached to a particular workspace.",
        priority: 82,
      };
  }
}

function renderResource(
  resource: RestoreResourceDescriptor,
  updatedAt: number | null,
  formatDate: (timestamp: number) => string,
): { label: string; description: string; detail: string } {
  const date = updatedAt === null ? null : formatDate(updatedAt);
  if (resource.kind === "chat") {
    return renderChat(resource, date);
  }
  if (resource.kind === "chat-transcript") {
    return renderTranscript(resource, date);
  }

  const metadata = resource.metadata;
  const workspace = workspaceLabel(metadataString(metadata, "workspaceUri"));
  const name = firstMetadataString(metadata, [
    "key",
    "extensionId",
    "relativePath",
    "profileName",
    "composerId",
    "workspaceId",
  ]) ?? decodedResourceSuffix(resource.resourceId);
  const profile = metadataString(metadata, "profileName") ??
    metadataString(metadata, "profileId");
  const version = metadataString(metadata, "version");
  const description = compactParts([
    workspace,
    profile === name ? null : profile,
    version === null ? null : `v${version}`,
    date === null ? null : `Updated ${date}`,
  ]);
  const decoded = decodedResourceSuffix(resource.resourceId);
  return {
    label: clip(name, 100),
    description: description.length === 0 ? restoreKindLabel(resource.kind) : description,
    detail: decoded,
  };
}

function resourceScope(resource: RestoreResourceDescriptor): {
  key: string;
  label: string;
  detail: string;
} {
  const metadata = resource.metadata;
  if (resource.kind === "chat" || resource.kind === "workspace-storage") {
    const uri = metadataString(metadata, "workspaceUri");
    const id = metadataString(metadata, "workspaceId");
    const identity = uri ?? id ?? "unknown-workspace";
    return {
      key: `${resource.kind}:${identity}`,
      label: workspaceLabel(uri) ?? (id === null ? "Unknown workspace" : clip(id, 80)),
      detail: uri ?? id ?? "No workspace metadata is available in this older backup.",
    };
  }
  if (resource.kind === "chat-transcript") {
    const relativePath = transcriptPath(resource);
    const project = relativePath.split("/").filter(Boolean)[0] ?? "Unknown project";
    return {
      key: `${resource.kind}:${project}`,
      label: clip(project, 100),
      detail: `Agent transcripts for project ${project}`,
    };
  }
  return {
    key: `${resource.kind}:all`,
    label: restoreKindLabel(resource.kind),
    detail: restoreKindPresentation(resource.kind).detail,
  };
}

function renderChat(
  resource: RestoreResourceDescriptor,
  date: string | null,
): { label: string; description: string; detail: string } {
  const metadata = resource.metadata;
  const title = normalizedMetadataString(metadata, "title");
  const workspace = workspaceLabel(metadataString(metadata, "workspaceUri"));
  const count = metadataNumber(metadata, "bubbleCount");
  const messages =
    count === null || count < 0 || !Number.isInteger(count)
      ? null
      : `${count} message${count === 1 ? "" : "s"}`;
  const composerId = chatComposerId(resource);
  const titlelessLabel = compactParts([
    workspace ?? "Cursor conversation",
    messages,
    shortIdentity(composerId),
  ]);
  return {
    label: title ?? titlelessLabel,
    description: compactParts([
      title === null ? "Title unavailable in this older backup" : workspace,
      title === null ? null : messages,
      date === null ? null : `Updated ${date}`,
    ]),
    detail: compactParts([
      `Conversation ID: ${composerId}`,
      metadataString(metadata, "workspaceUri"),
    ]),
  };
}

function renderTranscript(
  resource: RestoreResourceDescriptor,
  date: string | null,
): { label: string; description: string; detail: string } {
  const relativePath = transcriptPath(resource);
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  const transcriptIndex = segments.indexOf("agent-transcripts");
  const project = segments[0] ?? "Unknown project";
  const transcriptSegments = transcriptIndex < 0
    ? []
    : segments.slice(transcriptIndex + 1);
  const file = segments.at(-1) ?? relativePath;
  const stem = file.replace(/\.(jsonl|txt)$/i, "");
  const supportedFile = /\.(jsonl|txt)$/i.test(file);
  const subagent =
    supportedFile &&
    transcriptSegments.length === 3 &&
    transcriptSegments[1] === "subagents";
  const main =
    supportedFile &&
    transcriptSegments.length === 2 &&
    transcriptSegments[0] === stem;
  const identity = shortIdentity(stem);
  const shape = subagent
    ? "Subagent transcript"
    : main
      ? "Main transcript"
      : "Agent transcript";
  return {
    label: `${clip(project, 56)} · ${shape}${identity.length === 0 ? "" : ` · ${identity}`}`,
    description: compactParts([
      date === null ? null : `Updated ${date}`,
      file,
    ]),
    detail: relativePath,
  };
}

function displayTimestamp(
  resource: RestoreResourceDescriptor,
  now: number,
): number | null {
  const candidates = [
    metadataNumber(resource.metadata, "lastUpdatedAt"),
    resource.sourceTimestamp ?? null,
    parseTimestamp(resource.eventCreatedAt),
  ].filter((value): value is number => validDisplayTimestamp(value, now));
  return candidates.length === 0 ? null : Math.max(...candidates);
}

function validDisplayTimestamp(value: number | null, now: number): value is number {
  return value !== null &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 8.64e15 &&
    value <= now + FUTURE_CLOCK_TOLERANCE_MS;
}

function parseTimestamp(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metadataString(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizedMetadataString(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string | null {
  const value = metadataString(metadata, key);
  return value === null ? null : clip(value, 100);
}

function metadataNumber(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstMetadataString(
  metadata: Record<string, JsonValue> | undefined,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = metadataString(metadata, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function workspaceLabel(uri: string | null): string | null {
  if (uri === null) {
    return null;
  }
  try {
    const parsed = new URL(uri);
    const path = safeDecode(parsed.pathname);
    const name = path.split("/").filter(Boolean).at(-1);
    return name === undefined ? clip(uri, 60) : clip(name, 60);
  } catch {
    const name = uri.split(/[\\/]/).filter(Boolean).at(-1);
    return clip(name ?? uri, 60);
  }
}

function decodedResourceSuffix(resourceId: string): string {
  const slash = resourceId.indexOf("/");
  if (slash < 0 || slash === resourceId.length - 1) {
    return resourceId;
  }
  return safeDecode(resourceId.slice(slash + 1));
}

function transcriptPath(resource: RestoreResourceDescriptor): string {
  const prefix = "chat-transcript/";
  if (resource.resourceId.startsWith(prefix)) {
    const encoded = resource.resourceId.slice(prefix.length);
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded.length > 0) {
        return decoded.replace(/\\/g, "/");
      }
    } catch {
      // A malformed legacy ID cannot establish a canonical path. Metadata is
      // then the only readable fallback, but never overrides a decodable ID.
    }
  }
  return (
    metadataString(resource.metadata, "relativePath") ??
    decodedResourceSuffix(resource.resourceId)
  ).replace(/\\/g, "/");
}

function chatComposerId(resource: RestoreResourceDescriptor): string {
  const prefix = "chat/";
  if (resource.resourceId.startsWith(prefix)) {
    const encoded = resource.resourceId.slice(prefix.length);
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded.length > 0) {
        return decoded;
      }
    } catch {
      // Fall back to metadata only when the immutable ID is malformed.
    }
  }
  return metadataString(resource.metadata, "composerId") ??
    decodedResourceSuffix(resource.resourceId);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function shortIdentity(value: string): string {
  return /^[0-9a-f-]{12,}$/i.test(value) ? value.slice(0, 8) : clip(value, 24);
}

function compactParts(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part.length > 0).join(" · ");
}

function clip(value: string, limit: number): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length <= limit
    ? flattened
    : `${flattened.slice(0, limit - 1)}…`;
}

function itemCount(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
