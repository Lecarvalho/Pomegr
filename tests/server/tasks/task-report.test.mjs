import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTaskCheckFacts } from "../../../server/runtime/task-session-lookup.mjs";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

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
const PASSING = { treeClean: true, branchCommits: true, pullRequestStates: ["open"], ciPassed: null };

async function setup(context, { facts = PASSING } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-report-"));
  const clock = { now: 1_000_000 };
  const env = { facts, factCalls: [], clock, directory };
  env.store = openTaskStore({ directory, now: () => clock.now });
  const server = http.createServer(createRequestHandler({
    runtime: { resolveTaskCheckFacts: (ref) => { env.factCalls.push(ref); return env.facts; } },
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
  const planned = env.store.planStart(REPOSITORY_ID, { id }, () => START_FACTS);
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
  const env = await setup(context, { facts: { treeClean: false, branchCommits: true, pullRequestStates: null, ciPassed: null, secret: "SECRET-FACT" } });
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
  const planned = env.store.planStart(REPOSITORY_ID, { id: "T-2" }, () => START_FACTS);
  assert.equal(planned.ok, true);
  assert.deepEqual(env.store.bindSession({ token: planned.plan.token, sessionId: OTHER_SESSION }), { ok: true });
  assert.equal((await complete(env, OTHER_SESSION)).json.state, "done");
});

test("the resolutions refuse a task with no outcome, an unknown task, and a malformed payload", async (context) => {
  const env = await setup(context);
  startedTask(env);
  for (const action of ["resolve_done", "resolve_requeue"]) {
    assert.deepEqual(apply(env, action, { id: "T-1" }), { ok: false, error: "conflict" }, action);
    assert.deepEqual(apply(env, action, { id: "T-9" }), { ok: false, error: "not_found" }, action);
    assert.deepEqual(apply(env, action, { id: "T-1", state: "done" }), { ok: false, error: "invalid" }, action);
    assert.deepEqual(apply(env, action, {}), { ok: false, error: "invalid" }, action);
  }
  assert.equal(taskOf(env).state, "not_queued");
});

test("a failed report blocks a running queue and its resolution lets it run again", async (context) => {
  const env = await setup(context, { facts: { ...PASSING, treeClean: false } });
  startedTask(env, { checks: ["tree_clean"] });
  startedTask(env, { session: OTHER_SESSION });
  setQueue(env, "running");
  await complete(env);
  assert.deepEqual({ ...env.store.readBoard(REPOSITORY_ID).queue, order: undefined }, { status: "blocked", blockedBy: "T-1", order: undefined });
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

function observation(session) {
  return { observationStore: { get: (providerId, localId) => (providerId === "claude" && localId === "0b8f2c1e-1111-4222-8333-444455556666" ? { publicState: { session } } : undefined) } };
}
const repository = (overrides = {}) => ({
  available: true, historical: false, branch: "tasks/12", isMain: false, files: [],
  comparison: { branch: "main", kind: "base", ahead: 2, behind: 0, integrated: false }, ...overrides,
});
const pulls = (...items) => ({ status: "ready", checkedAt: null, items });
const pull = (state, headBranch = "tasks/12") => ({ state, headBranch, title: "SECRET-TITLE", url: "https://example.invalid/SECRET" });

test("check facts come from the session's committed repository state and carry no content", () => {
  const facts = resolveTaskCheckFacts(SESSION, observation({ repository: repository(), pullRequests: pulls(pull("open"), pull("merged", "other"), pull("unknown")) }));
  assert.deepEqual(facts, { treeClean: true, branchCommits: true, pullRequestStates: ["open"], ciPassed: null });
  assert.doesNotMatch(JSON.stringify(facts), /SECRET|tasks\/12/u);
  const dirty = resolveTaskCheckFacts(SESSION, observation({ repository: repository({ files: [{ status: "M", path: "a.txt" }] }), pullRequests: pulls() }));
  assert.deepEqual(dirty, { treeClean: false, branchCommits: true, pullRequestStates: [], ciPassed: false });
  const merged = resolveTaskCheckFacts(SESSION, observation({
    repository: repository({ comparison: { branch: "main", kind: "base", ahead: 0, behind: 0, integrated: true } }), pullRequests: pulls(pull("merged")),
  }));
  assert.deepEqual(merged, { treeClean: true, branchCommits: true, pullRequestStates: ["merged"], ciPassed: null });
});

test("CI passed joins the task branch's pull requests with the check status the monitor last read", () => {
  const url = (number) => `https://github.com/PomegrHQ/pomegr/pull/${number}`;
  const numbered = (number, state, headBranch = "tasks/12") => ({ state, headBranch, url: url(number) });
  const ci = (items, statuses) => resolveTaskCheckFacts(SESSION, {
    ...observation({ repository: repository(), pullRequests: pulls(...items) }),
    checkStatus: (value) => statuses[value] ?? null,
  }).ciPassed;

  assert.equal(ci([numbered(1, "open")], { [url(1)]: "passed" }), true);
  for (const status of ["failed", "pending", "none"]) assert.equal(ci([numbered(1, "open")], { [url(1)]: status }), false, status);
  // A check status the monitor has not read is unknown, and it is never read here.
  assert.equal(ci([numbered(1, "open")], {}), null);
  assert.equal(ci([numbered(1, "open"), numbered(2, "open")], { [url(1)]: "passed" }), null);
  assert.equal(ci([numbered(1, "open"), numbered(2, "open")], { [url(1)]: "passed", [url(2)]: "failed" }), false);
  // An open pull request is judged before a merged one; a closed one and another branch's never count.
  assert.equal(ci([numbered(1, "open"), numbered(2, "merged"), numbered(3, "closed")], { [url(1)]: "passed", [url(2)]: "failed", [url(3)]: "failed" }), true);
  assert.equal(ci([numbered(2, "merged"), numbered(3, "closed")], { [url(2)]: "passed", [url(3)]: "failed" }), true);
  assert.equal(ci([numbered(3, "closed")], { [url(3)]: "passed" }), false);
  assert.equal(ci([numbered(4, "open", "other")], { [url(4)]: "passed" }), false);
  assert.equal(ci([], {}), false);

  const facts = resolveTaskCheckFacts(SESSION, { ...observation({ repository: repository(), pullRequests: pulls(numbered(1, "open")) }), checkStatus: () => "passed" });
  assert.deepEqual(facts, { treeClean: true, branchCommits: true, pullRequestStates: ["open"], ciPassed: true });
  const notReady = resolveTaskCheckFacts(SESSION, {
    ...observation({ repository: repository(), pullRequests: { status: "unavailable", checkedAt: null, items: [numbered(1, "open")] } }), checkStatus: () => "passed",
  });
  assert.equal(notReady.ciPassed, null);
});

test("check facts the committed state does not establish are unknown", () => {
  const unknown = { treeClean: null, branchCommits: null, pullRequestStates: null, ciPassed: null };
  assert.deepEqual(resolveTaskCheckFacts("not a session", observation({ repository: repository() })), unknown);
  assert.deepEqual(resolveTaskCheckFacts(OTHER_SESSION, observation({ repository: repository() })), unknown);
  assert.deepEqual(resolveTaskCheckFacts(SESSION, observation({ repository: repository({ available: false }), pullRequests: pulls(pull("open")) })), unknown);
  assert.deepEqual(resolveTaskCheckFacts(SESSION, observation({ repository: repository({ historical: true }), pullRequests: pulls(pull("open")) })), unknown);
  const partial = resolveTaskCheckFacts(SESSION, observation({ repository: repository({ comparison: null }), pullRequests: { status: "unavailable", checkedAt: null, items: [pull("open")] } }));
  assert.deepEqual(partial, { treeClean: true, branchCommits: null, pullRequestStates: null, ciPassed: null });
  const main = resolveTaskCheckFacts(SESSION, observation({ repository: repository({ isMain: true, comparison: { branch: "origin/main", kind: "upstream", ahead: 3, behind: 0, integrated: false } }) }));
  assert.equal(main.branchCommits, false);
});
