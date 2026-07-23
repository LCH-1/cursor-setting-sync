import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type {
  LocalProjection,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  listFilesRecursively,
  normalizeResourcePath,
  readFileWithinRoot,
} from "../platform/files";
import { sha256 } from "../protocol/canonical";
import type { ResourceAdapter, ResourceApplyInput } from "../resources/resource";

export class ChatTranscriptsAdapter implements ResourceAdapter {
  readonly id = "chat-transcripts";
  readonly kinds = ["chat-transcript"] as const;
  readonly appliesWhileRunning = false;

  constructor(private readonly paths: CursorPaths) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const current = new Set<string>();
    const files = (await listFilesRecursively(this.paths.cursorProjects)).filter(
      (path) =>
        /[\\/]agent-transcripts[\\/]/i.test(path) && /\.(jsonl|txt)$/i.test(path),
    );
    for (const path of files) {
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
      deletions: findDeletions(known, current),
      warnings,
    };
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
): ResourceDeletion[] {
  return Object.values(known)
    .filter(
      (projection) =>
        projection.kind === "chat-transcript" &&
        !current.has(projection.resourceId),
    )
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
