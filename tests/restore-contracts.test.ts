import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import {
  recoverInterruptedApplyJournals,
  restoreDatabaseBackup,
} from "../src/helper/database";

const { DatabaseSync } = sqlite;
const describeWithBackup =
  typeof sqlite.backup === "function" ? describe : describe.skip;

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cursor-restore-contract-"));
  temporaryRoots.push(root);
  return root;
}

function createWorkspaceDatabase(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  database.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  database.exec("INSERT INTO ItemTable(key, value) VALUES ('layout', 'original')");
  database.exec("INSERT INTO cursorDiskKV(key, value) VALUES ('kv', 'original')");
  // A table outside the contract, which a logical restore must never touch.
  database.exec("CREATE TABLE futureTable (id TEXT PRIMARY KEY, value TEXT)");
  database.exec("INSERT INTO futureTable(id, value) VALUES ('keep', 'untouched')");
  database.close();
}

function createStoreDatabase(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value)");
  database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data)");
  database.exec("INSERT INTO meta(key, value) VALUES ('schema', 'original')");
  database.exec("INSERT INTO blobs(id, data) VALUES ('blob', 'original')");
  database.close();
}

function readCell(
  path: string,
  table: string,
  keyColumn: string,
  key: string,
  valueColumn: string,
): unknown {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT "${valueColumn}" AS v FROM "${table}" WHERE "${keyColumn}" = ?`)
      .get(key) as { v?: unknown } | undefined;
    return row?.v ?? null;
  } finally {
    database.close();
  }
}

async function backupOf(livePath: string, backupPath: string): Promise<void> {
  const source = new DatabaseSync(livePath, { readOnly: true });
  try {
    await sqlite.backup(source, backupPath, { rate: 100 });
  } finally {
    source.close();
  }
}

/**
 * Every contract the Restore Backup command can pass to the helper, exercised
 * on the destructive path. These used to be covered only for "global": a wrong
 * table name in restoreTablesForContract or a wrong column list in the
 * contract assertion would have shipped green and surfaced at the
 * recovery-of-last-resort moment.
 */
describeWithBackup("restoreDatabaseBackup contracts", () => {
  it("restores a workspace database and leaves unlisted tables alone", async () => {
    const root = await scratch();
    const live = join(root, "state.vscdb");
    const backup = join(root, "backup.vscdb");
    createWorkspaceDatabase(live);
    await backupOf(live, backup);

    const damage = new DatabaseSync(live);
    damage.exec("UPDATE ItemTable SET value = 'changed' WHERE key = 'layout'");
    damage.exec("DELETE FROM cursorDiskKV");
    damage.exec("UPDATE futureTable SET value = 'still-untouched' WHERE id = 'keep'");
    damage.close();

    const preRestore = await restoreDatabaseBackup(
      live,
      backup,
      root,
      "00000000-0000-4000-8000-0000000000aa",
      "workspace",
    );

    expect(readCell(live, "ItemTable", "key", "layout", "value")).toBe("original");
    expect(readCell(live, "cursorDiskKV", "key", "kv", "value")).toBe("original");
    // Outside the contract: the restore rewrites allowlisted tables only.
    expect(readCell(live, "futureTable", "id", "keep", "value")).toBe("still-untouched");
    expect(readCell(preRestore, "ItemTable", "key", "layout", "value")).toBe("changed");
  });

  it("restores a chat store database under the store contract", async () => {
    const root = await scratch();
    const live = join(root, "store.db");
    const backup = join(root, "backup.db");
    createStoreDatabase(live);
    await backupOf(live, backup);

    const damage = new DatabaseSync(live);
    damage.exec("UPDATE meta SET value = 'changed' WHERE key = 'schema'");
    damage.exec("DELETE FROM blobs");
    damage.close();

    await restoreDatabaseBackup(
      live,
      backup,
      root,
      "00000000-0000-4000-8000-0000000000ab",
      "store",
    );

    expect(readCell(live, "meta", "key", "schema", "value")).toBe("original");
    expect(readCell(live, "blobs", "id", "blob", "data")).toBe("original");
  });

  it("restores only ItemTable under the item-table contract", async () => {
    const root = await scratch();
    const live = join(root, "state.vscdb");
    const backup = join(root, "backup.vscdb");
    createWorkspaceDatabase(live);
    await backupOf(live, backup);

    const damage = new DatabaseSync(live);
    damage.exec("UPDATE ItemTable SET value = 'changed' WHERE key = 'layout'");
    damage.exec("UPDATE cursorDiskKV SET value = 'kept-current' WHERE key = 'kv'");
    damage.close();

    await restoreDatabaseBackup(
      live,
      backup,
      root,
      "00000000-0000-4000-8000-0000000000ac",
      "item-table",
    );

    expect(readCell(live, "ItemTable", "key", "layout", "value")).toBe("original");
    // Not in the item-table contract, so the current value stays.
    expect(readCell(live, "cursorDiskKV", "key", "kv", "value")).toBe("kept-current");
  });

  it("refuses a backup that does not satisfy the requested contract", async () => {
    const root = await scratch();
    const live = join(root, "state.vscdb");
    const backup = join(root, "backup.db");
    createWorkspaceDatabase(live);
    const store = join(root, "store-source.db");
    createStoreDatabase(store);
    await backupOf(store, backup);

    await expect(
      restoreDatabaseBackup(
        live,
        backup,
        root,
        "00000000-0000-4000-8000-0000000000ad",
        "workspace",
      ),
    ).rejects.toThrow();
    expect(readCell(live, "ItemTable", "key", "layout", "value")).toBe("original");
  });
});

describeWithBackup("interrupted restore journal recovery", () => {
  async function journalFixture(): Promise<{
    root: string;
    live: string;
    backup: string;
    journalPath: string;
  }> {
    const root = await scratch();
    const live = join(root, "state.vscdb");
    const backup = join(root, "backup.vscdb");
    createWorkspaceDatabase(live);
    await backupOf(live, backup);
    const journalPath = join(root, "restore-00000000-0000-4000-8000-0000000000ba.json");
    await writeFile(
      journalPath,
      JSON.stringify({
        version: 3,
        requestId: "00000000-0000-4000-8000-0000000000ba",
        status: "applying",
        databasePath: live,
        backupPath: backup,
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        contract: "workspace",
        preRestoreBackupPath: null,
      }),
      "utf8",
    );
    return { root, live, backup, journalPath };
  }

  it("marks a journal failed when its backup no longer validates, and keeps going", async () => {
    const fixture = await journalFixture();
    // Truncate the source so it stops being a database at all.
    await writeFile(fixture.backup, "no longer sqlite", "utf8");

    // The recovery loop must survive this: one bad journal used to throw out
    // of recoverInterruptedApplyJournals, which runs first in EVERY helper
    // mode - so every later apply and every shutdown export failed forever.
    await recoverInterruptedApplyJournals(fixture.root, fixture.live);

    const journal = JSON.parse(await readFile(fixture.journalPath, "utf8")) as {
      status: string;
      completedAt: string | null;
      error: string | null;
    };
    expect(journal.status).toBe("failed");
    expect(journal.completedAt).not.toBeNull();
    expect(journal.error).toMatch(/no longer validates/i);
    expect(readCell(fixture.live, "ItemTable", "key", "layout", "value")).toBe("original");
  });

  it("marks a journal failed when the backup schema no longer matches", async () => {
    const fixture = await journalFixture();
    const drift = new DatabaseSync(fixture.live);
    drift.exec("ALTER TABLE ItemTable ADD COLUMN extra TEXT");
    drift.close();

    await recoverInterruptedApplyJournals(fixture.root, fixture.live);

    const journal = JSON.parse(await readFile(fixture.journalPath, "utf8")) as {
      status: string;
      error: string | null;
    };
    expect(journal.status).toBe("failed");
    expect(journal.error).toMatch(/was not retried/i);
  });

  it("leaves the journal pending when Cursor reopened before the replay", async () => {
    const fixture = await journalFixture();
    const reopened = new Error("Cursor was reopened");

    await expect(
      recoverInterruptedApplyJournals(fixture.root, fixture.live, async () => {
        throw reopened;
      }),
    ).rejects.toThrow("Cursor was reopened");

    // Pending, not failed: the next closed-Cursor helper replays it.
    const journal = JSON.parse(await readFile(fixture.journalPath, "utf8")) as {
      status: string;
      completedAt: string | null;
    };
    expect(journal.completedAt).toBeNull();
    expect(readCell(fixture.live, "ItemTable", "key", "layout", "value")).toBe("original");
  });

  it("replays a healthy interrupted restore and clears its journal", async () => {
    const fixture = await journalFixture();
    const damage = new DatabaseSync(fixture.live);
    damage.exec("DELETE FROM ItemTable");
    damage.close();

    await recoverInterruptedApplyJournals(fixture.root, fixture.live);

    expect(readCell(fixture.live, "ItemTable", "key", "layout", "value")).toBe("original");
    const remaining = (await readdir(fixture.root)).filter((name) =>
      name.startsWith("restore-"),
    );
    expect(remaining).toEqual([]);
  });
});
