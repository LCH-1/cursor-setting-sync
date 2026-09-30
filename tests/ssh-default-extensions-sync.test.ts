import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CursorPaths } from "../src/platform/paths";
import type { LocalProjection } from "../src/types";
import { EventReconciler, parentsForLocalChange } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import {
  DEFAULT_IGNORED_SETTINGS,
  SettingsAdapter,
  collectMachineScopedSettings,
  createDefaultSettingsIgnoreMatcher,
  createMachineSettingsIgnoreMatcher,
  createSettingsIgnoreMatcher,
} from "../src/resources/settings";
import { semanticHash } from "../src/resources/jsonc";

const KEY = "remote.SSH.defaultExtensions";
const ACTIONS = "github.vscode-github-actions";
const roots: string[] = [];
const adapters: SettingsAdapter[] = [];
const producer = { extensionVersion: "1.0.17", cursorVersion: "3.22.12", vscodeVersion: "1.128.0" };

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SSH automatic-install preference synchronization", () => {
  it.each(["default", "work"])("carries a removal through the encrypted repository to the %s profile without restoring it", async (profileId) => {
    const root = await mkdtemp(join(tmpdir(), "ssh-defaults-sync-"));
    roots.push(root);
    const a = await fixture(join(root, "a"), profileId, ["ms-python.python", ACTIONS]);
    const b = await fixture(join(root, "b"), profileId, ["ms-python.python", ACTIONS]);
    const repositoryA = await SyncRepository.create(join(root, "repository"), join(root, "state-a"), "a sufficiently long settings test passphrase", 1024 * 1024, producer);
    const repositoryB = await SyncRepository.openWithMasterKey(repositoryA.root, join(root, "state-b"), repositoryA.repository, Buffer.from(repositoryA.masterKey), 1024 * 1024, producer);
    const reconciler = new EventReconciler();
    const resourceId = `settings/${profileId}/${KEY}`;
    const initial = await nextChange(a.adapter, {}, resourceId);
    expect(initial.snapshots.map((snapshot) => snapshot.resourceId)).toEqual([resourceId]);
    await repositoryA.publish(initial.snapshots, []);
    const initialProjection = reconciler.reconcile(await repositoryB.listEvents(), repositoryB.state, null).projections[0]!;
    const known: LocalProjection = { resourceId, kind: "settings", semanticHash: initialProjection.tip.semanticHash, versionId: initialProjection.tip.versionId };
    repositoryA.state.projections[resourceId] = known;
    repositoryB.state.projections[resourceId] = known;

    await writeFile(a.settingsPath, JSON.stringify({ [KEY]: ["ms-python.python"], "remote.SSH.configFile": "a-local-config" }));
    const removed = await nextChange(a.adapter, repositoryA.state.projections, resourceId);
    expect(removed.snapshots).toHaveLength(1);
    await repositoryA.publish(removed.snapshots.map((snapshot) => ({ ...snapshot, parents: parentsForLocalChange(known, []) })), []);
    await repositoryB.saveState();
    await repositoryB.refreshState();
    const incoming = reconciler.reconcile(await repositoryB.listEvents(), repositoryB.state, null);
    expect(incoming.conflicts).toEqual([]);
    const tip = incoming.projections.find((projection) => projection.resourceId === resourceId)!.tip;
    const content = await repositoryB.readObject(tip.payload!);
    expect(await b.adapter.apply({ resourceId, kind: "settings", semanticHash: tip.semanticHash, content, ...(tip.metadata === undefined ? {} : { metadata: tip.metadata }) })).toBeUndefined();
    const bSettings = JSON.parse(await readFile(b.settingsPath, "utf8")) as Record<string, unknown>;
    expect(bSettings[KEY]).toEqual(["ms-python.python"]);
    expect(bSettings["remote.SSH.configFile"]).toBe("b-local-config");
    repositoryB.state.projections[resourceId] = { ...known, versionId: tip.versionId, semanticHash: tip.semanticHash };
    expect((await b.adapter.scan(repositoryB.state.projections)).snapshots).toEqual([]);
    expect((await b.adapter.scan(repositoryB.state.projections)).deletions).toEqual([]);
  });

  it("propagates an empty automatic-install list", async () => {
    const root = await mkdtemp(join(tmpdir(), "ssh-defaults-delete-"));
    roots.push(root);
    const a = await fixture(join(root, "a"), "default", [ACTIONS]);
    const b = await fixture(join(root, "b"), "default", [ACTIONS]);
    const snapshot = (await a.adapter.scan({})).snapshots[0]!;
    const known = { [snapshot.resourceId]: { resourceId: snapshot.resourceId, kind: "settings" as const, semanticHash: snapshot.semanticHash, versionId: "v1" } };
    await writeFile(a.settingsPath, JSON.stringify({ [KEY]: [], "remote.SSH.configFile": "a-local-config" }));
    const scan = await nextChange(a.adapter, known, snapshot.resourceId);
    expect(scan.snapshots).toHaveLength(1);
    expect(await b.adapter.apply(scan.snapshots[0]!)).toBeUndefined();
    expect(JSON.parse(await readFile(b.settingsPath, "utf8"))).toEqual({ [KEY]: [], "remote.SSH.configFile": "b-local-config" });
  });

  it.each(["user", "native", "machine"])("respects an explicit %s exclusion while retaining the portable default exception", async (source) => {
    const root = await mkdtemp(join(tmpdir(), "ssh-defaults-excluded-"));
    roots.push(root);
    const f = await fixture(root, "default", [ACTIONS], source);
    expect((await f.adapter.scan({})).snapshots.some((snapshot) => snapshot.metadata?.key === KEY)).toBe(false);
    expect(await f.adapter.apply({ resourceId: `settings/default/${KEY}`, kind: "settings", semanticHash: semanticHash([]), content: Buffer.from("[]"), metadata: { profileId: "default", key: KEY } })).toEqual({ status: "retained-local", semanticHash: semanticHash([ACTIONS]) });
    expect((JSON.parse(await readFile(f.settingsPath, "utf8")) as Record<string, unknown>)[KEY]).toEqual([ACTIONS]);
  });

  it("exempts only the exact portable key from built-in defaults", () => {
    const defaults = createDefaultSettingsIgnoreMatcher(DEFAULT_IGNORED_SETTINGS);
    expect(defaults.matches(KEY)).toBe(false);
    for (const key of ["remote.SSH.configFile", "remote.SSH.remotePlatform", "remote.SSH.serverInstallPath.host", `${KEY}.host`, "remote.WSL.defaultExtensions"]) {
      expect(defaults.matches(key)).toBe(true);
    }
    expect(createSettingsIgnoreMatcher(["remote.SSH.*"]).matches(KEY)).toBe(true);
    expect(createMachineSettingsIgnoreMatcher([], []).matches("remote.SSH.configFile")).toBe(false);
  });
});

async function nextChange(adapter: SettingsAdapter, known: Record<string, LocalProjection>, resourceId: string) {
  for (let pass = 0; pass < 8; pass += 1) {
    const page = await adapter.scan(known);
    expect(page.warnings).toEqual([]);
    if (page.snapshots.some((snapshot) => snapshot.resourceId === resourceId) || page.deletions.some((deletion) => deletion.resourceId === resourceId)) return page;
  }
  throw new Error(`Settings change was not discovered: ${resourceId}`);
}

async function fixture(root: string, profileId: string, list: string[], exclusion?: string) {
  const userDataRoot = join(root, "User");
  const profileRoot = profileId === "default" ? userDataRoot : join(userDataRoot, "profiles", profileId);
  await mkdir(profileRoot, { recursive: true });
  const settingsPath = join(profileRoot, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ [KEY]: list, "remote.SSH.configFile": root.endsWith("b") ? "b-local-config" : "a-local-config", ...(exclusion === "native" ? { "settingsSync.ignoredSettings": ["remote.SSH.*"] } : {}) }));
  const machine = collectMachineScopedSettings(exclusion === "machine" ? [{ contributes: { configuration: { properties: { [KEY]: { scope: "machine" } } } } }] : []);
  const adapter = new SettingsAdapter(
    { userDataRoot, profilesRoot: join(userDataRoot, "profiles") } as CursorPaths,
    createSettingsIgnoreMatcher(exclusion === "user" ? ["remote.SSH.*"] : []),
    createMachineSettingsIgnoreMatcher([...machine], DEFAULT_IGNORED_SETTINGS),
    createDefaultSettingsIgnoreMatcher(DEFAULT_IGNORED_SETTINGS),
    { profileIntervalMs: 0 },
  );
  adapters.push(adapter);
  return { adapter, settingsPath };
}
