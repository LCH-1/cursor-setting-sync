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
import {
  PERMANENT_EXCLUSION_REASONS,
  isPermanentExclusionReason,
} from "../src/sync/resourcePolicy";
import type { LockHolderReport } from "../src/platform/lock";
import type { PendingDatabaseChange } from "../src/types";
import manifest from "../package.json";

const EXCLUDED_WORKSPACE_REASON =
  "This workspace is excluded by cursorSettingSync.ignoredWorkspaces on this computer.";
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
    expect(detail).toBe("4 change(s) are deferred: Created by a newer Cursor.");
    expect(detail).not.toContain(RESTART_TO_APPLY_TITLE);
  });

  it("reports both halves when only some changes are deferred", () => {
    const detail = pendingRestartDetail([
      ...pending("chat", 2),
      ...pending("extension", 1, true),
    ]);
    expect(detail).toContain("2 change(s)");
    expect(detail).toContain("1 change(s) are deferred: Created by a newer Cursor.");
  });

  it("counts a standing exclusion apart from something that is waiting", () => {
    // A workspace this computer excludes is not deferred - nothing is going to
    // lift it and nobody has to act. Counted together, a correctly configured
    // machine reported "234 change(s) are deferred", which reads as a backlog:
    // on the real pair those were the other computer's 193 local-only folders,
    // held back by exactly the policy meant to hold them back.
    const excluded = pending("workspace-storage", 3, true).map((change) => ({
      ...change,
      blockedReason: EXCLUDED_WORKSPACE_REASON,
    }));
    const detail = pendingRestartDetail([...excluded, ...pending("chat", 1, true)]);

    expect(detail).toContain("1 change(s) are deferred: Created by a newer Cursor.");
    expect(detail).toContain("3 change(s) are excluded by this computer's settings");
    expect(detail).toContain("cursorSettingSync.ignoredWorkspaces");
    expect(detail).not.toContain("4 change(s)");
  });

  it("says nothing about a restart when every change is a standing exclusion", () => {
    const detail = pendingRestartDetail(
      pending("workspace-storage", 234, true).map((change) => ({
        ...change,
        blockedReason: EXCLUDED_WORKSPACE_REASON,
      })),
    );

    expect(detail).toContain("234 change(s) are excluded");
    expect(detail).toContain("not waiting for anything");
    expect(detail).not.toContain(RESTART_TO_APPLY_TITLE);
    expect(detail).not.toContain("deferred");
  });

  it("classifies every reason the block sites can produce", () => {
    // The classification is by exact string, so a reworded reason silently
    // changes which bucket it lands in. These are the constants themselves.
    for (const reason of PERMANENT_EXCLUSION_REASONS) {
      expect(isPermanentExclusionReason(reason)).toBe(true);
    }
    for (const reason of [
      "Created by a newer Cursor.",
      "Workspace mapping is required for incoming workspace storage.",
      "The last apply could not write this resource: disk full",
      undefined,
    ]) {
      expect(isPermanentExclusionReason(reason)).toBe(false);
    }
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
