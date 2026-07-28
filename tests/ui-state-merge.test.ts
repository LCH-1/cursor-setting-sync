import { describe, expect, it } from "vitest";
import { mergeUiStateBuffers } from "../src/resources/uiStateMerge";
import {
  isDeniedUiStateKey,
  isIgnoredUiStateKey,
  isPolicyExcludedUiStateKey,
  isSecurityDeniedUiStateKey,
  normalizeIgnoredUiStateKeys,
} from "../src/resources/uiStatePolicy";

interface PinnedPanel {
  id: string;
  pinned: boolean;
  visible: boolean;
  order: number;
}

function panel(id: string, overrides: Partial<PinnedPanel> = {}): PinnedPanel {
  return { id, pinned: true, visible: false, order: 0, ...overrides };
}

function value(input: unknown): Buffer {
  return Buffer.from(JSON.stringify(input), "utf8");
}

function parsed(content: Buffer | undefined): unknown {
  return JSON.parse((content ?? Buffer.alloc(0)).toString("utf8")) as unknown;
}

/** Runs the merge the way the two devices run it: with local and remote swapped. */
function mergeBothWays(
  base: Buffer,
  local: Buffer,
  remote: Buffer,
): { first: ReturnType<typeof mergeUiStateBuffers>; second: ReturnType<typeof mergeUiStateBuffers> } {
  return {
    first: mergeUiStateBuffers(base, local, remote),
    second: mergeUiStateBuffers(base, remote, local),
  };
}

describe("UI state merge", () => {
  const base = value([
    panel("workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", {
      order: 1,
    }),
    panel("workbench.panel.chatSidebar", { visible: true, order: 0 }),
  ]);

  it("merges a pinnedPanels-shaped array without a conflict", () => {
    const local = value([
      panel("workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", {
        order: 1,
      }),
      panel("workbench.panel.chatSidebar", { visible: true, order: 0 }),
      panel("workbench.panel.aichat.11111111-1111-4111-8111-111111111111", {
        order: 2,
      }),
    ]);
    const remote = value([
      panel("workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", {
        order: 1,
      }),
      panel("workbench.panel.chatSidebar", { visible: false, order: 0 }),
    ]);

    const outcome = mergeUiStateBuffers(base, local, remote);

    expect(outcome.status).toBe("merged");
    expect(parsed(outcome.content)).toEqual([
      {
        id: "workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b",
        order: 1,
        pinned: true,
        visible: false,
      },
      {
        id: "workbench.panel.chatSidebar",
        order: 0,
        pinned: true,
        visible: false,
      },
      {
        id: "workbench.panel.aichat.11111111-1111-4111-8111-111111111111",
        order: 2,
        pinned: true,
        visible: false,
      },
    ]);
  });

  it("produces identical bytes on both devices for the same fork", () => {
    const local = value([
      panel("workbench.panel.chatSidebar", { visible: true, order: 0 }),
      panel("workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", {
        order: 1,
      }),
      panel("workbench.panel.local", { order: 9 }),
    ]);
    const remote = value([
      panel("workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", {
        order: 1,
        pinned: false,
      }),
      panel("workbench.panel.chatSidebar", { visible: true, order: 0 }),
      panel("workbench.panel.remote", { order: 3 }),
    ]);

    const { first, second } = mergeBothWays(base, local, remote);

    expect(first.status).toBe("merged");
    expect(second.status).toBe("merged");
    expect(first.content?.toString("utf8")).toBe(second.content?.toString("utf8"));
  });

  it("keeps the two devices byte-identical on a large disjoint fork", () => {
    const shared = Array.from({ length: 200 }, (_, index) =>
      panel(`workbench.panel.aichat.shared-${index}`, { order: index }),
    );
    const local = value([
      ...shared,
      ...Array.from({ length: 200 }, (_, index) =>
        panel(`workbench.panel.aichat.local-${index}`, { order: 400 - index }),
      ),
    ]);
    const remote = value([
      ...shared.map((entry) => ({ ...entry, visible: true })),
      ...Array.from({ length: 200 }, (_, index) =>
        panel(`workbench.panel.aichat.remote-${index}`, { order: 400 - index }),
      ),
    ]);

    const { first, second } = mergeBothWays(value(shared), local, remote);

    expect(first.status).toBe("merged");
    expect(first.content?.equals(second.content ?? Buffer.alloc(0))).toBe(true);
    expect(parsed(first.content)).toHaveLength(600);
  });

  it("keeps a one-sided removal and a one-sided addition", () => {
    const local = value([
      panel("workbench.panel.chatSidebar", { visible: true, order: 0 }),
    ]);
    const remote = value([
      panel("workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", {
        order: 1,
      }),
      panel("workbench.panel.chatSidebar", { visible: true, order: 0 }),
      panel("workbench.panel.added", { order: 4 }),
    ]);

    const { first, second } = mergeBothWays(base, local, remote);

    expect(first.content?.equals(second.content ?? Buffer.alloc(0))).toBe(true);
    expect((parsed(first.content) as PinnedPanel[]).map((entry) => entry.id)).toEqual([
      "workbench.panel.chatSidebar",
      "workbench.panel.added",
    ]);
  });

  it("orders elements added by both sides by order and then by id", () => {
    const local = value([
      panel("workbench.panel.chatSidebar", { visible: true, order: 0 }),
      panel("workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", {
        order: 1,
      }),
      panel("workbench.panel.zzz", { order: 2 }),
    ]);
    const remote = value([
      panel("workbench.panel.chatSidebar", { visible: true, order: 0 }),
      panel("workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", {
        order: 1,
      }),
      panel("workbench.panel.aaa", { order: 2 }),
      panel("workbench.panel.mmm", { order: 5 }),
    ]);

    const outcome = mergeUiStateBuffers(base, local, remote);

    expect((parsed(outcome.content) as PinnedPanel[]).map((entry) => entry.id)).toEqual([
      "workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b",
      "workbench.panel.chatSidebar",
      "workbench.panel.aaa",
      "workbench.panel.zzz",
      "workbench.panel.mmm",
    ]);
  });

  it("merges disjoint keys of a JSON object value", () => {
    const outcome = mergeUiStateBuffers(
      value({ collapsed: false, width: 300 }),
      value({ collapsed: true, width: 300 }),
      value({ collapsed: false, width: 420 }),
    );

    expect(outcome.status).toBe("merged");
    expect(parsed(outcome.content)).toEqual({ collapsed: true, width: 420 });
  });

  it("merges an identified array nested inside an object", () => {
    const nested = (views: PinnedPanel[]): Buffer => value({ version: 1, views });

    const outcome = mergeUiStateBuffers(
      nested([panel("explorer"), panel("outline")]),
      nested([panel("explorer", { visible: true }), panel("outline")]),
      nested([panel("explorer"), panel("outline"), panel("timeline", { order: 3 })]),
    );

    expect(outcome.status).toBe("merged");
    expect(parsed(outcome.content)).toEqual({
      version: 1,
      views: [
        { id: "explorer", order: 0, pinned: true, visible: true },
        { id: "outline", order: 0, pinned: true, visible: false },
        { id: "timeline", order: 3, pinned: true, visible: false },
      ],
    });
  });

  it("reports a conflict for a bare string value", () => {
    const outcome = mergeUiStateBuffers(
      Buffer.from("default", "utf8"),
      Buffer.from("top", "utf8"),
      Buffer.from("bottom", "utf8"),
    );

    expect(outcome.status).toBe("conflict");
    expect(outcome.content).toBeUndefined();
  });

  it("reports a conflict for two concurrent scalar edits", () => {
    const outcome = mergeUiStateBuffers(value(14), value(16), value(18));

    expect(outcome.status).toBe("conflict");
  });

  it("reports a conflict when the same element changed on both sides", () => {
    const outcome = mergeUiStateBuffers(
      base,
      value([panel("workbench.panel.chatSidebar", { order: 7 })]),
      value([panel("workbench.panel.chatSidebar", { order: 9 })]),
    );

    expect(outcome.status).toBe("conflict");
  });

  it("reports a conflict for an array of values with no identity field", () => {
    const outcome = mergeUiStateBuffers(
      value(["a", "b"]),
      value(["a", "b", "c"]),
      value(["a", "b", "d"]),
    );

    expect(outcome.status).toBe("conflict");
  });

  it("reports a conflict when an array repeats an identity", () => {
    const outcome = mergeUiStateBuffers(
      value([panel("duplicate"), panel("duplicate", { order: 1 })]),
      value([panel("duplicate", { visible: true }), panel("duplicate", { order: 1 })]),
      value([panel("duplicate"), panel("duplicate", { order: 2 })]),
    );

    expect(outcome.status).toBe("conflict");
  });

  it("returns the changed side unchanged when only one side moved", () => {
    const local = value([panel("only-local")]);

    expect(mergeUiStateBuffers(base, local, base).content?.equals(local)).toBe(true);
    expect(mergeUiStateBuffers(base, base, local).content?.equals(local)).toBe(true);
  });

  it("canonicalizes away a key-order-only difference between the two sides", () => {
    const reordered = Buffer.from(
      '[{"order":0,"visible":true,"pinned":true,"id":"workbench.panel.chatSidebar"},' +
        '{"pinned":true,"order":1,"visible":false,' +
        '"id":"workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b"}]',
      "utf8",
    );
    const local = value([
      panel("workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", {
        order: 1,
      }),
      panel("workbench.panel.chatSidebar", { visible: true, order: 0 }),
      panel("workbench.panel.local", { order: 2 }),
    ]);

    const { first, second } = mergeBothWays(base, local, reordered);

    expect(first.status).toBe("merged");
    expect(first.content?.equals(second.content ?? Buffer.alloc(0))).toBe(true);
  });
});

describe("UI state key policy", () => {
  it("denies the unbounded per-panel key families", () => {
    expect(
      isDeniedUiStateKey(
        "workbench.panel.composerChatViewPane.fe374843-0376-48d0-bbc4-948b7a99c55b.hidden",
      ),
    ).toBe(true);
    expect(isDeniedUiStateKey("workbench.auxiliarybar.pinnedPanels")).toBe(true);
    expect(isDeniedUiStateKey("workbench.panel.pinnedPanels")).toBe(false);
    expect(isDeniedUiStateKey("workbench.activity.pinnedViewlets2")).toBe(false);
  });

  it("separates a policy exclusion from a security denial", () => {
    // Policy: excluded from the scan, but harmless to receive. Treating one of
    // these as a security violation aborted the whole shutdown apply on any
    // device whose repository still held an event published by 0.0.1-0.0.3.
    for (const key of [
      "workbench.auxiliarybar.pinnedPanels",
      "workbench.panel.composerChatViewPane.fe374843-0376-48d0-bbc4-948b7a99c55b.hidden",
      // Rewritten by Cursor every 15-30 seconds while it runs; syncing it
      // published an event on virtually every poll.
      "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser",
    ]) {
      expect(isPolicyExcludedUiStateKey(key)).toBe(true);
      expect(isSecurityDeniedUiStateKey(key)).toBe(false);
      expect(isDeniedUiStateKey(key)).toBe(true);
    }

    // Security: receiving one of these is a protocol violation.
    for (const key of [
      "secret://github",
      "mcpOAuth.server",
      "some.accessToken",
      "vendor.password",
      "vendor.credentials",
      "github.authenticationSessions",
      "lch.cursor-setting-sync.state",
    ]) {
      expect(isSecurityDeniedUiStateKey(key)).toBe(true);
      expect(isPolicyExcludedUiStateKey(key)).toBe(false);
      expect(isDeniedUiStateKey(key)).toBe(true);
    }

    for (const key of [
      "workbench.activity.pinnedViewlets2",
      "workbench.panel.chatSidebar",
    ]) {
      expect(isSecurityDeniedUiStateKey(key)).toBe(false);
      expect(isPolicyExcludedUiStateKey(key)).toBe(false);
    }
  });

  it("matches an ignored key exactly or by prefix glob", () => {
    const ignored = normalizeIgnoredUiStateKeys([
      "  workbench.activity.pinnedViewlets2  ",
      "cursor/update*",
      "",
    ]);

    expect(isIgnoredUiStateKey("workbench.activity.pinnedViewlets2", ignored)).toBe(
      true,
    );
    expect(isIgnoredUiStateKey("workbench.activity.pinnedViewlets", ignored)).toBe(
      false,
    );
    expect(isIgnoredUiStateKey("cursor/updatePromptShownDate", ignored)).toBe(true);
    expect(isIgnoredUiStateKey("cursor/lastUpdateHiddenVersion", ignored)).toBe(false);
    expect(isIgnoredUiStateKey("anything", normalizeIgnoredUiStateKeys([]))).toBe(
      false,
    );
  });
});
