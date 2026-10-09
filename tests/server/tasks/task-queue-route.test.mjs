import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_ACTIONS } from "../../../server/tasks/task-record.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { removeDirectory, setQueueRow, setMeta, pauseReasonKey, withDatabase } from "./queue-test-support.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const OTHER_REPOSITORY_ID = "repo-fedcba987654321001234567";
const TOKEN = "t".repeat(40);
const SECRET_TEXT = "SECRET-TASK-TEXT-do-not-leak";
const withToken = { "x-pomegr-desktop-authorization": TOKEN };
const JSON_BODY = { "content-type": "application/json" };

async function realStore(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-queue-route-"));
  const store = openTaskStore({ directory });
  context.after(async () => {
    store.close();
    await removeDirectory(directory);
  });
  return { store, directory };
}

// A store double that records which methods ran, so a gate that must stop a request can be told from one that did not.
function recordingStore(inner, overrides = {}) {
  const calls = [];
  const store = {
    readBoard(...args) { calls.push("readBoard"); return inner.readBoard(...args); },
    apply(...args) { calls.push("apply"); return inner.apply(...args); },
    nextQueueStarts(...args) { calls.push("nextQueueStarts"); return overrides.nextQueueStarts ? overrides.nextQueueStarts(...args) : inner.nextQueueStarts(...args); },
    pauseQueue(...args) { calls.push("pauseQueue"); return overrides.pauseQueue ? overrides.pauseQueue(...args) : inner.pauseQueue(...args); },
    close() {},
  };
  return { store, calls };
}

async function startRoute(context, { taskStore, authorizationToken = TOKEN } = {}) {
  const touched = [];
  const runtime = new Proxy({}, { get(_object, property) { touched.push(String(property)); return undefined; } });
  const server = http.createServer(createRequestHandler({ runtime, taskStore, authorizationToken }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, touched };
}

function send(port, { method = "POST", path: requestPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON bodies stay text */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

const queueNext = (port, body = "{}", extra = {}) => send(port, {
  path: "/internal/tasks/queue-next", headers: { ...withToken, ...JSON_BODY, ...extra }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const queuePause = (port, payload, repositoryId = REPOSITORY_ID, extra = {}) => send(port, {
  path: "/internal/tasks/queue-pause", headers: { ...withToken, ...JSON_BODY, ...extra }, body: JSON.stringify({ repositoryId, payload }),
});
const action = (port, name, payload, repositoryId = REPOSITORY_ID) => send(port, {
  path: `/internal/tasks/${name}`, headers: { ...withToken, ...JSON_BODY }, body: JSON.stringify({ repositoryId, payload }),
});

function assertFixedError(response, status, error) {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"] || "", /^application\/json/u);
  assert.deepEqual(response.json, { ok: false, error });
}

/** Two repositories with a queued task each; the first one's queue is on. */
async function seeded(context) {
  const env = await realStore(context);
  for (const repositoryId of [REPOSITORY_ID, OTHER_REPOSITORY_ID]) {
    assert.equal(env.store.apply(repositoryId, "create", { text: SECRET_TEXT }).ok, true);
    assert.equal(env.store.apply(repositoryId, "queue_add", { id: "T-1" }).ok, true);
  }
  return env;
}

test("queue-next answers the next task of each running queue and nothing else", async (context) => {
  const { store } = await seeded(context);
  const { store: spy, calls } = recordingStore(store);
  const { port, touched } = await startRoute(context, { taskStore: spy });
  assert.deepEqual((await queueNext(port)).json, { ok: true, starts: [] });
  assert.equal((await action(port, "queue_settings", { on: true })).json.board.queue.status, "running");
  assert.equal((await action(port, "queue_settings", { on: true }, OTHER_REPOSITORY_ID)).json.board.queue.status, "running");
  const response = await queueNext(port);
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"], /^application\/json/u);
  assert.deepEqual(response.json, { ok: true, starts: [{ repositoryId: OTHER_REPOSITORY_ID, taskId: "T-1" }, { repositoryId: REPOSITORY_ID, taskId: "T-1" }].toSorted((a, b) => a.repositoryId.localeCompare(b.repositoryId)) });
  assert.deepEqual(Object.keys(response.json), ["ok", "starts"]);
  assert.equal(response.text.includes(SECRET_TEXT), false);
  assert.deepEqual(touched, [], "the observation runtime is never reached");
  assert.equal(calls.filter((call) => call === "nextQueueStarts").length, 2);
});

test("queue-next takes an empty JSON object and refuses everything else without reaching the store", async (context) => {
  const { store } = await seeded(context);
  const { store: spy, calls } = recordingStore(store);
  const { port } = await startRoute(context, { taskStore: spy });
  const bodies = [
    JSON.stringify({ repositoryId: REPOSITORY_ID }), JSON.stringify({ repositoryId: REPOSITORY_ID, payload: {} }), JSON.stringify({ x: 1 }), JSON.stringify({ payload: {} }),
    "[]", "null", "7", '"{}"', "", "not json", "{",
  ];
  for (const body of bodies) assertFixedError(await queueNext(port, body), 400, "invalid");
  assertFixedError(await queueNext(port, JSON.stringify({ text: "x".repeat(20_000) })), 413, "invalid");
  assertFixedError(await send(port, { path: "/internal/tasks/queue-next?x=1", headers: { ...withToken, ...JSON_BODY }, body: "{}" }), 400, "invalid");
  assert.deepEqual(calls, []);
});

test("queue-next is gated like every other private task action", async (context) => {
  const { store } = await seeded(context);
  const { store: spy, calls } = recordingStore(store);
  const { port } = await startRoute(context, { taskStore: spy });
  const url = "/internal/tasks/queue-next";
  const refused = [
    { headers: { ...JSON_BODY } },
    { headers: { ...JSON_BODY, "x-pomegr-desktop-authorization": "x".repeat(40) } },
    { headers: { ...withToken, ...JSON_BODY, origin: "http://evil.example" } },
    { headers: { ...withToken, ...JSON_BODY, host: "192.168.1.20:3003" } },
    { method: "GET", headers: { ...withToken } },
    { method: "PUT", headers: { ...withToken, ...JSON_BODY } },
  ];
  for (const request of refused) {
    for (const name of ["queue-next", "queue-pause"]) {
      const response = await send(port, { path: url.replace("queue-next", name), body: "{}", ...request });
      assert.equal(response.status, 401, `${name} ${JSON.stringify(request.headers)}`);
      assert.equal(response.text, "Unauthorized");
    }
  }
  assert.deepEqual(calls, []);
});

test("queue-next re-validates every start at the boundary and caps the answer at sixteen", async (context) => {
  const { store } = await realStore(context);
  const good = Array.from({ length: 20 }, (_, index) => ({ repositoryId: `repo-${index.toString(16).padStart(24, "0")}`, taskId: `T-${index + 1}` }));
  const answer = (starts) => ({ ok: true, starts });
  const { port } = await startRoute(context, {
    taskStore: recordingStore(store, { nextQueueStarts: () => answer([
      { repositoryId: "repo-nope", taskId: "T-1" }, { repositoryId: good[0].repositoryId, taskId: "T-0" }, { repositoryId: good[0].repositoryId, taskId: "t-1" },
      { repositoryId: good[0].repositoryId, taskId: "T-1 " }, { repositoryId: `${good[0].repositoryId}0`, taskId: "T-1" }, { repositoryId: good[0].repositoryId },
      { taskId: "T-1" }, null, "T-1", 7, [], { repositoryId: 1, taskId: 2 }, { repositoryId: good[0].repositoryId, taskId: "T-1234567890" },
      { repositoryId: good[1].repositoryId, taskId: "T-2", extra: SECRET_TEXT, text: SECRET_TEXT, path: "C:\\secret" },
      ...good.slice(2),
    ]) }).store,
  });
  const response = await queueNext(port);
  assert.equal(response.status, 200);
  assert.equal(response.json.starts.length, 16);
  assert.deepEqual(response.json.starts[0], good[1]);
  assert.deepEqual(response.json.starts, good.slice(1, 17));
  for (const entry of response.json.starts) assert.deepEqual(Object.keys(entry), ["repositoryId", "taskId"]);
  assert.equal(response.text.includes(SECRET_TEXT), false);
  assert.equal(response.text.includes("secret"), false);
});

test("queue-next answers a fixed 503 when the store cannot answer", async (context) => {
  const { store } = await realStore(context);
  const failures = {
    "not ok": () => ({ ok: false, error: "unavailable" }),
    "an error code the route does not know": () => ({ ok: false, error: "surprise" }),
    "no answer": () => undefined,
    "no list": () => ({ ok: true }),
    "a list that is not an array": () => ({ ok: true, starts: { length: 1 } }),
    "a throw": () => { throw new Error(`boom ${SECRET_TEXT} C:\\secret`); },
  };
  for (const [label, nextQueueStarts] of Object.entries(failures)) {
    const { port } = await startRoute(context, { taskStore: recordingStore(store, { nextQueueStarts }).store });
    const response = await queueNext(port);
    assertFixedError(response, 503, "unavailable");
    assert.equal(response.text.includes("boom"), false, label);
  }
  for (const taskStore of [null, undefined, {}, { nextQueueStarts: "no" }]) {
    const { port } = await startRoute(context, { taskStore });
    assertFixedError(await queueNext(port), 503, "unavailable");
  }
});

test("queue-pause pauses a running queue and answers only ok", async (context) => {
  const { store, directory } = await seeded(context);
  const { port, touched } = await startRoute(context, { taskStore: store });
  assert.equal((await action(port, "queue_settings", { on: true })).json.board.queue.status, "running");
  const response = await queuePause(port, { id: "T-1", reason: "plugin_missing" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { ok: true });
  assert.deepEqual(touched, []);
  const queue = store.readBoard(REPOSITORY_ID).queue;
  assert.deepEqual(queue, { status: "paused", blockedBy: "T-1", pauseReason: "plugin_missing", order: ["T-1"] });
  // Already paused, and a queue that was never on, change nothing and still answer ok.
  assert.deepEqual((await queuePause(port, { id: "T-1", reason: "cli_missing" })).json, { ok: true });
  assert.equal(store.readBoard(REPOSITORY_ID).queue.pauseReason, "plugin_missing");
  assert.deepEqual((await queuePause(port, { id: "T-1", reason: "start_failed" }, OTHER_REPOSITORY_ID)).json, { ok: true });
  assert.equal(store.readBoard(OTHER_REPOSITORY_ID).queue.status, "idle");
  assert.equal(withDatabase(directory, (database) => database.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'queue_pause_reason:%'").get().n), 1);
});

test("queue-pause maps the store's refusals to fixed statuses and never echoes the input", async (context) => {
  const { store } = await seeded(context);
  const { port } = await startRoute(context, { taskStore: store });
  await action(port, "queue_settings", { on: true });
  assertFixedError(await queuePause(port, { id: "T-1", reason: "session_not_linked" }), 400, "invalid");
  assertFixedError(await queuePause(port, { id: "T-1", reason: "start_failed", text: SECRET_TEXT }), 400, "invalid");
  assertFixedError(await queuePause(port, { id: "T-7", reason: "start_failed" }), 404, "not_found");
  assert.equal(store.readBoard(REPOSITORY_ID).queue.status, "running");
  for (const [error, status, expected] of [["invalid", 400, "invalid"], ["not_found", 404, "not_found"], ["unavailable", 503, "unavailable"], ["conflict", 503, "unavailable"], ["surprise", 503, "unavailable"]]) {
    const route = await startRoute(context, { taskStore: recordingStore(store, { pauseQueue: () => ({ ok: false, error }) }).store });
    assertFixedError(await queuePause(route.port, { id: "T-1", reason: "start_failed" }), status, expected);
  }
  for (const pauseQueue of [() => { throw new Error(`boom ${SECRET_TEXT}`); }, () => undefined]) {
    const route = await startRoute(context, { taskStore: recordingStore(store, { pauseQueue }).store });
    const response = await queuePause(route.port, { id: "T-1", reason: "start_failed" });
    assertFixedError(response, 503, "unavailable");
    assert.equal(response.text.includes("boom"), false);
  }
  const missing = await startRoute(context, { taskStore: {} });
  assertFixedError(await queuePause(missing.port, { id: "T-1", reason: "start_failed" }), 503, "unavailable");
});

test("queue-pause needs the usual envelope", async (context) => {
  const { store } = await seeded(context);
  const { store: spy, calls } = recordingStore(store);
  const { port } = await startRoute(context, { taskStore: spy });
  const headers = { ...withToken, ...JSON_BODY };
  const post = (body) => send(port, { path: "/internal/tasks/queue-pause", headers, body });
  assertFixedError(await post("{}"), 400, "invalid");
  assertFixedError(await post(JSON.stringify({ repositoryId: "repo-nope", payload: {} })), 400, "invalid");
  assertFixedError(await post(JSON.stringify({ repositoryId: REPOSITORY_ID })), 400, "invalid");
  assertFixedError(await post(JSON.stringify({ repositoryId: REPOSITORY_ID, payload: [] })), 400, "invalid");
  assertFixedError(await post(JSON.stringify({ repositoryId: REPOSITORY_ID, payload: {}, extra: 1 })), 400, "invalid");
  assertFixedError(await post("not json"), 400, "invalid");
  assert.deepEqual(calls, []);
});

test("GET /api/tasks carries the pause reason and never a next start, and a GET starts nothing", async (context) => {
  const { store, directory } = await seeded(context);
  const { store: spy, calls } = recordingStore(store);
  const { port } = await startRoute(context, { taskStore: spy });
  await action(port, "queue_settings", { on: true });
  const query = `/api/tasks?repositoryId=${REPOSITORY_ID}`;
  const running = await send(port, { method: "GET", path: query, headers: withToken });
  assert.deepEqual(running.json.queue, { status: "running", blockedBy: null, pauseReason: null, order: ["T-1"] });

  await queuePause(port, { id: "T-1", reason: "unsupported_platform" });
  const paused = await send(port, { method: "GET", path: query, headers: withToken });
  assert.equal(paused.status, 200);
  assert.deepEqual(paused.json.queue, { status: "paused", blockedBy: "T-1", pauseReason: "unsupported_platform", order: ["T-1"] });
  assert.deepEqual(Object.keys(paused.json.queue).toSorted(), ["blockedBy", "order", "pauseReason", "status"]);

  // Whatever the store hands the route, only the contract's queue keys leave it.
  setQueueRow(directory, "idle", null, REPOSITORY_ID);
  setMeta(directory, pauseReasonKey(REPOSITORY_ID), "start_failed");
  const idle = await send(port, { method: "GET", path: query, headers: withToken });
  assert.equal(idle.json.queue.pauseReason, null);
  for (const served of [running, paused, idle]) assert.deepEqual(Object.keys(served.json).toSorted(), ["columns", "features", "queue", "readiness", "repositoryId", "runModels", "tasks", "version"]);
  assert.equal(calls.includes("nextQueueStarts"), false);
  const denied = await send(port, { method: "GET", path: query, headers: {} });
  assert.deepEqual(denied.json.queue, { status: "idle", blockedBy: null, pauseReason: null, order: [] });
  assert.equal(denied.json.readiness, "desktop_only");
});

test("the route serves only the contract's four queue keys even when the store hands back more", async (context) => {
  const base = { version: 1, readiness: "ready", columns: [], features: [], tasks: [] };
  const board = (queue) => ({ ...base, queue });
  for (const [queue, expected] of [
    [{ status: "paused", blockedBy: "T-1", pauseReason: "start_failed", order: ["T-1"], nextStart: "T-1", path: "C:\\secret" }, { status: "paused", blockedBy: "T-1", pauseReason: "start_failed", order: ["T-1"] }],
    [{ status: "idle", order: [] }, { status: "idle", blockedBy: null, pauseReason: null, order: [] }],
  ]) {
    const { port } = await startRoute(context, { taskStore: { readBoard: () => board(queue) } });
    const response = await send(port, { method: "GET", path: `/api/tasks?repositoryId=${REPOSITORY_ID}`, headers: withToken });
    assert.deepEqual(response.json.queue, expected);
    assert.equal(response.text.includes("secret"), false);
  }
});

test("the queue routes are not part of the renderer's fixed action list", () => {
  assert.equal(TASK_ACTIONS.includes("queue-next") || TASK_ACTIONS.includes("queue-pause"), false);
  assert.equal(TASK_ACTIONS.includes("queue_settings"), true);
});
