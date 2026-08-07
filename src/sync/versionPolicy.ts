import type {
  CheckpointManifest,
  EventProducer,
  JsonValue,
  LocalProjection,
  ResourceDeletion,
  ResourceSnapshot,
  ResourceTip,
} from "../types";
import type { SyncRepository } from "../protocol/repository";
import { MAX_EVENT_CHANGES } from "../constants";
import { PUBLISH_WARNING_SOURCE } from "./warningLog";

export function shouldPublishSnapshot(
  projection: LocalProjection | undefined,
  snapshot: ResourceSnapshot,
  tips: ResourceTip[],
): boolean {
  if (
    projection !== undefined &&
    [
      "chat",
      "chat-transcript",
      "chat-store",
      "workspace-storage",
      // profile and extension applies write a form that deliberately differs
      // from the published bytes (a union-merged manifest, the version this
      // machine's resolver actually installed); the recorded hash is that
      // written form, and republishing it echoed between machines forever.
      "profile",
      "extension",
    ].includes(projection.kind) &&
    projection.retainedLocalHash === snapshot.semanticHash
  ) {
    return false;
  }
  if (
    tips.some(
      (tip) =>
        tip.operation === "put" && tip.semanticHash === snapshot.semanticHash,
    )
  ) {
    return false;
  }
  return projection?.semanticHash !== snapshot.semanticHash;
}

/**
 * A tip this device wrote on someone else's behalf rather than by scanning its
 * own disk.
 *
 * Both callers hang off that distinction. `applyProjections` skips a tip
 * carrying this device's own deviceId, because re-applying its own scan is
 * pointless; and the publish step protects a synthetic tip from being
 * overwritten by the local scan before it has been applied. A synthetic tip
 * fails both assumptions: the content came out of the repository, so the local
 * disk does not hold it yet.
 *
 * `checkpoint-marker` belongs here for the same reason as the rest. Pruning
 * republishes one current tip so old builds meet a v2 event and fail loudly,
 * and it reads that content from the repository blob - which on a device that
 * has not applied the resource yet is purely the other device's work wearing
 * this device's identity. Left unmarked, the marker took the own-scan
 * short-circuit and the resource was recorded as applied without anything
 * being written; for the kinds that only the offline helper can apply, the
 * next scan then found a projection with no matching row and published a
 * tombstone over the other device's copy.
 */
export function isSyntheticTip(tip: ResourceTip): boolean {
  return (
    tip.metadata?.syncOrigin === "conflict-resolution" ||
    tip.metadata?.syncOrigin === "auto-merge" ||
    tip.metadata?.syncOrigin === "version-restore" ||
    tip.metadata?.syncOrigin === "automatic-chat-repair" ||
    tip.metadata?.syncOrigin === "checkpoint-marker"
  );
}

export function effectiveTipProducer(
  tip: ResourceTip,
): EventProducer | undefined {
  return effectiveVersionProducer(tip.metadata, tip.producer);
}

export function effectiveVersionProducer(
  metadata: Record<string, JsonValue> | undefined,
  producer: EventProducer | undefined,
): EventProducer | undefined {
  // A version-restore republishes old content under the restoring device's
  // producer; the database version gate must keep judging the ORIGINAL
  // producer so a restore cannot launder a newer-version change.
  if (metadata?.syncOrigin === "version-restore") {
    const original = parseEventProducer(metadata.originalProducer);
    if (original !== undefined) {
      return original;
    }
  }
  return producer;
}

export function parseEventProducer(
  value: JsonValue | undefined,
): EventProducer | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const { extensionVersion, cursorVersion, vscodeVersion } = value;
  if (
    typeof extensionVersion !== "string" ||
    typeof cursorVersion !== "string" ||
    typeof vscodeVersion !== "string"
  ) {
    return undefined;
  }
  return { extensionVersion, cursorVersion, vscodeVersion };
}

export function producerAsMetadata(producer: EventProducer): JsonValue {
  return {
    extensionVersion: producer.extensionVersion,
    cursorVersion: producer.cursorVersion,
    vscodeVersion: producer.vscodeVersion,
  };
}

export async function absorbedCheckpointManifest(
  repository: SyncRepository,
): Promise<CheckpointManifest | null> {
  return repository.loadAbsorbedCheckpointManifest();
}

/**
 * Splits the scan result into what can actually go into an event.
 *
 * `SyncRepository.publish` throws on the first snapshot over the configured
 * limit, and that throw used to abort the whole cycle: one 150 MiB workspace
 * database stopped settings, keybindings, extensions and every other resource
 * from publishing, on this cycle and on every cycle after it. An oversized
 * resource is now dropped from the batch with a warning that names it, its
 * size and the two things the user can do about it, and everything else
 * publishes. The hard throw stays in `publish` as a defensive invariant.
 *
 * `sourceOf` names the warning bucket each snapshot belongs to, so a warning
 * can be scoped to the adapter that owns the resource: only a cycle that
 * scanned that adapter is entitled to clear it.
 */
export function filterPublishableChanges(
  snapshots: readonly ResourceSnapshot[],
  deletions: readonly ResourceDeletion[],
  maxPayloadBytes: number,
  sourceOf: (snapshot: ResourceSnapshot) => string = () =>
    PUBLISH_WARNING_SOURCE,
): {
  snapshots: ResourceSnapshot[];
  deletions: ResourceDeletion[];
  warnings: string[];
  warningsBySource: Map<string, string[]>;
} {
  const warnings: string[] = [];
  const warningsBySource = new Map<string, string[]>();
  const publishable = snapshots.filter((snapshot) => {
    if (snapshot.content.byteLength <= maxPayloadBytes) {
      return true;
    }
    const warning = oversizedPayloadWarning(
      snapshot.resourceId,
      snapshot.content.byteLength,
      maxPayloadBytes,
    );
    warnings.push(warning);
    const source = sourceOf(snapshot);
    const bucket = warningsBySource.get(source);
    if (bucket === undefined) {
      warningsBySource.set(source, [warning]);
    } else {
      bucket.push(warning);
    }
    return false;
  });
  return {
    snapshots: publishable,
    deletions: [...deletions],
    warnings,
    warningsBySource,
  };
}

/**
 * Publishes in events of at most MAX_EVENT_CHANGES changes. A single batch
 * larger than that used to throw and take the cycle with it.
 *
 * Lives next to {@link filterPublishableChanges} because the two guards belong
 * together: every publisher — the sync cycle and the shutdown export alike —
 * has to drop what cannot fit in a payload and split what cannot fit in an
 * event. It also keeps both reachable from the helper bundle, which cannot
 * import the extension-host manager.
 *
 * Returns the hash of every event actually written; a caller that marks its own
 * projections has to recognise all of them, not just the last one.
 */
export async function publishInBatches(
  repository: SyncRepository,
  snapshots: readonly ResourceSnapshot[],
  deletions: readonly ResourceDeletion[],
): Promise<Set<string>> {
  const published = new Set<string>();
  const record = (eventHash: string | null): void => {
    if (eventHash !== null) {
      published.add(eventHash);
    }
  };
  let snapshotIndex = 0;
  let deletionIndex = 0;
  do {
    // Bounded by estimated manifest bytes as well as by count: publish hard-
    // fails past MAX_EVENT_FILE_BYTES, and ten thousand changes whose records
    // average a kilobyte reach it long before the count cap does. An item is
    // always admitted into an empty batch so an oversized single record still
    // reaches publish, whose own limit is the one that decides.
    const batchSnapshots: ResourceSnapshot[] = [];
    const batchDeletions: ResourceDeletion[] = [];
    let estimatedBytes = 0;
    const admit = (item: ResourceSnapshot | ResourceDeletion): boolean => {
      const cost = estimatedChangeRecordBytes(item);
      const count = batchSnapshots.length + batchDeletions.length;
      if (count > 0 && (count >= MAX_EVENT_CHANGES || estimatedBytes + cost > EVENT_MANIFEST_BYTE_BUDGET)) {
        return false;
      }
      estimatedBytes += cost;
      return true;
    };
    while (snapshotIndex < snapshots.length) {
      const item = snapshots[snapshotIndex];
      if (item === undefined || !admit(item)) {
        break;
      }
      batchSnapshots.push(item);
      snapshotIndex += 1;
    }
    while (deletionIndex < deletions.length) {
      const item = deletions[deletionIndex];
      if (item === undefined || !admit(item)) {
        break;
      }
      batchDeletions.push(item);
      deletionIndex += 1;
    }
    record((await repository.publish(batchSnapshots, batchDeletions)).eventHash);
  } while (snapshotIndex < snapshots.length || deletionIndex < deletions.length);
  return published;
}

/**
 * What one change contributes to the event manifest: the record - id, hashes,
 * parents, metadata - not the payload, which travels as a separate object.
 * The budget below leaves room for the ~4/3 base64 expansion the encrypted
 * envelope adds on top of these estimates.
 */
function estimatedChangeRecordBytes(
  item: ResourceSnapshot | ResourceDeletion,
): number {
  return (
    item.resourceId.length +
    (item.parents?.reduce((total, parent) => total + parent.length + 4, 0) ?? 0) +
    (item.metadata === undefined ? 0 : JSON.stringify(item.metadata).length) +
    256
  );
}

const EVENT_MANIFEST_BYTE_BUDGET = 4 * 1024 * 1024;

/** The one wording used wherever a payload is refused for being too large. */
export function oversizedPayloadWarning(
  resourceId: string,
  byteLength: number,
  maxPayloadBytes: number,
): string {
  return (
    `${resourceId} is ${formatBytes(byteLength)}, ` +
    `above the ${formatBytes(maxPayloadBytes)} limit, so it was not published. ` +
    'Raise "cursorSettingSync.maxPayloadMiB" to cover it, or exclude the resource ' +
    '("cursorSettingSync.ignoredUserFiles", "cursorSettingSync.syncChat" or ' +
    '"cursorSettingSync.syncWorkspaceStorage" depending on its kind). ' +
    "Everything else in this cycle still synchronized."
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
