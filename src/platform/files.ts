import {
  constants,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export interface SafePathOnDiskOptions {
  allowMissing?: boolean;
  finalType?: "file" | "directory" | "any";
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function assertRealDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  const pathStat = await lstatOrNull(resolved);
  if (
    pathStat === null ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory()
  ) {
    throw new Error(`Expected a real directory: ${resolved}`);
  }
  return resolved;
}

// Reading from a synchronized folder can fail transiently: a cloud provider
// (OneDrive, Google Drive) may briefly lock a file while syncing it, or return
// UNKNOWN/EIO while hydrating an online-only placeholder. These are not
// corruption, so a short retry rides over them instead of aborting the whole
// sync. ENOENT is deliberately excluded — a missing file is a real absence the
// callers already handle. Genuine corruption surfaces later as a parse or hash
// failure, which is never a transient code and is therefore never retried.
const TRANSIENT_IO_CODES = new Set([
  "UNKNOWN",
  "EBUSY",
  "EIO",
  "EPERM",
  "EACCES",
  "EAGAIN",
  "EMFILE",
  "ENFILE",
  "ETIMEDOUT",
]);

export function isTransientIoError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    TRANSIENT_IO_CODES.has(error.code)
  );
}

export async function retryTransientRead<T>(
  operation: () => Promise<T>,
  attempts = 4,
  baseDelayMs = 150,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientIoError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
}

export async function statResilient(path: string): Promise<Stats> {
  return retryTransientRead(() => stat(path));
}

export async function readFileResilient(path: string): Promise<Buffer> {
  return retryTransientRead(() => readFile(path));
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const content = await retryTransientRead(() => readFile(path, "utf8"));
  return JSON.parse(content) as T;
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  /**
   * Pretty-print with two-space indentation. Files a human may open keep it;
   * the local sync state, which holds one record per synchronized resource and
   * is rewritten several times a minute, does not — the indentation there
   * roughly doubles the bytes serialized and fsync'd for nobody's benefit.
   */
  pretty = true,
): Promise<void> {
  const json = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await writeFileAtomic(path, Buffer.from(`${json}\n`, "utf8"));
}

export async function writeFileAtomic(
  path: string,
  content: Uint8Array,
  overwrite = true,
): Promise<void> {
  const parent = dirname(path);
  await ensureDirectory(parent);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.partial`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    // The commit gets the same transient tolerance as reads: a cloud-sync
    // client or antivirus holding the destination for a moment turns rename
    // into EPERM/EBUSY, and without a retry a durably written payload was
    // reported as a failed publish. EEXIST from link is not transient and
    // still fails fast.
    await retryTransientRead(async () => {
      if (!overwrite) {
        await link(temporaryPath, path);
      } else {
        await rename(temporaryPath, path);
      }
    });
    if (!overwrite) {
      await rm(temporaryPath, { force: true });
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await syncDirectoryBestEffort(parent);
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  // Persists the directory entry after rename/link so a published file cannot
  // vanish on power loss while later writes survive. Filesystems that refuse
  // to open or sync a directory degrade to the previous behavior.
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported here.
  }
}

export async function copyFileAtomic(source: string, destination: string): Promise<void> {
  const parent = dirname(destination);
  await ensureDirectory(parent);
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.partial`;
  await copyFile(source, temporaryPath, constants.COPYFILE_EXCL);
  // Same durability contract as writeFileAtomic above: the caller is
  // archiveRepository, the user's explicit safety copy, so a copy that
  // evaporates on power loss defeats the reason it was taken.
  const handle = await open(temporaryPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Same transient tolerance as writeFileAtomic's commit.
    await retryTransientRead(() => rename(temporaryPath, destination));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await syncDirectoryBestEffort(parent);
}

export async function listFilesRecursively(root: string): Promise<string[]> {
  const rootStat = await lstatOrNull(root);
  if (rootStat === null) {
    return [];
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Recursive file root must be a real directory: ${root}`);
  }
  const canonicalRoot = await realpath(resolve(root));

  const files: string[] = [];
  const pending = [resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error(`Recursive file path changed into a link or non-directory: ${current}`);
    }
    await assertCanonicalPathInside(canonicalRoot, current);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = resolve(current, entry.name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) {
        continue;
      }
      await assertCanonicalPathInside(canonicalRoot, child);
      if (childStat.isDirectory()) {
        pending.push(child);
      } else if (childStat.isFile()) {
        files.push(child);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * Resolves a portable path below a trusted, real directory and verifies every
 * existing component below that root without following symbolic links or
 * Windows junctions. The trusted root itself may have linked ancestors, but it
 * must be a real directory at the supplied path.
 */
export async function assertSafeRelativePathOnDisk(
  root: string,
  candidate: string,
  options: SafePathOnDiskOptions = {},
): Promise<string> {
  const target = assertSafeRelativePath(root, candidate);
  const allowMissing = options.allowMissing ?? false;
  const finalType = options.finalType ?? "any";
  const rootPath = resolve(root);
  const rootStat = await lstatOrNull(rootPath);
  if (
    rootStat === null ||
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory()
  ) {
    throw new Error(`Synchronized root must be a real directory: ${rootPath}`);
  }
  const canonicalRoot = await realpath(rootPath);
  const segments = candidate.split("/");
  let current = rootPath;
  let missing = false;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index] ?? "");
    const currentStat = await lstatOrNull(current);
    const final = index === segments.length - 1;
    if (currentStat === null) {
      if (!allowMissing) {
        throw new Error(`Synchronized path does not exist: ${candidate}`);
      }
      missing = true;
      continue;
    }
    if (missing) {
      throw new Error(`Synchronized path changed while being checked: ${candidate}`);
    }
    if (currentStat.isSymbolicLink()) {
      throw new Error(`Synchronized path contains a symbolic link or junction: ${candidate}`);
    }
    if (!final && !currentStat.isDirectory()) {
      throw new Error(`Synchronized path parent is not a directory: ${candidate}`);
    }
    if (
      final &&
      ((finalType === "file" && !currentStat.isFile()) ||
        (finalType === "directory" && !currentStat.isDirectory()))
    ) {
      throw new Error(`Synchronized path has an unexpected file type: ${candidate}`);
    }
    await assertCanonicalPathInside(canonicalRoot, current);
  }
  await assertSameDirectory(rootPath, rootStat);
  return target;
}

export async function readFileWithinRoot(
  root: string,
  candidate: string,
  maxBytes?: number,
): Promise<Buffer> {
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
  ) {
    throw new Error("Safe file read limit must be a non-negative integer.");
  }
  const target = await assertSafeRelativePathOnDisk(root, candidate, {
    finalType: "file",
  });
  const before = await lstat(target);
  const handle = await open(target, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error(`Synchronized file changed while being opened: ${candidate}`);
    }
    if (maxBytes !== undefined && opened.size > maxBytes) {
      throw new Error(`Synchronized file exceeds its size limit: ${candidate}`);
    }
    const content = await handle.readFile();
    if (maxBytes !== undefined && content.byteLength > maxBytes) {
      throw new Error(`Synchronized file exceeds its size limit: ${candidate}`);
    }
    const after = await lstat(target);
    if (
      after.isSymbolicLink() ||
      !sameFileIdentity(before, after) ||
      !sameFileVersion(before, after)
    ) {
      throw new Error(`Synchronized file changed while being read: ${candidate}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

export async function writeFileAtomicWithinRoot(
  root: string,
  candidate: string,
  content: Uint8Array,
  overwrite = true,
): Promise<void> {
  const target = await prepareFilePathWithinRoot(root, candidate);
  await writeFileAtomic(target, content, overwrite);
  await assertSafeRelativePathOnDisk(root, candidate, { finalType: "file" });
}

export async function prepareFilePathWithinRoot(
  root: string,
  candidate: string,
): Promise<string> {
  assertSafeRelativePath(root, candidate);
  await ensureSafeParentDirectories(root, candidate);
  return assertSafeRelativePathOnDisk(root, candidate, {
    allowMissing: true,
    finalType: "file",
  });
}

export async function ensureDirectoryWithinRoot(
  root: string,
  candidate: string,
): Promise<string> {
  assertSafeRelativePath(root, candidate);
  await ensureSafeParentDirectories(root, `${candidate}/.directory-target`);
  return assertSafeRelativePathOnDisk(root, candidate, {
    finalType: "directory",
  });
}

export async function removeFileWithinRoot(
  root: string,
  candidate: string,
): Promise<void> {
  const target = await assertSafeRelativePathOnDisk(root, candidate, {
    allowMissing: true,
    finalType: "file",
  });
  const targetStat = await lstatOrNull(target);
  if (targetStat === null) {
    return;
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error(`Refusing to remove a non-regular synchronized file: ${candidate}`);
  }
  try {
    await unlink(target);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

export async function directorySize(root: string): Promise<number> {
  const files = await listFilesRecursively(root);
  let total = 0;
  for (const file of files) {
    total += (await stat(file)).size;
  }
  return total;
}

export function assertSafeRelativePath(root: string, candidate: string): string {
  if (isAbsolute(candidate)) {
    throw new Error(`Absolute paths are not allowed: ${candidate}`);
  }
  if (candidate.length === 0 || candidate !== normalizeResourcePath(candidate)) {
    throw new Error(`Path is not in portable normalized form: ${candidate}`);
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => !isSafePortablePathSegment(segment))) {
    throw new Error(`Path contains an unsafe segment: ${candidate}`);
  }
  const normalizedRoot = resolve(root);
  const resolved = resolve(normalizedRoot, candidate);
  const relativePath = relative(normalizedRoot, resolved);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Path escapes synchronized root: ${candidate}`);
  }
  return resolved;
}

export function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.length > 128) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  if (!isSafePortablePathSegment(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}

export function normalizeResourcePath(path: string): string {
  return path.replaceAll("\\", "/").normalize("NFC");
}

// NTFS and default APFS fold case on lookup; Linux filesystems do not.
export function isCaseInsensitivePathPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" || platform === "darwin";
}

async function ensureSafeParentDirectories(
  root: string,
  candidate: string,
): Promise<void> {
  assertSafeRelativePath(root, candidate);
  const rootPath = resolve(root);
  const rootStat = await lstatOrNull(rootPath);
  if (
    rootStat === null ||
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory()
  ) {
    throw new Error(`Synchronized root must be a real directory: ${rootPath}`);
  }
  const canonicalRoot = await realpath(rootPath);
  const segments = candidate.split("/").slice(0, -1);
  let current = rootPath;
  for (const segment of segments) {
    current = resolve(current, segment);
    let currentStat = await lstatOrNull(current);
    if (currentStat === null) {
      try {
        await mkdir(current);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }
      }
      currentStat = await lstatOrNull(current);
    }
    if (
      currentStat === null ||
      currentStat.isSymbolicLink() ||
      !currentStat.isDirectory()
    ) {
      throw new Error(
        `Synchronized path contains a linked or invalid directory: ${candidate}`,
      );
    }
    await assertCanonicalPathInside(canonicalRoot, current);
  }
  await assertSameDirectory(rootPath, rootStat);
}

async function assertCanonicalPathInside(
  canonicalRoot: string,
  path: string,
): Promise<void> {
  const canonicalPath = await realpath(path);
  const relativePath = relative(canonicalRoot, canonicalPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Filesystem path resolves outside its synchronized root: ${path}`);
  }
}

async function assertSameDirectory(path: string, expected: Stats): Promise<void> {
  const current = await lstatOrNull(path);
  if (
    current === null ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    expected.dev !== current.dev ||
    expected.ino !== current.ino
  ) {
    throw new Error(`Synchronized root changed while being checked: ${path}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.ino !== 0 || right.ino !== 0) {
    return (
      left.ino === right.ino &&
      (process.platform === "win32" || left.dev === right.dev)
    );
  }
  return (
    left.dev === right.dev &&
    Math.abs(left.birthtimeMs - right.birthtimeMs) <= 2
  );
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return (
    left.size === right.size &&
    Math.abs(left.mtimeMs - right.mtimeMs) <= 2 &&
    Math.abs(left.ctimeMs - right.ctimeMs) <= 2
  );
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

function isSafePortablePathSegment(segment: string): boolean {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("\0") ||
    segment.includes(":") ||
    segment.endsWith(".") ||
    segment.endsWith(" ")
  ) {
    return false;
  }
  const stem = segment.split(".")[0]?.toUpperCase() ?? "";
  return !(
    ["CON", "PRN", "AUX", "NUL"].includes(stem) ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  );
}

export function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
