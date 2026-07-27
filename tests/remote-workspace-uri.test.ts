import { describe, expect, it } from "vitest";
import {
  normalizeWorkspaceUri,
  resolveTargetWorkspace,
} from "../src/chat/workspace";

// {"hostName":"geekdive_local2"} — the exact descriptor observed in a real
// workspaceStorage tree alongside the plain alias for the same server.
const DESCRIPTOR =
  "7b22686f73744e616d65223a226765656b646976655f6c6f63616c32227d";
const ALIAS_URI =
  "vscode-remote://ssh-remote%2Bgeekdive_local2/home/ubuntu/servers/linchpinedu/backend";
const DESCRIPTOR_URI = `vscode-remote://ssh-remote%2B${DESCRIPTOR}/home/ubuntu/servers/linchpinedu/backend`;

describe("the two spellings of one SSH host", () => {
  it("normalizes a hex descriptor to the alias it encodes", () => {
    expect(normalizeWorkspaceUri(DESCRIPTOR_URI, "win32")).toBe(
      normalizeWorkspaceUri(ALIAS_URI, "win32"),
    );
    expect(normalizeWorkspaceUri(DESCRIPTOR_URI, "linux")).toBe(
      "vscode-remote://ssh-remote+geekdive_local2/home/ubuntu/servers/linchpinedu/backend",
    );
  });

  it("maps an incoming remote workspace onto the local one on the same server", () => {
    // Without this the two are unrelated workspaces, and every chat written in
    // that folder stops at a mapping prompt with no answerable option.
    const resolved = resolveTargetWorkspace(
      "0c47e4bdcfe11e1ab67090eee8c9baf0",
      DESCRIPTOR_URI,
      [
        {
          id: "3948bfec65c8d5c6c74717f13defe2a1",
          uri: ALIAS_URI,
          basename: "backend",
        },
      ],
      {},
      "win32",
    );
    expect(resolved).toBe("3948bfec65c8d5c6c74717f13defe2a1");
  });

  it("keeps different servers apart", () => {
    // {"hostName":"geekdive_local"} — the other real host, one character off.
    const other =
      "vscode-remote://ssh-remote%2B7b22686f73744e616d65223a226765656b646976655f6c6f63616c227d/home/ubuntu/servers/linchpinedu/backend";
    expect(normalizeWorkspaceUri(other, "win32")).not.toBe(
      normalizeWorkspaceUri(ALIAS_URI, "win32"),
    );
  });

  it("leaves an alias that merely looks like hex alone", () => {
    // "abc123" decodes to bytes that are not JSON, so only a successful parse
    // may rewrite the authority.
    const hexish =
      "vscode-remote://ssh-remote%2Babc123/home/ubuntu/servers/app";
    expect(normalizeWorkspaceUri(hexish, "linux")).toBe(
      "vscode-remote://ssh-remote+abc123/home/ubuntu/servers/app",
    );
  });

  it("leaves a descriptor with no hostName alone", () => {
    // {"port":22} — valid JSON, nothing to substitute.
    const noHost = "vscode-remote://ssh-remote%2B7b22706f7274223a32327d/home/x";
    expect(normalizeWorkspaceUri(noHost, "linux")).toBe(
      "vscode-remote://ssh-remote+7b22706f7274223a32327d/home/x",
    );
  });

  it("leaves local file URIs untouched", () => {
    expect(
      normalizeWorkspaceUri(
        "file:///c%3A/Users/ckdgh/Desktop/projects/cursor-setting-sync",
        "win32",
      ),
    ).toBe("file:///c:/users/ckdgh/desktop/projects/cursor-setting-sync");
  });
});
