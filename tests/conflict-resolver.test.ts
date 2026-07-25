import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A quick pick the test drives. Each entry is either an index into the items
 * the resolver offered, or a predicate matched against their labels; returning
 * undefined models the user pressing Escape.
 */
const answers: Array<((labels: string[]) => number | undefined) | undefined> = [];
const offered: string[][] = [];
const executed: Array<{ command: string; args: unknown[] }> = [];

vi.mock("vscode", () => ({
  window: {
    showQuickPick: (items: Array<{ label: string }>) => {
      const labels = items.map((item) => item.label);
      offered.push(labels);
      const answer = answers.shift();
      const index = answer === undefined ? undefined : answer(labels);
      return Promise.resolve(index === undefined ? undefined : items[index]);
    },
  },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  },
  commands: {
    executeCommand: (command: string, ...args: unknown[]) => {
      executed.push({ command, args });
      return Promise.resolve(undefined);
    },
  },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  extensions: { all: [] },
}));

import { EventReconciler, compareTips } from "../src/protocol/reconciler";
import { ConflictController, tipForChoice } from "../src/ui/conflicts";
import { describeConflict, describeValue } from "../src/ui/conflictSummary";
import { SyncRepository } from "../src/protocol/repository";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import type {
  EventProducer,
  ResourceSnapshot,
  ResourceTip,
  SyncConflict,
} from "../src/types";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

const KEYS = ["editor.fontSize", "workbench.colorTheme", "editor.tabSize"];

/** Answers the quick pick with the first item whose label contains `needle`. */
function choose(needle: string): (labels: string[]) => number | undefined {
  return (labels) => {
    const index = labels.findIndex((label) => label.includes(needle));
    if (index < 0) {
      throw new Error(
        `No quick pick item matched ${needle}; offered:\n${labels.join("\n")}`,
      );
    }
    return index;
  };
}

/** Escape. */
const escape = undefined;

beforeEach(() => {
  answers.length = 0;
  offered.length = 0;
  executed.length = 0;
});

describe("conflict resolver overview", () => {
  it("names the resource and shows both values instead of hashes", async () => {
    await withConflicts(async (repository) => {
      answers.push(escape);
      await new ConflictController().collectSelections(repository);

      const list = offered[0] ?? [];
      // The resource's own name, not `settings/default/editor.fontSize`.
      expect(list.some((label) => label === "Setting: editor.fontSize")).toBe(true);
      expect(list.some((label) => label.includes("%2F"))).toBe(false);
      expect(list.some((label) => label.includes("Lamport"))).toBe(false);
    });
  });

  it("offers the three bulk answers before the individual conflicts", async () => {
    await withConflicts(async (repository) => {
      answers.push(escape);
      await new ConflictController().collectSelections(repository);

      const list = offered[0] ?? [];
      expect(list[0]).toContain("Keep the version written later everywhere");
      expect(list[1]).toContain("Keep this PC's version everywhere");
      expect(list[2]).toContain("Keep the other PC's version everywhere");
      expect(list.some((label) => label.includes("Decide later"))).toBe(true);
    });
  });

  it("resolves every conflict at once from one bulk answer", async () => {
    await withConflicts(async (repository) => {
      answers.push(choose("Keep the version written later everywhere"));

      const collected = await new ConflictController().collectSelections(repository);

      expect(collected.selections).toHaveLength(KEYS.length);
      expect(collected.deferred).toHaveLength(0);
      for (const selection of collected.selections) {
        const newest = [...(repository.state.tips[selection.resourceId] ?? [])].sort(
          compareTips,
        )[0];
        expect(selection.tip?.versionId).toBe(newest?.versionId);
      }
      // One prompt for the whole set - no diff editor opened for any of them.
      expect(offered).toHaveLength(1);
      expect(executed).toHaveLength(0);
    });
  });

  it("opens a diff only for the conflict the user asks to review", async () => {
    await withConflicts(async (repository) => {
      answers.push(choose("Setting: editor.fontSize"));
      answers.push(choose("Other PC"));
      answers.push(choose("Decide later"));

      const collected = await new ConflictController().collectSelections(repository);

      expect(collected.selections).toHaveLength(1);
      expect(collected.selections[0]?.resourceId).toBe(
        "settings/default/editor.fontSize",
      );
      expect(executed.filter((call) => call.command === "vscode.diff")).toHaveLength(
        1,
      );
    });
  });

  it("keeps decisions already made when the user backs out", async () => {
    await withConflicts(async (repository) => {
      answers.push(choose("Setting: editor.fontSize"));
      answers.push(choose("This PC"));
      // Escaping the list is "decide later", not "throw the last answer away".
      answers.push(escape);

      const collected = await new ConflictController().collectSelections(repository);

      expect(collected.selections).toHaveLength(1);
      expect(collected.selections[0]?.tip?.deviceId).toBe(
        repository.state.device.deviceId,
      );
    });
  });

  it("returns to the list when a single conflict is escaped", async () => {
    await withConflicts(async (repository) => {
      answers.push(choose("Setting: editor.fontSize"));
      answers.push(escape); // back out of the individual pick
      answers.push(choose("Keep the version written later everywhere"));

      const collected = await new ConflictController().collectSelections(repository);

      // Nothing was decided by the aborted review, and the run continued.
      expect(collected.selections).toHaveLength(KEYS.length);
    });
  });

  it("publishes one event for a whole bulk resolution", async () => {
    await withConflicts(async (repository) => {
      answers.push(choose("Keep the version written later everywhere"));
      const controller = new ConflictController();
      const collected = await controller.collectSelections(repository);
      const before = (await repository.listEvents()).length;

      const applied = await controller.applySelections(
        repository,
        collected.selections,
      );

      expect(applied.resolved).toBe(KEYS.length);
      expect(applied.deferred).toHaveLength(0);
      // Three conflicts, one event - not one event per conflict.
      expect((await repository.listEvents()).length).toBe(before + 1);
    });
  });

  it("does not let one unpublishable resolution cost the others", async () => {
    await withConflicts(async (repository) => {
      answers.push(choose("Keep the version written later everywhere"));
      const controller = new ConflictController();
      const collected = await controller.collectSelections(repository);
      // Lowering the limit below something already in the repository is the
      // documented way a resolution becomes unpublishable. At one byte, every
      // one of these two-byte settings values is refused.
      repository.setMaxPayloadBytes(1);

      const applied = await controller.applySelections(
        repository,
        collected.selections,
      );

      // Each one fails on its own account and is named; none is marked resolved.
      expect(applied.resolved).toBe(0);
      expect(applied.deferred).toHaveLength(KEYS.length);
      for (const key of KEYS) {
        expect(
          applied.deferred.some((entry) => entry.includes(key)),
        ).toBe(true);
      }
      // Nothing was marked resolved that was not published.
      expect(
        repository.state.conflicts.every(
          (conflict) => conflict.resolvedAt === undefined,
        ),
      ).toBe(true);
    });
  });

  it("resolves the publishable ones when only one is too large", async () => {
    await withConflicts(async (repository) => {
      answers.push(choose("Keep the version written later everywhere"));
      const controller = new ConflictController();
      const collected = await controller.collectSelections(repository);
      const selections = [...collected.selections];
      const doomed = selections[0];
      expect(doomed).toBeDefined();
      // One selection carries a payload nothing will accept; the rest are tiny.
      const huge = Buffer.alloc(2048, 0x21);
      selections[0] = {
        ...(doomed as (typeof selections)[number]),
        tip: null,
        live: {
          resourceId: doomed?.resourceId ?? "",
          kind: "settings",
          content: huge,
          semanticHash: sha256(huge),
          metadata: { profileId: "default", key: "editor.fontSize" },
        },
      };
      repository.setMaxPayloadBytes(1024);

      const applied = await controller.applySelections(repository, selections);

      expect(applied.resolved).toBe(KEYS.length - 1);
      expect(applied.deferred).toHaveLength(1);
      expect(applied.deferred[0]).toContain(doomed?.resourceId ?? "");
    });
  });

  it("reports a stale conflict instead of resolving it", async () => {
    await withConflicts(async (repository) => {
      answers.push(choose("Keep the version written later everywhere"));
      const controller = new ConflictController();
      const collected = await controller.collectSelections(repository);
      const stale = collected.selections.map((selection) => ({
        ...selection,
        tipVersionIds: ["something-else"],
      }));

      const applied = await controller.applySelections(repository, stale);

      expect(applied.resolved).toBe(0);
      expect(applied.deferred).toHaveLength(KEYS.length);
      expect(applied.deferred[0]).toContain("run Resolve Conflicts again");
    });
  });
});

describe("tipForChoice", () => {
  const view = (
    sides: Array<[deviceId: string, lamport: number, createdAt?: string]>,
  ) =>
    describeConflict(
      {
        conflictId: "c",
        resourceId: "settings/default/editor.fontSize",
        kind: "settings",
        baseVersionId: null,
        tipVersionIds: [],
        createdAt: "2026-07-25T12:00:00.000Z",
      },
      sides.map(([deviceId, lamport, createdAt]) => ({
        ...tip(deviceId, lamport),
        ...(createdAt === undefined ? {} : { createdAt }),
      })),
      {
        localDeviceId: "me",
        now: Date.parse("2026-07-25T12:00:00.000Z"),
        contentOf: () => null,
      },
    );

  it("declines when the choice names no side of this conflict", () => {
    // Three devices: a conflict between two peers has no "this PC" side, and
    // "the other PC" names two different machines. Substituting a different
    // answer than the one asked for would be worse than leaving it alone.
    const betweenPeers = view([
      ["them", 10],
      ["elsewhere", 9],
    ]);
    expect(tipForChoice(betweenPeers, "local")).toBeNull();
    expect(tipForChoice(betweenPeers, "remote")).toBeNull();
    expect(tipForChoice(betweenPeers, "newest")).not.toBeNull();
  });

  it("picks the single matching side otherwise", () => {
    const mixed = view([
      ["me", 10],
      ["them", 9],
    ]);
    expect(tipForChoice(mixed, "local")?.deviceId).toBe("me");
    expect(tipForChoice(mixed, "remote")?.deviceId).toBe("them");
  });

  it("keeps the side the screen calls later, not the causally later one", () => {
    // A device that has not polled publishes at a low Lamport however recently
    // it wrote. Showing "2 minutes ago" beside "7 days ago" and then handing
    // "keep the later one" to the seven-day-old side is worse than showing no
    // times at all, because the user acts on what they can read.
    const stale = view([
      ["me", 40, "2026-07-18T12:00:00.000Z"],
      ["them", 1, "2026-07-25T11:58:00.000Z"],
    ]);

    expect(stale.tips[0]?.deviceId).toBe("me"); // causally later
    expect(tipForChoice(stale, "newest")?.deviceId).toBe("them");
    expect(stale.electedByClock).toBe(true);
    expect(stale.sides.find((side) => side.newest)?.when).toBe("2 minutes ago");
  });

  it("is not decided by a device UUID when the Lamports tie", () => {
    // The ordinary two-machine fork: both devices caught up, both editing
    // before the next poll, so both events land on the same Lamport and
    // compareTips falls through to comparing two random device IDs.
    for (const [left, right] of [
      ["aaaa", "zzzz"],
      ["zzzz", "aaaa"],
    ] as const) {
      const tied = view([
        [left, 7, "2026-07-25T11:50:00.000Z"],
        [right, 7, "2026-07-25T11:55:00.000Z"],
      ]);
      expect(tipForChoice(tied, "newest")?.createdAt).toBe(
        "2026-07-25T11:55:00.000Z",
      );
    }
  });

  it("falls back to publish order when there is no time to compare", () => {
    // A version folded into a checkpoint keeps no timestamp, so there is
    // nothing to compare and the badge must not claim otherwise.
    const folded = view([
      ["me", 10],
      ["them", 9, "2026-07-25T11:00:00.000Z"],
    ]);

    expect(folded.electedByClock).toBe(false);
    expect(tipForChoice(folded, "newest")?.deviceId).toBe("me");
  });

  it("falls back to publish order when the two timestamps are equal", () => {
    const same = view([
      ["me", 10, "2026-07-25T11:00:00.000Z"],
      ["them", 9, "2026-07-25T11:00:00.000Z"],
    ]);

    expect(same.electedByClock).toBe(false);
    expect(tipForChoice(same, "newest")?.deviceId).toBe("me");
  });
});

describe("describeConflict", () => {
  it("reads a settings value rather than describing its bytes", () => {
    const conflict: SyncConflict = {
      conflictId: "c",
      resourceId: "settings/default/editor.fontSize",
      kind: "settings",
      baseVersionId: null,
      tipVersionIds: ["a#0", "b#0"],
      createdAt: new Date().toISOString(),
    };
    const tips = [
      { ...tip("me", 2), versionId: "a#0", metadata: { key: "editor.fontSize" } },
      { ...tip("them", 1), versionId: "b#0", metadata: { key: "editor.fontSize" } },
    ];
    const contents = new Map([
      ["a#0", canonicalBytes(14)],
      ["b#0", canonicalBytes(16)],
    ]);

    const view = describeConflict(conflict, tips, {
      localDeviceId: "me",
      now: Date.parse("2026-07-25T12:00:00.000Z"),
      contentOf: (candidate) => contents.get(candidate.versionId) ?? null,
    });

    expect(view.category).toBe("Setting");
    expect(view.name).toBe("editor.fontSize");
    expect(view.sides[0]?.deviceLabel).toBe("This PC");
    expect(view.sides[0]?.value).toBe("14");
    expect(view.sides[1]?.value).toBe("16");
    expect(view.sides[0]?.newest).toBe(true);
  });

  it("summarizes a chat by its title and message count", () => {
    const composerId = "026e7136-6ca9-4847-9328-6fc5a697c651";
    const conflict: SyncConflict = {
      conflictId: "c",
      resourceId: `chat/${composerId}`,
      kind: "chat",
      baseVersionId: null,
      tipVersionIds: ["a#0", "b#0"],
      createdAt: new Date().toISOString(),
    };
    const snapshot = (bubbles: number, title: string): Buffer =>
      canonicalBytes({
        schemaVersion: 1,
        composerId,
        header: {
          composerId,
          workspaceId: null,
          createdAt: 1,
          lastUpdatedAt: 1783312486260,
          isArchived: 0,
          isSubagent: 0,
          recency: 0,
          checkpointAt: null,
          value: title,
        },
        composerData: { key: `composerData:${composerId}`, valueBase64: "" },
        bubbles: Array.from({ length: bubbles }, (_unused, index) => ({
          key: `bubbleId:${composerId}:${index}`,
          valueBase64: "",
        })),
      });
    const contents = new Map([
      ["a#0", snapshot(49, "Refactoring the backend")],
      ["b#0", snapshot(47, "Refactoring the backend")],
    ]);

    const view = describeConflict(
      conflict,
      [
        { ...tip("me", 2), versionId: "a#0", kind: "chat" },
        { ...tip("them", 1), versionId: "b#0", kind: "chat" },
      ],
      {
        localDeviceId: "me",
        now: Date.parse("2026-07-25T12:00:00.000Z"),
        contentOf: (candidate) => contents.get(candidate.versionId) ?? null,
      },
    );

    expect(view.name).toBe("Refactoring the backend");
    expect(view.sides[0]?.value).toContain("49 messages");
    expect(view.sides[1]?.value).toContain("47 messages");
  });

  it("survives a peer timestamp that is finite but not a date", () => {
    // `parsePortableChatSnapshot` accepts any finite number for lastUpdatedAt,
    // and 1e20 is finite. `new Date(1e20).toISOString()` throws, and this runs
    // inside the loop that builds the whole list - one bad row would take the
    // entire Resolve Conflicts command down.
    const composerId = "026e7136-6ca9-4847-9328-6fc5a697c651";
    const content = canonicalBytes({
      schemaVersion: 1,
      composerId,
      header: {
        composerId,
        workspaceId: null,
        createdAt: 1,
        lastUpdatedAt: 1e20,
        isArchived: 0,
        isSubagent: 0,
        recency: 0,
        checkpointAt: null,
        value: "hostile",
      },
      composerData: { key: `composerData:${composerId}`, valueBase64: "" },
      bubbles: [],
    });

    expect(() =>
      describeValue("chat", { ...tip("me", 1), kind: "chat" }, content),
    ).not.toThrow();
    // The count still renders; only the unusable timestamp is dropped.
    expect(describeValue("chat", { ...tip("me", 1), kind: "chat" }, content)).toBe(
      "0 messages",
    );
  });

  it("turns the event timestamp into something a person can compare", () => {
    const conflict: SyncConflict = {
      conflictId: "c",
      resourceId: "settings/default/editor.tabSize",
      kind: "settings",
      baseVersionId: null,
      tipVersionIds: ["a#0", "b#0"],
      createdAt: "2026-07-25T12:00:00.000Z",
    };
    const now = Date.parse("2026-07-25T12:00:00.000Z");

    const view = describeConflict(
      conflict,
      [
        { ...tip("me", 2), versionId: "a#0", createdAt: "2026-07-25T11:57:00.000Z" },
        { ...tip("them", 1), versionId: "b#0", createdAt: "2026-07-25T10:00:00.000Z" },
      ],
      { localDeviceId: "me", now, contentOf: () => null },
    );

    expect(view.sides[0]?.when).toBe("3 minutes ago");
    expect(view.sides[1]?.when).toBe("2 hours ago");
  });
});

function tip(deviceId: string, lamport: number): ResourceTip {
  return {
    versionId: `${deviceId}#${lamport}`,
    eventHash: deviceId,
    changeIndex: 0,
    kind: "settings",
    lamport,
    deviceId,
    operation: "put",
    semanticHash: sha256(`${deviceId}:${lamport}`),
    parents: [],
  };
}

function settingSnapshot(key: string, value: number): ResourceSnapshot {
  const content = canonicalBytes(value);
  return {
    resourceId: `settings/default/${key}`,
    kind: "settings",
    content,
    semanticHash: sha256(content),
    metadata: { profileId: "default", key },
  };
}

/**
 * A repository with one base-free settings conflict per key, half of them
 * published by "this" device and half by a peer, so the local/remote bulk
 * answers have something to bite on.
 */
async function withConflicts(
  run: (repository: SyncRepository) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "cursor-setting-sync-resolver-"),
  );
  try {
    const repository = await SyncRepository.create(
      join(temporaryRoot, "repository"),
      join(temporaryRoot, "storage"),
      PASSPHRASE,
      1024 * 1024,
      PRODUCER,
    );
    // Two independent roots per resource: neither descends from the other, so
    // each one reconciles into a conflict.
    for (const value of [14, 16]) {
      for (const key of KEYS) {
        await repository.publish(
          [{ ...settingSnapshot(key, value), parents: [] }],
          [],
        );
      }
    }
    const conflicts = new EventReconciler().reconcile(
      await repository.listEvents(),
      repository.state,
      null,
    ).conflicts;
    expect(conflicts).toHaveLength(KEYS.length);
    // Both sides were published by this device, so the older one is relabelled
    // to model the two-machine fork the resolver exists for.
    for (const tips of Object.values(repository.state.tips)) {
      const oldest = [...tips].sort(compareTips)[tips.length - 1];
      if (oldest !== undefined) {
        oldest.deviceId = "c55756e3-4426-41d0-88b5-26ef11d9149e";
      }
    }
    await run(repository);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
