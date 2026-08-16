"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { Agent, CacheEvent, MonitorState, RequestSnapshot } from "../../../shared/monitor-contract";
import { compactNumber, formatDuration, timelineTime } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";

type TokenMetrics = MonitorState["metrics"]["tokens"];
type SnapshotComponent = "uncachedInputTokens" | "cacheWriteTokens" | "cacheReadTokens" | "outputTokens";

const ALL_AGENTS_SCOPE = "all-agents";
const RECENT_EVENT_COUNT = 5;
const MINIMUM_BAR_STEP = 26;
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

function snapshotEventKey(agentId: string, observedAt: string) {
  return `${agentId}\u0000${observedAt}`;
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

export function RequestSnapshotsPanel({ agents, requestSnapshots, cacheEvents, historical }: {
  agents: Agent[];
  requestSnapshots: TokenMetrics["requestSnapshots"];
  cacheEvents: TokenMetrics["cacheEvents"];
  historical: boolean;
}) {
  const snapshots = [...(requestSnapshots?.items || [])].sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  ));
  const [scope, setScope] = useState(() => initialScope(agents, snapshots));
  const [activeSnapshotIndex, setActiveSnapshotIndex] = useState<number | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);
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
  const maximum = niceMaximum(Math.max(0, ...snapshots.map((snapshot) => snapshot.totalTokens)));
  const resolvedActiveIndex = activeSnapshotIndex === null
    ? scopedSnapshots.length - 1
    : Math.max(0, Math.min(activeSnapshotIndex, scopedSnapshots.length - 1));
  const activeSnapshot = scopedSnapshots[resolvedActiveIndex];
  const spansMultipleDays = snapshots.length > 0
    && Date.parse(snapshots.at(-1)?.observedAt || "") - Date.parse(snapshots[0].observedAt) >= 24 * 60 * 60_000;

  const allScopedEvents = [...(cacheEvents?.items || [])]
    .filter((event) => resolvedScope === ALL_AGENTS_SCOPE || event.agentId === resolvedScope)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const visibleEvents = showAllEvents ? allScopedEvents : allScopedEvents.slice(-RECENT_EVENT_COUNT);
  const hiddenEventCount = Math.max(0, allScopedEvents.length - RECENT_EVENT_COUNT);
  const eventsBySnapshot = new Map<string, CacheEvent[]>();
  for (const event of cacheEvents?.items || []) {
    const key = snapshotEventKey(event.agentId, event.observedAt);
    eventsBySnapshot.set(key, [...(eventsBySnapshot.get(key) || []), event]);
  }
  const snapshotsByEvent = new Map(snapshots.map((snapshot) => [
    snapshotEventKey(snapshot.agentId, snapshot.observedAt),
    snapshot,
  ]));
  const activeEvents = activeSnapshot
    ? eventsBySnapshot.get(snapshotEventKey(activeSnapshot.agentId, activeSnapshot.observedAt)) || []
    : [];
  const activeAgentLabel = activeSnapshot
    ? agentById.get(activeSnapshot.agentId)?.label || "Agent"
    : scopeLabel;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollLeft = viewport.scrollWidth;
  }, [resolvedScope, scopedSnapshots.length]);

  useEffect(() => {
    if (activeSnapshotIndex === null) return;
    const activeBar = chartRef.current?.querySelector<HTMLElement>(`[data-snapshot-index="${resolvedActiveIndex}"]`);
    const viewport = viewportRef.current;
    if (!activeBar || !viewport) return;
    if (activeBar.offsetLeft < viewport.scrollLeft) viewport.scrollLeft = activeBar.offsetLeft;
    else if (activeBar.offsetLeft + activeBar.offsetWidth > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = activeBar.offsetLeft + activeBar.offsetWidth - viewport.clientWidth;
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
    ? `${activeAgentLabel}, ${timelineTime(activeSnapshot.observedAt, spansMultipleDays)}. ${activeSnapshot.uncachedInputTokens.toLocaleString()} uncached input, ${activeSnapshot.cacheWriteTokens.toLocaleString()} cache write, ${activeSnapshot.cacheReadTokens.toLocaleString()} cache read, ${activeSnapshot.outputTokens.toLocaleString()} output, ${activeSnapshot.totalTokens.toLocaleString()} total.${activeEvents.length ? ` ${activeEvents.map((event) => eventTitle(event.kind)).join(", ")}.` : ""}`
    : "No request snapshot selected.";

  return (
    <section className={`panel requestSnapshotsPanel ${historical ? "historical" : ""}`} aria-label="Request snapshots and cache evidence">
      <div className="requestSnapshotsHeader">
        <div>
          <h2>Request snapshots</h2>
          <p>Each bar is one provider usage snapshot. Equal spacing; timestamps appear in the readout. Not cumulative.</p>
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
            <dl>
              {SNAPSHOT_COMPONENTS.map((component) => (
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
                style={{ minWidth: `${scopedSnapshots.length * MINIMUM_BAR_STEP}px` }}
              >
                <div className="requestSnapshotGrid" aria-hidden="true"><i /><i /><i /></div>
                <div className="requestSnapshotBars" style={{ "--snapshot-count": scopedSnapshots.length } as CSSProperties} aria-hidden="true">
                  {scopedSnapshots.map((snapshot, index) => {
                    const events = eventsBySnapshot.get(snapshotEventKey(snapshot.agentId, snapshot.observedAt)) || [];
                    return (
                      <div className={`requestSnapshotBar${index === resolvedActiveIndex ? " active" : ""}${events.length ? " hasCacheEvent" : ""}`} data-snapshot-index={index} data-snapshot-id={snapshot.id} key={snapshot.id}>
                        {events.length > 0 && <i className={`requestSnapshotEventMarker ${events[0].kind}`} />}
                        <div className="requestSnapshotStack">
                          {SNAPSHOT_COMPONENTS.map((component) => (
                            <i className={component.className} key={component.key} style={{ height: `${snapshot[component.key] / maximum * 100}%` }} />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <div className="requestSnapshotFooter">
            <div className="requestSnapshotLegend" aria-label="Request snapshot components">
              {SNAPSHOT_COMPONENTS.map((component) => <span className={component.className} key={component.key}><i aria-hidden="true" />{component.label}</span>)}
            </div>
            <span>Scale fixed across scopes · {compactNumber(maximum)} max</span>
          </div>
          <p className="instrumentAnnouncement" id={announcementId} aria-live="polite" aria-atomic="true">{announcement}</p>
        </div>
      )}

      <div className="cacheEvidenceSection">
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
              snapshot={snapshotsByEvent.get(snapshotEventKey(event.agentId, event.observedAt)) || null}
              agentLabel={agentById.get(event.agentId)?.label || "Agent"}
              key={event.id}
            />)}
          </ol>
        </>}
      </div>
    </section>
  );
}
