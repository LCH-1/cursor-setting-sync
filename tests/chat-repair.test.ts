import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditChatReferences,
  buildChatRepairSnapshot,
  inspectBrokenChatsInDatabase,
} from "../src/chat/repair";
import type {
  PortableChatSnapshot,
  PortableKvRow,
} from "../src/chat/stateVscdb";
import { isSyntheticTip } from "../src/sync/versionPolicy";
import type { ResourceTip } from "../src/types";

const roots: string[] = [];
const COMPOSER = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Cursor chat reference audit", () => {
  it("protects an automatic repair tip from the live scan until helper apply", () => {
    expect(
      isSyntheticTip({
        versionId: `${"0".repeat(64)}#0`,
        eventHash: "0".repeat(64),
        changeIndex: 0,
        kind: "chat",
        lamport: 1,
        deviceId: "device",
        operation: "put",
        semanticHash: "1".repeat(64),
        parents: [],
        metadata: { syncOrigin: "automatic-chat-repair" },
      } satisfies ResourceTip),
    ).toBe(true);
  });

  it("flags only referenced missing or unreadable bubbles", () => {
    const local = chat(["a", "b", "c"], [
      bubble("a", { text: "kept" }),
      bubble("b", ""),
      {
        key: `bubbleId:${COMPOSER}:orphan`,
        valueBase64: Buffer.from("not-json", "utf8").toString("base64"),
        valueType: "text",
      },
    ]);

    const audit = auditChatReferences(local);

    expect(audit.status).toBe("known");
    if (audit.status !== "known") {
      return;
    }
    expect(audit.unavailableBubbleKeys).toEqual([
      `bubbleId:${COMPOSER}:b`,
      `bubbleId:${COMPOSER}:c`,
    ]);
  });

  it("adds recovered rows while preserving the live header, composerData and messages", () => {
    const local = chat(["a", "b"], [bubble("a", { text: "live" })], {
      title: "Live title",
      recency: 99,
    });
    const stored = chat(
      ["a", "b"],
      [bubble("a", { text: "old" }), bubble("b", { text: "recovered" })],
      { title: "Old title", recency: 1 },
    );

    const result = buildChatRepairSnapshot(local, [
      { versionId: "stored#0", snapshot: stored },
    ]);

    expect(result.status).toBe("repairable");
    if (result.status !== "repairable") {
      return;
    }
    expect(result.snapshot.header.value).toBe(JSON.stringify({ name: "Live title" }));
    expect(result.snapshot.header.recency).toBe(99);
    expect(result.snapshot.composerData).toEqual(local.composerData);
    expect(decode(result.snapshot.bubbles.find((row) => row.key.endsWith(":a")))).toEqual({
      text: "live",
    });
    expect(decode(result.snapshot.bubbles.find((row) => row.key.endsWith(":b")))).toEqual({
      text: "recovered",
    });
  });

  it("unions every row from the selected source and newer trusted versions", () => {
    const local = chat(
      ["a", "b"],
      [
        bubble("a", { revision: "live" }),
        bubble("local-orphan", { source: "live" }),
      ],
    );
    const newerPartial = chat(
      ["a", "b"],
      [
        bubble("a", { revision: "newer-trusted" }),
        bubble("shared-orphan", { revision: "newer-trusted" }),
        bubble("newer-orphan", { source: "newer" }),
      ],
    );
    const selectedComplete = chat(
      ["a", "b"],
      [
        bubble("a", { revision: "selected" }),
        bubble("b", { text: "recovered" }),
        bubble("shared-orphan", { revision: "selected" }),
        bubble("selected-orphan", { source: "selected" }),
      ],
    );

    const result = buildChatRepairSnapshot(local, [
      { versionId: "newer#0", snapshot: newerPartial },
      { versionId: "selected#0", snapshot: selectedComplete },
    ]);

    expect(result.status).toBe("repairable");
    if (result.status !== "repairable") {
      return;
    }
    const rows = new Map(
      result.snapshot.bubbles.map((row) => [
        row.key.slice(row.key.lastIndexOf(":") + 1),
        decode(row),
      ]),
    );
    expect(rows).toEqual(
      new Map([
        ["a", { revision: "live" }],
        ["b", { text: "recovered" }],
        ["local-orphan", { source: "live" }],
        ["newer-orphan", { source: "newer" }],
        ["selected-orphan", { source: "selected" }],
        ["shared-orphan", { revision: "newer-trusted" }],
      ]),
    );
    expect(result.snapshot.bubbles.map((row) => row.key)).toEqual(
      [...result.snapshot.bubbles.map((row) => row.key)].sort(),
    );
  });

  it("refuses an older complete source when a newer trusted version disagrees", () => {
    const local = chat(["a", "b"], []);
    const newerPartial = chat(["a", "b"], [bubble("a", { revision: 2 })]);
    const olderComplete = chat(
      ["a", "b"],
      [bubble("a", { revision: 1 }), bubble("b", { revision: 1 })],
    );

    expect(
      buildChatRepairSnapshot(local, [
        { versionId: "newer#0", snapshot: newerPartial },
        { versionId: "older#0", snapshot: olderComplete },
      ]),
    ).toEqual({
      status: "unavailable",
      reason: "trusted versions disagree about an unavailable message",
    });
  });

  it("finds a referenced missing row in TEXT or lossless UTF-8 BLOB composerData", async () => {
    for (const valueType of ["text", "blob"] as const) {
      const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-"));
      roots.push(root);
      const database = new DatabaseSync(join(root, `${valueType}.vscdb`));
      createSchema(database);
      insertHeader(database, COMPOSER, JSON.stringify({ name: "Broken" }));
      const body = JSON.stringify({
        _v: 17,
        fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
      });
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(
          `composerData:${COMPOSER}`,
          valueType === "text" ? body : Buffer.from(body, "utf8"),
        );
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(`bubbleId:${COMPOSER}:a`, JSON.stringify({ text: "present" }));
      // This invalid orphan is irrelevant because composerData never names it.
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(`bubbleId:${COMPOSER}:orphan`, "");
      // A body-less header is a normal Cursor pruning artifact and must not be
      // automatically revived.
      insertHeader(
        database,
        "22222222-2222-4222-8222-222222222222",
        "{}",
      );

      const result = inspectBrokenChatsInDatabase(database);

      expect(result.examinedChats).toBe(1);
      expect(result.broken).toHaveLength(1);
      expect(result.broken[0]?.unavailableBubbleKeys).toEqual([
        `bubbleId:${COMPOSER}:b`,
      ]);
      database.close();
    }
  });

  it("finds a referenced row whose key exists but whose JSON is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-invalid-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "invalid-json.vscdb"));
    createSchema(database);
    insertHeader(database, COMPOSER, JSON.stringify({ name: "Broken" }));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${COMPOSER}`,
        JSON.stringify({
          fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }],
        }),
      );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${COMPOSER}:a`, JSON.stringify({ text: "present" }));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${COMPOSER}:b`, "not-json");

    const result = inspectBrokenChatsInDatabase(database);

    expect(result.examinedChats).toBe(1);
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]?.unavailableBubbleKeys).toEqual([
      `bubbleId:${COMPOSER}:b`,
    ]);
    database.close();
  });

  it("isolates one malformed composer while continuing the database audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-isolation-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "isolation.vscdb"));
    createSchema(database);
    const malformed = "00000000-0000-4000-8000-000000000000";
    insertHeader(database, malformed, "{}");
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${malformed}`, 42);

    insertHeader(database, COMPOSER, JSON.stringify({ name: "Broken" }));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${COMPOSER}`,
        JSON.stringify({
          fullConversationHeadersOnly: [{ bubbleId: "missing" }],
        }),
      );

    const result = inspectBrokenChatsInDatabase(database);

    expect(result.examinedChats).toBe(1);
    expect(result.broken.map((item) => item.composerId)).toEqual([COMPOSER]);
    database.close();
  });
});

function chat(
  references: string[],
  bubbles: PortableKvRow[],
  options: { title?: string; recency?: number } = {},
): PortableChatSnapshot {
  return {
    schemaVersion: 1,
    composerId: COMPOSER,
    header: {
      composerId: COMPOSER,
      workspaceId: "workspace",
      createdAt: 1,
      lastUpdatedAt: 2,
      isArchived: 0,
      isSubagent: 0,
      recency: options.recency ?? 0,
      checkpointAt: null,
      value: JSON.stringify({ name: options.title ?? "Conversation" }),
    },
    composerData: jsonRow(
      `composerData:${COMPOSER}`,
      { fullConversationHeadersOnly: references.map((bubbleId) => ({ bubbleId })) },
    ),
    bubbles,
  };
}

function bubble(id: string, value: unknown): PortableKvRow {
  return jsonRow(`bubbleId:${COMPOSER}:${id}`, value);
}

function jsonRow(key: string, value: unknown): PortableKvRow {
  return {
    key,
    valueBase64: Buffer.from(
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    ).toString("base64"),
    valueType: "text",
  };
}

function decode(row: PortableKvRow | undefined): unknown {
  if (row === undefined) {
    return undefined;
  }
  return JSON.parse(Buffer.from(row.valueBase64, "base64").toString("utf8")) as unknown;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE composerHeaders(
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
    CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value);
  `);
}

function insertHeader(database: DatabaseSync, composerId: string, value: string): void {
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, ?, 1, 2, 0, 0, 0, NULL, ?)`,
    )
    .run(composerId, "workspace", value);
}
