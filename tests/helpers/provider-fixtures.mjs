import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { providerSource, qualifyProviderSessionId } from "../../monitor/providers/provider-contract.mjs";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";

export const PROVIDER_FIXTURE_ROOT = new URL("../fixtures/providers/", import.meta.url);

export const PRIVATE_FIXTURE_SENTINELS = Object.freeze([
  "PROMPT_MUST_NOT_LEAK",
  "ANSWER_MUST_NOT_LEAK",
  "RESPONSE_MUST_NOT_LEAK",
  "REASONING_MUST_NOT_LEAK",
  "DEVELOPER_INSTRUCTIONS_MUST_NOT_LEAK",
  "COMMAND_MUST_NOT_LEAK",
  "PATCH_MUST_NOT_LEAK",
  "STDOUT_MUST_NOT_LEAK",
  "STDERR_MUST_NOT_LEAK",
  "TOOL_OUTPUT_MUST_NOT_LEAK",
  "MCP_ARGUMENT_MUST_NOT_LEAK",
  "OAUTH_TOKEN_MUST_NOT_LEAK",
  "ENV_SECRET_MUST_NOT_LEAK",
  "PRIVATE_PATH_MUST_NOT_LEAK",
]);

export async function readProviderFixture(relativePath) {
  return readFile(new URL(relativePath, PROVIDER_FIXTURE_ROOT), "utf8");
}

export async function readProviderJsonFixture(relativePath) {
  return JSON.parse(await readProviderFixture(relativePath));
}

export async function readProviderJsonlFixture(relativePath) {
  const text = await readProviderFixture(relativePath);
  const records = [];
  const rejectedLines = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      rejectedLines.push({ lineNumber: index + 1, byteLength: Buffer.byteLength(line) });
    }
  }
  return { records, rejectedLines };
}

export function assertNoPrivateFixtureSentinels(value, label = "serialized provider output") {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const sentinel of PRIVATE_FIXTURE_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, `${label} leaked ${sentinel}`);
  }
}

/**
 * @param {"claude" | "codex"} providerId
 * @param {import("../../monitor/providers/provider-contract").ProviderSessionEvidence} evidence
 * @returns {import("../../shared/monitor-contract").MonitorState}
 */
export function monitorStateFromProviderEvidence(providerId, evidence) {
  const source = providerSource(providerId);
  const latestUsage = new Map();
  for (const snapshot of evidence.usageSnapshots) {
    const previous = latestUsage.get(snapshot.actorId);
    if (!previous || Date.parse(snapshot.timestamp) >= Date.parse(previous.timestamp)) latestUsage.set(snapshot.actorId, snapshot);
  }
  const agents = evidence.agents.map((agent) => {
    const snapshot = latestUsage.get(agent.id) || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    return {
      ...agent,
      tokens: {
        total: snapshot.input + snapshot.output + snapshot.cacheWrite + snapshot.cacheRead,
        input: snapshot.input,
        output: snapshot.output,
        cacheWrite: snapshot.cacheWrite,
        cacheRead: snapshot.cacheRead,
      },
    };
  });
  const tokenTotals = agents.reduce((totals, agent) => ({
    allAgents: totals.allAgents + agent.tokens.total,
    input: totals.input + agent.tokens.input,
    output: totals.output + agent.tokens.output,
    cacheWrite: totals.cacheWrite + agent.tokens.cacheWrite,
    cacheRead: totals.cacheRead + agent.tokens.cacheRead,
  }), { allAgents: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  const started = Date.parse(evidence.session.startedAt || "");
  const updated = Date.parse(evidence.session.updatedAt || "");
  const { recordedGitBranch, ...sessionEvidence } = evidence.session;
  const base = createEmptyMonitorState({ connected: true, source, view: evidence.historical ? "history" : "live" });

  return {
    ...base,
    session: {
      ...sessionEvidence,
      id: qualifyProviderSessionId(providerId, evidence.localId),
      repository: {
        available: Boolean(recordedGitBranch),
        branch: recordedGitBranch,
        files: [],
        historical: evidence.historical,
        isMain: false,
        comparison: null,
        commits: [],
        remote: { status: "unavailable", checkedAt: null },
      },
      pullRequests: { status: "ready", checkedAt: null, items: [] },
      durationMs: Number.isFinite(started) && Number.isFinite(updated) ? Math.max(0, updated - started) : 0,
    },
    metrics: {
      agents: agents.length,
      activeAgents: agents.filter((agent) => agent.status === "active" || agent.status === "waiting").length,
      toolCalls: agents.reduce((total, agent) => total + agent.toolCalls, 0),
      repeatedCalls: 0,
      tokens: { ...tokenTotals, contextGrowthTimeline: { bucketMs: 0, buckets: [] } },
    },
    agents,
    toolPatterns: evidence.toolCalls.map((call) => ({
      id: call.id,
      agent: call.actor.label,
      tool: call.tool,
      detail: call.detail,
      calls: 1,
    })),
    activity: evidence.activity,
    executionTasks: agents.find((agent) => agent.id === "primary")?.executionTasks || [],
    planTasks: evidence.planTasks,
  };
}
