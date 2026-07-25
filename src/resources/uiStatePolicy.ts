import { EXTENSION_ID } from "../constants";
import type { SqliteStorageValue } from "../platform/sqlite";
import { sqliteStorageText } from "../platform/sqlite";
import type { IgnoreMatcher } from "./ignorePatterns";
import { createIgnoreMatcher } from "./ignorePatterns";

const UUID = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";

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

/**
 * Keys this build declines to synchronize because they are machine-local churn,
 * not because they are dangerous.
 *
 * These are a *policy*, and policies change between releases. Every release up
 * to 0.0.3 published these keys, so real repositories already contain events
 * for them and this build must still be able to read those events without
 * failing. An inbound change for one of these keys is therefore skipped and
 * accounted for — never fatal. Conflating the two lists made the apply side
 * throw {@link FatalApplyError} on an event a previous version of this very
 * extension wrote, which aborted the entire shutdown apply — ui-state,
 * profiles, chat, extensions, user files and the workspaceStorage restore all
 * of it — on every single shutdown, permanently, because the event is immutable
 * and the pending entry is never superseded.
 */
const POLICY_EXCLUDED_KEY_PATTERNS = [
  // Cursor mints one of these per AI chat panel and never prunes them, so the
  // family grows without bound and every GUID is meaningless on another
  // machine. Syncing them only ferries dead layout entries between devices.
  new RegExp(`^workbench\\.panel\\.composerChatViewPane\\.${UUID}\\.hidden$`),
  // The same GUIDs, accumulated inside one value: this array collects a
  // `workbench.panel.aichat.<uuid>` entry per chat panel either machine ever
  // opened. Merging it converges, but the merged array is the union of both
  // machines' dead panels and nothing ever shrinks it again.
  /^workbench\.auxiliarybar\.pinnedPanels$/,
];

/** A key whose arrival is a protocol violation; see the pattern list. */
export function isSecurityDeniedUiStateKey(key: string): boolean {
  return SECURITY_DENIED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** A key this build declines to synchronize; see the pattern list. */
export function isPolicyExcludedUiStateKey(key: string): boolean {
  return POLICY_EXCLUDED_KEY_PATTERNS.some((pattern) => pattern.test(key));
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
  const parsed = JSON.parse(source) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Target storage marker must be an object.");
  }
  const entries = Object.entries(parsed);
  if (entries.length > 100_000) {
    throw new Error("Target storage marker contains too many entries.");
  }
  for (const [key, target] of entries) {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
