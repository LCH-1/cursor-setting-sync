import { describe, expect, it } from "vitest";
import { isIgnoredWorkspaceUri } from "../src/resources/workspaceStorage";
import { createIgnoreMatcher } from "../src/resources/ignorePatterns";
import manifest from "../package.json";

const LOCAL = "file:///c%3A/Users/ckdgh/Desktop/projects/cursor-setting-sync";
const REMOTE =
  "vscode-remote://ssh-remote%2Bgeekdive_local2/home/ubuntu/servers/linchpinedu/backend";

describe("cursorSettingSync.ignoredWorkspaces", () => {
  it('keeps only Remote-SSH workspaces when set to ["file://*"]', () => {
    // The documented recipe: a local folder path exists on exactly one
    // computer, so its incoming storage can only ever sit in the queue asking
    // to be mapped to something that is not there.
    const matcher = createIgnoreMatcher(["file://*"]);
    expect(isIgnoredWorkspaceUri(LOCAL, matcher)).toBe(true);
    expect(isIgnoredWorkspaceUri(REMOTE, matcher)).toBe(false);
  });

  it("matches a percent-encoded URI against a readable pattern", () => {
    // Cursor stores `file:///c%3A/...`; a user writing a path pattern writes
    // the decoded form, and being right only in one spelling is a trap.
    const matcher = createIgnoreMatcher(["file:///c:/Users/ckdgh/Desktop/*"]);
    expect(isIgnoredWorkspaceUri(LOCAL, matcher)).toBe(true);
  });

  it("excludes one server without touching the others", () => {
    const matcher = createIgnoreMatcher([
      "vscode-remote://ssh-remote+geekdive_local2/*",
    ]);
    expect(isIgnoredWorkspaceUri(REMOTE, matcher)).toBe(true);
    expect(
      isIgnoredWorkspaceUri(
        "vscode-remote://ssh-remote%2Bmove-dev/home/ubuntu/app",
        matcher,
      ),
    ).toBe(false);
  });

  it("never excludes a workspace whose URI is unknown", () => {
    // The pattern would be matched against nothing, and dropping a backup on
    // the strength of missing metadata is the wrong way to fail.
    const matcher = createIgnoreMatcher(["file://*", "*"]);
    expect(isIgnoredWorkspaceUri(null, matcher)).toBe(false);
    expect(isIgnoredWorkspaceUri(undefined, matcher)).toBe(false);
    expect(isIgnoredWorkspaceUri("", matcher)).toBe(false);
  });

  it("excludes nothing when the list is empty", () => {
    const matcher = createIgnoreMatcher([]);
    expect(isIgnoredWorkspaceUri(LOCAL, matcher)).toBe(false);
    expect(isIgnoredWorkspaceUri(REMOTE, matcher)).toBe(false);
  });

  it("is machine-scoped so curating one computer cannot switch off the other", () => {
    // Every other cursorSettingSync.* key travels with the settings this
    // extension synchronizes, so a window-scoped list would propagate.
    const property =
      manifest.contributes.configuration.properties[
        "cursorSettingSync.ignoredWorkspaces"
      ];
    expect(property?.scope).toBe("machine");
    expect(property?.default).toEqual([]);
  });
});
