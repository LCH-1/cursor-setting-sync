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
import { acquireFileLock, acquireFileLockWithin } from "../src/platform/lock";

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

  it("leaves a fresh unreadable lock file alone", async () => {
    // An unreadable lock is usually another process caught in the
    // milliseconds between its open("wx") and its writeFile. Taking it over
    // on unreadability alone stole locks mid-creation, and the post-rename
    // isSameLock(null, null) check confirmed the theft - two windows then
    // both believed they held the lock and ran full cycles concurrently.
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      await writeFile(path, "not json", "utf8");

      expect(await acquireFileLock(path)).toBeNull();
      expect(await readFile(path, "utf8")).toBe("not json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("takes over an unreadable lock file only after the TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      await writeFile(path, "not json", "utf8");
      const past = new Date(Date.now() - 16 * 60_000);
      await utimes(path, past, past);

      const lock = await acquireFileLock(path);
      if (lock === null) {
        throw new Error("Expected the stale corrupt lock to be taken over.");
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

  it("refresh reports the loss of a lock another holder took over", async () => {
    // A displaced holder must ABORT, not write blind: silently returning on
    // a foreign token let a stale-takeover race leave two processes each
    // convinced they held the mutex. The foreign lock's bytes stay untouched.
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      const lock = await acquireFileLock(path);
      if (lock === null) {
        throw new Error("Expected the free lock to be acquired.");
      }
      await writeFile(path, lockJson("other"), "utf8");
      await ageFile(path, 10 * 60_000);

      expect(() => lock.refresh()).toThrow(/taken over by another process/);

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

describe("acquireFileLockWithin", () => {
  it("waits out a holder instead of failing immediately", async () => {
    // The conflict resolver calls this once the user has already answered. A
    // routine 30-second poll holding the lock must cost a short wait, not the
    // whole set of answers.
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      const held = await acquireFileLock(path);
      if (held === null) {
        throw new Error("Expected the free lock to be acquired.");
      }
      let waitedAnnounced = 0;
      let elapsed = 0;
      const sleep = async (ms: number): Promise<void> => {
        elapsed += ms;
        // The holder finishes partway through, exactly like a poll ending.
        if (elapsed >= 500) {
          await held.release();
        }
      };

      const lock = await acquireFileLockWithin(
        path,
        60_000,
        () => {
          waitedAnnounced += 1;
        },
        sleep,
        () => elapsed,
      );

      expect(lock).not.toBeNull();
      // Announced once, not once per retry.
      expect(waitedAnnounced).toBe(1);
      await lock?.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives up at the deadline rather than waiting forever", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      const held = await acquireFileLock(path);
      if (held === null) {
        throw new Error("Expected the free lock to be acquired.");
      }
      let elapsed = 0;
      const sleep = async (ms: number): Promise<void> => {
        elapsed += ms;
      };

      const lock = await acquireFileLockWithin(
        path,
        1_000,
        () => {},
        sleep,
        () => elapsed,
      );

      expect(lock).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      await held.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns at once when the lock is free", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-lock-"));
    try {
      const path = join(root, "sync.lock");
      let slept = false;
      let announced = false;

      const lock = await acquireFileLockWithin(
        path,
        60_000,
        () => {
          announced = true;
        },
        async () => {
          slept = true;
        },
      );

      expect(lock).not.toBeNull();
      expect(slept).toBe(false);
      expect(announced).toBe(false);
      await lock?.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
