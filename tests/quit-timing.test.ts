import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  commands: {},
  workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }) },
  extensions: { all: [] },
}));

import {
  CURSOR_EXIT_WAIT_MS,
  FINALIZER_EXIT_WAIT_MS,
  QUIT_START_GRACE_MS,
} from "../src/constants";
import { QUIT_VETO_CHECK_DELAY_MS } from "../src/helper/launcher";
import { QUIT_STALLED_MESSAGE } from "../src/sync/manager";

describe("the quit timing budgets", () => {
  it("re-arms the shutdown finalizer only after the apply helper has given up", () => {
    // A re-armed finalizer is itself a Cursor.exe, so re-arming inside the
    // helper's exit budget would keep it from ever seeing zero - turning an
    // intermittent timeout into a certain one.
    expect(QUIT_VETO_CHECK_DELAY_MS).toBeGreaterThan(CURSOR_EXIT_WAIT_MS);
  });

  it("warns about a stalled quit while the helper is still waiting", () => {
    // News that arrives after the helper has given up is a postmortem, not a
    // chance to fix it: closing Cursor by hand has to still complete the apply.
    expect(QUIT_START_GRACE_MS).toBeLessThan(CURSOR_EXIT_WAIT_MS);
    // And comfortably longer than a quit that is actually working, which tears
    // the extension host down in a second or two.
    expect(QUIT_START_GRACE_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("lets the shutdown finalizer outlast any plausible editing session", () => {
    // Tempting to shorten - it is the process users find still running - but a
    // finalizer that times out never reaches exportFinalChanges, and `restart`
    // is false for that mode, so the session's workspaceStorage backup is
    // simply gone. Anyone who leaves Cursor open past the budget pays it.
    expect(FINALIZER_EXIT_WAIT_MS).toBeGreaterThanOrEqual(
      7 * 24 * 60 * 60 * 1000,
    );
  });
});

describe("the stalled-quit message", () => {
  it("never tells the user to kill Cursor processes", () => {
    // The offline helper is a Cursor.exe, and so is the shutdown finalizer
    // whose only job is the workspaceStorage backup. "End all Cursor.exe
    // tasks" destroys exactly what the user is trying to move.
    for (const forbidden of ["kill", "End task", "Task Manager", "taskkill"]) {
      expect(QUIT_STALLED_MESSAGE.toLowerCase()).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });

  it("says what to do and that nothing is lost", () => {
    expect(QUIT_STALLED_MESSAGE).toContain("Closing Cursor yourself");
    expect(QUIT_STALLED_MESSAGE).toContain("Nothing is lost");
  });

  it("states what was observed rather than diagnosing the quit", () => {
    // A multi-window quit closes windows serially and the window that ran the
    // command need not be first, so "Cursor has not started closing" can be
    // false while it is in fact closing. "Still open after N seconds" is the
    // whole of what this probe actually knows.
    expect(QUIT_STALLED_MESSAGE).toContain("still open");
    expect(QUIT_STALLED_MESSAGE).toContain(
      `${Math.round(QUIT_START_GRACE_MS / 1000)} seconds ago`,
    );
    expect(QUIT_STALLED_MESSAGE).not.toContain("has not started closing");
  });
});
