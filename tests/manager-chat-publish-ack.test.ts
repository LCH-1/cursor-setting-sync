import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ extensions: { all: [] }, workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }) }, window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined } }));

import { StateVscdbChatAdapter, parsePortableChatSnapshot, portableChatCoreHash, type PortableChatSnapshotV1 } from "../src/chat/stateVscdb";
import { __testing as helperMainTesting } from "../src/helper/main";
import { isLiveVerificationCandidate, verifyLiveQueuedChats } from "../src/helper/liveVerification";
import type { HelperRequest } from "../src/helper/types";
import type { ExtensionConfiguration } from "../src/config";
import type { CursorPaths } from "../src/platform/paths";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import { EventReconciler } from "../src/protocol/reconciler";
import { acquireFileLock } from "../src/platform/lock";
import type { ResourceAdapter } from "../src/resources/resource";
import { createExtensionIgnoreMatcher, ExtensionsAdapter } from "../src/resources/extensions";
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
  it.each(["partial", "complete", "missing-blob", "corrupt-blob", "changed-core", "untrusted-baseline", "different-baseline", "tampered-payload", "recapture", "superseded"] as const)("settles an equivalent v2 merge only after authenticating and observing its existing rows (%s)", async mode => {
    const f = await fixture();
    const db = new DatabaseSync(f.request.paths.globalDatabase);
    try {
      const blob = Buffer.from("immutable continuation blob");
      const id = sha256(blob);
      const missing = "f".repeat(64);
      const content = canonicalBytes({ ...f.chat, schemaVersion: 2, agentKv: {
        blobs: [{ key: `agentKv:blob:${id}`, valueType: "blob", valueBase64: blob.toString("base64") }],
        referencedIds: mode === "complete" ? [id] : [id, missing].sort(),
        missingIds: mode === "complete" ? [] : [missing],
      } });
      const snapshot = { ...f.snapshot, content, semanticHash: sha256(content), metadata: {
        ...f.snapshot.metadata, chatSnapshotSchemaVersion: 2, agentKvBlobCount: 1,
        agentKvReferencedCount: mode === "complete" ? 1 : 2, agentKvMissingCount: mode === "complete" ? 0 : 1,
      } };
      const baseline = await f.repository.publish([{ ...snapshot, parents: [] }], []);
      const baselineId = `${baseline.eventHash!}#0`;
      const merged = await f.repository.publish([{ ...snapshot, parents: [baselineId], metadata: {
        ...snapshot.metadata, syncOrigin: "auto-merge",
      } }], []);
      new EventReconciler().reconcile(await f.repository.listEvents(), f.repository.state, null);
      const tip = f.repository.state.tips[resourceId]![0]!;
      f.repository.state.projections[resourceId] = {
        resourceId, kind: "chat", versionId: baselineId, semanticHash: snapshot.semanticHash,
        payloadObjectId: tip.payload!.objectId,
        ...(mode === "recapture" ? { requiresAgentKvRecapture: true } : {}),
      };
      f.request.changes = [{ ...tip, resourceId }];
      const pending = { resourceId, kind: "chat" as const, eventHash: merged.eventHash!, changeIndex: 0,
        blockedReason: "Waiting for a complete synchronized continuation snapshot." };
      f.repository.state.pendingDatabaseChanges = [pending];
      expect(isLiveVerificationCandidate(tip, f.repository.state.projections[resourceId])).toBe(true);
      expect(isLiveVerificationCandidate(tip)).toBe(false);
      if (mode === "missing-blob") db.prepare("DELETE FROM cursorDiskKV WHERE key=?").run(`agentKv:blob:${id}`);
      if (mode === "corrupt-blob") db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(Buffer.from("wrong"), `agentKv:blob:${id}`);
      if (mode === "changed-core") db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run("local edit", f.chat.bubbles[0]!.key);
      if (mode === "untrusted-baseline" || mode === "different-baseline") {
        const read = f.repository.readVersionMetadata.bind(f.repository);
        vi.spyOn(f.repository, "readVersionMetadata").mockImplementation(async version => {
          if (version !== baselineId) return read(version);
          if (mode === "untrusted-baseline") throw new Error("baseline authentication failed");
          const original = await read(version);
          return { ...original, change: { ...original.change, semanticHash: "0".repeat(64) } };
        });
      }
      if (mode === "tampered-payload") {
        const read = f.repository.readVersion.bind(f.repository);
        vi.spyOn(f.repository, "readVersion").mockImplementation(async version => ({ ...await read(version), content: Buffer.from("tampered") }));
      }
      if (mode === "superseded") f.repository.state.tips[resourceId] = [{ ...tip, versionId: `${"f".repeat(64)}#0` }];
      const before = db.prepare("SELECT key,value FROM cursorDiskKV ORDER BY key").all();
      let verified: string[];
      if (mode === "partial") {
        f.internals.resourceApplyBlockReason = () => null;
        const runtime = f.manager as unknown as {
          masterKey: Buffer;
          helperSyncOptions(): HelperRequest["syncOptions"];
          helper: { verifyWhileRunning: (...args: unknown[]) => Promise<void> };
          verifyPendingWhileRunning(repository: SyncRepository, manual: boolean): Promise<void>;
        };
        runtime.masterKey = Buffer.from(f.repository.masterKey);
        runtime.helperSyncOptions = () => f.request.syncOptions;
        verified = [];
        const verify = vi.spyOn(runtime.helper, "verifyWhileRunning").mockImplementation(async (...args) => {
          f.request.changes = args[2] as HelperRequest["changes"];
          verified = await verifyLiveQueuedChats(f.request, f.repository);
        });
        await runtime.verifyPendingWhileRunning(f.repository, true);
        expect(verify).toHaveBeenCalledOnce();
      } else {
        verified = await verifyLiveQueuedChats(f.request, f.repository);
      }
      expect(db.prepare("SELECT key,value FROM cursorDiskKV ORDER BY key").all()).toEqual(before);
      expect(db.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`agentKv:blob:${missing}`)).toBeUndefined();
      if (mode === "partial" || mode === "complete") {
        expect(verified).toEqual([resourceId]);
        expect(f.repository.state.pendingDatabaseChanges).toEqual([]);
        expect(f.repository.state.projections[resourceId]?.versionId).toBe(tip.versionId);
        expect((await f.repository.readVersion(baselineId)).content).toEqual(content);
        expect((await f.repository.readVersion(tip.versionId)).change.metadata?.agentKvMissingCount).toBe(mode === "complete" ? 0 : 1);
        if (mode === "partial") {
          f.internals.adapters[0]!.scan = async () => ({ snapshots: [snapshot], deletions: [], warnings: [] });
          (f.manager as unknown as { lastLiveVerificationAt: number }).lastLiveVerificationAt = 0;
          await f.sync();
          (f.manager as unknown as { lastLiveVerificationAt: number }).lastLiveVerificationAt = 0;
          await f.sync();
          expect(f.repository.state.pendingDatabaseChanges).toEqual([]);
        }
      } else {
        expect(verified).toEqual([]);
        expect(f.repository.state.pendingDatabaseChanges).toEqual([pending]);
      }
    } finally { db.close(); await f.manager.shutdown(); }
  });

  it.each(["edited", "pruned", "different-remote", "untrusted-baseline"] as const)("preserves local edits beyond an authenticated equivalent queued baseline (%s)", async mode => {
    const f = await fixture();
    try {
      const original = await f.repository.publish([{ ...f.snapshot, parents: [] }], []);
      const originalVersion = `${original.eventHash!}#0`;
      f.repository.state.projections[resourceId] = { resourceId, kind: "chat", versionId: originalVersion,
        semanticHash: f.snapshot.semanticHash, sourceBubbleCount: 1 };
      const remote = mode === "different-remote" ? canonicalBytes({ ...f.chat, header: { ...f.chat.header, value: "remote edit" } }) : f.snapshot.content;
      const merged = await f.repository.publish([{ ...f.snapshot, content: remote, semanticHash: sha256(remote),
        metadata: { ...f.snapshot.metadata, syncOrigin: "auto-merge" }, parents: [originalVersion] }], []);
      new EventReconciler().reconcile(await f.repository.listEvents(), f.repository.state, null);
      const tip = f.repository.state.tips[resourceId]![0]!;
      f.request.changes = [{ ...tip, resourceId }];
      f.repository.state.pendingDatabaseChanges = [{ resourceId, kind: "chat", eventHash: merged.eventHash!, changeIndex: 0 }];
      await f.repository.saveState();
      const db = new DatabaseSync(f.request.paths.globalDatabase);
      try {
        if (mode === "pruned") db.prepare("DELETE FROM cursorDiskKV WHERE key=?").run(f.chat.bubbles[0]!.key);
        else db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run("new local edit", f.chat.bubbles[0]!.key);
      } finally { db.close(); }
      if (mode === "untrusted-baseline") {
        const read = f.repository.readVersionMetadata.bind(f.repository);
        vi.spyOn(f.repository, "readVersionMetadata").mockImplementation(version => version === originalVersion ? Promise.reject(new Error("bad baseline")) : read(version));
      }
      const settled = await verifyLiveQueuedChats(f.request, f.repository);
      if (mode === "edited") {
        expect(settled).toEqual([resourceId]);
        expect(f.repository.state.pendingDatabaseChanges).toEqual([]);
        const published = await f.repository.readVersion(f.repository.state.projections[resourceId].versionId!);
        expect(published.change.parents).toEqual([originalVersion, tip.versionId].sort());
        expect(parsePortableChatSnapshot(published.content!).bubbles[0]!.valueBase64).toBe(Buffer.from("new local edit").toString("base64"));
      } else {
        expect(settled).toEqual([]);
        expect(await f.repository.countEvents()).toBe(2);
        expect(f.repository.state.pendingDatabaseChanges).toHaveLength(1);
      }
    } finally { await f.manager.shutdown(); }
  });

  it("runs live verification after releasing the sync lock and refreshes the queue", async () => {
    const f = await fixture();
    f.internals.resourceApplyBlockReason = () => null;
    const blob = Buffer.from("immutable continuation blob");
    const id = sha256(blob);
    const content = canonicalBytes({ ...f.chat, schemaVersion: 2, agentKv: {
      blobs: [{ key: `agentKv:blob:${id}`, valueType: "blob", valueBase64: blob.toString("base64") }], referencedIds: [id], missingIds: [],
    } });
    await f.repository.publish([{ ...f.snapshot, content, semanticHash: sha256(content), metadata: {
      ...f.snapshot.metadata, chatSnapshotSchemaVersion: 2, syncOrigin: "agent-kv-enrichment", agentKvEnrichmentAppliesCore: false,
      agentKvBlobCount: 1, agentKvReferencedCount: 1, agentKvMissingCount: 0,
    } }], []);
    const runtime = f.manager as unknown as {
      masterKey: Buffer;
      helperSyncOptions(): HelperRequest["syncOptions"];
      helper: { verifyWhileRunning: (...args: unknown[]) => Promise<void> };
    };
    runtime.masterKey = Buffer.from(f.repository.masterKey);
    runtime.helperSyncOptions = () => f.request.syncOptions;
    const verify = vi.spyOn(runtime.helper, "verifyWhileRunning").mockImplementation(async (...args) => {
      const lock = await acquireFileLock(join(f.request.storageRoot, "sync.lock"));
      expect(lock).not.toBeNull();
      try {
        f.request.changes = args[2] as HelperRequest["changes"];
        await verifyLiveQueuedChats(f.request, f.repository);
      } finally { await lock?.release(); }
    });
    try {
      await f.sync();
      expect(verify).toHaveBeenCalledOnce();
      expect(f.repository.state.pendingDatabaseChanges).toEqual([]);
    } finally { await f.manager.shutdown(); }
  });

  it.each(["v1", "blobs", "missing", "corrupt", "changed", "unauthenticated", "superseded", "core-present", "core-changed"] as const)("verifies the exact queued chat while another connection remains open (%s)", async mode => {
    const f = await fixture();
    const db = new DatabaseSync(f.request.paths.globalDatabase);
    try {
      const blob = Buffer.from("immutable continuation blob");
      const id = sha256(blob);
      const enriched = { ...f.chat, schemaVersion: 2, agentKv: { blobs: [{ key: `agentKv:blob:${id}`, valueType: "blob", valueBase64: blob.toString("base64") }], referencedIds: [id], missingIds: [] } };
      const content = mode === "v1" ? f.snapshot.content : canonicalBytes(enriched);
      const metadata = mode === "v1" ? f.snapshot.metadata! : { ...f.snapshot.metadata, chatSnapshotSchemaVersion: 2, syncOrigin: "agent-kv-enrichment", agentKvEnrichmentAppliesCore: mode === "core-present" || mode === "core-changed" };
      const event = await f.repository.publish([{ ...f.snapshot, content, semanticHash: sha256(content), metadata, parents: [] }], []);
      const versionId = `${event.eventHash!}#0`;
      new EventReconciler().reconcile(await f.repository.listEvents(), f.repository.state, null);
      const tip = f.repository.state.tips[resourceId]![0]!;
      f.request.changes = [{ ...tip, resourceId }];
      f.repository.state.pendingDatabaseChanges = [{ resourceId, kind: "chat", eventHash: event.eventHash!, changeIndex: 0, blockedReason: "Incomplete continuation" }];
      await f.repository.saveState();
      if (mode === "missing") db.prepare("DELETE FROM cursorDiskKV WHERE key=?").run(`agentKv:blob:${id}`);
      if (mode === "corrupt") db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(Buffer.from("wrong"), `agentKv:blob:${id}`);
      if (mode === "changed" || mode === "core-changed") db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run("local edit", f.chat.bubbles[0]!.key);
      if (mode === "unauthenticated") vi.spyOn(f.repository, "readVersionMetadata").mockRejectedValue(new Error("authentication failed"));
      if (mode === "superseded") f.repository.state.tips[resourceId] = [{ ...tip, versionId: `${"f".repeat(64)}#0` }];
      const before = db.prepare("SELECT key, value FROM cursorDiskKV ORDER BY key").all();
      const verified = await verifyLiveQueuedChats(f.request, f.repository);
      expect(db.prepare("SELECT key, value FROM cursorDiskKV ORDER BY key").all()).toEqual(before);
      if (mode === "v1" || mode === "blobs" || mode === "core-present") {
        expect(verified).toEqual([resourceId]);
        expect(f.repository.state.pendingDatabaseChanges).toEqual([]);
        expect(f.repository.state.projections[resourceId]).toMatchObject({ versionId, sourceChatCoreHash: portableChatCoreHash(f.chat) });
        await f.repository.refreshState();
        expect(f.repository.state.pendingDatabaseChanges).toEqual([]);
      } else {
        expect(verified).toEqual([]);
        expect(f.repository.state.pendingDatabaseChanges).toHaveLength(1);
      }
    } finally { db.close(); await f.manager.shutdown(); }
  });

  it.each(["live", "shutdown", "changed", "unauthenticated"] as const)("settles an equivalent queued v1 merge from fresh bounded observations (%s)", async mode => {
    const f = await fixture();
    const original = await f.repository.publish([{ ...f.snapshot, parents: [] }], []);
    const originalVersion = `${original.eventHash!}#0`;
    f.repository.state.projections[resourceId] = { resourceId, kind: "chat", versionId: originalVersion,
      semanticHash: f.snapshot.semanticHash, sourceChatCoreHash: portableChatCoreHash(f.chat), sourceTimestamp: 2, sourceBubbleCount: 1 };
    const merged = await f.repository.publish([{ ...f.snapshot, parents: [originalVersion],
      metadata: { ...f.snapshot.metadata, syncOrigin: "auto-merge", mergeStrategy: "latest" } }], []);
    const mergedVersion = `${merged.eventHash!}#0`;
    f.repository.state.pendingDatabaseChanges = [{ resourceId, kind: "chat", eventHash: merged.eventHash!, changeIndex: 0, blockedReason: "Incomplete continuation" }];
    await f.repository.saveState();
    const onCapture = vi.fn();
    const adapter = new StateVscdbChatAdapter(f.request.paths, { periodicDeepVerification: false, onChatBodyCapture: onCapture });
    f.internals.adapters = [adapter];
    f.internals.resourceApplyBlockReason = () => "Incomplete continuation";
    if (mode === "changed") {
      const db = new DatabaseSync(f.request.paths.globalDatabase);
      db.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ text: "unpublished local edit" }), `bubbleId:${composerId}:bubble-1`);
      db.close();
    }
    if (mode === "unauthenticated") {
      const read = f.repository.readVersionMetadata.bind(f.repository);
      vi.spyOn(f.repository, "readVersionMetadata").mockImplementation(versionId => versionId === mergedVersion
        ? Promise.reject(new Error("Cannot authenticate merged event")) : read(versionId));
    }
    try {
      if (mode === "shutdown") {
        await helperMainTesting.exportFinalChanges(f.request, f.repository, () => {}, true);
      } else {
        await f.sync();
      }
      if (mode === "live" || mode === "shutdown") {
        expect(f.repository.state.projections[resourceId]?.versionId).toBe(mergedVersion);
        expect(f.repository.state.pendingDatabaseChanges.filter(item => item.resourceId === resourceId)).toEqual([]);
        expect(await f.repository.countEvents()).toBe(2);
        if (mode === "live") {
          const captures = onCapture.mock.calls.length;
          expect(captures).toBeGreaterThan(0);
          await f.sync();
          expect(onCapture).toHaveBeenCalledTimes(captures);
          expect(f.repository.state.pendingDatabaseChanges).toEqual([]);
        }
      } else {
        expect(f.repository.state.projections[resourceId]?.versionId).not.toBe(mergedVersion);
        expect(f.repository.state.pendingDatabaseChanges).toContainEqual(expect.objectContaining({ resourceId, eventHash: merged.eventHash }));
      }
      const db = new DatabaseSync(f.request.paths.globalDatabase, { readOnly: true });
      try {
        const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`bubbleId:${composerId}:bubble-1`);
        expect(row?.value).toBe(JSON.stringify({ text: mode === "changed" ? "unpublished local edit" : "local message" }));
      } finally { db.close(); }
    } finally { await f.manager.shutdown(); }
  });

  it.each(["live", "shutdown", "new-remote"] as const)("handles an extension removal against a synthetic install (%s)", async mode => {
    const f = await fixture();
    const id = "extension/default/publisher.removed";
    const content = canonicalBytes({ id: "publisher.removed", version: "1.0.0", installed: true, enabled: true, preRelease: false, pinned: false });
    const snapshot: ResourceSnapshot = { resourceId: id, kind: "extension", content, semanticHash: sha256(content), metadata: { profileId: "default", profileName: null, extensionId: "publisher.removed" } };
    const installed = await f.repository.publish([{ ...snapshot, parents: [] }], []);
    const installedVersion = `${installed.eventHash!}#0`;
    f.repository.state.projections[id] = { resourceId: id, kind: "extension", semanticHash: snapshot.semanticHash, versionId: installedVersion };
    const remoteContent = mode === "new-remote" ? canonicalBytes({ id: "publisher.removed", version: "2.0.0", installed: true, enabled: true, preRelease: false, pinned: false }) : content;
    const merged = await f.repository.publish([{ ...snapshot, content: remoteContent, semanticHash: sha256(remoteContent), parents: [installedVersion], metadata: { ...snapshot.metadata, syncOrigin: "conflict-resolution" } }], []);
    await f.repository.saveState();
    const adapter = new ExtensionsAdapter(f.request.paths, createExtensionIgnoreMatcher([]), { scanIntervalMs: 0, listInstalledExtensions: async () => [] });
    f.internals.adapters = [adapter];
    try {
      if (mode === "shutdown") {
        const scan = adapter.scan.bind(adapter);
        const status = adapter.scanStatus.bind(adapter);
        vi.spyOn(ExtensionsAdapter.prototype, "scan").mockImplementation(scan);
        vi.spyOn(ExtensionsAdapter.prototype, "scanStatus").mockImplementation(status);
        f.request.syncOptions.syncChat = false;
        await helperMainTesting.exportFinalChanges(f.request, f.repository, () => {});
      } else {
        await f.sync();
      }
      expect(f.repository.state.tips[id]).toHaveLength(1);
      if (mode === "new-remote") {
        expect(f.repository.state.tips[id]![0]).toMatchObject({ operation: "put", versionId: `${merged.eventHash!}#0` });
        expect(f.repository.state.pendingDatabaseChanges).toContainEqual(expect.objectContaining({ resourceId: id }));
        return;
      }
      expect(f.repository.state.tips[id]![0]).toMatchObject({ operation: "delete", parents: [`${merged.eventHash!}#0`] });
      expect(f.repository.state.pendingDatabaseChanges.filter(item => item.resourceId === id)).toEqual([]);
      const eventCount = await f.repository.countEvents();
      await f.sync();
      expect(await f.repository.countEvents()).toBe(eventCount);
    } finally { await f.manager.shutdown(); }
  });

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
