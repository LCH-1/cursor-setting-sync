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

export const DEFAULT_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_CHAT_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_MAX_PAYLOAD_MIB = 128;
export const MAX_EVENT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_CHECKPOINT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_OBJECT_ENVELOPE_BYTES = 1537 * 1024 * 1024;
export const MAX_EVENT_CHANGES = 10_000;
export const MAX_APPLY_BATCH_BYTES = 512 * 1024 * 1024;
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
