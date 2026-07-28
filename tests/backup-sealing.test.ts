import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import {
  backupDatabase,
  openDatabase,
  sealBackupFile,
} from "../src/platform/sqlite";

const describeWithBackup =
  typeof sqlite.backup === "function" ? describe : describe.skip;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ source: string; backup: string }> {
  const root = await mkdtemp(join(tmpdir(), "cursor-backup-sealing-"));
  temporaryRoots.push(root);
  const source = join(root, "state.vscdb");
  const database = openDatabase(source);
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  database.exec("INSERT INTO ItemTable (key, value) VALUES ('a', 'first')");
  database.close();
  return { source, backup: join(root, "backup.vscdb") };
}

function journalMode(path: string): string {
  const database = openDatabase(path, { readOnly: true });
  try {
    return String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  } finally {
    database.close();
  }
}

describeWithBackup("sealing a freshly written backup", () => {
  it("leaves no sidecars behind when the backup is read again", async () => {
    const { source, backup } = await fixture();
    const reader = openDatabase(source, { readOnly: true });
    try {
      await backupDatabase(reader, backup, { rate: 100 });
    } finally {
      reader.close();
    }

    await sealBackupFile(backup);

    // A snapshot has no concurrent readers, so it has no use for a log; the
    // point of the mode change is that reading it never recreates one.
    expect(journalMode(backup)).toBe("delete");
    expect(existsSync(`${backup}-wal`)).toBe(false);
    expect(existsSync(`${backup}-shm`)).toBe(false);
  });

  it("keeps every row the backup captured", async () => {
    const { source, backup } = await fixture();
    const reader = openDatabase(source, { readOnly: true });
    try {
      await backupDatabase(reader, backup, { rate: 100 });
    } finally {
      reader.close();
    }

    await sealBackupFile(backup);

    const sealed = openDatabase(backup, { readOnly: true });
    try {
      expect(sealed.prepare("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(sealed.prepare("SELECT key, value FROM ItemTable").all()).toEqual([
        { key: "a", value: "first" },
      ]);
    } finally {
      sealed.close();
    }
  });

  it("is a no-op on something that is not a database rather than throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-backup-sealing-"));
    temporaryRoots.push(root);
    const notADatabase = join(root, "notes.txt");
    await writeFile(notADatabase, "not a database", "utf8");

    // Sealing is housekeeping that runs after a backup is already written, so
    // it must never be the reason an apply fails.
    await expect(sealBackupFile(notADatabase)).resolves.toBeUndefined();
    await expect(sealBackupFile(join(root, "missing.vscdb"))).resolves.toBeUndefined();
  });
});
