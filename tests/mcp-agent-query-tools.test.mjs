import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPomegrMcpServer } from "../mcp/server.mjs";
import { AGENT_QUERY_TOOLS, createAgentQueryHandler, resolveCurrentSessionRef } from "../mcp/agent-query-tools.mjs";
import { buildPomegrMcpServer as buildClaudePomegrMcpServer } from "../plugins/claude-code/mcp/server.mjs";
import { AGENT_QUERY_AUTH_HEADER, publishAgentQueryDescriptor } from "../shared/agent-query-transport.mjs";
import { bindClaudeQuerySession, runClaudeQuerySessionHook } from "../plugin-src/claude-query-session.mjs";
import { Readable } from "node:stream";

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
  assert.equal(resolveCurrentSessionRef({ CLAUDE_CODE_SESSION_ID: "session-1" }), null);
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

test("Claude default reports follow the current host transcript across /clear in one MCP process", async () => {
  const before = "11111111-1111-4111-8111-111111111111";
  const after = "22222222-2222-4222-8222-222222222222";
  const calls = [];
  const server = buildClaudePomegrMcpServer({
    environment: { CLAUDE_CODE_SESSION_ID: before },
    query: async (url) => {
      const sessionRef = decodeURIComponent(url.split("/").at(-2));
      calls.push(sessionRef);
      return {
        schemaVersion: 1, readiness: "ready", observedAt: null, generatedAt: null, revision: 1,
        sessionRef, format: "markdown", filename: "pomegr-session-2026-09-09.md", report: "# Current session report",
      };
    },
  });
  const report = server._registeredTools.get_session_report;
  for (const id of [before, after, before]) {
    const hook = bindClaudeQuerySession({
      hook_event_name: "PreToolUse", tool_name: "mcp__plugin_pomegr_pomegr__get_session_report",
      tool_input: {}, session_id: before, transcript_path: path.resolve("private", `${id}.jsonl`),
    });
    assert.equal(hook.hookSpecificOutput.permissionDecision, undefined);
    assert.deepEqual(hook.hookSpecificOutput.updatedInput, { session_ref: `claude:${id}` });
    const response = await report.handler(hook.hookSpecificOutput.updatedInput);
    assert.equal(response.structuredContent.sessionRef, `claude:${id}`);
  }
  assert.deepEqual(calls, [before, after, before].map((id) => `claude:${id}`));
  const missingHook = await report.handler({});
  assert.equal(missingHook.structuredContent.reason, "current_session_unavailable");
  assert.equal(calls.length, 3);
});

test("Claude query hook binds only recognized defaults and keeps explicit selectors and authorization intact", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
    for (const tool of ["get_session_report", "list_session_agents", "get_agent_context", "get_recent_failures"]) {
      const payload = { hook_event_name: "PreToolUse", tool_name: prefix + tool, tool_input: {},
        transcript_path: path.resolve("private", id, "subagents", "agent-child.jsonl") };
      assert.deepEqual(bindClaudeQuerySession(payload).hookSpecificOutput.updatedInput, { session_ref: `claude:${id}` });
      assert.equal(bindClaudeQuerySession({ ...payload, tool_input: { session_ref: "claude:explicit" } }), null);
      assert.equal(bindClaudeQuerySession({ ...payload, transcript_path: "private-path-sentinel" }), null);
      assert.equal(bindClaudeQuerySession({ ...payload, tool_name: prefix + tool + "_lookalike" }), null);
    }
  }
  const payload = { hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__get_recent_failures",
    tool_input: { agent_id: "primary", within_minutes: 10, limit: 2 }, transcript_path: path.resolve("private", `${id}.jsonl`) };
  assert.deepEqual(bindClaudeQuerySession(payload).hookSpecificOutput.updatedInput,
    { ...payload.tool_input, session_ref: `claude:${id}` });
  const rejected = bindClaudeQuerySession({ ...payload, tool_input: { privateValue: "PRIVATE_SENTINEL" } });
  assert.equal(rejected, null);
  assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_SENTINEL|privateValue|private-path/u);
});

test("Claude query hook bounds malformed input and never echoes hook contents", async () => {
  for (const input of ["not-json PRIVATE_SENTINEL", "x".repeat(1024 * 1024 + 1)]) {
    let output = "";
    await runClaudeQuerySessionHook(Readable.from([input]), { write: (value) => { output += value; } });
    assert.equal(output, "");
    assert.doesNotMatch(output, /PRIVATE_SENTINEL|not-json/u);
  }
});

test("both MCP entrypoints can select the actual session when the launch identity is outdated or missing", async () => {
  for (const build of [buildPomegrMcpServer, buildClaudePomegrMcpServer]) {
    for (const currentSessionRef of ["claude:earlier-session", null]) {
      const calls = [];
      const server = build({ currentSessionRef, query: async (path) => {
        calls.push(path);
        return {
          schemaVersion: 1, readiness: "ready", observedAt: "2026-09-09T04:25:00.000Z",
          generatedAt: "2026-09-09T04:26:00.000Z", revision: 2,
          sessionRef: "claude:actual-session", format: "markdown",
          filename: "pomegr-actual-session-2026-09-09.md", report: "# Actual session report",
        };
      } });
      const tool = server._registeredTools.get_session_report;
      const input = AGENT_QUERY_TOOLS.get_session_report.inputSchema.parse({ session_ref: "claude:actual-session" });
      const response = await tool.handler(input);
      assert.equal(response.isError, undefined);
      assert.equal(response.structuredContent.sessionRef, "claude:actual-session");
      assert.deepEqual(calls, ["/api/agent/v1/sessions/claude%3Aactual-session/report"]);
      assert.equal(AGENT_QUERY_TOOLS.get_session_report.inputSchema.safeParse({ session_ref: "../private" }).success, false);
    }
  }
});

test("session queries reject another session's response without exposing its content", async () => {
  const query = async () => ({
    schemaVersion: 1, readiness: "ready", observedAt: null, generatedAt: null, revision: 1,
    sessionRef: "claude:wrong-session", format: "markdown",
    filename: "pomegr-wrong-session-2026-09-09.md", report: "WRONG_SESSION_CONTENT",
  });
  for (const build of [buildPomegrMcpServer, buildClaudePomegrMcpServer]) {
    const server = build({ currentSessionRef: "claude:actual-session", query });
    const response = await server._registeredTools.get_session_report.handler({});
    assert.equal(response.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /WRONG_SESSION_CONTENT|wrong-session/u);
  }
  const direct = await createAgentQueryHandler(query)("get_session_report", { session_ref: "claude:actual-session" });
  assert.equal(direct.isError, true);
  assert.doesNotMatch(JSON.stringify(direct), /WRONG_SESSION_CONTENT|wrong-session/u);
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
