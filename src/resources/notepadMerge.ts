import type { MergeOutcome } from "../types";

/**
 * `notepads.json` is a flat JSON array of notepads, each keyed by a string `id`
 * that Cursor mints once and never rewrites. That makes the file a keyed
 * collection wearing a list's clothes, and it is why it can be merged at all:
 * two computers that each added notepads to the same workspace hold two
 * *different subsets* of the same keyspace, not two versions of one opaque blob.
 *
 * Entries carry `{id, name, text}` in practice, but nothing here depends on
 * that beyond `id` — a winning entry travels verbatim, with whatever fields
 * Cursor put on it, so a field this build has never heard of survives the merge.
 */
interface NotepadEntry {
  id: string;
  [field: string]: unknown;
}

/** The largest notepad list this build will merge rather than hand to a person. */
const MAX_ENTRIES = 10_000;

/**
 * Three-way merge of two `notepads.json` payloads.
 *
 * `preferred` and `other` must be ordered by the replicated tip comparator, not
 * by which device is running this: both computers merge the same pair and must
 * reach the same bytes, or they publish two "resolutions" and re-fork.
 *
 * Per notepad id, against the base:
 *   - one side unchanged  -> the other side's version, changed or deleted. This
 *     is the case the user actually has: an edit made on one computer while the
 *     other simply still holds the old copy. Electing whole files would have
 *     thrown away every notepad on the losing side to carry one edit.
 *   - both sides identical -> that version.
 *   - added on one side only -> kept.
 *   - deleted on one side, edited on the other -> the edit survives. A resurrected
 *     notepad can be deleted again; a discarded edit cannot be retyped.
 *   - genuinely divergent -> {@link electEntry}, and if that cannot prove a
 *     winner the whole merge declines and a person decides.
 */
export function mergeNotepadBuffers(
  base: Buffer,
  preferred: Buffer,
  other: Buffer,
): MergeOutcome {
  const baseEntries = parseNotepads(base);
  const preferredEntries = parseNotepads(preferred);
  const otherEntries = parseNotepads(other);
  if (
    baseEntries === null ||
    preferredEntries === null ||
    otherEntries === null
  ) {
    return { status: "conflict" };
  }
  const baseById = byId(baseEntries);
  const preferredById = byId(preferredEntries);
  const otherById = byId(otherEntries);

  const merged: NotepadEntry[] = [];
  for (const id of orderedIds(preferredEntries, otherEntries)) {
    const resolution = resolveEntry(
      baseById.get(id),
      preferredById.get(id),
      otherById.get(id),
    );
    if (resolution === UNDECIDABLE) {
      return { status: "conflict" };
    }
    if (resolution !== DROP) {
      merged.push(resolution);
    }
  }
  return serializedOutcome(merged);
}

/**
 * Union of two `notepads.json` payloads that share no ancestor.
 *
 * This is the first-contact case: two computers that each already had notepads
 * for a workspace before they ever synchronized. There is no base to read
 * intent from, so every id either side holds is kept, and only an id both hold
 * with *different* content needs {@link electEntry} — which may decline, in
 * which case a person decides rather than a version being thrown away.
 */
export function unionNotepadBuffers(
  preferred: Buffer,
  other: Buffer,
): MergeOutcome {
  const preferredEntries = parseNotepads(preferred);
  const otherEntries = parseNotepads(other);
  if (preferredEntries === null || otherEntries === null) {
    return { status: "conflict" };
  }
  const preferredById = byId(preferredEntries);
  const otherById = byId(otherEntries);

  const merged: NotepadEntry[] = [];
  for (const id of orderedIds(preferredEntries, otherEntries)) {
    const fromPreferred = preferredById.get(id);
    const fromOther = otherById.get(id);
    if (fromPreferred === undefined || fromOther === undefined) {
      const only = fromPreferred ?? fromOther;
      if (only !== undefined) {
        merged.push(only);
      }
      continue;
    }
    const elected = electEntry(fromPreferred, fromOther);
    if (elected === UNDECIDABLE) {
      return { status: "conflict" };
    }
    merged.push(elected);
  }
  return serializedOutcome(merged);
}

/** This notepad is not in the merged list, because both sides deleted it. */
const DROP = Symbol("drop");
/** No rule can settle this notepad without destroying one side's writing. */
const UNDECIDABLE = Symbol("undecidable");

type EntryResolution = NotepadEntry | typeof DROP | typeof UNDECIDABLE;

function resolveEntry(
  fromBase: NotepadEntry | undefined,
  fromPreferred: NotepadEntry | undefined,
  fromOther: NotepadEntry | undefined,
): EntryResolution {
  if (fromPreferred === undefined && fromOther === undefined) {
    return DROP;
  }
  if (fromBase === undefined) {
    // Added on one side, or added on both. Two independent adds under one id
    // are not something Cursor produces (the id embeds the creation timestamp),
    // but they still have to land the same way on both computers.
    if (fromPreferred === undefined) return fromOther ?? DROP;
    if (fromOther === undefined) return fromPreferred;
    return electEntry(fromPreferred, fromOther);
  }
  const preferredChanged =
    fromPreferred === undefined || !sameEntry(fromBase, fromPreferred);
  const otherChanged = fromOther === undefined || !sameEntry(fromBase, fromOther);
  if (!preferredChanged) {
    // The preferred side still holds the base copy, so whatever the other side
    // did — edit or delete — is the only change and it wins outright. This is
    // the case the user actually has, and it needs no election at all.
    return fromOther ?? DROP;
  }
  if (!otherChanged) {
    return fromPreferred ?? DROP;
  }
  if (fromPreferred === undefined) {
    // Deleted here, edited there: the edit survives. See the header.
    return fromOther ?? DROP;
  }
  if (fromOther === undefined) {
    return fromPreferred;
  }
  return electEntry(fromPreferred, fromOther);
}

/**
 * Settles two versions of one notepad, or declines to.
 *
 * A notepad carries no timestamp — the `id` records when it was *created*, not
 * when it was last written — so there is no recency to read off the payload,
 * and the tip Lamport clock is not a substitute: a computer joining an existing
 * repository publishes at the highest Lamport in it, which would make every
 * note the newcomer happens to hold outrank the notes it is meeting. Measured
 * on the real pair: the joining machine held the higher Lamport and the SMALLER
 * file for both shared workspaces.
 *
 * So a winner is claimed only where one is provable — one text strictly
 * contains the other, which is the same note with material added, and taking it
 * loses nothing. Anything else is two people's writing with nothing to separate
 * them, and this returns {@link UNDECIDABLE} so the fork reaches the manual
 * resolver with both versions intact.
 *
 * Declining rather than electing is what the rest of this codebase does with
 * authored content: `mergeWorkspaceDatabaseSnapshots` reports a concurrent
 * update instead of picking, and last-writer-wins is documented as something
 * that "must never reach a kind whose loser holds authored content". Electing
 * here would have made notepads the exception, and silently — the merge has no
 * warning channel, so the losing text would vanish with nothing in the output
 * channel to say so.
 */
function electEntry(
  preferred: NotepadEntry,
  other: NotepadEntry,
): NotepadEntry | typeof UNDECIDABLE {
  if (sameEntry(preferred, other)) {
    return preferred;
  }
  const preferredText = preferred["text"];
  const otherText = other["text"];
  // Equal texts are deliberately not containment: the entries differ, so
  // something else on them does — a rename, most likely — and no side of that
  // is provable either.
  if (
    typeof preferredText === "string" &&
    typeof otherText === "string" &&
    preferredText !== otherText
  ) {
    if (preferredText.includes(otherText)) {
      return preferred;
    }
    if (otherText.includes(preferredText)) {
      return other;
    }
  }
  return UNDECIDABLE;
}

/**
 * Every id in either side, preferred side's order first.
 *
 * The array order is the order the user sees in the notepad list, so it is
 * worth keeping rather than sorting into id order — and reading it off the
 * preferred side keeps it identical on both computers.
 */
function orderedIds(
  preferred: readonly NotepadEntry[],
  other: readonly NotepadEntry[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...preferred, ...other]) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      ids.push(entry.id);
    }
  }
  return ids;
}

function byId(entries: readonly NotepadEntry[]): Map<string, NotepadEntry> {
  const result = new Map<string, NotepadEntry>();
  for (const entry of entries) {
    result.set(entry.id, entry);
  }
  return result;
}

function sameEntry(left: NotepadEntry, right: NotepadEntry): boolean {
  return stableJson(left) === stableJson(right);
}

/**
 * Field order must not decide equality; only the field values may.
 *
 * The accumulator has a null prototype because a notepad is parsed from a file
 * this process did not write: `JSON.parse` turns `"__proto__"` into an ordinary
 * own property, and assigning that onto a normal object literal sets the
 * accumulator's prototype instead of a field — the value then vanishes from
 * `JSON.stringify` and two entries that differ would compare equal.
 */
function stableJson(entry: NotepadEntry): string {
  const ordered = Object.create(null) as Record<string, unknown>;
  for (const field of Object.keys(entry).sort()) {
    ordered[field] = entry[field];
  }
  return JSON.stringify(ordered);
}

function serializedOutcome(entries: readonly NotepadEntry[]): MergeOutcome {
  // Two spaces, matching what Cursor itself writes, so a merge that changes
  // nothing produces the file that was already there.
  const content = Buffer.from(JSON.stringify(entries, null, 2), "utf8");
  return { status: "merged", content };
}

/**
 * Returns null — never throws — for anything this build cannot key by id: a
 * payload that is not an array of objects, an entry with no usable `id`, a
 * duplicate id, or a list too large to be a person's notepads. The conflict
 * then stays unresolved and a person decides, which is the right outcome for a
 * shape this code has never seen.
 */
function parseNotepads(content: Buffer): NotepadEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_ENTRIES) {
    return null;
  }
  const entries: NotepadEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const entry = candidate as Record<string, unknown>;
    const id = entry["id"];
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      return null;
    }
    seen.add(id);
    entries.push(entry as NotepadEntry);
  }
  return entries;
}
