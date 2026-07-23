import type {
  CheckpointManifest,
  EventProducer,
  JsonValue,
  LocalProjection,
  ResourceSnapshot,
  ResourceTip,
} from "../types";
import type { SyncRepository } from "../protocol/repository";

export function shouldPublishSnapshot(
  projection: LocalProjection | undefined,
  snapshot: ResourceSnapshot,
  tips: ResourceTip[],
): boolean {
  if (
    projection !== undefined &&
    ["chat", "chat-transcript", "chat-store", "workspace-storage"].includes(
      projection.kind,
    ) &&
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

export function isSyntheticTip(tip: ResourceTip): boolean {
  return (
    tip.metadata?.syncOrigin === "conflict-resolution" ||
    tip.metadata?.syncOrigin === "auto-merge" ||
    tip.metadata?.syncOrigin === "version-restore"
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
