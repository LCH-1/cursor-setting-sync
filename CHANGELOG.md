# Change Log

All notable changes to Cursor Setting Sync will be documented in this file.

## [0.0.32] - 2026-07-29

A concurrency-focused inspection of the whole extension - seven reviewers over multi-window races, extension-helper lifecycle, lock protocols, failure blast radius, republish loops, shared-folder semantics and cross-device convergence, every finding adversarially verified: 34 raised, 33 confirmed or downgraded-but-real. The reachable ones are fixed.

### Fixed - activation and multi-window

- Seven windows restoring at once no longer race to replace the shutdown finalizer with a 30-second timeout that killed the losing window's WHOLE activation ("Timed out replacing the shutdown finalizer"). Replacement now ends three ways, none fatal: armed (the old one exited), adopted (another window installed a newer finalizer - confirmed only after it holds the lock a full second, because one whose boot spanned this window's cancel marker self-cancels milliseconds after acquiring), or stalled (one is mid-export; a retry lands this session's finalizer a minute later). Arming is serialized per window, never throws, and reschedules itself on failure.
- Opening the repository now holds the sync lock, like the helper always has. An opening window's state save raced a sibling's live cycle and could revert projections and pending queues the cycle had just persisted - resurrecting resources another machine deleted.
- Helper results are claimed by atomic rename before being read, so restoring windows report each result exactly once; an apply failure consumed in ANY window re-arms the shutdown finalizer (the recovery used to live only in the window that launched the apply, which may be closed); a final-export success no longer clears the red bar a failed apply latched; and a failed applyAndRestart launch re-arms the finalizer it had just cancelled.
- A second window can no longer start a second Restart to Apply over the same queue while the first one's quit is in flight: committing to an apply leaves a marker other windows honor for three and a half minutes.
- A transient EPERM probing the sync lock (antivirus, cloud-sync tooling) skips the cycle instead of killing activation; the takeover of a stale readable lock re-checks the holder's liveness after the rename, closing a window where a heartbeat between the verdict and the rename lost its lock.

### Fixed - loops and cross-device convergence

- Four more republish loops of the 0.0.31 flood class: a non-pinned extension apply installs this machine's own "latest", and on a Cursor version skew the two machines re-published their versions at each other indefinitely - the helper now records the hash of what it actually installed, and the scan recognizes it as applied. A chat whose workspaceId was remapped (and whose header carries no timestamp) republished one event per restart on each machine - the written form's hash is recorded the same way. A profile manifest merged with local-only profiles echoed between machines forever - likewise. All three ride the retained-local mechanism workspace databases already used.
- A ui-state fork with three or more tips - several windows or machines each merging a different pair - had no two-tip shape, sat unresolved forever, and refused every checkpoint. It now resolves last-writer-wins, as does any fork on a policy-excluded key (the reactive-storage blob), which a 0.0.30 peer could otherwise re-derive against 0.0.31 every cycle.

### Fixed - shared-folder resilience

- One event whose payload had not crossed OneDrive yet no longer aborts every inbound apply cycle after cycle (extension side) or fails the whole shutdown batch (helper side): the resource defers itself, everything else applies, and it retries when the file arrives.
- An event file the checkpoint already covers that reads as zero-byte, truncated, torn or unauthenticated mid-propagation is skipped like the already-tolerated deleted one, instead of killing every cycle until it hydrates.
- Atomic writes retry the commit rename through transient cloud-sync locks the way reads always did, and a durably committed publish can no longer be reported failed over the advisory head.json.
- The two-repositories-in-one-folder wedge (Setup run on both computers before the cloud copied either) is explained with recovery steps instead of "Event belongs to a different repository."

### Known limits, accepted deliberately

- Restart to Apply still holds the sync lock while its workspace-mapping prompts are open; other windows skip cycles until the dialog is answered.
- Profile deletions still resurrect through the union merge (by design); only the infinite echo is gone.
- Two windows consuming two DIFFERENT helper results in the same instant can still lose one backup-list entry (the files themselves are untouched).

## [0.0.31] - 2026-07-29

### Changed

- Workspace state.vscdb synchronization carries content, not this machine's UI. A survey of every Remote-SSH workspace database on a real profile found ~160 distinct ItemTable keys, and all but a handful were per-machine workbench state - layout mementos, open-tab lists, view sizes, search history, extension scratch, cmd-K usage logs - rows both computers rewrite continuously whenever they have the same workspace open. Two machines quitting around the same time forked those rows into a conflict no row-level merge can resolve, and the manual resolver's whole-tip answer threw one side's layout away for nothing. ItemTable is now restricted to an allowlist of portable rows (`notepadData`, `notepad.reactiveStorageId`, `interactive.sessions`, `debug.breakpoint`); `cursorDiskKV` and `composerHeaders` still travel whole, because Cursor uses them for conversation-class data. The filter is symmetric - scan, helper apply, and conflict merge - so chrome in events published by earlier versions is skipped on write and cannot make a filtered snapshot read as having deleted it, which would have turned the transition itself into a conflict. Each machine's UI state stays its own; the helper's physical pre-write backups still copy whole database files, so local restore coverage is unchanged. Chats are unaffected - they live in the global database and merge per conversation.

### Fixed

- Cursor's reactive-storage blob (`src.vs.platform.reactivestorage...persistentStorage.applicationUser`) is policy-excluded from ui-state sync. Cursor registers it as a roaming key, but it is a ~360 KiB JSON document the app rewrites continuously while it runs - measured on this repository at a new event every 15-30 seconds for six hours straight on an otherwise idle machine, over 1,100 events in one evening. A value both machines rewrite nonstop can never converge; it only churns the repository and elects arbitrary last-writer winners. Policy exclusion, not a security denial: events already published for it are skipped harmlessly, never fatal, and no deletion is published for it.
- A workspace kept open on two computers no longer republishes its storage snapshot on every cycle: the published bytes were changing whenever the workbench touched a chrome row, and now they only change when portable content does.

## [0.0.30] - 2026-07-28

A full-code inspection pass: seven reviewers over every subsystem, each finding adversarially re-verified against the code before being accepted. 34 confirmed defects fixed.

### Fixed - backup safety

- One enablement backup per database per request, and retention now exempts every backup the running request has taken. Each extension whose enablement changed used to trigger its own full copy of the target database - three default-profile extensions at 1.3 GiB apiece blew the 4 GiB budget, and because each retention pass exempted only its own newest file, it evicted the same request's pre-apply global backup: the exact loss the budget was introduced to prevent, arriving through a different door. The enablement path also threads the lock heartbeat through its multi-GiB integrity passes now.
- A workspace whose `workspace.json` is unreadable - a 0-byte file from a crash mid-write - is no longer classified as a window with no folder open and silently dropped from the shutdown backup. Unknown is not folderless: its storage is backed up, and the discovery result is not memoized while any entry is unreadable, so the repaired file is noticed.
- `restore-backup` mode re-verifies that Cursor is still closed immediately before its destructive DELETE+INSERT - previously the only check was the exit wait, minutes earlier, and a user relaunching Cursor in that window got a restore reported as successful and then silently undone by Cursor's in-memory write-back at its next quit. The pre-restore git pull is skipped entirely (a restore reads no events), which removes the largest part of the window; replaying an interrupted restore journal re-checks the same way.
- A restore journal whose backup no longer validates - damaged since the interruption, or written for a schema Cursor has since changed - is marked failed and skipped instead of throwing out of the recovery loop. That loop runs first in every helper mode, so one bad journal used to fail every later apply AND every shutdown export, forever.
- Plain-file workspaceStorage writes (notepads.json, images) and chat transcripts re-check exclusivity before writing, like every database branch already did; Cursor appends to live transcripts, so writing one under a relaunched Cursor truncates a session it is still recording.
- An optional table absent from one side's snapshot - a Cursor whose schema has no `composerHeaders` - is treated as no opinion rather than as "every row deleted", which silently dropped the whole table from an auto-resolved workspace database merge.
- `archiveRepository` holds the sync lock for the whole copy, so its own window's poll, automatic maintenance, or the offline helper can no longer delete files mid-enumeration and tear the archive; `copyFileAtomic` fsyncs and cleans up its temp file like `writeFileAtomic` always has.
- A backup file with a far-future mtime (clock rollback, restored directory) can no longer pin itself permanently at the top of the retention order.

### Fixed - cross-device

- Historical events and checkpoints are validated against the protocol ceiling rather than this device's live `maxPayloadMiB`. Device A raising the limit and publishing something large wedged every cycle on device B until a human raised B's setting too - and settings sync could not fix it, because settings ride the same wedged log. Reads are widened; local publishes stay bounded by the live setting.
- `git clone` runs under the 600-second network timeout it was always meant to have. The subcommand detector took the first argument not starting with a dash, which in `-c core.autocrlf=false clone ...` is `core.autocrlf=false` - so joins of a large repository over a slow link were killed at 120 s, the partial clone deleted, nothing resumable. Timeout kill messages also report the timeout that actually applied.
- An unreadable sync lock file is no longer taken over on unreadability alone - it is usually another window caught in the milliseconds between creating the file and writing its content, and stealing it there let two processes run full cycles concurrently. Age is the tiebreaker now, with the same TTL the readable path uses, re-checked after the takeover rename.

### Fixed - resilience and honesty

- Re-running Setup with a wrong passphrase no longer kills sync until reload: the replacement repository is opened before the running state is torn down, so a failed open leaves the previous configuration synchronizing untouched - instead of a zeroed-but-non-null master key that a later Restart to Apply would hand to the helper.
- A "Sync Now" issued while automatic maintenance holds the lock is no longer silently swallowed: the drain loop re-checks the queue after maintenance instead of resolving the caller's await with no sync run.
- The red helper-failure bar clears when the queue it described is empty, and Disconnect resets it together with notices and the declined-offer memory.
- Startup no longer reports a live, deliberately waiting helper as "never reported a result" and deletes its request file: a fresh finalizer heartbeat or a request younger than the exit-wait budget is a helper that has not had time yet, not an abandoned one.
- One invalid directory under `User/profiles` ("New folder", a Syncthing conflict) no longer disables the entire settings and profile-files scans on every cycle; the entry is skipped, matching what Cursor itself does with it.
- The extension scan's CLI memo is no longer invalidated by the global database's mtime, which moves on virtually every poll during active use - the default profile spawned Electron-as-node every thirty seconds for the life of the session. The database mtime now refreshes only the cheap disabled-list read it actually feeds.
- Ignore patterns starting with `**/` match zero directories, as they do in gitignore: `**/secret.md` now covers a top-level `secret.md`.
- A profile settings file that fails to parse no longer causes every configured `ignoredSettings` entry to be misreported as a typo excluding nothing.
- Torn `product.json` degrades to unknown versions in the compatibility report instead of killing activation before any command is registered; a failure before the helper's exit wait finished no longer relaunches Cursor beside the one still open; `restoreAndRestart` arms the quit-stall warning it was missing; reconciliation survives 100k-event backlogs and 10k-deep version chains (argument-spread and recursion limits); `publishInBatches` splits by estimated manifest bytes as well as change count; the device no longer schedules a redundant sync cycle over its own checkpoint; a duplicated multi-GiB integrity pass per backup is gone.

### Added

- Tests for every restore contract the Restore Backup command can request (workspace, store, item-table), for `final-export` mode through the built bundle - the only path that ever exports workspaceStorage had no test at any level - and its supersede handling, for restore-journal failure recovery, for the quit-timer arming order, and pins for the retention defaults and the sidecar/exemption rules. A release run now fails loudly if the end-to-end suite would be skipped because the bundle was not built.

## [0.0.29] - 2026-07-28

### Fixed

- An apply could carry less than it said it would, without saying so. A queued change whose payload does not fit the remaining per-apply budget was dropped from the request with a bare `continue`: the helper then reported a complete success, the queue went down by less than the dialog had counted, and what was left looked exactly like the queue that would not drain - a reading this project has already chased twice for other reasons. The remainder is counted now. The offer says how many are too large to carry in the same pass and that they are offered again once this one finishes, and the output channel records the split before Cursor quits, which is where it survives the window being closed. The prompt's old hedge that a large queue "may need more than one pass" is gone: it appeared on every queue alike, including the ones that fit whole.

### Added

- An end-to-end test for the helper's `restore-backup` mode, which is what **Cursor Setting Sync: Restore Backup** launches. The restore itself was covered, but nothing had ever run the bundle in that mode, and its request carries three fields no other mode uses - a typo in any of them would have failed only in front of a user who had already lost something.

## [0.0.28] - 2026-07-28

### Fixed

- Journal sidecars were evicting the backups they belonged to. `backup()` copies the journal mode of its source, so a snapshot of a live Cursor database is itself in WAL mode, and every later read-only open of it - the validation that runs immediately after it is written, a restore's `ATTACH` - recreates `-wal` and `-shm` beside it and cannot unlink them again, because a read-only connection may not run the closing checkpoint. Written last, they were also the newest files in the directory, so newest-first retention kept them and deleted real recovery points to stay inside its budget. On the machine this was found on, twenty-two of the thirty retained files were sidecars holding nothing and eight were backups. A backup is now sealed into rollback-journal mode as soon as it is written, so reading it creates nothing; retention treats a snapshot and its sidecars as one recovery point, counted once and evicted together; and a sidecar whose database is gone is removed on sight, which is what clears a directory earlier versions filled.

### Changed

- The local backup budget is 4 GiB rather than 2 GiB, and the count limit is thirty backups rather than thirty files. 2 GiB is less than twice the size a heavily used global database reaches - 1.29 GiB on the machine measured - so the budget held exactly one global snapshot and every apply deleted the previous one. The only recovery point was the state immediately before the newest apply, so an apply whose damage was noticed one apply later had nothing left to roll back to. Two generations now fit, alongside the small per-workspace snapshots taken in the same run.

## [0.0.27] - 2026-07-28

### Fixed

- A configured device sat permanently at **Partial - some resources were not saved to the repository** for doing exactly what it was configured to do. Local workspaces excluded by `syncLocalWorkspaces`, storage from windows with no folder open, settings keys the built-in machine-scoped list took over, and conversations whose body Cursor pruned all travelled on the same channel as a genuine failure to save, and the scan re-derives every one of them on every run - so the amber never cleared and the sentence describing it was untrue of all four. Deliberate exclusions now have their own channel: still logged, still listed in diagnostics under `deliberateExclusions`, never counted and never amber. What remains amber is what the words say - on this repository, one workspaceStorage database whose SQLite index is corrupt and which therefore genuinely is not being backed up.

## [0.0.26] - 2026-07-28

### Fixed

- Three changes that no number of applies could drain, offered again on every launch. Leaving the queue is observational: an entry goes when a later scan finds the value already local, and nothing is dequeued on the helper's word - that the helper wrote a row is not evidence Cursor kept it. The cost is that a resource this device's own scan never emits can never be seen to arrive. Both kinds that hit it were already refused on the way out and had no matching refusal on the way in: workspaceStorage from a window with no folder open, whose directory is named after the millisecond that window opened, and `empty-state-draft`, the non-UUID composer row every Cursor installation keeps. Both devices publish their own copy, the copies conflict, and neither side can ever apply the other's. They are now dropped from the queue on arrival rather than deferred, so nothing asks about them again. Measured against this repository: 8 of 1237 workspaceStorage resources and 1 of 513 chats - exactly the set that would not drain.

### Changed

- The launch offer counts what the command would actually apply, not what is merely unblocked. A queue made entirely of entries that are dropped on arrival, or that fall outside the batch, raised a dialog about work that did not exist - once for real, seconds before those entries were dropped.

## [0.0.25] - 2026-07-28

### Fixed

- A queue that nothing but the command palette could drain. Everything about the wait says to close Cursor - the changes "can only be written while Cursor is closed", the status item reads "Queued" - and closing Cursor is the one thing that does not write them, because the queue is applied by an offline helper that only **Cursor Setting Sync: Restart to Apply** launches. A device sat at seventy-one queued changes across three restarts: the owner had done what the queue appeared to ask for, the number never moved, and nothing on screen distinguished that from a broken feature. The offer that until now appeared only at the end of setup is raised on any launch that finds changes waiting, and says outright that restarting Cursor is not what applies them. Declining is remembered for the session, one window raises it rather than every window, and it stops appearing when the queue is empty - which is what applying it does.

## [0.0.24] - 2026-07-28

### Fixed

- Sixty-nine chats were held back by a rule that was never about them. 0.0.13 stopped asking about workspaceStorage from a window with no folder open - its directory is named after the millisecond the window was created, so it identifies a window on one computer and nothing at all on any other - but the check ran before the branch that handles chats, so a chat carrying a workspace ID whose URI had not travelled was deferred too, under a message about workspace storage that no one could act on. The queue reported **71 database change(s) are deferred** when two of them were workspaceStorage. The check is scoped to workspaceStorage now.

### Changed

- workspaceStorage from a folderless window is no longer backed up either. Not asking about incoming ones only fixed half of it; the device that owned them went on publishing them, so they accumulated in the repository as changes no other computer could ever place. With local folder workspaces already excluded by default, what remains is Remote-SSH - the workspaces that genuinely exist on more than one machine. The exclusion is skipped entirely when workspace discovery returns nothing, because a workspace missing from a map that was never built is not evidence about that workspace, and dropping a backup on that basis is the one mistake this adapter must not make.

## [0.0.23] - 2026-07-28

### Fixed

- The status bar item read like the name of a command it no longer ran. 0.0.18 pointed its click at diagnostics so that quitting Cursor was never one misclick away from the item beside it, but left the label saying **Restart to Apply** - so pressing it handed back a diagnostics document, which is worse than either behaviour on its own. It now describes the state it is in, **Cursor Setting Sync: Queued**, and the tooltip says where the command lives. The click still only reports.

## [0.0.22] - 2026-07-28

### Fixed

- A malformed `product.json` killed the helper outright. An unreadable one already downgraded the version re-check to a warning — for the AppImage whose root unmounts together with the process that created the request — but a torn or half-written one reached `JSON.parse`, which threw past that guard and took the whole apply down before it had written anything. Both are facts about the installation rather than about whether the queued changes are safe to apply, so both downgrade now.

### Added

- An end-to-end test that runs the built `dist/helper.js` the way the extension runs it: a request file on disk, the repository key on stdin, a real spawn. It publishes a change as another device, applies it, and checks that the row reaches the database, that the pre-apply backup exists and predates the write, and that restoring that backup rolls the write back. Every failure in this series lived in the orchestration around the apply — the exit wait, what counts as a running Cursor, the lock, the request and result files — and not one unit test could see any of it, because none of them ran the bundle. This one found the `product.json` defect above on its first run. It skips itself while Cursor is running, since the helper's first act is to wait for Cursor to exit.

## [0.0.21] - 2026-07-28

### Fixed

- The offline helper waited for a process that was never going to exit. Cursor's `crashpad-handler` shares the `Cursor.exe` name, exists to catch a crash during shutdown - so it is deliberately among the last to go - and on Windows it is routinely orphaned outright. One machine sat with a single crashpad-handler, no window at all, and a helper that had been waiting twenty minutes; the count it consults saw a running Cursor and would have gone on seeing one forever. It holds no database, and every `CursorExitTimeoutError` in this series, including the ones reporting "1 Cursor process(es) are still running", traces back to counting it. It is excluded now. The classification needs command lines, which `tasklist` does not provide, so it runs only when survivors exist - the ordinary case is none - and is cached for the rest of the wait. If command lines cannot be read at all, every survivor keeps counting, which errs towards waiting rather than towards writing while Cursor is alive.

## [0.0.20] - 2026-07-27

### Fixed

- A helper that died before it could report anything left no trace at all. It was spawned with stderr discarded, so a failure at import time - a missing module, a bad runtime, a script that is no longer on disk - produced nothing but an unconsumed request file and a queue that never shrank. stderr now goes to a log beside the request, and any helper that was launched and never reported back is named in the output channel on the next start, together with whatever it managed to write.
- Upgrading left orphaned helper requests behind. A request records the helper script inside the extension version that wrote it, and installing a new version deletes that directory - so a shutdown finalizer armed moments before an upgrade points at a file that no longer exists and can never start. Seven of them had accumulated on one machine. That case is recognised and cleared silently; every other kind of abandoned request is reported.

## [0.0.19] - 2026-07-27

### Changed

- The status bar says when it is working. A cycle on a large repository runs for minutes, and the item was deliberately left untouched whenever a conflict or a queued change existed — so during exactly the wait that matters, someone watching for their chats to arrive saw a state that never changed and no way to tell progress from a stall. It now reads **Cursor Setting Sync: Syncing…** while a cycle is running, and returns to the actionable state the moment it ends. Short cycles still never touch the item; the two-second delay that prevented flicker is unchanged.
- The item's wording follows the state it is in: **Setup** before there is a repository, **Restart to Apply** while changes are queued, **Syncing…** while a cycle runs, and a plain check mark once everything has landed.

### Fixed

- A raw NUL byte had been written into `src/sync/manager.ts` as the separator in a cache key, which compiled and ran correctly but made every text tool treat the file as binary — `grep` reported "Binary file matches" instead of results. It is the same separator, spelled as an escape.

## [0.0.18] - 2026-07-27

### Fixed

- The synchronization lock went stale under a holder that was very much alive, and another process could take it over mid-write. `node:sqlite` is synchronous, so a large apply holds the event loop for minutes and the lock's heartbeat — an interval timer — never gets to run. The lock file's mtime stopped advancing, which is exactly what the staleness rule reads as an abandoned holder: a ten-minute apply came within five minutes of having its lock stolen while it was still writing to the database. It also made the busy message report the holder as "last active 8 minute(s) ago" about a helper that was working the whole time. `FileLock.refresh` was written for this and had no callers; the apply loops now call it between changes.

### Changed

- The status bar no longer quits Cursor when clicked. The pending-restart item ran `Restart to Apply` directly, which is a large thing to do to someone aiming for the item beside it, and the command is a rare deliberate one rather than something that earns a permanent button. Clicking now opens diagnostics; the item's text and tooltip still name the command, so the palette is one step away.

## [0.0.17] - 2026-07-27

### Fixed

- One never-saved scratch buffer stopped `Restart to Apply` from working at all. The command ran `workbench.action.files.saveAll` before quitting, and for an untitled document that opens the native **Save As** dialog and waits — so the `await` never resolved, `workbench.action.quit` on the very next line was never issued, and the offline helper sat through its entire exit budget before reporting that Cursor had not exited. The dialog is easy to miss behind the window, which is why this looked like a quit that silently did nothing. Dirty editors that already have a file are still saved; untitled ones are left to `files.hotExit`, which preserves them across a quit by default and is exactly what would have happened had the command never asked.

## [0.0.16] - 2026-07-27

### Fixed

- "1 Cursor process(es) are still running" named a process this extension had started itself. The shutdown finalizer is a headless `Cursor.exe`, and once past its own wait it stops checking whether it has been cancelled — so it stays in the process table for as long as its export takes, which on a repository holding a thousand workspaceStorage resources is minutes. An apply helper counted it as a running Cursor, waited out its full 180 seconds and gave up, telling the user to close a window that does not exist and naming a process they must not kill: it is the only path that ever backs up workspaceStorage. Its pid is now read from the lock it holds and left out of the count — but only while that lock is fresh, because a stale one names a recycled pid, and subtracting that would remove a genuine Cursor window from the list the exit wait depends on. Exclusivity against a real Cursor is unchanged, and the two helpers still serialize on `sync.lock`, which is the actual mutex.

## [0.0.15] - 2026-07-27

### Changed

- Setting up a new computer is one flow. A machine that has just joined necessarily has a full queue — extensions, profiles, chats and UI state all arrive at once, and none of them can be written while Cursor is running — so setup ended with a toast and left the user to discover a second command on their own. It now offers the apply directly. Declining is free and the status bar still carries it. The offer deliberately fires only from setup, because setup is also the documented way to unlock an established device, and on that device the queue is the ordinary flow of incoming chats rather than a one-time cost of joining. The wording does not promise the queue will empty in one pass: a large one exceeds the 512 MiB apply batch and needs another.
- The "configured" notice, which names `mcp.json` and `cli-config.json` as files that may carry API keys, is now written to the output channel as well as shown. The offer above can quit Cursor within seconds of it appearing.

### Fixed

- Applying an extension copied the entire global database, once per extension, whether or not anything changed. `updateExtensionEnablement` took a full `backupDatabase` before it read the row it might modify, and named the copy after the extension — so a request touching a dozen extensions wrote a dozen copies of a database that is 1,239 MiB on a real user's machine, blew the 2 GiB retention budget, and evicted the global apply's own backup along with it. Almost none of those copies protected anything: an extension arrives enabled and is simply absent from the disabled list, so there was nothing to write. The row is now read first, on a read-only connection, and the backup is taken only when the write would actually change it. An unreadable database still takes the backup, which is exactly when it earns its keep.

## [0.0.14] - 2026-07-27

### Fixed

- Every command could be defeated by a routine background poll. Each took the synchronization lock in a single attempt and failed outright if the thirty-second cycle happened to hold it, so `Restart to Apply`, `Checkpoint & Prune History`, `Restore Version`, `Compact Safe Orphans`, `Forget Device` and the conflict resolver's refresh all reported *another Cursor window or the offline helper is synchronizing* and did nothing. `Restart to Apply` was the worst of them: it runs a full sync first, which releases the lock, and then raced the background cycle for it a moment later — so the command reliably lost to its own preparation. All of them now wait up to a minute, showing *Waiting for the current synchronization to finish…*, which is the only outcome anyone would have chosen: a poll is seconds of work. Only the poll itself still gives up immediately, which is what it should do. 0.0.6 fixed this for the conflict resolver's apply step; the other eight call sites were left behind.
- The busy message no longer sends people looking for a window that is not there. When the lock is held by this window's own background cycle — which is the usual case, and the only one closing something cannot fix — it says so instead of naming "another Cursor window or the offline helper".

## [0.0.13] - 2026-07-27

### Fixed

- A window with no folder open produced a mapping prompt that could never be answered. VS Code names the storage for such a window after the millisecond it was created, so the modal read *Map incoming workspace storage workspace `1784792272718`* over a list of every local workspace — none of which was it, because that name identifies a window on one computer and can identify nothing on any other. It reappeared on every attempt, and until it was answered nothing else in the queue could apply. Incoming workspaceStorage that carries no folder URI is now set aside with a reason instead of asked about. It is still published by the device that owns it; leaving that alone needs `discoverWorkspaces` to distinguish "no workspace.json" from "workspace.json this scan could not read", and treating the second as the first would silently drop a real backup.

## [0.0.12] - 2026-07-27

### Fixed

- A chat written in a folder that exists on only one computer never reached the other one. The apply path answered `workspace mapping required` and dropped the change, while the extension host raised a modal — *Map incoming chat workspace `file:///…/projects/cbtpassmap`* — listing every local workspace, none of which was that folder, because that folder had never existed on this machine. There was no answerable option, and until the modal was answered nothing else in the queue could apply either. A chat is content rather than per-workspace scaffolding, so it is now written under the workspace ID it was created with instead of being withheld: that ID is a hash of the folder URI, so if this computer ever opens the same folder at the same path the conversation is already where Cursor looks for it, and a workspace ID naming nothing local is a state Cursor already handles — it is what a deleted workspace folder leaves behind. Declining to map a workspace no longer withholds its conversations either. The prompt remains for workspaceStorage alone, where writing to an unmapped location really would be wrong.

## [0.0.11] - 2026-07-27

### Changed

- **Local folder workspaces no longer take part in workspaceStorage sync by default.** A `file://` workspace is identified by its path, so unless both computers open the same project at the identical path there is nothing on the other side for its storage to land on — and what actually happened to those resources was a modal listing hundreds of unrelated workspaces, asking the user to map one that does not exist, which had to be answered before anything else could apply. Remote-SSH workspaces, which are the ones that genuinely exist on more than one computer, are unaffected and always synchronize; chats are unaffected either way. `cursorSettingSync.syncLocalWorkspaces` turns the old behaviour back on for anyone whose projects do live at the same paths everywhere, and like `ignoredWorkspaces` it is machine-scoped, so answering the question on one computer does not answer it for the other.
- A workspace this device had already been backing up that the new default now excludes is named in a warning rather than dropped in silence. The same reasoning as the built-in machine-specific settings list: a resource that stops travelling with no tombstone, no status change and a green check mark is one the user discovers only when they need the backup. Existing backups stay in the repository.

## [0.0.10] - 2026-07-27

### Added

- `cursorSettingSync.ignoredWorkspaces` keeps a computer out of workspaces it has no business holding. Set it to `["file://*"]` and only Remote-SSH workspaces are backed up or written — a local folder path exists on exactly one machine, so its incoming workspaceStorage can never be matched on another and does nothing but sit in the queue asking to be mapped to something that is not there. Wildcards work (`vscode-remote://ssh-remote+staging*`), and the percent-encoded form Cursor stores is matched against the readable pattern a person would write. The setting is machine-scoped: unlike every other `cursorSettingSync.*` key it does not travel, because which projects live on a computer is a fact about that computer, and a shared list would switch the other machine's backups off as a side effect of curating this one's. Chats are unaffected.

### Fixed

- The same SSH server was treated as two unrelated machines. Cursor records a Remote-SSH host either as the plain alias — `ssh-remote+geekdive_local2` — or as a hex-encoded JSON descriptor, `ssh-remote+7b22686f73744e616d65223a226765656b646976655f6c6f63616c32227d`, which is `{"hostName":"geekdive_local2"}`; which one appears depends on how the connection was opened, and both occur on one machine. VS Code hashes that URI into the workspaceStorage directory name, so the same folder on the same server became two workspaces with nothing in common — and every chat written there stopped at a mapping prompt offering hundreds of entries, none of which was the right answer. On the setup that prompted this, 35 remote folders were split that way, including the one whose chats had gone missing. The two spellings now compare equal.
- The automatic quit could fail silently for three minutes. `Restart to Apply` issues `workbench.action.quit`, which is advisory: when nothing acts on it there is no error and no dialog, and the first sign of trouble was the offline helper reporting a timeout long afterwards. If Cursor is still open fifteen seconds after the command, this now says so while the helper is still waiting — closing Cursor by hand at that point still completes the apply, because the helper waits for the windows to go away rather than for the command it sent. The message deliberately never suggests ending Cursor tasks: the helper is itself a `Cursor.exe`, and so is the shutdown finalizer whose only job is the workspaceStorage backup.
- Both post-quit timers were armed after the awaited quit, so a quit whose promise never settled left them unarmed — and with them the shutdown finalizer un-rearmed, costing the session its only workspaceStorage export on exactly the runs where the quit misfired. They are armed before the quit now.
- A deferred change is reported with the reason it actually carries. The status bar said "newer-version database change(s) are deferred" because that was once the only reason there was; an excluded workspace is another, and a count with the wrong explanation attached sends the user looking for a Cursor upgrade that would not help.

## [0.0.9] - 2026-07-27

### Fixed

- Pruning history could silently discard an incoming resource. Every prune republishes one current tip as a marker event so old builds meet a v2 event and fail loudly, and it reads that content out of the repository — so on a device that has not applied the resource yet, the marker is purely the *other* device's work wearing this device's identity. `applyProjections` skips a tip carrying this device's own ID, because re-applying its own scan is pointless, and the marker was not classified as synthetic, so it took that branch: the resource was recorded as applied with nothing written. For the kinds only the offline helper can apply, the next scan then found a projection with no matching row and published a tombstone over the other device's copy. The marker now counts as synthetic, and it prefers a resource the running Cursor can write itself — `chat-store/`, `chat-transcript/` and `chat/` sort ahead of `settings/`, so the alphabetically-first readable tip was almost always a chat. On the two-machine setup that prompted this, the resource it would have picked was one of 146 chats that existed on one PC only.
- An offline helper that failed was invisible for as long as Cursor kept running. `Restart to Apply` hands the queue to the helper and quits; if the quit is vetoed, or the helper's exit wait expires because a window is still open, it writes a failure and Cursor never restarts — and the result file was read only during activation. Nothing appeared: no notification, no log line, and a status bar still offering the command that had just failed. Results are now read on every synchronization cycle and when a vetoed quit is detected, the failure is stated in a notification that offers the retry directly, and it outranks the queue in the status bar instead of being repainted by it on the next cycle. The failure text is one sentence rather than a `helper.js` stack, and the two halves that are only correct once — folding the helper's warnings into the standing set, and the startup status repaint — still run only at startup, because a superseded shutdown finalizer reports no warnings and would otherwise clear the standing warning that a workspaceStorage backup was dropped.
- "Timed out waiting for Cursor to exit." now says what is still running. It names the surviving process IDs, points out that a window minimized, on another desktop, or waiting on a "save your changes?" prompt keeps the whole application alive, and deliberately never names this extension's own shutdown helper — that one exits by itself, and killing it destroys the session's workspaceStorage backup, which is the only one ever taken.
- The status bar said "N change(s) are waiting for restart", and a plain restart is the one action that provably does nothing: the shutdown finalizer exports this device's changes and returns without applying, so only the command writes anything. A user read it the obvious way, quit and relaunched repeatedly — eventually force-quitting every process — while 146 incoming chats sat untouched. The item now reads **Cursor Setting Sync: Restart to Apply**, names the command in its tooltip, says outright that quitting and reopening does not apply the queue, and breaks the count down by kind so "175 chat" identifies what is missing where "227 change(s)" did not. The README described the command the same wrong way and is corrected.
- A held synchronization lock no longer floods the output channel. Every poll that could not take it wrote a full line, so a lock held through a long cycle or an offline helper run — the ordinary case — cost two lines every thirty seconds per window, indefinitely, burying the standing warnings the channel exists to show. An hour of continuous contention is now thirteen lines instead of a hundred and twenty. Suppression keys on the holder's process ID rather than on the message, which carries an age that changes every minute; a different holder, a manual sync, or five minutes of silence all report again, so a lock held for an hour is still visible.

## [0.0.8] - 2026-07-26

### Fixed

- Answering the conflict resolver could throw away every answer. The prompt deliberately runs without the synchronization lock, because it can stay open indefinitely, and the lock is re-taken to publish the result — so a routine background poll starting in that window failed the whole set with "Another Cursor window or the offline helper is synchronizing", and the decisions were discarded. That window is at its widest exactly when it matters most, right after a large batch of conflicts is resolved and the cycles are long. The apply step now waits up to a minute for the poll to finish, showing what it is waiting for, and only gives up after that. The lock's own "another Cursor window" wording was the other half of the confusion: the holder is usually this window's own background cycle.
- Every chat conflict was labelled with a raw JSON document — `Chat: {"type":"head","composerId":"empty-state-draft","lastUpdate...` — where the conversation's name belongs. `composerHeaders.value` is not a title but a record describing the conversation, and the title is its `name` field. A chat with no name yet falls back to its composer ID rather than to a brace.

## [0.0.7] - 2026-07-26

### Fixed

- Reading any object larger than about four megabytes threw `RangeError: Maximum call stack size exceeded` and, from `autoMergeConflicts`, took the entire synchronization cycle with it — nothing published, nothing applied, no ack, on every poll. The base64 validator every envelope passes through used the pattern `/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/`, and V8 pushes a backtracking frame per four-character group as soon as the trailing optional group forces the star to give one back. It is now a character scan with no regular expression and no recursion, verified against the old pattern over 646,801 inputs for identical behaviour. The same pattern was in four places — the event, object and checkpoint envelopes, chat snapshots, `store.db` snapshots and workspace database snapshots — and all four are fixed. This was a latent fault in every release; 0.0.6 reached it because merging a chat conflict is the first thing that reads a multi-megabyte chat payload, and a chat is base64 message bodies, which do not compress.
- One conflict can no longer end a synchronization cycle. `autoMergeConflicts` documented that an escaping error would stop the device permanently — the events are immutable, so the next poll rebuilds the identical conflict and throws again — but it only handled the failures it anticipated. Every conflict is now processed under a guard: an unexpected error leaves that one conflict for manual resolution, names it and its reason in the output channel, and the rest of the cycle runs.

## [0.0.6] - 2026-07-25

### Added

- Chat conflicts resolve themselves, by combining the two sides instead of choosing between them. A chat payload is a header, a conversation body and a list of messages keyed by ID, so a fork merges into the union of both sides' messages — nothing either PC captured is dropped — while the header and body are adopted whole from the side with the newer `lastUpdatedAt`. Both devices read that timestamp out of the same two payloads, so both elect the same winner and publish byte-identical content and identical metadata with no round trip. This works with or without a common ancestor; with one, a message the ancestor had and one side removed stays removed. A payload that fails the same parse the apply side performs is left as a conflict rather than resolved by discarding a side, so this never trades a conversation for a cleared warning. On the two-machine setup that prompted the change this was 36 unresolvable conflicts, 32 of which held the same conversation on both sides — identical message counts and identical `lastUpdatedAt` — and differed only in machine-local header fields such as `recency`. Nobody could have adjudicated those from a diff, which is why they had sat there.
- `Cursor Setting Sync: Resolve Conflicts` lists every conflict on one screen and can answer all of them at once. Each entry is named by the resource's own name and shows both sides' values, which PC wrote each, and how long ago: `Setting: editor.fontSize · This PC: 14 vs Other PC: 16`. **Keep the version written later everywhere**, **Keep this PC's version everywhere** and **Keep the other PC's version everywhere** settle the whole list; a single entry can still be opened for its diff and decided alone. "Written later" means the times printed on that screen and not the protocol's own ordering, because the two disagree exactly when a fork is interesting: a PC that has not synchronized in a week publishes behind one that just did however recently it was written, and two PCs editing between the same two polls are ordered by a device identifier rather than by time. Where a side carries no time to compare — a version folded into a checkpoint keeps none — the entry says so and the later-published side wins. A bulk answer is applied only to the conflicts it actually names — with three or more PCs a conflict between two *other* machines has no "this PC" side, and that conflict is reported rather than given a different answer than the one asked for. The whole resolution is published as one event instead of one event per conflict, and a single resolution the repository refuses no longer costs the others in its batch.

### Changed

- A composer row whose ID is not a chat ID is no longer published. `parsePortableChatSnapshot` is the apply-side gate as well, so every device that received one rejected it; publishing it anyway cost an event, a payload object, a pending change that never cleared, and — once the other machine published its own copy — a conflict with no automatic resolution and nothing a person could adjudicate. Cursor keeps at least one of these permanently (`empty-state-draft`). Such a row is skipped in silence and never published as a deletion, so an existing value on another device is left untouched.

### Fixed

- The conflict resolver asked the user to choose between two hashes. Each conflict was presented as `Local · Lamport 42` against `Remote · Lamport 41` with a truncated semantic hash and a version ID — no resource name, no values, no wall-clock time, and a logical clock in place of one. It also opened a diff editor for *every* conflict before prompting, one modal prompt at a time, and cancelling any single prompt discarded every decision already made. Backing out of an individual conflict now returns to the list, and leaving the list keeps what was already decided.
- Conflicts that could not be resolved were reported only when *nothing* resolved. A run that settled most of the list and skipped the rest — which is the normal outcome of a bulk answer — said nothing at all about the ones it skipped. Every deferred conflict is now named in the output channel and counted in the notification whatever else happened in the same run.

## [0.0.5] - 2026-07-25

### Added

- Machine-specific settings are excluded by default. `window.zoomLevel`, `terminal.integrated.defaultProfile.*`, `git.path`, `http.proxy*`, `remote.SSH.*` and the rest of the built-in list describe the computer rather than a preference, and VS Code registers them in workbench code where no extension scan can see them — so a corporate proxy URL with credentials in it, or a shell path that exists on one PC only, used to travel verbatim. The list is deliberately narrow: keys VS Code's own Settings Sync propagates between machines — `terminal.integrated.profiles.*`, `terminal.integrated.env.*`, `files.simpleDialog.enable`, `python.venvPath` — are *not* on it. Because a newly excluded key would otherwise stop travelling in silence (no tombstone, no status change, a green check mark), a key this device had already synchronized is named in the output channel when the defaults take it over, and the same notice stays in Show Diagnostics under the standing warnings. Set `cursorSettingSync.useDefaultIgnoredSettings` to `false` to synchronize the whole list anyway; Show Diagnostics lists the effective set.
- `ignoredSettings`, `ignoredExtensions`, `ignoredUserFiles` and `ignoredUiStateKeys` accept wildcards: `remote.SSH.*`, `ms-python.*`, `rules/*.md`, `skills/**/secret.md`. Exact entries keep working unchanged. A `ignoredUserFiles` entry naming a directory — `rules` or `rules/` — now really does exclude everything under it, which is what the trailing slash always looked like it did but never was. An `ignoredSettings` or `ignoredUserFiles` entry that matched nothing is reported as a warning instead of failing silently.
- `Cursor Setting Sync: Disconnect` stops synchronizing and clears the stored repository, its encryption key and the workspace mappings from this device. The shared folder is left untouched. This is also the way out of "The configured folder now contains a different repository.", which previously failed at every startup with no stated remedy.
- Setup, Archive Repository, Checkpoint & Prune History, Compact Safe Orphans and a manual Sync Now report progress. Cloning a large git repository and deriving the encryption key used to happen with nothing at all on screen.
- The repository now folds its own history. Once the event log passes 500 files, a poll runs the same checkpoint-and-prune the manual command runs, behind the same gates (a warning-free reconcile, no unresolved conflicts, no pending database changes, every device acked, a checkpoint at least 24 hours old) and at most once every six hours. The event log, the blob store and the shared folder no longer grow without bound, and the sync cycle no longer gets slower as the repository ages.
- UI state conflicts now resolve themselves instead of asking. A value whose array elements carry a stable `id` — pinned view containers (`workbench.activity.pinnedViewlets2`), hidden-view lists — is merged element by element with the base ordering preserved, and any other UI state value falls back to the newest tip chosen from replicated event ordering alone. A UI state fork with no common ancestor at all — two machines that each minted the same key locally, which is how most of them arise — is resolved the same way: last-writer-wins needs no base. A put always beats a delete there, because a losing delete is repeatable and a losing put throws away the only copy. Both devices compute byte-identical output *and* identical metadata without exchanging a message, so the two independent resolutions collapse into one version. `.cursor` rules, settings, extensions, and chat still ask, whether or not the fork has a base, because there one side's loss is authored content.
- `cursorSettingSync.ignoredUiStateKeys` excludes UI state keys from synchronization. Like the built-in denylist, ignoring a key only stops it from syncing and never publishes a deletion to other devices. It is honored in both directions, exactly like `ignoredSettings`, `ignoredUserFiles` and `ignoredExtensions`: this device stops publishing the key, and an incoming put or delete for it from another device leaves the local value alone.

### Changed

- Two per-chat-panel UI state families are no longer synchronized: `workbench.panel.composerChatViewPane.<uuid>.hidden` and `workbench.auxiliarybar.pinnedPanels`. Cursor mints a GUID per chat panel and never prunes either one, so both grow without bound and every GUID is meaningless on the other machine — a union merge of `pinnedPanels` would give a PC holding two entries the peer's hundreds, permanently. This is a policy exclusion, not a safety rule: a value one of these keys already published from an earlier release is skipped on arrival and named in the output channel, never applied and never fatal. Existing values on other devices are left untouched, and the rest of the workbench layout still travels.
- A resource larger than `cursorSettingSync.maxPayloadMiB` is now skipped with a warning that names it, its size and the two remedies, and the rest of the cycle publishes normally. It used to abort the whole cycle: one oversized workspace database stopped settings, keybindings, extensions and everything else from publishing, on that cycle and every cycle after it. A publish failure also no longer prevents *incoming* changes from being applied. Lowering `maxPayloadMiB` below something already in the repository no longer makes that resource unreadable. The same two guards now cover the shutdown export, which is the only path that backs up `workspaceStorage`: one oversized workspace database used to destroy that whole export — no workspace state, notepads, images, chat, UI state, extensions or profiles for the session — and it repeated on every clean exit. An oversized workspace database is also detected while it is captured, measured on what it actually serializes to rather than on its decoded size.
- The status bar distinguishes states it used to collapse. A configured repository with automatic sync switched off reads "Paused" instead of "Setup" — clicking it no longer opens the first-run wizard against a working repository. A Cursor build without the required database access reads "Partial" instead of a green check mark, and activation shows one notification naming what will not synchronize.
- "Synchronization is currently busy." now names the holding process, how long it has been active, the lock file, and that a stale lock releases itself after fifteen minutes.
- Show Diagnostics reports reasons, not just counts: each pending change with its blocking reason, the conflicting resource IDs, every `cursorSettingSync.*` value actually in force, the machine-specific exclusion set, the git mode, the workspace mappings and the active adapters.

### Fixed

- An unreadable UI state target marker published a deletion for every UI state key this device had ever synchronized. The peers applied those tombstones and all synchronized UI state was destroyed, with only a local warning line mentioning it. A scan that cannot read the marker is incomplete, and an incomplete scan now publishes no UI state deletions.
- A `chat`, `chat-transcript`, `chat-store` or `workspace-storage` deletion is honored by keeping the local copy, but the projection recorded no hash for what was kept whenever the adapter had not produced a snapshot that cycle — always, for an unchanged chat or for workspaceStorage. The next scan then republished the resource and silently undid the other device's delete on every device. The offline helper's tombstone branches had the same gap.
- Auto-merging a JSON user file published a hash of the canonical JSON while the adapters that own those files hash the raw bytes, and each device wrote the merge into its own formatting. The two devices produced different bytes for the same merge, never converged, and republished the file on every cycle. The merge now picks its anchor text from the comment trivia, which is the same on both devices because it does not depend on which side is "local": if neither side changed the comments the ancestor's text is the anchor, if exactly one side did that side's text is, and if both did and the two renderings differ the resource goes to manual conflict resolution rather than dropping one side's annotations. Both devices emit identical bytes, a comment added on one side survives the merge, and the published hash is the hash of those bytes.
- One unreadable `workspaceStorage` directory — a cloud placeholder hydrating, an antivirus scan, a leftover Cursor handle — dropped the backup of *every* workspace for that run, and since this data is only captured at shutdown the next chance was the next clean exit. Each workspace is now enumerated on its own and a failure is reported for that workspace only.
- A checkpoint absorb that hit a stream rollback partway through left some device cursors adopted and the checkpoint reference behind, and the error path wrote exactly that to disk — a transient fault became a permanent fail-stop with no automatic recovery. The new cursors are now installed only after every device agrees, and the error path persists the error alone rather than whatever the failed operation left behind.
- Recreating a missing chat `store.db` declared `meta.value` as `TEXT`, which coerced restored INTEGER and REAL values to text and left the resource permanently disagreeing between devices. The fallback tables now keep the storage class they are given. (`blobs.data` was already declared `BLOB` and coerced nothing; it is untyped now only for consistency.)
- The repository watcher ignored incoming checkpoint files, so a peer's checkpoint was only noticed on the next poll.
- A warning that stayed true across sync cycles was re-logged on every poll, so a single permanent problem printed twice a minute forever. Collapsing that with one set of "warnings from the last cycle" does not work, because the file poll and the chat poll scan disjoint adapter sets and alternate: each cycle overwrites the other scope's set and every warning looks new again 30 seconds later. Warnings are therefore tracked per source — one bucket per adapter, plus one for the reconciler, one for auto-merge, one per adapter for publishing and one for the offline helper — and a cycle that did not run an adapter leaves that adapter's bucket alone. A warning is logged when it appears, again if it clears and comes back, and otherwise restated once an hour so a permanent problem cannot go silent. "Sync Now" logs everything that is standing, and Show Diagnostics lists each standing warning with its age.
- The status bar sat on `$(sync~spin) Synchronization is in progress.` more or less permanently and hid what the user could act on. The spinner is now armed rather than shown: a cycle that finishes within two seconds never touches the status item, and an outstanding conflict or a pending restart is never replaced by it at all. The terminal status is restored in a `finally` block, so no failure path or early return can leave the spinner standing, and a window that keeps losing the sync lock to another window now re-evaluates its status instead of displaying a stale result.
- A chat whose `composerId` was stored with BLOB affinity was published as a deletion even though its header was still in the table, and that tombstone became the repository tip, so the chat stopped propagating and a newly onboarded device never received it. The ID is now decoded from the stored bytes and used. When a header's identity genuinely cannot be determined, the scan publishes no chat deletions at all rather than risk a tombstone for a live chat.
- The log filled with one `Warning: Skipped chat <id>: composerData row is missing.` line per chat, repeated every 30 seconds forever. Cursor keeps a chat's list entry after pruning its conversation body, which is an expected state and not a failure, so those chats are now reported as a single aggregated line. That line states what was actually observed and names up to five composer IDs plus a count of the rest, rather than asserting a benign cause and naming nothing — a helper that wrote headers and died before the bodies would otherwise report hundreds of genuinely lost conversations as one reassuring sentence. Those chats are still never published as deletions, and a genuinely unreadable row keeps its own per-chat warning.
- Both READMEs and `docs/security.md` told users to keep MCP secrets out of sync with `cursorSettingSync.ignoredSettings`, which only ever applied to keys inside `settings.json`; `~/.cursor/mcp.json` is excluded by `cursorSettingSync.ignoredUserFiles`, which was documented nowhere. The Requirements section also listed the passphrase as mandatory when it is optional. `README.ko.md` was missing the automatic checkpoint and the per-PC machine-scope limitation entirely, and now matches `README.md` section for section.
- A stray editor scratch file in the repository root shipped inside the VSIX because it matched no `.vscodeignore` pattern. The root is now an allowlist — `package.json`, both READMEs, the changelog, the licence and the icon — so the next stray file cannot ship. `README.md` also ended with a leftover shell artifact line that rendered on the extension's marketplace page.
- The UI state exclusion list conflated two different things and broke `apply` permanently on any device whose repository already contained the excluded keys — which is every repository, because every earlier release published them. The list is a security boundary for `secret://`, OAuth, token, password, credential and authentication-session keys: an inbound change for one of those is a protocol violation and still fails the request. It is only a preference for the two per-chat-panel families, and treating those as a violation aborted the entire shutdown apply — no UI state, no profiles, no chat, and the extension, user-file and `workspaceStorage` restore never ran at all — on every single shutdown, forever, because the event is immutable and the pending entry can never be superseded. A policy-excluded key is now skipped with a recorded reason, is filtered out of the pending queue so it never reaches the helper, and never aborts the transaction.
- A device joining a repository that already contained another device's events threw `Local stream cursor is invalid` on its very first cycle and could never synchronize. Recovering an empty own stream wrote a `{lastSequence: 0, lastEventHash: null}` cursor, which is exactly the shape the reconciler rejects; a device that has published nothing now carries no pinned cursor at all, and a cursor already persisted in that shape is repaired on the next refresh.
- A conflict with no common ancestor was skipped by the automatic resolver outright, so it stayed unresolved forever: the user kept being prompted, and every one of those resources was re-scanned and re-published on every cycle, because a conflicted resource gets no projection and so can never take the "already applied" short circuit. On a real two-machine setup that was 23 permanently unresolvable UI state conflicts and a repository growing by thousands of events a day. UI state forks with no base now resolve by last-writer-wins, and a resource that is still in conflict may republish this device's tip at most once an hour instead of on every 30-second poll — the fork stays representable, but it can no longer drive unbounded growth. The manual resolver reads the live local value, so nothing it shows the user goes stale.
- The offline helper's warnings never reached the user. The helper runs after Cursor's window is gone, and a resource it dropped for exceeding `cursorSettingSync.maxPayloadMiB` produced one output-channel line under a green check mark — quieter than the hard failure that guard replaced in this same release. Since the shutdown export is the only path that backs up `workspaceStorage`, a workspace database over the limit was silently never backed up again, on every shutdown, indefinitely. Helper warnings are now standing warnings like any other: the status bar reads "Partial", Show Diagnostics lists them with their age and marks them as blocking publication, and they stay until a later helper run reports the problem gone.
- Raising `cursorSettingSync.maxPayloadMiB` — the remedy the oversized-payload warning itself recommends — could not take effect without restarting Cursor, and made things worse in the meantime: the publish guard read the setting live while `publish` enforced the value captured when the repository was opened, so the guard admitted a payload `publish` then rejected, and the error re-surfaced on every poll and on every manual Sync Now. The repository's limit now tracks the setting, and the guard is keyed to the repository's limit rather than to a second read of the configuration.

### Performance

Every number below is per sync cycle, and there are two polls a minute.

- The event log was re-read, re-hashed and re-decrypted in full on every cycle, twice on any cycle that published, plus a third pass over this device's own stream. Event files are immutable, so a file whose size and mtime are unchanged now reuses the decode that was already verified; a published event is added to the cache instead of invalidating it; and the own-stream walk starts from the cursor it last verified rather than from zero.
- The absorbed checkpoint was fully read, hashed, decrypted and revalidated on every cycle just to conclude it had not changed. The winner is now identified from the filename, which carries the ordering key, and the file is opened only when it differs from what is already absorbed.
- The local state file — one record per synchronized resource, which for a large chat history is megabytes — was pretty-printed and fsync'd three to five times per cycle. It is now written compactly, and only when its content actually changed.
- `acks.json` was rewritten into the shared folder on every cycle with a fresh timestamp, so a cloud client uploaded it around 2,900 times a day for data that changes a few times an hour. It is rewritten only when the cursors move, or on a fifteen-minute heartbeat.
- Every publish tripped the repository watcher with this device's own writes and scheduled a second, entirely redundant cycle one second later. Files this device just wrote are now recognized and ignored.
- The chat scan opened a transaction and re-read the header row for every chat on every poll just to discover nothing had changed. The list query now carries the timestamp and the steady state costs one query.
- `~/.cursor/{commands,skills,rules}` was re-walked, re-read and re-hashed in full every 30 seconds. Files whose size and mtime are unchanged reuse the previous result, the way the extensions and chat adapters already did.
- The chat transcript scan enumerated the whole of `~/.cursor/projects` with two `realpath` calls per entry and discarded most of it. It now opens each project's `agent-transcripts` directory directly.
- `workspace.json` was re-read through the hardened path walker for every workspaceStorage directory by three separate callers on every poll. The result is cached and invalidated by the root directory's own mtime.

## [0.0.3] - 2026-07-25

### Fixed

- A transient read failure on a repository file (`UNKNOWN: unknown error, read` and similar), common when the shared folder is a cloud drive that briefly locks a file or is hydrating an online-only placeholder, aborted the entire sync — including setup. Repository event, object, and checkpoint reads now retry transient I/O errors with a short backoff before failing. Genuine corruption and missing files still fail as before.

## [0.0.2] - 2026-07-25

### Fixed

- Chat synchronization crashed every cycle ("Adapter state-vscdb-chat scan failed... Received null") whenever a Cursor database row held a SQL NULL. NULL values are now carried with their SQLite storage class across every capture and apply path and round-trip as SQL NULL, and one unusable row is skipped with a warning instead of taking down the whole adapter scan.

## [0.0.1] - 2026-07-20

### Added

- Initial public release
- Encrypted multi-device synchronization for Cursor settings, profiles, extensions, user files, and supported chat data
- Encrypted offline synchronization for allowlisted Cursor `workspaceStorage`: portable typed `state.vscdb` rows merged with SQL, plus notepads and images; `workspace.json` is identity metadata only and deletions remain device-local
- Forward-compatible database synchronization policy that defers newer-version data on older clients
- Conflict preservation, offline database application, backups, diagnostics, repository maintenance, and recovery commands
- Query-only live database mutation: no SQLite file replacement, per-key workspace/store merges, pre-commit integrity checks, and bounded local backup retention
