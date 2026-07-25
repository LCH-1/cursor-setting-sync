import { STANDING_WARNING_REMINDER_MS } from "../constants";
import type { DiagnosticStandingWarning } from "../types";

/** Bucket key for warnings produced by the reconciler rather than an adapter. */
export const RECONCILER_WARNING_SOURCE = "reconciler";
/** Bucket key prefix for warnings raised while deciding what to publish. */
export const PUBLISH_WARNING_SOURCE = "publish";
/** Bucket key for warnings raised while auto-merging a conflict. */
export const AUTO_MERGE_WARNING_SOURCE = "auto-merge";
/**
 * Bucket key for warnings the offline helper reported.
 *
 * The helper runs in its own process after the extension host is gone, so
 * nothing it discovers can reach the status bar or diagnostics by itself. Its
 * warnings used to be a single output-channel line on an otherwise successful
 * result, which is quieter than the hard failure the guard replaced: the
 * shutdown export is the ONLY path that backs up workspaceStorage, so a
 * workspace database dropped for being over the payload limit was dropped
 * again on every shutdown, indefinitely, behind a green check mark.
 *
 * The bucket is observed exactly once per consumed batch of helper results, so
 * it stands until a later helper run reports the problem gone.
 */
export const HELPER_WARNING_SOURCE = "offline-helper";

/**
 * Bucket key for the publish warnings owned by one adapter.
 *
 * A publish warning can only be re-derived on a cycle that actually scanned the
 * adapter owning the oversized resource, so it has to be scoped exactly like
 * that adapter's own bucket. One global "publish" bucket looks like an
 * always-run source to {@link StandingWarningRegistry.observe}, and the
 * alternating files/chat poll then cleared and re-created the same warning
 * every other cycle.
 */
export function publishWarningSource(adapterId: string): string {
  return `${PUBLISH_WARNING_SOURCE}:${adapterId}`;
}

/** True for the global publish key and for every per-adapter publish bucket. */
export function isPublishWarningSource(source: string): boolean {
  return (
    source === PUBLISH_WARNING_SOURCE ||
    source.startsWith(`${PUBLISH_WARNING_SOURCE}:`)
  );
}

export interface StandingWarning {
  /**
   * An adapter id, a {@link publishWarningSource} key, or one of the
   * always-computed {@link RECONCILER_WARNING_SOURCE} /
   * {@link AUTO_MERGE_WARNING_SOURCE} keys.
   */
  source: string;
  warning: string;
  /** Epoch ms of the observation that (re)introduced this exact text. */
  firstSeenAt: number;
  lastSeenAt: number;
  lastLoggedAt: number;
  /** Observations of this text since `firstSeenAt`. */
  observations: number;
}

export type WarningLogReason = "new" | "reminder" | "manual";

export interface WarningLogEntry {
  source: string;
  warning: string;
  reason: WarningLogReason;
  /** How long the warning had already been standing; 0 when `reason` is "new". */
  standingForMs: number;
}

export interface WarningObservation {
  /**
   * Only the sources that actually ran this cycle. A source that ran and
   * produced nothing must appear with an empty array — that is the signal that
   * its warnings cleared. A source that did not run must be absent, or an
   * alternating files/chat poll would clear each scope's warnings in turn and
   * make every one of them look new again on the next cycle.
   */
  sources: ReadonlyMap<string, readonly string[]>;
  now: number;
  /** Manual "Sync Now": log everything, including sources that did not run. */
  force?: boolean;
}

/**
 * Remembers which warnings are standing, partitioned by the source that
 * produced them. A warning is logged when it appears, again after it clears and
 * returns, and otherwise only on a bounded reminder interval so a permanent
 * problem cannot go silent for the lifetime of the extension host.
 */
export class StandingWarningRegistry {
  /** source -> warning text -> bucket entry. */
  private readonly buckets = new Map<string, Map<string, StandingWarning>>();

  constructor(
    private readonly reminderIntervalMs: number = STANDING_WARNING_REMINDER_MS,
  ) {}

  observe(input: WarningObservation): WarningLogEntry[] {
    const entries: WarningLogEntry[] = [];
    for (const [source, warnings] of input.sources) {
      const previous = this.buckets.get(source);
      const next = new Map<string, StandingWarning>();
      for (const warning of new Set(warnings)) {
        const standing = previous?.get(warning);
        if (standing === undefined) {
          next.set(warning, {
            source,
            warning,
            firstSeenAt: input.now,
            lastSeenAt: input.now,
            lastLoggedAt: input.now,
            observations: 1,
          });
          entries.push({ source, warning, reason: "new", standingForMs: 0 });
          continue;
        }
        const carried: StandingWarning = {
          ...standing,
          lastSeenAt: input.now,
          observations: standing.observations + 1,
        };
        const due = input.now - standing.lastLoggedAt >= this.reminderIntervalMs;
        if (due || input.force === true) {
          carried.lastLoggedAt = input.now;
          entries.push({
            source,
            warning,
            reason: due ? "reminder" : "manual",
            standingForMs: Math.max(0, input.now - standing.firstSeenAt),
          });
        }
        next.set(warning, carried);
      }
      // Texts absent from `next` genuinely cleared, so they are dropped and
      // will log as "new" if they come back.
      if (next.size === 0) {
        this.buckets.delete(source);
      } else {
        this.buckets.set(source, next);
      }
    }
    if (input.force !== true) {
      return entries;
    }
    // A manual sync must show the user everything that is standing, including
    // buckets no adapter re-verified this cycle. Those were not re-observed, so
    // echoing them must not move their reminder clock.
    for (const [source, bucket] of this.buckets) {
      if (input.sources.has(source)) {
        continue;
      }
      for (const standing of bucket.values()) {
        entries.push({
          source,
          warning: standing.warning,
          reason: "manual",
          standingForMs: Math.max(0, input.now - standing.firstSeenAt),
        });
      }
    }
    return entries;
  }

  /** Every standing warning, oldest first. */
  standing(): StandingWarning[] {
    return [...this.buckets.values()]
      .flatMap((bucket) => [...bucket.values()])
      .sort((left, right) => left.firstSeenAt - right.firstSeenAt);
  }

  standingFor(source: string): StandingWarning[] {
    return [...(this.buckets.get(source)?.values() ?? [])].sort(
      (left, right) => left.firstSeenAt - right.firstSeenAt,
    );
  }

  /** Every standing warning whose bucket key matches, oldest first. */
  standingMatching(match: (source: string) => boolean): StandingWarning[] {
    return this.standing().filter((entry) => match(entry.source));
  }

  /**
   * Drops buckets whose source no longer exists. Adapters come and go with the
   * configuration, and a chat warning left standing after chat sync is turned
   * off would sit in diagnostics forever with nothing able to clear it.
   */
  retainSources(sources: ReadonlySet<string>): void {
    for (const source of [...this.buckets.keys()]) {
      if (!sources.has(source)) {
        this.buckets.delete(source);
      }
    }
  }

  clear(): void {
    this.buckets.clear();
  }
}

export function formatWarningLine(entry: WarningLogEntry): string {
  const qualifier =
    entry.reason === "new"
      ? ""
      : entry.reason === "reminder"
        ? ` (unchanged for ${formatStandingDuration(entry.standingForMs)})`
        : ` (standing for ${formatStandingDuration(entry.standingForMs)})`;
  return `Warning [${entry.source}]${qualifier}: ${entry.warning}`;
}

/** Coarse, human-readable duration: "45s", "4m", "2h 11m", "1d 3h". */
export function formatStandingDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder === 0 ? `${days}d` : `${days}d ${remainder}h`;
}

/** Pure projection for Show Diagnostics, so the shape is testable on its own. */
export function standingWarningDiagnostics(
  entries: readonly StandingWarning[],
  now: number,
): DiagnosticStandingWarning[] {
  return entries.map((entry) => ({
    source: entry.source,
    warning: entry.warning,
    firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
    standingFor: formatStandingDuration(Math.max(0, now - entry.firstSeenAt)),
    lastLoggedAt: new Date(entry.lastLoggedAt).toISOString(),
    observations: entry.observations,
    // A reconciler stream warning is not cosmetic: it hard-blocks compaction
    // and checkpointing until the missing events propagate.
    blocksMaintenance: entry.source === RECONCILER_WARNING_SOURCE,
    // A publish warning means a resource is not reaching the other devices.
    // A helper warning means the same thing for the shutdown half of the
    // cycle: a resource the helper dropped never reached the repository, and
    // for workspaceStorage the helper is the only path that ever would.
    blocksPublish:
      isPublishWarningSource(entry.source) ||
      entry.source === HELPER_WARNING_SOURCE,
  }));
}
