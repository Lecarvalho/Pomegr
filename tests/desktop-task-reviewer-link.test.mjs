import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTerminalController } from "../desktop/runtime/terminal.mjs";
import { createRequestHandler } from "../server/serving/request-handler.mjs";
import { serveSessionDirectoryWithTasks } from "../server/serving/session-directory-tasks.mjs";
import { openTaskStore } from "../server/tasks/task-store.mjs";
import { updateTask, withDatabase } from "./server/tasks/queue-test-support.mjs";

// T-188: a reviewer Pomegr started lost its task once the task left Review, because the only link was the
// current-review pointer. The Sessions list showed no task for it and the Terminal tab could not resolve it.
const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const DESKTOP = "d".repeat(40);
const BUILDER = "claude:builder";
const FIRST = "codex:reviewer-first";
const SECOND = "claude:reviewer-second";
const FACTS = { root: "C:\\Work\\repo", pluginReady: true };
const reviewKey = (nonce) => `${REPOSITORY_ID}/T-1/review-${nonce.repeat(32)}`;

async function monitor(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-reviewer-link-"));
  const clock = { now: 1_000_000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  const server = http.createServer(createRequestHandler({ runtime: { resolveTaskStart: () => FACTS }, taskStore: store, authorizationToken: DESKTOP }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise((done) => server.close(done));
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  assert.equal(store.apply(REPOSITORY_ID, "create", { text: "Implement the task renderer" }).ok, true);
  const env = { store, clock, directory, origin: `http://127.0.0.1:${server.address().port}` };
  inReview(env);
  return env;
}

function inReview(env) {
  updateTask(env.directory, 1, { state: "needs_review", session_id: BUILDER }, REPOSITORY_ID);
  withDatabase(env.directory, (db) => db.prepare("INSERT INTO task_events(repository_id, number, kind, at, session_id) VALUES (?, 1, 'review', ?, ?)")
    .run(REPOSITORY_ID, env.clock.now, BUILDER));
}

// A review as the desktop starts it: the monitor mints the dispatch, the reviewer's hook binds it, the reviewer reports.
function review(env, sessionId, verdict) {
  env.clock.now += 1000;
  const token = env.store.planReview(REPOSITORY_ID, { id: "T-1" }, () => FACTS).plan.token;
  assert.deepEqual(env.store.bindSession({ token, sessionId }), { ok: true });
  env.clock.now += 1000;
  const report = verdict === "pass" ? { verdict } : { verdict, reasons: ["Checks failed"] };
  assert.deepEqual(env.store.reportReview({ sessionId, ...report }), { ok: true });
}

// The Sessions list's Task cell: the directory rows joined with the store's links.
function directoryTasks(env, sessionIds) {
  const runtime = { serveSessionDirectory: () => ({ revision: 1, sessions: sessionIds.map((id) => ({ id })), matchedCount: sessionIds.length, counts: { all: 1, live: 0, needs: 0 }, pageSize: 25, nextCursor: null }) };
  return serveSessionDirectoryWithTasks({ runtime, taskStore: env.store, allowed: true, query: {} }).sessions.map((row) => row.task);
}

// The desktop Terminal tab's list, against the real monitor routes, with ended review keys in creation order.
async function terminalSessions(context, env, keys) {
  const client = { listHosts: async () => [], list: async () => keys.map((key) => ({ key, exited: true, exitCode: 0 })), close() {} };
  const controller = createTerminalController({ client, isTrustedEvent: (event) => event.trusted, monitorOrigin: env.origin, authorizationToken: DESKTOP });
  context.after(() => controller.dispose());
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  const frame = { send() {} }; sender.mainFrame = frame;
  const answer = await controller.run({ trusted: true, sender, senderFrame: frame }, "list");
  assert.equal(answer.ok, true);
  return answer.sessions.map((row) => [row.role, row.sessionId, row.state]);
}

async function reviewSessionRoute(env) {
  const response = await fetch(`${env.origin}/internal/tasks/review-session`, {
    method: "POST", headers: { "x-pomegr-desktop-authorization": DESKTOP, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { id: "T-1" } }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function reviewerRef(state) {
  return { id: "T-1", repositoryId: REPOSITORY_ID, state, featureId: null, feature: null, issue: null, role: "review" };
}

async function assertLinked(context, env, state) {
  assert.deepEqual(directoryTasks(env, [FIRST]), [reviewerRef(state)]);
  assert.deepEqual(await terminalSessions(context, env, [reviewKey("a")]), [["review", FIRST, "exited"]]);
  // The builder link and the agent report paths are untouched: the reviewer never becomes a started session.
  assert.equal(env.store.sessionTasks([FIRST]).get(FIRST), undefined);
  assert.equal(directoryTasks(env, [BUILDER])[0]?.role, undefined);
}

test("a reviewer stays linked after a pass verdict", async (context) => {
  const env = await monitor(context);
  review(env, FIRST, "pass");
  await assertLinked(context, env, "needs_review");
});

test("a reviewer stays linked after a fail verdict and a grant send-back", async (context) => {
  const env = await monitor(context);
  const settings = {
    actions: { start: true, review: true, sendBack: true, merge: false, writeTasks: false },
    limits: { hours: 1, tasks: 4, tasksAtATime: 3, sendBacks: 2, usagePercent: 80 },
    workRules: [{ kind: "text", value: "task" }],
  };
  assert.equal(env.store.apply(REPOSITORY_ID, "aril_settings_set", { settings }).ok, true);
  assert.equal(env.store.apply(REPOSITORY_ID, "grant_start", {}).ok, true);
  review(env, FIRST, "fail");
  assert.deepEqual(env.store.sendBackGrant(REPOSITORY_ID, { taskId: "T-1" }), { ok: true });
  assert.equal(env.store.readBoard(REPOSITORY_ID).tasks[0].review, null, "review state still follows the cleared current pointer");
  await assertLinked(context, env, null);
});

test("a reviewer stays linked after Mark done", async (context) => {
  const env = await monitor(context);
  review(env, FIRST, "pass");
  assert.equal(env.store.apply(REPOSITORY_ID, "resolve_done", { id: "T-1" }).ok, true);
  await assertLinked(context, env, "done");
});

test("a reviewer stays linked after Requeue", async (context) => {
  const env = await monitor(context);
  review(env, FIRST, "fail");
  assert.equal(env.store.apply(REPOSITORY_ID, "resolve_requeue", { id: "T-1" }).ok, true);
  assert.deepEqual(env.store.reportReview({ sessionId: FIRST, verdict: "pass" }), { ok: false, error: "not_found" }, "only the current reviewer reports");
  await assertLinked(context, env, null);
});

test("a second review of the same task keeps both reviewers", async (context) => {
  const env = await monitor(context);
  review(env, FIRST, "fail");
  review(env, SECOND, "pass");
  assert.deepEqual(directoryTasks(env, [FIRST, SECOND]), [reviewerRef("needs_review"), reviewerRef("needs_review")]);
  assert.deepEqual(await reviewSessionRoute(env), { ok: true, sessionId: SECOND, sessionIds: [FIRST, SECOND] });
  assert.deepEqual(await terminalSessions(context, env, [reviewKey("a"), reviewKey("b")]), [["review", FIRST, "exited"], ["review", SECOND, "exited"]]);
  assert.equal(env.store.apply(REPOSITORY_ID, "resolve_done", { id: "T-1" }).ok, true);
  assert.deepEqual(directoryTasks(env, [FIRST, SECOND]), [reviewerRef("done"), reviewerRef("done")]);
  assert.deepEqual(await reviewSessionRoute(env), { ok: true, sessionId: SECOND, sessionIds: [FIRST, SECOND] });
  assert.deepEqual(await terminalSessions(context, env, [reviewKey("a"), reviewKey("b")]), [["review", FIRST, "exited"], ["review", SECOND, "exited"]]);
});

test("deleting the task removes every reviewer link", async (context) => {
  const env = await monitor(context);
  review(env, FIRST, "pass");
  assert.equal(env.store.apply(REPOSITORY_ID, "resolve_done", { id: "T-1" }).ok, true);
  assert.equal(env.store.apply(REPOSITORY_ID, "delete", { id: "T-1" }).ok, true);
  assert.deepEqual(directoryTasks(env, [FIRST]), [null]);
  assert.equal(withDatabase(env.directory, (db) => db.prepare("SELECT COUNT(*) AS count FROM task_reviewers").get().count), 0);
});
