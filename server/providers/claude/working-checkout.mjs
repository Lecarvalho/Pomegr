import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toolWorkKind } from "../../normalize/work-kind.mjs";

const GIT_WORK_KINDS = new Set(["git", "git_push", "pull_request"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const MAX_DIRECTORIES = 8;
const MAX_DIRECTORY_LENGTH = 1_024;
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const ARGUMENT = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))`;
// Only a directory change that opens the command names where its Git commands ran.
const LEADING_DIRECTORY_CHANGE = new RegExp(String.raw`^\s*(?:cd|pushd|set-location)\s+(?:-(?:literalpath|path)\s+)?${ARGUMENT}\s*(?:&&|;|\r?\n)`, "iu");
const GIT_DIRECTORY_OPTION = new RegExp(String.raw`(?<![\w./\\'"-])git(?:\.exe)?\s+-C\s+${ARGUMENT}`, "u");
// A variable, substitution, home shorthand, or wildcard is never expanded here.
const UNEXPANDED = /[\u0000-\u001f\u007f$`~*?%<>|]/u;

function namedDirectory(command) {
  const match = LEADING_DIRECTORY_CHANGE.exec(command) || GIT_DIRECTORY_OPTION.exec(command);
  return match ? match[1] || match[2] || match[3] : null;
}

function absoluteDirectory(named, cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || UNEXPANDED.test(cwd)) return null;
  if (named === null) return path.resolve(cwd);
  if (named.length > MAX_DIRECTORY_LENGTH || UNEXPANDED.test(named)) return null;
  // Git Bash on Windows writes drive C as /c.
  const drive = process.platform === "win32" ? /^\/([A-Za-z])(?:\/(.*))?$/u.exec(named) : null;
  const directory = path.resolve(cwd, drive ? `${drive[1]}:\\${drive[2] || ""}` : named);
  return directory.length <= MAX_DIRECTORY_LENGTH ? directory : null;
}

function sameDirectory(left, right) {
  const a = path.resolve(left); const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The directories this session's own Git shell commands ran in, oldest use first and the latest last.
 * @param {Array<any>} records
 * @returns {string[]}
 */
export function claudeGitCommandDirectories(records) {
  const directories = new Map();
  let cwd = null;
  for (const record of Array.isArray(records) ? records : []) {
    if (typeof record?.cwd === "string") cwd = record.cwd;
    if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) continue;
    for (const content of record.message.content) {
      if (content?.type !== "tool_use" || !SHELL_TOOLS.has(String(content.name || "").toLowerCase())) continue;
      const command = content.input?.command;
      if (typeof command !== "string" || !GIT_WORK_KINDS.has(toolWorkKind(content.name, { input: content.input }))) continue;
      const directory = absoluteDirectory(namedDirectory(command), cwd);
      if (!directory) continue;
      const key = process.platform === "win32" ? directory.toLowerCase() : directory;
      directories.delete(key);
      directories.set(key, directory);
    }
  }
  return [...directories.values()].slice(-MAX_DIRECTORIES);
}

async function resolveCheckout(directory, resolveRepository) {
  let canonical;
  try {
    if (!fs.statSync(directory).isDirectory()) return null;
    canonical = fs.realpathSync.native(directory);
  } catch { return null; }
  let resolved;
  try { resolved = await resolveRepository(canonical, { requireGit: true }); } catch { return null; }
  return resolved && resolved.recognized === true && REPOSITORY_ID.test(resolved.repositoryId || "")
    && typeof resolved.root === "string" && path.isAbsolute(resolved.root) ? resolved : null;
}

/**
 * The checkout a session works in when it is another checkout of the launch repository than the launch one.
 * `attribution` is null when the latest Git command ran in the launch checkout or its directory gives no Git answer.
 * The transcript records the launch checkout's branch, so the other checkout is read on the branch it has.
 * @param {{ launchCwd?: string, directories?: string[], resolveRepository?: ((cwd: string, options?: { requireGit?: boolean }) => any) | null }} [input]
 * @returns {Promise<{ launchRoot: string, roots: string[], attribution: { state: "single", repositoryId: string, root: string, fingerprint: string, recordedBranch: null, anyBranch: true } | null } | null>}
 */
export async function resolveClaudeWorkingCheckout({ launchCwd, directories, resolveRepository } = {}) {
  if (typeof resolveRepository !== "function" || !Array.isArray(directories) || !directories.length
    || typeof launchCwd !== "string" || !path.isAbsolute(launchCwd)) return null;
  const launch = await resolveCheckout(launchCwd, resolveRepository);
  if (!launch) return null;
  const roots = [];
  let attribution = null;
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const resolved = await resolveCheckout(directories[index], resolveRepository);
    if (!resolved || resolved.repositoryId !== launch.repositoryId || sameDirectory(resolved.root, launch.root)) continue;
    if (!roots.some((root) => sameDirectory(root, resolved.root))) roots.push(resolved.root);
    if (index !== directories.length - 1) continue;
    attribution = {
      state: /** @type {const} */ ("single"), repositoryId: resolved.repositoryId, root: resolved.root,
      fingerprint: createHash("sha256").update(resolved.root).digest("hex").slice(0, 32),
      recordedBranch: null, anyBranch: /** @type {const} */ (true),
    };
  }
  return { launchRoot: launch.root, roots, attribution };
}

/** Moves a target inside another checkout of the launch repository to the same file of the launch checkout. */
export function rebaseCheckoutTarget(target, checkouts) {
  if (typeof target !== "string" || !path.isAbsolute(target) || !checkouts?.roots?.length) return target;
  for (const root of checkouts.roots) {
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return path.join(checkouts.launchRoot, relative);
  }
  return target;
}
