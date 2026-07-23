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
  workspaceId: string;
  createdAt: number;
  lastUpdatedAt: number;
  isArchived: number;
  isSubagent: number;
  recency: number;
  checkpointAt: number;
  value: string;
}

export interface PortableKvRow {
  key: string;
  valueBase64: string;
  /** SQLite storage class; absent in older snapshots, which are TEXT. */
  valueType?: "text" | "blob";
}

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
      const headers = database
        .prepare(
          "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value FROM composerHeaders WHERE isSubagent = 0",
        )
        .all() as unknown as PortableComposerHeader[];
      const selectData = database.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key = ?",
      );
      const selectHeader = database.prepare(
        "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value FROM composerHeaders WHERE composerId = ? AND isSubagent = 0",
      );
      const selectBubbles = database.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key",
      );
      for (const rawHeader of headers) {
        let snapshot: PortableChatSnapshot | null = null;
        database.exec("BEGIN");
        try {
          const currentHeader = selectHeader.get(rawHeader.composerId) as
            | PortableComposerHeader
            | undefined;
          if (currentHeader === undefined) {
            database.exec("COMMIT");
            continue;
          }
          const header = normalizeHeader(currentHeader);
          const resourceId = `chat/${header.composerId}`;
          current.add(resourceId);
          if (
            known[resourceId]?.kind === "chat" &&
            known[resourceId]?.sourceTimestamp === header.lastUpdatedAt
          ) {
            database.exec("COMMIT");
            continue;
          }
          const composerDataRow = selectData.get(
            `composerData:${header.composerId}`,
          ) as { key: string; value: Uint8Array | string } | undefined;
          if (composerDataRow === undefined) {
            warnings.push(`Missing composerData for ${header.composerId}.`);
            database.exec("COMMIT");
            continue;
          }
          const bubbleRows = selectBubbles.all(
            `bubbleId:${header.composerId}:%`,
          ) as Array<{
            key: string;
            value: Uint8Array | string;
          }>;
          snapshot = {
            schemaVersion: 1,
            composerId: header.composerId,
            header,
            composerData: portableRow(composerDataRow),
            bubbles: bubbleRows.map(portableRow),
          };
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        if (snapshot === null) {
          continue;
        }
        const resourceId = `chat/${snapshot.composerId}`;
        const content = canonicalBytes(snapshot);
        snapshots.push({
          resourceId,
          kind: "chat",
          content,
          semanticHash: sha256(content),
          metadata: {
            composerId: snapshot.header.composerId,
            workspaceId: snapshot.header.workspaceId,
            workspaceUri:
              workspaceUris.get(snapshot.header.workspaceId) ?? null,
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
    typeof value.header.workspaceId !== "string" ||
    typeof value.header.value !== "string" ||
    ![
      value.header.createdAt,
      value.header.lastUpdatedAt,
      value.header.isArchived,
      value.header.isSubagent,
      value.header.recency,
      value.header.checkpointAt,
    ].every((item) => typeof item === "number" && Number.isFinite(item)) ||
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
  return value === undefined || value === "text" || value === "blob";
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

function normalizeHeader(header: PortableComposerHeader): PortableComposerHeader {
  return {
    composerId: String(header.composerId),
    workspaceId: String(header.workspaceId),
    createdAt: Number(header.createdAt),
    lastUpdatedAt: Number(header.lastUpdatedAt),
    isArchived: Number(header.isArchived),
    isSubagent: Number(header.isSubagent),
    recency: Number(header.recency),
    checkpointAt: Number(header.checkpointAt),
    value: String(header.value),
  };
}

function portableRow(row: {
  key: string;
  value: Uint8Array | string;
}): PortableKvRow {
  const value = typeof row.value === "string" ? Buffer.from(row.value, "utf8") : Buffer.from(row.value);
  return {
    key: row.key,
    valueBase64: value.toString("base64"),
    valueType: typeof row.value === "string" ? "text" : "blob",
  };
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
