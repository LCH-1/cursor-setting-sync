import { describe, expect, it } from "vitest";

import {
  SyncCycleQueue,
  mergeSyncScopes,
  type SyncScope,
} from "../src/sync/cycleQueue";

interface Harness {
  queue: SyncCycleQueue;
  /** One entry per cycle the queue has started, in order. */
  cycles: Array<{ manual: boolean; scope: SyncScope }>;
  /** Ends the oldest cycle still running. */
  finish: (error?: unknown) => void;
  maintenanceRuns: () => number;
  failures: unknown[];
}

function harness(): Harness {
  const cycles: Array<{ manual: boolean; scope: SyncScope }> = [];
  const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> =
    [];
  let maintenance = 0;
  const failures: unknown[] = [];
  const queue = new SyncCycleQueue({
    runCycle: (manual, scope) => {
      cycles.push({ manual, scope });
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    runMaintenance: () => {
      maintenance += 1;
      return Promise.resolve();
    },
    onAutomaticFailure: (error) => {
      failures.push(error);
    },
  });
  return {
    queue,
    cycles,
    finish: (error?: unknown) => {
      const next = pending.shift();
      if (next === undefined) {
        throw new Error("no cycle is running");
      }
      if (error === undefined) {
        next.resolve();
      } else {
        next.reject(error);
      }
    },
    maintenanceRuns: () => maintenance,
    failures,
  };
}

/** Lets the microtask queue settle so awaited promises have run. */
async function flush(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve();
  }
}

function settledState(promise: Promise<void>): Promise<"pending" | "resolved" | "rejected"> {
  return Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    flush().then(() => "pending" as const),
  ]);
}

describe("a request parked behind a queue that keeps refilling", () => {
  it("returns when ITS cycle ends, not when the queue empties", async () => {
    // The bug this pins: "Restart to Apply" opens with a synchronize, and on a
    // repository where one cycle outlasts the 30-second poll the queue is
    // never empty - the timers and the folder watcher hand the drain a fresh
    // scope while the cycle they are behind is still running. Awaiting the
    // drain therefore never returned, and the command sat on its first phase
    // for over an hour while the output channel showed cycles completing.
    const bench = harness();
    const command = bench.queue.request(true, "all");
    expect(bench.cycles).toEqual([{ manual: true, scope: "all" }]);

    // A watcher notification lands while that first cycle is still running.
    // Unlike a repeated poll tick, it carries a unique observation and must
    // remain queued behind the active cycle.
    void bench.queue.requestAutomatic("remote");
    expect(await settledState(command)).toBe("pending");

    bench.finish();
    expect(await settledState(command)).toBe("resolved");
    // ...and the drain carried straight on with the refill, so the watcher
    // notification was not lost in exchange.
    expect(bench.cycles).toEqual([
      { manual: true, scope: "all" },
      { manual: false, scope: "remote" },
    ]);
  });

  it("does not resolve on a cycle that started before it asked", async () => {
    const bench = harness();
    const first = bench.queue.request(false, "files");
    const second = bench.queue.request(true, "chat");
    // `second` arrived after the cycle for `first` had already taken its
    // scope, so it belongs to the next one.
    bench.finish();
    expect(await settledState(first)).toBe("resolved");
    expect(await settledState(second)).toBe("pending");
    bench.finish();
    expect(await settledState(second)).toBe("resolved");
  });

  it("runs maintenance once the queue is genuinely empty", async () => {
    const bench = harness();
    const request = bench.queue.request(true, "all");
    bench.finish();
    await settledState(request);
    expect(bench.maintenanceRuns()).toBe(1);
    expect(bench.queue.draining).toBe(false);
  });
});

describe("a cycle that throws", () => {
  it("reaches the callers it was carrying", async () => {
    const bench = harness();
    const request = bench.queue.request(true, "all");
    bench.finish(new Error("lock is held"));
    await expect(request).rejects.toThrow("lock is held");
  });

  it("does not strand the callers queued behind it", async () => {
    // The failing cycle ends the drain. A caller that arrived while it ran is
    // in the next batch, which now never runs - before this it waited on a
    // promise nothing would ever settle.
    const bench = harness();
    const failing = bench.queue.request(true, "all");
    const behind = bench.queue.request(true, "chat");
    bench.finish(new Error("lock is held"));
    await expect(failing).rejects.toThrow("lock is held");
    // Its own situation, not the other request's error: this cycle never
    // started, so "lock is held" would be a failure reported by the wrong
    // caller. The reason is kept as the cause.
    await expect(behind).rejects.toThrow(
      "The synchronization cycle ended before this request ran.",
    );
    await expect(behind.catch((error: unknown) => (error as Error).cause)).resolves.toEqual(
      new Error("lock is held"),
    );
    expect(bench.queue.draining).toBe(false);
  });
});

describe("periodic polling", () => {
  it("drops covered ticks but coalesces one disjoint follow-up", async () => {
    const bench = harness();
    const first = bench.queue.requestPolling("files");
    expect(bench.cycles).toEqual([{ manual: false, scope: "files" }]);

    // Repeated file ticks carry no new information because the active cycle
    // already covers them. Chat is disjoint and must not be phase-starved, but
    // its whole burst shares one bounded follow-up.
    await bench.queue.requestPolling("files");
    const chat = Array.from({ length: 10_000 }, () =>
      bench.queue.requestPolling("chat"),
    );
    expect(new Set(chat).size).toBe(1);
    expect(bench.cycles).toEqual([{ manual: false, scope: "files" }]);

    bench.finish();
    await first;
    expect(bench.cycles).toEqual([
      { manual: false, scope: "files" },
      { manual: false, scope: "chat" },
    ]);
    bench.finish();
    await Promise.all(chat);
    await flush();
    expect(bench.queue.draining).toBe(false);
  });

  it("keeps unequal scopes live across repeated slow-cycle overlaps", async () => {
    const bench = harness();
    let active = bench.queue.requestPolling("files");
    const expected = ["files"];

    for (const nextScope of ["chat", "files", "chat", "files"] as const) {
      const next = bench.queue.requestPolling(nextScope);
      bench.finish();
      await active;
      expected.push(nextScope);
      expect(bench.cycles.map((cycle) => cycle.scope)).toEqual(expected);
      active = next;
    }

    bench.finish();
    await active;
    await flush();
    expect(bench.queue.draining).toBe(false);
  });

  it("drops ticks while a command holds the floor", async () => {
    const bench = harness();
    await bench.queue.withCommandFloor(async () => {
      await bench.queue.requestPolling("files");
      await bench.queue.requestPolling("chat");
    });
    await flush();
    expect(bench.cycles).toEqual([]);

    const next = bench.queue.requestPolling("all");
    expect(bench.cycles).toEqual([{ manual: false, scope: "all" }]);
    bench.finish();
    await next;
  });
});

describe("automatic notification bursts", () => {
  it("shares one resolving waiter for 10,000 notifications behind a cycle", async () => {
    const bench = harness();
    const gate = bench.queue.request(true, "all");
    const notifications = Array.from({ length: 10_000 }, (_, index) =>
      bench.queue.requestAutomatic(index % 2 === 0 ? "files" : "chat"),
    );

    expect(new Set(notifications).size).toBe(1);
    expect(bench.cycles).toEqual([{ manual: true, scope: "all" }]);

    bench.finish();
    await gate;
    expect(bench.cycles).toEqual([
      { manual: true, scope: "all" },
      { manual: false, scope: "all" },
    ]);

    bench.finish();
    await Promise.all(notifications);
    await flush();
    expect(bench.queue.draining).toBe(false);
  });

  it("rejects one shared burst and leaves the queue reusable", async () => {
    const bench = harness();
    const gate = bench.queue.request(true, "files");
    const notifications = Array.from({ length: 10_000 }, () =>
      bench.queue.requestAutomatic("remote"),
    );
    const shared = notifications[0];
    if (shared === undefined) {
      throw new Error("the notification burst was empty");
    }
    const outcome = shared.then(
      () => null,
      (error: unknown) => error,
    );

    expect(new Set(notifications).size).toBe(1);
    bench.finish();
    await gate;
    expect(bench.cycles).toEqual([
      { manual: true, scope: "files" },
      { manual: false, scope: "remote" },
    ]);

    const failure = new Error("watcher cycle failed");
    bench.finish(failure);
    expect(await outcome).toBe(failure);
    await flush();
    expect(bench.queue.draining).toBe(false);

    const recovery = bench.queue.requestAutomatic("remote");
    expect(bench.cycles).toHaveLength(3);
    bench.finish();
    await recovery;
    await flush();
    expect(bench.queue.draining).toBe(false);
  });
});

describe("the floor a user-invoked command stands on", () => {
  it("withholds automatic requests so the command can take the lock", async () => {
    // Commands wait a bounded time for the same file lock the cycle holds.
    // Against a self-refilling queue that wait cannot be long enough, and the
    // command fails against this window's own polling.
    const bench = harness();
    let released = false;
    const command = bench.queue.withCommandFloor(async () => {
      expect(bench.queue.commandRunning).toBe(true);
      await bench.queue.requestAutomatic("files");
      await bench.queue.requestAutomatic("remote");
      expect(bench.cycles).toEqual([]);
      released = true;
    });
    await command;
    expect(released).toBe(true);
    expect(bench.queue.commandRunning).toBe(false);
  });

  it("runs what it withheld afterwards, as one widened cycle", async () => {
    // Remembered rather than dropped: the scope decides what the next cycle
    // even looks at, so discarding the watcher's "remote" would leave the
    // shared folder unread until something asked for that scope by name.
    const bench = harness();
    await bench.queue.withCommandFloor(async () => {
      await bench.queue.requestAutomatic("files");
      await bench.queue.requestAutomatic("chat");
    });
    await flush();
    expect(bench.cycles).toEqual([{ manual: false, scope: "all" }]);
    bench.finish();
    await flush();
  });

  it("does not withhold the command's own synchronize", async () => {
    const bench = harness();
    const command = bench.queue.withCommandFloor(async () => {
      const own = bench.queue.request(true, "all");
      expect(bench.cycles).toEqual([{ manual: true, scope: "all" }]);
      bench.finish();
      await own;
    });
    await command;
  });

  it("reports a failure of the requests it deferred", async () => {
    // Nothing awaits the flush, so its error has nowhere else to go.
    const bench = harness();
    await bench.queue.withCommandFloor(async () => {
      await bench.queue.requestAutomatic("files");
    });
    await flush();
    bench.finish(new Error("git pull failed"));
    await flush();
    expect(bench.failures).toHaveLength(1);
    expect((bench.failures[0] as Error).message).toBe("git pull failed");
  });

  it("only stands down for the outermost command", async () => {
    const bench = harness();
    await bench.queue.withCommandFloor(async () => {
      await bench.queue.withCommandFloor(async () => {
        await bench.queue.requestAutomatic("files");
      });
      // The inner command finished, but the outer one is still preparing.
      expect(bench.cycles).toEqual([]);
    });
    await flush();
    expect(bench.cycles).toEqual([{ manual: false, scope: "files" }]);
    bench.finish();
    await flush();
  });

  it("lowers the floor when the command throws", async () => {
    const bench = harness();
    await expect(
      bench.queue.withCommandFloor(() => Promise.reject(new Error("cancelled"))),
    ).rejects.toThrow("cancelled");
    expect(bench.queue.commandRunning).toBe(false);
  });

  it("cannot refill after shutdown releases a command floor", async () => {
    const bench = harness();
    await bench.queue.withCommandFloor(async () => {
      await bench.queue.requestAutomatic("remote");
      bench.queue.close();
    });
    await bench.queue.request(true, "all");
    await bench.queue.requestPolling("chat");
    await flush();
    expect(bench.cycles).toEqual([]);
    expect(bench.queue.draining).toBe(false);
  });
});

describe("merging the scopes a batch asked for", () => {
  it("widens rather than running two narrow cycles", () => {
    expect(mergeSyncScopes(new Set<SyncScope>(["files", "chat"]))).toBe("all");
    expect(mergeSyncScopes(new Set<SyncScope>(["remote", "all"]))).toBe("all");
    expect(mergeSyncScopes(new Set<SyncScope>(["files", "remote"]))).toBe(
      "files",
    );
    expect(mergeSyncScopes(new Set<SyncScope>(["chat"]))).toBe("chat");
    expect(mergeSyncScopes(new Set<SyncScope>(["remote"]))).toBe("remote");
  });
});
