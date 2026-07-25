import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { EventReconciler, compareTips } from "../src/protocol/reconciler";
import {
  autoMergeConflicts,
  throttleConflictedRepublish,
} from "../src/sync/manager";
import { sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import type {
  EventProducer,
  JsonValue,
  ResourceKind,
  ResourceSnapshot,
  SyncConflict,
} from "../src/types";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

/**
 * The kinds of key the user's live repository was stuck on: every one of the 23
 * unresolved conflicts was `ui-state` with `baseVersionId === null`, because the
 * two machines each minted the value locally and neither side's version ever
 * descended from the other's.
 */
const OBSERVED_KEYS = [
  "cursor%2FupdatePromptLastPromptTime",
  "cursor%2FterminalExecutionServiceV3HealthCheckResult",
  "glass.cloudAgentProjects.v1",
  "remote.tunnels.toRestore.wsl%2BUbuntu",
];

describe("base-free conflicts", () => {
  it("auto-resolves the 23-style base-free ui-state conflicts", async () => {
    await withRepository(async (repository) => {
      for (const key of OBSERVED_KEYS) {
        await forkWithoutBase(
          repository,
          `ui-state/${key}`,
          "ui-state",
          Buffer.from(`${key}-a`, "utf8"),
          Buffer.from(`${key}-b`, "utf8"),
        );
      }
      const conflicts = await reconcileConflicts(repository);
      expect(conflicts).toHaveLength(OBSERVED_KEYS.length);
      // The whole point: no common ancestor, so no three-way merge exists.
      expect(
        conflicts.every((conflict) => conflict.baseVersionId === null),
      ).toBe(true);

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);

      expect(
        conflicts.every((conflict) => conflict.resolvedAt !== undefined),
      ).toBe(true);
      expect(await reconcileConflicts(repository)).toHaveLength(0);
      for (const key of OBSERVED_KEYS) {
        expect(repository.state.tips[`ui-state/${key}`]).toHaveLength(1);
      }
    });
  });

  it("republishes the winning tip verbatim, hash and metadata included", async () => {
    await withRepository(async (repository) => {
      const resourceId = "ui-state/cursor%2FupdatePromptLastPromptTime";
      await forkWithoutBase(
        repository,
        resourceId,
        "ui-state",
        Buffer.from("1700000000000", "utf8"),
        Buffer.from("1800000000000", "utf8"),
      );
      const conflicts = await reconcileConflicts(repository);
      const winner = [...(repository.state.tips[resourceId] ?? [])].sort(
        compareTips,
      )[0];
      const winnerContent = await repository.readVersion(
        winner?.versionId ?? "",
      );

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      await reconcileConflicts(repository);

      const tips = repository.state.tips[resourceId] ?? [];
      expect(tips).toHaveLength(1);
      const resolved = await repository.readVersion(tips[0]?.versionId ?? "");
      expect(
        resolved.content?.equals(winnerContent.content ?? Buffer.alloc(0)),
      ).toBe(true);
      // The hash is the winner's own, so the reconciler collapses this event
      // against the byte-identical one the other device publishes.
      expect(tips[0]?.semanticHash).toBe(winner?.semanticHash);
      // valueType decides whether the helper binds the value as TEXT or BLOB.
      expect(tips[0]?.metadata?.valueType).toBe(winner?.metadata?.valueType);
      expect(tips[0]?.metadata?.syncOrigin).toBe("auto-merge");
    });
  });

  it("elects the same winner and the same metadata on both devices", async () => {
    // Two devices resolving the same base-free fork with no communication must
    // emit byte-identical content AND identical metadata, or the reconciler —
    // which collapses two tips on operation plus semanticHash alone — leaves
    // whichever device published last deciding the ui-state storage class.
    await withTemporaryRoot(async (temporaryRoot) => {
      const resourceId = "ui-state/glass.cloudAgentProjects.v1";
      const shared = join(temporaryRoot, "repository");
      const storageA = join(temporaryRoot, "storage-a");
      const storageB = join(temporaryRoot, "storage-b");

      const deviceA = await SyncRepository.create(
        shared,
        storageA,
        PASSPHRASE,
        1024 * 1024,
        PRODUCER,
      );
      await deviceA.publish(
        [
          {
            ...typedSnapshot(resourceId, Buffer.from('["a"]', "utf8"), "text"),
            parents: [],
          },
        ],
        [],
      );
      await deviceA.saveState();

      const deviceB = await SyncRepository.open(
        shared,
        storageB,
        PASSPHRASE,
        1024 * 1024,
        PRODUCER,
      );
      await deviceB.refreshState();
      // Device B minted its own value before it ever saw device A's: no parent.
      await deviceB.publish(
        [
          {
            ...typedSnapshot(resourceId, Buffer.from('["b"]', "utf8"), "blob"),
            parents: [],
          },
        ],
        [],
      );
      await deviceB.saveState();

      const [fromA, fromB] = [
        await resolveAsDevice(temporaryRoot, "a", shared, storageA, resourceId),
        await resolveAsDevice(temporaryRoot, "b", shared, storageB, resourceId),
      ];

      expect(fromA.content.equals(fromB.content)).toBe(true);
      expect(fromA.metadata).toEqual(fromB.metadata);
      expect(fromA.semanticHash).toBe(fromB.semanticHash);
      // The two sides really did disagree about the storage class, so the
      // agreement above is the comparator's doing and not a coincidence.
      expect([...fromA.forkedValueTypes].sort()).toEqual(["blob", "text"]);
      expect(fromA.metadata?.valueType).toBe(fromA.newestValueType);
    });
  });

  it("lets a put beat a delete whatever the comparator says", async () => {
    await withRepository(async (repository) => {
      const resourceId = "ui-state/remote.tunnels.toRestore.wsl%2BUbuntu";
      const content = Buffer.from('{"host":"ubuntu"}', "utf8");
      await repository.publish(
        [{ ...snapshot(resourceId, "ui-state", content), parents: [] }],
        [],
      );
      // Published second, so this is the tip the comparator would elect.
      await repository.publish(
        [],
        [
          {
            resourceId,
            kind: "ui-state",
            semanticHash: sha256(Buffer.alloc(0)),
            metadata: { key: "remote.tunnels.toRestore.wsl+Ubuntu" },
            parents: [],
          },
        ],
      );
      const conflicts = await reconcileConflicts(repository);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.baseVersionId).toBeNull();
      const newest = [...(repository.state.tips[resourceId] ?? [])].sort(
        compareTips,
      )[0];
      expect(newest?.operation).toBe("delete");

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      await reconcileConflicts(repository);

      const tips = repository.state.tips[resourceId] ?? [];
      expect(tips).toHaveLength(1);
      // A losing delete is recoverable — the deleting side can remove the key
      // again. A losing put throws away the only copy of the value.
      expect(tips[0]?.operation).toBe("put");
      const resolved = await repository.readVersion(tips[0]?.versionId ?? "");
      expect(resolved.content?.equals(content)).toBe(true);
    });
  });

  it("still asks the user for a base-free conflict of a content-bearing kind", async () => {
    const contentBearing: Array<[string, ResourceKind]> = [
      ["cursor-user-rules/aicontext.personalContext", "cursor-user-rules"],
      ["settings/default/editor.fontSize", "settings"],
      ["cursor-user-file/rules%2Fteam.mdc", "cursor-user-file"],
      ["chat/composer%2Fabc", "chat"],
    ];
    for (const [resourceId, kind] of contentBearing) {
      await withRepository(async (repository) => {
        await forkWithoutBase(
          repository,
          resourceId,
          kind,
          Buffer.from("mine\n", "utf8"),
          Buffer.from("theirs\n", "utf8"),
        );
        const conflicts = await reconcileConflicts(repository);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.baseVersionId).toBeNull();

        // Silently discarding the loser here would destroy authored content.
        expect(await autoMergeConflicts(repository, conflicts)).toBe(false);
        expect(conflicts[0]?.resolvedAt).toBeUndefined();
        expect(repository.state.tips[resourceId]).toHaveLength(2);
      });
    }
  });
});

describe("conflicted republish throttle", () => {
  const RESOURCE = "chat/composer%2Fvolatile";
  const HOUR = 60 * 60 * 1000;

  function volatileSnapshot(cycle: number): { resourceId: string; hash: string } {
    // A conflicted resource gets no projection, so the only short-circuit left
    // in `shouldPublishSnapshot` is "matches an existing tip" — and a value
    // Cursor rewrites every few seconds never does.
    return { resourceId: RESOURCE, hash: `hash-${cycle}` };
  }

  it("does not emit a new event on every cycle for a volatile conflicted resource", () => {
    const conflicted = new Set([RESOURCE]);
    const seen = new Map<string, number>();
    const published: number[] = [];
    const start = Date.parse("2026-07-25T00:00:00.000Z");

    // Two hours of a 30-second poll.
    for (let cycle = 0; cycle < 240; cycle += 1) {
      const result = throttleConflictedRepublish(
        [volatileSnapshot(cycle)],
        conflicted,
        seen,
        start + cycle * 30_000,
        HOUR,
      );
      if (result.publish.length > 0) {
        published.push(cycle);
      }
    }

    // Without the throttle this was 240 genuinely-new events for one resource;
    // 23 of them on a 30-second poll is what grew the repository by thousands
    // of events a day.
    expect(published).toEqual([0, 120]);
  });

  it("keeps representing a freshly forked resource immediately", () => {
    const seen = new Map<string, number>();
    const now = Date.parse("2026-07-25T00:00:00.000Z");

    const first = throttleConflictedRepublish(
      [{ resourceId: RESOURCE }],
      new Set([RESOURCE]),
      seen,
      now,
      HOUR,
    );

    expect(first.publish).toHaveLength(1);
    expect(first.deferred).toEqual([]);
  });

  it("never throttles a resource that is not in conflict", () => {
    const seen = new Map<string, number>();
    const now = Date.parse("2026-07-25T00:00:00.000Z");

    for (let cycle = 0; cycle < 10; cycle += 1) {
      const result = throttleConflictedRepublish(
        [{ resourceId: "settings/default/editor.fontSize" }],
        new Set([RESOURCE]),
        seen,
        now + cycle * 30_000,
        HOUR,
      );
      expect(result.publish).toHaveLength(1);
    }
  });

  it("forgets a resource once its conflict is resolved", () => {
    const seen = new Map<string, number>();
    const now = Date.parse("2026-07-25T00:00:00.000Z");

    throttleConflictedRepublish(
      [{ resourceId: RESOURCE }],
      new Set([RESOURCE]),
      seen,
      now,
      HOUR,
    );
    expect(seen.has(RESOURCE)).toBe(true);

    // Conflict resolved: the bookkeeping goes away with it, so a fork that
    // reappears later publishes at once instead of waiting out the interval.
    throttleConflictedRepublish([], new Set(), seen, now + 1_000, HOUR);
    expect(seen.size).toBe(0);

    const again = throttleConflictedRepublish(
      [{ resourceId: RESOURCE }],
      new Set([RESOURCE]),
      seen,
      now + 2_000,
      HOUR,
    );
    expect(again.publish).toHaveLength(1);
  });
});

function snapshot(
  resourceId: string,
  kind: ResourceKind,
  content: Buffer,
): ResourceSnapshot {
  return {
    resourceId,
    kind,
    content,
    semanticHash: sha256(content),
    metadata: { key: resourceId.split("/")[1] ?? "", valueType: "text" },
  };
}

function typedSnapshot(
  resourceId: string,
  content: Buffer,
  valueType: string,
): ResourceSnapshot {
  return {
    ...snapshot(resourceId, "ui-state", content),
    metadata: { key: resourceId.split("/")[1] ?? "", valueType },
  };
}

/** Two roots for one resource: neither version descends from the other. */
async function forkWithoutBase(
  repository: SyncRepository,
  resourceId: string,
  kind: ResourceKind,
  left: Buffer,
  right: Buffer,
): Promise<void> {
  for (const content of [left, right]) {
    await repository.publish(
      [{ ...snapshot(resourceId, kind, content), parents: [] }],
      [],
    );
  }
}

async function resolveAsDevice(
  temporaryRoot: string,
  name: string,
  shared: string,
  storage: string,
  resourceId: string,
): Promise<{
  metadata: Record<string, JsonValue> | undefined;
  semanticHash: string | undefined;
  content: Buffer;
  forkedValueTypes: Array<JsonValue | undefined>;
  newestValueType: JsonValue | undefined;
}> {
  const root = join(temporaryRoot, `run-${name}`);
  await cp(shared, join(root, "repository"), { recursive: true });
  await cp(storage, join(root, "storage"), { recursive: true });
  const repository = await SyncRepository.open(
    join(root, "repository"),
    join(root, "storage"),
    PASSPHRASE,
    1024 * 1024,
    PRODUCER,
  );
  await repository.refreshState();
  const conflicts = await reconcileConflicts(repository);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]?.baseVersionId).toBeNull();
  const forked = [...(repository.state.tips[resourceId] ?? [])].sort(
    compareTips,
  );
  expect(forked).toHaveLength(2);

  expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
  await reconcileConflicts(repository);
  const tips = repository.state.tips[resourceId] ?? [];
  expect(tips).toHaveLength(1);
  const resolved = await repository.readVersion(tips[0]?.versionId ?? "");
  return {
    metadata: tips[0]?.metadata,
    semanticHash: tips[0]?.semanticHash,
    content: resolved.content ?? Buffer.alloc(0),
    forkedValueTypes: [...forked]
      .reverse()
      .map((tip) => tip.metadata?.valueType),
    newestValueType: forked[0]?.metadata?.valueType,
  };
}

async function reconcileConflicts(
  repository: SyncRepository,
): Promise<SyncConflict[]> {
  return new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  ).conflicts;
}

async function withRepository<T>(
  run: (repository: SyncRepository) => Promise<T>,
): Promise<T> {
  return withTemporaryRoot(async (temporaryRoot) =>
    run(
      await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        PASSPHRASE,
        1024 * 1024,
        PRODUCER,
      ),
    ),
  );
}

async function withTemporaryRoot<T>(
  run: (temporaryRoot: string) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "cursor-setting-sync-base-free-"),
  );
  try {
    return await run(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
