import assert from "node:assert/strict";
import http, { Server } from "node:http";
import test from "node:test";
import { buildAgentChatMcpServer, CHAT_TASK_UNAVAILABLE, createChatTaskReader } from "../mcp/agent-chat-server.mjs";
import { servedAgentTask } from "../shared/task-agent-read.mjs";
import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import { createRequestHandler } from "../server/serving/request-handler.mjs";
import { OTHER_REPOSITORY, REPOSITORY, createTask, openTemporaryStore, startedTask } from "./server/tasks/queue-test-support.mjs";
import { chatHarness, finishTurn, repositoryId, otherRepositoryId, send, until } from "./helpers/agent-chat-harness.mjs";

const entry = (overrides = {}) => ({ id: "T-1", text: "Full task 🥑 ".repeat(180), ownCondition: "Review the documentation",
  completeWhen: ["pr_open", "user_validated"], provider: "codex", model: "gpt-6-sol", effort: "medium",
  feature: "Aril", column: "Done", state: "done", editable: false, runsAfter: ["T-2"], textCut: false,
  report: { attention: "Check the result", block_reason: "Waiting for review" }, ...overrides });
const unavailable = { content: [{ type: "text", text: CHAT_TASK_UNAVAILABLE }], isError: true };
const tool = (readTask) => buildAgentChatMcpServer({ query: async () => null, readTask })._registeredTools.get_task;

test("chat get_task reuses the complete T118 shape and adds only snapshot-shaped attention and block reason", async () => {
  const task = entry({ repositoryId: "REPOSITORY-SENTINEL", columnId: "COLUMN-SENTINEL", featureId: "FEATURE-SENTINEL",
    session: "SESSION-SENTINEL", image: "IMAGE-SENTINEL", path: "PATH-SENTINEL", token: "TOKEN-SENTINEL", dispatch: "DISPATCH-SENTINEL",
    featureDescription: "DESCRIPTION-SENTINEL", appVersion: "VERSION-SENTINEL",
    report: { ...entry().report, results: ["RESULT-SENTINEL"], at: "TIME-SENTINEL" } });
  const answer = await tool(async (id) => { assert.equal(id, "T-1"); return task; }).handler({ task_id: "T-1" });
  assert.deepEqual(answer.structuredContent, { ...servedAgentTask(task), report: entry().report });
  assert.equal(answer.structuredContent.text, task.text);
  assert.equal(answer.structuredContent.ownCondition, task.ownCondition);
  assert.equal(answer.structuredContent.textCut, false);
  assert.doesNotMatch(JSON.stringify(answer), /SENTINEL/u);
});

test("unknown, malformed, unavailable, mismatched and cut task answers all use the same fixed line", async () => {
  for (const answer of [null, {}, entry({ id: "T-2" }), entry({ text: "x".repeat(4001) }), entry({ textCut: true }),
    entry({ ownCondition: "x".repeat(501) }), entry({ provider: "unknown" }), entry({ report: { attention: "x".repeat(201), block_reason: null } }),
    entry({ report: { attention: "two\nlines", block_reason: null } })]) {
    assert.deepEqual(await tool(async () => answer).handler({ task_id: "T-1" }), unavailable);
  }
  assert.deepEqual(await tool(async () => { throw new Error("PRIVATE-ERROR"); }).handler({ task_id: "T-1" }), unavailable);
  const reader = tool(async () => { assert.fail("invalid input must not read"); });
  for (const input of [{}, null, { task_id: "T-0" }, { task_id: "T-1", repositoryId: OTHER_REPOSITORY },
    { task_id: "T-1", path: "C:\\private" }, { task_id: "../T-1" }, { task_id: 1 }, { task_id: "T-1234567890" }]) {
    assert.deepEqual(await reader.handler(input), unavailable);
    assert.equal(reader.inputSchema.safeParse(input).success, false);
  }
});

test("the desktop-only monitor read keeps T118's exact projection and binding, and never calls the mutating board read", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-chat-task-");
  createTask(store, REPOSITORY, { text: "Full task ".repeat(300), completeWhen: { checks: ["user_validated"], own: "Check the screen" } });
  startedTask(directory, 1, { session: "codex:synthetic-chat-task" });
  assert.equal(store.completeTask({ sessionId: "codex:synthetic-chat-task", attention: "Look at this" }, () => null).ok, true);
  createTask(store, OTHER_REPOSITORY, { text: "OTHER-BOARD" });
  createTask(store, OTHER_REPOSITORY, { text: "OTHER-BOARD-ONLY" });
  const token = "d".repeat(40);
  const agentToken = "a".repeat(40);
  const server = http.createServer(createRequestHandler({ runtime: {}, authorizationToken: token, agentAuthorizationToken: agentToken,
    taskStore: { readAgentTasks: store.readAgentTasks, readBoard: () => assert.fail("readBoard can seed columns and must not run") } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/internal/agent-chat/task`;
  const read = (query, init = {}) => fetch(`${url}?${query}`, { headers: { [DESKTOP_AUTH_HEADER]: token }, ...init });
  const response = await read(`repositoryId=${REPOSITORY}&taskId=T-1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.deepEqual(result.task, { ...servedAgentTask(store.readAgentTasks(REPOSITORY)[0]), report: { attention: "Look at this", block_reason: null } });
  const unknown = await (await read(`repositoryId=${REPOSITORY}&taskId=T-99`)).json();
  assert.deepEqual(await (await read(`repositoryId=${REPOSITORY}&taskId=T-2`)).json(), unknown);
  assert.equal(unknown.reason, "not_found");
  for (const headers of [{}, { "x-pomegr-agent-authorization": agentToken }, { [DESKTOP_AUTH_HEADER]: token, origin: "http://localhost" }]) {
    assert.equal((await read(`repositoryId=${REPOSITORY}&taskId=T-1`, { headers })).status, 401);
  }
  assert.equal((await read(`repositoryId=${REPOSITORY}&taskId=T-1`, { method: "POST" })).status, 405);
  for (const query of [`repositoryId=${REPOSITORY}&taskId=T-0`, `repositoryId=${REPOSITORY}&taskId=T-1&taskId=T-2`,
    `repositoryId=${REPOSITORY}&taskId=T-1&path=x`, "repositoryId=bad&taskId=T-1"]) {
    assert.equal((await read(query)).status, 400);
  }
});

test("a turn capability reads only its repository, cannot proxy other operations, and is revoked on finish", async (context) => {
  const h = await chatHarness(context);
  h.state.actions = (_action, _payload, _body, call) => {
    assert.equal(call.pathname, "/internal/agent-chat/task");
    assert.equal(call.init.method, "GET");
    assert.deepEqual(call.query, { repositoryId, taskId: "T-1" });
    return { ok: true, task: entry() };
  };
  const first = await send(h, { provider: "codex" });
  const env = h.runs[0].options.mcpServer.env;
  const read = createChatTaskReader(env);
  assert.deepEqual(await read("T-1"), entry());
  assert.equal(h.runs[0].options.env.POMEGR_CHAT_TASK_KEY, undefined);
  assert.equal(h.runs[0].options.prompt.includes(env.POMEGR_CHAT_TASK_KEY), false);
  const before = h.calls.length;
  const headers = { "x-pomegr-chat-task-key": env.POMEGR_CHAT_TASK_KEY };
  for (const [suffix, init] of [["/task?task_id=T-1&repositoryId=other", {}], ["/task?task_id=T-1", { method: "POST" }],
    ["/task?task_id=T-1", { headers: { "x-pomegr-chat-task-key": "wrong" } }], ["/other?task_id=T-1", {}],
    ["/task?task_id=T-1", { headers: { ...headers, origin: "http://localhost" } }]]) {
    assert.equal((await fetch(`${env.POMEGR_CHAT_TASK_ORIGIN}${suffix}`, { headers, ...init })).status, 403);
  }
  assert.equal(h.calls.length, before);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done reading" }, first.conversationId);
  await assert.rejects(() => read("T-1"));
  h.state.board.repositoryId = otherRepositoryId;
  const second = await send(h, { repositoryId: otherRepositoryId, provider: "codex" });
  const next = h.runs[1].options.mcpServer.env;
  assert.notEqual(next.POMEGR_CHAT_TASK_KEY, env.POMEGR_CHAT_TASK_KEY);
  await h.handle("stop", { repositoryId: otherRepositoryId, conversationId: second.conversationId });
  h.chat.dispose();
  await assert.rejects(() => createChatTaskReader(next)("T-1"));
});

test("task transport refuses missing capabilities and bounds streamed answers without splitting UTF-8", async () => {
  assert.equal(await createChatTaskReader({}, () => assert.fail("no capability"))("T-1"), null);
  const env = { POMEGR_CHAT_TASK_ORIGIN: "http://127.0.0.1:4317", POMEGR_CHAT_TASK_KEY: "a".repeat(43) };
  const text = Buffer.from(JSON.stringify({ ok: true, task: entry() }));
  const read = createChatTaskReader(env, async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of text) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } })));
  assert.deepEqual(await read("T-1"), entry());
  assert.equal(await createChatTaskReader(env, async () => new Response("x".repeat(32769)))("T-1"), null);
});

test("Stop during bridge startup prevents the provider run and releases the turn", async (context) => {
  const listen = Server.prototype.listen;
  let resume;
  context.mock.method(Server.prototype, "listen", function (...args) { resume = () => listen.apply(this, args); return this; });
  const h = await chatHarness(context);
  const sending = send(h, { provider: "codex" });
  await until(() => resume);
  const { running } = await h.handle("list", { repositoryId });
  assert.equal((await h.handle("stop", { repositoryId, conversationId: running })).ok, true);
  resume();
  assert.deepEqual(await sending, { ok: false, error: "unavailable" });
  assert.equal(h.runs.length, 0);
  assert.equal((await h.handle("list", { repositoryId })).running, null);
});
