import type {
  JsonValue,
  LocalProjection,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import { stat } from "node:fs/promises";
import type { CursorPaths } from "../platform/paths";
import {
  normalizeResourcePath,
  pathExists,
  readFileWithinRoot,
  writeFileAtomicWithinRoot,
} from "../platform/files";
import type {
  OversizedSnapshotSettlement,
  ResourceAdapter,
  ResourceApplyInput,
  ResourceApplyResult,
  ResourceScanStatus,
} from "./resource";
import { isDeletion } from "./resource";
import {
  assertBoundedJsoncStructure,
  parseJsonc,
  parseJsoncObject,
  semanticHash,
  serializeCanonical,
  setJsoncProperty,
} from "./jsonc";
import {
  ProfileResourcePathPager,
  profilePathById,
  type ProfileResourcePaths,
} from "./profilePaths";
import { sha256 } from "../protocol/canonical";
import { relative } from "node:path";
import type { IgnoreMatcher } from "./ignorePatterns";
import {
  combineIgnoreMatchers,
  createIgnoreMatcher,
  EMPTY_IGNORE_MATCHER,
} from "./ignorePatterns";
import { DEFAULT_MAX_PAYLOAD_MIB } from "../constants";
import {
  GENERAL_MAX_RESOURCES_PER_SCAN,
  GENERAL_MAX_RETAINED_BYTES_PER_SCAN,
  generalOversizedObservation,
  generalOversizedWarning,
  generalResourceLimit,
  rememberGeneralOversizedObservation,
  type GeneralOversizedObservation,
} from "./boundedScan";

export interface SettingsAdapterOptions {
  maxProfilesPerScan?: number;
  maxResourcesPerScan?: number;
  maxRetainedBytesPerScan?: number;
  profileIntervalMs?: number;
  now?: () => number;
  onFileRead?: (path: string) => void;
  onMetadataCheck?: (path: string) => void;
}

const MAX_SETTINGS_STRUCTURAL_TOKENS = 8_192;

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

  private maxPayloadBytes = DEFAULT_MAX_PAYLOAD_MIB * 1024 * 1024;
  private lastScanStatus: ResourceScanStatus = {
    complete: true,
    deferredResourceIds: [],
  };
  private readonly oversized = new Map<string, GeneralOversizedObservation>();
  private oversizedOverflow = false;
  private readonly profilePager = new ProfileResourcePathPager();
  private readonly pendingProfiles: ProfileResourcePaths[] = [];
  private readonly failedProfiles = new Map<string, ProfileResourcePaths>();
  private failedProfileOverflow = false;
  private profileEnumerationActive = false;
  private nextProfileEnumerationAt = 0;
  private progressRevision = 0;
  private lastEmittedPageFingerprint: string | null = null;

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
    private readonly options: SettingsAdapterOptions = {},
  ) {}

  setMaxPayloadBytes(maxPayloadBytes: number): void {
    generalResourceLimit(maxPayloadBytes);
    if (this.maxPayloadBytes !== maxPayloadBytes) {
      this.maxPayloadBytes = maxPayloadBytes;
      this.oversized.clear();
      this.oversizedOverflow = false;
      this.failedProfileOverflow = false;
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

  /** Closes the resumable native profile-directory cursor, if one is open. */
  async dispose(): Promise<void> {
    await this.profilePager.dispose();
  }

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const notices: string[] = [];
    const observedKeys = new Set<string>();
    let observedKeysComplete = true;
    const silencedByDefaults = new Set<string>();
    const deferred = new Set<string>();
    const now = (this.options.now ?? Date.now)();
    if (
      !this.profileEnumerationActive &&
      now >= this.nextProfileEnumerationAt
    ) {
      this.profileEnumerationActive = true;
      this.profilePager.restart();
      this.pendingProfiles.length = 0;
      this.oversized.clear();
      this.oversizedOverflow = false;
      // Overflow means an older failed profile fell out of the bounded retry
      // queue. A fresh full enumeration is the proof that makes it safe to
      // forget that sentinel; the active generation remains incomplete below
      // until its pager and every selected profile finish.
      this.failedProfileOverflow = false;
      this.progressRevision += 1;
      this.lastEmittedPageFingerprint = null;
    }
    if (
      this.profileEnumerationActive &&
      this.pendingProfiles.length === 0
    ) {
      const page = await this.profilePager.advance(this.paths, {
        maxProfiles: this.options.maxProfilesPerScan ?? 16,
      });
      this.progressRevision += Math.max(1, page.workItems);
      this.pendingProfiles.push(...page.profiles);
      if (page.complete && this.pendingProfiles.length === 0) {
        this.profileEnumerationActive = false;
        this.nextProfileEnumerationAt =
          now + (this.options.profileIntervalMs ?? 30 * 1000);
      }
    }
    if (
      !this.profileEnumerationActive &&
      this.pendingProfiles.length === 0
    ) {
      const retry = this.failedProfiles.entries().next().value;
      if (retry !== undefined) {
        const [profileId, profile] = retry;
        this.failedProfiles.delete(profileId);
        this.pendingProfiles.push(profile);
      }
    }
    const selectedProfiles = this.pendingProfiles.slice(
      0,
      // One parsed object can already consume the full 8 MiB / 65,536-token
      // envelope. Processing profiles serially keeps the aggregate fixed.
      Math.min(this.options.maxProfilesPerScan ?? 16, 1),
    );
    if (this.profileEnumerationActive) {
      deferred.add("settings-profile-scope/profiles");
      observedKeysComplete = false;
    }
    // A settings file is parsed into an object, so its automatic parse limit is
    // also capped by the per-scan retained envelope rather than the broader
    // single-resource limit.
    const resourceLimit = Math.min(
      generalResourceLimit(this.maxPayloadBytes),
      GENERAL_MAX_RETAINED_BYTES_PER_SCAN,
    );
    const maxResources =
      this.options.maxResourcesPerScan ?? GENERAL_MAX_RESOURCES_PER_SCAN;
    const retainedLimit =
      this.options.maxRetainedBytesPerScan ??
      GENERAL_MAX_RETAINED_BYTES_PER_SCAN;
    let retainedBytes = 0;
    let materialized = 0;

    for (const profile of selectedProfiles) {
      let profileNeedsRetry = false;
      let info;
      try {
        this.options.onMetadataCheck?.(profile.settings);
        info = await stat(profile.settings);
      } catch (error) {
        if (!(await pathExists(profile.settings))) {
          this.completePendingProfile(profile.profileId);
          continue;
        }
        warnings.push(toErrorMessage(error));
        deferred.add(`settings-profile/${encodeURIComponent(profile.profileId)}`);
        observedKeysComplete = false;
        this.failPendingProfile(profile);
        continue;
      }
      if (info.size > resourceLimit) {
        warnings.push(
          `Settings file ${profile.settings} is ${info.size} bytes, above the ${resourceLimit}-byte automatic-capture work limit.`,
        );
        deferred.add(`settings-profile/${encodeURIComponent(profile.profileId)}`);
        observedKeysComplete = false;
        this.failPendingProfile(profile);
        continue;
      }
      try {
        const settingsRelativePath = normalizeResourcePath(
          relative(this.paths.userDataRoot, profile.settings),
        );
        this.options.onFileRead?.(profile.settings);
        const source = (
          await readFileWithinRoot(
            this.paths.userDataRoot,
            settingsRelativePath,
            resourceLimit,
          )
        ).toString("utf8");
        assertBoundedJsoncStructure(
          source,
          profile.settings,
          MAX_SETTINGS_STRUCTURAL_TOKENS,
        );
        const object = parseJsoncObject(source, profile.settings);
        const nativeIgnored = createIgnoreMatcher(
          readStringArray(object["settingsSync.ignoredSettings"]),
        );
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
          const content = serializeCanonical(value);
          const valueSemanticHash = sha256(content);
          if (
            projectionMatchesSemantic(
              known[resourceId],
              valueSemanticHash,
            )
          ) {
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
              `${info.size}:${info.mtimeMs}:${content.byteLength}`,
              content.byteLength,
              this.maxPayloadBytes,
            );
            const remembered = rememberGeneralOversizedObservation(
              this.oversized,
              observation,
            );
            if (!remembered) {
              this.oversizedOverflow = true;
              observedKeysComplete = false;
              // The adapter kind is now fail-closed. Do not materialize or
              // warn for the unbounded tail; a later full generation rebuilds
              // exact protection if the files become small enough again.
              break;
            }
            warnings.push(generalOversizedWarning("Setting", observation));
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
            kind: "settings",
            content,
            semanticHash: valueSemanticHash,
            metadata: {
              profileId: profile.profileId,
              key,
              lastUpdatedAt: info.mtimeMs,
            },
          });
          retainedBytes += content.byteLength;
          deferred.add(resourceId);
          profileNeedsRetry = true;
          this.oversized.delete(resourceId);
        }
      } catch (error) {
        warnings.push(toErrorMessage(error));
        observedKeysComplete = false;
        deferred.add(`settings-profile/${encodeURIComponent(profile.profileId)}`);
        profileNeedsRetry = true;
        this.failPendingProfile(profile);
      }
      if (!profileNeedsRetry) {
        this.completePendingProfile(profile.profileId);
      }
    }

    for (const profileId of this.failedProfiles.keys()) {
      deferred.add(`settings-profile/${encodeURIComponent(profileId)}`);
    }
    if (this.failedProfileOverflow) {
      deferred.add("settings-profile-scope/untracked-read-failures");
    }
    if (this.oversizedOverflow) {
      deferred.add("settings-profile-scope/untracked-oversized-resources");
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

    this.lastScanStatus = {
      complete: deferred.size === 0,
      deferredResourceIds: [...deferred].sort((left, right) =>
        left.localeCompare(right),
      ),
      progressToken: this.progressRevision,
    };

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

    return {
      snapshots,
      // Per-profile bounded parsing retains no stable all-profile key set.
      // Absence from this page cannot safely originate a destructive delete.
      deletions: [],
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
    const applyLimit = generalResourceLimit(this.maxPayloadBytes);
    let source = "{\n}\n";
    if (await pathExists(target)) {
      source = (
        await readFileWithinRoot(
          this.paths.userDataRoot,
          targetRelativePath,
          applyLimit,
        )
      ).toString("utf8");
    }

    assertBoundedJsoncStructure(
      source,
      target,
      MAX_SETTINGS_STRUCTURAL_TOKENS,
    );
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

    if (
      !isDeletion(input) &&
      input.content.byteLength > applyLimit
    ) {
      throw new Error(
        `Setting exceeds the automatic apply work limit: ${input.resourceId}`,
      );
    }
    const value = isDeletion(input)
      ? undefined
      : parseJsonc(input.content.toString("utf8"), input.resourceId);
    let updated = setJsoncProperty(source, [key], value);
    assertSettingsApplyOutput(updated, target, applyLimit);
    // VS Code tolerates a DUPLICATED top-level key with only an editor
    // squiggle, and jsonc-parser's parse() reads the LAST occurrence while
    // modify() edits the FIRST - so one edit can leave the file re-parsing to
    // the old value, silently reverting the remote change and republishing
    // the reversion. Each extra pass consumes one more occurrence; the loop
    // converges because occurrences are finite, and the bound is a fail-safe.
    for (let pass = 0; pass < 8; pass += 1) {
      const parsed = parseJsoncObject(updated, target);
      const landed = isDeletion(input)
        ? parsed[key] === undefined
        : JSON.stringify(parsed[key]) === JSON.stringify(value);
      if (landed) {
        break;
      }
      // A delete edit removes the first occurrence - for a put that did not
      // land, that first occurrence is the copy just written, so the delete
      // consumes one DUPLICATE per round and the re-put lands one step closer
      // to being the only occurrence.
      updated = setJsoncProperty(updated, [key], undefined);
      if (!isDeletion(input)) {
        updated = setJsoncProperty(updated, [key], value);
      }
      assertSettingsApplyOutput(updated, target, applyLimit);
    }
    parseJsoncObject(updated, target);
    const output = Buffer.from(updated, "utf8");
    if (output.byteLength > applyLimit) {
      throw new Error(
        `Updated settings file ${target} exceeds the ${applyLimit}-byte automatic apply limit.`,
      );
    }
    await writeFileAtomicWithinRoot(
      this.paths.userDataRoot,
      targetRelativePath,
      output,
    );
  }

  private completePendingProfile(profileId: string): void {
    this.failedProfiles.delete(profileId);
    const index = this.pendingProfiles.findIndex(
      (candidate) => candidate.profileId === profileId,
    );
    if (index >= 0) {
      this.pendingProfiles.splice(index, 1);
      this.progressRevision += 1;
      this.lastEmittedPageFingerprint = null;
    }
  }

  private failPendingProfile(profile: ProfileResourcePaths): void {
    const index = this.pendingProfiles.findIndex(
      (candidate) => candidate.profileId === profile.profileId,
    );
    if (index >= 0) {
      this.pendingProfiles.splice(index, 1);
    }
    this.failedProfiles.delete(profile.profileId);
    const maxFailed = Math.max(1, this.options.maxProfilesPerScan ?? 16);
    while (this.failedProfiles.size >= maxFailed) {
      const oldest = this.failedProfiles.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.failedProfiles.delete(oldest);
      this.failedProfileOverflow = true;
    }
    this.failedProfiles.set(profile.profileId, profile);
    this.lastEmittedPageFingerprint = null;
  }
}

function assertSettingsApplyOutput(
  source: string,
  path: string,
  maxBytes: number,
): void {
  if (Buffer.byteLength(source, "utf8") > maxBytes) {
    throw new Error(
      `Updated settings file ${path} exceeds the ${maxBytes}-byte automatic apply limit.`,
    );
  }
  assertBoundedJsoncStructure(source, path, MAX_SETTINGS_STRUCTURAL_TOKENS);
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

function projectionMatchesSemantic(
  projection: LocalProjection | undefined,
  semanticHash: string,
): boolean {
  return (
    projection?.semanticHash === semanticHash ||
    projection?.retainedLocalHash === semanticHash
  );
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
