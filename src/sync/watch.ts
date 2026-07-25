import {
  CHECKPOINT_EXTENSION,
  EVENT_EXTENSION,
  OBJECT_EXTENSION,
} from "../constants";

/**
 * Checkpoints are watched too. The watcher already subscribes to
 * `checkpoints/`, but the filter used to drop every `.csc` notification, so a
 * peer's new checkpoint - and the event deletions that follow it - were only
 * noticed on the next poll, with every listing in between relying on the
 * tolerate-pruned-event path instead of simply absorbing the checkpoint.
 */
export function isRepositoryPayloadFile(fileName: string): boolean {
  const normalized = fileName.replaceAll("\\", "/").toLowerCase();
  return (
    !normalized.includes("sync-conflict") &&
    (normalized.endsWith(EVENT_EXTENSION) ||
      normalized.endsWith(OBJECT_EXTENSION) ||
      normalized.endsWith(CHECKPOINT_EXTENSION))
  );
}

/** The basename of a watcher notification, on either path separator. */
export function repositoryPayloadFileName(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
