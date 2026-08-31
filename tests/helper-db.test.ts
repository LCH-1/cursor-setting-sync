import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import {
  applyGlobalDatabaseChanges,
  ensureGlobalDatabaseApplySessionBackup,
  portableToStoredProfile,
  recoverInterruptedApplyJournals,
  restoreDatabaseBackup,
  type GlobalDatabaseApplySession,
  type PreparedHelperChange,
} from "../src/helper/database";
import { enforceBackupRetention } from "../src/helper/backupRetention";
import type { HelperRequest } from "../src/helper/types";
import { applyNonGlobalChanges } from "../src/helper/resourceApply";
import { pathExists } from "../src/platform/files";
import {
  auditChatReferences,
  inspectBrokenChatContinuationsInDatabase,
  readPortableChatSnapshot,
} from "../src/chat/repair";
import type {
  PortableChatSnapshot,
  PortableChatSnapshotV2,
} from "../src/chat/stateVscdb";
import { portableChatCoreHash } from "../src/chat/stateVscdb";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";

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
const REPAIR_ORIGIN_DEVICE = "repair-origin-device";
const REPAIR_PEER_DEVICE = "repair-peer-device";
const REPAIR_MARKER_DEVICE = "repair-checkpoint-device";

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
  it("reuses one verified pre-drain backup across bounded global pages", async () => {
    const fixture = await createFixture();
    const session: GlobalDatabaseApplySession = {
      verifiedBackupPath: null,
    };
    const change = (index: number, value: string): PreparedHelperChange => ({
      change: {
        eventHash: String(index).repeat(64),
        changeIndex: 0,
        resourceId: `cursor-user-rules/${encodeURIComponent(USER_RULES_KEY)}`,
        kind: "cursor-user-rules",
        operation: "put",
        semanticHash: sha256(value),
        metadata: { key: USER_RULES_KEY, registeredUserTarget: false },
      },
      content: Buffer.from(value, "utf8"),
    });

    const first = await applyGlobalDatabaseChanges(
      fixture.request,
      [change(1, "first")],
      undefined,
      undefined,
      undefined,
      undefined,
      session,
    );
    const second = await applyGlobalDatabaseChanges(
      fixture.request,
      [change(2, "second")],
      undefined,
      undefined,
      undefined,
      undefined,
      session,
    );

    expect(second.backupPath).toBe(first.backupPath);
    expect(session.verifiedBackupPath).toBe(first.backupPath);
    expect(
      (await readdir(join(fixture.request.storageRoot, "backups"))).filter(
        (name) => name.startsWith("state-") && name.endsWith(".vscdb"),
      ),
    ).toHaveLength(1);
    expect(readItem(first.backupPath, USER_RULES_KEY)).toBeNull();
    expect(readItem(fixture.databasePath, USER_RULES_KEY)).toBe("second");
    const journal = JSON.parse(
      await readFile(
        join(
          fixture.request.storageRoot,
          `apply-${fixture.request.requestId}.json`,
        ),
        "utf8",
      ),
    ) as { status: string; backupPath: string | null; completedAt: string | null };
    expect(journal.status).toBe("verified");
    expect(journal.backupPath).toBe(first.backupPath);
    expect(journal.completedAt).not.toBeNull();
  });

  it("takes the shared global backup before an extension-first page", async () => {
    const fixture = await createFixture();
    const session: GlobalDatabaseApplySession = {
      verifiedBackupPath: null,
    };
    const backupPath = await ensureGlobalDatabaseApplySessionBackup(
      fixture.request,
      session,
    );
    const extensionId = "some.extension";
    const extensionDatabase = new DatabaseSync(fixture.databasePath);
    extensionDatabase
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run(
        "extensionsIdentifiers/disabled",
        JSON.stringify([{ id: extensionId }]),
      );
    extensionDatabase.close();
    expect(readItem(backupPath, "extensionsIdentifiers/disabled")).toBeNull();
    expect(
      readItem(fixture.databasePath, "extensionsIdentifiers/disabled"),
    ).toBe(JSON.stringify([{ id: extensionId }]));

    const backupRoot = join(fixture.request.storageRoot, "backups");
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(backupRoot, `pressure-${index}.vscdb`), `${index}`);
    }
    await enforceBackupRetention(fixture.request.storageRoot, {
      maxFiles: 1,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
      exemptPath: backupPath,
    });
    expect(await pathExists(backupPath)).toBe(true);

    const globalResult = await applyGlobalDatabaseChanges(
      fixture.request,
      [userRulesChange("text", Buffer.from("after extension", "utf8"))],
      undefined,
      undefined,
      () => [backupPath],
      undefined,
      session,
    );
    expect(globalResult.backupPath).toBe(backupPath);
    expect(readItem(backupPath, USER_RULES_KEY)).toBeNull();
    expect(readItem(fixture.databasePath, USER_RULES_KEY)).toBe(
      "after extension",
    );
    expect(
      (await readdir(backupRoot)).filter(
        (name) => name.startsWith("state-") && name.endsWith(".vscdb"),
      ),
    ).toHaveLength(1);
  });

  it("applies a chat-only batch without reading an oversized target marker", async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("UPDATE ItemTable SET value = zeroblob(?) WHERE key = ?")
      .run(8 * 1024 * 1024 + 1, "__$__targetStorageMarker");
    database.close();
    const composerId = "00000000-0000-4000-8000-000000000901";

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      ordinaryChatChange(
        repairSnapshot(composerId, "data", "header", [
          { id: "bubble", value: { text: "chat survived" } },
        ]),
      ),
    ]);

    expect(result.applied).toContain(`chat/${composerId}`);
    const verification = new DatabaseSync(fixture.databasePath, {
      readOnly: true,
    });
    expect(
      verification
        .prepare(
          "SELECT COUNT(*) AS count FROM composerHeaders WHERE composerId = ?",
        )
        .get(composerId),
    ).toEqual({ count: 1 });
    expect(
      verification
        .prepare("SELECT length(value) AS bytes FROM ItemTable WHERE key = ?")
        .get("__$__targetStorageMarker"),
    ).toEqual({ bytes: 8 * 1024 * 1024 + 1 });
    verification.close();
  });

  it("isolates an over-limit marker addition while applying a chat sibling", async () => {
    const fixture = await createFixture();
    const entries = Object.fromEntries(
      Array.from({ length: 16_384 }, (_, index) => [`key.${index}`, 0]),
    );
    const originalMarker = JSON.stringify(entries);
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("UPDATE ItemTable SET value = ? WHERE key = ?")
      .run(originalMarker, "__$__targetStorageMarker");
    database.close();
    const composerId = "00000000-0000-4000-8000-000000000902";
    const key = "aicontext.personalContext";

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "1".repeat(64),
          changeIndex: 0,
          resourceId: `cursor-user-rules/${encodeURIComponent(key)}`,
          kind: "cursor-user-rules",
          operation: "put",
          semanticHash: "hash",
          metadata: { key, registeredUserTarget: true },
        },
        content: Buffer.from("must not land", "utf8"),
      },
      ordinaryChatChange(
        repairSnapshot(composerId, "data", "header", [
          { id: "bubble", value: { text: "chat sibling" } },
        ]),
        "2",
      ),
    ]);

    expect(result.applied).toContain(`chat/${composerId}`);
    expect(result.applied).not.toContain(`cursor-user-rules/${key}`);
    expect(result.skipped.some((item) => item.includes("target storage marker"))).toBe(
      true,
    );
    expect(readItem(fixture.databasePath, key)).toBe(null);
    expect(readItem(fixture.databasePath, "__$__targetStorageMarker")).toBe(
      originalMarker,
    );
  });

  it("isolates a 1,001st stored profile while applying a chat sibling", async () => {
    const fixture = await createFixture();
    const stored = Array.from({ length: 1_000 }, (_, index) => ({
      location: { path: `/profiles/local-${index}` },
      name: `Local ${index}`,
    }));
    const originalManifest = JSON.stringify(stored);
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO ItemTable(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("userDataProfiles", originalManifest);
    database.close();
    const incomingProfiles = Buffer.from(
      JSON.stringify([{ id: "new-profile", name: "New profile" }]),
      "utf8",
    );
    const composerId = "00000000-0000-4000-8000-000000000903";

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "3".repeat(64),
          changeIndex: 0,
          resourceId: "profile/manifest",
          kind: "profile",
          operation: "put",
          semanticHash: sha256(incomingProfiles),
        },
        content: incomingProfiles,
      },
      ordinaryChatChange(
        repairSnapshot(composerId, "data", "header", [
          { id: "bubble", value: { text: "chat sibling" } },
        ]),
        "4",
      ),
    ]);

    expect(result.applied).toContain(`chat/${composerId}`);
    expect(result.applied).not.toContain("profile/manifest");
    expect(result.skipped.some((item) => item.includes("entry limit"))).toBe(true);
    expect(readItem(fixture.databasePath, "userDataProfiles")).toBe(
      originalManifest,
    );
  });

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

  it("repairs only referenced missing chat rows and preserves live conversation state", async () => {
    const fixture = await createFixture();
    const composerId = "33333333-3333-4333-8333-333333333333";
    const composerData = JSON.stringify({
      _v: 17,
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
    });
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'workspace', 1, 2, 0, 0, 99, NULL, ?)`,
      )
      .run(composerId, JSON.stringify({ name: "Live title" }));
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, composerData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "live a" }));
    seed.close();

    const local = repairSnapshot(
      composerId,
      composerData,
      JSON.stringify({ name: "Live title" }),
      [{ id: "a", value: { text: "live a" } }],
    );
    const audit = auditChatReferences(local);
    expect(audit.status).toBe("known");
    if (audit.status !== "known") {
      return;
    }
    const source = repairSnapshot(
      composerId,
      composerData,
      JSON.stringify({ name: "Historical title that must not win" }),
      [
        { id: "a", value: { text: "historical a" } },
        { id: "b", value: { text: "recovered b" } },
      ],
    );
    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, audit.fingerprint),
      REPAIR_ORIGIN_DEVICE,
    );

    expect(result.applied).toEqual([`chat/${composerId}`]);
    // The preserved live header is allowed to publish on the next scan rather
    // than being hidden behind a retained-local hash from the repair source.
    expect(result.retainedLocal).toEqual([]);
    expect(result.localChatCoreHashes[`chat/${composerId}`]).toBeNull();
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const header = database
        .prepare("SELECT value, recency FROM composerHeaders WHERE composerId = ?")
        .get(composerId) as { value?: string; recency?: number } | undefined;
      expect(header).toEqual({
        value: JSON.stringify({ name: "Live title" }),
        recency: 99,
      });
      expect(readKv(database, `bubbleId:${composerId}:a`)).toBe(
        JSON.stringify({ text: "live a" }),
      );
      expect(readKv(database, `bubbleId:${composerId}:b`)).toBe(
        JSON.stringify({ text: "recovered b" }),
      );
    } finally {
      database.close();
    }
  });

  it("defers automatic repair before reading an over-limit local chat body", async () => {
    const fixture = await createFixture({ maxPayloadBytes: 1024 });
    const composerId = "31313131-3131-4131-8131-313131313131";
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "oversized" }],
    });
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "local-header", 1);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, composerData);
    seed
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(4096))",
      )
      .run(`bubbleId:${composerId}:oversized`);
    seed.close();
    const source = repairSnapshot(
      composerId,
      composerData,
      "remote-header",
      [{ id: "oversized", value: { text: "small repair" } }],
    );

    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, "unreached-fingerprint"),
      REPAIR_ORIGIN_DEVICE,
    );

    expect(result.applied).toEqual([]);
    expect(result.failureByResourceId[`chat/${composerId}`]).toContain(
      "bounded 1024-byte inspection limit",
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT typeof(value) AS valueType, length(CAST(value AS BLOB)) AS valueBytes " +
              "FROM cursorDiskKV WHERE key = ?",
          )
          .get(`bubbleId:${composerId}:oversized`),
      ).toEqual({ valueType: "blob", valueBytes: 4096 });
    } finally {
      database.close();
    }
  });

  it("leaves the database unchanged when a live bubble exceeds the JSON structure budget", async () => {
    const fixture = await createFixture();
    const composerId = "32323232-3232-4232-8232-323232323232";
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "hostile" }],
    });
    const hostile = hostileRepairJson();
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "live-header", 1);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, composerData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:hostile`, hostile);
    seed.close();
    const source = repairSnapshot(
      composerId,
      composerData,
      "historical-header",
      [
        { id: "hostile", value: { text: "must not replace live" } },
        { id: "source-orphan", value: { text: "must not be added" } },
      ],
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      const result = await applyAutomaticRepair(
        fixture.request,
        automaticChatRepairChange(source, "unreached-fingerprint"),
        REPAIR_ORIGIN_DEVICE,
      );

      expect(result.applied).toEqual([]);
      expect(result.failureByResourceId[`chat/${composerId}`]).toContain(
        "chat row JSON structural work limit was reached",
      );
      expect(
        parse.mock.calls.filter(([input]) => input === hostile),
      ).toHaveLength(0);
      const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        expect(readKv(database, `composerData:${composerId}`)).toBe(composerData);
        expect(readKv(database, `bubbleId:${composerId}:hostile`)).toBe(hostile);
        expect(readKv(database, `bubbleId:${composerId}:source-orphan`)).toBeUndefined();
      } finally {
        database.close();
      }
    } finally {
      parse.mockRestore();
    }
  });

  it("leaves the database unchanged when many live bubbles exhaust one audit budget", async () => {
    const fixture = await createFixture();
    const composerId = "33333333-3232-4232-8232-333333333333";
    const ids = Array.from(
      { length: 88 },
      (_unused, index) => `aggregate-${index.toString().padStart(3, "0")}`,
    );
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: ids.map((bubbleId) => ({ bubbleId })),
    });
    const unit = smallRepairJson();
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "live-header", 1);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, composerData);
    const insert = seed.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
    );
    seed.exec("BEGIN");
    for (const id of ids) {
      insert.run(`bubbleId:${composerId}:${id}`, unit);
    }
    seed.exec("COMMIT");
    seed.close();
    const source = repairSnapshot(
      composerId,
      composerData,
      "historical-header",
      [
        ...ids.map((id) => ({ id, value: { text: `source-${id}` } })),
        { id: "source-orphan", value: { text: "must not be added" } },
      ],
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      const result = await applyAutomaticRepair(
        fixture.request,
        automaticChatRepairChange(source, "unreached-fingerprint"),
        REPAIR_ORIGIN_DEVICE,
      );

      expect(result.applied).toEqual([]);
      expect(result.failureByResourceId[`chat/${composerId}`]).toContain(
        "chat row JSON structural work limit was reached",
      );
      const parsedUnits = parse.mock.calls.filter(([input]) => input === unit);
      expect(parsedUnits.length).toBeGreaterThan(0);
      expect(parsedUnits.length).toBeLessThan(ids.length);
      const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        expect(readKv(database, `composerData:${composerId}`)).toBe(composerData);
        expect(readKv(database, `bubbleId:${composerId}:${ids[0]}`)).toBe(unit);
        expect(readKv(database, `bubbleId:${composerId}:${ids.at(-1)}`)).toBe(unit);
        expect(readKv(database, `bubbleId:${composerId}:source-orphan`)).toBeUndefined();
      } finally {
        database.close();
      }
    } finally {
      parse.mockRestore();
    }
  });

  it("applies automatic v2 bubble and continuation repair together and idempotently", async () => {
    const fixture = await createFixture();
    const composerId = "34343434-3434-4434-8434-343434343434";
    const blob = Buffer.from("automatic repair continuation", "utf8");
    const rootId = sha256(blob);
    const conversationState = serializedRootState(rootId);
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
      conversationState,
    });
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, JSON.stringify({ name: "Live" }), 1);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, composerData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "a" }));
    seed.close();

    const planned = repairSnapshot(
      composerId,
      composerData,
      JSON.stringify({ name: "Live" }),
      [{ id: "a", value: { text: "a" } }],
    );
    const repairedCore = repairSnapshot(
      composerId,
      composerData,
      JSON.stringify({ name: "Historical" }),
      [
        { id: "a", value: { text: "historical a" } },
        { id: "b", value: { text: "recovered b" } },
        ...Array.from({ length: 20 }, (_unused, index) => ({
          id: `historical-${index.toString().padStart(2, "0")}`,
          value: { text: `inert history ${index}` },
        })),
      ],
    );
    const source: PortableChatSnapshotV2 = {
      ...repairedCore,
      schemaVersion: 2,
      agentKv: {
        blobs: [
          {
            key: `agentKv:blob:${rootId}`,
            valueBase64: blob.toString("base64"),
            valueType: "blob",
          },
        ],
        referencedIds: [rootId],
        missingIds: [],
      },
    };
    const change = automaticChatRepairChange(
      source,
      repairFingerprint(planned),
    );

    const first = await applyAutomaticRepair(
      fixture.request,
      change,
      REPAIR_ORIGIN_DEVICE,
    );
    expect(first.applied).toEqual([`chat/${composerId}`]);

    let database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `bubbleId:${composerId}:b`)).toBe(
        JSON.stringify({ text: "recovered b" }),
      );
      expect(readKv(database, `agentKv:blob:${rootId}`)).toBe(blob.toString());
      const bubbleCount = database
        .prepare(
          "SELECT COUNT(*) AS total FROM cursorDiskKV WHERE key LIKE ?",
        )
        .get(`bubbleId:${composerId}:%`) as { total?: number } | undefined;
      expect(bubbleCount?.total).toBe(source.bubbles.length);
      const audit = await inspectBrokenChatContinuationsInDatabase(database);
      expect(audit).toMatchObject({
        auditedChats: 1,
        unknownChats: 0,
        broken: [],
      });
    } finally {
      database.close();
    }

    const second = await applyAutomaticRepair(
      fixture.request,
      change,
      REPAIR_ORIGIN_DEVICE,
    );
    expect(second.applied).toEqual([`chat/${composerId}`]);
    expect(second.skipped.join(" ")).toContain(
      "every supplied repair row was already valid",
    );
    database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `bubbleId:${composerId}:b`)).toBe(
        JSON.stringify({ text: "recovered b" }),
      );
      expect(readKv(database, `agentKv:blob:${rootId}`)).toBe(blob.toString());
    } finally {
      database.close();
    }
  });

  it("replaces a referenced unreadable JSON bubble on the repair origin", async () => {
    const fixture = await createFixture();
    const composerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "broken" }],
    });
    const invalidJson = "{not-json";
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'workspace', 1, 2, 0, 0, 3, NULL, '{}')`,
      )
      .run(composerId);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, composerData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:broken`, invalidJson);
    seed.close();

    const local = repairSnapshot(composerId, composerData, "{}", []);
    local.bubbles.push({
      key: `bubbleId:${composerId}:broken`,
      valueBase64: Buffer.from(invalidJson, "utf8").toString("base64"),
      valueType: "text",
    });
    const audit = auditChatReferences(local);
    expect(audit.status).toBe("known");
    if (audit.status !== "known") {
      return;
    }
    expect(audit.unavailableBubbleKeys).toEqual([
      `bubbleId:${composerId}:broken`,
    ]);
    const source = repairSnapshot(composerId, composerData, "{}", [
      { id: "broken", value: { text: "recovered" } },
    ]);

    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, audit.fingerprint),
      REPAIR_ORIGIN_DEVICE,
    );

    expect(result.applied).toEqual([`chat/${composerId}`]);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `bubbleId:${composerId}:broken`)).toBe(
        JSON.stringify({ text: "recovered" }),
      );
    } finally {
      database.close();
    }
  });

  it("skips an automatic chat repair when composerData changed after planning", async () => {
    const fixture = await createFixture();
    const composerId = "44444444-4444-4444-8444-444444444444";
    const plannedData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
    });
    const local = repairSnapshot(composerId, plannedData, "{}", [
      { id: "a", value: { text: "a" } },
    ]);
    const audit = auditChatReferences(local);
    expect(audit.status).toBe("known");
    if (audit.status !== "known") {
      return;
    }
    const changedData = JSON.stringify({
      fullConversationHeadersOnly: [
        { bubbleId: "a" },
        { bubbleId: "b" },
        { bubbleId: "c" },
      ],
    });
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'workspace', 1, 2, 0, 0, 0, NULL, '{}')`,
      )
      .run(composerId);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, changedData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "a" }));
    seed.close();
    const source = repairSnapshot(composerId, plannedData, "{}", [
      { id: "a", value: { text: "a" } },
      { id: "b", value: { text: "b" } },
    ]);

    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, audit.fingerprint),
      REPAIR_ORIGIN_DEVICE,
    );

    expect(result.applied).toEqual([]);
    expect(result.skipped.join("\n")).toContain("changed after repair was planned");
    expect(result.failureByResourceId[`chat/${composerId}`]).toContain(
      "changed after repair was planned",
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `bubbleId:${composerId}:b`)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("keeps automatic-repair fingerprint checks after checkpoint re-assertion", async () => {
    const fixture = await createFixture();
    const composerId = "45454545-4545-4545-8545-454545454545";
    const plannedData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
    });
    const planned = repairSnapshot(composerId, plannedData, "{}", [
      { id: "a", value: { text: "a" } },
    ]);
    const changedData = JSON.stringify({
      fullConversationHeadersOnly: [
        { bubbleId: "a" },
        { bubbleId: "b" },
        { bubbleId: "later" },
      ],
    });
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "{}", 1);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, changedData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "a" }));
    seed.close();
    const source = repairSnapshot(composerId, plannedData, "{}", [
      { id: "a", value: { text: "a" } },
      { id: "b", value: { text: "b" } },
    ]);
    const change = automaticChatRepairChange(
      source,
      repairFingerprint(planned),
    );
    checkpointAutomaticRepairChange(change);

    const result = await applyAutomaticRepair(
      fixture.request,
      change,
      REPAIR_ORIGIN_DEVICE,
    );

    expect(result.applied).toEqual([]);
    expect(result.failureByResourceId[`chat/${composerId}`]).toContain(
      "changed after repair was planned",
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `bubbleId:${composerId}:b`)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("uses checkpointed original source authority instead of the marker publisher", async () => {
    const fixture = await createFixture();
    const composerId = "46464646-4646-4646-8646-464646464646";
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
    });
    const local = repairSnapshot(composerId, composerData, "{}", [
      { id: "a", value: { text: "a" } },
    ]);
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "{}", 1);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, composerData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "a" }));
    seed.close();
    const source = repairSnapshot(composerId, composerData, "{}", [
      { id: "a", value: { text: "a" } },
      { id: "b", value: { text: "recovered" } },
    ]);
    const change = automaticChatRepairChange(
      source,
      repairFingerprint(local),
    );
    checkpointAutomaticRepairChange(change);

    const result = await applyAutomaticRepair(
      fixture.request,
      change,
      REPAIR_ORIGIN_DEVICE,
    );

    expect(result.applied).toEqual([`chat/${composerId}`]);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `bubbleId:${composerId}:b`)).toBe(
        JSON.stringify({ text: "recovered" }),
      );
    } finally {
      database.close();
    }
  });

  it.each(["missing", "mismatched"] as const)(
    "fails closed when checkpoint repair source metadata is %s",
    async (provenance) => {
      const fixture = await createFixture();
      const composerId =
        provenance === "missing"
          ? "47474747-4747-4747-8747-474747474747"
          : "48484848-4848-4848-8848-484848484848";
      const composerData = JSON.stringify({
        fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
      });
      const local = repairSnapshot(composerId, composerData, "{}", [
        { id: "a", value: { text: "a" } },
      ]);
      const seed = new DatabaseSync(fixture.databasePath);
      insertTestHeader(seed, composerId, "{}", 1);
      seed
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(`composerData:${composerId}`, composerData);
      seed
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "a" }));
      seed.close();
      const source = repairSnapshot(composerId, composerData, "{}", [
        { id: "a", value: { text: "a" } },
        { id: "b", value: { text: "must-not-land" } },
      ]);
      const change = automaticChatRepairChange(
        source,
        repairFingerprint(local),
      );
      checkpointAutomaticRepairChange(change);
      if (provenance === "missing") {
        delete change.change.metadata?.checkpointedSourceDeviceId;
      } else if (change.change.metadata !== undefined) {
        change.change.metadata.checkpointedSourceDeviceId = REPAIR_PEER_DEVICE;
      }

      const result = await applyAutomaticRepair(
        fixture.request,
        change,
        REPAIR_ORIGIN_DEVICE,
      );

      expect(result.applied).toEqual([]);
      expect(result.failureByResourceId[`chat/${composerId}`]).toContain(
        "origin does not match",
      );
      const database = new DatabaseSync(fixture.databasePath, {
        readOnly: true,
      });
      try {
        expect(readKv(database, `bubbleId:${composerId}:b`)).toBeUndefined();
      } finally {
        database.close();
      }
    },
  );

  it("materializes a complete repair snapshot only on a truly empty peer", async () => {
    const fixture = await createFixture();
    const composerId = "66666666-6666-4666-8666-666666666666";
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
    });
    const planned = repairSnapshot(composerId, composerData, "{}", [
      { id: "a", value: { text: "a" } },
    ]);
    const source = repairSnapshot(
      composerId,
      composerData,
      JSON.stringify({ name: "Recovered on peer" }),
      [
        { id: "a", value: { text: "a" } },
        { id: "b", value: { text: "b" } },
      ],
    );
    const mappedWorkspace = "mapped-workspace";
    await mkdir(
      join(fixture.request.paths.workspaceStorageRoot, mappedWorkspace),
      { recursive: true },
    );
    await writeFile(
      join(
        fixture.request.paths.workspaceStorageRoot,
        mappedWorkspace,
        "workspace.json",
      ),
      JSON.stringify({ folder: "file:///C:/work/mapped" }),
      "utf8",
    );
    fixture.request.workspaceMappings.workspace = mappedWorkspace;

    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, repairFingerprint(planned)),
      REPAIR_PEER_DEVICE,
    );

    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(result.failureByResourceId).toEqual({});
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const header = database
        .prepare(
          "SELECT workspaceId, value FROM composerHeaders WHERE composerId = ?",
        )
        .get(composerId) as
        | { workspaceId?: string; value?: string }
        | undefined;
      expect(header).toEqual({
        workspaceId: mappedWorkspace,
        value: JSON.stringify({ name: "Recovered on peer" }),
      });
      expect(readKv(database, `composerData:${composerId}`)).toBe(composerData);
      expect(readKv(database, `bubbleId:${composerId}:b`)).toBe(
        JSON.stringify({ text: "b" }),
      );
    } finally {
      database.close();
    }
  });

  it("fails closed when the originating chat disappeared before apply", async () => {
    const fixture = await createFixture();
    const composerId = "77777777-7777-4777-8777-777777777777";
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }],
    });
    const source = repairSnapshot(composerId, composerData, "{}", [
      { id: "a", value: { text: "a" } },
    ]);

    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, "planned"),
      REPAIR_ORIGIN_DEVICE,
    );

    expect(result.applied).toEqual([]);
    expect(result.failureByResourceId[`chat/${composerId}`]).toContain(
      "originating chat disappeared",
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT 1 FROM composerHeaders WHERE composerId = ?")
          .get(composerId),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("does not mistake a header-only peer chat for an empty target", async () => {
    const fixture = await createFixture();
    const composerId = "88888888-8888-4888-8888-888888888888";
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }],
    });
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'peer-workspace', 1, 9, 1, 0, 77, NULL, ?)` ,
      )
      .run(composerId, JSON.stringify({ name: "Peer title" }));
    seed.close();
    const source = repairSnapshot(
      composerId,
      composerData,
      JSON.stringify({ name: "Origin title" }),
      [{ id: "a", value: { text: "a" } }],
    );

    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, "planned"),
      REPAIR_PEER_DEVICE,
    );

    expect(result.applied).toEqual([]);
    expect(result.failureByResourceId[`chat/${composerId}`]).toContain(
      "partial local conversation",
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const header = database
        .prepare(
          "SELECT value, recency FROM composerHeaders WHERE composerId = ?",
        )
        .get(composerId);
      expect(header).toEqual({
        value: JSON.stringify({ name: "Peer title" }),
        recency: 77,
      });
      expect(readKv(database, `composerData:${composerId}`)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("repairs an existing peer from its fresh audit without the origin fingerprint", async () => {
    const fixture = await createFixture();
    const composerId = "99999999-9999-4999-8999-999999999999";
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
    });
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'peer-workspace', 1, 8, 0, 0, 55, NULL, ?)` ,
      )
      .run(composerId, JSON.stringify({ name: "Peer title" }));
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, composerData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "peer a" }));
    seed.close();
    const source = repairSnapshot(composerId, composerData, "{}", [
      { id: "a", value: { text: "origin a" } },
      { id: "b", value: { text: "recovered b" } },
    ]);

    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, "origin-fingerprint"),
      REPAIR_PEER_DEVICE,
    );

    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(result.retainedLocal).toEqual([]);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `bubbleId:${composerId}:a`)).toBe(
        JSON.stringify({ text: "peer a" }),
      );
      expect(readKv(database, `bubbleId:${composerId}:b`)).toBe(
        JSON.stringify({ text: "recovered b" }),
      );
    } finally {
      database.close();
    }
  });

  it("leaves a healthy divergent peer untouched and lets its next scan publish", async () => {
    const fixture = await createFixture();
    const composerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const peerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "peer" }],
    });
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'peer-workspace', 1, 8, 0, 0, 55, NULL, ?)` ,
      )
      .run(composerId, JSON.stringify({ name: "Healthy peer" }));
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, peerData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:peer`, JSON.stringify({ text: "peer" }));
    seed.close();
    const originData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "origin" }],
    });
    const source = repairSnapshot(composerId, originData, "{}", [
      { id: "origin", value: { text: "origin" } },
    ]);

    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, "origin-fingerprint"),
      REPAIR_PEER_DEVICE,
    );

    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(result.retainedLocal).toEqual([]);
    expect(result.skipped.join("\n")).toContain("already complete");
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `composerData:${composerId}`)).toBe(peerData);
      expect(readKv(database, `bubbleId:${composerId}:peer`)).toBe(
        JSON.stringify({ text: "peer" }),
      );
      expect(readKv(database, `bubbleId:${composerId}:origin`)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("blocks a damaged peer whose composerData differs from the repair source", async () => {
    const fixture = await createFixture();
    const composerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const peerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "peer-missing" }],
    });
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'peer-workspace', 1, 8, 0, 0, 55, NULL, '{}')`,
      )
      .run(composerId);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, peerData);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:a`, JSON.stringify({ text: "peer a" }));
    seed.close();
    const originData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "origin" }],
    });
    const source = repairSnapshot(composerId, originData, "{}", [
      { id: "a", value: { text: "origin a" } },
      { id: "origin", value: { text: "origin" } },
    ]);

    const result = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, "origin-fingerprint"),
      REPAIR_PEER_DEVICE,
    );

    expect(result.applied).toEqual([]);
    expect(result.failureByResourceId[`chat/${composerId}`]).toContain(
      "different composerData",
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `composerData:${composerId}`)).toBe(peerData);
      expect(readKv(database, `bubbleId:${composerId}:origin`)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("binds repair metadata to its source device and requires a local device", async () => {
    const fixture = await createFixture();
    const composerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const composerData = JSON.stringify({
      fullConversationHeadersOnly: [{ bubbleId: "a" }],
    });
    const source = repairSnapshot(composerId, composerData, "{}", [
      { id: "a", value: { text: "a" } },
    ]);

    const spoofed = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(
        source,
        "planned",
        "actual-event-device",
        "spoofed-origin-device",
      ),
      REPAIR_PEER_DEVICE,
    );
    expect(spoofed.failureByResourceId[`chat/${composerId}`]).toContain(
      "origin does not match",
    );
    expect(spoofed.failureByResourceId[`chat/${composerId}`]).not.toContain(
      "\n",
    );

    const unknownLocal = await applyAutomaticRepair(
      fixture.request,
      automaticChatRepairChange(source, "planned"),
      undefined,
    );
    expect(unknownLocal.failureByResourceId[`chat/${composerId}`]).toContain(
      "cannot identify the local repository device",
    );
  });

  it("restores NULL chat values and NULL header columns as SQL NULL", async () => {
    const fixture = await createFixture();
    const composerId = "00000000-0000-4000-8000-000000000002";
    const snapshot: PortableChatSnapshot = {
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
    };
    const content = canonicalBytes(snapshot);
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
          semanticHash: sha256(content),
        },
        content,
      },
    ]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(result.retainedLocal).toEqual([]);
    expect(result.retainedLocalHashes[`chat/${composerId}`]).toBeUndefined();
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

  it("applies enrichment additively without replacing a richer live chat core", async () => {
    const fixture = await createFixture();
    const composerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const blob = Buffer.from("recovered provenance", "utf8");
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "live-header", 111);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, "live-composer-data");
    for (let index = 0; index < 111; index += 1) {
      seed
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(`bubbleId:${composerId}:b${index}`, `live-${index}`);
    }
    const localBefore = readPortableChatSnapshot(seed, composerId);
    if (localBefore === null) {
      throw new Error("expected the seeded local chat");
    }
    const expectedLocalCoreHash = portableChatCoreHash(localBefore);
    seed.close();
    const source = agentKvSnapshot(
      composerId,
      Array.from({ length: 115 }, (_, index) => `repo-${index}`),
      [blob],
    );

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      agentKvEnrichmentChange(source),
    ]);
    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(expectedLocalCoreHash).not.toBe(portableChatCoreHash(source));
    expect(result.localChatCoreHashes[`chat/${composerId}`]).toBeNull();

    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const header = database
        .prepare(
          "SELECT value, recency FROM composerHeaders WHERE composerId = ?",
        )
        .get(composerId);
      expect(header).toEqual({ value: "live-header", recency: 111 });
      expect(readKv(database, `composerData:${composerId}`)).toBe(
        "live-composer-data",
      );
      expect(readKv(database, `bubbleId:${composerId}:b0`)).toBe("live-0");
      expect(readKv(database, `bubbleId:${composerId}:b114`)).toBeUndefined();
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS total FROM cursorDiskKV WHERE key >= ? AND key < ?",
          )
          .get(`bubbleId:${composerId}:`, `bubbleId:${composerId};`),
      ).toEqual({ total: 111 });
      expect(readKv(database, `agentKv:blob:${sha256(blob)}`)).toBe(
        blob.toString("utf8"),
      );
    } finally {
      database.close();
    }
  });

  it("defers blob-only enrichment before reading an over-limit local chat body", async () => {
    const fixture = await createFixture({ maxPayloadBytes: 1024 });
    const composerId = "32323232-3232-4232-8232-323232323232";
    const recoveredBlob = Buffer.from("must remain unapplied", "utf8");
    const recoveredKey = `agentKv:blob:${sha256(recoveredBlob)}`;
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "local-header", 1);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, "{}");
    seed
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(4096))",
      )
      .run(`bubbleId:${composerId}:oversized`);
    seed.close();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      agentKvEnrichmentChange(
        agentKvSnapshot(composerId, ["small source"], [recoveredBlob]),
      ),
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped.join("\n")).toContain(
      "Chat enrichment deferred: the local conversation exceeds the bounded 1024-byte inspection limit",
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT typeof(value) AS valueType, length(CAST(value AS BLOB)) AS valueBytes " +
              "FROM cursorDiskKV WHERE key = ?",
          )
          .get(`bubbleId:${composerId}:oversized`),
      ).toEqual({ valueType: "blob", valueBytes: 4096 });
      expect(readKv(database, recoveredKey)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("applies the parent core when an enrichment reaches a peer first", async () => {
    const fixture = await createFixture();
    const composerId = "dadadada-dada-4ada-8ada-dadadadadada";
    const blob = Buffer.from("remote continuation", "utf8");
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "older-local-header", 1);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, "older-local-composer");
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:local`, "older-local-bubble");
    seed.close();
    const source = agentKvSnapshot(composerId, ["remote-new"], [blob]);
    const change = agentKvEnrichmentChange(source);
    change.change.metadata = {
      ...change.change.metadata,
      agentKvEnrichmentAppliesCore: true,
    };

    const result = await applyGlobalDatabaseChanges(fixture.request, [change]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT value, recency FROM composerHeaders WHERE composerId = ?",
          )
          .get(composerId),
      ).toEqual({ value: "repo-header", recency: 999 });
      expect(readKv(database, `composerData:${composerId}`)).toBe("repo-data");
      expect(readKv(database, `bubbleId:${composerId}:b0`)).toBe("remote-new");
      // Ordinary chat apply is additive: the older local row remains inert
      // rather than being deleted while the remote composerData takes effect.
      expect(readKv(database, `bubbleId:${composerId}:local`)).toBe(
        "older-local-bubble",
      );
      expect(readKv(database, `agentKv:blob:${sha256(blob)}`)).toBe(
        blob.toString("utf8"),
      );
    } finally {
      database.close();
    }
  });

  it("keeps blob-only enrichment semantics after checkpoint re-assertion", async () => {
    const fixture = await createFixture();
    const composerId = "dededede-dede-4ede-8ede-dededededede";
    const blob = Buffer.from("checkpointed enrichment blob", "utf8");
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "newer-local-header", 7);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, "newer-local-composer");
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:local`, "newer-local-bubble");
    seed.close();
    const change = agentKvEnrichmentChange(
      agentKvSnapshot(composerId, ["older-repo"], [blob]),
    );
    change.change.metadata = {
      ...change.change.metadata,
      syncOrigin: "checkpoint-marker",
      checkpointedSyncOrigin: "agent-kv-enrichment",
    };

    const result = await applyGlobalDatabaseChanges(fixture.request, [change]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `composerData:${composerId}`)).toBe(
        "newer-local-composer",
      );
      expect(readKv(database, `bubbleId:${composerId}:local`)).toBe(
        "newer-local-bubble",
      );
      expect(readKv(database, `bubbleId:${composerId}:b0`)).toBeUndefined();
      expect(readKv(database, `agentKv:blob:${sha256(blob)}`)).toBe(
        blob.toString("utf8"),
      );
    } finally {
      database.close();
    }
  });

  it("persists a local core shortcut only when enrichment found the same core", async () => {
    const fixture = await createFixture();
    const composerId = "34343434-3434-4434-8434-343434343434";
    const blob = Buffer.from("same-core blob", "utf8");
    const source = agentKvSnapshot(composerId, ["same-core"], [blob]);
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'workspace', 1, 2, 0, 0, 999, NULL, 'repo-header')`,
      )
      .run(composerId);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${composerId}`, "repo-data");
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${composerId}:b0`, "same-core");
    seed.close();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      agentKvEnrichmentChange(source),
    ]);

    expect(result.localChatCoreHashes[`chat/${composerId}`]).toBe(
      portableChatCoreHash(source),
    );
  });

  it("repairs hash-invalid agentKv rows but preserves hash-valid storage", async () => {
    const fixture = await createFixture();
    const composerId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const repaired = Buffer.from("replacement bytes", "utf8");
    const preserved = Buffer.from("already valid text", "utf8");
    const source = agentKvSnapshot(composerId, ["repo"], [repaired, preserved]);
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "live", 1);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${sha256(repaired)}`, "corrupt");
    // The incoming snapshot carries BLOB, but a hash-valid TEXT row is never
    // overwritten merely to normalize its SQLite representation.
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${sha256(preserved)}`, preserved.toString("utf8"));
    seed.close();

    await applyGlobalDatabaseChanges(fixture.request, [
      agentKvEnrichmentChange(source),
    ]);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `agentKv:blob:${sha256(repaired)}`)).toBe(
        repaired.toString("utf8"),
      );
      expect(readKvType(database, `agentKv:blob:${sha256(repaired)}`)).toBe(
        "blob",
      );
      expect(readKv(database, `agentKv:blob:${sha256(preserved)}`)).toBe(
        preserved.toString("utf8"),
      );
      expect(readKvType(database, `agentKv:blob:${sha256(preserved)}`)).toBe(
        "text",
      );
    } finally {
      database.close();
    }
  });

  it("preflights an oversized corrupt local agentKv row before replacing it", async () => {
    const fixture = await createFixture({ maxPayloadBytes: 1024 * 1024 });
    const composerId = "efefefef-efef-4fef-8fef-efefefefefef";
    const repaired = Buffer.from("bounded replacement", "utf8");
    const key = `agentKv:blob:${sha256(repaired)}`;
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "local", 1);
    seed
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(33554433))",
      )
      .run(key);
    seed.close();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      agentKvEnrichmentChange(
        agentKvSnapshot(composerId, ["repo"], [repaired]),
      ),
    ]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, key)).toBe(repaired.toString("utf8"));
      expect(
        database
          .prepare(
            "SELECT length(CAST(value AS BLOB)) AS bytes FROM cursorDiskKV WHERE key = ?",
          )
          .get(key),
      ).toEqual({ bytes: repaired.byteLength });
    } finally {
      database.close();
    }
  });

  it("leaves a source-missing local blob for bounded enrichment to publish", async () => {
    const fixture = await createFixture();
    const composerId = "12121212-1212-4212-8212-121212121212";
    const local = Buffer.from("available only on target", "utf8");
    const id = sha256(local);
    const snapshot = agentKvSnapshot(composerId, ["repo"], [], [id]);
    const content = canonicalBytes(snapshot);
    const seed = new DatabaseSync(fixture.databasePath);
    seed
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${id}`, local.toString("utf8"));
    seed.close();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "f".repeat(64),
          changeIndex: 0,
          resourceId: `chat/${composerId}`,
          kind: "chat",
          operation: "put",
          semanticHash: sha256(content),
        },
        content,
      },
    ]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(result.retainedLocal).toEqual([]);
    expect(result.retainedLocalHashes[`chat/${composerId}`]).toBeUndefined();
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `agentKv:blob:${id}`)).toBe(local.toString());
    } finally {
      database.close();
    }
  });

  it.each([
    {
      composerId: "15151515-1515-4515-8515-151515151515",
      incomingValueType: "blob" as const,
      existingValueType: "text" as const,
    },
    {
      composerId: "16161616-1616-4616-8616-161616161616",
      incomingValueType: "text" as const,
      existingValueType: "blob" as const,
    },
  ])(
    "hashes the preserved $existingValueType agentKv class instead of incoming $incomingValueType",
    async ({ composerId, incomingValueType, existingValueType }) => {
      const fixture = await createFixture();
      const bytes = Buffer.from("same content-addressed bytes", "utf8");
      const snapshot = agentKvSnapshot(composerId, ["core"], [bytes]);
      snapshot.agentKv.blobs[0]!.valueType = incomingValueType;
      const blobKey = snapshot.agentKv.blobs[0]!.key;
      const seed = new DatabaseSync(fixture.databasePath);
      seed
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(
          blobKey,
          existingValueType === "text" ? bytes.toString("utf8") : bytes,
        );
      seed.close();

      const result = await applyGlobalDatabaseChanges(fixture.request, [
        ordinaryChatChange(snapshot),
      ]);
      const expected: PortableChatSnapshotV2 = {
        ...snapshot,
        agentKv: {
          ...snapshot.agentKv,
          blobs: snapshot.agentKv.blobs.map((row) => ({
            ...row,
            valueType: existingValueType,
          })),
        },
      };

      expect(result.applied).toEqual([`chat/${composerId}`]);
      expect(result.retainedLocalHashes[`chat/${composerId}`]).toBe(
        sha256(canonicalBytes(expected)),
      );
      const database = new DatabaseSync(fixture.databasePath, {
        readOnly: true,
      });
      try {
        expect(readKvType(database, blobKey)).toBe(existingValueType);
      } finally {
        database.close();
      }
    },
  );

  it("hashes legacy core rows with their normalized SQLite classes", async () => {
    const fixture = await createFixture();
    const composerId = "17171717-1717-4717-8717-171717171717";
    const base = agentKvSnapshot(composerId, [], []);
    const utf8 = Buffer.from("legacy text", "utf8");
    const binary = Buffer.from([0xff, 0x00, 0xfe, 0x80]);
    const snapshot: PortableChatSnapshot = {
      schemaVersion: 1,
      composerId,
      header: base.header,
      composerData: {
        key: `composerData:${composerId}`,
        valueBase64: utf8.toString("base64"),
      },
      bubbles: [
        {
          key: `bubbleId:${composerId}:a`,
          valueBase64: utf8.toString("base64"),
        },
        {
          key: `bubbleId:${composerId}:b`,
          valueBase64: binary.toString("base64"),
        },
      ],
    };
    const expected: PortableChatSnapshot = {
      ...snapshot,
      composerData: { ...snapshot.composerData, valueType: "text" },
      bubbles: [
        { ...snapshot.bubbles[0]!, valueType: "text" },
        { ...snapshot.bubbles[1]!, valueType: "blob" },
      ],
    };

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      ordinaryChatChange(snapshot),
    ]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(result.retainedLocalHashes[`chat/${composerId}`]).toBe(
      sha256(canonicalBytes(expected)),
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKvType(database, snapshot.composerData.key)).toBe("text");
      expect(readKvType(database, snapshot.bubbles[0]!.key)).toBe("text");
      expect(readKvType(database, snapshot.bubbles[1]!.key)).toBe("blob");
    } finally {
      database.close();
    }
  });

  it("hashes bubbles in scanner order and drops unwritten header fields", async () => {
    const fixture = await createFixture();
    const composerId = "18181818-1818-4818-8818-181818181818";
    const base = agentKvSnapshot(composerId, ["first", "second"], []);
    const header = {
      ...base.header,
      futureHeaderField: "not representable in composerHeaders",
    };
    const snapshot: PortableChatSnapshot = {
      schemaVersion: 1,
      composerId,
      header,
      composerData: base.composerData,
      bubbles: [base.bubbles[1]!, base.bubbles[0]!],
    };
    const expected: PortableChatSnapshot = {
      schemaVersion: 1,
      composerId,
      header: {
        composerId: header.composerId,
        workspaceId: header.workspaceId,
        createdAt: header.createdAt,
        lastUpdatedAt: header.lastUpdatedAt,
        isArchived: header.isArchived,
        isSubagent: header.isSubagent,
        recency: header.recency,
        checkpointAt: header.checkpointAt,
        value: header.value,
      },
      composerData: base.composerData,
      bubbles: [base.bubbles[0]!, base.bubbles[1]!],
    };

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      ordinaryChatChange(snapshot),
    ]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(result.retainedLocalHashes[`chat/${composerId}`]).toBe(
      sha256(canonicalBytes(expected)),
    );
  });

  it("rejects a TEXT core row whose bytes are not valid UTF-8", async () => {
    const fixture = await createFixture();
    const composerId = "19191919-1919-4919-8919-191919191919";
    const base = agentKvSnapshot(composerId, ["valid"], []);
    const snapshot: PortableChatSnapshot = {
      schemaVersion: 1,
      composerId,
      header: base.header,
      composerData: base.composerData,
      bubbles: [
        {
          key: `bubbleId:${composerId}:bad`,
          valueBase64: Buffer.from([0xff, 0xfe]).toString("base64"),
          valueType: "text",
        },
      ],
    };

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      ordinaryChatChange(snapshot),
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped.join("\n")).toContain(
      "A TEXT cursorDiskKV row is not valid UTF-8",
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT composerId FROM composerHeaders WHERE composerId = ?")
          .get(composerId),
      ).toBeUndefined();
      expect(readKv(database, snapshot.composerData.key)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("streams the exact canonical v2 hash after workspace remapping", async () => {
    const fixture = await createFixture();
    const composerId = "14141414-1414-4414-8414-141414141414";
    const mappedWorkspaceId = "mapped-v2-workspace";
    await mkdir(
      join(
        fixture.request.paths.workspaceStorageRoot,
        mappedWorkspaceId,
      ),
      { recursive: true },
    );
    await writeFile(
      join(
        fixture.request.paths.workspaceStorageRoot,
        mappedWorkspaceId,
        "workspace.json",
      ),
      JSON.stringify({ folder: "file:///C:/work/mapped-v2" }),
      "utf8",
    );
    fixture.request.workspaceMappings.workspace = mappedWorkspaceId;
    const snapshot = agentKvSnapshot(
      composerId,
      ["mapped core"],
      [Buffer.from("mapped blob", "utf8")],
    );
    snapshot.header.value = 'mapped "\\\n😀\ud800';
    const content = canonicalBytes(snapshot);

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      {
        change: {
          eventHash: "c".repeat(64),
          changeIndex: 0,
          resourceId: `chat/${composerId}`,
          kind: "chat",
          operation: "put",
          semanticHash: sha256(content),
        },
        content,
      },
    ]);

    expect(result.applied).toEqual([`chat/${composerId}`]);
    expect(result.retainedLocal).toEqual([`chat/${composerId}`]);
    expect(result.retainedLocalHashes[`chat/${composerId}`]).toBe(
      sha256(
        canonicalBytes({
          ...snapshot,
          header: {
            ...snapshot.header,
            workspaceId: mappedWorkspaceId,
          },
        }),
      ),
    );
  });

  it(
    "does not materialize many source-missing local blobs beside a near-limit core",
    async () => {
      const maxPayloadBytes = 8 * 1024 * 1024;
      const fixture = await createFixture({ maxPayloadBytes });
      const composerId = "13131313-1313-4313-8313-131313131313";
      const localBlobBytes = 256 * 1024;
      const localBlobs = Array.from({ length: 24 }, (_, index) =>
        Buffer.alloc(localBlobBytes, index + 1),
      );
      const localIds = localBlobs.map((value) => sha256(value));
      const snapshot = agentKvSnapshot(
        composerId,
        ["near-limit core"],
        [],
        localIds,
      );
      const largeHeaderValue = '"\n\\'.repeat(1_100_000);
      snapshot.header.value = largeHeaderValue;
      const content = canonicalBytes(snapshot);
      expect(content.byteLength).toBeGreaterThan(6 * 1024 * 1024);
      expect(content.byteLength).toBeLessThan(maxPayloadBytes);

      const seed = new DatabaseSync(fixture.databasePath);
      const insert = seed.prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
      );
      for (let index = 0; index < localIds.length; index += 1) {
        insert.run(`agentKv:blob:${localIds[index]!}`, localBlobs[index]!);
      }
      seed.close();

      type BufferToString = (
        this: Buffer,
        encoding?: BufferEncoding,
        start?: number,
        end?: number,
      ) => string;
      const bufferPrototype = Buffer.prototype as unknown as {
        toString: BufferToString;
      };
      const originalToString = bufferPrototype.toString;
      let localBlobBase64Materializations = 0;
      const toStringSpy = vi
        .spyOn(bufferPrototype, "toString")
        .mockImplementation(function (
          this: unknown,
          ...args: unknown[]
        ): string {
          const buffer = this as Buffer;
          const [encoding, start, end] = args as [
            BufferEncoding | undefined,
            number | undefined,
            number | undefined,
          ];
          // The crash-safe journal legitimately serializes the incoming core.
          // The old ordinary-v2 merge also converted each exact-size local
          // source-missing blob, which is the forbidden extra allocation here.
          if (
            encoding === "base64" &&
            buffer.byteLength === localBlobBytes
          ) {
            localBlobBase64Materializations += 1;
          }
          return originalToString.call(buffer, encoding, start, end);
        });

      let result: Awaited<ReturnType<typeof applyGlobalDatabaseChanges>>;
      try {
        result = await applyGlobalDatabaseChanges(fixture.request, [
          {
            change: {
              eventHash: "d".repeat(64),
              changeIndex: 0,
              resourceId: `chat/${composerId}`,
              kind: "chat",
              operation: "put",
              semanticHash: sha256(content),
            },
            content,
          },
        ]);
      } finally {
        toStringSpy.mockRestore();
      }

      expect(result!.applied).toEqual([`chat/${composerId}`]);
      expect(result!.retainedLocal).toEqual([]);
      expect(
        result!.retainedLocalHashes[`chat/${composerId}`],
      ).toBeUndefined();
      expect(localBlobBase64Materializations).toBe(0);

      const database = new DatabaseSync(fixture.databasePath, {
        readOnly: true,
      });
      try {
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS total,
                      SUM(length(CAST(value AS BLOB))) AS bytes
               FROM cursorDiskKV
               WHERE key LIKE 'agentKv:blob:%'`,
            )
            .get(),
        ).toEqual({
          total: localBlobs.length,
          bytes: localBlobs.length * localBlobBytes,
        });
        expect(
          database
            .prepare(
              "SELECT length(CAST(value AS BLOB)) AS bytes FROM cursorDiskKV WHERE key = ?",
            )
            .get(`bubbleId:${composerId}:b0`),
        ).toEqual({ bytes: Buffer.byteLength("near-limit core") });
        expect(
          database
            .prepare(
              "SELECT length(value) AS chars FROM composerHeaders WHERE composerId = ?",
            )
            .get(composerId),
        ).toEqual({ chars: largeHeaderValue.length });
      } finally {
        database.close();
      }
    },
    30_000,
  );

  it("does not materialize core rows beside a partial local chat", async () => {
    const fixture = await createFixture();
    const composerId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const blob = Buffer.from("only additive blob", "utf8");
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "partial-live", 7);
    seed.close();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      agentKvEnrichmentChange(agentKvSnapshot(composerId, ["repo"], [blob])),
    ]);
    expect(result.localChatCoreHashes[`chat/${composerId}`]).toBeNull();
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readKv(database, `composerData:${composerId}`)).toBeUndefined();
      expect(readKv(database, `bubbleId:${composerId}:b0`)).toBeUndefined();
      expect(readKv(database, `agentKv:blob:${sha256(blob)}`)).toBe(
        blob.toString("utf8"),
      );
      expect(
        database
          .prepare("SELECT value FROM composerHeaders WHERE composerId = ?")
          .get(composerId),
      ).toEqual({ value: "partial-live" });
    } finally {
      database.close();
    }
  });

  it.each([undefined, false])(
    "keeps a wholly absent chat core absent for legacy blob-only enrichment (%s)",
    async (appliesCore) => {
      const fixture = await createFixture();
      const composerId =
        appliesCore === false
          ? "acacacac-acac-4cac-8cac-acacacacacac"
          : "abababab-abab-4bab-8bab-abababababab";
      const blob = Buffer.from("portable blob", "utf8");
      const source = agentKvSnapshot(composerId, ["first", "second"], [blob]);
      const change = agentKvEnrichmentChange(source);
      if (appliesCore === false) {
        change.change.metadata = {
          ...change.change.metadata,
          agentKvEnrichmentAppliesCore: false,
        };
      }

      const result = await applyGlobalDatabaseChanges(fixture.request, [change]);
      expect(result.applied).toEqual([`chat/${composerId}`]);
      expect(result.localChatCoreHashes[`chat/${composerId}`]).toBeNull();
      const database = new DatabaseSync(fixture.databasePath, {
        readOnly: true,
      });
      try {
        expect(readKv(database, `composerData:${composerId}`)).toBeUndefined();
        expect(readKv(database, `bubbleId:${composerId}:b0`)).toBeUndefined();
        expect(readKv(database, `bubbleId:${composerId}:b1`)).toBeUndefined();
        expect(readKv(database, `agentKv:blob:${sha256(blob)}`)).toBe(
          blob.toString("utf8"),
        );
        expect(
          database
            .prepare("SELECT value FROM composerHeaders WHERE composerId = ?")
            .get(composerId),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    },
  );

  it("rejects a hash-invalid blob without materializing an absent chat core", async () => {
    const fixture = await createFixture();
    const composerId = "adadadad-adad-4dad-8dad-adadadadadad";
    const validBlob = Buffer.from("valid portable blob", "utf8");
    const source = agentKvSnapshot(composerId, ["source core"], [validBlob]);
    source.agentKv.blobs[0]!.valueBase64 = Buffer.from(
      "bytes that do not match the content-addressed key",
      "utf8",
    ).toString("base64");

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      agentKvEnrichmentChange(source),
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped.join("\n")).toContain(
      "Chat snapshot agentKv content address is invalid",
    );
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT value FROM composerHeaders WHERE composerId = ?")
          .get(composerId),
      ).toBeUndefined();
      expect(readKv(database, `composerData:${composerId}`)).toBeUndefined();
      expect(readKv(database, `bubbleId:${composerId}:b0`)).toBeUndefined();
      expect(
        database
          .prepare(
            "SELECT value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rolls back earlier agentKv writes when a later blob write fails", async () => {
    const fixture = await createFixture();
    const composerId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const values = [Buffer.from("first"), Buffer.from("second")].sort((a, b) =>
      sha256(a).localeCompare(sha256(b)),
    );
    const failKey = `agentKv:blob:${sha256(values[1]!)}`;
    const seed = new DatabaseSync(fixture.databasePath);
    insertTestHeader(seed, composerId, "partial", 1);
    seed.exec(
      `CREATE TRIGGER fail_second_agent_blob
       BEFORE INSERT ON cursorDiskKV
       WHEN NEW.key = '${failKey}'
       BEGIN SELECT RAISE(ABORT, 'injected agentKv failure'); END`,
    );
    seed.close();

    const result = await applyGlobalDatabaseChanges(fixture.request, [
      agentKvEnrichmentChange(agentKvSnapshot(composerId, ["repo"], values)),
    ]);
    expect(result.applied).toEqual([]);
    expect(result.skipped.join(" ")).toContain("injected agentKv failure");
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        readKv(database, `agentKv:blob:${sha256(values[0]!)}`),
      ).toBeUndefined();
      expect(readKv(database, failKey)).toBeUndefined();
      expect(
        database
          .prepare("SELECT value FROM composerHeaders WHERE composerId = ?")
          .get(composerId),
      ).toEqual({ value: "partial" });
    } finally {
      database.close();
    }
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

function readKv(
  database: InstanceType<typeof DatabaseSync>,
  key: string,
): string | undefined {
  const row = database
    .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
    .get(key) as { value?: Uint8Array | string | null } | undefined;
  if (row?.value === undefined || row.value === null) {
    return undefined;
  }
  return typeof row.value === "string"
    ? row.value
    : Buffer.from(row.value).toString("utf8");
}

function insertTestHeader(
  database: InstanceType<typeof DatabaseSync>,
  composerId: string,
  value: string,
  recency: number,
): void {
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, 'workspace', 1, 2, 0, 0, ?, NULL, ?)`,
    )
    .run(composerId, recency, value);
}

function agentKvSnapshot(
  composerId: string,
  bubbles: readonly string[],
  blobValues: readonly Buffer[],
  missingIds: readonly string[] = [],
): PortableChatSnapshotV2 {
  const blobs = blobValues
    .map((bytes) => ({
      key: `agentKv:blob:${sha256(bytes)}`,
      valueBase64: bytes.toString("base64"),
      valueType: "blob" as const,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    schemaVersion: 2,
    composerId,
    header: {
      composerId,
      workspaceId: "workspace",
      createdAt: 1,
      lastUpdatedAt: 2,
      isArchived: 0,
      isSubagent: 0,
      recency: 999,
      checkpointAt: null,
      value: "repo-header",
    },
    composerData: {
      key: `composerData:${composerId}`,
      valueBase64: Buffer.from("repo-data", "utf8").toString("base64"),
      valueType: "text",
    },
    bubbles: bubbles.map((value, index) => ({
      key: `bubbleId:${composerId}:b${index}`,
      valueBase64: Buffer.from(value, "utf8").toString("base64"),
      valueType: "text" as const,
    })),
    agentKv: {
      blobs,
      referencedIds: [
        ...new Set([
          ...blobs.map((blob) => blob.key.slice("agentKv:blob:".length)),
          ...missingIds,
        ]),
      ].sort(),
      missingIds: [...missingIds].sort(),
    },
  };
}

function agentKvEnrichmentChange(
  snapshot: PortableChatSnapshotV2,
): PreparedHelperChange {
  const content = canonicalBytes(snapshot);
  return {
    change: {
      eventHash: "e".repeat(64),
      changeIndex: 0,
      resourceId: `chat/${snapshot.composerId}`,
      kind: "chat",
      operation: "put",
      semanticHash: sha256(content),
      metadata: { syncOrigin: "agent-kv-enrichment" },
    },
    content,
  };
}

function ordinaryChatChange(
  snapshot: PortableChatSnapshot,
  eventHashCharacter = "b",
): PreparedHelperChange {
  const content = canonicalBytes(snapshot);
  return {
    change: {
      eventHash: eventHashCharacter.repeat(64),
      changeIndex: 0,
      resourceId: `chat/${snapshot.composerId}`,
      kind: "chat",
      operation: "put",
      semanticHash: sha256(content),
    },
    content,
  };
}

function repairSnapshot(
  composerId: string,
  composerData: string,
  headerValue: string,
  bubbles: Array<{ id: string; value: unknown }>,
): PortableChatSnapshot {
  return {
    schemaVersion: 1,
    composerId,
    header: {
      composerId,
      workspaceId: "workspace",
      createdAt: 1,
      lastUpdatedAt: 2,
      isArchived: 0,
      isSubagent: 0,
      recency: 1,
      checkpointAt: null,
      value: headerValue,
    },
    composerData: {
      key: `composerData:${composerId}`,
      valueBase64: Buffer.from(composerData, "utf8").toString("base64"),
      valueType: "text",
    },
    bubbles: bubbles.map((bubble) => ({
      key: `bubbleId:${composerId}:${bubble.id}`,
      valueBase64: Buffer.from(JSON.stringify(bubble.value), "utf8").toString(
        "base64",
      ),
      valueType: "text" as const,
    })),
  };
}

function automaticChatRepairChange(
  snapshot: PortableChatSnapshot,
  fingerprint: string,
  sourceDeviceId = REPAIR_ORIGIN_DEVICE,
  repairOriginDeviceId = REPAIR_ORIGIN_DEVICE,
): PreparedHelperChange {
  const content = canonicalBytes(snapshot);
  return {
    change: {
      eventHash: "9".repeat(64),
      changeIndex: 0,
      sourceDeviceId,
      resourceId: `chat/${snapshot.composerId}`,
      kind: "chat",
      operation: "put",
      semanticHash: sha256(content),
      metadata: {
        syncOrigin: "automatic-chat-repair",
        repairFingerprint: fingerprint,
        repairOriginDeviceId,
      },
    },
    content,
  };
}

function checkpointAutomaticRepairChange(change: PreparedHelperChange): void {
  change.change.sourceDeviceId = REPAIR_MARKER_DEVICE;
  change.change.metadata = {
    ...change.change.metadata,
    syncOrigin: "checkpoint-marker",
    checkpointedSyncOrigin: "automatic-chat-repair",
    checkpointedSourceDeviceId: REPAIR_ORIGIN_DEVICE,
    checkpointedVersionId: `${"8".repeat(64)}#0`,
  };
}

function repairFingerprint(snapshot: PortableChatSnapshot): string {
  const audit = auditChatReferences(snapshot);
  if (audit.status !== "known") {
    throw new Error(`Expected a known repair snapshot: ${audit.reason}`);
  }
  return audit.fingerprint;
}

function hostileRepairJson(): string {
  return `[${Array.from({ length: 87_400 }, () => "{}").join(",")}]`;
}

function smallRepairJson(): string {
  return `[${Array.from({ length: 1_000 }, () => "{}").join(",")}]`;
}

function serializedRootState(rootId: string): string {
  return `~${Buffer.concat([
    Buffer.from([0x0a, 0x20]),
    Buffer.from(rootId, "hex"),
  ]).toString("base64")}`;
}

function applyAutomaticRepair(
  request: HelperRequest,
  change: PreparedHelperChange,
  localDeviceId?: string,
) {
  return applyGlobalDatabaseChanges(
    request,
    [change],
    undefined,
    undefined,
    undefined,
    localDeviceId,
  );
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
