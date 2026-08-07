/**
 * Reads the conversation name Cursor stores inside `composerHeaders.value`.
 *
 * The column is normally a JSON document rather than the title itself.  Older
 * or newer Cursor builds may still store a bare string, so that form is
 * accepted when it does not look like an incomplete structured document.
 */
export function chatHeaderTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    const bare = clipTitle(value);
    return bare.length === 0 || bare.startsWith("{") || bare.startsWith("[")
      ? null
      : bare;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const name = (parsed as Record<string, unknown>).name;
  return typeof name === "string" && name.trim().length > 0
    ? clipTitle(name)
    : null;
}

/** Extracts a title from a stored portable chat without trusting its metadata. */
export function chatSnapshotTitle(content: Buffer): string | null {
  try {
    const snapshot = JSON.parse(content.toString("utf8")) as unknown;
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return null;
    }
    const header = (snapshot as Record<string, unknown>).header;
    if (header === null || typeof header !== "object" || Array.isArray(header)) {
      return null;
    }
    return chatHeaderTitle((header as Record<string, unknown>).value);
  } catch {
    return null;
  }
}

function clipTitle(value: string): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length <= 80
    ? flattened
    : `${flattened.slice(0, 79)}…`;
}
