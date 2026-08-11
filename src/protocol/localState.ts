import { hostname } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { LOCAL_STATE_FILE, LOCAL_STATE_VERSION } from "../constants";
import type { LocalSyncState } from "../types";
import {
  ensureDirectory,
  pathExists,
  writeFileAtomic,
} from "../platform/files";

export interface LocalStateStoreDiagnostics {
  onRead?: (path: string) => void;
  onParse?: (path: string) => void;
  onStringify?: (repositoryId: string) => void;
}

interface StateFileIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  modified: bigint;
  changed: bigint;
}

export class LocalStateStore {
  /**
   * A fixed-size digest of the bytes last written, per repository.
   *
   * `save()` is called several times per cycle from independent places — the
   * own-stream walk, the synthetic projection pass, the end of the cycle — and
   * most calls have nothing new to say. The digest avoids the temp-file write,
   * fsync and rename without retaining another multi-megabyte copy of the
   * state string in every Cursor window.
   */
  private readonly lastWrittenDigest = new Map<string, string>();
  private readonly lastObservedIdentity = new Map<string, StateFileIdentity>();

  constructor(
    readonly storageRoot: string,
    private readonly diagnostics: LocalStateStoreDiagnostics = {},
  ) {}

  async loadOrCreate(repositoryId: string): Promise<LocalSyncState> {
    await ensureDirectory(this.storageRoot);
    const path = this.pathFor(repositoryId);
    if (await pathExists(path)) {
      return this.readStable(repositoryId);
    }

    const state = this.createUnpersisted(repositoryId);
    await this.save(state);
    return state;
  }

  /**
   * Builds a valid in-memory placeholder without claiming a device identity.
   *
   * Deferred repository open always uses this without touching the atomic
   * state file. The caller must replace it with `loadOrCreate()` while holding
   * sync.lock before reading repository state or doing repository work, so
   * concurrent Cursor windows can never persist different identities for the
   * same installation.
   */
  createUnpersisted(repositoryId: string): LocalSyncState {
    return {
      version: LOCAL_STATE_VERSION,
      repositoryId,
      device: {
        deviceId: randomUUID(),
        name: hostname(),
        createdAt: new Date().toISOString(),
      },
      nextSequence: 1,
      lamport: 0,
      ownStreamHead: null,
      streams: {},
      tips: {},
      projections: {},
      conflicts: [],
      pendingDatabaseChanges: [],
      retiredDevices: [],
      lastSyncAt: null,
      lastError: null,
    };
  }

  async load(repositoryId: string): Promise<LocalSyncState> {
    return this.readStable(repositoryId);
  }

  /**
   * Returns the latest state only when the atomic file changed since this
   * store last loaded or wrote it. The common unchanged poll performs one
   * metadata lookup and no file read, JSON parse, or state serialization.
   */
  async loadIfChanged(repositoryId: string): Promise<LocalSyncState | null> {
    const path = this.pathFor(repositoryId);
    const identity = await stateFileIdentity(path);
    if (sameStateFileIdentity(identity, this.lastObservedIdentity.get(repositoryId))) {
      return null;
    }
    return this.readStable(repositoryId, identity);
  }

  async save(state: LocalSyncState): Promise<boolean> {
    this.diagnostics.onStringify?.(state.repositoryId);
    const serialized = JSON.stringify(state);
    const digest = stateDigest(serialized);
    if (this.lastWrittenDigest.get(state.repositoryId) === digest) {
      return false;
    }
    // Reuse the serialization that was just hashed. writeJsonAtomic would
    // stringify this multi-megabyte state a second time before every write.
    await writeFileAtomic(
      this.pathFor(state.repositoryId),
      Buffer.from(`${serialized}\n`, "utf8"),
    );
    this.lastWrittenDigest.set(state.repositoryId, digest);
    this.lastObservedIdentity.set(
      state.repositoryId,
      await stateFileIdentity(this.pathFor(state.repositoryId)),
    );
    return true;
  }

  /** Digest of the exact state bytes most recently loaded or saved here. */
  currentDigest(repositoryId: string): string | undefined {
    return this.lastWrittenDigest.get(repositoryId);
  }

  private pathFor(repositoryId: string): string {
    return join(
      this.storageRoot,
      LOCAL_STATE_FILE.replace(".json", `-${repositoryId}.json`),
    );
  }

  private async readStable(
    repositoryId: string,
    initialIdentity?: StateFileIdentity,
  ): Promise<LocalSyncState> {
    const path = this.pathFor(repositoryId);
    let before = initialIdentity ?? (await stateFileIdentity(path));

    // Atomic writers normally make the first before/after identity match. A
    // single retry closes the small race where an external window renames a
    // new state file while this one is reading the old inode.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.diagnostics.onRead?.(path);
      const bytes = await readFile(path);
      const after = await stateFileIdentity(path);
      if (!sameStateFileIdentity(before, after)) {
        if (attempt === 0) {
          before = after;
          continue;
        }
        throw new Error("Local state changed repeatedly while it was being read.");
      }
      this.diagnostics.onParse?.(path);
      const state = JSON.parse(bytes.toString("utf8")) as LocalSyncState;
      validateState(state, repositoryId);
      this.diagnostics.onStringify?.(repositoryId);
      this.lastWrittenDigest.set(
        repositoryId,
        stateDigest(JSON.stringify(state)),
      );
      this.lastObservedIdentity.set(repositoryId, after);
      return state;
    }

    throw new Error("Local state could not be read consistently.");
  }
}

async function stateFileIdentity(path: string): Promise<StateFileIdentity> {
  const value = await stat(path, { bigint: true });
  return {
    device: value.dev,
    inode: value.ino,
    size: value.size,
    modified: value.mtimeNs,
    changed: value.ctimeNs,
  };
}

function sameStateFileIdentity(
  left: StateFileIdentity | undefined,
  right: StateFileIdentity | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

/** A fixed-size memo instead of retaining a multi-megabyte JSON string. */
function stateDigest(serialized: string): string {
  return createHash("sha256").update(serialized).digest("base64url");
}

function validateState(state: LocalSyncState, repositoryId: string): void {
  if (state.version !== LOCAL_STATE_VERSION) {
    throw new Error(`Unsupported local state version: ${state.version}`);
  }
  if (state.repositoryId !== repositoryId) {
    throw new Error("Local state belongs to a different synchronization repository.");
  }
  if (state.device.deviceId.length === 0) {
    throw new Error("Local device ID is missing.");
  }
  if (state.checkpoint !== undefined) {
    const checkpoint = state.checkpoint;
    if (
      typeof checkpoint.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(checkpoint.hash) ||
      !Number.isSafeInteger(checkpoint.lamport) ||
      checkpoint.lamport < 1 ||
      checkpoint.streams === null ||
      typeof checkpoint.streams !== "object" ||
      Array.isArray(checkpoint.streams)
    ) {
      throw new Error("Local state checkpoint reference is invalid.");
    }
  }
}
