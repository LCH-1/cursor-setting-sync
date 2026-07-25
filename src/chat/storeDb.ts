import { relative } from "node:path";
import type { DatabaseSync } from "../platform/sqlite";
import { openDatabase } from "../platform/sqlite";
import { stat } from "node:fs/promises";
import type {
  LocalProjection,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeRelativePathOnDisk,
  listFilesRecursively,
  normalizeResourcePath,
  pathExists,
} from "../platform/files";
import {
  canonicalBytes,
  isCanonicalBase64Text,
  sha256,
} from "../protocol/canonical";
import type { ResourceAdapter, ResourceApplyInput } from "../resources/resource";

export type PortableStoreValue =
  | { type: "null" }
  | { type: "text"; value: string }
  | { type: "blob"; value: string }
  | { type: "integer"; value: string }
  | { type: "real"; value: number };

export interface PortableStoreSnapshot {
  schemaVersion: 1;
  relativePath: string;
  meta: Array<{ key: string; value: PortableStoreValue }>;
  blobs: Array<{ id: string; data: PortableStoreValue }>;
}

export class StoreDbChatAdapter implements ResourceAdapter {
  readonly id = "chat-store-db";
  readonly kinds = ["chat-store"] as const;
  readonly appliesWhileRunning = false;

  constructor(private readonly paths: CursorPaths) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const current = new Set<string>();
    const files = [
      ...(await listFilesRecursively(this.paths.cursorChats)),
      ...(await listFilesRecursively(this.paths.cursorAcpSessions)),
    ].filter((path) => /[\\/]store\.db$/i.test(path));

    for (const path of files) {
      try {
        const relativePath = normalizeResourcePath(
          relative(this.paths.cursorHome, path),
        );
        const resourceId = `chat-store/${encodeURIComponent(relativePath)}`;
        current.add(resourceId);
        await assertSafeRelativePathOnDisk(
          this.paths.cursorHome,
          relativePath,
          { finalType: "file" },
        );
        const lastUpdatedAt = await storeLastUpdatedAt(path);
        if (known[resourceId]?.sourceTimestamp === lastUpdatedAt) {
          continue;
        }
        const snapshot = readStoreSnapshot(path, relativePath, warnings);
        const content = canonicalBytes(snapshot);
        snapshots.push({
          resourceId,
          kind: "chat-store",
          content,
          semanticHash: sha256(content),
          metadata: {
            relativePath,
            metaCount: snapshot.meta.length,
            blobCount: snapshot.blobs.length,
            lastUpdatedAt,
          },
        });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      snapshots,
      deletions: findDeletions(known, current),
      warnings,
    };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Chat store databases must be applied by the offline helper.");
  }
}

export function parsePortableStoreSnapshot(content: Buffer): PortableStoreSnapshot {
  const snapshot = JSON.parse(content.toString("utf8")) as PortableStoreSnapshot;
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.relativePath !== "string" ||
    !Array.isArray(snapshot.meta) ||
    !Array.isArray(snapshot.blobs)
  ) {
    throw new Error("Unsupported or invalid chat store snapshot.");
  }
  if (snapshot.meta.length > 250_000 || snapshot.blobs.length > 250_000) {
    throw new Error("Chat store snapshot contains too many rows.");
  }
  if (
    snapshot.meta.some(
      (row) =>
        row === null ||
        typeof row !== "object" ||
        typeof row.key !== "string" ||
        !isPortableStoreValue(row.value),
    ) ||
    snapshot.blobs.some(
      (row) =>
        row === null ||
        typeof row !== "object" ||
        typeof row.id !== "string" ||
        !isPortableStoreValue(row.data),
    )
  ) {
    throw new Error("Chat store snapshot contains invalid rows.");
  }
  if (
    new Set(snapshot.meta.map((row) => row.key)).size !== snapshot.meta.length ||
    new Set(snapshot.blobs.map((row) => row.id)).size !== snapshot.blobs.length
  ) {
    throw new Error("Chat store snapshot contains duplicate row identifiers.");
  }
  return snapshot;
}

function isPortableStoreValue(value: unknown): value is PortableStoreValue {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as { type?: unknown; value?: unknown };
  if (candidate.type === "null") {
    return candidate.value === undefined;
  }
  if (candidate.type === "text") {
    return typeof candidate.value === "string";
  }
  if (candidate.type === "integer") {
    return (
      typeof candidate.value === "string" &&
      /^-?(?:0|[1-9][0-9]*)$/.test(candidate.value) &&
      BigInt(candidate.value) >= -(2n ** 63n) &&
      BigInt(candidate.value) <= 2n ** 63n - 1n
    );
  }
  if (candidate.type === "real") {
    return typeof candidate.value === "number" && Number.isFinite(candidate.value);
  }
  return (
    candidate.type === "blob" &&
    typeof candidate.value === "string" &&
    isCanonicalBase64Text(candidate.value) &&
    Buffer.from(candidate.value, "base64").toString("base64") === candidate.value
  );
}

export function readStoreSnapshot(
  path: string,
  relativePath: string,
  warnings?: string[],
): PortableStoreSnapshot {
  const database = openDatabase(path, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=2000");
    database.exec("PRAGMA query_only=ON");
    assertStoreSchema(database);
    database.exec("BEGIN");
    try {
      const metaRows = database
        .prepare("SELECT key, value, typeof(value) AS valueType FROM meta ORDER BY key")
        .all() as Array<{
          key: Uint8Array | string | number | bigint | null;
          value: Uint8Array | string | number | bigint | null;
          valueType: string;
        }>;
      const blobRows = database
        .prepare("SELECT id, data, typeof(data) AS dataType FROM blobs ORDER BY id")
        .all() as Array<{
          id: Uint8Array | string | number | bigint | null;
          data: Uint8Array | string | number | bigint | null;
          dataType: string;
        }>;
      database.exec("COMMIT");
      // SQLite permits NULL in a non-INTEGER PRIMARY KEY column. Such a row
      // has no usable identity, so it is dropped here rather than published
      // as a snapshot every peer rejects; coercing it would create a literal
      // "null" key on the target.
      const meta = metaRows
        .filter((row) => typeof row.key === "string")
        .map((row) => ({
          key: row.key as string,
          value: portableValue(row.value, row.valueType),
        }));
      const blobs = blobRows
        .filter((row) => typeof row.id === "string")
        .map((row) => ({
          id: row.id as string,
          data: portableValue(row.data, row.dataType),
        }));
      const skippedRows =
        metaRows.length - meta.length + (blobRows.length - blobs.length);
      if (skippedRows > 0) {
        warnings?.push(
          `Skipped ${skippedRows} store.db row(s) without a text key in ${relativePath}.`,
        );
      }
      return { schemaVersion: 1, relativePath, meta, blobs };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function assertStoreSchema(database: DatabaseSync): void {
  for (const [table, columns] of [
    ["meta", ["key", "value"]],
    ["blobs", ["id", "data"]],
  ] as const) {
    const actual = database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => String(row.name));
    if (!columns.every((column) => actual.includes(column))) {
      throw new Error(`Unsupported store.db schema for ${table}.`);
    }
  }
}

function portableValue(
  value: Uint8Array | string | number | bigint | null,
  sqliteType: string,
): PortableStoreValue {
  if (sqliteType === "null" && value === null) {
    return { type: "null" };
  }
  if (sqliteType === "text" && typeof value === "string") {
    return { type: "text", value };
  }
  if (sqliteType === "blob" && value instanceof Uint8Array) {
    return { type: "blob", value: Buffer.from(value).toString("base64") };
  }
  if (
    sqliteType === "integer" &&
    ((typeof value === "number" && Number.isSafeInteger(value)) ||
      typeof value === "bigint")
  ) {
    return { type: "integer", value: String(value) };
  }
  if (sqliteType === "real" && typeof value === "number" && Number.isFinite(value)) {
    return { type: "real", value: Object.is(value, -0) ? 0 : value };
  }
  throw new Error(`Unsupported SQLite value in store.db: ${sqliteType}.`);
}

function findDeletions(
  known: Record<string, LocalProjection>,
  current: Set<string>,
): ResourceDeletion[] {
  return Object.values(known)
    .filter(
      (projection) =>
        projection.kind === "chat-store" && !current.has(projection.resourceId),
    )
    .map((projection) => ({
      resourceId: projection.resourceId,
      kind: "chat-store",
      semanticHash: sha256(`deleted:${projection.resourceId}`),
      metadata: {
        relativePath: decodeURIComponent(
          projection.resourceId.slice("chat-store/".length),
        ),
      },
    }));
}

async function storeLastUpdatedAt(path: string): Promise<number> {
  const main = await stat(path);
  const walPath = `${path}-wal`;
  if (!(await pathExists(walPath))) {
    return main.mtimeMs;
  }
  const wal = await stat(walPath);
  return Math.max(main.mtimeMs, wal.mtimeMs);
}
