import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import * as vscode from "vscode";
import {
  HELPER_REQUEST_VERSION,
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
const QUIT_VETO_CHECK_DELAY_MS = 210_000;

export class HelperLauncher {
  private finalizer: ChildProcess | null = null;
  private quitVetoTimer: NodeJS.Timeout | null = null;
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
    await vscode.commands.executeCommand("workbench.action.files.saveAll");
    await vscode.commands.executeCommand("workbench.action.quit");
    this.scheduleQuitVetoCheck(onQuitVetoed);
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
    await vscode.commands.executeCommand("workbench.action.files.saveAll");
    await vscode.commands.executeCommand("workbench.action.quit");
    this.scheduleQuitVetoCheck(onQuitVetoed);
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

  dispose(): void {
    if (this.quitVetoTimer !== null) {
      clearTimeout(this.quitVetoTimer);
      this.quitVetoTimer = null;
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
    const child = spawn(process.execPath, [this.paths.helperScript, requestPath], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: environment,
    });
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
