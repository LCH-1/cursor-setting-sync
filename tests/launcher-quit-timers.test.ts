import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The quit command must hang: the shipped bug this file pins is a
// workbench.action.quit whose promise never settles, which left both safety
// timers unarmed because they were armed after the await.
vi.mock("vscode", () => ({
  commands: {
    executeCommand: (command: string): Promise<void> => {
      if (command === "workbench.action.quit") {
        quitRequested?.();
        return new Promise<void>(() => {});
      }
      return Promise.resolve();
    },
  },
  workspace: {
    saveAll: () => Promise.resolve(true),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
  window: {},
  extensions: { all: [] },
}));

let quitRequested: (() => void) | null = null;

import { HelperLauncher, QUIT_VETO_CHECK_DELAY_MS } from "../src/helper/launcher";
import { QUIT_START_GRACE_MS } from "../src/constants";
import type { CompatibilityReport } from "../src/types";
import type { CursorPaths } from "../src/platform/paths";
import type { HelperSyncOptions } from "../src/helper/launcher";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  quitRequested = null;
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createLauncher(): Promise<{
  launcher: HelperLauncher;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-launcher-timers-"));
  temporaryRoots.push(root);
  const helperScript = join(root, "helper-stub.cjs");
  // Consumes the key from stdin, then exits; enough for launch() to succeed.
  await writeFile(
    helperScript,
    "process.stdin.on('data', () => {});\nprocess.stdin.on('end', () => process.exit(0));\n",
    "utf8",
  );
  const paths = {
    extensionStorage: root,
    helperScript,
  } as unknown as CursorPaths;
  const compatibility = {
    cursorVersion: "3.11.19",
    vscodeVersion: "1.125.0",
    extensionVersion: "0.0.30",
  } as unknown as CompatibilityReport;
  return { launcher: new HelperLauncher(paths, compatibility), root };
}

const syncOptions: HelperSyncOptions = {
  ignoredSettings: [],
  ignoredExtensions: [],
  machineScopedSettings: [],
  syncChat: true,
  syncWorkspaceStorage: false,
  maxPayloadBytes: 128 * 1024 * 1024,
  gitSync: false,
};

async function expectTimersArmedBeforeQuitSettles(
  start: (
    launcher: HelperLauncher,
    onQuitVetoed: () => Promise<void>,
    onQuitStalled: () => void,
  ) => Promise<void>,
): Promise<void> {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { launcher } = await createLauncher();
  const stalled = vi.fn();
  const vetoed = vi.fn();
  const quitCalled = new Promise<void>((resolve) => {
    quitRequested = resolve;
  });

  // Never resolves - the quit promise hangs by construction, which is exactly
  // the run these timers exist for.
  void start(launcher, async () => {
    vetoed();
  }, stalled);
  await quitCalled;

  // The quit has been issued and its promise will never settle. Everything
  // after this point only happens if both timers were armed BEFORE the await.
  expect(stalled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(QUIT_START_GRACE_MS + 1_000);
  expect(stalled).toHaveBeenCalledTimes(1);

  expect(vetoed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(QUIT_VETO_CHECK_DELAY_MS);
  expect(vetoed).toHaveBeenCalledTimes(1);

  launcher.dispose();
}

describe("the quit safety timers", () => {
  it("applyAndRestart arms the stall and veto checks before awaiting the quit", async () => {
    await expectTimersArmedBeforeQuitSettles((launcher, onVetoed, onStalled) =>
      launcher.applyAndRestart(
        "C:/nonexistent-repository",
        Buffer.alloc(32, 1),
        [],
        {},
        syncOptions,
        onVetoed,
        onStalled,
      ),
    );
  }, 30_000);

  it("restoreAndRestart arms the stall and veto checks before awaiting the quit", async () => {
    await expectTimersArmedBeforeQuitSettles((launcher, onVetoed, onStalled) =>
      launcher.restoreAndRestart(
        "C:/nonexistent-repository",
        Buffer.alloc(32, 1),
        "C:/nonexistent-backup.vscdb",
        syncOptions,
        undefined,
        onVetoed,
        onStalled,
      ),
    );
  }, 30_000);
});
