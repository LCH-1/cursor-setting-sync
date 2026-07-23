import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { pathExists } from "../src/platform/files";
import {
  GitError,
  cloneRepository,
  commitAndPush,
  detectGit,
  initRepository,
  isGitRepository,
  largeFileWarnings,
  pullLatest,
  squashHistory,
} from "../src/platform/git";

const execFileAsync = promisify(execFile);

const gitAvailable =
  spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const suite = gitAvailable ? describe : describe.skip;

const SLOW = { timeout: 120_000 };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=Test Device", "-c", "user.email=device@example.com", ...args],
    {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    },
  );
  return stdout.trim();
}

async function makeRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `cursor-sync-git-${name}-`));
}

async function removeRoot(path: string): Promise<void> {
  try {
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch {
    // Windows can briefly hold handles on .git pack files; a leaked temp
    // directory must not fail the test that already asserted its behavior.
  }
}

async function createBareRemote(): Promise<string> {
  const dir = await makeRoot("remote");
  await git(dir, "init", "--bare", "-b", "main");
  return dir;
}

function remoteUrl(dir: string): string {
  return dir.replaceAll("\\", "/");
}

async function writeRepoFile(
  root: string,
  portablePath: string,
  content: string,
): Promise<void> {
  const segments = portablePath.split("/");
  await mkdir(join(root, ...segments.slice(0, -1)), { recursive: true });
  await writeFile(join(root, ...segments), content, "utf8");
}

async function listTree(root: string): Promise<string[]> {
  const output = await git(root, "ls-files");
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

interface DevicePair {
  remote: string;
  deviceA: string;
  deviceB: string;
}

async function createSyncedPair(): Promise<DevicePair> {
  const remote = await createBareRemote();
  const deviceA = await makeRoot("device-a");
  await initRepository(deviceA, remoteUrl(remote));
  await writeRepoFile(deviceA, "repo.json", '{"version":1}\n');
  await writeRepoFile(deviceA, "devices/device-a/events/0001.bin", "a-event-1");
  await writeRepoFile(deviceA, "devices/device-a/head.json", '{"seq":1}\n');
  await commitAndPush(deviceA, "device-a initial");
  const deviceB = await makeRoot("device-b");
  await cloneRepository(remoteUrl(remote), deviceB, "main");
  return { remote, deviceA, deviceB };
}

async function destroyPair(pair: DevicePair): Promise<void> {
  await removeRoot(pair.deviceA);
  await removeRoot(pair.deviceB);
  await removeRoot(pair.remote);
}

suite("git transport", () => {
  it("detects the system git binary", async () => {
    const detection = await detectGit();
    expect(detection.available).toBe(true);
    expect(detection.version).toMatch(/^\d+\./);
  });

  it("initializes, publishes, and clones a roundtrip", SLOW, async () => {
    const pair = await createSyncedPair();
    const plain = await makeRoot("plain");
    try {
      expect(await isGitRepository(pair.deviceA)).toBe(true);
      expect(await isGitRepository(pair.deviceB)).toBe(true);
      expect(await isGitRepository(plain)).toBe(false);

      expect(await readFile(join(pair.deviceB, "repo.json"), "utf8")).toBe(
        '{"version":1}\n',
      );
      expect(
        await readFile(
          join(pair.deviceB, "devices", "device-a", "events", "0001.bin"),
          "utf8",
        ),
      ).toBe("a-event-1");

      expect(await pullLatest(pair.deviceB)).toEqual({ status: "up-to-date" });
    } finally {
      await destroyPair(pair);
      await removeRoot(plain);
    }
  });

  it("refuses to clone into a non-empty directory", SLOW, async () => {
    const remote = await createBareRemote();
    const occupied = await makeRoot("occupied");
    try {
      await writeFile(join(occupied, "existing.txt"), "keep", "utf8");
      await expect(
        cloneRepository(remoteUrl(remote), occupied),
      ).rejects.toThrow(/empty directory/);
      await expect(
        cloneRepository(remoteUrl(remote), occupied),
      ).rejects.toBeInstanceOf(GitError);
    } finally {
      await removeRoot(occupied);
      await removeRoot(remote);
    }
  });

  it(
    "converges two devices writing their own directories via the push-retry path",
    SLOW,
    async () => {
      const pair = await createSyncedPair();
      try {
        await writeRepoFile(
          pair.deviceA,
          "devices/device-a/events/0002.bin",
          "a-event-2",
        );
        const first = await commitAndPush(pair.deviceA, "device-a second");
        expect(first).toEqual({
          committed: true,
          pushed: true,
          recoveredByPull: false,
        });

        await writeRepoFile(
          pair.deviceB,
          "devices/device-b/events/0001.bin",
          "b-event-1",
        );
        await writeRepoFile(pair.deviceB, "devices/device-b/head.json", '{"seq":1}\n');
        const second = await commitAndPush(pair.deviceB, "device-b first");
        expect(second).toEqual({
          committed: true,
          pushed: true,
          recoveredByPull: true,
        });

        expect(await pullLatest(pair.deviceA)).toEqual({ status: "merged" });

        const treeA = await listTree(pair.deviceA);
        expect(treeA).toEqual(await listTree(pair.deviceB));
        expect(treeA).toContain("devices/device-a/events/0002.bin");
        expect(treeA).toContain("devices/device-b/events/0001.bin");
        expect(await git(pair.deviceA, "status", "--porcelain")).toBe("");
        expect(await git(pair.deviceB, "status", "--porcelain")).toBe("");
      } finally {
        await destroyPair(pair);
      }
    },
  );

  it(
    "squashes history and lets the other device recover its unpushed work",
    { timeout: 180_000 },
    async () => {
      const pair = await createSyncedPair();
      try {
        await writeRepoFile(
          pair.deviceA,
          "devices/device-a/events/0002.bin",
          "a-event-2",
        );
        await commitAndPush(pair.deviceA, "device-a second");

        await writeRepoFile(
          pair.deviceB,
          "devices/device-b/events/0001.bin",
          "b-event-1",
        );
        await git(pair.deviceB, "add", "-A");
        await git(pair.deviceB, "commit", "-m", "device-b unpushed");

        const squash = await squashHistory(pair.deviceA, "checkpoint squash");
        expect(squash.pushed).toBe(true);
        expect(squash.bytesBefore).not.toBeNull();
        expect(squash.bytesAfter).not.toBeNull();
        expect(await git(pair.deviceA, "rev-list", "--count", "HEAD")).toBe("1");
        expect(await git(pair.remote, "rev-list", "--count", "main")).toBe("1");

        expect(await pullLatest(pair.deviceB)).toEqual({ status: "reset" });
        expect(
          await readFile(
            join(pair.deviceB, "devices", "device-b", "events", "0001.bin"),
            "utf8",
          ),
        ).toBe("b-event-1");
        expect(
          await readFile(
            join(pair.deviceB, "devices", "device-a", "events", "0002.bin"),
            "utf8",
          ),
        ).toBe("a-event-2");

        const republish = await commitAndPush(pair.deviceB, "device-b republish");
        expect(republish.committed).toBe(true);
        expect(republish.pushed).toBe(true);

        expect(await pullLatest(pair.deviceA)).toEqual({ status: "merged" });
        const treeA = await listTree(pair.deviceA);
        expect(treeA).toEqual(await listTree(pair.deviceB));
        expect(treeA).toContain("devices/device-a/events/0001.bin");
        expect(treeA).toContain("devices/device-a/events/0002.bin");
        expect(treeA).toContain("devices/device-b/events/0001.bin");
        expect(await git(pair.deviceB, "status", "--porcelain")).toBe("");
      } finally {
        await destroyPair(pair);
      }
    },
  );

  it("treats commitAndPush with nothing staged as a clean no-op", SLOW, async () => {
    const pair = await createSyncedPair();
    try {
      expect(await commitAndPush(pair.deviceA, "noop")).toEqual({
        committed: false,
        pushed: false,
        recoveredByPull: false,
      });
    } finally {
      await destroyPair(pair);
    }
  });

  it("supports local-only mode without a remote", SLOW, async () => {
    const root = await makeRoot("local-only");
    try {
      await initRepository(root, null);
      await writeRepoFile(root, "repo.json", '{"version":1}\n');
      await writeRepoFile(root, "devices/device-a/events/0001.bin", "a-event-1");

      expect(await commitAndPush(root, "local initial")).toEqual({
        committed: true,
        pushed: false,
        recoveredByPull: false,
      });
      expect(await pullLatest(root)).toEqual({ status: "no-remote" });
      expect(await commitAndPush(root, "local noop")).toEqual({
        committed: false,
        pushed: false,
        recoveredByPull: false,
      });

      await writeRepoFile(root, "devices/device-a/events/0002.bin", "a-event-2");
      await commitAndPush(root, "local second");
      const squash = await squashHistory(root, "local squash");
      expect(squash.pushed).toBe(false);
      expect(await git(root, "rev-list", "--count", "HEAD")).toBe("1");
      expect(
        await readFile(
          join(root, "devices", "device-a", "events", "0002.bin"),
          "utf8",
        ),
      ).toBe("a-event-2");
    } finally {
      await removeRoot(root);
    }
  });

  it("flags files exceeding the large-file threshold", SLOW, async () => {
    const root = await makeRoot("large-files");
    try {
      await initRepository(root, null);
      await writeRepoFile(root, "repo.json", '{"version":1}\n');
      await writeRepoFile(
        root,
        "devices/device-a/blobs/big.bin",
        "x".repeat(2048),
      );
      await commitAndPush(root, "large-file fixture");

      expect(await largeFileWarnings(root, 1024)).toEqual([
        { path: "devices/device-a/blobs/big.bin", sizeBytes: 2048 },
      ]);
      expect(await largeFileWarnings(root)).toEqual([]);

      const everything = await largeFileWarnings(root, 1);
      expect(everything.length).toBeGreaterThan(0);
      for (const warning of everything) {
        expect(warning.path.startsWith(".git")).toBe(false);
      }
    } finally {
      await removeRoot(root);
    }
  });
  it("recovers from a merge interrupted without conflicts", SLOW, async () => {
    const root = await makeRoot("merge-janitor");
    try {
      await initRepository(root, null);
      await writeRepoFile(root, "devices/device-a/events/one.event", "first");
      await commitAndPush(root, "first");
      const head = await git(root, "rev-parse", "HEAD");

      // A merge killed mid-flight leaves MERGE_HEAD behind; without a janitor
      // every later merge fails with "You have not concluded your merge".
      await writeFile(join(root, ".git", "MERGE_HEAD"), `${head}
`, "utf8");

      const result = await pullLatest(root);

      expect(result.status).toBe("no-remote");
      expect(await pathExists(join(root, ".git", "MERGE_HEAD"))).toBe(false);
    } finally {
      await removeRoot(root);
    }
  });

  it("refuses to sync a stranded squash branch", SLOW, async () => {
    const root = await makeRoot("squash-branch");
    try {
      await initRepository(root, null);
      await writeRepoFile(root, "devices/device-a/events/one.event", "first");
      await commitAndPush(root, "first");

      // An interrupted squash can leave HEAD on the temporary orphan branch,
      // which no other device reads.
      await git(root, "checkout", "--orphan", "cursor-sync-squash-abcd1234");

      await expect(pullLatest(root)).rejects.toThrow("squash branch");
      await expect(commitAndPush(root, "stranded")).rejects.toThrow(
        "squash branch",
      );
    } finally {
      await removeRoot(root);
    }
  });
});
