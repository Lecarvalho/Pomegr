import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_ACTIONS } from "../../../server/tasks/task-record.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const OTHER_REPOSITORY_ID = "repo-fedcba987654321001234567";
const TOKEN = "t".repeat(40);
const SECRET_TEXT = "SECRET-TASK-TEXT-do-not-leak";
const withToken = { "x-pomegr-desktop-authorization": TOKEN };
const JSON_BODY = { "content-type": "application/json" };
const IMPLEMENTED_ACTIONS = ["create", "update", "delete", "move", "feature_create", "queue_add", "queue_remove", "queue_reorder", "queue_settings", "resolve_done", "resolve_requeue"];

async function realStore(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-route-"));
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

// Wraps a store so every call is recorded, and a write that must never run can be told apart from a read.
function recordingStore(inner, overrides = {}) {
  const calls = [];
  const store = {
    readBoard(...args) { calls.push(["readBoard", ...args]); return inner.readBoard(...args); },
    apply(...args) { calls.push(["apply", args[0], args[1]]); return overrides.apply ? overrides.apply(...args) : inner.apply(...args); },
    close() {},
  };
  return { store, calls };
}

function untouchedRuntime() {
  // The handler asks once, when it is built, whether the runtime has the start-gate lookup; nothing else is read.
  const touched = [];
  return { runtime: new Proxy({}, { get(_object, property) { touched.push(String(property)); return undefined; } }), touched };
}

async function startRoute(context, { taskStore, authorizationToken = TOKEN } = {}) {
  const { runtime, touched } = untouchedRuntime();
  const server = http.createServer(createRequestHandler({ runtime, taskStore, authorizationToken }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, touched };
}

// Raw requests control Host and Origin, which fetch will not let a test set. Each request gets its own connection.
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

const action = (name, repositoryId, payload, extra = {}) => send(extra.port, {
  path: `/internal/tasks/${name}`,
  headers: { ...withToken, ...JSON_BODY, ...(extra.headers || {}) },
  body: JSON.stringify({ repositoryId, payload }),
});

function assertFixedError(response, status, error) {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"] || "", /^application\/json/u);
  assert.deepEqual(response.json, { ok: false, error });
}

test("an authorized create answers the new board, no-store JSON, without reaching the observation runtime", async (context) => {
  const store = await realStore(context);
  const { port, touched } = await startRoute(context, { taskStore: store });
  const response = await send(port, {
    path: "/internal/tasks/create", headers: { ...withToken, ...JSON_BODY },
    body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { text: SECRET_TEXT } }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"], /^application\/json/u);
  assert.equal(response.json.ok, true);
  assert.deepEqual(Object.keys(response.json).sort(), ["board", "ok"]);
  assert.deepEqual(Object.keys(response.json.board).sort(), ["columns", "features", "queue", "readiness", "repositoryId", "runModels", "tasks", "version"]);
  assert.equal(response.json.board.repositoryId, REPOSITORY_ID);
  assert.deepEqual(response.json.board.tasks.map((task) => [task.id, task.text, task.state]), [["T-1", SECRET_TEXT, "not_queued"]]);
  assert.deepEqual({ ...store.readBoard(REPOSITORY_ID), runModels: { codex: [] } }, response.json.board);
  assert.deepEqual(touched, ["resolveTaskGateFacts"]);
});

test("update, delete, and not_found travel through the route with fixed statuses", async (context) => {
  const store = await realStore(context);
  const { port } = await startRoute(context, { taskStore: store });
  await action("create", REPOSITORY_ID, { text: "first" }, { port });
  await action("create", REPOSITORY_ID, { text: "second" }, { port });

  const updated = await action("update", REPOSITORY_ID, { id: "T-1", text: "edited" }, { port });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.board.tasks.map((task) => task.text), ["edited", "second"]);

  assertFixedError(await action("update", REPOSITORY_ID, { id: "T-9", text: "nobody" }, { port }), 404, "not_found");
  assertFixedError(await action("delete", REPOSITORY_ID, { id: "T-9" }, { port }), 404, "not_found");
  assertFixedError(await action("update", OTHER_REPOSITORY_ID, { id: "T-1", text: "foreign" }, { port }), 404, "not_found");

  const deleted = await action("delete", REPOSITORY_ID, { id: "T-1" }, { port });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.board.tasks.map((task) => task.id), ["T-2"]);
  const created = await action("create", REPOSITORY_ID, { text: "third" }, { port });
  assert.deepEqual(created.json.board.tasks.map((task) => task.id), ["T-2", "T-3"]);
  const other = await action("create", OTHER_REPOSITORY_ID, { text: "elsewhere" }, { port });
  assert.deepEqual(other.json.board.tasks.map((task) => task.id), ["T-1"]);
});

test("move travels through the route with the store's fixed statuses", async (context) => {
  const store = await realStore(context);
  const { port, touched } = await startRoute(context, { taskStore: store });
  await action("create", REPOSITORY_ID, { text: "first" }, { port });
  await action("create", REPOSITORY_ID, { text: "second" }, { port });
  const [backlog, ready] = store.readBoard(REPOSITORY_ID).columns;

  const moved = await action("move", REPOSITORY_ID, { id: "T-2", columnId: ready.id, position: 9 }, { port });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.json.board.tasks.map((task) => [task.id, task.columnId, task.position]), [["T-1", backlog.id, 0], ["T-2", ready.id, 0]]);
  assert.deepEqual({ ...store.readBoard(REPOSITORY_ID), runModels: { codex: [] } }, moved.json.board);
  assert.deepEqual(touched, ["resolveTaskGateFacts"]);

  assertFixedError(await action("move", REPOSITORY_ID, { id: "T-9", columnId: ready.id, position: 0 }, { port }), 404, "not_found");
  assertFixedError(await action("move", REPOSITORY_ID, { id: "T-1", columnId: ready.id, position: -1 }, { port }), 400, "invalid");
  // The column actions are gone: the route refuses their names like any unknown action.
  for (const name of ["column_create", "column_rename", "column_reorder", "column_delete", "column_role"]) {
    assertFixedError(await action(name, REPOSITORY_ID, { id: backlog.id, name: SECRET_TEXT }, { port }), 404, "invalid");
  }
  assert.equal(store.readBoard(REPOSITORY_ID).columns.length, 5);
});

test("feature_create and feature placement travel through the route with the fixed statuses", async (context) => {
  const store = await realStore(context);
  const { port } = await startRoute(context, { taskStore: store });
  const created = await action("feature_create", REPOSITORY_ID, { name: "Search" }, { port });
  assert.equal(created.status, 200);
  const [feature] = created.json.board.features;
  assert.deepEqual([feature.name, feature.done], ["Search", false]);
  const attached = await action("create", REPOSITORY_ID, { text: "in feature", featureId: feature.id }, { port });
  assert.deepEqual(attached.json.board.tasks.map((task) => [task.featureId, task.step]), [[feature.id, 1]]);
  assertFixedError(await action("feature_create", REPOSITORY_ID, { name: "Search" }, { port }), 409, "conflict");
  assertFixedError(await action("feature_create", REPOSITORY_ID, { name: "" }, { port }), 400, "invalid");
  assertFixedError(await action("create", REPOSITORY_ID, { text: "x", featureId: `feat-${"0".repeat(12)}` }, { port }), 404, "not_found");
});

test("queue_add, queue_reorder, and queue_remove travel through the route with the fixed statuses", async (context) => {
  const store = await realStore(context);
  const { port, touched } = await startRoute(context, { taskStore: store });
  const feature = (await action("feature_create", REPOSITORY_ID, { name: "Search" }, { port })).json.board.features[0];
  await action("create", REPOSITORY_ID, { text: "one", featureId: feature.id }, { port });
  await action("create", REPOSITORY_ID, { text: "two", featureId: feature.id }, { port });
  await action("create", REPOSITORY_ID, { text: "single" }, { port });
  const added = await action("queue_add", REPOSITORY_ID, { id: "T-3" }, { port });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json.board.queue, { status: "idle", blockedBy: null, pauseReason: null, order: ["T-3"] });
  assert.deepEqual((await action("queue_add", REPOSITORY_ID, { id: "T-2" }, { port })).json.board.queue.order, ["T-2", "T-3"]);
  assert.deepEqual((await action("queue_add", REPOSITORY_ID, { id: "T-1" }, { port })).json.board.queue.order, ["T-1", "T-2", "T-3"]);
  const reordered = await action("queue_reorder", REPOSITORY_ID, { id: "T-1", step: 2 }, { port });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.json.board.tasks.map((task) => [task.id, task.step]), [["T-1", 1], ["T-2", 1], ["T-3", null]]);
  const separated = await action("queue_reorder", REPOSITORY_ID, { id: "T-2", step: 2 }, { port });
  assert.deepEqual(separated.json.board.tasks.map((task) => [task.id, task.step]), [["T-1", 1], ["T-2", 2], ["T-3", null]]);
  const removed = await action("queue_remove", REPOSITORY_ID, { id: "T-2" }, { port });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.board.queue.order, ["T-1", "T-3"]);
  assert.equal(JSON.stringify(removed.json).includes("queuePosition"), false);
  assertFixedError(await action("queue_add", REPOSITORY_ID, { id: "T-1" }, { port }), 409, "conflict");
  assertFixedError(await action("queue_remove", REPOSITORY_ID, { id: "T-2" }, { port }), 409, "conflict");
  assertFixedError(await action("queue_add", REPOSITORY_ID, { id: "T-9" }, { port }), 404, "not_found");
  assertFixedError(await action("queue_reorder", REPOSITORY_ID, { id: "T-1", step: 0 }, { port }), 400, "invalid");
  assertFixedError(await action("queue_reorder", REPOSITORY_ID, { id: "T-3", step: 1 }, { port }), 409, "conflict");
  assertFixedError(await action("queue_remove", REPOSITORY_ID, { id: "T-1", text: SECRET_TEXT }, { port }), 400, "invalid");
  assert.deepEqual(touched, ["resolveTaskGateFacts"]);
});

test("every listed action has a handler, so none answers the fixed unsupported result", async (context) => {
  const store = await realStore(context);
  const { port } = await startRoute(context, { taskStore: store });
  await action("create", REPOSITORY_ID, { text: "stay" }, { port });
  const before = store.readBoard(REPOSITORY_ID);
  assert.deepEqual(TASK_ACTIONS.filter((candidate) => !IMPLEMENTED_ACTIONS.includes(candidate)), []);
  for (const name of TASK_ACTIONS.filter((candidate) => candidate !== "queue_settings")) {
    const response = await action(name, REPOSITORY_ID, { id: "T-1", text: SECRET_TEXT, unknownKey: true }, { port });
    assert.notEqual(response.status, 501, name);
  }
  assert.equal((await action("queue_settings", REPOSITORY_ID, { on: "yes", text: SECRET_TEXT }, { port })).status, 400);
  assert.equal(store.readBoard(REPOSITORY_ID).queue.status, "idle");
  assert.deepEqual(store.readBoard(REPOSITORY_ID).tasks.map((task) => task.text), before.tasks.map((task) => task.text));
});

test("an unknown action is a fixed 404 that echoes nothing and never reaches the store", async (context) => {
  const store = await realStore(context);
  const { store: spy, calls } = recordingStore(store);
  const { port } = await startRoute(context, { taskStore: spy });
  for (const name of ["", "unknown", "CREATE", "create/extra", "create%2F", "..%2Ftasks", "__proto__", "constructor", "toString", "create%20", "move2"]) {
    const response = await send(port, {
      path: `/internal/tasks/${name}`, headers: { ...withToken, ...JSON_BODY },
      body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { text: SECRET_TEXT } }),
    });
    assertFixedError(response, 404, "invalid");
    assert.ok(!response.text.includes(SECRET_TEXT) && !response.text.includes(name || "\u0000"), `no echo of ${JSON.stringify(name)}`);
  }
  assert.deepEqual(calls, []);
});

test("a refused request never writes: missing or wrong token, foreign host, Origin, wrong method, and no configured token", async (context) => {
  const store = await realStore(context);
  const { store: spy, calls } = recordingStore(store);
  const { port } = await startRoute(context, { taskStore: spy });
  const body = JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { text: SECRET_TEXT } });
  const refused = [
    ["no token", { method: "POST", headers: { ...JSON_BODY } }],
    ["wrong token", { method: "POST", headers: { ...JSON_BODY, "x-pomegr-desktop-authorization": "x".repeat(40) } }],
    ["short token", { method: "POST", headers: { ...JSON_BODY, "x-pomegr-desktop-authorization": "t" } }],
    ["foreign host", { method: "POST", headers: { ...withToken, ...JSON_BODY, host: "192.168.1.20:3003" } }],
    ["LAN-style host with port", { method: "POST", headers: { ...withToken, ...JSON_BODY, host: "localhost:3003" } }],
    ["foreign origin", { method: "POST", headers: { ...withToken, ...JSON_BODY, origin: "http://evil.example" } }],
    ["same-origin Origin", { method: "POST", headers: { ...withToken, ...JSON_BODY, origin: `http://127.0.0.1:${port}` } }],
    ["GET", { method: "GET", headers: { ...withToken } }],
    ["PUT", { method: "PUT", headers: { ...withToken, ...JSON_BODY } }],
    ["DELETE", { method: "DELETE", headers: { ...withToken, ...JSON_BODY } }],
    ["OPTIONS", { method: "OPTIONS", headers: { ...withToken } }],
  ];
  for (const [label, options] of refused) {
    const response = await send(port, { ...options, path: "/internal/tasks/create", body: options.method === "GET" ? undefined : body });
    assert.equal(response.status, 401, label);
    assert.equal(response.headers["cache-control"], "no-store", label);
    assert.equal(response.text, "Unauthorized", label);
    assert.ok(!response.text.includes(SECRET_TEXT), label);
  }
  assert.deepEqual(calls, [], "a refused request never reaches the store");
  assert.deepEqual(store.readBoard(REPOSITORY_ID).tasks, []);

  // With no desktop token configured at all, the private action is refused for everyone.
  const open = await startRoute(context, { taskStore: spy, authorizationToken: "" });
  for (const headers of [{ ...JSON_BODY }, { ...withToken, ...JSON_BODY }]) {
    const response = await send(open.port, { path: "/internal/tasks/create", headers, body });
    assert.equal(response.status, 401);
    assert.equal(response.text, "Unauthorized");
  }
  assert.deepEqual(calls.filter(([name]) => name === "apply"), []);
  assert.deepEqual(store.readBoard(REPOSITORY_ID).tasks, []);
});

test("a malformed envelope is a fixed invalid 400 and never reaches the store", async (context) => {
  const store = await realStore(context);
  const { store: spy, calls } = recordingStore(store);
  const { port } = await startRoute(context, { taskStore: spy });
  const bodies = [
    "", "not json", "{", "null", "[]", "7", "\"text\"",
    JSON.stringify({}),
    JSON.stringify({ payload: { text: SECRET_TEXT } }),
    JSON.stringify({ repositoryId: REPOSITORY_ID }),
    JSON.stringify({ repositoryId: REPOSITORY_ID, payload: null }),
    JSON.stringify({ repositoryId: REPOSITORY_ID, payload: [SECRET_TEXT] }),
    JSON.stringify({ repositoryId: REPOSITORY_ID, payload: SECRET_TEXT }),
    JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { text: SECRET_TEXT }, extra: true }),
    JSON.stringify({ repositoryId: "not-a-repo", payload: { text: SECRET_TEXT } }),
    JSON.stringify({ repositoryId: "repo-0123456789ABCDEF01234567", payload: { text: SECRET_TEXT } }),
    JSON.stringify({ repositoryId: "repo-0123456789abcdef0123456", payload: { text: SECRET_TEXT } }),
    JSON.stringify({ repositoryId: 7, payload: { text: SECRET_TEXT } }),
    JSON.stringify({ repositoryId: ["repo-0123456789abcdef01234567"], payload: { text: SECRET_TEXT } }),
  ];
  for (const body of bodies) {
    const response = await send(port, { path: "/internal/tasks/create", headers: { ...withToken, ...JSON_BODY }, body });
    assertFixedError(response, 400, "invalid");
    assert.ok(!response.text.includes(SECRET_TEXT));
  }
  const withQuery = await send(port, {
    path: `/internal/tasks/create?repositoryId=${REPOSITORY_ID}`, headers: { ...withToken, ...JSON_BODY },
    body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { text: "x" } }),
  });
  assertFixedError(withQuery, 400, "invalid");
  assert.deepEqual(calls, []);
});

test("text bounds hold through the route: empty and 4001 characters are invalid, 4000 is accepted", async (context) => {
  const store = await realStore(context);
  const { port } = await startRoute(context, { taskStore: store });
  for (const text of ["", "   ", "x".repeat(4001), 12, null]) {
    assertFixedError(await action("create", REPOSITORY_ID, { text }, { port }), 400, "invalid");
  }
  assert.deepEqual(store.readBoard(REPOSITORY_ID).tasks, []);
  const accepted = await action("create", REPOSITORY_ID, { text: "x".repeat(4000) }, { port });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.board.tasks[0].text.length, 4000);
  assertFixedError(await action("update", REPOSITORY_ID, { id: "T-1", text: "" }, { port }), 400, "invalid");
  assertFixedError(await action("update", REPOSITORY_ID, { id: "T-1", text: "x".repeat(4001) }, { port }), 400, "invalid");
  assert.equal(store.readBoard(REPOSITORY_ID).tasks[0].text.length, 4000);
});

test("the 501st task is a 409 limit through the route", async (context) => {
  const store = await realStore(context);
  for (let count = 0; count < 500; count += 1) assert.equal(store.apply(REPOSITORY_ID, "create", { text: `task ${count}` }).ok, true);
  const { port } = await startRoute(context, { taskStore: store });
  assertFixedError(await action("create", REPOSITORY_ID, { text: "one too many" }, { port }), 409, "limit");
  assert.equal(store.readBoard(REPOSITORY_ID).tasks.length, 500);
  assert.equal((await action("create", OTHER_REPOSITORY_ID, { text: "another repository" }, { port })).status, 200);
});

test("an oversize payload or body is rejected with 413 and never reaches the store", async (context) => {
  const store = await realStore(context);
  const { store: spy, calls } = recordingStore(store);
  const { port } = await startRoute(context, { taskStore: spy });
  // The payload alone exceeds 16 KiB while the whole body stays under the transport cap.
  const justOver = JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { text: "y".repeat(16 * 1024 - 8) } });
  assert.ok(justOver.length < 17 * 1024);
  assertFixedError(await send(port, { path: "/internal/tasks/create", headers: { ...withToken, ...JSON_BODY }, body: justOver }), 413, "invalid");
  // A large body is cut off by the transport cap, announced by content-length or not.
  const huge = JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { text: "z".repeat(64 * 1024) } });
  assertFixedError(await send(port, { path: "/internal/tasks/create", headers: { ...withToken, ...JSON_BODY }, body: huge }), 413, "invalid");
  const chunked = await send(port, {
    path: "/internal/tasks/create", headers: { ...withToken, ...JSON_BODY, "transfer-encoding": "chunked" }, body: huge,
  });
  assertFixedError(chunked, 413, "invalid");
  assert.deepEqual(calls, []);
  assert.deepEqual(store.readBoard(REPOSITORY_ID).tasks, []);
});

test("store failures map to fixed statuses and never leak the thrown text or the task text", async (context) => {
  const inner = await realStore(context);
  const cases = [
    ["invalid", 400], ["not_found", 404], ["limit", 409], ["conflict", 409], ["unsupported", 501], ["surprise", 409],
  ];
  for (const [error, status] of cases) {
    const { store } = recordingStore(inner, { apply: () => ({ ok: false, error }) });
    const { port } = await startRoute(context, { taskStore: store });
    const response = await action("create", REPOSITORY_ID, { text: SECRET_TEXT }, { port });
    assertFixedError(response, status, error === "surprise" ? "conflict" : error);
  }
  for (const apply of [() => { throw new Error(`C:\\private\\${SECRET_TEXT}`); }, () => ({ ok: true, board: null }), () => null]) {
    const { store } = recordingStore(inner, { apply });
    const { port } = await startRoute(context, { taskStore: store });
    const response = await action("create", REPOSITORY_ID, { text: SECRET_TEXT }, { port });
    assert.ok(response.status === 503 || response.status === 409);
    assert.equal(response.json.ok, false);
    assert.ok(!response.text.includes(SECRET_TEXT) && !response.text.includes("private"));
  }
  const none = await startRoute(context, { taskStore: null });
  assertFixedError(await action("create", REPOSITORY_ID, { text: "x" }, { port: none.port }), 503, "conflict");
});

test("a malformed or newer store is never overwritten through the route", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-route-bad-"));
  context.after(() => rm(directory, { recursive: true, force: true }).catch(() => {}));
  const { writeFile, readFile } = await import("node:fs/promises");
  const garbage = Buffer.from("not a sqlite database; the user's tasks might be in here\n".repeat(30));
  await writeFile(path.join(directory, "tasks.sqlite"), garbage);
  const store = openTaskStore({ directory });
  context.after(() => store.close());
  const { port } = await startRoute(context, { taskStore: store });
  for (const [name, payload] of [["create", { text: "x" }], ["update", { id: "T-1", text: "x" }], ["delete", { id: "T-1" }]]) {
    const response = await action(name, REPOSITORY_ID, payload, { port });
    assert.equal(response.status, 409, name);
    assert.deepEqual(response.json, { ok: false, error: "conflict" }, name);
  }
  assert.deepEqual(await readFile(path.join(directory, "tasks.sqlite")), garbage);
});

test("GET /api/tasks behaves exactly as before: desktop_only for denied clients, the committed board for the desktop", async (context) => {
  const store = await realStore(context);
  const { port } = await startRoute(context, { taskStore: store });
  await action("create", REPOSITORY_ID, { text: SECRET_TEXT }, { port });
  const query = `/api/tasks?repositoryId=${REPOSITORY_ID}`;

  for (const headers of [{}, { "x-pomegr-desktop-authorization": "x".repeat(40) }, { ...withToken, origin: "http://evil.example" }, { ...withToken, host: "192.168.1.20:3003" }]) {
    const denied = await send(port, { method: "GET", path: query, headers });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers["cache-control"], "no-store");
    assert.deepEqual(denied.json, {
      version: 1, readiness: "desktop_only", repositoryId: REPOSITORY_ID,
      columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, runModels: { codex: [] },
    });
    assert.ok(!denied.text.includes(SECRET_TEXT));
  }
  const allowed = await send(port, { method: "GET", path: query, headers: withToken });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.readiness, "ready");
  assert.deepEqual(allowed.json.tasks.map((task) => task.text), [SECRET_TEXT]);
  // The mutation path is not a GET route: a POST to the board URL is still refused.
  const post = await send(port, { method: "POST", path: query, headers: { ...withToken, ...JSON_BODY }, body: "{}" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET");
});
