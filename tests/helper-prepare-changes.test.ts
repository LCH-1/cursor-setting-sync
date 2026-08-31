import { mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import {
  __testing as helperMainTesting,
  markAppliedProjections,
  prepareChanges,
} from "../src/helper/main";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import {
  portableChatCoreHash,
  type PortableChatSnapshotV2,
} from "../src/chat/stateVscdb";
import type {
  EventProducer,
  JsonValue,
  ResourceSnapshot,
  ResourceTip,
} from "../src/types";
import type { HelperChange, HelperRequest } from "../src/helper/types";
import type { PreparedHelperChange } from "../src/helper/database";
import { CursorReopenedError } from "../src/helper/resourceApply";
import type { ResourceProjection } from "../src/protocol/reconciler";
import { MAX_HELPER_APPLY_WORK_BYTES } from "../src/constants";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

describe("preparing a helper batch", () => {
  it("grandfathers only ordinary legacy checkpoint markers", () => {
    const parentVersionId = `${"1".repeat(64)}#0`;
    const markerDeviceId = "legacy-marker-device";
    const resourceId = "chat/00000000-0000-4000-8000-000000000059";
    const ordinaryMetadata: Record<string, JsonValue> = {
      syncOrigin: "checkpoint-marker",
      composerId: "00000000-0000-4000-8000-000000000059",
      workspaceId: "workspace",
      lastUpdatedAt: 59,
      bubbleCount: 1,
      chatSnapshotSchemaVersion: 2,
      agentKvMissingCount: 0,
    };
    const eligible = (
      metadata: Record<string, JsonValue>,
      parents: string[] = [parentVersionId],
      producer: EventProducer | null = PRODUCER,
    ): boolean => {
      const tip: ResourceTip = {
        versionId: `${"2".repeat(64)}#0`,
        eventHash: "2".repeat(64),
        changeIndex: 0,
        kind: "chat",
        lamport: 2,
        deviceId: markerDeviceId,
        operation: "put",
        semanticHash: "3".repeat(64),
        parents,
        metadata,
        ...(producer === null ? {} : { producer }),
      };
      const change: HelperChange = {
        eventHash: tip.eventHash,
        changeIndex: tip.changeIndex,
        sourceDeviceId: markerDeviceId,
        resourceId,
        kind: tip.kind,
        operation: tip.operation,
        semanticHash: tip.semanticHash,
        metadata,
      };
      return helperMainTesting.isEligible(
        change,
        [{ resourceId, tip, changed: true }],
        [],
      );
    };

    expect(eligible(ordinaryMetadata)).toBe(true);
    expect(eligible(ordinaryMetadata, [])).toBe(false);
    expect(eligible(ordinaryMetadata, ["not-a-version"])).toBe(false);
    expect(eligible(ordinaryMetadata, [parentVersionId], null)).toBe(false);

    const originalProducer = {
      extensionVersion: "0.0.58",
      cursorVersion: "3.16.0",
      vscodeVersion: "1.126.0",
    };
    for (const specialMetadata of [
      {
        ...ordinaryMetadata,
        repairOriginDeviceId: "repair-source-device",
        repairFingerprint: "4".repeat(64),
      },
      { ...ordinaryMetadata, originalProducer },
      {
        ...ordinaryMetadata,
        originalProducer,
        chatSnapshotSchemaVersion: 2,
        chatCoreHash: "5".repeat(64),
        agentKvBlobCount: 1,
        agentKvReferencedCount: 1,
        agentKvMissingCount: 0,
        enrichedFromVersionId: `${"6".repeat(64)}#0`,
        enrichedFromSemanticHash: "7".repeat(64),
      },
      {
        ...ordinaryMetadata,
        checkpointedVersionId: parentVersionId,
      },
    ]) {
      expect(eligible(specialMetadata)).toBe(false);
    }
  });

  it("refuses incomplete ordinary chats in both explicit and shutdown helper paths", () => {
    const projection = (
      index: number,
      metadata: Record<string, JsonValue>,
    ): ResourceProjection => {
      const composerId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const eventHash = String(index).repeat(64);
      return {
        resourceId: `chat/${composerId}`,
        changed: true,
        tip: {
          versionId: `${eventHash}#0`,
          eventHash,
          changeIndex: 0,
          kind: "chat",
          lamport: index,
          deviceId: "source-device",
          operation: "put",
          semanticHash: "f".repeat(64),
          parents: [],
          metadata,
          producer: PRODUCER,
        },
      };
    };
    const legacy = projection(1, { chatSnapshotSchemaVersion: 1 });
    const partial = projection(2, {
      chatSnapshotSchemaVersion: 2,
      agentKvMissingCount: 1,
    });
    const complete = projection(3, {
      chatSnapshotSchemaVersion: 2,
      agentKvMissingCount: 0,
    });
    const projections = [legacy, partial, complete];
    const asChange = ({ resourceId, tip }: ResourceProjection): HelperChange => ({
      eventHash: tip.eventHash,
      changeIndex: tip.changeIndex,
      sourceDeviceId: tip.deviceId,
      resourceId,
      kind: tip.kind,
      operation: tip.operation,
      semanticHash: tip.semanticHash,
      ...(tip.metadata === undefined ? {} : { metadata: tip.metadata }),
    });

    expect(
      helperMainTesting.isEligible(asChange(legacy), projections, []),
    ).toBe(false);
    expect(
      helperMainTesting.isEligible(asChange(partial), projections, []),
    ).toBe(false);
    expect(
      helperMainTesting.isEligible(asChange(complete), projections, []),
    ).toBe(true);

    const repository = {
      state: {
        pendingDatabaseChanges: projections.map(({ resourceId, tip }) => ({
          resourceId,
          kind: tip.kind,
          eventHash: tip.eventHash,
          changeIndex: tip.changeIndex,
        })),
      },
    } as unknown as SyncRepository;
    expect(
      helperMainTesting
        .shutdownApplyBatch(repository, projections)
        .map((change) => change.resourceId),
    ).toEqual([complete.resourceId]);
  });

  it("accepts checkpointed repair authority only when its provenance binds the sole parent", () => {
    const sourceDeviceId = "repair-source-device";
    const markerDeviceId = "checkpoint-marker-device";
    const parentVersionId = `${"a".repeat(64)}#0`;
    const markerVersionId = `${"b".repeat(64)}#0`;
    const metadata = {
      syncOrigin: "checkpoint-marker",
      checkpointedSyncOrigin: "automatic-chat-repair",
      checkpointedSourceDeviceId: sourceDeviceId,
      checkpointedVersionId: parentVersionId,
      checkpointedProducer: {
        extensionVersion: PRODUCER.extensionVersion,
        cursorVersion: PRODUCER.cursorVersion,
        vscodeVersion: PRODUCER.vscodeVersion,
      },
      repairOriginDeviceId: sourceDeviceId,
      repairFingerprint: "c".repeat(64),
    };
    const tip: ResourceTip = {
      versionId: markerVersionId,
      eventHash: "b".repeat(64),
      changeIndex: 0,
      kind: "chat",
      lamport: 2,
      deviceId: markerDeviceId,
      operation: "put",
      semanticHash: "d".repeat(64),
      parents: [parentVersionId],
      metadata,
      producer: PRODUCER,
    };
    const change: HelperChange = {
      eventHash: tip.eventHash,
      changeIndex: tip.changeIndex,
      sourceDeviceId: markerDeviceId,
      resourceId: "chat/00000000-0000-4000-8000-000000000001",
      kind: tip.kind,
      operation: tip.operation,
      semanticHash: tip.semanticHash,
      metadata,
    };
    const projection = (candidateTip: ResourceTip): ResourceProjection => ({
      resourceId: change.resourceId,
      tip: candidateTip,
      changed: true,
    });
    const eligible = (
      candidateTip: ResourceTip,
      candidateChange: HelperChange = change,
    ) =>
      helperMainTesting.isEligible(
        candidateChange,
        [projection(candidateTip)],
        [],
      );

    expect(eligible(tip)).toBe(true);
    for (const invalidTip of [
      { ...tip, parents: [] },
      { ...tip, parents: [parentVersionId, `${"e".repeat(64)}#0`] },
      {
        ...tip,
        parents: ["not-a-version"],
        metadata: { ...metadata, checkpointedVersionId: "not-a-version" },
      },
      {
        ...tip,
        metadata: { ...metadata, checkpointedVersionId: `${"e".repeat(64)}#0` },
      },
      {
        ...tip,
        metadata: { ...metadata, checkpointedSourceDeviceId: "../unsafe" },
      },
      {
        ...tip,
        metadata: { ...metadata, checkpointedProducer: null },
      },
      {
        ...tip,
        metadata: {
          ...metadata,
          checkpointedSourceDeviceId: "different-source-device",
        },
      },
    ]) {
      const invalidChange: HelperChange = {
        ...change,
        ...(invalidTip.metadata === undefined
          ? {}
          : { metadata: invalidTip.metadata }),
      };
      expect(eligible(invalidTip, invalidChange)).toBe(false);
    }
  });

  it("defers one unreadable payload instead of losing the whole batch", async () => {
    // A payload object that EXISTS but cannot be read - a cloud placeholder
    // that materialized as zero bytes, a truncated write, bit rot - used to
    // rethrow out of the preparation step. That happens before anything is
    // applied, dequeued or blocked, so the entire request died: nothing
    // written, the queue exactly as it was found, and the modal offering it
    // again at the next launch. The bytes never heal, so every later apply
    // died the same way and quit Cursor to do it.
    await withRepository(async (repository, root) => {
      const good = await publish(repository, "good", "keep me");
      const bad = await publish(repository, "bad", "unreadable");

      // Zero the object file the way a cloud placeholder does.
      await truncate(objectPath(root, bad), 0);

      const result = await prepareChanges(repository, [
        helperChange(good),
        helperChange(bad),
      ]);

      // The healthy sibling is still applied.
      expect(result.prepared.map((item) => item.change.resourceId)).toEqual([
        good.resourceId,
      ]);
      // ...and the damaged one is reported per resource, so it can be blocked
      // rather than re-offered forever.
      expect(Object.keys(result.failureByResourceId)).toEqual([bad.resourceId]);
      expect(result.skipped.join("\n")).toContain(bad.resourceId);
    });
  });

  it("verifies the authenticated continuation closure before preparing a core apply", async () => {
    await withRepository(async (repository) => {
      const complete = await publishPortableChat(
        repository,
        portableChat("10000000-0000-4000-8000-000000000001"),
      );

      const omittedLeafId = sha256("omitted continuation descendant");
      const rootBytes = Buffer.concat([
        Buffer.from([0x0a, 0x22, 0x12, 0x20]),
        Buffer.from(omittedLeafId, "hex"),
      ]);
      const rootId = sha256(rootBytes);
      const falseComplete = await publishPortableChat(
        repository,
        portableChat("10000000-0000-4000-8000-000000000002", {
          conversationState: `~${Buffer.concat([
            Buffer.from([0x42, 0x20]),
            Buffer.from(rootId, "hex"),
          ]).toString("base64")}`,
          blobs: [
            {
              key: `agentKv:blob:${rootId}`,
              valueBase64: rootBytes.toString("base64"),
              valueType: "blob",
            },
          ],
        }),
      );
      const missingRootId = sha256("declared missing active root");
      const forgedMetadata = await publishPortableChat(
        repository,
        portableChat("10000000-0000-4000-8000-000000000003", {
          conversationState: `~${Buffer.concat([
            Buffer.from([0x0a, 0x20]),
            Buffer.from(missingRootId, "hex"),
          ]).toString("base64")}`,
          missingIds: [missingRootId],
        }),
        { agentKvMissingCount: 0 },
      );

      const result = await prepareChanges(repository, [
        helperChange(complete),
        helperChange(falseComplete),
        helperChange(forgedMetadata),
      ]);

      expect(result.prepared.map((item) => item.change.resourceId)).toEqual([
        complete.resourceId,
      ]);
      expect(result.failureByResourceId[falseComplete.resourceId]).toContain(
        "closure could not be verified (invalid/reachable-id-not-declared)",
      );
      expect(result.failureByResourceId[forgedMetadata.resourceId]).toContain(
        "metadata does not match its payload",
      );
    });
  });

  it("keeps a payload that has not arrived yet queued without calling it a failure", async () => {
    // The opposite case, and the reason the two are told apart: a shared
    // folder that delivers the event before the object. That heals on its own,
    // so blocking it would make the user run the command by hand for a file
    // OneDrive is about to hand over.
    await withRepository(async (repository, root) => {
      const late = await publish(repository, "late", "not here yet");
      await rm(objectPath(root, late));

      const result = await prepareChanges(repository, [helperChange(late)]);

      expect(result.prepared).toHaveLength(0);
      expect(result.failureByResourceId).toEqual({});
      expect(result.skipped.join("\n")).toContain("payload not yet synced");
    });
  });

  it("defers a change whose event carries no payload reference", async () => {
    await withRepository(async (repository) => {
      const tip = await publish(repository, "orphan", "x");
      const change = helperChange(tip);
      delete change.payload;

      const result = await prepareChanges(repository, [change]);

      expect(result.prepared).toHaveLength(0);
      expect(result.failureByResourceId[tip.resourceId]).toContain(
        "no payload reference",
      );
    });
  });

  it("preflights a fixed helper work page before reading payload objects", async () => {
    const readObject = vi.fn(async () => Buffer.from("bounded"));
    const repository = { readObject } as unknown as SyncRepository;
    const change = (name: string, plainBytes: number): HelperChange => ({
      eventHash: "a".repeat(64),
      changeIndex: 0,
      resourceId: `snippet/${name}.json`,
      kind: "snippet",
      operation: "put",
      semanticHash: "b".repeat(64),
      payload: {
        deviceId: "source-device",
        objectId: "c".repeat(64),
        compressedBytes: 1,
        plainBytes,
      },
    });
    const first = change("first", 20 * 1024 * 1024);
    const nextPage = change("next-page", 20 * 1024 * 1024);
    const tooLarge = change("too-large", MAX_HELPER_APPLY_WORK_BYTES + 1);

    const result = await prepareChanges(repository, [
      tooLarge,
      first,
      nextPage,
    ]);

    expect(readObject).toHaveBeenCalledTimes(1);
    expect(result.prepared.map((item) => item.change.resourceId)).toEqual([
      first.resourceId,
    ]);
    expect(result.skipped.join("\n")).toContain("later bounded helper apply page");
    expect(result.failureByResourceId[tooLarge.resourceId]).toContain(
      "fixed",
    );
  });

  it("keeps a single over-limit shutdown item visible while admitting a small sibling", () => {
    const projection = (
      name: string,
      plainBytes: number,
      index: number,
    ): ResourceProjection => {
      const eventHash = String(index + 1).repeat(64);
      const resourceId = `snippet/${name}.json`;
      return {
        resourceId,
        changed: true,
        tip: {
          versionId: `${eventHash}#${index}`,
          eventHash,
          changeIndex: index,
          kind: "snippet",
          lamport: index + 1,
          deviceId: "source-device",
          operation: "put",
          semanticHash: "d".repeat(64),
          parents: [],
          payload: {
            deviceId: "source-device",
            objectId: "e".repeat(64),
            compressedBytes: 1,
            plainBytes,
          },
        },
      };
    };
    const oversized = projection(
      "oversized",
      MAX_HELPER_APPLY_WORK_BYTES + 1,
      0,
    );
    const small = projection("small", 1024, 1);
    const projections = [oversized, small];
    const repository = {
      state: {
        pendingDatabaseChanges: projections.map(({ resourceId, tip }) => ({
          resourceId,
          kind: tip.kind,
          eventHash: tip.eventHash,
          changeIndex: tip.changeIndex,
        })),
      },
    } as unknown as SyncRepository;

    const batch = helperMainTesting.shutdownApplyBatch(repository, projections);

    expect(batch.map((change) => change.resourceId)).toEqual([
      oversized.resourceId,
      small.resourceId,
    ]);
  });

  it("verifies the whole READY shutdown queue once while applying bounded pages", () => {
    const projections = Array.from(
      { length: 300 },
      (_unused, index): ResourceProjection => {
        const eventHash = index.toString(16).padStart(64, "0");
        const resourceId = `settings/default/queued-${index}`;
        return {
          resourceId,
          changed: true,
          tip: {
            versionId: `${eventHash}#0`,
            eventHash,
            changeIndex: 0,
            kind: "settings",
            lamport: index + 1,
            deviceId: "source-device",
            operation: "delete",
            semanticHash: "d".repeat(64),
            parents: [],
          },
        };
      },
    );
    const repository = {
      state: {
        pendingDatabaseChanges: projections.map(({ resourceId, tip }) => ({
          resourceId,
          kind: tip.kind,
          eventHash: tip.eventHash,
          changeIndex: tip.changeIndex,
        })),
      },
    } as unknown as SyncRepository;
    const request = {
      mode: "final-export",
      changes: [],
      syncOptions: { applyOnShutdown: true },
    } as unknown as HelperRequest;

    const verifiedTargets = helperMainTesting.finalExportTargetPage(
      request,
      repository,
      projections,
    );
    const explicitTargets = helperMainTesting.finalExportTargetPage(
      {
        ...request,
        mode: "apply-and-restart",
      },
      repository,
      projections,
    );
    const firstApplyPage = helperMainTesting.shutdownApplyBatch(
      repository,
      projections,
    );

    expect(verifiedTargets).toHaveLength(300);
    expect(explicitTargets).toEqual(verifiedTargets);
    expect(firstApplyPage).toHaveLength(256);
    expect(firstApplyPage).toEqual(verifiedTargets.slice(0, 256));
  });

  it("keeps policy-excluded stale entries out of every durable helper page", () => {
    const entries: Array<{
      resourceId: string;
      kind: ResourceTip["kind"];
      metadata?: ResourceTip["metadata"];
      excluded: boolean;
    }> = [
      {
        resourceId: `ui-state/${encodeURIComponent("workbench.activity.pinnedViewlets2")}`,
        kind: "ui-state",
        metadata: { key: "workbench.activity.pinnedViewlets2" },
        excluded: true,
      },
      {
        resourceId: "workspace-storage/folderless/state.vscdb",
        kind: "workspace-storage",
        metadata: { workspaceId: "folderless" },
        excluded: true,
      },
      {
        resourceId: "chat/empty-state-draft",
        kind: "chat",
        metadata: { composerId: "empty-state-draft" },
        excluded: true,
      },
      {
        resourceId: "chat/00000000-0000-4000-8000-000000000071",
        kind: "chat",
        metadata: {
          composerId: "00000000-0000-4000-8000-000000000071",
        },
        excluded: false,
      },
    ];
    const projections = entries.map(
      (entry, index): ResourceProjection => {
        const eventHash = (index + 1).toString(16).repeat(64);
        return {
          resourceId: entry.resourceId,
          changed: true,
          tip: {
            versionId: `${eventHash}#0`,
            eventHash,
            changeIndex: 0,
            kind: entry.kind,
            lamport: index + 1,
            deviceId: "source-device",
            operation: "delete",
            semanticHash: String(index + 5).repeat(64),
            parents: [],
            ...(entry.metadata === undefined
              ? {}
              : { metadata: entry.metadata }),
          },
        };
      },
    );
    const repository = {
      state: {
        pendingDatabaseChanges: projections.map(({ resourceId, tip }) => ({
          resourceId,
          kind: tip.kind,
          eventHash: tip.eventHash,
          changeIndex: tip.changeIndex,
        })),
      },
    } as unknown as SyncRepository;

    expect(
      helperMainTesting
        .shutdownApplyCandidates(repository, projections)
        .map((change) => change.resourceId),
    ).toEqual([entries[3]?.resourceId]);
    const valid = projections[3];
    expect(valid).toBeDefined();
    if (valid === undefined) {
      throw new Error("The valid policy fixture is missing.");
    }
    const mismatchedRepository = {
      state: {
        pendingDatabaseChanges: [
          {
            resourceId: "chat/00000000-0000-4000-8000-000000000072",
            kind: valid.tip.kind,
            eventHash: valid.tip.eventHash,
            changeIndex: valid.tip.changeIndex,
          },
          {
            resourceId: valid.resourceId,
            kind: "workspace-storage",
            eventHash: valid.tip.eventHash,
            changeIndex: valid.tip.changeIndex,
          },
        ],
      },
    } as unknown as SyncRepository;
    expect(
      helperMainTesting.shutdownApplyCandidates(
        mismatchedRepository,
        projections,
      ),
    ).toEqual([]);
    for (const [index, projection] of projections.entries()) {
      const tip = projection.tip;
      expect(
        helperMainTesting.isEligible(
          {
            eventHash: tip.eventHash,
            changeIndex: tip.changeIndex,
            sourceDeviceId: tip.deviceId,
            resourceId: projection.resourceId,
            kind: tip.kind,
            operation: tip.operation,
            semanticHash: tip.semanticHash,
            ...(tip.metadata === undefined ? {} : { metadata: tip.metadata }),
          },
          projections,
          [],
        ),
      ).toBe(!entries[index]?.excluded);
    }
  });

  it("recognizes only pages that can mutate the global database", () => {
    const prepared = (
      kind: ResourceTip["kind"],
      operation: HelperChange["operation"],
      profileId?: string,
    ): PreparedHelperChange => ({
      change: {
        eventHash: "a".repeat(64),
        changeIndex: 0,
        resourceId: `${kind}/candidate`,
        kind,
        operation,
        semanticHash: "b".repeat(64),
        ...(profileId === undefined ? {} : { metadata: { profileId } }),
      },
    });

    expect(
      helperMainTesting.pageMayMutateGlobalDatabase([
        prepared("extension", "put", "default"),
      ]),
    ).toBe(true);
    expect(
      helperMainTesting.pageMayMutateGlobalDatabase([
        prepared("extension", "delete", "default"),
        prepared("extension", "put", "named-profile"),
        prepared("chat-store", "delete"),
      ]),
    ).toBe(false);
    expect(
      helperMainTesting.pageMayMutateGlobalDatabase([
        prepared("chat", "put"),
      ]),
    ).toBe(true);
  });

  it("pins only cross-page recovery points that later pages can reuse", () => {
    const globalDatabase = "C:/Cursor/User/globalStorage/state.vscdb";
    const paths = helperMainTesting.priorApplyBackupPaths(
      {
        backupPath: "shared-global.vscdb",
        backups: [
          {
            backupPath: "workspace-page-one.vscdb",
            contract: "workspace",
            targetPath: "C:/Cursor/User/workspaceStorage/one/state.vscdb",
          },
          {
            backupPath: "store-page-one.db",
            contract: "store",
            targetPath: "C:/Cursor/chats/one/store.db",
          },
          {
            backupPath: "named-profile.vscdb",
            contract: "item-table",
            targetPath: "C:/Cursor/User/profiles/work/globalStorage/state.vscdb",
          },
          {
            backupPath: "duplicate-default.vscdb",
            contract: "item-table",
            targetPath: globalDatabase,
          },
        ],
      },
      ["journal-recovery.vscdb"],
      ["queued-restore-source.vscdb"],
      globalDatabase,
    );

    expect(paths).toEqual([
      "journal-recovery.vscdb",
      "queued-restore-source.vscdb",
      "shared-global.vscdb",
      "named-profile.vscdb",
    ]);
  });

  it("drains successive bounded pages without another user action", async () => {
    const queue = Array.from({ length: 600 }, (_unused, index): HelperChange => ({
      eventHash: index.toString(16).padStart(64, "0"),
      changeIndex: 0,
      resourceId: `settings/default/drain-${index}`,
      kind: "settings",
      operation: "delete",
      semanticHash: "f".repeat(64),
    }));
    const pageSizes: number[] = [];
    const beforePage = vi.fn(async () => {});

    const result = await helperMainTesting.drainBoundedApplyPages(
      () => queue.slice(0, 256),
      async (page) => {
        pageSizes.push(page.length);
        queue.splice(0, page.length);
        return true;
      },
      beforePage,
    );

    expect(result).toBe("drained");
    expect(pageSizes).toEqual([256, 256, 88]);
    expect(beforePage).toHaveBeenCalledTimes(3);
    expect(queue).toEqual([]);
  });

  it("stops an automatic drain when a page cannot make progress", async () => {
    const page: HelperChange[] = [
      {
        eventHash: "a".repeat(64),
        changeIndex: 0,
        resourceId: "settings/default/not-downloaded",
        kind: "settings",
        operation: "delete",
        semanticHash: "b".repeat(64),
      },
    ];
    const apply = vi.fn(async () => false);

    const result = await helperMainTesting.drainBoundedApplyPages(
      (attempted) =>
        attempted.has(`${page[0]?.eventHash}#${page[0]?.changeIndex}`)
          ? []
          : page,
      apply,
    );

    expect(result).toBe("no-progress");
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does not let a transient full-page payload starve later READY work", async () => {
    const projection = (
      name: string,
      plainBytes: number,
      index: number,
    ): ResourceProjection => {
      const eventHash = String(index + 1).repeat(64);
      const resourceId = `snippet/${name}.json`;
      return {
        resourceId,
        changed: true,
        tip: {
          versionId: `${eventHash}#0`,
          eventHash,
          changeIndex: 0,
          kind: "snippet",
          lamport: index + 1,
          deviceId: "source-device",
          operation: "put",
          semanticHash: "d".repeat(64),
          parents: [],
          payload: {
            deviceId: "source-device",
            objectId: String(index + 4).repeat(64),
            compressedBytes: 1,
            plainBytes,
          },
        },
      };
    };
    const stalled = projection("not-downloaded", MAX_HELPER_APPLY_WORK_BYTES, 0);
    const later = projection("later-ready", 1024, 1);
    const projections = [stalled, later];
    const pendingDatabaseChanges = projections.map(({ resourceId, tip }) => ({
      resourceId,
      kind: tip.kind,
      eventHash: tip.eventHash,
      changeIndex: tip.changeIndex,
    }));
    const repository = {
      state: { pendingDatabaseChanges },
    } as unknown as SyncRepository;
    const attemptedPages: string[][] = [];

    const result = await helperMainTesting.drainBoundedApplyPages(
      (attempted) =>
        helperMainTesting.shutdownApplyBatch(
          repository,
          projections,
          attempted,
        ),
      async (page) => {
        attemptedPages.push(page.map((change) => change.resourceId));
        if (page.some((change) => change.resourceId === stalled.resourceId)) {
          return false;
        }
        repository.state.pendingDatabaseChanges =
          repository.state.pendingDatabaseChanges.filter(
            (pending) =>
              !page.some((change) => change.resourceId === pending.resourceId),
          );
        return true;
      },
    );

    expect(result).toBe("no-progress");
    expect(attemptedPages).toEqual([
      [stalled.resourceId],
      [later.resourceId],
    ]);
    expect(repository.state.pendingDatabaseChanges).toEqual([
      expect.objectContaining({ resourceId: stalled.resourceId }),
    ]);
  });

  it("does not start another page after the closed-Cursor gate changes", async () => {
    const queue = Array.from({ length: 300 }, (_unused, index): HelperChange => ({
      eventHash: index.toString(16).padStart(64, "0"),
      changeIndex: 0,
      resourceId: `settings/default/reopen-${index}`,
      kind: "settings",
      operation: "delete",
      semanticHash: "e".repeat(64),
    }));
    const applied: string[] = [];
    let checks = 0;

    const interrupted = expect(
      helperMainTesting.drainBoundedApplyPages(
        () => queue.slice(0, 256),
        async (page) => {
          applied.push(...page.map((change) => change.resourceId));
          queue.splice(0, page.length);
          return true;
        },
        async () => {
          checks += 1;
          if (checks === 2) {
            throw new CursorReopenedError("Cursor reopened");
          }
        },
      ),
    ).rejects;
    await interrupted.toBeInstanceOf(CursorReopenedError);
    expect(applied).toHaveLength(256);
    expect(queue).toHaveLength(44);
  });

  it("excludes each stalled sibling after a partially successful page", async () => {
    const queue = Array.from({ length: 300 }, (_unused, index): HelperChange => ({
      eventHash: index.toString(16).padStart(64, "0"),
      changeIndex: 0,
      resourceId: `settings/default/mixed-${index}`,
      kind: "settings",
      operation: "delete",
      semanticHash: "c".repeat(64),
    }));
    const pages: number[] = [];
    let first = true;

    const result = await helperMainTesting.drainBoundedApplyPages(
      (stalled) =>
        queue
          .filter(
            (change) =>
              !stalled.has(`${change.eventHash}#${change.changeIndex}`),
          )
          .slice(0, 256),
      async (page) => {
        pages.push(page.length);
        if (first) {
          first = false;
          const successful = page.at(-1);
          if (successful !== undefined) {
            queue.splice(queue.indexOf(successful), 1);
          }
          return {
            madeProgress: true,
            stalledVersionIds: page
              .slice(0, -1)
              .map((change) => `${change.eventHash}#${change.changeIndex}`),
          };
        }
        const applied = new Set(page.map((change) => change.resourceId));
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          if (applied.has(queue[index]?.resourceId ?? "")) {
            queue.splice(index, 1);
          }
        }
        return { madeProgress: true, stalledVersionIds: [] };
      },
    );

    expect(result).toBe("drained");
    expect(pages).toEqual([256, 44]);
    expect(queue).toHaveLength(255);
  });

  it("targets only the bounded explicit apply page even beside 100k changed projections", () => {
    const change: HelperChange = {
      eventHash: "a".repeat(64),
      changeIndex: 0,
      resourceId: "settings/default/first",
      kind: "settings",
      operation: "put",
      semanticHash: "b".repeat(64),
      payload: {
        deviceId: "source-device",
        objectId: "c".repeat(64),
        compressedBytes: 1,
        plainBytes: 1,
      },
    };
    const projections = Array.from(
      { length: 100_000 },
      (_unused, index): ResourceProjection => ({
        resourceId: `settings/default/backlog-${index}`,
        changed: true,
        tip: {
          versionId: `${index.toString(16).padStart(64, "0")}#0`,
          eventHash: index.toString(16).padStart(64, "0"),
          changeIndex: 0,
          kind: "settings",
          lamport: index + 1,
          deviceId: "source-device",
          operation: "put",
          semanticHash: "d".repeat(64),
          parents: [],
        },
      }),
    );
    const request = {
      mode: "apply-and-restart",
      changes: [change],
    } as HelperRequest;

    const page = helperMainTesting.finalExportTargetPage(
      request,
      {
        state: { pendingDatabaseChanges: [] },
      } as unknown as SyncRepository,
      projections,
    );

    expect(page).toEqual([change]);
  });

  it("does not promote an unverified sibling when the first target drops after export", () => {
    const change = (suffix: string): HelperChange => ({
      eventHash: suffix.repeat(64),
      changeIndex: 0,
      resourceId: `settings/default/${suffix}`,
      kind: "settings",
      operation: "delete",
      semanticHash: "f".repeat(64),
    });
    const first = change("a");
    const promotedAfterDrift = change("b");

    expect(
      helperMainTesting.intersectVerifiedApplyPage(
        [promotedAfterDrift],
        [`${first.eventHash}#${first.changeIndex}`],
      ),
    ).toEqual([]);
  });
});

describe("marking helper chat projections", () => {
  it("requests one continuation recapture after applying a legacy repair", async () => {
    await withRepository(async (repository) => {
      const resourceId = "chat/acacacac-acac-4cac-8cac-acacacacacac";
      const change: HelperChange = {
        eventHash: "a".repeat(64),
        changeIndex: 0,
        resourceId,
        kind: "chat",
        operation: "put",
        semanticHash: "b".repeat(64),
        metadata: {
          syncOrigin: "automatic-chat-repair",
          chatSnapshotSchemaVersion: 1,
          bubbleCount: 4,
        },
      };

      markAppliedProjections(
        repository,
        [change],
        [resourceId],
        new Set(),
      );

      expect(
        repository.state.projections[resourceId]?.requiresAgentKvRecapture,
      ).toBe(true);
    });
  });

  it("does not recapture a repair payload whose continuation graph is complete", async () => {
    await withRepository(async (repository) => {
      const resourceId = "chat/adadadad-adad-4dad-8dad-adadadadadad";
      const change: HelperChange = {
        eventHash: "a".repeat(64),
        changeIndex: 0,
        resourceId,
        kind: "chat",
        operation: "put",
        semanticHash: "c".repeat(64),
        metadata: {
          syncOrigin: "automatic-chat-repair",
          chatSnapshotSchemaVersion: 2,
          agentKvMissingCount: 0,
        },
      };

      markAppliedProjections(
        repository,
        [change],
        [resourceId],
        new Set(),
      );

      expect(
        repository.state.projections[resourceId]?.requiresAgentKvRecapture,
      ).toBeUndefined();
    });
  });

  it("does not persist an enrichment tip's core for a divergent preserved core", async () => {
    await withRepository(async (repository) => {
      const resourceId = "chat/dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const sourceCoreHash = "a".repeat(64);
      const change: HelperChange = {
        eventHash: "c".repeat(64),
        changeIndex: 0,
        resourceId,
        kind: "chat",
        operation: "put",
        semanticHash: "d".repeat(64),
        metadata: {
          syncOrigin: "agent-kv-enrichment",
          chatCoreHash: sourceCoreHash,
          bubbleCount: 115,
        },
      };

      markAppliedProjections(
        repository,
        [change],
        [resourceId],
        new Set(),
        {},
        { [resourceId]: null },
      );

      expect(
        repository.state.projections[resourceId]?.sourceChatCoreHash,
      ).toBeUndefined();
    });
  });

  it("persists the verified core hash when local and source cores match", async () => {
    await withRepository(async (repository) => {
      const resourceId = "chat/abababab-abab-4bab-8bab-abababababab";
      const matchingCoreHash = "b".repeat(64);
      const change: HelperChange = {
        eventHash: "b".repeat(64),
        changeIndex: 0,
        resourceId,
        kind: "chat",
        operation: "put",
        semanticHash: "c".repeat(64),
        metadata: { chatCoreHash: matchingCoreHash },
      };

      markAppliedProjections(
        repository,
        [change],
        [resourceId],
        new Set(),
        {},
        { [resourceId]: matchingCoreHash },
      );

      expect(
        repository.state.projections[resourceId]?.sourceChatCoreHash,
      ).toBe(matchingCoreHash);
    });
  });

  it("omits a source core hash when enrichment preserved a partial local core", async () => {
    await withRepository(async (repository) => {
      const resourceId = "chat/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const change: HelperChange = {
        eventHash: "e".repeat(64),
        changeIndex: 0,
        resourceId,
        kind: "chat",
        operation: "put",
        semanticHash: "f".repeat(64),
        metadata: { chatCoreHash: "a".repeat(64) },
      };

      markAppliedProjections(
        repository,
        [change],
        [resourceId],
        new Set(),
        {},
        { [resourceId]: null },
      );

      expect(
        repository.state.projections[resourceId]?.sourceChatCoreHash,
      ).toBeUndefined();
    });
  });
});

interface PublishedTip {
  resourceId: string;
  tip: ResourceTip;
}

function portableChat(
  composerId: string,
  graph: {
    conversationState?: string;
    blobs?: PortableChatSnapshotV2["agentKv"]["blobs"];
    missingIds?: string[];
  } = {},
): PortableChatSnapshotV2 {
  const blobs = [...(graph.blobs ?? [])];
  const missingIds = [...(graph.missingIds ?? [])];
  const referencedIds = [
    ...blobs.map((row) => row.key.slice("agentKv:blob:".length)),
    ...missingIds,
  ].sort();
  return {
    schemaVersion: 2,
    composerId,
    header: {
      composerId,
      workspaceId: "workspace",
      createdAt: 1,
      lastUpdatedAt: 2,
      isArchived: 0,
      isSubagent: 0,
      recency: 1,
      checkpointAt: null,
      value: JSON.stringify({ name: "Helper closure fixture" }),
    },
    composerData: {
      key: `composerData:${composerId}`,
      valueBase64: Buffer.from(
        JSON.stringify({
          fullConversationHeadersOnly: [],
          ...(graph.conversationState === undefined
            ? {}
            : { conversationState: graph.conversationState }),
        }),
        "utf8",
      ).toString("base64"),
      valueType: "text",
    },
    bubbles: [],
    agentKv: {
      blobs,
      referencedIds,
      missingIds,
    },
  };
}

async function publishPortableChat(
  repository: SyncRepository,
  snapshot: PortableChatSnapshotV2,
  metadataOverride: Record<string, JsonValue> = {},
): Promise<PublishedTip> {
  const content = canonicalBytes(snapshot);
  const resourceId = `chat/${snapshot.composerId}`;
  const portable: ResourceSnapshot = {
    resourceId,
    kind: "chat",
    content,
    semanticHash: sha256(content),
    metadata: {
      composerId: snapshot.composerId,
      workspaceId: snapshot.header.workspaceId,
      chatSnapshotSchemaVersion: 2,
      chatCoreHash: portableChatCoreHash(snapshot),
      agentKvBlobCount: snapshot.agentKv.blobs.length,
      agentKvReferencedCount: snapshot.agentKv.referencedIds.length,
      agentKvMissingCount: snapshot.agentKv.missingIds.length,
      ...metadataOverride,
    },
  };
  await repository.publish([portable], []);
  new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  );
  const tip = (repository.state.tips[resourceId] ?? [])[0];
  if (tip === undefined) {
    throw new Error(`publish did not create a tip for ${resourceId}`);
  }
  return { resourceId, tip };
}

async function publish(
  repository: SyncRepository,
  name: string,
  body: string,
): Promise<PublishedTip> {
  const resourceId = `snippet/${name}.json`;
  const content = Buffer.from(JSON.stringify({ body }), "utf8");
  const snapshot: ResourceSnapshot = {
    resourceId,
    kind: "snippet",
    content,
    semanticHash: sha256(content),
  };
  await repository.publish([snapshot], []);
  // Tips come from reconciliation, not from publishing.
  new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  );
  const tip = (repository.state.tips[resourceId] ?? [])[0];
  if (tip === undefined) {
    throw new Error(`publish did not create a tip for ${resourceId}`);
  }
  return { resourceId, tip };
}

function helperChange(published: PublishedTip): HelperChange {
  const { tip, resourceId } = published;
  const change: HelperChange = {
    eventHash: tip.eventHash,
    changeIndex: tip.changeIndex,
    resourceId,
    kind: tip.kind,
    operation: tip.operation,
    semanticHash: tip.semanticHash,
  };
  if (tip.payload !== undefined) {
    change.payload = tip.payload;
  }
  if (tip.metadata !== undefined) {
    change.metadata = tip.metadata;
  }
  return change;
}

/** Mirrors the repository's own object layout. */
function objectPath(root: string, published: PublishedTip): string {
  const reference = published.tip.payload;
  if (reference === undefined) {
    throw new Error("tip has no payload reference");
  }
  return join(
    root,
    "devices",
    reference.deviceId,
    "blobs",
    "sha256",
    reference.objectId.slice(0, 2),
    `${reference.objectId}.cso`,
  );
}

async function withRepository(
  run: (repository: SyncRepository, root: string) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-prepare-test-"));
  const root = join(temporaryRoot, "repository");
  try {
    const repository = await SyncRepository.create(
      root,
      join(temporaryRoot, "storage"),
      PASSPHRASE,
      1024 * 1024,
      PRODUCER,
    );
    await run(repository, root);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
