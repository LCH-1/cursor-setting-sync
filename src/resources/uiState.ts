import { openDatabase } from "../platform/sqlite";
import {
  CURSOR_USER_RULES_KEY,
  TARGET_STORAGE_MARKER,
  USER_STORAGE_TARGET,
} from "../constants";
import type {
  LocalProjection,
  ResourceDeletion,
  ResourceKind,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import { sha256 } from "../protocol/canonical";
import type { ResourceAdapter, ResourceApplyInput } from "./resource";
import {
  isDeniedUiStateKey,
  parseTargetStorageMarker,
} from "./uiStatePolicy";

export class UiStateAdapter implements ResourceAdapter {
  readonly id = "ui-state";
  readonly kinds = ["ui-state", "cursor-user-rules"] as const;
  readonly appliesWhileRunning = false;

  constructor(private readonly paths: CursorPaths) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const database = openDatabase(this.paths.globalDatabase, { readOnly: true });
    try {
      // Cursor writes to this database while it runs; wait out short lock
      // bursts instead of failing the whole sync cycle with SQLITE_BUSY.
      database.exec("PRAGMA busy_timeout=2000");
      database.exec("PRAGMA query_only=ON");
      const markerRow = database
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get(TARGET_STORAGE_MARKER) as { value?: Uint8Array | string } | undefined;
      const targets = parseTargetStorageMarker(markerRow?.value);
      const keys = Object.entries(targets)
        .filter(([, target]) => target === USER_STORAGE_TARGET)
        .map(([key]) => key)
        .filter((key) => !isDeniedUiStateKey(key));
      if (!keys.includes(CURSOR_USER_RULES_KEY)) {
        keys.push(CURSOR_USER_RULES_KEY);
      }

      const snapshots: ResourceSnapshot[] = [];
      const current = new Set<string>();
      const select = database.prepare("SELECT value FROM ItemTable WHERE key = ?");
      for (const key of keys.sort((left, right) => left.localeCompare(right))) {
        const row = select.get(key) as { value?: Uint8Array | string } | undefined;
        if (row?.value === undefined) {
          continue;
        }
        const content = toBuffer(row.value);
        const kind: ResourceKind =
          key === CURSOR_USER_RULES_KEY ? "cursor-user-rules" : "ui-state";
        const resourceId = uiStateResourceId(kind, key);
        current.add(resourceId);
        snapshots.push({
          resourceId,
          kind,
          content,
          semanticHash: sha256(content),
          metadata: {
            key,
            registeredUserTarget: targets[key] === USER_STORAGE_TARGET,
            // SQLite storage class; the apply side must bind TEXT as a string
            // or VS Code's strict string comparisons silently reset UI state.
            valueType: typeof row.value === "string" ? "text" : "blob",
          },
        });
      }
      return {
        snapshots,
        deletions: findDeletions(known, current),
        warnings: [],
      };
    } finally {
      database.close();
    }
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("UI state must be applied by the offline helper.");
  }
}

function findDeletions(
  known: Record<string, LocalProjection>,
  current: Set<string>,
): ResourceDeletion[] {
  return Object.values(known)
    .filter((projection) => {
      if (
        (projection.kind !== "ui-state" &&
          projection.kind !== "cursor-user-rules") ||
        current.has(projection.resourceId)
      ) {
        return false;
      }
      const encodedKey = projection.resourceId.split("/")[1];
      return (
        encodedKey !== undefined &&
        (projection.kind === "cursor-user-rules" ||
          !isDeniedUiStateKey(decodeURIComponent(encodedKey)))
      );
    })
    .map((projection) => {
      const encodedKey = projection.resourceId.split("/")[1];
      if (encodedKey === undefined) {
        throw new Error(`Invalid UI state resource ID: ${projection.resourceId}`);
      }
      return {
        resourceId: projection.resourceId,
        kind: projection.kind,
        semanticHash: sha256(`deleted:${projection.resourceId}`),
        metadata: {
          key: decodeURIComponent(encodedKey),
          registeredUserTarget: projection.kind === "ui-state",
        },
      };
    });
}

function uiStateResourceId(kind: ResourceKind, key: string): string {
  return `${kind}/${encodeURIComponent(key)}`;
}

function toBuffer(value: Uint8Array | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}
