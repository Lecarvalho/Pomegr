import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { POMEGR_READ_TOOLS } from "../desktop/runtime/agent-chat-runner.mjs";
import { AGENT_CHAT_MCP_INSTRUCTIONS, buildAgentChatMcpServer } from "../mcp/agent-chat-server.mjs";
import { AGENT_QUERY_TOOLS } from "../mcp/agent-query-tools.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const sessionTools = ["get_session_report", "list_session_agents", "get_agent_context", "get_recent_failures"];
const SESSION_REF = "claude:chat-session-1";
const ENCODED_REF = "claude%3Achat-session-1";
const WRITE_TOOLS = [
  "add_task", "update_task", "remove_task", "complete_task", "block_task", "create_feature", "update_feature", "delete_feature", "get_feature",
  "report_signal", "report_progress", "rename_session", "report_agent_signal", "report_session_signal", "report_task_signal",
];

const base = { schemaVersion: 1, readiness: "ready", observedAt: "2026-10-01T12:00:00.000Z", generatedAt: "2026-10-01T12:00:00.000Z", revision: 4 };
const coverage = { maximumWindowMinutes: 1440, maximumRetained: 256, oldestObservedAt: null, newestObservedAt: null, truncated: false };

function answerFor(pathname) {
  if (pathname.endsWith("/report")) return { ...base, sessionRef: SESSION_REF, format: "markdown", filename: "pomegr-chat-2026-10-01.md", report: "# Pomegr Session Observation Report\n\nBounded." };
  if (pathname.endsWith("/context")) return { ...base, sessionRef: SESSION_REF, agentId: "primary", context: null, readiness: "unavailable", reason: "context_unavailable" };
  if (pathname.endsWith("/failures")) return { ...base, sessionRef: SESSION_REF, agentId: null, withinMinutes: 15, failures: [], retainedCoverage: coverage };
  if (pathname.endsWith("/agents")) return { ...base, sessionRef: SESSION_REF, agents: [] };
  if (pathname.endsWith("/usage-limits") || pathname.endsWith("/provider-health")) return { ...base, providers: [] };
  return { ...base, sessions: [], truncated: false };
}

function serverWithQuery() {
  const calls = [];
  const server = buildAgentChatMcpServer({ query: async (pathname, params) => { calls.push({ pathname, params }); return answerFor(pathname); } });
  return { server, calls, tools: server._registeredTools };
}

test("the server registers exactly the seven read tools the chat's run is allowed to call, each read-only", () => {
  const { tools } = serverWithQuery();
  assert.deepEqual(Object.keys(tools).sort(), [...POMEGR_READ_TOOLS].sort());
  assert.deepEqual(Object.keys(tools).sort(), Object.keys(AGENT_QUERY_TOOLS).sort());
  assert.equal(Object.keys(tools).length, 7);
  for (const name of POMEGR_READ_TOOLS) {
    assert.deepEqual(tools[name].annotations, readOnly, name);
    assert.ok(tools[name].outputSchema, `${name} has an output schema`);
    assert.equal(typeof tools[name].handler, "function");
  }
});

test("no tool of the server changes a task, a feature, a signal, or a session", () => {
  const { tools } = serverWithQuery();
  for (const name of WRITE_TOOLS) assert.equal(Object.hasOwn(tools, name), false, name);
  for (const tool of Object.values(tools)) assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(Object.values(tools).some((tool) => tool.annotations.destructiveHint !== false), false);
});

test("the server's instructions say that this chat has no current session and that every tool only reads", () => {
  const { server } = serverWithQuery();
  assert.equal(server.server._instructions, AGENT_CHAT_MCP_INSTRUCTIONS);
  assert.match(AGENT_CHAT_MCP_INSTRUCTIONS, /read-only observation tools for the Pomegr agent chat/u);
  assert.match(AGENT_CHAT_MCP_INSTRUCTIONS, /Nothing here changes a session, a task, or the board/u);
  assert.match(AGENT_CHAT_MCP_INSTRUCTIONS, /no current session/u);
  assert.match(AGENT_CHAT_MCP_INSTRUCTIONS, /session_ref/u);
  assert.match(AGENT_CHAT_MCP_INSTRUCTIONS, /public provider status does not prove impact or causation/u);
});

test("a session tool without a session reference answers current_session_unavailable and never calls the query", async () => {
  for (const name of sessionTools) {
    const { calls, tools } = serverWithQuery();
    const answer = await tools[name].handler({});
    assert.equal(answer.isError, undefined, name);
    assert.equal(answer.structuredContent.readiness, "unavailable", name);
    assert.equal(answer.structuredContent.reason, "current_session_unavailable", name);
    assert.equal(calls.length, 0, name);
    const named = await tools[name].handler({ session_ref: undefined, agent_id: "primary" });
    assert.equal(named.structuredContent.reason, "current_session_unavailable", `${name}: an agent without a session`);
    assert.equal(calls.length, 0, name);
  }
});

test("a host session in the environment is never taken for the chat's own session", async () => {
  const names = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { CODEX_THREAD_ID: "thread-1", CODEX_SESSION_ID: "thread-1", CLAUDE_CODE_SESSION_ID: "session-1" });
  try {
    const { calls, tools } = serverWithQuery();
    assert.equal((await tools.get_session_report.handler({})).structuredContent.reason, "current_session_unavailable");
    assert.equal(calls.length, 0);
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});

test("a session tool with a reference calls the query with its path", async () => {
  const { calls, tools } = serverWithQuery();
  const report = await tools.get_session_report.handler({ session_ref: SESSION_REF });
  assert.match(report.content[0].text, /^# Pomegr Session Observation Report/u);
  assert.equal(report.structuredContent.sessionRef, SESSION_REF);
  await tools.list_session_agents.handler({ session_ref: SESSION_REF });
  await tools.get_agent_context.handler({ session_ref: SESSION_REF });
  await tools.get_agent_context.handler({ session_ref: SESSION_REF, agent_id: "agent-7" });
  await tools.get_recent_failures.handler({ session_ref: SESSION_REF, agent_id: "agent-7", within_minutes: 30, limit: 5 });
  await tools.get_recent_failures.handler({ session_ref: SESSION_REF });
  assert.deepEqual(calls, [
    { pathname: `/api/agent/v1/sessions/${ENCODED_REF}/report`, params: {} },
    { pathname: `/api/agent/v1/sessions/${ENCODED_REF}/agents`, params: {} },
    { pathname: `/api/agent/v1/sessions/${ENCODED_REF}/agents/primary/context`, params: {} },
    { pathname: `/api/agent/v1/sessions/${ENCODED_REF}/agents/agent-7/context`, params: {} },
    { pathname: `/api/agent/v1/sessions/${ENCODED_REF}/failures`, params: { agent_id: "agent-7", within_minutes: 30, limit: 5 } },
    { pathname: `/api/agent/v1/sessions/${ENCODED_REF}/failures`, params: { agent_id: undefined, within_minutes: 15, limit: 10 } },
  ]);
});

test("a session answer for another session than the one asked about is refused", async () => {
  const server = buildAgentChatMcpServer({ query: async () => ({ ...answerFor("/report"), sessionRef: "claude:another-session" }) });
  const answer = await server._registeredTools.get_session_report.handler({ session_ref: SESSION_REF });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /malformed observation/u);
});

test("the tools that need no session call the query with their fixed paths", async () => {
  const { calls, tools } = serverWithQuery();
  await tools.list_sessions.handler({});
  await tools.list_sessions.handler({ provider: "codex", scope: "all", limit: 50 });
  await tools.get_usage_limits.handler({});
  await tools.get_usage_limits.handler({ provider: "claude" });
  await tools.get_provider_health.handler({});
  await tools.get_provider_health.handler({ provider: "codex" });
  assert.deepEqual(calls, [
    { pathname: "/api/agent/v1/sessions", params: { provider: undefined, scope: "live", limit: 20 } },
    { pathname: "/api/agent/v1/sessions", params: { provider: "codex", scope: "all", limit: 50 } },
    { pathname: "/api/agent/v1/usage-limits", params: {} },
    { pathname: "/api/agent/v1/usage-limits", params: { provider: "claude" } },
    { pathname: "/api/agent/v1/provider-health", params: {} },
    { pathname: "/api/agent/v1/provider-health", params: { provider: "codex" } },
  ]);
});

test("a query that fails answers unavailable instead of throwing", async () => {
  const server = buildAgentChatMcpServer({ query: async () => { throw new Error("connect ECONNREFUSED C:\\private\\data"); } });
  const answer = await server._registeredTools.get_usage_limits.handler({});
  assert.equal(answer.structuredContent.reason, "monitor_unavailable");
  assert.equal(JSON.stringify(answer).includes("private"), false);
});

test("without a query the server reads through the monitor descriptor under the given data root, and answers unavailable when there is none", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "pomegr-agent-chat-mcp-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const server = buildAgentChatMcpServer({ dataRoot });
  const answer = await server._registeredTools.list_sessions.handler({});
  assert.equal(answer.structuredContent.readiness, "unavailable");
  assert.equal(answer.structuredContent.reason, "monitor_unavailable");
});

test("the server and its entry import no task, feature, signal, or session-binding module", async () => {
  const [server, entry] = await Promise.all(["../mcp/agent-chat-server.mjs", "../mcp/agent-chat-entry.mjs"].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  for (const source of [server, entry]) {
    assert.doesNotMatch(source, /registerTaskTools|plugin-src|claude-query-session|task-binding|createAgentTaskWriter/u);
    assert.doesNotMatch(source, /console\./u);
  }
  assert.deepEqual([...server.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]), ["@modelcontextprotocol/server", "./agent-query-tools.mjs", "../shared/agent-query-transport.mjs"]);
  assert.match(server, /registerAgentQueryTools\(server, \{ query, currentSessionRef: null \}\)/u);
  assert.match(entry, /serveStdio\(\(\) => buildAgentChatMcpServer\(\)\)/u);
  assert.deepEqual([...entry.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]), ["@modelcontextprotocol/server/stdio", "./agent-chat-server.mjs"]);
});
