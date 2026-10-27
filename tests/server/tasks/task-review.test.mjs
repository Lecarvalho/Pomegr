import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import * as review from "../../../server/tasks/task-review.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { TASK_DISPATCH_UNBOUND_TTL_MS } from "../../../server/tasks/task-dispatch.mjs";
import { createTask, FACTS, metaValue, openTemporaryStore, passingGates, REPOSITORY, SESSION, updateTask, withDatabase } from "./queue-test-support.mjs";

const REVIEWER = "codex:reviewer";
test("board review shows only the current Review verdict without reviewer identity", async (t) => {
  const env = await setup(t);
  const current = () => env.store.readBoard(REPOSITORY).tasks[0].review;
  assert.equal(current(), null);
  assert.equal(env.store.bindSession({ token: plan(env).plan.token, sessionId: REVIEWER }).ok, true);
  assert.deepEqual(current(), { state: "running" });
  assert.equal(report(env).ok, true);
  assert.deepEqual(current(), { state: "passed", at: new Date(env.clock.now).toISOString(), reasons: [] });
  const reasons = ["Checks failed", "Rule unmet"];
  assert.equal(report(env, { verdict: "fail", reasons }).ok, true);
  assert.deepEqual(current(), { state: "failed", at: new Date(env.clock.now).toISOString(), reasons });
  assert.ok(!JSON.stringify(env.store.readBoard(REPOSITORY)).includes(REVIEWER));
  assert.equal(env.store.apply(REPOSITORY, "resolve_requeue", { id: "T-1" }).ok, true);
  assert.equal(current(), null);
  env.clock.now += 1000;
  updateTask(env.directory, 1, { session_id: SESSION });
  assert.equal(env.store.completeTask({ sessionId: SESSION }).ok, true);
  assert.equal(current(), null);
  assert.equal(env.store.bindSession({ token: plan(env).plan.token, sessionId: "codex:next" }).ok, true);
  assert.deepEqual(current(), { state: "running" });
  assert.equal(report(env, { sessionId: "codex:next" }).ok, true);
  assert.deepEqual(current(), { state: "passed", at: new Date(env.clock.now).toISOString(), reasons: [] });
});
const key = (kind, id = "T-1") => `task_${kind}:${REPOSITORY}:${id}`;
const plan = (env, payload = { id: "T-1" }, facts = FACTS) => env.store.planReview(REPOSITORY, payload, () => facts);
const rows = (env, table) => withDatabase(env.directory, (db) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
const reviewerCount = (env) => withDatabase(env.directory, (db) => db.prepare("SELECT COUNT(*) AS count FROM task_reviewers").get().count);
const report = (env, fields = {}) => env.store.reportReview({ sessionId: REVIEWER, verdict: "pass", ...fields });
async function setup(t, bind = false) {
  const env = await openTemporaryStore(t);
  createTask(env.store);
  updateTask(env.directory, 1, { state: "needs_review", session_id: SESSION });
  if (bind) assert.deepEqual(env.store.bindSession({ token: plan(env).plan.token, sessionId: REVIEWER }), { ok: true });
  return env;
}

test("review plans require Review, a builder, and no live review dispatch", async (t) => {
  const env = await setup(t);
  for (const state of ["not_queued", "queued", "scheduled", "blocked", "stalled", "done"]) {
    updateTask(env.directory, 1, { state });
    assert.deepEqual(plan(env), { ok: false, error: "not_startable" });
  }
  updateTask(env.directory, 1, { state: "needs_review", session_id: null });
  assert.deepEqual(plan(env), { ok: false, error: "not_startable" });
  updateTask(env.directory, 1, { session_id: SESSION });
  const first = plan(env);
  assert.equal(first.ok, true);
  assert.deepEqual(Object.keys(first.plan).sort(), ["taskId", "provider", "model", "effort", "repositoryRoot", "prompt", "token"].sort());
  assert.equal(metaValue(env.directory, key("review_dispatch")), `${crypto.createHash("sha256").update(first.plan.token).digest("hex")}:${env.clock.now}`);
  assert.deepEqual(plan(env), { ok: false, error: "not_startable" });
  env.clock.now += TASK_DISPATCH_UNBOUND_TTL_MS;
  assert.deepEqual(env.store.bindSession({ token: first.plan.token, sessionId: REVIEWER }), { ok: false, error: "not_found" });
  assert.equal(plan(env).ok, true);
});

test("review overrides use run validation and exact payloads; facts follow the selected run", async (t) => {
  const env = await setup(t);
  for (const payload of [{}, { id: "T-1", model: "gpt-6" }, { id: "T-1", provider: "codex" },
    { id: "T-1", provider: null, model: null, effort: null }, { id: "T-1", provider: "other", model: null, effort: null },
    { id: "T-1", provider: "codex", model: "../path", effort: "high" }, { id: "T-1", provider: "codex", model: null, effort: "max" },
    { id: "T-1", worktree: true }]) assert.deepEqual(plan(env, payload), { ok: false, error: "invalid" });
  assert.deepEqual(plan(env, { id: "T-1" }, { root: null, pluginReady: true }), { ok: false, error: "unavailable" });
  assert.deepEqual(plan(env, { id: "T-1" }, { ...FACTS, pluginReady: false }), { ok: false, error: "plugin_missing" });
  const answer = plan(env, { id: "T-1", provider: "codex", model: "gpt-6", effort: "high" });
  assert.deepEqual([answer.plan.provider, answer.plan.model, answer.plan.effort], ["codex", "gpt-6", "high"]);
  assert.equal(env.store.readBoard(REPOSITORY).tasks[0].run.provider, null);
});

test("abort clears only the matching review token", async (t) => {
  const env = await setup(t);
  const token = plan(env).plan.token;
  assert.deepEqual(env.store.abortReview(REPOSITORY, { id: "T-1", token: "x".repeat(43) }), { ok: true });
  assert.notEqual(metaValue(env.directory, key("review_dispatch")), null);
  assert.deepEqual(env.store.abortReview(REPOSITORY, { id: "T-1", token }), { ok: true });
  assert.equal(metaValue(env.directory, key("review_dispatch")), null);
});

test("review binding preserves builder fields and column, rejects linked sessions and reused tokens", async (t) => {
  const env = await setup(t);
  const before = env.store.readBoard(REPOSITORY).tasks[0];
  const token = plan(env).plan.token;
  assert.deepEqual(env.store.bindSession({ token, sessionId: SESSION }), { ok: false, error: "not_found" });
  assert.deepEqual(env.store.bindSession({ token, sessionId: REVIEWER }), { ok: true });
  assert.deepEqual(env.store.readBoard(REPOSITORY).tasks[0], { ...before, review: { state: "running" } });
  assert.equal(metaValue(env.directory, key("reviewer")), REVIEWER);
  assert.equal(metaValue(env.directory, key("review_dispatch")), null);
  assert.deepEqual(rows(env, "task_log").map((r) => r.kind), ["review_started"]);
  assert.deepEqual(env.store.bindSession({ token, sessionId: "codex:another" }), { ok: false, error: "not_found" });
  createTask(env.store);
  const builder = env.store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates);
  assert.deepEqual(env.store.bindSession({ token: builder.plan.token, sessionId: "claude:builder2" }), { ok: true });
  updateTask(env.directory, 2, { state: "needs_review" });
  const second = plan(env, { id: "T-2" }).plan.token;
  assert.deepEqual(env.store.bindSession({ token: second, sessionId: REVIEWER }), { ok: false, error: "not_found" });
  updateTask(env.directory, 2, { state: "done" });
  assert.deepEqual(env.store.bindSession({ token: second, sessionId: "codex:new" }), { ok: false, error: "not_found" });
});

// T-184: desktop main's start-bind links a Codex reviewer whose session-start hook never reported.
test("start-bind links only the named task's live review dispatch, once, and only a Codex session", async (t) => {
  const env = await setup(t);
  const token = plan(env).plan.token;
  const bind = (payload) => env.store.bindStart(REPOSITORY, { id: "T-1", token, sessionId: REVIEWER, ...payload });
  createTask(env.store);
  updateTask(env.directory, 2, { state: "needs_review", session_id: "codex:builder2" });
  assert.deepEqual(bind({ id: "T-2" }), { ok: false, error: "not_found" });
  assert.deepEqual(bind({ token: "x".repeat(43) }), { ok: false, error: "not_found" });
  assert.deepEqual(bind({ sessionId: "claude:reviewer" }), { ok: false, error: "invalid" });
  assert.deepEqual(bind({ sessionId: "codex:builder2" }), { ok: false, error: "not_found" }, "a builder session never reviews");
  assert.equal(env.store.reviewSession(REPOSITORY, { id: "T-1" }).sessionId, null);
  env.clock.now += TASK_DISPATCH_UNBOUND_TTL_MS;
  assert.deepEqual(bind({}), { ok: false, error: "not_found" });
  env.clock.now -= 1;
  const before = env.store.readBoard(REPOSITORY).tasks[0];
  assert.deepEqual(bind({}), { ok: true });
  assert.deepEqual(env.store.readBoard(REPOSITORY).tasks[0], { ...before, review: { state: "running" } });
  assert.equal(env.store.reviewSession(REPOSITORY, { id: "T-1" }).sessionId, REVIEWER);
  assert.equal(metaValue(env.directory, key("review_dispatch")), null);
  assert.deepEqual(rows(env, "task_log").map((r) => r.kind), ["review_started"]);
  assert.deepEqual(bind({}), { ok: false, error: "not_found" });
  assert.deepEqual(env.store.bindSession({ token, sessionId: REVIEWER }), { ok: false, error: "not_found" }, "the hook's late report is refused");
  assert.equal(report(env).ok, true);
});

test("only the reviewer reports; changed verdicts append, identical retries do not", async (t) => {
  const env = await setup(t, true);
  assert.deepEqual(report(env, { sessionId: SESSION }), { ok: false, error: "not_found" });
  assert.deepEqual(report(env, { taskId: "T-2" }), { ok: false, error: "not_found" });
  assert.deepEqual(report(env), { ok: true });
  assert.deepEqual(report(env), { ok: true });
  const fail = { verdict: "fail", reasons: ["AGENTS.md: unmet, required checks failed"] };
  assert.deepEqual(report(env, fail), { ok: true });
  assert.deepEqual(report(env, fail), { ok: true });
  const stored = rows(env, "task_reviews");
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((r) => [r.session_id, r.at, r.verdict, r.reasons]), [[REVIEWER, env.clock.now, "pass", null], [REVIEWER, env.clock.now, "fail", JSON.stringify(fail.reasons)]]);
  assert.deepEqual(rows(env, "task_log").map((r) => r.kind), ["review_started", "review_passed", "review_failed"]);
  assert.equal(env.store.readBoard(REPOSITORY).tasks[0].state, "needs_review");
  const exposed = JSON.stringify([env.store.readBoard(REPOSITORY), env.store.readAgentTasks(REPOSITORY), env.store.readLog(REPOSITORY, { limit: 20 })]);
  assert.ok(!exposed.includes(REVIEWER));
  assert.ok(!JSON.stringify([env.store.readAgentTasks(REPOSITORY), env.store.readLog(REPOSITORY, { limit: 20 })]).includes(fail.reasons[0]));
  updateTask(env.directory, 1, { state: "done" });
  assert.deepEqual(report(env), { ok: false, error: "not_reviewable" });
});

test("review verdict and reason validation rejects malformed reports", async (t) => {
  const env = await setup(t, true);
  for (const fields of [{ verdict: "unknown" }, { reasons: ["x"] }, { verdict: "fail" }, { verdict: "fail", reasons: [] },
    { verdict: "fail", reasons: Array(11).fill("x") }, { verdict: "fail", reasons: ["x".repeat(201)] },
    ...["", "  ", "a\nb", "a\rb", "a\u2028b", "a\u2029b", 1].map((reason) => ({ verdict: "fail", reasons: [reason] })),
    { extra: true }]) assert.deepEqual(report(env, fields), { ok: false, error: "invalid" });
  assert.equal(rows(env, "task_reviews").length, 0);
});

test("Requeue clears the reviewer and dispatch, and Done records first verdict and total reviews", async (t) => {
  const env = await setup(t, true);
  report(env, { verdict: "fail", reasons: ["rule unmet"] });
  plan(env);
  assert.equal(env.store.apply(REPOSITORY, "resolve_requeue", { id: "T-1" }).ok, true);
  assert.equal(metaValue(env.directory, key("reviewer")), null);
  assert.equal(metaValue(env.directory, key("review_dispatch")), null);
  assert.deepEqual(report(env), { ok: false, error: "not_found" });
  updateTask(env.directory, 1, { state: "needs_review", session_id: SESSION });
  assert.deepEqual(env.store.bindSession({ token: plan(env).plan.token, sessionId: "codex:next-review" }), { ok: true });
  report(env, { sessionId: "codex:next-review" });
  assert.equal(env.store.apply(REPOSITORY, "resolve_done", { id: "T-1" }).ok, true);
  const outcome = withDatabase(env.directory, (db) => db.prepare("SELECT reviews, first_review_passed FROM task_outcomes WHERE number = 1").get());
  assert.deepEqual({ ...outcome }, { reviews: 2, first_review_passed: 0 });
  assert.equal(metaValue(env.directory, key("reviewer")), null);
});

test("Done records a first pass, and no verdicts remain unknown", async (t) => {
  const env = await setup(t, true);
  report(env);
  env.store.apply(REPOSITORY, "resolve_done", { id: "T-1" });
  createTask(env.store);
  updateTask(env.directory, 2, { state: "needs_review" });
  env.store.apply(REPOSITORY, "resolve_done", { id: "T-2" });
  const outcomes = withDatabase(env.directory, (db) => db.prepare("SELECT reviews, first_review_passed FROM task_outcomes ORDER BY number").all());
  assert.deepEqual(outcomes.map((r) => ({ ...r })), [{ reviews: 1, first_review_passed: 1 }, { reviews: 0, first_review_passed: null }]);
});

test("existing stores add reviews and outcome columns without losing old outcomes", async (t) => {
  const env = await setup(t);
  env.store.apply(REPOSITORY, "resolve_done", { id: "T-1" });
  env.store.close();
  withDatabase(env.directory, (db) => db.exec("DROP TABLE task_reviews; ALTER TABLE task_outcomes DROP COLUMN reviews; ALTER TABLE task_outcomes DROP COLUMN first_review_passed;"));
  const reopened = openTaskStore({ directory: env.directory });
  try {
    assert.equal(reopened.readBoard(REPOSITORY).readiness, "ready");
    const row = withDatabase(env.directory, (db) => db.prepare("SELECT reviews, first_review_passed FROM task_outcomes").get());
    assert.deepEqual({ ...row }, { reviews: null, first_review_passed: null });
    assert.equal(rows(env, "task_reviews").length, 0);
  } finally { reopened.close(); }
});

test("deleting a task removes reviews and both review keys", async (t) => {
  const env = await setup(t, true);
  report(env);
  plan(env);
  assert.equal(env.store.apply(REPOSITORY, "delete", { id: "T-1" }).ok, true);
  assert.equal(rows(env, "task_reviews").length, 0);
  assert.equal(reviewerCount(env), 0);
  assert.equal(metaValue(env.directory, key("reviewer")), null);
  assert.equal(metaValue(env.directory, key("review_dispatch")), null);
});

// T-188: every reviewer session stays linked to its task until the task is deleted.
test("the reviewer record keeps each reviewer with its link time while the current pointer clears", async (t) => {
  const env = await setup(t, true);
  const kept = () => reviewerCount(env);
  assert.deepEqual(withDatabase(env.directory, (db) => db.prepare("SELECT repository_id, number, session_id, at FROM task_reviewers").all()).map((row) => ({ ...row })),
    [{ repository_id: REPOSITORY, number: 1, session_id: REVIEWER, at: env.clock.now }]);
  assert.equal(env.store.apply(REPOSITORY, "resolve_requeue", { id: "T-1" }).ok, true);
  assert.equal(metaValue(env.directory, key("reviewer")), null);
  assert.equal(kept(), 1);
  assert.deepEqual(env.store.reviewSession(REPOSITORY, { id: "T-1" }), { ok: true, sessionId: REVIEWER, sessionIds: [REVIEWER] });
  assert.deepEqual([...env.store.sessionReviews([REVIEWER, SESSION, "codex:unknown"]).keys()], [REVIEWER]);
  assert.equal(env.store.sessionReviews([REVIEWER]).get(REVIEWER).role, "review");
  assert.equal(env.store.readBoard(REPOSITORY).tasks[0].review, null);
  assert.ok(!JSON.stringify(env.store.readBoard(REPOSITORY)).includes(REVIEWER), "the board never serves a reviewer identity");
});

test("a kept reviewer still reviews only its own task, and the same reviewer relinks its task without a second row", async (t) => {
  const env = await setup(t, true);
  createTask(env.store);
  updateTask(env.directory, 2, { state: "needs_review", session_id: "claude:builder2" });
  assert.equal(env.store.apply(REPOSITORY, "resolve_done", { id: "T-1" }).ok, true);
  assert.deepEqual(env.store.bindSession({ token: plan(env, { id: "T-2" }).plan.token, sessionId: REVIEWER }), { ok: false, error: "not_found" });
  updateTask(env.directory, 1, { state: "needs_review", session_id: SESSION });
  env.clock.now += 1000;
  assert.deepEqual(env.store.bindSession({ token: plan(env).plan.token, sessionId: REVIEWER }), { ok: true });
  assert.equal(reviewerCount(env), 1);
});

test("existing stores fill the reviewer record from verdicts and current reviewers", async (t) => {
  const env = await setup(t, true);
  report(env);
  createTask(env.store);
  updateTask(env.directory, 2, { state: "needs_review", session_id: "claude:builder2" });
  assert.deepEqual(env.store.bindSession({ token: plan(env, { id: "T-2" }).plan.token, sessionId: "codex:current" }), { ok: true });
  env.store.close();
  withDatabase(env.directory, (db) => db.exec("DROP TABLE task_reviewers"));
  const reopened = openTaskStore({ directory: env.directory, now: () => env.clock.now });
  try {
    assert.deepEqual([...reopened.sessionReviews([REVIEWER, "codex:current"])].map(([session, task]) => [session, task.id]), [[REVIEWER, "T-1"], ["codex:current", "T-2"]]);
  } finally { reopened.close(); }
});

test("review prompt has the task, feature and fixed read-only review instructions within 8000 characters", () => {
  const prompt = review.buildReviewPrompt({ id: "T-7", text: "-task text", completeWhen: { checks: ["pr_open", "tree_clean"], own: "own condition" } }, { id: "feat-123", title: "Feature" });
  assert.ok(!prompt.startsWith("-"));
  for (const text of ["Task T-7", "must not edit, commit, or push", "-task text", "Complete when:", "Pull request open", "Working tree clean", "own condition", "Feature", "feat-123", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING", "merge base", "default branch", "tasks/T-7", "focused and full", "report_review", "exactly once", '"pass"', '"fail"', "10", "200", "met, unmet, or unknown", "fails its own review"]) assert.ok(prompt.includes(text), text);
  const bounded = review.buildReviewPrompt({ id: "T-7", text: "x".repeat(4000), completeWhen: { checks: [], own: "y".repeat(500) } }, { id: "feat-123456789abc", title: "z".repeat(80) });
  assert.ok(bounded.length <= 8000);
});
