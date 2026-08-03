import { describe, expect, it } from "vitest";
import type { FileLock } from "../src/platform/lock";
import {
  BackgroundCoordinator,
  type ProbeScheduler,
} from "../src/sync/backgroundCoordinator";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function settledState(
  promise: Promise<unknown>,
): Promise<"pending" | "resolved" | "rejected"> {
  return Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

interface ScheduledEntry {
  active: boolean;
  callback(): void;
  delayMs: number;
}

class FakeProbeScheduler {
  readonly entries: ScheduledEntry[] = [];

  readonly schedule: ProbeScheduler = (callback, delayMs) => {
    const entry: ScheduledEntry = { active: true, callback, delayMs };
    this.entries.push(entry);
    return {
      cancel: () => {
        entry.active = false;
      },
    };
  };

  get pending(): number {
    return this.entries.filter((entry) => entry.active).length;
  }

  fireAll(): void {
    for (const entry of this.entries.filter((candidate) => candidate.active)) {
      entry.active = false;
      entry.callback();
    }
  }
}

class FakeLock implements FileLock {
  readonly path: string;
  releaseCalls = 0;
  releaseGate: Deferred | null = null;
  refreshError: Error | null = null;

  constructor(
    private readonly pool: FakeLockPool,
    readonly id: number,
  ) {
    this.path = `background-${id}.lock`;
  }

  refresh(): void {
    if (this.refreshError !== null) {
      throw this.refreshError;
    }
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    await this.releaseGate?.promise;
    if (this.pool.owner === this) {
      this.pool.owner = null;
    }
  }
}

class FakeLockPool {
  owner: FakeLock | null = null;
  acquireCalls = 0;
  readonly locks: FakeLock[] = [];
  acquireError: Error | null = null;

  readonly acquire = async (): Promise<FileLock | null> => {
    this.acquireCalls += 1;
    if (this.acquireError !== null) {
      throw this.acquireError;
    }
    if (this.owner !== null) {
      return null;
    }
    const lock = new FakeLock(this, this.locks.length + 1);
    this.locks.push(lock);
    this.owner = lock;
    return lock;
  };
}

describe("background coordinator", () => {
  it("elects exactly one leader and leaves one probe per follower", async () => {
    const pool = new FakeLockPool();
    const schedulers = Array.from(
      { length: 5 },
      () => new FakeProbeScheduler(),
    );
    const activations = Array.from({ length: 5 }, () => 0);
    const coordinators = schedulers.map(
      (scheduler, index) =>
        new BackgroundCoordinator({
          acquire: pool.acquire,
          activate: async () => {
            activations[index] = (activations[index] ?? 0) + 1;
          },
          deactivate: () => {},
          scheduleProbe: scheduler.schedule,
          probeDelayMs: () => 41,
        }),
    );

    await Promise.all(coordinators.map((coordinator) => coordinator.start(true)));

    expect(coordinators.filter((coordinator) => coordinator.active)).toHaveLength(
      1,
    );
    expect(activations.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(schedulers.map((scheduler) => scheduler.pending).sort()).toEqual([
      0, 1, 1, 1, 1,
    ]);
    expect(
      schedulers.flatMap((scheduler) => scheduler.entries).every(
        (entry) => entry.delayMs === 41,
      ),
    ).toBe(true);
  });

  it("awaits the old release and skips stale activation during a restart", async () => {
    const pool = new FakeLockPool();
    const scheduler = new FakeProbeScheduler();
    const finalizer = deferred();
    const events: string[] = [];
    let activation = 0;
    const coordinator = new BackgroundCoordinator({
      acquire: async () => {
        events.push("acquire");
        return pool.acquire();
      },
      activate: async (_runInitialSync, isCurrent) => {
        activation += 1;
        if (activation === 1) {
          events.push("finalizer-start");
          await finalizer.promise;
          events.push(isCurrent() ? "watcher-stale-bug" : "stale-skipped");
          return;
        }
        events.push("replacement-active");
      },
      deactivate: () => events.push("deactivate"),
      scheduleProbe: scheduler.schedule,
      probeDelayMs: () => 1,
    });

    const first = coordinator.start(true);
    await flush();
    const firstLock = pool.locks[0];
    expect(firstLock).toBeDefined();
    const release = deferred();
    firstLock!.releaseGate = release;

    const replacement = coordinator.start(false);
    expect(events.at(-1)).toBe("deactivate");
    expect(firstLock!.releaseCalls).toBe(1);
    finalizer.resolve();
    await flush();
    expect(events).toContain("stale-skipped");
    expect(events).not.toContain("watcher-stale-bug");
    expect(pool.acquireCalls).toBe(1);
    expect(await settledState(replacement)).toBe("pending");

    release.resolve();
    await Promise.all([first, replacement]);
    expect(events.at(-1)).toBe("replacement-active");
    expect(pool.acquireCalls).toBe(2);
    expect(firstLock!.releaseCalls).toBe(1);
    expect(coordinator.active).toBe(true);
  });

  it("cleans partial activation and retries after any activation-stage error", async () => {
    const pool = new FakeLockPool();
    const scheduler = new FakeProbeScheduler();
    const errors: unknown[] = [];
    let runtimeOpen = false;
    let failWatcher = true;
    let deactivations = 0;
    const coordinator = new BackgroundCoordinator({
      acquire: pool.acquire,
      activate: async () => {
        runtimeOpen = true;
        if (failWatcher) {
          throw new Error("watcher creation failed");
        }
      },
      deactivate: () => {
        deactivations += 1;
        runtimeOpen = false;
      },
      scheduleProbe: scheduler.schedule,
      probeDelayMs: () => 7,
      onError: (error) => errors.push(error),
    });

    await coordinator.start(true);
    expect(runtimeOpen).toBe(false);
    expect(coordinator.active).toBe(false);
    expect(pool.locks[0]?.releaseCalls).toBe(1);
    expect(scheduler.pending).toBe(1);
    expect(errors).toEqual([new Error("watcher creation failed")]);
    expect(deactivations).toBeGreaterThanOrEqual(2);

    failWatcher = false;
    scheduler.fireAll();
    await flush();
    expect(coordinator.active).toBe(true);
    expect(scheduler.pending).toBe(0);
  });

  it("reports acquisition errors while maintaining only one retry probe", async () => {
    const pool = new FakeLockPool();
    const scheduler = new FakeProbeScheduler();
    const errors: unknown[] = [];
    pool.acquireError = new Error("lock storage unavailable");
    const coordinator = new BackgroundCoordinator({
      acquire: pool.acquire,
      activate: async () => {},
      deactivate: () => {},
      scheduleProbe: scheduler.schedule,
      probeDelayMs: () => 9,
      onError: (error) => errors.push(error),
    });

    await coordinator.start();
    expect(scheduler.pending).toBe(1);
    scheduler.fireAll();
    await flush();
    expect(scheduler.pending).toBe(1);
    expect(errors).toHaveLength(2);
  });

  it("lets exactly one follower take over after the leader stops", async () => {
    const pool = new FakeLockPool();
    const schedulers = Array.from(
      { length: 4 },
      () => new FakeProbeScheduler(),
    );
    const coordinators = schedulers.map(
      (scheduler) =>
        new BackgroundCoordinator({
          acquire: pool.acquire,
          activate: async () => {},
          deactivate: () => {},
          scheduleProbe: scheduler.schedule,
          probeDelayMs: () => 3,
        }),
    );
    await Promise.all(coordinators.map((coordinator) => coordinator.start()));
    const leader = coordinators.find((coordinator) => coordinator.active);
    expect(leader).toBeDefined();

    await leader!.stop();
    schedulers.forEach((scheduler) => scheduler.fireAll());
    await flush();

    expect(coordinators.filter((coordinator) => coordinator.active)).toHaveLength(
      1,
    );
    expect(
      coordinators.filter(
        (coordinator) => coordinator !== leader && coordinator.active,
      ),
    ).toHaveLength(1);
  });

  it("deactivates stop immediately and resolves it after lock release", async () => {
    const pool = new FakeLockPool();
    const scheduler = new FakeProbeScheduler();
    let runtimeOpen = false;
    const coordinator = new BackgroundCoordinator({
      acquire: pool.acquire,
      activate: async () => {
        runtimeOpen = true;
      },
      deactivate: () => {
        runtimeOpen = false;
      },
      scheduleProbe: scheduler.schedule,
      probeDelayMs: () => 1,
    });
    await coordinator.start();
    const lock = pool.locks[0]!;
    const release = deferred();
    lock.releaseGate = release;

    const stopped = coordinator.stop();
    expect(runtimeOpen).toBe(false);
    expect(coordinator.active).toBe(false);
    expect(lock.releaseCalls).toBe(1);
    expect(await settledState(stopped)).toBe("pending");
    release.resolve();
    await stopped;
    expect(scheduler.pending).toBe(0);
  });

  it("cancels follower probes on stop and dispose", async () => {
    const pool = new FakeLockPool();
    const leader = new BackgroundCoordinator({
      acquire: pool.acquire,
      activate: async () => {},
      deactivate: () => {},
    });
    await leader.start();
    for (const permanently of [false, true]) {
      const scheduler = new FakeProbeScheduler();
      const follower = new BackgroundCoordinator({
        acquire: pool.acquire,
        activate: async () => {},
        deactivate: () => {},
        scheduleProbe: scheduler.schedule,
        probeDelayMs: () => 1,
      });
      await follower.start();
      const callsBefore = pool.acquireCalls;
      await (permanently ? follower.dispose() : follower.stop());
      expect(scheduler.pending).toBe(0);
      scheduler.fireAll();
      await flush();
      expect(pool.acquireCalls).toBe(callsBefore);
    }
  });

  it("stands down and reprobes when refresh proves ownership was lost", async () => {
    const pool = new FakeLockPool();
    const scheduler = new FakeProbeScheduler();
    const errors: unknown[] = [];
    let runtimeOpen = false;
    const coordinator = new BackgroundCoordinator({
      acquire: pool.acquire,
      activate: async () => {
        runtimeOpen = true;
      },
      deactivate: () => {
        runtimeOpen = false;
      },
      scheduleProbe: scheduler.schedule,
      probeDelayMs: () => 5,
      onError: (error) => errors.push(error),
    });
    await coordinator.start();
    expect(coordinator.validateOwnership()).toBe(true);
    pool.locks[0]!.refreshError = new Error("foreign token");

    expect(coordinator.validateOwnership()).toBe(false);
    expect(runtimeOpen).toBe(false);
    expect(coordinator.active).toBe(false);
    await flush();
    expect(pool.locks[0]!.releaseCalls).toBe(1);
    expect(scheduler.pending).toBe(1);
    expect(errors).toEqual([new Error("foreign token")]);
  });
});
