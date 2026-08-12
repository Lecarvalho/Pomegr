export const EFFICIENCY_SIGNAL_RULES = Object.freeze({
  repetition: Object.freeze({ minimumCalls: 3, maximumSignals: 3 }),
  concurrentMutation: Object.freeze({ windowMs: 30_000, maximumSignals: 2 }),
  automaticCompaction: Object.freeze({ trigger: "auto", maximumSignals: 3 }),
  promptCacheMissAfterIdle: Object.freeze({
    minimumInputContext: 8_000,
    minimumPreviousCacheReadShare: 0.8,
    maximumCurrentCacheReadShare: 0.1,
    minimumIdleMs: 30 * 60 * 1_000,
    minimumColdRefillTokens: 8_000,
    maximumSignalsPerAgent: 1,
  }),
  unsharedContextPressure: Object.freeze({
    minimumPrimaryContext: 150_000,
    minimumPrimaryToolCalls: 40,
  }),
});

const ALL_RULE_EVIDENCE = Object.freeze({
  repetition: true,
  concurrentMutation: true,
  unsharedContext: true,
  healthyFallback: true,
  cacheUsageClassification: true,
});

function compactContext(tokens) {
  return `${(tokens / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
}

function cacheReadShare(snapshot) {
  const inputContext = snapshot.input + snapshot.cacheRead;
  return inputContext > 0 ? snapshot.cacheRead / inputContext : null;
}

function compactElapsed(milliseconds) {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 120) return `${minutes.toLocaleString("en-US")} minutes`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours.toLocaleString("en-US", { maximumFractionDigits: 1 })} hours`;
}

function compactionActorId(compaction) {
  const value = compaction?.actorId ?? compaction?.actor?.id;
  return typeof value === "string" ? value : "";
}

function promptCacheMissSignals({ agents, usageSnapshots, compactions, enabled }) {
  if (!enabled) return [];
  const rule = EFFICIENCY_SIGNAL_RULES.promptCacheMissAfterIdle;
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const uniqueSnapshots = new Map();
  for (const snapshot of usageSnapshots) {
    if (!snapshot || typeof snapshot.dedupeId !== "string") continue;
    const previous = uniqueSnapshots.get(snapshot.dedupeId);
    if (!previous || Date.parse(snapshot.timestamp) >= Date.parse(previous.timestamp)) {
      uniqueSnapshots.set(snapshot.dedupeId, snapshot);
    }
  }
  const byAgent = new Map();
  for (const snapshot of uniqueSnapshots.values()) {
    if (!agentsById.has(snapshot.actorId)) continue;
    byAgent.set(snapshot.actorId, [...(byAgent.get(snapshot.actorId) || []), snapshot]);
  }

  const signals = [];
  for (const agent of agents) {
    if (agent.kind === "fork") continue;
    const snapshots = (byAgent.get(agent.id) || []).sort((left, right) => (
      Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId)
    ));
    let latestMatch = null;
    for (let index = 1; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1];
      const current = snapshots[index];
      const previousTime = Date.parse(previous.timestamp);
      const currentTime = Date.parse(current.timestamp);
      const elapsed = currentTime - previousTime;
      const currentInputContext = current.input + current.cacheRead;
      const previousShare = cacheReadShare(previous);
      const currentShare = cacheReadShare(current);
      const comparable = Number.isFinite(previousTime)
        && Number.isFinite(currentTime)
        && elapsed >= rule.minimumIdleMs
        && Number.isSafeInteger(previous.comparisonGroup)
        && previous.comparisonGroup === current.comparisonGroup
        && typeof previous.model === "string"
        && previous.model.length > 0
        && previous.model === current.model
        && !compactions.some((compaction) => (
          compactionActorId(compaction) === agent.id
          && Date.parse(compaction.timestamp) > previousTime
          && Date.parse(compaction.timestamp) <= currentTime
        ));
      if (!comparable
        || currentInputContext < rule.minimumInputContext
        || previousShare < rule.minimumPreviousCacheReadShare
        || currentShare > rule.maximumCurrentCacheReadShare) continue;
      latestMatch = { current, currentInputContext, currentShare, elapsed, previousShare };
    }
    if (!latestMatch) continue;
    const refill = latestMatch.current.cacheWrite >= rule.minimumColdRefillTokens
      ? " The provider also recorded a large cache refill on the current request."
      : "";
    signals.push({
      id: `prompt-cache-miss-${agent.id}`,
      level: "warning",
      title: "Prompt cache miss after idle gap",
      detail: `${agent.label}'s current input context was ${compactContext(latestMatch.currentInputContext)} with ${Math.round(latestMatch.currentShare * 100)}% read from cache after ${compactElapsed(latestMatch.elapsed)}. The preceding comparable request read ${Math.round(latestMatch.previousShare * 100)}% from cache.${refill} Cache expiration or eviction may have reduced efficiency, but a changed prefix, cache key, or routing can produce the same pattern.`,
    });
  }
  return signals;
}

// This is the executable catalog for every rule shown in Efficiency signals.
// Keep thresholds, evidence, severity, and user-facing explanations together so
// rule changes remain reviewable and deterministic.
export function evaluateEfficiencySignals({
  agents = [],
  repetitionCandidates = [],
  overlaps = [],
  compactions = [],
  usageSnapshots = [],
  availableEvidence,
} = {}) {
  const evidence = availableEvidence === undefined
    ? ALL_RULE_EVIDENCE
    : Object.fromEntries(Object.keys(ALL_RULE_EVIDENCE).map((key) => [key, availableEvidence?.[key] === true]));
  const loops = (evidence.repetition ? repetitionCandidates : [])
    .filter((item) => item.count >= EFFICIENCY_SIGNAL_RULES.repetition.minimumCalls)
    .sort((a, b) => b.count - a.count);
  const insights = [];

  for (const agent of agents.filter((item) => item.status === "needs_input")) insights.push({
    id: `needs-input-${agent.id}`,
    level: "warning",
    title: `${agent.label} needs your input`,
    detail: "A user-input request is waiting for a response.",
  });

  const compactionRule = EFFICIENCY_SIGNAL_RULES.automaticCompaction;
  const automaticCompactionsByAgent = new Map();
  for (const compaction of compactions.filter((item) => item.trigger === compactionRule.trigger)) {
    const actorId = compactionActorId(compaction);
    if (!actorId) continue;
    automaticCompactionsByAgent.set(actorId, [
      ...(automaticCompactionsByAgent.get(actorId) || []),
      compaction,
    ]);
  }
  let automaticCompactionSignals = 0;
  for (const agent of agents) {
    if (automaticCompactionSignals >= compactionRule.maximumSignals) break;
    const observed = automaticCompactionsByAgent.get(agent.id) || [];
    if (!observed.length) continue;
    const latest = observed.at(-1);
    const occurrence = observed.length === 1 ? "" : ` ${observed.length.toLocaleString("en-US")} times; the latest boundary was recorded`;
    const context = latest.preTokens === null ? "" : ` at ${compactContext(latest.preTokens)} context`;
    const event = observed.length === 1
      ? `The provider automatically compacted this agent's conversation${context}.`
      : `The provider automatically compacted this agent's conversation${occurrence}${context}.`;
    insights.push({
      id: `automatic-compaction-${agent.id}`,
      level: "warning",
      title: `${agent.label} context was automatically compacted`,
      detail: `${event} Earlier conversation detail was summarized to continue the session. Consider delegating or starting a focused follow-up before context pressure builds again.`,
    });
    automaticCompactionSignals += 1;
  }

  insights.push(...promptCacheMissSignals({
    agents,
    usageSnapshots,
    compactions,
    enabled: evidence.cacheUsageClassification,
  }));

  const primary = agents.find((agent) => agent.id === "primary");
  const hasObservedSubagent = agents.some((agent) => agent.id !== "primary");
  const contextRule = EFFICIENCY_SIGNAL_RULES.unsharedContextPressure;
  if (
    evidence.unsharedContext
    && primary
    && !hasObservedSubagent
    && primary.tokens?.total >= contextRule.minimumPrimaryContext
    && primary.toolCalls >= contextRule.minimumPrimaryToolCalls
  ) insights.push({
    id: "unshared-context-pressure",
    level: "warning",
    title: "Large primary context, no delegation observed",
    detail: `The primary agent's current context is ${compactContext(primary.tokens.total)} after ${primary.toolCalls.toLocaleString("en-US")} tool calls. No subagent transcript was observed. Consider delegating the next bounded, independent task.`,
  });

  for (const [loopIndex, loop] of loops.slice(0, EFFICIENCY_SIGNAL_RULES.repetition.maximumSignals).entries()) insights.push({
    id: `loop-${loop.actor.id}-${loopIndex}`,
    level: "warning",
    title: `${loop.actor.label} repeated ${loop.tool} ${loop.count} times`,
    detail: loop.detail ? `The same scoped call (${loop.detail}) recurred with unchanged inputs. Check whether it produced new evidence.` : "The same call recurred with unchanged inputs. Check whether it is making progress.",
  });

  const overlapRule = EFFICIENCY_SIGNAL_RULES.concurrentMutation;
  for (const overlap of (evidence.concurrentMutation ? overlaps : []).slice(0, overlapRule.maximumSignals)) insights.push({
    id: `overlap-${overlap.display}`,
    level: "warning",
    title: `Concurrent edits may conflict in ${overlap.display}`,
    detail: `${overlap.actors.size} agents modified the same region within ${overlapRule.windowMs / 1_000} seconds across ${overlap.calls} calls.`,
  });

  if (!insights.length && evidence.healthyFallback) insights.push({
    id: "healthy-flow",
    level: "info",
    title: "No obvious loops right now",
    detail: "Tool activity is varied and agent overlap remains low. The coach will stay quiet unless that changes.",
  });

  return { insights, loops };
}
