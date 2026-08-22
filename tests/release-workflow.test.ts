import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};

describe("Cursor-only release workflow", () => {
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
