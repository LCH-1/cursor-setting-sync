import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as sqlite from "node:sqlite";

import { MAX_EVENT_CHANGES } from "../src/constants";
import { sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import { WorkspaceStorageAdapter } from "../src/resources/workspaceStorage";
import {
  filterPublishableChanges,
  publishInBatches,
} from "../src/sync/versionPolicy";
import type { CursorPaths } from "../src/platform/paths";
import type {
  EventProducer,
  ResourceDeletion,
  ResourceSnapshot,
} from "../src/types";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

const temporaryRoots: string[] = [];
const describeWithSqlite =
  typeof sqlite.DatabaseSync === "function" ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

/**
 * The shutdown export is the ONLY path that backs up workspaceStorage, because
 * the adapter never scans while Cursor runs. Publishing it raw meant one
 * oversized or over-long batch destroyed the whole backup for that session.
 */
describe("shutdown export publish guards", () => {
  it("drops an oversized resource with a warning and publishes everything else", async () => {
    await withRepository(4096, async (repository) => {
      const snapshots = [
        snapshot("settings/default/editor.fontSize", "settings", "14"),
        snapshot(
          "workspace-storage/workspace-a%2Fstate.vscdb",
          "workspace-storage",
          "x".repeat(8192),
        ),
        snapshot(
          "workspace-storage/workspace-a%2Fnotepads.json",
          "workspace-storage",
          "notepads",
        ),
      ];

      await expect(repository.publish([...snapshots], [])).rejects.toThrow(
        "Payload exceeds configured limit",
      );

      const publishable = filterPublishableChanges(
        snapshots,
        [],
        repository.maxPayloadBytes,
      );
      expect(publishable.warnings).toHaveLength(1);
      expect(publishable.warnings[0]).toContain(
        "workspace-storage/workspace-a%2Fstate.vscdb",
      );
      expect(publishable.warnings[0]).toContain("was not published");

      const published = await publishInBatches(
        repository,
        publishable.snapshots,
        publishable.deletions,
      );

      expect(published.size).toBe(1);
      expect(publishedResourceIds(await repository.listEvents())).toEqual([
        "settings/default/editor.fontSize",
        "workspace-storage/workspace-a%2Fnotepads.json",
      ]);
    });
  });

  it("splits by estimated manifest bytes long before the count cap", async () => {
    // publish hard-fails past MAX_EVENT_FILE_BYTES, and far fewer than ten
    // thousand changes reach it when each record carries fat metadata - a
    // batch split only by count aborted the whole cycle exactly there.
    await withRepository(16 * 1024 * 1024, async (repository) => {
      const wide = "m".repeat(1024 * 1024);
      const snapshots = Array.from({ length: 6 }, (_unused, index) => ({
        ...snapshot(`workspace-storage/wide-${index}`, "workspace-storage", "x"),
        metadata: { relativePath: `wide-${index}/state.vscdb`, padding: wide },
      }));

      await expect(repository.publish([...snapshots], [])).rejects.toThrow(
        /exceeds/i,
      );

      const published = await publishInBatches(repository, snapshots, []);

      expect(published.size).toBeGreaterThan(1);
      expect(publishedResourceIds(await repository.listEvents())).toHaveLength(
        snapshots.length,
      );
    });
  });

  it("splits an export larger than MAX_EVENT_CHANGES across events", async () => {
    await withRepository(1024 * 1024, async (repository) => {
      const snapshots = [
        snapshot("settings/default/editor.fontSize", "settings", "14"),
        snapshot("settings/default/editor.tabSize", "settings", "2"),
        snapshot("settings/default/editor.wordWrap", "settings", '"on"'),
      ];
      const deletions: ResourceDeletion[] = Array.from(
        { length: MAX_EVENT_CHANGES - 1 },
        (_unused, index) => deletion(`ui-state/stale-${index}`),
      );
      expect(snapshots.length + deletions.length).toBeGreaterThan(
        MAX_EVENT_CHANGES,
      );

      await expect(repository.publish([...snapshots], [...deletions])).rejects.toThrow(
        "Too many changes for one event",
      );

      const published = await publishInBatches(repository, snapshots, deletions);

      expect(published.size).toBe(2);
      const events = await repository.listEvents();
      expect(events).toHaveLength(2);
      expect(
        events.map((event) => event.manifest.changes.length).sort(
          (left, right) => left - right,
        ),
      ).toEqual([2, MAX_EVENT_CHANGES]);
      expect(publishedResourceIds(events)).toContain(
        "settings/default/editor.wordWrap",
      );
      expect(publishedResourceIds(events)).toHaveLength(
        snapshots.length + deletions.length,
      );
    });
  }, 60_000);
});

describeWithSqlite("workspaceStorage capture-side payload cap", () => {
  it("refuses a database whose SERIALIZED size exceeds the payload limit", async () => {
    const paths = await createPaths();
    const workspaceRoot = join(paths.workspaceStorageRoot, "workspace-a");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "notepads.json"), "notepads", "utf8");
    const databasePath = join(workspaceRoot, "state.vscdb");
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    database.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
    // 60 KiB of blob decodes to 60 KiB but serializes to ~80 KiB of base64
    // inside JSON, so it passes a 64 KiB decoded-bytes cap and fails the real
    // one. That gap is exactly what used to reach `publish` and throw. It
    // lives in cursorDiskKV because ItemTable rows outside the portable
    // allowlist no longer reach the serialized snapshot at all.
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run("blob", Buffer.alloc(60 * 1024, 7));
    database.close();

    const adapter = new WorkspaceStorageAdapter(paths, {}, 64 * 1024);
    const result = await adapter.scan({});

    expect(
      result.snapshots.map((item) => item.metadata?.relativePath),
    ).toEqual(["workspace-a/notepads.json"]);
    // Configured-policy oversize is represented as a lightweight settlement;
    // the manager/helper turns that into the single shared payload warning.
    // The adapter itself only emits a second warning for its stricter fixed
    // automatic-work ceiling, avoiding duplicate user messages here.
    expect(adapter.oversizedSnapshotSettlements(64 * 1024)).toEqual([
      expect.objectContaining({
        resourceId: "workspace-storage/workspace-a%2Fstate.vscdb",
        maxPayloadBytes: 64 * 1024,
      }),
    ]);
  });
});

function snapshot(
  resourceId: string,
  kind: ResourceSnapshot["kind"],
  content: string,
): ResourceSnapshot {
  const buffer = Buffer.from(content, "utf8");
  return {
    resourceId,
    kind,
    content: buffer,
    semanticHash: sha256(buffer),
  };
}

function deletion(resourceId: string): ResourceDeletion {
  return {
    resourceId,
    kind: "ui-state",
    semanticHash: sha256(`deleted:${resourceId}`),
  };
}

function publishedResourceIds(
  events: Awaited<ReturnType<SyncRepository["listEvents"]>>,
): string[] {
  return events
    .flatMap((event) => event.manifest.changes.map((change) => change.resourceId))
    .sort((left, right) => left.localeCompare(right));
}

async function withRepository(
  maxPayloadBytes: number,
  run: (repository: SyncRepository) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cursor-export-guards-"));
  temporaryRoots.push(root);
  const repository = await SyncRepository.create(
    join(root, "repository"),
    join(root, "storage"),
    PASSPHRASE,
    maxPayloadBytes,
    PRODUCER,
  );
  await run(repository);
}

async function createPaths(): Promise<CursorPaths> {
  const root = await mkdtemp(join(tmpdir(), "cursor-export-guards-paths-"));
  temporaryRoots.push(root);
  const userDataRoot = join(root, "User");
  const cursorHome = join(root, ".cursor");
  const extensionStorage = join(root, "extension-storage");
  return {
    appRoot: root,
    userDataRoot,
    globalStorageRoot: join(userDataRoot, "globalStorage"),
    globalDatabase: join(userDataRoot, "globalStorage", "state.vscdb"),
    workspaceStorageRoot: join(userDataRoot, "workspaceStorage"),
    profilesRoot: join(userDataRoot, "profiles"),
    snippetsRoot: join(userDataRoot, "snippets"),
    promptsRoot: join(userDataRoot, "prompts"),
    userTasks: join(userDataRoot, "tasks.json"),
    userMcp: join(userDataRoot, "mcp.json"),
    cursorHome,
    cursorMcp: join(cursorHome, "mcp.json"),
    cursorCliConfig: join(cursorHome, "cli-config.json"),
    cursorCommands: join(cursorHome, "commands"),
    cursorSkills: join(cursorHome, "skills"),
    cursorRules: join(cursorHome, "rules"),
    cursorProjects: join(cursorHome, "projects"),
    cursorChats: join(cursorHome, "chats"),
    cursorAcpSessions: join(cursorHome, "acp-sessions"),
    cursorExtensionsManifest: join(cursorHome, "extensions", "extensions.json"),
    extensionStorage,
    helperScript: join(root, "helper.js"),
  };
}
