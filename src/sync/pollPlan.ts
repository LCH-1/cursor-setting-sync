import type { SyncScope } from "./cycleQueue";

export interface PollPlanEntry {
  scope: SyncScope;
  intervalMs: number;
}

/**
 * The smallest set of periodic loops that covers the configured resources.
 *
 * File and chat polling default to the same cadence. Keeping two loops in
 * that case guarantees two lock windows and two repository reconciliations
 * for the same instant, so one widened `all` cycle replaces them.
 */
export function createPollPlan(
  filesIntervalMs: number,
  chatIntervalMs: number,
  syncChat: boolean,
): PollPlanEntry[] {
  if (syncChat && filesIntervalMs === chatIntervalMs) {
    return [{ scope: "all", intervalMs: filesIntervalMs }];
  }
  const plan: PollPlanEntry[] = [
    { scope: "files", intervalMs: filesIntervalMs },
  ];
  if (syncChat) {
    plan.push({ scope: "chat", intervalMs: chatIntervalMs });
  }
  return plan;
}
