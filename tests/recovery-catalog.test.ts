import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RECOVERY_CATALOG_LIMITS,
  RecoveryCatalogInventoryCancelledError,
  RecoveryCatalogLimitError,
  acquireRecoveryCatalogBuildSession,
  readRecoveryCatalog,
  recoveryCatalogEntryArtifactPaths,
  upsertRecoveryCatalogEntries,
  upsertRecoveryCatalogEntry,
  type RecoveryCatalogManifestV1,
  type RecoveryCatalogUpsertInput,
} from "../src/chat/recoveryCatalog";
import { sha256 } from "../src/protocol/canonical";
import {
  visibleRecoveryCatalogComposerKey,
  type VisibleChatRecoveryArtifact,
} from "../src/chat/visibleRecovery";

const COMPOSER_A = "11111111-1111-4111-8111-111111111111";
const COMPOSER_B = "22222222-2222-4222-8222-222222222222";
const CORE_A = sha256("core-a");
const CORE_B = sha256("core-b");
const DAMAGE_A = sha256("damage-a");
const DAMAGE_B = sha256("damage-b");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("recovery catalog", () => {
  it("atomically stores a bounded batch with relative content-addressed files", async () => {
    const root = await temporaryStorage();
    const artifact = await createArtifact(
      root,
      COMPOSER_A,
      Buffer.from("private recovered transcript", "utf8"),
      Buffer.from("png fixture", "utf8"),
    );

    const result = await upsertRecoveryCatalogEntries(root, [
      readyInput(COMPOSER_A, CORE_A, DAMAGE_A, artifact, 200, "Title\n# injected"),
      {
        composerId: COMPOSER_B,
        composerStorageClass: "text",
        chatCoreHash: CORE_B,
        damageFingerprint: DAMAGE_B,
        title: null,
        lastUpdatedAt: 100,
        status: "skipped-body",
      },
    ]);

    expect(result.manifest.entries.map((entry) => entry.status)).toEqual([
      "ready",
      "skipped-body",
    ]);
    expect(result.capacity).toMatchObject({
      entryCount: 2,
      readyArtifactBytes:
        Buffer.byteLength("private recovered transcript") +
        Buffer.byteLength("png fixture"),
      remainingEntries: RECOVERY_CATALOG_LIMITS.maxEntries - 2,
    });
    const raw = await readFile(result.manifestPath, "utf8");
    expect(raw).not.toContain(root);
    expect(raw).not.toContain("private recovered transcript");
    expect(raw).not.toMatch(/[A-Za-z]:\\/u);
    const ready = result.manifest.entries[0];
    expect(ready?.status).toBe("ready");
    if (ready?.status !== "ready") {
      throw new Error("Expected a ready catalog entry.");
    }
    expect(ready.artifact.transcript.relativePath).toMatch(
      new RegExp(
        `^recovery-transcripts/catalog-v1-artifacts/recovered-${visibleRecoveryCatalogComposerKey(COMPOSER_A, "text")}/visible-[0-9a-f]{64}\\.md$`,
      ),
    );
    expect(ready.artifact.images[0]?.relativePath).toMatch(
      new RegExp(
        `^recovery-transcripts/catalog-v1-artifacts/recovered-${visibleRecoveryCatalogComposerKey(COMPOSER_A, "text")}/image-[0-9a-f]{64}\\.png$`,
      ),
    );

    const index = await readFile(result.indexPath, "utf8");
    expect(index).toContain(
      "Original Cursor conversations and databases remain unchanged.",
    );
    expect(index).toContain("plaintext files retained");
    expect(index).toContain(COMPOSER_A);
    expect(index).toContain("Title \\# injected");
    expect(index).not.toContain("\n# injected");
    expect(index).not.toContain(root);
    expect(index).toContain(
      `./${ready.artifact.transcript.relativePath.slice("recovery-transcripts/".length)}`,
    );
    expect(
      await readFile(
        join(dirname(result.indexPath), ready.artifact.transcript.relativePath.slice("recovery-transcripts/".length)),
        "utf8",
      ),
    ).toBe("private recovered transcript");

    const paths = await recoveryCatalogEntryArtifactPaths(root, ready);
    expect(paths).toEqual([
      artifact.path,
      artifact.imageAttachments[0]?.path,
    ]);
  });

  it("keeps one current generation per exact composer and retains superseded files", async () => {
    const root = await temporaryStorage();
    const firstArtifact = await createArtifact(
      root,
      COMPOSER_A,
      Buffer.from("first", "utf8"),
    );
    const first = readyInput(
      COMPOSER_A,
      CORE_A,
      DAMAGE_A,
      firstArtifact,
      100,
      "Before",
    );
    await upsertRecoveryCatalogEntry(root, first);
    const firstManifest = await readFile(
      join(root, "recovery-transcripts", "catalog-v1.json"),
    );
    await upsertRecoveryCatalogEntry(root, first);
    expect(
      await readFile(join(root, "recovery-transcripts", "catalog-v1.json")),
    ).toEqual(firstManifest);

    const secondArtifact = await createArtifact(
      root,
      COMPOSER_A,
      Buffer.from("second", "utf8"),
    );
    const replaced = await upsertRecoveryCatalogEntry(
      root,
      readyInput(
        COMPOSER_A,
        CORE_B,
        DAMAGE_B,
        secondArtifact,
        101,
        "After",
      ),
    );
    expect(replaced.manifest.entries).toHaveLength(1);
    expect(replaced.manifest.entries[0]?.title).toBe("After");
    expect(replaced.manifest.entries[0]?.chatCoreHash).toBe(CORE_B);
    expect(replaced.manifest.entries[0]?.damageFingerprint).toBe(DAMAGE_B);
    await expect(stat(firstArtifact.path)).resolves.toBeDefined();
    await expect(stat(secondArtifact.path)).resolves.toBeDefined();
  });

  it("lets a caller replace a known-corrupt ready entry with a non-ready observation", async () => {
    const root = await temporaryStorage();
    const prior = await createArtifact(
      root,
      COMPOSER_A,
      Buffer.from("prior-ready", "utf8"),
    );
    await upsertRecoveryCatalogEntry(
      root,
      readyInput(COMPOSER_A, CORE_A, DAMAGE_A, prior),
    );
    await writeFile(prior.path, Buffer.from("corrupt prior bytes", "utf8"));

    const replaced = await upsertRecoveryCatalogEntry(root, {
      composerId: COMPOSER_A,
      composerStorageClass: "text",
      chatCoreHash: CORE_B,
      damageFingerprint: DAMAGE_B,
      title: "Current observation",
      lastUpdatedAt: 300,
      status: "changed",
    });

    expect(replaced.manifest.entries).toHaveLength(1);
    expect(replaced.manifest.entries[0]).toEqual({
      composerId: COMPOSER_A,
      composerStorageClass: "text",
      chatCoreHash: CORE_B,
      damageFingerprint: DAMAGE_B,
      title: "Current observation",
      lastUpdatedAt: 300,
      status: "changed",
    });
    await expect(stat(prior.path)).resolves.toBeDefined();
  });

  it("serializes concurrent upserts without losing either checkpoint", async () => {
    const root = await temporaryStorage();
    await Promise.all([
      upsertRecoveryCatalogEntry(root, {
        composerId: COMPOSER_A,
        composerStorageClass: "text",
        chatCoreHash: CORE_A,
        damageFingerprint: DAMAGE_A,
        title: "A",
        status: "unknown",
      }),
      upsertRecoveryCatalogEntry(root, {
        composerId: COMPOSER_B,
        composerStorageClass: "text",
        chatCoreHash: CORE_B,
        damageFingerprint: DAMAGE_B,
        title: "B",
        status: "changed",
      }),
    ]);

    const catalog = await readRecoveryCatalog(root);
    expect(catalog.manifest.entries.map((entry) => entry.composerId).sort()).toEqual(
      [COMPOSER_A, COMPOSER_B],
    );
  });

  it("rejects duplicate composer IDs in one batch without changing the manifest", async () => {
    const root = await temporaryStorage();
    const before = await readRecoveryCatalog(root);
    await expect(
      upsertRecoveryCatalogEntries(root, [
        {
          composerId: COMPOSER_A,
          composerStorageClass: "text",
          chatCoreHash: CORE_A,
          damageFingerprint: DAMAGE_A,
          title: "first",
          status: "unknown",
        },
        {
          composerId: COMPOSER_A,
          composerStorageClass: "text",
          chatCoreHash: CORE_B,
          damageFingerprint: DAMAGE_B,
          title: "second",
          status: "changed",
        },
      ]),
    ).rejects.toThrow(/same exact composer identity more than once/iu);
    expect((await readRecoveryCatalog(root)).manifest).toEqual(before.manifest);
  });

  it("keeps case-distinct composer artifact namespaces isolated", async () => {
    const root = await temporaryStorage();
    const lower = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const upper = lower.toUpperCase();
    const lowerArtifact = await createArtifact(
      root,
      lower,
      Buffer.from("lower", "utf8"),
    );
    const upperArtifact = await createArtifact(
      root,
      upper,
      Buffer.from("upper", "utf8"),
    );
    expect(dirname(lowerArtifact.path)).not.toBe(dirname(upperArtifact.path));
    await upsertRecoveryCatalogEntries(root, [
      readyInput(lower, CORE_A, DAMAGE_A, lowerArtifact),
      readyInput(upper, CORE_B, DAMAGE_B, upperArtifact),
    ]);
    await upsertRecoveryCatalogEntry(root, {
      composerId: lower,
      composerStorageClass: "text",
      chatCoreHash: CORE_A,
      damageFingerprint: DAMAGE_A,
      title: "lower retired",
      status: "changed",
    });
    await expect(stat(lowerArtifact.path)).resolves.toBeDefined();
    await expect(stat(upperArtifact.path)).resolves.toBeDefined();
  });

  it("keeps TEXT and BLOB rows with the same decoded composer ID distinct", async () => {
    const root = await temporaryStorage();
    const textArtifact = await createArtifact(
      root,
      COMPOSER_A,
      Buffer.from("text storage", "utf8"),
    );
    const blobArtifact = await createArtifact(
      root,
      COMPOSER_A,
      Buffer.from("blob storage", "utf8"),
      undefined,
      "blob",
    );
    expect(dirname(textArtifact.path)).not.toBe(dirname(blobArtifact.path));

    const result = await upsertRecoveryCatalogEntries(root, [
      readyInput(COMPOSER_A, CORE_A, DAMAGE_A, textArtifact),
      readyInput(
        COMPOSER_A,
        CORE_B,
        DAMAGE_B,
        blobArtifact,
        null,
        "BLOB row",
        "blob",
      ),
    ]);

    expect(result.manifest.entries).toHaveLength(2);
    expect(
      result.manifest.entries.map((entry) => entry.composerStorageClass).sort(),
    ).toEqual(["blob", "text"]);
    await expect(stat(textArtifact.path)).resolves.toBeDefined();
    await expect(stat(blobArtifact.path)).resolves.toBeDefined();
  });

  it("serializes physical inventory and reserves quota before writes", async () => {
    const root = await temporaryStorage();
    const first = await acquireRecoveryCatalogBuildSession(root);
    expect(first).not.toBeNull();
    if (first === null) {
      throw new Error("Expected a recovery catalog build session.");
    }
    try {
      expect(await acquireRecoveryCatalogBuildSession(root)).toBeNull();
      first.reserveArtifact(
        RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes,
        1,
      );
      expect(first.physicalBytes).toBe(
        RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes,
      );
      expect(() => first.reserveArtifact(1, 1)).toThrowError(
        expect.objectContaining({
          code: "RECOVERY_CATALOG_LIMIT",
          reason: "physical-artifact-bytes",
        }),
      );
    } finally {
      await first.release();
    }
    const next = await acquireRecoveryCatalogBuildSession(root);
    expect(next).not.toBeNull();
    await next?.release();
  });

  it("counts atomic-write partials and unknown regular leaf files", async () => {
    const root = await temporaryStorage();
    const directory = join(
      root,
      "recovery-transcripts",
      "catalog-v1-artifacts",
      `recovered-${visibleRecoveryCatalogComposerKey(COMPOSER_A, "text")}`,
    );
    await mkdir(directory, { recursive: true });
    const artifactRootMetadata = join(
      root,
      "recovery-transcripts",
      "catalog-v1-artifacts",
      ".DS_Store",
    );
    await writeFile(artifactRootMetadata, "meta");
    const partial = join(
      directory,
      `visible-${sha256("partial")}.md.4242.22222222-2222-4222-8222-222222222222.partial`,
    );
    await writeFile(partial, "partial");
    const catalogPartial = join(
      root,
      "recovery-transcripts",
      "catalog-v1.json.4242.33333333-3333-4333-8333-333333333333.partial",
    );
    await writeFile(catalogPartial, "catalog-partial");
    const session = await acquireRecoveryCatalogBuildSession(root);
    expect(session).toMatchObject({ physicalBytes: 11, physicalFiles: 2 });
    await session?.release();

    const unknown = join(directory, "unknown.txt");
    await writeFile(unknown, "x");
    const withUnknown = await acquireRecoveryCatalogBuildSession(root);
    expect(withUnknown).toMatchObject({ physicalBytes: 12, physicalFiles: 3 });
    await withUnknown?.release();
    await rm(unknown);
    await mkdir(unknown);
    await expect(acquireRecoveryCatalogBuildSession(root)).rejects.toMatchObject({
      code: "RECOVERY_CATALOG_LIMIT",
      reason: "physical-inventory",
    });
    await rm(unknown, { recursive: true });
    const retry = await acquireRecoveryCatalogBuildSession(root);
    expect(retry).not.toBeNull();
    await retry?.release();
  });

  it("keeps metadata atomic-write debris under a separate hard cap", async () => {
    const root = await temporaryStorage();
    const directory = join(root, "recovery-transcripts");
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      const partial = join(
        directory,
        `catalog-v1.json.4242.55555555-5555-4555-8555-${index.toString().padStart(12, "0")}.partial`,
      );
      await writeFile(partial, "");
      await truncate(partial, RECOVERY_CATALOG_LIMITS.maxManifestBytes);
    }
    const exact = await acquireRecoveryCatalogBuildSession(root);
    expect(exact).not.toBeNull();
    await exact?.release();

    const overflow = join(
      directory,
      "index.md.4242.66666666-6666-4666-8666-666666666666.partial",
    );
    await writeFile(overflow, "x");
    await expect(acquireRecoveryCatalogBuildSession(root)).rejects.toMatchObject({
      code: "RECOVERY_CATALOG_LIMIT",
      reason: "metadata-partial-bytes",
      limit: RECOVERY_CATALOG_LIMITS.maxMetadataPartialBytes,
    });
  });

  it("deduplicates hardlinked final/partial crash pairs but counts both entries", async () => {
    const root = await temporaryStorage();
    const artifact = await createArtifact(
      root,
      COMPOSER_A,
      Buffer.from("hardlink crash pair", "utf8"),
    );
    const partial = `${artifact.path}.4242.44444444-4444-4444-8444-444444444444.partial`;
    await link(artifact.path, partial);
    const session = await acquireRecoveryCatalogBuildSession(root);
    expect(session).toMatchObject({
      physicalBytes: Buffer.byteLength("hardlink crash pair"),
      physicalFiles: 2,
    });
    await session?.release();
  });

  it("observes cancellation while walking physical inventory and releases the build lock", async () => {
    const root = await temporaryStorage();
    await createArtifact(root, COMPOSER_A, Buffer.from("one", "utf8"));
    await createArtifact(root, COMPOSER_B, Buffer.from("two", "utf8"));
    let checks = 0;
    await expect(
      acquireRecoveryCatalogBuildSession(root, () => {
        checks += 1;
        return checks >= 4;
      }),
    ).rejects.toBeInstanceOf(RecoveryCatalogInventoryCancelledError);
    expect(checks).toBeGreaterThanOrEqual(4);
    const retry = await acquireRecoveryCatalogBuildSession(root);
    expect(retry).not.toBeNull();
    await retry?.release();
  });

  it("rejects an artifact outside storage and leaves the manifest unchanged", async () => {
    const root = await temporaryStorage();
    const outside = await mkdtemp(join(tmpdir(), "cursor-recovery-outside-"));
    roots.push(outside);
    const bytes = Buffer.from("outside", "utf8");
    const hash = sha256(bytes);
    const path = join(outside, `visible-${hash}.md`);
    await writeFile(path, bytes);
    const artifact: VisibleChatRecoveryArtifact = {
      path,
      transcriptHash: hash,
      imageAttachments: [],
    };

    await expect(
      upsertRecoveryCatalogEntry(
        root,
        readyInput(COMPOSER_A, CORE_A, DAMAGE_A, artifact),
      ),
    ).rejects.toThrow(/path|outside|escape/iu);
    const catalog = await readRecoveryCatalog(root);
    expect(catalog.manifest.entries).toEqual([]);
  });

  it("revalidates ready artifacts and refuses changed bytes", async () => {
    const root = await temporaryStorage();
    const artifact = await createArtifact(
      root,
      COMPOSER_A,
      Buffer.from("original", "utf8"),
    );
    const result = await upsertRecoveryCatalogEntry(
      root,
      readyInput(COMPOSER_A, CORE_A, DAMAGE_A, artifact),
    );
    const entry = result.manifest.entries[0];
    if (entry === undefined) {
      throw new Error("Expected one catalog entry.");
    }
    await writeFile(artifact.path, Buffer.from("tampered", "utf8"));
    await expect(
      recoveryCatalogEntryArtifactPaths(root, entry),
    ).rejects.toThrow(/verification/iu);
  });

  it("strictly bounds manifest size, structure, entry count, and artifact quota", async () => {
    const root = await temporaryStorage();
    const manifestPath = join(root, "recovery-transcripts", "catalog-v1.json");
    await mkdir(dirname(manifestPath), { recursive: true });

    await writeFile(
      manifestPath,
      Buffer.alloc(RECOVERY_CATALOG_LIMITS.maxManifestBytes + 1, 0x20),
    );
    await expect(readRecoveryCatalog(root)).rejects.toThrow(/size limit/iu);

    await writeFile(
      manifestPath,
      `{"schemaVersion":1,"entries":${"[".repeat(40)}${"]".repeat(40)}}`,
    );
    await expect(readRecoveryCatalog(root)).rejects.toThrow(/structural safety/iu);

    const tooMany: RecoveryCatalogManifestV1 = {
      schemaVersion: 1,
      entries: Array.from(
        { length: RECOVERY_CATALOG_LIMITS.maxEntries + 1 },
        (_unused, index) => ({
          composerId: composerIdFor(index),
          composerStorageClass: "text" as const,
          chatCoreHash: CORE_A,
          damageFingerprint: DAMAGE_A,
          title: null,
          lastUpdatedAt: null,
          status: "unknown" as const,
        }),
      ),
    };
    await writeFile(manifestPath, JSON.stringify(tooMany));
    await expect(readRecoveryCatalog(root)).rejects.toMatchObject({
      code: "RECOVERY_CATALOG_LIMIT",
      reason: "entries",
    });

    const quotaManifest: RecoveryCatalogManifestV1 = {
      schemaVersion: 1,
      entries: Array.from({ length: 16 }, (_unused, index) => {
        const composerId = composerIdFor(index);
        const transcriptHash = sha256(`quota-transcript-${index}`);
        const imageOneHash = sha256(`quota-image-a-${index}`);
        const imageTwoHash = sha256(`quota-image-b-${index}`);
        return {
          composerId,
          composerStorageClass: "text" as const,
          chatCoreHash: CORE_A,
          damageFingerprint: sha256(`quota-damage-${index}`),
          title: null,
          lastUpdatedAt: null,
          status: "ready" as const,
          artifact: {
            transcript: {
              relativePath: artifactRelativePath(
                composerId,
                "visible",
                transcriptHash,
                ".md",
              ),
              sha256: transcriptHash,
              byteLength: 1024 * 1024,
            },
            images: [imageOneHash, imageTwoHash].map((hash) => ({
              relativePath: artifactRelativePath(
                composerId,
                "image",
                hash,
                ".png",
              ),
              sha256: hash,
              byteLength: 16 * 1024 * 1024,
              mimeType: "image/png" as const,
            })),
          },
        };
      }),
    };
    await writeFile(manifestPath, JSON.stringify(quotaManifest));
    await expect(readRecoveryCatalog(root)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RecoveryCatalogLimitError &&
        error.reason === "artifact-bytes" &&
        error.limit === RECOVERY_CATALOG_LIMITS.maxReadyArtifactBytes,
    );
  });

  it("keeps the generated index within its fixed byte bound", async () => {
    const root = await temporaryStorage();
    const entries: RecoveryCatalogUpsertInput[] = Array.from(
      { length: RECOVERY_CATALOG_LIMITS.maxEntries },
      (_unused, index) => ({
        composerId: composerIdFor(index),
        composerStorageClass: "text" as const,
        chatCoreHash: CORE_A,
        damageFingerprint: sha256(`index-damage-${index}`),
        title: `Long title ${index} ${"가".repeat(300)}`,
        lastUpdatedAt: index,
        status: "unknown",
      }),
    );
    const result = await upsertRecoveryCatalogEntries(root, entries);
    expect((await stat(result.indexPath)).size).toBeLessThanOrEqual(
      RECOVERY_CATALOG_LIMITS.maxIndexBytes,
    );
    expect(await readFile(result.indexPath, "utf8")).toContain(
      "additional catalog entries were omitted",
    );
  });

  it("keeps an uncataloged artifact when a quota rejects its checkpoint", async () => {
    const root = await temporaryStorage();
    const manifestPath = join(root, "recovery-transcripts", "catalog-v1.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    const full: RecoveryCatalogManifestV1 = {
      schemaVersion: 1,
      entries: Array.from({ length: 16 }, (_unused, index) => {
        const composerId = composerIdFor(index);
        const transcriptHash = sha256(`full-transcript-${index}`);
        const imageHashes = [
          sha256(`full-image-a-${index}`),
          sha256(`full-image-b-${index}`),
        ];
        return {
          composerId,
          composerStorageClass: "text" as const,
          chatCoreHash: CORE_A,
          damageFingerprint: sha256(`full-damage-${index}`),
          title: null,
          lastUpdatedAt: null,
          status: "ready" as const,
          artifact: {
            transcript: {
              relativePath: artifactRelativePath(
                composerId,
                "visible",
                transcriptHash,
                ".md",
              ),
              sha256: transcriptHash,
              byteLength: 0,
            },
            images: imageHashes.map((hash) => ({
              relativePath: artifactRelativePath(
                composerId,
                "image",
                hash,
                ".png",
              ),
              sha256: hash,
              byteLength: 16 * 1024 * 1024,
              mimeType: "image/png" as const,
            })),
          },
        };
      }),
    };
    await writeFile(manifestPath, JSON.stringify(full));
    const rejected = await createArtifact(
      root,
      COMPOSER_A,
      Buffer.from("quota-rejected", "utf8"),
    );

    await expect(
      upsertRecoveryCatalogEntry(
        root,
        readyInput(COMPOSER_A, CORE_B, DAMAGE_B, rejected),
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_CATALOG_LIMIT",
      reason: "artifact-bytes",
    });
    await expect(stat(rejected.path)).resolves.toBeDefined();
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(full);
  });
});

async function temporaryStorage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cursor-recovery-catalog-"));
  roots.push(root);
  return root;
}

function readyInput(
  composerId: string,
  chatCoreHash: string,
  damageFingerprint: string,
  artifact: VisibleChatRecoveryArtifact,
  lastUpdatedAt: number | null = null,
  title: string | null = "Recovered",
  composerStorageClass: "text" | "blob" = "text",
): RecoveryCatalogUpsertInput {
  return {
    composerId,
    composerStorageClass,
    chatCoreHash,
    damageFingerprint,
    title,
    lastUpdatedAt,
    status: "ready",
    artifact,
  };
}

async function createArtifact(
  root: string,
  composerId: string,
  transcriptBytes: Buffer,
  imageBytes?: Buffer,
  composerStorageClass: "text" | "blob" = "text",
): Promise<VisibleChatRecoveryArtifact> {
  const transcriptHash = sha256(transcriptBytes);
  const transcriptPath = join(
    root,
    artifactRelativePath(
      composerId,
      "visible",
      transcriptHash,
      ".md",
      composerStorageClass,
    ),
  );
  await mkdir(dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, transcriptBytes);
  const imageAttachments: VisibleChatRecoveryArtifact["imageAttachments"] =
    imageBytes === undefined
      ? []
      : [
          {
            path: join(
              root,
              artifactRelativePath(
                composerId,
                "image",
                sha256(imageBytes),
                ".png",
                composerStorageClass,
              ),
            ),
            hash: sha256(imageBytes),
            mimeType: "image/png",
            byteLength: imageBytes.byteLength,
          },
        ];
  for (const image of imageAttachments) {
    if (imageBytes === undefined) {
      throw new Error("Expected image bytes for the attachment fixture.");
    }
    await writeFile(image.path, imageBytes);
  }
  return {
    path: transcriptPath,
    transcriptHash,
    imageAttachments,
  };
}

function artifactRelativePath(
  composerId: string,
  prefix: "visible" | "image",
  hash: string,
  suffix: ".md" | ".png",
  composerStorageClass: "text" | "blob" = "text",
): string {
  return `recovery-transcripts/catalog-v1-artifacts/recovered-${visibleRecoveryCatalogComposerKey(composerId, composerStorageClass)}/${prefix}-${hash}${suffix}`;
}

function composerIdFor(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;
}
