"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Agent, ContextHistoryBoundary, MonitorState } from "../../../shared/monitor-contract";
import { compactNumber, formatBucketDuration, timelineTime } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";

type TokenMetrics = MonitorState["metrics"]["tokens"];
type HistoryBucket = TokenMetrics["contextHistory"]["buckets"][number];
type HistoryPoint = { bucket: HistoryBucket; bucketIndex: number; total: number };

const ALL_AGENTS_SCOPE = "all-agents";
const CHART_WIDTH = 1000;
const CHART_HEIGHT = 154;
const CHART_INSET = 5;

function initialScope(agents: Agent[], buckets: HistoryBucket[]) {
  const observed = new Set(buckets.flatMap((bucket) => bucket.agents.map((agent) => agent.agentId)));
  if (observed.has("primary")) return "primary";
  return agents.find((agent) => observed.has(agent.id))?.id || agents[0]?.id || ALL_AGENTS_SCOPE;
}

function niceMaximum(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const rounded = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return rounded * magnitude;
}

function pointX(bucketIndex: number, bucketCount: number) {
  if (bucketCount <= 1) return CHART_WIDTH;
  return CHART_INSET + bucketIndex / (bucketCount - 1) * (CHART_WIDTH - CHART_INSET * 2);
}

function pointY(total: number, maximum: number) {
  return CHART_HEIGHT - CHART_INSET - Math.max(0, Math.min(1, total / maximum)) * (CHART_HEIGHT - CHART_INSET * 2);
}

function boundaryX(timestamp: string, start: number, end: number) {
  const time = Date.parse(timestamp);
  const progress = end > start && Number.isFinite(time) ? (time - start) / (end - start) : 0;
  return CHART_INSET + Math.max(0, Math.min(1, progress)) * (CHART_WIDTH - CHART_INSET * 2);
}

function boundaryLabel(kind: ContextHistoryBoundary["kind"]) {
  if (kind === "automatic_compaction") return "Automatic compaction";
  if (kind === "manual_compaction") return "Manual compaction";
  return "Snapshot decrease";
}

function stepPath(points: HistoryPoint[], bucketCount: number, maximum: number) {
  return points.reduce((path, point, index) => {
    const x = pointX(point.bucketIndex, bucketCount);
    const y = pointY(point.total, maximum);
    if (index === 0) return `M ${x} ${y}`;
    return `${path} H ${x} V ${y}`;
  }, "");
}

function scopedPoints(buckets: HistoryBucket[], scope: string): HistoryPoint[] {
  return buckets.flatMap((bucket, bucketIndex) => {
    const total = scope === ALL_AGENTS_SCOPE
      ? bucket.total
      : bucket.agents.find((agent) => agent.agentId === scope)?.total;
    return typeof total === "number" && total > 0 ? [{ bucket, bucketIndex, total }] : [];
  });
}

export function ContextHistoryPanel({ agents, tokens, historical }: {
  agents: Agent[];
  tokens: TokenMetrics;
  historical: boolean;
}) {
  const buckets = tokens.contextHistory?.buckets || [];
  const [scope, setScope] = useState(() => initialScope(agents, buckets));
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const announcementId = useId();
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const scopeAvailable = scope === ALL_AGENTS_SCOPE || agentById.has(scope);
  const resolvedScope = scopeAvailable ? scope : initialScope(agents, buckets);

  const points = scopedPoints(buckets, resolvedScope);
  const maximum = niceMaximum(Math.max(0, ...buckets.flatMap((bucket) => [
    bucket.total,
    ...bucket.agents.map((agent) => agent.total),
  ])));
  const path = stepPath(points, buckets.length, maximum);
  const resolvedActiveIndex = activePointIndex === null
    ? points.length - 1
    : Math.max(0, Math.min(activePointIndex, points.length - 1));
  const activePoint = points[resolvedActiveIndex];
  const activeX = activePoint ? pointX(activePoint.bucketIndex, buckets.length) : null;
  const activeY = activePoint ? pointY(activePoint.total, maximum) : null;
  const scopeLabel = resolvedScope === ALL_AGENTS_SCOPE ? "All agents" : agentById.get(resolvedScope)?.label || "Selected agent";
  const helperText = resolvedScope === ALL_AGENTS_SCOPE
    ? "Sum of each agent’s latest carried-forward snapshot. Agents can overlap; this is not unique context or spend."
    : `Latest request snapshot over time for ${scopeLabel}. Not cumulative token use.`;
  const spansMultipleDays = buckets.length > 0
    && Date.parse(buckets.at(-1)?.end || "") - Date.parse(buckets[0].start) >= 24 * 60 * 60_000;
  const middleBucket = buckets[Math.floor((buckets.length - 1) / 2)];
  const historyStart = Date.parse(buckets[0]?.start || "");
  const historyEnd = Date.parse(buckets.at(-1)?.end || "");
  const boundaries = (tokens.contextHistory?.boundaries || []).filter((boundary) => (
    resolvedScope === ALL_AGENTS_SCOPE || boundary.agentId === resolvedScope
  ));
  const activeBoundaries = activePoint ? boundaries.filter((boundary) => {
    const time = Date.parse(boundary.timestamp);
    return time >= Date.parse(activePoint.bucket.start) && time < Date.parse(activePoint.bucket.end);
  }) : [];
  const boundaryReadout = (boundary: ContextHistoryBoundary) => {
    const agentPrefix = resolvedScope === ALL_AGENTS_SCOPE
      ? `${agentById.get(boundary.agentId)?.label || "Agent"}: `
      : "";
    const previousLevel = boundary.preTokens === null ? "" : ` · ${compactNumber(boundary.preTokens)} before`;
    return `${agentPrefix}${boundaryLabel(boundary.kind)}${previousLevel}`;
  };

  const handleChartKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (points.length === 0) return;
    let next = resolvedActiveIndex;
    if (event.key === "ArrowLeft") next = Math.max(0, resolvedActiveIndex - 1);
    else if (event.key === "ArrowRight") next = Math.min(points.length - 1, resolvedActiveIndex + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = points.length - 1;
    else return;
    event.preventDefault();
    setActivePointIndex(next === points.length - 1 ? null : next);
  };

  const handleChartPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (points.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const targetX = progress * CHART_WIDTH;
    const nearestIndex = points.reduce((best, point, index) => (
      Math.abs(pointX(point.bucketIndex, buckets.length) - targetX)
        < Math.abs(pointX(points[best].bucketIndex, buckets.length) - targetX) ? index : best
    ), 0);
    setActivePointIndex(nearestIndex === points.length - 1 ? null : nearestIndex);
  };

  return (
    <section className={`panel contextHistoryPanel ${historical ? "historical" : ""}`} aria-label="Context history">
      <div className="contextHistoryHeader">
        <div>
          <h2>Context history</h2>
          <p>{helperText}</p>
        </div>
        <label className="contextScopeControl">
          <span>Scope</span>
          <select aria-label="Context scope" value={resolvedScope} onChange={(event) => {
            setScope(event.target.value);
            setActivePointIndex(null);
          }}>
            {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.label}</option>)}
            <option value={ALL_AGENTS_SCOPE}>All agents (snapshot sum)</option>
          </select>
        </label>
      </div>

      {points.length === 0 ? (
        <EmptyState text={historical ? `No context snapshots were recorded for ${scopeLabel}.` : "Context history will appear after the first model response."} />
      ) : (
        <div className="contextHistoryBody">
          <div className="contextHistoryReadout">
            <span>{activePoint ? timelineTime(activePoint.bucket.end, spansMultipleDays) : "—"}</span>
            <strong>{activePoint ? `${compactNumber(activePoint.total)} context` : "No snapshot"}</strong>
            {activeBoundaries.map((boundary) => <em key={boundary.id}>{boundaryReadout(boundary)}</em>)}
            {activePointIndex !== null && activePointIndex < points.length - 1 && (
              <button type="button" onClick={() => setActivePointIndex(null)}>Latest</button>
            )}
          </div>
          <div className="contextHistoryPlot">
            <div className="contextHistoryScale" aria-hidden="true">
              <span>{compactNumber(maximum)}</span>
              <span>{compactNumber(maximum / 2)}</span>
              <span>0</span>
            </div>
            <div
              className="contextHistoryChart"
              role="group"
              tabIndex={0}
              aria-label={`${scopeLabel} context history. Use Left and Right arrow keys to inspect snapshots.`}
              aria-describedby={announcementId}
              onKeyDown={handleChartKeyDown}
              onPointerMove={handleChartPointerMove}
              onPointerLeave={(event) => { if (document.activeElement !== event.currentTarget) setActivePointIndex(null); }}
            >
              <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                <g className="contextHistoryGrid">
                  <line x1="0" y1={CHART_INSET} x2={CHART_WIDTH} y2={CHART_INSET} />
                  <line x1="0" y1={CHART_HEIGHT / 2} x2={CHART_WIDTH} y2={CHART_HEIGHT / 2} />
                  <line x1="0" y1={CHART_HEIGHT - CHART_INSET} x2={CHART_WIDTH} y2={CHART_HEIGHT - CHART_INSET} />
                </g>
                <path className="contextHistoryLine" d={path} fill="none" />
                {boundaries.map((boundary) => {
                  const x = boundaryX(boundary.timestamp, historyStart, historyEnd);
                  const marker = boundary.kind === "automatic_compaction"
                    ? <rect x={x - 4.5} y="5" width="9" height="9" />
                    : boundary.kind === "manual_compaction"
                      ? <path d={`M ${x} 4 l 5 5 -5 5 -5 -5 Z`} />
                      : <path d={`M ${x} 4 l 5 10 h-10 Z`} />;
                  return <g className={`contextBoundary ${boundary.kind}`} key={boundary.id}><line x1={x} y1="0" x2={x} y2={CHART_HEIGHT} />{marker}</g>;
                })}
                {activeX !== null && activeY !== null && <>
                  <line className="contextHistoryCursor" x1={activeX} y1="0" x2={activeX} y2={CHART_HEIGHT} />
                  <circle className="contextHistoryCursorPoint" cx={activeX} cy={activeY} r="4.5" />
                </>}
              </svg>
            </div>
          </div>
          <div className="contextHistoryAxis" aria-hidden="true">
            <span>{timelineTime(buckets[0].end, spansMultipleDays)}</span>
            <span>{middleBucket ? timelineTime(middleBucket.end, spansMultipleDays) : ""}</span>
            <span>{timelineTime(buckets.at(-1)?.end || buckets[0].end, spansMultipleDays)}</span>
          </div>
          <div className="contextHistoryMethod">
            <span>{formatBucketDuration(tokens.contextHistory.bucketMs)} buckets · carried latest request snapshots</span>
            <span>Scale fixed across scopes · {compactNumber(maximum)} max</span>
          </div>
          {boundaries.length > 0 && <div className="contextBoundaryLegend" aria-label="Context history boundaries">
            {[...new Set(boundaries.map((boundary) => boundary.kind))].map((kind) => <span className={kind} key={kind}><i aria-hidden="true" />{boundaryLabel(kind)}</span>)}
          </div>}
          <p className="contextHistoryAnnouncement" id={announcementId} aria-live="polite" aria-atomic="true">
            {activePoint ? `${scopeLabel}, ${timelineTime(activePoint.bucket.end, spansMultipleDays)}, ${activePoint.total.toLocaleString()} context.${activeBoundaries.length ? ` ${activeBoundaries.map(boundaryReadout).join(", ")}.` : ""}` : "No context snapshot selected."}
          </p>
        </div>
      )}

    </section>
  );
}
