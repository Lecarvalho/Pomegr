import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { REPOSITORY as REPO, passingGates, FACTS, createTask, queueTask, updateTask, withDatabase } from "./queue-test-support.mjs";

const actions = { start: true, review: true, sendBack: false, merge: false, writeTasks: false };
const limits = { hours: 1, tasks: 4, tasksAtATime: 3, sendBacks: null, usagePercent: 80 };
function setup(t) {
  const directory = mkdtempSync(path.join(process.cwd(), ".grant-test-"));
  const clock = { now: 1700000000000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const set = (settings, repo = REPO) => store.apply(repo, "aril_settings_set", { settings });
  const start = (repo = REPO) => store.apply(repo, "grant_start", {});
  const ready = (text = "task", repo = REPO) => {
    createTask(store, repo, { text });
    const id = `T-${Math.max(...store.readBoard(repo).tasks.map((task) => Number(task.id.slice(2))))}`;
    queueTask(store, id, repo);
    return id;
  };
  const next = (resolveGateFacts = passingGates) => store.nextGrantSteps({ resolveGateFacts, resolveUsage: () => 10 });
  const configure = (settings = {}, repo = REPO) => assert.equal(set({ actions, limits, workRules: [{ kind: "text", value: "task" }], ...settings }, repo).ok, true);
  return { store, directory, clock, set, start, ready, next, configure };
}
const step = (taskId, kind = "start", repositoryId = REPO) => ({ repositoryId, taskId, kind,
  ...(kind === "review" ? { run: { provider: "claude", model: null, effort: null } } : {}) });
const error = (answer, code) => assert.deepEqual(answer, { ok: false, error: code });

const plan = "docs/plans/next.md";
const writing = { actions: { ...actions, writeTasks: true }, workRules: [{ kind: "plan", value: plan }] };
const write = (f, tasks = [{ text: "Written work" }], source = plan) => f.store.writeGrantTasks(REPO, { plan: source, tasks });
const writeStep = { repositoryId: REPO, kind: "write_tasks", plans: [plan] };

test("writing requires both a named plan and start permission; plan rules select no existing task", (t) => {
  const f = setup(t);
  f.configure({ actions: writing.actions }); error(f.start(), "not_ready");
  f.configure({ ...writing, actions: { ...writing.actions, start: false } }); error(f.start(), "not_ready");
  f.ready(plan);
  f.configure(writing); assert.equal(f.start().ok, true);
  assert.deepEqual(f.next().steps, [writeStep]);
  error(f.store.planStart(REPO, { id: "T-1", grant: true }, () => FACTS, passingGates), "not_startable");
});

test("writing snapshots plans, creates Ready tasks with dependencies, metadata, logs and a separate count", (t) => {
  const f = setup(t); f.ready("Owner work"); f.configure(writing); f.start();
  f.set({ workRules: [{ kind: "plan", value: "other.md" }], actions });
  assert.deepEqual(f.next().steps, [writeStep]);
  error(write(f, [{ text: "wrong source" }], "other.md"), "not_allowed");
  assert.deepEqual(write(f, [{ text: " first ", completeWhen: { own: "proved", checks: ["ci_passed"] }, after: ["T-1"] }, { text: "second", after: ["#1"] }]), { ok: true, taskIds: ["T-2", "T-3"] });
  const board = f.store.readBoard(REPO), ready = board.columns.find((c) => c.name === "Ready").id;
  assert.deepEqual(board.tasks.slice(1).map((task) => [task.columnId, task.position, task.after, task.featureId]), [[ready, 1, ["T-1"], null], [ready, 2, ["T-2"], null]]);
  assert.equal(board.tasks[1].text, "first");
  assert.deepEqual(board.tasks[1].completeWhen, { own: "proved", checks: ["ci_passed"] });
  assert.equal(board.aril.grant.startsUsed, 0);
  withDatabase(f.directory, (db) => {
    const grant = db.prepare("SELECT * FROM aril_grants").get();
    assert.equal(grant.tasks_written, 2);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(`task_grant_written:${REPO}:T-2`).value, String(grant.id));
    assert.deepEqual(db.prepare("SELECT kind FROM task_log WHERE kind = 'grant_task_written'").all().map((row) => row.kind), ["grant_task_written", "grant_task_written"]);
  });
  assert.deepEqual(f.next().steps, [], "written work holds writing while dependencies block it");
  assert.equal(f.store.apply(REPO, "queue_remove", { id: "T-1" }).ok, true);
  assert.equal(f.store.apply(REPO, "move", { id: "T-1", columnId: board.columns.find((c) => c.name === "Done").id, position: 0 }).ok, true);
  assert.deepEqual(f.next().steps, [step("T-2")]);
  assert.equal(f.store.planStart(REPO, { id: "T-2", grant: true }, () => FACTS, passingGates).ok, true);
  f.store.apply(REPO, "grant_stop", {}); f.configure(writing); f.start();
  error(f.store.planStart(REPO, { id: "T-3", grant: true }, () => FACTS, passingGates), "not_startable");
});

test("writing refuses inactive, unallowed, over-cap and malformed batches and rolls back every partial write", (t) => {
  const f = setup(t);
  error(write(f), "not_active");
  f.configure(); f.start(); error(write(f), "not_allowed"); f.store.apply(REPO, "grant_stop", {});
  f.configure(writing); f.start();
  for (const tasks of [[], Array(6).fill({ text: "x" }), null, [{ text: "" }], [{ text: "ok" }, { text: "" }],
    [{ text: "x", run: {} }], [{ text: "x", featureId: null }], [{ text: "x", completeWhen: { checks: ["bogus"] } }],
    [{ text: "x", after: ["#1"] }], [{ text: "x" }, { text: "y", after: ["#2"] }], [{ text: "x", after: ["#0"] }],
    [{ text: "x", after: ["T-99"] }], [{ text: "x", after: null }], [{ text: "x" }, { text: "y", after: ["#1", "#1"] }]]) {
    error(write(f, tasks), "invalid");
    assert.equal(f.store.readBoard(REPO).tasks.length, 0);
    withDatabase(f.directory, (db) => {
      assert.equal(db.prepare("SELECT tasks_written FROM aril_grants WHERE ended_at IS NULL").get().tasks_written, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_log").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'task_grant_written:%'").get().n, 0);
    });
  }
  error(f.store.writeGrantTasks(REPO, { plan, tasks: [{ text: "x" }], extra: true }), "invalid");
  assert.deepEqual(write(f, Array(3).fill({ text: "ok" })), { ok: true, taskIds: ["T-1", "T-2", "T-3"] });
  error(write(f, Array(2).fill({ text: "over cap" })), "limit");
  assert.deepEqual(write(f), { ok: true, taskIds: ["T-4"] });
  error(write(f), "limit");
  f.clock.now += 3600000; error(write(f), "not_active");
});

test("write steps are spaced strictly beyond ten minutes, persisted and reset for a new grant", (t) => {
  const f = setup(t); f.configure(writing); f.start();
  assert.deepEqual(f.next().steps, [writeStep]);
  assert.deepEqual(f.next().steps, []);
  f.clock.now += 600000; assert.deepEqual(f.next().steps, []);
  f.clock.now++; assert.deepEqual(f.next().steps, [writeStep]);
  const reopened = openTaskStore({ directory: f.directory, now: () => f.clock.now });
  try { assert.deepEqual(reopened.nextGrantSteps().steps, []); } finally { reopened.close(); }
  f.store.apply(REPO, "grant_stop", {}); f.start(); assert.deepEqual(f.next().steps, [writeStep]);
});

test("write steps require idle selected work and remaining writing allowance, without consuming concurrency", (t) => {
  const f = setup(t); f.ready();
  f.configure({ ...writing, workRules: [...writing.workRules, { kind: "text", value: "task" }] }); f.start();
  assert.deepEqual(f.next().steps, [step("T-1")]);
  updateTask(f.directory, 1, { state: "needs_review", session_id: "codex:builder" });
  assert.equal(f.next().steps.some((s) => s.kind === "write_tasks"), false);
  updateTask(f.directory, 1, { state: "not_queued", session_id: "codex:builder" });
  assert.equal(f.next().steps.some((s) => s.kind === "write_tasks"), false);
  f.set({ workRules: [] });
  assert.deepEqual(f.next().steps, [writeStep], "unselected in-flight work does not block writing");
  f.clock.now += 600001;
  withDatabase(f.directory, (db) => db.prepare("UPDATE aril_grants SET tasks_written = 4").run());
  assert.deepEqual(f.next().steps, []);
});

test("existing grants migrate tasks_written once without changing their authority", (t) => {
  const f = setup(t); f.configure(); f.start();
  withDatabase(f.directory, (db) => db.exec("ALTER TABLE aril_grants DROP COLUMN tasks_written"));
  const reopened = openTaskStore({ directory: f.directory, now: () => f.clock.now });
  try {
    assert.equal(reopened.readBoard(REPO).aril.grant.active, true);
    withDatabase(f.directory, (db) => assert.equal(db.prepare("SELECT tasks_written FROM aril_grants").get().tasks_written, 0));
  } finally { reopened.close(); }
});

test("a selected card in Review holds writing even before a builder is linked", (t) => {
  const f = setup(t); f.configure(writing); f.start(); write(f);
  const review = f.store.readBoard(REPO).columns.find((column) => column.name === "Review");
  assert.equal(f.store.apply(REPO, "move", { id: "T-1", columnId: review.id, position: 0 }).ok, true);
  assert.deepEqual(f.next().steps, []);
});

test("written tasks keep grant selection for reviews, send-back and merge", (t) => {
  const f = setup(t);
  f.configure({ ...writing, actions: { ...writing.actions, sendBack: true, merge: true }, mergeMode: "direct", limits: { ...limits, sendBacks: 1 } }); f.start(); write(f);
  updateTask(f.directory, 1, { state: "needs_review", session_id: "codex:builder-1", report_at: f.clock.now, report_results: "[]" });
  assert.deepEqual(f.next().steps, [step("T-1", "review")]);
  failedReview(f);
  assert.deepEqual(f.next().steps, [step("T-1", "send_back")]);
  assert.equal(f.store.sendBackGrant(REPO, { taskId: "T-1" }).ok, true);
  f.clock.now++; failedReview(f, 1, "pass");
  const headOid = "a".repeat(40), resolvePullRequestFacts = () => ({ number: 42, state: "open", checks: "passed", headOid });
  assert.deepEqual(f.store.nextGrantSteps({ resolvePullRequestFacts }).steps, [{ repositoryId: REPO, taskId: "T-1", kind: "merge", pullRequest: 42, headOid, mergeMethod: null, mergeMode: "direct" }]);
  assert.equal(f.store.attemptGrantMerge(REPO, { taskId: "T-1", headOid }, resolvePullRequestFacts).ok, true);
});

test("five-task batches resolve earlier references and a log failure rolls the entire batch back", (t) => {
  const f = setup(t); f.configure({ ...writing, limits: { ...limits, tasks: 5 } }); f.start();
  const tasks = Array.from({ length: 5 }, (_, index) => ({ text: `work ${index}`, after: index ? [`#${index}`] : [] }));
  withDatabase(f.directory, (db) => db.exec("CREATE TRIGGER refuse_write BEFORE INSERT ON task_log WHEN NEW.number = 2 BEGIN SELECT RAISE(ABORT, 'synthetic'); END"));
  error(write(f, tasks), "invalid");
  assert.equal(f.store.readBoard(REPO).tasks.length, 0);
  withDatabase(f.directory, (db) => {
    assert.equal(db.prepare("SELECT tasks_written FROM aril_grants").get().tasks_written, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_log").get().n, 0);
    db.exec("DROP TRIGGER refuse_write");
  });
  assert.deepEqual(write(f, tasks), { ok: true, taskIds: ["T-1", "T-2", "T-3", "T-4", "T-5"] });
  assert.deepEqual(f.store.readBoard(REPO).tasks.map((task) => task.after ?? []), [[], ["T-1"], ["T-2"], ["T-3"], ["T-4"]]);
});

function failedReview({ directory, clock }, number = 1, verdict = "fail", at = clock.now) {
  updateTask(directory, number, { state: "needs_review", session_id: `codex:builder-${number}`, report_at: clock.now, report_results: "[]" });
  withDatabase(directory, (db) => {
    db.prepare("UPDATE tasks SET column_id = (SELECT id FROM columns WHERE repository_id = ? AND name = 'Review') WHERE repository_id = ? AND number = ?").run(REPO, REPO, number);
    db.prepare("INSERT INTO task_events(repository_id, number, kind, at, session_id) VALUES (?, ?, 'review', ?, ?)").run(REPO, number, clock.now, `codex:builder-${number}`);
    db.prepare("INSERT INTO task_reviews(repository_id, number, session_id, at, verdict, reasons) VALUES (?, ?, ?, ?, ?, ?)")
      .run(REPO, number, `codex:reviewer-${number}`, at, verdict, verdict === "fail" ? JSON.stringify(["Missing proof", "Fix the regression"]) : null);
  });
}
