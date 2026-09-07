import { join, resolve } from "node:path";
import type * as ChildProcessApi from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HelperRequest } from "../src/helper/types";
import { resolveCursorPaths } from "../src/platform/paths";

const { spawn, unref } = vi.hoisted(() => {
  const unref = vi.fn();
  return { spawn: vi.fn(() => ({ unref })), unref };
});

vi.mock("node:child_process", async () => ({
  ...await vi.importActual<typeof ChildProcessApi>("node:child_process"),
  spawn,
}));
vi.mock("vscode", () => ({ window: {}, extensions: { all: [] } }));

import { __testing } from "../src/helper/main";

afterEach(() => {
  vi.clearAllMocks();
});

describe("helper restarts in the same Cursor user data directory", () => {
  it.each(["default-data", "custom data with spaces"])(
    "passes the request's %s directory to the spawned Cursor",
    (directoryName) => {
      const dataDirectory = resolve("test-data", directoryName);
      const context = {
        globalStorageUri: {
          fsPath: join(dataDirectory, "User", "globalStorage", "lch.cursor-setting-sync"),
        },
        extensionPath: resolve("extension-install"),
      } as Parameters<typeof resolveCursorPaths>[0];
      const paths = resolveCursorPaths(context, resolve("cursor-app"));
      const request = { cursorExecutable: process.execPath, paths } as HelperRequest;

      __testing.restartCursor(request);

      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        ["--user-data-dir", dataDirectory],
        expect.objectContaining({
          detached: true,
          stdio: "ignore",
        }),
      );
      expect(unref).toHaveBeenCalledOnce();
    },
  );
});
