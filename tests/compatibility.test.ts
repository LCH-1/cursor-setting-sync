import { describe, expect, it } from "vitest";
import {
  compareVersions,
  cursorExecutableForRestart,
  cursorLaunchCommand,
  databaseApplyBlockReason,
  inspectGlobalDatabaseSchemaCapabilities,
  isDatabaseBackedKind,
  isExpectedCursorExecutable,
  parseCursorProcessIds,
} from "../src/platform/compatibility";
import type { openDatabase } from "../src/platform/sqlite";
import type { CompatibilityReport, EventProducer } from "../src/types";
import { shouldPublishSnapshot } from "../src/sync/versionPolicy";
import { resourceConfigurationBlockReason } from "../src/sync/resourcePolicy";

describe("activation database compatibility inspection", () => {
  it("checks schema and small metadata indexes without scanning the full database", () => {
    const databasePath = "C:/Cursor/User/globalStorage/state.vscdb";
    const tableColumns = new Map<string, readonly string[]>([
      ["ItemTable", ["key", "value"]],
      [
        "composerHeaders",
        [
          "composerId",
          "workspaceId",
          "createdAt",
          "lastUpdatedAt",
          "isArchived",
          "isSubagent",
          "recency",
          "checkpointAt",
          "value",
        ],
      ],
      ["cursorDiskKV", ["key", "value"]],
    ]);
    const executedSql: string[] = [];
    let closed = false;
    let itemTableIntegrity = "ok";
    const database = {
      exec(sql: string): void {
        executedSql.push(sql);
      },
      prepare(sql: string) {
        executedSql.push(sql);
        if (
          sql ===
          "SELECT name FROM sqlite_master WHERE type = ? AND name = ?"
        ) {
          return {
            get: (_type: string, table: string) =>
              tableColumns.has(table) ? { name: table } : undefined,
          };
        }

        const tableName = /^PRAGMA table_info\("([^"]+)"\)$/.exec(sql)?.[1];
        if (tableName !== undefined) {
          return {
            all: () =>
              (tableColumns.get(tableName) ?? []).map((name) => ({ name })),
          };
        }

        if (sql === "PRAGMA journal_mode") {
          return { get: () => ({ journal_mode: "wal" }) };
        }

        if (sql === 'PRAGMA integrity_check("ItemTable")') {
          return {
            all: () => [{ integrity_check: itemTableIntegrity }],
          };
        }

        if (sql === 'PRAGMA integrity_check("composerHeaders")') {
          return { all: () => [{ integrity_check: "ok" }] };
        }

        throw new Error(`Unexpected activation SQL: ${sql}`);
      },
      close(): void {
        closed = true;
      },
    } as unknown as ReturnType<typeof openDatabase>;
    const warnings: string[] = [];

    const capabilities = inspectGlobalDatabaseSchemaCapabilities(
      databasePath,
      warnings,
      (openedPath, options) => {
        expect(openedPath).toBe(databasePath);
        expect(options).toEqual({ readOnly: true });
        return database;
      },
    );

    expect(capabilities["global-item-table"].available).toBe(true);
    expect(capabilities["global-chat"].available).toBe(true);
    expect(warnings).toEqual([]);
    expect(executedSql).toContain("PRAGMA query_only=ON");
    expect(executedSql).toContain("PRAGMA journal_mode");
    expect(executedSql).toContain('PRAGMA integrity_check("ItemTable")');
    expect(executedSql).toContain(
      'PRAGMA integrity_check("composerHeaders")',
    );
    expect(executedSql).not.toContain("PRAGMA quick_check");
    expect(executedSql).not.toContain("PRAGMA integrity_check");
    expect(closed).toBe(true);

    // A silent missing-index-entry failure in ItemTable can otherwise make a
    // real profile manifest look absent and publish an empty replacement.
    itemTableIntegrity = "wrong # of entries in index ItemTable_autoindex";
    const corrupted = inspectGlobalDatabaseSchemaCapabilities(
      databasePath,
      [],
      () => database,
    );
    expect(corrupted["global-item-table"].available).toBe(false);
    expect(corrupted["global-item-table"].reasons.join(" ")).toContain(
      "wrong # of entries",
    );
    expect(corrupted["global-chat"].available).toBe(true);
  });
});

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
