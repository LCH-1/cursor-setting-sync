import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
  LocalProjection,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeIdentifier,
  assertSafeRelativePath,
  listFilesRecursively,
  normalizeResourcePath,
  pathExists,
} from "../platform/files";
import { sha256 } from "../protocol/canonical";
import { discoverWorkspaces } from "../chat/workspace";
import type { ResourceAdapter, ResourceApplyInput } from "./resource";
import {
  captureWorkspaceDatabaseSnapshot,
  serializeWorkspaceDatabaseSnapshot,
} from "../helper/workspaceDatabaseMerge";

interface WorkspaceStorageCandidate {
  actualWorkspaceId: string;
  canonicalRelativePath: string;
  path: string;
  priority: number;
}

export class WorkspaceStorageAdapter implements ResourceAdapter {
  readonly id = "workspace-storage";
  readonly kinds = ["workspace-storage"] as const;
  readonly appliesWhileRunning = false;
  readonly scanWhileRunning = false;

  constructor(
    private readonly paths: CursorPaths,
    private readonly workspaceMappings: Record<string, string> = {},
  ) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const workspaceUris = new Map(
      (await discoverWorkspaces(this.paths)).map((workspace) => [
        workspace.id,
        workspace.uri,
      ]),
    );
    const mappingTargets = new Set(Object.values(this.workspaceMappings));
    const candidates = new Map<string, WorkspaceStorageCandidate>();

    for (const path of await listBackedUpWorkspaceStoragePaths(
      this.paths.workspaceStorageRoot,
    )) {
      try {
        const actualRelativePath = normalizeResourcePath(
          relative(this.paths.workspaceStorageRoot, path),
        );
        const actualWorkspaceId = validateWorkspaceStorageRelativePath(
          this.paths.workspaceStorageRoot,
          actualRelativePath,
        );
        if (!isBackedUpWorkspaceStorageFile(actualRelativePath)) {
          continue;
        }
        const canonicalWorkspaceId = canonicalWorkspaceStorageId(
          actualWorkspaceId,
          this.workspaceMappings,
        );
        const canonicalRelativePath = [
          canonicalWorkspaceId,
          ...actualRelativePath.split("/").slice(1),
        ].join("/");
        const resourceId = workspaceStorageResourceId(canonicalRelativePath);
        const candidate: WorkspaceStorageCandidate = {
          actualWorkspaceId,
          canonicalRelativePath,
          path,
          priority: mappingTargets.has(actualWorkspaceId)
            ? 2
            : actualWorkspaceId === canonicalWorkspaceId
              ? 1
              : 0,
        };
        const current = candidates.get(resourceId);
        if (current === undefined) {
          candidates.set(resourceId, candidate);
        } else {
          const preferred =
            candidate.priority > current.priority ||
            (candidate.priority === current.priority &&
              candidate.path.localeCompare(current.path) < 0)
              ? candidate
              : current;
          const discarded = preferred === candidate ? current : candidate;
          // The losing directory is excluded from backup; surfacing the
          // collision keeps that exclusion visible instead of silent.
          warnings.push(
            `workspaceStorage directories ${discarded.actualWorkspaceId} and ${preferred.actualWorkspaceId} collide on ${preferred.canonicalRelativePath}; backing up ${preferred.actualWorkspaceId} only.`,
          );
          candidates.set(resourceId, preferred);
        }
      } catch (error) {
        warnings.push(formatScanWarning(path, error));
      }
    }

    for (const [resourceId, candidate] of [...candidates.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      try {
        const database = isWorkspaceStateDatabasePath(
          candidate.canonicalRelativePath,
        );
        const observedTimestamp = await workspaceStorageTimestamp(
          candidate.path,
          database,
        );
        if (known[resourceId]?.sourceTimestamp === observedTimestamp) {
          continue;
        }
        const captured = database
          ? await snapshotWorkspaceDatabase(
              candidate.path,
              candidate.canonicalRelativePath.split("/")[0] ?? "",
              candidate.actualWorkspaceId,
            )
          : await readStableFile(candidate.path);
        warnings.push(
          ...captured.warnings.map(
            (warning) => `${candidate.canonicalRelativePath}: ${warning}`,
          ),
        );
        snapshots.push({
          resourceId,
          kind: "workspace-storage",
          content: captured.content,
          semanticHash: sha256(captured.content),
          metadata: {
            relativePath: candidate.canonicalRelativePath,
            workspaceId:
              candidate.canonicalRelativePath.split("/")[0] ?? "",
            workspaceUri:
              workspaceUris.get(candidate.actualWorkspaceId) ?? null,
            lastUpdatedAt: captured.mtimeMs,
            plainBytes: captured.content.byteLength,
          },
        });
      } catch (error) {
        warnings.push(formatScanWarning(candidate.path, error));
      }
    }

    return { snapshots, deletions: [], warnings };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("workspaceStorage files must be applied by the offline helper.");
  }
}

async function listBackedUpWorkspaceStoragePaths(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }
  const paths: string[] = [];
  const workspaces = await readdir(root, { withFileTypes: true });
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) {
      continue;
    }
    const workspaceRoot = join(root, workspace.name);
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      const lowerName = entry.name.toLowerCase();
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        ["state.vscdb", "notepads.json"].includes(lowerName)
      ) {
        paths.push(join(workspaceRoot, entry.name));
      } else if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        lowerName === "images"
      ) {
        paths.push(...(await listFilesRecursively(join(workspaceRoot, entry.name))));
      }
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

export function validateWorkspaceStorageRelativePath(
  root: string,
  relativePath: string,
): string {
  assertSafeRelativePath(root, relativePath);
  const segments = relativePath.split("/");
  if (segments.length < 2) {
    throw new Error(`workspaceStorage path must include a workspace ID: ${relativePath}`);
  }
  return assertSafeIdentifier(segments[0] ?? "", "workspaceStorage workspace ID");
}

export function workspaceStorageResourceId(relativePath: string): string {
  const resourceId = `workspace-storage/${encodeURIComponent(relativePath)}`;
  if (resourceId.length > 4096) {
    throw new Error(`workspaceStorage resource path is too long: ${relativePath}`);
  }
  return resourceId;
}

export function canonicalWorkspaceStorageId(
  localWorkspaceId: string,
  workspaceMappings: Record<string, string>,
): string {
  assertSafeIdentifier(localWorkspaceId, "workspaceStorage workspace ID");
  const related = new Set([localWorkspaceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [source, target] of Object.entries(workspaceMappings)) {
      if (!isWorkspaceStorageId(source) || !isWorkspaceStorageId(target)) {
        continue;
      }
      if (!related.has(source) && !related.has(target)) {
        continue;
      }
      if (!related.has(source)) {
        related.add(source);
        changed = true;
      }
      if (!related.has(target)) {
        related.add(target);
        changed = true;
      }
    }
  }
  return [...related].sort()[0] ?? localWorkspaceId;
}

export function isTransientWorkspaceStorageFile(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  return (
    name.endsWith("-wal") ||
    name.endsWith("-shm") ||
    name.endsWith("-journal") ||
    name.endsWith(".lock") ||
    name.endsWith(".partial") ||
    name.endsWith(".tmp")
  );
}

export function isBackedUpWorkspaceStorageFile(relativePath: string): boolean {
  if (isTransientWorkspaceStorageFile(relativePath)) {
    return false;
  }
  const segments = relativePath.split("/");
  const nestedPath = segments.slice(1);
  if (nestedPath.length === 1) {
    return ["state.vscdb", "notepads.json"].includes(
      nestedPath[0]?.toLowerCase() ?? "",
    );
  }
  return nestedPath.length >= 2 && nestedPath[0]?.toLowerCase() === "images";
}

export function isWorkspaceStateDatabasePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return (
    segments.length === 2 &&
    segments[1]?.toLowerCase() === "state.vscdb"
  );
}

async function snapshotWorkspaceDatabase(
  path: string,
  canonicalWorkspaceId: string,
  databaseWorkspaceId: string,
): Promise<{ content: Buffer; mtimeMs: number; warnings: string[] }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await workspaceStorageTimestamp(path, true);
    const captured = captureWorkspaceDatabaseSnapshot(path, {
      workspaceId: canonicalWorkspaceId,
      databaseWorkspaceId,
      includeComposerHeaders: true,
    });
    const content = serializeWorkspaceDatabaseSnapshot(captured.snapshot);
    const after = await workspaceStorageTimestamp(path, true);
    if (before === after) {
      return {
        content,
        mtimeMs: after,
        warnings: captured.warnings,
      };
    }
  }
  throw new Error(`Workspace database changed while being backed up: ${path}`);
}

async function readStableFile(
  path: string,
): Promise<{ content: Buffer; mtimeMs: number; warnings: string[] }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await stat(path);
    const content = await readFile(path);
    const after = await stat(path);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { content, mtimeMs: after.mtimeMs, warnings: [] };
    }
  }
  throw new Error(`workspaceStorage file changed while being read: ${path}`);
}

async function workspaceStorageTimestamp(
  path: string,
  database: boolean,
): Promise<number> {
  const main = await stat(path);
  if (!database) {
    return main.mtimeMs;
  }
  const walPath = `${path}-wal`;
  if (!(await pathExists(walPath))) {
    return main.mtimeMs;
  }
  return Math.max(main.mtimeMs, (await stat(walPath)).mtimeMs);
}

function isWorkspaceStorageId(value: string): boolean {
  try {
    assertSafeIdentifier(value, "workspaceStorage workspace ID");
    return true;
  } catch {
    return false;
  }
}

function formatScanWarning(path: string, error: unknown): string {
  return `Unable to back up workspaceStorage file ${path}: ${
    error instanceof Error ? error.message : String(error)
  }`;
}
