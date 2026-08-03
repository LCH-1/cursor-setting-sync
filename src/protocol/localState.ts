import { hostname } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LOCAL_STATE_FILE, LOCAL_STATE_VERSION } from "../constants";
import type { LocalSyncState } from "../types";
import {
  ensureDirectory,
  pathExists,
  readJsonFile,
  writeFileAtomic,
} from "../platform/files";

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

  constructor(readonly storageRoot: string) {}

  async loadOrCreate(repositoryId: string): Promise<LocalSyncState> {
    await ensureDirectory(this.storageRoot);
    const path = this.pathFor(repositoryId);
    if (await pathExists(path)) {
      const state = await readJsonFile<LocalSyncState>(path);
      validateState(state, repositoryId);
      this.lastWrittenDigest.set(
        repositoryId,
        stateDigest(JSON.stringify(state)),
      );
      return state;
    }

    const state: LocalSyncState = {
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
    await this.save(state);
    return state;
  }

  async load(repositoryId: string): Promise<LocalSyncState> {
    const state = await readJsonFile<LocalSyncState>(this.pathFor(repositoryId));
    validateState(state, repositoryId);
    // Keeps the write memo aligned with what is actually on disk, so a file
    // another process rewrote is never mistaken for one this store wrote.
    this.lastWrittenDigest.set(
      repositoryId,
      stateDigest(JSON.stringify(state)),
    );
    return state;
  }

  async save(state: LocalSyncState): Promise<void> {
    const serialized = JSON.stringify(state);
    const digest = stateDigest(serialized);
    if (this.lastWrittenDigest.get(state.repositoryId) === digest) {
      return;
    }
    // Reuse the serialization that was just hashed. writeJsonAtomic would
    // stringify this multi-megabyte state a second time before every write.
    await writeFileAtomic(
      this.pathFor(state.repositoryId),
      Buffer.from(`${serialized}\n`, "utf8"),
    );
    this.lastWrittenDigest.set(state.repositoryId, digest);
  }

  private pathFor(repositoryId: string): string {
    return join(
      this.storageRoot,
      LOCAL_STATE_FILE.replace(".json", `-${repositoryId}.json`),
    );
  }
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
