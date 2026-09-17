import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "../../../../shared/monitor-contract";
import { agentDisplayName, agentRoleLabel, compactNumber } from "../../../dashboard-utils";
import { cacheEvidenceLabel } from "./cache-evidence";
import type { RequestLane } from "./lane-model";
import { requestMarker, type ChartMode, type RequestRow } from "./model";
import { labeledEvidenceRow, placeAxisLabels, RequestBar } from "./RequestBarsChart";

// Every lane and the shared axis use one horizontal geometry, so a request sits at the same x
// in whichever lane owns it and other lanes leave a gap there. The viewBox width follows the
// measured plot width, so one unit is one pixel and SVG text keeps its size at every width.
const FALLBACK_WIDTH = 1112;
export const LANE_LEFT = 8;
/** Right-hand space reserved for the lane maximum, so no bar or evidence icon can reach it. */
export const MAXIMUM_GUTTER = 72;
const GAP = 3;
const MARKER = 14;
const LABEL_PAD = 4;
const PRIMARY = { band: 22, plot: 96 };
const SECONDARY = { band: 18, plot: 34 };

function laneLabel(lane: RequestLane, agents: Agent[]): { name: string; meta: string } {
  if (lane.kind === "compaction") {
    const count = new Set(lane.rows.map((row) => row.agentId)).size;
    return { name: "Compactions", meta: `compaction · ${count} ${count === 1 ? "agent" : "agents"}` };
  }
  const agent = agents.find((candidate) => candidate.id === lane.agentId);
  return agent ? { name: agentDisplayName(agent), meta: `${agentRoleLabel(agent)} · ${agent.model}` } : { name: "Unknown agent", meta: "not in the agent roster" };
}

export type LaneBandLabel = {
  key: string; kind: "selected" | "evidence" | "compaction"; text: string; x: number; anchor: "start" | "middle" | "end";
  /** Estimated horizontal extent the label occupies. */
  start: number; end: number;
};

/**
 * Lays out a lane band's text: the hovered, focused or selected cache-evidence label (right of
 * its icon when it fits), the selected request marker, then compaction text. Evidence icons are
 * fixed obstacles; a label that cannot clear them and earlier labels inside `[left, right]` is
 * dropped instead of overlapping.
 */
export function placeLaneBandLabels(entries: { row: RequestRow; index: number }[], { barX, width, left, right }: {
  barX: (index: number) => number; width: number; left: number; right: number;
}, selectedId: string | null, labeled: RequestRow | undefined): LaneBandLabel[] {
  const center = (index: number) => barX(index) + width / 2;
  const taken = entries.filter(({ row }) => row.cacheEvidence).map(({ index }) => [center(index) - MARKER / 2, center(index) + MARKER / 2]);
  const placed: LaneBandLabel[] = [];
  const place = (label: Pick<LaneBandLabel, "key" | "kind" | "text">, charWidth: number, candidates: Pick<LaneBandLabel, "x" | "anchor">[]) => {
    const size = label.text.length * charWidth;
    for (const candidate of candidates) {
      const start = candidate.anchor === "start" ? candidate.x : candidate.anchor === "end" ? candidate.x - size : candidate.x - size / 2;
      if (start < left || start + size > right || taken.some(([from, to]) => start < to + LABEL_PAD && start + size + LABEL_PAD > from)) continue;
      taken.push([start, start + size]);
      placed.push({ ...label, ...candidate, start, end: start + size });
      return;
    }
  };
  const side = MARKER / 2 + LABEL_PAD;
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
    const boundary = barX(index) - GAP / 2;
    place({ key: `compaction-${row.id}`, kind: "compaction", text: "compaction" }, 6, [{ x: boundary + 3, anchor: "start" }, { x: boundary - 3, anchor: "end" }]);
  }
  return placed;
}

export function RequestLaneChart({ lanes, laneByRequest, agents, rows, start, end, size, mode, selectedId, cacheWriteAvailable, onSelect, onStep, windowStart, total }: {
  lanes: RequestLane[]; laneByRequest: Map<string, string>; agents: Agent[];
  rows: RequestRow[]; start: number; end: number; size: number; mode: ChartMode;
  selectedId: string | null; cacheWriteAvailable: boolean;
  onSelect: (row: RequestRow) => void; onStep: (delta: number) => void;
  windowStart: number; total: number;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<SVGSVGElement>(null);
  const [plotWidth, setPlotWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const element = axisRef.current;
    if (!element) return;
    const measure = () => {
      const measured = Math.round(element.getBoundingClientRect().width);
      if (measured > 0) setPlotWidth(measured);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusSelection = useRef(false);
  useLayoutEffect(() => {
    if (!focusSelection.current) return;
    focusSelection.current = false;
    chartRef.current?.querySelector<SVGGElement>('[aria-pressed="true"]')?.focus();
  });
  const right = Math.max(LANE_LEFT + size * GAP * 2, plotWidth - MAXIMUM_GUTTER);
  const step = (right - LANE_LEFT + GAP) / size;
  const width = step - GAP;
  const barX = (index: number) => LANE_LEFT + step * index;
  const visible = useMemo(() => rows.slice(start - 1, end), [rows, start, end]);
  const visibleByLane = useMemo(() => {
    const byLane = new Map<string, { row: RequestRow; index: number }[]>();
    visible.forEach((row, index) => {
      const id = laneByRequest.get(row.id);
      if (!id) return;
      const entries = byLane.get(id);
      if (entries) entries.push({ row, index });
      else byLane.set(id, [{ row, index }]);
    });
    return byLane;
  }, [visible, laneByRequest]);
  const axisLabels = placeAxisLabels(visible, (index) => barX(index) + width / 2, true, plotWidth);
  const keyboardStep = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    focusSelection.current = true;
    onStep(event.key === "ArrowLeft" ? -1 : 1);
  };
  return <div className="requestLanes" ref={chartRef} role="group" aria-label={`Model requests by agent, positions ${windowStart} to ${Math.min(total, windowStart + size - 1)}`} onKeyDown={keyboardStep}>
    {lanes.map((lane) => {
      const { band, plot } = lane.primary ? PRIMARY : SECONDARY;
      const bottom = band + plot;
      const { name, meta } = laneLabel(lane, agents);
      const fullLabel = `${name} · ${meta}`;
      const entries = visibleByLane.get(lane.id) ?? [];
      const labeled = labeledEvidenceRow(entries.map(({ row }) => row), [hoveredId, focusedId, selectedId]);
      // Band text sits above the maximum's row, so it may use the full plot width.
      const bandLabels = placeLaneBandLabels(entries, { barX, width, left: 0, right: plotWidth }, selectedId, labeled);
      return <div key={lane.id} className={`requestLane${lane.primary ? " isPrimary" : ""}`} data-lane-kind={lane.kind} role="group" aria-label={fullLabel}>
        <div className="requestLaneLabel" title={fullLabel}>
          <span className="requestLaneName">{name}</span>
          <span className="requestLaneMeta">{meta}</span>
        </div>
        <svg className="requestLanePlot" viewBox={`0 0 ${plotWidth} ${bottom}`} width="100%" height={bottom}>
          <g className="requestsActionsAxis"><line x1={LANE_LEFT} x2={right} y1={bottom} y2={bottom} /></g>
          <text className="requestLaneMaximum" x={plotWidth} y={band + 10} textAnchor="end">max {compactNumber(lane.maximum)}</text>
          {entries.map(({ row, index }) => <RequestBar key={row.id} row={row} x={barX(index)} width={width} gap={GAP} top={band} bottom={bottom} right={right} band={band} marker={MARKER} labels={false}
            maximum={lane.maximum} mode={mode} cacheWriteAvailable={cacheWriteAvailable} selected={row.id === selectedId} onSelect={onSelect} onHover={setHoveredId} onFocus={setFocusedId} />)}
          {bandLabels.map((label) => {
            const text = <text key={label.key} aria-hidden="true" className={label.kind === "selected" ? "requestsActionsSelectedLabel" : label.kind === "evidence" ? "requestsActionsRefillLabel" : undefined} x={label.x} y={band - 5} textAnchor={label.anchor}>{label.text}</text>;
            return label.kind === "compaction" ? <g key={label.key} className="requestsActionsCompaction">{text}</g> : text;
          })}
        </svg>
      </div>;
    })}
    <div className="requestLaneAxisRow">
      <span />
      <svg ref={axisRef} className="requestLaneAxis" viewBox={`0 0 ${plotWidth} 18`} width="100%" height={18}>
        <g className="requestsActionsAxis">
          {axisLabels.map((label) => <text key={label.index} x={label.x} y={14} textAnchor={label.anchor}>{label.text}</text>)}
        </g>
      </svg>
    </div>
  </div>;
}
