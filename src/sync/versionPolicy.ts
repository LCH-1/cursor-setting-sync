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
import { classifyLegacyCheckpointMarker } from "../protocol/checkpointMarker";
import { MAX_EVENT_CHANGES } from "../constants";
import { PUBLISH_WARNING_SOURCE } from "./warningLog";
import { assertSafeIdentifier } from "../platform/files";

export function shouldPublishSnapshot(
  projection: LocalProjection | undefined,
  snapshot: ResourceSnapshot,
  tips: ResourceTip[],
): boolean {
  if (snapshot.metadata?.syncOrigin === "agent-kv-recapture") {
    // A helper-applied legacy/incomplete automatic repair can have byte-for-
    // byte the same core and graph envelope as its repair tip. Reassert it
    // once as an ordinary local capture so later DB generations can use the
    // normal enrichment pipeline. A prior ordinary reassert with these exact
    // bytes is already the acknowledgement and must not be duplicated.
    return !tips.some(
      (tip) =>
        tip.operation === "put" &&
        tip.semanticHash === snapshot.semanticHash &&
        effectiveSyncOrigin(tip.metadata) !== "automatic-chat-repair",
    );
  }
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
    tip.metadata?.syncOrigin === "agent-kv-enrichment" ||
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
  const checkpointMarker = metadata?.syncOrigin === "checkpoint-marker";
  if (checkpointMarker) {
    const checkpointed = parseEventProducer(metadata.checkpointedProducer);
    if (checkpointed !== undefined && producer !== undefined) {
      return {
        extensionVersion: producer.extensionVersion,
        cursorVersion: checkpointed.cursorVersion,
        vscodeVersion: checkpointed.vscodeVersion,
      };
    }
    const legacyKind = classifyLegacyCheckpointMarker(metadata);
    if (legacyKind === "ordinary") {
      // v0.0.59's marker manifest is the only authenticated compatibility
      // datum left for an ordinary database tip. Grandfather that exact shape;
      // partial new provenance and every legacy special recipe stay closed.
      return producer;
    }
    if (
      legacyKind === "automatic-chat-repair" ||
      legacyKind === "ambiguous-special"
    ) {
      return undefined;
    }
  }
  const effectiveOrigin = effectiveSyncOrigin(metadata);
  if (effectiveOrigin === "agent-kv-enrichment") {
    const original = parseEventProducer(metadata?.originalProducer);
    if (original === undefined || producer === undefined) {
      // The enriched payload is schema v2, so an absent enrichment-event
      // producer must fail closed rather than masquerade as its legacy source.
      return undefined;
    }
    return {
      // The extension version gates the NEW v2 envelope. Cursor/VS Code gate
      // the unchanged database core copied from the source tip. Taking all
      // three fields from either producer would respectively let an old build
      // parse v2, or launder a newer Cursor database core through this device.
      extensionVersion: producer.extensionVersion,
      cursorVersion: original.cursorVersion,
      vscodeVersion: original.vscodeVersion,
    };
  }
  // A version-restore republishes old content under the restoring device's
  // producer; the database version gate must keep judging the ORIGINAL
  // producer so a restore cannot launder a newer-version change.
  if (effectiveOrigin === "version-restore") {
    const original = parseEventProducer(metadata?.originalProducer);
    if (original !== undefined) {
      return checkpointMarker
        ? producer === undefined
          ? undefined
          : {
              extensionVersion: producer.extensionVersion,
              cursorVersion: original.cursorVersion,
              vscodeVersion: original.vscodeVersion,
            }
        : original;
    }
  }
  // Old enrichment/restore markers can still prove their core producer through
  // `originalProducer` in the branches above. An ordinary or automatic-repair
  // marker without checkpointed producer provenance must not inherit the
  // checkpointing machine's older Cursor version and bypass the DB gate.
  if (checkpointMarker) {
    return undefined;
  }
  return producer;
}

/**
 * The semantic recipe a synthetic payload must use when it is applied.
 * Checkpoint pruning re-asserts repository bytes under `checkpoint-marker`,
 * but that transport marker must not erase blob-only enrichment or additive
 * automatic-repair semantics and turn them into an ordinary core overwrite.
 */
export function effectiveSyncOrigin(
  metadata: Record<string, JsonValue> | undefined,
): string | undefined {
  const direct = metadata?.syncOrigin;
  if (typeof direct !== "string") {
    return undefined;
  }
  if (direct !== "checkpoint-marker") {
    return direct;
  }
  if (typeof metadata?.checkpointedSyncOrigin === "string") {
    return metadata.checkpointedSyncOrigin;
  }
  const legacyKind = classifyLegacyCheckpointMarker(metadata);
  return legacyKind === "automatic-chat-repair" ||
    legacyKind === "agent-kv-enrichment" ||
    legacyKind === "version-restore"
    ? legacyKind
    : direct;
}

/**
 * Source device whose authenticated content a helper recipe is allowed to
 * act for. A checkpoint event's own device only reasserted repository bytes;
 * the marker metadata carries the original source across marker generations.
 */
export function effectiveSourceDeviceId(
  metadata: Record<string, JsonValue> | undefined,
  directSourceDeviceId: string | undefined,
): string | undefined {
  const candidate =
    metadata?.syncOrigin === "checkpoint-marker"
      ? metadata.checkpointedSourceDeviceId
      : directSourceDeviceId;
  if (typeof candidate !== "string") {
    return undefined;
  }
  try {
    return assertSafeIdentifier(candidate, "repair source device ID");
  } catch {
    return undefined;
  }
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
