import assert from "node:assert/strict";
import test from "node:test";
import { allChecksPassed, verifyChecks } from "../../../server/tasks/task-checks.mjs";
import { TASK_CHECKS } from "../../../server/tasks/task-record.mjs";

const PASSING = { treeClean: true, branchCommits: true, pullRequestStates: ["open", "merged"], ciPassed: true };
const passed = (results) => Object.fromEntries(results.map((result) => [result.check, result.passed]));

test("every check passes on a known passing fact, one result per check in contract order", () => {
  const results = verifyChecks([...TASK_CHECKS].reverse(), PASSING);
  assert.deepEqual(results.map((result) => result.check), [...TASK_CHECKS]);
  assert.ok(results.every((result) => Object.keys(result).join() === "check,passed" && result.passed === true));
  assert.equal(allChecksPassed(results), true);
});

test("only the requested checks are judged, once each, and unknown names are dropped", () => {
  assert.deepEqual(verifyChecks(["tree_clean", "tree_clean", "made_up", 7], PASSING), [{ check: "tree_clean", passed: true }]);
  assert.deepEqual(verifyChecks([], PASSING), []);
  assert.deepEqual(verifyChecks(null, PASSING), []);
  assert.equal(allChecksPassed([]), true);
});

test("each fact decides only its own check", () => {
  assert.deepEqual(passed(verifyChecks(TASK_CHECKS, { ...PASSING, treeClean: false })),
    { pr_open: true, tree_clean: false, commit_on_branch: true, pr_merged: true, ci_passed: true });
  assert.deepEqual(passed(verifyChecks(TASK_CHECKS, { ...PASSING, branchCommits: false })),
    { pr_open: true, tree_clean: true, commit_on_branch: false, pr_merged: true, ci_passed: true });
  assert.deepEqual(passed(verifyChecks(TASK_CHECKS, { ...PASSING, pullRequestStates: ["open"] })),
    { pr_open: true, tree_clean: true, commit_on_branch: true, pr_merged: false, ci_passed: true });
  assert.deepEqual(passed(verifyChecks(TASK_CHECKS, { ...PASSING, pullRequestStates: ["merged", "closed"] })),
    { pr_open: false, tree_clean: true, commit_on_branch: true, pr_merged: true, ci_passed: true });
  assert.deepEqual(passed(verifyChecks(TASK_CHECKS, { ...PASSING, pullRequestStates: [] })).pr_open, false);
});

test("an unknown, missing, or malformed fact is never a pass", () => {
  const nothing = { pr_open: false, tree_clean: false, commit_on_branch: false, pr_merged: false, ci_passed: false };
  for (const facts of [
    null, undefined, [], "facts", 1,
    {},
    { treeClean: null, branchCommits: null, pullRequestStates: null, ciPassed: null },
    { treeClean: "true", branchCommits: 1, pullRequestStates: "open", ciPassed: "yes" },
    { treeClean: 1, branchCommits: "yes", pullRequestStates: ["open", "draft"], ciPassed: 1 },
  ]) {
    const results = verifyChecks(TASK_CHECKS, facts);
    assert.deepEqual(passed(results), nothing, JSON.stringify(facts));
    assert.equal(allChecksPassed(results), false);
  }
});

test("CI passed cannot be confirmed from the facts the monitor commits today", () => {
  assert.deepEqual(verifyChecks(["ci_passed"], { treeClean: true, branchCommits: true, pullRequestStates: ["merged"], ciPassed: null }),
    [{ check: "ci_passed", passed: false }]);
});
