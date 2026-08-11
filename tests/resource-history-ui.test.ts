import { describe, expect, it, vi } from "vitest";
import { chatHeaderTitle, chatSnapshotTitle } from "../src/chat/title";
import {
  buildRestoreKindChoices,
  buildRestoreResourceChoices,
  buildRestoreScopeChoices,
  restorablePutVersions,
  restoreTargetIsUnchanged,
  type RestoreResourceDescriptor,
} from "../src/ui/resourceHistory";
import type { JsonValue, ResourceKind } from "../src/types";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");
const date = (timestamp: number): string => new Date(timestamp).toISOString();

describe("Restore Version History picker labels", () => {
  it("reduces hundreds of raw resources to one row per clearly explained kind", () => {
    const resources = [
      descriptor("chat/00000000-0000-4000-8000-000000000001", "chat"),
      ...Array.from({ length: 500 }, (_unused, index) =>
        descriptor(
          `chat-transcript/${encodeURIComponent(
            `c-Users-me-project/agent-transcripts/${index}/${index}.jsonl`,
          )}`,
          "chat-transcript",
        ),
      ),
    ];

    const choices = buildRestoreKindChoices(resources);

    expect(choices).toHaveLength(2);
    expect(choices[0]?.resourceKind).toBe("chat");
    expect(choices[0]?.label).toBe("Cursor conversations");
    expect(choices[0]?.detail).toMatch(/missing chat/i);
    expect(choices[1]?.label).toBe("Agent transcripts");
    expect(choices[1]?.description).toBe("500 items");
    expect(choices[1]?.detail).toMatch(/not the main Cursor conversation/i);
    expect(choices.some((choice) => choice.label.includes("%2F"))).toBe(false);
  });

  it("shows a chat title, workspace, message count, and update time", () => {
    const resource = descriptor(
      "chat/00000000-0000-4000-8000-00000000000a",
      "chat",
      {
        title: "  Fix the\nrestore picker  ",
        composerId: "00000000-0000-4000-8000-00000000000a",
        workspaceUri: "file:///C:/work/cursor-setting-sync",
        bubbleCount: 63,
        lastUpdatedAt: NOW - 60_000,
      },
    );

    const [choice] = buildRestoreResourceChoices([resource], {
      now: NOW,
      formatDate: date,
    });

    expect(choice?.label).toBe("Fix the restore picker");
    expect(choice?.description).toContain("cursor-setting-sync");
    expect(choice?.description).toContain("63 messages");
    expect(choice?.description).toContain("2026-08-07T11:59:00.000Z");
    expect(choice?.detail).toContain("Conversation ID");
    expect(choice?.detail).not.toContain("chat/");
  });

  it("makes title-less older chats identifiable by workspace, date, and messages", () => {
    const [choice] = buildRestoreResourceChoices([
      descriptor(
        "chat/00000000-0000-4000-8000-00000000000b",
        "chat",
        {
          composerId: "00000000-0000-4000-8000-00000000000b",
          workspaceUri: "vscode-remote://ssh-remote+server/home/me/backend",
          bubbleCount: 1,
          lastUpdatedAt: NOW - 120_000,
        },
      ),
    ], { now: NOW, formatDate: date });

    expect(choice?.label).toContain("backend");
    expect(choice?.label).toContain("1 message");
    expect(choice?.label).toContain("00000000");
    expect(choice?.description).toContain("Title unavailable");
    expect(choice?.description).toContain("2026-08-07T11:58:00.000Z");
  });

  it("uses the canonical chat ID instead of mismatched peer metadata", () => {
    const canonical = "33333333-3333-4333-8333-333333333333";
    const [choice] = buildRestoreResourceChoices([
      descriptor(`chat/${canonical}`, "chat", {
        composerId: "99999999-9999-4999-8999-999999999999",
      }),
    ]);

    expect(choice?.label).toContain("33333333");
    expect(choice?.detail).toContain(canonical);
    expect(choice?.detail).not.toContain("99999999");
  });

  it("decodes transcript paths and distinguishes main and subagent files", () => {
    const mainPath =
      "c-Users-me-project/agent-transcripts/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
    const childPath =
      "c-Users-me-project/agent-transcripts/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/subagents/ffffffff-1111-2222-3333-444444444444.txt";
    const choices = buildRestoreResourceChoices([
      descriptor(`chat-transcript/${encodeURIComponent(mainPath)}`, "chat-transcript", {
        lastUpdatedAt: NOW - 10_000,
      }),
      descriptor(`chat-transcript/${encodeURIComponent(childPath)}`, "chat-transcript", {
        lastUpdatedAt: NOW - 5_000,
      }),
    ], { now: NOW, formatDate: date });

    expect(choices[0]?.label).toContain("Subagent transcript");
    expect(choices[0]?.label).toContain("ffffffff");
    expect(choices[1]?.label).toContain("Main transcript");
    expect(choices[1]?.label).toContain("aaaaaaaa");
    expect(choices[0]?.detail).toContain(childPath);
    expect(choices[0]?.detail).not.toContain("%2F");
    expect(choices[0]?.label).not.toContain("%2F");
  });

  it("uses the canonical transcript ID when peer metadata names another path", () => {
    const canonical =
      "safe-project/agent-transcripts/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
    const resource = descriptor(
      `chat-transcript/${encodeURIComponent(canonical)}`,
      "chat-transcript",
      {
        projectSlug: "wrong-project",
        relativePath: "wrong-project/agent-transcripts/wrong/wrong.jsonl",
      },
    );

    const [scope] = buildRestoreScopeChoices([resource]);
    const [choice] = buildRestoreResourceChoices([resource]);

    expect(scope?.label).toBe("safe-project");
    expect(choice?.label).toContain("safe-project");
    expect(choice?.detail).toBe(canonical);
    expect(choice?.detail).not.toContain("wrong-project");
  });

  it("narrows a large transcript list by project before showing files", () => {
    const resources = Array.from({ length: 200 }, (_unused, index) => {
      const project = `project-${index % 4}`;
      const path = `${project}/agent-transcripts/${index}/${index}.jsonl`;
      return descriptor(`chat-transcript/${encodeURIComponent(path)}`, "chat-transcript", {
        projectSlug: project,
        relativePath: path,
        lastUpdatedAt: NOW - index * 1000,
      });
    });

    const scopes = buildRestoreScopeChoices(resources, {
      now: NOW,
      formatDate: date,
    });

    expect(scopes).toHaveLength(4);
    expect(scopes.every((scope) => scope.resourceIds.length === 50)).toBe(true);
    expect(scopes[0]?.label).toBe("project-0");
    expect(scopes[0]?.description).toContain("50 items");
  });

  it("survives malformed IDs, ignores implausible future clocks, and sorts blocked rows last", () => {
    const choices = buildRestoreResourceChoices([
      {
        ...descriptor("chat-transcript/%E0%A4%A", "chat-transcript", {
          lastUpdatedAt: NOW + 2 * 24 * 60 * 60 * 1000,
        }),
        eventCreatedAt: "2026-08-07T11:00:00.000Z",
      },
      {
        ...descriptor("chat-transcript/blocked", "chat-transcript", {
          lastUpdatedAt: NOW,
        }),
        blockedReason: "Resolve the conflict first.",
      },
    ], { now: NOW, formatDate: date });

    expect(choices[0]?.resourceId).toBe("chat-transcript/%E0%A4%A");
    expect(choices[0]?.updatedAt).toBe(Date.parse("2026-08-07T11:00:00.000Z"));
    expect(choices[1]?.label).toContain("$(circle-slash)");
    expect(choices[1]?.description).toBe("Resolve the conflict first.");
  });

  it("gives metadata-free chats distinct short IDs and rejects negative dates", () => {
    const choices = buildRestoreResourceChoices([
      {
        ...descriptor("chat/11111111-1111-4111-8111-111111111111", "chat", {
          lastUpdatedAt: -1,
        }),
        sourceTimestamp: -2,
      },
      descriptor("chat/22222222-2222-4222-8222-222222222222", "chat"),
    ], { now: NOW, formatDate: date });

    expect(choices.map((choice) => choice.label)).toContain(
      "Cursor conversation · 11111111",
    );
    expect(choices.map((choice) => choice.label)).toContain(
      "Cursor conversation · 22222222",
    );
    expect(choices.every((choice) => choice.updatedAt === null)).toBe(true);
  });

  it("marks a completely disabled kind without hiding its explanation", () => {
    const [choice] = buildRestoreKindChoices([
      {
        ...descriptor("chat/id", "chat"),
        blockedReason: "Chat synchronization is disabled in settings.",
      },
    ]);

    expect(choice?.label).toBe("$(circle-slash) Cursor conversations");
    expect(choice?.blockedReason).toMatch(/disabled/);
    expect(choice?.detail).toMatch(/missing chat/i);
  });
});

describe("restorable history filtering", () => {
  const olderPut = { versionId: "old#0", operation: "put" as const };
  const currentPut = { versionId: "current#0", operation: "put" as const };
  const currentDelete = { versionId: "delete#0", operation: "delete" as const };

  it("omits a current-only put but keeps an older put behind a current put", () => {
    expect(
      restorablePutVersions([currentPut], new Set([currentPut.versionId]), () => null),
    ).toEqual([]);
    expect(
      restorablePutVersions(
        [currentPut, olderPut],
        new Set([currentPut.versionId]),
        () => null,
      ),
    ).toEqual([olderPut]);
  });

  it("keeps an older put behind a current deletion and applies compatibility gates", () => {
    expect(
      restorablePutVersions(
        [currentDelete, olderPut],
        new Set([currentDelete.versionId]),
        () => null,
      ),
    ).toEqual([olderPut]);
    expect(
      restorablePutVersions(
        [currentDelete, olderPut],
        new Set([currentDelete.versionId]),
        (version) => version === olderPut ? "incompatible" : null,
      ),
    ).toEqual([]);
  });

  it("rejects a restore when tips, kind, or conflict state changed in the picker", () => {
    const expected = ["a#0", "b#0"];
    const fresh = [
      { versionId: "b#0", kind: "chat" as const },
      { versionId: "a#0", kind: "chat" as const },
    ];
    expect(restoreTargetIsUnchanged(expected, fresh, "chat", false)).toBe(true);
    expect(restoreTargetIsUnchanged(expected, fresh, "chat", true)).toBe(false);
    expect(
      restoreTargetIsUnchanged(expected, [{ versionId: "a#0", kind: "chat" }], "chat", false),
    ).toBe(false);
    expect(
      restoreTargetIsUnchanged(
        expected,
        [{ versionId: "a#0", kind: "settings" }, fresh[0] ?? { versionId: "b#0", kind: "chat" }],
        "chat",
        false,
      ),
    ).toBe(false);
  });
});

describe("Cursor conversation title metadata", () => {
  it("reads and normalizes the name in Cursor's structured header", () => {
    expect(chatHeaderTitle(JSON.stringify({ name: "  Restore\nthis chat  " }))).toBe(
      "Restore this chat",
    );
  });

  it("accepts a bare legacy title but never renders raw structured text", () => {
    expect(chatHeaderTitle("A legacy title")).toBe("A legacy title");
    expect(chatHeaderTitle("{not valid JSON")).toBeNull();
    expect(chatHeaderTitle(JSON.stringify({ subtitle: "No name" }))).toBeNull();
    expect(chatHeaderTitle(null)).toBeNull();
  });

  it("refuses structurally hostile header JSON before parsing it", () => {
    const hostile = `{"name":"hidden","items":[${"0,".repeat(65_536)}0]}`;
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(chatHeaderTitle(hostile)).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("refuses a huge bare title before parsing or normalizing the full value", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(chatHeaderTitle("x".repeat(64 * 1024 + 1))).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("clips long titles and extracts the title again from an old chat payload", () => {
    const long = `  ${"a".repeat(90)}\nend  `;
    const title = chatHeaderTitle(JSON.stringify({ name: long }));
    expect(title).toHaveLength(80);
    expect(title?.endsWith("…")).toBe(true);
    expect(chatHeaderTitle(JSON.stringify({ name: "   " }))).toBeNull();
    expect(chatHeaderTitle(JSON.stringify(["not", "a", "header"]))).toBeNull();
    expect(chatHeaderTitle(JSON.stringify("JSON string"))).toBeNull();

    const payload = Buffer.from(
      JSON.stringify({ header: { value: JSON.stringify({ name: "Recovered title" }) } }),
      "utf8",
    );
    expect(chatSnapshotTitle(payload)).toBe("Recovered title");
    expect(chatSnapshotTitle(Buffer.from("not JSON", "utf8"))).toBeNull();
  });
});

function descriptor(
  resourceId: string,
  kind: ResourceKind,
  metadata?: Record<string, JsonValue>,
): RestoreResourceDescriptor {
  return {
    resourceId,
    kind,
    metadata,
    sourceTimestamp: undefined,
    eventCreatedAt: undefined,
    blockedReason: null,
  };
}
