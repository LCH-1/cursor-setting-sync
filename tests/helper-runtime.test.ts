import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELPER_RUNTIME_EXECUTABLE, prepareHelperRuntime, type HelperRuntimeOptions } from "../src/helper/runtime";
import * as runtime from "../src/helper/runtime";
import { HelperLauncher, type HelperSyncOptions } from "../src/helper/launcher";
import type { CursorPaths } from "../src/platform/paths";
import type { CompatibilityReport } from "../src/types";

vi.mock("vscode", () => ({ commands: { executeCommand: async () => {} }, workspace: { saveAll: async () => true }, window: {}, extensions: { all: [] } }));

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cursor-helper-runtime-"));
  roots.push(root);
  const source = join(root, "installed");
  const storage = join(root, "local-storage");
  await mkdir(source);
  await writeFile(join(source, "Cursor.exe"), "trusted runtime executable");
  await writeFile(join(source, "icudtl.dat"), "trusted ICU data");
  await writeFile(join(source, "v8_context_snapshot.bin"), "trusted V8 snapshot");
  const identity = { node: "24.18.1", electron: "42.10.0", arch: "x64" };
  const probe = vi.fn(async (_executablePath: string) => identity);
  const options: HelperRuntimeOptions = { platform: "win32", executablePath: join(source, "Cursor.exe"), identity, probe, processes: async () => [], isAlive: () => false };
  return { root, source, storage, identity, probe, options };
}

function child(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }) as ChildProcess;
}

async function cacheFolders(storage: string): Promise<string[]> {
  return (await readdir(join(storage, "helper-runtime"))).filter(name => name.startsWith("node-"));
}

describe("independent Windows shutdown-helper runtime", () => {
  it("copies only the three required runtime files and verifies its own executable", async () => {
    const f = await fixture();
    const lease = await prepareHelperRuntime(f.storage, f.options);
    expect(basename(lease.executablePath)).toBe(HELPER_RUNTIME_EXECUTABLE);
    expect(lease.executablePath.startsWith(f.storage)).toBe(true);
    expect(await readFile(lease.executablePath, "utf8")).toBe("trusted runtime executable");
    const manifest = JSON.parse(await readFile(join(dirname(lease.executablePath), "manifest.json"), "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(manifest.files).sort()).toEqual([HELPER_RUNTIME_EXECUTABLE, "icudtl.dat", "v8_context_snapshot.bin"].sort());
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.probe.mock.calls[0]?.[0]).not.toBe(f.options.executablePath);
    await lease.release();
  });

  it("keeps a pinned runtime intact after installation replacement and reuses the same Node/Electron cache", async () => {
    const f = await fixture();
    f.options.isAlive = pid => pid === 31001;
    const first = await prepareHelperRuntime(f.storage, f.options);
    await first.attach(child(31001));
    await first.release();
    await rm(f.source, { recursive: true });
    await mkdir(f.source);
    await writeFile(join(f.source, "Cursor.exe"), "new Cursor patch with another installation");
    const next = await prepareHelperRuntime(f.storage, f.options);
    expect(next.executablePath).toBe(first.executablePath);
    expect(await readFile(next.executablePath, "utf8")).toBe("trusted runtime executable");
    expect(await readFile(join(dirname(next.executablePath), "icudtl.dat"), "utf8")).toBe("trusted ICU data");
    expect(await readFile(join(dirname(next.executablePath), "v8_context_snapshot.bin"), "utf8")).toBe("trusted V8 snapshot");
    expect(f.probe).toHaveBeenCalledTimes(1);
    await next.release();
  });

  it("repairs a corrupted inactive cache instead of executing altered bytes", async () => {
    const f = await fixture();
    const first = await prepareHelperRuntime(f.storage, f.options);
    await first.release();
    await writeFile(first.executablePath, "tampered");
    const repaired = await prepareHelperRuntime(f.storage, f.options);
    expect(await readFile(repaired.executablePath, "utf8")).toBe("trusted runtime executable");
    expect(f.probe).toHaveBeenCalledTimes(2);
    await repaired.release();
  });

  it("rejects a damaged runtime that still has an active helper lease", async () => {
    const f = await fixture();
    f.options.isAlive = pid => pid === 31002;
    const first = await prepareHelperRuntime(f.storage, f.options);
    await first.attach(child(31002));
    await first.release();
    await writeFile(first.executablePath, "damaged while in use");
    await expect(prepareHelperRuntime(f.storage, f.options)).rejects.toThrow("may still be in use");
    expect(await readFile(first.executablePath, "utf8")).toBe("damaged while in use");
  });

  it("rebuilds an incomplete cache whose snapshot is missing", async () => {
    const f = await fixture();
    const first = await prepareHelperRuntime(f.storage, f.options);
    await first.release();
    await rm(join(dirname(first.executablePath), "v8_context_snapshot.bin"));
    const repaired = await prepareHelperRuntime(f.storage, f.options);
    expect(await readFile(join(dirname(repaired.executablePath), "v8_context_snapshot.bin"), "utf8")).toBe("trusted V8 snapshot");
    await repaired.release();
  });

  it("does not publish a partial cache or fall back when an installed runtime file is missing", async () => {
    const f = await fixture();
    await rm(join(f.source, "icudtl.dat"));
    await expect(prepareHelperRuntime(f.storage, f.options)).rejects.toThrow();
    expect(await readdir(join(f.storage, "helper-runtime"))).toEqual([]);
  });

  it("refuses a copy whose running runtime identity differs from the extension host", async () => {
    const f = await fixture();
    f.options.probe = async () => ({ ...f.identity, node: "24.19.0" });
    await expect(prepareHelperRuntime(f.storage, f.options)).rejects.toThrow("reload this window");
    expect(await readdir(join(f.storage, "helper-runtime"))).toEqual([]);
  });

  it.each([5, 10])("serializes %i window preparations and publishes only one verified copy", async windows => {
    const f = await fixture();
    const paths = await Promise.all(Array.from({ length: windows }, async () => {
      const lease = await prepareHelperRuntime(f.storage, f.options);
      try { return lease.executablePath; } finally { await lease.release(); }
    }));
    expect(new Set(paths).size).toBe(1);
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(await cacheFolders(f.storage)).toHaveLength(1);
  });

  it("retains active leases while pruning unneeded runtime generations", async () => {
    const f = await fixture();
    f.options.isAlive = pid => pid === 31003;
    const active = await prepareHelperRuntime(f.storage, f.options);
    await active.attach(child(31003));
    await active.release();
    for (const node of ["24.19.0", "24.20.0", "24.21.0"]) {
      const identity = { ...f.identity, node };
      const lease = await prepareHelperRuntime(f.storage, { ...f.options, identity, probe: async () => identity });
      await lease.release();
    }
    expect(await cacheFolders(f.storage)).toHaveLength(3);
    expect(await readFile(active.executablePath, "utf8")).toBe("trusted runtime executable");
  });

  it("removes accumulated dead leases from the current runtime while retaining live and unknown owners", async () => {
    const f = await fixture();
    const first = await prepareHelperRuntime(f.storage, f.options);
    await first.release();
    const folder = dirname(first.executablePath);
    for (let index = 1; index <= 40; index += 1) {
      await writeFile(join(folder, `lease-${index.toString(16)}.json`), JSON.stringify({ pid: 32000 + index, phase: "running" }));
    }
    await writeFile(join(folder, "lease-a1a1.json"), JSON.stringify({ pid: 33001, phase: "preparing" }));
    await writeFile(join(folder, "lease-b1b1.json"), "incomplete lease");
    await writeFile(join(folder, "lease-c1c1.json"), JSON.stringify({ pid: "unknown", phase: "running" }));
    f.options.isAlive = pid => pid === 33001;
    const current = await prepareHelperRuntime(f.storage, f.options);
    await current.release();
    expect((await readdir(folder)).filter(name => name.startsWith("lease-")).sort()).toEqual(["lease-a1a1.json", "lease-b1b1.json", "lease-c1c1.json"]);
    expect(f.probe).toHaveBeenCalledTimes(1);
  });

  it("cleans dead leases in a retained prior cache even when another lease keeps that runtime active", async () => {
    const f = await fixture();
    const first = await prepareHelperRuntime(f.storage, f.options);
    await first.release();
    const folder = dirname(first.executablePath);
    await writeFile(join(folder, "lease-a1a1.json"), JSON.stringify({ pid: 34001, phase: "running" }));
    await writeFile(join(folder, "lease-b1b1.json"), JSON.stringify({ pid: 34002, phase: "running" }));
    await writeFile(join(folder, "lease-c1c1.json"), JSON.stringify({ pid: 34003, phase: "unknown" }));
    const identity = { ...f.identity, node: "24.19.0" };
    const next = await prepareHelperRuntime(f.storage, { ...f.options, identity, probe: async () => identity, isAlive: pid => pid === 34002 });
    await next.release();
    expect((await readdir(folder)).filter(name => name.startsWith("lease-")).sort()).toEqual(["lease-b1b1.json", "lease-c1c1.json"]);
  });

  it("preserves a running executable even when its launcher died before recording the child lease", async () => {
    const f = await fixture();
    const active = await prepareHelperRuntime(f.storage, f.options);
    await active.release();
    f.options.processes = async () => [{ pid: 31004, executablePath: active.executablePath }];
    for (const node of ["24.19.0", "24.20.0", "24.21.0"]) {
      const identity = { ...f.identity, node };
      const lease = await prepareHelperRuntime(f.storage, { ...f.options, identity, probe: async () => identity });
      await lease.release();
    }
    expect(await cacheFolders(f.storage)).toHaveLength(3);
    expect(await readFile(active.executablePath, "utf8")).toBe("trusted runtime executable");
  });

  it("skips cleanup entirely if operating-system process inspection fails", async () => {
    const f = await fixture();
    f.options.processes = async () => { throw new Error("process query unavailable"); };
    for (const node of ["24.18.1", "24.19.0", "24.20.0"]) {
      const identity = { ...f.identity, node };
      const lease = await prepareHelperRuntime(f.storage, { ...f.options, identity, probe: async () => identity });
      await lease.release();
    }
    expect(await cacheFolders(f.storage)).toHaveLength(3);
  });

  it("rejects invalid runtime identifiers before creating any cache", async () => {
    const f = await fixture();
    await expect(prepareHelperRuntime(f.storage, { ...f.options, identity: { ...f.identity, node: "../../outside" } })).rejects.toThrow("Cannot identify");
    await expect(readdir(f.storage)).rejects.toThrow();
  });

  it("leaves non-Windows launchers on their existing executable", async () => {
    const f = await fixture();
    const lease = await prepareHelperRuntime(f.storage, { ...f.options, platform: "linux" });
    expect(lease.executablePath).toBe(f.options.executablePath);
    expect(f.probe).not.toHaveBeenCalled();
    await lease.release();
  });

  it.each(["lease", "key-pipe"])("terminates the spawned child if %s setup fails before it is armed", async failure => {
    const f = await fixture();
    await mkdir(f.storage);
    const helperScript = join(f.root, "waiting-helper.cjs");
    await writeFile(helperScript, "process.stdin.resume(); setInterval(() => {}, 1000);");
    let spawned: ChildProcess | null = null;
    let exited: Promise<void> = Promise.resolve();
    const release = vi.fn(async () => {});
    vi.spyOn(runtime, "prepareHelperRuntime").mockResolvedValueOnce({
      executablePath: process.execPath,
      attach: async value => {
        spawned = value;
        exited = new Promise(resolve => value.once("close", () => resolve()));
        if (failure === "lease") throw new Error("lease setup failed");
        if (value.stdin !== null) vi.spyOn(value.stdin, "end").mockImplementation(() => { throw new Error("key-pipe setup failed"); });
      },
      release,
    });
    const launcher = new HelperLauncher(
      { extensionStorage: f.storage, helperScript } as CursorPaths,
      { cursorVersion: "3.20.10", vscodeVersion: "1.125.0", extensionVersion: "1.0.8" } as CompatibilityReport,
    );
    const syncOptions: HelperSyncOptions = { ignoredSettings: [], ignoredExtensions: [], machineScopedSettings: [], syncChat: true, syncWorkspaceStorage: false, maxPayloadBytes: 1024, gitSync: false };
    await expect(launcher.startFinalizer(f.root, Buffer.alloc(32), {}, syncOptions)).rejects.toThrow(`${failure} setup failed`);
    await exited;
    expect((spawned as ChildProcess | null)?.killed).toBe(true);
    expect((spawned as ChildProcess | null)?.stdin?.destroyed).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    launcher.dispose();
  });

  it("closes the stderr descriptor and runtime lease when spawn throws synchronously", async () => {
    const f = await fixture();
    await mkdir(f.storage);
    const helperScript = join(f.root, "helper.cjs");
    await writeFile(helperScript, "process.stdin.resume();");
    const attach = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    vi.spyOn(runtime, "prepareHelperRuntime").mockResolvedValueOnce({ executablePath: process.execPath, attach, release });
    const spawnProcess = vi.fn<typeof spawn>(() => { throw new Error("synchronous spawn failure"); });
    const launcher = new HelperLauncher(
      { extensionStorage: f.storage, helperScript } as CursorPaths,
      { cursorVersion: "3.20.10", vscodeVersion: "1.125.0", extensionVersion: "1.0.8" } as CompatibilityReport,
      30_000,
      spawnProcess,
    );
    const syncOptions: HelperSyncOptions = { ignoredSettings: [], ignoredExtensions: [], machineScopedSettings: [], syncChat: true, syncWorkspaceStorage: false, maxPayloadBytes: 1024, gitSync: false };
    await expect(launcher.startFinalizer(f.root, Buffer.alloc(32), {}, syncOptions)).rejects.toThrow("synchronous spawn failure");
    const stdio = spawnProcess.mock.calls[0]?.[2]?.stdio as unknown as [string, string, number];
    expect(() => fstatSync(stdio[2])).toThrow(/EBADF/);
    expect(attach).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    launcher.dispose();
  });
});
