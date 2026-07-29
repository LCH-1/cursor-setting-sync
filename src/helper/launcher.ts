import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import * as vscode from "vscode";
import {
  CURSOR_EXIT_WAIT_MS,
  HELPER_REQUEST_VERSION,
  QUIT_START_GRACE_MS,
} from "../constants";
import type { CompatibilityReport } from "../types";
import { cursorExecutableForRestart } from "../platform/compatibility";
import type { CursorPaths } from "../platform/paths";
import { pathExists, writeFileAtomic, writeJsonAtomic } from "../platform/files";
import { acquireFileLock } from "../platform/lock";
import type { DatabaseContract } from "./database";
import type { HelperChange, HelperRequest } from "./types";

export type HelperSyncOptions = HelperRequest["syncOptions"];

/**
 * How a request to install this window's shutdown finalizer ended.
 *
 * - `armed`: the previous finalizer exited and this window's replacement holds
 *   the lock.
 * - `adopted`: another window installed a finalizer AFTER this window asked the
 *   old one to stand down. That one never reads this window's cancel marker as
 *   addressed to it (the marker predates it), so waiting out the 30 seconds and
 *   failing was guaranteed - and pointless, because a live finalizer with
 *   current state already covers the shutdown export. Seven windows restoring
 *   at once made this the COMMON activation path, and the guaranteed failure
 *   took the whole activation down with it.
 * - `stalled`: the standing finalizer neither exited nor qualified for
 *   adoption within the wait - typically one mid-export from the previous
 *   quit, which only polls its cancel marker while waiting for Cursor to
 *   exit. It finishes and releases on its own; the caller retries later
 *   instead of dying.
 */
export type FinalizerReplaceOutcome = "armed" | "adopted" | "stalled";

/**
 * The apply helper waits up to 180 seconds for every Cursor process to exit.
 * A re-armed finalizer is itself a Cursor.exe process, so re-arming before the
 * helper gives up would keep it from ever seeing zero other Cursor processes.
 */
export const QUIT_VETO_CHECK_DELAY_MS = CURSOR_EXIT_WAIT_MS + 30_000;

export class HelperLauncher {
  private finalizer: ChildProcess | null = null;
  private quitVetoTimer: NodeJS.Timeout | null = null;
  private quitStartedTimer: NodeJS.Timeout | null = null;
  private readonly cancelFinalizersPath: string;

  constructor(
    private readonly paths: CursorPaths,
    private readonly compatibility: CompatibilityReport,
    /** Test seam: how long a finalizer replacement waits for the old holder. */
    private readonly replaceWaitMs = 30_000,
  ) {
    this.cancelFinalizersPath = join(paths.extensionStorage, "cancel-finalizers");
  }

  async startFinalizer(
    repositoryRoot: string,
    masterKey: Buffer,
    workspaceMappings: Record<string, string>,
    syncOptions: HelperSyncOptions,
  ): Promise<void> {
    await rm(this.cancelFinalizersPath, { force: true });
    await rm(`${this.cancelFinalizersPath}-owner`, { force: true });
    const request = this.createRequest(
      "final-export",
      repositoryRoot,
      false,
      [],
      workspaceMappings,
      syncOptions,
    );
    this.finalizer = await this.launch(request, masterKey);
  }

  async restartFinalizer(
    repositoryRoot: string,
    masterKey: Buffer,
    workspaceMappings: Record<string, string>,
    syncOptions: HelperSyncOptions,
  ): Promise<FinalizerReplaceOutcome> {
    const cancelledAt = await this.cancelFinalizers();
    const wait = await this.waitForFinalizersToExit(cancelledAt);
    if (wait !== "free") {
      return wait;
    }
    await this.startFinalizer(
      repositoryRoot,
      masterKey,
      workspaceMappings,
      syncOptions,
    );
    return "armed";
  }

  /** Returns the marker timestamp, for comparing against a later holder. */
  async cancelFinalizers(): Promise<number> {
    return this.writeCancelMarker("restart");
  }

  /**
   * The marker file itself stays a bare ISO timestamp - the one format every
   * fielded finalizer, 0.0.32 included, parses. The writer's identity and the
   * KIND of handoff live in a sidecar: a "restart" writer promises to arm a
   * replacement (so its death voids the cancel), a "quit" writer is expected
   * to die (the window is closing) and its cancel survives it for a grace
   * window. Folding either into the marker bytes made older finalizers read
   * NaN and never stand down.
   */
  private async writeCancelMarker(kind: "restart" | "quit"): Promise<number> {
    const stamp = new Date().toISOString();
    await writeJsonAtomic(`${this.cancelFinalizersPath}-owner`, {
      pid: process.pid,
      kind,
    });
    await writeFileAtomic(
      this.cancelFinalizersPath,
      Buffer.from(stamp, "utf8"),
    );
    this.finalizer?.kill();
    this.finalizer = null;
    return Date.parse(stamp);
  }

  async applyAndRestart(
    repositoryRoot: string,
    masterKey: Buffer,
    changes: HelperChange[],
    workspaceMappings: Record<string, string>,
    syncOptions: HelperSyncOptions,
    onQuitVetoed: () => Promise<void> = async () => {},
    onQuitStalled: () => void = () => {},
  ): Promise<void> {
    await this.writeCancelMarker("quit");
    const request = this.createRequest(
      "apply-and-restart",
      repositoryRoot,
      true,
      changes,
      workspaceMappings,
      syncOptions,
    );
    await this.launch(request, masterKey);
    await saveNamedEditors();
    // Armed before the quit, not after. `workbench.action.quit` is awaited, and
    // a quit whose promise never settles left both timers unarmed - so the
    // shutdown finalizer was never re-armed either, costing the session its
    // only workspaceStorage export on exactly the runs where the quit misfired.
    this.scheduleQuitStartedCheck(onQuitStalled);
    this.scheduleQuitVetoCheck(onQuitVetoed);
    await vscode.commands.executeCommand("workbench.action.quit");
  }

  async restoreAndRestart(
    repositoryRoot: string,
    masterKey: Buffer,
    backupPath: string,
    syncOptions: HelperSyncOptions,
    restoreTarget?: { targetPath: string; contract: DatabaseContract },
    onQuitVetoed: () => Promise<void> = async () => {},
    onQuitStalled: () => void = () => {},
  ): Promise<void> {
    await this.writeCancelMarker("quit");
    const request = this.createRequest(
      "restore-backup",
      repositoryRoot,
      true,
      [],
      {},
      syncOptions,
    );
    request.backupToRestore = backupPath;
    if (restoreTarget !== undefined) {
      request.restoreTargetPath = restoreTarget.targetPath;
      request.restoreContract = restoreTarget.contract;
    }
    await this.launch(request, masterKey);
    await saveNamedEditors();
    // Both timers armed before the quit for the same reason as in
    // `applyAndRestart`: a quit whose promise never settles left the stall
    // undetected and the veto check unarmed.
    this.scheduleQuitStartedCheck(onQuitStalled);
    this.scheduleQuitVetoCheck(onQuitVetoed);
    await vscode.commands.executeCommand("workbench.action.quit");
  }

  /**
   * If the user vetoes the quit dialog the extension host keeps running while
   * the helper times out. This timer only fires after the helper's exit-wait
   * window has elapsed, so the caller can re-arm the shutdown finalizer and
   * keep exporting session changes without starving a still-waiting apply.
   * A successful quit kills the extension host first; the timer is unref'd so
   * it never keeps the host alive, and dispose() clears it on deactivation.
   */
  private scheduleQuitVetoCheck(onQuitVetoed: () => Promise<void>): void {
    if (this.quitVetoTimer !== null) {
      clearTimeout(this.quitVetoTimer);
    }
    this.quitVetoTimer = setTimeout(() => {
      this.quitVetoTimer = null;
      void onQuitVetoed();
    }, QUIT_VETO_CHECK_DELAY_MS);
    this.quitVetoTimer.unref();
  }

  /**
   * Says something while the helper is still waiting, rather than after it has
   * given up.
   *
   * `workbench.action.quit` is advisory. When nothing acts on it there is no
   * error and no dialog: the helper waits out its whole budget and the failure
   * surfaces minutes later, by which time the user has concluded the feature is
   * broken. This timer only survives to fire if the quit did not happen, since
   * a successful one tears the extension host down first, and it is unref'd so
   * it never keeps the host alive.
   */
  private scheduleQuitStartedCheck(onQuitStalled: () => void): void {
    if (this.quitStartedTimer !== null) {
      clearTimeout(this.quitStartedTimer);
    }
    this.quitStartedTimer = setTimeout(() => {
      this.quitStartedTimer = null;
      onQuitStalled();
    }, QUIT_START_GRACE_MS);
    this.quitStartedTimer.unref();
  }

  dispose(): void {
    if (this.quitVetoTimer !== null) {
      clearTimeout(this.quitVetoTimer);
      this.quitVetoTimer = null;
    }
    if (this.quitStartedTimer !== null) {
      clearTimeout(this.quitStartedTimer);
      this.quitStartedTimer = null;
    }
  }

  private createRequest(
    mode: HelperRequest["mode"],
    repositoryRoot: string,
    restart: boolean,
    changes: HelperChange[],
    workspaceMappings: Record<string, string>,
    syncOptions: HelperSyncOptions,
  ): HelperRequest {
    return {
      version: HELPER_REQUEST_VERSION,
      requestId: randomUUID(),
      mode,
      createdAt: new Date().toISOString(),
      repositoryRoot,
      storageRoot: this.paths.extensionStorage,
      cursorExecutable: cursorExecutableForRestart(),
      extensionHostPid: process.pid,
      restart,
      expectedCursorVersion: this.compatibility.cursorVersion,
      expectedVscodeVersion: this.compatibility.vscodeVersion,
      extensionVersion: this.compatibility.extensionVersion,
      paths: this.paths,
      changes,
      workspaceMappings,
      syncOptions,
    };
  }

  private async launch(
    request: HelperRequest,
    masterKey: Buffer,
  ): Promise<ChildProcess> {
    if (!(await pathExists(this.paths.helperScript))) {
      throw new Error(`Helper script is missing: ${this.paths.helperScript}`);
    }
    const requestPath = join(
      this.paths.extensionStorage,
      `helper-request-${request.requestId}.json`,
    );
    await writeJsonAtomic(requestPath, request);
    const environment = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    };
    // stderr was discarded, so a helper that died before it could write a
    // result - a missing module, a bad runtime, anything at import time -
    // left nothing behind but an unconsumed request file and a queue that
    // never shrank. It goes to a file next to the request instead, which
    // `consumeHelperResults` reports and removes.
    const errorLog = await open(`${requestPath}.stderr.log`, "a");
    const child = spawn(process.execPath, [this.paths.helperScript, requestPath], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "ignore", errorLog.fd],
      env: environment,
    });
    void errorLog.close();
    await new Promise<void>((resolve, reject) => {
      const stdin = child.stdin;
      if (stdin === null) {
        reject(new Error("Unable to open the helper key pipe."));
        return;
      }
      const onError = (error: Error): void => {
        stdin.off("error", onError);
        reject(error);
      };
      stdin.once("error", onError);
      stdin.end(`${masterKey.toString("base64")}\n`, () => {
        stdin.off("error", onError);
        resolve();
      });
    });
    child.unref();
    return child;
  }

  private async waitForFinalizersToExit(
    cancelledAt: number,
  ): Promise<"free" | FinalizerReplaceOutcome> {
    const lockPath = join(this.paths.extensionStorage, "shutdown-finalizer.lock");
    const startedAt = Date.now();
    // A crashed finalizer's lock needs no handling here: its pid is dead, so
    // isLockStale reads it as stale immediately (no TTL wait) and the acquire
    // below breaks it through the atomic rename-verify takeover. An explicit
    // rm() was tried and is strictly worse - between reading the holder and
    // removing the file, a successor can create a LIVE lock at the same path.
    let candidate: { pid: number; createdAt: number; seenAt: number } | null =
      null;
    while (Date.now() - startedAt < this.replaceWaitMs) {
      const lock = await acquireFileLock(lockPath);
      if (lock !== null) {
        await lock.release();
        return "free";
      }
      const holder = await readFinalizerLockHolder(lockPath);
      if (
        holder !== null &&
        processAlive(holder.pid) &&
        holder.createdAt > cancelledAt
      ) {
        // A lock stamped after this window's cancel marker is not proof the
        // holder will stay: the marker is compared against the REQUEST's
        // createdAt (stamped before spawn), so a finalizer whose boot spanned
        // the marker write acquires the lock and then cancels itself
        // milliseconds later. Adopting it would leave the session with no
        // finalizer at all while every window logs success. A holder is only
        // adopted once the SAME lock has survived a full second - a doomed
        // one releases within tens of milliseconds of acquiring.
        if (
          candidate !== null &&
          candidate.pid === holder.pid &&
          candidate.createdAt === holder.createdAt
        ) {
          if (Date.now() - candidate.seenAt >= ADOPTION_CONFIRM_MS) {
            return "adopted";
          }
        } else {
          candidate = {
            pid: holder.pid,
            createdAt: holder.createdAt,
            seenAt: Date.now(),
          };
        }
      } else {
        candidate = null;
      }
      await delay(100);
    }
    return "stalled";
  }
}

const ADOPTION_CONFIRM_MS = 1_000;

/**
 * The holder a finalizer lock names, or null while the file is unreadable -
 * including the milliseconds mid-creation, which must read as "someone is
 * there", not as breakable.
 */
async function readFinalizerLockHolder(
  lockPath: string,
): Promise<{ pid: number; createdAt: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      createdAt?: unknown;
    };
    const createdAt =
      typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
    if (typeof parsed.pid !== "number" || !Number.isFinite(createdAt)) {
      return null;
    }
    return { pid: parsed.pid, createdAt };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a live process this user may not signal; only ESRCH is absence.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Saves every dirty editor that already has a file, and deliberately not the
 * ones that do not.
 *
 * This used to be `workbench.action.files.saveAll`, which for an untitled
 * document opens the native Save As dialog and waits. The await then never
 * resolves, so `workbench.action.quit` on the next line was never issued at
 * all - and the helper, which is waiting for the process list to empty, sat
 * through its whole budget and reported that Cursor had not exited. One
 * scratch buffer somebody had never saved was enough to make "Restart to
 * Apply" fail every single time, with a dialog that is easy to miss behind
 * the window.
 *
 * Nothing is lost by skipping them: VS Code's `files.hotExit` preserves
 * untitled buffers across a quit by default, which is exactly what would have
 * happened had the command never asked.
 */
async function saveNamedEditors(): Promise<void> {
  await vscode.workspace.saveAll(false);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
