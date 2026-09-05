import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, unlink, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import type { CursorPaths } from "../platform/paths";
import { isMissingPathError, writeJsonAtomic } from "../platform/files";
import type { DatabaseContract } from "./database";
import type { HelperBackup } from "./types";
import { BACKUP_DIRECTORY } from "../constants";

const MAX_BACKUP_BYTES = 64 * 1024 ** 3;
const SIDECARS = ["-wal", "-shm", "-journal"];
interface ArchiveMetadata extends HelperBackup {
  version: 1;
  sourceBytes: number;
  sourceSha256: string;
  sourceMtimeMs: number;
}

async function fileInfo(path: string): Promise<Stats | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Backup is not a regular file: ${path}`);
    return info;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function sameFile(left: Stats, right: Stats | null): boolean {
  return right !== null && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function resolveBackupSource(path: string): Promise<string | null> {
  if (await fileInfo(path)) return path;
  if (!path.endsWith(".gz") && await fileInfo(`${path}.gz`)) return `${path}.gz`;
  return null;
}

async function readArchiveMetadata(path: string): Promise<ArchiveMetadata> {
  const info = await fileInfo(`${path}.json`);
  if (info === null || info.size > 16 * 1024) throw new Error(`Compressed backup metadata is missing or oversized: ${path}`);
  const metadata = JSON.parse(await readFile(`${path}.json`, "utf8")) as ArchiveMetadata;
  if (metadata.version !== 1 || !Number.isSafeInteger(metadata.sourceBytes) ||
    metadata.sourceBytes < 1 || metadata.sourceBytes > MAX_BACKUP_BYTES ||
    !/^[a-f0-9]{64}$/.test(metadata.sourceSha256) ||
    !Number.isFinite(metadata.sourceMtimeMs) || typeof metadata.targetPath !== "string" ||
    !["global", "workspace", "store", "item-table"].includes(metadata.contract)) {
    throw new Error(`Invalid compressed backup metadata: ${path}`);
  }
  return metadata;
}

function digestMeter(maxBytes: number) {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(new Error("Backup exceeds its bounded uncompressed size"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, finish: () => ({ bytes, hash: hash.digest("hex") }) };
}

async function inflateArchive(path: string, metadata: ArchiveMetadata, destination?: string): Promise<void> {
  const identity = await fileInfo(path);
  if (identity === null) throw new Error(`Compressed backup disappeared: ${path}`);
  if (identity.size > metadata.sourceBytes * 1.01 + 1024 * 1024) throw new Error("Compressed backup exceeds its bounded input size");
  const meter = digestMeter(metadata.sourceBytes);
  const output = destination === undefined
    ? new Writable({ write(_chunk, _encoding, callback) { callback(); } })
    : createWriteStream(destination, { flags: "wx", mode: 0o600 });
  await pipeline(createReadStream(path), createGunzip(), meter.stream, output);
  const digest = meter.finish();
  if (digest.bytes !== metadata.sourceBytes || digest.hash !== metadata.sourceSha256 ||
    !sameFile(identity, await fileInfo(path))) throw new Error(`Compressed backup failed round-trip verification: ${path}`);
}

/** Old journals keep their original .vscdb paths; resolve the verified archive transparently. */
export async function withReadableBackup<T>(path: string, operation: (source: string) => Promise<T>): Promise<T> {
  const source = await resolveBackupSource(path);
  if (source === null) throw new Error(`Backup does not exist: ${path}`);
  if (!source.endsWith(".gz")) return operation(source);
  const metadata = await readArchiveMetadata(source);
  const parent = await realpath(dirname(source));
  const tempRoot = await mkdtemp(join(parent, ".restore-"));
  const extracted = join(tempRoot, "source.vscdb");
  try {
    await inflateArchive(source, metadata, extracted);
    return await operation(extracted);
  } finally {
    // Only remove names created for this extraction, never an arbitrary tree.
    for (const suffix of ["", ...SIDECARS]) await rm(`${extracted}${suffix}`, { force: true });
    await rmdir(tempRoot);
  }
}

interface Candidate {
  backup: HelperBackup;
  path: string;
  identity: Stats;
  mtimeMs: number;
}

export interface CompressedBackupMaintenanceOptions {
  storageRoot: string;
  paths: Pick<CursorPaths, "globalDatabase" | "workspaceStorageRoot" | "profilesRoot">;
  backups: readonly HelperBackup[];
  validate(path: string, contract: DatabaseContract): void;
  beforeWork(): Promise<void>;
  heartbeat(): void;
}

function targetKey(backup: HelperBackup): string {
  const path = resolve(backup.targetPath);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function inferBackup(path: string, paths: CompressedBackupMaintenanceOptions["paths"]): HelperBackup | null {
  const name = basename(path);
  if (/^state-.+\.vscdb$/.test(name)) return { backupPath: path, targetPath: paths.globalDatabase, contract: "global" };
  const workspace = /^workspace-([a-f0-9]{32})-.+\.vscdb$/.exec(name);
  if (workspace) return { backupPath: path, targetPath: join(paths.workspaceStorageRoot, workspace[1]!, "state.vscdb"), contract: "workspace" };
  const profile = /^extensions-(default|[a-zA-Z0-9_-]+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.vscdb$/.exec(name);
  if (profile) return { backupPath: path, targetPath: profile[1] === "default" ? paths.globalDatabase : join(paths.profilesRoot, profile[1]!, "globalStorage", "state.vscdb"), contract: "item-table" };
  return null;
}

async function assertNoLiveSidecars(path: string): Promise<void> {
  for (const suffix of ["-wal", "-journal"]) {
    const info = await fileInfo(`${path}${suffix}`);
    if (info !== null && info.size > 0) throw new Error(`Backup has an unsealed SQLite sidecar: ${path}${suffix}`);
  }
}

async function createArchive(candidate: Candidate, options: CompressedBackupMaintenanceOptions): Promise<string> {
  const source = candidate.path;
  if (candidate.identity.size > MAX_BACKUP_BYTES) throw new Error("Backup exceeds the supported archive size");
  await assertNoLiveSidecars(source);
  options.heartbeat();
  options.validate(source, candidate.backup.contract);
  options.heartbeat();
  await assertNoLiveSidecars(source);
  if (!sameFile(candidate.identity, await fileInfo(source))) throw new Error(`Backup changed before compression: ${source}`);
  const archive = `${source}.gz`;
  const existingArchive = await fileInfo(archive);
  const temporary = `${archive}.${randomUUID()}.partial`;
  try {
    const meter = digestMeter(Math.min(candidate.identity.size, MAX_BACKUP_BYTES));
    if (existingArchive === null) {
      await pipeline(createReadStream(source), meter.stream, createGzip({ level: 6 }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    } else {
      // Recover a crash between publishing the archive and its metadata only
      // when the existing archive proves identical to the still-present source.
      await pipeline(createReadStream(source), meter.stream, new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    }
    const digest = meter.finish();
    const metadata: ArchiveMetadata = {
      ...candidate.backup, backupPath: archive, version: 1,
      sourceBytes: digest.bytes, sourceSha256: digest.hash, sourceMtimeMs: candidate.mtimeMs,
    };
    await inflateArchive(existingArchive === null ? temporary : archive, metadata);
    if (!sameFile(candidate.identity, await fileInfo(source))) throw new Error(`Backup changed during compression: ${source}`);
    await options.beforeWork();
    if (existingArchive === null) await link(temporary, archive);
    await writeJsonAtomic(`${archive}.json`, metadata);
    await utimes(archive, new Date(), new Date(candidate.mtimeMs));
    return archive;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeAbandonedScratch(root: string, beforeWork: () => Promise<void>): Promise<number> {
  let deletedBytes = 0;
  for (const name of await readdir(root)) {
    const partial = /^(.+\.(?:vscdb|db))\.gz\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.partial$/.exec(name);
    const path = join(root, name);
    if (partial !== null) {
      // A partial is disposable only while its original source still exists.
      if (await fileInfo(join(root, partial[1]!)) === null) continue;
      const identity = await fileInfo(path);
      if (identity === null) continue;
      await beforeWork();
      if (!sameFile(identity, await fileInfo(path))) throw new Error("Backup scratch changed before cleanup");
      await unlink(path);
      deletedBytes += identity.size;
    } else if (/^\.restore-[a-zA-Z0-9]{6}$/.test(name)) {
      const identity = await lstat(path);
      if (identity.isSymbolicLink() || !identity.isDirectory() || await realpath(path) !== join(await realpath(root), name)) continue;
      const names = await readdir(path);
      if (names.some(child => !/^source\.vscdb(?:-wal|-shm|-journal)?$/.test(child))) continue;
      const files = await Promise.all(names.map(async child => ({ path: join(path, child), identity: await fileInfo(join(path, child)) })));
      for (const file of files) {
        if (file.identity === null) continue;
        await beforeWork();
        const current = await lstat(path);
        if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino ||
          !sameFile(file.identity, await fileInfo(file.path))) throw new Error("Restore scratch changed before cleanup");
        await unlink(file.path);
        deletedBytes += file.identity.size;
      }
      await beforeWork();
      const current = await lstat(path);
      if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Restore scratch directory changed before cleanup");
      await rmdir(path);
    }
  }
  return deletedBytes;
}

/** Called under the helper lock, after DB work has completed; never removes a live DB. */
export async function maintainCompressedBackups(options: CompressedBackupMaintenanceOptions): Promise<{
  backups: HelperBackup[]; replacements: Map<string, string>; deletedBytes: number; warnings: string[];
}> {
  const result = { backups: [] as HelperBackup[], replacements: new Map<string, string>(), deletedBytes: 0, warnings: [] as string[] };
  const root = resolve(options.storageRoot, BACKUP_DIRECTORY);
  await mkdir(root, { recursive: true });
  const canonicalParent = await realpath(options.storageRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(root) !== join(canonicalParent, BACKUP_DIRECTORY)) {
    throw new Error("Refusing compressed backup maintenance outside the exact backup directory");
  }
  const assertRoot = async () => {
    const info = await lstat(root);
    if (info.isSymbolicLink() || info.dev !== rootInfo.dev || info.ino !== rootInfo.ino ||
      await realpath(root) !== join(canonicalParent, BACKUP_DIRECTORY)) throw new Error("Backup directory changed during maintenance");
  };
  const protectedPaths = new Set<string>();
  for (const name of await readdir(options.storageRoot)) {
    if (!/^restore-.+\.json$/.test(name)) continue;
    const journal = JSON.parse(await readFile(join(options.storageRoot, name), "utf8")) as { completedAt: string | null; backupPath: string };
    if (journal.completedAt === null && typeof journal.backupPath === "string") {
      protectedPaths.add(resolve(journal.backupPath).replace(/\.gz$/, ""));
    }
  }
  // No restore callback is active here: journal replay and request execution
  // have already finished under the same helper lock.
  result.deletedBytes += await removeAbandonedScratch(root, async () => {
    await options.beforeWork();
    await assertRoot();
  });
  const known = new Map(options.backups.map(backup => [resolve(backup.backupPath), backup]));
  const groups = new Map<string, Candidate[]>();
  for (const name of await readdir(root)) {
    if (!/\.(vscdb|db)(\.gz)?$/.test(name)) continue;
    const path = join(root, name);
    try {
      const identity = await fileInfo(path);
      if (identity === null) continue;
      const metadata = name.endsWith(".gz") ? await readArchiveMetadata(path) : null;
      const backup = metadata ?? known.get(path) ?? inferBackup(path, options.paths);
      if (backup === null || backup === undefined) continue;
      const key = targetKey(backup);
      const group = groups.get(key) ?? [];
      const observedTime = metadata?.sourceMtimeMs ?? identity.mtimeMs;
      group.push({ path, identity, backup, mtimeMs: observedTime > Date.now() + 60_000 ? 0 : observedTime });
      groups.set(key, group);
    } catch (error) {
      // An unidentifiable backup must never be deleted because another file exists.
      result.warnings.push(`Preserved backup ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const candidates of groups.values()) {
    await options.beforeWork();
    await assertRoot();
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || Number(b.path.endsWith(".gz")) - Number(a.path.endsWith(".gz")));
    const newest = candidates[0]!;
    // Enablement backups copy the whole DB but originally restore only ItemTable.
    // Consolidation must not discard the older snapshot's chat restore contract.
    const broaderContract = candidates.find(candidate => candidate.backup.contract !== "item-table")?.backup.contract;
    const promoteContract = newest.backup.contract === "item-table" && broaderContract !== undefined;
    if (promoteContract) newest.backup = { ...newest.backup, contract: broaderContract };
    if (candidates.some(c => protectedPaths.has(resolve(c.path).replace(/\.gz$/, "")))) {
      result.warnings.push(`Kept recovery-pinned backups for ${newest.backup.targetPath}`);
      continue;
    }
    try {
      let archive = newest.path;
      if (!archive.endsWith(".gz")) {
        archive = await createArchive(newest, { ...options, beforeWork: async () => {
          await options.beforeWork();
          await assertRoot();
        } });
      } else if (candidates.length > 1) {
        await withReadableBackup(archive, async source => {
          options.heartbeat();
          options.validate(source, newest.backup.contract);
          options.heartbeat();
        });
        if (promoteContract) {
          await options.beforeWork();
          await assertRoot();
          await writeJsonAtomic(`${archive}.json`, { ...await readArchiveMetadata(archive), contract: newest.backup.contract });
        }
      }
      const archivedBackup = { backupPath: archive, contract: newest.backup.contract, targetPath: newest.backup.targetPath };
      result.backups.push(archivedBackup);
      result.replacements.set(newest.path.replace(/\.gz$/, ""), archive);
      // The replacement is fully verified before the first old byte is removed.
      for (const candidate of candidates) {
        if (candidate.path === archive) continue;
        await options.beforeWork();
        await assertRoot();
        if (!sameFile(candidate.identity, await fileInfo(candidate.path))) throw new Error(`Backup changed before cleanup: ${candidate.path}`);
        if (!candidate.path.endsWith(".gz")) {
          await assertNoLiveSidecars(candidate.path);
          for (const suffix of SIDECARS) await rm(`${candidate.path}${suffix}`, { force: true });
        }
        await unlink(candidate.path);
        if (candidate.path.endsWith(".gz")) await rm(`${candidate.path}.json`, { force: true });
        result.deletedBytes += candidate.identity.size;
      }
    } catch (error) {
      result.warnings.push(`Compressed backup maintenance for ${newest.backup.targetPath} was deferred: ${error instanceof Error ? error.message : String(error)}`);
    }
    options.heartbeat();
  }
  return result;
}
