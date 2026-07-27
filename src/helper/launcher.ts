import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
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
  ): Promise<void> {
    await this.cancelFinalizers();
    await this.waitForFinalizersToExit();
    await this.startFinalizer(
      repositoryRoot,
      masterKey,
      workspaceMappings,
      syncOptions,
    );
  }

  async cancelFinalizers(): Promise<void> {
    await writeFileAtomic(
      this.cancelFinalizersPath,
      Buffer.from(new Date().toISOString(), "utf8"),
    );
    this.finalizer?.kill();
    this.finalizer = null;
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
    await writeFileAtomic(
      this.cancelFinalizersPath,
      Buffer.from(new Date().toISOString(), "utf8"),
    );
    this.finalizer?.kill();
    this.finalizer = null;
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
  ): Promise<void> {
    await writeFileAtomic(
      this.cancelFinalizersPath,
      Buffer.from(new Date().toISOString(), "utf8"),
    );
    this.finalizer?.kill();
    this.finalizer = null;
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
    // Armed before the quit for the same reason as in `applyAndRestart`.
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

  private async waitForFinalizersToExit(): Promise<void> {
    const lockPath = join(this.paths.extensionStorage, "shutdown-finalizer.lock");
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30_000) {
      const lock = await acquireFileLock(lockPath);
      if (lock !== null) {
        await lock.release();
        return;
      }
      await delay(100);
    }
    throw new Error("Timed out replacing the shutdown finalizer.");
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
