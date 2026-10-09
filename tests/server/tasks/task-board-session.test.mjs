import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskLookups } from "../../../server/runtime/task-start-lookup.mjs";
import { resolveTaskSessionFacts } from "../../../server/runtime/task-session-lookup.mjs";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_SESSION_STATES, TASK_SESSION_TITLE_LENGTH, fillTaskSessions } from "../../../server/tasks/task-board.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { passingGates } from "./queue-test-support.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const DESKTOP = "d".repeat(40);
const SESSION = "claude:0b8f2c1e-1111-4222-8333-444455556666";
const FACTS = { root: "C:/Work/repo", pluginReady: true };
const desktopHeaders = { "x-pomegr-desktop-authorization": DESKTOP, "content-type": "application/json" };
const BACKSLASH = String.fromCharCode(92);
const LINE_BREAK = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);

const unlinked = (id) => ({ id, text: `task ${id}`, session: null });
const linked = (id, sessionId) => ({ id, text: `task ${id}`, session: { id: sessionId, title: null, state: "unknown", observedModel: null } });
const UNKNOWN = (id) => ({ id, title: null, state: "unknown", observedModel: null });

test("a linked task is filled from the resolver and an unlinked task stays null", () => {
  const board = { version: 1, readiness: "ready", tasks: [linked("T-1", SESSION), unlinked("T-2")], queue: { order: [] } };
  const frozen = structuredClone(board);
  const calls = [];
  const filled = fillTaskSessions(board, (id) => {
    calls.push(id);
    return { title: "Fix the flaky test", state: "working", observedModel: "claude-opus-4-1" };
  });
  assert.deepEqual(calls, [SESSION]);
  assert.deepEqual(filled.tasks[0].session, { id: SESSION, title: "Fix the flaky test", state: "working", observedModel: "claude-opus-4-1" });
  assert.equal(filled.tasks[1], board.tasks[1]);
  assert.equal(filled.tasks[1].session, null);
  assert.deepEqual(filled.queue, board.queue);
  assert.deepEqual(board, frozen);
  assert.notEqual(filled, board);
});

test("no facts, a throwing resolver, or no resolver gives the unknown session", () => {
  const board = { tasks: [linked("T-1", SESSION)] };
  const expected = [UNKNOWN(SESSION)];
  for (const resolver of [() => null, () => undefined, () => "claude", () => 7, () => ({}), () => { throw new Error("catalog gone"); }, undefined, null, "not a function"]) {
    assert.deepEqual(fillTaskSessions(board, resolver).tasks.map((task) => task.session), expected);
  }
});

test("an invalid state falls back to unknown; every catalog state is kept as given", () => {
  const board = { tasks: [linked("T-1", SESSION)] };
  const stateOf = (state) => fillTaskSessions(board, () => ({ state })).tasks[0].session.state;
  assert.deepEqual(TASK_SESSION_STATES, ["working", "needs_input", "idle", "open", "stopped", "closed", "unknown"]);
  for (const state of TASK_SESSION_STATES) assert.equal(stateOf(state), state);
  for (const state of ["running", "Working", " working", "done", "", null, undefined, 3, {}, ["working"]]) assert.equal(stateOf(state), "unknown");
});

test("a title must be a bounded one-line string, else it is null", () => {
  const board = { tasks: [linked("T-1", SESSION)] };
  const titleOf = (title) => fillTaskSessions(board, () => ({ title })).tasks[0].session.title;
  assert.equal(titleOf("Fix the flaky test"), "Fix the flaky test");
  assert.equal(titleOf("  padded  "), "padded");
  assert.equal(titleOf("t".repeat(TASK_SESSION_TITLE_LENGTH)), "t".repeat(TASK_SESSION_TITLE_LENGTH));
  assert.equal(TASK_SESSION_TITLE_LENGTH, 160);
  for (const title of ["", "   ", "t".repeat(TASK_SESSION_TITLE_LENGTH + 1), `two${LINE_BREAK}lines`, `nul${NUL}byte`, `a${LONE_SURROGATE}b`, 42, null, undefined, {}, ["x"]]) {
    assert.equal(titleOf(title), null, JSON.stringify(title));
  }
});

test("an observed model is validated like the request model identifier, else it is null", () => {
  const board = { tasks: [linked("T-1", SESSION)] };
  const modelOf = (observedModel) => fillTaskSessions(board, () => ({ observedModel })).tasks[0].session.observedModel;
  assert.equal(modelOf("claude-opus-4-1"), "claude-opus-4-1");
  assert.equal(modelOf("gpt-5.2-codex"), "gpt-5.2-codex");
  assert.equal(modelOf(" claude-sonnet-4 "), "claude-sonnet-4");
  assert.equal(modelOf("m".repeat(120)), "m".repeat(120));
  const invalid = [
    "m".repeat(121), "C:/models/opus", ["C:", "models"].join(BACKSLASH), "../model", "/usr/share/model", "<b>opus</b>", "Claude Opus is the best model",
    `a${LINE_BREAK}b`, "", "unknown", "Unknown", "UNKNOWN", 5, null, undefined, {},
  ];
  for (const model of invalid) assert.equal(modelOf(model), null, JSON.stringify(model));
});

test("a field that fails validation degrades alone", () => {
  const board = { tasks: [linked("T-1", SESSION)] };
  const [task] = fillTaskSessions(board, () => ({ title: "Good title", state: "bogus", observedModel: "../x" })).tasks;
  assert.deepEqual(task.session, { id: SESSION, title: "Good title", state: "unknown", observedModel: null });
});

test("the projection adds no key and carries no other fact the resolver returns", () => {
  const board = { tasks: [linked("T-1", SESSION)] };
  const [task] = fillTaskSessions(board, () => ({
    title: "t", state: "idle", observedModel: "claude-opus-4-1", cwd: "C:/secret", transcript: "path", token: "digest", repositoryId: REPOSITORY_ID,
  })).tasks;
  assert.deepEqual(Object.keys(task.session), ["id", "title", "state", "observedModel"]);
});

test("a board without a task list is returned as given", () => {
  for (const board of [null, undefined, {}, { tasks: "x" }]) assert.equal(fillTaskSessions(board, () => ({ state: "idle" })), board);
});

// The route plumbing: a real store, a linked task, and a runtime that holds only what committed state would.
async function serving(context, runtime) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-session-"));
  const store = openTaskStore({ directory });
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: DESKTOP }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise((done) => server.close(done));
    store.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; } catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return { store, port: server.address().port };
}

function send(port, { method = "GET", path: requestPath, headers = desktopHeaders, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, headers: response.headers, text, json: JSON.parse(text) });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

const getBoard = (port, headers) => send(port, { path: `/api/tasks?repositoryId=${REPOSITORY_ID}`, ...(headers ? { headers } : {}) });

function linkTask(store, text = "Fix the SECRET-TASK-TEXT flaky test", sessionId = SESSION) {
  assert.equal(store.apply(REPOSITORY_ID, "create", { text }).ok, true);
  const number = Number(store.readBoard(REPOSITORY_ID).tasks.at(-1).id.slice(2));
  const planned = store.planStart(REPOSITORY_ID, { id: `T-${number}` }, () => FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.deepEqual(store.bindSession({ token: planned.plan.token, sessionId }), { ok: true });
}

test("GET /api/tasks fills a linked session only from the resolver handed in", async (context) => {
  const calls = [];
  const runtime = {
    resolveTaskSessionFacts(id) {
      calls.push(id);
      return { title: "Fix the flaky test", state: "needs_input", observedModel: "claude-opus-4-1" };
    },
  };
  const { store, port } = await serving(context, runtime);
  linkTask(store);
  assert.equal(store.apply(REPOSITORY_ID, "create", { text: "not started" }).ok, true);
  const response = await getBoard(port);
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json.tasks[0].session, { id: SESSION, title: "Fix the flaky test", state: "needs_input", observedModel: "claude-opus-4-1" });
  assert.equal(response.json.tasks[1].session, null);
  assert.deepEqual(calls, [SESSION]);
  // The stored board is untouched: the facts are borrowed per read, never persisted.
  assert.deepEqual(store.readBoard(REPOSITORY_ID).tasks[0].session, UNKNOWN(SESSION));
});

test("without a resolver the GET serves a linked session as unknown", async (context) => {
  for (const runtime of [{}, { resolveTaskSessionFacts: "not a function" }]) {
    const { store, port } = await serving(context, runtime);
    linkTask(store);
    const response = await getBoard(port);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.tasks[0].session, UNKNOWN(SESSION));
  }
});

test("a resolver that throws or returns junk degrades each field and never fails the GET", async (context) => {
  const throwing = await serving(context, { resolveTaskSessionFacts() { throw new Error("SECRET-CATALOG-FAILURE"); } });
  linkTask(throwing.store);
  const failed = await getBoard(throwing.port);
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.json.tasks[0].session, UNKNOWN(SESSION));
  assert.ok(!failed.text.includes("SECRET-CATALOG-FAILURE"));
  const junk = await serving(context, {
    resolveTaskSessionFacts: () => ({ title: `bad${LINE_BREAK}title`, state: "exploding", observedModel: "C:/secret/model", cwd: "C:/secret" }),
  });
  linkTask(junk.store);
  const served = await getBoard(junk.port);
  assert.deepEqual(served.json.tasks[0].session, UNKNOWN(SESSION));
  assert.ok(!served.text.includes("secret"));
});

test("a GET with no linked task never reads the session lookup, and a denied client reads nothing", async (context) => {
  const accessed = [];
  const runtime = new Proxy({}, { get(_target, key) { accessed.push(String(key)); return undefined; } });
  const { store, port } = await serving(context, runtime);
  assert.equal(store.apply(REPOSITORY_ID, "create", { text: "plain" }).ok, true);
  assert.equal((await getBoard(port)).status, 200);
  assert.ok(!accessed.includes("resolveTaskSessionFacts"), accessed.join());
  linkTask(store, "linked");
  accessed.length = 0;
  const denied = await getBoard(port, { "content-type": "application/json" });
  assert.equal(denied.json.readiness, "desktop_only");
  assert.deepEqual(denied.json.tasks, []);
  assert.ok(!denied.text.includes("linked") && !denied.text.includes(SESSION));
  assert.ok(!accessed.includes("resolveTaskSessionFacts"), accessed.join());
});

test("the board a mutation answers carries the same filled session", async (context) => {
  const runtime = { resolveTaskSessionFacts: () => ({ title: "Borrowed title", state: "working", observedModel: "claude-sonnet-4" }) };
  const { store, port } = await serving(context, runtime);
  linkTask(store, "original text");
  const response = await send(port, {
    method: "POST", path: "/internal/tasks/update",
    body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { id: "T-1", text: "edited text" } }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.deepEqual(response.json.board.tasks[0].session, { id: SESSION, title: "Borrowed title", state: "working", observedModel: "claude-sonnet-4" });
  assert.equal(response.json.board.tasks[0].text, "edited text");
});

test("the store fills sessions only when it is handed a resolver", async (context) => {
  const { store } = await serving(context, {});
  linkTask(store);
  assert.deepEqual(store.readBoard(REPOSITORY_ID).tasks[0].session, UNKNOWN(SESSION));
  const filled = store.readBoard(REPOSITORY_ID, { resolveSessionFacts: () => ({ title: "t", state: "idle", observedModel: null }) });
  assert.equal(filled.tasks[0].session.state, "idle");
  assert.equal(store.apply(REPOSITORY_ID, "update", { id: "T-1", text: "x" }).board.tasks[0].session.state, "unknown");
  const applied = store.apply(REPOSITORY_ID, "update", { id: "T-1", text: "y" }, { resolveSessionFacts: () => ({ state: "stopped" }) });
  assert.equal(applied.board.tasks[0].session.state, "stopped");
});

// The runtime lookup: committed catalog row and committed public state, nothing else.
const catalogRow = (overrides) => ({ id: SESSION, title: "Fix the flaky test", activityStatus: "working", isLive: true, ...overrides });
const storeWith = (publicState) => ({ get: (provider, id) => (provider === "claude" && id === SESSION.slice("claude:".length) ? { publicState } : undefined) });
const lookup = ({ rows = [], publicState = null } = {}) => (ref) => resolveTaskSessionFacts(ref, {
  observationStore: storeWith(publicState), catalogSessions: () => rows,
});

test("the lookup reads the catalog row's title and the state the Sessions list renders", () => {
  for (const activityStatus of TASK_SESSION_STATES) {
    assert.equal(lookup({ rows: [catalogRow({ activityStatus })] })(SESSION).state, activityStatus);
  }
  const publicState = { session: { title: "From state" }, agents: [{ id: "primary", model: "claude-opus-4-1" }, { id: "agent-2", model: "claude-haiku-4" }] };
  assert.deepEqual(lookup({ rows: [catalogRow()], publicState })(SESSION), { title: "Fix the flaky test", state: "working", observedModel: "claude-opus-4-1", writerReleased: false });
});

test("the lookup falls back to the committed public state where the row lacks a title or is missing", () => {
  const publicState = { session: { title: "From state" }, agents: [{ id: "primary", model: "claude-sonnet-4" }] };
  assert.deepEqual(lookup({ rows: [catalogRow({ title: "Untitled session" })], publicState })(SESSION), { title: "From state", state: "working", observedModel: "claude-sonnet-4", writerReleased: false });
  assert.deepEqual(lookup({ publicState })(SESSION), { title: "From state", state: "unknown", observedModel: "claude-sonnet-4", writerReleased: false });
  assert.deepEqual(lookup({ rows: [catalogRow({ title: "Untitled session" })] })(SESSION), { title: null, state: "working", observedModel: null, writerReleased: false });
  assert.deepEqual(lookup({ rows: [catalogRow({ title: `a${NUL}b${LINE_BREAK}c` })] })(SESSION).title, "a b c");
  assert.equal(lookup({ rows: [catalogRow({ title: "t".repeat(400) })] })(SESSION).title.length, TASK_SESSION_TITLE_LENGTH);
});

test("the lookup yields null for an unknown or malformed session and no model without a primary agent", () => {
  assert.equal(lookup({ rows: [catalogRow()] })("claude:other"), null);
  for (const ref of ["not a ref", "claude", "claude:", "gemini:abc", "claude:a:b", undefined, null, 7]) assert.equal(lookup({ rows: [catalogRow()] })(ref), null);
  assert.equal(lookup({ rows: [catalogRow()], publicState: { agents: [{ id: "agent-2", model: "claude-haiku-4" }] } })(SESSION).observedModel, null);
  assert.equal(lookup({ rows: [catalogRow()], publicState: { agents: "x" } })(SESSION).observedModel, null);
  assert.equal(lookup({ rows: [catalogRow()], publicState: { agents: [{ id: "primary", model: 5 }] } })(SESSION).observedModel, null);
  assert.equal(lookup({ rows: [null, catalogRow()] })(SESSION).state, "working");
});

test("the provider's unknown model placeholder is no observed model once projected", () => {
  const facts = lookup({ rows: [catalogRow()], publicState: { agents: [{ id: "primary", model: "unknown" }] } });
  const [task] = fillTaskSessions({ tasks: [linked("T-1", SESSION)] }, facts).tasks;
  assert.equal(task.session.observedModel, null);
  assert.equal(task.session.state, "working");
});

test("createTaskLookups exposes the facts lookup beside the others and reads only committed memory", () => {
  const touched = [];
  const lookups = createTaskLookups({
    observationStore: { get: (...args) => { touched.push(["get", ...args]); return undefined; } },
    catalogSessions: () => { touched.push(["catalog"]); return [catalogRow()]; },
    repositoryInventory: new Proxy({}, { get(_target, key) { touched.push(["inventory", String(key)]); return undefined; } }),
  });
  assert.deepEqual(Object.keys(lookups).toSorted(), ["resolveRunModels", "resolveTaskCheckFacts", "resolveTaskGateFacts", "resolveTaskSession", "resolveTaskSessionFacts", "resolveTaskStart"]);
  assert.deepEqual(lookups.resolveTaskSessionFacts(SESSION), { title: "Fix the flaky test", state: "working", observedModel: null, writerReleased: false });
  assert.deepEqual(touched, [["catalog"], ["get", "claude", SESSION.slice("claude:".length)]]);
});
