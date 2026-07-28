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
import type { IgnoreMatcher } from "./ignorePatterns";
import {
  combineIgnoreMatchers,
  createIgnoreMatcher,
  EMPTY_IGNORE_MATCHER,
} from "./ignorePatterns";

/**
 * Keys that describe *this computer* rather than a preference, and that VS
 * Code registers in workbench code instead of an extension `package.json` — so
 * `collectMachineScopedSettings` cannot see them and they would otherwise sync
 * verbatim between machines. A proxy URL carries credentials; a shell path
 * points at an executable that may not exist on the other side; a zoom level
 * belongs to a monitor. Users who genuinely want one of these to travel can
 * set `cursorSettingSync.useDefaultIgnoredSettings` to false and curate
 * `cursorSettingSync.ignoredSettings` themselves.
 *
 * The bar for being on this list is that the *value* names something that has
 * to exist on this computer — an absolute path, a shell or host resource, a
 * network endpoint or credential — or a property of the physical display.
 * Anything VS Code's own Settings Sync propagates between
 * machines is deliberately absent, because excluding it here would stop a key
 * travelling that the user already expects to travel:
 * `terminal.integrated.profiles.*` and `terminal.integrated.env.*` are
 * application-scoped preferences (and the `.windows` / `.osx` / `.linux`
 * suffix already keeps a platform's entry off the other platforms),
 * `files.simpleDialog.enable` is a plain UI preference, and `python.venvPath`
 * is declared `machine`-scoped by the Python extension itself, so
 * `collectMachineScopedSettings` already excludes it wherever it matters.
 */
export const DEFAULT_IGNORED_SETTINGS: readonly string[] = [
  "application.shellEnvironmentResolutionTimeout",
  "git.path",
  "http.proxy*",
  "http.systemCertificates",
  "http.experimental.systemCertificatesV2",
  "java.jdt.ls.java.home",
  "python.condaPath",
  "python.defaultInterpreterPath",
  "remote.SSH.*",
  "remote.WSL.*",
  "terminal.external.*",
  "terminal.integrated.automationProfile.*",
  "terminal.integrated.cwd",
  "terminal.integrated.defaultProfile.*",
  "terminal.integrated.shell.*",
  "terminal.integrated.shellArgs.*",
  "window.zoomLevel",
  "window.zoomPerWindow",
];

/** Ignore-list flavour shared by settings keys and extension identifiers. */
export function createSettingsIgnoreMatcher(
  entries: readonly string[],
): IgnoreMatcher {
  return createIgnoreMatcher(entries);
}

export class SettingsAdapter implements ResourceAdapter {
  readonly id = "settings";
  readonly kinds = ["settings"] as const;
  readonly appliesWhileRunning = true;

  constructor(
    private readonly paths: CursorPaths,
    private readonly ignoredSettings: IgnoreMatcher,
    private readonly machineScopedSettings: IgnoreMatcher,
    /**
     * The built-in {@link DEFAULT_IGNORED_SETTINGS} in force, used only to
     * report which keys the defaults took over. Exclusion itself is decided by
     * `machineScopedSettings`, which already contains them.
     */
    private readonly defaultIgnoredSettings: IgnoreMatcher = EMPTY_IGNORE_MATCHER,
  ) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const notices: string[] = [];
    const current = new Set<string>();
    const scannedProfiles = new Set<string>();
    const nativeIgnoredByProfile = new Map<string, IgnoreMatcher>();
    const observedKeys = new Set<string>();
    let observedKeysComplete = true;
    const silencedByDefaults = new Set<string>();

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
        const nativeIgnored = createIgnoreMatcher(
          readStringArray(object["settingsSync.ignoredSettings"]),
        );
        nativeIgnoredByProfile.set(profile.profileId, nativeIgnored);
        for (const [key, value] of Object.entries(object)) {
          observedKeys.add(key);
          const resourceId = settingsResourceId(profile.profileId, key);
          if (
            nativeIgnored.matches(key) ||
            this.ignoredSettings.matches(key) ||
            this.machineScopedSettings.matches(key)
          ) {
            if (
              this.defaultIgnoredSettings.matches(key) &&
              !this.ignoredSettings.matches(key) &&
              !nativeIgnored.matches(key) &&
              known[resourceId] !== undefined
            ) {
              silencedByDefaults.add(key);
            }
            continue;
          }
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
        observedKeysComplete = false;
      }
    }

    // A configured entry that matched nothing is almost always a typo or an
    // unsupported pattern, and silence there means the user believes a key is
    // excluded when it is not. Only claimable when every settings file was
    // actually read: a profile that failed to parse leaves its keys out of
    // observedKeys, and reporting each configured entry as "excluding
    // nothing" on that basis told the user to delete entries that were fine.
    if (observedKeysComplete) {
      for (const pattern of this.ignoredSettings.unmatched(observedKeys)) {
        warnings.push(
          `cursorSettingSync.ignoredSettings entry "${pattern}" matched no settings key. Correct the typo or remove the entry; nothing is being excluded by it.`,
        );
      }
    }

    // A key the built-in defaults took over is otherwise completely silent:
    // findDeletions suppresses the tombstone, apply answers "retained-local"
    // and the status bar keeps its green check, so the user has no way to
    // learn why a setting stopped travelling after an upgrade. The text is
    // stable, so StandingWarningRegistry logs it once and then only on its
    // reminder interval, and Show Diagnostics lists it under this adapter.
    if (silencedByDefaults.size > 0) {
      notices.push(
        `Built-in machine-specific defaults now exclude settings keys this device had already synchronized: ${[
          ...silencedByDefaults,
        ]
          .sort()
          .join(
            ", ",
          )}. Their existing values stay on each computer; set cursorSettingSync.useDefaultIgnoredSettings to false to synchronize them again.`,
      );
    }

    const isIgnoredKey = (profileId: string, key: string): boolean =>
      this.ignoredSettings.matches(key) ||
      this.machineScopedSettings.matches(key) ||
      nativeIgnoredByProfile.get(profileId)?.matches(key) === true;

    return {
      snapshots,
      deletions: findDeletions(known, current, scannedProfiles, isIgnoredKey),
      warnings,
      notices,
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
    const nativeIgnored = createIgnoreMatcher(
      readStringArray(object["settingsSync.ignoredSettings"]),
    );
    if (
      combineIgnoreMatchers(
        this.ignoredSettings,
        this.machineScopedSettings,
        nativeIgnored,
      ).matches(key)
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
  scannedProfiles: Set<string>,
  isIgnoredKey: (profileId: string, key: string) => boolean,
): ResourceDeletion[] {
  return Object.values(known)
    .filter((projection) => {
      if (
        projection.kind !== "settings" ||
        current.has(projection.resourceId)
      ) {
        return false;
      }
      const metadata = projectionMetadata(projection.resourceId);
      return (
        scannedProfiles.has(metadata.profileId) &&
        !isIgnoredKey(metadata.profileId, metadata.key)
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
