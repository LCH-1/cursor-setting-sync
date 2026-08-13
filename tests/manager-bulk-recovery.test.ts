import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ui = vi.hoisted(() => ({
  answers: [] as Array<((labels: string[]) => number | undefined) | undefined>,
  commands: [] as Array<{ command: string; args: unknown[] }>,
  confirmations: [] as string[],
  information: [] as string[],
  offered: [] as Array<{ title: string; labels: string[] }>,
  progressReports: [] as string[],
  preservingReports: 0,
  cancelAfterPreservingReports: null as number | null,
  onProgress: undefined as ((message: string) => void) | undefined,
  warningChoice: undefined as string | undefined,
  workspaceUris: [] as string[],
}));

vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  extensions: { all: [] },
  workspace: {
    get workspaceFolders() {
      return ui.workspaceUris.map((uri) => ({
        uri: { toString: () => uri },
      }));
    },
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  },
  window: {
    withProgress: async (
      _options: unknown,
      task: (
        progress: { report: (value: unknown) => void },
        token: { readonly isCancellationRequested: boolean },
      ) => Promise<unknown>,
    ) =>
      task(
        {
          report: (value: unknown) => {
            if (
              value === null ||
              typeof value !== "object" ||
              typeof (value as { message?: unknown }).message !== "string"
            ) {
              return;
            }
            const message = (value as { message: string }).message;
            ui.progressReports.push(message);
            if (message.startsWith("Preserving ")) {
              ui.preservingReports += 1;
            }
            ui.onProgress?.(message);
          },
        },
        {
          get isCancellationRequested() {
            return (
              ui.cancelAfterPreservingReports !== null &&
              ui.preservingReports >= ui.cancelAfterPreservingReports
            );
          },
        },
      ),
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
      return ui.warningChoice !== undefined && args.includes(ui.warningChoice)
        ? ui.warningChoice
        : undefined;
    },
    showInformationMessage: async (message: string) => {
      ui.information.push(message);
      return undefined;
    },
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      ui.commands.push({ command, args });
      return undefined;
    },
  },
  Uri: {
    parse: (value: string) => ({ toString: () => value }),
    file: (value: string) => ({
      fsPath: value,
      toString: () => `file://${value}`,
    }),
  },
}));

import { SyncManager } from "../src/sync/manager";
import { sha256 } from "../src/protocol/canonical";
import {
  RECOVERY_CATALOG_LIMITS,
  RecoveryCatalogLimitError,
} from "../src/chat/recoveryCatalog";
import type { ExtensionConfiguration } from "../src/config";
import type { CursorPaths } from "../src/platform/paths";
import type { CompatibilityReport } from "../src/types";
import type { ConflictController } from "../src/ui/conflicts";
import type { StatusController } from "../src/ui/status";

const roots: string[] = [];
const producer = {
  extensionVersion: "0.0.65",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

beforeEach(() => {
  resetUi();
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bulk unavailable-chat recovery manager", () => {
  it("paginates past four damaged chats and catalogs all nine exactly once", async () => {
    const fixture = await createBulkFixture(9);
    try {
      await preserveAll(fixture.manager);

      const manifest = await readManifest(fixture.extensionStorage);
      expect(manifest.entries).toHaveLength(9);
      expect(
        manifest.entries.map((entry) => entry.composerId).sort(),
      ).toEqual(
        Array.from({ length: 9 }, (_unused, index) => composerId(index)),
      );
      expect(new Set(manifest.entries.map(entryIdentity))).toHaveLength(9);
      expect(
        new Set(
          manifest.entries.map(
            (entry) => requiredReadyArtifact(entry).transcript.relativePath,
          ),
        ),
      ).toHaveLength(9);
      expect(ui.preservingReports).toBe(9);
      expect(
        ui.progressReports.filter((message) =>
          message.startsWith("Auditing chats ("),
        ),
      ).toHaveLength(3);
      expect(ui.information.at(-1)).toContain("9 ready");
    } finally {
      fixture.manager.dispose();
    }
  });

  it("keeps the first four checkpoints on cancellation, then resumes without gaps or rewrites", async () => {
    const fixture = await createBulkFixture(9);
    try {
      ui.cancelAfterPreservingReports = 4;
      await preserveAll(fixture.manager);

      const cancelled = await readManifest(fixture.extensionStorage);
      expect(
        cancelled.entries.map((entry) => entry.composerId).sort(),
      ).toEqual(
        Array.from({ length: 4 }, (_unused, index) => composerId(index)),
      );
      expect(ui.confirmations.at(-1)).toContain(
        "Cancelled at an item boundary after cataloguing 4 conversations",
      );

      resetUi();
      await preserveAll(fixture.manager);
      const completedText = await readManifestText(fixture.extensionStorage);
      const completed = parseManifest(completedText);
      expect(
        completed.entries.map((entry) => entry.composerId).sort(),
      ).toEqual(
        Array.from({ length: 9 }, (_unused, index) => composerId(index)),
      );
      expect(new Set(completed.entries.map(entryIdentity))).toHaveLength(9);

      resetUi();
      await preserveAll(fixture.manager);
      expect(await readManifestText(fixture.extensionStorage)).toBe(
        completedText,
      );
      expect(ui.preservingReports).toBe(0);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("marks an externally changed database pass incomplete without downgrading a prior ready entry", async () => {
    const fixture = await createBulkFixture(1);
    try {
      await preserveAll(fixture.manager);
      const before = (await readManifest(fixture.extensionStorage)).entries[0];
      expect(before?.status).toBe("ready");
      fixture.addBrokenChat(1);

      resetUi();
      let committed = false;
      ui.onProgress = (message) => {
        if (committed || !message.startsWith("Preserving ")) {
          return;
        }
        committed = true;
        const database = new DatabaseSync(fixture.globalDatabase);
        try {
          database
            .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
            .run("bulk-recovery:generation-marker", "changed externally");
        } finally {
          database.close();
        }
      };

      await preserveAll(fixture.manager);

      expect(committed).toBe(true);
      expect(ui.confirmations.at(-1)).toContain(
        "live chat database changed during the multi-page audit",
      );
      expect(ui.confirmations.at(-1)).toContain(
        "result is intentionally incomplete",
      );
      const after = await readManifest(fixture.extensionStorage);
      expect(after.entries).toHaveLength(2);
      expect(after.entries.find((entry) => entry.composerId === composerId(0)))
        .toEqual(before);
      expect(after.entries.every((entry) => entry.status === "ready")).toBe(
        true,
      );
    } finally {
      fixture.manager.dispose();
    }
  });

  it.each([
    ["a different workspace", "file:///C:/work/original", ["file:///C:/work/other"]],
    ["no stored workspace URI", null, ["file:///C:/work/original"]],
  ] as const)("blocks Open for %s", async (_label, storedUri, openUris) => {
    const fixture = await createBulkFixture(1, storedUri);
    try {
      await preserveAll(fixture.manager);

      resetUi();
      ui.workspaceUris.push(...openUris);
      ui.answers.push(() => 0);
      await fixture.manager.openRecoveredChatSafely();

      expect(ui.offered.at(-1)?.title).toBe("Open Recovered Chat Safely");
      expect(ui.confirmations.at(-1)).toContain(
        "Open the recovered conversation's original workspace",
      );
      expect(ui.confirmations.at(-1)).toContain("No Agent was created");
      expect(ui.commands).toEqual([]);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("replaces a corrupt ready entry with non-ready state when rebuilding its visible body fails", async () => {
    const fixture = await createBulkFixture(1);
    try {
      await preserveAll(fixture.manager);
      const ready = (await readManifest(fixture.extensionStorage)).entries[0];
      const artifact = requiredReadyArtifact(ready);
      await writeFile(
        join(fixture.extensionStorage, artifact.transcript.relativePath),
        "corrupt catalog transcript",
      );
      const database = new DatabaseSync(fixture.globalDatabase);
      try {
        database
          .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
          .run(
            JSON.stringify({ type: 1, text: "" }),
            `bubbleId:${composerId(0)}:message`,
          );
      } finally {
        database.close();
      }

      resetUi();
      await preserveAll(fixture.manager);

      const rebuilt = (await readManifest(fixture.extensionStorage)).entries[0];
      expect(rebuilt).toMatchObject({
        composerId: composerId(0),
        composerStorageClass: "text",
        status: "skipped-body",
      });
      expect(rebuilt).not.toHaveProperty("artifact");

      resetUi();
      await fixture.manager.openRecoveredChatSafely();
      expect(ui.information.at(-1)).toContain(
        "no verified chat artifact ready to open",
      );
      expect(ui.offered).toEqual([]);
      expect(ui.commands).toEqual([]);
    } finally {
      fixture.manager.dispose();
    }
  });

  it("downgrades a corrupt ready entry when its rebuild hits the physical quota", async () => {
    const fixture = await createBulkFixture(1);
    try {
      await preserveAll(fixture.manager);
      const ready = (await readManifest(fixture.extensionStorage)).entries[0];
      const artifact = requiredReadyArtifact(ready);
      await writeFile(
        join(fixture.extensionStorage, artifact.transcript.relativePath),
        "corrupt catalog transcript",
      );
      const internals = fixture.manager as unknown as {
        preserveRecoveryCatalogObservation: (
          ...args: unknown[]
        ) => Promise<unknown>;
      };
      vi.spyOn(
        internals,
        "preserveRecoveryCatalogObservation",
      ).mockRejectedValueOnce(
        new RecoveryCatalogLimitError(
          "physical-artifact-bytes",
          RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes,
          RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes + 1,
        ),
      );

      resetUi();
      await preserveAll(fixture.manager);

      const downgraded = (await readManifest(fixture.extensionStorage)).entries[0];
      expect(downgraded).toMatchObject({
        composerId: composerId(0),
        composerStorageClass: "text",
        status: "skipped-limit",
      });
      expect(downgraded).not.toHaveProperty("artifact");
      expect(ui.confirmations.at(-1)).toContain("physical-artifact");

      resetUi();
      await fixture.manager.openRecoveredChatSafely();
      expect(ui.information.at(-1)).toContain(
        "no verified chat artifact ready to open",
      );
      expect(ui.offered).toEqual([]);
      expect(ui.commands).toEqual([]);
    } finally {
      fixture.manager.dispose();
    }
  });
});

interface StoredArtifact {
  transcript: { relativePath: string; sha256: string; byteLength: number };
  images: Array<{
    relativePath: string;
    sha256: string;
    byteLength: number;
    mimeType: "image/png";
  }>;
}

interface StoredEntry {
  composerId: string;
  composerStorageClass: "text" | "blob";
  chatCoreHash: string;
  damageFingerprint: string;
  title: string | null;
  lastUpdatedAt: number | null;
  status: "ready" | "skipped-limit" | "skipped-body" | "changed" | "unknown";
  artifact?: StoredArtifact;
}

interface StoredManifest {
  schemaVersion: 1;
  entries: StoredEntry[];
}

interface BulkFixture {
  manager: SyncManager;
  globalDatabase: string;
  extensionStorage: string;
  addBrokenChat(index: number): void;
}

async function createBulkFixture(
  count: number,
  workspaceUri: string | null = "file:///C:/work/original",
): Promise<BulkFixture> {
  const root = await mkdtemp(join(tmpdir(), "cursor-bulk-recovery-manager-"));
  roots.push(root);
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
  for (let index = 0; index < count; index += 1) {
    insertBrokenChat(database, index, workspaceUri);
  }
  database.close();

  const extensionStorage = join(root, "extension-storage");
  const paths = {
    globalDatabase,
    extensionStorage,
    helperScript: join(root, "helper.js"),
    workspaceStorageRoot: join(root, "workspaceStorage"),
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
  return {
    manager,
    globalDatabase,
    extensionStorage,
    addBrokenChat(index: number): void {
      const live = new DatabaseSync(globalDatabase);
      try {
        insertBrokenChat(live, index, workspaceUri);
      } finally {
        live.close();
      }
    },
  };
}

function insertBrokenChat(
  database: DatabaseSync,
  index: number,
  workspaceUri: string | null,
): void {
  const id = composerId(index);
  const missingRoot = sha256(
    Buffer.from(`missing continuation root ${index}`, "utf8"),
  );
  const header = {
    name: `Damaged chat ${index}`,
    ...(workspaceUri === null
      ? {}
      : { workspaceIdentifier: { uri: { external: workspaceUri } } }),
  };
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, 'project-a', 1, ?, 0, 0, 0, NULL, ?)`,
    )
    .run(id, 100 + index, JSON.stringify(header));
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(
      `composerData:${id}`,
      JSON.stringify({
        fullConversationHeadersOnly: [{ bubbleId: "message" }],
        conversationState: serializedRootState(missingRoot),
      }),
    );
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(
      `bubbleId:${id}:message`,
      JSON.stringify({ type: 1, text: `Recoverable request ${index}` }),
    );
}

function composerId(index: number): string {
  return `80000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function serializedRootState(rootId: string): string {
  return `~${Buffer.concat([
    Buffer.from([0x0a, 0x20]),
    Buffer.from(rootId, "hex"),
  ]).toString("base64")}`;
}

async function preserveAll(manager: SyncManager): Promise<void> {
  ui.warningChoice = "Preserve All Safely";
  await manager.preserveAllUnavailableChatsSafely();
}

function resetUi(): void {
  ui.answers.length = 0;
  ui.commands.length = 0;
  ui.confirmations.length = 0;
  ui.information.length = 0;
  ui.offered.length = 0;
  ui.progressReports.length = 0;
  ui.preservingReports = 0;
  ui.cancelAfterPreservingReports = null;
  ui.onProgress = undefined;
  ui.warningChoice = undefined;
  ui.workspaceUris.length = 0;
}

async function readManifest(extensionStorage: string): Promise<StoredManifest> {
  return parseManifest(await readManifestText(extensionStorage));
}

async function readManifestText(extensionStorage: string): Promise<string> {
  return readFile(
    join(extensionStorage, "recovery-transcripts", "catalog-v1.json"),
    "utf8",
  );
}

function parseManifest(value: string): StoredManifest {
  return JSON.parse(value) as StoredManifest;
}

function entryIdentity(entry: StoredEntry): string {
  return `${entry.composerStorageClass}\0${entry.composerId}`;
}

function requiredReadyArtifact(entry: StoredEntry | undefined): StoredArtifact {
  if (entry?.status !== "ready" || entry.artifact === undefined) {
    throw new Error("Expected a ready recovery catalog entry.");
  }
  return entry.artifact;
}
