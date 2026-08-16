"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { Agent, CacheEvent, MonitorState, RequestSnapshot } from "../../../shared/monitor-contract";
import { compactNumber, formatDuration, timelineTime } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";

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
  if (kind === "miss_refill") return "Possible cache miss · refill recorded";
  if (kind === "reuse") return "Cache reuse recorded";
  return "Cache refill recorded";
}

function eventDetail(event: CacheEvent) {
  if (event.kind === "miss_refill" && event.previousCacheReadPercent !== null && event.gapMs !== null) {
    return `Cached input fell from ${event.previousCacheReadPercent}% to ${event.cacheReadPercent}% after ${formatDuration(event.gapMs)}; a large refill was recorded.`;
  }
  if (event.kind === "reuse") {
    return event.relatedEventId && event.gapMs !== null
      ? `Cache reuse was recorded ${formatDuration(event.gapMs)} after its linked refill.`
      : "Pomegr derived cache reuse from the reported token counts for this request.";
  }
  return "Pomegr derived a large cache refill from the reported token counts for this request.";
}

function CacheEventRow({ event, snapshot, agentLabel }: {
  event: CacheEvent;
  snapshot: RequestSnapshot | null;
  agentLabel: string;
}) {
  return (
    <li className={`cacheEvidenceRow ${event.kind}`}>
      <span className="cacheEvidenceMark" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          {event.kind === "reuse"
            ? <path d="M3 9.5a5 5 0 0 0 8.7 1.5M13 6.5A5 5 0 0 0 4.3 5M3 3v3h3M13 13v-3h-3" />
            : <><path d="M8 2v8" /><path d="m4.5 7 3.5 3.5L11.5 7" /><path d="M3 13h10" /></>}
        </svg>
      </span>
      <div className="cacheEvidenceBody">
        <div className="cacheEvidenceTitle">
          <strong>{eventTitle(event.kind)}</strong>
          <span>{agentLabel} · <time dateTime={event.observedAt}>{timelineTime(event.observedAt)}</time></span>
        </div>
        <p>{eventDetail(event)}</p>
      </div>
      <dl className="cacheEvidenceMetrics">
        <div><dt>Cache read</dt><dd>{snapshot ? `${snapshot.cacheReadTokens.toLocaleString()} (${event.cacheReadPercent}%)` : `${event.cacheReadPercent}%`}</dd></div>
        <div><dt>Cache write</dt><dd>{(snapshot?.cacheWriteTokens ?? event.cacheWriteTokens).toLocaleString()}</dd></div>
        <div><dt>Prompt input</dt><dd>{event.promptInputTokens.toLocaleString()}</dd></div>
      </dl>
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
  const [activeSnapshotIndex, setActiveSnapshotIndex] = useState<number | null>(null);
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
  const scopeLabel = resolvedScope === ALL_AGENTS_SCOPE ? "All agents" : agentById.get(resolvedScope)?.label || "Selected agent";
  const scopedSnapshots = snapshots.filter((snapshot) => (
    resolvedScope === ALL_AGENTS_SCOPE || snapshot.agentId === resolvedScope
  ));
  const maximum = niceMaximum(Math.max(0, ...snapshots.flatMap((snapshot) => [
    snapshot.totalTokens,
    ...snapshotComponents.map((component) => snapshot[component.key]),
  ])));
  const resolvedActiveIndex = activeSnapshotIndex === null
    ? scopedSnapshots.length - 1
    : Math.max(0, Math.min(activeSnapshotIndex, scopedSnapshots.length - 1));
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
  const snapshotsByEvent = new Map<string, RequestSnapshot>();
  for (const snapshot of snapshots) {
    const key = snapshotEventKey(snapshot.agentId, snapshot.observedAt);
    if (key !== null) snapshotsByEvent.set(key, snapshot);
  }
  const matchingSnapshot = (event: CacheEvent) => {
    const key = snapshotEventKey(event.agentId, event.observedAt);
    return key === null ? null : snapshotsByEvent.get(key) || null;
  };
  const activeSnapshotKey = activeSnapshot
    ? snapshotEventKey(activeSnapshot.agentId, activeSnapshot.observedAt)
    : null;
  const activeEvents = activeSnapshotKey === null ? [] : eventsBySnapshot.get(activeSnapshotKey) || [];
  const activeAgentLabel = activeSnapshot
    ? agentById.get(activeSnapshot.agentId)?.label || "Agent"
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
    if (activeSnapshotIndex === null) return;
    const activePoint = chartRef.current?.querySelector<HTMLElement>(`[data-snapshot-index="${resolvedActiveIndex}"]`);
    const viewport = viewportRef.current;
    if (!activePoint || !viewport) return;
    if (activePoint.offsetLeft < viewport.scrollLeft) viewport.scrollLeft = activePoint.offsetLeft;
    else if (activePoint.offsetLeft + activePoint.offsetWidth > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = activePoint.offsetLeft + activePoint.offsetWidth - viewport.clientWidth;
    }
  }, [activeSnapshotIndex, resolvedActiveIndex]);

  const handleChartKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (scopedSnapshots.length === 0) return;
    let next = resolvedActiveIndex;
    if (event.key === "ArrowLeft") next = Math.max(0, resolvedActiveIndex - 1);
    else if (event.key === "ArrowRight") next = Math.min(scopedSnapshots.length - 1, resolvedActiveIndex + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = scopedSnapshots.length - 1;
    else return;
    event.preventDefault();
    setActiveSnapshotIndex(next === scopedSnapshots.length - 1 ? null : next);
  };

  const handleChartPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (scopedSnapshots.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const next = Math.round(progress * (scopedSnapshots.length - 1));
    setActiveSnapshotIndex(next === scopedSnapshots.length - 1 ? null : next);
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
          <select aria-label="Request scope" value={resolvedScope} onChange={(event) => {
            setScope(event.target.value);
            setActiveSnapshotIndex(null);
            setShowAllEvents(false);
          }}>
            {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.label}</option>)}
            <option value={ALL_AGENTS_SCOPE}>All agents</option>
          </select>
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
            {activeSnapshotIndex !== null && activeSnapshotIndex < scopedSnapshots.length - 1 && (
              <button type="button" onClick={() => setActiveSnapshotIndex(null)}>Latest</button>
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
                onPointerLeave={(event) => { if (document.activeElement !== event.currentTarget) setActiveSnapshotIndex(null); }}
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
                  {scopedSnapshots.map((snapshot, index) => {
                    const key = snapshotEventKey(snapshot.agentId, snapshot.observedAt);
                    const events = key === null ? [] : eventsBySnapshot.get(key) || [];
                    return (
                      <div className={`requestSnapshotPointColumn${index === resolvedActiveIndex ? " active" : ""}${events.length ? " hasCacheEvent" : ""}`} data-snapshot-index={index} data-snapshot-id={snapshot.id} key={snapshot.id}>
                        {events.length > 0 && <i className={`requestSnapshotEventMarker ${events[0].kind}`} />}
                        {snapshotComponents.map((component) => (
                          <i
                            className={`contextChartPoint ${component.className}ChartPoint${visibleSeries[component.key] ? "" : " isHidden"}`}
                            key={component.key}
                            style={{ "--point-y": `${pointsBySeries[component.key][index].y / CHART_HEIGHT * 100}%` } as CSSProperties}
                          />
                        ))}
                      </div>
                    );
                  })}
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
          <div><h3>Cache evidence</h3><p>Meaningful cache transitions derived by Pomegr from provider-reported token counts. Evidence, not cost.</p></div>
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
            {visibleEvents.map((event) => <CacheEventRow
              event={event}
              snapshot={matchingSnapshot(event)}
              agentLabel={agentById.get(event.agentId)?.label || "Agent"}
              key={event.id}
            />)}
          </ol>
        </>}
      </div>}
    </section>
  );
}
