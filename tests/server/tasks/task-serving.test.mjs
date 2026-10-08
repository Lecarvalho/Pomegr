import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { createMonitorServer } from "../../../server/server.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const TOKEN = "t".repeat(40);
const SECRET_TEXT = "SECRET-TASK-TEXT-do-not-leak";
const BOARD_KEYS = ["columns", "features", "queue", "readiness", "repositoryId", "runModels", "tasks", "version"];
const EMPTY_QUEUE = { status: "idle", blockedBy: null, pauseReason: null, order: [] };

function secretBoard(repositoryId = REPOSITORY_ID) {
  return {
    version: 1, readiness: "ready", repositoryId,
    columns: [{ id: "c1", name: "SECRET-COLUMN", position: 0 }],
    features: [{ id: "f1", name: "SECRET-FEATURE", done: false }],
    tasks: [{
      id: "T-1", text: SECRET_TEXT, columnId: "c1", position: 0, featureId: "f1", step: 1,
      run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: "SECRET-OWN" },
      state: "not_queued", scheduledAt: null, session: null, report: null,
      createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z",
    }],
    queue: { ...EMPTY_QUEUE },
  };
}

// A store whose every property access is recorded, so a GET provably touches nothing but readBoard.
function recordingStore(read = (repositoryId) => secretBoard(repositoryId)) {
  const accessed = [];
  const calls = [];
  const target = {
    readBoard(repositoryId) { calls.push(["readBoard", repositoryId]); return read(repositoryId); },
    apply() { calls.push(["apply"]); throw new Error("apply must never run on a GET"); },
    close() { calls.push(["close"]); },
  };
  const store = new Proxy(target, { get(object, property) { accessed.push(String(property)); return object[property]; } });
  return { store, accessed, calls };
}

// The route is dispatched before any runtime read; a runtime that is touched at all fails the test.
function untouchedRuntime(resolveRunModels) {
  const touched = [];
  return { runtime: new Proxy({}, { get(_object, property) { touched.push(String(property)); return property === "resolveRunModels" ? resolveRunModels : undefined; } }), touched };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function startRoute(context, { taskStore, authorizationToken = "", resolveRunModels } = {}) {
  const { runtime, touched } = untouchedRuntime(resolveRunModels);
  const server = http.createServer(createRequestHandler({ runtime, taskStore, authorizationToken }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return listen(server).then((port) => ({ port, touched }));
}

// Raw requests control Host and Origin, which fetch will not let a test set. A refused write is answered
// without reading its body, so each request gets its own connection instead of a reusable one.
function send(port, { method = "GET", path = "/api/tasks", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (response) => {
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

const query = (id = REPOSITORY_ID) => `/api/tasks?repositoryId=${id}`;
const withToken = { "x-pomegr-desktop-authorization": TOKEN };

function assertNoStoreJson(response) {
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"] || "", /^application\/json/u);
}

function assertNoTaskContent(response) {
  assert.ok(!response.text.includes("SECRET"), "no stored task, column, or feature text may be served");
  assert.ok(!response.text.includes(SECRET_TEXT));
}

function assertDesktopOnly(response, repositoryId) {
  assert.equal(response.status, 200);
  assertNoStoreJson(response);
  assert.deepEqual(response.json, {
    version: 1, readiness: "desktop_only", repositoryId,
    columns: [], features: [], tasks: [], queue: EMPTY_QUEUE, runModels: { codex: [] },
  });
  assertNoTaskContent(response);
}

test("an allowed same-computer GET serves the committed board, no-store, through readBoard only", async (context) => {
  const { store, accessed, calls } = recordingStore();
  const { port, touched } = await startRoute(context, { taskStore: store });
  const response = await send(port, { path: query() });
  assert.equal(response.status, 200);
  assertNoStoreJson(response);
  assert.deepEqual(response.json, { ...secretBoard(), runModels: { codex: [] } });
  assert.deepEqual(Object.keys(response.json).sort(), BOARD_KEYS);
  assert.deepEqual(calls, [["readBoard", REPOSITORY_ID]]);
  assert.deepEqual([...new Set(accessed)], ["readBoard"]);
  assert.deepEqual(touched, ["resolveRunModels"], "a task GET reads only the committed run-model lookup, never provider acquisition");
});

test("the served body carries only the contract keys even when the store returns extras", async (context) => {
  const { store } = recordingStore((repositoryId) => ({ ...secretBoard(repositoryId),
    repositoryId: "repo-ffffffffffffffffffffffff", privatePath: "C:\\private\\store.db", dispatchToken: "POMEGR-SECRET-TOKEN" }));
  const { port } = await startRoute(context, { taskStore: store });
  const response = await send(port, { path: query() });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), BOARD_KEYS);
  assert.equal(response.json.repositoryId, REPOSITORY_ID);
  assert.ok(!response.text.includes("privatePath") && !response.text.includes("POMEGR-SECRET-TOKEN"));
});

test("with a desktop token configured, only a token-bearing same-computer request reads the board", async (context) => {
  const { store, calls } = recordingStore();
  const { port } = await startRoute(context, { taskStore: store, authorizationToken: TOKEN });

  assertDesktopOnly(await send(port, { path: query() }), REPOSITORY_ID);
  assertDesktopOnly(await send(port, { path: query(), headers: { "x-pomegr-desktop-authorization": "x".repeat(40) } }), REPOSITORY_ID);
  assert.deepEqual(calls, [], "a denied client never reaches the store");

  const allowed = await send(port, { path: query(), headers: withToken });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.readiness, "ready");
  assert.equal(allowed.json.tasks[0].text, SECRET_TEXT);
  assert.deepEqual(calls, [["readBoard", REPOSITORY_ID]]);
});

test("a foreign Host or an Origin header is denied like the provider-folder gate", async (context) => {
  const { store, calls } = recordingStore();
  const { port } = await startRoute(context, { taskStore: store, authorizationToken: TOKEN });
  assertDesktopOnly(await send(port, { path: query(), headers: { ...withToken, host: "192.168.1.20:3003" } }), REPOSITORY_ID);
  assertDesktopOnly(await send(port, { path: query(), headers: { ...withToken, origin: "http://evil.example" } }), REPOSITORY_ID);
  assertDesktopOnly(await send(port, { path: query(), headers: { ...withToken, origin: `http://127.0.0.1:${port}` } }), REPOSITORY_ID);
  assert.deepEqual(calls, []);
});

test("a denied client gets no echo of an invalid repository ID and no task content", async (context) => {
  const { store, calls } = recordingStore();
  const { port } = await startRoute(context, { taskStore: store, authorizationToken: TOKEN });
  for (const path of ["/api/tasks", "/api/tasks?repositoryId=not-a-repo", "/api/tasks?repositoryId=repo-ABC", `/api/tasks?repositoryId=${REPOSITORY_ID}&path=C%3A%5Csecret`]) {
    const response = await send(port, { path });
    assertDesktopOnly(response, path.includes(`repositoryId=${REPOSITORY_ID}`) ? REPOSITORY_ID : "");
  }
  assert.deepEqual(calls, []);
});

test("writes and other methods are refused and never reach the store", async (context) => {
  const { store, calls, accessed } = recordingStore();
  const { port, touched } = await startRoute(context, { taskStore: store, authorizationToken: TOKEN });
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    for (const headers of [withToken, {}]) {
      const response = await send(port, { method, path: query(), headers, body: method === "GET" ? undefined : "{\"text\":\"x\"}" });
      assert.equal(response.status, 405, `${method} must be refused`);
      assert.equal(response.headers.allow, "GET");
      assert.equal(response.headers["cache-control"], "no-store");
      assertNoTaskContent(response);
    }
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(accessed, []);
  assert.deepEqual(touched, []);
});

test("a malformed, missing, duplicated, or extra query is a 400 like repository-files, without reading the store", async (context) => {
  const { store, calls } = recordingStore();
  const { port } = await startRoute(context, { taskStore: store });
  const bad = [
    "/api/tasks",
    "/api/tasks?repositoryId=",
    "/api/tasks?repositoryId=not-a-repo",
    "/api/tasks?repositoryId=repo-0123456789ABCDEF01234567",
    "/api/tasks?repositoryId=repo-0123456789abcdef0123456",
    `/api/tasks?repositoryId=${REPOSITORY_ID}&repositoryId=${REPOSITORY_ID}`,
    `/api/tasks?repositoryId=${REPOSITORY_ID}&path=C%3A%5CUsers`,
    `/api/tasks?repositoryId=${REPOSITORY_ID}&columnId=c1`,
    `/api/tasks?repositoryId=${REPOSITORY_ID}&revision=1`,
  ];
  for (const path of bad) {
    const response = await send(port, { path });
    assert.equal(response.status, 400, path);
    assertNoStoreJson(response);
    assert.deepEqual(response.json, { error: "Invalid tasks query" });
  }
  const withBody = await send(port, { path: query(), headers: { "content-length": "2" }, body: "{}" });
  assert.equal(withBody.status, 400);
  assert.deepEqual(calls, []);
});

test("a missing store, a throwing read, or a malformed board is unavailable and empty, never a ready board", async (context) => {
  const unavailable = { version: 1, readiness: "unavailable", repositoryId: REPOSITORY_ID, columns: [], features: [], tasks: [], queue: EMPTY_QUEUE, runModels: { codex: [] } };
  const cases = [
    ["missing store", undefined],
    ["throwing read", recordingStore(() => { throw new Error("C:\\private\\path failed"); }).store],
    ["non-object board", recordingStore(() => null).store],
    ["desktop_only from a store", recordingStore(() => ({ ...secretBoard(), readiness: "desktop_only" })).store],
    ["missing arrays", recordingStore(() => ({ version: 1, readiness: "ready", queue: EMPTY_QUEUE })).store],
    ["queue without an order", recordingStore(() => ({ ...secretBoard(), queue: { status: "idle", blockedBy: null } })).store],
  ];
  for (const [label, taskStore] of cases) {
    const { port } = await startRoute(context, { taskStore });
    const response = await send(port, { path: query() });
    assert.equal(response.status, 503, label);
    assertNoStoreJson(response);
    assert.deepEqual(response.json, unavailable, label);
    assert.ok(!response.text.includes("private"), label);
  }
});

test("a store that reports itself unavailable or loading is served as given, with empty arrays intact", async (context) => {
  for (const readiness of ["unavailable", "loading"]) {
    const { store } = recordingStore((repositoryId) => ({ version: 1, readiness, repositoryId, columns: [], features: [], tasks: [], queue: EMPTY_QUEUE }));
    const { port } = await startRoute(context, { taskStore: store });
    const response = await send(port, { path: query() });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { version: 1, readiness, repositoryId: REPOSITORY_ID, columns: [], features: [], tasks: [], queue: EMPTY_QUEUE, runModels: { codex: [] } });
  }
});

test("the monitor server composes the injected task store into the same gated route", async (context) => {
  const { store, calls } = recordingStore();
  const server = createMonitorServer({ runtime: {}, taskStore: store, authorizationToken: TOKEN });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);
  assertDesktopOnly(await send(port, { path: query() }), REPOSITORY_ID);
  const allowed = await send(port, { path: query(), headers: withToken });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.tasks[0].text, SECRET_TEXT);
  assert.deepEqual(calls, [["readBoard", REPOSITORY_ID]]);

  const bare = createMonitorServer({ runtime: {} });
  context.after(() => new Promise((resolve) => bare.close(resolve)));
  const barePort = await listen(bare);
  const unavailable = await send(barePort, { path: query() });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.readiness, "unavailable");
});

test("the LAN gateway does not forward the task board", async () => {
  const gateway = await readFile(new URL("../../../desktop/runtime/lan-gateway.mjs", import.meta.url), "utf8");
  assert.ok(!gateway.includes("/api/tasks"), "tasks stay off the LAN gateway route list");
});

test("the board carries runModels.codex from the injected lookup: bounded to 64, invalid ids and labels dropped", async (context) => {
  const rows = [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, { id: "gpt-6.1-sol", label: "duplicate" }, { id: "gpt-5.2", label: "bad\nlabel" },
    { id: "C:\\models\\x", label: "path" }, { id: "../x", label: null }, { id: "x".repeat(121), label: null }, { id: "", label: null }, null,
    ...Array.from({ length: 80 }, (_, index) => ({ id: `model-${index}`, label: index === 0 ? "L".repeat(65) : `Model ${index}` })),
  ];
  const { store } = recordingStore();
  const { port } = await startRoute(context, { taskStore: store, resolveRunModels: () => rows });
  const response = await send(port, { path: query() });
  const codex = response.json.runModels.codex;
  assert.equal(codex.length, 64);
  assert.deepEqual(codex.slice(0, 3), [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, { id: "gpt-5.2", label: null }, { id: "model-0", label: null }]);
  assert.ok(codex.every((row) => Object.keys(row).sort().join() === "id,label"));
});

test("a throwing or missing run-model lookup serves an empty list, and a denied client never reads it", async (context) => {
  const { store } = recordingStore();
  const throwing = await startRoute(context, { taskStore: store, resolveRunModels: () => { throw new Error("boom"); } });
  assert.deepEqual((await send(throwing.port, { path: query() })).json.runModels, { codex: [] });
  const missing = await startRoute(context, { taskStore: store });
  assert.deepEqual((await send(missing.port, { path: query() })).json.runModels, { codex: [] });
  let reads = 0;
  const denied = await startRoute(context, { taskStore: store, authorizationToken: TOKEN, resolveRunModels: () => { reads += 1; return [{ id: "gpt-6.1-sol", label: null }]; } });
  const response = await send(denied.port, { path: query() });
  assert.equal(response.json.readiness, "desktop_only");
  assert.deepEqual(response.json.runModels, { codex: [] });
  assert.equal(reads, 0);
});
