import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { compactNumber, shortTime } from "../../../dashboard-utils";
import type { ChartMode, RequestRow } from "./model";

export function RequestBarsChart({ rows, start, end, size, maximum, mode, selectedId, phone, cacheWriteAvailable, onSelect, onStep }: {
  rows: RequestRow[]; start: number; end: number; size: number; maximum: number; mode: ChartMode;
  selectedId: string | null; phone: boolean; cacheWriteAvailable: boolean;
  onSelect: (row: RequestRow) => void; onStep: (delta: number) => void;
}) {
  const chartRef = useRef<SVGSVGElement>(null);
  const focusSelection = useRef(false);
  useLayoutEffect(() => {
    if (!focusSelection.current) return;
    focusSelection.current = false;
    chartRef.current?.querySelector<SVGGElement>('[aria-pressed="true"]')?.focus();
  });
  const left = phone ? 34 : 56;
  const right = phone ? 330 : 1100;
  const top = phone ? 22 : 26;
  const bottom = phone ? 150 : 222;
  const gap = phone ? 2.8 : 3;
  const step = (right - left + gap) / size;
  const width = step - gap;
  const height = (value: number) => value / maximum * (bottom - top);
  const visible = rows.slice(start - 1, end);
  const keyboardStep = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    focusSelection.current = true;
    onStep(event.key === "ArrowLeft" ? -1 : 1);
  };
  return <svg className="requestsActionsChart" viewBox={phone ? "0 0 334 168" : "0 0 1112 246"}
    ref={chartRef} role="group" aria-label={`Model requests, positions ${start} to ${end}`} onKeyDown={keyboardStep}>
    {(phone ? [0, .5, 1] : [0, .25, .5, .75, 1]).map((fraction) => <g key={fraction} className="requestsActionsAxis">
      <line x1={left} x2={right} y1={bottom - fraction * (bottom - top)} y2={bottom - fraction * (bottom - top)} />
      <text x={left - 6} y={bottom - fraction * (bottom - top) + 4} textAnchor="end">{compactNumber(maximum * fraction)}</text>
    </g>)}
    {visible.map((row, index) => {
      const x = left + step * index;
      const selected = row.id === selectedId;
      const segments = [
        { kind: "uncached", value: row.uncachedInputTokens },
        ...(cacheWriteAvailable ? [{ kind: "write", value: row.cacheWriteTokens }] : []),
        ...(mode === "full" ? [{ kind: "read", value: row.cacheReadTokens }] : []),
        { kind: "output", value: row.outputTokens },
      ];
      let stacked = 0;
      const stack = segments.map(({ kind, value }) => {
        stacked += value;
        return <rect key={kind} className={`requestsActionsSegment ${kind}`} x={x} y={bottom - height(stacked)} width={width} height={height(value)} />;
      });
      return <g key={row.id} className={`requestsActionsBar${selected ? " isSelected" : ""}`} role="button" tabIndex={0}
        aria-pressed={selected} aria-label={`Request #${row.ordinal}, ${row.uncachedInputTokens.toLocaleString()} uncached input, ${cacheWriteAvailable ? `${row.cacheWriteTokens.toLocaleString()} cache write, ` : ""}${row.cacheReadTokens.toLocaleString()} cache read, ${row.outputTokens.toLocaleString()} output`}
        onClick={() => onSelect(row)} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row); }
        }}>
        <rect className="requestsActionsHit" x={x - gap / 2} y={top} width={step} height={bottom - top} />
        {mode === "fresh" && <rect className="requestsActionsOutline" x={x} y={bottom - height(row.promptTokens)} width={width} height={height(row.promptTokens)} />}
        {stack}
        {selected && <rect className="requestsActionsSelection" x={x} y={bottom - height(Math.max(stacked, mode === "fresh" ? row.promptTokens : 0))} width={width} height={Math.max(1, height(Math.max(stacked, mode === "fresh" ? row.promptTokens : 0)))} />}
        {row.compactionBefore && <g className="requestsActionsCompaction"><line x1={x - gap / 2} x2={x - gap / 2} y1={top} y2={bottom} /><text x={x < right - 75 ? x : x - 65} y={top - 8}>compaction</text></g>}
        {selected && <text className="requestsActionsSelectedLabel" x={Math.min(right - 16, Math.max(left + 16, x + width / 2))} y={Math.max(top + 10, bottom - height(Math.max(stacked, row.promptTokens))) - 5} textAnchor="middle">#{row.ordinal}</text>}
      </g>;
    })}
    <g className="requestsActionsAxis">
      <text x={left} y={phone ? 164 : 238}>#{start}</text>
      {!phone && visible.length > 2 && <text x={(left + right) / 2} y={238} textAnchor="middle">#{visible[Math.floor(visible.length / 2)].ordinal} · {shortTime(visible[Math.floor(visible.length / 2)].observedAt)}</text>}
      <text x={right} y={phone ? 164 : 238} textAnchor="end">#{end}</text>
    </g>
  </svg>;
}
