// The done-when rule: which checked conditions pass, judged from plain repository facts the entry
// point read from committed observation. This module is pure. It reads no store, route, runtime, Git,
// or provider data, and it keeps nothing: its only output is one `{ check, passed }` per check.
//
// A fact that is unknown is never a pass. Every fact is validated here, so the rule does not trust its
// caller: a value of the wrong type counts as unknown.
//
// A fact also has an age. `facts.readAt` holds the time each fact was read and `facts.workAt` the time of the
// latest work that could have changed it (epoch milliseconds). A fact passes only when its read time is a finite
// number and is not earlier than its work time. A null work time means no relevant work is recorded; a work
// time that is not a finite number (a task still running is `Infinity`) or is missing leaves the fact unknown.

import { TASK_CHECKS } from "./task-record.mjs";

/** Pull-request states a fact may list for the task branch. */
export const TASK_PULL_REQUEST_STATES = Object.freeze(["open", "merged", "closed"]);

// The states of the task branch's pull requests. An empty list is a known absence; a missing or malformed list is unknown.
const pullRequestStates = (facts) => (Array.isArray(facts.pullRequestStates)
  && facts.pullRequestStates.every((state) => TASK_PULL_REQUEST_STATES.includes(state)) ? facts.pullRequestStates : []);

// Each rule returns true only for a known passing value. `read` and `work` name the entries of `readAt` and `workAt`
// that date the fact: the tree and the repository (branch comparison and pull requests) change with different work.
const RULES = Object.freeze({
  pr_open: { read: "pullRequests", work: "repository", value: (facts) => pullRequestStates(facts).includes("open") },
  tree_clean: { read: "tree", work: "tree", value: (facts) => facts.treeClean === true },
  // The task branch is not the main branch and holds a commit of its own, merged since or not.
  commit_on_branch: { read: "branch", work: "repository", value: (facts) => facts.branchCommits === true },
  pr_merged: { read: "pullRequests", work: "repository", value: (facts) => pullRequestStates(facts).includes("merged") },
  // The checks of the task branch's pull request all passed. Pending, failed, no check, and unknown are not a pass.
  ci_passed: { read: "ci", work: "repository", value: (facts) => facts.ciPassed === true },
});

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// True only when the fact was read at a known time that is not before the latest work that could have changed it.
function readAfterWork(facts, { read, work }) {
  const readAt = isRecord(facts.readAt) ? facts.readAt[read] : undefined;
  if (!Number.isFinite(readAt)) return false;
  const workAt = isRecord(facts.workAt) ? facts.workAt[work] : undefined;
  if (workAt === null) return true;
  return Number.isFinite(workAt) && readAt >= workAt;
}

/**
 * `checks` is the task's checked conditions; `facts` is
 * `{ treeClean, branchCommits, pullRequestStates, ciPassed, readAt, workAt }`, each value null when unknown,
 * `readAt` the read times `{ tree, branch, pullRequests, ci }` and `workAt` the work times `{ tree, repository }`.
 * Returns one `{ check, passed }` per distinct recognized check, in the contract's check order. Missing or
 * malformed facts, and facts read before the work they judge, pass nothing.
 */
export function verifyChecks(checks, facts) {
  const requested = new Set(Array.isArray(checks) ? checks : []);
  const known = isRecord(facts) ? facts : {};
  return TASK_CHECKS.filter((check) => requested.has(check)).map((check) => {
    const rule = RULES[check];
    return { check, passed: rule.value(known) === true && readAfterWork(known, rule) };
  });
}

/** True when every result passed; an empty list passes, so a task with no checked condition completes on the report alone. */
export function allChecksPassed(results) {
  return Array.isArray(results) && results.every((result) => result?.passed === true);
}
