import {
  lstat,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Stats } from "node:fs";
import { BACKUP_DIRECTORY } from "../constants";
import {
  isCaseInsensitivePathPlatform,
  isMissingPathError,
} from "../platform/files";

const DAY_MS = 24 * 60 * 60 * 1_000;
const FUTURE_MTIME_TOLERANCE_MS = 60_000;

export interface BackupRetentionOptions {
  maxFiles?: number;
  maxAgeMs?: number;
  maxTotalBytes?: number;
  /** Intended for deterministic callers and tests. Defaults to Date.now(). */
  nowMs?: number;
  /**
   * Absolute path of a backup that retention must never delete, typically the
   * backup created by the running request. Defaults to the newest scanned
   * file so post-retention validation of a fresh backup cannot fail.
   */
  exemptPath?: string;
  /**
   * Every backup the running request has taken so far. One request can take
   * several - the pre-apply global snapshot, then per-workspace and
   * per-profile ones - and a retention pass that exempts only its own newest
   * backup was able to evict the same request's earlier ones, including the
   * only pre-apply recovery point.
   */
  exemptPaths?: readonly string[];
}

export interface SkippedBackupEntry {
  path: string;
  reason: string;
}

export interface BackupRetentionResult {
  backupRoot: string;
  retainedPaths: string[];
  deletedPaths: string[];
  skipped: SkippedBackupEntry[];
  retainedBytes: number;
  deletedBytes: number;
}

export const DEFAULT_BACKUP_RETENTION = Object.freeze({
  /**
   * Counted in backups, not files: a snapshot and its journal sidecars are one
   * entry, so a directory of 30 backups is 30 recovery points rather than the
   * ten it used to work out to.
   */
  maxFiles: 30,
  maxAgeMs: 30 * DAY_MS,
  /**
   * Two generations of a large Cursor database, plus room for the small
   * per-workspace snapshots taken in the same run.
   *
   * This was 2 GiB, which is less than twice the size a heavily used global
   * database reaches - 1.29 GiB on the machine this was found on. The budget
   * could therefore hold exactly one global snapshot, so every apply deleted
   * the previous one and the only recovery point was the state immediately
   * before the newest apply. An apply whose damage is noticed one apply later
   * had nothing left to roll back to.
   */
  maxTotalBytes: 4 * 1_024 * 1_024 * 1_024,
});

/**
 * SQLite's sidecars for a database file. A backup is a snapshot with no
 * readers to coordinate with, so these carry nothing once it is sealed; they
 * exist only because opening a WAL-mode file read-only recreates them.
 */
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

interface NormalizedRetentionPolicy {
  maxFiles: number;
  maxAgeMs: number;
  maxTotalBytes: number;
  nowMs: number;
}

interface BackupFile {
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  identity: FileIdentity;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ScanResult {
  files: BackupFile[];
  skipped: SkippedBackupEntry[];
}

/**
 * One recovery point: a snapshot together with any SQLite sidecars sitting
 * beside it. Retention decides about the group rather than about each file,
 * because a sidecar is worth nothing without its database and a database is
 * still usable without its sidecars.
 */
interface BackupGroup {
  /** The snapshot, or null for sidecars whose database is already gone. */
  primary: BackupFile | null;
  files: BackupFile[];
  mtimeMs: number;
  relativePath: string;
}

/**
 * Applies bounded retention to plaintext local recovery snapshots under the
 * extension's exact `backups` directory. Only regular files are unlinked. The
 * function never follows or removes symbolic links, never removes directories,
 * and never copies, renames, or replaces a live database.
 *
 * Call this after a backup has been fully created and validated. A missing
 * backup directory is a successful no-op.
 */
export async function enforceBackupRetention(
  extensionStorageRoot: string,
  options: BackupRetentionOptions = {},
): Promise<BackupRetentionResult> {
  const policy = normalizePolicy(options);
  const backupRoot = resolve(extensionStorageRoot, BACKUP_DIRECTORY);
  const initialRootStat = await lstatOrNull(backupRoot);
  if (initialRootStat === null) {
    return emptyResult(backupRoot);
  }
  if (initialRootStat.isSymbolicLink() || !initialRootStat.isDirectory()) {
    throw new Error(
      `Refusing backup retention because the backup root is not a real directory: ${backupRoot}`,
    );
  }

  const canonicalStorageRoot = await realpath(resolve(extensionStorageRoot));
  const canonicalBackupRoot = await realpath(backupRoot);
  const expectedCanonicalRoot = resolve(
    canonicalStorageRoot,
    BACKUP_DIRECTORY,
  );
  if (!pathsEqual(canonicalBackupRoot, expectedCanonicalRoot)) {
    throw new Error(
      `Refusing backup retention because the backup root resolves outside extension storage: ${backupRoot}`,
    );
  }

  const rootIdentity = identityOf(initialRootStat);
  await assertRootUnchanged(backupRoot, rootIdentity);
  const scan = await scanBackupDirectory(
    backupRoot,
    canonicalBackupRoot,
    rootIdentity,
  );
  // A future mtime - clock rollback, a restored backup directory - must not
  // pin a file permanently at the top of the newest prefix, where the age
  // clamp keeps it forever young and the ordering keeps it forever first.
  // Within the tolerance it is benign skew and clamps to now; beyond it the
  // timestamp is not evidence of recency at all, so the file is ordered at
  // the age boundary instead - retained while there is room, first out under
  // pressure, and never occupying the newest slot.
  for (const file of scan.files) {
    if (file.mtimeMs > policy.nowMs + FUTURE_MTIME_TOLERANCE_MS) {
      file.mtimeMs = policy.nowMs - policy.maxAgeMs;
    } else if (file.mtimeMs > policy.nowMs) {
      file.mtimeMs = policy.nowMs;
    }
  }
  scan.files.sort(compareNewestFirst);

  const groups = groupBackupFiles(scan.files);
  // The default exempts the newest snapshot rather than the newest file, which
  // after a backup is one of its sidecars.
  const fallbackExempt =
    options.exemptPath === undefined && (options.exemptPaths?.length ?? 0) === 0
      ? groups.find((group) => group.primary !== null)?.primary?.path
      : undefined;
  const exemptPaths = [
    ...(options.exemptPath === undefined ? [] : [options.exemptPath]),
    ...(options.exemptPaths ?? []),
    ...(fallbackExempt === undefined ? [] : [fallbackExempt]),
  ];
  const isExemptGroup = (group: BackupGroup): boolean =>
    exemptPaths.some((path) => groupContainsPath(group, path));
  const retained: BackupFile[] = [];
  const deletionPlan: BackupFile[] = [];
  let retainedBytes = 0;
  let retainedBackups = 0;
  let newestPrefixOpen = true;
  for (const group of groups) {
    if (group.primary === null) {
      // A journal sidecar whose database is gone restores nothing. These used
      // to outlive the snapshots they belonged to: sidecars are written last,
      // so newest-first ordering kept them and spent the count and byte budget
      // the real backups needed.
      if (isExemptGroup(group)) {
        scan.skipped.push({
          path: group.files[0]?.path ?? exemptPaths[0] ?? "",
          reason: "The exempt backup is never removed by retention.",
        });
        continue;
      }
      deletionPlan.push(...group.files);
      continue;
    }
    // Sidecars beside a snapshot that is being kept are spent too. New backups
    // are sealed at write time so they never grow any; removing them here is
    // what clears the ones earlier versions left behind.
    const spent = group.files.filter(
      (file) => file !== group.primary && isSpentSidecar(file),
    );
    const live = group.files.filter((file) => !spent.includes(file));
    const liveBytes = live.reduce((total, file) => total + file.size, 0);

    const ageMs = Math.max(0, policy.nowMs - group.mtimeMs);
    const withinAge = ageMs <= policy.maxAgeMs;
    const withinCount = retainedBackups < policy.maxFiles;
    const withinBytes = liveBytes <= policy.maxTotalBytes - retainedBytes;
    if (newestPrefixOpen && withinAge && withinCount && withinBytes) {
      retained.push(...live);
      retainedBytes += liveBytes;
      retainedBackups += 1;
      deletionPlan.push(...spent);
      continue;
    }
    if (isExemptGroup(group)) {
      // Deleting a backup of the running request would fail its
      // post-retention validation and abort the apply forever.
      scan.skipped.push({
        path: group.primary.path,
        reason: "The exempt backup is never removed by retention.",
      });
      deletionPlan.push(...spent);
      continue;
    }
    if (!withinAge || !withinCount) {
      // Only age and count violations close the newest prefix. A backup that
      // alone exceeds the remaining byte budget is deleted without closing
      // the prefix, so healthy older backups that still fit stay retained.
      newestPrefixOpen = false;
    }
    // The snapshot is listed before its sidecars so that the reversed plan
    // removes it last; an interruption then leaves a usable backup behind
    // rather than sidecars with nothing to attach to.
    deletionPlan.push(
      group.primary,
      ...group.files.filter((file) => file !== group.primary),
    );
  }

  const deleted: BackupFile[] = [];
  // Removing oldest files first preserves the most useful recovery points if
  // the process is interrupted midway through maintenance.
  for (const file of deletionPlan.reverse()) {
    await assertRootUnchanged(backupRoot, rootIdentity);
    const safeToDelete = await verifyDeletionCandidate(
      backupRoot,
      canonicalBackupRoot,
      file,
    );
    if (safeToDelete !== null) {
      scan.skipped.push({ path: file.path, reason: safeToDelete });
      retained.push(file);
      retainedBytes += file.size;
      continue;
    }
    try {
      // unlink removes only this directory entry. It does not follow a final
      // path component that is swapped to a symlink after validation.
      await unlink(file.path);
      deleted.push(file);
    } catch (error) {
      if (!isMissingPathError(error)) {
        scan.skipped.push({
          path: file.path,
          reason: `Could not remove backup: ${formatUnknownError(error)}`,
        });
        retained.push(file);
        retainedBytes += file.size;
      }
    }
  }

  retained.sort(compareNewestFirst);
  deleted.sort(compareNewestFirst);
  scan.skipped.sort((left, right) => comparePath(left.path, right.path));
  return {
    backupRoot,
    retainedPaths: retained.map((file) => file.path),
    deletedPaths: deleted.map((file) => file.path),
    skipped: scan.skipped,
    retainedBytes,
    deletedBytes: deleted.reduce((total, file) => total + file.size, 0),
  };
}

async function scanBackupDirectory(
  backupRoot: string,
  canonicalBackupRoot: string,
  rootIdentity: FileIdentity,
): Promise<ScanResult> {
  const files: BackupFile[] = [];
  const skipped: SkippedBackupEntry[] = [];
  const pending = [backupRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      continue;
    }
    await assertRootUnchanged(backupRoot, rootIdentity);
    const directoryStat = await lstatOrNull(directory);
    if (directoryStat === null) {
      continue;
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      skipped.push({
        path: directory,
        reason: "Directory changed or became a symbolic link during retention.",
      });
      continue;
    }
    const canonicalDirectory = await realpath(directory);
    if (!isPathInside(canonicalBackupRoot, canonicalDirectory, true)) {
      skipped.push({
        path: directory,
        reason: "Directory resolves outside the exact backup root.",
      });
      continue;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      // Archive retention is per database; extraction scratch must survive
      // the pre-restore backup created while it is in use.
      if (/\.(vscdb|db)\.gz(?:\.json)?$/.test(entry.name) ||
        entry.name.startsWith(".restore-") || entry.name.endsWith(".partial")) continue;
      const child = resolve(directory, entry.name);
      if (!isPathInside(backupRoot, child, false)) {
        throw new Error(`Backup entry escapes the exact backup root: ${child}`);
      }
      const childStat = await lstatOrNull(child);
      if (childStat === null) {
        continue;
      }
      if (childStat.isSymbolicLink()) {
        skipped.push({
          path: child,
          reason: "Symbolic links are never followed or removed.",
        });
      } else if (childStat.isDirectory()) {
        pending.push(child);
      } else if (childStat.isFile()) {
        if (!Number.isSafeInteger(childStat.size) || childStat.size < 0) {
          skipped.push({
            path: child,
            reason: "File size is outside the supported safe-integer range.",
          });
          continue;
        }
        files.push({
          path: child,
          relativePath: portableRelativePath(backupRoot, child),
          size: childStat.size,
          mtimeMs: childStat.mtimeMs,
          identity: identityOf(childStat),
        });
      } else {
        skipped.push({
          path: child,
          reason: "Only regular backup files are eligible for retention.",
        });
      }
    }
  }
  return { files, skipped };
}

async function verifyDeletionCandidate(
  backupRoot: string,
  canonicalBackupRoot: string,
  file: BackupFile,
): Promise<string | null> {
  if (!isPathInside(backupRoot, file.path, false)) {
    return "Candidate is outside the exact backup root.";
  }
  const ancestorIssue = await verifyRealDirectoryAncestors(
    backupRoot,
    dirname(file.path),
  );
  if (ancestorIssue !== null) {
    return ancestorIssue;
  }
  const current = await lstatOrNull(file.path);
  if (current === null) {
    return "Backup disappeared before retention could remove it.";
  }
  if (current.isSymbolicLink() || !current.isFile()) {
    return "Backup changed type before retention could remove it.";
  }
  if (!sameIdentity(file.identity, identityOf(current))) {
    return "Backup changed after it was scanned and was left untouched.";
  }
  const canonicalCandidate = await realpath(file.path);
  if (!isPathInside(canonicalBackupRoot, canonicalCandidate, false)) {
    return "Backup resolves outside the exact backup root.";
  }
  return null;
}

async function verifyRealDirectoryAncestors(
  backupRoot: string,
  candidateParent: string,
): Promise<string | null> {
  const relativeParent = relative(backupRoot, candidateParent);
  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${sep}`) ||
    isAbsolute(relativeParent)
  ) {
    return "Backup parent is outside the exact backup root.";
  }
  let current = backupRoot;
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const currentStat = await lstatOrNull(current);
    if (
      currentStat === null ||
      currentStat.isSymbolicLink() ||
      !currentStat.isDirectory()
    ) {
      return "A backup parent changed or became a symbolic link.";
    }
  }
  return null;
}

async function assertRootUnchanged(
  backupRoot: string,
  expected: FileIdentity,
): Promise<void> {
  const current = await lstatOrNull(backupRoot);
  if (
    current === null ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameDirectoryIdentity(expected, identityOf(current))
  ) {
    throw new Error(
      `Backup root changed during retention; no further files will be removed: ${backupRoot}`,
    );
  }
}

function normalizePolicy(
  options: BackupRetentionOptions,
): NormalizedRetentionPolicy {
  const maxFiles = options.maxFiles ?? DEFAULT_BACKUP_RETENTION.maxFiles;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_BACKUP_RETENTION.maxAgeMs;
  const maxTotalBytes =
    options.maxTotalBytes ?? DEFAULT_BACKUP_RETENTION.maxTotalBytes;
  const nowMs = options.nowMs ?? Date.now();
  assertNonNegativeSafeInteger(maxFiles, "maxFiles");
  assertNonNegativeSafeInteger(maxAgeMs, "maxAgeMs");
  assertNonNegativeSafeInteger(maxTotalBytes, "maxTotalBytes");
  assertNonNegativeSafeInteger(nowMs, "nowMs");
  return { maxFiles, maxAgeMs, maxTotalBytes, nowMs };
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function identityOf(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameDirectoryIdentity(left: FileIdentity, right: FileIdentity): boolean {
  // Directory size and timestamps legitimately change as backup entries are
  // unlinked. Device/inode identify the directory itself across that cleanup.
  return left.dev === right.dev && left.ino === right.ino;
}

function compareNewestFirst(left: BackupFile, right: BackupFile): number {
  if (left.mtimeMs !== right.mtimeMs) {
    return right.mtimeMs - left.mtimeMs;
  }
  return comparePath(right.relativePath, left.relativePath);
}

/**
 * Collects each snapshot with its sidecars. A group is dated by its snapshot,
 * not by its newest file, so a sidecar recreated later by a read-only open
 * cannot make an old backup look fresh.
 */
function groupBackupFiles(files: BackupFile[]): BackupGroup[] {
  const snapshots = new Map<string, BackupGroup>();
  for (const file of files) {
    if (sidecarBasePath(file.path) === null) {
      snapshots.set(groupKey(file.path), {
        primary: file,
        files: [file],
        mtimeMs: file.mtimeMs,
        relativePath: file.relativePath,
      });
    }
  }
  const orphans: BackupGroup[] = [];
  for (const file of files) {
    const base = sidecarBasePath(file.path);
    if (base === null) {
      continue;
    }
    const group = snapshots.get(groupKey(base));
    if (group === undefined) {
      orphans.push({
        primary: null,
        files: [file],
        mtimeMs: file.mtimeMs,
        relativePath: file.relativePath,
      });
      continue;
    }
    group.files.push(file);
  }
  return [...snapshots.values(), ...orphans].sort(compareGroupsNewestFirst);
}

function compareGroupsNewestFirst(left: BackupGroup, right: BackupGroup): number {
  if (left.mtimeMs !== right.mtimeMs) {
    return right.mtimeMs - left.mtimeMs;
  }
  return comparePath(right.relativePath, left.relativePath);
}

/** The database a sidecar belongs to, or null when the path is not one. */
function sidecarBasePath(path: string): string | null {
  const lower = path.toLowerCase();
  for (const suffix of SIDECAR_SUFFIXES) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) {
      return path.slice(0, path.length - suffix.length);
    }
  }
  return null;
}

/**
 * A sidecar that cannot be holding anything the snapshot needs. `-shm` is a
 * shared-memory index SQLite rebuilds on demand, and retention only ever runs
 * with no Cursor process alive to have one mapped. An empty log is likewise
 * spent; one with content is left alone rather than guessed about.
 */
function isSpentSidecar(file: BackupFile): boolean {
  const lower = file.path.toLowerCase();
  return lower.endsWith("-shm") || file.size === 0;
}

function groupContainsPath(group: BackupGroup, path: string): boolean {
  return group.files.some((file) => pathsEqual(file.path, path));
}

function groupKey(path: string): string {
  return isCaseInsensitivePathPlatform(process.platform)
    ? resolve(path).toLowerCase()
    : resolve(path);
}

function comparePath(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isPathInside(root: string, candidate: string, allowRoot: boolean): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath.length === 0) {
    return allowRoot;
  }
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

export function pathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isCaseInsensitivePathPlatform(platform)
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function emptyResult(backupRoot: string): BackupRetentionResult {
  return {
    backupRoot,
    retainedPaths: [],
    deletedPaths: [],
    skipped: [],
    retainedBytes: 0,
    deletedBytes: 0,
  };
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
