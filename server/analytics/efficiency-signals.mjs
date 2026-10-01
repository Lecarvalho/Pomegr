import crypto from "node:crypto";
import {
  AGENT_SIGNAL_MCP_TOOLS,
  AGENT_SIGNAL_TOOL,
  CLEAR_AGENT_SIGNAL_MCP_TOOLS,
  CLEAR_AGENT_SIGNAL_TOOL,
  CLEAR_SESSION_PROGRESS_MCP_TOOLS,
  CLEAR_SESSION_PROGRESS_TOOL,
  CLEAR_SESSION_SIGNAL_MCP_TOOLS,
  CLEAR_SESSION_SIGNAL_TOOL,
  SESSION_PROGRESS_MCP_TOOLS,
  SESSION_PROGRESS_TOOL,
  SESSION_SIGNAL_MCP_TOOLS,
  SESSION_SIGNAL_TOOL,
  TASK_SIGNAL_MCP_TOOLS,
  TASK_SIGNAL_TOOL,
} from "../normalize/session-signals.mjs";

// Pomegr's own reporting tools. Claude keeps the namespaced MCP name as the
// tool; Codex records the tool as `MCP` with a `server / tool` detail. Pomegr
// read tools are deliberately absent: repeating an identical read is polling.
const SESSION_TITLE_TOOL = "rename_session";
const POMEGR_REPORTING_MCP_TOOLS = new Set([
  ...AGENT_SIGNAL_MCP_TOOLS,
  ...SESSION_SIGNAL_MCP_TOOLS,
  ...TASK_SIGNAL_MCP_TOOLS,
  ...CLEAR_AGENT_SIGNAL_MCP_TOOLS,
  ...CLEAR_SESSION_SIGNAL_MCP_TOOLS,
  ...SESSION_PROGRESS_MCP_TOOLS,
  ...CLEAR_SESSION_PROGRESS_MCP_TOOLS,
  `mcp__pomegr__${SESSION_TITLE_TOOL}`,
  `mcp__plugin_pomegr_pomegr__${SESSION_TITLE_TOOL}`,
]);
const POMEGR_REPORTING_CODEX_DETAILS = new Set([
  AGENT_SIGNAL_TOOL,
  SESSION_SIGNAL_TOOL,
  TASK_SIGNAL_TOOL,
  CLEAR_AGENT_SIGNAL_TOOL,
  CLEAR_SESSION_SIGNAL_TOOL,
  SESSION_PROGRESS_TOOL,
  CLEAR_SESSION_PROGRESS_TOOL,
  SESSION_TITLE_TOOL,
].map((tool) => `pomegr / ${tool}`));

function isPomegrReportingToolCall(tool, detail) {
  return POMEGR_REPORTING_MCP_TOOLS.has(tool) || (tool === "MCP" && POMEGR_REPORTING_CODEX_DETAILS.has(detail));
}

export const EFFICIENCY_SIGNAL_RULES = Object.freeze({
  repetition: Object.freeze({ minimumCalls: 3, maximumSignals: 3 }),
  concurrentMutation: Object.freeze({ windowMs: 30_000, maximumSignals: 2 }),
  sharedFileChanges: Object.freeze({ minimumAgents: 2, maximumSignals: 3 }),
  broadFileChanges: Object.freeze({ minimumExclusiveFiles: 20, maximumSignals: 3 }),
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

function agentList(labels) {
  if (labels.length <= 2) return labels.join(" and ");
  if (labels.length === 3) return `${labels[0]}, ${labels[1]}, and ${labels[2]}`;
  return `${labels[0]}, ${labels[1]}, and ${(labels.length - 2).toLocaleString("en-US")} other agents`;
}

// Groups recorded file changes by file within the session. A move touches both
// its previous and new path; only the new path counts toward an agent's breadth.
// Repository-relative paths stay monitor-side: signals carry only the basename
// and an opaque digest of the file key.
function fileChangeFootprints(fileChanges, agentIds) {
  const files = new Map();
  const changedByAgent = new Map();
  const touch = (actorId, repositoryId, filePath) => {
    const key = `${repositoryId || ""}\u0000${filePath}`;
    const file = files.get(key) || { key, name: filePath.split(/[\\/]/u).at(-1), actors: new Set(), changes: 0 };
    file.actors.add(actorId);
    file.changes += 1;
    files.set(key, file);
    return key;
  };
  for (const change of fileChanges) {
    if (!agentIds.has(change?.actorId) || typeof change.path !== "string" || !change.path) continue;
    const key = touch(change.actorId, change.repositoryId, change.path);
    if (typeof change.previousPath === "string" && change.previousPath) touch(change.actorId, change.repositoryId, change.previousPath);
    changedByAgent.set(change.actorId, (changedByAgent.get(change.actorId) || new Set()).add(key));
  }
  return { files, changedByAgent };
}

function fileChangeSignals(agents, fileChanges, overlapDisplays) {
  const labels = new Map(agents.map((agent) => [agent.id, agent.label]));
  const order = new Map(agents.map((agent, index) => [agent.id, index]));
  const { files, changedByAgent } = fileChangeFootprints(fileChanges, new Set(labels.keys()));
  const signals = [];

  const sharedRule = EFFICIENCY_SIGNAL_RULES.sharedFileChanges;
  const shared = [...files.values()]
    .filter((file) => file.actors.size >= sharedRule.minimumAgents && !overlapDisplays.has(file.name.toLowerCase()))
    .sort((a, b) => b.actors.size - a.actors.size || b.changes - a.changes || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  for (const file of shared.slice(0, sharedRule.maximumSignals)) {
    const actorLabels = [...file.actors].sort((a, b) => order.get(a) - order.get(b)).map((id) => labels.get(id));
    signals.push({
      id: `shared-file-${crypto.createHash("sha256").update(file.key).digest("hex").slice(0, 12)}`,
      agentId: null,
      level: "warning",
      title: `${file.actors.size.toLocaleString("en-US")} agents changed ${file.name}`,
      detail: `${agentList(actorLabels)} each recorded changes to this file in this session (${file.changes.toLocaleString("en-US")} recorded changes). Check that their assignments did not overlap; a planned handoff such as a review fix also produces this pattern.`,
    });
  }

  const broadRule = EFFICIENCY_SIGNAL_RULES.broadFileChanges;
  const broad = agents
    .map((agent) => ({
      agent,
      files: [...(changedByAgent.get(agent.id) || [])].filter((key) => files.get(key).actors.size === 1).length,
    }))
    .filter((item) => item.files >= broadRule.minimumExclusiveFiles)
    .sort((a, b) => b.files - a.files || order.get(a.agent.id) - order.get(b.agent.id));
  for (const { agent, files: count } of broad.slice(0, broadRule.maximumSignals)) signals.push({
    id: `broad-file-changes-${agent.id}`,
    agentId: agent.id,
    level: "warning",
    title: `${agent.label} changed ${count.toLocaleString("en-US")} files alone`,
    detail: "No other agent recorded a change to any of these files in this session. Consider splitting broad work into bounded tasks that are easier to review or delegate.",
  });

  return signals;
}

// This is the executable catalog for every rule shown in Efficiency signals.
// Keep thresholds, evidence, severity, and user-facing explanations together so
// rule changes remain reviewable and deterministic.
export function evaluateEfficiencySignals({
  agents = [],
  repetitionCandidates = [],
  overlaps = [],
  fileChanges = [],
  compactions = [],
  cacheEvents = [],
  availableEvidence,
} = {}) {
  const evidence = availableEvidence === undefined
    ? ALL_RULE_EVIDENCE
    : Object.fromEntries(Object.keys(ALL_RULE_EVIDENCE).map((key) => [key, availableEvidence?.[key] === true]));
  // Repeated Pomegr status reports are requested by the reporting policy, not loops.
  const loops = (evidence.repetition ? repetitionCandidates : [])
    .filter((item) => item.count >= EFFICIENCY_SIGNAL_RULES.repetition.minimumCalls && !isPomegrReportingToolCall(item.tool, item.detail))
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
  const shownOverlaps = (evidence.concurrentMutation ? overlaps : []).slice(0, overlapRule.maximumSignals);
  for (const overlap of shownOverlaps) insights.push({
    id: `overlap-${overlap.display}`,
    agentId: null,
    level: "warning",
    title: `Concurrent edits may conflict in ${overlap.display}`,
    detail: `${overlap.actors.size} agents modified the same region within ${overlapRule.windowMs / 1_000} seconds across ${overlap.calls} calls.`,
  });

  insights.push(...fileChangeSignals(agents, fileChanges, new Set(shownOverlaps.map((overlap) => overlap.display.toLowerCase()))));

  if (!insights.length && evidence.healthyFallback) insights.push({
    id: "healthy-flow",
    level: "info",
    title: "No obvious loops right now",
    detail: "Tool activity is varied and agent overlap remains low. The coach will stay quiet unless that changes.",
  });

  return { insights, loops };
}
