import { describe, expect, it } from "vitest";

import { createPollPlan } from "../src/sync/pollPlan";

describe("background polling plan", () => {
  it("uses one widened loop when file and chat cadences match", () => {
    expect(createPollPlan(30_000, 30_000, true)).toEqual([
      { scope: "all", intervalMs: 30_000 },
    ]);
  });

  it("keeps different cadences independent", () => {
    expect(createPollPlan(60_000, 30_000, true)).toEqual([
      { scope: "files", intervalMs: 60_000 },
      { scope: "chat", intervalMs: 30_000 },
    ]);
  });

  it("does not create a chat loop when chat sync is disabled", () => {
    expect(createPollPlan(45_000, 30_000, false)).toEqual([
      { scope: "files", intervalMs: 45_000 },
    ]);
  });
});
