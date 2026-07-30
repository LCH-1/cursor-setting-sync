import type { MergeOutcome } from "../types";

/**
 * The Remote Explorer's memory of which folders you have opened on each SSH
 * host — the tree under "SSH TARGETS", one entry per host with the paths
 * beneath it.
 *
 * Cursor keeps this in the global `state.vscdb` ItemTable, registered as
 * MACHINE-target. That is why it never travelled: the ui-state adapter only
 * ever read USER-target keys, so these were outside the synchronized set from
 * the beginning rather than something a later exclusion removed. VS Code's own
 * Settings Sync leaves them behind for the same reason.
 *
 * Machine-target is the right call for a *path on this computer* and the wrong
 * one here: a remote path is the same string on every computer that reaches the
 * same server, which is exactly the setup this list is for. Two machines that
 * SSH to one host should not have to rediscover its folders separately.
 *
 * Only the host→folder history is carried. Nothing here reads or writes
 * `~/.ssh/config`: the hosts themselves, their addresses, users and key files
 * stay entirely on each computer.
 */

/**
 * Keys carried, and the field inside each that holds the host map.
 *
 * An allowlist rather than a pattern, for the same reason the workspace
 * ItemTable is one: everything else in this table is either genuinely local or
 * something no one has looked at yet, and a pattern would sweep both in.
 */
const REMOTE_TARGET_KEYS: ReadonlyMap<string, string> = new Map([
  // Cursor's own Remote-SSH fork; this is what fills the tree in Cursor.
  ["anysphere.remote-ssh", "remoteLocationHistory_v0"],
  // The upstream extension, present when it is installed alongside.
  ["ms-vscode-remote.remote-ssh", "folder.history.v1"],
]);

/** The most hosts, and folders per host, this build will carry. */
const MAX_HOSTS = 500;
const MAX_FOLDERS_PER_HOST = 200;

export function isRemoteTargetsKey(key: string): boolean {
  return REMOTE_TARGET_KEYS.has(key);
}

export function remoteTargetsKeys(): string[] {
  return [...REMOTE_TARGET_KEYS.keys()];
}

/**
 * Combines two hosts→folders maps, keeping everything either computer knows.
 *
 * There is nothing to elect between: a folder one machine has opened and the
 * other has not is a fact about the server, not a disagreement. So hosts union
 * by name and folders union within a host, and neither side loses an entry.
 *
 * Order carries meaning — the list is most-recently-opened first, which is what
 * the tree shows — so `preferred`'s order leads and anything only `other` knows
 * follows in its own order. Both computers run this on the same pair with the
 * same preferred side, so both reach the same bytes.
 */
export function mergeRemoteTargetsBuffers(
  preferred: Buffer,
  other: Buffer,
): MergeOutcome {
  const preferredValue = parse(preferred);
  const otherValue = parse(other);
  if (preferredValue === null || otherValue === null) {
    return { status: "conflict" };
  }
  if (preferredValue.field !== otherValue.field) {
    // Two different shapes under one key: not something to guess at.
    return { status: "conflict" };
  }

  const merged: Record<string, string[]> = {};
  const hosts: string[] = [];
  for (const host of [
    ...Object.keys(preferredValue.hosts),
    ...Object.keys(otherValue.hosts),
  ]) {
    if (!Object.hasOwn(merged, host)) {
      merged[host] = [];
      hosts.push(host);
    }
  }
  if (hosts.length > MAX_HOSTS) {
    return { status: "conflict" };
  }
  for (const host of hosts) {
    const seen = new Set<string>();
    const folders: string[] = [];
    for (const folder of [
      ...(preferredValue.hosts[host] ?? []),
      ...(otherValue.hosts[host] ?? []),
    ]) {
      if (seen.has(folder)) {
        continue;
      }
      seen.add(folder);
      folders.push(folder);
      if (folders.length >= MAX_FOLDERS_PER_HOST) {
        break;
      }
    }
    merged[host] = folders;
  }

  const content = Buffer.from(
    JSON.stringify({ [preferredValue.field]: merged }),
    "utf8",
  );
  return { status: "merged", content };
}

interface ParsedRemoteTargets {
  field: string;
  hosts: Record<string, string[]>;
}

/**
 * Returns null — never throws — for anything that is not the shape this build
 * knows. The conflict then stays for a person rather than being replaced by a
 * guess at a structure a future Cursor invented.
 */
function parse(content: Buffer): ParsedRemoteTargets | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  // Every known payload is a single wrapper field holding the host map.
  if (entries.length !== 1) {
    return null;
  }
  const [field, value] = entries[0] as [string, unknown];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const hosts = Object.create(null) as Record<string, string[]>;
  for (const [host, folders] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(folders)) {
      return null;
    }
    const list: string[] = [];
    for (const folder of folders) {
      if (typeof folder !== "string") {
        return null;
      }
      list.push(folder);
    }
    hosts[host] = list;
  }
  return { field, hosts };
}
