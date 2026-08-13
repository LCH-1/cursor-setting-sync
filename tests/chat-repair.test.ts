import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditChatContinuationRoots,
  auditChatReferences,
  buildChatRepairSnapshot,
  inspectBrokenChatContinuationsInDatabase,
  inspectBrokenChatsInDatabase,
} from "../src/chat/repair";
import type {
  PortableChatSnapshot,
  PortableKvRow,
} from "../src/chat/stateVscdb";
import { isSyntheticTip } from "../src/sync/versionPolicy";
import type { ResourceTip } from "../src/types";
import { canonicalBytes, sha256 } from "../src/protocol/canonical";

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

  it("refuses hostile composer and bubble JSON before parsing their decoded graphs", () => {
    const hostile = hostileStructuralJson();
    expect(Buffer.byteLength(hostile, "utf8")).toBeLessThan(1024 * 1024);
    const parse = vi.spyOn(JSON, "parse");
    try {
      const composerHostile = chat([], []);
      composerHostile.composerData = jsonRow(
        `composerData:${COMPOSER}`,
        hostile,
      );
      expect(auditChatReferences(composerHostile)).toEqual({
        status: "unknown",
        reason: "chat row JSON structural work limit was reached",
      });

      const bubbleHostile = chat(["hostile"], [
        jsonRow(`bubbleId:${COMPOSER}:hostile`, hostile),
      ]);
      expect(auditChatReferences(bubbleHostile)).toEqual({
        status: "unknown",
        reason: "chat row JSON structural work limit was reached",
      });
      expect(
        parse.mock.calls.filter(([input]) => input === hostile),
      ).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
  });

  it("treats a hostile referenced SQLite bubble as unknown without damage", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-structure-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "hostile-bubble.vscdb"));
    createSchema(database);
    insertHeader(database, COMPOSER, JSON.stringify({ name: "Bounded" }));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${COMPOSER}`,
        JSON.stringify({
          fullConversationHeadersOnly: [{ bubbleId: "hostile" }],
        }),
      );
    const hostile = hostileStructuralJson();
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${COMPOSER}:hostile`, hostile);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(inspectBrokenChatsInDatabase(database)).toMatchObject({
        examinedChats: 1,
        limitReached: true,
        broken: [],
      });
      expect(
        parse.mock.calls.filter(([input]) => input === hostile),
      ).toHaveLength(0);
    } finally {
      parse.mockRestore();
      database.close();
    }
  });

  it("does not let one hostile newest chat starve an older repairable chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-starvation-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "starvation.vscdb"));
    createSchema(database);
    const hostileComposer = "99999999-9999-4999-8999-999999999999";
    insertHeader(database, hostileComposer, "{}", 100);
    const hostile = hostileStructuralJson();
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`composerData:${hostileComposer}`, hostile);
    insertHeader(database, COMPOSER, JSON.stringify({ name: "Repairable" }), 1);
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${COMPOSER}`,
        JSON.stringify({
          fullConversationHeadersOnly: [{ bubbleId: "missing" }],
        }),
      );

    const parse = vi.spyOn(JSON, "parse");
    try {
      const inspection = inspectBrokenChatsInDatabase(database);

      expect(inspection).toMatchObject({
        examinedChats: 1,
        limitReached: true,
      });
      expect(inspection.broken.map((item) => item.composerId)).toEqual([COMPOSER]);
      expect(
        parse.mock.calls.filter(([input]) => input === hostile),
      ).toHaveLength(0);
    } finally {
      parse.mockRestore();
      database.close();
    }
  });

  it("bounds aggregate JSON structure across many referenced portable rows", () => {
    const unit = smallStructuralJson();
    const ids = Array.from(
      { length: 88 },
      (_unused, index) => `aggregate-${index.toString().padStart(3, "0")}`,
    );
    const snapshot = chat(
      ids,
      ids.map((id) => jsonRow(`bubbleId:${COMPOSER}:${id}`, unit)),
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(auditChatReferences(snapshot)).toEqual({
        status: "unknown",
        reason: "chat row JSON structural work limit was reached",
      });
      const parsedUnits = parse.mock.calls.filter(([input]) => input === unit);
      expect(parsedUnits.length).toBeGreaterThan(0);
      expect(parsedUnits.length).toBeLessThan(ids.length);
    } finally {
      parse.mockRestore();
    }
  });

  it("bounds aggregate JSON structure across many referenced SQLite rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-aggregate-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "aggregate.vscdb"));
    createSchema(database);
    insertHeader(database, COMPOSER, JSON.stringify({ name: "Aggregate" }));
    const ids = Array.from(
      { length: 88 },
      (_unused, index) => `aggregate-${index.toString().padStart(3, "0")}`,
    );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${COMPOSER}`,
        JSON.stringify({
          fullConversationHeadersOnly: ids.map((bubbleId) => ({ bubbleId })),
        }),
      );
    const insert = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
    );
    const unit = smallStructuralJson();
    database.exec("BEGIN");
    for (const id of ids) {
      insert.run(`bubbleId:${COMPOSER}:${id}`, unit);
    }
    database.exec("COMMIT");

    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(inspectBrokenChatsInDatabase(database)).toMatchObject({
        examinedChats: 1,
        limitReached: true,
        broken: [],
      });
      const parsedUnits = parse.mock.calls.filter(([input]) => input === unit);
      expect(parsedUnits.length).toBeGreaterThan(0);
      expect(parsedUnits.length).toBeLessThan(ids.length);
    } finally {
      parse.mockRestore();
      database.close();
    }
  });

  it("shares the aggregate JSON budget and row cache across repair building", () => {
    const unit = smallStructuralJson();
    const local = chat(
      ["missing"],
      Array.from({ length: 88 }, (_unused, index) =>
        jsonRow(`bubbleId:${COMPOSER}:orphan-${index}`, unit)
      ),
    );
    const recoveryValue = JSON.stringify({ text: "recovered" });
    const source = chat(["missing"], [
      jsonRow(`bubbleId:${COMPOSER}:missing`, recoveryValue),
    ]);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(
        buildChatRepairSnapshot(local, [
          { versionId: "bounded-source#0", snapshot: source },
        ]),
      ).toEqual({
        status: "unavailable",
        reason: "chat row JSON structural work limit was reached",
      });
      expect(
        parse.mock.calls.filter(([input]) => input === recoveryValue),
      ).toHaveLength(1);
      const parsedUnits = parse.mock.calls.filter(([input]) => input === unit);
      expect(parsedUnits.length).toBeGreaterThan(0);
      expect(parsedUnits.length).toBeLessThan(local.bubbles.length);
    } finally {
      parse.mockRestore();
    }
  });

  it("parses one repeated recovery row only once across a successful build", () => {
    const local = chat(["missing"], []);
    const recoveryValue = JSON.stringify({ text: "recovered once" });
    const source = chat(["missing"], [
      jsonRow(`bubbleId:${COMPOSER}:missing`, recoveryValue),
    ]);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(
        buildChatRepairSnapshot(local, [
          { versionId: "cached-source#0", snapshot: source },
        ]).status,
      ).toBe("repairable");
      expect(
        parse.mock.calls.filter(([input]) => input === recoveryValue),
      ).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
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

  it("bounds retained damaged snapshots while reporting every deferred large chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-bounded-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "bounded.vscdb"));
    createSchema(database);
    const composerIds = Array.from(
      { length: 6 },
      (_unused, index) =>
        `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    for (const [index, composerId] of composerIds.entries()) {
      insertHeader(
        database,
        composerId,
        JSON.stringify(index === 5 ? {} : { name: `Damaged ${index}` }),
        100 + index,
      );
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(
          `composerData:${composerId}`,
          JSON.stringify({
            ...(index === 5 ? { name: "Composer data fallback" } : {}),
            fullConversationHeadersOnly: [
              { bubbleId: `present-${index}` },
              { bubbleId: `missing-${index}` },
            ],
          }),
        );
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(
          `bubbleId:${composerId}:present-${index}`,
          JSON.stringify({
            text: `${index}:${"x".repeat(256 * 1024)}`,
          }),
        );
    }

    const countBounded = inspectBrokenChatsInDatabase(database, {
      limits: {
        maxRetainedChats: 2,
        maxRetainedBytes: 8 * 1024 * 1024,
      },
    });

    expect(countBounded).toMatchObject({
      examinedChats: 6,
      deferredBrokenChats: 4,
      limitReached: true,
    });
    expect(countBounded.broken.map((item) => item.composerId)).toEqual([
      composerIds[5],
      composerIds[4],
    ]);
    expect(countBounded.retainedSnapshotBytes).toBe(
      countBounded.broken.reduce(
        (total, item) => total + canonicalBytes(item.snapshot).byteLength,
        0,
      ),
    );
    expect(countBounded.retainedSnapshotBytes).toBeLessThanOrEqual(
      8 * 1024 * 1024,
    );

    const byteBounded = inspectBrokenChatsInDatabase(database, {
      limits: { maxRetainedChats: 6, maxRetainedBytes: 450 * 1024 },
    });

    expect(byteBounded).toMatchObject({
      examinedChats: 6,
      deferredBrokenChats: 5,
      limitReached: true,
    });
    expect(byteBounded.broken.map((item) => item.composerId)).toEqual([
      composerIds[5],
    ]);
    expect(byteBounded.retainedSnapshotBytes).toBeGreaterThan(1);
    const onlyRetained = byteBounded.broken[0];
    if (onlyRetained === undefined) {
      throw new Error("Expected the newest large damaged chat to be retained.");
    }
    expect(byteBounded.retainedSnapshotBytes).toBe(
      canonicalBytes(onlyRetained.snapshot).byteLength,
    );
    expect(byteBounded.retainedSnapshotBytes).toBeLessThanOrEqual(450 * 1024);

    const targeted = inspectBrokenChatsInDatabase(database, {
      resourceIds: new Set([`chat/${composerIds[2]}`]),
      limits: { maxRetainedChats: 1, maxRetainedBytes: 450 * 1024 },
    });
    expect(targeted).toMatchObject({
      examinedChats: 1,
      deferredBrokenChats: 0,
      limitReached: false,
    });
    expect(targeted.broken.map((item) => item.composerId)).toEqual([
      composerIds[2],
    ]);

    const preparedSql: string[] = [];
    const originalPrepare = database.prepare.bind(database);
    const prepareSpy = vi.spyOn(database, "prepare").mockImplementation((sql) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    });
    const firstPage = inspectBrokenChatsInDatabase(database, {
      pageAtRetentionLimit: true,
      limits: { maxRetainedChats: 2, maxRetainedBytes: 8 * 1024 * 1024 },
    });
    const firstPageSql = preparedSql.find((sql) =>
      sql.includes("FROM composerHeaders h"),
    );
    if (firstPageSql === undefined) {
      throw new Error("Expected the paged composer inspection query.");
    }
    const firstPlan = database
      .prepare(`EXPLAIN QUERY PLAN ${firstPageSql}`)
      .all()
      .map((row) => String(row.detail))
      .join("\n");
    expect(firstPlan).toContain("composerHeaders_1");
    expect(firstPlan).not.toContain("TEMP B-TREE");
    expect(firstPage.broken.map((item) => item.composerId)).toEqual([
      composerIds[0],
      composerIds[1],
    ]);
    expect(firstPage.deferredBrokenChats).toBe(1);
    expect(firstPage.resumeAfter).toEqual({
      composerId: composerIds[1],
    });

    preparedSql.length = 0;
    const secondPage = inspectBrokenChatsInDatabase(database, {
      ...(firstPage.resumeAfter === null
        ? {}
        : { after: firstPage.resumeAfter }),
      pageAtRetentionLimit: true,
      limits: { maxRetainedChats: 2, maxRetainedBytes: 8 * 1024 * 1024 },
    });
    const secondPageSql = preparedSql.find((sql) =>
      sql.includes("FROM composerHeaders h"),
    );
    if (secondPageSql === undefined || firstPage.resumeAfter === null) {
      throw new Error("Expected the resumed composer inspection query.");
    }
    const secondPlan = database
      .prepare(`EXPLAIN QUERY PLAN ${secondPageSql}`)
      .all(firstPage.resumeAfter.composerId)
      .map((row) => String(row.detail))
      .join("\n");
    expect(secondPlan).toContain("composerHeaders_1 (composerId>?)");
    expect(secondPlan).not.toContain("TEMP B-TREE");
    expect(secondPage.broken.map((item) => item.composerId)).toEqual([
      composerIds[2],
      composerIds[3],
    ]);
    expect(secondPage.resumeAfter).toEqual({
      composerId: composerIds[3],
    });

    prepareSpy.mockRestore();
    const finalPage = inspectBrokenChatsInDatabase(database, {
      ...(secondPage.resumeAfter === null
        ? {}
        : { after: secondPage.resumeAfter }),
      pageAtRetentionLimit: true,
      limits: { maxRetainedChats: 2, maxRetainedBytes: 8 * 1024 * 1024 },
    });
    expect(finalPage.broken.map((item) => item.composerId)).toEqual([
      composerIds[4],
      composerIds[5],
    ]);
    expect(finalPage.broken[1]?.title).toBe("Composer data fallback");
    expect(finalPage.resumeAfter).toBeNull();
    expect(finalPage.scannedThrough).toEqual({
      composerId: composerIds[5],
    });
    database.close();
  });

  it("keeps an exact BLOB composer primary key while paging", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-blob-page-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "blob-page.vscdb"));
    createSchema(database);
    const textComposer = "20000000-0000-4000-8000-000000000001";
    const blobComposer = "20000000-0000-4000-8000-000000000002";
    insertHeader(database, textComposer, JSON.stringify({ name: "Text" }));
    database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, 'workspace', 1, 2, 0, 0, 0, NULL, ?)`,
      )
      .run(Buffer.from(blobComposer), JSON.stringify({ name: "Blob" }));
    for (const composerId of [textComposer, blobComposer]) {
      database
        .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
        .run(
          `composerData:${composerId}`,
          JSON.stringify({
            fullConversationHeadersOnly: [{ bubbleId: "missing" }],
          }),
        );
    }

    const first = inspectBrokenChatsInDatabase(database, {
      pageAtRetentionLimit: true,
      limits: { maxRetainedChats: 1, maxRetainedBytes: 1024 * 1024 },
    });
    expect(first.broken.map((item) => item.composerId)).toEqual([textComposer]);
    expect(first.resumeAfter).toEqual({ composerId: textComposer });
    if (first.resumeAfter === null) {
      throw new Error("Expected a keyset cursor before the BLOB composer.");
    }

    const second = inspectBrokenChatsInDatabase(database, {
      after: first.resumeAfter,
      pageAtRetentionLimit: true,
      limits: { maxRetainedChats: 1, maxRetainedBytes: 1024 * 1024 },
    });
    expect(second.broken.map((item) => item.composerId)).toEqual([blobComposer]);
    expect(second.resumeAfter).toBeNull();
    const blobCursor = second.scannedThrough?.composerId;
    expect(blobCursor).toBeInstanceOf(Uint8Array);
    if (!(blobCursor instanceof Uint8Array)) {
      throw new Error("Expected the exact BLOB primary-key cursor.");
    }
    expect(Buffer.from(blobCursor).toString("utf8")).toBe(blobComposer);

    const terminal = inspectBrokenChatsInDatabase(database, {
      after: { composerId: blobCursor },
      pageAtRetentionLimit: true,
      limits: { maxRetainedChats: 1, maxRetainedBytes: 1024 * 1024 },
    });
    expect(terminal.broken).toEqual([]);
    expect(terminal.resumeAfter).toBeNull();
    database.close();
  });

  it("defers a hard-oversized damaged chat from SQLite length metadata without selecting bubble values", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-preflight-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "preflight.vscdb"));
    createSchema(database);
    insertHeader(database, COMPOSER, JSON.stringify({ name: "Too large" }));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${COMPOSER}`,
        JSON.stringify({
          fullConversationHeadersOnly: [{ bubbleId: "missing" }],
        }),
      );
    database
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(?))",
      )
      .run(`bubbleId:${COMPOSER}:oversized-orphan`, 4 * 1024);

    let bubbleValueRangeSelects = 0;
    let bubbleValueAllCalls = 0;
    let unguardedComposerDataSelects = 0;
    const observedDatabase: DatabaseSync = new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (/d\.value\s+AS\s+value/iu.test(sql)) {
              unguardedComposerDataSelects += 1;
            }
            const statement = target.prepare(sql);
            if (
              /SELECT\s+key,\s*value,\s*typeof\(value\)/iu.test(sql) &&
              sql.includes("key >= ?")
            ) {
              bubbleValueRangeSelects += 1;
              return new Proxy(statement, {
                get(statementTarget, statementProperty) {
                  const value = Reflect.get(
                    statementTarget,
                    statementProperty,
                    statementTarget,
                  ) as unknown;
                  if (statementProperty === "all" && typeof value === "function") {
                    return (...args: unknown[]) => {
                      bubbleValueAllCalls += 1;
                      return (value as (...values: unknown[]) => unknown)(...args);
                    };
                  }
                  return typeof value === "function"
                    ? (...args: unknown[]) =>
                        (value as (...values: unknown[]) => unknown).apply(
                          statementTarget,
                          args,
                        )
                    : value;
                },
              });
            }
            return statement;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function"
          ? (...args: unknown[]) =>
              (value as (...values: unknown[]) => unknown).apply(target, args)
          : value;
      },
    });

    const inspection = inspectBrokenChatsInDatabase(observedDatabase, {
      limits: { maxRetainedChats: 8, maxRetainedBytes: 1024 },
    });

    expect(inspection).toMatchObject({
      examinedChats: 1,
      retainedSnapshotBytes: 0,
      deferredBrokenChats: 0,
      oversizedChats: 1,
      snapshotByteLimit: 1024,
      limitReached: true,
      broken: [],
    });
    expect(bubbleValueRangeSelects).toBe(0);
    expect(bubbleValueAllCalls).toBe(0);
    expect(unguardedComposerDataSelects).toBe(0);
    database.close();
  });

  it("does not classify a healthy chat with a huge inert orphan as damaged or oversized", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-orphan-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "healthy-orphan.vscdb"));
    createSchema(database);
    insertHeader(database, COMPOSER, JSON.stringify({ name: "Healthy" }));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${COMPOSER}`,
        JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "a" }] }),
      );
    const insert = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
    );
    insert.run(`bubbleId:${COMPOSER}:a`, JSON.stringify({ text: "healthy" }));
    database
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(?))",
      )
      .run(`bubbleId:${COMPOSER}:orphan`, 4 * 1024);

    const inspection = inspectBrokenChatsInDatabase(database, {
      limits: { maxRetainedChats: 8, maxRetainedBytes: 1024 },
    });

    expect(inspection).toMatchObject({
      examinedChats: 1,
      retainedSnapshotBytes: 0,
      deferredBrokenChats: 0,
      oversizedChats: 0,
      snapshotByteLimit: 1024,
      limitReached: false,
      broken: [],
    });
    database.close();
  });

  it("treats oversized composerData as bounded unknown without claiming bubble damage", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-composer-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "huge-composer.vscdb"));
    createSchema(database);
    insertHeader(database, COMPOSER, JSON.stringify({ name: "Unknown" }));
    database
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(?))",
      )
      .run(`composerData:${COMPOSER}`, 4 * 1024);

    const inspection = inspectBrokenChatsInDatabase(database, {
      limits: { maxRetainedChats: 8, maxRetainedBytes: 1024 },
    });

    expect(inspection).toMatchObject({
      examinedChats: 0,
      retainedSnapshotBytes: 0,
      deferredBrokenChats: 0,
      oversizedChats: 0,
      snapshotByteLimit: 1024,
      limitReached: false,
      broken: [],
    });
    database.close();
  });

  it("guards oversized header value and workspace text before a damaged snapshot is materialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-header-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "huge-header.vscdb"));
    createSchema(database);
    const hugeValueComposer = "33333333-3333-4333-8333-333333333333";
    const hugeWorkspaceComposer = "44444444-4444-4444-8444-444444444444";
    const aggregateComposer = "55555555-5555-4555-8555-555555555555";
    insertHeader(database, hugeValueComposer, "x".repeat(4 * 1024), 20);
    database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, ?, 1, 10, 0, 0, 0, NULL, '{}')`,
      )
      .run(hugeWorkspaceComposer, "w".repeat(4 * 1024));
    database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, ?, 1, 5, 0, 0, 0, NULL, ?)`,
      )
      .run(aggregateComposer, "w".repeat(600), "x".repeat(600));
    const insert = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
    );
    for (const composerId of [
      hugeValueComposer,
      hugeWorkspaceComposer,
      aggregateComposer,
    ]) {
      insert.run(
        `composerData:${composerId}`,
        JSON.stringify({
          fullConversationHeadersOnly: [{ bubbleId: "missing" }],
        }),
      );
    }

    let unguardedHeaderReads = 0;
    let guardedHeaderValueReads = 0;
    const observedDatabase: DatabaseSync = new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (
              /checkpointAt,\s*value\s+FROM\s+composerHeaders/iu.test(sql)
            ) {
              unguardedHeaderReads += 1;
            }
            const statement = target.prepare(sql);
            if (
              sql.includes("END AS workspaceId") &&
              sql.includes("END AS value") &&
              sql.includes("FROM composerHeaders")
            ) {
              return new Proxy(statement, {
                get(statementTarget, statementProperty) {
                  const value = Reflect.get(
                    statementTarget,
                    statementProperty,
                    statementTarget,
                  ) as unknown;
                  if (statementProperty === "get" && typeof value === "function") {
                    return (...args: unknown[]) => {
                      guardedHeaderValueReads += 1;
                      return (value as (...values: unknown[]) => unknown)(...args);
                    };
                  }
                  return typeof value === "function"
                    ? (...args: unknown[]) =>
                        (value as (...values: unknown[]) => unknown).apply(
                          statementTarget,
                          args,
                        )
                    : value;
                },
              });
            }
            return statement;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function"
          ? (...args: unknown[]) =>
              (value as (...values: unknown[]) => unknown).apply(target, args)
          : value;
      },
    });

    const inspection = inspectBrokenChatsInDatabase(observedDatabase, {
      limits: { maxRetainedChats: 8, maxRetainedBytes: 1024 },
    });

    expect(inspection).toMatchObject({
      examinedChats: 3,
      retainedSnapshotBytes: 0,
      deferredBrokenChats: 0,
      oversizedChats: 3,
      snapshotByteLimit: 1024,
      limitReached: true,
      broken: [],
    });
    expect(unguardedHeaderReads).toBe(0);
    expect(guardedHeaderValueReads).toBe(0);
    database.close();
  });

  it("reports a referenced over-limit bubble as bounded unknown instead of healthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-repair-ref-limit-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "huge-reference.vscdb"));
    createSchema(database);
    insertHeader(database, COMPOSER, JSON.stringify({ name: "Unknown" }));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${COMPOSER}`,
        JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "a" }] }),
      );
    database
      .prepare(
        "INSERT INTO cursorDiskKV(key, value) VALUES (?, zeroblob(?))",
      )
      .run(`bubbleId:${COMPOSER}:a`, 4 * 1024);

    const inspection = inspectBrokenChatsInDatabase(database, {
      limits: { maxRetainedChats: 8, maxRetainedBytes: 1024 },
    });

    expect(inspection).toMatchObject({
      examinedChats: 1,
      retainedSnapshotBytes: 0,
      deferredBrokenChats: 0,
      oversizedChats: 0,
      snapshotByteLimit: 1024,
      limitReached: true,
      broken: [],
    });
    database.close();
  });

  it("finds an affected-style continuation with many roots and most absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-agentkv-missing-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "missing-roots.vscdb"));
    createSchema(database);
    const leaves = generatedGraphLeaves("affected", 106);
    const ids = leaves.map((leaf) => leaf.id);
    insertChatWithConversationState(
      database,
      COMPOSER,
      "Continuation damaged",
      serializedConversationState(ids),
    );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${ids[0]}`, leaves[0]!.bytes);

    const inspection = await inspectBrokenChatContinuationsInDatabase(database);

    expect(inspection).toMatchObject({
      examinedChats: 1,
      auditedChats: 1,
      unknownChats: 0,
      probedRootCount: 106,
      limitReached: false,
    });
    expect(inspection.broken).toHaveLength(1);
    const observation = inspection.broken[0];
    expect(observation).toMatchObject({
      resourceId: `chat/${COMPOSER}`,
      composerId: COMPOSER,
      title: "Continuation damaged",
      workspaceId: "workspace",
      conversationStateCount: 1,
      referencedRootCount: 106,
      unavailableRootCount: 105,
    });
    expect(observation?.unavailableRootIds).toEqual(ids.slice(1));
    expect(observation?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (await inspectBrokenChatContinuationsInDatabase(database)).broken[0]
        ?.fingerprint,
    ).toBe(observation?.fingerprint);

    const otherComposer = "22222222-2222-4222-8222-222222222222";
    insertChatWithConversationState(
      database,
      otherComposer,
      "Other damaged continuation",
      serializedConversationState(["f".repeat(64)]),
    );
    const preparedSql: string[] = [];
    const originalPrepare = database.prepare.bind(database);
    const prepareSpy = vi.spyOn(database, "prepare").mockImplementation((sql) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    });
    const scoped = await inspectBrokenChatContinuationsInDatabase(database, {
      composerIds: new Set([COMPOSER]),
    });
    prepareSpy.mockRestore();
    expect(scoped.examinedChats).toBe(1);
    expect(scoped.broken.map((item) => item.composerId)).toEqual([COMPOSER]);
    const scopedSql = preparedSql.find((sql) =>
      sql.includes("FROM composerHeaders h"),
    );
    expect(scopedSql).toContain("h.composerId = ?");
    expect(scopedSql).not.toContain("ORDER BY");
    if (scopedSql === undefined) {
      throw new Error("Expected the scoped continuation query.");
    }
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${scopedSql}`)
      .all(COMPOSER)
      .map((row) => String(row.detail))
      .join("\n");
    expect(plan).toContain("composerHeaders_1 (composerId=?)");
    expect(plan).not.toContain("TEMP B-TREE");
    database.close();
  });

  it("treats hash-valid text and blob root storage as a healthy continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-agentkv-healthy-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "healthy-roots.vscdb"));
    createSchema(database);
    const leaves = generatedGraphLeaves("healthy", 2);
    const ids = leaves.map((leaf) => leaf.id);
    insertChatWithConversationState(
      database,
      COMPOSER,
      "Healthy",
      serializedConversationState(ids),
    );
    const insert = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
    );
    insert.run(
      `agentKv:blob:${ids[0]}`,
      leaves[0]!.bytes.toString("utf8"),
    );
    insert.run(`agentKv:blob:${ids[1]}`, leaves[1]!.bytes);

    const inspection = await inspectBrokenChatContinuationsInDatabase(database);

    expect(inspection).toMatchObject({
      examinedChats: 1,
      auditedChats: 1,
      unknownChats: 0,
      probedRootCount: 2,
      limitReached: false,
      broken: [],
    });
    database.close();
  });

  it("flags a present root whose bytes do not match its content ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-agentkv-corrupt-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "corrupt-root.vscdb"));
    createSchema(database);
    const expected = Buffer.from("leaf:expected", "utf8");
    const rootId = sha256(expected);
    insertChatWithConversationState(
      database,
      COMPOSER,
      "Hash corrupt",
      serializedConversationState([rootId]),
    );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${rootId}`, Buffer.from("leaf:tampered", "utf8"));

    const inspection = await inspectBrokenChatContinuationsInDatabase(database);

    expect(inspection).toMatchObject({
      examinedChats: 1,
      auditedChats: 1,
      unknownChats: 0,
      probedRootCount: 1,
      limitReached: false,
    });
    expect(inspection.broken[0]).toMatchObject({
      referencedRootCount: 1,
      unavailableRootCount: 1,
      unavailableRootIds: [rootId],
    });
    database.close();
  });

  it("walks a hash-valid root and flags its missing descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-agentkv-child-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "missing-child.vscdb"));
    createSchema(database);
    const childBytes = Buffer.from("leaf:missing-child", "utf8");
    const childId = sha256(childBytes);
    const rootBytes = protobufIds([childId]);
    const rootId = sha256(rootBytes);
    insertChatWithConversationState(
      database,
      COMPOSER,
      "Missing descendant",
      serializedConversationState([rootId]),
    );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${rootId}`, rootBytes);

    const inspection = await inspectBrokenChatContinuationsInDatabase(database);

    expect(inspection).toMatchObject({
      examinedChats: 1,
      auditedChats: 1,
      unknownChats: 0,
      probedRootCount: 2,
      limitReached: false,
    });
    expect(inspection.broken[0]).toMatchObject({
      referencedRootCount: 2,
      unavailableRootCount: 1,
      unavailableRootIds: [childId],
    });
    database.close();
  });

  it("counts an unreadable reachable row as unavailable rather than healthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-agentkv-unreadable-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "unreadable-child.vscdb"));
    createSchema(database);
    const childBytes = Buffer.from("leaf:unreadable-child", "utf8");
    const childId = sha256(childBytes);
    const rootBytes = protobufIds([childId]);
    const rootId = sha256(rootBytes);
    insertChatWithConversationState(
      database,
      COMPOSER,
      "Unreadable descendant",
      serializedConversationState([rootId]),
    );
    const insert = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
    );
    insert.run(`agentKv:blob:${rootId}`, rootBytes);
    insert.run(`agentKv:blob:${childId}`, 42);

    const inspection = await inspectBrokenChatContinuationsInDatabase(database);

    expect(inspection).toMatchObject({
      auditedChats: 1,
      unknownChats: 0,
      probedRootCount: 2,
      limitReached: false,
    });
    expect(inspection.broken[0]).toMatchObject({
      unavailableRootCount: 1,
      unavailableRootIds: [childId],
    });
    database.close();
  });

  it("does not misclassify an invalid or absent conversationState as damage", async () => {
    const invalid = chat([], [], {
      conversationState: "~not canonical base64",
    });
    let probes = 0;

    const invalidAudit = await auditChatContinuationRoots(invalid, () => {
      probes += 1;
      return { status: "missing" };
    });
    const absentAudit = await auditChatContinuationRoots(chat([], []), () => {
      probes += 1;
      return { status: "missing" };
    });

    expect(invalidAudit).toMatchObject({
      status: "unknown",
      reason: "conversation-state-unreadable",
      probedRootCount: 0,
    });
    expect(absentAudit).toMatchObject({
      status: "known",
      referencedRootIds: [],
      unavailableRootIds: [],
      probedRootCount: 0,
    });
    expect(probes).toBe(0);
  });

  it("reports structurally hostile decoded conversation JSON as unknown", async () => {
    const hostile = chat([], []);
    let nested = "0";
    for (let depth = 0; depth < 257; depth += 1) {
      nested = `[${nested}]`;
    }
    hostile.composerData = {
      key: `composerData:${COMPOSER}`,
      valueBase64: Buffer.from(nested, "utf8").toString("base64"),
      valueType: "text",
    };
    let probes = 0;

    const audit = await auditChatContinuationRoots(hostile, () => {
      probes += 1;
      return { status: "missing" };
    });

    expect(audit).toMatchObject({
      status: "unknown",
      reason: "conversation-state-json-structure-limit",
      probedRootCount: 0,
    });
    expect(probes).toBe(0);
  });

  it("prioritizes the most recent chat and never partially probes the next budgeted chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-agentkv-bounded-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "bounded-roots.vscdb"));
    createSchema(database);
    const firstComposer = "00000000-0000-4000-8000-000000000000";
    const firstLeaves = generatedGraphLeaves("first", 3);
    const secondLeaves = generatedGraphLeaves("second", 3);
    const firstIds = firstLeaves.map((leaf) => leaf.id);
    const secondIds = secondLeaves.map((leaf) => leaf.id);
    insertChatWithConversationState(
      database,
      firstComposer,
      "Older",
      serializedConversationState(firstIds),
      1,
    );
    insertChatWithConversationState(
      database,
      COMPOSER,
      "Recently failed",
      serializedConversationState(secondIds),
      100,
    );
    const insert = database.prepare(
      "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
    );
    // Only the recent conversation is healthy. With composer-ID ordering the
    // older missing-root chat would consume the budget and be misreported;
    // recency ordering audits the conversation the user just tried first.
    for (const leaf of secondLeaves) {
      insert.run(`agentKv:blob:${leaf.id}`, leaf.bytes);
    }

    const inspection = await inspectBrokenChatContinuationsInDatabase(database, {
      limits: { maxRootProbes: 4 },
    });

    expect(inspection).toEqual({
      examinedChats: 2,
      auditedChats: 1,
      unknownChats: 1,
      probedRootCount: 3,
      limitReached: true,
      broken: [],
    });
    database.close();
  });

  it("reports an oversized graph row as bounded unknown without reading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-agentkv-byte-bound-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "byte-bound.vscdb"));
    createSchema(database);
    const bytes = Buffer.alloc(4096, 0x6c);
    const rootId = sha256(bytes);
    const conversationState = serializedConversationState([rootId]);
    insertChatWithConversationState(
      database,
      COMPOSER,
      "Oversized graph",
      conversationState,
    );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`agentKv:blob:${rootId}`, bytes);
    const seedBytes = Buffer.from(conversationState.slice(1), "base64").length;

    const inspection = await inspectBrokenChatContinuationsInDatabase(database, {
      limits: { maxSeedBytesPerChat: seedBytes + 16 },
    });

    expect(inspection).toEqual({
      examinedChats: 1,
      auditedChats: 0,
      unknownChats: 1,
      probedRootCount: 1,
      limitReached: true,
      broken: [],
    });
    database.close();
  });

  it("rejects an escape-expanded continuation header before selecting bubble values", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-chat-header-escape-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "header-escape.vscdb"));
    createSchema(database);
    insertHeader(database, COMPOSER, "\u0000".repeat(300));
    const aggregateComposer = "88888888-8888-4888-8888-888888888888";
    database
      .prepare(
        `INSERT INTO composerHeaders(
          composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
          isSubagent, recency, checkpointAt, value
        ) VALUES (?, ?, 1, 1, 0, 0, 0, NULL, ?)`,
      )
      .run(aggregateComposer, "w".repeat(600), "x".repeat(600));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${COMPOSER}`,
        JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "a" }] }),
      );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `composerData:${aggregateComposer}`,
        JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "a" }] }),
      );
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(`bubbleId:${COMPOSER}:a`, JSON.stringify({ text: "healthy" }));
    database
      .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
      .run(
        `bubbleId:${aggregateComposer}:a`,
        JSON.stringify({ text: "healthy" }),
      );

    let bubbleValueRangeSelects = 0;
    let guardedHeaderValueReads = 0;
    const observedDatabase: DatabaseSync = new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (
              /SELECT\s+key,\s*value,\s*typeof\(value\)/iu.test(sql) &&
              sql.includes("key >= ?")
            ) {
              bubbleValueRangeSelects += 1;
            }
            const statement = target.prepare(sql);
            if (
              sql.includes("END AS workspaceId") &&
              sql.includes("END AS value") &&
              sql.includes("FROM composerHeaders")
            ) {
              return new Proxy(statement, {
                get(statementTarget, statementProperty) {
                  const value = Reflect.get(
                    statementTarget,
                    statementProperty,
                    statementTarget,
                  ) as unknown;
                  if (statementProperty === "get" && typeof value === "function") {
                    return (...args: unknown[]) => {
                      guardedHeaderValueReads += 1;
                      return (value as (...values: unknown[]) => unknown)(...args);
                    };
                  }
                  return typeof value === "function"
                    ? (...args: unknown[]) =>
                        (value as (...values: unknown[]) => unknown).apply(
                          statementTarget,
                          args,
                        )
                    : value;
                },
              });
            }
            return statement;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function"
          ? (...args: unknown[]) =>
              (value as (...values: unknown[]) => unknown).apply(target, args)
          : value;
      },
    });

    const inspection = await inspectBrokenChatContinuationsInDatabase(
      observedDatabase,
      { limits: { maxSnapshotBytesPerChat: 1024 } },
    );

    expect(inspection).toMatchObject({
      examinedChats: 2,
      auditedChats: 0,
      unknownChats: 2,
      probedRootCount: 0,
      limitReached: true,
      broken: [],
    });
    expect(bubbleValueRangeSelects).toBe(0);
    expect(guardedHeaderValueReads).toBe(1);
    database.close();
  });
});

function chat(
  references: string[],
  bubbles: PortableKvRow[],
  options: {
    title?: string;
    recency?: number;
    conversationState?: string;
  } = {},
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
      {
        fullConversationHeadersOnly: references.map((bubbleId) => ({ bubbleId })),
        ...(options.conversationState === undefined
          ? {}
          : { conversationState: options.conversationState }),
      },
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

function hostileStructuralJson(): string {
  return `[${Array.from({ length: 87_400 }, () => "{}").join(",")}]`;
}

function smallStructuralJson(): string {
  return `[${Array.from({ length: 1_000 }, () => "{}").join(",")}]`;
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

function insertHeader(
  database: DatabaseSync,
  composerId: string,
  value: string,
  lastUpdatedAt = 2,
): void {
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, ?, 1, ?, 0, 0, 0, NULL, ?)`,
    )
    .run(composerId, "workspace", lastUpdatedAt, value);
}

function insertChatWithConversationState(
  database: DatabaseSync,
  composerId: string,
  title: string,
  conversationState: string,
  lastUpdatedAt = 2,
): void {
  insertHeader(
    database,
    composerId,
    JSON.stringify({ name: title }),
    lastUpdatedAt,
  );
  database
    .prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)")
    .run(
      `composerData:${composerId}`,
      JSON.stringify({
        fullConversationHeadersOnly: [],
        conversationState,
      }),
    );
}

function generatedGraphLeaves(
  label: string,
  count: number,
): Array<{ id: string; bytes: Buffer }> {
  return Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.from(`leaf:${label}:${index}`, "utf8");
    return { id: sha256(bytes), bytes };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function serializedConversationState(ids: readonly string[]): string {
  return `~${protobufIds(ids).toString("base64")}`;
}

function protobufIds(ids: readonly string[]): Buffer {
  return Buffer.concat(
    ids.map((id) =>
      Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")]),
    ),
  );
}
