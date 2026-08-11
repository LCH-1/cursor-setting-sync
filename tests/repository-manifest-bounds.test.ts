import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REPOSITORY_FILE } from "../src/constants";
import {
  MAX_REPOSITORY_FILE_BYTES,
  readRepositoryManifest,
} from "../src/protocol/repository";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("shared repository manifest read envelope", () => {
  it("rejects a sparse oversized manifest before extension/helper JSON parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "repository-manifest-bound-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    const manifest = join(root, REPOSITORY_FILE);
    await writeFile(manifest, "{}", "utf8");
    await truncate(manifest, MAX_REPOSITORY_FILE_BYTES + 1);
    const parse = vi.spyOn(JSON, "parse");

    await expect(readRepositoryManifest(root)).rejects.toThrow(
      "exceeds its size limit",
    );

    expect(parse).not.toHaveBeenCalled();
  });
});
