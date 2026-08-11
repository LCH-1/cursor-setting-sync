import { sha256 } from "../protocol/canonical";
import type { OversizedSnapshotSettlement } from "../resources/resource";

/**
 * Hard extension-host work envelope for auxiliary chat artifacts.
 *
 * These resources are useful recovery material, but unlike the primary chat
 * database they used to be read wholesale on every live chat poll.  A raised
 * repository payload policy must not turn one poll into a 512 MiB allocation.
 */
export const CHAT_AUXILIARY_MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
export const CHAT_AUXILIARY_MAX_RETAINED_BYTES_PER_SCAN = 8 * 1024 * 1024;
export const CHAT_AUXILIARY_MAX_RESOURCES_PER_SCAN = 32;
export const CHAT_AUXILIARY_MAX_OVERSIZED_SETTLEMENTS = 64;

export interface AuxiliaryOversizedObservation
  extends OversizedSnapshotSettlement {
  identity: string;
  fixedWorkLimit: boolean;
}

interface RememberedAuxiliaryOversizedObservation {
  observation: AuxiliaryOversizedObservation;
  generation: number;
}

/**
 * Keeps standing oversized proofs bounded while a file-tree generation is
 * scanned over many polls.  An overflow deliberately makes the owning adapter
 * incomplete: exact IDs that did not fit cannot safely be replaced by an
 * incoming version.  A later complete generation prunes stale entries; the
 * following generation can then prove whether the live set fits again.
 */
export class BoundedAuxiliaryOversizedSettlements {
  private readonly observations = new Map<
    string,
    RememberedAuxiliaryOversizedObservation
  >();
  private generation = 0;
  private overflowCountValue = 0;

  constructor(
    private readonly maxEntries = CHAT_AUXILIARY_MAX_OVERSIZED_SETTLEMENTS,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("Auxiliary oversized settlement limit must be positive.");
    }
  }

  beginGeneration(): void {
    this.generation += 1;
    this.overflowCountValue = 0;
  }

  completeGeneration(): void {
    for (const [resourceId, remembered] of this.observations) {
      if (remembered.generation !== this.generation) {
        this.observations.delete(resourceId);
      }
    }
  }

  clear(): void {
    this.observations.clear();
    this.overflowCountValue = 0;
  }

  delete(resourceId: string): boolean {
    return this.observations.delete(resourceId);
  }

  get(resourceId: string): AuxiliaryOversizedObservation | undefined {
    const remembered = this.observations.get(resourceId);
    if (remembered === undefined) {
      return undefined;
    }
    remembered.generation = this.generation;
    return remembered.observation;
  }

  set(
    resourceId: string,
    observation: AuxiliaryOversizedObservation,
  ): boolean {
    const remembered = this.observations.get(resourceId);
    if (remembered !== undefined) {
      remembered.observation = observation;
      remembered.generation = this.generation;
      return true;
    }
    if (this.observations.size >= this.maxEntries) {
      this.overflowCountValue = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.overflowCountValue + 1,
      );
      return false;
    }
    this.observations.set(resourceId, {
      observation,
      generation: this.generation,
    });
    return true;
  }

  values(): AuxiliaryOversizedObservation[] {
    return [...this.observations.values()].map(
      (remembered) => remembered.observation,
    );
  }

  get overflowed(): boolean {
    return this.overflowCountValue > 0;
  }

  get overflowCount(): number {
    return this.overflowCountValue;
  }
}

export function auxiliaryResourceLimit(maxPayloadBytes: number): number {
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    throw new Error("Auxiliary chat payload limit must be a positive integer.");
  }
  return Math.min(maxPayloadBytes, CHAT_AUXILIARY_MAX_RESOURCE_BYTES);
}

export function auxiliaryOversizedObservation(
  resourceId: string,
  identity: string,
  byteLength: number,
  maxPayloadBytes: number,
): AuxiliaryOversizedObservation {
  const limit = auxiliaryResourceLimit(maxPayloadBytes);
  return {
    resourceId,
    // This is deliberately an observation hash, not a fabricated content
    // hash.  It is used only to keep the exact local resource protected while
    // its bytes are outside the automatic-capture work envelope.
    semanticHash: sha256(`oversized:${resourceId}:${identity}:${byteLength}`),
    byteLength,
    maxPayloadBytes: limit,
    identity,
    fixedWorkLimit: limit < maxPayloadBytes,
  };
}

export function auxiliaryOversizedWarning(
  label: string,
  observation: AuxiliaryOversizedObservation,
): string {
  const reason = observation.fixedWorkLimit
    ? `the fixed ${formatBytes(observation.maxPayloadBytes)} automatic-capture work limit`
    : `the configured ${formatBytes(observation.maxPayloadBytes)} payload limit`;
  return `${label} ${observation.resourceId} is ${formatBytes(
    observation.byteLength,
  )}, above ${reason}. It remains local and protected from incoming replacement; smaller chat resources continue synchronizing.`;
}

export function orderedAfterCursor<T>(
  values: readonly T[],
  cursor: string | null,
  key: (value: T) => string,
): T[] {
  if (values.length < 2 || cursor === null) {
    return [...values];
  }
  const index = values.findIndex((value) => key(value) === cursor);
  if (index < 0 || index + 1 >= values.length) {
    return [...values];
  }
  return [...values.slice(index + 1), ...values.slice(0, index + 1)];
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
