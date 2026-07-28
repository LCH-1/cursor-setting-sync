import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { queuedApplyPrompt } from "../src/sync/manager";
import { RESTART_TO_APPLY_TITLE } from "../src/constants";
import type { PendingDatabaseChange } from "../src/types";

function pending(
  kind: PendingDatabaseChange["kind"],
  count: number,
): PendingDatabaseChange[] {
  return Array.from({ length: count }, (_unused, index) => ({
    resourceId: `${kind}/${index}`,
    kind,
    eventHash: `hash-${index}`,
    changeIndex: index,
    queuedAt: 0,
  }));
}

describe("the queued-apply offer", () => {
  it("says how much is waiting and of what", () => {
    const message = queuedApplyPrompt([
      ...pending("chat", 69),
      ...pending("workspace-storage", 2),
    ]);
    expect(message).toContain("71 change(s)");
    expect(message).toContain("69 chat");
    expect(message).toContain("2 workspace-storage");
  });

  it("denies the reading that a restart is enough", () => {
    // This device sat at 71 queued changes across three separate restarts. The
    // owner had done everything the queue described - closed Cursor, reopened
    // it - and the number never moved, because only the command drains it. The
    // sentence exists so that nobody has to work that out from the outcome.
    const message = queuedApplyPrompt(pending("chat", 69));
    expect(message).toMatch(/restarting cursor yourself does not/i);
  });

  it("warns that one pass may not finish a large queue", () => {
    // MAX_APPLY_BATCH_BYTES truncates the batch silently; a user who is not
    // told reads the remainder as the same failure recurring.
    expect(queuedApplyPrompt(pending("chat", 400))).toMatch(
      /more than one pass/i,
    );
  });

  it("never claims the status bar will apply anything on a click", () => {
    // The item is deliberately inert: quitting Cursor must not sit one misclick
    // away from the item beside it. Text promising otherwise would be the
    // label/action mismatch that already shipped once.
    const message = queuedApplyPrompt(pending("chat", 3));
    expect(message).not.toMatch(/click .{0,20}status bar/i);
    expect(RESTART_TO_APPLY_TITLE.length).toBeGreaterThan(0);
  });
});
