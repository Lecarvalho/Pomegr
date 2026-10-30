import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY_ID = `repo-${"a".repeat(24)}`;
const TOKEN = "d".repeat(40);
const AGENT_TOKEN = "a".repeat(40);
const DESKTOP = { "x-pomegr-desktop-authorization": TOKEN, "content-type": "application/json" };
const PAIRED = { "x-pomegr-desktop-authorization": TOKEN, "x-pomegr-lan-gateway": "1", "content-type": "application/json" };
const GATEWAY = { "x-pomegr-lan-gateway": "1", "content-type": "application/json" };

async function setup(t, { taskStore, runtime = { resolveTaskUsage: () => 10 } } = {}) {
  const directory = await mkdtemp(path.join(process.cwd(), ".aril-grant-route-test-"));
  const store = taskStore ?? openTaskStore({ directory });
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: TOKEN, agentAuthorizationToken: AGENT_TOKEN }));
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
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: 80 },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true,
});

test("grant writing routes keep exact payloads and fixed answers, and serve write steps", async (t) => {
  const { port, store } = await setup(t);
  const body = { repositoryId: REPOSITORY_ID, plan: "next.md", tasks: [{ text: "written" }] };
  fixedError(await post(port, "grant-write-tasks", body), 409, "not_active");
  const settings = defaults();
  settings.actions = { ...settings.actions, start: true, writeTasks: true, markDone: false };
  settings.limits = { ...settings.limits, hours: 1, tasks: 1, tasksAtATime: 1 };
  settings.workRules = [{ kind: "plan", value: "next.md" }];
  assert.equal(store.apply(REPOSITORY_ID, "aril_settings_set", { settings }).ok, true);
  assert.equal(store.apply(REPOSITORY_ID, "grant_start", {}).ok, true);
  assert.deepEqual((await post(port, "grant-next", {})).json, { ok: true, steps: [{ repositoryId: REPOSITORY_ID, kind: "write_tasks", plans: ["next.md"] }] });
  for (const invalid of [{ ...body, extra: true }, { ...body, tasks: [{ text: "" }] }, { ...body, tasks: [{ text: "x", run: {} }] }]) fixedError(await post(port, "grant-write-tasks", invalid), 400, "invalid");
  fixedError(await post(port, "grant-write-tasks", { ...body, plan: "else.md" }), 409, "not_allowed");
  assert.deepEqual((await post(port, "grant-write-tasks", body)).json, { ok: true, taskIds: ["T-1"] });
  fixedError(await post(port, "grant-write-tasks", body), 409, "limit");
});

test("grant writing never returns an arbitrary store failure", async (t) => {
  const { port } = await setup(t, { taskStore: { writeGrantTasks: () => ({ ok: false, error: "unavailable", detail: "private" }) } });
  fixedError(await post(port, "grant-write-tasks", { repositoryId: REPOSITORY_ID, plan: "next.md", tasks: [{ text: "work" }] }), 400, "invalid");
});

test("Aril memory route is desktop-main-only, exact, and applies the lines to the text as it is", async (t) => {
  const { port, store } = await setup(t);
  const body = { repositoryId: REPOSITORY_ID, add: ["Docs in English."], remove: [] };
  for (const headers of [{ "content-type": "application/json" }, { ...DESKTOP, origin: "http://localhost" }, { "x-pomegr-agent-authorization": AGENT_TOKEN, "content-type": "application/json" }]) {
    assert.equal((await post(port, "aril-memory-update", body, headers)).status, 401);
  }
  for (const marker of ["1", "0", ""]) fixedError(await post(port, "aril-memory-update", body, { ...DESKTOP, "x-pomegr-lan-gateway": marker }), 403, "unavailable");
  for (const invalid of [{ ...body, scope: "owner" }, { repositoryId: REPOSITORY_ID, add: ["x"] }, { ...body, repositoryId: "bad" }, { ...body, add: "x" }, { ...body, add: [], remove: [] }, { ...body, add: ["x".repeat(301)] }, envelope(body)]) {
    fixedError(await post(port, "aril-memory-update", invalid), 400, "invalid");
  }
  fixedError(await send(port, { path: "/internal/tasks/aril-memory-update?x=1", body: JSON.stringify(body) }), 400, "invalid");
  assert.deepEqual((await post(port, "aril-memory-update", body)).json, { ok: true, added: 1, removed: 0 });
  assert.deepEqual((await post(port, "aril-memory-update", body)).json, { ok: true, added: 0, removed: 0 });
  assert.equal(store.readBoard(REPOSITORY_ID).aril.memory.updatedBy, "aril");
  fixedError(await post(port, "aril-memory-update", { ...body, add: [], remove: ["A line that is not there."] }), 404, "not_found");
  assert.equal(store.apply(REPOSITORY_ID, "aril_memory_set", { text: Array.from({ length: 20 }, () => `- ${"x".repeat(297)}`).join("\n") }).ok, true);
  fixedError(await post(port, "aril-memory-update", { ...body, add: ["y".repeat(300)] }), 409, "limit");
  const board = await send(port, { method: "GET", path: `/api/tasks?repositoryId=${REPOSITORY_ID}`, headers: DESKTOP });
  assert.deepEqual(Object.keys(board.json.aril.memory).sort(), ["previous", "text", "updatedAt", "updatedBy"], "the board serves the memory in its one shape");
});

test("Aril rework route is desktop-main-only, exact, and answers fixed recording results", async (t) => {
  const { port, store } = await setup(t);
  const body = { repositoryId: REPOSITORY_ID, fix: "#342", reworks: "#336", cause: "missed_wiring" };
  for (const headers of [{ "content-type": "application/json" }, { ...DESKTOP, origin: "http://localhost" }, { "x-pomegr-agent-authorization": AGENT_TOKEN, "content-type": "application/json" }]) {
    assert.equal((await post(port, "aril-declare-rework", body, headers)).status, 401);
  }
  for (const marker of ["1", "0", ""]) fixedError(await post(port, "aril-declare-rework", body, { ...DESKTOP, "x-pomegr-lan-gateway": marker }), 403, "unavailable");
  for (const invalid of [{ ...body, declaredBy: "owner" }, { ...body, cause: "unknown" }, { ...body, fix: "#0342" }, { ...body, repositoryId: "bad" }, envelope(body)]) fixedError(await post(port, "aril-declare-rework", invalid), 400, "invalid");
  fixedError(await send(port, { path: "/internal/tasks/aril-declare-rework?x=1", body: JSON.stringify(body) }), 400, "invalid");
  assert.deepEqual((await post(port, "aril-declare-rework", body)).json, { ok: true, status: "recorded" });
  assert.deepEqual((await post(port, "aril-declare-rework", body)).json, { ok: true, status: "exists" });
  assert.equal(store.readBoard(REPOSITORY_ID).rework[0].cause, body.cause);
  const board = await send(port, { method: "GET", path: `/api/tasks?repositoryId=${REPOSITORY_ID}`, headers: DESKTOP });
  assert.deepEqual(board.json.rework, store.readBoard(REPOSITORY_ID).rework);
});

test("Aril rework route never exposes arbitrary store data", async (t) => {
  const taskStore = { declareArilRework: () => ({ ok: true, status: "recorded", private: "secret" }) };
  const { port } = await setup(t, { taskStore });
  const body = { repositoryId: REPOSITORY_ID, fix: "#342", reworks: "#336", cause: "other" };
  assert.deepEqual((await post(port, "aril-declare-rework", body)).json, { ok: true, status: "recorded" });
  taskStore.declareArilRework = () => ({ ok: false, error: "secret", detail: "private" });
  fixedError(await post(port, "aril-declare-rework", body), 503, "unavailable");
});

test("grant actions use fixed envelopes and the start grant is not ready by default", async (t) => {
  const { port, store } = await setup(t);
  const initial = await post(port, "grant_start", envelope({}));
  fixedError(initial, 409, "not_ready");
  assert.deepEqual(await post(port, "grant_stop", envelope({})).then((response) => response.json), { ok: true });

  const settings = defaults();
  settings.actions.start = true;
  settings.actions.review = true;
  settings.limits = { ...settings.limits, hours: 1, tasks: 1, tasksAtATime: 1 };
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
  readySettings.limits = { ...readySettings.limits, hours: 1, tasks: 1, tasksAtATime: 1 };
  readySettings.pairedDevices = true;
  assert.equal(store.apply(REPOSITORY_ID, "aril_settings_set", { settings: readySettings }).ok, true);
  const started = await post(port, "grant_start", envelope({}), PAIRED);
  assert.equal(started.status, 200);
  assert.deepEqual(Object.keys(started.json), ["ok", "grant"]);
  assert.deepEqual(started.json.grant, store.readBoard(REPOSITORY_ID).aril.grant);
});

test("grant runner routes require desktop authorization and reject paired requests", async (t) => {
  const { port } = await setup(t);
  const requests = [
    ["grant-next", {}],
    ["grant-write-tasks", { repositoryId: REPOSITORY_ID, plan: "next.md", tasks: [{ text: "work" }] }],
    ["grant-check", { repositoryId: REPOSITORY_ID }],
    ["grant-record", { repositoryId: REPOSITORY_ID, taskId: "T-1", kind: "start" }],
    ["grant-send-back", { repositoryId: REPOSITORY_ID, taskId: "T-1" }],
    ["grant-merge-attempt", { repositoryId: REPOSITORY_ID, taskId: "T-1", headOid: "a".repeat(40) }],
    ["grant-merge-result", { repositoryId: REPOSITORY_ID, taskId: "T-1", headOid: "a".repeat(40), outcome: "merged" }],
    ["grant-branch-result", { repositoryId: REPOSITORY_ID, taskId: "T-1", outcome: "deleted" }],
    ["grant-done", { repositoryId: REPOSITORY_ID, taskId: "T-1" }],
    ["grant-end", { repositoryId: REPOSITORY_ID, reason: "app_restart" }],
    ["grant-end-all", { reason: "app_restart" }],
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

test("merge routes pass the committed PR resolver and project only the desktop merge fields", async (t) => {
  const headOid = "a".repeat(40);
  const step = { repositoryId: REPOSITORY_ID, taskId: "T-1", kind: "merge", pullRequest: 42, headOid, mergeMethod: null, mergeMode: "auto" };
  const facts = { number: 42, headOid, state: "open", checks: "passed" };
  const checkResolver = (resolve) => assert.deepEqual(resolve("codex:builder", "T-1"), facts);
  let outcome = { ok: true, pullRequest: 42, output: "private" };
  const { port } = await setup(t, { runtime: { resolveTaskPullRequestFacts: (id, taskId) => {
    assert.equal(id, "codex:builder"); assert.equal(taskId, "T-1"); return facts;
  } }, taskStore: {
    nextGrantSteps({ resolvePullRequestFacts }) { checkResolver(resolvePullRequestFacts); return { ok: true, steps: [{ ...step, output: "private" }] }; },
    attemptGrantMerge(repo, payload, resolve) {
      assert.equal(repo, REPOSITORY_ID); assert.deepEqual(payload, { taskId: "T-1", headOid }); checkResolver(resolve); return outcome;
    },
    recordGrantMerge(repo, payload) {
      assert.equal(repo, REPOSITORY_ID); assert.deepEqual(payload, { taskId: "T-1", headOid, outcome: "merged" }); return outcome;
    },
  } });
  assert.deepEqual((await post(port, "grant-next", {})).json, { ok: true, steps: [step] });
  const body = { repositoryId: REPOSITORY_ID, taskId: "T-1", headOid };
  assert.deepEqual((await post(port, "grant-merge-attempt", body)).json, { ok: true, pullRequest: 42 });
  assert.deepEqual((await post(port, "grant-merge-result", { ...body, outcome: "merged" })).json, { ok: true });
  for (const error of ["not_active", "not_eligible"]) {
    outcome = { ok: false, error, output: "private" };
    fixedError(await post(port, "grant-merge-attempt", body), 409, error);
  }
  for (const invalid of [{ ...body, headOid: "bad" }, { ...body, extra: true }, { ...body, taskId: "bad" }]) fixedError(await post(port, "grant-merge-attempt", invalid), 400, "invalid");
  fixedError(await post(port, "grant-merge-result", { ...body, outcome: "unknown" }), 400, "invalid");
});

test("merge steps carry a known merge mode and branch delete steps project only their fixed fields", async (t) => {
  const headOid = "a".repeat(40);
  const merge = { repositoryId: REPOSITORY_ID, taskId: "T-1", kind: "merge", pullRequest: 42, headOid, mergeMethod: "squash", mergeMode: "direct" };
  const remove = { repositoryId: REPOSITORY_ID, taskId: "T-2", kind: "delete_branch", pullRequest: 7, branch: "tasks/T-2" };
  const { port } = await setup(t, { taskStore: {
    nextGrantSteps: () => ({ ok: true, steps: [{ ...merge, output: "private" }, { ...merge, taskId: "T-3", mergeMode: null }, { ...merge, taskId: "T-4", mergeMode: "queue" },
      { ...remove, output: "private" }, { ...remove, taskId: "T-5", branch: "a..b" }, { ...remove, taskId: "T-6", pullRequest: 0 }, { ...remove, taskId: "T-7", branch: undefined }] }),
    recordGrantBranchDelete(repo, payload) { assert.equal(repo, REPOSITORY_ID); assert.deepEqual(payload, { taskId: "T-2", outcome: "refused" }); return { ok: true, output: "private" }; },
    recordGrantMerge: () => ({ ok: true }),
  } });
  assert.deepEqual((await post(port, "grant-next", {})).json, { ok: true, steps: [merge, remove] });
  const body = { repositoryId: REPOSITORY_ID, taskId: "T-2", outcome: "refused" };
  assert.deepEqual((await post(port, "grant-branch-result", body)).json, { ok: true });
  for (const invalid of [{ ...body, outcome: "gone" }, { ...body, extra: true }, { ...body, taskId: "bad" }, { repositoryId: REPOSITORY_ID, taskId: "T-2" }]) fixedError(await post(port, "grant-branch-result", invalid), 400, "invalid");
  assert.deepEqual((await post(port, "grant-merge-result", { repositoryId: REPOSITORY_ID, taskId: "T-1", headOid, outcome: "auto_enabled" })).json, { ok: true });
});

test("grant-done reads the task's checks fresh through the runtime and answers only fixed shapes (T-182)", async (t) => {
  const markDone = { repositoryId: REPOSITORY_ID, taskId: "T-1", kind: "mark_done" };
  const facts = { number: 42, state: "merged" };
  const checks = { ciPassed: true };
  let outcome = { ok: true, output: "private" };
  const { port } = await setup(t, { runtime: {
    resolveTaskPullRequestFacts: () => facts,
    readTaskCheckFacts: async (ref) => { assert.equal(ref, "codex:builder"); return checks; },
  }, taskStore: {
    nextGrantSteps: () => ({ ok: true, steps: [{ ...markDone, output: "private" }, { ...markDone, run: { provider: "claude", model: null, effort: null } }] }),
    async markGrantDone(repo, payload, { readCheckFacts, resolvePullRequestFacts, resolveOutcomeFacts }) {
      assert.equal(repo, REPOSITORY_ID); assert.deepEqual(payload, { taskId: "T-1" });
      assert.deepEqual(resolvePullRequestFacts("codex:builder", "T-1"), facts);
      assert.equal(typeof resolveOutcomeFacts, "function");
      assert.deepEqual(await readCheckFacts("codex:builder"), checks);
      return outcome;
    },
  } });
  assert.deepEqual((await post(port, "grant-next", {})).json, { ok: true, steps: [markDone] });
  const body = { repositoryId: REPOSITORY_ID, taskId: "T-1" };
  assert.deepEqual((await post(port, "grant-done", body)).json, { ok: true });
  for (const error of ["not_active", "not_eligible"]) {
    outcome = { ok: false, error, output: "private" };
    fixedError(await post(port, "grant-done", body), 409, error);
  }
  outcome = { ok: false, error: "private" };
  fixedError(await post(port, "grant-done", body), 503, "unavailable");
  for (const invalid of [{ ...body, extra: true }, { ...body, taskId: "bad" }, { repositoryId: REPOSITORY_ID }, { taskId: "T-1" }]) fixedError(await post(port, "grant-done", invalid), 400, "invalid");
});

test("grant-end-all accepts only the restart reason and returns the number ended without eligible work", async (t) => {
  const { port, store } = await setup(t);
  const settings = defaults();
  settings.actions.start = true;
  settings.limits = { ...settings.limits, hours: 1, tasks: 1, tasksAtATime: 1 };
  store.apply(REPOSITORY_ID, "aril_settings_set", { settings });
  store.apply(REPOSITORY_ID, "grant_start", {});
  assert.deepEqual(store.nextGrantSteps().steps, []);
  for (const body of [null, [], {}, { reason: "start_failed" }, { reason: "app_restart", repositoryId: REPOSITORY_ID }]) {
    fixedError(await post(port, "grant-end-all", body), 400, "invalid");
  }
  const ended = await post(port, "grant-end-all", { reason: "app_restart" });
  assert.equal(ended.status, 200);
  assert.equal(ended.headers["cache-control"], "no-store");
  assert.deepEqual(ended.json, { ok: true, ended: 1 });
  assert.equal(store.readBoard(REPOSITORY_ID).aril.grant.endReason, "app_restart");
  assert.deepEqual((await post(port, "grant-end-all", { reason: "app_restart" })).json, { ok: true, ended: 0 });
});

test("grant-next projects at most sixteen fixed start and review steps", async (t) => {
  const steps = Array.from({ length: 20 }, (_, index) => ({
    repositoryId: `repo-${index.toString(16).padStart(24, "0")}`,
    taskId: `T-${index + 1}`,
    kind: ["send_back", "review", "start"][index % 3],
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
  settings.limits = { ...settings.limits, hours: 1, tasks: 1, tasksAtATime: 1 };
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

test("grant-send-back validates its body and exposes only fixed results", async (t) => {
  let result = { ok: true, reasons: ["private"] };
  const taskStore = { sendBackGrant(repositoryId, payload) {
    assert.equal(repositoryId, REPOSITORY_ID);
    assert.deepEqual(payload, { taskId: "T-1" });
    return result;
  } };
  const { port } = await setup(t, { taskStore });
  const body = { repositoryId: REPOSITORY_ID, taskId: "T-1" };
  assert.deepEqual((await post(port, "grant-send-back", body)).json, { ok: true });
  for (const error of ["not_active", "not_eligible"]) {
    result = { ok: false, error, reasons: ["private"] };
    fixedError(await post(port, "grant-send-back", body), 409, error);
  }
  for (const invalid of [{}, { ...body, taskId: "bad" }, { ...body, extra: true }]) {
    fixedError(await post(port, "grant-send-back", invalid), 400, "invalid");
  }
});
