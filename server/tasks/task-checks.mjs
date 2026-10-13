
import { TASK_CHECKS } from "./task-record.mjs";

export const TASK_PULL_REQUEST_STATES = Object.freeze(["open", "merged", "closed"]);

const pullRequestStates = (facts) => (Array.isArray(facts.pullRequestStates)
  && facts.pullRequestStates.every((state) => TASK_PULL_REQUEST_STATES.includes(state)) ? facts.pullRequestStates : []);

// Each rule returns true only for a known passing value.
// A pull request's state has no `work`: it is the state the Repository tab lists, as of its dated read.
const RULES = Object.freeze({
  pr_open: { read: "pullRequests", work: null, value: (facts) => pullRequestStates(facts).includes("open") },
  tree_clean: { read: "tree", work: "tree", value: (facts) => facts.treeClean === true },
  // The task branch is not the main branch and holds a commit of its own, merged since or not.
  commit_on_branch: { read: "branch", work: "repository", value: (facts) => facts.branchCommits === true },
  pr_merged: { read: "pullRequests", work: null, value: (facts) => pullRequestStates(facts).includes("merged") },
  // The checks of the task branch's pull request all passed.
  ci_passed: { read: "ci", work: "repository", value: (facts) => facts.ciPassed === true },
});

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function readAfterWork(facts, { read, work }) {
  const readAt = isRecord(facts.readAt) ? facts.readAt[read] : undefined;
  if (!Number.isFinite(readAt)) return false;
  if (work === null) return true;
  const workAt = isRecord(facts.workAt) ? facts.workAt[work] : undefined;
  if (workAt === null) return true;
  return Number.isFinite(workAt) && readAt >= workAt;
}

// A check with no rule (`user_validated`) is judged by the agent, like the own condition: it gets no result.
export function verifyChecks(checks, facts) {
  const requested = new Set(Array.isArray(checks) ? checks : []);
  const known = isRecord(facts) ? facts : {};
  return TASK_CHECKS.filter((check) => requested.has(check) && Object.hasOwn(RULES, check)).map((check) => {
    const rule = RULES[check];
    return { check, passed: rule.value(known) === true && readAfterWork(known, rule) };
  });
}

export function allChecksPassed(results) {
  return Array.isArray(results) && results.every((result) => result?.passed === true);
}
