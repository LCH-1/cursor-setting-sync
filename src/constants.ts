export const EXTENSION_ID = "lch.cursor-setting-sync";
export const REPOSITORY_FORMAT = "cursor-setting-sync";
export const CRYPTO_CONTEXT = "cursor-setting-sync";
export const PROTOCOL_VERSION = 1;
export const CHECKPOINTED_EVENT_PROTOCOL_VERSION = 2;
export const LOCAL_STATE_VERSION = 1;
export const EVENT_ENVELOPE_VERSION = 1;
export const OBJECT_ENVELOPE_VERSION = 1;
export const CHECKPOINT_ENVELOPE_VERSION = 1;
export const HELPER_REQUEST_VERSION = 1;

export const REPOSITORY_FILE = "repo.json";
export const LOCAL_STATE_FILE = "sync-state.json";
export const DEVICE_FILE = "device.json";
export const APPLY_JOURNAL_FILE = "apply-journal.json";
export const HELPER_REQUEST_FILE = "helper-request.json";
export const BACKUP_DIRECTORY = "backups";
export const QUARANTINE_DIRECTORY = "quarantine";

export const EVENT_EXTENSION = ".cse";
export const OBJECT_EXTENSION = ".cso";
export const CHECKPOINT_EXTENSION = ".csc";
export const PARTIAL_EXTENSION = ".partial";

/**
 * How long a warning that keeps reappearing stays quiet between log lines. Long
 * enough that a 30-second poll does not repeat it, short enough that a
 * permanent problem — a stream gap blocking compaction, a broken adapter — is
 * never silent for the lifetime of the extension host.
 */
export const STANDING_WARNING_REMINDER_MS = 60 * 60 * 1000;
/**
 * How long a cycle must run before the status bar switches to the spinner. A
 * steady-state cycle finishes inside this window and never touches the status
 * item, so the bar keeps showing whatever the user can act on instead of
 * flickering between a spinner and a result several times a minute.
 */
export const SYNC_INDICATOR_DELAY_MS = 2000;

/**
 * How many event files may accumulate before the poll path runs the same
 * checkpoint-and-prune the manual command runs. Nothing used to schedule that
 * command, so the event log, the blob store and the shared folder grew without
 * bound and every sync cycle got slower as the repository aged. The threshold
 * is high enough that a normal week never reaches it and low enough that the
 * per-cycle cost stays flat.
 */
export const AUTOMATIC_CHECKPOINT_EVENT_THRESHOLD = 500;
/**
 * Minimum spacing between automatic maintenance attempts. Every phase is gated
 * (a warning-free reconcile, every device acked, a 24-hour-old checkpoint), so
 * an attempt that cannot proceed must not be retried on the next poll.
 */
export const AUTOMATIC_CHECKPOINT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Minimum spacing between two publications of the same resource while it sits
 * in an unresolved conflict.
 *
 * A conflicted side deliberately keeps publishing its own tip so the conflict
 * stays representable (see `parentsWithOwnConflictTips`). For a resource whose
 * content is stable that costs nothing — `shouldPublishSnapshot` already
 * suppresses a snapshot whose hash matches an existing tip. For a VOLATILE one
 * it costs a genuinely-new event on every poll, forever, because a conflicted
 * resource never gets a projection and so never short-circuits: 23 conflicts on
 * a 30-second poll is what grew the user's repository by thousands of events a
 * day. An hour is far longer than the poll and far shorter than the time a user
 * takes to answer the conflict prompt, and the manual resolver reads the LIVE
 * local snapshot rather than the published tip, so a stale tip costs nothing
 * the user can see.
 */
export const CONFLICTED_REPUBLISH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long the conflict resolver waits for the sync lock before giving up on
 * applying answers the user has already given. A poll is seconds of work, so
 * this only has to outlast one; it is not a deadline for anything the user is
 * waiting on beyond that.
 */
export const CONFLICT_APPLY_LOCK_WAIT_MS = 60_000;

/**
 * How long a command the user invoked waits for the synchronization lock.
 *
 * Every command took the lock in a single attempt and failed outright if a
 * routine poll happened to hold it - and `Restart to Apply` runs a full sync
 * first, so it released the lock and then raced the background cycle for it a
 * moment later. The user is told "another Cursor window or the offline helper
 * is synchronizing" about, usually, this window's own poll, and the command
 * they asked for simply does not happen.
 *
 * A poll is seconds of work, so waiting it out is the only outcome anyone would
 * choose. This only has to outlast one cycle; it is not a deadline for anything
 * the user is waiting on beyond that.
 */
export const COMMAND_LOCK_WAIT_MS = 60_000;

/**
 * How long the poll path stays quiet about a sync lock it keeps failing to take.
 *
 * A held lock is the normal state while a long cycle or the offline helper runs,
 * and every skipped poll used to write its own line: two lines every thirty
 * seconds, per window, for as long as it lasted. A real session buried its
 * standing warnings under thousands of them. Going silent instead is not an
 * option either — a lock held for an hour is a problem the user has to be able
 * to see — so the first skip is reported, and after that only a change of holder
 * or this interval says it again. Three reminders fit inside the lock's own
 * fifteen-minute staleness window.
 */
export const LOCK_SKIP_REMINDER_MS = 5 * 60_000;

/** The extension's single public Command Palette entry. */
export const MANAGE_COMMAND = "cursorSync.manage";
export const MANAGE_TITLE = "Cursor Setting Sync: Manage";

/**
 * Queued database writes are normally applied by the shutdown finalizer. These
 * compatibility names point every exceptional retry affordance at the one
 * public management command and name the exact action inside it.
 */
export const RESTART_TO_APPLY_COMMAND = MANAGE_COMMAND;
export const RESTART_TO_APPLY_TITLE = `${MANAGE_TITLE} → Sync & Apply Now`;

/**
 * How often the apply's preparation repeats the phase it is still on.
 *
 * Each phase logs when it starts, so a slow one leaves the channel silent for
 * as long as it runs - which is precisely when somebody goes looking. Rare
 * enough not to bury the log, frequent enough to answer "is this moving".
 */
export const RESTART_TO_APPLY_HEARTBEAT_MS = 30_000;

/**
 * A cycle slower than this says so in the log when it ends.
 *
 * The duration is otherwise invisible, and it is the number that decides
 * whether the poll interval is long enough to leave the queue any idle: a
 * cycle that outlasts it means the drain is running back to back, which is
 * both a CPU cost and what starves a command of the lock.
 */
export const SLOW_SYNC_CYCLE_MS = 60_000;

/**
 * Marks a queued change the offline helper tried to write and could not.
 *
 * Shared by the helper (which sets it) and the extension host (which must not
 * clear it on the next poll), so the two cannot drift. Matched on this prefix
 * alone: the rest of the line is the underlying error, which differs per
 * resource and changes wording between releases.
 *
 * A per-resource apply failure is deliberately survivable - one corrupt
 * database must not abort the batch - so the entry stays queued, which is
 * correct. What was missing is that a queued entry is also an OFFER: it counts
 * toward the modal that quits Cursor to write it. A resource that fails the
 * same way every time therefore re-offered itself after every single restart,
 * quitting Cursor each round to run an apply that could not succeed. The user's
 * second computer did exactly that on a workspace database whose local copy
 * fails SQLite's quick_check ("wrong # of entries in index"): the pre-write
 * backup cannot be taken, the helper refuses to write without one - rightly -
 * and "applied 0 resource(s)" left the queue exactly as it found it.
 *
 * Blocking stops the offer without discarding the change: it stays in the queue
 * and in diagnostics with the real reason attached, and an explicit
 * {@link RESTART_TO_APPLY_TITLE} clears the block and tries again.
 */
export const APPLY_FAILURE_BLOCK_PREFIX =
  "The last apply could not write this resource";

/**
 * How long after issuing the quit this window waits before concluding that the
 * quit never started.
 *
 * `workbench.action.quit` is advisory, and when it does nothing there is no
 * error and no dialog - the helper simply waits out its whole exit budget and
 * reports a timeout minutes later. A user on 0.0.9 sat through the full 180
 * seconds with no indication anything was wrong, then found Cursor still open.
 *
 * A quit that is working tears this extension host down in a second or two, so
 * a timer this long cannot fire during a healthy shutdown; and it is far short
 * of the helper's own budget, so the news arrives while the helper is still
 * waiting and closing Cursor by hand still completes the apply.
 */
export const QUIT_START_GRACE_MS = 15_000;

/**
 * The built-in workspace exclusion `cursorSettingSync.syncLocalWorkspaces`
 * switches off. Matches every local folder workspace and nothing remote.
 */
export const LOCAL_WORKSPACE_PATTERN = "file://*";

/**
 * How long a shutdown finalizer waits for Cursor to exit before giving up.
 *
 * Effectively "however long this editing session lasts", and deliberately so.
 * A finalizer that times out throws out of `waitForCursorExit` before
 * `exportFinalChanges` ever runs, and `restart` is false for this mode, so
 * nothing recovers and nothing re-arms until the next activation - meaning the
 * session's shutdown export, the only path that ever backs up workspaceStorage,
 * is silently lost. Anyone who leaves Cursor open longer than the budget and
 * then quits pays that price, so the budget has to outlast any plausible
 * session. Shortening it to make the waiting process tidy would trade a
 * cosmetic problem for a data one.
 */
export const FINALIZER_EXIT_WAIT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long an apply or restore helper waits for every Cursor process to exit.
 *
 * Deliberately shorter than {@link QUIT_VETO_CHECK_DELAY_MS} in the launcher: a
 * re-armed shutdown finalizer is itself a `Cursor.exe`, so re-arming before
 * this budget elapses would keep the helper from ever seeing zero.
 */
export const CURSOR_EXIT_WAIT_MS = 180_000;

/**
 * How fresh `shutdown-finalizer.lock` must be before its recorded pid is
 * believed and excluded from the running-Cursor count.
 *
 * The holder refreshes the file every minute, so a lock older than this has no
 * live owner - and trusting a stale one would subtract a recycled pid, which is
 * to say a genuine Cursor window, from the list the exit wait depends on.
 * Matches the lock layer's own staleness rule.
 */
export const FINALIZER_LOCK_TRUST_MS = 15 * 60_000;

export const DEFAULT_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_CHAT_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_MAX_PAYLOAD_MIB = 128;
export const MAX_EVENT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_CHECKPOINT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_OBJECT_ENVELOPE_BYTES = 1537 * 1024 * 1024;
export const MAX_EVENT_CHANGES = 10_000;
export const MAX_APPLY_BATCH_BYTES = 512 * 1024 * 1024;
/** Fixed in-process payload envelope for one offline helper apply page. */
export const MAX_HELPER_APPLY_WORK_BYTES = 32 * 1024 * 1024;
/** Fixed extension-host envelope for one appliesWhileRunning payload. */
export const MAX_RUNNING_APPLY_PAYLOAD_BYTES = 32 * 1024 * 1024;
/** Fixed extension-host envelope for the payload copied into a prune marker. */
export const MAX_CHECKPOINT_MARKER_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_PARENTS_PER_CHANGE = 256;

export const AES_KEY_BYTES = 32;
export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;
export const SCRYPT_N = 131072;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

export const TARGET_STORAGE_MARKER = "__$__targetStorageMarker";
export const USER_STORAGE_TARGET = 0;
export const CURSOR_USER_RULES_KEY = "aicontext.personalContext";
