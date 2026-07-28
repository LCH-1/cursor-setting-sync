import { join, relative } from "node:path";
import { readdir } from "node:fs/promises";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeIdentifier,
  assertSafeRelativePathOnDisk,
  normalizeResourcePath,
  pathExists,
} from "../platform/files";

export interface ProfileResourcePaths {
  profileId: string;
  root: string;
  settings: string;
  keybindings: string;
  snippets: string;
  tasks: string;
  prompts: string;
  mcp: string;
}

export async function discoverProfileResourcePaths(
  paths: CursorPaths,
): Promise<ProfileResourcePaths[]> {
  const profiles: ProfileResourcePaths[] = [
    createProfilePaths("default", paths.userDataRoot),
  ];
  if (!(await pathExists(paths.profilesRoot))) {
    return profiles;
  }
  await assertSafeRelativePathOnDisk(
    paths.userDataRoot,
    normalizeResourcePath(relative(paths.userDataRoot, paths.profilesRoot)),
    { finalType: "directory" },
  );
  const entries = await readdir(paths.profilesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      try {
        profiles.push(createProfilePaths(entry.name, join(paths.profilesRoot, entry.name)));
      } catch {
        // One "New folder" or Syncthing conflict directory under User/profiles
        // is not a profile; throwing here disabled the entire settings and
        // profile-files scans, wholesale, on every cycle until it was deleted.
        // Cursor itself would never read such a directory either - skipping it
        // synchronizes exactly what Cursor sees.
      }
    }
  }
  return profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));
}

export function profilePathById(paths: CursorPaths, profileId: string): ProfileResourcePaths {
  assertValidProfileId(profileId);
  return profileId === "default"
    ? createProfilePaths("default", paths.userDataRoot)
    : createProfilePaths(profileId, join(paths.profilesRoot, profileId));
}

export function assertValidProfileId(profileId: string): string {
  return assertSafeIdentifier(profileId, "profile ID");
}

function createProfilePaths(profileId: string, root: string): ProfileResourcePaths {
  assertValidProfileId(profileId);
  return {
    profileId,
    root,
    settings: join(root, "settings.json"),
    keybindings: join(root, "keybindings.json"),
    snippets: join(root, "snippets"),
    tasks: join(root, "tasks.json"),
    prompts: join(root, "prompts"),
    mcp: join(root, "mcp.json"),
  };
}
