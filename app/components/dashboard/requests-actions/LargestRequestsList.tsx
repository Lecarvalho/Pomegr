import { useState } from "react";
import type { Agent } from "../../../../shared/monitor-contract";
import { agentDisplayName, compactNumber } from "../../../dashboard-utils";
import { WORK_LABELS } from "../../agents/agent-presentation";
import { largestRequests, type LargestSort, type RequestRow } from "./model";

const SORTS: LargestSort[] = ["uncachedInput", "output", "cacheWrite", "total"];
const SORT_LABELS = { uncachedInput: "uncached input", output: "output", cacheWrite: "cache write", total: "total" };
const SORT_KEYS = { uncachedInput: "uncachedInputTokens", output: "outputTokens", cacheWrite: "cacheWriteTokens", total: "totalTokens" } as const;

export function LargestRequestsList({ rows, agents, selectedId, phone, cacheWriteAvailable, onSelect }: {
  rows: RequestRow[]; agents: Agent[]; selectedId: string | null; phone: boolean; cacheWriteAvailable: boolean; onSelect: (row: RequestRow) => void;
}) {
  const [sort, setSort] = useState<LargestSort>("uncachedInput");
  const [expanded, setExpanded] = useState(false);
  const resolvedSort = !cacheWriteAvailable && sort === "cacheWrite" ? "total" : sort;
  const sorts = SORTS.filter((value) => cacheWriteAvailable || value !== "cacheWrite");
  const largest = largestRequests(rows, resolvedSort, expanded ? 20 : phone ? 3 : 5);
  const valueKey = SORT_KEYS[resolvedSort];
  const maximum = largest[0]?.[valueKey] || 1;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return <section className="requestsActionsLargest" aria-label="Largest requests">
    <header><h3 className="sessionEyebrow">Largest requests</h3><button type="button" className="requestsActionsButton" onClick={() => setSort(sorts[(sorts.indexOf(resolvedSort) + 1) % sorts.length])}>by {SORT_LABELS[resolvedSort]}</button></header>
    <div>{largest.map((row) => {
      const agent = byId.get(row.agentId);
      return <button type="button" key={row.id} className={`requestsActionsLargestRow${selectedId === row.id ? " isSelected" : ""}`} aria-pressed={selectedId === row.id}
        aria-label={`Locate request #${row.ordinal}, ${agent ? agentDisplayName(agent) : "Unknown agent"}`} onClick={() => onSelect(row)}>
        <span className="requestsActionsNumber">#{row.ordinal.toLocaleString()}</span>
        <span className="requestsActionsLargestIdentity"><strong>{agent ? agentDisplayName(agent) : "Unknown agent"}</strong>
          <small>before: {row.precedingWork.length ? row.precedingWork.map(({ kind, count }) => `${WORK_LABELS[kind]}${count > 1 ? ` ×${count}` : ""}`).join(", ") : "none recorded"}</small>
          <i aria-hidden="true" style={{ width: `${row[valueKey] / maximum * 100}%` }} />
        </span>
        <span className="requestsActionsNumber">{compactNumber(row[valueKey])}</span>
      </button>;
    })}</div>
    <footer><span>{phone ? `All ${rows.length.toLocaleString()} · never summed` : "Individual request measurements, never summed"}</span><button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? `Show ${phone ? 3 : 5}` : "Show 20"}</button></footer>
  </section>;
}
