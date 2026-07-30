import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import {
  WORKSPACE_MAPPING_BLOCK_REASON,
  queuePending,
} from "../src/sync/manager";
import type { SyncRepository } from "../src/protocol/repository";
import type { ResourceProjection } from "../src/protocol/reconciler";
import type { PendingDatabaseChange, ResourceTip } from "../src/types";

const WORKSPACE_ID = "703f151ce2095257aebae8e68adf30c0";
const RESOURCE_ID = `workspace-storage/${encodeURIComponent(
  `${WORKSPACE_ID}/state.vscdb`,
)}`;
const EVENT_HASH = "a".repeat(64);

describe("the queued-change block a workspace mapping owns", () => {
  it("survives the next poll instead of re-offering a restart that cannot write", () => {
    // The loop this closes, as seen on the user's second computer: one
    // workspace-storage change offered again after every single restart.
    //   1. the mapping pass cannot place the workspace, so it blocks the entry
    //   2. blocked entries leave the batch, so the modal goes quiet
    //   3. the next poll re-queues the entry; resourceApplyBlockReason cannot
    //      see workspace mappings, so it reports "nothing wrong"
    //   4. queuePending deleted the block -> ready again -> modal -> quit ->
    //      the helper skips it ("workspace mapping required", which does not
    //      mark it applied) -> still queued -> back to 1, forever.
    const repository = repositoryWith([
      {
        eventHash: EVENT_HASH,
        changeIndex: 0,
        resourceId: RESOURCE_ID,
        kind: "workspace-storage",
        blockedReason: WORKSPACE_MAPPING_BLOCK_REASON,
      },
    ]);

    // The poll's verdict: this synchronous check knows nothing about mappings.
    queuePending(repository, projection(), undefined);

    // Still blocked, so it stays out of the helper batch that raises the modal
    // and quits Cursor.
    expect(repository.state.pendingDatabaseChanges[0]?.blockedReason).toBe(
      WORKSPACE_MAPPING_BLOCK_REASON,
    );
  });

  it("still clears a block this pass does own", () => {
    // Compatibility and configuration blocks ARE recomputed every cycle, so a
    // Cursor upgrade that lifts one has to take effect without the user acting.
    const repository = repositoryWith([
      {
        eventHash: EVENT_HASH,
        changeIndex: 0,
        resourceId: RESOURCE_ID,
        kind: "workspace-storage",
        blockedReason: "Created by a newer Cursor.",
      },
    ]);

    queuePending(repository, projection(), undefined);

    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
  });

  it("replaces a mapping block when this pass has a reason of its own", () => {
    // An excluded workspace outranks "map it": the answer is that it is never
    // coming here, which is more actionable than being asked again.
    const repository = repositoryWith([
      {
        eventHash: EVENT_HASH,
        changeIndex: 0,
        resourceId: RESOURCE_ID,
        kind: "workspace-storage",
        blockedReason: WORKSPACE_MAPPING_BLOCK_REASON,
      },
    ]);

    queuePending(repository, projection(), "This workspace is excluded.");

    expect(repository.state.pendingDatabaseChanges[0]?.blockedReason).toBe(
      "This workspace is excluded.",
    );
  });
});

function projection(): ResourceProjection {
  const tip: ResourceTip = {
    kind: "workspace-storage",
    versionId: "v1",
    eventHash: EVENT_HASH,
    changeIndex: 0,
    operation: "put",
    semanticHash: "hash",
    lamport: 1,
    deviceId: "bf423e19",
    parents: [],
    metadata: {
      relativePath: `${WORKSPACE_ID}/state.vscdb`,
      workspaceId: WORKSPACE_ID,
      // Required: a workspaceStorage tip with no folder URI belongs to a window
      // that had nothing open, and queuePending drops those outright rather
      // than queueing a change no computer can place.
      workspaceUri: "vscode-remote://ssh-remote%2Bserver/home/ubuntu/servers",
    },
  };
  return { resourceId: RESOURCE_ID, tip, changed: true };
}

/**
 * queuePending touches nothing but `state.pendingDatabaseChanges`, so the
 * repository is stubbed down to that.
 */
function repositoryWith(pending: PendingDatabaseChange[]): SyncRepository {
  return {
    state: { pendingDatabaseChanges: pending },
  } as unknown as SyncRepository;
}
