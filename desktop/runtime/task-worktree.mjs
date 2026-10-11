import { execFile as execFileChild } from "node:child_process";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// Git worktrees for parallel tasks inside the repository: `<repository root>/.pomegr/worktrees/<task id>`. Paths stay in desktop main.
// Nothing here discards work: a worktree is removed only when clean and its HEAD holds no commit that exists nowhere else.

export const TASK_WORKTREE_REPOSITORY_PATH = Object.freeze([".pomegr", "worktrees"]);
// Where worktrees were made before they moved into the repository: `<desktop data root>/task-worktrees/<repository id>/<task id>`.
// One that is still there is used, opened, and removed where it is.
export const TASK_WORKTREE_DIRECTORY = "task-worktrees";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const UNSAFE_PATH = /[\u0000\r\n"]/u;
const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_BYTES = 1024 * 1024;

export const taskBranch = (taskId) => `tasks/${taskId}`;

const safeAbsolute = (value) => typeof value === "string" && value !== "" && !UNSAFE_PATH.test(value)
  && path.isAbsolute(value) && path.resolve(value) === value;

function defaultDirectoryExists(directory) {
  try { return statSync(directory).isDirectory(); } catch { return false; }
}

// The path the file system gives a directory (resolves Windows short names and links), so it compares equal to what Git lists.
function canonicalPath(value) {
  try { return realpathSync.native(value); } catch { return path.resolve(value); }
}

/** Git prints worktree paths with forward slashes and in their long form; Windows paths compare without case. */
function samePath(left, right, platform) {
  const same = (a, b) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  return same(path.resolve(left), path.resolve(right)) || same(canonicalPath(left), canonicalPath(right));
}

// Ignores everything in the worktrees folder, itself included, so the repository's own working tree stays clean.
function defaultIgnoreContents(directory) {
  try { writeFileSync(path.join(directory, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
}

function listedBranch(porcelain, directory, platform) {
  for (const block of porcelain.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const listed = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!listed || !samePath(listed, directory, platform)) continue;
    return lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? "";
  }
  return null;
}

export function createTaskWorktrees(options = {}) {
  const legacyRoot = safeAbsolute(options.root) ? options.root : null;
  const execFile = options.execFile || execFileChild;
  const executable = options.git || "git";
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const directoryExists = options.directoryExists || defaultDirectoryExists;
  const makeDirectory = options.makeDirectory || ((directory) => { mkdirSync(directory, { recursive: true }); });
  const ignoreContents = options.ignoreContents || defaultIgnoreContents;

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
    if (!safeAbsolute(repositoryRoot)) return null;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId) || typeof taskId !== "string" || !TASK_ID.test(taskId)) return null;
    const legacy = legacyRoot ? path.join(legacyRoot, repositoryId, taskId) : null;
    const made = legacy !== null && directoryExists(legacy);
    return { repositoryRoot, directory: made ? legacy : path.join(repositoryRoot, ...TASK_WORKTREE_REPOSITORY_PATH, taskId), branch: taskBranch(taskId) };
  }

  async function listed({ repositoryRoot, directory }) {
    const list = await git(repositoryRoot, ["worktree", "list", "--porcelain"]);
    return list.ok ? listedBranch(list.stdout, directory, platform) : null;
  }

  async function treeState(directory) {
    const status = await git(directory, ["status", "--porcelain", "--untracked-files=normal"]);
    if (!status.ok) return "unknown";
    return status.stdout.trim() === "" ? "clean" : "dirty";
  }

  async function clean(directory) {
    return await treeState(directory) === "clean";
  }

  /** A worktree left by an earlier start is reused only when Git lists it on the task branch and its tree is clean. */
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
      ignoreContents(path.dirname(at.directory));
      const existing = await git(at.repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${at.branch}`]);
      const added = existing.ok
        ? await git(at.repositoryRoot, ["worktree", "add", at.directory, at.branch])
        : await git(at.repositoryRoot, ["worktree", "add", "-b", at.branch, at.directory, "HEAD"]);
      if (!added.ok || !directoryExists(at.directory)) return { ok: false };
      return { ok: true, directory: at.directory, created: true, branchCreated: !existing.ok };
    } catch { return { ok: false }; }
  }

  /** Removes the worktree only when nothing would be lost. The branch goes only when it was the worktree's own, so every commit of it was just found elsewhere. */
  async function remove(request) {
    const at = target(request);
    if (!at) return "failed";
    try {
      if (!directoryExists(at.directory)) return "absent";
      const branch = await listed(at);
      if (branch === null) return "kept";
      if (!(await clean(at.directory))) return "kept";
      const unique = await git(at.directory, ["rev-list", "--count", "HEAD", "--not", "--remotes", `--exclude=${at.branch}`, "--branches"]);
      if (!unique.ok || unique.stdout.trim() !== "0") return "kept";
      if (!(await git(at.repositoryRoot, ["worktree", "remove", at.directory])).ok) return "failed";
      if (request.deleteBranch === true && branch === `refs/heads/${at.branch}`) await git(at.repositoryRoot, ["branch", "-D", at.branch]);
      return "removed";
    } catch { return "failed"; }
  }

  /** For desktop main alone: the path never leaves main. Without a repository root only a worktree made before the move is found. */
  async function locate({ repositoryRoot, repositoryId, taskId } = {}) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId) || typeof taskId !== "string" || !TASK_ID.test(taskId)) return null;
    const directories = [
      ...(safeAbsolute(repositoryRoot) ? [path.join(repositoryRoot, ...TASK_WORKTREE_REPOSITORY_PATH, taskId)] : []),
      ...(legacyRoot ? [path.join(legacyRoot, repositoryId, taskId)] : []),
    ];
    try {
      for (const directory of directories) {
        if (!directoryExists(directory)) continue;
        const branch = await listed({ repositoryRoot: directory, directory });
        if (branch === `refs/heads/${taskBranch(taskId)}`) return directory;
      }
      return null;
    } catch { return null; }
  }

  return Object.freeze({ ensure, remove, locate });
}
