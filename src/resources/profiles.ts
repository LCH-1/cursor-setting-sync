import { basename } from "node:path";
import type { SqliteStorageValue } from "../platform/sqlite";
import { openDatabase, sqliteStorageText } from "../platform/sqlite";
import type {
  JsonValue,
  LocalProjection,
  ResourceScanResult,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import { serializeCanonical, semanticHash } from "./jsonc";
import type { ResourceAdapter, ResourceApplyInput } from "./resource";
import { assertValidProfileId } from "./profilePaths";

export interface PortableProfile {
  id: string;
  name: string;
  icon?: string;
  useDefaultFlags?: Record<string, boolean>;
}

export class ProfilesAdapter implements ResourceAdapter {
  readonly id = "profiles";
  readonly kinds = ["profile"] as const;
  readonly appliesWhileRunning = false;

  constructor(private readonly paths: CursorPaths) {}

  async scan(_known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    let profiles: PortableProfile[];
    try {
      profiles = this.readPortableProfiles();
    } catch (error) {
      // Publishing an empty manifest here would delete every profile on the
      // other PCs, so an unreadable manifest publishes nothing at all.
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
    return {
      snapshots: [
        {
          resourceId: "profile/manifest",
          kind: "profile",
          content: serializeCanonical(value),
          semanticHash: semanticHash(value),
          metadata: { count: profiles.length },
        },
      ],
      deletions: [],
      warnings: [],
    };
  }

  async apply(_input: ResourceApplyInput): Promise<void> {
    throw new Error("Profile manifests must be applied by the offline helper.");
  }

  private readPortableProfiles(): PortableProfile[] {
    return readPortableProfiles(this.paths.globalDatabase);
  }
}

export function readPortableProfiles(databasePath: string): PortableProfile[] {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("userDataProfiles") as { value?: SqliteStorageValue } | undefined;
    const raw = row?.value;
    // A NULL manifest means "no profiles", exactly like an absent row. This
    // path never writes, so the NULL is left untouched on disk.
    if (raw === undefined || raw === null) {
      return [];
    }
    const text = sqliteStorageText(raw, "userDataProfiles");
    if (text.trim().length === 0) {
      return [];
    }
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
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
  const value = JSON.parse(content.toString("utf8")) as unknown;
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

function normalizeProfile(value: unknown): PortableProfile {
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
