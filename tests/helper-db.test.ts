import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import {
  applyGlobalDatabaseChanges,
  portableToStoredProfile,
  recoverInterruptedApplyJournals,
  restoreDatabaseBackup,
  type PreparedHelperChange,
} from "../src/helper/database";
import type { HelperRequest } from "../src/helper/types";
import { applyNonGlobalChanges } from "../src/helper/resourceApply";
import { pathExists } from "../src/platform/files";

const temporaryRoots: string[] = [];
const { DatabaseSync } = sqlite;
// The offline helper needs `node:sqlite.backup` (see docs/compatibility.md), so
// these tests cannot run without it.
const hasBackup = typeof sqlite.backup === "function";
const describeWithBackup = hasBackup ? describe : describe.skip;

// A silent skip is worse than no test: the suite reports green while the entire
// offline apply path — the one that decides whether a shutdown writes anything
// at all — goes unexercised. Local runs on a Node without `backup` stay green,
// but a release or CI run has to opt in and then cannot miss the gap.
const USER_RULES_KEY = "aicontext.personalContext";

describe("offline database helper prerequisites", () => {
  it("exercises the offline helper suite on a runtime that supports it", () => {
    if (hasBackup) {
      return;
    }
    const strict =
      process.env.CI === "true" || process.env.REQUIRE_SQLITE_BACKUP === "1";
    expect(
      strict,
      `Node ${process.version} does not expose node:sqlite.backup, so every offline database helper test was skipped. Run the suite on a Node build that provides it (Node 24 or newer) before releasing, or clear CI/REQUIRE_SQLITE_BACKUP to accept the gap locally.`,
    ).toBe(false);
  });
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describeWithBackup("offline database helper", () => {
  it("backs up and applies an allowlisted UI state value", async () => {
    const fixture = await createFixture();
    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "1".repeat(64),
          changeIndex: 0,
          resourceId: "cursor-user-rules/aicontext.personalContext",
          kind: "cursor-user-rules",
          operation: "put",
          semanticHash: "hash",
          metadata: {
            key: "aicontext.personalContext",
            registeredUserTarget: false,
          },
        },
        content: Buffer.from("Always respond safely.", "utf8"),
      },
    ]);

    expect(result.backupPath).toContain("backups");
    expect(readItem(fixture.databasePath, "aicontext.personalContext")).toBe(
      "Always respond safely.",
    );
  });

  it("aborts before the write transaction when Cursor reopened during the backup", async () => {
    // The backup/validate/retention pipeline ahead of the transaction takes
    // minutes on a real database - plenty of time to relaunch Cursor, whose
    // write-back at its next quit silently reverts a commit made under it.
    const fixture = await createFixture();
    let checked = 0;
    const operation = applyGlobalDatabaseChanges(
      fixture.request,
      [
        {
          change: {
            eventHash: "9".repeat(64),
            changeIndex: 0,
            resourceId: "cursor-user-rules/aicontext.personalContext",
            kind: "cursor-user-rules",
            operation: "put",
            semanticHash: "hash",
            metadata: {
              key: "aicontext.personalContext",
              registeredUserTarget: false,
            },
          },
          content: Buffer.from("never lands", "utf8"),
        },
      ],
      () => {},
      async () => {
        checked += 1;
        throw new Error("Cursor was reopened before offline changes could be applied.");
      },
    );

    await expect(operation).rejects.toThrow("Cursor was reopened");
    expect(checked).toBe(1);
    // The live database is untouched and the pre-apply backup exists.
    expect(readItem(fixture.databasePath, "existing")).toBe("preserved");
    expect(
      readItem(fixture.databasePath, "aicontext.personalContext"),
    ).toBeNull();
  });

  it("rolls back the SQL transaction when an unsafe key is requested", async () => {
    const fixture = await createFixture();
    const operation = applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "2".repeat(64),
          changeIndex: 0,
          resourceId: "ui-state/secret%3A%2F%2Fforbidden",
          kind: "ui-state",
          operation: "put",
          semanticHash: "hash",
          metadata: {
            key: "secret://forbidden",
            registeredUserTarget: true,
          },
        },
        content: Buffer.from("forbidden", "utf8"),
      },
    ]);

    await expect(operation).rejects.toThrow("unsafe UI state key");
    expect(readItem(fixture.databasePath, "existing")).toBe("preserved");
  });

  it("still fails the whole request for a security-denied key alongside good changes", async () => {
    const fixture = await createFixture();
    const operation = applyGlobalDatabaseChanges(fixture.request, [
      uiStateChange(
        "workbench.panel.chatSidebar",
        "text",
        Buffer.from("peer layout", "utf8"),
      ),
      {
        change: {
          eventHash: "2".repeat(64),
          changeIndex: 1,
          resourceId: `ui-state/${encodeURIComponent("github.authenticationSessions")}`,
          kind: "ui-state",
          operation: "put",
          semanticHash: "hash",
          metadata: {
            key: "github.authenticationSessions",
            registeredUserTarget: true,
          },
        },
        content: Buffer.from("[]", "utf8"),
      },
    ]);

    await expect(operation).rejects.toThrow("unsafe UI state key");
    // The whole transaction rolled back, including the change that preceded it.
    expect(readItem(fixture.databasePath, "workbench.panel.chatSidebar")).toBe(
      null,
    );
    expect(readItem(fixture.databasePath, "existing")).toBe("preserved");
  });

  it.each([
    "workbench.auxiliarybar.pinnedPanels",
    "workbench.panel.composerChatViewPane.1b4e28ba-2fa1-11d2-883f-b9a761bde3fb.hidden",
    // Keys earlier releases DID synchronize. The repository still holds their
    // immutable events, and receiving one must skip rather than fail.
    "workbench.activity.pinnedViewlets2",
    "workbench.panel.chatSidebar",
  ])(
    "skips the excluded ui-state key %s and still applies the rest of the request",
    async (excludedKey) => {
      const fixture = await createFixture();
      const result = await applyGlobalDatabaseChanges(fixture.request, [
        {
          change: {
            eventHash: "7".repeat(64),
            changeIndex: 0,
            resourceId: `ui-state/${encodeURIComponent(excludedKey)}`,
            kind: "ui-state",
            operation: "put",
            semanticHash: "hash",
            metadata: { key: excludedKey, registeredUserTarget: true },
          },
          content: Buffer.from("[]", "utf8"),
        },
        {
          change: {
            eventHash: "7".repeat(64),
            changeIndex: 2,
            resourceId: "cursor-user-rules/aicontext.personalContext",
            kind: "cursor-user-rules",
            operation: "put",
            semanticHash: "hash",
            metadata: {
              key: "aicontext.personalContext",
              registeredUserTarget: false,
            },
          },
          content: Buffer.from("Always respond safely.", "utf8"),
        },
      ]);

      // Nothing was written for the excluded key...
      expect(readItem(fixture.databasePath, excludedKey)).toBe(null);
      // ...but the user rules in the same request landed. They share the
      // adapter and the table with ui-state and must not be caught by it.
      expect(
        readItem(fixture.databasePath, "aicontext.personalContext"),
      ).toBe("Always respond safely.");
      // Accounted for, so it stops being pending instead of being retried on
      // every shutdown forever, and the reason is recorded.
      expect(result.applied).toContain(
        `ui-state/${encodeURIComponent(excludedKey)}`,
      );
      expect(
        result.skipped.some(
          (entry) =>
            entry.startsWith(`ui-state/${encodeURIComponent(excludedKey)}:`) &&
            entry.includes("kept local to each computer"),
        ),
      ).toBe(true);
    },
  );

  it("keeps the local row when a peer deletes a policy-excluded key", async () => {
    const fixture = await createFixture();
    const key = "workbench.auxiliarybar.pinnedPanels";
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run(key, "local panels");
    database.close();

    await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "8".repeat(64),
          changeIndex: 0,
          resourceId: `ui-state/${encodeURIComponent(key)}`,
          kind: "ui-state",
          operation: "delete",
          semanticHash: "hash",
          metadata: { key, registeredUserTarget: true },
        },
      },
    ]);

    expect(readItem(fixture.databasePath, key)).toBe("local panels");
  });

  it("retains the local value for an inbound UI state key", async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("workbench.activity.pinnedViewlets2", "local layout");
    database.close();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      pinnedViewletsChange("put", Buffer.from("peer layout", "utf8")),
    ]);

    expect(
      readItem(fixture.databasePath, "workbench.activity.pinnedViewlets2"),
    ).toBe("local layout");
    // Accounted for, so the change stops being pending and the user is not
    // asked to restart for it again on every activation.
    expect(result.applied).toContain(
      "ui-state/workbench.activity.pinnedViewlets2",
    );
    expect(result.skipped).toContain(
      "ui-state/workbench.activity.pinnedViewlets2: window layout is kept local to each computer; the local value is kept and nothing is deleted on other devices",
    );
  });

  it("keeps the local row when a peer deletes an ignored UI state key", async () => {
    const fixture = await createFixture({
      ignoredUiStateKeys: ["workbench.activity.*"],
    });
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("workbench.activity.pinnedViewlets2", "local layout");
    database
      .prepare(
        `INSERT INTO ItemTable(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(
        "__$__targetStorageMarker",
        Buffer.from(
          JSON.stringify({ "workbench.activity.pinnedViewlets2": 0 }),
          "utf8",
        ),
      );
    database.close();

    await applyGlobalDatabaseChanges(fixture.request, [
      pinnedViewletsChange("delete"),
    ]);

    expect(
      readItem(fixture.databasePath, "workbench.activity.pinnedViewlets2"),
    ).toBe("local layout");
    expect(
      JSON.parse(readItem(fixture.databasePath, "__$__targetStorageMarker") ?? "{}"),
    ).toEqual({ "workbench.activity.pinnedViewlets2": 0 });
  });

  it("retains a UI state key the ignore list does not name either", async () => {
    // The exclusion is the kind, not the user's list: a key nobody ignored is
    // still not written. Reading it off the list would have left every key the
    // user had not thought to name travelling between computers.
    const fixture = await createFixture({
      ignoredUiStateKeys: ["workbench.activity.pinnedViewlets2"],
    });

    await applyGlobalDatabaseChanges(fixture.request, [
      uiStateChange(
        "workbench.panel.chatSidebar",
        "text",
        Buffer.from("peer layout", "utf8"),
      ),
    ]);

    expect(readItem(fixture.databasePath, "workbench.panel.chatSidebar")).toBe(
      null,
    );
  });

  it("merges profiles by ID and preserves local and future fields", async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run(
        "userDataProfiles",
        JSON.stringify([
          {
            location: { path: "/profiles/shared" },
            name: "Old shared name",
            icon: "old-icon",
            futureField: { enabled: true },
          },
          {
            location: { path: "/profiles/local-only" },
            name: "Local only",
            futureField: "keep",
          },
        ]),
      );
    database.close();

    await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "3".repeat(64),
          changeIndex: 0,
          resourceId: "profile/manifest",
          kind: "profile",
          operation: "put",
          semanticHash: "hash",
        },
        content: Buffer.from(
          JSON.stringify([
            { id: "shared", name: "New shared name" },
            { id: "remote-new", name: "Remote new" },
          ]),
          "utf8",
        ),
      },
    ]);

    const stored = JSON.parse(
      readItem(fixture.databasePath, "userDataProfiles") ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(3);
    expect(stored.find((profile) => profile.name === "New shared name")).toEqual(
      expect.objectContaining({ futureField: { enabled: true } }),
    );
    expect(stored.find((profile) => profile.name === "Local only")).toEqual(
      expect.objectContaining({ futureField: "keep" }),
    );
    expect(stored.find((profile) => profile.name === "Remote new")).toBeDefined();
  });

  it("upserts store.db rows without deleting target-only data or newer tables", async () => {
    const fixture = await createFixture();
    const relativePath = "chats/session/store.db";
    const storePath = join(fixture.request.paths.cursorHome, ...relativePath.split("/"));
    await mkdir(join(storePath, ".."), { recursive: true });
    const existingConnection = new DatabaseSync(storePath);
    existingConnection.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    existingConnection.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    existingConnection.exec("CREATE TABLE newerTable (id TEXT PRIMARY KEY, value TEXT)");
    existingConnection
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?)")
      .run("shared", "local");
    existingConnection
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?)")
      .run("local-only", "preserved");
    existingConnection
      .prepare("INSERT INTO newerTable(id, value) VALUES (?, ?)")
      .run("future", "preserved");

    const resourceId = `chat-store/${encodeURIComponent(relativePath)}`;
    const result = await applyNonGlobalChanges(fixture.request, [
      {
        change: {
          eventHash: "4".repeat(64),
          changeIndex: 0,
          resourceId,
          kind: "chat-store",
          operation: "put",
          semanticHash: "hash",
        },
        content: Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            relativePath,
            meta: [
              { key: "shared", value: { type: "text", value: "remote" } },
              { key: "remote-only", value: { type: "text", value: "added" } },
            ],
            blobs: [
              { id: "integer", data: { type: "integer", value: "42" } },
            ],
          }),
          "utf8",
        ),
      },
    ]);

    expect(result.applied).toEqual([resourceId]);
    expect(readValue(existingConnection, "meta", "key", "shared", "value")).toBe(
      "remote",
    );
    expect(
      readValue(existingConnection, "meta", "key", "local-only", "value"),
    ).toBe("preserved");
    expect(
      readValue(existingConnection, "meta", "key", "remote-only", "value"),
    ).toBe("added");
    expect(readValue(existingConnection, "blobs", "id", "integer", "data")).toBe(
      42,
    );
    expect(
      readValue(existingConnection, "newerTable", "id", "future", "value"),
    ).toBe("preserved");
    existingConnection.close();
  });

  it("restores logical rows with SQL without replacing the live database file", async () => {
    const fixture = await createFixture();
    const backupPath = join(fixture.request.storageRoot, "manual-backup.vscdb");
    await mkdir(fixture.request.storageRoot, { recursive: true });
    const backupSource = new DatabaseSync(fixture.databasePath, {
      readOnly: true,
    });
    try {
      await sqlite.backup(backupSource, backupPath, { rate: 100 });
    } finally {
      backupSource.close();
    }

    const existingConnection = new DatabaseSync(fixture.databasePath);
    existingConnection
      .prepare("UPDATE ItemTable SET value = ? WHERE key = ?")
      .run("changed", "existing");
    existingConnection
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("created-after-backup", "remove-me");

    const returnedPreRestorePath = await restoreDatabaseBackup(
      fixture.databasePath,
      backupPath,
      fixture.request.storageRoot,
      "00000000-0000-4000-8000-000000000011",
      "global",
    );

    expect(readItemFromConnection(existingConnection, "existing")).toBe(
      "preserved",
    );
    expect(
      readItemFromConnection(existingConnection, "created-after-backup"),
    ).toBeNull();
    existingConnection.close();

    const journal = JSON.parse(
      await readFile(
        join(
          fixture.request.storageRoot,
          "restore-00000000-0000-4000-8000-000000000011.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(journal.version).toBe(3);
    expect(journal.status).toBe("verified");
    expect(journal).not.toHaveProperty("candidatePath");
    expect(journal).not.toHaveProperty("quarantineRoot");
    const preRestoreBackupPath = journal.preRestoreBackupPath as string;
    expect(preRestoreBackupPath).toContain("pre-restore-");
    expect(preRestoreBackupPath).toBe(returnedPreRestorePath);
    const preRestore = new DatabaseSync(preRestoreBackupPath, {
      readOnly: true,
    });
    try {
      expect(readItemFromConnection(preRestore, "existing")).toBe("changed");
      expect(readItemFromConnection(preRestore, "created-after-backup")).toBe(
        "remove-me",
      );
    } finally {
      preRestore.close();
    }
  });

  it("takes a fresh pre-restore backup before replaying an interrupted restore", async () => {
    const fixture = await createFixture();
    const storageRoot = fixture.request.storageRoot;
    await mkdir(storageRoot, { recursive: true });
    const backupPath = join(storageRoot, "manual-backup.vscdb");
    const backupSource = new DatabaseSync(fixture.databasePath, {
      readOnly: true,
    });
    try {
      await sqlite.backup(backupSource, backupPath, { rate: 100 });
    } finally {
      backupSource.close();
    }
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("written-after-interruption", "recoverable");
    database.close();
    const requestId = "00000000-0000-4000-8000-000000000015";
    const journalPath = join(storageRoot, `restore-${requestId}.json`);
    await writeFile(
      journalPath,
      JSON.stringify({
        version: 3,
        requestId,
        status: "applying",
        databasePath: fixture.databasePath,
        backupPath,
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        contract: "global",
        preRestoreBackupPath: null,
      }),
    );

    await recoverInterruptedApplyJournals(storageRoot, fixture.databasePath);

    expect(readItem(fixture.databasePath, "written-after-interruption")).toBeNull();
    const recoveryBackupPath = join(
      storageRoot,
      "backups",
      `pre-restore-${requestId}-recovery.vscdb`,
    );
    const recoveryBackup = new DatabaseSync(recoveryBackupPath, {
      readOnly: true,
    });
    try {
      expect(
        readItemFromConnection(recoveryBackup, "written-after-interruption"),
      ).toBe("recoverable");
    } finally {
      recoveryBackup.close();
    }
    expect(await pathExists(journalPath)).toBe(false);
  });

  it("fails an interrupted restore without replaying when no fresh backup can be created", async () => {
    const fixture = await createFixture();
    const storageRoot = fixture.request.storageRoot;
    await mkdir(storageRoot, { recursive: true });
    const backupPath = join(storageRoot, "manual-backup.vscdb");
    const backupSource = new DatabaseSync(fixture.databasePath, {
      readOnly: true,
    });
    try {
      await sqlite.backup(backupSource, backupPath, { rate: 100 });
    } finally {
      backupSource.close();
    }
    const requestId = "00000000-0000-4000-8000-000000000016";
    const journalPath = join(storageRoot, `restore-${requestId}.json`);
    await writeFile(
      journalPath,
      JSON.stringify({
        version: 3,
        requestId,
        status: "applying",
        databasePath: join(storageRoot, "missing.vscdb"),
        backupPath,
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        contract: "global",
        preRestoreBackupPath: null,
      }),
    );

    await recoverInterruptedApplyJournals(storageRoot, fixture.databasePath);

    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(journal.status).toBe("failed");
    expect(journal.error).toContain("pre-restore backup could not be created");
    expect(journal.completedAt).not.toBeNull();
    expect(
      await pathExists(
        join(storageRoot, "backups", `pre-restore-${requestId}-recovery.vscdb`),
      ),
    ).toBe(false);
  });

  it("preserves the SQLite storage class of applied ItemTable values", async () => {
    // One key per fixture rather than four keys in one request: ui-state no
    // longer travels, so `aicontext.personalContext` is the only key that
    // reaches this code, and each storage class has to be applied on its own.
    const legacyBlobBytes = Buffer.from([0xff, 0x00, 0x01]);
    const cases: Array<{
      valueType: "text" | "blob" | undefined;
      content: Buffer;
      storageClass: string;
    }> = [
      {
        valueType: "text",
        content: Buffer.from("true", "utf8"),
        storageClass: "text",
      },
      {
        valueType: "blob",
        content: Buffer.from([1, 2, 3]),
        storageClass: "blob",
      },
      {
        valueType: undefined,
        content: Buffer.from("legacy", "utf8"),
        storageClass: "text",
      },
      // A legacy payload that is not valid UTF-8 must keep its exact bytes
      // instead of being decoded through U+FFFD replacement characters.
      {
        valueType: undefined,
        content: legacyBlobBytes,
        storageClass: "blob",
      },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      await applyGlobalDatabaseChanges(fixture.request, [
        userRulesChange(testCase.valueType, testCase.content),
      ]);

      const database = new DatabaseSync(fixture.databasePath, {
        readOnly: true,
      });
      try {
        expect(readItemType(database, USER_RULES_KEY)).toBe(
          testCase.storageClass,
        );
        const raw = database
          .prepare("SELECT value FROM ItemTable WHERE key = ?")
          .get(USER_RULES_KEY) as { value?: Uint8Array | string } | undefined;
        expect(Buffer.from(raw?.value ?? [])).toEqual(testCase.content);
      } finally {
        database.close();
      }
    }
  });

  it("preserves chat KV storage classes and never deletes local messages", async () => {
    const fixture = await createFixture();
    const composerId = "00000000-0000-4000-8000-000000000001";
    const otherComposerId = "11111111-1111-4111-8111-111111111111";
    const workspaceRoot = join(
      fixture.request.paths.workspaceStorageRoot,
      "anonymous-workspace",
    );
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, "workspace.json"),
      JSON.stringify({ folder: "file:///c%3A/project" }),
    );
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:stale`, "absent-from-the-snapshot");
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${otherComposerId}:kept`, "other-composer");
    seed.close();

    const snapshot = {
      schemaVersion: 1,
      composerId,
      header: {
        composerId,
        workspaceId: "anonymous-workspace",
        createdAt: 1700000000000,
        lastUpdatedAt: 1700000001000,
        isArchived: 0,
        isSubagent: 0,
        recency: 0,
        checkpointAt: 0,
        value: "{}",
      },
      composerData: {
        key: `composerData:${composerId}`,
        valueBase64: Buffer.from("{}", "utf8").toString("base64"),
        valueType: "text",
      },
      bubbles: [
        {
          key: `bubbleId:${composerId}:text-bubble`,
          valueBase64: Buffer.from('{"text":"kept"}', "utf8").toString("base64"),
          valueType: "text",
        },
        {
          key: `bubbleId:${composerId}:blob-bubble`,
          valueBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
          valueType: "blob",
        },
        {
          key: `bubbleId:${composerId}:legacy-bubble`,
          valueBase64: Buffer.from('{"text":"legacy"}', "utf8").toString(
            "base64",
          ),
        },
        {
          key: `bubbleId:${composerId}:legacy-blob-bubble`,
          valueBase64: Buffer.from([0xff, 0xfe, 0x01]).toString("base64"),
        },
      ],
    };
    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "5".repeat(64),
          changeIndex: 0,
          resourceId: `chat/${composerId}`,
          kind: "chat",
          operation: "put",
          semanticHash: "hash",
        },
        content: Buffer.from(JSON.stringify(snapshot), "utf8"),
      },
    ]);
    expect(result.applied).toEqual([`chat/${composerId}`]);

    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKvType(database, `composerData:${composerId}`)).toBe("text");
      expect(readKvType(database, `bubbleId:${composerId}:text-bubble`)).toBe(
        "text",
      );
      expect(readKvType(database, `bubbleId:${composerId}:blob-bubble`)).toBe(
        "blob",
      );
      expect(readKvType(database, `bubbleId:${composerId}:legacy-bubble`)).toBe(
        "text",
      );
      expect(
        readKvType(database, `bubbleId:${composerId}:legacy-blob-bubble`),
      ).toBe("blob");
      // A message this computer holds and the incoming snapshot does not is
      // KEPT. It used to be deleted, on the rule that a removal on the source
      // should not survive here - but Cursor gives nobody a way to delete one
      // message, so every such absence is Cursor pruning a conversation body
      // on the other computer alone. Deleting made one machine's housekeeping
      // the other machine's data loss, and since the emptied side then
      // published its own empty capture, a chat pruned anywhere ended up empty
      // everywhere. `composerData` decides what the conversation contains, so
      // an unreferenced row is inert.
      expect(readKvType(database, `bubbleId:${composerId}:stale`)).toBe("text");
      expect(readKvType(database, `bubbleId:${otherComposerId}:kept`)).toBe(
        "text",
      );
    } finally {
      database.close();
    }
  });

  it("restores NULL chat values and NULL header columns as SQL NULL", async () => {
    const fixture = await createFixture();
    const composerId = "00000000-0000-4000-8000-000000000002";
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, "replaced-by-null");
    seed
      .prepare(
        `INSERT INTO composerHeaders(composerId, workspaceId, createdAt, value)
         VALUES (?, ?, ?, ?)`,
      )
      .run(composerId, "anonymous-workspace", 1, "{}");
    seed.close();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "7".repeat(64),
          changeIndex: 0,
          resourceId: `chat/${composerId}`,
          kind: "chat",
          operation: "put",
          semanticHash: "hash",
        },
        content: Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            composerId,
            header: {
              composerId,
              workspaceId: null,
              createdAt: null,
              lastUpdatedAt: null,
              isArchived: null,
              isSubagent: null,
              recency: null,
              checkpointAt: null,
              value: null,
            },
            composerData: {
              key: `composerData:${composerId}`,
              valueBase64: "",
              valueType: "null",
            },
            bubbles: [
              {
                key: `bubbleId:${composerId}:null-bubble`,
                valueBase64: "",
                valueType: "null",
              },
            ],
          }),
          "utf8",
        ),
      },
    ]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKvType(database, `composerData:${composerId}`)).toBe("null");
      expect(readKvType(database, `bubbleId:${composerId}:null-bubble`)).toBe(
        "null",
      );
      const header = database
        .prepare(
          `SELECT typeof(workspaceId) AS workspaceId, typeof(createdAt) AS createdAt,
            typeof(isArchived) AS isArchived, typeof(checkpointAt) AS checkpointAt,
            typeof(value) AS value
           FROM composerHeaders WHERE composerId = ?`,
        )
        .get(composerId) as Record<string, string> | undefined;
      expect(header).toEqual({
        workspaceId: "null",
        createdAt: "null",
        isArchived: "null",
        checkpointAt: "null",
        value: "null",
      });
    } finally {
      database.close();
    }
  });

  it("commits a profile apply when userDataProfiles is SQL NULL", async () => {
    const fixture = await createFixture();
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("userDataProfiles", null);
    seed.close();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "8".repeat(64),
          changeIndex: 0,
          resourceId: "profile/manifest",
          kind: "profile",
          operation: "put",
          semanticHash: "hash",
        },
        content: Buffer.from(
          JSON.stringify([{ id: "work", name: "Work" }]),
          "utf8",
        ),
      },
    ]);

    expect(result.applied).toEqual(["profile/manifest"]);
    const stored = JSON.parse(
      readItem(fixture.databasePath, "userDataProfiles") ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
  });

  it("leaves a NULL target storage marker untouched when no change registers a key", async () => {
    const fixture = await createFixture();
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare("UPDATE ItemTable SET value = ? WHERE key = ?")
      .run(null, "__$__targetStorageMarker");
    seed.close();

    await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "9".repeat(64),
          changeIndex: 0,
          resourceId: "cursor-user-rules/aicontext.personalContext",
          kind: "cursor-user-rules",
          operation: "put",
          semanticHash: "hash",
          metadata: {
            key: "aicontext.personalContext",
            registeredUserTarget: false,
          },
        },
        content: Buffer.from("rules", "utf8"),
      },
    ]);

    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readItemType(database, "__$__targetStorageMarker")).toBe("null");
    } finally {
      database.close();
    }
  });

  it("writes a chat whose workspace is not on this computer instead of dropping it", async () => {
    // The apply path answered "workspace mapping required" and skipped the
    // change, while the extension host raised a modal listing every local
    // workspace - none of which was the folder in question, because that
    // folder only ever existed on the other machine. Together that is how
    // conversations from a one-machine project never arrived at all.
    const fixture = await createFixture();
    const composerId = "00000000-0000-4000-8000-000000000009";
    const foreignWorkspace = "598c263dae4dcb731e5b78c884124368";
    const snapshot = {
      schemaVersion: 1,
      composerId,
      header: {
        composerId,
        workspaceId: foreignWorkspace,
        createdAt: 1,
        lastUpdatedAt: 2,
        isArchived: 0,
        isSubagent: 0,
        recency: 0,
        checkpointAt: null,
        value: JSON.stringify({ name: "written on the other PC" }),
      },
      composerData: {
        key: `composerData:${composerId}`,
        valueBase64: Buffer.from("{}", "utf8").toString("base64"),
        valueType: "text",
      },
      bubbles: [],
    };

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "9".repeat(64),
          changeIndex: 0,
          resourceId: `chat/${composerId}`,
          kind: "chat",
          operation: "put",
          semanticHash: "hash",
          metadata: {
            composerId,
            workspaceId: foreignWorkspace,
            workspaceUri: "file:///c%3A/Users/ckdgh/Desktop/projects/cbtpassmap",
          },
        },
        content: Buffer.from(JSON.stringify(snapshot), "utf8"),
      },
    ]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(result.skipped.join("\n")).not.toContain("workspace mapping");

    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT workspaceId FROM composerHeaders WHERE composerId = ?")
        .get(composerId) as { workspaceId: string | null };
      // Preserved rather than nulled: the ID is a hash of the folder URI, so
      // opening that folder here later puts the chat where Cursor looks for it.
      expect(row.workspaceId).toBe(foreignWorkspace);
    } finally {
      database.close();
    }
  });

  it("skips one rejected change instead of discarding the whole batch", async () => {
    const fixture = await createFixture();
    const composerId = "00000000-0000-4000-8000-000000000003";

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "a".repeat(64),
          changeIndex: 0,
          resourceId: `chat/${composerId}`,
          kind: "chat",
          operation: "put",
          semanticHash: "hash",
        },
        content: Buffer.from("{ not a snapshot", "utf8"),
      },
      userRulesChange("text", Buffer.from("kept", "utf8"), 1),
    ]);

    expect(result.applied).toEqual([`cursor-user-rules/${USER_RULES_KEY}`]);
    expect(result.skipped.join("\n")).toContain(`chat/${composerId}:`);
    expect(readItem(fixture.databasePath, USER_RULES_KEY)).toBe("kept");
  });

  it("rejects an unrecognised ItemTable storage class instead of writing a decoded value", async () => {
    const fixture = await createFixture();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      userRulesChange("null", Buffer.alloc(0)),
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped.join("\n")).toContain(
      "Unsupported UI state storage class: null",
    );
    expect(readItem(fixture.databasePath, USER_RULES_KEY)).toBeNull();
  });

  it("does not restore a stale backup when recovering an applying journal", async () => {
    const fixture = await createFixture();
    const storageRoot = fixture.request.storageRoot;
    await mkdir(storageRoot, { recursive: true });
    const backupPath = join(storageRoot, "stale-backup.vscdb");
    const backupSource = new DatabaseSync(fixture.databasePath, {
      readOnly: true,
    });
    try {
      await sqlite.backup(backupSource, backupPath, { rate: 100 });
    } finally {
      backupSource.close();
    }
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("written-after-backup", "keep-me");
    database.close();
    const journalPath = join(
      storageRoot,
      "apply-00000000-0000-4000-8000-000000000012.json",
    );
    await writeFile(
      journalPath,
      JSON.stringify({
        version: 1,
        requestId: "00000000-0000-4000-8000-000000000012",
        status: "applying",
        databasePath: fixture.databasePath,
        backupPath,
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
      }),
    );

    await recoverInterruptedApplyJournals(storageRoot, fixture.databasePath);

    expect(readItem(fixture.databasePath, "written-after-backup")).toBe(
      "keep-me",
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(journal.status).toBe("failed");
    expect(journal.completedAt).not.toBeNull();
    expect(journal.error).toContain("pendingDatabaseChanges");
  });

  it("scans only top-level journals, quarantines corrupt ones, and prunes expired ones", async () => {
    const fixture = await createFixture();
    const storageRoot = fixture.request.storageRoot;
    await mkdir(join(storageRoot, "backups"), { recursive: true });
    const corruptPath = join(storageRoot, "apply-corrupt.json");
    await writeFile(corruptPath, "{ not json");
    const nestedPath = join(storageRoot, "backups", "apply-nested.json");
    await writeFile(nestedPath, "{ also not json");
    const agedCorruptPath = join(storageRoot, "apply-old.json.corrupt");
    await writeFile(agedCorruptPath, "{ stale");
    const agedDate = new Date("2020-01-01T00:00:00.000Z");
    await utimes(agedCorruptPath, agedDate, agedDate);
    const recentCorruptPath = join(storageRoot, "restore-new.json.corrupt");
    await writeFile(recentCorruptPath, "{ recent");
    const expiredPath = join(storageRoot, "apply-expired.json");
    await writeFile(
      expiredPath,
      JSON.stringify(completedJournal("2020-01-01T00:00:00.000Z")),
    );
    const recentPath = join(storageRoot, "apply-recent.json");
    await writeFile(
      recentPath,
      JSON.stringify(completedJournal(new Date().toISOString())),
    );
    const committedPath = join(storageRoot, "apply-committed.json");
    await writeFile(
      committedPath,
      JSON.stringify({
        version: 1,
        requestId: "00000000-0000-4000-8000-000000000014",
        status: "committed",
        databasePath: fixture.databasePath,
        backupPath: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
      }),
    );

    await recoverInterruptedApplyJournals(storageRoot, fixture.databasePath);

    expect(await pathExists(corruptPath)).toBe(false);
    expect(await pathExists(`${corruptPath}.corrupt`)).toBe(true);
    expect(await pathExists(nestedPath)).toBe(true);
    expect(await pathExists(expiredPath)).toBe(false);
    expect(await pathExists(recentPath)).toBe(true);
    expect(await pathExists(committedPath)).toBe(false);
    expect(await pathExists(agedCorruptPath)).toBe(false);
    expect(await pathExists(recentCorruptPath)).toBe(true);
  });
});

describe("stored profile file URIs per platform", () => {
  it("prefixes and forward-slashes a Windows profiles root", () => {
    const stored = portableToStoredProfile(
      { id: "work", name: "Work" },
      "C:\\Users\\u\\AppData\\Roaming\\Cursor\\User\\profiles",
      "win32",
    );

    expect(stored.location).toEqual({
      $mid: 1,
      scheme: "file",
      path: "/C:/Users/u/AppData/Roaming/Cursor/User/profiles/work",
    });
  });

  it("uses a POSIX profiles root verbatim", () => {
    for (const [platform, profilesRoot] of [
      ["linux", "/home/u/.config/Cursor/User/profiles"],
      ["darwin", "/Users/u/Library/Application Support/Cursor/User/profiles"],
    ] as const) {
      const stored = portableToStoredProfile(
        { id: "work", name: "Work" },
        profilesRoot,
        platform,
      );

      expect(stored.location).toEqual({
        $mid: 1,
        scheme: "file",
        path: `${profilesRoot}/work`,
      });
    }
  });
});

async function createFixture(
  syncOptions: Partial<HelperRequest["syncOptions"]> = {},
): Promise<{
  request: HelperRequest;
  databasePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-sync-test-"));
  temporaryRoots.push(root);
  const databasePath = join(root, "state.vscdb");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode=WAL");
  database.exec(
    "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  database.exec(
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  database.exec(
    `CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
      recency INTEGER, checkpointAt INTEGER, value TEXT
    )`,
  );
  database
    .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
    .run("existing", "preserved");
  database
    .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
    .run(
      "__$__targetStorageMarker",
      Buffer.from(JSON.stringify({ existing: 0 }), "utf8"),
    );
  database.close();

  const cursorHome = join(root, ".cursor");
  const userDataRoot = join(root, "User");
  const extensionStorage = join(root, "extension-storage");
  const request: HelperRequest = {
    version: 1,
    requestId: "00000000-0000-4000-8000-000000000010",
    mode: "apply-and-restart",
    createdAt: "2026-07-14T00:00:00.000Z",
    repositoryRoot: join(root, "repository"),
    storageRoot: extensionStorage,
    cursorExecutable: "Cursor.exe",
    extensionHostPid: 1,
    restart: false,
    expectedCursorVersion: "3.11.19",
    expectedVscodeVersion: "1.125.0",
    extensionVersion: "0.0.1",
    paths: {
      appRoot: root,
      userDataRoot,
      globalStorageRoot: root,
      globalDatabase: databasePath,
      workspaceStorageRoot: join(userDataRoot, "workspaceStorage"),
      profilesRoot: join(userDataRoot, "profiles"),
      snippetsRoot: join(userDataRoot, "snippets"),
      promptsRoot: join(userDataRoot, "prompts"),
      userTasks: join(userDataRoot, "tasks.json"),
      userMcp: join(userDataRoot, "mcp.json"),
      cursorHome,
      cursorMcp: join(cursorHome, "mcp.json"),
      cursorCliConfig: join(cursorHome, "cli-config.json"),
      cursorCommands: join(cursorHome, "commands"),
      cursorSkills: join(cursorHome, "skills"),
      cursorRules: join(cursorHome, "rules"),
      cursorProjects: join(cursorHome, "projects"),
      cursorChats: join(cursorHome, "chats"),
      cursorAcpSessions: join(cursorHome, "acp-sessions"),
      cursorExtensionsManifest: join(cursorHome, "extensions", "extensions.json"),
      extensionStorage,
      helperScript: join(root, "helper.js"),
    },
    changes: [],
    workspaceMappings: {},
    syncOptions: {
      ignoredSettings: [],
      ignoredExtensions: [],
      machineScopedSettings: [],
      syncChat: true,
      syncWorkspaceStorage: true,
      maxPayloadBytes: 128 * 1024 * 1024,
      ...syncOptions,
    },
  };
  return { request, databasePath };
}

function pinnedViewletsChange(
  operation: "put" | "delete",
  content?: Buffer,
): PreparedHelperChange {
  const key = "workbench.activity.pinnedViewlets2";
  return {
    change: {
      eventHash: "5".repeat(64),
      changeIndex: 0,
      resourceId: `ui-state/${encodeURIComponent(key)}`,
      kind: "ui-state",
      operation,
      semanticHash: "hash",
      metadata: { key, registeredUserTarget: true },
    },
    ...(content === undefined ? {} : { content }),
  };
}

function readItem(databasePath: string, key: string): string | null {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return readItemFromConnection(database, key);
  } finally {
    database.close();
  }
}

function readItemFromConnection(database: InstanceType<typeof DatabaseSync>, key: string): string | null {
  const row = database
    .prepare("SELECT value FROM ItemTable WHERE key = ?")
    .get(key) as { value?: Uint8Array | string } | undefined;
  return row?.value === undefined
    ? null
    : typeof row.value === "string"
      ? row.value
      : Buffer.from(row.value).toString("utf8");
}

function readValue(
  database: InstanceType<typeof DatabaseSync>,
  table: "meta" | "blobs" | "newerTable",
  keyColumn: "key" | "id",
  key: string,
  valueColumn: "value" | "data",
): unknown {
  const row = database
    .prepare(
      `SELECT "${valueColumn}" AS value FROM "${table}" WHERE "${keyColumn}" = ?`,
    )
    .get(key) as { value?: unknown } | undefined;
  return row?.value;
}

function readItemType(
  database: InstanceType<typeof DatabaseSync>,
  key: string,
): string | undefined {
  const row = database
    .prepare("SELECT typeof(value) AS type FROM ItemTable WHERE key = ?")
    .get(key) as { type?: string } | undefined;
  return row?.type;
}

function readKvType(
  database: InstanceType<typeof DatabaseSync>,
  key: string,
): string | undefined {
  const row = database
    .prepare("SELECT typeof(value) AS type FROM cursorDiskKV WHERE key = ?")
    .get(key) as { type?: string } | undefined;
  return row?.type;
}

function uiStateChange(
  key: string,
  valueType: "text" | "blob" | "null" | undefined,
  content: Buffer,
): PreparedHelperChange {
  return {
    change: {
      eventHash: "6".repeat(64),
      changeIndex: 0,
      resourceId: `ui-state/${encodeURIComponent(key)}`,
      kind: "ui-state",
      operation: "put",
      semanticHash: "hash",
      metadata: {
        key,
        registeredUserTarget: true,
        ...(valueType === undefined ? {} : { valueType }),
      },
    },
    content,
  };
}

/**
 * The one ItemTable key this build still writes from the repository. ui-state
 * is excluded wholesale, so anything testing the *shared* write path — storage
 * classes, batch isolation, metadata validation — has to ride on this kind.
 */
function userRulesChange(
  valueType: "text" | "blob" | "null" | undefined,
  content: Buffer,
  changeIndex = 0,
): PreparedHelperChange {
  return {
    change: {
      eventHash: "6".repeat(64),
      changeIndex,
      resourceId: `cursor-user-rules/${USER_RULES_KEY}`,
      kind: "cursor-user-rules",
      operation: "put",
      semanticHash: "hash",
      metadata: {
        key: USER_RULES_KEY,
        registeredUserTarget: true,
        ...(valueType === undefined ? {} : { valueType }),
      },
    },
    content,
  };
}

function completedJournal(completedAt: string): Record<string, unknown> {
  return {
    version: 1,
    requestId: "00000000-0000-4000-8000-000000000013",
    status: "verified",
    databasePath: "unused",
    backupPath: null,
    startedAt: completedAt,
    completedAt,
    error: null,
  };
}
