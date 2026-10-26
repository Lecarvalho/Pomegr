
import { TASK_CHECKS } from "./task-record.mjs";

// `unknown` names a listed pull request whose state the read did not establish.
export const TASK_PULL_REQUEST_STATES = Object.freeze(["open", "merged", "closed", "unknown"]);

const known = (value) => (typeof value === "boolean" ? value : null);

// A listed pull request in a wanted state holds; one of unknown state leaves the answer unknown.
function pullRequestIn(facts, ...wanted) {
  const states = facts.pullRequestStates;
  if (!Array.isArray(states) || !states.every((state) => TASK_PULL_REQUEST_STATES.includes(state))) return null;
  if (states.some((state) => wanted.includes(state))) return true;
  return states.includes("unknown") ? null : false;
}

// Each rule returns true for a known passing value, false for a known failing one, and null for an unknown one.
// A pull request's state has no `work`: it is the state the Repository tab lists, as of its dated read.
const RULES = Object.freeze({
  // A merged pull request was opened, so it still meets the condition; one closed without merging does not (task T-179).
  pr_open: { read: "pullRequests", work: null, value: (facts) => pullRequestIn(facts, "open", "merged") },
  tree_clean: { read: "tree", work: "tree", value: (facts) => known(facts.treeClean) },
  // The task branch is not the main branch and holds a commit of its own, merged since or not.
  commit_on_branch: { read: "branch", work: "repository", value: (facts) => known(facts.branchCommits) },
  pr_merged: { read: "pullRequests", work: null, value: (facts) => pullRequestIn(facts, "merged") },
  // The checks of the task branch's pull request all passed.
  ci_passed: { read: "ci", work: "repository", value: (facts) => known(facts.ciPassed) },
});

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function readAfterWork(facts, { read, work }) {
  const readAt = isRecord(facts.readAt) ? facts.readAt[read] : undefined;
  if (!Number.isFinite(readAt)) return false;
  if (read === "ci" && facts.ciRevisionVerified === true) return true;
  if (work === null) return true;
  const workAt = isRecord(facts.workAt) ? facts.workAt[work] : undefined;
  if (workAt === null) return true;
  return Number.isFinite(workAt) && readAt >= workAt;
}

// A check with no rule (`user_validated`) is judged by the agent, like the own condition: it gets no result.
// A condition passed or failed only on a dated reading of it. Without one the result is `unavailable`:
// Pomegr could not verify the condition, which says nothing about whether it holds.
export function verifyChecks(checks, facts) {
  const requested = new Set(Array.isArray(checks) ? checks : []);
  const held = isRecord(facts) ? facts : {};
  return TASK_CHECKS.filter((check) => requested.has(check) && Object.hasOwn(RULES, check)).map((check) => {
    const rule = RULES[check];
    const value = readAfterWork(held, rule) ? rule.value(held) : null;
    return value === null ? { check, passed: false, unavailable: true } : { check, passed: value };
  });
}

// The board's reading of a waiting task says only whether a condition holds now.
export function readChecks(checks, facts) {
  return verifyChecks(checks, facts).map((result) => ({ check: result.check, passed: result.passed }));
}

export function allChecksPassed(results) {
  return Array.isArray(results) && results.every((result) => result?.passed === true);
}
