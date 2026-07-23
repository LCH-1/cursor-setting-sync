# Cursor Setting Sync

**English** · [한국어](README.ko.md)

Cursor Setting Sync securely synchronizes Cursor configuration, allowlisted workspace state, and supported chat data across multiple PCs through a shared folder such as OneDrive or Syncthing, or through a git remote such as GitHub. Repository payloads are encrypted before they leave the device, and no synchronization server or account is required. It runs on Windows, macOS, and Linux.

## Features

- Settings for the default profile and named profiles
- Keybindings, snippets, user tasks, prompts, and MCP configuration
- Installed extension lists, versions, enablement, pre-release, and pinning state
- Profile definitions and selected user-scoped UI state
- Cursor User Rules
- `~/.cursor` MCP and CLI configuration, commands, skills, and rules
- Portable, query-level synchronization of allowlisted `%APPDATA%\Cursor\User\workspaceStorage` state plus notepads and images
- Composer/chat records, agent transcripts, and supported `store.db` sessions
- Immutable history, deterministic conflict detection, encrypted deduplicated objects, backups, and diagnostics
- Shared-folder or git-remote transport: with `cursorSettingSync.gitSync` enabled and the repository folder a git worktree, every cycle pulls before reading and commits/pushes after writing

## Cross-version synchronization

Cursor versions do not need to match exactly.

- File-based resources synchronize in both directions across supported Cursor versions.
- Database-backed resources created by an older Cursor or extension version can be applied by a newer version.
- Database-backed resources created by a newer Cursor, VS Code base, or extension version are deferred on an older PC. Update that PC before applying them.
- Workspace database rows are serialized into a versioned portable payload and merged with SQL only after Cursor exits. Original SQLite files are never transported or installed.
- A deferred remote version is not replaced by an unchanged older local copy. If both PCs genuinely modify the same resource, both versions are preserved as a conflict instead of silently overwriting either side.
- Unknown repository protocol versions fail closed before the client publishes local changes.
- Safe but unknown resource kinds from a newer extension remain in the immutable log; an older extension continues applying kinds it understands and picks up the deferred kind after it is updated.

This policy prioritizes forward migration and data safety. Reverse application to an older Cursor is allowed only when the producing versions are not newer and the local database passes the required schema checks.

## Requirements

- Windows 10 or later, macOS, or Linux
- Cursor with VS Code API 1.99 or later
- A shared folder provided by OneDrive, Syncthing, or a similar file synchronization tool — or a git remote (the `git` CLI must be on PATH for git transport)
- A repository passphrase of at least 12 characters

File-based synchronization remains available when Cursor's embedded runtime does not provide the required SQLite capabilities. Profile, UI-state, extension-state, workspace storage, and database-backed chat synchronization require `node:sqlite`, online backup support, and a compatible local schema.

## Installation

Install **Cursor Setting Sync** from the Extensions view, then run `Cursor Setting Sync: Setup` from the Command Palette.

## Setup

### Common (every transport)

- Every transport starts by running `Cursor Setting Sync: Setup`.
- The passphrase is optional. If you set one, it must be at least 12 characters and identical on every PC. It is never stored in the shared repository and cannot be recovered.
- Leaving the passphrase empty shows a security warning and then proceeds. The encryption key is then stored inside the repository next to the data, so anyone who can read the shared folder or git remote can decrypt everything. Use it only for a trusted local folder or a fully controlled private remote.
- On additional PCs, file resources apply automatically when safe. When database or workspace-storage changes are pending, follow the status bar and run `Cursor Setting Sync: Restart to Apply`.
- Running `Sync Now` (or any other command) before `Setup` does nothing: the status bar shows `unconfigured` and a message points you to `Setup`. Nothing is synchronized until a repository is configured.

Pick a transport below, and check the [Storage options](#storage-options) table for provider-specific notes.

### Transport A — shared folder (OneDrive · Dropbox · Google Drive · Syncthing · local)

**First PC**

1. Run `Cursor Setting Sync: Setup`.
2. Select an empty folder inside the shared (or local) location.
3. Choose **Plain shared folder**.
4. Enter a passphrase (at least 12 characters, or leave it empty to skip it).
5. Wait for the status bar to report that synchronization is up to date, then confirm your provider finished uploading.

**Additional PCs**

1. Install the extension and run `Cursor Setting Sync: Setup`.
2. Select the same shared folder (each PC's own local copy).
3. Choose **Plain shared folder** and enter the same passphrase.

> Google Drive needs "Mirror files" mode with "Available offline", and OneDrive needs "Always keep on this device". See [Storage options](#storage-options) for details.

### Transport B — git remote (GitHub · GitLab · self-hosted)

**Prerequisite**: the `git` CLI must be on `PATH`, and because authentication is non-interactive (`GIT_TERMINAL_PROMPT=0`) you should configure a credential helper or SSH keys first.

**First PC (create the repository)**

1. Run `Cursor Setting Sync: Setup`.
2. Select an empty folder (any location).
3. Choose **New git repository with remote** and enter the remote URL (leave it empty for a local-only git history).
4. Enter a passphrase (at least 12 characters, or leave it empty to skip it). The first sync pushes to the remote.

**Additional PCs (join the repository)**

1. Install the extension and run `Cursor Setting Sync: Setup`.
2. Select an empty folder.
3. Choose **Clone an existing git repository** and enter the same remote URL.
4. Enter the same passphrase.

## Storage options

The repository is a folder of encrypted, append-only files. What "sync" means depends on what carries that folder to your other PCs. Point `Setup` at a folder and pick the transport that matches how the folder travels.

| Transport | How to set it up | What you get |
| --- | --- | --- |
| **OneDrive / Dropbox / iCloud Drive** | Choose **Plain shared folder** and select an empty folder inside the provider's synced location. Keep it on disk: OneDrive right-click → **"Always keep on this device"** (not "Free up space"; this is the Files On-Demand feature), Dropbox → turn off "online-only", iCloud Drive keeps files local by default. | Full multi-PC sync. The provider uploads the folder; each PC points `Setup` at its own local copy of the same synced folder. |
| **Google Drive** | In Google Drive for desktop use **"Mirror files"** mode (not stream-only) and right-click the folder → **"Available offline"**, then choose **Plain shared folder**. | Full multi-PC sync. In stream-only mode files are virtual placeholders, so file watching and reads are unreliable — Mirror files mode is required. |
| **Syncthing / Resilio** | Point every PC's share at the same folder and choose **Plain shared folder**. | Full multi-PC sync with no cloud account. The extension already ignores `sync-conflict` copies. |
| **Local folder (no cloud, no git)** | Choose **Plain shared folder** and select any local directory. | Single-PC versioned backup: full version history, `Restore Version History`, and `Restore Backup` all work. It just never reaches other PCs, because nothing carries the folder off the machine. |
| **Git — clone existing** | Choose **Clone an existing git repository** and paste the repository URL (GitHub, GitLab, or a self-hosted remote). | Joins a repository other PCs already push to. Each cycle pulls before reading and commits/pushes after writing. |
| **Git — new with remote** | Choose **New git repository with remote** and paste the remote URL. | Initializes git in the folder and connects the remote; the first sync pushes. Use this to start a fleet on GitHub/GitLab/self-hosted. |
| **Git — local-only** | Choose **New git repository with remote** and leave the URL empty. | A local git history with no remote — like the local-folder case, but with git commits. Add a remote later to publish. |

Git transport requires the `git` CLI on `PATH`. Authentication uses your system git credentials non-interactively (`GIT_TERMINAL_PROMPT=0`), so configure a credential helper or SSH keys first; an auth failure degrades to a warning and the folder still works locally. Remote changes are detected by polling (git mode receives no file-change events). Because encrypted payloads do not delta-compress, a git repository grows roughly with the data it holds — GitHub rejects files over 100 MB and prefers repositories under a few GB, so keep an eye on `Show Repository Usage` and run `Checkpoint & Prune History` to squash git history when it grows.

## Commands

**Setup and everyday sync**

- **Setup** — First-time configuration. Pick the repository folder and transport (plain / clone / new git), then enter the encryption passphrase (12+ characters, the same on every PC, never stored in the folder).
- **Sync Now** — Run one synchronization immediately. Synchronization is otherwise automatic (30-second polling plus file watching); this publishes local changes and pulls remote ones on demand.
- **Restart to Apply** — Quit and relaunch Cursor to apply pending database changes. Files apply while Cursor runs, but `state.vscdb` (chat, UI state, workspace databases) is written safely with SQL only after Cursor exits.

**Conflicts and recovery**

- **Resolve Conflicts** — Manually resolve edits made on two PCs that could not auto-merge. Shows a diff and lets you keep one side (or the current local content).
- **Restore Version History** — Roll one resource back to an earlier version (like a git revert). Pick a resource, browse its versions with a diff preview, and publish the chosen one as a new version; history is preserved.
- **Restore Backup** — Restore a database to an earlier backup snapshot. A SQLite backup is taken before every database write; pick one to restore. A "pre-restore" backup is also listed so a mistaken restore can be undone.

**Repository management**

- **Checkpoint & Prune History** — Fold the current state into a checkpoint and, once every PC has received it, delete the folded history to stop the repository from growing forever. In git mode it also squashes git history. Update every PC before running it — older builds fail loudly afterward.
- **Compact Safe Orphans** — Lightweight cleanup that removes object files no event references and stale temp files. It never touches event history.
- **Archive Repository** — Copy the entire repository folder to a separate location as a backup archive.
- **Forget Device** — Remove a device you no longer use from the list (local state only). Use it when an offline device is blocking pruning.

**Diagnostics**

- **Show Diagnostics** — View the current sync status, errors, and warning log. Start here when something looks wrong.
- **Show Repository Usage** — Report how much space the repository uses; in git mode it also warns about files over the 100 MB GitHub limit.

## Settings

```jsonc
{
  "cursorSettingSync.enabled": true,
  "cursorSettingSync.pollIntervalSeconds": 30,
  "cursorSettingSync.chatPollIntervalSeconds": 30,
  "cursorSettingSync.autoApplyFiles": true,
  "cursorSettingSync.syncChat": true,
  "cursorSettingSync.syncWorkspaceStorage": true,
  "cursorSettingSync.gitSync": true,
  "cursorSettingSync.ignoredSettings": [],
  "cursorSettingSync.ignoredExtensions": [],
  "cursorSettingSync.maxPayloadMiB": 128
}
```

| Setting | Default | Role |
| --- | --- | --- |
| `enabled` | `true` | Master switch that turns automatic synchronization on or off after setup. |
| `pollIntervalSeconds` | `30` | Fallback polling interval (seconds, 10–3600) for scanning the shared repository. Git mode detects remote changes through this poll. |
| `chatPollIntervalSeconds` | `30` | Interval (seconds, 10–3600) for checking Cursor chat metadata changes. |
| `autoApplyFiles` | `true` | Whether non-conflicting file resources apply while Cursor runs. A manual `Sync Now` applies regardless of this value. |
| `syncChat` | `true` | Synchronize supported Cursor chat stores (composer conversations, agent transcripts, `store.db`). |
| `syncWorkspaceStorage` | `true` | Back up `workspaceStorage` state. It is captured only after every Cursor process exits. |
| `gitSync` | `true` | When the repository folder is a git worktree, pull before reading and commit/push after writing. Requires the `git` CLI. |
| `ignoredSettings` | `[]` | Setting keys excluded from synchronization. Add sensitive values such as API keys here. |
| `ignoredExtensions` | `[]` | Extension IDs excluded from synchronization. |
| `maxPayloadMiB` | `128` | Maximum uncompressed size of one payload (MiB, 1–512). Larger resources are not published. |

Values still present under the legacy `cursorSync.*` namespace are honored as a fallback.

## Security and privacy

- Payloads are encrypted with AES-256-GCM using keys derived from a random repository master key.
- The passphrase-derived key only wraps the master key; the passphrase is not stored in the repository.
- The unlocked master key is kept in Cursor's `SecretStorage` on each PC.
- Cursor/extension `SecretStorage` and known database-backed OAuth, authentication-session, password, credential, and token keys are excluded.
- Inline values inside synchronized settings or MCP JSON are encrypted but are part of the payload. Prefer environment-variable references and add sensitive setting keys to `cursorSettingSync.ignoredSettings`.
- Workspace storage payloads are restricted to logical rows from `state.vscdb`, `notepads.json`, and files below `images/`; all payloads remain encrypted in the repository.
- `workspace.json` is read only to derive encrypted workspace identity/URI metadata. It is never stored or restored as a payload, and mapped workspace IDs share one canonical resource identity.
- Workspace-storage deletions are not propagated because each PC may have a different set of workspaces.
- SQLite database files, WAL/SHM/journal sidecars, backup copies, browser sessions, retrieval indexes, debugger data, and other workspace caches are never placed in the shared repository.
- Live Cursor databases are never copied over, renamed, quarantined, or replaced. Every change is prepared SQL inside a SQLite transaction, with integrity checks before commit.
- Recovery backups remain local and are used only as read sources for SQL restoration. Plaintext local backups are limited to the newest 30 files, 30 days, and 2 GiB.
- No telemetry is collected and the extension does not communicate with a project-operated server.

Shared-folder status only confirms a local file write. Always wait for OneDrive or Syncthing to finish uploading before shutting down a PC after important changes.

## Known limitations

- Cursor/GitHub/Microsoft sign-in and MCP OAuth authorization must be completed separately on every PC.
- A forced shutdown can prevent the final database and workspace-storage export from completing. Run `Cursor Setting Sync: Sync Now`, then close Cursor normally after important work.
- Workspace storage is captured only after every Cursor process exits; `Cursor Setting Sync: Sync Now` does not scan it while Cursor is running.
- Workspace database imports are upsert-only in protocol v1: target-only rows are preserved, and a missing incoming row never deletes local state.
- Agent transcripts alone may not fully recreate every Cursor sidebar entry.
- Finalized events and tombstones are retained by repository protocol v1.

See [usage](docs/usage.md), [protocol](docs/protocol.md), [security](docs/security.md), and [compatibility](docs/compatibility.md) for technical details.

## License

[MIT](LICENSE)

## Links

- [Repository](https://github.com/LCH-1/cursor-setting-sync)
- [Issue tracker](https://github.com/LCH-1/cursor-setting-sync/issues)
"# cursor-setting-sync" 
