import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_HOME_ATTENTION_LIMIT, TASK_HOME_TITLE_LENGTH, summarizeTaskHome } from "../../../server/tasks/task-home.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const OTHER_REPOSITORY = `repo-${"b2".repeat(12)}`;
const TOKEN = "t".repeat(40);
const HOME_PATH = "/api/tasks?view=home";
const EMPTY_QUEUE = { status: "idle", blockedBy: null, pauseReason: null };
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `c${position}`, name, position }));

function task(number, overrides = {}) {
  return { id: `T-${number}`, text: `Task ${number}`, columnId: "c0", state: "not_queued", session: null, updatedAt: "2026-10-08T10:00:00.000Z", ...overrides };
}
function board(tasks, overrides = {}) {
  return { columns, features: [], tasks, queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, ...overrides };
}

test("a board is summarized as its five column counts, open features, queue, and newest change", () => {
  const home = summarizeTaskHome([{ repositoryId: REPOSITORY, board: board([
    task(1), task(2, { columnId: "c1", updatedAt: "2026-10-09T10:00:00.000Z" }), task(3, { columnId: "c4", state: "done" }),
  ], { features: [{ id: "f1", name: "SECRET-FEATURE", done: false }, { id: "f2", name: "Shipped", done: true }], queue: { status: "blocked", blockedBy: "T-2", pauseReason: null, order: ["T-1"] } }) }]);
  assert.deepEqual(home, {
    boards: [{ repositoryId: REPOSITORY, readiness: "ready", counts: [1, 1, 0, 0, 1], openFeatures: 1, queue: { status: "blocked", blockedBy: "T-2", pauseReason: null }, updatedAt: "2026-10-09T10:00:00.000Z" }],
    attention: [], attentionTotal: 0,
  });
  assert.ok(!JSON.stringify(home).includes("SECRET-FEATURE"), "a feature name never enters the home");
});

test("a board that did not project is unavailable and adds nothing that waits", () => {
  const home = summarizeTaskHome([{ repositoryId: REPOSITORY, board: null }, { repositoryId: OTHER_REPOSITORY, board: board([], { columns: columns.slice(0, 3) }) }]);
  assert.deepEqual(home.boards.map((entry) => [entry.readiness, entry.counts, entry.updatedAt]), [["unavailable", [], null], ["unavailable", [], null]]);
  assert.deepEqual(home.boards[0].queue, EMPTY_QUEUE);
  assert.equal(home.attentionTotal, 0);
});

test("only Needs review, Stalled, and Blocked by agent wait for the owner, newest first across boards", () => {
  const home = summarizeTaskHome([
    { repositoryId: REPOSITORY, board: board([
      task(1, { state: "needs_review", updatedAt: "2026-10-08T10:00:00.000Z" }), task(2, { state: "queued" }), task(3, { state: "done" }),
      task(4, { state: "blocked", updatedAt: "2026-10-10T10:00:00.000Z" }),
    ]) },
    { repositoryId: OTHER_REPOSITORY, board: board([task(1, { state: "stalled", updatedAt: "2026-10-09T10:00:00.000Z" })]) },
  ]);
  assert.deepEqual(home.attention.map((item) => [item.repositoryId, item.taskId, item.state]), [
    [REPOSITORY, "T-4", "blocked"], [OTHER_REPOSITORY, "T-1", "stalled"], [REPOSITORY, "T-1", "needs_review"],
  ]);
  assert.equal(home.attentionTotal, 3);
});

test("the title is one bounded line: the session title, else the first line of the task text", () => {
  const long = "x".repeat(400);
  const home = summarizeTaskHome([{ repositoryId: REPOSITORY, board: board([
    task(1, { state: "needs_review", text: "\n  First line\nSECOND-LINE-never-served", updatedAt: "2026-10-08T10:00:03.000Z" }),
    task(2, { state: "needs_review", text: "Task text", session: { id: "claude:abc", title: "Session title" }, updatedAt: "2026-10-08T10:00:02.000Z" }),
    task(3, { state: "needs_review", text: long, updatedAt: "2026-10-08T10:00:01.000Z" }),
    task(4, { state: "needs_review", text: "See [image:img-0123456789ab]", updatedAt: "2026-10-08T10:00:00.000Z" }),
  ]) }]);
  assert.deepEqual(home.attention.map((item) => item.title).filter((title) => title.length < 100), ["First line", "Session title", "See [image]"]);
  assert.equal(home.attention[2].title.length, TASK_HOME_TITLE_LENGTH);
  assert.ok(!JSON.stringify(home).includes("SECOND-LINE"));
});

test("the title leaves out the leading tags, lets the next line lead after a line of only tags, and keeps a text of only tags", () => {
  const home = summarizeTaskHome([{ repositoryId: REPOSITORY, board: board([
    task(1, { state: "needs_review", text: "[ backend ] [ recce ] Coverage opens a shot only on an action line.\nSECOND-LINE-never-served", updatedAt: "2026-10-08T10:00:05.000Z" }),
    task(2, { state: "needs_review", text: "[ frontend ] [ tech-debt ]\nMake plan-intent atomic\nSECOND-LINE-never-served", updatedAt: "2026-10-08T10:00:04.000Z" }),
    task(3, { state: "needs_review", text: "[wip] [ui]", updatedAt: "2026-10-08T10:00:03.000Z" }),
    task(4, { state: "needs_review", text: "Fix [ bug ] in the cart", updatedAt: "2026-10-08T10:00:02.000Z" }),
    task(5, { state: "needs_review", text: "[ ui ] Polish the board", session: { id: "claude:abc", title: "Session title" }, updatedAt: "2026-10-08T10:00:01.000Z" }),
  ]) }]);
  assert.deepEqual(home.attention.map((item) => item.title), [
    "Coverage opens a shot only on an action line.", "Make plan-intent atomic", "[wip] [ui]", "Fix [ bug ] in the cart", "Session title",
  ]);
  assert.ok(!JSON.stringify(home).includes("SECOND-LINE"));
});

test("the title skips blank lines and a Windows line break after the tags, leaves out a heading mark, and keeps a text of only tags", () => {
  const home = summarizeTaskHome([{ repositoryId: REPOSITORY, board: board([
    task(1, { state: "needs_review", text: "[ui]\n\nFix the login\nSECOND-LINE-never-served", updatedAt: "2026-10-08T10:00:06.000Z" }),
    task(2, { state: "needs_review", text: "[ui] [x]\r\n  \r\nFix on Windows\r\nSECOND-LINE-never-served", updatedAt: "2026-10-08T10:00:05.000Z" }),
    task(3, { state: "needs_review", text: "\n\n## Heading title\nSECOND-LINE-never-served", updatedAt: "2026-10-08T10:00:04.000Z" }),
    task(4, { state: "needs_review", text: "[wip] [ui]\n\n  \n", updatedAt: "2026-10-08T10:00:03.000Z" }),
    task(5, { state: "needs_review", text: "[ui] # Tagged heading", updatedAt: "2026-10-08T10:00:02.000Z" }),
    task(6, { state: "needs_review", text: "   \n\u0001\nAfter a control line", updatedAt: "2026-10-08T10:00:01.000Z" }),
  ]) }]);
  assert.deepEqual(home.attention.map((item) => item.title), [
    "Fix the login", "Fix on Windows", "Heading title", "[wip] [ui]", "Tagged heading", "After a control line",
  ]);
  assert.ok(!JSON.stringify(home).includes("SECOND-LINE"));
});

test("the title joins every leading line of only tags into the tags, and keeps a text of only tags on one line", () => {
  const home = summarizeTaskHome([{ repositoryId: REPOSITORY, board: board([
    task(1, { state: "needs_review", text: "[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent consume atomic\nSECOND-LINE-never-served", updatedAt: "2026-10-08T10:00:03.000Z" }),
    task(2, { state: "needs_review", text: "[a]\n[b]\n", updatedAt: "2026-10-08T10:00:02.000Z" }),
    task(3, { state: "needs_review", text: "Title\n[a]\nBody", updatedAt: "2026-10-08T10:00:01.000Z" }),
    task(4, { state: "needs_review", text: "[ui]\n\n[TODO] write tests", updatedAt: "2026-10-08T10:00:00.000Z" }),
  ]) }]);
  assert.deepEqual(home.attention.map((item) => item.title), ["Make plan-intent consume atomic", "[a] [b]", "Title", "[TODO] write tests"]);
  assert.ok(!JSON.stringify(home).includes("SECOND-LINE"));
});

test("the list of what waits is capped, and the total still counts every task", () => {
  const tasks = Array.from({ length: TASK_HOME_ATTENTION_LIMIT + 7 }, (_, index) => task(index + 1, { state: "stalled" }));
  const home = summarizeTaskHome([{ repositoryId: REPOSITORY, board: board(tasks) }]);
  assert.equal(home.attention.length, TASK_HOME_ATTENTION_LIMIT);
  assert.equal(home.attentionTotal, TASK_HOME_ATTENTION_LIMIT + 7);
});

async function temporaryStore(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-home-"));
  const store = openTaskStore({ directory });
  context.after(async () => {
    store.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
  });
  return { store, directory };
}

test("the store summarizes only the boards it holds, and reading the home seeds no board", async (context) => {
  const { store, directory } = await temporaryStore(context);
  assert.deepEqual(store.readHome(), { boards: [], attention: [], attentionTotal: 0 });
  assert.equal(store.apply(REPOSITORY, "create", { text: "Write the release notes\nwith details" }).ok, true);
  assert.equal(store.apply(REPOSITORY, "create", { text: "Second task" }).ok, true);
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try { database.prepare("UPDATE tasks SET state = 'needs_review' WHERE repository_id = ? AND number = 1").run(REPOSITORY); } finally { database.close(); }

  const home = store.readHome();
  assert.equal(home.boards.length, 1, "a repository with no stored board is not listed, and is not created by the read");
  assert.deepEqual({ ...home.boards[0], updatedAt: null }, { repositoryId: REPOSITORY, readiness: "ready", counts: [2, 0, 0, 0, 0], openFeatures: 0, queue: EMPTY_QUEUE, updatedAt: null });
  assert.match(home.boards[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(home.attention, [{ repositoryId: REPOSITORY, taskId: "T-1", title: "Write the release notes", state: "needs_review" }]);
  assert.equal(store.readHome().boards.length, 1);

  store.close();
  assert.equal(store.readHome(), null, "a closed store answers no home");
});

function send(port, { method = "GET", path: requestPath = HOME_PATH, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON bodies stay text */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function startRoute(context, taskStore, authorizationToken = "") {
  const touched = [];
  const runtime = new Proxy({}, { get(_object, property) { touched.push(String(property)); return undefined; } });
  const server = http.createServer(createRequestHandler({ runtime, taskStore, authorizationToken }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, touched };
}

const storedHome = () => ({
  boards: [
    { repositoryId: REPOSITORY, readiness: "ready", counts: [1, 0, 0, 1, 0], openFeatures: 1, queue: { status: "paused", blockedBy: "T-2", pauseReason: "start_failed", order: ["T-9"] }, updatedAt: "2026-10-08T10:00:00.000Z", privatePath: "C:\\SECRET" },
    { repositoryId: "not-a-repository", readiness: "ready", counts: [0, 0, 0, 0, 0], openFeatures: 0, queue: EMPTY_QUEUE, updatedAt: null },
    { repositoryId: OTHER_REPOSITORY, readiness: "ready", counts: [1, 2], openFeatures: 0, queue: EMPTY_QUEUE, updatedAt: null },
  ],
  attention: [
    { repositoryId: REPOSITORY, taskId: "T-1", title: "Write the release notes", state: "needs_review", text: "SECRET-TEXT" },
    { repositoryId: REPOSITORY, taskId: "T-2", title: "x".repeat(161), state: "stalled" },
    { repositoryId: REPOSITORY, taskId: "T-3", title: "Queued", state: "queued" },
  ],
  attentionTotal: 3,
});

test("a same-computer GET serves the home, no-store, through readHome only, with only the contract keys", async (context) => {
  const calls = [];
  const { port, touched } = await startRoute(context, { readHome() { calls.push("readHome"); return storedHome(); }, readBoard() { calls.push("readBoard"); return null; } });
  const response = await send(port);
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, {
    version: 1, readiness: "ready",
    boards: [
      { repositoryId: REPOSITORY, readiness: "ready", counts: [1, 0, 0, 1, 0], openFeatures: 1, queue: { status: "paused", blockedBy: "T-2", pauseReason: "start_failed" }, updatedAt: "2026-10-08T10:00:00.000Z" },
      { repositoryId: OTHER_REPOSITORY, readiness: "unavailable", counts: [], openFeatures: 0, queue: EMPTY_QUEUE, updatedAt: null },
    ],
    attention: [{ repositoryId: REPOSITORY, taskId: "T-1", title: "Write the release notes", state: "needs_review" }],
    attentionTotal: 3,
  });
  assert.ok(!response.text.includes("SECRET"));
  assert.deepEqual(calls, ["readHome"]);
  assert.deepEqual(touched.filter((name) => name !== "resolveTaskGateFacts"), [], "the home reads no runtime state beyond the lazy session lookup");
});

test("a denied client gets a content-free desktop-only home and never reaches the store", async (context) => {
  const calls = [];
  const { port } = await startRoute(context, { readHome() { calls.push("readHome"); return storedHome(); } }, TOKEN);
  const denied = { version: 1, readiness: "desktop_only", boards: [], attention: [], attentionTotal: 0 };
  for (const headers of [{}, { "x-pomegr-desktop-authorization": "x".repeat(40) }, { "x-pomegr-desktop-authorization": TOKEN, origin: "http://evil.example" }, { "x-pomegr-desktop-authorization": TOKEN, host: "192.168.1.20:3003" }]) {
    const response = await send(port, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, denied);
  }
  assert.deepEqual(calls, []);
  assert.equal((await send(port, { headers: { "x-pomegr-desktop-authorization": TOKEN } })).json.readiness, "ready");
});

test("a bad query, a write, and a store that cannot answer never serve a ready home", async (context) => {
  const { port } = await startRoute(context, { readHome() { return null; } });
  assert.equal((await send(port, { path: `${HOME_PATH}&repositoryId=${REPOSITORY}` })).status, 400);
  assert.equal((await send(port, { path: `${HOME_PATH}&path=C%3A%5Csecret` })).status, 400);
  assert.equal((await send(port, { method: "POST" })).status, 405);
  const unavailable = await send(port);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.json, { version: 1, readiness: "unavailable", boards: [], attention: [], attentionTotal: 0 });
  // Any other `view` is not the home: it is an invalid board query.
  assert.equal((await send(port, { path: "/api/tasks?view=board" })).status, 400);
});
