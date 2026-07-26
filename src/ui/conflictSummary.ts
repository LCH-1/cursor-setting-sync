import type { JsonValue, ResourceKind, ResourceTip, SyncConflict } from "../types";
import { compareTips } from "../protocol/reconciler";
import { formatBytes } from "../sync/versionPolicy";

/**
 * Turns a conflict into the two or three sentences a person actually needs.
 *
 * Nothing in the stored conflict is meant to be read by a human: `resourceId`
 * is percent-encoded, `versionId` is a hash, and `lamport` is a logical clock
 * that answers "which came later in causal order" and not "which is mine" or
 * "when". A resolver built on those asks the user to arbitrate between two
 * hashes, which is not a question anyone can answer. Everything below exists to
 * replace them with the resource's own name, its value, whose machine it came
 * from, and when.
 *
 * This module is deliberately free of any `vscode` import so the labelling can
 * be tested without an extension host.
 */

/** How much of a payload is worth reading to build a one-line preview. */
export const PREVIEW_BYTE_LIMIT = 64 * 1024;

export interface ConflictSideView {
  tip: ResourceTip;
  /** Whether this side was published by the device running the resolver. */
  origin: "local" | "remote";
  /** "This PC" / "Other PC (c55756e3)". */
  deviceLabel: string;
  /** One-line rendering of the side's content. */
  value: string;
  /** "3 minutes ago", or null when the version predates a checkpoint. */
  when: string | null;
  /** The side {@link latestSideIndex} elects; see it for what "later" means. */
  newest: boolean;
}

export interface ConflictView {
  conflict: SyncConflict;
  tips: ResourceTip[];
  /** "Setting", "Chat", "Cursor rules", ... */
  category: string;
  /** The resource's own name: `editor.fontSize`, `rules/team.mdc`, a title. */
  name: string;
  sides: ConflictSideView[];
  /** The tip {@link latestSideIndex} elects, and what "keep the later one" means. */
  latest: ResourceTip;
  /**
   * True when both sides carry a usable timestamp, so the election above really
   * was decided by the times shown on screen rather than by publish order.
   */
  electedByClock: boolean;
}

/**
 * Which side a person reading this screen would call the later one.
 *
 * `compareTips` orders by Lamport, then device ID, then event hash. That answers
 * "which came later in causal order", which is the right question for anything
 * both devices must agree on without talking — and the wrong question to put in
 * front of a person, for two reasons:
 *
 *  - The two orderings disagree exactly when a fork is interesting. A device
 *    that has not polled publishes at a low Lamport however recently it wrote,
 *    so the stale machine's week-old edit can outrank the peer's two-minute-old
 *    one.
 *  - In the *ordinary* two-machine fork — both devices caught up, both editing
 *    before the next poll — the two events land on the same Lamport and the
 *    comparator falls through to `deviceId.localeCompare`, which is a coin flip
 *    over two random UUIDs.
 *
 * The resolver now shows wall-clock times, and a screen that displays
 * "2 minutes ago" next to "7 days ago" and then hands "keep the newer one" to
 * the seven-day-old side is worse than one that showed no times at all: the user
 * acts on what they can read. So the badge and the bulk action are both decided
 * here, from the same timestamps that are printed.
 *
 * This is a *manual* choice by one person on one machine, published as an
 * ordinary resolution event, so it carries none of the replication obligations
 * that keep automatic merges on Lamport ordering. Where a timestamp is missing —
 * a version folded into a checkpoint keeps none — or where the two are equal,
 * this falls back to the causal head, and {@link ConflictView.electedByClock}
 * reports that so the wording can stay honest.
 *
 * `tips` must already be in `compareTips` order.
 */
export function latestSideIndex(tips: readonly ResourceTip[]): {
  index: number;
  byClock: boolean;
} {
  const times = tips.map((tip) => {
    const parsed = tip.createdAt === undefined ? NaN : Date.parse(tip.createdAt);
    return Number.isFinite(parsed) ? parsed : null;
  });
  if (times.length < 2 || times.some((time) => time === null)) {
    return { index: 0, byClock: false };
  }
  let index = 0;
  for (let candidate = 1; candidate < times.length; candidate += 1) {
    if ((times[candidate] as number) > (times[index] as number)) {
      index = candidate;
    }
  }
  // Equal timestamps decide nothing, so the causal head stands and the caller
  // must not claim the clock chose it.
  const distinct = new Set(times).size > 1;
  return { index: distinct ? index : 0, byClock: distinct };
}

export interface ConflictViewContext {
  localDeviceId: string;
  now: number;
  /** Payload bytes already read for this tip, or null when unavailable. */
  contentOf: (tip: ResourceTip) => Buffer | null;
}

export function describeConflict(
  conflict: SyncConflict,
  tips: readonly ResourceTip[],
  context: ConflictViewContext,
): ConflictView {
  const ordered = [...tips].sort(compareTips);
  const latest = latestSideIndex(ordered);
  const latestTip = ordered[latest.index] ?? ordered[0];
  if (latestTip === undefined) {
    throw new Error(`Conflict ${conflict.resourceId} has no tips to describe.`);
  }
  return {
    conflict,
    tips: ordered,
    category: categoryLabel(conflict.kind),
    name: resourceName(conflict, ordered, context),
    latest: latestTip,
    electedByClock: latest.byClock,
    sides: ordered.map((tip, index) => ({
      tip,
      origin: tip.deviceId === context.localDeviceId ? "local" : "remote",
      deviceLabel:
        tip.deviceId === context.localDeviceId
          ? "This PC"
          : `Other PC (${tip.deviceId.slice(0, 8)})`,
      value: describeValue(conflict.kind, tip, context.contentOf(tip)),
      when: relativeTime(tip.createdAt, context.now),
      newest: index === latest.index,
    })),
  };
}

export function categoryLabel(kind: ResourceKind): string {
  switch (kind) {
    case "settings":
      return "Setting";
    case "keybindings":
      return "Keybindings";
    case "snippet":
      return "Snippet";
    case "task":
      return "Task";
    case "prompt":
      return "Prompt";
    case "mcp":
      return "MCP config";
    case "extension":
      return "Extension";
    case "profile":
      return "Profile";
    case "ui-state":
      return "UI state";
    case "cursor-user-file":
      return "Cursor file";
    case "cursor-user-rules":
      return "Cursor rules";
    case "chat":
      return "Chat";
    case "chat-transcript":
      return "Chat transcript";
    case "chat-store":
      return "Chat store";
    case "workspace-storage":
      return "Workspace data";
  }
}

/**
 * The name the user knows the resource by. Resource IDs encode this already —
 * `settings/<profile>/<key>` really is one settings key — so the work is
 * reading it back out of the metadata the publishing adapter attached, and
 * falling back to a decoded resource ID rather than to nothing.
 */
function resourceName(
  conflict: SyncConflict,
  tips: readonly ResourceTip[],
  context: ConflictViewContext,
): string {
  const metadata = tips[0]?.metadata;
  if (conflict.kind === "chat") {
    const title = chatTitle(tips, context);
    if (title !== null) {
      return title;
    }
  }
  for (const field of ["key", "relativePath", "extensionId", "composerId"]) {
    const value = metadata?.[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return decodePath(conflict.resourceId);
}

function chatTitle(
  tips: readonly ResourceTip[],
  context: ConflictViewContext,
): string | null {
  for (const tip of tips) {
    const snapshot = parseJson(context.contentOf(tip));
    const header = isObject(snapshot) ? snapshot.header : undefined;
    const title = isObject(header) ? chatHeaderName(header.value) : null;
    if (title !== null) {
      return title;
    }
  }
  return null;
}

/**
 * The chat's name, out of the `composerHeaders.value` document.
 *
 * That column is not a title: it is a JSON record describing the conversation —
 * `{"type":"head","composerId":...,"name":...,"subtitle":...}` — and its `name`
 * field is what Cursor shows in the chat list. Treating the column itself as
 * the title put a raw JSON document where the chat's name belongs in the
 * resolver, on every chat conflict.
 *
 * A conversation with no name yet (a draft, an empty composer) returns null so
 * the caller falls back to the composer ID, which is at least an identifier.
 */
function chatHeaderName(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value) as JsonValue;
  } catch {
    // Not a document at all. An older or newer Cursor could plausibly put a
    // bare title here, so it is used — but only when it does not look like the
    // structured value this column actually holds today.
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed.startsWith("{") || trimmed.startsWith("[")
      ? null
      : clip(trimmed, 60);
  }
  const name = isObject(parsed) ? parsed.name : undefined;
  return typeof name === "string" && name.trim().length > 0
    ? clip(name.trim(), 60)
    : null;
}

/**
 * A one-line rendering of what this side of the fork actually holds.
 *
 * Every branch degrades rather than throws: a payload can be a delete, absent,
 * compacted behind a checkpoint, larger than the preview budget, or binary, and
 * a resolver that fails on any of those is worse than one that says so.
 */
export function describeValue(
  kind: ResourceKind,
  tip: ResourceTip,
  content: Buffer | null,
): string {
  if (tip.operation === "delete") {
    return "removed";
  }
  if (content === null) {
    const bytes = tip.payload?.plainBytes;
    return bytes === undefined || bytes > PREVIEW_BYTE_LIMIT
      ? `${bytes === undefined ? "content" : formatBytes(bytes)} not previewed`
      : "content unavailable";
  }
  if (kind === "chat") {
    return describeChatValue(tip, content);
  }
  if (kind === "settings" || kind === "extension") {
    const parsed = parseJson(content);
    if (parsed !== undefined) {
      return clip(JSON.stringify(parsed) ?? "null", 80);
    }
  }
  const text = decodeText(content);
  if (text === null) {
    return `binary, ${formatBytes(content.byteLength)}`;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  const lines = trimmed.split("\n");
  const first = clip(lines[0] ?? "", 70);
  return lines.length === 1
    ? first
    : `${first} (+${lines.length - 1} more line${lines.length === 2 ? "" : "s"})`;
}

function describeChatValue(tip: ResourceTip, content: Buffer): string {
  const snapshot = parseJson(content);
  const bubbles = isObject(snapshot) ? snapshot.bubbles : undefined;
  const count = Array.isArray(bubbles)
    ? bubbles.length
    : numberOf(tip.metadata?.bubbleCount);
  const header = isObject(snapshot) ? snapshot.header : undefined;
  const updatedAt = isObject(header)
    ? numberOf(header.lastUpdatedAt)
    : numberOf(tip.metadata?.lastUpdatedAt);
  const parts = [
    count === null ? "conversation" : `${count} message${count === 1 ? "" : "s"}`,
  ];
  const written = utcMinute(updatedAt);
  if (written !== null) {
    parts.push(`last written ${written}`);
  }
  return parts.join(", ");
}

/**
 * `Number.isFinite` is not enough to hand a value to `Date`: 1e20 is finite and
 * outside the representable range, and `toISOString` throws on it. The number
 * comes out of a peer's payload, and one throw here would take down the whole
 * Resolve Conflicts command rather than one row of one list.
 */
function utcMinute(timestamp: number | null): string | null {
  if (timestamp === null || Math.abs(timestamp) > 8.64e15) {
    return null;
  }
  const at = new Date(timestamp);
  return Number.isNaN(at.getTime())
    ? null
    : at.toISOString().slice(0, 16).replace("T", " ");
}

export function relativeTime(
  timestamp: string | undefined,
  now: number,
): string | null {
  if (timestamp === undefined) {
    return null;
  }
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) {
    return null;
  }
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 0) {
    return "just now";
  }
  for (const [limit, size, unit] of [
    [60, 1, "second"],
    [3600, 60, "minute"],
    [86400, 3600, "hour"],
    [2592000, 86400, "day"],
  ] as const) {
    if (seconds < limit) {
      const value = Math.floor(seconds / size);
      return value <= 0
        ? "just now"
        : `${value} ${unit}${value === 1 ? "" : "s"} ago`;
    }
  }
  return new Date(at).toISOString().slice(0, 10);
}

function decodePath(resourceId: string): string {
  try {
    return decodeURIComponent(resourceId);
  } catch {
    return resourceId;
  }
}

function parseJson(content: Buffer | null): JsonValue | undefined {
  if (content === null || content.byteLength > PREVIEW_BYTE_LIMIT) {
    return undefined;
  }
  const text = decodeText(content);
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Null when the bytes are not valid UTF-8 text. */
function decodeText(content: Buffer): string | null {
  const text = content.toString("utf8");
  return text.includes("\uFFFD") ? null : text;
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(value: string, limit: number): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length <= limit
    ? flattened
    : `${flattened.slice(0, limit - 1)}…`;
}
