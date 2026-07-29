import { randomUUID } from "node:crypto";
import type {
  CheckpointManifest,
  LocalProjection,
  LocalSyncState,
  ResourceTip,
  SyncConflict,
} from "../types";
import { isSupportedResourceKind } from "../types";
import { compareCodeUnits } from "./canonical";
import type { DecryptedEvent } from "./repository";

export interface ReconcileResult {
  projections: ResourceProjection[];
  conflicts: SyncConflict[];
  warnings: string[];
  acceptedEventHashes: string[];
}

const RESOLVED_CONFLICT_RETENTION_DAYS = 30;
const MAX_RETAINED_RESOLVED_CONFLICTS = 200;

export function parentsForLocalChange(
  projection: LocalProjection | undefined,
  tips: ResourceTip[],
): string[] {
  if (
    projection !== undefined &&
    tips.length > 1 &&
    tips.every(
      (tip) =>
        tip.semanticHash === projection.semanticHash &&
        tip.operation === tips[0]?.operation,
    )
  ) {
    return tips.map((tip) => tip.versionId).sort();
  }
  return projection?.versionId === null || projection === undefined
    ? []
    : [projection.versionId];
}

export interface ResourceProjection {
  resourceId: string;
  tip: ResourceTip;
  changed: boolean;
}

interface VersionNode {
  tip: ResourceTip;
  parents: string[];
}

export class EventReconciler {
  reconcile(
    events: DecryptedEvent[],
    state: LocalSyncState,
    checkpoint: CheckpointManifest | null,
  ): ReconcileResult {
    const { accepted, warnings } = acceptContiguousStreams(
      events,
      state,
      checkpoint,
    );
    const resources = buildResourceGraphs(accepted, checkpoint);
    const projections: ResourceProjection[] = [];
    const conflicts: SyncConflict[] = [];
    const nextTips: Record<string, ResourceTip[]> = {};

    for (const [resourceId, graph] of resources) {
      const tips = calculateTips(graph);
      nextTips[resourceId] = tips;
      const equivalent = tips.every(
        (tip) =>
          tip.operation === tips[0]?.operation &&
          tip.semanticHash === tips[0]?.semanticHash,
      );
      if (tips.length > 1 && !equivalent) {
        conflicts.push(
          existingOrNewConflict(state.conflicts, resourceId, tips, graph),
        );
        continue;
      }
      const active = chooseActiveTip(tips);
      if (active === undefined) {
        continue;
      }
      const current = state.projections[resourceId];
      projections.push({
        resourceId,
        tip: active,
        changed:
          current?.versionId !== active.versionId ||
          current.semanticHash !== active.semanticHash,
      });
    }

    state.tips = nextTips;
    state.conflicts = mergeConflictHistory(state.conflicts, conflicts);
    // A loop, not Math.max(...spread): the spread passes one argument per
    // accepted event, and the since-checkpoint backlog is unbounded while a
    // conflict blocks checkpointing - past ~100k events it overflows the
    // argument stack and every cycle dies with RangeError.
    for (const event of accepted) {
      if (event.manifest.lamport > state.lamport) {
        state.lamport = event.manifest.lamport;
      }
    }
    const acceptedEventHashes = accepted.map((event) => event.eventHash);
    for (const event of accepted) {
      state.streams[event.stored.header.deviceId] = {
        lastSequence: event.stored.header.sequence,
        lastEventHash: event.eventHash,
      };
    }

    return { projections, conflicts, warnings, acceptedEventHashes };
  }
}

function acceptContiguousStreams(
  events: DecryptedEvent[],
  state: LocalSyncState,
  checkpoint: CheckpointManifest | null,
): {
  accepted: DecryptedEvent[];
  warnings: string[];
} {
  const byDevice = new Map<string, DecryptedEvent[]>();
  for (const event of events) {
    const deviceId = event.stored.header.deviceId;
    const checkpointCursor = checkpoint?.streams[deviceId];
    if (
      checkpointCursor !== undefined &&
      event.stored.header.sequence <= checkpointCursor.lastSequence
    ) {
      continue;
    }
    const retiredCursor = state.retiredDevices.includes(deviceId)
      ? state.streams[deviceId]
      : undefined;
    if (
      state.retiredDevices.includes(deviceId) &&
      (retiredCursor === undefined ||
        event.stored.header.sequence > retiredCursor.lastSequence)
    ) {
      continue;
    }
    const deviceEvents = byDevice.get(deviceId) ?? [];
    deviceEvents.push(event);
    byDevice.set(deviceId, deviceEvents);
  }

  for (const [deviceId, cursor] of Object.entries(state.streams)) {
    validatePinnedStreamCursor(deviceId, cursor);
    if (!byDevice.has(deviceId)) {
      const checkpointCursor = checkpoint?.streams[deviceId];
      if (
        checkpointCursor !== undefined &&
        cursor.lastSequence <= checkpointCursor.lastSequence
      ) {
        continue;
      }
      throw streamRollbackError(
        deviceId,
        `previously accepted event ${cursor.lastSequence} is no longer visible`,
      );
    }
  }

  const accepted: DecryptedEvent[] = [];
  const warnings: string[] = [];
  for (const [deviceId, deviceEvents] of byDevice) {
    deviceEvents.sort(
      (left, right) =>
        left.stored.header.sequence - right.stored.header.sequence ||
        compareCodeUnits(left.eventHash, right.eventHash),
    );
    const pinned = state.streams[deviceId];
    const checkpointCursor = checkpoint?.streams[deviceId];
    let expectedSequence = (checkpointCursor?.lastSequence ?? 0) + 1;
    let previousHash: string | null = checkpointCursor?.lastEventHash ?? null;
    for (const event of deviceEvents) {
      const header = event.stored.header;
      if (header.sequence !== expectedSequence) {
        if (pinned !== undefined && expectedSequence <= pinned.lastSequence) {
          throw streamRollbackError(
            deviceId,
            `previously accepted event ${expectedSequence} is missing`,
          );
        }
        warnings.push(
          `Waiting for device ${deviceId} event ${expectedSequence}; received ${header.sequence}.`,
        );
        break;
      }
      if (header.previousEventHash !== previousHash) {
        if (pinned !== undefined && header.sequence <= pinned.lastSequence) {
          throw streamRollbackError(
            deviceId,
            `previously accepted chain changed at event ${header.sequence}`,
          );
        }
        warnings.push(`Device ${deviceId} event stream forked at ${header.sequence}.`);
        break;
      }
      if (
        pinned !== undefined &&
        header.sequence === pinned.lastSequence &&
        event.eventHash !== pinned.lastEventHash
      ) {
        throw streamRollbackError(
          deviceId,
          `previously accepted event ${header.sequence} has a different hash`,
        );
      }
      accepted.push(event);
      previousHash = event.eventHash;
      expectedSequence += 1;
    }
    if (
      pinned !== undefined &&
      expectedSequence - 1 < pinned.lastSequence
    ) {
      throw streamRollbackError(
        deviceId,
        `stream ended before previously accepted event ${pinned.lastSequence}`,
      );
    }
  }
  return { accepted, warnings };
}

function validatePinnedStreamCursor(
  deviceId: string,
  cursor: LocalSyncState["streams"][string],
): void {
  if (
    !Number.isSafeInteger(cursor.lastSequence) ||
    cursor.lastSequence < 1 ||
    typeof cursor.lastEventHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(cursor.lastEventHash)
  ) {
    throw new Error(`Local stream cursor is invalid for device ${deviceId}.`);
  }
}

function streamRollbackError(deviceId: string, detail: string): Error {
  return new Error(
    `Repository stream rollback detected for device ${deviceId}: ${detail}. ` +
      "Wait for the shared-folder provider to restore the missing immutable events before synchronizing.",
  );
}

function buildResourceGraphs(
  events: DecryptedEvent[],
  checkpoint: CheckpointManifest | null,
): Map<string, Map<string, VersionNode>> {
  const resources = new Map<string, Map<string, VersionNode>>();
  for (const folded of checkpoint?.resources ?? []) {
    if (!isSupportedResourceKind(folded.kind)) {
      continue;
    }
    const separator = folded.versionId.lastIndexOf("#");
    const tip: ResourceTip = {
      versionId: folded.versionId,
      eventHash: folded.versionId.slice(0, separator),
      changeIndex: Number(folded.versionId.slice(separator + 1)),
      kind: folded.kind,
      lamport: folded.lamport,
      deviceId: folded.deviceId,
      operation: folded.operation,
      semanticHash: folded.semanticHash,
      parents: [],
    };
    if (folded.producer !== undefined) {
      tip.producer = folded.producer;
    }
    if (folded.payload !== undefined) {
      tip.payload = folded.payload;
    }
    if (folded.metadata !== undefined) {
      tip.metadata = folded.metadata;
    }
    const graph =
      resources.get(folded.resourceId) ?? new Map<string, VersionNode>();
    graph.set(folded.versionId, { tip, parents: [] });
    resources.set(folded.resourceId, graph);
  }
  for (const event of events) {
    event.manifest.changes.forEach((change, changeIndex) => {
      if (!isSupportedResourceKind(change.kind)) {
        return;
      }
      const versionId = `${event.eventHash}#${changeIndex}`;
      const tip: ResourceTip = {
        versionId,
        eventHash: event.eventHash,
        changeIndex,
        kind: change.kind,
        lamport: event.manifest.lamport,
        // Display only; the conflict resolver has nothing else to tell a person
        // when one side of a fork happened. Never used to order anything.
        createdAt: event.manifest.createdAt,
        deviceId: event.stored.header.deviceId,
        operation: change.operation,
        semanticHash: change.semanticHash,
        parents: change.parents,
      };
      if (event.manifest.producer !== undefined) {
        tip.producer = event.manifest.producer;
      }
      if (change.payload !== undefined) {
        tip.payload = change.payload;
      }
      if (change.metadata !== undefined) {
        tip.metadata = change.metadata;
      }
      const graph = resources.get(change.resourceId) ?? new Map<string, VersionNode>();
      graph.set(versionId, { tip, parents: change.parents });
      resources.set(change.resourceId, graph);
    });
  }
  return resources;
}

function calculateTips(graph: Map<string, VersionNode>): ResourceTip[] {
  const ancestors = new Set<string>();
  for (const node of graph.values()) {
    for (const parent of node.parents) {
      markAncestors(parent, graph, ancestors);
    }
  }
  return [...graph.values()]
    .filter((node) => !ancestors.has(node.tip.versionId))
    .map((node) => node.tip)
    .sort(compareTips);
}

function markAncestors(
  versionId: string,
  graph: Map<string, VersionNode>,
  ancestors: Set<string>,
): void {
  // An explicit stack, not recursion: a version chain grows one link per
  // publish of the resource, so a chatty resource that has not been folded
  // into a checkpoint for weeks reaches depths that overflow the call stack.
  const pending = [versionId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || ancestors.has(current)) {
      continue;
    }
    ancestors.add(current);
    const parent = graph.get(current);
    if (parent !== undefined) {
      pending.push(...parent.parents);
    }
  }
}

function chooseActiveTip(tips: ResourceTip[]): ResourceTip | undefined {
  if (tips.length === 0) {
    return undefined;
  }
  const updates = tips.filter((tip) => tip.operation === "put");
  const candidates = updates.length > 0 ? updates : tips;
  return [...candidates].sort(compareTips)[0];
}

/**
 * Deterministic total order over the tips of one resource, newest first. Every
 * device derives it from replicated event data alone, so a caller that needs a
 * tie-break both devices will agree on can sort with this and take the head.
 */
export function compareTips(left: ResourceTip, right: ResourceTip): number {
  if (left.lamport !== right.lamport) {
    return right.lamport - left.lamport;
  }
  // Code-unit order, never localeCompare: this comparator elects replicated
  // winners, and both machines must sort identically whatever their locales.
  const deviceOrder = compareCodeUnits(right.deviceId, left.deviceId);
  if (deviceOrder !== 0) {
    return deviceOrder;
  }
  return compareCodeUnits(right.eventHash, left.eventHash);
}

function existingOrNewConflict(
  existing: SyncConflict[],
  resourceId: string,
  tips: ResourceTip[],
  graph: Map<string, VersionNode>,
): SyncConflict {
  const tipVersionIds = tips.map((tip) => tip.versionId).sort();
  const match = existing.find(
    (conflict) =>
      conflict.resourceId === resourceId &&
      conflict.resolvedAt === undefined &&
      arraysEqual([...conflict.tipVersionIds].sort(), tipVersionIds),
  );
  if (match !== undefined) {
    // A base compacted away by a checkpoint resolves to neither an event nor
    // the folded checkpoint entry; the conflict degrades to manual resolution.
    if (match.baseVersionId !== null && !graph.has(match.baseVersionId)) {
      match.baseVersionId = null;
    }
    return match;
  }
  return {
    conflictId: randomUUID(),
    resourceId,
    kind: tips[0]?.kind ?? "settings",
    baseVersionId: findCommonParent(tips, graph),
    tipVersionIds,
    createdAt: new Date().toISOString(),
  };
}

function findCommonParent(
  tips: ResourceTip[],
  graph: Map<string, VersionNode>,
): string | null {
  const ancestorSets = tips.map((tip) => {
    const ancestors = new Set<string>();
    for (const parent of tip.parents) {
      markAncestors(parent, graph, ancestors);
    }
    return ancestors;
  });
  const [first, ...rest] = ancestorSets;
  if (first === undefined) {
    return null;
  }
  const common = [...first]
    .filter((versionId) => rest.every((ancestors) => ancestors.has(versionId)))
    .flatMap((versionId) => {
      const node = graph.get(versionId);
      return node === undefined ? [] : [node.tip];
    });
  // compareTips orders by descending Lamport, so the first common ancestor is
  // the lowest one and yields the most precise three-way merge base.
  return common.sort(compareTips)[0]?.versionId ?? null;
}

function mergeConflictHistory(
  existing: SyncConflict[],
  active: SyncConflict[],
): SyncConflict[] {
  const activeIds = new Set(active.map((conflict) => conflict.conflictId));
  const cutoff =
    Date.now() - RESOLVED_CONFLICT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const retainedResolvedIds = new Set(
    existing
      .filter(
        (conflict) =>
          conflict.resolvedAt !== undefined &&
          Date.parse(conflict.resolvedAt) >= cutoff,
      )
      .sort((left, right) =>
        (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? ""),
      )
      .slice(0, MAX_RETAINED_RESOLVED_CONFLICTS)
      .map((conflict) => conflict.conflictId),
  );
  return [
    ...existing.filter((conflict) =>
      conflict.resolvedAt === undefined
        ? activeIds.has(conflict.conflictId)
        : retainedResolvedIds.has(conflict.conflictId),
    ),
    ...active.filter(
      (conflict) =>
        !existing.some((candidate) => candidate.conflictId === conflict.conflictId),
    ),
  ];
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
