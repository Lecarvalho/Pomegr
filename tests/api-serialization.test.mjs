import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMonitorRuntime, createMonitorServer } from "../monitor/server.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import {
  assertNoPrivateFixtureSentinels,
  readProviderFixture,
} from "./helpers/provider-fixtures.mjs";

const SAFE_CWD = "C:\\synthetic\\pomegr-api-fixture";
const PRIVATE_RESOURCE_PID = 987_654_321;
const PRIVATE_RESOURCE_START = "PROCESS_START_MUST_NOT_LEAK";

function resourceUsageSamplerWithPrivateFields() {
  return {
    async sample() {},
    get() {
      return {
        status: "ready",
        reason: null,
        current: {
          cpuCores: 1.25,
          cpuMachinePercent: 15.625,
          memoryBytes: 2_048,
          readBytesPerSecond: 400,
          writeBytesPerSecond: 200,
          pid: PRIVATE_RESOURCE_PID,
          processStartIdentity: PRIVATE_RESOURCE_START,
          processName: "PROCESS_NAME_MUST_NOT_LEAK",
        },
        observedPeak: {
          memoryBytes: 4_096,
          pid: PRIVATE_RESOURCE_PID,
          processStartIdentity: PRIVATE_RESOURCE_START,
        },
        samples: [{
          timestamp: "2026-08-10T13:00:18.000Z",
          cpuCores: 1.25,
          cpuMachinePercent: 15.625,
          memoryBytes: 2_048,
          readBytesPerSecond: 400,
          writeBytesPerSecond: 200,
          command: "PROCESS_COMMAND_MUST_NOT_LEAK",
        }],
        intervalMs: 5_000,
      };
    },
  };
}

async function writeFixture(file, fixture, replacements = []) {
  let contents = await readProviderFixture(fixture);
  for (const [from, to] of replacements) contents = contents.replaceAll(from, to);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

async function startSyntheticMonitor(context, options) {
  const server = createMonitorServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function codexAppThread() {
  return {
    id: "codex-fixture-parent",
    sessionId: "codex-fixture-parent",
    ephemeral: false,
    createdAt: Date.parse("2026-08-10T13:00:00.000Z") / 1_000,
    updatedAt: Date.parse("2026-08-10T13:00:17.000Z") / 1_000,
    source: "cli",
    cwd: SAFE_CWD,
    name: "Synthetic Codex API fixture",
    status: { type: "idle" },
    preview: "PROMPT_MUST_NOT_LEAK",
    authFile: "AUTH_FILE_MUST_NOT_LEAK",
    environment: { SECRET: "ENV_SECRET_MUST_NOT_LEAK" },
    turns: [{
      id: "turn-private",
      items: [
        { type: "userMessage", content: "PROMPT_MUST_NOT_LEAK" },
        { type: "agentMessage", content: "RESPONSE_MUST_NOT_LEAK" },
        { type: "futurePrivateItem", reasoning: "REASONING_MUST_NOT_LEAK" },
      ],
    }],
  };
}

function rateLimitsWithPrivateFields() {
  return {
    result: {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_786_363_200 },
          credits: { token: "OAUTH_TOKEN_MUST_NOT_LEAK" },
        },
      },
      authFile: "AUTH_FILE_MUST_NOT_LEAK",
      environmentSecret: "ENV_SECRET_MUST_NOT_LEAK",
      localPath: "PRIVATE_PATH_MUST_NOT_LEAK",
      account: "ACCOUNT_MUST_NOT_LEAK",
      workspace: "WORKSPACE_MUST_NOT_LEAK",
      plan: "PLAN_MUST_NOT_LEAK",
      credit: "CREDIT_MUST_NOT_LEAK",
      stderr: "STDERR_MUST_NOT_LEAK",
      rawRpcError: "RAW_RPC_MUST_NOT_LEAK",
    },
  };
}

async function syntheticProviders(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-api-audit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const replacements = [["PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path"]];

  const claudeRoot = path.join(root, "claude");
  const claudeId = "claude-fixture-parent";
  const claudeFile = path.join(claudeRoot, "projects", "fixture", `${claudeId}.jsonl`);
  const claudeChildFile = path.join(claudeRoot, "projects", "fixture", claudeId, "subagents", "agent-child-fixture.jsonl");
  await writeFixture(claudeFile, "claude/session.jsonl", replacements);
  await writeFixture(
    claudeChildFile,
    "claude/subagent.jsonl",
    replacements,
  );
  await writeFixture(path.join(claudeRoot, "registry", `${claudeId}.json`), "claude/registry.json");
  await writeFixture(path.join(claudeRoot, "tasks", claudeId, "task-1.json"), "claude/task.json");
  const workflowRunId = "wf_fixture-1";
  const workflowSessionRoot = path.join(claudeRoot, "projects", "fixture", claudeId);
  await mkdir(path.join(workflowSessionRoot, "subagents", "workflows", workflowRunId), { recursive: true });
  await appendFile(claudeFile, `${JSON.stringify({
    type: "user",
    timestamp: "2026-08-10T13:00:19.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "private-launch", content: "WORKFLOW_PATH_MUST_NOT_LEAK" }] },
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      taskId: "PRIVATE_WORKFLOW_TASK_ID",
      workflowName: "fixture-workflow",
      runId: workflowRunId,
      summary: "Implement and verify the fixture",
      scriptPath: "WORKFLOW_PATH_MUST_NOT_LEAK",
    },
  })}\n`, "utf8");
  await appendFile(claudeFile, `${[
    {
      type: "assistant",
      timestamp: "2026-08-10T13:00:20.000Z",
      message: {
        content: [{
          type: "tool_use",
          name: "mcp__pomegr__report_session_progress",
          input: {
            phase: "implementing",
            percent: 42,
            remaining_minutes_min: 5,
            remaining_minutes_max: 10,
            confidence: "high",
          },
        }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-08-10T13:00:21.000Z",
      message: {
        content: [{
          type: "tool_use",
          name: "mcp__pomegr__report_session_progress",
          input: {
            phase: "complete",
            percent: 100,
            confidence: "high",
            private: "MCP_PROGRESS_PRIVATE_MUST_NOT_LEAK",
          },
        }],
      },
    },
  ].map(JSON.stringify).join("\n")}\n`, "utf8");
  await writeFile(
    path.join(workflowSessionRoot, "subagents", "workflows", workflowRunId, "agent-shared.jsonl"),
    `${JSON.stringify({ type: "user", timestamp: "2026-08-10T13:00:18.000Z", message: { content: "WORKFLOW_AGENT_PROMPT_MUST_NOT_LEAK" } })}\n`,
    "utf8",
  );
  await writeFixture(
    path.join(workflowSessionRoot, "subagents", "workflows", workflowRunId, "journal.jsonl"),
    "claude/workflow/journal.jsonl",
  );
  await writeFixture(
    path.join(workflowSessionRoot, "workflows", `${workflowRunId}.json`),
    "claude/workflow/completed.json",
  );
  const claude = createClaudeProvider({
    homeDir: claudeRoot,
    projectsRoot: path.join(claudeRoot, "projects"),
    registryRoot: path.join(claudeRoot, "registry"),
    tasksRoot: path.join(claudeRoot, "tasks"),
    explicitSession: claudeFile,
    usageRequest: async () => { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK AUTH_FILE_MUST_NOT_LEAK"); },
  });

  const codexRoot = path.join(root, "codex");
  const rolloutRoot = path.join(codexRoot, "sessions", "2026", "08", "10");
  const codexParentFile = path.join(rolloutRoot, "rollout-parent.jsonl");
  const codexChildFile = path.join(rolloutRoot, "rollout-child.jsonl");
  await writeFixture(codexParentFile, "codex/parent.jsonl", replacements);
  await writeFixture(codexChildFile, "codex/child.jsonl", replacements);
  await appendFile(codexParentFile, `${[
    {
      timestamp: "2026-08-10T13:00:20.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "mcp__pomegr__report_session_progress",
        call_id: "progress-valid",
        arguments: JSON.stringify({
          phase: "verifying",
          percent: 88,
          remaining_minutes_min: 1,
          remaining_minutes_max: 3,
          confidence: "medium",
        }),
      },
    },
    {
      timestamp: "2026-08-10T13:00:21.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "mcp__pomegr__report_session_progress",
        call_id: "progress-private",
        arguments: JSON.stringify({
          phase: "complete",
          percent: 100,
          confidence: "high",
          private: "MCP_PROGRESS_PRIVATE_MUST_NOT_LEAK",
        }),
      },
    },
  ].map(JSON.stringify).join("\n")}\n`, "utf8");
  const parent = codexAppThread();
  const codex = createCodexProvider({
    codexHome: codexRoot,
    includeArchived: false,
    cacheMs: 0,
    appServer: {
      async listThreads() { return { data: [parent] }; },
      async readThread({ threadId }) {
        if (threadId !== parent.id) throw new Error("PRIVATE_PATH_MUST_NOT_LEAK");
        return { thread: parent };
      },
    },
    rateLimitsReader: { async readRateLimits() { return rateLimitsWithPrivateFields(); } },
  });
  return { claude, codex, transcriptPaths: { claudeChildFile, codexChildFile } };
}

test("/api/state and /api/sessions serialize only allowlisted Claude and Codex metadata", async (context) => {
  const { claude, codex, transcriptPaths } = await syntheticProviders(context);
  const providerRegistry = createProviderRegistry([claude, codex]);
  const origin = await startSyntheticMonitor(context, {
    providerRegistry,
    resourceUsageSampler: resourceUsageSamplerWithPrivateFields(),
    readGitState() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK ENV_SECRET_MUST_NOT_LEAK"); },
    async readPullRequests() { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK TOOL_OUTPUT_MUST_NOT_LEAK"); },
  });

  const responses = await Promise.all([
    fetch(`${origin}/api/sessions`),
    fetch(`${origin}/api/state?sessionId=claude%3Aclaude-fixture-parent`),
    fetch(`${origin}/api/state?sessionId=codex%3Acodex-fixture-parent`),
    fetch(`${origin}/api/home`),
    fetch(`${origin}/api/home?scope=aggregates`),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200]);
  const serialized = await Promise.all(responses.map((response) => response.text()));
  serialized.forEach((body, index) => assertNoPrivateFixtureSentinels(body, `API response ${index + 1}`));
  assert.doesNotMatch(serialized.join("\n"), /AUTH_FILE_MUST_NOT_LEAK/);
  assert.doesNotMatch(serialized.join("\n"), /PRIVATE_WORKFLOW_TASK_ID/);
  assert.doesNotMatch(serialized.join("\n"), /MCP_PROGRESS_PRIVATE_MUST_NOT_LEAK|remaining_minutes_min|remaining_minutes_max/);
  assert.doesNotMatch(
    serialized.join("\n"),
    /987654321|PROCESS_START_MUST_NOT_LEAK|PROCESS_NAME_MUST_NOT_LEAK|PROCESS_COMMAND_MUST_NOT_LEAK|processStartIdentity|"pid"|intervalMs/,
  );

  const catalog = JSON.parse(serialized[0]);
  assert.deepEqual(catalog.sessions.map(({ id, source }) => ({ id, source })).sort((left, right) => left.id.localeCompare(right.id)), [
    { id: "claude:claude-fixture-parent", source: "Claude Code" },
    { id: "codex:codex-fixture-parent", source: "Codex" },
  ]);
  assert.equal(Array.isArray(catalog.liveSessions), true);
  assert.equal(catalog.liveSessions.every((session) => session.isLive === true), true);
  for (const session of catalog.liveSessions) {
    assert.equal(Object.hasOwn(session, "contextHistory"), false);
    assert.equal(Object.hasOwn(session, "resources"), false);
  }
  const claudeState = JSON.parse(serialized[1]);
  const codexState = JSON.parse(serialized[2]);
  const home = JSON.parse(serialized[3]);
  const aggregates = JSON.parse(serialized[4]);
  assert.equal(Array.isArray(home.projects), true);
  assert.deepEqual(aggregates, {
    generatedAt: home.generatedAt,
    providerLimits: home.providerLimits,
    limitActivities: home.limitActivities,
    ...(home.error ? { error: home.error } : {}),
  });
  assert.equal(Object.hasOwn(aggregates, "projects"), false);
  assert.equal(Object.hasOwn(aggregates, "liveSessions"), false);
  assert.deepEqual(claudeState.session.progress, {
    phase: "implementing",
    percent: 42,
    remainingMinutesMin: 5,
    remainingMinutesMax: 10,
    confidence: "high",
    reportedAt: "2026-08-10T13:00:20.000Z",
  });
  assert.deepEqual(codexState.session.progress, {
    phase: "verifying",
    percent: 88,
    remainingMinutesMin: 1,
    remainingMinutesMax: 3,
    confidence: "medium",
    reportedAt: "2026-08-10T13:00:20.000Z",
  });
  assert.deepEqual(claudeState.session.pomegrPlugin, {
    status: "active",
    version: "0.4.1",
    policyStatus: "valid",
    policyVersion: 7,
    observedAt: "2026-08-10T12:00:00.500Z",
  });
  assert.deepEqual(codexState.session.pomegrPlugin, {
    status: "active",
    version: "0.4.1",
    policyStatus: "valid",
    policyVersion: 7,
    observedAt: "2026-08-10T13:00:01.000Z",
  });
  for (const state of [claudeState, codexState]) {
    assert.equal(Object.hasOwn(state.session.progress, "remaining_minutes_min"), false);
    assert.equal(Object.hasOwn(state.session.progress, "remaining_minutes_max"), false);
    assert.equal(Object.hasOwn(state.session.progress, "private"), false);
  }
  assert.equal(serialized.join("\n").includes(transcriptPaths.claudeChildFile), false);
  assert.equal(serialized.join("\n").includes(transcriptPaths.codexChildFile), false);
  assert.equal(Object.hasOwn(claudeState.agents.find((agent) => agent.id === "agent-child-fixture"), "transcriptPath"), false);
  assert.equal(Object.hasOwn(codexState.agents.find((agent) => agent.id === "agent-codex-fixture-child"), "transcriptPath"), false);
  assert.equal(claudeState.agents.find((agent) => agent.id === "agent-child-fixture").transcriptAvailable, true);
  assert.equal(codexState.agents.find((agent) => agent.id === "agent-codex-fixture-child").transcriptAvailable, true);
  assert.equal(claudeState.workflows[0].metadataStatus, "ready");
  assert.deepEqual(claudeState.workflows[0].agentIds, ["workflow-wf_fixture-1-agent-shared"]);
  assert.equal(claudeState.agents.find((agent) => agent.workflowId === "wf_fixture-1").workflowState, "done");
  assert.equal(claudeState.session.repository.available, false, "Git failure degrades independently");
  assert.equal(codexState.session.repository.available, false, "Git failure degrades independently");
  assert.equal(claudeState.session.pullRequests.status, "unavailable");
  assert.equal(codexState.usageLimits.available, true);
  assert.doesNotMatch(JSON.stringify(codexState.usageLimits), /ACCOUNT_MUST_NOT_LEAK|WORKSPACE_MUST_NOT_LEAK|PLAN_MUST_NOT_LEAK|CREDIT_MUST_NOT_LEAK|RAW_RPC_MUST_NOT_LEAK|STDERR_MUST_NOT_LEAK/);
  assert.deepEqual(Object.keys(codexState.usageLimits).sort(), ["attemptedAt", "available", "error", "fetchedAt", "limits"]);
  assert.equal(codexState.metrics.tokens.allAgents, 1_950);
  assert.equal(codexState.metrics.tokens.allAgents < 9_800, true, "cumulative total_token_usage is not exposed");
  assert.deepEqual(claudeState.metrics.tokens.contextHistory.boundaries.map(({ agentId, kind, preTokens }) => ({
    agentId, kind, preTokens,
  })), [{ agentId: "primary", kind: "automatic_compaction", preTokens: 180_000 }]);
  assert.equal(claudeState.metrics.tokens.cacheEvents.status, "ready");
  assert.equal(codexState.metrics.tokens.cacheEvents.status, "unavailable");
  for (const state of [claudeState, codexState]) {
    assert.equal(state.metrics.tokens.contextHistory.buckets.at(-1).total, state.metrics.tokens.allAgents);
    assert.equal(Array.isArray(state.metrics.tokens.contextHistory.boundaries), true);
    assert.equal(Array.isArray(state.metrics.tokens.cacheEvents.items), true);
    assert.equal(Array.isArray(state.metrics.tokens.cacheEvents.possibleFullRefills), true);
    for (const refill of state.metrics.tokens.cacheEvents.possibleFullRefills) {
      assert.deepEqual(Object.keys(refill).sort(), ["agentId", "count", "reasons", "toolChangeAttributions"]);
      assert.equal(state.agents.some((agent) => agent.id === refill.agentId), true);
      assert.equal(Number.isSafeInteger(refill.count) && refill.count > 0 && refill.count <= 999, true);
      assert.equal(Array.isArray(refill.reasons), true);
      for (const reason of refill.reasons) {
        assert.deepEqual(Object.keys(reason).sort(), ["count", "reason"]);
        assert.match(reason.reason, /^(model_changed|system_changed|tools_changed|messages_changed)$/);
        assert.equal(Number.isSafeInteger(reason.count) && reason.count > 0 && reason.count <= refill.count, true);
      }
      assert.equal(Array.isArray(refill.toolChangeAttributions), true);
      const attributedRefills = refill.toolChangeAttributions.reduce((total, attribution) => total + attribution.count, 0);
      const diagnosedToolChanges = refill.reasons.find((reason) => reason.reason === "tools_changed")?.count || 0;
      assert.equal(attributedRefills <= diagnosedToolChanges, true);
      for (const attribution of refill.toolChangeAttributions) {
        assert.deepEqual(Object.keys(attribution).sort(), ["cause", "changes", "count"]);
        assert.equal(attribution.cause, "remote_control_connected");
        assert.equal(Number.isSafeInteger(attribution.count) && attribution.count > 0 && attribution.count <= refill.count, true);
        assert.equal(Array.isArray(attribution.changes) && attribution.changes.length > 0 && attribution.changes.length <= 8, true);
        for (const change of attribution.changes) {
          assert.deepEqual(Object.keys(change).sort(), ["kind", "tool"]);
          assert.match(change.tool, /^(RemoteTrigger|PushNotification|ListAgents)$/);
          assert.match(change.kind, /^(added|definition_changed)$/);
        }
      }
    }
    assert.equal(state.metrics.tokens.requestSnapshots.status, "ready");
    assert.equal(state.metrics.tokens.requestSnapshots.items.length > 0, true);
    for (const item of state.metrics.tokens.requestSnapshots.items) {
      assert.deepEqual(Object.keys(item).sort(), [
        "agentId", "cacheReadTokens", "cacheWriteTokens", "id", "observedAt", "outputTokens", "totalTokens", "uncachedInputTokens",
      ]);
      assert.equal(item.totalTokens, item.uncachedInputTokens + item.cacheWriteTokens + item.cacheReadTokens + item.outputTokens);
      assert.match(item.id, /^request-[a-f0-9]{16}$/);
    }
    assert.equal(Object.hasOwn(state.metrics.tokens, "contextGrowthTimeline"), false);
    assert.deepEqual(state.metrics.resources, {
      status: "ready",
      reason: null,
      current: {
        cpuCores: 1.25,
        cpuMachinePercent: 15.625,
        memoryBytes: 2_048,
        readBytesPerSecond: 400,
        writeBytesPerSecond: 200,
      },
      observedPeak: { memoryBytes: 4_096 },
      samples: [{
        timestamp: "2026-08-10T13:00:18.000Z",
        cpuCores: 1.25,
        cpuMachinePercent: 15.625,
        memoryBytes: 2_048,
        readBytesPerSecond: 400,
        writeBytesPerSecond: 200,
      }],
    });
  }
});

test("the transcript path endpoint is one-shot, agent-scoped, and rejects browser cross-origin access", async (context) => {
  const { claude, codex, transcriptPaths } = await syntheticProviders(context);
  const origin = await startSyntheticMonitor(context, {
    providerRegistry: createProviderRegistry([claude, codex]),
    readGitState() { return { available: false, branch: "", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }; },
    async readPullRequests() { return { status: "unavailable", checkedAt: null, items: [] }; },
  });
  const query = (sessionId, agentId) => new URLSearchParams({ sessionId, agentId });
  const [claudePath, codexPath, primaryPath, deniedPath] = await Promise.all([
    fetch(`${origin}/api/transcript-path?${query("claude:claude-fixture-parent", "agent-child-fixture")}`),
    fetch(`${origin}/api/transcript-path?${query("codex:codex-fixture-parent", "agent-codex-fixture-child")}`),
    fetch(`${origin}/api/transcript-path?${query("claude:claude-fixture-parent", "primary")}`),
    fetch(`${origin}/api/transcript-path?${query("claude:claude-fixture-parent", "agent-child-fixture")}`, {
      headers: { Origin: "https://untrusted.example" },
    }),
  ]);

  assert.deepEqual([claudePath.status, codexPath.status, primaryPath.status, deniedPath.status], [200, 200, 404, 403]);
  assert.deepEqual(await claudePath.json(), { path: transcriptPaths.claudeChildFile });
  assert.deepEqual(await codexPath.json(), { path: transcriptPaths.codexChildFile });
  assert.doesNotMatch(await primaryPath.text(), /claudeFile|\.jsonl|PRIVATE/i);
  assert.doesNotMatch(await deniedPath.text(), /agent-child-fixture|\.jsonl|PRIVATE/i);
});

test("normalizes hostile provider agent kinds before browser state is built", async () => {
  const provider = {
    id: "claude",
    source: "Claude Code",
    capabilities: {},
  };
  const runtime = createMonitorRuntime({
    providerRegistry: {
      defaultProvider: provider,
      async readSession() {
        return {
          provider,
          sessionId: "claude:role-fixture",
          evidence: {
            historical: true,
            session: {
              title: "Role fixture",
              project: "pomegr",
              cwd: SAFE_CWD,
              startedAt: null,
              updatedAt: null,
              recordedGitBranch: "",
              cost: null,
              approvalMode: null,
              contextMachinery: null,
              summary: null,
              signal: null,
            },
            agents: [{
              id: "agent-hostile",
              parentId: null,
              label: "Agent",
              kind: "HOSTILE_PROVIDER_KIND_MUST_NOT_LEAK",
              workflowId: null,
              workflowPhaseId: null,
              workflowOrder: null,
              workflowState: null,
              model: "unknown",
              effort: "unknown",
              status: "idle",
              signal: null,
              toolCalls: 0,
              skills: [],
              executionTasks: [],
              lastSeen: "",
              startedAt: "",
              updatedAt: "",
              durationMs: 0,
            }],
            workflows: [], usageSnapshots: [], toolCalls: [], activity: [], planTasks: [], compactions: [], pullRequestCreations: [],
            efficiencyRuleEvidence: { repetition: false, concurrentMutation: false, unsharedContext: false, healthyFallback: false, cacheUsageClassification: false },
          },
        };
      },
      async readUsageLimits() { return { available: false, fetchedAt: null, attemptedAt: null, limits: [], error: "" }; },
    },
  });
  const state = await runtime.analyze();
  assert.equal(state.agents[0].assignment, null);
  assert.equal(state.agents[0].role, "unknown");
  assert.equal(Object.hasOwn(state.agents[0], "kind"), false);
  assert.doesNotMatch(JSON.stringify(state), /HOSTILE_PROVIDER_KIND_MUST_NOT_LEAK/);
});

test("preserves busy full-session context history while keeping request snapshots bounded", async () => {
  const provider = {
    id: "codex",
    source: "Codex",
    capabilities: {},
  };
  const startedAtMs = Date.parse("2026-08-10T13:00:00.000Z");
  const usageSnapshots = Array.from({ length: 150 }, (_, index) => ({
    dedupeId: `busy-history-${index}`,
    actorId: "primary",
    timestamp: new Date(startedAtMs + index * 60_000).toISOString(),
    input: 1_000 + index,
    output: 10,
    cacheWrite: 0,
    cacheRead: 0,
  }));
  const runtime = createMonitorRuntime({
    providerRegistry: {
      defaultProvider: provider,
      async readSession() {
        return {
          provider,
          sessionId: "codex:busy-history",
          evidence: {
            historical: true,
            session: {
              title: "Busy history fixture",
              project: "pomegr",
              cwd: SAFE_CWD,
              startedAt: new Date(startedAtMs).toISOString(),
              updatedAt: new Date(startedAtMs + 149 * 60_000).toISOString(),
              recordedGitBranch: "",
              cost: null,
              approvalMode: null,
              contextMachinery: null,
              summary: null,
              signal: null,
            },
            agents: [{
              id: "primary",
              parentId: null,
              label: "Primary agent",
              kind: "orchestrator",
              model: "unknown",
              effort: "unknown",
              status: "idle",
              signal: null,
              toolCalls: 0,
              skills: [],
              executionTasks: [],
              lastSeen: new Date(startedAtMs + 149 * 60_000).toISOString(),
              startedAt: new Date(startedAtMs).toISOString(),
              updatedAt: new Date(startedAtMs + 149 * 60_000).toISOString(),
              durationMs: 149 * 60_000,
            }],
            workflows: [],
            usageSnapshots,
            toolCalls: [],
            activity: [],
            planTasks: [],
            compactions: [],
            pullRequestCreations: [],
            efficiencyRuleEvidence: {
              repetition: false,
              concurrentMutation: false,
              unsharedContext: false,
              healthyFallback: false,
              cacheUsageClassification: false,
            },
          },
        };
      },
      async readUsageLimits() {
        return { available: false, fetchedAt: null, attemptedAt: null, limits: [], error: "" };
      },
    },
    async readPullRequests() {
      return { status: "ready", checkedAt: null, items: [] };
    },
  });

  const state = await runtime.analyze("codex:busy-history");
  const firstContextBucket = state.metrics.tokens.contextHistory.buckets.find((bucket) => bucket.total > 0);

  assert.equal(state.metrics.tokens.requestSnapshots.items.length, 100);
  assert.equal(Date.parse(firstContextBucket.start) <= startedAtMs + 10 * 60_000, true);
  assert.equal(state.metrics.tokens.contextHistory.buckets.at(-1).total, 1_159);
  assert.equal(Date.parse(state.metrics.tokens.requestSnapshots.items[0].observedAt) > Date.parse(firstContextBucket.start), true);
});

test("missing and deleted history stays historical without current Git or usage data", async (context) => {
  const { claude, codex } = await syntheticProviders(context);
  let gitCalls = 0;
  let usageCalls = 0;
  const wrappedCodex = { ...codex, async readUsageLimits() { usageCalls += 1; return codex.readUsageLimits(); } };
  const providerRegistry = createProviderRegistry([claude, wrappedCodex]);
  const origin = await startSyntheticMonitor(context, {
    providerRegistry,
    readGitState() { gitCalls += 1; throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    async readPullRequests() { return { status: "ready", checkedAt: null, items: [] }; },
  });
  const response = await fetch(`${origin}/api/state?sessionId=codex%3Adeleted-history`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assertNoPrivateFixtureSentinels(body, "deleted-history API response");
  const state = JSON.parse(body);
  assert.equal(state.view, "history");
  assert.equal(state.error, "The selected session is no longer available.");
  assert.equal(state.session, null);
  assert.equal(state.metrics.resources, null);
  assert.deepEqual(state.usageLimits.limits, []);
  assert.equal(gitCalls, 0);
  assert.equal(usageCalls, 0);
});

test("one provider failure cannot fail the other provider's API catalog or state", async (context) => {
  const { claude, codex } = await syntheticProviders(context);
  const brokenCodex = {
    ...codex,
    async listSessions() { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK"); },
    async readSession() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
  };
  const providerRegistry = createProviderRegistry([claude, brokenCodex]);
  const origin = await startSyntheticMonitor(context, {
    providerRegistry,
    readGitState() { return { available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }; },
    async readPullRequests() { return { status: "ready", checkedAt: null, items: [] }; },
  });
  const [catalogResponse, stateResponse] = await Promise.all([
    fetch(`${origin}/api/sessions`),
    fetch(`${origin}/api/state?sessionId=claude%3Aclaude-fixture-parent`),
  ]);
  assert.equal(catalogResponse.status, 200);
  assert.equal(stateResponse.status, 200);
  const catalog = await catalogResponse.json();
  const state = await stateResponse.json();
  assert.deepEqual(catalog.sessions.map(({ id }) => id), ["claude:claude-fixture-parent"]);
  assert.equal(state.source, "Claude Code");
  assertNoPrivateFixtureSentinels([catalog, state], "provider failure isolation API responses");
});

test("HTTP fallbacks never serialize arbitrary exception messages", async (context) => {
  const { claude } = await syntheticProviders(context);
  const runtime = {
    async sessionFeed() { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK"); },
    async homeSnapshot() { throw new Error("HOME_PRIVATE_PAYLOAD_MUST_NOT_LEAK"); },
    async analyze() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    analyzeEmpty() {
      return {
        connected: false,
        source: claude.source,
        capabilities: claude.capabilities,
        view: "live",
      };
    },
  };
  const origin = await startSyntheticMonitor(context, { runtime });
  const [sessions, state, home, aggregates] = await Promise.all([
    fetch(`${origin}/api/sessions`),
    fetch(`${origin}/api/state`),
    fetch(`${origin}/api/home`),
    fetch(`${origin}/api/home?scope=aggregates`),
  ]);
  assert.equal(sessions.status, 500);
  assert.equal(state.status, 500);
  assert.equal(home.status, 500);
  assert.equal(aggregates.status, 500);
  const [sessionsBody, stateBody, homeBody, aggregatesBody] = await Promise.all([
    sessions.text(), state.text(), home.text(), aggregates.text(),
  ]);
  assert.deepEqual(JSON.parse(homeBody), { generatedAt: null, providerLimits: [], limitActivities: [], projects: [], error: "Home snapshot error" });
  assert.deepEqual(JSON.parse(aggregatesBody), { generatedAt: null, providerLimits: [], limitActivities: [], error: "Home snapshot error" });
  const serialized = `${sessionsBody}\n${stateBody}\n${homeBody}\n${aggregatesBody}`;
  assert.doesNotMatch(serialized, /MUST_NOT_LEAK/);
  assert.match(serialized, /Session catalog error/);
  assert.match(serialized, /Monitor error/);
});
