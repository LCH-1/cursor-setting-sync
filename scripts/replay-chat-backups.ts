import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { prepareChatConflictResolution } from "../src/chat/conflictResolution";
import { enrichCurrentChatTipsFromLiveDatabase } from "../src/chat/enrichment";
import type { ResourceVersionMetadata } from "../src/protocol/repository";
import type { ResourceSnapshot, SyncConflict } from "../src/types";
import { DatabaseSync } from "node:sqlite";
import { StateVscdbChatAdapter, parsePortableChatSnapshot, portableChatCoreHash, type PortableChatSnapshot, type PortableKvRow } from "../src/chat/stateVscdb";
import { verifyPortableChatContinuationClosure } from "../src/chat/continuationClosure";
import { applyGlobalDatabaseChanges, type GlobalDatabaseApplySession } from "../src/helper/database";
import { markAppliedProjections, prepareChanges } from "../src/helper/main";
import type { HelperChange, HelperRequest } from "../src/helper/types";
import type { CursorPaths } from "../src/platform/paths";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import type { SyncRepository } from "../src/protocol/repository";
import { chatContinuationApplyBlockReason } from "../src/sync/chatContinuationPolicy";
import { effectiveTipProducer } from "../src/sync/versionPolicy";
import { helperAcceptsChatProducer } from "../src/helper/chatMigration";
import { compareVersions } from "../src/platform/compatibility";
import packageMetadata from "../package.json";
import type { EventProducer, JsonValue, LocalProjection, ResourceTip } from "../src/types";

let auditRoot = "";
let destinationRoot = "";
const limit = 128 * 1024 * 1024;
interface Resolution { resourceId: string; metadata: Record<string, JsonValue>; semanticHash: string; [key: string]: unknown }
interface Proof { hash: string; valueType: string; resourceId: string; kind: "bubble" | "blob" }
interface Fixture { conflicts: SyncConflict[]; tips: Record<string, ResourceTip[]>; versions: Record<string, ResourceVersionMetadata | null>; payloads: string[] }
const report: Record<string, unknown> = { capturedAt: new Date().toISOString(),
  scope: "Exported backup payloads replayed into isolated SQLite databases; source databases and remote hardware are not accessed", devices: [] };
let producer: EventProducer = { extensionVersion: packageMetadata.version, cursorVersion: "0.0.0", vscodeVersion: "0.0.0" };

export async function replayChatBackups(fixtureRoot: string, outputRoot?: string) {
  auditRoot = resolve(fixtureRoot);
  destinationRoot = join(resolve(outputRoot ?? auditRoot), `chat-replay-${randomUUID()}`);
  const fixture = JSON.parse(await readFile(join(auditRoot, "fixture.json"), "utf8")) as Fixture;
  validateFixture(fixture);
  for (const tip of Object.values(fixture.tips).flat()) {
    const source = effectiveTipProducer(tip);
    if (source === undefined) continue;
    for (const key of ["cursorVersion", "vscodeVersion"] as const) {
      if (compareVersions(source[key], producer[key]) === 1) producer[key] = source[key];
    }
  }
  report.simulatedProducer = producer;
  await mkdir(join(destinationRoot, "outputs"), { recursive: true });
  const devices = [...new Set(Object.values(fixture.tips).flatMap(tips => tips.map(tip => tip.deviceId)))]
    .sort().slice(0, 2).map((deviceId, index) => ({ label: `replay-${index + 1}`, deviceId }));
  if (devices.length === 1) devices.push({ label: "replay-2", deviceId: devices[0]!.deviceId });
  if (devices.length !== 2) throw new Error("The fixture must contain at least one source device.");
  const resolutions = await resolveFixture(fixture);
  const runRoot = join(destinationRoot, "databases");
  await mkdir(runRoot, { recursive: true });
  for (let deviceIndex = 0; deviceIndex < devices.length; deviceIndex++) {
    const device = devices[deviceIndex]!;
    const root = join(runRoot, device.label);
    await mkdir(root);
    const paths = pathsFor(root);
    await mkdir(paths.extensionStorage);
    const database = new DatabaseSync(paths.globalDatabase);
    database.exec(`CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      CREATE TABLE cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,createdAt INTEGER,
        lastUpdatedAt INTEGER,isArchived INTEGER,isSubagent INTEGER,recency INTEGER,checkpointAt INTEGER,value TEXT);`);
    database.exec("BEGIN");
    const proof = new Map<string, Proof>();
    const projections: Record<string, LocalProjection> = {};
    const selected: unknown[] = [];
    for (const [resourceId, tips] of Object.entries(fixture.tips)) {
      const matching = tips.filter(tip => tip.deviceId === device.deviceId);
      const choices = matching.length > 0 ? matching : tips;
      const tip = choices[deviceIndex % choices.length]!;
      const content = await readFile(join(auditRoot, "inputs", `${tip.versionId.replace("#", "_")}.json`));
      if (sha256(content) !== tip.semanticHash) throw new Error(`Input hash mismatch ${resourceId}`);
      const snapshot = parsePortableChatSnapshot(content);
      seed(database, snapshot, proof);
      projections[resourceId] = { resourceId, kind: "chat", semanticHash: tip.semanticHash,
        versionId: tip.versionId, sourceChatCoreHash: portableChatCoreHash(snapshot),
        sourceBubbleCount: snapshot.bubbles.length,
        ...(snapshot.header.lastUpdatedAt === null ? {} : { sourceTimestamp: snapshot.header.lastUpdatedAt }) };
      selected.push({ resourceId, versionId: tip.versionId, sourceDeviceId: tip.deviceId,
        matchesDevice: tip.deviceId === device.deviceId, schema: snapshot.schemaVersion,
        bubbles: snapshot.bubbles.length, blobs: snapshot.schemaVersion === 2 ? snapshot.agentKv.blobs.length : 0 });
    }
    database.exec("COMMIT");
    database.close();
    const request = requestFor(paths, device.deviceId);
    const repository = { state: { projections, pendingDatabaseChanges: [] } } as unknown as SyncRepository;
    const session: GlobalDatabaseApplySession = { verifiedBackupPath: null };
    const results: Record<string, unknown>[] = [];
    const applicable: Resolution[] = [];
    for (const resolution of resolutions) {
      const prepared = await loadResolution(resolution, device.deviceId);
      if (prepared.blocked !== null || prepared.change === undefined || prepared.content === undefined) {
        results.push({ resourceId: resolution.resourceId, status: "blocked-by-production-gate", reason: prepared.blocked });
        continue;
      }
      const { change, content } = prepared;
      const result = await applyGlobalDatabaseChanges(request, [{ change, content }], () => {}, async () => {},
        () => [], device.deviceId, session);
      markAppliedProjections(repository, [change], result.applied, new Set(result.retainedLocal),
        result.retainedLocalHashes, result.localChatCoreHashes, result.failureByResourceId);
      const checks = verifyApplied(paths.globalDatabase, parsePortableChatSnapshot(content), change);
      const snapshot = parsePortableChatSnapshot(content);
      const closure = snapshot.schemaVersion === 2 ? await verifyPortableChatContinuationClosure(snapshot) : null;
      results.push({ resourceId: resolution.resourceId, status: result.applied.includes(resolution.resourceId) ? "applied" : "not-applied",
        strategy: resolution.metadata?.chatResolutionStrategy, skipped: result.skipped,
        failures: result.failureByResourceId, checks, closure });
      if (result.applied.includes(resolution.resourceId)) applicable.push(resolution);
      console.log(JSON.stringify({ phase: "apply-replay", device: device.label, resourceId: resolution.resourceId,
        applied: result.applied.length, checkedRows: checks.rows, rowMismatches: checks.rowMismatches }));
    }
    const scan = new StateVscdbChatAdapter(paths, { offline: true, periodicDeepVerification: false,
      forceCoreVerificationResourceIds: Object.keys(fixture.tips) });
    scan.setMaxPayloadBytes(limit);
    const recaptures: unknown[] = [];
    const scanWarnings: string[] = [];
    const scanNotices: string[] = [];
    let passes = 0;
    while (passes++ < 200) {
      const scanned = await scan.scan(repository.state.projections);
      scanWarnings.push(...scanned.warnings);
      scanNotices.push(...(scanned.notices ?? []));
      for (const snapshot of scanned.snapshots) {
        recaptures.push({ resourceId: snapshot.resourceId, bytes: snapshot.content.byteLength,
          semanticHash: snapshot.semanticHash, metadata: snapshot.metadata });
        const value = parsePortableChatSnapshot(snapshot.content);
        const previous = repository.state.projections[snapshot.resourceId];
        repository.state.projections[snapshot.resourceId] = { resourceId: snapshot.resourceId, kind: "chat",
          semanticHash: snapshot.semanticHash, versionId: previous?.versionId ?? null,
          sourceBubbleCount: value.bubbles.length, sourceChatCoreHash: portableChatCoreHash(value),
          ...(value.header.lastUpdatedAt === null ? {} : { sourceTimestamp: value.header.lastUpdatedAt }) };
      }
      if (scan.scanStatus().complete) break;
    }
    const beforeRepeat = logicalDigest(paths.globalDatabase);
    let repeatedApplied = 0;
    for (const resolution of applicable) {
      const prepared = await loadResolution(resolution, device.deviceId);
      const result = await applyGlobalDatabaseChanges(request, [{ change: prepared.change!, content: prepared.content! }],
        () => {}, async () => {}, () => [], device.deviceId, session);
      repeatedApplied += result.applied.length;
    }
    const afterRepeat = logicalDigest(paths.globalDatabase);
    const preservation = verifyPreserved(paths.globalDatabase, proof);
    const verificationDb = new DatabaseSync(paths.globalDatabase, { readOnly: true });
    const quickCheck = verificationDb.prepare("PRAGMA quick_check").get()?.quick_check;
    verificationDb.close();
    const summary = { device: device.label, deviceId: device.deviceId, databasePath: paths.globalDatabase, sourceChoices: selected,
      inputProofRows: proof.size, results, recaptures, scanPasses: passes, scanComplete: scan.scanStatus().complete,
      scanWarnings: [...new Set(scanWarnings)], scanNotices: [...new Set(scanNotices)],
      repeatedApplied, logicalRowsStableAfterRepeat: beforeRepeat === afterRepeat, logicalDigest: afterRepeat,
      preservation, quickCheck };
    (report.devices as unknown[]).push(summary);
    await writeFile(join(destinationRoot, "apply-replay-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ phase: "device-complete", device: device.label, applied: applicable.length,
      recaptures: recaptures.length, preserved: preservation, stableRepeat: beforeRepeat === afterRepeat, quickCheck }));
  }
  await replayEnrichment(report, resolutions, fixture);
  return { reportRoot: destinationRoot, devices: report.devices };
}

async function loadResolution(resolution: Resolution, deviceId: string): Promise<{ blocked: string | null; change?: HelperChange; content?: Buffer }> {
  let content: Buffer;
  try { content = await readFile(join(destinationRoot, "outputs", `${resolution.resourceId.slice(5)}.json`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { blocked: "no resolution payload" }; throw error; }
  const hash = sha256(content);
  if (resolution.semanticHash !== undefined && hash !== resolution.semanticHash) throw new Error("Resolution hash mismatch");
  const change: HelperChange = { resourceId: resolution.resourceId, kind: "chat", operation: "put",
    eventHash: sha256(`isolated-replay:${hash}`), changeIndex: 0, sourceDeviceId: deviceId,
    semanticHash: hash, metadata: resolution.metadata,
    payload: { plainBytes: content.byteLength, compressedBytes: content.byteLength, objectId: hash, deviceId } };
  const block = chatContinuationApplyBlockReason(change);
  if (block !== undefined) return { blocked: block };
  const reader = { readObject: async () => content } as unknown as SyncRepository;
  const prepared = await prepareChanges(reader, [change]);
  if (prepared.prepared.length !== 1) return { blocked: prepared.skipped.join("; ") };
  return { blocked: null, change, content };
}

function bytes(row: PortableKvRow): Buffer { return Buffer.from(row.valueBase64, "base64"); }
function value(row: PortableKvRow): string | Buffer | null {
  const raw = bytes(row);
  if (row.valueType === "null") return null;
  if (row.valueType === "blob") return raw;
  const text = raw.toString("utf8");
  return row.valueType === "text" || Buffer.from(text).equals(raw) ? text : raw;
}

function seed(db: DatabaseSync, snapshot: PortableChatSnapshot, proof: Map<string, Proof>) {
  const header = snapshot.header;
  db.prepare("INSERT INTO composerHeaders VALUES (?,?,?,?,?,?,?,?,?)")
    .run(header.composerId, header.workspaceId, header.createdAt, header.lastUpdatedAt, header.isArchived,
      header.isSubagent, header.recency, header.checkpointAt, header.value);
  const statement = db.prepare("INSERT INTO cursorDiskKV(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  statement.run(snapshot.composerData.key, value(snapshot.composerData));
  for (const row of snapshot.bubbles) {
    statement.run(row.key, value(row));
    proof.set(row.key, { hash: sha256(bytes(row)), valueType: row.valueType ?? "text", resourceId: `chat/${snapshot.composerId}`, kind: "bubble" });
  }
  if (snapshot.schemaVersion === 2) for (const row of snapshot.agentKv.blobs) {
    statement.run(row.key, value(row));
    proof.set(row.key, { hash: sha256(bytes(row)), valueType: row.valueType ?? "text", resourceId: `chat/${snapshot.composerId}`, kind: "blob" });
  }
}

function rowBytes(value: unknown): Buffer {
  if (value === null) return Buffer.alloc(0);
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("Unexpected SQLite value class");
}

function verifyApplied(path: string, snapshot: PortableChatSnapshot, change: HelperChange) {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("SELECT value,typeof(value) AS valueType FROM cursorDiskKV WHERE key=?");
  const blobOnly = change.metadata?.syncOrigin === "agent-kv-enrichment" && change.metadata.agentKvEnrichmentAppliesCore !== true;
  const checks = [...(blobOnly ? [] : [snapshot.composerData, ...snapshot.bubbles]),
    ...(snapshot.schemaVersion === 2 ? snapshot.agentKv.blobs : [])];
  let rowMismatches = 0;
  for (const expected of checks) {
    const actual = row.get(expected.key);
    if (actual === undefined || !rowBytes(actual.value).equals(bytes(expected))) rowMismatches++;
  }
  const header = db.prepare("SELECT * FROM composerHeaders WHERE composerId=?").get(snapshot.composerId);
  const expectedHeader = snapshot.header;
  const headerMismatch = !blobOnly && sha256(canonicalBytes(header ?? null)) !== sha256(canonicalBytes(expectedHeader));
  db.close();
  return { rows: checks.length, rowMismatches, headerMismatch, blobOnly };
}

function verifyPreserved(path: string, proof: Map<string, Proof>) {
  const db = new DatabaseSync(path, { readOnly: true });
  const read = db.prepare("SELECT value,typeof(value) AS valueType FROM cursorDiskKV WHERE key=?");
  let missing = 0, changed = 0, storageClassChanged = 0;
  const affected: string[] = [];
  for (const [key, expected] of proof) {
    const actual = read.get(key);
    if (actual === undefined) { missing++; affected.push(expected.resourceId); }
    else {
      if (sha256(rowBytes(actual.value)) !== expected.hash) { changed++; affected.push(expected.resourceId); }
      if (actual.valueType !== expected.valueType) storageClassChanged++;
    }
  }
  db.close();
  return { rows: proof.size, missing, changed, storageClassChanged, affectedResources: [...new Set(affected)] };
}

function logicalDigest(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  const hash = createHash("sha256");
  for (const row of db.prepare("SELECT * FROM composerHeaders ORDER BY composerId").iterate()) hash.update(canonicalBytes(row));
  for (const row of db.prepare("SELECT key,typeof(value) AS valueType,value FROM cursorDiskKV ORDER BY key").iterate()) {
    hash.update(canonicalBytes([row.key, row.valueType])); hash.update(rowBytes(row.value));
  }
  db.close();
  return hash.digest("hex");
}

function pathsFor(root: string): CursorPaths {
  return { appRoot: root, userDataRoot: root, globalStorageRoot: root, globalDatabase: join(root, "state.vscdb"),
    workspaceStorageRoot: join(root, "workspaceStorage"), profilesRoot: join(root, "profiles"), snippetsRoot: join(root, "snippets"),
    promptsRoot: join(root, "prompts"), userTasks: join(root, "tasks.json"), userMcp: join(root, "mcp.json"), cursorHome: root,
    cursorMcp: join(root, "cursor-mcp.json"), cursorCliConfig: join(root, "cli-config.json"), cursorCommands: join(root, "commands"),
    cursorSkills: join(root, "skills"), cursorRules: join(root, "rules"), cursorProjects: join(root, "projects"), cursorChats: join(root, "chats"),
    cursorAcpSessions: join(root, "acp"), cursorExtensionsManifest: join(root, "extensions.json"), extensionStorage: join(root, "storage"), helperScript: join(root, "helper.js") };
}

function requestFor(paths: CursorPaths, deviceId: string): HelperRequest {
  return { version: 1, requestId: randomUUID(), mode: "apply-and-restart", createdAt: new Date().toISOString(),
    repositoryRoot: join(paths.userDataRoot, "unused-repository"), storageRoot: paths.extensionStorage,
    cursorExecutable: process.execPath, extensionHostPid: 0, restart: false, expectedCursorVersion: producer.cursorVersion,
    expectedVscodeVersion: producer.vscodeVersion, extensionVersion: producer.extensionVersion, paths, changes: [], workspaceMappings: {},
    syncOptions: { ignoredSettings: [], ignoredExtensions: [], machineScopedSettings: [], syncChat: true, syncWorkspaceStorage: false, maxPayloadBytes: limit } };
}



function validateFixture(fixture: Fixture): void {
  if (!Array.isArray(fixture.conflicts) || fixture.tips === null || typeof fixture.tips !== "object" ||
    fixture.versions === null || typeof fixture.versions !== "object" || !Array.isArray(fixture.payloads)) {
    throw new Error("Expected fixture.json with conflicts, tips, versions and payloads.");
  }
  const resourcePattern = /^chat\/[0-9a-f-]{36}$/i;
  const versionPattern = /^[a-f0-9]{64}#\d+$/;
  for (const conflict of fixture.conflicts) {
    if (!resourcePattern.test(conflict.resourceId) || conflict.kind !== "chat" ||
      !Array.isArray(fixture.tips[conflict.resourceId])) throw new Error("Invalid chat conflict fixture.");
  }
  for (const [resourceId, tips] of Object.entries(fixture.tips)) {
    if (!resourcePattern.test(resourceId) || !Array.isArray(tips) || tips.length === 0 ||
      tips.some(tip => !versionPattern.test(tip.versionId) || typeof tip.deviceId !== "string" || tip.deviceId.length === 0)) {
      throw new Error("Invalid source tip fixture.");
    }
  }
  for (const version of [...Object.keys(fixture.versions), ...fixture.payloads]) {
    if (!versionPattern.test(version)) throw new Error("Invalid version filename.");
  }
}

async function resolveFixture(fixture: Fixture): Promise<Resolution[]> {
  const repository = {
    state: { tips: structuredClone(fixture.tips) }, maxPayloadBytes: limit,
    tryReadVersionMetadata: async (version: string) => fixture.versions[version] ?? null,
    tryReadVersion: async (version: string) => {
      if (!/^[a-f0-9]{64}#\d+$/.test(version)) throw new Error("Invalid version read.");
      const metadata = fixture.versions[version];
      if (!metadata) return null;
      let content: Buffer;
      try { content = await readFile(join(auditRoot, "inputs", `${version.replace("#", "_")}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      if (sha256(content) !== metadata.change.semanticHash) throw new Error("Source payload hash mismatch.");
      return { ...metadata, content };
    },
  } as unknown as SyncRepository;
  const resolutions: Resolution[] = [];
  const failures: unknown[] = [];
  for (const conflict of fixture.conflicts) {
    const warnings: string[] = [];
    const snapshot = await prepareChatConflictResolution(repository, conflict, {
      offline: true,
      tipsAllowed: tips => tips.every(tip => helperAcceptsChatProducer(tip, requestFor(pathsFor(destinationRoot), "replay"))),
      onWarning: message => warnings.push(message),
    });
    if (snapshot === null) {
      failures.push({ resourceId: conflict.resourceId, warnings });
      continue;
    }
    const file = join(destinationRoot, "outputs", `${conflict.resourceId.slice(5)}.json`);
    await writeFile(file, snapshot.content);
    const { content: _content, ...metadata } = snapshot;
    void _content;
    if (snapshot.metadata === undefined) throw new Error("Resolution metadata is missing.");
    resolutions.push({ ...metadata, metadata: snapshot.metadata, file });
  }
  await writeFile(join(destinationRoot, "resolutions.json"), JSON.stringify(resolutions, null, 2));
  await writeFile(join(destinationRoot, "resolution-failures.json"), JSON.stringify(failures, null, 2));
  return resolutions;
}

async function replayEnrichment(baseline: any, resolutions: Resolution[], fixture: Fixture) {
  const output: Record<string, unknown> = { capturedAt: new Date().toISOString(), stages: [], forwarded: [] };
  const storedComplete: Array<{ sourceDevice: string; resourceId: string; snapshot: ResourceSnapshot }> = [];
  const repositories = new Map<string, SyncRepository>();
  const sessions = new Map<string, GlobalDatabaseApplySession>();
  await mkdir(join(destinationRoot, "enriched-outputs"), { recursive: true });
  for (const device of baseline.devices) {
    const paths = pathsFor(dirname(device.databasePath));
    const deviceId = device.deviceId as string;
    const repository = { state: { tips: {}, projections: {}, pendingDatabaseChanges: [] } } as unknown as SyncRepository;
    for (const choice of device.sourceChoices) {
      const applied = device.results.some((r: any) => r.resourceId === choice.resourceId && r.status === "applied");
      const current = applied ? resolutions.find((r: any) => r.resourceId === choice.resourceId)! : fixture.versions[choice.versionId]!.change;
      repository.state.projections[choice.resourceId] = { resourceId: choice.resourceId, kind: "chat", semanticHash: current.semanticHash,
        versionId: choice.versionId,
        ...(typeof current.metadata?.chatCoreHash === "string" ? { sourceChatCoreHash: current.metadata.chatCoreHash } : {}),
        ...(typeof current.metadata?.lastUpdatedAt === "number" ? { sourceTimestamp: current.metadata.lastUpdatedAt } : {}),
        ...(typeof current.metadata?.bubbleCount === "number" ? { sourceBubbleCount: current.metadata.bubbleCount } : {}) };
    }
    repositories.set(device.device, repository);
    const session: GlobalDatabaseApplySession = { verifiedBackupPath: null };
    sessions.set(device.device, session);
    for (const resolution of resolutions.filter((r: any) => r.metadata.chatSnapshotSchemaVersion === 1)) {
      const content = await readFile(join(destinationRoot, "outputs", `${resolution.resourceId.slice(5)}.json`));
      const original = parsePortableChatSnapshot(content);
      const hash = sha256(content);
      const eventHash = sha256(`replay-resolved:${hash}`);
      const tip: ResourceTip = { resourceId: resolution.resourceId, kind: "chat", operation: "put", semanticHash: hash,
        eventHash, changeIndex: 0, versionId: `${eventHash}#0`, parents: resolution.parents, lamport: 30_000,
        deviceId, producer, payload: { plainBytes: content.length, compressedBytes: content.length, objectId: hash, deviceId },
        metadata: resolution.metadata } as ResourceTip;
      repository.state.tips[resolution.resourceId] = [tip];
      repository.tryReadVersion = async () => ({ content, change: { ...tip, resourceId: resolution.resourceId }, producer });
      let enriched: ResourceSnapshot | undefined;
      repository.publish = async (snapshots) => {
        enriched = snapshots[0]!;
        const enrichedHash = sha256(enriched.content);
        repository.state.tips[resolution.resourceId] = [{ ...tip, semanticHash: enrichedHash,
          eventHash: sha256(`replay-enriched:${enrichedHash}`), versionId: `${sha256(`replay-enriched:${enrichedHash}`)}#0`,
          metadata: enriched.metadata ?? {}, parents: enriched.parents ?? [],
          payload: { plainBytes: enriched.content.length, compressedBytes: enriched.content.length, objectId: enrichedHash, deviceId } }];
        return { eventHash: sha256(`replay-enriched:${enrichedHash}`), eventPath: "isolated-memory", changeCount: 1 };
      };
      const result = await enrichCurrentChatTipsFromLiveDatabase(repository, paths.globalDatabase, {
        offline: true, maxPayloadBytes: limit, batchSize: 1, cursor: { afterResourceId: null },
        candidateIndex: [{ resourceId: resolution.resourceId, tip, expectedTipIds: [tip.versionId] }],
      });
      const stage: Record<string, unknown> = { device: device.device, resourceId: resolution.resourceId,
        initialSchema: original.schemaVersion, initialCoreHash: portableChatCoreHash(original),
        attempted: result.attempted, published: result.published, warnings: result.warnings };
      if (enriched !== undefined) {
        const built = parsePortableChatSnapshot(enriched.content);
        const closure = built.schemaVersion === 2 ? await verifyPortableChatContinuationClosure(built) : null;
        Object.assign(stage, { bytes: enriched.content.length, coreUnchanged: portableChatCoreHash(built) === portableChatCoreHash(original),
          schema: built.schemaVersion, blobs: built.schemaVersion === 2 ? built.agentKv.blobs.length : null,
          missing: built.schemaVersion === 2 ? built.agentKv.missingIds.length : null, closure,
          appliesCore: enriched.metadata?.agentKvEnrichmentAppliesCore === true });
        await writeFile(join(destinationRoot, "enriched-outputs", `${device.device}.${built.composerId}.json`), enriched.content);
        const applied = await applyEnriched(repository, enriched, paths, deviceId, session, requestFor, verifyApplied, logicalDigest);
        Object.assign(stage, applied);
        if (enriched.metadata?.agentKvEnrichmentAppliesCore === true && closure?.status === "complete") {
          storedComplete.push({ sourceDevice: device.device, resourceId: resolution.resourceId, snapshot: enriched });
        }
      } else {
        stage.coreApplied = false;
        stage.reason = "No complete enrichment can be created from this backup database; the latest core stays unchanged in the repository and existing local data is preserved.";
      }
      (output.stages as unknown[]).push(stage);
      await writeFile(join(destinationRoot, "enrichment-replay-report.json"), JSON.stringify(output, null, 2));
      console.log(JSON.stringify({ phase: "enrich-replay", ...stage }));
    }
  }
  for (const completed of storedComplete) {
    for (const device of baseline.devices.filter((d: any) => d.device !== completed.sourceDevice)) {
      const paths = pathsFor(dirname(device.databasePath));
      const deviceId = device.deviceId as string;
      const applied = await applyEnriched(repositories.get(device.device)!, completed.snapshot, paths, deviceId,
        sessions.get(device.device)!, requestFor, verifyApplied, logicalDigest);
      (output.forwarded as unknown[]).push({ sourceDevice: completed.sourceDevice, targetDevice: device.device,
        resourceId: completed.resourceId, ...applied });
    }
  }
  await writeFile(join(destinationRoot, "enrichment-replay-report.json"), JSON.stringify(output, null, 2));
}

async function applyEnriched(repository: SyncRepository, snapshot: ResourceSnapshot, paths: any, deviceId: string,
  session: GlobalDatabaseApplySession, requestFor: any, verifyApplied: any, logicalDigest: any) {
  const hash = sha256(snapshot.content);
  const change: HelperChange = { resourceId: snapshot.resourceId, kind: "chat", operation: "put", semanticHash: hash,
    eventHash: sha256(`apply-enriched:${hash}`), changeIndex: 0, sourceDeviceId: deviceId, metadata: snapshot.metadata ?? {},
    payload: { plainBytes: snapshot.content.length, compressedBytes: snapshot.content.length, objectId: hash, deviceId } };
  const reader = { readObject: async () => snapshot.content } as unknown as SyncRepository;
  const prepared = await prepareChanges(reader, [change]);
  if (prepared.prepared.length !== 1) return { productionGate: prepared.skipped, coreApplied: false };
  const request = requestFor(paths, deviceId);
  request.requestId = randomUUID();
  const applied = await applyGlobalDatabaseChanges(request, prepared.prepared, () => {}, async () => {}, () => [], deviceId, session);
  markAppliedProjections(repository, [change], applied.applied, new Set(applied.retainedLocal),
    applied.retainedLocalHashes, applied.localChatCoreHashes, applied.failureByResourceId);
  const checks = verifyApplied(paths.globalDatabase, parsePortableChatSnapshot(snapshot.content), change);
  const scan = new StateVscdbChatAdapter(paths, { offline: true, periodicDeepVerification: false,
    forceCoreVerificationResourceIds: [snapshot.resourceId] });
  scan.setMaxPayloadBytes(limit);
  const scanned = await scan.scan(repository.state.projections);
  const before = logicalDigest(paths.globalDatabase);
  request.requestId = randomUUID();
  await applyGlobalDatabaseChanges(request, prepared.prepared, () => {}, async () => {}, () => [], deviceId, session);
  return { productionGate: "accepted", applied: applied.applied.length, coreApplied: snapshot.metadata?.agentKvEnrichmentAppliesCore === true && applied.applied.length === 1,
    checks, recaptures: scanned.snapshots.map(s => ({ resourceId: s.resourceId, bytes: s.content.length, metadata: s.metadata })),
    warnings: scanned.warnings, notices: scanned.notices, repeatStable: before === logicalDigest(paths.globalDatabase) };
}

