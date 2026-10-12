import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_ACTIONS as ROUTE_ACTIONS } from "../../../server/serving/task-routes.mjs";
import { buildTaskPrompt } from "../../../server/tasks/task-dispatch.mjs";
import { TASK_ACTIONS, TASK_BOUNDS } from "../../../server/tasks/task-record.mjs";
import { FACTS, OTHER_REPOSITORY, REPOSITORY, SESSION, createTask, metaValue, openTemporaryStore, passingGates, setMeta, startedTask } from "./queue-test-support.mjs";

const TOKEN = "f".repeat(40);
const SECRET = "FEATURE-DESCRIPTION-do-not-leak";
const SESSIONS = { "claude:known": REPOSITORY, "claude:other": OTHER_REPOSITORY, "claude:norepo": null };
const headers = { "x-pomegr-agent-authorization": TOKEN, "content-type": "application/json" };
const PATHS = Object.fromEntries(["get", "create", "update", "delete"].map((name) => [name, `/api/agent/v1/tasks/feature-${name}`]));
const FEATURE_ID = /^feat-[0-9a-f]{12}$/u;

const descriptionKey = (featureId, repositoryId = REPOSITORY) => `feature_description:${repositoryId}:${featureId}`;
const appVersionKey = (featureId, repositoryId = REPOSITORY) => `feature_app_version:${repositoryId}:${featureId}`;

function createFeature(store, payload, repositoryId = REPOSITORY) {
  const result = store.apply(repositoryId, "agent_feature_create", payload);
  assert.equal(result.ok, true);
  assert.match(result.featureId, FEATURE_ID);
  return result.featureId;
}

async function start(context, store) {
  const runtime = { resolveTaskSession: (ref) => (Object.hasOwn(SESSIONS, ref) ? { found: true, repositoryId: SESSIONS[ref] } : null) };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, agentAuthorizationToken: TOKEN }));
  context.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return server.address().port;
}

function send(port, requestPath, payload, { method = "POST", extra = headers, sessionRef = "claude:known" } = {}) {
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
    request.end(typeof payload === "string" ? payload : JSON.stringify({ sessionRef, ...payload }));
  });
}

const refused = (response, status, expected) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: false, reason: expected });
};

test("a feature keeps a title, a description, and an app version, and the board still serves only its name", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-feature-");
  const featureId = createFeature(store, { title: "  Offline mode  ", description: `Line one\n${SECRET}`, appVersion: "1.4.0" });
  assert.deepEqual(store.readFeature(REPOSITORY, featureId), { id: featureId, title: "Offline mode", description: `Line one\n${SECRET}`, appVersion: "1.4.0" });
  assert.deepEqual(store.readFeature(REPOSITORY, "Offline mode"), store.readFeature(REPOSITORY, featureId));
  assert.equal(metaValue(directory, descriptionKey(featureId)), `Line one\n${SECRET}`);
  assert.equal(metaValue(directory, appVersionKey(featureId)), "1.4.0");
  // The description and the app version are read only through `get_feature`.
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(board.features, [{ id: featureId, name: "Offline mode", done: false }]);
  assert.doesNotMatch(JSON.stringify(board), /FEATURE-DESCRIPTION|1\.4\.0/u);

  const bare = createFeature(store, { title: "Bare" });
  assert.deepEqual(store.readFeature(REPOSITORY, bare), { id: bare, title: "Bare", description: null, appVersion: null });
  assert.equal(metaValue(directory, descriptionKey(bare)), null);
  // A feature made in the desktop app has no description and no app version.
  assert.equal(store.apply(REPOSITORY, "feature_create", { name: "Desktop" }).ok, true);
  assert.deepEqual({ ...store.readFeature(REPOSITORY, "Desktop"), id: null }, { id: null, title: "Desktop", description: null, appVersion: null });
  assert.deepEqual(store.apply(REPOSITORY, "feature_create", { name: "More", extra: "x" }), { ok: false, error: "invalid" });

  assert.equal(store.readFeature(REPOSITORY, "Missing"), null);
  assert.equal(store.readFeature(REPOSITORY, "feat-000000000000"), null);
  assert.equal(store.readFeature(OTHER_REPOSITORY, featureId), null);
  assert.equal(store.readFeature("not-a-repository", featureId), null);
  for (const reference of [null, undefined, 7, "", "two\nlines", "x".repeat(81)]) assert.equal(store.readFeature(REPOSITORY, reference), null, String(reference));
});

test("create refuses a duplicate title, an invalid field, and a feature past the bound", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-task-feature-");
  createFeature(store, { title: "One" });
  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_create", { title: "One", description: "again" }), { ok: false, error: "conflict" });
  for (const payload of [
    {}, { title: "" }, { title: "two\nlines" }, { title: "x".repeat(TASK_BOUNDS.featureNameLength + 1) }, { title: "ok", name: "ok" },
    { title: "ok", description: "x".repeat(TASK_BOUNDS.featureDescriptionLength + 1) }, { title: "ok", description: "bad\u0000" }, { title: "ok", description: 4 },
    { title: "ok", appVersion: "1\n2" }, { title: "ok", appVersion: "x".repeat(TASK_BOUNDS.featureAppVersionLength + 1) }, { title: "ok", sessionId: "claude:x" },
    null, "One", [],
  ]) assert.deepEqual(store.apply(REPOSITORY, "agent_feature_create", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.equal(store.apply(REPOSITORY, "agent_feature_create", { title: "Longest", description: "x".repeat(TASK_BOUNDS.featureDescriptionLength), appVersion: "v".repeat(TASK_BOUNDS.featureAppVersionLength) }).ok, true);
  for (let count = store.readBoard(REPOSITORY).features.length; count < TASK_BOUNDS.featuresPerRepository; count += 1) createFeature(store, { title: `Feature ${count}` });
  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_create", { title: "One too many" }), { ok: false, error: "limit" });
  assert.equal(store.readBoard(REPOSITORY).features.length, TASK_BOUNDS.featuresPerRepository);
});

test("update replaces only the fields it carries, clears with null, and keeps titles unique", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-feature-");
  const featureId = createFeature(store, { title: "One", description: "first", appVersion: "1.0" });
  createFeature(store, { title: "Two" });
  createTask(store, REPOSITORY, { featureId });
  const before = store.readBoard(REPOSITORY).tasks[0];

  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_update", { feature: "One", description: "second" }).featureId, featureId);
  assert.deepEqual(store.readFeature(REPOSITORY, featureId), { id: featureId, title: "One", description: "second", appVersion: "1.0" });
  assert.equal(store.apply(REPOSITORY, "agent_feature_update", { feature: featureId, title: "Renamed", appVersion: null }).ok, true);
  assert.deepEqual(store.readFeature(REPOSITORY, "Renamed"), { id: featureId, title: "Renamed", description: "second", appVersion: null });
  assert.equal(metaValue(directory, appVersionKey(featureId)), null);
  assert.equal(store.readFeature(REPOSITORY, "One"), null);
  // An empty description is no description.
  assert.equal(store.apply(REPOSITORY, "agent_feature_update", { feature: featureId, description: "   " }).ok, true);
  assert.equal(store.readFeature(REPOSITORY, featureId).description, null);
  // Its own title again is not a conflict; another feature's title is.
  assert.equal(store.apply(REPOSITORY, "agent_feature_update", { feature: featureId, title: "Renamed" }).ok, true);
  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_update", { feature: featureId, title: "Two" }), { ok: false, error: "conflict" });
  assert.equal(store.readFeature(REPOSITORY, featureId).title, "Renamed");

  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_update", { feature: "Missing", title: "x" }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "agent_feature_update", { feature: featureId, title: "x" }), { ok: false, error: "not_found" });
  for (const payload of [{ feature: featureId }, { title: "x" }, { feature: featureId, title: "" }, { feature: featureId, title: null }, { feature: featureId, description: 3 },
    { feature: featureId, appVersion: "a\nb" }, { feature: featureId, title: "x", id: featureId }, { feature: 7, title: "x" }]) {
    assert.deepEqual(store.apply(REPOSITORY, "agent_feature_update", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  }
  // The feature's task is untouched: no state, step, or update time moved.
  assert.deepEqual(store.readBoard(REPOSITORY).tasks[0], before);
});

test("delete removes only a feature with no task, with its description and app version", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-feature-");
  const empty = createFeature(store, { title: "Empty", description: SECRET, appVersion: "2.0" });
  const used = createFeature(store, { title: "Used", description: "kept" });
  createTask(store, REPOSITORY, { featureId: used });

  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_delete", { feature: "Used" }), { ok: false, error: "conflict" });
  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_delete", { feature: used }), { ok: false, error: "conflict" });
  assert.equal(store.readFeature(REPOSITORY, used).description, "kept");
  assert.equal(store.readBoard(REPOSITORY).tasks[0].featureId, used);

  assert.deepEqual(store.apply(OTHER_REPOSITORY, "agent_feature_delete", { feature: empty }), { ok: false, error: "not_found" });
  const deleted = store.apply(REPOSITORY, "agent_feature_delete", { feature: empty });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.board.features.map((feature) => feature.name), ["Used"]);
  assert.equal(store.readFeature(REPOSITORY, empty), null);
  assert.equal(metaValue(directory, descriptionKey(empty)), null);
  assert.equal(metaValue(directory, appVersionKey(empty)), null);
  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_delete", { feature: empty }), { ok: false, error: "not_found" });
  for (const payload of [{}, { feature: "" }, { feature: empty, force: true }, { id: empty }]) {
    assert.deepEqual(store.apply(REPOSITORY, "agent_feature_delete", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  }
  // Once its task is gone the feature can go too.
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-1" }).ok, true);
  assert.equal(store.apply(REPOSITORY, "agent_feature_delete", { feature: used }).ok, true);
  assert.deepEqual(store.readBoard(REPOSITORY).features, []);
});

test("a stored description or app version outside the contract reads as not set", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-feature-");
  const featureId = createFeature(store, { title: "One" });
  setMeta(directory, descriptionKey(featureId), "x".repeat(TASK_BOUNDS.featureDescriptionLength + 1));
  setMeta(directory, appVersionKey(featureId), "two\nlines");
  assert.deepEqual(store.readFeature(REPOSITORY, featureId), { id: featureId, title: "One", description: null, appVersion: null });
  assert.equal(store.readBoard(REPOSITORY).readiness, "ready");
});

test("the feature actions are store only: no desktop or paired-device action names them", () => {
  for (const list of [TASK_ACTIONS, ROUTE_ACTIONS]) {
    assert.equal(list.some((name) => name.startsWith("agent_")), false);
    assert.deepEqual(list.filter((name) => name.startsWith("feature_")), ["feature_create", "feature_update"]);
  }
});

test("the session prompt names the task's feature by title and ID and nothing else of it", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-task-feature-");
  const featureId = createFeature(store, { title: "Offline \"mode\"", description: SECRET, appVersion: "9.9.9-secret" });
  createTask(store, REPOSITORY, { text: "In a feature", featureId });
  createTask(store, REPOSITORY, { text: "Alone" });

  const inFeature = store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates);
  assert.equal(inFeature.ok, true);
  const line = `This task is part of the feature "Offline "mode"" (${featureId}). When you need the feature's description or app version, call the Pomegr MCP tool get_feature.`;
  const lines = inFeature.plan.prompt.split("\n");
  assert.equal(lines.filter((entry) => entry === line).length, 1);
  assert.equal(lines.indexOf(line), lines.indexOf("Complete when:") - 1);
  assert.doesNotMatch(inFeature.plan.prompt, /FEATURE-DESCRIPTION|9\.9\.9/u);

  const alone = store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates);
  assert.equal(alone.ok, true);
  assert.doesNotMatch(alone.plan.prompt, /feature|get_feature/u);

  const task = { id: "T-3", text: "x", completeWhen: { checks: [], own: null } };
  assert.equal(buildTaskPrompt(task, [], null), buildTaskPrompt(task));
  for (const feature of [{}, { id: featureId }, { title: "x" }, { id: 4, title: "x" }, "feature"]) assert.equal(buildTaskPrompt(task, [], feature), buildTaskPrompt(task), JSON.stringify(feature));
});

test("feature-get answers the four fields, by ID, by title, or for the session's own task", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-feature-");
  const port = await start(context, store);
  const featureId = createFeature(store, { title: "Offline mode", description: SECRET, appVersion: "1.4.0" });
  const feature = { id: featureId, title: "Offline mode", description: SECRET, appVersion: "1.4.0" };

  for (const reference of [featureId, "Offline mode"]) {
    const response = await send(port, PATHS.get, { feature: reference });
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json, { schemaVersion: 1, ok: true, feature });
  }
  // Without a feature only a session started for a task of a feature has one to read.
  refused(await send(port, PATHS.get, {}), 404, "not_found");
  createTask(store, REPOSITORY, { featureId });
  startedTask(directory, 1, { session: SESSION });
  // The linked session reads its task's board even when its committed repository is another one or unknown.
  assert.deepEqual((await send(port, PATHS.get, {}, { sessionRef: SESSION })).json, { schemaVersion: 1, ok: true, feature });
  assert.deepEqual((await send(port, PATHS.get, { feature: "Offline mode" }, { sessionRef: SESSION })).json.feature, feature);

  refused(await send(port, PATHS.get, { feature: "Missing" }), 404, "not_found");
  refused(await send(port, PATHS.get, { feature: featureId }, { sessionRef: "claude:other" }), 404, "not_found");
  refused(await send(port, PATHS.get, { feature: featureId }, { sessionRef: "claude:unknown" }), 404, "session_not_found");
  refused(await send(port, PATHS.get, { feature: featureId }, { sessionRef: "claude:norepo" }), 409, "repository_unavailable");
  for (const payload of [{ feature: "" }, { feature: 4 }, { feature: "x".repeat(81) }, { feature: featureId, repositoryId: REPOSITORY }, { feature: featureId, title: "x" }, { sessionRef: "bad ref" }]) {
    refused(await send(port, PATHS.get, payload), 400, "invalid");
  }
  refused(await send(port, PATHS.get, "not json"), 400, "invalid");
  refused(await send(port, `${PATHS.get}?repositoryId=${REPOSITORY}`, { feature: featureId }), 400, "invalid");
});

test("feature-create, feature-update, and feature-delete write the session's own board and echo no content", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-task-feature-");
  const port = await start(context, store);

  const created = await send(port, PATHS.create, { title: "Offline mode", description: SECRET, appVersion: "1.4.0" });
  assert.equal(created.status, 200);
  assert.match(created.json.featureId, FEATURE_ID);
  assert.deepEqual(created.json, { schemaVersion: 1, ok: true, featureId: created.json.featureId });
  const { featureId } = created.json;
  assert.deepEqual(store.readFeature(REPOSITORY, featureId), { id: featureId, title: "Offline mode", description: SECRET, appVersion: "1.4.0" });
  assert.deepEqual(store.readBoard(OTHER_REPOSITORY).features, []);
  refused(await send(port, PATHS.create, { title: "Offline mode" }), 409, "conflict");
  for (const payload of [{}, { title: "" }, { title: "x", feature: featureId }, { title: "x", description: 4 }, { title: "x", description: "x".repeat(2001) }, { title: "x", appVersion: "x".repeat(41) }, { title: "x", repositoryId: REPOSITORY }]) {
    refused(await send(port, PATHS.create, payload), 400, "invalid");
  }
  refused(await send(port, PATHS.create, { title: "two\nlines" }), 400, "invalid");

  const updated = await send(port, PATHS.update, { feature: "Offline mode", title: "Offline", description: null, appVersion: "1.5.0" });
  assert.deepEqual(updated.json, { schemaVersion: 1, ok: true, featureId });
  assert.doesNotMatch(updated.text, /Offline|1\.5\.0/u);
  assert.deepEqual(store.readFeature(REPOSITORY, featureId), { id: featureId, title: "Offline", description: null, appVersion: "1.5.0" });
  refused(await send(port, PATHS.update, { feature: featureId }), 400, "invalid");
  refused(await send(port, PATHS.update, { title: "x" }), 400, "invalid");
  refused(await send(port, PATHS.update, { feature: "Missing", title: "x" }), 404, "not_found");
  refused(await send(port, PATHS.update, { feature: featureId, title: "x" }, { sessionRef: "claude:other" }), 404, "not_found");

  createTask(store, REPOSITORY, { featureId });
  refused(await send(port, PATHS.delete, { feature: featureId }), 409, "conflict");
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-1" }).ok, true);
  refused(await send(port, PATHS.delete, { feature: featureId }, { sessionRef: "claude:other" }), 404, "not_found");
  refused(await send(port, PATHS.delete, {}), 400, "invalid");
  assert.deepEqual((await send(port, PATHS.delete, { feature: featureId })).json, { schemaVersion: 1, ok: true });
  assert.deepEqual(store.readBoard(REPOSITORY).features, []);
  refused(await send(port, PATHS.delete, { feature: featureId }), 404, "not_found");
});

test("the feature paths take a POST from the agent gate only", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-task-feature-");
  const port = await start(context, store);
  for (const requestPath of Object.values(PATHS)) {
    const get = await send(port, requestPath, "", { method: "GET" });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, "POST");
    assert.equal((await send(port, requestPath, { title: "x", feature: "x" }, { extra: { "content-type": "application/json" } })).status, 401);
    assert.equal((await send(port, requestPath, { title: "x", feature: "x" }, { extra: { ...headers, origin: "http://evil.example" } })).status, 401);
    refused(await send(port, requestPath, { title: "x", feature: "x" }, { extra: { ...headers, "content-type": "text/plain" } }), 400, "invalid");
  }
  assert.deepEqual(store.readBoard(REPOSITORY).features, []);
  // No other path was added beside them.
  assert.equal((await send(port, "/api/agent/v1/tasks/feature-list", {})).status, 405);
});

test("a missing store or session lookup answers unavailable", async (context) => {
  for (const [taskStore, runtime] of [[null, { resolveTaskSession: () => ({ found: true, repositoryId: REPOSITORY }) }], [{ apply() {}, readFeature() {} }, {}],
    [{ apply() { throw new Error("boom"); }, readFeature() { throw new Error("boom"); } }, { resolveTaskSession: () => ({ found: true, repositoryId: REPOSITORY }) }]]) {
    const server = http.createServer(createRequestHandler({ runtime, taskStore, agentAuthorizationToken: TOKEN }));
    context.after(() => new Promise((done) => server.close(done)));
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const bodies = { [PATHS.get]: { feature: "x" }, [PATHS.create]: { title: "x" }, [PATHS.update]: { feature: "x", title: "y" }, [PATHS.delete]: { feature: "x" } };
    for (const requestPath of Object.values(PATHS)) refused(await send(server.address().port, requestPath, bodies[requestPath]), 503, "unavailable");
  }
});
