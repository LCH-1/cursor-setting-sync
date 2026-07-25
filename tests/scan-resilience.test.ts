import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import type { CursorPaths } from "../src/platform/paths";
import { UiStateAdapter } from "../src/resources/uiState";
import { WorkspaceStorageAdapter } from "../src/resources/workspaceStorage";
import { filterPublishableChanges } from "../src/sync/versionPolicy";
import { isRepositoryPayloadFile } from "../src/sync/watch";
import { mergeJsoncBuffers } from "../src/resources/jsonc";
import { sha256 } from "../src/protocol/canonical";
import type { LocalProjection, ResourceSnapshot } from "../src/types";

const { DatabaseSync } = sqlite;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("ui-state scan with an unreadable target marker", () => {
  it("publishes no ui-state deletions when the marker cannot be parsed", async () => {
    const root = await temporaryRoot();
    const globalDatabase = join(root, "state.vscdb");
    const database = new DatabaseSync(globalDatabase);
    database.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    // A marker that is present but not an object: fail-closed, so the scan
    // knows nothing about which keys are USER-target.
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("__$__targetStorageMarker", "[1,2,3]");
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("aicontext.personalContext", "rules");
    database.close();

    const paths = { globalDatabase } as CursorPaths;
    const known: Record<string, LocalProjection> = {};
    for (const key of ["workbench.panel.hidden", "views.state"]) {
      const resourceId = `ui-state/${encodeURIComponent(key)}`;
      known[resourceId] = {
        resourceId,
        kind: "ui-state",
        semanticHash: "a".repeat(64),
        versionId: null,
      };
    }

    const result = await new UiStateAdapter(paths).scan(known);

    expect(result.deletions).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("no UI state deletions");
  });
});

describe("workspaceStorage listing resilience", () => {
  it("captures every usable workspace alongside entries it cannot use", async () => {
    const root = await temporaryRoot();
    const workspaceStorageRoot = join(root, "workspaceStorage");
    await mkdir(join(workspaceStorageRoot, "good"), { recursive: true });
    await writeFile(
      join(workspaceStorageRoot, "good", "notepads.json"),
      '{"a":1}',
      "utf8",
    );
    await writeFile(join(workspaceStorageRoot, "stray"), "not a directory");

    const adapter = new WorkspaceStorageAdapter({
      workspaceStorageRoot,
    } as CursorPaths);
    const result = await adapter.scan({});

    expect(result.snapshots.map((item) => item.resourceId)).toEqual([
      `workspace-storage/${encodeURIComponent("good/notepads.json")}`,
    ]);
    expect(result.deletions).toEqual([]);
  });

  it("reports an unreadable root as a warning instead of failing the scan", async () => {
    const root = await temporaryRoot();
    const workspaceStorageRoot = join(root, "workspaceStorage");
    // A readdir that rejects is what a locked, hydrating or permission-denied
    // directory looks like; it used to reject the whole listing and take the
    // backup of every workspace with it.
    await writeFile(workspaceStorageRoot, "not a directory");

    const adapter = new WorkspaceStorageAdapter({
      workspaceStorageRoot,
    } as CursorPaths);
    const result = await adapter.scan({});

    expect(result.snapshots).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("publish batching and size limits", () => {
  const snapshot = (resourceId: string, bytes: number): ResourceSnapshot => ({
    resourceId,
    kind: "settings",
    content: Buffer.alloc(bytes, 1),
    semanticHash: "b".repeat(64),
  });

  it("drops only the oversized resource and explains the remedies", () => {
    const result = filterPublishableChanges(
      [snapshot("settings/default/a", 16), snapshot("chat/huge", 4096)],
      [],
      1024,
    );

    expect(result.snapshots.map((item) => item.resourceId)).toEqual([
      "settings/default/a",
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("chat/huge");
    expect(result.warnings[0]).toContain("cursorSettingSync.maxPayloadMiB");
    expect(result.warnings[0]).toContain("Everything else in this cycle");
  });

  it("passes everything through when nothing is oversized", () => {
    const result = filterPublishableChanges(
      [snapshot("settings/default/a", 16)],
      [
        {
          resourceId: "settings/default/b",
          kind: "settings",
          semanticHash: "c".repeat(64),
        },
      ],
      1024,
    );

    expect(result.warnings).toEqual([]);
    expect(result.snapshots).toHaveLength(1);
    expect(result.deletions).toHaveLength(1);
  });
});

describe("repository watcher file filter", () => {
  it("accepts checkpoint files alongside events and objects", () => {
    expect(isRepositoryPayloadFile("checkpoints/0000000000000001-ab.csc")).toBe(
      true,
    );
    expect(isRepositoryPayloadFile("devices/d/events/0001-ab.cse")).toBe(true);
    expect(isRepositoryPayloadFile("devices/d/blobs/sha256/ab/ab.cso")).toBe(
      true,
    );
    expect(isRepositoryPayloadFile("acks.json")).toBe(false);
    expect(isRepositoryPayloadFile("0001-ab.sync-conflict.cse")).toBe(false);
  });
});

describe("JSONC auto-merge output", () => {
  const base = Buffer.from('{\n  // keep\n  "a": 1,\n  "b": 1\n}\n', "utf8");
  const left = Buffer.from('{\n  // keep\n  "a": 2,\n  "b": 1\n}\n', "utf8");
  const right = Buffer.from('{\n\t// keep\n\t"a": 1,\n\t"b": 2\n}\n', "utf8");

  it("hashes the bytes it publishes, the way the adapters hash the file", () => {
    const outcome = mergeJsoncBuffers(base, left, right);

    expect(outcome.status).toBe("merged");
    expect(outcome.semanticHash).toBe(sha256(outcome.content as Buffer));
  });

  it("produces identical bytes on both devices of the same fork", () => {
    const onLeft = mergeJsoncBuffers(base, left, right);
    const onRight = mergeJsoncBuffers(base, right, left);

    expect(onLeft.content?.toString("utf8")).toBe(
      onRight.content?.toString("utf8"),
    );
    expect(onLeft.semanticHash).toBe(onRight.semanticHash);
    expect(onLeft.content?.toString("utf8")).toContain("// keep");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cursor-sync-resilience-"));
  temporaryRoots.push(root);
  return root;
}
