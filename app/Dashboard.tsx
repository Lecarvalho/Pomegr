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
import { stateEndpoint } from "./dashboard-utils";
import { LiveClockProvider } from "./hooks/LiveClockContext";
import { RelativeTimeText } from "./components/LiveTime";
import { buildSessionReport, sessionReportFilename } from "./session-report.mjs";
import { usageRefreshDelay } from "./usage-refresh.mjs";

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

  const refresh = useCallback(async (refreshUsage = false) => {
    try {
      const response = await fetch(stateEndpoint(selectedSessionId, refreshUsage), { cache: "no-store" });
      if (!response.ok) throw new Error("Monitor unavailable");
      const nextData = await response.json() as MonitorState;
      startTransition(() => {
        setData(nextData);
        setLastRefresh(new Date());
      });
    } catch {
      setData((current) => ({ ...current, connected: false, error: "Start the local monitor with npm run dev." }));
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

  useEffect(() => {
    if (selectedIsHistorical || paused) return;
    const timeout = window.setTimeout(() => { void refresh(true); }, usageRefreshDelay(data.usageLimits.attemptedAt));
    return () => window.clearTimeout(timeout);
  }, [data.usageLimits.attemptedAt, paused, refresh, selectedIsHistorical]);

  const viewingHistory = data.view === "history";
  const clockRunning = data.connected && !viewingHistory && !paused;
  const attentionSessions = sessions.filter((session) => session.isLive && session.needsInput);

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
        <SessionHero session={data.session} historical={viewingHistory} />

        {attentionSessions.length > 0 && <div className="attentionNotice" role="status"><span className="attentionGlyph" aria-hidden="true">!</span><span><strong>Claude Code needs your input</strong><small>{attentionSessions.length === 1 ? attentionSessions[0].title : `${attentionSessions.length} live sessions are waiting for you`}</small></span></div>}
        {data.error && <div className="notice"><span>!</span>{data.error}</div>}
        {data.session && <RepositoryPanel session={data.session} />}
        {!viewingHistory && <UsageLimitsPanel usageLimits={data.usageLimits} />}
        <SummaryMetrics state={data} historical={viewingHistory} />
        <ContextGrowthTimeline timeline={data.metrics.tokens.contextGrowthTimeline} currentTokens={data.metrics.tokens} cost={data.session?.cost || null} historical={viewingHistory} />
        <MachineryPanel machinery={data.session?.contextMachinery} historical={viewingHistory} />

        <section className="contentGrid">
          <AgentActivityPanel agents={data.agents} executionTasks={data.executionTasks || []} planTasks={data.planTasks || []} historical={viewingHistory} />
          <InsightsPanel insights={data.insights} />
        </section>

        <ActivityPanel activity={data.activity} historical={viewingHistory} loading={loading} onRefresh={() => void refresh(false)} />
          <DashboardFooter viewingHistory={viewingHistory} paused={paused} lastRefresh={lastRefresh} />
        </main>
      </div>
    </LiveClockProvider>
  );
}

function DashboardFooter({ viewingHistory, paused, lastRefresh }: { viewingHistory: boolean; paused: boolean; lastRefresh: Date | null }) {
  return (
    <footer>
      <span>{viewingHistory ? "Historical transcript · Read-only" : "Local-only observer · Read-only"}</span>
      <span>{viewingHistory ? "Archived session view" : paused ? "Updates paused" : lastRefresh ? <>Updated <RelativeTimeText value={lastRefresh.toISOString()} /></> : "Connecting…"}</span>
    </footer>
  );
}
