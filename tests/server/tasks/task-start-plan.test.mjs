import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_DISPATCH_UNBOUND_TTL_MS, TASK_PROMPT_OPENING, buildTaskPrompt } from "../../../server/tasks/task-dispatch.mjs";
import { TASK_ACTIONS } from "../../../server/tasks/task-record.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { GATE_FACTS } from "./queue-test-support.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const TOKEN = "d".repeat(40);
const ROOT = "C:\\Work\\SECRET-ROOT\\repo";
const TEXT = "Fix the SECRET-TASK-TEXT flaky test";
const headers = { "x-pomegr-desktop-authorization": TOKEN, "content-type": "application/json" };

async function setup(context, { facts = { root: ROOT, pluginReady: true }, gateFacts = GATE_FACTS } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-start-"));
  const clock = { now: 1_000_000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  const lookups = [];
  const providers = [];
  const runtime = {
    resolveTaskStart(id, provider) { lookups.push(id); providers.push(provider); return typeof facts === "function" ? facts() : facts; },
    resolveTaskGateFacts: () => (typeof gateFacts === "function" ? gateFacts() : gateFacts),
  };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: TOKEN }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise((done) => server.close(done));
    store.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; } catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return { store, clock, lookups, providers, port: server.address().port, directory };
}

function send(port, { method = "POST", path: requestPath, headers: extra = headers, body } = {}) {
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
    request.end(body);
  });
}

const call = (port, name, payload, extra = {}) => send(port, {
  path: `/internal/tasks/${name}`, ...extra, body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload }),
});
const plan = (env, payload) => call(env.port, "start-plan", payload);
const create = (env, payload) => assert.equal(env.store.apply(REPOSITORY_ID, "create", { text: TEXT, ...payload }).ok, true);
const refused = (response, status, error) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { ok: false, error });
};
// Reads or edits the private file directly, as a local reader would.
function withDatabase(directory, work) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try { return work(database); } finally { database.close(); }
}
const dispatchOf = (directory, number) => withDatabase(directory, (database) => database.prepare("SELECT dispatch_token FROM tasks WHERE number = ?").get(number).dispatch_token);

test("a startable task yields the plan with null model and effort", async (context) => {
  const env = await setup(context);
  create(env, {});
  const response = await plan(env, { id: "T-1" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(response.json), ["ok", "plan"]);
  const body = response.json.plan;
  assert.deepEqual(Object.keys(body), ["taskId", "provider", "model", "effort", "repositoryRoot", "worktree", "prompt", "images", "token"]);
  assert.equal(body.taskId, "T-1");
  assert.equal(body.provider, "claude");
  assert.equal(body.model, null);
  assert.equal(body.effort, null);
  assert.equal(body.repositoryRoot, ROOT);
  assert.equal(body.worktree, false);
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(env.lookups, [REPOSITORY_ID]);
});

test("run settings flow into the plan", async (context) => {
  const env = await setup(context);
  create(env, { run: { provider: "claude", model: "claude-opus-4-1", effort: "xhigh" } });
  const response = await plan(env, { id: "T-1" });
  assert.equal(response.json.plan.model, "claude-opus-4-1");
  assert.equal(response.json.plan.effort, "xhigh");
});

test("a queued task is startable and keeps its state", async (context) => {
  const env = await setup(context);
  create(env, {});
  assert.equal(env.store.apply(REPOSITORY_ID, "queue_add", { id: "T-1" }).ok, true);
  assert.equal((await plan(env, { id: "T-1" })).status, 200);
  assert.equal(env.store.readBoard(REPOSITORY_ID).tasks[0].state, "queued");
});

test("the prompt is fixed: opening sentence, id, text, labels, own condition, tool names", () => {
  const task = {
    id: "T-7", text: "--rm -rf the world",
    doneWhen: { checks: ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"], own: "docs updated" },
  };
  const prompt = buildTaskPrompt(task);
  assert.ok(prompt.startsWith(TASK_PROMPT_OPENING));
  assert.ok(!prompt.startsWith("-"));
  for (const part of ["T-7", "--rm -rf the world", "Pull request open", "Working tree clean", "Commit on task branch",
    "Pull request merged", "CI passed", "docs updated", "complete_task", "block_task"]) {
    assert.ok(prompt.includes(part), part);
  }
  const empty = buildTaskPrompt({ id: "T-8", text: "x", doneWhen: { checks: [], own: null } });
  assert.ok(empty.includes("No condition is checked"));
  assert.ok(!empty.includes("Pull request open"));
});

test("a plan is single use and frees again after the TTL", async (context) => {
  const env = await setup(context);
  create(env, {});
  assert.equal((await plan(env, { id: "T-1" })).status, 200);
  refused(await plan(env, { id: "T-1" }), 409, "not_startable");
  env.clock.now += TASK_DISPATCH_UNBOUND_TTL_MS - 1;
  refused(await plan(env, { id: "T-1" }), 409, "not_startable");
  env.clock.now += 1;
  assert.equal((await plan(env, { id: "T-1" })).status, 200);
});

test("abort with the right token frees the task; a wrong token does not", async (context) => {
  const env = await setup(context);
  create(env, {});
  const first = await plan(env, { id: "T-1" });
  const wrong = await call(env.port, "start-abort", { id: "T-1", token: "w".repeat(43) });
  assert.deepEqual(wrong.json, { ok: true });
  refused(await plan(env, { id: "T-1" }), 409, "not_startable");
  const right = await call(env.port, "start-abort", { id: "T-1", token: first.json.plan.token });
  assert.equal(right.status, 200);
  assert.deepEqual(right.json, { ok: true });
  assert.equal(dispatchOf(env.directory, 1), null);
  assert.equal((await plan(env, { id: "T-1" })).status, 200);
  // Idempotent: the spent token still answers ok.
  assert.deepEqual((await call(env.port, "start-abort", { id: "T-1", token: first.json.plan.token })).json, { ok: true });
});

test("abort validates its payload and names unknown tasks", async (context) => {
  const env = await setup(context);
  create(env, {});
  refused(await call(env.port, "start-abort", { id: "T-1" }), 400, "invalid");
  refused(await call(env.port, "start-abort", { id: "T-1", token: "short" }), 400, "invalid");
  refused(await call(env.port, "start-abort", { id: "T-1", token: "a".repeat(43), extra: 1 }), 400, "invalid");
  refused(await call(env.port, "start-abort", { id: "T-9", token: "a".repeat(43) }), 404, "not_found");
});

test("start-plan refusals: invalid, not_found", async (context) => {
  const env = await setup(context);
  create(env, {});
  refused(await plan(env, { id: "T-1", extra: true }), 400, "invalid");
  refused(await plan(env, { id: "task-1" }), 400, "invalid");
  refused(await plan(env, {}), 400, "invalid");
  refused(await plan(env, { id: "T-9" }), 404, "not_found");
  assert.deepEqual(env.lookups, []);
});

test("a Codex task plans a Codex start and asks for the Codex plugin proof", async (context) => {
  let ready = (provider) => provider === "codex";
  const env = await setup(context, { facts: () => ({ root: ROOT, pluginReady: ready(env.providers.at(-1)) }) });
  create(env, { run: { provider: "codex", model: "gpt-6-sol", effort: "xhigh" } });
  create(env, {});
  const answer = await plan(env, { id: "T-1" });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.plan.provider, "codex");
  assert.equal(answer.json.plan.model, "gpt-6-sol");
  assert.equal(answer.json.plan.effort, "xhigh");
  refused(await plan(env, { id: "T-2" }), 409, "plugin_missing");
  assert.deepEqual(env.providers, ["codex", "claude"]);
  ready = () => false;
});

test("a task in another state or with a linked session is not startable", async (context) => {
  const env = await setup(context);
  create(env, {});
  create(env, {});
  withDatabase(env.directory, (database) => database.exec(
    "UPDATE tasks SET state = 'done' WHERE number = 1; UPDATE tasks SET session_id = 'claude:abc' WHERE number = 2",
  ));
  refused(await plan(env, { id: "T-1" }), 409, "not_startable");
  refused(await plan(env, { id: "T-2" }), 409, "not_startable");
});

test("an unknown root is unavailable and missing plugin proof is plugin_missing; neither mints", async (context) => {
  let facts = { root: null, pluginReady: true };
  const env = await setup(context, { facts: () => facts });
  create(env, {});
  refused(await plan(env, { id: "T-1" }), 503, "unavailable");
  facts = { root: ROOT, pluginReady: false };
  refused(await plan(env, { id: "T-1" }), 409, "plugin_missing");
  assert.equal(dispatchOf(env.directory, 1), null);
  facts = { root: ROOT, pluginReady: true };
  assert.equal((await plan(env, { id: "T-1" })).status, 200);
});

test("without runtime facts the start is unavailable", async (context) => {
  const env = await setup(context, { facts: null });
  create(env, {});
  refused(await plan(env, { id: "T-1" }), 503, "unavailable");
});

test("start routes keep the desktop-token gate and are not renderer actions", async (context) => {
  const env = await setup(context);
  create(env, {});
  assert.ok(!TASK_ACTIONS.includes("start-plan") && !TASK_ACTIONS.includes("start-abort"));
  for (const name of ["start-plan", "start-abort"]) {
    const noToken = await call(env.port, name, { id: "T-1" }, { headers: { "content-type": "application/json" } });
    assert.equal(noToken.status, 401);
    const wrong = await call(env.port, name, { id: "T-1" }, { headers: { ...headers, "x-pomegr-desktop-authorization": "e".repeat(40) } });
    assert.equal(wrong.status, 401);
    const get = await send(env.port, { method: "GET", path: `/internal/tasks/${name}`, headers: { "x-pomegr-desktop-authorization": TOKEN } });
    assert.equal(get.status, 401);
  }
  assert.equal(dispatchOf(env.directory, 1), null);
  refused(await call(env.port, "start-other", { id: "T-1" }), 404, "invalid");
});

test("token, digest, mint time and root never reach the board, other action results, or logs", async (context) => {
  const env = await setup(context);
  create(env, {});
  const minted = await plan(env, { id: "T-1" });
  const token = minted.json.plan.token;
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const stored = dispatchOf(env.directory, 1);
  assert.equal(stored, `${digest}:${env.clock.now}`);
  assert.ok(!stored.includes(token));
  const board = await send(env.port, { method: "GET", path: `/api/tasks?repositoryId=${REPOSITORY_ID}`, headers: { "x-pomegr-desktop-authorization": TOKEN } });
  const other = await call(env.port, "update", { id: "T-1", text: "changed" });
  const failure = await plan(env, { id: "T-1" });
  const texts = [board.text, other.text, failure.text, JSON.stringify(env.store.readBoard(REPOSITORY_ID))];
  for (const text of texts) {
    for (const secret of [token, digest, String(env.clock.now), ROOT, "SECRET-ROOT"]) assert.ok(!text.includes(secret), secret);
  }
});

test("the plan asks for a worktree only for a task of a step that holds more than one task", async (context) => {
  const env = await setup(context);
  const feature = env.store.apply(REPOSITORY_ID, "feature_create", { name: "Search" });
  assert.equal(feature.ok, true);
  const featureId = feature.board.features[0].id;
  create(env, { featureId, step: 1 });
  create(env, { featureId, step: 1 });
  create(env, { featureId, step: 2 });
  create(env, {});
  // A step counts its tasks of any state, so a done sibling still means a worktree.
  withDatabase(env.directory, (database) => database.prepare("UPDATE tasks SET state = 'done' WHERE number = 1").run());
  const second = await plan(env, { id: "T-2" });
  assert.equal(second.json.plan.worktree, true);
  assert.equal(second.json.plan.repositoryRoot, ROOT, "the plan names the root, never a worktree path");
  assert.equal((await plan(env, { id: "T-4" })).json.plan.worktree, false, "no feature");
  // T-3 waits on step 1 (T-2 is not done), so the gate holds it.
  refused(await plan(env, { id: "T-3" }), 409, "gate_held");
  withDatabase(env.directory, (database) => database.prepare("UPDATE tasks SET state = 'done', dispatch_token = NULL WHERE number = 2").run());
  assert.equal((await plan(env, { id: "T-3" })).json.plan.worktree, false, "alone in its step");
});
