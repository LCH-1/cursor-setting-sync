import { execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { acquireFileLockWithin } from "../platform/lock";
import { assertSafeRelativePathOnDisk, readFileBounded, writeJsonAtomic } from "../platform/files";

export const HELPER_RUNTIME_EXECUTABLE = "cursor-sync-helper-runtime.exe";
const RUNTIME_FILES = [HELPER_RUNTIME_EXECUTABLE, "icudtl.dat", "v8_context_snapshot.bin"] as const;
const execFileAsync = promisify(execFile);

interface RuntimeIdentity { node: string; electron: string; arch: string }
interface RuntimeProcess { pid: number; executablePath: string }
interface RuntimeManifest {
  version: 1;
  identity: RuntimeIdentity;
  files: Record<string, { bytes: number; sha256: string }>;
}

export interface HelperRuntimeOptions {
  platform?: NodeJS.Platform;
  executablePath?: string;
  identity?: RuntimeIdentity;
  probe?: (executablePath: string) => Promise<RuntimeIdentity>;
  processes?: () => Promise<RuntimeProcess[]>;
  isAlive?: (pid: number) => boolean;
}

export interface HelperRuntimeLease {
  executablePath: string;
  attach(child: ChildProcess): Promise<void>;
  release(): Promise<void>;
}

export async function prepareHelperRuntime(
  storageRoot: string,
  options: HelperRuntimeOptions = {},
): Promise<HelperRuntimeLease> {
  const executablePath = options.executablePath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || (options.identity === undefined && process.versions.electron === undefined && basename(executablePath).toLowerCase() !== "cursor.exe")) {
    return { executablePath, attach: async () => {}, release: async () => {} };
  }
  const identity = options.identity ?? { node: process.versions.node, electron: process.versions.electron ?? "", arch: process.arch };
  const key = runtimeKey(identity);
  await mkdir(storageRoot, { recursive: true });
  const cacheRoot = await assertSafeRelativePathOnDisk(storageRoot, "helper-runtime", { allowMissing: true, finalType: "directory" });
  await mkdir(cacheRoot, { recursive: true });
  const lock = await acquireFileLockWithin(join(cacheRoot, "prepare.lock"), 120_000);
  if (lock === null) throw new Error("Timed out preparing the independent shutdown-helper runtime.");
  const probe = options.probe ?? probeRuntime;
  const isAlive = options.isAlive ?? processAlive;
  let leasePath: string | null = null;
  let attached = false;
  let released = false;
  try {
    const folder = await assertSafeRelativePathOnDisk(cacheRoot, key, { allowMissing: true, finalType: "directory" });
    let processes: RuntimeProcess[] | null = null;
    try { processes = await (options.processes ?? runtimeProcesses)(); } catch { /* An unavailable process list forbids cache deletion. */ }
    if (!(await validRuntime(folder, identity))) {
      if (await exists(folder)) {
        if (processes === null || await runtimeInUse(folder, processes, isAlive)) {
          throw new Error("The cached shutdown-helper runtime failed verification and may still be in use; it was preserved.");
        }
        await removeCacheFolder(cacheRoot, key);
      }
      const stagingName = `.prepare-${process.pid}-${randomUUID()}`;
      const staging = join(cacheRoot, stagingName);
      await mkdir(staging);
      try {
        const files: RuntimeManifest["files"] = {};
        for (const name of RUNTIME_FILES) {
          const source = join(dirname(executablePath), name === HELPER_RUNTIME_EXECUTABLE ? basename(executablePath) : name);
          const sourceHash = await hashFile(source);
          await copyFile(source, join(staging, name));
          const copiedHash = await hashFile(join(staging, name));
          if (sourceHash.sha256 !== copiedHash.sha256 || sourceHash.bytes !== copiedHash.bytes || sourceHash.sha256 !== (await hashFile(source)).sha256) {
            throw new Error("Cursor runtime files changed during the independent-runtime copy; retry after the update completes.");
          }
          files[name] = copiedHash;
          lock.refresh();
        }
        if (runtimeKey(await probe(join(staging, HELPER_RUNTIME_EXECUTABLE))) !== key) {
          throw new Error("Cursor updated while preparing its shutdown-helper runtime; reload this window before retrying.");
        }
        await writeJsonAtomic(join(staging, "manifest.json"), { version: 1, identity, files } satisfies RuntimeManifest);
        await rename(staging, folder);
      } catch (error) {
        await removeCacheFolder(cacheRoot, stagingName).catch(() => {});
        throw error;
      }
    }
    await pruneDeadLeases(folder, isAlive);
    leasePath = join(folder, `lease-${randomUUID()}.json`);
    await writeJsonAtomic(leasePath, { pid: process.pid, phase: "preparing" });
    await cleanupRuntimes(cacheRoot, key, processes, isAlive);
    const pinnedLease = leasePath;
    return {
      executablePath: join(folder, HELPER_RUNTIME_EXECUTABLE),
      async attach(child) {
        if (child.pid === undefined) throw new Error("The independent shutdown helper did not start.");
        await writeJsonAtomic(pinnedLease, { pid: child.pid, phase: "running" });
        attached = true;
        child.once("exit", () => { void rm(pinnedLease, { force: true }).catch(() => {}); });
        if (child.exitCode !== null || child.signalCode !== null) await rm(pinnedLease, { force: true });
      },
      async release() {
        if (released) return;
        released = true;
        try { if (!attached) await rm(pinnedLease, { force: true }); } finally { await lock.release(); }
      },
    };
  } catch (error) {
    if (leasePath !== null) await rm(leasePath, { force: true }).catch(() => {});
    await lock.release();
    throw error;
  }
}

function runtimeKey(identity: RuntimeIdentity): string {
  if (!/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*$/.test(identity.node) || !/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*$/.test(identity.electron) || !/^(x64|arm64|ia32)$/.test(identity.arch)) {
    throw new Error("Cannot identify a supported independent Cursor helper runtime.");
  }
  return `node-${identity.node}-electron-${identity.electron}-${identity.arch}`;
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const value of createReadStream(path)) {
    const chunk = value as Buffer;
    bytes += chunk.length;
    if (bytes > 1024 * 1024 * 1024) throw new Error("A Cursor runtime file exceeded the 1 GiB verification limit.");
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function validRuntime(folder: string, identity: RuntimeIdentity): Promise<boolean> {
  try {
    if ((await readdir(folder)).some(name => !RUNTIME_FILES.includes(name as typeof RUNTIME_FILES[number]) && name !== "manifest.json" && !/^lease-[a-f0-9-]+\.json$/.test(name))) return false;
    const manifest = JSON.parse((await readFileBounded(await assertSafeRelativePathOnDisk(folder, "manifest.json", { finalType: "file" }), 16 * 1024)).toString("utf8")) as RuntimeManifest;
    if (manifest.version !== 1 || runtimeKey(manifest.identity) !== runtimeKey(identity) || Object.keys(manifest.files).length !== RUNTIME_FILES.length) return false;
    for (const name of RUNTIME_FILES) {
      const expected = manifest.files[name];
      if (expected === undefined || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) return false;
      const actual = await hashFile(await assertSafeRelativePathOnDisk(folder, name, { finalType: "file" }));
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) return false;
    }
    return true;
  } catch { return false; }
}

async function runtimeInUse(folder: string, processes: RuntimeProcess[], isAlive: (pid: number) => boolean): Promise<boolean> {
  if (processes.some(item => resolve(dirname(item.executablePath)).toLowerCase() === resolve(folder).toLowerCase())) return true;
  for (const name of await readdir(folder)) {
    if (!/^lease-[a-f0-9-]+\.json$/.test(name)) continue;
    try {
      const lease = JSON.parse((await readFileBounded(await assertSafeRelativePathOnDisk(folder, name, { finalType: "file" }), 4096)).toString("utf8")) as { pid: number; phase?: unknown };
      if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0 || (lease.phase !== "running" && lease.phase !== "preparing") || isAlive(lease.pid)) return true;
    } catch { return true; }
  }
  return false;
}

async function pruneDeadLeases(folder: string, isAlive: (pid: number) => boolean): Promise<void> {
  for (const name of await readdir(folder)) {
    if (!/^lease-[a-f0-9-]+\.json$/.test(name)) continue;
    try {
      const path = await assertSafeRelativePathOnDisk(folder, name, { finalType: "file" });
      const lease = JSON.parse((await readFileBounded(path, 4096)).toString("utf8")) as { pid?: unknown; phase?: unknown };
      if (typeof lease.pid !== "number" || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 || (lease.phase !== "running" && lease.phase !== "preparing") || isAlive(lease.pid)) continue;
      await rm(path, { force: true });
    } catch { /* Unreadable leases or unavailable process identity remain pinned. */ }
  }
}

async function cleanupRuntimes(root: string, current: string, processes: RuntimeProcess[] | null, isAlive: (pid: number) => boolean): Promise<void> {
  if (processes === null) return;
  const inactive: { name: string; modified: number }[] = [];
  for (const name of await readdir(root)) {
    if (name === current || !/^(?:node-[a-zA-Z0-9.-]+-(?:x64|arm64|ia32)|\.prepare-\d+-[a-f0-9-]+)$/.test(name)) continue;
    try {
      const folder = await assertSafeRelativePathOnDisk(root, name, { finalType: "directory" });
      await pruneDeadLeases(folder, isAlive);
      if (await runtimeInUse(folder, processes, isAlive)) continue;
      if (name.startsWith(".prepare-")) await removeCacheFolder(root, name);
      else inactive.push({ name, modified: (await stat(join(folder, "manifest.json"))).mtimeMs });
    } catch { /* Unknown or concurrently changed cache entries remain untouched. */ }
  }
  inactive.sort((a, b) => b.modified - a.modified);
  for (const candidate of inactive.slice(1)) await removeCacheFolder(root, candidate.name).catch(() => {});
}

async function removeCacheFolder(root: string, name: string): Promise<void> {
  const folder = await assertSafeRelativePathOnDisk(root, name, { finalType: "directory" });
  await rm(folder, { recursive: true, force: true });
}

async function probeRuntime(executable: string): Promise<RuntimeIdentity> {
  const code = "const s=require('node:sqlite'); if(typeof s.DatabaseSync!=='function'||typeof s.backup!=='function')throw Error('SQLite backup unavailable'); console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,arch:process.arch}));";
  const { stdout } = await execFileAsync(executable, ["--no-warnings", "--eval", code], { cwd: dirname(executable), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 });
  return JSON.parse(stdout.trim()) as RuntimeIdentity;
}

async function runtimeProcesses(): Promise<RuntimeProcess[]> {
  const command = `Get-CimInstance Win32_Process -Filter "Name='${HELPER_RUNTIME_EXECUTABLE}'" -ErrorAction Stop | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (stdout.trim() === "") return [];
  const raw: unknown = JSON.parse(stdout);
  const entries: unknown[] = Array.isArray(raw) ? raw as unknown[] : [raw];
  return entries.map(item => {
    if (item === null || typeof item !== "object") throw new Error("Cannot identify an active shutdown-helper runtime.");
    const record = item as Record<string, unknown>;
    if (!Number.isSafeInteger(record.ProcessId) || typeof record.ExecutablePath !== "string" || record.ExecutablePath.length === 0) throw new Error("Cannot identify an active shutdown-helper runtime.");
    return { pid: record.ProcessId as number, executablePath: record.ExecutablePath };
  });
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
