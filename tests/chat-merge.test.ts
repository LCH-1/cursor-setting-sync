import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { EventReconciler, compareTips } from "../src/protocol/reconciler";
import { autoMergeConflicts } from "../src/sync/manager";
import { mergeChatSnapshotBuffers } from "../src/chat/chatMerge";
import {
  parsePortableChatSnapshot,
  type PortableChatSnapshot,
  type PortableKvRow,
} from "../src/chat/stateVscdb";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import type {
  EventProducer,
  ResourceSnapshot,
  SyncConflict,
} from "../src/types";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

const COMPOSER = "026e7136-6ca9-4847-9328-6fc5a697c651";

describe("mergeChatSnapshotBuffers", () => {
  it("keeps every bubble either side captured", () => {
    // The live case: one device holds 4 bubbles the other has not seen yet.
    const first = chat({ bubbles: ["b1", "b2", "b3"], lastUpdatedAt: 200 });
    const second = chat({ bubbles: ["b1", "b4"], lastUpdatedAt: 100 });

    const outcome = mergeChatSnapshotBuffers(null, [first, second]);

    expect(outcome.status).toBe("merged");
    expect(bubbleKeys(outcome.content)).toEqual([
      bubbleKey("b1"),
      bubbleKey("b2"),
      bubbleKey("b3"),
      bubbleKey("b4"),
    ]);
    expect(outcome.bubbleCount).toBe(4);
  });

  it("adopts the header of the newer capture, not of the first argument", () => {
    const older = chat({ bubbles: ["b1"], lastUpdatedAt: 100, title: "old" });
    const newer = chat({ bubbles: ["b1"], lastUpdatedAt: 900, title: "new" });

    // The newer side is passed second, so a merge that just took `ordered[0]`
    // would silently adopt the stale title.
    const outcome = mergeChatSnapshotBuffers(null, [older, newer]);

    expect(header(outcome.content).value).toBe("new");
    expect(header(outcome.content).lastUpdatedAt).toBe(900);
    expect(outcome.winner).toBe(1);
  });

  it("never lets a null timestamp outrank a real one", () => {
    // The live `73d39056` fork: 58 bubbles with a timestamp against 0 bubbles
    // with none. Electing the empty side would drop the whole conversation.
    const populated = chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 1_000 });
    const empty = chat({ bubbles: [], lastUpdatedAt: null });

    for (const ordered of [
      [populated, empty] as const,
      [empty, populated] as const,
    ]) {
      const outcome = mergeChatSnapshotBuffers(null, ordered);
      expect(header(outcome.content).lastUpdatedAt).toBe(1_000);
      expect(bubbleKeys(outcome.content)).toHaveLength(2);
    }
  });

  it("produces identical bytes whichever device runs it", () => {
    // Both devices sort the same two tips with the same comparator, so both
    // call this with the same order; the tie-break must not depend on anything
    // else either. Equal timestamps make the tie-break the only thing deciding.
    const left = chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 500, title: "L" });
    const right = chat({ bubbles: ["b2", "b3"], lastUpdatedAt: 500, title: "R" });

    const once = mergeChatSnapshotBuffers(null, [left, right]);
    const twice = mergeChatSnapshotBuffers(null, [left, right]);

    expect(once.content?.equals(twice.content ?? Buffer.alloc(0))).toBe(true);
    expect(once.semanticHash).toBe(twice.semanticHash);
    // Ordering by key, which is what `ORDER BY key` reads back on the next scan.
    expect(bubbleKeys(once.content)).toEqual([
      bubbleKey("b1"),
      bubbleKey("b2"),
      bubbleKey("b3"),
    ]);
  });

  it("hashes exactly what the adapter's next scan will hash", () => {
    // The 0.0.5 JSONC bug in a new place: publishing a hash the next scan does
    // not recompute republishes the resource on every cycle forever.
    const outcome = mergeChatSnapshotBuffers(null, [
      chat({ bubbles: ["b1"], lastUpdatedAt: 2 }),
      chat({ bubbles: ["b2"], lastUpdatedAt: 1 }),
    ]);
    const content = outcome.content ?? Buffer.alloc(0);

    expect(outcome.semanticHash).toBe(sha256(content));
    // A round trip through the adapter's own parse and re-serialize is a
    // fixed point, so the value the helper writes is the value that is read.
    expect(canonicalBytes(parsePortableChatSnapshot(content)).equals(content)).toBe(
      true,
    );
  });

  it("honours a deletion when a base says the bubble once existed", () => {
    const base = chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 1 });
    const kept = chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 3 });
    const trimmed = chat({ bubbles: ["b1"], lastUpdatedAt: 2 });

    const merged = mergeChatSnapshotBuffers(base, [kept, trimmed]);
    expect(bubbleKeys(merged.content)).toEqual([bubbleKey("b1")]);

    // Without the base the same pair is an addition, not a deletion.
    const unioned = mergeChatSnapshotBuffers(null, [kept, trimmed]);
    expect(bubbleKeys(unioned.content)).toEqual([bubbleKey("b1"), bubbleKey("b2")]);
  });

  it("declines a payload it cannot parse instead of electing a side", () => {
    // `chat/empty-state-draft` is a real composer row whose ID is not a UUID,
    // so the parser rejects it - and so would the apply side. Guessing here
    // would throw away a side of something no build can even read.
    const unparseable = Buffer.from('{"schemaVersion":1}', "utf8");
    const valid = chat({ bubbles: ["b1"], lastUpdatedAt: 5 });

    expect(mergeChatSnapshotBuffers(null, [valid, unparseable]).status).toBe(
      "conflict",
    );
    expect(mergeChatSnapshotBuffers(null, [unparseable, unparseable]).status).toBe(
      "conflict",
    );
  });

  it("declines rather than throwing on a payload built to break serialization", () => {
    // `parsePortableChatSnapshot` validates the fields this format defines and
    // leaves the ones it does not, so a peer can attach a property deep enough
    // to overflow the recursive canonical serializer. `autoMergeConflicts` runs
    // before the scan, the publish and the apply, and an error escaping it
    // aborts the whole cycle — permanently, because the events are immutable and
    // the next poll rebuilds the identical conflict.
    // Written as raw text rather than built as a value: at this depth
    // JSON.stringify overflows too, while JSON.parse - and therefore the
    // adapter's own validation - accepts it happily.
    const depth = 6_000;
    const nested = `${"[".repeat(depth)}1${"]".repeat(depth)}`;
    const hostile = Buffer.from(
      chat({ bubbles: ["b1"], lastUpdatedAt: 9 })
        .toString("utf8")
        .replace('"header":{', `"header":{"hostile":${nested},`),
      "utf8",
    );
    // The premise: this really does pass the gate the apply side uses.
    expect(() => parsePortableChatSnapshot(hostile)).not.toThrow();

    const other = chat({ bubbles: ["b2"], lastUpdatedAt: 8 });
    expect(() => mergeChatSnapshotBuffers(null, [hostile, other])).not.toThrow();
    expect(mergeChatSnapshotBuffers(null, [hostile, other]).status).toBe(
      "conflict",
    );
  });

  it("declines two different conversations", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    expect(
      mergeChatSnapshotBuffers(null, [
        chat({ bubbles: ["b1"], lastUpdatedAt: 1 }),
        chat({ bubbles: ["b1"], lastUpdatedAt: 2, composerId: other }),
      ]).status,
    ).toBe("conflict");
  });
});

describe("base-free chat conflicts", () => {
  it("resolves a fork whose two sides hold the same conversation", async () => {
    // 32 of the 36 conflicts in the live repository were this: identical bubble
    // counts, identical lastUpdatedAt, differing only in machine-local header
    // fields. Nobody could have adjudicated them from a diff.
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      await publishFork(
        repository,
        resourceId,
        chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 7, recency: 1 }),
        chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 7, recency: 9 }),
      );
      const conflicts = await reconcileConflicts(repository);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.baseVersionId).toBeNull();

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);

      expect(await reconcileConflicts(repository)).toHaveLength(0);
      const tips = repository.state.tips[resourceId] ?? [];
      expect(tips).toHaveLength(1);
      expect(tips[0]?.metadata?.syncOrigin).toBe("auto-merge");
      const resolved = await repository.readVersion(tips[0]?.versionId ?? "");
      expect(bubbleKeys(resolved.content ?? undefined)).toHaveLength(2);
    });
  });

  it("resolves a real divergence by union rather than by discarding a side", async () => {
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      await publishFork(
        repository,
        resourceId,
        chat({ bubbles: ["b1", "b2", "b3"], lastUpdatedAt: 10 }),
        chat({ bubbles: ["b1", "b4"], lastUpdatedAt: 20 }),
      );
      const conflicts = await reconcileConflicts(repository);

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      await reconcileConflicts(repository);

      const tips = repository.state.tips[resourceId] ?? [];
      const resolved = await repository.readVersion(tips[0]?.versionId ?? "");
      // Nothing was thrown away, and the count that travels with the tip
      // describes the union rather than the winning side.
      expect(bubbleKeys(resolved.content ?? undefined)).toHaveLength(4);
      expect(tips[0]?.metadata?.bubbleCount).toBe(4);
      expect(header(resolved.content ?? undefined).lastUpdatedAt).toBe(20);
    });
  });

  it("honours a deletion through the three-way path when a base survives", async () => {
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      const base = await repository.publish(
        [
          {
            ...chatSnapshot(
              resourceId,
              chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 1 }),
            ),
            parents: [],
          },
        ],
        [],
      );
      const baseVersion = `${base.eventHash ?? ""}#0`;
      // Both sides descend from the base, so this fork has a real merge base
      // and takes the three-way path rather than the base-free one.
      for (const side of [
        chat({ bubbles: ["b1", "b2", "b3"], lastUpdatedAt: 30 }),
        chat({ bubbles: ["b1"], lastUpdatedAt: 20 }),
      ]) {
        await repository.publish(
          [{ ...chatSnapshot(resourceId, side), parents: [baseVersion] }],
          [],
        );
      }
      const conflicts = await reconcileConflicts(repository);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.baseVersionId).toBe(baseVersion);

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      await reconcileConflicts(repository);

      const tips = repository.state.tips[resourceId] ?? [];
      expect(tips).toHaveLength(1);
      const resolved = await repository.readVersion(tips[0]?.versionId ?? "");
      // b3 is an addition and survives; b2 was in the base and one side removed
      // it, which is a deletion and is honoured rather than resurrected.
      expect(bubbleKeys(resolved.content ?? undefined)).toEqual([
        bubbleKey("b1"),
        bubbleKey("b3"),
      ]);
    });
  });

  it("still asks when the payload is not a snapshot this build can parse", async () => {
    await withRepository(async (repository) => {
      const resourceId = "chat/empty-state-draft";
      await publishFork(
        repository,
        resourceId,
        Buffer.from("mine\n", "utf8"),
        Buffer.from("theirs\n", "utf8"),
      );
      const conflicts = await reconcileConflicts(repository);

      // Falling back to last-writer-wins here would discard a side of something
      // that no build can read - the loser would not even be recoverable by
      // picking it in the resolver.
      expect(await autoMergeConflicts(repository, conflicts)).toBe(false);
      expect(conflicts[0]?.resolvedAt).toBeUndefined();
      expect(repository.state.tips[resourceId]).toHaveLength(2);
    });
  });

  it("reaches the same result on both devices with no communication", async () => {
    await withTemporaryRoot(async (temporaryRoot) => {
      const resourceId = `chat/${COMPOSER}`;
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
            ...chatSnapshot(
              resourceId,
              chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 400, recency: 1 }),
            ),
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
      // Device B captured its own copy before it ever saw device A's: no parent.
      await deviceB.publish(
        [
          {
            ...chatSnapshot(
              resourceId,
              chat({ bubbles: ["b2", "b3"], lastUpdatedAt: 400, recency: 8 }),
            ),
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
      expect(fromA.semanticHash).toBe(fromB.semanticHash);
      // Identical metadata matters as much as identical bytes: the reconciler
      // collapses two tips on operation plus semanticHash alone, so differing
      // metadata would leave whichever device published last deciding it.
      expect(fromA.metadata).toEqual(fromB.metadata);
      expect(bubbleKeys(fromA.content)).toHaveLength(3);
    });
  });
});

function chat(options: {
  bubbles: readonly string[];
  lastUpdatedAt: number | null;
  title?: string;
  recency?: number;
  composerId?: string;
}): Buffer {
  const composerId = options.composerId ?? COMPOSER;
  const snapshot: PortableChatSnapshot = {
    schemaVersion: 1,
    composerId,
    header: {
      composerId,
      workspaceId: "48710bdaa43062a17d2bdebe7b5aac75",
      createdAt: 1,
      lastUpdatedAt: options.lastUpdatedAt,
      isArchived: 0,
      isSubagent: 0,
      // Machine-local ordering: the field that made two identical captures
      // publish different bytes on the user's two machines.
      recency: options.recency ?? 0,
      checkpointAt: null,
      value: options.title ?? "conversation",
    },
    composerData: row(`composerData:${composerId}`, options.title ?? "body"),
    bubbles: options.bubbles.map((id) =>
      row(`bubbleId:${composerId}:${id}`, id),
    ),
  };
  return canonicalBytes(snapshot);
}

function row(key: string, value: string): PortableKvRow {
  return {
    key,
    valueBase64: Buffer.from(value, "utf8").toString("base64"),
    valueType: "text",
  };
}

function bubbleKey(id: string): string {
  return `bubbleId:${COMPOSER}:${id}`;
}

function bubbleKeys(content: Buffer | undefined): string[] {
  return parsePortableChatSnapshot(content ?? Buffer.alloc(0)).bubbles.map(
    (bubble) => bubble.key,
  );
}

function header(
  content: Buffer | undefined,
): PortableChatSnapshot["header"] {
  return parsePortableChatSnapshot(content ?? Buffer.alloc(0)).header;
}

function chatSnapshot(resourceId: string, content: Buffer): ResourceSnapshot {
  return {
    resourceId,
    kind: "chat",
    content,
    semanticHash: sha256(content),
    metadata: {
      composerId: resourceId.slice("chat/".length),
      workspaceId: "48710bdaa43062a17d2bdebe7b5aac75",
      workspaceUri: null,
    },
  };
}

/** Two roots for one resource: neither version descends from the other. */
async function publishFork(
  repository: SyncRepository,
  resourceId: string,
  left: Buffer,
  right: Buffer,
): Promise<void> {
  for (const content of [left, right]) {
    await repository.publish(
      [{ ...chatSnapshot(resourceId, content), parents: [] }],
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
  metadata: Record<string, unknown> | undefined;
  semanticHash: string | undefined;
  content: Buffer;
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
  expect([...(repository.state.tips[resourceId] ?? [])].sort(compareTips)).toHaveLength(
    2,
  );

  expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
  await reconcileConflicts(repository);
  const tips = repository.state.tips[resourceId] ?? [];
  expect(tips).toHaveLength(1);
  const resolved = await repository.readVersion(tips[0]?.versionId ?? "");
  return {
    metadata: tips[0]?.metadata,
    semanticHash: tips[0]?.semanticHash,
    content: resolved.content ?? Buffer.alloc(0),
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
    join(tmpdir(), "cursor-setting-sync-chat-merge-"),
  );
  try {
    return await run(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
