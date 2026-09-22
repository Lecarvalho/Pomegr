import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "../../../../shared/monitor-contract";
import { compactNumber, shortTime } from "../../../dashboard-utils";
import { requestMarker, type ChartMode, type RequestRow } from "./model";
import { cacheEvidenceLabel } from "./cache-evidence";
import { CacheRefillIcon } from "../CacheRefillIcon";
import { requestAgentRole, RequestRoleTrack } from "./RequestRoleTrack";
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

export type BandLabel = {
  key: string; kind: "selected" | "evidence" | "compaction"; text: string; x: number; anchor: "start" | "middle" | "end";
  /** Estimated horizontal extent the label occupies. */
  start: number; end: number;
};

const LABEL_PAD = 4;

/**
 * Lays out the text row of a band above the bars: the hovered, focused or selected cache-evidence
 * label (right of its icon when it fits), the selected request marker, then compaction text.
 * Evidence icons (`marker` wide) are fixed obstacles; a label that cannot clear them and earlier
 * labels inside `[left, right]` is dropped instead of overlapping. Lanes and the phone chart use it.
 */
export function placeBandLabels(entries: { row: RequestRow; index: number }[], { barX, width, left, right, gap = 3, marker = 14 }: {
  barX: (index: number) => number; width: number; left: number; right: number; gap?: number; marker?: number;
}, selectedId: string | null, labeled: RequestRow | undefined): BandLabel[] {
  const center = (index: number) => barX(index) + width / 2;
  const taken = entries.filter(({ row }) => row.cacheEvidence).map(({ index }) => [center(index) - marker / 2, center(index) + marker / 2]);
  const placed: BandLabel[] = [];
  const place = (label: Pick<BandLabel, "key" | "kind" | "text">, charWidth: number, candidates: Pick<BandLabel, "x" | "anchor">[]) => {
    const size = label.text.length * charWidth;
    for (const candidate of candidates) {
      const start = candidate.anchor === "start" ? candidate.x : candidate.anchor === "end" ? candidate.x - size : candidate.x - size / 2;
      if (start < left || start + size > right || taken.some(([from, to]) => start < to + LABEL_PAD && start + size + LABEL_PAD > from)) continue;
      taken.push([start, start + size]);
      placed.push({ ...label, ...candidate, start, end: start + size });
      return;
    }
  };
  const side = marker / 2 + LABEL_PAD;
  const evidence = labeled && entries.find(({ row }) => row === labeled);
  if (evidence?.row.cacheEvidence) {
    const x = center(evidence.index);
    place({ key: "evidence", kind: "evidence", text: cacheEvidenceLabel(evidence.row.cacheEvidence, true) }, 6.5, [{ x: x + side, anchor: "start" }, { x: x - side, anchor: "end" }]);
  }
  const selected = entries.find(({ row }) => row.id === selectedId);
  if (selected) {
    const x = center(selected.index);
    place({ key: "selected", kind: "selected", text: requestMarker(selected.row) }, 7, [{ x, anchor: "middle" }, { x: x - side, anchor: "end" }, { x: x + side, anchor: "start" }]);
  }
  for (const { row, index } of entries) {
    if (!row.compactionBefore) continue;
    const boundary = barX(index) - gap / 2;
    place({ key: `compaction-${row.id}`, kind: "compaction", text: "compaction" }, 6, [{ x: boundary + 3, anchor: "start" }, { x: boundary - 3, anchor: "end" }]);
  }
  return placed;
}

/** Draws placed band labels on one baseline; decorative, since bars carry the same facts in their names. */
export function RequestBandLabels({ labels, y }: { labels: BandLabel[]; y: number }) {
  return <>{labels.map((label) => {
    const text = <text key={label.key} aria-hidden="true" className={label.kind === "selected" ? "requestsActionsSelectedLabel" : label.kind === "evidence" ? "requestsActionsRefillLabel" : undefined} x={label.x} y={y} textAnchor={label.anchor}>{label.text}</text>;
    return label.kind === "compaction" ? <g key={label.key} className="requestsActionsCompaction">{text}</g> : text;
  })}</>;
}

/**
 * One request bar shared by the single chart and the lanes: stacked request-local segments,
 * selection, compaction boundary, and the cache-evidence marker drawn in the `band` above `top`.
 * `marker` sizes that icon; without `labels` the caller places the compaction and selected text.
 * `agent` names the request's agent in the accessible name where no lane label already does.
 */
export function RequestBar({ row, x, width, gap, top, bottom, right, band, marker = 16, labels = true, agent, maximum, mode, cacheWriteAvailable, selected, onSelect, onHover, onFocus }: {
  row: RequestRow; x: number; width: number; gap: number; top: number; bottom: number; right: number; band: number;
  marker?: number; labels?: boolean; agent?: string;
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
    aria-pressed={selected} aria-label={`Request ${requestMarker(row)}, ${agent ? `${agent}, ` : ""}${row.uncachedInputTokens.toLocaleString()} uncached input, ${cacheWriteAvailable ? `${row.cacheWriteTokens.toLocaleString()} cache write, ` : ""}${row.cacheReadTokens.toLocaleString()} cache read, ${row.outputTokens.toLocaleString()} output${row.cacheEvidence ? `, ${cacheEvidenceLabel(row.cacheEvidence)}` : ""}`}
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
      {/* One string child: React's server renderer emits an empty <title> for several children. */}
      <title>{`${cacheEvidenceLabel(row.cacheEvidence)} · request ${requestMarker(row)}`}</title>
      <line x1={x + width / 2} x2={x + width / 2} y1={top - band + marker + 10} y2={bottom} />
      <g transform={`translate(${x + width / 2 - marker / 2} ${top - band + 2})`}><CacheRefillIcon size={marker} inferred={row.cacheEvidence.kind !== "refill"} /></g>
    </g>}
    {labels && selected && <text className="requestsActionsSelectedLabel" x={x + width / 2} y={Math.max(Math.min(16, top), barTop - 8)} textAnchor="middle">{requestMarker(row)}</text>}
  </g>;
}

/**
 * The single chart. With `agents` it draws the role-family agent track under the bars, names each
 * bar's agent, and reports the hovered or focused request through `onInspect`.
 */
export function RequestBarsChart({ rows, start, end, size, maximum, mode, selectedId, phone, cacheWriteAvailable, onSelect, onStep, windowStart, total, onMove, agents, onInspect }: {
  rows: RequestRow[]; start: number; end: number; size: number; maximum: number; mode: ChartMode;
  selectedId: string | null; phone: boolean; cacheWriteAvailable: boolean;
  onSelect: (row: RequestRow) => void; onStep: (delta: number) => void;
  windowStart: number; total: number; onMove: (start: number) => void;
  agents?: Agent[]; onInspect?: (id: string | null) => void;
}) {
  const chartRef = useRef<SVGSVGElement>(null);
  const drag = useRequestChartDrag(phone, windowStart, total, size, onMove);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  useEffect(() => onInspect?.(hoveredId ?? focusedId), [hoveredId, focusedId, onInspect]);
  const focusSelection = useRef(false);
  useLayoutEffect(() => {
    if (!focusSelection.current) return;
    focusSelection.current = false;
    chartRef.current?.querySelector<SVGGElement>('[aria-pressed="true"]')?.focus();
  });
  const left = phone ? 34 : 56;
  const right = phone ? 330 : 1100;
  const top = phone ? 50 : 54;
  // The agent track takes a strip between the bars and the axis labels.
  const track = agents ? { gap: 3, height: phone ? 3 : 4 } : null;
  const bottom = (phone ? 178 : 250) - (track ? track.gap * 2 + track.height : 0);
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
  // Phone reserves a text row just above the plot top that bars never reach. Compaction, selected
  // and evidence text share it and drop out rather than overlap on the narrow chart.
  const bandLabels = phone ? placeBandLabels(visible.map((row, index) => ({ row, index })), { barX: (index) => left + step * index, width, left, right, gap, marker: 16 }, selectedId, labeledRow) : null;
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
    {visible.map((row, index) => <RequestBar key={row.id} row={row} x={left + step * index} width={width} gap={gap} top={top} bottom={bottom} right={right} band={44} labels={!phone}
      agent={agents && requestAgentRole(row, agents).name} maximum={maximum} mode={mode} cacheWriteAvailable={cacheWriteAvailable} selected={row.id === selectedId} onSelect={onSelect} onHover={setHoveredId} onFocus={setFocusedId} />)}
    {agents && track && <RequestRoleTrack rows={visible} agents={agents} barX={(index) => left + step * index} width={width} y={bottom + track.gap} height={track.height} />}
    {bandLabels && <RequestBandLabels labels={bandLabels} y={top - 6} />}
    {!bandLabels && labeledRow?.cacheEvidence && <text aria-hidden="true" className="requestsActionsRefillLabel" x={labelStart} y={top - 43} textAnchor="start">{labelText}</text>}
    <g className="requestsActionsAxis">
      {axisLabels.map((label) => <text key={label.index} x={label.x} y={phone ? 192 : 266} textAnchor={label.anchor}>{label.text}</text>)}
    </g>
  </svg>;
}
