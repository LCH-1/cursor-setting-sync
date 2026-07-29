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
import { mergeUiStateBuffers } from "../src/resources/uiStateMerge";
import { mergeJsoncBuffers } from "../src/resources/jsonc";
import { sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import type {
  EventProducer,
  JsonValue,
  ResourceKind,
  ResourceSnapshot,
} from "../src/types";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

// A key NOT on the policy-exclusion list: excluded keys now short-circuit to
// last-writer-wins before the structural merge these tests exercise.
const PINNED_PANELS = "ui-state/workbench.activity.pinnedViewlets2";

const BASE_PANELS = panels([
  ["workbench.panel.chatSidebar", 0, true],
  ["workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", 1, false],
]);
const LOCAL_PANELS = panels([
  ["workbench.panel.chatSidebar", 0, true],
  ["workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", 1, false],
  ["workbench.panel.aichat.11111111-1111-4111-8111-111111111111", 2, false],
]);
const REMOTE_PANELS = panels([
  ["workbench.panel.chatSidebar", 0, false],
  ["workbench.panel.aichat.fe374843-0376-48d0-bbc4-948b7a99c55b", 1, false],
  ["workbench.panel.aichat.22222222-2222-4222-8222-222222222222", 3, false],
]);

describe("ui-state auto-merge", () => {
  it("resolves a layout fork by last writer without asking the user", async () => {
    await withRepository(async (repository) => {
      const conflicts = await forkResource(
        repository,
        PINNED_PANELS,
        "ui-state",
        BASE_PANELS,
        LOCAL_PANELS,
        REMOTE_PANELS,
      );
      expect(conflicts).toHaveLength(1);
      const winner = [...(repository.state.tips[PINNED_PANELS] ?? [])].sort(
        compareTips,
      )[0];
      const winnerContent = await repository.readVersion(winner?.versionId ?? "");

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(conflicts[0]?.resolvedAt).toBeDefined();
      expect(await reconcileConflicts(repository)).toHaveLength(0);

      const tips = repository.state.tips[PINNED_PANELS] ?? [];
      expect(tips).toHaveLength(1);
      expect(tips[0]?.metadata?.syncOrigin).toBe("auto-merge");
      expect(tips[0]?.metadata?.valueType).toBe("text");
      const merged = await repository.readVersion(tips[0]?.versionId ?? "");
      expect(
        merged.content?.equals(winnerContent.content ?? Buffer.alloc(0)),
      ).toBe(true);
    });
  });

  it("takes one side whole rather than the union the structural merge would build", async () => {
    // The structural ui-state merge still exists and is still tested directly,
    // but no conflict reaches it any more: every ui-state key is excluded from
    // synchronization, so a fork is settled by the replicated comparator and
    // the value stays whatever one machine had. If this ever starts matching
    // the union again, the kind has quietly begun travelling once more.
    await withRepository(async (repository) => {
      const conflicts = await forkResource(
        repository,
        PINNED_PANELS,
        "ui-state",
        BASE_PANELS,
        LOCAL_PANELS,
        REMOTE_PANELS,
      );
      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);

      const tips = repository.state.tips[PINNED_PANELS] ?? [];
      const resolved =
        (await repository.readVersion(tips[0]?.versionId ?? "")).content ??
        Buffer.alloc(0);
      const structural =
        mergeUiStateBuffers(BASE_PANELS, LOCAL_PANELS, REMOTE_PANELS).content ??
        Buffer.alloc(0);

      expect(resolved.equals(structural)).toBe(false);
      expect(
        resolved.equals(LOCAL_PANELS) || resolved.equals(REMOTE_PANELS),
      ).toBe(true);
      // The union would have carried all four panels; one side carries three.
      expect(
        JSON.parse(structural.toString("utf8")) as unknown[],
      ).toHaveLength(4);
      expect(JSON.parse(resolved.toString("utf8")) as unknown[]).toHaveLength(3);
    });
  });

  it("falls back to the deterministic newest tip for an unmergeable value", async () => {
    await withRepository(async (repository) => {
      const resourceId = "ui-state/workbench.activityBar.location";
      const conflicts = await forkResource(
        repository,
        resourceId,
        "ui-state",
        Buffer.from("default", "utf8"),
        Buffer.from("top", "utf8"),
        Buffer.from("bottom", "utf8"),
      );
      const winner = [...(repository.state.tips[resourceId] ?? [])].sort(
        compareTips,
      )[0];
      const winnerContent = await repository.readVersion(winner?.versionId ?? "");

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(await reconcileConflicts(repository)).toHaveLength(0);

      const tips = repository.state.tips[resourceId] ?? [];
      expect(tips).toHaveLength(1);
      const resolved = await repository.readVersion(tips[0]?.versionId ?? "");
      expect(
        resolved.content?.equals(winnerContent.content ?? Buffer.alloc(0)),
      ).toBe(true);
      // The winner's own metadata rides along: the losing tip's storage class
      // would make the helper bind the value as the wrong SQLite type.
      expect(tips[0]?.metadata?.valueType).toBe(winner?.metadata?.valueType);
    });
  });

  it("attaches the same metadata whichever device runs the merge", async () => {
    // The merged bytes are identical on both devices, and the reconciler
    // collapses two merge events on operation plus semanticHash alone — so
    // device-dependent metadata would let an arbitrary tip pick decide the
    // ui-state valueType, and with it whether every device binds TEXT or BLOB.
    await withTemporaryRoot(async (temporaryRoot) => {
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
      const published = await deviceA.publish(
        [typedSnapshot(PINNED_PANELS, BASE_PANELS, "text")],
        [],
      );
      const parents = [`${published.eventHash}#0`];
      await deviceA.publish(
        [{ ...typedSnapshot(PINNED_PANELS, LOCAL_PANELS, "text"), parents }],
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
      await deviceB.publish(
        [{ ...typedSnapshot(PINNED_PANELS, REMOTE_PANELS, "blob"), parents }],
        [],
      );
      await deviceB.saveState();

      // Each device resolves the fork on its own copy of the folder, having
      // seen nothing of the other's merge.
      const [fromA, fromB] = [
        await mergeAsDevice(temporaryRoot, "a", shared, storageA),
        await mergeAsDevice(temporaryRoot, "b", shared, storageB),
      ];

      expect(fromA.content.equals(fromB.content)).toBe(true);
      expect(fromA.metadata).toEqual(fromB.metadata);
      // Whichever tip the replicated comparator calls newest owns the storage
      // class, and the two devices disagreed about the owner because each one
      // read it off the tip it happened to have published itself.
      expect([...fromA.forkedValueTypes].sort()).toEqual(["blob", "text"]);
      expect(fromA.newestValueType).toBe(fromB.newestValueType);
      expect(fromA.metadata?.valueType).toBe(fromA.newestValueType);
    });
  });

  it("leaves an over-limit merge for the manual resolver instead of aborting the cycle", async () => {
    // A three-way merge is the union of both sides' additions, so two tips that
    // each publish fine can merge into a payload `publish` rejects. That throw
    // used to escape into the sync cycle ahead of the scan, the publish batch
    // and applyProjections, and the immutable events re-derived the identical
    // conflict on every later poll — the device stopped synchronizing for good.
    const resourceId = "snippet/typescript.json";
    const base = jsonBuffer({ a: "a".repeat(1000) });
    const local = jsonBuffer({ a: "a".repeat(1000), b: "b".repeat(2500) });
    const remote = jsonBuffer({ a: "a".repeat(1000), c: "c".repeat(2500) });
    const limit = 4096;
    expect(base.byteLength).toBeLessThan(limit);
    expect(local.byteLength).toBeLessThan(limit);
    expect(remote.byteLength).toBeLessThan(limit);
    expect(
      mergeJsoncBuffers(base, local, remote).content?.byteLength ?? 0,
    ).toBeGreaterThan(limit);

    await withRepository(async (repository) => {
      const conflicts = await forkResource(
        repository,
        resourceId,
        "snippet",
        base,
        local,
        remote,
      );
      expect(conflicts).toHaveLength(1);
      const warnings: string[] = [];

      // Two cycles: the second proves the device is not wedged.
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await expect(
          autoMergeConflicts(
            repository,
            conflicts,
            () => true,
            (warning) => warnings.push(warning),
          ),
        ).resolves.toBe(false);
      }

      expect(conflicts[0]?.resolvedAt).toBeUndefined();
      expect(await reconcileConflicts(repository)).toHaveLength(1);
      expect(repository.state.tips[resourceId]).toHaveLength(2);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(resourceId);
      expect(warnings[0]).toContain("cursorSettingSync.maxPayloadMiB");
      expect(warnings[0]).toContain("Cursor Setting Sync: Resolve Conflicts");
    }, limit);
  });

  it("resolves a policy-excluded key by last writer instead of merging churn", async () => {
    await withRepository(async (repository) => {
      const resourceId =
        "ui-state/src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
      const conflicts = await forkResource(
        repository,
        resourceId,
        "ui-state",
        Buffer.from('{"tick":1}', "utf8"),
        Buffer.from('{"tick":2}', "utf8"),
        Buffer.from('{"tick":3}', "utf8"),
      );
      expect(conflicts).toHaveLength(1);

      // One LWW resolution ends the chain; the scan never republishes the
      // key, so this is the last event the resource ever produces.
      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(await reconcileConflicts(repository)).toHaveLength(0);
      expect(repository.state.tips[resourceId]).toHaveLength(1);
    });
  });

  it("resolves a three-tip ui-state fork that blocked checkpoints forever", async () => {
    await withRepository(async (repository) => {
      const resourceId = "ui-state/workbench.activityBar.location";
      const published = await repository.publish(
        [snapshot(resourceId, "ui-state", Buffer.from("base", "utf8"))],
        [],
      );
      const parents = [`${published.eventHash}#0`];
      // Three concurrent children of one base: the two-tip machinery had no
      // shape for this, so the fork sat unresolved and refused every
      // checkpoint from then on.
      for (const value of ["left", "middle", "right"]) {
        await repository.publish(
          [{ ...snapshot(resourceId, "ui-state", Buffer.from(value, "utf8")), parents }],
          [],
        );
      }
      const conflicts = await reconcileConflicts(repository);
      expect(conflicts).toHaveLength(1);

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(await reconcileConflicts(repository)).toHaveLength(0);
      expect(repository.state.tips[resourceId]).toHaveLength(1);
    });
  });

  it("still asks for a cursor-user-rules conflict", async () => {
    await withRepository(async (repository) => {
      const conflicts = await forkResource(
        repository,
        "cursor-user-rules/aicontext.personalContext",
        "cursor-user-rules",
        Buffer.from("Always write tests.\n", "utf8"),
        Buffer.from("Always write tests.\nPrefer TypeScript.\n", "utf8"),
        Buffer.from("Always write tests.\nPrefer Rust.\n", "utf8"),
      );

      expect(await autoMergeConflicts(repository, conflicts)).toBe(false);
      expect(conflicts[0]?.resolvedAt).toBeUndefined();
      expect(repository.state.tips["cursor-user-rules/aicontext.personalContext"]).toHaveLength(
        2,
      );
    });
  });

  it("leaves the existing keybindings text merge working", async () => {
    await withRepository(async (repository) => {
      const resourceId = "keybindings/default";
      const conflicts = await forkResource(
        repository,
        resourceId,
        "keybindings",
        Buffer.from('[\n  { "key": "ctrl+b", "command": "b" },\n]\n', "utf8"),
        Buffer.from(
          '[\n  { "key": "ctrl+a", "command": "a" },\n  { "key": "ctrl+b", "command": "b" },\n]\n',
          "utf8",
        ),
        Buffer.from(
          '[\n  { "key": "ctrl+b", "command": "b" },\n  { "key": "ctrl+c", "command": "c" },\n]\n',
          "utf8",
        ),
      );

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(await reconcileConflicts(repository)).toHaveLength(0);

      const tips = repository.state.tips[resourceId] ?? [];
      const merged = await repository.readVersion(tips[0]?.versionId ?? "");
      const text = (merged.content ?? Buffer.alloc(0)).toString("utf8");
      expect(text).toContain('"command": "a"');
      expect(text).toContain('"command": "b"');
      expect(text).toContain('"command": "c"');
    });
  });

  it("leaves the existing mcp JSON merge working", async () => {
    await withRepository(async (repository) => {
      const resourceId = "mcp/default";
      const conflicts = await forkResource(
        repository,
        resourceId,
        "mcp",
        Buffer.from('{\n  "servers": {\n    "a": 1\n  }\n}\n', "utf8"),
        Buffer.from('{\n  "servers": {\n    "a": 1,\n    "b": 2\n  }\n}\n', "utf8"),
        Buffer.from('{\n  "servers": {\n    "a": 1,\n    "c": 3\n  }\n}\n', "utf8"),
      );

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(await reconcileConflicts(repository)).toHaveLength(0);

      const tips = repository.state.tips[resourceId] ?? [];
      const merged = await repository.readVersion(tips[0]?.versionId ?? "");
      expect(
        JSON.parse((merged.content ?? Buffer.alloc(0)).toString("utf8")),
      ).toEqual({ servers: { a: 1, b: 2, c: 3 } });
    });
  });
});

function panels(entries: Array<[string, number, boolean]>): Buffer {
  return Buffer.from(
    JSON.stringify(
      entries.map(([id, order, visible]) => ({ id, pinned: true, visible, order })),
    ),
    "utf8",
  );
}

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

function jsonBuffer(value: Record<string, string>): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

/**
 * Resolves the fork on a private copy of the shared folder, the way a device
 * that has not seen the other one's merge yet does.
 */
async function mergeAsDevice(
  temporaryRoot: string,
  name: string,
  shared: string,
  storage: string,
): Promise<{
  metadata: Record<string, JsonValue> | undefined;
  content: Buffer;
  /** Both sides' storage classes, oldest tip first. */
  forkedValueTypes: Array<JsonValue | undefined>;
  /** The storage class the replicated comparator elects. */
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
  const forked = [...(repository.state.tips[PINNED_PANELS] ?? [])].sort(
    compareTips,
  );
  expect(forked).toHaveLength(2);

  expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
  await reconcileConflicts(repository);
  const tips = repository.state.tips[PINNED_PANELS] ?? [];
  expect(tips).toHaveLength(1);
  const merged = await repository.readVersion(tips[0]?.versionId ?? "");
  return {
    metadata: tips[0]?.metadata,
    content: merged.content ?? Buffer.alloc(0),
    forkedValueTypes: [...forked]
      .reverse()
      .map((tip) => tip.metadata?.valueType),
    newestValueType: forked[0]?.metadata?.valueType,
  };
}

/** Publishes a base version plus two children of it, then reconciles. */
async function forkResource(
  repository: SyncRepository,
  resourceId: string,
  kind: ResourceKind,
  base: Buffer,
  local: Buffer,
  remote: Buffer,
): ReturnType<typeof reconcileConflicts> {
  const published = await repository.publish(
    [snapshot(resourceId, kind, base)],
    [],
  );
  const parents = [`${published.eventHash}#0`];
  for (const content of [local, remote]) {
    await repository.publish(
      [{ ...snapshot(resourceId, kind, content), parents }],
      [],
    );
  }
  return reconcileConflicts(repository);
}

async function reconcileConflicts(repository: SyncRepository) {
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
    join(tmpdir(), "cursor-setting-sync-ui-state-"),
  );
  try {
    return await run(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
