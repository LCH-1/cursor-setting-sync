import type { JsonValue } from "../types";

export type LegacyCheckpointMarkerKind =
  | "ordinary"
  | "automatic-chat-repair"
  | "agent-kv-enrichment"
  | "version-restore"
  | "ambiguous-special";

/**
 * Classifies the exact pre-provenance marker shape written by v0.0.59-v0.0.62:
 * the active metadata was spread verbatim and only `syncOrigin` was replaced.
 * Any presence of a new provenance field makes the marker current/partial,
 * never legacy, so stripping one field cannot downgrade into this exception.
 */
export function classifyLegacyCheckpointMarker(
  metadata: Record<string, JsonValue> | undefined,
): LegacyCheckpointMarkerKind | null {
  if (
    metadata?.syncOrigin !== "checkpoint-marker" ||
    [
      "checkpointedProducer",
      "checkpointedSyncOrigin",
      "checkpointedSourceDeviceId",
      "checkpointedVersionId",
    ].some((key) => Object.hasOwn(metadata, key))
  ) {
    return null;
  }
  if (
    ["repairOriginDeviceId", "repairFingerprint", "repairedBubbleCount"].some(
      (key) => Object.hasOwn(metadata, key),
    )
  ) {
    return "automatic-chat-repair";
  }
  const hasEnrichmentDiscriminator =
    Object.hasOwn(metadata, "enrichedFromVersionId") ||
    Object.hasOwn(metadata, "enrichedFromSemanticHash");
  if (hasEnrichmentDiscriminator) {
    return isUnambiguousLegacyEnrichment(metadata)
      ? "agent-kv-enrichment"
      : "ambiguous-special";
  }
  if (Object.hasOwn(metadata, "originalProducer")) {
    return isEventProducerMetadata(metadata.originalProducer)
      ? "version-restore"
      : "ambiguous-special";
  }
  return "ordinary";
}

function isUnambiguousLegacyEnrichment(
  metadata: Record<string, JsonValue>,
): boolean {
  return (
    isEventProducerMetadata(metadata.originalProducer) &&
    typeof metadata.enrichedFromVersionId === "string" &&
    /^[a-f0-9]{64}#\d+$/.test(metadata.enrichedFromVersionId) &&
    typeof metadata.enrichedFromSemanticHash === "string" &&
    /^[a-f0-9]{64}$/.test(metadata.enrichedFromSemanticHash) &&
    metadata.chatSnapshotSchemaVersion === 2 &&
    isNonNegativeSafeInteger(metadata.agentKvBlobCount) &&
    isNonNegativeSafeInteger(metadata.agentKvReferencedCount) &&
    isNonNegativeSafeInteger(metadata.agentKvMissingCount) &&
    typeof metadata.chatCoreHash === "string" &&
    /^[a-f0-9]{64}$/.test(metadata.chatCoreHash)
  );
}

function isEventProducerMetadata(value: JsonValue | undefined): boolean {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  return (
    typeof value.extensionVersion === "string" &&
    typeof value.cursorVersion === "string" &&
    typeof value.vscodeVersion === "string"
  );
}

function isNonNegativeSafeInteger(value: JsonValue | undefined): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}
