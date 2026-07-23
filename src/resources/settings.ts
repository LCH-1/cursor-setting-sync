import type {
  JsonValue,
  LocalProjection,
  ResourceDeletion,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  normalizeResourcePath,
  pathExists,
  readFileWithinRoot,
  writeFileAtomicWithinRoot,
} from "../platform/files";
import type {
  ResourceAdapter,
  ResourceApplyInput,
  ResourceApplyResult,
} from "./resource";
import { isDeletion } from "./resource";
import {
  parseJsonc,
  parseJsoncObject,
  semanticHash,
  serializeCanonical,
  setJsoncProperty,
} from "./jsonc";
import { discoverProfileResourcePaths, profilePathById } from "./profilePaths";
import { sha256 } from "../protocol/canonical";
import { relative } from "node:path";

export class SettingsAdapter implements ResourceAdapter {
  readonly id = "settings";
  readonly kinds = ["settings"] as const;
  readonly appliesWhileRunning = true;

  constructor(
    private readonly paths: CursorPaths,
    private readonly ignoredSettings: Set<string>,
    private readonly machineScopedSettings: Set<string>,
  ) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const current = new Set<string>();
    const excluded = new Set<string>();
    const scannedProfiles = new Set<string>();

    for (const profile of await discoverProfileResourcePaths(this.paths)) {
      if (!(await pathExists(profile.settings))) {
        scannedProfiles.add(profile.profileId);
        continue;
      }
      try {
        const settingsRelativePath = normalizeResourcePath(
          relative(this.paths.userDataRoot, profile.settings),
        );
        const source = (
          await readFileWithinRoot(
            this.paths.userDataRoot,
            settingsRelativePath,
          )
        ).toString("utf8");
        const object = parseJsoncObject(source, profile.settings);
        scannedProfiles.add(profile.profileId);
        const nativeIgnored = readStringArray(object["settingsSync.ignoredSettings"]);
        const ignored = new Set([...this.ignoredSettings, ...nativeIgnored]);
        for (const key of [...ignored, ...this.machineScopedSettings]) {
          excluded.add(settingsResourceId(profile.profileId, key));
        }
        for (const [key, value] of Object.entries(object)) {
          if (ignored.has(key) || this.machineScopedSettings.has(key)) {
            continue;
          }
          const resourceId = settingsResourceId(profile.profileId, key);
          current.add(resourceId);
          snapshots.push({
            resourceId,
            kind: "settings",
            content: serializeCanonical(value),
            semanticHash: semanticHash(value),
            metadata: {
              profileId: profile.profileId,
              key,
            },
          });
        }
      } catch (error) {
        warnings.push(toErrorMessage(error));
      }
    }

    return {
      snapshots,
      deletions: findDeletions(
        known,
        current,
        excluded,
        scannedProfiles,
        this.ignoredSettings,
        this.machineScopedSettings,
      ),
      warnings,
    };
  }

  async apply(input: ResourceApplyInput): Promise<ResourceApplyResult> {
    const profileId = metadataString(input.metadata, "profileId");
    const key = metadataString(input.metadata, "key");
    if (input.resourceId !== settingsResourceId(profileId, key)) {
      throw new Error(`Settings metadata does not match ${input.resourceId}.`);
    }
    const target = profilePathById(this.paths, profileId).settings;
    const targetRelativePath = normalizeResourcePath(
      relative(this.paths.userDataRoot, target),
    );
    let source = "{\n}\n";
    if (await pathExists(target)) {
      source = (
        await readFileWithinRoot(this.paths.userDataRoot, targetRelativePath)
      ).toString("utf8");
    }

    const object = parseJsoncObject(source, target);
    const nativeIgnored = new Set(
      readStringArray(object["settingsSync.ignoredSettings"]),
    );
    if (
      this.ignoredSettings.has(key) ||
      this.machineScopedSettings.has(key) ||
      nativeIgnored.has(key)
    ) {
      const localValue = object[key];
      return {
        status: "retained-local",
        semanticHash:
          localValue === undefined
            ? sha256(`deleted:${input.resourceId}`)
            : semanticHash(localValue),
      };
    }

    const value = isDeletion(input)
      ? undefined
      : parseJsonc(input.content.toString("utf8"), input.resourceId);
    const updated = setJsoncProperty(source, [key], value);
    parseJsoncObject(updated, target);
    await writeFileAtomicWithinRoot(
      this.paths.userDataRoot,
      targetRelativePath,
      Buffer.from(updated, "utf8"),
    );
  }
}

export function collectMachineScopedSettings(
  extensionPackageJson: unknown[],
): Set<string> {
  const machine = new Set<string>();
  for (const packageJson of extensionPackageJson) {
    if (packageJson === null || typeof packageJson !== "object") {
      continue;
    }
    const contributes = (packageJson as Record<string, unknown>).contributes;
    if (contributes === null || typeof contributes !== "object") {
      continue;
    }
    const configurations = normalizeConfigurations(
      (contributes as Record<string, unknown>).configuration,
    );
    for (const configuration of configurations) {
      const properties = configuration.properties;
      if (properties === null || typeof properties !== "object") {
        continue;
      }
      for (const [key, definition] of Object.entries(properties)) {
        if (
          definition !== null &&
          typeof definition === "object" &&
          ["machine", "machine-overridable"].includes(
            String((definition as Record<string, unknown>).scope),
          )
        ) {
          machine.add(key);
        }
      }
    }
  }
  return machine;
}

function settingsResourceId(profileId: string, key: string): string {
  return `settings/${encodeURIComponent(profileId)}/${encodeURIComponent(key)}`;
}

function findDeletions(
  known: Record<string, LocalProjection>,
  current: Set<string>,
  excluded: Set<string>,
  scannedProfiles: Set<string>,
  ignoredSettings: Set<string>,
  machineScopedSettings: Set<string>,
): ResourceDeletion[] {
  return Object.values(known)
    .filter((projection) => {
      if (
        projection.kind !== "settings" ||
        current.has(projection.resourceId) ||
        excluded.has(projection.resourceId)
      ) {
        return false;
      }
      const metadata = projectionMetadata(projection.resourceId);
      return (
        scannedProfiles.has(metadata.profileId) &&
        !ignoredSettings.has(metadata.key) &&
        !machineScopedSettings.has(metadata.key)
      );
    })
    .map((projection) => ({
      resourceId: projection.resourceId,
      kind: "settings",
      semanticHash: sha256(`deleted:${projection.resourceId}`),
      metadata: projectionMetadata(projection.resourceId),
    }));
}

function projectionMetadata(resourceId: string): { profileId: string; key: string } {
  const [, profileId, key] = resourceId.split("/");
  if (profileId === undefined || key === undefined) {
    throw new Error(`Invalid settings resource ID: ${resourceId}`);
  }
  return {
    profileId: decodeURIComponent(profileId),
    key: decodeURIComponent(key),
  };
}

function metadataString(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string {
  const value = metadata?.[key];
  if (typeof value !== "string") {
    throw new Error(`Resource metadata is missing ${key}.`);
  }
  return value;
}

function readStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeConfigurations(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object",
    );
  }
  return value !== null && typeof value === "object"
    ? [value as Record<string, unknown>]
    : [];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
