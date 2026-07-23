import { basename, relative } from "node:path";
import type {
  JsonValue,
  LocalProjection,
  ResourceDeletion,
  ResourceKind,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";
import type { CursorPaths } from "../platform/paths";
import {
  assertSafeRelativePath,
  listFilesRecursively,
  normalizeResourcePath,
  pathExists,
  readFileWithinRoot,
  removeFileWithinRoot,
  writeFileAtomicWithinRoot,
} from "../platform/files";
import { sha256 } from "../protocol/canonical";
import type { ResourceAdapter, ResourceApplyInput } from "./resource";
import { isDeletion } from "./resource";
import { parseJsonc } from "./jsonc";
import { discoverProfileResourcePaths, profilePathById } from "./profilePaths";

interface ProfileFileCandidate {
  kind: ResourceKind;
  profileId: string;
  path: string;
  relativePath: string;
  validateJsonc: boolean;
}

export class ProfileFilesAdapter implements ResourceAdapter {
  readonly id = "profile-files";
  readonly kinds = [
    "keybindings",
    "snippet",
    "task",
    "prompt",
    "mcp",
  ] as const;
  readonly appliesWhileRunning = true;

  constructor(private readonly paths: CursorPaths) {}

  async scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult> {
    const snapshots: ResourceSnapshot[] = [];
    const warnings: string[] = [];
    const current = new Set<string>();
    const unscannedScopes = new Set<string>();
    for (const candidate of await this.discoverCandidates(
      warnings,
      unscannedScopes,
    )) {
      const resourceId = resourceIdFor(candidate);
      current.add(resourceId);
      try {
        const content = await readFileWithinRoot(
          this.paths.userDataRoot,
          normalizeResourcePath(
            relative(this.paths.userDataRoot, candidate.path),
          ),
        );
        if (candidate.validateJsonc) {
          parseJsonc(content.toString("utf8"), candidate.path);
        }
        snapshots.push({
          resourceId,
          kind: candidate.kind,
          content,
          semanticHash: sha256(content),
          metadata: {
            profileId: candidate.profileId,
            relativePath: candidate.relativePath,
          },
        });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    return {
      snapshots,
      deletions: this.findDeletions(known, current, unscannedScopes),
      warnings,
    };
  }

  async apply(input: ResourceApplyInput): Promise<void> {
    const profileId = metadataString(input.metadata, "profileId");
    const relativePath = metadataString(input.metadata, "relativePath");
    const expectedResourceId = `${input.kind}/${encodeURIComponent(profileId)}/${encodeURIComponent(relativePath)}`;
    if (input.resourceId !== expectedResourceId) {
      throw new Error(`Profile file metadata does not match ${input.resourceId}.`);
    }
    assertAllowedProfileRelativePath(input.kind, relativePath);
    const root = rootForKind(this.paths, input.kind, profileId);
    const target = assertSafeRelativePath(root, relativePath);
    const targetFromUserData = normalizeResourcePath(
      relative(this.paths.userDataRoot, target),
    );
    if (isDeletion(input)) {
      await removeFileWithinRoot(this.paths.userDataRoot, targetFromUserData);
      return;
    }
    if (["keybindings", "snippet", "task", "mcp"].includes(input.kind)) {
      parseJsonc(input.content.toString("utf8"), input.resourceId);
    }
    await writeFileAtomicWithinRoot(
      this.paths.userDataRoot,
      targetFromUserData,
      input.content,
    );
  }

  private async discoverCandidates(
    warnings: string[],
    unscannedScopes: Set<string>,
  ): Promise<ProfileFileCandidate[]> {
    const candidates: ProfileFileCandidate[] = [];
    for (const profile of await discoverProfileResourcePaths(this.paths)) {
      const singleFiles: Array<{
        kind: ResourceKind;
        path: string;
        validateJsonc: boolean;
      }> = [
        { kind: "keybindings", path: profile.keybindings, validateJsonc: true },
        { kind: "task", path: profile.tasks, validateJsonc: true },
        { kind: "mcp", path: profile.mcp, validateJsonc: true },
      ];
      for (const file of singleFiles) {
        if (await pathExists(file.path)) {
          candidates.push({
            ...file,
            profileId: profile.profileId,
            relativePath: basename(file.path),
          });
        }
      }
      let snippetPaths: string[] = [];
      try {
        snippetPaths = await listFilesRecursively(profile.snippets);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        unscannedScopes.add(scanScope("snippet", profile.profileId));
      }
      for (const path of snippetPaths) {
        if (/\.(json|code-snippets)$/i.test(path)) {
          candidates.push({
            kind: "snippet",
            profileId: profile.profileId,
            path,
            relativePath: normalizeResourcePath(relative(profile.snippets, path)),
            validateJsonc: true,
          });
        }
      }
      let promptPaths: string[] = [];
      try {
        promptPaths = await listFilesRecursively(profile.prompts);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        unscannedScopes.add(scanScope("prompt", profile.profileId));
      }
      for (const path of promptPaths) {
        candidates.push({
          kind: "prompt",
          profileId: profile.profileId,
          path,
          relativePath: normalizeResourcePath(relative(profile.prompts, path)),
          validateJsonc: false,
        });
      }
    }
    return candidates;
  }

  private findDeletions(
    known: Record<string, LocalProjection>,
    current: Set<string>,
    unscannedScopes: ReadonlySet<string>,
  ): ResourceDeletion[] {
    return Object.values(known)
      .filter(
        (projection) =>
          this.kinds.includes(
            projection.kind as (typeof this.kinds)[number],
          ) &&
          !current.has(projection.resourceId) &&
          !unscannedScopes.has(
            scanScope(
              projection.kind,
              parseResourceId(projection.resourceId).profileId,
            ),
          ),
      )
      .map((projection) => {
        const parsed = parseResourceId(projection.resourceId);
        return {
          resourceId: projection.resourceId,
          kind: projection.kind,
          semanticHash: sha256(`deleted:${projection.resourceId}`),
          metadata: {
            profileId: parsed.profileId,
            relativePath: parsed.relativePath,
          },
        };
      });
  }
}

function scanScope(kind: ResourceKind, profileId: string): string {
  return `${kind}/${profileId}`;
}

function assertAllowedProfileRelativePath(
  kind: ResourceKind,
  relativePath: string,
): void {
  const exact: Partial<Record<ResourceKind, string>> = {
    keybindings: "keybindings.json",
    task: "tasks.json",
    mcp: "mcp.json",
  };
  const expected = exact[kind];
  if (expected !== undefined && relativePath !== expected) {
    throw new Error(`Unexpected ${kind} path: ${relativePath}`);
  }
  if (
    kind === "snippet" &&
    !/\.(json|code-snippets)$/i.test(relativePath)
  ) {
    throw new Error(`Unexpected snippet path: ${relativePath}`);
  }
}

function resourceIdFor(candidate: ProfileFileCandidate): string {
  return `${candidate.kind}/${encodeURIComponent(candidate.profileId)}/${encodeURIComponent(
    candidate.relativePath,
  )}`;
}

function parseResourceId(resourceId: string): {
  profileId: string;
  relativePath: string;
} {
  const [, profileId, relativePath] = resourceId.split("/");
  if (profileId === undefined || relativePath === undefined) {
    throw new Error(`Invalid profile resource ID: ${resourceId}`);
  }
  return {
    profileId: decodeURIComponent(profileId),
    relativePath: decodeURIComponent(relativePath),
  };
}

function rootForKind(
  paths: CursorPaths,
  kind: ResourceKind,
  profileId: string,
): string {
  const profile = profilePathById(paths, profileId);
  switch (kind) {
    case "snippet":
      return profile.snippets;
    case "prompt":
      return profile.prompts;
    case "keybindings":
    case "task":
    case "mcp":
      return profile.root;
    default:
      throw new Error(`Unsupported profile file kind: ${kind}`);
  }
}

function metadataString(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string {
  const value = metadata?.[key];
  if (typeof value !== "string") {
    throw new Error(`Resource metadata is missing ${key}.`);
  }
  return value;
}
