import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_STATE_FILE } from "../src/constants";
import { LocalStateStore } from "../src/protocol/localState";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local sync state write memo", () => {
  it("does not rewrite an unchanged state and persists the next mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-local-state-"));
    temporaryRoots.push(root);
    const repositoryId = "11111111-1111-4111-8111-111111111111";
    const store = new LocalStateStore(root);
    const state = await store.loadOrCreate(repositoryId);
    const statePath = join(
      root,
      LOCAL_STATE_FILE.replace(".json", `-${repositoryId}.json`),
    );
    const before = await stat(statePath);

    await store.save(state);

    const unchanged = await stat(statePath);
    expect(unchanged.mtimeMs).toBe(before.mtimeMs);

    state.lastSyncAt = "2026-08-03T12:34:56.000Z";
    await store.save(state);

    const stored = JSON.parse(await readFile(statePath, "utf8")) as {
      lastSyncAt?: unknown;
    };
    expect(stored.lastSyncAt).toBe(state.lastSyncAt);
  });

  it("does no read, parse, or stringify for an unchanged identity probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sync-local-state-probe-"));
    temporaryRoots.push(root);
    const repositoryId = "22222222-2222-4222-8222-222222222222";
    const counts = { reads: 0, parses: 0, stringifies: 0 };
    const store = new LocalStateStore(root, {
      onRead: () => {
        counts.reads += 1;
      },
      onParse: () => {
        counts.parses += 1;
      },
      onStringify: () => {
        counts.stringifies += 1;
      },
    });
    await store.loadOrCreate(repositoryId);
    counts.reads = 0;
    counts.parses = 0;
    counts.stringifies = 0;

    await expect(store.loadIfChanged(repositoryId)).resolves.toBeNull();
    expect(counts).toEqual({ reads: 0, parses: 0, stringifies: 0 });

    const external = new LocalStateStore(root);
    const changed = await external.load(repositoryId);
    changed.lastError = "external change";
    await external.save(changed);

    await expect(store.loadIfChanged(repositoryId)).resolves.toMatchObject({
      lastError: "external change",
    });
    expect(counts).toEqual({ reads: 1, parses: 1, stringifies: 1 });
  });
});
