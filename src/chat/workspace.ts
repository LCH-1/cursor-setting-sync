import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeIdentifier,
  isCaseInsensitivePathPlatform,
  pathExists,
  readFileWithinRoot,
} from "../platform/files";
import { buffersFitJsonStructureBudget } from "../protocol/jsonStructure";

export interface WorkspaceIdentity {
  id: string;
  uri: string;
  basename: string;
}

interface WorkspaceJson {
  folder?: string;
  workspace?: string;
}

export interface WorkspaceDiscovery {
  workspaces: WorkspaceIdentity[];
  /**
   * Directories whose `workspace.json` was missing, torn, or unparseable at
   * scan time. Unknown is not folderless: a crash while VS Code writes the
   * file leaves it empty, and treating that as "a window with no folder open"
   * silently dropped the workspace's storage from the shutdown backup.
   */
  unreadableIds: string[];
}

interface WorkspaceDiscoveryMemo {
  mtimeMs: number;
  entryCount: number;
  entries: Map<string, WorkspaceIdentity | null>;
  unreadableIds: Set<string>;
  retryCursor: string | null;
  structuralUnreadableIdentities: Map<string, string>;
}

const WORKSPACE_METADATA_MAX_BYTES = 1024 * 1024;
const WORKSPACE_METADATA_RETRIES_PER_SCAN = 16;
export const WORKSPACE_IDENTITY_LOOKUPS_PER_PAGE = 64;
export const HELPER_WORKSPACE_IDENTITY_REFERENCES = 512;
const WORKSPACE_IDENTITY_LOOKUP_MEMO_ENTRIES = 256;
const REMOTE_HOST_DESCRIPTOR_MEMO_ENTRIES = 256;

interface WorkspaceIdentityLookupMemo {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  workspace: WorkspaceIdentity | null;
}

const workspaceIdentityLookupMemo = new Map<
  string,
  WorkspaceIdentityLookupMemo
>();
const remoteHostDescriptorMemo = new Map<string, string | null>();
let workspaceStorageEnumerationObserver: (() => void) | undefined;

/** Narrow instrumentation used only by fixed-work regression tests. */
export const workspaceDiscoveryTesting = {
  setEnumerationObserver(observer: (() => void) | undefined): void {
    workspaceStorageEnumerationObserver = observer;
  },
};

/**
 * Cached per workspaceStorage root.
 *
 * Three callers rediscover this map independently - the chat scan, the
 * workspaceStorage scan and the workspace-mapping prompt - and every one of
 * them used to stat and read a `workspace.json` through the hardened path
 * walker for each of what can be hundreds of never-garbage-collected
 * workspaceStorage directories, on every 30-second poll. The set can only
 * change when a directory is added or removed, which is exactly what the root
 * directory's own mtime records; the entry count is compared as well so a
 * filesystem with coarse timestamps still notices.
 */
const discoveryMemo = new Map<string, WorkspaceDiscoveryMemo>();

/** Drops the memo; exported for tests that rewrite a workspaceStorage tree. */
export function resetWorkspaceDiscoveryCache(): void {
  discoveryMemo.clear();
  workspaceIdentityLookupMemo.clear();
  remoteHostDescriptorMemo.clear();
  workspaceStorageEnumerationObserver = undefined;
}

/**
 * Resolves only workspace IDs referenced by the caller's current bounded page.
 * It never enumerates `workspaceStorage`, returns at most 64 identities, and
 * keeps a small LRU of metadata rather than the complete workspace population.
 */
export async function lookupWorkspaceIdentitiesById(
  paths: CursorPaths,
  workspaceIds: Iterable<string>,
  options: {
    maxLookups?: number;
    onMetadataRead?: (workspaceId: string) => void;
  } = {},
): Promise<Map<string, WorkspaceIdentity>> {
  const maxLookups =
    options.maxLookups ?? WORKSPACE_IDENTITY_LOOKUPS_PER_PAGE;
  if (!Number.isSafeInteger(maxLookups) || maxLookups <= 0) {
    throw new Error("Workspace identity lookup limit must be positive.");
  }
  const result = new Map<string, WorkspaceIdentity>();
  const seen = new Set<string>();
  for (const workspaceId of workspaceIds) {
    if (seen.has(workspaceId)) {
      continue;
    }
    if (seen.size >= maxLookups) {
      break;
    }
    seen.add(workspaceId);
    try {
      assertSafeIdentifier(workspaceId, "workspace ID");
      const metadataPath = join(
        paths.workspaceStorageRoot,
        workspaceId,
        "workspace.json",
      );
      const info = await stat(metadataPath);
      if (!info.isFile() || info.size > WORKSPACE_METADATA_MAX_BYTES) {
        continue;
      }
      const memoKey = `${paths.workspaceStorageRoot}\0${workspaceId}`;
      const cached = workspaceIdentityLookupMemo.get(memoKey);
      if (
        cached !== undefined &&
        cached.size === info.size &&
        cached.mtimeMs === info.mtimeMs &&
        cached.ctimeMs === info.ctimeMs
      ) {
        workspaceIdentityLookupMemo.delete(memoKey);
        workspaceIdentityLookupMemo.set(memoKey, cached);
        if (cached.workspace !== null) {
          result.set(workspaceId, cached.workspace);
        }
        continue;
      }
      options.onMetadataRead?.(workspaceId);
      const metadataBytes = await readFileWithinRoot(
        paths.workspaceStorageRoot,
        `${workspaceId}/workspace.json`,
        WORKSPACE_METADATA_MAX_BYTES,
      );
      if (!buffersFitJsonStructureBudget([metadataBytes])) {
        rememberWorkspaceIdentityLookup(memoKey, {
          size: info.size,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          workspace: null,
        });
        continue;
      }
      const metadata = JSON.parse(metadataBytes.toString("utf8")) as WorkspaceJson;
      const uri = metadata.folder ?? metadata.workspace;
      const workspace =
        typeof uri === "string" && uri.length > 0
          ? { id: workspaceId, uri, basename: workspaceBasename(uri) }
          : null;
      rememberWorkspaceIdentityLookup(memoKey, {
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        workspace,
      });
      if (workspace !== null) {
        result.set(workspaceId, workspace);
      }
    } catch {
      // URI metadata is optional display/mapping context. Invalid, absent or
      // transiently torn metadata safely resolves to null for this page.
    }
  }
  return result;
}

/**
 * Resolves the fixed set referenced by one authenticated helper page. The
 * helper page itself is capped at 256 changes; the second half of this bound
 * leaves room for explicit mapping targets without ever enumerating the
 * potentially unbounded workspaceStorage directory.
 */
export async function lookupWorkspaceIdentityReferences(
  paths: CursorPaths,
  workspaceIds: Iterable<string>,
  workspaceMappings: Readonly<Record<string, string>> = {},
  options: {
    maxReferences?: number;
    onMetadataRead?: (workspaceId: string) => void;
  } = {},
): Promise<WorkspaceIdentity[]> {
  const maxReferences =
    options.maxReferences ?? HELPER_WORKSPACE_IDENTITY_REFERENCES;
  if (
    !Number.isSafeInteger(maxReferences) ||
    maxReferences <= 0 ||
    maxReferences > HELPER_WORKSPACE_IDENTITY_REFERENCES
  ) {
    throw new Error(
      `Helper workspace identity reference limit must be between 1 and ${HELPER_WORKSPACE_IDENTITY_REFERENCES}.`,
    );
  }
  const references = new Set<string>();
  const add = (workspaceId: string): void => {
    if (references.has(workspaceId)) {
      return;
    }
    if (references.size >= maxReferences) {
      throw new Error(
        `Helper workspace identity page exceeds ${maxReferences} references.`,
      );
    }
    references.add(workspaceId);
  };
  for (const workspaceId of workspaceIds) {
    add(workspaceId);
  }
  // A legacy chat event may carry its workspace ID only inside the payload.
  // Looking up the bounded explicit targets preserves those mappings without
  // parsing a second full chat graph during preflight.
  // Set iteration visits appended values, so this follows only the direct
  // mapping chain connected to a referenced source. Unrelated configuration
  // entries are neither cloned nor counted against the page.
  for (const source of references) {
    const target = workspaceMappings[source];
    if (Object.hasOwn(workspaceMappings, source) && typeof target === "string") {
      add(target);
    }
  }

  const resolved = new Map<string, WorkspaceIdentity>();
  let page: string[] = [];
  const flush = async (): Promise<void> => {
    if (page.length === 0) {
      return;
    }
    const identities = await lookupWorkspaceIdentitiesById(paths, page, {
      maxLookups: WORKSPACE_IDENTITY_LOOKUPS_PER_PAGE,
      ...(options.onMetadataRead === undefined
        ? {}
        : { onMetadataRead: options.onMetadataRead }),
    });
    for (const [workspaceId, identity] of identities) {
      resolved.set(workspaceId, identity);
    }
    page = [];
  };
  for (const workspaceId of references) {
    page.push(workspaceId);
    if (page.length >= WORKSPACE_IDENTITY_LOOKUPS_PER_PAGE) {
      await flush();
    }
  }
  await flush();
  return [...resolved.values()];
}

/** Returns only mapping edges reachable from this bounded source page. */
export function selectWorkspaceMappingsForReferences(
  workspaceIds: Iterable<string>,
  workspaceMappings: Readonly<Record<string, string>>,
  maxReferences = HELPER_WORKSPACE_IDENTITY_REFERENCES,
): Record<string, string> {
  if (
    !Number.isSafeInteger(maxReferences) ||
    maxReferences <= 0 ||
    maxReferences > HELPER_WORKSPACE_IDENTITY_REFERENCES
  ) {
    throw new Error(
      `Helper workspace mapping reference limit must be between 1 and ${HELPER_WORKSPACE_IDENTITY_REFERENCES}.`,
    );
  }
  const references = new Set<string>();
  for (const workspaceId of workspaceIds) {
    if (!references.has(workspaceId) && references.size >= maxReferences) {
      throw new Error(
        `Helper workspace mapping page exceeds ${maxReferences} references.`,
      );
    }
    references.add(workspaceId);
  }
  const selected = Object.create(null) as Record<string, string>;
  for (const source of references) {
    const target = workspaceMappings[source];
    if (!Object.hasOwn(workspaceMappings, source) || typeof target !== "string") {
      continue;
    }
    if (!references.has(target) && references.size >= maxReferences) {
      throw new Error(
        `Helper workspace mapping page exceeds ${maxReferences} references.`,
      );
    }
    references.add(target);
    selected[source] = target;
  }
  return selected;
}

function rememberWorkspaceIdentityLookup(
  key: string,
  value: WorkspaceIdentityLookupMemo,
): void {
  workspaceIdentityLookupMemo.delete(key);
  while (
    workspaceIdentityLookupMemo.size >=
    WORKSPACE_IDENTITY_LOOKUP_MEMO_ENTRIES
  ) {
    const oldest = workspaceIdentityLookupMemo.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    workspaceIdentityLookupMemo.delete(oldest);
  }
  workspaceIdentityLookupMemo.set(key, value);
}

export async function discoverWorkspaces(
  paths: CursorPaths,
): Promise<WorkspaceIdentity[]> {
  return (await discoverWorkspacesDetailed(paths)).workspaces;
}

export async function discoverWorkspacesDetailed(
  paths: CursorPaths,
): Promise<WorkspaceDiscovery> {
  if (!(await pathExists(paths.workspaceStorageRoot))) {
    discoveryMemo.delete(paths.workspaceStorageRoot);
    return { workspaces: [], unreadableIds: [] };
  }
  workspaceStorageEnumerationObserver?.();
  const entries = await readdir(paths.workspaceStorageRoot, { withFileTypes: true });
  let rootMtimeMs: number | null = null;
  try {
    rootMtimeMs = (await stat(paths.workspaceStorageRoot)).mtimeMs;
  } catch {
    // Without a root timestamp the discovery simply runs in full.
  }
  const memo = discoveryMemo.get(paths.workspaceStorageRoot);
  const directoryIds = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const currentIds = new Set(directoryIds);
  const state: WorkspaceDiscoveryMemo = memo ?? {
    mtimeMs: rootMtimeMs ?? -1,
    entryCount: entries.length,
    entries: new Map(),
    unreadableIds: new Set(),
    retryCursor: null,
    structuralUnreadableIdentities: new Map(),
  };
  state.structuralUnreadableIdentities ??= new Map();
  for (const cachedId of [...state.entries.keys()]) {
    if (!currentIds.has(cachedId)) {
      state.entries.delete(cachedId);
      state.unreadableIds.delete(cachedId);
      state.structuralUnreadableIdentities.delete(cachedId);
    }
  }
  for (const id of directoryIds) {
    if (!state.entries.has(id)) {
      state.unreadableIds.add(id);
    }
  }
  const retryIds = rotateWorkspaceIds(
    [...state.unreadableIds].filter((id) => currentIds.has(id)).sort(),
    state.retryCursor,
  ).slice(0, WORKSPACE_METADATA_RETRIES_PER_SCAN);
  for (const id of retryIds) {
    state.retryCursor = id;
    try {
      const metadataPath = join(
        paths.workspaceStorageRoot,
        id,
        "workspace.json",
      );
      const metadataInfo = await stat(metadataPath);
      if (metadataInfo.size > WORKSPACE_METADATA_MAX_BYTES) {
        throw new Error("workspace metadata exceeds its read limit");
      }
      const metadataIdentity = `${metadataInfo.size}:${metadataInfo.mtimeMs}:${metadataInfo.ctimeMs}`;
      if (
        state.structuralUnreadableIdentities.get(id) === metadataIdentity
      ) {
        state.unreadableIds.add(id);
        continue;
      }
      state.structuralUnreadableIdentities.delete(id);
      const metadataBytes = await readFileWithinRoot(
        paths.workspaceStorageRoot,
        `${id}/workspace.json`,
        WORKSPACE_METADATA_MAX_BYTES,
      );
      if (!buffersFitJsonStructureBudget([metadataBytes])) {
        state.structuralUnreadableIdentities.set(id, metadataIdentity);
        throw new Error("workspace metadata exceeds its structural JSON limit");
      }
      const metadata = JSON.parse(metadataBytes.toString("utf8")) as WorkspaceJson;
      const uri = metadata.folder ?? metadata.workspace;
      state.entries.set(
        id,
        typeof uri === "string" && uri.length > 0
          ? { id, uri, basename: workspaceBasename(uri) }
          : null,
      );
      state.unreadableIds.delete(id);
      state.structuralUnreadableIdentities.delete(id);
    } catch {
      // Preserve a previous healthy identity if a later refresh is transient;
      // callers also receive the ID as unknown and therefore fail closed.
      state.unreadableIds.add(id);
    }
  }
  state.mtimeMs = rootMtimeMs ?? state.mtimeMs;
  state.entryCount = entries.length;
  if (state.unreadableIds.size === 0) {
    state.retryCursor = null;
  }
  discoveryMemo.set(paths.workspaceStorageRoot, state);
  const sorted = [...state.entries.values()]
    .filter((workspace): workspace is WorkspaceIdentity => workspace !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    workspaces: [...sorted],
    unreadableIds: [...state.unreadableIds].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

function rotateWorkspaceIds(values: string[], cursor: string | null): string[] {
  if (cursor === null || values.length < 2) {
    return values;
  }
  const index = values.indexOf(cursor);
  if (index < 0 || index + 1 >= values.length) {
    return values;
  }
  return [...values.slice(index + 1), ...values.slice(0, index + 1)];
}

export function resolveTargetWorkspace(
  sourceWorkspaceId: string,
  sourceWorkspaceUri: string | null,
  localWorkspaces: WorkspaceIdentity[],
  explicitMappings: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (localWorkspaces.some((workspace) => workspace.id === sourceWorkspaceId)) {
    return sourceWorkspaceId;
  }
  const explicit = Object.hasOwn(explicitMappings, sourceWorkspaceId)
    ? explicitMappings[sourceWorkspaceId]
    : undefined;
  if (
    typeof explicit === "string" &&
    localWorkspaces.some((workspace) => workspace.id === explicit)
  ) {
    return explicit;
  }
  if (sourceWorkspaceUri === null) {
    return null;
  }
  const normalizedSource = normalizeWorkspaceUri(sourceWorkspaceUri, platform);
  const exact = localWorkspaces.find(
    (workspace) =>
      normalizeWorkspaceUri(workspace.uri, platform) === normalizedSource,
  );
  if (exact !== undefined) {
    return exact.id;
  }
  // Basenames are display labels, not identities. Two unrelated projects can
  // both be named "app"; only an exact URI or explicit user mapping is safe.
  return null;
}

export function normalizeWorkspaceUri(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const decoded = normalizeRemoteHost(decodeWorkspaceUri(uri));
  const separated = platform === "win32" ? decoded.replaceAll("\\", "/") : decoded;
  const trimmed = separated.replace(/\/+$/, "");
  return isCaseInsensitivePathPlatform(platform)
    ? trimmed.toLocaleLowerCase("en-US")
    : trimmed;
}

/** Exact normalized membership check used before opening recovery context. */
export function workspaceUriMatchesAny(
  expected: string,
  candidates: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedExpected = normalizeWorkspaceUri(expected, platform);
  return candidates.some(
    (candidate) => normalizeWorkspaceUri(candidate, platform) === normalizedExpected,
  );
}

/**
 * Collapses the two spellings Cursor uses for one SSH host.
 *
 * The same server is recorded either as the plain alias from the SSH config -
 * `ssh-remote+geekdive_local2` - or as a hex-encoded JSON descriptor,
 * `ssh-remote+7b22686f73744e616d65223a226765656b646976655f6c6f63616c32227d`,
 * which is `{"hostName":"geekdive_local2"}`. Which one appears depends on how
 * the connection was opened, and both forms occur on a single machine: one
 * user's `workspaceStorage` held 36 workspaces under the alias and 15 more
 * under the descriptor for that same server.
 *
 * VS Code hashes the URI into the workspaceStorage directory name, so the same
 * folder on the same server becomes two unrelated workspaces - which is why an
 * incoming remote workspace matched nothing locally and every chat written
 * there stopped at a mapping prompt the user had no way to answer.
 */
function normalizeRemoteHost(uri: string): string {
  return uri.replace(
    /^(vscode-remote:\/\/ssh-remote\+)([0-9a-fA-F]+)(?=\/|$)/,
    (whole, prefix: string, encoded: string) => {
      const hostName = remoteHostFromDescriptor(encoded);
      return hostName === null ? whole : `${prefix}${hostName}`;
    },
  );
}

/**
 * The `hostName` inside a hex-encoded connection descriptor, or null for
 * anything else - including an alias that happens to be all hex characters,
 * which only a successful parse can distinguish from a real descriptor.
 */
function remoteHostFromDescriptor(encoded: string): string | null {
  if (encoded.length < 2 || encoded.length % 2 !== 0) {
    return null;
  }
  const bytes = Buffer.from(encoded, "hex");
  if (bytes.length * 2 !== encoded.length) {
    return null;
  }
  const memoKey = createHash("sha256").update(encoded).digest("hex");
  const cached = remoteHostDescriptorMemo.get(memoKey);
  if (cached !== undefined || remoteHostDescriptorMemo.has(memoKey)) {
    remoteHostDescriptorMemo.delete(memoKey);
    remoteHostDescriptorMemo.set(memoKey, cached ?? null);
    return cached ?? null;
  }
  if (!buffersFitJsonStructureBudget([bytes])) {
    rememberRemoteHostDescriptor(memoKey, null);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    rememberRemoteHostDescriptor(memoKey, null);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    rememberRemoteHostDescriptor(memoKey, null);
    return null;
  }
  const hostName = (parsed as { hostName?: unknown }).hostName;
  const result =
    typeof hostName === "string" && hostName.length > 0 ? hostName : null;
  rememberRemoteHostDescriptor(memoKey, result);
  return result;
}

function rememberRemoteHostDescriptor(key: string, hostName: string | null): void {
  remoteHostDescriptorMemo.delete(key);
  while (remoteHostDescriptorMemo.size >= REMOTE_HOST_DESCRIPTOR_MEMO_ENTRIES) {
    const oldest = remoteHostDescriptorMemo.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    remoteHostDescriptorMemo.delete(oldest);
  }
  remoteHostDescriptorMemo.set(key, hostName);
}

function workspaceBasename(uri: string): string {
  const normalized = decodeWorkspaceUri(uri)
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  return basename(normalized);
}

function decodeWorkspaceUri(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}
