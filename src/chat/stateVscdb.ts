import type { DatabaseSync } from "../platform/sqlite";
import { openDatabase } from "../platform/sqlite";
import type {
  LocalProjection,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  canonicalBytes,
  isCanonicalBase64Text,
  sha256,
} from "../protocol/canonical";
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

interface ChatIdentity {
  /** Resolved UUID text, used for resource IDs and cursorDiskKV key prefixes. */
  composerId: string;
  /** The raw column value, used to bind the composerHeaders lookup. */
  headerKey: SqliteRowValue;
}

type ChatCapture =
  | { kind: "missing" }
  | { kind: "unchanged" }
  | { kind: "incomplete" }
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
    const bodyless: string[] = [];
    let identityUnknown = false;
    try {
      // Cursor writes to this database while it runs; wait out short lock
      // bursts instead of failing the whole sync cycle with SQLITE_BUSY.
      database.exec("PRAGMA busy_timeout=2000");
      database.exec("PRAGMA query_only=ON");
      // NULL = 0 is NULL, not true, so a composer whose late-added isSubagent
      // column was never backfilled must be matched explicitly or it silently
      // drops out of the scan and is published as a deletion.
      // `lastUpdatedAt` is selected here as well so the steady state - every
      // chat unchanged - is answered from this one query. Re-opening a
      // transaction and re-reading the header row per composer, only to compare
      // the same timestamp and roll straight back out, cost three statement
      // executions per chat on every 30-second poll against a database Cursor
      // is concurrently writing to.
      const headers = database
        .prepare(
          "SELECT composerId, lastUpdatedAt FROM composerHeaders WHERE COALESCE(isSubagent, 0) = 0",
        )
        .all() as Array<{
        composerId: SqliteRowValue;
        lastUpdatedAt: SqliteRowValue;
      }>;
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
        const composerId = composerIdText(rawHeader.composerId);
        if (composerId === null) {
          // Without an identity this header cannot be matched against `known`,
          // so whichever chat it is looks absent and would be published as a
          // deletion. That tombstone becomes the repository tip and the chat
          // stops propagating for good, so the whole scan gives up on
          // deletions rather than guess.
          identityUnknown = true;
          warnings.push(
            "Skipped a composer header whose composerId is neither text nor a UTF-8 encoded chat ID; no chat deletions are published from this scan.",
          );
          continue;
        }
        const resourceId = `chat/${composerId}`;
        // A composer whose ID is not a chat ID cannot be synchronized at all:
        // `parsePortableChatSnapshot` is the apply-side gate as well, so every
        // device that received one would reject it. Publishing it anyway cost
        // an event, a payload object, a permanently pending change and — once
        // the other machine published its own copy — a conflict that no
        // automatic path could resolve and no person could adjudicate. Cursor
        // keeps at least one of these permanently (`empty-state-draft`).
        //
        // It stays in `current` so it is never published as a deletion: a
        // tombstone would be a claim about the resource rather than silence
        // about it, and this build simply has nothing to say.
        if (!COMPOSER_ID_PATTERN.test(composerId)) {
          current.add(resourceId);
          continue;
        }
        // Only a timestamp that is a real number carries change information, and
        // the projection has to already be a chat for the comparison to mean
        // anything. Anything else falls through to the transactional capture,
        // which is where the authoritative comparison still lives.
        const listedTimestamp = plainNumber(rawHeader.lastUpdatedAt);
        if (
          listedTimestamp !== null &&
          known[resourceId]?.kind === "chat" &&
          known[resourceId]?.sourceTimestamp === listedTimestamp
        ) {
          current.add(resourceId);
          continue;
        }
        let captured: ChatCapture;
        try {
          captured = captureChat(
            database,
            statements,
            { composerId, headerKey: rawHeader.composerId },
            known,
          );
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
        // Aggregated rather than warned per chat: a body that never arrives is
        // never publishable, so a per-chat line would repeat on every poll
        // forever. The IDs still travel with the count, because a body-less
        // header is also what a mass loss looks like.
        if (captured.kind === "incomplete") {
          bodyless.push(composerId);
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
      if (bodyless.length > 0) {
        warnings.push(bodylessChatsWarning(bodyless));
      }
    } finally {
      database.close();
    }

    return {
      snapshots,
      deletions: identityUnknown ? [] : findChatDeletions(known, current),
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
  return (
    typeof value === "string" &&
    isCanonicalBase64Text(value) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function captureChat(
  database: DatabaseSync,
  statements: ChatStatements,
  identity: ChatIdentity,
  known: Record<string, LocalProjection>,
): ChatCapture {
  database.exec("BEGIN");
  try {
    // Bound with the raw value, not the decoded text: SQLite never considers a
    // BLOB equal to a TEXT, so a BLOB-affinity composerId would miss its own
    // row and read as a chat that had disappeared.
    const currentHeader = statements.header.get(identity.headerKey) as
      | RawComposerHeader
      | undefined;
    if (currentHeader === undefined) {
      database.exec("COMMIT");
      return { kind: "missing" };
    }
    const header = normalizeHeader(currentHeader, identity.composerId);
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
    // Cursor prunes the conversation body but leaves the list entry behind, so
    // a header without composerData is an expected state, not a broken row.
    if (composerDataRow === undefined) {
      database.exec("COMMIT");
      return { kind: "incomplete" };
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

function normalizeHeader(
  header: RawComposerHeader,
  composerId: string,
): PortableComposerHeader {
  return {
    // The caller resolved this from the raw column value; a BLOB-affinity
    // composerId carries the same UUID text as every other reference to it.
    composerId,
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

/** A SQLite value usable as a change timestamp, or null if it is not one. */
function plainNumber(value: SqliteRowValue): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const COMPOSER_ID_PATTERN =
  /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const BODYLESS_SAMPLE_SIZE = 5;

/**
 * Whether a composer ID names a chat this build can carry between devices.
 *
 * The scan already refuses to publish anything else; exported so the inbound
 * side can refuse the same set, which it has to, because a resource the scan
 * will not produce is one nothing can ever observe as applied.
 */
export function isSyncableComposerId(composerId: string): boolean {
  return COMPOSER_ID_PATTERN.test(composerId);
}

/**
 * Resolves the identity of a composer header row. SQLite column affinity does
 * not stop a BLOB from landing in `composerHeaders.composerId`, and node:sqlite
 * hands those back as a Uint8Array; the bytes are the same UUID text Cursor
 * writes everywhere else, so decoding them recovers a usable identity. Anything
 * that is not a chat ID afterwards is not something we can match against the
 * known projections, and the caller must not guess.
 */
function composerIdText(value: SqliteRowValue): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    const decoded = Buffer.from(value).toString("utf8");
    return COMPOSER_ID_PATTERN.test(decoded) ? decoded : null;
  }
  return null;
}

/**
 * A header with no `composerData` row is usually Cursor keeping a list entry
 * after pruning the conversation, but a helper that wrote headers and then died
 * before the bodies looks exactly the same. The message therefore states what
 * was observed and carries IDs, so a mass loss is diagnosable instead of
 * reading as one reassuring line.
 */
function bodylessChatsWarning(composerIds: readonly string[]): string {
  const sample = composerIds.slice(0, BODYLESS_SAMPLE_SIZE).join(", ");
  const remainder = composerIds.length - Math.min(
    composerIds.length,
    BODYLESS_SAMPLE_SIZE,
  );
  return `Skipped ${composerIds.length} chat(s) whose conversation body is not in the database: ${sample}${
    remainder === 0 ? "" : ` and ${remainder} more`
  }. Expected when Cursor prunes a conversation and keeps its list entry; if you still expect one of these chats, its body was lost locally.`;
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
