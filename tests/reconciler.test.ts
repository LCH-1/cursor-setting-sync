import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { EventReconciler } from "../src/protocol/reconciler";
import {
  autoMergeConflicts,
  parentsWithOwnConflictTips,
  syntheticApplyDecision,
  validatedTextMergeOutcome,
  type AdapterScanIndex,
} from "../src/sync/manager";
import { mergeTextBuffers } from "../src/resources/text";
import { sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import type { DecryptedEvent } from "../src/protocol/repository";
import type {
  CheckpointManifest,
  CheckpointResource,
  EventManifest,
  LocalProjection,
  LocalSyncState,
  ResourceChange,
  ResourceDeletion,
  ResourceSnapshot,
  ResourceTip,
  StreamCursor,
} from "../src/types";

describe("event reconciliation", () => {
  it("merges changes to independent resources", () => {
    const first = event("a", 1, null, "1".repeat(64), [
      change("settings/default/editor.fontSize", []),
    ]);
    const second = event("b", 1, null, "2".repeat(64), [
      change("settings/default/editor.tabSize", []),
    ]);
    const result = new EventReconciler().reconcile(
      [first, second],
      state(),
      null,
    );

    expect(result.conflicts).toHaveLength(0);
    expect(result.projections).toHaveLength(2);
  });

  it("coalesces concurrent versions with identical semantic content", () => {
    const resourceId = "settings/default/editor.fontSize";
    const first = event("a", 1, null, "1".repeat(64), [
      change(resourceId, []),
    ]);
    const second = event("b", 1, null, "2".repeat(64), [
      change(resourceId, []),
    ]);
    const result = new EventReconciler().reconcile(
      [first, second],
      state(),
      null,
    );

    expect(result.conflicts).toHaveLength(0);
    expect(result.projections).toHaveLength(1);
    expect(result.projections[0]?.tip.semanticHash).toBe(resourceId);
    expect(result.projections[0]?.changed).toBe(true);
    expect(result.projections[0]?.resourceId).toBe(resourceId);
    expect(result.projections[0]?.tip.versionId).toMatch(/#0$/);
    expect(result.projections[0]?.tip.operation).toBe("put");
    expect(result.projections[0]?.tip.kind).toBe("settings");
    expect(result.projections[0]?.tip.parents).toEqual([]);
    expect(result.projections[0]).toBeDefined();
    expect(result.acceptedEventHashes).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("preserves concurrent versions with different semantic content", () => {
    const resourceId = "settings/default/editor.fontSize";
    const first = event("a", 1, null, "1".repeat(64), [
      { ...change(resourceId, []), semanticHash: "a".repeat(64) },
    ]);
    const second = event("b", 1, null, "2".repeat(64), [
      { ...change(resourceId, []), semanticHash: "b".repeat(64) },
    ]);
    const result = new EventReconciler().reconcile(
      [first, second],
      state(),
      null,
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.baseVersionId).toBeNull();
    expect(result.projections).toHaveLength(0);
  });

  it("finds the merge base across a two-generation divergence", () => {
    const resourceId = "settings/default/editor.fontSize";
    const baseHash = "1".repeat(64);
    const firstChildHash = "2".repeat(64);
    const secondChildHash = "3".repeat(64);
    const remoteHash = "4".repeat(64);
    const result = new EventReconciler().reconcile(
      [
        event("a", 1, null, baseHash, [
          { ...change(resourceId, []), semanticHash: "0".repeat(64) },
        ]),
        event("a", 2, baseHash, firstChildHash, [
          {
            ...change(resourceId, [`${baseHash}#0`]),
            semanticHash: "a".repeat(64),
          },
        ]),
        event("a", 3, firstChildHash, secondChildHash, [
          {
            ...change(resourceId, [`${firstChildHash}#0`]),
            semanticHash: "b".repeat(64),
          },
        ]),
        event("b", 1, null, remoteHash, [
          {
            ...change(resourceId, [`${baseHash}#0`]),
            semanticHash: "c".repeat(64),
          },
        ]),
      ],
      state(),
      null,
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.baseVersionId).toBe(`${baseHash}#0`);
    expect([...(result.conflicts[0]?.tipVersionIds ?? [])].sort()).toEqual(
      [`${secondChildHash}#0`, `${remoteHash}#0`].sort(),
    );
  });

  it("picks the lowest common ancestor when several exist", () => {
    const resourceId = "settings/default/editor.fontSize";
    const rootHash = "1".repeat(64);
    const middleHash = "2".repeat(64);
    const localHash = "3".repeat(64);
    const remoteHash = "4".repeat(64);
    const result = new EventReconciler().reconcile(
      [
        event("a", 1, null, rootHash, [
          { ...change(resourceId, []), semanticHash: "0".repeat(64) },
        ]),
        event("a", 2, rootHash, middleHash, [
          {
            ...change(resourceId, [`${rootHash}#0`]),
            semanticHash: "a".repeat(64),
          },
        ]),
        event("a", 3, middleHash, localHash, [
          {
            ...change(resourceId, [`${middleHash}#0`]),
            semanticHash: "b".repeat(64),
          },
        ]),
        event("b", 1, null, remoteHash, [
          {
            ...change(resourceId, [`${middleHash}#0`]),
            semanticHash: "c".repeat(64),
          },
        ]),
      ],
      state(),
      null,
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.baseVersionId).toBe(`${middleHash}#0`);
  });

  it("ages out old resolved conflicts and caps retained history", () => {
    const localState = state();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    localState.conflicts = [
      {
        conflictId: "expired",
        resourceId: "settings/default/expired",
        kind: "settings",
        baseVersionId: null,
        tipVersionIds: [],
        createdAt: new Date(now - 40 * day).toISOString(),
        resolvedAt: new Date(now - 31 * day).toISOString(),
      },
      ...Array.from({ length: 250 }, (_, index) => ({
        conflictId: `recent-${index}`,
        resourceId: `settings/default/recent-${index}`,
        kind: "settings" as const,
        baseVersionId: null,
        tipVersionIds: [],
        createdAt: new Date(now - index * 60 * 1000).toISOString(),
        resolvedAt: new Date(now - index * 60 * 1000).toISOString(),
      })),
    ];

    new EventReconciler().reconcile([], localState, null);

    expect(localState.conflicts).toHaveLength(200);
    const retainedIds = new Set(
      localState.conflicts.map((conflict) => conflict.conflictId),
    );
    expect(retainedIds.has("expired")).toBe(false);
    expect(retainedIds.has("recent-0")).toBe(true);
    expect(retainedIds.has("recent-199")).toBe(true);
    expect(retainedIds.has("recent-200")).toBe(false);
  });

  it("accepts a child version as the only tip", () => {
    const resourceId = "settings/default/editor.fontSize";
    const firstHash = "1".repeat(64);
    const secondHash = "2".repeat(64);
    const first = event("a", 1, null, firstHash, [
      change(resourceId, []),
    ]);
    const second = event("a", 2, firstHash, secondHash, [
      change(resourceId, [`${firstHash}#0`]),
    ]);
    const result = new EventReconciler().reconcile(
      [first, second],
      state(),
      null,
    );

    expect(result.conflicts).toHaveLength(0);
    expect(result.projections[0]?.tip.versionId).toBe(`${secondHash}#0`);
    expect(result.projections[0]?.tip.producer?.cursorVersion).toBe("3.11.19");
  });

  it("waits for a missing sequence instead of applying out of order", () => {
    const outOfOrder = event("b", 2, "1".repeat(64), "2".repeat(64), [
      change("settings/default/editor.fontSize", []),
    ]);
    const result = new EventReconciler().reconcile(
      [outOfOrder],
      state(),
      null,
    );

    expect(result.projections).toHaveLength(0);
    expect(result.warnings[0]).toContain("event 1");
  });

  it("fails closed when a previously accepted stream tail disappears", () => {
    const firstHash = "1".repeat(64);
    const secondHash = "2".repeat(64);
    const localState = state();
    localState.streams.a = {
      lastSequence: 2,
      lastEventHash: secondHash,
    };
    const first = event("a", 1, null, firstHash, [
      change("settings/default/editor.fontSize", []),
    ]);

    expect(() =>
      new EventReconciler().reconcile([first], localState, null),
    ).toThrow(/stream rollback detected.*event 2/i);
    expect(localState.streams.a).toEqual({
      lastSequence: 2,
      lastEventHash: secondHash,
    });
  });

  it("fails closed when a previously accepted stream head hash changes", () => {
    const pinnedHash = "1".repeat(64);
    const replacementHash = "2".repeat(64);
    const localState = state();
    localState.streams.a = {
      lastSequence: 1,
      lastEventHash: pinnedHash,
    };
    const replacement = event("a", 1, null, replacementHash, [
      change("settings/default/editor.fontSize", []),
    ]);

    expect(() =>
      new EventReconciler().reconcile([replacement], localState, null),
    ).toThrow(/stream rollback detected.*different hash/i);
    expect(localState.streams.a?.lastEventHash).toBe(pinnedHash);
  });

  it("fails closed when a previously accepted device stream disappears", () => {
    const localState = state();
    localState.streams.a = {
      lastSequence: 1,
      lastEventHash: "1".repeat(64),
    };

    expect(() =>
      new EventReconciler().reconcile([], localState, null),
    ).toThrow(/stream rollback detected.*no longer visible/i);
  });

  it("advances a pinned stream and still accepts a new device stream", () => {
    const firstHash = "1".repeat(64);
    const secondHash = "2".repeat(64);
    const newDeviceHash = "3".repeat(64);
    const localState = state();
    localState.streams.a = {
      lastSequence: 1,
      lastEventHash: firstHash,
    };
    const result = new EventReconciler().reconcile(
      [
        event("a", 1, null, firstHash, [
          change("settings/default/editor.fontSize", []),
        ]),
        event("a", 2, firstHash, secondHash, [
          change("settings/default/editor.fontSize", [`${firstHash}#0`]),
        ]),
        event("b", 1, null, newDeviceHash, [
          change("settings/default/editor.tabSize", []),
        ]),
      ],
      localState,
      null,
    );

    expect(result.warnings).toEqual([]);
    expect(localState.streams.a).toEqual({
      lastSequence: 2,
      lastEventHash: secondHash,
    });
    expect(localState.streams.b).toEqual({
      lastSequence: 1,
      lastEventHash: newDeviceHash,
    });
  });

  it("waits for a missing future event without decreasing a pinned cursor", () => {
    const firstHash = "1".repeat(64);
    const localState = state();
    localState.streams.a = {
      lastSequence: 1,
      lastEventHash: firstHash,
    };
    const result = new EventReconciler().reconcile(
      [
        event("a", 1, null, firstHash, [
          change("settings/default/editor.fontSize", []),
        ]),
        event("a", 3, "2".repeat(64), "3".repeat(64), [
          change("settings/default/editor.fontSize", []),
        ]),
      ],
      localState,
      null,
    );

    expect(result.warnings[0]).toContain("event 2");
    expect(localState.streams.a).toEqual({
      lastSequence: 1,
      lastEventHash: firstHash,
    });
  });

  it("keeps a retired stream's pinned history and ignores later events", () => {
    const firstHash = "1".repeat(64);
    const secondHash = "2".repeat(64);
    const ignoredHash = "3".repeat(64);
    const localState = state();
    localState.streams.a = {
      lastSequence: 2,
      lastEventHash: secondHash,
    };
    localState.retiredDevices.push("a");

    const result = new EventReconciler().reconcile(
      [
        event("a", 1, null, firstHash, [
          change("settings/default/editor.fontSize", []),
        ]),
        event("a", 2, firstHash, secondHash, [
          change("settings/default/editor.fontSize", [`${firstHash}#0`]),
        ]),
        event("a", 3, secondHash, ignoredHash, [
          change("settings/default/editor.fontSize", [`${secondHash}#0`]),
        ]),
      ],
      localState,
      null,
    );

    expect(result.acceptedEventHashes).toEqual([firstHash, secondHash]);
    expect(result.projections[0]?.tip.versionId).toBe(`${secondHash}#0`);
    expect(localState.streams.a).toEqual({
      lastSequence: 2,
      lastEventHash: secondHash,
    });
  });

  it("fails closed when retired pinned history disappears", () => {
    const localState = state();
    localState.streams.a = {
      lastSequence: 1,
      lastEventHash: "1".repeat(64),
    };
    localState.retiredDevices.push("a");

    expect(() =>
      new EventReconciler().reconcile([], localState, null),
    ).toThrow(/stream rollback detected.*no longer visible/i);
  });

  it("treats conflict-parented successive edits as a chain instead of siblings", () => {
    const resourceId = "settings/default/editor.fontSize";
    const baseHash = "1".repeat(64);
    const localFirst = "2".repeat(64);
    const remoteHash = "3".repeat(64);
    const localSecond = "4".repeat(64);
    const events = (secondEditParents: string[]) => [
      event("a", 1, null, baseHash, [
        { ...change(resourceId, []), semanticHash: "0".repeat(64) },
      ]),
      event("a", 2, baseHash, localFirst, [
        {
          ...change(resourceId, [`${baseHash}#0`]),
          semanticHash: "a".repeat(64),
        },
      ]),
      event("b", 1, null, remoteHash, [
        {
          ...change(resourceId, [`${baseHash}#0`]),
          semanticHash: "b".repeat(64),
        },
      ]),
      event("a", 3, localFirst, localSecond, [
        {
          ...change(resourceId, secondEditParents),
          semanticHash: "c".repeat(64),
        },
      ]),
    ];

    // Parents pinned to the stale pre-conflict projection accumulate siblings.
    const stale = new EventReconciler().reconcile(
      events([`${baseHash}#0`]),
      state(),
      null,
    );
    expect(stale.conflicts[0]?.tipVersionIds).toHaveLength(3);

    // Unioning the device's own conflict tip keeps its edits a chain.
    const chained = new EventReconciler().reconcile(
      events([`${baseHash}#0`, `${localFirst}#0`]),
      state(),
      null,
    );
    expect(chained.conflicts).toHaveLength(1);
    expect([...(chained.conflicts[0]?.tipVersionIds ?? [])].sort()).toEqual(
      [`${localSecond}#0`, `${remoteHash}#0`].sort(),
    );
    expect(chained.conflicts[0]?.baseVersionId).toBe(`${baseHash}#0`);
  });

  it("keeps original change indexes while ignoring future resource kinds", () => {
    const eventHash = "3".repeat(64);
    const future = {
      ...change("future-resource/example", []),
      kind: "future-resource",
    };
    const known = change("settings/default/editor.fontSize", []);
    const result = new EventReconciler().reconcile(
      [event("a", 1, null, eventHash, [future, known])],
      state(),
      null,
    );

    expect(result.acceptedEventHashes).toEqual([eventHash]);
    expect(result.projections).toHaveLength(1);
    expect(result.projections[0]?.resourceId).toBe(known.resourceId);
    expect(result.projections[0]?.tip.versionId).toBe(`${eventHash}#1`);
  });
});

describe("checkpoint-aware reconciliation", () => {
  const resourceId = "settings/default/editor.fontSize";
  const foldedHash = "f".repeat(64);

  it("chains later events onto the seeded folded tip", () => {
    const firstChild = "1".repeat(64);
    const secondChild = "2".repeat(64);
    const localState = state();
    const result = new EventReconciler().reconcile(
      [
        event("a", 3, foldedHash, firstChild, [
          {
            ...change(resourceId, [`${foldedHash}#0`]),
            semanticHash: "a".repeat(64),
          },
        ]),
        event("a", 4, firstChild, secondChild, [
          {
            ...change(resourceId, [`${firstChild}#0`]),
            semanticHash: "b".repeat(64),
          },
        ]),
      ],
      localState,
      checkpoint({ a: cursor(2, foldedHash) }, [
        foldedResource(resourceId, `${foldedHash}#0`),
      ]),
    );

    expect(result.warnings).toEqual([]);
    expect(result.conflicts).toHaveLength(0);
    expect(result.projections).toHaveLength(1);
    expect(result.projections[0]?.tip.versionId).toBe(`${secondChild}#0`);
    expect(localState.streams.a).toEqual({
      lastSequence: 4,
      lastEventHash: secondChild,
    });
  });

  it("conflicts a concurrent event with the folded tip and nulls the pruned base", () => {
    const prunedHash = "0".repeat(64);
    const remoteHash = "9".repeat(64);
    const result = new EventReconciler().reconcile(
      [
        event("b", 1, null, remoteHash, [
          {
            ...change(resourceId, [`${prunedHash}#0`]),
            semanticHash: "b".repeat(64),
          },
        ]),
      ],
      state(),
      checkpoint({ a: cursor(2, foldedHash) }, [
        foldedResource(resourceId, `${foldedHash}#0`, {
          semanticHash: "a".repeat(64),
        }),
      ]),
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.baseVersionId).toBeNull();
    expect([...(result.conflicts[0]?.tipVersionIds ?? [])].sort()).toEqual(
      [`${foldedHash}#0`, `${remoteHash}#0`].sort(),
    );
    expect(result.projections).toHaveLength(0);
  });

  it("finds the folded tip as the merge base for concurrent children", () => {
    const localChild = "1".repeat(64);
    const remoteChild = "2".repeat(64);
    const result = new EventReconciler().reconcile(
      [
        event("a", 3, foldedHash, localChild, [
          {
            ...change(resourceId, [`${foldedHash}#0`]),
            semanticHash: "a".repeat(64),
          },
        ]),
        event("b", 1, null, remoteChild, [
          {
            ...change(resourceId, [`${foldedHash}#0`]),
            semanticHash: "b".repeat(64),
          },
        ]),
      ],
      state(),
      checkpoint({ a: cursor(2, foldedHash) }, [
        foldedResource(resourceId, `${foldedHash}#0`),
      ]),
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.baseVersionId).toBe(`${foldedHash}#0`);
    expect([...(result.conflicts[0]?.tipVersionIds ?? [])].sort()).toEqual(
      [`${localChild}#0`, `${remoteChild}#0`].sort(),
    );
  });

  it("nulls a persisted conflict base that resolves to neither an event nor the checkpoint entry", () => {
    const prunedHash = "0".repeat(64);
    const remoteHash = "9".repeat(64);
    const localState = state();
    localState.conflicts = [
      {
        conflictId: "persisted",
        resourceId,
        kind: "settings",
        baseVersionId: `${prunedHash}#0`,
        tipVersionIds: [`${foldedHash}#0`, `${remoteHash}#0`].sort(),
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ];
    const result = new EventReconciler().reconcile(
      [
        event("b", 1, null, remoteHash, [
          {
            ...change(resourceId, [`${prunedHash}#0`]),
            semanticHash: "b".repeat(64),
          },
        ]),
      ],
      localState,
      checkpoint({ a: cursor(2, foldedHash) }, [
        foldedResource(resourceId, `${foldedHash}#0`, {
          semanticHash: "a".repeat(64),
        }),
      ]),
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.conflictId).toBe("persisted");
    expect(result.conflicts[0]?.baseVersionId).toBeNull();
    expect(localState.conflicts[0]?.baseVersionId).toBeNull();
  });

  it("keeps a persisted conflict base that resolves to the checkpoint entry", () => {
    const localChild = "1".repeat(64);
    const remoteChild = "2".repeat(64);
    const localState = state();
    localState.conflicts = [
      {
        conflictId: "persisted",
        resourceId,
        kind: "settings",
        baseVersionId: `${foldedHash}#0`,
        tipVersionIds: [`${localChild}#0`, `${remoteChild}#0`].sort(),
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ];
    const result = new EventReconciler().reconcile(
      [
        event("a", 3, foldedHash, localChild, [
          {
            ...change(resourceId, [`${foldedHash}#0`]),
            semanticHash: "a".repeat(64),
          },
        ]),
        event("b", 1, null, remoteChild, [
          {
            ...change(resourceId, [`${foldedHash}#0`]),
            semanticHash: "b".repeat(64),
          },
        ]),
      ],
      localState,
      checkpoint({ a: cursor(2, foldedHash) }, [
        foldedResource(resourceId, `${foldedHash}#0`),
      ]),
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.conflictId).toBe("persisted");
    expect(result.conflicts[0]?.baseVersionId).toBe(`${foldedHash}#0`);
  });

  it("accepts a stream resuming at the checkpoint cursor", () => {
    const nextHash = "1".repeat(64);
    const result = new EventReconciler().reconcile(
      [
        event("a", 3, foldedHash, nextHash, [
          change(resourceId, [`${foldedHash}#0`]),
        ]),
      ],
      state(),
      checkpoint({ a: cursor(2, foldedHash) }, [
        foldedResource(resourceId, `${foldedHash}#0`),
      ]),
    );

    expect(result.warnings).toEqual([]);
    expect(result.acceptedEventHashes).toEqual([nextHash]);
  });

  it("warns on a gap above the checkpoint cursor", () => {
    const result = new EventReconciler().reconcile(
      [
        event("a", 4, "2".repeat(64), "3".repeat(64), [
          change(resourceId, []),
        ]),
      ],
      state(),
      checkpoint({ a: cursor(2, foldedHash) }, []),
    );

    expect(result.acceptedEventHashes).toEqual([]);
    expect(result.warnings[0]).toContain("event 3");
  });

  it("fails closed when pinned events above the cursor are missing", () => {
    const localState = state();
    localState.streams.a = {
      lastSequence: 4,
      lastEventHash: "4".repeat(64),
    };

    expect(() =>
      new EventReconciler().reconcile(
        [],
        localState,
        checkpoint({ a: cursor(2, foldedHash) }, []),
      ),
    ).toThrow(/stream rollback detected.*event 4 is no longer visible/i);
  });

  it("fails closed when a stream ends between the cursor and the pinned head", () => {
    const localState = state();
    localState.streams.a = {
      lastSequence: 4,
      lastEventHash: "4".repeat(64),
    };

    expect(() =>
      new EventReconciler().reconcile(
        [
          event("a", 3, foldedHash, "3".repeat(64), [
            change(resourceId, []),
          ]),
        ],
        localState,
        checkpoint({ a: cursor(2, foldedHash) }, []),
      ),
    ).toThrow(/stream rollback detected.*before previously accepted event 4/i);
  });

  it("passes a pinned stream folded at or below the cursor with zero visible events", () => {
    const localState = state();
    localState.streams.a = {
      lastSequence: 2,
      lastEventHash: foldedHash,
    };

    const result = new EventReconciler().reconcile(
      [],
      localState,
      checkpoint({ a: cursor(5, "5".repeat(64)) }, []),
    );

    expect(result.warnings).toEqual([]);
    expect(result.acceptedEventHashes).toEqual([]);
    expect(localState.streams.a).toEqual({
      lastSequence: 2,
      lastEventHash: foldedHash,
    });
  });

  it("filters leftover events at or below the checkpoint cursor", () => {
    const firstHash = "1".repeat(64);
    const thirdHash = "3".repeat(64);
    const result = new EventReconciler().reconcile(
      [
        event("a", 1, null, firstHash, [change(resourceId, [])]),
        event("a", 2, firstHash, foldedHash, [
          change(resourceId, [`${firstHash}#0`]),
        ]),
        event("a", 3, foldedHash, thirdHash, [
          change(resourceId, [`${foldedHash}#0`]),
        ]),
      ],
      state(),
      checkpoint({ a: cursor(2, foldedHash) }, [
        foldedResource(resourceId, `${foldedHash}#0`),
      ]),
    );

    expect(result.warnings).toEqual([]);
    expect(result.acceptedEventHashes).toEqual([thirdHash]);
    expect(result.projections).toHaveLength(1);
    expect(result.projections[0]?.tip.versionId).toBe(`${thirdHash}#0`);
  });

  it("keeps the absorbed checkpoint lamport monotonic across low-lamport input", () => {
    const nextHash = "1".repeat(64);
    const localState = state();
    localState.lamport = 50;
    new EventReconciler().reconcile(
      [
        event("a", 3, foldedHash, nextHash, [
          change(resourceId, [`${foldedHash}#0`]),
        ]),
      ],
      localState,
      checkpoint(
        { a: cursor(2, foldedHash) },
        [foldedResource(resourceId, `${foldedHash}#0`)],
        50,
      ),
    );

    expect(localState.lamport).toBe(50);
  });
});

describe("trivial conflict auto-resolution", () => {
  const resourceId = "settings/default/editor.fontSize";

  it("resolves a base-equal tip against a real edit for a manual-merge kind", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-trivial-"),
    );
    try {
      const repository = await createTestRepository(temporaryRoot);
      const base = await repository.publish(
        [settingsSnapshot(resourceId, "14")],
        [],
      );
      const edit = await repository.publish(
        [
          {
            ...settingsSnapshot(resourceId, "16"),
            parents: [`${base.eventHash}#0`],
          },
        ],
        [],
      );
      const marker = await repository.publish(
        [
          {
            ...settingsSnapshot(resourceId, "14"),
            parents: [`${base.eventHash}#0`],
            metadata: { syncOrigin: "checkpoint-marker" },
          },
        ],
        [],
      );
      const reconciler = new EventReconciler();
      const before = reconciler.reconcile(
        await repository.listEvents(),
        repository.state,
        null,
      );
      expect(before.conflicts).toHaveLength(1);
      expect(before.conflicts[0]?.baseVersionId).toBe(`${base.eventHash}#0`);

      expect(await autoMergeConflicts(repository, before.conflicts)).toBe(true);
      expect(before.conflicts[0]?.resolvedAt).toBeDefined();

      const after = reconciler.reconcile(
        await repository.listEvents(),
        repository.state,
        null,
      );
      expect(after.conflicts).toHaveLength(0);
      const tips = repository.state.tips[resourceId] ?? [];
      expect(tips).toHaveLength(1);
      expect(tips[0]?.semanticHash).toBe(sha256(Buffer.from("16", "utf8")));
      expect(tips[0]?.metadata?.syncOrigin).toBe("auto-merge");
      expect([...(tips[0]?.parents ?? [])].sort()).toEqual(
        [`${edit.eventHash}#0`, `${marker.eventHash}#0`].sort(),
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("leaves a conflict alone when both tips differ from the base", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-setting-sync-nontrivial-"),
    );
    try {
      const repository = await createTestRepository(temporaryRoot);
      const base = await repository.publish(
        [settingsSnapshot(resourceId, "14")],
        [],
      );
      await repository.publish(
        [
          {
            ...settingsSnapshot(resourceId, "16"),
            parents: [`${base.eventHash}#0`],
          },
        ],
        [],
      );
      await repository.publish(
        [
          {
            ...settingsSnapshot(resourceId, "18"),
            parents: [`${base.eventHash}#0`],
          },
        ],
        [],
      );
      const result = new EventReconciler().reconcile(
        await repository.listEvents(),
        repository.state,
        null,
      );
      expect(result.conflicts).toHaveLength(1);

      expect(await autoMergeConflicts(repository, result.conflicts)).toBe(false);
      expect(result.conflicts[0]?.resolvedAt).toBeUndefined();
      expect(repository.state.tips[resourceId]).toHaveLength(2);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("conflict-aware publish parents", () => {
  const resourceId = "keybindings/default/keybindings.json";

  it("unions the device's own conflict tips into the parents", () => {
    const projection = localProjection(resourceId, "0".repeat(64));
    const tips = [
      resourceTip(`${"2".repeat(64)}#0`, "local-device", "a".repeat(64)),
      resourceTip(`${"3".repeat(64)}#0`, "remote-device", "b".repeat(64)),
    ];
    expect(
      parentsWithOwnConflictTips(projection, tips, "local-device", "c".repeat(64)),
    ).toEqual([`${"1".repeat(64)}#0`, `${"2".repeat(64)}#0`]);
  });

  it("does not parent a snapshot on an own tip with identical content", () => {
    const projection = localProjection(resourceId, "0".repeat(64));
    const tips = [
      resourceTip(`${"2".repeat(64)}#0`, "local-device", "a".repeat(64)),
      resourceTip(`${"3".repeat(64)}#0`, "remote-device", "b".repeat(64)),
    ];
    expect(
      parentsWithOwnConflictTips(projection, tips, "local-device", "a".repeat(64)),
    ).toEqual([`${"1".repeat(64)}#0`]);
  });

  it("falls back to the projection parent without own tips", () => {
    const projection = localProjection(resourceId, "0".repeat(64));
    const tips = [
      resourceTip(`${"3".repeat(64)}#0`, "remote-device", "b".repeat(64)),
    ];
    expect(
      parentsWithOwnConflictTips(projection, tips, "local-device", "c".repeat(64)),
    ).toEqual([`${"1".repeat(64)}#0`]);
  });
});

describe("synthetic merge drift decisions", () => {
  const resourceId = "keybindings/default/keybindings.json";
  const tip = resourceTip(`${"9".repeat(64)}#0`, "remote-device", "e".repeat(64));

  it("treats a failed scan as drift", () => {
    expect(syntheticApplyDecision(null, resourceId, tip, undefined).action).toBe(
      "drift",
    );
  });

  it("marks an already-applied merge from the live snapshot", () => {
    const live = liveSnapshot(resourceId, tip.semanticHash);
    expect(
      syntheticApplyDecision(scanIndex([live]), resourceId, tip, undefined),
    ).toEqual({ action: "already-applied", live });
  });

  it("applies over live content that matches the known projection", () => {
    const known = localProjection(resourceId, "a".repeat(64));
    const live = liveSnapshot(resourceId, "a".repeat(64));
    expect(
      syntheticApplyDecision(scanIndex([live]), resourceId, tip, known).action,
    ).toBe("apply");
  });

  it("skips when live content differs from the tip and the projection", () => {
    const known = localProjection(resourceId, "a".repeat(64));
    const live = liveSnapshot(resourceId, "b".repeat(64));
    expect(
      syntheticApplyDecision(scanIndex([live]), resourceId, tip, known).action,
    ).toBe("drift");
  });

  it("skips an unpublished local delete instead of resurrecting it", () => {
    const known = localProjection(resourceId, "a".repeat(64));
    const deletion = resourceDeletion(resourceId, "d".repeat(64));
    expect(
      syntheticApplyDecision(scanIndex([], [deletion]), resourceId, tip, known)
        .action,
    ).toBe("drift");
  });

  it("applies over a delete the projection already records", () => {
    const known = localProjection(resourceId, "d".repeat(64));
    const deletion = resourceDeletion(resourceId, "d".repeat(64));
    expect(
      syntheticApplyDecision(scanIndex([], [deletion]), resourceId, tip, known)
        .action,
    ).toBe("apply");
  });

  it("treats a missing snapshot for a projected resource as drift", () => {
    const known = localProjection(resourceId, "a".repeat(64));
    expect(
      syntheticApplyDecision(scanIndex([]), resourceId, tip, known).action,
    ).toBe("drift");
  });

  it("applies a merge for a resource that never existed locally", () => {
    expect(
      syntheticApplyDecision(scanIndex([]), resourceId, tip, undefined).action,
    ).toBe("apply");
  });
});

describe("keybindings text merge validation", () => {
  it("degrades a clean text merge that yields invalid JSONC to a conflict", () => {
    const base = Buffer.from(
      '[\n  { "key": "ctrl+a", "command": "one" }\n]\n',
      "utf8",
    );
    const remote = Buffer.from(
      '[\n  { "key": "ctrl+a", "command": "one" },\n  { "key": "ctrl+b", "command": "two"\n]\n',
      "utf8",
    );
    const merged = mergeTextBuffers(base, base, remote);
    expect(merged.status).toBe("merged");
    const outcome = validatedTextMergeOutcome("keybindings", merged);
    expect(outcome.status).toBe("conflict");
    expect(outcome.content).toBeUndefined();
  });

  it("keeps a clean text merge that stays valid JSONC", () => {
    const base = Buffer.from(
      [
        "[",
        '  { "key": "ctrl+a", "command": "one" },',
        '  { "key": "ctrl+b", "command": "two" },',
        '  { "key": "ctrl+c", "command": "three" }',
        "]",
        "",
      ].join("\n"),
      "utf8",
    );
    const local = Buffer.from(
      base.toString("utf8").replace('"one"', '"uno"'),
      "utf8",
    );
    const remote = Buffer.from(
      base.toString("utf8").replace('"three"', '"tres"'),
      "utf8",
    );
    const merged = mergeTextBuffers(base, local, remote);
    expect(merged.status).toBe("merged");
    const outcome = validatedTextMergeOutcome("keybindings", merged);
    expect(outcome).toBe(merged);
    expect(outcome.content?.toString("utf8")).toContain('"uno"');
    expect(outcome.content?.toString("utf8")).toContain('"tres"');
  });

  it("leaves non-JSONC text kinds untouched", () => {
    const merged = {
      status: "merged" as const,
      content: Buffer.from("plain text merge", "utf8"),
      semanticHash: "0".repeat(64),
    };
    expect(validatedTextMergeOutcome("prompt", merged)).toBe(merged);
  });
});

function event(
  deviceId: string,
  sequence: number,
  previousEventHash: string | null,
  eventHash: string,
  changes: ResourceChange[],
): DecryptedEvent {
    const manifest: EventManifest = {
      eventVersion: 1,
      createdAt: "2026-07-14T00:00:00.000Z",
      lamport: sequence,
      producer: {
        extensionVersion: "0.0.1",
        cursorVersion: "3.11.19",
        vscodeVersion: "1.125.0",
      },
      changes,
  };
  return {
    path: `${deviceId}/${sequence}`,
    fileName: `${sequence}-${eventHash}.cse`,
    eventHash,
    stored: {
      header: {
        protocolVersion: 1,
        envelopeVersion: 1,
        repositoryId: "repository",
        deviceId,
        sequence,
        previousEventHash,
      },
      nonce: "",
      ciphertext: "",
      tag: "",
    },
    manifest,
  };
}

function change(resourceId: string, parents: string[]): ResourceChange {
  return {
    resourceId,
    kind: "settings",
    operation: "put",
    parents,
    semanticHash: resourceId,
  };
}

function checkpoint(
  streams: Record<string, StreamCursor>,
  resources: CheckpointResource[],
  lamport = 10,
): CheckpointManifest {
  return {
    checkpointVersion: 1,
    createdAt: "2026-07-14T00:00:00.000Z",
    deviceId: "a",
    lamport,
    predecessorHash: null,
    streams,
    resources,
  };
}

function cursor(lastSequence: number, lastEventHash: string): StreamCursor {
  return { lastSequence, lastEventHash };
}

function foldedResource(
  resourceId: string,
  versionId: string,
  overrides: Partial<CheckpointResource> = {},
): CheckpointResource {
  return {
    resourceId,
    kind: "settings",
    operation: "put",
    semanticHash: resourceId,
    versionId,
    lamport: 1,
    deviceId: "a",
    ...overrides,
  };
}

function resourceTip(
  versionId: string,
  deviceId: string,
  semanticHash: string,
): ResourceTip {
  return {
    versionId,
    eventHash: versionId.split("#")[0] ?? versionId,
    changeIndex: 0,
    kind: "keybindings",
    lamport: 1,
    deviceId,
    operation: "put",
    semanticHash,
    parents: [],
  };
}

function localProjection(
  resourceId: string,
  semanticHash: string,
): LocalProjection {
  return {
    resourceId,
    kind: "keybindings",
    semanticHash,
    versionId: `${"1".repeat(64)}#0`,
  };
}

function liveSnapshot(
  resourceId: string,
  semanticHash: string,
): ResourceSnapshot {
  return {
    resourceId,
    kind: "keybindings",
    content: Buffer.from(semanticHash, "utf8"),
    semanticHash,
  };
}

function resourceDeletion(
  resourceId: string,
  semanticHash: string,
): ResourceDeletion {
  return {
    resourceId,
    kind: "keybindings",
    semanticHash,
  };
}

function scanIndex(
  snapshots: ResourceSnapshot[],
  deletions: ResourceDeletion[] = [],
): AdapterScanIndex {
  return {
    snapshots: new Map(
      snapshots.map((snapshot) => [snapshot.resourceId, snapshot]),
    ),
    deletions: new Map(
      deletions.map((deletion) => [deletion.resourceId, deletion]),
    ),
  };
}

async function createTestRepository(
  temporaryRoot: string,
): Promise<SyncRepository> {
  return SyncRepository.create(
    join(temporaryRoot, "repository"),
    join(temporaryRoot, "storage"),
    "a sufficiently long test passphrase",
    1024 * 1024,
    {
      extensionVersion: "0.0.1",
      cursorVersion: "3.11.19",
      vscodeVersion: "1.125.0",
    },
  );
}

function settingsSnapshot(
  resourceId: string,
  value: string,
): ResourceSnapshot {
  const content = Buffer.from(value, "utf8");
  return {
    resourceId,
    kind: "settings",
    content,
    semanticHash: sha256(content),
  };
}

function state(): LocalSyncState {
  return {
    version: 1,
    repositoryId: "repository",
    device: {
      deviceId: "local",
      name: "Local",
      createdAt: "2026-07-14T00:00:00.000Z",
    },
    nextSequence: 1,
    lamport: 0,
    ownStreamHead: null,
    streams: {},
    tips: {},
    projections: {},
    conflicts: [],
    pendingDatabaseChanges: [],
    retiredDevices: [],
    lastSyncAt: null,
    lastError: null,
  };
}
