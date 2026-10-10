import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeIssue } from "../../../server/repository/issues.mjs";
import { createTaskIssues } from "../../../server/runtime/task-issues.mjs";
import { createTaskLookups } from "../../../server/runtime/task-start-lookup.mjs";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_ISSUE_ACTIONS } from "../../../server/serving/task-issue-routes.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { removeDirectory } from "./queue-test-support.mjs";

const REPOSITORY = "repo-0123456789abcdef01234567";
const OTHER_REPOSITORY = "repo-fedcba987654321001234567";
const ROOT = "C:/Work/SECRET-ROOT/repo";
const TOKEN = "i".repeat(40);
const withToken = { "x-pomegr-desktop-authorization": TOKEN };
const JSON_BODY = { "content-type": "application/json" };
const BODY_SECRET = "BODY-NOT-PROMOTED-do-not-serve";

const raw = (number, overrides = {}) => ({
  number, title: `Issue ${number}`, body: `Body of ${number}`, state: "open", author_association: "MEMBER", updated_at: "2026-10-01T10:00:00Z", ...overrides,
});

/** A fake reader over a mutable GitHub: every call is logged, nothing runs `gh`. */
function fakeReader(initial = {}) {
  const github = {
    connection: "connected", visibility: "public", capabilities: ["read_issues", "create_issues"], listStatus: "ok", truncated: false,
    issues: [raw(1), raw(2, { body: `${BODY_SECRET} <!-- hidden note -->visible` })],
    ...initial,
  };
  const calls = [];
  const reader = {
    async connection() { calls.push(["connection"]); return github.connection; },
    async repositoryAccess(root) { calls.push(["repositoryAccess", root]); return { visibility: github.visibility, capabilities: github.capabilities }; },
    async listOpenIssues(root) {
      calls.push(["listOpenIssues", root]);
      return { status: github.listStatus, issues: github.issues.map(normalizeIssue).filter(Boolean), truncated: github.truncated };
    },
    async readIssue(root, number) {
      calls.push(["readIssue", root, number]);
      if (github.readStatus) return { status: github.readStatus, issue: null };
      const found = github.issues.find((item) => item.number === number && item.state === "open" && !item.pull_request);
      return found ? { status: "ok", issue: normalizeIssue(found) } : { status: "not_found", issue: null };
    },
  };
  return { reader, github, calls };
}

async function setup(context, { reader, roots = { [REPOSITORY]: ROOT }, storeOverride = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-issues-"));
  const store = openTaskStore({ directory, now: () => 1_000_000 });
  context.after(async () => { store.close(); await removeDirectory(directory); });
  const taskIssues = createTaskIssues({ repositoryRoot: (id) => roots[id] ?? null, reader, now: () => Date.parse("2026-10-09T12:00:00.000Z") });
  const readerCalls = [];
  const runtime = new Proxy({
    taskIssues,
    serveSessionDirectory: () => ({ revision: 1, sessions: [] }),
    observationActive: () => false,
    analyze: async () => ({ sessions: [] }),
    analyzeEmpty: () => ({ sessions: [] }),
  }, { get(target, property) { readerCalls.push(String(property)); return target[property]; } });
  const server = http.createServer(createRequestHandler({ runtime, taskStore: storeOverride ?? store, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { store, taskIssues, port: server.address().port, runtimeReads: readerCalls };
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

const call = (port, name, repositoryId, payload, { headers = {}, query = "" } = {}) => send(port, {
  path: `/internal/tasks/${name}${query}`, headers: { ...withToken, ...JSON_BODY, ...headers }, body: JSON.stringify({ repositoryId, payload }),
});
const getBoard = (port, id = REPOSITORY) => send(port, { method: "GET", path: `/api/tasks?repositoryId=${id}`, headers: withToken });

function assertRefusal(response, status, error) {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"] || "", /^application\/json/u);
  assert.deepEqual(response.json, { ok: false, error });
}

test("the three action names are the fixed list", () => {
  assert.deepEqual([...TASK_ISSUE_ACTIONS], ["github-status", "issues-list", "issue-promote"]);
});

test("github-status answers the connection and the repository access, never the root", async (context) => {
  const { reader, calls } = fakeReader();
  const { port } = await setup(context, { reader });
  const response = await call(port, "github-status", REPOSITORY, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { ok: true, connection: "connected", repository: { visibility: "public", capabilities: ["read_issues", "create_issues"] } });
  assert.ok(!response.text.includes("SECRET-ROOT"));
  assert.deepEqual(calls, [["connection"], ["repositoryAccess", ROOT]]);
});

test("github-status has no repository unless connected and the root is recognized", async (context) => {
  const signedOut = fakeReader({ connection: "not_signed_in" });
  const first = await setup(context, { reader: signedOut.reader });
  assert.deepEqual((await call(first.port, "github-status", REPOSITORY, {})).json, { ok: true, connection: "not_signed_in", repository: null });
  assert.deepEqual(signedOut.calls, [["connection"]]);

  const missing = fakeReader({ connection: "cli_missing" });
  const second = await setup(context, { reader: missing.reader });
  assert.deepEqual((await call(second.port, "github-status", REPOSITORY, {})).json, { ok: true, connection: "cli_missing", repository: null });

  const unknown = fakeReader();
  const third = await setup(context, { reader: unknown.reader });
  assert.deepEqual((await call(third.port, "github-status", OTHER_REPOSITORY, {})).json, { ok: true, connection: "connected", repository: null });
  assert.deepEqual(unknown.calls, [["connection"]]);
});

test("issues-list serves the allowlisted projection with the promoted task joined, and never taskText", async (context) => {
  const { reader } = fakeReader({ truncated: true });
  const { port, store } = await setup(context, { reader });
  const listed = await call(port, "issues-list", REPOSITORY, {});
  assert.equal(listed.status, 200);
  assert.equal(listed.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(listed.json).sort(), ["issues", "ok", "readAt", "status", "truncated"]);
  assert.equal(listed.json.status, "ok");
  assert.equal(listed.json.readAt, "2026-10-09T12:00:00.000Z");
  assert.equal(listed.json.truncated, true);
  assert.equal(listed.json.issues.length, 2);
  for (const item of listed.json.issues) {
    assert.deepEqual(Object.keys(item).sort(), [
      "authorAssociation", "body", "bodyTruncated", "characters", "digest", "hiddenComments", "number", "taskId", "title", "tooLong", "updatedAt",
    ]);
    assert.equal(item.taskId, null);
    assert.match(item.digest, /^[a-f0-9]{64}$/u);
  }
  const second = listed.json.issues[1];
  assert.equal(second.body, `${BODY_SECRET} <!-- hidden note -->visible`);
  assert.deepEqual(second.hiddenComments, { count: 1, ranges: [{ start: BODY_SECRET.length + 1, end: BODY_SECRET.length + 1 + "<!-- hidden note -->".length }] });
  assert.equal(second.authorAssociation, "member");
  assert.ok(!listed.text.includes("taskText"));
  assert.ok(!listed.text.includes("SECRET-ROOT"));

  const promoted = await call(port, "issue-promote", REPOSITORY, { number: 1, digest: listed.json.issues[0].digest });
  assert.deepEqual(promoted.json, { ok: true, taskId: "T-1" });
  const again = await call(port, "issues-list", REPOSITORY, {});
  assert.deepEqual(again.json.issues.map((item) => item.taskId), ["T-1", null]);
  assert.equal(store.promotedIssues(REPOSITORY).get(1), "T-1");
});

test("issues-list answers only a status when the read failed or the root is unknown", async (context) => {
  for (const status of ["cli_missing", "not_signed_in", "no_access", "issues_disabled", "unavailable"]) {
    const { reader } = fakeReader({ listStatus: status });
    const { port } = await setup(context, { reader });
    const response = await call(port, "issues-list", REPOSITORY, {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, status, readAt: "2026-10-09T12:00:00.000Z", truncated: false, issues: [] });
  }
  const unknown = fakeReader();
  const { port } = await setup(context, { reader: unknown.reader });
  const response = await call(port, "issues-list", OTHER_REPOSITORY, {});
  assert.deepEqual(response.json, { ok: true, status: "unavailable", readAt: "2026-10-09T12:00:00.000Z", truncated: false, issues: [] });
  assert.deepEqual(unknown.calls, []);
});

test("promote reads the issue again and stores the stripped text, never text from the request", async (context) => {
  const fake = fakeReader();
  const { port, store } = await setup(context, { reader: fake.reader });
  const listed = await call(port, "issues-list", REPOSITORY, {});
  const target = listed.json.issues[1];
  fake.calls.length = 0;
  const response = await call(port, "issue-promote", REPOSITORY, { number: 2, digest: target.digest });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { ok: true, taskId: "T-1" });
  assert.deepEqual(fake.calls, [["readIssue", ROOT, 2]]);
  const task = store.readBoard(REPOSITORY).tasks[0];
  assert.equal(task.text, `Issue 2\n\n${BODY_SECRET} visible`);
  assert.deepEqual(task.source, { kind: "github_issue", number: 2 });
  assert.ok(!response.text.includes(BODY_SECRET));
});

test("a payload with a title, body, or text field is invalid and the store is not written", async (context) => {
  const fake = fakeReader();
  const { port, store } = await setup(context, { reader: fake.reader });
  const digest = normalizeIssue(raw(1)).digest;
  for (const payload of [
    { number: 1, digest, title: "FORGED", body: "FORGED" }, { number: 1, digest, text: "FORGED" }, { number: 1, digest, extra: 1 },
  ]) assertRefusal(await call(port, "issue-promote", REPOSITORY, payload), 400, "invalid");
  assert.deepEqual(fake.calls, []);
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 0);
});

test("a changed issue is a conflict, a promoted one is a conflict, a long one is a limit", async (context) => {
  const fake = fakeReader();
  const { port, store } = await setup(context, { reader: fake.reader });
  const listed = await call(port, "issues-list", REPOSITORY, {});
  const [first] = listed.json.issues;

  fake.github.issues[0] = raw(1, { body: "edited since the list" });
  assertRefusal(await call(port, "issue-promote", REPOSITORY, { number: 1, digest: first.digest }), 409, "conflict");
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 0);

  const fresh = normalizeIssue(fake.github.issues[0]);
  assert.deepEqual((await call(port, "issue-promote", REPOSITORY, { number: 1, digest: fresh.digest })).json, { ok: true, taskId: "T-1" });
  assertRefusal(await call(port, "issue-promote", REPOSITORY, { number: 1, digest: fresh.digest }), 409, "conflict");
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 1);

  fake.github.issues.push(raw(3, { body: "x".repeat(4100) }), raw(4, { body: "y".repeat(30_000) }));
  for (const number of [3, 4]) {
    const issue = normalizeIssue(fake.github.issues.find((item) => item.number === number));
    assert.equal(issue.tooLong, true);
    assertRefusal(await call(port, "issue-promote", REPOSITORY, { number, digest: issue.digest }), 409, "limit");
  }
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 1);
});

test("a gone, closed, or pull-request issue is not_found, and other read failures are unavailable", async (context) => {
  const fake = fakeReader();
  fake.github.issues.push(raw(5, { state: "closed" }), raw(6, { pull_request: {} }));
  const { port, store } = await setup(context, { reader: fake.reader });
  const digest = "a".repeat(64);
  for (const number of [5, 6, 99]) assertRefusal(await call(port, "issue-promote", REPOSITORY, { number, digest }), 404, "not_found");
  for (const status of ["cli_missing", "not_signed_in", "no_access", "issues_disabled", "unavailable"]) {
    fake.github.readStatus = status;
    assertRefusal(await call(port, "issue-promote", REPOSITORY, { number: 1, digest }), 503, "unavailable");
  }
  fake.github.readStatus = "not_found";
  assertRefusal(await call(port, "issue-promote", REPOSITORY, { number: 1, digest }), 404, "not_found");
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 0);

  assertRefusal(await call(port, "issue-promote", OTHER_REPOSITORY, { number: 1, digest }), 503, "unavailable");
});

test("a private repository lists and promotes like a public one", async (context) => {
  const fake = fakeReader({ visibility: "private", capabilities: ["read_issues"] });
  const { port } = await setup(context, { reader: fake.reader });
  const status = await call(port, "github-status", REPOSITORY, {});
  assert.deepEqual(status.json.repository, { visibility: "private", capabilities: ["read_issues"] });
  const listed = await call(port, "issues-list", REPOSITORY, {});
  assert.equal(listed.json.status, "ok");
  const promoted = await call(port, "issue-promote", REPOSITORY, { number: 1, digest: listed.json.issues[0].digest });
  assert.deepEqual(promoted.json, { ok: true, taskId: "T-1" });
});

test("the store's refusals keep their fixed statuses, and a throwing store or reader is unavailable", async (context) => {
  const fake = fakeReader();
  const digest = normalizeIssue(raw(1)).digest;
  for (const [error, status] of [["limit", 409], ["invalid", 400], ["conflict", 409], ["surprise", 503]]) {
    const { port } = await setup(context, { reader: fake.reader, storeOverride: { apply: () => ({ ok: false, error }), promotedIssues: () => new Map(), readBoard: () => ({}), close() {} } });
    assertRefusal(await call(port, "issue-promote", REPOSITORY, { number: 1, digest }), status, error === "surprise" ? "unavailable" : error);
  }
  const throwing = await setup(context, { reader: fake.reader, storeOverride: { apply() { throw new Error("C:/secret/path"); }, promotedIssues: () => new Map(), close() {} } });
  const thrown = await call(throwing.port, "issue-promote", REPOSITORY, { number: 1, digest });
  assertRefusal(thrown, 503, "unavailable");
  assert.ok(!thrown.text.includes("secret"));
  const boom = { ...fake.reader, async connection() { throw new Error("C:/secret/gh"); } };
  const { port } = await setup(context, { reader: boom });
  const status = await call(port, "github-status", REPOSITORY, {});
  assertRefusal(status, 503, "unavailable");
  assert.ok(!status.text.includes("secret"));
});

test("a missing store or a missing composition is unavailable", async (context) => {
  const server = http.createServer(createRequestHandler({ runtime: {}, taskStore: null, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  for (const name of TASK_ISSUE_ACTIONS) {
    assertRefusal(await call(server.address().port, name, REPOSITORY, name === "issue-promote" ? { number: 1, digest: "a".repeat(64) } : {}), 503, "unavailable");
  }
  const { port } = await setup(context, { reader: fakeReader().reader });
  const noComposition = http.createServer(createRequestHandler({ runtime: {}, taskStore: { apply() {}, promotedIssues: () => new Map(), close() {} }, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => noComposition.close(resolve)));
  await new Promise((resolve) => noComposition.listen(0, "127.0.0.1", resolve));
  assertRefusal(await call(noComposition.address().port, "issues-list", REPOSITORY, {}), 503, "unavailable");
  assert.ok(port > 0);
});

test("authorization: no token, a wrong token, an Origin, a foreign host, or a GET never reach the reader", async (context) => {
  const fake = fakeReader();
  const { port, runtimeReads } = await setup(context, { reader: fake.reader });
  const body = JSON.stringify({ repositoryId: REPOSITORY, payload: {} });
  for (const name of TASK_ISSUE_ACTIONS) {
    const requestPath = `/internal/tasks/${name}`;
    for (const headers of [
      JSON_BODY, { ...JSON_BODY, "x-pomegr-desktop-authorization": "x".repeat(40) }, { ...withToken, ...JSON_BODY, origin: "http://evil.example" }, { ...withToken, ...JSON_BODY, host: "192.168.1.20:3003" },
    ]) {
      const denied = await send(port, { path: requestPath, headers, body });
      assert.equal(denied.status, 401);
      assert.equal(denied.text, "Unauthorized");
    }
    const get = await send(port, { method: "GET", path: requestPath, headers: withToken });
    assert.equal(get.status, 401);
  }
  assert.deepEqual(fake.calls, []);
  assert.ok(!runtimeReads.includes("taskIssues"));
});

test("bad envelopes, payloads, queries, and sizes are invalid and read nothing", async (context) => {
  const fake = fakeReader();
  const { port, store } = await setup(context, { reader: fake.reader });
  const digest = "a".repeat(64);
  const post = (name, body, query = "") => send(port, { path: `/internal/tasks/${name}${query}`, headers: { ...withToken, ...JSON_BODY }, body });
  for (const name of TASK_ISSUE_ACTIONS) {
    assertRefusal(await post(name, "not json"), 400, "invalid");
    assertRefusal(await post(name, JSON.stringify([])), 400, "invalid");
    assertRefusal(await post(name, JSON.stringify({ repositoryId: "bad", payload: {} })), 400, "invalid");
    assertRefusal(await post(name, JSON.stringify({ repositoryId: REPOSITORY })), 400, "invalid");
    assertRefusal(await post(name, JSON.stringify({ repositoryId: REPOSITORY, payload: [] })), 400, "invalid");
    assertRefusal(await post(name, JSON.stringify({ repositoryId: REPOSITORY, payload: {}, extra: 1 })), 400, "invalid");
    assertRefusal(await post(name, JSON.stringify({ repositoryId: REPOSITORY, payload: {} }), "?x=1"), 400, "invalid");
    assertRefusal(await post(name, JSON.stringify({ repositoryId: REPOSITORY, payload: { padding: "p".repeat(20_000) } })), 413, "invalid");
  }
  for (const name of ["github-status", "issues-list"]) {
    assertRefusal(await call(port, name, REPOSITORY, { number: 1 }), 400, "invalid");
  }
  for (const payload of [
    {}, { number: 1 }, { digest }, { number: 0, digest }, { number: -1, digest }, { number: 1.5, digest }, { number: "1", digest }, { number: 1_000_000_000, digest },
    { number: null, digest }, { number: 1, digest: "A".repeat(64) }, { number: 1, digest: "a".repeat(63) }, { number: 1, digest: 5 }, { number: 1, digest: `${digest}\n` },
  ]) assertRefusal(await call(port, "issue-promote", REPOSITORY, payload), 400, "invalid");
  assert.deepEqual(fake.calls, []);
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 0);
});

test("promote_issue is not a route of its own", async (context) => {
  const fake = fakeReader();
  const { port, store } = await setup(context, { reader: fake.reader });
  for (const name of ["promote_issue", "promote-issue", "issues_list"]) {
    const response = await call(port, name, REPOSITORY, { number: 1, title: "FORGED", body: "FORGED" });
    assert.equal(response.status, 404);
  }
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 0);
  assert.deepEqual(fake.calls, []);
});

test("no GET reaches the reader or serves a listed issue body, and a task carries only its source", async (context) => {
  const fake = fakeReader();
  const { port, runtimeReads } = await setup(context, { reader: fake.reader });
  const listed = await call(port, "issues-list", REPOSITORY, {});
  await call(port, "issue-promote", REPOSITORY, { number: 1, digest: listed.json.issues[0].digest });
  fake.calls.length = 0;
  runtimeReads.length = 0;

  const board = await getBoard(port);
  assert.equal(board.status, 200);
  assert.deepEqual(board.json.tasks.map((task) => task.source), [{ kind: "github_issue", number: 1 }]);
  assert.deepEqual(Object.keys(board.json).sort(), ["columns", "features", "queue", "readiness", "repositoryId", "runModels", "tasks", "version"]);
  const gets = [
    board.text,
    (await send(port, { method: "GET", path: `/api/tasks?repositoryId=${OTHER_REPOSITORY}`, headers: withToken })).text,
    (await send(port, { method: "GET", path: "/api/sessions?mode=directory&tasks=1", headers: withToken })).text,
    (await send(port, { method: "GET", path: "/api/state", headers: withToken })).text,
  ];
  for (const text of gets) {
    assert.ok(!text.includes(BODY_SECRET));
    assert.ok(!text.includes("Body of 2"));
    assert.ok(!text.includes("hidden note"));
  }
  assert.deepEqual(fake.calls, []);
  assert.ok(!runtimeReads.includes("taskIssues"));
});

test("the held list is bounded to sixteen repositories, oldest evicted, and not persisted anywhere", async () => {
  const fake = fakeReader();
  const roots = {};
  const ids = Array.from({ length: 18 }, (_, index) => `repo-${String(index).padStart(24, "0")}`);
  for (const id of ids) roots[id] = `C:/Work/${id}`;
  const taskIssues = createTaskIssues({ repositoryRoot: (id) => roots[id] ?? null, reader: fake.reader });
  for (const id of ids.slice(0, 16)) await taskIssues.list(id);
  assert.ok(ids.slice(0, 16).every((id) => taskIssues.held(id) !== null));
  await taskIssues.list(ids[0]);
  await taskIssues.list(ids[16]);
  assert.equal(taskIssues.held(ids[1]), null);
  assert.notEqual(taskIssues.held(ids[0]), null);
  await taskIssues.list(ids[17]);
  assert.equal(taskIssues.held(ids[2]), null);
  assert.equal(ids.filter((id) => taskIssues.held(id) !== null).length, 16);
  assert.equal(taskIssues.held(ids[17]).issues.length, 2);
  assert.equal(taskIssues.held("repo-ffffffffffffffffffffffff"), null);
});

test("list for an unknown root, and a failed read, hold nothing and a failed read never evicts a good list", async () => {
  const fake = fakeReader();
  const taskIssues = createTaskIssues({ repositoryRoot: (id) => (id === REPOSITORY ? ROOT : null), reader: fake.reader });
  const unknown = await taskIssues.list(OTHER_REPOSITORY);
  assert.equal(unknown.status, "unavailable");
  assert.deepEqual(unknown.issues, []);
  assert.equal(taskIssues.held(OTHER_REPOSITORY), null);
  assert.deepEqual(await taskIssues.read(OTHER_REPOSITORY, 1), { status: "unavailable", issue: null });

  await taskIssues.list(REPOSITORY);
  fake.github.listStatus = "unavailable";
  assert.equal((await taskIssues.list(REPOSITORY)).status, "unavailable");
  assert.equal(taskIssues.held(REPOSITORY).status, "ok");
  const one = await taskIssues.read(REPOSITORY, 1);
  assert.equal(one.status, "ok");
  assert.equal(one.issue.number, 1);
});

test("read never trusts the held list", async () => {
  const fake = fakeReader();
  const taskIssues = createTaskIssues({ repositoryRoot: () => ROOT, reader: fake.reader });
  await taskIssues.list(REPOSITORY);
  fake.github.issues[0] = raw(1, { title: "Renamed" });
  assert.equal((await taskIssues.read(REPOSITORY, 1)).issue.title, "Renamed");
  assert.equal(taskIssues.held(REPOSITORY).issues[0].title, "Issue 1");
});

test("the runtime lookups compose the reader with the recognized root and keep the root out of the answers", async () => {
  const fake = fakeReader();
  const lookups = createTaskLookups({
    observationStore: null, catalogSessions: () => [], repositoryInventory: { repositoryRoot: (id) => (id === REPOSITORY ? ROOT : null) }, issueReader: fake.reader,
  });
  const listed = await lookups.taskIssues.list(REPOSITORY);
  assert.equal(listed.status, "ok");
  assert.ok(!JSON.stringify(await lookups.taskIssues.status(REPOSITORY)).includes("SECRET-ROOT"));
  assert.deepEqual(fake.calls.filter(([name]) => name === "listOpenIssues"), [["listOpenIssues", ROOT]]);
  assert.equal((await lookups.taskIssues.list(OTHER_REPOSITORY)).status, "unavailable");
});
