import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { serveSessionDirectoryWithTasks } from "../../../server/serving/session-directory-tasks.mjs";
import { SESSION_ASSIGNED_TASKS_MAX, TASK_ASSIGNED_SESSIONS_MAX } from "../../../server/tasks/task-assignments.mjs";
import { OTHER_REPOSITORY, REPOSITORY, START_TIME, createTask, metaValue, openTemporaryStore, queueRow, queueSettings, queueTask, setMeta, startedTask, storedDispatch } from "./queue-test-support.mjs";

const AGENT = "a".repeat(40);
const DESKTOP = "d".repeat(40);
const STARTED = "claude:0b8f2c1e-1111-4222-8333-444455556666";
const HAND = "claude:1c9f3d2f-2222-4333-8444-555566667777";
const OTHER = "codex:019a0000-2222-7333-8444-555566667777";
const FOREIGN = "claude:2d0a4e3a-3333-4444-8555-666677778888";
const SESSIONS = { [STARTED]: REPOSITORY, [HAND]: REPOSITORY, [OTHER]: REPOSITORY, [FOREIGN]: OTHER_REPOSITORY };
const agentHeaders = { "x-pomegr-agent-authorization": AGENT, "content-type": "application/json" };
const desktopHeaders = { "x-pomegr-desktop-authorization": DESKTOP, "content-type": "application/json" };
const key = (number, repositoryId = REPOSITORY) => `task_assigned:${repositoryId}:T-${number}`;
const assign = (store, id, sessionId, repositoryId = REPOSITORY) => store.apply(repositoryId, "session_assign", { id, sessionId });
const unassign = (store, id, sessionId, repositoryId = REPOSITORY) => store.apply(repositoryId, "session_unassign", { id, sessionId });
const task = (store, id, repositoryId = REPOSITORY) => store.readBoard(repositoryId).tasks.find((entry) => entry.id === id);

async function serve(context, store, { facts = null } = {}) {
  const calls = [];
  const runtime = {
    resolveTaskSession: (ref) => (Object.hasOwn(SESSIONS, ref) ? { found: true, repositoryId: SESSIONS[ref] } : null),
    resolveTaskCheckFacts: (ref) => { calls.push(ref); return facts; },
  };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: DESKTOP, agentAuthorizationToken: AGENT }));
  context.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  const send = (requestPath, body, headers = agentHeaders) => new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: requestPath, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* text */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
  return { calls, agent: (name, body) => send(`/api/agent/v1/tasks/${name}`, body), desktop: (action, payload, repositoryId = REPOSITORY) => send(`/internal/tasks/${action}`, { repositoryId, payload }, desktopHeaders) };
}

test("assigning is a marker: it stores the session, shows it on the board, and changes no state, column, or queue place", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  queueTask(store, "T-1");
  const before = task(store, "T-1");
  const queue = store.readBoard(REPOSITORY).queue;
  assert.equal(assign(store, "T-1", HAND).ok, true);
  const after = task(store, "T-1");
  assert.deepEqual(after.assigned, [{ id: HAND, title: null, state: "unknown", observedModel: null }]);
  assert.deepEqual({ ...after, assigned: undefined }, { ...before, assigned: undefined });
  assert.deepEqual(store.readBoard(REPOSITORY).queue, queue);
  assert.equal(after.session, null);
  assert.equal(metaValue(directory, key(1)), JSON.stringify([HAND]));
  // The task has not started, so it still takes a change, and the queue may still start it.
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-1", text: "changed" }).ok, true);
  assert.deepEqual(store.readBoard(REPOSITORY).queue.order, ["T-1"]);
});

test("a task holds many sessions and a session many tasks; assigning twice changes nothing", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  for (const [id, session] of [["T-1", HAND], ["T-1", OTHER], ["T-1", HAND], ["T-2", HAND]]) assert.equal(assign(store, id, session).ok, true);
  assert.deepEqual(task(store, "T-1").assigned.map((session) => session.id), [HAND, OTHER]);
  assert.deepEqual(task(store, "T-2").assigned.map((session) => session.id), [HAND]);
  assert.equal(metaValue(directory, key(1)), JSON.stringify([HAND, OTHER]));
  assert.deepEqual(store.sessionAssignedTasks([HAND, OTHER, STARTED]).get(HAND).map((entry) => entry.id), ["T-1", "T-2"]);
  assert.equal(store.sessionAssignedTasks([STARTED]).has(STARTED), false);
});

test("assign refuses a done task, the task's own started session, an unknown task, a full task, and a full session", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  for (let index = 0; index < SESSION_ASSIGNED_TASKS_MAX + 3; index += 1) createTask(store);
  startedTask(directory, 1, { session: STARTED });
  assert.deepEqual(assign(store, "T-1", STARTED), { ok: false, error: "conflict" });
  startedTask(directory, 2, { state: "done" });
  assert.deepEqual(assign(store, "T-2", HAND), { ok: false, error: "conflict" });
  assert.deepEqual(assign(store, "T-999", HAND), { ok: false, error: "not_found" });
  for (const payload of [{ id: "T-1" }, { id: "T-1", sessionId: "bad id" }, { id: "x", sessionId: HAND }, { id: "T-1", sessionId: HAND, extra: 1 }]) {
    assert.deepEqual(store.apply(REPOSITORY, "session_assign", payload), { ok: false, error: "invalid" });
    assert.deepEqual(store.apply(REPOSITORY, "session_unassign", payload), { ok: false, error: "invalid" });
  }
  for (let index = 0; index < TASK_ASSIGNED_SESSIONS_MAX; index += 1) assert.equal(assign(store, "T-3", `claude:filler-${index}`).ok, true);
  assert.deepEqual(assign(store, "T-3", HAND), { ok: false, error: "limit" });
  for (let index = 0; index < SESSION_ASSIGNED_TASKS_MAX; index += 1) assert.equal(assign(store, `T-${index + 4}`, OTHER).ok, true);
  assert.deepEqual(assign(store, "T-1", OTHER), { ok: false, error: "limit" });
});

test("unassign removes one assignment and the last one removes the row; deleting the task removes them all", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  assign(store, "T-1", HAND);
  assign(store, "T-1", OTHER);
  assign(store, "T-2", HAND);
  assert.deepEqual(unassign(store, "T-1", STARTED), { ok: false, error: "not_found" });
  assert.equal(unassign(store, "T-1", HAND).ok, true);
  assert.deepEqual(task(store, "T-1").assigned.map((session) => session.id), [OTHER]);
  assert.equal(unassign(store, "T-1", OTHER).ok, true);
  assert.equal(Object.hasOwn(task(store, "T-1"), "assigned"), false);
  assert.equal(metaValue(directory, key(1)), null);
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-2" }).ok, true);
  assert.equal(metaValue(directory, key(2)), null);
  assert.equal(store.sessionAssignedTasks([HAND]).has(HAND), false);
});

test("a stored list outside the contract reads as none and never as raw text", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  setMeta(directory, key(1), "not json");
  assert.equal(Object.hasOwn(task(store, "T-1"), "assigned"), false);
  setMeta(directory, key(1), JSON.stringify([HAND, "bad id", 7, HAND]));
  assert.deepEqual(task(store, "T-1").assigned.map((session) => session.id), [HAND]);
});

test("the board fills an assigned session with the borrowed facts and no reading of the conditions", async (context) => {
  const { store } = await openTemporaryStore(context);
  createTask(store, REPOSITORY, { completeWhen: { checks: ["tree_clean"], own: null } });
  assign(store, "T-1", HAND);
  const board = store.readBoard(REPOSITORY, {
    resolveSessionFacts: (id) => (id === HAND ? { title: "Resume the work", state: "working", observedModel: "model-large" } : null),
    resolveCheckFacts: () => { throw new Error("an assigned session reads no condition"); },
  });
  assert.deepEqual(board.tasks[0].assigned, [{ id: HAND, title: "Resume the work", state: "working", observedModel: "model-large" }]);
});

test("an assigned session reports a task that has not started: it goes to Review, and a start still in flight links nothing", async (context) => {
  const { store, directory, clock } = await openTemporaryStore(context);
  createTask(store);
  queueTask(store, "T-1");
  startedTask(directory, 1, { mintedAt: START_TIME });
  assign(store, "T-1", HAND);
  assert.deepEqual(store.completeTask({ sessionId: HAND }, () => null), { ok: true, state: "needs_review", results: [] });
  const reported = task(store, "T-1");
  assert.equal(reported.state, "needs_review");
  assert.equal(store.readBoard(REPOSITORY).columns.find((column) => column.id === reported.columnId).role, "review");
  assert.equal(storedDispatch(directory, 1), null);
  clock.now += 1;
  assert.deepEqual(store.completeTask({ sessionId: HAND }, () => null), { ok: true, state: "needs_review", results: [] });
});

test("the latest report wins among the started session and assigned ones while the owner hold remains", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  startedTask(directory, 1, { session: STARTED });
  assign(store, "T-1", HAND);
  assign(store, "T-1", OTHER);
  assert.deepEqual(store.blockTask({ sessionId: HAND, reason: "Needs a decision" }), { ok: true, state: "blocked" });
  assert.deepEqual(store.completeTask({ sessionId: STARTED }, () => null), { ok: true, state: "needs_review", results: [], ownerHold: true });
  assert.deepEqual(store.completeTask({ sessionId: OTHER }, () => null), { ok: true, state: "needs_review", results: [], ownerHold: true });
  assert.equal(task(store, "T-1").report.blockReason, null);
});

test("an assigned session reports a stalled task and frees the queue; the started session may update the report", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  queueTask(store, "T-2");
  startedTask(directory, 1, { session: STARTED, state: "stalled" });
  assert.equal(queueSettings(store, true).ok, true);
  assert.deepEqual(queueRow(directory), { queue_status: "blocked", queue_blocked_by: "T-1" });
  assign(store, "T-1", HAND);
  assert.deepEqual(store.completeTask({ sessionId: HAND }, () => null), { ok: true, state: "needs_review", results: [] });
  assert.equal(task(store, "T-1").state, "needs_review");
  assert.deepEqual(store.completeTask({ sessionId: STARTED }, () => null), { ok: true, state: "needs_review", results: [] });
  assert.deepEqual(queueRow(directory), { queue_status: "running", queue_blocked_by: null });
});

test("a session with several tasks names the one it reports, and only a task of its own", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  for (let index = 0; index < 3; index += 1) createTask(store);
  startedTask(directory, 1, { session: HAND });
  assign(store, "T-2", HAND);
  assert.deepEqual(store.completeTask({ sessionId: HAND }, () => null), { ok: false, error: "task_required" });
  assert.deepEqual(store.blockTask({ sessionId: HAND, reason: "x" }), { ok: false, error: "task_required" });
  assert.deepEqual(store.completeTask({ sessionId: HAND, taskId: "T-3" }, () => null), { ok: false, error: "not_found" });
  assert.deepEqual(store.completeTask({ sessionId: HAND, taskId: "bad" }, () => null), { ok: false, error: "invalid" });
  assert.equal(store.completeTask({ sessionId: HAND, taskId: "T-2" }, () => null).ok, true);
  assert.equal(store.blockTask({ sessionId: HAND, taskId: "T-1", reason: "x" }).ok, true);
  assert.equal(task(store, "T-2").state, "needs_review");
  assert.equal(task(store, "T-1").state, "blocked");
  assert.deepEqual(store.completeTask({ sessionId: OTHER }, () => null), { ok: false, error: "not_found" });
});

test("an unassigned session can no longer report, and a requeue keeps the assignment so the session reports again", async (context) => {
  const { store } = await openTemporaryStore(context);
  createTask(store);
  assign(store, "T-1", HAND);
  assign(store, "T-1", OTHER);
  unassign(store, "T-1", OTHER);
  assert.deepEqual(store.completeTask({ sessionId: OTHER }, () => null), { ok: false, error: "not_found" });
  assert.equal(store.completeTask({ sessionId: HAND }, () => null).ok, true);
  assert.equal(store.apply(REPOSITORY, "resolve_requeue", { id: "T-1" }).ok, true);
  assert.deepEqual(task(store, "T-1").assigned.map((session) => session.id), [HAND]);
  assert.equal(store.completeTask({ sessionId: HAND }, () => null).ok, true);
});

test("the agent routes assign and unassign the bound session on its own board and answer a fixed status only", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store, REPOSITORY, { text: "SECRET-TASK-TEXT" });
  startedTask(directory, 1, { session: STARTED });
  const { agent } = await serve(context, store);
  const ok = await agent("assign", { sessionRef: HAND, taskId: "T-1" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { schemaVersion: 1, ok: true });
  assert.deepEqual(task(store, "T-1").assigned.map((session) => session.id), [HAND]);
  for (const [name, body, status, reason] of [
    ["assign", { sessionRef: STARTED, taskId: "T-1" }, 409, "conflict"],
    ["assign", { sessionRef: HAND, taskId: "T-9" }, 404, "not_found"],
    // A session of another repository reaches only its own board, where the task does not exist.
    ["assign", { sessionRef: FOREIGN, taskId: "T-1" }, 404, "not_found"],
    ["assign", { sessionRef: "claude:unknown", taskId: "T-1" }, 404, "session_not_found"],
    ["assign", { sessionRef: HAND, taskId: "T-1", repositoryId: REPOSITORY }, 400, "invalid"],
    ["assign", { sessionRef: HAND }, 400, "invalid"],
    ["unassign", { sessionRef: OTHER, taskId: "T-1" }, 404, "not_found"],
    ["unassign", { sessionRef: HAND, taskId: "nope" }, 400, "invalid"],
  ]) {
    const response = await agent(name, body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.deepEqual(response.json, { schemaVersion: 1, ok: false, reason });
    assert.equal(response.text.includes("SECRET"), false);
  }
  assert.deepEqual((await agent("unassign", { sessionRef: HAND, taskId: "T-1" })).json, { schemaVersion: 1, ok: true });
  assert.equal(Object.hasOwn(task(store, "T-1"), "assigned"), false);
});

test("the report routes take a task ID, verify on the reporting session's facts, and answer task_required", async (context) => {
  const { store } = await openTemporaryStore(context);
  createTask(store, REPOSITORY, { completeWhen: { checks: ["tree_clean"], own: null } });
  createTask(store);
  assign(store, "T-1", HAND);
  assign(store, "T-2", HAND);
  const facts = { treeClean: true, branchCommits: true, pullRequestStates: [], ciPassed: null, readAt: { tree: 2000, branch: 2000, pullRequests: 2000, ci: 2000 }, workAt: { tree: 1000, repository: 1000 } };
  const { agent, calls } = await serve(context, store, { facts });
  const bare = await agent("complete", { sessionRef: HAND });
  assert.equal(bare.status, 409);
  assert.deepEqual(bare.json, { schemaVersion: 1, ok: false, reason: "task_required" });
  const named = await agent("complete", { sessionRef: HAND, taskId: "T-1" });
  assert.deepEqual(named.json, { schemaVersion: 1, ok: true, state: "needs_review", results: [{ check: "tree_clean", passed: true }] });
  assert.deepEqual(calls, [HAND]);
  assert.deepEqual((await agent("block", { sessionRef: HAND, taskId: "T-2", reason: "Needs a decision" })).json, { schemaVersion: 1, ok: true, state: "blocked" });
  assert.equal((await agent("complete", { sessionRef: HAND, taskId: "T-1", extra: 1 })).status, 400);
  assert.equal((await agent("block", { sessionRef: HAND, taskId: "bad", reason: "x" })).status, 400);
});

test("get_feature reads the feature of an assigned task, and asks for the task when the session has several", async (context) => {
  const { store } = await openTemporaryStore(context);
  const featureId = store.apply(REPOSITORY, "agent_feature_create", { title: "Upload reliability", description: "Shared context" }).featureId;
  createTask(store, REPOSITORY, { featureId });
  createTask(store);
  assign(store, "T-1", HAND);
  const { agent } = await serve(context, store);
  const read = await agent("feature-get", { sessionRef: HAND });
  assert.deepEqual(read.json.feature, { id: featureId, title: "Upload reliability", description: "Shared context", appVersion: null });
  assign(store, "T-2", HAND);
  assert.deepEqual((await agent("feature-get", { sessionRef: HAND })).json, { schemaVersion: 1, ok: false, reason: "task_required" });
  assert.equal((await agent("feature-get", { sessionRef: HAND, taskId: "T-1" })).json.feature.id, featureId);
  assert.deepEqual((await agent("feature-get", { sessionRef: HAND, taskId: "T-2" })).json, { schemaVersion: 1, ok: false, reason: "not_found" });
  assert.equal((await agent("feature-get", { sessionRef: HAND, taskId: "T-1", feature: "Upload reliability" })).status, 400);
});

test("the owner assigns only a session of the board's repository, and unassigns through the same route", async (context) => {
  const { store } = await openTemporaryStore(context);
  createTask(store);
  const { desktop } = await serve(context, store);
  const assigned = await desktop("session_assign", { id: "T-1", sessionId: HAND });
  assert.equal(assigned.status, 200);
  assert.deepEqual(assigned.json.board.tasks[0].assigned.map((session) => session.id), [HAND]);
  for (const sessionId of [FOREIGN, "claude:unknown"]) {
    const refused = await desktop("session_assign", { id: "T-1", sessionId });
    assert.equal(refused.status, 404);
    assert.deepEqual(refused.json, { ok: false, error: "not_found" });
  }
  const removed = await desktop("session_unassign", { id: "T-1", sessionId: HAND });
  assert.equal(removed.status, 200);
  assert.equal(Object.hasOwn(removed.json.board.tasks[0], "assigned"), false);
});

test("the Sessions list carries a session's assigned tasks beside the one it was started for, and only when it has one", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store, REPOSITORY, { text: "SECRET-TASK-TEXT" });
  createTask(store);
  startedTask(directory, 1, { session: HAND });
  assign(store, "T-2", HAND);
  assign(store, "T-1", OTHER);
  const runtime = { serveSessionDirectory: () => ({ revision: 1, sessions: [{ id: HAND }, { id: OTHER }, { id: STARTED }] }) };
  const page = serveSessionDirectoryWithTasks({ runtime, taskStore: store, allowed: true, query: {} });
  const reference = (id, state = null) => ({ id, repositoryId: REPOSITORY, state, featureId: null, feature: null, issue: null });
  assert.deepEqual(page.sessions, [
    { id: HAND, task: reference("T-1"), assignedTasks: [reference("T-2")] },
    { id: OTHER, task: null, assignedTasks: [reference("T-1")] },
    { id: STARTED, task: null },
  ]);
  assert.equal(JSON.stringify(page).includes("SECRET"), false);
  const denied = serveSessionDirectoryWithTasks({ runtime, taskStore: store, allowed: false, query: {} });
  assert.deepEqual(denied.sessions, [{ id: HAND }, { id: OTHER }, { id: STARTED }]);
});
