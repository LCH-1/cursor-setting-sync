import type {
  LocalProjection,
  ResourceDeletion,
  ResourceKind,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";

export type ResourceApplyInput = ResourceSnapshot | ResourceDeletion;

export interface RetainedLocalApplyResult {
  status: "retained-local";
  semanticHash: string;
}

export type ResourceApplyResult = void | RetainedLocalApplyResult;

/** Lightweight proof that an exact local snapshot remains over one policy. */
export interface OversizedSnapshotSettlement {
  resourceId: string;
  semanticHash: string;
  byteLength: number;
  maxPayloadBytes: number;
  /** Optional adapter-specific guidance for a fixed interactive work bound. */
  warning?: string;
}

/** Bounded continuation state for one-shot scanners such as the helper. */
export interface ResourceScanStatus {
  complete: boolean;
  deferredResourceIds: readonly string[];
  /**
   * Monotonic evidence that a resumable discovery/ack cursor advanced. A
   * helper may keep draining while this changes; retrying the same failed
   * descriptor must leave it unchanged.
   */
  progressToken?: number;
}

export interface ResourceAdapter {
  readonly id: string;
  readonly kinds: readonly ResourceKind[];
  readonly appliesWhileRunning: boolean;
  readonly scanWhileRunning?: boolean;

  /** Optional policy hook for adapters that settle exact oversized snapshots. */
  setMaxPayloadBytes?(maxPayloadBytes: number): void;
  /** Acknowledges that the manager deliberately filtered this exact snapshot. */
  settleOversizedSnapshot?(
    snapshot: ResourceSnapshot,
    maxPayloadBytes: number,
  ): boolean;
  /** Standing lightweight observations; never retain the oversized content. */
  oversizedSnapshotSettlements?(
    maxPayloadBytes: number,
  ): readonly OversizedSnapshotSettlement[];
  /** Reports body work that a bounded scan deliberately deferred. */
  scanStatus?(): ResourceScanStatus;
  /** Releases process-local resources such as resumable native directory cursors. */
  dispose?(): void | Promise<void>;

  scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult>;
  apply(input: ResourceApplyInput): Promise<ResourceApplyResult>;
}

/**
 * Retires a whole adapter generation without letting one failed cleanup skip
 * the remaining adapters. Each adapter is invoked at most once per call.
 */
export async function disposeResourceAdapters(
  adapters: readonly ResourceAdapter[],
): Promise<void> {
  const results = await Promise.allSettled(
    adapters.map((adapter) => Promise.resolve().then(() => adapter.dispose?.())),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed !== undefined) {
    throw failed.reason;
  }
}

export function isDeletion(input: ResourceApplyInput): input is ResourceDeletion {
  return !("content" in input);
}
