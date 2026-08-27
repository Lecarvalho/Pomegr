"use client";

import type { ContextHistoryBoundary } from "../../../shared/monitor-contract";
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

export function AgentHistoryIndicators({ agentIds, boundaries, className = "" }: {
  agentIds: string[];
  boundaries: ContextHistoryBoundary[];
  className?: string;
}) {
  const summary = summarizeCompactions(boundaries, agentIds);
  if (summary.total === 0) return null;
  const description = compactionDescription(summary, agentIds.length);
  const displayedCount = summary.total > 99 ? "99+" : String(summary.total);
  return <span className={`agentHistoryIndicators ${className}`.trim()}>
    <AgentChip className="agentHistoryIndicator agentCompactionIndicator" title={description} ariaLabel={description}>
      <svg aria-hidden="true" className="agentHistoryIcon" viewBox="0 0 24 24">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <span aria-hidden="true" className="agentHistoryCount">{displayedCount}</span>
    </AgentChip>
  </span>;
}
