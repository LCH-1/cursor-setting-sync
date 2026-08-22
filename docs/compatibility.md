# Compatibility

## Supported installation range

- Windows 10 or later
- Cursor exposing VS Code API 1.99 or later
- Node.js 20 or later for the extension bundle

The extension does not require an exact Cursor patch, minor, or VS Code base version. File-based resources are portable across supported installations.

## Source build and release verification

Building and running the complete test suite from source requires Node.js 24 or later. The published extension bundle still targets Node.js 20 and degrades to file-only synchronization when an older Cursor runtime lacks the required SQLite APIs, but Node.js 24 is required to exercise the offline-helper integration tests and `node:sqlite.backup` release gate without skips.

## Directional version policy

Each event records the producing Cursor version, VS Code base version, and extension version.

- Older producer to newer consumer: allowed when the local schema contract passes.
- Same versions: allowed when the local schema contract passes.
- Newer producer to older consumer: file resources are allowed; database-backed resources are deferred.
- Unknown producer metadata: database-backed resources are deferred.
- Unknown repository, event, or object protocol version: synchronization stops before local publication.

Deferred versions stay in the encrypted repository. They become eligible after the older PC updates and synchronizes again. An unchanged older local copy is not published over the deferred remote tip. A genuine local edit creates a concurrent DAG tip and therefore a conflict.

Workspace storage is treated as database-backed because each workspace may contain `state.vscdb`. It follows the same directional version policy even for the accompanying allowlisted JSON and image files. Database capture and SQL merge always run offline after Cursor exits.

## Database capability contract

Database-backed synchronization additionally requires:

- `node:sqlite`
- `node:sqlite.backup`
- `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- `PRAGMA quick_check = ok`
- Required tables and columns:

```text
ItemTable(key, value)
cursorDiskKV(key, value)
composerHeaders(
  composerId, workspaceId, createdAt, lastUpdatedAt,
  isArchived, isSubagent, recency, checkpointAt, value
)
```

Workspace `state.vscdb` additionally requires `ItemTable(key, value)` and `cursorDiskKV(key, value)` with a unique key. These rows are transported in a typed portable format; the database file, schema objects, WAL, SHM, and rollback journal are never transported. Newer target tables and columns therefore survive an older-to-newer import.

Every nullable `composerHeaders` column and every `cursorDiskKV` chat value is transported with its SQLite storage class, so SQL `NULL` round-trips as `NULL` instead of becoming `0` or the text `null`. A client older than the `null` storage class rejects such a chat snapshot rather than applying a coerced value.

Portable Composer chat schema v2 additionally carries the reachable `agentKv:blob:<sha256>` continuation graph referenced by supported top-level `conversationState` fields in `composerData` and bubble rows, together with authenticated graph references retained by chat merges. Keys, hashes, reference partitions, counts, and byte limits are validated before apply. Version 0.0.62 and earlier can neither produce nor consume this graph and safely defer a v2 payload instead of applying only its legacy portion; legacy rows that already exist locally remain visible. Update every PC to 0.0.63 before relying on a restored conversation for continued prompting.

If these checks fail, file synchronization remains active while profile, Cursor User Rules, extension-state, workspace storage, and database-backed chat resources are deferred. Diagnostics explain the failed capability or schema check.

## Portable resources

File resources include settings, keybindings, snippets, tasks, prompts, MCP files, Cursor commands, skills, rules, and agent transcripts. Machine-scoped settings and configured ignore lists are excluded.

Database-backed resources include profiles, Cursor User Rules, extension state, allowlisted workspace storage, Composer/chat records, and supported `store.db` sessions. UI state is read from the same database but is not synchronized.

A lower extension version can retain events containing a well-formed resource kind introduced by a newer extension. It continues applying supported changes from the same event without reindexing them, and a later extension update replays the immutable log to discover the previously unknown kind.

Workspace storage payloads are limited to `state.vscdb`, `notepads.json`, and `images/**`. `workspace.json` supplies read-only identity/URI metadata and is never restored. Browser sessions, retrieval indexes, debugger data, prior database backups, renamed/corrupt database copies, caches, and SQLite sidecars are intentionally excluded.

Mapped workspace IDs are canonicalized into one resource identity. Deletions are not published or applied for workspace storage because local workspace sets may legitimately differ.

## Known limits

- Remote SSH and WSL extension-host behavior is not supported because this extension is designed as a local UI extension.
- Cursor account authentication, extension `SecretStorage`, OS credentials, and MCP OAuth tokens are intentionally device-local.
- Workspace chat restoration may require a workspace mapping when paths differ between PCs.
- Workspace-storage restoration may also require a mapping. Synchronization never replaces the local `workspace.json` association.
- A clean Cursor exit is required for the final workspace snapshot; forced termination can leave the repository one session behind.
