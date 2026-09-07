import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCursorPaths, resolveUserDataRoot } from "../src/platform/paths";

function contextFor(userDataRoot: string): Parameters<typeof resolveCursorPaths>[0] {
  return {
    globalStorageUri: {
      fsPath: join(userDataRoot, "globalStorage", "lch.cursor-setting-sync"),
    },
    extensionPath: join("install-root", "extension"),
  } as Parameters<typeof resolveCursorPaths>[0];
}

describe("Cursor user data root per platform", () => {
  it("uses APPDATA on Windows", () => {
    expect(
      resolveUserDataRoot({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      }),
    ).toBe(join("C:\\Users\\u\\AppData\\Roaming", "Cursor", "User"));
  });

  it("requires APPDATA on Windows", () => {
    expect(() => resolveUserDataRoot({ platform: "win32", env: {} })).toThrow(
      /APPDATA/,
    );
    expect(() =>
      resolveUserDataRoot({ platform: "win32", env: { APPDATA: "" } }),
    ).toThrow(/APPDATA/);
  });

  it("uses Application Support on macOS", () => {
    expect(
      resolveUserDataRoot({ platform: "darwin", env: {}, home: "/Users/u" }),
    ).toBe(join("/Users/u", "Library", "Application Support", "Cursor", "User"));
  });

  it("prefers XDG_CONFIG_HOME on Linux", () => {
    expect(
      resolveUserDataRoot({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/xdg/config" },
        home: "/home/u",
      }),
    ).toBe(join("/xdg/config", "Cursor", "User"));
  });

  it("falls back to ~/.config on Linux", () => {
    for (const env of [{}, { XDG_CONFIG_HOME: "" }]) {
      expect(
        resolveUserDataRoot({ platform: "linux", env, home: "/home/u" }),
      ).toBe(join("/home/u", ".config", "Cursor", "User"));
    }
  });

  it("requires a home directory on POSIX platforms", () => {
    expect(() =>
      resolveUserDataRoot({ platform: "linux", env: {}, home: "" }),
    ).toThrow(/home directory/i);
  });
});

describe("resolveCursorPaths per platform", () => {
  it("derives every path from the platform user data root and home", () => {
    const userDataRoot = join("/home/u", ".config", "Cursor", "User");
    const context = contextFor(userDataRoot);
    const paths = resolveCursorPaths(context, "/app/root", {
      platform: "linux",
      env: {},
      home: "/home/u",
    });
    expect(paths.appRoot).toBe("/app/root");
    expect(paths.userDataRoot).toBe(userDataRoot);
    expect(paths.globalDatabase).toBe(
      join(userDataRoot, "globalStorage", "state.vscdb"),
    );
    expect(paths.workspaceStorageRoot).toBe(join(userDataRoot, "workspaceStorage"));
    expect(paths.cursorHome).toBe(join("/home/u", ".cursor"));
    expect(paths.cursorMcp).toBe(join("/home/u", ".cursor", "mcp.json"));
    expect(paths.extensionStorage).toBe(context.globalStorageUri.fsPath);
    expect(paths.helperScript).toBe(
      join("install-root", "extension", "dist", "helper.js"),
    );
  });

  it("keeps cursorHome under the injected home on macOS", () => {
    const paths = resolveCursorPaths(contextFor(
      join("/Users/u", "Library", "Application Support", "Cursor", "User"),
    ), "/app/root", {
      platform: "darwin",
      env: {},
      home: "/Users/u",
    });

    expect(paths.userDataRoot).toBe(
      join("/Users/u", "Library", "Application Support", "Cursor", "User"),
    );
    expect(paths.cursorHome).toBe(join("/Users/u", ".cursor"));
  });

  it("uses a custom Windows user data directory instead of the default profile", () => {
    const userDataRoot = join("C:\\isolated cursor data", "User");
    const paths = resolveCursorPaths(contextFor(userDataRoot), "C:\\Cursor\\app", {
      platform: "win32",
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      home: "C:\\Users\\u",
    });

    expect(paths.userDataRoot).toBe(userDataRoot);
    expect(paths.globalDatabase).toBe(join(userDataRoot, "globalStorage", "state.vscdb"));
    expect(paths.workspaceStorageRoot).toBe(join(userDataRoot, "workspaceStorage"));
    expect(paths.profilesRoot).toBe(join(userDataRoot, "profiles"));
    expect(paths.userTasks).toBe(join(userDataRoot, "tasks.json"));
    expect(paths.cursorHome).toBe(join("C:\\Users\\u", ".cursor"));
  });

  it("isolates portable Cursor state without needing the default platform path", () => {
    const userDataRoot = join("portable-install", "data", "user-data", "User");
    const paths = resolveCursorPaths(contextFor(userDataRoot), "portable-install/app", {
      platform: "win32",
      env: {},
      home: "portable-home",
    });

    expect(paths.userDataRoot).toBe(userDataRoot);
    expect(paths.globalStorageRoot).toBe(join(userDataRoot, "globalStorage"));
    expect(paths.snippetsRoot).toBe(join(userDataRoot, "snippets"));
    expect(paths.extensionStorage).toBe(contextFor(userDataRoot).globalStorageUri.fsPath);
  });

  it("keeps separate Cursor user data directories on separate databases and locks", () => {
    const first = resolveCursorPaths(contextFor(join("first", "User")), "app");
    const second = resolveCursorPaths(contextFor(join("second", "User")), "app");

    expect(first.globalDatabase).not.toBe(second.globalDatabase);
    expect(first.workspaceStorageRoot).not.toBe(second.workspaceStorageRoot);
    expect(first.extensionStorage).not.toBe(second.extensionStorage);
    expect(first.cursorHome).toBe(second.cursorHome);
  });
});
