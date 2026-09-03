"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HomeProviderUsageLimits, ProviderServiceStatus, SessionSummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { groupSessionsByProject, newestSessionsFirst, relativeTime, sessionListTime, sessionState } from "../../dashboard-utils";
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
import { CommandComingSoon, CommandEmpty, CommandFilter, CommandIcon, CommandPage, CommandSearch, CommandStatus, CommandToolbar } from "./CommandPage";
export { AgentsView } from "../agents/AgentsView";

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

const builtInDashboards = [
  { title: "Session overview", detail: "Live and historical work across projects", scope: "All sessions", href: "/sessions" },
  { title: "Agent operations", detail: "Session-level agent counts and execution state", scope: "Live sessions", href: "/agents" },
  { title: "Usage & cache evidence", detail: "Provider windows and request observations", scope: "Account", href: "/usage-limits" },
  { title: "Repository activity", detail: "Projects associated with observed sessions", scope: "Projects", href: "/repositories" },
];

const DASHBOARD_COLUMNS: CommandTableColumn<(typeof builtInDashboards)[number]>[] = [
  {
    id: "dashboard", label: "Dashboard",
    renderCell: (dashboard) => <Link className="commandTablePrimary" href={dashboard.href}><strong>{dashboard.title}</strong><small>{dashboard.detail}</small></Link>,
  },
  {
    id: "scope", label: "Scope", colClassName: "commandDashboardColScope",
    renderCell: (dashboard) => dashboard.scope,
  },
  {
    id: "updated", label: "Updated", className: "commandDashboardUpdated", colClassName: "commandDashboardColUpdated",
    renderCell: () => "Live data",
  },
  {
    id: "open", label: "Open dashboard", hideLabel: true, colClassName: "commandDashboardColAction",
    renderCell: (dashboard) => <Link className="commandIconLink" href={dashboard.href} aria-label={"Open " + dashboard.title}><CommandIcon name="arrow" size="small" /></Link>,
  },
];

const SESSION_PAGE_SIZE = 10;
function sessionColumns(providers: ProviderServiceStatus[]): CommandTableColumn<SessionSummary>[] { return [
  {
    id: "session", label: "Session", colClassName: "commandSessionColSession",
    renderCell: (session) => <><Link href={sessionHref(session)} className="commandTablePrimary"><strong>{session.title}</strong></Link><div className="commandSessionMetadata"><span>{session.project} · <ProviderBadge source={session.source} compact /></span><SessionProviderWarning session={session} providers={providers} /></div><SessionCurrentActivity session={session} compact /></>,
  },
  {
    id: "state", label: "State", cellLabel: "State", colClassName: "commandSessionColState",
    renderCell: (session) => { const state = sessionState(session); return <CommandStatus state={state.state}>{state.label}</CommandStatus>; },
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
    renderCell: (session) => sessionTimestamp(session.updatedAt),
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
        <CommandTable
          caption="Built-in dashboards"
          rows={visible}
          columns={DASHBOARD_COLUMNS}
          getRowKey={(dashboard) => dashboard.href}
          className="commandDashboardTable"
          emptyState={<CommandEmpty title="No dashboards match" detail="Try a different dashboard name or filter." icon="dashboard" />}
        />
      </section>
      <aside className="commandDashboardPreview"><h2>Session overview</h2><p>Find live and historical work across your projects, with filters for sessions that need input.</p><Link className="commandSecondaryAction" href="/sessions">Open sessions <CommandIcon name="arrow" size="small" /></Link></aside>
    </div>
    <p className="commandUnavailableNote">Custom dashboard composition is not available yet. The built-in views above remain read-only and provider-neutral.</p>
  </CommandPage>;
}

export function SessionsView({ initialProject = "" }: { initialProject?: string } = {}) {
  const [project, setProject] = useState(initialProject);
  const { providers } = useProviderStatus();
  const columns = useMemo(() => sessionColumns(providers), [providers]);
  const { sessions, loading, connected, readiness } = useSessionCatalog();
  const [query, setQuery] = useState("");
  const [selectedFilter, setFilter] = useState<"all" | "live" | "needs" | "history" | null>(null);
  const [page, setPage] = useState(1);
  const liveSessionCount = sessions.filter((session) => session.isLive).length;
  const filter = selectedFilter ?? (liveSessionCount > 0 ? "live" : "all");
  const filteredSessions = useMemo(() => newestSessionsFirst(sessions.filter((session) => {
    if (project && session.project !== project) return false;
    const haystack = `${session.title} ${session.project} ${session.source}`.toLowerCase();
    if (query.trim() && !haystack.includes(query.trim().toLowerCase())) return false;
    if (filter === "live" && !session.isLive) return false;
    if (filter === "history" && session.isLive) return false;
    if (filter === "needs" && !(session.needsInput || session.activityStatus === "needs_input")) return false;
    return true;
  })), [filter, project, query, sessions]);
  const updateQuery = (value: string) => { setQuery(value); setPage(1); };
  const updateFilter = (value: typeof filter) => { setFilter(value); setPage(1); };
  const needsInputCount = sessions.filter((session) => session.needsInput || session.activityStatus === "needs_input").length;
  const catalogUnavailable = readiness.catalog === "unavailable" || !connected;
  return <CommandPage title="Sessions" description="Live and historical coding-agent sessions, organized for fast triage without exposing conversation content." busy={loading && !sessions.length}>
    <div className="commandSessionsDirectory">
      <CommandToolbar>
        <CommandSearch value={query} onChange={updateQuery} placeholder="Filter sessions" label="Filter sessions" />
        {project && <button className="commandFilterChip active" type="button" aria-label={`Clear project filter: ${project}`} onClick={() => { setProject(""); setPage(1); }}>Project: {project}<CommandIcon name="close" size="small" /></button>}
        <CommandFilter active={filter === "all"} onClick={() => updateFilter("all")} count={sessions.length}>All</CommandFilter>
        <CommandFilter active={filter === "live"} onClick={() => updateFilter("live")} count={liveSessionCount}>Live</CommandFilter>
        <CommandFilter active={filter === "needs"} onClick={() => updateFilter("needs")} count={needsInputCount}>Needs input</CommandFilter>
        <CommandFilter active={filter === "history"} onClick={() => updateFilter("history")} count={sessions.length - liveSessionCount}>History</CommandFilter>
        <span className="commandToolbarCount">{filteredSessions.length} matches</span>
      </CommandToolbar>
      <CommandTable
        caption="Observed Pomegr sessions"
        rows={filteredSessions}
        columns={columns}
        getRowKey={(session) => session.id}
        className="commandSessionTable"
        pagination={{ page, pageSize: SESSION_PAGE_SIZE, onPageChange: setPage, label: "Session pages" }}
        emptyState={catalogUnavailable && !sessions.length ? <CommandEmpty title="Session catalog unavailable" detail="Pomegr will retry the local monitor automatically." icon="sessions" /> : <CommandEmpty title={sessions.length ? "No sessions match" : "No sessions observed"} detail={sessions.length ? "Try a different search or filter." : "Observed sessions will appear here when the local monitor is ready."} icon="sessions" />}
      />
      {catalogUnavailable && sessions.length > 0 && <p className="commandUnavailableNote">The local monitor is reconnecting. Showing the last known session catalog.</p>}
    </div>
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
    <header className="commandUsageProviderHead"><div className="commandUsageProviderIdentity"><h2 id={`usage-${entry.provider}`}><ProviderBadge source={entry.source} /></h2><ProviderStatusDetails status={providerStatus} compact dotOnly /></div><span>{statusLabel}{failureKind && limits.fetchedAt && <> · {limits.origin === "local_observation" ? "Last observed" : "Updated"} {relativeTime(limits.fetchedAt)}</>}</span></header>
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
