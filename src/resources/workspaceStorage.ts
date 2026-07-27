import type { Dirent } from "node:fs";
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
import { EMPTY_IGNORE_MATCHER, type IgnoreMatcher } from "./ignorePatterns";
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
    /**
     * The publish limit. Capturing a database larger than what can ever be
     * published only burns minutes of IO before the publish side skips it, so
     * the capture stops at the same number.
     */
    private readonly maxPayloadBytes: number | undefined = undefined,
    /**
     * Workspaces this computer stays out of, matched against the workspace URI.
     * A workspace with no URI is never excluded: the entry would be matched on
     * nothing, and dropping a backup on the strength of missing metadata is the
     * wrong direction to fail in.
     */
    private readonly ignoredWorkspaces: IgnoreMatcher = EMPTY_IGNORE_MATCHER,
  ) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    // The URI map is snapshot metadata, not a precondition. Letting an
    // unreadable workspaceStorage root reject here dropped the backup of every
    // workspace, which is exactly the failure this adapter must not have.
    let workspaceUris = new Map<string, string>();
    try {
      workspaceUris = new Map(
        (await discoverWorkspaces(this.paths)).map((workspace) => [
          workspace.id,
          workspace.uri,
        ]),
      );
    } catch (error) {
      warnings.push(formatScanWarning(this.paths.workspaceStorageRoot, error));
    }
    const mappingTargets = new Set(Object.values(this.workspaceMappings));
    const candidates = new Map<string, WorkspaceStorageCandidate>();

    const listed = await listBackedUpWorkspaceStoragePaths(
      this.paths.workspaceStorageRoot,
    );
    warnings.push(...listed.warnings);

    for (const path of listed.paths) {
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
        if (
          isIgnoredWorkspaceUri(
            workspaceUris.get(actualWorkspaceId),
            this.ignoredWorkspaces,
          )
        ) {
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
              this.maxPayloadBytes,
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

/**
 * Enumerates the backed-up files under every workspaceStorage directory.
 *
 * A single locked, hydrating or permission-denied directory used to reject the
 * whole listing, which made the adapter throw and dropped the backup of *every*
 * workspace for that run — and since this adapter only scans at shutdown, the
 * next chance was the next clean exit. Each workspace is therefore enumerated
 * on its own and a failure is reported as a warning naming that workspace. This
 * adapter emits no deletions, so a partial listing is safe.
 */
async function listBackedUpWorkspaceStoragePaths(
  root: string,
): Promise<{ paths: string[]; warnings: string[] }> {
  if (!(await pathExists(root))) {
    return { paths: [], warnings: [] };
  }
  const paths: string[] = [];
  const warnings: string[] = [];
  let workspaces: Dirent[];
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return { paths: [], warnings: [formatScanWarning(root, error)] };
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) {
      continue;
    }
    const workspaceRoot = join(root, workspace.name);
    try {
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
          paths.push(
            ...(await listFilesRecursively(join(workspaceRoot, entry.name))),
          );
        }
      }
    } catch (error) {
      warnings.push(formatScanWarning(workspaceRoot, error));
    }
  }
  return {
    paths: paths.sort((left, right) => left.localeCompare(right)),
    warnings,
  };
}

/**
 * Whether `cursorSettingSync.ignoredWorkspaces` covers this workspace.
 *
 * Both halves of the sync consult this - the scan, so an excluded workspace is
 * never backed up, and the apply side, so an incoming one is never written and
 * never raises the mapping prompt. A workspace whose URI is unknown is left in,
 * because the pattern would be matched against nothing and silently dropping a
 * backup is the worse of the two mistakes.
 */
export function isIgnoredWorkspaceUri(
  uri: string | null | undefined,
  ignored: IgnoreMatcher,
): boolean {
  if (typeof uri !== "string" || uri.length === 0) {
    return false;
  }
  return ignored.matches(uri) || ignored.matches(decodeWorkspaceUriSafely(uri));
}

/**
 * `file://*` has to match a URI Cursor stored as `file:///c%3A/...`, and a user
 * writing a path pattern will write the readable form, so both spellings are
 * offered to the matcher.
 */
function decodeWorkspaceUriSafely(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
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
  maxPayloadBytes: number | undefined,
): Promise<{ content: Buffer; mtimeMs: number; warnings: string[] }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await workspaceStorageTimestamp(path, true);
    const captured = captureWorkspaceDatabaseSnapshot(path, {
      workspaceId: canonicalWorkspaceId,
      databaseWorkspaceId,
      includeComposerHeaders: true,
      ...(maxPayloadBytes === undefined
        ? {}
        : { limits: { maxPlainBytes: maxPayloadBytes } }),
    });
    const content = serializeWorkspaceDatabaseSnapshot(captured.snapshot);
    // The capture limit counts DECODED bytes, but the payload is base64 inside
    // JSON — roughly 4/3 of the blobs plus structure. A database that passed
    // capture can therefore still be far above the publish limit, and letting
    // it reach `publish` used to throw away the entire shutdown export. Only
    // the serialized buffer can be compared against the limit that matters.
    if (maxPayloadBytes !== undefined && content.byteLength > maxPayloadBytes) {
      throw new Error(
        `the snapshot serializes to ${content.byteLength} bytes, above the ${maxPayloadBytes} byte payload limit. ` +
          'Raise "cursorSettingSync.maxPayloadMiB" to cover it, or set ' +
          '"cursorSettingSync.syncWorkspaceStorage" to false. Everything else in this export still synchronized.',
      );
    }
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
