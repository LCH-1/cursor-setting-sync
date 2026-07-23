import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryWatcher } from "../src/sync/repositoryWatcher";
import type { RepositoryWatcher } from "../src/sync/repositoryWatcher";

const recursiveWatchPlatform =
  process.platform === "win32" || process.platform === "darwin";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for a watcher event.");
    }
    await delay(50);
  }
}

describe("repository watcher", () => {
  let root: string | null = null;
  let watcher: RepositoryWatcher | null = null;

  afterEach(async () => {
    watcher?.close();
    watcher = null;
    if (root !== null) {
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
      root = null;
    }
  });

  it.runIf(recursiveWatchPlatform)(
    "reports nested payload files through the recursive watch",
    async () => {
      root = await mkdtemp(join(tmpdir(), "cursor-sync-watch-recursive-"));
      const eventsDirectory = join(root, "devices", "device-a", "events");
      await mkdir(eventsDirectory, { recursive: true });
      const seen: string[] = [];
      watcher = createRepositoryWatcher(
        root,
        process.platform,
        (fileName) => {
          seen.push(fileName.replaceAll("\\", "/"));
        },
        () => {},
      );
      await delay(250);
      await writeFile(join(eventsDirectory, "0001-abc.cse"), "event", "utf8");
      await waitFor(() =>
        seen.some((name) => name.endsWith("0001-abc.cse")),
      );
    },
  );

  it("watches the fixed directory levels in linux mode", async () => {
    root = await mkdtemp(join(tmpdir(), "cursor-sync-watch-linux-"));
    const eventsDirectory = join(root, "devices", "device-a", "events");
    await mkdir(eventsDirectory, { recursive: true });
    const seen: string[] = [];
    watcher = createRepositoryWatcher(
      root,
      "linux",
      (fileName) => {
        seen.push(fileName);
      },
      () => {},
    );
    await delay(250);
    await writeFile(join(eventsDirectory, "0001-abc.cse"), "event", "utf8");
    await waitFor(() => seen.includes("0001-abc.cse"));
  });

  it("discovers device directories created after the watch started", async () => {
    root = await mkdtemp(join(tmpdir(), "cursor-sync-watch-discover-"));
    await mkdir(join(root, "devices"), { recursive: true });
    const seen: string[] = [];
    watcher = createRepositoryWatcher(
      root,
      "linux",
      (fileName) => {
        seen.push(fileName);
      },
      () => {},
    );
    await delay(250);
    const deviceRoot = join(root, "devices", "device-b");
    await mkdir(deviceRoot);
    await delay(500);
    await mkdir(join(deviceRoot, "events"));
    await delay(500);
    await writeFile(
      join(deviceRoot, "events", "0001-def.cse"),
      "event",
      "utf8",
    );
    await waitFor(() => seen.includes("0001-def.cse"));
  });

  it("stops reporting after close", async () => {
    root = await mkdtemp(join(tmpdir(), "cursor-sync-watch-close-"));
    const eventsDirectory = join(root, "devices", "device-a", "events");
    await mkdir(eventsDirectory, { recursive: true });
    // Directory-entry noise (e.g. a parent timestamp update while watches are
    // registered) is filtered by the manager, so only payload names count.
    const seen: string[] = [];
    const closed = createRepositoryWatcher(
      root,
      "linux",
      (fileName) => {
        if (fileName.endsWith(".cse")) {
          seen.push(fileName);
        }
      },
      () => {},
    );
    await delay(250);
    closed.close();
    await writeFile(join(eventsDirectory, "0002-ghi.cse"), "event", "utf8");
    await delay(500);
    expect(seen).toEqual([]);
  });
});
