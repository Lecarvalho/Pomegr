import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY_ID = `repo-${"a".repeat(24)}`;
const TOKEN = "d".repeat(40);
const DESKTOP = { "x-pomegr-desktop-authorization": TOKEN, "content-type": "application/json" };
const PAIRED = { "x-pomegr-desktop-authorization": TOKEN, "x-pomegr-lan-gateway": "1", "content-type": "application/json" };
const GATEWAY = { "x-pomegr-lan-gateway": "1", "content-type": "application/json" };

async function setup(t, { taskStore, runtime = {} } = {}) {
  const directory = await mkdtemp(path.join(process.cwd(), ".aril-grant-route-test-"));
  const store = taskStore ?? openTaskStore({ directory });
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: TOKEN }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (store !== taskStore) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { port: server.address().port, store, directory };
}

function send(port, { method = "POST", path: requestPath, headers = DESKTOP, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* fixed text errors stay text */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

const post = (port, route, body, headers = DESKTOP) => send(port, {
  path: `/internal/tasks/${route}`, headers, body: JSON.stringify(body),
});
const envelope = (payload, repositoryId = REPOSITORY_ID) => ({ repositoryId, payload });
const fixedError = (response, status, error) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { ok: false, error });
};

const defaults = () => ({
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false },
  limits: { hours: null, starts: null, concurrent: null, sendBacks: null, allowancePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false,
});

test("grant actions use fixed envelopes and the start grant is not ready by default", async (t) => {
  const { port, store } = await setup(t);
  const initial = await post(port, "grant_start", envelope({}));
  fixedError(initial, 409, "not_ready");
  assert.deepEqual(await post(port, "grant_stop", envelope({})).then((response) => response.json), { ok: true });

  const settings = defaults();
  settings.actions.start = true;
  settings.actions.review = true;
  settings.limits = { ...settings.limits, hours: 1, starts: 1, concurrent: 1 };
  assert.equal(store.apply(REPOSITORY_ID, "aril_settings_set", { settings }).ok, true);
  const started = await post(port, "grant_start", envelope({}));
  assert.equal(started.status, 200);
  assert.deepEqual(Object.keys(started.json), ["ok", "grant"]);
  assert.deepEqual(Object.keys(started.json.grant).toSorted(), ["actions", "active", "endsAt", "limits", "startsUsed", "startedAt"].toSorted());
  assert.deepEqual(started.json.grant, store.readBoard(REPOSITORY_ID).aril.grant);
  fixedError(await post(port, "grant_start", envelope({})), 409, "conflict");
  assert.deepEqual(await post(port, "grant_stop", envelope({})).then((response) => response.json), { ok: true });
});

test("paired-device marker can stop a grant, never start one, and needs the paired setting", async (t) => {
  const { port, store } = await setup(t);
  fixedError(await post(port, "grant_start", envelope({}), PAIRED), 403, "unavailable");
  assert.deepEqual(await post(port, "grant_stop", envelope({}), PAIRED).then((response) => response.json), { ok: true });
  assert.equal(store.apply(REPOSITORY_ID, "aril_settings_set", { settings: { pairedDevices: true } }).ok, true);
  const readySettings = defaults();
  readySettings.actions.start = true;
  readySettings.actions.review = true;
  readySettings.limits = { ...readySettings.limits, hours: 1, starts: 1, concurrent: 1 };
  readySettings.pairedDevices = true;
  assert.equal(store.apply(REPOSITORY_ID, "aril_settings_set", { settings: readySettings }).ok, true);
  const started = await post(port, "grant_start", envelope({}), PAIRED);
  assert.equal(started.status, 200);
  assert.deepEqual(Object.keys(started.json), ["ok", "grant"]);
  assert.deepEqual(started.json.grant, store.readBoard(REPOSITORY_ID).aril.grant);
});

test("four grant runner routes require desktop authorization and reject paired requests", async (t) => {
  const { port } = await setup(t);
  const requests = [
    ["grant-next", {}],
    ["grant-check", { repositoryId: REPOSITORY_ID }],
    ["grant-record", { repositoryId: REPOSITORY_ID, taskId: "T-1", kind: "start" }],
    ["grant-end", { repositoryId: REPOSITORY_ID, reason: "app_restart" }],
  ];
  for (const [route, body] of requests) {
    const unauthorized = await post(port, route, body, { "content-type": "application/json" });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.text, "Unauthorized");
    const wrongToken = await post(port, route, body, { "x-pomegr-desktop-authorization": "x".repeat(40), "content-type": "application/json" });
    assert.equal(wrongToken.status, 401);
    assert.equal(wrongToken.text, "Unauthorized");
    const wrongMethod = await send(port, { method: "GET", path: `/internal/tasks/${route}`, headers: DESKTOP });
    assert.equal(wrongMethod.status, 401);
    assert.equal(wrongMethod.text, "Unauthorized");
    fixedError(await post(port, route, body, PAIRED), 403, "unavailable");
    const pairedOnly = await post(port, route, body, GATEWAY);
    assert.equal(pairedOnly.status, 401);
    assert.equal(pairedOnly.text, "Unauthorized");
  }
  fixedError(await post(port, "grant-next", { extra: true }), 400, "invalid");
  fixedError(await post(port, "grant-check", {}, DESKTOP), 400, "invalid");
  fixedError(await send(port, { path: "/internal/tasks/grant-next?x=1", headers: DESKTOP, body: "{}" }), 400, "invalid");
});

test("grant-next projects at most sixteen fixed start and review steps", async (t) => {
  const steps = Array.from({ length: 20 }, (_, index) => ({
    repositoryId: `repo-${index.toString(16).padStart(24, "0")}`,
    taskId: `T-${index + 1}`,
    kind: index % 2 ? "review" : "start",
    path: "C:\\private\\repository",
  }));
  const taskStore = {
    nextGrantSteps: () => ({ ok: true, steps }),
  };
  const { port } = await setup(t, { taskStore });
  const response = await post(port, "grant-next", {});
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json), ["ok", "steps"]);
  assert.deepEqual(response.json.steps, steps.slice(0, 16).map(({ repositoryId, taskId, kind }) => ({ repositoryId, taskId, kind })));
  for (const step of response.json.steps) assert.deepEqual(Object.keys(step), ["repositoryId", "taskId", "kind"]);
  assert.equal(response.text.includes("private"), false);
});

test("grant check, record, and end answer their fixed shapes", async (t) => {
  const { port, store } = await setup(t);
  assert.deepEqual(await post(port, "grant-check", { repositoryId: REPOSITORY_ID }).then((response) => response.json), { ok: true, active: false });
  const settings = defaults();
  settings.actions.start = true;
  settings.actions.review = true;
  settings.limits = { ...settings.limits, hours: 1, starts: 1, concurrent: 1 };
  assert.equal(store.apply(REPOSITORY_ID, "aril_settings_set", { settings }).ok, true);
  const started = await post(port, "grant_start", envelope({}));
  assert.equal(started.status, 200);
  assert.deepEqual(Object.keys(started.json), ["ok", "grant"]);
  assert.deepEqual(started.json.grant, store.readBoard(REPOSITORY_ID).aril.grant);
  assert.deepEqual(await post(port, "grant-check", { repositoryId: REPOSITORY_ID }).then((response) => response.json), { ok: true, active: true });
  assert.equal(store.apply(REPOSITORY_ID, "create", { text: "Grant route task" }).ok, true);
  assert.deepEqual(await post(port, "grant-record", { repositoryId: REPOSITORY_ID, taskId: "T-1", kind: "start" }).then((response) => response.json), { ok: true });
  assert.deepEqual(await post(port, "grant-end", { repositoryId: REPOSITORY_ID, reason: "start_failed" }).then((response) => response.json), { ok: true });
  fixedError(await post(port, "grant-record", { repositoryId: REPOSITORY_ID, taskId: "T-1", kind: "start" }), 409, "not_active");
});

test("grant endpoints reject malformed envelopes and flat bodies", async (t) => {
  const { port } = await setup(t);
  for (const body of [
    {}, { repositoryId: REPOSITORY_ID }, envelope([]), envelope({}, "repo-invalid"), { ...envelope({}), extra: 1 },
  ]) fixedError(await post(port, "grant_start", body), 400, "invalid");
  for (const [route, body] of [
    ["grant-next", { extra: true }], ["grant-check", {}], ["grant-check", { repositoryId: REPOSITORY_ID, extra: true }],
    ["grant-record", { repositoryId: REPOSITORY_ID, taskId: "T-1", kind: "unknown" }],
    ["grant-end", { repositoryId: REPOSITORY_ID, reason: "unknown" }],
  ]) fixedError(await post(port, route, body), 400, "invalid");
});
