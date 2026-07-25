import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  LocalProjection,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  isMissingPathError,
  listFilesRecursively,
  normalizeResourcePath,
  readFileWithinRoot,
} from "../platform/files";
import { sha256 } from "../protocol/canonical";
import type { ResourceAdapter, ResourceApplyInput } from "../resources/resource";

/** Where Cursor keeps a project's transcripts, relative to the project root. */
const TRANSCRIPT_DIRECTORY = "agent-transcripts";

export class ChatTranscriptsAdapter implements ResourceAdapter {
  readonly id = "chat-transcripts";
  readonly kinds = ["chat-transcript"] as const;
  readonly appliesWhileRunning = false;

  constructor(private readonly paths: CursorPaths) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const current = new Set<string>();
    const discovered = await this.discoverTranscripts(warnings);
    for (const path of discovered.files) {
      try {
        const relativePath = normalizeResourcePath(
          relative(this.paths.cursorProjects, path),
        );
        const resourceId = `chat-transcript/${encodeURIComponent(relativePath)}`;
        const projectSlug = relativePath.split("/")[0] ?? "";
        current.add(resourceId);
        const currentStat = await stat(path);
        if (known[resourceId]?.sourceTimestamp === currentStat.mtimeMs) {
          continue;
        }
        const stable = await readStableFile(
          this.paths.cursorHome,
          normalizeResourcePath(relative(this.paths.cursorHome, path)),
          path,
        );
        snapshots.push({
          resourceId,
          kind: "chat-transcript",
          content: stable.content,
          semanticHash: sha256(stable.content),
          metadata: {
            relativePath,
            projectSlug,
            lastUpdatedAt: stable.mtimeMs,
          },
        });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    return {
      snapshots,
      deletions: findDeletions(known, current, discovered.scannedProjects),
      warnings,
    };
  }

  /**
   * Lists transcript files by opening each project's `agent-transcripts`
   * directory directly.
   *
   * The previous implementation walked the whole of ~/.cursor/projects and then
   * threw away everything that was not a transcript. That walk is
   * security-hardened rather than fast - roughly two `realpath` calls per
   * filesystem entry - so on a large chat history it cost seconds per 30-second
   * poll to rediscover the same files. Enumerating the transcript directories
   * themselves visits only entries that can produce a resource.
   *
   * A project whose directory could not be read is reported and excluded from
   * deletions, so an unreadable project never tombstones its transcripts on the
   * other devices.
   */
  private async discoverTranscripts(
    warnings: string[],
  ): Promise<{ files: string[]; scannedProjects: Set<string> }> {
    const files: string[] = [];
    const scannedProjects = new Set<string>();
    let projects;
    try {
      projects = await readdir(this.paths.cursorProjects, {
        withFileTypes: true,
      });
    } catch (error) {
      if (isMissingPathError(error)) {
        return { files, scannedProjects };
      }
      throw error;
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) {
        continue;
      }
      const root = join(
        this.paths.cursorProjects,
        project.name,
        TRANSCRIPT_DIRECTORY,
      );
      try {
        files.push(
          ...(await listFilesRecursively(root)).filter((path) =>
            /\.(jsonl|txt)$/i.test(path),
          ),
        );
        scannedProjects.add(project.name);
      } catch (error) {
        if (isMissingPathError(error)) {
          // A project that has never produced a transcript.
          scannedProjects.add(project.name);
          continue;
        }
        warnings.push(
          `Unable to enumerate transcripts for ${project.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { files: files.sort((left, right) => left.localeCompare(right)), scannedProjects };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Chat transcripts must be applied by the offline helper.");
  }
}

async function readStableFile(
  root: string,
  relativePath: string,
  path: string,
): Promise<{ content: Buffer; mtimeMs: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await stat(path);
    const content = await readFileWithinRoot(root, relativePath);
    const after = await stat(path);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { content, mtimeMs: after.mtimeMs };
    }
  }
  throw new Error(`Transcript changed while being read: ${path}`);
}

function findDeletions(
  known: Record<string, LocalProjection>,
  current: Set<string>,
  scannedProjects: ReadonlySet<string>,
): ResourceDeletion[] {
  return Object.values(known)
    .filter((projection) => {
      if (
        projection.kind !== "chat-transcript" ||
        current.has(projection.resourceId)
      ) {
        return false;
      }
      const relativePath = decodeURIComponent(
        projection.resourceId.slice("chat-transcript/".length),
      );
      const segments = relativePath.split("/");
      const project = segments[0] ?? "";
      // Only a projection this scan could actually have found is a candidate
      // for deletion: the project has to have been enumerated, and the path has
      // to be in the transcript directory the enumeration covers. Anything else
      // simply stops updating rather than being tombstoned on every device.
      return (
        scannedProjects.has(project) && segments[1] === TRANSCRIPT_DIRECTORY
      );
    })
    .map((projection) => ({
      resourceId: projection.resourceId,
      kind: "chat-transcript",
      semanticHash: sha256(`deleted:${projection.resourceId}`),
      metadata: {
        relativePath: decodeURIComponent(
          projection.resourceId.slice("chat-transcript/".length),
        ),
      },
    }));
}
