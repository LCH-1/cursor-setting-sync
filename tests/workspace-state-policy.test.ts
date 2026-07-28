import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { EventReconciler } from "../src/protocol/reconciler";
import { autoMergeConflicts } from "../src/sync/manager";
import { sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import {
  filterPortableWorkspaceRows,
  isPortableWorkspaceStateRow,
} from "../src/resources/workspaceStatePolicy";
import {
  parseWorkspaceDatabaseSnapshot,
  type WorkspaceDatabaseSnapshot,
} from "../src/helper/workspaceDatabaseMerge";
import type { EventProducer, ResourceSnapshot } from "../src/types";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

const RESOURCE_ID = "workspace-storage/workspace-a%2Fstate.vscdb";
const CHROME_KEY = "memento/workbench.parts.editor";

describe("the portable workspace-state policy", () => {
  it("classifies ItemTable rows and leaves the content tables alone", () => {
    expect(isPortableWorkspaceStateRow("ItemTable", "notepadData")).toBe(true);
    expect(isPortableWorkspaceStateRow("ItemTable", "notepad.reactiveStorageId")).toBe(true);
    expect(isPortableWorkspaceStateRow("ItemTable", "interactive.sessions")).toBe(true);
    expect(isPortableWorkspaceStateRow("ItemTable", "debug.breakpoint")).toBe(true);

    expect(isPortableWorkspaceStateRow("ItemTable", CHROME_KEY)).toBe(false);
    expect(isPortableWorkspaceStateRow("ItemTable", "composer.composerData")).toBe(false);
    expect(isPortableWorkspaceStateRow("ItemTable", "history.entries")).toBe(false);
    expect(isPortableWorkspaceStateRow("ItemTable", "aiService.generations")).toBe(false);
    expect(isPortableWorkspaceStateRow("ItemTable", "workbench.panel.hidden")).toBe(false);

    // Only ItemTable is chrome; the other tables carry conversation-class data.
    expect(isPortableWorkspaceStateRow("cursorDiskKV", "anything")).toBe(true);
    expect(isPortableWorkspaceStateRow("composerHeaders", "anything")).toBe(true);
  });

  it("filters only the ItemTable rows of a snapshot", () => {
    const filtered = filterPortableWorkspaceRows(
      workspaceSnapshot({
        item: [
          ["notepadData", "note"],
          [CHROME_KEY, "layout"],
        ],
        kv: [["kv-key", "kept"]],
      }),
    );
    expect(
      filtered.tables.find((table) => table.name === "ItemTable")?.rows,
    ).toEqual([{ key: "notepadData", values: [{ type: "text", value: "note" }] }]);
    expect(
      filtered.tables.find((table) => table.name === "cursorDiskKV")?.rows,
    ).toEqual([{ key: "kv-key", values: [{ type: "text", value: "kept" }] }]);
  });
});

describe("workspace-storage auto-merge under the policy", () => {
  it("resolves a fork whose only same-key divergence is machine chrome", async () => {
    // Both machines had the same remote workspace open, so both rewrote the
    // same layout memento - the row that used to make every dual-quit fork a
    // manual conflict - while each added its own portable row.
    await withRepository(async (repository) => {
      const conflicts = await forkResource(
        repository,
        workspaceSnapshot({
          item: [[CHROME_KEY, "base-layout"]],
        }),
        workspaceSnapshot({
          item: [
            [CHROME_KEY, "local-layout"],
            ["notepadData", "local-note"],
          ],
        }),
        workspaceSnapshot({
          item: [
            [CHROME_KEY, "remote-layout"],
            ["interactive.sessions", "remote-session"],
          ],
        }),
      );
      expect(conflicts).toHaveLength(1);

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(conflicts[0]?.resolvedAt).toBeDefined();
      expect(await reconcileConflicts(repository)).toHaveLength(0);

      const tips = repository.state.tips[RESOURCE_ID] ?? [];
      expect(tips).toHaveLength(1);
      const merged = parseWorkspaceDatabaseSnapshot(
        (await repository.readVersion(tips[0]?.versionId ?? "")).content ??
          Buffer.alloc(0),
      );
      // Both sides' portable additions survive; the chrome never travels.
      expect(
        merged.tables.find((table) => table.name === "ItemTable")?.rows,
      ).toEqual([
        {
          key: "interactive.sessions",
          values: [{ type: "text", value: "remote-session" }],
        },
        { key: "notepadData", values: [{ type: "text", value: "local-note" }] },
      ]);
    });
  });

  it("does not read a filtered side as having deleted an old snapshot's chrome", async () => {
    // Transition: the base and the remote tip were published by a build that
    // still shipped chrome, and the remote side even changed it. The filtered
    // local tip must not turn that into a concurrent-delete conflict.
    await withRepository(async (repository) => {
      const conflicts = await forkResource(
        repository,
        workspaceSnapshot({
          item: [
            [CHROME_KEY, "old-layout"],
            ["notepadData", "note"],
          ],
        }),
        workspaceSnapshot({
          item: [["notepadData", "note"]],
        }),
        workspaceSnapshot({
          item: [
            [CHROME_KEY, "newer-layout"],
            ["notepadData", "note"],
          ],
        }),
      );
      expect(conflicts).toHaveLength(1);

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(await reconcileConflicts(repository)).toHaveLength(0);

      const tips = repository.state.tips[RESOURCE_ID] ?? [];
      expect(tips).toHaveLength(1);
      const merged = parseWorkspaceDatabaseSnapshot(
        (await repository.readVersion(tips[0]?.versionId ?? "")).content ??
          Buffer.alloc(0),
      );
      expect(
        merged.tables.find((table) => table.name === "ItemTable")?.rows,
      ).toEqual([
        { key: "notepadData", values: [{ type: "text", value: "note" }] },
      ]);
    });
  });
});

function workspaceSnapshot(rows: {
  item?: Array<[string, string]>;
  kv?: Array<[string, string]>;
}): WorkspaceDatabaseSnapshot {
  const textRows = (entries: Array<[string, string]> | undefined) =>
    (entries ?? []).map(([key, value]) => ({
      key,
      values: [{ type: "text", value } as const],
    }));
  return {
    format: "cursor-setting-sync.workspace-database",
    version: 1,
    workspaceId: "workspace-a",
    sqliteUserVersion: 0,
    tables: [
      {
        name: "ItemTable",
        keyColumn: "key",
        columns: ["value"],
        rows: textRows(rows.item),
      },
      {
        name: "cursorDiskKV",
        keyColumn: "key",
        columns: ["value"],
        rows: textRows(rows.kv),
      },
    ],
  };
}

function serialized(snapshot: WorkspaceDatabaseSnapshot): Buffer {
  return Buffer.from(JSON.stringify(snapshot), "utf8");
}

function resourceSnapshot(content: Buffer): ResourceSnapshot {
  return {
    resourceId: RESOURCE_ID,
    kind: "workspace-storage",
    content,
    semanticHash: sha256(content),
    metadata: {
      relativePath: "workspace-a/state.vscdb",
      workspaceId: "workspace-a",
    },
  };
}

/** Publishes a base version plus two children of it, then reconciles. */
async function forkResource(
  repository: SyncRepository,
  base: WorkspaceDatabaseSnapshot,
  local: WorkspaceDatabaseSnapshot,
  remote: WorkspaceDatabaseSnapshot,
): ReturnType<typeof reconcileConflicts> {
  const published = await repository.publish(
    [resourceSnapshot(serialized(base))],
    [],
  );
  const parents = [`${published.eventHash}#0`];
  for (const side of [local, remote]) {
    await repository.publish(
      [{ ...resourceSnapshot(serialized(side)), parents }],
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
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-ws-policy-test-"));
  try {
    const repository = await SyncRepository.create(
      join(temporaryRoot, "repository"),
      join(temporaryRoot, "storage"),
      PASSPHRASE,
      1024 * 1024,
      PRODUCER,
    );
    return await run(repository);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
