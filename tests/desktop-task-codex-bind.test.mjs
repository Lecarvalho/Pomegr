import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskStart } from "../desktop/runtime/task-dispatch.mjs";
import { createTerminalController } from "../desktop/runtime/terminal.mjs";
import { createRequestHandler } from "../server/serving/request-handler.mjs";
import { serveSessionDirectoryWithTasks } from "../server/serving/session-directory-tasks.mjs";
import { TASK_DISPATCH_UNBOUND_TTL_MS } from "../server/tasks/task-dispatch.mjs";
import { openTaskStore } from "../server/tasks/task-store.mjs";
import { passingGates } from "./server/tasks/queue-test-support.mjs";

// T-181: Codex skipped the Pomegr plugin's untrusted SessionStart hooks after a plugin update, so a
// task-started Codex session never reported its token and its Sessions row showed no task.
const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const DESKTOP = "d".repeat(40);
const AGENT = "a".repeat(40);
const ROOT = "C:\\Work\\repo";
const CODEX = "C:\\Users\\tester\\.local\\bin\\codex.exe";
const ROOT_SESSION = "codex:01a178f3-6bfa-7b61-9f4a-62b7cab4c626";
const PID = 4242;
const FACTS = { root: ROOT, pluginReady: true };
const trusted = { trusted: true };
const desktopHeaders = { "x-pomegr-desktop-authorization": DESKTOP, "content-type": "application/json" };

async function monitor(context, { provider = "codex" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-bind-"));
  const clock = { now: 1_000_000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  const server = http.createServer(createRequestHandler({
    runtime: { resolveTaskStart: () => FACTS }, taskStore: store, authorizationToken: DESKTOP, agentAuthorizationToken: AGENT,
  }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise((done) => server.close(done));
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  assert.equal(store.apply(REPOSITORY_ID, "create", { text: "Implement the renderer core", run: { provider } }).ok, true);
  return { store, clock, origin: `http://127.0.0.1:${server.address().port}` };
}

async function until(check, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

// Desktop main against the real monitor routes. The plan is minted by the store as the route does.
function desktop(env, { lookup = async () => ROOT_SESSION, processOf } = {}) {
  const posts = [];
  const lookups = [];
  let key = null;
  let token = null;
  const terminal = {
    ensureHost: async () => {},
    create: async (plan) => { key = plan.key; return { key: plan.key, pid: PID }; },
    processOf: processOf || (async (asked) => (asked === key ? PID : null)),
  };
  const starter = createTaskStart({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin: env.origin, authorizationToken: DESKTOP, platform: "win32",
    environment: { USERPROFILE: "C:\\Users\\tester" },
    fileExists: (file) => file === CODEX, directoryExists: (directory) => directory === ROOT,
    confirm: async () => true, terminal, bindIntervalMs: 5,
    sessionForProcess: async (pid) => { lookups.push(pid); return lookup(lookups.length); },
    fetch: async (url, options) => {
      const route = url.split("/").pop();
      const body = JSON.parse(options.body);
      posts.push({ route, body });
      if (route === "start-plan") {
        const planned = env.store.planStart(body.repositoryId, body.payload, () => FACTS, passingGates);
        token = planned.plan?.token ?? null;
        return new Response(JSON.stringify(planned.ok ? { ok: true, plan: planned.plan } : planned), { headers: { "content-type": "application/json" } });
      }
      return fetch(url, options);
    },
  });
  return { starter, posts, lookups, token: () => token, binds: () => posts.filter((post) => post.route === "start-bind") };
}

const linkedTask = (env, sessionId = ROOT_SESSION) => env.store.sessionTasks([sessionId])?.get(sessionId)?.id ?? null;

// The Sessions list's Task cell: the directory row joined with the store's session link.
function directoryTask(env, sessionId = ROOT_SESSION) {
  const runtime = { serveSessionDirectory: () => ({ revision: 1, sessions: [{ id: sessionId }], matchedCount: 1, counts: { all: 1, live: 1, needs: 0 }, pageSize: 25, nextCursor: null }) };
  return serveSessionDirectoryWithTasks({ runtime, taskStore: env.store, allowed: true, query: {} }).sessions[0].task?.id ?? null;
}

test("a Codex task start whose session-start hook never reports links its observed root session", async (context) => {
  const env = await monitor(context);
  // The session is not observed on the first lookups, as right after the launch.
  const d = desktop(env, { lookup: async (count) => (count < 3 ? null : ROOT_SESSION) });
  context.after(() => d.starter.dispose());
  assert.deepEqual(await d.starter.start(trusted, REPOSITORY_ID, "T-1"), { status: "started" });
  // The failing step: without a hook report nothing links the task, so the Task cell shows the dash.
  assert.equal(linkedTask(env), null);
  assert.equal(directoryTask(env), null);

  await until(() => linkedTask(env) === "T-1", "the desktop link");
  assert.equal(directoryTask(env), "T-1");
  assert.deepEqual(d.binds().map((post) => post.body), [{ repositoryId: REPOSITORY_ID, payload: { id: "T-1", token: d.token(), sessionId: ROOT_SESSION } }]);
  assert.ok(d.lookups.length >= 3 && d.lookups.every((pid) => pid === PID));

  // The token stays single use: the hook's late report is refused.
  const hook = await fetch(`${env.origin}/api/agent/v1/tasks/bind`, {
    method: "POST", headers: { "x-pomegr-agent-authorization": AGENT, "content-type": "application/json" },
    body: JSON.stringify({ token: d.token(), sessionRef: ROOT_SESSION }),
  });
  assert.equal(hook.status, 404);
  const lookupsAfterLink = d.lookups.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(d.lookups.length, lookupsAfterLink, "the watch ends once the task is linked");
});

test("a hook that links first ends the desktop watch with the same refusal", async (context) => {
  const env = await monitor(context);
  let hooked = false;
  // The plugin hook reports first, as it does when Codex trusts it; the session is observed later.
  const d = desktop(env, { lookup: async (count) => {
    if (count === 1) { assert.equal(env.store.bindSession({ token: d.token(), sessionId: ROOT_SESSION }).ok, true); hooked = true; }
    return count < 3 ? null : ROOT_SESSION;
  } });
  context.after(() => d.starter.dispose());
  assert.deepEqual(await d.starter.start(trusted, REPOSITORY_ID, "T-1"), { status: "started" });
  await until(() => d.binds().length === 1, "the desktop bind attempt");
  assert.equal(hooked, true);
  assert.equal(linkedTask(env), "T-1");
  const lookups = d.lookups.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(d.binds().length, 1, "a refused link ends the watch");
  assert.equal(d.lookups.length, lookups);
});

test("start-bind keeps the token the only authority", async (context) => {
  const env = await monitor(context);
  const planned = env.store.planStart(REPOSITORY_ID, { id: "T-1" }, () => FACTS, passingGates);
  const token = planned.plan.token;
  const bind = (payload, headers = desktopHeaders) => fetch(`${env.origin}/internal/tasks/start-bind`, {
    method: "POST", headers, body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload }),
  }).then(async (response) => ({ status: response.status, json: await response.json() }));
  const refused = (answer, status, error) => assert.deepEqual(answer, { status, json: { ok: false, error } });

  refused(await bind({ id: "T-1", token, sessionId: "claude:0b8f2c1e-1111-4222-8333-444455556666" }), 400, "invalid");
  refused(await bind({ id: "T-1", token, sessionId: ROOT_SESSION, extra: true }), 400, "invalid");
  refused(await bind({ id: "T-1", token: "B".repeat(43), sessionId: ROOT_SESSION }), 404, "not_found");
  refused(await bind({ id: "T-2", token, sessionId: ROOT_SESSION }), 404, "not_found");
  const agent = await fetch(`${env.origin}/internal/tasks/start-bind`, {
    method: "POST", headers: { "x-pomegr-agent-authorization": AGENT, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { id: "T-1", token, sessionId: ROOT_SESSION } }),
  });
  assert.notEqual(agent.status, 200, "only desktop main may call the internal route");
  assert.equal(linkedTask(env), null);

  env.clock.now += TASK_DISPATCH_UNBOUND_TTL_MS;
  refused(await bind({ id: "T-1", token, sessionId: ROOT_SESSION }), 404, "not_found");
  env.clock.now -= 1;
  assert.deepEqual(await bind({ id: "T-1", token, sessionId: ROOT_SESSION }), { status: 200, json: { ok: true } });
  assert.equal(linkedTask(env), "T-1");
  assert.equal(env.store.readBoard(REPOSITORY_ID).tasks[0].state, "not_queued", "linking changes no state");
  refused(await bind({ id: "T-1", token, sessionId: ROOT_SESSION }), 404, "not_found");
});

test("a Claude task start is never watched, and the watch stops for an exited process or a foreign session", async (context) => {
  const claude = await monitor(context, { provider: "claude" });
  const c = desktop(claude, {});
  context.after(() => c.starter.dispose());
  await c.starter.start(trusted, REPOSITORY_ID, "T-1");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(c.lookups, []);
  assert.deepEqual(c.binds(), []);

  const exited = await monitor(context);
  const e = desktop(exited, { processOf: async () => null });
  context.after(() => e.starter.dispose());
  await e.starter.start(trusted, REPOSITORY_ID, "T-1");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(e.lookups, [], "an exited or replaced process is never looked up");
  assert.equal(linkedTask(exited), null);

  const foreign = await monitor(context);
  const f = desktop(foreign, { lookup: async () => "claude:0b8f2c1e-1111-4222-8333-444455556666" });
  await f.starter.start(trusted, REPOSITORY_ID, "T-1");
  await until(() => f.lookups.length >= 3, "repeated lookups");
  assert.deepEqual(f.binds(), [], "only a Codex session is reported");
  f.starter.dispose();
  const stopped = f.lookups.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(f.lookups.length, stopped, "dispose ends the watch");
});

test("the terminal controller reports a running terminal's process and nothing once it exited", async () => {
  let rows = [{ key: "repo-0123456789abcdef01234567/T-1/" + "a".repeat(32), pid: PID, exited: false }];
  const controller = createTerminalController({ client: { list: async () => rows, close() {} } });
  assert.equal(await controller.processOf(rows[0].key), PID);
  assert.equal(await controller.processOf("other"), null);
  rows = [{ ...rows[0], exited: true, exitCode: 0 }];
  assert.equal(await controller.processOf(rows[0].key), null);
  const broken = createTerminalController({ client: { list: async () => { throw new Error("TERMINAL_UNAVAILABLE"); }, close() {} } });
  assert.equal(await broken.processOf(rows[0].key), null);
});
