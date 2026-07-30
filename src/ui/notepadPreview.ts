/**
 * Renders `notepads.json` as the notes a person wrote, for the conflict diff.
 *
 * The payload is a JSON array of `{id, name, text}` whose `text` holds the whole
 * note with its line breaks escaped as `\n` inside a JSON string. Diffing the
 * raw bytes therefore showed one enormous line per note, with every paragraph
 * break spelled `\r\n` in the middle of it — the reviewer could see that
 * *something* differed without being able to read either version, which is the
 * one thing the review screen exists to make possible.
 *
 * Preview only. The resolution still publishes the original bytes of whichever
 * side is chosen; nothing here is ever written back.
 */

/** Separates notes; long enough not to collide with note text. */
const SEPARATOR = "─".repeat(60);

interface NotepadEntry {
  id: string;
  name?: unknown;
  text?: unknown;
}

/**
 * Returns the readable rendering, or null when the payload is not a notepad
 * list this build can read — in which case the caller shows the raw bytes,
 * which is still better than showing nothing.
 */
export function renderNotepadsPreview(content: string): string | null {
  const entries = parse(content);
  if (entries === null) {
    return null;
  }
  if (entries.length === 0) {
    return "(no notepads)\n";
  }
  const sections = entries.map((entry, index) => {
    const name =
      typeof entry.name === "string" && entry.name.trim().length > 0
        ? entry.name
        : "(untitled)";
    // The id is kept because it is what the merge keys on: when a note appears
    // on one side only, the id is the evidence that it is a different note
    // rather than a rename of the one beside it.
    const heading = `### ${index + 1}. ${name}    [id ${entry.id}]`;
    const body =
      typeof entry.text === "string"
        ? normalizeLineEndings(entry.text)
        : "(this note has no text)";
    return `${heading}\n\n${body}\n`;
  });
  return `${sections.join(`\n${SEPARATOR}\n\n`)}\n`;
}

/**
 * `\r\n` is what these files carry, and a diff that renders one side with
 * carriage returns and the other without reports every line as changed.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parse(content: string): NotepadEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const entries: NotepadEntry[] = [];
  for (const candidate of parsed) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const entry = candidate as Record<string, unknown>;
    if (typeof entry["id"] !== "string") {
      return null;
    }
    entries.push(entry as unknown as NotepadEntry);
  }
  return entries;
}

/** True for the `workspace-storage/...%2Fnotepads.json` resource IDs. */
export function isNotepadsResourceId(resourceId: string): boolean {
  const prefix = "workspace-storage/";
  if (!resourceId.startsWith(prefix)) {
    return false;
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(resourceId.slice(prefix.length));
  } catch {
    return false;
  }
  const segments = relativePath.split("/");
  return segments.length === 2 && segments[1]?.toLowerCase() === "notepads.json";
}
