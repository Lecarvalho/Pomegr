import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_ACTIONS as ROUTE_ACTIONS } from "../../../server/serving/task-routes.mjs";
import { buildTaskPrompt } from "../../../server/tasks/task-dispatch.mjs";
import { TASK_ACTIONS, TASK_BOUNDS } from "../../../server/tasks/task-record.mjs";
import { TASK_STORE_SCHEMA_VERSION, openTaskStore } from "../../../server/tasks/task-store.mjs";
import { normalizeIssue } from "../../../server/repository/issues.mjs";
import { FACTS, OTHER_REPOSITORY, REPOSITORY, passingGates, removeDirectory } from "./queue-test-support.mjs";

const TOKEN = "p".repeat(40);
const SESSION = "claude:0b8f2c1e-1111-4222-8333-444455556666";

async function setup(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-promote-"));
  const env = { directory, store: openTaskStore({ directory, now: () => 1_000_000 }) };
  context.after(async () => { env.store.close(); await removeDirectory(directory); });
  return env;
}

const promote = (env, payload, repositoryId = REPOSITORY) => env.store.apply(repositoryId, "promote_issue", payload);
const board = (env, repositoryId = REPOSITORY) => env.store.readBoard(repositoryId);
const issue = (overrides = {}) => ({ number: 12, title: "Fix the parser", body: "It crashes on empty input.", ...overrides });

function metaRows(env) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(env.directory, "tasks.sqlite"), { readOnly: true });
  try { return database.prepare("SELECT key, value FROM meta WHERE key LIKE 'task_source:%' ORDER BY key").all().map((row) => ({ key: row.key, value: row.value })); } finally { database.close(); }
}

test("promote creates a task in the first column with the composed text and its source", async (context) => {
  const env = await setup(context);
  const result = promote(env, issue());
  assert.equal(result.ok, true);
  assert.equal(result.taskId, "T-1");
  const first = result.board.columns[0];
  assert.equal(first.name, "Backlog");
  const task = result.board.tasks[0];
  assert.equal(task.id, "T-1");
  assert.equal(task.columnId, first.id);
  assert.equal(task.text, "Fix the parser\n\nIt crashes on empty input.");
  assert.deepEqual(task.source, { kind: "github_issue", number: 12 });
  assert.deepEqual(task.run, { provider: null, model: null, effort: null });
  assert.deepEqual(task.doneWhen, { checks: [], own: null });
  assert.equal(task.state, "not_queued");
  assert.equal(task.featureId, null);
  assert.deepEqual(board(env).tasks[0].source, { kind: "github_issue", number: 12 });
  assert.deepEqual(metaRows(env), [{ key: `task_source:${REPOSITORY}:T-1`, value: "12" }]);
});

test("an empty body stores the title alone, and a plain task has no source", async (context) => {
  const env = await setup(context);
  assert.equal(promote(env, issue({ body: "" })).board.tasks[0].text, "Fix the parser");
  assert.equal(promote(env, issue({ number: 13, body: "  \n " })).board.tasks[1].text, "Fix the parser");
  assert.equal(env.store.apply(REPOSITORY, "create", { text: "A plain task" }).ok, true);
  assert.equal(board(env).tasks[2].source, null);
});

test("promoting the same issue again is a conflict, in the same repository only", async (context) => {
  const env = await setup(context);
  assert.equal(promote(env, issue()).ok, true);
  assert.deepEqual(promote(env, issue()), { ok: false, error: "conflict" });
  assert.deepEqual(promote(env, issue({ title: "Another title" })), { ok: false, error: "conflict" });
  assert.equal(board(env).tasks.length, 1);
  assert.equal(promote(env, issue(), OTHER_REPOSITORY).ok, true);
  assert.equal(promote(env, issue({ number: 13 })).taskId, "T-2");
});

test("text over 4000 characters is limit, and exactly 4000 is stored", async (context) => {
  const env = await setup(context);
  const title = "T";
  assert.deepEqual(promote(env, issue({ title, body: "b".repeat(TASK_BOUNDS.textLength - title.length - 1) })), { ok: false, error: "limit" });
  assert.equal(board(env).tasks.length, 0);
  const fits = promote(env, issue({ title, body: "b".repeat(TASK_BOUNDS.textLength - title.length - 2) }));
  assert.equal(fits.ok, true);
  assert.equal(fits.board.tasks[0].text.length, 4000);
  // A promoted issue the reader called tooLong is refused the same way.
  const read = normalizeIssue({ number: 14, title: "Long", body: "x".repeat(4100), author_association: "NONE" });
  assert.equal(read.tooLong, true);
  assert.deepEqual(promote(env, { number: 14, title: read.title, body: "x".repeat(4100) }), { ok: false, error: "limit" });
});

test("a full board is limit", async (context) => {
  const env = await setup(context);
  for (let number = 1; number <= TASK_BOUNDS.tasksPerRepository; number += 1) assert.equal(env.store.apply(REPOSITORY, "create", { text: `task ${number}` }).ok, true);
  assert.deepEqual(promote(env, issue()), { ok: false, error: "limit" });
  assert.deepEqual(metaRows(env), []);
});

test("invalid payloads change nothing", async (context) => {
  const env = await setup(context);
  const bad = [
    undefined, null, "text", [], {}, issue({ number: 0 }), issue({ number: -1 }), issue({ number: 1.5 }), issue({ number: "12" }),
    issue({ number: 1_000_000_000 }), issue({ title: "" }), issue({ title: " padded " }), issue({ title: "two\nlines" }),
    issue({ title: "x".repeat(201) }), issue({ title: 5 }), issue({ title: "bad \ud800" }), issue({ body: null }), issue({ body: 7 }),
    issue({ body: "control \u0007 char" }), issue({ body: "x".repeat(1_000_001) }), { ...issue(), extra: true }, { number: 12, title: "T" },
    { number: 12, body: "b" }, { title: "T", body: "b" }, { ...issue(), id: "T-1" },
  ];
  for (const payload of bad) assert.deepEqual(promote(env, payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(promote(env, issue(), "not-a-repository"), { ok: false, error: "invalid" });
  assert.equal(board(env).tasks.length, 0);
  assert.deepEqual(metaRows(env), []);
  // Line breaks and tabs in a body are ordinary text.
  assert.equal(promote(env, issue({ body: "line one\r\n\tline two" })).ok, true);
});

test("deleting a promoted task deletes its source in the same write and the issue can be promoted again", async (context) => {
  const env = await setup(context);
  assert.equal(promote(env, issue()).taskId, "T-1");
  assert.equal(env.store.apply(REPOSITORY, "delete", { id: "T-1" }).ok, true);
  assert.deepEqual(metaRows(env), []);
  assert.equal(env.store.promotedIssues(REPOSITORY).size, 0);
  const again = promote(env, issue());
  assert.equal(again.ok, true);
  // Task numbers are never reused.
  assert.equal(again.taskId, "T-2");
  assert.deepEqual(again.board.tasks[0].source, { kind: "github_issue", number: 12 });
});

test("promotedIssues maps issue numbers to task IDs per repository", async (context) => {
  const env = await setup(context);
  assert.equal(env.store.promotedIssues(REPOSITORY).size, 0);
  promote(env, issue({ number: 12 }));
  env.store.apply(REPOSITORY, "create", { text: "plain" });
  promote(env, issue({ number: 99 }));
  promote(env, issue({ number: 12 }), OTHER_REPOSITORY);
  const promoted = env.store.promotedIssues(REPOSITORY);
  assert.ok(promoted instanceof Map);
  assert.deepEqual([...promoted], [[12, "T-1"], [99, "T-3"]]);
  assert.deepEqual([...env.store.promotedIssues(OTHER_REPOSITORY)], [[12, "T-1"]]);
  assert.equal(env.store.promotedIssues("nope").size, 0);
  env.store.close();
  assert.equal(env.store.promotedIssues(REPOSITORY).size, 0);
});

test("the source survives closing and reopening, closing a task, and a requeue", async (context) => {
  const env = await setup(context);
  promote(env, issue());
  env.store.close();
  const reopened = openTaskStore({ directory: env.directory, now: () => 1_000_000 });
  try {
    assert.deepEqual(reopened.readBoard(REPOSITORY).tasks[0].source, { kind: "github_issue", number: 12 });
    assert.deepEqual([...reopened.promotedIssues(REPOSITORY)], [[12, "T-1"]]);
    // An edit and a move keep where the task came from.
    const edited = reopened.apply(REPOSITORY, "update", { id: "T-1", text: "Edited locally" });
    assert.deepEqual(edited.board.tasks[0].source, { kind: "github_issue", number: 12 });
    assert.equal(reopened.readBoard(REPOSITORY).tasks[0].text, "Edited locally");
    const done = reopened.readBoard(REPOSITORY).columns.at(-1);
    assert.equal(reopened.apply(REPOSITORY, "move", { id: "T-1", columnId: done.id, position: 0 }).board.tasks[0].source.number, 12);
    // Start, report a block, and requeue: the link and report clear, the origin stays.
    const planned = reopened.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates);
    assert.deepEqual(reopened.bindSession({ token: planned.plan.token, sessionId: SESSION }), { ok: true });
    assert.equal(reopened.blockTask({ sessionId: SESSION, reason: "Needs a decision" }).state, "blocked");
    const requeued = reopened.apply(REPOSITORY, "resolve_requeue", { id: "T-1" });
    assert.equal(requeued.ok, true);
    assert.equal(requeued.board.tasks[0].session, null);
    assert.equal(requeued.board.tasks[0].source.number, 12);
  } finally { reopened.close(); }
});

test("the store schema version is unchanged and promote_issue is not a routable action", async (context) => {
  assert.equal(TASK_STORE_SCHEMA_VERSION, 1);
  assert.equal(TASK_ACTIONS.includes("promote_issue"), false);
  assert.equal(ROUTE_ACTIONS.includes("promote_issue"), false);
  const env = await setup(context);
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(env.directory, "tasks.sqlite"), { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1");
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name), ["columns", "features", "meta", "repositories", "tasks"]);
  } finally { database.close(); }
});

test("a malformed stored source reads as no source and never breaks the board", async (context) => {
  const env = await setup(context);
  promote(env, issue());
  env.store.close();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(env.directory, "tasks.sqlite"));
  database.prepare("UPDATE meta SET value = ? WHERE key = ?").run("not a number", `task_source:${REPOSITORY}:T-1`);
  database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`task_source:${REPOSITORY}:garbage`, "5");
  database.close();
  const reopened = openTaskStore({ directory: env.directory });
  try {
    const read = reopened.readBoard(REPOSITORY);
    assert.equal(read.readiness, "ready");
    assert.equal(read.tasks[0].source, null);
    assert.equal(reopened.promotedIssues(REPOSITORY).size, 0);
  } finally { reopened.close(); }
});

test("the prompt names the issue only when the task has a source, and the longest prompt fits the desktop limit", () => {
  const base = { id: "T-3", text: "Fix the parser", doneWhen: { checks: [], own: null } };
  const plain = buildTaskPrompt({ ...base, source: null });
  assert.ok(!plain.includes("GitHub issue"));
  assert.equal(buildTaskPrompt(base), plain);
  const sourced = buildTaskPrompt({ ...base, source: { kind: "github_issue", number: 12 } });
  const line = 'This task comes from GitHub issue #12. Write "Closes #12" in the pull request description.';
  const lines = sourced.split("\n");
  assert.ok(lines.includes(line));
  // The issue line sits just before the final instruction.
  assert.equal(lines.at(-2), line);
  assert.ok(lines.at(-1).startsWith("When the task is done"));
  assert.deepEqual(lines.filter((entry) => entry !== line), plain.split("\n"));
  for (const source of [{ kind: "github_issue", number: "12; rm" }, { kind: "github_issue", number: 0 }, { kind: "github_issue", number: 1.5 },
    { kind: "other", number: 12 }, { kind: "github_issue" }, undefined]) {
    assert.equal(buildTaskPrompt({ ...base, source }), plain, JSON.stringify(source));
  }
  const longest = buildTaskPrompt({
    id: "T-999999999", text: "x".repeat(TASK_BOUNDS.textLength),
    doneWhen: { checks: ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"], own: "y".repeat(TASK_BOUNDS.ownConditionLength) },
    source: { kind: "github_issue", number: 999_999_999 },
  });
  assert.ok(longest.length < 8000, `the longest prompt is ${longest.length} characters`);
});

test("a started promoted task's plan carries the issue line", async (context) => {
  const env = await setup(context);
  const promoted = promote(env, issue({ number: 31 }));
  const planned = env.store.planStart(REPOSITORY, { id: promoted.taskId }, () => FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.ok(planned.plan.prompt.includes('Write "Closes #31" in the pull request description.'));
  assert.deepEqual(env.store.bindSession({ token: planned.plan.token, sessionId: SESSION }), { ok: true });
  assert.deepEqual(env.store.readBoard(REPOSITORY).tasks[0].source, { kind: "github_issue", number: 31 });
  const plain = env.store.apply(REPOSITORY, "create", { text: "plain" });
  assert.equal(plain.ok, true);
  const second = env.store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates);
  assert.ok(!second.plan.prompt.includes("GitHub issue"));
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function get(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "GET", path: requestPath, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    request.on("error", reject);
    request.end();
  });
}

function post(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: "127.0.0.1", port, method: "POST", path: requestPath, agent: false,
      headers: { "x-pomegr-desktop-authorization": TOKEN, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
    request.end(payload);
  });
}

test("GET /api/tasks serves the source of a promoted task and null for the others, and no route promotes", async (context) => {
  const env = await setup(context);
  promote(env, issue({ number: 12 }));
  env.store.apply(REPOSITORY, "create", { text: "plain" });
  const server = http.createServer(createRequestHandler({ runtime: {}, taskStore: env.store, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  const served = await get(port, `/api/tasks?repositoryId=${REPOSITORY}`, { "x-pomegr-desktop-authorization": TOKEN });
  assert.equal(served.status, 200);
  assert.equal(served.json.readiness, "ready");
  assert.deepEqual(served.json.tasks.map((task) => task.source), [{ kind: "github_issue", number: 12 }, null]);
  assert.ok(served.json.tasks.every((task) => Object.hasOwn(task, "source")));

  assert.equal(await post(port, "/internal/tasks/promote_issue", { repositoryId: REPOSITORY, payload: issue({ number: 77 }) }), 404);
  assert.equal(env.store.readBoard(REPOSITORY).tasks.length, 2);
});

test("the served source is validated again at the route", async (context) => {
  const store = {
    readBoard: () => ({
      version: 1, readiness: "ready", repositoryId: REPOSITORY, columns: [], features: [],
      queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] },
      tasks: [
        { id: "T-1", source: { kind: "github_issue", number: 4, login: "SECRET-LOGIN" } },
        { id: "T-2", source: { kind: "github_issue", number: -4 } },
        { id: "T-3", source: { kind: "url", number: 4 } },
        { id: "T-4", source: "github" },
        { id: "T-5" },
      ],
    }),
    apply() { throw new Error("no writes on a GET"); },
    close() {},
  };
  const server = http.createServer(createRequestHandler({ runtime: {}, taskStore: store, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);
  const served = await get(port, `/api/tasks?repositoryId=${REPOSITORY}`, { "x-pomegr-desktop-authorization": TOKEN });
  assert.deepEqual(served.json.tasks.map((task) => task.source), [{ kind: "github_issue", number: 4 }, null, null, null, null]);
});
