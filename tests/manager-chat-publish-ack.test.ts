import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ extensions: { all: [] }, workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }) }, window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined } }));

import { portableChatCoreHash, type PortableChatSnapshotV1 } from "../src/chat/stateVscdb";
import { __testing as helperMainTesting } from "../src/helper/main";
import type { HelperRequest } from "../src/helper/types";
import type { ExtensionConfiguration } from "../src/config";
import type { CursorPaths } from "../src/platform/paths";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import type { ResourceAdapter } from "../src/resources/resource";
import { SyncManager } from "../src/sync/manager";
import type { CompatibilityReport, ResourceSnapshot, ResourceTip } from "../src/types";
import type { ConflictController } from "../src/ui/conflicts";
import type { StatusController } from "../src/ui/status";

const roots: string[] = [];
const producer = { extensionVersion: "1.0.8", cursorVersion: "3.20.10", vscodeVersion: "1.125.0" };
const passphrase = "a sufficiently long manager ACK passphrase";
const composerId = "00000000-0000-4000-8000-000000000401";
const resourceId = `chat/${composerId}`;
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("manager local chat publication acknowledgement", () => {
  it("retains the authenticated v1 publication through same-cycle enrichment and shutdown export", async () => {
    const f = await fixture();
    try {
      await f.sync();
      const tip = f.repository.state.tips[resourceId]![0]!;
      expect(tip.metadata?.syncOrigin).toBe("agent-kv-enrichment");
      const local = (await f.repository.listEvents()).flatMap(event => event.manifest.changes.map((change, index) => ({ event, change, index })))
        .find(item => item.change.semanticHash === f.snapshot.semanticHash)!;
      const localVersionId = `${local.event.eventHash}#${local.index}`;
      expect(f.repository.state.projections[resourceId]).toMatchObject({ semanticHash: f.snapshot.semanticHash, versionId: localVersionId, sourceChatCoreHash: portableChatCoreHash(f.chat) });
      expect(tip.parents).toContain(localVersionId);
      expect(f.repository.state.pendingDatabaseChanges).toContainEqual(expect.objectContaining({ resourceId, eventHash: tip.eventHash }));
      const before = await f.repository.countEvents();
      await helperMainTesting.exportFinalChanges(f.request, f.repository, () => {}, true);
      expect(await f.repository.countEvents()).toBe(before);
      expect(f.repository.state.conflicts.filter(conflict => conflict.resolvedAt === undefined)).toEqual([]);
      expect(f.repository.state.tips[resourceId]![0]!.versionId).toBe(tip.versionId);
    } finally { await f.manager.shutdown(); }
  });

  it("acknowledges a successful local chat publication even while its peer conflict is unresolved", async () => {
    const f = await fixture();
    const peer = await SyncRepository.open(f.repository.root, join(f.root, "peer"), passphrase, f.repository.maxPayloadBytes, { ...producer, cursorVersion: "4.0.0" });
    const content = canonicalBytes({ ...f.chat, header: { ...f.chat.header, value: JSON.stringify({ name: "incompatible peer core" }) } });
    await peer.publish([{ ...f.snapshot, content, semanticHash: sha256(content), parents: [] }], []);
    f.internals.resourceApplyBlockReason = tip => tip.deviceId === peer.state.device.deviceId ? "Peer Cursor version requires a newer runtime" : null;
    try {
      await f.sync();
      expect(f.repository.state.conflicts.filter(conflict => conflict.resolvedAt === undefined)).toHaveLength(1);
      const localTip = f.repository.state.tips[resourceId]!.find(tip => tip.deviceId === f.repository.state.device.deviceId)!;
      expect(f.repository.state.projections[resourceId]).toMatchObject({ semanticHash: f.snapshot.semanticHash, versionId: localTip.versionId });
      expect((await f.repository.readVersion(localTip.versionId)).content).toEqual(f.snapshot.content);
      const before = await f.repository.countEvents();
      await f.sync();
      expect(await f.repository.countEvents()).toBe(before);
    } finally { await f.manager.shutdown(); }
  });

  it("does not claim a local observation was published when the event write fails", async () => {
    const f = await fixture();
    vi.spyOn(f.repository, "publish").mockRejectedValue(new Error("event write failed"));
    try {
      await f.sync();
      expect(f.repository.state.projections[resourceId]).toBeUndefined();
      expect(await f.repository.countEvents()).toBe(0);
    } finally { await f.manager.shutdown(); }
  });

  it.each([
    { legacyObservation: false, conflict: false, preEnrichment: false },
    { legacyObservation: true, conflict: false, preEnrichment: false },
    { legacyObservation: false, conflict: true, preEnrichment: false },
    { legacyObservation: true, conflict: true, preEnrichment: false },
    { legacyObservation: false, conflict: false, preEnrichment: true },
    { legacyObservation: true, conflict: false, preEnrichment: true },
  ])("acknowledges matching peer bytes without consuming synthetic changes ($legacyObservation / $conflict / $preEnrichment)", async ({ legacyObservation, conflict, preEnrichment }) => {
    const f = await fixture();
    const previous = { ...f.chat, header: { ...f.chat.header, lastUpdatedAt: 1 },
      bubbles: f.chat.bubbles.map(row => ({ ...row, valueBase64: Buffer.from(JSON.stringify({ text: "previous body" })).toString("base64") })) };
    const previousContent = canonicalBytes(previous);
    const old = await f.repository.publish([{ ...f.snapshot, content: previousContent, semanticHash: sha256(previousContent), parents: [] }], []);
    const oldVersionId = `${old.eventHash!}#0`;
    f.repository.state.projections[resourceId] = { resourceId, kind: "chat", versionId: oldVersionId,
      semanticHash: legacyObservation ? f.snapshot.semanticHash : sha256(previousContent),
      sourceChatCoreHash: portableChatCoreHash(legacyObservation ? f.chat : previous) };
    await f.repository.saveState();
    const peer = await SyncRepository.open(f.repository.root, join(f.root, "peer"), passphrase, f.repository.maxPayloadBytes, preEnrichment ? producer : { ...producer, cursorVersion: "4.0.0" });
    const peerPublished = await peer.publish([{ ...f.snapshot, parents: [oldVersionId] }], []);
    if (conflict) {
      const branch = canonicalBytes({ ...previous, header: { ...previous.header, value: JSON.stringify({ name: "other durable branch" }) } });
      await f.repository.publish([{ ...f.snapshot, content: branch, semanticHash: sha256(branch), parents: [oldVersionId] }], []);
    }
    f.repository.invalidateSharedGraphObservation();
    if (!preEnrichment) {
      f.internals.resourceApplyBlockReason = tip => tip.deviceId === peer.state.device.deviceId ? "Peer Cursor version requires a newer runtime" : null;
    }
    try {
      await f.sync();
      expect(f.repository.state.projections[resourceId]).toMatchObject({ semanticHash: f.snapshot.semanticHash, versionId: `${peerPublished.eventHash!}#0` });
      if (preEnrichment) {
        const enrichedTip = f.repository.state.tips[resourceId]![0]!;
        expect(enrichedTip.metadata?.syncOrigin).toBe("agent-kv-enrichment");
        expect(f.repository.state.pendingDatabaseChanges).toContainEqual(expect.objectContaining({ resourceId, eventHash: enrichedTip.eventHash }));
      }
      const before = await f.repository.countEvents();
      await helperMainTesting.exportFinalChanges(f.request, f.repository, () => {}, true);
      expect(await f.repository.countEvents()).toBe(before);
      expect(f.repository.state.conflicts.filter(item => item.resolvedAt === undefined)).toHaveLength(conflict ? 1 : 0);
    } finally { await f.manager.shutdown(); }
  });

  it("keeps an unauthenticated matching chat pending instead of recording an inferred ACK", async () => {
    const f = await fixture();
    const peer = await SyncRepository.open(f.repository.root, join(f.root, "peer"), passphrase, f.repository.maxPayloadBytes, { ...producer, cursorVersion: "4.0.0" });
    const published = await peer.publish([{ ...f.snapshot, parents: [] }], []);
    f.repository.invalidateSharedGraphObservation();
    f.internals.resourceApplyBlockReason = () => "Peer Cursor version requires a newer runtime";
    const read = f.repository.readVersionMetadata.bind(f.repository);
    vi.spyOn(f.repository, "readVersionMetadata").mockImplementation(versionId =>
      versionId === `${published.eventHash!}#0` ? Promise.reject(new Error("Authenticated event unavailable")) : read(versionId));
    try {
      await f.sync();
      expect(f.repository.state.projections[resourceId]).toBeUndefined();
      expect(f.repository.state.pendingDatabaseChanges.find(change => change.resourceId === resourceId)?.blockedReason).toContain("could not be authenticated");
      expect(await f.repository.countEvents()).toBe(1);
    } finally { await f.manager.shutdown(); }
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cursor-manager-chat-ack-"));
  roots.push(root);
  const storage = join(root, "storage");
  const user = join(root, "User");
  await mkdir(storage);
  await mkdir(user);
  const databasePath = join(root, "state.vscdb");
  const blob = Buffer.from("immutable continuation blob");
  const blobId = sha256(blob);
  const bubbleId = "bubble-1";
  const textRow = (key: string, value: string) => ({ key, valueType: "text" as const, valueBase64: Buffer.from(value).toString("base64") });
  const chat: PortableChatSnapshotV1 = {
    schemaVersion: 1, composerId,
    header: { composerId, workspaceId: null, createdAt: 1, lastUpdatedAt: 2, isArchived: 0, isSubagent: 0, recency: 0, checkpointAt: null, value: JSON.stringify({ name: "local conversation" }) },
    composerData: textRow(`composerData:${composerId}`, JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId }], conversationState: `~${Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(blobId, "hex")]).toString("base64")}` })),
    bubbles: [textRow(`bubbleId:${composerId}:${bubbleId}`, JSON.stringify({ text: "local message" }))],
  };
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE ItemTable(key TEXT UNIQUE,value BLOB); CREATE TABLE cursorDiskKV(key TEXT UNIQUE,value BLOB); CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,createdAt INTEGER,lastUpdatedAt INTEGER,isArchived INTEGER,isSubagent INTEGER,recency INTEGER,checkpointAt INTEGER,value TEXT);");
  database.prepare("INSERT INTO composerHeaders VALUES(?,NULL,1,2,0,0,0,NULL,?)").run(composerId, chat.header.value);
  for (const row of [chat.composerData, ...chat.bubbles]) database.prepare("INSERT INTO cursorDiskKV VALUES(?,?)").run(row.key, Buffer.from(row.valueBase64, "base64").toString("utf8"));
  database.prepare("INSERT INTO cursorDiskKV VALUES(?,?)").run(`agentKv:blob:${blobId}`, blob);
  database.close();
  const repository = await SyncRepository.create(join(root, "repository"), storage, passphrase, 4 * 1024 * 1024, producer);
  const paths = {
    appRoot: root, userDataRoot: user, globalStorageRoot: root, globalDatabase: databasePath,
    workspaceStorageRoot: join(user, "workspaceStorage"), profilesRoot: join(user, "profiles"), snippetsRoot: join(user, "snippets"), promptsRoot: join(user, "prompts"), userTasks: join(user, "tasks.json"), userMcp: join(user, "mcp.json"),
    cursorHome: join(root, ".cursor"), cursorMcp: join(root, "mcp.json"), cursorCliConfig: join(root, "cli-config.json"), cursorCommands: join(root, "commands"), cursorSkills: join(root, "skills"), cursorRules: join(root, "rules"), cursorProjects: join(root, "projects"), cursorChats: join(root, "chats"), cursorAcpSessions: join(root, "acp-sessions"), cursorExtensionsManifest: join(root, "extensions.json"), extensionStorage: storage, helperScript: join(root, "helper.js"),
  } satisfies CursorPaths;
  const compatibility: CompatibilityReport = { compatible: true, ...producer, nodeVersion: process.versions.node, sqliteAvailable: true, sqliteBackupAvailable: true, globalDatabasePath: databasePath, databaseCapabilities: { "global-item-table": { available: true, reasons: [] }, "global-chat": { available: true, reasons: [] }, "sqlite-files": { available: true, reasons: [] } }, reasons: [], warnings: [] };
  const manager = new SyncManager({} as never, paths, compatibility, { gitSync: false, enabled: true, syncChat: true, syncWorkspaceStorage: false, maxPayloadBytes: repository.maxPayloadBytes, autoApplyFiles: false, applyOnShutdown: false, effectiveIgnoredWorkspaces: [] } as unknown as ExtensionConfiguration, { log: vi.fn(), setStatus: vi.fn() } as unknown as StatusController, {} as ConflictController);
  const content = canonicalBytes(chat);
  const snapshot: ResourceSnapshot = { resourceId, kind: "chat", content, semanticHash: sha256(content), metadata: { composerId, workspaceId: null, lastUpdatedAt: 2, bubbleCount: 1, chatSnapshotSchemaVersion: 1, chatCoreHash: portableChatCoreHash(chat) } };
  const adapter: ResourceAdapter = { id: "test-live-chat", kinds: ["chat"], appliesWhileRunning: false, scan: async () => ({ snapshots: [snapshot], deletions: [], warnings: [] }), apply: async () => { throw new Error("Live chat apply is forbidden"); } };
  const internals = manager as unknown as { repository: SyncRepository; adapters: ResourceAdapter[]; performSync(manual: boolean, scope: "all"): Promise<void>; resourceApplyBlockReason(tip: ResourceTip): string | null };
  internals.repository = repository;
  internals.adapters = [adapter];
  const request: HelperRequest = { version: 1, requestId: "11111111-2222-4333-8444-555555555555", mode: "final-export", createdAt: new Date().toISOString(), repositoryRoot: repository.root, storageRoot: storage, cursorExecutable: process.execPath, extensionHostPid: 0x7ffffffe, restart: false, expectedCursorVersion: producer.cursorVersion, expectedVscodeVersion: producer.vscodeVersion, extensionVersion: producer.extensionVersion, paths, changes: [], workspaceMappings: {}, syncOptions: { ignoredSettings: [], ignoredExtensions: [], ignoredUserFiles: [], ignoredUiStateKeys: [], ignoredWorkspaces: [], machineScopedSettings: [], applyOnShutdown: true, syncChat: true, syncWorkspaceStorage: false, maxPayloadBytes: repository.maxPayloadBytes, gitSync: false } };
  return { root, repository, manager, internals, request, chat, snapshot, sync: () => internals.performSync(false, "all") };
}
