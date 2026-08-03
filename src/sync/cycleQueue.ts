/**
 * The scheduler in front of the synchronization cycle.
 *
 * Three sources ask for a sync - the two poll timers, the shared-folder
 * watcher, and the user - and only one cycle may run at a time, so requests
 * are coalesced into a queue and drained in order. What makes this its own
 * module rather than three fields on the manager is that both of the rules
 * below are invisible until a repository gets big enough for one cycle to
 * outlast the poll interval, at which point they decide whether a command the
 * user invoked ever returns.
 */

export type SyncScope = "all" | "files" | "chat" | "remote";

/**
 * The single scope that covers everything the queued requests asked for.
 *
 * Widening is always safe - a cycle may look at more than it was asked to -
 * so the merge climbs to "all" rather than trying to run two narrow cycles.
 */
export function mergeSyncScopes(scopes: ReadonlySet<SyncScope>): SyncScope {
  if (scopes.has("all") || (scopes.has("files") && scopes.has("chat"))) {
    return "all";
  }
  if (scopes.has("files")) {
    return "files";
  }
  if (scopes.has("chat")) {
    return "chat";
  }
  return "remote";
}

/** A caller parked on the cycle that took its scope. */
interface CycleWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Releases one cycle's callers; `null` means the cycle succeeded. */
function settle(waiters: readonly CycleWaiter[], error: unknown): void {
  for (const waiter of waiters) {
    if (error === null) {
      waiter.resolve();
    } else {
      waiter.reject(error);
    }
  }
}

export interface SyncCycleQueueOptions {
  /** Runs one synchronization cycle. */
  runCycle: (manual: boolean, scope: SyncScope) => Promise<void>;
  /**
   * Runs between drains, not between cycles: the maintenance phases take the
   * same lock a cycle holds, so they cannot overlap one.
   */
  runMaintenance: () => Promise<void>;
  /** Reports a failure of an automatic request nobody is awaiting. */
  onAutomaticFailure: (error: unknown) => void;
}

export class SyncCycleQueue {
  private readonly pendingScopes = new Set<SyncScope>();
  private pendingManual = false;
  /**
   * One entry per {@link request} caller still waiting for its cycle.
   *
   * Callers used to await the drain loop itself, which resolves only once the
   * queue is empty - and on a repository where one cycle outlasts the poll
   * interval the queue is never empty, because the timers and the watcher
   * refill it while the cycle they are queued behind is still running. The
   * drain kept working correctly and the caller simply never heard back.
   * "Restart to Apply" opens with a synchronize, so on a large repository it
   * sat on its first phase for as long as the user was willing to wait, while
   * the output channel showed cycle after cycle completing fine.
   */
  private readonly waiters: CycleWaiter[] = [];
  private drain: Promise<void> | null = null;
  private floor = 0;
  private readonly deferredScopes = new Set<SyncScope>();

  constructor(private readonly options: SyncCycleQueueOptions) {}

  /** True while a drain is in flight. */
  get draining(): boolean {
    return this.drain !== null;
  }

  /** True while a command holds the floor. */
  get commandRunning(): boolean {
    return this.floor > 0;
  }

  /**
   * Resolves when the drain in flight, if any, has ended.
   *
   * Only safe once nothing can refill the queue - a drain outlives every
   * individual request by design. Disconnect uses it after stopping the
   * timers and closing the watcher, to keep the last cycle from publishing
   * into a folder the user was just told this device had left.
   */
  async settled(): Promise<void> {
    await this.drain;
  }

  /**
   * Queues a request and resolves when the cycle that takes its scope ends.
   *
   * Not when the queue empties: see {@link waiters}.
   */
  request(manual: boolean, scope: SyncScope): Promise<void> {
    this.pendingScopes.add(scope);
    this.pendingManual ||= manual;
    // Pushed before the drain is started below, because an async function
    // body runs up to its first `await` synchronously and the first thing the
    // loop does is claim the waiters.
    const cycle = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (this.drain === null) {
      this.drain = this.drainQueue().finally(() => {
        this.drain = null;
      });
      // Nothing awaits the drain itself, so an escape from it would be an
      // unhandled rejection: every outcome reaches callers through the cycle
      // promise above instead.
      void this.drain.catch(() => undefined);
    }
    return cycle;
  }

  /**
   * A request from a timer or the watcher rather than the user.
   *
   * Withheld while a command holds the floor - remembered, not dropped, since
   * the scope decides what the next cycle even looks at and discarding a
   * watcher's "remote" would leave the folder's changes unread until
   * something else asked for that scope by name.
   */
  requestAutomatic(scope: SyncScope): Promise<void> {
    if (this.floor > 0) {
      this.deferredScopes.add(scope);
      return Promise.resolve();
    }
    return this.request(false, scope);
  }

  /**
   * Runs a user-invoked command with the automatic cycle standing down.
   *
   * Commands take the same file lock the background cycle does, and wait a
   * bounded time for it. That is ample against one cycle and hopeless against
   * a queue that refills itself: the timers and the watcher hand the drain a
   * fresh scope while the current cycle is still running, so on a repository
   * where a cycle outlasts the interval the lock is never free for long
   * enough and the command the user asked for loses to this window's own
   * polling - reported back as "this window's own background synchronization
   * is still running", which is true and useless, because waiting longer
   * cannot help.
   */
  async withCommandFloor<T>(run: () => Promise<T>): Promise<T> {
    this.floor += 1;
    try {
      return await run();
    } finally {
      this.floor -= 1;
      if (this.floor === 0 && this.deferredScopes.size > 0) {
        const scope = mergeSyncScopes(this.deferredScopes);
        this.deferredScopes.clear();
        void this.request(false, scope).catch((error: unknown) => {
          this.options.onAutomaticFailure(error);
        });
      }
    }
  }

  private async drainQueue(): Promise<void> {
    let escaped: unknown = null;
    try {
      do {
        while (this.pendingScopes.size > 0) {
          const scope = mergeSyncScopes(this.pendingScopes);
          const manual = this.pendingManual;
          this.pendingScopes.clear();
          this.pendingManual = false;
          // Claimed before the await, and in the same synchronous step as the
          // clear above, so it is exactly the callers whose scopes this cycle
          // just took. A request arriving while the cycle runs lands in the
          // next batch of `pendingScopes`, and its waiter belongs to the
          // cycle that will carry it.
          const carried = this.waiters.splice(0);
          try {
            await this.options.runCycle(manual, scope);
          } catch (error) {
            escaped = error;
            settle(carried, error);
            throw error;
          }
          settle(carried, null);
        }
        // Inside the drain rather than after it: a checkpoint of a multi-GiB
        // repository holds the lock for minutes, and a request issued during
        // that window queues a scope which would otherwise go unnoticed until
        // the next timer.
        await this.options.runMaintenance();
      } while (this.pendingScopes.size > 0);
    } finally {
      // On the normal path this is empty: a waiter is pushed in the same tick
      // as its scope, so anything left here would have kept the loop going. A
      // cycle that threw ends the drain with later callers still parked, and
      // the next drain knows nothing about them.
      //
      // Not the escaping error itself: these callers' cycle never started, and
      // handing them "the lock is held" would have them report a failure that
      // happened to somebody else's request as their own. The reason is still
      // reachable as the cause.
      settle(
        this.waiters.splice(0),
        new Error("The synchronization cycle ended before this request ran.", {
          cause: escaped,
        }),
      );
    }
  }
}
