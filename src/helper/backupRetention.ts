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
  maxFiles: 30,
  maxAgeMs: 30 * DAY_MS,
  maxTotalBytes: 2 * 1_024 * 1_024 * 1_024,
});

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
  scan.files.sort(compareNewestFirst);

  const exemptPath = options.exemptPath ?? scan.files[0]?.path;
  const retained: BackupFile[] = [];
  const deletionPlan: BackupFile[] = [];
  let retainedBytes = 0;
  let newestPrefixOpen = true;
  for (const file of scan.files) {
    const ageMs = Math.max(0, policy.nowMs - file.mtimeMs);
    const withinAge = ageMs <= policy.maxAgeMs;
    const withinCount = retained.length < policy.maxFiles;
    const withinBytes =
      file.size <= policy.maxTotalBytes - retainedBytes;
    if (newestPrefixOpen && withinAge && withinCount && withinBytes) {
      retained.push(file);
      retainedBytes += file.size;
      continue;
    }
    if (exemptPath !== undefined && pathsEqual(file.path, exemptPath)) {
      // Deleting the backup of the running request would fail its
      // post-retention validation and abort the apply forever.
      scan.skipped.push({
        path: file.path,
        reason: "The exempt backup is never removed by retention.",
      });
      continue;
    }
    if (!withinAge || !withinCount) {
      // Only age and count violations close the newest prefix. A file that
      // alone exceeds the remaining byte budget is deleted without closing
      // the prefix, so healthy older backups that still fit stay retained.
      newestPrefixOpen = false;
    }
    deletionPlan.push(file);
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
