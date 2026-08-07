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
  warningChoice: undefined as string | undefined,
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
    ) => task({ report: () => undefined }),
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
    showInformationMessage: async (message: string) => {
      ui.information.push(message);
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
import type {
  CompatibilityReport,
  ResourceSnapshot,
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
  ui.warningChoice = undefined;
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
      ) as { header?: { value?: string }; bubbles?: Array<{ key?: string }> };
      expect(payload.header?.value).toBe(JSON.stringify({ name: "Broken chat" }));
      expect(payload.bubbles?.map((bubble) => bubble.key)).toEqual([
        `bubbleId:${fixture.composerId}:a`,
        `bubbleId:${fixture.composerId}:b`,
        `bubbleId:${fixture.composerId}:c`,
      ]);
      expect(
        ui.information.some((message) => message.includes("1 chat repair is queued")),
      ).toBe(true);
    } finally {
      fixture.manager.dispose();
    }
  });
});

async function createRepairFixture(): Promise<{
  manager: SyncManager;
  repository: SyncRepository;
  composerId: string;
  olderVersionId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-repair-command-"));
  temporaryRoots.push(root);
  const repository = await SyncRepository.create(
    join(root, "repository"),
    join(root, "storage"),
    "a sufficiently long test passphrase",
    4 * 1024 * 1024,
    producer,
  );
  const composerId = "55555555-5555-4555-8555-555555555555";
  const older = await repository.publish(
    [repairChatSnapshot(composerId, ["a"])],
    [],
  );
  const olderVersionId = `${requiredHash(older.eventHash)}#0`;
  const complete = await repository.publish(
    [
      {
        ...repairChatSnapshot(composerId),
        parents: [olderVersionId],
      },
    ],
    [],
  );
  await repository.publish(
    [
      {
        // The newest partial version has an unreferenced row that must remain
        // in the synthesized child even though the older complete source is
        // the version that supplies missing referenced bubble b.
        ...repairChatSnapshot(composerId, ["a", "c"]),
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
  return { manager, repository, composerId, olderVersionId };
}

function repairChatSnapshot(
  composerId: string,
  bubbleIds: string[] = ["a", "b"],
): ResourceSnapshot {
  const content = canonicalBytes({
    schemaVersion: 1,
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
    bubbles: bubbleIds.map((id) => ({
      key: `bubbleId:${composerId}:${id}`,
      valueBase64: Buffer.from(JSON.stringify({ text: id }), "utf8").toString(
        "base64",
      ),
      valueType: "text",
    })),
  });
  return {
    resourceId: `chat/${composerId}`,
    kind: "chat",
    content,
    semanticHash: sha256(content),
    metadata: {
      composerId,
      workspaceId: "project-a",
      workspaceUri: "file:///C:/work/project-a",
      bubbleCount: bubbleIds.length,
      title: "Broken chat",
    },
  };
}

async function createFixture(): Promise<{
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
    4 * 1024 * 1024,
    producer,
  );
  const chatA = "00000000-0000-4000-8000-00000000000a";
  const chatB = "00000000-0000-4000-8000-00000000000b";
  const oldA = chatSnapshot(chatA, "Earlier conversation A", "project-a", 1);
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
