import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { createTaskLog, installTaskLogIpc, TASK_LOG_CHANNEL, TASK_LOG_KINDS } from "../desktop/runtime/task-log.mjs";
import { installTaskLogIpc as reexported } from "../desktop/runtime/task-action.mjs";
import { TASK_LOG_KINDS as serverKinds } from "../server/tasks/task-log.mjs";
import { DESKTOP_RUNTIME_FILES } from "../desktop/packaging/artifact-policy.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";
const invalid = { ok: false, error: "invalid" };
const unavailable = { ok: false, error: "unavailable" };
const entry = () => ({ id: 1, task: "T-2", kind: "started", at: 123, pullRequest: null });
const log = () => ({ entries: [entry()], more: false, cursors: { aril: 0 }, latestId: 1 });
const response = (value, ok = true) => ({ ok, json: async () => value });
function harness(answer = response({ ok: true, log: log() }), overrides = {}) {
  const calls = [];
  const action = createTaskLog({ isTrustedEvent: (event) => event?.trusted === true, monitorOrigin: origin, authorizationToken: "secret",
    fetch: async (url, options) => { calls.push({ url, options }); return typeof answer === "function" ? answer() : answer; }, ...overrides });
  return { action, calls };
}

test("fixed channel, kinds, export, registration and packaging", async () => {
  assert.equal(TASK_LOG_CHANNEL, "pomegr:task-log");
  assert.deepEqual(TASK_LOG_KINDS, serverKinds);
  assert.equal(reexported, installTaskLogIpc);
  assert.ok(DESKTOP_RUNTIME_FILES.includes("desktop/runtime/task-log.mjs"));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.build.files.includes("desktop/runtime/task-log.mjs"));
  const shell = await readFile(new URL("../desktop/runtime/shell-main.mjs", import.meta.url), "utf8");
  assert.match(shell, /installTaskLogIpc\(\{ \.\.\.taskBridge, action: taskLog \}\)/u);
  assert.match(shell, /taskLog: taskLog\.readLog/u);
  assert.ok(TASK_LOG_KINDS.includes("grant_task_written"));
});

test("untrusted events and bad repositories send nothing", async () => {
  const { action, calls } = harness();
  for (const event of [{}, undefined]) assert.deepEqual(await action.run(event, repositoryId), invalid);
  for (const id of ["C:\\private", "repo-0123", "repo-0123456789ABCDEF01234567", undefined, 7, {}]) assert.deepEqual(await action.run(trusted, id), invalid);
  assert.equal(calls.length, 0);
});

test("reads exactly 200 without ack and re-bounds all fields", async () => {
  const value = log();
  value.entries = TASK_LOG_KINDS.map((kind, i) => ({ ...entry(), id: i + 1, kind, pullRequest: i + 1, private: "hidden" }));
  value.cursors.private = "hidden";
  const { action, calls } = harness(response({ ok: true, log: value, private: "hidden" }));
  assert.deepEqual(await action.run(trusted, repositoryId, { after: 1 }), { ok: true, log: {
    entries: value.entries.map(({ id, task, kind, at, pullRequest }) => ({ id, task, kind, at, pullRequest })), more: false, arilCursor: 0,
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${origin}/internal/tasks/log-read`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["x-pomegr-desktop-authorization"], "secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), { repositoryId, payload: { limit: 200 } });
  const full = { entries: Array.from({ length: 200 }, (_, i) => ({ ...entry(), id: i + 1 })), more: true, cursors: { aril: 100 } };
  assert.deepEqual(await harness(response({ ok: true, log: full })).action.run(trusted, repositoryId), { ok: true, log: { entries: full.entries, more: true, arilCursor: 100 } });
});

test("the shared reader re-bounds without a window event while IPC still requires trust", async () => {
  const value = log(); value.entries[0].private = "hidden"; value.cursors.private = "hidden";
  const { action, calls } = harness(response({ ok: true, log: value }));
  assert.deepEqual(await action.readLog(repositoryId), { ok: true, log: { entries: [entry()], more: false, arilCursor: 0 } });
  const handlers = new Map();
  const remove = installTaskLogIpc({ action, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) } });
  assert.deepEqual(await handlers.get(TASK_LOG_CHANNEL)({}, repositoryId), invalid);
  assert.equal(calls.length, 1);
  assert.deepEqual(await handlers.get(TASK_LOG_CHANNEL)(trusted, repositoryId), await action.readLog(repositoryId));
  remove();
  assert.deepEqual(await action.readLog(repositoryId), unavailable);
});

test("malformed entries, kind, bounds, cursor and envelopes are unavailable", async () => {
  const mutations = [(s) => { s.entries = []; s.entries.length = 201; }, (s) => { s.entries = {}; }, (s) => { s.more = 1; }, (s) => { delete s.cursors; }];
  for (const value of [-1, 0.5, undefined, "1", NaN, Number.MAX_SAFE_INTEGER + 1]) mutations.push((s) => { s.cursors.aril = value; });
  for (const [field, values] of Object.entries({ id: [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1], task: ["T-0", "T-01", "T-x", 1], kind: ["unknown", "toString", null], at: [1.5, NaN, Infinity, "1"], pullRequest: [undefined, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1] })) {
    for (const value of values) mutations.push((s) => { s.entries[0][field] = value; });
  }
  mutations.push((s) => { s.entries[0] = null; });
  for (const mutate of mutations) { const value = log(); mutate(value); assert.deepEqual(await harness(response({ ok: true, log: value })).action.run(trusted, repositoryId), unavailable); }
  for (const body of [[], null, { ok: true }, { ok: true, log: [] }, { ok: false, error: "private" }]) assert.deepEqual(await harness(response(body)).action.run(trusted, repositoryId), unavailable);
  assert.deepEqual(await harness(response({ ok: true, log: log() }, false)).action.run(trusted, repositoryId), unavailable);
  assert.deepEqual(await harness(() => { throw new Error("private"); }).action.run(trusted, repositoryId), unavailable);
});

test("untrusted origins, absent authorization and disposed reads are unavailable", async () => {
  for (const overrides of [{ monitorOrigin: "https://example.com" }, { authorizationToken: null }]) {
    const { action, calls } = harness(undefined, overrides);
    assert.deepEqual(await action.run(trusted, repositoryId), unavailable); assert.equal(calls.length, 0);
  }
  const { action, calls } = harness(); action.dispose();
  assert.deepEqual(await action.run(trusted, repositoryId), unavailable); assert.equal(calls.length, 0);
});

test("IPC contains errors and disposes the fixed handler", async () => {
  const handlers = new Map(); let disposed = false;
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  const remove = installTaskLogIpc({ ipcMain, action: { run: async () => { throw new Error("private"); }, dispose() { disposed = true; } } });
  assert.deepEqual([...handlers.keys()], [TASK_LOG_CHANNEL]);
  assert.deepEqual(await handlers.get(TASK_LOG_CHANNEL)(trusted, repositoryId), unavailable);
  remove(); assert.equal(handlers.size, 0); assert.equal(disposed, true);
});

test("preload exposes only a repository ID read", async () => {
  let api; const calls = [];
  vm.runInNewContext(await readFile(new URL("../desktop/runtime/preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } }), window: { addEventListener() {} },
  });
  assert.equal((await api.taskLog("bad")).error, "invalid"); assert.equal(calls.length, 0);
  await api.taskLog(repositoryId, { limit: 999, after: 1 });
  assert.deepEqual(calls, [[TASK_LOG_CHANNEL, repositoryId]]);
});
