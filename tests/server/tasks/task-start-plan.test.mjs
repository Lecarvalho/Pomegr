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
import { taskStartRevision } from "../../../shared/task-start-revision.mjs";

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
  assert.deepEqual(Object.keys(body), ["taskId", "provider", "model", "effort", "remoteControl", "repositoryRoot", "worktree", "prompt", "images", "token"]);
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
  assert.equal(response.json.plan.remoteControl, false);
});

test("Remote Control flows into the plan of a Claude Code task, named or by default", async (context) => {
  const env = await setup(context);
  create(env, { run: { remoteControl: true } });
  create(env, { run: { provider: "claude", remoteControl: true } });
  assert.equal((await plan(env, { id: "T-1" })).json.plan.remoteControl, true);
  assert.equal((await plan(env, { id: "T-2" })).json.plan.remoteControl, true);
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
    completeWhen: { checks: ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed", "user_validated"], own: "docs updated" },
  };
  const prompt = buildTaskPrompt(task);
  assert.ok(prompt.startsWith(TASK_PROMPT_OPENING));
  assert.ok(!prompt.startsWith("-"));
  for (const part of ["T-7", "--rm -rf the world", "Pull request open", "Working tree clean", "Commit on task branch",
    "Pull request merged", "CI passed", "Validated with the user", "docs updated", "complete_task", "block_task"]) {
    assert.ok(prompt.includes(part), part);
  }
  assert.ok(prompt.endsWith("When the task is complete, call the Pomegr MCP tool complete_task. It puts the task in Review for the owner. "
    + "It takes two optional fields: attention, one line for what needs the owner's attention, and task_id, only when you have more than one task. "
    + "A finished task with nothing to flag is reported with no field. If you cannot proceed, call the Pomegr MCP tool block_task with a short reason. The latest report wins until the owner marks the task done. Reporting completion after a block runs the checks and moves the task to Review, but keeps the queue hold until the owner chooses Mark done or Requeue."));
  const empty = buildTaskPrompt({ id: "T-8", text: "x", completeWhen: { checks: [], own: null } });
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

const queue = (env, ...ids) => ids.forEach((id) => assert.equal(env.store.apply(REPOSITORY_ID, "queue_add", { id }).ok, true));
const group = (env, ...ids) => assert.equal(env.store.apply(REPOSITORY_ID, "queue_group", { ids }).ok, true);
const pilot = (env, id = "T-1", overrides = {}) => {
  const task = env.store.readBoard(REPOSITORY_ID).tasks.find((entry) => entry.id === id);
  return { id, autonomous: { attemptId: `pilot-${"a".repeat(24)}_${id}`, expectedUpdatedAt: task.updatedAt, expectedTaskDigest: taskStartRevision(task), expectedRun: task.run, ...overrides } };
};

test("autonomous selection is atomic, preserves effort and owner flags, and is private", async (context) => {
  const env = await setup(context);
  create(env, { run: { effort: "xhigh", keepWorktree: true } });
  const request = pilot(env, "T-1", { run: { provider: "codex", model: "gpt-6-sol", effort: "low" } });
  const answer = await plan(env, request);
  assert.equal(answer.status, 200);
  assert.equal(answer.json.plan.provider, "codex");
  assert.equal(answer.json.plan.model, "gpt-6-sol");
  assert.equal(answer.json.plan.effort, "xhigh");
  const task = env.store.readBoard(REPOSITORY_ID).tasks[0];
  assert.equal(task.run.keepWorktree, true);
  assert.ok(!JSON.stringify(task).includes(request.autonomous.attemptId));
  refused(await plan(env, request), 409, "already_attempted");
});

test("autonomous plans preserve explicit provider default models and reject stale run/revision selections", async (context) => {
  const env = await setup(context);
  create(env, { run: { provider: "claude" } });
  refused(await plan(env, pilot(env, "T-1", { expectedUpdatedAt: new Date(0).toISOString() })), 409, "not_startable");
  refused(await plan(env, pilot(env, "T-1", { expectedRun: { provider: "codex" } })), 409, "not_startable");
  assert.equal(dispatchOf(env.directory, 1), null);
  const answer = await plan(env, pilot(env, "T-1", { run: { provider: "codex", model: "gpt-6-sol" } }));
  assert.equal(answer.json.plan.provider, "claude");
  assert.equal(answer.json.plan.model, null);
});

test("autonomous digest refuses same-millisecond text and condition edits without claiming or selecting a run", async (context) => {
  const env = await setup(context);
  for (const [index, change] of [
    { text: "Changed task text", checks: "[]", own: null },
    { text: TEXT, checks: '["tree_clean"]', own: "Changed completion condition" },
  ].entries()) {
    create(env, {});
    const id = `T-${index + 1}`;
    const request = pilot(env, id, { run: { provider: "codex", model: "gpt-6-sol" } });
    withDatabase(env.directory, (database) => database.prepare("UPDATE tasks SET text = ?, checks = ?, own_condition = ? WHERE number = ?")
      .run(change.text, change.checks, change.own, index + 1));
    const changed = env.store.readBoard(REPOSITORY_ID).tasks.find((task) => task.id === id);
    assert.equal(changed.updatedAt, request.autonomous.expectedUpdatedAt, "the edit deliberately retains the exact timestamp");
    assert.notEqual(taskStartRevision(changed), request.autonomous.expectedTaskDigest);
    refused(await plan(env, request), 409, "not_startable");
    assert.equal(dispatchOf(env.directory, index + 1), null);
    assert.equal(changed.run.provider, null);
  }
});

test("task revision canonicalizes absent flags and arrays and excludes borrowed session facts", async (context) => {
  const env = await setup(context);
  create(env, {});
  const task = env.store.readBoard(REPOSITORY_ID).tasks[0];
  const digest = taskStartRevision(task);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(taskStartRevision({ ...task, after: [], images: [], run: { ...task.run, remoteControl: false, keepWorktree: false },
    session: { id: "codex:borrowed", title: "new observation", state: "working" }, assigned: [{ id: "claude:assigned" }], report: { at: "ignored" } }), digest);
  for (const expectedTaskDigest of [undefined, "bad", "A".repeat(64)]) {
    refused(await plan(env, pilot(env, "T-1", { expectedTaskDigest })), 400, "invalid");
  }
});

test("autonomous selection gates the chosen provider before writing its run or durable claim", async (context) => {
  let gateFacts = { ...GATE_FACTS, usage: { ...GATE_FACTS.usage, codex: { fiveHourPercent: 99 } } };
  const env = await setup(context, { gateFacts: () => gateFacts });
  create(env, {});
  const request = pilot(env, "T-1", { run: { provider: "codex", model: "gpt-6-sol" } });
  refused(await plan(env, request), 409, "gate_held");
  assert.equal(env.store.readBoard(REPOSITORY_ID).tasks[0].run.provider, null);
  assert.equal(dispatchOf(env.directory, 1), null);
  gateFacts = GATE_FACTS;
  assert.equal((await plan(env, request)).status, 200);
});

test("autonomous starts respect Ready order, dependencies, and final committed gate changes", async (context) => {
  let gateFacts = GATE_FACTS;
  const env = await setup(context, { gateFacts: () => gateFacts });
  create(env, {}); create(env, {});
  queue(env, "T-1", "T-2");
  refused(await plan(env, pilot(env, "T-2")), 409, "gate_held");
  assert.equal(env.store.apply(REPOSITORY_ID, "after_set", { id: "T-1", after: ["T-2"] }).ok, true);
  refused(await plan(env, pilot(env, "T-1")), 409, "gate_held");
  assert.equal(env.store.apply(REPOSITORY_ID, "after_set", { id: "T-1", after: [] }).ok, true);
  gateFacts = { ...GATE_FACTS, treeClean: false };
  refused(await plan(env, pilot(env)), 409, "tree_dirty");
  const answer = await plan(env, { ...pilot(env), worktree: true });
  assert.equal(answer.status, 200);
  const payload = { id: "T-1", token: answer.json.plan.token, worktree: true };
  assert.equal((await call(env.port, "start-check", payload)).status, 200);
  gateFacts = { ...GATE_FACTS, treeClean: false };
  assert.equal((await call(env.port, "start-check", payload)).status, 200, "the already prepared separate worktree is independent of root dirt");
  gateFacts = { ...GATE_FACTS, providerStatus: { ...GATE_FACTS.providerStatus, claude: "incident" } };
  refused(await call(env.port, "start-check", payload), 409, "gate_held");
  gateFacts = { ...GATE_FACTS, treeClean: false };
  refused(await call(env.port, "start-check", { id: payload.id, token: payload.token }), 409, "tree_dirty");
  refused(await call(env.port, "start-check", { ...payload, token: "w".repeat(43) }), 409, "not_startable");
});

test("an autonomous durable claim survives monitor reopen and expiry, blocks every start, and can bind late", async (context) => {
  const env = await setup(context);
  create(env, {});
  const answer = await plan(env, pilot(env));
  const payload = { id: "T-1", token: answer.json.plan.token };
  env.clock.now += TASK_DISPATCH_UNBOUND_TTL_MS * 3;
  const reopened = openTaskStore({ directory: env.directory, now: () => env.clock.now });
  try {
    assert.deepEqual(reopened.planStart(REPOSITORY_ID, { id: "T-1" }, () => ({ root: ROOT, pluginReady: true }), () => GATE_FACTS), { ok: false, error: "not_startable" });
    assert.deepEqual(reopened.checkStart(REPOSITORY_ID, payload, () => GATE_FACTS), { ok: true });
    assert.deepEqual(reopened.bindSession({ token: payload.token, sessionId: "codex:late-session" }), { ok: true });
    assert.equal(reopened.readBoard(REPOSITORY_ID).tasks[0].session.id, "codex:late-session");
  } finally { reopened.close(); }
});

test("an aborted autonomous attempt cannot be replayed, and a new grant is independent", async (context) => {
  const env = await setup(context);
  create(env, {});
  const request = pilot(env);
  const answer = await plan(env, request);
  assert.equal((await call(env.port, "start-abort", { id: "T-1", token: answer.json.plan.token })).status, 200);
  refused(await plan(env, request), 409, "already_attempted");
  assert.equal((await plan(env, pilot(env, "T-1", { attemptId: `pilot-${"b".repeat(24)}_T-1` }))).status, 200);
});

test("only an explicit owner resolution frees a durable uncertain launch and refuses its late binding", async (context) => {
  const env = await setup(context);
  create(env, {}); create(env, {});
  const first = await plan(env, pilot(env));
  // Ordinary edits cannot turn an uncertain launch back into startable work.
  assert.equal(env.store.apply(REPOSITORY_ID, "update", { id: "T-1", text: "new" }).error, "conflict");
  assert.equal(env.store.apply(REPOSITORY_ID, "resolve_requeue", { id: "T-1" }).ok, true);
  assert.equal(dispatchOf(env.directory, 1), null);
  assert.equal(env.store.bindSession({ token: first.json.plan.token, sessionId: "codex:requeued-late" }).error, "not_found");
  const second = await plan(env, pilot(env, "T-1", { attemptId: `pilot-${"b".repeat(24)}_T-1` }));
  assert.equal(second.status, 200);
  assert.equal(env.store.apply(REPOSITORY_ID, "resolve_done", { id: "T-1" }).ok, true);
  assert.equal(dispatchOf(env.directory, 1), null);
  assert.equal(env.store.bindSession({ token: second.json.plan.token, sessionId: "codex:done-late" }).error, "not_found");
  assert.equal(env.store.readBoard(REPOSITORY_ID).tasks[1].run.provider, null);
});
const worktree = async (env, id) => {
  const { json } = await plan(env, { id });
  assert.equal(json.plan.repositoryRoot, ROOT, "the plan names the root, never a worktree path");
  return json.plan.worktree;
};

test("the plan asks for a worktree for each member of a group, also across features, and for no other card", async (context) => {
  const env = await setup(context);
  const first = env.store.apply(REPOSITORY_ID, "feature_create", { name: "Search" }).board.features[0].id;
  const second = env.store.apply(REPOSITORY_ID, "feature_create", { name: "Billing" }).board.features[0].id;
  create(env, { featureId: first });
  create(env, { featureId: first });
  create(env, { featureId: second });
  create(env, { featureId: second });
  create(env, {});
  create(env, {});
  queue(env, "T-1", "T-2", "T-3", "T-4", "T-5", "T-6");
  // T-2 (Search), T-3 (Billing) and T-6 (no feature) run together; T-1, T-4 and T-5 stand alone.
  group(env, "T-2", "T-3", "T-6");
  const plans = {};
  for (const id of ["T-1", "T-2", "T-3", "T-4", "T-5", "T-6"]) plans[id] = await worktree(env, id);
  assert.deepEqual(plans, { "T-1": false, "T-2": true, "T-3": true, "T-4": false, "T-5": false, "T-6": true });
});

test("an ungrouped card of a feature runs in the root, whatever its siblings, and a member left alone does too", async (context) => {
  const env = await setup(context);
  const feature = env.store.apply(REPOSITORY_ID, "feature_create", { name: "Search" }).board.features[0].id;
  for (let count = 0; count < 4; count += 1) create(env, { featureId: feature });
  queue(env, "T-1", "T-2", "T-3", "T-4");
  assert.equal(await worktree(env, "T-1"), false);
  group(env, "T-3", "T-4");
  assert.equal(await worktree(env, "T-2"), false, "its neighbors are a group, it is not");
  // T-4 leaves the queue: T-3 is the only member in the queue and is no group.
  assert.equal(env.store.apply(REPOSITORY_ID, "queue_remove", { id: "T-4" }).ok, true);
  assert.equal(await worktree(env, "T-3"), false);
});
