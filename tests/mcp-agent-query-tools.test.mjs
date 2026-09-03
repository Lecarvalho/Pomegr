import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPomegrMcpServer } from "../mcp/server.mjs";
import { AGENT_QUERY_TOOLS } from "../mcp/agent-query-tools.mjs";
import { buildPomegrMcpServer as buildClaudePomegrMcpServer } from "../plugins/claude-code/mcp/server.mjs";
import { AGENT_QUERY_AUTH_HEADER, publishAgentQueryDescriptor } from "../shared/agent-query-transport.mjs";

const readNames = Object.keys(AGENT_QUERY_TOOLS).sort();

test("both MCP entrypoints register the six read tools with read-only metadata and guidance", () => {
  for (const build of [buildPomegrMcpServer, buildClaudePomegrMcpServer]) {
    const server = build();
    assert.match(server.server._instructions, /only when their result could materially change the next decision/i);
    assert.match(server.server._instructions, /do not poll routinely/i);
    assert.match(server.server._instructions, /coincident.*causation|causation/i);
    assert.deepEqual(Object.keys(server._registeredTools).filter((name) => readNames.includes(name)).sort(), readNames);
    for (const name of readNames) {
      const tool = server._registeredTools[name];
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      assert.match(tool.description, /decision-triggered/i);
      assert.match(tool.description, /do not poll/i);
      assert.ok(tool.outputSchema);
    }
  }
});

test("agent queries pass exact selectors and return structured content plus bounded text", async () => {
  const calls = [];
  const server = buildPomegrMcpServer({
    query: async (path, params) => {
      calls.push({ path, params });
      if (path.endsWith("/agents")) {
        return {
          schemaVersion: 1, readiness: "ready", observedAt: "2026-09-03T12:00:00.000Z",
          generatedAt: "2026-09-03T12:00:00.000Z", revision: 1, sessionRef: "claude:one", agents: [],
        };
      }
      return {
        schemaVersion: 1, readiness: "ready", observedAt: "2026-09-03T12:00:00.000Z",
        generatedAt: "2026-09-03T12:00:00.000Z", revision: 1, truncated: false,
        sessions: [{ sessionRef: "claude:one", provider: "claude", title: "One", project: "Pomegr", state: "live", activityStatus: "working", createdAt: null, updatedAt: "2026-09-03T12:00:00.000Z" }],
      };
    },
  });
  const response = await server._registeredTools.list_sessions.handler({});
  assert.equal(response.structuredContent.schemaVersion, 1);
  assert.equal(response.structuredContent.readiness, "ready");
  assert.match(response.content[0].text, /list_sessions/);
  assert.deepEqual(calls, [{ path: "/api/agent/v1/sessions", params: { provider: undefined, scope: "live", limit: 20 } }]);

  await server._registeredTools.list_session_agents.handler({ session_ref: "claude:one" });
  assert.equal(calls.at(-1).path, "/api/agent/v1/sessions/claude%3Aone/agents");
});

test("transport failures become an unavailable observation and do not become MCP errors", async () => {
  const server = buildClaudePomegrMcpServer({ query: async () => { throw new Error("private transport detail"); } });
  const response = await server._registeredTools.get_usage_limits.handler({ provider: "claude" });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, {
    schemaVersion: 1,
    readiness: "unavailable",
    observedAt: null,
    generatedAt: null,
    revision: null,
    reason: "monitor_unavailable",
  });
  assert.doesNotMatch(response.content[0].text, /private transport detail/);
});

test("malformed monitor observations are MCP errors and never expose payload text", async () => {
  const server = buildPomegrMcpServer({ query: async () => "not-json" });
  const response = await server._registeredTools.get_provider_health.handler({});
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /malformed observation/);
  assert.doesNotMatch(response.content[0].text, /not-json/);
});

test("closed-world response validation rejects unexpected private fields", async () => {
  const server = buildPomegrMcpServer({ query: async () => ({
    schemaVersion: 1, readiness: "ready", observedAt: null, generatedAt: null, revision: 1,
    providers: [], prompt: "PROMPT_SENTINEL",
  }) });
  const response = await server._registeredTools.get_provider_health.handler({});
  assert.equal(response.isError, true);
  assert.doesNotMatch(response.content[0].text, /PROMPT_SENTINEL/u);
});

test("the default MCP reader reaches a running packaged-style monitor through its descriptor capability", async (t) => {
  const token = "A".repeat(43);
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-mcp-query-"));
  let observedHeader = null;
  const monitor = http.createServer((request, response) => {
    observedHeader = request.headers[AGENT_QUERY_AUTH_HEADER];
    response.writeHead(observedHeader === token ? 200 : 401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 1, readiness: "ready", observedAt: "2026-09-03T12:00:00.000Z",
      generatedAt: "2026-09-03T12:00:00.000Z", revision: 3, providers: [],
    }));
  });
  await new Promise((resolve) => monitor.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => { monitor.closeAllConnections(); monitor.close(resolve); });
    await rm(root, { recursive: true, force: true });
  });
  await publishAgentQueryDescriptor({ dataRoot: root, origin: `http://127.0.0.1:${monitor.address().port}`, token });
  const server = buildPomegrMcpServer({ dataRoot: root });
  const result = await server._registeredTools.get_provider_health.handler({});
  assert.equal(result.structuredContent.revision, 3);
  assert.equal(observedHeader, token);
});
