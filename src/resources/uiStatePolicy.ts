import { EXTENSION_ID } from "../constants";

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

export function parseTargetStorageMarker(
  value: Uint8Array | string | undefined,
): Record<string, number> {
  const result = Object.create(null) as Record<string, number>;
  if (value === undefined) {
    return result;
  }
  const source =
    typeof value === "string" ? value : Buffer.from(value).toString("utf8");
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
