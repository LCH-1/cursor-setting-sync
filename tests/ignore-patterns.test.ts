import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  combineIgnoreMatchers,
  createIgnoreMatcher,
  EMPTY_IGNORE_MATCHER,
} from "../src/resources/ignorePatterns";
import { normalizeIgnoredUserFiles } from "../src/resources/cursorUserFiles";
import { normalizeIgnoredUiStateKeys } from "../src/resources/uiStatePolicy";
import {
  DEFAULT_IGNORED_SETTINGS,
  SettingsAdapter,
  createSettingsIgnoreMatcher,
} from "../src/resources/settings";
import { createExtensionIgnoreMatcher } from "../src/resources/extensions";
import { standingWarningDiagnostics } from "../src/sync/warningLog";
import type { CursorPaths } from "../src/platform/paths";
import type { LocalProjection } from "../src/types";

describe("shared ignore patterns", () => {
  it("keeps exact entries matching exactly", () => {
    const matcher = createIgnoreMatcher(["editor.fontSize"]);

    expect(matcher.matches("editor.fontSize")).toBe(true);
    expect(matcher.matches("editor.fontSizeScale")).toBe(false);
    expect(matcher.matches("editor")).toBe(false);
  });

  it("treats an empty list as matching nothing", () => {
    const matcher = createIgnoreMatcher([]);

    expect(matcher.patterns).toEqual([]);
    expect(matcher.matches("anything")).toBe(false);
    expect(matcher.unmatched(["anything"])).toEqual([]);
  });

  it("expands a trailing star over the rest of a dotted key", () => {
    const matcher = createIgnoreMatcher(["remote.SSH.*"]);

    expect(matcher.matches("remote.SSH.configFile")).toBe(true);
    expect(matcher.matches("remote.SSH.serverInstallPath.host")).toBe(true);
    expect(matcher.matches("remote.SSH")).toBe(false);
    expect(matcher.matches("remote.WSL.configFile")).toBe(false);
  });

  it("anchors a wildcard at both ends", () => {
    const matcher = createIgnoreMatcher(["http.proxy*"]);

    expect(matcher.matches("http.proxy")).toBe(true);
    expect(matcher.matches("http.proxyStrictSSL")).toBe(true);
    expect(matcher.matches("my.http.proxy")).toBe(false);
  });

  it("escapes regular-expression metacharacters in an entry", () => {
    const matcher = createIgnoreMatcher(["a+b.c*"]);

    expect(matcher.matches("a+b.cd")).toBe(true);
    expect(matcher.matches("aab.cd")).toBe(false);
  });

  it("stops a single star at the separator in a path list", () => {
    const matcher = createIgnoreMatcher(["rules/*.md"], { separator: "/" });

    expect(matcher.matches("rules/private.md")).toBe(true);
    expect(matcher.matches("rules/team/private.md")).toBe(false);
    expect(matcher.matches("commands/private.md")).toBe(false);
  });

  it("crosses separators for a double star, including zero directories", () => {
    const matcher = createIgnoreMatcher(["skills/**/secret.md"], {
      separator: "/",
    });

    expect(matcher.matches("skills/secret.md")).toBe(true);
    expect(matcher.matches("skills/a/secret.md")).toBe(true);
    expect(matcher.matches("skills/a/b/secret.md")).toBe(true);
    expect(matcher.matches("rules/secret.md")).toBe(false);
  });

  it("matches zero directories for a leading double star", () => {
    // gitignore and VS Code globs both read "**/x" as "x at any depth,
    // including the top level"; compiled naively it became "anything, then a
    // separator", which never matched the top-level file the user meant.
    const matcher = createIgnoreMatcher(["**/secret.md"], { separator: "/" });

    expect(matcher.matches("secret.md")).toBe(true);
    expect(matcher.matches("a/secret.md")).toBe(true);
    expect(matcher.matches("a/b/secret.md")).toBe(true);
    expect(matcher.matches("visible.md")).toBe(false);
  });

  it("treats a wildcard-free path entry as the whole directory", () => {
    const matcher = createIgnoreMatcher(["rules", "mcp.json"], {
      separator: "/",
    });

    expect(matcher.matches("rules")).toBe(true);
    expect(matcher.matches("rules/private.md")).toBe(true);
    expect(matcher.matches("rules/team/private.md")).toBe(true);
    expect(matcher.matches("rulesets/private.md")).toBe(false);
    expect(matcher.matches("mcp.json")).toBe(true);
  });

  it("normalizes a trailing slash and folds case when asked", () => {
    const matcher = createIgnoreMatcher(["Rules/"], {
      separator: "/",
      caseFold: true,
    });

    expect(matcher.patterns).toEqual(["rules"]);
    expect(matcher.matches("rules/secret.md")).toBe(true);
  });

  it("reports entries that matched nothing", () => {
    const matcher = createIgnoreMatcher(["rules/", "typo/**"], {
      separator: "/",
    });

    expect(matcher.unmatched(["rules/a.md", "commands/b.md"])).toEqual([
      "typo/**",
    ]);
  });

  it("unions matchers without losing either side", () => {
    const combined = combineIgnoreMatchers(
      createIgnoreMatcher(["a.*"]),
      createIgnoreMatcher(["b.one"]),
    );

    expect(combined.matches("a.two")).toBe(true);
    expect(combined.matches("b.one")).toBe(true);
    expect(combined.matches("c.one")).toBe(false);
    expect(combined.patterns).toEqual(["a.*", "b.one"]);
  });
});

describe("ignore matchers wired into the adapters", () => {
  it("matches user files by directory, glob and exact path", () => {
    const matcher = normalizeIgnoredUserFiles(
      ["rules/", "skills/*.md", "mcp.json"],
      "linux",
    );

    expect(matcher.matches("rules/private.md")).toBe(true);
    expect(matcher.matches("skills/one.md")).toBe(true);
    expect(matcher.matches("skills/one/SKILL.md")).toBe(false);
    expect(matcher.matches("mcp.json")).toBe(true);
    expect(matcher.matches("cli-config.json")).toBe(false);
  });

  it("accepts a Windows-style separator in a user-file entry", () => {
    const matcher = normalizeIgnoredUserFiles(["rules\\private.md"], "linux");

    expect(matcher.matches("rules/private.md")).toBe(true);
  });

  it("matches extension identifiers case-insensitively with wildcards", () => {
    const matcher = createExtensionIgnoreMatcher(["MS-Python.*", "Foo.Bar"]);

    expect(matcher.matches("ms-python.python")).toBe(true);
    expect(matcher.matches("foo.bar")).toBe(true);
    expect(matcher.matches("other.extension")).toBe(false);
  });

  it("matches UI state keys by prefix glob", () => {
    const matcher = normalizeIgnoredUiStateKeys(["workbench.panel.*"]);

    expect(matcher.matches("workbench.panel.aichat.hidden")).toBe(true);
    expect(matcher.matches("workbench.activity.pinnedViewlets2")).toBe(false);
  });
});

describe("default machine-specific settings", () => {
  const matcher = createSettingsIgnoreMatcher([...DEFAULT_IGNORED_SETTINGS]);

  it("excludes the workbench-registered keys extension scanning cannot see", () => {
    for (const key of [
      "window.zoomLevel",
      "terminal.integrated.defaultProfile.windows",
      "http.proxy",
      "http.proxyStrictSSL",
      "remote.SSH.configFile",
      "git.path",
    ]) {
      expect(matcher.matches(key)).toBe(true);
    }
  });

  it("leaves ordinary preferences alone", () => {
    for (const key of [
      "editor.fontSize",
      "workbench.colorTheme",
      "terminal.integrated.fontSize",
      "http.experimental.somethingElse",
    ]) {
      expect(matcher.matches(key)).toBe(false);
    }
  });

  it("does not take over keys VS Code Settings Sync itself propagates", () => {
    // These are application/window-scoped preferences in VS Code's own
    // registry, so excluding them stopped keys travelling that the user
    // already expected to travel.
    for (const key of [
      "terminal.integrated.profiles.windows",
      "terminal.integrated.env.linux",
      "files.simpleDialog.enable",
      "python.venvPath",
    ]) {
      expect(matcher.matches(key)).toBe(false);
    }
  });
});

describe("settings keys the built-in defaults took over", () => {
  const temporaryRoots: string[] = [];

  afterAll(async () => {
    for (const root of temporaryRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const projection = (key: string): LocalProjection => ({
    resourceId: `settings/default/${encodeURIComponent(key)}`,
    kind: "settings",
    semanticHash: "a".repeat(64),
    versionId: "v1",
  });

  async function scanWith(
    settings: Record<string, unknown>,
    known: Record<string, LocalProjection>,
  ): Promise<string[]> {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-defaults-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify(settings, null, 2),
      "utf8",
    );
    const adapter = new SettingsAdapter(
      { userDataRoot: root, profilesRoot: join(root, "profiles") } as CursorPaths,
      EMPTY_IGNORE_MATCHER,
      createSettingsIgnoreMatcher([...DEFAULT_IGNORED_SETTINGS]),
      createSettingsIgnoreMatcher([...DEFAULT_IGNORED_SETTINGS]),
    );
    const result = await adapter.scan(known);
    // A key the built-in defaults took over is a deliberate exclusion, not a
    // failure to save it.
    expect(result.warnings).toEqual([]);
    return result.notices ?? [];
  }

  it("names every previously synchronized key an upgrade newly excluded", async () => {
    const warnings = await scanWith(
      {
        "editor.fontSize": 14,
        "window.zoomLevel": 1,
        "terminal.integrated.defaultProfile.windows": "Git Bash",
      },
      {
        ...Object.fromEntries([
          [
            projection("window.zoomLevel").resourceId,
            projection("window.zoomLevel"),
          ],
          [
            projection("terminal.integrated.defaultProfile.windows").resourceId,
            projection("terminal.integrated.defaultProfile.windows"),
          ],
        ]),
      },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("terminal.integrated.defaultProfile.windows");
    expect(warnings[0]).toContain("window.zoomLevel");
    expect(warnings[0]).toContain("useDefaultIgnoredSettings");
  });

  it("stays silent for keys this device never synchronized", async () => {
    const warnings = await scanWith(
      { "editor.fontSize": 14, "window.zoomLevel": 1 },
      {},
    );

    expect(warnings).toEqual([]);
  });

  it("surfaces the notice in Show Diagnostics", () => {
    const warnings = standingWarningDiagnostics(
      [
        {
          source: "settings",
          warning:
            "Built-in machine-specific defaults now exclude settings keys this device had already synchronized: window.zoomLevel.",
          firstSeenAt: 1_000,
          lastSeenAt: 1_000,
          lastLoggedAt: 1_000,
          observations: 1,
        },
      ],
      2_000,
    );

    expect(warnings[0]?.source).toBe("settings");
    expect(warnings[0]?.warning).toContain("window.zoomLevel");
  });
});
