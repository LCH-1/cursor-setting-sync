import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acquireFileLock } from "../src/platform/lock";

interface StoredLock {
  pid: number;
  token: string;
  createdAt: string;
}

const renameHook = vi.hoisted(() => ({
  beforeRename: null as (() => Promise<void>) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ): Promise<void> => {
      const hook = renameHook.beforeRename;
      if (hook !== null) {
        renameHook.beforeRename = null;
        await hook();
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

function lockJson(token: string): string {
  return JSON.stringify({
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  });
}

async function ageFile(path: string, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs);
  await utimes(path, past, past);
}

describe("file lock", () => {
  beforeEach(() => {
    renameHook.beforeRename = null;
  });

  it("acquires a free lock and removes it on release", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      const lock = await acquireFileLock(path);
      if (lock === null) {
        throw new Error("Expected the free lock to be acquired.");
      }
      const stored = JSON.parse(await readFile(path, "utf8")) as StoredLock;
      expect(stored.pid).toBe(process.pid);

      await lock.release();
      await expect(readFile(path, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null while another live holder heartbeats", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      await writeFile(path, lockJson("holder"), "utf8");

      expect(await acquireFileLock(path)).toBeNull();
      const stored = JSON.parse(await readFile(path, "utf8")) as StoredLock;
      expect(stored.token).toBe("holder");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a live lock whose heartbeat is ten minutes old", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      await writeFile(path, lockJson("holder"), "utf8");
      await ageFile(path, 10 * 60_000);

      expect(await acquireFileLock(path)).toBeNull();
      const stored = JSON.parse(await readFile(path, "utf8")) as StoredLock;
      expect(stored.token).toBe("holder");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("takes over a lock idle past the TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      await writeFile(path, lockJson("stale"), "utf8");
      await ageFile(path, 16 * 60_000);

      const lock = await acquireFileLock(path);
      if (lock === null) {
        throw new Error("Expected the stale lock to be taken over.");
      }
      const stored = JSON.parse(await readFile(path, "utf8")) as StoredLock;
      expect(stored.token).not.toBe("stale");
      expect(stored.pid).toBe(process.pid);
      await lock.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("takes over a corrupt lock file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      await writeFile(path, "not json", "utf8");

      const lock = await acquireFileLock(path);
      if (lock === null) {
        throw new Error("Expected the corrupt lock to be taken over.");
      }
      const stored = JSON.parse(await readFile(path, "utf8")) as StoredLock;
      expect(stored.pid).toBe(process.pid);
      await lock.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a lock recreated between the staleness check and the rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      await writeFile(path, lockJson("stale"), "utf8");
      await ageFile(path, 16 * 60_000);

      // Another contender wins the race: it replaces the stale lock with its
      // own fresh one right before this contender's takeover rename runs.
      renameHook.beforeRename = async () => {
        await writeFile(path, lockJson("fresh"), "utf8");
      };

      expect(await acquireFileLock(path)).toBeNull();
      const stored = JSON.parse(await readFile(path, "utf8")) as StoredLock;
      expect(stored.token).toBe("fresh");
      expect(await readdir(root)).toEqual(["sync.lock"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refresh synchronously renews the heartbeat", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      const lock = await acquireFileLock(path);
      if (lock === null) {
        throw new Error("Expected the free lock to be acquired.");
      }
      await ageFile(path, 10 * 60_000);

      lock.refresh();

      const refreshed = await stat(path);
      expect(Date.now() - refreshed.mtimeMs).toBeLessThan(60_000);
      await lock.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refresh leaves a lock owned by another holder untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      const lock = await acquireFileLock(path);
      if (lock === null) {
        throw new Error("Expected the free lock to be acquired.");
      }
      await writeFile(path, lockJson("other"), "utf8");
      await ageFile(path, 10 * 60_000);

      lock.refresh();

      const untouched = await stat(path);
      expect(Date.now() - untouched.mtimeMs).toBeGreaterThan(9 * 60_000);
      await lock.release();
      const stored = JSON.parse(await readFile(path, "utf8")) as StoredLock;
      expect(stored.token).toBe("other");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
