"use client";

import type { CacheRefillCount, CacheRefillReason, CacheToolChangeAttributionCount, ContextHistoryBoundary } from "../../../shared/monitor-contract";
import { AgentChip } from "../AgentChip";

export type CompactionSummary = {
  automatic: number;
  manual: number;
  total: number;
};

export function summarizeCompactions(boundaries: ContextHistoryBoundary[], agentIds: string[]): CompactionSummary {
  const observedAgents = new Set(agentIds);
  let automatic = 0;
  let manual = 0;
  for (const boundary of boundaries) {
    if (!observedAgents.has(boundary.agentId)) continue;
    if (boundary.kind === "automatic_compaction") automatic += 1;
    if (boundary.kind === "manual_compaction") manual += 1;
  }
  return { automatic, manual, total: automatic + manual };
}

export function compactionDescription(summary: CompactionSummary, representedAgents = 1) {
  const count = `${summary.total} ${summary.total === 1 ? "compaction" : "compactions"}`;
  const scope = representedAgents > 1 ? ` across ${representedAgents} agents` : "";
  const kinds = [
    summary.automatic > 0 ? `${summary.automatic} automatic` : "",
    summary.manual > 0 ? `${summary.manual} manual` : "",
  ].filter(Boolean).join(" · ");
  return `${count}${scope}${kinds ? ` · ${kinds}` : ""}.`;
}

export function summarizeCacheRefills(cacheRefills: CacheRefillCount[], agentIds: string[]) {
  const observedAgents = new Set(agentIds);
  return cacheRefills.reduce((count, refill) => observedAgents.has(refill.agentId) ? count + refill.count : count, 0);
}

const CACHE_REFILL_REASON_LABELS: Record<CacheRefillReason, string> = {
  model_changed: "model configuration changed",
  system_changed: "system instructions changed",
  tools_changed: "tool definitions changed",
  messages_changed: "message history changed",
};

const CACHE_TOOL_CHANGE_CAUSE_LABELS: Record<CacheToolChangeAttributionCount["cause"], string> = {
  remote_control_connected: "Remote Control connected",
};
const CACHE_TOOL_NAMES = new Set(["RemoteTrigger", "PushNotification", "ListAgents"]);
const CACHE_TOOL_CHANGE_KIND_LABELS = {
  added: "added",
  definition_changed: "definition changed",
} as const;

export function summarizeCacheRefillReasons(cacheRefills: CacheRefillCount[], agentIds: string[]) {
  const observedAgents = new Set(agentIds);
  const counts = new Map<CacheRefillReason, number>();
  for (const refill of cacheRefills) {
    if (!observedAgents.has(refill.agentId)) continue;
    for (const item of refill.reasons || []) {
      if (!Object.hasOwn(CACHE_REFILL_REASON_LABELS, item.reason) || !Number.isSafeInteger(item.count) || item.count <= 0) continue;
      counts.set(item.reason, (counts.get(item.reason) || 0) + item.count);
    }
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => ({ reason, count }));
}

export function summarizeCacheToolChangeAttributions(cacheRefills: CacheRefillCount[], agentIds: string[]) {
  const observedAgents = new Set(agentIds);
  const attributions = new Map<CacheToolChangeAttributionCount["cause"], CacheToolChangeAttributionCount>();
  for (const refill of cacheRefills) {
    if (!observedAgents.has(refill.agentId)) continue;
    for (const attribution of refill.toolChangeAttributions || []) {
      if (!Object.hasOwn(CACHE_TOOL_CHANGE_CAUSE_LABELS, attribution.cause)
        || !Number.isSafeInteger(attribution.count)
        || attribution.count <= 0) continue;
      const changes = (attribution.changes || []).filter((change) => (
        CACHE_TOOL_NAMES.has(change.tool) && Object.hasOwn(CACHE_TOOL_CHANGE_KIND_LABELS, change.kind)
      ));
      const previous = attributions.get(attribution.cause);
      attributions.set(attribution.cause, {
        cause: attribution.cause,
        count: (previous?.count || 0) + attribution.count,
        changes: previous?.changes || changes,
      });
    }
  }
  return [...attributions.values()].sort((left, right) => left.cause.localeCompare(right.cause));
}

export function cacheRefillDescription(
  count: number,
  representedAgents = 1,
  reasons: ReturnType<typeof summarizeCacheRefillReasons> = [],
  toolChangeAttributions: ReturnType<typeof summarizeCacheToolChangeAttributions> = [],
) {
  const occurrences = count === 1 ? "1 time" : `${count} times`;
  const scope = representedAgents > 1 ? ` across ${representedAgents} agents` : "";
  const diagnosed = reasons.reduce((total, item) => total + item.count, 0);
  const reasonText = reasons.map(({ reason, count: reasonCount }) => (
    `${CACHE_REFILL_REASON_LABELS[reason]}${reasonCount > 1 ? ` (${reasonCount})` : ""}`
  )).join(" · ");
  const unavailable = Math.max(0, count - diagnosed);
  const evidence = [reasonText, unavailable > 0 ? `reason unavailable${unavailable > 1 ? ` (${unavailable})` : ""}` : ""].filter(Boolean).join(" · ");
  const inference = toolChangeAttributions.map((attribution) => {
    const cause = CACHE_TOOL_CHANGE_CAUSE_LABELS[attribution.cause];
    const causeCount = attribution.count > 1 ? ` (${attribution.count} refills)` : "";
    const changes = attribution.changes.map((change) => `${change.tool} (${CACHE_TOOL_CHANGE_KIND_LABELS[change.kind]})`).join(", ");
    return `${cause}${causeCount}${changes ? `; likely changed ${changes}` : ""}`;
  }).join(" · ");
  return `Possible full cache refill observed ${occurrences}${scope}.${evidence ? ` Provider diagnostic: ${evidence}.` : " Reason unavailable."}${inference ? ` Pomegr inference: ${inference}.` : ""}`;
}

export function AgentHistoryIndicators({ agentIds, boundaries, cacheRefills = [], className = "" }: {
  agentIds: string[];
  boundaries: ContextHistoryBoundary[];
  cacheRefills?: CacheRefillCount[];
  className?: string;
}) {
  const summary = summarizeCompactions(boundaries, agentIds);
  const cacheRefillCount = summarizeCacheRefills(cacheRefills, agentIds);
  const cacheRefillReasons = summarizeCacheRefillReasons(cacheRefills, agentIds);
  const cacheToolChangeAttributions = summarizeCacheToolChangeAttributions(cacheRefills, agentIds);
  if (summary.total === 0 && cacheRefillCount === 0) return null;
  return <span className={`agentHistoryIndicators ${className}`.trim()}>
    {summary.total > 0 && <AgentChip className="agentHistoryIndicator agentCompactionIndicator" title={compactionDescription(summary, agentIds.length)} ariaLabel={compactionDescription(summary, agentIds.length)}>
      <svg aria-hidden="true" className="agentHistoryIcon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
      <span aria-hidden="true" className="agentHistoryCount">{summary.total > 99 ? "99+" : summary.total}</span>
    </AgentChip>}
    {cacheRefillCount > 0 && <AgentChip className="agentHistoryIndicator agentCacheRefillIndicator" title={cacheRefillDescription(cacheRefillCount, agentIds.length, cacheRefillReasons, cacheToolChangeAttributions)} ariaLabel={cacheRefillDescription(cacheRefillCount, agentIds.length, cacheRefillReasons, cacheToolChangeAttributions)}>
      <svg aria-hidden="true" className="agentHistoryIcon agentCacheRefillIcon" viewBox="0 0 24 24">
        <path d="M12 2.5v8M8.5 7l3.5 3.5L15.5 7M4 14h16M6.5 18h11M9 22h6" />
      </svg>
      <span aria-hidden="true" className="agentHistoryCount">{cacheRefillCount > 99 ? "99+" : cacheRefillCount}</span>
    </AgentChip>}
  </span>;
}
