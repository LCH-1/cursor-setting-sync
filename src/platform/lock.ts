import { open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { readFileSync, utimesSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDirectory, isMissingPathError } from "./files";
import { dirname } from "node:path";

// The holder refreshes the lock file's mtime so diagnostics can report recent
// activity and a half-created/corrupt file can eventually heal. A readable
// lock is NEVER displaced merely because its heartbeat is old while its PID
// is alive: sleep, hibernation, a stopped debugger, synchronous work and wall
// clock jumps can all make an entirely valid heartbeat look arbitrarily old.
// New lock payloads also carry the OS process-start identity, which lets an old
// lock heal when its PID has genuinely been recycled without weakening that
// rule. Older payloads remain valid and take the conservative live-PID path.
const HEARTBEAT_INTERVAL_MS = 60_000;
const STALE_LOCK_TTL_MS = 15 * 60_000;
const PROCESS_IDENTITY_CACHE_MS = 30_000;
const execFileAsync = promisify(execFile);

interface LockContent {
  pid: number;
  token: string;
  createdAt: string;
  /** Optional for compatibility with locks written before process identity. */
  processStartId?: string;
}

interface CachedProcessIdentity {
  checkedAt: number;
  value: string | null;
}

const processIdentityCache = new Map<number, CachedProcessIdentity>();
const processIdentityLookups = new Map<number, Promise<string | null>>();

export interface FileLock {
  path: string;
  /**
   * Re-stamps the lock's mtime before a long synchronous phase.
   *
   * Throws {@link LockLostError} when the path is PROVABLY held by someone
   * else (readable content with a foreign token): a stale-takeover race can
   * displace a live holder, and continuing a destructive critical section on
   * a lock another process now owns is strictly worse than aborting - the
   * helper's error paths roll the write back. Every other failure (a
   * transient read error, a vanished file) stays silent as before.
   */
  refresh(): void;
  release(): Promise<void>;
}

/** The lock's path is now owned by another process; abort the critical section. */
export class LockLostError extends Error {
  constructor(path: string) {
    super(
      `The synchronization lock was taken over by another process (${path}); aborting to avoid concurrent writes.`,
    );
    this.name = "LockLostError";
  }
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
      "Close other Cursor windows, or wait - a lock whose holder has exited is released automatically, " +
      "and current lock files also detect PID reuse. " +
      `An unreadable lock file is recovered after ${staleMinutes} minutes. ` +
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
    let storedContent = content;
    try {
      // Resolve the potentially slower Windows/macOS process metadata only
      // after this contender has won open("wx"). Losing Cursor windows never
      // spawn a probe, and the winner caches the result for every later lock.
      const processStartId = await getProcessStartIdentity(process.pid);
      if (processStartId !== null) {
        storedContent = { ...content, processStartId };
      }
      await handle.writeFile(JSON.stringify(storedContent), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return createLock(path, storedContent);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

async function readLock(path: string): Promise<LockContent | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isLockContent(parsed)) {
      return null;
    }
    return parsed;
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

  // A live PID is sufficient proof for legacy locks. Age alone is not proof
  // of death: in particular, Windows resumes all Cursor processes with an old
  // mtime after sleep, and the previous implementation let the first window
  // steal a lock from the still-running holder.
  if (existing.processStartId === undefined) {
    return false;
  }

  try {
    const lockStat = await stat(path);
    if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_TTL_MS) {
      return false;
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    throw error;
  }

  // Only an OS identity mismatch can make a readable lock stale while its
  // numeric PID is alive. An unavailable/unsupported probe fails closed and
  // leaves the lock alone; the holder exiting will still release it normally.
  const actualProcessStartId = await getProcessStartIdentity(existing.pid);
  return (
    actualProcessStartId !== null &&
    haveComparableProcessStartIds(
      existing.processStartId,
      actualProcessStartId,
    ) &&
    existing.processStartId !== actualProcessStartId
  );
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
      let foreign = false;
      try {
        const existing = JSON.parse(readFileSync(path, "utf8")) as LockContent;
        if (existing.token !== content.token) {
          // Displaced by a stale-takeover race: another process now owns the
          // path and believes it holds the mutex. Silently returning here
          // let the displaced holder keep writing blind.
          foreign = true;
        } else {
          const now = new Date();
          utimesSync(path, now, now);
        }
      } catch {
        // Same contract as the heartbeat: a failed READ never interrupts the
        // holder - only a proven foreign occupant does.
      }
      if (foreign) {
        clearInterval(heartbeat);
        throw new LockLostError(path);
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

function isLockContent(value: unknown): value is LockContent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" &&
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.createdAt === "string" &&
    (candidate.processStartId === undefined ||
      (typeof candidate.processStartId === "string" &&
        candidate.processStartId.length > 0))
  );
}

function haveComparableProcessStartIds(left: string, right: string): boolean {
  const leftScheme = processStartIdScheme(left);
  return leftScheme !== null && leftScheme === processStartIdScheme(right);
}

function processStartIdScheme(value: string): string | null {
  if (/^linux:\d+$/u.test(value)) {
    return "linux";
  }
  if (/^win32:\d+$/u.test(value)) {
    return "win32";
  }
  if (value.startsWith("darwin:")) {
    const timestamp = value.slice("darwin:".length);
    return timestamp.length > 0 && Number.isFinite(Date.parse(timestamp))
      ? "darwin"
      : null;
  }
  return null;
}

async function getProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  const checkedAt = process.uptime() * 1_000;
  const cached = processIdentityCache.get(pid);
  if (
    cached !== undefined &&
    (pid === process.pid ||
      checkedAt - cached.checkedAt < PROCESS_IDENTITY_CACHE_MS)
  ) {
    // This process cannot reuse its own PID while it is running, so its
    // identity is immutable and safe to cache for the module lifetime. This
    // also prevents a PowerShell process from being launched on every poll.
    return cached.value;
  }

  const pending = processIdentityLookups.get(pid);
  if (pending !== undefined) {
    return pending;
  }

  const lookup = readProcessStartIdentity(pid)
    .catch(() => null)
    .then((value) => {
      processIdentityCache.set(pid, {
        checkedAt: process.uptime() * 1_000,
        value,
      });
      return value;
    })
    .finally(() => {
      processIdentityLookups.delete(pid);
    });
  processIdentityLookups.set(pid, lookup);
  return lookup;
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) is parenthesized and may itself contain spaces or ')'.
    // Everything after its final ')' starts at field 3; starttime is field 22.
    const commEnd = raw.lastIndexOf(")");
    if (commEnd < 0) {
      return null;
    }
    const fields = raw.slice(commEnd + 1).trim().split(/\s+/u);
    const startTicks = fields[19];
    return startTicks === undefined || !/^\d+$/u.test(startTicks)
      ? null
      : `linux:${startTicks}`;
  }

  if (process.platform === "win32") {
    const script =
      "$ErrorActionPreference='Stop';" +
      `$p=Get-Process -Id ${pid};` +
      "[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)";
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      },
    );
    const ticks = stdout.trim();
    return /^\d+$/u.test(ticks) ? `win32:${ticks}` : null;
  }

  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        timeout: 5_000,
      },
    );
    const startedAt = stdout.trim().replace(/\s+/gu, " ");
    return startedAt.length === 0 ? null : `darwin:${startedAt}`;
  }

  return null;
}
