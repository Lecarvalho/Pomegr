import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { createIssueReader } from "../../../server/repository/issues.mjs";
import { createTaskIssues } from "../../../server/runtime/task-issues.mjs";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_ACTIONS as ROUTE_ACTIONS } from "../../../server/serving/task-routes.mjs";
import { TASK_ACTIONS } from "../../../server/tasks/task-record.mjs";
import { OTHER_REPOSITORY, REPOSITORY, metaValue, openTemporaryStore } from "./queue-test-support.mjs";

const ROOT = "C:/Work/SECRET-ROOT/repo";
const TOKEN = "c".repeat(40);
const withToken = { "x-pomegr-desktop-authorization": TOKEN };
const JSON_BODY = { "content-type": "application/json" };
const SECRET_TEXT = "SECRET-FIRST-LINE\n\nSECRET-BODY with $(whoami) and \"quotes\"";
const FAILURES = ["cli_missing", "not_signed_in", "no_access", "issues_disabled", "failed"];

/** A fake reader over the create call only; every call is logged and nothing runs `gh`. */
function fakeReader({ answer = { status: "ok", number: 77 }, gate = null } = {}) {
  const calls = [];
  const reader = {
    async connection() { calls.push(["connection"]); return "connected"; },
    async repositoryAccess() { calls.push(["repositoryAccess"]); return { visibility: "public", capabilities: ["read_issues", "create_issues"] }; },
    async listOpenIssues() { calls.push(["listOpenIssues"]); return { status: "ok", issues: [], truncated: false }; },
    async readIssue() { calls.push(["readIssue"]); return { status: "not_found", issue: null }; },
    async createIssue(root, input) {
      calls.push(["createIssue", root, input]);
      if (gate) await gate.promise;
      return typeof answer === "function" ? answer(input) : answer;
    },
  };
  return { reader, calls };
}

async function setup(context, { reader, store: given = null, roots = { [REPOSITORY]: ROOT } } = {}) {
  const store = given ?? (await openTemporaryStore(context, "pomegr-task-issue-create-")).store;
  const taskIssues = createTaskIssues({ repositoryRoot: (id) => roots[id] ?? null, reader });
  const runtime = { taskIssues, serveSessionDirectory: () => ({ revision: 1, sessions: [] }), observationActive: () => false };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { store, port: server.address().port };
}

function send(port, { path: requestPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: requestPath, headers, agent: false }, (response) => {
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

const create = (port, payload, repositoryId = REPOSITORY, name = "issue-create") => send(port, {
  path: `/internal/tasks/${name}`, headers: { ...withToken, ...JSON_BODY }, body: JSON.stringify({ repositoryId, payload }),
});
const addTask = (store, text = SECRET_TEXT, repositoryId = REPOSITORY) => {
  const result = store.apply(repositoryId, "create", { text });
  assert.equal(result.ok, true);
  return result.taskId;
};
const refusal = (response, status, error) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { ok: false, error });
};

test("create answers the new task's ID, and only create does", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-task-issue-create-");
  assert.equal(store.apply(REPOSITORY, "create", { text: "one" }).taskId, "T-1");
  assert.equal(store.apply(REPOSITORY, "create", { text: "two" }).taskId, "T-2");
  assert.equal("taskId" in store.apply(REPOSITORY, "update", { id: "T-1", text: "changed" }), false);
  assert.equal("taskId" in store.apply(REPOSITORY, "delete", { id: "T-2" }), false);
  assert.equal("taskId" in store.apply(REPOSITORY, "create", { text: "" }), false);
});

test("issueDraft is a committed read of the saved text and whether a source exists", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-task-issue-create-");
  const id = addTask(store, "Saved text");
  assert.deepEqual(store.issueDraft(REPOSITORY, id), { text: "Saved text", hasSource: false });
  assert.equal(store.apply(REPOSITORY, "record_issue", { id, number: 5 }).ok, true);
  assert.deepEqual(store.issueDraft(REPOSITORY, id), { text: "Saved text", hasSource: true });
  for (const [repository, task] of [[REPOSITORY, "T-99"], [OTHER_REPOSITORY, id], ["bad", id], [REPOSITORY, "t-1"], [REPOSITORY, 1], [REPOSITORY, undefined]]) {
    assert.equal(store.issueDraft(repository, task), null);
  }
  store.close();
  assert.equal(store.issueDraft(REPOSITORY, id), null);
});

test("record_issue writes the source of an existing task, like a promote", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-issue-create-");
  const id = addTask(store, "plain");
  assert.equal(store.readBoard(REPOSITORY).tasks[0].source, null);
  const recorded = store.apply(REPOSITORY, "record_issue", { id, number: 31 });
  assert.equal(recorded.ok, true);
  assert.deepEqual(recorded.board.tasks[0].source, { kind: "github_issue", number: 31 });
  assert.equal("taskId" in recorded, false);
  assert.deepEqual(store.readBoard(REPOSITORY).tasks[0].source, { kind: "github_issue", number: 31 });
  assert.equal(metaValue(directory, `task_source:${REPOSITORY}:${id}`), "31");
  assert.equal(store.promotedIssues(REPOSITORY).get(31), id);
});

test("record_issue refuses a missing task, a task with a source, and an issue another task holds", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-issue-create-");
  const first = addTask(store, "first");
  const second = addTask(store, "second");
  assert.deepEqual(store.apply(REPOSITORY, "record_issue", { id: "T-9", number: 1 }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "record_issue", { id: first, number: 1 }), { ok: false, error: "not_found" });
  assert.equal(store.apply(REPOSITORY, "record_issue", { id: first, number: 10 }).ok, true);
  assert.deepEqual(store.apply(REPOSITORY, "record_issue", { id: first, number: 11 }), { ok: false, error: "conflict" });
  assert.deepEqual(store.apply(REPOSITORY, "record_issue", { id: second, number: 10 }), { ok: false, error: "conflict" });
  assert.equal(metaValue(directory, `task_source:${REPOSITORY}:${first}`), "10");
  assert.equal(metaValue(directory, `task_source:${REPOSITORY}:${second}`), null);
  assert.equal(store.apply(REPOSITORY, "record_issue", { id: second, number: 12 }).ok, true);
});

test("record_issue validates its payload, and a promoted task is never recorded again", async (context) => {
  const { store } = await openTemporaryStore(context, "pomegr-task-issue-create-");
  const id = addTask(store, "x");
  for (const payload of [undefined, null, [], {}, { id }, { number: 1 }, { id, number: 0 }, { id, number: -1 }, { id, number: 1.5 }, { id, number: "1" },
    { id, number: 1_000_000_000 }, { id: "t-1", number: 1 }, { id: "T-0", number: 1 }, { id: 1, number: 1 }, { id, number: 1, extra: true }, { id, number: 1, text: "FORGED" }]) {
    assert.deepEqual(store.apply(REPOSITORY, "record_issue", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  }
  assert.equal(store.readBoard(REPOSITORY).tasks[0].source, null);
  const promoted = store.apply(REPOSITORY, "promote_issue", { number: 3, title: "Promoted", body: "" });
  assert.deepEqual(store.apply(REPOSITORY, "record_issue", { id: promoted.taskId, number: 4 }), { ok: false, error: "conflict" });
});

test("record_issue is not reachable through the task-action route, the action lists, or the desktop", async (context) => {
  assert.equal(TASK_ACTIONS.includes("record_issue"), false);
  assert.equal(ROUTE_ACTIONS.includes("record_issue"), false);
  const { reader, calls } = fakeReader();
  const { store, port } = await setup(context, { reader });
  const id = addTask(store, "plain");
  for (const name of ["record_issue", "record-issue", "issue_create", "create-issue"]) {
    const response = await create(port, { id, number: 9 }, REPOSITORY, name);
    assert.ok([400, 404, 501].includes(response.status), name);
    assert.equal(response.json?.ok, false);
  }
  assert.equal(store.readBoard(REPOSITORY).tasks[0].source, null);
  assert.deepEqual(calls, []);
  const desktop = await readFile(new URL("../../../desktop/runtime/task-action.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(desktop, /record_issue|issue-create|issue_create/u);
  const preload = await readFile(new URL("../../../desktop/runtime/preload.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(preload, /record_issue/u);
});

test("issue-create sends the saved text once through the reader, records the number, and answers only it", async (context) => {
  const { reader, calls } = fakeReader({ answer: { status: "ok", number: 77 } });
  const { store, port } = await setup(context, { reader });
  const id = addTask(store);
  const response = await create(port, { taskId: id });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json, { ok: true, number: 77 });
  assert.ok(!response.text.includes("SECRET"));
  assert.deepEqual(calls, [["createIssue", ROOT, { title: "SECRET-FIRST-LINE", body: SECRET_TEXT }]]);
  assert.deepEqual(store.readBoard(REPOSITORY).tasks[0].source, { kind: "github_issue", number: 77 });
  assert.equal(store.readBoard(REPOSITORY).tasks[0].text, SECRET_TEXT);
  // The same task is a conflict from then on, and GitHub is not asked again.
  refusal(await create(port, { taskId: id }), 409, "conflict");
  assert.equal(calls.length, 1);
});

test("every GitHub failure answers 502 with the fixed error and leaves the task untouched", async (context) => {
  for (const status of FAILURES) {
    const { reader, calls } = fakeReader({ answer: { status, number: null } });
    const { store, port } = await setup(context, { reader });
    const id = addTask(store);
    const before = JSON.stringify(store.readBoard(REPOSITORY));
    const response = await create(port, { taskId: id });
    refusal(response, 502, status);
    assert.ok(!response.text.includes("SECRET"));
    assert.equal(JSON.stringify(store.readBoard(REPOSITORY)), before, status);
    assert.equal(store.readBoard(REPOSITORY).tasks[0].source, null);
    assert.equal(calls.length, 1);
    // The in-flight key is released: the task can be created again.
    refusal(await create(port, { taskId: id }), 502, status);
    assert.equal(calls.length, 2);
  }
});

test("an unexpected reader status, an invalid number, or a throwing reader is a fixed failure and writes nothing", async (context) => {
  for (const [answer, status, error] of [
    [{ status: "teapot", number: null }, 502, "failed"],
    [{ status: "ok", number: 0 }, 502, "failed"],
    [{ status: "ok", number: 1.5 }, 502, "failed"],
    [{ status: "unavailable", number: null }, 503, "unavailable"],
  ]) {
    const { reader } = fakeReader({ answer });
    const { store, port } = await setup(context, { reader });
    const id = addTask(store);
    refusal(await create(port, { taskId: id }), status, error);
    assert.equal(store.readBoard(REPOSITORY).tasks[0].source, null);
  }
  const { reader } = fakeReader();
  const boom = { ...reader, async createIssue() { throw new Error("C:/secret/gh"); } };
  const { store, port } = await setup(context, { reader: boom });
  const id = addTask(store);
  const thrown = await create(port, { taskId: id });
  refusal(thrown, 503, "unavailable");
  assert.ok(!thrown.text.includes("secret"));
  assert.equal(store.readBoard(REPOSITORY).tasks[0].source, null);
  refusal(await create(port, { taskId: id }), 503, "unavailable");
});

test("a record that fails after GitHub accepted the issue answers failed and the task stays without a source", async (context) => {
  const { reader } = fakeReader({ answer: { status: "ok", number: 5 } });
  const { store } = await setup(context, { reader });
  const id = addTask(store);
  const failing = { ...store, apply: (repositoryId, action, payload, ...rest) => (action === "record_issue"
    ? { ok: false, error: "conflict" } : store.apply(repositoryId, action, payload, ...rest)) };
  const { port } = await setup(context, { reader, store: failing });
  refusal(await create(port, { taskId: id }), 502, "failed");
  assert.equal(store.readBoard(REPOSITORY).tasks[0].source, null);
});

test("a missing task is not_found and a task with a source is a conflict, both without asking GitHub", async (context) => {
  const { reader, calls } = fakeReader();
  const { store, port } = await setup(context, { reader });
  refusal(await create(port, { taskId: "T-5" }), 404, "not_found");
  const other = addTask(store, "elsewhere", OTHER_REPOSITORY);
  refusal(await create(port, { taskId: other }), 404, "not_found");
  const promoted = store.apply(REPOSITORY, "promote_issue", { number: 8, title: "Promoted", body: "" }).taskId;
  refusal(await create(port, { taskId: promoted }), 409, "conflict");
  assert.deepEqual(calls, []);
  assert.deepEqual(store.readBoard(REPOSITORY).tasks[0].source, { kind: "github_issue", number: 8 });
});

test("a text without a title fails before GitHub is asked", async (context) => {
  const { reader, calls } = fakeReader();
  const { store, port } = await setup(context, { reader });
  const id = addTask(store, "a task");
  // The store never saves such a text; a draft that is all control characters must still end in a fixed failure.
  const untitled = { ...store, issueDraft: () => ({ text: "\u0007\u0001\n\u0000", hasSource: false }) };
  const { port: untitledPort } = await setup(context, { reader, store: untitled });
  refusal(await create(untitledPort, { taskId: id }), 502, "failed");
  assert.deepEqual(calls, []);
  assert.equal(store.readBoard(REPOSITORY).tasks[0].source, null);
  assert.ok(port > 0);
});

test("a create already in flight for the same task is a conflict; another task and a retry are not", async (context) => {
  let release;
  const gate = { promise: new Promise((resolve) => { release = resolve; }) };
  const { reader, calls } = fakeReader({ gate });
  const { store, port } = await setup(context, { reader });
  const first = addTask(store, "first task");
  const second = addTask(store, "second task");
  const pending = create(port, { taskId: first });
  while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  refusal(await create(port, { taskId: first }), 409, "conflict");
  assert.equal(calls.length, 1);
  release();
  assert.deepEqual((await pending).json, { ok: true, number: 77 });
  // The second task has its own key; issue 77 is now held by the first task, so recording it is refused.
  refusal(await create(port, { taskId: second }), 502, "failed");
  assert.equal(calls.length, 2);
  assert.equal(store.readBoard(REPOSITORY).tasks[1].source, null);
});

test("the route needs the desktop token and refuses bad envelopes and payloads before any read", async (context) => {
  const { reader, calls } = fakeReader();
  const { store, port } = await setup(context, { reader });
  const id = addTask(store);
  const body = JSON.stringify({ repositoryId: REPOSITORY, payload: { taskId: id } });
  for (const headers of [JSON_BODY, { ...JSON_BODY, "x-pomegr-desktop-authorization": "x".repeat(40) }, { ...withToken, ...JSON_BODY, origin: "http://evil.example" }]) {
    const denied = await send(port, { path: "/internal/tasks/issue-create", headers, body });
    assert.equal(denied.status, 401);
    assert.equal(denied.text, "Unauthorized");
  }
  for (const payload of [{}, { taskId: id, extra: 1 }, { taskId: id, text: "FORGED" }, { taskId: id, title: "FORGED", body: "FORGED" }, { taskId: "t-1" }, { taskId: "T-0" },
    { taskId: "T-1234567890" }, { taskId: 1 }, { taskId: null }, { number: 1 }, { id }]) {
    refusal(await create(port, payload), 400, "invalid");
  }
  refusal(await send(port, { path: "/internal/tasks/issue-create", headers: { ...withToken, ...JSON_BODY }, body: JSON.stringify({ repositoryId: "bad", payload: { taskId: id } }) }), 400, "invalid");
  refusal(await send(port, { path: "/internal/tasks/issue-create?x=1", headers: { ...withToken, ...JSON_BODY }, body }), 400, "invalid");
  assert.deepEqual(calls, []);
  assert.equal(store.readBoard(REPOSITORY).tasks[0].source, null);
});

test("an unknown repository root, and a store or composition without the read, are unavailable", async (context) => {
  const { reader, calls } = fakeReader();
  const { store, port } = await setup(context, { reader, roots: {} });
  const id = addTask(store);
  refusal(await create(port, { taskId: id }), 503, "unavailable");
  assert.deepEqual(calls, []);
  const bare = http.createServer(createRequestHandler({ runtime: {}, taskStore: { apply() {}, promotedIssues: () => new Map(), close() {} }, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => bare.close(resolve)));
  await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
  refusal(await create(bare.address().port, { taskId: "T-1" }), 503, "unavailable");
});

test("the real reader sends the saved text on standard input and never as an argument", async (context) => {
  const seen = [];
  const execFile = (file, args, options, callback) => {
    const call = { file, args, stdin: null };
    seen.push(call);
    const answer = args[0] === "repo" ? { nameWithOwner: "acme/widgets", visibility: "PUBLIC", hasIssuesEnabled: true, viewerPermission: "ADMIN" } : { number: 12 };
    setImmediate(() => callback(null, JSON.stringify(answer), ""));
    return { stdin: { on() {}, end(text) { call.stdin = text; } } };
  };
  const { store, port } = await setup(context, { reader: createIssueReader({ execFile }) });
  const id = addTask(store);
  assert.deepEqual((await create(port, { taskId: id })).json, { ok: true, number: 12 });
  // The repository is resolved first, and the write names exactly that repository.
  assert.equal(seen.length, 2);
  assert.equal(seen[0].args[0], "repo");
  assert.equal(seen[0].stdin, null);
  assert.deepEqual(seen[1].args, ["api", "--method", "POST", "repos/acme/widgets/issues", "--input", "-"]);
  assert.ok(!JSON.stringify(seen.map((call) => call.args)).includes("SECRET"));
  assert.deepEqual(JSON.parse(seen[1].stdin), { title: "SECRET-FIRST-LINE", body: SECRET_TEXT });
  assert.deepEqual(store.readBoard(REPOSITORY).tasks[0].source, { kind: "github_issue", number: 12 });
});
