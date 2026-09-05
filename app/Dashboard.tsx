"use client";

import Link from "next/link";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import type { MonitorState, SessionReadiness, SessionSummary } from "../shared/monitor-contract";
import { encodeSessionRoute } from "../shared/session-route.mjs";
import { createEmptyMonitorState, createEmptyProviderCapabilities } from "../shared/monitor-state.mjs";
import { AgentActivityPanel, type AgentActivityViewMode } from "./components/dashboard/AgentActivityPanel";
import { ContextHistoryPanel } from "./components/dashboard/ContextHistoryPanel";
import { SessionCommandBar } from "./components/dashboard/SessionCommandBar";
import { ResourceUsagePanel } from "./components/dashboard/ResourceUsagePanel";
import { RequestSnapshotsPanel } from "./components/dashboard/RequestSnapshotsPanel";
import { SessionDetailsPanel } from "./components/dashboard/SessionDetailsPanel";
import { RepositoryDisclosurePanel } from "./components/dashboard/RepositoryDisclosurePanel";
import { SessionHero } from "./components/dashboard/SessionHero";
import { ProviderBadge } from "./components/ProviderBadge";
import { SessionKpiStrip } from "./components/dashboard/SessionKpiStrip";
import { SessionSummaryCards } from "./components/dashboard/SessionSummaryCards";
import { sessionNeedingAttention, stateEndpoint } from "./dashboard-utils";
import { LiveClockProvider } from "./hooks/LiveClockContext";
import { buildSessionReport, sessionReportFilename } from "./session-report.mjs";
import type { DesktopState } from "./components/DesktopControls";
import { useSessionCatalog } from "./hooks/SessionCatalogContext";
import { useUsageLimits, useUsageLimitsPollingPause } from "./usage-limits-client";
import { useProviderStatus, useProviderStatusPollingPause } from "./provider-status-client";
import { ProviderServiceNotice, dismissProviderIncident, dismissedProviderIncidentFor, providerIncidentRank, providerServiceNoticeVisible, providerStatusFor } from "./components/ProviderStatus";
import { useDisplayPreferences } from "./hooks/DisplayPreferencesContext";
import { usePhoneLayout } from "./hooks/usePhoneLayout";

type DesktopBridge = {
  saveReport(payload: { filename: string; content: string }): Promise<{ status: string }>;
  getDesktopState(): Promise<DesktopState | null>;
  setPaused(value: boolean): Promise<DesktopState | null>;
  onDesktopStateChanged(callback: (state: DesktopState) => void): () => void;
};

function desktopBridge() {
  return (window as Window & { pomegrDesktop?: DesktopBridge }).pomegrDesktop;
}

function notificationNavigationSessionId() {
  if (typeof window === "undefined") return null;
  const candidate = new URLSearchParams(window.location.search).get("sessionId");
  return candidate && /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate) ? candidate : null;
}

function storedAgentActivityViewMode(sessionId: string | null): AgentActivityViewMode {
  if (!sessionId || typeof window === "undefined") return "list";
  try {
    return window.localStorage.getItem(`pomegr-agent-activity-view-${sessionId}`) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

export function Dashboard({ initialSessionId = null }: { initialSessionId?: string | null }) {
  const phone = usePhoneLayout();
  const [data, setData] = useState<MonitorState>(() => createEmptyMonitorState());
  const { sessions } = useSessionCatalog();
  const sharedUsage = useUsageLimits();
  const providerStatus = useProviderStatus();
  const { preferences: displayPreferences } = useDisplayPreferences();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => initialSessionId ?? notificationNavigationSessionId());
  const [paused, setPaused] = useState(false);
  useUsageLimitsPollingPause(paused);
  useProviderStatusPollingPause(paused);
  const [loading, setLoading] = useState(true);
  const [reportGenerating, setReportGenerating] = useState(false);
  const revisionsBySessionRef = useRef(new Map<string, number | string>());
  const [agentActivityViewPreference, setAgentActivityViewPreference] = useState<{ sessionId: string | null; viewMode: AgentActivityViewMode }>({ sessionId: null, viewMode: "list" });
  const capabilities = data.capabilities || createEmptyProviderCapabilities();
  const sharedProviderUsage = sharedUsage.providers.find((entry) => entry.provider === (data.source === "Codex" ? "codex" : "claude"));
  const displayData = sharedUsage.readiness[(data.source === "Codex" ? "codex" : "claude")] === "ready" && sharedProviderUsage
    ? { ...data, usageLimits: sharedProviderUsage.usageLimits }
    : data;
  const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId)
    ?? (data.catalogIdentity?.id === selectedSessionId ? data.catalogIdentity : null) : null;
  // Open can age out of the Live filter without becoming a historical snapshot.
  const selectedIsHistorical = Boolean(selectedSessionId && (selectedSession
    ? !selectedSession.isLive && selectedSession.activityStatus !== "open"
    : data.view === "history"));
  const [, setProviderNoticeVersion] = useState(0);

  useEffect(() => {
    const legacySessionId = notificationNavigationSessionId();
    if (!legacySessionId || initialSessionId) return;
    try {
      window.history.replaceState(null, "", `/sessions/${encodeSessionRoute(legacySessionId)}`);
    } catch {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    }
  }, [initialSessionId]);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let active = true;
    const apply = (state: DesktopState | null) => {
      if (!active || !state) return;
      setPaused(state.paused);
    };
    void bridge.getDesktopState().then(apply, () => {});
    const unsubscribe = bridge.onDesktopStateChanged(apply);
    return () => { active = false; unsubscribe(); };
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const revisionKey = selectedSessionId ?? "__current__";
      const response = await fetch(stateEndpoint(selectedSessionId, revisionsBySessionRef.current.get(revisionKey) ?? null), { cache: "no-store", signal });
      if (!response.ok) throw new Error("Monitor unavailable");
      if (response.status === 204) return "unchanged" as const;
      const nextData = await response.json() as MonitorState;
      if (signal?.aborted) return "aborted" as const;
      startTransition(() => {
        const headerRevision = response.headers.get("x-pomegr-revision");
        if (typeof nextData.revision === "number" || typeof nextData.revision === "string") revisionsBySessionRef.current.set(revisionKey, nextData.revision);
        else if (headerRevision) revisionsBySessionRef.current.set(revisionKey, headerRevision);
        setSelectedSessionId((current) => current ?? nextData.session?.id ?? nextData.catalogIdentity?.id ?? null);
        setData(nextData);
      });
      return Object.values(nextData.readiness || {}).includes("loading") || (!nextData.session && nextData.readiness?.core !== "unavailable")
        ? "loading" as const
        : "ready" as const;
    } catch {
      if (signal?.aborted) return "aborted" as const;
      setData((current) => ({ ...current, connected: false, error: "Local monitor unavailable. Run npm run dev in this project; Pomegr will reconnect automatically." }));
      return "failed" as const;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    const controller = new AbortController();
    let nextRefresh: number | null = null;
    let retryAttempt = 0;
    if (paused) return () => controller.abort();
    const schedule = (delay: number) => {
      if (controller.signal.aborted) return;
      if (nextRefresh !== null) window.clearTimeout(nextRefresh);
      nextRefresh = window.setTimeout(() => { nextRefresh = null; void poll(); }, delay);
    };
    const poll = async () => {
      const result = await refresh(controller.signal);
      if (controller.signal.aborted || paused || result === "aborted") return;
      if (result === "failed") return schedule([2_000, 5_000, 10_000, 30_000][Math.min(retryAttempt++, 3)]);
      retryAttempt = 0;
      if (document.hidden) return schedule(30_000);
      if (result === "loading") return schedule(1_000);
      if (!selectedIsHistorical) schedule(2_000);
    };
    const foreground = () => {
      if (!document.hidden && nextRefresh !== null) {
        window.clearTimeout(nextRefresh);
        nextRefresh = null;
        void poll();
      }
    };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    void poll();
    return () => {
      controller.abort();
      if (nextRefresh !== null) window.clearTimeout(nextRefresh);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [paused, refresh, selectedIsHistorical]);

  const togglePause = useCallback(() => {
    const next = !paused;
    const bridge = desktopBridge();
    setPaused(next);
    if (!bridge) return;
    void bridge.setPaused(next).then((state) => {
      if (!state) return;
      setPaused(state.paused);
    }, () => setPaused(!next));
  }, [paused]);

  const activeSessionId = data.session?.id ?? null;
  const agentActivityViewMode = agentActivityViewPreference.sessionId === activeSessionId
    ? agentActivityViewPreference.viewMode
    : storedAgentActivityViewMode(activeSessionId);
  const changeAgentActivityView = useCallback((viewMode: AgentActivityViewMode) => {
    setAgentActivityViewPreference({ sessionId: activeSessionId, viewMode });
    if (!activeSessionId) return;
    try {
      window.localStorage.setItem(`pomegr-agent-activity-view-${activeSessionId}`, viewMode);
    } catch {
      // The in-memory controlled state remains usable when preferences are unavailable.
    }
  }, [activeSessionId]);

  const viewingHistory = data.view === "history";
  const sessionMatchesSelection = Boolean(data.session && (!selectedSessionId || selectedSessionId === data.session.id));
  const switchingSession = Boolean(loading && data.session && selectedSessionId && selectedSessionId !== data.session.id);
  const visibleProviderStatus = providerStatusFor(providerStatus.providers, data.source === "Codex" ? "codex" : "claude");
  const providerIssueKey = visibleProviderStatus?.incidentKey || visibleProviderStatus?.status || null;
  const providerIssueRank = visibleProviderStatus ? providerIncidentRank(visibleProviderStatus) : 0;
  const showProviderNotice = providerServiceNoticeVisible(visibleProviderStatus, viewingHistory, dismissedProviderIncidentFor(data.session?.id || null), sessionMatchesSelection && !switchingSession);
  const connecting = loading && !data.error && !data.session;
  const clockRunning = data.connected && !viewingHistory && !paused && !switchingSession;
  const attentionSession = sessionNeedingAttention(sessions, data.session?.id || null, viewingHistory);

  const generateReport = async () => {
    if (!data.session || reportGenerating) return;
    setReportGenerating(true);
    let reportState = data;
    try {
      try {
        const revisionKey = selectedSessionId ?? "__current__";
        const response = await fetch(stateEndpoint(selectedSessionId, revisionsBySessionRef.current.get(revisionKey) ?? null), { cache: "no-store" });
        if (response.ok && response.status !== 204) {
          const latestState = await response.json() as MonitorState;
          if (latestState.session?.id === data.session.id) {
            const headerRevision = response.headers.get("x-pomegr-revision");
            if (typeof latestState.revision === "number" || typeof latestState.revision === "string") revisionsBySessionRef.current.set(revisionKey, latestState.revision);
            else if (headerRevision) revisionsBySessionRef.current.set(revisionKey, headerRevision);
            reportState = { ...latestState, revision: latestState.revision ?? headerRevision ?? null };
            setData(reportState);
          }
        }
      } catch {
        // The visible snapshot remains sufficient when the local refresh is unavailable.
      }
      const generatedAt = new Date();
      const content = buildSessionReport(reportState, generatedAt);
      const filename = sessionReportFilename(reportState, generatedAt);
      const bridge = desktopBridge();
      if (bridge) {
        await bridge.saveReport({ filename, content });
        return;
      }
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setReportGenerating(false);
    }
  };

  const breadcrumbProject = selectedSession?.project || ((!selectedSessionId || selectedSessionId === data.session?.id) ? data.session?.project : null);

  return (
    <LiveClockProvider running={clockRunning}>
      <section className="commandSessionView" id="top">
        <nav className="sessionBreadcrumb" aria-label="Breadcrumb">
          <ol>
            <li><Link href="/sessions">Sessions</Link></li>
            {breadcrumbProject && <li>
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none"><path d="m6 3 5 5-5 5" /></svg>
              <span aria-current="page">{breadcrumbProject}</span>
            </li>}
          </ol>
        </nav>
        <SessionCommandBar activityStatus={selectedSession?.activityStatus} connected={data.connected} connecting={connecting} historical={viewingHistory} paused={paused} reportGenerating={reportGenerating} canGenerateReport={Boolean(data.session) && !phone} onGenerateReport={generateReport} onTogglePause={togglePause} />
        {data.session && (!selectedSessionId || selectedSessionId === data.session.id) ? <div className="sessionView" key={data.session.id} aria-busy={switchingSession}>
          <SessionHero session={data.session} source={data.source} capabilities={capabilities} historical={viewingHistory} activityStatus={selectedSession?.activityStatus} reportGenerating={reportGenerating} onGenerateReport={generateReport} />
          {showProviderNotice && <ProviderServiceNotice status={visibleProviderStatus!} onDismiss={() => { dismissProviderIncident(data.session!.id, { key: providerIssueKey!, rank: providerIssueRank }); setProviderNoticeVersion((version) => version + 1); }} />}
          {attentionSession && <div className="attentionNotice" role="status"><span className="attentionGlyph" aria-hidden="true">!</span><span><strong>Agent needs your input</strong><small>{attentionSession.title}</small></span></div>}
          {data.error && <div className="notice"><span>!</span>{data.error}</div>}
          <SessionKpiStrip state={data} historical={viewingHistory} />
          {data.readiness?.contextEvidence === "loading" ? <ReadinessSkeleton label="context evidence" /> : <>{displayPreferences.contextHistory && <ContextHistoryPanel key={data.session?.id || "awaiting-session"} agents={data.agents} tokens={data.metrics.tokens} historical={viewingHistory} />}
          <RequestSnapshotsPanel key={`${data.session?.id || "awaiting-session"}-requests`} agents={data.agents} requestSnapshots={data.metrics.tokens.requestSnapshots} cacheEvents={data.metrics.tokens.cacheEvents} cacheWriteAvailable={capabilities.cacheWriteUsage} historical={viewingHistory} /></>}
          {data.readiness?.activityEvidence === "loading" ? <ReadinessSkeleton label="session activity" className="sessionProgressSkeleton" /> : <SessionSummaryCards state={data} paused={paused} historical={viewingHistory} needsInput={Boolean(attentionSession?.needsInput)} />}
          {data.readiness?.agentEvidence === "loading" ? <ReadinessSkeleton label="agent evidence" /> : <section className="contentGrid" id="agent-activity">
            <AgentActivityPanel agents={data.agents} cacheRefills={data.metrics.tokens.cacheEvents.possibleFullRefills} cacheReadDrops={data.metrics.tokens.cacheReadDrops?.items} contextBoundaries={data.metrics.tokens.contextHistory.boundaries} executionTasks={data.executionTasks || []} planTasks={capabilities.planTasks ? data.planTasks || [] : []} requestSnapshots={data.metrics.tokens.requestSnapshots} workflows={data.workflows || []} historical={viewingHistory} sessionId={data.session.id} viewMode={agentActivityViewMode} onViewModeChange={changeAgentActivityView} />
          </section>}
          {!viewingHistory && (data.readiness?.resources === "loading" ? <ReadinessSkeleton label="resource usage" /> : <ResourceUsagePanel resources={data.metrics.resources} />)}

          <RepositoryDisclosurePanel session={displayData.session!} historical={viewingHistory} />
          <SessionDetailsPanel state={displayData} historical={viewingHistory} loading={loading} onRefresh={() => void refresh()} showEstimatedCost={displayPreferences.estimatedCost} />
        </div> : <>
          {data.error && <div className="notice"><span>!</span>{data.error}</div>}
          <AwaitingSession connected={data.connected} connecting={connecting} loadingSession={Boolean(selectedSessionId)} session={selectedSession} readiness={data.readiness} />
        </>}
      </section>
    </LiveClockProvider>
  );
}

function AwaitingSession({ connected, connecting, loadingSession, session, readiness }: { connected: boolean; connecting: boolean; loadingSession: boolean; session: SessionSummary | null | undefined; readiness?: SessionReadiness }) {
  if (session && readiness?.core === "unavailable") return <section className="sessionView" aria-label={`Session ${session.title}`}>
    <header className="hero"><div><h1>{session.title}</h1><div className="sessionIdentity"><strong>{session.project}</strong><span>{session.source}</span></div></div></header>
    <section className="panel sessionLoadingPanel" aria-label="Recorded activity" role="status">
      <strong>No recorded activity yet</strong>
      <p>Pomegr has detected this session. Activity and context will appear here when the provider records them.</p>
    </section>
  </section>;
  if (loadingSession && session) return <SessionLoadingShell session={session} readiness={readiness || { core: "loading", agentEvidence: "loading", contextEvidence: "loading", activityEvidence: "loading", repository: "loading", resources: "loading", usageLimits: "loading" }} />;
  const heading = connecting
    ? loadingSession ? "Loading session" : "Connecting to local monitor"
    : connected ? "No active session yet" : "Local monitor offline";
  const description = connecting
    ? loadingSession
      ? "Fetching the latest state for this session."
      : "Loading the latest session state. Prompts and responses stay private."
    : connected
      ? "Start a coding-agent session and it will appear here automatically. Prompts and responses stay private."
      : "Run npm run dev in this project. Pomegr will reconnect automatically.";
  return (
    <section className="awaitingSession" aria-label="Session discovery status" aria-live="polite">
      <h1>{heading}</h1>
      <p>{description}</p>
    </section>
  );
}

function SessionLoadingShell({ session, readiness }: { session: SessionSummary; readiness: SessionReadiness }) {
  const domainSkeleton = (domain: keyof SessionReadiness) => readiness[domain] === "loading";
  return <section className="sessionView sessionView-loading" aria-label={`Loading ${session.title}`} aria-busy="true">
    <header className="hero">
      <div><h1>{session.title}</h1><div className="sessionIdentity"><strong>{session.project}</strong><span className="sessionIdentityPart"><span aria-hidden="true">·</span><ProviderBadge source={session.source} /></span><span className="sessionIdentityPart"><span aria-hidden="true">·</span>{session.isLive ? "Live session" : "Recorded session"}</span></div></div>
      <span className="uiSkeleton sessionLoadingStatus" aria-hidden="true" />
    </header>
    <p className="srOnly" role="status">Loading session evidence for {session.title}.</p>
    <div className="sessionLoadingPanels">
      {(["agentEvidence", "contextEvidence", "activityEvidence", "repository", "resources", "usageLimits"] as const).map((domain) => domainSkeleton(domain)
        ? <section className="sessionLoadingPanel panel" aria-hidden="true" key={domain}><span className="uiSkeleton sessionLoadingPanelTitle" /><span className="uiSkeleton sessionLoadingPanelBody" /><span className="uiSkeleton sessionLoadingPanelBody short" /></section>
        : readiness[domain] === "unavailable" ? <section className="sessionLoadingPanel panel sessionLoadingUnavailable" key={domain}><strong>{domain.replace(/([A-Z])/g, " $1")} unavailable</strong><p>This evidence could not be confirmed by the local monitor.</p></section>
        : null)}
    </div>
  </section>;
}

function ReadinessSkeleton({ label, className = "" }: { label: string; className?: string }) {
  return <section className={`panel readinessSkeleton ${className}`.trim()} aria-busy="true"><p className="srOnly" role="status">Loading {label}.</p><span className="uiSkeleton readinessSkeletonTitle" aria-hidden="true" /><span className="uiSkeleton readinessSkeletonBody" aria-hidden="true" /><span className="uiSkeleton readinessSkeletonBody short" aria-hidden="true" /></section>;
}
