import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createTaskAction,
  installTaskActionIpc,
  TASK_ACTION_CHANNEL,
  TASK_ACTION_NAMES,
} from "../desktop/runtime/task-action.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function harness(answer, overrides = {}) {
  const calls = [];
  const action = createTaskAction({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin: origin,
    authorizationToken: "secret",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return typeof answer === "function" ? answer(url, options) : answer;
    },
    ...overrides,
  });
  return { action, calls };
}

const invalid = { ok: false, error: "invalid" };
const unavailable = { ok: false, error: "unavailable" };

test("task action channel and list are fixed", () => {
  assert.equal(TASK_ACTION_CHANNEL, "pomegr:task-action");
  assert.deepEqual([...TASK_ACTION_NAMES], [
    "create", "update", "delete", "move", "column_create", "column_rename", "column_reorder", "column_delete",
    "feature_create", "queue_add", "queue_remove", "queue_reorder", "queue_settings", "resolve_done", "resolve_requeue",
  ]);
});

test("untrusted frame, unknown action, bad ID, and bad payloads are refused without a request", async () => {
  const { action, calls } = harness(() => json({ ok: true }));
  assert.deepEqual(await action.run({}, repositoryId, "create", { text: "x" }), invalid);
  assert.deepEqual(await action.run(undefined, repositoryId, "create", { text: "x" }), invalid);
  assert.deepEqual(await action.run(trusted, repositoryId, "erase", { text: "x" }), invalid);
  assert.deepEqual(await action.run(trusted, repositoryId, "../create", { text: "x" }), invalid);
  assert.deepEqual(await action.run(trusted, repositoryId, undefined, { text: "x" }), invalid);
  for (const id of ["C:\\private", "repo-0123", "repo-0123456789ABCDEF01234567", "repo-0123456789abcdef012345678", undefined, 7]) {
    assert.deepEqual(await action.run(trusted, id, "create", { text: "x" }), invalid);
  }
  for (const payload of [undefined, null, "text", 5, ["a"], new Map(), new (class Task {})(), () => {}]) {
    assert.deepEqual(await action.run(trusted, repositoryId, "create", payload), invalid);
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.deepEqual(await action.run(trusted, repositoryId, "create", cyclic), invalid);
  assert.deepEqual(await action.run(trusted, repositoryId, "create", { n: 1n }), invalid);
  assert.equal(calls.length, 0);
});

test("payload cap is 16 KiB of serialized JSON", async () => {
  const { action, calls } = harness(() => json({ ok: true }));
  const overhead = JSON.stringify({ text: "" }).length;
  assert.deepEqual(await action.run(trusted, repositoryId, "create", { text: "a".repeat(16 * 1024 - overhead + 1) }), invalid);
  assert.equal(calls.length, 0);
  assert.deepEqual(await action.run(trusted, repositoryId, "create", { text: "a".repeat(16 * 1024 - overhead) }), { ok: true });
  assert.equal(calls.length, 1);
  // Multi-byte text counts in bytes, not characters.
  assert.deepEqual(await action.run(trusted, repositoryId, "create", { text: "\u00e9".repeat(9000) }), invalid);
  assert.equal(calls.length, 1);
});

test("a valid call posts once to the fixed monitor URL with the desktop token and the documented body", async () => {
  const { action, calls } = harness(() => json({ ok: true, board: { tasks: [{ id: "T-1", text: "private task text" }] } }));
  const payload = { text: "Write the plan", featureId: null };
  const result = await action.run(trusted, repositoryId, "create", payload);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, `${origin}/internal/tasks/create`);
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.equal(options.headers["x-pomegr-desktop-authorization"], "secret");
  assert.equal(options.headers["content-type"], "application/json");
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), { repositoryId, payload });
});

test("every fixed action maps to its own internal path", async () => {
  const { action, calls } = harness(() => json({ ok: true }));
  for (const name of TASK_ACTION_NAMES) assert.deepEqual(await action.run(trusted, repositoryId, name, {}), { ok: true });
  assert.deepEqual(calls.map((call) => call.url), TASK_ACTION_NAMES.map((name) => `${origin}/internal/tasks/${name}`));
});

test("monitor errors map to the bounded set and nothing else crosses back", async () => {
  for (const error of ["invalid", "not_found", "limit", "conflict", "unsupported"]) {
    const { action } = harness(() => json({ ok: false, error, detail: "C:\\secret\\path", board: { tasks: [] } }, 400));
    assert.deepEqual(await action.run(trusted, repositoryId, "update", { id: "T-1" }), { ok: false, error });
  }
  const unknownValues = [
    { ok: false, error: "teapot" }, { ok: false, error: "unavailable" }, { ok: false, error: 42 },
    { ok: false }, {}, [], null, "ok", { ok: "true" },
  ];
  for (const body of unknownValues) {
    const { action } = harness(() => json(body));
    assert.deepEqual(await action.run(trusted, repositoryId, "update", { id: "T-1" }), unavailable);
  }
  const success = harness(() => json({ ok: true, board: { tasks: [] }, extra: "x" }));
  assert.deepEqual(await success.action.run(trusted, repositoryId, "update", {}), { ok: true });
});

test("network failure, non-JSON, server error, and redirects give unavailable", async () => {
  const thrown = harness(() => { throw new Error("connect ECONNREFUSED C:\\secret"); });
  assert.deepEqual(await thrown.action.run(trusted, repositoryId, "create", { text: "x" }), unavailable);
  const rejected = harness(() => Promise.reject(new TypeError("fetch failed")));
  assert.deepEqual(await rejected.action.run(trusted, repositoryId, "create", { text: "x" }), unavailable);
  const html = harness(() => new Response("<html>oops</html>", { status: 200 }));
  assert.deepEqual(await html.action.run(trusted, repositoryId, "create", { text: "x" }), unavailable);
  const empty = harness(() => new Response(null, { status: 500 }));
  assert.deepEqual(await empty.action.run(trusted, repositoryId, "create", { text: "x" }), unavailable);
  const failedSuccess = harness(() => json({ ok: true }, 500));
  assert.deepEqual(await failedSuccess.action.run(trusted, repositoryId, "create", { text: "x" }), unavailable);
  const redirect = harness((_url, options) => {
    assert.equal(options.redirect, "error");
    throw new TypeError("unexpected redirect");
  });
  assert.deepEqual(await redirect.action.run(trusted, repositoryId, "create", { text: "x" }), unavailable);
});

test("a missing token, a non-loopback origin, or disposal never posts", async () => {
  for (const options of [
    { authorizationToken: undefined },
    { monitorOrigin: "https://example.test" },
    { monitorOrigin: "http://192.168.1.5:4317" },
    { monitorOrigin: undefined },
  ]) {
    const { action, calls } = harness(() => json({ ok: true }), options);
    assert.deepEqual(await action.run(trusted, repositoryId, "create", { text: "x" }), unavailable);
    assert.equal(calls.length, 0);
  }
  const { action, calls } = harness(() => json({ ok: true }));
  action.dispose();
  assert.deepEqual(await action.run(trusted, repositoryId, "create", { text: "x" }), unavailable);
  assert.equal(calls.length, 0);
});

test("IPC registers the fixed channel, passes arguments, and removes the handler", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  };
  let disposed = 0;
  const calls = [];
  const remove = installTaskActionIpc({
    ipcMain,
    action: {
      run: async (...args) => { calls.push(args); return { ok: true }; },
      dispose() { disposed += 1; },
    },
  });
  assert.deepEqual([...handlers.keys()], [TASK_ACTION_CHANNEL]);
  assert.deepEqual(await handlers.get(TASK_ACTION_CHANNEL)(trusted, repositoryId, "create", { text: "x" }), { ok: true });
  assert.deepEqual(calls, [[trusted, repositoryId, "create", { text: "x" }]]);
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(disposed, 1);
  assert.throws(() => installTaskActionIpc({}), TypeError);
});

test("an action that throws resolves unavailable at the IPC boundary", async () => {
  const handlers = new Map();
  installTaskActionIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler() {} },
    action: { run: async () => { throw new Error("C:\\secret"); } },
  });
  assert.deepEqual(await handlers.get(TASK_ACTION_CHANNEL)(trusted, repositoryId, "create", {}), unavailable);
});

test("preload exposes taskAction on the fixed channel and refuses bad calls locally", async () => {
  const preload = await readFile(new URL("../desktop/runtime/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /taskAction\(repositoryId, action, payload\)/u);
  assert.match(preload, /ipcRenderer\.invoke\("pomegr:task-action", repositoryId, action, payload\)/u);
  for (const name of TASK_ACTION_NAMES) assert.ok(preload.includes(`"${name}"`), `preload lists ${name}`);

  const invokes = [];
  let exposed;
  const Module = (await import("node:module")).default;
  const require = Module.createRequire(import.meta.url);
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") {
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
        ipcRenderer: { invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true }); } },
      };
    }
    return original.call(this, request, ...rest);
  };
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    require("../desktop/runtime/preload.cjs");
  } finally {
    Module._load = original;
    globalThis.window = previousWindow;
  }
  assert.equal(typeof exposed.taskAction, "function");
  assert.deepEqual(await exposed.taskAction("nope", "create", {}), invalid);
  assert.deepEqual(await exposed.taskAction(repositoryId, "erase", {}), invalid);
  assert.deepEqual(await exposed.taskAction(repositoryId, "create", "text"), invalid);
  assert.deepEqual(await exposed.taskAction(repositoryId, "create", null), invalid);
  assert.deepEqual(await exposed.taskAction(repositoryId, "create", []), invalid);
  assert.equal(invokes.length, 0);
  assert.deepEqual(await exposed.taskAction(repositoryId, "create", { text: "x" }), { ok: true });
  assert.deepEqual(invokes, [["pomegr:task-action", repositoryId, "create", { text: "x" }]]);
});
