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
});
