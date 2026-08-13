# Change Log

All notable changes to Cursor Setting Sync will be documented in this file.

## [0.0.66] - 2026-08-13

### Added

- **Hundreds of continuation-damaged chats can now be preserved in one bounded, cancellable pass.** When no exact synchronized source or backup can repair the original chat in place, **Preserve All Recoverable Chats Safely** creates a checkpointed fallback catalog without opening hundreds of Agents, rewriting original conversation rows, writing Cursor's database, or sending prompts. Its plaintext can include message text, thinking/error state, inert tool inputs/results/status, source selections and URIs, todos and new/original-file work state, and selected PNGs. The manifest is capped at 2,000 current entries and 512 MiB of currently referenced ready files; final, obsolete/rejected, and recognized atomic-partial artifact-tree files separately share a hard 512 MiB/130,000-entry cap, while retained manifest/index partials have a 32 MiB/16-entry cap. **Open Recovered Chat Safely** revalidates the original workspace, selected live conversation, and every stored file immediately before preparing one empty Agent. Recovery files remain until the user explicitly removes the local `recovery-transcripts` folder or its files.

### Fixed

- **Unavailable-chat repair now reports bounded audit reasons precisely and cannot strand later damage behind an earlier batch.** Exact, warning-free compatible stored sources still take the automatic in-place repair path. Chats without that source stay unchanged and can be preserved only through the explicit local-catalog fallback; unreadable, structural-limit, cancellation, database-race, corrupt-artifact, and storage-quota cases all fail closed without being mislabeled as healthy or ready.

## [0.0.65] - 2026-08-13

### Added

- **An unavailable conversation whose continuation blobs no longer exist can now continue safely in a new Agent without rewriting the damaged chat.** **Continue Unavailable Chat Safely** verifies every visible row in a read-only transaction, rechecks the continuation damage immediately before export, and creates a bounded plaintext Markdown context containing the recoverable user and assistant text, thinking and error state, inert tool inputs/results/status, deduplicated source selections, and allowlisted composer work state. A surviving selected PNG is validated byte-for-byte, copied content-addressed, and attached beside the Markdown file. Nothing is submitted automatically, and the extension does not rewrite the original conversation rows. Cursor may persist the newly opened empty Agent itself. The local plaintext recovery artifacts remain in extension storage until the user deletes them.

### Fixed

- **Unrecoverable legacy chats no longer prevent `Repair Unavailable Chats` from reaching a later continuation-damaged conversation.** The command advances through indexed, bounded `composerId` keyset pages, releases each no-source batch, and proceeds to the independent continuation audit in the same invocation. It no longer repeats the same first batch, misreports an aggregate safety limit as a request to apply that batch, or suggests Restore Version History when no earlier stored version exists.
- **Safe continuation now handles the real Remote SSH and attachment edge cases.** Hex-descriptor and alias spellings of the same SSH workspace compare as one identity, the selected chat is re-audited after UI selection, image paths are rebound only to the matching local workspace-storage image directory, and PNG structure, CRCs, dimensions, decoded work, size, and hash are checked before an Agent can be opened. Internal Cursor command rejection falls back to a verified manual artifact instead of sending or stacking another action.

## [0.0.64] - 2026-08-13

### Fixed

- **A transient cloud-provider metadata update no longer aborts synchronization while `repo.json` is being read.** The opened-handle identity and size checks remain fail-closed, but a safe read discarded because OneDrive, Dropbox, Syncthing, or another provider replaced or restamped the manifest is now retried through the same bounded transient-I/O policy as other shared-folder reads. Structural path and symbolic-link validation failures are still reported immediately and are never retried.

## [0.0.63] - 2026-08-11

### Added

- **Composer conversations now carry the content-addressed continuation data Cursor needs to submit the next turn.** In addition to the visible header, `composerData`, and `bubbleId:` rows, the portable v2 chat payload includes every reachable, available, hash-verified `agentKv:blob:` row and explicitly records unavailable IDs. The target inserts only missing or corrupt blobs and never replaces a hash-valid local copy.
- **Existing conversations published by 0.0.62 and earlier can be enriched without rolling their visible history back.** A healthy source PC attaches its validated blob graph to the exact current repository tip, preserving a newer target PC's prompts, error bubbles, title, and conversation body byte for byte. `Repair Unavailable Chats` also audits continuation roots and, when the synchronized copy is not yet complete, gives count-only instructions to run **Sync Now** first on a PC where the chat still continues.

### Fixed

- **Chats restored from another PC no longer fail the next prompt with `Conversation data missing`.** Older releases synchronized all legacy message rows but omitted Cursor's separate continuation blob graph, so a conversation could render perfectly while the server rejected it with dozens or hundreds of missing blobs. Chat capture, merge, apply, automatic repair, and metadata acknowledgement now preserve the graph consistently, and a previously applied complete tip can be re-queued if its local blobs are later lost.
- **Large or malformed continuation graphs cannot turn chat polling into an unbounded CPU/RAM scan.** Background capture is limited to two new graphs per scan, 4,096 nodes and 32 MiB per chat; protobuf candidate discovery is bounded before allocation, oversized SQLite rows are rejected by length before their value is materialized, and incomplete work falls back to the legacy core for later bounded enrichment. Transient SQLite read failures are retried instead of being cached as a successful no-op.
- **Large chat histories now settle instead of being rebuilt on every poll.** Changed-body capture, bubble-count audits, and same-count deep verification advance through bounded round-robin batches; oversized chats are size-checked and hash-streamed without loading their full body, stable warnings remain visible without reopening SQLite, and the shutdown helper drains feasible local changes before applying incoming data.
- **Large file trees and auxiliary Cursor stores no longer create one-poll memory or I/O spikes.** Transcript, chat-store, workspace image, profile, extension, settings, and Cursor user-file scans advance through bounded pages; file and SQLite sizes are checked before values cross into JavaScript, and stable idle scans reuse lightweight observations. A partial or failed local scan now blocks the matching incoming write instead of letting an unreadable or not-yet-published local edit be overwritten.
- **Encrypted repository and offline-helper reads are bounded before allocation.** Object envelopes use the authenticated compressed size, event/checkpoint files use opened-handle limits that cannot be bypassed by a stat/read race, and helper applies retain at most one 32 MiB page while leaving later changes queued. A single larger payload is reported explicitly rather than silently starving smaller siblings.
- **Synthetic chat metadata always describes the exact payload it accompanies.** Automatic merges, blob enrichment, and unavailable-message repair recompute schema, blob/reference/missing counts, and core hashes instead of inheriting stale fields that could suppress later verification.
- **Opening many Cursor windows no longer duplicates the full synchronization state in every extension host.** A standby window does not open the repository or read, parse, stringify, or retain its local-state body. Only the elected owner or an explicit command opens the lightweight repository envelope on demand; its local-state body is initialized once after that window takes `sync.lock`.

### Changed

- The compatibility floor for v2 database-backed chat payloads is extension version `0.0.63`. Older clients safely defer those payloads until they are updated.
- Bounded Cursor user-file, profile-file, settings, extension, and UI-state discovery is now additive-only. These fixed-memory pages cannot retain a stable identity set for an entire large or concurrently changing tree/marker, so they no longer originate deletion tombstones from absence in one page. Existing authenticated tombstones remain understood and can still be applied; this change only prevents a partial local walk from inventing a destructive deletion.

## [0.0.62] - 2026-08-08

### Fixed

- **Idle synchronization no longer walks the Git worktree every 30 seconds.** Background remote probes are spaced to five minutes, unchanged acknowledgement heartbeats do not rewrite the repository, and `git add/status/push` runs only for a due probe, a real publication, an acknowledgement write, or a manual sync. A failed Git window remains degraded until a real retry succeeds instead of being cleared by a skipped no-op poll.
- **Opening several Cursor windows no longer serializes full repository recovery in every extension host.** Passive windows load only atomic local state and activate immediately; the elected owner performs checkpoint absorption and stream recovery once under `sync.lock`. Manual commands and owner failover initialize safely on demand, a missing local state file is recreated by exactly one owner, and overlapping configuration changes cannot install a stale repository or zero a key still in use.
- **Chat polling no longer performs a global scan of every message row whenever Cursor touches its multi-gigabyte database.** A constant-size database/WAL fingerprint provides a zero-SQLite idle path, indexed per-conversation counts narrow ordinary growth, and rare same-count edits are verified in bounded round-robin batches. Verification hashes the canonical snapshot one SQLite row at a time, so an unchanged 49 MB conversation no longer requires a second full copy, a Base64 object graph, and one giant JSON buffer in memory. Legacy projections now remember the timestamp and message count learned by an exact verification instead of re-reading hundreds of unchanged conversations on every poll, and a local chat matching another current conflict tip is acknowledged as that exact version instead of being re-emitted forever. Changed snapshots are retried until the repository acknowledges them, while destructive deletions require one stable before/after database view.
- **Checkpointed repositories no longer stat and retain every folded event during routine reconciliation.** Events covered by the authenticated checkpoint are skipped from their filename sequence before stat, read, or decrypt; full version history remains available to Restore and Repair. On the reported repository this reduces the normal reconcile set from 14,558 events to about 1,200 and releases the folded decoded-event cache.
- **The shutdown finalizer no longer spawns `tasklist` twice per second after one window closes while other Cursor windows remain open.** Cancellation is still checked every 500 ms, but the operating-system process listing runs immediately on the owner-host exit edge and then at most once every 30 seconds.
- **A live synchronization lock is never stolen merely because its heartbeat looks old after sleep, hibernation, a debugger pause, or long synchronous work.** New lock files carry the operating-system process start identity so genuine PID reuse still heals safely. Repository opens now wait for a real lock instead of falling back to an unlocked state write, and closing or reloading a waiting window cancels promptly.
- **Automatic checkpoint maintenance lets an existing checkpoint reach the 24-hour prune gate.** It prunes the old checkpoint first and folds newer changes only after a successful prune, including when another device's acknowledgement arrives between the precheck and the guarded prune.

### Changed

- **`Repair Unavailable Chats` keeps its expensive live-database audit and history traversal outside the repository lock.** The final locked phase revalidates tips and the exact damage fingerprint, and the repair builds one complete newest-valid union so newer inert rows are preserved without holding every historical payload in memory.

## [0.0.61] - 2026-08-07

### Added

- **`Repair Unavailable Chats` detects and repairs the `Conversation data missing` failure without making the user choose chat IDs or historical versions.** The command audits the live `composerData.fullConversationHeadersOnly` references, finds only conversations whose referenced `bubbleId:` rows are absent or unreadable, and searches the warning-free trusted current-tip ancestry for one version that contains every unavailable message. A body-less header, an orphan row, a deleted chat, a conflict, an incomplete event stream, an incompatible producer, and an unknown composerData shape are never guessed into an automatic repair.
- **Automatic repair is additive, portable, and race-safe.** The published child keeps the live header and composerData and deterministically unions existing rows with the complete source and newer trusted rows, so checkpointing or onboarding a new PC cannot drop history that this PC does not currently reference. After Cursor exits, the originating PC must still match the exact reference fingerprint; another PC may materialize a truly absent chat or repair the same composerData, while any partial or divergent local structure is left untouched. The helper never deletes a row or replaces a live header/composerData, creates the normal SQLite backup, uses a per-resource savepoint, and verifies every live reference plus database integrity before commit.
- **The expensive reference audit is command-only and bounded.** It streams one composer's indexed key range at a time, isolates malformed rows to that conversation, materializes full payloads only for damaged chats, and stops reading history at the newest complete source. The 30-second background poll and multi-window CPU/RAM behavior therefore do not regress. One modal repairs every unambiguous conversation in the batch, with **Repair and Restart** for immediate offline application or **Queue Repair** for a later `Restart to Apply`.

## [0.0.60] - 2026-08-07

### Changed

- **`Restore Version History` no longer opens with thousands of internal resource IDs.** It now starts with a short data-type list, clearly separates main **Cursor conversations** from raw **Agent transcripts**, narrows large chat/transcript sets by workspace or project, and shows titles (when recorded), message counts, readable paths, and update times instead of percent-encoded IDs.
- **Only resources with an eligible earlier version are offered.** Current-only, conflicted, disabled, deleted-version, and incompatible entries stay out of the actionable lists, while a deleted resource with an older `put` remains recoverable. Histories for the chosen type are collected in one event traversal rather than rescanning the complete event log once per resource, and are limited to trusted ancestors of freshly reconciled tips; a shared-folder stream gap or fork blocks Restore instead of exposing an unaccepted event as history.
- **The final restore decision is easier to verify and remains race-safe.** The confirmation repeats the readable resource name, type, version time, message count, size, source device, and decoded conversation/path identity. After the picker closes, the command rechecks tips, conflicts, configuration, producer compatibility, and the selected payload identity under the command lock before publishing anything. New chat snapshots carry their Cursor title as lightweight metadata, and restoring an older chat derives that title again from its payload.

## [0.0.59] - 2026-08-03

### Changed

- **Opening more Cursor windows no longer multiplies background synchronization work.** One window now owns the recursive repository watcher, automatic file/chat polling, and the machine-wide shutdown finalizer. Other windows stay passive and automatically elect a replacement within 15–30 seconds if the owner exits. Commands remain available in every window.
- **Slow synchronization cannot turn periodic polling into a permanent CPU backlog.** Poll ticks already covered by a running cycle are dropped, a different scope is coalesced into at most one fair follow-up, the next interval begins only after its request settles, and equal file/chat intervals share one widened cycle. Repository-watcher bursts also share one queued waiter instead of allocating one promise handler per event.
- **Startup no longer integrity-scans Cursor's entire global database in every window.** Activation now performs schema checks plus integrity checks limited to the small destructive-metadata tables; full SQLite integrity checks remain in the offline write path where they protect an actual database change. On the reported 1.8 GB database, this dropped from tens of seconds to roughly 8 ms while retaining the profile/UI/chat-header index-corruption gate.
- **Chat polling uses the database key index instead of scanning it.** Bubble lookups now use exact half-open key ranges, and large local synchronization states retain only a fixed-size digest rather than a second multi-megabyte JSON string. This lowers steady-state CPU and memory use.
- **Offline-helper stderr logs are cleaned up safely.** A processed result removes its matching log, and old request-less logs are pruned at startup after identity, age, and race checks.
- **Packaging and publishing now run the complete verification gate.** Type checking, linting, all scenario tests, bundling, and smoke loading must succeed before a VSIX can be produced or published.

## [0.0.58] - 2026-08-03

### Changed

- **`Restore Version History` shows how many messages a chat version holds.** Recovering a conversation is the one case where two versions of the same resource have to be told apart on content, and the payload size was the only clue on the line. `3f1a2b4c · put · 412 KB · 167 messages` says which entry still has the conversation in it, which is what makes the 0.0.57 recovery path usable by hand.

## [0.0.57] - 2026-08-03

### Fixed

- **Applying a chat no longer deletes messages this computer still has.** The applier removed every `bubbleId:` row the incoming snapshot did not contain, on the rule that a message deleted on the source must not survive on the target. There is no such deletion: Cursor offers no way to remove a single message, so every absence is Cursor pruning a conversation body on one computer alone. Replicating it turned one machine's housekeeping into the other machine's data loss — and because the emptied side then published its own empty capture, a conversation pruned on *either* computer ended up empty on **both**, rendering up to a point and then failing with "Conversation data missing".

  Measured on the real pair: 553 conversations, 58,062 messages, and **5 chats holding 377 messages between them gone — every one an all-or-nothing loss, not a partial one**, which is the signature of wholesale replication rather than corruption. Unreferenced rows are inert (`composerData.fullConversationHeadersOnly` decides what a conversation contains), so keeping them costs storage and nothing else — the same reasoning the conflict merge already used to union messages instead of choosing between them.

- **A conversation that lost messages here is no longer published over the fuller copy.** Even without the delete, republishing a pruned capture would overwrite the shared `composerData`. A chat whose message count has *dropped* since this device last published it is now held back, with a notice naming the chats and the counts. Growth still publishes exactly as before, and a chat this device has never published is unaffected — an absent count means "unknown", not "zero".

  This also gives the other direction for free: because the shared folder keeps the fuller version, it stays available to be written back to the computer that pruned it.

## [0.0.56] - 2026-08-03

### Fixed

- **`Restart to Apply` could wait forever on its first phase.** The command opens with a synchronize, and every caller of that synchronize waited not for its own cycle but for the whole queue behind it to empty. On a repository where one cycle outlasts the poll interval the queue is *never* empty: the two 30-second timers and the shared-folder watcher hand the drain a fresh scope while the cycle they are queued behind is still running, so the loop kept working correctly and the caller was simply never told. Observed on a 1.1 GB repository as an apply that sat on "Synchronizing before the apply..." for over an hour while the output channel showed cycle after cycle completing normally. Each request now resolves when the cycle that took *its* scope ends.

  The 0.0.55 phase logging is what made this legible — the log stopping at phase one while sync warnings kept arriving on the hour is the whole diagnosis. The call itself has been there since 0.0.34.

- **A user-invoked command no longer competes with this window's own polling.** Commands take the same lock the background cycle holds and wait up to a minute for it — ample against one cycle, hopeless against a queue that refills itself, so the command failed with "this window's own background synchronization is still running", which was true and useless because waiting longer could not help. Automatic requests now stand down while a command prepares. They are withheld rather than dropped: the scope decides what the next cycle even looks at, so a watcher event during a command is still picked up, in one widened cycle, as soon as the command is done.

- **A cycle that fails no longer strands the requests queued behind it.** They waited on a promise nothing would ever settle. They now report that their cycle never ran, with the failure that ended the drain kept as the cause — rather than reporting somebody else's error as their own.

### Changed

- **A phase that runs long says so while it runs.** Phases logged when they started, so the slowest one — exactly the one somebody goes to the log about — wrote nothing until the next began. `Restart to Apply` now repeats the phase it is still on every 30 seconds, with the elapsed time.
- **A synchronization cycle slower than a minute reports its duration.** That number is what decides whether the poll interval leaves the queue any idle at all; a cycle longer than the interval means the next one starts the moment this one ends, which costs CPU continuously and is what starved commands of the lock.

## [0.0.55] - 2026-08-03

### Changed

- **`Restart to Apply` says what it is doing.** Only the wait for the synchronization lock was ever shown, and that notification disappears the moment the lock is taken — after which the synchronize, the shared-folder fetch, the state reload and the workspace-mapping pass all ran in silence. On a large repository that is minutes of a command that has visibly done nothing, with no way to tell it apart from one that has hung. The whole preparation now runs under one progress notification that names each phase, and every phase is written to the output channel with an elapsed time, so the record survives the quit and is still there when Cursor comes back.
- **The offline pass is bracketed by two log lines.** It runs with Cursor closed, so there is no UI it can report into while it works. The line before the quit names how many changes are going and warns that reopening the editor by hand cancels the pass; the line after the relaunch reports what landed and how long it took — a pass that took four minutes and one that took four seconds used to read identically.

## [0.0.54] - 2026-08-03

### Fixed

- **Reopening Cursor during the shutdown pass is no longer reported as a failure.** "Cursor was reopened before offline changes could be applied" arrived as a red status bar and a notification — the treatment a real failure gets — when nothing had gone wrong: nothing was written, the queue is exactly as it was, and the next shutdown applies it. This became the routine outcome in 0.0.49, when the shutdown pass started applying the whole queue instead of only exporting: that takes minutes, and closing the editor and opening it again inside that window is not a mistake. Showing it in red taught the user to ignore the one signal that means their data did not land. It is now a log line, and the status returns to Queued.
- **A queue that keeps getting interrupted can still be drained.** With the shutdown apply enabled, the queued-apply offer stays out of the way — but if the previous shutdown pass was cut short, the offer comes back for that session. Otherwise someone who always reopens quickly would get neither a completed shutdown apply nor a prompt, and the queue would never drain. The offer is the only path that controls the quit itself.
- The detection prefers a structured flag on the helper result and falls back to the message text, because the finalizer that runs at the first shutdown after an update is the *previous* build's — it is spawned at startup — so the release that introduces the flag reports without it exactly once.

## [0.0.53] - 2026-08-03

### Fixed

- **A conversation that kept going was frozen at its first message.** Cursor stamps `composerHeaders.lastUpdatedAt` once, near the start of a chat, and then streams every later message into `cursorDiskKV` without touching it again. The scan used that timestamp alone as its change signal — so a poll that happened to land while a chat had one message published one message, recorded the timestamp, and from then on every scan compared equal and skipped the chat entirely. The conversation grew for hours; the repository kept the first line.

  Measured on the real pair: a chat with **63 messages on disk, published with `bubbleCount: 1`**, and the second computer showing exactly that one message under the title "New Agent" — the header had never travelled either. Another chat with 68 messages had never been published at all.

  The change signal is now the timestamp **and** the message count, gathered for every conversation in one grouped query per scan rather than a count per chat. A projection written by an earlier version carries no count, which reads as "unknown" and forces a re-read — so chats frozen by this bug republish in full on the first scan after the update, without anyone having to touch them.

## [0.0.52] - 2026-08-03

### Fixed

- **SSH folder history never actually landed on either computer.** 0.0.48 added the `remote-targets` kind: it scanned correctly, published correctly, and merged two machines' host lists into a union correctly — the shared folder held the right answer the whole time. What it did not do was write it. The helper splits prepared changes by kind, global-database kinds to one applier and the rest to another, and the new kind was added to neither list. That is not an error anyone sees: the change is prepared, handed to nobody, and never marked applied — so it sits in the queue forever, re-offered on every launch and written by nothing. Both computers kept their own list and the merged one waited in the repository.

  Found by tracing why a folder opened on one machine never appeared on the other: the repository held a correct auto-merged union, and both devices had it queued and unapplied. The kind list is now shared between the routing and the write path, and `tests/offline-apply-kinds.test.ts` fails if a helper-applied kind is ever routed to neither half again.

## [0.0.51] - 2026-07-31

### Fixed

- **A chat with an image can be continued on the other computer.** Images pasted into a chat are stored under `workspaceStorage/<workspace>/images/`, and that whole folder was scanned only at shutdown, because it also holds `state.vscdb` — a database Cursor keeps open, where reading mid-write captures a torn snapshot. The chat itself publishes within thirty seconds. So a conversation crossed to the other machine while its screenshots stayed behind on the one that took them, waiting for a quit that had not happened, and Cursor will not continue a chat whose image is missing: it reports `Couldn't process image ...` and then fails the turn outright.

  Chat images are not databases. Each is written once under a fresh name and never edited, so they are now scanned while Cursor runs and travel with the chat that references them. `state.vscdb` and `notepads.json` still wait for the shutdown export, which is the pass that has Cursor to itself.

## [0.0.50] - 2026-07-31

### Changed

- **A quiet poll now reconciles once instead of three times.** Measured on a real machine: every open window burned a full CPU core for 5-10 seconds every 30 seconds, ~20-35% of a core each, continuously. A reconcile rebuilds the version graph of every resource from every event — 13,628 events and 2,235 resources on the repository this was found on — and the sync cycle ran one after the scan and one after the publish regardless of whether either had changed anything. Both are now conditional: the post-publish pass is skipped when the cycle published nothing (the common case, and nothing between the two passes writes to the repository), and the post-synthetic pass is skipped when there were no synthetic tips to apply. The reconcile after an auto-merge was already conditional and stays that way. A cycle that publishes something still recomputes exactly as before.

  The remaining per-cycle cost is one `stat` per event file, which the cache uses to notice a file another device is pruning out from under it. That one is *not* safe to drop — the filename carries the content hash, but a file can be truncated in place while a deletion propagates, and without the check a cached decode outlives the bytes it was made from and a folded-away event comes back. It is left alone.

  The real lever on both remaining costs is repository size: `Forget Device` for a computer that is gone, then `Checkpoint & Prune History`, cuts the event count the cycle walks.

## [0.0.49] - 2026-07-31

### Changed

- **Queued changes are written when you close Cursor, instead of asking you to close it.** The queue needs a Cursor that is not running, and the only way to give it one was a modal — on every launch — offering to quit the editor you had just opened. But a shutdown finalizer already runs at every quit: it waits for the last process to exit, takes the lock, and exports this session's workspaceStorage. It now writes the pending queue in the same pass. No modal, no second quit, no relaunch. The finalizer reads the queue itself rather than a list decided when it was armed, because it is armed at startup and runs whenever you happen to close the editor. Turn it off with `cursorSettingSync.applyOnShutdown` to be prompted for an explicit `Restart to Apply` instead; either way files still apply immediately while Cursor runs, and nothing is ever written to a database Cursor holds open.
- The status bar says so: queued changes now read as "written the next time you close Cursor - no restart needed", with `Restart to Apply` offered for anyone who wants them sooner.

### Fixed

- **Checkpoints no longer accumulate in the shared folder while one computer is behind.** A checkpoint is created whenever any event has been published since the last one, and the *only* thing that deletes a superseded checkpoint file is a prune that gets past the gate requiring every device to have absorbed the current one. With a device stuck — the real pair had one whose acknowledgements stopped three days earlier — every maintenance run added a 2.6 MB file that nothing would ever remove: **60 files, 150 MB, written in 34 hours**, all uploaded to the shared folder. Creating one also made the prune in the same run abort, because creating absorbs it and the prune then reports "a newer checkpoint was absorbed" — so the act of creating guaranteed the act of deleting could not follow. The lagging-device check now runs *before* the write, and a run that cannot prune keeps the existing checkpoint and names the device holding things up.

## [0.0.48] - 2026-07-30

### Added

- **The Remote Explorer's SSH folder history now travels.** The tree under "SSH TARGETS" remembers which folders you have opened on each host, and that memory never left the computer that built it — not because a later release excluded it, but because Cursor registers it MACHINE-target, and the only keys this extension ever read out of the global table were USER-target ones. VS Code's own Settings Sync skips it for the same reason. Machine-target is the right call for a path on *this* computer and the wrong one for a path on a server both computers reach, which is exactly what this list holds.

  Two hosts→folders keys are carried, by allowlist: `anysphere.remote-ssh` (the one that fills the tree in Cursor) and `ms-vscode-remote.remote-ssh` (the upstream extension, when installed). A fork between two computers is **unioned, never elected**: every host either machine knows is kept, folders union within each host, and the replicated-newest side only decides the order the tree shows — because a folder one machine has opened and the other has not is a fact about the server, not a disagreement. First contact between two computers unions the same way, so neither side's history is discarded to settle it.

  **Nothing reads or writes `~/.ssh/config`.** The hosts themselves — their addresses, users, ports and key files — stay entirely on each computer; only the folder history for hosts you already have is synchronized. A payload whose shape this build does not recognize is left for the manual resolver rather than replaced by a guess, and a peer naming any key outside the allowlist under this kind is refused.

## [0.0.47] - 2026-07-30

### Changed

- **A change this computer has decided not to write is no longer counted as a backlog.** Queued changes were reported two ways — waiting, or deferred — and "deferred" covered both a temporary hold, like a version that needs an upgrade, and a standing decision, like a workspace excluded by `cursorSettingSync.ignoredWorkspaces`. The second is never going to lift on its own and needs nobody to act, so counting them together told a **correctly configured** computer it had "234 change(s) are deferred". On the real pair those were the other machine's 193 local-only folders, held back by exactly the policy that is meant to hold them back. Standing exclusions are now counted and described separately, as excluded and "not waiting for anything".
- **The status bar no longer says "Queued" for a queue that holds nothing to do.** A machine whose entire queue is standing exclusions needs no restart and no decision; it now reports its normal state instead of a badge implying outstanding work.

## [0.0.46] - 2026-07-30

Both of these are about the one screen where the extension asks a person to decide something.

### Changed

- **The conflict review says which pane is which.** The diff opens two versions side by side and the picker beside it named them only by the computer that wrote each one, so the question the screen actually raises — *which of these two panes am I choosing* — had no answer anywhere on it. The picker entries now lead with `LEFT` and `RIGHT`, the diff title spells out `LEFT This PC ↔ RIGHT Other PC (…)`, and the labels are in each pane's own path so the panes identify themselves even after the title scrolls out of a narrow tab.
- **A notepad conflict is shown as the notes, not as JSON.** `notepads.json` keeps every note's whole text inside one JSON string with its line breaks escaped, so the diff rendered each note as a single enormous line with `\r\n` written out in the middle of it — you could see that something differed without being able to read either version. The preview now renders each note under its own heading with its real line breaks, and normalizes CRLF against LF so a difference in line endings alone no longer reports every line as changed. The preview is only what is displayed: whichever side is chosen still publishes its original bytes exactly.

## [0.0.45] - 2026-07-30

The rest of the class 0.0.44 found: an apply that cannot succeed must never be the reason Cursor quits. Five reviewers traced every route by which a queued change survives an apply, and each finding was put to a refutation pass before it was fixed.

### Fixed

- **The answer to a workspace mapping prompt no longer dies with the process it was given to.** `Restart to Apply` asks which local folder an incoming workspace belongs to, and blocks the change when there is no answer — but nothing wrote that decision to disk before quitting, and the reload on the next launch read the old row back unblocked. Every block the mapping pass set was lost, including the one 0.0.43 added machinery to preserve. Blocks derived from the per-cycle check reached disk through the poll's own save; workspace mappings are precisely what that check cannot see.
- **One damaged payload object no longer costs the entire apply, repeatedly.** A payload that is present but unreadable — a cloud placeholder materialized as zero bytes, a truncated write, a size or authentication mismatch — was rethrown out of the preparation step, before anything was applied, dequeued or blocked. The whole request died with the queue exactly as it found it, and since those bytes do not heal, every later apply died the same way while the modal kept quitting Cursor to retry. Such a change is now deferred on its own, reported per resource, and blocked from being offered again, exactly like the per-resource failures its siblings already get. A change whose event carries no payload reference at all is treated the same way instead of throwing.
- A payload that simply has not arrived yet is still told apart from one that is damaged: it stays queued and unblocked, because a shared folder delivering a file a minute late heals on its own and blocking it would make the user run the command by hand for nothing.

## [0.0.44] - 2026-07-30

0.0.43 fixed a way the apply prompt could repeat. It was not the way that was actually happening.

### Fixed

- **A change the helper cannot write no longer quits Cursor to retry it on every launch.** The real loop, from the second computer's own diagnostics: one workspace database whose *local* copy fails SQLite's `quick_check` (`wrong # of entries in index sqlite_autoindex_ItemTable_1`). The pre-write backup cannot be taken, the helper refuses to write without one — which is right — and it reported `applied 0 resource(s)`. A per-resource failure is deliberately survivable, so the entry stayed queued; what nobody accounted for is that a queued entry is also an *offer*. It counted toward the modal that quits Cursor to write it, so a resource failing identically every time re-offered itself after every restart, forever, quitting the editor each round for an apply that could not succeed. The helper now blocks what it just failed to write, with the underlying error attached: the change stays in the queue and in diagnostics instead of being discarded, the offer stops, and running `Restart to Apply` deliberately clears the block and tries again — re-blocking it if it fails again. One corrupt database no longer costs the rest of the queue *or* the ability to use the editor.
- The 0.0.43 block-preservation rule was itself broken on upgrade. It compared the blocked reason by exact string equality, but that reason is persisted in repository state — so the strings it compares against are strings older builds wrote, and 0.0.43 had just reworded one of them. Every block written before the upgrade went unrecognized and was cleared on the first poll. Recognition is now by prefix, which is the part that identifies which pass owns the block; the wording is user-facing prose and free to change.

## [0.0.43] - 2026-07-30

Two dead ends found by using the thing: a button that did nothing, and a restart prompt that could never be satisfied.

### Fixed

- **The apply prompt no longer returns after every restart.** A workspaceStorage change for a workspace with no counterpart on this computer sat in a loop with no exit: the mapping pass blocked it, which correctly took it out of the batch and silenced the offer — and then the next poll re-queued the same entry, found nothing wrong with it (the per-cycle check is synchronous and cannot see workspace mappings or discover folders), and deleted the block. The change was ready again, the modal quit Cursor again, and the helper skipped it again with "workspace mapping required" — which does not mark it applied, so it stayed queued. Thirty seconds later the modal was back. The second computer in the pair this was built against sat in exactly that cycle: one change, re-offered after every single restart, that no restart could ever write. A block the mapping pass owns is now left alone by the queueing pass; only the mapping pass clears it, and it does so the moment the workspace resolves. Blocks the queueing pass does own — a disabled kind, an excluded workspace, an incompatible producer — are still recomputed every cycle, so a Cursor upgrade that lifts one still takes effect on its own.
- The blocked reason now says what to do about it: open the folder on this computer, then run `Restart to Apply` to be asked again.
- **Clicking the conflict warning in the status bar does something.** It runs `Resolve Conflicts`, whose first act is to take the synchronization lock — routinely held by this window's own poll for a good part of a minute, with a 60-second wait before it gives up. Taken bare, that produced no notification, no spinner, and no dialog for up to a minute, so the item that had just asked for attention read as a dead button. The wait is now shown. `takeCommandLock` has always accepted a reporter for exactly this reason; `Resolve Conflicts`, `Restore Version History` and `Forget Device` never passed one.

## [0.0.42] - 2026-07-30

Two answers to the same question — what belongs on one computer, and what has to reach all of them.

### Changed

- **UI state is no longer synchronized at all.** Window layout — pinned panels and view containers, hidden views, per-panel state, dismissed-notification counters — now stays on the machine that produced it. Each Cursor window rewrites these keys on its own schedule from what you do on that screen, so they have no shared meaning between computers and nothing to converge on; carrying them raised conflicts with no authored change behind them, thirteen of the sixteen the second machine reported on joining. Releases 0.0.4 through 0.0.41 excluded one churning family at a time — dead chat-panel GUIDs, the pinned-panel union, the reactive-storage blob — and the field kept producing the next one, so the whole kind is now local. Your Cursor User Rules live in the same database table but are a separate resource and still travel, as do settings, keybindings, snippets, tasks, prompts, MCP configuration, extensions, profiles, chats, and workspace storage. Values earlier versions published are still skipped on arrival rather than failing the apply, and nothing is deleted on any device. `cursorSettingSync.ignoredUiStateKeys` consequently has no effect and can be removed from your settings.

### Fixed

- A notepad edited on one computer now reaches the others instead of forcing a choice between two whole files. `notepads.json` is a JSON array keyed by notepad id, so it is merged notepad by notepad: an id only one machine has is kept, an id whose text one side never touched takes the other side's version — the ordinary case where one computer edited and the other simply still holds the old copy — and an edit that raced a deletion survives, because a resurrected notepad can be deleted again while a discarded edit cannot be retyped. First contact between two computers, where there is no common ancestor to read intent from, unions the two lists the same way. The two conflicts left standing on the live pair after 0.0.41 were exactly this, one per workspace, and the manual resolver's whole-file either/or would have thrown away every notepad on the losing side to carry one change.
- Where two versions of the same notepad genuinely differ, the merge only claims a winner when it can prove one, and otherwise asks. A notepad carries no timestamp — its id records when it was created, not when it was last written — so if one text strictly contains the other, that side is the same note with material added and is taken. Anything else is two people's writing with nothing in the file to separate them, so the fork goes to `Resolve Conflicts` with both versions intact rather than being settled by discarding one; there is no warning channel out of a merge, so an election there would have deleted the losing text from both computers with nothing in the output channel to say it happened. The tip's Lamport clock is deliberately not used as a recency signal either: a computer joining an existing repository publishes at the highest clock in it, and on the pair this was built against the joining machine held the higher clock and the *smaller* file for both shared workspaces, so electing by clock would have destroyed the very content this change exists to carry.
- An auto-merged workspace-storage version now advertises its own size. A merge is routinely larger than either side, so inheriting the winning tip's byte count described a payload nobody published.

## [0.0.41] - 2026-07-30

Found on the real two-computer pair the moment the second machine joined.

### Fixed

- A second computer joining no longer raises one unresolvable conflict per shared workspace. Both machines already had their own `state.vscdb` for every Remote-SSH project they both keep open, so neither snapshot descended from the other and the three-way merge had nothing to compare against - the live pair produced 198 of these, and the manual resolver could only offer whole-snapshot either/or, discarding the losing machine's notepads and sessions wholesale. Base-free workspace databases are now unioned the way base-free chats already were: with no ancestor there are no deletions to honour, so every row either machine has is kept, and only a key both hold with differing values is decided - by the replicated-newest tip, so both computers compute byte-identical results and the reconciler collapses them into one version.

## [0.0.40] - 2026-07-29

The final full-scope pass after the convergence series: three reviewers re-read every source file of v0.0.39 whole (58 areas explicitly cleared), raising five findings - one medium, four low - all outside the audited fix chain and all fixed here.

### Fixed

- Auto-merge can no longer destroy a non-UTF-8 user file: concurrently edited binary files whose extension escaped the denylist (.ico, .woff2, .mp3, ...) were diff3-merged as UTF-8, converging both machines on replacement-character soup with no prompt. Merge inputs are now round-trip checked; anything non-textual goes to the manual resolver, which handles binary either/or.
- A displaced lock holder aborts instead of writing blind: refresh() throws when the lock file provably carries another process's token (the stale-takeover race's rarest interleaving), so the helper's error paths roll the write back rather than running a destructive section on a mutex someone else owns.
- The Restore Backup picker resolves each pre-restore snapshot's contract from its record instead of assuming global: a workspace or store snapshot offered as a global restore quit Cursor only to fail (or could import wrong content wholesale); snapshots whose origin record has rotated out are skipped with a log line instead of being mislabeled.
- A repository switch through Setup clears the previous repository's standing helper warnings - they had no re-observation path on the new repository and painted it "Partial" for the rest of the session. Notices from adapters that were turned off (chat sync disabled) are pruned with the adapters instead of standing in diagnostics until reload.

## [0.0.39] - 2026-07-29

Convergence round six: one finding, low severity, confined to the one-release upgrade window.

### Fixed

- The staging-sweep pid check requires the segment to be structurally a pid (all-decimal, followed by the uuid segment): parseInt partial-parsed a pre-0.0.38 name's bare hex suffix into a garbage never-alive pid, deleting on sight the very sibling-window clone the age gate was promised for during the one-release mixed-version window.

## [0.0.38] - 2026-07-29

Convergence round five: one finding, low severity, fixed.

### Fixed

- Clone-staging names carry the process id as well as the hostname token, and the sweep removes a same-machine entry only when its process is provably dead (or the entry outlives any possible clone): opening Setup in a second window could previously delete a sibling window's clone mid-flight, since the hostname token distinguishes machines but not windows.

## [0.0.37] - 2026-07-29

Convergence round four: five findings against the 0.0.36 diff, all narrow lifecycle refinements of that release's own additions.

### Fixed

- The reconnect probe survives configuration changes and disable/re-enable: clearing it inside disposeRuntime meant ANY settings change (which reaches every window) permanently stranded a disconnected-elsewhere window at "locked", and the disabled gate ended the probe chain a re-enable could never restart. The probe now keeps watching while disabled (without resuming sync) and dies only with dispose() and disconnect().
- The leftover-staging sweep is reachable where it matters: Setup clears this machine's clone-staging debris BEFORE its emptiness check, so a failed clone's retry reaches the clone path instead of a picker that only offers creating a divergent repository; the promotion-failure path also removes its staging directory after rolling back. Staging names now carry a hostname-derived token, and another machine's staging directory is only swept when a day old - a bare prefix match could delete the replica of a clone still running on the other computer.
- The changelog's duplicate-heading class is retired: the 0.0.35 duplicate this round introduced and the older 0.0.33/0.0.32 pairs are all deduplicated.

## [0.0.36] - 2026-07-29

Convergence round three: verification of the 0.0.35 diff raised six findings - four distinct, all small, all fixed here. The finding count across rounds (32, then 18, then 6, all progressively narrower in scope) is the convergence the audit series was run for.

### Fixed

- The staged clone's promotion step tolerates transient Windows locks (OneDrive, antivirus) with retries; on unrecoverable failure it moves the promoted entries back and fails with instructions instead of leaving the target half-assembled behind a raw EPERM. Leftover staging directories from an earlier failed clone are cleared automatically, so a retry reaches the clone path again. The mid-clone foreign-file abort now says to WAIT and re-run Setup when the folder syncs from another computer - the previous wording told the user to delete what may be the other machine's repository.
- The reconnect probe respects the enabled setting: a window torn down by a sibling's disconnect and then disabled no longer resumes watching and publishing under a "disabled" status bar after a later Setup; disable, disconnect and a fresh start of watching also cancel any pending probe.

## [0.0.35] - 2026-07-29

Convergence round two: adversarial verification of the 0.0.34 diff itself - 18 findings raised against it, 2 refuted, the rest fixed here. Each is a refinement of a round-one fix, not a regression of older behavior.

### Fixed

- The finalizer arm's completion re-check now distinguishes scopes: a CLOSING window leaves the just-armed (or adopted) exporter running - cancelling it silently cost the machine its shutdown export - while Disable and Disconnect (own window's or a sibling's, via the machine-wide marker) still stand it down; an adopted sibling finalizer is never cancelled by another window's teardown. The arm also passes a copy of the master key, so a Setup re-run during the 30-second replacement wait can no longer hand the finalizer 32 zero bytes.
- A window torn down by a sibling's disconnect marker cancels any in-flight arm's exporter (closing the one-final-export leak) and probes for reconnection - after a Setup elsewhere removes the marker, the window reopens and resumes instead of sitting dark at "unconfigured" until a manual reload.
- The apply/restore claim carries a nonce for its whole life: a leftover veto timer or a stale consumed result can no longer erase a successor attempt's live claim (pid alone cannot tell two attempts from one window apart); the claim is re-stamped and re-verified after the unbounded preparation phase, so a TTL-expired claim taken over by another window makes this attempt stand down instead of double-committing; Restore Backup gained the same config-change abort Restart to Apply has.
- The cancel-marker owner sidecar is bound to its marker by stamp: a crash between the two writes strands a sidecar that would otherwise veto every LATER writer's legitimate cancel forever.
- The claimed-result name embeds the claim instant, closing the rename-to-utimes gap in which a sibling's orphan sweep could still destroy a freshly claimed overnight result.
- The exit-wait listing tolerance gained a budget: an environment where the process listing has NEVER worked fails loudly after ten consecutive failures (surfaced through the stderr log and the red bar) instead of waiting thirty days in silence; transient hiccups after a first success still wait indefinitely, as intended.
- A failed clone can no longer delete files it did not create: cloning goes through a staging subdirectory, failure cleanup is scoped to it, and foreign files that appear in the target mid-clone abort with instructions instead of being removed - in a cloud-synced folder those could be another machine's repository content.
- Torn-checkpoint tolerance is enumerated instead of prefix-matched, so a checkpoint that authenticates and then fails validation (complete and genuinely invalid) fail-stops instead of being skipped forever as "still arriving".
- A device now detects its own forked stream: two event files at one sequence in the device's own directory (the OS-restore fork, if it ever lands despite the 0.0.34 guards) fail-stop with recovery instructions on the one machine that can see both branches, instead of silently extending one of them while every peer wedges.

### Known limits, accepted deliberately

- The OS-restore fork guards read the local replica of the shared folder; a whole-disk restore where the first publish beats cloud rehydration can still fork - the new owner-side detection turns that from a silent permanent wedge into a named, recoverable state.

## [0.0.34] - 2026-07-29

Convergence round one: a fresh-eyes audit of the last three releases' own fixes plus the subsystems no earlier audit had reached (protocol core, the file adapters, the manager command flows), 32 findings adversarially verified. Everything reachable is fixed.

### Fixed - bugs in recent fixes

- The cancel-finalizers marker is a bare ISO timestamp again - the 0.0.33 two-line format read as NaN to a still-running 0.0.32 finalizer, which then NEVER stood down: the session retried "stalled" every minute forever and quit exports ran against the pre-update session's request. The writer's pid and the KIND of handoff live in a sidecar now: a "restart" writer's death voids its cancel immediately (a crashed restart can never arm the replacement it promised), while a "quit" writer is expected to die and keeps its grace window - which also closes the headline 0.0.33 scenario the grace alone could not.
- One transient process-listing failure no longer kills the session's only shutdown exporter: the wait treats it as "Cursor may still be running" and retries, matching the stated policy everywhere else.
- Restart to Apply claims the apply-in-progress marker BEFORE its multi-ten-second pre-quit sync, not after - two windows could both commit to the same apply and each helper then counted the other as a live Cursor until both timed out having applied nothing. Every early exit releases the claim; a consumed stale result no longer erases a DIFFERENT live window's marker (the clear checks the owner pid); the claimed-result sweep stamps the claim time so an overnight export's result is not "an hour-old orphan" the instant it is claimed.
- Disable or Disconnect landing while a finalizer arm is inside its 30-second replacement wait no longer gets overridden by that arm: the arm re-checks on completion and cancels what it just installed.

### Fixed - protocol core

- A device whose extension state was restored from an OS backup can no longer fork its own event stream: stream recovery consults the shared head.json and waits while the device's own newer events are still arriving, and publish refuses a sequence ANY existing file occupies - previously both machines fail-stopped permanently on "previously accepted event has a different hash".
- A checkpoint file caught mid-propagation (zero-byte, truncated, torn ciphertext - checkpoints run tens of MiB over OneDrive) no longer kills every sync cycle and even repository open until it finishes hydrating; it is skipped like a pruned event and retried next poll.
- Every replicated ordering - conflict-winner election, checkpoint tips, event ordering - now compares by UTF-16 code units instead of localeCompare: a Danish/Norwegian locale sorts "aa" after "ab", so a device pair split across locales could elect different winners for the same fork and re-fork forever.
- Checkpoint creation refuses, and prune aborts, when the repository contains resource kinds this build does not know: a future release adding a kind would otherwise have today's build silently omit those resources from its checkpoint and then delete the only events carrying them.

### Fixed - adapters

- Deleting a profile on one machine no longer wipes that profile's keybindings, snippets, tasks and prompts on every other machine: the profile-files adapter gained the vanished-profile guard its sibling adapters always had.
- A duplicated key in settings.json (VS Code tolerates them) no longer silently reverts every remote edit of that key: the apply verifies the edit landed and consumes duplicates until it does.
- Chat stores and transcripts another machine wrote are no longer fully re-read and re-hashed on EVERY 30-second poll forever: the scan refreshes the projection timestamp when content matches, and applied transcripts get their source mtime restored.
- The extension retained-hash records the OBSERVED post-install preRelease/pinned state instead of the peer's desired one, closing a version-skew ping-pong the 0.0.32 fix left open on channel fallbacks.
- A clone killed mid-checkout now cleans up everything it created, not just .git - checked-out files used to block every retry with "must be an empty directory" and no stated cause. Sync commits never invoke GPG signing, so a commit.gpgsign user no longer gets a stray pinentry dialog (or a two-minute hang) from every sync cycle.

### Fixed - command flows

- Disconnect now disconnects the MACHINE, not just the window it ran in: a machine-wide marker makes every sibling window (which observe no globalState events) stop synchronizing and tear down at its next cycle - previously they kept publishing into the folder, green check mark and all.
- Restart to Apply and Restore Backup capture a copy of the master key, so a Disconnect or Setup re-run mid-command can no longer hand the helper an all-zero key; Restart to Apply also aborts if the configuration changed while it was parked in prompts.
- Forget Device requires a modal confirmation (a "(no published events)" entry may be a computer still joining) and the same picker can now RESTORE a forgotten device - retiring was irreversible and silently blinded the machine to a real peer.
- A Setup re-run resets the previous repository's latched failure, notices and declined-offer memory instead of carrying them into the new repository; diagnostics' gitMode reports the LAST git window's outcome instead of latching "degraded" forever after one offline minute.

### Added

- A repeated-rounds two-device simulation (three rounds of concurrent workspace and chat edits converging to a single tip each round), and regression pins for the finalizer adoption-confirm window, the backward-parseable cancel marker, duplicated settings keys, the vanished-profile guard, and code-unit ordering.

## [0.0.33] - 2026-07-29

A backup-and-restore audit under multi-window and multi-computer concurrency: six reviewers over backup creation, retention, the restore flow, the shutdown export, cross-machine semantics and user-facing truth; 70 interleavings traced (most came up clean), 32 findings adversarially verified, none refuted. The reachable ones are fixed.

### Fixed - backup and restore integrity

- The global database apply re-checks that Cursor is still closed immediately before its write transaction - the backup/validate/retention pipeline ahead of it takes minutes on a multi-GiB database, long enough to relaunch Cursor, whose write-back at its next quit silently reverted a commit that was already marked applied. The logical restore re-checks the same way immediately before its DELETE+INSERT, inside the path that first integrity-checks the multi-GiB source.
- The fresh pre-restore backup that an interrupted-restore replay takes is registered with the run, so the same run's retention can no longer evict the only capture of the pre-replay state; the global apply's retention pass also exempts every backup earlier steps of the same run took.
- A queued restore's source backup is exempt from retention until the restore runs - an apply interleaving between the user's confirmation and the helper could previously delete the file the restore was about to read.
- An interrupted restore found more than a day after it started is NOT replayed - days later a destructive rewind to a stale backup is data loss wearing a recovery costume; the journal closes with instructions to re-run Restore Backup deliberately. A replay that does run within the window is disclosed in the result (what was rewound, where the pre-replay copy is) instead of happening silently.

### Fixed - the shutdown export

- A cancel marker whose writer died before arming a replacement expires after a minute instead of standing down the session's only exporter forever; markers now name their writer, and a live writer (a slow quit) keeps its marker valid indefinitely.
- The exit wait no longer trusts a recycled extension-host pid: the authoritative process listing runs on its own cadence, so a stray pid can no longer hold a finalizer for its full thirty-day timeout.
- A helper that vanished without a result is announced out loud - a hard-crashed shutdown export or a restore that never ran used to leave green status everywhere and one Output line; a queued restore cleared by an extension update is named too.
- Arming respects disable (an in-flight arm resolving after the user turns sync off no longer re-installs the exporter), and a failing first sync during Setup no longer costs the session its exporter and polling.

### Fixed - what the user is told

- Final-export warnings consumed mid-session (a vetoed quit) are no longer destroyed unseen: they merge into the standing warnings instead of being skipped past on a path that had already deleted the result file.
- Real per-resource apply failures are promoted to standing warnings; folded into the routine skip list inside a green result, a resource failing identically on every apply was invisible.
- The restore confirmation says that the restored state propagates to other computers through synchronization; Restore Backup participates in the apply-in-progress protocol, so it cannot race a Restart to Apply from another window; helper results another window claimed and never processed are swept after an hour.

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
