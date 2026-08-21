import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CursorPaths } from "../src/platform/paths";
import type { LocalProjection, ResourceSnapshot } from "../src/types";
import type { ResourceAdapter } from "../src/resources/resource";
import {
  CursorUserFilesAdapter,
  normalizeIgnoredUserFiles,
} from "../src/resources/cursorUserFiles";
import { ProfileFilesAdapter } from "../src/resources/profileFiles";
import { ProfileResourcePathPager } from "../src/resources/profilePaths";
import {
  ExtensionsAdapter,
  MAX_EXTENSION_MANIFEST_BYTES,
  createExtensionIgnoreMatcher,
  readBoundedExtensionManifestMetadata,
} from "../src/resources/extensions";
import { ProfilesAdapter } from "../src/resources/profiles";
import {
  SettingsAdapter,
  createSettingsIgnoreMatcher,
} from "../src/resources/settings";
import { EMPTY_IGNORE_MATCHER } from "../src/resources/ignorePatterns";
import { UiStateAdapter } from "../src/resources/uiState";
import { GENERAL_MAX_OVERSIZED_SETTLEMENTS } from "../src/resources/boundedScan";
import {
  discoverWorkspacesDetailed,
  lookupWorkspaceIdentityReferences,
  resetWorkspaceDiscoveryCache,
  workspaceDiscoveryTesting,
} from "../src/chat/workspace";

const temporaryRoots: string[] = [];

afterEach(async () => {
  resetWorkspaceDiscoveryCache();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("ordinary adapter fixed work envelopes", () => {
  it("bounds Cursor/profile oversized protection registries and rebuilds them after recovery", async () => {
    const cursorPaths = await cursorHomeFixture();
    await writeManyFiles(cursorPaths.cursorRules, 65, ".md", "x".repeat(2_048));
    const cursor = new CursorUserFilesAdapter(
      cursorPaths,
      normalizeIgnoredUserFiles([]),
      "win32",
      {
        enumerationIntervalMs: 0,
        metadataIntervalMs: 0,
        now: () => 1,
      },
    );
    cursor.setMaxPayloadBytes(1_024);

    const profileRoot = await temporaryRoot("profile-oversized-registry-");
    const promptsRoot = join(profileRoot, "prompts");
    await mkdir(join(profileRoot, "profiles"), { recursive: true });
    await writeManyFiles(promptsRoot, 65, ".md", "x".repeat(2_048));
    const profiles = new ProfileFilesAdapter(
      {
        userDataRoot: profileRoot,
        profilesRoot: join(profileRoot, "profiles"),
        promptsRoot,
      } as CursorPaths,
      {
        enumerationIntervalMs: 0,
        metadataIntervalMs: 0,
        now: () => 1,
      },
    );
    profiles.setMaxPayloadBytes(1_024);

    for (const [adapter, sentinel] of [
      [cursor, "cursor-user-file-scope/untracked-oversized-resources"],
      [profiles, "profile-file-scope/untracked-oversized-resources"],
    ] as const) {
      let maxWarnings = 0;
      for (let pass = 0; pass < 40; pass += 1) {
        const result = await adapter.scan({});
        maxWarnings = Math.max(maxWarnings, result.warnings.length);
        if (adapter.scanStatus().deferredResourceIds.includes(sentinel)) {
          break;
        }
      }
      expect(adapter.oversizedSnapshotSettlements(1_024)).toHaveLength(
        GENERAL_MAX_OVERSIZED_SETTLEMENTS,
      );
      expect(adapter.scanStatus().complete).toBe(false);
      expect(adapter.scanStatus().deferredResourceIds).toContain(sentinel);
      expect(maxWarnings).toBeLessThanOrEqual(
        GENERAL_MAX_OVERSIZED_SETTLEMENTS,
      );
    }

    await writeManyFiles(cursorPaths.cursorRules, 65, ".md", "ok");
    await writeManyFiles(promptsRoot, 65, ".md", "ok");
    for (const adapter of [cursor, profiles] as const) {
      const known: Record<string, LocalProjection> = {};
      for (let pass = 0; pass < 80; pass += 1) {
        const result = await adapter.scan(known);
        for (const snapshot of result.snapshots) {
          known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
        }
        if (adapter.scanStatus().complete) {
          break;
        }
      }
      expect(adapter.scanStatus()).toMatchObject({
        complete: true,
        deferredResourceIds: [],
      });
      expect(adapter.oversizedSnapshotSettlements(1_024)).toEqual([]);
    }
    await cursor.dispose();
    await profiles.dispose();
  }, 15_000);

  it("bounds UI oversized protections and requires a clean marker sweep to recover", async () => {
    const root = await temporaryRoot("ui-oversized-registry-");
    const globalDatabase = join(root, "state.vscdb");
    const keys = Array.from({ length: 65 }, (_, index) => `u${index}`);
    const database = new DatabaseSync(globalDatabase);
    database.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run(
        "__$__targetStorageMarker",
        JSON.stringify(Object.fromEntries(keys.map((key) => [key, 0]))),
      );
    const insertLarge = database.prepare(
      "INSERT INTO ItemTable(key, value) VALUES (?, zeroblob(2048))",
    );
    for (const key of keys) {
      insertLarge.run(key);
    }
    database.close();
    const adapter = new UiStateAdapter(
      { globalDatabase } as CursorPaths,
      undefined,
      {
        maxResourcesPerScan: 32,
        maxMetadataChecksPerScan: 64,
        forceVerificationResourceIds: new Set(
          keys.map((key) => `ui-state/${encodeURIComponent(key)}`),
        ),
      },
    );
    adapter.setMaxPayloadBytes(1_024);
    let maxWarnings = 0;
    for (let pass = 0; pass < 8; pass += 1) {
      const result = await adapter.scan({});
      maxWarnings = Math.max(maxWarnings, result.warnings.length);
      if (
        adapter
          .scanStatus()
          .deferredResourceIds.includes(
            "ui-state-scope/untracked-oversized-resources",
          )
      ) {
        break;
      }
    }
    expect(adapter.oversizedSnapshotSettlements(1_024)).toHaveLength(
      GENERAL_MAX_OVERSIZED_SETTLEMENTS,
    );
    expect(maxWarnings).toBeLessThanOrEqual(GENERAL_MAX_OVERSIZED_SETTLEMENTS);
    expect(adapter.scanStatus().complete).toBe(false);

    const recovered = new DatabaseSync(globalDatabase);
    const update = recovered.prepare("UPDATE ItemTable SET value = ? WHERE key = ?");
    for (const key of keys) {
      update.run(`ok:${key}`, key);
    }
    recovered.close();
    const known: Record<string, LocalProjection> = {};
    for (let pass = 0; pass < 16; pass += 1) {
      const result = await adapter.scan(known);
      for (const snapshot of result.snapshots) {
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
      if (adapter.scanStatus().complete) {
        break;
      }
    }
    expect(adapter.scanStatus()).toMatchObject({
      complete: true,
      deferredResourceIds: [],
    });
    expect(adapter.oversizedSnapshotSettlements(1_024)).toEqual([]);
  });

  it("bounds extension oversized warnings and rebuilds on the next full profile sweep", async () => {
    const root = await temporaryRoot("extension-oversized-registry-");
    const cursorHome = join(root, ".cursor");
    const userDataRoot = join(root, "User");
    const globalDatabase = join(userDataRoot, "globalStorage", "state.vscdb");
    const cursorExtensionsManifest = join(cursorHome, "extensions", "extensions.json");
    await mkdir(join(globalDatabase, ".."), { recursive: true });
    await mkdir(join(cursorExtensionsManifest, ".."), { recursive: true });
    await writeFile(cursorExtensionsManifest, "[]", "utf8");
    const database = new DatabaseSync(globalDatabase);
    database.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database.close();
    let installed = Array.from({ length: 65 }, (_, index) => ({
      id: `publisher${index}.${"x".repeat(1_100)}`,
      version: "1.0.0",
    }));
    let now = 1;
    const adapter = new ExtensionsAdapter(
      {
        cursorHome,
        userDataRoot,
        profilesRoot: join(userDataRoot, "profiles"),
        globalDatabase,
        cursorExtensionsManifest,
      } as CursorPaths,
      createExtensionIgnoreMatcher([]),
      {
        now: () => now,
        listInstalledExtensions: async () => installed,
      },
    );
    adapter.setMaxPayloadBytes(1_024);

    const first = await adapter.scan({});
    expect(first.warnings).toHaveLength(GENERAL_MAX_OVERSIZED_SETTLEMENTS);
    expect(adapter.oversizedSnapshotSettlements(1_024)).toHaveLength(
      GENERAL_MAX_OVERSIZED_SETTLEMENTS,
    );
    expect(adapter.scanStatus()).toMatchObject({
      complete: false,
      deferredResourceIds: ["extension-scope/untracked-oversized-resources"],
    });

    installed = [{ id: "publisher.recovered", version: "1.0.0" }];
    await writeFile(cursorExtensionsManifest, "[\n]", "utf8");
    now += 30_001;
    const known: Record<string, LocalProjection> = {};
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await adapter.scan(known);
      for (const snapshot of result.snapshots) {
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
      if (adapter.scanStatus().complete) {
        break;
      }
    }
    expect(adapter.scanStatus()).toMatchObject({
      complete: true,
      deferredResourceIds: [],
    });
    expect(adapter.oversizedSnapshotSettlements(1_024)).toEqual([]);
    expect(known["extension/default/publisher.recovered"]).toBeDefined();
  });

  it("settles an oversized Cursor user file without reading its body", async () => {
    const paths = await cursorHomeFixture();
    await writeFile(paths.cursorMcp, "{}", "utf8");
    await truncate(paths.cursorMcp, 2 * 1024 * 1024);
    let reads = 0;
    const adapter = new CursorUserFilesAdapter(
      paths,
      normalizeIgnoredUserFiles([]),
      "win32",
      {
        maxEnumerationRootsPerScan: 3,
        onFileRead: () => {
          reads += 1;
        },
      },
    );
    adapter.setMaxPayloadBytes(1024);

    const result = await adapter.scan({});

    expect(result.snapshots).toEqual([]);
    expect(reads).toBe(0);
    expect(adapter.oversizedSnapshotSettlements(1024)).toHaveLength(1);
    await adapter.dispose();
  });

  it("pages many Cursor user files, retries until acknowledged, then idles without reads", async () => {
    const paths = await cursorHomeFixture();
    await mkdir(paths.cursorRules, { recursive: true });
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        join(paths.cursorRules, `${index.toString().padStart(2, "0")}.md`),
        `rule-${index}`,
        "utf8",
      );
    }
    let reads = 0;
    let now = 1;
    const adapter = new CursorUserFilesAdapter(
      paths,
      normalizeIgnoredUserFiles([]),
      "win32",
      {
        maxEnumerationRootsPerScan: 3,
        maxMetadataChecksPerScan: 8,
        maxResourcesPerScan: 4,
        maxRetainedBytesPerScan: 1024,
        enumerationIntervalMs: 1_000_000,
        metadataIntervalMs: 1_000_000,
        now: () => now,
        onFileRead: () => {
          reads += 1;
        },
      },
    );
    const known: Record<string, LocalProjection> = {};
    const seen = new Set<string>();

    for (let pass = 0; pass < 30; pass += 1) {
      const result = await adapter.scan(known);
      expect(result.snapshots.length).toBeLessThanOrEqual(4);
      for (const snapshot of result.snapshots) {
        seen.add(snapshot.resourceId);
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(seen.size).toBe(40);
    expect(adapter.scanStatus().complete).toBe(true);
    const readsAfterDrain = reads;
    now += 1;
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(reads).toBe(readsAfterDrain);
    await adapter.dispose();
  });

  it("pages settings keys and leaves an unacknowledged page deferred", async () => {
    const root = await temporaryRoot("settings-bounds-");
    const settings = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`test.key${index}`, index]),
    );
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify(settings),
      "utf8",
    );
    const adapter = new SettingsAdapter(
      { userDataRoot: root, profilesRoot: join(root, "profiles") } as CursorPaths,
      EMPTY_IGNORE_MATCHER,
      createSettingsIgnoreMatcher([]),
      EMPTY_IGNORE_MATCHER,
      { maxResourcesPerScan: 4, maxRetainedBytesPerScan: 1024 },
    );
    const known: Record<string, LocalProjection> = {};
    const first = await adapter.scan(known);
    expect(first.snapshots).toHaveLength(4);
    expect(adapter.scanStatus().complete).toBe(false);
    // No acknowledgement: the same page is retried after a failed publish.
    expect(
      (await adapter.scan(known)).snapshots.map((item) => item.resourceId),
    ).toEqual(first.snapshots.map((item) => item.resourceId));

    const seen = new Set<string>();
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await adapter.scan(known);
      for (const snapshot of result.snapshots) {
        seen.add(snapshot.resourceId);
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
      if (adapter.scanStatus().complete) {
        break;
      }
    }
    expect(seen.size).toBe(40);
    expect(adapter.scanStatus().complete).toBe(true);
    await adapter.dispose();
  });

  it("parses only one near-token-cap settings profile and never enumerates all known keys", async () => {
    const root = await temporaryRoot("settings-aggregate-bounds-");
    const profilesRoot = join(root, "profiles");
    await mkdir(profilesRoot, { recursive: true });
    const settings = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 4_000 }, (_, index) => [`key.${index}`, index]),
      ),
    );
    await writeFile(join(root, "settings.json"), settings, "utf8");
    for (let index = 0; index < 15; index += 1) {
      const profileRoot = join(profilesRoot, `p-${index}`);
      await mkdir(profileRoot, { recursive: true });
      await writeFile(join(profileRoot, "settings.json"), settings, "utf8");
    }
    let reads = 0;
    const known = new Proxy(Object.create(null) as Record<string, LocalProjection>, {
      ownKeys: () => {
        throw new Error("settings scan enumerated the whole known projection");
      },
    });
    const adapter = new SettingsAdapter(
      { userDataRoot: root, profilesRoot } as CursorPaths,
      EMPTY_IGNORE_MATCHER,
      EMPTY_IGNORE_MATCHER,
      EMPTY_IGNORE_MATCHER,
      {
        maxProfilesPerScan: 16,
        onFileRead: () => {
          reads += 1;
        },
      },
    );

    const result = await adapter.scan(known);

    expect(reads).toBe(1);
    expect(result.snapshots.length).toBeLessThanOrEqual(32);
    expect(adapter.scanStatus().complete).toBe(false);
    await adapter.dispose();
  });

  it("recovers a settings failed-profile overflow only after a clean full generation", async () => {
    const root = await temporaryRoot("settings-failure-overflow-");
    const profilesRoot = join(root, "profiles");
    await mkdir(profilesRoot, { recursive: true });
    await writeFile(join(root, "settings.json"), "{}", "utf8");
    const profileCount = 6;
    for (let index = 0; index < profileCount; index += 1) {
      const profileRoot = join(profilesRoot, `p-${index}`);
      await mkdir(profileRoot, { recursive: true });
      await writeFile(join(profileRoot, "settings.json"), "{", "utf8");
    }
    let now = 1;
    const adapter = new SettingsAdapter(
      { userDataRoot: root, profilesRoot } as CursorPaths,
      EMPTY_IGNORE_MATCHER,
      EMPTY_IGNORE_MATCHER,
      EMPTY_IGNORE_MATCHER,
      {
        maxProfilesPerScan: 2,
        profileIntervalMs: 100,
        now: () => now,
      },
    );
    let observedOverflow = false;
    for (let pass = 0; pass < 30; pass += 1) {
      await adapter.scan({});
      observedOverflow ||= adapter
        .scanStatus()
        .deferredResourceIds.includes(
          "settings-profile-scope/untracked-read-failures",
        );
      if (observedOverflow) {
        break;
      }
    }
    expect(observedOverflow).toBe(true);

    for (let index = 0; index < profileCount; index += 1) {
      await writeFile(
        join(profilesRoot, `p-${index}`, "settings.json"),
        JSON.stringify({ [`recovered.${index}`]: index }),
        "utf8",
      );
    }
    now = 1_000;
    const known: Record<string, LocalProjection> = {};
    for (let pass = 0; pass < 80; pass += 1) {
      const result = await adapter.scan(known);
      for (const snapshot of result.snapshots) {
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
      if (adapter.scanStatus().complete) {
        break;
      }
      // Let the adapter begin the clean full generation required to retire an
      // overflow sentinel after the original generation drains.
      now += 101;
    }

    expect(adapter.scanStatus()).toMatchObject({
      complete: true,
      deferredResourceIds: [],
    });
    for (let index = 0; index < profileCount; index += 1) {
      expect(known[`settings/p-${index}/recovered.${index}`]).toBeDefined();
    }
    await adapter.dispose();
  });

  it("recovers 65 transient UI value failures through a required clean marker sweep", async () => {
    const root = await temporaryRoot("ui-failure-overflow-");
    const globalDatabase = join(root, "state.vscdb");
    const database = new DatabaseSync(globalDatabase);
    database.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    const keys = Array.from({ length: 65 }, (_, index) => `ui.fail.${index}`);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run(
        "__$__targetStorageMarker",
        JSON.stringify(Object.fromEntries(keys.map((key) => [key, 0]))),
      );
    const insert = database.prepare(
      "INSERT INTO ItemTable(key, value) VALUES (?, ?)",
    );
    for (const key of keys) {
      insert.run(key, `value:${key}`);
    }
    database.close();

    let failReads = true;
    const adapter = new UiStateAdapter(
      { globalDatabase } as CursorPaths,
      undefined,
      {
        maxResourcesPerScan: 32,
        maxMetadataChecksPerScan: 64,
        // Ordinary ui-state is intentionally policy-excluded. Exact helper
        // verification reintroduces only the bounded target page, which also
        // makes this a regression for that real path.
        forceVerificationResourceIds: new Set(
          keys.map((key) => `ui-state/${encodeURIComponent(key)}`),
        ),
        onValueRead: (key) => {
          if (failReads && key.startsWith("ui.fail.")) {
            throw new Error(`transient read failure: ${key}`);
          }
        },
      },
    );
    let observedOverflow = false;
    for (let pass = 0; pass < 8; pass += 1) {
      await adapter.scan({});
      observedOverflow ||= adapter
        .scanStatus()
        .deferredResourceIds.includes("ui-state-scope/untracked-read-failures");
      if (observedOverflow) {
        break;
      }
    }
    expect(observedOverflow).toBe(true);

    failReads = false;
    const known: Record<string, LocalProjection> = {};
    for (let pass = 0; pass < 160; pass += 1) {
      const result = await adapter.scan(known);
      for (const snapshot of result.snapshots) {
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(adapter.scanStatus()).toMatchObject({
      complete: true,
      deferredResourceIds: [],
    });
    for (const key of keys) {
      expect(known[`ui-state/${encodeURIComponent(key)}`]).toBeDefined();
    }
  });

  it("preflights oversized profile and UI-state SQLite values before SELECT", async () => {
    const root = await temporaryRoot("sqlite-general-bounds-");
    const globalDatabase = join(root, "state.vscdb");
    const database = new DatabaseSync(globalDatabase);
    database.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, zeroblob(?))")
      .run("userDataProfiles", 2 * 1024 * 1024);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run(
        "__$__targetStorageMarker",
        JSON.stringify({ "aicontext.personalContext": 0 }),
      );
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, zeroblob(?))")
      .run("aicontext.personalContext", 2 * 1024 * 1024);
    database.close();
    const paths = { globalDatabase } as CursorPaths;
    let profileReads = 0;
    const profiles = new ProfilesAdapter(paths, {
      onValueRead: () => {
        profileReads += 1;
      },
    });
    profiles.setMaxPayloadBytes(1024);
    const uiReads: string[] = [];
    const uiState = new UiStateAdapter(paths, undefined, {
      onValueRead: (key) => uiReads.push(key),
    });
    uiState.setMaxPayloadBytes(1024);

    expect((await profiles.scan({})).snapshots).toEqual([]);
    expect(profileReads).toBe(0);
    expect(profiles.oversizedSnapshotSettlements(1024)).toHaveLength(1);
    expect((await uiState.scan({})).snapshots).toEqual([]);
    expect(uiReads).not.toContain("aicontext.personalContext");
    expect(
      uiState
        .oversizedSnapshotSettlements(1024)
        .some(
          (item) =>
            item.resourceId ===
            "cursor-user-rules/aicontext.personalContext",
        ),
    ).toBe(true);
  });

  it("keeps an unreadable profile file deferred and never tombstones it", async () => {
    const root = await temporaryRoot("profile-file-bounds-");
    await mkdir(join(root, "profiles"), { recursive: true });
    await writeFile(join(root, "keybindings.json"), "not json", "utf8");
    const resourceId = "keybindings/default/keybindings.json";
    const adapter = new ProfileFilesAdapter(
      { userDataRoot: root, profilesRoot: join(root, "profiles") } as CursorPaths,
      { maxEnumerationScopesPerScan: 16 },
    );

    const result = await adapter.scan({
      [resourceId]: {
        resourceId,
        kind: "keybindings",
        semanticHash: "a".repeat(64),
        versionId: null,
      },
    });

    expect(result.deletions).toEqual([]);
    expect(adapter.scanStatus().complete).toBe(false);
    expect(adapter.scanStatus().deferredResourceIds).toContain(resourceId);
    await adapter.dispose();
  });

  it("keeps discovery moving when the first pending Cursor/profile page is permanently unreadable", async () => {
    const cursorPaths = await cursorHomeFixture();
    await writeManyFiles(cursorPaths.cursorRules, 12, ".md", "rule");
    const cursorFailures = new Set<string>();
    let cursorMaxRetained = 0;
    const cursor = new CursorUserFilesAdapter(
      cursorPaths,
      normalizeIgnoredUserFiles([]),
      "win32",
      {
        maxEnumerationMatchesPerScan: 4,
        maxEnumerationWorkItemsPerScan: 64,
        maxMetadataChecksPerScan: 16,
        maxResourcesPerScan: 4,
        onFileRead: (path) => {
          if (cursorFailures.has(path)) {
            throw new Error(`permanent read failure: ${path}`);
          }
          if (cursorFailures.size < 4) {
            cursorFailures.add(path);
            throw new Error(`permanent read failure: ${path}`);
          }
        },
        onPendingDescriptorCount: (count) => {
          cursorMaxRetained = Math.max(cursorMaxRetained, count);
        },
      },
    );

    const cursorResult = await cursor.scan({});
    expect(cursorFailures.size).toBe(4);
    expect(cursorResult.snapshots.length).toBeGreaterThan(0);
    expect(cursorResult.deletions).toEqual([]);
    expect(cursorMaxRetained).toBeLessThanOrEqual(8);
    expect(cursor.scanStatus().complete).toBe(false);
    for (const path of cursorFailures) {
      const relativePath = path
        .slice(cursorPaths.cursorHome.length + 1)
        .replaceAll("\\", "/");
      expect(cursor.scanStatus().deferredResourceIds).toContain(
        `cursor-user-file/${encodeURIComponent(relativePath)}`,
      );
    }
    await cursor.dispose();

    const profileRoot = await temporaryRoot("profile-failed-page-");
    const profilesRoot = join(profileRoot, "profiles");
    const promptsRoot = join(profileRoot, "prompts");
    await mkdir(profilesRoot, { recursive: true });
    await writeManyFiles(promptsRoot, 12, ".md", "prompt");
    const profileFailures = new Set<string>();
    let profileMaxRetained = 0;
    const profile = new ProfileFilesAdapter(
      { userDataRoot: profileRoot, profilesRoot } as CursorPaths,
      {
        maxEnumerationMatchesPerScan: 4,
        maxEnumerationWorkItemsPerScan: 64,
        maxMetadataChecksPerScan: 16,
        maxResourcesPerScan: 4,
        onFileRead: (path) => {
          if (profileFailures.has(path)) {
            throw new Error(`permanent read failure: ${path}`);
          }
          if (profileFailures.size < 4) {
            profileFailures.add(path);
            throw new Error(`permanent read failure: ${path}`);
          }
        },
        onPendingDescriptorCount: (count) => {
          profileMaxRetained = Math.max(profileMaxRetained, count);
        },
      },
    );

    const profileResult = await profile.scan({});
    expect(profileFailures.size).toBe(4);
    expect(profileResult.snapshots.length).toBeGreaterThan(0);
    expect(profileResult.deletions).toEqual([]);
    expect(profileMaxRetained).toBeLessThanOrEqual(8);
    expect(profile.scanStatus().complete).toBe(false);
    for (const path of profileFailures) {
      const relativePath = path
        .slice(promptsRoot.length + 1)
        .replaceAll("\\", "/");
      expect(profile.scanStatus().deferredResourceIds).toContain(
        `prompt/default/${encodeURIComponent(relativePath)}`,
      );
    }
    await profile.dispose();
  });

  it("does not acknowledge same-mtime Cursor/profile/settings rewrites by timestamp alone", async () => {
    const cursorPaths = await cursorHomeFixture();
    await mkdir(cursorPaths.cursorRules, { recursive: true });
    const cursorFile = join(cursorPaths.cursorRules, "same.md");
    await writeFile(cursorFile, "old", "utf8");
    let now = 1;
    const cursor = new CursorUserFilesAdapter(
      cursorPaths,
      normalizeIgnoredUserFiles([]),
      "win32",
      {
        maxEnumerationRootsPerScan: 3,
        metadataIntervalMs: 10,
        enumerationIntervalMs: 10,
        now: () => now,
      },
    );
    const cursorKnown: Record<string, LocalProjection> = {};
    const cursorInitial = await drainOneSnapshot(cursor, cursorKnown);
    const cursorTime = (await stat(cursorFile)).mtime;
    await drainAdapter(cursor, cursorKnown);
    await writeFile(cursorFile, "new", "utf8");
    await utimes(cursorFile, cursorTime, cursorTime);
    now += 11;
    const cursorChanged = await drainOneSnapshot(cursor, cursorKnown, false);
    expect(cursorChanged.semanticHash).not.toBe(cursorInitial.semanticHash);

    const profileRoot = await temporaryRoot("profile-same-mtime-");
    const profilesRoot = join(profileRoot, "profiles");
    const promptRoot = join(profileRoot, "prompts");
    await mkdir(profilesRoot, { recursive: true });
    await mkdir(promptRoot, { recursive: true });
    const promptFile = join(promptRoot, "same.md");
    await writeFile(promptFile, "old", "utf8");
    now = 1;
    const profile = new ProfileFilesAdapter(
      { userDataRoot: profileRoot, profilesRoot } as CursorPaths,
      {
        metadataIntervalMs: 10,
        enumerationIntervalMs: 10,
        now: () => now,
      },
    );
    const profileKnown: Record<string, LocalProjection> = {};
    const profileInitial = await drainOneSnapshot(profile, profileKnown);
    const promptTime = (await stat(promptFile)).mtime;
    await drainAdapter(profile, profileKnown);
    await writeFile(promptFile, "new", "utf8");
    await utimes(promptFile, promptTime, promptTime);
    now += 11;
    const profileChanged = await drainOneSnapshot(profile, profileKnown, false);
    expect(profileChanged.semanticHash).not.toBe(profileInitial.semanticHash);

    const settingsRoot = await temporaryRoot("settings-same-mtime-");
    const settingsProfilesRoot = join(settingsRoot, "profiles");
    await mkdir(settingsProfilesRoot, { recursive: true });
    const settingsFile = join(settingsRoot, "settings.json");
    await writeFile(settingsFile, '{"test.value":"old"}', "utf8");
    now = 1;
    const settings = new SettingsAdapter(
      {
        userDataRoot: settingsRoot,
        profilesRoot: settingsProfilesRoot,
      } as CursorPaths,
      EMPTY_IGNORE_MATCHER,
      EMPTY_IGNORE_MATCHER,
      EMPTY_IGNORE_MATCHER,
      { profileIntervalMs: 10, now: () => now },
    );
    const settingsKnown: Record<string, LocalProjection> = {};
    const settingsInitial = await drainOneSnapshot(settings, settingsKnown);
    const settingsTime = (await stat(settingsFile)).mtime;
    await drainAdapter(settings, settingsKnown);
    await writeFile(settingsFile, '{"test.value":"new"}', "utf8");
    await utimes(settingsFile, settingsTime, settingsTime);
    now += 11;
    const settingsChanged = await drainOneSnapshot(
      settings,
      settingsKnown,
      false,
    );
    expect(settingsChanged.semanticHash).not.toBe(settingsInitial.semanticHash);
    await Promise.all([cursor.dispose(), profile.dispose(), settings.dispose()]);
  });

  it("force-verifies same-mtime profile manifests and UI-state values with fresh adapters", async () => {
    const profileRoot = await temporaryRoot("profile-force-verification-");
    const profileDatabasePath = join(profileRoot, "state.vscdb");
    const oldProfiles = JSON.stringify([
      { location: { path: "/profiles/p1" }, name: "Old" },
    ]);
    const newProfiles = JSON.stringify([
      { location: { path: "/profiles/p1" }, name: "New" },
    ]);
    expect(Buffer.byteLength(newProfiles)).toBe(Buffer.byteLength(oldProfiles));
    const profileDatabase = new DatabaseSync(profileDatabasePath);
    profileDatabase.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    profileDatabase
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("userDataProfiles", oldProfiles);
    profileDatabase.close();
    const profilePaths = {
      globalDatabase: profileDatabasePath,
    } as CursorPaths;
    const profileInitial = (await new ProfilesAdapter(profilePaths).scan({}))
      .snapshots[0]!;
    const profileKnown = {
      [profileInitial.resourceId]: projectionFromSnapshot(profileInitial),
    };
    const profileOriginalStat = await stat(profileDatabasePath);
    const profileRewrite = new DatabaseSync(profileDatabasePath);
    profileRewrite
      .prepare("UPDATE ItemTable SET value = ? WHERE key = ?")
      .run(newProfiles, "userDataProfiles");
    profileRewrite.close();
    await utimes(
      profileDatabasePath,
      profileOriginalStat.mtime,
      profileOriginalStat.mtime,
    );
    const profileRewrittenStat = await stat(profileDatabasePath);
    expect(profileRewrittenStat.size).toBe(profileOriginalStat.size);
    expect(profileRewrittenStat.mtimeMs).toBeCloseTo(
      profileOriginalStat.mtimeMs,
      -1,
    );
    profileKnown[profileInitial.resourceId]!.sourceTimestamp =
      profileRewrittenStat.mtimeMs;
    expect(
      (await new ProfilesAdapter(profilePaths).scan(profileKnown)).snapshots,
    ).toEqual([]);

    const forcedProfile = await new ProfilesAdapter(profilePaths, {
      forceVerificationResourceIds: new Set([profileInitial.resourceId]),
    }).scan(profileKnown);

    expect(forcedProfile.snapshots).toHaveLength(1);
    expect(forcedProfile.snapshots[0]?.content.toString("utf8")).toContain(
      '"name":"New"',
    );
    expect(forcedProfile.snapshots[0]?.semanticHash).not.toBe(
      profileInitial.semanticHash,
    );

    const uiRoot = await temporaryRoot("ui-force-verification-");
    const uiDatabasePath = join(uiRoot, "state.vscdb");
    const uiKey = "aicontext.personalContext";
    const uiResourceId = `cursor-user-rules/${encodeURIComponent(uiKey)}`;
    expect(Buffer.byteLength("new")).toBe(Buffer.byteLength("old"));
    const uiDatabase = new DatabaseSync(uiDatabasePath);
    uiDatabase.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    uiDatabase
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("__$__targetStorageMarker", "{}");
    uiDatabase
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run(uiKey, "old");
    uiDatabase.close();
    const uiPaths = { globalDatabase: uiDatabasePath } as CursorPaths;
    const uiInitial = (await new UiStateAdapter(uiPaths).scan({})).snapshots.find(
      (snapshot) => snapshot.resourceId === uiResourceId,
    )!;
    const uiKnown = {
      [uiResourceId]: projectionFromSnapshot(uiInitial),
    };
    const uiOriginalStat = await stat(uiDatabasePath);
    const uiRewrite = new DatabaseSync(uiDatabasePath);
    uiRewrite
      .prepare("UPDATE ItemTable SET value = ? WHERE key = ?")
      .run("new", uiKey);
    uiRewrite.close();
    await utimes(uiDatabasePath, uiOriginalStat.mtime, uiOriginalStat.mtime);
    const uiRewrittenStat = await stat(uiDatabasePath);
    expect(uiRewrittenStat.size).toBe(uiOriginalStat.size);
    expect(uiRewrittenStat.mtimeMs).toBeCloseTo(uiOriginalStat.mtimeMs, -1);
    uiKnown[uiResourceId]!.sourceTimestamp = uiRewrittenStat.mtimeMs;
    expect((await new UiStateAdapter(uiPaths).scan(uiKnown)).snapshots).toEqual(
      [],
    );

    const forcedUi = await new UiStateAdapter(uiPaths, undefined, {
      forceVerificationResourceIds: new Set([uiResourceId]),
    }).scan(uiKnown);

    expect(forcedUi.snapshots).toHaveLength(1);
    expect(forcedUi.snapshots[0]?.resourceId).toBe(uiResourceId);
    expect(forcedUi.snapshots[0]?.content.toString("utf8")).toBe("new");
    expect(forcedUi.snapshots[0]?.semanticHash).not.toBe(
      uiInitial.semanticHash,
    );
  });

  it("retains hash-only memo identities for unchanged files above body-cache limits", async () => {
    const cursorPaths = await cursorHomeFixture();
    await mkdir(cursorPaths.cursorRules, { recursive: true });
    await writeFile(
      join(cursorPaths.cursorRules, "large.md"),
      Buffer.alloc(3 * 1024 * 1024, 1),
    );
    let now = 1;
    let cursorReads = 0;
    const cursor = new CursorUserFilesAdapter(
      cursorPaths,
      normalizeIgnoredUserFiles([]),
      "win32",
      {
        now: () => now,
        metadataIntervalMs: 10,
        enumerationIntervalMs: 10,
        onFileRead: () => {
          cursorReads += 1;
        },
      },
    );
    cursor.setMaxPayloadBytes(16 * 1024 * 1024);
    const cursorKnown: Record<string, LocalProjection> = {};
    await drainOneSnapshot(cursor, cursorKnown);
    await drainAdapter(cursor, cursorKnown);
    const cursorProjection = Object.values(cursorKnown)[0]!;
    delete cursorProjection.sourceFileSize;
    delete cursorProjection.sourceFileCtimeMs;
    now += 11;
    await drainAdapter(cursor, cursorKnown);
    expect(cursorReads).toBe(1);

    const profileRoot = await temporaryRoot("profile-large-memo-");
    const profilesRoot = join(profileRoot, "profiles");
    const promptsRoot = join(profileRoot, "prompts");
    await mkdir(profilesRoot, { recursive: true });
    await mkdir(promptsRoot, { recursive: true });
    await writeFile(
      join(promptsRoot, "large.md"),
      Buffer.alloc(9 * 1024 * 1024, 2),
    );
    now = 1;
    let profileReads = 0;
    const profile = new ProfileFilesAdapter(
      { userDataRoot: profileRoot, profilesRoot } as CursorPaths,
      {
        now: () => now,
        metadataIntervalMs: 10,
        enumerationIntervalMs: 10,
        onFileRead: () => {
          profileReads += 1;
        },
      },
    );
    profile.setMaxPayloadBytes(16 * 1024 * 1024);
    const profileKnown: Record<string, LocalProjection> = {};
    await drainOneSnapshot(profile, profileKnown);
    await drainAdapter(profile, profileKnown);
    const profileProjection = Object.values(profileKnown)[0]!;
    delete profileProjection.sourceFileSize;
    delete profileProjection.sourceFileCtimeMs;
    now += 11;
    await drainAdapter(profile, profileKnown);
    expect(profileReads).toBe(1);
    await Promise.all([cursor.dispose(), profile.dispose()]);
  });

  it("rejects a sparse oversized extension manifest before body materialization", async () => {
    const paths = await cursorHomeFixture();
    await writeFile(paths.cursorExtensionsManifest, "[]", "utf8");
    await truncate(
      paths.cursorExtensionsManifest,
      MAX_EXTENSION_MANIFEST_BYTES + 1,
    );
    let reads = 0;
    await expect(
      readBoundedExtensionManifestMetadata(
        paths,
        MAX_EXTENSION_MANIFEST_BYTES,
        () => {
          reads += 1;
        },
      ),
    ).rejects.toThrow("read limit");
    expect(reads).toBe(0);
  });

  it("rejects deeply nested extension metadata before JSON object materialization", async () => {
    const paths = await cursorHomeFixture();
    const source = `${"[".repeat(129)}0${"]".repeat(129)}`;
    await writeFile(paths.cursorExtensionsManifest, source, "utf8");

    await expect(
      readBoundedExtensionManifestMetadata(paths),
    ).rejects.toThrow("128-level automatic parse depth limit");
  });

  it("finishes a two-profile extension generation and idles without CLI or DB reads", async () => {
    const root = await temporaryRoot("extension-profile-sweep-");
    const cursorHome = join(root, ".cursor");
    const userDataRoot = join(root, "User");
    const profilesRoot = join(userDataRoot, "profiles");
    const globalDatabase = join(userDataRoot, "globalStorage", "state.vscdb");
    const profileDatabase = join(
      profilesRoot,
      "p1",
      "globalStorage",
      "state.vscdb",
    );
    await mkdir(join(userDataRoot, "globalStorage"), { recursive: true });
    await mkdir(join(profilesRoot, "p1", "globalStorage"), {
      recursive: true,
    });
    await mkdir(cursorHome, { recursive: true });
    const global = new DatabaseSync(globalDatabase);
    global.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
    global
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run(
        "userDataProfiles",
        JSON.stringify([{ location: { path: "/profiles/p1" }, name: "One" }]),
      );
    global.close();
    const profile = new DatabaseSync(profileDatabase);
    profile.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
    profile.close();
    const paths = {
      appRoot: root,
      cursorHome,
      userDataRoot,
      profilesRoot,
      globalDatabase,
      cursorExtensionsManifest: join(cursorHome, "extensions.json"),
    } as CursorPaths;
    await writeFile(paths.cursorExtensionsManifest, "[]", "utf8");
    let cliReads = 0;
    let disabledReads = 0;
    const adapter = new ExtensionsAdapter(
      paths,
      createExtensionIgnoreMatcher([]),
      {
        now: () => 1,
        scanIntervalMs: 1_000_000,
        listInstalledExtensions: async (profileName) => {
          cliReads += 1;
          return [
            {
              id: profileName === null ? "publisher.default" : "publisher.one",
              version: "1.0.0",
            },
          ];
        },
        onDisabledValueRead: () => {
          disabledReads += 1;
        },
      },
    );
    const known: Record<string, LocalProjection> = {};
    await drainAdapter(adapter, known);
    expect(adapter.scanStatus().complete).toBe(true);
    expect(Object.keys(known).sort()).toEqual([
      "extension/default/publisher.default",
      "extension/p1/publisher.one",
    ]);
    expect(cliReads).toBe(2);
    expect(disabledReads).toBe(2);

    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(adapter.scanStatus().complete).toBe(true);
    expect(cliReads).toBe(2);
    expect(disabledReads).toBe(2);
  });

  it("advances past a corrupt extension profile and still publishes its sibling", async () => {
    const root = await temporaryRoot("extension-profile-failure-");
    const cursorHome = join(root, ".cursor");
    const userDataRoot = join(root, "User");
    const profilesRoot = join(userDataRoot, "profiles");
    const globalDatabase = join(userDataRoot, "globalStorage", "state.vscdb");
    await mkdir(join(userDataRoot, "globalStorage"), { recursive: true });
    await mkdir(cursorHome, { recursive: true });
    const database = new DatabaseSync(globalDatabase);
    database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run(
        "userDataProfiles",
        JSON.stringify([
          { location: { path: "/profiles/a" }, name: "Broken" },
          { location: { path: "/profiles/b" }, name: "Healthy" },
        ]),
      );
    database.close();
    const paths = {
      appRoot: root,
      cursorHome,
      userDataRoot,
      profilesRoot,
      globalDatabase,
      cursorExtensionsManifest: join(cursorHome, "extensions.json"),
    } as CursorPaths;
    await writeFile(paths.cursorExtensionsManifest, "[]", "utf8");
    const adapter = new ExtensionsAdapter(
      paths,
      createExtensionIgnoreMatcher([]),
      {
        now: () => 1,
        listInstalledExtensions: async (profileName) => {
          if (profileName === "Broken") {
            throw new Error("corrupt registry");
          }
          return profileName === "Healthy"
            ? [{ id: "publisher.healthy", version: "1.0.0" }]
            : [];
        },
      },
    );
    const known: Record<string, LocalProjection> = {};
    for (let pass = 0; pass < 12; pass += 1) {
      const result = await adapter.scan(known);
      for (const snapshot of result.snapshots) {
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
    }

    expect(known["extension/b/publisher.healthy"]).toBeDefined();
    expect(adapter.scanStatus().complete).toBe(false);
    expect(adapter.scanStatus().deferredResourceIds).toContain(
      "extension-profile/a",
    );
  });

  it("streams 10,001 Cursor files with bounded state and makes fresh-helper progress past 1,024", async () => {
    const paths = await cursorHomeFixture();
    await writeManyFiles(paths.cursorRules, 10_001, ".md", "rule");
    const known: Record<string, LocalProjection> = {
      "cursor-user-file/rules%2Fvanished.md": {
        resourceId: "cursor-user-file/rules%2Fvanished.md",
        kind: "cursor-user-file",
        semanticHash: "ghost",
        versionId: null,
      },
    };
    const seen = new Set<string>();
    let reads = 0;
    let scanWork = 0;
    let scanMetadata = 0;
    let maxPending = 0;
    let maxRetainedPaths = 0;
    const options = {
      maxEnumerationRootsPerScan: 3,
      maxEnumerationWorkItemsPerScan: 512,
      maxEnumerationMatchesPerScan: 32,
      maxMetadataChecksPerScan: 64,
      maxResourcesPerScan: 32,
      metadataIntervalMs: 1_000_000,
      enumerationIntervalMs: 1_000_000,
      now: () => 1,
      onFileRead: () => {
        reads += 1;
      },
      onMetadataCheck: () => {
        scanMetadata += 1;
      },
      onEnumerationPage: (page: {
        workItems: number;
        retainedPathCount: number;
      }) => {
        scanWork += page.workItems;
        maxRetainedPaths = Math.max(
          maxRetainedPaths,
          page.retainedPathCount,
        );
      },
      onPendingDescriptorCount: (count: number) => {
        maxPending = Math.max(maxPending, count);
      },
    };
    const scanAndAcknowledge = async (adapter: CursorUserFilesAdapter) => {
      scanWork = 0;
      scanMetadata = 0;
      const result = await adapter.scan(known);
      expect(result.deletions).toEqual([]);
      expect(result.snapshots.length).toBeLessThanOrEqual(32);
      expect(scanWork).toBeLessThanOrEqual(512);
      expect(scanMetadata).toBeLessThanOrEqual(64);
      for (const snapshot of result.snapshots) {
        seen.add(snapshot.resourceId);
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
      return result;
    };

    // This is exactly the finite shutdown-helper window. Results are emitted
    // from the first page instead of being staged until the 10k walk ends.
    let finalHelper: CursorUserFilesAdapter | null = null;
    for (let session = 0; session < 16 && seen.size < 10_001; session += 1) {
      const before = seen.size;
      const helper = new CursorUserFilesAdapter(
        paths,
        normalizeIgnoredUserFiles([]),
        "win32",
        options,
      );
      for (let pass = 0; pass < 32; pass += 1) {
        await scanAndAcknowledge(helper);
      }
      expect(seen.size).toBeGreaterThan(before);
      if (seen.size < 10_001) {
        await helper.dispose();
      } else {
        finalHelper = helper;
      }
    }
    expect(finalHelper).not.toBeNull();
    expect(seen.size).toBe(10_001);
    expect(finalHelper!.scanStatus().complete).toBe(true);
    // Published projections carry size+mtime+ctime alongside the content hash.
    // Every fresh helper can skip the authenticated unchanged prefix during
    // the bounded walk without rereading it, and every session makes progress.
    expect(reads).toBe(10_001);
    expect(maxPending).toBeLessThanOrEqual(32);
    expect(maxRetainedPaths).toBeLessThanOrEqual(65);

    scanWork = 0;
    scanMetadata = 0;
    const readsBeforeIdle = reads;
    expect((await finalHelper!.scan(known)).snapshots).toEqual([]);
    expect(scanWork).toBe(0);
    expect(scanMetadata).toBe(0);
    expect(reads).toBe(readsBeforeIdle);
    await finalHelper!.dispose();
  }, 120_000);

  it("streams 10,003 profile prompt files with bounded pending/work and then idles", async () => {
    const root = await temporaryRoot("profile-file-10k-");
    const profilesRoot = join(root, "profiles");
    const prompts = join(root, "prompts");
    await mkdir(profilesRoot, { recursive: true });
    await writeManyFiles(prompts, 10_003, ".md", "prompt");
    const paths = { userDataRoot: root, profilesRoot } as CursorPaths;
    const known: Record<string, LocalProjection> = {
      "prompt/default/vanished.md": {
        resourceId: "prompt/default/vanished.md",
        kind: "prompt",
        semanticHash: "ghost",
        versionId: null,
      },
    };
    const seen = new Set<string>();
    let reads = 0;
    let scanWork = 0;
    let scanMetadata = 0;
    let maxPending = 0;
    let maxRetainedPaths = 0;
    const adapter = new ProfileFilesAdapter(paths, {
      maxEnumerationScopesPerScan: 16,
      maxEnumerationWorkItemsPerScan: 256,
      maxEnumerationMatchesPerScan: 32,
      maxMetadataChecksPerScan: 64,
      maxResourcesPerScan: 32,
      metadataIntervalMs: 1_000_000,
      enumerationIntervalMs: 1_000_000,
      now: () => 1,
      onFileRead: () => {
        reads += 1;
      },
      onMetadataCheck: () => {
        scanMetadata += 1;
      },
      onEnumerationPage: (page) => {
        scanWork += page.workItems;
        maxRetainedPaths = Math.max(
          maxRetainedPaths,
          page.retainedPathCount,
        );
      },
      onPendingDescriptorCount: (count) => {
        maxPending = Math.max(maxPending, count);
      },
    });
    for (let pass = 0; pass < 400; pass += 1) {
      scanWork = 0;
      scanMetadata = 0;
      const result = await adapter.scan(known);
      expect(result.deletions).toEqual([]);
      expect(result.snapshots.length).toBeLessThanOrEqual(32);
      expect(scanWork).toBeLessThanOrEqual(256);
      expect(scanMetadata).toBeLessThanOrEqual(64);
      for (const snapshot of result.snapshots) {
        seen.add(snapshot.resourceId);
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
      if (adapter.scanStatus().complete) {
        break;
      }
    }
    expect(adapter.scanStatus().complete).toBe(true);
    expect(seen.size).toBe(10_003);
    expect(reads).toBe(10_003);
    expect(maxPending).toBeLessThanOrEqual(32);
    expect(maxRetainedPaths).toBeLessThanOrEqual(65);

    scanWork = 0;
    scanMetadata = 0;
    const readsBeforeIdle = reads;
    expect((await adapter.scan(known)).snapshots).toEqual([]);
    expect(scanWork).toBe(0);
    expect(scanMetadata).toBe(0);
    expect(reads).toBe(readsBeforeIdle);
    await adapter.dispose();
  }, 120_000);

  it("keyset-walks 10,003 top-level profiles without a return-all array", async () => {
    const root = await temporaryRoot("profile-paths-10k-");
    const profilesRoot = join(root, "profiles");
    await mkdir(profilesRoot, { recursive: true });
    await createManyDirectories(profilesRoot, 10_003);
    const paths = { userDataRoot: root, profilesRoot } as CursorPaths;
    const pager = new ProfileResourcePathPager();
    const seen = new Set<string>();
    let complete = false;
    for (let pass = 0; pass < 400; pass += 1) {
      const page = await pager.advance(paths, {
        maxProfiles: 32,
        maxWorkItems: 256,
      });
      expect(page.profiles.length).toBeLessThanOrEqual(32);
      expect(page.workItems).toBeLessThanOrEqual(256);
      expect(page.retainedPathCount).toBeLessThanOrEqual(2);
      for (const profile of page.profiles) {
        seen.add(profile.profileId);
      }
      if (page.complete) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    expect(seen.size).toBe(10_004);
    expect((await pager.advance(paths)).profiles).toEqual([]);
    await pager.dispose();
  }, 120_000);
});

describe("workspace identity memo bounds", () => {
  it("resolves one helper target among 10k unrelated workspaces without directory enumeration", async () => {
    const root = await temporaryRoot("workspace-helper-exact-");
    const workspaceStorageRoot = join(root, "workspaceStorage");
    await mkdir(workspaceStorageRoot, { recursive: true });
    await createManyDirectories(workspaceStorageRoot, 10_000);
    const targetId = "profile-09999";
    await writeFile(
      join(workspaceStorageRoot, targetId, "workspace.json"),
      JSON.stringify({ folder: "file:///only-referenced-target" }),
      "utf8",
    );
    let enumerations = 0;
    let metadataReads = 0;
    workspaceDiscoveryTesting.setEnumerationObserver(() => {
      enumerations += 1;
    });
    const mappings = Object.fromEntries(
      Array.from({ length: 600 }, (_unused, index) => [
        `unrelated-${index}`,
        `nowhere-${index}`,
      ]),
    );
    mappings.foreign = targetId;

    const resolved = await lookupWorkspaceIdentityReferences(
      { workspaceStorageRoot } as CursorPaths,
      ["foreign"],
      mappings,
      {
        onMetadataRead: () => {
          metadataReads += 1;
        },
      },
    );

    expect(resolved).toEqual([
      {
        id: targetId,
        uri: "file:///only-referenced-target",
        basename: "only-referenced-target",
      },
    ]);
    expect(metadataReads).toBe(1);
    expect(enumerations).toBe(0);
  }, 120_000);

  it("invalidates exact workspace identity memo on same-size restored-mtime rewrites", async () => {
    const root = await temporaryRoot("workspace-exact-ctime-");
    const workspaceStorageRoot = join(root, "workspaceStorage");
    const workspaceId = "workspace-a";
    const metadataPath = join(
      workspaceStorageRoot,
      workspaceId,
      "workspace.json",
    );
    await mkdir(join(workspaceStorageRoot, workspaceId), { recursive: true });
    await writeFile(
      metadataPath,
      JSON.stringify({ folder: "file:///workspace-old" }),
      "utf8",
    );
    const originalTime = (await stat(metadataPath)).mtime;
    const paths = { workspaceStorageRoot } as CursorPaths;
    expect(
      (await lookupWorkspaceIdentityReferences(paths, [workspaceId]))[0]?.uri,
    ).toBe("file:///workspace-old");

    await writeFile(
      metadataPath,
      JSON.stringify({ folder: "file:///workspace-new" }),
      "utf8",
    );
    await utimes(metadataPath, originalTime, originalTime);

    expect(
      (await lookupWorkspaceIdentityReferences(paths, [workspaceId]))[0]?.uri,
    ).toBe("file:///workspace-new");
  });

  it("memoizes structurally hostile exact workspace metadata without parsing", async () => {
    const root = await temporaryRoot("workspace-exact-structure-");
    const workspaceStorageRoot = join(root, "workspaceStorage");
    const workspaceId = "workspace-hostile";
    await mkdir(join(workspaceStorageRoot, workspaceId), { recursive: true });
    await writeFile(
      join(workspaceStorageRoot, workspaceId, "workspace.json"),
      `{"folder":"file:///hostile","future":[${Array.from(
        { length: 22_000 },
        () => "{}",
      ).join(",")}]}`,
      "utf8",
    );
    let metadataReads = 0;
    const parse = vi.spyOn(JSON, "parse");
    try {
      const paths = { workspaceStorageRoot } as CursorPaths;
      const first = await lookupWorkspaceIdentityReferences(
        paths,
        [workspaceId],
        {},
        { onMetadataRead: () => { metadataReads += 1; } },
      );
      const cached = await lookupWorkspaceIdentityReferences(
        paths,
        [workspaceId],
        {},
        { onMetadataRead: () => { metadataReads += 1; } },
      );

      expect(first).toEqual([]);
      expect(cached).toEqual([]);
      expect(metadataReads).toBe(1);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("keeps structurally hostile discovery metadata unknown without reparsing it", async () => {
    const root = await temporaryRoot("workspace-discovery-structure-");
    const workspaceStorageRoot = join(root, "workspaceStorage");
    const workspaceId = "workspace-hostile";
    await mkdir(join(workspaceStorageRoot, workspaceId), { recursive: true });
    await writeFile(
      join(workspaceStorageRoot, workspaceId, "workspace.json"),
      `{"folder":"file:///hostile","future":[${Array.from(
        { length: 22_000 },
        () => "{}",
      ).join(",")}]}`,
      "utf8",
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      const paths = { workspaceStorageRoot } as CursorPaths;
      const first = await discoverWorkspacesDetailed(paths);
      const cached = await discoverWorkspacesDetailed(paths);

      expect(first.unreadableIds).toEqual([workspaceId]);
      expect(cached.unreadableIds).toEqual([workspaceId]);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("bounds an oversized workspace.json and does not reread healthy identities", async () => {
    const root = await temporaryRoot("workspace-discovery-bounds-");
    const workspaceStorageRoot = join(root, "workspaceStorage");
    await mkdir(workspaceStorageRoot, { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      const id = `ws-${index.toString().padStart(2, "0")}`;
      await mkdir(join(workspaceStorageRoot, id), { recursive: true });
      await writeFile(
        join(workspaceStorageRoot, id, "workspace.json"),
        JSON.stringify({ folder: `file:///project-${index}` }),
        "utf8",
      );
    }
    const oversizedId = "zz-oversized";
    await mkdir(join(workspaceStorageRoot, oversizedId), { recursive: true });
    const oversizedPath = join(workspaceStorageRoot, oversizedId, "workspace.json");
    await writeFile(oversizedPath, "{}", "utf8");
    await truncate(oversizedPath, 2 * 1024 * 1024);
    const paths = { workspaceStorageRoot } as CursorPaths;

    await discoverWorkspacesDetailed(paths);
    const complete = await discoverWorkspacesDetailed(paths);
    expect(complete.workspaces).toHaveLength(20);
    expect(complete.unreadableIds).toContain(oversizedId);

    // A nested metadata rewrite does not change workspaceStorageRoot itself.
    // The healthy per-entry identity remains cached while only unreadable IDs
    // consume the bounded retry cursor.
    await writeFile(
      join(workspaceStorageRoot, "ws-00", "workspace.json"),
      "not json",
      "utf8",
    );
    const cached = await discoverWorkspacesDetailed(paths);
    expect(cached.workspaces.some((item) => item.id === "ws-00")).toBe(true);
    expect(cached.unreadableIds).toEqual([oversizedId]);
  });
});

function projectionFromSnapshot(snapshot: ResourceSnapshot): LocalProjection {
  return {
    resourceId: snapshot.resourceId,
    kind: snapshot.kind,
    semanticHash: snapshot.semanticHash,
    versionId: null,
    ...(typeof snapshot.metadata?.lastUpdatedAt === "number"
      ? { sourceTimestamp: snapshot.metadata.lastUpdatedAt }
      : {}),
    ...(typeof snapshot.metadata?.sourceFileSize === "number"
      ? { sourceFileSize: snapshot.metadata.sourceFileSize }
      : {}),
    ...(typeof snapshot.metadata?.sourceFileCtimeMs === "number"
      ? { sourceFileCtimeMs: snapshot.metadata.sourceFileCtimeMs }
      : {}),
  };
}

async function drainOneSnapshot(
  adapter: Pick<ResourceAdapter, "scan" | "scanStatus">,
  known: Record<string, LocalProjection>,
  acknowledge = true,
): Promise<ResourceSnapshot> {
  for (let pass = 0; pass < 64; pass += 1) {
    const result = await adapter.scan(known);
    const snapshot = result.snapshots[0];
    if (snapshot) {
      if (acknowledge) {
        known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
      }
      return snapshot;
    }
    if (adapter.scanStatus?.().complete) {
      break;
    }
  }
  throw new Error("Adapter completed without emitting a snapshot.");
}

async function drainAdapter(
  adapter: Pick<ResourceAdapter, "scan" | "scanStatus">,
  known: Record<string, LocalProjection>,
): Promise<void> {
  for (let pass = 0; pass < 64; pass += 1) {
    const result = await adapter.scan(known);
    for (const snapshot of result.snapshots) {
      known[snapshot.resourceId] = projectionFromSnapshot(snapshot);
    }
    if (adapter.scanStatus?.().complete ?? result.snapshots.length === 0) {
      return;
    }
  }
  throw new Error("Adapter did not complete within the bounded test window.");
}

async function cursorHomeFixture(): Promise<CursorPaths> {
  const root = await temporaryRoot("cursor-user-bounds-");
  return {
    cursorHome: root,
    cursorMcp: join(root, "mcp.json"),
    cursorCliConfig: join(root, "cli-config.json"),
    cursorCommands: join(root, "commands"),
    cursorSkills: join(root, "skills"),
    cursorRules: join(root, "rules"),
    cursorExtensionsManifest: join(root, "extensions.json"),
  } as CursorPaths;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeManyFiles(
  root: string,
  count: number,
  suffix: string,
  content: string,
): Promise<void> {
  await mkdir(root, { recursive: true });
  for (let start = 0; start < count; start += 256) {
    await Promise.all(
      Array.from(
        { length: Math.min(256, count - start) },
        (_unused, offset) => {
          const index = start + offset;
          return writeFile(
            join(root, `${index.toString().padStart(5, "0")}${suffix}`),
            content,
            "utf8",
          );
        },
      ),
    );
  }
}

async function createManyDirectories(root: string, count: number): Promise<void> {
  for (let start = 0; start < count; start += 256) {
    await Promise.all(
      Array.from(
        { length: Math.min(256, count - start) },
        (_unused, offset) =>
          mkdir(
            join(root, `profile-${(start + offset).toString().padStart(5, "0")}`),
          ),
      ),
    );
  }
}
