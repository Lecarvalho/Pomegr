import { execFile as execFileChild } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

// Git worktrees for tasks that run in parallel. The tasks of one feature step start together, so each gets a
// worktree of its own under one Pomegr-owned directory of the desktop data root, on the branch `tasks/<task id>`.
// The directory is `<root>/<repository id>/<task id>`: both parts are validated identifiers, so no task text and
// no repository path ever shapes it. Git runs through `execFile` with argument arrays and never through a shell.
// Worktree paths stay in desktop main: they are never sent to the monitor or the renderer.
//
// Nothing here discards work. A worktree is removed only when Git lists it as a worktree of the repository, its
// working tree is clean, and its HEAD holds no commit that exists nowhere else (no remote and no other local
// branch); the removal itself is Git's own unforced `worktree remove`, which refuses a dirty tree again.

export const TASK_WORKTREE_DIRECTORY = "task-worktrees";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const UNSAFE_PATH = /[\u0000\r\n"]/u;
const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_BYTES = 1024 * 1024;

/** The branch a task's worktree is on. */
export const taskBranch = (taskId) => `tasks/${taskId}`;

const safeAbsolute = (value) => typeof value === "string" && value !== "" && !UNSAFE_PATH.test(value)
  && path.isAbsolute(value) && path.resolve(value) === value;

function defaultDirectoryExists(directory) {
  try { return statSync(directory).isDirectory(); } catch { return false; }
}

/** Git prints worktree paths with forward slashes; Windows paths compare without case. */
function samePath(left, right, platform) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The branch Git lists for the worktree at `directory`, `""` for a detached one, or null when it lists none there. */
function listedBranch(porcelain, directory, platform) {
  for (const block of porcelain.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const listed = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!listed || !samePath(listed, directory, platform)) continue;
    return lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? "";
  }
  return null;
}

/**
 * `root` is the Pomegr-owned directory that holds every task worktree. Returns `{ ensure, remove }`; both never
 * throw and answer nothing but fixed values and, for `ensure`, the worktree directory for desktop main.
 */
export function createTaskWorktrees(options = {}) {
  const root = safeAbsolute(options.root) ? options.root : null;
  const execFile = options.execFile || execFileChild;
  const executable = options.git || "git";
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const directoryExists = options.directoryExists || defaultDirectoryExists;
  const makeDirectory = options.makeDirectory || ((directory) => { mkdirSync(directory, { recursive: true }); });

  /** Runs Git in `directory`. Resolves `{ ok, stdout }`; a failure of any kind is `ok: false`. */
  function git(directory, args) {
    return new Promise((resolve) => {
      try {
        execFile(executable, ["-C", directory, ...args], {
          env: { ...environment, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8", shell: false, windowsHide: true,
          timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_BYTES,
        }, (error, stdout) => resolve({ ok: !error, stdout: typeof stdout === "string" ? stdout : "" }));
      } catch { resolve({ ok: false, stdout: "" }); }
    });
  }

  function target({ repositoryRoot, repositoryId, taskId } = {}) {
    if (!root || !safeAbsolute(repositoryRoot)) return null;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId) || typeof taskId !== "string" || !TASK_ID.test(taskId)) return null;
    return { repositoryRoot, directory: path.join(root, repositoryId, taskId), branch: taskBranch(taskId) };
  }

  /** Whether Git lists `directory` as a worktree of the repository, and on which branch. */
  async function listed({ repositoryRoot, directory }) {
    const list = await git(repositoryRoot, ["worktree", "list", "--porcelain"]);
    return list.ok ? listedBranch(list.stdout, directory, platform) : null;
  }

  /** `clean`, `dirty`, or `unknown` when Git's status itself failed: a failed status is never known to be dirty. */
  async function treeState(directory) {
    const status = await git(directory, ["status", "--porcelain", "--untracked-files=normal"]);
    if (!status.ok) return "unknown";
    return status.stdout.trim() === "" ? "clean" : "dirty";
  }

  /** True only for a tree known to be clean: an unknown state is not clean. */
  async function clean(directory) {
    return await treeState(directory) === "clean";
  }

  /**
   * The worktree a task's session runs in: `{ ok: true, directory, created, branchCreated }` or `{ ok: false }`.
   * `{ ok: false, reason: "dirty" }` is the one distinct failure: Git lists the task's worktree on its branch and
   * the tree has uncommitted changes. A `git status` that fails is not known to be dirty and stays the plain failure.
   * A new worktree starts at the repository's current commit, on a new `tasks/<task id>` branch or on that branch
   * when it already exists. A worktree left by an earlier start of the task is used again only when Git still
   * lists it on the task branch and its working tree is clean. A directory in the way that is anything else is
   * left alone and the answer is `ok: false`.
   */
  async function ensure(request) {
    const at = target(request);
    if (!at) return { ok: false };
    try {
      if (directoryExists(at.directory)) {
        const branch = await listed(at);
        if (branch !== `refs/heads/${at.branch}`) return { ok: false };
        const state = await treeState(at.directory);
        if (state === "dirty") return { ok: false, reason: "dirty" };
        if (state !== "clean") return { ok: false };
        return { ok: true, directory: at.directory, created: false, branchCreated: false };
      }
      makeDirectory(path.dirname(at.directory));
      const existing = await git(at.repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${at.branch}`]);
      const added = existing.ok
        ? await git(at.repositoryRoot, ["worktree", "add", at.directory, at.branch])
        : await git(at.repositoryRoot, ["worktree", "add", "-b", at.branch, at.directory, "HEAD"]);
      if (!added.ok || !directoryExists(at.directory)) return { ok: false };
      return { ok: true, directory: at.directory, created: true, branchCreated: !existing.ok };
    } catch { return { ok: false }; }
  }

  /**
   * Removes a task's worktree when nothing would be lost: `removed`, `absent`, `kept` (uncommitted changes, commits
   * that exist nowhere else, or a directory Git does not list as this repository's worktree), or `failed`. With
   * `deleteBranch` the task branch is deleted too, by Git's safe delete, which refuses an unmerged branch.
   */
  async function remove(request) {
    const at = target(request);
    if (!at) return "failed";
    try {
      if (!directoryExists(at.directory)) return "absent";
      if (await listed(at) === null) return "kept";
      if (!(await clean(at.directory))) return "kept";
      const unique = await git(at.directory, ["rev-list", "--count", "HEAD", "--not", "--remotes", `--exclude=${at.branch}`, "--branches"]);
      if (!unique.ok || unique.stdout.trim() !== "0") return "kept";
      if (!(await git(at.repositoryRoot, ["worktree", "remove", at.directory])).ok) return "failed";
      if (request.deleteBranch === true) await git(at.repositoryRoot, ["branch", "-d", at.branch]);
      return "removed";
    } catch { return "failed"; }
  }

  /**
   * The directory of a task's existing worktree, for desktop main alone, or null. It answers only when the directory
   * exists and Git, asked from inside it, lists it as a worktree on `tasks/<task id>`; the path never leaves main.
   */
  async function locate({ repositoryId, taskId } = {}) {
    const at = target({ repositoryRoot: root, repositoryId, taskId });
    if (!at) return null;
    try {
      if (!directoryExists(at.directory)) return null;
      const branch = await listed({ repositoryRoot: at.directory, directory: at.directory });
      return branch === `refs/heads/${at.branch}` ? at.directory : null;
    } catch { return null; }
  }

  return Object.freeze({ ensure, remove, locate });
}
