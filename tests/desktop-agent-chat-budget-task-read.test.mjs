import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { BOARD_TEXT_BUDGET } from "../desktop/runtime/agent-chat-prompt.mjs";
import { buildAgentChatMcpServer } from "../mcp/agent-chat-server.mjs";
import { createRequestHandler } from "../server/serving/request-handler.mjs";
import { servedAgentTask } from "../shared/task-agent-read.mjs";
import { chatHarness, finishTurn, repositoryId, send } from "./helpers/agent-chat-harness.mjs";
import { OTHER_REPOSITORY, createTask, openTemporaryStore } from "./server/tasks/queue-test-support.mjs";

test("a budget-cut snapshot task reads whole through the existing repository-bound get_task without changing the board", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-chat-budget-read-");
  for (let id = 1; id <= 20; id += 1) {
    createTask(store, repositoryId, {
      text: `Task ${id} title\n` + "🥑".repeat(1900) + " FULL-TEXT-TAIL",
      completeWhen: { checks: ["pr_open"], own: `Condition for task ${id}` },
    });
  }
  createTask(store, OTHER_REPOSITORY, { text: "OTHER-BOARD-PRIVATE" });
  const board = store.readBoard(repositoryId);
  const h = await chatHarness(context);
  h.state.board = board;
  const server = http.createServer(createRequestHandler({
    runtime: {}, authorizationToken: "synthetic-budget-monitor-token-123456",
    taskStore: { readAgentTasks: store.readAgentTasks, readBoard: () => assert.fail("task read must not seed or change the board") },
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const monitorOrigin = `http://127.0.0.1:${server.address().port}`;
  h.state.actions = async (_action, _payload, _body, call) => {
    assert.equal(call.pathname, "/internal/agent-chat/task");
    assert.equal(call.init.method, "GET");
    assert.deepEqual(call.query, { repositoryId, taskId: "T-20" });
    const response = await fetch(`${monitorOrigin}${call.pathname}${call.search}`, {
      headers: { "x-pomegr-desktop-authorization": "synthetic-budget-monitor-token-123456" },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const before = await readFile(path.join(directory, "tasks.sqlite"));
  const sent = await send(h, { provider: "codex" });
  assert.equal(sent.ok, true);
  const prompt = h.runs[0].options.prompt;
  const snapshot = JSON.parse(prompt.split("<board_snapshot>\n")[1].split("\n</board_snapshot>")[0]);
  const cut = snapshot.tasks.find((task) => task.id === "T-20");
  const original = board.tasks.find((task) => task.id === cut.id);
  assert.equal(cut.text_cut, true);
  assert.equal(cut.text.startsWith("Task 20 title"), true);
  assert.equal(cut.text.includes("FULL-TEXT-TAIL"), false);
  assert.deepEqual(snapshot.task_text, { cut: snapshot.tasks.filter((task) => task.text_cut).length, total: 20 });
  assert.ok(snapshot.tasks.reduce((sum, task) => sum + task.text.length, 0) <= BOARD_TEXT_BUDGET);
  assert.match(prompt, /Use get_task with a task ID to read its whole text and conditions on this board when a task you need has text_cut; do not guess from its preview/u);
  const mcp = buildAgentChatMcpServer({ environment: h.runs[0].options.mcpServer.env, query: async () => null });
  const answer = await mcp._registeredTools.get_task.handler({ task_id: cut.id });
  assert.equal(answer.isError, undefined);
  assert.deepEqual(answer.structuredContent, {
    ...servedAgentTask(store.readAgentTasks(repositoryId).find((task) => task.id === cut.id)),
    report: { block_reason: null, attention: null },
  });
  assert.equal(answer.structuredContent.text, original.text);
  assert.equal(answer.structuredContent.textCut, false);
  assert.equal(answer.structuredContent.ownCondition, "Condition for task 20");
  assert.equal(answer.structuredContent.text.endsWith("FULL-TEXT-TAIL"), true);
  assert.deepEqual(store.readBoard(repositoryId), board);
  assert.deepEqual(await readFile(path.join(directory, "tasks.sqlite")), before);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Read the complete task." }, sent.conversationId);
});
