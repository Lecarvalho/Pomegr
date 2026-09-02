import { isRunningAgent } from "./agent-metadata.mjs";
import { buildRequestModelObservations } from "./request-snapshots.mjs";
import { buildProviderTokenUsage } from "./session-projection.mjs";
import { projectSessionActivityFallback, projectSessionCurrentActivity } from "./session-current-activity.mjs";

export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function homeSessionSummary(entry, evidence, homePolicy) {
  if (!evidence?.session) return null;
  const agents = Array.isArray(evidence.agents) ? evidence.agents.map((agent) => ({ ...agent })) : [];
  const primaryAgent = agents.find((agent) => agent.id === "primary");
  const usageSnapshots = Array.isArray(evidence.usageSnapshots) ? evidence.usageSnapshots : [];
  const tokenUsage = buildProviderTokenUsage(
    agents,
    usageSnapshots,
    evidence.session.startedAt,
    evidence.session.updatedAt,
    entry.id,
    Array.isArray(evidence.compactions) ? evidence.compactions : [],
  );
  const startedAt = Date.parse(evidence.session.startedAt || "");
  const updatedAt = Date.parse(evidence.session.updatedAt || "");
  const wallTimeMs = Number.isFinite(startedAt) && Number.isFinite(updatedAt)
    ? Math.max(0, updatedAt - startedAt)
    : null;
  return {
    id: entry.id,
    provider: entry.provider,
    source: entry.source,
    title: entry.title,
    project: entry.project,
    updatedAt: entry.updatedAt,
    recordedUpdatedAt: evidence.session.updatedAt || entry.updatedAt,
    needsInput: Boolean(entry.needsInput),
    activityStatus: entry.activityStatus || "unknown",
    agentCount: agents.length,
    activeAgentCount: agents.filter(isRunningAgent).length,
    latestContextTotal: Number.isFinite(tokenUsage.allAgents) ? tokenUsage.allAgents : null,
    contextHistory: tokenUsage.contextHistory,
    progress: evidence.session.progress ?? null,
    currentActivity: projectSessionCurrentActivity(entry, primaryAgent),
    activityFallback: projectSessionActivityFallback(entry, agents, evidence.toolCalls),
    lastObservedActivity: projectSessionActivityFallback({ ...entry, isLive: false }, agents, evidence.toolCalls),
    isLive: Boolean(entry.isLive),
    createdAt: evidence.session.startedAt,
    requestObservationsAvailable: true,
    requestObservations: tokenUsage.requestSnapshots.items.map(({ id, observedAt }) => ({ id, observedAt })),
    requestModelObservations: homePolicy?.requestModelObservations
      ? buildRequestModelObservations({ sessionId: entry.id, agents, usageSnapshots })
      : [],
    usageLimitRejections: Array.isArray(evidence.usageLimitRejections)
      ? evidence.usageLimitRejections.map(({ observedAt, resetsAt }) => ({ observedAt, resetsAt }))
      : [],
    wallTimeMs,
    resources: null,
  };
}

export function unavailableHomeSessionSummary(entry) {
  return {
    id: entry.id,
    provider: entry.provider,
    source: entry.source,
    title: entry.title,
    project: entry.project,
    updatedAt: entry.updatedAt,
    recordedUpdatedAt: entry.updatedAt,
    needsInput: Boolean(entry.needsInput),
    activityStatus: entry.activityStatus || "unknown",
    agentCount: null,
    activeAgentCount: null,
    latestContextTotal: null,
    contextHistory: null,
    progress: null,
    currentActivity: null,
    activityFallback: null,
    lastObservedActivity: null,
    isLive: Boolean(entry.isLive),
    createdAt: null,
    requestObservationsAvailable: false,
    requestObservations: [],
    requestModelObservations: [],
    usageLimitRejections: [],
    wallTimeMs: null,
    resources: null,
  };
}
