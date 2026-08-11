import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isMissingPathError } from "../platform/files";

export const AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN = 256;
export const AUXILIARY_DIRECTORY_MATCHES_PER_SCAN = 32;
export const AUXILIARY_DIRECTORY_MAX_DEPTH = 64;

export interface BoundedFileTreeAdvanceOptions {
  maxWorkItems: number;
  maxMatches: number;
  maxDirectoryMatches?: number;
  includeFile?: (
    path: string,
    relativePath: string,
    stat: BoundedFileTreeStat,
  ) => boolean;
  includeDirectory?: (path: string, relativePath: string) => boolean;
  descendIntoDirectory?: (path: string, relativePath: string) => boolean;
  onWorkItem?: ((path: string) => void) | undefined;
}

export interface BoundedFileTreeAdvanceResult {
  complete: boolean;
  /** Only matches found in this page. The walker never retains earlier files. */
  files: string[];
  /** Bounded directory matches from this page; traversal still descends. */
  directories: string[];
  /** True only when the root was already absent before traversal began. */
  missing: boolean;
  workItems: number;
  retainedPathCount: number;
}

export interface BoundedFileTreeEntry {
  name: string;
}

export interface BoundedFileTreeStat {
  dev: number;
  ino: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface BoundedFileTreeDirectory {
  read(): Promise<BoundedFileTreeEntry | null>;
  close(): Promise<void>;
}

export interface BoundedFileTreeFileSystem {
  lstat(path: string): Promise<BoundedFileTreeStat>;
  realpath(path: string): Promise<string>;
  opendir(path: string): Promise<BoundedFileTreeDirectory>;
}

export class BoundedFileTreeWalkError extends Error {
  constructor(
    readonly workItems: number,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BoundedFileTreeWalkError";
  }
}

interface DirectoryCursor {
  path: string;
  handle: BoundedFileTreeDirectory;
}

interface FileTreeState {
  rootPath: string;
  canonicalRoot: string;
  rootStat: BoundedFileTreeStat;
  directories: DirectoryCursor[];
  pendingDirectory: string | null;
  completePending: boolean;
}

/**
 * Resumable, security-checked depth-first traversal with fixed retained state.
 *
 * Parent directory handles keep their native cursors while a child is visited,
 * so the walker retains only the current depth (capped at 64), one pending
 * child path, and the bounded matches returned by this call. It never builds a
 * file list for the whole tree and completion performs no sort or flatten.
 * `opendir` uses a one-entry native buffer, keeping hidden native allocation in
 * the same envelope as the explicit work budget.
 */
export class BoundedFileTreeWalker {
  private readonly states = new Map<string, FileTreeState>();
  private progressRevision = 0;

  constructor(
    private readonly filesystem: BoundedFileTreeFileSystem =
      NODE_FILE_TREE_FILESYSTEM,
  ) {}

  async advance(
    root: string,
    options: BoundedFileTreeAdvanceOptions,
  ): Promise<BoundedFileTreeAdvanceResult> {
    assertPositiveLimit(options.maxWorkItems, "Directory traversal work");
    assertPositiveLimit(options.maxMatches, "Directory traversal match");
    if (options.maxDirectoryMatches !== undefined) {
      assertPositiveLimit(
        options.maxDirectoryMatches,
        "Directory traversal directory-match",
      );
    }
    const rootPath = resolve(root);
    const files: string[] = [];
    const directories: string[] = [];
    let workItems = 0;
    let state = this.states.get(rootPath);
    const startingProgressRevision = this.progressRevision;
    try {
      if (state === undefined) {
        options.onWorkItem?.(rootPath);
        workItems += 1;
        let rootStat: BoundedFileTreeStat;
        try {
          rootStat = await this.filesystem.lstat(rootPath);
        } catch (error) {
          if (isMissingPathError(error)) {
            this.progressRevision += 1;
            return {
              complete: true,
              files,
              directories,
              missing: true,
              workItems,
              retainedPathCount: 0,
            };
          }
          throw error;
        }
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
          throw new Error(
            `Recursive file root must be a real directory: ${rootPath}`,
          );
        }
        state = {
          rootPath,
          canonicalRoot: await this.filesystem.realpath(rootPath),
          rootStat,
          directories: [],
          pendingDirectory: rootPath,
          completePending: false,
        };
        this.states.set(rootPath, state);
        this.progressRevision += 1;
      }

      while (
        workItems < options.maxWorkItems &&
        files.length < options.maxMatches &&
        directories.length < (options.maxDirectoryMatches ?? Infinity)
      ) {
        if (state.completePending) {
          options.onWorkItem?.(state.rootPath);
          workItems += 1;
          await assertSameDirectory(
            this.filesystem,
            state.rootPath,
            state.rootStat,
          );
          await assertCanonicalPathInside(
            this.filesystem,
            state.canonicalRoot,
            state.rootPath,
          );
          this.states.delete(rootPath);
          this.progressRevision += 1;
          return {
            complete: true,
            files,
            directories,
            missing: false,
            workItems,
            retainedPathCount: 0,
          };
        }

        if (state.pendingDirectory !== null) {
          const directory = state.pendingDirectory;
          options.onWorkItem?.(directory);
          workItems += 1;
          if (state.directories.length >= AUXILIARY_DIRECTORY_MAX_DEPTH) {
            throw new Error(
              `Recursive file tree exceeds the ${AUXILIARY_DIRECTORY_MAX_DEPTH}-directory depth limit: ${rootPath}`,
            );
          }
          const directoryStat = await this.filesystem.lstat(directory);
          if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
            throw new Error(
              `Recursive file path changed into a link or non-directory: ${directory}`,
            );
          }
          await assertCanonicalPathInside(
            this.filesystem,
            state.canonicalRoot,
            directory,
          );
          state.directories.push({
            path: directory,
            handle: await this.filesystem.opendir(directory),
          });
          state.pendingDirectory = null;
          this.progressRevision += 1;
          continue;
        }

        const active = state.directories.at(-1);
        if (active === undefined) {
          state.completePending = true;
          continue;
        }
        options.onWorkItem?.(active.path);
        workItems += 1;
        const entry = await active.handle.read();
        if (entry === null) {
          await closeDirectory(active.handle);
          state.directories.pop();
          if (state.directories.length === 0) {
            state.completePending = true;
          }
          this.progressRevision += 1;
          continue;
        }
        const child = resolve(active.path, entry.name);
        const childStat = await this.filesystem.lstat(child);
        if (childStat.isSymbolicLink()) {
          // The native directory cursor advanced successfully even though
          // policy excludes this entry. Count that durable forward position.
          this.progressRevision += 1;
          continue;
        }
        await assertCanonicalPathInside(
          this.filesystem,
          state.canonicalRoot,
          child,
        );
        const relativePath = relative(state.rootPath, child);
        if (childStat.isDirectory()) {
          if (options.descendIntoDirectory?.(child, relativePath) ?? true) {
            state.pendingDirectory = child;
          }
          if (options.includeDirectory?.(child, relativePath) ?? false) {
            directories.push(child);
          }
        } else if (
          childStat.isFile() &&
          (options.includeFile?.(child, relativePath, childStat) ?? true)
        ) {
          files.push(child);
        }
        this.progressRevision += 1;
      }

      return {
        complete: false,
        files,
        directories,
        missing: false,
        workItems,
        retainedPathCount: retainedPathCount(state),
      };
    } catch (error) {
      try {
        await this.discard(rootPath);
      } catch (closeError) {
        // The whole cursor state is discarded below, so none of the successful
        // prefix work from this call remains durable. Do not let a permanently
        // failing suffix manufacture a new helper progress token on every
        // retry.
        this.progressRevision = startingProgressRevision;
        throw new BoundedFileTreeWalkError(workItems, closeError);
      }
      this.progressRevision = startingProgressRevision;
      throw new BoundedFileTreeWalkError(workItems, error);
    }
  }

  retainedPathCount(root?: string): number {
    if (root !== undefined) {
      const state = this.states.get(resolve(root));
      return state === undefined ? 0 : retainedPathCount(state);
    }
    let count = 0;
    for (const state of this.states.values()) {
      count += retainedPathCount(state);
    }
    return count;
  }

  /** Process-local monotonic cursor proof; directory retries do not advance. */
  progressToken(): number {
    return this.progressRevision;
  }

  async discard(root: string): Promise<void> {
    const rootPath = resolve(root);
    const state = this.states.get(rootPath);
    this.states.delete(rootPath);
    if (state !== undefined) {
      await Promise.all(
        state.directories.map((directory) =>
          closeDirectory(directory.handle),
        ),
      );
    }
  }

  async discardExcept(roots: ReadonlySet<string>): Promise<void> {
    const retained = new Set([...roots].map((root) => resolve(root)));
    await Promise.all(
      [...this.states.keys()]
        .filter((root) => !retained.has(root))
        .map((root) => this.discard(root)),
    );
  }

  async clear(): Promise<void> {
    await Promise.all([...this.states.keys()].map((root) => this.discard(root)));
  }
}

function retainedPathCount(state: FileTreeState): number {
  return state.directories.length + (state.pendingDirectory === null ? 0 : 1);
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} limit must be a positive integer.`);
  }
}

async function assertCanonicalPathInside(
  filesystem: BoundedFileTreeFileSystem,
  canonicalRoot: string,
  path: string,
): Promise<void> {
  const canonicalPath = await filesystem.realpath(path);
  const relativePath = relative(canonicalRoot, canonicalPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Filesystem path resolves outside its synchronized root: ${path}`);
  }
}

async function assertSameDirectory(
  filesystem: BoundedFileTreeFileSystem,
  path: string,
  expected: BoundedFileTreeStat,
): Promise<void> {
  const current = await filesystem.lstat(path);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    expected.dev !== current.dev ||
    expected.ino !== current.ino
  ) {
    throw new Error(`Recursive file root changed while being checked: ${path}`);
  }
}

async function closeDirectory(directory: BoundedFileTreeDirectory): Promise<void> {
  try {
    await directory.close();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ERR_DIR_CLOSED"
    ) {
      throw error;
    }
  }
}

const NODE_FILE_TREE_FILESYSTEM: BoundedFileTreeFileSystem = {
  lstat: async (path) => lstat(path),
  realpath: async (path) => realpath(path),
  opendir: async (path) => opendir(path, { bufferSize: 1 }),
};
