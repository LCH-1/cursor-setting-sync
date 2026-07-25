# Security design

## Protected data

Synchronization payloads may contain chat text, source excerpts, local paths, workspace metadata, notepad content, images, MCP environment values, and user-entered configuration. Every shared payload is encrypted with AES-256-GCM using keys derived from a random repository master key.

The repository passphrase is not stored in the shared folder. `repo.json` contains only scrypt parameters, a random salt, the wrapped master key, the repository identity, and the protocol version. Each PC stores the unlocked master key in Cursor `SecretStorage`. The detached helper receives it through a short-lived stdin pipe, not through command-line arguments, environment variables, or a key file.

## Excluded data

The extension excludes from database-backed UI-state synchronization:

- `secret://*`
- `mcpOAuth.*`
- access tokens, refresh tokens, passwords, credentials, and authentication-session patterns
- Cursor and extension `SecretStorage`
- downloaded extension binaries and caches
- workspace browser sessions, retrieval indexes, debugger storage, SQLite sidecars, and prior database backups
- restoration of `workspace.json`; only its workspace identity and URI are used as encrypted metadata

Account and OAuth authorization must be completed separately on each PC.

File resources are handled differently: explicitly synchronized settings and MCP JSON may contain inline API keys, headers, or environment values. Those files are encrypted in the shared repository, but their inline contents are intentionally synchronized. Prefer environment-variable references. `cursorSettingSync.ignoredSettings` applies only to keys inside `settings.json`; a whole file under `~/.cursor` — `mcp.json`, `cli-config.json`, a private rules file — is excluded with `cursorSettingSync.ignoredUserFiles`, which also accepts a directory entry such as `rules/` and wildcards such as `rules/*.md`.

## Input and path boundaries

- Absolute paths and `..` traversal are rejected.
- Symlinks are not collected.
- Portable paths require NFC normalization and `/` separators.
- Empty segments, reserved Windows names, alternate data streams, and trailing dots or spaces are rejected.
- Cursor user files are limited to explicit MCP, CLI configuration, commands, skills, and rules locations.
- Transcripts are limited to supported files under `agent-transcripts`.
- Chat stores are limited to `store.db` under `chats` or `acp-sessions`.
- Workspace storage payloads are limited to portable logical rows read from `state.vscdb`, `notepads.json`, and regular files below `images/` inside a validated workspace ID.
- `workspace.json` is parsed read-only for workspace identity and URI metadata and is never written by synchronization.
- Workspace-storage WAL/SHM/journal files, backups, browser-session data, retrieval data, debugger data, and unknown extension directories are rejected by the allowlist.
- Mapped workspace IDs are canonicalized to one resource identity, and workspace-storage deletions never remove local files on another PC.
- Resource IDs, kinds, profile IDs, metadata paths, and payload-internal paths must agree.
- Event, object, compressed, plaintext, and apply-batch sizes are bounded.

## Cross-version safety

Events record their producing Cursor, VS Code base, and extension versions. Portable file resources remain bidirectional. Database-backed resources, including workspace storage, from a newer producer are deferred on an older consumer, and missing producer metadata also defers database application.

This prevents an older installation from applying an unknown newer database representation. It also prevents the unchanged older local representation from being published over the deferred remote tip. If the old installation genuinely edits that resource, the resource DAG preserves both branches as a conflict.

Unknown repository or envelope protocols fail closed before publication.

## SQLite write safety

Global database writes require:

1. A compatible producer direction
2. `node:sqlite` with online backup support
3. A matching local schema contract
4. Cursor process exit
5. `BEGIN IMMEDIATE`
6. `PRAGMA quick_check = ok`
7. A completed online backup

All schema checks, prepared DML, foreign-key checks, and `integrity_check` run before `COMMIT`. A pre-commit error uses SQLite `ROLLBACK`; a post-commit checkpoint delay is maintenance and never causes committed data to be reverted. Online backups are read-only recovery sources. No live database, WAL, SHM, or rollback-journal file is copied over, renamed, quarantined, or replaced.

Workspace `state.vscdb` is read through SQLite after all Cursor processes exit and serialized into deterministic typed rows for `ItemTable` and `cursorDiskKV`. Incoming data is applied to an existing mapped workspace database with per-key `INSERT`/`UPDATE` statements. Target-only rows, unknown tables, unknown columns, schema objects, and sidecars remain untouched. Snapshot absence does not imply deletion. Ordinary allowlisted workspace files use atomic replacement, while `workspace.json` remains untouched.

Local recovery backups are plaintext because Cursor itself can read the same local data. They stay below the extension's local storage directory, are never uploaded as payloads, and are bounded to 30 files, 30 days, and 2 GiB.

## Threat-model limits

- A malicious device with the repository passphrase can create valid events.
- A malicious local process or Cursor extension running as the user may read local data.
- A compromised shared-folder account can delete or roll back encrypted files, but cannot read payloads or forge authenticated changes without the master key.
- A lost passphrase cannot be recovered.
- Protocol v1 changes the passphrase by creating a new repository rather than re-encrypting an existing repository in place.
