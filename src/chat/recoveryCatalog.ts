import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  assertRealDirectory,
  assertSafeRelativePath,
  assertSafeRelativePathOnDisk,
  ensureDirectory,
  ensureDirectoryWithinRoot,
  isMissingPathError,
  normalizeResourcePath,
  pathExists,
  readFileWithinRoot,
  writeFileAtomicWithinRoot,
} from "../platform/files";
import {
  acquireFileLockWithin,
  type FileLock,
} from "../platform/lock";
import { canonicalBytes, sha256 } from "../protocol/canonical";
import { buffersFitJsonStructureBudget } from "../protocol/jsonStructure";
import {
  DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS,
  type VisibleChatRecoveryArtifact,
  visibleRecoveryCatalogComposerKey,
} from "./visibleRecovery";
import type { ComposerIdStorageClass } from "./repair";
import { isSyncableComposerId } from "./stateVscdb";

export type RecoveryCatalogStatus =
  | "ready"
  | "skipped-limit"
  | "skipped-body"
  | "changed"
  | "unknown";

export interface RecoveryCatalogUpsertInput {
  composerId: string;
  composerStorageClass: ComposerIdStorageClass;
  chatCoreHash: string;
  damageFingerprint: string;
  title: string | null;
  lastUpdatedAt?: number | null;
  status: RecoveryCatalogStatus;
  /** The absolute-path result returned by writeVisibleChatRecoveryArtifact. */
  artifact?: VisibleChatRecoveryArtifact;
}

export interface RecoveryCatalogStoredFile {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface RecoveryCatalogStoredImage extends RecoveryCatalogStoredFile {
  mimeType: "image/png";
}

export interface RecoveryCatalogStoredArtifact {
  transcript: RecoveryCatalogStoredFile;
  images: RecoveryCatalogStoredImage[];
}

interface RecoveryCatalogEntryBase {
  composerId: string;
  composerStorageClass: ComposerIdStorageClass;
  chatCoreHash: string;
  damageFingerprint: string;
  title: string | null;
  lastUpdatedAt: number | null;
}

export interface RecoveryCatalogReadyEntry extends RecoveryCatalogEntryBase {
  status: "ready";
  artifact: RecoveryCatalogStoredArtifact;
}

export interface RecoveryCatalogNonReadyEntry
  extends RecoveryCatalogEntryBase {
  status: Exclude<RecoveryCatalogStatus, "ready">;
}

export type RecoveryCatalogEntry =
  | RecoveryCatalogReadyEntry
  | RecoveryCatalogNonReadyEntry;

export interface RecoveryCatalogManifestV1 {
  schemaVersion: 1;
  entries: RecoveryCatalogEntry[];
}

export interface RecoveryCatalogResult {
  manifest: RecoveryCatalogManifestV1;
  capacity: RecoveryCatalogCapacity;
  /** Absolute runtime path. Absolute paths are never persisted in the catalog. */
  manifestPath: string;
  /** Absolute runtime path to the bounded human-readable catalog. */
  indexPath: string;
}

export interface RecoveryCatalogCapacity {
  entryCount: number;
  readyArtifactBytes: number;
  remainingEntries: number;
  remainingReadyArtifactBytes: number;
}

export type RecoveryCatalogLimitReason =
  | "entries"
  | "artifact-bytes"
  | "manifest-bytes"
  | "manifest-structure"
  | "physical-artifact-bytes"
  | "physical-artifact-files"
  | "physical-inventory"
  | "metadata-partial-bytes"
  | "metadata-partial-files";

export class RecoveryCatalogLimitError extends Error {
  readonly code = "RECOVERY_CATALOG_LIMIT";

  constructor(
    readonly reason: RecoveryCatalogLimitReason,
    readonly limit: number,
    readonly attempted: number,
  ) {
    super(
      `Recovery catalog ${reason} limit was exceeded (${attempted} > ${limit}).`,
    );
    this.name = "RecoveryCatalogLimitError";
  }
}

export const RECOVERY_CATALOG_LIMITS = Object.freeze({
  maxManifestBytes: 8 * 1024 * 1024,
  maxIndexBytes: 1024 * 1024,
  maxEntries: 2_000,
  maxReadyArtifactBytes: 512 * 1024 * 1024,
  maxPhysicalArtifactBytes: 512 * 1024 * 1024,
  maxPhysicalArtifactFiles:
    2_000 * (DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxSelectedImages + 1),
  maxMetadataPartialBytes: 32 * 1024 * 1024,
  maxMetadataPartialFiles: 16,
  maxTitleBytes: 1024,
  maxJsonStructuralTokens: 262_144,
  maxJsonDepth: 32,
  lockTimeoutMs: 10_000,
});

const RECOVERY_DIRECTORY = "recovery-transcripts";
const CATALOG_ARTIFACT_DIRECTORY =
  "recovery-transcripts/catalog-v1-artifacts";
const MANIFEST_RELATIVE_PATH = `${RECOVERY_DIRECTORY}/catalog-v1.json`;
const INDEX_RELATIVE_PATH = `${RECOVERY_DIRECTORY}/index.md`;
// Keep the lock directly below the already validated extension-storage root;
// no intermediate path can be exchanged for a junction before lock creation.
const LOCK_FILE_NAME = "recovery-catalog-v1.lock";
const BUILD_LOCK_FILE_NAME = "recovery-catalog-build-v1.lock";
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const RECOVERY_ARTIFACT_FILE_PATTERN =
  /^(?:visible-[0-9a-f]{64}\.md|image-[0-9a-f]{64}\.png)$/u;
const RECOVERY_ARTIFACT_PARTIAL_FILE_PATTERN =
  /^(?:visible-[0-9a-f]{64}\.md|image-[0-9a-f]{64}\.png)\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$/u;
const RECOVERY_CATALOG_ROOT_PARTIAL_PATTERN =
  /^(?:catalog-v1\.json|index\.md)\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$/u;
const STATUS_VALUES = new Set<RecoveryCatalogStatus>([
  "ready",
  "skipped-limit",
  "skipped-body",
  "changed",
  "unknown",
]);
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

/**
 * Atomically updates every supplied observation under one catalog lock.
 * One composer has one current catalog generation. Repeating the composer ID
 * replaces its prior core/fingerprint generation instead of leaving a stale
 * ready artifact selectable beside the current damage observation.
 */
export async function upsertRecoveryCatalogEntries(
  extensionStorage: string,
  inputs: readonly RecoveryCatalogUpsertInput[],
): Promise<RecoveryCatalogResult> {
  if (inputs.length > RECOVERY_CATALOG_LIMITS.maxEntries) {
    throw new RecoveryCatalogLimitError(
      "entries",
      RECOVERY_CATALOG_LIMITS.maxEntries,
      inputs.length,
    );
  }
  return withRecoveryCatalogLock(extensionStorage, async (root) => {
    const loaded = await loadRecoveryCatalog(root);
    const selectedInputs = normalizeAndDeduplicateInputs(inputs);
    const replacements: RecoveryCatalogEntry[] = [];
    for (const input of selectedInputs.values()) {
      replacements.push(await materializeInput(root, input));
    }

    const byIdentity = new Map(
      loaded.manifest.entries.map((entry) => [entryIdentity(entry), entry]),
    );
    for (const entry of replacements) {
      byIdentity.set(entryIdentity(entry), entry);
    }
    if (byIdentity.size > RECOVERY_CATALOG_LIMITS.maxEntries) {
      throw new RecoveryCatalogLimitError(
        "entries",
        RECOVERY_CATALOG_LIMITS.maxEntries,
        byIdentity.size,
      );
    }
    const manifest: RecoveryCatalogManifestV1 = {
      schemaVersion: 1,
      entries: [...byIdentity.values()].sort(compareEntries),
    };
    assertCatalogArtifactQuota(manifest);
    const manifestBytes = encodeManifest(manifest);
    if (!loaded.bytes?.equals(manifestBytes)) {
      await writeFileAtomicWithinRoot(
        root,
        MANIFEST_RELATIVE_PATH,
        manifestBytes,
      );
    }
    // Superseded derivatives are reaped only by the grace-bounded pruner.
    // Writers materialize files before taking this catalog lock, so immediate
    // deletion here could race another window's in-flight generation.
    await writeCatalogIndex(root, manifest);
    return catalogResult(root, manifest);
  });
}

export async function upsertRecoveryCatalogEntry(
  extensionStorage: string,
  input: RecoveryCatalogUpsertInput,
): Promise<RecoveryCatalogResult> {
  return upsertRecoveryCatalogEntries(extensionStorage, [input]);
}

/**
 * Loads and strictly validates the bounded v1 manifest. The derived index is
 * healed atomically when absent or stale, so callers can immediately open the
 * returned `indexPath` after a process restart.
 */
export async function readRecoveryCatalog(
  extensionStorage: string,
): Promise<RecoveryCatalogResult> {
  return withRecoveryCatalogLock(extensionStorage, async (root) => {
    const loaded = await loadRecoveryCatalog(root);
    if (loaded.bytes === null) {
      await writeFileAtomicWithinRoot(
        root,
        MANIFEST_RELATIVE_PATH,
        encodeManifest(loaded.manifest),
      );
    }
    await writeCatalogIndex(root, loaded.manifest);
    return catalogResult(root, loaded.manifest);
  });
}

export function isRecoveryCatalogReadyEntry(
  entry: RecoveryCatalogEntry,
): entry is RecoveryCatalogReadyEntry {
  return entry.status === "ready";
}

/**
 * Revalidates one ready entry's exact files immediately before a caller opens
 * or attaches them. The catalog read itself intentionally does not materialize
 * every transcript/image in a potentially large batch.
 */
export async function recoveryCatalogEntryArtifactPaths(
  extensionStorage: string,
  entry: RecoveryCatalogEntry,
): Promise<string[]> {
  await ensureDirectory(extensionStorage);
  const root = await assertRealDirectory(extensionStorage);
  const validated = validateStoredEntry(entry);
  if (validated.status !== "ready") {
    throw new Error("The recovery catalog entry has no ready artifact.");
  }
  const files: RecoveryCatalogStoredFile[] = [
    validated.artifact.transcript,
    ...validated.artifact.images,
  ];
  const paths: string[] = [];
  for (const file of files) {
    paths.push(await verifyStoredFile(root, file));
  }
  return paths;
}

export interface RecoveryCatalogBuildSession {
  readonly physicalBytes: number;
  readonly physicalFiles: number;
  reserveArtifact(totalBytes: number, fileCount: number): void;
  release(): Promise<void>;
}

/**
 * Serializes every production catalog artifact writer and inventories the
 * isolated artifact tree before a run. Exact reservation happens before each
 * bundle's first write, so failed or rejected derivatives still remain inside
 * the fixed physical byte/file ceilings without requiring automatic deletion.
 */
export async function acquireRecoveryCatalogBuildSession(
  extensionStorage: string,
  isCancelled: () => boolean = () => false,
): Promise<RecoveryCatalogBuildSession | null> {
  await ensureDirectory(extensionStorage);
  const root = await assertRealDirectory(extensionStorage);
  const lock = await acquireFileLockWithin(
    assertSafeRelativePath(root, BUILD_LOCK_FILE_NAME),
    1_000,
  );
  if (lock === null) {
    return null;
  }
  try {
    const inventory = await recoveryCatalogPhysicalInventory(
      root,
      isCancelled,
    );
    return createRecoveryCatalogBuildSession(lock, inventory);
  } catch (error) {
    await lock.release();
    throw error;
  }
}

function createRecoveryCatalogBuildSession(
  lock: FileLock,
  initial: { bytes: number; files: number },
): RecoveryCatalogBuildSession {
  let bytes = initial.bytes;
  let files = initial.files;
  return {
    get physicalBytes(): number {
      return bytes;
    },
    get physicalFiles(): number {
      return files;
    },
    reserveArtifact(totalBytes: number, fileCount: number): void {
      if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
        throw new RecoveryCatalogLimitError(
          "physical-inventory",
          RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes,
          RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes + 1,
        );
      }
      if (!Number.isSafeInteger(fileCount) || fileCount < 1) {
        throw new RecoveryCatalogLimitError(
          "physical-inventory",
          RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactFiles,
          RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactFiles + 1,
        );
      }
      const attemptedBytes = bytes + totalBytes;
      // writeFileAtomic(overwrite=false) briefly exposes the final hardlink
      // beside its temporary name. Writes are sequential, so one additional
      // directory entry covers the only crash-pair that can be in flight.
      const attemptedFiles = files + fileCount + 1;
      if (
        !Number.isSafeInteger(attemptedBytes) ||
        attemptedBytes > RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes
      ) {
        throw new RecoveryCatalogLimitError(
          "physical-artifact-bytes",
          RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes,
          attemptedBytes,
        );
      }
      if (
        !Number.isSafeInteger(attemptedFiles) ||
        attemptedFiles > RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactFiles
      ) {
        throw new RecoveryCatalogLimitError(
          "physical-artifact-files",
          RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactFiles,
          attemptedFiles,
        );
      }
      // Charge conservatively even when content-addressed paths already exist
      // or a later write fails. The next command re-inventories exact files.
      bytes = attemptedBytes;
      files += fileCount;
    },
    release: () => lock.release(),
  };
}

async function recoveryCatalogPhysicalInventory(
  root: string,
  isCancelled: () => boolean,
): Promise<{ bytes: number; files: number }> {
  if (isCancelled()) {
    throw new RecoveryCatalogInventoryCancelledError();
  }
  const inventory = { bytes: 0, files: 0 };
  const physicalInodes = new Set<string>();
  await inventoryRecoveryCatalogRootFiles(
    root,
    isCancelled,
  );
  const artifactRoot = await assertSafeRelativePathOnDisk(
    root,
    CATALOG_ARTIFACT_DIRECTORY,
    { allowMissing: true, finalType: "directory" },
  );
  if (!(await pathExists(artifactRoot))) {
    return inventory;
  }
  const rootBefore = await lstat(artifactRoot, { bigint: true });
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
    throw recoveryCatalogPhysicalInventoryError();
  }
  let directories = 0;
  const rootDirectory = await opendir(artifactRoot, { bufferSize: 1 });
  try {
    for (;;) {
      if (isCancelled()) {
        throw new RecoveryCatalogInventoryCancelledError();
      }
      const entry = await rootDirectory.read();
      if (entry === null) {
        break;
      }
      const recoveredDirectory = /^recovered-[0-9a-f]{64}$/u.test(
        entry.name,
      );
      if (!recoveredDirectory) {
        if (!entry.isFile()) {
          throw recoveryCatalogPhysicalInventoryError();
        }
        const relativePath = `${CATALOG_ARTIFACT_DIRECTORY}/${entry.name}`;
        let path: string;
        try {
          path = await assertSafeRelativePathOnDisk(root, relativePath, {
            finalType: "file",
          });
        } catch (error) {
          if (isMissingPathError(error)) {
            throw recoveryCatalogPhysicalInventoryError();
          }
          throw error;
        }
        const value = await lstat(path, { bigint: true });
        if (
          value.isSymbolicLink() ||
          !value.isFile() ||
          value.size < 0n ||
          value.size > BigInt(RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes) ||
          value.size > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          throw recoveryCatalogPhysicalInventoryError();
        }
        addRecoveryCatalogPhysicalFile(
          inventory,
          physicalInodes,
          Number(value.size),
          value.dev,
          value.ino,
        );
        continue;
      }
      directories += 1;
      if (
        directories > RECOVERY_CATALOG_LIMITS.maxEntries ||
        !entry.isDirectory()
      ) {
        throw recoveryCatalogPhysicalInventoryError();
      }
      const directoryRelativePath = `${CATALOG_ARTIFACT_DIRECTORY}/${entry.name}`;
      const directoryPath = await assertSafeRelativePathOnDisk(
        root,
        directoryRelativePath,
        { finalType: "directory" },
      );
      const directoryBefore = await lstat(directoryPath, { bigint: true });
      if (
        directoryBefore.isSymbolicLink() ||
        !directoryBefore.isDirectory()
      ) {
        throw recoveryCatalogPhysicalInventoryError();
      }
      const directory = await opendir(directoryPath, { bufferSize: 1 });
      try {
        for (;;) {
          if (isCancelled()) {
            throw new RecoveryCatalogInventoryCancelledError();
          }
          const file = await directory.read();
          if (file === null) {
            break;
          }
          const finalArtifact = RECOVERY_ARTIFACT_FILE_PATTERN.test(file.name);
          const partialArtifact =
            RECOVERY_ARTIFACT_PARTIAL_FILE_PATTERN.test(file.name);
          const relativePath = `${directoryRelativePath}/${file.name}`;
          if (!file.isFile()) {
            throw recoveryCatalogPhysicalInventoryError();
          }
          let path: string;
          try {
            path = await assertSafeRelativePathOnDisk(root, relativePath, {
              finalType: "file",
            });
          } catch (error) {
            if (isMissingPathError(error)) {
              throw recoveryCatalogPhysicalInventoryError();
            }
            throw error;
          }
          const value = await lstat(path, { bigint: true });
          if (value.isSymbolicLink() || !value.isFile()) {
            throw recoveryCatalogPhysicalInventoryError();
          }
          const maximumFileBytes =
            finalArtifact || partialArtifact
              ? file.name.startsWith("visible-")
                ? DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxTranscriptBytes
                : DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxSelectedImageBytes
              : RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes;
          if (
            value.size < 0n ||
            value.size > BigInt(maximumFileBytes) ||
            value.size > BigInt(Number.MAX_SAFE_INTEGER)
          ) {
            throw recoveryCatalogPhysicalInventoryError();
          }
          addRecoveryCatalogPhysicalFile(
            inventory,
            physicalInodes,
            Number(value.size),
            value.dev,
            value.ino,
          );
        }
      } finally {
        await directory.close();
      }
      const directoryAfter = await lstat(directoryPath, { bigint: true });
      if (!sameInventoryDirectory(directoryBefore, directoryAfter)) {
        throw recoveryCatalogPhysicalInventoryError();
      }
    }
  } finally {
    await rootDirectory.close();
  }
  const rootAfter = await lstat(artifactRoot, { bigint: true });
  if (!sameInventoryDirectory(rootBefore, rootAfter)) {
    throw recoveryCatalogPhysicalInventoryError();
  }
  return inventory;
}

async function inventoryRecoveryCatalogRootFiles(
  root: string,
  isCancelled: () => boolean,
): Promise<void> {
  const recoveryRoot = await assertSafeRelativePathOnDisk(
    root,
    RECOVERY_DIRECTORY,
    { allowMissing: true, finalType: "directory" },
  );
  if (!(await pathExists(recoveryRoot))) {
    return;
  }
  const before = await lstat(recoveryRoot, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw recoveryCatalogPhysicalInventoryError();
  }
  const directory = await opendir(recoveryRoot, { bufferSize: 1 });
  let partialBytes = 0;
  let partialFiles = 0;
  const partialInodes = new Set<string>();
  try {
    for (;;) {
      if (isCancelled()) {
        throw new RecoveryCatalogInventoryCancelledError();
      }
      const entry = await directory.read();
      if (entry === null) {
        break;
      }
      const isManifest = entry.name === "catalog-v1.json";
      const isIndex = entry.name === "index.md";
      const isPartial = RECOVERY_CATALOG_ROOT_PARTIAL_PATTERN.test(entry.name);
      const resemblesCatalogPartial =
        (entry.name.startsWith("catalog-v1.json.") ||
          entry.name.startsWith("index.md.")) &&
        entry.name.endsWith(".partial");
      if (!isManifest && !isIndex && !isPartial) {
        if (resemblesCatalogPartial) {
          throw recoveryCatalogPhysicalInventoryError();
        }
        continue;
      }
      const relativePath = `${RECOVERY_DIRECTORY}/${entry.name}`;
      const path = await assertSafeRelativePathOnDisk(root, relativePath, {
        finalType: "file",
      });
      const value = await lstat(path, { bigint: true });
      if (value.isSymbolicLink() || !value.isFile()) {
        throw recoveryCatalogPhysicalInventoryError();
      }
      const maximumFileBytes =
        isManifest || entry.name.startsWith("catalog-v1.json.")
          ? RECOVERY_CATALOG_LIMITS.maxManifestBytes
          : RECOVERY_CATALOG_LIMITS.maxIndexBytes;
      if (
        value.size < 0n ||
        value.size > BigInt(maximumFileBytes) ||
        value.size > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw recoveryCatalogPhysicalInventoryError();
      }
      if (isPartial) {
        partialFiles += 1;
        const identity = `${value.dev}:${value.ino}`;
        if (!partialInodes.has(identity)) {
          partialInodes.add(identity);
          partialBytes += Number(value.size);
        }
        if (
          !Number.isSafeInteger(partialBytes) ||
          partialBytes > RECOVERY_CATALOG_LIMITS.maxMetadataPartialBytes
        ) {
          throw new RecoveryCatalogLimitError(
            "metadata-partial-bytes",
            RECOVERY_CATALOG_LIMITS.maxMetadataPartialBytes,
            partialBytes,
          );
        }
        if (
          partialFiles > RECOVERY_CATALOG_LIMITS.maxMetadataPartialFiles
        ) {
          throw new RecoveryCatalogLimitError(
            "metadata-partial-files",
            RECOVERY_CATALOG_LIMITS.maxMetadataPartialFiles,
            partialFiles,
          );
        }
      }
    }
  } finally {
    await directory.close();
  }
  const after = await lstat(recoveryRoot, { bigint: true });
  if (!sameInventoryDirectory(before, after)) {
    throw recoveryCatalogPhysicalInventoryError();
  }
  // One metadata atomic write can leave at most one new temporary file. Keep
  // exact manifest-size/file-count headroom before the build starts so a crash
  // cannot push retained catalog metadata debris beyond its separate cap.
  const attemptedBytes =
    partialBytes + RECOVERY_CATALOG_LIMITS.maxManifestBytes;
  if (attemptedBytes > RECOVERY_CATALOG_LIMITS.maxMetadataPartialBytes) {
    throw new RecoveryCatalogLimitError(
      "metadata-partial-bytes",
      RECOVERY_CATALOG_LIMITS.maxMetadataPartialBytes,
      attemptedBytes,
    );
  }
  const attemptedFiles = partialFiles + 1;
  if (attemptedFiles > RECOVERY_CATALOG_LIMITS.maxMetadataPartialFiles) {
    throw new RecoveryCatalogLimitError(
      "metadata-partial-files",
      RECOVERY_CATALOG_LIMITS.maxMetadataPartialFiles,
      attemptedFiles,
    );
  }
}

function addRecoveryCatalogPhysicalFile(
  inventory: { bytes: number; files: number },
  physicalInodes: Set<string>,
  byteLength: number,
  device: bigint,
  inode: bigint,
): void {
  inventory.files += 1;
  const identity = `${device}:${inode}`;
  if (!physicalInodes.has(identity)) {
    physicalInodes.add(identity);
    inventory.bytes += byteLength;
  }
  if (
    !Number.isSafeInteger(inventory.bytes) ||
    inventory.bytes > RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes
  ) {
    throw new RecoveryCatalogLimitError(
      "physical-artifact-bytes",
      RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactBytes,
      inventory.bytes,
    );
  }
  if (inventory.files > RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactFiles) {
    throw new RecoveryCatalogLimitError(
      "physical-artifact-files",
      RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactFiles,
      inventory.files,
    );
  }
}

export class RecoveryCatalogInventoryCancelledError extends Error {
  constructor() {
    super("Recovery catalog physical inventory was cancelled.");
    this.name = "RecoveryCatalogInventoryCancelledError";
  }
}

function sameInventoryDirectory(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.isDirectory() &&
    !left.isSymbolicLink() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function recoveryCatalogPhysicalInventoryError(): RecoveryCatalogLimitError {
  return new RecoveryCatalogLimitError(
    "physical-inventory",
    RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactFiles,
    RECOVERY_CATALOG_LIMITS.maxPhysicalArtifactFiles + 1,
  );
}

async function withRecoveryCatalogLock<T>(
  extensionStorage: string,
  run: (root: string) => Promise<T>,
): Promise<T> {
  await ensureDirectory(extensionStorage);
  const root = await assertRealDirectory(extensionStorage);
  const lockPath = assertSafeRelativePath(root, LOCK_FILE_NAME);
  const lock = await acquireFileLockWithin(
    lockPath,
    RECOVERY_CATALOG_LIMITS.lockTimeoutMs,
  );
  if (lock === null) {
    throw new Error(
      "Another Cursor window is updating the recovery catalog; try again in a moment.",
    );
  }
  try {
    await ensureDirectoryWithinRoot(root, RECOVERY_DIRECTORY);
    return await run(root);
  } finally {
    await lock.release();
  }
}

async function loadRecoveryCatalog(root: string): Promise<{
  manifest: RecoveryCatalogManifestV1;
  bytes: Buffer | null;
}> {
  const manifestPath = await assertSafeRelativePathOnDisk(
    root,
    MANIFEST_RELATIVE_PATH,
    { allowMissing: true, finalType: "file" },
  );
  if (!(await pathExists(manifestPath))) {
    return { manifest: { schemaVersion: 1, entries: [] }, bytes: null };
  }
  let bytes: Buffer;
  try {
    bytes = await readFileWithinRoot(
      root,
      MANIFEST_RELATIVE_PATH,
      RECOVERY_CATALOG_LIMITS.maxManifestBytes,
    );
  } catch (error) {
    if (isMissingPathError(error)) {
      return { manifest: { schemaVersion: 1, entries: [] }, bytes: null };
    }
    throw error;
  }
  if (
    !buffersFitJsonStructureBudget([bytes], {
      maxStructuralTokens: RECOVERY_CATALOG_LIMITS.maxJsonStructuralTokens,
      maxNestingDepth: RECOVERY_CATALOG_LIMITS.maxJsonDepth,
    })
  ) {
    throw new Error("Recovery catalog JSON exceeds its structural safety limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("Recovery catalog JSON is invalid.", { cause: error });
  }
  return { manifest: validateManifest(parsed), bytes };
}

function validateManifest(value: unknown): RecoveryCatalogManifestV1 {
  const record = requireRecord(value, "Recovery catalog");
  requireExactKeys(record, ["entries", "schemaVersion"], "Recovery catalog");
  if (record.schemaVersion !== 1) {
    throw new Error("Recovery catalog schema version is unsupported.");
  }
  if (!Array.isArray(record.entries)) {
    throw new Error("Recovery catalog entries must be an array.");
  }
  if (record.entries.length > RECOVERY_CATALOG_LIMITS.maxEntries) {
    throw new RecoveryCatalogLimitError(
      "entries",
      RECOVERY_CATALOG_LIMITS.maxEntries,
      record.entries.length,
    );
  }
  const entries = record.entries.map(validateStoredEntry);
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = entryIdentity(entry);
    if (identities.has(identity)) {
      throw new Error("Recovery catalog contains a duplicate entry identity.");
    }
    identities.add(identity);
  }
  const manifest: RecoveryCatalogManifestV1 = {
    schemaVersion: 1,
    entries: entries.sort(compareEntries),
  };
  assertCatalogArtifactQuota(manifest);
  return manifest;
}

function validateStoredEntry(value: unknown): RecoveryCatalogEntry {
  const record = requireRecord(value, "Recovery catalog entry");
  const status = validateStatus(record.status);
  requireExactKeys(
    record,
    status === "ready"
      ? [
          "artifact",
          "chatCoreHash",
          "composerId",
          "composerStorageClass",
          "damageFingerprint",
          "lastUpdatedAt",
          "status",
          "title",
        ]
      : [
          "chatCoreHash",
          "composerId",
          "composerStorageClass",
          "damageFingerprint",
          "lastUpdatedAt",
          "status",
          "title",
        ],
    "Recovery catalog entry",
  );
  const base = {
    composerId: validateComposerId(record.composerId),
    composerStorageClass: validateComposerStorageClass(
      record.composerStorageClass,
    ),
    chatCoreHash: validateHash(record.chatCoreHash, "chat core hash"),
    damageFingerprint: validateHash(
      record.damageFingerprint,
      "damage fingerprint",
    ),
    title: validateStoredTitle(record.title),
    lastUpdatedAt: validateLastUpdatedAt(record.lastUpdatedAt),
  };
  if (status !== "ready") {
    return { ...base, status };
  }
  return {
    ...base,
    status,
    artifact: validateStoredArtifact(
      record.artifact,
      base.composerId,
      base.composerStorageClass,
    ),
  };
}

function validateStoredArtifact(
  value: unknown,
  composerId: string,
  composerStorageClass: ComposerIdStorageClass,
): RecoveryCatalogStoredArtifact {
  const record = requireRecord(value, "Recovery catalog artifact");
  requireExactKeys(record, ["images", "transcript"], "Recovery catalog artifact");
  const transcript = validateStoredFile(
    record.transcript,
    "transcript",
    composerId,
    composerStorageClass,
  );
  if (!Array.isArray(record.images)) {
    throw new Error("Recovery catalog artifact images must be an array.");
  }
  if (
    record.images.length >
    DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxSelectedImages
  ) {
    throw new Error("Recovery catalog artifact exceeds its image count limit.");
  }
  const images = record.images.map((image) =>
    validateStoredImage(
      image,
      composerId,
      composerStorageClass,
    ),
  );
  const paths = new Set<string>();
  let totalImageBytes = 0;
  for (const image of images) {
    if (paths.has(image.relativePath)) {
      throw new Error("Recovery catalog artifact contains a duplicate image path.");
    }
    paths.add(image.relativePath);
    totalImageBytes += image.byteLength;
    if (
      totalImageBytes >
      DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxSelectedImageTotalBytes
    ) {
      throw new Error("Recovery catalog artifact exceeds its aggregate image limit.");
    }
  }
  return {
    transcript,
    images: images.sort((left, right) =>
      compareText(left.relativePath, right.relativePath),
    ),
  };
}

function validateStoredFile(
  value: unknown,
  kind: "transcript" | "image",
  composerId: string,
  composerStorageClass: ComposerIdStorageClass,
): RecoveryCatalogStoredFile {
  const record = requireRecord(value, `Recovery catalog ${kind}`);
  const keys =
    kind === "image"
      ? ["byteLength", "mimeType", "relativePath", "sha256"]
      : ["byteLength", "relativePath", "sha256"];
  requireExactKeys(record, keys, `Recovery catalog ${kind}`);
  const hash = validateHash(record.sha256, `${kind} hash`);
  const byteLength = validateArtifactByteLength(record.byteLength, kind);
  if (typeof record.relativePath !== "string") {
    throw new Error(`Recovery catalog ${kind} path must be a string.`);
  }
  const expected = expectedArtifactRelativePath(
    composerId,
    composerStorageClass,
    kind,
    hash,
  );
  if (record.relativePath !== expected) {
    throw new Error(`Recovery catalog ${kind} path is not content-addressed.`);
  }
  // Performs portable normalization and traversal/reserved-name checks without
  // requiring the artifact to exist during a manifest-only read.
  assertSafeRelativePath(".", record.relativePath);
  return { relativePath: record.relativePath, sha256: hash, byteLength };
}

function validateStoredImage(
  value: unknown,
  composerId: string,
  composerStorageClass: ComposerIdStorageClass,
): RecoveryCatalogStoredImage {
  const record = requireRecord(value, "Recovery catalog image");
  if (record.mimeType !== "image/png") {
    throw new Error("Recovery catalog image MIME type is unsupported.");
  }
  return {
    ...validateStoredFile(
      record,
      "image",
      composerId,
      composerStorageClass,
    ),
    mimeType: "image/png",
  };
}

function normalizeAndDeduplicateInputs(
  inputs: readonly RecoveryCatalogUpsertInput[],
): Map<string, RecoveryCatalogUpsertInput & { lastUpdatedAt: number | null }> {
  const selected = new Map<
    string,
    RecoveryCatalogUpsertInput & { lastUpdatedAt: number | null }
  >();
  for (const input of inputs) {
    const composerId = validateComposerId(input.composerId);
    const composerStorageClass = validateComposerStorageClass(
      input.composerStorageClass,
    );
    const identity = catalogComposerIdentity(
      composerId,
      composerStorageClass,
    );
    if (selected.has(identity)) {
      throw new Error(
        "Recovery catalog input contains the same exact composer identity more than once.",
      );
    }
    const chatCoreHash = validateHash(input.chatCoreHash, "chat core hash");
    const damageFingerprint = validateHash(
      input.damageFingerprint,
      "damage fingerprint",
    );
    const status = validateStatus(input.status);
    if (status === "ready" && input.artifact === undefined) {
      throw new Error("A ready recovery catalog entry requires an artifact.");
    }
    if (status !== "ready" && input.artifact !== undefined) {
      throw new Error("A non-ready recovery catalog entry cannot carry an artifact.");
    }
    const normalized = {
      ...input,
      composerId,
      composerStorageClass,
      chatCoreHash,
      damageFingerprint,
      title: normalizeInputTitle(input.title),
      lastUpdatedAt: validateLastUpdatedAt(input.lastUpdatedAt ?? null),
      status,
    };
    selected.set(identity, normalized);
  }
  return selected;
}

async function materializeInput(
  root: string,
  input: RecoveryCatalogUpsertInput & { lastUpdatedAt: number | null },
): Promise<RecoveryCatalogEntry> {
  const base: RecoveryCatalogEntryBase = {
    composerId: input.composerId,
    composerStorageClass: input.composerStorageClass,
    chatCoreHash: input.chatCoreHash,
    damageFingerprint: input.damageFingerprint,
    title: input.title,
    lastUpdatedAt: input.lastUpdatedAt,
  };
  if (input.status !== "ready") {
    return { ...base, status: input.status };
  }
  if (input.artifact === undefined) {
    throw new Error("A ready recovery catalog entry requires an artifact.");
  }
  return {
    ...base,
    status: "ready",
    artifact: await materializeArtifact(
      root,
      input.composerId,
      input.composerStorageClass,
      input.artifact,
    ),
  };
}

async function materializeArtifact(
  root: string,
  composerId: string,
  composerStorageClass: ComposerIdStorageClass,
  artifact: VisibleChatRecoveryArtifact,
): Promise<RecoveryCatalogStoredArtifact> {
  const transcriptHash = validateHash(
    artifact.transcriptHash,
    "transcript hash",
  );
  const transcriptRelativePath = await validatedArtifactRelativePath(
    root,
    artifact.path,
  );
  if (
    transcriptRelativePath !==
    expectedArtifactRelativePath(
      composerId,
      composerStorageClass,
      "transcript",
      transcriptHash,
    )
  ) {
    throw new Error("Recovery transcript path is not content-addressed.");
  }
  const transcriptBytes = await readFileWithinRoot(
    root,
    transcriptRelativePath,
    DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxTranscriptBytes,
  );
  if (sha256(transcriptBytes) !== transcriptHash) {
    throw new Error("Recovery transcript content hash does not match its path.");
  }
  const transcript: RecoveryCatalogStoredFile = {
    relativePath: transcriptRelativePath,
    sha256: transcriptHash,
    byteLength: transcriptBytes.byteLength,
  };

  if (
    artifact.imageAttachments.length >
    DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxSelectedImages
  ) {
    throw new Error("Recovery artifact exceeds its image count limit.");
  }
  const images: RecoveryCatalogStoredImage[] = [];
  const paths = new Set<string>();
  let totalImageBytes = 0;
  for (const image of artifact.imageAttachments) {
    if (image.mimeType !== "image/png") {
      throw new Error("Recovery artifact image MIME type is unsupported.");
    }
    const hash = validateHash(image.hash, "image hash");
    const byteLength = validateArtifactByteLength(image.byteLength, "image");
    const relativePath = await validatedArtifactRelativePath(root, image.path);
    if (
      relativePath !==
      expectedArtifactRelativePath(
        composerId,
        composerStorageClass,
        "image",
        hash,
      )
    ) {
      throw new Error("Recovery image path is not content-addressed.");
    }
    if (paths.has(relativePath)) {
      throw new Error("Recovery artifact contains a duplicate image path.");
    }
    paths.add(relativePath);
    totalImageBytes += byteLength;
    if (
      totalImageBytes >
      DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxSelectedImageTotalBytes
    ) {
      throw new Error("Recovery artifact exceeds its aggregate image limit.");
    }
    const bytes = await readFileWithinRoot(root, relativePath, byteLength);
    if (bytes.byteLength !== byteLength || sha256(bytes) !== hash) {
      throw new Error("Recovery image read-back verification failed.");
    }
    images.push({
      relativePath,
      sha256: hash,
      byteLength,
      mimeType: "image/png",
    });
  }
  return {
    transcript,
    images: images.sort((left, right) =>
      compareText(left.relativePath, right.relativePath),
    ),
  };
}

async function validatedArtifactRelativePath(
  root: string,
  absolutePath: string,
): Promise<string> {
  if (typeof absolutePath !== "string" || !isAbsolute(absolutePath)) {
    throw new Error("Recovery artifact input path must be absolute.");
  }
  const relativePath = normalizeResourcePath(
    relative(resolve(root), resolve(absolutePath)),
  );
  assertSafeRelativePath(root, relativePath);
  await assertSafeRelativePathOnDisk(root, relativePath, {
    finalType: "file",
  });
  return relativePath;
}

async function verifyStoredFile(
  root: string,
  file: RecoveryCatalogStoredFile,
): Promise<string> {
  const maxBytes = file.relativePath.endsWith(".md")
    ? DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxTranscriptBytes
    : DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxSelectedImageBytes;
  if (file.byteLength > maxBytes) {
    throw new Error("Recovery catalog artifact exceeds its file size limit.");
  }
  const bytes = await readFileWithinRoot(root, file.relativePath, file.byteLength);
  if (bytes.byteLength !== file.byteLength || sha256(bytes) !== file.sha256) {
    throw new Error("Recovery catalog artifact read-back verification failed.");
  }
  return assertSafeRelativePathOnDisk(root, file.relativePath, {
    finalType: "file",
  });
}

function encodeManifest(manifest: RecoveryCatalogManifestV1): Buffer {
  const bytes = Buffer.concat([canonicalBytes(manifest), Buffer.from("\n")]);
  if (bytes.byteLength > RECOVERY_CATALOG_LIMITS.maxManifestBytes) {
    throw new RecoveryCatalogLimitError(
      "manifest-bytes",
      RECOVERY_CATALOG_LIMITS.maxManifestBytes,
      bytes.byteLength,
    );
  }
  if (
    !buffersFitJsonStructureBudget([bytes], {
      maxStructuralTokens: RECOVERY_CATALOG_LIMITS.maxJsonStructuralTokens,
      maxNestingDepth: RECOVERY_CATALOG_LIMITS.maxJsonDepth,
    })
  ) {
    throw new RecoveryCatalogLimitError(
      "manifest-structure",
      RECOVERY_CATALOG_LIMITS.maxJsonStructuralTokens,
      RECOVERY_CATALOG_LIMITS.maxJsonStructuralTokens + 1,
    );
  }
  return bytes;
}

async function writeCatalogIndex(
  root: string,
  manifest: RecoveryCatalogManifestV1,
): Promise<void> {
  const bytes = buildCatalogIndex(manifest);
  await writeFileAtomicWithinRoot(root, INDEX_RELATIVE_PATH, bytes);
}

function buildCatalogIndex(manifest: RecoveryCatalogManifestV1): Buffer {
  const counts = new Map<RecoveryCatalogStatus, number>();
  for (const status of STATUS_VALUES) {
    counts.set(status, 0);
  }
  for (const entry of manifest.entries) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  }
  const header = [
    "# Cursor Chat Recovery Catalog",
    "",
    "Original Cursor conversations and databases remain unchanged.",
    "Ready recovery transcripts, images, this catalog, and any obsolete content-addressed derivatives are plaintext files retained in this extension's local recovery-transcripts folder until you explicitly delete those recovery files.",
    "",
    `[Machine-readable catalog](./catalog-v1.json) · ${manifest.entries.length} entr${manifest.entries.length === 1 ? "y" : "ies"} · ready ${counts.get("ready") ?? 0} · skipped-limit ${counts.get("skipped-limit") ?? 0} · skipped-body ${counts.get("skipped-body") ?? 0} · changed ${counts.get("changed") ?? 0} · unknown ${counts.get("unknown") ?? 0}`,
    "",
  ].join("\n");
  const chunks = [header];
  let usedBytes = Buffer.byteLength(header, "utf8");
  let rendered = 0;
  // Leave room for the bounded omission footer even when the next title is at
  // its maximum allowed byte length.
  const footerReserve = 256;
  for (const entry of manifest.entries) {
    const block = indexEntryBlock(entry);
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (
      usedBytes + blockBytes + footerReserve >
      RECOVERY_CATALOG_LIMITS.maxIndexBytes
    ) {
      break;
    }
    chunks.push(block);
    usedBytes += blockBytes;
    rendered += 1;
  }
  const omitted = manifest.entries.length - rendered;
  if (omitted > 0) {
    chunks.push(
      `\n_${omitted} additional catalog entr${omitted === 1 ? "y was" : "ies were"} omitted from this bounded index. The machine-readable manifest retains them._\n`,
    );
  }
  const bytes = Buffer.from(chunks.join(""), "utf8");
  if (bytes.byteLength > RECOVERY_CATALOG_LIMITS.maxIndexBytes) {
    throw new Error("Recovery catalog index exceeds its size limit.");
  }
  return bytes;
}

function indexEntryBlock(entry: RecoveryCatalogEntry): string {
  const title = entry.title === null ? "Untitled conversation" : entry.title;
  const lines = [
    `## ${escapeMarkdownTitle(title)}`,
    "",
    `- Status: \`${entry.status}\``,
    `- Composer ID: \`${entry.composerId}\``,
    `- Composer storage: \`${entry.composerStorageClass}\``,
    `- Last updated: ${entry.lastUpdatedAt === null ? "unknown" : new Date(entry.lastUpdatedAt).toISOString()}`,
  ];
  if (entry.status === "ready") {
    const localTranscriptPath = entry.artifact.transcript.relativePath.slice(
      `${RECOVERY_DIRECTORY}/`.length,
    );
    lines.push(
      `- Recovery transcript: [open plaintext context](./${localTranscriptPath})`,
      `- Verified PNG attachments: ${entry.artifact.images.length}`,
    );
  }
  lines.push("", "");
  return lines.join("\n");
}

function escapeMarkdownTitle(value: string): string {
  let oneLine = "";
  let replacingControl = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      if (!replacingControl) {
        oneLine += " ";
        replacingControl = true;
      }
      continue;
    }
    replacingControl = false;
    oneLine += character;
  }
  oneLine = oneLine.trim();
  const visible = oneLine.length === 0 ? "Untitled conversation" : oneLine;
  return visible.replace(/([\\`*_{}[\]()<>#+.!|-])/gu, "\\$1");
}

function catalogResult(
  root: string,
  manifest: RecoveryCatalogManifestV1,
): RecoveryCatalogResult {
  return {
    manifest,
    capacity: catalogCapacity(manifest),
    manifestPath: assertSafeRelativePath(root, MANIFEST_RELATIVE_PATH),
    indexPath: assertSafeRelativePath(root, INDEX_RELATIVE_PATH),
  };
}

function catalogCapacity(
  manifest: RecoveryCatalogManifestV1,
): RecoveryCatalogCapacity {
  const readyArtifactBytes = catalogReadyArtifactBytes(manifest);
  return {
    entryCount: manifest.entries.length,
    readyArtifactBytes,
    remainingEntries: Math.max(
      0,
      RECOVERY_CATALOG_LIMITS.maxEntries - manifest.entries.length,
    ),
    remainingReadyArtifactBytes: Math.max(
      0,
      RECOVERY_CATALOG_LIMITS.maxReadyArtifactBytes - readyArtifactBytes,
    ),
  };
}

function assertCatalogArtifactQuota(
  manifest: RecoveryCatalogManifestV1,
): void {
  const attempted = catalogReadyArtifactBytes(manifest);
  if (attempted > RECOVERY_CATALOG_LIMITS.maxReadyArtifactBytes) {
    throw new RecoveryCatalogLimitError(
      "artifact-bytes",
      RECOVERY_CATALOG_LIMITS.maxReadyArtifactBytes,
      attempted,
    );
  }
}

function catalogReadyArtifactBytes(
  manifest: RecoveryCatalogManifestV1,
): number {
  let total = 0;
  for (const byteLength of catalogArtifactPaths(manifest).values()) {
    total += byteLength;
  }
  return total;
}

/** Unique content-addressed paths referenced by the current catalog only. */
function catalogArtifactPaths(
  manifest: RecoveryCatalogManifestV1,
): Map<string, number> {
  const paths = new Map<string, number>();
  for (const entry of manifest.entries) {
    if (entry.status !== "ready") {
      continue;
    }
    for (const file of [
      entry.artifact.transcript,
      ...entry.artifact.images,
    ]) {
      const existing = paths.get(file.relativePath);
      if (existing !== undefined && existing !== file.byteLength) {
        throw new Error(
          "Recovery catalog gives one artifact path conflicting byte lengths.",
        );
      }
      if (existing === undefined) {
        paths.set(file.relativePath, file.byteLength);
      }
    }
  }
  return paths;
}

function expectedArtifactRelativePath(
  composerId: string,
  composerStorageClass: ComposerIdStorageClass,
  kind: "transcript" | "image",
  hash: string,
): string {
  const directory = `${CATALOG_ARTIFACT_DIRECTORY}/recovered-${visibleRecoveryCatalogComposerKey(composerId, composerStorageClass)}`;
  return kind === "transcript"
    ? `${directory}/visible-${hash}.md`
    : `${directory}/image-${hash}.png`;
}

function entryIdentity(entry: {
  composerId: string;
  composerStorageClass: ComposerIdStorageClass;
}): string {
  return catalogComposerIdentity(
    entry.composerId,
    entry.composerStorageClass,
  );
}

function catalogComposerIdentity(
  composerId: string,
  composerStorageClass: ComposerIdStorageClass,
): string {
  return `${composerStorageClass}\0${composerId}`;
}

function compareEntries(
  left: RecoveryCatalogEntry,
  right: RecoveryCatalogEntry,
): number {
  if (left.lastUpdatedAt !== right.lastUpdatedAt) {
    if (left.lastUpdatedAt === null) {
      return 1;
    }
    if (right.lastUpdatedAt === null) {
      return -1;
    }
    return right.lastUpdatedAt - left.lastUpdatedAt;
  }
  return (
    compareText(left.title ?? "", right.title ?? "") ||
    compareText(left.composerId, right.composerId) ||
    compareText(left.composerStorageClass, right.composerStorageClass) ||
    compareText(left.chatCoreHash, right.chatCoreHash) ||
    compareText(left.damageFingerprint, right.damageFingerprint)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateComposerId(value: unknown): string {
  if (typeof value !== "string" || !isSyncableComposerId(value)) {
    throw new Error("Recovery catalog composer ID is invalid.");
  }
  return value;
}

function validateHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`Recovery catalog ${label} is invalid.`);
  }
  return value;
}

function validateComposerStorageClass(
  value: unknown,
): ComposerIdStorageClass {
  if (value !== "text" && value !== "blob") {
    throw new Error(
      "Recovery catalog composer storage class must be text or blob.",
    );
  }
  return value;
}

function validateStatus(value: unknown): RecoveryCatalogStatus {
  if (typeof value !== "string" || !STATUS_VALUES.has(value as RecoveryCatalogStatus)) {
    throw new Error("Recovery catalog status is invalid.");
  }
  return value as RecoveryCatalogStatus;
}

function normalizeInputTitle(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Recovery catalog title is invalid.");
  }
  return validateStoredTitle(value.normalize("NFC"));
}

function validateStoredTitle(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > RECOVERY_CATALOG_LIMITS.maxTitleBytes
  ) {
    throw new Error("Recovery catalog title is invalid or exceeds its size limit.");
  }
  return value;
}

function validateLastUpdatedAt(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_DATE_MILLISECONDS
  ) {
    throw new Error("Recovery catalog last-updated timestamp is invalid.");
  }
  return value;
}

function validateArtifactByteLength(
  value: unknown,
  kind: "transcript" | "image",
): number {
  const limit =
    kind === "transcript"
      ? DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxTranscriptBytes
      : DEFAULT_VISIBLE_CHAT_RECOVERY_LIMITS.maxSelectedImageBytes;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > limit
  ) {
    throw new Error(`Recovery catalog ${kind} size is invalid or over limit.`);
  }
  return value;
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  if (
    actual.length !== sortedExpected.length ||
    !actual.every((key, index) => key === sortedExpected[index])
  ) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}
