import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface RepositoryWatcher {
  close(): void;
}

/**
 * fs.watch supports {recursive: true} only on win32 and darwin. On linux the
 * repository's fixed layout is watched level by level instead: the root,
 * checkpoints/, devices/, each devices/<id>/, and each devices/<id>/events/
 * directory, re-deriving the set whenever a directory that can gain
 * subdirectories reports an event.
 */
export function createRepositoryWatcher(
  root: string,
  platform: NodeJS.Platform,
  onFile: (fileName: string) => void,
  onError: (message: string) => void,
): RepositoryWatcher {
  if (platform === "linux") {
    return new DirectoryListWatcher(root, onFile, onError);
  }
  const watcher = watch(root, { recursive: true }, (_eventType, fileName) => {
    if (fileName !== null) {
      onFile(String(fileName));
    }
  });
  watcher.on("error", (error) => {
    onError(error.message);
  });
  return {
    close: () => {
      watcher.close();
    },
  };
}

interface WatchTarget {
  path: string;
  /** True for directories whose events can mean a new watchable directory. */
  trackSubdirectories: boolean;
}

class DirectoryListWatcher implements RepositoryWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;
  private refreshing = false;
  private refreshQueued = false;

  constructor(
    private readonly root: string,
    private readonly onFile: (fileName: string) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.scheduleRefresh();
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  private scheduleRefresh(): void {
    if (this.closed) {
      return;
    }
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    void this.refresh()
      .catch((error: unknown) => {
        this.onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.refreshing = false;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          this.scheduleRefresh();
        }
      });
  }

  private async refresh(): Promise<void> {
    const targets = await this.watchTargets();
    if (this.closed) {
      return;
    }
    const expected = new Set(targets.map((target) => target.path));
    for (const [directory, watcher] of this.watchers) {
      if (!expected.has(directory)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    }
    for (const target of targets) {
      if (!this.watchers.has(target.path)) {
        this.addWatcher(target);
      }
    }
  }

  private async watchTargets(): Promise<WatchTarget[]> {
    const devicesRoot = join(this.root, "devices");
    const targets: WatchTarget[] = [
      { path: this.root, trackSubdirectories: true },
      { path: join(this.root, "checkpoints"), trackSubdirectories: false },
      { path: devicesRoot, trackSubdirectories: true },
    ];
    const deviceIds = await subdirectoriesOf(devicesRoot);
    for (const deviceId of deviceIds) {
      const deviceRoot = join(devicesRoot, deviceId);
      const shardRoot = join(deviceRoot, "blobs", "sha256");
      targets.push(
        { path: deviceRoot, trackSubdirectories: true },
        { path: join(deviceRoot, "events"), trackSubdirectories: false },
        { path: join(deviceRoot, "blobs"), trackSubdirectories: true },
        { path: shardRoot, trackSubdirectories: true },
      );
      // Objects land in two-character shard directories; without watching them
      // a remote payload only surfaces on the next poll.
      for (const shard of await subdirectoriesOf(shardRoot)) {
        targets.push({
          path: join(shardRoot, shard),
          trackSubdirectories: false,
        });
      }
    }
    return targets;
  }

  private addWatcher(target: WatchTarget): void {
    let watcher: FSWatcher;
    try {
      watcher = watch(target.path, (_eventType, fileName) => {
        if (fileName !== null) {
          this.onFile(String(fileName));
        }
        if (target.trackSubdirectories) {
          this.scheduleRefresh();
        }
      });
    } catch {
      // The directory vanished between listing and watching; a later refresh
      // re-adds it once its parent reports the re-creation.
      return;
    }
    watcher.on("error", (error) => {
      this.watchers.get(target.path)?.close();
      this.watchers.delete(target.path);
      this.onError(error.message);
      // Without a refresh a transient watch error would leave the directory
      // unwatched until an unrelated parent event happens to fire.
      this.scheduleRefresh();
    });
    this.watchers.set(target.path, watcher);
  }
}

async function subdirectoriesOf(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // The directory does not exist yet; its parent reports the creation.
    return [];
  }
}
