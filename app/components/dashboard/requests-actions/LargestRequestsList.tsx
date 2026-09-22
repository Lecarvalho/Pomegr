import { useState } from "react";
import type { Agent } from "../../../../shared/monitor-contract";
import { agentDisplayName, compactNumber, requestTokenTitle } from "../../../dashboard-utils";
import { largestRequests, requestMarker, type LargestSort, type RequestRow } from "./model";

const SORTS: LargestSort[] = ["uncachedInput", "cacheWrite", "total", "output"];
const SORT_LABELS = { uncachedInput: "uncached input", cacheWrite: "cache write", total: "total", output: "output" };
const SORT_KEYS = { uncachedInput: "uncachedInputTokens", cacheWrite: "cacheWriteTokens", total: "totalTokens", output: "outputTokens" } as const;
const LIMIT = 3;

/** One wrapping line under the minimap: the metric cycles in place, and each item selects its request. */
export function LargestRequestsList({ rows, agents, selectedId, cacheWriteAvailable, onSelect }: {
  rows: RequestRow[]; agents: Agent[]; selectedId: string | null; cacheWriteAvailable: boolean; onSelect: (row: RequestRow) => void;
}) {
  const [sort, setSort] = useState<LargestSort>("uncachedInput");
  const resolvedSort = !cacheWriteAvailable && sort === "cacheWrite" ? "total" : sort;
  const sorts = SORTS.filter((value) => cacheWriteAvailable || value !== "cacheWrite");
  const valueKey = SORT_KEYS[resolvedSort];
  // A request with none of the metric is not among the largest, so a sparse metric lists fewer items.
  const largest = largestRequests(rows, resolvedSort, LIMIT).filter((row) => row[valueKey] > 0);
  const sortLabel = SORT_LABELS[resolvedSort];
  return <section className="requestsActionsLargest" aria-label="Largest requests">
    <button type="button" className="commandQuietAction requestsActionsLargestSort" title="Change ranking metric" onClick={() => setSort(sorts[(sorts.indexOf(resolvedSort) + 1) % sorts.length])}>Largest by {sortLabel}</button>
    {largest.map((row) => {
      const agent = agents.find((candidate) => candidate.id === row.agentId);
      const name = agent ? agentDisplayName(agent) : "Unknown agent";
      return <button type="button" key={row.id} className={`commandQuietAction requestsActionsLargestRow${selectedId === row.id ? " isSelected" : ""}`} aria-pressed={selectedId === row.id}
        aria-label={`Locate request ${requestMarker(row)}, ${name}, ${row[valueKey].toLocaleString()} ${sortLabel}`} onClick={() => onSelect(row)}>
        <span className="requestsActionsNumber requestsActionsLargestMarker">{requestMarker(row)}</span>
        <span className="requestsActionsLargestName" title={name}>{name}</span>
        <span className="requestsActionsNumber requestsActionsLargestValue" title={requestTokenTitle(`${sortLabel[0].toUpperCase()}${sortLabel.slice(1)}`, row[valueKey])}>{compactNumber(row[valueKey])}</span>
      </button>;
    })}
  </section>;
}
