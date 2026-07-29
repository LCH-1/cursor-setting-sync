import { open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { readFileSync, utimesSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ensureDirectory, isMissingPathError } from "./files";
import { dirname } from "node:path";

// The holder refreshes the lock file's mtime so other processes can tell a
// live lock from one whose PID was recycled after a reboot. Staleness needs
// either a dead PID or an mtime older than the TTL, so a recycled PID that
// never heartbeats the file heals instead of blocking sync forever. The TTL
// is fifteen heartbeats so a holder stalled in long synchronous work does
// not lose a live lock over a few missed refreshes.
const HEARTBEAT_INTERVAL_MS = 60_000;
const STALE_LOCK_TTL_MS = 15 * 60_000;

interface LockContent {
  pid: number;
  token: string;
  createdAt: string;
}

export interface FileLock {
  path: string;
  refresh(): void;
  release(): Promise<void>;
}

/**
 * Acquires the lock, retrying until it is free or `timeoutMs` elapses.
 *
 * {@link acquireFileLock} tries exactly once, which is right where failing
 * costs nothing — the caller has done no work yet and can be told to try again.
 * It is wrong once the user has already answered something: the conflict
 * resolver deliberately releases the lock while its prompt is open, so a
 * routine background poll starting in that window made the whole set of answers
 * fail with "Another Cursor window or the offline helper is synchronizing", and
 * they were discarded. A poll is seconds of work, so waiting it out is both
 * cheap and the only outcome the user would ever choose.
 *
 * `onWait` is called once, on the first attempt that has to wait, so the caller
 * can say what is happening rather than appear frozen.
 */
export async function acquireFileLockWithin(
  path: string,
  timeoutMs: number,
  onWait: () => void = () => {},
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): Promise<FileLock | null> {
  const deadline = now() + timeoutMs;
  let waited = false;
  for (;;) {
    const lock = await acquireFileLock(path);
    if (lock !== null) {
      return lock;
    }
    if (now() >= deadline) {
      return null;
    }
    if (!waited) {
      waited = true;
      onWait();
    }
    await sleep(Math.min(LOCK_RETRY_INTERVAL_MS, Math.max(0, deadline - now())));
  }
}

const LOCK_RETRY_INTERVAL_MS = 250;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireFileLock(path: string): Promise<FileLock | null> {
  await ensureDirectory(dirname(path));
  const content: LockContent = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const fresh = await tryCreateLock(path, content);
  if (fresh !== null) {
    return fresh;
  }

  const existing = await readLock(path);
  if (existing !== null && !(await isLockStale(path, existing))) {
    return null;
  }
  if (existing === null && !(await isUnreadableFileStale(path))) {
    // An unreadable lock file is usually another contender caught between its
    // open("wx") and its writeFile - milliseconds old, very much alive. Taking
    // it over on unreadability alone stole locks mid-creation and left two
    // processes both convinced they held one. Age is the tiebreaker: a file
    // that stays unreadable past the TTL is corrupt, not nascent, and the TTL
    // is the same self-healing the readable path already applies.
    return null;
  }

  // Renaming the stale file away is atomic, so exactly one contender takes it
  // over. A plain remove-then-create would let a slow racer delete the lock a
  // faster racer just created.
  const takeoverPath = `${path}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(path, takeoverPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      // Another contender already renamed the stale lock; retry the normal
      // create and lose gracefully if that contender recreated it first.
      return tryCreateLock(path, content);
    }
    throw error;
  }
  // The staleness decision was made before the rename, so the rename can land
  // after another contender already took the stale lock over and created a
  // fresh live lock at the path. Only proceed when the renamed-away file is
  // still the stale lock observed above; otherwise put it back and lose.
  const moved = await readLock(takeoverPath);
  if (!isSameLock(existing, moved)) {
    await undoTakeover(path, takeoverPath);
    return null;
  }
  if (existing === null && !(await isUnreadableFileStale(takeoverPath))) {
    // Both reads were null, which isSameLock alone cannot distinguish from
    // "the writer finished in between and the holder heartbeated it" - the
    // rename preserves mtime, so re-checking the age of the moved file closes
    // that window. A fresh mtime means the lock came back to life; restore it.
    await undoTakeover(path, takeoverPath);
    return null;
  }
  if (moved !== null && !(await isLockStale(takeoverPath, moved))) {
    // The staleness verdict predates the rename. A holder whose heartbeat
    // landed in between is alive - the rename preserved the fresh mtime, so
    // re-judging the moved file sees it. isSameLock alone cannot: the bytes
    // (pid, token) are identical whether the holder is dead or mid-beat.
    await undoTakeover(path, takeoverPath);
    return null;
  }
  await rm(takeoverPath, { force: true });
  return tryCreateLock(path, content);
}

/**
 * Who is holding `path`, both as a sentence for the user and as the holder's
 * PID.
 *
 * The sentence carries an age that changes every minute, so it cannot be
 * compared against the previous observation to decide whether anything actually
 * changed. The poll path needs exactly that comparison to stop logging the same
 * skip twice a minute forever, and the PID is the part that identifies the
 * holder; see {@link noteLockSkip}.
 */
export interface LockHolderReport {
  /** Null when the lock file has already gone or cannot be parsed. */
  pid: number | null;
  description: string;
}

/**
 * Explains who is holding `path`, for the message shown when a command cannot
 * take the lock. The lock file already records the PID and the creation time
 * and self-heals on a dead PID or after the TTL, but none of that used to reach
 * the user: every command failed with the same six words and no way to learn
 * that closing the other window - or simply waiting - fixes it.
 */
export async function reportLockHolder(path: string): Promise<LockHolderReport> {
  const existing = await readLock(path);
  if (existing === null) {
    return {
      pid: null,
      description:
        "Another Cursor window or the offline helper is synchronizing. " +
        "Close other Cursor windows, or try again in a moment. " +
        `Lock file: ${path}.`,
    };
  }
  let heldFor = "";
  try {
    const minutes = Math.max(
      0,
      Math.floor((Date.now() - (await stat(path)).mtimeMs) / 60_000),
    );
    heldFor = `, last active ${minutes} minute(s) ago`;
  } catch {
    // The age is a nicety; the PID alone is already actionable.
  }
  const staleMinutes = Math.round(STALE_LOCK_TTL_MS / 60_000);
  return {
    pid: existing.pid,
    description:
      `Another Cursor window or the offline helper (pid ${existing.pid}${heldFor}) is synchronizing. ` +
      "Close other Cursor windows, or wait - a lock whose holder has exited is " +
      `released automatically, and any lock goes stale after ${staleMinutes} minutes. ` +
      `Lock file: ${path}.`,
  };
}

export async function describeLockHolder(path: string): Promise<string> {
  return (await reportLockHolder(path)).description;
}

function isSameLock(
  left: LockContent | null,
  right: LockContent | null,
): boolean {
  if (left === null || right === null) {
    return left === null && right === null;
  }
  return left.token === right.token && left.pid === right.pid;
}

async function undoTakeover(path: string, takeoverPath: string): Promise<void> {
  try {
    // Recreating with "wx" restores the displaced lock byte-for-byte without
    // ever clobbering the path: if yet another contender recreated it first,
    // the create fails and that contender keeps the lock.
    const displaced = await readFile(takeoverPath);
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(displaced);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort: the displaced holder cannot be restored once the path is
    // occupied again, and a failed undo must not mask the null result.
  }
  await rm(takeoverPath, { force: true });
}

async function tryCreateLock(
  path: string,
  content: LockContent,
): Promise<FileLock | null> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(JSON.stringify(content), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return createLock(path, content);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

async function readLock(path: string): Promise<LockContent | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockContent;
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/** Staleness for a lock whose content cannot be read: age is all there is. */
async function isUnreadableFileStale(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_LOCK_TTL_MS;
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    throw error;
  }
}

async function isLockStale(path: string, existing: LockContent): Promise<boolean> {
  if (!isProcessAlive(existing.pid)) {
    return true;
  }
  try {
    const lockStat = await stat(path);
    return Date.now() - lockStat.mtimeMs > STALE_LOCK_TTL_MS;
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    throw error;
  }
}

function createLock(path: string, content: LockContent): FileLock {
  const heartbeat = setInterval(() => {
    void touchLock(path, content);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  return {
    path,
    refresh(): void {
      // Long synchronous phases stall the event loop and with it the
      // heartbeat, so holders call this right before entering one. It must
      // stay synchronous to run while the loop still can.
      try {
        const existing = JSON.parse(readFileSync(path, "utf8")) as LockContent;
        if (existing.token !== content.token) {
          return;
        }
        const now = new Date();
        utimesSync(path, now, now);
      } catch {
        // Same contract as the heartbeat: a failed refresh never interrupts
        // the holder.
      }
    },
    async release(): Promise<void> {
      clearInterval(heartbeat);
      const existing = await readLock(path);
      if (existing?.token === content.token) {
        await rm(path, { force: true });
      }
    },
  };
}

async function touchLock(path: string, content: LockContent): Promise<void> {
  try {
    const existing = await readLock(path);
    if (existing?.token !== content.token) {
      return;
    }
    const now = new Date();
    await utimes(path, now, now);
  } catch {
    // A failed heartbeat must never interrupt the holder; the lock only goes
    // stale for others once the TTL lapses or the holder's PID dies.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled from here.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
