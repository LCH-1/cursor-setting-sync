import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_IGNORED_SETTINGS,
  SettingsAdapter,
  createSettingsIgnoreMatcher,
} from "../src/resources/settings";
import { EMPTY_IGNORE_MATCHER } from "../src/resources/ignorePatterns";
import { parseJsonc } from "../src/resources/jsonc";
import { sha256 } from "../src/protocol/canonical";
import type { CursorPaths } from "../src/platform/paths";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(source: string): Promise<{
  adapter: SettingsAdapter;
  settingsPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-settings-dup-"));
  temporaryRoots.push(root);
  await mkdir(root, { recursive: true });
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, source, "utf8");
  const adapter = new SettingsAdapter(
    { userDataRoot: root, profilesRoot: join(root, "profiles") } as CursorPaths,
    EMPTY_IGNORE_MATCHER,
    createSettingsIgnoreMatcher([...DEFAULT_IGNORED_SETTINGS]),
    createSettingsIgnoreMatcher([...DEFAULT_IGNORED_SETTINGS]),
  );
  return { adapter, settingsPath };
}

function putInput(key: string, value: unknown): Parameters<SettingsAdapter["apply"]>[0] {
  const content = Buffer.from(JSON.stringify(value), "utf8");
  return {
    resourceId: `settings/default/${encodeURIComponent(key)}`,
    kind: "settings",
    content,
    semanticHash: sha256(content),
    metadata: { profileId: "default", key },
  };
}

function deleteInput(key: string): Parameters<SettingsAdapter["apply"]>[0] {
  return {
    resourceId: `settings/default/${encodeURIComponent(key)}`,
    kind: "settings",
    semanticHash: sha256(`deleted:settings/default/${encodeURIComponent(key)}`),
    metadata: { profileId: "default", key },
  };
}

describe("settings apply with duplicated top-level keys", () => {
  // VS Code tolerates a duplicated key with only an editor squiggle, but
  // jsonc-parser reads the LAST occurrence while modify() edits the FIRST -
  // one edit used to leave the file re-parsing to the old value, silently
  // reverting the remote change on the machine where the user typed it, then
  // republishing the reversion: a permanent per-key revert loop.
  it("a put lands even when the key is duplicated", async () => {
    const { adapter, settingsPath } = await fixture(
      '{\n  "editor.fontSize": 12,\n  "editor.fontSize": 14\n}\n',
    );

    await adapter.apply(putInput("editor.fontSize", 16));

    const parsed = parseJsonc(
      (await readFile(settingsPath, "utf8")),
      settingsPath,
    ) as Record<string, unknown>;
    expect(parsed["editor.fontSize"]).toBe(16);
  });

  it("a delete removes every duplicate instead of resurrecting the survivor", async () => {
    const { adapter, settingsPath } = await fixture(
      '{\n  "editor.fontSize": 12,\n  "editor.fontSize": 14,\n  "editor.tabSize": 2\n}\n',
    );

    await adapter.apply(deleteInput("editor.fontSize"));

    const parsed = parseJsonc(
      (await readFile(settingsPath, "utf8")),
      settingsPath,
    ) as Record<string, unknown>;
    expect(parsed["editor.fontSize"]).toBeUndefined();
    expect(parsed["editor.tabSize"]).toBe(2);
  });
});
