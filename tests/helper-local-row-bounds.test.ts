import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { TARGET_STORAGE_MARKER } from "../src/constants";
import { __testing as databaseTesting } from "../src/helper/database";
import { __testing as resourceApplyTesting } from "../src/helper/resourceApply";

const roots: string[] = [];
const OVERSIZED_ROW_BYTES = 8 * 1024 * 1024 + 1;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("offline helper local-row preflights", () => {
  it("rejects an oversized target marker before selecting its body", async () => {
    const { database } = await fixture(TARGET_STORAGE_MARKER);
    let reads = 0;

    expect(() =>
      databaseTesting.readTargetMarker(database, () => {
        reads += 1;
      }),
    ).toThrow("read limit");
    expect(reads).toBe(0);
    expect(rowLength(database, TARGET_STORAGE_MARKER)).toBe(
      OVERSIZED_ROW_BYTES,
    );
    database.close();
  });

  it("rejects an oversized stored profile manifest before selecting its body", async () => {
    const { database, root } = await fixture("userDataProfiles");
    let reads = 0;

    expect(() =>
      databaseTesting.mergeStoredProfiles(database, [], join(root, "profiles"), () => {
        reads += 1;
      }),
    ).toThrow("read limit");
    expect(reads).toBe(0);
    expect(rowLength(database, "userDataProfiles")).toBe(OVERSIZED_ROW_BYTES);
    database.close();
  });

  it("rejects an oversized disabled-extension list before selecting its body", async () => {
    const key = "extensionsIdentifiers/disabled";
    const { database } = await fixture(key);
    let reads = 0;

    expect(() =>
      resourceApplyTesting.readDisabledExtensionState(database, () => {
        reads += 1;
      }),
    ).toThrow("read limit");
    expect(reads).toBe(0);
    expect(rowLength(database, key)).toBe(OVERSIZED_ROW_BYTES);
    database.close();
  });
});

async function fixture(key: string): Promise<{
  root: string;
  database: DatabaseSync;
}> {
  const root = await mkdtemp(join(tmpdir(), "helper-local-row-bounds-"));
  roots.push(root);
  const database = new DatabaseSync(join(root, "state.vscdb"));
  database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
  database
    .prepare("INSERT INTO ItemTable(key, value) VALUES (?, zeroblob(?))")
    .run(key, OVERSIZED_ROW_BYTES);
  return { root, database };
}

function rowLength(database: DatabaseSync, key: string): number {
  const row = database
    .prepare("SELECT length(value) AS bytes FROM ItemTable WHERE key = ?")
    .get(key) as { bytes: number };
  return row.bytes;
}
