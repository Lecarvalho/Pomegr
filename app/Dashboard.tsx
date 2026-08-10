"use client";

import { startTransition, useCallback, useEffect, useState } from "react";
import type { MonitorState, SessionSummary } from "../shared/monitor-contract";
import { createEmptyMonitorState } from "../shared/monitor-state.mjs";
import { ActivityPanel } from "./components/dashboard/ActivityPanel";
import { AgentActivityPanel } from "./components/dashboard/AgentActivityPanel";
import { ContextGrowthTimeline } from "./components/dashboard/ContextGrowthTimeline";
import { DashboardHeader } from "./components/dashboard/DashboardHeader";
import { InsightsPanel } from "./components/dashboard/InsightsPanel";
import { MachineryPanel } from "./components/dashboard/MachineryPanel";
import { RepositoryPanel } from "./components/dashboard/RepositoryPanel";
import { SessionHero } from "./components/dashboard/SessionHero";
import { SessionSidebar } from "./components/dashboard/SessionSidebar";
import { SummaryMetrics } from "./components/dashboard/SummaryMetrics";
import { UsageLimitsPanel } from "./components/dashboard/UsageLimitsPanel";
import { sessionNeedingAttention, stateEndpoint } from "./dashboard-utils";
import { LiveClockProvider } from "./hooks/LiveClockContext";
import { RelativeTimeText } from "./components/LiveTime";
import { buildSessionReport, sessionReportFilename } from "./session-report.mjs";

export function Dashboard() {
  const [data, setData] = useState<MonitorState>(() => createEmptyMonitorState());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reportGenerating, setReportGenerating] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : null;
  const selectedIsHistorical = Boolean(selectedSessionId && (selectedSession ? !selectedSession.isLive : data.view === "history"));

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(stateEndpoint(selectedSessionId), { cache: "no-store" });
      if (!response.ok) throw new Error("Monitor unavailable");
      const nextData = await response.json() as MonitorState;
      startTransition(() => {
        setData(nextData);
        setLastRefresh(new Date());
      });
    } catch {
      setData((current) => ({ ...current, connected: false, error: "Local monitor unavailable. Run npm run dev in this project; Threadlight will reconnect automatically." }));
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

  const refreshSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (!response.ok) return;
      const catalog = await response.json() as { sessions?: SessionSummary[] };
      startTransition(() => setSessions(catalog.sessions || []));
    } catch {
      // Live monitoring remains available when the catalog cannot be refreshed.
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const interval = selectedIsHistorical ? null : window.setInterval(() => { if (!paused) void refresh(); }, 1800);
    return () => {
      window.clearTimeout(initial);
      if (interval) window.clearInterval(interval);
    };
  }, [paused, refresh, selectedIsHistorical]);

  useEffect(() => {
    const initial = window.setTimeout(refreshSessions, 0);
    const interval = window.setInterval(refreshSessions, 2_000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [refreshSessions]);

  const viewingHistory = data.view === "history";
  const clockRunning = data.connected && !viewingHistory && !paused;
  const attentionSession = sessionNeedingAttention(sessions, data.session?.id || null, viewingHistory);

  const selectSession = useCallback((session: SessionSummary) => {
    setSelectedSessionId(session.id);
    setData(createEmptyMonitorState({ view: session.isLive ? "live" : "history" }));
    setSidebarOpen(false);
    setLoading(true);
  }, []);

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
      const blob = new Blob([buildSessionReport(reportState, generatedAt)], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = sessionReportFilename(reportState, generatedAt);
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
        <SessionSidebar open={sidebarOpen} sessions={sessions} selectedSessionId={selectedSessionId} currentSessionId={data.session?.id || null} viewingHistory={viewingHistory} onClose={() => setSidebarOpen(false)} onSelect={selectSession} />
        <main className="shell">
        <DashboardHeader connected={data.connected} historical={viewingHistory} paused={paused} reportGenerating={reportGenerating} canGenerateReport={Boolean(data.session)} onOpenSessions={() => setSidebarOpen(true)} onGenerateReport={generateReport} onTogglePause={() => setPaused((value) => !value)} />
        {data.session && <SessionHero session={data.session} historical={viewingHistory} />}

        {attentionSession && <div className="attentionNotice" role="status"><span className="attentionGlyph" aria-hidden="true">!</span><span><strong>Agent needs your input</strong><small>{attentionSession.title}</small></span></div>}
        {data.error && <div className="notice"><span>!</span>{data.error}</div>}
        {data.session ? <>
          <section className="contentGrid">
            <AgentActivityPanel agents={data.agents} executionTasks={data.executionTasks || []} planTasks={data.planTasks || []} historical={viewingHistory} />
            <InsightsPanel insights={data.insights} />
          </section>

          <SummaryMetrics state={data} historical={viewingHistory} />
          <ContextGrowthTimeline timeline={data.metrics.tokens.contextGrowthTimeline} currentTokens={data.metrics.tokens} cost={data.session.cost || null} historical={viewingHistory} />

          <details className="sessionDetails">
            <summary><span>Session details</span><small>Repository, usage limits, loaded context, and activity</small></summary>
            <div className="sessionDetailsBody">
              <RepositoryPanel session={data.session} />
              {!viewingHistory && <UsageLimitsPanel usageLimits={data.usageLimits} />}
              <MachineryPanel machinery={data.session.contextMachinery} historical={viewingHistory} />
              <ActivityPanel activity={data.activity} historical={viewingHistory} loading={loading} onRefresh={() => void refresh(false)} />
            </div>
          </details>
        </> : <AwaitingSession connected={data.connected} />}
          <DashboardFooter viewingHistory={viewingHistory} paused={paused} lastRefresh={lastRefresh} />
        </main>
      </div>
    </LiveClockProvider>
  );
}

function AwaitingSession({ connected }: { connected: boolean }) {
  return (
    <section className="awaitingSession" aria-label="Session discovery status">
      <h1>{connected ? "No active session yet" : "Local monitor offline"}</h1>
      <p>{connected
        ? "Start a coding-agent session and it will appear here automatically. Prompts and responses stay private."
        : "Run npm run dev in this project. Threadlight will reconnect automatically."}</p>
    </section>
  );
}

function DashboardFooter({ viewingHistory, paused, lastRefresh }: { viewingHistory: boolean; paused: boolean; lastRefresh: Date | null }) {
  return (
    <footer>
      <span>{viewingHistory ? "Recorded session · Read-only" : "Local observer · Read-only"}</span>
      <span>{viewingHistory ? "Historical snapshot" : paused ? "Live updates paused" : lastRefresh ? <>Updated <RelativeTimeText value={lastRefresh.toISOString()} /></> : "Connecting…"}</span>
    </footer>
  );
}
