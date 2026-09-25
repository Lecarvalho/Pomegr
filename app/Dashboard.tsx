"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { MonitorState, SessionSummary } from "../shared/monitor-contract";
import type { SessionSummaryDomain } from "../shared/session-domain-contract";
import { encodeSessionRoute } from "../shared/session-route.mjs";
import { ActivitiesTab } from "./components/dashboard/ActivitiesTab";
import { AgentsTab } from "./components/dashboard/AgentsTab";
import { LegacySessionTab } from "./components/dashboard/LegacySessionTab";
import { RepositoryTab } from "./components/dashboard/RepositoryTab";
import { SessionIdChip } from "./components/dashboard/SessionIdChip";
import { ResourcesTab } from "./components/dashboard/ResourcesTab";
import { SignalsTab } from "./components/dashboard/SignalsTab";
import { SessionOverview } from "./components/dashboard/SessionOverview";
import { SessionTabs } from "./components/dashboard/SessionTabs";
import { parseSessionTab, sessionQueryString, type SessionRouteQuery, type SessionTab } from "./components/dashboard/session-route";
import { CommandBreadcrumbSeparator, CommandIcon, CommandPageHeader, CommandStatus } from "./components/command-center/CommandPage";
import type { DesktopState } from "./components/DesktopControls";
import { SessionWallTimeText } from "./components/LiveTime";
import { ProviderBadge } from "./components/ProviderBadge";
import { compactNumber, sessionListTime, sessionState, stateEndpoint } from "./dashboard-utils";
import { useDisplayPreferences } from "./hooks/DisplayPreferencesContext";
import { useSessionCatalog } from "./hooks/SessionCatalogContext";
import { buildSessionReport, sessionReportFilename } from "./session-report.mjs";
import { useSessionDomain } from "./session-domain-store";

type DesktopBridge = {
  saveReport(payload: { filename: string; content: string }): Promise<{ status: string }>;
  getDesktopState(): Promise<DesktopState | null>;
  onDesktopStateChanged(callback: (state: DesktopState) => void): () => void;
};

function desktopBridge() { return (window as Window & { pomegrDesktop?: DesktopBridge }).pomegrDesktop; }

function SessionKpis({ summary, historical }: { summary: SessionSummaryDomain; historical: boolean }) {
  const agentsReady = summary.sectionReadiness.agentEvidence === "ready";
  const statusCountsReady = agentsReady && summary.metrics.idleAgents !== null && summary.metrics.finishedAgents !== null
    && summary.metrics.activeAgents + summary.metrics.idleAgents + summary.metrics.finishedAgents === summary.metrics.agents;
  const contextReady = summary.sectionReadiness.contextEvidence === "ready";
  const activityReady = summary.sectionReadiness.activityEvidence === "ready";
  const session = summary.session;
  return <section className="sessionKpiStrip sessionSummaryKpis" aria-label="Session totals">
    <div className="sessionKpi"><span className="sessionEyebrow">Agents</span><strong>{agentsReady ? summary.metrics.agents.toLocaleString() : "—"}</strong><small>{statusCountsReady ? <><span className={summary.metrics.activeAgents ? "sessionPositive" : undefined}>{summary.metrics.activeAgents} active</span><span className="sessionDesktopLabel"> · {summary.metrics.idleAgents} idle · {summary.metrics.finishedAgents} finished</span></> : "Agent status counts unavailable"}</small></div>
    <div className="sessionKpi"><span className="sessionEyebrow"><span className="sessionDesktopLabel">All-agent context</span><span className="sessionPhoneLabel">Context</span></span><strong className="sessionContextValue">{contextReady ? compactNumber(summary.allAgentContext) : "—"}</strong><small>{contextReady ? <><span className="sessionDesktopLabel">Latest snapshots · not spend</span><span className="sessionPhoneLabel">Sum of latest</span></> : "Context evidence unavailable"}</small></div>
    <div className="sessionKpi sessionKpiWall"><span className="sessionEyebrow">{historical ? "Recorded wall time" : "Wall time"}</span><strong>{session ? <SessionWallTimeText session={session} historical={historical} /> : "—"}</strong><small>Includes idle gaps</small></div>
    <div className="sessionKpi sessionKpiCalls"><span className="sessionEyebrow">Calls</span><strong>{activityReady ? summary.metrics.toolCalls.toLocaleString() : "—"}</strong><small>{activityReady ? `${summary.metrics.repeatedCalls.toLocaleString()} repeated` : "Activity evidence unavailable"}</small></div>
    <div className="sessionKpi sessionKpiDesktopOnly"><span className="sessionEyebrow">Agent estimate</span><strong>{activityReady && session?.progress ? `${session.progress.percent}%` : "—"}</strong><small>{activityReady && session?.progress ? `${session.progress.phase.replaceAll("_", " ")} · ${session.progress.confidence} confidence` : "No estimate recorded"}</small></div>
  </section>;
}

function SessionLoading({ error }: { error?: string | null }) {
  return <section className="commandView commandSessionView" aria-busy="true"><CommandPageHeader breadcrumb={<Link href="/sessions">Sessions</Link>} title="Loading session…" meta="Reading the latest committed summary." /><div className="sessionTabState" role="status">Loading session summary…</div>{error && <div className="notice" role="alert"><span aria-hidden="true">!</span>{error}</div>}</section>;
}

// The store never resolves `data` from a request that failed before any committed body was
// ever retained (see `session-domain-store.ts`'s catch branch), so without this a session whose
// very first request fails would render `SessionLoading` forever instead of recovering. Once a
// later poll succeeds `summary.data` becomes non-null and the caller stops rendering this state
// on its own, so no local retry bookkeeping is needed here.
function SessionConnectionIssue({ message }: { message: string }) {
  return <section className="commandView commandSessionView"><CommandPageHeader breadcrumb={<Link href="/sessions">Sessions</Link>} title="Session evidence unavailable" meta="Pomegr has not yet reached the local monitor for this session." /><div className="notice" role="alert"><span aria-hidden="true">!</span>{message}</div></section>;
}

function SessionUnavailable({ meta }: { meta: string }) {
  return <section className="commandView commandSessionView"><CommandPageHeader breadcrumb={<Link href="/sessions">Sessions</Link>} title="Session unavailable" meta={meta} /><div className="sessionTabState">Choose another session from the Sessions page.</div></section>;
}

// A detected session whose provider has not recorded anything yet is not unavailable: keep its
// catalog identity and say that its evidence will appear once the provider records it.
function SessionAwaitingActivity({ session }: { session: SessionSummary }) {
  return <section className="commandView commandSessionView"><CommandPageHeader breadcrumb={<><Link href="/sessions">Sessions</Link><CommandBreadcrumbSeparator /><span aria-current="page">{session.project}</span></>} title={session.title} meta={<div className="sessionHeaderMeta"><ProviderBadge source={session.source} /></div>} /><div className="sessionTabState" role="status">No recorded activity yet. Activity and context appear here once the provider records them.</div></section>;
}

export function Dashboard({ initialSessionId: sessionId, initialQuery = {} }: { initialSessionId: string; initialQuery?: SessionRouteQuery }) {
  const router = useRouter();
  const { sessions } = useSessionCatalog();
  const { preferences } = useDisplayPreferences();
  const catalogSession = sessions.find((session) => session.id === sessionId);
  const catalogHistorical = Boolean(catalogSession && !catalogSession.isLive && catalogSession.activityStatus !== "open");
  const [paused, setPaused] = useState(false);
  const [reportGenerating, setReportGenerating] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  // The catalog row can be loading, unavailable, or simply missing while the session's own
  // fetched summary already confirms `view: "history"`. Latch that confirmation so a recorded
  // session never keeps the live polling cadence just because the catalog has no matching row.
  const [trackedSessionId, setTrackedSessionId] = useState(sessionId);
  const [knownHistorical, setKnownHistorical] = useState(catalogHistorical);
  if (sessionId !== trackedSessionId) { setTrackedSessionId(sessionId); setKnownHistorical(catalogHistorical); }
  const domainHistorical = catalogHistorical || knownHistorical;
  const summaryResult = useSessionDomain({ sessionId, domain: "session-summary" }, { historical: domainHistorical, enabled: !paused });
  const summary = summaryResult.data;
  if (summary?.view === "history" && !knownHistorical) setKnownHistorical(true);
  const historical = summary?.view === "history" || catalogHistorical;
  const activeTab = parseSessionTab(initialQuery.tab);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let active = true;
    void bridge.getDesktopState().then((state) => { if (active && state) setPaused(state.paused); }, () => {});
    const unsubscribe = bridge.onDesktopStateChanged((state) => setPaused(state.paused));
    return () => { active = false; unsubscribe(); };
  }, []);

  const navigate = useCallback((changes: Partial<Record<keyof SessionRouteQuery, string | null>>) => {
    const next = { ...changes };
    if (Object.prototype.hasOwnProperty.call(changes, "agent") && changes.agent !== initialQuery.agent
      && !Object.prototype.hasOwnProperty.call(changes, "request")) next.request = null;
    const query = sessionQueryString(initialQuery, next);
    router.replace(`/sessions/${encodeSessionRoute(sessionId)}${query ? `?${query}` : ""}`, { scroll: false });
  }, [initialQuery, sessionId, router]);
  const selectTab = useCallback((tab: SessionTab) => navigate({ tab }), [navigate]);
  const navigateActivities = useCallback(({ agent, request }: { agent: string | null; request: string | null }) => navigate({ agent, request }), [navigate]);

  const generateReport = async () => {
    if (!summary?.session || reportGenerating) return;
    setReportGenerating(true);
    setReportError(null);
    try {
      const response = await fetch(stateEndpoint(sessionId), { cache: "no-store" });
      if (!response.ok || response.status === 204) throw new Error("Report evidence unavailable");
      const state = await response.json() as MonitorState;
      if (state.session?.id !== sessionId) throw new Error("Report evidence unavailable");
      const generatedAt = new Date();
      const content = buildSessionReport(state, generatedAt);
      const filename = sessionReportFilename(state, generatedAt);
      const bridge = desktopBridge();
      if (bridge) await bridge.saveReport({ filename, content });
      else {
        const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
    } catch { setReportError("The report could not be prepared from the latest committed session evidence."); }
    finally { setReportGenerating(false); }
  };

  // A definitive monitor answer (its hydration found no recorded evidence for this session) is not
  // a connection problem: show it honestly instead of "not yet reached the monitor", with no retry.
  if (!summary && summaryResult.unavailable) return <SessionUnavailable meta="Pomegr found no recorded evidence for this session." />;
  if (!summary) return summaryResult.error ? <SessionConnectionIssue message={summaryResult.error} /> : <SessionLoading />;
  // A retained "loading" body (no session yet) is still evidence that a request once completed,
  // so a later poll failure surfaces the connection notice alongside it rather than silently
  // showing "Loading session…" forever; the next successful response clears `summaryResult.error`
  // on its own (see session-domain-store.ts), so no local retry bookkeeping is needed here either.
  if (summary.readiness === "loading" && !summary.session) return <SessionLoading error={summaryResult.error} />;
  if (!summary.session || summary.readiness === "unavailable") return catalogSession
    ? <SessionAwaitingActivity session={catalogSession} />
    : <SessionUnavailable meta="Pomegr has no committed summary for this session." />;

  const status = sessionState(summary.lifecycle);
  const nativeId = summary.session.id.split(":").at(-1) || summary.session.id;
  const meta = <div className="sessionHeaderMeta"><ProviderBadge source={summary.source} /><span className="commandChip"><CommandStatus state={status.state}>{historical ? "Recorded" : status.label}</CommandStatus></span><SessionIdChip sessionId={nativeId} />{summary.repository.branch && <span className="commandChip sessionBranchChip"><CommandIcon name="git" size="small" />{summary.repository.branch}</span>}<span className="sessionStartedMeta">Started {summary.session.startedAt ? sessionListTime(summary.session.startedAt) : "time unavailable"}</span></div>;
  return <section className="commandView commandSessionView" aria-busy={summaryResult.fetching || undefined}>
    <CommandPageHeader breadcrumb={<><Link href="/sessions">Sessions</Link><CommandBreadcrumbSeparator /><span aria-current="page">{summary.session.project}</span></>} title={summary.session.title} meta={meta}
      actions={<button type="button" className="commandQuietAction" disabled={reportGenerating} onClick={() => void generateReport()}>{reportGenerating ? "Preparing…" : "Download report"}</button>} />
    {summaryResult.error && <div className="notice" role="status"><span aria-hidden="true">!</span>{summaryResult.error}</div>}
    {reportError && <div className="notice" role="status"><span aria-hidden="true">!</span>{reportError}</div>}
    <SessionKpis summary={summary} historical={historical} />
    <SessionTabs active={activeTab} summary={summary} onSelect={selectTab} />
    <div className="sessionTabPanel" role="tabpanel" id="session-tab-panel" aria-labelledby={`session-tab-${activeTab}`}>
      {activeTab === "overview" && <SessionOverview summary={summary} showEstimatedCost={preferences.estimatedCost} onNavigate={navigate} />}
      {activeTab === "agents" && <AgentsTab sessionId={sessionId} historical={historical} paused={paused} selectedAgentId={initialQuery.agent || null} onSelectAgent={(agentId) => navigate({ tab: "agents", agent: agentId })} onOpenActivities={({ agentId, request }) => navigate({ tab: "activities", agent: agentId || null, request: request || null })} />}
      {activeTab === "activities" && <ActivitiesTab sessionId={sessionId} historical={historical} paused={paused} route={{ agent: initialQuery.agent || null, request: initialQuery.request || null }} onRouteChange={navigateActivities} onOpenAgent={(agentId) => navigate({ tab: "agents", agent: agentId, request: null })} />}
      {activeTab === "signals" && <SignalsTab sessionId={sessionId} historical={historical} paused={paused} onNavigateAgent={(agentId) => navigate({ tab: "agents", agent: agentId })} />}
      {activeTab === "repository" && <RepositoryTab sessionId={sessionId} historical={historical} paused={paused} selectedPath={initialQuery.path || null} onSelectPath={(path) => navigate({ path })} />}
      {activeTab === "resources" && <ResourcesTab sessionId={sessionId} historical={historical} paused={paused} />}
      {activeTab !== "overview" && activeTab !== "agents" && activeTab !== "activities" && activeTab !== "signals" && activeTab !== "repository" && activeTab !== "resources" && <LegacySessionTab tab={activeTab} sessionId={sessionId} historical={historical} paused={paused} showEstimatedCost={preferences.estimatedCost} />}
    </div>
  </section>;
}
