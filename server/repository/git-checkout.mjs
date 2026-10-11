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

/** @param {string} cwd @returns {Promise<{ root: string, commonDir: string | null } | null>} */
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
const TASK_WORKTREE_DIRECTORY = "task-worktrees";
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const isTaskId = (value) => TASK_ID.test(value);

/** @param {string} cwd @returns {string | null} */
export function taskWorktreeRepositoryId(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const segments = path.resolve(cwd).split(/[\\/]+/u);
  for (let index = 0; index + 2 < segments.length; index += 1) {
    if (segments[index] === TASK_WORKTREE_DIRECTORY && REPOSITORY_ID.test(segments[index + 1]) && isTaskId(segments[index + 2])) return segments[index + 1];
  }
  return null;
}

/** @param {string | { root?: unknown, commonDir?: unknown } | null | undefined} answer @returns {{ root: string, mainRoot: string } | null} */
export function checkoutRoots(answer) {
  const root = typeof answer === "string" ? answer : answer?.root;
  if (typeof root !== "string" || !root || !path.isAbsolute(root)) return null;
  const commonDir = answer !== null && typeof answer === "object" ? absolutePath(answer.commonDir) : null;
  if (!commonDir || path.basename(commonDir) !== ".git") return { root, mainRoot: root };
  const parent = path.dirname(commonDir);
  return { root, mainRoot: samePath(parent, root) ? root : parent };
}
