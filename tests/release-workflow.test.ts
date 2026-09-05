import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};

describe("Cursor-only release workflow", () => {
  it("packages only distributable assets and public documentation", async () => {
    const vsce = createRequire(resolve("package.json"))("@vscode/vsce/out/package") as {
      listFiles(options: { cwd: string; dependencies: boolean }): Promise<string[]>;
    };
    const files = await vsce.listFiles({ cwd: process.cwd(), dependencies: false });
    const publicFiles = new Set([
      "package.json", "README.md", "README.ko.md", "CHANGELOG.md", "LICENSE",
      "THIRD_PARTY_NOTICES.md", "icon.png", "dist/extension.js", "dist/helper.js",
      "docs/usage.md", "docs/security.md", "docs/protocol.md", "docs/compatibility.md",
    ]);
    expect(files.filter((file) => !publicFiles.has(file))).toEqual([]);
    expect(files).toContain("package.json");
    expect(files).toContain("docs/usage.md");
  }, 20_000);

  it("publishes the verified artifact only to Open VSX before GitHub Release", () => {
    expect(workflow).toContain("publish-open-vsx:");
    expect(workflow).toContain("Publish to Open VSX (Cursor)");
    expect(workflow).toContain("secrets.OPEN_VSX_TOKEN");

    expect(workflow).not.toContain("publish-vscode-marketplace");
    expect(workflow).not.toContain("VS_MARKETPLACE_TOKEN");
    expect(workflow).not.toContain("marketplace.visualstudio.com");
    expect(workflow).not.toContain("Visual Studio Marketplace");
    expect(workflow).not.toContain("VS Code Marketplace");

    const githubRelease = workflow.slice(workflow.indexOf("  github-release:"));
    expect(githubRelease).toContain("- publish-open-vsx");
    expect(githubRelease).not.toContain("publish-vscode-marketplace");
    expect(githubRelease).toContain("CHANGELOG.md");
    expect(githubRelease).not.toContain("First stable release");
  });

  it("keeps packaging and Open VSX publication without VS Marketplace scripts", () => {
    expect(manifest.scripts?.package).toContain("vsce package");
    expect(manifest.scripts?.["ovsx:publish"]).toContain("ovsx publish");

    expect(manifest.scripts).not.toHaveProperty("publish");
    expect(manifest.scripts).not.toHaveProperty("publish:patch");
    expect(manifest.scripts).not.toHaveProperty("publish:minor");
    expect(manifest.scripts).not.toHaveProperty("publish:major");
  });
});
