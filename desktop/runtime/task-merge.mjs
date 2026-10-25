import { execFile as defaultExecFile } from "node:child_process";
import { userSessionEnvironment } from "./environment-policy.mjs";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const OID = /^[a-f0-9]{40}$/u;
const METHODS = new Set(["squash", "merge", "rebase"]);

function validStep(step) {
  return step && typeof step === "object" && !Array.isArray(step)
    && REPOSITORY_ID.test(step.repositoryId) && TASK_ID.test(step.taskId) && step.kind === "merge"
    && Number.isSafeInteger(step.pullRequest) && step.pullRequest > 0 && OID.test(step.headOid)
    && (step.mergeMethod === null || METHODS.has(step.mergeMethod));
}

function command(execFile, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile("gh", args, {
      cwd, timeout: timeoutMs, windowsHide: true, shell: false, encoding: "utf8", maxBuffer: 64 * 1024,
      // The user's own gh login, without this app's runtime variables or tokens.
      env: { ...userSessionEnvironment(process.env), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => {
      resolve({ error, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}

function commandFailure(error) {
  if (error?.killed === true || error?.code === "ETIMEDOUT") return "failed";
  return Number.isInteger(error?.code) && error.code !== 0 ? "refused" : "failed";
}

/** Executes one already-selected grant merge and sends only its fixed outcome to the monitor. */
export function createTaskMerge(options = {}) {
  const post = options.post;
  const execFile = options.execFile ?? defaultExecFile;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 30_000;

  async function merge(step, isAuthorized) {
    if (!validStep(step) || typeof post !== "function" || typeof isAuthorized !== "function") return { outcome: "refused" };
    const { repositoryId, taskId, headOid } = step;
    let attempt;
    try { attempt = await post("grant-merge-attempt", { repositoryId, taskId, headOid }); } catch { return { outcome: "refused" }; }
    if (attempt?.ok !== true || attempt.pullRequest !== step.pullRequest) return { outcome: "refused" };

    let outcome = "refused";
    try {
      const rootAnswer = await post("worktree-root", { repositoryId, payload: {} });
      const root = rootAnswer?.ok === true && typeof rootAnswer.root === "string" ? rootAnswer.root : null;
      if (root) {
        let method = step.mergeMethod;
        if (method === null) {
          if (await isAuthorized() !== true) throw new Error("refused");
          const result = await command(execFile, ["repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"], root, timeoutMs);
          if (result.error) outcome = commandFailure(result.error);
          else {
            let allowed;
            try { allowed = JSON.parse(result.stdout); } catch { allowed = null; }
            const fields = ["squashMergeAllowed", "mergeCommitAllowed", "rebaseMergeAllowed"];
            const matches = allowed && fields.every((field) => typeof allowed[field] === "boolean")
              ? [["squashMergeAllowed", "squash"], ["mergeCommitAllowed", "merge"], ["rebaseMergeAllowed", "rebase"]]
                .filter(([key]) => allowed[key] === true).map(([, value]) => value) : [];
            if (matches?.length === 1) method = matches[0];
          }
        }
        if (method && METHODS.has(method) && await isAuthorized() === true) {
          const result = await command(execFile, ["pr", "merge", String(step.pullRequest), `--${method}`, "--match-head-commit", headOid], root, timeoutMs);
          if (!result.error) outcome = "merged";
          else outcome = commandFailure(result.error);
        }
      }
    } catch (error) {
      outcome = error?.message === "refused" ? "refused" : "failed";
    }
    try { await post("grant-merge-result", { repositoryId, taskId, headOid, outcome }); } catch { /* best effort */ }
    return { outcome };
  }

  return Object.freeze({ merge });
}
