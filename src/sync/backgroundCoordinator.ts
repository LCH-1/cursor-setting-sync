import type { FileLock } from "../platform/lock";

export interface ProbeCancellation {
  cancel(): void;
}

export type ProbeScheduler = (
  callback: () => void,
  delayMs: number,
) => ProbeCancellation;

export interface BackgroundCoordinatorOptions {
  acquire(): Promise<FileLock | null>;
  activate(
    runInitialSync: boolean,
    isCurrent: () => boolean,
  ): Promise<void>;
  /** Must synchronously close every watcher and timer created by activate. */
  deactivate(): void;
  scheduleProbe?: ProbeScheduler;
  probeDelayMs?: () => number;
  onError?: (error: unknown) => void;
}

interface OwnedLock {
  generation: number;
  lock: FileLock;
}

interface PendingProbe {
  cancellation: ProbeCancellation | null;
}

const DEFAULT_PROBE_MIN_DELAY_MS = 15_000;
const DEFAULT_PROBE_JITTER_MS = 15_000;

/**
 * Elects one extension host to own machine-wide background work.
 *
 * Public operations are serialized, while their generation is invalidated at
 * call time. That distinction lets an activation waiting for a finalizer see
 * `isCurrent() === false` immediately, without allowing its replacement to
 * acquire until the old lock's asynchronous release has completed.
 */
export class BackgroundCoordinator {
  private readonly options: BackgroundCoordinatorOptions;
  private operationTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private shouldRun = false;
  private disposed = false;
  private owned: OwnedLock | null = null;
  private activated = false;
  private probe: PendingProbe | null = null;

  constructor(options: BackgroundCoordinatorOptions) {
    this.options = options;
  }

  /** True only after this generation has both acquired and activated. */
  get active(): boolean {
    const owned = this.owned;
    return (
      this.activated &&
      owned !== null &&
      this.isCurrent(owned.generation, owned.lock)
    );
  }

  /**
   * Restarts election for the latest configuration.
   *
   * A follower resolves normally with `active === false` and one jittered
   * probe. Operational failures are delivered through `onError` and retried
   * the same way, so timer callbacks never create unhandled rejections.
   */
  start(runInitialSync = false): Promise<void> {
    if (this.disposed) {
      return this.operationTail;
    }
    this.shouldRun = true;
    const generation = ++this.generation;
    this.cancelProbe();
    this.activated = false;
    this.deactivateNow();
    // Begin releasing immediately. The queued attempt also awaits it, which is
    // the important part when configuration changes arrive back-to-back.
    const release = this.releaseOwned();
    return this.enqueue(async () => {
      await release;
      if (this.isRequestedGeneration(generation)) {
        await this.attempt(generation, runInitialSync);
      }
    });
  }

  /**
   * Stops runtime work synchronously and resolves once every earlier owner has
   * finished releasing its file lock. A later start is still allowed.
   */
  stop(): Promise<void> {
    return this.standDown(false);
  }

  /** Permanently stops this coordinator and cancels every pending probe. */
  dispose(): Promise<void> {
    return this.standDown(true);
  }

  /**
   * Refreshes the current lock as an explicit ownership check.
   *
   * A proven foreign token stands the runtime down immediately. Cleanup and a
   * new jittered election continue asynchronously, while the caller gets a
   * synchronous false result and can abort its critical section.
   */
  validateOwnership(): boolean {
    const owned = this.owned;
    if (!this.active || owned === null) {
      return false;
    }
    try {
      owned.lock.refresh();
      return this.active && this.owned === owned;
    } catch (error) {
      this.report(error);
      const generation = ++this.generation;
      this.activated = false;
      this.cancelProbe();
      this.deactivateNow();
      const release = this.releaseSpecific(owned);
      void this.enqueue(async () => {
        await release;
        if (this.isRequestedGeneration(generation)) {
          this.scheduleProbe(generation);
        }
      }).catch((queueError: unknown) => this.report(queueError));
      return false;
    }
  }

  private standDown(permanently: boolean): Promise<void> {
    if (permanently) {
      this.disposed = true;
    }
    this.shouldRun = false;
    ++this.generation;
    this.cancelProbe();
    this.activated = false;
    this.deactivateNow();
    const release = this.releaseOwned();
    return this.enqueue(async () => {
      await release;
      // An acquire already in flight when stop was called may have installed a
      // lock before noticing its stale generation. The serialized attempt
      // releases that local lock first; this second pass covers future changes
      // to an activation implementation without weakening stop's contract.
      await this.releaseOwned();
    });
  }

  private async attempt(
    generation: number,
    runInitialSync: boolean,
  ): Promise<void> {
    if (!this.isRequestedGeneration(generation)) {
      return;
    }
    let lock: FileLock | null;
    try {
      lock = await this.options.acquire();
    } catch (error) {
      this.report(error);
      if (this.isRequestedGeneration(generation)) {
        this.scheduleProbe(generation);
      }
      return;
    }
    if (lock === null) {
      if (this.isRequestedGeneration(generation)) {
        this.scheduleProbe(generation);
      }
      return;
    }
    if (!this.isRequestedGeneration(generation)) {
      await this.releaseLock(lock);
      return;
    }

    const owned: OwnedLock = { generation, lock };
    this.owned = owned;
    try {
      // Besides heartbeating before potentially long initialization, refresh
      // makes ownership loss injectable and directly testable.
      lock.refresh();
      await this.options.activate(runInitialSync, () =>
        this.isCurrent(generation, lock),
      );
      if (!this.isCurrent(generation, lock)) {
        // A defensive second cleanup covers an activation implementation that
        // resumed after cancellation without consulting its isCurrent seam.
        // The operation queue guarantees no replacement activation exists yet.
        this.deactivateNow();
        await this.releaseSpecific(owned);
        return;
      }
      lock.refresh();
      if (!this.isCurrent(generation, lock)) {
        this.deactivateNow();
        await this.releaseSpecific(owned);
        return;
      }
      this.activated = true;
    } catch (error) {
      this.report(error);
      this.activated = false;
      this.deactivateNow();
      await this.releaseSpecific(owned);
      if (this.isRequestedGeneration(generation)) {
        this.scheduleProbe(generation);
      }
    }
  }

  private isCurrent(generation: number, lock: FileLock): boolean {
    return (
      this.isRequestedGeneration(generation) &&
      this.owned?.lock === lock &&
      this.owned.generation === generation
    );
  }

  private isRequestedGeneration(generation: number): boolean {
    return (
      !this.disposed && this.shouldRun && generation === this.generation
    );
  }

  private scheduleProbe(generation: number): void {
    if (this.probe !== null || !this.isRequestedGeneration(generation)) {
      return;
    }
    const pending: PendingProbe = { cancellation: null };
    this.probe = pending;
    try {
      pending.cancellation = (this.options.scheduleProbe ?? defaultScheduler)(
        () => {
          if (this.probe !== pending) {
            return;
          }
          this.probe = null;
          if (!this.isRequestedGeneration(generation)) {
            return;
          }
          void this.enqueue(() => this.attempt(generation, true)).catch(
            (error: unknown) => this.report(error),
          );
        },
        (this.options.probeDelayMs ?? defaultProbeDelay)(),
      );
    } catch (error) {
      if (this.probe === pending) {
        this.probe = null;
      }
      this.report(error);
    }
  }

  private cancelProbe(): void {
    const probe = this.probe;
    this.probe = null;
    try {
      probe?.cancellation?.cancel();
    } catch (error) {
      this.report(error);
    }
  }

  private releaseOwned(): Promise<void> {
    const owned = this.owned;
    return owned === null ? Promise.resolve() : this.releaseSpecific(owned);
  }

  private releaseSpecific(owned: OwnedLock): Promise<void> {
    if (this.owned !== owned) {
      // A newer start/stop already detached this owner and began its release.
      return Promise.resolve();
    }
    this.owned = null;
    this.activated = false;
    return this.releaseLock(owned.lock);
  }

  private async releaseLock(lock: FileLock): Promise<void> {
    try {
      await lock.release();
    } catch (error) {
      this.report(error);
    }
  }

  private deactivateNow(): void {
    try {
      this.options.deactivate();
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics must not break election or lock cleanup.
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.catch(() => {});
    return result;
  }
}

function defaultProbeDelay(): number {
  return (
    DEFAULT_PROBE_MIN_DELAY_MS +
    Math.floor(Math.random() * DEFAULT_PROBE_JITTER_MS)
  );
}

function defaultScheduler(
  callback: () => void,
  delayMs: number,
): ProbeCancellation {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
