import type {
  JsonValue,
  ObjectReference,
  ResourceKind,
  ResourceOperation,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import type { DatabaseContract } from "./database";

export interface HelperChange {
  eventHash: string;
  changeIndex: number;
  resourceId: string;
  kind: ResourceKind;
  operation: ResourceOperation;
  semanticHash: string;
  payload?: ObjectReference;
  metadata?: Record<string, JsonValue>;
}

export interface HelperRequest {
  version: number;
  requestId: string;
  mode: "apply-and-restart" | "final-export" | "restore-backup";
  createdAt: string;
  repositoryRoot: string;
  storageRoot: string;
  cursorExecutable: string;
  extensionHostPid: number;
  restart: boolean;
  expectedCursorVersion: string;
  expectedVscodeVersion: string;
  extensionVersion: string;
  paths: CursorPaths;
  changes: HelperChange[];
  workspaceMappings: Record<string, string>;
  syncOptions: {
    ignoredSettings: string[];
    ignoredExtensions: string[];
    /** Absent in helper-request files written before this option existed. */
    ignoredUserFiles?: string[];
    machineScopedSettings: string[];
    syncChat: boolean;
    syncWorkspaceStorage: boolean;
    maxPayloadBytes: number;
    /**
     * Absent in helper-request files written before this option existed;
     * treated as enabled when absent.
     */
    gitSync?: boolean;
  };
  backupToRestore?: string;
  restoreTargetPath?: string;
  restoreContract?: DatabaseContract;
}

export interface HelperBackup {
  backupPath: string;
  contract: DatabaseContract;
  targetPath: string;
}

export interface HelperResult {
  requestId: string;
  success: boolean;
  completedAt: string;
  applied: string[];
  skipped: string[];
  backupPath: string | null;
  backups?: HelperBackup[];
  error: string | null;
}
