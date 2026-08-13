import { afterEach, describe, expect, it, vi } from "vitest";

const platformMocks = vi.hoisted(() => ({
  readFileWithinRoot: vi.fn(),
}));

vi.mock("../src/platform/files", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readFileWithinRoot: platformMocks.readFileWithinRoot,
  };
});

import { SynchronizedFileChangedError } from "../src/platform/files";
import { readRepositoryManifest } from "../src/protocol/repository";

afterEach(() => {
  vi.restoreAllMocks();
  platformMocks.readFileWithinRoot.mockReset();
});

describe("shared repository manifest read races", () => {
  it("retries a manifest replaced by the sync provider during its first read", async () => {
    const repository = {
      version: 1,
      repositoryId: "repository-id",
    };
    platformMocks.readFileWithinRoot
      .mockRejectedValueOnce(
        new SynchronizedFileChangedError("repo.json", "read"),
      )
      .mockResolvedValueOnce(
        Buffer.from(`${JSON.stringify(repository)}\n`, "utf8"),
      );

    await expect(readRepositoryManifest("C:/shared")).resolves.toEqual(
      repository,
    );
    expect(platformMocks.readFileWithinRoot).toHaveBeenCalledTimes(2);
  });

  it("does not retry a persistent manifest validation failure", async () => {
    platformMocks.readFileWithinRoot.mockRejectedValueOnce(
      new Error("Synchronized path contains a symbolic link or junction: repo.json"),
    );

    await expect(readRepositoryManifest("C:/shared")).rejects.toThrow(
      "symbolic link or junction",
    );
    expect(platformMocks.readFileWithinRoot).toHaveBeenCalledTimes(1);
  });
});
