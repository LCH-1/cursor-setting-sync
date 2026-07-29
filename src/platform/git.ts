import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { directorySize, ensureDirectory, pathExists } from "./files";

const GIT_TIMEOUT_MS = 120_000;
// Clone, fetch and push move the whole encrypted repository, which can reach
// hundreds of megabytes; push is not resumable, so a short timeout would make
// a large repository permanently unpushable.
const GIT_NETWORK_TIMEOUT_MS = 600_000;
const NETWORK_SUBCOMMANDS = new Set(["clone", "fetch", "push", "pull"]);
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GITHUB_LARGE_FILE_THRESHOLD_BYTES = 95 * 1024 * 1024;
const SQUASH_BRANCH_PREFIX = "cursor-sync-squash-";

const AUTH_FAILURE_PATTERN =
  /authentication failed|could not read username|could not read password|terminal prompts disabled|permission denied \(publickey\)|invalid credentials|access denied|the requested url returned error: 40[13]|support for password authentication was removed/i;

export type GitErrorKind = "missing-binary" | "auth" | "conflict" | "command";

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitDetection {
  available: boolean;
  version: string | null;
}

export type PullStatus = "no-remote" | "up-to-date" | "merged" | "reset";

export interface PullResult {
  status: PullStatus;
}

export interface CommitPushResult {
  committed: boolean;
  pushed: boolean;
  recoveredByPull: boolean;
}

export interface SquashHistoryResult {
  bytesBefore: number | null;
  bytesAfter: number | null;
  pushed: boolean;
}

export interface LargeFileWarning {
  path: string;
  sizeBytes: number;
}

interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function detectGit(): Promise<GitDetection> {
  try {
    const result = await execGitRaw(null, ["--version"]);
    if (result.code !== 0) {
      return { available: false, version: null };
    }
    const match = /git version (\S+)/.exec(result.stdout);
    return { available: true, version: match?.[1] ?? result.stdout.trim() };
  } catch (error) {
    if (error instanceof GitError && error.kind === "missing-binary") {
      return { available: false, version: null };
    }
    throw error;
  }
}

export async function isGitRepository(root: string): Promise<boolean> {
  if (!(await pathExists(join(root, ".git")))) {
    return false;
  }
  const result = await execGitRaw(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function initRepository(
  root: string,
  remoteUrl: string | null,
  branch = "main",
): Promise<void> {
  assertSafeGitArgument(branch, "branch name");
  await ensureDirectory(root);
  await runGit(root, ["init", "-b", branch]);
  await disableLineEndingConversion(root);
  if (remoteUrl !== null) {
    assertSafeGitArgument(remoteUrl, "remote URL");
    const existing = await execGitRaw(root, ["remote", "get-url", "origin"]);
    if (existing.code === 0) {
      await runGit(root, ["remote", "set-url", "origin", remoteUrl]);
    } else {
      await runGit(root, ["remote", "add", "origin", remoteUrl]);
    }
  }
}

export async function cloneRepository(
  remoteUrl: string,
  root: string,
  branch?: string,
): Promise<void> {
  assertSafeGitArgument(remoteUrl, "remote URL");
  if (branch !== undefined) {
    assertSafeGitArgument(branch, "branch name");
  }
  await ensureDirectory(root);
  // Leftover staging directories from an earlier failed clone are this
  // extension's own debris; clearing them lets a retry reach the clone path
  // instead of wedging on "must be an empty directory" forever.
  for (const entry of await readdir(root)) {
    if (entry.startsWith(".cursor-sync-clone-")) {
      await rm(join(root, entry), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      }).catch(() => {});
    }
  }
  const entries = await readdir(root);
  if (entries.length > 0) {
    throw new GitError(
      "command",
      `Clone target must be an empty directory: ${root}`,
    );
  }
  // Clone into a staging subdirectory, never into the target itself. A clone
  // force-killed mid-checkout (the timeout SIGKILLs git before its atexit
  // cleanup) leaves debris, and cleaning the TARGET on failure deleted files
  // that arrived AFTER the emptiness precheck - in a cloud-synced folder,
  // potentially another machine's repository content, with the deletions
  // propagating. Scoping everything to the staging directory makes deleting
  // a file the clone did not create structurally impossible.
  const stagingName = `.cursor-sync-clone-${randomUUID().slice(0, 8)}`;
  const staging = join(root, stagingName);
  const args = ["-c", "core.autocrlf=false", "clone"];
  if (branch !== undefined) {
    args.push("--branch", branch);
  }
  args.push("--", remoteUrl, stagingName);
  try {
    await runGit(root, args);
  } catch (error) {
    try {
      await rm(staging, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    } catch {
      // The staging folder may need emptying by hand; the rethrown clone
      // error is still the story that matters, and the visible dot-directory
      // names itself as this extension's debris.
    }
    throw error;
  }
  // Success: the target must still contain nothing but the staging directory
  // before its contents move up. Foreign files that appeared meanwhile are
  // NOT deleted - in a cloud-synced folder they are most likely another
  // machine's repository arriving, and the right move is to JOIN it, never
  // to hand-delete it.
  const afterClone = (await readdir(root)).filter((name) => name !== stagingName);
  if (afterClone.length > 0) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new GitError(
      "command",
      `Files appeared in the clone target while cloning (${afterClone[0] ?? ""}). ` +
        "If this folder synchronizes from another computer, wait for that synchronization to finish and run Setup again - it will join the repository that arrived. " +
        "Only empty the folder if you are certain the files are not another computer's sync data.",
    );
  }
  // The promotion gets the same transient-lock tolerance as every other
  // mutation of this directory - OneDrive or an antivirus holding one fresh
  // checkout file made a single bare rename throw a raw EPERM out of Setup
  // over a fully successful clone. On unrecoverable failure the moved
  // entries go back so the target again holds only the staging directory,
  // which the precheck above clears on the next attempt.
  const promoted: string[] = [];
  try {
    for (const entry of await readdir(staging)) {
      await renameWithRetries(join(staging, entry), join(root, entry));
      promoted.push(entry);
    }
  } catch (error) {
    for (const entry of promoted) {
      await renameWithRetries(join(root, entry), join(staging, entry)).catch(
        () => {},
      );
    }
    throw new GitError(
      "command",
      `The clone finished but its files could not be moved into place (${
        error instanceof Error ? error.message : String(error)
      }). Close programs that may hold the folder open and run Setup again.`,
    );
  }
  // Staging is empty and the clone has fully materialized; a locked leftover
  // directory is cosmetic and the precheck clears it next time.
  await rm(staging, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 200,
  }).catch(() => {});
  await disableLineEndingConversion(root);
}

async function renameWithRetries(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt >= 4 ||
        (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

async function disableLineEndingConversion(root: string): Promise<void> {
  // Repository content is encrypted and hash-addressed, so every checkout
  // must reproduce it byte for byte; a global core.autocrlf=true on Windows
  // would rewrite line endings and corrupt integrity checks.
  await runGit(root, ["config", "core.autocrlf", "false"]);
}

export async function pullLatest(root: string): Promise<PullResult> {
  const branch = await currentBranch(root);
  assertNotSquashBranch(branch);
  await abortInterruptedMerge(root);
  const remote = await execGitRaw(root, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) {
    return { status: "no-remote" };
  }

  const fetch = await execGitRaw(root, ["fetch", "origin", branch]);
  if (fetch.code !== 0) {
    if (/couldn't find remote ref|no matching remote head/i.test(fetch.stderr)) {
      // The remote exists but has no branch yet (fresh bare repository); the
      // first push will create it.
      return { status: "up-to-date" };
    }
    throw classifyGitFailure(["fetch", "origin", branch], fetch);
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteExists =
    (await execGitRaw(root, ["rev-parse", "--verify", "--quiet", remoteRef]))
      .code === 0;
  if (!remoteExists) {
    return { status: "up-to-date" };
  }
  await ensureUpstream(root, branch);

  const born =
    (await execGitRaw(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))
      .code === 0;
  if (!born) {
    // A repository initialized against an already-populated remote has no
    // local commits to merge into. checkout -B adopts the remote branch while
    // refusing to clobber untracked local files, which are exactly this
    // device's own not-yet-committed files.
    await runGit(root, ["checkout", "-B", branch, remoteRef]);
    return { status: "reset" };
  }

  const before = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  const merge = await execGitRaw(root, [
    ...(await identityFlags(root)),
    "merge",
    "--no-edit",
    "FETCH_HEAD",
  ]);
  if (merge.code === 0) {
    const after = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    return { status: after === before ? "up-to-date" : "merged" };
  }

  const output = `${merge.stdout}\n${merge.stderr}`;
  if (/refusing to merge unrelated histories/i.test(output)) {
    // A rewritten remote (checkpoint squash starts a new orphan root) shares
    // no ancestor with the local branch. reset --mixed adopts the remote
    // history while keeping the working tree, so this device's own unpushed
    // event files stay on disk for the caller to re-commit.
    await assertRecoverableWorkingTree(root);
    await runGit(root, ["reset", "--mixed", remoteRef]);
    await restoreMissingTrackedFiles(root);
    return { status: "reset" };
  }
  if (
    /CONFLICT|automatic merge failed/i.test(output) ||
    (await hasUnmergedPaths(root))
  ) {
    const conflicted = (
      await execGitRaw(root, ["diff", "--name-only", "--diff-filter=U"])
    ).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    await execGitRaw(root, ["merge", "--abort"]);
    throw new GitError(
      "conflict",
      `git merge conflict in sync repository — this should be impossible; inspect ${
        conflicted.length > 0 ? conflicted.join(", ") : "the repository"
      }`,
    );
  }
  throw classifyGitFailure(["merge", "--no-edit", "FETCH_HEAD"], merge);
}

export async function commitAndPush(
  root: string,
  message: string,
): Promise<CommitPushResult> {
  const branch = await currentBranch(root);
  assertNotSquashBranch(branch);
  const committed = await stageAndCommit(root, message);
  const remote = await execGitRaw(root, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) {
    return { committed, pushed: false, recoveredByPull: false };
  }
  if (!committed && !(await hasUnpushedCommits(root, branch))) {
    return { committed: false, pushed: false, recoveredByPull: false };
  }

  const pushArgs = ["push", "-u", "origin", branch];
  const push = await execGitRaw(root, pushArgs);
  if (push.code === 0) {
    return { committed, pushed: true, recoveredByPull: false };
  }
  const failure = classifyGitFailure(pushArgs, push);
  if (failure.kind === "auth" || !isPushRejection(push)) {
    throw failure;
  }

  const pull = await pullLatest(root);
  const recommitted =
    pull.status === "reset" ? await stageAndCommit(root, message) : false;
  const retry = await execGitRaw(root, pushArgs);
  if (retry.code !== 0) {
    throw classifyGitFailure(pushArgs, retry);
  }
  return {
    committed: committed || recommitted,
    pushed: true,
    recoveredByPull: true,
  };
}

export async function squashHistory(
  root: string,
  message: string,
): Promise<SquashHistoryResult> {
  const branch = await currentBranch(root);
  const gitDirectory = join(root, ".git");
  const bytesBefore = await directorySizeOrNull(gitDirectory);

  const temporary = `${SQUASH_BRANCH_PREFIX}${randomUUID().slice(0, 8)}`;
  try {
    await runGit(root, ["checkout", "--orphan", temporary]);
    await runGit(root, ["add", "-A"]);
    await runGit(root, [
      ...(await identityFlags(root)),
      "commit",
      "-m",
      message,
    ]);
    await runGit(root, ["branch", "-M", branch]);
  } catch (error) {
    // A half-finished squash would strand the device on the orphan branch,
    // where fetch/push silently target a branch no other device reads.
    await execGitRaw(root, ["checkout", "-f", branch]);
    await execGitRaw(root, ["branch", "-D", temporary]);
    throw error;
  }

  const remote = await execGitRaw(root, ["remote", "get-url", "origin"]);
  let pushed = false;
  if (remote.code === 0) {
    await runGit(root, [
      "push",
      "--force-with-lease",
      "-u",
      "origin",
      branch,
    ]);
    pushed = true;
  }

  // Without expiring reflogs first, gc keeps the pre-squash history reachable
  // and reclaims nothing. Both steps are best-effort: on Windows open pack
  // handles can make gc fail, and a failed cleanup must not fail the squash.
  try {
    await execGitRaw(root, ["reflog", "expire", "--expire=now", "--all"]);
  } catch (_error) {
    // Tolerated.
  }
  try {
    await execGitRaw(root, ["gc", "--prune=now", "--aggressive"]);
  } catch (_error) {
    // Tolerated.
  }

  const bytesAfter = await directorySizeOrNull(gitDirectory);
  return { bytesBefore, bytesAfter, pushed };
}

export async function largeFileWarnings(
  root: string,
  thresholdBytes = GITHUB_LARGE_FILE_THRESHOLD_BYTES,
): Promise<LargeFileWarning[]> {
  if (!(await pathExists(root))) {
    return [];
  }
  const warnings: LargeFileWarning[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.isSymbolicLink()) {
        continue;
      }
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const size = (await stat(child)).size;
      if (size > thresholdBytes) {
        warnings.push({
          path: relative(root, child).replaceAll("\\", "/"),
          sizeBytes: size,
        });
      }
    }
  }
  return warnings.sort(
    (left, right) =>
      right.sizeBytes - left.sizeBytes || left.path.localeCompare(right.path),
  );
}

async function currentBranch(root: string): Promise<string> {
  const result = await execGitRaw(root, ["symbolic-ref", "--short", "HEAD"]);
  if (result.code !== 0) {
    if (/not a git repository/i.test(result.stderr)) {
      throw new GitError(
        "command",
        `The sync repository is not a git repository: ${root}`,
      );
    }
    throw new GitError(
      "command",
      `The sync repository is in a detached HEAD state; check out a branch before syncing: ${root}`,
    );
  }
  return result.stdout.trim();
}

async function ensureUpstream(root: string, branch: string): Promise<void> {
  const upstream = await execGitRaw(root, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  ]);
  if (upstream.code === 0) {
    return;
  }
  // Written as plain config so it also works before the branch's first commit,
  // where branch --set-upstream-to refuses to run.
  await runGit(root, ["config", `branch.${branch}.remote`, "origin"]);
  await runGit(root, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
}

async function stageAndCommit(root: string, message: string): Promise<boolean> {
  await runGit(root, ["add", "-A"]);
  if (!(await hasStagedChanges(root))) {
    return false;
  }
  await runGit(root, [...(await identityFlags(root)), "commit", "-m", message]);
  return true;
}

async function hasStagedChanges(root: string): Promise<boolean> {
  const born =
    (await execGitRaw(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))
      .code === 0;
  if (!born) {
    // diff --cached needs a HEAD to compare against; after add -A every
    // change is staged, so any status output means there is something to
    // commit.
    const status = await runGit(root, ["status", "--porcelain"]);
    return status.stdout.trim().length > 0;
  }
  const staged = await execGitRaw(root, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) {
    return false;
  }
  if (staged.code === 1) {
    return true;
  }
  throw classifyGitFailure(["diff", "--cached", "--quiet"], staged);
}

async function hasUnpushedCommits(root: string, branch: string): Promise<boolean> {
  const born =
    (await execGitRaw(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))
      .code === 0;
  if (!born) {
    return false;
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteExists =
    (await execGitRaw(root, ["rev-parse", "--verify", "--quiet", remoteRef]))
      .code === 0;
  if (!remoteExists) {
    return true;
  }
  const ahead = await runGit(root, ["rev-list", "--count", `${remoteRef}..HEAD`]);
  return Number.parseInt(ahead.stdout.trim(), 10) > 0;
}

async function identityFlags(root: string): Promise<string[]> {
  // The sync repository is private transport, so a missing global identity
  // must not block commits; an explicit one is respected untouched.
  const email = await execGitRaw(root, ["config", "user.email"]);
  if (email.code === 0 && email.stdout.trim().length > 0) {
    return [];
  }
  return [
    "-c",
    "user.name=Cursor Setting Sync",
    "-c",
    "user.email=cursor-sync@localhost",
  ];
}

async function hasUnmergedPaths(root: string): Promise<boolean> {
  const unmerged = await execGitRaw(root, ["ls-files", "--unmerged"]);
  return unmerged.code === 0 && unmerged.stdout.trim().length > 0;
}

async function assertRecoverableWorkingTree(root: string): Promise<void> {
  const mergeHead = await execGitRaw(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "MERGE_HEAD",
  ]);
  if (mergeHead.code === 0 || (await hasUnmergedPaths(root))) {
    throw new GitError(
      "conflict",
      "git merge conflict in sync repository — this should be impossible; inspect the repository before retrying the history-rewrite recovery.",
    );
  }
}

async function restoreMissingTrackedFiles(root: string): Promise<void> {
  const listed = await runGit(root, ["ls-files", "--deleted", "-z"]);
  const missing = listed.stdout.split("\0").filter((entry) => entry.length > 0);
  // These are files the reset target tracks but this clone never checked out
  // (events other devices pushed before the squash). Without restoring them,
  // the caller's add -A would commit their deletion. Chunked so one command
  // line stays under the Windows argument-length limit.
  let index = 0;
  while (index < missing.length) {
    const chunk: string[] = [];
    let length = 0;
    while (index < missing.length) {
      const entry = missing[index];
      if (entry === undefined) {
        index += 1;
        continue;
      }
      if (chunk.length > 0 && length + entry.length > 6000) {
        break;
      }
      chunk.push(entry);
      length += entry.length + 1;
      index += 1;
    }
    if (chunk.length > 0) {
      await runGit(root, ["checkout", "--", ...chunk]);
    }
  }
}

function isPushRejection(result: GitCommandResult): boolean {
  return /\[rejected\]|failed to push some refs|non-fast-forward|fetch first|stale info/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

async function directorySizeOrNull(path: string): Promise<number | null> {
  try {
    return await directorySize(path);
  } catch (_error) {
    return null;
  }
}

function assertSafeGitArgument(value: string, label: string): string {
  if (value.length === 0 || value.startsWith("-") || value.includes("\0")) {
    throw new GitError("command", `Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

async function runGit(
  cwd: string | null,
  args: string[],
): Promise<GitCommandResult> {
  const result = await execGitRaw(cwd, args);
  if (result.code !== 0) {
    throw classifyGitFailure(args, result);
  }
  return result;
}

function gitTimeoutFor(args: string[]): number {
  const subcommand = gitSubcommandOf(args);
  return subcommand !== undefined && NETWORK_SUBCOMMANDS.has(subcommand)
    ? GIT_NETWORK_TIMEOUT_MS
    : GIT_TIMEOUT_MS;
}

/**
 * The first argument that is actually the subcommand. "First that does not
 * start with a dash" is not it: `-c key=value` takes a separate value argument,
 * so clone invocations spelled `['-c','core.autocrlf=false','clone',...]`
 * resolved to `core.autocrlf=false` and the clone ran under the short local
 * timeout instead of the network one - which killed every join of a large
 * repository over a slow link at 120 s, deleted the partial clone, and left
 * nothing to resume.
 */
function gitSubcommandOf(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "-c" || argument === "-C") {
      // Both take their value as the next argument.
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      continue;
    }
    return argument;
  }
  return undefined;
}

function assertNotSquashBranch(branch: string): void {
  if (branch.startsWith(SQUASH_BRANCH_PREFIX)) {
    throw new GitError(
      "command",
      `The sync repository is checked out on the temporary squash branch ${branch}, which no other device reads. An earlier history squash was interrupted; run "git checkout main" (or the configured branch) in the repository folder to recover.`,
    );
  }
}

/**
 * A merge interrupted without recorded conflicts leaves MERGE_HEAD behind and
 * every later merge fails until it is concluded, so the transport would stay
 * degraded forever.
 */
async function abortInterruptedMerge(root: string): Promise<void> {
  const merging = await execGitRaw(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "MERGE_HEAD",
  ]);
  if (merging.code !== 0 || (await hasUnmergedPaths(root))) {
    return;
  }
  await execGitRaw(root, ["merge", "--abort"]);
}

async function execGitRaw(
  cwd: string | null,
  args: string[],
): Promise<GitCommandResult> {
  if (cwd !== null && !(await pathExists(cwd))) {
    throw new GitError(
      "command",
      `Git repository directory does not exist: ${cwd}`,
    );
  }
  const timeoutMs = gitTimeoutFor(args);
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      args,
      {
        cwd: cwd ?? undefined,
        // GIT_TERMINAL_PROMPT/GIT_ASKPASS force credential failures to fail
        // fast instead of prompting; GCM_INTERACTIVE stops the Windows
        // credential manager from raising a GUI dialog.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "echo",
          GCM_INTERACTIVE: "never",
          // A user who signs their commits globally (commit.gpgsign=true with
          // a passphrase-protected key) would get a stray pinentry dialog -
          // or a 120s hang - from EVERY sync commit, squash commit and merge
          // commit, in the extension and the helper alike. Sync commits are
          // plumbing, not authored history; signing them serves nobody.
          // GIT_CONFIG_* overrides all config files (git >= 2.31).
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "commit.gpgsign",
          GIT_CONFIG_VALUE_0: "false",
        },
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as Error & {
          code?: number | string;
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (failure.code === "ENOENT") {
          rejectPromise(
            new GitError(
              "missing-binary",
              "The git executable was not found on PATH. Install git (https://git-scm.com) or add it to PATH to use git-based sync.",
            ),
          );
          return;
        }
        if (failure.killed === true || typeof failure.signal === "string") {
          rejectPromise(
            new GitError(
              "command",
              `git ${args.join(" ")} timed out after ${timeoutMs / 1000} seconds or was terminated (signal ${failure.signal ?? "unknown"}).`,
            ),
          );
          return;
        }
        if (typeof failure.code === "number") {
          resolvePromise({ code: failure.code, stdout, stderr });
          return;
        }
        rejectPromise(
          new GitError("command", `git ${args.join(" ")} failed: ${failure.message}`),
        );
      },
    );
  });
}

function classifyGitFailure(
  args: string[],
  result: GitCommandResult,
): GitError {
  const detail =
    result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  if (AUTH_FAILURE_PATTERN.test(`${result.stderr}\n${result.stdout}`)) {
    return new GitError(
      "auth",
      `git ${args[0] ?? ""} was rejected by the remote. Configure git credentials for the remote (credential helper or access token) or switch the remote URL to SSH. ${detail}`,
    );
  }
  return new GitError("command", `git ${args.join(" ")} failed: ${detail}`);
}
