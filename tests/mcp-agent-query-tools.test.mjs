import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPomegrMcpServer } from "../mcp/server.mjs";
import { AGENT_QUERY_TOOLS, resolveCurrentSessionRef } from "../mcp/agent-query-tools.mjs";
import { buildPomegrMcpServer as buildClaudePomegrMcpServer } from "../plugins/claude-code/mcp/server.mjs";
import { AGENT_QUERY_AUTH_HEADER, publishAgentQueryDescriptor } from "../shared/agent-query-transport.mjs";

const readNames = Object.keys(AGENT_QUERY_TOOLS).sort();

test("both MCP entrypoints register the seven read tools with read-only metadata and guidance", () => {
  for (const build of [buildPomegrMcpServer, buildClaudePomegrMcpServer]) {
    const server = build();
    assert.match(server.server._instructions, /only when their result could materially change the next decision/i);
    assert.match(server.server._instructions, /do not poll routinely/i);
    assert.match(server.server._instructions, /configured local guard checkpoint.*local concurrency.*not a reason for repeated MCP polling/i);
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

test("current session references come only from one valid host identity", () => {
  assert.equal(resolveCurrentSessionRef({ CODEX_THREAD_ID: "thread-1", CODEX_SESSION_ID: "thread-1" }), "codex:thread-1");
  assert.equal(resolveCurrentSessionRef({ CLAUDE_CODE_SESSION_ID: "session-1" }), "claude:session-1");
  assert.equal(resolveCurrentSessionRef({}), null);
  assert.equal(resolveCurrentSessionRef({ CODEX_THREAD_ID: "thread-1", CODEX_SESSION_ID: "thread-2" }), null);
  assert.equal(resolveCurrentSessionRef({ CODEX_THREAD_ID: "thread-1", CLAUDE_CODE_SESSION_ID: "session-1" }), null);
  assert.equal(resolveCurrentSessionRef({ CODEX_THREAD_ID: "../private" }), null);
});

test("session-scoped tools default to the host session and primary agent without client IDs", async () => {
  const calls = [];
  const server = buildPomegrMcpServer({
    currentSessionRef: "codex:current-1",
    query: async (path, params) => {
      calls.push({ path, params });
      const base = { schemaVersion: 1, readiness: "ready", observedAt: "2026-09-03T12:00:00.000Z", generatedAt: "2026-09-03T12:00:00.000Z", revision: 4, sessionRef: "codex:current-1" };
      if (path.endsWith("/report")) return { ...base, format: "markdown", filename: "pomegr-current-2026-09-03.md", report: "# Pomegr Session Observation Report\n\nCurrent." };
      if (path.endsWith("/context")) return { ...base, agentId: "primary", context: null, readiness: "unavailable", reason: "context_unavailable" };
      if (path.endsWith("/failures")) return { ...base, agentId: null, withinMinutes: 15, failures: [], retainedCoverage: { maximumWindowMinutes: 1440, maximumRetained: 256, oldestObservedAt: null, newestObservedAt: null, truncated: false } };
      return { ...base, agents: [] };
    },
  });
  const report = await server._registeredTools.get_session_report.handler({});
  assert.match(report.content[0].text, /^# Pomegr Session Observation Report/u);
  assert.equal(report.structuredContent.sessionRef, "codex:current-1");
  await server._registeredTools.get_agent_context.handler({});
  await server._registeredTools.get_recent_failures.handler({});
  await server._registeredTools.list_session_agents.handler({});
  assert.deepEqual(calls, [
    { path: "/api/agent/v1/sessions/codex%3Acurrent-1/report", params: {} },
    { path: "/api/agent/v1/sessions/codex%3Acurrent-1/agents/primary/context", params: {} },
    { path: "/api/agent/v1/sessions/codex%3Acurrent-1/failures", params: { agent_id: undefined, within_minutes: 15, limit: 10 } },
    { path: "/api/agent/v1/sessions/codex%3Acurrent-1/agents", params: {} },
  ]);
});

test("session-scoped tools fail closed when the host supplies no current identity", async () => {
  let called = false;
  const server = buildPomegrMcpServer({ currentSessionRef: null, query: async () => { called = true; return {}; } });
  const response = await server._registeredTools.get_session_report.handler({});
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.reason, "current_session_unavailable");
  assert.equal(called, false);
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

test("both MCP entrypoints preserve confirmed closed session observations", async () => {
  for (const build of [buildPomegrMcpServer, buildClaudePomegrMcpServer]) {
    const server = build({ query: async () => ({
      schemaVersion: 1, readiness: "ready", observedAt: null, generatedAt: null, revision: 1, truncated: false,
      sessions: [{ sessionRef: "claude:closed", provider: "claude", title: "Closed session", project: "Pomegr",
        state: "history", activityStatus: "closed", createdAt: null, updatedAt: null }],
    }) });
    const response = await server._registeredTools.list_sessions.handler({ scope: "all" });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.sessions[0].activityStatus, "closed");
  }
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

test("usage limits accept only bounded local concurrency evidence", async () => {
  const localActivity = {
    scope: "machine_provider", readiness: "ready", observedAt: "2026-09-03T12:00:00.000Z",
    liveSessions: 3, workingSessions: 2, unknownSessions: 1, truncated: false,
  };
  const server = buildPomegrMcpServer({ query: async () => ({
    schemaVersion: 1, readiness: "ready", observedAt: "2026-09-03T12:00:00.000Z",
    generatedAt: "2026-09-03T12:00:00.000Z", revision: 1,
    providers: [{
      provider: "codex", readiness: "ready", available: true, origin: "provider_api", freshness: "fresh",
      observedAt: "2026-09-03T12:00:00.000Z", attemptedAt: null, retryAt: null, failureCategory: null,
      localActivity, windows: [],
    }],
  }) });
  const response = await server._registeredTools.get_usage_limits.handler({ provider: "codex" });
  assert.deepEqual(response.structuredContent.providers[0].localActivity, localActivity);

  const malformed = buildPomegrMcpServer({ query: async () => ({
    schemaVersion: 1, readiness: "ready", observedAt: null, generatedAt: null, revision: 1,
    providers: [{
      provider: "codex", readiness: "ready", available: true, origin: "provider_api", freshness: "fresh",
      observedAt: null, attemptedAt: null, retryAt: null, failureCategory: null,
      localActivity: { ...localActivity, liveSessions: 10_001, privatePath: "PATH_SENTINEL" }, windows: [],
    }],
  }) });
  const invalid = await malformed._registeredTools.get_usage_limits.handler({ provider: "codex" });
  assert.equal(invalid.isError, true);
  assert.doesNotMatch(invalid.content[0].text, /PATH_SENTINEL/u);
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
