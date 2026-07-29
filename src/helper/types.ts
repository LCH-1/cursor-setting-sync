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
    /** Absent in helper-request files written before this option existed. */
    ignoredUiStateKeys?: string[];
    /**
     * Absent in helper-request files written before this option existed.
     *
     * The shutdown export is the only path that ever scans workspaceStorage, so
     * without this the exclusion would hold on the apply side and be ignored by
     * the half that actually takes the backups.
     */
    ignoredWorkspaces?: string[];
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
  /**
   * Which request produced this result; absent on results written before
   * 0.0.32. A final-export success says nothing about a failed apply, so the
   * consumer must not let one clear the apply-failure bar.
   */
  mode?: HelperRequest["mode"];
  success: boolean;
  completedAt: string;
  applied: string[];
  /**
   * Everything the helper did not do, routine and otherwise: a superseded
   * change, a tombstone it deliberately retained, a ui-state key this version
   * excludes — and, mixed in, the entries of {@link HelperResult.warnings}.
   * Only ever logged.
   */
  skipped: string[];
  /**
   * The subset of {@link HelperResult.skipped} that means something did not
   * reach the repository: a transport failure, an adapter that threw during
   * the shutdown scan, or a resource dropped for exceeding the payload limit.
   * These are promoted to standing warnings in the extension host, because a
   * successful result is otherwise indistinguishable from a clean one.
   *
   * Absent in results written by helpers older than 0.0.5; the extension host
   * falls back to reporting nothing rather than guessing which of the mixed
   * `skipped` entries were routine.
   */
  warnings?: string[];
  backupPath: string | null;
  backups?: HelperBackup[];
  error: string | null;
}
