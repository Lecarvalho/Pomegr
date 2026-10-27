import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { REPOSITORY as REPO, passingGates, createTask, queueTask, updateTask, withDatabase } from "./queue-test-support.mjs";

// A grant marks a merged task Done when the acceptance settled with the owner passes (T-182).
const actions = { start: false, review: true, sendBack: false, merge: false, writeTasks: false, markDone: true };
const limits = { hours: 1, tasks: 4, tasksAtATime: 3, sendBacks: null, usagePercent: 80 };
const CHECKS = ["pr_open", "pr_merged", "ci_passed"];
const MERGED = { number: 42, state: "merged", checks: "passed", headOid: "a".repeat(40) };
const PASSING = Object.freeze({ treeClean: true, branchCommits: true, pullRequestStates: ["merged"], ciPassed: true,
  readAt: { tree: 2000, branch: 2000, pullRequests: 2000, ci: 2000 }, workAt: { tree: 1000, repository: 1000 } });
const BUILDER = "codex:builder-1";
const error = (answer, code) => assert.deepEqual(answer, { ok: false, error: code });
const markDoneStep = { repositoryId: REPO, taskId: "T-1", kind: "mark_done" };

function setup(t, { checks = CHECKS, settings = {}, verdict = "pass" } = {}) {
  const directory = mkdtempSync(path.join(process.cwd(), ".grant-done-test-"));
  const clock = { now: 1700000000000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  createTask(store, REPO, { text: "task one", completeWhen: { checks, own: null } });
  createTask(store, REPO, { text: "task two" });
  queueTask(store, "T-1");
  updateTask(directory, 1, { state: "needs_review", session_id: BUILDER, report_at: clock.now, report_results: "[]" });
  withDatabase(directory, (db) => {
    db.prepare("UPDATE tasks SET column_id = (SELECT id FROM columns WHERE repository_id = ? AND name = 'Review') WHERE repository_id = ? AND number = 1").run(REPO, REPO);
    db.prepare("INSERT INTO task_events(repository_id, number, kind, at, session_id) VALUES (?, 1, 'review', ?, ?)").run(REPO, clock.now, BUILDER);
    if (verdict) db.prepare("INSERT INTO task_reviews(repository_id, number, session_id, at, verdict, reasons) VALUES (?, 1, 'codex:reviewer-1', ?, ?, ?)")
      .run(REPO, clock.now, verdict, verdict === "fail" ? JSON.stringify(["Missing proof"]) : null);
  });
  assert.equal(store.apply(REPO, "aril_settings_set", { settings: { actions, limits, workRules: [{ kind: "text", value: "task" }], ...settings } }).ok, true);
  const reads = [];
  const context = { facts: PASSING, pullRequest: MERGED };
  const resolvePullRequestFacts = () => context.pullRequest;
  return { store, directory, clock, reads, context,
    start: () => store.apply(REPO, "grant_start", {}),
    next: () => store.nextGrantSteps({ resolveGateFacts: passingGates, resolveUsage: () => 10, resolvePullRequestFacts }).steps,
    markDone: () => store.markGrantDone(REPO, { taskId: "T-1" }, {
      readCheckFacts: async (sessionId) => { reads.push(sessionId); return context.facts; }, resolvePullRequestFacts }),
    task: (id = "T-1") => store.readBoard(REPO).tasks.find((task) => task.id === id),
    kinds: () => store.readLog(REPO, { limit: 50 }).entries.map((entry) => `${entry.task}:${entry.kind}`) };
}

test("a grant marks a merged, reviewed task with every check passed Done and logs grant_done", async (t) => {
  const f = setup(t);
  assert.equal(f.start().ok, true);
  assert.deepEqual(f.next(), [markDoneStep]);
  assert.deepEqual(f.next(), [], "a minute passes before the step is offered again");
  f.clock.now += 60000;
  assert.deepEqual(f.next(), [markDoneStep]);
  assert.deepEqual(await f.markDone(), { ok: true });
  assert.deepEqual(f.reads, [BUILDER], "the checks are read fresh for the builder session");
  const done = f.task();
  assert.equal(done.state, "done");
  assert.equal(f.store.readBoard(REPO).columns.find((column) => column.id === done.columnId).role, "done");
  assert.deepEqual(f.kinds().slice(-2), ["T-1:done", "T-1:grant_done"]);
  assert.equal(f.store.readBoard(REPO).aril.grant.startsUsed, 0, "a mark-done is no new grant task");
  assert.deepEqual(f.next(), []);
  error(await f.markDone(), "not_eligible");
  assert.equal(withDatabase(f.directory, (db) => db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'task_grant_done_offered:%'").get().n), 0);
});

for (const [name, change, offered = true] of [
  ["a failed check", (f) => { f.context.facts = { ...PASSING, ciPassed: false }; }],
  ["an unavailable check", (f) => { f.context.facts = { ...PASSING, ciPassed: null }; }],
  ["no check reading", (f) => { f.context.facts = null; }],
  ["a check read before the work", (f) => { f.context.facts = { ...PASSING, workAt: { tree: 1000, repository: 3000 } }; }],
  ["an unmerged pull request", (f) => { f.context.pullRequest = { ...MERGED, state: "open" }; }, false],
  ["unknown pull-request facts", (f) => { f.context.pullRequest = null; }, false],
]) test(`a grant refuses to mark Done with ${name}`, async (t) => {
  const f = setup(t);
  assert.equal(f.start().ok, true);
  change(f);
  assert.deepEqual(f.next(), offered ? [markDoneStep] : []);
  error(await f.markDone(), "not_eligible");
  assert.equal(f.task().state, "needs_review");
  assert.equal(f.kinds().some((kind) => kind.endsWith(":grant_done") || kind.endsWith(":done")), false);
});

for (const [name, options, prepare = () => {}] of [
  ["user_validated in Complete when", { checks: [...CHECKS, "user_validated"] }],
  ["no Complete when check, which leaves no acceptance to verify", { checks: [] }],
  ["Mark done off", { settings: { actions: { ...actions, markDone: false } } }],
  ["a failed review", { verdict: "fail" }],
  ["no review while reviews are on", { verdict: null }],
  ["a task no work rule selects", { settings: { workRules: [{ kind: "text", value: "other" }] } }],
  ["an owner block hold", {}, (f) => withDatabase(f.directory, (db) => db.prepare("INSERT INTO meta(key, value) VALUES (?, '1')").run(`task_block_hold:${REPO}:T-1`))],
  ["a stalled task", {}, (f) => updateTask(f.directory, 1, { state: "stalled" })],
]) test(`a grant never marks Done with ${name}, and never reads the checks`, async (t) => {
  const f = setup(t, options);
  assert.equal(f.start().ok, true);
  prepare(f);
  assert.deepEqual(f.next().filter((step) => step.kind === "mark_done"), []);
  error(await f.markDone(), "not_eligible");
  assert.deepEqual(f.reads, []);
  assert.notEqual(f.task().state, "done");
});

test("with reviews off a task without a verdict may be marked Done; without a grant nothing is", async (t) => {
  const f = setup(t, { verdict: null, settings: { actions: { ...actions, start: true, review: false } } });
  error(await f.markDone(), "not_active");
  assert.equal(f.start().ok, true);
  assert.deepEqual(await f.markDone(), { ok: true });
  error(await f.store.markGrantDone(REPO, { taskId: "T-1", extra: true }), "invalid");
  error(await f.store.markGrantDone(REPO, { taskId: "1" }), "invalid");
});

test("a stop between the check reading and the write marks nothing", async (t) => {
  const f = setup(t);
  assert.equal(f.start().ok, true);
  const answer = f.store.markGrantDone(REPO, { taskId: "T-1" }, { resolvePullRequestFacts: () => MERGED,
    readCheckFacts: async () => { assert.equal(f.store.apply(REPO, "grant_stop", {}).ok, true); return PASSING; } });
  error(await answer, "not_active");
  assert.equal(f.task().state, "needs_review");
});

test("a runs_after child becomes startable for the queue and the grant once the grant marks its parent Done", async (t) => {
  const f = setup(t, { settings: { actions: { ...actions, start: true } } });
  assert.equal(f.store.apply(REPO, "after_set", { id: "T-2", after: ["T-1"] }).ok, true);
  queueTask(f.store, "T-2");
  assert.equal(f.store.apply(REPO, "queue_settings", { on: true }).ok, true);
  assert.equal(f.start().ok, true);
  assert.deepEqual(f.store.nextQueueStarts({ resolveGateFacts: passingGates }).starts, [], "the queue holds the child until its parent is Done");
  assert.deepEqual(await f.markDone(), { ok: true });
  assert.deepEqual(f.store.nextQueueStarts({ resolveGateFacts: passingGates }).starts, [{ repositoryId: REPO, taskId: "T-2" }]);
  assert.deepEqual(f.next(), [{ repositoryId: REPO, taskId: "T-2", kind: "start" }]);
});

for (const markDone of [true, false]) test(`a grant that used its tasks ${markDone ? "waits up to ten minutes after a merge for Mark done" : "ends at once without Mark done"}`, (t) => {
  const f = setup(t, { settings: { actions: { ...actions, start: true, markDone }, limits: { ...limits, tasks: 1 } } });
  assert.equal(f.start().ok, true);
  assert.equal(f.store.recordGrant(REPO, { taskId: "T-1", kind: "start" }).ok, true);
  withDatabase(f.directory, (db) => db.prepare("INSERT INTO task_log(repository_id, number, kind, at) VALUES (?, 1, 'merged', ?)").run(REPO, f.clock.now));
  assert.equal(f.store.checkGrant(REPO).active, markDone);
  f.clock.now += 600001;
  assert.equal(f.store.checkGrant(REPO).active, false);
  assert.equal(f.store.readBoard(REPO).aril.grant.endReason, "tasks_used");
});

test("an older grant without Mark done in its snapshot reads it as off", (t) => {
  const f = setup(t);
  assert.equal(f.start().ok, true);
  withDatabase(f.directory, (db) => db.prepare("UPDATE aril_grants SET actions = ?").run(JSON.stringify({ ...actions, markDone: undefined })));
  assert.equal(f.store.readBoard(REPO).aril.grant.actions.markDone, false);
  assert.deepEqual(f.next(), []);
});
