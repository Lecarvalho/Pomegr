import { statSync } from "node:fs";
import path from "node:path";

import { runExecFile } from "../normalize/exec-file-runner.mjs";

const GIT_OPTIONS = Object.freeze({ windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 });

function absolutePath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && path.isAbsolute(text) && !/[\u0000-\u001f\u007f]/u.test(text) ? path.resolve(text) : null;
}

function samePath(left, right) {
  const a = path.resolve(left); const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Git's answer that an existing folder is no checkout it can use. It is an answer, unlike a missing folder, a timeout,
// or a Git that cannot run, which are no answer (null).
export const GIT_NOT_A_REPOSITORY = Object.freeze({ root: null, commonDir: null, notRepository: true });

const NOT_A_REPOSITORY = Symbol("not a repository");

// Git exits 128 when it refuses the folder; a folder that is gone makes it exit 128 too, so the folder must exist.
function refusedFolder(cwd, error) {
  if (error?.code !== 128 || error.killed) return null;
  try { return statSync(cwd).isDirectory() ? NOT_A_REPOSITORY : null; } catch { return null; }
}

function revParse(cwd, args) {
  return new Promise((resolve) => {
    runExecFile("git", ["-C", cwd, "rev-parse", ...args], GIT_OPTIONS, (error, stdout) => resolve(error ? refusedFolder(cwd, error) : String(stdout || "")));
  });
}

/** @param {string} cwd @returns {Promise<{ root: string, commonDir: string | null } | typeof GIT_NOT_A_REPOSITORY | null>} */
export async function readGitCheckout(cwd) {
  const [toplevel, directories] = await Promise.all([
    revParse(cwd, ["--show-toplevel"]),
    revParse(cwd, ["--path-format=absolute", "--git-dir", "--git-common-dir"]),
  ]);
  if (toplevel === NOT_A_REPOSITORY) return GIT_NOT_A_REPOSITORY;
  const root = absolutePath(toplevel);
  if (!root) return null;
  const [gitDir, commonDir] = String(typeof directories === "string" ? directories : "").split(/\r?\n/u).map(absolutePath);
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

/**
 * The main root a Pomegr task worktree inside its repository names: `<main root>/.pomegr/worktrees/<task ID>`.
 * @param {string} cwd @returns {string | null}
 */
export function taskWorktreeMainRoot(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const resolved = path.resolve(cwd);
  const segments = resolved.split(/[\\/]+/u);
  for (let index = 1; index + 2 < segments.length; index += 1) {
    if (segments[index] === ".pomegr" && segments[index + 1] === "worktrees" && isTaskId(segments[index + 2])) {
      let root = resolved;
      for (let up = segments.length - index; up > 0; up -= 1) root = path.dirname(root);
      return root;
    }
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
