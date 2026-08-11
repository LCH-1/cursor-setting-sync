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
import { sha256 } from "../src/protocol/canonical";
import type {
  EventProducer,
  JsonValue,
  ResourceSnapshot,
  ResourceTip,
} from "../src/types";
import type { HelperChange, HelperRequest } from "../src/helper/types";
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
      {} as SyncRepository,
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
