"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { buildSessionReport, sessionReportFilename } from "./session-report.mjs";

type Agent = {
  id: string;
  parentId: string | null;
  label: string;
  kind: string;
  model: string;
  effort: string;
  status: "active" | "waiting" | "needs_input" | "warm" | "finished" | "stopped" | "idle";
  toolCalls: number;
  lastSeen: string;
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  tokens: {
    total: number;
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  };
};

type Activity = {
  id: string;
  timestamp: string;
  actor: string;
  tool: string;
  detail: string;
};

type ExecutionTask = {
  id: string;
  label: string;
  kind: "shell";
  status: "running" | "completed" | "failed" | "stopped";
  background: boolean;
  backgroundId: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
};

type PlanTask = {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  blocks: string[];
  blockedBy: string[];
};

type ContextGrowthBucket = {
  start: string;
  end: string;
  total: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

type Insight = {
  id: string;
  level: "info" | "warning";
  title: string;
  detail: string;
};

type LoopPattern = {
  id: string;
  agent: string;
  tool: string;
  detail: string;
  calls: number;
  repeats: number;
};

type ToolPattern = {
  id: string;
  agent: string;
  tool: string;
  detail: string;
  calls: number;
};

type SessionSummary = {
  id: string;
  title: string;
  project: string;
  updatedAt: string;
  isLive: boolean;
};

type MonitorState = {
  connected: boolean;
  source: string;
  view: "live" | "history";
  session: {
    id: string;
    title: string;
    project: string;
    cwd: string;
    repository: {
      available: boolean;
      branch: string;
      files: Array<{ status: string; path: string }>;
      historical: boolean;
    };
    startedAt: string | null;
    updatedAt: string | null;
    durationMs: number;
  } | null;
  score: number;
  metrics: {
    agents: number;
    activeAgents: number;
    toolCalls: number;
    repeatedCalls: number;
    tokens: {
      allAgents: number;
      input: number;
      output: number;
      cacheWrite: number;
      cacheRead: number;
      contextGrowthTimeline: {
        bucketMs: number;
        buckets: ContextGrowthBucket[];
      };
    };
  };
  agents: Agent[];
  toolPatterns: ToolPattern[];
  loops: LoopPattern[];
  activity: Activity[];
  executionTasks: ExecutionTask[];
  planTasks: PlanTask[];
  insights: Insight[];
  usageLimits: {
    available: boolean;
    fetchedAt: string | null;
    attemptedAt: string | null;
    error?: string;
    limits: Array<{
      id: string;
      label: string;
      window: string;
      percent: number;
      resetsAt: string | null;
      severity: string;
      active: boolean;
    }>;
  };
  error?: string;
};

const EMPTY: MonitorState = {
  connected: false,
  source: "Claude Code",
  view: "live",
  session: null,
  score: 100,
  metrics: {
    agents: 0,
    activeAgents: 0,
    toolCalls: 0,
    repeatedCalls: 0,
    tokens: { allAgents: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, contextGrowthTimeline: { bucketMs: 0, buckets: [] } },
  },
  agents: [],
  toolPatterns: [],
  loops: [],
  activity: [],
  executionTasks: [],
  planTasks: [],
  insights: [],
  usageLimits: { available: false, fetchedAt: null, attemptedAt: null, limits: [] },
};

function relativeTime(value: string | null) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function shortTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function sessionListTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function stateEndpoint(sessionId: string | null, refreshUsage = false) {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  if (refreshUsage) params.set("refreshUsage", "1");
  return `/api/state${params.size ? `?${params}` : ""}`;
}

function groupSessionsByProject(sessions: SessionSummary[]) {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const project = session.project || "Unknown project";
    const projectSessions = groups.get(project) || [];
    projectSessions.push(session);
    groups.set(project, projectSessions);
  }
  return [...groups].map(([project, projectSessions]) => ({ project, sessions: projectSessions }));
}

function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

function formatDuration(milliseconds: number) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatBucketDuration(milliseconds: number) {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  return `${hours / 24}d`;
}

function timelineTime(value: string, includeDate = false) {
  return new Intl.DateTimeFormat(undefined, includeDate
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatAgentDuration(agent: Agent) {
  const startedAt = new Date(agent.startedAt).getTime();
  const isRunning = agent.status === "active" || agent.status === "waiting";
  const liveDuration = isRunning && Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const totalSeconds = Math.max(0, Math.floor(Math.max(agent.durationMs, liveDuration) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatExecutionTaskDuration(task: ExecutionTask) {
  const startedAt = new Date(task.startedAt).getTime();
  const finishedAt = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function gitStatusLabel(status: string) {
  if (status === "??") return "NEW";
  if (status.includes("D")) return "DEL";
  if (status.includes("R")) return "REN";
  if (status.includes("A")) return "ADD";
  if (status.includes("U")) return "CONFLICT";
  return "MOD";
}

function gitPathParts(filePath: string) {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separator < 0
    ? { directory: "", filename: filePath }
    : { directory: filePath.slice(0, separator + 1), filename: filePath.slice(separator + 1) };
}

function resetCountdown(value: string | null) {
  if (!value) return "Reset unavailable";
  const milliseconds = new Date(value).getTime() - Date.now();
  if (milliseconds <= 0) return "Resetting now";
  const totalMinutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `Resets in ${days}d ${hours}h`;
  if (hours) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${minutes}m`;
}

function agentTreeRows(agents: Agent[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];

  for (const agent of agents) {
    if (agent.parentId && agent.parentId !== agent.id && byId.has(agent.parentId)) {
      const siblings = children.get(agent.parentId) || [];
      siblings.push(agent);
      children.set(agent.parentId, siblings);
    } else {
      roots.push(agent);
    }
  }

  roots.sort((a, b) => (a.id === "primary" ? -1 : b.id === "primary" ? 1 : 0));
  const rows: Array<{ agent: Agent; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (agent: Agent, depth: number) => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    rows.push({ agent, depth });
    for (const child of children.get(agent.id) || []) visit(child, depth + 1);
  };

  for (const root of roots) visit(root, 0);
  for (const agent of agents) visit(agent, 0);
  return rows;
}

function ContextGrowthTimeline({ timeline, currentContext, historical }: {
  timeline: MonitorState["metrics"]["tokens"]["contextGrowthTimeline"];
  currentContext: number;
  historical: boolean;
}) {
  const buckets = timeline?.buckets || [];
  const maximum = Math.max(0, ...buckets.map((bucket) => bucket.total));
  const spansMultipleDays = buckets.length > 0
    && new Date(buckets.at(-1)?.end || 0).getTime() - new Date(buckets[0].start).getTime() >= 24 * 60 * 60_000;
  const middle = buckets[Math.floor((buckets.length - 1) / 2)];

  return (
    <section className={`panel tokenHistogramPanel ${historical ? "historical" : ""}`} aria-label="All-agent context growth timeline">
      <div className="panelHeader tokenHistogramHeader">
        <div className="tokenHistogramTitle">
          <div className="pulseBars" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <div><span className="label">CONTEXT GROWTH</span><h2>Context added over time</h2></div>
        </div>
        <div className="histogramSummary">
          <strong>{compactNumber(currentContext)}</strong>
          <span>{historical ? "recorded context" : "current context"}</span>
        </div>
      </div>
      {buckets.length === 0 ? (
        <Empty text="Context growth will appear here after the first model response." />
      ) : (
        <div className="histogramContent">
          <div className="histogramScale" aria-hidden="true">
            <span>{compactNumber(maximum)}</span>
            <span>{compactNumber(Math.round(maximum / 2))}</span>
            <span>0</span>
          </div>
          <div className="histogramChart">
            <div className="histogramGrid" aria-hidden="true"><i /><i /><i /></div>
            <div className="activityBars" role="list" aria-label={`${buckets.length} chronological context-growth buckets`}>
              {buckets.map((bucket) => {
                const height = maximum > 0 ? (bucket.total / maximum) * 100 : 0;
                const segmentSize = (value: number) => bucket.total > 0 ? `${(value / bucket.total) * 100}%` : "0%";
                const label = `${timelineTime(bucket.start, spansMultipleDays)} to ${timelineTime(bucket.end, spansMultipleDays)}: ${bucket.total.toLocaleString()} net context added; ${bucket.input.toLocaleString()} attributed to uncached input, ${bucket.cacheWrite.toLocaleString()} to cache write, ${bucket.cacheRead.toLocaleString()} to cache read, ${bucket.output.toLocaleString()} to generated output`;
                return (
                  <div
                    className={`activityBar ${bucket.total === 0 ? "emptyBar" : ""}`}
                    key={bucket.start}
                    role="listitem"
                    tabIndex={0}
                    aria-label={label}
                    style={{ "--bar-height": `${height}%` } as CSSProperties}
                  >
                    <i className="activityStack" aria-hidden="true">
                      <b className="activitySegment inputSegment" style={{ "--segment-size": segmentSize(bucket.input) } as CSSProperties} />
                      <b className="activitySegment cacheWriteSegment" style={{ "--segment-size": segmentSize(bucket.cacheWrite) } as CSSProperties} />
                      <b className="activitySegment cacheReadSegment" style={{ "--segment-size": segmentSize(bucket.cacheRead) } as CSSProperties} />
                      <b className="activitySegment outputSegment" style={{ "--segment-size": segmentSize(bucket.output) } as CSSProperties} />
                    </i>
                    <span className="histogramTooltip">
                      <strong>{compactNumber(bucket.total)} context added</strong>
                      <small>{timelineTime(bucket.start, spansMultipleDays)}–{timelineTime(bucket.end, spansMultipleDays)}</small>
                      <em>{compactNumber(bucket.input)} input · {compactNumber(bucket.cacheWrite)} write · {compactNumber(bucket.cacheRead)} read · {compactNumber(bucket.output)} output</em>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="histogramAxis" aria-hidden="true">
              <span>{timelineTime(buckets[0].start, spansMultipleDays)}</span>
              <span>{middle ? timelineTime(middle.start, spansMultipleDays) : ""}</span>
              <span>{timelineTime(buckets.at(-1)?.end || buckets[0].end, spansMultipleDays)}</span>
            </div>
          </div>
        </div>
      )}
      {buckets.length > 0 && (
        <div className="histogramFooter">
          <div className="histogramLegend" aria-label="Context growth composition legend">
            <span><i className="inputSwatch" />Uncached input</span>
            <span><i className="cacheWriteSwatch" />Cache write</span>
            <span><i className="cacheReadSwatch" />Cache read</span>
            <span><i className="outputSwatch" />Generated output</span>
          </div>
          <span>{formatBucketDuration(timeline.bucketMs)} per bar · positive change in latest snapshots</span>
        </div>
      )}
    </section>
  );
}

export function Dashboard() {
  const [data, setData] = useState<MonitorState>(EMPTY);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reportGenerating, setReportGenerating] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [openMetric, setOpenMetric] = useState<"tools" | "loops" | null>(null);
  const [executionTasksOpen, setExecutionTasksOpen] = useState(false);
  const [planTasksOpen, setPlanTasksOpen] = useState(false);
  const toolMetricRef = useRef<HTMLElement | null>(null);
  const loopMetricRef = useRef<HTMLElement | null>(null);
  const executionTaskPopoverRef = useRef<HTMLDivElement | null>(null);
  const planTaskPopoverRef = useRef<HTMLDivElement | null>(null);
  const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : null;
  const selectedIsHistorical = Boolean(selectedSessionId && (selectedSession ? !selectedSession.isLive : data.view === "history"));

  const refresh = useCallback(async (refreshUsage = false) => {
    try {
      const response = await fetch(stateEndpoint(selectedSessionId, refreshUsage), { cache: "no-store" });
      if (!response.ok) throw new Error("Monitor unavailable");
      setData(await response.json());
      setLastRefresh(new Date());
    } catch {
      setData((current) => ({
        ...current,
        connected: false,
        error: "Start the local monitor with npm run dev.",
      }));
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

  const refreshSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (!response.ok) return;
      const catalog = await response.json() as { sessions?: SessionSummary[] };
      setSessions(catalog.sessions || []);
    } catch {
      // Live monitoring remains available when the catalog cannot be refreshed.
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const interval = selectedIsHistorical ? null : window.setInterval(() => {
      if (!paused) refresh();
    }, 1800);
    return () => {
      window.clearTimeout(initial);
      if (interval) window.clearInterval(interval);
    };
  }, [paused, refresh, selectedIsHistorical]);

  useEffect(() => {
    const initial = window.setTimeout(refreshSessions, 0);
    const interval = window.setInterval(refreshSessions, 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (!openMetric) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const activeRef = openMetric === "tools" ? toolMetricRef : loopMetricRef;
      if (!activeRef.current?.contains(event.target as Node)) setOpenMetric(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMetric(null);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMetric]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!executionTasksOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!executionTaskPopoverRef.current?.contains(event.target as Node)) setExecutionTasksOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExecutionTasksOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [executionTasksOpen]);

  useEffect(() => {
    if (!planTasksOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!planTaskPopoverRef.current?.contains(event.target as Node)) setPlanTasksOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlanTasksOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [planTasksOpen]);

  useEffect(() => {
    if (selectedIsHistorical || paused) return;
    const interval = window.setInterval(() => {
      void refresh(true);
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [paused, refresh, selectedIsHistorical]);

  const sessionLabel = data.session?.title || "Waiting for a session";
  const ringStyle = {
    background: `conic-gradient(var(--green) ${data.score * 3.6}deg, var(--line) 0deg)`,
  };
  const agentRows = agentTreeRows(data.agents);
  const toolPatterns = data.toolPatterns || [];
  const loopPatterns = data.loops || [];
  const viewingHistory = data.view === "history";
  const liveSessions = sessions.filter((session) => session.isLive);
  const historySessions = sessions.filter((session) => !session.isLive);
  const historyGroups = groupSessionsByProject(historySessions);
  const executionTasks = data.executionTasks || [];
  const runningExecutionTasks = executionTasks.filter((task) => task.status === "running");
  const finishedExecutionTasks = executionTasks.filter((task) => task.status !== "running");
  const planTasks = data.planTasks || [];
  const completedPlanTasks = planTasks.filter((task) => task.status === "completed").length;
  const activePlanTasks = planTasks.filter((task) => task.status === "in_progress").length;
  const openPlanTasks = planTasks.length - completedPlanTasks - activePlanTasks;

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
    <div className="appFrame">
      {sidebarOpen && <button className="sidebarBackdrop" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close session navigation" />}
      <aside className={`sessionSidebar ${sidebarOpen ? "open" : ""}`} aria-label="Session navigation">
        <div className="sidebarHeader">
          <div><span className="label">THREADLIGHT</span><strong>Sessions</strong></div>
          <button type="button" onClick={() => setSidebarOpen(false)} aria-label="Close session navigation">×</button>
        </div>
        <nav className="sessionNav">
          <div className="liveHeading"><span>LIVE SESSIONS</span><small>{liveSessions.length}</small></div>
          <div className="liveSessionList">
            {liveSessions.map((session) => {
              const selected = selectedSessionId ? selectedSessionId === session.id : data.session?.id === session.id && !viewingHistory;
              return (
                <button
                  type="button"
                  className={`liveSessionLink ${selected ? "selected" : ""}`}
                  key={session.id}
                  onClick={() => { setSelectedSessionId(session.id); setData({ ...EMPTY, view: "live" }); setOpenMetric(null); setSidebarOpen(false); setLoading(true); }}
                  aria-current={selected ? "page" : undefined}
                >
                  <i />
                  <span><strong>{session.title}</strong><small>{session.project} · {relativeTime(session.updatedAt)}</small></span>
                </button>
              );
            })}
            {liveSessions.length === 0 && (
              <div className="liveSessionEmpty"><i /><span><strong>Waiting for a session</strong><small>Auto-discovery enabled</small></span></div>
            )}
          </div>
          <div className="historyHeading"><span>HISTORY</span><small>{historySessions.length}</small></div>
          <div className="historyList">
            {historySessions.length === 0 && <p>No previous sessions found.</p>}
            {historyGroups.map((group) => {
              const collapsed = collapsedProjects.has(group.project);
              const groupId = `history-project-${encodeURIComponent(group.project)}`;
              return (
                <section className={`historyProject ${collapsed ? "collapsed" : ""}`} key={group.project}>
                  <button
                    className="historyProjectHeader"
                    type="button"
                    onClick={() => setCollapsedProjects((current) => {
                      const next = new Set(current);
                      if (next.has(group.project)) next.delete(group.project);
                      else next.add(group.project);
                      return next;
                    })}
                    aria-expanded={!collapsed}
                    aria-controls={groupId}
                  >
                    <span><i aria-hidden="true">▾</i><strong title={group.project}>{group.project}</strong></span>
                    <small>{group.sessions.length}</small>
                  </button>
                  {!collapsed && <div className="historyProjectSessions" id={groupId}>
                    {group.sessions.map((session) => (
                      <button
                        type="button"
                        className={selectedSessionId === session.id ? "selected" : ""}
                        key={session.id}
                        onClick={() => { setSelectedSessionId(session.id); setData({ ...EMPTY, view: "history" }); setOpenMetric(null); setSidebarOpen(false); setLoading(true); }}
                        aria-current={selectedSessionId === session.id ? "page" : undefined}
                      >
                        <strong>{session.title}</strong>
                        <time>{sessionListTime(session.updatedAt)}</time>
                      </button>
                    ))}
                  </div>}
                </section>
              );
            })}
          </div>
        </nav>
      </aside>
      <main className="shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Threadlight home">
          <span className="brandMark"><i /><i /><i /></span>
          <span>Threadlight</span>
        </a>
        <div className="topActions">
          <button className="sessionMenuButton" type="button" onClick={() => setSidebarOpen(true)}>Sessions</button>
          <span className={`connection ${data.connected ? "online" : "offline"}`}>
            <i /> {viewingHistory ? "Historical session" : data.connected ? "Monitor connected" : "Monitor offline"}
          </span>
          <button className="ghostButton reportButton" onClick={generateReport} disabled={!data.session || reportGenerating}>
            {reportGenerating ? "Generating…" : "Generate report"}
          </button>
          {!viewingHistory && (
            <button className="ghostButton" onClick={() => setPaused((value) => !value)}>
              {paused ? "Resume" : "Pause"}
            </button>
          )}
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <div className="eyebrow"><span /> {viewingHistory ? "HISTORICAL SESSION" : "LIVE SESSION OBSERVER"} {data.session ? `· ${data.session.project}` : ""}</div>
          <h1>{sessionLabel}</h1>
          <p>{viewingHistory
            ? "Reviewing recorded execution metadata. Current usage limits and live repository state are excluded."
            : "Watching Claude Code quietly. Prompt and response text stay out of the dashboard; only execution metadata is analyzed."}</p>
        </div>
        <div className="sessionMeta">
          <span>{viewingHistory ? "RECORDED WALL TIME" : "ELAPSED WALL TIME"}</span>
          <strong>{data.session ? formatDuration(data.session.durationMs) : "—"}</strong>
          <small>{data.session ? viewingHistory ? `Ended ${sessionListTime(data.session.updatedAt || "")}` : `Last event ${relativeTime(data.session.updatedAt)}` : "Auto-discovery enabled"}</small>
        </div>
      </section>

      {data.error && <div className="notice"><span>!</span>{data.error}</div>}

      {data.session?.repository.available && (
        <section className="panel gitPanel" aria-label={data.session.repository.historical ? "Recorded Git branch" : "Git working tree"}>
          <div className="gitSummary">
            <div>
              <span className="label">{data.session.repository.historical ? "RECORDED BRANCH" : "GIT BRANCH"}</span>
              <h2>{data.session.repository.branch}</h2>
              <p title={data.session.cwd}>{data.session.project}</p>
            </div>
            <span className={`changeCount ${data.session.repository.files.length ? "dirty" : "clean"}`}>
              {data.session.repository.historical ? "File state not recorded" : data.session.repository.files.length ? `${data.session.repository.files.length} uncommitted` : "Working tree clean"}
            </span>
          </div>
          {!data.session.repository.historical && data.session.repository.files.length > 0 && (
            <div className="gitFiles">
              {data.session.repository.files.map((file) => {
                const pathParts = gitPathParts(file.path);
                return (
                  <div className="gitFile" key={`${file.status}-${file.path}`}>
                    <span className={`gitStatus ${gitStatusLabel(file.status).toLowerCase()}`}>{gitStatusLabel(file.status)}</span>
                    <code title={file.path}><span className="gitPathDirectory">{pathParts.directory}</span><strong className="gitPathName">{pathParts.filename}</strong></code>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {!viewingHistory && <section className="panel limitsPanel" aria-label="Claude usage limits">
        <div className="limitsHeader">
          <div><span className="label">CLAUDE PLAN</span><h2>Usage limits</h2></div>
          <span className={`quiet usageCheck ${data.usageLimits.error ? "stale" : ""}`} title={data.usageLimits.error || undefined}>
            {data.usageLimits.error
              ? data.usageLimits.fetchedAt
                ? `Checked ${relativeTime(data.usageLimits.fetchedAt)} · retry failed ${relativeTime(data.usageLimits.attemptedAt)}`
                : `Refresh failed ${relativeTime(data.usageLimits.attemptedAt)} · retrying`
              : data.usageLimits.fetchedAt ? `Checked ${relativeTime(data.usageLimits.fetchedAt)}` : "Connecting…"}
          </span>
        </div>
        <div className="limitCards">
          {!data.usageLimits.available && <Empty text={data.usageLimits.error || "Plan usage loads one minute after the page opens."} />}
          {data.usageLimits.limits.map((limit) => (
            <article className={`limitCard ${limit.severity}`} key={limit.id}>
              <div className="limitTop">
                <div><span>{limit.window}</span><strong>{limit.label}</strong></div>
                <b>{Math.round(limit.percent)}%</b>
              </div>
              <div className="limitTrack"><i style={{ width: `${Math.min(100, Math.max(0, limit.percent))}%` }} /></div>
              <div className="limitBottom"><span>{resetCountdown(limit.resetsAt)}</span>{limit.active && <em>Active limit</em>}</div>
            </article>
          ))}
        </div>
      </section>}

      <section className="summaryGrid" aria-label="Session summary">
        <article className="scoreCard panel">
          <div className="scoreRing" style={ringStyle}>
            <div><strong>{data.score}</strong><span>/100</span></div>
          </div>
          <div>
            <span className="label">FLOW SCORE</span>
            <h2>{data.score >= 85 ? "Running cleanly" : data.score >= 65 ? "Worth a look" : "Friction detected"}</h2>
            <p>Based on repeated calls, agent overlap, and waiting patterns.</p>
          </div>
        </article>

        <article className="metric panel">
          <span className="metricIcon agentsIcon">⌁</span>
          <div><span className="label">AGENTS</span><strong>{viewingHistory ? data.metrics.agents : data.metrics.activeAgents}{!viewingHistory && <small> / {data.metrics.agents}</small>}</strong></div>
          <p>{viewingHistory ? "observed in session" : "running now"}</p>
        </article>
        <article className="metric panel toolMetric" ref={toolMetricRef}>
          <span className="metricIcon toolIcon">⌘</span>
          <div><span className="label">TOOL CALLS</span><strong>{data.metrics.toolCalls}</strong></div>
          <div className="metricFooter">
            <span>across {toolPatterns.length} grouped {toolPatterns.length === 1 ? "pattern" : "patterns"}</span>
            <button
              type="button"
              onClick={() => setOpenMetric((open) => open === "tools" ? null : "tools")}
              disabled={toolPatterns.length === 0}
              aria-expanded={openMetric === "tools"}
              aria-controls="tool-calls-popover"
            >View list</button>
          </div>
          {openMetric === "tools" && (
            <div className="metricPopover" id="tool-calls-popover" role="dialog" aria-label="Tool call breakdown">
              <div className="metricPopoverHeader">
                <div><span className="label">TOOL CALL BREAKDOWN</span><strong>{toolPatterns.length} grouped patterns</strong></div>
                <button type="button" onClick={() => setOpenMetric(null)} aria-label="Close tool call breakdown">×</button>
              </div>
              <p>{data.metrics.toolCalls} calls grouped by agent, tool, and sanitized target.</p>
              <div className="metricPopoverList">
                {toolPatterns.map((pattern) => (
                  <div className="metricPopoverRow" key={pattern.id}>
                    <div><strong>{pattern.agent}</strong><span>{pattern.tool}{pattern.detail ? ` · ${pattern.detail}` : ""}</span></div>
                    <div><strong>{pattern.calls}</strong><span>{pattern.calls === 1 ? "call" : "calls"}</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </article>
        <article className="metric panel loopMetric" ref={loopMetricRef}>
          <span className={`metricIcon ${data.metrics.repeatedCalls ? "warnIcon" : "clearIcon"}`}>↻</span>
          <div><span className="label">REPEATED CALLS</span><strong>{data.metrics.repeatedCalls}</strong></div>
          <div className="metricFooter">
            <span>across {loopPatterns.length} loop {loopPatterns.length === 1 ? "pattern" : "patterns"}</span>
            <button
              type="button"
              onClick={() => setOpenMetric((open) => open === "loops" ? null : "loops")}
              disabled={loopPatterns.length === 0}
              aria-expanded={openMetric === "loops"}
              aria-controls="loop-patterns-popover"
            >View list</button>
          </div>
          {openMetric === "loops" && (
            <div className="metricPopover" id="loop-patterns-popover" role="dialog" aria-label="Repeated call patterns">
              <div className="metricPopoverHeader">
                <div><span className="label">LOOP PATTERNS</span><strong>{loopPatterns.length} grouped patterns</strong></div>
                <button type="button" onClick={() => setOpenMetric(null)} aria-label="Close loop patterns">×</button>
              </div>
              <p>{data.metrics.repeatedCalls} calls beyond the first occurrence of each pattern.</p>
              <div className="metricPopoverList">
                {loopPatterns.map((loop) => (
                  <div className="metricPopoverRow" key={loop.id}>
                    <div><strong>{loop.agent}</strong><span>{loop.tool}{loop.detail ? ` · ${loop.detail}` : ""}</span></div>
                    <div><strong>{loop.calls}</strong><span>{loop.repeats} repeated</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </article>
      </section>

      <ContextGrowthTimeline
        timeline={data.metrics.tokens.contextGrowthTimeline}
        currentContext={data.metrics.tokens.allAgents}
        historical={viewingHistory}
      />

      <section className="panel cachePanel" aria-label="All-agent context composition">
        <div className="cacheLead">
          <span className="label">CONTEXT COMPOSITION</span>
          <h2>All-agent latest snapshots</h2>
          <p>How the all-agent context total is composed.</p>
        </div>
        <div className="tokenStat">
          <span>Uncached input</span>
          <strong>{compactNumber(data.metrics.tokens.input)}</strong>
        </div>
        <div className="tokenStat">
          <span>Cache write</span>
          <strong>{compactNumber(data.metrics.tokens.cacheWrite)}</strong>
        </div>
        <div className="tokenStat">
          <span>Cache read</span>
          <strong>{compactNumber(data.metrics.tokens.cacheRead)}</strong>
        </div>
        <div className="tokenStat outputTokens">
          <span>Generated output</span>
          <strong>{compactNumber(data.metrics.tokens.output)}</strong>
        </div>
      </section>

      <section className="contentGrid">
        <article className="panel agentsPanel">
          <div className="panelHeader">
            <div><span className="label">ORCHESTRATION</span><h2>Agent activity</h2></div>
            <span className="quiet">{data.agents.length} observed</span>
          </div>
          <div className="agentList">
            {data.agents.length === 0 && <Empty text="No Claude Code agents detected yet." />}
            {agentRows.map(({ agent, depth }) => (
              <div
                className={`agentRow ${depth > 0 ? "childAgent" : "rootAgent"} ${agent.status}Agent ${(executionTasksOpen || planTasksOpen) && agent.id === "primary" ? "agentPopoverOpen" : ""}`}
                key={agent.id}
                style={{ "--agent-indent": `${Math.min(depth, 8) * 20}px` } as CSSProperties}
              >
                <div className="treeRail"><span className={agent.id === "primary" ? "primaryNode" : "agentNode"} /></div>
                <div className="agentIdentity">
                  <div className="agentTitleLine">
                    <strong>{agent.label}</strong>
                    {agent.id === "primary" && executionTasks.length > 0 && (
                      <div className="executionTaskAnchor" ref={executionTaskPopoverRef}>
                        <button
                          className="executionTaskTrigger"
                          type="button"
                          onClick={() => { setPlanTasksOpen(false); setExecutionTasksOpen((open) => !open); }}
                          aria-expanded={executionTasksOpen}
                          aria-controls="primary-agent-execution-tasks"
                        >{runningExecutionTasks.length > 0 ? `${runningExecutionTasks.length} running` : `${finishedExecutionTasks.length} shell tasks`}</button>
                        {executionTasksOpen && (
                          <div className="executionTaskPopover" id="primary-agent-execution-tasks" role="dialog" aria-label="Background tasks">
                            <div className="executionTaskPopoverHeader">
                              <div><span className="label">EXECUTION TASKS</span><strong>Background tasks</strong></div>
                              <button type="button" onClick={() => setExecutionTasksOpen(false)} aria-label="Close execution tasks">×</button>
                            </div>
                            <p>{runningExecutionTasks.length} running · {finishedExecutionTasks.length} recently finished</p>
                            <div className="executionTaskList">
                              {runningExecutionTasks.length > 0 && (
                                <section className="executionTaskSection" aria-label="Running execution tasks">
                                  <h3>Running</h3>
                                  {runningExecutionTasks.map((task) => (
                                    <div className="executionTaskRow running" key={task.id}>
                                      <span className="executionTaskState" aria-hidden="true">◷</span>
                                      <div><strong>{task.label}</strong><small>Shell · {task.background ? "background · " : ""}{formatExecutionTaskDuration(task)}</small></div>
                                    </div>
                                  ))}
                                </section>
                              )}
                              {finishedExecutionTasks.length > 0 && (
                                <section className="executionTaskSection" aria-label="Finished execution tasks">
                                  <h3>Recent finished {finishedExecutionTasks.length}</h3>
                                  {finishedExecutionTasks.map((task) => (
                                    <div className={`executionTaskRow ${task.status}`} key={task.id}>
                                      <span className="executionTaskState" aria-hidden="true">{task.status === "completed" ? "✓" : task.status === "failed" ? "!" : "×"}</span>
                                      <div>
                                        <strong>{task.label}</strong>
                                        <small>Shell · {formatExecutionTaskDuration(task)}{task.exitCode !== null ? ` · exit ${task.exitCode}` : ""}</small>
                                      </div>
                                    </div>
                                  ))}
                                </section>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {agent.id === "primary" && planTasks.length > 0 && (
                      <div className="planTaskAnchor" ref={planTaskPopoverRef}>
                        <button
                          className="planTaskTrigger"
                          type="button"
                          onClick={() => { setExecutionTasksOpen(false); setPlanTasksOpen((open) => !open); }}
                          aria-expanded={planTasksOpen}
                          aria-controls="primary-agent-plan-tasks"
                        >{planTasks.length} plan items</button>
                        {planTasksOpen && (
                          <div className="planTaskPopover" id="primary-agent-plan-tasks" role="dialog" aria-label="Claude plan checklist">
                            <div className="planTaskPopoverHeader">
                              <div><span className="label">CLAUDE PLAN</span><strong>Plan checklist</strong></div>
                              <button type="button" onClick={() => setPlanTasksOpen(false)} aria-label="Close plan checklist">×</button>
                            </div>
                            <p>{completedPlanTasks} done · {activePlanTasks} in progress · {openPlanTasks} open</p>
                            <div className="planTaskList">
                              {planTasks.map((task) => (
                                <div className={`planTaskRow ${task.status}`} key={task.id}>
                                  <span className="planTaskState" aria-hidden="true">{task.status === "completed" ? "✓" : task.status === "in_progress" ? "■" : "□"}</span>
                                  <div>
                                    <strong>{task.subject}</strong>
                                    {task.blockedBy.length > 0 && <small>Blocked by {task.blockedBy.join(", ")}</small>}
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="planTaskCaution">
                              <strong>Agent-maintained checklist</strong>
                              <span>Static until Claude updates it. Claude may forget, so do not treat this as live execution truth.</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="agentMeta">
                    <span className="agentMetaKind">{agent.kind}</span>
                    <span className="agentMetaRuntime">{agent.model} · {agent.effort} effort</span>
                    <span className="agentMetaTools">{agent.toolCalls} tools</span>
                  </div>
                </div>
                <div className="agentTokens">
                  <strong>{compactNumber(agent.tokens.total)}</strong>
                  <span>{viewingHistory ? "recorded context" : "current context"}</span>
                </div>
                <div className="agentDuration">
                  <strong>{formatAgentDuration(agent)}</strong>
                  <span>wall time</span>
                </div>
                <span className={`statusPill ${agent.status}`}><i />{agent.status === "needs_input" ? "needs input" : agent.status}</span>
                <time>{relativeTime(agent.lastSeen)}</time>
              </div>
            ))}
          </div>
        </article>

        <article className="panel insightPanel">
          <div className="panelHeader">
            <div><span className="label">EFFICIENCY COACH</span><h2>Live thoughts</h2></div>
            <span className="quiet">{data.insights.length} signals</span>
          </div>
          <div className="insightList">
            {data.insights.length === 0 && <Empty text="No efficiency issues found. Staying quiet." />}
            {data.insights.map((insight) => (
              <div className={`insight ${insight.level}`} key={insight.id}>
                <span className="insightGlyph">{insight.level === "warning" ? "↻" : "✓"}</span>
                <div><strong>{insight.title}</strong><p>{insight.detail}</p></div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="panel activityPanel">
        <div className="panelHeader">
          <div><span className="label">EVENT STREAM</span><h2>{viewingHistory ? "Recorded tool activity" : "Recent tool activity"}</h2></div>
          <button className="textButton" onClick={() => refresh(false)} disabled={loading}>Refresh now</button>
        </div>
        <div className="activityTable">
          <div className="activityHead"><span>TIME</span><span>AGENT</span><span>ACTION</span><span>TARGET</span></div>
          {data.activity.length === 0 && <Empty text="Tool activity will appear here as it happens." />}
          {data.activity.slice(0, 12).map((event) => (
            <div className="activityRow" key={event.id}>
              <time>{shortTime(event.timestamp)}</time>
              <span className="actor"><i />{event.actor}</span>
              <strong>{event.tool}</strong>
              <span className="target" title={event.detail}>{event.detail || "—"}</span>
            </div>
          ))}
        </div>
      </section>

      <footer>
        <span>{viewingHistory ? "Historical transcript · Read-only" : "Local-only observer · Read-only"}</span>
        <span>{viewingHistory ? "Archived session view" : paused ? "Updates paused" : lastRefresh ? `Updated ${relativeTime(lastRefresh.toISOString())}` : "Connecting…"}</span>
      </footer>
      </main>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty"><span>·</span>{text}</div>;
}
