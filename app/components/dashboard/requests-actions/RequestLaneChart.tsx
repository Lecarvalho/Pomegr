import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "../../../../shared/monitor-contract";
import { agentDisplayName, agentRoleLabel, compactNumber } from "../../../dashboard-utils";
import { cacheEvidenceLabel } from "./cache-evidence";
import type { RequestLane } from "./lane-model";
import type { ChartMode, RequestRow } from "./model";
import { labeledEvidenceRow, placeAxisLabels, RequestBar } from "./RequestBarsChart";

// Every lane and the shared axis use one horizontal geometry, so a request sits at the same x
// in whichever lane owns it and other lanes leave a gap there.
const VIEW_WIDTH = 1112;
const LEFT = 8;
const RIGHT = 1104;
const GAP = 3;
const PRIMARY = { band: 22, plot: 96 };
const SECONDARY = { band: 18, plot: 34 };

function laneLabel(lane: RequestLane, agents: Agent[]): { name: string; meta: string | null } {
  if (lane.kind === "compaction") return { name: "Compactions", meta: "compaction" };
  const agent = agents.find((candidate) => candidate.id === lane.agentId);
  return agent ? { name: agentDisplayName(agent), meta: `${agentRoleLabel(agent)} · ${agent.model}` } : { name: "Unknown agent", meta: null };
}

export function RequestLaneChart({ lanes, laneByRequest, agents, rows, start, end, size, mode, selectedId, cacheWriteAvailable, onSelect, onStep, windowStart, total }: {
  lanes: RequestLane[]; laneByRequest: Map<string, string>; agents: Agent[];
  rows: RequestRow[]; start: number; end: number; size: number; mode: ChartMode;
  selectedId: string | null; cacheWriteAvailable: boolean;
  onSelect: (row: RequestRow) => void; onStep: (delta: number) => void;
  windowStart: number; total: number;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusSelection = useRef(false);
  useLayoutEffect(() => {
    if (!focusSelection.current) return;
    focusSelection.current = false;
    chartRef.current?.querySelector<SVGGElement>('[aria-pressed="true"]')?.focus();
  });
  const step = (RIGHT - LEFT + GAP) / size;
  const width = step - GAP;
  const barX = (index: number) => LEFT + step * index;
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
  const axisLabels = placeAxisLabels(visible, (index) => barX(index) + width / 2, true, VIEW_WIDTH);
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
      const entries = visibleByLane.get(lane.id) ?? [];
      const maximumText = `max ${compactNumber(lane.maximum)}`;
      const labeled = labeledEvidenceRow(entries.map(({ row }) => row), [hoveredId, focusedId, selectedId]);
      const labeledIndex = labeled ? entries.find(({ row }) => row === labeled)!.index : 0;
      const labelText = labeled?.cacheEvidence ? cacheEvidenceLabel(labeled.cacheEvidence, true) : "";
      const labelStart = Math.max(LEFT, Math.min(barX(labeledIndex) + width / 2 + 12, RIGHT - maximumText.length * 7 - 12 - labelText.length * 6));
      return <div key={lane.id} className={`requestLane${lane.primary ? " isPrimary" : ""}`} data-lane-kind={lane.kind}>
        <div className="requestLaneLabel" title={meta ? `${name} · ${meta}` : name}>
          <span className="requestLaneName">{name}</span>
          {meta && <span className="requestLaneMeta">{meta}</span>}
        </div>
        <svg className="requestLanePlot" viewBox={`0 0 ${VIEW_WIDTH} ${bottom}`} width="100%">
          <g className="requestsActionsAxis"><line x1={LEFT} x2={RIGHT} y1={bottom} y2={bottom} /></g>
          <text className="requestLaneMaximum" x={RIGHT} y={band - 6} textAnchor="end">{maximumText}</text>
          {entries.map(({ row, index }) => <RequestBar key={row.id} row={row} x={barX(index)} width={width} gap={GAP} top={band} bottom={bottom} right={RIGHT} band={band}
            maximum={lane.maximum} mode={mode} cacheWriteAvailable={cacheWriteAvailable} selected={row.id === selectedId} onSelect={onSelect} onHover={setHoveredId} onFocus={setFocusedId} />)}
          {labeled?.cacheEvidence && <text aria-hidden="true" className="requestsActionsRefillLabel" x={labelStart} y={band - 6} textAnchor="start">{labelText}</text>}
        </svg>
      </div>;
    })}
    <svg className="requestLaneAxis" viewBox={`0 0 ${VIEW_WIDTH} 18`} width="100%">
      <g className="requestsActionsAxis">
        {axisLabels.map((label) => <text key={label.index} x={label.x} y={14} textAnchor={label.anchor}>{label.text}</text>)}
      </g>
    </svg>
  </div>;
}
