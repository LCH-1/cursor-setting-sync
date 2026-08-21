import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import {
  INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON,
  WORKSPACE_MAPPING_BLOCK_REASON,
  queuePending,
} from "../src/sync/manager";
import { APPLY_FAILURE_BLOCK_PREFIX } from "../src/constants";
import type { SyncRepository } from "../src/protocol/repository";
import type { ResourceProjection } from "../src/protocol/reconciler";
import type {
  JsonValue,
  PendingDatabaseChange,
  ResourceTip,
} from "../src/types";

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

  it("recognizes a block an older build wrote, whose wording has since changed", () => {
    // The reason is persisted in repository state, so what this build compares
    // against is what an OLDER build wrote. 0.0.43 appended a sentence to the
    // text; matching the whole sentence would have failed to recognize every
    // block already sitting in the field, un-blocked it on the first poll after
    // the upgrade, and put the computer this was written for straight back into
    // the loop the upgrade was supposed to end.
    const legacyReason =
      "Workspace mapping is required for incoming workspace storage.";
    expect(WORKSPACE_MAPPING_BLOCK_REASON).not.toBe(legacyReason);

    const repository = repositoryWith([
      {
        eventHash: EVENT_HASH,
        changeIndex: 0,
        resourceId: RESOURCE_ID,
        kind: "workspace-storage",
        blockedReason: legacyReason,
      },
    ]);

    queuePending(repository, projection(), undefined);

    expect(repository.state.pendingDatabaseChanges[0]?.blockedReason).toBe(
      legacyReason,
    );
  });

  it("keeps a change the last apply failed to write out of the next offer", () => {
    // The real loop, measured on the user's second computer: one workspace
    // database whose LOCAL copy fails SQLite's quick_check ("wrong # of entries
    // in index sqlite_autoindex_ItemTable_1"). The pre-write backup cannot be
    // taken, the helper refuses to write without one, and it reported "applied
    // 0 resource(s)" - so the entry stayed queued, which is correct, and stayed
    // OFFERED, which is not. Every launch raised the modal, quit Cursor, ran an
    // apply that could not succeed, and reopened to the same modal.
    const repository = repositoryWith([
      {
        eventHash: EVENT_HASH,
        changeIndex: 0,
        resourceId: RESOURCE_ID,
        kind: "workspace-storage",
        blockedReason: `${APPLY_FAILURE_BLOCK_PREFIX}: SQLite quick_check failed: wrong # of entries in index sqlite_autoindex_ItemTable_1`,
      },
    ]);

    queuePending(repository, projection(), undefined);

    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toContain(APPLY_FAILURE_BLOCK_PREFIX);
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

describe("cross-device chat continuation queueing", () => {
  it("blocks an ordinary v1 chat until its complete v2 child arrives", () => {
    const repository = repositoryWith([]);

    queuePending(repository, chatProjection({ chatSnapshotSchemaVersion: 1 }));

    expect(repository.state.pendingDatabaseChanges).toEqual([
      expect.objectContaining({
        resourceId: "chat/01234567-89ab-4cde-8fab-0123456789ab",
        blockedReason: INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON,
      }),
    ]);
  });

  it("blocks a partial v2 chat but admits a complete v2 chat", () => {
    const partialRepository = repositoryWith([]);
    queuePending(
      partialRepository,
      chatProjection({
        chatSnapshotSchemaVersion: 2,
        agentKvMissingCount: 1,
      }),
    );
    expect(
      partialRepository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBe(INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON);

    const completeRepository = repositoryWith([]);
    queuePending(
      completeRepository,
      chatProjection({
        chatSnapshotSchemaVersion: 2,
        agentKvMissingCount: 0,
      }),
    );
    expect(
      completeRepository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
  });

  it("keeps the existing one-shot continuation recapture path for body repair", () => {
    const repository = repositoryWith([]);
    queuePending(
      repository,
      chatProjection({
        syncOrigin: "automatic-chat-repair",
        chatSnapshotSchemaVersion: 1,
      }),
    );
    expect(repository.state.pendingDatabaseChanges[0]?.blockedReason).toBeUndefined();
  });

  it("allows legacy blob-only enrichment without applying its partial core", () => {
    const repository = repositoryWith([]);
    const projection = chatProjection({
      syncOrigin: "agent-kv-enrichment",
      chatSnapshotSchemaVersion: 2,
      agentKvMissingCount: 1,
    });

    expect(queuePending(repository, projection)).toBe(true);
    expect(repository.state.pendingDatabaseChanges).toHaveLength(1);
    expect(
      repository.state.pendingDatabaseChanges[0],
    ).not.toHaveProperty("blockedReason");
  });

  it("blocks a core-applying enrichment until its graph is complete", () => {
    const repository = repositoryWith([]);
    queuePending(
      repository,
      chatProjection({
        syncOrigin: "agent-kv-enrichment",
        agentKvEnrichmentAppliesCore: true,
        chatSnapshotSchemaVersion: 2,
        agentKvMissingCount: 1,
      }),
    );

    expect(repository.state.pendingDatabaseChanges[0]?.blockedReason).toBe(
      INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON,
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

function chatProjection(metadata: Record<string, JsonValue>): ResourceProjection {
  const composerId = "01234567-89ab-4cde-8fab-0123456789ab";
  const tip: ResourceTip = {
    kind: "chat",
    versionId: "chat-v1",
    eventHash: "b".repeat(64),
    changeIndex: 0,
    operation: "put",
    semanticHash: "c".repeat(64),
    lamport: 1,
    deviceId: "bf423e19",
    parents: [],
    metadata,
  };
  return { resourceId: `chat/${composerId}`, tip, changed: true };
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
