import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeRepositoryLocation,
  normalizeComparisonPath,
  pathsOverlap,
} from "../src/sync/repositoryPath";

describe("repository path isolation", () => {
  it("rejects a repository nested inside a synchronized source", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-sync-path-"));
    try {
      const source = join(temporaryRoot, "Cursor", "User");
      const repository = join(source, "shared-repository");
      await mkdir(repository, { recursive: true });

      await expect(
        assertSafeRepositoryLocation(repository, [
          { label: "Cursor user data", path: source },
        ]),
      ).rejects.toThrow(/must not contain or be contained/i);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a synchronized source nested inside the repository", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-sync-path-"));
    try {
      const repository = join(temporaryRoot, "shared-repository");
      const source = join(repository, "Cursor", "User");
      await mkdir(source, { recursive: true });

      await expect(
        assertSafeRepositoryLocation(repository, [
          { label: "Cursor user data", path: source },
        ]),
      ).rejects.toThrow(/must not contain or be contained/i);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("allows sibling directories", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cursor-sync-path-"));
    try {
      const repository = join(temporaryRoot, "shared-repository");
      const source = join(temporaryRoot, "Cursor", "User");
      await mkdir(repository, { recursive: true });
      await mkdir(source, { recursive: true });

      await expect(
        assertSafeRepositoryLocation(repository, [
          { label: "Cursor user data", path: source },
        ]),
      ).resolves.toBeUndefined();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("compares Windows paths case-insensitively", () => {
    if (process.platform === "win32") {
      expect(pathsOverlap("C:/Cursor/User", "c:/cursor/user/profiles")).toBe(
        true,
      );
    }
  });

  it("folds path case on Windows and macOS but not on Linux", () => {
    expect(normalizeComparisonPath("Cursor/USER", "win32")).toBe(
      normalizeComparisonPath("cursor/user", "win32"),
    );
    expect(normalizeComparisonPath("Cursor/USER", "darwin")).toBe(
      normalizeComparisonPath("cursor/user", "darwin"),
    );
    expect(normalizeComparisonPath("Cursor/USER", "linux")).not.toBe(
      normalizeComparisonPath("cursor/user", "linux"),
    );
    expect(pathsOverlap("Cursor/User", "cursor/user/profiles", "darwin")).toBe(
      true,
    );
  });
});
