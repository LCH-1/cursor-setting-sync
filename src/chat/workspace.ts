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

export interface WorkspaceDiscovery {
  workspaces: WorkspaceIdentity[];
  /**
   * Directories whose `workspace.json` was missing, torn, or unparseable at
   * scan time. Unknown is not folderless: a crash while VS Code writes the
   * file leaves it empty, and treating that as "a window with no folder open"
   * silently dropped the workspace's storage from the shutdown backup.
   */
  unreadableIds: string[];
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
  return (await discoverWorkspacesDetailed(paths)).workspaces;
}

export async function discoverWorkspacesDetailed(
  paths: CursorPaths,
): Promise<WorkspaceDiscovery> {
  if (!(await pathExists(paths.workspaceStorageRoot))) {
    discoveryMemo.delete(paths.workspaceStorageRoot);
    return { workspaces: [], unreadableIds: [] };
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
    return { workspaces: [...memo.workspaces], unreadableIds: [] };
  }
  const workspaces: WorkspaceIdentity[] = [];
  const unreadableIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const metadataPath = join(paths.workspaceStorageRoot, entry.name, "workspace.json");
    if (!(await pathExists(metadataPath))) {
      // A directory without its workspace.json is a window mid-creation or a
      // torn write, not a decided state; callers must not treat it as a
      // window that had nothing open.
      unreadableIds.push(entry.name);
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
      unreadableIds.push(entry.name);
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
  // A scan that hit an unreadable workspace.json is not memoized: the file's
  // later arrival or repair changes neither the root's mtime nor the entry
  // count, so a memo taken now would keep serving the incomplete answer.
  if (rootMtimeMs !== null && unreadableIds.length === 0) {
    discoveryMemo.set(paths.workspaceStorageRoot, {
      mtimeMs: rootMtimeMs,
      entryCount: entries.length,
      workspaces: sorted,
    });
  }
  return {
    workspaces: [...sorted],
    unreadableIds: unreadableIds.sort((left, right) => left.localeCompare(right)),
  };
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
  const decoded = normalizeRemoteHost(decodeWorkspaceUri(uri));
  const separated = platform === "win32" ? decoded.replaceAll("\\", "/") : decoded;
  const trimmed = separated.replace(/\/+$/, "");
  return isCaseInsensitivePathPlatform(platform)
    ? trimmed.toLocaleLowerCase("en-US")
    : trimmed;
}

/**
 * Collapses the two spellings Cursor uses for one SSH host.
 *
 * The same server is recorded either as the plain alias from the SSH config -
 * `ssh-remote+geekdive_local2` - or as a hex-encoded JSON descriptor,
 * `ssh-remote+7b22686f73744e616d65223a226765656b646976655f6c6f63616c32227d`,
 * which is `{"hostName":"geekdive_local2"}`. Which one appears depends on how
 * the connection was opened, and both forms occur on a single machine: one
 * user's `workspaceStorage` held 36 workspaces under the alias and 15 more
 * under the descriptor for that same server.
 *
 * VS Code hashes the URI into the workspaceStorage directory name, so the same
 * folder on the same server becomes two unrelated workspaces - which is why an
 * incoming remote workspace matched nothing locally and every chat written
 * there stopped at a mapping prompt the user had no way to answer.
 */
function normalizeRemoteHost(uri: string): string {
  return uri.replace(
    /^(vscode-remote:\/\/ssh-remote\+)([0-9a-fA-F]+)(?=\/|$)/,
    (whole, prefix: string, encoded: string) => {
      const hostName = remoteHostFromDescriptor(encoded);
      return hostName === null ? whole : `${prefix}${hostName}`;
    },
  );
}

/**
 * The `hostName` inside a hex-encoded connection descriptor, or null for
 * anything else - including an alias that happens to be all hex characters,
 * which only a successful parse can distinguish from a real descriptor.
 */
function remoteHostFromDescriptor(encoded: string): string | null {
  if (encoded.length < 2 || encoded.length % 2 !== 0) {
    return null;
  }
  const bytes = Buffer.from(encoded, "hex");
  if (bytes.length * 2 !== encoded.length) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const hostName = (parsed as { hostName?: unknown }).hostName;
  return typeof hostName === "string" && hostName.length > 0 ? hostName : null;
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
