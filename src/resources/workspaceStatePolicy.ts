import type {
  WorkspaceDatabaseSnapshot,
  WorkspaceDatabaseTable,
} from "../helper/workspaceDatabaseMerge";

/**
 * ItemTable rows of a workspace state.vscdb that are worth carrying to another
 * computer. Everything else in that table is the workbench's per-machine UI
 * state — panel sizes, view mementos, open-tab lists, MRU caches, extension
 * scratch — which Cursor rewrites continuously on every machine that has the
 * workspace open.
 *
 * This is an allowlist, not a denylist, on purpose. A survey of every
 * Remote-SSH workspace database on a real profile found ~160 distinct ItemTable
 * keys, of which only the handful below carry anything a person would miss on
 * the other computer; the rest is chrome, and chrome is unbounded — every
 * installed extension and every Cursor release mints new keys. A denylist
 * would chase that forever, and every key it missed is another row both
 * machines rewrite concurrently, which is exactly the row-level conflict a
 * shared workspace cannot resolve on its own.
 *
 * Excluding a key here does not delete it anywhere: the scan simply stops
 * publishing it, the apply side stops writing it, and each machine keeps its
 * own live value. The helper's physical pre-write backups still copy the whole
 * database file, so the full ItemTable remains locally restorable.
 */
const PORTABLE_WORKSPACE_ITEM_KEYS: ReadonlySet<string> = new Set([
  // Cursor notepads - authored content.
  "notepadData",
  "notepad.reactiveStorageId",
  // Interactive-window sessions - conversation-class data.
  "interactive.sessions",
  // Breakpoints name files inside the workspace, so on a Remote-SSH workspace
  // they mean the same thing on every machine that opens it.
  "debug.breakpoint",
]);

/**
 * Whether a workspace-database row travels between computers.
 *
 * Only ItemTable is filtered. cursorDiskKV and composerHeaders pass through
 * whole: Cursor uses both for conversation-class content (chat bodies lived in
 * workspace cursorDiskKV in earlier versions), never for machine chrome.
 */
export function isPortableWorkspaceStateRow(
  table: string,
  key: string,
): boolean {
  return table !== "ItemTable" || PORTABLE_WORKSPACE_ITEM_KEYS.has(key);
}

/**
 * Restricts a workspace-database snapshot to its portable rows.
 *
 * Applied in three places, which together make the policy symmetric: the scan
 * (chrome never leaves this machine), the helper apply (chrome in an event a
 * previous version published is skipped, not written), and the three-way
 * conflict merge (a base or tip that still carries chrome — published by an
 * older build — cannot make a filtered side read as having deleted it, which
 * would otherwise turn every fork against an old snapshot into a
 * concurrent-delete conflict for as long as the old event remains the base).
 */
export function filterPortableWorkspaceRows(
  snapshot: WorkspaceDatabaseSnapshot,
): WorkspaceDatabaseSnapshot {
  return {
    ...snapshot,
    tables: snapshot.tables.map((table): WorkspaceDatabaseTable => {
      if (table.name !== "ItemTable") {
        return table;
      }
      return {
        ...table,
        rows: table.rows.filter((row) =>
          isPortableWorkspaceStateRow(table.name, row.key),
        ),
      };
    }),
  };
}
