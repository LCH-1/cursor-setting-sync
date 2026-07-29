import { describe, expect, it } from "vitest";

import { compareCodeUnits } from "../src/protocol/canonical";
import { compareTips } from "../src/protocol/reconciler";
import type { ResourceTip } from "../src/types";

function tip(deviceId: string, eventHash: string): ResourceTip {
  return {
    resourceId: "ui-state/x",
    kind: "ui-state",
    operation: "put",
    semanticHash: "h",
    versionId: `${eventHash}#0`,
    eventHash,
    changeIndex: 0,
    lamport: 7,
    deviceId,
    parents: [],
  } as unknown as ResourceTip;
}

describe("replicated orderings are locale-independent", () => {
  it("compareCodeUnits orders 'ab' after 'aa' regardless of collation rules", () => {
    // Danish/Norwegian collation sorts "aa" AFTER "ab" (aa = å). A device
    // pair split across such locales elected DIFFERENT winners for the same
    // lamport-tied fork and re-forked forever. Code-unit order is the one
    // order every machine computes identically.
    expect(compareCodeUnits("aa", "ab")).toBeLessThan(0);
    expect(compareCodeUnits("ab", "aa")).toBeGreaterThan(0);
    expect(compareCodeUnits("aa", "aa")).toBe(0);
  });

  it("compareTips tie-breaks lamport-equal tips by code units", () => {
    const winner = [tip("aa9-device", "hash-1"), tip("ab2-device", "hash-2")]
      .sort(compareTips)[0];
    // Descending device order by code units: "ab2..." > "aa9...".
    expect(winner?.deviceId).toBe("ab2-device");
  });
});
