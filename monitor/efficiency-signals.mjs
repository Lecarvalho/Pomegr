export const EFFICIENCY_SIGNAL_RULES = Object.freeze({
  repetition: Object.freeze({ minimumCalls: 3, maximumSignals: 3 }),
  concurrentMutation: Object.freeze({ windowMs: 30_000, maximumSignals: 2 }),
  automaticCompaction: Object.freeze({ trigger: "auto", maximumSignals: 3 }),
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

function cacheMissSignals(agents, cacheEvents, enabled) {
  if (!enabled) return [];
  const labels = new Map(agents.map((agent) => [agent.id, agent.label]));
  const emittedAgents = new Set();
  const signals = [];
  for (const event of cacheEvents) {
    if (event?.kind !== "miss_refill" || emittedAgents.has(event.agentId) || !labels.has(event.agentId)) continue;
    emittedAgents.add(event.agentId);
    signals.push({
      id: `prompt-cache-miss-${event.agentId}`,
      agentId: event.agentId,
      level: "warning",
      title: "Prompt cache miss and refill after idle gap",
      detail: `${labels.get(event.agentId)}'s prompt input was ${compactContext(event.promptInputTokens)} with ${event.cacheReadPercent}% read from cache after ${compactElapsed(event.gapMs)}. The preceding comparable request read ${event.previousCacheReadPercent}% from cache, and the provider recorded an ${compactContext(event.cacheWriteTokens)} cache refill. Cache expiration or eviction may have reduced efficiency, but a changed prefix, cache key, or routing can produce the same pattern.`,
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
  cacheEvents = [],
  availableEvidence,
} = {}) {
  const evidence = availableEvidence === undefined
    ? ALL_RULE_EVIDENCE
    : Object.fromEntries(Object.keys(ALL_RULE_EVIDENCE).map((key) => [key, availableEvidence?.[key] === true]));
  const loops = (evidence.repetition ? repetitionCandidates : [])
    .filter((item) => item.count >= EFFICIENCY_SIGNAL_RULES.repetition.minimumCalls)
    .sort((a, b) => b.count - a.count);
  const insights = [];

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
    const event = latest.inferred
      ? `Codex compacted context during an active task and resumed that task${context}. Pomegr classifies this recorded lifecycle as automatic; this rollout did not persist the provider trigger itself.`
      : observed.length === 1
        ? `The provider automatically compacted this agent's conversation${context}.`
        : `The provider automatically compacted this agent's conversation${occurrence}${context}.`;
    insights.push({
      id: `automatic-compaction-${agent.id}`,
      agentId: agent.id,
      level: "warning",
      title: `${agent.label} context was automatically compacted`,
      detail: `${event} Earlier conversation detail was summarized to continue the session. Consider delegating or starting a focused follow-up before context pressure builds again.`,
    });
    automaticCompactionSignals += 1;
  }

  insights.push(...cacheMissSignals(agents, cacheEvents, evidence.cacheUsageClassification));

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
    agentId: loop.actor.id,
    level: "warning",
    title: `${loop.actor.label} repeated ${loop.tool} ${loop.count} times`,
    detail: loop.detail ? `The same scoped call (${loop.detail}) recurred with unchanged inputs. Check whether it produced new evidence.` : "The same call recurred with unchanged inputs. Check whether it is making progress.",
  });

  const overlapRule = EFFICIENCY_SIGNAL_RULES.concurrentMutation;
  for (const overlap of (evidence.concurrentMutation ? overlaps : []).slice(0, overlapRule.maximumSignals)) insights.push({
    id: `overlap-${overlap.display}`,
    agentId: null,
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
