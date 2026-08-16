"use client";

import { startTransition, useCallback, useEffect, useState } from "react";
import type { MonitorState, SessionSummary } from "../shared/monitor-contract";
import { createEmptyMonitorState, createEmptyProviderCapabilities } from "../shared/monitor-state.mjs";
import { AgentActivityPanel } from "./components/dashboard/AgentActivityPanel";
import { ContextHistoryPanel } from "./components/dashboard/ContextHistoryPanel";
import { DashboardHeader } from "./components/dashboard/DashboardHeader";
import { InsightsPanel } from "./components/dashboard/InsightsPanel";
import { ResourceUsagePanel } from "./components/dashboard/ResourceUsagePanel";
import { SessionDetailsPanel } from "./components/dashboard/SessionDetailsPanel";
import { SessionHero } from "./components/dashboard/SessionHero";
import { SessionSidebar } from "./components/dashboard/SessionSidebar";
import { SummaryMetrics } from "./components/dashboard/SummaryMetrics";
import { WorkflowActivityPanel } from "./components/dashboard/WorkflowActivityPanel";
import { preserveSessionOrder, sessionNeedingAttention, stateEndpoint } from "./dashboard-utils";
import { LiveClockProvider } from "./hooks/LiveClockContext";
import { RelativeTimeText } from "./components/LiveTime";
import { buildSessionReport, sessionReportFilename } from "./session-report.mjs";
import type { DesktopState } from "./components/DesktopControls";

type DesktopBridge = {
  saveReport(payload: { filename: string; content: string }): Promise<{ status: string }>;
  getDesktopState(): Promise<DesktopState | null>;
  setPaused(value: boolean): Promise<DesktopState | null>;
  setLaunchAtLogin(value: boolean): Promise<DesktopState | null>;
  setCloseBehavior(value: DesktopState["closeBehavior"]): Promise<DesktopState | null>;
  setNotifications(value: boolean): Promise<DesktopState | null>;
  setNotificationQuiet(value: boolean): Promise<DesktopState | null>;
  installUpdate(): Promise<DesktopState | null>;
  quit(): Promise<boolean>;
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

export function Dashboard() {
  const [data, setData] = useState<MonitorState>(() => createEmptyMonitorState());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => notificationNavigationSessionId());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [desktopState, setDesktopState] = useState<DesktopState | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportGenerating, setReportGenerating] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const capabilities = data.capabilities || createEmptyProviderCapabilities();
  const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : null;
  const selectedIsHistorical = Boolean(selectedSessionId && (selectedSession ? !selectedSession.isLive : data.view === "history"));

  useEffect(() => {
    document.documentElement.dataset.pomegrHydrated = "true";
    return () => { delete document.documentElement.dataset.pomegrHydrated; };
  }, []);

  useEffect(() => {
    if (!notificationNavigationSessionId()) return;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, []);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let active = true;
    const apply = (state: DesktopState | null) => {
      if (!active || !state) return;
      setDesktopState(state);
      setPaused(state.paused);
    };
    void bridge.getDesktopState().then(apply, () => {});
    const unsubscribe = bridge.onDesktopStateChanged(apply);
    return () => { active = false; unsubscribe(); };
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(stateEndpoint(selectedSessionId), { cache: "no-store", signal });
      if (!response.ok) throw new Error("Monitor unavailable");
      const nextData = await response.json() as MonitorState;
      if (signal?.aborted) return;
      startTransition(() => {
        setSelectedSessionId((current) => current ?? nextData.session?.id ?? null);
        setData(nextData);
        setLastRefresh(new Date());
      });
    } catch {
      if (signal?.aborted) return;
      setData((current) => ({ ...current, connected: false, error: "Local monitor unavailable. Run npm run dev in this project; Pomegr will reconnect automatically." }));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [selectedSessionId]);

  const refreshSessions = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store", signal });
      if (!response.ok) return;
      const catalog = await response.json() as { sessions?: SessionSummary[] };
      if (signal?.aborted) return;
      startTransition(() => setSessions((current) => preserveSessionOrder(current, catalog.sessions || [])));
    } catch {
      // Live monitoring remains available when the catalog cannot be refreshed.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let nextRefresh: number | null = null;
    if (paused) return () => controller.abort();
    const poll = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted && !paused && !selectedIsHistorical) {
        nextRefresh = window.setTimeout(() => void poll(), 1800);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (nextRefresh !== null) window.clearTimeout(nextRefresh);
    };
  }, [paused, refresh, selectedIsHistorical]);

  useEffect(() => {
    const controller = new AbortController();
    let nextRefresh: number | null = null;
    if (paused) return () => controller.abort();
    const poll = async () => {
      await refreshSessions(controller.signal);
      if (!controller.signal.aborted && !paused) nextRefresh = window.setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      controller.abort();
      if (nextRefresh !== null) window.clearTimeout(nextRefresh);
    };
  }, [paused, refreshSessions]);

  const togglePause = useCallback(() => {
    const next = !paused;
    const bridge = desktopBridge();
    setPaused(next);
    if (!bridge) return;
    void bridge.setPaused(next).then((state) => {
      if (!state) return;
      setDesktopState(state);
      setPaused(state.paused);
    }, () => setPaused(!next));
  }, [paused]);

  const setLaunchAtLogin = useCallback((value: boolean) => {
    void desktopBridge()?.setLaunchAtLogin(value).then((state) => { if (state) setDesktopState(state); }, () => {});
  }, []);

  const setCloseBehavior = useCallback((value: DesktopState["closeBehavior"]) => {
    void desktopBridge()?.setCloseBehavior(value).then((state) => { if (state) setDesktopState(state); }, () => {});
  }, []);

  const setNotifications = useCallback((value: boolean) => {
    void desktopBridge()?.setNotifications(value).then((state) => { if (state) setDesktopState(state); }, () => {});
  }, []);

  const setNotificationQuiet = useCallback((value: boolean) => {
    void desktopBridge()?.setNotificationQuiet(value).then((state) => { if (state) setDesktopState(state); }, () => {});
  }, []);

  const installUpdate = useCallback(() => {
    void desktopBridge()?.installUpdate().then((state) => { if (state) setDesktopState(state); }, () => {});
  }, []);

  const viewingHistory = data.view === "history";
  const connecting = loading && !data.error && !data.session;
  const switchingSession = Boolean(loading && data.session && selectedSessionId && selectedSessionId !== data.session.id);
  const clockRunning = data.connected && !viewingHistory && !paused && !switchingSession;
  const attentionSession = sessionNeedingAttention(sessions, data.session?.id || null, viewingHistory);

  const selectSession = useCallback((session: SessionSummary) => {
    if (session.id === selectedSessionId) {
      setSidebarOpen(false);
      return;
    }
    setSelectedSessionId(session.id);
    setSidebarOpen(false);
    setLoading(true);
  }, [selectedSessionId]);

  const generateReport = async () => {
    if (!data.session || reportGenerating) return;
    setReportGenerating(true);
    let reportState = data;
    try {
      try {
        const response = await fetch(stateEndpoint(selectedSessionId), { cache: "no-store" });
        if (response.ok) {
          const latestState = await response.json() as MonitorState;
          if (latestState.session) {
            reportState = latestState;
            setData(latestState);
            setLastRefresh(new Date());
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

  return (
    <LiveClockProvider running={clockRunning}>
      <div className="appFrame">
        <SessionSidebar open={sidebarOpen} sessions={sessions} selectedSessionId={selectedSessionId} currentSessionId={data.session?.id || null} viewingHistory={viewingHistory} update={desktopState?.update || null} onInstallUpdate={installUpdate} onClose={() => setSidebarOpen(false)} onSelect={selectSession} />
        <main className="shell" id="top">
        <DashboardHeader connected={data.connected} connecting={connecting} historical={viewingHistory} paused={paused} desktopState={desktopState} sessionsOpen={sidebarOpen} reportGenerating={reportGenerating} canGenerateReport={Boolean(data.session)} onOpenSessions={() => setSidebarOpen(true)} onGenerateReport={generateReport} onTogglePause={togglePause} onSetLaunchAtLogin={setLaunchAtLogin} onSetCloseBehavior={setCloseBehavior} onSetNotifications={setNotifications} onSetNotificationQuiet={setNotificationQuiet} onQuit={() => { void desktopBridge()?.quit(); }} />
        {data.session ? <div className="sessionView" key={data.session.id} aria-busy={switchingSession}>
          <SessionHero session={data.session} source={data.source} capabilities={capabilities} historical={viewingHistory} />
          {attentionSession && <div className="attentionNotice" role="status"><span className="attentionGlyph" aria-hidden="true">!</span><span><strong>Agent needs your input</strong><small>{attentionSession.title}</small></span></div>}
          {data.error && <div className="notice"><span>!</span>{data.error}</div>}
          {capabilities.workflows && (data.workflows || []).length > 0 && (
            <WorkflowActivityPanel agents={data.agents} historical={viewingHistory} sessionId={data.session.id} workflows={data.workflows || []} />
          )}
          <section className="contentGrid">
            <AgentActivityPanel agents={data.agents} executionTasks={data.executionTasks || []} planTasks={capabilities.planTasks ? data.planTasks || [] : []} workflows={data.workflows || []} historical={viewingHistory} />
            <InsightsPanel insights={data.insights} />
          </section>

          <SummaryMetrics state={data} historical={viewingHistory} />
          <ContextHistoryPanel key={data.session?.id || "awaiting-session"} agents={data.agents} tokens={data.metrics.tokens} historical={viewingHistory} />
          {!viewingHistory && <ResourceUsagePanel resources={data.metrics.resources} />}

          <SessionDetailsPanel state={data} historical={viewingHistory} loading={loading} onRefresh={() => void refresh()} />
        </div> : <>
          {data.error && <div className="notice"><span>!</span>{data.error}</div>}
          <AwaitingSession connected={data.connected} connecting={connecting} loadingSession={Boolean(selectedSessionId)} />
        </>}
          <DashboardFooter connected={data.connected} connecting={connecting} viewingHistory={viewingHistory} paused={paused} lastRefresh={lastRefresh} />
        </main>
      </div>
    </LiveClockProvider>
  );
}

function AwaitingSession({ connected, connecting, loadingSession }: { connected: boolean; connecting: boolean; loadingSession: boolean }) {
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

function DashboardFooter({ connected, connecting, viewingHistory, paused, lastRefresh }: { connected: boolean; connecting: boolean; viewingHistory: boolean; paused: boolean; lastRefresh: Date | null }) {
  return (
    <footer>
      <span>{viewingHistory ? "Recorded session · Read-only" : "Local observer · Read-only"} · <a href="https://github.com/Lecarvalho/pomegr" target="_blank" rel="noreferrer">Source</a> · <a href="/about#license">AGPL-3.0-only</a></span>
      <span>{connecting ? "Connecting…" : viewingHistory ? "Historical snapshot" : !connected ? "Monitor unavailable" : paused ? "Live updates paused" : lastRefresh ? <>Updated <RelativeTimeText value={lastRefresh.toISOString()} /></> : "Connecting…"}</span>
    </footer>
  );
}
