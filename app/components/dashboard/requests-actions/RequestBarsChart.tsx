import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { compactNumber, shortTime } from "../../../dashboard-utils";
import { requestMarker, type ChartMode, type RequestRow } from "./model";
import { cacheEvidenceLabel } from "./cache-evidence";
import { CacheRefillIcon } from "../CacheRefillIcon";
import { useRequestChartDrag } from "./useRequestChartDrag";

export type AxisLabel = { index: number; text: string; x: number; anchor: "middle" | "end"; left: number; right: number };

/** Places request markers under the endpoints, then the middle bar with its time when it fits. */
export function placeAxisLabels(visible: RequestRow[], barCenter: (index: number) => number, withMiddle: boolean, limit: number): AxisLabel[] {
  const axisLabels: AxisLabel[] = [];
  // Reserve endpoints first, then fit the timestamp between them. Use a
  // conservative width for the caption-size monospace text in SVG coordinates.
  const middleIndex = Math.floor(visible.length / 2);
  for (const index of [visible.length - 1, 0, ...(withMiddle && visible.length > 2 ? [middleIndex] : [])]) {
    const row = visible[index];
    if (!row || axisLabels.some((label) => label.index === index)) continue;
    const text = `${requestMarker(row)}${!row.numberPending && index === middleIndex && index > 0 && index < visible.length - 1 ? ` · ${shortTime(row.observedAt)}` : ""}`;
    const labelWidth = text.length * 8;
    const x = barCenter(index);
    const anchor = x + labelWidth / 2 > limit ? "end" : "middle";
    const labelLeft = x - (anchor === "end" ? labelWidth : labelWidth / 2);
    const labelRight = labelLeft + labelWidth;
    if (axisLabels.some((label) => labelLeft < label.right + 8 && labelRight + 8 > label.left)) continue;
    axisLabels.push({ index, text, x, anchor, left: labelLeft, right: labelRight });
  }
  return axisLabels.sort((a, b) => a.index - b.index);
}

/** The hovered, focused or selected row whose cache evidence gets a text label. */
export function labeledEvidenceRow(rows: RequestRow[], ids: (string | null)[]) {
  return ids.map((id) => rows.find((row) => row.id === id && row.cacheEvidence)).find((row) => row !== undefined);
}

/**
 * One request bar shared by the single chart and the lanes: stacked request-local segments,
 * selection, compaction boundary, and the cache-evidence marker drawn in the `band` above `top`.
 * `marker` sizes that icon; without `labels` the caller places the compaction and selected text.
 */
export function RequestBar({ row, x, width, gap, top, bottom, right, band, marker = 16, labels = true, maximum, mode, cacheWriteAvailable, selected, onSelect, onHover, onFocus }: {
  row: RequestRow; x: number; width: number; gap: number; top: number; bottom: number; right: number; band: number;
  marker?: number; labels?: boolean;
  maximum: number; mode: ChartMode; cacheWriteAvailable: boolean; selected: boolean;
  onSelect: (row: RequestRow) => void; onHover: (id: string | null) => void; onFocus: (id: string | null) => void;
}) {
  const height = (value: number) => value / maximum * (bottom - top);
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
  const barTop = bottom - height(stacked);
  return <g className={`requestsActionsBar${selected ? " isSelected" : ""}`} role="button" tabIndex={0}
    aria-pressed={selected} aria-label={`Request ${requestMarker(row)}, ${row.uncachedInputTokens.toLocaleString()} uncached input, ${cacheWriteAvailable ? `${row.cacheWriteTokens.toLocaleString()} cache write, ` : ""}${row.cacheReadTokens.toLocaleString()} cache read, ${row.outputTokens.toLocaleString()} output${row.cacheEvidence ? `, ${cacheEvidenceLabel(row.cacheEvidence)}` : ""}`}
    onPointerEnter={() => onHover(row.id)} onPointerLeave={() => onHover(null)}
    onFocus={() => onFocus(row.id)} onBlur={() => onFocus(null)}
    onClick={() => onSelect(row)} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row); }
    }}>
    <rect className="requestsActionsHit" x={x - gap / 2} y={row.cacheEvidence ? top - band : top} width={width + gap} height={bottom - top + (row.cacheEvidence ? band : 0)} />
    {stack}
    {selected && <rect className="requestsActionsSelection" x={x} y={barTop} width={width} height={Math.max(1, height(stacked))} />}
    {row.compactionBefore && <g className="requestsActionsCompaction"><line x1={x - gap / 2} x2={x - gap / 2} y1={top} y2={bottom} />{labels && <text x={x < right - 75 ? x : x - 65} y={top - 8}>compaction</text>}</g>}
    {row.cacheEvidence && <g className={`requestsActionsRefill${row.cacheEvidence.kind !== "refill" ? " isInferred" : ""}`}>
      <title>{cacheEvidenceLabel(row.cacheEvidence)} · request {requestMarker(row)}</title>
      <line x1={x + width / 2} x2={x + width / 2} y1={top - band + marker + 10} y2={bottom} />
      <g transform={`translate(${x + width / 2 - marker / 2} ${top - band + 2})`}><CacheRefillIcon size={marker} inferred={row.cacheEvidence.kind !== "refill"} /></g>
    </g>}
    {labels && selected && <text className="requestsActionsSelectedLabel" x={x + width / 2} y={Math.max(Math.min(16, top), barTop - 8)} textAnchor="middle">{requestMarker(row)}</text>}
  </g>;
}

export function RequestBarsChart({ rows, start, end, size, maximum, mode, selectedId, phone, cacheWriteAvailable, onSelect, onStep, windowStart, total, onMove }: {
  rows: RequestRow[]; start: number; end: number; size: number; maximum: number; mode: ChartMode;
  selectedId: string | null; phone: boolean; cacheWriteAvailable: boolean;
  onSelect: (row: RequestRow) => void; onStep: (delta: number) => void;
  windowStart: number; total: number; onMove: (start: number) => void;
}) {
  const chartRef = useRef<SVGSVGElement>(null);
  const drag = useRequestChartDrag(phone, windowStart, total, size, onMove);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusSelection = useRef(false);
  useLayoutEffect(() => {
    if (!focusSelection.current) return;
    focusSelection.current = false;
    chartRef.current?.querySelector<SVGGElement>('[aria-pressed="true"]')?.focus();
  });
  const left = phone ? 34 : 56;
  const right = phone ? 330 : 1100;
  const top = phone ? 50 : 54;
  const bottom = phone ? 178 : 250;
  const gap = phone ? 2.8 : 3;
  const step = (right - left + gap) / size;
  const width = step - gap;
  const visible = rows.slice(start - 1, end);
  const barCenter = (index: number) => left + step * index + width / 2;
  const axisLabels = placeAxisLabels(visible, barCenter, !phone, phone ? 334 : 1112);
  const labeledRow = labeledEvidenceRow(visible, [hoveredId, focusedId, selectedId]);
  const labelX = labeledRow ? barCenter(visible.indexOf(labeledRow)) : left;
  const labelText = labeledRow?.cacheEvidence ? cacheEvidenceLabel(labeledRow.cacheEvidence, true) : "";
  const labelStart = Math.max(left, Math.min(labelX + 12, right - labelText.length * 6));
  const keyboardStep = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    focusSelection.current = true;
    onStep(event.key === "ArrowLeft" ? -1 : 1);
  };
  return <svg className="requestsActionsChart" viewBox={phone ? "0 0 334 196" : "0 0 1112 274"}
    ref={chartRef} role="group" aria-label={`Model requests, positions ${windowStart} to ${Math.min(total, windowStart + size - 1)}`} onKeyDown={keyboardStep} {...drag}>
    {(phone ? [0, .5, 1] : [0, .25, .5, .75, 1]).map((fraction) => <g key={fraction} className="requestsActionsAxis">
      <line x1={left} x2={right} y1={bottom - fraction * (bottom - top)} y2={bottom - fraction * (bottom - top)} />
      <text x={left - 6} y={bottom - fraction * (bottom - top) + 4} textAnchor="end">{compactNumber(maximum * fraction)}</text>
    </g>)}
    {visible.map((row, index) => <RequestBar key={row.id} row={row} x={left + step * index} width={width} gap={gap} top={top} bottom={bottom} right={right} band={44}
      maximum={maximum} mode={mode} cacheWriteAvailable={cacheWriteAvailable} selected={row.id === selectedId} onSelect={onSelect} onHover={setHoveredId} onFocus={setFocusedId} />)}
    {labeledRow?.cacheEvidence && <text aria-hidden="true" className="requestsActionsRefillLabel" x={labelStart} y={top - 43} textAnchor="start">{labelText}</text>}
    <g className="requestsActionsAxis">
      {axisLabels.map((label) => <text key={label.index} x={label.x} y={phone ? 192 : 266} textAnchor={label.anchor}>{label.text}</text>)}
    </g>
  </svg>;
}
