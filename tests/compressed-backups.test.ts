import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { maintainCompressedBackups, resolveBackupSource, withReadableBackup } from "../src/helper/compressedBackups";
import { recoverInterruptedApplyJournals, restoreDatabaseBackup, validateDatabaseFile } from "../src/helper/database";
import { enforceBackupRetention } from "../src/helper/backupRetention";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function createDatabase(path: string, value: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
        lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT);`);
    database.prepare("INSERT INTO ItemTable VALUES ('test', ?)").run(value);
    database.prepare("INSERT INTO cursorDiskKV VALUES ('large', ?)").run("x".repeat(1024 * 1024));
  } finally { database.close(); }
}

function readValue(path: string): unknown {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return database.prepare("SELECT value FROM ItemTable WHERE key = 'test'").get()?.value; }
  finally { database.close(); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cursor-compressed-backup-"));
  roots.push(root);
  const storageRoot = join(root, "storage"), backupRoot = join(storageRoot, "backups");
  await mkdir(backupRoot, { recursive: true });
  const globalDatabase = join(root, "live.vscdb");
  createDatabase(globalDatabase, "live");
  return {
    root, storageRoot, backupRoot, globalDatabase,
    options: { storageRoot, paths: { globalDatabase, workspaceStorageRoot: join(root, "workspaces"), profilesRoot: join(root, "profiles") }, backups: [],
      validate: validateDatabaseFile, beforeWork: async () => {}, heartbeat: () => {} },
  };
}

async function backup(root: string, name: string, ageMs: number, value = name): Promise<string> {
  const path = join(root, name);
  createDatabase(path, value);
  const time = new Date(Date.now() - ageMs);
  await utimes(path, time, time);
  return path;
}

describe("one verified compressed backup per database", () => {
  it("migrates legacy global backups, verifies round-trip and restores an old journal path", async () => {
    const f = await fixture();
    const older = await backup(f.backupRoot, "state-old.vscdb", 20_000);
    const newest = await backup(f.backupRoot, "state-new.vscdb", 10_000, "before");
    const original = await readFile(newest);
    const result = await maintainCompressedBackups(f.options);
    expect(result.warnings).toEqual([]);
    expect(await resolveBackupSource(older)).toBeNull();
    expect(await resolveBackupSource(newest)).toBe(`${newest}.gz`);
    expect((await stat(`${newest}.gz`)).size).toBeLessThan(original.length / 10);
    expect(await readdir(f.backupRoot)).toEqual(expect.arrayContaining(["state-new.vscdb.gz", "state-new.vscdb.gz.json"]));
    await withReadableBackup(newest, async source => expect(await readFile(source)).toEqual(original));
    await restoreDatabaseBackup(f.globalDatabase, newest, f.storageRoot);
    expect(readValue(f.globalDatabase)).toBe("before");
    expect((await readdir(f.backupRoot)).some(name => name.startsWith(".restore-"))).toBe(false);
  });

  it("replaces the previous archive only after the next generation is verified", async () => {
    const f = await fixture();
    const old = await backup(f.backupRoot, "state-old.vscdb", 20_000);
    await maintainCompressedBackups(f.options);
    const current = await backup(f.backupRoot, "state-current.vscdb", 1_000);
    const result = await maintainCompressedBackups(f.options);
    expect(result.warnings).toEqual([]);
    expect(await resolveBackupSource(old)).toBeNull();
    expect(await resolveBackupSource(current)).toBe(`${current}.gz`);
    expect((await readdir(f.backupRoot)).sort()).toEqual(["state-current.vscdb.gz", "state-current.vscdb.gz.json"]);
    expect((await maintainCompressedBackups(f.options)).deletedBytes).toBe(0);
  });

  it("keeps a separate latest archive for a different workspace database", async () => {
    const f = await fixture();
    await backup(f.backupRoot, "state-old.vscdb", 20_000);
    await backup(f.backupRoot, "state-new.vscdb", 10_000);
    const id = "a".repeat(32);
    await backup(f.backupRoot, `workspace-${id}-old.vscdb`, 20_000);
    await backup(f.backupRoot, `workspace-${id}-new.vscdb`, 10_000);
    const result = await maintainCompressedBackups(f.options);
    expect(result.warnings).toEqual([]);
    expect(result.backups.map(b => b.contract).sort()).toEqual(["global", "workspace"]);
    expect((await readdir(f.backupRoot)).filter(n => n.endsWith(".gz"))).toHaveLength(2);
  });

  it("preserves old archives and the new raw backup if validation fails", async () => {
    const f = await fixture();
    const old = await backup(f.backupRoot, "state-old.vscdb", 20_000);
    await maintainCompressedBackups(f.options);
    const current = await backup(f.backupRoot, "state-current.vscdb", 1_000);
    const result = await maintainCompressedBackups({ ...f.options, validate() { throw new Error("integrity failed"); } });
    expect(result.warnings.join(" ")).toContain("integrity failed");
    expect(await resolveBackupSource(old)).toBe(`${old}.gz`);
    expect(await resolveBackupSource(current)).toBe(current);
  });

  it("does not duplicate the same physical DB for global and enablement backups", async () => {
    const f = await fixture();
    const old = await backup(f.backupRoot, "state-old.vscdb", 20_000);
    const newest = await backup(f.backupRoot, "extensions-default-7d6b06bf-4dd6-4783-a2f2-9a9d76a518a1.vscdb", 1_000);
    const result = await maintainCompressedBackups(f.options);
    expect(result.warnings).toEqual([]);
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]?.contract).toBe("global");
    expect((JSON.parse(await readFile(`${newest}.gz.json`, "utf8")) as Record<string, unknown>).contract).toBe("global");
    expect(await resolveBackupSource(old)).toBeNull();
    expect(await resolveBackupSource(newest)).toBe(`${newest}.gz`);
  });

  it("preserves a broader restore contract when the newest archive came from enablement", async () => {
    const f = await fixture();
    const newest = await backup(f.backupRoot, "extensions-default-7d6b06bf-4dd6-4783-a2f2-9a9d76a518a1.vscdb", 1_000);
    await maintainCompressedBackups(f.options);
    const old = await backup(f.backupRoot, "state-old.vscdb", 20_000);
    const result = await maintainCompressedBackups(f.options);
    expect(result.warnings).toEqual([]);
    expect(result.backups[0]?.contract).toBe("global");
    expect((JSON.parse(await readFile(`${newest}.gz.json`, "utf8")) as Record<string, unknown>).contract).toBe("global");
    expect(await resolveBackupSource(old)).toBeNull();
  });

  it("keeps the prior full-chat backup if the newest enablement backup lacks its tables", async () => {
    const f = await fixture();
    const old = await backup(f.backupRoot, "state-old.vscdb", 20_000);
    const newest = await backup(f.backupRoot, "extensions-default-7d6b06bf-4dd6-4783-a2f2-9a9d76a518a1.vscdb", 1_000);
    const database = new DatabaseSync(newest);
    try { database.exec("DROP TABLE cursorDiskKV; DROP TABLE composerHeaders"); }
    finally { database.close(); }
    const result = await maintainCompressedBackups(f.options);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(await resolveBackupSource(old)).toBe(old);
    expect(await resolveBackupSource(newest)).toBe(newest);
  });

  it("rejects corrupted gzip bytes before any restore callback and cleans extraction scratch", async () => {
    const f = await fixture();
    const path = await backup(f.backupRoot, "state-one.vscdb", 1_000);
    await maintainCompressedBackups(f.options);
    const bytes = await readFile(`${path}.gz`);
    bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 255;
    await writeFile(`${path}.gz`, bytes);
    const operation = vi.fn();
    await expect(withReadableBackup(path, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect((await readdir(f.backupRoot)).some(n => n.startsWith(".restore-"))).toBe(false);
    expect(readValue(f.globalDatabase)).toBe("live");
  });

  it("bounds decompression by the manifest size and detects hash tampering", async () => {
    const f = await fixture();
    const path = await backup(f.backupRoot, "state-one.vscdb", 1_000);
    await maintainCompressedBackups(f.options);
    const metadata = JSON.parse(await readFile(`${path}.gz.json`, "utf8")) as Record<string, unknown>;
    await writeFile(`${path}.gz.json`, JSON.stringify({ ...metadata, sourceBytes: 1 }));
    await expect(withReadableBackup(path, async () => {})).rejects.toThrow("bounded uncompressed size");
    await writeFile(`${path}.gz.json`, JSON.stringify({ ...metadata, sourceSha256: "0".repeat(64) }));
    await expect(withReadableBackup(path, async () => {})).rejects.toThrow("round-trip verification");
  });

  it("does not rotate backups needed by an unfinished restore", async () => {
    const f = await fixture();
    const old = await backup(f.backupRoot, "state-old.vscdb", 20_000);
    const current = await backup(f.backupRoot, "state-current.vscdb", 1_000);
    await writeFile(join(f.storageRoot, "restore-pending.json"), JSON.stringify({ completedAt: null, backupPath: old }));
    const result = await maintainCompressedBackups(f.options);
    expect(result.warnings.join(" ")).toContain("recovery-pinned");
    expect(await resolveBackupSource(old)).toBe(old);
    expect(await resolveBackupSource(current)).toBe(current);
  });

  it("preserves every source when Cursor reopens before archive publication", async () => {
    const f = await fixture();
    const old = await backup(f.backupRoot, "state-old.vscdb", 20_000);
    const current = await backup(f.backupRoot, "state-current.vscdb", 1_000);
    let checks = 0;
    const result = await maintainCompressedBackups({ ...f.options, beforeWork: async () => { if (++checks === 2) throw new Error("Cursor reopened"); } });
    expect(result.warnings.join(" ")).toContain("Cursor reopened");
    expect(await resolveBackupSource(old)).toBe(old);
    expect(await resolveBackupSource(current)).toBe(current);
    expect((await readdir(f.backupRoot)).some(n => n.endsWith(".partial"))).toBe(false);
  });

  it("resumes an interrupted archive metadata publication without losing the source", async () => {
    const f = await fixture();
    const path = await backup(f.backupRoot, "state-one.vscdb", 1_000);
    const original = await readFile(path);
    await maintainCompressedBackups(f.options);
    await rm(`${path}.gz.json`);
    await writeFile(path, original);
    const result = await maintainCompressedBackups(f.options);
    expect(result.backups).toHaveLength(1);
    await withReadableBackup(path, async source => expect(await readFile(source)).toEqual(original));
    expect(await resolveBackupSource(path)).toBe(`${path}.gz`);
  });

  it("protects compressed archives and extraction scratch from legacy byte retention", async () => {
    const f = await fixture();
    const path = await backup(f.backupRoot, "state-one.vscdb", 1_000);
    await maintainCompressedBackups(f.options);
    await withReadableBackup(path, async source => {
      await enforceBackupRetention(f.storageRoot, { maxFiles: 0, maxTotalBytes: 0 });
      expect(readValue(source)).toBe("state-one.vscdb");
    });
    expect(await resolveBackupSource(path)).toBe(`${path}.gz`);
  });

  it("refuses a linked backup directory without touching its contents", async () => {
    const f = await fixture();
    await rm(f.backupRoot, { recursive: true });
    const outside = join(f.root, "outside");
    await mkdir(outside);
    const path = await backup(outside, "state-one.vscdb", 1_000);
    await symlink(outside, f.backupRoot, "junction");
    await expect(maintainCompressedBackups(f.options)).rejects.toThrow("exact backup directory");
    expect(await stat(path)).toBeDefined();
  });

  it("replays an interrupted restore whose legacy path now resolves to gzip", async () => {
    const f = await fixture();
    const path = await backup(f.backupRoot, "state-one.vscdb", 1_000, "before");
    await maintainCompressedBackups(f.options);
    const requestId = "87b9d155-dee1-44dc-84b4-e9313c7f007d";
    await writeFile(join(f.storageRoot, `restore-${requestId}.json`), JSON.stringify({
      version: 3, requestId, status: "applying", databasePath: f.globalDatabase,
      backupPath: path, startedAt: new Date().toISOString(), completedAt: null,
      error: null, contract: "global", preRestoreBackupPath: null,
    }));
    await recoverInterruptedApplyJournals(f.storageRoot, f.globalDatabase);
    expect(readValue(f.globalDatabase)).toBe("before");
    expect((await readdir(f.backupRoot)).some(n => n.startsWith(".restore-"))).toBe(false);
  });

  it("does not compress a backup that still has a nonempty WAL", async () => {
    const f = await fixture();
    const path = await backup(f.backupRoot, "state-one.vscdb", 1_000);
    await writeFile(`${path}-wal`, "unsealed data");
    const result = await maintainCompressedBackups(f.options);
    expect(result.warnings.join(" ")).toContain("unsealed SQLite sidecar");
    expect(await resolveBackupSource(path)).toBe(path);
    expect(await readFile(`${path}-wal`, "utf8")).toBe("unsealed data");
  });

  it("cleans abandoned compression and extraction scratch without sweeping unrelated files", async () => {
    const f = await fixture();
    const path = await backup(f.backupRoot, "state-one.vscdb", 1_000);
    const partial = `${path}.gz.87b9d155-dee1-44dc-84b4-e9313c7f007d.partial`;
    await writeFile(partial, "incomplete gzip");
    const abandoned = join(f.backupRoot, ".restore-aB1234");
    const unrelated = join(f.backupRoot, ".restore-zZ1234");
    await mkdir(abandoned);
    await mkdir(unrelated);
    await writeFile(join(abandoned, "source.vscdb"), "interrupted extraction");
    await writeFile(join(unrelated, "keep.txt"), "unrelated");
    await writeFile(join(f.backupRoot, "keep.partial"), "unrelated");
    const result = await maintainCompressedBackups(f.options);
    expect(result.warnings).toEqual([]);
    expect(await readdir(f.backupRoot)).not.toContain(".restore-aB1234");
    await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(unrelated, "keep.txt"), "utf8")).toBe("unrelated");
    expect(await readFile(join(f.backupRoot, "keep.partial"), "utf8")).toBe("unrelated");
    expect(await resolveBackupSource(path)).toBe(`${path}.gz`);
  });
});
