import { basename, join } from "node:path";
import { readdir } from "node:fs/promises";
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

export async function discoverWorkspaces(
  paths: CursorPaths,
): Promise<WorkspaceIdentity[]> {
  if (!(await pathExists(paths.workspaceStorageRoot))) {
    return [];
  }
  const entries = await readdir(paths.workspaceStorageRoot, { withFileTypes: true });
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
  return workspaces.sort((left, right) => left.id.localeCompare(right.id));
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
