import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { helperFailureDetail, isHelperResultFileName } from "../src/sync/manager";
import { cursorExitTimeoutDetail } from "../src/platform/compatibility";
import { RESTART_TO_APPLY_TITLE } from "../src/constants";

describe("which files in the storage root are helper results", () => {
  it("ignores the temp file an atomic write leaves behind", () => {
    // `writeFileAtomic` writes `<path>.<pid>.<uuid>.partial` and renames, so the
    // temp file carries the result prefix too. Parsing one is parsing a
    // half-written buffer - which used to reach the user as "activation failed"
    // and nothing else, and now that results are read on every cycle would be
    // a routine hazard rather than a startup-only one.
    expect(
      isHelperResultFileName(
        "helper-result-11111111-1111-4111-8111-111111111111.json.4242.22222222-2222-4222-8222-222222222222.partial",
      ),
    ).toBe(false);
    expect(
      isHelperResultFileName(
        "helper-result-11111111-1111-4111-8111-111111111111.json",
      ),
    ).toBe(true);
    expect(
      isHelperResultFileName(
        "helper-request-11111111-1111-4111-8111-111111111111.json",
      ),
    ).toBe(false);
  });
});

describe("what the user is told when the offline helper fails", () => {
  it("turns an exit-timeout stack into one line that names the retry", () => {
    // `HelperResult.error` is `error.stack ?? error.message`, so this is the
    // literal shape the reported incident produced.
    const detail = helperFailureDetail(
      "CursorExitTimeoutError: Timed out waiting for Cursor to exit. 3 Cursor process(es) are still running (pid 4188).\n" +
        "    at waitForCursorExit (C:\\Users\\x\\.cursor\\extensions\\lch.cursor-setting-sync-0.0.8\\dist\\helper.js:10797:9)\n" +
        "    at async run (helper.js:122:5)",
    );
    expect(detail).not.toContain("\n");
    expect(detail).not.toContain("    at ");
    expect(detail).not.toContain("CursorExitTimeoutError");
    expect(detail).toContain("Timed out waiting for Cursor to exit.");
    expect(detail).toContain("pid 4188");
    expect(detail).toContain(RESTART_TO_APPLY_TITLE);
    expect(detail).toContain("still here");
  });

  it("still names a next step when the helper reported no error at all", () => {
    const detail = helperFailureDetail(null);
    expect(detail).toContain("The offline helper failed.");
    expect(detail).toContain(RESTART_TO_APPLY_TITLE);
  });
});

describe("the exit-timeout explanation", () => {
  it("names the processes that are still running", () => {
    const detail = cursorExitTimeoutDetail([4188, 5120], null);
    expect(detail).toContain("2 Cursor process(es)");
    expect(detail).toContain("4188, 5120");
    expect(detail).toContain("save your changes");
  });

  it("never tells the user to close the extension's own shutdown helper", () => {
    // Killing the finalizer destroys that session's workspaceStorage backup,
    // which is the only one ever taken.
    const detail = cursorExitTimeoutDetail([7777], 7777);
    expect(detail).not.toContain("7777");
    expect(detail).toContain("exits on its own");
  });

  it("says so plainly when the process list could not be read", () => {
    const detail = cursorExitTimeoutDetail(null, null);
    expect(detail).toContain("could not be read");
    expect(detail).not.toMatch(/0 Cursor process/);
  });

  it("tells the user to simply retry when Cursor exited during the last poll", () => {
    const detail = cursorExitTimeoutDetail([], null);
    expect(detail).toContain("has since exited");
  });

  it("caps the pid list instead of printing a wall of helper children", () => {
    // One Cursor window is a dozen processes on every platform.
    const detail = cursorExitTimeoutDetail(
      Array.from({ length: 14 }, (_unused, index) => 5000 + index),
      null,
    );
    expect(detail).toContain("14 Cursor process(es)");
    expect(detail).toContain("and 6 more");
    expect(detail).not.toContain("5013");
  });
});
