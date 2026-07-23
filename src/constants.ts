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
