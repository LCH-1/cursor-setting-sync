import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import {
  MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE,
  MAX_CHAT_OVERSIZED_SETTLEMENTS,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  StateVscdbChatAdapter,
} from "../src/chat/stateVscdb";
import {
  __testing as helperMainTesting,
  prepareChanges,
  markAppliedProjections,
} from "../src/helper/main";
import type { HelperChange, HelperRequest } from "../src/helper/types";
import type { CursorPaths } from "../src/platform/paths";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import { applyGlobalDatabaseChanges } from "../src/helper/database";
import { migrateOfflineChatTips } from "../src/helper/chatMigration";
import { mergeOfflineChatConflicts } from "../src/helper/chatConflictMerge";
import { mergeChatSnapshotBuffers } from "../src/chat/chatMerge";
import { enrichCurrentChatTipsFromLiveDatabase } from "../src/chat/enrichment";
import { APPLY_FAILURE_BLOCK_PREFIX, MAX_HELPER_APPLY_WORK_BYTES } from "../src/constants";
import type {
  PortableChatSnapshot,
  PortableChatSnapshotV2,
} from "../src/chat/stateVscdb";
import type { PortableStoreSnapshot } from "../src/chat/storeDb";
import type { ResourceSnapshot } from "../src/types";

const PASSPHRASE = "a sufficiently long final export passphrase";
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const SMALL_CHAT_COUNT = 40;
const SMALL_BUBBLE_BYTES = 256 * 1024;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("the helper's bounded final chat export", () => {
  it.each(["settled", "protected", "incomplete", "round-limit"] as const)("settles a local edit first discovered after partial remote continuation becomes ready in the same shutdown (%s)", async (mode) => {
    const fixture = await createFixture();
    const id = composerId(706);
    const resourceId = `chat/${id}`;
    const blob = Buffer.from("immutable continuation available on this PC");
    const blobId = sha256(blob);
    const conversationState = `~${Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(blobId, "hex")]).toString("base64")}`;
    insertLiveChat(fixture.database, id, "shared base", 1, 8);
    fixture.database.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: `bubble-${id}` }], conversationState,
    }), `composerData:${id}`);
    fixture.database.prepare("INSERT INTO cursorDiskKV VALUES (?,?)").run(`agentKv:blob:${blobId}`, blob);
    fixture.database.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    const base = fixture.repository.state.tips[resourceId]![0]!;
    const source = parsePortableChatSnapshot((await fixture.repository.readVersion(base.versionId)).content!);
    const partial: PortableChatSnapshotV2 = { ...source, schemaVersion: 2,
      bubbles: [{ ...source.bubbles[0]!, valueBase64: Buffer.from(JSON.stringify({ text: "older remote branch" })).toString("base64") }],
      agentKv: { blobs: [], referencedIds: [blobId], missingIds: [blobId] } };
    const content = canonicalBytes(partial);
    const peer = await SyncRepository.open(fixture.request.repositoryRoot, join(fixture.request.storageRoot, "peer"), PASSPHRASE, MAX_PAYLOAD_BYTES, base.producer!);
    const remote = await peer.publish([{ resourceId, kind: "chat", content, semanticHash: sha256(content), parents: [base.versionId],
      metadata: { chatSnapshotSchemaVersion: 2, chatCoreHash: portableChatCoreHash(partial), lastUpdatedAt: 1, bubbleCount: 1,
        agentKvBlobCount: 0, agentKvReferencedCount: 1, agentKvMissingCount: 1 } }], []);
    fixture.repository.state.pendingDatabaseChanges = [{ resourceId, kind: "chat", eventHash: remote.eventHash!, changeIndex: 0,
      blockedReason: "Continuation is incomplete" }];
    await fixture.repository.saveState();
    const local = new DatabaseSync(fixture.request.paths.globalDatabase);
    local.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ text: "latest local edit with unchanged timestamp" }), `bubbleId:${id}:bubble-${id}`);
    local.close();
    fixture.repository.invalidateSharedGraphObservation();
    const originalHead = fixture.repository.state.ownStreamHead;
    const first = await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    expect(fixture.repository.state.ownStreamHead).toBe(originalHead);
    expect(first.verifiedApplyVersionIds).toEqual([]);
    if (mode === "protected") {
      first.protectedLocalResourceIds.push(resourceId);
    } else if (mode === "incomplete") {
      first.incompleteKinds.push("chat");
    }
    const guard = vi.fn(async () => {});
    let injected = false;
    // The forwarding call below preserves each real adapter's receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalScan = StateVscdbChatAdapter.prototype.scan;
    const scan = mode === "round-limit" ? vi.spyOn(StateVscdbChatAdapter.prototype, "scan").mockImplementation(async function (this: StateVscdbChatAdapter, known) {
      const tips = fixture.repository.state.tips[resourceId] ?? [];
      if (!injected && tips.length === 1 && tips[0]!.metadata?.chatResolutionStrategy !== undefined) {
        injected = true;
        const database = new DatabaseSync(fixture.request.paths.globalDatabase);
        try {
          database.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ text: "another local edit during the final verification" }), `bubbleId:${id}:bubble-${id}`);
        } finally { database.close(); }
      }
      return originalScan.call(this, known);
    }) : null;
    let outcome;
    try {
      outcome = await helperMainTesting.settleOfflineChatChanges(fixture.request, fixture.repository, first, guard, () => {});
    } finally { scan?.mockRestore(); }
    const reconciled = new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    if (mode === "round-limit") {
      expect(injected).toBe(true);
      expect(reconciled.conflicts).toHaveLength(1);
      expect(outcome.notices).toContain("Some chat updates still need merge or final verification. They remain queued for the next shutdown apply.");
      const tips = fixture.repository.state.tips[resourceId]!;
      expect(tips).toHaveLength(2);
      const latest = tips.find(tip => tip.metadata?.chatResolutionStrategy === undefined)!;
      expect(outcome.verifiedApplyVersionIds).not.toContain(latest.versionId);
      const verified = helperMainTesting.intersectVerifiedApplyPage(tips.map(tip => helperChange(tip, resourceId)), outcome.verifiedApplyVersionIds);
      expect(verified.every(change => !helperMainTesting.isEligible(change, reconciled.projections, fixture.repository.state.conflicts))).toBe(true);
      expect(fixture.repository.state.pendingDatabaseChanges).toHaveLength(1);
      const snapshot = parsePortableChatSnapshot((await fixture.repository.readVersion(latest.versionId)).content!);
      expect(Buffer.from(snapshot.bubbles[0]!.valueBase64, "base64").toString()).toBe(JSON.stringify({ text: "another local edit during the final verification" }));
      return;
    }
    expect(reconciled.conflicts).toEqual([]);
    const final = fixture.repository.state.tips[resourceId]![0]!;
    expect(outcome.verifiedApplyVersionIds).toContain(final.versionId);
    if (mode === "protected" || mode === "incomplete") {
      expect(helperMainTesting.finalExportApplyBlockReason(helperChange(final, resourceId), outcome))
        .toContain(mode === "protected" ? "exact final local resource" : "final local scan");
      expect(fixture.repository.state.pendingDatabaseChanges).toHaveLength(1);
      expect(fixture.repository.state.projections[resourceId]!.versionId).not.toBe(final.versionId);
      return;
    }
    expect(helperMainTesting.finalExportApplyBlockReason(helperChange(final, resourceId), outcome)).toBeNull();
    const snapshot = parsePortableChatSnapshot((await fixture.repository.readVersion(final.versionId)).content!);
    expect(snapshot.schemaVersion).toBe(2);
    expect(Buffer.from(snapshot.bubbles[0]!.valueBase64, "base64").toString()).toBe(JSON.stringify({ text: "latest local edit with unchanged timestamp" }));
    const prepared = await prepareChanges(fixture.repository, [helperChange(final, resourceId)]);
    const applied = await applyGlobalDatabaseChanges(fixture.request, prepared.prepared);
    expect(applied.applied).toEqual([resourceId]);
    markAppliedProjections(fixture.repository, [helperChange(final, resourceId)], applied.applied, new Set(applied.retainedLocal), applied.retainedLocalHashes, applied.localChatCoreHashes);
    await fixture.repository.saveState();
    const count = (await fixture.repository.listEvents()).length;
    const next = await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    await helperMainTesting.settleOfflineChatChanges(fixture.request, fixture.repository, next, guard, () => {});
    expect((await fixture.repository.listEvents()).length).toBe(count);
    expect(fixture.repository.state.pendingDatabaseChanges).toEqual([]);
    const database = new DatabaseSync(fixture.request.paths.globalDatabase, { readOnly: true });
    try {
      expect(database.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`bubbleId:${id}:bubble-${id}`)?.value)
        .toBe(JSON.stringify({ text: "latest local edit with unchanged timestamp" }));
    } finally { database.close(); }
    expect(guard).toHaveBeenCalled();
  });

  it.each([false, true])("does not rescan or publish when chat settlement has no work (disabled: %s)", async (disabled) => {
    const fixture = await createFixture();
    fixture.database.close();
    const first = await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    fixture.request.syncOptions.syncChat = !disabled;
    const head = fixture.repository.state.ownStreamHead;
    const guard = vi.fn(async () => {});
    const scan = vi.spyOn(StateVscdbChatAdapter.prototype, "scan");
    try {
      const outcome = await helperMainTesting.settleOfflineChatChanges(fixture.request, fixture.repository, first, guard, () => {});
      expect(outcome).toBe(first);
      expect(scan).not.toHaveBeenCalled();
      expect(guard).toHaveBeenCalledTimes(disabled ? 0 : 1);
      expect(fixture.repository.state.ownStreamHead).toBe(head);
    } finally { scan.mockRestore(); }
  });

  it.each(["final-export", "apply-and-restart"] as const)("never verifies disabled chat adapters through %s targets or its explicit fallback", async (mode) => {
    const fixture = await createFixture();
    fixture.database.close();
    fixture.request.mode = mode;
    fixture.request.syncOptions.syncChat = false;
    const changes: HelperChange[] = (["chat", "chat-transcript", "chat-store", "settings"] as const).map((kind, index) => ({
      resourceId: kind === "chat" ? `chat/${composerId(705)}` : `${kind}/example`, kind,
      operation: "delete", eventHash: String(index + 1).repeat(64), changeIndex: 0, semanticHash: String(index + 5).repeat(64),
    }));
    const projections = changes.map(change => ({ resourceId: change.resourceId, changed: true,
      tip: { ...change, versionId: `${change.eventHash}#0`, deviceId: "peer", lamport: 1, parents: [] } }));
    fixture.request.changes = changes;
    fixture.repository.state.pendingDatabaseChanges = changes.map(change => ({ resourceId: change.resourceId,
      kind: change.kind, eventHash: change.eventHash, changeIndex: 0 }));
    expect(helperMainTesting.finalExportTargetPage(fixture.request, fixture.repository, projections).map(change => change.kind)).toEqual(["settings"]);
    fixture.repository.state.pendingDatabaseChanges = [];
    expect(helperMainTesting.finalExportTargetPage(fixture.request, fixture.repository, projections).map(change => change.kind))
      .toEqual(mode === "apply-and-restart" ? ["settings"] : []);
  });

  it.each(["stale", "transient", "stale-transient", "unknown-block", "failed-scan", "new-local-edit", "disabled-chat"])("revalidates an existing shutdown chat queue safely (%s)", async (mode) => {
    const fixture = await createFixture();
    const id = composerId(704);
    const resourceId = `chat/${id}`;
    insertLiveChat(fixture.database, id, "base", 1, 8);
    fixture.database.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    const before = structuredClone(fixture.repository.state.projections[resourceId]!);
    const peer = await SyncRepository.open(fixture.request.repositoryRoot,
      join(fixture.request.storageRoot, "peer"), PASSPHRASE, MAX_PAYLOAD_BYTES,
      fixture.repository.state.tips[resourceId]![0]!.producer!);
    let previousVersion = before.versionId!;
    const versions: string[] = [];
    for (const time of [2, 3]) {
      const core = portableChatV2(id, "remote continuation", time, `remote message ${time}`);
      const content = canonicalBytes(core);
      const published = await peer.publish([{ resourceId, kind: "chat", content, semanticHash: sha256(content), parents: [previousVersion],
        metadata: { chatSnapshotSchemaVersion: 2, chatCoreHash: portableChatCoreHash(core),
          agentKvBlobCount: 0, agentKvReferencedCount: 0, agentKvMissingCount: 0, lastUpdatedAt: time, bubbleCount: 1 } }], []);
      previousVersion = `${published.eventHash}#0`;
      versions.push(previousVersion);
    }
    fixture.repository.invalidateSharedGraphObservation();
    new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    const current = fixture.repository.state.tips[resourceId]![0]!;
    const blockedReason = mode === "unknown-block" ? `${APPLY_FAILURE_BLOCK_PREFIX}: SQLite quick_check failed` :
      `${APPLY_FAILURE_BLOCK_PREFIX}: The final local verification for ${resourceId} did not finish within the bounded scan. Retry after the current synchronization completes.`;
    const queuedVersion = mode.startsWith("stale") ? versions[0]! : versions[1]!;
    fixture.repository.state.pendingDatabaseChanges = [{ resourceId, kind: "chat", eventHash: queuedVersion.split("#")[0]!, changeIndex: 0,
      ...(mode === "stale" ? {} : { blockedReason }) }];
    await fixture.repository.saveState();
    if (mode === "new-local-edit" || mode === "disabled-chat") {
      const local = new DatabaseSync(fixture.request.paths.globalDatabase);
      local.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ text: "a final local edit" }), `bubbleId:${id}:bubble-${id}`);
      local.close();
    }
    if (mode === "disabled-chat") {
      fixture.request.syncOptions.syncChat = false;
    }
    const scan = mode === "failed-scan" ? vi.spyOn(StateVscdbChatAdapter.prototype, "scan")
      .mockRejectedValue(new Error("The local database cannot be verified")) : null;
    let outcome;
    try { outcome = await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true); }
    finally { scan?.mockRestore(); }
    const pending = fixture.repository.state.pendingDatabaseChanges[0]!;
    expect(`${pending.eventHash}#${pending.changeIndex}`).toBe(current.versionId);
    const reconciled = new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    const candidates = helperMainTesting.shutdownApplyCandidates(fixture.repository, reconciled.projections);
    if (["unknown-block", "failed-scan", "new-local-edit", "disabled-chat"].includes(mode)) {
      expect(pending.blockedReason).toBe(blockedReason);
      expect(candidates).toEqual([]);
      expect(fixture.repository.state.pendingDatabaseChanges).toHaveLength(1);
      if (mode === "new-local-edit") {
        expect(reconciled.conflicts).toHaveLength(1);
      } else {
        expect(fixture.repository.state.projections[resourceId]).toMatchObject({ versionId: before.versionId, semanticHash: before.semanticHash });
      }
      if (mode === "disabled-chat") {
        expect(outcome.verifiedApplyVersionIds).not.toContain(current.versionId);
        const database = new DatabaseSync(fixture.request.paths.globalDatabase, { readOnly: true });
        try {
          expect(database.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`bubbleId:${id}:bubble-${id}`)?.value)
            .toBe(JSON.stringify({ text: "a final local edit" }));
        } finally { database.close(); }
      }
      return;
    }
    expect(pending.blockedReason).toBeUndefined();
    expect(outcome.verifiedApplyVersionIds).toContain(current.versionId);
    expect(helperMainTesting.finalExportApplyBlockReason(helperChange(current, resourceId), outcome)).toBeNull();
    expect(candidates.map(change => `${change.eventHash}#${change.changeIndex}`)).toEqual([current.versionId]);
    expect(fixture.repository.state.projections[resourceId]).toMatchObject({ versionId: before.versionId, semanticHash: before.semanticHash });
    const prepared = await prepareChanges(fixture.repository, candidates);
    const result = await applyGlobalDatabaseChanges(fixture.request, prepared.prepared);
    expect(result.applied).toEqual([resourceId]);
    markAppliedProjections(fixture.repository, candidates, result.applied, new Set(result.retainedLocal), result.retainedLocalHashes, result.localChatCoreHashes);
    expect(fixture.repository.state.pendingDatabaseChanges).toEqual([]);
    const database = new DatabaseSync(fixture.request.paths.globalDatabase, { readOnly: true });
    try {
      expect(database.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`bubbleId:${id}:bubble-${id}`)?.value)
        .toBe(JSON.stringify({ text: "remote message 3" }));
    } finally { database.close(); }
  });

  it.each([false, true])("acknowledges exact peer captures before migration without retaining an older version ID (legacy observation: %s)", async (legacyObservation) => {
    const fixture = await createFixture();
    const ids = [700, 701, 702, 703].map(composerId);
    const blob = Buffer.from("immutable continuation");
    const blobId = sha256(blob);
    const conversationState = `~${Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(blobId, "hex")]).toString("base64")}`;
    fixture.database.prepare("INSERT INTO cursorDiskKV(key,value) VALUES (?,?)").run(`agentKv:blob:${blobId}`, blob);
    for (const id of ids) {
      insertLiveChat(fixture.database, id, "base", 1, 8);
      fixture.database.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({
        fullConversationHeadersOnly: [{ bubbleId: `bubble-${id}` }], conversationState,
      }), `composerData:${id}`);
    }
    fixture.database.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    const bases = new Map(ids.map(id => [id, fixture.repository.state.tips[`chat/${id}`]![0]!]));
    const peer = await SyncRepository.open(fixture.request.repositoryRoot,
      join(fixture.request.storageRoot, "peer"), PASSPHRASE, MAX_PAYLOAD_BYTES, bases.get(ids[0]!)!.producer!);
    const changes: ResourceSnapshot[] = [];
    for (const id of ids) {
      const source = parsePortableChatSnapshot((await fixture.repository.readVersion(bases.get(id)!.versionId)).content!);
      source.header.lastUpdatedAt = 2;
      source.bubbles[0]!.valueBase64 = Buffer.from(JSON.stringify({ text: "matching changed local body" })).toString("base64");
      const updated: PortableChatSnapshot = {
        schemaVersion: 1, composerId: source.composerId, header: source.header,
        composerData: source.composerData, bubbles: source.bubbles,
      };
      const content = canonicalBytes(updated);
      changes.push({ resourceId: `chat/${id}`, kind: "chat", content, semanticHash: sha256(content),
        parents: [bases.get(id)!.versionId], metadata: { lastUpdatedAt: 2, bubbleCount: 1,
          chatCoreHash: portableChatCoreHash(source), chatSnapshotSchemaVersion: 1 } });
    }
    await peer.publish(changes, []);
    const local = new DatabaseSync(fixture.request.paths.globalDatabase);
    for (const id of ids) {
      local.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ text: "matching changed local body" }), `bubbleId:${id}:bubble-${id}`);
      local.prepare("UPDATE composerHeaders SET lastUpdatedAt=2 WHERE composerId=?").run(id);
    }
    local.close();
    if (legacyObservation) {
      for (const change of changes) {
        const projection = fixture.repository.state.projections[change.resourceId]!;
        projection.semanticHash = change.semanticHash;
        projection.sourceChatCoreHash = portableChatCoreHash(parsePortableChatSnapshot(change.content));
        projection.sourceTimestamp = 2;
      }
      await fixture.repository.saveState();
    }
    fixture.repository.invalidateSharedGraphObservation();
    const count = (await fixture.repository.listEvents()).length;
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    expect((await fixture.repository.listEvents()).length).toBe(count);
    for (const id of ids) {
      const projection = fixture.repository.state.projections[`chat/${id}`]!;
      expect(projection.versionId).not.toBe(bases.get(id)!.versionId);
      expect((await fixture.repository.readVersionMetadata(projection.versionId!)).change.semanticHash).toBe(projection.semanticHash);
    }
    await migrateOfflineChatTips(fixture.repository, fixture.request, async () => {}, () => {});
    const migratedCount = (await fixture.repository.listEvents()).length;
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    expect(fixture.repository.state.conflicts.filter(conflict => conflict.resolvedAt === undefined)).toEqual([]);
    expect((await fixture.repository.listEvents()).length).toBe(migratedCount);
  });

  it.each([false, true])("keeps the published local core acknowledged across merge, migration, and final verification (new edit: %s)", async (changedAfterResolution) => {
    const fixture = await createFixture();
    const ids = [988, 989, 990, 991].map(composerId);
    const blob = Buffer.from("shared immutable continuation");
    const blobId = sha256(blob);
    const conversationState = `~${Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(blobId, "hex")]).toString("base64")}`;
    fixture.database.prepare("INSERT INTO cursorDiskKV(key,value) VALUES (?,?)").run(`agentKv:blob:${blobId}`, blob);
    for (const id of ids) {
      insertLiveChat(fixture.database, id, "base", 1, 8);
      fixture.database.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({
        fullConversationHeadersOnly: [{ bubbleId: `bubble-${id}` }], conversationState,
      }), `composerData:${id}`);
    }
    fixture.database.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    const bases = new Map(ids.map(id => [id, fixture.repository.state.tips[`chat/${id}`]![0]!]));
    const peer = await SyncRepository.open(fixture.request.repositoryRoot,
      join(fixture.request.storageRoot, "peer"), PASSPHRASE, MAX_PAYLOAD_BYTES, bases.get(ids[0]!)!.producer!);
    for (const id of ids) {
      const base = await fixture.repository.readVersion(bases.get(id)!.versionId);
      const source = parsePortableChatSnapshot(base.content!);
      const complete: PortableChatSnapshotV2 = { ...source, schemaVersion: 2,
        agentKv: { blobs: [{ key: `agentKv:blob:${blobId}`, valueBase64: blob.toString("base64"), valueType: "blob" }], referencedIds: [blobId], missingIds: [] } };
      const content = canonicalBytes(complete);
      await peer.publish([{ resourceId: `chat/${id}`, kind: "chat", content, semanticHash: sha256(content),
        parents: [bases.get(id)!.versionId], metadata: { syncOrigin: "agent-kv-enrichment", agentKvEnrichmentAppliesCore: true,
          enrichedFromVersionId: bases.get(id)!.versionId, originalProducer: { ...bases.get(id)!.producer! }, chatCoreHash: portableChatCoreHash(source),
          chatSnapshotSchemaVersion: 2, agentKvBlobCount: 1, agentKvReferencedCount: 1, agentKvMissingCount: 0 } }], []);
    }
    const changed = new DatabaseSync(fixture.request.paths.globalDatabase);
    for (const id of ids) {
      changed.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ text: "last local edit" }), `bubbleId:${id}:bubble-${id}`);
      changed.prepare("UPDATE composerHeaders SET lastUpdatedAt=2 WHERE composerId=?").run(id);
    }
    changed.close();
    fixture.repository.invalidateSharedGraphObservation();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    expect(fixture.repository.state.conflicts.filter(c => c.resolvedAt === undefined)).toHaveLength(ids.length);
    const localTips = ids.map(id => fixture.repository.state.tips[`chat/${id}`]!
      .find(tip => tip.deviceId === fixture.repository.state.device.deviceId)!);
    expect(localTips.some(tip => tip.metadata?.chatSnapshotSchemaVersion === 1)).toBe(true);
    expect(await mergeOfflineChatConflicts(fixture.repository, fixture.request, async () => {}, () => {})).toEqual({ published: ids.length, warnings: [] });
    await migrateOfflineChatTips(fixture.repository, fixture.request, async () => {}, () => {});
    const resolvedVersions = ids.map(id => fixture.repository.state.tips[`chat/${id}`]![0]!.versionId);
    if (changedAfterResolution) {
      const latest = new DatabaseSync(fixture.request.paths.globalDatabase);
      latest.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?")
        .run(JSON.stringify({ text: "a newer local edit after resolution" }), `bubbleId:${ids[0]}:bubble-${ids[0]}`);
      latest.close();
    }
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    const conflicts = fixture.repository.state.conflicts.filter(c => c.resolvedAt === undefined);
    if (changedAfterResolution) {
      expect(conflicts.map(conflict => conflict.resourceId)).toEqual([`chat/${ids[0]}`]);
      const ownVersion = fixture.repository.state.projections[`chat/${ids[0]}`]!.versionId!;
      const local = parsePortableChatSnapshot((await fixture.repository.readVersion(ownVersion)).content!);
      expect(Buffer.from(local.bubbles[0]!.valueBase64, "base64").toString()).toBe(JSON.stringify({ text: "a newer local edit after resolution" }));
      expect(ids.slice(1).map(id => fixture.repository.state.tips[`chat/${id}`]![0]!.versionId)).toEqual(resolvedVersions.slice(1));
    } else {
      expect(conflicts).toEqual([]);
      expect(ids.map(id => fixture.repository.state.tips[`chat/${id}`]![0]!.versionId)).toEqual(resolvedVersions);
    }
  });

  it.each(["missing", "unreadable"])("protects an unpublished local observation when its provenance is %s, including after conflict resolution", async (failure) => {
    const fixture = await createFixture();
    const id = composerId(999);
    const resourceId = `chat/${id}`;
    insertLiveChat(fixture.database, id, "local branch", 2, 16);
    fixture.database.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const original = fixture.repository.state.tips[resourceId]![0]!;
    const remote = portableChatV2(id, "remote branch", 3, "remote message");
    const content = canonicalBytes(remote);
    const metadata = { chatSnapshotSchemaVersion: 2, chatCoreHash: portableChatCoreHash(remote),
      agentKvBlobCount: 0, agentKvReferencedCount: 0, agentKvMissingCount: 0, lastUpdatedAt: 3, bubbleCount: 1 };
    await fixture.repository.publish([{ resourceId, kind: "chat", content, semanticHash: sha256(content), parents: [], metadata }], []);
    const unpublished = portableChatV2(id, "local branch", 2, "unpublished local message");
    const local = new DatabaseSync(fixture.request.paths.globalDatabase);
    local.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?")
      .run(JSON.stringify({ text: "unpublished local message" }), `bubbleId:${id}:bubble-${id}`);
    local.close();
    fixture.repository.state.projections[resourceId]!.semanticHash = sha256(canonicalBytes(unpublished));
    fixture.repository.state.projections[resourceId]!.sourceChatCoreHash = portableChatCoreHash(unpublished);
    await fixture.repository.saveState();
    const read = fixture.repository.readVersionMetadata.bind(fixture.repository);
    vi.spyOn(fixture.repository, "readVersionMetadata").mockImplementation(async version => {
      if (version === original.versionId) {
        throw new Error(failure === "missing" ? "Resource version is unavailable" : "Authenticated source could not be read");
      }
      return read(version);
    });
    const beforeResolution = await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    expect(beforeResolution.protectedLocalResourceIds).toContain(resourceId);
    const resolved = await fixture.repository.publish([{ resourceId, kind: "chat", content, semanticHash: sha256(content),
      parents: fixture.repository.state.tips[resourceId]!.map(tip => tip.versionId), metadata: { ...metadata, syncOrigin: "auto-merge" } }], []);
    new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    fixture.repository.state.pendingDatabaseChanges = [{ resourceId, kind: "chat", eventHash: resolved.eventHash!, changeIndex: 0 }];
    await fixture.repository.saveState();
    const afterResolution = await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    expect(afterResolution.protectedLocalResourceIds).toContain(resourceId);
    expect(helperMainTesting.finalExportApplyBlockReason({ resourceId, kind: "chat" }, afterResolution)).not.toBeNull();
    const verified = new DatabaseSync(fixture.request.paths.globalDatabase, { readOnly: true });
    expect(verified.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`bubbleId:${id}:bubble-${id}`)?.value)
      .toBe(JSON.stringify({ text: "unpublished local message" }));
    verified.close();
  });

  it.each([
    { unchangedTimestamp: false, rememberedUnpublished: false, missingVersion: false },
    { unchangedTimestamp: true, rememberedUnpublished: false, missingVersion: false },
    { unchangedTimestamp: true, rememberedUnpublished: true, missingVersion: false },
    { unchangedTimestamp: true, rememberedUnpublished: true, missingVersion: true },
  ])("publishes the last edit of an existing conflict before offline merge ($unchangedTimestamp / $rememberedUnpublished / $missingVersion)", async ({ unchangedTimestamp, rememberedUnpublished, missingVersion }) => {
    const fixture = await createFixture();
    const id = composerId(998);
    const resourceId = `chat/${id}`;
    insertLiveChat(fixture.database, id, "shared base", 1, 16);
    fixture.database.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const base = fixture.repository.state.tips[resourceId]![0]!;
    const local = new DatabaseSync(fixture.request.paths.globalDatabase);
    local.prepare("UPDATE composerHeaders SET lastUpdatedAt = 2, value = ? WHERE composerId = ?")
      .run(JSON.stringify({ name: "local branch" }), id);
    local.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const previousOwn = fixture.repository.state.tips[resourceId]![0]!;
    const peer = await SyncRepository.open(fixture.request.repositoryRoot,
      join(fixture.request.storageRoot, "peer"), PASSPHRASE, MAX_PAYLOAD_BYTES, previousOwn.producer!);
    const remote = portableChatV2(id, "peer branch", 2, "remote branch message");
    const content = canonicalBytes(remote);
    await peer.publish([{ resourceId, kind: "chat", content, semanticHash: sha256(content),
      parents: [base.versionId], metadata: { chatSnapshotSchemaVersion: 2,
        chatCoreHash: portableChatCoreHash(remote), agentKvBlobCount: 0,
        agentKvReferencedCount: 0, agentKvMissingCount: 0 } }], []);
    fixture.repository.invalidateSharedGraphObservation();
    const before = new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    expect(before.conflicts).toHaveLength(1);
    const peerTip = fixture.repository.state.tips[resourceId]!.find(tip => tip.deviceId === peer.state.device.deviceId)!;
    const changed = new DatabaseSync(fixture.request.paths.globalDatabase);
    if (!unchangedTimestamp) {
      changed.prepare("UPDATE composerHeaders SET lastUpdatedAt = 3 WHERE composerId = ?").run(id);
    }
    const finalText = JSON.stringify({ text: "last local message before shutdown" });
    changed.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run(finalText, `bubbleId:${id}:bubble-${id}`);
    changed.close();
    if (rememberedUnpublished) {
      // v1.0.6 recorded a suppressed conflict scan as though it was durable.
      // The old versionId still points at the previous, different payload.
      const unpublished = portableChatV2(id, "local branch", 2, "last local message before shutdown");
      fixture.repository.state.projections[resourceId]!.semanticHash = sha256(canonicalBytes(unpublished));
      fixture.repository.state.projections[resourceId]!.sourceChatCoreHash = portableChatCoreHash(unpublished);
      if (missingVersion) {
        fixture.repository.state.projections[resourceId]!.versionId = null;
      }
      await fixture.repository.saveState();
    }

    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);

    const tips = fixture.repository.state.tips[resourceId]!;
    expect(tips).toHaveLength(2);
    const finalOwn = tips.find(tip => tip.deviceId === fixture.repository.state.device.deviceId)!;
    expect(finalOwn.versionId).not.toBe(previousOwn.versionId);
    expect(finalOwn.parents).toContain(previousOwn.versionId);
    expect(finalOwn.parents).not.toContain(peerTip.versionId);
    expect(tips.some(tip => tip.versionId === peerTip.versionId)).toBe(true);
    const published = parsePortableChatSnapshot((await fixture.repository.readVersion(finalOwn.versionId)).content!);
    expect(Buffer.from(published.bubbles[0]!.valueBase64, "base64").toString("utf8")).toBe(finalText);
    const head = fixture.repository.state.ownStreamHead;
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    expect(fixture.repository.state.ownStreamHead).toEqual(head);
  });

  it("closes large duplicate forks with the exact complete enrichment contract and applies it once", async () => {
    const fixture = await createFixture(64 * 1024 * 1024);
    fixture.database.close();
    const id = composerId(994);
    const resourceId = `chat/${id}`;
    const source = portableChat(id, "large identical core", 2, "x".repeat(13 * 1024 * 1024));
    const legacy = canonicalBytes(source);
    const complete = canonicalBytes({ ...source, schemaVersion: 2,
      agentKv: { blobs: [], referencedIds: [], missingIds: [] } });
    const publish = async (content: Buffer, parents: string[], metadata = {}) => fixture.repository.publish([{
      resourceId, kind: "chat", content, semanticHash: sha256(content), parents, metadata,
    }], []);
    await publish(legacy, []);
    new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    const base = fixture.repository.state.tips[resourceId]![0]!;
    const metadata = {
      syncOrigin: "agent-kv-enrichment", agentKvEnrichmentAppliesCore: true,
      enrichedFromVersionId: base.versionId,
      originalProducer: base.producer!, chatCoreHash: portableChatCoreHash(source),
      chatSnapshotSchemaVersion: 2, agentKvBlobCount: 0, agentKvReferencedCount: 0, agentKvMissingCount: 0,
    };
    await publish(complete, [base.versionId], metadata);
    await publish(legacy, [base.versionId]);
    await publish(complete, [base.versionId], metadata);
    const before = new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    expect(before.conflicts).toHaveLength(1);
    const parents = fixture.repository.state.tips[resourceId]!.map(tip => tip.versionId).sort();
    expect(mergeChatSnapshotBuffers(legacy, [legacy, complete]).workBudgetExceeded).toBe(true);
    const guard = vi.fn(async () => {});
    expect(await mergeOfflineChatConflicts(fixture.repository, fixture.request, guard, () => {}))
      .toEqual({ published: 1, warnings: [] });
    expect(guard).toHaveBeenCalledTimes(2);
    const tip = fixture.repository.state.tips[resourceId]![0]!;
    expect(tip.parents).toEqual(parents);
    expect(tip.metadata).toMatchObject(metadata);
    expect(tip.metadata).toMatchObject({ chatResolutionStrategy: "merged",
      chatResolutionCoreHash: metadata.chatCoreHash });
    expect(tip.metadata?.chatResolutionOrigin).toHaveProperty("versionId");
    expect(tip.metadata?.chatResolutionOrigin).toHaveProperty("lamport");
    expect(tip.metadata?.chatResolutionOrigin).toHaveProperty("deviceId", fixture.repository.state.device.deviceId);
    expect((await fixture.repository.readVersion(tip.versionId)).content?.equals(complete)).toBe(true);
    expect(fixture.repository.state.pendingDatabaseChanges).toEqual([
      expect.objectContaining({ resourceId, eventHash: tip.eventHash }),
    ]);
    const verified = await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    expect(verified.verifiedApplyVersionIds).toContain(tip.versionId);
    const prepared = await prepareChanges(fixture.repository, [helperChange(tip, resourceId)]);
    expect(prepared.skipped).toEqual([]);
    const applied = await applyGlobalDatabaseChanges(fixture.request, prepared.prepared);
    expect(applied.applied).toEqual([resourceId]);
    const db = new DatabaseSync(fixture.request.paths.globalDatabase, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(source.bubbles[0]!.key)!;
      expect(Buffer.from(String(row.value)).toString("base64")).toBe(source.bubbles[0]!.valueBase64);
      expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
    } finally { db.close(); }
    expect((await mergeOfflineChatConflicts(fixture.repository, fixture.request, guard, () => {})).published).toBe(0);
  }, 60_000);

  it("merges a complete novel union, retains the latest ambiguous version, and preserves protected recipes", async () => {
    for (const mode of ["ambiguous", "novel-union", "protected"] as const) {
      const fixture = await createFixture();
      fixture.database.close();
      const id = composerId(995);
      const first = portableChatV2(id, "first", 2, "retained");
      const second = portableChatV2(id, "second", 2, "retained");
      if (mode === "ambiguous") {
        second.bubbles[0]!.valueBase64 = Buffer.from(JSON.stringify({ text: "latest competing edit" })).toString("base64");
      } else if (mode === "novel-union") {
        first.bubbles.push({ ...first.bubbles[0]!, key: `bubbleId:${id}:extra-a` });
        second.bubbles.push({ ...second.bubbles[0]!, key: `bubbleId:${id}:extra-b` });
      }
      for (const snapshot of [first, second]) {
        const content = canonicalBytes(snapshot);
        await fixture.repository.publish([{ resourceId: `chat/${id}`, kind: "chat", content,
          semanticHash: sha256(content), parents: [],
          metadata: { chatSnapshotSchemaVersion: 2, chatCoreHash: portableChatCoreHash(snapshot),
            agentKvBlobCount: 0, agentKvReferencedCount: 0, agentKvMissingCount: 0,
            ...(mode === "protected" ? { syncOrigin: "version-restore" } : {}) },
        }], []);
      }
      const head = fixture.repository.state.ownStreamHead;
      const result = await mergeOfflineChatConflicts(fixture.repository, fixture.request, async () => {}, () => {});
      if (mode === "protected") {
        expect(result.published).toBe(0);
        expect(fixture.repository.state.ownStreamHead).toEqual(head);
        expect(fixture.repository.state.tips[`chat/${id}`]).toHaveLength(2);
      } else {
        expect(result.published).toBe(1);
        expect(fixture.repository.state.tips[`chat/${id}`]).toHaveLength(1);
        const tip = fixture.repository.state.tips[`chat/${id}`]![0]!;
        const resolved = (await fixture.repository.readVersion(tip.versionId)).content!;
        expect(tip.parents).toHaveLength(2);
        expect(fixture.repository.state.pendingDatabaseChanges[0]?.blockedReason).toBeUndefined();
        expect(tip.metadata?.chatResolutionStrategy).toBe(mode === "ambiguous" ? "latest" : "merged");
        if (mode === "ambiguous") {
          expect(resolved.equals(canonicalBytes(second))).toBe(true);
        } else {
          expect(parsePortableChatSnapshot(resolved).bubbles).toHaveLength(3);
        }
      }
    }
  });

  it("preflights payload bytes and producer versions and aborts if Cursor reopens before publication", async () => {
    const fixture = await createFixture();
    fixture.database.close();
    const id = composerId(996);
    for (const title of ["first", "second"]) {
      const content = canonicalBytes(portableChat(id, title, 2, "retained"));
      await fixture.repository.publish([{ resourceId: `chat/${id}`, kind: "chat", content,
        semanticHash: sha256(content), parents: [],
      }], []);
    }
    const read = vi.spyOn(fixture.repository, "readVersion");
    expect((await mergeOfflineChatConflicts(fixture.repository,
      { ...fixture.request, extensionVersion: "0.0.1" }, async () => {}, () => {})).published).toBe(0);
    expect(read).not.toHaveBeenCalled();
    const originalMetadata = fixture.repository.readVersionMetadata.bind(fixture.repository);
    const metadata = vi.spyOn(fixture.repository, "readVersionMetadata").mockImplementation(async (version) => {
      const value = await originalMetadata(version);
      value.change = { ...value.change, payload: { ...value.change.payload!, plainBytes: 129 * 1024 * 1024 } };
      return value;
    });
    expect((await mergeOfflineChatConflicts(fixture.repository, fixture.request, async () => {}, () => {})).published).toBe(0);
    expect(read).not.toHaveBeenCalled();
    metadata.mockRestore();
    const publish = vi.spyOn(fixture.repository, "publish");
    const guard = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Cursor reopened"));
    await expect(mergeOfflineChatConflicts(fixture.repository, fixture.request, guard, () => {})).rejects.toThrow("Cursor reopened");
    expect(publish).not.toHaveBeenCalled();
  });

  it("only attempts the latest bounded payload when aggregate overflow prevents a merge", async () => {
    const fixture = await createFixture(128 * 1024 * 1024);
    fixture.database.close();
    const id = composerId(997);
    const publish = async (title: string, parents: string[]) => {
      const content = canonicalBytes(portableChat(id, title, 2, "retained"));
      await fixture.repository.publish([{ resourceId: `chat/${id}`, kind: "chat", content,
        semanticHash: sha256(content), parents,
      }], []);
    };
    await publish("base", []);
    new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    const base = fixture.repository.state.tips[`chat/${id}`]![0]!.versionId;
    await publish("first", [base]);
    await publish("second", [base]);
    const original = fixture.repository.readVersionMetadata.bind(fixture.repository);
    vi.spyOn(fixture.repository, "readVersionMetadata").mockImplementation(async version => {
      const value = await original(version);
      return { ...value, change: { ...value.change,
        payload: { ...value.change.payload!, plainBytes: 100 * 1024 * 1024 },
      } };
    });
    const read = vi.spyOn(fixture.repository, "readVersion");
    expect((await mergeOfflineChatConflicts(fixture.repository, fixture.request, async () => {}, () => {})).published).toBe(0);
    // The latest candidate is within the individual limit. Its forged size
    // still fails the authenticated object reader, preserving both forks.
    expect(read).toHaveBeenCalledTimes(1);
    expect(fixture.repository.state.tips[`chat/${id}`]).toHaveLength(2);
  });

  it("exports and restores one chat above the interactive page limit without dropping its core", async () => {
    const source = await createFixture(64 * 1024 * 1024);
    const id = composerId(991);
    insertLiveChat(source.database, id, "large offline chat", 2, 25 * 1024 * 1024);
    source.database.close();
    const exported = await helperMainTesting.exportFinalChanges(source.request, source.repository);
    expect(exported.incompleteKinds).not.toContain("chat");
    const tip = source.repository.state.tips[`chat/${id}`]![0]!;
    expect(tip.payload!.plainBytes).toBeGreaterThan(MAX_HELPER_APPLY_WORK_BYTES);
    expect(tip.metadata).toMatchObject({ chatSnapshotSchemaVersion: 2, agentKvMissingCount: 0 });
    const change = helperChange(tip, `chat/${id}`);
    const prepared = await prepareChanges(source.repository, [change]);
    expect(prepared.prepared).toHaveLength(1);
    expect(prepared.skipped).toEqual([]);
    const target = await createFixture(64 * 1024 * 1024);
    target.database.close();
    const result = await applyGlobalDatabaseChanges(target.request, prepared.prepared);
    expect(result.applied).toEqual([`chat/${id}`]);
    const restored = new DatabaseSync(target.request.paths.globalDatabase, { readOnly: true });
    try {
      expect(restored.prepare("SELECT count(*) AS n FROM composerHeaders WHERE composerId=?").get(id)?.n).toBe(1);
      const value = restored.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`bubbleId:${id}:bubble-${id}`)?.value;
      expect((JSON.parse(String(value)) as { text: string }).text).toHaveLength(25 * 1024 * 1024);
      expect(restored.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
    } finally {
      restored.close();
    }
  }, 60_000);

  it("migrates an interactive-deferred legacy chat and verifies its new target in the same shutdown", async () => {
    const fixture = await createFixture(64 * 1024 * 1024);
    const id = composerId(992);
    const blob = Buffer.alloc(14 * 1024 * 1024, 0x61);
    const blobId = sha256(blob);
    const serializedState = `~${Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(blobId, "hex")]).toString("base64")}`;
    fixture.database.prepare("INSERT INTO cursorDiskKV(key,value) VALUES (?,?)").run(`agentKv:blob:${blobId}`, blob);
    fixture.database.close();
    const source = portableChat(id, "legacy large source", 2, "x".repeat(13 * 1024 * 1024));
    source.composerData.valueBase64 = Buffer.from(JSON.stringify({ conversationState: serializedState })).toString("base64");
    const content = canonicalBytes(source);
    await fixture.repository.publish([{
      resourceId: `chat/${id}`, kind: "chat", content, semanticHash: sha256(content), parents: [],
      metadata: { chatSnapshotSchemaVersion: 1, bubbleCount: 1 },
    }], []);
    new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    const interactive = await enrichCurrentChatTipsFromLiveDatabase(fixture.repository, fixture.request.paths.globalDatabase, {
      cursor: { afterResourceId: null }, maxPayloadBytes: fixture.request.syncOptions.maxPayloadBytes,
    });
    expect(interactive.published).toBe(0);
    const before = vi.fn(async () => {});
    const migrated = await migrateOfflineChatTips(fixture.repository, fixture.request, before, () => {});
    expect(migrated).toEqual({ published: 1, warnings: [] });
    expect(before).toHaveBeenCalledOnce();
    const tip = fixture.repository.state.tips[`chat/${id}`]![0]!;
    expect(tip.payload!.plainBytes).toBeGreaterThan(MAX_HELPER_APPLY_WORK_BYTES);
    expect(tip.metadata).toMatchObject({ chatSnapshotSchemaVersion: 2, agentKvMissingCount: 0, agentKvEnrichmentAppliesCore: true });
    expect(fixture.repository.state.pendingDatabaseChanges).toEqual([expect.objectContaining({ resourceId: `chat/${id}` })]);
    const verified = await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository, () => {}, true);
    expect(verified.verifiedApplyVersionIds).toContain(tip.versionId);
    const preparation = await prepareChanges(fixture.repository, [helperChange(tip, `chat/${id}`)]);
    expect(preparation.skipped).toEqual([]);
    const applied = await applyGlobalDatabaseChanges(fixture.request, preparation.prepared);
    expect(applied.applied).toEqual([`chat/${id}`]);
    const reread = new DatabaseSync(fixture.request.paths.globalDatabase, { readOnly: true });
    try {
      expect(reread.prepare("SELECT count(*) AS n FROM composerHeaders WHERE composerId=?").get(id)?.n).toBe(1);
      const storedBlob = reread.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`agentKv:blob:${blobId}`)?.value;
      expect(sha256(Buffer.from(storedBlob as Uint8Array))).toBe(blobId);
    } finally { reread.close(); }
    expect((await migrateOfflineChatTips(fixture.repository, fixture.request, before, () => {})).published).toBe(0);
  }, 60_000);

  it("does not migrate newer producer data or continue after the closed-Cursor check fails", async () => {
    const fixture = await createFixture();
    fixture.database.close();
    const id = composerId(993);
    const content = canonicalBytes(portableChat(id, "version gate", 1, "retained source"));
    await fixture.repository.publish([{
      resourceId: `chat/${id}`, kind: "chat", content, semanticHash: sha256(content), parents: [],
      metadata: { chatSnapshotSchemaVersion: 1 },
    }], []);
    new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    const head = fixture.repository.state.ownStreamHead;
    const before = vi.fn(async () => {});
    const older = { ...fixture.request, extensionVersion: "0.0.62" };
    expect(await migrateOfflineChatTips(fixture.repository, older, before, () => {})).toEqual({ published: 0, warnings: [] });
    expect(before).not.toHaveBeenCalled();
    await expect(migrateOfflineChatTips(fixture.repository, fixture.request, async () => {
      throw new Error("Cursor reopened");
    }, () => {})).rejects.toThrow("Cursor reopened");
    expect(fixture.repository.state.ownStreamHead).toEqual(head);
    expect(fixture.repository.state.pendingDatabaseChanges).toEqual([]);
  });

  it("recaptures an own legacy body edit even when its header and row count are unchanged", async () => {
    const fixture = await createFixture();
    const id = composerId(994);
    insertLiveChat(fixture.database, id, "unchanged header", 2, 10);
    const source = portableChat(id, "unchanged header", 2, "x".repeat(10));
    const content = canonicalBytes(source);
    await fixture.repository.publish([{
      resourceId: `chat/${id}`, kind: "chat", content, semanticHash: sha256(content), parents: [],
      metadata: { chatSnapshotSchemaVersion: 1, chatCoreHash: portableChatCoreHash(source), bubbleCount: 1, lastUpdatedAt: 2 },
    }], []);
    new EventReconciler().reconcile(await fixture.repository.listEvents(), fixture.repository.state, null);
    const original = fixture.repository.state.tips[`chat/${id}`]![0]!;
    fixture.repository.state.projections[`chat/${id}`] = {
      resourceId: `chat/${id}`, kind: "chat", versionId: original.versionId,
      semanticHash: original.semanticHash, sourceTimestamp: 2, sourceBubbleCount: 1,
      sourceChatCoreHash: portableChatCoreHash(source),
    };
    fixture.database.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ text: "edited body" }), `bubbleId:${id}:bubble-${id}`);
    fixture.database.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const updated = fixture.repository.state.tips[`chat/${id}`]![0]!;
    expect(updated.versionId).not.toBe(original.versionId);
    expect(updated.metadata?.chatCoreHash).not.toBe(original.metadata?.chatCoreHash);
    expect(fixture.repository.state.conflicts.filter((conflict) => conflict.resolvedAt === undefined)).toEqual([]);
  });

  it("checks the last same-count body edit of a recent complete chat at shutdown", async () => {
    const fixture = await createFixture();
    const id = composerId(995);
    insertLiveChat(fixture.database, id, "recent complete chat", 2, 10);
    fixture.database.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const original = fixture.repository.state.tips[`chat/${id}`]![0]!;
    expect(original.metadata?.chatSnapshotSchemaVersion).toBe(2);
    const edit = new DatabaseSync(fixture.request.paths.globalDatabase);
    edit.prepare("UPDATE cursorDiskKV SET value=? WHERE key=?").run(JSON.stringify({ text: "final body" }), `bubbleId:${id}:bubble-${id}`);
    edit.close();
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const updated = fixture.repository.state.tips[`chat/${id}`]![0]!;
    expect(updated.versionId).not.toBe(original.versionId);
    expect(updated.metadata?.lastUpdatedAt).toBe(original.metadata?.lastUpdatedAt);
    expect(updated.metadata?.bubbleCount).toBe(original.metadata?.bubbleCount);
  });

  it("publishes a same-mtime local Cursor-file edit before a queued peer tip can overwrite it", async () => {
    const fixture = await createFixture();
    const relativePath = "rules/same.md";
    const resourceId = `cursor-user-file/${encodeURIComponent(relativePath)}`;
    const target = join(fixture.request.paths.cursorHome, "rules", "same.md");
    await mkdir(join(fixture.request.paths.cursorHome, "rules"), {
      recursive: true,
    });
    await writeFile(target, "local-old", "utf8");
    const originalTime = (await stat(target)).mtime;
    fixture.database.close();

    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const reconciler = new EventReconciler();
    let reconciled = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    const baseTip = reconciled.projections.find(
      (projection) => projection.resourceId === resourceId,
    )?.tip;
    if (baseTip === undefined) {
      throw new Error("Expected the initial Cursor file export.");
    }

    const peerContent = Buffer.from("peer-new!", "utf8");
    const peerPublish = await fixture.repository.publish(
      [
        {
          resourceId,
          kind: "cursor-user-file",
          content: peerContent,
          semanticHash: sha256(peerContent),
          parents: [baseTip.versionId],
          metadata: {
            relativePath,
            lastUpdatedAt: originalTime.getTime(),
          },
        },
      ],
      [],
    );
    const peerVersionId = `${peerPublish.eventHash ?? ""}#0`;

    await writeFile(target, "local-new", "utf8");
    await utimes(target, originalTime, originalTime);
    const outcome = await helperMainTesting.exportFinalChanges(
      fixture.request,
      fixture.repository,
    );

    reconciled = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    expect(outcome.incompleteKinds).not.toContain("cursor-user-file");
    expect(reconciled.conflicts.some((item) => item.resourceId === resourceId)).toBe(
      true,
    );
    expect(
      (fixture.repository.state.tips[resourceId] ?? []).some(
        (tip) =>
          tip.versionId !== peerVersionId &&
          tip.semanticHash === sha256(Buffer.from("local-new", "utf8")),
      ),
    ).toBe(true);
    expect(await readFile(target, "utf8")).toBe("local-new");
  });

  it("force-verifies a same-mtime transcript target before queued whole-file apply", async () => {
    const fixture = await createFixture();
    const relativePath = "project/agent-transcripts/session/session.jsonl";
    const resourceId = `chat-transcript/${encodeURIComponent(relativePath)}`;
    const target = join(
      fixture.request.paths.cursorProjects,
      ...relativePath.split("/"),
    );
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "local-old", "utf8");
    const originalTime = (await stat(target)).mtime;
    fixture.database.close();

    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const baseTip = fixture.repository.state.tips[resourceId]?.[0];
    if (baseTip === undefined) {
      throw new Error("Expected the initial transcript export.");
    }
    const peerContent = Buffer.from("peer-new!", "utf8");
    const peerPublish = await fixture.repository.publish(
      [
        {
          resourceId,
          kind: "chat-transcript",
          content: peerContent,
          semanticHash: sha256(peerContent),
          parents: [baseTip.versionId],
          metadata: {
            relativePath,
            projectSlug: "project",
            lastUpdatedAt: originalTime.getTime(),
          },
        },
      ],
      [],
    );
    const peerVersionId = `${peerPublish.eventHash ?? ""}#0`;

    await writeFile(target, "local-new", "utf8");
    await utimes(target, originalTime, originalTime);
    const outcome = await helperMainTesting.exportFinalChanges(
      fixture.request,
      fixture.repository,
    );

    expect(outcome.incompleteKinds).not.toContain("chat-transcript");
    expect(
      (fixture.repository.state.tips[resourceId] ?? []).some(
        (tip) =>
          tip.versionId !== peerVersionId &&
          tip.semanticHash === sha256(Buffer.from("local-new", "utf8")),
      ),
    ).toBe(true);
    expect(await readFile(target, "utf8")).toBe("local-new");
  });

  it("force-verifies a same-mtime store target before queued key merge", async () => {
    const fixture = await createFixture();
    const relativePath = "chats/session/store.db";
    const resourceId = `chat-store/${encodeURIComponent(relativePath)}`;
    const target = join(fixture.request.paths.cursorHome, ...relativePath.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    const store = new DatabaseSync(target);
    store.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value)");
    store.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data)");
    store
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?)")
      .run("edited", "local-old");
    store.close();
    const originalStat = await stat(target);
    fixture.database.close();

    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const baseTip = fixture.repository.state.tips[resourceId]?.[0];
    if (baseTip === undefined) {
      throw new Error("Expected the initial store export.");
    }
    const peerSnapshot: PortableStoreSnapshot = {
      schemaVersion: 1,
      relativePath,
      meta: [
        { key: "edited", value: { type: "text", value: "peer-new!" } },
      ],
      blobs: [],
    };
    const peerContent = canonicalBytes(peerSnapshot);
    const peerPublish = await fixture.repository.publish(
      [
        {
          resourceId,
          kind: "chat-store",
          content: peerContent,
          semanticHash: sha256(peerContent),
          parents: [baseTip.versionId],
          metadata: {
            relativePath,
            lastUpdatedAt: originalStat.mtimeMs,
          },
        },
      ],
      [],
    );
    const peerVersionId = `${peerPublish.eventHash ?? ""}#0`;
    const rewrittenStore = new DatabaseSync(target);
    rewrittenStore
      .prepare("UPDATE meta SET value = ? WHERE key = ?")
      .run("local-new", "edited");
    rewrittenStore.close();
    expect((await stat(target)).size).toBe(originalStat.size);
    await utimes(target, originalStat.mtime, originalStat.mtime);
    const localSnapshot: PortableStoreSnapshot = {
      schemaVersion: 1,
      relativePath,
      meta: [
        { key: "edited", value: { type: "text", value: "local-new" } },
      ],
      blobs: [],
    };
    const localHash = sha256(canonicalBytes(localSnapshot));

    const outcome = await helperMainTesting.exportFinalChanges(
      fixture.request,
      fixture.repository,
    );

    expect(outcome.incompleteKinds).not.toContain("chat-store");
    expect(
      (fixture.repository.state.tips[resourceId] ?? []).some(
        (tip) => tip.versionId !== peerVersionId && tip.semanticHash === localHash,
      ),
    ).toBe(true);
    const verifiedStore = new DatabaseSync(target, { readOnly: true });
    expect(
      verifiedStore
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get("edited")?.value,
    ).toBe("local-new");
    verifiedStore.close();
  });

  it("keeps a repair recapture request until a published tip acknowledges it", () => {
    const resourceId = `chat/${composerId(699)}`;
    const persistent = {
      [resourceId]: {
        resourceId,
        kind: "chat" as const,
        semanticHash: "a".repeat(64),
        versionId: `${"b".repeat(64)}#0`,
        requiresAgentKvRecapture: true,
      },
    };
    const provisional = {
      [resourceId]: {
        resourceId,
        kind: "chat" as const,
        semanticHash: "a".repeat(64),
        versionId: `${"b".repeat(64)}#0`,
        sourceTimestamp: 1,
        sourceBubbleCount: 1,
      },
    };

    // A conflict/oversize filter may create a provisional observation without
    // publishing it. Only the final reconcile of an actually published
    // ordinary recapture is allowed to replace and clear the persistent flag.
    helperMainTesting.rememberLearnedChatProjectionSources(
      persistent,
      provisional,
    );

    expect(persistent[resourceId]?.requiresAgentKvRecapture).toBe(true);
  });

  it("publishes a newer local edit instead of applying a stale queued synthetic tip", async () => {
    const fixture = await createFixture();
    const id = composerId(700);
    const resourceId = `chat/${id}`;
    insertLiveChat(fixture.database, id, "local base", 1, 32);
    fixture.database.close();

    // Establish the exact local projection the synthetic operation was queued
    // against, just as a prior extension-host scan would have done.
    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const reconciler = new EventReconciler();
    let reconciled = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    const baseTip = reconciled.projections.find(
      (projection) => projection.resourceId === resourceId,
    )?.tip;
    if (baseTip === undefined) {
      throw new Error("Expected the exported local base tip.");
    }

    const synthetic = portableChat(id, "queued restore", 2, "restored");
    const syntheticContent = canonicalBytes(synthetic);
    const syntheticPublish = await fixture.repository.publish(
      [
        {
          resourceId,
          kind: "chat",
          content: syntheticContent,
          semanticHash: sha256(syntheticContent),
          parents: [baseTip.versionId],
          metadata: {
            composerId: id,
            workspaceId: null,
            lastUpdatedAt: 2,
            bubbleCount: 1,
            syncOrigin: "version-restore",
            originalProducer: {
              extensionVersion: "0.0.63",
              cursorVersion: "3.11.19",
              vscodeVersion: "1.125.0",
            },
          },
        },
      ],
      [],
    );
    const syntheticVersionId = `${syntheticPublish.eventHash ?? ""}#0`;
    reconciled = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    expect(
      reconciled.projections.find(
        (projection) => projection.resourceId === resourceId,
      )?.tip.versionId,
    ).toBe(syntheticVersionId);
    // Simulate a rebuilt/missing local projection. The live database itself is
    // still authoritative evidence of drift and must not be suppressed merely
    // because the helper has no prior semantic hash to compare against.
    delete fixture.repository.state.projections[resourceId];
    await fixture.repository.saveState();

    // The user keeps chatting after the restore/merge was queued but before
    // Cursor exits. Final export must parent and publish this newer local form;
    // suppressing it would let the stale synthetic payload overwrite it later
    // in the same helper invocation.
    const database = new DatabaseSync(fixture.request.paths.globalDatabase);
    database
      .prepare(
        "UPDATE composerHeaders SET lastUpdatedAt = ?, value = ? WHERE composerId = ?",
      )
      .run(3, JSON.stringify({ name: "local after queue" }), id);
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run(
        JSON.stringify({ text: "local-after-queue" }),
        `bubbleId:${id}:bubble-${id}`,
      );
    database.close();

    const outcome = await helperMainTesting.exportFinalChanges(
      fixture.request,
      fixture.repository,
    );
    expect(outcome.protectedLocalResourceIds).not.toContain(resourceId);

    const final = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    // With the projection deliberately removed above, the final local export
    // cannot prove ancestry and must remain as a safe conflict.  The important
    // postcondition is that the stale synthetic tip is no longer eligible to
    // overwrite the live database in this helper run.
    expect(final.conflicts).toHaveLength(1);
    const finalTip = (fixture.repository.state.tips[resourceId] ?? []).find(
      (tip) => tip.metadata?.title === "local after queue",
    );
    expect(finalTip?.metadata?.title).toBe("local after queue");
    const syntheticChange = helperChange(
      (fixture.repository.state.tips[resourceId] ?? []).find(
        (tip) => tip.versionId === syntheticVersionId,
      ) ?? (() => {
        throw new Error("Expected the queued synthetic tip to remain visible.");
      })(),
      resourceId,
    );
    expect(
      helperMainTesting.isEligible(
        syntheticChange,
        final.projections,
        final.conflicts,
      ),
    ).toBe(false);
    if (finalTip?.payload === undefined) {
      throw new Error("Expected the final local chat payload.");
    }
    const finalSnapshot = parsePortableChatSnapshot(
      await fixture.repository.readObject(finalTip.payload),
    );
    expect(finalSnapshot.header.value).toContain("local after queue");
    expect(
      Buffer.from(finalSnapshot.bubbles[0]?.valueBase64 ?? "", "base64").toString(
        "utf8",
      ),
    ).toContain("local-after-queue");
  });

  it("force-verifies same-count local drift before an explicit restart apply", async () => {
    const fixture = await createFixture();
    const id = composerId(701);
    const resourceId = `chat/${id}`;
    insertLiveChat(fixture.database, id, "stable header", 1, 16);
    fixture.database.close();

    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const reconciler = new EventReconciler();
    let reconciled = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    const baseTip = reconciled.projections.find(
      (projection) => projection.resourceId === resourceId,
    )?.tip;
    if (baseTip === undefined) {
      throw new Error("Expected the exported local base tip.");
    }

    const queued = portableChat(id, "queued remote", 2, "remote overwrite");
    const content = canonicalBytes(queued);
    const published = await fixture.repository.publish(
      [
        {
          resourceId,
          kind: "chat",
          content,
          semanticHash: sha256(content),
          parents: [baseTip.versionId],
          metadata: {
            composerId: id,
            workspaceId: null,
            lastUpdatedAt: 2,
            bubbleCount: 1,
            syncOrigin: "version-restore",
            originalProducer: {
              extensionVersion: "0.0.63",
              cursorVersion: "3.11.19",
              vscodeVersion: "1.125.0",
            },
          },
        },
      ],
      [],
    );
    const queuedVersionId = `${published.eventHash ?? ""}#0`;
    reconciled = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    const queuedTip = reconciled.projections.find(
      (projection) => projection.resourceId === resourceId,
    )?.tip;
    expect(queuedTip?.versionId).toBe(queuedVersionId);

    // Keep the exact timestamp, header and row count. Only a forced body hash
    // can observe this last local edit; the ordinary shutdown fast path must
    // not let the queued restore replace it.
    const localValue = JSON.stringify({ text: "y".repeat(16) });
    const database = new DatabaseSync(fixture.request.paths.globalDatabase);
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run(localValue, `bubbleId:${id}:bubble-${id}`);
    database.close();
    fixture.request.mode = "apply-and-restart";
    fixture.request.changes = [
      helperChange(
        queuedTip ?? (() => {
          throw new Error("Expected the queued restore tip.");
        })(),
        resourceId,
      ),
    ];

    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const final = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    expect(final.conflicts).toHaveLength(1);
    expect(
      helperMainTesting.isEligible(
        fixture.request.changes[0]!,
        final.projections,
        final.conflicts,
      ),
    ).toBe(false);
    const readOnly = new DatabaseSync(fixture.request.paths.globalDatabase, {
      readOnly: true,
    });
    try {
      expect(
        readOnly
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .get(`bubbleId:${id}:bubble-${id}`),
      ).toEqual({ value: localValue });
    } finally {
      readOnly.close();
    }
  });

  it("publishes a same-hash ordinary recapture after an applied repair", async () => {
    const fixture = await createFixture();
    const id = composerId(702);
    const resourceId = `chat/${id}`;
    insertLiveChat(fixture.database, id, "repaired locally", 1, 16);
    fixture.database.close();

    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const reconciler = new EventReconciler();
    let reconciled = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    const baseTip = reconciled.projections.find(
      (projection) => projection.resourceId === resourceId,
    )?.tip;
    if (baseTip?.payload === undefined) {
      throw new Error("Expected the initial chat payload.");
    }
    const content = await fixture.repository.readObject(baseTip.payload);
    const repair = await fixture.repository.publish(
      [
        {
          resourceId,
          kind: "chat",
          content,
          semanticHash: baseTip.semanticHash,
          parents: [baseTip.versionId],
          metadata: {
            ...(baseTip.metadata ?? {}),
            syncOrigin: "automatic-chat-repair",
            repairOriginDeviceId:
              fixture.repository.state.device.deviceId,
            repairFingerprint: "applied-repair-fingerprint",
          },
        },
      ],
      [],
    );
    const repairVersionId = `${repair.eventHash ?? ""}#0`;
    reconciled = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    const repairTip = reconciled.projections.find(
      (projection) => projection.resourceId === resourceId,
    )?.tip;
    expect(repairTip?.versionId).toBe(repairVersionId);
    fixture.repository.state.projections[resourceId] = {
      resourceId,
      kind: "chat",
      semanticHash: repairTip!.semanticHash,
      versionId: repairVersionId,
      ...(repairTip?.payload === undefined
        ? {}
        : { payloadObjectId: repairTip.payload.objectId }),
      sourceTimestamp: 1,
      sourceBubbleCount: 1,
      ...(typeof repairTip?.metadata?.chatCoreHash === "string"
        ? { sourceChatCoreHash: repairTip.metadata.chatCoreHash }
        : {}),
      requiresAgentKvRecapture: true,
    };
    await fixture.repository.saveState();

    await helperMainTesting.exportFinalChanges(fixture.request, fixture.repository);
    const final = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    expect(final.conflicts).toEqual([]);
    const finalTip = final.projections.find(
      (projection) => projection.resourceId === resourceId,
    )?.tip;
    expect(finalTip?.parents).toEqual([repairVersionId]);
    expect(finalTip?.semanticHash).toBe(repairTip?.semanticHash);
    expect(finalTip?.metadata?.syncOrigin).toBe("agent-kv-recapture");
    expect(
      fixture.repository.state.projections[resourceId]
        ?.requiresAgentKvRecapture,
    ).toBeUndefined();
  });

  it("drains every feasible page and protects an oversized local chat from queued apply", async () => {
    const fixture = await createFixture();
    const hugeComposerId = composerId(999);
    const laterComposerId = composerId(SMALL_CHAT_COUNT - 1);
    insertLiveChat(
      fixture.database,
      hugeComposerId,
      "local oversized",
      10_000,
      2 * 1024 * 1024,
    );
    for (let index = 0; index < SMALL_CHAT_COUNT; index += 1) {
      insertLiveChat(
        fixture.database,
        composerId(index),
        `local ${index}`,
        9_999 - index,
        SMALL_BUBBLE_BYTES,
      );
    }
    fixture.database.close();

    // These are the queued incoming values the shutdown helper received before
    // its definitive local export. The oldest small local edit sits beyond the
    // first 32 body captures and the aggregate 8 MiB page, while the huge local
    // value can never fit this repository's one-payload policy.
    const remoteSnapshots = [
      portableChat(hugeComposerId, "remote oversized", 1, "remote huge"),
      portableChat(laterComposerId, "remote later", 1, "remote later"),
    ].map((snapshot) => {
      const content = canonicalBytes(snapshot);
      return {
        resourceId: `chat/${snapshot.composerId}`,
        kind: "chat" as const,
        content,
        semanticHash: sha256(content),
        metadata: {
          composerId: snapshot.composerId,
          workspaceId: null,
          lastUpdatedAt: snapshot.header.lastUpdatedAt,
          bubbleCount: snapshot.bubbles.length,
        },
      };
    });
    const remotePublish = await fixture.repository.publish(remoteSnapshots, []);
    const reconciler = new EventReconciler();
    const before = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    await fixture.repository.saveState();
    const remoteChanges = before.projections.map((projection) =>
      helperChange(projection.tip, projection.resourceId),
    );
    const remoteHuge = requiredChange(remoteChanges, `chat/${hugeComposerId}`);
    const remoteLater = requiredChange(remoteChanges, `chat/${laterComposerId}`);
    expect(remoteHuge.eventHash).toBe(remotePublish.eventHash);
    expect(remoteLater.eventHash).toBe(remotePublish.eventHash);

    const outcome = await helperMainTesting.exportFinalChanges(
      fixture.request,
      fixture.repository,
    );

    expect(outcome.incompleteKinds).toEqual([]);
    expect(outcome.protectedLocalResourceIds).toContain(
      `chat/${hugeComposerId}`,
    );
    expect(
      outcome.warnings.some(
        (warning) =>
          warning.includes(`chat/${hugeComposerId}`) &&
          warning.includes("above the 1.0 MiB limit"),
      ),
    ).toBe(true);
    expect(
      helperMainTesting.finalExportApplyBlockReason(remoteHuge, outcome),
    ).not.toBeNull();

    const after = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    expect(
      helperMainTesting.isEligible(remoteLater, after.projections, after.conflicts),
    ).toBe(false);

    // Every feasible local chat, including the one deferred behind both scan
    // limits on pass one, was published and acknowledged during this same
    // helper invocation. Reading the active objects also detects duplicate or
    // stale remote publication hidden by a resource-count-only assertion.
    for (let index = 0; index < SMALL_CHAT_COUNT; index += 1) {
      const resourceId = `chat/${composerId(index)}`;
      const localTips = (fixture.repository.state.tips[resourceId] ?? []).filter(
        (tip) => tip.metadata?.title === `local ${index}`,
      );
      expect(localTips, resourceId).toHaveLength(1);
      const localTip = localTips[0];
      expect(localTip?.operation, resourceId).toBe("put");
      if (localTip?.payload === undefined) {
        throw new Error(`Expected an active payload for ${resourceId}.`);
      }
      const snapshot = parsePortableChatSnapshot(
        await fixture.repository.readObject(localTip.payload),
      );
      expect(snapshot.header.value, resourceId).toContain(`local ${index}`);
      expect(snapshot.bubbles, resourceId).toHaveLength(1);
    }

    // The unpublishable local chat remains represented by the older remote tip
    // in the repository, but the exact-ID protection prevents that queued tip
    // from overwriting the newer local SQLite value in the apply phase.
    const hugeProjection = after.projections.find(
      (candidate) => candidate.resourceId === `chat/${hugeComposerId}`,
    );
    expect(hugeProjection?.tip.versionId).toBe(
      before.projections.find(
        (candidate) => candidate.resourceId === `chat/${hugeComposerId}`,
      )?.tip.versionId,
    );
  }, 120_000);

  it("drains more than 32 header pages while keeping an incomplete queued chat blocked", async () => {
    const fixture = await createFixture();
    const fillerCount = MAX_CHAT_HEADER_METADATA_ROWS_PER_PAGE * 32 + 1;
    const insert = fixture.database.prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, NULL, 1, ?, 0, 1, 0, NULL, '{}')`,
    );
    fixture.database.exec("BEGIN");
    try {
      for (let index = 0; index < fillerCount; index += 1) {
        insert.run(composerId(100_000 + index), 100_000 - index);
      }
      fixture.database.exec("COMMIT");
    } catch (error) {
      fixture.database.exec("ROLLBACK");
      throw error;
    }
    fixture.database.close();

    const complete = portableChatV2(
      composerId(900_001),
      "complete remote",
      2,
      "complete",
    );
    const missingId = "d".repeat(64);
    const incomplete = portableChatV2(
      composerId(900_002),
      "incomplete remote",
      2,
      "incomplete",
      [missingId],
    );
    const publish = await fixture.repository.publish(
      [complete, incomplete].map((snapshot) => {
        const content = canonicalBytes(snapshot);
        return {
          resourceId: `chat/${snapshot.composerId}`,
          kind: "chat" as const,
          content,
          semanticHash: sha256(content),
          metadata: {
            composerId: snapshot.composerId,
            workspaceId: null,
            lastUpdatedAt: snapshot.header.lastUpdatedAt,
            bubbleCount: snapshot.bubbles.length,
            chatSnapshotSchemaVersion: 2,
            agentKvBlobCount: snapshot.agentKv.blobs.length,
            agentKvReferencedCount: snapshot.agentKv.referencedIds.length,
            agentKvMissingCount: snapshot.agentKv.missingIds.length,
            chatCoreHash: portableChatCoreHash(snapshot),
          },
        };
      }),
      [],
    );
    const reconciler = new EventReconciler();
    const before = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    const completeResourceId = `chat/${complete.composerId}`;
    const incompleteResourceId = `chat/${incomplete.composerId}`;
    const completeProjection = before.projections.find(
      (candidate) => candidate.resourceId === completeResourceId,
    );
    const incompleteProjection = before.projections.find(
      (candidate) => candidate.resourceId === incompleteResourceId,
    );
    if (completeProjection === undefined || incompleteProjection === undefined) {
      throw new Error("Expected both queued chat projections.");
    }
    expect(completeProjection.tip.eventHash).toBe(publish.eventHash);
    expect(incompleteProjection.tip.eventHash).toBe(publish.eventHash);
    fixture.repository.state.pendingDatabaseChanges = [
      completeProjection,
      incompleteProjection,
    ].map((projection) => ({
      eventHash: projection.tip.eventHash,
      changeIndex: projection.tip.changeIndex,
      resourceId: projection.resourceId,
      kind: "chat" as const,
    }));
    await fixture.repository.saveState();

    const outcome = await helperMainTesting.exportFinalChanges(
      fixture.request,
      fixture.repository,
    );

    expect(outcome.incompleteKinds).not.toContain("chat");
    expect(
      outcome.warnings.some((warning) =>
        warning.includes("final state-vscdb-chat export remained incomplete"),
      ),
    ).toBe(false);
    expect(outcome.verifiedApplyVersionIds).toContain(
      completeProjection.tip.versionId,
    );
    const after = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    const eligible = helperMainTesting.shutdownApplyBatch(
      fixture.repository,
      after.projections,
    );
    expect(eligible.map((change) => change.resourceId)).toEqual([
      completeResourceId,
    ]);
    const preparation = await prepareChanges(fixture.repository, eligible);
    expect(preparation.prepared.map((item) => item.change.resourceId)).toEqual([
      completeResourceId,
    ]);
    expect(preparation.skipped).toEqual([]);
    expect(
      fixture.repository.state.pendingDatabaseChanges.some(
        (pending) => pending.resourceId === incompleteResourceId,
      ),
    ).toBe(true);
  }, 120_000);

  it("keeps a present malformed forced target blocked and exits after 32 stagnant passes", async () => {
    const fixture = await createFixture();
    const id = composerId(925_000);
    const resourceId = `chat/${id}`;
    fixture.database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, NULL, 1, 1, 0, 'malformed', 0, NULL, '{}')`,
      )
      .run(id);
    fixture.database.close();

    const remote = portableChatV2(id, "remote target", 2, "remote");
    const content = canonicalBytes(remote);
    await fixture.repository.publish(
      [
        {
          resourceId,
          kind: "chat",
          content,
          semanticHash: sha256(content),
          metadata: {
            composerId: id,
            workspaceId: null,
            lastUpdatedAt: remote.header.lastUpdatedAt,
            bubbleCount: remote.bubbles.length,
            chatSnapshotSchemaVersion: 2,
            agentKvBlobCount: remote.agentKv.blobs.length,
            agentKvReferencedCount: remote.agentKv.referencedIds.length,
            agentKvMissingCount: remote.agentKv.missingIds.length,
            chatCoreHash: portableChatCoreHash(remote),
          },
        },
      ],
      [],
    );
    const reconciler = new EventReconciler();
    const before = reconciler.reconcile(
      await fixture.repository.listEvents(),
      fixture.repository.state,
      null,
    );
    const projection = before.projections.find(
      (candidate) => candidate.resourceId === resourceId,
    );
    if (projection === undefined) {
      throw new Error("Expected the queued malformed-target projection.");
    }
    fixture.repository.state.pendingDatabaseChanges = [
      {
        eventHash: projection.tip.eventHash,
        changeIndex: projection.tip.changeIndex,
        resourceId,
        kind: "chat",
      },
    ];
    await fixture.repository.saveState();
    const heartbeat = vi.fn();

    const outcome = await helperMainTesting.exportFinalChanges(
      fixture.request,
      fixture.repository,
      heartbeat,
    );

    expect(outcome.incompleteKinds).toContain("chat");
    expect(outcome.protectedLocalResourceIds).toContain(resourceId);
    expect(
      outcome.warnings.some(
        (warning) =>
          warning.includes("final state-vscdb-chat export remained incomplete") &&
          warning.includes("32 consecutive no-progress passes"),
      ),
    ).toBe(true);
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(32);
    expect(heartbeat.mock.calls.length).toBeLessThan(40);
    expect(
      fixture.repository.state.pendingDatabaseChanges.some(
        (pending) => pending.resourceId === resourceId,
      ),
    ).toBe(true);
  }, 30_000);

  it("fails closed after 32 stagnant passes for a permanent oversized overflow", async () => {
    const fixture = await createFixture();
    fixture.request.syncOptions.maxPayloadBytes = 1024;
    const insert = fixture.database.prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, NULL, 1, ?, 0, 0, 0, NULL,
        replace(hex(zeroblob(2048)), '00', 'h'))`,
    );
    fixture.database.exec("BEGIN");
    try {
      for (let index = 0; index <= MAX_CHAT_OVERSIZED_SETTLEMENTS; index += 1) {
        insert.run(composerId(950_000 + index), 950_000 - index);
      }
      fixture.database.exec("COMMIT");
    } catch (error) {
      fixture.database.exec("ROLLBACK");
      throw error;
    }
    fixture.database.close();
    const heartbeat = vi.fn();

    const outcome = await helperMainTesting.exportFinalChanges(
      fixture.request,
      fixture.repository,
      heartbeat,
    );

    expect(outcome.incompleteKinds).toContain("chat");
    expect(
      outcome.warnings.some(
        (warning) =>
          warning.includes("final state-vscdb-chat export remained incomplete") &&
          warning.includes("32 consecutive no-progress passes"),
      ),
    ).toBe(true);
    expect(heartbeat.mock.calls.length).toBeLessThan(100);
  }, 30_000);

  it("drains bounded transcript pages and releases each page before continuing", async () => {
    const fixture = await createFixture();
    fixture.database.close();
    const transcriptIds: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const relativePath = `project/agent-transcripts/session-${index}/session-${index}.jsonl`;
      const path = join(
        fixture.request.paths.cursorProjects,
        ...relativePath.split("/"),
      );
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, Buffer.alloc(256 * 1024, index));
      transcriptIds.push(
        `chat-transcript/${encodeURIComponent(relativePath)}`,
      );
    }

    const outcome = await helperMainTesting.exportFinalChanges(
      fixture.request,
      fixture.repository,
    );

    expect(outcome.incompleteKinds).toEqual([]);
    expect(outcome.protectedLocalResourceIds).toEqual([]);
    for (const resourceId of transcriptIds) {
      const tips = fixture.repository.state.tips[resourceId] ?? [];
      expect(tips, resourceId).toHaveLength(1);
      expect(tips[0]?.operation, resourceId).toBe("put");
    }
  }, 120_000);
});

interface Fixture {
  database: DatabaseSync;
  repository: SyncRepository;
  request: HelperRequest;
}

async function createFixture(maxPayloadBytes = MAX_PAYLOAD_BYTES): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "cursor-final-export-drain-"));
  roots.push(root);
  const databasePath = join(root, "state.vscdb");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders(
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
      recency INTEGER, checkpointAt INTEGER, value TEXT
    );
  `);

  const storageRoot = join(root, "extension-storage");
  const repositoryRoot = join(root, "repository");
  const userDataRoot = join(root, "User");
  const cursorHome = join(root, ".cursor");
  await mkdir(storageRoot, { recursive: true });
  await mkdir(userDataRoot, { recursive: true });
  await mkdir(cursorHome, { recursive: true });
  // ExtensionsAdapter intentionally invokes Cursor's CLI during a final
  // export.  This isolated fixture uses the current Node executable as its
  // stand-in, so provide the minimal CLI entry point the real installation
  // always has.  Leaving it absent makes the adapter correctly report the
  // extension kind as incomplete and causes every bounded drain pass to retry
  // the same fixture error, obscuring the chat/transcript behavior under test.
  await mkdir(join(root, "out"), { recursive: true });
  await writeFile(join(root, "out", "cli.js"), "process.exit(0);\n", "utf8");
  await writeFile(
    join(root, "product.json"),
    JSON.stringify({ version: "3.11.19", vscodeVersion: "1.125.0" }),
    "utf8",
  );
  const repository = await SyncRepository.create(
    repositoryRoot,
    storageRoot,
    PASSPHRASE,
    maxPayloadBytes,
    {
      extensionVersion: "0.0.63",
      cursorVersion: "3.11.19",
      vscodeVersion: "1.125.0",
    },
  );
  const paths: CursorPaths = {
    appRoot: root,
    userDataRoot,
    globalStorageRoot: root,
    globalDatabase: databasePath,
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
    cursorExtensionsManifest: join(
      cursorHome,
      "extensions",
      "extensions.json",
    ),
    extensionStorage: storageRoot,
    helperScript: join(root, "helper.js"),
  };
  return {
    database,
    repository,
    request: {
      version: 1,
      requestId: "11111111-2222-4333-8444-555555555555",
      mode: "final-export",
      createdAt: new Date().toISOString(),
      repositoryRoot,
      storageRoot,
      cursorExecutable: process.execPath,
      extensionHostPid: 0x7ffffffe,
      restart: false,
      expectedCursorVersion: "3.11.19",
      expectedVscodeVersion: "1.125.0",
      extensionVersion: "0.0.63",
      paths,
      changes: [],
      workspaceMappings: {},
      syncOptions: {
        ignoredSettings: [],
        ignoredExtensions: [],
        ignoredUserFiles: [],
        ignoredUiStateKeys: [],
        ignoredWorkspaces: [],
        machineScopedSettings: [],
        applyOnShutdown: true,
        syncChat: true,
        syncWorkspaceStorage: false,
        maxPayloadBytes,
        gitSync: false,
      },
    },
  };
}

function insertLiveChat(
  database: DatabaseSync,
  composerId: string,
  title: string,
  lastUpdatedAt: number,
  bubbleBytes: number,
): void {
  const bubbleId = `bubble-${composerId}`;
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, NULL, 1, ?, 0, 0, 0, NULL, ?)`,
    )
    .run(composerId, lastUpdatedAt, JSON.stringify({ name: title }));
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(
      `composerData:${composerId}`,
      JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId }] }),
    );
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(
      `bubbleId:${composerId}:${bubbleId}`,
      JSON.stringify({ text: "x".repeat(bubbleBytes) }),
    );
}

function portableChat(
  composerId: string,
  title: string,
  lastUpdatedAt: number,
  text: string,
): PortableChatSnapshot {
  const bubbleId = `bubble-${composerId}`;
  return {
    schemaVersion: 1,
    composerId,
    header: {
      composerId,
      workspaceId: null,
      createdAt: 1,
      lastUpdatedAt,
      isArchived: 0,
      isSubagent: 0,
      recency: 0,
      checkpointAt: null,
      value: JSON.stringify({ name: title }),
    },
    composerData: {
      key: `composerData:${composerId}`,
      valueBase64: Buffer.from(
        JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId }] }),
        "utf8",
      ).toString("base64"),
      valueType: "text",
    },
    bubbles: [
      {
        key: `bubbleId:${composerId}:${bubbleId}`,
        valueBase64: Buffer.from(JSON.stringify({ text }), "utf8").toString(
          "base64",
        ),
        valueType: "text",
      },
    ],
  };
}

function portableChatV2(
  composerId: string,
  title: string,
  lastUpdatedAt: number,
  text: string,
  missingIds: string[] = [],
): PortableChatSnapshotV2 {
  const base = portableChat(
    composerId,
    title,
    lastUpdatedAt,
    text,
  );
  return {
    schemaVersion: 2,
    composerId: base.composerId,
    header: base.header,
    composerData: base.composerData,
    bubbles: base.bubbles,
    agentKv: {
      blobs: [],
      referencedIds: [...missingIds],
      missingIds: [...missingIds],
    },
  };
}

function composerId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function helperChange(
  tip: Parameters<typeof helperMainTesting.isEligible>[1][number]["tip"],
  resourceId: string,
): HelperChange {
  return {
    eventHash: tip.eventHash,
    changeIndex: tip.changeIndex,
    sourceDeviceId: tip.deviceId,
    resourceId,
    kind: tip.kind,
    operation: tip.operation,
    semanticHash: tip.semanticHash,
    ...(tip.payload === undefined ? {} : { payload: tip.payload }),
    ...(tip.metadata === undefined ? {} : { metadata: tip.metadata }),
  };
}

function requiredChange(
  changes: readonly HelperChange[],
  resourceId: string,
): HelperChange {
  const change = changes.find((candidate) => candidate.resourceId === resourceId);
  if (change === undefined) {
    throw new Error(`Missing test change for ${resourceId}.`);
  }
  return change;
}
