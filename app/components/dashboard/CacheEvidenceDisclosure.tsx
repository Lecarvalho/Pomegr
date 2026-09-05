"use client";

import { useState, type KeyboardEvent } from "react";
import type { Agent, CacheEvent, RequestSnapshot, RequestSnapshotFeed, CacheEventFeed } from "../../../shared/monitor-contract";
import { agentDisplayLabel, timelineTime } from "../../dashboard-utils";
import { snapshotEventKey } from "./requests-actions/model";
import { DashboardDisclosurePanel } from "./DashboardDisclosurePanel";

export const CACHE_EVIDENCE_STORAGE_KEY = "pomegr-disclosure-cache-evidence";
export const RECENT_CACHE_EVENT_COUNT = 5;



export function eventTitle(kind: CacheEvent["kind"]) {
  if (kind === "miss_refill") return "Possible cache miss · refill";
  if (kind === "reuse") return "Cache reuse";
  return "Cache refill";
}

export type CacheEventRowProps = {
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
};

/** Compact cache evidence with an optional link to its matching request. */
export function CacheEventRow({ event, agentLabel, showAgent, interactive, active, selected, onHover, onHoverEnd, onFocus, onBlur, onSelect, onClearSelection }: CacheEventRowProps) {
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

export type CacheEvidenceDisclosureProps = {
  agents: Agent[];
  cacheEvents?: CacheEventFeed | null;
  requestSnapshots?: RequestSnapshotFeed | null;
  cacheWriteAvailable: boolean;
  historical: boolean;
  onSelectSnapshot?: (snapshot: RequestSnapshot) => void;
  selectedSnapshot?: RequestSnapshot | null;
};

export function CacheEvidenceDisclosure({ agents, cacheEvents, requestSnapshots, cacheWriteAvailable, historical, onSelectSnapshot, selectedSnapshot }: CacheEvidenceDisclosureProps) {
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);

  if (!cacheWriteAvailable) return null;

  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const allEvents = cacheEvents?.status === "ready"
    ? [...cacheEvents.items].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id))
    : [];
  const visibleEvents = showAllEvents ? allEvents : allEvents.slice(-RECENT_CACHE_EVENT_COUNT);
  const hiddenEventCount = Math.max(0, allEvents.length - RECENT_CACHE_EVENT_COUNT);
  const snapshotByKey = new Map<string, RequestSnapshot>();
  for (const snapshot of requestSnapshots?.items || []) {
    const key = snapshotEventKey(snapshot.agentId, snapshot.observedAt);
    if (key !== null && !snapshotByKey.has(key)) snapshotByKey.set(key, snapshot);
  }
  const selectedKey = selectedSnapshot ? snapshotEventKey(selectedSnapshot.agentId, selectedSnapshot.observedAt) : null;
  const summary = `${allEvents.length} ${allEvents.length === 1 ? "event" : "events"}`;

  return (
    <DashboardDisclosurePanel
      className="cacheEvidenceDisclosure sessionEvidenceDisclosure"
      defaultOpen={false}
      storageKey={CACHE_EVIDENCE_STORAGE_KEY}
      summary={<span className="sessionEvidenceSummary">{summary}</span>}
      title="Cache evidence"
    >
      <div className="cacheEvidenceSection">
        <div className="cacheEvidenceHeader">
          <div><h3>Cache evidence</h3><p>Transitions from provider-reported token counts. Not cost.</p></div>
          {cacheEvents?.status === "ready" && <span>{summary}</span>}
        </div>
        {cacheEvents?.status !== "ready" ? (
          <p className="cacheEvidenceState">{historical ? "No comparable cache snapshots were recorded for this session." : "Comparable cache snapshots are not available yet for this session."}</p>
        ) : allEvents.length === 0 ? (
          <p className="cacheEvidenceState">{historical ? "No cache transitions were recorded for this session." : "Watching for meaningful cache transitions…"}</p>
        ) : <>
          {hiddenEventCount > 0 && (
            <button className="cacheEvidenceExpand" type="button" onClick={() => setShowAllEvents((current) => !current)} aria-expanded={showAllEvents}>
              {showAllEvents ? `Show recent ${RECENT_CACHE_EVENT_COUNT}` : `Show ${hiddenEventCount} earlier ${hiddenEventCount === 1 ? "event" : "events"}`}
            </button>
          )}
          <ol className="cacheEvidenceList">
            {visibleEvents.map((event) => {
              const eventKey = snapshotEventKey(event.agentId, event.observedAt);
              const snapshot = eventKey === null ? undefined : snapshotByKey.get(eventKey);
              const interactive = Boolean(snapshot && onSelectSnapshot);
              return <CacheEventRow
                event={event}
                agentLabel={agentById.has(event.agentId) ? agentDisplayLabel(agentById.get(event.agentId)!) : "Agent"}
                showAgent
                interactive={interactive}
                active={event.id === hoveredEventId || event.id === focusedEventId || (eventKey !== null && eventKey === selectedKey)}
                selected={Boolean(eventKey !== null && eventKey === selectedKey)}
                onHover={() => setHoveredEventId(event.id)}
                onHoverEnd={() => setHoveredEventId(null)}
                onFocus={() => setFocusedEventId(event.id)}
                onBlur={() => setFocusedEventId(null)}
                onSelect={() => { if (snapshot) onSelectSnapshot?.(snapshot); }}
                onClearSelection={() => undefined}
                key={event.id}
              />;
            })}
          </ol>
        </>}
      </div>
    </DashboardDisclosurePanel>
  );
}
