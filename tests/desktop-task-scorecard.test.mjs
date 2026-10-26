import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

import { createTaskScorecard, installTaskScorecardIpc, TASK_SCORECARD_CHANNEL } from "../desktop/runtime/task-scorecard.mjs";
import { installTaskScorecardIpc as reexported } from "../desktop/runtime/task-action.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";
const appVersion = "1.2.0-beta+1";
const invalid = { ok: false, error: "invalid" };
const unavailable = { ok: false, error: "unavailable" };
const snapshot = () => ({ version: "1.2.0", takenAt: 123, measures: {
  ownerTurns: { value: 2, sample: 3 }, reviewToDoneMs: { value: null, sample: 0 }, firstPass: { value: 0.5, sample: 2 }, reworkRate: { value: 0.25, sample: 4 },
} });
const scorecard = () => ({ formula: 2, current: snapshot(), baseline: null });
const response = (value, ok = true) => ({ ok, json: async () => value });

function harness(answer = response({ ok: true, scorecard: scorecard() }), overrides = {}) {
  const calls = [];
  const action = createTaskScorecard({
    isTrustedEvent: (event) => event?.trusted === true, monitorOrigin: origin, authorizationToken: "secret", appVersion,
    fetch: async (url, options) => { calls.push({ url, options }); return typeof answer === "function" ? answer() : answer; },
    ...overrides,
  });
  return { action, calls };
}

test("the channel is fixed and task-action re-exports the installer", () => {
  assert.equal(TASK_SCORECARD_CHANNEL, "pomegr:task-scorecard");
  assert.equal(reexported, installTaskScorecardIpc);
});

test("untrusted events and bad repository IDs send nothing", async () => {
  const { action, calls } = harness();
  for (const event of [{}, undefined]) assert.deepEqual(await action.run(event, repositoryId), invalid);
  for (const id of ["C:\\private", "repo-0123", "repo-0123456789ABCDEF01234567", undefined, 7, {}]) {
    assert.deepEqual(await action.run(trusted, id), invalid);
  }
  assert.equal(calls.length, 0);
});

test("a bad app version is unavailable without a request", async () => {
  for (const version of [undefined, null, 7, {}, "", "v".repeat(41), "1 2", "1/2", "1.0\n"]) {
    const { action, calls } = harness(undefined, { appVersion: version });
    assert.deepEqual(await action.run(trusted, repositoryId), unavailable);
    assert.equal(calls.length, 0);
  }
});

test("a read carries the main process version and token and returns only bounded fields", async () => {
  const value = scorecard();
  value.baseline = snapshot();
  value.extra = "private";
  value.current.extra = "private";
  value.current.measures.extra = "private";
  value.current.measures.ownerTurns.extra = "private";
  const { action, calls } = harness(response({ ok: true, scorecard: value, extra: "private" }));
  const result = await action.run(trusted, repositoryId, "renderer-version");
  assert.deepEqual(result, { ok: true, scorecard: { ...scorecard(), baseline: snapshot() } });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls[0].url, `${origin}/internal/tasks/scorecard-read`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["x-pomegr-desktop-authorization"], "secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), { repositoryId, payload: { appVersion } });
  assert.deepEqual(await harness().action.run(trusted, repositoryId), { ok: true, scorecard: scorecard() });
  for (const version of ["a", "v".repeat(40)]) {
    const edge = scorecard();
    edge.current.version = version;
    assert.deepEqual(await harness(response({ ok: true, scorecard: edge }), { appVersion: version }).action.run(trusted, repositoryId), { ok: true, scorecard: edge });
  }
});

test("malformed scorecards are unavailable, including non-JSON numbers", async () => {
  const mutations = [
    (s) => { s.formula = 1.5; }, (s) => { s.formula = Number.MAX_SAFE_INTEGER + 1; },
    (s) => { delete s.baseline; }, (s) => { s.current = null; }, (s) => { s.baseline = []; },
  ];
  for (const key of ["current", "baseline"]) {
    for (const version of ["", "v".repeat(41), 7]) mutations.push((s) => { s[key].version = version; });
    mutations.push((s) => { s[key].takenAt = 1.5; });
    mutations.push((s) => { delete s[key].measures.firstPass; });
    mutations.push((s) => { delete s[key].measures.reworkRate; });
    mutations.push((s) => { s[key].measures.reworkRate.value = 1.01; });
    mutations.push((s) => { s[key].measures.firstPass.value = 1.01; });
    for (const measure of ["ownerTurns", "reviewToDoneMs", "firstPass", "reworkRate"]) {
      for (const value of [NaN, Infinity, -1, "1", undefined]) mutations.push((s) => { s[key].measures[measure].value = value; });
      for (const sample of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null]) mutations.push((s) => { s[key].measures[measure].sample = sample; });
    }
  }
  for (const mutate of mutations) {
    const value = { ...scorecard(), baseline: snapshot() };
    mutate(value);
    assert.deepEqual(await harness(response({ ok: true, scorecard: value })).action.run(trusted, repositoryId), unavailable);
  }
  for (const body of [[], "x", { ok: true }, { ok: true, scorecard: [] }, { ok: false }, { ok: false, error: "private" }]) {
    assert.deepEqual(await harness(response(body)).action.run(trusted, repositoryId), unavailable);
  }
});

test("fixed monitor errors pass through and failures are unavailable", async () => {
  for (const error of ["invalid", "unavailable"]) {
    assert.deepEqual(await harness(response({ ok: false, error }, false)).action.run(trusted, repositoryId), { ok: false, error });
  }
  for (const answer of [response({ ok: true, scorecard: scorecard() }, false), () => { throw new Error("private"); }, { ok: true, json: async () => { throw new Error("private"); } }]) {
    assert.deepEqual(await harness(answer).action.run(trusted, repositoryId), unavailable);
  }
  for (const overrides of [{ monitorOrigin: "https://example.com" }, { authorizationToken: "" }]) {
    const { action, calls } = harness(undefined, overrides);
    assert.deepEqual(await action.run(trusted, repositoryId), unavailable);
    assert.equal(calls.length, 0);
  }
  const { action, calls } = harness();
  action.dispose();
  assert.deepEqual(await action.run(trusted, repositoryId), unavailable);
  assert.equal(calls.length, 0);
});

test("the IPC handler installs, contains errors, and disposes", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  let disposed = false;
  const remove = installTaskScorecardIpc({ ipcMain, action: { run: async (event, repo) => ({ event, repo }), dispose() { disposed = true; } } });
  assert.deepEqual([...handlers.keys()], [TASK_SCORECARD_CHANNEL]);
  assert.deepEqual(await handlers.get(TASK_SCORECARD_CHANNEL)(trusted, repositoryId), { event: trusted, repo: repositoryId });
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(disposed, true);
  installTaskScorecardIpc({ ipcMain, action: { run: async () => { throw new Error("private"); } } });
  assert.deepEqual(await handlers.get(TASK_SCORECARD_CHANNEL)(trusted, repositoryId), unavailable);
  assert.throws(() => installTaskScorecardIpc({}), TypeError);
});

test("preload exposes a repository-only scorecard read", async () => {
  let api;
  const calls = [];
  vm.runInNewContext(await readFile(new URL("../desktop/runtime/preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } }),
    window: { addEventListener() {} },
  });
  assert.equal((await api.taskScorecard("bad")).error, "invalid");
  assert.equal(calls.length, 0);
  await api.taskScorecard(repositoryId, "renderer-version");
  assert.deepEqual(calls, [[TASK_SCORECARD_CHANNEL, repositoryId]]);
});
