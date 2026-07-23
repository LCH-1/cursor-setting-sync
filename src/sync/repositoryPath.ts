import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isCaseInsensitivePathPlatform } from "../platform/files";

export async function assertSafeRepositoryLocation(
  repositoryRoot: string,
  synchronizedRoots: ReadonlyArray<{ label: string; path: string }>,
): Promise<void> {
  const canonicalRepository = await canonicalizePath(repositoryRoot);
  for (const synchronized of synchronizedRoots) {
    const canonicalSynchronized = await canonicalizePath(synchronized.path);
    if (pathsOverlap(canonicalRepository, canonicalSynchronized)) {
      throw new Error(
        `The synchronization repository must not contain or be contained by ${synchronized.label}: ${synchronized.path}`,
      );
    }
  }
}

export function pathsOverlap(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedLeft = normalizeComparisonPath(left, platform);
  const normalizedRight = normalizeComparisonPath(right, platform);
  return (
    pathContains(normalizedLeft, normalizedRight) ||
    pathContains(normalizedRight, normalizedLeft)
  );
}

async function canonicalizePath(candidate: string): Promise<string> {
  let current = resolve(candidate);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const resolvedExisting = await realpath(current);
      return resolve(resolvedExisting, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        return resolve(candidate);
      }
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

export function normalizeComparisonPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = resolve(path);
  return isCaseInsensitivePathPlatform(platform)
    ? normalized.toLowerCase()
    : normalized;
}

function pathContains(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
