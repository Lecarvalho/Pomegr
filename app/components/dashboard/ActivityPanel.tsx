"use client";

import { useMemo, useState } from "react";
import type { Activity, ActivityFeed } from "../../../shared/monitor-contract";
import { shortTime } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";
import { WorkKindIcon } from "../WorkKindIcon";
import { WORK_LABELS } from "../agents/agent-presentation";
import { DashboardDisclosurePanel } from "./DashboardDisclosurePanel";
import type { SessionRequestSelection } from "./requests-actions/useSessionRequestSelection";
import { requestMarker } from "./requests-actions/model";
import { ACTIVITY_PAGE_SIZE, useActivityHistory } from "./useActivityHistory";

const PAGE_SIZE = ACTIVITY_PAGE_SIZE;
type Scope = "all" | "primary" | "subagents";

export function activityDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Number((value / 1_000).toFixed(1))}s`;
  if (value < 3_600_000) return `${Number((value / 60_000).toFixed(1))}m`;
  return `${Number((value / 3_600_000).toFixed(1))}h`;
}

function ActivityBreakdown({ activity }: { activity: ActivityFeed }) {
  const [expanded, setExpanded] = useState(false);
  const kinds = [...activity.byKind].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const largest = Math.max(1, ...kinds.map((row) => row.count));
  return <div className="activityBreakdown">
    <header><h3 className="sessionEyebrow">Actions by kind</h3><span>count · share · median duration</span></header>
    {(expanded ? kinds : kinds.slice(0, 7)).map(({ kind, count, medianDurationMs }) => <div className="activityKindRow" key={kind}>
      <WorkKindIcon kind={kind} /><span className="activityKindLabel">{WORK_LABELS[kind]}</span>
      <span className="activityKindTrack"><i style={{ width: `${count / largest * 100}%` }} /></span>
      <strong>{count.toLocaleString()}</strong><span>{activity.toolCalls ? Math.round(count / activity.toolCalls * 100) : 0}%</span><span>{activityDuration(medianDurationMs)}</span>
    </div>)}
    {kinds.length > 7 && <button type="button" className="commandTextLink" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer kinds" : `Show ${kinds.length - 7} more kinds`}</button>}
    <div className="activityOtherCounts"><div><span>Messages &amp; input</span><strong>{activity.messages.toLocaleString()}</strong></div><div className={activity.failed ? "activityFailures" : ""}><span>Failed shell runs</span><strong>{activity.failed.toLocaleString()}</strong></div></div>
    <p>Counts describe recorded tool calls, not effort or quality. Duration is wall time from call to result, including approval waits.</p>
  </div>;
}

function ActivityRow({ event, ordinal, selected, phone, onSelect }: { event: Activity; ordinal?: number; selected: boolean; phone: boolean; onSelect: () => void }) {
  const content = <>
    <time className="activityTime">{shortTime(event.timestamp)}</time>
    <span className="actor"><i aria-hidden="true" /><span>{event.actor}</span></span>
    <span className="activityAction"><WorkKindIcon kind={event.workKind} /><strong>{event.tool}</strong></span>
    <span className="target" title={event.detail}>{event.detail || "—"}</span>
    <span className={`activityDuration${event.durationMs === null ? " unavailable" : ""}`}>{activityDuration(event.durationMs)}</span>
    <span className={`activityRequest${ordinal ? " commandTextLink" : " unavailable"}`} title={ordinal ? `Related request #${ordinal}` : "No recorded request link"}>{ordinal ? `#${ordinal}` : "—"}</span>
  </>;
  const className = `activityRow${event.status === "failed" ? " failed" : ""}${selected ? " selected" : ""}${phone ? " activityRowPhone" : ""}`;
  return ordinal ? <button type="button" className={`commandQuietAction ${className}`} aria-pressed={selected} onClick={onSelect} aria-label={`${event.tool}, ${event.actor}, request #${ordinal}`}>{content}</button>
    : <div className={className}>{content}</div>;
}

/** Explicit selection reveals linked rows; manual paging anchors later live pages by row id. */
export function ActivityPanel({ activity, historical, loading, onRefresh, selection, sessionId, historyEnabled = false }: {
  activity: ActivityFeed; historical: boolean; loading: boolean; onRefresh: () => void; selection: SessionRequestSelection; sessionId: string; historyEnabled?: boolean;
}) {
  const [scope, setScope] = useState<Scope>("all");
  const [paging, setPaging] = useState({ scope, offset: 0, anchor: null as string | null });
  const { selected, phone, navigation } = selection;
  const [handledNavigation, setHandledNavigation] = useState(navigation);
  const navigating = navigation !== handledNavigation && navigation?.id === selected?.id;
  const scopedItems = useMemo(() => {
    const primary = selection.agents.find((agent) => agent.id === "primary")?.label ?? "Primary agent";
    const children = new Set(selection.agents.filter((agent) => agent.id !== "primary").map((agent) => agent.label));
    return activity.items.filter((event) => scope === "all" || (scope === "primary" ? event.actor === primary : children.has(event.actor)));
  }, [activity.items, scope, selection.agents]);
  const revealAll = navigating && (historyEnabled
    ? (scope === "primary" && selected?.agentId !== "primary") || (scope === "subagents" && selected?.agentId === "primary")
    : !scopedItems.some((event) => event.requestId === selected?.id) && activity.items.some((event) => event.requestId === selected?.id));
  const activeScope = revealAll ? "all" : scope;
  const items = revealAll ? activity.items : scopedItems;
  const history = useActivityHistory({ enabled: historyEnabled, sessionId, scope: activeScope, filterRequestId: null, navigation });
  const anchorIndex = !historical && paging.offset > 0 && paging.anchor ? items.findIndex((event) => event.id === paging.anchor) : -1;
  let offset = paging.scope !== activeScope ? 0 : Math.max(0, Math.min(anchorIndex >= 0 ? anchorIndex : paging.offset, Math.max(0, items.length - 1)));
  if (navigation !== handledNavigation) {
    setHandledNavigation(navigation);
    if (navigating) {
      if (revealAll) setScope("all");
      const index = items.findIndex((event) => event.requestId === selected?.id);
      if (index >= 0 && !items.slice(offset, offset + PAGE_SIZE).some((event) => event.requestId === selected?.id)) {
        offset = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
      }
      setPaging({ scope: activeScope, offset, anchor: items[offset]?.id ?? null });
    }
  }
  if (historyEnabled) offset = history.page?.offset ?? 0;
  const total = historyEnabled ? history.page?.total ?? 0 : items.length;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const visible = historyEnabled ? history.page?.items ?? [] : items.slice(offset, offset + PAGE_SIZE);
  const goToPage = (value: number) => {
    if (historyEnabled) return history.goToPage(Math.max(1, Math.min(value, pages)));
    const start = (Math.max(1, Math.min(value, pages)) - 1) * PAGE_SIZE;
    setPaging({ scope, offset: start, anchor: items[start]?.id ?? null });
  };
  const requestRows = new Map(selection.allRows.map((row) => [row.id, row]));
  for (const row of selection.rows) requestRows.set(row.id, row);
  const highlightedIndex = selected ? items.findIndex((event) => event.requestId === selected.id) : -1;
  const highlightVisible = selected && visible.some((event) => event.requestId === selected.id);
  const highlightedPage = highlightedIndex < 0 ? null : Math.floor(highlightedIndex / PAGE_SIZE) + 1;
  const selectedNumber = selected && requestMarker(selected);
  const selectionStatus = historyEnabled ? (highlightVisible ? "highlighted" : history.loading ? "· locating activity…" : "") : highlightedIndex >= 0 ? "highlighted" : activity.items.some((event) => event.requestId === selected?.id)
    ? "· linked activity outside this agent scope" : "· no linked activity in retained feed";
  const pageNumbers = [...new Set([1, page - 1, page, page + 1, pages])].filter((value) => value >= 1 && value <= pages).sort((a, b) => a - b);
  const topKinds = [...activity.byKind].sort((a, b) => b.count - a.count).slice(0, 3);
  return <section className="panel activityPanel" aria-label="Activity">
    <header className="activityPanelHeader">
      <div><h2>Activity</h2><p>{historyEnabled ? total.toLocaleString() : activity.total.toLocaleString()} {(historyEnabled ? total : activity.total) === 1 ? "event" : "events"}{!historyEnabled && <> · {activity.toolCalls.toLocaleString()} tool calls · {activity.byKind.length} kinds</>}{selected && <> · request <span className="activitySelectedNumber">{selectedNumber}</span> {selectionStatus}{historyEnabled && history.linkedCount !== null && <> · {history.linkedCount} linked {history.linkedCount === 1 ? "event" : "events"}</>}{!historyEnabled && !highlightVisible && highlightedPage !== null && <> · on <button className="commandTextLink" type="button" onClick={() => goToPage(highlightedPage)}>page {highlightedPage}</button></>}</>}</p></div>
      <div className="activityControls"><div className="commandSegmented" role="group" aria-label="Activity agent scope">{([["all", "All agents"], ["primary", "Primary"], ["subagents", "Subagents"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={scope === value} onClick={() => { setScope(value); setPaging({ scope: value, offset: 0, anchor: null }); }}>{label}</button>)}</div><button className="commandQuietAction" type="button" onClick={() => { onRefresh(); history.refresh(); }} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    </header>
    {historyEnabled && history.newEvents > 0 && <div className="activityLinkNote"><button type="button" className="commandTextLink" onClick={history.latest}>{history.newEvents} new events · View latest</button></div>}
    <div className="activityLayout">
      {phone ? <DashboardDisclosurePanel className="activityBreakdownDisclosure" title="Actions by kind" summary={<span>{topKinds.map(({ kind, count }) => `${WORK_LABELS[kind]} ${activity.toolCalls ? Math.round(count / activity.toolCalls * 100) : 0}%`).join(" · ")}</span>} defaultOpen={false} icon="chevron" storageKey={`pomegr-activity-breakdown-${sessionId}`}><ActivityBreakdown activity={activity} /></DashboardDisclosurePanel> : <ActivityBreakdown activity={activity} />}
      <div className="activityFeed">
        <div className="activityTable" aria-busy={historyEnabled && history.loading}>
          {!phone && <div className="activityHead"><span>TIME</span><span>AGENT</span><span>ACTION</span><span>TARGET</span><span>DURATION</span><span>REQUEST</span></div>}
          {!visible.length && <EmptyState text={historyEnabled && history.loading ? "Loading session history…" : historyEnabled && history.failed ? "Session history is unavailable. Try Refresh." : scope !== "all" ? "No activity for these agents." : historical ? "No activity was recorded for this session." : "Tool use and messages will appear here as they happen."} />}
          {visible.map((event) => <ActivityRow key={event.id} event={event} ordinal={"requestNumber" in event && typeof event.requestNumber === "number" ? event.requestNumber : !historyEnabled && event.requestId ? requestRows.get(event.requestId)?.ordinal : undefined} selected={Boolean(event.requestId && event.requestId === selected?.id)} phone={phone} onSelect={() => { if (event.requestId) selection.locate(event.requestId); }} />)}
        </div>
        <footer className="activityPagination">
          {!phone && <span>Showing {total ? offset + 1 : 0}–{Math.min(offset + PAGE_SIZE, total)} of {total}{scope !== "all" ? " in this scope" : ""}{historyEnabled && history.loading ? " · Loading…" : ""}</span>}
          <nav aria-label="Activity pages"><button className="commandSecondaryAction" type="button" disabled={offset === 0} onClick={() => goToPage(page - 1)}>Previous</button>
            {!phone && pageNumbers.map((value, index) => <span className="activityPageNumber" key={value}>{index > 0 && value - pageNumbers[index - 1] > 1 && <span>…</span>}<button type="button" className="commandSecondaryAction" aria-current={page === value ? "page" : undefined} onClick={() => goToPage(value)}>{value}</button></span>)}
            <button className="commandSecondaryAction" type="button" disabled={offset + PAGE_SIZE >= total} onClick={() => goToPage(page + 1)}>Next</button></nav>
          {phone && <span>Page {page} of {pages} · {total} events</span>}
        </footer>
      </div>
    </div>
  </section>;
}
