import { basename, join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { CursorPaths } from "../platform/paths";
import {
  isCaseInsensitivePathPlatform,
  pathExists,
  readFileWithinRoot,
} from "../platform/files";

export interface WorkspaceIdentity {
  id: string;
  uri: string;
  basename: string;
}

interface WorkspaceJson {
  folder?: string;
  workspace?: string;
}

interface WorkspaceDiscoveryMemo {
  mtimeMs: number;
  entryCount: number;
  workspaces: WorkspaceIdentity[];
}

/**
 * Cached per workspaceStorage root.
 *
 * Three callers rediscover this map independently - the chat scan, the
 * workspaceStorage scan and the workspace-mapping prompt - and every one of
 * them used to stat and read a `workspace.json` through the hardened path
 * walker for each of what can be hundreds of never-garbage-collected
 * workspaceStorage directories, on every 30-second poll. The set can only
 * change when a directory is added or removed, which is exactly what the root
 * directory's own mtime records; the entry count is compared as well so a
 * filesystem with coarse timestamps still notices.
 */
const discoveryMemo = new Map<string, WorkspaceDiscoveryMemo>();

/** Drops the memo; exported for tests that rewrite a workspaceStorage tree. */
export function resetWorkspaceDiscoveryCache(): void {
  discoveryMemo.clear();
}

export async function discoverWorkspaces(
  paths: CursorPaths,
): Promise<WorkspaceIdentity[]> {
  if (!(await pathExists(paths.workspaceStorageRoot))) {
    discoveryMemo.delete(paths.workspaceStorageRoot);
    return [];
  }
  const entries = await readdir(paths.workspaceStorageRoot, { withFileTypes: true });
  let rootMtimeMs: number | null = null;
  try {
    rootMtimeMs = (await stat(paths.workspaceStorageRoot)).mtimeMs;
  } catch {
    // Without a root timestamp the discovery simply runs in full.
  }
  const memo = discoveryMemo.get(paths.workspaceStorageRoot);
  if (
    rootMtimeMs !== null &&
    memo !== undefined &&
    memo.mtimeMs === rootMtimeMs &&
    memo.entryCount === entries.length
  ) {
    return [...memo.workspaces];
  }
  const workspaces: WorkspaceIdentity[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const metadataPath = join(paths.workspaceStorageRoot, entry.name, "workspace.json");
    if (!(await pathExists(metadataPath))) {
      continue;
    }
    let metadata: WorkspaceJson;
    try {
      metadata = JSON.parse(
        (
          await readFileWithinRoot(
            paths.workspaceStorageRoot,
            `${entry.name}/workspace.json`,
          )
        ).toString("utf8"),
      ) as WorkspaceJson;
    } catch {
      continue;
    }
    const uri = metadata.folder ?? metadata.workspace;
    if (typeof uri !== "string" || uri.length === 0) {
      continue;
    }
    workspaces.push({
      id: entry.name,
      uri,
      basename: workspaceBasename(uri),
    });
  }
  const sorted = workspaces.sort((left, right) => left.id.localeCompare(right.id));
  if (rootMtimeMs !== null) {
    discoveryMemo.set(paths.workspaceStorageRoot, {
      mtimeMs: rootMtimeMs,
      entryCount: entries.length,
      workspaces: sorted,
    });
  }
  return [...sorted];
}

export function resolveTargetWorkspace(
  sourceWorkspaceId: string,
  sourceWorkspaceUri: string | null,
  localWorkspaces: WorkspaceIdentity[],
  explicitMappings: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (localWorkspaces.some((workspace) => workspace.id === sourceWorkspaceId)) {
    return sourceWorkspaceId;
  }
  const explicit = Object.hasOwn(explicitMappings, sourceWorkspaceId)
    ? explicitMappings[sourceWorkspaceId]
    : undefined;
  if (
    typeof explicit === "string" &&
    localWorkspaces.some((workspace) => workspace.id === explicit)
  ) {
    return explicit;
  }
  if (sourceWorkspaceUri === null) {
    return null;
  }
  const normalizedSource = normalizeWorkspaceUri(sourceWorkspaceUri, platform);
  const exact = localWorkspaces.find(
    (workspace) =>
      normalizeWorkspaceUri(workspace.uri, platform) === normalizedSource,
  );
  if (exact !== undefined) {
    return exact.id;
  }
  // Basenames are display labels, not identities. Two unrelated projects can
  // both be named "app"; only an exact URI or explicit user mapping is safe.
  return null;
}

export function normalizeWorkspaceUri(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const decoded = decodeWorkspaceUri(uri);
  const separated = platform === "win32" ? decoded.replaceAll("\\", "/") : decoded;
  const trimmed = separated.replace(/\/+$/, "");
  return isCaseInsensitivePathPlatform(platform)
    ? trimmed.toLocaleLowerCase("en-US")
    : trimmed;
}

function workspaceBasename(uri: string): string {
  const normalized = decodeWorkspaceUri(uri)
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  return basename(normalized);
}

function decodeWorkspaceUri(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}
