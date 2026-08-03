import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { helperRunDuration, isInterruptedResult } from "../src/sync/manager";

const REOPENED =
  "CursorReopenedError: Cursor was reopened before offline changes could be applied. Close Cursor and try again.";

describe("a shutdown pass cut short by the editor reopening", () => {
  it("is told apart from a failure the user has to act on", () => {
    // Nothing was written and the queue is intact, so this calls for a log
    // line, not the red status bar and notification a real failure gets.
    // It became the routine outcome when 0.0.49 started applying the whole
    // queue at shutdown rather than only exporting: that pass takes minutes,
    // and reopening the editor inside that window is not a mistake. Painting
    // it red teaches the user to ignore the one signal that means their data
    // did not land.
    expect(isInterruptedResult({ interrupted: true })).toBe(true);
    expect(isInterruptedResult({ interrupted: true, error: REOPENED })).toBe(true);
  });

  it("recognizes the run that reports without the flag", () => {
    // The finalizer is spawned at startup and holds that build's code, so the
    // first shutdown after an update is handled by the PREVIOUS version's
    // helper - the one release that introduces the flag reports without it
    // exactly once. Falling back to the message keeps that run quiet too.
    expect(isInterruptedResult({ error: REOPENED })).toBe(true);
  });

  it("leaves a real failure alone", () => {
    for (const error of [
      "SQLite quick_check failed: wrong # of entries in index",
      "Timed out waiting for Cursor to exit.",
      "Unsupported helper Node runtime: v18.0.0",
      null,
    ] satisfies Array<string | null>) {
      expect(isInterruptedResult({ error })).toBe(false);
    }
    expect(isInterruptedResult({})).toBe(false);
    expect(isInterruptedResult({ interrupted: false, error: "disk full" })).toBe(
      false,
    );
  });
});

describe("how long the offline pass took", () => {
  it("is reported, because Cursor is closed for all of it", () => {
    // The apply runs with the editor shut, so there is no UI it could report
    // into while it works. The completion line is the only place the duration
    // is ever visible - without it a pass that took four minutes and one that
    // took four seconds read identically.
    expect(
      helperRunDuration({
        startedAt: "2026-08-03T10:00:00.000Z",
        completedAt: "2026-08-03T10:03:12.000Z",
      }),
    ).toBe(" in 3m 12s");
    expect(
      helperRunDuration({
        startedAt: "2026-08-03T10:00:00.000Z",
        completedAt: "2026-08-03T10:00:07.000Z",
      }),
    ).toBe(" in 7s");
  });

  it("says nothing when the helper did not report a start time", () => {
    // A helper armed before this shipped is still the one that runs at the
    // first shutdown after the update.
    expect(helperRunDuration({ completedAt: "2026-08-03T10:00:00.000Z" })).toBe("");
    expect(helperRunDuration({})).toBe("");
  });
});
