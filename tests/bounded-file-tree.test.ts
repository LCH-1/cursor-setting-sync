import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  BoundedFileTreeWalker,
  type BoundedFileTreeDirectory,
  type BoundedFileTreeFileSystem,
  type BoundedFileTreeStat,
} from "../src/chat/boundedFileTree";

describe("bounded resumable file-tree traversal", () => {
  it("streams 10k matches without retaining the tree or spiking at completion", async () => {
    const root = resolve(join("virtual", "transcripts"));
    const entryCount = 10_001;
    const entries = Array.from(
      { length: entryCount },
      (_, index) => `${index.toString().padStart(5, "0")}.jsonl`,
    );
    const filesystem = fakeFlatFileSystem(root, entries);
    const walker = new BoundedFileTreeWalker(filesystem);
    const published = new Set<string>();
    let callbacks = 0;
    let maxReturned = 0;
    let maxRetained = 0;
    let complete = false;

    for (let pass = 0; pass < 2_000 && !complete; pass += 1) {
      const before = callbacks;
      const page = await walker.advance(root, {
        maxWorkItems: 37,
        maxMatches: 13,
        includeFile: (path) => path.endsWith(".jsonl"),
        onWorkItem: () => {
          callbacks += 1;
        },
      });
      expect(callbacks - before).toBeLessThanOrEqual(37);
      expect(page.workItems).toBeLessThanOrEqual(37);
      expect(page.files.length).toBeLessThanOrEqual(13);
      expect(page.retainedPathCount).toBeLessThanOrEqual(1);
      expect(walker.retainedPathCount()).toBeLessThanOrEqual(1);
      maxReturned = Math.max(maxReturned, page.files.length);
      maxRetained = Math.max(maxRetained, page.retainedPathCount);
      page.files.forEach((path) => published.add(path));
      complete = page.complete;
    }

    expect(complete).toBe(true);
    expect(published.size).toBe(entryCount);
    expect(maxReturned).toBe(13);
    expect(maxRetained).toBe(1);
    expect(walker.retainedPathCount()).toBe(0);

    // The adapter owns the refresh schedule. Once the completed generation is
    // settled it does not call the walker again until that schedule expires.
    const beforeIdle = callbacks;
    expect(complete).toBe(true);
    expect(callbacks).toBe(beforeIdle);
  });

  it("pages 10k top-level roots without retaining a root-name set", async () => {
    const root = resolve(join("virtual", "workspace-storage"));
    const directoryCount = 10_003;
    const entries = Array.from(
      { length: directoryCount },
      (_, index) => `workspace-${index.toString().padStart(5, "0")}`,
    );
    const walker = new BoundedFileTreeWalker(
      fakeTopLevelDirectoryFileSystem(root, entries),
    );
    const publishedRoots = new Set<string>();
    let callbacks = 0;
    let complete = false;

    for (let pass = 0; pass < 2_000 && !complete; pass += 1) {
      const before = callbacks;
      const page = await walker.advance(root, {
        maxWorkItems: 41,
        maxMatches: 1,
        maxDirectoryMatches: 11,
        includeFile: () => false,
        includeDirectory: () => true,
        onWorkItem: () => {
          callbacks += 1;
        },
      });
      expect(callbacks - before).toBeLessThanOrEqual(41);
      expect(page.files).toEqual([]);
      expect(page.directories.length).toBeLessThanOrEqual(11);
      expect(page.retainedPathCount).toBeLessThanOrEqual(2);
      expect(walker.retainedPathCount()).toBeLessThanOrEqual(2);
      page.directories.forEach((path) => publishedRoots.add(path));
      complete = page.complete;
    }

    expect(complete).toBe(true);
    expect(publishedRoots.size).toBe(directoryCount);
    expect(walker.retainedPathCount()).toBe(0);
    const beforeIdle = callbacks;
    expect(callbacks).toBe(beforeIdle);
  });

  it("counts skipped symlinks as real cursor progress until a valid tail entry", async () => {
    const root = resolve(join("virtual", "symlink-prefix"));
    const entries = [
      ...Array.from({ length: 80 }, (_, index) => `link-${index}`),
      "tail.jsonl",
    ];
    const base = fakeFlatFileSystem(root, entries);
    const filesystem: BoundedFileTreeFileSystem = {
      ...base,
      lstat: async (path) =>
        path === root
          ? fakeStat("directory", 1)
          : path.endsWith("tail.jsonl")
            ? fakeStat("file", 2)
            : fakeSymlinkStat(),
    };
    const walker = new BoundedFileTreeWalker(filesystem);
    let previousToken = walker.progressToken();
    let foundTail = false;

    for (let pass = 0; pass < 100 && !foundTail; pass += 1) {
      const page = await walker.advance(root, {
        maxWorkItems: 3,
        maxMatches: 1,
        includeFile: (path) => path.endsWith(".jsonl"),
      });
      expect(walker.progressToken()).toBeGreaterThan(previousToken);
      previousToken = walker.progressToken();
      foundTail = page.files.some((path) => path.endsWith("tail.jsonl"));
    }

    expect(foundTail).toBe(true);
  });

  it("rolls progress back when a later child failure discards the whole cursor", async () => {
    const root = resolve(join("virtual", "failing-suffix"));
    const entries = ["prefix.jsonl", "broken.jsonl"];
    const base = fakeFlatFileSystem(root, entries);
    const filesystem: BoundedFileTreeFileSystem = {
      ...base,
      lstat: async (path) => {
        if (path.endsWith("broken.jsonl")) {
          throw new Error("permanent lstat failure");
        }
        return path === root ? fakeStat("directory", 1) : fakeStat("file", 2);
      },
    };
    const walker = new BoundedFileTreeWalker(filesystem);

    for (let retry = 0; retry < 3; retry += 1) {
      await expect(
        walker.advance(root, {
          maxWorkItems: 16,
          maxMatches: 16,
          includeFile: () => true,
        }),
      ).rejects.toThrow("permanent lstat failure");
      expect(walker.progressToken()).toBe(0);
      expect(walker.retainedPathCount()).toBe(0);
    }
  });
});

function fakeFlatFileSystem(
  root: string,
  entries: readonly string[],
): BoundedFileTreeFileSystem {
  const rootStat = fakeStat("directory", 1);
  const fileStat = fakeStat("file", 2);
  return {
    lstat: async (path) => (path === root ? rootStat : fileStat),
    realpath: async (path) => path,
    opendir: async (path) => {
      if (path !== root) {
        throw new Error(`Unexpected fake directory: ${path}`);
      }
      let index = 0;
      let closed = false;
      const directory: BoundedFileTreeDirectory = {
        read: async () => {
          if (closed) {
            throw new Error("Fake directory is closed.");
          }
          const name = entries[index];
          if (name === undefined) {
            return null;
          }
          index += 1;
          return { name };
        },
        close: async () => {
          closed = true;
        },
      };
      return directory;
    },
  };
}

function fakeTopLevelDirectoryFileSystem(
  root: string,
  entries: readonly string[],
): BoundedFileTreeFileSystem {
  const directoryStat = fakeStat("directory", 1);
  return {
    lstat: async () => directoryStat,
    realpath: async (path) => path,
    opendir: async (path) => {
      let index = 0;
      let closed = false;
      return {
        read: async () => {
          if (closed) {
            throw new Error("Fake directory is closed.");
          }
          if (path !== root) {
            return null;
          }
          const name = entries[index];
          if (name === undefined) {
            return null;
          }
          index += 1;
          return { name };
        },
        close: async () => {
          closed = true;
        },
      };
    },
  };
}

function fakeStat(
  kind: "directory" | "file",
  inode: number,
): BoundedFileTreeStat {
  return {
    dev: 1,
    ino: inode,
    isSymbolicLink: () => false,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
  };
}

function fakeSymlinkStat(): BoundedFileTreeStat {
  return {
    dev: 1,
    ino: 3,
    isSymbolicLink: () => true,
    isDirectory: () => false,
    isFile: () => false,
  };
}
