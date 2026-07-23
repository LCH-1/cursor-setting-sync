import type { DatabaseSync } from "../platform/sqlite";
import { openDatabase } from "../platform/sqlite";
import type {
  LocalProjection,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import type { ResourceAdapter, ResourceApplyInput } from "../resources/resource";
import { discoverWorkspaces } from "./workspace";

export interface PortableComposerHeader {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  isArchived: number | null;
  isSubagent: number | null;
  recency: number | null;
  checkpointAt: number | null;
  value: string | null;
}

export interface PortableKvRow {
  key: string;
  valueBase64: string;
  /** SQLite storage class; absent in older snapshots, which are TEXT. */
  valueType?: "text" | "blob" | "null";
}

type SqliteRowValue = Uint8Array | string | number | bigint | null;

type RawComposerHeader = {
  composerId: SqliteRowValue;
  workspaceId: SqliteRowValue;
  createdAt: SqliteRowValue;
  lastUpdatedAt: SqliteRowValue;
  isArchived: SqliteRowValue;
  isSubagent: SqliteRowValue;
  recency: SqliteRowValue;
  checkpointAt: SqliteRowValue;
  value: SqliteRowValue;
};

type RawKvRow = {
  key: SqliteRowValue;
  value: SqliteRowValue;
  valueType: SqliteRowValue;
};

type ChatStatement = ReturnType<DatabaseSync["prepare"]>;

interface ChatStatements {
  header: ChatStatement;
  data: ChatStatement;
  bubbles: ChatStatement;
}

type ChatCapture =
  | { kind: "missing" }
  | { kind: "unchanged" }
  | { kind: "captured"; snapshot: PortableChatSnapshot };

export interface PortableChatSnapshot {
  schemaVersion: 1;
  composerId: string;
  header: PortableComposerHeader;
  composerData: PortableKvRow;
  bubbles: PortableKvRow[];
}

export class StateVscdbChatAdapter implements ResourceAdapter {
  readonly id = "state-vscdb-chat";
  readonly kinds = ["chat"] as const;
  readonly appliesWhileRunning = false;

  constructor(private readonly paths: CursorPaths) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const workspaceUris = new Map(
      (await discoverWorkspaces(this.paths)).map((workspace) => [
        workspace.id,
        workspace.uri,
      ]),
    );
    const database = openDatabase(this.paths.globalDatabase, { readOnly: true });
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const current = new Set<string>();
    try {
      // Cursor writes to this database while it runs; wait out short lock
      // bursts instead of failing the whole sync cycle with SQLITE_BUSY.
      database.exec("PRAGMA busy_timeout=2000");
      database.exec("PRAGMA query_only=ON");
      // NULL = 0 is NULL, not true, so a composer whose late-added isSubagent
      // column was never backfilled must be matched explicitly or it silently
      // drops out of the scan and is published as a deletion.
      const headers = database
        .prepare(
          "SELECT composerId FROM composerHeaders WHERE COALESCE(isSubagent, 0) = 0",
        )
        .all() as Array<{ composerId: SqliteRowValue }>;
      const statements: ChatStatements = {
        header: database.prepare(
          "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value FROM composerHeaders WHERE composerId = ? AND COALESCE(isSubagent, 0) = 0",
        ),
        data: database.prepare(
          "SELECT key, value, typeof(value) AS valueType FROM cursorDiskKV WHERE key = ?",
        ),
        bubbles: database.prepare(
          "SELECT key, value, typeof(value) AS valueType FROM cursorDiskKV WHERE key LIKE ? ORDER BY key",
        ),
      };
      for (const rawHeader of headers) {
        const composerId = rawHeader.composerId;
        if (typeof composerId !== "string") {
          warnings.push("Skipped a composer header whose composerId is not text.");
          continue;
        }
        const resourceId = `chat/${composerId}`;
        let captured: ChatCapture;
        try {
          captured = captureChat(database, statements, composerId, known);
        } catch (error) {
          // One unusable row must never take the whole adapter down. The
          // resource stays in `current` so it is not published as a deletion.
          current.add(resourceId);
          warnings.push(
            `Skipped chat ${composerId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        if (captured.kind === "missing") {
          continue;
        }
        current.add(resourceId);
        if (captured.kind === "unchanged") {
          continue;
        }
        const snapshot = captured.snapshot;
        const workspaceId = snapshot.header.workspaceId;
        const content = canonicalBytes(snapshot);
        snapshots.push({
          resourceId,
          kind: "chat",
          content,
          semanticHash: sha256(content),
          metadata: {
            composerId: snapshot.header.composerId,
            workspaceId,
            workspaceUri:
              workspaceId === null
                ? null
                : workspaceUris.get(workspaceId) ?? null,
            lastUpdatedAt: snapshot.header.lastUpdatedAt,
            bubbleCount: snapshot.bubbles.length,
          },
        });
      }
    } finally {
      database.close();
    }

    return {
      snapshots,
      deletions: findChatDeletions(known, current),
      warnings,
    };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Chat snapshots must be applied by the offline helper.");
  }
}

export function parsePortableChatSnapshot(content: Buffer): PortableChatSnapshot {
  const value = JSON.parse(content.toString("utf8")) as PortableChatSnapshot;
  if (
    value === null ||
    typeof value !== "object" ||
    value.schemaVersion !== 1 ||
    typeof value.composerId !== "string" ||
    value.header === null ||
    typeof value.header !== "object" ||
    value.header.composerId !== value.composerId ||
    value.composerData === null ||
    typeof value.composerData !== "object" ||
    !Array.isArray(value.bubbles)
  ) {
    throw new Error("Unsupported or invalid chat snapshot.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.composerId)) {
    throw new Error("Chat snapshot composer ID is invalid.");
  }
  if (value.composerData.key !== `composerData:${value.composerId}`) {
    throw new Error("Chat snapshot composerData key does not match its composer ID.");
  }
  if (
    !isValidBase64(value.composerData.valueBase64) ||
    !isNullableText(value.header.workspaceId) ||
    !isNullableText(value.header.value) ||
    ![
      value.header.createdAt,
      value.header.lastUpdatedAt,
      value.header.isArchived,
      value.header.isSubagent,
      value.header.recency,
      value.header.checkpointAt,
    ].every(
      (item) =>
        item === null || (typeof item === "number" && Number.isFinite(item)),
    ) ||
    value.bubbles.length > 250_000
  ) {
    throw new Error("Chat snapshot fields are invalid.");
  }
  if (
    value.bubbles.some(
      (bubble) =>
        bubble === null ||
        typeof bubble !== "object" ||
        typeof bubble.key !== "string" ||
        bubble.key.length <= `bubbleId:${value.composerId}:`.length ||
        !bubble.key.startsWith(`bubbleId:${value.composerId}:`) ||
        !isValidBase64(bubble.valueBase64),
    )
  ) {
    throw new Error("Chat snapshot contains a bubble for another composer.");
  }
  if (new Set(value.bubbles.map((bubble) => bubble.key)).size !== value.bubbles.length) {
    throw new Error("Chat snapshot contains duplicate bubble keys.");
  }
  if (
    !isValidKvValueType(value.composerData.valueType) ||
    value.bubbles.some((bubble) => !isValidKvValueType(bubble.valueType))
  ) {
    throw new Error("Chat snapshot contains an invalid value storage class.");
  }
  return value;
}

function isValidKvValueType(value: unknown): value is PortableKvRow["valueType"] {
  return (
    value === undefined ||
    value === "text" ||
    value === "blob" ||
    value === "null"
  );
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isValidBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    return false;
  }
  return (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function captureChat(
  database: DatabaseSync,
  statements: ChatStatements,
  composerId: string,
  known: Record<string, LocalProjection>,
): ChatCapture {
  database.exec("BEGIN");
  try {
    const currentHeader = statements.header.get(composerId) as
      | RawComposerHeader
      | undefined;
    if (currentHeader === undefined) {
      database.exec("COMMIT");
      return { kind: "missing" };
    }
    const header = normalizeHeader(currentHeader);
    const resourceId = `chat/${header.composerId}`;
    // A null timestamp carries no change information, so it must never
    // short-circuit against a projection that simply recorded none either.
    if (
      header.lastUpdatedAt !== null &&
      known[resourceId]?.kind === "chat" &&
      known[resourceId]?.sourceTimestamp === header.lastUpdatedAt
    ) {
      database.exec("COMMIT");
      return { kind: "unchanged" };
    }
    const composerDataRow = statements.data.get(
      `composerData:${header.composerId}`,
    ) as RawKvRow | undefined;
    if (composerDataRow === undefined) {
      throw new Error("composerData row is missing.");
    }
    const bubbleRows = statements.bubbles.all(
      `bubbleId:${header.composerId}:%`,
    ) as RawKvRow[];
    const snapshot: PortableChatSnapshot = {
      schemaVersion: 1,
      composerId: header.composerId,
      header,
      composerData: portableRow(composerDataRow),
      bubbles: bubbleRows.map(portableRow),
    };
    database.exec("COMMIT");
    return { kind: "captured", snapshot };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function normalizeHeader(header: RawComposerHeader): PortableComposerHeader {
  if (typeof header.composerId !== "string") {
    throw new Error("composerId is not text.");
  }
  return {
    composerId: header.composerId,
    workspaceId: nullableText(header.workspaceId, "workspaceId"),
    createdAt: nullableNumber(header.createdAt, "createdAt"),
    lastUpdatedAt: nullableNumber(header.lastUpdatedAt, "lastUpdatedAt"),
    isArchived: nullableNumber(header.isArchived, "isArchived"),
    isSubagent: nullableNumber(header.isSubagent, "isSubagent"),
    recency: nullableNumber(header.recency, "recency"),
    checkpointAt: nullableNumber(header.checkpointAt, "checkpointAt"),
    value: nullableText(header.value, "value"),
  };
}

// Coercing an unexpected storage class here would publish fabricated data: a
// BLOB would become its comma-joined bytes, and a non-numeric value would
// become NaN, which canonicalization turns into a NULL that overwrites the
// target's real value. Rejecting instead lets the caller skip the composer.
function nullableText(value: SqliteRowValue, column: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      `composerHeaders.${column} has an unsupported SQLite storage class.`,
    );
  }
  return value;
}

function nullableNumber(value: SqliteRowValue, column: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `composerHeaders.${column} has an unsupported SQLite storage class.`,
    );
  }
  return value;
}

function portableRow(row: RawKvRow): PortableKvRow {
  if (typeof row.key !== "string") {
    throw new Error("A cursorDiskKV key is not text.");
  }
  if (row.valueType === "null" && row.value === null) {
    return { key: row.key, valueBase64: "", valueType: "null" };
  }
  if (row.valueType === "text" && typeof row.value === "string") {
    return {
      key: row.key,
      valueBase64: Buffer.from(row.value, "utf8").toString("base64"),
      valueType: "text",
    };
  }
  if (row.valueType === "blob" && row.value instanceof Uint8Array) {
    return {
      key: row.key,
      valueBase64: Buffer.from(row.value).toString("base64"),
      valueType: "blob",
    };
  }
  throw new Error(
    `cursorDiskKV key ${row.key} has an unsupported SQLite storage class: ${String(
      row.valueType,
    )}.`,
  );
}

function findChatDeletions(
  known: Record<string, LocalProjection>,
  current: Set<string>,
): ResourceDeletion[] {
  return Object.values(known)
    .filter(
      (projection) =>
        projection.kind === "chat" && !current.has(projection.resourceId),
    )
    .map((projection) => {
      const composerId = projection.resourceId.slice("chat/".length);
      return {
        resourceId: projection.resourceId,
        kind: "chat",
        semanticHash: sha256(`deleted:${projection.resourceId}`),
        metadata: {
          composerId,
          ...(projection.sourceTimestamp === undefined
            ? {}
            : { lastUpdatedAt: projection.sourceTimestamp }),
        },
      };
    });
}
