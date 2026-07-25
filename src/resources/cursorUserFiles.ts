import { relative } from "node:path";
import { stat } from "node:fs/promises";
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
import type { IgnoreMatcher } from "./ignorePatterns";
import { createIgnoreMatcher } from "./ignorePatterns";

/** One remembered file: the identity that proves it, plus what it produced. */
interface UserFileMemo {
  size: number;
  mtimeMs: number;
  content: Buffer;
  semanticHash: string;
}

/**
 * Bounds on what the scan memo keeps in memory. A single oversized file, or a
 * very large skills tree, falls back to re-reading rather than growing the
 * extension host without limit.
 */
const MAX_MEMO_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MEMO_TOTAL_BYTES = 64 * 1024 * 1024;

export class CursorUserFilesAdapter implements ResourceAdapter {
  readonly id = "cursor-user-files";
  readonly kinds = ["cursor-user-file"] as const;
  readonly appliesWhileRunning = true;

  /**
   * Files whose size and mtime are unchanged since the previous scan.
   *
   * This adapter runs on the 30-second files poll and used to re-run the
   * hardened path walk (an lstat and a realpath per path segment), a full read
   * and a sha256 for every file under ~/.cursor/{commands,skills,rules} every
   * time, producing an identical answer. A skills tree of a few hundred files
   * made that minutes of pointless IO per hour. Every other frequently polled
   * adapter here already memoizes on mtime; this one now does too.
   */
  private readonly scanMemo = new Map<string, UserFileMemo>();
  private memoBytes = 0;

  // Relative paths that are neither published nor applied, so secret-bearing
  // files can be kept local. Entries may be a canonical path ("mcp.json"), a
  // directory covering everything under it ("rules"), or a glob
  // ("skills/**/secret.md"). On case-insensitive platforms the entries are
  // case-folded so a configured entry matches regardless of on-disk casing; on
  // Linux paths differing only in case are distinct files, so case matters.
  constructor(
    private readonly paths: CursorPaths,
    private readonly ignoredFiles: IgnoreMatcher = createIgnoreMatcher([]),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const unscannedPrefixes = new Set<string>();
    const paths = await this.discoverFiles(warnings, unscannedPrefixes);
    const current = new Set<string>();
    const caseMap = new Map<string, string>();
    const observedPaths = new Set<string>();
    const memoized = new Set<string>();

    for (const path of paths) {
      const relativePath = normalizeResourcePath(relative(this.paths.cursorHome, path));
      const caseKey = foldResourcePathCase(relativePath, this.platform);
      observedPaths.add(caseKey);
      if (this.ignoredFiles.matches(caseKey)) {
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
        const info = await fileIdentity(path);
        const memo = this.scanMemo.get(relativePath);
        if (
          info !== null &&
          memo !== undefined &&
          memo.size === info.size &&
          memo.mtimeMs === info.mtimeMs
        ) {
          snapshots.push({
            resourceId,
            kind: "cursor-user-file",
            content: memo.content,
            semanticHash: memo.semanticHash,
            metadata: { relativePath },
          });
          memoized.add(relativePath);
          continue;
        }
        const content = await readFileWithinRoot(
          this.paths.cursorHome,
          relativePath,
        );
        if (relativePath === "mcp.json" || relativePath === "cli-config.json") {
          parseJsonc(content.toString("utf8"), path);
        }
        const semantic = sha256(content);
        if (info !== null) {
          this.remember(relativePath, {
            size: info.size,
            mtimeMs: info.mtimeMs,
            content,
            semanticHash: semantic,
          });
          memoized.add(relativePath);
        }
        snapshots.push({
          resourceId,
          kind: "cursor-user-file",
          content,
          semanticHash: semantic,
          metadata: { relativePath },
        });
      } catch (error) {
        this.forget(relativePath);
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    // Files that vanished, or that this scan could not enumerate, must not keep
    // occupying the memo.
    for (const relativePath of [...this.scanMemo.keys()]) {
      if (!memoized.has(relativePath)) {
        this.forget(relativePath);
      }
    }

    // Silence here means the user believes a private file is excluded when it
    // is still being published, so an entry that matched nothing is reported.
    // It is deliberately not phrased as "your file is being published": the
    // same entry matches nothing when the file simply does not exist yet,
    // which is the normal case for someone who excludes mcp.json up front.
    for (const pattern of this.ignoredFiles.unmatched(observedPaths)) {
      warnings.push(
        `cursorSettingSync.ignoredUserFiles entry "${pattern}" matched no file under the Cursor home directory, so it is excluding nothing. That is expected if the file does not exist yet; otherwise correct the pattern.`,
      );
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
    if (this.ignoredFiles.matches(foldResourcePathCase(relativePath, this.platform))) {
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

  private remember(relativePath: string, memo: UserFileMemo): void {
    this.forget(relativePath);
    if (
      memo.content.byteLength > MAX_MEMO_FILE_BYTES ||
      this.memoBytes + memo.content.byteLength > MAX_MEMO_TOTAL_BYTES
    ) {
      return;
    }
    this.scanMemo.set(relativePath, memo);
    this.memoBytes += memo.content.byteLength;
  }

  private forget(relativePath: string): void {
    const memo = this.scanMemo.get(relativePath);
    if (memo === undefined) {
      return;
    }
    this.scanMemo.delete(relativePath);
    this.memoBytes -= memo.content.byteLength;
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

/**
 * Builds the `ignoredUserFiles` matcher. Entries are relative Cursor-home
 * paths: `mcp.json`, a directory such as `rules` or `rules/` (which now really
 * does cover everything under it), or a glob such as `rules/*.md`. On Windows
 * and macOS the comparison folds case, the way the filesystem does.
 */
export function normalizeIgnoredUserFiles(
  entries: readonly string[],
  platform: NodeJS.Platform = process.platform,
): IgnoreMatcher {
  const normalized: string[] = [];
  for (const entry of entries) {
    try {
      let path = normalizeResourcePath(entry);
      if (path.startsWith("./")) {
        path = path.slice(2);
      }
      if (path.replace(/\/+$/, "").length === 0) {
        continue;
      }
      normalized.push(path);
    } catch {
      // A malformed ignore entry must not break adapter construction.
    }
  }
  return createIgnoreMatcher(normalized, {
    separator: "/",
    caseFold: isCaseInsensitivePathPlatform(platform),
  });
}

async function fileIdentity(
  path: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    // Without an identity the file is simply read the slow way.
    return null;
  }
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
  ignoredFiles: IgnoreMatcher,
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
        !ignoredFiles.matches(foldResourcePathCase(relativePath, platform)) &&
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
