import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const GIT_OPTIONS = Object.freeze({ windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 });

function absolutePath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && path.isAbsolute(text) && !/[\u0000-\u001f\u007f]/u.test(text) ? path.resolve(text) : null;
}

function samePath(left, right) {
  const a = path.resolve(left); const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function revParse(cwd, args) {
  try {
    const { stdout } = await execFile("git", ["-C", cwd, "rev-parse", ...args], GIT_OPTIONS);
    return String(stdout || "");
  } catch { return null; }
}

/**
 * The default Git lookup of the repository inventory: the checkout's top level and, only for a linked
 * worktree, the common Git directory it shares with its main repository. A linked worktree is the one
 * case where Git's own directory (`<common>/worktrees/<name>`) differs from the common directory; a main
 * checkout, a submodule, and a separate Git directory have the two equal and answer `commonDir: null`.
 * Both reads use the same deadline and output cap; a failed directory read (an older Git, for example)
 * leaves `commonDir` null, so the top level alone names the repository as before.
 * @param {string} cwd
 * @returns {Promise<{ root: string, commonDir: string | null } | null>}
 */
export async function readGitCheckout(cwd) {
  const [toplevel, directories] = await Promise.all([
    revParse(cwd, ["--show-toplevel"]),
    revParse(cwd, ["--path-format=absolute", "--git-dir", "--git-common-dir"]),
  ]);
  const root = absolutePath(toplevel);
  if (!root) return null;
  const [gitDir, commonDir] = String(directories || "").split(/\r?\n/u).map(absolutePath);
  return { root, commonDir: gitDir && commonDir && !samePath(gitDir, commonDir) ? commonDir : null };
}

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
// The folder the desktop keeps task worktrees in (`TASK_WORKTREE_DIRECTORY` in desktop/runtime/task-worktree.mjs).
const TASK_WORKTREE_DIRECTORY = "task-worktrees";
// The task store's task ID format (`TASK_ID` in server/tasks/task-record.mjs, `TASK_ID_PATTERN` in
// shared/task-contract.ts). Repeated here because the repository layer cannot import the task layer;
// tests/server/repository/task-worktree-identity.test.mjs holds the two together.
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const isTaskId = (value) => TASK_ID.test(value);

/**
 * The repository ID a Pomegr-made task worktree path names: the directory is, or is inside,
 * `.../task-worktrees/<repository ID>/<task ID>`, with the exact ID format of the inventory and the task
 * store's task ID format. A path-shape reading only: the caller accepts it solely for a repository ID it
 * already knows, and only when Git gave no answer for the directory.
 * @param {string} cwd
 * @returns {string | null}
 */
export function taskWorktreeRepositoryId(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const segments = path.resolve(cwd).split(/[\\/]+/u);
  for (let index = 0; index + 2 < segments.length; index += 1) {
    if (segments[index] === TASK_WORKTREE_DIRECTORY && REPOSITORY_ID.test(segments[index + 1]) && isTaskId(segments[index + 2])) return segments[index + 1];
  }
  return null;
}

/**
 * The two monitor-private roots of a lookup answer: `root`, the checkout the directory is in (a linked
 * worktree's own top level), and `mainRoot`, the repository it belongs to. `mainRoot` is the parent of
 * the common Git directory when that directory is named `.git` and its parent is another folder than the
 * top level (product-owner decision, 2026-10-10: a linked worktree belongs to its main repository).
 * Everything else, a bare repository or a separate Git directory included, keeps the top level.
 * A lookup may answer a plain top-level string; that is a checkout with no common directory.
 * @param {string | { root?: unknown, commonDir?: unknown } | null | undefined} answer
 * @returns {{ root: string, mainRoot: string } | null}
 */
export function checkoutRoots(answer) {
  const root = typeof answer === "string" ? answer : answer?.root;
  if (typeof root !== "string" || !root || !path.isAbsolute(root)) return null;
  const commonDir = answer !== null && typeof answer === "object" ? absolutePath(answer.commonDir) : null;
  if (!commonDir || path.basename(commonDir) !== ".git") return { root, mainRoot: root };
  const parent = path.dirname(commonDir);
  return { root, mainRoot: samePath(parent, root) ? root : parent };
}
