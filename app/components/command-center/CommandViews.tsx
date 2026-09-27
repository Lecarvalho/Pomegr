"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HomeProviderUsageLimits, ProviderServiceStatus, SessionCatalogCoverage, SessionDirectorySnapshot, SessionSummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { relativeTime, sessionListTime, sessionState } from "../../dashboard-utils";
import { useSessionCatalog } from "../../hooks/SessionCatalogContext";
import { usageLimitDisplay, usageLimitFailureKind, usageLimitFailureMessage } from "../../usage-limit-presentation";
import { useUsageLimits } from "../../usage-limits-client";
import { useProviderStatus } from "../../provider-status-client";
import { RetryCountdownText } from "../LiveTime";
import { ClaudeUsageControls } from "../ClaudeUsageControls";
import { CodexUsageHelp } from "../CodexUsageHelp";
import { AgentChip } from "../AgentChip";
import { ProviderBadge } from "../ProviderBadge";
import { ProviderServiceNotice, ProviderStatusArea, ProviderStatusDetails, providerHasServiceIssue, providerIncidentRank, providerServiceNoticeVisible, providerStatusFor, type ProviderIncidentDismissal } from "../ProviderStatus";
import { CommandTable, type CommandTableColumn } from "./CommandTable";
import { SessionCacheTiming } from "./SessionCacheTiming";
import { CommandEmpty, CommandFilter, CommandIcon, CommandPage, CommandSearch, CommandSelect, CommandStatus, CommandToolbar } from "./CommandPage";
import { useProviderSettingsAvailable } from "../../settings/ProviderSettings";
import { subscribeLiveEvents } from "../../live-events";
export { AgentsView } from "../agents/AgentsView";
export { RepositoryInventoryView as RepositoriesView } from "../repositories/RepositoryInventoryView";

function sessionHref(session: SessionSummary) {
  try { return `/sessions/${encodeSessionRoute(session.id)}`; } catch { return "/"; }
}

function sessionTimestamp(value: string) {
  return <time dateTime={value} title={sessionListTime(value)}>{relativeTime(value)}</time>;
}

type DisplayActivity = {
  label: string;
  observedAt: string;
  state: "current" | "last_observed";
  provenance: "Provider-reported" | "Execution task" | "Tool activity";
  actor?: "primary" | "subagent" | "multiple" | "unknown";
};

const activityActorLabel = {
  primary: "Primary agent",
  subagent: "Subagent",
  multiple: "Multiple agents",
} as const;

function sessionActivity(session: SessionSummary): DisplayActivity | null {
  // Guard older monitor responses during upgrades; lifecycle qualification is backend-owned.
  const canShowCurrent = session.isLive && ["working", "needs_input"].includes(session.activityStatus);
  if (canShowCurrent && session.currentActivity?.state === "current") {
    return { ...session.currentActivity, provenance: "Provider-reported" };
  }
  const fallback = session.activityFallback;
  if (!fallback || !["current", "last_observed"].includes(fallback.state)) return null;
  // A task-derived current label cannot outlive the live lifecycle qualification.
  if (fallback.state === "current" && !canShowCurrent) return null;
  return {
    ...fallback,
    provenance: fallback.source === "execution_task" ? "Execution task" : "Tool activity",
  };
}

function SessionCurrentActivity({ session, compact = false }: { session: SessionSummary; compact?: boolean }) {
  const activity = sessionActivity(session);
  const label = activity?.label ?? "—";
  // Relative time, actor, and provenance can refresh independently; only a displayed label change fades in.
  const identity = label;
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const previousIdentity = useRef<string | null>(null);
  useEffect(() => {
    const labelElement = labelRef.current;
    if (labelElement && previousIdentity.current !== null && previousIdentity.current !== identity) {
      labelElement.classList.add("commandTableActivityLabelChanged");
    }
    previousIdentity.current = identity;
  }, [identity]);

  const actor = activity?.actor && activity.actor !== "unknown" ? activityActorLabel[activity.actor] : null;
  const age = activity ? relativeTime(activity.observedAt) : null;
  const provenance = activity ? [activity.provenance, age, actor].filter(Boolean).join(" · ") : "Activity is unavailable";
  const accessibleLabel = activity
    ? `${activity.state === "current" ? "Current activity" : "Previous activity"}: ${activity.label}. ${provenance}.`
    : provenance;
  return <AgentChip className={`commandTableActivity${activity ? "" : " commandTableActivityUnavailable"}${activity?.state === "last_observed" ? " commandTableActivityLast" : ""}${compact ? " commandTableActivityCompact" : ""}`} title={`${label} · ${provenance}`} ariaLabel={accessibleLabel}>
    {activity && <span className="commandTableActivityMark" aria-hidden="true" />}
    {!activity && <span className="commandTableActivityMarkPlaceholder" aria-hidden="true" />}
    <span className="commandTableActivityLabel" key={identity} ref={labelRef}>{label}</span>
    {actor && activity?.actor !== "primary" && <span className="commandTableActivityMeta"> · {actor}</span>}
  </AgentChip>;
}

const SESSION_PAGE_SIZE = 25;

function SessionSummaryLoading({ session }: { session: SessionSummary }) {
  if (!session.isLive || session.summaryReadiness !== "loading") return null;
  return <span className="commandSessionSummaryLoading" role="status" aria-label={`Loading metrics for ${session.title}`} title="Loading session metrics">
    <span className="commandSessionSummarySpinner" aria-hidden="true" />
  </span>;
}

function sessionColumns(providers: ProviderServiceStatus[]): CommandTableColumn<SessionSummary>[] { return [
  {
    id: "session", label: "Session", colClassName: "commandSessionColSession",
    renderCell: (session) => <><Link href={sessionHref(session)} className="commandTablePrimary"><strong>{session.title}</strong></Link><div className="commandSessionMetadata"><span>{session.project} · <ProviderBadge source={session.source} variant="text" /></span><SessionProviderWarning session={session} providers={providers} /></div><SessionCurrentActivity session={session} compact /></>,
  },
  {
    id: "state", label: "State", cellLabel: "State", colClassName: "commandSessionColState",
    renderCell: (session) => { const state = sessionState(session); return <span className="commandSessionState"><CommandStatus state={state.state}>{state.label}</CommandStatus><SessionSummaryLoading session={session} /></span>; },
  },
  {
    id: "activity", label: "Last activity", className: "commandTableActivityColumn", colClassName: "commandSessionColActivity",
    renderCell: (session) => <SessionCurrentActivity session={session} />,
  },
  {
    id: "agents", label: "Agents", cellLabel: "Agents", className: "commandTableAgents", colClassName: "commandSessionColAgents",
    sortValue: (session) => session.agentCount, sortLabel: "total agents",
    renderCell: (session) => session.agentCount === null ? <span title="Agent count is unavailable">—</span> : <span title={session.activeAgentCount === null ? "Active agent count is unavailable" : "Active / total agents"}>{session.activeAgentCount === null ? session.agentCount : session.activeAgentCount + "/" + session.agentCount}</span>,
  },
  {
    id: "context", label: "Context", cellLabel: "Context", colClassName: "commandSessionColContext",
    sortValue: (session) => session.latestContextTotal,
    renderCell: (session) => session.latestContextTotal === null ? <span title="Context is unavailable">—</span> : Math.round(session.latestContextTotal / 1000) + "k",
  },
  {
    id: "progress", label: "Progress", cellLabel: "Progress", colClassName: "commandSessionColProgress",
    sortValue: (session) => session.progress?.percent,
    renderCell: (session) => <span className="commandTableProgress" title={session.progress ? "Agent-reported session progress" : "Agent-reported session progress is unavailable"}>{session.progress ? Math.round(session.progress.percent) + "%" : "—"}</span>,
  },
  {
    id: "updated", label: "Updated", cellLabel: "Updated", className: "commandTableUpdated", colClassName: "commandSessionColUpdated",
    sortValue: (session) => Date.parse(session.updatedAt),
    renderCell: (session) => <>{sessionTimestamp(session.updatedAt)}<SessionCacheTiming session={session} /></>,
  },
  {
    id: "open", label: "Open session", hideLabel: true, colClassName: "commandSessionColAction",
    renderCell: (session) => <Link className="commandIconLink" href={sessionHref(session)} aria-label={"Open " + session.title}><CommandIcon name="arrow" size="small" /></Link>,
  },
]; }

function SessionProviderWarning({ session, providers }: { session: SessionSummary; providers: ProviderServiceStatus[] }) {
  const status = providerStatusFor(providers, session.provider);
  if (!session.isLive || !providerHasServiceIssue(status)) return null;
  return <ProviderStatusDetails status={status} compact chip />;
}

export function SessionsView({ initialProject = "", initialRepositoryId }: { initialProject?: string; initialRepositoryId?: string } = {}) {
  const [project, setProject] = useState(initialProject);
  const { providers } = useProviderStatus();
  const columns = useMemo(() => sessionColumns(providers), [providers]);
  const { sessions: committedSessions, connected, paused, readiness } = useSessionCatalog();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "live" | "needs">("all");
  const [sort, setSort] = useState<"newest" | "oldest" | "title">("newest");
  const [directory, setDirectory] = useState<SessionDirectorySnapshot | null>(null);
  const [directoryQueryKey, setDirectoryQueryKey] = useState<string | null>(null);
  const [directoryUnavailable, setDirectoryUnavailable] = useState(false);
  const [fulfilledRequestKey, setFulfilledRequestKey] = useState<string | null>(null);
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorPageBase, setCursorPageBase] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestRef = useRef(0);
  const revisionRef = useRef<string | number | null>(null);
  const directoryQuery = useMemo(() => {
    const params = new URLSearchParams({ mode: "directory", filter, sort, pageSize: String(SESSION_PAGE_SIZE) });
    if (query.trim()) params.set("query", query.trim());
    if (project) params.set("project", project);
    if (initialRepositoryId) params.set("repositoryId", initialRepositoryId);
    return params.toString();
  }, [filter, initialRepositoryId, project, query, sort]);
  const resetDirectory = () => { setCursor(null); setCursorTrail([]); setCursorPageBase(0); };
  const updateQuery = (value: string) => { setQuery(value); resetDirectory(); };
  const updateFilter = (value: typeof filter) => { setFilter(value); resetDirectory(); };

  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    const request = ++requestRef.current;
    const params = new URLSearchParams(directoryQuery);
    if (cursor) params.set("cursor", cursor);
    if (cursor && revisionRef.current !== null) params.set("revision", String(revisionRef.current));
    const requestKey = `${directoryQuery}\u0000${cursor || ""}\u0000${refreshNonce}`;
    void fetch(`/api/sessions?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session directory unavailable");
        return response.json() as Promise<SessionDirectorySnapshot>;
      })
      .then((next) => {
        if (controller.signal.aborted || request !== requestRef.current || !Array.isArray(next.sessions) || !next.coverage) return;
        revisionRef.current = next.revision;
        setDirectory(next);
        setDirectoryQueryKey(directoryQuery);
        setFulfilledRequestKey(requestKey);
        setDirectoryUnavailable(false);
        if (next.cursorReset) { setCursor(null); setCursorTrail([]); setCursorPageBase(0); }
      })
      .catch(() => { if (!controller.signal.aborted && request === requestRef.current) setDirectoryUnavailable(true); });
    return () => controller.abort();
  }, [cursor, directoryQuery, paused, refreshNonce]);

  useEffect(() => {
    if (paused) return;
    let timer: number | null = null;
    const refresh = () => setRefreshNonce((value) => value + 1);
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { refresh(); schedule(); }, document.hidden ? 60_000 : 30_000);
    };
    const visibility = () => { if (!document.hidden) refresh(); };
    const unsubscribe = subscribeLiveEvents((event) => { if (event.type === "revision" && event.domain === "sessions") refresh(); });
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => { unsubscribe(); document.removeEventListener("visibilitychange", visibility); if (timer !== null) window.clearTimeout(timer); };
  }, [directoryQuery, paused]);

  const directoryMatchesQuery = directoryQueryKey === directoryQuery;
  const activeRequestKey = `${directoryQuery}\u0000${cursor || ""}\u0000${refreshNonce}`;
  const directoryLoading = !paused && fulfilledRequestKey !== activeRequestKey;
  const committedSessionsById = useMemo(() => new Map(committedSessions.map((session) => [session.id, session])), [committedSessions]);
  const pageRows = useMemo(() => {
    if (!directoryMatchesQuery) return [];
    return (directory?.sessions || []).map((session) => {
      const committed = committedSessionsById.get(session.id);
      return committed ? { ...session, ...committed } : session;
    });
  }, [committedSessionsById, directory?.sessions, directoryMatchesQuery]);
  const coverage = directoryMatchesQuery ? directory?.coverage : undefined;
  const counts = directoryMatchesQuery ? directory?.counts : undefined;
  const matchedCount = directoryMatchesQuery ? directory?.matchedCount : null;
  const liveSessionCount = counts?.live;
  const needsInputCount = counts?.needs;
  const catalogUnavailable = readiness.catalog === "unavailable" || !connected;
  const catalogLoading = !directoryMatchesQuery && !catalogUnavailable && !directoryUnavailable && !paused;
  const providerSettingsAvailable = useProviderSettingsAvailable();
  return <CommandPage title="Sessions" description="Live and historical coding-agent sessions, organized for fast triage without exposing conversation content." busy={catalogLoading}>
    <div className="commandSessionsDirectory">
      <div className="commandSessionsToolbar"><CommandToolbar label="Filter sessions">
        <CommandSearch value={query} onChange={updateQuery} placeholder="Filter sessions" label="Filter sessions" />
        <div className="commandSessionFilters" role="group" aria-label="Session scope">
          {project && <button className="commandFilterChip active" type="button" aria-label={`Clear project filter: ${project}`} onClick={() => { setProject(""); resetDirectory(); }}>Project: {project}<CommandIcon name="close" size="small" /></button>}
          <CommandFilter active={filter === "all"} onClick={() => updateFilter("all")} count={counts?.all}>All</CommandFilter>
          <CommandFilter active={filter === "live"} onClick={() => updateFilter("live")} count={catalogLoading ? undefined : liveSessionCount}>Live</CommandFilter>
          <CommandFilter active={filter === "needs"} onClick={() => updateFilter("needs")} count={catalogLoading ? undefined : needsInputCount}>Needs input</CommandFilter>
        </div>
        <CommandSelect aria-label="Sort sessions" value={sort} onChange={(event) => { setSort(event.currentTarget.value as typeof sort); resetDirectory(); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title</option></CommandSelect>
        {matchedCount !== null && <span className="commandToolbarCount" aria-live="polite">{matchedCount} matches</span>}
      </CommandToolbar></div>
      {coverage && <SessionDirectoryCoverage coverage={coverage} />}
      <CommandTable
        caption="Observed Pomegr sessions"
        rows={pageRows}
        columns={columns.map((column) => ({ ...column, sortValue: undefined }))}
        getRowKey={(session) => session.id}
        className="commandSessionTable"
        emptyState={catalogLoading ? <div className="commandSessionsSkeleton" role="status" aria-label="Loading sessions">
          <p>Loading sessions</p>
          <div aria-hidden="true">{[0, 1, 2].map((row) => <div className="commandSessionsSkeletonRow" key={row}>
            <span className="uiSkeleton commandSessionsSkeletonTitle" />
            <span className="uiSkeleton commandSessionsSkeletonDetail" />
            <span className="uiSkeleton commandSessionsSkeletonMeta" />
          </div>)}</div>
        </div> : (catalogUnavailable || directoryUnavailable || paused) && !pageRows.length ? <CommandEmpty title="Session catalog unavailable" detail={paused ? "Pomegr is paused. Resume it to refresh the session directory." : "Pomegr will retry the local monitor automatically."} icon="sessions" /> : <CommandEmpty title={matchedCount ? "No sessions match" : "No sessions observed"} detail={matchedCount ? "Try a different search or filter." : "Observed sessions will appear here when the local monitor is ready."} icon="sessions" />}
      />
      {directoryMatchesQuery && directory && <nav className="commandPagination" aria-label="Session pages"><span className="commandPaginationSummary">Showing up to {directory.pageSize} of {matchedCount}</span><div className="commandPaginationControls"><button className="commandSecondaryAction" type="button" disabled={!cursorTrail.length || directoryLoading} onClick={() => { const previous = cursorTrail.at(-1) || null; setCursorTrail((trail) => trail.slice(0, -1)); setCursor(previous); }}>Previous</button><button className="commandSecondaryAction" type="button" disabled={!directory.nextCursor || directoryLoading} onClick={() => { if (!directory.nextCursor) return; setCursorTrail((trail) => { const next = [...trail, cursor || ""]; if (next.length <= 100) return next; setCursorPageBase((page) => page + 1); return next.slice(1); }); setCursor(directory.nextCursor); }}>Next</button></div><span className="commandPaginationPageStatus" aria-live="polite">Page {cursorPageBase + cursorTrail.length + 1}</span></nav>}
      {!pageRows.length && !catalogLoading && providerSettingsAvailable && <p className="commandUnavailableNote">Need a different local source? <Link className="commandTextLink" href="/settings?section=providers">Configure session sources</Link></p>}
      {(catalogUnavailable || directoryUnavailable) && pageRows.length > 0 && <p className="commandUnavailableNote">The local monitor is reconnecting. Showing the last known session catalog.</p>}
    </div>
  </CommandPage>;
}

function SessionDirectoryCoverage({ coverage }: { coverage: SessionCatalogCoverage }) {
  if (coverage.status === "complete" && coverage.exactTotal !== null) return <p className="commandUnavailableNote" role="status">{coverage.exactTotal} sessions in the complete catalog.{coverage.observedAt ? ` Observed ${sessionListTime(coverage.observedAt)}.` : ""}</p>;
  const previous = coverage.lastCompletedTotal === null ? null : `${coverage.lastCompletedTotal} completed ${coverage.lastCompletedAt ? sessionListTime(coverage.lastCompletedAt) : "previously"}`;
  return <p className="commandUnavailableNote" role="status">{coverage.knownCount} known sessions while discovery is {coverage.status}.{previous ? ` Last complete catalog: ${previous}.` : " The total is not yet exact."}</p>;
}

function usageResetLabel(value: string | null) {
  if (!value) return "Reset time unavailable";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Reset time unavailable";
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (minutes > 0 && minutes < 60) return `Resets in ${minutes}m`;
  if (minutes >= 60 && minutes < 24 * 60) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Resets ${sessionListTime(value)}`;
}

function UsageProvider({ entry, providerStatus }: { entry: HomeProviderUsageLimits; providerStatus: ReturnType<typeof providerStatusFor> }) {
  const limits = entry.usageLimits;
  const status = entry.readiness || (limits.available ? "ready" : "unavailable");
  const failureKind = usageLimitFailureKind(limits);
  const displayedLimits = usageLimitDisplay(limits);
  const statusLabel = failureKind === "authentication_required"
    ? "Usage access interrupted"
    : failureKind === "rate_limited"
      ? "Refresh rate-limited"
      : limits.available && failureKind
        ? "Refresh delayed"
        : status === "ready" && limits.fetchedAt
          ? `${limits.origin === "local_observation" ? "Last observed" : "Updated"} ${relativeTime(limits.fetchedAt)}`
          : status === "loading" ? "Connecting…" : "Unavailable";
  return <section className="commandUsageProvider" aria-labelledby={`usage-${entry.provider}`}>
    <header className="commandUsageProviderHead"><div className="commandUsageProviderIdentity"><h2 id={`usage-${entry.provider}`}><ProviderBadge source={entry.source} variant="text" /></h2><ProviderStatusDetails status={providerStatus} compact dotOnly /></div><span>{statusLabel}{failureKind && limits.fetchedAt && <> · {limits.origin === "local_observation" ? "Last observed" : "Updated"} {relativeTime(limits.fetchedAt)}</>}</span></header>
    {status === "loading" ? <CommandEmpty title="Waiting for provider usage" detail="The monitor is preparing the latest account-level window." icon="timer" /> : status !== "ready" || !limits.available ? <div className="commandUsageUnavailable"><CommandIcon name="limits" size="small" /><p>{failureKind ? usageLimitFailureMessage(entry.source, limits) : `Usage limits for ${entry.source} are unavailable.`}{limits.retryAt && <><br /><RetryCountdownText value={limits.retryAt} />.</>}</p></div> : displayedLimits.current.length || displayedLimits.localFable ? <><div className="commandUsageRows">{displayedLimits.current.map((limit) => <article className={`commandUsageWindow ${limit.severity}`} key={limit.id}>
      <header><strong>{limit.label}</strong><b>{Math.round(limit.percent)}%</b></header><div className="commandUsageTrack"><i style={{ width: `${Math.max(0, Math.min(100, limit.percent))}%` }} /></div><footer><span>{usageResetLabel(limit.resetsAt)}</span><span>Provider-reported window</span></footer>
    </article>)}{displayedLimits.localFable?.kind === "retained" && <article className={`commandUsageWindow ${displayedLimits.localFable.limit.severity}`} key="retained-model-fable"><header><strong>{displayedLimits.localFable.limit.label}</strong><b>{Math.round(displayedLimits.localFable.limit.percent)}%</b></header><div className="commandUsageTrack"><i style={{ width: `${Math.max(0, Math.min(100, displayedLimits.localFable.limit.percent))}%` }} /></div><footer><span>{usageResetLabel(displayedLimits.localFable.limit.resetsAt)}</span><span>Last API value {relativeTime(displayedLimits.localFable.fetchedAt)}</span></footer></article>}{displayedLimits.localFable?.kind === "unavailable" && <article className="commandUsageWindow" key="unavailable-model-fable"><header><strong>Fable</strong><span className="commandUsageStatus">{displayedLimits.localFable.label}</span></header><footer><span>{displayedLimits.localFable.detail}</span></footer></article>}</div>{failureKind && <p className="commandUsageRefreshNote" role="status">{usageLimitFailureMessage(entry.source, limits)}{limits.retryAt && <> <RetryCountdownText value={limits.retryAt} />.</>}</p>}</> : <div className="commandUsageUnavailable"><p>No provider windows were reported.</p></div>}
    {entry.provider === "claude" && <ClaudeUsageControls usageLimits={limits} showObservationNote={false} />}
    {entry.provider === "codex" && <CodexUsageHelp usageLimits={limits} />}
  </section>;
}

export function UsageLimitsView() {
  const [dismissedIncidents, setDismissedIncidents] = useState<Partial<Record<ProviderServiceStatus["provider"], ProviderIncidentDismissal>>>({});
  const snapshot = useUsageLimits();
  const statusSnapshot = useProviderStatus();
  const providersUnavailable = snapshot.providers.length === 0 && Object.values(snapshot.readiness).every((status) => status === "unavailable");
  return <CommandPage title="Usage limits" description="Provider-reported account usage and health check.">
    {statusSnapshot.providers.filter((provider) => providerServiceNoticeVisible(provider, false, dismissedIncidents[provider.provider] ?? null)).map((provider) => <ProviderServiceNotice
      key={provider.provider}
      status={provider}
      onDismiss={() => setDismissedIncidents((current) => ({ ...current, [provider.provider]: { key: provider.incidentKey || provider.status, rank: providerIncidentRank(provider) } }))}
    />)}
    {snapshot.providers.length ? snapshot.providers.map((entry) => <UsageProvider entry={entry} providerStatus={providerStatusFor(statusSnapshot.providers, entry.provider)} key={entry.provider} />) : <><ProviderStatusArea providers={statusSnapshot.providers} /><CommandEmpty title={providersUnavailable ? "Usage limits unavailable" : "Usage limits are loading"} detail={providersUnavailable ? "The local monitor could not provide account-level provider evidence." : "Pomegr is waiting for account-level provider evidence."} icon="limits" /></>}
    <p className="commandUsageCaution">Provider-reported account usage reflects the last observation and may lag current activity. Pomegr does not attribute usage or cost to sessions, agents, or repositories. Local request observations show correlation only.</p>
  </CommandPage>;
}
