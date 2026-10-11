import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import {
  applyWorkspaceDatabaseSnapshot,
  assertDistinctPaths,
  captureWorkspaceDatabaseSnapshot,
  mergeWorkspaceDatabaseSnapshots,
  parseWorkspaceDatabaseSnapshot,
  serializeWorkspaceDatabaseSnapshot,
  unionWorkspaceDatabaseSnapshots,
  type PortableSqliteValue,
  type WorkspaceDatabaseRow,
  type WorkspaceDatabaseSnapshot,
  WorkspaceDatabaseMergeConflictError,
  workspaceDatabaseSnapshotHash,
} from "../src/helper/workspaceDatabaseMerge";

const temporaryRoots: string[] = [];
const describeWithBackup =
  typeof sqlite.backup === "function" ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("portable workspace database snapshots", () => {
  it("captures committed WAL data and preserves every SQLite storage class", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.vscdb");
    const database = await createDatabase(path);
    database.exec("PRAGMA journal_mode=WAL");
    database.exec("PRAGMA wal_autocheckpoint=0");
    const insert = database.prepare(
      "INSERT INTO ItemTable(key, value) VALUES (?, ?)",
    );
    insert.run("z-text", "hello");
    insert.run("a-blob", Buffer.from([0, 1, 2, 255]));
    insert.run("n-null", null);
    insert.run("i-integer", 9_007_199_254_740_993n);
    insert.run("r-real", 1.25);
    database.exec("CREATE TABLE futureState (id TEXT PRIMARY KEY, value BLOB)");

    let captured;
    try {
      captured = captureWorkspaceDatabaseSnapshot(path, {
        workspaceId: "workspace-a",
      });
    } finally {
      database.close();
    }

    expect(captured.warnings).toEqual([
      "Ignored 1 unknown workspace database table(s).",
    ]);
    expect(
      captured.snapshot.tables[0]?.rows.map((row) => row.key),
    ).toEqual(["a-blob", "i-integer", "n-null", "r-real", "z-text"]);
    expect(snapshotValue(captured.snapshot, "ItemTable", "a-blob")).toEqual({
      type: "blob",
      base64: "AAEC/w==",
    });
    expect(snapshotValue(captured.snapshot, "ItemTable", "i-integer")).toEqual({
      type: "integer",
      value: "9007199254740993",
    });
    expect(snapshotValue(captured.snapshot, "ItemTable", "n-null")).toEqual({
      type: "null",
    });
    expect(snapshotValue(captured.snapshot, "ItemTable", "r-real")).toEqual({
      type: "real",
      value: 1.25,
    });

    const serialized = serializeWorkspaceDatabaseSnapshot(captured.snapshot);
    const parsed = parseWorkspaceDatabaseSnapshot(serialized);
    expect(parsed).toEqual(captured.snapshot);
    expect(workspaceDatabaseSnapshotHash(parsed)).toBe(
      workspaceDatabaseSnapshotHash(captured.snapshot),
    );
  });

  it("canonicalizes database workspace IDs for portable composer rows", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.vscdb");
    const database = await createDatabase(path, { composerHeaders: true });
    database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("composer-1", "physical-b", 1n, 2n, 0n, 0n, 3n, 4n, "header");
    database.close();

    const result = captureWorkspaceDatabaseSnapshot(path, {
      workspaceId: "canonical-a",
      databaseWorkspaceId: "physical-b",
      includeComposerHeaders: true,
    });

    expect(
      snapshotValue(result.snapshot, "composerHeaders", "composer-1", 0),
    ).toEqual({ type: "text", value: "canonical-a" });
  });

  it.each(["legacy", "empty", "null", "used"] as const)(
    "captures %s subagent header data without a false unknown-column warning",
    async (mode) => {
      const root = await temporaryRoot();
      const path = join(root, "state.vscdb");
      const database = await createDatabase(path, {
        composerHeaders: true,
        subagentTypeName: mode !== "legacy",
      });
      if (mode !== "empty") {
        insertHeader(database, "composer-1", "header");
        if (mode === "used") {
          database.prepare("UPDATE composerHeaders SET subagentTypeName = ?").run("explorer");
        }
      }
      database.close();

      const captured = captureWorkspaceDatabaseSnapshot(path, {
        workspaceId: "workspace-a", includeComposerHeaders: true,
      });
      const headers = captured.snapshot.tables.find((table) => table.name === "composerHeaders");
      expect(captured.warnings).toEqual([]);
      expect(headers?.columns).toHaveLength(mode === "legacy" ? 8 : 9);
      expect(parseWorkspaceDatabaseSnapshot(serializeWorkspaceDatabaseSnapshot(captured.snapshot))).toEqual(captured.snapshot);
      if (mode === "used") {
        expect(snapshotValue(captured.snapshot, "composerHeaders", "composer-1", 8)).toEqual(text("explorer"));
      }
    },
  );

  it("keeps the warning and value preservation boundary for unrelated future columns", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.vscdb");
    const database = await createDatabase(path, { composerHeaders: true, subagentTypeName: true });
    database.exec("ALTER TABLE composerHeaders ADD COLUMN futureState TEXT");
    insertHeader(database, "composer-1", "header");
    database.prepare("UPDATE composerHeaders SET subagentTypeName = ?, futureState = ?").run("explorer", "private-future-data");
    database.close();

    const captured = captureWorkspaceDatabaseSnapshot(path, {
      workspaceId: "workspace-a", includeComposerHeaders: true,
    });
    expect(captured.warnings).toEqual(["Ignored 1 unknown column(s) in composerHeaders."]);
    expect(snapshotValue(captured.snapshot, "composerHeaders", "composer-1", 8)).toEqual(text("explorer"));
    expect(serializeWorkspaceDatabaseSnapshot(captured.snapshot).toString()).not.toContain("private-future-data");
  });

  it("rejects malformed values, duplicate keys, and payload limit violations", () => {
    const valid = makeSnapshot("workspace-a", {
      ItemTable: { key: text("value") },
    });
    const malformed = structuredClone(valid) as unknown as Record<string, unknown>;
    const tables = malformed.tables as Array<Record<string, unknown>>;
    const rows = tables[0]?.rows as Array<Record<string, unknown>>;
    rows[0] = { key: "key", values: [{ type: "blob", base64: "not-base64" }] };
    expect(() =>
      parseWorkspaceDatabaseSnapshot(
        Buffer.from(JSON.stringify(malformed), "utf8"),
      ),
    ).toThrow("invalid base64");

    const duplicate = structuredClone(valid);
    duplicate.tables[0]?.rows.push(cloneRow(duplicate.tables[0].rows[0]));
    expect(() => serializeWorkspaceDatabaseSnapshot(duplicate)).toThrow(
      "Duplicate workspace database key",
    );
    expect(() =>
      serializeWorkspaceDatabaseSnapshot(valid, { maxPlainBytes: 1 }),
    ).toThrow("configured limits");
  });

  it("rejects structurally amplified JSON before parsing it", () => {
    const rows = Array.from({ length: 90_000 }, () => "{}").join(",");
    const content = Buffer.from(
      `{"format":"cursor-setting-sync.workspace-database","version":1,"workspaceId":"workspace-a","tables":[${rows}]}`,
      "utf8",
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(() => parseWorkspaceDatabaseSnapshot(content)).toThrow(
        "structural JSON limit",
      );
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("round-trips the full bounded ItemTable row budget", () => {
    const snapshot: WorkspaceDatabaseSnapshot = {
      format: "cursor-setting-sync.workspace-database",
      version: 1,
      workspaceId: "workspace-a",
      sqliteUserVersion: 0,
      tables: [
        {
          name: "ItemTable",
          keyColumn: "key",
          columns: ["value"],
          rows: Array.from({ length: 16_384 }, (_, index) => ({
            key: `key-${index.toString().padStart(5, "0")}`,
            values: [{ type: "null" }],
          })),
        },
        {
          name: "cursorDiskKV",
          keyColumn: "key",
          columns: ["value"],
          rows: [],
        },
      ],
    };

    const content = serializeWorkspaceDatabaseSnapshot(snapshot);

    expect(parseWorkspaceDatabaseSnapshot(content)).toEqual(snapshot);
  });

  it("refuses a structurally excessive writer input before JSON.stringify", () => {
    const snapshot: WorkspaceDatabaseSnapshot = {
      format: "cursor-setting-sync.workspace-database",
      version: 1,
      workspaceId: "workspace-a",
      sqliteUserVersion: 0,
      tables: [
        {
          name: "ItemTable",
          keyColumn: "key",
          columns: ["value"],
          rows: Array.from({ length: 20_200 }, (_, index) => ({
            key: `key-${index}`,
            values: [{ type: "null" }],
          })),
        },
        {
          name: "cursorDiskKV",
          keyColumn: "key",
          columns: ["value"],
          rows: [],
        },
      ],
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(() =>
        serializeWorkspaceDatabaseSnapshot(snapshot, { maxRows: 30_000 }),
      ).toThrow("structural JSON limit");
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("rejects oversized SQLite blobs before their values cross into JavaScript", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.vscdb");
    const database = await createDatabase(path);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, zeroblob(?))")
      .run("oversized", 8 * 1024 * 1024);
    database.close();

    const bufferFrom = vi.spyOn(Buffer, "from");
    try {
      expect(() =>
        captureWorkspaceDatabaseSnapshot(path, {
          workspaceId: "workspace-a",
          limits: { maxPlainBytes: 1024 },
        }),
      ).toThrow("payload limit");
      expect(
        bufferFrom.mock.calls.some(([value]) => value instanceof Uint8Array),
      ).toBe(false);
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it("rejects an aggregate row excess before materializing any row value", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.vscdb");
    const database = await createDatabase(path);
    const insert = database.prepare(
      "INSERT INTO ItemTable(key, value) VALUES (?, ?)",
    );
    insert.run("one", Buffer.from([1]));
    insert.run("two", Buffer.from([2]));
    insert.run("three", Buffer.from([3]));
    database.close();

    const bufferFrom = vi.spyOn(Buffer, "from");
    try {
      expect(() =>
        captureWorkspaceDatabaseSnapshot(path, {
          workspaceId: "workspace-a",
          limits: { maxRows: 2 },
        }),
      ).toThrow("row limit");
      expect(
        bufferFrom.mock.calls.some(([value]) => value instanceof Uint8Array),
      ).toBe(false);
    } finally {
      bufferFrom.mockRestore();
    }
  });
});

describe("workspace database snapshot three-way merge", () => {
  it("keeps an optional table when one side's schema does not have it at all", () => {
    // A snapshot from a Cursor whose schema lacks composerHeaders (the reason
    // the descriptor is required:false) is no opinion about its rows. Read as
    // "every row deleted", each base-equal local row took the absent side's
    // nothing and the whole table vanished from the auto-resolved merge.
    const withHeaders = (value: string): Buffer =>
      Buffer.from(
        JSON.stringify({
          format: "cursor-setting-sync.workspace-database",
          version: 1,
          workspaceId: "workspace-a",
          sqliteUserVersion: 0,
          tables: [
            {
              name: "ItemTable",
              keyColumn: "key",
              columns: ["value"],
              rows: [],
            },
            {
              name: "cursorDiskKV",
              keyColumn: "key",
              columns: ["value"],
              rows: [],
            },
            {
              name: "composerHeaders",
              keyColumn: "composerId",
              columns: [
                "workspaceId",
                "createdAt",
                "lastUpdatedAt",
                "isArchived",
                "isSubagent",
                "recency",
                "checkpointAt",
                "value",
              ],
              rows: [
                {
                  key: "composer-1",
                  values: [
                    { type: "text", value: "workspace-a" },
                    { type: "integer", value: "1" },
                    { type: "integer", value: "2" },
                    { type: "integer", value: "0" },
                    { type: "integer", value: "0" },
                    { type: "integer", value: "0" },
                    { type: "null" },
                    { type: "text", value },
                  ],
                },
              ],
            },
          ],
        }),
        "utf8",
      );
    const base = parseWorkspaceDatabaseSnapshot(withHeaders("kept"));
    const local = parseWorkspaceDatabaseSnapshot(withHeaders("kept"));
    // The other device's Cursor has no composerHeaders table to export.
    const remote = makeSnapshot("workspace-a", {});

    const result = mergeWorkspaceDatabaseSnapshots(base, local, remote);

    expect(result.status).toBe("merged");
    const headers = result.snapshot?.tables.find(
      (candidate) => candidate.name === "composerHeaders",
    );
    expect(headers?.rows).toHaveLength(1);
  });

  it("merges independent updates and a one-sided deletion", () => {
    const base = makeSnapshot("workspace-a", {
      ItemTable: {
        left: text("base-left"),
        right: text("base-right"),
        removed: text("base-removed"),
      },
    });
    const local = makeSnapshot("workspace-a", {
      ItemTable: {
        left: text("local-left"),
        right: text("base-right"),
        removed: text("base-removed"),
      },
    });
    const remote = makeSnapshot("workspace-a", {
      ItemTable: {
        left: text("base-left"),
        right: text("remote-right"),
      },
    });

    const result = mergeWorkspaceDatabaseSnapshots(base, local, remote);

    expect(result.status).toBe("merged");
    expect(snapshotValue(result.snapshot, "ItemTable", "left")).toEqual(
      text("local-left"),
    );
    expect(snapshotValue(result.snapshot, "ItemTable", "right")).toEqual(
      text("remote-right"),
    );
    expect(snapshotValue(result.snapshot, "ItemTable", "removed")).toBeUndefined();
  });

  it("reports same-key updates without leaking keys or values", () => {
    const base = makeSnapshot("workspace-a", {
      ItemTable: { "secret/project/path": text("base") },
    });
    const local = makeSnapshot("workspace-a", {
      ItemTable: { "secret/project/path": text("local") },
    });
    const remote = makeSnapshot("workspace-a", {
      ItemTable: { "secret/project/path": text("remote") },
    });

    const result = mergeWorkspaceDatabaseSnapshots(base, local, remote);

    expect(result.status).toBe("conflict");
    expect(result.snapshot).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.table).toBe("ItemTable");
    expect(result.conflicts[0]?.reason).toBe("concurrent-update");
    expect(result.conflicts[0]?.keyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.conflicts)).not.toContain("secret");
    expect(JSON.stringify(result.conflicts)).not.toContain("remote");
  });
});

describe("workspace database path distinctness", () => {
  it("treats case-differing paths as identical only on Windows and macOS", () => {
    expect(() =>
      assertDistinctPaths("data/state.vscdb", "data/STATE.VSCDB", "win32"),
    ).toThrow(/must differ/);
    expect(() =>
      assertDistinctPaths("data/state.vscdb", "data/STATE.VSCDB", "darwin"),
    ).toThrow(/must differ/);
    expect(() =>
      assertDistinctPaths("data/state.vscdb", "data/STATE.VSCDB", "linux"),
    ).not.toThrow();
    expect(() =>
      assertDistinctPaths("data/state.vscdb", "data/state.vscdb", "linux"),
    ).toThrow(/must differ/);
  });
});

describe("optional workspace header merge columns", () => {
  it("retains new metadata through a legacy row update and a legacy preferred union", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.vscdb");
    const database = await createDatabase(path, { composerHeaders: true, subagentTypeName: true });
    insertHeader(database, "composer-1", "base");
    database.prepare("UPDATE composerHeaders SET subagentTypeName = ?").run("explorer");
    database.close();
    const base = captureHeaders(path);
    const legacy = structuredClone(base);
    const headers = legacy.tables.find((table) => table.name === "composerHeaders")!;
    headers.columns.pop();
    headers.rows[0]!.values.pop();
    headers.rows[0]!.values[7] = text("legacy-change");

    const merged = mergeWorkspaceDatabaseSnapshots(base, legacy, base);
    expect(merged.status).toBe("merged");
    expect(snapshotValue(merged.snapshot, "composerHeaders", "composer-1", 7)).toEqual(text("legacy-change"));
    expect(snapshotValue(merged.snapshot, "composerHeaders", "composer-1", 8)).toEqual(text("explorer"));
    const union = unionWorkspaceDatabaseSnapshots(legacy, base);
    expect(snapshotValue(union, "composerHeaders", "composer-1", 7)).toEqual(text("legacy-change"));
    expect(snapshotValue(union, "composerHeaders", "composer-1", 8)).toEqual(text("explorer"));
    expect(parseWorkspaceDatabaseSnapshot(serializeWorkspaceDatabaseSnapshot(union))).toEqual(union);

    const noTable = makeSnapshot("workspace-a", {});
    const passthrough = mergeWorkspaceDatabaseSnapshots(base, legacy, noTable);
    expect(snapshotValue(passthrough.snapshot, "composerHeaders", "composer-1", 8)).toEqual(text("explorer"));

    const legacyDeletion = structuredClone(legacy);
    legacyDeletion.tables.find((table) => table.name === "composerHeaders")!.rows = [];
    const deletion = mergeWorkspaceDatabaseSnapshots(base, legacyDeletion, base);
    expect(deletion.status).toBe("conflict");
    expect(deletion.conflicts).toEqual([expect.objectContaining({ reason: "unsafe-schema-delete" })]);
  });

  it("merges a newly populated optional column and protects concurrent optional edits", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.vscdb");
    const database = await createDatabase(path, { composerHeaders: true, subagentTypeName: true });
    insertHeader(database, "composer-1", "base");
    database.close();
    const legacy = captureHeaders(path);
    const legacyHeaders = legacy.tables.find((table) => table.name === "composerHeaders")!;
    legacyHeaders.columns.pop();
    legacyHeaders.rows[0]!.values.pop();
    const current = structuredClone(legacy);
    const headers = current.tables.find((table) => table.name === "composerHeaders")!;
    headers.columns.push("subagentTypeName");
    headers.rows[0]!.values.push(text("explorer"));
    const merged = mergeWorkspaceDatabaseSnapshots(legacy, legacy, current);
    expect(merged.status).toBe("merged");
    expect(snapshotValue(merged.snapshot, "composerHeaders", "composer-1", 8)).toEqual(text("explorer"));

    const local = structuredClone(current);
    local.tables.find((table) => table.name === "composerHeaders")!.rows[0]!.values[8] = text("local-edit");
    const remote = structuredClone(current);
    remote.tables.find((table) => table.name === "composerHeaders")!.rows[0]!.values[8] = text("remote-edit");
    const conflict = mergeWorkspaceDatabaseSnapshots(current, local, remote);
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflicts).toEqual([expect.objectContaining({ reason: "concurrent-update" })]);
    expect(conflict.snapshot).toBeUndefined();
  });

  it("rejects unrecognized or reordered snapshot columns", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.vscdb");
    const database = await createDatabase(path, { composerHeaders: true });
    database.close();
    const snapshot = captureHeaders(path);
    const headers = snapshot.tables.find((table) => table.name === "composerHeaders")!;
    headers.columns.push("futureColumn");
    expect(() => serializeWorkspaceDatabaseSnapshot(snapshot)).toThrow("column contract changed");
    headers.columns[8] = "subagentTypeName";
    [headers.columns[0], headers.columns[8]] = [headers.columns[8], headers.columns[0]!];
    expect(() => serializeWorkspaceDatabaseSnapshot(snapshot)).toThrow("column contract changed");
  });
});

describeWithBackup("workspace database query apply", () => {
  it.each(["clear", "delete"] as const)("preserves the explicit last subagent %s after a current snapshot", async (mode) => {
    const fixture = await applyFixture({ composerHeaders: true, subagentTypeName: true });
    insertHeader(fixture.database, "composer-1", "header");
    fixture.database.prepare("UPDATE composerHeaders SET workspaceId = ?, subagentTypeName = ?").run("workspace-b", "explorer");
    fixture.database.close();
    const sourcePath = join(fixture.root, "source.vscdb");
    const source = await createDatabase(sourcePath, { composerHeaders: true, subagentTypeName: true });
    insertHeader(source, "composer-1", "header");
    source.prepare("UPDATE composerHeaders SET subagentTypeName = ?").run("explorer");
    const base = captureHeaders(sourcePath);
    source.exec(mode === "clear" ? "UPDATE composerHeaders SET subagentTypeName = NULL" : "DELETE FROM composerHeaders");
    source.close();
    const incoming = captureHeaders(sourcePath);
    expect(incoming.tables.find((table) => table.name === "composerHeaders")?.columns).toHaveLength(9);

    const result = await applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath, backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b", base, incoming,
    });
    expect(result).toMatchObject(mode === "clear"
      ? { updated: 1, deleted: 0, warnings: [] }
      : { updated: 0, deleted: 1, warnings: [] });
    expect(readHeader(fixture.backupPath, "composer-1")).toMatchObject({ subagentTypeName: "explorer" });
    if (mode === "clear") {
      expect(readHeader(fixture.targetPath, "composer-1")).toMatchObject({ subagentTypeName: null });
    } else {
      expect(readHeader(fixture.targetPath, "composer-1")).toBeUndefined();
    }
  });

  it("imports used and explicit null subagent types with a verified backup and repeatable apply", async () => {
    const fixture = await applyFixture({ composerHeaders: true, subagentTypeName: true });
    insertHeader(fixture.database, "null-type", "before");
    fixture.database.prepare("UPDATE composerHeaders SET subagentTypeName = ?").run("old-type");
    fixture.database.close();
    const sourcePath = join(fixture.root, "source.vscdb");
    const source = await createDatabase(sourcePath, { composerHeaders: true, subagentTypeName: true });
    insertHeader(source, "used-type", "new");
    insertHeader(source, "null-type", "new");
    source.prepare("UPDATE composerHeaders SET subagentTypeName = ? WHERE composerId = ?").run("explorer", "used-type");
    source.close();
    const incoming = captureHeaders(sourcePath);

    const applied = await applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath, backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b", incoming,
    });
    expect(applied).toMatchObject({ inserted: 1, updated: 1, warnings: [] });
    expect(readHeader(fixture.targetPath, "used-type")).toMatchObject({ workspaceId: "workspace-b", subagentTypeName: "explorer" });
    expect(readHeader(fixture.targetPath, "null-type")).toMatchObject({ subagentTypeName: null });
    expect(readHeader(fixture.backupPath, "null-type")).toMatchObject({ subagentTypeName: "old-type", value: "before" });
    const repeated = await applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath, backupPath: join(fixture.root, "repeat-backup.vscdb"),
      targetWorkspaceId: "workspace-b", incoming,
    });
    expect(repeated).toMatchObject({ inserted: 0, updated: 0, deleted: 0, unchanged: 2, warnings: [] });
  });

  it.each(["nullable", "default"] as const)(
    "preserves target-only subagent types and %s insertion semantics for an old source",
    async (mode) => {
      const fixture = await applyFixture({ composerHeaders: true });
      fixture.database.exec(mode === "default"
        ? "ALTER TABLE composerHeaders ADD COLUMN subagentTypeName TEXT DEFAULT 'default-type'"
        : "ALTER TABLE composerHeaders ADD COLUMN subagentTypeName TEXT");
      insertHeader(fixture.database, "existing", "before");
      fixture.database.prepare("UPDATE composerHeaders SET subagentTypeName = ?").run("target-only-type");
      fixture.database.close();
      const sourcePath = join(fixture.root, "source.vscdb");
      const source = await createDatabase(sourcePath, { composerHeaders: true });
      insertHeader(source, "existing", "after");
      insertHeader(source, "inserted", "new");
      source.close();

      const result = await applyWorkspaceDatabaseSnapshot({
        targetPath: fixture.targetPath, backupPath: fixture.backupPath,
        targetWorkspaceId: "workspace-b", incoming: captureHeaders(sourcePath),
      });
      expect(result).toMatchObject({ inserted: 1, updated: 1, warnings: [] });
      expect(readHeader(fixture.targetPath, "existing")).toMatchObject({ value: "after", subagentTypeName: "target-only-type" });
      expect(readHeader(fixture.targetPath, "inserted")).toMatchObject({ subagentTypeName: mode === "default" ? "default-type" : null });
    },
  );

  it("accepts unused optional values on an old target without changing its schema", async () => {
    const fixture = await applyFixture({ composerHeaders: true });
    fixture.database.close();
    const sourcePath = join(fixture.root, "source.vscdb");
    const source = await createDatabase(sourcePath, { composerHeaders: true, subagentTypeName: true });
    insertHeader(source, "composer-1", "new");
    source.close();
    const incoming = captureHeaders(sourcePath);
    expect(incoming.tables.find((table) => table.name === "composerHeaders")?.columns).toHaveLength(9);

    const result = await applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath, backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b", incoming,
    });
    expect(result).toMatchObject({ inserted: 1, warnings: [] });
    expect(readHeader(fixture.targetPath, "composer-1")).toMatchObject({ value: "new" });
    expect(readHeader(fixture.targetPath, "composer-1")).not.toHaveProperty("subagentTypeName");
  });

  it("rejects a used optional value on an old target before backup or any write", async () => {
    const fixture = await applyFixture({ composerHeaders: true });
    insertHeader(fixture.database, "composer-1", "preserved");
    insertText(fixture.database, "sentinel", "preserved");
    fixture.database.close();
    const sourcePath = join(fixture.root, "source.vscdb");
    const source = await createDatabase(sourcePath, { composerHeaders: true, subagentTypeName: true });
    insertHeader(source, "composer-1", "remote");
    source.prepare("UPDATE composerHeaders SET subagentTypeName = ?").run("explorer");
    insertText(source, "sentinel", "must-not-write");
    source.close();

    await expect(applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath, backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b", incoming: captureHeaders(sourcePath),
    })).rejects.toThrow("does not support populated column(s)");
    expect(readHeader(fixture.targetPath, "composer-1")).toMatchObject({ value: "preserved" });
    expect(readValue(fixture.targetPath, "sentinel")?.value).toBe("preserved");
    await expect(stat(fixture.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["legacy", "current"] as const)("protects target-only optional data from an old source deletion after a %s base", async (baseMode) => {
    const fixture = await applyFixture({ composerHeaders: true, subagentTypeName: true });
    insertHeader(fixture.database, "composer-1", "base");
    fixture.database.prepare("UPDATE composerHeaders SET workspaceId = ?, subagentTypeName = ?").run("workspace-b", "target-only-type");
    fixture.database.close();
    const sourcePath = join(fixture.root, "source.vscdb");
    const source = await createDatabase(sourcePath, { composerHeaders: true, subagentTypeName: baseMode === "current" });
    insertHeader(source, "composer-1", "base");
    if (baseMode === "current") {
      source.prepare("UPDATE composerHeaders SET subagentTypeName = ?").run("target-only-type");
    }
    source.close();
    const base = captureHeaders(sourcePath);
    const incoming = structuredClone(base);
    const incomingHeaders = incoming.tables.find((table) => table.name === "composerHeaders")!;
    incomingHeaders.rows = [];
    if (baseMode === "current") {
      incomingHeaders.columns.pop();
    }

    await expect(applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath, backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b", base, incoming,
    })).rejects.toMatchObject({ conflicts: [expect.objectContaining({ reason: "unsafe-schema-delete" })] });
    expect(readHeader(fixture.targetPath, "composer-1")).toMatchObject({ subagentTypeName: "target-only-type" });
    await expect(stat(fixture.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains unrelated unknown target values during known subagent updates", async () => {
    const fixture = await applyFixture({ composerHeaders: true, subagentTypeName: true });
    fixture.database.exec("ALTER TABLE composerHeaders ADD COLUMN futureState TEXT");
    insertHeader(fixture.database, "composer-1", "before");
    fixture.database.prepare("UPDATE composerHeaders SET futureState = ?").run("local-only");
    fixture.database.close();
    const sourcePath = join(fixture.root, "source.vscdb");
    const source = await createDatabase(sourcePath, { composerHeaders: true, subagentTypeName: true });
    insertHeader(source, "composer-1", "after");
    source.prepare("UPDATE composerHeaders SET subagentTypeName = ?").run("explorer");
    source.close();

    const result = await applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath, backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b", incoming: captureHeaders(sourcePath),
    });
    expect(result.warnings).toEqual(["Ignored 1 unknown column(s) in composerHeaders."]);
    expect(readHeader(fixture.targetPath, "composer-1")).toMatchObject({ value: "after", subagentTypeName: "explorer", futureState: "local-only" });
  });

  it("uses an upsert-only overlay without a base and preserves unrelated state", async () => {
    const fixture = await applyFixture({ extraNullableColumn: true });
    fixture.database
      .prepare("INSERT INTO ItemTable(key, value, future) VALUES (?, ?, ?)")
      .run("local-only", "local", "future-local");
    fixture.database
      .prepare("INSERT INTO ItemTable(key, value, future) VALUES (?, ?, ?)")
      .run("shared", "old", "future-shared");
    fixture.database.exec("CREATE TABLE unknownLocal (id TEXT PRIMARY KEY, value TEXT)");
    fixture.database
      .prepare("INSERT INTO unknownLocal(id, value) VALUES (?, ?)")
      .run("sentinel", "preserved");
    fixture.database.close();
    const before = await stat(fixture.targetPath);
    const incoming = makeSnapshot("workspace-a", {
      ItemTable: {
        shared: blob(Buffer.from([3, 2, 1])),
        "remote-only": text("remote"),
      },
    });

    const result = await applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath,
      backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b",
      incoming,
    });

    const after = await stat(fixture.targetPath);
    expect(after.birthtimeMs).toBe(before.birthtimeMs);
    expect(result).toEqual(
      expect.objectContaining({ inserted: 1, updated: 1, deleted: 0 }),
    );
    expect(readValue(fixture.targetPath, "local-only")).toEqual({
      type: "text",
      value: "local",
      future: "future-local",
    });
    expect(readValue(fixture.targetPath, "shared")).toEqual({
      type: "blob",
      value: Buffer.from([3, 2, 1]),
      future: "future-shared",
    });
    expect(readUnknownValue(fixture.targetPath)).toBe("preserved");
    expect((await stat(fixture.backupPath)).size).toBeGreaterThan(0);
  });

  it("applies only safe three-way updates and deletes", async () => {
    const fixture = await applyFixture();
    insertText(fixture.database, "updated", "base-update");
    insertText(fixture.database, "deleted", "base-delete");
    insertText(fixture.database, "local-only", "local");
    fixture.database.close();
    const base = makeSnapshot("workspace-a", {
      ItemTable: {
        updated: text("base-update"),
        deleted: text("base-delete"),
      },
    });
    const incoming = makeSnapshot("workspace-a", {
      ItemTable: { updated: text("remote-update") },
    });

    const result = await applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath,
      backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b",
      base,
      incoming,
    });

    expect(result).toEqual(
      expect.objectContaining({ inserted: 0, updated: 1, deleted: 1 }),
    );
    expect(readValue(fixture.targetPath, "updated")?.value).toBe("remote-update");
    expect(readValue(fixture.targetPath, "deleted")).toBeUndefined();
    expect(readValue(fixture.targetPath, "local-only")?.value).toBe("local");
  });

  it("aborts atomically on a concurrent row change before making a backup", async () => {
    const fixture = await applyFixture();
    insertText(fixture.database, "conflict", "local-change");
    insertText(fixture.database, "safe", "base-safe");
    fixture.database.close();
    const base = makeSnapshot("workspace-a", {
      ItemTable: {
        conflict: text("base"),
        safe: text("base-safe"),
      },
    });
    const incoming = makeSnapshot("workspace-a", {
      ItemTable: {
        conflict: text("remote-change"),
        safe: text("remote-safe"),
      },
    });

    const apply = applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath,
      backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b",
      base,
      incoming,
    });

    await expect(apply).rejects.toBeInstanceOf(
      WorkspaceDatabaseMergeConflictError,
    );
    expect(readValue(fixture.targetPath, "conflict")?.value).toBe("local-change");
    expect(readValue(fixture.targetPath, "safe")?.value).toBe("base-safe");
    await expect(stat(fixture.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back the DML transaction when pre-commit validation fails", async () => {
    const fixture = await applyFixture();
    insertText(fixture.database, "referenced", "before");
    fixture.database.exec(
      "CREATE TABLE unknownChild (id TEXT PRIMARY KEY, parentKey TEXT REFERENCES ItemTable(key))",
    );
    fixture.database
      .prepare("INSERT INTO unknownChild(id, parentKey) VALUES (?, ?)")
      .run("child", "referenced");
    fixture.database.close();
    const base = makeSnapshot("workspace-a", {
      ItemTable: { referenced: text("before") },
    });
    const incoming = makeSnapshot("workspace-a", {});

    await expect(
      applyWorkspaceDatabaseSnapshot({
        targetPath: fixture.targetPath,
        backupPath: fixture.backupPath,
        targetWorkspaceId: "workspace-b",
        base,
        incoming,
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed|foreign_key_check failed/);

    expect(readValue(fixture.targetPath, "referenced")?.value).toBe("before");
    expect(readValue(fixture.backupPath, "referenced")?.value).toBe("before");
  });

  it("maps composer workspace IDs while applying row updates", async () => {
    const fixture = await applyFixture({ composerHeaders: true });
    fixture.database.close();
    const sourcePath = join(fixture.root, "source.vscdb");
    const source = await createDatabase(sourcePath, { composerHeaders: true });
    source
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("composer-1", "workspace-a", 1n, 2n, 0n, 0n, 3n, 4n, "value");
    source.close();
    const incoming = captureWorkspaceDatabaseSnapshot(sourcePath, {
      workspaceId: "workspace-a",
      includeComposerHeaders: true,
    }).snapshot;

    await applyWorkspaceDatabaseSnapshot({
      targetPath: fixture.targetPath,
      backupPath: fixture.backupPath,
      targetWorkspaceId: "workspace-b",
      incoming,
    });

    const target = new sqlite.DatabaseSync(fixture.targetPath, { readOnly: true });
    try {
      expect(
        target
          .prepare("SELECT workspaceId FROM composerHeaders WHERE composerId = ?")
          .get("composer-1"),
      ).toEqual({ workspaceId: "workspace-b" });
    } finally {
      target.close();
    }
  });

  it("refuses to create a missing target database", async () => {
    const root = await temporaryRoot();
    const targetPath = join(root, "missing", "state.vscdb");
    const backupPath = join(root, "backup.vscdb");

    await expect(
      applyWorkspaceDatabaseSnapshot({
        targetPath,
        backupPath,
        targetWorkspaceId: "workspace-b",
        incoming: makeSnapshot("workspace-a", {
          ItemTable: { key: text("value") },
        }),
      }),
    ).rejects.toThrow("refusing to create or replace");
    await expect(stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses caller limits for target preflight and writes nothing on oversize", async () => {
    const fixture = await applyFixture();
    fixture.database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, zeroblob(?))")
      .run("local-large", 8 * 1024 * 1024);
    fixture.database.close();
    const incoming = makeSnapshot("workspace-a", {
      ItemTable: { remote: text("must-not-be-written") },
    });

    const bufferFrom = vi.spyOn(Buffer, "from");
    try {
      await expect(
        applyWorkspaceDatabaseSnapshot({
          targetPath: fixture.targetPath,
          backupPath: fixture.backupPath,
          targetWorkspaceId: "workspace-b",
          incoming,
          limits: { maxPlainBytes: 1024 },
        }),
      ).rejects.toThrow("payload limit");
      expect(
        bufferFrom.mock.calls.some(([value]) => value instanceof Uint8Array),
      ).toBe(false);
    } finally {
      bufferFrom.mockRestore();
    }

    await expect(stat(fixture.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    const target = new sqlite.DatabaseSync(fixture.targetPath, { readOnly: true });
    try {
      expect(
        target
          .prepare(
            "SELECT typeof(value) AS type, length(value) AS bytes FROM ItemTable WHERE key = ?",
          )
          .get("local-large"),
      ).toEqual({ type: "blob", bytes: 8 * 1024 * 1024 });
      expect(
        target.prepare("SELECT 1 AS present FROM ItemTable WHERE key = ?").get("remote"),
      ).toBeUndefined();
    } finally {
      target.close();
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cursor-workspace-db-merge-"));
  temporaryRoots.push(root);
  return root;
}

async function createDatabase(
  path: string,
  options: {
    composerHeaders?: boolean;
    extraNullableColumn?: boolean;
    subagentTypeName?: boolean;
  } = {},
): Promise<sqlite.DatabaseSync> {
  await mkdir(join(path, ".."), { recursive: true });
  const database = new sqlite.DatabaseSync(path);
  database.exec(
    options.extraNullableColumn === true
      ? "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB, future TEXT)"
      : "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  database.exec(
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  if (options.composerHeaders === true) {
    database.exec(
      `CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
        lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
        recency INTEGER, checkpointAt INTEGER, value TEXT
      )`,
    );
    if (options.subagentTypeName === true) {
      database.exec("ALTER TABLE composerHeaders ADD COLUMN subagentTypeName TEXT");
    }
  }
  return database;
}

async function applyFixture(
  options: Parameters<typeof createDatabase>[1] = {},
): Promise<{
  root: string;
  targetPath: string;
  backupPath: string;
  database: sqlite.DatabaseSync;
}> {
  const root = await temporaryRoot();
  const targetPath = join(root, "workspace-b", "state.vscdb");
  const backupPath = join(root, "backups", "state-before-apply.vscdb");
  const database = await createDatabase(targetPath, options);
  return { root, targetPath, backupPath, database };
}

function insertText(database: sqlite.DatabaseSync, key: string, value: string): void {
  database
    .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
    .run(key, value);
}

function insertHeader(database: sqlite.DatabaseSync, id: string, value: string): void {
  database.prepare(`INSERT INTO composerHeaders(
    composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
    isSubagent, recency, checkpointAt, value
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, "workspace-a", 1n, 2n, 0n, 1n, 3n, 4n, value);
}

function captureHeaders(path: string): WorkspaceDatabaseSnapshot {
  return captureWorkspaceDatabaseSnapshot(path, {
    workspaceId: "workspace-a", includeComposerHeaders: true,
  }).snapshot;
}

function readHeader(path: string, id: string): Record<string, unknown> | undefined {
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("SELECT * FROM composerHeaders WHERE composerId = ?").get(id);
  } finally {
    database.close();
  }
}

function makeSnapshot(
  workspaceId: string,
  rows: {
    ItemTable?: Record<string, PortableSqliteValue>;
    cursorDiskKV?: Record<string, PortableSqliteValue>;
  },
): WorkspaceDatabaseSnapshot {
  return parseWorkspaceDatabaseSnapshot(
    Buffer.from(
      JSON.stringify({
        format: "cursor-setting-sync.workspace-database",
        version: 1,
        workspaceId,
        sqliteUserVersion: 0,
        tables: [
          table("ItemTable", rows.ItemTable ?? {}),
          table("cursorDiskKV", rows.cursorDiskKV ?? {}),
        ],
      }),
      "utf8",
    ),
  );
}

function table(
  name: "ItemTable" | "cursorDiskKV",
  rows: Record<string, PortableSqliteValue>,
): {
  name: "ItemTable" | "cursorDiskKV";
  keyColumn: "key";
  columns: ["value"];
  rows: WorkspaceDatabaseRow[];
} {
  return {
    name,
    keyColumn: "key",
    columns: ["value"],
    rows: Object.entries(rows).map(([key, value]) => ({ key, values: [value] })),
  };
}

function text(value: string): PortableSqliteValue {
  return { type: "text", value };
}

function blob(value: Uint8Array): PortableSqliteValue {
  return { type: "blob", base64: Buffer.from(value).toString("base64") };
}

function cloneRow(row: WorkspaceDatabaseRow | undefined): WorkspaceDatabaseRow {
  if (row === undefined) {
    throw new Error("Test row is missing.");
  }
  return {
    key: row.key,
    values: row.values.map((value) => ({ ...value })),
  };
}

function snapshotValue(
  snapshot: WorkspaceDatabaseSnapshot | undefined,
  tableName: string,
  key: string,
  index = 0,
): PortableSqliteValue | undefined {
  return snapshot?.tables
    .find((table) => table.name === tableName)
    ?.rows.find((row) => row.key === key)?.values[index];
}

function readValue(
  path: string,
  key: string,
): { type: string; value: unknown; future?: unknown } | undefined {
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const columns = database
      .prepare("PRAGMA table_info(ItemTable)")
      .all()
      .map((row) => String(row.name));
    const future = columns.includes("future") ? ", future" : "";
    const statement = database.prepare(
      `SELECT typeof(value) AS type, value${future} FROM ItemTable WHERE key = ?`,
    );
    statement.setReadBigInts(true);
    const row = statement.get(key);
    return row === undefined
      ? undefined
      : {
          type: String(row.type),
          value:
            row.value instanceof Uint8Array ? Buffer.from(row.value) : row.value,
          ...(columns.includes("future") ? { future: row.future } : {}),
        };
  } finally {
    database.close();
  }
}

function readUnknownValue(path: string): string | undefined {
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM unknownLocal WHERE id = ?")
      .get("sentinel");
    return typeof row?.value === "string" ? row.value : undefined;
  } finally {
    database.close();
  }
}
