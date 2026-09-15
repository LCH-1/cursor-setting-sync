import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ window: {}, extensions: { all: [] } }));

import { EXTENSION_ID } from "../src/constants";
import { applyNonGlobalChanges } from "../src/helper/resourceApply";
import type { HelperRequest } from "../src/helper/types";
import type { CursorPaths } from "../src/platform/paths";
import { sha256 } from "../src/protocol/canonical";
import { EventReconciler, parentsForLocalChange } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import { createExtensionIgnoreMatcher, ExtensionsAdapter, type ExtensionsAdapterOptions } from "../src/resources/extensions";
import { scanAdapters } from "../src/sync/manager";
import type { LocalProjection, ResourceDeletion, ResourceSnapshot } from "../src/types";

const roots: string[] = [];
const producer = { extensionVersion: "1.0.11", cursorVersion: "3.11.19", vscodeVersion: "1.125.0" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("extension deletion synchronization", () => {
  it("publishes a known removal through an incomplete profile page, then acknowledges it", async () => {
    const paths = await fixture(["work"]);
    const known = projections("default/publisher.removed", "work/publisher.unvisited", "gone/publisher.missing");
    const adapter = scanner(paths);
    const result = await scanAdapters([adapter], known, "all", new Set());
    expect(result.deletions.map((item) => item.resourceId)).toEqual(["extension/default/publisher.removed"]);
    expect(result.deferredAdapterIds.has("extensions")).toBe(true);
    expect(result.adapterIndexes.get("extensions")?.deletions.size).toBe(1);
    acknowledge(known, result.deletions);
    expect((await adapter.scan(known)).deletions).toEqual([]);
    expect((await adapter.scan(known)).deletions.map((item) => item.resourceId)).toEqual(["extension/work/publisher.unvisited"]);
  });

  it("does not treat an empty new device or a remote-only install as a local removal", async () => {
    const paths = await fixture();
    expect((await scanner(paths).scan({})).deletions).toEqual([]);
  });

  it("protects installed, ignored, self, foreign-kind, malformed and already deleted entries", async () => {
    const paths = await fixture();
    const known = projections(
      "default/publisher.installed", "default/publisher.ignored", `default/${EXTENSION_ID.toLowerCase()}`,
      "default/publisher.deleted", "default/publisher.retained", "default/publisher.wrong-kind", "default/invalid/id",
    );
    known["extension/default/publisher.deleted"]!.semanticHash = sha256("deleted:extension/default/publisher.deleted");
    known["extension/default/publisher.retained"]!.retainedLocalHash = sha256("deleted:extension/default/publisher.retained");
    known["extension/default/publisher.wrong-kind"]!.kind = "settings";
    const adapter = scanner(paths, {
      listInstalledExtensions: async () => [{ id: "Publisher.Installed", version: "1.0.0" }],
    }, ["PUBLISHER.IGNORED"]);
    expect((await adapter.scan(known)).deletions).toEqual([]);
  });

  it("retries deletion pages until acknowledged without exceeding the shared change limit", async () => {
    const paths = await fixture();
    const adapter = scanner(paths, {
      maxResourcesPerScan: 2,
      listInstalledExtensions: async () => [{ id: "publisher.installed", version: "1" }],
    });
    const known = projections(...Array.from({ length: 5 }, (_, index) => `default/publisher.removed${index}`));
    const first = await adapter.scan(known);
    expect(first.snapshots).toHaveLength(1);
    expect(first.deletions).toHaveLength(1);
    expect((await adapter.scan(known)).deletions).toEqual(first.deletions);
    acknowledge(known, [...first.snapshots, ...first.deletions]);
    const removed = [...first.deletions];
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await adapter.scan(known);
      expect(result.snapshots.length + result.deletions.length).toBeLessThanOrEqual(2);
      removed.push(...result.deletions);
      acknowledge(known, [...result.snapshots, ...result.deletions]);
    }
    expect(new Set(removed.map((item) => item.resourceId)).size).toBe(5);
    expect(adapter.scanStatus().complete).toBe(true);
  });

  it("suppresses removals on CLI failure and continues healthy sibling profiles", async () => {
    const paths = await fixture(["work"]);
    const adapter = scanner(paths, {
      listInstalledExtensions: async (name) => {
        if (name === null) throw new Error("CLI unavailable");
        return [];
      },
    });
    const known = projections("default/publisher.protected", "work/publisher.removed");
    const failed = await adapter.scan(known);
    expect(failed.deletions).toEqual([]);
    expect(failed.warnings.join()).toContain("CLI unavailable");
    const healthy = await scanAdapters([adapter], known, "all", new Set());
    expect(healthy.deletions.map((item) => item.resourceId)).toEqual(["extension/work/publisher.removed"]);
  });

  it.each(["metadata", "disabled", "profiles"])("does not invent profile removals when %s storage is corrupt", async (corrupt) => {
    const paths = await fixture(["work"]);
    if (corrupt === "metadata") {
      await writeFile(paths.cursorExtensionsManifest, "{");
    } else {
      const database = new DatabaseSync(paths.globalDatabase);
      database.prepare("INSERT OR REPLACE INTO ItemTable(key,value) VALUES (?, ?)").run(
        corrupt === "disabled" ? "extensionsIdentifiers/disabled" : "userDataProfiles", "{",
      );
      database.close();
    }
    const result = await scanner(paths).scan(projections("default/publisher.removed", "work/publisher.protected"));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.deletions.map((item) => item.resourceId)).toEqual(
      corrupt === "profiles" ? ["extension/default/publisher.removed"] : [],
    );
  });

  it("rechecks the registry before emitting destructive changes", async () => {
    const paths = await fixture();
    const adapter = scanner(paths, {
      listInstalledExtensions: async () => {
        await writeFile(paths.cursorExtensionsManifest, "[\n]\n");
        return [];
      },
    });
    const result = await adapter.scan(projections("default/publisher.protected"));
    expect(result.deletions).toEqual([]);
    expect(result.warnings.join()).toContain("changed during enumeration");
  });

  it("publishes an explicit reinstall after a deletion has been applied", async () => {
    const paths = await fixture();
    const known = projections("default/publisher.reinstalled");
    known["extension/default/publisher.reinstalled"]!.semanticHash = sha256("deleted:extension/default/publisher.reinstalled");
    const result = await scanner(paths, {
      listInstalledExtensions: async () => [{ id: "publisher.reinstalled", version: "2" }],
    }).scan(known);
    expect(result.snapshots).toHaveLength(1);
    expect(result.deletions).toEqual([]);
  });

  it.each(["default", "work"])("carries a %s removal from A through the repository to B's uninstall CLI without resurrection", async (profileId) => {
    const paths = await fixture(profileId === "default" ? [] : [profileId]);
    const root = dirname(paths.userDataRoot);
    const repositoryA = await SyncRepository.create(join(root, "repository"), join(root, "a"), "a sufficiently long extension test passphrase", 1024 * 1024, producer);
    const repositoryB = await SyncRepository.openWithMasterKey(repositoryA.root, join(root, "b"), repositoryA.repository, Buffer.from(repositoryA.masterKey), 1024 * 1024, producer);
    const resourceId = `extension/${profileId}/publisher.removed`;
    const installedAdapter = scanner(paths, {
      listInstalledExtensions: async (name) => (name ?? "default") === profileId ? [{ id: "publisher.removed", version: "1" }] : [],
    });
    let installed = await installedAdapter.scan({});
    if (installed.snapshots.length === 0) installed = await installedAdapter.scan({});
    await repositoryA.publish(installed.snapshots, []);
    const reconciler = new EventReconciler();
    const initial = reconciler.reconcile(await repositoryB.listEvents(), repositoryB.state, null).projections[0]!;
    expect(initial.tip.operation).toBe("put");
    for (const repository of [repositoryA, repositoryB]) {
      repository.state.projections[resourceId] = { resourceId, kind: "extension", semanticHash: initial.tip.semanticHash, versionId: initial.tip.versionId };
    }
    const removedAdapter = scanner(paths);
    let removed = await scanAdapters([removedAdapter], repositoryA.state.projections, "all", new Set());
    if (removed.deletions.length === 0) removed = await scanAdapters([removedAdapter], repositoryA.state.projections, "all", new Set());
    expect(removed.deletions).toHaveLength(1);
    await repositoryA.publish([], removed.deletions.map((item) => ({ ...item, parents: parentsForLocalChange(repositoryA.state.projections[item.resourceId], []) })));
    await repositoryB.saveState();
    await repositoryB.refreshState();
    const incoming = reconciler.reconcile(await repositoryB.listEvents(), repositoryB.state, null);
    expect(incoming.conflicts).toEqual([]);
    const tip = incoming.projections[0]!.tip;
    expect(tip.operation).toBe("delete");
    expect((await installedAdapter.scan(repositoryB.state.projections)).snapshots).toEqual([]);
    const cliRoot = join(root, "app", "out");
    await mkdir(cliRoot, { recursive: true });
    const callLog = join(root, "calls.json");
    await writeFile(join(cliRoot, "cli.js"), `require('node:fs').writeFileSync(${JSON.stringify(callLog)}, JSON.stringify(process.argv.slice(2)));`);
    const request: HelperRequest = {
      version: 1, requestId: "extension-delete-test", mode: "apply-and-restart", createdAt: "2026-09-15T00:00:00.000Z",
      repositoryRoot: repositoryA.root, storageRoot: join(root, "b"), cursorExecutable: process.execPath,
      extensionHostPid: 1, restart: false, expectedCursorVersion: producer.cursorVersion, expectedVscodeVersion: producer.vscodeVersion,
      extensionVersion: producer.extensionVersion, paths: { ...paths, appRoot: join(root, "app") }, changes: [], workspaceMappings: {},
      syncOptions: { ignoredSettings: [], ignoredExtensions: [], machineScopedSettings: [], syncChat: false, syncWorkspaceStorage: false, maxPayloadBytes: 1024 * 1024 },
    };
    const applied = await applyNonGlobalChanges(request, [{ change: { ...tip, resourceId } }]);
    expect(applied.applied).toEqual([resourceId]);
    const args = JSON.parse(await readFile(callLog, "utf8")) as string[];
    expect(args.slice(0, 2)).toEqual(["--uninstall-extension", "publisher.removed"]);
    expect(args[args.indexOf("--user-data-dir") + 1]).toBe(root);
    expect(args.includes("--profile")).toBe(profileId !== "default");
    if (profileId !== "default") expect(args[args.indexOf("--profile") + 1]).toBe(profileId);
    repositoryB.state.projections[resourceId] = { resourceId, kind: "extension", semanticHash: tip.semanticHash, versionId: tip.versionId };
    const after = scanner(paths);
    for (let pass = 0; pass < 3; pass += 1) {
      const result = await after.scan(repositoryB.state.projections);
      expect(result.snapshots).toEqual([]);
      expect(result.deletions).toEqual([]);
    }
  });
});

async function fixture(profiles: string[] = []): Promise<CursorPaths> {
  const root = await mkdtemp(join(tmpdir(), "extension-delete-"));
  roots.push(root);
  const userDataRoot = join(root, "User");
  const globalDatabase = join(userDataRoot, "globalStorage", "state.vscdb");
  const cursorHome = join(root, ".cursor");
  const cursorExtensionsManifest = join(cursorHome, "extensions", "extensions.json");
  await mkdir(dirname(globalDatabase), { recursive: true });
  await mkdir(dirname(cursorExtensionsManifest), { recursive: true });
  await writeFile(cursorExtensionsManifest, "[]");
  const database = new DatabaseSync(globalDatabase);
  database.exec("CREATE TABLE ItemTable(key TEXT UNIQUE, value BLOB)");
  database.prepare("INSERT INTO ItemTable(key,value) VALUES (?, ?)").run("userDataProfiles", JSON.stringify(profiles.map((name) => ({ name, location: { path: `/profiles/${name}` } }))));
  database.close();
  return { userDataRoot, globalDatabase, cursorHome, cursorExtensionsManifest, profilesRoot: join(userDataRoot, "profiles") } as CursorPaths;
}

function scanner(paths: CursorPaths, options: ExtensionsAdapterOptions = {}, ignored: string[] = []): ExtensionsAdapter {
  return new ExtensionsAdapter(paths, createExtensionIgnoreMatcher(ignored), { scanIntervalMs: 0, listInstalledExtensions: async () => [], ...options });
}

function projections(...suffixes: string[]): Record<string, LocalProjection> {
  return Object.fromEntries(suffixes.map((suffix) => {
    const resourceId = `extension/${suffix}`;
    return [resourceId, { resourceId, kind: "extension", semanticHash: sha256("installed"), versionId: "a".repeat(64) + "#0" }];
  }));
}

function acknowledge(known: Record<string, LocalProjection>, items: Array<ResourceSnapshot | ResourceDeletion>): void {
  for (const item of items) known[item.resourceId] = { resourceId: item.resourceId, kind: item.kind, semanticHash: item.semanticHash, versionId: null };
}
