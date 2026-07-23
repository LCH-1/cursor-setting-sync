import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LOCAL_STATE_FILE, LOCAL_STATE_VERSION } from "../constants";
import type { LocalSyncState } from "../types";
import { ensureDirectory, pathExists, readJsonFile, writeJsonAtomic } from "../platform/files";

export class LocalStateStore {
  constructor(readonly storageRoot: string) {}

  async loadOrCreate(repositoryId: string): Promise<LocalSyncState> {
    await ensureDirectory(this.storageRoot);
    const path = this.pathFor(repositoryId);
    if (await pathExists(path)) {
      const state = await readJsonFile<LocalSyncState>(path);
      validateState(state, repositoryId);
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
    return state;
  }

  async save(state: LocalSyncState): Promise<void> {
    await writeJsonAtomic(this.pathFor(state.repositoryId), state);
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
