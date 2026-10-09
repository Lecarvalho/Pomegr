import assert from "node:assert/strict";
import test from "node:test";
import { allChecksPassed, verifyChecks } from "../../../server/tasks/task-checks.mjs";
import { TASK_CHECKS } from "../../../server/tasks/task-record.mjs";

// Every fact was read at 2000, after the latest work (1000), so each known passing value passes.
const READ_AT = Object.freeze({ tree: 2000, branch: 2000, pullRequests: 2000, ci: 2000 });
const WORK_AT = Object.freeze({ tree: 1000, repository: 1000 });
const PASSING = Object.freeze({ treeClean: true, branchCommits: true, pullRequestStates: ["open", "merged"], ciPassed: true, readAt: READ_AT, workAt: WORK_AT });
const passed = (results) => Object.fromEntries(results.map((result) => [result.check, result.passed]));
const only = (check, facts) => passed(verifyChecks([check], facts))[check];

// The entries of `readAt` and `workAt` that date each check.
const DATED_BY = Object.freeze({
  pr_open: { read: "pullRequests", work: "repository" },
  tree_clean: { read: "tree", work: "tree" },
  commit_on_branch: { read: "branch", work: "repository" },
  pr_merged: { read: "pullRequests", work: "repository" },
  ci_passed: { read: "ci", work: "repository" },
});

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
    { treeClean: null, branchCommits: null, pullRequestStates: null, ciPassed: null, readAt: READ_AT, workAt: WORK_AT },
    { treeClean: "true", branchCommits: 1, pullRequestStates: "open", ciPassed: "yes", readAt: READ_AT, workAt: WORK_AT },
    { treeClean: 1, branchCommits: "yes", pullRequestStates: ["open", "draft"], ciPassed: 1, readAt: READ_AT, workAt: WORK_AT },
  ]) {
    const results = verifyChecks(TASK_CHECKS, facts);
    assert.deepEqual(passed(results), nothing, JSON.stringify(facts));
    assert.equal(allChecksPassed(results), false);
  }
});

test("CI passed needs a known passing check status", () => {
  for (const ciPassed of [null, false]) {
    assert.deepEqual(verifyChecks(["ci_passed"], { ...PASSING, pullRequestStates: ["merged"], ciPassed }), [{ check: "ci_passed", passed: false }]);
  }
  assert.deepEqual(verifyChecks(["ci_passed"], { ciPassed: true, readAt: READ_AT, workAt: WORK_AT }), [{ check: "ci_passed", passed: true }]);
});

for (const [check, { read, work }] of Object.entries(DATED_BY)) {
  test(`${check} passes only on a fact read at a known time that is not before the work it judges`, () => {
    const facts = (readAt, workAt) => ({ ...PASSING, readAt: { ...READ_AT, ...readAt }, workAt: { ...WORK_AT, ...workAt } });

    // Fresh: read after the work, and read exactly when the work ended.
    assert.equal(only(check, facts({}, {})), true, "fresh");
    assert.equal(only(check, facts({ [read]: 1000 }, {})), true, "read at the work time");

    // Read before the work: the fact describes a state the work may since have changed.
    assert.equal(only(check, facts({ [read]: 999 }, {})), false, "read before the work");
    assert.equal(only(check, facts({}, { [work]: 2001 })), false, "work after the read");
    assert.equal(only(check, facts({}, { [work]: Number.POSITIVE_INFINITY })), false, "work still running");

    // No read time, or one that is not a finite number: unknown.
    for (const bad of [null, undefined, "2000", Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      assert.equal(only(check, facts({ [read]: bad }, {})), false, `read time ${String(bad)}`);
    }
    for (const readAt of [undefined, null, "2000", [], {}]) {
      assert.equal(only(check, { ...PASSING, readAt }), false, `readAt ${JSON.stringify(readAt)}`);
    }

    // A null work time is no recorded work; a missing or malformed one is unknown.
    assert.equal(only(check, facts({}, { [work]: null })), true, "null work time");
    assert.equal(only(check, { ...PASSING, workAt: { tree: null, repository: null } }), true, "no work recorded");
    for (const bad of [undefined, "1000", Number.NaN, {}, true]) {
      assert.equal(only(check, facts({}, { [work]: bad })), false, `work time ${String(bad)}`);
    }
    for (const workAt of [undefined, "1000", [], 1000]) {
      assert.equal(only(check, { ...PASSING, workAt }), false, `workAt ${JSON.stringify(workAt)}`);
    }

    // A time does not make a failing value pass, and the other entries date only their own checks.
    const failing = { treeClean: false, branchCommits: false, pullRequestStates: [], ciPassed: false };
    assert.equal(only(check, { ...PASSING, ...failing }), false, "failing value");
    for (const other of Object.keys(READ_AT).filter((key) => key !== read)) assert.equal(only(check, facts({ [other]: null }, {})), true, `unrelated read time ${other}`);
    for (const other of Object.keys(WORK_AT).filter((key) => key !== work)) assert.equal(only(check, facts({}, { [other]: Number.POSITIVE_INFINITY })), true, `unrelated work time ${other}`);
  });
}

test("the tree and the repository are dated by different work", () => {
  const facts = { ...PASSING, workAt: { tree: 3000, repository: 1000 } };
  assert.deepEqual(passed(verifyChecks(TASK_CHECKS, facts)), { pr_open: true, tree_clean: false, commit_on_branch: true, pr_merged: true, ci_passed: true });
  const repository = { ...PASSING, workAt: { tree: 1000, repository: 3000 } };
  assert.deepEqual(passed(verifyChecks(TASK_CHECKS, repository)), { pr_open: false, tree_clean: true, commit_on_branch: false, pr_merged: false, ci_passed: false });
  const treeRead = { ...PASSING, readAt: { ...READ_AT, tree: null } };
  assert.deepEqual(passed(verifyChecks(TASK_CHECKS, treeRead)), { pr_open: true, tree_clean: false, commit_on_branch: true, pr_merged: true, ci_passed: true });
});

test("a report with a stale or undated fact does not complete a task", () => {
  assert.equal(allChecksPassed(verifyChecks(TASK_CHECKS, { ...PASSING, readAt: { ...READ_AT, pullRequests: 999 } })), false);
  assert.equal(allChecksPassed(verifyChecks(["tree_clean"], { treeClean: true, branchCommits: true, pullRequestStates: [], ciPassed: true })), false);
});
