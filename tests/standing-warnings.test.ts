import { describe, expect, it } from "vitest";
import {
  RECONCILER_WARNING_SOURCE,
  StandingWarningRegistry,
  formatStandingDuration,
  formatWarningLine,
  standingWarningDiagnostics,
} from "../src/sync/warningLog";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-07-25T00:00:00.000Z");
const CHAT = "state-vscdb-chat";

function sources(
  entries: Record<string, readonly string[]>,
): Map<string, readonly string[]> {
  return new Map(Object.entries(entries));
}

describe("standing warning registry", () => {
  it("logs a warning when it appears and stays quiet while it persists", () => {
    const registry = new StandingWarningRegistry(HOUR);

    expect(
      registry.observe({ sources: sources({ [CHAT]: ["gap"] }), now: T0 }),
    ).toEqual([
      { source: CHAT, warning: "gap", reason: "new", standingForMs: 0 },
    ]);
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + 30_000,
      }),
    ).toEqual([]);
  });

  it("keeps an unrun source's bucket across a files/chat scope alternation", () => {
    // One global "warnings from the last cycle" set does not work here: the
    // files cycle in the middle erases the chat warning, and it reads as new
    // again on the next chat cycle.
    const registry = new StandingWarningRegistry(HOUR);

    expect(
      registry.observe({ sources: sources({ [CHAT]: ["gap"] }), now: T0 }),
    ).toHaveLength(1);
    expect(
      registry.observe({
        sources: sources({ settings: [] }),
        now: T0 + 30_000,
      }),
    ).toEqual([]);
    expect(
      registry.observe({
        sources: sources({ settings: [] }),
        now: T0 + 60_000,
      }),
    ).toEqual([]);
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + 90_000,
      }),
    ).toEqual([]);
  });

  it("logs a warning again after its own source reported it clear", () => {
    const registry = new StandingWarningRegistry(HOUR);

    registry.observe({ sources: sources({ [CHAT]: ["gap"] }), now: T0 });
    expect(
      registry.observe({ sources: sources({ [CHAT]: [] }), now: T0 + 1_000 }),
    ).toEqual([]);
    expect(registry.standing()).toEqual([]);
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + 2_000,
      }),
    ).toEqual([
      { source: CHAT, warning: "gap", reason: "new", standingForMs: 0 },
    ]);
  });

  it("reminds on the interval rather than on every poll", () => {
    const registry = new StandingWarningRegistry(HOUR);

    registry.observe({ sources: sources({ [CHAT]: ["gap"] }), now: T0 });
    for (let elapsed = 30_000; elapsed < HOUR; elapsed += 30_000) {
      expect(
        registry.observe({
          sources: sources({ [CHAT]: ["gap"] }),
          now: T0 + elapsed,
        }),
      ).toEqual([]);
    }
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + HOUR,
      }),
    ).toEqual([
      {
        source: CHAT,
        warning: "gap",
        reason: "reminder",
        standingForMs: HOUR,
      },
    ]);
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + HOUR + 30_000,
      }),
    ).toEqual([]);
  });

  it("never lets a standing reconciler warning go silent forever", () => {
    const registry = new StandingWarningRegistry(HOUR);
    const logged: string[] = [];

    // Two hours of 30-second cycles: the stream gap blocks compaction the whole
    // time, so it must be re-stated, and exactly three times, not 240.
    for (let cycle = 0; cycle <= 240; cycle += 1) {
      for (const entry of registry.observe({
        sources: sources({ [RECONCILER_WARNING_SOURCE]: ["stream gap"] }),
        now: T0 + cycle * 30_000,
      })) {
        logged.push(formatWarningLine(entry));
      }
    }

    expect(logged).toEqual([
      "Warning [reconciler]: stream gap",
      "Warning [reconciler] (unchanged for 1h): stream gap",
      "Warning [reconciler] (unchanged for 2h): stream gap",
    ]);
  });

  it("logs everything on a manual sync and restarts the reminder clock", () => {
    const registry = new StandingWarningRegistry(HOUR);

    registry.observe({ sources: sources({ [CHAT]: ["gap"] }), now: T0 });
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + 10 * 60_000,
        force: true,
      }),
    ).toEqual([
      {
        source: CHAT,
        warning: "gap",
        reason: "manual",
        standingForMs: 10 * 60_000,
      },
    ]);
    // The reminder is now due an hour after the manual run, not after T0.
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + HOUR,
      }),
    ).toEqual([]);
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + HOUR + 10 * 60_000,
      })[0]?.reason,
    ).toBe("reminder");
  });

  it("echoes a source the manual cycle did not run without clearing or re-timing it", () => {
    const registry = new StandingWarningRegistry(HOUR);

    registry.observe({ sources: sources({ [CHAT]: ["gap"] }), now: T0 });
    expect(
      registry.observe({
        sources: sources({ settings: [] }),
        now: T0 + 60_000,
        force: true,
      }),
    ).toEqual([
      {
        source: CHAT,
        warning: "gap",
        reason: "manual",
        standingForMs: 60_000,
      },
    ]);
    expect(registry.standingFor(CHAT)).toHaveLength(1);
    // The echo did not re-verify the warning, so the original clock still runs.
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + HOUR - 1,
      }),
    ).toEqual([]);
    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap"] }),
        now: T0 + HOUR,
      })[0]?.reason,
    ).toBe("reminder");
  });

  it("collapses a warning repeated within one cycle", () => {
    const registry = new StandingWarningRegistry(HOUR);

    expect(
      registry.observe({
        sources: sources({ [CHAT]: ["gap", "gap"] }),
        now: T0,
      }),
    ).toHaveLength(1);
  });

  it("treats identical text from two sources as two independent warnings", () => {
    const registry = new StandingWarningRegistry(HOUR);
    const text = "Adapter scan failed: EBUSY";

    expect(
      registry.observe({
        sources: sources({ settings: [text], profiles: [text] }),
        now: T0,
      }),
    ).toHaveLength(2);
    expect(
      registry.observe({
        sources: sources({ settings: [] }),
        now: T0 + 1_000,
      }),
    ).toEqual([]);
    expect(registry.standing().map((entry) => entry.source)).toEqual([
      "profiles",
    ]);
  });

  it("drops buckets for adapters that no longer exist", () => {
    const registry = new StandingWarningRegistry(HOUR);

    registry.observe({
      sources: sources({ [CHAT]: ["gap"], settings: ["broken"] }),
      now: T0,
    });
    registry.retainSources(new Set([RECONCILER_WARNING_SOURCE, "settings"]));

    expect(registry.standing().map((entry) => entry.source)).toEqual([
      "settings",
    ]);
  });
});

describe("standing warnings in Show Diagnostics", () => {
  it("projects every standing warning with its age and maintenance impact", () => {
    const registry = new StandingWarningRegistry(HOUR);
    registry.observe({
      sources: sources({ [RECONCILER_WARNING_SOURCE]: ["stream gap"] }),
      now: T0,
    });
    registry.observe({
      sources: sources({
        [RECONCILER_WARNING_SOURCE]: ["stream gap"],
        [CHAT]: ["no body"],
      }),
      now: T0 + HOUR,
    });

    // What showDiagnostics writes into its JSON document.
    const diagnostics = standingWarningDiagnostics(
      registry.standing(),
      T0 + 2 * HOUR + 11 * 60_000,
    );

    expect(diagnostics).toEqual([
      {
        source: RECONCILER_WARNING_SOURCE,
        warning: "stream gap",
        firstSeenAt: new Date(T0).toISOString(),
        standingFor: "2h 11m",
        lastLoggedAt: new Date(T0 + HOUR).toISOString(),
        observations: 2,
        blocksMaintenance: true,
        blocksPublish: false,
      },
      {
        source: CHAT,
        warning: "no body",
        firstSeenAt: new Date(T0 + HOUR).toISOString(),
        standingFor: "1h 11m",
        lastLoggedAt: new Date(T0 + HOUR).toISOString(),
        observations: 1,
        blocksMaintenance: false,
        blocksPublish: false,
      },
    ]);
  });

  it("formats durations coarsely", () => {
    expect(formatStandingDuration(0)).toBe("0s");
    expect(formatStandingDuration(45_000)).toBe("45s");
    expect(formatStandingDuration(4 * 60_000)).toBe("4m");
    expect(formatStandingDuration(2 * HOUR)).toBe("2h");
    expect(formatStandingDuration(2 * HOUR + 11 * 60_000)).toBe("2h 11m");
    expect(formatStandingDuration(27 * HOUR)).toBe("1d 3h");
  });
});
