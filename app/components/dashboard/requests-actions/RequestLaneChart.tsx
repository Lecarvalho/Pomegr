import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Agent, Workflow } from "../../../../shared/monitor-contract";
import { agentDisplayName, agentRoleLabel, compactNumber } from "../../../dashboard-utils";
import { layoutRequestLanes, type RequestLane, type RequestLaneGroup } from "./lane-model";
import type { ChartMode, RequestRow } from "./model";
import { labeledEvidenceRow, placeAxisLabels, placeBandLabels, RequestBandLabels, RequestBar } from "./RequestBarsChart";

// Every lane and the shared axis use one horizontal geometry, so a request sits at the same x
// in whichever lane owns it and other lanes leave a gap there. The viewBox width follows the
// measured plot width, so one unit is one pixel and SVG text keeps its size at every width.
const FALLBACK_WIDTH = 1112;
export const LANE_LEFT = 8;
/** Right-hand space reserved for the lane maximum, so no bar or evidence icon can reach it. */
export const MAXIMUM_GUTTER = 72;
const GAP = 3;
const MARKER = 14;
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

function groupLabel(group: RequestLaneGroup): { name: string; meta: string } {
  const members = `${group.members} agents`;
  return { name: group.title, meta: group.kind === "workflow" ? `workflow · ${members}` : members };
}

function LabelText({ name, meta, chevron }: { name: string; meta: string; chevron?: boolean }) {
  return <>
    <span className="requestLaneName">{chevron && <svg className="requestLaneChevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>}{name}</span>
    <span className="requestLaneMeta">{meta}</span>
  </>;
}

/**
 * Desktop lanes. A lane name focuses its agent through the shared agent scope, so the feed and
 * request detail never outlive a hidden bar; a group label expands or collapses a workflow group.
 * The expanded group ids belong to the caller, so they survive a switch to the single chart.
 */
export function RequestLaneChart({ lanes, agents, workflows, expanded, onToggleGroup, focusedAgentId, onFocusAgent, rows, start, end, size, mode, selectedId, cacheWriteAvailable, onSelect, onStep, windowStart, total }: {
  lanes: RequestLane[]; agents: Agent[]; workflows: Workflow[];
  expanded: ReadonlySet<string>; onToggleGroup: (groupId: string) => void;
  focusedAgentId: string | null; onFocusAgent: (agentId: string | null) => void;
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
  const layout = useMemo(() => layoutRequestLanes(lanes, agents, workflows, expanded, { scoped: focusedAgentId !== null, mode, cacheWriteAvailable }),
    [lanes, agents, workflows, expanded, focusedAgentId, mode, cacheWriteAvailable]);
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
      const id = layout.rowByRequest.get(row.id);
      if (!id) return;
      const entries = byLane.get(id);
      if (entries) entries.push({ row, index });
      else byLane.set(id, [{ row, index }]);
    });
    return byLane;
  }, [visible, layout]);
  const axisLabels = placeAxisLabels(visible, (index) => barX(index) + width / 2, true, plotWidth);
  const keyboardStep = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrow keys step bars, never from a label button, so focus does not jump out of the labels.
    if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || (event.target as Element).closest(".requestLaneLabel")) return;
    event.preventDefault();
    focusSelection.current = true;
    onStep(event.key === "ArrowLeft" ? -1 : 1);
  };
  return <div className="requestLanes" ref={chartRef} role="group" aria-label={`Model requests by agent, positions ${windowStart} to ${Math.min(total, windowStart + size - 1)}`} onKeyDown={keyboardStep}>
    {layout.rows.map((row) => {
      if (row.kind === "groupHeader") {
        const { name, meta } = groupLabel(row.group);
        return <div key={row.id} className="requestLaneGroupHeader">
          <button type="button" className="commandQuietAction requestLaneLabel" title={`${name} · ${meta}`} aria-label={`${name} · ${meta}`} aria-expanded="true" onClick={() => onToggleGroup(row.group.id)}><LabelText name={name} meta={meta} chevron /></button>
        </div>;
      }
      const lane = row.kind === "lane" ? row.lane : null;
      const { band, plot } = lane?.primary ? PRIMARY : SECONDARY;
      const bottom = band + plot;
      const { name, meta } = row.kind === "lane" ? laneLabel(row.lane, agents) : groupLabel(row.group);
      const maximum = row.kind === "lane" ? row.lane.maximum : row.group.maximum;
      const fullLabel = `${name} · ${meta}`;
      let label: ReactNode = <div className="requestLaneLabel" title={fullLabel}><LabelText name={name} meta={meta} /></div>;
      if (row.kind === "group") label = <button type="button" className="commandQuietAction requestLaneLabel" title={fullLabel} aria-label={fullLabel} aria-expanded="false" onClick={() => onToggleGroup(row.group.id)}><LabelText name={name} meta={meta} chevron /></button>;
      else if (lane && lane.agentId !== null && agents.some((agent) => agent.id === lane.agentId)) {
        const focused = lane.agentId === focusedAgentId;
        label = <button type="button" className="commandQuietAction requestLaneLabel" title={fullLabel} aria-label={`Focus ${fullLabel}`} aria-pressed={focused} onClick={() => onFocusAgent(focused ? null : lane.agentId)}><LabelText name={name} meta={meta} /></button>;
      }
      const entries = visibleByLane.get(row.id) ?? [];
      const labeled = labeledEvidenceRow(entries.map(({ row: request }) => request), [hoveredId, focusedId, selectedId]);
      // Band text sits above the maximum's row, so it may use the full plot width.
      const bandLabels = placeBandLabels(entries, { barX, width, left: 0, right: plotWidth, gap: GAP, marker: MARKER }, selectedId, labeled);
      const className = `requestLane${lane?.primary ? " isPrimary" : ""}${row.kind === "lane" && row.member ? " isGroupMember" : ""}`;
      return <div key={row.id} className={className} data-lane-kind={lane ? lane.kind : "group"} role="group" aria-label={fullLabel}>
        {label}
        <svg className="requestLanePlot" viewBox={`0 0 ${plotWidth} ${bottom}`} width="100%" height={bottom}>
          <g className="requestsActionsAxis"><line x1={LANE_LEFT} x2={right} y1={bottom} y2={bottom} /></g>
          <text className="requestLaneMaximum" x={plotWidth} y={band + 10} textAnchor="end">max {compactNumber(maximum)}</text>
          {entries.map(({ row: request, index }) => <RequestBar key={request.id} row={request} x={barX(index)} width={width} gap={GAP} top={band} bottom={bottom} right={right} band={band} marker={MARKER} labels={false}
            maximum={maximum} mode={mode} cacheWriteAvailable={cacheWriteAvailable} selected={request.id === selectedId} onSelect={onSelect} onHover={setHoveredId} onFocus={setFocusedId} />)}
          <RequestBandLabels labels={bandLabels} y={band - 5} />
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
