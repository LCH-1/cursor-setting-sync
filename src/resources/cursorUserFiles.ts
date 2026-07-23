import { relative } from "node:path";
import type {
  JsonValue,
  LocalProjection,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeRelativePath,
  isCaseInsensitivePathPlatform,
  listFilesRecursively,
  normalizeResourcePath,
  pathExists,
  readFileWithinRoot,
  removeFileWithinRoot,
  writeFileAtomicWithinRoot,
} from "../platform/files";
import { sha256 } from "../protocol/canonical";
import type {
  ResourceAdapter,
  ResourceApplyInput,
  ResourceApplyResult,
} from "./resource";
import { isDeletion } from "./resource";
import { parseJsonc } from "./jsonc";

export class CursorUserFilesAdapter implements ResourceAdapter {
  readonly id = "cursor-user-files";
  readonly kinds = ["cursor-user-file"] as const;
  readonly appliesWhileRunning = true;

  // Canonical relative paths (for example "mcp.json") that are neither
  // published nor applied, so secret-bearing files can be kept local. On
  // case-insensitive platforms the entries are case-folded so a configured
  // entry matches regardless of on-disk casing; on Linux paths differing only
  // in case are distinct files, so matching is exact.
  constructor(
    private readonly paths: CursorPaths,
    private readonly ignoredFiles: ReadonlySet<string> = new Set(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const unscannedPrefixes = new Set<string>();
    const paths = await this.discoverFiles(warnings, unscannedPrefixes);
    const current = new Set<string>();
    const caseMap = new Map<string, string>();

    for (const path of paths) {
      const relativePath = normalizeResourcePath(relative(this.paths.cursorHome, path));
      const caseKey = foldResourcePathCase(relativePath, this.platform);
      if (this.ignoredFiles.has(caseKey)) {
        continue;
      }
      const previous = caseMap.get(caseKey);
      const resourceId = cursorUserResourceId(relativePath);
      if (previous !== undefined && previous !== relativePath) {
        warnings.push(`Case-insensitive path conflict: ${previous} and ${relativePath}`);
        current.add(resourceId);
        current.add(cursorUserResourceId(previous));
        continue;
      }
      caseMap.set(caseKey, relativePath);
      current.add(resourceId);
      try {
        const content = await readFileWithinRoot(
          this.paths.cursorHome,
          relativePath,
        );
        if (relativePath === "mcp.json" || relativePath === "cli-config.json") {
          parseJsonc(content.toString("utf8"), path);
        }
        snapshots.push({
          resourceId,
          kind: "cursor-user-file",
          content,
          semanticHash: sha256(content),
          metadata: { relativePath },
        });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      snapshots,
      deletions: findDeletions(
        known,
        current,
        unscannedPrefixes,
        this.ignoredFiles,
        this.platform,
      ),
      warnings,
    };
  }

  async apply(input: ResourceApplyInput): Promise<ResourceApplyResult> {
    const relativePath = metadataString(input.metadata, "relativePath");
    if (input.resourceId !== cursorUserResourceId(relativePath)) {
      throw new Error(`Cursor user metadata does not match ${input.resourceId}.`);
    }
    if (!isAllowedCursorRelativePath(relativePath)) {
      throw new Error(`Cursor user path is not allowlisted: ${relativePath}`);
    }
    assertSafeRelativePath(this.paths.cursorHome, relativePath);
    if (this.ignoredFiles.has(foldResourcePathCase(relativePath, this.platform))) {
      return {
        status: "retained-local",
        semanticHash: await this.localSemanticHash(relativePath, input.resourceId),
      };
    }
    if (isDeletion(input)) {
      await removeFileWithinRoot(this.paths.cursorHome, relativePath);
      return;
    }
    if (relativePath === "mcp.json" || relativePath === "cli-config.json") {
      parseJsonc(input.content.toString("utf8"), input.resourceId);
    }
    await writeFileAtomicWithinRoot(
      this.paths.cursorHome,
      relativePath,
      input.content,
    );
  }

  private async localSemanticHash(
    relativePath: string,
    resourceId: string,
  ): Promise<string> {
    try {
      return sha256(
        await readFileWithinRoot(this.paths.cursorHome, relativePath),
      );
    } catch {
      // An ignored file that cannot be read locally is projected with the
      // deletion marker used for absent resources.
      return sha256(`deleted:${resourceId}`);
    }
  }

  private async discoverFiles(
    warnings: string[],
    unscannedPrefixes: Set<string>,
  ): Promise<string[]> {
    const files: string[] = [];
    for (const path of [this.paths.cursorMcp, this.paths.cursorCliConfig]) {
      if (await pathExists(path)) {
        files.push(path);
      }
    }
    for (const root of [
      this.paths.cursorCommands,
      this.paths.cursorSkills,
      this.paths.cursorRules,
    ]) {
      try {
        files.push(...(await listFilesRecursively(root)));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        unscannedPrefixes.add(
          normalizeResourcePath(relative(this.paths.cursorHome, root)),
        );
      }
    }
    return files.sort((left, right) => left.localeCompare(right));
  }
}

export function normalizeIgnoredUserFiles(
  entries: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const entry of entries) {
    try {
      let path = normalizeResourcePath(entry);
      if (path.startsWith("./")) {
        path = path.slice(2);
      }
      path = path.replace(/\/+$/, "");
      if (path.length === 0) {
        continue;
      }
      normalized.add(foldResourcePathCase(path, platform));
    } catch {
      // A malformed ignore entry must not break adapter construction.
    }
  }
  return normalized;
}

function foldResourcePathCase(path: string, platform: NodeJS.Platform): string {
  return isCaseInsensitivePathPlatform(platform)
    ? path.toLocaleLowerCase("en-US")
    : path;
}

function cursorUserResourceId(relativePath: string): string {
  return `cursor-user-file/${encodeURIComponent(relativePath)}`;
}

function findDeletions(
  known: Record<string, LocalProjection>,
  current: Set<string>,
  unscannedPrefixes: ReadonlySet<string>,
  ignoredFiles: ReadonlySet<string>,
  platform: NodeJS.Platform,
): ResourceDeletion[] {
  return Object.values(known)
    .filter((projection) => {
      if (
        projection.kind !== "cursor-user-file" ||
        current.has(projection.resourceId)
      ) {
        return false;
      }
      const relativePath = decodeURIComponent(
        projection.resourceId.slice("cursor-user-file/".length),
      );
      return (
        !ignoredFiles.has(foldResourcePathCase(relativePath, platform)) &&
        !isInUnscannedPrefix(relativePath, unscannedPrefixes)
      );
    })
    .map((projection) => {
      const encoded = projection.resourceId.slice("cursor-user-file/".length);
      const relativePath = decodeURIComponent(encoded);
      return {
        resourceId: projection.resourceId,
        kind: "cursor-user-file",
        semanticHash: sha256(`deleted:${projection.resourceId}`),
        metadata: { relativePath },
      };
    });
}

function isInUnscannedPrefix(
  relativePath: string,
  unscannedPrefixes: ReadonlySet<string>,
): boolean {
  for (const prefix of unscannedPrefixes) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function isAllowedCursorRelativePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return (
    relativePath === "mcp.json" ||
    relativePath === "cli-config.json" ||
    (segments.length > 1 &&
      ["commands", "skills", "rules"].includes(segments[0] ?? ""))
  );
}

function metadataString(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string {
  const value = metadata?.[key];
  if (typeof value !== "string") {
    throw new Error(`Resource metadata is missing ${key}.`);
  }
  return value;
}
