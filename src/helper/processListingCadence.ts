export const CURSOR_PROCESS_LIST_INTERVAL_MS = 30_000;

export interface CursorProcessListingState {
  /** Null until the helper has made its first authoritative process listing. */
  lastListingAt: number | null;
  /** Whether the request's originating extension host was absent last tick. */
  hostGone: boolean;
}

export interface CursorProcessListingDecision {
  due: boolean;
  state: CursorProcessListingState;
}

/**
 * Schedules the expensive OS-wide Cursor process listing.
 *
 * The finalizer itself wakes every 500ms so a cancel marker is noticed
 * promptly. That cadence must not become the cadence for spawning `tasklist`
 * or `ps`: once the originating window closes while another Cursor window is
 * still open, `hostGone` remains true for the finalizer's potentially
 * month-long lifetime. The host transition may pull one listing forward, but
 * a standing absence is thereafter checked only on the normal interval.
 */
export function cursorProcessListingDecision(
  previous: CursorProcessListingState,
  now: number,
  hostGone: boolean,
  intervalMs = CURSOR_PROCESS_LIST_INTERVAL_MS,
): CursorProcessListingDecision {
  const hostJustExited = !previous.hostGone && hostGone;
  const clockRolledBack =
    previous.lastListingAt !== null && now < previous.lastListingAt;
  const intervalElapsed =
    previous.lastListingAt !== null &&
    now - previous.lastListingAt >= intervalMs;
  const due =
    previous.lastListingAt === null ||
    hostJustExited ||
    clockRolledBack ||
    intervalElapsed;
  return {
    due,
    state: {
      lastListingAt: due ? now : previous.lastListingAt,
      hostGone,
    },
  };
}
