"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { AgentCurrentActivity, HomeProviderUsageLimits, SessionSummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { groupSessionsByProject, newestSessionsFirst, relativeTime, sessionListTime } from "../../dashboard-utils";
import { useSessionCatalog } from "../../hooks/SessionCatalogContext";
import { useUsageLimits } from "../../usage-limits-client";
import { ProviderBadge } from "../ProviderBadge";
import { CommandComingSoon, CommandEmpty, CommandFilter, CommandIcon, CommandMetric, CommandPage, CommandSearch, CommandStatus, CommandToolbar } from "./CommandPage";

function sessionHref(session: SessionSummary) {
  try { return `/sessions/${encodeSessionRoute(session.id)}`; } catch { return "/"; }
}

function sessionState(session: SessionSummary) {
  if (session.needsInput || session.activityStatus === "needs_input") return { label: "Needs input", state: "attention" as const };
  if (session.activityStatus === "working") return { label: "Active", state: "active" as const };
  if (session.activityStatus === "idle") return { label: "Idle", state: "idle" as const };
  return { label: session.isLive ? "Open" : "Complete", state: "unknown" as const };
}

function sessionTimestamp(value: string) {
  return <time dateTime={value} title={sessionListTime(value)}>{relativeTime(value)}</time>;
}

function SessionCurrentActivity({ activity, compact = false }: { activity: AgentCurrentActivity | null | undefined; compact?: boolean }) {
  if (!activity) {
    return compact ? null : <span className="commandTableActivityUnavailable" title="Current provider-reported activity is unavailable">—</span>;
  }
  const provenance = `Provider-reported · observed ${relativeTime(activity.observedAt)}`;
  return <span className={`commandTableActivity${compact ? " commandTableActivityCompact" : ""}`} title={`${activity.label} · ${provenance}`} aria-label={`Current activity: ${activity.label}. ${provenance}.`}><span className="commandTableActivityMark" aria-hidden="true" /><span className="commandTableActivityLabel">{activity.label}</span></span>;
}

const builtInDashboards = [
  { title: "Workspace overview", detail: "Cross-project operating picture", scope: "All sessions", href: "/" },
  { title: "Agent operations", detail: "Session-level agent counts and execution state", scope: "Live sessions", href: "/agents" },
  { title: "Usage & cache evidence", detail: "Provider windows and request observations", scope: "Account", href: "/usage-limits" },
  { title: "Repository activity", detail: "Projects associated with observed sessions", scope: "Projects", href: "/repositories" },
];

const SESSION_PAGE_SIZE = 10;

export function DashboardsView() {
  const [query, setQuery] = useState("");
  const visible = builtInDashboards.filter((dashboard) => {
    return `${dashboard.title} ${dashboard.detail} ${dashboard.scope}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  return <CommandPage title="Dashboards" description="Purpose-built views for workspace health, live execution, usage evidence, and repository change." action={<button className="commandPrimaryAction" type="button" disabled aria-disabled="true"><CommandIcon name="spark" size="small" />Create dashboard</button>}>
    <CommandToolbar>
      <CommandSearch value={query} onChange={setQuery} placeholder="Find a dashboard" label="Find a dashboard" />
      <span className="commandToolbarCount">{visible.length} dashboards</span>
    </CommandToolbar>
    <div className="commandDashboardDirectory">
      <section className="commandDashboardRows" aria-label="Built-in dashboards">
        <div className="commandDirectoryHead"><span>Dashboard</span><span>Scope</span><span>Updated</span></div>
        {visible.map((dashboard) => <Link className="commandDashboardRow" href={dashboard.href} key={dashboard.title}>
          <span><strong>{dashboard.title}</strong><small>{dashboard.detail}</small></span><span>{dashboard.scope}</span><time>Live data</time><CommandIcon name="arrow" size="small" />
        </Link>)}
        {!visible.length && <CommandEmpty title="No dashboards match" detail="Try a different dashboard name or filter." icon="dashboard" />}
      </section>
      <aside className="commandDashboardPreview"><h2>Workspace overview</h2><p>The default landing view uses normalized session and account evidence from the monitor.</p><Link className="commandSecondaryAction" href="/">Open workspace <CommandIcon name="arrow" size="small" /></Link></aside>
    </div>
    <p className="commandUnavailableNote">Custom dashboard composition is not available yet. The built-in views above remain read-only and provider-neutral.</p>
  </CommandPage>;
}

export function SessionsView() {
  const { sessions, liveSessions, loading, connected, readiness } = useSessionCatalog();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "live" | "needs" | "history">("all");
  const [page, setPage] = useState(1);
  const liveById = useMemo(() => new Map(liveSessions.map((session) => [session.id, session])), [liveSessions]);
  const filteredSessions = useMemo(() => newestSessionsFirst(sessions.filter((session) => {
    const haystack = `${session.title} ${session.project} ${session.source}`.toLowerCase();
    if (query.trim() && !haystack.includes(query.trim().toLowerCase())) return false;
    if (filter === "live" && !session.isLive) return false;
    if (filter === "history" && session.isLive) return false;
    if (filter === "needs" && !(session.needsInput || session.activityStatus === "needs_input")) return false;
    return true;
  })), [filter, query, sessions]);
  const pageCount = Math.max(1, Math.ceil(filteredSessions.length / SESSION_PAGE_SIZE));
  const activePage = Math.min(page, pageCount);
  const firstVisibleIndex = (activePage - 1) * SESSION_PAGE_SIZE;
  const visibleSessions = filteredSessions.slice(firstVisibleIndex, firstVisibleIndex + SESSION_PAGE_SIZE);
  const updateQuery = (value: string) => { setQuery(value); setPage(1); };
  const updateFilter = (value: typeof filter) => { setFilter(value); setPage(1); };
  const needsInputCount = sessions.filter((session) => session.needsInput || session.activityStatus === "needs_input").length;
  const catalogUnavailable = readiness.catalog === "unavailable" || !connected;
  return <CommandPage title="Sessions" description="Live and historical coding-agent sessions, organized for fast triage without exposing conversation content." busy={loading && !sessions.length}>
    <div className="commandSessionsDirectory">
      <CommandToolbar>
        <CommandSearch value={query} onChange={updateQuery} placeholder="Filter sessions" label="Filter sessions" />
        <CommandFilter active={filter === "all"} onClick={() => updateFilter("all")} count={sessions.length}>All</CommandFilter>
        <CommandFilter active={filter === "live"} onClick={() => updateFilter("live")} count={liveSessions.length}>Live</CommandFilter>
        <CommandFilter active={filter === "needs"} onClick={() => updateFilter("needs")} count={needsInputCount}>Needs input</CommandFilter>
        <CommandFilter active={filter === "history"} onClick={() => updateFilter("history")} count={sessions.length - liveSessions.length}>History</CommandFilter>
        <span className="commandToolbarCount">{filteredSessions.length} matches</span>
      </CommandToolbar>
      {catalogUnavailable && !sessions.length ? <CommandEmpty title="Session catalog unavailable" detail="Pomegr will retry the local monitor automatically." icon="sessions" /> : !filteredSessions.length ? <CommandEmpty title={sessions.length ? "No sessions match" : "No sessions observed"} detail={sessions.length ? "Try a different search or filter." : "Observed sessions will appear here when the local monitor is ready."} icon="sessions" /> : <div className="commandSessionTableWrap">
        <table className="commandTable"><caption className="commandVisuallyHidden">Observed Pomegr sessions</caption><colgroup><col className="commandSessionColSession" /><col className="commandSessionColState" /><col className="commandSessionColActivity" /><col className="commandSessionColAgents" /><col className="commandSessionColContext" /><col className="commandSessionColProgress" /><col className="commandSessionColUpdated" /><col className="commandSessionColAction" /></colgroup><thead><tr><th>Session</th><th>State</th><th className="commandTableActivityColumn">Current activity</th><th className="commandTableAgents">Agents</th><th>Context</th><th>Progress</th><th className="commandTableUpdated">Updated</th><th aria-label="Open session" /></tr></thead>
          <tbody>{visibleSessions.map((session) => { const detail = liveById.get(session.id); const state = sessionState(session); return <tr key={session.id}>
            <td><Link href={sessionHref(session)} className="commandTablePrimary"><strong>{session.title}</strong><small>{session.project} · <ProviderBadge source={session.source} compact /></small><SessionCurrentActivity activity={detail?.currentActivity} compact /></Link></td>
            <td data-label="State"><CommandStatus state={state.state}>{state.label}</CommandStatus></td>
            <td className="commandTableActivityColumn"><SessionCurrentActivity activity={detail?.currentActivity} /></td>
            <td className="commandTableAgents" data-label="Agents">{detail?.agentCount ?? <span title="Agent count is only available in live session evidence">—</span>}</td>
            <td data-label="Context">{detail?.latestContextTotal === null || detail?.latestContextTotal === undefined ? <span title="Context is only available in live session evidence">—</span> : `${Math.round(detail.latestContextTotal / 1000)}k`}</td>
            <td data-label="Progress"><span className="commandTableProgress" title={detail?.progress ? "Agent-reported session progress" : "Agent-reported session progress is unavailable"}>{detail?.progress ? `${Math.round(detail.progress.percent)}%` : "—"}</span></td>
            <td className="commandTableUpdated" data-label="Updated">{sessionTimestamp(session.updatedAt)}</td>
            <td><Link className="commandIconLink" href={sessionHref(session)} aria-label={`Open ${session.title}`}><CommandIcon name="arrow" size="small" /></Link></td>
          </tr>; })}</tbody>
        </table>
      </div>}
      {filteredSessions.length > SESSION_PAGE_SIZE && <nav className="commandPagination" aria-label="Session pages">
        <span className="commandPaginationSummary">Showing {firstVisibleIndex + 1}–{Math.min(firstVisibleIndex + SESSION_PAGE_SIZE, filteredSessions.length)} of {filteredSessions.length}</span>
        <div className="commandPaginationControls">
          <button type="button" onClick={() => setPage(activePage - 1)} disabled={activePage === 1}>Previous</button>
          <span className="commandPaginationPageStatus" aria-live="polite">Page {activePage} of {pageCount}</span>
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => <button type="button" className="commandPaginationPage" aria-label={`Go to page ${pageNumber}`} aria-current={pageNumber === activePage ? "page" : undefined} onClick={() => setPage(pageNumber)} key={pageNumber}>{pageNumber}</button>)}
          <button type="button" onClick={() => setPage(activePage + 1)} disabled={activePage === pageCount}>Next</button>
        </div>
      </nav>}
      {catalogUnavailable && sessions.length > 0 && <p className="commandUnavailableNote">The local monitor is reconnecting. Showing the last known session catalog.</p>}
    </div>
  </CommandPage>;
}

export function AgentsView() {
  const { sessions, liveSessions, loading, connected } = useSessionCatalog();
  const knownAgentCount = liveSessions.reduce((total, session) => total + (session.agentCount || 0), 0);
  const knownActiveAgentCount = liveSessions.reduce((total, session) => total + (session.activeAgentCount || 0), 0);
  const sessionsWithCounts = liveSessions.filter((session) => session.agentCount !== null).length;
  return <CommandPage title="Agents" description="A normalized agent roster is planned; the current monitor exposes agent evidence only inside individual session views." busy={loading && !sessions.length} action={<button className="commandSecondaryAction" type="button" disabled aria-disabled="true">View topology</button>}>
    <div className="commandMetricsRow"><CommandMetric label="Visible sessions" value={String(liveSessions.length)} detail="Live catalog" /><CommandMetric label="Known agents" value={sessionsWithCounts ? String(knownAgentCount) : "—"} detail={sessionsWithCounts ? "Across live sessions" : "Evidence unavailable"} /><CommandMetric label="Active agents" value={sessionsWithCounts ? String(knownActiveAgentCount) : "—"} detail="Session-level evidence" /></div>
    <CommandComingSoon title="Global agent detail is not available yet" detail="Pomegr will add a global roster with normalized role, status, context, and parent-session provenance when that evidence can be served safely. No individual agents are inferred here." icon="agents" />
    {!connected && <p className="commandUnavailableNote">The local monitor is reconnecting; aggregate counts may be stale.</p>}
  </CommandPage>;
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

function UsageProvider({ entry }: { entry: HomeProviderUsageLimits }) {
  const limits = entry.usageLimits;
  const status = entry.readiness || (limits.available ? "ready" : "unavailable");
  return <section className="commandUsageProvider" aria-labelledby={`usage-${entry.provider}`}>
    <header className="commandUsageProviderHead"><h2 id={`usage-${entry.provider}`}><ProviderBadge source={entry.source} /></h2><span>{status === "ready" && limits.fetchedAt ? `Updated ${relativeTime(limits.fetchedAt)}` : status === "loading" ? "Connecting…" : "Unavailable"}</span></header>
    {status === "loading" ? <CommandEmpty title="Waiting for provider usage" detail="The monitor is preparing the latest account-level window." icon="timer" /> : status !== "ready" || !limits.available ? <div className="commandUsageUnavailable"><CommandIcon name="limits" size="small" /><p>{limits.error || `Usage limits for ${entry.source} are unavailable.`}</p></div> : limits.limits.length ? <div className="commandUsageRows">{limits.limits.map((limit) => <article className={`commandUsageWindow ${limit.severity}`} key={limit.id}>
      <header><strong>{limit.label}</strong><b>{Math.round(limit.percent)}%</b></header><div className="commandUsageTrack"><i style={{ width: `${Math.max(0, Math.min(100, limit.percent))}%` }} /></div><footer><span>{usageResetLabel(limit.resetsAt)}</span><span>Provider-reported window</span></footer>
    </article>)}</div> : <div className="commandUsageUnavailable"><p>No provider windows were reported.</p></div>}
  </section>;
}

export function UsageLimitsView() {
  const snapshot = useUsageLimits();
  const providersUnavailable = snapshot.providers.length === 0 && Object.values(snapshot.readiness).every((status) => status === "unavailable");
  return <CommandPage title="Usage limits" description="Provider-reported account windows with local request evidence shown only for correlation—not attribution or billing." action={<button className="commandSecondaryAction" type="button" disabled aria-disabled="true">Refresh limits</button>}>
    {snapshot.providers.length ? snapshot.providers.map((entry) => <UsageProvider entry={entry} key={entry.provider} />) : <CommandEmpty title={providersUnavailable ? "Usage limits unavailable" : "Usage limits are loading"} detail={providersUnavailable ? "The local monitor could not provide account-level provider evidence." : "Pomegr is waiting for account-level provider evidence."} icon="limits" />}
    <p className="commandUsageCaution">Usage is account-level. Pomegr does not assign provider usage or cost to individual sessions, agents, or repositories. Local request observations, when available, describe correlation only.</p>
  </CommandPage>;
}

export function RepositoriesView() {
  const { sessions, loading, connected, readiness } = useSessionCatalog();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupSessionsByProject(sessions).filter(({ project }) => project.toLowerCase().includes(query.trim().toLowerCase())), [query, sessions]);
  const catalogUnavailable = readiness.catalog === "unavailable" || !connected;
  return <CommandPage title="Repositories" description="Projects associated with observed sessions. Detailed Git state remains a planned surface." busy={loading && !sessions.length}>
    <CommandToolbar>
      <CommandSearch value={query} onChange={setQuery} placeholder="Filter projects" label="Filter projects" />
      <span className="commandToolbarCount">{groups.length} projects · Session catalog</span>
    </CommandToolbar>
    {catalogUnavailable && !sessions.length ? <CommandEmpty title="Project catalog unavailable" detail="Pomegr will retry the local monitor automatically." icon="repositories" /> : !groups.length ? <CommandEmpty title={sessions.length ? "No projects match" : "No repositories observed"} detail={sessions.length ? "Try a different project name." : "Projects appear here when sessions are observed."} icon="repositories" /> : <div className="commandRepositoryList">{groups.map(({ project, sessions: projectSessions }) => {
      const liveCount = projectSessions.filter((session) => session.isLive).length;
      const latest = projectSessions.reduce((value, session) => value > session.updatedAt ? value : session.updatedAt, "");
      return <article className="commandRepositoryRow" key={project}><div className="commandRepositoryIdentity"><CommandIcon name="repositories" size="small" /><span><strong>{project}</strong><small>{projectSessions.length} observed session{projectSessions.length === 1 ? "" : "s"}</small></span></div><span className="commandRepositoryStat"><strong>{liveCount}</strong> live</span><span className="commandRepositoryStat"><strong>{projectSessions.length - liveCount}</strong> history</span><span className="commandRepositoryUpdated">{latest ? sessionTimestamp(latest) : "—"}</span><span className="commandRepositoryUnavailable">Git details coming soon</span></article>;
    })}</div>}
    <CommandComingSoon title="Detailed repository evidence is coming soon" detail="Branch, working-tree, commit, and pull-request aggregation will be added when the monitor can provide a bounded repository summary. Current rows reflect session associations only." icon="git" />
  </CommandPage>;
}
