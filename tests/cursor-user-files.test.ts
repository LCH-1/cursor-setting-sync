import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CursorPaths } from "../src/platform/paths";
import {
  CursorUserFilesAdapter,
  normalizeIgnoredUserFiles,
} from "../src/resources/cursorUserFiles";
import { sha256 } from "../src/protocol/canonical";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("Cursor user file ignore matching per platform", () => {
  it("folds ignore entries on Windows and macOS but keeps Linux exact", () => {
    expect([...normalizeIgnoredUserFiles(["Rules/Secret.md"], "win32")]).toEqual([
      "rules/secret.md",
    ]);
    expect([...normalizeIgnoredUserFiles(["Rules/Secret.md"], "darwin")]).toEqual([
      "rules/secret.md",
    ]);
    expect([...normalizeIgnoredUserFiles(["Rules/Secret.md"], "linux")]).toEqual([
      "Rules/Secret.md",
    ]);
  });

  it("ignores a scanned file case-insensitively on macOS but not on Linux", async () => {
    const paths = await createCursorHome();
    await writeFile(paths.cursorMcp, "{}\n", "utf8");

    const darwinAdapter = new CursorUserFilesAdapter(
      paths,
      normalizeIgnoredUserFiles(["MCP.JSON"], "darwin"),
      "darwin",
    );
    const darwinResult = await darwinAdapter.scan({});
    expect(darwinResult.snapshots).toEqual([]);
    expect(darwinResult.warnings).toEqual([]);

    const linuxAdapter = new CursorUserFilesAdapter(
      paths,
      normalizeIgnoredUserFiles(["MCP.JSON"], "linux"),
      "linux",
    );
    const linuxResult = await linuxAdapter.scan({});
    expect(
      linuxResult.snapshots.map((snapshot) => snapshot.metadata?.relativePath),
    ).toEqual(["mcp.json"]);
  });

  it("retains ignored files on apply with platform-appropriate folding", async () => {
    const paths = await createCursorHome();
    const ignored = normalizeIgnoredUserFiles(["rules/secret.md"], "linux");
    const linuxAdapter = new CursorUserFilesAdapter(paths, ignored, "linux");

    const retained = await linuxAdapter.apply(applyInput("rules/secret.md"));
    expect(retained).toMatchObject({ status: "retained-local" });

    const written = await linuxAdapter.apply(applyInput("rules/Secret.md"));
    expect(written).toBeUndefined();
    await expect(
      readFile(join(paths.cursorHome, "rules", "Secret.md"), "utf8"),
    ).resolves.toBe("remote");

    const darwinAdapter = new CursorUserFilesAdapter(
      paths,
      normalizeIgnoredUserFiles(["rules/secret.md"], "darwin"),
      "darwin",
    );
    const darwinRetained = await darwinAdapter.apply(applyInput("rules/SECRET.md"));
    expect(darwinRetained).toMatchObject({ status: "retained-local" });
  });
});

function applyInput(relativePath: string): Parameters<
  CursorUserFilesAdapter["apply"]
>[0] {
  const content = Buffer.from("remote", "utf8");
  return {
    resourceId: `cursor-user-file/${encodeURIComponent(relativePath)}`,
    kind: "cursor-user-file",
    content,
    semanticHash: sha256(content),
    metadata: { relativePath },
  };
}

async function createCursorHome(): Promise<CursorPaths> {
  const root = await mkdtemp(join(tmpdir(), "cursor-user-files-test-"));
  temporaryRoots.push(root);
  return {
    cursorHome: root,
    cursorMcp: join(root, "mcp.json"),
    cursorCliConfig: join(root, "cli-config.json"),
    cursorCommands: join(root, "commands"),
    cursorSkills: join(root, "skills"),
    cursorRules: join(root, "rules"),
  } as CursorPaths;
}
