import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GitModule from "../src/platform/git";
import * as chatEnrichment from "../src/chat/enrichment";

const gitRuntime = vi.hoisted(() => ({
  isGitRepository: vi.fn(),
  pullLatest: vi.fn(),
  commitAndPush: vi.fn(),
  largeFileWarnings: vi.fn(),
}));

const vscodeRuntime = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
}));

vi.mock("vscode", () => ({
  extensions: { all: [] },
  ProgressLocation: { Notification: 1 },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
    openTextDocument: async (input: unknown) => input,
  },
  window: {
    withProgress: async (
      _options: unknown,
      task: (progress: { report(value: unknown): void }) => Promise<unknown>,
    ) => task({ report: () => undefined }),
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showQuickPick: vscodeRuntime.showQuickPick,
    showTextDocument: async () => undefined,
  },
}));

vi.mock("../src/platform/git", async () => {
  const actual = await vi.importActual<typeof GitModule>(
    "../src/platform/git",
  );
  return {
    ...actual,
    isGitRepository: gitRuntime.isGitRepository,
    pullLatest: gitRuntime.pullLatest,
    commitAndPush: gitRuntime.commitAndPush,
    largeFileWarnings: gitRuntime.largeFileWarnings,
  };
});

import {
  BACKGROUND_GIT_PULL_INTERVAL_MS,
  INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON,
  SyncManager,
  WORKSPACE_MAPPING_BLOCK_REASON,
  backgroundGitPullDue,
  markSuppressedSnapshotProjection,
  pendingHelperBatch,
  projectionOverlayForBoundedScan,
  withRequiredFileLock,
} from "../src/sync/manager";
import {
  APPLY_FAILURE_BLOCK_PREFIX,
  MAX_HELPER_APPLY_WORK_BYTES,
  MAX_RUNNING_APPLY_PAYLOAD_BYTES,
} from "../src/constants";
import { StateVscdbChatAdapter } from "../src/chat/stateVscdb";
import type { ExtensionConfiguration } from "../src/config";
import { GitError } from "../src/platform/git";
import { acquireFileLock } from "../src/platform/lock";
import type { FileLock } from "../src/platform/lock";
import type { CursorPaths } from "../src/platform/paths";
import { sha256 } from "../src/protocol/canonical";
import { LocalStateStore } from "../src/protocol/localState";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import type { ResourceAdapter } from "../src/resources/resource";
import type {
  CompatibilityReport,
  LocalProjection,
  ResourceSnapshot,
  ResourceTip,
} from "../src/types";
import type { ConflictController } from "../src/ui/conflicts";
import type { StatusController } from "../src/ui/status";
import { shouldPublishSnapshot } from "../src/sync/versionPolicy";

const { DatabaseSync } = sqlite;
const T0 = Date.parse("2026-08-08T00:00:00.000Z");
const temporaryRoots: string[] = [];

beforeEach(() => {
  vscodeRuntime.showQuickPick.mockReset();
  vscodeRuntime.showQuickPick.mockResolvedValue(undefined);
  gitRuntime.isGitRepository.mockReset().mockResolvedValue(true);
  gitRuntime.pullLatest.mockReset().mockResolvedValue({ status: "up-to-date" });
  gitRuntime.commitAndPush.mockReset().mockResolvedValue({
    committed: false,
    pushed: false,
    recoveredByPull: false,
  });
  gitRuntime.largeFileWarnings.mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("pending helper request work envelope", () => {
  it("never sends a stale unblocked incomplete chat to the offline helper", () => {
    const resourceId = "chat/01234567-89ab-4cde-8fab-0123456789ab";
    const eventHash = "9".repeat(64);
    const repository = {
      state: {
        pendingDatabaseChanges: [
          {
            eventHash,
            changeIndex: 0,
            resourceId,
            kind: "chat",
          },
        ],
        tips: {
          [resourceId]: [
            {
              versionId: `${eventHash}#0`,
              eventHash,
              changeIndex: 0,
              kind: "chat",
              lamport: 1,
              deviceId: "remote-device",
              operation: "put",
              semanticHash: eventHash,
              payload: {
                deviceId: "remote-device",
                objectId: eventHash,
                compressedBytes: 1,
                plainBytes: 1024,
              },
              parents: [],
              metadata: { chatSnapshotSchemaVersion: 1 },
            } satisfies ResourceTip,
          ],
        },
      },
    } as unknown as SyncRepository;

    expect(pendingHelperBatch(repository)).toEqual({
      changes: [],
      deferredForBatchLimit: 0,
    });
  });

  it("keeps one individually oversized change visible while paging a small sibling", () => {
    const oversized = helperTip(
      "settings/default/oversized",
      "a".repeat(64),
      MAX_HELPER_APPLY_WORK_BYTES + 1,
    );
    const small = helperTip(
      "settings/default/small",
      "b".repeat(64),
      1024,
    );
    const repository = {
      state: {
        pendingDatabaseChanges: [oversized.pending, small.pending],
        tips: {
          [oversized.pending.resourceId]: [oversized.tip],
          [small.pending.resourceId]: [small.tip],
        },
      },
    } as unknown as SyncRepository;

    const batch = pendingHelperBatch(repository);

    expect(batch.changes.map((change) => change.resourceId)).toEqual([
      oversized.pending.resourceId,
      small.pending.resourceId,
    ]);
    expect(batch.deferredForBatchLimit).toBe(0);
  });

  it("defers aggregate overflow and caps one request at 256 metadata items", () => {
    const entries = Array.from({ length: 300 }, (_, index) =>
      helperTip(
        `settings/default/key-${index}`,
        index.toString(16).padStart(64, "0"),
        256 * 1024,
      ),
    );
    const repository = {
      state: {
        pendingDatabaseChanges: entries.map((entry) => entry.pending),
        tips: Object.fromEntries(
          entries.map((entry) => [entry.pending.resourceId, [entry.tip]]),
        ),
      },
    } as unknown as SyncRepository;

    const batch = pendingHelperBatch(repository);

    expect(batch.changes.length).toBeLessThanOrEqual(256);
    expect(
      batch.changes.reduce(
        (sum, change) => sum + (change.payload?.plainBytes ?? 0),
        0,
      ),
    ).toBeLessThanOrEqual(MAX_HELPER_APPLY_WORK_BYTES);
    expect(batch.deferredForBatchLimit).toBeGreaterThan(0);
  });
});

describe("workspace mapping and chat continuation blocks", () => {
  it.each([
    { label: "workspace-less", workspaceId: null, resolved: false },
    { label: "unmapped", workspaceId: "source-workspace", resolved: false },
    { label: "resolved", workspaceId: "source-workspace", resolved: true },
  ])(
    "keeps an incomplete $label chat blocked when the mapping pass finishes",
    async ({ workspaceId, resolved }) => {
      const temporaryRoot = await mkdtemp(
        join(tmpdir(), "cursor-manager-chat-mapping-"),
      );
      temporaryRoots.push(temporaryRoot);
      const workspaceStorageRoot = join(temporaryRoot, "workspaceStorage");
      await mkdir(workspaceStorageRoot, { recursive: true });
      const workspaceMappings: Record<string, string> = {};
      if (resolved) {
        const targetWorkspaceId = "target-workspace";
        const targetDirectory = join(workspaceStorageRoot, targetWorkspaceId);
        await mkdir(targetDirectory, { recursive: true });
        await writeFile(
          join(targetDirectory, "workspace.json"),
          JSON.stringify({ folder: "file:///target/project" }),
        );
        workspaceMappings["source-workspace"] = targetWorkspaceId;
      }
      const resourceId = "chat/01234567-89ab-4cde-8fab-0123456789ab";
      const eventHash = "8".repeat(64);
      const tip = {
        versionId: `${eventHash}#0`,
        eventHash,
        changeIndex: 0,
        kind: "chat",
        lamport: 1,
        deviceId: "remote-device",
        operation: "put",
        semanticHash: "7".repeat(64),
        parents: [],
        producer: {
          extensionVersion: "0.0.61",
          cursorVersion: "3.15.6",
          vscodeVersion: "1.125.0",
        },
        metadata: {
          chatSnapshotSchemaVersion: 1,
          workspaceId,
          workspaceUri:
            workspaceId === null ? null : "file:///source/project",
        },
      } satisfies ResourceTip;
      const repository = {
        state: {
          pendingDatabaseChanges: [
            {
              resourceId,
              kind: "chat",
              eventHash,
              changeIndex: 0,
              blockedReason: INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON,
            },
          ],
          tips: { [resourceId]: [tip] },
        },
      } as unknown as SyncRepository;
      const manager = createManager({
        paths: {
          workspaceStorageRoot,
          extensionStorage: join(temporaryRoot, "extension-storage"),
          helperScript: join(temporaryRoot, "helper.js"),
        } as unknown as CursorPaths,
        configuration: {
          syncChat: true,
          syncWorkspaceStorage: true,
          effectiveIgnoredWorkspaces: [],
          workspaceMappings,
          setWorkspaceMapping: vi.fn(async () => undefined),
        } as unknown as ExtensionConfiguration,
      });
      const internals = manager as unknown as {
        ensureWorkspaceMappings(repository: SyncRepository): Promise<void>;
      };

      await internals.ensureWorkspaceMappings(repository);

      expect(
        repository.state.pendingDatabaseChanges[0]?.blockedReason,
      ).toBe(INCOMPLETE_CHAT_CONTINUATION_BLOCK_REASON);
      expect(pendingHelperBatch(repository).changes).toEqual([]);
      manager.dispose();
    },
  );

  it("still clears a mapping-owned block after a complete v2 chat no longer needs it", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-manager-chat-mapping-complete-"),
    );
    temporaryRoots.push(temporaryRoot);
    const workspaceStorageRoot = join(temporaryRoot, "workspaceStorage");
    await mkdir(workspaceStorageRoot, { recursive: true });
    const resourceId = "chat/12345678-89ab-4cde-8fab-0123456789ab";
    const eventHash = "6".repeat(64);
    const tip = {
      versionId: `${eventHash}#0`,
      eventHash,
      changeIndex: 0,
      kind: "chat",
      lamport: 1,
      deviceId: "remote-device",
      operation: "put",
      semanticHash: "5".repeat(64),
      parents: [],
      producer: {
        extensionVersion: "0.0.61",
        cursorVersion: "3.15.6",
        vscodeVersion: "1.125.0",
      },
      metadata: {
        chatSnapshotSchemaVersion: 2,
        agentKvMissingCount: 0,
        workspaceId: null,
      },
    } satisfies ResourceTip;
    const repository = {
      state: {
        pendingDatabaseChanges: [
          {
            resourceId,
            kind: "chat",
            eventHash,
            changeIndex: 0,
            blockedReason:
              "Workspace mapping is required for incoming workspace storage.",
          },
        ],
        tips: { [resourceId]: [tip] },
      },
    } as unknown as SyncRepository;
    const manager = createManager({
      paths: {
        workspaceStorageRoot,
        extensionStorage: join(temporaryRoot, "extension-storage"),
        helperScript: join(temporaryRoot, "helper.js"),
      } as unknown as CursorPaths,
      configuration: {
        syncChat: true,
        syncWorkspaceStorage: true,
        effectiveIgnoredWorkspaces: [],
        workspaceMappings: {},
      } as unknown as ExtensionConfiguration,
    });
    const internals = manager as unknown as {
      ensureWorkspaceMappings(repository: SyncRepository): Promise<void>;
    };

    await internals.ensureWorkspaceMappings(repository);

    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();

    const applyFailure = `${APPLY_FAILURE_BLOCK_PREFIX}: prior database write failed`;
    repository.state.pendingDatabaseChanges[0]!.blockedReason = applyFailure;
    await internals.ensureWorkspaceMappings(repository);
    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBe(applyFailure);
    manager.dispose();
  });

  it("keeps an unresolved workspace quiet while an exact sibling still progresses", async () => {
    const fixture = await createWorkspaceMappingHarness();
    await writeWorkspaceIdentity(
      fixture.workspaceStorageRoot,
      "local-exact",
      "file:///C:/projects/exact",
    );
    const unresolved = workspaceStorageTip(
      "remote-unresolved",
      "vscode-remote://ssh-remote+server/home/ubuntu/unresolved",
      "1",
      T0 + 2,
    );
    const exact = workspaceStorageTip(
      "remote-exact",
      "file:///C:/projects/exact",
      "2",
      T0 + 1,
      WORKSPACE_MAPPING_BLOCK_REASON,
    );
    const repository = workspaceMappingRepository([unresolved, exact]);

    await fixture.ensureWorkspaceMappings(repository);

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(
      repository.state.pendingDatabaseChanges.find(
        (pending) => pending.resourceId === unresolved.pending.resourceId,
      )?.blockedReason,
    ).toBe(WORKSPACE_MAPPING_BLOCK_REASON);
    expect(
      repository.state.pendingDatabaseChanges.find(
        (pending) => pending.resourceId === exact.pending.resourceId,
      )?.blockedReason,
    ).toBeUndefined();
    expect(fixture.setWorkspaceMapping).toHaveBeenCalledOnce();
    expect(fixture.setWorkspaceMapping).toHaveBeenCalledWith(
      "remote-exact",
      "local-exact",
    );
    fixture.manager.dispose();
  });

  it("persists an exact URI mapping without opening the picker", async () => {
    const fixture = await createWorkspaceMappingHarness();
    const sourceUri = "file:///C:/projects/exact-target";
    await writeWorkspaceIdentity(
      fixture.workspaceStorageRoot,
      "local-target",
      sourceUri,
    );
    const entry = workspaceStorageTip(
      "remote-source",
      sourceUri,
      "3",
      T0,
      WORKSPACE_MAPPING_BLOCK_REASON,
    );
    const repository = workspaceMappingRepository([entry]);

    await fixture.ensureWorkspaceMappings(repository);

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(fixture.setWorkspaceMapping).toHaveBeenCalledWith(
      "remote-source",
      "local-target",
    );
    expect(fixture.workspaceMappings).toEqual({
      "remote-source": "local-target",
    });
    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
    fixture.manager.dispose();
  });

  it("repairs a stale mapping when the exact URI now identifies another target", async () => {
    const fixture = await createWorkspaceMappingHarness({
      "remote-source": "missing-old-target",
    });
    const sourceUri = "file:///C:/projects/current-target";
    await writeWorkspaceIdentity(
      fixture.workspaceStorageRoot,
      "current-target",
      sourceUri,
    );
    const entry = workspaceStorageTip(
      "remote-source",
      sourceUri,
      "4",
      T0,
      WORKSPACE_MAPPING_BLOCK_REASON,
    );
    const repository = workspaceMappingRepository([entry]);

    await fixture.ensureWorkspaceMappings(repository);

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(fixture.setWorkspaceMapping).toHaveBeenCalledOnce();
    expect(fixture.setWorkspaceMapping).toHaveBeenCalledWith(
      "remote-source",
      "current-target",
    );
    expect(fixture.workspaceMappings["remote-source"]).toBe("current-target");
    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
    fixture.manager.dispose();
  });

  it("resolves the same workspace ID without persisting or prompting", async () => {
    const fixture = await createWorkspaceMappingHarness();
    const workspaceId = "same-workspace";
    const workspaceUri = "file:///C:/projects/same-workspace";
    await writeWorkspaceIdentity(
      fixture.workspaceStorageRoot,
      workspaceId,
      workspaceUri,
    );
    await writeWorkspaceIdentity(
      fixture.workspaceStorageRoot,
      "same-workspace-duplicate-uri",
      `${workspaceUri}/`,
    );
    const entry = workspaceStorageTip(
      workspaceId,
      workspaceUri,
      "7",
      T0,
      WORKSPACE_MAPPING_BLOCK_REASON,
    );
    const repository = workspaceMappingRepository([entry]);

    await fixture.ensureWorkspaceMappings(repository);

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
    fixture.manager.dispose();
  });

  it("uses a valid stored workspace mapping without persisting or prompting", async () => {
    const fixture = await createWorkspaceMappingHarness({
      "stored-source": "stored-target",
    });
    const storedTargetUri = "file:///C:/projects/stored-target";
    await writeWorkspaceIdentity(
      fixture.workspaceStorageRoot,
      "stored-target",
      storedTargetUri,
    );
    await writeWorkspaceIdentity(
      fixture.workspaceStorageRoot,
      "stored-target-duplicate-uri",
      `${storedTargetUri}/`,
    );
    const entry = workspaceStorageTip(
      "stored-source",
      storedTargetUri,
      "8",
      T0,
      WORKSPACE_MAPPING_BLOCK_REASON,
    );
    const repository = workspaceMappingRepository([entry]);

    await fixture.ensureWorkspaceMappings(repository);

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
    fixture.manager.dispose();
  });

  it("defers duplicate normalized URI candidates without prompting during routine sync", async () => {
    const fixture = await createWorkspaceMappingHarness();
    const sourceWorkspaceUri = "file:///C:/projects/duplicate-normalized-uri";
    await Promise.all([
      writeWorkspaceIdentity(
        fixture.workspaceStorageRoot,
        "duplicate-uri-a",
        sourceWorkspaceUri,
      ),
      writeWorkspaceIdentity(
        fixture.workspaceStorageRoot,
        "duplicate-uri-b",
        `${sourceWorkspaceUri}/`,
      ),
    ]);
    const entry = workspaceStorageTip(
      "duplicate-uri-source",
      sourceWorkspaceUri,
      "9",
      T0,
    );
    const repository = workspaceMappingRepository([entry]);

    await fixture.ensureWorkspaceMappings(repository);

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBe(WORKSPACE_MAPPING_BLOCK_REASON);
    fixture.manager.dispose();
  });

  it("pages more than 512 source and stored-target identity references", async () => {
    const mappings = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `paged-source-${index.toString().padStart(3, "0")}`,
        `paged-target-${index.toString().padStart(3, "0")}`,
      ]),
    );
    const fixture = await createWorkspaceMappingHarness(mappings);
    await Promise.all(
      Object.values(mappings).map((targetWorkspaceId) =>
        writeWorkspaceIdentity(
          fixture.workspaceStorageRoot,
          targetWorkspaceId,
          `file:///C:/projects/${targetWorkspaceId}`,
        ),
      ),
    );
    const entries = Object.keys(mappings).map((sourceWorkspaceId, index) =>
      workspaceStorageTip(
        sourceWorkspaceId,
        `vscode-remote://ssh-remote+server/home/ubuntu/${sourceWorkspaceId}`,
        (index % 10).toString(),
        T0 + index,
        WORKSPACE_MAPPING_BLOCK_REASON,
      ),
    );
    const repository = workspaceMappingRepository(entries);

    await fixture.ensureWorkspaceMappings(repository);

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(
      repository.state.pendingDatabaseChanges.filter(
        (pending) => pending.blockedReason !== undefined,
      ),
    ).toEqual([]);
    fixture.manager.dispose();
  });

  it("defers ambiguous workspace storage while chat and settings remain applicable", async () => {
    const fixture = await createWorkspaceMappingHarness();
    const sourceWorkspaceId = "ambiguous-source";
    const unresolved = workspaceStorageTip(
      sourceWorkspaceId,
      "vscode-remote://ssh-remote+server/home/ubuntu/ambiguous",
      "9",
      T0 + 2,
    );
    const repository = workspaceMappingRepository([unresolved]);
    const chatResourceId = "chat/12345678-1234-4123-8123-1234567890ab";
    const chatEventHash = "a".repeat(64);
    const chatTip = {
      versionId: `${chatEventHash}#0`,
      eventHash: chatEventHash,
      changeIndex: 0,
      kind: "chat",
      lamport: 1,
      deviceId: "remote-device",
      operation: "put",
      semanticHash: chatEventHash,
      payload: {
        deviceId: "remote-device",
        objectId: chatEventHash,
        compressedBytes: 1,
        plainBytes: 1,
      },
      parents: [],
      producer: {
        extensionVersion: "0.0.61",
        cursorVersion: "3.15.6",
        vscodeVersion: "1.125.0",
      },
      metadata: {
        chatSnapshotSchemaVersion: 2,
        agentKvMissingCount: 0,
        workspaceId: sourceWorkspaceId,
        workspaceUri:
          "vscode-remote://ssh-remote+server/home/ubuntu/ambiguous",
      },
    } satisfies ResourceTip;
    const settings = helperTip(
      "settings/default/mixed-workspace-test",
      "b".repeat(64),
      1,
    );
    repository.state.pendingDatabaseChanges.push(
      {
        resourceId: chatResourceId,
        kind: "chat",
        eventHash: chatEventHash,
        changeIndex: 0,
        blockedReason: WORKSPACE_MAPPING_BLOCK_REASON,
      },
      settings.pending,
    );
    repository.state.tips[chatResourceId] = [chatTip];
    repository.state.tips[settings.pending.resourceId] = [settings.tip];

    await fixture.ensureWorkspaceMappings(repository);

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(
      repository.state.pendingDatabaseChanges.find(
        (pending) => pending.resourceId === unresolved.pending.resourceId,
      )?.blockedReason,
    ).toBe(WORKSPACE_MAPPING_BLOCK_REASON);
    expect(
      repository.state.pendingDatabaseChanges.find(
        (pending) => pending.resourceId === chatResourceId,
      )?.blockedReason,
    ).toBeUndefined();
    const applicable = pendingHelperBatch(repository).changes.map(
      (change) => change.resourceId,
    );
    expect(applicable).toEqual([chatResourceId, settings.pending.resourceId]);
    fixture.manager.dispose();
  });

  it("shows a picker only through the explicit public mapping command", async () => {
    const fixture = await createManualWorkspaceMappingFixture();
    vscodeRuntime.showQuickPick.mockImplementationOnce(
      async (items: Array<{ workspaceId: string | null }>) =>
        items.find((item) => item.workspaceId === fixture.targetWorkspaceId),
    );

    await fixture.manager.mapPendingWorkspaces();

    expect(vscodeRuntime.showQuickPick).toHaveBeenCalledOnce();
    expect(fixture.setWorkspaceMapping).toHaveBeenCalledWith(
      fixture.sourceWorkspaceId,
      fixture.targetWorkspaceId,
    );
    expect(
      fixture.repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
    fixture.manager.dispose();
  });

  it("maps a unique exact candidate beyond the initial discovery page without a picker", async () => {
    const sourceWorkspaceUri = "file:///C:/projects/expanded-exact-target";
    const fixture = await createManualWorkspaceMappingFixture({
      sourceWorkspaceUri,
    });
    const targetWorkspaceId = "zz-expanded-exact-target";
    await seedExpandedWorkspaceCandidates(
      fixture.workspaceStorageRoot,
      targetWorkspaceId,
      sourceWorkspaceUri,
    );

    await fixture.manager.mapPendingWorkspaces();

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(fixture.takeCommandLock).toHaveBeenCalledTimes(2);
    expect(fixture.refreshState).toHaveBeenCalledTimes(2);
    expect(fixture.setWorkspaceMapping).toHaveBeenCalledOnce();
    expect(fixture.setWorkspaceMapping).toHaveBeenCalledWith(
      fixture.sourceWorkspaceId,
      targetWorkspaceId,
    );
    expect(
      fixture.repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
    expect(fixture.refreshAdapters).toHaveBeenCalledOnce();
    expect(fixture.startFinalizer).toHaveBeenCalledOnce();
    fixture.manager.dispose();
  });

  it("ignores an expanded exact candidate that changes after the apply lock is reacquired", async () => {
    const sourceWorkspaceUri = "file:///C:/projects/expanded-stale-target";
    const fixture = await createManualWorkspaceMappingFixture({
      sourceWorkspaceUri,
    });
    const targetWorkspaceId = "zz-expanded-stale-target";
    await seedExpandedWorkspaceCandidates(
      fixture.workspaceStorageRoot,
      targetWorkspaceId,
      sourceWorkspaceUri,
    );
    fixture.refreshState.mockImplementation(async () => {
      if (fixture.refreshState.mock.calls.length === 2) {
        await writeWorkspaceIdentity(
          fixture.workspaceStorageRoot,
          targetWorkspaceId,
          "file:///C:/projects/replaced-expanded-target-with-different-length",
        );
      }
    });

    await fixture.manager.mapPendingWorkspaces();

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(fixture.takeCommandLock).toHaveBeenCalledTimes(2);
    expect(fixture.refreshState).toHaveBeenCalledTimes(2);
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(
      fixture.repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBe(WORKSPACE_MAPPING_BLOCK_REASON);
    expect(fixture.refreshAdapters).not.toHaveBeenCalled();
    expect(fixture.startFinalizer).not.toHaveBeenCalled();
    fixture.manager.dispose();
  });

  it("offers duplicate normalized URI candidates only through the safe manual picker", async () => {
    const sourceWorkspaceUri = "file:///C:/projects/manual-duplicate-uri";
    const fixture = await createManualWorkspaceMappingFixture({
      sourceWorkspaceUri,
    });
    await Promise.all([
      writeWorkspaceIdentity(
        fixture.workspaceStorageRoot,
        "manual-duplicate-a",
        sourceWorkspaceUri,
      ),
      writeWorkspaceIdentity(
        fixture.workspaceStorageRoot,
        "manual-duplicate-b",
        `${sourceWorkspaceUri}/`,
      ),
    ]);
    let shownItems: Array<{
      label: string;
      workspaceId: string | null;
    }> = [];
    vscodeRuntime.showQuickPick.mockImplementationOnce(
      async (
        items: Array<{
          label: string;
          workspaceId: string | null;
        }>,
      ) => {
        shownItems = items;
        return items[0];
      },
    );

    await fixture.manager.mapPendingWorkspaces();

    expect(vscodeRuntime.showQuickPick).toHaveBeenCalledOnce();
    expect(shownItems[0]?.workspaceId).toBeNull();
    expect(shownItems[0]?.label).toContain("Skip");
    expect(shownItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: "manual-duplicate-a" }),
        expect.objectContaining({ workspaceId: "manual-duplicate-b" }),
      ]),
    );
    expect(fixture.takeCommandLock).toHaveBeenCalledOnce();
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(
      fixture.repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBe(WORKSPACE_MAPPING_BLOCK_REASON);
    fixture.manager.dispose();
  });

  it("refreshes mapping consumers when the public initial pass clears a same-ID block", async () => {
    const fixture = await createManualWorkspaceMappingFixture();
    await writeWorkspaceIdentity(
      fixture.workspaceStorageRoot,
      fixture.sourceWorkspaceId,
      "vscode-remote://ssh-remote+server/home/ubuntu/manual-source",
    );

    await fixture.manager.mapPendingWorkspaces();

    expect(vscodeRuntime.showQuickPick).not.toHaveBeenCalled();
    expect(fixture.takeCommandLock).toHaveBeenCalledOnce();
    expect(fixture.refreshState).toHaveBeenCalledOnce();
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(
      fixture.repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBeUndefined();
    expect(fixture.refreshAdapters).toHaveBeenCalledOnce();
    expect(fixture.startFinalizer).toHaveBeenCalledOnce();
    fixture.manager.dispose();
  });

  it("releases the read lock while picking, then revalidates and refreshes helper consumers", async () => {
    const fixture = await createManualWorkspaceMappingFixture();
    vscodeRuntime.showQuickPick.mockImplementationOnce(
      async (items: Array<{ workspaceId: string | null }>) => {
        expect(fixture.firstLock.release).toHaveBeenCalledOnce();
        expect(fixture.secondLock.release).not.toHaveBeenCalled();
        expect(fixture.takeCommandLock).toHaveBeenCalledOnce();
        return items.find(
          (item) => item.workspaceId === fixture.targetWorkspaceId,
        );
      },
    );

    await fixture.manager.mapPendingWorkspaces();

    expect(fixture.takeCommandLock).toHaveBeenCalledTimes(2);
    expect(fixture.refreshState).toHaveBeenCalledTimes(2);
    expect(fixture.setWorkspaceMapping).toHaveBeenCalledWith(
      fixture.sourceWorkspaceId,
      fixture.targetWorkspaceId,
    );
    expect(fixture.secondLock.release).toHaveBeenCalledOnce();
    expect(fixture.refreshAdapters).toHaveBeenCalledOnce();
    expect(fixture.startFinalizer).toHaveBeenCalledOnce();
    fixture.manager.dispose();
  });

  it("ignores a selection when the pending source changes before the apply lock refresh", async () => {
    const fixture = await createManualWorkspaceMappingFixture();
    fixture.refreshState.mockImplementation(async () => {
      if (fixture.refreshState.mock.calls.length !== 2) {
        return;
      }
      const eventHash = "d".repeat(64);
      const current = fixture.repository.state.tips[
        fixture.entry.pending.resourceId
      ]![0]!;
      fixture.repository.state.pendingDatabaseChanges[0] = {
        ...fixture.repository.state.pendingDatabaseChanges[0]!,
        eventHash,
      };
      fixture.repository.state.tips[fixture.entry.pending.resourceId] = [
        {
          ...current,
          versionId: `${eventHash}#0`,
          eventHash,
          semanticHash: eventHash,
          metadata: {
            ...current.metadata,
            workspaceUri:
              "vscode-remote://ssh-remote+server/home/ubuntu/replaced-source",
          },
        },
      ];
    });
    vscodeRuntime.showQuickPick.mockImplementationOnce(
      async (items: Array<{ workspaceId: string | null }>) =>
        items.find((item) => item.workspaceId === fixture.targetWorkspaceId),
    );

    await fixture.manager.mapPendingWorkspaces();

    expect(fixture.refreshState).toHaveBeenCalledTimes(2);
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(fixture.refreshAdapters).not.toHaveBeenCalled();
    expect(fixture.startFinalizer).not.toHaveBeenCalled();
    fixture.manager.dispose();
  });

  it("ignores a selection when the target identity changes before revalidation", async () => {
    const fixture = await createManualWorkspaceMappingFixture();
    vscodeRuntime.showQuickPick.mockImplementationOnce(
      async (items: Array<{ workspaceId: string | null }>) => {
        await writeWorkspaceIdentity(
          fixture.workspaceStorageRoot,
          fixture.targetWorkspaceId,
          "file:///C:/projects/replaced-target-with-a-different-uri",
        );
        return items.find(
          (item) => item.workspaceId === fixture.targetWorkspaceId,
        );
      },
    );

    await fixture.manager.mapPendingWorkspaces();

    expect(fixture.refreshState).toHaveBeenCalledTimes(2);
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(fixture.refreshAdapters).not.toHaveBeenCalled();
    expect(fixture.startFinalizer).not.toHaveBeenCalled();
    fixture.manager.dispose();
  });

  it.each(["disconnected", "repository-changed"] as const)(
    "ignores a selection after the manager is $mode",
    async (mode) => {
      const fixture = await createManualWorkspaceMappingFixture();
      vscodeRuntime.showQuickPick.mockImplementationOnce(
        async (items: Array<{ workspaceId: string | null }>) => {
          fixture.internals.repository =
            mode === "disconnected"
              ? null
              : ({
                  ...fixture.repository,
                  root: "replacement-repository",
                } as SyncRepository);
          return items.find(
            (item) => item.workspaceId === fixture.targetWorkspaceId,
          );
        },
      );

      await fixture.manager.mapPendingWorkspaces();

      expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
      expect(fixture.refreshAdapters).not.toHaveBeenCalled();
      expect(fixture.startFinalizer).not.toHaveBeenCalled();
      fixture.manager.dispose();
    },
  );

  it("offers a safe first cancel item and known candidates during incomplete discovery", async () => {
    const fixture = await createManualWorkspaceMappingFixture();
    const unreadableDirectory = join(
      fixture.workspaceStorageRoot,
      "unreadable-target",
    );
    await mkdir(unreadableDirectory, { recursive: true });
    await writeFile(
      join(unreadableDirectory, "workspace.json"),
      "{not valid workspace metadata",
      "utf8",
    );

    let shownItems: Array<{
      label: string;
      workspaceId: string | null;
    }> = [];
    vscodeRuntime.showQuickPick.mockImplementationOnce(
      async (
        items: Array<{
          label: string;
          workspaceId: string | null;
        }>,
      ) => {
        shownItems = items;
        return items[0];
      },
    );

    await fixture.manager.mapPendingWorkspaces();

    expect(vscodeRuntime.showQuickPick).toHaveBeenCalledOnce();
    expect(shownItems[0]?.workspaceId).toBeNull();
    expect(shownItems[0]?.label).toContain("Skip");
    expect(shownItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: fixture.targetWorkspaceId,
        }),
      ]),
    );
    expect(fixture.setWorkspaceMapping).not.toHaveBeenCalled();
    expect(
      fixture.repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBe(WORKSPACE_MAPPING_BLOCK_REASON);
    fixture.manager.dispose();
  });
});

describe("running ordinary apply drift guard", () => {
  it("preflights oversized live payloads, keeps their block stable, and applies a small sibling", async () => {
    const apply = vi.fn(async () => undefined);
    const adapter: ResourceAdapter = {
      id: "bounded-live-settings",
      kinds: ["settings"],
      appliesWhileRunning: true,
      scanStatus: () => ({ complete: true, deferredResourceIds: [] }),
      scan: async () => ({ snapshots: [], deletions: [], warnings: [] }),
      apply,
    };
    const fixture = await createSyncHarness(adapter);
    fixture.repository.setMaxPayloadBytes(64 * 1024 * 1024);
    const oversized = namedSettingsSnapshot(
      "settings/default/oversized-live",
      "oversized",
    );
    const small = namedSettingsSnapshot(
      "settings/default/small-live",
      "small",
    );
    await fixture.repository.publish([oversized, small], []);
    await reconcileAndPersist(fixture.repository);
    const oversizedTip = fixture.repository.state.tips[
      oversized.resourceId
    ]![0]!;
    const smallTip = fixture.repository.state.tips[small.resourceId]![0]!;
    if (oversizedTip.payload === undefined) {
      throw new Error("expected oversized live payload metadata");
    }
    oversizedTip.payload.plainBytes =
      MAX_RUNNING_APPLY_PAYLOAD_BYTES + 1;
    for (const snapshot of [oversized, small]) {
      fixture.repository.state.projections[snapshot.resourceId] = {
        resourceId: snapshot.resourceId,
        kind: "settings",
        semanticHash: sha256(Buffer.from(`known-${snapshot.resourceId}`)),
        versionId: null,
      };
    }
    const projections = [oversizedTip, smallTip].map((tip) => ({
      resourceId:
        tip === oversizedTip ? oversized.resourceId : small.resourceId,
      tip: { ...tip, deviceId: "remote-device" },
      changed: true,
    }));
    type LiveProjection = (typeof projections)[number];
    const internals = fixture.manager as unknown as {
      configuration: { autoApplyFiles: boolean };
      applyProjections(
        repository: SyncRepository,
        projections: LiveProjection[],
        localSnapshots: Map<string, ReturnType<typeof namedSettingsSnapshot>>,
        manual: boolean,
      ): Promise<boolean>;
      applyPendingRunningResources(repository: SyncRepository): Promise<void>;
    };
    internals.configuration.autoApplyFiles = true;
    const readObject = vi.spyOn(fixture.repository, "readObject");

    await expect(
      internals.applyProjections(
        fixture.repository,
        projections,
        new Map(),
        false,
      ),
    ).resolves.toBe(true);

    expect(readObject).toHaveBeenCalledOnce();
    expect(readObject).toHaveBeenCalledWith(smallTip.payload);
    expect(apply).toHaveBeenCalledOnce();
    const pending = fixture.repository.state.pendingDatabaseChanges;
    expect(pending).toHaveLength(1);
    const firstReason = pending[0]?.blockedReason;
    expect(firstReason).toContain("live-apply memory limit");
    expect(firstReason).toContain("32.0 MiB live-apply memory limit");
    expect(firstReason).toContain("Reduce or replace the source payload");
    expect(firstReason).toContain("was not read");

    readObject.mockClear();
    await internals.applyPendingRunningResources(fixture.repository);
    await internals.applyPendingRunningResources(fixture.repository);

    expect(readObject).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
    expect(
      fixture.repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toBe(firstReason);
    await fixture.manager.shutdown();
  });

  it("queues an incoming setting when its bounded local scan is incomplete", async () => {
    let complete = false;
    const apply = vi.fn(async () => undefined);
    const adapter: ResourceAdapter = {
      id: "bounded-settings",
      kinds: ["settings"],
      appliesWhileRunning: true,
      scanStatus: () => ({
        complete,
        deferredResourceIds: ["settings-profile/default"],
      }),
      scan: async () => ({ snapshots: [], deletions: [], warnings: [] }),
      apply,
    };
    const fixture = await createSyncHarness(adapter);
    const remote = settingsSnapshot("remote");
    const published = await fixture.repository.publish([remote], []);
    await reconcileAndPersist(fixture.repository);
    const storedTip = fixture.repository.state.tips[remote.resourceId]![0]!;
    const knownHash = sha256(Buffer.from("known", "utf8"));
    fixture.repository.state.projections[remote.resourceId] = {
      resourceId: remote.resourceId,
      kind: "settings",
      semanticHash: knownHash,
      versionId: null,
    };
    const projection = {
      resourceId: remote.resourceId,
      tip: { ...storedTip, deviceId: "remote-device" },
      changed: true,
    };
    const internals = fixture.manager as unknown as {
      applyProjections(
        repository: SyncRepository,
        projections: Array<typeof projection>,
        localSnapshots: Map<string, ReturnType<typeof settingsSnapshot>>,
        manual: boolean,
        deferredAdapterIds?: ReadonlySet<string>,
      ): Promise<boolean>;
    };

    await expect(
      internals.applyProjections(
        fixture.repository,
        [projection],
        new Map(),
        true,
      ),
    ).resolves.toBe(true);

    expect(published.eventHash).toBe(storedTip.eventHash);
    expect(apply).not.toHaveBeenCalled();
    expect(fixture.repository.state.pendingDatabaseChanges).toHaveLength(1);
    await expect(
      internals.applyProjections(
        fixture.repository,
        [projection],
        new Map(),
        true,
      ),
    ).resolves.toBe(false);
    complete = true;
    await expect(
      internals.applyProjections(
        fixture.repository,
        [projection],
        new Map(),
        true,
        new Set([adapter.id]),
      ),
    ).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
    await expect(
      internals.applyProjections(
        fixture.repository,
        [projection],
        new Map(),
        true,
      ),
    ).resolves.toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(fixture.repository.state.pendingDatabaseChanges).toEqual([]);
    await fixture.manager.shutdown();
  });

  it("queues an ordinary successor over an unpublished local edit", async () => {
    const local = settingsSnapshot("local edit");
    const apply = vi.fn(async () => undefined);
    const adapter: ResourceAdapter = {
      id: "edited-settings",
      kinds: ["settings"],
      appliesWhileRunning: true,
      scanStatus: () => ({ complete: true, deferredResourceIds: [] }),
      scan: async () => ({ snapshots: [local], deletions: [], warnings: [] }),
      apply,
    };
    const fixture = await createSyncHarness(adapter);
    const remote = settingsSnapshot("remote");
    await fixture.repository.publish([remote], []);
    await reconcileAndPersist(fixture.repository);
    const storedTip = fixture.repository.state.tips[remote.resourceId]![0]!;
    fixture.repository.state.projections[remote.resourceId] = {
      resourceId: remote.resourceId,
      kind: "settings",
      semanticHash: sha256(Buffer.from("known", "utf8")),
      versionId: null,
    };
    const projection = {
      resourceId: remote.resourceId,
      tip: { ...storedTip, deviceId: "remote-device" },
      changed: true,
    };
    const internals = fixture.manager as unknown as {
      applyProjections(
        repository: SyncRepository,
        projections: Array<typeof projection>,
        localSnapshots: Map<string, ReturnType<typeof settingsSnapshot>>,
        manual: boolean,
      ): Promise<void>;
    };

    await internals.applyProjections(
      fixture.repository,
      [projection],
      new Map(),
      true,
    );

    expect(apply).not.toHaveBeenCalled();
    expect(fixture.repository.state.pendingDatabaseChanges).toHaveLength(1);
    await fixture.manager.shutdown();
  });
});

describe("resource adapter lifecycle", () => {
  it("waits for an active scan before disposing a replaced generation and disposes shutdown generation once", async () => {
    let announceScan!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      announceScan = resolve;
    });
    let releaseScan!: () => void;
    const scanHeld = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const oldDispose = vi.fn(async () => undefined);
    const replacementDispose = vi.fn(async () => undefined);
    const oldAdapter: ResourceAdapter = {
      id: "held-settings",
      kinds: ["settings"],
      appliesWhileRunning: true,
      scan: vi.fn(async () => {
        announceScan();
        await scanHeld;
        return { snapshots: [], deletions: [], warnings: [] };
      }),
      apply: async () => undefined,
      dispose: oldDispose,
    };
    const replacement: ResourceAdapter = {
      id: "replacement-settings",
      kinds: ["settings"],
      appliesWhileRunning: true,
      scan: async () => ({ snapshots: [], deletions: [], warnings: [] }),
      apply: async () => undefined,
      dispose: replacementDispose,
    };
    const fixture = await createSyncHarness(oldAdapter);
    const internals = fixture.manager as unknown as {
      createAdapters(): ResourceAdapter[];
      refreshAdapters(): Promise<void>;
    };
    internals.createAdapters = vi.fn(() => [replacement]);

    try {
      const cycle = fixture.manager.syncNow(true);
      await scanStarted;
      const refresh = internals.refreshAdapters();
      await Promise.resolve();

      expect(oldDispose).not.toHaveBeenCalled();
      releaseScan();
      await Promise.all([cycle, refresh]);
      expect(oldDispose).toHaveBeenCalledTimes(1);
      expect(replacementDispose).not.toHaveBeenCalled();

      await fixture.manager.shutdown();
      await fixture.manager.shutdown();
      expect(oldDispose).toHaveBeenCalledTimes(1);
      expect(replacementDispose).toHaveBeenCalledTimes(1);
    } finally {
      releaseScan();
      await fixture.manager.shutdown();
    }
  });
});

describe("repository open locking", () => {
  it("waits through a bounded timeout and never runs before a real lock exists", async () => {
    const order: string[] = [];
    const lock = {
      path: "sync.lock",
      refresh: () => undefined,
      release: vi.fn(async () => {
        order.push("release");
      }),
    } satisfies FileLock;
    const acquire = vi
      .fn<() => Promise<FileLock | null>>()
      .mockImplementationOnce(async () => {
        order.push("timeout");
        return null;
      })
      .mockImplementationOnce(async () => {
        order.push("acquired");
        return lock;
      });
    const run = vi.fn(async () => {
      order.push("run");
      return "opened";
    });

    await expect(withRequiredFileLock(acquire, run)).resolves.toBe("opened");

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
    expect(lock.release).toHaveBeenCalledOnce();
    expect(order).toEqual(["timeout", "acquired", "run", "release"]);
  });

  it("fails closed when lock acquisition itself errors", async () => {
    const run = vi.fn(async () => "must not run");

    await expect(
      withRequiredFileLock(
        async () => {
          throw new Error("EPERM probing sync.lock");
        },
        run,
      ),
    ).rejects.toThrow("EPERM probing sync.lock");
    expect(run).not.toHaveBeenCalled();
  });

  it("releases a lock acquired after cancellation without running", async () => {
    let active = true;
    const lock = {
      path: "sync.lock",
      refresh: () => undefined,
      release: vi.fn(async () => undefined),
    } satisfies FileLock;
    const run = vi.fn(async () => "must not run");

    await expect(
      withRequiredFileLock(
        async () => {
          active = false;
          return lock;
        },
        run,
        () => active,
      ),
    ).rejects.toThrow("cancelled");
    expect(lock.release).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("multi-window deferred repository activation", () => {
  it("keeps a standby window from reading, parsing, or serializing local state", async () => {
    const fixture = await createDeferredManagerFixture(true);
    const roleLock = await acquireFileLock(
      join(fixture.extensionStorage, "background-role.lock"),
    );
    const syncLock = await acquireFileLock(
      join(fixture.extensionStorage, "sync.lock"),
    );
    expect(roleLock).not.toBeNull();
    expect(syncLock).not.toBeNull();
    const ensureInitialized = vi.spyOn(
      SyncRepository.prototype,
      "ensureInitialized",
    );
    const openDeferred = vi.spyOn(
      SyncRepository,
      "openDeferredWithMasterKey",
    );
    const loadLocalState = vi.spyOn(LocalStateStore.prototype, "load");
    const loadOrCreateLocalState = vi.spyOn(
      LocalStateStore.prototype,
      "loadOrCreate",
    );
    const saveLocalState = vi.spyOn(LocalStateStore.prototype, "save");

    try {
      await fixture.manager.initialize();

      expect(fixture.openedRepository()).toBeNull();
      expect(openDeferred).not.toHaveBeenCalled();
      expect(loadLocalState).not.toHaveBeenCalled();
      expect(loadOrCreateLocalState).not.toHaveBeenCalled();
      expect(saveLocalState).not.toHaveBeenCalled();
      expect(ensureInitialized).not.toHaveBeenCalled();
      expect(fixture.lastStatus()).toBe("up-to-date");
    } finally {
      await syncLock?.release();
      await roleLock?.release();
      await fixture.manager.shutdown();
    }
  });

  it("initializes a standby repository only when that window manually synchronizes", async () => {
    const fixture = await createDeferredManagerFixture();
    const roleLock = await acquireFileLock(
      join(fixture.extensionStorage, "background-role.lock"),
    );
    expect(roleLock).not.toBeNull();
    const ensureInitialized = vi.spyOn(
      SyncRepository.prototype,
      "ensureInitialized",
    );
    const openDeferred = vi.spyOn(
      SyncRepository,
      "openDeferredWithMasterKey",
    );
    const loadLocalState = vi.spyOn(LocalStateStore.prototype, "load");
    const loadOrCreateLocalState = vi.spyOn(
      LocalStateStore.prototype,
      "loadOrCreate",
    );

    try {
      await fixture.manager.initialize();
      expect(openDeferred).not.toHaveBeenCalled();
      expect(loadLocalState).not.toHaveBeenCalled();
      expect(loadOrCreateLocalState).not.toHaveBeenCalled();
      expect(ensureInitialized).not.toHaveBeenCalled();

      await fixture.manager.syncNow(true);

      expect(openDeferred).toHaveBeenCalledOnce();
      expect(loadLocalState).not.toHaveBeenCalled();
      expect(loadOrCreateLocalState).toHaveBeenCalledOnce();
      expect(ensureInitialized).toHaveBeenCalledOnce();
      expect(fixture.openedRepository()?.isInitialized).toBe(true);
    } finally {
      await roleLock?.release();
      await fixture.manager.shutdown();
    }
  });

  it("hydrates a standby repository before collecting conflict selections", async () => {
    const fixture = await createDeferredManagerFixture();
    const roleLock = await acquireFileLock(
      join(fixture.extensionStorage, "background-role.lock"),
    );
    expect(roleLock).not.toBeNull();
    const openDeferred = vi.spyOn(
      SyncRepository,
      "openDeferredWithMasterKey",
    );
    const ensureInitialized = vi.spyOn(
      SyncRepository.prototype,
      "ensureInitialized",
    );
    const collectSelections = vi.fn(async (repository: SyncRepository) => {
      expect(repository.isInitialized).toBe(true);
      return { selections: [], deferred: ["test conflict remains deferred"] };
    });
    const internals = fixture.manager as unknown as {
      conflicts: ConflictController;
    };
    internals.conflicts = {
      collectSelections,
    } as unknown as ConflictController;

    try {
      await fixture.manager.initialize();
      expect(fixture.openedRepository()).toBeNull();

      await fixture.manager.prepareForRepositoryCommand();
      expect(fixture.openedRepository()?.isInitialized).toBe(false);
      await fixture.manager.resolveConflicts();

      expect(openDeferred).toHaveBeenCalledOnce();
      expect(ensureInitialized).toHaveBeenCalledOnce();
      expect(collectSelections).toHaveBeenCalledOnce();
    } finally {
      await roleLock?.release();
      await fixture.manager.shutdown();
    }
  });

  it("hydrates a standby repository before rendering diagnostics", async () => {
    const fixture = await createDeferredManagerFixture(true);
    const roleLock = await acquireFileLock(
      join(fixture.extensionStorage, "background-role.lock"),
    );
    expect(roleLock).not.toBeNull();
    const openDeferred = vi.spyOn(
      SyncRepository,
      "openDeferredWithMasterKey",
    );
    const ensureInitialized = vi.spyOn(
      SyncRepository.prototype,
      "ensureInitialized",
    );

    try {
      await fixture.manager.initialize();
      expect(fixture.openedRepository()).toBeNull();

      await fixture.manager.prepareForRepositoryCommand();
      expect(fixture.openedRepository()?.isInitialized).toBe(false);
      await fixture.manager.showDiagnostics();

      expect(openDeferred).toHaveBeenCalledOnce();
      expect(ensureInitialized).toHaveBeenCalledOnce();
      expect(fixture.openedRepository()?.isInitialized).toBe(true);
      expect(
        fixture.openedRepository()?.state.pendingDatabaseChanges,
      ).toHaveLength(1);
    } finally {
      await roleLock?.release();
      await fixture.manager.shutdown();
    }
  });

  it("lets the owner cycle return before an accepted launch offer queues another cycle", async () => {
    const fixture = await createDeferredManagerFixture(true);
    let syncLock = await acquireFileLock(
      join(fixture.extensionStorage, "sync.lock"),
    );
    expect(syncLock).not.toBeNull();
    const internals = fixture.manager as unknown as {
      offerQueuedApply(occasion: "launch" | "setup"): Promise<void>;
    };
    let nestedCycle = Promise.resolve();
    let nestedCycleStarted = false;
    const offerQueuedApply = vi.fn(async () => {
      nestedCycle = fixture.manager.syncNow(true);
      nestedCycleStarted = true;
      await nestedCycle;
    });

    try {
      // This window owns the background role, but the first cycle cannot take
      // sync.lock. The launch offer must stay armed against placeholder state.
      await fixture.manager.initialize();
      expect(fixture.openedRepository()?.isInitialized).toBe(false);
      expect(fixture.lastStatus()).toBe("syncing");
      await syncLock?.release();
      syncLock = null;
      internals.offerQueuedApply = offerQueuedApply;

      await fixture.manager.syncNow(false);
      await vi.waitFor(() => {
        expect(nestedCycleStarted).toBe(true);
      });
      await nestedCycle;

      expect(offerQueuedApply).toHaveBeenCalledOnce();
      expect(fixture.openedRepository()?.isInitialized).toBe(true);
    } finally {
      await syncLock?.release();
      await fixture.manager.shutdown();
    }
  });

  it("completes deferred initialization after a standby window takes ownership", async () => {
    const fixture = await createDeferredManagerFixture();
    let roleLock = await acquireFileLock(
      join(fixture.extensionStorage, "background-role.lock"),
    );
    expect(roleLock).not.toBeNull();
    const ensureInitialized = vi.spyOn(
      SyncRepository.prototype,
      "ensureInitialized",
    );
    const openDeferred = vi.spyOn(
      SyncRepository,
      "openDeferredWithMasterKey",
    );
    const loadOrCreateLocalState = vi.spyOn(
      LocalStateStore.prototype,
      "loadOrCreate",
    );

    try {
      await fixture.manager.initialize();
      expect(openDeferred).not.toHaveBeenCalled();
      expect(loadOrCreateLocalState).not.toHaveBeenCalled();
      expect(ensureInitialized).not.toHaveBeenCalled();
      await roleLock?.release();
      roleLock = null;

      await fixture.manager.configurationChanged();

      expect(openDeferred).toHaveBeenCalledOnce();
      expect(loadOrCreateLocalState).toHaveBeenCalledOnce();
      expect(ensureInitialized).toHaveBeenCalledOnce();
      expect(fixture.openedRepository()?.isInitialized).toBe(true);
    } finally {
      await roleLock?.release();
      await fixture.manager.shutdown();
    }
  });

  it("initializes before returning a manual-command lock and releases it on failure", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-manager-command-"));
    temporaryRoots.push(temporaryRoot);
    const extensionStorage = join(temporaryRoot, "extension-storage");
    await mkdir(extensionStorage, { recursive: true });
    const manager = createManager({
      paths: {
        extensionStorage,
        helperScript: join(temporaryRoot, "helper.js"),
      } as unknown as CursorPaths,
    });
    const ensureInitialized = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("deferred recovery failed"));
    const internals = manager as unknown as {
      repository: SyncRepository;
      takeCommandLock(repository: SyncRepository): Promise<FileLock>;
    };
    const repository = { ensureInitialized } as unknown as SyncRepository;
    internals.repository = repository;

    try {
      await expect(internals.takeCommandLock(repository)).rejects.toThrow(
        "deferred recovery failed",
      );
      const recoveredLock = await acquireFileLock(
        join(extensionStorage, "sync.lock"),
      );
      expect(recoveredLock).not.toBeNull();
      await recoveredLock?.release();

      internals.repository = {
        ensureInitialized: vi.fn(async () => undefined),
      } as unknown as SyncRepository;
      await expect(internals.takeCommandLock(repository)).rejects.toThrow(
        "repository changed",
      );
      expect(ensureInitialized).toHaveBeenCalledOnce();

      internals.repository = repository;
      ensureInitialized.mockResolvedValueOnce(undefined);
      const commandLock = await internals.takeCommandLock(repository);
      expect(ensureInitialized).toHaveBeenCalledTimes(2);
      await commandLock.release();
    } finally {
      await manager.shutdown();
    }
  });
});

describe("background Git pull throttling", () => {
  it("is due on first use, repository switches, clock rollback, and interval expiry", () => {
    const previous = { root: "R1", attemptedAt: T0 };

    expect(backgroundGitPullDue(null, "R1", T0)).toBe(true);
    expect(backgroundGitPullDue(previous, "R1", T0 + 30_000)).toBe(false);
    expect(backgroundGitPullDue(previous, "R2", T0 + 30_000)).toBe(true);
    expect(backgroundGitPullDue(previous, "R1", T0 - 1)).toBe(true);
    expect(
      backgroundGitPullDue(
        previous,
        "R1",
        T0 + BACKGROUND_GIT_PULL_INTERVAL_MS,
      ),
    ).toBe(true);
  });

  it("skips repeated background fetches but keeps the Git write window active", async () => {
    const manager = createManager();
    const openGitWindow = (
      manager as unknown as {
        openGitWindow(
          repository: SyncRepository,
          forcePull?: boolean,
        ): Promise<boolean>;
      }
    ).openGitWindow.bind(manager);
    const repository = { root: "R1" } as SyncRepository;
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(T0);

    await expect(openGitWindow(repository, false)).resolves.toBe(true);
    now.mockReturnValue(T0 + 30_000);
    // `true` is important: performSync uses it to commit/push a local publish
    // even though this particular background window did not fetch.
    await expect(openGitWindow(repository, false)).resolves.toBe(true);
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(1);
    expect(gitRuntime.isGitRepository).toHaveBeenCalledTimes(1);

    // A user command is never throttled.
    await expect(openGitWindow(repository, true)).resolves.toBe(true);
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(2);
    expect(gitRuntime.isGitRepository).toHaveBeenCalledTimes(2);

    // Nor can the previous repository's timestamp suppress a newly selected
    // repository's first remote read.
    now.mockReturnValue(T0 + 31_000);
    await expect(
      openGitWindow({ root: "R2" } as SyncRepository, false),
    ).resolves.toBe(true);
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(3);
    expect(gitRuntime.isGitRepository).toHaveBeenCalledTimes(3);
    manager.dispose();
  });

  it("starts the retry interval when a slow failed probe completes", async () => {
    const manager = createManager();
    const internals = manager as unknown as {
      backgroundGitPullAttempt: { root: string; attemptedAt: number } | null;
      openGitWindow(
        repository: SyncRepository,
        forcePull?: boolean,
      ): Promise<boolean>;
    };
    const repository = { root: "R1" } as SyncRepository;
    let clock = T0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    gitRuntime.pullLatest.mockImplementationOnce(async () => {
      clock = T0 + 2 * 60_000;
      throw new Error("slow timeout");
    });

    await expect(
      internals.openGitWindow.call(manager, repository, false),
    ).resolves.toBe(false);
    expect(internals.backgroundGitPullAttempt?.attemptedAt).toBe(clock);

    clock += 30_000;
    await expect(
      internals.openGitWindow.call(manager, repository, false),
    ).resolves.toBe(true);
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(1);
    expect(gitRuntime.isGitRepository).toHaveBeenCalledTimes(1);
    manager.dispose();
  });
});

describe("background Git commit gating", () => {
  it("reuses reconciliation and skips state persistence on a second idle poll", async () => {
    const fixture = await createSyncHarness(settingsAdapter("14"));
    const local = settingsSnapshot("14");
    await fixture.repository.publish([local], []);
    await reconcileAndPersist(fixture.repository);
    const tip = fixture.repository.state.tips[local.resourceId]![0]!;
    fixture.repository.state.projections[local.resourceId] = {
      resourceId: local.resourceId,
      kind: local.kind,
      semanticHash: local.semanticHash,
      versionId: tip.versionId,
      ...(tip.payload === undefined
        ? {}
        : { payloadObjectId: tip.payload.objectId }),
    };
    const lastSyncAt = "2026-07-25T01:02:03.000Z";
    fixture.repository.state.lastSyncAt = lastSyncAt;
    await fixture.repository.saveState();
    await fixture.repository.writeAck();
    setRecentGitProbe(fixture, T0);
    const reconcile = vi.spyOn(EventReconciler.prototype, "reconcile");
    const saveState = vi.spyOn(fixture.repository, "saveState");

    await fixture.performSync(false, "all");
    await fixture.performSync(false, "all");

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(fixture.repository.state.lastSyncAt).toBe(lastSyncAt);
    await fixture.manager.shutdown();
  });

  it("keeps the post-publish reconciliation cache hot on the next poll", async () => {
    const fixture = await createSyncHarness(settingsAdapter("14"));
    await fixture.repository.writeAck();
    setRecentGitProbe(fixture, T0);
    const reconcile = vi.spyOn(EventReconciler.prototype, "reconcile");
    const saveState = vi.spyOn(fixture.repository, "saveState");

    await fixture.performSync(false, "all");
    expect(await fixture.repository.countEvents()).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(saveState).toHaveBeenCalledTimes(1);

    await fixture.performSync(false, "all");

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(saveState).toHaveBeenCalledTimes(1);
    await fixture.manager.shutdown();
  });

  it("does not run git add/push for a throttled no-op poll", async () => {
    const fixture = await createSyncHarness();
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await fixture.repository.writeAck();
    setRecentGitProbe(fixture, T0);
    now.mockReturnValue(T0 + 30_000);

    await fixture.performSync(false, "all");

    expect(gitRuntime.isGitRepository).not.toHaveBeenCalled();
    expect(gitRuntime.pullLatest).not.toHaveBeenCalled();
    expect(gitRuntime.commitAndPush).not.toHaveBeenCalled();
    await fixture.manager.shutdown();
  });

  it("commits on a due probe, an ack write, and a manual cycle", async () => {
    const probe = await createSyncHarness();
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await probe.repository.writeAck();
    setRecentGitProbe(probe, T0);
    now.mockReturnValue(T0 + BACKGROUND_GIT_PULL_INTERVAL_MS);

    await probe.performSync(false, "all");
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(1);
    expect(gitRuntime.commitAndPush).toHaveBeenCalledTimes(1);
    await probe.manager.shutdown();

    gitRuntime.isGitRepository.mockClear();
    gitRuntime.pullLatest.mockClear();
    gitRuntime.commitAndPush.mockClear();
    const ack = await createSyncHarness();
    setRecentGitProbe(ack, Date.now());

    await ack.performSync(false, "all");
    expect(gitRuntime.pullLatest).not.toHaveBeenCalled();
    expect(gitRuntime.commitAndPush).toHaveBeenCalledTimes(1);
    await ack.manager.shutdown();

    gitRuntime.isGitRepository.mockClear();
    gitRuntime.pullLatest.mockClear();
    gitRuntime.commitAndPush.mockClear();
    const manual = await createSyncHarness();
    await manual.repository.writeAck();
    setRecentGitProbe(manual, Date.now());

    await manual.performSync(true, "all");
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(1);
    expect(gitRuntime.commitAndPush).toHaveBeenCalledTimes(1);
    await manual.manager.shutdown();
  });

  it("pushes a local publish immediately and still commits before surfacing a publish error", async () => {
    const published = await createSyncHarness(settingsAdapter("16"));
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await published.repository.writeAck();
    vi.spyOn(published.repository, "writeAck").mockResolvedValue(false);
    setRecentGitProbe(published, T0);
    now.mockReturnValue(T0 + 30_000);

    await published.performSync(false, "all");
    expect(await published.repository.countEvents()).toBe(1);
    expect(gitRuntime.pullLatest).not.toHaveBeenCalled();
    expect(gitRuntime.commitAndPush).toHaveBeenCalledTimes(1);
    await published.manager.shutdown();

    gitRuntime.commitAndPush.mockClear();
    const partial = await createSyncHarness(settingsAdapter("18"));
    await partial.repository.writeAck();
    vi.spyOn(partial.repository, "writeAck").mockResolvedValue(false);
    setRecentGitProbe(partial, Date.now());
    const publish = partial.repository.publish.bind(partial.repository);
    vi.spyOn(partial.repository, "publish").mockImplementation(async (...args) => {
      const result = await publish(...args);
      if (result.eventHash !== null) {
        throw new Error("simulated failure after the event write");
      }
      return result;
    });

    await partial.performSync(false, "all");
    expect(await partial.repository.countEvents()).toBe(1);
    expect(gitRuntime.commitAndPush).toHaveBeenCalledTimes(1);
    await partial.manager.shutdown();
  });

  it("does not enrich an attempted chat tip after its ordinary publish reports failure", async () => {
    const content = Buffer.from("new local v1 chat", "utf8");
    const snapshot = {
      resourceId: "chat/23456789-89ab-4cde-8fab-0123456789ab",
      kind: "chat",
      content,
      semanticHash: sha256(content),
      metadata: {
        chatSnapshotSchemaVersion: 1,
        workspaceId: null,
      },
    } satisfies ResourceSnapshot;
    const adapter: ResourceAdapter = {
      id: "test-chat-publish-failure",
      kinds: ["chat"],
      appliesWhileRunning: false,
      scanStatus: () => ({ complete: true, deferredResourceIds: [] }),
      scan: async () => ({ snapshots: [snapshot], deletions: [], warnings: [] }),
      apply: async () => undefined,
    };
    const fixture = await createSyncHarness(adapter);
    const managerInternals = fixture.manager as unknown as {
      configuration: { syncChat: boolean };
    };
    managerInternals.configuration.syncChat = true;
    const enrich = vi
      .spyOn(chatEnrichment, "enrichCurrentChatTipsFromLiveDatabase")
      .mockResolvedValue({
        attempted: 1,
        published: 0,
        cursor: { afterResourceId: null },
        warnings: [],
        publishedResourceIds: [],
      });
    const publish = fixture.repository.publish.bind(fixture.repository);
    vi.spyOn(fixture.repository, "publish").mockImplementation(
      async (...args) => {
        const result = await publish(...args);
        if (result.eventHash !== null) {
          throw new Error("simulated failure after the chat event write");
        }
        return result;
      },
    );

    await fixture.performSync(false, "all");

    expect(await fixture.repository.countEvents()).toBe(1);
    // The ordinary pre-scan migration probe always runs. A second call would
    // be the post-publish target built from the chat whose publish just failed.
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich.mock.calls[0]?.[2].candidateIndex).toEqual([]);
    await fixture.manager.shutdown();
  });

  it("keeps degraded health through throttled idle polls and retries on the next probe", async () => {
    const fixture = await createSyncHarness();
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await fixture.repository.writeAck();
    setRecentGitProbe(fixture, T0);
    gitRuntime.pullLatest.mockRejectedValueOnce(new Error("remote offline"));
    now.mockReturnValue(T0 + BACKGROUND_GIT_PULL_INTERVAL_MS);

    await fixture.performSync(false, "all");
    expect(fixture.lastGitWindowDegraded()).toBe(true);
    expect(gitRuntime.commitAndPush).not.toHaveBeenCalled();

    now.mockReturnValue(
      T0 + BACKGROUND_GIT_PULL_INTERVAL_MS + 30_000,
    );
    await fixture.performSync(false, "all");
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(1);
    expect(gitRuntime.commitAndPush).not.toHaveBeenCalled();
    expect(fixture.lastGitWindowDegraded()).toBe(true);

    now.mockReturnValue(
      T0 + 2 * BACKGROUND_GIT_PULL_INTERVAL_MS,
    );
    await fixture.performSync(false, "all");
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(2);
    expect(gitRuntime.commitAndPush).toHaveBeenCalledTimes(1);
    expect(fixture.lastGitWindowDegraded()).toBe(false);
    await fixture.manager.shutdown();
  });

  it("keeps a pull conflict fail-closed until a later probe succeeds", async () => {
    const scan = vi.fn(async () => ({
      snapshots: [settingsSnapshot("20")],
      deletions: [],
      warnings: [],
    }));
    const fixture = await createSyncHarness({
      id: "conflict-settings",
      kinds: ["settings"],
      appliesWhileRunning: true,
      scan,
      apply: async () => undefined,
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await fixture.repository.writeAck();
    setRecentGitProbe(fixture, T0);
    gitRuntime.pullLatest.mockRejectedValueOnce(
      new GitError("conflict", "known diverged worktree"),
    );
    now.mockReturnValue(T0 + BACKGROUND_GIT_PULL_INTERVAL_MS);

    await fixture.performSync(false, "all");
    expect(scan).not.toHaveBeenCalled();
    expect(await fixture.repository.countEvents()).toBe(0);

    now.mockReturnValue(
      T0 + BACKGROUND_GIT_PULL_INTERVAL_MS + 30_000,
    );
    await fixture.performSync(false, "all");
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
    expect(await fixture.repository.countEvents()).toBe(0);

    now.mockReturnValue(T0 + 2 * BACKGROUND_GIT_PULL_INTERVAL_MS);
    await fixture.performSync(false, "all");
    expect(gitRuntime.pullLatest).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenCalledOnce();
    expect(await fixture.repository.countEvents()).toBe(1);
    expect(gitRuntime.commitAndPush).toHaveBeenCalledOnce();
    await fixture.manager.shutdown();
  });

});

describe("suppressed local snapshot metadata", () => {
  it("creates an absent projection from the newest equal current tip", () => {
    const content = Buffer.from("same local bytes", "utf8");
    const snapshot = {
      resourceId: "chat/no-prior-projection",
      kind: "chat" as const,
      content,
      semanticHash: sha256(content),
      metadata: { lastUpdatedAt: T0, bubbleCount: 5 },
    };
    const older = conflictTip(snapshot.semanticHash, "d".repeat(64), 7);
    const newer = conflictTip(snapshot.semanticHash, "e".repeat(64), 8);
    const projections: Record<string, LocalProjection> = {};

    expect(
      markSuppressedSnapshotProjection(projections, snapshot, [older, newer]),
    ).toBe(true);
    expect(projections[snapshot.resourceId]).toMatchObject({
      semanticHash: snapshot.semanticHash,
      versionId: newer.versionId,
      payloadObjectId: newer.payload?.objectId,
      sourceTimestamp: T0,
      sourceBubbleCount: 5,
    });
  });

  it("persists a verified chat's timestamp and bubble count without republishing it", async () => {
    const content = Buffer.from('{"schemaVersion":1}', "utf8");
    const snapshot = {
      resourceId: "chat/legacy-projection",
      kind: "chat" as const,
      content,
      semanticHash: sha256(content),
      metadata: {
        lastUpdatedAt: T0,
        bubbleCount: 37,
      },
    };
    const fixture = await createSyncHarness({
      id: "verified-chat",
      kinds: ["chat"],
      appliesWhileRunning: false,
      scan: async () => ({
        snapshots: [snapshot],
        deletions: [],
        warnings: [],
      }),
      apply: async () => undefined,
    });
    await fixture.repository.publish([snapshot], []);
    await reconcileAndPersist(fixture.repository);
    const tip = fixture.repository.state.tips[snapshot.resourceId]![0]!;
    fixture.repository.state.projections[snapshot.resourceId] = {
      resourceId: snapshot.resourceId,
      kind: "chat",
      semanticHash: snapshot.semanticHash,
      versionId: tip.versionId,
      ...(tip.payload === undefined
        ? {}
        : { payloadObjectId: tip.payload.objectId }),
      sourceTimestamp: T0 - 1,
    };
    await fixture.repository.saveState();
    await fixture.repository.writeAck();
    setRecentGitProbe(fixture, Date.now());

    await fixture.performSync(false, "all");

    expect(await fixture.repository.countEvents()).toBe(1);
    expect(
      fixture.repository.state.projections[snapshot.resourceId]?.sourceTimestamp,
    ).toBe(T0);
    expect(
      fixture.repository.state.projections[snapshot.resourceId]
        ?.sourceBubbleCount,
    ).toBe(37);
    await fixture.manager.shutdown();
  });

  it("settles a chat whose local bytes match another current conflict tip", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-manager-existing-tip-"),
    );
    temporaryRoots.push(temporaryRoot);
    const globalDatabase = join(temporaryRoot, "state.vscdb");
    const database = new DatabaseSync(globalDatabase);
    database.exec(
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database.exec(
      `CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
        lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
        recency INTEGER, checkpointAt INTEGER, value TEXT
      )`,
    );
    const composerId = "00000000-0000-4000-8000-0000000000cf";
    database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'workspace-a', 1, ?, 0, 0, 0, 0, '{}')`,
      )
      .run(composerId, T0);
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, "{}");
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:b0`, '{"text":"local side"}');
    database.close();

    const paths = {
      appRoot: temporaryRoot,
      globalDatabase,
      workspaceStorageRoot: join(temporaryRoot, "workspaceStorage"),
      profilesRoot: join(temporaryRoot, "profiles"),
      cursorHome: join(temporaryRoot, ".cursor"),
      cursorExtensionsManifest: join(
        temporaryRoot,
        ".cursor",
        "extensions",
        "extensions.json",
      ),
    } as CursorPaths;
    const baseline = await new StateVscdbChatAdapter(paths).scan({});
    const localSnapshot = baseline.snapshots[0]!;
    const competingHash = "c".repeat(64);
    const competingTip = conflictTip(competingHash, "a".repeat(64), 1);
    const matchingTip = conflictTip(
      localSnapshot.semanticHash,
      "b".repeat(64),
      2,
    );
    const projections: Record<string, LocalProjection> = {
      [localSnapshot.resourceId]: {
        resourceId: localSnapshot.resourceId,
        kind: "chat",
        semanticHash: competingHash,
        versionId: competingTip.versionId,
        sourceTimestamp: T0,
        sourceBubbleCount: 1,
      },
    };
    const tips = [competingTip, matchingTip];
    const adapter = new StateVscdbChatAdapter(paths);

    const emitted = await adapter.scan(projections);
    expect(emitted.snapshots).toHaveLength(1);
    expect(
      shouldPublishSnapshot(
        projections[localSnapshot.resourceId],
        emitted.snapshots[0]!,
        tips,
      ),
    ).toBe(false);
    expect(
      markSuppressedSnapshotProjection(
        projections,
        emitted.snapshots[0]!,
        tips,
      ),
    ).toBe(true);
    expect(projections[localSnapshot.resourceId]).toMatchObject({
      semanticHash: localSnapshot.semanticHash,
      versionId: matchingTip.versionId,
      payloadObjectId: matchingTip.payload?.objectId,
      sourceTimestamp: T0,
      sourceBubbleCount: 1,
    });

    expect((await adapter.scan(projections)).snapshots).toEqual([]);
    const blocker = new DatabaseSync(globalDatabase);
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      // The second scan acknowledged the adapter's pending snapshot and made
      // a settled observation. A third poll must not reopen SQLite.
      expect((await adapter.scan(projections)).snapshots).toEqual([]);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });
});

describe("queued chat final core verification", () => {
  it("copies only touched projections from a large known-state map", () => {
    const projections: Record<string, LocalProjection> = {};
    for (let index = 0; index < 100_000; index += 1) {
      const resourceId = `chat/${index.toString().padStart(12, "0")}`;
      projections[resourceId] = {
        resourceId,
        kind: "chat",
        semanticHash: "a".repeat(64),
        versionId: null,
      };
    }
    const target = "chat/000000099999";
    const sourceReads: string[] = [];
    const guarded = new Proxy(projections, {
      get(source, property, receiver) {
        if (typeof property === "string") {
          sourceReads.push(property);
        }
        return Reflect.get(source, property, receiver) as unknown;
      },
      ownKeys() {
        throw new Error("bounded projection view enumerated the full state");
      },
    });

    const overlay = projectionOverlayForBoundedScan(guarded);
    const learned = overlay[target];
    expect(learned?.resourceId).toBe(target);
    learned!.sourceBubbleCount = 7;

    expect(projections[target]?.sourceBubbleCount).toBeUndefined();
    expect(sourceReads).toEqual([target]);
    expect(Object.keys(overlay)).toEqual([target]);
  });

  it("captures and blocks a same-count same-timestamp local edit before offline apply", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-manager-chat-final-verify-"),
    );
    temporaryRoots.push(temporaryRoot);
    const globalDatabase = join(temporaryRoot, "state.vscdb");
    const database = new DatabaseSync(globalDatabase);
    database.exec(
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database.exec(
      `CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
        lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
        recency INTEGER, checkpointAt INTEGER, value TEXT
      )`,
    );
    const composerId = "00000000-0000-4000-8000-0000000000fa";
    database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'workspace-a', 1, ?, 0, 0, 0, 0, '{}')`,
      )
      .run(composerId, T0);
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, "{}");
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:b0`, '{"text":"base"}');
    database.close();
    const paths = {
      appRoot: temporaryRoot,
      globalDatabase,
      workspaceStorageRoot: join(temporaryRoot, "workspaceStorage"),
      profilesRoot: join(temporaryRoot, "profiles"),
      cursorHome: join(temporaryRoot, ".cursor"),
      cursorExtensionsManifest: join(
        temporaryRoot,
        ".cursor",
        "extensions",
        "extensions.json",
      ),
      extensionStorage: join(temporaryRoot, "storage"),
      helperScript: join(temporaryRoot, "helper.js"),
    } as CursorPaths;
    const baseline = (await new StateVscdbChatAdapter(paths).scan({}))
      .snapshots[0]!;
    const repository = await SyncRepository.create(
      join(temporaryRoot, "repository"),
      paths.extensionStorage,
      "a sufficiently long test passphrase",
      4 * 1024 * 1024,
      {
        extensionVersion: "0.0.63",
        cursorVersion: "3.15.6",
        vscodeVersion: "1.125.0",
      },
    );
    const baseEvent = await repository.publish([baseline], []);
    await reconcileAndPersist(repository);
    const baseTip = repository.state.tips[baseline.resourceId]![0]!;
    const remoteContent = Buffer.from("remote queued chat", "utf8");
    await repository.publish(
      [
        {
          ...baseline,
          content: remoteContent,
          semanticHash: sha256(remoteContent),
          parents: [`${baseEvent.eventHash}#0`],
        },
      ],
      [],
    );
    await reconcileAndPersist(repository);
    const remoteTip = repository.state.tips[baseline.resourceId]![0]!;
    repository.state.projections[baseline.resourceId] = {
      resourceId: baseline.resourceId,
      kind: "chat",
      semanticHash: baseline.semanticHash,
      versionId: baseTip.versionId,
      ...(baseTip.payload === undefined
        ? {}
        : { payloadObjectId: baseTip.payload.objectId }),
      sourceTimestamp: T0,
      sourceBubbleCount: 1,
      sourceChatCoreHash: baseline.metadata?.chatCoreHash as string,
    };
    repository.state.pendingDatabaseChanges.push({
      resourceId: baseline.resourceId,
      kind: "chat",
      eventHash: remoteTip.eventHash,
      changeIndex: remoteTip.changeIndex,
    });
    const edit = new DatabaseSync(globalDatabase);
    edit
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run('{"text":"last-millisecond local edit"}', `bubbleId:${composerId}:b0`);
    edit.close();
    const manager = createManager({
      paths,
      configuration: {
        maxPayloadBytes: 4 * 1024 * 1024,
      } as ExtensionConfiguration,
    });
    const internals = manager as unknown as {
      protectQueuedChatsBeforeOfflineApply(
        repository: SyncRepository,
      ): Promise<void>;
    };

    await internals.protectQueuedChatsBeforeOfflineApply(repository);

    expect(await repository.countEvents()).toBe(3);
    expect(
      repository.state.pendingDatabaseChanges[0]?.blockedReason,
    ).toContain("local edit");
    manager.dispose();
  });
});

describe("automatic checkpoint maintenance", () => {
  it("lets a young checkpoint age before folding newer changes", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "cursor-manager-maintenance-"),
    );
    temporaryRoots.push(temporaryRoot);
    const repository = await SyncRepository.create(
      join(temporaryRoot, "repository"),
      join(temporaryRoot, "storage"),
      "a sufficiently long test passphrase",
      4 * 1024 * 1024,
      {
        extensionVersion: "0.0.61",
        cursorVersion: "3.15.6",
        vscodeVersion: "1.125.0",
      },
    );
    await repository.publish([settingsSnapshot("14")], []);
    await reconcileAndPersist(repository);
    const firstCheckpoint = await repository.createCheckpoint(true);

    await repository.publish([settingsSnapshot("16")], []);
    await reconcileAndPersist(repository);

    const manager = createManager();
    const lock = {
      path: "maintenance-test.lock",
      refresh: () => undefined,
      release: vi.fn(async () => undefined),
    } satisfies FileLock;
    const internals = manager as unknown as {
      takeCommandLock(report: (message: string) => void): Promise<FileLock>;
      openGitWindow(repository: SyncRepository): Promise<boolean>;
      checkpointPhases(
        repository: SyncRepository,
        overrideAgeGate: boolean,
        report: (message: string) => void,
      ): Promise<{
        created: { checkpointHash: string } | null;
        prune: {
          status: "pruned" | "aborted";
          reason: string | null;
        } | null;
      }>;
    };
    internals.takeCommandLock = vi.fn(async () => lock);
    internals.openGitWindow = vi.fn(async () => false);
    const createCheckpoint = vi.spyOn(repository, "createCheckpoint");

    try {
      const young = await internals.checkpointPhases(
        repository,
        false,
        () => undefined,
      );

      expect(young.created).toBeNull();
      expect(young.prune?.status).toBe("aborted");
      expect(young.prune?.reason).toContain("younger than 24 hours");
      expect(createCheckpoint).not.toHaveBeenCalled();
      expect(repository.state.checkpoint?.hash).toBe(
        firstCheckpoint.checkpointHash,
      );

      vi.spyOn(repository, "laggingDeviceReasons").mockResolvedValue([
        "peer: stale pre-prune observation",
      ]);
      const forced = await internals.checkpointPhases(
        repository,
        true,
        () => undefined,
      );

      expect(forced.prune?.status).toBe("pruned");
      expect(forced.created?.checkpointHash).not.toBe(
        firstCheckpoint.checkpointHash,
      );
      expect(createCheckpoint).toHaveBeenCalledTimes(1);
      const newest = await repository.loadAbsorbedCheckpointManifest();
      expect(newest?.resources[0]?.semanticHash).toBe(
        sha256(Buffer.from("16", "utf8")),
      );
    } finally {
      manager.dispose();
    }
  });
});

interface WorkspaceStorageTipEntry {
  pending: {
    eventHash: string;
    changeIndex: number;
    resourceId: string;
    kind: "workspace-storage";
    blockedReason?: string;
  };
  tip: ResourceTip;
}

async function createWorkspaceMappingHarness(
  initialMappings: Record<string, string> = {},
) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "cursor-manager-workspace-mapping-"),
  );
  temporaryRoots.push(temporaryRoot);
  const workspaceStorageRoot = join(temporaryRoot, "workspaceStorage");
  await mkdir(workspaceStorageRoot, { recursive: true });
  const workspaceMappings = { ...initialMappings };
  const setWorkspaceMapping = vi.fn(
    async (sourceWorkspaceId: string, targetWorkspaceId: string) => {
      workspaceMappings[sourceWorkspaceId] = targetWorkspaceId;
    },
  );
  const manager = createManager({
    paths: {
      workspaceStorageRoot,
      extensionStorage: join(temporaryRoot, "extension-storage"),
      helperScript: join(temporaryRoot, "helper.js"),
    } as unknown as CursorPaths,
    configuration: {
      syncChat: true,
      syncWorkspaceStorage: true,
      effectiveIgnoredWorkspaces: [],
      workspaceMappings,
      setWorkspaceMapping,
    } as unknown as ExtensionConfiguration,
  });
  const internals = manager as unknown as {
    ensureWorkspaceMappings(repository: SyncRepository): Promise<void>;
  };
  return {
    manager,
    workspaceStorageRoot,
    workspaceMappings,
    setWorkspaceMapping,
    ensureWorkspaceMappings: internals.ensureWorkspaceMappings.bind(manager),
  };
}

async function createManualWorkspaceMappingFixture(
  options: { sourceWorkspaceUri?: string } = {},
) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "cursor-manager-manual-workspace-mapping-"),
  );
  temporaryRoots.push(temporaryRoot);
  const workspaceStorageRoot = join(temporaryRoot, "workspaceStorage");
  await mkdir(workspaceStorageRoot, { recursive: true });
  const sourceWorkspaceId = "manual-source";
  const targetWorkspaceId = "manual-target";
  const targetWorkspaceUri = "file:///C:/projects/manual-target";
  await writeWorkspaceIdentity(
    workspaceStorageRoot,
    targetWorkspaceId,
    targetWorkspaceUri,
  );
  const entry = workspaceStorageTip(
    sourceWorkspaceId,
    options.sourceWorkspaceUri ??
      "vscode-remote://ssh-remote+server/home/ubuntu/manual-source",
    "e",
    T0,
    WORKSPACE_MAPPING_BLOCK_REASON,
  );
  const repository = workspaceMappingRepository([entry]);
  const repositoryRoot = join(temporaryRoot, "repository");
  const repositoryId = "manual-mapping-repository";
  const refreshState = vi.fn(async () => undefined);
  const saveState = vi.fn(async () => undefined);
  Object.assign(repository, {
    root: repositoryRoot,
    repository: { repositoryId },
    setMaxPayloadBytes: vi.fn(),
    refreshState,
    saveState,
  });
  const workspaceMappings: Record<string, string> = {};
  const setWorkspaceMapping = vi.fn(
    async (sourceId: string, targetId: string) => {
      workspaceMappings[sourceId] = targetId;
    },
  );
  const manager = createManager({
    paths: {
      workspaceStorageRoot,
      extensionStorage: join(temporaryRoot, "extension-storage"),
      helperScript: join(temporaryRoot, "helper.js"),
    } as unknown as CursorPaths,
    configuration: {
      repositoryPath: repositoryRoot,
      repositoryId,
      gitSync: false,
      maxPayloadBytes: 4 * 1024 * 1024,
      syncChat: true,
      syncWorkspaceStorage: true,
      effectiveIgnoredWorkspaces: [],
      workspaceMappings,
      setWorkspaceMapping,
    } as unknown as ExtensionConfiguration,
  });
  const firstLock = {
    path: "workspace-mapping-read.lock",
    refresh: () => undefined,
    release: vi.fn(async () => undefined),
  } satisfies FileLock;
  const secondLock = {
    path: "workspace-mapping-apply.lock",
    refresh: () => undefined,
    release: vi.fn(async () => undefined),
  } satisfies FileLock;
  let lockIndex = 0;
  const takeCommandLock = vi.fn(async () => {
    const lock = [firstLock, secondLock][lockIndex];
    lockIndex += 1;
    if (lock === undefined) {
      throw new Error("unexpected extra workspace mapping lock");
    }
    return lock;
  });
  const refreshAdapters = vi.fn(async () => undefined);
  const startFinalizer = vi.fn(async () => undefined);
  const internals = manager as unknown as {
    repository: SyncRepository | null;
    takeCommandLock(repository: SyncRepository): Promise<FileLock>;
    openGitWindow(repository: SyncRepository): Promise<boolean>;
    refreshAdapters(): Promise<void>;
    startFinalizer(): Promise<void>;
  };
  internals.repository = repository;
  internals.takeCommandLock = takeCommandLock;
  internals.openGitWindow = vi.fn(async () => false);
  internals.refreshAdapters = refreshAdapters;
  internals.startFinalizer = startFinalizer;
  return {
    manager,
    internals,
    repository,
    entry,
    workspaceStorageRoot,
    sourceWorkspaceId,
    targetWorkspaceId,
    firstLock,
    secondLock,
    takeCommandLock,
    refreshState,
    saveState,
    setWorkspaceMapping,
    refreshAdapters,
    startFinalizer,
  };
}

async function seedExpandedWorkspaceCandidates(
  workspaceStorageRoot: string,
  targetWorkspaceId: string,
  targetWorkspaceUri: string,
): Promise<void> {
  await Promise.all([
    ...Array.from({ length: 40 }, (_, index) =>
      writeWorkspaceIdentity(
        workspaceStorageRoot,
        `aa-expanded-filler-${index.toString().padStart(2, "0")}`,
        `file:///C:/projects/expanded-filler-${index}`,
      ),
    ),
    writeWorkspaceIdentity(
      workspaceStorageRoot,
      targetWorkspaceId,
      targetWorkspaceUri,
    ),
  ]);
}

async function writeWorkspaceIdentity(
  workspaceStorageRoot: string,
  workspaceId: string,
  workspaceUri: string,
): Promise<void> {
  const directory = join(workspaceStorageRoot, workspaceId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "workspace.json"),
    JSON.stringify({ folder: workspaceUri }),
    "utf8",
  );
}

function workspaceStorageTip(
  sourceWorkspaceId: string,
  workspaceUri: string,
  hashCharacter: string,
  lastUpdatedAt: number,
  blockedReason?: string,
): WorkspaceStorageTipEntry {
  const eventHash = hashCharacter.repeat(64);
  const relativePath = `${sourceWorkspaceId}/notepads.json`;
  const resourceId = `workspace-storage/${encodeURIComponent(relativePath)}`;
  const tip = {
    versionId: `${eventHash}#0`,
    eventHash,
    changeIndex: 0,
    kind: "workspace-storage",
    lamport: 1,
    deviceId: "remote-device",
    operation: "put",
    semanticHash: eventHash,
    payload: {
      deviceId: "remote-device",
      objectId: eventHash,
      compressedBytes: 1,
      plainBytes: 1,
    },
    parents: [],
    producer: {
      extensionVersion: "0.0.61",
      cursorVersion: "3.15.6",
      vscodeVersion: "1.125.0",
    },
    metadata: {
      relativePath,
      workspaceId: sourceWorkspaceId,
      workspaceUri,
      lastUpdatedAt,
    },
  } satisfies ResourceTip;
  return {
    pending: {
      eventHash,
      changeIndex: 0,
      resourceId,
      kind: "workspace-storage",
      ...(blockedReason === undefined ? {} : { blockedReason }),
    },
    tip,
  };
}

function workspaceMappingRepository(
  entries: readonly WorkspaceStorageTipEntry[],
): SyncRepository {
  return {
    state: {
      pendingDatabaseChanges: entries.map((entry) => ({ ...entry.pending })),
      tips: Object.fromEntries(
        entries.map((entry) => [entry.pending.resourceId, [entry.tip]]),
      ),
      conflicts: [],
    },
  } as unknown as SyncRepository;
}

interface SyncHarness {
  manager: SyncManager;
  repository: SyncRepository;
  performSync(manual: boolean, scope: "all"): Promise<void>;
  setGitState(input: {
    attempt: { root: string; attemptedAt: number };
    mode: { root: string; checkedAt: number; active: boolean };
  }): void;
  lastGitWindowDegraded(): boolean;
}

interface DeferredManagerFixture {
  manager: SyncManager;
  extensionStorage: string;
  openedRepository(): SyncRepository | null;
  lastStatus(): string | undefined;
}

async function createDeferredManagerFixture(
  withPendingChange = false,
): Promise<DeferredManagerFixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-manager-deferred-"));
  temporaryRoots.push(temporaryRoot);
  const extensionStorage = join(temporaryRoot, "extension-storage");
  const userDataRoot = join(temporaryRoot, "cursor-user");
  const cursorHome = join(temporaryRoot, "cursor-home");
  await Promise.all([
    mkdir(extensionStorage, { recursive: true }),
    mkdir(userDataRoot, { recursive: true }),
    mkdir(cursorHome, { recursive: true }),
  ]);
  const repository = await SyncRepository.create(
    join(temporaryRoot, "repository"),
    extensionStorage,
    "a sufficiently long test passphrase",
    4 * 1024 * 1024,
    {
      extensionVersion: "0.0.62",
      cursorVersion: "3.15.6",
      vscodeVersion: "1.125.0",
    },
  );
  if (withPendingChange) {
    repository.state.pendingDatabaseChanges.push({
      resourceId: "chat/deferred-status",
      kind: "chat",
      eventHash: "a".repeat(64),
      changeIndex: 0,
    });
    await repository.saveState();
  }
  const setStatus = vi.fn();
  const status = {
    log: vi.fn(),
    setStatus,
    show: vi.fn(),
  } as unknown as StatusController;
  const configuration = {
    repositoryPath: repository.root,
    repositoryId: repository.repository.repositoryId,
    getMasterKey: vi.fn(async () => Buffer.from(repository.masterKey)),
    gitSync: false,
    enabled: true,
    maxPayloadBytes: 4 * 1024 * 1024,
    autoApplyFiles: false,
    applyOnShutdown: false,
    syncChat: false,
    syncWorkspaceStorage: false,
    effectiveIgnoredWorkspaces: [],
    workspaceMappings: {},
  } as unknown as ExtensionConfiguration;
  const manager = createManager({
    paths: {
      extensionStorage,
      helperScript: join(temporaryRoot, "helper.js"),
      userDataRoot,
      cursorHome,
    } as unknown as CursorPaths,
    configuration,
    status,
  });
  const internals = manager as unknown as {
    repository: SyncRepository | null;
    consumeHelperResults(): Promise<void>;
    refreshAdapters(): Promise<void>;
    startFinalizer(): Promise<void>;
    startBackgroundRuntime(): void;
    offerQueuedApply(): Promise<void>;
  };
  internals.consumeHelperResults = vi.fn(async () => undefined);
  internals.refreshAdapters = vi.fn(async () => undefined);
  internals.startFinalizer = vi.fn(async () => undefined);
  internals.startBackgroundRuntime = vi.fn();
  internals.offerQueuedApply = vi.fn(async () => undefined);
  return {
    manager,
    extensionStorage,
    openedRepository: () => internals.repository,
    lastStatus: () => setStatus.mock.calls.at(-1)?.[0] as string | undefined,
  };
}

async function createSyncHarness(
  adapter?: ResourceAdapter,
): Promise<SyncHarness> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-manager-sync-"));
  temporaryRoots.push(temporaryRoot);
  const extensionStorage = join(temporaryRoot, "extension-storage");
  await mkdir(extensionStorage, { recursive: true });
  const repository = await SyncRepository.create(
    join(temporaryRoot, "repository"),
    join(temporaryRoot, "storage"),
    "a sufficiently long test passphrase",
    4 * 1024 * 1024,
    {
      extensionVersion: "0.0.61",
      cursorVersion: "3.15.6",
      vscodeVersion: "1.125.0",
    },
  );
  const manager = createManager({
    paths: {
      extensionStorage,
      helperScript: join(temporaryRoot, "helper.js"),
    } as unknown as CursorPaths,
    configuration: {
      gitSync: true,
      enabled: true,
      repositoryPath: repository.root,
      repositoryId: repository.repository.repositoryId,
      getMasterKey: vi.fn(async () => Buffer.from(repository.masterKey)),
      maxPayloadBytes: 4 * 1024 * 1024,
      autoApplyFiles: false,
      applyOnShutdown: false,
      syncChat: false,
      syncWorkspaceStorage: false,
      effectiveIgnoredWorkspaces: [],
    } as unknown as ExtensionConfiguration,
  });
  const internals = manager as unknown as {
    repository: SyncRepository;
    adapters: ResourceAdapter[];
    backgroundGitPullAttempt: { root: string; attemptedAt: number } | null;
    backgroundGitModeCheck: {
      root: string;
      checkedAt: number;
      active: boolean;
    } | null;
    lastGitWindowDegraded: boolean;
    performSync(manual: boolean, scope: "all"): Promise<void>;
  };
  internals.repository = repository;
  internals.adapters = adapter === undefined ? [] : [adapter];
  return {
    manager,
    repository,
    performSync: internals.performSync.bind(manager),
    setGitState: ({ attempt, mode }) => {
      internals.backgroundGitPullAttempt = attempt;
      internals.backgroundGitModeCheck = mode;
    },
    lastGitWindowDegraded: () => internals.lastGitWindowDegraded,
  };
}

function setRecentGitProbe(fixture: SyncHarness, attemptedAt: number): void {
  fixture.setGitState({
    attempt: { root: fixture.repository.root, attemptedAt },
    mode: {
      root: fixture.repository.root,
      checkedAt: attemptedAt,
      active: true,
    },
  });
}

function settingsAdapter(value: string): ResourceAdapter {
  return {
    id: "test-settings",
    kinds: ["settings"],
    appliesWhileRunning: true,
    scan: async () => ({
      snapshots: [settingsSnapshot(value)],
      deletions: [],
      warnings: [],
    }),
    apply: async () => undefined,
  };
}

function conflictTip(
  semanticHash: string,
  eventHash: string,
  lamport: number,
): ResourceTip {
  const deviceId = `device-${lamport}`;
  return {
    versionId: `${eventHash}#0`,
    eventHash,
    changeIndex: 0,
    kind: "chat",
    lamport,
    deviceId,
    operation: "put",
    semanticHash,
    payload: {
      deviceId,
      objectId: eventHash,
      compressedBytes: 1,
      plainBytes: 1,
    },
    parents: [],
  };
}

function settingsSnapshot(value: string) {
  return namedSettingsSnapshot("settings/default/editor.fontSize", value);
}

function namedSettingsSnapshot(resourceId: string, value: string) {
  const content = Buffer.from(value, "utf8");
  return {
    resourceId,
    kind: "settings" as const,
    content,
    semanticHash: sha256(content),
  };
}

function helperTip(
  resourceId: string,
  eventHash: string,
  plainBytes: number,
): {
  pending: {
    eventHash: string;
    changeIndex: number;
    resourceId: string;
    kind: "settings";
  };
  tip: ResourceTip;
} {
  const deviceId = "remote-device";
  return {
    pending: {
      eventHash,
      changeIndex: 0,
      resourceId,
      kind: "settings",
    },
    tip: {
      versionId: `${eventHash}#0`,
      eventHash,
      changeIndex: 0,
      kind: "settings",
      lamport: 1,
      deviceId,
      operation: "put",
      semanticHash: eventHash,
      payload: {
        deviceId,
        objectId: eventHash,
        compressedBytes: 1,
        plainBytes,
      },
      parents: [],
      metadata: { profileId: "default", key: resourceId.split("/").at(-1) ?? "" },
    },
  };
}

async function reconcileAndPersist(repository: SyncRepository): Promise<void> {
  new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    await repository.loadAbsorbedCheckpointManifest(),
  );
  await repository.saveState();
  await repository.writeAck();
}

function createManager(
  options: {
    paths?: CursorPaths;
    configuration?: ExtensionConfiguration;
    status?: StatusController;
  } = {},
): SyncManager {
  const compatibility = {
    compatible: true,
    extensionVersion: "0.0.61",
    cursorVersion: "3.15.6",
    vscodeVersion: "1.125.0",
    nodeVersion: process.versions.node,
    sqliteAvailable: true,
    sqliteBackupAvailable: true,
    globalDatabasePath: "state.vscdb",
    databaseCapabilities: {
      "global-item-table": { available: true, reasons: [] },
      "global-chat": { available: true, reasons: [] },
      "sqlite-files": { available: true, reasons: [] },
    },
    reasons: [],
    warnings: [],
  } satisfies CompatibilityReport;
  return new SyncManager(
    {} as never,
    options.paths ??
      ({
        extensionStorage: "extension-storage",
        helperScript: "helper.js",
      } as unknown as CursorPaths),
    compatibility,
    options.configuration ?? ({ gitSync: true } as ExtensionConfiguration),
    options.status ??
      ({ log: vi.fn(), setStatus: vi.fn() } as unknown as StatusController),
    {} as ConflictController,
  );
}
