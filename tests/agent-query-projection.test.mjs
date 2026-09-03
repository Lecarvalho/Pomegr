import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildAgentQueryProjection, createAgentQueryProjectionCache } from "../monitor/agent-query-projection.mjs";
import { createRequestHandler } from "../monitor/request-handler.mjs";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const at = (offset = 0) => new Date(NOW + offset).toISOString();

function retained() {
  return {
    qualifiedId: "codex:session-1", revision: 3,
    readiness: { agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready" },
    publicState: { agents: [
      { id: "primary", parentId: null, label: "Primary", role: "orchestrator", status: "active", assignment: null, startedAt: at(-1000), updatedAt: at(-10), lastSeen: at(-10), cacheLifetime: "1h", tokens: { total: 80, input: 20, output: 10, cacheRead: 40, cacheWrite: 10 }, executionTasks: [
        { id: "task-1", workKind: "test", status: "failed", startedAt: at(-200), finishedAt: at(-100), failureCause: "tests_failed" },
      ] },
      { id: "child", parentId: "primary", label: "Builder", role: "builder", status: "finished", assignment: "bounded task", startedAt: at(-900), updatedAt: at(-20), lastSeen: at(-20), cacheLifetime: "5m", tokens: { total: 0 }, executionTasks: [] },
    ] },
    evidence: {
      usageSnapshots: [
        { dedupeId: "older", actorId: "primary", timestamp: at(-500), input: 10, output: 5, cacheRead: 20, cacheWrite: 0 },
        { dedupeId: "latest", actorId: "primary", timestamp: at(-25), input: 20, output: 10, cacheRead: 40, cacheWrite: 10, reasoningOutput: 4, modelContextWindow: 200_000 },
      ],
      toolCalls: [
      { id: "task-1", timestamp: at(-100), actor: { id: "primary", label: "Primary" }, status: "failed", workKind: "test" },
      { id: "tool-2", timestamp: at(-50), actor: { id: "child", label: "Builder" }, status: "failed", workKind: "write" },
      ],
    },
  };
}

function projection() {
  return buildAgentQueryProjection({
    now: () => NOW,
    catalog: [{ id: "codex:session-1", provider: "codex", title: "Safe title", project: "Pomegr", isLive: true, activityStatus: "working", summaryReadiness: "ready" }],
    entries: [retained()],
    providerStatus: { revision: 2, generatedAt: at(-1), providers: [{ provider: "codex", status: "operational", readiness: "ready", freshness: "fresh", checkedAt: at(-2), updatedAt: at(-3), statusPageUrl: "https://status.openai.com/", incidents: [] }] },
    usageLimits: { revision: 4, generatedAt: at(-1), providers: [{ provider: "codex", readiness: "ready", usageLimits: { available: true, origin: "provider_api", freshness: "fresh", fetchedAt: at(-4), attemptedAt: at(-4), retryAt: null, failureKind: null, limits: [{ id: "all", window: "5 hours", percent: 12, resetsAt: at(1000), severity: "normal", active: true }, { id: "inactive", window: "month", percent: 1, resetsAt: null, severity: "normal", active: false }], retainedLimits: { fetchedAt: at(-1000), limits: [{ id: "supplemental", active: true }] } } }] },
  });
}

test("agent query projection distinguishes primary/delegated and selects latest context", () => {
  const value = projection();
  const agents = value.listSessionAgents("codex:session-1");
  assert.deepEqual(agents.agents.map((agent) => [agent.id, agent.scope, agent.parentId]), [["primary", "main", null], ["child", "delegated", "primary"]]);
  assert.equal(Object.hasOwn(agents.agents[0], "tokens"), false);
  assert.equal(Object.hasOwn(agents.agents[0], "executionTasks"), false);
  assert.equal(value.getAgentContext("codex:session-1", "primary").context.kind, "latest_context_snapshot");
  assert.deepEqual(value.getAgentContext("codex:session-1", "primary").context, {
    agentId: "primary", kind: "latest_context_snapshot", observedAt: at(-25), total: 80,
    uncachedInput: 20, cacheRead: 40, cacheWrite: 10, output: 10,
    reasoningOutput: 4, modelContextWindow: 200_000, cacheLifetime: "1h",
  });
  assert.equal(value.getAgentContext("codex:session-1", "child").reason, "context_unavailable");
  assert.equal(value.getAgentContext("codex:session-1", "missing").reason, "agent_not_found");
});

test("session, provider-health, and usage-limit projections expose only V1 fields and provenance", () => {
  const value = projection();
  const session = value.listSessions({ scope: "all" }).sessions[0];
  assert.deepEqual(Object.keys(session), ["sessionRef", "provider", "title", "project", "state", "activityStatus", "createdAt", "updatedAt"]);
  assert.equal(value.providerHealth({ provider: "codex" }).providers[0].freshness, "fresh");
  const usage = value.usageLimits({ provider: "codex" }).providers[0];
  assert.equal(usage.origin, "provider_api");
  assert.equal(usage.freshness, "fresh");
  assert.deepEqual(usage.windows.map(({ id, usedPercent }) => [id, usedPercent]), [["all", 12], ["inactive", 1]]);
  assert.doesNotMatch(JSON.stringify(usage), /retainedLimits|supplemental/u);
});

test("recent failures are bounded, opaque, and prefer matching execution tasks", () => {
  const failures = projection().getRecentFailures("codex:session-1", null, 15, 10).failures;
  assert.equal(failures.length, 2);
  assert.equal(failures.find((item) => item.agentId === "primary").failureCategory, "tests_failed");
  assert.match(failures[0].id, /^failure_[a-f0-9]{24}$/u);
  assert.doesNotMatch(JSON.stringify(failures), /task-1|tool-2|description|stderr|command/u);
});

test("recent failures apply the requested window and limit and report truncation", () => {
  const entry = retained();
  entry.evidence.toolCalls.push({ id: "old", timestamp: at(-20 * 60_000), actor: { id: "primary", label: "Primary" }, status: "failed", workKind: "shell" });
  for (let index = 0; index < 30; index += 1) {
    entry.evidence.toolCalls.push({ id: `many-${index}`, timestamp: at(-1000 - index), actor: { id: "primary", label: "Primary" }, status: "failed", workKind: "shell" });
  }
  const value = buildAgentQueryProjection({ now: () => NOW, entries: [entry] });
  const result = value.getRecentFailures("codex:session-1", "primary", 15, 25);
  assert.equal(result.failures.length, 25);
  assert.equal(result.retainedCoverage.truncated, true);
  assert.equal(result.failures.every((failure) => Date.parse(failure.observedAt) >= NOW - 15 * 60_000), true);
});

test("agent-query serialization excludes private evidence and out-of-contract session aggregates", () => {
  const entry = retained();
  entry.evidence.prompt = "PROMPT_SENTINEL";
  entry.evidence.response = "RESPONSE_SENTINEL";
  entry.evidence.credentials = "CREDENTIAL_SENTINEL";
  entry.evidence.transcriptPath = "PATH_SENTINEL";
  entry.evidence.toolCalls[0].detail = "COMMAND_SENTINEL STDOUT_SENTINEL STDERR_SENTINEL";
  entry.evidence.toolCalls[0].arguments = "MCP_ARGUMENT_SENTINEL";
  entry.evidence.toolCalls[0].result = "MCP_RESULT_SENTINEL";
  entry.publicState.agents[0].kind = "PROVIDER_KIND_SENTINEL";
  entry.publicState.agents[0].model = "MODEL_SENTINEL";
  entry.publicState.agents[0].executionTasks[0].description = "TASK_DESCRIPTION_SENTINEL";
  entry.publicState.agents[0].executionTasks[0].command = "TASK_COMMAND_SENTINEL";
  entry.publicState.agents[0].executionTasks[0].stdout = "TASK_OUTPUT_SENTINEL";
  const value = buildAgentQueryProjection({
    now: () => NOW,
    catalog: [{ id: "codex:session-1", provider: "codex", title: "Safe", project: "Pomegr", isLive: true, activityStatus: "working" }],
    entries: [entry],
    usageLimits: { providers: [{ provider: "codex", readiness: "unavailable", usageLimits: { available: false, fetchedAt: null, attemptedAt: null, retryAt: null, failureKind: "unavailable", error: "RAW_ERROR_SENTINEL", limits: [] } }] },
  });
  const serialized = JSON.stringify([
    value.listSessions({ scope: "all" }), value.listSessionAgents("codex:session-1"),
    value.getAgentContext("codex:session-1", "primary"), value.getRecentFailures("codex:session-1", null, 1440, 25),
    value.usageLimits(), value.providerHealth(),
  ]);
  for (const sentinel of ["PROMPT_SENTINEL", "RESPONSE_SENTINEL", "CREDENTIAL_SENTINEL", "PATH_SENTINEL", "COMMAND_SENTINEL", "STDOUT_SENTINEL", "STDERR_SENTINEL", "MCP_ARGUMENT_SENTINEL", "MCP_RESULT_SENTINEL", "PROVIDER_KIND_SENTINEL", "MODEL_SENTINEL", "TASK_DESCRIPTION_SENTINEL", "TASK_COMMAND_SENTINEL", "TASK_OUTPUT_SENTINEL", "RAW_ERROR_SENTINEL"]) {
    assert.doesNotMatch(serialized, new RegExp(sentinel, "u"));
  }
});

test("agent routes require their separate authorization header", async (t) => {
  const token = "a".repeat(32);
  const desktopToken = "b".repeat(32);
  const server = http.createServer(createRequestHandler({
    authorizationToken: desktopToken,
    agentAuthorizationToken: token,
    runtime: {
      serveAgentQuery: (name, args) => ({ revision: 1, snapshot: { serialized: JSON.stringify({ name, args }) } }),
      serveSessionCatalog: () => ({ status: "ready", revision: 1, snapshot: { serialized: "{}" } }),
    },
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/api/agent/v1/sessions`)).status, 401);
  const response = await fetch(`${origin}/api/agent/v1/sessions`, { headers: { "x-pomegr-agent-authorization": token } });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(await response.text()).name, "listSessions");
  assert.equal((await fetch(`${origin}/api/agent/v1/sessions`, { method: "POST", headers: { "x-pomegr-agent-authorization": token } })).status, 405);
  assert.equal((await fetch(`${origin}/api/agent/v1/sessions`, { headers: { "x-pomegr-desktop-authorization": desktopToken } })).status, 401);
  assert.equal((await fetch(`${origin}/api/sessions`, { headers: { "x-pomegr-agent-authorization": token } })).status, 401);
  assert.equal((await fetch(`${origin}/api/transcript-path`, { headers: { "x-pomegr-agent-authorization": token } })).status, 401);
});

test("all six GET routes parse exact selectors without starting other runtime work", async (t) => {
  const calls = [];
  const server = http.createServer(createRequestHandler({ runtime: {
    serveAgentQuery: (name, args) => {
      calls.push({ name, args });
      return { revision: 7, snapshot: { serialized: JSON.stringify({ schemaVersion: 1, readiness: "ready", name, args }) } };
    },
  } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const paths = [
    "/api/agent/v1/provider-health?provider=codex",
    "/api/agent/v1/usage-limits?provider=claude",
    "/api/agent/v1/sessions?scope=all&limit=4",
    "/api/agent/v1/sessions/codex%3Asession-1/agents",
    "/api/agent/v1/sessions/codex%3Asession-1/agents/primary/context",
    "/api/agent/v1/sessions/codex%3Asession-1/failures?agent_id=primary&within_minutes=30&limit=3",
  ];
  for (const pathname of paths) assert.equal((await fetch(origin + pathname)).status, 200);
  assert.deepEqual(calls.map(({ name }) => name), ["providerHealth", "usageLimits", "listSessions", "listSessionAgents", "getAgentContext", "getRecentFailures"]);
  assert.deepEqual(calls.at(-1).args, { sessionRef: "codex:session-1", agentId: "primary", withinMinutes: 30, limit: 3 });
  assert.equal((await fetch(`${origin}/api/agent/v1/provider-health/extra`)).status, 404);
  assert.equal((await fetch(`${origin}/api/agent/v1/provider-health?unknown=value`)).status, 400);
  assert.equal(calls.length, 6);
});

test("query cache reuses exact serialized response until a D refresh", () => {
  let rows = [{ id: "codex:session-1", provider: "codex", title: "One", project: "Pomegr", isLive: true }];
  let rejectRefresh = false;
  const cache = createAgentQueryProjectionCache({ now: () => NOW, sources: { catalog: () => {
    if (rejectRefresh) throw new Error("candidate failed");
    return rows;
  }, entries: () => [], providerStatus: {}, usageLimits: {} } });
  cache.refresh();
  const first = cache.read("listSessions", { scope: "live" });
  rows = [{ ...rows[0], title: "Two" }];
  assert.strictEqual(cache.read("listSessions", { scope: "live" }).snapshot, first.snapshot);
  rejectRefresh = true;
  assert.throws(() => cache.refresh(), /candidate failed/u);
  assert.strictEqual(cache.read("listSessions", { scope: "live" }).snapshot, first.snapshot, "failed derivation retains the committed response");
  rejectRefresh = false;
  cache.refresh();
  assert.notStrictEqual(cache.read("listSessions", { scope: "live" }).snapshot, first.snapshot);
});
