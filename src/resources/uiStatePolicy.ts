import { EXTENSION_ID } from "../constants";
import type { SqliteStorageValue } from "../platform/sqlite";
import { sqliteStorageText } from "../platform/sqlite";
import type { IgnoreMatcher } from "./ignorePatterns";
import { createIgnoreMatcher } from "./ignorePatterns";
import { assertBoundedJsoncStructure } from "./jsonc";

export const MAX_TARGET_STORAGE_MARKER_BYTES = 8 * 1024 * 1024;
export const MAX_TARGET_STORAGE_MARKER_ENTRIES = 16_384;
const MAX_TARGET_STORAGE_MARKER_KEY_BYTES = 2 * 1024 * 1024;

/**
 * Keys that must never cross the repository boundary because carrying them
 * would leak a secret or let a peer rewrite this extension's own bookkeeping.
 *
 * This list is a security boundary, not a preference. An inbound change for one
 * of these keys is a protocol violation — no honest peer produces one — so the
 * apply side treats it as fatal and rolls the whole transaction back rather
 * than writing anything the attacker chose.
 */
const SECURITY_DENIED_KEY_PATTERNS = [
  /^secret:\/\//i,
  /^mcpOAuth\./i,
  /(?:^|[./_-])(access|refresh)?token(?:$|[./_-])/i,
  /(?:^|[./_-])password(?:$|[./_-])/i,
  /(?:^|[./_-])credential(?:s)?(?:$|[./_-])/i,
  /authenticationSession/i,
  new RegExp(`^${escapeRegExp(EXTENSION_ID)}`, "i"),
];

/** A key whose arrival is a protocol violation; see the pattern list. */
export function isSecurityDeniedUiStateKey(key: string): boolean {
  return SECURITY_DENIED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * True for every `ui-state` key: this build synchronizes none of them.
 *
 * The kind is window chrome — pinned viewlets, hidden panels, per-panel layout,
 * dismissed notification counters — that each Cursor window rewrites on its own
 * schedule from what the user does on *that* screen. It has no shared meaning
 * between two computers, and carrying it produced conflicts that had no
 * authored change behind them at all: on the real pair, thirteen of the sixteen
 * conflicts a second computer raised on joining were ui-state keys whose only
 * crime was existing on both machines before the machines ever met. Releases
 * 0.0.4 through 0.0.41 narrowed the exclusion pattern by pattern — dead chat
 * panel GUIDs, the pinned-panel union, the reactive-storage blob — and each
 * narrowing left the next churning key to be found in the field. The honest
 * conclusion of that sequence is the whole kind.
 *
 * `cursor-user-rules` (`aicontext.personalContext`) lives in the same table but
 * is a *different kind* precisely so this exclusion cannot reach it: user rules
 * are authored prose and still travel.
 *
 * This is a *policy*, not a safety boundary, and the distinction is load
 * bearing. Every release up to 0.0.41 published some of these keys, so real
 * repositories already contain immutable events for them and this build must
 * still read those events without failing. An inbound ui-state change is
 * therefore skipped and accounted for — never fatal. Conflating the two lists
 * made the apply side throw {@link FatalApplyError} on an event a previous
 * version of this very extension wrote, which aborted the entire shutdown apply
 * — profiles, chat, extensions, user files and the workspaceStorage restore,
 * all of it — on every single shutdown, permanently, because the event is
 * immutable and the pending entry is never superseded.
 */
export function isPolicyExcludedUiStateKey(_key: string): boolean {
  return true;
}

/**
 * Everything the scan must leave out, for either reason. Only the *scan* may
 * use this union: the apply side has to tell the two apart, because one aborts
 * the transaction and the other must not.
 */
export function isDeniedUiStateKey(key: string): boolean {
  return isSecurityDeniedUiStateKey(key) || isPolicyExcludedUiStateKey(key);
}

/**
 * Normalizes the user's `ignoredUiStateKeys` entries into the shared ignore
 * matcher: an exact key, or a glob such as `workbench.panel.*`.
 */
export function normalizeIgnoredUiStateKeys(
  entries: readonly string[],
): IgnoreMatcher {
  return createIgnoreMatcher(entries);
}

/**
 * Like the denylist, this only removes a key from the scan. A key the user
 * starts ignoring must never be published as a deletion, or one device's
 * preference would wipe the value everywhere.
 */
export function isIgnoredUiStateKey(
  key: string,
  ignored: IgnoreMatcher,
): boolean {
  return ignored.matches(key);
}

/**
 * A NULL, absent, or empty marker means the same thing to VS Code: no key is
 * registered as USER-target. A marker that is present but unparseable still
 * throws, because degrading a real marker to {} would let the apply side
 * rewrite it and strip every registered key.
 */
export function parseTargetStorageMarker(
  value: SqliteStorageValue | undefined,
): Record<string, number> {
  const result = Object.create(null) as Record<string, number>;
  if (value === undefined || value === null) {
    return result;
  }
  const source = sqliteStorageText(value, "Target storage marker");
  if (source.trim().length === 0) {
    return result;
  }
  if (Buffer.byteLength(source, "utf8") > MAX_TARGET_STORAGE_MARKER_BYTES) {
    throw new Error("Target storage marker exceeds its byte limit.");
  }
  assertBoundedJsoncStructure(source, "Target storage marker");
  const parsed = JSON.parse(source) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Target storage marker must be an object.");
  }
  let entries = 0;
  let keyBytes = 0;
  for (const key in parsed) {
    if (!Object.hasOwn(parsed, key)) {
      continue;
    }
    entries += 1;
    keyBytes += Buffer.byteLength(key, "utf8");
    if (
      entries > MAX_TARGET_STORAGE_MARKER_ENTRIES ||
      keyBytes > MAX_TARGET_STORAGE_MARKER_KEY_BYTES
    ) {
      throw new Error("Target storage marker contains too many entries.");
    }
    const target = (parsed as Record<string, unknown>)[key];
    if (
      key.length === 0 ||
      key.length > 4096 ||
      typeof target !== "number" ||
      !Number.isSafeInteger(target)
    ) {
      throw new Error("Target storage marker contains an invalid entry.");
    }
    result[key] = target;
  }
  return result;
}

/** Validates the post-apply marker before any SQL or in-memory state commits. */
export function serializeTargetStorageMarker(
  entries: Readonly<Record<string, number>>,
): string {
  let count = 0;
  let keyBytes = 0;
  for (const key in entries) {
    if (!Object.hasOwn(entries, key)) {
      continue;
    }
    const target = entries[key];
    count += 1;
    keyBytes += Buffer.byteLength(key, "utf8");
    if (
      count > MAX_TARGET_STORAGE_MARKER_ENTRIES ||
      keyBytes > MAX_TARGET_STORAGE_MARKER_KEY_BYTES ||
      key.length === 0 ||
      key.length > 4096 ||
      typeof target !== "number" ||
      !Number.isSafeInteger(target)
    ) {
      throw new Error("Updated target storage marker contains an invalid entry.");
    }
  }
  const serialized = JSON.stringify(entries);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TARGET_STORAGE_MARKER_BYTES) {
    throw new Error("Updated target storage marker exceeds its byte limit.");
  }
  return serialized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
