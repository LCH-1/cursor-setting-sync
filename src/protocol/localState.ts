import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LOCAL_STATE_FILE, LOCAL_STATE_VERSION } from "../constants";
import type { LocalSyncState } from "../types";
import { ensureDirectory, pathExists, readJsonFile, writeJsonAtomic } from "../platform/files";

export class LocalStateStore {
  /**
   * The bytes last written, per repository. `save()` is called several times
   * per cycle from independent places — the own-stream walk, the synthetic
   * projection pass, the end of the cycle — and most of those calls have
   * nothing new to say. Comparing first turns each of them into a string
   * compare instead of a multi-megabyte serialize, temp-file write, fsync,
   * rename and directory fsync.
   */
  private readonly lastWritten = new Map<string, string>();

  constructor(readonly storageRoot: string) {}

  async loadOrCreate(repositoryId: string): Promise<LocalSyncState> {
    await ensureDirectory(this.storageRoot);
    const path = this.pathFor(repositoryId);
    if (await pathExists(path)) {
      const state = await readJsonFile<LocalSyncState>(path);
      validateState(state, repositoryId);
      this.lastWritten.set(repositoryId, JSON.stringify(state));
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
    this.lastWritten.set(repositoryId, JSON.stringify(state));
    return state;
  }

  async save(state: LocalSyncState): Promise<void> {
    const serialized = JSON.stringify(state);
    if (this.lastWritten.get(state.repositoryId) === serialized) {
      return;
    }
    await writeJsonAtomic(this.pathFor(state.repositoryId), state, false);
    this.lastWritten.set(state.repositoryId, serialized);
  }

  private pathFor(repositoryId: string): string {
    return join(
      this.storageRoot,
      LOCAL_STATE_FILE.replace(".json", `-${repositoryId}.json`),
    );
  }
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
