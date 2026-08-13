import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ui = vi.hoisted(() => ({
  answers: [] as Array<((labels: string[]) => number | undefined) | undefined>,
  offered: [] as Array<{ title: string; labels: string[] }>,
  confirmations: [] as string[],
  information: [] as string[],
  progressReports: [] as string[],
  warningChoice: undefined as string | undefined,
  informationChoice: undefined as string | undefined,
}));

vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  extensions: { all: [] },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  },
  window: {
    withProgress: async (
      _options: unknown,
      task: (progress: { report: (value: unknown) => void }) => Promise<unknown>,
    ) =>
      task({
        report: (value: unknown) => {
          if (
            value !== null &&
            typeof value === "object" &&
            typeof (value as { message?: unknown }).message === "string"
          ) {
            ui.progressReports.push((value as { message: string }).message);
          }
        },
      }),
    showQuickPick: async (
      items: Array<{ label: string }>,
      options: { title?: string },
    ) => {
      const labels = items.map((item) => item.label);
      ui.offered.push({ title: options.title ?? "", labels });
      const answer = ui.answers.shift();
      const index = answer === undefined ? undefined : answer(labels);
      return index === undefined ? undefined : items[index];
    },
    showWarningMessage: async (message: string, ...args: unknown[]) => {
      ui.confirmations.push(message);
      if (
        ui.warningChoice !== undefined &&
        args.includes(ui.warningChoice)
      ) {
        return ui.warningChoice;
      }
      return args.includes("Restore Version") ? "Restore Version" : undefined;
    },
    showInformationMessage: async (message: string, ...args: unknown[]) => {
      ui.information.push(message);
      if (
        ui.informationChoice !== undefined &&
        args.includes(ui.informationChoice)
      ) {
        return ui.informationChoice;
      }
      return undefined;
    },
  },
  commands: { executeCommand: async () => undefined },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
}));

import { SyncManager } from "../src/sync/manager";
import { SyncRepository } from "../src/protocol/repository";
import { EventReconciler } from "../src/protocol/reconciler";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import {
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  type PortableAgentKvPayload,
} from "../src/chat/stateVscdb";
import type {
  CompatibilityReport,
  ResourceSnapshot,
  ResourceVersionSummary,
} from "../src/types";
import type { CursorPaths } from "../src/platform/paths";
import type { ExtensionConfiguration } from "../src/config";
import type { StatusController } from "../src/ui/status";
import type { ConflictController } from "../src/ui/conflicts";

const temporaryRoots: string[] = [];
const producer = {
  extensionVersion: "0.0.60",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

beforeEach(() => {
  ui.answers.length = 0;
  ui.offered.length = 0;
  ui.confirmations.length = 0;
  ui.information.length = 0;
  ui.progressReports.length = 0;
  ui.warningChoice = undefined;
  ui.informationChoice = undefined;
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Restore Version History command", () => {
  it("runs kind -> workspace -> resource -> version -> confirmation on a real repository", async () => {
    const fixture = await createFixture();
    try {
      ui.answers.push(
        choose("Cursor conversations"),
        choose("project-a"),
        choose("Current conversation A"),
        choose("1 message"),
      );
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.restoreVersion();

      const events = await fixture.repository.listEvents();
      expect(events).toHaveLength(before + 1);
      expect(ui.offered.map((offer) => offer.title)).toEqual([
        "Restore Version History: choose a data type",
        "Restore Version History: choose a workspace or project",
        "Restore Version History: Cursor conversations — project-a",
        "Restore a version of Current conversation A",
      ]);
      expect(ui.confirmations[0]).toBe('Restore "Current conversation A"?');
      expect(ui.information.some((message) => message.includes("queued"))).toBe(true);

      const restoredEvent = events.at(-1);
      const restoredVersion = `${restoredEvent?.eventHash ?? ""}#0`;
      const restored = await fixture.repository.readVersion(restoredVersion);
      expect(restored.content?.equals(fixture.oldContent)).toBe(true);
      expect(restored.change.metadata?.syncOrigin).toBe("version-restore");
      expect(restored.change.metadata?.title).toBe("Earlier conversation A");
    } finally {
      fixture.manager.dispose();
    }
  });

  it("restores a large chat without reparsing the full snapshot to recover its title", async () => {
    const fixture = await createFixture(2 * 1024 * 1024);
    const parse = vi.spyOn(JSON, "parse");
    try {
      ui.answers.push(
        choose("Cursor conversations"),
        choose("project-a"),
        choose("Current conversation A"),
        choose("1 message"),
      );
      const before = (await fixture.repository.listEvents()).length;
      parse.mockClear();

      await fixture.manager.restoreVersion();

      expect(
        parse.mock.calls.filter(
          ([value]) =>
            typeof value === "string" && value.length > 1024 * 1024,
        ),
      ).toHaveLength(0);
      const events = await fixture.repository.listEvents();
      expect(events).toHaveLength(before + 1);
      const restored = await fixture.repository.readVersion(
        `${events.at(-1)?.eventHash ?? ""}#0`,
      );
      expect(restored.content?.equals(fixture.oldContent)).toBe(true);
      expect(restored.change.metadata?.title).toBe("Earlier conversation A");
    } finally {
      parse.mockRestore();
      fixture.manager.dispose();
    }
  });

  it("publishes nothing when the workspace picker is cancelled", async () => {
    const fixture = await createFixture();
    try {
      ui.answers.push(choose("Cursor conversations"), undefined);
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.restoreVersion();

      expect(await fixture.repository.listEvents()).toHaveLength(before);
      expect(ui.offered).toHaveLength(2);
      expect(ui.confirmations).toEqual([]);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("omits oversized current and selected previews before reading either payload", async () => {
    const fixture = await createFixture();
    try {
      const [resourceId] = Object.keys(fixture.repository.state.tips);
      if (resourceId === undefined) {
        throw new Error("expected a resource history");
      }
      const tips = fixture.repository.state.tips[resourceId] ?? [];
      const currentTip = tips.find((tip) => tip.operation === "put");
      if (currentTip?.payload === undefined) {
        throw new Error("expected current payload metadata");
      }
      currentTip.payload.plainBytes = 1024 * 1024 + 1;
      const summary: ResourceVersionSummary = {
        versionId: currentTip.versionId,
        resourceId,
        kind: currentTip.kind,
        operation: currentTip.operation,
        semanticHash: currentTip.semanticHash,
        lamport: currentTip.lamport,
        createdAt: currentTip.createdAt ?? new Date(0).toISOString(),
        deviceId: currentTip.deviceId,
        plainBytes: 1024 * 1024 + 1,
        fromCheckpoint: false,
        ...(currentTip.producer === undefined
          ? {}
          : { producer: currentTip.producer }),
      };
      const reads = vi.spyOn(fixture.repository, "tryReadVersion");
      type PreviewTip = (typeof tips)[number];
      const prototype = SyncManager.prototype as unknown as {
        showHistoryPreview(
          repository: SyncRepository,
          resourceId: string,
          tips: PreviewTip[],
          summary: ResourceVersionSummary,
        ): Promise<void>;
      };

      await prototype.showHistoryPreview.call(
        fixture.manager,
        fixture.repository,
        resourceId,
        tips,
        summary,
      );

      expect(reads).not.toHaveBeenCalled();
      const documents = (
        fixture.manager as unknown as {
          historyDocuments: Map<string, string>;
        }
      ).historyDocuments;
      expect([...documents.values()]).toHaveLength(2);
      expect(
        [...documents.values()].every((value) =>
          value.includes("preview omitted before reading"),
        ),
      ).toBe(true);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("refuses an over-limit selected restore before preview or payload read", async () => {
    const fixture = await createFixture(0, 128 * 1024 * 1024);
    try {
      ui.answers.push(
        choose("Cursor conversations"),
        choose("project-a"),
        choose("Current conversation A"),
        choose("1 message"),
      );
      declareHistoryPayloadBytes(
        fixture.repository,
        64 * 1024 * 1024 + 1,
      );
      const reads = vi.spyOn(fixture.repository, "tryReadVersion");
      const internals = fixture.manager as unknown as {
        showHistoryPreview: ReturnType<typeof vi.fn>;
      };
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.restoreVersion();

      expect(reads).not.toHaveBeenCalled();
      expect(internals.showHistoryPreview).not.toHaveBeenCalled();
      expect(await fixture.repository.listEvents()).toHaveLength(before);
      expect(ui.confirmations).toHaveLength(1);
      expect(ui.confirmations[0]).toContain("64.0 MiB restore limit");
      expect(ui.confirmations[0]).toContain("Nothing was read or changed");
    } finally {
      fixture.manager.dispose();
    }
  });

  it("uses a lower repository payload policy as the restore pre-read limit", async () => {
    const fixture = await createFixture();
    try {
      ui.answers.push(
        choose("Cursor conversations"),
        choose("project-a"),
        choose("Current conversation A"),
        choose("1 message"),
      );
      declareHistoryPayloadBytes(
        fixture.repository,
        4 * 1024 * 1024 + 1,
      );
      const reads = vi.spyOn(fixture.repository, "tryReadVersion");
      const internals = fixture.manager as unknown as {
        showHistoryPreview: ReturnType<typeof vi.fn>;
      };
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.restoreVersion();

      expect(reads).not.toHaveBeenCalled();
      expect(internals.showHistoryPreview).not.toHaveBeenCalled();
      expect(await fixture.repository.listEvents()).toHaveLength(before);
      expect(ui.confirmations).toHaveLength(1);
      expect(ui.confirmations[0]).toContain("4.0 MiB restore limit");
      expect(ui.confirmations[0]).toContain("repository payload policy");
      expect(ui.confirmations[0]).toContain("Nothing was read or changed");
    } finally {
      fixture.manager.dispose();
    }
  });
});

describe("Repair Unavailable Chats command", () => {
  it("finds the damaged chat and publishes one complete repair without a picker", async () => {
    const fixture = await createRepairFixture();
    try {
      ui.warningChoice = "Queue Repair";
      const before = (await fixture.repository.listEvents()).length;
      const tryReadVersion = vi.spyOn(
        fixture.repository,
        "tryReadVersion",
      );

      await fixture.manager.repairUnavailableChats();

      const events = await fixture.repository.listEvents();
      expect(events).toHaveLength(before + 1);
      expect(ui.offered).toEqual([]);
      expect(ui.confirmations).toEqual([
        "Repair 1 unavailable Cursor conversation?",
      ]);
      const repaired = await fixture.repository.readVersion(
        `${events.at(-1)?.eventHash ?? ""}#0`,
      );
      expect(repaired.change.metadata?.syncOrigin).toBe(
        "automatic-chat-repair",
      );
      expect(repaired.change.metadata?.repairedBubbleCount).toBe(1);
      expect(repaired.change.metadata?.repairOriginDeviceId).toBe(
        fixture.repository.state.device.deviceId,
      );
      expect(
        tryReadVersion.mock.calls.map(([versionId]) => versionId),
      ).not.toContain(fixture.olderVersionId);
      const payload = JSON.parse(
        repaired.content?.toString("utf8") ?? "null",
      ) as {
        header?: { value?: string };
        bubbles?: Array<{ key?: string; valueBase64?: string }>;
      };
      expect(payload.header?.value).toBe(JSON.stringify({ name: "Broken chat" }));
      expect(payload.bubbles?.map((bubble) => bubble.key)).toEqual([
        `bubbleId:${fixture.composerId}:a`,
        `bubbleId:${fixture.composerId}:b`,
        `bubbleId:${fixture.composerId}:c`,
      ]);
      const preservedC = payload.bubbles?.find(
        (bubble) => bubble.key === `bubbleId:${fixture.composerId}:c`,
      );
      expect(
        Buffer.from(preservedC?.valueBase64 ?? "", "base64").toString("utf8"),
      ).toBe(JSON.stringify({ text: "c" }));
      expect(
        ui.information.some((message) => message.includes("1 chat repair is queued")),
      ).toBe(true);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("queues a bounded partial batch and reports damaged chats deferred by the audit cap", async () => {
    const fixture = await createRepairFixture();
    try {
      const database = new DatabaseSync(fixture.globalDatabase);
      for (let index = 0; index < 8; index += 1) {
        const composerId = `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
        database
          .prepare(
            `INSERT INTO composerHeaders(
              composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
              isSubagent, recency, checkpointAt, value
            ) VALUES (?, 'project-a', 1, 1, 0, 0, 0, NULL, ?)`,
          )
          .run(composerId, JSON.stringify({ name: `Deferred ${index}` }));
        database
          .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
          .run(
            `composerData:${composerId}`,
            JSON.stringify({
              fullConversationHeadersOnly: [
                { bubbleId: `missing-${index}` },
              ],
            }),
          );
      }
      database.close();
      ui.warningChoice = "Queue Repair";
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.repairUnavailableChats();

      expect(await fixture.repository.listEvents()).toHaveLength(before + 1);
      expect(ui.confirmations).toEqual([
        "Repair 1 unavailable Cursor conversation?",
      ]);
      expect(ui.information.at(-1)).toContain(
        "1 additional damaged conversation was deferred by the command memory safety limit",
      );
      expect(ui.information.at(-1)).toContain(
        "run Repair Unavailable Chats again to inspect the next batch",
      );
      expect(
        ui.information.some((message) =>
          message.includes("No referenced chat message rows"),
        ),
      ).toBe(false);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("skips a single hard-oversized repair before bubble materialization and does not promise rerun progress", async () => {
    const fixture = await createRepairFixture();
    try {
      const database = new DatabaseSync(fixture.globalDatabase);
      database
        .prepare(
          "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(?))",
        )
        .run(
          `bubbleId:${fixture.composerId}:oversized-orphan`,
          4 * 1024 * 1024,
        );
      database.close();
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.repairUnavailableChats();

      expect(await fixture.repository.listEvents()).toHaveLength(before);
      expect(ui.confirmations.at(-1)).toContain(
        "exceeded the hard 4.0 MiB repair snapshot limit",
      );
      expect(ui.confirmations.at(-1)).toContain(
        "Rerunning alone cannot make it fit",
      );
      expect(ui.confirmations.at(-1)).not.toContain("Restore Version History");
      expect(ui.confirmations.at(-1)).toContain("not an all-clear result");
      expect(ui.confirmations.at(-1)).not.toContain(
        "run Repair Unavailable Chats again",
      );
    } finally {
      fixture.manager.dispose();
    }
  });

  it("retains and unions v2 continuation data while repairing legacy bubbles", async () => {
    const fixture = await createRepairFixture(true);
    try {
      ui.warningChoice = "Queue Repair";

      await fixture.manager.repairUnavailableChats();

      const events = await fixture.repository.listEvents();
      const repaired = await fixture.repository.readVersion(
        `${events.at(-1)?.eventHash ?? ""}#0`,
      );
      const payload = parsePortableChatSnapshot(
        repaired.content ?? Buffer.alloc(0),
      );
      const expected = fixture.agentKv;
      expect(expected).not.toBeNull();
      if (expected === null) {
        return;
      }
      expect(isPortableChatSnapshotV2(payload)).toBe(true);
      if (!isPortableChatSnapshotV2(payload)) {
        return;
      }
      expect(payload.agentKv.blobs.map((blob) => blob.key)).toEqual(
        expected.blobKeys,
      );
      expect(payload.agentKv.referencedIds).toEqual(expected.referencedIds);
      expect(payload.agentKv.missingIds).toEqual(expected.missingIds);
      expect(repaired.change.metadata).toMatchObject({
        chatSnapshotSchemaVersion: 2,
        agentKvBlobCount: expected.blobKeys.length,
        agentKvReferencedCount: expected.referencedIds.length,
        agentKvMissingCount: expected.missingIds.length,
        chatCoreHash: portableChatCoreHash(payload),
        bubbleCount: 3,
      });
    } finally {
      fixture.manager.dispose();
    }
  });

  it.each([
    ["malformed", "~not canonical base64"],
    [
      "over-limit",
      serializedRootStates(
        Array.from({ length: 4_097 }, (_unused, index) =>
          sha256(`too-many-live-repair-roots-${index}`),
        ),
      ),
    ],
  ])(
    "does not publish a v2 bubble repair whose live core roots are %s",
    async (_case, conversationState) => {
      const fixture = await createRepairFixture(true, conversationState);
      try {
        ui.warningChoice = "Queue Repair";
        const before = (await fixture.repository.listEvents()).length;

        await fixture.manager.repairUnavailableChats();

        expect(await fixture.repository.listEvents()).toHaveLength(before);
        expect(
          ui.information.some((message) => message.includes("repair is queued")),
        ).toBe(false);
        expect(ui.confirmations.at(-1)).toContain("Nothing was changed");
      } finally {
        fixture.manager.dispose();
      }
    },
  );

  it("defers a repair when disjoint valid histories exceed the aggregate bubble budget", async () => {
    const fixture = await createRepairFixture(false, undefined, 1_450_000);
    try {
      const maxPayloadBytes = fixture.repository.maxPayloadBytes;
      expect(fixture.candidatePayloadBytes).toHaveLength(2);
      expect(
        fixture.candidatePayloadBytes.every(
          (payloadBytes) => payloadBytes < maxPayloadBytes,
        ),
      ).toBe(true);
      expect(
        fixture.candidatePayloadBytes.reduce(
          (total, payloadBytes) => total + payloadBytes,
          0,
        ),
      ).toBeGreaterThan(
        maxPayloadBytes -
          Math.max(64 * 1024, Math.ceil(maxPayloadBytes / 10)),
      );
      ui.warningChoice = "Queue Repair";
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.repairUnavailableChats();

      expect(await fixture.repository.listEvents()).toHaveLength(before);
      expect(
        ui.information.some((message) => message.includes("repair is queued")),
      ).toBe(false);
      expect(ui.confirmations.at(-1)).toContain("Nothing was changed");
    } finally {
      fixture.manager.dispose();
    }
  });

  it("defers an over-limit declared history source before reading its payload", async () => {
    const fixture = await createRepairFixture(
      false,
      undefined,
      0,
      128 * 1024 * 1024,
    );
    try {
      const originalHistories =
        fixture.repository.listReachableResourceHistories.bind(
          fixture.repository,
        );
      vi.spyOn(
        fixture.repository,
        "listReachableResourceHistories",
      ).mockImplementation(async (...args) => {
        const histories = await originalHistories(...args);
        const history = histories.get(`chat/${fixture.composerId}`) ?? [];
        const newestPut = history.find(
          (summary) =>
            summary.kind === "chat" && summary.operation === "put",
        );
        expect(newestPut).toBeDefined();
        return new Map([
          [
            `chat/${fixture.composerId}`,
            newestPut === undefined
              ? []
              : [{ ...newestPut, plainBytes: 64 * 1024 * 1024 + 1 }],
          ],
        ]);
      });
      const reads = vi.spyOn(fixture.repository, "tryReadVersion");
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.repairUnavailableChats();

      expect(reads).not.toHaveBeenCalled();
      expect(await fixture.repository.listEvents()).toHaveLength(before);
      expect(ui.information).toEqual([]);
      expect(ui.confirmations).toHaveLength(1);
      expect(ui.confirmations[0]).toContain(
        "deferred because synchronized repair history exceeded",
      );
      expect(ui.confirmations[0]).toContain(
        "authenticated metadata to be oversized was not read",
      );
      expect(ui.confirmations[0]).toContain("not an all-clear result");
      expect(ui.confirmations[0]).toContain("Nothing was changed");
    } finally {
      fixture.manager.dispose();
    }
  });

  it("reaches an older complete source after sequential large partial sources", async () => {
    const fixture = await createRepairFixture(
      false,
      undefined,
      0,
      128 * 1024 * 1024,
    );
    try {
      ui.warningChoice = "Queue Repair";
      const originalHistories =
        fixture.repository.listReachableResourceHistories.bind(
          fixture.repository,
        );
      const declaredByVersion = new Map<string, number>();
      vi.spyOn(
        fixture.repository,
        "listReachableResourceHistories",
      ).mockImplementation(async (...args) => {
        const histories = await originalHistories(...args);
        const history = histories.get(`chat/${fixture.composerId}`) ?? [];
        const newestPartial = history[0];
        const complete = history[1];
        const olderPartial = history[2];
        expect(newestPartial).toBeDefined();
        expect(complete).toBeDefined();
        expect(olderPartial).toBeDefined();
        const ordered = [
          [newestPartial, 40 * 1024 * 1024],
          [olderPartial, 30 * 1024 * 1024],
          [complete, 1024 * 1024],
        ] as const;
        for (const [summary, plainBytes] of ordered) {
          if (summary !== undefined) {
            declaredByVersion.set(summary.versionId, plainBytes);
          }
        }
        return new Map([
          [
            `chat/${fixture.composerId}`,
            ordered.flatMap(([summary, plainBytes]) =>
              summary === undefined ? [] : [{ ...summary, plainBytes }],
            ),
          ],
        ]);
      });
      const originalRead = fixture.repository.tryReadVersion.bind(
        fixture.repository,
      );
      const reads = vi
        .spyOn(fixture.repository, "tryReadVersion")
        .mockImplementation(async (versionId) => {
          const data = await originalRead(versionId);
          const plainBytes = declaredByVersion.get(versionId);
          return data === null || data.change.payload === undefined ||
            plainBytes === undefined
            ? data
            : {
                ...data,
                change: {
                  ...data.change,
                  payload: { ...data.change.payload, plainBytes },
                },
              };
        });
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.repairUnavailableChats();

      expect(await fixture.repository.listEvents()).toHaveLength(before + 1);
      expect(reads).toHaveBeenCalledTimes(6);
      expect(ui.confirmations).toEqual([
        "Repair 1 unavailable Cursor conversation?",
      ]);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("uses a newest complete source without summing a long unused history", async () => {
    const fixture = await createRepairFixture(
      false,
      undefined,
      0,
      128 * 1024 * 1024,
    );
    try {
      ui.warningChoice = "Queue Repair";
      const originalHistories =
        fixture.repository.listReachableResourceHistories.bind(
          fixture.repository,
        );
      let completeVersionId = "";
      vi.spyOn(
        fixture.repository,
        "listReachableResourceHistories",
      ).mockImplementation(async (...args) => {
        const histories = await originalHistories(...args);
        const history = histories.get(`chat/${fixture.composerId}`) ?? [];
        const complete = history[1];
        const older = history[2];
        expect(complete).toBeDefined();
        expect(older).toBeDefined();
        completeVersionId = complete?.versionId ?? "";
        return new Map([
          [
            `chat/${fixture.composerId}`,
            complete === undefined || older === undefined
              ? []
              : [
                  complete,
                  ...Array.from({ length: 100 }, () => ({
                    ...older,
                    plainBytes: 1024 * 1024,
                  })),
                ],
          ],
        ]);
      });
      const reads = vi.spyOn(fixture.repository, "tryReadVersion");
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.repairUnavailableChats();

      expect(await fixture.repository.listEvents()).toHaveLength(before + 1);
      expect(reads).toHaveBeenCalledTimes(2);
      expect(
        reads.mock.calls.map(([versionId]) => versionId),
      ).toEqual([completeVersionId, completeVersionId]);
      expect(ui.confirmations).toEqual([
        "Repair 1 unavailable Cursor conversation?",
      ]);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("releases the planning lock before walking history payloads", async () => {
    const fixture = await createRepairFixture();
    try {
      ui.warningChoice = "Queue Repair";
      let firstLockReleased = false;
      let lockCount = 0;
      const internals = fixture.manager as unknown as {
        takeCommandLock: () => Promise<{ release: () => Promise<void> }>;
      };
      internals.takeCommandLock = vi.fn(async () => {
        lockCount += 1;
        const thisLock = lockCount;
        return {
          release: async () => {
            if (thisLock === 1) {
              firstLockReleased = true;
            }
          },
        };
      });
      const originalHistories =
        fixture.repository.listReachableResourceHistories.bind(
          fixture.repository,
        );
      const histories = vi
        .spyOn(fixture.repository, "listReachableResourceHistories")
        .mockImplementation(async (...args) => {
          expect(firstLockReleased).toBe(true);
          return originalHistories(...args);
        });
      const originalRead = fixture.repository.tryReadVersion.bind(
        fixture.repository,
      );
      const reads = vi
        .spyOn(fixture.repository, "tryReadVersion")
        .mockImplementation(async (versionId) => {
          expect(firstLockReleased).toBe(true);
          return originalRead(versionId);
        });

      await fixture.manager.repairUnavailableChats();

      expect(histories).toHaveBeenCalledOnce();
      expect(reads).toHaveBeenCalled();
      expect(lockCount).toBe(2);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("diagnoses missing continuation blobs without publishing or exposing their IDs", async () => {
    const fixture = await createContinuationRepairFixture("missing");
    try {
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.repairUnavailableChats();

      expect(await fixture.repository.listEvents()).toHaveLength(before);
      expect(ui.information).toEqual([]);
      expect(ui.confirmations).toHaveLength(1);
      const warning = ui.confirmations[0] ?? "";
      expect(warning).toContain(
        "1 Cursor conversation has 1 unavailable continuation blob",
      );
      expect(warning).toContain(
        "this PC and the synchronized legacy history lack the continuation blobs",
      );
      expect(warning).toContain(
        "run Sync Now on a PC where the affected chat still continues",
      );
      expect(warning).toContain(
        "then run Sync Now on this PC and choose Restart to Apply",
      );
      expect(warning).not.toContain(fixture.rootId);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("audits continuation data after advancing beyond three no-source message-body pages", async () => {
    const fixture = await createContinuationRepairFixture("missing");
    try {
      const database = new DatabaseSync(fixture.globalDatabase);
      for (let index = 0; index < 17; index += 1) {
        const composerId = `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
        database
          .prepare(
            `INSERT INTO composerHeaders(
              composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
              isSubagent, recency, checkpointAt, value
            ) VALUES (?, 'project-a', 1, ?, 0, 0, 0, NULL, ?)`,
          )
          .run(
            composerId,
            100 + index,
            JSON.stringify({ name: `No source ${index}` }),
          );
        database
          .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
          .run(
            `composerData:${composerId}`,
            JSON.stringify({
              fullConversationHeadersOnly: [{ bubbleId: `missing-${index}` }],
            }),
          );
      }
      const structurallyBoundedComposer =
        "70000000-0000-4000-8000-999999999999";
      database
        .prepare(
          `INSERT INTO composerHeaders(
            composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
            isSubagent, recency, checkpointAt, value
          ) VALUES (?, 'project-a', 1, 200, 0, 0, 0, NULL, ?)`,
        )
        .run(
          structurallyBoundedComposer,
          JSON.stringify({ name: "Bounded healthy chat" }),
        );
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(
          `composerData:${structurallyBoundedComposer}`,
          JSON.stringify({
            fullConversationHeadersOnly: [],
            boundedNoise: Array.from({ length: 270_000 }, () => null),
          }),
        );
      database.close();
      const before = (await fixture.repository.listEvents()).length;

      await fixture.manager.repairUnavailableChats();

      expect(await fixture.repository.listEvents()).toHaveLength(before);
      expect(
        ui.progressReports.filter(
          (message) =>
            message === "Checking which chat messages are unavailable...",
        ),
      ).toHaveLength(4);
      expect(ui.information).toEqual([]);
      expect(ui.confirmations).toHaveLength(1);
      const warning = ui.confirmations[0] ?? "";
      expect(warning).toContain(
        "17 unavailable message-body conversations have no warning-free compatible synchronized source",
      );
      expect(warning).toContain(
        "1 Cursor conversation has 1 unavailable continuation blob",
      );
      expect(warning).toContain(
        "run Sync Now on a PC where the affected chat still continues",
      );
      expect(warning).not.toContain("Restore Version History");
      expect(warning).not.toContain("inspect the next batch");
      expect(warning).not.toContain("memory safety limit");
      expect(warning).toContain(
        "per-conversation JSON or metadata safety bound",
      );
    } finally {
      fixture.manager.dispose();
    }
  });

  it("offers the existing restart path when a complete v2 chat tip is pending", async () => {
    const fixture = await createContinuationRepairFixture("complete-pending");
    try {
      ui.informationChoice = "Restart to Apply";
      const restart = vi
        .spyOn(fixture.manager, "restartToApply")
        .mockResolvedValue(undefined);

      await fixture.manager.repairUnavailableChats();

      expect(restart).toHaveBeenCalledOnce();
      expect(ui.confirmations).toEqual([]);
      expect(ui.information).toHaveLength(1);
      expect(ui.information[0]).toContain(
        "complete synchronized v2 copy queued on this PC",
      );
      expect(ui.information[0]).toContain("1 unavailable continuation blob");
      expect(ui.information[0]).not.toContain(fixture.rootId);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("rejects an oversized complete-v2 continuation source before reading it", async () => {
    const fixture = await createContinuationRepairFixture("complete-pending");
    try {
      const [tip] = Object.values(fixture.repository.state.tips).flat();
      if (tip?.payload === undefined) {
        throw new Error("expected complete-v2 payload metadata");
      }
      tip.payload.plainBytes = 4 * 1024 * 1024 + 1;
      const reads = vi.spyOn(fixture.repository, "tryReadVersion");

      await fixture.manager.repairUnavailableChats();

      expect(reads).not.toHaveBeenCalled();
      expect(ui.information).toEqual([]);
      expect(ui.confirmations).toHaveLength(1);
      expect(ui.confirmations[0]).toContain(
        "4.0 MiB repair source limit",
      );
      expect(ui.confirmations[0]).toContain("was not read");
      expect(
        fixture.repository.state.pendingDatabaseChanges,
      ).toHaveLength(1);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("still offers continuation recovery when another healthy chat has a huge orphan body", async () => {
    const fixture = await createContinuationRepairFixture("complete-pending");
    try {
      const healthyComposerId = "77777777-7777-4777-8777-777777777777";
      const database = new DatabaseSync(fixture.globalDatabase);
      database
        .prepare(
          `INSERT INTO composerHeaders(
            composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
            isSubagent, recency, checkpointAt, value
          ) VALUES (?, 'project-a', 1, 30, 0, 0, 0, NULL, ?)`,
        )
        .run(healthyComposerId, JSON.stringify({ name: "Huge healthy chat" }));
      const insert = database.prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
      );
      insert.run(
        `composerData:${healthyComposerId}`,
        JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "a" }] }),
      );
      insert.run(
        `bubbleId:${healthyComposerId}:a`,
        JSON.stringify({ text: "healthy" }),
      );
      database
        .prepare(
          "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(?))",
        )
        .run(`bubbleId:${healthyComposerId}:orphan`, 4 * 1024 * 1024);
      database.close();
      ui.informationChoice = "Restart to Apply";
      const restart = vi
        .spyOn(fixture.manager, "restartToApply")
        .mockResolvedValue(undefined);

      await fixture.manager.repairUnavailableChats();

      expect(restart).toHaveBeenCalledOnce();
      expect(ui.confirmations).toEqual([]);
      expect(ui.information).toHaveLength(1);
      expect(ui.information[0]).toContain(
        "complete synchronized v2 copy queued on this PC",
      );
      expect(ui.information[0]).toContain("1 continuation record");
    } finally {
      fixture.manager.dispose();
    }
  });

  it("re-queues a complete current v2 tip when local continuation blobs disappeared", async () => {
    const fixture = await createContinuationRepairFixture("complete-current");
    try {
      expect(fixture.repository.state.pendingDatabaseChanges).toEqual([]);
      ui.informationChoice = "Restart to Apply";
      const restart = vi
        .spyOn(fixture.manager, "restartToApply")
        .mockResolvedValue(undefined);

      await fixture.manager.repairUnavailableChats();

      expect(restart).toHaveBeenCalledOnce();
      expect(ui.confirmations).toEqual([]);
      expect(ui.information).toHaveLength(1);
      expect(ui.information[0]).toContain(
        "complete synchronized v2 copy queued on this PC",
      );
      expect(
        fixture.repository.state.pendingDatabaseChanges.map(
          (change) => change.resourceId,
        ),
      ).toEqual(["chat/66666666-6666-4666-8666-666666666666"]);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("does not queue an ordinary complete v2 tip whose chat core differs from the live chat", async () => {
    const fixture = await createContinuationRepairFixture(
      "complete-current-divergent-core",
    );
    try {
      ui.informationChoice = "Restart to Apply";
      const restart = vi
        .spyOn(fixture.manager, "restartToApply")
        .mockResolvedValue(undefined);

      await fixture.manager.repairUnavailableChats();

      expect(restart).not.toHaveBeenCalled();
      expect(fixture.repository.state.pendingDatabaseChanges).toEqual([]);
      expect(ui.confirmations.at(-1)).toContain(
        "does not have a complete synchronized v2 copy queued here",
      );
    } finally {
      fixture.manager.dispose();
    }
  });

  it("queues divergent-core enrichment only for its blob-only helper recipe", async () => {
    const fixture = await createContinuationRepairFixture(
      "complete-enrichment-divergent-core",
    );
    try {
      ui.informationChoice = "Restart to Apply";
      const restart = vi
        .spyOn(fixture.manager, "restartToApply")
        .mockResolvedValue(undefined);

      await fixture.manager.repairUnavailableChats();

      expect(restart).toHaveBeenCalledOnce();
      expect(
        fixture.repository.state.pendingDatabaseChanges.map(
          (change) => change.resourceId,
        ),
      ).toEqual(["chat/66666666-6666-4666-8666-666666666666"]);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("rejects a complete pending v2 tip whose materialized roots belong to another state", async () => {
    const fixture = await createContinuationRepairFixture("divergent-pending");
    try {
      ui.informationChoice = "Restart to Apply";
      const restart = vi
        .spyOn(fixture.manager, "restartToApply")
        .mockResolvedValue(undefined);

      await fixture.manager.repairUnavailableChats();

      expect(restart).not.toHaveBeenCalled();
      expect(ui.information).toEqual([]);
      expect(ui.confirmations).toHaveLength(1);
      expect(ui.confirmations[0]).toContain(
        "does not have a complete synchronized v2 copy queued here",
      );
      expect(ui.confirmations[0]).toContain(
        "run Sync Now on a PC where the affected chat still continues",
      );
      expect(ui.confirmations[0]).not.toContain(fixture.rootId);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("reports a healthy chat only after checking message rows and the reachable continuation graph", async () => {
    const fixture = await createContinuationRepairFixture("healthy");
    try {
      await fixture.manager.repairUnavailableChats();

      expect(ui.confirmations).toEqual([]);
      expect(ui.information).toEqual([
        "Checked 1 Cursor conversation message bodies and 1 continuation records. No referenced chat message rows or reachable continuation blobs are unavailable.",
      ]);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("warns instead of claiming an all-clear when continuation state is unreadable", async () => {
    const fixture = await createContinuationRepairFixture("unreadable");
    try {
      await fixture.manager.repairUnavailableChats();

      expect(ui.information).toEqual([]);
      expect(ui.confirmations).toHaveLength(1);
      expect(ui.confirmations[0]).toContain(
        "No definite unavailable chat data was found",
      );
      expect(ui.confirmations[0]).toContain(
        "1 continuation record was not safely readable",
      );
      expect(ui.confirmations[0]).not.toContain("No referenced chat message rows");
    } finally {
      fixture.manager.dispose();
    }
  });
});

type ContinuationRepairFixtureMode =
  | "missing"
  | "complete-current"
  | "complete-current-divergent-core"
  | "complete-enrichment-divergent-core"
  | "complete-pending"
  | "divergent-pending"
  | "healthy"
  | "unreadable";

async function createContinuationRepairFixture(
  mode: ContinuationRepairFixtureMode,
): Promise<{
  manager: SyncManager;
  repository: SyncRepository;
  rootId: string;
  globalDatabase: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-continuation-command-"));
  temporaryRoots.push(root);
  const repository = await SyncRepository.create(
    join(root, "repository"),
    join(root, "storage"),
    "a sufficiently long test passphrase",
    4 * 1024 * 1024,
    producer,
  );
  const composerId = "66666666-6666-4666-8666-666666666666";
  const blob = Buffer.from("portable continuation root", "utf8");
  const rootId = sha256(blob);
  const state = serializedRootState(rootId);
  const storedBlob =
    mode === "divergent-pending"
      ? Buffer.from("another conversation root", "utf8")
      : blob;
  const storedRootId = sha256(storedBlob);
  const storedState = serializedRootState(storedRootId);
  const completeV2 =
    mode === "complete-current" ||
    mode === "complete-current-divergent-core" ||
    mode === "complete-enrichment-divergent-core" ||
    mode === "complete-pending" ||
    mode === "divergent-pending";
  const completePending =
    mode === "complete-pending" || mode === "divergent-pending";
  const published = await repository.publish(
    [
      continuationChatSnapshot(
        composerId,
        storedState,
        storedRootId,
        storedBlob,
        completeV2,
        mode === "complete-current-divergent-core" ||
          mode === "complete-enrichment-divergent-core"
          ? "Older synchronized core"
          : "Continuation chat",
        mode === "complete-enrichment-divergent-core",
      ),
    ],
    [],
  );
  new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  );
  if (completePending) {
    const versionId = `${requiredHash(published.eventHash)}#0`;
    const tip = repository.state.tips[`chat/${composerId}`]?.find(
      (candidate) => candidate.versionId === versionId,
    );
    if (tip === undefined) {
      throw new Error("Expected a complete continuation tip.");
    }
    repository.state.pendingDatabaseChanges.push({
      eventHash: tip.eventHash,
      changeIndex: tip.changeIndex,
      resourceId: `chat/${composerId}`,
      kind: "chat",
    });
  }
  await repository.saveState();

  const globalDatabase = join(root, "state.vscdb");
  const database = new DatabaseSync(globalDatabase);
  database.exec(`
    CREATE TABLE composerHeaders(
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
      recency INTEGER, checkpointAt INTEGER, value TEXT
    );
    CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value);
  `);
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, 'project-a', 1, 20, 0, 0, 0, NULL, ?)`,
    )
    .run(composerId, JSON.stringify({ name: "Continuation chat" }));
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(
      `composerData:${composerId}`,
      JSON.stringify({
        fullConversationHeadersOnly: [{ bubbleId: "a" }],
        conversationState:
          mode === "unreadable" ? "~not canonical base64" : state,
      }),
    );
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "renderable" }));
  if (mode === "healthy") {
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${rootId}`, blob);
  }
  database.close();

  const paths = {
    globalDatabase,
    extensionStorage: join(root, "extension-storage"),
    helperScript: join(root, "helper.js"),
  } as unknown as CursorPaths;
  const compatibility = {
    compatible: true,
    ...producer,
    nodeVersion: process.versions.node,
    sqliteAvailable: true,
    sqliteBackupAvailable: true,
    globalDatabasePath: globalDatabase,
    databaseCapabilities: {
      "global-item-table": { available: true, reasons: [] },
      "global-chat": { available: true, reasons: [] },
      "sqlite-files": { available: true, reasons: [] },
    },
    reasons: [],
    warnings: [],
  } satisfies CompatibilityReport;
  const manager = new SyncManager(
    {} as never,
    paths,
    compatibility,
    {
      syncChat: true,
      syncWorkspaceStorage: true,
      maxPayloadBytes: 4 * 1024 * 1024,
    } as unknown as ExtensionConfiguration,
    { log: vi.fn() } as unknown as StatusController,
    {} as ConflictController,
  );
  const internals = manager as unknown as {
    repository: SyncRepository;
    takeCommandLock: () => Promise<{ release: () => Promise<void> }>;
    openGitWindow: () => Promise<boolean>;
    commitGitWindow: () => Promise<void>;
    syncNow: () => Promise<void>;
  };
  internals.repository = repository;
  internals.takeCommandLock = vi.fn(async () => ({
    release: async () => undefined,
  }));
  internals.openGitWindow = vi.fn(async () => false);
  internals.commitGitWindow = vi.fn(async () => undefined);
  internals.syncNow = vi.fn(async () => undefined);
  return { manager, repository, rootId, globalDatabase };
}

function continuationChatSnapshot(
  composerId: string,
  conversationState: string,
  rootId: string,
  blob: Buffer,
  completeV2: boolean,
  title = "Continuation chat",
  enrichment = false,
): ResourceSnapshot {
  const core = {
    composerId,
    header: {
      composerId,
      workspaceId: "project-a",
      createdAt: 1,
      lastUpdatedAt: 20,
      isArchived: 0,
      isSubagent: 0,
      recency: 0,
      checkpointAt: null,
      value: JSON.stringify({ name: title }),
    },
    composerData: {
      key: `composerData:${composerId}`,
      valueBase64: Buffer.from(
        JSON.stringify({
          fullConversationHeadersOnly: [{ bubbleId: "a" }],
          conversationState,
        }),
        "utf8",
      ).toString("base64"),
      valueType: "text" as const,
    },
    bubbles: [
      {
        key: `bubbleId:${composerId}:a`,
        valueBase64: Buffer.from(
          JSON.stringify({ text: "renderable" }),
          "utf8",
        ).toString("base64"),
        valueType: "text" as const,
      },
    ],
  };
  const portable = completeV2
    ? {
        ...core,
        schemaVersion: 2,
        agentKv: {
          blobs: [
            {
              key: `agentKv:blob:${rootId}`,
              valueBase64: blob.toString("base64"),
              valueType: "blob",
            },
          ],
          referencedIds: [rootId],
          missingIds: [],
        },
      }
    : { ...core, schemaVersion: 1 };
  const content = canonicalBytes(portable);
  const parsed = parsePortableChatSnapshot(content);
  return {
    resourceId: `chat/${composerId}`,
    kind: "chat",
    content,
    semanticHash: sha256(content),
    metadata: {
      composerId,
      workspaceId: "project-a",
      workspaceUri: "file:///C:/work/project-a",
      lastUpdatedAt: 20,
      bubbleCount: 1,
      title,
      chatCoreHash: portableChatCoreHash(parsed),
      chatSnapshotSchemaVersion: completeV2 ? 2 : 1,
      ...(enrichment
        ? {
            syncOrigin: "agent-kv-enrichment",
            originalProducer: {
              extensionVersion: producer.extensionVersion,
              cursorVersion: producer.cursorVersion,
              vscodeVersion: producer.vscodeVersion,
            },
          }
        : {}),
      ...(completeV2
        ? {
            agentKvBlobCount: 1,
            agentKvReferencedCount: 1,
            agentKvMissingCount: 0,
          }
        : {}),
    },
  };
}

function serializedRootState(rootId: string): string {
  return serializedRootStates([rootId]);
}

function serializedRootStates(rootIds: readonly string[]): string {
  return `~${Buffer.concat(
    rootIds.map((rootId) =>
      Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(rootId, "hex")]),
    ),
  ).toString("base64")}`;
}

async function createRepairFixture(
  withAgentKv = false,
  liveConversationState?: string,
  disjointBubbleBytes = 0,
  maxPayloadBytes = 4 * 1024 * 1024,
): Promise<{
  manager: SyncManager;
  repository: SyncRepository;
  composerId: string;
  olderVersionId: string;
  candidatePayloadBytes: number[];
  globalDatabase: string;
  agentKv: {
    blobKeys: string[];
    referencedIds: string[];
    missingIds: string[];
  } | null;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-repair-command-"));
  temporaryRoots.push(root);
  const repository = await SyncRepository.create(
    join(root, "repository"),
    join(root, "storage"),
    "a sufficiently long test passphrase",
    maxPayloadBytes,
    producer,
  );
  const composerId = "55555555-5555-4555-8555-555555555555";
  const liveCoreRootId = sha256("live repaired core root");
  const effectiveLiveConversationState =
    liveConversationState ??
    (withAgentKv ? serializedRootState(liveCoreRootId) : undefined);
  const selectedAgentKv = withAgentKv
    ? testAgentKvPayload(
        [Buffer.from("selected materialized continuation", "utf8")],
        [Buffer.from("selected missing continuation", "utf8")],
      )
    : null;
  const currentAgentKv = withAgentKv
    ? testAgentKvPayload(
        [Buffer.from("current materialized continuation", "utf8")],
        [Buffer.from("current missing continuation", "utf8")],
      )
    : null;
  const older = await repository.publish(
    [repairChatSnapshot(composerId, ["a"])],
    [],
  );
  const olderVersionId = `${requiredHash(older.eventHash)}#0`;
  const selectedRepair = repairChatSnapshot(
    composerId,
    ["a", "b", "c"],
    [],
    selectedAgentKv,
    disjointBubbleBytes === 0
      ? []
      : [
          {
            id: "selected-large",
            value: { text: "s".repeat(disjointBubbleBytes) },
          },
        ],
  );
  const complete = await repository.publish(
    [
      {
        ...selectedRepair,
        parents: [olderVersionId],
      },
    ],
    [],
  );
  const currentRepair = repairChatSnapshot(
    composerId,
    ["a", "c"],
    ["c"],
    currentAgentKv,
    disjointBubbleBytes === 0
      ? []
      : [
          {
            id: "current-large",
            value: { text: "c".repeat(disjointBubbleBytes) },
          },
        ],
  );
  await repository.publish(
    [
      {
        // The newest partial version has an unreferenced row. Selection only
        // retains missing-key candidates, but the published repair must still
        // preserve the older usable c for future peers when this copy is bad.
        ...currentRepair,
        parents: [`${requiredHash(complete.eventHash)}#0`],
      },
    ],
    [],
  );
  new EventReconciler().reconcile(await repository.listEvents(), repository.state, null);
  await repository.saveState();

  const globalDatabase = join(root, "state.vscdb");
  const database = new DatabaseSync(globalDatabase);
  database.exec(`
    CREATE TABLE composerHeaders(
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
      recency INTEGER, checkpointAt INTEGER, value TEXT
    );
    CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value);
  `);
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, 'project-a', 1, 2, 0, 0, 0, NULL, ?)`,
    )
    .run(composerId, JSON.stringify({ name: "Broken chat" }));
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(
      `composerData:${composerId}`,
      JSON.stringify({
        fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
        ...(effectiveLiveConversationState === undefined
          ? {}
          : { conversationState: effectiveLiveConversationState }),
      }),
    );
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "a" }));
  database.close();

  const paths = {
    globalDatabase,
    extensionStorage: join(root, "extension-storage"),
    helperScript: join(root, "helper.js"),
  } as unknown as CursorPaths;
  const compatibility = {
    compatible: true,
    ...producer,
    nodeVersion: process.versions.node,
    sqliteAvailable: true,
    sqliteBackupAvailable: true,
    globalDatabasePath: globalDatabase,
    databaseCapabilities: {
      "global-item-table": { available: true, reasons: [] },
      "global-chat": { available: true, reasons: [] },
      "sqlite-files": { available: true, reasons: [] },
    },
    reasons: [],
    warnings: [],
  } satisfies CompatibilityReport;
  const manager = new SyncManager(
    {} as never,
    paths,
    compatibility,
    {
      syncChat: true,
      syncWorkspaceStorage: true,
      maxPayloadBytes,
    } as unknown as ExtensionConfiguration,
    { log: vi.fn() } as unknown as StatusController,
    {} as ConflictController,
  );
  const internals = manager as unknown as {
    repository: SyncRepository;
    takeCommandLock: () => Promise<{ release: () => Promise<void> }>;
    openGitWindow: () => Promise<boolean>;
    commitGitWindow: () => Promise<void>;
    syncNow: () => Promise<void>;
  };
  internals.repository = repository;
  internals.takeCommandLock = vi.fn(async () => ({
    release: async () => undefined,
  }));
  internals.openGitWindow = vi.fn(async () => false);
  internals.commitGitWindow = vi.fn(async () => undefined);
  internals.syncNow = vi.fn(async () => undefined);
  const combinedBlobs = [
    ...(selectedAgentKv?.blobs ?? []),
    ...(currentAgentKv?.blobs ?? []),
  ].sort((left, right) => left.key.localeCompare(right.key));
  const combinedReferences = [
    ...(selectedAgentKv?.referencedIds ?? []),
    ...(currentAgentKv?.referencedIds ?? []),
    ...(withAgentKv && liveConversationState === undefined
      ? [liveCoreRootId]
      : []),
  ].sort();
  const materializedIds = new Set(
    combinedBlobs.map((blob) => blob.key.slice("agentKv:blob:".length)),
  );
  return {
    manager,
    repository,
    composerId,
    olderVersionId,
    globalDatabase,
    candidatePayloadBytes: [
      selectedRepair.content.byteLength,
      currentRepair.content.byteLength,
    ],
    agentKv: withAgentKv
      ? {
          blobKeys: combinedBlobs.map((blob) => blob.key),
          referencedIds: combinedReferences,
          missingIds: combinedReferences.filter(
            (id) => !materializedIds.has(id),
          ),
        }
      : null,
  };
}

function repairChatSnapshot(
  composerId: string,
  bubbleIds: string[] = ["a", "b"],
  invalidBubbleIds: string[] = [],
  agentKv: PortableAgentKvPayload | null = null,
  extraBubbles: ReadonlyArray<{ id: string; value: unknown }> = [],
): ResourceSnapshot {
  const invalid = new Set(invalidBubbleIds);
  const core = {
    composerId,
    header: {
      composerId,
      workspaceId: "project-a",
      createdAt: 1,
      lastUpdatedAt: 2,
      isArchived: 0,
      isSubagent: 0,
      recency: 0,
      checkpointAt: null,
      value: JSON.stringify({ name: "Broken chat" }),
    },
    composerData: {
      key: `composerData:${composerId}`,
      valueBase64: Buffer.from(
        JSON.stringify({
          fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
        }),
        "utf8",
      ).toString("base64"),
      valueType: "text",
    },
    bubbles: [
      ...bubbleIds.map((id) => ({
        key: `bubbleId:${composerId}:${id}`,
        valueBase64: Buffer.from(
          invalid.has(id) ? "not-json" : JSON.stringify({ text: id }),
          "utf8",
        ).toString("base64"),
        valueType: "text",
      })),
      ...extraBubbles.map((bubble) => ({
        key: `bubbleId:${composerId}:${bubble.id}`,
        valueBase64: Buffer.from(
          JSON.stringify(bubble.value),
          "utf8",
        ).toString("base64"),
        valueType: "text",
      })),
    ],
  };
  const content = canonicalBytes(
    agentKv === null
      ? { ...core, schemaVersion: 1 }
      : { ...core, schemaVersion: 2, agentKv },
  );
  return {
    resourceId: `chat/${composerId}`,
    kind: "chat",
    content,
    semanticHash: sha256(content),
    metadata: {
      composerId,
      workspaceId: "project-a",
      workspaceUri: "file:///C:/work/project-a",
      bubbleCount: bubbleIds.length + extraBubbles.length,
      title: "Broken chat",
      chatSnapshotSchemaVersion: agentKv === null ? 1 : 2,
      ...(agentKv === null
        ? {}
        : {
            agentKvBlobCount: agentKv.blobs.length,
            agentKvReferencedCount: agentKv.referencedIds.length,
            agentKvMissingCount: agentKv.missingIds.length,
          }),
    },
  };
}

function testAgentKvPayload(
  materialized: Buffer[],
  missing: Buffer[],
): PortableAgentKvPayload {
  const blobs = materialized
    .map((value) => ({
      key: `agentKv:blob:${sha256(value)}`,
      valueBase64: value.toString("base64"),
      valueType: "blob" as const,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const referencedIds = [
    ...blobs.map((blob) => blob.key.slice("agentKv:blob:".length)),
    ...missing.map((value) => sha256(value)),
  ].sort();
  const materializedIds = new Set(
    blobs.map((blob) => blob.key.slice("agentKv:blob:".length)),
  );
  return {
    blobs,
    referencedIds,
    missingIds: referencedIds.filter((id) => !materializedIds.has(id)),
  };
}

function declareHistoryPayloadBytes(
  repository: SyncRepository,
  plainBytes: number,
): void {
  const original = repository.listReachableResourceHistories.bind(repository);
  vi.spyOn(repository, "listReachableResourceHistories").mockImplementation(
    async (...args) => {
      const histories = await original(...args);
      return new Map(
        [...histories].map(([resourceId, history]) => [
          resourceId,
          history.map((summary) => ({ ...summary, plainBytes })),
        ]),
      );
    },
  );
}

async function createFixture(
  oldPayloadPaddingBytes = 0,
  maxPayloadBytes = 4 * 1024 * 1024,
): Promise<{
  manager: SyncManager;
  repository: SyncRepository;
  oldContent: Buffer;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-restore-command-"));
  temporaryRoots.push(root);
  const repository = await SyncRepository.create(
    join(root, "repository"),
    join(root, "storage"),
    "a sufficiently long test passphrase",
    maxPayloadBytes,
    producer,
  );
  const chatA = "00000000-0000-4000-8000-00000000000a";
  const chatB = "00000000-0000-4000-8000-00000000000b";
  const oldA = chatSnapshot(
    chatA,
    "Earlier conversation A",
    "project-a",
    1,
    oldPayloadPaddingBytes,
  );
  const firstA = await repository.publish([oldA], []);
  await repository.publish(
    [
      {
        ...chatSnapshot(chatA, "Current conversation A", "project-a", 2),
        parents: [`${requiredHash(firstA.eventHash)}#0`],
      },
    ],
    [],
  );
  const firstB = await repository.publish(
    [chatSnapshot(chatB, "Earlier conversation B", "project-b", 1)],
    [],
  );
  await repository.publish(
    [
      {
        ...chatSnapshot(chatB, "Current conversation B", "project-b", 2),
        parents: [`${requiredHash(firstB.eventHash)}#0`],
      },
    ],
    [],
  );
  new EventReconciler().reconcile(await repository.listEvents(), repository.state, null);
  await repository.saveState();

  const paths = {
    extensionStorage: join(root, "extension-storage"),
    helperScript: join(root, "helper.js"),
  } as unknown as CursorPaths;
  const compatibility = {
    compatible: true,
    ...producer,
    nodeVersion: process.versions.node,
    sqliteAvailable: true,
    sqliteBackupAvailable: true,
    globalDatabasePath: join(root, "state.vscdb"),
    databaseCapabilities: {
      "global-item-table": { available: true, reasons: [] },
      "global-chat": { available: true, reasons: [] },
      "sqlite-files": { available: true, reasons: [] },
    },
    reasons: [],
    warnings: [],
  } satisfies CompatibilityReport;
  const configuration = {
    syncChat: true,
    syncWorkspaceStorage: true,
    maxPayloadBytes,
  } as unknown as ExtensionConfiguration;
  const status = {
    log: vi.fn(),
  } as unknown as StatusController;
  const manager = new SyncManager(
    {} as never,
    paths,
    compatibility,
    configuration,
    status,
    {} as ConflictController,
  );
  const internals = manager as unknown as {
    repository: SyncRepository;
    takeCommandLock: () => Promise<{ release: () => Promise<void> }>;
    openGitWindow: () => Promise<boolean>;
    commitGitWindow: () => Promise<void>;
    showHistoryPreview: () => Promise<void>;
    syncNow: () => Promise<void>;
  };
  internals.repository = repository;
  internals.takeCommandLock = vi.fn(async () => ({
    release: async () => undefined,
  }));
  internals.openGitWindow = vi.fn(async () => false);
  internals.commitGitWindow = vi.fn(async () => undefined);
  internals.showHistoryPreview = vi.fn(async () => undefined);
  internals.syncNow = vi.fn(async () => undefined);
  return { manager, repository, oldContent: oldA.content };
}

function chatSnapshot(
  composerId: string,
  title: string,
  project: string,
  bubbleCount: number,
  payloadPaddingBytes = 0,
): ResourceSnapshot {
  const content = canonicalBytes({
    schemaVersion: 1,
    composerId,
    header: {
      composerId,
      workspaceId: project,
      createdAt: 1,
      lastUpdatedAt: 1_786_100_000_000 + bubbleCount,
      isArchived: 0,
      isSubagent: 0,
      recency: 0,
      checkpointAt: null,
      value: JSON.stringify({ name: title }),
    },
    composerData: { key: `composerData:${composerId}`, valueBase64: "e30=" },
    bubbles: Array.from({ length: bubbleCount }, (_unused, index) => ({
      key: `bubbleId:${composerId}:${index}`,
      valueBase64: "e30=",
    })),
    ...(payloadPaddingBytes === 0
      ? {}
      : { testPadding: "x".repeat(payloadPaddingBytes) }),
  });
  return {
    resourceId: `chat/${composerId}`,
    kind: "chat",
    content,
    semanticHash: sha256(content),
    metadata: {
      composerId,
      workspaceId: project,
      workspaceUri: `file:///C:/work/${project}`,
      lastUpdatedAt: 1_786_100_000_000 + bubbleCount,
      bubbleCount,
      title,
    },
  };
}

function choose(needle: string): (labels: string[]) => number | undefined {
  return (labels) => {
    const index = labels.findIndex((label) => label.includes(needle));
    if (index < 0) {
      throw new Error(`No QuickPick item matched ${needle}: ${labels.join(", ")}`);
    }
    return index;
  };
}

function requiredHash(value: string | null): string {
  if (value === null) {
    throw new Error("Expected publish to create an event.");
  }
  return value;
}
