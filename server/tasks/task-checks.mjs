// The done-when rule: which checked conditions pass, judged from plain repository facts the entry
// point read from committed observation. This module is pure. It reads no store, route, runtime, Git,
// or provider data, and it keeps nothing: its only output is one `{ check, passed }` per check.
//
// A fact that is unknown is never a pass. Every fact is validated here, so the rule does not trust its
// caller: a value of the wrong type counts as unknown.

import { TASK_CHECKS } from "./task-record.mjs";

/** Pull-request states a fact may list for the task branch. */
export const TASK_PULL_REQUEST_STATES = Object.freeze(["open", "merged", "closed"]);

// The states of the task branch's pull requests. An empty list is a known absence; a missing or malformed list is unknown.
const pullRequestStates = (facts) => (Array.isArray(facts.pullRequestStates)
  && facts.pullRequestStates.every((state) => TASK_PULL_REQUEST_STATES.includes(state)) ? facts.pullRequestStates : []);

// Each rule returns true only for a known passing fact.
const RULES = Object.freeze({
  pr_open: (facts) => pullRequestStates(facts).includes("open"),
  tree_clean: (facts) => facts.treeClean === true,
  // The task branch is not the main branch and holds a commit of its own, merged since or not.
  commit_on_branch: (facts) => facts.branchCommits === true,
  pr_merged: (facts) => pullRequestStates(facts).includes("merged"),
  // The source of pull-request check state arrives with the CI part; until then the fact is always unknown.
  ci_passed: (facts) => facts.ciPassed === true,
});

/**
 * `checks` is the task's checked conditions; `facts` is
 * `{ treeClean, branchCommits, pullRequestStates, ciPassed }`, each null when unknown. Returns one
 * `{ check, passed }` per distinct recognized check, in the contract's check order. Missing or malformed
 * facts pass nothing.
 */
export function verifyChecks(checks, facts) {
  const requested = new Set(Array.isArray(checks) ? checks : []);
  const known = facts !== null && typeof facts === "object" && !Array.isArray(facts) ? facts : {};
  return TASK_CHECKS.filter((check) => requested.has(check)).map((check) => ({ check, passed: RULES[check](known) === true }));
}

/** True when every result passed; an empty list passes, so a task with no checked condition completes on the report alone. */
export function allChecksPassed(results) {
  return Array.isArray(results) && results.every((result) => result?.passed === true);
}
