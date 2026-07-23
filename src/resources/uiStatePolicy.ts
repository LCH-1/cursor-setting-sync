import { EXTENSION_ID } from "../constants";
import type { SqliteStorageValue } from "../platform/sqlite";
import { sqliteStorageText } from "../platform/sqlite";

const DENIED_KEY_PATTERNS = [
  /^secret:\/\//i,
  /^mcpOAuth\./i,
  /(?:^|[./_-])(access|refresh)?token(?:$|[./_-])/i,
  /(?:^|[./_-])password(?:$|[./_-])/i,
  /(?:^|[./_-])credential(?:s)?(?:$|[./_-])/i,
  /authenticationSession/i,
  new RegExp(`^${escapeRegExp(EXTENSION_ID)}`, "i"),
];

export function isDeniedUiStateKey(key: string): boolean {
  return DENIED_KEY_PATTERNS.some((pattern) => pattern.test(key));
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
