import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ window: {}, extensions: { all: [] } }));

import { StateVscdbChatAdapter, portableChatCoreHash, type PortableChatSnapshotV2 } from "../src/chat/stateVscdb";
import { applyGlobalDatabaseChanges } from "../src/helper/database";
import { markAppliedProjections } from "../src/helper/main";
import type { HelperChange, HelperRequest } from "../src/helper/types";
import type { CursorPaths } from "../src/platform/paths";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import type { SyncRepository } from "../src/protocol/repository";

const roots: string[] = [];
const id = "45454545-4545-4545-8545-454545454545";
const resourceId = `chat/${id}`;
const maxBytes = 1024 * 1024;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("latest chat application and local recapture", () => {
  it.each(["a", "b"])("keeps inactive %s rows without republishing them or poisoning the next active continuation", async (device) => {
    const fixture = await createFixture();
    const staleId = sha256(`unavailable inactive ${device} graph`);
    const staleState = `~${Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(staleId, "hex")]).toString("base64")}`;
    const inactiveKey = `bubbleId:${id}:inactive-${device}`;
    const inactiveValue = JSON.stringify({ text: `inactive ${device} branch ${"🍎".repeat(20_000)}`, conversationState: staleState });
    const seed = new DatabaseSync(fixture.paths.globalDatabase);
    seed.prepare("INSERT INTO cursorDiskKV(key,value) VALUES (?,?)")
      .run(inactiveKey, device === "a" ? inactiveValue : Buffer.from(inactiveValue));
    seed.close();
    const snapshot = latestSnapshot();
    const content = canonicalBytes(snapshot);
    const change: HelperChange = {
      resourceId, kind: "chat", operation: "put", eventHash: "a".repeat(64), changeIndex: 0,
      semanticHash: sha256(content), metadata: {
        syncOrigin: "auto-merge", chatResolutionStrategy: "latest",
        chatResolutionCoreHash: portableChatCoreHash(snapshot),
        chatCoreHash: portableChatCoreHash(snapshot), chatSnapshotSchemaVersion: 2,
        agentKvBlobCount: 0, agentKvReferencedCount: 0, agentKvMissingCount: 0,
        bubbleCount: 1, lastUpdatedAt: 10,
      },
    };
    const result = await applyGlobalDatabaseChanges(fixture.request, [{ change, content }]);
    expect(result.applied).toEqual([resourceId]);
    const repository = { state: { projections: {}, pendingDatabaseChanges: [] } } as unknown as SyncRepository;
    markAppliedProjections(repository, [change], result.applied, new Set(result.retainedLocal),
      result.retainedLocalHashes, result.localChatCoreHashes);
    const adapter = new StateVscdbChatAdapter(fixture.paths, {
      offline: true, periodicDeepVerification: false, forceCoreVerificationResourceIds: [resourceId],
    });
    adapter.setMaxPayloadBytes(maxBytes);
    const unchanged = await adapter.scan(repository.state.projections);
    expect(unchanged.snapshots).toHaveLength(0);
    const mergedChange = { ...change, eventHash: "b".repeat(64),
      metadata: { ...change.metadata, chatResolutionStrategy: "merged" } };
    const merged = await applyGlobalDatabaseChanges(fixture.request, [{ change: mergedChange, content }]);
    markAppliedProjections(repository, [mergedChange], merged.applied, new Set(merged.retainedLocal),
      merged.retainedLocalHashes, merged.localChatCoreHashes);
    const afterMerge = new StateVscdbChatAdapter(fixture.paths, {
      offline: true, periodicDeepVerification: false, forceCoreVerificationResourceIds: [resourceId],
    });
    afterMerge.setMaxPayloadBytes(maxBytes);
    expect((await afterMerge.scan(repository.state.projections)).snapshots).toHaveLength(0);
    const edited = new DatabaseSync(fixture.paths.globalDatabase);
    const preserved = edited.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(inactiveKey)?.value;
    expect(typeof preserved === "string" ? preserved : Buffer.from(preserved as Uint8Array).toString("utf8")).toBe(inactiveValue);
    edited.prepare("UPDATE composerHeaders SET lastUpdatedAt=11 WHERE composerId=?").run(id);
    edited.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "active" }, { bubbleId: "next" }],
    }), `composerData:${id}`);
    edited.prepare("INSERT INTO cursorDiskKV(key,value) VALUES (?,?)")
      .run(`bubbleId:${id}:next`, JSON.stringify({ text: "real next user message" }));
    edited.close();
    const next = await adapter.scan(repository.state.projections);
    expect(next.snapshots).toHaveLength(1);
    const captured = JSON.parse(next.snapshots[0]!.content.toString("utf8")) as PortableChatSnapshotV2;
    expect(captured.schemaVersion).toBe(2);
    expect(captured.agentKv.missingIds).toEqual([]);
    expect(captured.agentKv.referencedIds).not.toContain(staleId);
    expect(captured.bubbles.some(row => row.key === inactiveKey)).toBe(true);
    expect(captured.bubbles.some(row => row.key === `bubbleId:${id}:next`)).toBe(true);
  });
});

function latestSnapshot(): PortableChatSnapshotV2 {
  const row = (key: string, value: unknown) => ({ key, valueType: "text" as const,
    valueBase64: Buffer.from(JSON.stringify(value)).toString("base64") });
  return {
    schemaVersion: 2, composerId: id,
    header: { composerId: id, workspaceId: null, createdAt: 1, lastUpdatedAt: 10,
      isArchived: 0, isSubagent: 0, recency: 0, checkpointAt: null, value: JSON.stringify({ name: "latest" }) },
    composerData: row(`composerData:${id}`, { fullConversationHeadersOnly: [{ bubbleId: "active" }] }),
    bubbles: [row(`bubbleId:${id}:active`, { text: "winning branch message" })],
    agentKv: { blobs: [], referencedIds: [], missingIds: [] },
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "chat-latest-apply-"));
  roots.push(root);
  const databasePath = join(root, "state.vscdb");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB);
    CREATE TABLE cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB);
    CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT);`);
  db.close();
  const paths: CursorPaths = {
    appRoot: root, userDataRoot: root, globalStorageRoot: root, globalDatabase: databasePath,
    workspaceStorageRoot: join(root, "workspaceStorage"), profilesRoot: join(root, "profiles"),
    snippetsRoot: join(root, "snippets"), promptsRoot: join(root, "prompts"), userTasks: join(root, "tasks.json"),
    userMcp: join(root, "mcp.json"), cursorHome: root, cursorMcp: join(root, "cursor-mcp.json"),
    cursorCliConfig: join(root, "cli-config.json"), cursorCommands: join(root, "commands"),
    cursorSkills: join(root, "skills"), cursorRules: join(root, "rules"), cursorProjects: join(root, "projects"),
    cursorChats: join(root, "chats"), cursorAcpSessions: join(root, "acp"),
    cursorExtensionsManifest: join(root, "extensions.json"), extensionStorage: join(root, "storage"),
    helperScript: join(root, "helper.js"),
  };
  await mkdir(paths.extensionStorage);
  const request: HelperRequest = {
    version: 1, requestId: "45454545-4545-4545-8545-454545454546", mode: "apply-and-restart",
    createdAt: new Date().toISOString(), repositoryRoot: join(root, "repo"), storageRoot: paths.extensionStorage,
    cursorExecutable: process.execPath, extensionHostPid: 0, restart: false,
    expectedCursorVersion: "3.11.19", expectedVscodeVersion: "1.125.0", extensionVersion: "1.0.6",
    paths, changes: [], workspaceMappings: {}, syncOptions: {
      ignoredSettings: [], ignoredExtensions: [], machineScopedSettings: [], syncChat: true,
      syncWorkspaceStorage: false, maxPayloadBytes: maxBytes,
    },
  };
  return { paths, request };
}
