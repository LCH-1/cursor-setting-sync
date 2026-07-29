import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  commands: { executeCommand: () => Promise.resolve() },
  workspace: {
    saveAll: () => Promise.resolve(true),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
  window: {},
  extensions: { all: [] },
}));

import { HelperLauncher } from "../src/helper/launcher";
import type { CompatibilityReport } from "../src/types";
import type { CursorPaths } from "../src/platform/paths";
import type { HelperSyncOptions } from "../src/helper/launcher";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const syncOptions: HelperSyncOptions = {
  ignoredSettings: [],
  ignoredExtensions: [],
  machineScopedSettings: [],
  syncChat: true,
  syncWorkspaceStorage: false,
  maxPayloadBytes: 128 * 1024 * 1024,
  gitSync: false,
};

async function createLauncher(
  replaceWaitMs = 30_000,
): Promise<{ launcher: HelperLauncher; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "cursor-finalizer-replace-"));
  temporaryRoots.push(root);
  const helperScript = join(root, "helper-stub.cjs");
  await writeFile(
    helperScript,
    "process.stdin.on('data', () => {});\nprocess.stdin.on('end', () => process.exit(0));\n",
    "utf8",
  );
  const paths = { extensionStorage: root, helperScript } as unknown as CursorPaths;
  const compatibility = {
    cursorVersion: "3.11.19",
    vscodeVersion: "1.125.0",
    extensionVersion: "0.0.32",
  } as unknown as CompatibilityReport;
  return {
    launcher: new HelperLauncher(paths, compatibility, replaceWaitMs),
    root,
  };
}

function lockFile(root: string): string {
  return join(root, "shutdown-finalizer.lock");
}

async function writeLock(
  root: string,
  pid: number,
  createdAt: string,
): Promise<void> {
  await writeFile(
    lockFile(root),
    JSON.stringify({ pid, token: "test-token", createdAt }),
    "utf8",
  );
}

async function requestFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter(
    (name) => name.startsWith("helper-request-") && name.endsWith(".json"),
  );
}

/** A pid that verifiably belonged to a process that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

describe("replacing the shutdown finalizer", () => {
  it("adopts a finalizer another window installed after this window's cancel", async () => {
    const { launcher, root } = await createLauncher();
    // createdAt in the near future is unambiguously later than the cancel
    // marker this call writes - the seven-windows-restoring race, condensed.
    await writeLock(root, process.pid, new Date(Date.now() + 5_000).toISOString());

    const outcome = await launcher.restartFinalizer(
      "C:/nonexistent-repository",
      Buffer.alloc(32, 1),
      {},
      syncOptions,
    );

    expect(outcome).toBe("adopted");
    // Adoption spawns nothing: the other window's finalizer is the finalizer.
    expect(await requestFiles(root)).toEqual([]);
    launcher.dispose();
  });

  it("breaks a crashed finalizer's lock and arms its own", async () => {
    const { launcher, root } = await createLauncher();
    // A live-looking lock whose pid is provably dead - what last night's
    // hard-crashed helper left behind, with a fresh mtime the 15-minute TTL
    // would not clear inside the 30-second wait.
    await writeLock(root, await deadPid(), new Date().toISOString());

    const outcome = await launcher.restartFinalizer(
      "C:/nonexistent-repository",
      Buffer.alloc(32, 1),
      {},
      syncOptions,
    );

    expect(outcome).toBe("armed");
    expect(await requestFiles(root)).toHaveLength(1);
    launcher.dispose();
  });

  it("does not adopt a holder that releases within the confirmation window", async () => {
    // The doomed finalizer: its lock postdates the cancel, but only because
    // its boot spanned the marker write - it reads the marker milliseconds
    // after acquiring and self-cancels. Adopt-on-first-sight would return
    // "adopted" here and leave the session with NO exporter at all; the
    // 1-second survival requirement must see the release and arm instead.
    const { launcher, root } = await createLauncher();
    await writeLock(root, process.pid, new Date(Date.now() + 5_000).toISOString());
    setTimeout(() => {
      void rm(lockFile(root), { force: true });
    }, 300);

    const outcome = await launcher.restartFinalizer(
      "C:/nonexistent-repository",
      Buffer.alloc(32, 1),
      {},
      syncOptions,
    );

    expect(outcome).toBe("armed");
    expect(await requestFiles(root)).toHaveLength(1);
    launcher.dispose();
  });

  it("writes a backward-parseable cancel marker with the owner in a sidecar", async () => {
    // A 0.0.32 finalizer parses the marker with Date.parse(content.trim());
    // the two-line format read as NaN there, so it NEVER stood down and the
    // session retried "stalled" every minute forever. The marker bytes must
    // stay a bare ISO timestamp for as long as old finalizers can be running.
    const { launcher, root } = await createLauncher(300);
    await writeLock(root, process.pid, new Date(Date.now() - 60_000).toISOString());
    await launcher.restartFinalizer(
      "C:/nonexistent-repository",
      Buffer.alloc(32, 1),
      {},
      syncOptions,
    );

    const marker = (await readFile(join(root, "cancel-finalizers"), "utf8")).trim();
    expect(Number.isFinite(Date.parse(marker))).toBe(true);
    const owner = JSON.parse(
      await readFile(join(root, "cancel-finalizers-owner"), "utf8"),
    ) as { pid?: number; kind?: string };
    expect(owner.pid).toBe(process.pid);
    expect(owner.kind).toBe("restart");
    launcher.dispose();
  });

  it("reports a live but unresponsive older finalizer as stalled instead of throwing", async () => {
    const { launcher, root } = await createLauncher(600);
    // Alive (this test's own pid), created BEFORE the cancel marker, and never
    // exiting: a finalizer mid-export, which does not poll its cancel marker.
    await writeLock(root, process.pid, new Date(Date.now() - 60_000).toISOString());

    const outcome = await launcher.restartFinalizer(
      "C:/nonexistent-repository",
      Buffer.alloc(32, 1),
      {},
      syncOptions,
    );

    expect(outcome).toBe("stalled");
    expect(await requestFiles(root)).toEqual([]);
    // The standing lock is untouched: the holder is alive and will release it.
    const holder = JSON.parse(await readFile(lockFile(root), "utf8")) as {
      pid?: number;
    };
    expect(holder.pid).toBe(process.pid);
    launcher.dispose();
  });
});
