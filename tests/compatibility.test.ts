import { describe, expect, it } from "vitest";
import {
  compareVersions,
  cursorExecutableForRestart,
  cursorLaunchCommand,
  databaseApplyBlockReason,
  isDatabaseBackedKind,
  isExpectedCursorExecutable,
  parseCursorProcessIds,
} from "../src/platform/compatibility";
import type { CompatibilityReport, EventProducer } from "../src/types";
import { shouldPublishSnapshot } from "../src/sync/versionPolicy";
import { resourceConfigurationBlockReason } from "../src/sync/resourcePolicy";

describe("cross-version synchronization policy", () => {
  it("allows older database data to move to a newer installation", () => {
    expect(
      databaseApplyBlockReason(
        "chat",
        producer("0.0.1", "3.10.2", "1.124.0"),
        report("0.0.2", "3.11.19", "1.125.0"),
      ),
    ).toBeNull();
  });

  it("defers newer Cursor database data on an older installation", () => {
    expect(
      databaseApplyBlockReason(
        "ui-state",
        producer("0.0.1", "3.12.0", "1.126.0"),
        report("0.0.1", "3.11.19", "1.125.0"),
      ),
    ).toContain("newer Cursor 3.12.0");
  });

  it("defers database data produced by a newer extension", () => {
    expect(
      databaseApplyBlockReason(
        "profile",
        producer("0.1.0", "3.11.19", "1.125.0"),
        report("0.0.1", "3.11.19", "1.125.0"),
      ),
    ).toContain("newer extension 0.1.0");
  });

  it("keeps file resources bidirectional across versions", () => {
    expect(isDatabaseBackedKind("settings")).toBe(false);
    expect(
      databaseApplyBlockReason(
        "settings",
        producer("9.0.0", "9.0.0", "9.0.0"),
        report("0.0.1", "3.11.19", "1.125.0"),
      ),
    ).toBeNull();
  });

  it.each(["chat", "chat-transcript", "chat-store"] as const)(
    "defers %s before adapter dispatch when chat synchronization is disabled",
    (kind) => {
      expect(
        resourceConfigurationBlockReason(kind, {
          syncChat: false,
          syncWorkspaceStorage: true,
        }),
      ).toContain("disabled");
      expect(
        resourceConfigurationBlockReason(kind, {
          syncChat: true,
          syncWorkspaceStorage: true,
        }),
      ).toBeNull();
    },
  );

  it("defers workspace storage only while its option is disabled", () => {
    expect(
      resourceConfigurationBlockReason("workspace-storage", {
        syncChat: true,
        syncWorkspaceStorage: false,
      }),
    ).toContain("disabled");
    expect(
      resourceConfigurationBlockReason("workspace-storage", {
        syncChat: true,
        syncWorkspaceStorage: true,
      }),
    ).toBeNull();
  });

  it("compares numeric versions without lexicographic mistakes", () => {
    expect(compareVersions("3.9.10", "3.10.0")).toBe(-1);
    expect(compareVersions("v24.0.0", "24.0")).toBe(0);
    expect(compareVersions("unknown", "3.11.0")).toBeNull();
  });

  it("does not republish an unchanged old local value over a deferred newer tip", () => {
    const projection = {
      resourceId: "chat/example",
      kind: "chat" as const,
      semanticHash: "a".repeat(64),
      versionId: `${"1".repeat(64)}#0`,
    };
    const snapshot = {
      resourceId: projection.resourceId,
      kind: projection.kind,
      content: Buffer.from("old local value"),
      semanticHash: projection.semanticHash,
    };
    const remoteTip = {
      versionId: `${"2".repeat(64)}#0`,
      eventHash: "2".repeat(64),
      changeIndex: 0,
      kind: projection.kind,
      lamport: 2,
      deviceId: "newer-device",
      operation: "put" as const,
      semanticHash: "b".repeat(64),
      parents: [projection.versionId],
      producer: producer("0.0.2", "3.12.0", "1.126.0"),
    };

    expect(shouldPublishSnapshot(projection, snapshot, [remoteTip])).toBe(false);
    expect(
      shouldPublishSnapshot(
        projection,
        { ...snapshot, semanticHash: "c".repeat(64) },
        [remoteTip],
      ),
    ).toBe(true);
  });
});

describe("platform-specific Cursor process handling", () => {
  it("recognizes the expected extension host executable per platform", () => {
    expect(isExpectedCursorExecutable("C:\\Apps\\CURSOR.EXE", "win32")).toBe(true);
    expect(isExpectedCursorExecutable("C:\\Apps\\node.exe", "win32")).toBe(false);
    expect(
      isExpectedCursorExecutable(
        "/Applications/Cursor.app/Contents/MacOS/Cursor",
        "darwin",
      ),
    ).toBe(true);
    expect(isExpectedCursorExecutable("/usr/local/bin/cursor", "darwin")).toBe(
      false,
    );
    expect(isExpectedCursorExecutable("/usr/share/cursor/cursor", "linux")).toBe(
      true,
    );
    expect(
      isExpectedCursorExecutable("/opt/Cursor-1.2.3-x86_64.AppImage", "linux"),
    ).toBe(true);
    expect(isExpectedCursorExecutable("/usr/share/cursor/Cursor", "linux")).toBe(
      false,
    );
  });

  it("parses tasklist output on Windows", () => {
    const output = [
      '"Cursor.exe","4120","Console","1","215,132 K"',
      '"cursor.EXE","4188","Console","1","88,004 K"',
      '"node.exe","5000","Console","1","10,000 K"',
      "INFO: No tasks are running which match the specified criteria.",
    ].join("\r\n");

    expect(parseCursorProcessIds(output, "win32")).toEqual([4120, 4188]);
  });

  it("parses ps output on macOS including the Cursor helper processes", () => {
    const output = [
      "    1 /sbin/launchd",
      "  845 /Applications/Cursor.app/Contents/MacOS/Cursor",
      "  846 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app/Contents/MacOS/Cursor Helper (Renderer)",
      "  901 /usr/bin/ps",
      "not a process line",
      "",
    ].join("\n");

    // Helpers keep state.vscdb open, so the exclusivity gate must see them.
    expect(parseCursorProcessIds(output, "darwin")).toEqual([845, 846]);
  });

  it("accepts the macOS plugin host as the extension host executable", () => {
    expect(
      isExpectedCursorExecutable(
        "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)",
        "darwin",
      ),
    ).toBe(true);
  });

  it("parses ps output on Linux including AppImage names", () => {
    const output = [
      "    1 systemd",
      "  512 cursor",
      "  513 /usr/share/cursor/cursor",
      "  600 Cursor-1.2.3-x86_64.AppImage",
      "  601 code",
      "  abc broken",
    ].join("\n");

    expect(parseCursorProcessIds(output, "linux")).toEqual([512, 513, 600]);
  });

  it("relaunches a macOS bundle through open -a", () => {
    expect(
      cursorLaunchCommand("/Applications/Cursor.app/Contents/MacOS/Cursor", "darwin"),
    ).toEqual({ command: "open", args: ["-a", "/Applications/Cursor.app"] });
    expect(
      cursorLaunchCommand(
        "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)",
        "darwin",
      ),
    ).toEqual({ command: "open", args: ["-a", "/Applications/Cursor.app"] });
    expect(cursorLaunchCommand("/usr/local/bin/cursor", "darwin")).toEqual({
      command: "/usr/local/bin/cursor",
      args: [],
    });
  });

  it("spawns the executable directly on Windows and Linux", () => {
    expect(cursorLaunchCommand("C:\\Apps\\Cursor.exe", "win32")).toEqual({
      command: "C:\\Apps\\Cursor.exe",
      args: [],
    });
    expect(cursorLaunchCommand("/opt/Cursor.AppImage", "linux")).toEqual({
      command: "/opt/Cursor.AppImage",
      args: [],
    });
  });

  it("records the AppImage as the restart target on Linux", () => {
    expect(
      cursorExecutableForRestart(
        "linux",
        { APPIMAGE: "/home/u/Apps/Cursor.AppImage" },
        "/tmp/.mount_Cursor/usr/share/cursor/cursor",
      ),
    ).toBe("/home/u/Apps/Cursor.AppImage");
    expect(
      cursorExecutableForRestart("linux", {}, "/usr/share/cursor/cursor"),
    ).toBe("/usr/share/cursor/cursor");
    expect(
      cursorExecutableForRestart(
        "linux",
        { APPIMAGE: "" },
        "/usr/share/cursor/cursor",
      ),
    ).toBe("/usr/share/cursor/cursor");
    expect(
      cursorExecutableForRestart(
        "win32",
        { APPIMAGE: "/ignored" },
        "C:\\Apps\\Cursor.exe",
      ),
    ).toBe("C:\\Apps\\Cursor.exe");
  });
});

function producer(
  extensionVersion: string,
  cursorVersion: string,
  vscodeVersion: string,
): EventProducer {
  return { extensionVersion, cursorVersion, vscodeVersion };
}

function report(
  extensionVersion: string,
  cursorVersion: string,
  vscodeVersion: string,
): CompatibilityReport {
  return {
    compatible: true,
    extensionVersion,
    cursorVersion,
    vscodeVersion,
    nodeVersion: "v24.0.0",
    sqliteAvailable: true,
    sqliteBackupAvailable: true,
    globalDatabasePath: "C:/Cursor/User/globalStorage/state.vscdb",
    databaseCapabilities: {
      "global-item-table": { available: true, reasons: [] },
      "global-chat": { available: true, reasons: [] },
      "sqlite-files": { available: true, reasons: [] },
    },
    reasons: [],
    warnings: [],
  };
}
