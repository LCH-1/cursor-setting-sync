import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative } from "node:path";
import { stat } from "node:fs/promises";
import { openDatabase, sqliteStorageText } from "../platform/sqlite";
import { existsSync } from "node:fs";
import type {
  JsonValue,
  LocalProjection,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  isMissingPathError,
  normalizeResourcePath,
  pathExists,
  readFileWithinRoot,
} from "../platform/files";
import { sha256 } from "../protocol/canonical";
import {
  assertBoundedJsoncStructure,
  serializeCanonical,
} from "./jsonc";
import type {
  OversizedSnapshotSettlement,
  ResourceAdapter,
  ResourceApplyInput,
  ResourceScanStatus,
} from "./resource";
import { readPortableProfiles } from "./profiles";
import { EXTENSION_ID } from "../constants";
import type { IgnoreMatcher } from "./ignorePatterns";
import { createIgnoreMatcher } from "./ignorePatterns";
import { DEFAULT_MAX_PAYLOAD_MIB } from "../constants";
import {
  GENERAL_MAX_RESOURCES_PER_SCAN,
  GENERAL_MAX_RETAINED_BYTES_PER_SCAN,
  OversizedSqliteValueError,
  generalOversizedObservation,
  generalOversizedWarning,
  generalResourceLimit,
  inspectSqliteValue,
  readSqliteValue,
  rememberGeneralOversizedObservation,
  type GeneralOversizedObservation,
} from "./boundedScan";

/**
 * Extension identifiers compare case-insensitively, so both the configured
 * entries and the observed IDs are folded before matching. `ms-python.*` and
 * an exact `publisher.name` both work.
 */
export function createExtensionIgnoreMatcher(
  entries: readonly string[],
): IgnoreMatcher {
  return createIgnoreMatcher(entries, { caseFold: true });
}

const execFileAsync = promisify(execFile);

interface ExtensionDesiredState {
  id: string;
  version: string;
  installed: true;
  enabled: boolean;
  preRelease: boolean;
  pinned: boolean;
}

export interface ExtensionMetadata {
  preRelease: boolean;
  pinned: boolean;
}

interface ProfileScanMemo {
  manifestMtimeMs: number | null;
  databaseMtimeMs: number | null;
  registryMtimeMs: number | null;
  installed: Array<{ id: string; version: string }>;
  disabled: Set<string>;
  identifierBytes: number;
}

export const MAX_EXTENSION_MANIFEST_BYTES =
  GENERAL_MAX_RETAINED_BYTES_PER_SCAN;
export const MAX_EXTENSION_IDENTIFIERS = 16_384;
const MAX_EXTENSION_IDENTIFIER_BYTES = 512;
const MAX_EXTENSION_MEMO_IDENTIFIERS = 16_384;
const MAX_EXTENSION_COLLECTION_IDENTIFIER_BYTES = 2 * 1024 * 1024;
const MAX_EXTENSION_MEMO_IDENTIFIER_BYTES = 4 * 1024 * 1024;

export interface ExtensionsAdapterOptions {
  maxProfilesPerScan?: number;
  maxResourcesPerScan?: number;
  maxRetainedBytesPerScan?: number;
  onManifestRead?: () => void;
  onDisabledValueRead?: (profileId: string) => void;
  scanIntervalMs?: number;
  now?: () => number;
  /** Narrow test seam; production uses Cursor's Electron-as-node CLI. */
  listInstalledExtensions?: (
    profileName: string | null,
  ) => Promise<Array<{ id: string; version: string }>>;
}

interface ExtensionProfile {
  id: string;
  name: string;
}

export class ExtensionsAdapter implements ResourceAdapter {
  readonly id = "extensions";
  readonly kinds = ["extension"] as const;
  readonly appliesWhileRunning = false;

  // Scans run on a frequent poll, so the CLI spawn and disabled-state read
  // are re-run for a profile only when the extensions manifest, that
  // profile's database (main file or WAL, since commits land in the WAL
  // without touching the main file), or the profile's own extension registry
  // changed since the previous scan.
  private readonly scanMemo = new Map<string, ProfileScanMemo>();
  private scanMemoIdentifiers = 0;
  private scanMemoIdentifierBytes = 0;
  private extensionMetadataMemo: {
    size: number;
    mtimeMs: number;
    value: Map<string, ExtensionMetadata>;
    identifierBytes: number;
  } | null = null;
  private maxPayloadBytes = DEFAULT_MAX_PAYLOAD_MIB * 1024 * 1024;
  private lastScanStatus: ResourceScanStatus = {
    complete: true,
    deferredResourceIds: [],
  };
  private readonly oversized = new Map<string, GeneralOversizedObservation>();
  private oversizedOverflow = false;
  /** Finite generation: one profile remains selected until its page is acked. */
  private profileSweep: ExtensionProfile[] | null = null;
  private profileSweepIndex = 0;
  private profileSweepManifestUnreadable = false;
  private readonly failedProfileIds = new Set<string>();
  private nextSweepAt = 0;
  private progressRevision = 0;
  private lastEmittedPageFingerprint: string | null = null;
  private profileSweepRetryOnly = false;

  constructor(
    private readonly paths: CursorPaths,
    private readonly ignoredExtensions: IgnoreMatcher,
    private readonly options: ExtensionsAdapterOptions = {},
  ) {}

  setMaxPayloadBytes(maxPayloadBytes: number): void {
    generalResourceLimit(maxPayloadBytes);
    if (this.maxPayloadBytes !== maxPayloadBytes) {
      this.maxPayloadBytes = maxPayloadBytes;
      this.oversized.clear();
      this.oversizedOverflow = false;
      this.profileSweep = null;
      this.profileSweepIndex = 0;
      this.nextSweepAt = 0;
    }
  }

  scanStatus(): ResourceScanStatus {
    return this.lastScanStatus;
  }

  oversizedSnapshotSettlements(
    _maxPayloadBytes: number,
  ): readonly OversizedSnapshotSettlement[] {
    return [...this.oversized.values()];
  }

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const deferred = new Set<string>();
    const now = (this.options.now ?? Date.now)();
    if (this.profileSweep === null && now < this.nextSweepAt) {
      this.lastScanStatus = {
        complete: !this.oversizedOverflow,
        deferredResourceIds: this.oversizedOverflow
          ? ["extension-scope/untracked-oversized-resources"]
          : [],
        progressToken: this.progressRevision,
      };
      return { snapshots: [], deletions: [], warnings: [] };
    }
    if (this.profileSweep === null) {
      // Rebuild exact oversized protections only under the incomplete full
      // profile sweep that follows. This is also the recovery point for a
      // prior bounded-registry overflow.
      this.oversized.clear();
      this.oversizedOverflow = false;
    }
    let metadata: Map<string, ExtensionMetadata>;
    try {
      metadata = await this.readExtensionMetadata();
    } catch (error) {
      this.lastScanStatus = {
        complete: false,
        deferredResourceIds: ["extension/manifest"],
        progressToken: this.progressRevision,
      };
      return {
        snapshots: [],
        deletions: [],
        warnings: [
          `Unable to read extension metadata: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
    const manifestMtimeMs = await mtimeOrNull(this.paths.cursorExtensionsManifest);
    const resourceLimit = generalResourceLimit(this.maxPayloadBytes);
    const extensionStateLimit = Math.min(
      resourceLimit,
      MAX_EXTENSION_MANIFEST_BYTES,
    );
    const maxResources =
      this.options.maxResourcesPerScan ?? GENERAL_MAX_RESOURCES_PER_SCAN;
    const retainedLimit =
      this.options.maxRetainedBytesPerScan ??
      GENERAL_MAX_RETAINED_BYTES_PER_SCAN;
    let retainedBytes = 0;
    let materialized = 0;
    // An unreadable profile manifest must degrade to "default profile only"
    // instead of taking down extension sync entirely. Profiles missing from
    // the list are also absent from scannedProfiles, so findDeletions
    // suppresses their deletions rather than uninstalling them elsewhere.
    if (this.profileSweep === null) {
      let declaredProfiles: ExtensionProfile[] = [];
      this.profileSweepManifestUnreadable = false;
      try {
        declaredProfiles = readPortableProfiles(
          this.paths.globalDatabase,
          MAX_EXTENSION_MANIFEST_BYTES,
        ).map((profile) => ({ id: profile.id, name: profile.name }));
      } catch (error) {
        this.profileSweepManifestUnreadable = true;
        warnings.push(
          `Unable to enumerate profiles: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      this.profileSweep = [
        { id: "default", name: "Default" },
        ...declaredProfiles,
      ];
      this.profileSweepIndex = 0;
      this.profileSweepRetryOnly = false;
      this.progressRevision += 1;
      this.lastEmittedPageFingerprint = null;
    }
    const profile = this.profileSweep[this.profileSweepIndex];
    const selectedProfiles = profile === undefined ? [] : [profile];
    let profileFailed = false;
    let profileNeedsRetry = false;

    for (const profile of selectedProfiles) {
      try {
        const databaseMtimeMs = await databaseMtimeOrNull(
          profileDatabasePath(this.paths, profile.id),
        );
        const registryMtimeMs =
          profile.id === "default"
            ? null
            : await mtimeOrNull(
                join(this.paths.profilesRoot, profile.id, "extensions.json"),
              );
        const memo = this.scanMemo.get(profile.id);
        let installed: Array<{ id: string; version: string }>;
        let disabled: Set<string>;
        // The database mtime invalidates only the disabled list it feeds - a
        // one-row read. It must not invalidate the CLI listing: the default
        // profile's database is the global chat store, whose WAL mtime moves
        // on virtually every poll during active use, and keying the CLI spawn
        // on it re-ran Electron-as-node every thirty seconds for the life of
        // the session - the exact cost this memo exists to avoid.
        if (
          memo !== undefined &&
          memo.manifestMtimeMs === manifestMtimeMs &&
          memo.registryMtimeMs === registryMtimeMs
        ) {
          this.scanMemo.delete(profile.id);
          this.scanMemo.set(profile.id, memo);
          installed = memo.installed;
          if (memo.databaseMtimeMs === databaseMtimeMs) {
            disabled = memo.disabled;
          } else {
            disabled = readDisabledExtensions(
              this.paths,
              profile.id,
              extensionStateLimit,
              this.options.onDisabledValueRead,
            );
            memo.databaseMtimeMs = databaseMtimeMs;
            this.scanMemoIdentifiers -= memo.disabled.size;
            this.scanMemoIdentifierBytes -= identifierBytes(memo.disabled);
            memo.disabled = disabled;
            memo.identifierBytes =
              installedIdentifierBytes(memo.installed) +
              identifierBytes(disabled);
            this.scanMemoIdentifiers += disabled.size;
            this.scanMemoIdentifierBytes += identifierBytes(disabled);
            this.enforceScanMemoLimit(profile.id);
          }
        } else {
          installed = await (
            this.options.listInstalledExtensions ??
            ((profileName) => this.listInstalledExtensions(profileName))
          )(profile.id === "default" ? null : profile.name);
          disabled = readDisabledExtensions(
            this.paths,
            profile.id,
            extensionStateLimit,
            this.options.onDisabledValueRead,
          );
          this.rememberProfileScan(profile.id, {
            manifestMtimeMs,
            databaseMtimeMs,
            registryMtimeMs,
            installed,
            disabled,
            identifierBytes:
              installedIdentifierBytes(installed) + identifierBytes(disabled),
          });
        }
        const sourceTimestamp = Math.max(
          ...[manifestMtimeMs, databaseMtimeMs, registryMtimeMs].filter(
            (value): value is number => value !== null,
          ),
          0,
        );
        for (const entry of installed) {
          const id = entry.id.toLowerCase();
          if (
            id === EXTENSION_ID.toLowerCase() ||
            this.ignoredExtensions.matches(id)
          ) {
            continue;
          }
          const desired: ExtensionDesiredState = {
            id,
            version: entry.version,
            installed: true,
            enabled: !disabled.has(id),
            preRelease: metadata.get(id)?.preRelease ?? false,
            pinned: metadata.get(id)?.pinned ?? false,
          };
          const value = desired as unknown as JsonValue;
          const resourceId = extensionResourceId(profile.id, id);
          const content = serializeCanonical(value);
          const desiredSemanticHash = sha256(content);
          if (projectionMatchesSemantic(known[resourceId], desiredSemanticHash)) {
            this.oversized.delete(resourceId);
            continue;
          }
          if (materialized >= maxResources) {
            deferred.add(resourceId);
            profileNeedsRetry = true;
            continue;
          }
          if (content.byteLength > resourceLimit) {
            const observation = generalOversizedObservation(
              resourceId,
              `${sourceTimestamp}:${content.byteLength}`,
              content.byteLength,
              this.maxPayloadBytes,
            );
            const remembered = rememberGeneralOversizedObservation(
              this.oversized,
              observation,
            );
            if (!remembered) {
              this.oversizedOverflow = true;
              // Overflow protects the whole kind. Advance this finite profile
              // sweep instead of repeatedly enumerating an unbounded prefix.
              break;
            }
            warnings.push(generalOversizedWarning("Extension", observation));
            continue;
          }
          if (
            snapshots.length > 0 &&
            retainedBytes + content.byteLength > retainedLimit
          ) {
            deferred.add(resourceId);
            profileNeedsRetry = true;
            continue;
          }
          materialized += 1;
          snapshots.push({
            resourceId,
            kind: "extension",
            content,
            semanticHash: desiredSemanticHash,
            metadata: {
              profileId: profile.id,
              profileName: profile.name,
              extensionId: id,
              version: entry.version,
              enabled: desired.enabled,
              preRelease: desired.preRelease,
              pinned: desired.pinned,
              ...(sourceTimestamp > 0
                ? { lastUpdatedAt: sourceTimestamp }
                : {}),
            },
          });
          retainedBytes += content.byteLength;
          deferred.add(resourceId);
          profileNeedsRetry = true;
          this.oversized.delete(resourceId);
        }
      } catch (error) {
        warnings.push(
          `Unable to enumerate extensions for ${profile.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        deferred.add(`extension-profile/${encodeURIComponent(profile.id)}`);
        this.failedProfileIds.add(profile.id);
        profileFailed = true;
      }
    }

    if (this.profileSweepManifestUnreadable) {
      deferred.add("extension-profiles/manifest");
    }
    const shouldAdvanceProfile =
      profile !== undefined && (profileFailed || !profileNeedsRetry);
    if (profile !== undefined && !profileFailed && !profileNeedsRetry) {
      this.failedProfileIds.delete(profile.id);
    }
    if (snapshots.length > 0) {
      const fingerprint = snapshots
        .map((snapshot) => `${snapshot.resourceId}:${snapshot.semanticHash}`)
        .join("\0");
      if (fingerprint !== this.lastEmittedPageFingerprint) {
        this.progressRevision += 1;
        this.lastEmittedPageFingerprint = fingerprint;
      }
    }
    if (shouldAdvanceProfile && this.profileSweep !== null) {
      this.profileSweepIndex += 1;
      if (!this.profileSweepRetryOnly) {
        this.progressRevision += 1;
      }
      this.lastEmittedPageFingerprint = null;
      if (this.profileSweepIndex >= this.profileSweep.length) {
        const retryProfiles = this.profileSweep.filter((candidate) =>
          this.failedProfileIds.has(candidate.id),
        );
        if (retryProfiles.length > 0) {
          if (!this.profileSweepRetryOnly) {
            this.progressRevision += 1;
          }
          this.profileSweep = retryProfiles;
          this.profileSweepIndex = 0;
          this.profileSweepRetryOnly = true;
          for (const retry of retryProfiles) {
            deferred.add(
              `extension-profile/${encodeURIComponent(retry.id)}`,
            );
          }
        } else {
          this.profileSweep = null;
          this.profileSweepIndex = 0;
          this.profileSweepRetryOnly = false;
          this.progressRevision += 1;
          this.nextSweepAt = this.profileSweepManifestUnreadable
            ? 0
            : now + (this.options.scanIntervalMs ?? 30_000);
        }
      } else {
        deferred.add(
          `extension-profile/${encodeURIComponent(
            this.profileSweep[this.profileSweepIndex]!.id,
          )}`,
        );
      }
    }

    if (this.oversizedOverflow) {
      deferred.add("extension-scope/untracked-oversized-resources");
    }
    this.lastScanStatus = {
      complete: deferred.size === 0,
      deferredResourceIds: [...deferred].sort((left, right) =>
        left.localeCompare(right),
      ),
      progressToken: this.progressRevision,
    };
    return {
      snapshots,
      // A bounded per-profile page does not retain an all-profile installed
      // set, so absence cannot safely originate an uninstall tombstone.
      deletions: [],
      warnings,
    };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Extension state must be applied by the offline helper.");
  }

  private rememberProfileScan(profileId: string, memo: ProfileScanMemo): void {
    const previous = this.scanMemo.get(profileId);
    if (previous !== undefined) {
      this.scanMemoIdentifiers -=
        previous.installed.length + previous.disabled.size;
      this.scanMemoIdentifierBytes -= previous.identifierBytes;
      this.scanMemo.delete(profileId);
    }
    const identifiers = memo.installed.length + memo.disabled.size;
    if (
      identifiers > MAX_EXTENSION_MEMO_IDENTIFIERS ||
      memo.identifierBytes > MAX_EXTENSION_MEMO_IDENTIFIER_BYTES
    ) {
      return;
    }
    this.scanMemo.set(profileId, memo);
    this.scanMemoIdentifiers += identifiers;
    this.scanMemoIdentifierBytes += memo.identifierBytes;
    this.enforceScanMemoLimit(profileId);
  }

  private enforceScanMemoLimit(retainProfileId: string): void {
    while (
      this.scanMemoIdentifiers + (this.extensionMetadataMemo?.value.size ?? 0) >
        MAX_EXTENSION_MEMO_IDENTIFIERS ||
      this.scanMemoIdentifierBytes +
          (this.extensionMetadataMemo?.identifierBytes ?? 0) >
        MAX_EXTENSION_MEMO_IDENTIFIER_BYTES
    ) {
      const oldest = this.scanMemo.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      const removed = this.scanMemo.get(oldest);
      this.scanMemo.delete(oldest);
      if (removed !== undefined) {
        this.scanMemoIdentifiers -=
          removed.installed.length + removed.disabled.size;
        this.scanMemoIdentifierBytes -= removed.identifierBytes;
      }
      if (oldest === retainProfileId) {
        break;
      }
    }
  }

  private async listInstalledExtensions(
    profileName: string | null,
  ): Promise<Array<{ id: string; version: string }>> {
    const args = ["--list-extensions", "--show-versions"];
    if (profileName !== null) {
      args.push("--profile", profileName);
    }
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(this.paths.appRoot, "out", "cli.js"), ...args],
      {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: MAX_EXTENSION_MANIFEST_BYTES,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    );
    if (Buffer.byteLength(stdout, "utf8") > MAX_EXTENSION_MANIFEST_BYTES) {
      throw new Error("Installed extension listing exceeds its byte limit.");
    }
    const installed: Array<{ id: string; version: string }> = [];
    let identifierByteCount = 0;
    let start = 0;
    for (let index = 0; index <= stdout.length; index += 1) {
      if (index < stdout.length && stdout[index] !== "\n") {
        continue;
      }
      const line = stdout
        .slice(start, index)
        .replace(/\r$/, "")
        .trim();
      start = index + 1;
      if (line.length === 0) {
        continue;
      }
      if (
        installed.length >= MAX_EXTENSION_IDENTIFIERS ||
        Buffer.byteLength(line, "utf8") > MAX_EXTENSION_IDENTIFIER_BYTES
      ) {
        throw new Error("Installed extension listing exceeds its entry limit.");
      }
      const separator = line.lastIndexOf("@");
      const entry =
        separator <= 0
          ? { id: line, version: "latest" }
          : {
              id: line.slice(0, separator),
              version: line.slice(separator + 1),
            };
      identifierByteCount +=
        Buffer.byteLength(entry.id, "utf8") +
        Buffer.byteLength(entry.version, "utf8");
      if (identifierByteCount > MAX_EXTENSION_COLLECTION_IDENTIFIER_BYTES) {
        throw new Error("Installed extension listing exceeds its identifier byte limit.");
      }
      installed.push(entry);
    }
    return installed;
  }

  private async readExtensionMetadata(): Promise<Map<string, ExtensionMetadata>> {
    if (!(await pathExists(this.paths.cursorExtensionsManifest))) {
      this.extensionMetadataMemo = null;
      return new Map();
    }
    const manifestInfo = await stat(this.paths.cursorExtensionsManifest);
    if (
      this.extensionMetadataMemo?.size === manifestInfo.size &&
      this.extensionMetadataMemo.mtimeMs === manifestInfo.mtimeMs
    ) {
      return this.extensionMetadataMemo.value;
    }
    const manifestLimit = Math.min(
      generalResourceLimit(this.maxPayloadBytes),
      MAX_EXTENSION_MANIFEST_BYTES,
    );
    if (manifestInfo.size > manifestLimit) {
      throw new Error(
        `Extension manifest is ${manifestInfo.size} bytes, above the ${manifestLimit}-byte read limit.`,
      );
    }
    const result = await readBoundedExtensionManifestMetadata(
      this.paths,
      manifestLimit,
      this.options.onManifestRead,
    );
    this.extensionMetadataMemo = {
      size: manifestInfo.size,
      mtimeMs: manifestInfo.mtimeMs,
      value: result,
      identifierBytes: identifierBytes(result.keys()),
    };
    this.enforceScanMemoLimit("");
    return result;
  }
}

export async function readBoundedExtensionManifestMetadata(
  paths: CursorPaths,
  maxBytes = MAX_EXTENSION_MANIFEST_BYTES,
  onManifestRead?: () => void,
): Promise<Map<string, ExtensionMetadata>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Extension manifest read limit must be positive.");
  }
  const limit = Math.min(maxBytes, MAX_EXTENSION_MANIFEST_BYTES);
  const info = await stat(paths.cursorExtensionsManifest);
  if (!info.isFile() || info.size > limit) {
    throw new Error(
      `Extension manifest is ${info.size} bytes, above the ${limit}-byte read limit.`,
    );
  }
  onManifestRead?.();
  const source = (
    await readFileWithinRoot(
      paths.cursorHome,
      normalizeResourcePath(
        relative(paths.cursorHome, paths.cursorExtensionsManifest),
      ),
      limit,
    )
  ).toString("utf8");
  assertBoundedJsonCollection(
    source,
    MAX_EXTENSION_IDENTIFIERS,
    "Extension manifest",
  );
  assertBoundedJsoncStructure(source, "Extension manifest");
  const parsed = JSON.parse(source) as unknown;
  const result = new Map<string, ExtensionMetadata>();
  let identifierByteCount = 0;
  if (!Array.isArray(parsed)) {
    return result;
  }
  if (parsed.length > MAX_EXTENSION_IDENTIFIERS) {
    throw new Error("Extension manifest exceeds its entry limit.");
  }
  for (const item of parsed) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const identifier = record.identifier;
    const id =
      identifier !== null && typeof identifier === "object"
        ? (identifier as Record<string, unknown>).id
        : undefined;
    if (typeof id !== "string") {
      continue;
    }
    if (Buffer.byteLength(id, "utf8") > MAX_EXTENSION_IDENTIFIER_BYTES) {
      throw new Error("Extension manifest contains an oversized identifier.");
    }
    identifierByteCount += Buffer.byteLength(id, "utf8");
    if (identifierByteCount > MAX_EXTENSION_COLLECTION_IDENTIFIER_BYTES) {
      throw new Error("Extension manifest exceeds its identifier byte limit.");
    }
    const itemMetadata =
      record.metadata !== null && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : {};
    result.set(id.toLowerCase(), {
      preRelease:
        itemMetadata.isPreReleaseVersion === true || record.preRelease === true,
      pinned: itemMetadata.pinned === true || record.pinned === true,
    });
    if (result.size > MAX_EXTENSION_IDENTIFIERS) {
      throw new Error("Extension manifest exceeds its identifier limit.");
    }
  }
  return result;
}

function profileDatabasePath(paths: CursorPaths, profileId: string): string {
  return profileId === "default"
    ? paths.globalDatabase
    : join(paths.profilesRoot, profileId, "globalStorage", "state.vscdb");
}

async function mtimeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

async function databaseMtimeOrNull(path: string): Promise<number | null> {
  const main = await mtimeOrNull(path);
  if (main === null) {
    return null;
  }
  const wal = await mtimeOrNull(`${path}-wal`);
  return wal === null ? main : Math.max(main, wal);
}

function readDisabledExtensions(
  paths: CursorPaths,
  profileId: string,
  maxBytes: number,
  onValueRead?: (profileId: string) => void,
): Set<string> {
  const databasePath = profileDatabasePath(paths, profileId);
  if (!existsSync(databasePath)) {
    return new Set();
  }
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const key = "extensionsIdentifiers/disabled";
    const metadata = inspectSqliteValue(database, key);
    if (metadata.byteLength !== null && metadata.byteLength > maxBytes) {
      throw new OversizedSqliteValueError(
        `${profileId}:${key}`,
        metadata.byteLength,
        maxBytes,
      );
    }
    onValueRead?.(profileId);
    const raw = readSqliteValue(database, key);
    // A NULL disabled list means "nothing is disabled", exactly like an
    // absent row; this path is read-only so the NULL stays on disk.
    if (raw === undefined || raw === null) {
      return new Set();
    }
    const text = sqliteStorageText(raw, "extensionsIdentifiers/disabled");
    if (text.trim().length === 0) {
      return new Set();
    }
    assertBoundedJsonCollection(
      text,
      MAX_EXTENSION_IDENTIFIERS,
      `Disabled extension list for ${profileId}`,
    );
    assertBoundedJsoncStructure(
      text,
      `Disabled extension list for ${profileId}`,
    );
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    if (parsed.length > MAX_EXTENSION_IDENTIFIERS) {
      throw new Error("Disabled extension list exceeds its entry limit.");
    }
    const disabled = new Set<string>();
    let identifierByteCount = 0;
    for (const item of parsed) {
      const id =
        typeof item === "string"
          ? item
          : item !== null && typeof item === "object"
            ? (item as Record<string, unknown>).id
            : undefined;
      if (typeof id !== "string") {
        continue;
      }
      if (Buffer.byteLength(id, "utf8") > MAX_EXTENSION_IDENTIFIER_BYTES) {
        throw new Error("Disabled extension list contains an oversized ID.");
      }
      identifierByteCount += Buffer.byteLength(id, "utf8");
      if (identifierByteCount > MAX_EXTENSION_COLLECTION_IDENTIFIER_BYTES) {
        throw new Error(
          "Disabled extension list exceeds its identifier byte limit.",
        );
      }
      disabled.add(id.toLowerCase());
      if (disabled.size > MAX_EXTENSION_IDENTIFIERS) {
        throw new Error("Disabled extension list exceeds its identifier limit.");
      }
    }
    return disabled;
  } finally {
    database.close();
  }
}

function extensionResourceId(profileId: string, extensionId: string): string {
  return `extension/${encodeURIComponent(profileId)}/${encodeURIComponent(extensionId)}`;
}

function identifierBytes(values: Iterable<string>): number {
  let total = 0;
  for (const value of values) {
    total += Buffer.byteLength(value, "utf8");
  }
  return total;
}

function installedIdentifierBytes(
  values: Iterable<{ id: string; version: string }>,
): number {
  let total = 0;
  for (const value of values) {
    total +=
      Buffer.byteLength(value.id, "utf8") +
      Buffer.byteLength(value.version, "utf8");
  }
  return total;
}

function projectionMatchesSemantic(
  projection: LocalProjection | undefined,
  semanticHash: string,
): boolean {
  return (
    projection?.semanticHash === semanticHash ||
    projection?.retainedLocalHash === semanticHash
  );
}

function assertBoundedJsonCollection(
  source: string,
  maxEntries: number,
  label: string,
): void {
  let depth = 0;
  let separators = 0;
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[" || character === "{") {
      depth += 1;
      continue;
    }
    if (character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character === "," && depth === 1) {
      separators += 1;
      if (separators >= maxEntries) {
        throw new Error(`${label} exceeds its ${maxEntries}-entry limit.`);
      }
    }
  }
}
