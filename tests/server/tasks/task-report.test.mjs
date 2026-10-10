import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { passingGates } from "./queue-test-support.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const AGENT = "a".repeat(40);
const TEXT = "Fix the SECRET-TASK-TEXT flaky test";
const SESSION = "claude:0b8f2c1e-1111-4222-8333-444455556666";
const OTHER_SESSION = "codex:019a0000-2222-7333-8444-555566667777";
const COMPLETE = "/api/agent/v1/tasks/complete";
const BLOCK = "/api/agent/v1/tasks/block";
const REASON = "The SECRET-REASON migration needs a decision";
const agentHeaders = { "x-pomegr-agent-authorization": AGENT, "content-type": "application/json" };
const START_FACTS = { root: "C:/Work/SECRET-ROOT/repo", pluginReady: true };
// Every fact carries the time it was read, later than the work it judges; a fact without one is unknown.
const FRESH = { readAt: { tree: 2000, branch: 2000, pullRequests: 2000, ci: 2000 }, workAt: { tree: 1000, repository: 1000 } };
const PASSING = { treeClean: true, branchCommits: true, pullRequestStates: ["open"], ciPassed: null, ...FRESH };

async function setup(context, { facts = PASSING, read = undefined } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-report-"));
  const clock = { now: 1_000_000 };
  const env = { facts, factCalls: [], read, readCalls: [], clock, directory };
  env.store = openTaskStore({ directory, now: () => clock.now });
  const server = http.createServer(createRequestHandler({
    runtime: { resolveTaskCheckFacts: (ref) => { env.factCalls.push(ref); return env.facts; },
      // The report's own read, when the test gives one: a function of the session reference.
      ...(read === undefined ? {} : { readTaskCheckFacts: async (ref) => { env.readCalls.push(ref); return env.read(ref); } }) },
    taskStore: env.store, authorizationToken: "d".repeat(40), agentAuthorizationToken: AGENT,
  }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  env.port = server.address().port;
  context.after(async () => {
    await new Promise((done) => server.close(done));
    env.store.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; } catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return env;
}

function send(port, { method = "POST", path: requestPath, headers = agentHeaders, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* text */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

const complete = (env, sessionRef = SESSION) => send(env.port, { path: COMPLETE, body: JSON.stringify({ sessionRef }) });
const block = (env, reason = REASON, sessionRef = SESSION) => send(env.port, { path: BLOCK, body: JSON.stringify({ sessionRef, reason }) });
const refused = (response, status, reason) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: false, reason });
};
const apply = (env, action, payload) => env.store.apply(REPOSITORY_ID, action, payload);
const taskOf = (env, id = "T-1") => env.store.readBoard(REPOSITORY_ID).tasks.find((task) => task.id === id);

/** Creates a task and links `session` to it the way a started session does. */
function startedTask(env, { checks = [], own = null, session = SESSION } = {}) {
  const created = apply(env, "create", { text: TEXT, doneWhen: { checks, own } });
  assert.equal(created.ok, true);
  const id = created.board.tasks.reduce((best, task) => (Number(task.id.slice(2)) > Number(best.slice(2)) ? task.id : best), "T-0");
  const planned = env.store.planStart(REPOSITORY_ID, { id }, () => START_FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.deepEqual(env.store.bindSession({ token: planned.plan.token, sessionId: session }), { ok: true });
  return id;
}

function withDatabase(directory, work) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try { return work(database); } finally { database.close(); }
}
const setQueue = (env, status, blockedBy = null) => withDatabase(env.directory, (database) =>
  database.prepare("UPDATE repositories SET queue_status = ?, queue_blocked_by = ? WHERE repository_id = ?").run(status, blockedBy, REPOSITORY_ID));

test("complete with no checked condition is done on the report alone", async (context) => {
  const env = await setup(context, { facts: null });
  startedTask(env, { own: "Tests pass." });
  env.clock.now = 2_000_000;
  const response = await complete(env);
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, state: "done", results: [] });
  const task = taskOf(env);
  assert.equal(task.state, "done");
  assert.deepEqual(task.report, { at: new Date(2_000_000).toISOString(), results: [], blockReason: null });
  assert.equal(task.session.id, SESSION);
});

test("complete verifies the checked conditions from the bound session's facts: all pass is done", async (context) => {
  const env = await setup(context);
  startedTask(env, { checks: ["pr_open", "tree_clean", "commit_on_branch"] });
  const response = await complete(env);
  const results = [{ check: "pr_open", passed: true }, { check: "tree_clean", passed: true }, { check: "commit_on_branch", passed: true }];
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, state: "done", results });
  assert.deepEqual(env.factCalls, [SESSION]);
  assert.deepEqual(taskOf(env).report.results, results);
  assert.equal(taskOf(env).state, "done");
});

test("a failed or unknown check gives needs review with each result, and nothing but results", async (context) => {
  const env = await setup(context, { facts: { treeClean: false, branchCommits: true, pullRequestStates: null, ciPassed: null, ...FRESH, secret: "SECRET-FACT" } });
  startedTask(env, { checks: ["pr_open", "tree_clean", "commit_on_branch", "ci_passed"] });
  const response = await complete(env);
  const results = [
    { check: "pr_open", passed: false }, { check: "tree_clean", passed: false },
    { check: "commit_on_branch", passed: true }, { check: "ci_passed", passed: false },
  ];
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, state: "needs_review", results });
  assert.doesNotMatch(response.text, /SECRET|T-1|repo-/u);
  const task = taskOf(env);
  assert.equal(task.state, "needs_review");
  assert.deepEqual(task.report.results, results);
  assert.equal(task.report.blockReason, null);
});

test("facts that are missing or throw pass nothing and never fail the request", async (context) => {
  const env = await setup(context);
  startedTask(env, { checks: ["tree_clean"] });
  env.facts = null;
  assert.equal((await complete(env)).json.state, "needs_review");
  const thrower = await setup(context);
  startedTask(thrower, { checks: ["tree_clean"] });
  const server = http.createServer(createRequestHandler({
    runtime: { resolveTaskCheckFacts: () => { throw new Error("SECRET-ERROR"); } }, taskStore: thrower.store, agentAuthorizationToken: AGENT,
  }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  context.after(() => new Promise((done) => server.close(done)));
  const response = await send(server.address().port, { path: COMPLETE, body: JSON.stringify({ sessionRef: SESSION }) });
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, state: "needs_review", results: [{ check: "tree_clean", passed: false }] });
});

test("block stores the bounded reason and sets blocked", async (context) => {
  const env = await setup(context);
  startedTask(env, { checks: ["pr_open"] });
  env.clock.now = 3_000_000;
  const response = await block(env, `  ${REASON}  `);
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, state: "blocked" });
  assert.doesNotMatch(response.text, /SECRET/u);
  const task = taskOf(env);
  assert.equal(task.state, "blocked");
  assert.deepEqual(task.report, { at: new Date(3_000_000).toISOString(), results: [], blockReason: REASON });
  assert.deepEqual(env.factCalls, []);
});

test("a task takes one report per dispatch", async (context) => {
  const env = await setup(context);
  startedTask(env, { checks: ["tree_clean"] });
  assert.equal((await complete(env)).json.state, "done");
  const before = taskOf(env);
  refused(await complete(env), 409, "already_reported");
  refused(await block(env), 409, "already_reported");
  assert.deepEqual(taskOf(env), before);

  const blocked = await setup(context);
  startedTask(blocked);
  assert.equal((await block(blocked)).json.state, "blocked");
  refused(await complete(blocked), 409, "already_reported");
  refused(await block(blocked, "another reason"), 409, "already_reported");
  assert.equal(taskOf(blocked).report.blockReason, REASON);
  assert.deepEqual(blocked.factCalls, []);
});

test("only the session linked to a task can report on it", async (context) => {
  const env = await setup(context);
  startedTask(env);
  apply(env, "create", { text: "Unstarted" });
  refused(await complete(env, OTHER_SESSION), 404, "not_found");
  refused(await block(env, REASON, OTHER_SESSION), 404, "not_found");
  assert.equal(taskOf(env).state, "not_queued");
  assert.equal(taskOf(env, "T-2").report, null);
  assert.deepEqual(env.factCalls, []);
});

test("malformed reports are invalid and change nothing", async (context) => {
  const env = await setup(context);
  startedTask(env);
  const bodies = [
    [COMPLETE, {}], [COMPLETE, { sessionRef: "claude:" }], [COMPLETE, { sessionRef: SESSION, id: "T-1" }],
    [COMPLETE, { sessionRef: SESSION, repositoryId: REPOSITORY_ID }], [COMPLETE, { sessionRef: SESSION, reason: REASON }],
    [COMPLETE, [SESSION]], [BLOCK, { sessionRef: SESSION }], [BLOCK, { sessionRef: SESSION, reason: "" }],
    [BLOCK, { sessionRef: SESSION, reason: "   " }], [BLOCK, { sessionRef: SESSION, reason: "x".repeat(201) }],
    [BLOCK, { sessionRef: SESSION, reason: "two\nlines" }], [BLOCK, { sessionRef: SESSION, reason: 7 }],
    [BLOCK, { sessionRef: SESSION, reason: REASON, id: "T-1" }],
  ];
  for (const [requestPath, body] of bodies) refused(await send(env.port, { path: requestPath, body: JSON.stringify(body) }), 400, "invalid");
  refused(await send(env.port, { path: COMPLETE, body: "{" }), 400, "invalid");
  refused(await send(env.port, { path: `${COMPLETE}?x=1`, body: JSON.stringify({ sessionRef: SESSION }) }), 400, "invalid");
  refused(await send(env.port, { path: COMPLETE, headers: { ...agentHeaders, "content-type": "text/plain" }, body: JSON.stringify({ sessionRef: SESSION }) }), 400, "invalid");
  assert.equal((await block(env, "x".repeat(200))).json.state, "blocked");
});

test("the report routes take the agent gate and POST only", async (context) => {
  const env = await setup(context);
  startedTask(env);
  const body = JSON.stringify({ sessionRef: SESSION });
  assert.equal((await send(env.port, { path: COMPLETE, headers: { "content-type": "application/json" }, body })).status, 401);
  assert.equal((await send(env.port, { path: COMPLETE, headers: { ...agentHeaders, origin: "http://evil.example" }, body })).status, 401);
  assert.equal((await send(env.port, { path: COMPLETE, method: "GET" })).status, 405);
  assert.equal((await send(env.port, { path: BLOCK, method: "PUT", body })).status, 405);
  assert.equal(taskOf(env).report, null);
  assert.deepEqual(env.factCalls, []);
});

test("a store that cannot report answers unavailable", async (context) => {
  const server = http.createServer(createRequestHandler({ runtime: {}, taskStore: null, agentAuthorizationToken: AGENT }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  context.after(() => new Promise((done) => server.close(done)));
  const { port } = server.address();
  refused(await send(port, { path: COMPLETE, body: JSON.stringify({ sessionRef: SESSION }) }), 503, "unavailable");
  refused(await send(port, { path: BLOCK, body: JSON.stringify({ sessionRef: SESSION, reason: REASON }) }), 503, "unavailable");
});

test("resolve_done accepts a task that needs the user and keeps its report and session", async (context) => {
  const env = await setup(context, { facts: { ...PASSING, treeClean: false } });
  startedTask(env, { checks: ["tree_clean"] });
  await complete(env);
  const reported = taskOf(env);
  assert.equal(reported.state, "needs_review");
  assert.equal(apply(env, "resolve_done", { id: "T-1" }).ok, true);
  const task = taskOf(env);
  assert.equal(task.state, "done");
  assert.deepEqual(task.report, reported.report);
  assert.equal(task.session.id, SESSION);
  assert.deepEqual(apply(env, "resolve_done", { id: "T-1" }), { ok: false, error: "conflict" });
  assert.deepEqual(apply(env, "resolve_requeue", { id: "T-1" }), { ok: false, error: "conflict" });
});

test("resolve_requeue clears the report and the link, queues the task last, and lets it be started and reported again", async (context) => {
  const env = await setup(context);
  apply(env, "create", { text: "Queued first" });
  apply(env, "queue_add", { id: "T-1" });
  startedTask(env);
  await block(env);
  assert.equal(apply(env, "resolve_requeue", { id: "T-2" }).ok, true);
  const task = taskOf(env, "T-2");
  assert.equal(task.state, "queued");
  assert.equal(task.report, null);
  assert.equal(task.session, null);
  assert.deepEqual(env.store.readBoard(REPOSITORY_ID).queue.order, ["T-1", "T-2"]);
  refused(await complete(env), 404, "not_found");
  const planned = env.store.planStart(REPOSITORY_ID, { id: "T-2" }, () => START_FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.deepEqual(env.store.bindSession({ token: planned.plan.token, sessionId: OTHER_SESSION }), { ok: true });
  assert.equal((await complete(env, OTHER_SESSION)).json.state, "done");
});

test("the resolutions refuse a task that was never started, an unknown task, and a malformed payload", async (context) => {
  const env = await setup(context);
  apply(env, "create", { text: TEXT });
  for (const action of ["resolve_done", "resolve_requeue"]) {
    assert.deepEqual(apply(env, action, { id: "T-1" }), { ok: false, error: "conflict" }, action);
    assert.deepEqual(apply(env, action, { id: "T-9" }), { ok: false, error: "not_found" }, action);
    assert.deepEqual(apply(env, action, { id: "T-1", state: "done" }), { ok: false, error: "invalid" }, action);
    assert.deepEqual(apply(env, action, {}), { ok: false, error: "invalid" }, action);
  }
  assert.equal(taskOf(env).state, "not_queued");
  // A start still waiting for its session has no link yet: it is not a task to resolve.
  const planned = env.store.planStart(REPOSITORY_ID, { id: "T-1" }, () => START_FACTS, passingGates);
  assert.equal(planned.ok, true);
  for (const action of ["resolve_done", "resolve_requeue"]) assert.deepEqual(apply(env, action, { id: "T-1" }), { ok: false, error: "conflict" }, action);
});

test("resolve_done accepts a linked task that has no report, keeps its link, and refuses the session's later report", async (context) => {
  const env = await setup(context);
  startedTask(env, { checks: ["tree_clean"] });
  const before = taskOf(env);
  assert.equal(before.state, "not_queued");
  assert.equal(before.report, null);
  assert.equal(apply(env, "resolve_done", { id: "T-1" }).ok, true);
  const task = taskOf(env);
  assert.equal(task.state, "done");
  assert.equal(task.report, null);
  assert.equal(task.session.id, SESSION);
  // The task has an outcome now: neither the exit nor a report from the running session repeats it.
  assert.deepEqual(apply(env, "resolve_done", { id: "T-1" }), { ok: false, error: "conflict" });
  assert.deepEqual(apply(env, "resolve_requeue", { id: "T-1" }), { ok: false, error: "conflict" });
  refused(await complete(env), 409, "already_reported");
  refused(await block(env), 409, "already_reported");
  assert.equal(taskOf(env).state, "done");
});

test("resolve_requeue accepts a linked task that has no report, clears the link and the dispatch, and the old session can no longer report", async (context) => {
  const env = await setup(context);
  apply(env, "create", { text: "Queued first" });
  apply(env, "queue_add", { id: "T-1" });
  startedTask(env);
  assert.equal(apply(env, "resolve_requeue", { id: "T-2" }).ok, true);
  const task = taskOf(env, "T-2");
  assert.equal(task.state, "queued");
  assert.equal(task.report, null);
  assert.equal(task.session, null);
  assert.deepEqual(env.store.readBoard(REPOSITORY_ID).queue.order, ["T-1", "T-2"]);
  assert.equal(withDatabase(env.directory, (database) => database.prepare("SELECT dispatch_token FROM tasks WHERE number = 2").get().dispatch_token), null);
  refused(await complete(env), 404, "not_found");
  refused(await block(env), 404, "not_found");
  const planned = env.store.planStart(REPOSITORY_ID, { id: "T-2" }, () => START_FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.deepEqual(env.store.bindSession({ token: planned.plan.token, sessionId: OTHER_SESSION }), { ok: true });
  assert.equal((await complete(env, OTHER_SESSION)).json.state, "done");
});

test("nothing resolves a linked task with no report by itself: the queue waits on it until the user acts", async (context) => {
  const env = await setup(context);
  startedTask(env);
  apply(env, "create", { text: "Next task" });
  apply(env, "queue_add", { id: "T-2" });
  setQueue(env, "running");
  assert.deepEqual(env.store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
  // A session the monitor still shows working, or one it holds no facts for, never changes the task.
  for (const facts of [{ state: "working", writerReleased: false }, { state: "unknown", writerReleased: false }, null]) {
    assert.deepEqual(env.store.stallEndedTasks(() => facts), { ok: true, stalled: 0 });
  }
  env.clock.now += 24 * 60 * 60 * 1000;
  assert.deepEqual(env.store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
  assert.equal(taskOf(env).state, "not_queued");
  assert.equal(env.store.readBoard(REPOSITORY_ID).queue.status, "running");
  assert.equal(apply(env, "resolve_done", { id: "T-1" }).ok, true);
  assert.deepEqual(env.store.nextQueueStarts({ resolveGateFacts: passingGates }),
    { ok: true, starts: [{ repositoryId: REPOSITORY_ID, taskId: "T-2" }] });
});

test("block_task from the bound session works on a linked task with no report and blocks the queue", async (context) => {
  const env = await setup(context);
  startedTask(env);
  startedTask(env, { session: OTHER_SESSION });
  setQueue(env, "running");
  assert.equal(taskOf(env).report, null);
  env.clock.now = 3_000_000;
  const response = await block(env);
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, state: "blocked" });
  const task = taskOf(env);
  assert.equal(task.state, "blocked");
  assert.deepEqual(task.report, { at: new Date(3_000_000).toISOString(), results: [], blockReason: REASON });
  assert.equal(task.session.id, SESSION);
  const queue = env.store.readBoard(REPOSITORY_ID).queue;
  assert.deepEqual({ status: queue.status, blockedBy: queue.blockedBy }, { status: "blocked", blockedBy: "T-1" });
  assert.deepEqual(env.store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
  // Only the bound session blocks: the other linked task is untouched.
  assert.equal(taskOf(env, "T-2").state, "not_queued");
  // The user's Requeue of the blocked task lets the queue run again.
  assert.equal(apply(env, "resolve_requeue", { id: "T-1" }).ok, true);
  assert.equal(env.store.readBoard(REPOSITORY_ID).queue.status, "running");
});

test("a failed report blocks a running queue and its resolution lets it run again", async (context) => {
  const env = await setup(context, { facts: { ...PASSING, treeClean: false } });
  startedTask(env, { checks: ["tree_clean"] });
  startedTask(env, { session: OTHER_SESSION });
  setQueue(env, "running");
  await complete(env);
  assert.deepEqual({ ...env.store.readBoard(REPOSITORY_ID).queue, order: undefined }, { status: "blocked", blockedBy: "T-1", pauseReason: null, order: undefined });
  await block(env, REASON, OTHER_SESSION);
  assert.equal(env.store.readBoard(REPOSITORY_ID).queue.blockedBy, "T-1");
  apply(env, "resolve_done", { id: "T-1" });
  let queue = env.store.readBoard(REPOSITORY_ID).queue;
  assert.equal(queue.status, "blocked");
  assert.equal(queue.blockedBy, "T-2");
  apply(env, "resolve_requeue", { id: "T-2" });
  queue = env.store.readBoard(REPOSITORY_ID).queue;
  assert.equal(queue.status, "running");
  assert.equal(queue.blockedBy, null);
});

test("a report that passes, and a queue that is not running, leave the queue status alone", async (context) => {
  const env = await setup(context, { facts: { ...PASSING, treeClean: false } });
  startedTask(env);
  setQueue(env, "running");
  await complete(env);
  assert.equal(env.store.readBoard(REPOSITORY_ID).queue.status, "running");

  for (const status of ["idle", "paused"]) {
    const other = await setup(context, { facts: { ...PASSING, treeClean: false } });
    startedTask(other, { checks: ["tree_clean"] });
    setQueue(other, status);
    await complete(other);
    assert.equal(other.store.readBoard(REPOSITORY_ID).queue.status, status);
    apply(other, "resolve_done", { id: "T-1" });
    assert.equal(other.store.readBoard(REPOSITORY_ID).queue.status, status);
  }
});


// The committed facts were read before the agent's last Git command; the report's own read is later than it.
const STALE = { ...PASSING, ciPassed: true, readAt: { tree: 500, branch: 500, pullRequests: 500, ci: 500 } };
const READ_NOW = { ...PASSING, ciPassed: true };

test("a report is verified on a read made when it arrives, not on the older committed facts", async (context) => {
  const env = await setup(context, { facts: STALE, read: () => READ_NOW });
  startedTask(env, { checks: ["pr_open", "ci_passed"] });
  const response = await complete(env);
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, state: "done", results: [{ check: "pr_open", passed: true }, { check: "ci_passed", passed: true }] });
  assert.deepEqual(env.readCalls, [SESSION]);
  assert.deepEqual(env.factCalls, [], "the committed facts are not judged when the read answered");
  assert.equal(taskOf(env).state, "done");
});

test("without the read the same report is judged on the stale committed facts and needs review", async (context) => {
  const env = await setup(context, { facts: STALE });
  startedTask(env, { checks: ["pr_open", "ci_passed"] });
  assert.equal((await complete(env)).json.state, "needs_review");
});

test("a condition the report's read finds false gives needs review", async (context) => {
  const env = await setup(context, { read: () => ({ ...READ_NOW, pullRequestStates: [], ciPassed: false }) });
  startedTask(env, { checks: ["pr_open", "commit_on_branch", "ci_passed"] });
  const response = await complete(env);
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, state: "needs_review",
    results: [{ check: "pr_open", passed: false }, { check: "commit_on_branch", passed: true }, { check: "ci_passed", passed: false }] });
  assert.equal(taskOf(env).state, "needs_review");
});

test("a read that fails falls back to the committed facts and never fails the request", async (context) => {
  const env = await setup(context, { read: () => { throw new Error("SECRET-ERROR"); } });
  startedTask(env, { checks: ["tree_clean"] });
  const response = await complete(env);
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, state: "done", results: [{ check: "tree_clean", passed: true }] });
  assert.deepEqual(env.factCalls, [SESSION]);
  const empty = await setup(context, { read: () => null });
  startedTask(empty, { checks: ["tree_clean"] });
  assert.equal((await complete(empty)).json.state, "done");
  assert.deepEqual(empty.factCalls, [SESSION]);
});

test("only a report that will be verified reads the repository", async (context) => {
  const env = await setup(context, { read: () => READ_NOW });
  // No task is linked to the session.
  refused(await complete(env), 404, "not_found");
  // A task with no checked condition completes on the report alone.
  startedTask(env, { own: "Tests pass." });
  assert.equal((await complete(env)).json.state, "done");
  // A second report changes nothing.
  refused(await complete(env), 409, "already_reported");
  // A block never reads.
  startedTask(env, { checks: ["pr_open"], session: OTHER_SESSION });
  assert.equal((await block(env, REASON, OTHER_SESSION)).json.state, "blocked");
  assert.deepEqual(env.readCalls, []);
  assert.equal(env.store.reportChecks(SESSION), null);
  assert.equal(env.store.reportChecks("not a session"), null);
});

test("reportChecks lists the checked conditions of a task that can still be reported on", async (context) => {
  const env = await setup(context);
  startedTask(env, { checks: ["pr_open", "ci_passed"] });
  assert.deepEqual(env.store.reportChecks(SESSION), ["pr_open", "ci_passed"]);
  await complete(env);
  assert.equal(env.store.reportChecks(SESSION), null);
});
