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
  portableChatCoreHash,
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

  it("preserves a base bubble pruned from one device", () => {
    const base = chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 1 });
    const kept = chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 3 });
    const trimmed = chat({ bubbles: ["b1"], lastUpdatedAt: 2 });

    const merged = mergeChatSnapshotBuffers(base, [kept, trimmed]);
    expect(bubbleKeys(merged.content)).toEqual([bubbleKey("b1"), bubbleKey("b2")]);

    // With or without a base, one-sided rows are an additive union because
    // Cursor does not expose per-message deletion.
    const unioned = mergeChatSnapshotBuffers(null, [kept, trimmed]);
    expect(bubbleKeys(unioned.content)).toEqual([bubbleKey("b1"), bubbleKey("b2")]);
  });

  it("preserves a base bubble pruned from both fork tips", () => {
    const base = chat({ bubbles: ["b1", "b2"], lastUpdatedAt: 1 });
    const left = chat({ bubbles: ["b1", "b3"], lastUpdatedAt: 3 });
    const right = chat({ bubbles: ["b1", "b4"], lastUpdatedAt: 2 });

    const merged = mergeChatSnapshotBuffers(base, [left, right]);
    expect(bubbleKeys(merged.content)).toEqual([
      bubbleKey("b1"),
      bubbleKey("b2"),
      bubbleKey("b3"),
      bubbleKey("b4"),
    ]);

    // Byte-identical tips still have to pass through the readable base: tip
    // equality alone cannot turn pruning on both devices into a deletion.
    const identical = chat({ bubbles: ["b1"], lastUpdatedAt: 4 });
    const restored = mergeChatSnapshotBuffers(base, [identical, identical]);
    expect(restored.status).toBe("merged");
    expect(bubbleKeys(restored.content)).toEqual([
      bubbleKey("b1"),
      bubbleKey("b2"),
    ]);
  });

  it("keeps the same-key row changed from the base even when the other header wins", () => {
    const base = chat({ bubbles: ["b1"], lastUpdatedAt: 1 });
    const completed = withBubbleValue(
      chat({ bubbles: ["b1"], lastUpdatedAt: 2 }),
      "b1",
      "completed content",
    );
    const newerButPruned = chat({
      bubbles: ["b1", "b2"],
      lastUpdatedAt: 3,
    });

    const outcome = mergeChatSnapshotBuffers(base, [completed, newerButPruned]);

    expect(outcome.status).toBe("merged");
    expect(outcome.winner).toBe(1);
    expect(bubbleValue(outcome.content, "b1")).toBe("completed content");
    expect(bubbleKeys(outcome.content)).toEqual([
      bubbleKey("b1"),
      bubbleKey("b2"),
    ]);
  });

  it("keeps ambiguous same-key row disagreements manual", () => {
    const base = chat({ bubbles: ["b1"], lastUpdatedAt: 1 });
    const left = withBubbleValue(
      chat({ bubbles: ["b1"], lastUpdatedAt: 3 }),
      "b1",
      "left content",
    );
    const right = withBubbleValue(
      chat({ bubbles: ["b1"], lastUpdatedAt: 2 }),
      "b1",
      "right content",
    );

    expect(mergeChatSnapshotBuffers(base, [left, right]).status).toBe(
      "conflict",
    );
    expect(mergeChatSnapshotBuffers(null, [left, right]).status).toBe(
      "conflict",
    );
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
    // The shared apply-side parser now fails closed on the same structural
    // policy, while the merge must retain its work-budget sentinel.
    expect(() => parsePortableChatSnapshot(hostile)).toThrow(
      "structural parser safety limit",
    );

    const other = chat({ bubbles: ["b2"], lastUpdatedAt: 8 });
    expect(() => mergeChatSnapshotBuffers(null, [hostile, other])).not.toThrow();
    expect(mergeChatSnapshotBuffers(null, [hostile, other]).status).toBe(
      "conflict",
    );
    expect(
      mergeChatSnapshotBuffers(null, [hostile, other]).workBudgetExceeded,
    ).toBe(true);
  });

  it("rejects minified structural amplification before snapshot parsing", () => {
    const empty = chat({ bubbles: [], lastUpdatedAt: 9 }).toString("utf8");
    // These intentionally invalid rows make the ordering observable: if the
    // snapshot parser ran first it would return an ordinary parse conflict.
    // The work-budget sentinel proves the allocation-free structural scan
    // rejected the compact 22,000-object array before JSON.parse materialized
    // it. The payload is nowhere near the 32 MiB byte cap.
    const tinyObjects = Array.from({ length: 22_000 }, () => "{}").join(",");
    const hostile = Buffer.from(
      empty.replace('"bubbles":[]', `"bubbles":[${tinyObjects}]`),
      "utf8",
    );
    expect(hostile.byteLength).toBeLessThan(32 * 1024 * 1024);

    const outcome = mergeChatSnapshotBuffers(null, [
      hostile,
      chat({ bubbles: ["safe"], lastUpdatedAt: 8 }),
    ]);
    expect(outcome.status).toBe("conflict");
    expect(outcome.workBudgetExceeded).toBe(true);
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

  it("upgrades v1/v2 merges and unions reachable agentKv blobs deterministically", () => {
    const blobA = Buffer.from("blob-a", "utf8");
    const blobB = Buffer.from("blob-b", "utf8");
    const missingC = "f".repeat(64);
    const first = chatV2(
      { bubbles: ["b1"], lastUpdatedAt: 1 },
      [blobA],
      [sha256(blobB)],
    );
    const second = chatV2(
      { bubbles: ["b2"], lastUpdatedAt: 2 },
      [blobB],
      [missingC],
    );

    const outcome = mergeChatSnapshotBuffers(null, [first, second]);
    const parsed = parsePortableChatSnapshot(outcome.content ?? Buffer.alloc(0));
    expect(parsed.schemaVersion).toBe(2);
    if (parsed.schemaVersion !== 2) {
      throw new Error("expected v2 merge");
    }
    expect(parsed.agentKv.blobs.map((row) => row.key)).toEqual(
      [sha256(blobA), sha256(blobB)]
        .sort()
        .map((id) => `agentKv:blob:${id}`),
    );
    expect(parsed.agentKv.referencedIds).toEqual(
      [sha256(blobA), sha256(blobB), missingC].sort(),
    );
    // The second side materializes the first side's missing ID.
    expect(parsed.agentKv.missingIds).toEqual([missingC]);

    const legacy = chat({ bubbles: ["b3"], lastUpdatedAt: 3 });
    const upgraded = mergeChatSnapshotBuffers(null, [legacy, first]);
    expect(
      parsePortableChatSnapshot(upgraded.content ?? Buffer.alloc(0))
        .schemaVersion,
    ).toBe(2);

    const preservedBase = mergeChatSnapshotBuffers(first, [
      chat({ bubbles: ["b1", "new-a"], lastUpdatedAt: 4 }),
      chat({ bubbles: ["b1", "new-b"], lastUpdatedAt: 5 }),
    ]);
    const fromBase = parsePortableChatSnapshot(
      preservedBase.content ?? Buffer.alloc(0),
    );
    expect(fromBase.schemaVersion).toBe(2);
    expect(
      fromBase.schemaVersion === 2
        ? fromBase.agentKv.blobs.map((blob) => blob.key)
        : [],
    ).toEqual([`agentKv:blob:${sha256(blobA)}`]);
  });

  it("declines a disjoint agentKv reference union above the merge node cap", () => {
    // Each side is a valid bounded v2 payload on its own. Only their disjoint
    // union crosses the conflict merge's tighter interactive-work limit.
    const firstIds = Array.from({ length: 2_048 }, (_unused, index) =>
      sha256(`first-disjoint-reference-${index}`),
    );
    const secondIds = Array.from({ length: 2_049 }, (_unused, index) =>
      sha256(`second-disjoint-reference-${index}`),
    );
    const first = chatV2(
      { bubbles: ["first"], lastUpdatedAt: 1 },
      [],
      firstIds,
    );
    const second = chatV2(
      { bubbles: ["second"], lastUpdatedAt: 2 },
      [],
      secondIds,
    );
    expect(parsePortableChatSnapshot(first).schemaVersion).toBe(2);
    expect(parsePortableChatSnapshot(second).schemaVersion).toBe(2);

    expect(mergeChatSnapshotBuffers(null, [first, second]).status).toBe(
      "conflict",
    );
  });

  it("declines a disjoint agentKv blob union above the decoded-byte cap", () => {
    // The first side is exactly at the 32 MiB merge allowance and remains a
    // valid standalone snapshot under the parser's compatibility ceiling. A
    // single byte from the other valid side must fail before a larger Map or
    // merged JSON/Base64 payload is constructed.
    const first = chatV2(
      { bubbles: ["first"], lastUpdatedAt: 1 },
      [Buffer.alloc(32 * 1024 * 1024, 0x61)],
    );
    const second = chatV2(
      { bubbles: ["second"], lastUpdatedAt: 2 },
      [Buffer.from([0x62])],
    );
    expect(parsePortableChatSnapshot(first).schemaVersion).toBe(2);
    expect(parsePortableChatSnapshot(second).schemaVersion).toBe(2);

    expect(mergeChatSnapshotBuffers(null, [first, second]).status).toBe(
      "conflict",
    );
  });

  it("adds a newer v1 core root to the retained older v2 graph", () => {
    const olderBlob = Buffer.from("older complete root", "utf8");
    const olderRoot = sha256(olderBlob);
    const newerRoot = sha256("newer core root without a local blob");
    const newer = chat({
      bubbles: ["new"],
      lastUpdatedAt: 20,
      conversationState: serializedRootState([newerRoot]),
    });
    const older = chatV2(
      {
        bubbles: ["old"],
        lastUpdatedAt: 10,
        conversationState: serializedRootState([olderRoot]),
      },
      [olderBlob],
    );

    const outcome = mergeChatSnapshotBuffers(null, [newer, older]);
    expect(outcome.status).toBe("merged");
    const merged = parsePortableChatSnapshot(
      outcome.content ?? Buffer.alloc(0),
    );
    expect(merged.schemaVersion).toBe(2);
    if (merged.schemaVersion !== 2) {
      throw new Error("expected v2 merge");
    }
    expect(merged.agentKv.blobs.map((blob) => blob.key)).toEqual([
      `agentKv:blob:${olderRoot}`,
    ]);
    expect(merged.agentKv.referencedIds).toEqual(
      [newerRoot, olderRoot].sort(),
    );
    expect(merged.agentKv.missingIds).toEqual([newerRoot]);

    // Older builds could already have produced two byte-identical v2 tips
    // whose metadata claimed completeness while omitting the core root.
    const falseComplete = chatV2(
      {
        bubbles: ["same"],
        lastUpdatedAt: 30,
        conversationState: serializedRootState([newerRoot]),
      },
      [],
    );
    const corrected = mergeChatSnapshotBuffers(null, [
      falseComplete,
      falseComplete,
    ]);
    expect(corrected.status).toBe("merged");
    const correctedSnapshot = parsePortableChatSnapshot(
      corrected.content ?? Buffer.alloc(0),
    );
    expect(
      correctedSnapshot.schemaVersion === 2
        ? correctedSnapshot.agentKv.missingIds
        : [],
    ).toEqual([newerRoot]);
  });

  it.each([
    ["malformed", "~not canonical base64"],
    [
      "over-limit",
      serializedRootState(
        Array.from({ length: 4_097 }, (_unused, index) =>
          sha256(`too-many-winning-core-roots-${index}`),
        ),
      ),
    ],
  ])("declines a v2 merge whose winning core roots are %s", (_case, state) => {
    const olderBlob = Buffer.from("retained complete root", "utf8");
    const older = chatV2(
      { bubbles: ["old"], lastUpdatedAt: 1 },
      [olderBlob],
    );
    const unsafeWinner = chat({
      bubbles: ["new"],
      lastUpdatedAt: 2,
      conversationState: state,
    });

    expect(
      mergeChatSnapshotBuffers(null, [unsafeWinner, older]).status,
    ).toBe("conflict");
    const unsafeV2 = chatV2(
      {
        bubbles: ["same"],
        lastUpdatedAt: 3,
        conversationState: state,
      },
      [],
    );
    expect(
      mergeChatSnapshotBuffers(null, [unsafeV2, unsafeV2]).status,
    ).toBe("conflict");
  });
});

describe("base-free chat conflicts", () => {
  it("preflights two near-limit tips before materializing either payload", async () => {
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      await publishFork(
        repository,
        resourceId,
        chat({ bubbles: ["left"], lastUpdatedAt: 2 }),
        chat({ bubbles: ["right"], lastUpdatedAt: 1 }),
      );
      const conflicts = await reconcileConflicts(repository);
      const tips = repository.state.tips[resourceId] ?? [];
      for (const tip of tips) {
        if (tip.payload === undefined) {
          throw new Error("expected put payload metadata");
        }
        // Individually legal under repository policy; together they exceed the
        // much smaller interactive merge budget.
        tip.payload.plainBytes = Math.floor(repository.maxPayloadBytes * 0.75);
      }
      const reads = vi.spyOn(repository, "tryReadVersion");
      const publishes = vi.spyOn(repository, "publish");
      const warnings: string[] = [];

      expect(
        await autoMergeConflicts(
          repository,
          conflicts,
          () => true,
          (warning) => warnings.push(warning),
        ),
      ).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      expect(publishes).not.toHaveBeenCalled();
      expect(conflicts[0]?.resolvedAt).toBeUndefined();
      expect(warnings.join("\n")).toContain("interactive merge budget");
      expect(warnings.join("\n")).toContain("Resolve Conflicts");

      reads.mockRestore();
      publishes.mockRestore();
    });
  });

  it("materializes admissible base-free tips sequentially", async () => {
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      await publishFork(
        repository,
        resourceId,
        chat({ bubbles: ["left"], lastUpdatedAt: 2 }),
        chat({ bubbles: ["right"], lastUpdatedAt: 1 }),
      );
      const conflicts = await reconcileConflicts(repository);
      const originalRead = repository.tryReadVersion.bind(repository);
      let releaseFirst: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const started: string[] = [];
      const reads = vi
        .spyOn(repository, "tryReadVersion")
        .mockImplementation(async (versionId) => {
          started.push(versionId);
          if (started.length === 1) {
            await firstGate;
          }
          return originalRead(versionId);
        });

      const merge = autoMergeConflicts(repository, conflicts);
      await vi.waitFor(() => expect(started).toHaveLength(1));
      // Promise.all would already have entered the second materializer while
      // the first one was held. Sequential reads keep the live peak bounded.
      expect(started).toHaveLength(1);
      releaseFirst?.();
      await expect(merge).resolves.toBe(true);
      expect(started).toHaveLength(2);

      reads.mockRestore();
    });
  });

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

  it.each(["base-free", "three-way"] as const)(
    "does not publish an ambiguous %s same-key row disagreement",
    async (mode) => {
      await withRepository(async (repository) => {
        const resourceId = `chat/${COMPOSER}`;
        const baseContent = chat({ bubbles: ["b1"], lastUpdatedAt: 1 });
        const left = withBubbleValue(
          chat({ bubbles: ["b1", "left"], lastUpdatedAt: 3 }),
          "b1",
          "left content",
        );
        const right = withBubbleValue(
          chat({ bubbles: ["b1", "right"], lastUpdatedAt: 2 }),
          "b1",
          "right content",
        );
        if (mode === "base-free") {
          await publishFork(repository, resourceId, left, right);
        } else {
          const base = await repository.publish(
            [{ ...chatSnapshot(resourceId, baseContent), parents: [] }],
            [],
          );
          const baseVersion = `${base.eventHash ?? ""}#0`;
          for (const side of [left, right]) {
            await repository.publish(
              [{ ...chatSnapshot(resourceId, side), parents: [baseVersion] }],
              [],
            );
          }
        }
        const conflicts = await reconcileConflicts(repository);
        const publishes = vi.spyOn(repository, "publish");

        expect(await autoMergeConflicts(repository, conflicts)).toBe(false);
        expect(publishes).not.toHaveBeenCalled();
        expect(conflicts[0]?.resolvedAt).toBeUndefined();
        expect(repository.state.tips[resourceId]).toHaveLength(2);

        publishes.mockRestore();
      });
    },
  );

  it("recomputes v2 format metadata from the merged payload", async () => {
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      const firstBlob = Buffer.from("first merged blob", "utf8");
      const secondBlob = Buffer.from("second merged blob", "utf8");
      const unresolved = "e".repeat(64);
      const sides = [
        chatV2(
          { bubbles: ["b1"], lastUpdatedAt: 10 },
          [firstBlob],
          [sha256(secondBlob)],
        ),
        chatV2(
          { bubbles: ["b2"], lastUpdatedAt: 20 },
          [secondBlob],
          [unresolved],
        ),
      ];
      for (const [index, content] of sides.entries()) {
        await repository.publish(
          [
            {
              ...chatSnapshot(resourceId, content),
              parents: [],
              // Deliberately stale winner metadata: the merged event must not
              // claim this v2 graph is complete merely because one input did.
              metadata: {
                composerId: COMPOSER,
                chatSnapshotSchemaVersion: index === 0 ? 2 : 1,
                agentKvBlobCount: 0,
                agentKvReferencedCount: 0,
                agentKvMissingCount: 0,
                chatCoreHash: "0".repeat(64),
              },
            },
          ],
          [],
        );
      }

      const conflicts = await reconcileConflicts(repository);
      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      await reconcileConflicts(repository);

      const tip = (repository.state.tips[resourceId] ?? [])[0];
      const resolved = await repository.readVersion(tip?.versionId ?? "");
      const parsed = parsePortableChatSnapshot(
        resolved.content ?? Buffer.alloc(0),
      );
      expect(parsed.schemaVersion).toBe(2);
      if (parsed.schemaVersion !== 2) {
        throw new Error("expected a v2 auto-merge");
      }
      expect(tip?.metadata).toMatchObject({
        chatSnapshotSchemaVersion: 2,
        agentKvBlobCount: 2,
        agentKvReferencedCount: 3,
        agentKvMissingCount: 1,
        bubbleCount: 2,
        chatCoreHash: portableChatCoreHash(parsed),
      });
      expect(parsed.agentKv.missingIds).toEqual([unresolved]);
    });
  });

  it("preserves pruned base bubbles through the three-way path", async () => {
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
        chat({ bubbles: ["b1", "b3"], lastUpdatedAt: 30 }),
        chat({ bubbles: ["b1", "b4"], lastUpdatedAt: 20 }),
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
      // b3/b4 are additions and survive. b2 disappeared from both local
      // databases, but the readable base proves it is pruning rather than a
      // user deletion, so it remains as an inert row instead of shared loss.
      expect(bubbleKeys(resolved.content ?? undefined)).toEqual([
        bubbleKey("b1"),
        bubbleKey("b2"),
        bubbleKey("b3"),
        bubbleKey("b4"),
      ]);
    });
  });

  it("keeps a non-exact three-way base manual instead of dropping its pruned bubble", async () => {
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      const exactBase = parsePortableChatSnapshot(
        chat({ bubbles: ["b1", "base-only"], lastUpdatedAt: 1 }),
      );
      const baseContent = canonicalBytes({
        ...exactBase,
        harmlessFutureField: "must not be discarded",
      });
      const base = await repository.publish(
        [{ ...chatSnapshot(resourceId, baseContent), parents: [] }],
        [],
      );
      const baseVersion = `${base.eventHash ?? ""}#0`;
      for (const side of [
        chat({ bubbles: ["b1", "left"], lastUpdatedAt: 3 }),
        chat({ bubbles: ["b1", "right"], lastUpdatedAt: 2 }),
      ]) {
        await repository.publish(
          [{ ...chatSnapshot(resourceId, side), parents: [baseVersion] }],
          [],
        );
      }
      const conflicts = await reconcileConflicts(repository);
      const publishes = vi.spyOn(repository, "publish");

      expect(await autoMergeConflicts(repository, conflicts)).toBe(false);
      expect(publishes).not.toHaveBeenCalled();
      expect(conflicts[0]?.resolvedAt).toBeUndefined();
      expect(repository.state.tips[resourceId]).toHaveLength(2);

      publishes.mockRestore();
    });
  });

  it("reads no payload when three-way declared aggregate work is over budget", async () => {
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      const baseContent = chat({ bubbles: ["base"], lastUpdatedAt: 1 });
      const base = await repository.publish(
        [{ ...chatSnapshot(resourceId, baseContent), parents: [] }],
        [],
      );
      const baseVersion = `${base.eventHash ?? ""}#0`;
      for (const side of [
        chat({ bubbles: ["base", "left"], lastUpdatedAt: 3 }),
        chat({ bubbles: ["base", "right"], lastUpdatedAt: 2 }),
      ]) {
        await repository.publish(
          [{ ...chatSnapshot(resourceId, side), parents: [baseVersion] }],
          [],
        );
      }
      const conflicts = await reconcileConflicts(repository);
      const tips = repository.state.tips[resourceId] ?? [];
      const eachDeclared = Math.floor(repository.maxPayloadBytes / 2);
      for (const tip of tips) {
        if (tip.payload === undefined) {
          throw new Error("expected put payload metadata");
        }
        tip.payload.plainBytes = eachDeclared;
      }
      const reads = vi.spyOn(repository, "tryReadVersion");
      const metadataReads = vi.spyOn(repository, "tryReadVersionMetadata");
      const publishes = vi.spyOn(repository, "publish");
      const warnings: string[] = [];

      expect(
        await autoMergeConflicts(
          repository,
          conflicts,
          () => true,
          (warning) => warnings.push(warning),
        ),
      ).toBe(false);
      expect(metadataReads).toHaveBeenCalledWith(baseVersion);
      expect(reads).not.toHaveBeenCalled();
      expect(publishes).not.toHaveBeenCalled();
      expect(conflicts[0]?.resolvedAt).toBeUndefined();
      expect(warnings.join("\n")).toContain("interactive merge budget");

      reads.mockRestore();
      metadataReads.mockRestore();
      publishes.mockRestore();
    });
  });

  it("keeps an over-count disjoint bubble union manual without publishing", async () => {
    await withRepository(async (repository) => {
      const resourceId = `chat/${COMPOSER}`;
      const leftIds = Array.from(
        { length: 8_193 },
        (_unused, index) => `left-${index}`,
      );
      const rightIds = Array.from(
        { length: 8_192 },
        (_unused, index) => `right-${index}`,
      );
      await publishFork(
        repository,
        resourceId,
        chat({ bubbles: leftIds, lastUpdatedAt: 2 }),
        chat({ bubbles: rightIds, lastUpdatedAt: 1 }),
      );
      const conflicts = await reconcileConflicts(repository);
      const publishes = vi.spyOn(repository, "publish");
      const warnings: string[] = [];

      expect(
        await autoMergeConflicts(
          repository,
          conflicts,
          () => true,
          (warning) => warnings.push(warning),
        ),
      ).toBe(false);
      expect(publishes).not.toHaveBeenCalled();
      expect(conflicts[0]?.resolvedAt).toBeUndefined();
      expect(repository.state.tips[resourceId]).toHaveLength(2);
      expect(warnings.join("\n")).toContain("interactive merge budget");
      expect(warnings.join("\n")).toContain("Resolve Conflicts");

      publishes.mockRestore();
    }, 8 * 1024 * 1024);
  }, 15_000);

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
  conversationState?: string;
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
    composerData: row(
      `composerData:${composerId}`,
      options.conversationState === undefined
        ? options.title ?? "body"
        : JSON.stringify({ conversationState: options.conversationState }),
    ),
    bubbles: options.bubbles.map((id) =>
      row(`bubbleId:${composerId}:${id}`, id),
    ),
  };
  return canonicalBytes(snapshot);
}

function chatV2(
  options: Parameters<typeof chat>[0],
  values: readonly Buffer[],
  missingIds: readonly string[] = [],
): Buffer {
  const core = parsePortableChatSnapshot(chat(options));
  const blobs = values
    .map((bytes) => ({
      key: `agentKv:blob:${sha256(bytes)}`,
      valueBase64: bytes.toString("base64"),
      valueType: "blob" as const,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return canonicalBytes({
    ...core,
    schemaVersion: 2,
    agentKv: {
      blobs,
      referencedIds: [
        ...new Set([
          ...blobs.map((blob) => blob.key.slice("agentKv:blob:".length)),
          ...missingIds,
        ]),
      ].sort(),
      missingIds: [...missingIds].sort(),
    },
  });
}

function row(key: string, value: string): PortableKvRow {
  return {
    key,
    valueBase64: Buffer.from(value, "utf8").toString("base64"),
    valueType: "text",
  };
}

function serializedRootState(rootIds: readonly string[]): string {
  return `~${Buffer.concat(
    rootIds.map((rootId) =>
      Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(rootId, "hex")]),
    ),
  ).toString("base64")}`;
}

function bubbleKey(id: string): string {
  return `bubbleId:${COMPOSER}:${id}`;
}

function bubbleKeys(content: Buffer | undefined): string[] {
  return parsePortableChatSnapshot(content ?? Buffer.alloc(0)).bubbles.map(
    (bubble) => bubble.key,
  );
}

function withBubbleValue(content: Buffer, id: string, value: string): Buffer {
  const snapshot = parsePortableChatSnapshot(content);
  const key = bubbleKey(id);
  return canonicalBytes({
    ...snapshot,
    bubbles: snapshot.bubbles.map((bubble) =>
      bubble.key === key ? row(key, value) : bubble,
    ),
  });
}

function bubbleValue(content: Buffer | undefined, id: string): string | null {
  const bubble = parsePortableChatSnapshot(
    content ?? Buffer.alloc(0),
  ).bubbles.find((candidate) => candidate.key === bubbleKey(id));
  return bubble === undefined
    ? null
    : Buffer.from(bubble.valueBase64, "base64").toString("utf8");
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
  maxPayloadBytes = 1024 * 1024,
): Promise<T> {
  return withTemporaryRoot(async (temporaryRoot) =>
    run(
      await SyncRepository.create(
        join(temporaryRoot, "repository"),
        join(temporaryRoot, "storage"),
        PASSPHRASE,
        maxPayloadBytes,
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
