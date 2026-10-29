import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { passingGates } from "./queue-test-support.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const BUILDER = "claude:builder-session";
const REVIEWER = "codex:reviewer-session";
const AGENT_TOKEN = "a".repeat(40);
const DESKTOP_HEADERS = { "x-pomegr-desktop-authorization": "d".repeat(40), "content-type": "application/json" };
const AGENT_HEADERS = { "x-pomegr-agent-authorization": AGENT_TOKEN, "content-type": "application/json" };
const FACTS = { root: "C:/work/repository", pluginReady: true };

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-review-route-"));
  const store = openTaskStore({ directory });
  let closed = false;
  const env = { directory, store, startFacts: FACTS, port: null,
    closeStore() { if (!closed) { closed = true; store.close(); } } };
  const server = http.createServer(createRequestHandler({
    runtime: { resolveTaskStart: () => env.startFacts }, taskStore: store,
    authorizationToken: "d".repeat(40), agentAuthorizationToken: AGENT_TOKEN,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  env.port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    env.closeStore();
    await rm(directory, { recursive: true, force: true });
  });
  return env;
}

function send(port, { method = "POST", path: requestPath, headers = AGENT_HEADERS, body }) {
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

const review = (env, body) => send(env.port, { path: "/api/agent/v1/tasks/review", body: JSON.stringify(body) });
const action = (env, name, payload, { headers = DESKTOP_HEADERS, method = "POST" } = {}) => send(env.port, {
  method, path: `/internal/tasks/${name}`, headers,
  body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload }),
});
const refused = (response, status, reason) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: false, reason });
};
const actionRefused = (response, status, error) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { ok: false, error });
};

function withDatabase(directory, work) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try { return work(database); } finally { database.close(); }
}

test("desktop review plan/abort and agent review report share the intended gates and fixed answers", async (t) => {
  const env = await setup(t);
  assert.equal(env.store.apply(REPOSITORY_ID, "create", { text: "Review route task" }).ok, true);
  const started = env.store.planStart(REPOSITORY_ID, { id: "T-1" }, () => FACTS, passingGates);
  assert.equal(env.store.bindSession({ token: started.plan.token, sessionId: BUILDER }).ok, true);
  assert.deepEqual((await send(env.port, { path: "/api/agent/v1/tasks/complete", body: JSON.stringify({ sessionRef: BUILDER }) })).json.state, "needs_review");

  const first = await action(env, "review-plan", { id: "T-1" });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.json.plan).sort(), ["taskId", "provider", "model", "effort", "repositoryRoot", "prompt", "token"].sort());
  assert.equal(first.json.plan.taskId, "T-1");
  assert.deepEqual((await action(env, "review-abort", { id: "T-1", token: first.json.plan.token })).json, { ok: true });
  const planned = await action(env, "review-plan", { id: "T-1" });
  refused(await review(env, { sessionRef: REVIEWER, verdict: "pass" }), 404, "not_found");
  assert.equal((await send(env.port, { path: "/api/agent/v1/tasks/bind", body: JSON.stringify({ token: planned.json.plan.token, sessionRef: REVIEWER }) })).status, 200);

  withDatabase(env.directory, (database) => database.prepare("UPDATE tasks SET state = 'blocked' WHERE repository_id = ? AND number = 1").run(REPOSITORY_ID));
  refused(await review(env, { sessionRef: REVIEWER, verdict: "pass" }), 409, "not_reviewable");
  withDatabase(env.directory, (database) => database.prepare("UPDATE tasks SET state = 'needs_review' WHERE repository_id = ? AND number = 1").run(REPOSITORY_ID));

  const reasons = Array.from({ length: 10 }, () => "\u7406\u7531".repeat(100));
  const failed = await review(env, { sessionRef: REVIEWER, taskId: "T-1", verdict: "fail", reasons });
  assert.deepEqual(failed.json, { schemaVersion: 1, ok: true });
  assert.doesNotMatch(failed.text, /\u7406\u7531|sessionId|taskId/u);
  const escapedReasons = Array.from({ length: 10 }, () => "\u0001".repeat(200));
  assert.deepEqual((await review(env, { sessionRef: REVIEWER, verdict: "fail", reasons: escapedReasons })).json, { schemaVersion: 1, ok: true });
  assert.deepEqual((await review(env, { sessionRef: REVIEWER, verdict: "pass" })).json, { schemaVersion: 1, ok: true });
});

test("review rejects invalid verdicts, reason sets, and all line separators", async (t) => {
  const env = await setup(t);
  for (const body of [
    { sessionRef: REVIEWER, verdict: "pass", reasons: ["extra"] },
    { sessionRef: REVIEWER, verdict: "pass", extra: true },
    { sessionRef: REVIEWER, verdict: "fail" },
    { sessionRef: REVIEWER, verdict: "fail", reasons: [] },
    { sessionRef: REVIEWER, verdict: "fail", reasons: [""] },
    { sessionRef: REVIEWER, verdict: "fail", reasons: ["x".repeat(201)] },
    { sessionRef: REVIEWER, verdict: "fail", reasons: Array.from({ length: 11 }, () => "x") },
    { sessionRef: REVIEWER, verdict: "fail", reasons: ["line\nbreak"] },
    { sessionRef: REVIEWER, verdict: "fail", reasons: ["line\rbreak"] },
    { sessionRef: REVIEWER, verdict: "fail", reasons: ["line\u2028break"] },
    { sessionRef: REVIEWER, verdict: "fail", reasons: ["line\u2029break"] },
    { sessionRef: REVIEWER, verdict: "fail", reasons: ["\ud83d\ude00".repeat(101)] },
  ]) refused(await review(env, body), 400, "invalid");
});

test("review routes keep their desktop and agent authorization gates and POST methods", async (t) => {
  const env = await setup(t);
  for (const route of ["review-plan", "review-abort"]) {
    assert.equal((await action(env, route, {}, { headers: { "content-type": "application/json" } })).status, 401);
    assert.equal((await action(env, route, {}, { headers: { ...DESKTOP_HEADERS, "x-pomegr-desktop-authorization": "wrong" } })).status, 401);
    assert.equal((await action(env, route, {}, { method: "GET" })).status, 401);
  }
  assert.equal((await send(env.port, { path: "/api/agent/v1/tasks/review", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await send(env.port, { path: "/api/agent/v1/tasks/review", headers: { ...AGENT_HEADERS, "x-pomegr-agent-authorization": "wrong" }, body: "{}" })).status, 401);
  assert.equal((await send(env.port, { method: "GET", path: "/api/agent/v1/tasks/review" })).status, 405);
});

test("review plan returns fixed invalid, missing, not-startable, plugin, and unavailable answers", async (t) => {
  const env = await setup(t);
  actionRefused(await action(env, "review-plan", {}), 400, "invalid");
  actionRefused(await action(env, "review-plan", { id: "T-9" }), 404, "not_found");
  assert.equal(env.store.apply(REPOSITORY_ID, "create", { text: "Not ready" }).ok, true);
  actionRefused(await action(env, "review-plan", { id: "T-1" }), 409, "not_startable");

  const pluginMissing = await setup(t);
  await prepareReviewable(pluginMissing);
  pluginMissing.startFacts = { ...FACTS, pluginReady: false };
  actionRefused(await action(pluginMissing, "review-plan", { id: "T-1" }), 409, "plugin_missing");

  const unavailable = await setup(t);
  await prepareReviewable(unavailable);
  unavailable.startFacts = { ...FACTS, root: null };
  actionRefused(await action(unavailable, "review-plan", { id: "T-1" }), 503, "unavailable");
});

async function prepareReviewable(env) {
  assert.equal(env.store.apply(REPOSITORY_ID, "create", { text: "Reviewable" }).ok, true);
  const start = env.store.planStart(REPOSITORY_ID, { id: "T-1" }, () => FACTS, passingGates);
  assert.equal(env.store.bindSession({ token: start.plan.token, sessionId: BUILDER }).ok, true);
  const completed = await send(env.port, { path: "/api/agent/v1/tasks/complete", body: JSON.stringify({ sessionRef: BUILDER }) });
  assert.equal(completed.json.state, "needs_review");
}

test("a closed task store answers review unavailable without exposing an exception", async (t) => {
  const env = await setup(t);
  env.closeStore();
  refused(await review(env, { sessionRef: REVIEWER, verdict: "pass" }), 503, "unavailable");
});

test("desktop review-session returns only the bound reviewer identity, never the builder", async (t) => {
  const env = await setup(t);
  await prepareReviewable(env);
  const unbound = await action(env, "review-session", { id: "T-1" });
  assert.equal(unbound.status, 200);
  assert.equal(unbound.headers["cache-control"], "no-store");
  assert.deepEqual(unbound.json, { ok: true, sessionId: null, sessionIds: [], reported: false });
  const planned = await action(env, "review-plan", { id: "T-1" });
  assert.equal(env.store.bindSession({ token: planned.json.plan.token, sessionId: REVIEWER }).ok, true);
  const bound = await action(env, "review-session", { id: "T-1" });
  assert.equal(bound.status, 200);
  assert.deepEqual(bound.json, { ok: true, sessionId: REVIEWER, sessionIds: [REVIEWER], reported: false });
  assert.doesNotMatch(bound.text, /builder|repositoryRoot|prompt|token|reasons|plan/u);
  // T-188: a pointer that is not a session ID is not the current review; a kept value that is not one is never served.
  withDatabase(env.directory, (database) => {
    database.prepare("UPDATE meta SET value = ? WHERE key = ?").run("C:/private/reviewer.txt", `task_reviewer:${REPOSITORY_ID}:T-1`);
    database.prepare("INSERT INTO task_reviewers (repository_id, number, session_id, at) VALUES (?, 1, ?, ?)").run(REPOSITORY_ID, "C:/private/kept.txt", Date.now() * 2);
  });
  const fallback = await action(env, "review-session", { id: "T-1" });
  assert.deepEqual(fallback.json, { ok: true, sessionId: null, sessionIds: [REVIEWER], reported: false });
  assert.doesNotMatch(fallback.text, /private/u);
});

test("review-session rejects non-desktop callers and GET", async (t) => {
  const env = await setup(t);
  for (const headers of [
    { "content-type": "application/json" },
    { ...DESKTOP_HEADERS, "x-pomegr-desktop-authorization": "wrong" },
    AGENT_HEADERS,
    { ...DESKTOP_HEADERS, origin: "http://localhost" },
  ]) assert.equal((await action(env, "review-session", { id: "T-1" }, { headers })).status, 401);
  assert.equal((await action(env, "review-session", { id: "T-1" }, { method: "GET" })).status, 401);
});

test("review-session validates the repository envelope and task and fixes missing/unavailable answers", async (t) => {
  const env = await setup(t);
  for (const payload of [{}, { id: "T-0" }, { id: 1 }, { id: "T-1", extra: true }]) {
    actionRefused(await action(env, "review-session", payload), 400, "invalid");
  }
  for (const body of [
    { repositoryId: "../private", payload: { id: "T-1" } },
    { repositoryId: REPOSITORY_ID, payload: { id: "T-1" }, extra: true },
  ]) actionRefused(await send(env.port, {
    path: "/internal/tasks/review-session", headers: DESKTOP_HEADERS, body: JSON.stringify(body),
  }), 400, "invalid");
  actionRefused(await action(env, "review-session", { id: "T-9" }), 404, "not_found");
  env.closeStore();
  actionRefused(await action(env, "review-session", { id: "T-1" }), 503, "unavailable");
});

test("review-session says whether the latest reviewer reported, also once the task is Done", async (t) => {
  const env = await setup(t);
  await prepareReviewable(env);
  const planned = await action(env, "review-plan", { id: "T-1" });
  assert.equal(env.store.bindSession({ token: planned.json.plan.token, sessionId: REVIEWER }).ok, true);
  // Linked without a verdict: the reviewer has not reported.
  assert.equal((await action(env, "review-session", { id: "T-1" })).json.reported, false);
  assert.deepEqual((await review(env, { sessionRef: REVIEWER, verdict: "pass" })).json, { schemaVersion: 1, ok: true });
  const reported = await action(env, "review-session", { id: "T-1" });
  assert.deepEqual(reported.json, { ok: true, sessionId: REVIEWER, sessionIds: [REVIEWER], reported: true });
  // Done clears the board's review, but the verdict stays recorded.
  withDatabase(env.directory, (database) => database.prepare("UPDATE tasks SET state = 'done' WHERE repository_id = ? AND number = 1").run(REPOSITORY_ID));
  assert.equal((await action(env, "review-session", { id: "T-1" })).json.reported, true);
  // A reviewer linked after that verdict, as when the task went back and was requeued, has not reported yet.
  withDatabase(env.directory, (database) => database.prepare("INSERT INTO task_reviewers (repository_id, number, session_id, at) VALUES (?, 1, ?, ?)")
    .run(REPOSITORY_ID, "codex:second-reviewer", Date.now() + 60_000));
  const second = await action(env, "review-session", { id: "T-1" });
  assert.deepEqual(second.json.sessionIds, [REVIEWER, "codex:second-reviewer"]);
  assert.equal(second.json.reported, false);
  // A reviewer value that is not a session ID is never served and never counts as the latest reviewer.
  withDatabase(env.directory, (database) => database.prepare("DELETE FROM task_reviewers WHERE session_id = ?").run("codex:second-reviewer"));
  withDatabase(env.directory, (database) => database.prepare("INSERT INTO task_reviewers (repository_id, number, session_id, at) VALUES (?, 1, ?, ?)")
    .run(REPOSITORY_ID, "C:/private/kept.txt", Date.now() + 60_000));
  assert.equal((await action(env, "review-session", { id: "T-1" })).json.reported, true);
});

