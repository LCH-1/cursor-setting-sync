import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative } from "node:path";
import { stat } from "node:fs/promises";
import type { SqliteStorageValue } from "../platform/sqlite";
import { openDatabase, sqliteStorageText } from "../platform/sqlite";
import { existsSync } from "node:fs";
import type {
  JsonValue,
  LocalProjection,
  ResourceDeletion,
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
import { semanticHash, serializeCanonical } from "./jsonc";
import type { ResourceAdapter, ResourceApplyInput } from "./resource";
import { readPortableProfiles } from "./profiles";
import { EXTENSION_ID } from "../constants";

const execFileAsync = promisify(execFile);

interface ExtensionDesiredState {
  id: string;
  version: string;
  installed: true;
  enabled: boolean;
  preRelease: boolean;
  pinned: boolean;
}

interface ExtensionMetadata {
  preRelease: boolean;
  pinned: boolean;
}

interface ProfileScanMemo {
  manifestMtimeMs: number | null;
  databaseMtimeMs: number | null;
  registryMtimeMs: number | null;
  installed: Array<{ id: string; version: string }>;
  disabled: Set<string>;
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

  constructor(
    private readonly paths: CursorPaths,
    private readonly ignoredExtensions: Set<string>,
  ) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const current = new Set<string>();
    const scannedProfiles = new Set<string>();
    const metadata = await this.readExtensionMetadata();
    const manifestMtimeMs = await mtimeOrNull(this.paths.cursorExtensionsManifest);
    // An unreadable profile manifest must degrade to "default profile only"
    // instead of taking down extension sync entirely. Profiles missing from
    // the list are also absent from scannedProfiles, so findDeletions
    // suppresses their deletions rather than uninstalling them elsewhere.
    let declaredProfiles: Array<{ id: string; name: string }> = [];
    try {
      declaredProfiles = readPortableProfiles(this.paths.globalDatabase).map(
        (profile) => ({ id: profile.id, name: profile.name }),
      );
    } catch (error) {
      warnings.push(
        `Unable to enumerate profiles: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const profiles = [{ id: "default", name: "Default" }, ...declaredProfiles];

    for (const profile of profiles) {
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
        if (
          memo !== undefined &&
          memo.manifestMtimeMs === manifestMtimeMs &&
          memo.databaseMtimeMs === databaseMtimeMs &&
          memo.registryMtimeMs === registryMtimeMs
        ) {
          installed = memo.installed;
          disabled = memo.disabled;
        } else {
          installed = await this.listInstalledExtensions(
            profile.id === "default" ? null : profile.name,
          );
          disabled = readDisabledExtensions(this.paths, profile.id);
          this.scanMemo.set(profile.id, {
            manifestMtimeMs,
            databaseMtimeMs,
            registryMtimeMs,
            installed,
            disabled,
          });
        }
        scannedProfiles.add(profile.id);
        for (const entry of installed) {
          const id = entry.id.toLowerCase();
          if (
            id === EXTENSION_ID.toLowerCase() ||
            this.ignoredExtensions.has(id)
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
          current.add(resourceId);
          snapshots.push({
            resourceId,
            kind: "extension",
            content: serializeCanonical(value),
            semanticHash: semanticHash(value),
            metadata: {
              profileId: profile.id,
              profileName: profile.name,
              extensionId: id,
              version: entry.version,
              enabled: desired.enabled,
              preRelease: desired.preRelease,
              pinned: desired.pinned,
            },
          });
        }
      } catch (error) {
        warnings.push(
          `Unable to enumerate extensions for ${profile.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      snapshots,
      deletions: findDeletions(
        known,
        current,
        new Map(profiles.map((profile) => [profile.id, profile.name])),
        scannedProfiles,
        this.ignoredExtensions,
      ),
      warnings,
    };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Extension state must be applied by the offline helper.");
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
      maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.lastIndexOf("@");
        if (separator <= 0) {
          return { id: line, version: "latest" };
        }
        return {
          id: line.slice(0, separator),
          version: line.slice(separator + 1),
        };
      });
  }

  private async readExtensionMetadata(): Promise<Map<string, ExtensionMetadata>> {
    const result = new Map<string, ExtensionMetadata>();
    if (!(await pathExists(this.paths.cursorExtensionsManifest))) {
      return result;
    }
    const parsed = JSON.parse(
      (
        await readFileWithinRoot(
          this.paths.cursorHome,
          normalizeResourcePath(
            relative(
              this.paths.cursorHome,
              this.paths.cursorExtensionsManifest,
            ),
          ),
        )
      ).toString("utf8"),
    ) as unknown;
    if (!Array.isArray(parsed)) {
      return result;
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
      const itemMetadata =
        record.metadata !== null && typeof record.metadata === "object"
          ? (record.metadata as Record<string, unknown>)
          : {};
      result.set(id.toLowerCase(), {
        preRelease:
          itemMetadata.isPreReleaseVersion === true || record.preRelease === true,
        pinned: itemMetadata.pinned === true || record.pinned === true,
      });
    }
    return result;
  }
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

function readDisabledExtensions(paths: CursorPaths, profileId: string): Set<string> {
  const databasePath = profileDatabasePath(paths, profileId);
  if (!existsSync(databasePath)) {
    return new Set();
  }
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("extensionsIdentifiers/disabled") as
      | { value?: SqliteStorageValue }
      | undefined;
    const raw = row?.value;
    // A NULL disabled list means "nothing is disabled", exactly like an
    // absent row; this path is read-only so the NULL stays on disk.
    if (raw === undefined || raw === null) {
      return new Set();
    }
    const text = sqliteStorageText(raw, "extensionsIdentifiers/disabled");
    if (text.trim().length === 0) {
      return new Set();
    }
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (item !== null && typeof item === "object") {
            return (item as Record<string, unknown>).id;
          }
          return undefined;
        })
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.toLowerCase()),
    );
  } finally {
    database.close();
  }
}

function findDeletions(
  known: Record<string, LocalProjection>,
  current: Set<string>,
  profileNames: Map<string, string>,
  scannedProfiles: Set<string>,
  ignoredExtensions: Set<string>,
): ResourceDeletion[] {
  return Object.values(known)
    .filter((projection) => {
      if (
        projection.kind !== "extension" ||
        current.has(projection.resourceId)
      ) {
        return false;
      }
      const parsed = parseExtensionResourceId(projection.resourceId);
      return (
        scannedProfiles.has(parsed.profileId) &&
        !ignoredExtensions.has(parsed.extensionId.toLowerCase()) &&
        parsed.extensionId.toLowerCase() !== EXTENSION_ID.toLowerCase()
      );
    })
    .map((projection) => {
      const { profileId, extensionId } = parseExtensionResourceId(
        projection.resourceId,
      );
      return {
        resourceId: projection.resourceId,
        kind: "extension",
        semanticHash: sha256(`deleted:${projection.resourceId}`),
        metadata: {
          profileId,
          profileName: profileNames.get(profileId) ?? profileId,
          extensionId,
        },
      };
    });
}

function extensionResourceId(profileId: string, extensionId: string): string {
  return `extension/${encodeURIComponent(profileId)}/${encodeURIComponent(extensionId)}`;
}

function parseExtensionResourceId(resourceId: string): {
  profileId: string;
  extensionId: string;
} {
  const [, profileId, extensionId] = resourceId.split("/");
  if (profileId === undefined || extensionId === undefined) {
    throw new Error(`Invalid extension resource ID: ${resourceId}`);
  }
  return {
    profileId: decodeURIComponent(profileId),
    extensionId: decodeURIComponent(extensionId),
  };
}
