import { createHash } from "node:crypto";
import { readPortableChatSnapshotBounded } from "../chat/repair";
import { parsePortableChatSnapshot, portableChatCoreHash } from "../chat/stateVscdb";
import { updatePortableComposerHeaderHash } from "../chat/headerCanonical";
import { openDatabase, type DatabaseSync } from "../platform/sqlite";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import type { SyncRepository } from "../protocol/repository";
import { acknowledgePublishedLocalChats, effectiveSyncOrigin } from "../sync/versionPolicy";
import type { ResourceChange, ResourceSnapshot } from "../types";
import type { HelperRequest } from "./types";

const MAX_LIVE_VERIFICATION_BYTES = 128 * 1024 * 1024;
const MAX_LIVE_CORE_BYTES = 128 * 1024 * 1024;
export const MAX_LIVE_VERIFICATION_CHANGES = 8;

export function isLiveVerificationCandidate(change: Pick<ResourceChange, "kind" | "operation" | "metadata">): boolean {
  return change.kind === "chat" && change.operation === "put" &&
    (change.metadata?.chatSnapshotSchemaVersion === 1 ||
      effectiveSyncOrigin(change.metadata) === "agent-kv-enrichment");
}

/** The caller owns the synchronization lock. Cursor's database is never written. */
export async function verifyLiveQueuedChats(
  request: HelperRequest,
  repository: SyncRepository,
  heartbeat: () => void = () => {},
): Promise<string[]> {
  if (!request.syncOptions.syncChat) return [];
  const verified: string[] = [];
  let workBytes = 0;
  for (const requested of request.changes.slice(0, MAX_LIVE_VERIFICATION_CHANGES)) {
    heartbeat();
    const versionId = `${requested.eventHash}#${requested.changeIndex}`;
    const tips = repository.state.tips[requested.resourceId] ?? [];
    if (tips.length !== 1 || tips[0]?.versionId !== versionId ||
        !repository.state.pendingDatabaseChanges.some(pending => pending.resourceId === requested.resourceId &&
          `${pending.eventHash}#${pending.changeIndex}` === versionId)) continue;
    try {
      const { change } = await repository.readVersionMetadata(versionId);
      if (change.resourceId !== requested.resourceId || !isLiveVerificationCandidate(change) ||
          change.payload === undefined || change.payload.plainBytes > request.syncOptions.maxPayloadBytes) continue;
      workBytes += change.payload.plainBytes;
      if (workBytes > MAX_LIVE_VERIFICATION_BYTES) break;
      const enrichment = effectiveSyncOrigin(change.metadata) === "agent-kv-enrichment";
      const previous = repository.state.projections[change.resourceId];
      if (previous?.requiresAgentKvRecapture === true) continue;
      let authenticatedBaseline = false;
      if (!enrichment && previous?.versionId && previous.semanticHash === change.semanticHash) {
        const baseline = (await repository.readVersionMetadata(previous.versionId)).change;
        authenticatedBaseline = baseline.resourceId === change.resourceId && baseline.kind === "chat" &&
          baseline.operation === "put" && baseline.semanticHash === change.semanticHash;
      }
      let incoming = null;
      if (enrichment) {
        const version = await repository.readVersion(versionId);
        if (version.content === null || sha256(version.content) !== change.semanticHash) continue;
        incoming = parsePortableChatSnapshot(version.content);
        if (incoming.schemaVersion !== 2 || `chat/${incoming.composerId}` !== change.resourceId) continue;
      }
      const database = openDatabase(request.paths.globalDatabase, { readOnly: true });
      let localChange: ResourceSnapshot | null = null;
      try {
        database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN");
        const current = readPortableChatSnapshotBounded(database, change.resourceId.slice(5), Math.min(MAX_LIVE_CORE_BYTES, request.syncOptions.maxPayloadBytes));
        if (current.status !== "known") continue;
        const coreHash = portableChatCoreHash(current.snapshot);
        const content = canonicalBytes(current.snapshot);
        workBytes += Math.max(0, content.byteLength - change.payload.plainBytes);
        if (workBytes > MAX_LIVE_VERIFICATION_BYTES) continue;
        if (incoming !== null) {
          if (coreHash !== portableChatCoreHash(incoming) || incoming.schemaVersion !== 2 ||
              !incoming.agentKv.blobs.every(blob => existingBlobMatches(database, blob.key, heartbeat))) continue;
        } else if (sha256(content) !== change.semanticHash || content.byteLength !== change.payload.plainBytes) {
          if (!authenticatedBaseline || typeof previous?.sourceBubbleCount !== "number" ||
              typeof change.metadata?.bubbleCount !== "number" ||
              current.snapshot.bubbles.length < Math.max(previous.sourceBubbleCount, change.metadata.bubbleCount)) continue;
          // Both authenticated versions describe the same starting bytes. A
          // fresh local edit can safely descend from both without replacing
          // any Cursor rows or discarding a different incoming conversation.
          localChange = {
            resourceId: change.resourceId, kind: "chat", content, semanticHash: sha256(content),
            parents: [...new Set([versionId, previous.versionId!])].sort(),
            metadata: {
              composerId: current.snapshot.composerId,
              workspaceId: current.snapshot.header.workspaceId,
              workspaceUri: change.metadata?.workspaceId === current.snapshot.header.workspaceId
                ? change.metadata?.workspaceUri ?? null : null,
              lastUpdatedAt: current.snapshot.header.lastUpdatedAt,
              bubbleCount: current.snapshot.bubbles.length,
              chatSnapshotSchemaVersion: 1, chatCoreHash: coreHash,
            },
          };
        }
        if (localChange === null) {
          const headerHash = createHash("sha256");
          updatePortableComposerHeaderHash(headerHash, current.snapshot.header);
          repository.state.projections[change.resourceId] = {
            resourceId: change.resourceId, kind: "chat", versionId, semanticHash: change.semanticHash,
            payloadObjectId: change.payload.objectId,
            sourceChatCoreHash: coreHash, sourceBubbleCount: current.snapshot.bubbles.length,
            sourceHeaderFingerprint: headerHash.digest("hex"),
            ...(current.snapshot.header.lastUpdatedAt === null ? {} : { sourceTimestamp: current.snapshot.header.lastUpdatedAt }),
            ...(enrichment ? { retainedLocalHash: sha256(content) } : {}),
          };
        }
      } finally {
        database.close();
      }
      if (localChange !== null) {
        const publication = await repository.publish([localChange], []);
        if (publication.eventHash === null) continue;
        await acknowledgePublishedLocalChats(repository, publication.eventHash, [localChange]);
      }
      repository.state.pendingDatabaseChanges = repository.state.pendingDatabaseChanges.filter(pending =>
        pending.resourceId !== change.resourceId || `${pending.eventHash}#${pending.changeIndex}` !== versionId);
      verified.push(change.resourceId);
    } catch {
      // Unavailable payloads, busy databases and failed authentication remain queued.
    }
  }
  if (verified.length > 0) await repository.saveState();
  return verified;
}

function existingBlobMatches(database: DatabaseSync, key: string, heartbeat: () => void): boolean {
  if (!/^agentKv:blob:[0-9a-f]{64}$/.test(key)) return false;
  const metadata = database.prepare("SELECT typeof(value) AS type, length(CAST(value AS BLOB)) AS bytes FROM cursorDiskKV WHERE key=?").get(key);
  if (metadata === undefined || (metadata.type !== "text" && metadata.type !== "blob") ||
      typeof metadata.bytes !== "number" || metadata.bytes > MAX_LIVE_VERIFICATION_BYTES) return false;
  const hash = createHash("sha256");
  const chunk = database.prepare("SELECT substr(CAST(value AS BLOB), ?, ?) AS value FROM cursorDiskKV WHERE key=?");
  for (let offset = 0; offset < metadata.bytes; offset += 1024 * 1024) {
    heartbeat();
    const row = chunk.get(offset + 1, 1024 * 1024, key);
    if (!(row?.value instanceof Uint8Array)) return false;
    hash.update(row.value);
  }
  return hash.digest("hex") === key.slice("agentKv:blob:".length);
}
