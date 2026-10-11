import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { REPOSITORY, START_TIME, createTask, metaValue, openTemporaryStore, queueRow, queueTask, setQueueRow, startedTask, updateTask } from "./queue-test-support.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const TOKEN = "a".repeat(40);
const SECRET_TEXT = "AGENT-TASK-TEXT-do-not-leak";
const SESSIONS = {
  "claude:known": REPOSITORY_ID, "claude:norepo": null,
  // Two sessions of the queue-test repository, for the remove rule.
  "claude:mine": REPOSITORY, "claude:theirs": REPOSITORY,
  // Committed under another identity (a task worktree whose folder is gone, for example) or none, but started for a task of REPOSITORY.
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

test("success lands in the first column not queued with run and completeWhen stored, echoing only the ID", async (context) => {
  const store = await realStore(context);
  const { port, lookups } = await start(context, store);
  const response = await add(port, {
    text: SECRET_TEXT, run: { provider: "codex", model: "gpt-5", effort: "high" }, completeWhen: { checks: ["pr_open"], own: "tests green" },
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
  assert.deepEqual(task.completeWhen, { checks: ["pr_open"], own: "tests green" });
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
  assert.equal((await add(port, { text: "o", completeWhen: { checks: [], own: "y".repeat(500) } })).status, 200);
  reason(await add(port, { text: "o", completeWhen: { checks: [], own: "y".repeat(501) } }), 400, "invalid");
  // A plugin from before the rename still sends `doneWhen`; both names together are refused.
  assert.equal((await add(port, { text: "p", doneWhen: { checks: ["pr_open"], own: null } })).status, 200);
  reason(await add(port, { text: "o", doneWhen: { checks: [], own: null }, completeWhen: { checks: [], own: null } }), 400, "invalid");
  reason(await add(port, { text: "m", run: { provider: "claude", model: "bad model\n", effort: null } }), 400, "invalid");
  reason(await add(port, { text: "m", run: { provider: "other", model: null, effort: null } }), 400, "invalid");
  reason(await add(port, { text: "f", feature: "f".repeat(81) }), 400, "invalid");
  reason(await add(port, JSON.stringify({ sessionRef: "claude:known", text: "z".repeat(17 * 1024) })), 400, "invalid");
  const added = store.readBoard(REPOSITORY_ID).tasks;
  assert.equal(added.length, 3);
  assert.deepEqual(added.at(-1).completeWhen, { checks: ["pr_open"], own: null }, "the older name lands in completeWhen");
});

test("feature attach by exact name, with no step; an unknown feature creates nothing", async (context) => {
  const store = await realStore(context);
  const { port } = await start(context, store);
  assert.equal(store.apply(REPOSITORY_ID, "feature_create", { name: "Checkout" }).ok, true);
  assert.equal((await add(port, { text: "one", feature: "Checkout" })).status, 200);
  assert.equal((await add(port, { text: "two", feature: "Checkout" })).status, 200);
  const board = store.readBoard(REPOSITORY_ID);
  const featureId = board.features[0].id;
  assert.deepEqual(board.tasks.map((task) => [task.featureId, Object.hasOwn(task, "step")]), [[featureId, false], [featureId, false]]);
  reason(await add(port, { text: "stepped", feature: "Checkout", step: 1 }), 400, "invalid");
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

test("the same session adding the same text again gets the task it already added, and only that", async (context) => {
  const { store, directory, clock } = await openTemporaryStore(context, "pomegr-agent-add-again-");
  const { port } = await start(context, store);
  const addText = async (sessionRef, text, extra = {}) => (await send(port, { body: JSON.stringify({ sessionRef, text, ...extra }) })).json;
  const first = await addText("claude:mine", SECRET_TEXT);
  assert.deepEqual(first, { schemaVersion: 1, ok: true, taskId: "T-1" });
  // The retry of a call whose answer was lost: the same ID, the same shape, and no second task.
  assert.deepEqual(await addText("claude:mine", SECRET_TEXT), first);
  // The text is compared as the store keeps it, so outer blanks do not make a second task.
  assert.deepEqual(await addText("claude:mine", `  ${SECRET_TEXT}\n`), first);
  // Run and conditions do not tell two adds apart; the text and the feature do.
  assert.deepEqual(await addText("claude:mine", SECRET_TEXT, { run: { provider: "codex", model: null, effort: null } }), first);
  assert.deepEqual(taskIds(store), ["T-1"]);
  // Another text, another session, or another feature each make a task of their own.
  assert.equal((await addText("claude:mine", `${SECRET_TEXT} two`)).taskId, "T-2");
  assert.equal((await addText("claude:theirs", SECRET_TEXT)).taskId, "T-3");
  assert.equal(store.apply(REPOSITORY, "feature_create", { name: "Reports" }).ok, true);
  assert.equal((await addText("claude:mine", SECRET_TEXT, { feature: "Reports" })).taskId, "T-4");
  assert.equal((await addText("claude:mine", SECRET_TEXT, { feature: "Reports" })).taskId, "T-4");
  assert.equal((await addText("claude:mine", SECRET_TEXT)).taskId, "T-1");
  assert.deepEqual(taskIds(store), ["T-1", "T-2", "T-3", "T-4"]);
  // The owner's edits do not end it inside the window; an owner's delete does.
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-2", text: "edited by the owner" }).ok, true);
  assert.equal((await addText("claude:mine", `${SECRET_TEXT} two`)).taskId, "T-2");
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-3" }).ok, true);
  assert.equal((await addText("claude:theirs", SECRET_TEXT)).taskId, "T-5");
  // The memory is the monitor's alone: nothing about it is stored, and the task text is kept nowhere new.
  assert.equal(metaValue(directory, adderKey(1)), "claude:mine");
  assert.doesNotMatch(JSON.stringify(store.readBoard(REPOSITORY)), /recent|digest/u);
  // After the window the same call adds a new task, and the window counts from the add, not from the last retry.
  clock.now += 4 * 60 * 1000;
  assert.equal((await addText("claude:mine", SECRET_TEXT)).taskId, "T-1");
  clock.now += 61 * 1000;
  assert.equal((await addText("claude:mine", SECRET_TEXT)).taskId, "T-6");
  assert.equal((await addText("claude:mine", SECRET_TEXT)).taskId, "T-6");
});

test("a store reopened after a restart remembers no earlier add, and a refused add is not remembered", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-agent-add-restart-");
  const { port } = await start(context, store);
  const addText = async (text) => send(port, { body: JSON.stringify({ sessionRef: "claude:mine", text }) });
  reason(await addText("x".repeat(4001)), 400, "invalid");
  reason(await addText("x".repeat(4001)), 400, "invalid");
  assert.equal((await addText(SECRET_TEXT)).json.taskId, "T-1");
  store.close();
  const reopened = openTaskStore({ directory });
  try {
    const second = await start(context, reopened);
    assert.equal((await send(second.port, { body: JSON.stringify({ sessionRef: "claude:mine", text: SECRET_TEXT }) })).json.taskId, "T-2");
  } finally {
    reopened.close();
  }
});

test("no other agent write path exists", async (context) => {
  const store = await realStore(context);
  const { port } = await start(context, store);
  const body = JSON.stringify({ sessionRef: "claude:known", text: "x" });
  for (const requestPath of ["/api/agent/v1/tasks/complete/", "/api/agent/v1/tasks/block/x", "/api/agent/v1/tasks/resolve", "/api/agent/v1/tasks", "/api/agent/v1/tasks/add/", "/api/agent/v1/tasks/remove/", "/api/agent/v1/tasks/delete", "/api/agent/v1/sessions", "/api/agent/v1/provider-health"]) {
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
  // A committed identity that differs from the repository whose board holds the task does not redirect the add.
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
  // Without the link the session's own committed identity is used, as before the link existed.
  assert.equal((await addTo(throwing.port, "claude:worktree")).json.ok, true);
  assert.equal(store.readBoard("repo-ffffffffffffffffffffffff").tasks.length, 1);
  const missing = await start(context, { apply: store.apply, readBoard: store.readBoard });
  assert.equal((await addTo(missing.port, "claude:known", { text: "from the worktree, second" })).json.ok, true);
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

const REMOVE = "/api/agent/v1/tasks/remove";
const addAs = async (port, sessionRef, text = SECRET_TEXT) => (await send(port, { body: JSON.stringify({ sessionRef, text }) })).json.taskId;
const remove = (port, taskId, sessionRef = "claude:mine", extra = {}) => send(port, { path: REMOVE, body: JSON.stringify({ sessionRef, taskId, ...extra }) });
const adderKey = (number) => `task_added_by:${REPOSITORY}:T-${number}`;
const taskIds = (store) => store.readBoard(REPOSITORY).tasks.map((task) => task.id).sort();
const refused = (response) => {
  reason(response, 404, "not_found");
  assert.doesNotMatch(response.text, /AGENT-TASK|T-\d|claude:|repo-|state|queued/u);
};

test("a session removes a task it added: the number stays retired and the answer names nothing", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-agent-remove-");
  const { port } = await start(context, store);
  assert.equal(await addAs(port, "claude:mine"), "T-1");
  assert.equal(await addAs(port, "claude:mine", "a second task"), "T-2");
  assert.equal(metaValue(directory, adderKey(2)), "claude:mine");
  // The record of who added a task is never on the served board.
  assert.doesNotMatch(JSON.stringify(store.readBoard(REPOSITORY)), /claude:mine|added_by|addedBy/u);
  const response = await remove(port, "T-2");
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true });
  assert.deepEqual(taskIds(store), ["T-1"]);
  assert.equal(metaValue(directory, adderKey(2)), null);
  // Gone is gone: a second call is the same refusal as a task that never existed, and the number is not reused.
  refused(await remove(port, "T-2"));
  // The same text again, moments later, is a new task: a removed task is never answered as the one already added.
  assert.equal(await addAs(port, "claude:mine", "a second task"), "T-3");
});

test("a task the user or another session added, or one that does not exist, is the one fixed refusal", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-agent-remove-");
  const { port } = await start(context, store);
  createTask(store, REPOSITORY, { text: SECRET_TEXT });
  assert.equal(await addAs(port, "claude:theirs"), "T-2");
  assert.equal(await addAs(port, "claude:mine"), "T-3");
  const answers = [await remove(port, "T-1"), await remove(port, "T-2"), await remove(port, "T-99")];
  for (const response of answers) refused(response);
  assert.equal(new Set(answers.map((response) => response.text)).size, 1);
  // A session Pomegr does not know, one with no repository, and one on another board find nothing either.
  for (const sessionRef of ["codex:missing", "claude:norepo", "claude:known"]) refused(await remove(port, "T-3", sessionRef));
  assert.deepEqual(taskIds(store), ["T-1", "T-2", "T-3"]);
});

test("a task that waits in the queue is removed, and one that started, linked, or reported is refused", async (context) => {
  const { store, directory, clock } = await openTemporaryStore(context, "pomegr-agent-remove-");
  const { port } = await start(context, store);
  for (let number = 1; number <= 7; number += 1) assert.equal(await addAs(port, "claude:mine", `${SECRET_TEXT} ${number}`), `T-${number}`);
  // T-1 queued and T-2 scheduled still wait.
  queueTask(store, "T-1");
  assert.equal(store.apply(REPOSITORY, "queue_add", { id: "T-2", at: new Date(START_TIME + 3_600_000).toISOString() }).ok, true);
  // T-3 has a start in flight, T-4 a linked session, T-5 a report, T-6 is done, and T-7's start ran out.
  startedTask(directory, 3, { mintedAt: clock.now, state: "queued" });
  startedTask(directory, 4, { session: "claude:run-4", state: "queued" });
  updateTask(directory, 5, { state: "blocked", session_id: "claude:run-5", report_at: clock.now, report_results: "[]", report_block_reason: "stuck" });
  updateTask(directory, 6, { state: "done", session_id: "claude:run-6" });
  startedTask(directory, 7, { mintedAt: clock.now - 60 * 60_000 });
  for (const id of ["T-3", "T-4", "T-5", "T-6"]) refused(await remove(port, id));
  for (const id of ["T-1", "T-2", "T-7"]) assert.deepEqual((await remove(port, id)).json, { schemaVersion: 1, ok: true }, id);
  assert.deepEqual(taskIds(store), ["T-3", "T-4", "T-5", "T-6"]);
});

test("the user's edits and moves do not end the session's right, and a queue blocked at the task is released", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-agent-remove-");
  const { port } = await start(context, store);
  assert.equal(await addAs(port, "claude:mine"), "T-1");
  const board = store.readBoard(REPOSITORY);
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-1", text: "edited by the user" }).ok, true);
  assert.equal(store.apply(REPOSITORY, "move", { id: "T-1", columnId: board.columns[1].id, position: 0 }).ok, true);
  setQueueRow(directory, "blocked", "T-1");
  assert.equal((await remove(port, "T-1")).status, 200);
  assert.deepEqual(taskIds(store), []);
  assert.deepEqual(queueRow(directory), { queue_status: "running", queue_blocked_by: null });
});

test("a session started for a task removes what it added on the linked task's board", async (context) => {
  const { store } = await linkedStore(context, "claude:worktree");
  const { port } = await start(context, store);
  assert.equal(await addAs(port, "claude:worktree"), "T-2");
  // Its own task, the one it was started for, is not one it added.
  refused(await remove(port, "T-1", "claude:worktree"));
  assert.equal((await remove(port, "T-2", "claude:worktree")).status, 200);
  assert.deepEqual(taskIds(store), ["T-1"]);
});

test("remove takes a session and one task ID and nothing else", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-agent-remove-");
  const { port } = await start(context, store);
  assert.equal(await addAs(port, "claude:mine"), "T-1");
  for (const extra of [{ repositoryId: REPOSITORY }, { path: "C:\\x" }, { text: "x" }, { id: "T-1" }]) reason(await remove(port, "T-1", "claude:mine", extra), 400, "invalid");
  for (const taskId of ["1", "T-0", "T-01", "t-1", "T-1 ", "T-1234567890", "", null, 1, ["T-1"]]) reason(await remove(port, taskId), 400, "invalid");
  for (const sessionRef of ["", "mine", "claude:", "claude:a b", null]) reason(await remove(port, "T-1", sessionRef), 400, "invalid");
  reason(await send(port, { path: REMOVE, body: JSON.stringify({ taskId: "T-1" }) }), 400, "invalid");
  reason(await send(port, { path: REMOVE, body: "{" }), 400, "invalid");
  reason(await send(port, { path: `${REMOVE}?repositoryId=${REPOSITORY}`, body: JSON.stringify({ sessionRef: "claude:mine", taskId: "T-1" }) }), 400, "invalid");
  reason(await send(port, { path: REMOVE, headers: { ...headers, "content-type": "text/plain" }, body: JSON.stringify({ sessionRef: "claude:mine", taskId: "T-1" }) }), 400, "invalid");
  // Without the agent capability, or from a page, the call is refused before the store is read.
  assert.equal((await send(port, { path: REMOVE, headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionRef: "claude:mine", taskId: "T-1" }) })).status, 401);
  assert.equal((await send(port, { path: REMOVE, headers: { ...headers, origin: "http://127.0.0.1" }, body: JSON.stringify({ sessionRef: "claude:mine", taskId: "T-1" }) })).status, 401);
  const wrong = await send(port, { method: "GET", path: REMOVE, headers: { "x-pomegr-agent-authorization": TOKEN } });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, "POST");
  assert.deepEqual(taskIds(store), ["T-1"]);
});

test("remove answers unavailable when the store or the session lookup cannot be used", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-agent-remove-");
  const working = await start(context, store);
  assert.equal(await addAs(working.port, "claude:mine"), "T-1");
  reason(await remove((await start(context, null)).port, "T-1"), 503, "unavailable");
  reason(await remove((await start(context, store, { resolve: false })).port, "T-1"), 503, "unavailable");
  const failing = await start(context, { ...store, apply() { throw new Error("SECRET-STORE-FAILURE"); } });
  const response = await remove(failing.port, "T-1");
  reason(response, 503, "unavailable");
  assert.doesNotMatch(response.text, /SECRET/u);
  assert.deepEqual(taskIds(store), ["T-1"]);
});

test("the desktop route never accepts the agent store actions", async (context) => {
  const { TASK_ACTIONS } = await import("../../../server/tasks/task-record.mjs");
  assert.equal(TASK_ACTIONS.includes("agent_create"), false);
  assert.equal(TASK_ACTIONS.includes("agent_remove"), false);
  const { store } = await openTemporaryStore(context, "pomegr-agent-remove-");
  // A stored session that is not a session ID, and a payload with another key, change nothing.
  assert.deepEqual(store.apply(REPOSITORY, "agent_create", { sessionId: "not a session", task: { text: "x" } }), { ok: false, error: "invalid" });
  assert.deepEqual(store.apply(REPOSITORY, "agent_create", { sessionId: "claude:mine", task: { text: "x" }, repositoryId: REPOSITORY }), { ok: false, error: "invalid" });
  assert.equal(store.apply(REPOSITORY, "agent_create", { sessionId: "claude:mine", task: { text: "x" } }).taskId, "T-1");
  assert.deepEqual(store.apply(REPOSITORY, "agent_remove", { sessionId: "claude:mine", id: "T-1", force: true }), { ok: false, error: "invalid" });
  assert.deepEqual(store.apply(REPOSITORY, "agent_remove", { sessionId: "claude:theirs", id: "T-1" }), { ok: false, error: "not_found" });
  assert.deepEqual(taskIds(store), ["T-1"]);
});
