import { execFile as defaultExecFile } from "node:child_process";
import { isBranchName } from "../../shared/git-branch-name.mjs";
import { userSessionEnvironment } from "./environment-policy.mjs";

const FIELDS = "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,autoMergeAllowed,deleteBranchOnMerge,defaultBranchRef";
const FLAGS = ["squashMergeAllowed", "mergeCommitAllowed", "rebaseMergeAllowed", "autoMergeAllowed", "deleteBranchOnMerge"];
const KEEP_MS = 30 * 60_000;
const KEEP_UNKNOWN_MS = 5 * 60_000;

/** Runs one gh command with the user's own gh login, without this app's runtime variables or tokens. */
export function ghCommand(execFile = defaultExecFile, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile("gh", args, {
      cwd, timeout: timeoutMs, windowsHide: true, shell: false, encoding: "utf8", maxBuffer: 64 * 1024,
      env: { ...userSessionEnvironment(process.env), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => resolve({ error, stdout: typeof stdout === "string" ? stdout : "" }));
  });
}

export function commandFailure(error) {
  if (error?.killed === true || error?.code === "ETIMEDOUT") return "failed";
  return Number.isInteger(error?.code) && error.code !== 0 ? "refused" : "failed";
}

function bounded(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { return null; }
  if (value === null || typeof value !== "object" || !FLAGS.every((flag) => typeof value[flag] === "boolean")) return null;
  const name = value.defaultBranchRef?.name;
  return { ...Object.fromEntries(FLAGS.map((flag) => [flag, value[flag]])), defaultBranch: isBranchName(name) ? name : null };
}

/**
 * The repository's own GitHub merge settings and default branch name, read with the user's gh login. Kept in memory for
 * 30 minutes, and a failed read as unknown (null) for 5. Nothing else of the answer is kept or sent.
 */
export function createRepositoryGithub(options = {}) {
  const execFile = options.execFile ?? defaultExecFile;
  const now = options.now ?? Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 15_000;
  const kept = new Map();
  return Object.freeze({
    async read(repositoryId, root) {
      const held = kept.get(repositoryId);
      if (held && held.until > now()) return held.facts;
      const result = await ghCommand(execFile, ["repo", "view", "--json", FIELDS], root, timeoutMs);
      const facts = result.error ? null : bounded(result.stdout);
      kept.set(repositoryId, { facts, until: now() + (facts ? KEEP_MS : KEEP_UNKNOWN_MS) });
      return facts;
    },
  });
}
