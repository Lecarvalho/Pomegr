import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { REPOSITORY as REPO, passingGates, createTask, queueTask, updateTask, withDatabase } from "./queue-test-support.mjs";

// Merge mode, auto-merge outcomes, and the branch delete step of a grant (Aril operator phase 9b).
const HEAD = "a".repeat(40);
const green = { number: 42, state: "open", checks: "passed", headOid: HEAD };
const actions = { start: true, review: true, sendBack: false, merge: false, writeTasks: false };
const limits = { hours: 1, tasks: 4, tasksAtATime: 3, sendBacks: null, usagePercent: 80 };
const error = (answer, code) => assert.deepEqual(answer, { ok: false, error: code });

function setup(t) {
  const directory = mkdtempSync(path.join(process.cwd(), ".grant-test-"));
  const clock = { now: 1700000000000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const set = (settings) => store.apply(REPO, "aril_settings_set", { settings });
  const ready = () => {
    createTask(store, REPO, { text: "task" });
    const id = `T-${Math.max(...store.readBoard(REPO).tasks.map((task) => Number(task.id.slice(2))))}`;
    queueTask(store, id, REPO);
  };
  const configure = (settings = {}) => assert.equal(set({ actions, limits, workRules: [{ kind: "text", value: "task" }], ...settings }).ok, true);
  return { store, directory, clock, set, ready, configure, start: () => store.apply(REPO, "grant_start", {}),
    next: () => store.nextGrantSteps({ resolveGateFacts: passingGates, resolveUsage: () => 10 }) };
}
// A reviewed task in Review, as the grant sees one.
function failedReview({ directory, clock }, number = 1, verdict = "fail") {
  updateTask(directory, number, { state: "needs_review", session_id: `codex:builder-${number}`, report_at: clock.now, report_results: "[]" });
  withDatabase(directory, (db) => {
    db.prepare("UPDATE tasks SET column_id = (SELECT id FROM columns WHERE repository_id = ? AND name = 'Review') WHERE repository_id = ? AND number = ?").run(REPO, REPO, number);
    db.prepare("INSERT INTO task_events(repository_id, number, kind, at, session_id) VALUES (?, ?, 'review', ?, ?)").run(REPO, number, clock.now, `codex:builder-${number}`);
    db.prepare("INSERT INTO task_reviews(repository_id, number, session_id, at, verdict, reasons) VALUES (?, ?, ?, ?, ?, ?)")
      .run(REPO, number, `codex:reviewer-${number}`, clock.now, verdict, verdict === "fail" ? JSON.stringify(["Missing proof"]) : null);
  });
}
const step = (taskId) => ({ repositoryId: REPO, taskId, kind: "start" });
function mergeSetup(t) {
  const context = setup(t);
  const { ready, directory, clock, configure, start, store } = context;
  ready();
  updateTask(directory, 1, { state: "needs_review", session_id: "codex:builder" });
  withDatabase(directory, (db) => {
    db.prepare("INSERT INTO task_events(repository_id, number, kind, at) VALUES (?, 1, 'review', ?)").run(REPO, clock.now);
    db.prepare("INSERT INTO task_reviews(repository_id, number, session_id, at, verdict) VALUES (?, 1, 'codex:reviewer', ?, 'pass')").run(REPO, clock.now);
  });
  configure({ actions: { ...actions, start: false, review: false, merge: true }, mergeMode: "direct" });
  assert.equal(start().ok, true);
  const resolvePullRequestFacts = () => green;
  return { ...context, resolvePullRequestFacts,
    nextMerge: (resolver = resolvePullRequestFacts) => store.nextGrantSteps({ resolvePullRequestFacts: resolver }).steps,
    attempt: (headOid = HEAD, resolver = resolvePullRequestFacts) => store.attemptGrantMerge(REPO, { taskId: "T-1", headOid }, resolver) };
}

test("an enabled auto-merge is logged, never marks the head refused, and keeps the task open until the merge is seen", (t) => {
  const { store, attempt, nextMerge, set, directory } = mergeSetup(t);
  set({ mergeMode: "auto" });
  assert.equal(attempt().ok, true);
  assert.deepEqual(store.recordGrantMerge(REPO, { taskId: "T-1", headOid: HEAD, outcome: "auto_enabled" }), { ok: true });
  assert.deepEqual(store.readLog(REPO, { limit: 10 }).entries.map((entry) => entry.kind), ["grant_merge_auto"]);
  const metaKeys = () => withDatabase(directory, (db) => db.prepare("SELECT key FROM meta WHERE key LIKE 'task_merge_refused:%'").all());
  assert.deepEqual(metaKeys(), []);
  assert.deepEqual(nextMerge(), [], "once per head commit");
  assert.equal(store.checkGrant(REPO).active, true);
  assert.equal(store.recordGrantMerge(REPO, { taskId: "T-1", headOid: HEAD, outcome: "refused" }).ok, true);
  assert.equal(metaKeys().length, 1, "a refusal still holds the head");
});

test("an enabled auto-merge keeps the task's slot until the merge is seen", (t) => {
  const f = setup(t); f.ready(); f.ready();
  f.configure({ actions: { ...actions, merge: true }, mergeMode: "auto", limits: { ...limits, tasksAtATime: 1 } }); f.start();
  f.store.recordGrant(REPO, { taskId: "T-1", kind: "start" });
  failedReview(f, 1, "pass");
  assert.equal(f.store.attemptGrantMerge(REPO, { taskId: "T-1", headOid: HEAD }, () => green).ok, true);
  assert.equal(f.store.recordGrantMerge(REPO, { taskId: "T-1", headOid: HEAD, outcome: "auto_enabled" }).ok, true);
  assert.deepEqual(f.next().steps, []);
  withDatabase(f.directory, (db) => db.prepare("INSERT INTO task_log(repository_id, number, kind, at) VALUES (?, 1, 'merged', ?)").run(REPO, f.clock.now));
  assert.deepEqual(f.next().steps, [step("T-2")]);
});

const mergedFacts = { number: 42, state: "merged", checks: "passed", headOid: HEAD, headBranch: "tasks/T-1", baseBranch: "main", sameRepository: true };
test("a branch delete step needs a seen merge, a same-repository head branch, deleteBranch true and merge authority, once per task", (t) => {
  const { store, directory, set, start, nextMerge, clock } = mergeSetup(t);
  const offered = (facts = mergedFacts) => nextMerge(typeof facts === "function" || facts === null ? facts : () => facts).filter((entry) => entry.kind === "delete_branch");
  const expected = { repositoryId: REPO, taskId: "T-1", kind: "delete_branch", pullRequest: 42, branch: "tasks/T-1" };
  const seen = (kind, at = clock.now) => withDatabase(directory, (db) => db.prepare("INSERT INTO task_log(repository_id, number, kind, at) VALUES (?, 1, ?, ?)").run(REPO, kind, at));
  const unseen = () => withDatabase(directory, (db) => db.prepare("DELETE FROM task_log WHERE kind IN ('merged', 'grant_merge')").run());
  set({ deleteBranch: true });
  assert.deepEqual(offered(), [], "no merge has been seen");
  for (const kind of ["merged", "grant_merge"]) { seen(kind); assert.deepEqual(offered(), [expected], kind); unseen(); }
  seen("merged", clock.now - 1); assert.deepEqual(offered(), [], "a merge before the grant started is not this grant's"); unseen();
  seen("merged");
  for (const value of [null, false]) { set({ deleteBranch: value }); assert.deepEqual(offered(), [], `deleteBranch ${value}`); }
  set({ deleteBranch: true });
  for (const change of [{ state: "open" }, { state: "closed" }, { state: null }, { sameRepository: false }, { sameRepository: null }, { sameRepository: undefined },
    { number: null }, { headBranch: null }, { headBranch: "" }, { headBranch: "main" }, { headBranch: "-x" }, { headBranch: "a..b" }, { headBranch: "a b" },
    { headBranch: "x.lock" }, { headBranch: "/x" }, { headBranch: "x/" }, { headBranch: "a//b" }, { headBranch: "a\nb" }, { headBranch: "a".repeat(201) }]) {
    assert.deepEqual(offered({ ...mergedFacts, ...change }), [], JSON.stringify(change));
  }
  assert.deepEqual(offered(null), []);
  assert.deepEqual(offered(() => { throw new Error("private"); }), []);
  set({ workRules: [] }); assert.deepEqual(offered(), []); set({ workRules: [{ kind: "text", value: "task" }] });
  store.apply(REPO, "grant_stop", {}); set({ actions }); start(); assert.deepEqual(offered(), [], "no merge authority");
  store.apply(REPO, "grant_stop", {}); set({ actions: { ...actions, start: false, review: false, merge: true } }); assert.equal(start().ok, true);
  assert.deepEqual(offered(), [expected]);
  const payload = { taskId: "T-1", outcome: "deleted" };
  for (const bad of [{}, { ...payload, outcome: "gone" }, { ...payload, extra: 1 }, { taskId: "bad", outcome: "deleted" }]) error(store.recordGrantBranchDelete(REPO, bad), "invalid");
  error(store.recordGrantBranchDelete(REPO, { ...payload, taskId: "T-9" }), "not_eligible");
  assert.deepEqual(store.recordGrantBranchDelete(REPO, payload), { ok: true });
  assert.deepEqual(offered(), [], "once per task");
  error(store.recordGrantBranchDelete(REPO, { ...payload, outcome: "refused" }), "not_eligible");
  assert.equal(withDatabase(directory, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").get(`task_branch_delete:${REPO}:T-1`).value), "deleted");
  assert.deepEqual(store.readLog(REPO, { limit: 10 }).entries.map((entry) => entry.kind), ["merged", "grant_branch_deleted"]);
});

test("a grant that used its tasks waits up to ten minutes after a merge for a settled branch delete, then ends", (t) => {
  for (const deleteBranch of [true, null]) {
    const f = setup(t); f.ready();
    f.configure({ actions: { ...actions, merge: true }, mergeMode: "direct", deleteBranch, limits: { ...limits, tasks: 1, tasksAtATime: 1 } }); f.start();
    f.store.recordGrant(REPO, { taskId: "T-1", kind: "start" });
    failedReview(f, 1, "pass");
    withDatabase(f.directory, (db) => db.prepare("INSERT INTO task_log(repository_id, number, kind, at) VALUES (?, 1, 'grant_merge', ?)").run(REPO, f.clock.now));
    if (deleteBranch === null) { assert.equal(f.store.checkGrant(REPO).active, false, "nothing to wait for"); continue; }
    assert.deepEqual(f.store.nextGrantSteps({ resolvePullRequestFacts: () => mergedFacts }).steps.map((entry) => entry.kind), ["delete_branch"]);
    f.clock.now += 599_000;
    assert.equal(f.store.checkGrant(REPO).active, true);
    assert.deepEqual(f.store.recordGrantBranchDelete(REPO, { taskId: "T-1", outcome: "deleted" }), { ok: true });
    assert.equal(f.store.checkGrant(REPO).active, false, "settled");
    assert.equal(f.store.readBoard(REPO).aril.grant.endReason, "tasks_used");
    const late = setup(t); late.ready();
    late.configure({ actions: { ...actions, merge: true }, mergeMode: "direct", deleteBranch, limits: { ...limits, tasks: 1, tasksAtATime: 1 } }); late.start();
    late.store.recordGrant(REPO, { taskId: "T-1", kind: "start" });
    failedReview(late, 1, "pass");
    withDatabase(late.directory, (db) => db.prepare("INSERT INTO task_log(repository_id, number, kind, at) VALUES (?, 1, 'merged', ?)").run(REPO, late.clock.now));
    late.clock.now += 599_000; assert.equal(late.store.checkGrant(REPO).active, true);
    late.clock.now += 2_000; assert.equal(late.store.checkGrant(REPO).active, false, "ten minutes after the merge");
  }
});

test("a refused branch delete is logged and not offered again; a delete needs a merge first", (t) => {
  const { store, directory, set, nextMerge, clock } = mergeSetup(t);
  set({ deleteBranch: true });
  error(store.recordGrantBranchDelete(REPO, { taskId: "T-1", outcome: "refused" }), "not_eligible");
  withDatabase(directory, (db) => db.prepare("INSERT INTO task_log(repository_id, number, kind, at) VALUES (?, 1, 'grant_merge', ?)").run(REPO, clock.now));
  assert.deepEqual(store.recordGrantBranchDelete(REPO, { taskId: "T-1", outcome: "refused" }), { ok: true });
  assert.deepEqual(nextMerge(() => mergedFacts), []);
  assert.deepEqual(store.readLog(REPO, { limit: 10 }).entries.map((entry) => entry.kind), ["grant_merge", "grant_branch_delete_refused"]);
});
