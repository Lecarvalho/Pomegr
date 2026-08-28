"use client";

import type { CacheRefillCount, ContextHistoryBoundary } from "../../../shared/monitor-contract";
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

export function cacheRefillDescription(count: number, representedAgents = 1) {
  const occurrences = count === 1 ? "1 time" : `${count} times`;
  const scope = representedAgents > 1 ? ` across ${representedAgents} agents` : "";
  return `Possible full cache refill observed ${occurrences}${scope}.`;
}

export function AgentHistoryIndicators({ agentIds, boundaries, cacheRefills = [], className = "" }: {
  agentIds: string[];
  boundaries: ContextHistoryBoundary[];
  cacheRefills?: CacheRefillCount[];
  className?: string;
}) {
  const summary = summarizeCompactions(boundaries, agentIds);
  const cacheRefillCount = summarizeCacheRefills(cacheRefills, agentIds);
  if (summary.total === 0 && cacheRefillCount === 0) return null;
  return <span className={`agentHistoryIndicators ${className}`.trim()}>
    {summary.total > 0 && <AgentChip className="agentHistoryIndicator agentCompactionIndicator" title={compactionDescription(summary, agentIds.length)} ariaLabel={compactionDescription(summary, agentIds.length)}>
      <svg aria-hidden="true" className="agentHistoryIcon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
      <span aria-hidden="true" className="agentHistoryCount">{summary.total > 99 ? "99+" : summary.total}</span>
    </AgentChip>}
    {cacheRefillCount > 0 && <AgentChip className="agentHistoryIndicator agentCacheRefillIndicator" title={cacheRefillDescription(cacheRefillCount, agentIds.length)} ariaLabel={cacheRefillDescription(cacheRefillCount, agentIds.length)}>
      <svg aria-hidden="true" className="agentHistoryIcon agentCacheRefillIcon" viewBox="0 0 24 24">
        <path d="M12 2.5v8M8.5 7l3.5 3.5L15.5 7M4 14h16M6.5 18h11M9 22h6" />
      </svg>
      <span aria-hidden="true" className="agentHistoryCount">{cacheRefillCount > 99 ? "99+" : cacheRefillCount}</span>
    </AgentChip>}
  </span>;
}
