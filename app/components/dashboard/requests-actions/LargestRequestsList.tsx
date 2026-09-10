import { useState } from "react";
import { largestRequests, requestMarker, type LargestSort, type RequestRow } from "./model";

const SORTS: LargestSort[] = ["uncachedInput", "output", "cacheWrite", "total"];
const SORT_LABELS = { uncachedInput: "uncached input", output: "output", cacheWrite: "cache write", total: "total" };
const SORT_KEYS = { uncachedInput: "uncachedInputTokens", output: "outputTokens", cacheWrite: "cacheWriteTokens", total: "totalTokens" } as const;

export function LargestRequestsList({ rows, scopeLabel, selectedId, cacheWriteAvailable, onSelect }: {
  rows: RequestRow[]; scopeLabel: string; selectedId: string | null; cacheWriteAvailable: boolean; onSelect: (row: RequestRow) => void;
}) {
  const [sort, setSort] = useState<LargestSort>("uncachedInput");
  const resolvedSort = !cacheWriteAvailable && sort === "cacheWrite" ? "total" : sort;
  const sorts = SORTS.filter((value) => cacheWriteAvailable || value !== "cacheWrite");
  const largest = largestRequests(rows, resolvedSort, 5);
  const valueKey = SORT_KEYS[resolvedSort];
  const sortLabel = SORT_LABELS[resolvedSort];
  const maximum = largest[0]?.[valueKey] || 1;
  return <section className="requestsActionsLargest" aria-label="Largest requests">
    <header><h3 className="sessionEyebrow">Largest requests <span>· {scopeLabel}</span></h3>
      <button type="button" className="commandQuietAction" title="Change ranking metric" onClick={() => setSort(sorts[(sorts.indexOf(resolvedSort) + 1) % sorts.length])}>by {sortLabel}</button>
    </header>
    <div>{largest.map((row) => {
      return <button type="button" key={row.id} className={`commandQuietAction requestsActionsLargestRow${selectedId === row.id ? " isSelected" : ""}`} aria-pressed={selectedId === row.id}
        aria-label={`Locate request ${requestMarker(row)}, ${row[valueKey].toLocaleString()} ${sortLabel}`} onClick={() => onSelect(row)}>
        <span className="requestsActionsNumber">{requestMarker(row)}</span>
        <span className="requestsActionsLargestBar"><i aria-hidden="true" style={{ width: `${row[valueKey] / maximum * 100}%` }} /></span>
        <span className="requestsActionsNumber">{row[valueKey].toLocaleString()}</span>
      </button>;
    })}</div>
  </section>;
}
