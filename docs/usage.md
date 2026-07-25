# Usage and recovery

## Create a repository

1. Install the extension and run `Cursor Setting Sync: Setup`.
2. Select an empty directory: either inside OneDrive, Syncthing, or another
   shared folder, or anywhere on disk when a git remote provides the transport.
3. Choose how the empty folder stores the repository:
   - **Plain shared folder** keeps the folder as-is and relies on the
     synchronization provider.
   - **Clone an existing git repository** joins a repository other devices
     already push to.
   - **New git repository with remote** initializes git in the folder; the
     remote URL may stay empty for a local-only history.
   A non-empty folder without a repository skips this picker and offers
   **Create encrypted repository** instead.
4. Enter a passphrase with at least 12 characters.
5. Wait for the status bar to report that synchronization is up to date.
6. Confirm that the shared-folder provider, or the git remote, received the
   first push.

The passphrase is required to decrypt the repository and cannot be recovered.

## Join from another PC

1. Install the extension and run `Cursor Setting Sync: Setup`.
2. Select the existing shared repository.
3. Enter the same passphrase.
4. File resources apply automatically when they do not conflict.
5. Run `Cursor Setting Sync: Restart to Apply` when database or workspace storage changes are pending.
6. Select a local workspace mapping if incoming chat or workspace data references a different path.

If a pending database change was created by a newer Cursor, VS Code base, or extension version, it remains deferred. Update the receiving PC and synchronize again. Portable file resources continue synchronizing while the database change is deferred.

## Git repository

The repository folder can be a git worktree instead of (or in addition to) a OneDrive or Syncthing folder. When `Cursor Setting Sync: Setup` is pointed at an empty folder it offers three choices:

- **Plain shared folder** — the existing behavior; git is not involved.
- **Clone an existing git repository** — enter a remote URL; the folder is cloned and setup continues by joining the cloned repository with the shared passphrase.
- **New git repository with remote** — git is initialized in the folder; the remote URL may be left empty for a local-only git history.

While `cursorSettingSync.gitSync` is enabled (the default) and the repository folder is a git worktree, every synchronization cycle pulls from the remote before reading and commits and pushes after writing, all under the machine-local synchronization lock. The offline helper mirrors the same transport around its shutdown export and offline apply.

### Credentials

The extension shells out to the system `git` CLI and uses whatever credentials git itself is configured with: a credential helper, an access token embedded in the remote URL, or SSH keys. Every git command runs non-interactively with `GIT_TERMINAL_PROMPT=0`, so nothing ever prompts for a password; a missing or rejected credential fails fast instead. If an authentication warning appears, configure a git credential helper (or switch the remote URL to SSH) and verify access once with `git fetch` in the repository folder.

A missing git binary, an authentication failure, or any other non-conflict git error degrades that cycle to plain shared-folder mode: the local repository write always completes, a warning is shown once per session per failure kind, and the details are logged to the Cursor Setting Sync output channel. A real git merge conflict inside the sync repository should be impossible — every device writes only its own directory — and aborts the cycle loudly for inspection.

### Remote change detection

A git remote emits no filesystem events, so incoming remote commits are detected by the regular poll timers (`cursorSettingSync.pollIntervalSeconds` and `cursorSettingSync.chatPollIntervalSeconds`, 30 seconds by default), not by the repository watcher. Expect up to one poll interval of latency before another device's pushed changes are pulled and applied.

### Repository size

GitHub rejects individual files over 100 MB and recommends keeping repositories below a few gigabytes. The extension scans the repository in git mode (during `Show Repository Usage` and at most once per hour after a publishing sync) and warns with the offending file and its size — lower `cursorSettingSync.maxPayloadMiB` or disable chat sync for such a repository. Because git history retains deleted event files, `Cursor Setting Sync: Checkpoint & Prune History` also squashes the git history into a single commit after a successful prune, force-pushes it, and reports the reclaimed space; other devices recover from the rewritten history automatically without losing their unpushed work.

## Platform support

Windows, macOS, and Linux are supported. The offline helper behaves identically on every platform; only the Cursor data paths and process-discovery commands differ. On Linux the repository watcher observes the fixed repository directory layout instead of one recursive watch, with identical debounce and filtering behavior.

## Recommended device handoff

Before moving from PC A to PC B:

1. Run `Cursor Setting Sync: Sync Now` on PC A.
2. Wait until the extension reports that the local repository write completed.
3. Close every Cursor window normally. The shutdown helper then captures database and workspace-storage changes.
4. Wait until OneDrive or Syncthing reports that the final repository files have uploaded.
5. Start or synchronize PC B.

The shutdown finalizer performs one last database export after Cursor exits normally. It cannot guarantee export after power loss, forced process termination, or an operating-system shutdown that kills the helper.

## Workspace storage synchronization

`cursorSettingSync.syncWorkspaceStorage` is enabled by default. The extension backs up only these payload entries below `%APPDATA%\Cursor\User\workspaceStorage\<workspace-id>`:

- supported `state.vscdb` rows, captured as a deterministic typed payload
- `notepads.json`
- Files below `images/`

`workspace.json` is read only to discover the workspace identity and URI. Its contents are not stored or restored as a payload. Explicit and automatically resolved workspace mappings canonicalize related workspace IDs into one synchronized resource identity while each PC retains its own local association.

Workspace storage is deliberately not scanned or applied while Cursor is running. After all Cursor processes exit, the shutdown helper captures the local allowlist. Incoming versions remain pending until `Cursor Setting Sync: Restart to Apply`; the helper exports the stopped local state first, checks for conflicts, validates incoming data, and then applies eligible files or database rows offline.

Transient SQLite files (`*-wal`, `*-shm`, and `*-journal`), prior database backups, renamed or corrupt database copies, and cache/session data are not backed up. This includes `anysphere.cursor-browser-extension`, `anysphere.cursor-retrieval`, `ms-vscode.js-debug`, and other non-allowlisted extension directories. File and workspace-directory deletions are never propagated because valid workspace sets commonly differ between PCs.

## Resolve conflicts

1. Run `Cursor Setting Sync: Resolve Conflicts`.
2. Every conflict is listed on one screen, named and with both sides' values beside it — `Setting: editor.fontSize · This PC: 14 vs Other PC: 16` — along with which PC wrote each side and when.
3. Answer the whole list at once with **Keep the version written later everywhere**, **Keep this PC's version everywhere** or **Keep the other PC's version everywhere**, or pick a single entry to open its diff and decide it on its own. **Decide later** leaves everything as it is.
4. The extension publishes a resolution event referencing every conflicting tip, batching the whole set into one event.

Nothing is lost by deferring: both versions stay in the repository until the conflict is resolved, and `Cursor Setting Sync: Restore Version History` can recover a side that lost.

A bulk answer only applies to the conflicts it names. With three or more PCs, a conflict between two *other* machines has no "this PC" side, so that conflict is left alone and reported rather than being given a different answer than the one asked for.

"Written later" means the timestamps shown on the same screen, not the synchronization protocol's own ordering. The two differ routinely — a PC that has not synchronized in a week publishes behind one that just did, however recently it was written, and two PCs editing between the same two polls are ordered by a device identifier rather than by time. Since the resolver shows you the times, it decides by them. Where a side carries no time to compare — a version folded into a checkpoint keeps none — the entry says so and the later-published side wins instead.

JSON and text resources attempt a semantic merge or diff3 merge when a common parent exists. Ambiguous changes remain conflicts. A JSON merge writes its result into the *common ancestor's* text, so both devices resolving the same fork emit identical bytes and the two independent merges collapse into one version; comments and formatting present in the ancestor survive.

A resource larger than `cursorSettingSync.maxPayloadMiB` is not published. It is skipped with a warning naming the resource, its size, and the remedies, and the rest of the cycle publishes and applies normally.

UI state resolves on its own instead of prompting. A value whose elements carry a stable `id` — pinned view containers (`workbench.activity.pinnedViewlets2`), every hidden-view list — is merged element by element, and anything else falls back to the newest writer, decided from replicated event ordering alone. Both devices compute the same bytes without talking to each other, so the two independent resolutions collapse into one version. Keys you would rather keep per-machine belong in `cursorSettingSync.ignoredUiStateKeys`.

Chat resolves on its own too, but by combining the two sides rather than choosing between them. A chat is a header, a conversation body and a list of messages keyed by ID, so a fork merges into the union of both sides' messages — nothing either PC captured is dropped — while the header and body come whole from the side with the newer `lastUpdatedAt`, which both devices read out of the same two payloads and therefore agree on. This works with or without a common ancestor; with one, a message the ancestor had and one side removed stays removed. A payload this build cannot parse is left as a conflict rather than resolved by discarding a side.

`.cursor` rules, settings, and extensions still ask, because there one side's loss is content you wrote and there is no way to combine the two.

## Apply database changes

The offline helper waits for Cursor to exit, acquires a lock, validates each database, and creates a recovery backup before modification. Live database files and sidecars are never replaced. Global, store, extension-state, and workspace changes use prepared SQL in `BEGIN IMMEDIATE`; integrity checks run before commit and failures use SQLite rollback. Workspace imports update or insert incoming keys while preserving target-only rows, unknown tables, and newer schema columns.

Apply payloads are limited to 512 MiB per restart. If pending items remain, run `Cursor Setting Sync: Restart to Apply` again.

## Restore a backup

1. Run `Cursor Setting Sync: Restore Backup`.
2. Select a `state-*.vscdb` backup.
3. Confirm **Import and Restart**. The backup is queried as a read source and is never installed over the live database file.

## Restore a previous version

1. Run `Cursor Setting Sync: Restore Version History`.
2. Select a resource. Resources with an active conflict must be resolved first, and resources whose kind is disabled in settings (chat or workspace storage synchronization turned off) cannot be restored.
3. Select a version. The current content, deletions, and versions created by a newer Cursor, VS Code base, or extension than the local installation are marked and cannot be selected. A diff preview of the current content against the selected version opens automatically.
4. Confirm **Restore Version**. The old content is re-published as a new version on top of the existing history; nothing is rewritten.
5. Database-backed kinds (chat, UI state, workspace storage, and similar) are applied offline; run `Cursor Setting Sync: Restart to Apply`.

A restored version keeps the original version's producer metadata, so the newer-version database safety gate keeps judging the version it came from. If another device pruned the selected version while it was being picked, the restore aborts cleanly; refresh the history and pick again.

## Checkpoint and prune history

`Cursor Setting Sync: Checkpoint & Prune History` folds the current state of every resource into one encrypted checkpoint file and, once every device has absorbed that checkpoint, deletes the event files it covers.

**Upgrade every device to a checkpoint-aware build before the first run.** After the first checkpoint is absorbed, events are written with a newer protocol version, and older builds fail loudly instead of silently rebuilding a partial history.

- The command requires a clean, fully propagated synchronization (no stream warnings) and no unresolved conflicts.
- Creating the checkpoint is the first phase; pruning becomes available only after every visible device has recorded the checkpoint in its acknowledgements. The command reports which device is still lagging.
- Pruning additionally waits until the checkpoint is 24 hours old so that devices that have not yet appeared in the shared folder are protected. An explicit confirmation can override the age gate when every device is known to be current.
- **History loss caveat:** pruned per-version history is unrecoverable. `Restore Version History` can then only reach versions still present as events or as the checkpoint's folded content, and conflicts whose common base was pruned degrade to manual resolution with a two-way diff.

## Diagnostics and maintenance

- `Cursor Setting Sync: Show Diagnostics` shows versions, database capabilities, schema results, the last error, and — for anything that is stuck — the reason rather than only a count: each pending change with what is blocking it, the conflicting resource IDs, every `cursorSettingSync.*` value actually in force (legacy-namespace fallbacks resolved), the machine-specific exclusion set, the git mode, the workspace mappings, and the adapters currently running. It also lists every standing warning with the adapter that produced it, how long it has been standing, and whether it blocks compaction and checkpointing. Standing warnings are logged once when they appear and then restated only once an hour, so this list — not the output channel — is the place to see what is currently true.
- `Cursor Setting Sync: Show Repository Usage` calculates shared repository size.
- `Cursor Setting Sync: Restore Version History` re-publishes an older version of a resource as the new current content.
- `Cursor Setting Sync: Compact Safe Orphans` removes safe local-device partials and objects that neither an event nor the absorbed checkpoint references; it requires a warning-free reconcile.
- `Cursor Setting Sync: Checkpoint & Prune History` folds history into a checkpoint and prunes covered event files once every device has absorbed it. The same fold also runs on its own once the event log passes 500 files, at most once every six hours, behind exactly the gates listed above — so the repository does not grow without bound just because nobody ran the command.
- `Cursor Setting Sync: Disconnect` clears this device's stored repository path, encryption key, and workspace mappings. The shared folder is untouched, so another device keeps synchronizing and this one can rejoin through `Setup`.
- `Cursor Setting Sync: Archive Repository` copies the complete repository to a separate directory.
- `Cursor Setting Sync: Forget Device` retires a device stream locally.

## Device-local authentication

Cursor account sessions, GitHub or Microsoft sign-in, extension `SecretStorage`, MCP OAuth tokens, and OS keychain credentials are not synchronized. Authenticate separately on each PC.
