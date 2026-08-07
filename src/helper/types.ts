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
  /**
   * Authenticated publisher of the event carrying this change. The helper
   * derives this from the reconciled projection instead of trusting repair
   * metadata, and older request files may omit it.
   */
  sourceDeviceId?: string;
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
    /**
     * Whether the shutdown finalizer writes the queue as well as exporting it.
     *
     * Absent in helper-request files written before this option existed, and a
     * finalizer armed by an older build carries no such field - so the reader
     * treats only an explicit `false` as off. Getting that backwards would
     * silently stop applying for anyone mid-upgrade.
     */
    applyOnShutdown?: boolean;
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
  /**
   * The run stopped because Cursor was open again, not because anything went
   * wrong. Nothing was written, the queue is untouched, and the next shutdown
   * applies it.
   *
   * Reported apart from `success` because the two call for opposite
   * treatment. A real failure is a red status bar and a notification: the user
   * has to do something. This is neither - it is the ordinary outcome of
   * closing Cursor and opening it again before the offline pass finished,
   * which became routine when 0.0.49 started applying the whole queue at
   * shutdown rather than only exporting. Painting it red taught the user to
   * ignore the one signal that means their data did not land.
   *
   * Absent on results written before 0.0.54; the consumer falls back to the
   * message text for those.
   */
  interrupted?: boolean;
  /**
   * When the helper process started, so the extension host can report how long
   * an offline pass took. Cursor is closed for the whole of one, so this is the
   * only way the duration is ever visible. Absent before 0.0.55.
   */
  startedAt?: string;
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
