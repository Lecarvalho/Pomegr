import crypto from "node:crypto";
import { recentActivityEvents, shellFailureActivityEvents } from "./activity-events.mjs";
import { isRunningAgent } from "./agent-metadata.mjs";
import { resolveAgentRole } from "./agent-roles.mjs";
import { buildCacheEvidence } from "./cache-events.mjs";
import { buildCacheReadDrops } from "./cache-read-drops.mjs";
import { buildSessionReportEvidence } from "./session-report-evidence.mjs";
import { buildContextHistory } from "./context-history.mjs";
import { EFFICIENCY_SIGNAL_RULES, evaluateEfficiencySignals } from "./efficiency-signals.mjs";
import { buildRequestSnapshots } from "./request-snapshots.mjs";
import { concurrentMutationOverlaps } from "./tool-efficiency.mjs";
import { normalizedWorkKind, toolWorkKind } from "./work-kind.mjs";

function groupToolEvidence(toolCalls) {
  const repetitionMap = new Map();
  const patternMap = new Map();
  const mutationEvents = [];
  for (const call of toolCalls) {
    const repetitionKey = `${call.actor.id}|${call.repetitionSignature}`;
    const repetition = repetitionMap.get(repetitionKey);
    repetitionMap.set(repetitionKey, {
      count: (repetition?.count || 0) + 1,
      actor: call.actor,
      tool: call.tool,
      detail: call.detail,
      sig: call.repetitionSignature,
    });
    const patternKey = `${call.actor.id}|${call.tool}|${call.detail}`;
    const pattern = patternMap.get(patternKey);
    patternMap.set(patternKey, {
      count: (pattern?.count || 0) + 1,
      actor: call.actor,
      tool: call.tool,
      detail: call.detail,
    });
    if (call.mutation) mutationEvents.push({
      actorId: call.actor.id,
      timestamp: call.timestamp,
      display: call.mutation.display,
      scopes: call.mutation.scopes,
    });
  }
  return {
    repetitionCandidates: [...repetitionMap.values()],
    groupedTools: [...patternMap.values()].sort((a, b) => b.count - a.count),
    mutationEvents,
  };
}

function aggregateCacheLifetime(snapshots) {
  const lifetimes = new Set();
  for (const snapshot of snapshots) {
    if (snapshot.cacheLifetime === "mixed") return "mixed";
    if (["5m", "1h", "30m+"].includes(snapshot.cacheLifetime)) lifetimes.add(snapshot.cacheLifetime);
  }
  return lifetimes.size > 1 ? "mixed" : lifetimes.values().next().value || null;
}

function publicInsight(insight) {
  const { id, level, title, detail, agentId } = insight;
  return {
    id,
    level,
    title,
    detail,
    ...(typeof agentId === "string" || agentId === null ? { agentId } : {}),
  };
}

export function buildProviderTokenUsage(agents, usageSnapshots, startedAt, updatedAt, sessionId, compactions) {
  const snapshotsById = new Map(usageSnapshots.map((snapshot) => [`${snapshot.actorId}\u0000${snapshot.dedupeId}`, snapshot]));
  const visibleAgentIds = new Set(agents.map((agent) => agent.id));
  const boundedByAgent = new Map();
  for (const snapshot of snapshotsById.values()) {
    if (!visibleAgentIds.has(snapshot.actorId)) continue;
    boundedByAgent.set(snapshot.actorId, [...(boundedByAgent.get(snapshot.actorId) || []), snapshot]);
  }
  const snapshots = [...boundedByAgent.values()].flatMap((items) => items
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId)));
  const latestByAgent = new Map();
  for (const usage of snapshots) {
    const usageTime = new Date(usage.timestamp).getTime();
    const previous = latestByAgent.get(usage.actorId);
    const snapshotTotal = usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
    if (snapshotTotal > 0 && (!previous || usageTime >= new Date(previous.timestamp).getTime())) {
      latestByAgent.set(usage.actorId, usage);
    }
  }
  for (const agent of agents) {
    const latest = latestByAgent.get(agent.id) || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const total = latest.input + latest.output + latest.cacheWrite + latest.cacheRead;
    agent.tokens = {
      input: latest.input,
      output: latest.output,
      cacheWrite: latest.cacheWrite,
      cacheRead: latest.cacheRead,
      total,
      ...(Number.isFinite(latest.reasoningOutput) ? { reasoningOutput: latest.reasoningOutput } : {}),
      ...(Number.isFinite(latest.modelContextWindow) ? { modelContextWindow: latest.modelContextWindow } : {}),
    };
    agent.cacheLifetime = aggregateCacheLifetime(boundedByAgent.get(agent.id) || []);
  }
  return {
    allAgents: agents.reduce((total, agent) => total + agent.tokens.total, 0),
    input: agents.reduce((total, agent) => total + agent.tokens.input, 0),
    output: agents.reduce((total, agent) => total + agent.tokens.output, 0),
    cacheWrite: agents.reduce((total, agent) => total + agent.tokens.cacheWrite, 0),
    cacheRead: agents.reduce((total, agent) => total + agent.tokens.cacheRead, 0),
    contextHistory: buildContextHistory(snapshots, {
      startedAt,
      updatedAt,
      sessionId,
      agentIds: agents.map((agent) => agent.id),
      compactions,
    }),
    cacheEvents: { status: "unavailable", items: [], possibleFullRefills: [] },
    cacheReadDrops: { status: "unavailable", items: [] },
    requestSnapshots: buildRequestSnapshots({ sessionId, agents, usageSnapshots }),
  };
}

/**
 * Project already-sanitized provider evidence into the browser-safe MonitorState.
 * All environment-dependent values are explicit inputs so fixtures and runtime
 * reads exercise the same deterministic transformation.
 */
export function projectProviderSessionEvidence({
  evidence,
  sessionId,
  source,
  capabilities,
  repositoryRoles = null,
  repository,
  pullRequests,
  usageLimits,
  resources = null,
}) {
  const historical = evidence.historical;
  const agents = evidence.agents.map(({ kind, ...agent }) => {
    const normalized = {
      workflowId: null,
      workflowPhaseId: null,
      workflowOrder: null,
      workflowState: null,
      assignment: null,
      ...agent,
    };
    return {
      ...normalized,
      executionTasks: (normalized.executionTasks || []).map((task) => ({
        ...task,
        workKind: normalizedWorkKind(task.workKind),
      })),
      role: resolveAgentRole({
        id: normalized.id,
        kind,
        workflowId: normalized.workflowId,
        repositoryRoles,
      }),
    };
  });
  const compactions = evidence.compactions.map((compaction) => ({
    ...compaction,
    actor: {
      id: compaction.actorId,
      label: agents.find((agent) => agent.id === compaction.actorId)?.label || "Agent",
    },
  }));
  const tokenUsage = buildProviderTokenUsage(
    agents,
    evidence.usageSnapshots,
    evidence.session.startedAt,
    evidence.session.updatedAt,
    sessionId,
    compactions,
  );
  const { groupedTools, repetitionCandidates, mutationEvents } = groupToolEvidence(evidence.toolCalls);
  const overlaps = concurrentMutationOverlaps(mutationEvents, EFFICIENCY_SIGNAL_RULES.concurrentMutation.windowMs);
  const cacheEvidence = buildCacheEvidence({
    sessionId,
    agents,
    usageSnapshots: evidence.usageSnapshots,
    compactions,
    enabled: evidence.efficiencyRuleEvidence.cacheUsageClassification,
  });
  tokenUsage.cacheEvents = cacheEvidence.feed;
  tokenUsage.cacheReadDrops = buildCacheReadDrops({ sessionId, agents, usageSnapshots: evidence.usageSnapshots, compactions });
  tokenUsage.reportEvidence = buildSessionReportEvidence({
    sessionId, agents, usageSnapshots: evidence.usageSnapshots,
    compactions, cacheEvidence, capabilities,
  });
  const { insights, loops } = evaluateEfficiencySignals({
    agents,
    repetitionCandidates,
    overlaps,
    compactions,
    cacheEvents: tokenUsage.cacheEvents.items,
    availableEvidence: evidence.efficiencyRuleEvidence,
  });
  const repeatedCalls = loops.reduce((total, item) => total + item.count - 1, 0);
  const toolPatterns = groupedTools.map((item) => ({
    id: crypto.createHash("sha1").update(`${item.actor.id}|${item.tool}|${item.detail}`).digest("hex").slice(0, 12),
    agent: item.actor.label,
    tool: item.tool,
    detail: item.detail,
    calls: item.count,
  }));
  const loopPatterns = loops.map((loop, loopIndex) => ({
    id: `loop-${loop.actor.id}-${loopIndex}`,
    agent: loop.actor.label,
    agentId: loop.actor.id,
    tool: loop.tool,
    detail: loop.detail,
    calls: loop.count,
    repeats: loop.count - 1,
  }));
  const allEvents = [
    ...evidence.activity,
    ...evidence.toolCalls.map((call) => ({
      id: call.id,
      timestamp: call.timestamp,
      actor: call.actor.label,
      tool: call.tool,
      workKind: normalizedWorkKind(call.workKind, toolWorkKind(call.tool, { detail: call.detail })),
      detail: call.detail,
      status: call.status === "failed" ? "failed" : null,
    })),
  ];
  const executionTasks = agents.find((agent) => agent.id === "primary")?.executionTasks || [];
  const primaryActor = agents.find((agent) => agent.id === "primary")?.label || "Primary agent";
  allEvents.push(...shellFailureActivityEvents(executionTasks, primaryActor));

  const score = Math.max(25, 100 - Math.min(45, repeatedCalls * 4) - Math.min(25, overlaps.length * 7));
  const activeAgents = agents.filter(isRunningAgent).length;
  agents.sort((a, b) => (a.id === "primary" ? -1 : b.id === "primary" ? 1 : new Date(b.lastSeen) - new Date(a.lastSeen)));

  return {
    connected: true,
    source,
    capabilities,
    view: historical ? "history" : "live",
    session: {
      id: sessionId,
      title: evidence.session.title,
      project: evidence.session.project,
      cwd: evidence.session.cwd,
      repository,
      pullRequests,
      startedAt: evidence.session.startedAt,
      updatedAt: evidence.session.updatedAt,
      durationMs: evidence.session.startedAt && evidence.session.updatedAt
        ? Math.max(0, new Date(evidence.session.updatedAt).getTime() - new Date(evidence.session.startedAt).getTime())
        : 0,
      cost: evidence.session.cost,
      approvalMode: evidence.session.approvalMode,
      contextMachinery: evidence.session.contextMachinery,
      summary: evidence.session.summary,
      signal: evidence.session.signal,
      progress: evidence.session.progress ?? null,
      pomegrPlugin: evidence.session.pomegrPlugin ?? null,
    },
    score,
    metrics: {
      agents: agents.length,
      activeAgents,
      toolCalls: agents.reduce((total, agent) => total + agent.toolCalls, 0),
      repeatedCalls,
      resources: historical ? null : resources,
      tokens: tokenUsage,
    },
    agents,
    workflows: evidence.workflows || [],
    toolPatterns,
    loops: loopPatterns,
    activity: recentActivityEvents(allEvents),
    executionTasks,
    planTasks: evidence.planTasks,
    insights: insights.map(publicInsight),
    usageLimits,
  };
}
