import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProfileFilesAdapter } from "../src/resources/profileFiles";
import type { CursorPaths } from "../src/platform/paths";
import type { LocalProjection } from "../src/types";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("profile-files additive streaming deletion policy", () => {
  it("does not tombstone a vanished profile or a file absent from a bounded page", async () => {
    // Deleting a profile on one machine removed User/profiles/<id>, and the
    // next scan tombstoned every keybinding, snippet, task and prompt file
    // that profile ever had - peers then unlinked them live, with no backup.
    // settings.ts and extensions.ts always had the scanned-profile guard;
    // this pins that profileFiles has it too.
    const root = await mkdtemp(join(tmpdir(), "cursor-profile-del-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "profiles"), { recursive: true });
    // The default profile has one live keybindings file.
    await writeFile(join(root, "keybindings.json"), "[]\n", "utf8");
    const paths = {
      userDataRoot: root,
      profilesRoot: join(root, "profiles"),
    } as CursorPaths;
    const known: Record<string, LocalProjection> = {
      // A projection from the deleted "work" profile: its directory no
      // longer exists, so discovery never sees it.
      ["keybindings/work/keybindings.json"]: {
        resourceId: "keybindings/work/keybindings.json",
        kind: "keybindings",
        semanticHash: "h1",
        versionId: "e#0",
      },
      // A projection whose FILE is gone from a profile that still exists.
      // Streaming pages deliberately retain no whole-tree identity set, so
      // absence here cannot be distinguished from an unvisited later page.
      ["keybindings/default/keybindings.json"]: {
        resourceId: "keybindings/default/keybindings.json",
        kind: "keybindings",
        semanticHash: "h2",
        versionId: "e#1",
      },
      ["snippet/default/removed.code-snippets"]: {
        resourceId: "snippet/default/removed.code-snippets",
        kind: "snippet",
        semanticHash: "h3",
        versionId: "e#2",
      },
    };

    const result = await new ProfileFilesAdapter(paths).scan(known);

    const deleted = result.deletions.map((deletion) => deletion.resourceId);
    // Both are retained. Existing remote tombstones are still understood on
    // apply, but this bounded scanner never invents a destructive one without
    // a stable whole-tree proof.
    expect(deleted).not.toContain("keybindings/work/keybindings.json");
    expect(deleted).not.toContain("snippet/default/removed.code-snippets");
  });
});
