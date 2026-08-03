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

    // Two poll ticks land while that first cycle is still running.
    void bench.queue.request(false, "files");
    void bench.queue.request(false, "chat");
    expect(await settledState(command)).toBe("pending");

    bench.finish();
    expect(await settledState(command)).toBe("resolved");
    // ...and the drain carried straight on with the refill, so nothing the
    // timers asked for was lost in exchange.
    expect(bench.cycles).toEqual([
      { manual: true, scope: "all" },
      { manual: false, scope: "all" },
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
