import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_BOUNDS } from "../../../server/tasks/task-record.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const OTHER_REPOSITORY = `repo-${"b2".repeat(12)}`;
const UNKNOWN = `feat-${"0".repeat(12)}`;
const TOKEN = "t".repeat(40);
const SECRET = "FEATURE-DESCRIPTION-do-not-leak";
const withToken = { "x-pomegr-desktop-authorization": TOKEN };
const JSON_BODY = { "content-type": "application/json" };

async function realStore(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-feature-edit-"));
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

async function startRoute(context, store) {
  const server = http.createServer(createRequestHandler({ runtime: {}, taskStore: store, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function send(port, { method = "POST", path: requestPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (response) => {
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

const post = (port, name, body, headers = { ...withToken, ...JSON_BODY }) => send(port, { path: `/internal/tasks/${name}`, headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const action = (port, name, payload, repositoryId = REPOSITORY) => post(port, name, { repositoryId, payload });
const read = (port, id, repositoryId = REPOSITORY) => action(port, "feature-read", { id }, repositoryId);
const featureId = (store, name, repositoryId = REPOSITORY) => store.readBoard(repositoryId).features.find((feature) => feature.name === name).id;

test("feature_create keeps an optional description and app version and still serves only the title", async (context) => {
  const store = await realStore(context);
  assert.equal(store.apply(REPOSITORY, "feature_create", { name: "Search", description: `Line\n${SECRET}`, appVersion: "1.4.0" }).ok, true);
  const id = featureId(store, "Search");
  assert.deepEqual(store.readFeature(REPOSITORY, id), { id, title: "Search", description: `Line\n${SECRET}`, appVersion: "1.4.0" });
  assert.equal(store.apply(REPOSITORY, "feature_create", { name: "Bare" }).ok, true);
  assert.deepEqual(store.readFeature(REPOSITORY, "Bare"), { id: featureId(store, "Bare"), title: "Bare", description: null, appVersion: null });
  const answer = store.apply(REPOSITORY, "feature_create", { name: "Third", description: SECRET, appVersion: "9.9" });
  assert.deepEqual(answer.board.features.map((feature) => Object.keys(feature).sort()), [["done", "id", "name"], ["done", "id", "name"], ["done", "id", "name"]]);
  assert.doesNotMatch(JSON.stringify(answer.board), /FEATURE-DESCRIPTION|9\.9/u);
  for (const payload of [
    { name: "x", description: "x".repeat(TASK_BOUNDS.featureDescriptionLength + 1) }, { name: "x", description: 4 }, { name: "x", appVersion: "1\n2" },
    { name: "x", appVersion: "v".repeat(TASK_BOUNDS.featureAppVersionLength + 1) }, { name: "x", title: "x" },
  ]) assert.deepEqual(store.apply(REPOSITORY, "feature_create", payload), { ok: false, error: "invalid" }, JSON.stringify(payload).slice(0, 60));
  assert.deepEqual(store.apply(REPOSITORY, "feature_create", { name: "Search", description: "again" }), { ok: false, error: "conflict" });
});

test("feature_create refuses a feature past the bound", async (context) => {
  const store = await realStore(context);
  for (let count = 0; count < TASK_BOUNDS.featuresPerRepository; count += 1) assert.equal(store.apply(REPOSITORY, "feature_create", { name: `F${count}` }).ok, true);
  assert.deepEqual(store.apply(REPOSITORY, "feature_create", { name: "More", description: "x" }), { ok: false, error: "limit" });
});

test("feature_update keeps an absent field, clears a null one, and accepts the own title", async (context) => {
  const store = await realStore(context);
  store.apply(REPOSITORY, "feature_create", { name: "One", description: "first", appVersion: "1.0" });
  store.apply(REPOSITORY, "feature_create", { name: "Two" });
  const id = featureId(store, "One");

  assert.equal(store.apply(REPOSITORY, "feature_update", { id, description: "second" }).ok, true);
  assert.deepEqual(store.readFeature(REPOSITORY, id), { id, title: "One", description: "second", appVersion: "1.0" });
  assert.equal(store.apply(REPOSITORY, "feature_update", { id, name: "  Renamed  ", appVersion: null }).ok, true);
  assert.deepEqual(store.readFeature(REPOSITORY, id), { id, title: "Renamed", description: "second", appVersion: null });
  assert.equal(store.apply(REPOSITORY, "feature_update", { id, name: "Renamed", description: null }).ok, true);
  assert.deepEqual(store.readFeature(REPOSITORY, id), { id, title: "Renamed", description: null, appVersion: null });
  assert.equal(store.apply(REPOSITORY, "feature_update", { id, appVersion: "2.0" }).ok, true);
  assert.equal(store.readFeature(REPOSITORY, id).appVersion, "2.0");
  assert.equal(store.apply(REPOSITORY, "feature_update", { id, appVersion: "   " }).ok, true);
  assert.equal(store.readFeature(REPOSITORY, id).appVersion, null);

  assert.deepEqual(store.apply(REPOSITORY, "feature_update", { id, name: "Two" }), { ok: false, error: "conflict" });
  assert.equal(store.readFeature(REPOSITORY, id).title, "Renamed");
  assert.deepEqual(store.apply(REPOSITORY, "feature_update", { id: UNKNOWN, name: "Nope" }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "feature_update", { id, name: "Nope" }), { ok: false, error: "not_found" });
  for (const payload of [
    {}, { id }, { name: "x" }, { id: "Renamed", name: "x" }, { id: "feat-xyz", name: "x" }, { id, name: "" }, { id, name: "two\nlines" }, { id, name: "x".repeat(81) },
    { id, description: "x".repeat(TASK_BOUNDS.featureDescriptionLength + 1) }, { id, description: 4 }, { id, appVersion: "1\n2" },
    { id, appVersion: "v".repeat(TASK_BOUNDS.featureAppVersionLength + 1) }, { id, title: "x" }, { id, name: "x", extra: 1 }, null, "x", [],
  ]) assert.deepEqual(store.apply(REPOSITORY, "feature_update", payload), { ok: false, error: "invalid" }, JSON.stringify(payload)?.slice(0, 60));
});

test("feature_update through the route answers the fixed statuses and never the description", async (context) => {
  const store = await realStore(context);
  const port = await startRoute(context, store);
  await action(port, "feature_create", { name: "One", description: SECRET, appVersion: "7.7.7" });
  await action(port, "feature_create", { name: "Two" });
  const id = featureId(store, "One");

  const renamed = await action(port, "feature_update", { id, name: "Renamed", description: `${SECRET} 2`, appVersion: "8.8.8" });
  assert.equal(renamed.status, 200);
  assert.deepEqual(Object.keys(renamed.json).sort(), ["board", "ok"]);
  assert.doesNotMatch(renamed.text, /FEATURE-DESCRIPTION|7\.7\.7|8\.8\.8/u);
  assert.deepEqual(renamed.json.board.features.map((feature) => feature.name), ["Renamed", "Two"]);
  const conflict = await action(port, "feature_update", { id, name: "Two" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json, { ok: false, error: "conflict" });
  assert.equal((await action(port, "feature_update", { id: UNKNOWN, name: "x" })).status, 404);
  assert.equal((await action(port, "feature_update", { id })).status, 400);
  assert.equal((await post(port, "feature_update", { repositoryId: REPOSITORY, payload: { id, name: "Z" } }, JSON_BODY)).status, 401);

  // The desktop marks the feature done and reopens it; the board serves the stored flag.
  const marked = await action(port, "feature_update", { id, done: true });
  assert.equal(marked.status, 200);
  assert.deepEqual(marked.json.board.features.map((feature) => [feature.name, feature.done]), [["Renamed", true], ["Two", false]]);
  assert.equal((await action(port, "create", { text: "late", featureId: id })).status, 409);
  assert.equal((await action(port, "feature_update", { id, done: "yes" })).status, 400);
  const reopened = await action(port, "feature_update", { id, done: false });
  assert.equal(reopened.json.board.features[0].done, false);
  assert.equal((await action(port, "create", { text: "again", featureId: id })).status, 200);
});

test("the feature read answers the two fields, desktop only, with exact inputs", async (context) => {
  const store = await realStore(context);
  const port = await startRoute(context, store);
  await action(port, "feature_create", { name: "One", description: SECRET, appVersion: "1.2" });
  await action(port, "feature_create", { name: "Bare" });
  const id = featureId(store, "One");

  const found = await read(port, id);
  assert.equal(found.status, 200);
  assert.equal(found.headers["cache-control"], "no-store");
  assert.deepEqual(found.json, { ok: true, feature: { description: SECRET, appVersion: "1.2" } });
  assert.deepEqual((await read(port, featureId(store, "Bare"))).json, { ok: true, feature: { description: null, appVersion: null } });

  const missing = await read(port, UNKNOWN);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { ok: false, error: "not_found" });
  assert.equal((await read(port, id, OTHER_REPOSITORY)).status, 404);
  for (const body of [
    { repositoryId: REPOSITORY, payload: { id: "One" } }, { repositoryId: REPOSITORY, payload: { id: "feat-xyz" } }, { repositoryId: REPOSITORY, payload: {} },
    { repositoryId: REPOSITORY, payload: { id, name: "x" } }, { repositoryId: REPOSITORY, payload: [id] }, { repositoryId: "repo-short", payload: { id } },
    { repositoryId: REPOSITORY, payload: { id }, extra: 1 }, { payload: { id } }, "not json", [],
  ]) {
    const refused = await post(port, "feature-read", body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.deepEqual(refused.json, { ok: false, error: "invalid" });
  }
  const query = await send(port, { path: "/internal/tasks/feature-read?x=1", headers: { ...withToken, ...JSON_BODY }, body: JSON.stringify({ repositoryId: REPOSITORY, payload: { id } }) });
  assert.equal(query.status, 400);
  const body = { repositoryId: REPOSITORY, payload: { id } };
  assert.equal((await post(port, "feature-read", body, JSON_BODY)).status, 401);
  assert.equal((await post(port, "feature-read", body, { "x-pomegr-desktop-authorization": "x".repeat(40), ...JSON_BODY })).status, 401);
  assert.equal((await post(port, "feature-read", body, { ...withToken, ...JSON_BODY, origin: "http://127.0.0.1:3003" })).status, 401);
});

test("the feature read answers a bounded value only and a fixed unavailable when the store fails", async (context) => {
  const inner = await realStore(context);
  const long = { id: `feat-${"1".repeat(12)}`, description: "x".repeat(2001), appVersion: "v".repeat(41) };
  const base = { readBoard: inner.readBoard, apply: inner.apply, close() {} };
  const port = await startRoute(context, { ...base, readFeature: () => long });
  assert.deepEqual((await read(port, long.id)).json, { ok: true, feature: { description: null, appVersion: null } });
  const broken = await startRoute(context, { ...base, readFeature() { throw new Error("C:\\secret\\path"); } });
  const failed = await read(broken, long.id);
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.json, { ok: false, error: "unavailable" });
  const absent = await startRoute(context, base);
  assert.equal((await read(absent, long.id)).status, 503);
});

test("GET /api/tasks holds no description and no app version after a feature has both", async (context) => {
  const store = await realStore(context);
  const port = await startRoute(context, store);
  await action(port, "feature_create", { name: "One", description: SECRET, appVersion: "7.7.7" });
  await action(port, "feature_update", { id: featureId(store, "One"), description: `${SECRET} again` });
  const board = await send(port, { method: "GET", path: `/api/tasks?repositoryId=${REPOSITORY}`, headers: withToken });
  assert.equal(board.json.readiness, "ready");
  assert.deepEqual(board.json.features, [{ id: featureId(store, "One"), name: "One", done: false }]);
  assert.doesNotMatch(board.text, /FEATURE-DESCRIPTION|7\.7\.7/u);
  // `/api/state` never reads the task store, and the home view serves counts and title lines only.
  const home = await send(port, { method: "GET", path: "/api/tasks?view=home", headers: withToken });
  assert.doesNotMatch(home.text, /FEATURE-DESCRIPTION|7\.7\.7/u);
});
