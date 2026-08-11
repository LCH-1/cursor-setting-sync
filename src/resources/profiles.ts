import { basename } from "node:path";
import { openDatabase, sqliteStorageText } from "../platform/sqlite";
import type {
  JsonValue,
  LocalProjection,
  ResourceScanResult,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  assertBoundedJsoncStructure,
  serializeCanonical,
  semanticHash,
} from "./jsonc";
import type {
  OversizedSnapshotSettlement,
  ResourceAdapter,
  ResourceApplyInput,
  ResourceScanStatus,
} from "./resource";
import { assertValidProfileId } from "./profilePaths";
import { DEFAULT_MAX_PAYLOAD_MIB } from "../constants";
import {
  GENERAL_MAX_RESOURCE_BYTES,
  GENERAL_MAX_RETAINED_BYTES_PER_SCAN,
  OversizedSqliteValueError,
  generalOversizedObservation,
  generalOversizedWarning,
  generalResourceLimit,
  inspectSqliteValue,
  readSqliteValue,
  sqliteDatabaseTimestamp,
  type GeneralOversizedObservation,
} from "./boundedScan";

export interface PortableProfile {
  id: string;
  name: string;
  icon?: string;
  useDefaultFlags?: Record<string, boolean>;
}

export interface ProfilesAdapterOptions {
  onValueRead?: () => void;
  forceVerificationResourceIds?: ReadonlySet<string>;
}

export class ProfilesAdapter implements ResourceAdapter {
  readonly id = "profiles";
  readonly kinds = ["profile"] as const;
  readonly appliesWhileRunning = false;

  private maxPayloadBytes = DEFAULT_MAX_PAYLOAD_MIB * 1024 * 1024;
  private lastScanStatus: ResourceScanStatus = {
    complete: true,
    deferredResourceIds: [],
  };
  private oversized: GeneralOversizedObservation | null = null;

  constructor(
    private readonly paths: CursorPaths,
    private readonly options: ProfilesAdapterOptions = {},
  ) {}

  setMaxPayloadBytes(maxPayloadBytes: number): void {
    generalResourceLimit(maxPayloadBytes);
    if (this.maxPayloadBytes !== maxPayloadBytes) {
      this.maxPayloadBytes = maxPayloadBytes;
      this.oversized = null;
    }
  }

  scanStatus(): ResourceScanStatus {
    return this.lastScanStatus;
  }

  oversizedSnapshotSettlements(
    _maxPayloadBytes: number,
  ): readonly OversizedSnapshotSettlement[] {
    return this.oversized === null ? [] : [this.oversized];
  }

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const resourceId = "profile/manifest";
    const databaseTimestamp = await sqliteDatabaseTimestamp(
      this.paths.globalDatabase,
    );
    if (
      databaseTimestamp !== null &&
      !this.options.forceVerificationResourceIds?.has(resourceId) &&
      known[resourceId]?.sourceTimestamp === databaseTimestamp
    ) {
      this.lastScanStatus = { complete: true, deferredResourceIds: [] };
      return { snapshots: [], deletions: [], warnings: [] };
    }
    let profiles: PortableProfile[];
    const limit = Math.min(
      generalResourceLimit(this.maxPayloadBytes),
      GENERAL_MAX_RETAINED_BYTES_PER_SCAN,
    );
    try {
      profiles = this.readPortableProfiles(limit);
    } catch (error) {
      if (error instanceof OversizedSqliteValueError) {
        this.oversized = generalOversizedObservation(
          resourceId,
          `${databaseTimestamp ?? "missing"}:${error.byteLength}`,
          error.byteLength,
          this.maxPayloadBytes,
        );
        this.lastScanStatus = { complete: true, deferredResourceIds: [] };
        return {
          snapshots: [],
          deletions: [],
          warnings: [generalOversizedWarning("Profile manifest", this.oversized)],
        };
      }
      // Publishing an empty manifest here would delete every profile on the
      // other PCs, so an unreadable manifest publishes nothing at all.
      this.lastScanStatus = {
        complete: false,
        deferredResourceIds: [resourceId],
      };
      return {
        snapshots: [],
        deletions: [],
        warnings: [
          `Unable to read the profile manifest: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
    const value = profiles as unknown as JsonValue;
    const content = serializeCanonical(value);
    if (content.byteLength > limit) {
      this.oversized = generalOversizedObservation(
        resourceId,
        `${databaseTimestamp ?? "missing"}:${content.byteLength}`,
        content.byteLength,
        this.maxPayloadBytes,
      );
      this.lastScanStatus = { complete: true, deferredResourceIds: [] };
      return {
        snapshots: [],
        deletions: [],
        warnings: [generalOversizedWarning("Profile manifest", this.oversized)],
      };
    }
    this.oversized = null;
    this.lastScanStatus = { complete: true, deferredResourceIds: [] };
    return {
      snapshots: [
        {
          resourceId,
          kind: "profile",
          content,
          semanticHash: semanticHash(value),
          metadata: {
            count: profiles.length,
            ...(databaseTimestamp === null
              ? {}
              : { lastUpdatedAt: databaseTimestamp }),
          },
        },
      ],
      deletions: [],
      warnings: [],
    };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Profile manifests must be applied by the offline helper.");
  }

  private readPortableProfiles(maxBytes: number): PortableProfile[] {
    return readPortableProfiles(
      this.paths.globalDatabase,
      maxBytes,
      this.options.onValueRead,
    );
  }
}

export function readPortableProfiles(
  databasePath: string,
  maxBytes = GENERAL_MAX_RESOURCE_BYTES,
  onValueRead?: () => void,
): PortableProfile[] {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const metadata = inspectSqliteValue(database, "userDataProfiles");
    if (
      metadata.byteLength !== null &&
      metadata.byteLength > maxBytes
    ) {
      throw new OversizedSqliteValueError(
        "userDataProfiles",
        metadata.byteLength,
        maxBytes,
      );
    }
    onValueRead?.();
    const raw = readSqliteValue(database, "userDataProfiles");
    // A NULL manifest means "no profiles", exactly like an absent row. This
    // path never writes, so the NULL is left untouched on disk.
    if (raw === undefined || raw === null) {
      return [];
    }
    const text = sqliteStorageText(raw, "userDataProfiles");
    if (text.trim().length === 0) {
      return [];
    }
    assertBoundedJsoncStructure(text, "userDataProfiles");
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 100) {
      throw new Error("userDataProfiles is not an array.");
    }
    return parsed
      .map(normalizeProfile)
      .sort((left, right) => left.id.localeCompare(right.id));
  } finally {
    database.close();
  }
}

export function parsePortableProfiles(content: Buffer): PortableProfile[] {
  const source = content.toString("utf8");
  assertBoundedJsoncStructure(source, "Portable profile manifest");
  const value = JSON.parse(source) as unknown;
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Portable profile manifest is invalid.");
  }
  const profiles = value.map((item): PortableProfile => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Portable profile entry is invalid.");
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    const name = record.name;
    if (typeof id !== "string" || typeof name !== "string" || name.length === 0) {
      throw new Error("Portable profile identity is invalid.");
    }
    assertValidProfileId(id);
    const profile: PortableProfile = { id, name };
    if (typeof record.icon === "string") {
      profile.icon = record.icon;
    }
    if (
      record.useDefaultFlags !== undefined &&
      (record.useDefaultFlags === null ||
        typeof record.useDefaultFlags !== "object" ||
        Array.isArray(record.useDefaultFlags) ||
        Object.values(record.useDefaultFlags).some(
          (flag) => typeof flag !== "boolean",
        ))
    ) {
      throw new Error(`Portable profile flags are invalid: ${id}`);
    }
    if (record.useDefaultFlags !== undefined) {
      profile.useDefaultFlags = record.useDefaultFlags as Record<string, boolean>;
    }
    return profile;
  });
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error("Portable profile manifest contains duplicate IDs.");
  }
  return profiles;
}

export function normalizeProfile(value: unknown): PortableProfile {
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid stored profile entry.");
  }
  const record = value as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Stored profile name is missing.");
  }
  const id = profileIdFromLocation(record.location);
  const profile: PortableProfile = { id, name };
  if (typeof record.icon === "string") {
    profile.icon = record.icon;
  }
  if (
    record.useDefaultFlags !== null &&
    typeof record.useDefaultFlags === "object" &&
    !Array.isArray(record.useDefaultFlags)
  ) {
    profile.useDefaultFlags = Object.fromEntries(
      Object.entries(record.useDefaultFlags).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  }
  return profile;
}

function profileIdFromLocation(location: unknown): string {
  if (typeof location === "string") {
    return basename(location.replaceAll("\\", "/"));
  }
  if (location !== null && typeof location === "object") {
    const path = (location as Record<string, unknown>).path;
    if (typeof path === "string") {
      return basename(path.replaceAll("\\", "/"));
    }
  }
  throw new Error("Stored profile location is unsupported.");
}
