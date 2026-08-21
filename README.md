# Cursor Setting Sync

**English** · [한국어](README.ko.md)

Cursor Setting Sync securely synchronizes Cursor configuration, allowlisted workspace state, and supported chat data across multiple PCs through a shared folder such as OneDrive or Syncthing, or through a git remote such as GitHub. Repository payloads are encrypted before they leave the device, and no synchronization server or account is required. It runs on Windows, macOS, and Linux.

## Features

- Settings for the default profile and named profiles
- Keybindings, snippets, user tasks, prompts, and MCP configuration
- Installed extension lists, versions, enablement, pre-release, and pinning state
- Profile definitions
- Cursor User Rules
- `~/.cursor` MCP and CLI configuration, commands, skills, and rules
- Portable, query-level synchronization of allowlisted `%APPDATA%\Cursor\User\workspaceStorage` state plus notepads and images
- Composer/chat records (including the content-addressed data required to continue them), agent transcripts, and supported `store.db` sessions
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
- An optional repository passphrase (12+ characters when set; leaving it empty stores the key inside the repository, so only do that for a private local folder or a fully trusted private remote)

File-based synchronization remains available when Cursor's embedded runtime does not provide the required SQLite capabilities. Profile, UI-state, extension-state, workspace storage, and database-backed chat synchronization require `node:sqlite`, online backup support, and a compatible local schema.

## Installation

Install **Cursor Setting Sync** from the Extensions view, then run the single Command Palette entry, `Cursor Setting Sync: Manage`, and choose **Setup or Reconfigure**.

## Setup

### Common (every transport)

- Every transport starts from `Cursor Setting Sync: Manage` → **Setup or Reconfigure**.
- The passphrase is optional. If you set one, it must be at least 12 characters and identical on every PC. It is never stored in the shared repository and cannot be recovered.
- Leaving the passphrase empty shows a security warning and then proceeds. The encryption key is then stored inside the repository next to the data, so anyone who can read the shared folder or git remote can decrypt everything. Use it only for a trusted local folder or a fully controlled private remote.
- On additional PCs, file resources apply automatically when safe. Database and workspace-storage changes apply through the shutdown helper after all Cursor windows close normally; use **Apply Queued Changes** inside **Manage** only when you want to apply immediately.
- Before setup, the status bar opens **Manage** directly at **Setup or Reconfigure**. Nothing is synchronized until a repository is configured.

Pick a transport below, and check the [Storage options](#storage-options) table for provider-specific notes.

### Transport A — shared folder (OneDrive · Dropbox · Google Drive · Syncthing · local)

**First PC**

1. Run `Cursor Setting Sync: Manage` and choose **Setup or Reconfigure**.
2. Select an empty folder inside the shared (or local) location.
3. Choose **Plain shared folder**.
4. Enter a passphrase (at least 12 characters, or leave it empty to skip it).
5. Wait for the status bar to report that synchronization is up to date, then confirm your provider finished uploading.

**Additional PCs**

1. Install the extension, run `Cursor Setting Sync: Manage`, and choose **Setup or Reconfigure**.
2. Select the same shared folder (each PC's own local copy).
3. Choose **Plain shared folder** and enter the same passphrase.

> Google Drive needs "Mirror files" mode with "Available offline", and OneDrive needs "Always keep on this device". See [Storage options](#storage-options) for details.

### Transport B — git remote (GitHub · GitLab · self-hosted)

**Prerequisite**: the `git` CLI must be on `PATH`, and because authentication is non-interactive (`GIT_TERMINAL_PROMPT=0`) you should configure a credential helper or SSH keys first.

**First PC (create the repository)**

1. Run `Cursor Setting Sync: Manage` and choose **Setup or Reconfigure**.
2. Select an empty folder (any location).
3. Choose **New git repository with remote** and enter the remote URL (leave it empty for a local-only git history).
4. Enter a passphrase (at least 12 characters, or leave it empty to skip it). The first sync pushes to the remote.

**Additional PCs (join the repository)**

1. Install the extension, run `Cursor Setting Sync: Manage`, and choose **Setup or Reconfigure**.
2. Select an empty folder.
3. Choose **Clone an existing git repository** and enter the same remote URL.
4. Enter the same passphrase.

## Storage options

The repository is a folder of encrypted, append-only files. What "sync" means depends on what carries that folder to your other PCs. From **Manage**, choose **Setup or Reconfigure**, point it at a folder, and pick the transport that matches how the folder travels.

| Transport | How to set it up | What you get |
| --- | --- | --- |
| **OneDrive / Dropbox / iCloud Drive** | Choose **Plain shared folder** and select an empty folder inside the provider's synced location. Keep it on disk: OneDrive right-click → **"Always keep on this device"** (not "Free up space"; this is the Files On-Demand feature), Dropbox → turn off "online-only", iCloud Drive keeps files local by default. | Full multi-PC sync. The provider uploads the folder; each PC points **Setup or Reconfigure** at its own local copy of the same synced folder. |
| **Google Drive** | In Google Drive for desktop use **"Mirror files"** mode (not stream-only) and right-click the folder → **"Available offline"**, then choose **Plain shared folder**. | Full multi-PC sync. In stream-only mode files are virtual placeholders, so file watching and reads are unreliable — Mirror files mode is required. |
| **Syncthing / Resilio** | Point every PC's share at the same folder and choose **Plain shared folder**. | Full multi-PC sync with no cloud account. The extension already ignores `sync-conflict` copies. |
| **Local folder (no cloud, no git)** | Choose **Plain shared folder** and select any local directory. | Single-PC versioned backup: full version history, **Restore Version History**, and **Restore Database Backup** all work. It just never reaches other PCs, because nothing carries the folder off the machine. |
| **Git — clone existing** | Choose **Clone an existing git repository** and paste the repository URL (GitHub, GitLab, or a self-hosted remote). | Joins a repository other PCs already push to. Each cycle pulls before reading and commits/pushes after writing. |
| **Git — new with remote** | Choose **New git repository with remote** and paste the remote URL. | Initializes git in the folder and connects the remote; the first sync pushes. Use this to start a fleet on GitHub/GitLab/self-hosted. |
| **Git — local-only** | Choose **New git repository with remote** and leave the URL empty. | A local git history with no remote — like the local-folder case, but with git commits. Add a remote later to publish. |

Git transport requires the `git` CLI on `PATH`. Authentication uses your system git credentials non-interactively (`GIT_TERMINAL_PROMPT=0`), so configure a credential helper or SSH keys first; an auth failure degrades to a warning and the folder still works locally. Remote changes are detected by polling (git mode receives no file-change events). Because encrypted payloads do not delta-compress, a git repository grows roughly with the data it holds. The extension checks git file sizes automatically and, once the event log passes 500 files, periodically checkpoints and prunes eligible history behind the same propagation and safety gates used by synchronization.

## Continue the same original chat on another PC

Use this flow when a conversation still continues normally on PC B and you want to continue that exact conversation on PC A, rather than create a successor Agent:

1. Install the same current extension version on both PCs. On PC B, open the working original conversation and wait for the automatic cycle—and the shared-folder provider or git push—to finish. To force a cycle, open **Manage** and choose **Sync Now**.
2. On PC A, wait for the automatic repository cycle. If a database change is queued, close every Cursor window normally, let the shutdown helper finish, and reopen Cursor. To apply immediately, choose **Apply Queued Changes** inside **Manage**. Chat database rows are never written while Cursor is running.
3. Reopen the same workspace and select the original conversation. Its exact `composerId` is retained; this flow does not create a new Agent.

PC A queues and applies a chat core only from a complete portable v2 continuation graph, and the offline helper verifies its metadata and reachable closure again before writing. A legacy blob-only event itself may add blobs but never materializes an absent core; when that legacy payload is closure-complete, the current extension republishes a verified core-applying child so an existing repository can recover the original core. Materialized orphan blobs are retained, while missing declarations that are proven unreachable and absent are normalized in bounded passes. If Cursor gave both copies the same frozen timestamp, the complete longer copy wins automatically only when it is a provable strict extension of the shared visible sequence; an ambiguous fork remains unresolved for manual handling. Newly published or changed chats admitted by the bounded two-chat work batch receive continuation enrichment in the same cycle. A large backlog of older chats is still processed incrementally, so one cycle is not guaranteed to prepare every legacy conversation—allow additional automatic cycles on the PC that still has the working originals before applying them elsewhere.

## One management command

The Command Palette exposes exactly one entry: **Cursor Setting Sync: Manage**. Normal operation needs no command: synchronization polls and watches automatically, safe file changes apply while Cursor runs, queued database changes apply after a normal full shutdown, and checkpoint/prune/orphan maintenance runs behind bounded safety gates.

**Manage** opens one action list for the cases that still require a deliberate choice:

- **Show Diagnostics**, **Sync Now**, and **Apply Queued Changes** for inspection or an immediate retry. The latter two are manual accelerators for automatic work.
- **Resolve Conflicts** for data that cannot be merged without choosing a side.
- **Repair Unavailable Chats** and **Open Recovered Chat** for bounded in-place repair or the safe transcript fallback. Repair never fabricates missing continuation data; if no exact source exists it leaves the original unchanged.
- **Restore Version History** and **Restore Database Backup** for explicit rollback. A pre-restore backup is created so a mistaken database restore can be undone.
- **Archive Repository**, **Forget Device**, **Setup or Reconfigure**, and **Disconnect This PC** for infrequent administration. Disconnect clears only this PC's path, key, and mappings; it does not alter the shared repository.

Status-bar clicks route to the relevant action inside **Manage**, so setup, diagnostics, queued apply, and conflict resolution remain one click away without adding separate palette commands.

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
  "cursorSettingSync.useDefaultIgnoredSettings": true,
  "cursorSettingSync.ignoredExtensions": [],
  "cursorSettingSync.ignoredUserFiles": [],
  "cursorSettingSync.ignoredUiStateKeys": [],
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
| `syncLocalWorkspaces` | `false` | Whether local folder workspaces (`file://`) take part in workspaceStorage sync. **Off by default**: a local folder is identified by its path, so unless both computers open the same project at the identical path there is nothing on the other side for it to land on — and the only thing that ever happened to those resources was a prompt listing hundreds of unrelated workspaces asking you to map one that does not exist. Turn it on if the same projects live at the same paths everywhere. Remote-SSH workspaces always synchronize. **Machine-scoped.** |
| `ignoredWorkspaces` | `[]` | Further workspaces this computer neither backs up nor writes, matched against the workspace URI, on top of the built-in exclusion above. Wildcards work: `vscode-remote://ssh-remote+staging*`. The percent-encoded form Cursor stores is matched against the readable pattern you write. **Machine-scoped**: unlike every other setting here it does not travel between computers, because which projects live on a machine is a fact about that machine. Chats are unaffected. |
| `gitSync` | `true` | When the repository folder is a git worktree, pull before reading and commit/push after writing. Requires the `git` CLI. |
| `ignoredSettings` | `[]` | Setting keys in `settings.json` excluded from synchronization. Add sensitive values such as API keys here. Each entry is an exact key (`editor.fontSize`) or a wildcard (`remote.SSH.*`). |
| `useDefaultIgnoredSettings` | `true` | Also exclude the built-in machine-specific key list below. Turn it off to synchronize those keys anyway. |
| `ignoredExtensions` | `[]` | Extension IDs excluded from synchronization. Exact (`ms-python.python`) or wildcard (`ms-python.*`); matching ignores case. |
| `ignoredUserFiles` | `[]` | Files under `~/.cursor` excluded from synchronization, by relative path. Use this — **not** `ignoredSettings` — to keep `mcp.json` or `cli-config.json` off the shared folder. An entry naming a directory (`rules` or `rules/`) excludes everything under it, and wildcards work: `rules/*.md`, `skills/**/secret.md`. |
| `ignoredUiStateKeys` | `[]` | **No effect since 0.0.42.** No UI state key is synchronized at all any more, so there is nothing left for this list to exclude. See [UI state is not synchronized](#ui-state-is-not-synchronized). |
| `maxPayloadMiB` | `128` | Maximum uncompressed size of one payload (MiB, 1–512). A larger resource is skipped with a warning naming it; everything else in the cycle still synchronizes. |

Every ignore list accepts the same patterns: an exact entry, `*` for any characters (stopping at `/` in the path-shaped `ignoredUserFiles`), and `**` to cross directory separators. For `ignoredSettings` and `ignoredUserFiles`, an entry that matches nothing is reported in the output channel, so a typo is visible.

Values still present under the legacy `cursorSync.*` namespace are honored as a fallback.

### Machine-specific settings excluded by default

These describe the computer rather than a preference, and VS Code registers them in workbench code where scanning extension manifests cannot see them — a proxy URL carries credentials, a shell path points at an executable the other PC may not have, a zoom level belongs to a monitor. `cursorSettingSync.useDefaultIgnoredSettings: false` turns the whole list off.

```
application.shellEnvironmentResolutionTimeout   remote.WSL.*
git.path                                        terminal.external.*
http.proxy*                                     terminal.integrated.automationProfile.*
http.systemCertificates                         terminal.integrated.cwd
http.experimental.systemCertificatesV2          terminal.integrated.defaultProfile.*
java.jdt.ls.java.home                           terminal.integrated.shell.*
python.condaPath                                terminal.integrated.shellArgs.*
python.defaultInterpreterPath                   window.zoomLevel
remote.SSH.*                                    window.zoomPerWindow
```

Keys that VS Code's own Settings Sync propagates between machines are deliberately **not** on the list: `terminal.integrated.profiles.*`, `terminal.integrated.env.*` and `files.simpleDialog.enable` are ordinary application-scoped preferences, and `python.venvPath` is declared `machine`-scoped by the Python extension itself.

Settings that an installed extension declares as `machine` or `machine-overridable` scope are excluded on top of this list.

If a key on this list had already synchronized from this PC before the list started covering it, the output channel names it, and `Show Diagnostics` keeps the same notice under the standing warnings — so a key that stops travelling after an upgrade is never silent.

### UI state is not synchronized

Since 0.0.42, **no** UI state key travels between computers. Window layout — pinned panels and view containers, hidden views, per-panel state, dismissed-notification counters — stays on the machine that produced it.

Each Cursor window rewrites these keys on its own schedule from what you do on that screen, so they have no shared meaning across two computers and nothing to converge on. Carrying them produced conflicts with no authored change behind them at all: when a second computer first joined the real repository this was built for, thirteen of its sixteen conflicts were UI state keys whose only crime was existing on both machines. Releases 0.0.4 through 0.0.41 excluded one churning key family at a time — dead chat-panel GUIDs, the pinned-panel union, Cursor's reactive-storage blob — and the field kept producing the next one.

Your **Cursor User Rules** are stored in the same database table but are a separate resource, and they still synchronize. So do settings, keybindings, snippets, tasks, prompts, MCP configuration, extensions, profiles, chats, and workspace storage.

This is a policy, not a safety rule. A UI state value published by an earlier version is skipped on arrival, is named in the output channel, and never fails the rest of the apply. The value already on other devices is never deleted. `cursorSettingSync.ignoredUiStateKeys` is consequently a no-op and can be removed from your settings.

## Security and privacy

- Payloads are encrypted with AES-256-GCM using keys derived from a random repository master key.
- The passphrase-derived key only wraps the master key; the passphrase is not stored in the repository.
- The unlocked master key is kept in Cursor's `SecretStorage` on each PC.
- Cursor/extension `SecretStorage` and known database-backed OAuth, authentication-session, password, credential, and token keys are excluded.
- Inline values inside synchronized settings or MCP JSON are encrypted but are part of the payload. Prefer environment-variable references. Sensitive keys inside `settings.json` go in `cursorSettingSync.ignoredSettings`; whole files under `~/.cursor` such as `mcp.json` and `cli-config.json` go in `cursorSettingSync.ignoredUserFiles`.
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
- A forced shutdown can prevent the final database and workspace-storage export from completing. If needed, open **Manage**, choose **Sync Now**, then close Cursor normally after important work.
- Workspace storage is captured only after every Cursor process exits; the **Sync Now** action does not scan it while Cursor is running.
- Workspace database imports are upsert-only in protocol v1: target-only rows are preserved, and a missing incoming row never deletes local state.
- Agent transcripts alone may not fully recreate every Cursor sidebar entry.
- Finalized events and tombstones are retained by repository protocol v1 until automatic maintenance folds and removes them. Once the event log passes 500 files, a running extension host waits at least six hours between automatic attempts; restarting Cursor may re-evaluate sooner, but the propagation, age, pending-work, and conflict safety gates still apply.
- The machine-specific exclusion set is computed per PC. A key an extension declares as `machine`-scoped is only excluded where that extension is installed, so install order across the fleet can still let such a key travel. The built-in default list above applies everywhere and is not affected.

See [usage](docs/usage.md), [protocol](docs/protocol.md), [security](docs/security.md), and [compatibility](docs/compatibility.md) for technical details.

## License

[MIT](LICENSE)

## Links

- [Repository](https://github.com/LCH-1/cursor-setting-sync)
- [Issue tracker](https://github.com/LCH-1/cursor-setting-sync/issues)
