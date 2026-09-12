import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqlite from "node:sqlite";

import { MAX_EVENT_CHANGES } from "../src/constants";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { parsePortableChatSnapshot, portableChatCoreHash } from "../src/chat/stateVscdb";
import { SyncRepository } from "../src/protocol/repository";
import { EventReconciler } from "../src/protocol/reconciler";
import { WorkspaceStorageAdapter } from "../src/resources/workspaceStorage";
import {
  filterPublishableChanges,
  acknowledgeObservedLocalChats,
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
  vi.restoreAllMocks();
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
  it.each(["exact", "enriched-source"])("acknowledges authenticated %s bytes without marking an unobserved enrichment applied", async (kind) => {
    await withRepository(4096, async repository => {
      const observed = localChat(8);
      const published = await repository.publish([observed], []);
      const sourceVersionId = `${published.eventHash}#0`;
      if (kind === "enriched-source") {
        const source = parsePortableChatSnapshot(observed.content);
        const rich = canonicalBytes({ ...source, schemaVersion: 2,
          agentKv: { blobs: [], referencedIds: [], missingIds: [] } });
        await repository.publish([{ ...observed, content: rich, semanticHash: sha256(rich),
          parents: [sourceVersionId], metadata: { syncOrigin: "agent-kv-enrichment", enrichedFromVersionId: sourceVersionId } }], []);
      }
      new EventReconciler().reconcile(await repository.listEvents(), repository.state, null);
      const tipVersionId = repository.state.tips[observed.resourceId]![0]!.versionId;
      repository.state.pendingDatabaseChanges = [{ resourceId: observed.resourceId, kind: "chat",
        eventHash: tipVersionId.split("#")[0]!, changeIndex: 0 }];
      observed.metadata = { chatCoreHash: "f".repeat(64), bubbleCount: 999, lastUpdatedAt: 999 };
      expect(await acknowledgeObservedLocalChats(repository, [observed])).toEqual(new Set());
      const durable = await repository.stateStore.loadOrCreate(repository.repository.repositoryId);
      expect(durable.projections[observed.resourceId]).toMatchObject({ versionId: sourceVersionId,
        semanticHash: observed.semanticHash, sourceBubbleCount: 0, sourceTimestamp: 2,
        sourceChatCoreHash: portableChatCoreHash(parsePortableChatSnapshot(observed.content)) });
      expect(durable.pendingDatabaseChanges).toHaveLength(1);
      expect(`${durable.pendingDatabaseChanges[0]!.eventHash}#0`).toBe(tipVersionId);
    });
  });

  it.each(["unreadable", "forged-tip-hash", "false-local-hash", "synthetic-input", "repair-recapture"])("preserves the local projection when an observed ACK has %s", async (failure) => {
    await withRepository(4096, async repository => {
      const observed = localChat(9);
      await publishInBatches(repository, [observed], [], { acknowledgeLocalChats: true });
      new EventReconciler().reconcile(await repository.listEvents(), repository.state, null);
      repository.state.projections[observed.resourceId]!.requiresAgentKvRecapture = true;
      const before = structuredClone(repository.state.projections[observed.resourceId]);
      if (failure === "unreadable") {
        vi.spyOn(repository, "readVersionMetadata").mockRejectedValue(new Error("unavailable authenticated source"));
      } else if (failure === "forged-tip-hash") {
        const changed = localChat(9, "not committed");
        observed.content = changed.content;
        observed.semanticHash = changed.semanticHash;
        repository.state.tips[observed.resourceId]![0]!.semanticHash = changed.semanticHash;
      } else if (failure === "false-local-hash") {
        observed.content = localChat(9, "not committed").content;
      } else if (failure === "synthetic-input") {
        observed.metadata = { syncOrigin: "agent-kv-enrichment" };
      } else {
        observed.metadata = { syncOrigin: "agent-kv-recapture" };
      }
      const failed = await acknowledgeObservedLocalChats(repository, [observed]);
      expect(failed).toEqual(["synthetic-input", "repair-recapture"].includes(failure) ? new Set() : new Set([observed.resourceId]));
      expect(repository.state.projections[observed.resourceId]).toEqual(before);
    });
  });

  it.each(["missing-source", "new-local-edit"])("keeps enrichment pending and its original projection on %s", async (failure) => {
    await withRepository(4096, async repository => {
      const observed = localChat(10);
      await publishInBatches(repository, [observed], [], { acknowledgeLocalChats: true });
      const before = structuredClone(repository.state.projections[observed.resourceId]);
      const sourceVersionId = before!.versionId!;
      const core = parsePortableChatSnapshot(observed.content);
      const rich = canonicalBytes({ ...core, schemaVersion: 2,
        agentKv: { blobs: [], referencedIds: [], missingIds: [] } });
      await repository.publish([{ ...observed, content: rich, semanticHash: sha256(rich), parents: [sourceVersionId],
        metadata: { syncOrigin: "agent-kv-enrichment", enrichedFromVersionId: sourceVersionId } }], []);
      new EventReconciler().reconcile(await repository.listEvents(), repository.state, null);
      if (failure === "missing-source") {
        const read = repository.readVersionMetadata.bind(repository);
        vi.spyOn(repository, "readVersionMetadata").mockImplementation(version =>
          version === sourceVersionId ? Promise.reject(new Error("Resource version is unavailable")) : read(version));
      }
      const failed = await acknowledgeObservedLocalChats(repository,
        [failure === "new-local-edit" ? localChat(10, "a real new local edit") : observed]);
      expect(failed).toEqual(failure === "missing-source" ? new Set([observed.resourceId]) : new Set());
      expect(repository.state.projections[observed.resourceId]).toEqual(before);
      expect(repository.state.tips[observed.resourceId]![0]!.versionId).not.toBe(sourceVersionId);
    });
  });

  it("acknowledges the authenticated sorted change index and derives chat source hints from actual bytes", async () => {
    await withRepository(4096, async repository => {
      const earlier = localChat(1);
      const later = localChat(2);
      later.metadata = { chatCoreHash: "f".repeat(64), bubbleCount: 999, lastUpdatedAt: 999 };
      const published = await publishInBatches(repository,
        [later, snapshot("chat-store/session", "chat-store", "{}"), earlier], [deletion("ui-state/deleted")],
        { acknowledgeLocalChats: true });
      expect(published.size).toBe(1);
      const event = (await repository.listEvents())[0]!;
      const durable = await repository.stateStore.loadOrCreate(repository.repository.repositoryId);
      for (const source of [earlier, later]) {
        const projection = durable.projections[source.resourceId]!;
        const index = event.manifest.changes.findIndex(change => change.resourceId === source.resourceId);
        expect(projection.versionId).toBe(`${event.eventHash}#${index}`);
        expect(projection.payloadObjectId).toBe(event.manifest.changes[index]!.payload!.objectId);
        expect(projection.semanticHash).toBe(source.semanticHash);
        expect(projection.sourceChatCoreHash).toBe(portableChatCoreHash(parsePortableChatSnapshot(source.content)));
        expect(projection.sourceTimestamp).toBe(2);
        expect(projection.sourceBubbleCount).toBe(0);
      }
      expect(durable.projections[earlier.resourceId]!.versionId).toContain("#1");
      expect(durable.projections[later.resourceId]!.versionId).toContain("#2");
    });
  });

  it("persists a successful local-chat batch even when the following batch fails", async () => {
    await withRepository(8 * 1024 * 1024, async repository => {
      const first = localChat(3);
      const second = localChat(4);
      const padding = "m".repeat(2 * 1024 * 1024 + 512);
      first.metadata = { padding };
      second.metadata = { padding };
      const publish = repository.publish.bind(repository);
      vi.spyOn(repository, "publish").mockImplementationOnce(publish)
        .mockRejectedValueOnce(new Error("later batch failed"));
      await expect(publishInBatches(repository, [first, second], [], { acknowledgeLocalChats: true }))
        .rejects.toThrow("later batch failed");
      const durable = await repository.stateStore.loadOrCreate(repository.repository.repositoryId);
      const firstEvent = (await repository.listEvents())[0]!;
      expect(durable.projections[first.resourceId]?.versionId).toBe(`${firstEvent.eventHash}#0`);
      expect(durable.projections[first.resourceId]?.semanticHash).toBe(first.semanticHash);
      expect(durable.projections[second.resourceId]).toBeUndefined();
    });
  });

  it("does not acknowledge a synthetic repository payload as locally applied", async () => {
    await withRepository(4096, async repository => {
      const source = localChat(5);
      await publishInBatches(repository, [source], [], { acknowledgeLocalChats: true });
      const before = structuredClone(repository.state.projections[source.resourceId]);
      const synthetic = localChat(5, "repository-only title");
      synthetic.metadata = { syncOrigin: "agent-kv-enrichment", agentKvEnrichmentAppliesCore: true };
      await publishInBatches(repository, [synthetic], [], { acknowledgeLocalChats: true });
      expect(repository.state.projections[source.resourceId]).toEqual(before);
    });
  });

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

function localChat(index: number, title = "local title"): ResourceSnapshot {
  const composerId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const content = canonicalBytes({ schemaVersion: 1, composerId,
    header: { composerId, workspaceId: null, createdAt: 1, lastUpdatedAt: 2,
      isArchived: 0, isSubagent: 0, recency: 2, checkpointAt: null, value: JSON.stringify({ name: title }) },
    composerData: { key: `composerData:${composerId}`, valueBase64: Buffer.from('{"fullConversationHeadersOnly":[]}').toString("base64"), valueType: "text" },
    bubbles: [] });
  return { resourceId: `chat/${composerId}`, kind: "chat", content, semanticHash: sha256(content) };
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
