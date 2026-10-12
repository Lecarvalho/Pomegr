import assert from "node:assert/strict";
import test from "node:test";

import { createTaskFeature, installTaskFeatureIpc, TASK_FEATURE_CHANNEL } from "../desktop/runtime/task-feature.mjs";
import { installTaskFeatureIpc as reexported } from "../desktop/runtime/task-action.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const featureId = "feat-0123456789ab";
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";
const invalid = { ok: false, error: "invalid" };
const unavailable = { ok: false, error: "unavailable" };

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function harness(answer, overrides = {}) {
  const calls = [];
  const feature = createTaskFeature({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin: origin,
    authorizationToken: "secret",
    fetch: async (url, options) => { calls.push({ url, options }); return typeof answer === "function" ? answer(url, options) : answer; },
    ...overrides,
  });
  return { feature, calls };
}

test("the channel is fixed and task-action re-exports the installer", () => {
  assert.equal(TASK_FEATURE_CHANNEL, "pomegr:task-feature");
  assert.equal(reexported, installTaskFeatureIpc);
});

test("an untrusted frame and bad IDs are refused without a request", async () => {
  const { feature, calls } = harness(() => json({ ok: true, feature: { description: null, appVersion: null } }));
  assert.deepEqual(await feature.run({}, repositoryId, featureId), invalid);
  assert.deepEqual(await feature.run(undefined, repositoryId, featureId), invalid);
  for (const id of ["C:\\private", "repo-0123", "repo-0123456789ABCDEF01234567", undefined, 7]) assert.deepEqual(await feature.run(trusted, id, featureId), invalid);
  for (const id of ["Search", "feat-xyz", "feat-0123456789AB", "../feat-0123456789ab", "feat-0123456789abc", undefined, 7, {}]) assert.deepEqual(await feature.run(trusted, repositoryId, id), invalid);
  assert.equal(calls.length, 0);
});

test("a read posts only the two IDs with the desktop authorization and answers the two fields", async () => {
  const { feature, calls } = harness(() => json({ ok: true, feature: { description: "Context\nmore", appVersion: "1.2.0", extra: "dropped" }, title: "dropped" }));
  assert.deepEqual(await feature.run(trusted, repositoryId, featureId), { ok: true, description: "Context\nmore", appVersion: "1.2.0" });
  assert.equal(calls[0].url, `${origin}/internal/tasks/feature-read`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-pomegr-desktop-authorization"], "secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), { repositoryId, payload: { id: featureId } });
  const bare = harness(() => json({ ok: true, feature: { description: null, appVersion: null } }));
  assert.deepEqual(await bare.feature.run(trusted, repositoryId, featureId), { ok: true, description: null, appVersion: null });
});

test("an answer is bounded: an oversize or mistyped field reads as none, and a foreign shape is unavailable", async () => {
  const oversize = harness(() => json({ ok: true, feature: { description: "x".repeat(2001), appVersion: "v".repeat(41) } }));
  assert.deepEqual(await oversize.feature.run(trusted, repositoryId, featureId), { ok: true, description: null, appVersion: null });
  const typed = harness(() => json({ ok: true, feature: { description: 5, appVersion: { a: 1 } } }));
  assert.deepEqual(await typed.feature.run(trusted, repositoryId, featureId), { ok: true, description: null, appVersion: null });
  const edge = harness(() => json({ ok: true, feature: { description: "x".repeat(2000), appVersion: "v".repeat(40) } }));
  assert.deepEqual(await edge.feature.run(trusted, repositoryId, featureId), { ok: true, description: "x".repeat(2000), appVersion: "v".repeat(40) });
  for (const body of [{ ok: true }, { ok: true, feature: "x" }, [], "x", { ok: false, error: "secret text" }, { ok: false }]) {
    assert.deepEqual(await harness(() => json(body)).feature.run(trusted, repositoryId, featureId), unavailable, JSON.stringify(body));
  }
  assert.deepEqual(await harness(() => json({ ok: true, feature: { description: "x", appVersion: null } }, 500)).feature.run(trusted, repositoryId, featureId), unavailable);
  assert.deepEqual(await harness(() => new Response("not json")).feature.run(trusted, repositoryId, featureId), unavailable);
});

test("the monitor's fixed refusals pass through and a failure is unavailable", async () => {
  for (const error of ["invalid", "not_found", "unavailable"]) {
    assert.deepEqual(await harness(() => json({ ok: false, error }, 404)).feature.run(trusted, repositoryId, featureId), { ok: false, error }, error);
  }
  assert.deepEqual(await harness(() => json({ ok: false, error: "conflict" }, 409)).feature.run(trusted, repositoryId, featureId), unavailable);
  assert.deepEqual(await harness(() => { throw new Error("C:\\secret"); }).feature.run(trusted, repositoryId, featureId), unavailable);
  assert.deepEqual(await harness(() => json({}), { monitorOrigin: "http://example.com" }).feature.run(trusted, repositoryId, featureId), unavailable);
  assert.deepEqual(await harness(() => json({}), { authorizationToken: "" }).feature.run(trusted, repositoryId, featureId), unavailable);
  const disposed = harness(() => json({}));
  disposed.feature.dispose();
  assert.deepEqual(await disposed.feature.run(trusted, repositoryId, featureId), unavailable);
});

test("the IPC handler is installed once on its channel, answers fixed results, and removes itself", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  let disposed = false;
  const remove = installTaskFeatureIpc({ ipcMain, action: { run: async (_event, repo, id) => ({ ok: true, repo, id }), dispose() { disposed = true; } } });
  assert.deepEqual([...handlers.keys()], [TASK_FEATURE_CHANNEL]);
  assert.deepEqual(await handlers.get(TASK_FEATURE_CHANNEL)(trusted, repositoryId, featureId), { ok: true, repo: repositoryId, id: featureId });
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(disposed, true);
  installTaskFeatureIpc({ ipcMain, action: { run: async () => { throw new Error("C:\\secret"); } } });
  assert.deepEqual(await handlers.get(TASK_FEATURE_CHANNEL)(trusted, repositoryId, featureId), unavailable);
  assert.throws(() => installTaskFeatureIpc({}), TypeError);
});
