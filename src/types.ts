export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WrappedKey {
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface RepositoryKdf {
  algorithm: "scrypt";
  salt: string;
  n: number;
  r: number;
  p: number;
  keyLength: number;
}

export interface RepositoryFile {
  format: "cursor-setting-sync";
  protocolVersion: number;
  repositoryId: string;
  createdAt: string;
  kdf: RepositoryKdf;
  wrappedMasterKey: WrappedKey;
}

export interface DeviceIdentity {
  deviceId: string;
  name: string;
  createdAt: string;
}

export const SUPPORTED_RESOURCE_KINDS = [
  "settings",
  "keybindings",
  "snippet",
  "task",
  "prompt",
  "mcp",
  "extension",
  "profile",
  "ui-state",
  "cursor-user-file",
  "cursor-user-rules",
  "remote-targets",
  "chat",
  "chat-transcript",
  "chat-store",
  "workspace-storage",
] as const;

export type ResourceKind = (typeof SUPPORTED_RESOURCE_KINDS)[number];

/**
 * The kinds only the offline helper can write, mirroring every adapter whose
 * `appliesWhileRunning` is false. Cursor holds those databases open while it
 * runs, so a change to one of them cannot land until Cursor has exited.
 *
 * Kept here rather than derived from the adapters because the repository layer
 * needs it and must not depend on them; `tests/offline-apply-kinds.test.ts`
 * compares the two so they cannot drift apart.
 */
/**
 * The kinds written into the global `state.vscdb` ItemTable.
 *
 * The helper routes prepared changes to one applier or another by kind, and a
 * kind on neither list is silently dropped - prepared, never written, never
 * marked applied, queued forever. `tests/offline-apply-kinds.test.ts` checks
 * this against the write path so the two cannot drift.
 */
export const GLOBAL_DATABASE_KINDS: readonly ResourceKind[] = [
  "chat",
  "ui-state",
  "cursor-user-rules",
  "remote-targets",
  "profile",
];

export const HELPER_APPLIED_KINDS: ReadonlySet<ResourceKind> = new Set([
  "extension",
  "profile",
  "ui-state",
  "cursor-user-rules",
  "remote-targets",
  "chat",
  "chat-transcript",
  "chat-store",
  "workspace-storage",
]);

export function isSupportedResourceKind(value: unknown): value is ResourceKind {
  return (
    typeof value === "string" &&
    (SUPPORTED_RESOURCE_KINDS as readonly string[]).includes(value)
  );
}

export type ResourceOperation = "put" | "delete";

export interface ObjectReference {
  deviceId: string;
  objectId: string;
  compressedBytes: number;
  plainBytes: number;
}

export interface ResourceChange {
  resourceId: string;
  kind: string;
  operation: ResourceOperation;
  parents: string[];
  semanticHash: string;
  payload?: ObjectReference;
  metadata?: Record<string, JsonValue>;
}

export interface EventManifest {
  eventVersion: number;
  createdAt: string;
  lamport: number;
  producer?: EventProducer;
  changes: ResourceChange[];
}

export interface EventProducer {
  extensionVersion: string;
  cursorVersion: string;
  vscodeVersion: string;
}

export interface EventHeader {
  protocolVersion: number;
  envelopeVersion: number;
  repositoryId: string;
  deviceId: string;
  sequence: number;
  previousEventHash: string | null;
}

export interface StoredEvent {
  header: EventHeader;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface StoredObject {
  protocolVersion: number;
  envelopeVersion: number;
  repositoryId: string;
  deviceId: string;
  objectId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface CheckpointResource {
  resourceId: string;
  kind: ResourceKind;
  operation: ResourceOperation;
  semanticHash: string;
  versionId: string;
  lamport: number;
  deviceId: string;
  payload?: ObjectReference;
  metadata?: Record<string, JsonValue>;
  producer?: EventProducer;
}

export interface CheckpointManifest {
  checkpointVersion: 1;
  createdAt: string;
  deviceId: string;
  lamport: number;
  predecessorHash: string | null;
  streams: Record<string, StreamCursor>;
  resources: CheckpointResource[];
}

export interface CheckpointHeader {
  protocolVersion: number;
  envelopeVersion: number;
  repositoryId: string;
  deviceId: string;
  lamport: number;
}

export interface StoredCheckpoint {
  header: CheckpointHeader;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface CheckpointIdentity {
  hash: string;
  lamport: number;
}

export interface AbsorbedCheckpoint extends CheckpointIdentity {
  streams: Record<string, StreamCursor>;
}

export interface DeviceAcks {
  deviceId: string;
  updatedAt: string;
  streams: Record<string, StreamCursor>;
  absorbedCheckpoint: CheckpointIdentity | null;
}

export interface ResourceVersionSummary {
  versionId: string;
  resourceId: string;
  kind: ResourceKind;
  operation: ResourceOperation;
  semanticHash: string;
  lamport: number;
  createdAt: string;
  deviceId: string;
  plainBytes: number | null;
  fromCheckpoint: boolean;
  producer?: EventProducer;
}

export interface ResourceTip {
  versionId: string;
  eventHash: string;
  changeIndex: number;
  kind: ResourceKind;
  lamport: number;
  /**
   * Wall clock of the event that carried this version, for display only.
   * Absent for a version folded into a checkpoint, whose manifest does not
   * retain one. Ordering decisions use `lamport` and never this.
   */
  createdAt?: string;
  deviceId: string;
  operation: ResourceOperation;
  semanticHash: string;
  payload?: ObjectReference;
  parents: string[];
  producer?: EventProducer;
  metadata?: Record<string, JsonValue>;
}

export interface LocalProjection {
  resourceId: string;
  kind: ResourceKind;
  semanticHash: string;
  versionId: string | null;
  payloadObjectId?: string;
  retainedLocalHash?: string;
  sourceTimestamp?: number;
  /** File size captured with the semantic hash for bounded fresh-process scans. */
  sourceFileSize?: number;
  /** File ctime captured with the semantic hash; paired with size and mtime. */
  sourceFileCtimeMs?: number;
  /**
   * How many messages the published version of a chat held.
   *
   * `sourceTimestamp` alone is not a change signal for a chat. Cursor stamps
   * `composerHeaders.lastUpdatedAt` once, near the start of a conversation, and
   * then streams the rest of the messages into `cursorDiskKV` without touching
   * it again. A scan that ran while the conversation had one message published
   * one message, recorded that timestamp, and from then on every later scan
   * compared equal and skipped the chat - so the conversation stayed frozen at
   * its first message in the repository no matter how long it went on. Measured
   * on the real pair: a chat with 63 messages on disk, published with one, and
   * the other computer showing exactly that one.
   */
  sourceBubbleCount?: number;
  /**
   * Hash of the chat's legacy core only (header/composerData/bubbles), without
   * v2 agentKv blobs. This lets a scan prove the user-visible conversation is
   * unchanged without rereading hundreds of megabytes of content-addressed
   * blob rows merely because the repository payload was enriched.
   */
  sourceChatCoreHash?: string;
  /**
   * Hash of the portable composer header only.  Keeping this small observation
   * beside the projection lets the paged chat scanner detect a header edit
   * whose timestamp did not move without retaining an O(total chats) in-memory
   * header map across the sweep.
   */
  sourceHeaderFingerprint?: string;
  /**
   * One-shot request written by the offline helper after a legacy/incomplete
   * automatic bubble repair.  The next live scan must walk the continuation
   * graph even when the repaired v1 core hash already matches this projection.
   * The adapter removes the flag after one bounded graph-capture attempt.
   */
  requiresAgentKvRecapture?: boolean;
}

export interface SyncConflict {
  conflictId: string;
  resourceId: string;
  kind: ResourceKind;
  baseVersionId: string | null;
  tipVersionIds: string[];
  createdAt: string;
  resolvedAt?: string;
}

export interface PendingDatabaseChange {
  eventHash: string;
  changeIndex: number;
  resourceId: string;
  kind: ResourceKind;
  blockedReason?: string;
}

export interface StreamCursor {
  lastSequence: number;
  lastEventHash: string | null;
}

export interface LocalSyncState {
  version: number;
  repositoryId: string;
  device: DeviceIdentity;
  nextSequence: number;
  lamport: number;
  ownStreamHead: string | null;
  streams: Record<string, StreamCursor>;
  checkpoint?: AbsorbedCheckpoint;
  tips: Record<string, ResourceTip[]>;
  projections: Record<string, LocalProjection>;
  conflicts: SyncConflict[];
  pendingDatabaseChanges: PendingDatabaseChange[];
  retiredDevices: string[];
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface ResourceSnapshot {
  resourceId: string;
  kind: ResourceKind;
  content: Buffer;
  semanticHash: string;
  metadata?: Record<string, JsonValue>;
  parents?: string[];
}

export interface ResourceDeletion {
  resourceId: string;
  kind: ResourceKind;
  semanticHash: string;
  metadata?: Record<string, JsonValue>;
  content?: never;
  parents?: string[];
}

export interface ResourceScanResult {
  snapshots: ResourceSnapshot[];
  deletions: ResourceDeletion[];
  /**
   * Something did not reach the repository that was meant to. These become
   * standing warnings and turn the status item amber.
   */
  warnings: string[];
  /**
   * Something was left out on purpose, and saying so is the only way the user
   * finds out. A workspace excluded by a setting, a settings key the built-in
   * machine-scoped list took over, a conversation whose body Cursor pruned:
   * the scan is behaving exactly as configured, and it re-derives the same
   * notice on every single run.
   *
   * Kept apart from {@link warnings} because sharing that channel meant a
   * device that had merely been configured sat permanently at "Partial - some
   * resources were not saved to the repository", which was not true of any of
   * them. Logged and listed in diagnostics; never promoted, never amber.
   */
  notices?: string[];
}

export interface MergeOutcome {
  status: "unchanged" | "merged" | "conflict";
  content?: Buffer;
  semanticHash?: string;
  conflictContent?: Buffer;
}

export interface CompatibilityReport {
  compatible: boolean;
  extensionVersion: string;
  cursorVersion: string;
  vscodeVersion: string;
  nodeVersion: string;
  sqliteAvailable: boolean;
  sqliteBackupAvailable: boolean;
  globalDatabasePath: string;
  databaseCapabilities: Record<DatabaseCapability, DatabaseCapabilityStatus>;
  reasons: string[];
  warnings: string[];
}

export type DatabaseCapability =
  | "global-item-table"
  | "global-chat"
  | "sqlite-files";

export interface DatabaseCapabilityStatus {
  available: boolean;
  reasons: string[];
}

export interface DiagnosticStandingWarning {
  /** Adapter id, or "reconciler". */
  source: string;
  warning: string;
  firstSeenAt: string;
  /** Human-readable age, e.g. "2h 11m". */
  standingFor: string;
  lastLoggedAt: string;
  observations: number;
  /** Reconciler stream warnings block compaction and checkpointing. */
  blocksMaintenance: boolean;
  /** Publish warnings mean a resource is not reaching the other devices. */
  blocksPublish: boolean;
}

export interface DiagnosticPendingChange {
  resourceId: string;
  kind: ResourceKind;
  /** Why the change cannot be applied yet, or null when it is simply queued. */
  blockedReason: string | null;
}

/** Every `cursorSettingSync.*` value actually in use, legacy fallbacks resolved. */
export interface DiagnosticConfiguration {
  enabled: boolean;
  pollIntervalSeconds: number;
  chatPollIntervalSeconds: number;
  autoApplyFiles: boolean;
  syncChat: boolean;
  syncWorkspaceStorage: boolean;
  applyOnShutdown: boolean;
  gitSync: boolean;
  maxPayloadMiB: number;
  useDefaultIgnoredSettings: boolean;
  ignoredSettings: string[];
  ignoredExtensions: string[];
  ignoredUserFiles: string[];
  ignoredUiStateKeys: string[];
}

export interface DiagnosticSnapshot {
  generatedAt: string;
  compatibility: CompatibilityReport;
  configured: boolean;
  repositoryPath: string | null;
  deviceId: string | null;
  pendingDatabaseChanges: number;
  pending: DiagnosticPendingChange[];
  conflicts: number;
  conflictResourceIds: string[];
  effectiveConfiguration: DiagnosticConfiguration;
  /** The built-in machine-specific keys in force, empty when opted out. */
  defaultIgnoredSettings: string[];
  /** Everything excluded as machine-specific, defaults and extensions merged. */
  machineScopedSettings: string[];
  gitMode: "off" | "enabled" | "degraded";
  workspaceMappings: Record<string, string>;
  /** The adapters currently constructed; absent kinds are not synchronizing. */
  adapters: string[];
  standingWarnings: DiagnosticStandingWarning[];
  /** Deliberate exclusions. Reported, never counted; see ResourceScanResult.notices. */
  deliberateExclusions?: DiagnosticStandingWarning[];
  lastSyncAt: string | null;
  lastError: string | null;
  repositoryBytes?: number;
}

export interface ApplyJournal {
  version: number;
  requestId: string;
  status:
    | "pending"
    | "backed-up"
    | "applying"
    | "committed"
    | "verified"
    | "restored"
    | "failed";
  databasePath: string;
  backupPath: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}
