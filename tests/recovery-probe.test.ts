import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureChatRecoveryProbe,
  findChatRecoverySuccessor,
} from "../src/chat/recoveryProbe";

const ORIGINAL = "11111111-1111-4111-8111-111111111111";
const SUCCESSOR = "22222222-2222-4222-8222-222222222222";

describe("read-only chat recovery probe", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it("fingerprints visible roles, markers, the tail, and a complete empty graph", async () => {
    const fixture = await createFixture();
    insertComposer(fixture.database, ORIGINAL, 100, [
      user("u1", "timepicker 동작"),
      assistant("a1", "확인", tool("read_file_v2", '{"path":"x"}')),
      assistant("a2", ""),
      user("u2", "ㅎㅇ"),
      assistant("a3", "응답"),
    ]);
    fixture.database.close();

    const first = await captureChatRecoveryProbe(fixture.path, ORIGINAL);
    const second = await captureChatRecoveryProbe(fixture.path, ORIGINAL);

    expect(first.probeFingerprint).toBe(second.probeFingerprint);
    expect(first.visible).toEqual({
      referencedCount: 5,
      presentReferencedCount: 5,
      unavailableReferencedCount: 0,
      storedBubbleCount: 5,
    });
    expect(first.roles).toEqual({
      referencedUser: 2,
      referencedAssistant: 3,
      recoverableUserRecords: 2,
      recoverableAssistantRecords: 2,
      toolUseCount: 1,
      validToolUseCount: 1,
      rawToolNameCounts: { read_file_v2: 1 },
      skippedEmptyAssistantRows: 1,
      unrecoverableUserRows: 0,
      unsupportedRoleRows: 0,
      unreadableRows: 0,
    });
    expect(first.markers).toMatchObject({
      timerOrTimepicker: true,
      hieungIeung: true,
    });
    expect(first.tail.assistantFollowsLastUser).toBe(true);
    expect(first.tail.lastUser).toMatchObject({
      referenceIndex: 3,
      recoverable: true,
    });
    expect(first.tail.lastAssistant).toMatchObject({
      referenceIndex: 4,
      recoverable: true,
    });
    expect(first.agentKv).toMatchObject({
      status: "known",
      referencedCount: 0,
      foundCount: 0,
      unavailableCount: 0,
      complete: true,
    });
  });

  it("identifies one same-workspace successor by two distinct prompt hashes", async () => {
    const fixture = await createFixture();
    insertComposer(fixture.database, ORIGINAL, 100, [user("u1", "old")]);
    insertComposer(fixture.database, SUCCESSOR, 1_100, [
      user("u1", "probe-one"),
      user("u1-copy", "probe-one"),
      assistant("a1", "first response"),
      user("u2", "probe-two"),
      user("u2-copy", "probe-two"),
      assistant("a2", "second response"),
    ]);
    insertComposer(
      fixture.database,
      "33333333-3333-4333-8333-333333333333",
      1_200,
      [user("u1", "different"), assistant("a1", "response")],
    );
    fixture.database.close();

    const result = await findChatRecoverySuccessor(fixture.path, ORIGINAL, {
      createdAfter: 1_000,
      expectedUserTextHashes: [hash("probe-one"), hash("probe-two")],
    });

    expect(result).toMatchObject({
      candidateCount: 2,
      candidateLimitReached: false,
      matchingCandidateCount: 1,
      identifiedComposerId: SUCCESSOR,
    });
    expect(result.successor?.tail.assistantFollowsLastUser).toBe(true);
    expect(result.successor?.agentKv).toMatchObject({
      status: "known",
      complete: true,
      unavailableCount: 0,
    });
  });

  it("refuses an ambiguous or truncated successor search", async () => {
    const fixture = await createFixture();
    insertComposer(fixture.database, ORIGINAL, 100, [user("u1", "old")]);
    for (const [id, createdAt] of [
      [SUCCESSOR, 1_100],
      ["33333333-3333-4333-8333-333333333333", 1_200],
    ] as const) {
      insertComposer(fixture.database, id, createdAt, [
        user("u1", "probe-one"),
        assistant("a1", "first"),
        user("u2", "probe-two"),
        assistant("a2", "second"),
      ]);
    }
    fixture.database.close();

    const ambiguous = await findChatRecoverySuccessor(
      fixture.path,
      ORIGINAL,
      {
        createdAfter: 1_000,
        expectedUserTextHashes: [hash("probe-one"), hash("probe-two")],
      },
    );
    expect(ambiguous.matchingCandidateCount).toBe(2);
    expect(ambiguous.identifiedComposerId).toBeNull();

    const truncated = await findChatRecoverySuccessor(
      fixture.path,
      ORIGINAL,
      {
        createdAfter: 1_000,
        expectedUserTextHashes: [hash("probe-one"), hash("probe-two")],
        maxCandidates: 1,
      },
    );
    expect(truncated.candidateLimitReached).toBe(true);
    expect(truncated.identifiedComposerId).toBeNull();
  });

  async function createFixture(): Promise<{
    database: DatabaseSync;
    path: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "chat-recovery-probe-"));
    roots.push(root);
    const path = join(root, "state.vscdb");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        workspaceId TEXT,
        createdAt INTEGER,
        lastUpdatedAt INTEGER,
        isArchived INTEGER,
        isSubagent INTEGER,
        recency INTEGER,
        checkpointAt INTEGER,
        value TEXT
      );
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value);
    `);
    return { database, path };
  }
});

interface FixtureBubble {
  id: string;
  value: Record<string, unknown>;
}

function insertComposer(
  database: DatabaseSync,
  composerId: string,
  createdAt: number,
  bubbles: readonly FixtureBubble[],
): void {
  database
    .prepare(
      `INSERT INTO composerHeaders(
         composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
         isSubagent, recency, checkpointAt, value
       ) VALUES (?, ?, ?, ?, 0, 0, ?, NULL, ?)`,
    )
    .run(
      composerId,
      "workspace-1",
      createdAt,
      createdAt + 10,
      createdAt + 10,
      JSON.stringify({ name: composerId }),
    );
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(
      `composerData:${composerId}`,
      JSON.stringify({
        fullConversationHeadersOnly: bubbles.map((bubble) => ({
          bubbleId: bubble.id,
        })),
      }),
    );
  const insert = database.prepare(
    "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
  );
  for (const bubble of bubbles) {
    insert.run(
      `bubbleId:${composerId}:${bubble.id}`,
      JSON.stringify({ bubbleId: bubble.id, ...bubble.value }),
    );
  }
}

function user(id: string, text: string): FixtureBubble {
  return { id, value: { type: 1, text } };
}

function assistant(
  id: string,
  text: string,
  toolFormerData?: Record<string, unknown>,
): FixtureBubble {
  return {
    id,
    value: {
      type: 2,
      text,
      ...(toolFormerData === undefined ? {} : { toolFormerData }),
    },
  };
}

function tool(name: string, params: string): Record<string, unknown> {
  return { name, params };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
