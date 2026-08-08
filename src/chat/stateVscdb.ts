import type { DatabaseSync } from "../platform/sqlite";
import { openDatabase } from "../platform/sqlite";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type {
  LocalProjection,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  canonicalBytes,
  canonicalJson,
  isCanonicalBase64Text,
  sha256,
} from "../protocol/canonical";
import type { ResourceAdapter, ResourceApplyInput } from "../resources/resource";
import { discoverWorkspaces } from "./workspace";
import { chatHeaderTitle } from "./title";

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
  bubbleCount: ChatStatement;
}

interface ChatIdentity {
  /** Resolved UUID text, used for resource IDs and cursorDiskKV key prefixes. */
  composerId: string;
  /** The raw column value, used to bind the composerHeaders lookup. */
  headerKey: SqliteRowValue;
}

interface SettledChatScan {
  /** Main database plus WAL identity captured before the successful scan. */
  databaseFingerprint: string;
  /** Repository-side chat projections the scan compared against. */
  knownFingerprint: string;
  /** Narrows a repository-only change to the chats whose bodies need reading. */
  projectionFingerprints: ReadonlyMap<string, string>;
  /** Detects header edits for which Cursor left lastUpdatedAt unchanged. */
  headerFingerprints: ReadonlyMap<string, string>;
  /** Stable informational notices still need to remain visible to the UI. */
  notices: readonly string[];
}

interface DeepVerificationSweep {
  /** Index in the sorted, syncable composer IDs for the current pass. */
  nextIndex: number;
  /** A mutation during this pass requires one more complete pass. */
  needsAnotherPass: boolean;
  /** Last fingerprints observed, so new changes do not restart this pass. */
  databaseFingerprint: string;
  knownFingerprint: string;
}

interface PendingChatSnapshot {
  semanticHash: string;
  /** Database generation from which the returned snapshot was captured. */
  databaseFingerprint: string;
}

type ChatCapture =
  | { kind: "missing" }
  | { kind: "unchanged" }
  | { kind: "incomplete" }
  | { kind: "pruned"; had: number; has: number }
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

  /** Last stable full header observation, whether or not it emitted work. */
  private lastScan: SettledChatScan | null = null;
  /** Observation eligible for the zero-SQLite idle shortcut. */
  private settledScan: SettledChatScan | null = null;
  /** Equal-count body verification, spread across bounded polling cycles. */
  private deepVerificationSweep: DeepVerificationSweep | null = null;
  /** Snapshots returned to the manager but not yet reflected by `known`. */
  private readonly pendingSnapshots = new Map<string, PendingChatSnapshot>();

  constructor(private readonly paths: CursorPaths) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const databaseFingerprint = await stateVscdbFingerprint(
      this.paths.globalDatabase,
    );
    const knownFingerprints = knownChatsFingerprints(known);
    const knownFingerprint = knownFingerprints.combined;
    const acknowledgedPendingSnapshots = new Set<string>();
    for (const [resourceId, pending] of this.pendingSnapshots) {
      const projection = known[resourceId];
      if (
        projection?.kind === "chat" &&
        (projection.semanticHash === pending.semanticHash ||
          projection.retainedLocalHash === pending.semanticHash)
      ) {
        if (pending.databaseFingerprint === databaseFingerprint) {
          acknowledgedPendingSnapshots.add(resourceId);
        }
        this.pendingSnapshots.delete(resourceId);
      }
    }
    const previousScan = this.lastScan;
    const settledScan = this.settledScan;
    if (
      this.pendingSnapshots.size === 0 &&
      this.deepVerificationSweep === null &&
      settledScan?.databaseFingerprint === databaseFingerprint &&
      settledScan.knownFingerprint === knownFingerprint
    ) {
      // A successful settled scan produced neither snapshots nor deletions. If
      // neither side of that comparison moved, repeating synchronous SQLite
      // work cannot produce a different answer. In particular this avoids
      // waking a multi-gigabyte state.vscdb every thirty seconds while Cursor
      // is idle. Notices are repeated because the standing-notice registry
      // expects adapters to keep reporting conditions that remain true.
      return {
        snapshots: [],
        deletions: [],
        warnings: [],
        notices: [...settledScan.notices],
      };
    }
    // A scan that is about to touch SQLite invalidates the idle shortcut. The
    // last stable observation remains available for narrow header/projection
    // comparisons even when the preceding scan emitted a snapshot.
    this.settledScan = null;
    const isInitialScan = previousScan === null;
    const databaseChangedSinceLastScan =
      previousScan !== null &&
      previousScan.databaseFingerprint !== databaseFingerprint;
    if (isInitialScan || databaseChangedSinceLastScan) {
      if (this.deepVerificationSweep === null) {
        this.deepVerificationSweep = {
          nextIndex: 0,
          needsAnotherPass: false,
          databaseFingerprint,
          knownFingerprint,
        };
      }
    }
    const activeSweep = this.deepVerificationSweep;
    if (
      activeSweep !== null &&
      (activeSweep.databaseFingerprint !== databaseFingerprint ||
        activeSweep.knownFingerprint !== knownFingerprint)
    ) {
      // Finish the current pass instead of restarting at index zero. Cursor can
      // append to the WAL every few seconds; resetting here would starve chats
      // near the end forever. One follow-up pass over the latest stable state
      // closes the gap once churn stops, while continuous churn still audits
      // every chat round-robin.
      activeSweep.needsAnotherPass = true;
      activeSweep.databaseFingerprint = databaseFingerprint;
      activeSweep.knownFingerprint = knownFingerprint;
    }
    const workspaceUris = new Map(
      (await discoverWorkspaces(this.paths)).map((workspace) => [
        workspace.id,
        workspace.uri,
      ]),
    );
    const database = openDatabase(this.paths.globalDatabase, { readOnly: true });
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const notices: string[] = [];
    const current = new Set<string>();
    const bodyless: string[] = [];
    const pruned: string[] = [];
    const nonReconstructablePendingSnapshots = new Set<string>();
    const headerFingerprints = new Map<string, string>();
    let identityUnknown = false;
    let syncableResourceCount: number;
    let sweepEndIndex: number;
    try {
      // Cursor writes to this database while it runs; wait out short lock
      // bursts instead of failing the whole sync cycle with SQLITE_BUSY.
      database.exec("PRAGMA busy_timeout=2000");
      database.exec("PRAGMA query_only=ON");
      // NULL = 0 is NULL, not true, so a composer whose late-added isSubagent
      // column was never backfilled must be matched explicitly or it silently
      // drops out of the scan and is published as a deletion.
      // Every header column is selected because Cursor does not consistently
      // advance lastUpdatedAt when it edits archive/title/recency fields. The
      // table is small; fingerprinting these rows is cheap and prevents such an
      // edit from hiding behind an unchanged timestamp and bubble count.
      const headers = database
        .prepare(
          "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value " +
            "FROM composerHeaders WHERE COALESCE(isSubagent, 0) = 0",
        )
        .all() as RawComposerHeader[];
      const syncableResourceIds = [
        ...new Set(
          headers
            .map((header) => composerIdText(header.composerId))
            .filter(
              (composerId): composerId is string =>
                composerId !== null && COMPOSER_ID_PATTERN.test(composerId),
            )
            .map((composerId) => `chat/${composerId}`),
        ),
      ].sort();
      syncableResourceCount = syncableResourceIds.length;
      const sweepStartIndex = activeSweep?.nextIndex ?? 0;
      sweepEndIndex =
        activeSweep === null
          ? 0
          : Math.min(
              syncableResourceIds.length,
              sweepStartIndex + DEEP_VERIFICATION_BATCH_SIZE,
            );
      const deepVerificationIds = new Set(
        syncableResourceIds.slice(sweepStartIndex, sweepEndIndex),
      );
      const statements: ChatStatements = {
        header: database.prepare(
          "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value FROM composerHeaders WHERE composerId = ? AND COALESCE(isSubagent, 0) = 0",
        ),
        data: database.prepare(
          "SELECT key, value, typeof(value) AS valueType FROM cursorDiskKV WHERE key = ?",
        ),
        bubbles: database.prepare(
          "SELECT key, value, typeof(value) AS valueType FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key",
        ),
        bubbleCount: database.prepare(
          "SELECT COUNT(*) AS total FROM cursorDiskKV WHERE key >= ? AND key < ?",
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
        const headerFingerprint = rawHeaderFingerprint(rawHeader);
        headerFingerprints.set(resourceId, headerFingerprint);
        // Only a timestamp that is a real number carries change information, and
        // the projection has to already be a chat for the comparison to mean
        // anything. Anything else falls through to the transactional capture,
        // which is where the authoritative comparison still lives.
        const listedTimestamp = plainNumber(rawHeader.lastUpdatedAt);
        const projection = known[resourceId];
        const headerChangedSinceSettledScan =
          previousScan !== null &&
          previousScan.headerFingerprints.get(resourceId) !==
            headerFingerprint;
        const projectionChangedSinceSettledScan =
          previousScan !== null &&
          !acknowledgedPendingSnapshots.has(resourceId) &&
          previousScan.projectionFingerprints.get(resourceId) !==
            knownFingerprints.byResource.get(resourceId);
        const bodyMustBeRead =
          this.pendingSnapshots.has(resourceId) ||
          deepVerificationIds.has(resourceId) ||
          projectionChangedSinceSettledScan ||
          headerChangedSinceSettledScan;
        // Cursor usually advances lastUpdatedAt with a header edit, but not for
        // every column in every release. A changed row fingerprint must
        // therefore fall through to the transactional capture even if its
        // timestamp and bubble count still match the projection.
        if (
          !bodyMustBeRead &&
          listedTimestamp !== null &&
          projection?.kind === "chat" &&
          projection.sourceTimestamp === listedTimestamp &&
          typeof projection.sourceBubbleCount === "number" &&
          projection.sourceBubbleCount ===
            currentBubbleCount(statements.bubbleCount, composerId)
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
            bodyMustBeRead,
          );
          // Deep verification can materialize several megabytes of SQLite
          // text and canonical JSON for one conversation. Yield between those
          // exceptional body reads so the shared extension host can service
          // Cursor and the other extensions instead of appearing frozen for
          // one long synchronous burst.
          if (bodyMustBeRead) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
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
          // A previously emitted snapshot can be superseded locally before the
          // manager acknowledges it (for example Cursor/undo restores the
          // repository version). Forced streaming verification proved the
          // current bytes equal that known version, so the obsolete retry must
          // not keep the zero-SQLite idle path disabled forever.
          this.pendingSnapshots.delete(resourceId);
          continue;
        }
        // Aggregated rather than warned per chat: a body that never arrives is
        // never publishable, so a per-chat line would repeat on every poll
        // forever. The IDs still travel with the count, because a body-less
        // header is also what a mass loss looks like.
        if (captured.kind === "incomplete") {
          // A previously returned put can no longer be reconstructed from this
          // database. Keep the repository's older complete copy and allow the
          // adapter to settle instead of forcing this body-less row forever.
          if (this.pendingSnapshots.has(resourceId)) {
            nonReconstructablePendingSnapshots.add(resourceId);
          }
          bodyless.push(composerId);
          continue;
        }
        // Aggregated for the same reason, and a notice rather than a warning:
        // the repository still holds the full conversation, so nothing was
        // lost that this device can act on - it is the other computer's copy
        // being protected from this one's pruning.
        if (captured.kind === "pruned") {
          if (this.pendingSnapshots.has(resourceId)) {
            nonReconstructablePendingSnapshots.add(resourceId);
          }
          pruned.push(`${composerId} (${captured.had} -> ${captured.has})`);
          continue;
        }
        const snapshot = captured.snapshot;
        const workspaceId = snapshot.header.workspaceId;
        const title = chatHeaderTitle(snapshot.header.value);
        const content = canonicalBytes(snapshot);
        const semanticHash = sha256(content);
        if (
          projection?.kind === "chat" &&
          (projection.semanticHash === semanticHash ||
            projection.retainedLocalHash === semanticHash)
        ) {
          // A forced body verification must read exact bytes, but it need not
          // retain and hand the unchanged (potentially huge) snapshot to the
          // manager. The manager's publish policy makes the same two checks.
          rememberObservedChatSource(
            projection,
            snapshot.header.lastUpdatedAt,
            snapshot.bubbles.length,
          );
          this.pendingSnapshots.delete(resourceId);
          continue;
        }
        this.pendingSnapshots.set(resourceId, {
          semanticHash,
          databaseFingerprint,
        });
        snapshots.push({
          resourceId,
          kind: "chat",
          content,
          semanticHash,
          metadata: {
            composerId: snapshot.header.composerId,
            workspaceId,
            workspaceUri:
              workspaceId === null
                ? null
                : workspaceUris.get(workspaceId) ?? null,
            lastUpdatedAt: snapshot.header.lastUpdatedAt,
            bubbleCount: snapshot.bubbles.length,
            ...(title === null ? {} : { title }),
          },
        });
      }
      if (bodyless.length > 0) {
        notices.push(bodylessChatsWarning(bodyless));
      }
      if (pruned.length > 0) {
        notices.push(prunedChatsNotice(pruned));
      }
    } finally {
      database.close();
    }

    const candidateDeletions = identityUnknown
      ? []
      : findChatDeletions(known, current);
    let afterDatabaseFingerprint: string | null = null;
    let databaseStable = false;
    try {
      afterDatabaseFingerprint = await stateVscdbFingerprint(
        this.paths.globalDatabase,
      );
      databaseStable = afterDatabaseFingerprint === databaseFingerprint;
    } catch {
      // Replacing or temporarily hiding the database after the header listing
      // is indistinguishable from a concurrent mutation. Fail closed below.
    }
    if (databaseStable) {
      for (const resourceId of nonReconstructablePendingSnapshots) {
        this.pendingSnapshots.delete(resourceId);
      }
      for (const resourceId of this.pendingSnapshots.keys()) {
        if (!current.has(resourceId)) {
          // The pending put no longer describes local state. A stable missing
          // header is represented by the deletion candidate below instead of
          // replaying an obsolete snapshot forever.
          this.pendingSnapshots.delete(resourceId);
        }
      }
    }
    // `scan` owns this projection object for the duration of the awaited call.
    // Exact semantic verification above may have upgraded legacy source
    // metadata in place, so the sweep must remember the post-upgrade value.
    // Keeping its pre-scan fingerprint would mistake its own learning for an
    // external repository change on the next poll and repeat the whole sweep.
    const observedKnownFingerprints = knownChatsFingerprints(known);

    if (activeSweep !== null) {
      if (!databaseStable) {
        activeSweep.needsAnotherPass = true;
      }
      activeSweep.databaseFingerprint =
        afterDatabaseFingerprint ?? databaseFingerprint;
      activeSweep.knownFingerprint = observedKnownFingerprints.combined;
      if (sweepEndIndex >= syncableResourceCount) {
        if (activeSweep.needsAnotherPass) {
          // Complete the pass that was already in flight, then cover the
          // latest generation from the beginning. This avoids starvation
          // under a continuously growing WAL.
          activeSweep.nextIndex = 0;
          activeSweep.needsAnotherPass = false;
        } else {
          this.deepVerificationSweep = null;
        }
      } else {
        activeSweep.nextIndex = sweepEndIndex;
      }
    }
    const result: ResourceScanResult = {
      snapshots,
      // A header inserted after the initial listing otherwise looks deleted.
      // Tombstones are destructive and may only come from one settled view of
      // the database; snapshots remain safe to publish from per-chat read
      // transactions and are rechecked by semantic hash downstream.
      deletions: databaseStable ? candidateDeletions : [],
      warnings,
      notices,
    };
    const scanIsQuiet =
      result.snapshots.length === 0 &&
      result.deletions.length === 0 &&
      result.warnings.length === 0;
    let stableObservation: SettledChatScan | null = null;
    if (databaseStable) {
      stableObservation = {
        databaseFingerprint,
        knownFingerprint: observedKnownFingerprints.combined,
        projectionFingerprints: observedKnownFingerprints.byResource,
        headerFingerprints,
        notices: [...notices],
      };
      // Pending snapshots above make unacknowledged puts reproducible even when
      // a later quiet batch advances this baseline. Warnings remain untrusted:
      // advancing past a malformed row could hide it behind timestamp/count.
      if (result.warnings.length === 0) {
        this.lastScan = stableObservation;
      }
    }
    if (
      scanIsQuiet &&
      this.deepVerificationSweep === null &&
      stableObservation !== null
    ) {
      // Fingerprint again after closing SQLite. If Cursor committed during the
      // scan, caching the later file state against an earlier DB snapshot could
      // hide that commit forever. Only equal before/after fingerprints are a
      // settled observation; otherwise the next poll deliberately scans again.
      this.settledScan = stableObservation;
    }
    return result;
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
  forceCapture = false,
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
    // Same two-part signal as the listing pass; see
    // `LocalProjection.sourceBubbleCount` for why the timestamp alone is not
    // enough. Counted inside the transaction so it agrees with the rows the
    // capture below would read.
    const bubbleRange = bubbleKeyRange(header.composerId);
    const liveBubbleCount = plainNumber(
      (
        statements.bubbleCount.get(...bubbleRange) as
          | { total?: SqliteRowValue }
          | undefined
      )?.total ?? 0,
    );
    if (
      !forceCapture &&
      header.lastUpdatedAt !== null &&
      known[resourceId]?.kind === "chat" &&
      known[resourceId]?.sourceTimestamp === header.lastUpdatedAt &&
      known[resourceId]?.sourceBubbleCount === (liveBubbleCount ?? 0)
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
    // A conversation that has LOST messages since this device last published
    // it is not a change to propagate.
    //
    // Cursor prunes conversation bodies on its own schedule, per computer.
    // Publishing the pruned capture made this device's housekeeping the shared
    // truth and emptied the other computer's copy of a conversation it still
    // held in full. Messages are immutable and append-only - Cursor offers no
    // way to delete one - so a shrink is never the user's doing, and the
    // richer version already in the repository is the one worth keeping.
    // Holding back also leaves that version available to be written back here.
    const knownCount = known[resourceId]?.sourceBubbleCount;
    if (
      known[resourceId]?.kind === "chat" &&
      typeof knownCount === "number" &&
      (liveBubbleCount ?? 0) < knownCount
    ) {
      database.exec("COMMIT");
      return { kind: "pruned", had: knownCount, has: liveBubbleCount ?? 0 };
    }
    if (forceCapture && known[resourceId]?.kind === "chat") {
      // Equal timestamp/count verification is deliberately streamed. A real
      // Cursor conversation can be tens of megabytes; materializing all rows,
      // their Base64 copies, the sorted object graph and one giant canonical
      // JSON buffer merely to prove that nothing changed caused large periodic
      // CPU and RAM spikes. Hashing the exact same canonical byte sequence one
      // row at a time keeps memory bounded by the largest single SQLite value.
      const semanticHash = streamedChatSemanticHash(
        header,
        composerDataRow,
        statements.bubbles.iterate(...bubbleRange) as Iterable<RawKvRow>,
      );
      if (
        semanticHash === known[resourceId]?.semanticHash ||
        semanticHash === known[resourceId]?.retainedLocalHash
      ) {
        database.exec("COMMIT");
        rememberObservedChatSource(
          known[resourceId],
          header.lastUpdatedAt,
          liveBubbleCount ?? 0,
        );
        return { kind: "unchanged" };
      }
    }
    const bubbleRows = statements.bubbles.all(...bubbleRange) as RawKvRow[];
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

/**
 * Hashes the canonical PortableChatSnapshot representation without retaining
 * the complete conversation or its complete JSON serialization in memory.
 *
 * The literal member order below is the UTF-16 code-unit order enforced by
 * `canonicalBytes`: bubbles, composerData, composerId, header, schemaVersion.
 * Each nested object still goes through the canonical encoder, so escaping,
 * nullable header fields and SQLite TEXT/BLOB/NULL distinctions remain byte
 * for byte identical to the published snapshot format.
 */
function streamedChatSemanticHash(
  header: PortableComposerHeader,
  composerData: RawKvRow,
  bubbles: Iterable<RawKvRow>,
): string {
  const hash = createHash("sha256");
  hash.update('{"bubbles":[');
  let first = true;
  for (const bubble of bubbles) {
    if (!first) {
      hash.update(",");
    }
    first = false;
    hash.update(canonicalJson(portableRow(bubble)));
  }
  hash.update('],"composerData":');
  hash.update(canonicalJson(portableRow(composerData)));
  hash.update(',"composerId":');
  hash.update(canonicalJson(header.composerId));
  hash.update(',"header":');
  hash.update(canonicalJson(header));
  hash.update(',"schemaVersion":1}');
  return hash.digest("hex");
}

/**
 * Index-friendly bounds for every bubble row belonging to one composer.
 *
 * Cursor's keys use `bubbleId:<uuid>:<bubble>`. `:` and its immediate ASCII
 * successor `;` form an exact half-open prefix range under SQLite's default
 * BINARY collation. Unlike `LIKE ?`, this remains an index range when the
 * prefix is bound at runtime and avoids scanning the 1+ GiB cursorDiskKV
 * covering index on every poll.
 */
export function bubbleKeyRange(composerId: string): [string, string] {
  return [`bubbleId:${composerId}:`, `bubbleId:${composerId};`];
}

function currentBubbleCount(
  statement: ChatStatement,
  composerId: string,
): number {
  const total = plainNumber(
    (
      statement.get(...bubbleKeyRange(composerId)) as
        | { total?: SqliteRowValue }
        | undefined
    )?.total ?? 0,
  );
  return total ?? 0;
}

/**
 * Records a cheap future change signal only after exact semantic bytes were
 * proven equal to the projection. This upgrades legacy projections in place
 * without publishing hundreds of duplicate multi-megabyte chat snapshots.
 */
function rememberObservedChatSource(
  projection: LocalProjection,
  lastUpdatedAt: number | null,
  bubbleCount: number,
): void {
  if (lastUpdatedAt === null) {
    delete projection.sourceTimestamp;
  } else {
    projection.sourceTimestamp = lastUpdatedAt;
  }
  projection.sourceBubbleCount = bubbleCount;
}

/**
 * O(1) change signal for the live SQLite file.
 *
 * Cursor uses WAL mode, so looking only at state.vscdb misses nearly every
 * running-session commit. Size plus nanosecond timestamps and file identity for
 * both files catches WAL append/reset/checkpoint and database replacement
 * without opening SQLite or reading the multi-gigabyte database. `-shm` is
 * deliberately absent: readers update it for lock coordination without
 * changing durable data, which would defeat the idle fast path.
 */
async function stateVscdbFingerprint(databasePath: string): Promise<string> {
  const [database, wal] = await Promise.all([
    fileFingerprint(databasePath, false, 100),
    fileFingerprint(`${databasePath}-wal`, true, 32),
  ]);
  return sha256(`${database}\n${wal}`);
}

async function fileFingerprint(
  path: string,
  optional: boolean,
  headerLength: number,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const before = await handle.stat({ bigint: true });
    const header = Buffer.allocUnsafe(headerLength);
    let bytesRead = 0;
    while (bytesRead < headerLength) {
      const result = await handle.read(
        header,
        bytesRead,
        headerLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    return [
      before.dev,
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
      before.birthtimeNs,
      after.size,
      after.mtimeNs,
      after.ctimeNs,
      sha256(header.subarray(0, bytesRead)),
    ].join(":");
  } catch (error) {
    if (optional && errorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

interface KnownChatFingerprints {
  combined: string;
  byResource: ReadonlyMap<string, string>;
}

/** A repository projection change can alter the correct local scan result. */
function knownChatsFingerprints(
  known: Record<string, LocalProjection>,
): KnownChatFingerprints {
  const chats = Object.values(known)
    .filter((projection) => projection.kind === "chat")
    .sort((left, right) =>
      left.resourceId < right.resourceId
        ? -1
        : left.resourceId > right.resourceId
          ? 1
          : 0,
    );
  return {
    combined: sha256(canonicalBytes(chats)),
    byResource: new Map(
      chats.map((projection) => [
        projection.resourceId,
        sha256(canonicalBytes(projection)),
      ]),
    ),
  };
}

function rawHeaderFingerprint(header: RawComposerHeader): string {
  return sha256(
    canonicalBytes(
      [
        header.composerId,
        header.workspaceId,
        header.createdAt,
        header.lastUpdatedAt,
        header.isArchived,
        header.isSubagent,
        header.recency,
        header.checkpointAt,
        header.value,
      ].map(sqliteFingerprintPart),
    ),
  );
}

function sqliteFingerprintPart(value: SqliteRowValue): string {
  if (value === null) {
    return "null";
  }
  if (value instanceof Uint8Array) {
    return `blob:${Buffer.from(value).toString("base64")}`;
  }
  if (typeof value === "bigint") {
    return `bigint:${value.toString()}`;
  }
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? "-0" : value.toString()}`;
  }
  return `text:${value}`;
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
 * Bounds the fallback audit for equal-timestamp/equal-count edits.
 *
 * Normal chat growth is selected immediately by its header or bubble count.
 * This round-robin exists only for the rare in-place edit that changes neither.
 * Sixteen real conversations could allocate hundreds of MiB and monopolize an
 * extension-host core for most of a 30-second poll; four retains eventual full
 * coverage while keeping each burst small enough for interactive Cursor use.
 */
const DEEP_VERIFICATION_BATCH_SIZE = 4;

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

/**
 * Says which conversations this computer stopped publishing because they shrank.
 *
 * Not a warning: nothing is broken and there is nothing to fix. It is the
 * record of this device declining to make its own pruning everyone's, and the
 * counts are what make a slow local erosion visible before the repository is
 * the only copy left.
 */
function prunedChatsNotice(entries: readonly string[]): string {
  const sample = entries.slice(0, BODYLESS_SAMPLE_SIZE).join(", ");
  const remainder = entries.length - Math.min(entries.length, BODYLESS_SAMPLE_SIZE);
  return `Held back ${entries.length} chat(s) that lost messages on this computer: ${sample}${
    remainder === 0 ? "" : ` and ${remainder} more`
  }. Cursor prunes conversation bodies per computer and messages are never deleted individually, so the fuller copy already in the shared folder is kept instead of being overwritten with this one.`;
}

function findChatDeletions(
  known: Record<string, LocalProjection>,
  current: Set<string>,
): ResourceDeletion[] {
  return Object.values(known)
    .filter(
      (projection) =>
        projection.kind === "chat" &&
        !current.has(projection.resourceId) &&
        // The repository projection can already be the deterministic
        // tombstone produced by an earlier scan. Re-emitting that no-op on
        // every poll prevented the adapter from ever becoming settled.
        projection.semanticHash !== chatDeletionHash(projection.resourceId),
    )
    .map((projection) => {
      const composerId = projection.resourceId.slice("chat/".length);
      return {
        resourceId: projection.resourceId,
        kind: "chat",
        semanticHash: chatDeletionHash(projection.resourceId),
        metadata: {
          composerId,
          ...(projection.sourceTimestamp === undefined
            ? {}
            : { lastUpdatedAt: projection.sourceTimestamp }),
        },
      };
    });
}

function chatDeletionHash(resourceId: string): string {
  return sha256(`deleted:${resourceId}`);
}
