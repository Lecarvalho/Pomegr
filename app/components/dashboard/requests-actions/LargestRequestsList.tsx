import { largestRequests, requestMarker, type RequestRow } from "./model";

export function LargestRequestsList({ rows, scopeLabel, selectedId, onSelect }: {
  rows: RequestRow[]; scopeLabel: string; selectedId: string | null; onSelect: (row: RequestRow) => void;
}) {
  const largest = largestRequests(rows, "uncachedInput", 5);
  const valueKey = "uncachedInputTokens";
  const maximum = largest[0]?.[valueKey] || 1;
  return <section className="requestsActionsLargest" aria-label="Largest requests">
    <header><h3 className="sessionEyebrow" title="Ranked by uncached input">Largest requests <span>· {scopeLabel}</span></h3></header>
    <div>{largest.map((row) => {
      return <button type="button" key={row.id} className={`commandQuietAction requestsActionsLargestRow${selectedId === row.id ? " isSelected" : ""}`} aria-pressed={selectedId === row.id}
        aria-label={`Locate request ${requestMarker(row)}, ${row[valueKey].toLocaleString()} uncached input`} onClick={() => onSelect(row)}>
        <span className="requestsActionsNumber">{requestMarker(row)}</span>
        <span className="requestsActionsLargestBar"><i aria-hidden="true" style={{ width: `${row[valueKey] / maximum * 100}%` }} /></span>
        <span className="requestsActionsNumber">{row[valueKey].toLocaleString()}</span>
      </button>;
    })}</div>
  </section>;
}
