import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_DISPATCH_UNBOUND_TTL_MS } from "../../../server/tasks/task-dispatch.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { passingGates } from "./queue-test-support.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const OTHER_REPOSITORY_ID = "repo-fedcba987654321001234567";
const DESKTOP = "d".repeat(40);
const AGENT = "a".repeat(40);
const TEXT = "Fix the SECRET-TASK-TEXT flaky test";
const SESSION = "claude:0b8f2c1e-1111-4222-8333-444455556666";
const BIND = "/api/agent/v1/tasks/bind";
const desktopHeaders = { "x-pomegr-desktop-authorization": DESKTOP, "content-type": "application/json" };
const agentHeaders = { "x-pomegr-agent-authorization": AGENT, "content-type": "application/json" };
const FACTS = { root: "C:/Work/SECRET-ROOT/repo", pluginReady: true };

async function setup(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-bind-"));
  const clock = { now: 1_000_000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  const server = http.createServer(createRequestHandler({
    runtime: { resolveTaskStart: () => FACTS }, taskStore: store, authorizationToken: DESKTOP, agentAuthorizationToken: AGENT,
  }));
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
  return { store, clock, port: server.address().port, directory };
}

function send(port, { method = "POST", path: requestPath = BIND, headers = agentHeaders, body } = {}) {
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

const bind = (env, payload) => send(env.port, { body: typeof payload === "string" ? payload : JSON.stringify(payload) });
const create = (env, repositoryId = REPOSITORY_ID) => assert.equal(env.store.apply(repositoryId, "create", { text: TEXT }).ok, true);
// A start plan mints the dispatch token exactly as the desktop does.
const mint = (env, id = "T-1", repositoryId = REPOSITORY_ID) => {
  const planned = env.store.planStart(repositoryId, { id }, () => FACTS, passingGates);
  assert.equal(planned.ok, true);
  return planned.plan.token;
};
const plan = (env, id = "T-1") => send(env.port, {
  path: "/internal/tasks/start-plan", headers: desktopHeaders, body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { id } }),
});
const REFUSED = (reason) => ({ schemaVersion: 1, ok: false, reason });
const refused = (response, status, reason) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, REFUSED(reason));
};
function withDatabase(directory, work) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try { return work(database); } finally { database.close(); }
}
const rowOf = (directory, number, repositoryId = REPOSITORY_ID) => withDatabase(directory, (database) =>
  database.prepare("SELECT session_id, dispatch_token, state, column_id, position, queue_position FROM tasks WHERE repository_id = ? AND number = ?")
    .get(repositoryId, number));

test("the planned token links the session, clears the digest, and moves the card to In progress", async (context) => {
  const env = await setup(context);
  create(env);
  const before = env.store.readBoard(REPOSITORY_ID).tasks[0];
  const token = mint(env);
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  assert.equal(rowOf(env.directory, 1).dispatch_token, `${digest}:${env.clock.now}`);
  const response = await bind(env, { token, sessionRef: SESSION });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: true });
  const row = rowOf(env.directory, 1);
  assert.equal(row.session_id, SESSION);
  assert.equal(row.dispatch_token, null);
  const after = env.store.readBoard(REPOSITORY_ID).tasks[0];
  assert.deepEqual(after.session, { id: SESSION, title: null, state: "unknown", observedModel: null });
  const columns = env.store.readBoard(REPOSITORY_ID).columns;
  assert.equal(columns.find((column) => column.id === before.columnId).role, null);
  assert.equal(columns.find((column) => column.id === after.columnId).role, "in_progress");
  for (const key of ["id", "text", "featureId", "step", "run", "doneWhen", "state", "scheduledAt", "report", "createdAt"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.ok(Date.parse(after.updatedAt) >= Date.parse(before.updatedAt));
  assert.equal(row.state, "not_queued");
  // Nothing of the token, its digest, or the link reaches the other surfaces.
  const texts = [JSON.stringify(env.store.readBoard(REPOSITORY_ID)), response.text];
  for (const text of texts) for (const secret of [token, digest]) assert.ok(!text.includes(secret), secret);
  assert.ok(!response.text.includes(SESSION));
});

test("a queued task keeps its state and queue position when bound", async (context) => {
  const env = await setup(context);
  create(env);
  assert.equal(env.store.apply(REPOSITORY_ID, "queue_add", { id: "T-1" }).ok, true);
  const before = rowOf(env.directory, 1);
  assert.equal((await bind(env, { token: mint(env), sessionRef: SESSION })).status, 200);
  const after = rowOf(env.directory, 1);
  assert.equal(after.state, "queued");
  assert.equal(after.queue_position, before.queue_position);
});

test("a wrong token is not_found and leaves the dispatch alone", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  const stored = rowOf(env.directory, 1).dispatch_token;
  refused(await bind(env, { token: "w".repeat(43), sessionRef: SESSION }), 404, "not_found");
  assert.equal(rowOf(env.directory, 1).session_id, null);
  assert.equal(rowOf(env.directory, 1).dispatch_token, stored);
  assert.equal((await bind(env, { token, sessionRef: SESSION })).status, 200);
});

test("a token that was never minted, and a task with no dispatch, are not_found", async (context) => {
  const env = await setup(context);
  create(env);
  refused(await bind(env, { token: "n".repeat(43), sessionRef: SESSION }), 404, "not_found");
  assert.equal(rowOf(env.directory, 1).session_id, null);
});

test("a reused token is not_found and the first link stands", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  assert.equal((await bind(env, { token, sessionRef: SESSION })).status, 200);
  refused(await bind(env, { token, sessionRef: SESSION }), 404, "not_found");
  refused(await bind(env, { token, sessionRef: "claude:another-session" }), 404, "not_found");
  assert.equal(rowOf(env.directory, 1).session_id, SESSION);
});

test("a task that already has a session cannot be bound again", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  // A link written while the digest was still stored: the digest alone must not rebind the task.
  withDatabase(env.directory, (database) => database.exec("UPDATE tasks SET session_id = 'claude:first' WHERE number = 1"));
  refused(await bind(env, { token, sessionRef: "claude:second" }), 404, "not_found");
  assert.equal(rowOf(env.directory, 1).session_id, "claude:first");
});

test("a session already linked to another task is not_found and the first link stands", async (context) => {
  const env = await setup(context);
  create(env);
  create(env);
  const first = mint(env, "T-1");
  const second = mint(env, "T-2");
  assert.equal((await bind(env, { token: first, sessionRef: SESSION })).status, 200);
  refused(await bind(env, { token: second, sessionRef: SESSION }), 404, "not_found");
  assert.equal(rowOf(env.directory, 1).session_id, SESSION);
  assert.equal(rowOf(env.directory, 2).session_id, null);
  // The refusal consumed nothing: the second task's own session can still bind.
  assert.equal((await bind(env, { token: second, sessionRef: "claude:the-second-session" })).status, 200);
  assert.equal(rowOf(env.directory, 2).session_id, "claude:the-second-session");
});

test("the lookup is monitor-wide and each token finds only its own task", async (context) => {
  const env = await setup(context);
  create(env, REPOSITORY_ID);
  create(env, REPOSITORY_ID);
  create(env, OTHER_REPOSITORY_ID);
  const first = mint(env, "T-1", REPOSITORY_ID);
  const second = mint(env, "T-1", OTHER_REPOSITORY_ID);
  // A stored value that is not a digest is skipped, never matched and never a failure.
  withDatabase(env.directory, (database) => database.exec("UPDATE tasks SET dispatch_token = 'not-a-digest' WHERE number = 2"));
  assert.equal((await bind(env, { token: second, sessionRef: "claude:in-other-repository" })).status, 200);
  assert.equal(rowOf(env.directory, 1, OTHER_REPOSITORY_ID).session_id, "claude:in-other-repository");
  assert.equal(rowOf(env.directory, 1, REPOSITORY_ID).session_id, null);
  assert.equal((await bind(env, { token: first, sessionRef: "claude:in-first-repository" })).status, 200);
  assert.equal(rowOf(env.directory, 1, REPOSITORY_ID).session_id, "claude:in-first-repository");
});

test("an expired unbound dispatch is not_found, and one TTL short of expiry still binds", async (context) => {
  const env = await setup(context);
  create(env);
  create(env);
  const live = mint(env, "T-1");
  const expired = mint(env, "T-2");
  env.clock.now += TASK_DISPATCH_UNBOUND_TTL_MS - 1;
  assert.equal((await bind(env, { token: live, sessionRef: SESSION })).status, 200);
  env.clock.now += 1;
  refused(await bind(env, { token: expired, sessionRef: "claude:late-session" }), 404, "not_found");
  assert.equal(rowOf(env.directory, 2).session_id, null);
});

test("a bound task is never startable again and its link never expires", async (context) => {
  const env = await setup(context);
  create(env);
  assert.equal((await bind(env, { token: mint(env), sessionRef: SESSION })).status, 200);
  const notStartable = { ok: false, error: "not_startable" };
  const attempt = await plan(env);
  assert.equal(attempt.status, 409);
  assert.deepEqual(attempt.json, notStartable);
  env.clock.now += TASK_DISPATCH_UNBOUND_TTL_MS * 100;
  assert.deepEqual((await plan(env)).json, notStartable);
  assert.equal(rowOf(env.directory, 1).session_id, SESSION);
  assert.equal(env.store.readBoard(REPOSITORY_ID).tasks[0].session.id, SESSION);
});

test("a malformed request is invalid and consumes nothing", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  const valid = { token, sessionRef: SESSION };
  const bodies = [
    "{", "[]", "null", "\"token\"", "{}",
    { sessionRef: SESSION }, { token },
    { ...valid, taskId: "T-1" }, { ...valid, repositoryId: REPOSITORY_ID }, { ...valid, extra: 1 },
    { token: "short", sessionRef: SESSION }, { token: "t".repeat(15), sessionRef: SESSION }, { token: "t".repeat(129), sessionRef: SESSION },
    { token: `${"t".repeat(20)} ${"t".repeat(20)}`, sessionRef: SESSION }, { token: "t".repeat(20) + "/", sessionRef: SESSION },
    { token: 12345, sessionRef: SESSION }, { token: null, sessionRef: SESSION }, { token: [token], sessionRef: SESSION },
    { token, sessionRef: 7 }, { token, sessionRef: "" }, { token, sessionRef: "claude:" }, { token, sessionRef: "../etc" },
    { token, sessionRef: "gemini:abc" }, { token, sessionRef: "claude:a:b" }, { token, sessionRef: "claude:" + "x".repeat(129) },
    { token, sessionRef: "claude:abc def" },
  ];
  for (const body of bodies) refused(await bind(env, body), 400, "invalid");
  assert.equal(rowOf(env.directory, 1).session_id, null);
  assert.equal((await bind(env, valid)).status, 200);
});

test("the content type, query, and body size are checked before the store", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  const body = JSON.stringify({ token, sessionRef: SESSION });
  refused(await send(env.port, { headers: { ...agentHeaders, "content-type": "text/plain" }, body }), 400, "invalid");
  refused(await send(env.port, { headers: { "x-pomegr-agent-authorization": AGENT }, body }), 400, "invalid");
  refused(await send(env.port, { path: `${BIND}?repositoryId=${REPOSITORY_ID}`, body }), 400, "invalid");
  refused(await bind(env, { token, sessionRef: SESSION, padding: "p".repeat(2048) }), 400, "invalid");
  assert.equal(rowOf(env.directory, 1).session_id, null);
  assert.equal((await send(env.port, { headers: { ...agentHeaders, "content-type": "application/json; charset=utf-8" }, body })).status, 200);
});

test("every answer is a fixed object with no task, repository, session, or token", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  const responses = [
    await bind(env, { token: "x".repeat(43), sessionRef: SESSION }),
    await bind(env, "{"),
    await bind(env, { token, sessionRef: SESSION }),
    await bind(env, { token, sessionRef: SESSION }),
  ];
  assert.deepEqual(responses.map((response) => response.text), [
    JSON.stringify(REFUSED("not_found")), JSON.stringify(REFUSED("invalid")),
    JSON.stringify({ schemaVersion: 1, ok: true }), JSON.stringify(REFUSED("not_found")),
  ]);
  for (const response of responses) {
    for (const secret of ["T-1", REPOSITORY_ID, "SECRET", token, SESSION]) assert.ok(!response.text.includes(secret), secret);
  }
});

test("only POST is served, and the agent gate applies", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  const body = JSON.stringify({ token, sessionRef: SESSION });
  for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD"]) {
    const response = await send(env.port, { method, body: method === "GET" || method === "HEAD" ? undefined : body });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, "POST", method);
  }
  assert.equal((await send(env.port, { headers: { "content-type": "application/json" }, body })).status, 401);
  assert.equal((await send(env.port, { headers: { ...agentHeaders, "x-pomegr-agent-authorization": "b".repeat(40) }, body })).status, 401);
  assert.equal((await send(env.port, { headers: { ...agentHeaders, origin: "http://evil.example" }, body })).status, 401);
  // The desktop token is not the agent token.
  assert.equal((await send(env.port, { headers: desktopHeaders, body })).status, 401);
  assert.equal(rowOf(env.directory, 1).session_id, null);
  assert.equal((await send(env.port, { path: `${BIND}/`, body })).status, 405);
});

test("the bind path is not a renderer task action or a desktop route", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  const response = await send(env.port, {
    path: "/internal/tasks/bind", headers: desktopHeaders, body: JSON.stringify({ repositoryId: REPOSITORY_ID, payload: { token, sessionId: SESSION } }),
  });
  assert.equal(response.status, 404);
  assert.equal(rowOf(env.directory, 1).session_id, null);
});

test("a missing, closed, or throwing store answers unavailable", async (context) => {
  const body = JSON.stringify({ token: "t".repeat(43), sessionRef: SESSION });
  for (const taskStore of [null, {}, { bindSession() { throw new Error("SECRET-STORE-FAILURE"); } }, { bindSession: () => ({ ok: false, error: "other" }) }]) {
    const server = http.createServer(createRequestHandler({ runtime: {}, taskStore, agentAuthorizationToken: AGENT }));
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    try {
      const response = await send(server.address().port, { body });
      refused(response, 503, "unavailable");
      assert.ok(!response.text.includes("SECRET"));
    } finally {
      await new Promise((done) => server.close(done));
    }
  }
  const env = await setup(context);
  create(env);
  const token = mint(env);
  env.store.close();
  refused(await bind(env, { token, sessionRef: SESSION }), 503, "unavailable");
});

test("the store binds with a fixed result and validates its own payload", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  assert.deepEqual(env.store.bindSession({ token, sessionId: "bad session" }), { ok: false, error: "invalid" });
  assert.deepEqual(env.store.bindSession({ token, sessionId: SESSION, extra: true }), { ok: false, error: "invalid" });
  assert.deepEqual(env.store.bindSession({ token: "short", sessionId: SESSION }), { ok: false, error: "invalid" });
  assert.deepEqual(env.store.bindSession(null), { ok: false, error: "invalid" });
  assert.deepEqual(env.store.bindSession({ token: "z".repeat(43), sessionId: SESSION }), { ok: false, error: "not_found" });
  assert.deepEqual(env.store.bindSession({ token, sessionId: SESSION }), { ok: true });
  assert.deepEqual(env.store.bindSession({ token, sessionId: SESSION }), { ok: false, error: "not_found" });
});

test("a constraint failure while linking is not_found, and any other write failure is unavailable", async (context) => {
  const env = await setup(context);
  create(env);
  const token = mint(env);
  const guard = (message) => withDatabase(env.directory, (database) => database.exec(`
    DROP TRIGGER IF EXISTS refuse_link;
    CREATE TRIGGER refuse_link BEFORE UPDATE OF session_id ON tasks BEGIN SELECT RAISE(ABORT, '${message}'); END;`));
  guard("UNIQUE constraint failed: tasks.session_id");
  refused(await bind(env, { token, sessionRef: SESSION }), 404, "not_found");
  guard("disk is on fire");
  refused(await bind(env, { token, sessionRef: SESSION }), 503, "unavailable");
  assert.equal(rowOf(env.directory, 1).session_id, null);
  withDatabase(env.directory, (database) => database.exec("DROP TRIGGER refuse_link"));
  assert.equal((await bind(env, { token, sessionRef: SESSION })).status, 200);
});
