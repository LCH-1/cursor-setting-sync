import { afterEach, describe, expect, it } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  enforceBackupRetention,
  pathsEqual,
  type BackupRetentionOptions,
} from "../src/helper/backupRetention";

const temporaryRoots: string[] = [];
const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("local backup retention", () => {
  it("retains only the newest prefix within count, age, and byte limits", async () => {
    const fixture = await createFixture();
    const oldest = await createBackup(fixture.backupRoot, "oldest.vscdb", 4, 8);
    const middle = await createBackup(fixture.backupRoot, "middle.vscdb", 4, 2);
    const newest = await createBackup(fixture.backupRoot, "newest.vscdb", 4, 1);

    const result = await enforceBackupRetention(fixture.storageRoot, {
      maxFiles: 3,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxTotalBytes: 6,
      nowMs: NOW,
    });

    expect(result.retainedPaths).toEqual([newest]);
    expect(result.deletedPaths.map((path) => basename(path))).toEqual([
      "middle.vscdb",
      "oldest.vscdb",
    ]);
    expect(result.retainedBytes).toBe(4);
    expect(result.deletedBytes).toBe(8);
    await expect(readFile(newest)).resolves.toHaveLength(4);
    await expect(lstat(middle)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(oldest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an oversized newest backup and still retains healthy older ones", async () => {
    const fixture = await createFixture();
    const oldest = await createBackup(fixture.backupRoot, "oldest.vscdb", 4, 8);
    const middle = await createBackup(fixture.backupRoot, "middle.vscdb", 4, 2);
    const newest = await createBackup(fixture.backupRoot, "newest.vscdb", 100, 1);

    const result = await enforceBackupRetention(fixture.storageRoot, {
      maxFiles: 3,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxTotalBytes: 10,
      nowMs: NOW,
    });

    expect(result.deletedPaths).toEqual([]);
    expect(result.retainedPaths).toEqual([middle, oldest]);
    expect(result.skipped).toEqual([
      {
        path: newest,
        reason: "The exempt backup is never removed by retention.",
      },
    ]);
    expect(await existing([oldest, middle, newest])).toEqual([
      "middle.vscdb",
      "newest.vscdb",
      "oldest.vscdb",
    ]);
  });

  it("deletes an oversized backup without closing the prefix for later files", async () => {
    const fixture = await createFixture();
    const oldest = await createBackup(fixture.backupRoot, "oldest.vscdb", 1, 8);
    const middle = await createBackup(fixture.backupRoot, "middle.vscdb", 10, 2);
    const newest = await createBackup(fixture.backupRoot, "newest.vscdb", 1, 1);

    const result = await enforceBackupRetention(fixture.storageRoot, {
      maxFiles: 3,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxTotalBytes: 3,
      nowMs: NOW,
    });

    expect(result.retainedPaths).toEqual([newest, oldest]);
    expect(result.deletedPaths).toEqual([middle]);
    expect(result.skipped).toEqual([]);
    expect(await existing([oldest, middle, newest])).toEqual([
      "newest.vscdb",
      "oldest.vscdb",
    ]);
  });

  it("does not let journal sidecars evict the snapshots they belong to", async () => {
    // The shape this was found in: every backup had a `-wal` and a `-shm`
    // written just after it, so newest-first ordering saw the sidecars first
    // and spent the file budget on them. Twenty-two of thirty retained files
    // were sidecars and real recovery points were being deleted to fit.
    const fixture = await createFixture();
    const newest = await createBackup(fixture.backupRoot, "newest.vscdb", 4, 1);
    const newestWal = await createBackup(fixture.backupRoot, "newest.vscdb-wal", 0, 0.99);
    const newestShm = await createBackup(fixture.backupRoot, "newest.vscdb-shm", 8, 0.98);
    const older = await createBackup(fixture.backupRoot, "older.vscdb", 4, 5);
    const olderWal = await createBackup(fixture.backupRoot, "older.vscdb-wal", 0, 4.99);
    const olderShm = await createBackup(fixture.backupRoot, "older.vscdb-shm", 8, 4.98);

    const result = await enforceBackupRetention(fixture.storageRoot, {
      maxFiles: 2,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxTotalBytes: 100,
      nowMs: NOW,
    });

    // Two backups fit in a budget of two, and the sidecars cost nothing.
    expect(result.retainedPaths).toEqual([newest, older]);
    expect(result.deletedPaths.map((path) => basename(path)).sort()).toEqual([
      "newest.vscdb-shm",
      "newest.vscdb-wal",
      "older.vscdb-shm",
      "older.vscdb-wal",
    ]);
    expect(await existing([newest, newestWal, newestShm, older, olderWal, olderShm])).toEqual([
      "newest.vscdb",
      "older.vscdb",
    ]);
  });

  it("removes a sidecar whose database is already gone", async () => {
    const fixture = await createFixture();
    const keep = await createBackup(fixture.backupRoot, "keep.vscdb", 4, 1);
    const ghostWal = await createBackup(fixture.backupRoot, "ghost.vscdb-wal", 0, 0.5);
    const ghostShm = await createBackup(fixture.backupRoot, "ghost.vscdb-shm", 8, 0.4);

    const result = await enforceBackupRetention(fixture.storageRoot, {
      maxFiles: 10,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxTotalBytes: 1_000,
      nowMs: NOW,
    });

    // Nothing was over any limit; the orphans go because they restore nothing.
    expect(result.retainedPaths).toEqual([keep]);
    expect(result.deletedPaths.map((path) => basename(path)).sort()).toEqual([
      "ghost.vscdb-shm",
      "ghost.vscdb-wal",
    ]);
    expect(await existing([keep, ghostWal, ghostShm])).toEqual(["keep.vscdb"]);
  });

  it("keeps a write-ahead log that still has content and charges it to its backup", async () => {
    const fixture = await createFixture();
    const newest = await createBackup(fixture.backupRoot, "newest.vscdb", 4, 1);
    const newestWal = await createBackup(fixture.backupRoot, "newest.vscdb-wal", 16, 0.99);
    const older = await createBackup(fixture.backupRoot, "older.vscdb", 4, 5);
    const olderWal = await createBackup(fixture.backupRoot, "older.vscdb-wal", 16, 4.99);

    const result = await enforceBackupRetention(fixture.storageRoot, {
      maxFiles: 10,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      // Room for one backup and its log, not two.
      maxTotalBytes: 25,
      nowMs: NOW,
    });

    expect(result.retainedPaths.map((path) => basename(path)).sort()).toEqual([
      "newest.vscdb",
      "newest.vscdb-wal",
    ]);
    expect(result.retainedBytes).toBe(20);
    // The older backup and its log are evicted together rather than leaving
    // one without the other.
    expect(result.deletedPaths.map((path) => basename(path)).sort()).toEqual([
      "older.vscdb",
      "older.vscdb-wal",
    ]);
    expect(await existing([newest, newestWal, older, olderWal])).toEqual([
      "newest.vscdb",
      "newest.vscdb-wal",
    ]);
  });

  it("exempts the newest snapshot rather than the newest sidecar", async () => {
    const fixture = await createFixture();
    const newest = await createBackup(fixture.backupRoot, "newest.vscdb", 100, 1);
    await createBackup(fixture.backupRoot, "newest.vscdb-shm", 8, 0.99);

    const result = await enforceBackupRetention(fixture.storageRoot, {
      maxFiles: 3,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxTotalBytes: 10,
      nowMs: NOW,
    });

    expect(result.skipped).toEqual([
      {
        path: newest,
        reason: "The exempt backup is never removed by retention.",
      },
    ]);
    expect(await existing([newest])).toEqual(["newest.vscdb"]);
  });

  it("never deletes an explicitly exempted backup path", async () => {
    const fixture = await createFixture();
    const oldest = await createBackup(fixture.backupRoot, "oldest.vscdb", 1, 8);
    const newest = await createBackup(fixture.backupRoot, "newest.vscdb", 1, 1);

    const result = await enforceBackupRetention(fixture.storageRoot, {
      ...deleteEverythingPolicy(),
      exemptPath: oldest,
    });

    expect(result.retainedPaths).toEqual([]);
    expect(result.deletedPaths).toEqual([newest]);
    expect(result.skipped).toEqual([
      {
        path: oldest,
        reason: "The exempt backup is never removed by retention.",
      },
    ]);
    expect(await existing([oldest, newest])).toEqual(["oldest.vscdb"]);
  });

  it("applies a hard maximum age and maximum file count", async () => {
    const fixture = await createFixture();
    const paths = [
      await createBackup(fixture.backupRoot, "one.db", 1, 1),
      await createBackup(fixture.backupRoot, "two.db", 1, 2),
      await createBackup(fixture.backupRoot, "three.db", 1, 3),
      await createBackup(fixture.backupRoot, "expired.db", 1, 31),
    ];

    const result = await enforceBackupRetention(fixture.storageRoot, {
      maxFiles: 2,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxTotalBytes: 100,
      nowMs: NOW,
    });

    expect(result.retainedPaths.map((path) => basename(path))).toEqual([
      "one.db",
      "two.db",
    ]);
    expect(result.deletedPaths.map((path) => basename(path))).toEqual([
      "three.db",
      "expired.db",
    ]);
    expect(await existing(paths)).toEqual(["one.db", "two.db"]);
  });

  it("never touches a live database or sibling outside the exact backup root", async () => {
    const fixture = await createFixture();
    const liveDatabase = join(fixture.storageRoot, "live-state.vscdb");
    const sibling = join(fixture.root, "outside.db");
    await writeFile(liveDatabase, "live database", "utf8");
    await writeFile(sibling, "outside", "utf8");
    await createBackup(fixture.backupRoot, "delete-me.vscdb", 8, 1);

    await enforceBackupRetention(fixture.storageRoot, deleteEverythingPolicy());

    await expect(readFile(liveDatabase, "utf8")).resolves.toBe("live database");
    await expect(readFile(sibling, "utf8")).resolves.toBe("outside");
  });

  it("does not follow or remove file and directory symbolic links", async () => {
    const fixture = await createFixture();
    const outsideDirectory = join(fixture.root, "outside");
    const outsideFile = join(outsideDirectory, "recovery.db");
    await mkdir(outsideDirectory);
    await writeFile(outsideFile, "outside recovery", "utf8");
    const fileLink = join(fixture.backupRoot, "linked-file.db");
    const directoryLink = join(fixture.backupRoot, "linked-directory");
    if (!(await tryCreateSymlink(outsideFile, fileLink, "file"))) {
      return;
    }
    if (
      !(await tryCreateSymlink(
        outsideDirectory,
        directoryLink,
        process.platform === "win32" ? "junction" : "dir",
      ))
    ) {
      return;
    }

    const result = await enforceBackupRetention(
      fixture.storageRoot,
      deleteEverythingPolicy(),
    );

    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside recovery");
    expect((await lstat(fileLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(directoryLink)).isSymbolicLink()).toBe(true);
    expect(result.skipped.map((entry) => basename(entry.path)).sort()).toEqual([
      "linked-directory",
      "linked-file.db",
    ]);
  });

  it("refuses a backup root that is itself a symbolic link", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-backup-retention-test-"));
    temporaryRoots.push(root);
    const storageRoot = join(root, "extension-storage");
    const outsideDirectory = join(root, "outside-backups");
    await mkdir(storageRoot, { recursive: true });
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, "outside.db"), "outside", "utf8");
    if (
      !(await tryCreateSymlink(
        outsideDirectory,
        join(storageRoot, "backups"),
        process.platform === "win32" ? "junction" : "dir",
      ))
    ) {
      return;
    }

    await expect(
      enforceBackupRetention(storageRoot, deleteEverythingPolicy()),
    ).rejects.toThrow("backup root is not a real directory");
    await expect(
      readFile(join(outsideDirectory, "outside.db"), "utf8"),
    ).resolves.toBe("outside");
  });

  it("is a no-op when no backup directory exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-backup-retention-test-"));
    temporaryRoots.push(root);
    const storageRoot = join(root, "extension-storage");

    const result = await enforceBackupRetention(storageRoot);

    expect(result).toEqual({
      backupRoot: join(storageRoot, "backups"),
      retainedPaths: [],
      deletedPaths: [],
      skipped: [],
      retainedBytes: 0,
      deletedBytes: 0,
    });
  });

  it.each([
    ["maxFiles", -1],
    ["maxFiles", 1.5],
    ["maxAgeMs", Number.POSITIVE_INFINITY],
    ["maxTotalBytes", Number.MAX_SAFE_INTEGER + 1],
    ["nowMs", Number.NaN],
  ] as const)("rejects an unsafe %s policy value", async (key, value) => {
    const fixture = await createFixture();

    await expect(
      enforceBackupRetention(fixture.storageRoot, { [key]: value }),
    ).rejects.toThrow(`${key} must be a non-negative safe integer`);
  });

  it("compares backup paths case-insensitively only on Windows and macOS", () => {
    expect(pathsEqual("backups/Snapshot.vscdb", "backups/snapshot.vscdb", "win32")).toBe(true);
    expect(pathsEqual("backups/Snapshot.vscdb", "backups/snapshot.vscdb", "darwin")).toBe(true);
    expect(pathsEqual("backups/Snapshot.vscdb", "backups/snapshot.vscdb", "linux")).toBe(false);
    expect(pathsEqual("backups/snapshot.vscdb", "backups/snapshot.vscdb", "linux")).toBe(true);
  });
});

async function createFixture(): Promise<{
  root: string;
  storageRoot: string;
  backupRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-backup-retention-test-"));
  temporaryRoots.push(root);
  const storageRoot = join(root, "extension-storage");
  const backupRoot = join(storageRoot, "backups");
  await mkdir(backupRoot, { recursive: true });
  return { root, storageRoot, backupRoot };
}

async function createBackup(
  backupRoot: string,
  name: string,
  bytes: number,
  ageDays: number,
): Promise<string> {
  const path = join(backupRoot, name);
  await writeFile(path, Buffer.alloc(bytes, ageDays));
  const timestamp = new Date(NOW - ageDays * 24 * 60 * 60 * 1_000);
  await utimes(path, timestamp, timestamp);
  return path;
}

async function existing(paths: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    try {
      await lstat(path);
      result.push(basename(path));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return result.sort();
}

function deleteEverythingPolicy(): BackupRetentionOptions {
  return {
    maxFiles: 0,
    maxAgeMs: 0,
    maxTotalBytes: 0,
    nowMs: NOW,
  };
}

async function tryCreateSymlink(
  target: string,
  path: string,
  type: "file" | "dir" | "junction",
): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      return false;
    }
    throw error;
  }
}
