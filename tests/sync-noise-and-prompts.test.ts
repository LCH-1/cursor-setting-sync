import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import {
  lockSkipResumedLine,
  noteLockSkip,
  pendingRestartDetail,
  type LockSkipState,
} from "../src/sync/manager";
import {
  LOCK_SKIP_REMINDER_MS,
  RESTART_TO_APPLY_COMMAND,
  RESTART_TO_APPLY_TITLE,
} from "../src/constants";
import type { LockHolderReport } from "../src/platform/lock";
import type { PendingDatabaseChange } from "../src/types";
import manifest from "../package.json";

const T0 = Date.parse("2026-07-27T00:00:00.000Z");
const POLL_MS = 30_000;

function holder(pid: number | null, minutes = 0): LockHolderReport {
  return {
    pid,
    description:
      pid === null
        ? "Another Cursor window or the offline helper is synchronizing."
        : `Another Cursor window or the offline helper (pid ${pid}, last active ${minutes} minute(s) ago) is synchronizing.`,
  };
}

describe("the skipped-sync log flood", () => {
  it("says the first skip of a run immediately", () => {
    const decision = noteLockSkip(null, holder(4242), T0, false);
    expect(decision.line).toContain("pid 4242");
    expect(decision.state).toEqual({ pid: 4242, loggedAt: T0, skipped: 1 });
  });

  it("stays quiet while the same holder is still working", () => {
    const first = noteLockSkip(null, holder(4242), T0, false);
    const second = noteLockSkip(first.state, holder(4242, 1), T0 + POLL_MS, false);
    expect(second.line).toBeNull();
    // The description carries an age that changes every minute, so keying on
    // the sentence would never suppress anything; only the PID is stable.
    expect(second.state).toEqual({ pid: 4242, loggedAt: T0, skipped: 2 });
  });

  it("cuts an hour of continuous contention from 120 lines to 13", () => {
    // Two poll timers at 30 s each, for one hour, against a lock held
    // throughout: this is the reported flood.
    let state: LockSkipState | null = null;
    let logged = 0;
    for (let elapsed = 0; elapsed <= 60 * 60_000; elapsed += POLL_MS) {
      const decision = noteLockSkip(state, holder(4242), T0 + elapsed, false);
      state = decision.state;
      if (decision.line !== null) {
        logged += 1;
      }
    }
    expect(logged).toBe(1 + (60 * 60_000) / LOCK_SKIP_REMINDER_MS);
    expect(state?.skipped).toBe(121);
  });

  it("reports again the moment the reminder interval is reached", () => {
    const first = noteLockSkip(null, holder(4242), T0, false);
    const quiet = noteLockSkip(
      first.state,
      holder(4242),
      T0 + LOCK_SKIP_REMINDER_MS - 1,
      false,
    );
    expect(quiet.line).toBeNull();
    const due = noteLockSkip(
      quiet.state,
      holder(4242),
      T0 + LOCK_SKIP_REMINDER_MS,
      false,
    );
    expect(due.line).toContain("cycle(s) skipped so far");
    expect(due.state.loggedAt).toBe(T0 + LOCK_SKIP_REMINDER_MS);
  });

  it("never swallows a different holder", () => {
    const first = noteLockSkip(null, holder(4242), T0, false);
    const other = noteLockSkip(first.state, holder(9001), T0 + POLL_MS, false);
    expect(other.line).toContain("pid 9001");
    // The count would read as one long wait that never happened.
    expect(other.line).not.toContain("skipped so far");
  });

  it("always answers a sync the user asked for", () => {
    const first = noteLockSkip(null, holder(4242), T0, false);
    const manual = noteLockSkip(first.state, holder(4242), T0 + 1_000, true);
    expect(manual.line).not.toBeNull();
  });

  it("closes out a run only when more than one cycle was skipped", () => {
    expect(lockSkipResumedLine(null)).toBeNull();
    expect(lockSkipResumedLine({ pid: 1, loggedAt: T0, skipped: 1 })).toBeNull();
    expect(lockSkipResumedLine({ pid: 1, loggedAt: T0, skipped: 7 })).toBe(
      "Synchronization resumed after 7 skipped cycle(s).",
    );
  });
});

describe("the queued-changes status detail", () => {
  function pending(kind: string, count: number, blocked = false) {
    return Array.from({ length: count }, (_unused, index) => ({
      eventHash: `${kind}-${index}`,
      changeIndex: index,
      resourceId: `${kind}/${index}`,
      kind,
      ...(blocked ? { blockedReason: "Created by a newer Cursor." } : {}),
    })) as PendingDatabaseChange[];
  }

  it("never tells the user to restart Cursor", () => {
    // The reported incident: 227 queued changes, none blocked, and a status
    // bar that said "227 change(s) are waiting for restart."
    const detail = pendingRestartDetail([
      ...pending("chat", 175),
      ...pending("ui-state", 39),
      ...pending("chat-transcript", 13),
    ]);
    expect(detail).toContain(RESTART_TO_APPLY_TITLE);
    expect(detail).toContain("quitting and reopening Cursor does not");
    expect(detail).not.toContain("waiting for restart");
  });

  it("names the kinds so the missing data is recognizable", () => {
    const detail = pendingRestartDetail([
      ...pending("chat", 175),
      ...pending("ui-state", 39),
      ...pending("chat-transcript", 13),
    ]);
    expect(detail).toContain("227 change(s)");
    expect(detail).toContain("175 chat, 39 ui-state, 13 chat-transcript");
  });

  it("offers nothing to apply when every change is deferred", () => {
    const detail = pendingRestartDetail(pending("chat", 4, true));
    expect(detail).toBe("4 newer-version database change(s) are deferred.");
    expect(detail).not.toContain(RESTART_TO_APPLY_TITLE);
  });

  it("reports both halves when only some changes are deferred", () => {
    const detail = pendingRestartDetail([
      ...pending("chat", 2),
      ...pending("extension", 1, true),
    ]);
    expect(detail).toContain("2 change(s)");
    expect(detail).toContain("1 newer-version database change(s) are deferred.");
  });
});

describe("the command the affordances name", () => {
  it("is spelled exactly as the palette contributes it", () => {
    // A renamed palette title with a stale constant would put the user back
    // where they started: told to run a command that does not exist.
    const contributed = manifest.contributes.commands.find(
      (command) => command.command === RESTART_TO_APPLY_COMMAND,
    );
    expect(contributed?.title).toBe(RESTART_TO_APPLY_TITLE);
    expect(manifest.activationEvents).toContain(
      `onCommand:${RESTART_TO_APPLY_COMMAND}`,
    );
  });
});
