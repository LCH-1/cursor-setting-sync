import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { ChatTranscriptsAdapter } from "../src/chat/transcripts";
import {
  BoundedAuxiliaryOversizedSettlements,
  auxiliaryOversizedObservation,
} from "../src/chat/auxiliaryScan";
import {
  parsePortableStoreSnapshot,
  portableStoreSnapshotCanonicalByteLength,
  portableStoreSnapshotSemanticHash,
  serializePortableStoreSnapshot,
  StoreDbChatAdapter,
  type PortableStoreSnapshot,
} from "../src/chat/storeDb";
import { WorkspaceStorageAdapter } from "../src/resources/workspaceStorage";
import { sha256 } from "../src/protocol/canonical";
import type { CursorPaths } from "../src/platform/paths";
import type { LocalProjection, ResourceSnapshot } from "../src/types";

const roots: string[] = [];
const describeWithSqlite =
  typeof sqlite.DatabaseSync === "function" ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded auxiliary oversized settlements", () => {
  it("caps retained proofs and recovers after a complete stale sweep", () => {
    const settlements = new BoundedAuxiliaryOversizedSettlements(2);
    const observation = (resourceId: string) =>
      auxiliaryOversizedObservation(resourceId, `identity-${resourceId}`, 2, 1);

    settlements.beginGeneration();
    expect(settlements.set("one", observation("one"))).toBe(true);
    expect(settlements.set("two", observation("two"))).toBe(true);
    expect(settlements.set("three", observation("three"))).toBe(false);
    settlements.completeGeneration();
    expect(settlements.values()).toHaveLength(2);
    expect(settlements.overflowed).toBe(true);

    settlements.beginGeneration();
    expect(settlements.get("one")?.resourceId).toBe("one");
    settlements.completeGeneration();
    expect(settlements.values().map((item) => item.resourceId)).toEqual(["one"]);
    expect(settlements.overflowed).toBe(false);

    settlements.beginGeneration();
    expect(settlements.get("one")?.resourceId).toBe("one");
    expect(settlements.set("three", observation("three"))).toBe(true);
    settlements.completeGeneration();
    expect(settlements.values()).toHaveLength(2);
    expect(settlements.overflowed).toBe(false);
  });
});

describe("portable auxiliary parser bounds", () => {
  it("rejects structurally amplified store JSON before parsing it", () => {
    const rows = Array.from({ length: 90_000 }, () => "{}").join(",");
    const content = Buffer.from(
      `{"schemaVersion":1,"relativePath":"chats/a/store.db","meta":[${rows}],"blobs":[]}`,
      "utf8",
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(() => parsePortableStoreSnapshot(content)).toThrow(
        "structural JSON limit",
      );
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});

describe("bounded transcript scans", () => {
  it("settles an oversized sparse transcript before reading it", async () => {
    const paths = await createPaths();
    const transcript = join(
      paths.cursorProjects,
      "project-a",
      "agent-transcripts",
      "session-a",
      "session-a.jsonl",
    );
    await mkdir(join(transcript, ".."), { recursive: true });
    await writeFile(transcript, "");
    await truncate(transcript, 2048);
    let reads = 0;
    const adapter = new ChatTranscriptsAdapter(paths, {
      onFileRead: () => {
        reads += 1;
      },
    });
    adapter.setMaxPayloadBytes(1024);

    const first = await adapter.scan({});
    const second = await adapter.scan({});

    expect(first.snapshots).toEqual([]);
    expect(second.snapshots).toEqual([]);
    expect(reads).toBe(0);
    expect(adapter.scanStatus()).toMatchObject({
      complete: true,
      deferredResourceIds: [],
    });
    expect(adapter.oversizedSnapshotSettlements(1024)).toHaveLength(1);
  });

  it("bounds standing oversized proofs and fails the kind closed on overflow", async () => {
    const paths = await createPaths();
    for (let index = 0; index < 2; index += 1) {
      const transcript = join(
        paths.cursorProjects,
        "project-overflow",
        "agent-transcripts",
        `session-${index}`,
        `session-${index}.jsonl`,
      );
      await mkdir(join(transcript, ".."), { recursive: true });
      await writeFile(transcript, "");
      await truncate(transcript, 2048);
    }
    const adapter = new ChatTranscriptsAdapter(paths, {
      maxOversizedSettlements: 1,
    });
    adapter.setMaxPayloadBytes(1024);

    const result = await adapter.scan({});

    expect(result.snapshots).toEqual([]);
    expect(adapter.oversizedSnapshotSettlements(1024)).toHaveLength(1);
    expect(adapter.scanStatus()).toMatchObject({ complete: false });
    expect(adapter.scanStatus().deferredResourceIds).toContain(
      "chat-transcript-scope/untracked-oversized-resources",
    );
    expect(result.warnings.join("\n")).toContain(
      "oversized settlement tracking exceeded its fixed limit",
    );
  });

  it("advances a retained-byte cursor until every small transcript is emitted", async () => {
    const paths = await createPaths();
    for (let index = 0; index < 4; index += 1) {
      const transcript = join(
        paths.cursorProjects,
        "project-a",
        "agent-transcripts",
        `session-${index}`,
        `session-${index}.jsonl`,
      );
      await mkdir(join(transcript, ".."), { recursive: true });
      await writeFile(transcript, `row-${index}`);
    }
    const adapter = new ChatTranscriptsAdapter(paths, {
      maxResourcesPerScan: 2,
      maxRetainedBytesPerScan: 7,
    });
    const known: Record<string, LocalProjection> = {};
    const observed = new Set<string>();
    let maxSnapshots = 0;
    for (let pass = 0; pass < 8; pass += 1) {
      const result = await adapter.scan(known);
      maxSnapshots = Math.max(maxSnapshots, result.snapshots.length);
      rememberSnapshots(known, result.snapshots);
      for (const snapshot of result.snapshots) {
        observed.add(snapshot.resourceId);
      }
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(observed.size).toBe(4);
    expect(maxSnapshots).toBe(1);
    expect(adapter.scanStatus().complete).toBe(true);
    expect((await adapter.scan(known)).snapshots).toEqual([]);
  });

  it("bounds recursive enumeration and file metadata syscalls across a finite sweep", async () => {
    const paths = await createPaths();
    for (let project = 0; project < 3; project += 1) {
      const transcript = join(
        paths.cursorProjects,
        `project-${project}`,
        "agent-transcripts",
        "session",
        "session.jsonl",
      );
      await mkdir(join(transcript, ".."), { recursive: true });
      await writeFile(transcript, `project-${project}`);
    }
    let enumerations = 0;
    let metadataChecks = 0;
    const adapter = new ChatTranscriptsAdapter(paths, {
      maxEnumerationProjectsPerScan: 1,
      maxMetadataChecksPerScan: 1,
      enumerationIntervalMs: Number.MAX_SAFE_INTEGER,
      metadataIntervalMs: Number.MAX_SAFE_INTEGER,
      onProjectEnumerate: () => {
        enumerations += 1;
      },
      onMetadataCheck: () => {
        metadataChecks += 1;
      },
    });
    const known: Record<string, LocalProjection> = {};
    const observed = new Set<string>();
    for (let pass = 0; pass < 10; pass += 1) {
      const beforeEnumerations = enumerations;
      const beforeMetadata = metadataChecks;
      const result = await adapter.scan(known);
      expect(enumerations - beforeEnumerations).toBeLessThanOrEqual(1);
      expect(metadataChecks - beforeMetadata).toBeLessThanOrEqual(1);
      expect(result.deletions).toEqual([]);
      rememberSnapshots(known, result.snapshots);
      result.snapshots.forEach((snapshot) => observed.add(snapshot.resourceId));
      if (adapter.scanStatus().complete) {
        break;
      }
    }
    expect(observed.size).toBe(3);
    expect(adapter.scanStatus().complete).toBe(true);
    const metadataBeforeIdle = metadataChecks;
    await adapter.scan(known);
    expect(metadataChecks).toBe(metadataBeforeIdle);
  });

  it("resumes one large transcript directory within a fixed traversal budget", async () => {
    const paths = await createPaths();
    const transcriptRoot = join(
      paths.cursorProjects,
      "project-large",
      "agent-transcripts",
    );
    await mkdir(transcriptRoot, { recursive: true });
    for (let index = 0; index < 37; index += 1) {
      await writeFile(
        join(transcriptRoot, `${index.toString().padStart(3, "0")}.jsonl`),
        `row-${index}`,
      );
    }
    let traversalWork = 0;
    const adapter = new ChatTranscriptsAdapter(paths, {
      maxEnumerationProjectsPerScan: 1,
      maxEnumerationWorkItemsPerScan: 5,
      enumerationIntervalMs: Number.MAX_SAFE_INTEGER,
      metadataIntervalMs: Number.MAX_SAFE_INTEGER,
      onEnumerationWork: () => {
        traversalWork += 1;
      },
    });
    const seededResourceId = `chat-transcript/${encodeURIComponent(
      "project-large/agent-transcripts/000.jsonl",
    )}`;
    const known: Record<string, LocalProjection> = {
      [seededResourceId]: {
        resourceId: seededResourceId,
        kind: "chat-transcript",
        semanticHash: sha256("seed"),
        versionId: null,
      },
    };
    const observed = new Set<string>();
    for (let pass = 0; pass < 100; pass += 1) {
      const before = traversalWork;
      const result = await adapter.scan(known);
      expect(traversalWork - before).toBeLessThanOrEqual(5);
      expect(result.deletions).toEqual([]);
      rememberSnapshots(known, result.snapshots);
      result.snapshots.forEach((snapshot) => observed.add(snapshot.resourceId));
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(observed.size).toBe(37);
    expect(adapter.scanStatus().complete).toBe(true);
    const beforeIdle = traversalWork;
    await adapter.scan(known);
    expect(traversalWork).toBe(beforeIdle);
  });

  it("keeps a transiently unreadable transcript deferred until it is captured", async () => {
    const paths = await createPaths();
    const transcript = join(
      paths.cursorProjects,
      "project-a",
      "agent-transcripts",
      "session-a",
      "session-a.jsonl",
    );
    await mkdir(join(transcript, ".."), { recursive: true });
    await writeFile(transcript, "local edit");
    let failRead = true;
    const adapter = new ChatTranscriptsAdapter(paths, {
      onFileRead: () => {
        if (failRead) {
          failRead = false;
          throw new Error("transient transcript read failure");
        }
      },
    });

    const first = await adapter.scan({});
    expect(first.snapshots).toEqual([]);
    expect(adapter.scanStatus().complete).toBe(false);
    expect(adapter.scanStatus().deferredResourceIds).toHaveLength(1);

    const second = await adapter.scan({});
    expect(second.snapshots).toHaveLength(1);
    expect(adapter.scanStatus().complete).toBe(true);
  });

  it("keeps a project enumeration failure incomplete until retry succeeds", async () => {
    const paths = await createPaths();
    const transcript = join(
      paths.cursorProjects,
      "project-a",
      "agent-transcripts",
      "session-a",
      "session-a.jsonl",
    );
    await mkdir(join(transcript, ".."), { recursive: true });
    await writeFile(transcript, "local edit");
    let failEnumeration = true;
    const adapter = new ChatTranscriptsAdapter(paths, {
      onProjectEnumerate: () => {
        if (failEnumeration) {
          failEnumeration = false;
          throw new Error("transient directory failure");
        }
      },
    });

    expect((await adapter.scan({})).snapshots).toEqual([]);
    expect(adapter.scanStatus().complete).toBe(false);
    expect(adapter.scanStatus().deferredResourceIds[0]).toMatch(
      /^chat-transcript-project\//,
    );
    expect((await adapter.scan({})).snapshots).toHaveLength(1);
    expect(adapter.scanStatus().complete).toBe(true);
  });
});

describeWithSqlite("bounded store.db scans", () => {
  it("rejects a zeroblob from SQL metadata without materializing its value", async () => {
    const paths = await createPaths();
    const store = join(paths.cursorChats, "session-a", "store.db");
    await mkdir(join(store, ".."), { recursive: true });
    const database = new sqlite.DatabaseSync(store);
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value)");
    database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data)");
    database.exec("INSERT INTO blobs(id, data) VALUES ('huge', zeroblob(2048))");
    database.close();
    let materializations = 0;
    const adapter = new StoreDbChatAdapter(paths, {
      onValueMaterialize: () => {
        materializations += 1;
      },
    });
    adapter.setMaxPayloadBytes(1024);

    const first = await adapter.scan({});
    const second = await adapter.scan({});

    expect(first.snapshots).toEqual([]);
    expect(second.snapshots).toEqual([]);
    expect(materializations).toBe(0);
    expect(adapter.oversizedSnapshotSettlements(1024)).toHaveLength(1);
  });

  it("streams the exact same canonical length and hash as canonicalBytes", () => {
    const snapshot: PortableStoreSnapshot = {
      schemaVersion: 1,
      relativePath: "chats/session/store.db",
      meta: [
        { key: "quote\"\n", value: { type: "text", value: "한글\\\n" } },
        { key: "integer", value: { type: "integer", value: "42" } },
      ],
      blobs: [
        { id: "blob", data: { type: "blob", value: "AP8=" } },
        { id: "null", data: { type: "null" } },
      ],
    };
    const content = serializePortableStoreSnapshot(snapshot);

    expect(portableStoreSnapshotCanonicalByteLength(snapshot)).toBe(
      content.byteLength,
    );
    expect(portableStoreSnapshotSemanticHash(snapshot)).toBe(sha256(content));
    expect(parsePortableStoreSnapshot(content)).toEqual(snapshot);
  });

  it("refuses an aggregate store row excess before canonical serialization", () => {
    const snapshot: PortableStoreSnapshot = {
      schemaVersion: 1,
      relativePath: "chats/session/store.db",
      meta: Array.from({ length: 20_001 }, (_, index) => ({
        key: `key-${index}`,
        value: { type: "null" as const },
      })),
      blobs: [],
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(() => serializePortableStoreSnapshot(snapshot)).toThrow(
        "aggregate row count",
      );
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("settles an aggregate store row excess before materializing values", async () => {
    const paths = await createPaths();
    const store = join(paths.cursorChats, "session-many", "store.db");
    await mkdir(join(store, ".."), { recursive: true });
    const database = new sqlite.DatabaseSync(store);
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value)");
    database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data)");
    const insert = database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    database.exec("BEGIN");
    for (let index = 0; index < 20_001; index += 1) {
      insert.run(`key-${index}`, "value");
    }
    database.exec("COMMIT");
    database.close();
    let materializations = 0;
    const adapter = new StoreDbChatAdapter(paths, {
      onValueMaterialize: () => {
        materializations += 1;
      },
    });

    const first = await adapter.scan({});
    const second = await adapter.scan({});

    expect(first.snapshots).toEqual([]);
    expect(second.snapshots).toEqual([]);
    expect(materializations).toBe(0);
    expect(adapter.oversizedSnapshotSettlements(128 * 1024 * 1024)).toHaveLength(1);
  });

  it("settles a physically huge store before opening or inspecting SQLite", async () => {
    const paths = await createPaths();
    const store = join(paths.cursorChats, "session-large", "store.db");
    await mkdir(join(store, ".."), { recursive: true });
    await writeFile(store, "");
    await truncate(store, 65 * 1024 * 1024);
    let inspections = 0;
    const adapter = new StoreDbChatAdapter(paths, {
      onInspect: () => {
        inspections += 1;
      },
    });

    const result = await adapter.scan({});

    expect(result.snapshots).toEqual([]);
    expect(inspections).toBe(0);
    expect(adapter.oversizedSnapshotSettlements(128 * 1024 * 1024)).toHaveLength(1);
  });

  it("bounds aggregate SQLite inspection work and resumes later large stores", async () => {
    const paths = await createPaths();
    for (let index = 0; index < 3; index += 1) {
      const store = join(paths.cursorChats, `session-aggregate-${index}`, "store.db");
      await mkdir(join(store, ".."), { recursive: true });
      const database = new sqlite.DatabaseSync(store);
      database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value)");
      database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data)");
      database.exec(
        "INSERT INTO meta(key, value) VALUES ('huge', zeroblob(27262976))",
      );
      database.close();
    }
    let inspections = 0;
    let maxInspectionsInOneScan = 0;
    const scanWarnings: string[] = [];
    const adapter = new StoreDbChatAdapter(paths, {
      onInspect: () => {
        inspections += 1;
      },
    });

    for (let pass = 0; pass < 8; pass += 1) {
      const before = inspections;
      const result = await adapter.scan({});
      scanWarnings.push(...result.warnings);
      expect(result.snapshots).toEqual([]);
      maxInspectionsInOneScan = Math.max(
        maxInspectionsInOneScan,
        inspections - before,
      );
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(maxInspectionsInOneScan).toBeLessThanOrEqual(2);
    expect(inspections, scanWarnings.join("\n")).toBe(3);
    expect(
      adapter.oversizedSnapshotSettlements(128 * 1024 * 1024),
    ).toHaveLength(3);
    expect(adapter.scanStatus().complete).toBe(true);
    const beforeIdle = inspections;
    await adapter.scan({});
    expect(inspections).toBe(beforeIdle);
  }, 30_000);

  it("keeps a transient store inspection failure deferred", async () => {
    const paths = await createPaths();
    const store = join(paths.cursorChats, "session-retry", "store.db");
    await mkdir(join(store, ".."), { recursive: true });
    const database = new sqlite.DatabaseSync(store);
    database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value)");
    database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data)");
    database.exec("INSERT INTO meta(key, value) VALUES ('edited', 'local')");
    database.close();
    let failInspect = true;
    const adapter = new StoreDbChatAdapter(paths, {
      onInspect: () => {
        if (failInspect) {
          failInspect = false;
          throw new Error("transient SQLite busy");
        }
      },
    });

    expect((await adapter.scan({})).snapshots).toEqual([]);
    expect(adapter.scanStatus().complete).toBe(false);
    expect(adapter.scanStatus().deferredResourceIds).toHaveLength(1);
    expect((await adapter.scan({})).snapshots).toHaveLength(1);
    expect(adapter.scanStatus().complete).toBe(true);
  });

  it("rotates a permanently failing large store so a healthy sibling progresses", async () => {
    const paths = await createPaths();
    const failing = join(paths.cursorChats, "session-00-failing", "store.db");
    const healthy = join(paths.cursorChats, "session-01-healthy", "store.db");
    for (const [store, bytes] of [
      [failing, 60 * 1024 * 1024],
      [healthy, 6 * 1024 * 1024],
    ] as const) {
      await mkdir(join(store, ".."), { recursive: true });
      const database = new sqlite.DatabaseSync(store);
      database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value)");
      database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data)");
      database.exec(
        `INSERT INTO meta(key, value) VALUES ('payload', zeroblob(${bytes}))`,
      );
      database.close();
    }
    const adapter = new StoreDbChatAdapter(paths, {
      onInspect: (path) => {
        if (path === failing) {
          throw new Error("permanent SQLite failure");
        }
      },
    });
    const observed = new Set<string>();
    const known: Record<string, LocalProjection> = {};
    const scanWarnings: string[] = [];

    for (let pass = 0; pass < 6 && observed.size === 0; pass += 1) {
      const result = await adapter.scan(known);
      scanWarnings.push(...result.warnings);
      rememberSnapshots(known, result.snapshots);
      result.snapshots.forEach((snapshot) => observed.add(snapshot.resourceId));
    }

    expect(observed, scanWarnings.join("\n")).toEqual(
      new Set([
        `chat-store/${encodeURIComponent("chats/session-01-healthy/store.db")}`,
      ]),
    );
    expect(adapter.scanStatus().complete).toBe(false);
    expect(adapter.scanStatus().deferredResourceIds).toContain(
      `chat-store/${encodeURIComponent("chats/session-00-failing/store.db")}`,
    );
  }, 30_000);

  it("resumes a large nested store root without an unbounded recursive walk", async () => {
    const paths = await createPaths();
    for (let index = 0; index < 19; index += 1) {
      const store = join(
        paths.cursorChats,
        "large-root",
        `session-${index.toString().padStart(2, "0")}`,
        "store.db",
      );
      await mkdir(join(store, ".."), { recursive: true });
      const database = new sqlite.DatabaseSync(store);
      database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value)");
      database.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data)");
      database.exec(`INSERT INTO meta(key, value) VALUES ('index', ${index})`);
      database.close();
    }
    let traversalWork = 0;
    const adapter = new StoreDbChatAdapter(paths, {
      maxEnumerationRootsPerScan: 1,
      maxEnumerationWorkItemsPerScan: 6,
      maxMetadataChecksPerScan: 4,
      maxResourcesPerScan: 4,
      enumerationIntervalMs: Number.MAX_SAFE_INTEGER,
      metadataIntervalMs: Number.MAX_SAFE_INTEGER,
      onEnumerationWork: () => {
        traversalWork += 1;
      },
    });
    const known: Record<string, LocalProjection> = {};
    const observed = new Set<string>();
    for (let pass = 0; pass < 150; pass += 1) {
      const before = traversalWork;
      const result = await adapter.scan(known);
      expect(traversalWork - before).toBeLessThanOrEqual(6);
      rememberSnapshots(known, result.snapshots);
      result.snapshots.forEach((snapshot) => observed.add(snapshot.resourceId));
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(observed.size).toBe(19);
    expect(adapter.scanStatus().complete).toBe(true);
    const beforeIdle = traversalWork;
    await adapter.scan(known);
    expect(traversalWork).toBe(beforeIdle);
  });
});

describe("bounded workspaceStorage scans", () => {
  it("settles an oversized live image before reading it", async () => {
    const paths = await createPaths();
    await writeWorkspaceIdentity(paths, "workspace-a");
    const image = join(
      paths.workspaceStorageRoot,
      "workspace-a",
      "images",
      "large.png",
    );
    await mkdir(join(image, ".."), { recursive: true });
    await writeFile(image, "");
    await truncate(image, 2048);
    let reads = 0;
    const adapter = new WorkspaceStorageAdapter(
      paths,
      {},
      1024,
      undefined,
      true,
      {
        onFileRead: () => {
          reads += 1;
        },
      },
    );

    const result = await adapter.scan({});

    expect(result.snapshots).toEqual([]);
    expect(reads).toBe(0);
    expect(adapter.oversizedSnapshotSettlements(1024)).toHaveLength(1);
  });

  it("pages the shutdown adapter instead of retaining every file at once", async () => {
    const paths = await createPaths();
    await writeWorkspaceIdentity(paths, "workspace-a");
    for (let index = 0; index < 4; index += 1) {
      const image = join(
        paths.workspaceStorageRoot,
        "workspace-a",
        "images",
        `${index}.png`,
      );
      await mkdir(join(image, ".."), { recursive: true });
      await writeFile(image, `image-${index}`);
    }
    const adapter = new WorkspaceStorageAdapter(
      paths,
      {},
      1024 * 1024,
      undefined,
      false,
      { maxResourcesPerScan: 1, maxRetainedBytesPerScan: 1024 },
    );
    const known: Record<string, LocalProjection> = {};
    const observed = new Set<string>();
    for (let pass = 0; pass < 8; pass += 1) {
      const result = await adapter.scan(known);
      expect(result.snapshots.length).toBeLessThanOrEqual(1);
      rememberSnapshots(known, result.snapshots);
      result.snapshots.forEach((snapshot) => observed.add(snapshot.resourceId));
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(observed.size).toBe(4);
    expect(adapter.scanStatus().complete).toBe(true);
  });

  it("bounds workspace-tree enumeration and cached-file metadata checks", async () => {
    const paths = await createPaths();
    for (let workspace = 0; workspace < 3; workspace += 1) {
      const workspaceId = `workspace-${workspace}`;
      await writeWorkspaceIdentity(paths, workspaceId);
      const image = join(
        paths.workspaceStorageRoot,
        workspaceId,
        "images",
        "image.png",
      );
      await mkdir(join(image, ".."), { recursive: true });
      await writeFile(image, workspaceId);
    }
    let enumerations = 0;
    let metadataChecks = 0;
    const adapter = new WorkspaceStorageAdapter(
      paths,
      {},
      1024 * 1024,
      undefined,
      true,
      {
        maxEnumerationWorkspacesPerScan: 1,
        maxMetadataChecksPerScan: 1,
        enumerationIntervalMs: Number.MAX_SAFE_INTEGER,
        metadataIntervalMs: Number.MAX_SAFE_INTEGER,
        onWorkspaceEnumerate: () => {
          enumerations += 1;
        },
        onMetadataCheck: () => {
          metadataChecks += 1;
        },
      },
    );
    const known: Record<string, LocalProjection> = {};
    const observed = new Set<string>();
    for (let pass = 0; pass < 12; pass += 1) {
      const beforeEnumerations = enumerations;
      const beforeMetadata = metadataChecks;
      const result = await adapter.scan(known);
      expect(enumerations - beforeEnumerations).toBeLessThanOrEqual(1);
      expect(metadataChecks - beforeMetadata).toBeLessThanOrEqual(1);
      rememberSnapshots(known, result.snapshots);
      result.snapshots.forEach((snapshot) => observed.add(snapshot.resourceId));
      if (adapter.scanStatus().complete) {
        break;
      }
    }
    expect(observed.size).toBe(3);
    expect(adapter.scanStatus().complete).toBe(true);
  });

  it("resumes a large images directory and performs no traversal when settled", async () => {
    const paths = await createPaths();
    await writeWorkspaceIdentity(paths, "workspace-large");
    const images = join(
      paths.workspaceStorageRoot,
      "workspace-large",
      "images",
    );
    await mkdir(images, { recursive: true });
    for (let index = 0; index < 41; index += 1) {
      await writeFile(
        join(images, `${index.toString().padStart(3, "0")}.png`),
        `image-${index}`,
      );
    }
    let traversalWork = 0;
    const adapter = new WorkspaceStorageAdapter(
      paths,
      {},
      1024 * 1024,
      undefined,
      true,
      {
        maxEnumerationWorkspacesPerScan: 1,
        maxEnumerationWorkItemsPerScan: 5,
        maxMetadataChecksPerScan: 8,
        maxResourcesPerScan: 8,
        enumerationIntervalMs: Number.MAX_SAFE_INTEGER,
        metadataIntervalMs: Number.MAX_SAFE_INTEGER,
        onEnumerationWork: () => {
          traversalWork += 1;
        },
      },
    );
    const known: Record<string, LocalProjection> = {};
    const observed = new Set<string>();
    for (let pass = 0; pass < 150; pass += 1) {
      const before = traversalWork;
      const result = await adapter.scan(known);
      expect(traversalWork - before).toBeLessThanOrEqual(5);
      rememberSnapshots(known, result.snapshots);
      result.snapshots.forEach((snapshot) => observed.add(snapshot.resourceId));
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(observed.size).toBe(41);
    expect(adapter.scanStatus().complete).toBe(true);
    const beforeIdle = traversalWork;
    await adapter.scan(known);
    expect(traversalWork).toBe(beforeIdle);
  });

  it("keeps a transient workspace file read failure deferred", async () => {
    const paths = await createPaths();
    await writeWorkspaceIdentity(paths, "workspace-a");
    const image = join(
      paths.workspaceStorageRoot,
      "workspace-a",
      "images",
      "retry.png",
    );
    await mkdir(join(image, ".."), { recursive: true });
    await writeFile(image, "local image");
    let failRead = true;
    const adapter = new WorkspaceStorageAdapter(
      paths,
      {},
      1024 * 1024,
      undefined,
      true,
      {
        onFileRead: () => {
          if (failRead) {
            failRead = false;
            throw new Error("transient workspace read failure");
          }
        },
      },
    );

    expect((await adapter.scan({})).snapshots).toEqual([]);
    expect(adapter.scanStatus().complete).toBe(false);
    expect(adapter.scanStatus().deferredResourceIds).toHaveLength(1);
    expect((await adapter.scan({})).snapshots).toHaveLength(1);
    expect(adapter.scanStatus().complete).toBe(true);
  });

  it("keeps a workspace enumeration failure incomplete until retry succeeds", async () => {
    const paths = await createPaths();
    await writeWorkspaceIdentity(paths, "workspace-a");
    const image = join(
      paths.workspaceStorageRoot,
      "workspace-a",
      "images",
      "retry.png",
    );
    await mkdir(join(image, ".."), { recursive: true });
    await writeFile(image, "local image");
    let failEnumeration = true;
    const adapter = new WorkspaceStorageAdapter(
      paths,
      {},
      1024 * 1024,
      undefined,
      true,
      {
        onWorkspaceEnumerate: () => {
          if (failEnumeration) {
            failEnumeration = false;
            throw new Error("transient workspace enumeration failure");
          }
        },
      },
    );

    expect((await adapter.scan({})).snapshots).toEqual([]);
    expect(adapter.scanStatus().complete).toBe(false);
    expect(adapter.scanStatus().deferredResourceIds[0]).toMatch(
      /^workspace-storage-enumeration\//,
    );
    expect((await adapter.scan({})).snapshots).toHaveLength(1);
    expect(adapter.scanStatus().complete).toBe(true);
  });
});

describeWithSqlite("bounded workspaceStorage database inspections", () => {
  it("settles a physically huge state database before opening it", async () => {
    const paths = await createPaths();
    await writeWorkspaceIdentity(paths, "workspace-large-db");
    const databasePath = join(
      paths.workspaceStorageRoot,
      "workspace-large-db",
      "state.vscdb",
    );
    await writeFile(databasePath, "");
    await truncate(databasePath, 65 * 1024 * 1024);
    let reads = 0;
    const adapter = new WorkspaceStorageAdapter(
      paths,
      {},
      128 * 1024 * 1024,
      undefined,
      false,
      {
        onFileRead: () => {
          reads += 1;
        },
      },
    );

    expect((await adapter.scan({})).snapshots).toEqual([]);
    expect(reads).toBe(0);
    expect(
      adapter.oversizedSnapshotSettlements(128 * 1024 * 1024),
    ).toHaveLength(1);
  });

  it("bounds aggregate database inspections and eventually settles every item", async () => {
    const paths = await createPaths();
    for (let index = 0; index < 3; index += 1) {
      const workspaceId = `workspace-large-${index}`;
      await writeWorkspaceIdentity(paths, workspaceId);
      const databasePath = join(
        paths.workspaceStorageRoot,
        workspaceId,
        "state.vscdb",
      );
      const database = new sqlite.DatabaseSync(databasePath);
      database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value)");
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
      );
      database.exec(
        "INSERT INTO cursorDiskKV(key, value) VALUES ('payload', zeroblob(27262976))",
      );
      database.close();
    }
    let inspections = 0;
    let maxInspectionsInOneScan = 0;
    const workspaceWarnings: string[] = [];
    const adapter = new WorkspaceStorageAdapter(
      paths,
      {},
      128 * 1024 * 1024,
      undefined,
      false,
      {
        onFileRead: () => {
          inspections += 1;
        },
      },
    );

    for (let pass = 0; pass < 8; pass += 1) {
      const before = inspections;
      const result = await adapter.scan({});
      workspaceWarnings.push(...result.warnings);
      expect(result.snapshots).toEqual([]);
      maxInspectionsInOneScan = Math.max(
        maxInspectionsInOneScan,
        inspections - before,
      );
      if (adapter.scanStatus().complete) {
        break;
      }
    }

    expect(maxInspectionsInOneScan).toBeLessThanOrEqual(2);
    expect(inspections, workspaceWarnings.join("\n")).toBe(3);
    expect(
      adapter.oversizedSnapshotSettlements(128 * 1024 * 1024),
    ).toHaveLength(3);
    expect(adapter.scanStatus().complete).toBe(true);
  }, 30_000);

  it("rotates a permanently failing large database past a healthy sibling", async () => {
    const paths = await createPaths();
    const entries = [
      ["workspace-00-failing", 60 * 1024 * 1024],
      ["workspace-01-healthy", 6 * 1024 * 1024],
    ] as const;
    let failingPath = "";
    for (const [workspaceId, bytes] of entries) {
      await writeWorkspaceIdentity(paths, workspaceId);
      const databasePath = join(
        paths.workspaceStorageRoot,
        workspaceId,
        "state.vscdb",
      );
      if (workspaceId.includes("failing")) {
        failingPath = databasePath;
      }
      const database = new sqlite.DatabaseSync(databasePath);
      database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value)");
      database.exec(
        "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
      );
      database.exec(
        `INSERT INTO cursorDiskKV(key, value) VALUES ('payload', zeroblob(${bytes}))`,
      );
      database.close();
    }
    const adapter = new WorkspaceStorageAdapter(
      paths,
      {},
      128 * 1024 * 1024,
      undefined,
      false,
      {
        onFileRead: (path) => {
          if (path === failingPath) {
            throw new Error("permanent workspace database failure");
          }
        },
      },
    );
    const observed = new Set<string>();
    const known: Record<string, LocalProjection> = {};
    const workspaceWarnings: string[] = [];

    for (let pass = 0; pass < 6 && observed.size === 0; pass += 1) {
      const result = await adapter.scan(known);
      workspaceWarnings.push(...result.warnings);
      rememberSnapshots(known, result.snapshots);
      result.snapshots.forEach((snapshot) => observed.add(snapshot.resourceId));
    }

    expect(observed, workspaceWarnings.join("\n")).toEqual(
      new Set([
        `workspace-storage/${encodeURIComponent(
          "workspace-01-healthy/state.vscdb",
        )}`,
      ]),
    );
    expect(adapter.scanStatus().complete).toBe(false);
  }, 30_000);
});

async function createPaths(): Promise<CursorPaths> {
  const root = await mkdtemp(join(tmpdir(), "cursor-aux-bounds-"));
  roots.push(root);
  const cursorHome = join(root, ".cursor");
  const userDataRoot = join(root, "User");
  const paths: CursorPaths = {
    appRoot: root,
    userDataRoot,
    globalStorageRoot: join(userDataRoot, "globalStorage"),
    globalDatabase: join(userDataRoot, "globalStorage", "state.vscdb"),
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
    extensionStorage: join(root, "extension-storage"),
    helperScript: join(root, "helper.js"),
  };
  await Promise.all([
    mkdir(paths.cursorProjects, { recursive: true }),
    mkdir(paths.cursorChats, { recursive: true }),
    mkdir(paths.cursorAcpSessions, { recursive: true }),
    mkdir(paths.workspaceStorageRoot, { recursive: true }),
  ]);
  return paths;
}

async function writeWorkspaceIdentity(
  paths: CursorPaths,
  workspaceId: string,
): Promise<void> {
  const path = join(paths.workspaceStorageRoot, workspaceId, "workspace.json");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ folder: `file:///C:/${workspaceId}` }));
}

function rememberSnapshots(
  known: Record<string, LocalProjection>,
  snapshots: readonly ResourceSnapshot[],
): void {
  for (const snapshot of snapshots) {
    known[snapshot.resourceId] = {
      resourceId: snapshot.resourceId,
      kind: snapshot.kind,
      semanticHash: snapshot.semanticHash,
      versionId: null,
      ...(typeof snapshot.metadata?.lastUpdatedAt === "number"
        ? { sourceTimestamp: snapshot.metadata.lastUpdatedAt }
        : {}),
    };
  }
}
