import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildPomegrMcpServer } from "../mcp/server.mjs";
import { TASK_COMPLETE_PATH, TASK_REPORT_UNBOUND_TEXT } from "../mcp/task-tools.mjs";

const THREAD = "019a0000-2222-7333-8444-555566667777";

test("Codex task completion uses host metadata through the MCP transport", { timeout: 5000 }, async (t) => {
  const posts = [];
  const server = buildPomegrMcpServer({
    environment: {},
    taskPost: async (pathname, body) => {
      posts.push({ pathname, body });
      return { ok: true, state: "needs_review", results: [] };
    },
    query: async () => ({}),
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(() => server.close());
  let requestId = 0;
  const request = async (method, params) => {
    const id = ++requestId;
    const answer = new Promise((resolve) => {
      clientTransport.onmessage = (message) => { if (message.id === id) resolve(message); };
    });
    await clientTransport.send({ jsonrpc: "2.0", id, method, params });
    const response = await answer;
    assert.equal(response.error, undefined);
    return response.result;
  };
  await server.connect(serverTransport);
  await clientTransport.start();
  await request("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-codex", version: "1.0.0" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const completed = await request("tools/call", {
    name: "complete_task", arguments: {},
    _meta: { threadId: THREAD, "x-codex-turn-metadata": { thread_id: THREAD } },
  });
  assert.notEqual(completed.isError, true);
  assert.match(completed.content[0].text, /put it in Review/u);
  assert.deepEqual(posts, [{ pathname: TASK_COMPLETE_PATH, body: { sessionRef: `codex:${THREAD}` } }]);

  for (const metadata of [undefined, { threadId: "../invalid" }, {
    threadId: THREAD, "x-codex-turn-metadata": { thread_id: "different-thread" },
  }]) {
    const refused = await request("tools/call", {
      name: "complete_task", arguments: {}, ...(metadata ? { _meta: metadata } : {}),
    });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, TASK_REPORT_UNBOUND_TEXT);
  }
  assert.equal(posts.length, 1, "unbound calls never reach the monitor");
});
