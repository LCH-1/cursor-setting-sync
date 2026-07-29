import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  extensions: { all: [] },
}));

import { EventReconciler } from "../src/protocol/reconciler";
import { autoMergeConflicts } from "../src/sync/manager";
import { sha256 } from "../src/protocol/canonical";
import { SyncRepository } from "../src/protocol/repository";
import {
  mergeNotepadBuffers,
  unionNotepadBuffers,
} from "../src/resources/notepadMerge";
import type { EventProducer, ResourceSnapshot } from "../src/types";

const PASSPHRASE = "a sufficiently long test passphrase";
const PRODUCER: EventProducer = {
  extensionVersion: "0.0.1",
  cursorVersion: "3.11.19",
  vscodeVersion: "1.125.0",
};

const WORKSPACE_ID = "703f151ce2095257aebae8e68adf30c0";
const RELATIVE_PATH = `${WORKSPACE_ID}/notepads.json`;
const RESOURCE_ID = `workspace-storage/${encodeURIComponent(RELATIVE_PATH)}`;

interface Notepad {
  id: string;
  name: string;
  text: string;
}

describe("notepads.json merge", () => {
  it("unions two first-contact lists by notepad id", () => {
    // The live case: two computers that each had notepads for the same remote
    // workspace before they ever synchronized. Neither list descends from the
    // other, and picking one file discards the other machine's notes wholesale.
    const merged = parsed(
      unionNotepadBuffers(
        notepads([note("1", "shared", "same"), note("2", "only-a", "a")]),
        notepads([note("1", "shared", "same"), note("3", "only-b", "b")]),
      ),
    );

    expect(merged.map((entry) => entry.id)).toEqual(["1", "2", "3"]);
    expect(merged.find((entry) => entry.id === "3")?.text).toBe("b");
  });

  it("keeps the updated copy when one side is the same note with more in it", () => {
    // "두 개의 notepad를 동시에 수정한 적은 없어" - the two sides are not rival
    // edits, they are one note and a stale copy of it. There is no timestamp in
    // the payload to say which is which, so the only honest signal is that one
    // text contains the other, and the containing side is the update.
    const stale = notepads([note("1", "todo", "buy milk")]);
    const updated = notepads([note("1", "todo", "buy milk\nbuy bread")]);

    for (const [preferred, other] of [
      [stale, updated],
      [updated, stale],
    ] as const) {
      const merged = parsed(unionNotepadBuffers(preferred, other));
      expect(merged).toHaveLength(1);
      expect(merged[0]?.text).toBe("buy milk\nbuy bread");
    }
  });

  it("asks a person when two texts genuinely diverged", () => {
    // Neither contains the other, so nothing in the data says which is newer -
    // and a notepad is prose somebody typed. Electing a side would delete the
    // loser's writing from both computers with nothing in the output channel
    // to say it happened, so the fork goes to the manual resolver instead.
    const first = notepads([note("1", "todo", "alpha")]);
    const second = notepads([note("1", "todo", "beta")]);

    expect(unionNotepadBuffers(first, second).status).toBe("conflict");
    expect(unionNotepadBuffers(second, first).status).toBe("conflict");

    const base = notepads([note("1", "todo", "start")]);
    expect(mergeNotepadBuffers(base, first, second).status).toBe("conflict");
  });

  it("declines a rename it cannot attribute rather than picking one", () => {
    // Same text, different name: the entries differ, so something was renamed,
    // and containment on the text proves nothing about which name is current.
    const first = notepads([note("1", "todo", "same")]);
    const second = notepads([note("1", "backlog", "same")]);

    expect(unionNotepadBuffers(first, second).status).toBe("conflict");
  });

  it("still settles a notepad both computers hold identically", () => {
    const same = notepads([note("1", "todo", "same")]);
    expect(parsed(unionNotepadBuffers(same, same))).toHaveLength(1);
  });

  it("propagates an edit made on one computer to the other", () => {
    // The ordinary case once the two machines share history: one side edited,
    // the other did not touch the file at all.
    const base = notepads([note("1", "todo", "old"), note("2", "keep", "kept")]);
    const edited = notepads([
      note("1", "todo", "new"),
      note("2", "keep", "kept"),
    ]);

    for (const [preferred, other] of [
      [base, edited],
      [edited, base],
    ] as const) {
      const merged = parsed(mergeNotepadBuffers(base, preferred, other));
      expect(merged.map((entry) => entry.text)).toEqual(["new", "kept"]);
    }
  });

  it("honours a deletion the other side left alone", () => {
    const base = notepads([note("1", "gone", "x"), note("2", "stays", "y")]);
    const deleted = notepads([note("2", "stays", "y")]);

    for (const [preferred, other] of [
      [base, deleted],
      [deleted, base],
    ] as const) {
      const merged = parsed(mergeNotepadBuffers(base, preferred, other));
      expect(merged.map((entry) => entry.id)).toEqual(["2"]);
    }
  });

  it("keeps an edit that raced a deletion", () => {
    // A resurrected notepad can be deleted again; a discarded edit cannot be
    // retyped, so the recoverable direction wins.
    const base = notepads([note("1", "todo", "old")]);
    const edited = notepads([note("1", "todo", "edited")]);
    const deleted = notepads([]);

    for (const [preferred, other] of [
      [edited, deleted],
      [deleted, edited],
    ] as const) {
      const merged = parsed(mergeNotepadBuffers(base, preferred, other));
      expect(merged).toHaveLength(1);
      expect(merged[0]?.text).toBe("edited");
    }
  });

  it("carries fields this build has never heard of", () => {
    const withExtra = Buffer.from(
      JSON.stringify([
        { id: "1", name: "todo", text: "x", futureField: { nested: 1 } },
      ]),
      "utf8",
    );
    const merged = parsed(
      unionNotepadBuffers(withExtra, notepads([note("2", "other", "y")])),
    );

    expect(merged[0]).toEqual({
      id: "1",
      name: "todo",
      text: "x",
      futureField: { nested: 1 },
    });
  });

  it("compares a field named __proto__ as a field", () => {
    // The payload comes off disk, so `JSON.parse` can hand back an entry with
    // an own "__proto__" property. Accumulating it onto a normal object would
    // set that object's prototype instead, hiding the difference.
    // Written as raw JSON on purpose: in an object literal `__proto__:` sets
    // the prototype and no such property is ever created, so only text like
    // this reproduces what a file on disk can carry.
    const entry = (marker: string): Buffer =>
      Buffer.from(
        `[{"id":"1","text":"same","__proto__":{"marker":"${marker}"}}]`,
        "utf8",
      );

    // The preferred side changed the field and the other side did not, so the
    // preferred side's value is the only change and must survive. Comparing
    // through an accumulator with a normal prototype would drop the field from
    // both sides, read BOTH sides as unchanged from base, and hand back the
    // other side's stale copy.
    const merged = mergeNotepadBuffers(
      entry("base"),
      entry("edited"),
      entry("base"),
    );

    expect(merged.content?.toString("utf8")).toContain('"marker": "edited"');
  });

  it("leaves a shape it cannot key for the manual resolver", () => {
    const valid = notepads([note("1", "todo", "x")]);
    for (const broken of [
      Buffer.from("not json at all", "utf8"),
      Buffer.from(JSON.stringify({ notepads: [] }), "utf8"),
      Buffer.from(JSON.stringify([{ name: "no id" }]), "utf8"),
      // Two entries under one id: there is no keyed merge to do.
      Buffer.from(
        JSON.stringify([
          { id: "1", text: "a" },
          { id: "1", text: "b" },
        ]),
        "utf8",
      ),
    ]) {
      expect(unionNotepadBuffers(valid, broken).status).toBe("conflict");
      expect(unionNotepadBuffers(broken, valid).status).toBe("conflict");
      expect(mergeNotepadBuffers(valid, valid, broken).status).toBe("conflict");
    }
  });
});

describe("notepads.json auto-merge", () => {
  it("unions a base-free fork instead of asking once per shared workspace", async () => {
    await withRepository(async (repository) => {
      const conflicts = await forkBaseFree(
        repository,
        notepads([note("1", "from-a", "a"), note("2", "shared", "same")]),
        notepads([note("2", "shared", "same"), note("3", "from-b", "b")]),
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.baseVersionId).toBeNull();

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(await reconcileConflicts(repository)).toHaveLength(0);

      const tips = repository.state.tips[RESOURCE_ID] ?? [];
      expect(tips).toHaveLength(1);
      expect(tips[0]?.metadata?.syncOrigin).toBe("auto-merge");
      const merged = JSON.parse(
        (
          (await repository.readVersion(tips[0]?.versionId ?? "")).content ??
          Buffer.alloc(0)
        ).toString("utf8"),
      ) as Notepad[];
      // Every notepad either computer wrote survives.
      expect(merged.map((entry) => entry.id).sort()).toEqual(["1", "2", "3"]);
      // The size the tip advertises has to describe the union it published,
      // not the one side whose metadata it inherited.
      expect(tips[0]?.metadata?.plainBytes).toBe(
        ((await repository.readVersion(tips[0]?.versionId ?? "")).content ?? Buffer.alloc(0))
          .byteLength,
      );
    });
  });

  it("merges a three-way fork so each computer's edit reaches the other", async () => {
    await withRepository(async (repository) => {
      const conflicts = await forkResource(
        repository,
        notepads([note("1", "one", "old"), note("2", "two", "old")]),
        notepads([note("1", "one", "edited on A"), note("2", "two", "old")]),
        notepads([note("1", "one", "old"), note("2", "two", "edited on B")]),
      );
      expect(conflicts).toHaveLength(1);

      expect(await autoMergeConflicts(repository, conflicts)).toBe(true);
      expect(await reconcileConflicts(repository)).toHaveLength(0);

      const tips = repository.state.tips[RESOURCE_ID] ?? [];
      expect(tips).toHaveLength(1);
      const merged = JSON.parse(
        (
          (await repository.readVersion(tips[0]?.versionId ?? "")).content ??
          Buffer.alloc(0)
        ).toString("utf8"),
      ) as Notepad[];
      expect(merged.map((entry) => entry.text)).toEqual([
        "edited on A",
        "edited on B",
      ]);
    });
  });
});

function note(id: string, name: string, text: string): Notepad {
  return { id, name, text };
}

function notepads(entries: readonly Notepad[]): Buffer {
  return Buffer.from(JSON.stringify(entries, null, 2), "utf8");
}

function parsed(outcome: { status: string; content?: Buffer }): Notepad[] {
  expect(outcome.status).toBe("merged");
  return JSON.parse(
    (outcome.content ?? Buffer.alloc(0)).toString("utf8"),
  ) as Notepad[];
}

function resourceSnapshot(content: Buffer): ResourceSnapshot {
  return {
    resourceId: RESOURCE_ID,
    kind: "workspace-storage",
    content,
    semanticHash: sha256(content),
    metadata: {
      relativePath: RELATIVE_PATH,
      workspaceId: WORKSPACE_ID,
      plainBytes: content.byteLength,
    },
  };
}

async function forkBaseFree(
  repository: SyncRepository,
  first: Buffer,
  second: Buffer,
): ReturnType<typeof reconcileConflicts> {
  for (const side of [first, second]) {
    await repository.publish([resourceSnapshot(side)], []);
  }
  return reconcileConflicts(repository);
}

async function forkResource(
  repository: SyncRepository,
  base: Buffer,
  local: Buffer,
  remote: Buffer,
): ReturnType<typeof reconcileConflicts> {
  const published = await repository.publish([resourceSnapshot(base)], []);
  const parents = [`${published.eventHash}#0`];
  for (const side of [local, remote]) {
    await repository.publish([{ ...resourceSnapshot(side), parents }], []);
  }
  return reconcileConflicts(repository);
}

async function reconcileConflicts(repository: SyncRepository) {
  return new EventReconciler().reconcile(
    await repository.listEvents(),
    repository.state,
    null,
  ).conflicts;
}

async function withRepository<T>(
  run: (repository: SyncRepository) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-notepad-test-"));
  try {
    const repository = await SyncRepository.create(
      join(temporaryRoot, "repository"),
      join(temporaryRoot, "storage"),
      PASSPHRASE,
      1024 * 1024,
      PRODUCER,
    );
    return await run(repository);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
