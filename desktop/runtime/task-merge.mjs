import { isBranchName } from "../../shared/git-branch-name.mjs";
import { commandFailure, createRepositoryGithub, ghCommand } from "./repository-github.mjs";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const OID = /^[a-f0-9]{40}$/u;
const METHODS = new Set(["squash", "merge", "rebase"]);
const MODES = new Set(["direct", "auto"]);
const NAME_WITH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;

function validStep(step) {
  return step && typeof step === "object" && !Array.isArray(step)
    && REPOSITORY_ID.test(step.repositoryId) && TASK_ID.test(step.taskId) && step.kind === "merge"
    && Number.isSafeInteger(step.pullRequest) && step.pullRequest > 0 && OID.test(step.headOid)
    && (step.mergeMethod === null || METHODS.has(step.mergeMethod)) && MODES.has(step.mergeMode);
}

function validDelete(step) {
  return step && typeof step === "object" && !Array.isArray(step)
    && REPOSITORY_ID.test(step.repositoryId) && TASK_ID.test(step.taskId) && step.kind === "delete_branch"
    && Number.isSafeInteger(step.pullRequest) && step.pullRequest > 0 && isBranchName(step.branch);
}

/** Executes one already-selected grant merge or branch delete and sends only its fixed outcome to the monitor. */
export function createTaskMerge(options = {}) {
  const post = options.post;
  const execFile = options.execFile;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 30_000;
  const github = options.github ?? createRepositoryGithub({ execFile, timeoutMs });
  const gh = (args, root) => ghCommand(execFile, args, root, timeoutMs);

  async function root(repositoryId) {
    const answer = await post("worktree-root", { repositoryId, payload: {} });
    return answer?.ok === true && typeof answer.root === "string" ? answer.root : null;
  }

  // The method the step names, or the one method the repository allows.
  const soleMethod = (facts) => {
    const allowed = [["squashMergeAllowed", "squash"], ["mergeCommitAllowed", "merge"], ["rebaseMergeAllowed", "rebase"]].filter(([key]) => facts[key] === true);
    return allowed.length === 1 ? allowed[0][1] : null;
  };

  // After an auto-merge request: merged now, waiting on the repository's own rules or merge queue, or not confirmed.
  async function afterAuto(step, folder) {
    const result = await gh(["pr", "view", String(step.pullRequest), "--json", "state,autoMergeRequest,isInMergeQueue"], folder);
    let view = null;
    if (!result.error) try { view = JSON.parse(result.stdout); } catch { /* unconfirmed */ }
    if (view?.state === "MERGED") return "merged";
    return view?.state === "OPEN" && (view.autoMergeRequest != null || view.isInMergeQueue === true) ? "auto_enabled" : "failed";
  }

  async function merge(step, isAuthorized) {
    if (!validStep(step) || typeof post !== "function" || typeof isAuthorized !== "function") return { outcome: "refused" };
    const { repositoryId, taskId, headOid } = step;
    let attempt;
    try { attempt = await post("grant-merge-attempt", { repositoryId, taskId, headOid }); } catch { return { outcome: "refused" }; }
    if (attempt?.ok !== true || attempt.pullRequest !== step.pullRequest) return { outcome: "refused" };

    let outcome = "refused";
    try {
      const folder = await root(repositoryId);
      if (folder) {
        let method = step.mergeMethod;
        if (method === null || step.mergeMode === "auto") {
          if (await isAuthorized() !== true) throw new Error("refused");
          const facts = await github.read(repositoryId, folder);
          if (method === null && facts) method = soleMethod(facts);
          // The repository must allow auto-merge; GitHub then merges when its own rules do.
          if (step.mergeMode === "auto" && facts?.autoMergeAllowed !== true) method = null;
        }
        if (method && METHODS.has(method) && await isAuthorized() === true) {
          const result = await gh(["pr", "merge", String(step.pullRequest), `--${method}`, ...(step.mergeMode === "auto" ? ["--auto"] : []), "--match-head-commit", headOid], folder);
          if (result.error) outcome = commandFailure(result.error);
          else outcome = step.mergeMode === "auto" ? await afterAuto(step, folder) : "merged";
        }
      }
    } catch (error) {
      outcome = error?.message === "refused" ? "refused" : "failed";
    }
    try { await post("grant-merge-result", { repositoryId, taskId, headOid, outcome }); } catch { /* best effort */ }
    return { outcome };
  }

  /** Deletes a merged task's head branch from this repository, never its default branch. A stopped grant does nothing and records nothing. */
  async function deleteBranch(step, isAuthorized) {
    if (!validDelete(step) || typeof post !== "function" || typeof isAuthorized !== "function") return { outcome: "refused" };
    const { repositoryId, taskId, branch } = step;
    let outcome = "refused";
    try {
      const folder = await root(repositoryId);
      if (folder) {
        if (await isAuthorized() !== true) return { outcome: "skipped" };
        const facts = await github.read(repositoryId, folder);
        if (facts?.defaultBranch && facts.defaultBranch !== branch) {
          if (await isAuthorized() !== true) return { outcome: "skipped" };
          const named = await gh(["repo", "view", "--json", "nameWithOwner"], folder);
          let nameWithOwner = null;
          if (!named.error) try { nameWithOwner = JSON.parse(named.stdout)?.nameWithOwner; } catch { /* unknown */ }
          if (typeof nameWithOwner === "string" && NAME_WITH_OWNER.test(nameWithOwner)) {
            if (await isAuthorized() !== true) return { outcome: "skipped" };
            const result = await gh(["api", "-X", "DELETE", `repos/${nameWithOwner}/git/refs/heads/${branch}`], folder);
            if (!result.error) outcome = "deleted";
          }
        }
      }
    } catch { outcome = "refused"; }
    try { await post("grant-branch-result", { repositoryId, taskId, outcome }); } catch { /* best effort */ }
    return { outcome };
  }

  return Object.freeze({ merge, deleteBranch });
}
