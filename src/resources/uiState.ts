import type { SqliteStorageValue } from "../platform/sqlite";
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
  isIgnoredUiStateKey,
  parseTargetStorageMarker,
} from "./uiStatePolicy";
import type { IgnoreMatcher } from "./ignorePatterns";
import { createIgnoreMatcher } from "./ignorePatterns";

export class UiStateAdapter implements ResourceAdapter {
  readonly id = "ui-state";
  readonly kinds = ["ui-state", "cursor-user-rules"] as const;
  readonly appliesWhileRunning = false;

  constructor(
    private readonly paths: CursorPaths,
    private readonly ignoredKeys: IgnoreMatcher = createIgnoreMatcher([]),
  ) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const database = openDatabase(this.paths.globalDatabase, { readOnly: true });
    try {
      // Cursor writes to this database while it runs; wait out short lock
      // bursts instead of failing the whole sync cycle with SQLITE_BUSY.
      database.exec("PRAGMA busy_timeout=2000");
      database.exec("PRAGMA query_only=ON");
      const scanWarnings: string[] = [];
      const markerRow = database
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get(TARGET_STORAGE_MARKER) as
        | { value?: SqliteStorageValue }
        | undefined;
      // An unreadable marker must not take down the whole adapter: without it
      // no key is known to be USER-target, but cursor-user-rules still syncs.
      //
      // It must not produce deletions either. Without the marker `keys`
      // collapses to cursor-user-rules alone, so every ui-state resource this
      // device ever projected would look absent and be published as a
      // tombstone — the peers would then delete their live UI state. The scan
      // is incomplete, and an incomplete scan never deletes; this mirrors
      // `scannedProfiles` in the settings and extension adapters.
      let targets: Record<string, number> = {};
      let markerReadable = true;
      try {
        targets = parseTargetStorageMarker(markerRow?.value);
      } catch (error) {
        markerReadable = false;
        scanWarnings.push(
          `Unable to read the UI state target marker, so no UI state deletions are published from this scan: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const keys = Object.entries(targets)
        .filter(([, target]) => target === USER_STORAGE_TARGET)
        .map(([key]) => key)
        .filter(
          (key) =>
            !isDeniedUiStateKey(key) && !isIgnoredUiStateKey(key, this.ignoredKeys),
        );
      if (!keys.includes(CURSOR_USER_RULES_KEY)) {
        keys.push(CURSOR_USER_RULES_KEY);
      }

      const snapshots: ResourceSnapshot[] = [];
      const warnings: string[] = [...scanWarnings];
      const current = new Set<string>();
      const select = database.prepare("SELECT value FROM ItemTable WHERE key = ?");
      for (const key of keys.sort((left, right) => left.localeCompare(right))) {
        const row = select.get(key) as { value?: SqliteStorageValue } | undefined;
        const raw = row?.value;
        if (raw === undefined) {
          continue;
        }
        const kind: ResourceKind =
          key === CURSOR_USER_RULES_KEY ? "cursor-user-rules" : "ui-state";
        const resourceId = uiStateResourceId(kind, key);
        if (typeof raw !== "string" && !(raw instanceof Uint8Array)) {
          // The wire format has no NULL storage class, and publishing empty
          // content would overwrite a peer's real value. The row is still in
          // `current` so a present-but-unusable value is not a deletion.
          current.add(resourceId);
          warnings.push(
            `ui-state ${key}: skipped an unusable SQLite value (${
              raw === null ? "NULL" : typeof raw
            }).`,
          );
          continue;
        }
        const content = toBuffer(raw);
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
            valueType: typeof raw === "string" ? "text" : "blob",
          },
        });
      }
      return {
        snapshots,
        deletions: findDeletions(
          known,
          current,
          this.ignoredKeys,
          markerReadable,
        ),
        warnings,
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
  ignoredKeys: IgnoreMatcher,
  markerReadable: boolean,
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
      // cursor-user-rules is read by its own fixed key and does not depend on
      // the marker, so its absence is still trustworthy.
      if (!markerReadable && projection.kind === "ui-state") {
        return false;
      }
      const encodedKey = projection.resourceId.split("/")[1];
      if (encodedKey === undefined) {
        return false;
      }
      if (projection.kind === "cursor-user-rules") {
        return true;
      }
      const key = decodeURIComponent(encodedKey);
      return !isDeniedUiStateKey(key) && !isIgnoredUiStateKey(key, ignoredKeys);
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
