import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GitModule from "../src/platform/git";

const gitRuntime = vi.hoisted(() => ({
  isGitRepository: vi.fn(),
  pullLatest: vi.fn(),
  commitAndPush: vi.fn(),
  largeFileWarnings: vi.fn(),
}));

vi.mock("vscode", () => ({
  extensions: { all: [] },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  },
  window: {
    showWarningMessage: async () => undefined,
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
  SyncManager,
  backgroundGitPullDue,
  markSuppressedSnapshotProjection,
  withRequiredFileLock,
} from "../src/sync/manager";
import { StateVscdbChatAdapter } from "../src/chat/stateVscdb";
import type { ExtensionConfiguration } from "../src/config";
import { GitError } from "../src/platform/git";
import { acquireFileLock } from "../src/platform/lock";
import type { FileLock } from "../src/platform/lock";
import type { CursorPaths } from "../src/platform/paths";
import { sha256 } from "../src/protocol/canonical";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import type { ResourceAdapter } from "../src/resources/resource";
import type {
  CompatibilityReport,
  LocalProjection,
  ResourceTip,
} from "../src/types";
import type { ConflictController } from "../src/ui/conflicts";
import type { StatusController } from "../src/ui/status";
import { shouldPublishSnapshot } from "../src/sync/versionPolicy";

const { DatabaseSync } = sqlite;
const T0 = Date.parse("2026-08-08T00:00:00.000Z");
const temporaryRoots: string[] = [];

beforeEach(() => {
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
  it("keeps a standby window lightweight and preserves its local queued status", async () => {
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

    try {
      await fixture.manager.initialize();

      const opened = fixture.openedRepository();
      expect(opened).not.toBeNull();
      expect(opened?.isInitialized).toBe(false);
      expect(ensureInitialized).not.toHaveBeenCalled();
      expect(fixture.lastStatus()).toBe("pending-restart");
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

    try {
      await fixture.manager.initialize();
      expect(ensureInitialized).not.toHaveBeenCalled();

      await fixture.manager.syncNow(true);

      expect(ensureInitialized).toHaveBeenCalledOnce();
      expect(fixture.openedRepository()?.isInitialized).toBe(true);
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
      // sync.lock. The launch offer must stay armed against uninitialized state.
      await fixture.manager.initialize();
      expect(fixture.openedRepository()?.isInitialized).toBe(false);
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

    try {
      await fixture.manager.initialize();
      expect(ensureInitialized).not.toHaveBeenCalled();
      await roleLock?.release();
      roleLock = null;

      await fixture.manager.configurationChanged();

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
    refreshAdapters(): void;
    startFinalizer(): Promise<void>;
    startBackgroundRuntime(): void;
    offerQueuedApply(): Promise<void>;
  };
  internals.consumeHelperResults = vi.fn(async () => undefined);
  internals.refreshAdapters = vi.fn();
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
  const content = Buffer.from(value, "utf8");
  return {
    resourceId: "settings/default/editor.fontSize",
    kind: "settings" as const,
    content,
    semanticHash: sha256(content),
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
