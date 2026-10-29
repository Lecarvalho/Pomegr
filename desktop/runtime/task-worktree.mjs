import { execFile as execFileChild } from "node:child_process";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
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
const INVENTORY_PARALLEL = 3;

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
  const openDirectory = options.openDirectory || opendir;
  const lstatEntry = options.lstat || lstat;
  const now = options.now || Date.now;
  const listeners = new Set();

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

  /** `listener(repositoryId, taskId)` runs after a worktree of that task was made, was removed, or was found missing. It changes no outcome. */
  function onChange(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function changed(repositoryId, taskId) {
    for (const listener of listeners) {
      try { listener(repositoryId, taskId); } catch { /* A listener never changes what happened to the worktree. */ }
    }
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

  // True when HEAD holds a commit that exists on no remote and on no branch but the task's own; null when Git cannot say.
  async function uniqueCommits(directory, branch) {
    const found = await git(directory, ["rev-list", "--count", "HEAD", "--not", "--remotes", `--exclude=${branch}`, "--branches"]);
    return found.ok ? found.stdout.trim() !== "0" : null;
  }

  // The size of a folder from a bounded walk (20,000 entries, 2 seconds, or the inventory's shared deadline); `atLeast` says the
  // walk stopped early. Links are not followed.
  async function treeSize(directory, deadline = Infinity) {
    const stop = Math.min(now() + 2_000, deadline); const pending = [directory]; let entries = 0; let bytes = 0; let atLeast = false;
    while (pending.length > 0 && !atLeast) {
      const current = pending.pop(); let iterator = null;
      try {
        iterator = (await openDirectory(current))[Symbol.asyncIterator]();
        for (;;) {
          if (entries >= 20_000 || now() >= stop) { atLeast = true; break; }
          const { value: entry, done } = await iterator.next();
          if (done) break;
          entries++;
          if (entry.isSymbolicLink()) continue;
          const known = await lstatEntry(path.join(current, entry.name));
          if (known.isDirectory()) pending.push(path.join(current, entry.name));
          else if (known.isFile()) bytes += known.size;
        }
      } catch { /* An unreadable or vanished entry adds no known size. */ }
      try { await iterator?.return?.(); } catch { /* Already closed. */ }
    }
    return { sizeMB: Math.round(bytes / 104857.6) / 10, atLeast };
  }

  // The task worktrees Git lists for the repository at the two Pomegr locations as `[task ID, folder]`, at most 30, oldest task first;
  // null when Git cannot list them. The task ID comes only from the folder name.
  async function discover({ repositoryRoot, repositoryId } = {}) {
    if (!safeAbsolute(repositoryRoot) || !REPOSITORY_ID.test(repositoryId || "")) return null;
    const listing = await git(repositoryRoot, ["worktree", "list", "--porcelain"]);
    if (!listing.ok) return null;
    const homes = [path.join(repositoryRoot, ...TASK_WORKTREE_REPOSITORY_PATH), ...(legacyRoot ? [path.join(legacyRoot, repositoryId)] : [])];
    const found = new Map();
    for (const block of listing.stdout.split(/\r?\n\r?\n/u)) {
      const listed = block.split(/\r?\n/u).find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const taskId = listed ? path.basename(listed) : "";
      if (TASK_ID.test(taskId) && homes.some((home) => samePath(listed, path.join(home, taskId), platform))) found.set(taskId, listed);
    }
    return [...found].sort(([a], [b]) => Number(a.slice(2)) - Number(b.slice(2))).slice(0, 30);
  }

  /**
   * The facts Git gives about the task worktrees of a repository, a row for each: `{ taskId, clean, uniqueCommits }`. It walks no folder.
   * A row holds facts only, never a path; a fact that cannot be read counts against removal. A removal never trusts a row: `remove`
   * reads both facts again.
   */
  async function inventory(request = {}) {
    try {
      const found = await discover(request);
      if (!found) return [];
      // A few worktrees at a time: each row is two Git processes.
      const rows = new Array(found.length);
      let next = 0;
      const worker = async () => {
        while (next < found.length) {
          const index = next++;
          const [taskId, directory] = found[index];
          const [state, unique] = await Promise.all([treeState(directory), uniqueCommits(directory, taskBranch(taskId))]);
          rows[index] = { taskId, clean: state === "clean", uniqueCommits: unique !== false };
        }
      };
      await Promise.all(Array.from({ length: Math.min(INVENTORY_PARALLEL, found.length) }, worker));
      return rows;
    } catch { return []; }
  }

  /** The sizes of those worktrees, `{ taskId, sizeMB, atLeast }` each. All the walks share one budget, so they end together in a few seconds. */
  async function sizes(request = {}) {
    try {
      const found = await discover(request);
      if (!found) return [];
      const measured = [], deadline = now() + 6_000;
      for (const [taskId, directory] of found) measured.push({ taskId, ...await treeSize(directory, deadline) });
      return measured;
    } catch { return []; }
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
      changed(request.repositoryId, request.taskId);
      return { ok: true, directory: at.directory, created: true, branchCreated: !existing.ok };
    } catch { return { ok: false }; }
  }

  /** Removes the worktree only when nothing would be lost. The branch goes only when it was the worktree's own, so every commit of it was just found elsewhere. */
  async function remove(request) {
    const at = target(request);
    if (!at) return "failed";
    const detailed = request.detailed === true;
    const gone = (outcome) => { changed(request.repositoryId, request.taskId); return outcome; };
    try {
      if (!directoryExists(at.directory)) return gone(detailed ? "not_found" : "absent");
      const branch = await listed(at);
      if (branch === null) return detailed ? "failed" : "kept";
      const state = await treeState(at.directory);
      if (state === "unknown") return detailed ? "failed" : "kept";
      if (state === "dirty") return detailed ? "dirty" : "kept";
      const unique = await uniqueCommits(at.directory, at.branch);
      if (unique === null) return detailed ? "failed" : "kept";
      if (unique) return detailed ? "unique_commits" : "kept";
      if (!(await git(at.repositoryRoot, ["worktree", "remove", at.directory])).ok) return "failed";
      if (request.deleteBranch === true && branch === `refs/heads/${at.branch}`) await git(at.repositoryRoot, ["branch", "-D", at.branch]);
      return gone("removed");
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

  return Object.freeze({ ensure, remove, locate, inventory, sizes, onChange });
}
