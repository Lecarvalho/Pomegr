import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { REPOSITORY, createTask, openTemporaryStore, startedTask } from "./queue-test-support.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const TOKEN = "a".repeat(40);
const SECRET_TEXT = "AGENT-TASK-TEXT-do-not-leak";
const SESSIONS = {
  "claude:known": REPOSITORY_ID, "claude:norepo": null,
  // Committed under the worktree's own identity (or none), but started for a task of REPOSITORY.
  "claude:worktree": "repo-ffffffffffffffffffffffff", "claude:worktree-norepo": null,
};
const headers = { "x-pomegr-agent-authorization": TOKEN, "content-type": "application/json" };
const ADD = "/api/agent/v1/tasks/add";

async function realStore(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-agent-task-"));
  const store = openTaskStore({ directory });
  context.after(async () => {
    store.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return store;
}

async function start(context, taskStore, { resolve = true } = {}) {
  const lookups = [];
  const runtime = resolve ? {
    resolveTaskSession(ref) {
      lookups.push(ref);
      return Object.hasOwn(SESSIONS, ref) ? { found: true, repositoryId: SESSIONS[ref] } : null;
    },
  } : {};
  const server = http.createServer(createRequestHandler({ runtime, taskStore, agentAuthorizationToken: TOKEN }));
  context.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, lookups };
}

function send(port, { method = "POST", path: requestPath = ADD, headers: extra = headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers: extra, agent: false }, (response) => {
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

const add = (port, payload) => send(port, {
  body: typeof payload === "string" ? payload : JSON.stringify({ sessionRef: "claude:known", ...payload }),
});
const reason = (response, status, expected) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: false, reason: expected });
};

test("success lands in the first column not queued with run and doneWhen stored, echoing only the ID", async (context) => {
  const store = await realStore(context);
  const { port, lookups } = await start(context, store);
  const response = await add(port, {
    text: SECRET_TEXT, run: { provider: "codex", model: "gpt-5", effort: "high" }, doneWhen: { checks: ["pr_open"], own: "tests green" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, taskId: "T-1" });
  assert.doesNotMatch(response.text, /AGENT-TASK/u);
  assert.deepEqual(lookups, ["claude:known"]);
  const board = store.readBoard(REPOSITORY_ID);
  const [task] = board.tasks;
  assert.equal(task.text, SECRET_TEXT);
  assert.equal(task.state, "not_queued");
  assert.equal(task.columnId, board.columns[0].id);
  assert.equal(task.run.provider, "codex");
  assert.deepEqual(task.doneWhen, { checks: ["pr_open"], own: "tests green" });
  assert.equal((await add(port, { text: "again" })).json.taskId, "T-2");
});

test("add_task creates a local task with no source and never reaches the issue reader", async (context) => {
  const store = await realStore(context);
  const touched = [];
  const runtime = new Proxy({
    resolveTaskSession: () => ({ found: true, repositoryId: REPOSITORY_ID }),
    taskIssues: { create: () => { touched.push("create"); }, list: () => { touched.push("list"); }, status: () => { touched.push("status"); }, read: () => { touched.push("read"); } },
  }, { get(target, property) { touched.push(String(property)); return target[property]; } });
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, agentAuthorizationToken: TOKEN }));
  context.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const response = await add(server.address().port, { text: SECRET_TEXT });
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true, taskId: "T-1" });
  assert.equal(store.readBoard(REPOSITORY_ID).tasks[0].source, null);
  assert.equal(store.issueDraft(REPOSITORY_ID, "T-1").hasSource, false);
  assert.equal(touched.includes("taskIssues"), false);
  assert.deepEqual(touched.filter((name) => ["create", "list", "status", "read"].includes(name)), []);
});

test("unauthorized and Origin-bearing requests are refused before any write", async (context) => {
  const store = await realStore(context);
  const { port, lookups } = await start(context, store);
  const body = JSON.stringify({ sessionRef: "claude:known", text: "x" });
  assert.equal((await send(port, { headers: { "content-type": "application/json" }, body })).status, 401);
  assert.equal((await send(port, { headers: { ...headers, origin: "http://evil.example" }, body })).status, 401);
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 0);
  assert.deepEqual(lookups, []);
});

test("a content type other than JSON is invalid", async (context) => {
  const store = await realStore(context);
  const { port } = await start(context, store);
  const body = JSON.stringify({ sessionRef: "claude:known", text: "x" });
  reason(await send(port, { headers: { ...headers, "content-type": "text/plain" }, body }), 400, "invalid");
  reason(await send(port, { headers: { "x-pomegr-agent-authorization": TOKEN }, body }), 400, "invalid");
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 0);
});

test("unknown session and session without repository answer fixed reasons", async (context) => {
  const store = await realStore(context);
  const { port } = await start(context, store);
  reason(await add(port, JSON.stringify({ sessionRef: "codex:missing", text: "x" })), 404, "session_not_found");
  reason(await add(port, JSON.stringify({ sessionRef: "claude:norepo", text: "x" })), 409, "repository_unavailable");
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 0);
});

test("unknown keys, repository selectors, and malformed bodies are invalid", async (context) => {
  const store = await realStore(context);
  const { port } = await start(context, store);
  for (const extra of [{ repositoryId: REPOSITORY_ID }, { repository: "x" }, { path: "C:\\x" }, { cwd: "." }, { columnId: "col-0123456789ab" }, { state: "queued" }, { id: "T-1" }]) {
    reason(await add(port, { text: "x", ...extra }), 400, "invalid");
  }
  reason(await add(port, "[]"), 400, "invalid");
  reason(await add(port, "{"), 400, "invalid");
  reason(await add(port, JSON.stringify({ text: "x" })), 400, "invalid");
  reason(await add(port, JSON.stringify({ sessionRef: "../etc", text: "x" })), 400, "invalid");
  reason(await add(port, JSON.stringify({ sessionRef: "claude:known" })), 400, "invalid");
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 0);
});

test("bounds follow the store validation", async (context) => {
  const store = await realStore(context);
  const { port } = await start(context, store);
  assert.equal((await add(port, { text: "x".repeat(4000) })).status, 200);
  reason(await add(port, { text: "x".repeat(4001) }), 400, "invalid");
  reason(await add(port, { text: "   " }), 400, "invalid");
  assert.equal((await add(port, { text: "o", doneWhen: { checks: [], own: "y".repeat(500) } })).status, 200);
  reason(await add(port, { text: "o", doneWhen: { checks: [], own: "y".repeat(501) } }), 400, "invalid");
  reason(await add(port, { text: "m", run: { provider: "claude", model: "bad model\n", effort: null } }), 400, "invalid");
  reason(await add(port, { text: "m", run: { provider: "other", model: null, effort: null } }), 400, "invalid");
  reason(await add(port, { text: "f", feature: "f".repeat(81) }), 400, "invalid");
  reason(await add(port, JSON.stringify({ sessionRef: "claude:known", text: "z".repeat(17 * 1024) })), 400, "invalid");
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 2);
});

test("feature attach by exact name at a new last step; an unknown feature creates nothing", async (context) => {
  const store = await realStore(context);
  const { port } = await start(context, store);
  assert.equal(store.apply(REPOSITORY_ID, "feature_create", { name: "Checkout" }).ok, true);
  assert.equal((await add(port, { text: "one", feature: "Checkout" })).status, 200);
  assert.equal((await add(port, { text: "two", feature: "Checkout" })).status, 200);
  const board = store.readBoard(REPOSITORY_ID);
  const featureId = board.features[0].id;
  assert.deepEqual(board.tasks.map((task) => [task.featureId, task.step]), [[featureId, 1], [featureId, 2]]);
  reason(await add(port, { text: "three", feature: "checkout" }), 404, "feature_not_found");
  reason(await add(port, { text: "three", feature: "Nope" }), 404, "feature_not_found");
  assert.equal(store.readBoard(REPOSITORY_ID).features.length, 1);
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 2);
});

test("the 500-task limit answers limit", async (context) => {
  const store = await realStore(context);
  const { port } = await start(context, store);
  for (let index = 0; index < 500; index += 1) assert.equal(store.apply(REPOSITORY_ID, "create", { text: `t${index}` }).ok, true);
  reason(await add(port, { text: "one too many" }), 409, "limit");
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 500);
});

test("an unavailable store or lookup answers unavailable", async (context) => {
  const none = await start(context, null);
  reason(await add(none.port, { text: "x" }), 503, "unavailable");
  const store = await realStore(context);
  const noLookup = await start(context, store, { resolve: false });
  reason(await add(noLookup.port, { text: "x" }), 503, "unavailable");
});

test("no other agent write path exists", async (context) => {
  const store = await realStore(context);
  const { port } = await start(context, store);
  const body = JSON.stringify({ sessionRef: "claude:known", text: "x" });
  for (const requestPath of ["/api/agent/v1/tasks/complete/", "/api/agent/v1/tasks/block/x", "/api/agent/v1/tasks/resolve", "/api/agent/v1/tasks", "/api/agent/v1/tasks/add/", "/api/agent/v1/sessions", "/api/agent/v1/provider-health"]) {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await send(port, { method, path: requestPath, body });
      assert.equal(response.status, 405, `${method} ${requestPath}`);
      assert.equal(response.headers.allow, "GET");
    }
  }
  const missing = await send(port, { method: "GET", path: "/api/agent/v1/tasks/resolve", headers: { "x-pomegr-agent-authorization": TOKEN } });
  assert.equal(missing.status, 404);
  const wrong = await send(port, { method: "GET", path: ADD, headers: { "x-pomegr-agent-authorization": TOKEN } });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, "POST");
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 0);
});

/** A store whose T-1 on REPOSITORY is linked to each given session, as the plugin's session-start hook leaves it. */
async function linkedStore(context, ...sessions) {
  const env = await openTemporaryStore(context, "pomegr-agent-link-");
  for (const [index, session] of sessions.entries()) {
    createTask(env.store, REPOSITORY, { text: `linked ${index}` });
    startedTask(env.directory, index + 1, { session });
  }
  return env;
}

const addTo = (port, sessionRef, extra = {}) => send(port, { body: JSON.stringify({ sessionRef, text: "from the worktree", ...extra }) });

test("a session linked to a task adds to the linked task's board, whatever repository it committed under", async (context) => {
  const { store } = await linkedStore(context, "claude:worktree", "claude:worktree-norepo", "claude:uncommitted");
  const { port } = await start(context, store);
  // The committed identity of a task worktree differs from the repository whose board holds the task.
  assert.deepEqual((await addTo(port, "claude:worktree")).json, { schemaVersion: 1, ok: true, taskId: "T-4" });
  // A committed session with no repository identity, and a linked session the monitor has not committed yet, still add.
  assert.deepEqual((await addTo(port, "claude:worktree-norepo")).json, { schemaVersion: 1, ok: true, taskId: "T-5" });
  assert.deepEqual((await addTo(port, "claude:uncommitted")).json, { schemaVersion: 1, ok: true, taskId: "T-6" });
  assert.deepEqual(store.readBoard(REPOSITORY).tasks.map((task) => task.id), ["T-1", "T-2", "T-3", "T-4", "T-5", "T-6"]);
  assert.equal(store.readBoard(REPOSITORY).tasks.find((task) => task.id === "T-4").text, "from the worktree");
  assert.equal(store.readBoard("repo-ffffffffffffffffffffffff").tasks.length, 0);
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 0);
});

test("a session that is not linked keeps the committed repository, and an unknown one is still not found", async (context) => {
  const { store } = await linkedStore(context, "claude:worktree");
  const { port } = await start(context, store);
  assert.equal((await addTo(port, "claude:known")).json.ok, true);
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 1);
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 1);
  reason(await addTo(port, "claude:norepo"), 409, "repository_unavailable");
  reason(await addTo(port, "codex:missing"), 404, "session_not_found");
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 1);
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 1);
});

test("a linked session still cannot name a repository or a path in the body", async (context) => {
  const { store } = await linkedStore(context, "claude:worktree");
  const { port } = await start(context, store);
  for (const extra of [{ repositoryId: REPOSITORY_ID }, { repositoryId: REPOSITORY }, { path: "C:\\x" }, { cwd: "." }]) {
    reason(await addTo(port, "claude:worktree", extra), 400, "invalid");
  }
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 1);
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 0);
});

test("a store that cannot read the link leaves the committed identity in charge", async (context) => {
  const { store } = await linkedStore(context, "claude:worktree");
  const throwing = await start(context, { ...store, sessionTasks() { throw new Error("SECRET-LINK-FAILURE"); } });
  assert.equal((await addTo(throwing.port, "claude:known")).json.ok, true);
  // Without the link the worktree's own committed identity is used, as before the link existed.
  assert.equal((await addTo(throwing.port, "claude:worktree")).json.ok, true);
  assert.equal(store.readBoard("repo-ffffffffffffffffffffffff").tasks.length, 1);
  const missing = await start(context, { apply: store.apply, readBoard: store.readBoard });
  assert.equal((await addTo(missing.port, "claude:known")).json.ok, true);
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 2);
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 1);
});

test("the runtime session lookup reads only committed store and catalog facts", async () => {
  const { resolveTaskSession } = await import("../../../server/runtime/task-session-lookup.mjs");
  const observationStore = { get: (provider, id) => (provider === "claude" && id === "live" ? { publicState: { session: { repositoryId: REPOSITORY_ID } } } : undefined) };
  const catalogSessions = () => [{ id: "codex:row", repositoryId: REPOSITORY_ID }, { id: "codex:bare" }];
  const lookup = (ref) => resolveTaskSession(ref, { observationStore, catalogSessions });
  assert.deepEqual(lookup("claude:live"), { found: true, repositoryId: REPOSITORY_ID });
  assert.deepEqual(lookup("codex:row"), { found: true, repositoryId: REPOSITORY_ID });
  assert.deepEqual(lookup("codex:bare"), { found: true, repositoryId: null });
  assert.equal(lookup("codex:none"), null);
  assert.equal(lookup("not a ref"), null);
});
