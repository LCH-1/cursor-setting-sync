import { join, relative } from "node:path";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeIdentifier,
  assertSafeRelativePathOnDisk,
  normalizeResourcePath,
  pathExists,
} from "../platform/files";
import {
  AUXILIARY_DIRECTORY_MATCHES_PER_SCAN,
  AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN,
  BoundedFileTreeWalker,
} from "../chat/boundedFileTree";

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

export interface ProfileResourcePathPage {
  profiles: ProfileResourcePaths[];
  complete: boolean;
  workItems: number;
  retainedPathCount: number;
}

/**
 * Stateful, fixed-memory enumeration of the default profile and top-level
 * `User/profiles/*` directories. Call `restart()` only after a completed
 * sweep; callers retain at most the returned page, never the whole profile
 * population.
 */
export class ProfileResourcePathPager {
  private readonly walker = new BoundedFileTreeWalker();
  private started = false;
  private defaultPending = true;
  private completed = false;

  restart(): void {
    this.started = true;
    this.defaultPending = true;
    this.completed = false;
  }

  get active(): boolean {
    return this.started && !this.completed;
  }

  /** Closes the resumable native profile-directory cursor, if one is open. */
  async dispose(): Promise<void> {
    await this.walker.clear();
    this.started = false;
    this.defaultPending = true;
    this.completed = false;
  }

  async advance(
    paths: CursorPaths,
    options: {
      maxProfiles?: number;
      maxWorkItems?: number;
    } = {},
  ): Promise<ProfileResourcePathPage> {
    if (!this.started) {
      this.restart();
    }
    if (this.completed) {
      return {
        profiles: [],
        complete: true,
        workItems: 0,
        retainedPathCount: 0,
      };
    }
    const maxProfiles =
      options.maxProfiles ?? AUXILIARY_DIRECTORY_MATCHES_PER_SCAN;
    const maxWorkItems =
      options.maxWorkItems ?? AUXILIARY_DIRECTORY_WORK_ITEMS_PER_SCAN;
    assertPositiveLimit(maxProfiles, "Profile page");
    assertPositiveLimit(maxWorkItems, "Profile enumeration work");
    const profiles: ProfileResourcePaths[] = [];
    if (this.defaultPending) {
      profiles.push(createProfilePaths("default", paths.userDataRoot));
      this.defaultPending = false;
      if (profiles.length >= maxProfiles) {
        return {
          profiles,
          complete: false,
          workItems: 0,
          retainedPathCount: this.walker.retainedPathCount(paths.profilesRoot),
        };
      }
    }
    if (!(await pathExists(paths.profilesRoot))) {
      this.completed = true;
      return {
        profiles,
        complete: true,
        workItems: 1,
        retainedPathCount: 0,
      };
    }
    await assertSafeRelativePathOnDisk(
      paths.userDataRoot,
      normalizeResourcePath(relative(paths.userDataRoot, paths.profilesRoot)),
      { finalType: "directory" },
    );
    const page = await this.walker.advance(paths.profilesRoot, {
      maxWorkItems,
      maxMatches: 1,
      maxDirectoryMatches: maxProfiles - profiles.length,
      includeFile: () => false,
      includeDirectory: (_path, relativePath) => {
        if (relativePath.includes("/") || relativePath.includes("\\")) {
          return false;
        }
        try {
          assertValidProfileId(relativePath);
          return true;
        } catch {
          // Cursor ignores conflict/temporary directory names as profiles.
          return false;
        }
      },
      descendIntoDirectory: () => false,
    });
    for (const directory of page.directories) {
      const profileId = normalizeResourcePath(
        relative(paths.profilesRoot, directory),
      );
      profiles.push(createProfilePaths(profileId, directory));
    }
    if (page.complete) {
      this.completed = true;
    }
    return {
      profiles,
      complete: page.complete,
      workItems: page.workItems,
      retainedPathCount: page.retainedPathCount,
    };
  }
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

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} limit must be a positive integer.`);
  }
}
