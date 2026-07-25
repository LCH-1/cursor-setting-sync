import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertSafeIdentifier,
  assertSafeRelativePath,
  readFileWithinRoot,
  removeFileWithinRoot,
  writeFileAtomicWithinRoot,
} from "../src/platform/files";
import { assertValidProfileId } from "../src/resources/profilePaths";
import { validateEventManifest } from "../src/protocol/repository";
import { parentsForLocalChange } from "../src/protocol/reconciler";
import { isRepositoryPayloadFile } from "../src/sync/watch";
import { CursorUserFilesAdapter } from "../src/resources/cursorUserFiles";
import {
  SettingsAdapter,
  createSettingsIgnoreMatcher,
} from "../src/resources/settings";
import { ProfileFilesAdapter } from "../src/resources/profileFiles";
import { semanticHash } from "../src/resources/jsonc";
import { canonicalJson } from "../src/protocol/canonical";
import type { CursorPaths } from "../src/platform/paths";
import type {
  EventManifest,
  LocalProjection,
  ResourceTip,
} from "../src/types";

describe("synchronization input boundaries", () => {
  it("does not retrigger synchronization for local repository metadata", () => {
    expect(isRepositoryPayloadFile("devices/local/acks.json")).toBe(false);
    expect(isRepositoryPayloadFile("devices/local/head.json")).toBe(false);
    expect(
      isRepositoryPayloadFile(`devices/remote/events/${"1".repeat(16)}-${"a".repeat(64)}.cse`),
    ).toBe(true);
    expect(
      isRepositoryPayloadFile(`devices/remote/blobs/sha256/aa/${"a".repeat(64)}.cso`),
    ).toBe(true);
  });

  it("accepts a normalized path inside its exact root", () => {
    const root = resolve("C:/safe-root");
    expect(assertSafeRelativePath(root, "commands/example.md")).toBe(
      join(root, "commands/example.md"),
    );
  });

  it.each([
    "commands/../outside.txt",
    "commands\\outside.txt",
    "commands//outside.txt",
    "commands/CON.txt",
    "commands/file.txt:stream",
  ])("rejects unsafe portable path %s", (candidate) => {
    expect(() => assertSafeRelativePath("C:/safe-root", candidate)).toThrow();
  });

  it("rejects a profile identifier that can escape profilesRoot", () => {
    expect(() => assertValidProfileId("..\\..\\escaped")).toThrow();
    expect(() => assertSafeIdentifier("valid-profile_1", "profile ID")).not.toThrow();
  });

  it("reads, writes, and removes files below a real root", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-sync-safe-path-"));
    const root = join(temporaryRoot, "root");
    try {
      await mkdir(root);
      await writeFileAtomicWithinRoot(
        root,
        "rules/nested/example.md",
        Buffer.from("safe", "utf8"),
      );

      expect(
        (await readFileWithinRoot(root, "rules/nested/example.md")).toString(
          "utf8",
        ),
      ).toBe("safe");
      await removeFileWithinRoot(root, "rules/nested/example.md");
      await expect(
        stat(join(root, "rules", "nested", "example.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a directory symlink or junction below the trusted root", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-sync-linked-path-"));
    const root = join(temporaryRoot, "root");
    const outside = join(temporaryRoot, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      await writeFile(join(outside, "secret.md"), "do not collect", "utf8");
      await symlink(
        outside,
        join(root, "rules"),
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(
        readFileWithinRoot(root, "rules/secret.md"),
      ).rejects.toThrow(/symbolic link|junction/i);
      await expect(
        writeFileAtomicWithinRoot(
          root,
          "rules/escape.md",
          Buffer.from("escaped", "utf8"),
        ),
      ).rejects.toThrow(/symbolic link|linked/i);
      await expect(
        readFile(join(outside, "escape.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a final file symlink when the platform permits creating one", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-sync-linked-file-"));
    const root = join(temporaryRoot, "root");
    const secret = join(temporaryRoot, "secret.json");
    try {
      await mkdir(root);
      await writeFile(secret, '{"token":"private"}', "utf8");
      try {
        await symlink(secret, join(root, "mcp.json"), "file");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EPERM") {
          return;
        }
        throw error;
      }

      await expect(readFileWithinRoot(root, "mcp.json")).rejects.toThrow(
        /symbolic link|junction/i,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects an allowlist prefix followed by traversal", async () => {
    const relativePath = "commands/../outside.txt";
    const adapter = new CursorUserFilesAdapter({
      cursorHome: "C:/safe-root",
    } as CursorPaths);
    await expect(
      adapter.apply({
        resourceId: `cursor-user-file/${encodeURIComponent(relativePath)}`,
        kind: "cursor-user-file",
        semanticHash: "a".repeat(64),
        metadata: { relativePath },
      }),
    ).rejects.toThrow("unsafe segment");
  });

  it("rejects traversal embedded in incoming profile metadata", async () => {
    const profileId = "..\\..\\escaped";
    const key = "editor.fontSize";
    const adapter = new SettingsAdapter(
      {
        userDataRoot: "C:/Cursor/User",
        profilesRoot: "C:/Cursor/User/profiles",
      } as CursorPaths,
      createSettingsIgnoreMatcher([]),
      createSettingsIgnoreMatcher([]),
    );
    await expect(
      adapter.apply({
        resourceId: `settings/${encodeURIComponent(profileId)}/${encodeURIComponent(key)}`,
        kind: "settings",
        semanticHash: "a".repeat(64),
        metadata: { profileId, key },
      }),
    ).rejects.toThrow("profile ID");
  });

  it("retains an ignored local setting instead of applying a remote value", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-sync-settings-"));
    try {
      const settingsPath = join(temporaryRoot, "settings.json");
      await writeFile(
        settingsPath,
        JSON.stringify({ "editor.fontSize": 14 }, null, 2),
      );
      const adapter = new SettingsAdapter(
        {
          userDataRoot: temporaryRoot,
          profilesRoot: join(temporaryRoot, "profiles"),
        } as CursorPaths,
        createSettingsIgnoreMatcher(["editor.fontSize"]),
        createSettingsIgnoreMatcher([]),
      );

      const result = await adapter.apply({
        resourceId: "settings/default/editor.fontSize",
        kind: "settings",
        content: Buffer.from("20", "utf8"),
        semanticHash: semanticHash(20),
        metadata: { profileId: "default", key: "editor.fontSize" },
      });

      expect(result).toEqual({
        status: "retained-local",
        semanticHash: semanticHash(14),
      });
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
        "editor.fontSize": 14,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("does not publish snippet deletions when its directory cannot be enumerated", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-sync-profile-scan-"));
    try {
      await writeFile(join(temporaryRoot, "snippets"), "not a directory", "utf8");
      const adapter = new ProfileFilesAdapter({
        userDataRoot: temporaryRoot,
        profilesRoot: join(temporaryRoot, "profiles"),
      } as CursorPaths);
      const resourceId = "snippet/default/example.code-snippets";

      const result = await adapter.scan({
        [resourceId]: projection(resourceId, "snippet"),
      });

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.deletions).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("does not publish Cursor user-file deletions when a root cannot be enumerated", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-sync-user-scan-"));
    try {
      await writeFile(join(temporaryRoot, "commands"), "not a directory", "utf8");
      const adapter = new CursorUserFilesAdapter({
        cursorHome: temporaryRoot,
        cursorMcp: join(temporaryRoot, "mcp.json"),
        cursorCliConfig: join(temporaryRoot, "cli-config.json"),
        cursorCommands: join(temporaryRoot, "commands"),
        cursorSkills: join(temporaryRoot, "skills"),
        cursorRules: join(temporaryRoot, "rules"),
      } as CursorPaths);
      const resourceId = "cursor-user-file/commands%2Fexample.md";

      const result = await adapter.scan({
        [resourceId]: projection(resourceId, "cursor-user-file"),
      });

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.deletions).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed event changes before adapter dispatch", () => {
    const manifest = validManifest();
    manifest.changes[0]!.resourceId = "chat/not-a-setting";

    expect(() => validateEventManifest(manifest, 1024)).toThrow(
      "invalid resource change",
    );
  });

  it("accepts a syntactically safe future resource kind", () => {
    const manifest = validManifest();
    manifest.changes[0]!.kind = "future-resource";
    manifest.changes[0]!.resourceId = "future-resource/example";

    expect(() => validateEventManifest(manifest, 1024)).not.toThrow();
  });

  it.each([
    "../settings",
    "Settings",
    "-future",
    "future-",
    "future--resource",
    `a${"b".repeat(64)}`,
  ])(
    "rejects malformed wire resource kind %s",
    (kind) => {
      const manifest = validManifest();
      manifest.changes[0]!.kind = kind;
      manifest.changes[0]!.resourceId = `${kind}/example`;

      expect(() => validateEventManifest(manifest, 1024)).toThrow(
        "invalid resource change",
      );
    },
  );

  it("rejects payload references above the configured limit", () => {
    const manifest = validManifest();
    manifest.changes[0] = {
      resourceId: "settings/default/example",
      kind: "settings",
      operation: "put",
      parents: [],
      semanticHash: "a".repeat(64),
      payload: {
        deviceId: "device-a",
        objectId: "b".repeat(64),
        compressedBytes: 2048,
        plainBytes: 2048,
      },
    };

    expect(() => validateEventManifest(manifest, 1024)).toThrow(
      "Object reference is invalid",
    );
  });

  it("rejects malformed producer compatibility metadata", () => {
    const manifest = validManifest();
    manifest.producer = {
      extensionVersion: "",
      cursorVersion: "3.11.19",
      vscodeVersion: "1.125.0",
    };

    expect(() => validateEventManifest(manifest, 1024)).toThrow(
      "producer metadata",
    );
  });
});

describe("canonical JSON security", () => {
  it("preserves an own __proto__ key instead of collapsing its hash input", () => {
    const withPrototypeKey = JSON.parse(
      '{"__proto__":{"enabled":true},"z":1}',
    ) as object;

    expect(canonicalJson(withPrototypeKey)).toBe(
      '{"__proto__":{"enabled":true},"z":1}',
    );
    expect(canonicalJson(withPrototypeKey)).not.toBe(canonicalJson({ z: 1 }));
  });

  it("orders non-ASCII keys by code units instead of the host locale", () => {
    expect(canonicalJson(JSON.parse('{"ä":1,"z":2}') as object)).toBe(
      '{"z":2,"ä":1}',
    );
  });
});

describe("equivalent DAG tips", () => {
  it("uses every equivalent tip as the parent of the next local edit", () => {
    const projection: LocalProjection = {
      resourceId: "settings/default/example",
      kind: "settings",
      semanticHash: "a".repeat(64),
      versionId: `${"1".repeat(64)}#0`,
    };
    const tips = [
      tip("1".repeat(64), "device-a"),
      tip("2".repeat(64), "device-b"),
    ];

    expect(parentsForLocalChange(projection, tips)).toEqual([
      `${"1".repeat(64)}#0`,
      `${"2".repeat(64)}#0`,
    ]);
  });
});

function validManifest(): EventManifest {
  return {
    eventVersion: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    lamport: 1,
    changes: [
      {
        resourceId: "settings/default/example",
        kind: "settings",
        operation: "delete",
        parents: [],
        semanticHash: "a".repeat(64),
      },
    ],
  };
}

function tip(eventHash: string, deviceId: string): ResourceTip {
  return {
    versionId: `${eventHash}#0`,
    eventHash,
    changeIndex: 0,
    kind: "settings",
    lamport: 1,
    deviceId,
    operation: "put",
    semanticHash: "a".repeat(64),
    parents: [],
  };
}

function projection(
  resourceId: string,
  kind: LocalProjection["kind"],
): LocalProjection {
  return {
    resourceId,
    kind,
    semanticHash: "a".repeat(64),
    versionId: `${"1".repeat(64)}#0`,
  };
}
