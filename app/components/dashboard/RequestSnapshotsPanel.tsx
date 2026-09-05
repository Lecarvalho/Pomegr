"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { Agent, CacheEvent, MonitorState, RequestSnapshot } from "../../../shared/monitor-contract";
import { agentDisplayLabel, compactNumber, timelineTime } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";
import { CommandSelect } from "../command-center/CommandPage";

type TokenMetrics = MonitorState["metrics"]["tokens"];
type SnapshotComponent = "uncachedInputTokens" | "cacheWriteTokens" | "cacheReadTokens" | "outputTokens";
type Point = { x: number; y: number };
type CubicSegment = { start: Point; firstControl: Point; secondControl: Point; end: Point };

const ALL_AGENTS_SCOPE = "all-agents";
const RECENT_EVENT_COUNT = 5;
const MINIMUM_POINT_STEP = 28;
const CHART_WIDTH = 1000;
const CHART_HEIGHT = 146;
const CHART_INSET = 5;
const SNAPSHOT_COMPONENTS: Array<{ key: SnapshotComponent; className: string; label: string }> = [
  { key: "uncachedInputTokens", className: "uncachedInput", label: "Uncached input" },
  { key: "cacheWriteTokens", className: "cacheWrite", label: "Cache write" },
  { key: "cacheReadTokens", className: "cacheRead", label: "Cache read" },
  { key: "outputTokens", className: "output", label: "Output" },
];

function initialScope(agents: Agent[], snapshots: RequestSnapshot[]) {
  const observed = new Set(snapshots.map((snapshot) => snapshot.agentId));
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

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** A monotone cubic Hermite spline. Harmonic-mean tangents keep every segment inside its data bounds. */
function monotoneSegments(points: Point[]): CubicSegment[] {
  if (points.length < 2) return [];
  const slopes = points.slice(0, -1).map((point, index) => {
    const width = points[index + 1].x - point.x;
    return width > 0 ? (points[index + 1].y - point.y) / width : 0;
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes.at(-1) || 0;
    const before = slopes[index - 1];
    const after = slopes[index];
    return before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)
      ? 0
      : 2 / (1 / before + 1 / after);
  });

  return points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    const width = next.x - point.x;
    return {
      start: point,
      firstControl: { x: point.x + width / 3, y: point.y + tangents[index] * width / 3 },
      secondControl: { x: next.x - width / 3, y: next.y - tangents[index + 1] * width / 3 },
      end: next,
    };
  });
}

export function monotonePath(points: Point[]) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return monotoneSegments(points).reduce((path, segment) => (
    `${path} C ${segment.firstControl.x} ${segment.firstControl.y}, ${segment.secondControl.x} ${segment.secondControl.y}, ${segment.end.x} ${segment.end.y}`
  ), `M ${points[0].x} ${points[0].y}`);
}

function snapshotSeriesPoints(snapshots: RequestSnapshot[], component: SnapshotComponent, maximum: number): Point[] {
  return snapshots.map((snapshot, index) => {
    const x = (index + 0.5) * CHART_WIDTH / snapshots.length;
    const value = maximum > 0 ? finiteNonNegative(snapshot[component]) / maximum : 0;
    return { x, y: CHART_HEIGHT - CHART_INSET - value * (CHART_HEIGHT - CHART_INSET * 2) };
  });
}

function areaPath(points: Point[]) {
  if (points.length === 0) return "";
  return `${monotonePath(points)} L ${points.at(-1)?.x || 0} ${CHART_HEIGHT - CHART_INSET} L ${points[0].x} ${CHART_HEIGHT - CHART_INSET} Z`;
}

export function snapshotEventKey(agentId: string, observedAt: string) {
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) return null;
  return `${agentId}\u0000${new Date(timestamp).toISOString()}`;
}

function eventTitle(kind: CacheEvent["kind"]) {
  if (kind === "miss_refill") return "Possible cache miss · refill";
  if (kind === "reuse") return "Cache reuse";
  return "Cache refill";
}

function CacheEventRow({ event, agentLabel, showAgent, interactive, active, selected, onHover, onHoverEnd, onFocus, onBlur, onSelect, onClearSelection }: {
  event: CacheEvent;
  agentLabel: string;
  showAgent: boolean;
  interactive: boolean;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onHoverEnd: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onSelect: () => void;
  onClearSelection: () => void;
}) {
  const handleKeyDown = (keyboardEvent: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
      keyboardEvent.preventDefault();
      onSelect();
    } else if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      keyboardEvent.currentTarget.blur();
      onClearSelection();
    }
  };

  return (
    <li className="cacheEvidenceItem">
      <div
        className={`cacheEvidenceRow ${event.kind}${active ? " active" : ""}${interactive ? " interactive" : ""}`}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? `Locate ${eventTitle(event.kind)} at ${timelineTime(event.observedAt)}` : undefined}
        aria-pressed={interactive ? selected : undefined}
        onPointerEnter={interactive ? onHover : undefined}
        onPointerLeave={interactive ? onHoverEnd : undefined}
        onFocus={interactive ? onFocus : undefined}
        onBlur={interactive ? onBlur : undefined}
        onClick={interactive ? onSelect : undefined}
        onKeyDown={handleKeyDown}
      >
        <span className="cacheEvidenceMark" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            {event.kind === "reuse"
              ? <path d="M3 9.5a5 5 0 0 0 8.7 1.5M13 6.5A5 5 0 0 0 4.3 5M3 3v3h3M13 13v-3h-3" />
              : <><path d="M8 2v8" /><path d="m4.5 7 3.5 3.5L11.5 7" /><path d="M3 13h10" /></>}
          </svg>
        </span>
        <div className="cacheEvidenceBody">
          <strong>{eventTitle(event.kind)}</strong>
          {showAgent && <span>{agentLabel}</span>}
        </div>
        <span className="cacheEvidencePercent"><strong>{event.cacheReadPercent}%</strong> read</span>
      </div>
    </li>
  );
}

export function RequestSnapshotsPanel({ agents, requestSnapshots, cacheEvents, cacheWriteAvailable, historical }: {
  agents: Agent[];
  requestSnapshots: TokenMetrics["requestSnapshots"];
  cacheEvents: TokenMetrics["cacheEvents"];
  cacheWriteAvailable: boolean;
  historical: boolean;
}) {
  const snapshots = [...(requestSnapshots?.items || [])].sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  ));
  const [scope, setScope] = useState(() => initialScope(agents, snapshots));
  const [selectedSnapshotIndex, setSelectedSnapshotIndex] = useState<number | null>(null);
  const [hoveredSnapshotIndex, setHoveredSnapshotIndex] = useState<number | null>(null);
  const [focusedSnapshotIndex, setFocusedSnapshotIndex] = useState<number | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [visibleSeries, setVisibleSeries] = useState<Record<SnapshotComponent, boolean>>({
    uncachedInputTokens: true,
    cacheWriteTokens: true,
    cacheReadTokens: true,
    outputTokens: true,
  });
  const snapshotComponents = cacheWriteAvailable
    ? SNAPSHOT_COMPONENTS
    : SNAPSHOT_COMPONENTS.filter((component) => component.key !== "cacheWriteTokens");
  const announcementId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const scopeAvailable = scope === ALL_AGENTS_SCOPE || agentById.has(scope);
  const resolvedScope = scopeAvailable ? scope : initialScope(agents, snapshots);
  const scopeAgent = agentById.get(resolvedScope);
  const scopeLabel = resolvedScope === ALL_AGENTS_SCOPE ? "All agents" : scopeAgent ? agentDisplayLabel(scopeAgent) : "Selected agent";
  const scopedSnapshots = snapshots.filter((snapshot) => (
    resolvedScope === ALL_AGENTS_SCOPE || snapshot.agentId === resolvedScope
  ));
  const maximum = niceMaximum(Math.max(0, ...snapshots.flatMap((snapshot) => [
    snapshot.totalTokens,
    ...snapshotComponents.map((component) => snapshot[component.key]),
  ])));
  const inspectionSnapshotIndex = hoveredSnapshotIndex ?? focusedSnapshotIndex ?? selectedSnapshotIndex;
  const resolvedActiveIndex = inspectionSnapshotIndex === null
    ? scopedSnapshots.length - 1
    : Math.max(0, Math.min(inspectionSnapshotIndex, scopedSnapshots.length - 1));
  const activeSnapshot = scopedSnapshots[resolvedActiveIndex];
  const spansMultipleDays = snapshots.length > 0
    && Date.parse(snapshots.at(-1)?.observedAt || "") - Date.parse(snapshots[0].observedAt) >= 24 * 60 * 60_000;

  const cacheEventItems = cacheWriteAvailable ? cacheEvents?.items || [] : [];
  const allScopedEvents = [...cacheEventItems]
    .filter((event) => resolvedScope === ALL_AGENTS_SCOPE || event.agentId === resolvedScope)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const visibleEvents = showAllEvents ? allScopedEvents : allScopedEvents.slice(-RECENT_EVENT_COUNT);
  const hiddenEventCount = Math.max(0, allScopedEvents.length - RECENT_EVENT_COUNT);
  const eventsBySnapshot = new Map<string, CacheEvent[]>();
  for (const event of cacheEventItems) {
    const key = snapshotEventKey(event.agentId, event.observedAt);
    if (key === null) continue;
    eventsBySnapshot.set(key, [...(eventsBySnapshot.get(key) || []), event]);
  }
  const scopedSnapshotIndexes = new Map<string, number>();
  scopedSnapshots.forEach((snapshot, index) => {
    const key = snapshotEventKey(snapshot.agentId, snapshot.observedAt);
    if (key !== null) scopedSnapshotIndexes.set(key, index);
  });
  const matchingSnapshotIndex = (event: CacheEvent) => {
    const key = snapshotEventKey(event.agentId, event.observedAt);
    return key === null ? null : scopedSnapshotIndexes.get(key) ?? null;
  };
  const activeSnapshotKey = activeSnapshot
    ? snapshotEventKey(activeSnapshot.agentId, activeSnapshot.observedAt)
    : null;
  const activeEvents = activeSnapshotKey === null ? [] : eventsBySnapshot.get(activeSnapshotKey) || [];
  const activeAgentLabel = activeSnapshot
    ? (agentById.has(activeSnapshot.agentId) ? agentDisplayLabel(agentById.get(activeSnapshot.agentId)!) : "Agent")
    : scopeLabel;
  const pointsBySeries = Object.fromEntries(snapshotComponents.map((component) => (
    [component.key, snapshotSeriesPoints(scopedSnapshots, component.key, maximum)]
  ))) as Record<SnapshotComponent, Point[]>;
  const activeX = scopedSnapshots.length === 1
    ? CHART_WIDTH / 2
    : (resolvedActiveIndex + 0.5) * CHART_WIDTH / scopedSnapshots.length;
  const anySeriesVisible = snapshotComponents.some((component) => visibleSeries[component.key]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollLeft = viewport.scrollWidth;
  }, [resolvedScope, scopedSnapshots.length]);

  useEffect(() => {
    if (inspectionSnapshotIndex === null) return;
    const activePoint = chartRef.current?.querySelector<HTMLElement>(`[data-snapshot-index="${resolvedActiveIndex}"]`);
    const viewport = viewportRef.current;
    if (!activePoint || !viewport) return;
    if (activePoint.offsetLeft < viewport.scrollLeft) viewport.scrollLeft = activePoint.offsetLeft;
    else if (activePoint.offsetLeft + activePoint.offsetWidth > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = activePoint.offsetLeft + activePoint.offsetWidth - viewport.clientWidth;
    }
  }, [inspectionSnapshotIndex, resolvedActiveIndex]);

  const clearInspection = () => {
    setSelectedSnapshotIndex(null);
    setHoveredSnapshotIndex(null);
    setFocusedSnapshotIndex(null);
  };

  const handleChartKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (scopedSnapshots.length === 0) return;
    let next = resolvedActiveIndex;
    if (event.key === "ArrowLeft") next = Math.max(0, resolvedActiveIndex - 1);
    else if (event.key === "ArrowRight") next = Math.min(scopedSnapshots.length - 1, resolvedActiveIndex + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = scopedSnapshots.length - 1;
    else return;
    event.preventDefault();
    setHoveredSnapshotIndex(null);
    setFocusedSnapshotIndex(null);
    setSelectedSnapshotIndex(next);
  };

  const chartSnapshotIndex = (element: HTMLDivElement, clientX: number) => {
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0) return null;
    const progress = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    return Math.round(progress * (scopedSnapshots.length - 1));
  };

  const handleChartPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (scopedSnapshots.length === 0) return;
    const next = chartSnapshotIndex(event.currentTarget, event.clientX);
    if (next !== null) setHoveredSnapshotIndex(next);
  };

  const handleChartClick = (event: MouseEvent<HTMLDivElement>) => {
    if (scopedSnapshots.length === 0) return;
    const next = chartSnapshotIndex(event.currentTarget, event.clientX);
    if (next !== null) setSelectedSnapshotIndex(next);
  };

  const announcement = activeSnapshot
    ? `${activeAgentLabel}, ${timelineTime(activeSnapshot.observedAt, spansMultipleDays)}. ${activeSnapshot.uncachedInputTokens.toLocaleString()} uncached input, ${cacheWriteAvailable ? `${activeSnapshot.cacheWriteTokens.toLocaleString()} cache write, ` : ""}${activeSnapshot.cacheReadTokens.toLocaleString()} cache read, ${activeSnapshot.outputTokens.toLocaleString()} output, ${activeSnapshot.totalTokens.toLocaleString()} total.${activeEvents.length ? ` ${activeEvents.map((event) => eventTitle(event.kind)).join(", ")}.` : ""}`
    : "No request snapshot selected.";

  return (
    <section className={`panel requestSnapshotsPanel ${historical ? "historical" : ""}`} aria-label={cacheWriteAvailable ? "Request snapshots and cache evidence" : "Request snapshots"}>
      <div className="requestSnapshotsHeader">
        <div>
          <h2>Request snapshots</h2>
          <p>Each point is one provider usage snapshot. Equal spacing; curves only connect recorded points. Not cumulative.</p>
        </div>
        <label className="contextScopeControl">
          <span>Scope</span>
          <CommandSelect aria-label="Request scope" value={resolvedScope} onChange={(event) => {
            setScope(event.target.value);
            clearInspection();
            setShowAllEvents(false);
          }}>
            {agents.map((agent) => <option value={agent.id} key={agent.id}>{agentDisplayLabel(agent)}</option>)}
            <option value={ALL_AGENTS_SCOPE}>All agents</option>
          </CommandSelect>
        </label>
      </div>

      {requestSnapshots?.status !== "ready" ? (
        <EmptyState text={historical ? "No independent request snapshots were recorded for this session." : "Independent request snapshots are not available yet for this session."} />
      ) : scopedSnapshots.length === 0 ? (
        <EmptyState text={historical ? `No request snapshots were recorded for ${scopeLabel}.` : `Watching for request snapshots for ${scopeLabel}…`} />
      ) : (
        <div className="requestSnapshotsBody">
          <div className="requestSnapshotReadout">
            <div>
              <span><time dateTime={activeSnapshot.observedAt}>{timelineTime(activeSnapshot.observedAt, spansMultipleDays)}</time> · {activeAgentLabel}</span>
              <strong>{activeSnapshot.totalTokens.toLocaleString()} total</strong>
            </div>
            <dl style={{ "--snapshot-component-count": snapshotComponents.length } as CSSProperties}>
              {snapshotComponents.map((component) => (
                <div key={component.key}><dt>{component.label}</dt><dd>{activeSnapshot[component.key].toLocaleString()}</dd></div>
              ))}
            </dl>
            {activeEvents.map((event) => <em className={event.kind} key={event.id}>{eventTitle(event.kind)}</em>)}
            {inspectionSnapshotIndex !== null && resolvedActiveIndex < scopedSnapshots.length - 1 && (
              <button type="button" onClick={clearInspection}>Latest</button>
            )}
          </div>
          <div className="requestSnapshotPlot">
            <div className="requestSnapshotScale" aria-hidden="true">
              <span>{compactNumber(maximum)}</span>
              <span>{compactNumber(maximum / 2)}</span>
              <span>0</span>
            </div>
            <div className="requestSnapshotViewport" ref={viewportRef}>
              <div
                className="requestSnapshotChart"
                ref={chartRef}
                role="group"
                tabIndex={0}
                aria-label={`${scopeLabel} request snapshots. Use Left and Right arrow keys to inspect requests.`}
                aria-describedby={announcementId}
                onKeyDown={handleChartKeyDown}
                onPointerMove={handleChartPointerMove}
                onPointerLeave={() => setHoveredSnapshotIndex(null)}
                onClick={handleChartClick}
                style={{ minWidth: `${scopedSnapshots.length * MINIMUM_POINT_STEP}px` }}
              >
                <div className="requestSnapshotGrid" aria-hidden="true"><i /><i /><i /></div>
                <svg className="contextAreaChart requestSnapshotAreaChart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                  {[...snapshotComponents].reverse().map((component) => (
                    <path
                      className={`contextArea ${component.className}Area${visibleSeries[component.key] ? "" : " isHidden"}`}
                      d={areaPath(pointsBySeries[component.key])}
                      key={`${component.key}-area`}
                    />
                  ))}
                  {snapshotComponents.map((component) => (
                    <path
                      className={`contextSeriesLine ${component.className}Line${visibleSeries[component.key] ? "" : " isHidden"}`}
                      d={monotonePath(pointsBySeries[component.key])}
                      key={`${component.key}-line`}
                    />
                  ))}
                  <line className="requestSnapshotCursor" x1={activeX} x2={activeX} y1={0} y2={CHART_HEIGHT} />
                </svg>
                <div className="requestSnapshotPoints" style={{ "--snapshot-count": scopedSnapshots.length } as CSSProperties} aria-hidden="true">
                  {scopedSnapshots.map((snapshot, index) => (
                      <div className={`requestSnapshotPointColumn${index === resolvedActiveIndex ? " active" : ""}`} data-snapshot-index={index} data-snapshot-id={snapshot.id} key={snapshot.id}>
                        {snapshotComponents.map((component) => (
                          <i
                            className={`contextChartPoint ${component.className}ChartPoint${visibleSeries[component.key] ? "" : " isHidden"}`}
                            key={component.key}
                            style={{ "--point-y": `${pointsBySeries[component.key][index].y / CHART_HEIGHT * 100}%` } as CSSProperties}
                          />
                        ))}
                      </div>
                  ))}
                </div>
                {!anySeriesVisible && <p className="requestSnapshotHiddenState">All series hidden. Use the legend to show a metric.</p>}
              </div>
            </div>
          </div>
          <div className="requestSnapshotFooter">
            <div className="requestSnapshotLegend" aria-label="Request snapshot components">
              {snapshotComponents.map((component) => (
                <button
                  className={`requestSnapshotLegendItem ${component.className}`}
                  type="button"
                  role="switch"
                  aria-checked={visibleSeries[component.key]}
                  onClick={() => setVisibleSeries((current) => ({ ...current, [component.key]: !current[component.key] }))}
                  key={component.key}
                >
                  <i aria-hidden="true" />{component.label}
                </button>
              ))}
            </div>
            <span>Scale fixed across scopes and toggles · {compactNumber(maximum)} max</span>
          </div>
          <p className="instrumentAnnouncement" id={announcementId} aria-live="polite" aria-atomic="true">{announcement}</p>
        </div>
      )}

      {cacheWriteAvailable && <div className="cacheEvidenceSection">
        <div className="cacheEvidenceHeader">
          <div><h3>Cache evidence</h3><p>Transitions from provider-reported token counts. Not cost.</p></div>
          {cacheEvents?.status === "ready" && <span>{allScopedEvents.length} {allScopedEvents.length === 1 ? "event" : "events"}</span>}
        </div>
        {cacheEvents?.status !== "ready" ? (
          <p className="cacheEvidenceState">{historical ? "No comparable cache snapshots were recorded for this session." : "Comparable cache snapshots are not available yet for this session."}</p>
        ) : allScopedEvents.length === 0 ? (
          <p className="cacheEvidenceState">{historical ? `No cache transitions were recorded for ${scopeLabel}.` : `Watching for meaningful cache transitions for ${scopeLabel}…`}</p>
        ) : <>
          {hiddenEventCount > 0 && (
            <button className="cacheEvidenceExpand" type="button" onClick={() => setShowAllEvents((current) => !current)} aria-expanded={showAllEvents}>
              {showAllEvents ? `Show recent ${RECENT_EVENT_COUNT}` : `Show ${hiddenEventCount} earlier ${hiddenEventCount === 1 ? "event" : "events"}`}
            </button>
          )}
          <ol className="cacheEvidenceList">
            {visibleEvents.map((event) => {
              const snapshotIndex = matchingSnapshotIndex(event);
              const eventKey = snapshotEventKey(event.agentId, event.observedAt);
              return <CacheEventRow
                event={event}
                agentLabel={agentById.has(event.agentId) ? agentDisplayLabel(agentById.get(event.agentId)!) : "Agent"}
                showAgent={resolvedScope === ALL_AGENTS_SCOPE}
                interactive={snapshotIndex !== null}
                active={eventKey !== null && eventKey === activeSnapshotKey}
                selected={snapshotIndex !== null && snapshotIndex === selectedSnapshotIndex}
                onHover={() => { if (snapshotIndex !== null) setHoveredSnapshotIndex(snapshotIndex); }}
                onHoverEnd={() => setHoveredSnapshotIndex(null)}
                onFocus={() => { if (snapshotIndex !== null) setFocusedSnapshotIndex(snapshotIndex); }}
                onBlur={() => setFocusedSnapshotIndex(null)}
                onSelect={() => { if (snapshotIndex !== null) setSelectedSnapshotIndex(snapshotIndex); }}
                onClearSelection={clearInspection}
                key={event.id}
              />;
            })}
          </ol>
        </>}
      </div>}
    </section>
  );
}
