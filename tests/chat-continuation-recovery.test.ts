import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrichCurrentChatTipsFromLiveDatabase,
  type ChatTipEnrichmentCursor,
} from "../src/chat/enrichment";
import {
  auditChatContinuationRoots,
  readPortableChatSnapshot,
  type ChatContinuationRootAudit,
  type ChatContinuationRootProbe,
} from "../src/chat/repair";
import {
  isPortableChatSnapshotV2,
  parsePortableChatSnapshot,
  portableChatCoreHash,
  type PortableChatSnapshot,
  type PortableChatSnapshotV1,
  type PortableKvRow,
} from "../src/chat/stateVscdb";
import {
  applyGlobalDatabaseChanges,
  type PreparedHelperChange,
} from "../src/helper/database";
import type { HelperRequest } from "../src/helper/types";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";
import { EventReconciler } from "../src/protocol/reconciler";
import { SyncRepository } from "../src/protocol/repository";
import type {
  EventProducer,
  ResourceSnapshot,
  ResourceTip,
} from "../src/types";

const { DatabaseSync } = sqlite;
const PASSPHRASE = "a sufficiently long continuation recovery passphrase";
const COMPOSER_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const TITLE = "Calendar selection logic";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.63",
  cursorVersion: "3.15.6",
  vscodeVersion: "1.125.0",
};
const temporaryRoots: string[] = [];
const describeWithBackup =
  typeof sqlite.backup === "function" ? describe : describe.skip;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describeWithBackup("cross-device chat continuation recovery", () => {
  it("enriches a newer A core from both devices and repairs A additively", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-recovery-e2e-"));
    temporaryRoots.push(root);
    const repository = await SyncRepository.create(
      join(root, "repository"),
      join(root, "repository-state"),
      PASSPHRASE,
      4 * 1024 * 1024,
      PRODUCER,
    );
    const aDatabasePath = join(root, "device-a-state.vscdb");
    const bDatabasePath = join(root, "device-b-state.vscdb");
    createGlobalDatabase(aDatabasePath);
    createGlobalDatabase(bDatabasePath);

    const aLeaf = contentBlob("A-only continuation leaf");
    const aRoot = contentBlob(protobufIds([aLeaf.id]));
    const bLeaf = contentBlob("B healthy continuation leaf");
    const bRoot = contentBlob(protobufIds([bLeaf.id]));
    const aCore = chatSnapshot({
      bubbleCount: 5,
      composerRootId: bRoot.id,
      errorBubbleRootId: aRoot.id,
      label: "A-newer",
    });
    const bCore = chatSnapshot({
      bubbleCount: 3,
      composerRootId: bRoot.id,
      label: "B-shorter",
    });
    seedChat(aDatabasePath, aCore, [aRoot, aLeaf]);
    seedChat(bDatabasePath, bCore, [bRoot, bLeaf]);

    const initialA = await auditDatabaseChat(aDatabasePath);
    expectKnownAudit(initialA.audit);
    expect(initialA.audit.unavailableRootIds).toEqual([bRoot.id]);
    const initialB = await auditDatabaseChat(bDatabasePath);
    expectKnownAudit(initialB.audit);
    expect(initialB.audit).toMatchObject({
      unavailableRootIds: [],
      probedRootCount: 2,
    });

    const legacyTip = await publishChat(repository, aCore);
    expect(legacyTip.metadata?.chatSnapshotSchemaVersion).toBeUndefined();

    const bResult = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      bDatabasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: new Map(),
      },
    );
    expect(bResult).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);

    const partialTip = onlyTip(repository);
    const partial = await readTipChat(repository, partialTip);
    expect(isPortableChatSnapshotV2(partial)).toBe(true);
    if (!isPortableChatSnapshotV2(partial)) {
      throw new Error("B enrichment did not produce chat schema v2");
    }
    expect(core(partial)).toEqual(core(aCore));
    expect(partial.agentKv).toMatchObject({
      referencedIds: [aRoot.id, bLeaf.id, bRoot.id].sort(),
      missingIds: [aRoot.id],
    });
    expect(partial.agentKv.blobs.map(blobId)).toEqual(
      [bLeaf.id, bRoot.id].sort(),
    );
    expect(partialTip.metadata).toMatchObject({
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 2,
      agentKvReferencedCount: 3,
      agentKvMissingCount: 1,
      chatCoreHash: portableChatCoreHash(aCore),
      syncOrigin: "agent-kv-enrichment",
    });
    expect(portableChatCoreHash(readDatabaseChat(bDatabasePath))).toBe(
      portableChatCoreHash(bCore),
    );

    const aResult = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      aDatabasePath,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: new Map(),
      },
    );
    expect(aResult).toMatchObject({ attempted: 1, published: 1, warnings: [] });
    await reconcile(repository);

    const finalTip = onlyTip(repository);
    const finalSnapshot = await readTipChat(repository, finalTip);
    expect(isPortableChatSnapshotV2(finalSnapshot)).toBe(true);
    if (!isPortableChatSnapshotV2(finalSnapshot)) {
      throw new Error("A enrichment did not retain chat schema v2");
    }
    expect(core(finalSnapshot)).toEqual(core(aCore));
    expect(finalSnapshot.agentKv).toMatchObject({
      referencedIds: [aLeaf.id, aRoot.id, bLeaf.id, bRoot.id].sort(),
      missingIds: [],
    });
    expect(finalSnapshot.agentKv.blobs.map(blobId)).toEqual(
      [aLeaf.id, aRoot.id, bLeaf.id, bRoot.id].sort(),
    );
    expect(finalTip.parents).toEqual([partialTip.versionId]);
    expect(finalTip.metadata).toMatchObject({
      chatSnapshotSchemaVersion: 2,
      agentKvBlobCount: 4,
      agentKvReferencedCount: 4,
      agentKvMissingCount: 0,
      chatCoreHash: portableChatCoreHash(aCore),
      syncOrigin: "agent-kv-enrichment",
    });

    const aCoreBeforeApply = readDatabaseChat(aDatabasePath);
    const applyResult = await applyGlobalDatabaseChanges(
      helperRequest(root, aDatabasePath),
      [await preparedTipChange(repository, finalTip)],
    );
    expect(applyResult.applied).toEqual([`chat/${COMPOSER_ID}`]);
    expect(applyResult.skipped).toEqual([]);

    const aCoreAfterApply = readDatabaseChat(aDatabasePath);
    expect(core(aCoreAfterApply)).toEqual(core(aCoreBeforeApply));
    expect(core(aCoreAfterApply)).toEqual(core(aCore));
    expect(portableChatCoreHash(aCoreAfterApply)).toBe(
      portableChatCoreHash(aCore),
    );
    expect(JSON.parse(aCoreAfterApply.header.value ?? "null") as unknown).toEqual(
      { name: TITLE },
    );

    const repairedA = await auditDatabaseChat(aDatabasePath);
    expectKnownAudit(repairedA.audit);
    expect(repairedA.audit).toMatchObject({
      unavailableRootIds: [],
      probedRootCount: 4,
    });
    expect(repairedA.audit.referencedRootIds).toEqual(
      [aLeaf.id, aRoot.id, bLeaf.id, bRoot.id].sort(),
    );

    // A complete v2 tip is not an enrichment candidate. The deliberately
    // invalid SQLite sentinel would throw if the lazy wrapper opened it, while
    // spying on the repository proves an idle pass does not decrypt the tip.
    const invalidIdleDatabase = join(root, "must-not-open.vscdb");
    await writeFile(invalidIdleDatabase, "not a sqlite database", "utf8");
    const readVersion = vi.spyOn(repository, "tryReadVersion");
    const idleCache = new Map<string, string>();
    const firstIdle = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      invalidIdleDatabase,
      {
        cursor: initialCursor(),
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: idleCache,
      },
    );
    const secondIdle = await enrichCurrentChatTipsFromLiveDatabase(
      repository,
      invalidIdleDatabase,
      {
        cursor: firstIdle.cursor,
        maxPayloadBytes: repository.maxPayloadBytes,
        attemptCache: idleCache,
      },
    );
    expect(firstIdle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(secondIdle).toMatchObject({ attempted: 0, published: 0, warnings: [] });
    expect(readVersion).not.toHaveBeenCalled();
  });
});

interface ContentBlob {
  id: string;
  bytes: Buffer;
  row: PortableKvRow;
}

function contentBlob(value: string | Buffer): ContentBlob {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const id = sha256(bytes);
  return {
    id,
    bytes,
    row: {
      key: `agentKv:blob:${id}`,
      valueBase64: bytes.toString("base64"),
      valueType: "blob",
    },
  };
}

function protobufIds(ids: readonly string[]): Buffer {
  return Buffer.concat(
    ids.map((id) =>
      Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")]),
    ),
  );
}

function serializedConversationState(id: string): string {
  return `~${protobufIds([id]).toString("base64")}`;
}

function chatSnapshot(options: {
  bubbleCount: number;
  composerRootId: string;
  errorBubbleRootId?: string;
  label: string;
}): PortableChatSnapshotV1 {
  const bubbleIds = Array.from(
    { length: options.bubbleCount },
    (_, index) => `bubble-${index}`,
  );
  return {
    schemaVersion: 1,
    composerId: COMPOSER_ID,
    header: {
      composerId: COMPOSER_ID,
      workspaceId: "workspace",
      createdAt: 1,
      lastUpdatedAt: options.bubbleCount,
      isArchived: 0,
      isSubagent: 0,
      recency: options.bubbleCount,
      checkpointAt: null,
      value: JSON.stringify({ name: TITLE }),
    },
    composerData: jsonRow(`composerData:${COMPOSER_ID}`, {
      fullConversationHeadersOnly: bubbleIds.map((bubbleId) => ({ bubbleId })),
      conversationState: serializedConversationState(options.composerRootId),
    }),
    bubbles: bubbleIds.map((bubbleId, index) =>
      jsonRow(`bubbleId:${COMPOSER_ID}:${bubbleId}`, {
        bubbleId,
        text:
          index === options.bubbleCount - 1 &&
          options.errorBubbleRootId !== undefined
            ? "Conversation data missing"
            : `${options.label} message ${index}`,
        ...(index === options.bubbleCount - 1 &&
        options.errorBubbleRootId !== undefined
          ? {
              conversationState: serializedConversationState(
                options.errorBubbleRootId,
              ),
            }
          : {}),
      }),
    ),
  };
}

function jsonRow(key: string, value: unknown): PortableKvRow {
  return {
    key,
    valueBase64: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
    valueType: "text",
  };
}

function core(snapshot: PortableChatSnapshot): unknown {
  return {
    composerId: snapshot.composerId,
    header: snapshot.header,
    composerData: snapshot.composerData,
    bubbles: snapshot.bubbles,
  };
}

function blobId(row: PortableKvRow): string {
  return row.key.slice("agentKv:blob:".length);
}

function createGlobalDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode=WAL");
    database.exec(
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database.exec(
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    database.exec(`CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
      recency INTEGER, checkpointAt INTEGER, value TEXT
    )`);
    database
      .prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)")
      .run("existing", "preserved");
  } finally {
    database.close();
  }
}

function seedChat(
  databasePath: string,
  snapshot: PortableChatSnapshotV1,
  blobs: readonly ContentBlob[],
): void {
  const database = new DatabaseSync(databasePath);
  try {
    const header = snapshot.header;
    database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        header.composerId,
        header.workspaceId,
        header.createdAt,
        header.lastUpdatedAt,
        header.isArchived,
        header.isSubagent,
        header.recency,
        header.checkpointAt,
        header.value,
      );
    const insert = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
    );
    insert.run(
      snapshot.composerData.key,
      Buffer.from(snapshot.composerData.valueBase64, "base64").toString("utf8"),
    );
    for (const bubble of snapshot.bubbles) {
      insert.run(
        bubble.key,
        Buffer.from(bubble.valueBase64, "base64").toString("utf8"),
      );
    }
    for (const blob of blobs) {
      insert.run(blob.row.key, blob.bytes);
    }
  } finally {
    database.close();
  }
}

function readDatabaseChat(databasePath: string): PortableChatSnapshot {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const snapshot = readPortableChatSnapshot(database, COMPOSER_ID);
    if (snapshot === null) {
      throw new Error(`Missing test chat in ${databasePath}`);
    }
    return snapshot;
  } finally {
    database.close();
  }
}

async function auditDatabaseChat(
  databasePath: string,
): Promise<{ snapshot: PortableChatSnapshot; audit: ChatContinuationRootAudit }> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const snapshot = readPortableChatSnapshot(database, COMPOSER_ID);
    if (snapshot === null) {
      throw new Error(`Missing test chat in ${databasePath}`);
    }
    return {
      snapshot,
      audit: await auditChatContinuationRoots(snapshot, sqliteProbe(database), {
        limits: {
          maxRootProbes: 8,
          maxRootsPerChat: 8,
          maxSeedBytesPerChat: 4 * 1024,
          maxGraphDepth: 4,
          maxProtobufDepth: 4,
        },
      }),
    };
  } finally {
    database.close();
  }
}

function sqliteProbe(database: sqlite.DatabaseSync): ChatContinuationRootProbe {
  const statement = database.prepare(
    `SELECT key, value, typeof(value) AS valueType,
            length(CAST(value AS BLOB)) AS valueBytes
       FROM cursorDiskKV
      WHERE key = ?`,
  );
  return (key, remainingBytes) => {
    const row = statement.get(key) as
      | {
          key?: unknown;
          value?: unknown;
          valueType?: unknown;
          valueBytes?: unknown;
        }
      | undefined;
    if (row === undefined) {
      return { status: "missing" };
    }
    if (
      row.key !== key ||
      typeof row.valueBytes !== "number" ||
      !Number.isSafeInteger(row.valueBytes) ||
      row.valueBytes < 0
    ) {
      return { status: "unreadable", reason: "invalid SQLite row metadata" };
    }
    if (row.valueBytes > remainingBytes) {
      return { status: "over-budget" };
    }
    if (row.valueType === "text" && typeof row.value === "string") {
      return {
        status: "found",
        key,
        bytes: Buffer.from(row.value, "utf8"),
        valueType: "text",
      };
    }
    if (row.valueType === "blob" && row.value instanceof Uint8Array) {
      return {
        status: "found",
        key,
        bytes: Buffer.from(row.value),
        valueType: "blob",
      };
    }
    return { status: "unreadable", reason: "unsupported SQLite storage" };
  };
}

function expectKnownAudit(
  audit: ChatContinuationRootAudit,
): asserts audit is Extract<ChatContinuationRootAudit, { status: "known" }> {
  expect(audit.status).toBe("known");
  if (audit.status !== "known") {
    throw new Error(`Continuation audit was unknown: ${audit.reason}`);
  }
}

function initialCursor(): ChatTipEnrichmentCursor {
  return { afterResourceId: null };
}

async function publishChat(
  repository: SyncRepository,
  chat: PortableChatSnapshot,
): Promise<ResourceTip> {
  await repository.publish(
    [
      {
        ...resourceSnapshot(chat, []),
        metadata: {
          composerId: chat.composerId,
          workspaceId: chat.header.workspaceId,
          bubbleCount: chat.bubbles.length,
          title: TITLE,
          chatCoreHash: portableChatCoreHash(chat),
        },
      },
    ],
    [],
  );
  await reconcile(repository);
  return onlyTip(repository);
}

function resourceSnapshot(
  chat: PortableChatSnapshot,
  parents: string[],
): ResourceSnapshot {
  const content = canonicalBytes(chat);
  return {
    resourceId: `chat/${chat.composerId}`,
    kind: "chat",
    content,
    semanticHash: sha256(content),
    parents,
  };
}

async function reconcile(repository: SyncRepository): Promise<void> {
  new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  );
}

function onlyTip(repository: SyncRepository): ResourceTip {
  const tips = repository.state.tips[`chat/${COMPOSER_ID}`] ?? [];
  expect(tips).toHaveLength(1);
  const tip = tips[0];
  if (tip === undefined) {
    throw new Error("Missing chat tip");
  }
  return tip;
}

async function readTipChat(
  repository: SyncRepository,
  tip: ResourceTip,
): Promise<PortableChatSnapshot> {
  const data = await repository.readVersion(tip.versionId);
  if (data.content === null) {
    throw new Error(`Chat tip ${tip.versionId} has no content`);
  }
  return parsePortableChatSnapshot(data.content);
}

async function preparedTipChange(
  repository: SyncRepository,
  tip: ResourceTip,
): Promise<PreparedHelperChange> {
  const data = await repository.readVersion(tip.versionId);
  if (data.content === null) {
    throw new Error(`Chat tip ${tip.versionId} has no content`);
  }
  return {
    change: {
      eventHash: tip.eventHash,
      changeIndex: tip.changeIndex,
      sourceDeviceId: tip.deviceId,
      resourceId: `chat/${COMPOSER_ID}`,
      kind: "chat",
      operation: "put",
      semanticHash: tip.semanticHash,
      ...(tip.payload === undefined ? {} : { payload: tip.payload }),
      ...(tip.metadata === undefined ? {} : { metadata: tip.metadata }),
    },
    content: data.content,
  };
}

function helperRequest(root: string, databasePath: string): HelperRequest {
  const cursorHome = join(root, ".cursor");
  const userDataRoot = join(root, "User");
  const extensionStorage = join(root, "helper-storage");
  return {
    version: 1,
    requestId: "12345678-9abc-4def-8abc-123456789abc",
    mode: "apply-and-restart",
    createdAt: "2026-08-11T00:00:00.000Z",
    repositoryRoot: join(root, "repository"),
    storageRoot: extensionStorage,
    cursorExecutable: "Cursor.exe",
    extensionHostPid: 1,
    restart: false,
    expectedCursorVersion: PRODUCER.cursorVersion,
    expectedVscodeVersion: PRODUCER.vscodeVersion,
    extensionVersion: PRODUCER.extensionVersion,
    paths: {
      appRoot: root,
      userDataRoot,
      globalStorageRoot: root,
      globalDatabase: databasePath,
      workspaceStorageRoot: join(userDataRoot, "workspaceStorage"),
      profilesRoot: join(userDataRoot, "profiles"),
      snippetsRoot: join(userDataRoot, "snippets"),
      promptsRoot: join(userDataRoot, "prompts"),
      userTasks: join(userDataRoot, "tasks.json"),
      userMcp: join(userDataRoot, "mcp.json"),
      cursorHome,
      cursorMcp: join(cursorHome, "mcp.json"),
      cursorCliConfig: join(cursorHome, "cli-config.json"),
      cursorCommands: join(cursorHome, "commands"),
      cursorSkills: join(cursorHome, "skills"),
      cursorRules: join(cursorHome, "rules"),
      cursorProjects: join(cursorHome, "projects"),
      cursorChats: join(cursorHome, "chats"),
      cursorAcpSessions: join(cursorHome, "acp-sessions"),
      cursorExtensionsManifest: join(cursorHome, "extensions", "extensions.json"),
      extensionStorage,
      helperScript: join(root, "helper.js"),
    },
    changes: [],
    workspaceMappings: {},
    syncOptions: {
      ignoredSettings: [],
      ignoredExtensions: [],
      machineScopedSettings: [],
      syncChat: true,
      syncWorkspaceStorage: true,
      maxPayloadBytes: 4 * 1024 * 1024,
    },
  };
}
