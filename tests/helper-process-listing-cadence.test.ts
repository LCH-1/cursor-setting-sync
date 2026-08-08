import { describe, expect, it } from "vitest";
import {
  CURSOR_PROCESS_LIST_INTERVAL_MS,
  cursorProcessListingDecision,
  type CursorProcessListingState,
} from "../src/helper/processListingCadence";

function initialState(): CursorProcessListingState {
  return { lastListingAt: null, hostGone: false };
}

describe("shutdown finalizer process-list cadence", () => {
  it("lists immediately, then only every 30 seconds while the owner host stays gone", () => {
    let state = initialState();
    const listingTimes: number[] = [];

    // Models two minutes of the finalizer's real 500ms cancel-marker loop.
    // Before this guard, every one of these 241 ticks spawned tasklist once
    // the originating window had closed while another Cursor window remained.
    for (let now = 0; now <= 120_000; now += 500) {
      const decision = cursorProcessListingDecision(state, now, true);
      state = decision.state;
      if (decision.due) {
        listingTimes.push(now);
      }
    }

    expect(listingTimes).toEqual([0, 30_000, 60_000, 90_000, 120_000]);
  });

  it("pulls one listing forward when a live owner exits without turning absence into a busy loop", () => {
    let state = initialState();

    let decision = cursorProcessListingDecision(state, 0, false);
    expect(decision.due).toBe(true);
    state = decision.state;

    decision = cursorProcessListingDecision(state, 5_000, false);
    expect(decision.due).toBe(false);
    state = decision.state;

    decision = cursorProcessListingDecision(state, 6_000, true);
    expect(decision.due).toBe(true);
    state = decision.state;

    decision = cursorProcessListingDecision(state, 6_500, true);
    expect(decision.due).toBe(false);
    state = decision.state;

    decision = cursorProcessListingDecision(
      state,
      6_000 + CURSOR_PROCESS_LIST_INTERVAL_MS,
      true,
    );
    expect(decision.due).toBe(true);
  });

  it("recovers its cadence after a wall-clock rollback", () => {
    const first = cursorProcessListingDecision(initialState(), 50_000, false);
    const rolledBack = cursorProcessListingDecision(
      first.state,
      10_000,
      false,
    );

    expect(rolledBack.due).toBe(true);
    expect(rolledBack.state.lastListingAt).toBe(10_000);
  });
});
