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
  "chat",
  "chat-transcript",
  "chat-store",
  "workspace-storage",
] as const;

export type ResourceKind = (typeof SUPPORTED_RESOURCE_KINDS)[number];

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
  warnings: string[];
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

export interface DiagnosticSnapshot {
  generatedAt: string;
  compatibility: CompatibilityReport;
  configured: boolean;
  repositoryPath: string | null;
  deviceId: string | null;
  pendingDatabaseChanges: number;
  conflicts: number;
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
