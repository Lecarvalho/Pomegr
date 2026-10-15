import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { AGENT_TASK_READ_BOUNDS, servedAgentTask } from "../../../server/serving/task-agent-read-routes.mjs";
import { OTHER_REPOSITORY, REPOSITORY, START_TIME, createTask, openTemporaryStore, startedTask } from "./queue-test-support.mjs";

const TOKEN = "f".repeat(40);
const SESSIONS = { "claude:known": REPOSITORY, "claude:other": OTHER_REPOSITORY, "claude:norepo": null };
const headers = { "x-pomegr-agent-authorization": TOKEN, "content-type": "application/json" };
const GET = "/api/agent/v1/tasks/get";
const LIST = "/api/agent/v1/tasks/list";
const LINKED = "claude:0b8f2c1e-1111-4222-8333-SESSION-SENTINEL";
const BLOCK = "BLOCK-REASON-SENTINEL";
const ATTENTION = "ATTENTION-SENTINEL";

async function start(context, store) {
  const runtime = { resolveTaskSession: (ref) => (Object.hasOwn(SESSIONS, ref) ? { found: true, repositoryId: SESSIONS[ref] } : null) };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, agentAuthorizationToken: TOKEN }));
  context.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return server.address().port;
}

function send(port, requestPath, payload, { method = "POST", sessionRef = "claude:known" } = {}) {
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
    request.end(typeof payload === "string" ? payload : JSON.stringify({ sessionRef, ...payload }));
  });
}

const refused = (response, status, reason) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: false, reason });
};

// A board with a planned task of a feature, a blocked one, one in review, one with a live dispatch, and a long one.
async function board(context) {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-agent-read-");
  const feature = store.apply(REPOSITORY, "agent_feature_create", { title: "Offline mode", description: "FEATURE-DESCRIPTION-SENTINEL" });
  createTask(store, REPOSITORY, {
    text: "Fix the cache [image:img-0123456789ab] now.", featureId: feature.featureId,
    run: { provider: "claude", model: "claude-opus-5-5", effort: "high" }, completeWhen: { checks: ["ci_passed", "pr_open"], own: "Docs updated" },
  });
  createTask(store, REPOSITORY, { text: "Started task" });
  startedTask(directory, 2, { session: LINKED });
  assert.equal(store.blockTask({ sessionId: LINKED, reason: BLOCK }).ok, true);
  createTask(store, REPOSITORY, { text: "Reviewed task" });
  startedTask(directory, 3, { session: `${LINKED}-2` });
  assert.equal(store.completeTask({ sessionId: `${LINKED}-2`, attention: ATTENTION }, () => null).ok, true);
  createTask(store, REPOSITORY, { text: "Dispatched task" });
  startedTask(directory, 4, { mintedAt: START_TIME });
  createTask(store, REPOSITORY, { text: `Long ${"y".repeat(995)}` });
  createTask(store, OTHER_REPOSITORY, { text: "OTHER-BOARD-SENTINEL" });
  return { store, directory, featureId: feature.featureId };
}

test("get_task's route answers one task of the session's own board in the served shape, and nothing else", async (context) => {
  const { store, featureId } = await board(context);
  const port = await start(context, store);
  const read = await send(port, GET, { taskId: "T-1" });
  assert.equal(read.status, 200);
  assert.equal(read.headers["cache-control"], "no-store");
  assert.deepEqual(read.json, { schemaVersion: 1, ok: true, task: {
    id: "T-1", text: "Fix the cache [image] now.", textCut: false, ownCondition: "Docs updated", completeWhen: ["pr_open", "ci_passed"],
    provider: "claude", model: "claude-opus-5-5", effort: "high", feature: "Offline mode", column: "Backlog", state: "not_queued", editable: true,
  } });
  // A started task reads too, and says update_task cannot change it; its report, session, and IDs never reach the agent.
  const started = await send(port, GET, { taskId: "T-2" });
  assert.equal(started.json.task.state, "blocked");
  assert.equal(started.json.task.editable, false);
  const reviewed = await send(port, GET, { taskId: "T-3" });
  assert.equal(reviewed.json.task.state, "needs_review");
  assert.equal(reviewed.json.task.column, "Review");
  assert.equal((await send(port, GET, { taskId: "T-4" })).json.task.editable, false);
  for (const answer of [read, started, reviewed]) {
    assert.doesNotMatch(answer.text, new RegExp(`${BLOCK}|${ATTENTION}|SESSION-SENTINEL|FEATURE-DESCRIPTION|img-|repo-|col-|${featureId}|createdAt|report|images|session`, "u"));
  }

  // An unknown task and a task of another board answer the same not_found.
  refused(await send(port, GET, { taskId: "T-99" }), 404, "not_found");
  const otherBoard = await send(port, GET, { taskId: "T-1" }, { sessionRef: "claude:other" });
  assert.equal(otherBoard.json.task.text, "OTHER-BOARD-SENTINEL");
  refused(await send(port, GET, { taskId: "T-2" }, { sessionRef: "claude:other" }), 404, "not_found");
  refused(await send(port, GET, { taskId: "T-1" }, { sessionRef: "claude:unknown" }), 404, "session_not_found");
  refused(await send(port, GET, { taskId: "T-1" }, { sessionRef: "claude:norepo" }), 409, "repository_unavailable");
});

test("list_tasks's route lists the whole board in board order, bounded, and narrows by its filters", async (context) => {
  const { store } = await board(context);
  const port = await start(context, store);
  const all = await send(port, LIST, {});
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.tasks.map((task) => task.id), ["T-1", "T-2", "T-4", "T-5", "T-3"]);
  assert.equal(all.json.matched, 5);
  assert.equal(all.json.truncated, false);
  const long = all.json.tasks.find((task) => task.id === "T-5");
  assert.equal(long.textCut, true);
  assert.equal(long.text.length, AGENT_TASK_READ_BOUNDS.listTextLength);
  assert.match(long.text, /^Long y+…$/u);
  assert.doesNotMatch(all.text, new RegExp(`${BLOCK}|${ATTENTION}|SESSION-SENTINEL|OTHER-BOARD|img-|repo-|col-|feat-`, "u"));

  const ids = async (filters) => (await send(port, LIST, filters)).json.tasks.map((task) => task.id);
  assert.deepEqual(await ids({ query: "CACHE" }), ["T-1"]);
  assert.deepEqual(await ids({ query: "docs upd" }), ["T-1"]);
  assert.deepEqual(await ids({ state: "blocked" }), ["T-2"]);
  assert.deepEqual(await ids({ feature: "Offline mode" }), ["T-1"]);
  assert.deepEqual(await ids({ editable: true }), ["T-1", "T-5"]);
  assert.deepEqual(await ids({ editable: false, query: "task" }), ["T-2", "T-4", "T-3"]);
  assert.deepEqual(await ids({ query: "nothing like it" }), []);

  for (const bad of [{ query: "" }, { query: "q".repeat(81) }, { query: "a\nb" }, { state: "running" }, { editable: "yes" }, { repositoryId: REPOSITORY }, { taskId: "T-1" }]) {
    refused(await send(port, LIST, bad), 400, "invalid");
  }
  for (const bad of [{}, { taskId: "T-0" }, { taskId: "T-1", query: "x" }]) refused(await send(port, GET, bad), 400, "invalid");
  refused(await send(port, `${LIST}?x=1`, {}), 400, "invalid");
  assert.equal((await send(port, LIST, {}, { method: "GET" })).status, 405);
});

test("list_tasks's route answers at most its fixed number of tasks and says the list was cut", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-task-agent-list-");
  for (let index = 0; index < AGENT_TASK_READ_BOUNDS.listTasks + 5; index += 1) createTask(store, REPOSITORY, { text: `Task ${index}` });
  const port = await start(context, store);
  const listed = await send(port, LIST, {});
  assert.equal(listed.json.tasks.length, AGENT_TASK_READ_BOUNDS.listTasks);
  assert.equal(listed.json.matched, AGENT_TASK_READ_BOUNDS.listTasks + 5);
  assert.equal(listed.json.truncated, true);
  // A board that was never written lists nothing, and a read writes nothing.
  const empty = await send(port, LIST, {}, { sessionRef: "claude:other" });
  assert.deepEqual(empty.json, { schemaVersion: 1, ok: true, tasks: [], matched: 0, truncated: false });
});

test("the served shape refuses any entry outside its bounds and drops every field it does not list", () => {
  const entry = { id: "T-1", text: "t", ownCondition: null, completeWhen: [], provider: null, model: null, effort: null, feature: null, column: "Ready", state: "queued", editable: true };
  assert.deepEqual(Object.keys(servedAgentTask({ ...entry, session: "s", report: {}, repositoryId: REPOSITORY, columnId: "col-0", featureId: "feat-0" })),
    ["id", "text", "textCut", "ownCondition", "completeWhen", "provider", "model", "effort", "feature", "column", "state", "editable"]);
  for (const bad of [{ id: "x" }, { text: "" }, { text: "t".repeat(4001) }, { ownCondition: "o".repeat(501) }, { completeWhen: ["merged"] }, { provider: "other" },
    { model: "m".repeat(121) }, { effort: "max" }, { feature: "f".repeat(81) }, { column: null }, { state: "running" }, { editable: "yes" }]) {
    assert.equal(servedAgentTask({ ...entry, ...bad }), null, JSON.stringify(bad));
  }
});
