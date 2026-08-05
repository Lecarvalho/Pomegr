"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

type Agent = {
  id: string;
  parentId: string | null;
  label: string;
  kind: string;
  model: string;
  effort: string;
  status: "active" | "waiting" | "warm" | "idle";
  toolCalls: number;
  lastSeen: string;
  tokens: {
    total: number;
    cumulative: number;
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    lastMinute: number;
  };
};

type Activity = {
  id: string;
  timestamp: string;
  actor: string;
  tool: string;
  detail: string;
};

type Insight = {
  id: string;
  level: "info" | "warning";
  title: string;
  detail: string;
};

type MonitorState = {
  connected: boolean;
  source: string;
  session: {
    id: string;
    title: string;
    project: string;
    cwd: string;
    repository: {
      available: boolean;
      branch: string;
      files: Array<{ status: string; path: string }>;
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
      total: number;
      cumulative: number;
      allAgents: number;
      input: number;
      output: number;
      cacheWrite: number;
      cacheRead: number;
      lastMinute: number;
    };
  };
  agents: Agent[];
  activity: Activity[];
  insights: Insight[];
  usageLimits: {
    available: boolean;
    fetchedAt: string | null;
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
  session: null,
  score: 100,
  metrics: {
    agents: 0,
    activeAgents: 0,
    toolCalls: 0,
    repeatedCalls: 0,
    tokens: { total: 0, cumulative: 0, allAgents: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, lastMinute: 0 },
  },
  agents: [],
  activity: [],
  insights: [],
  usageLimits: { available: false, fetchedAt: null, limits: [] },
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

function gitStatusLabel(status: string) {
  if (status === "??") return "NEW";
  if (status.includes("D")) return "DEL";
  if (status.includes("R")) return "REN";
  if (status.includes("A")) return "ADD";
  if (status.includes("U")) return "CONFLICT";
  return "MOD";
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

export function Dashboard() {
  const [data, setData] = useState<MonitorState>(EMPTY);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
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
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const interval = window.setInterval(() => {
      if (!paused) refresh();
    }, 1800);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [paused, refresh]);

  const sessionLabel = data.session?.title || "Waiting for a session";
  const ringStyle = {
    background: `conic-gradient(var(--green) ${data.score * 3.6}deg, var(--line) 0deg)`,
  };
  const agentRows = agentTreeRows(data.agents);

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Threadlight home">
          <span className="brandMark"><i /><i /><i /></span>
          <span>Threadlight</span>
        </a>
        <div className="topActions">
          <span className={`connection ${data.connected ? "online" : "offline"}`}>
            <i /> {data.connected ? "Monitor connected" : "Monitor offline"}
          </span>
          <button className="ghostButton" onClick={() => setPaused((value) => !value)}>
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <div className="eyebrow"><span /> LIVE SESSION OBSERVER {data.session ? `· ${data.session.project}` : ""}</div>
          <h1>{sessionLabel}</h1>
          <p>
            Watching Claude Code quietly. Prompt and response text stay out of the dashboard;
            only execution metadata is analyzed.
          </p>
        </div>
        <div className="sessionMeta">
          <span>ELAPSED WALL TIME</span>
          <strong>{data.session ? formatDuration(data.session.durationMs) : "—"}</strong>
          <small>{data.session ? `Last event ${relativeTime(data.session.updatedAt)}` : "Auto-discovery enabled"}</small>
        </div>
      </section>

      {data.error && <div className="notice"><span>!</span>{data.error}</div>}

      {data.session?.repository.available && (
        <section className="panel gitPanel" aria-label="Git working tree">
          <div className="gitSummary">
            <div>
              <span className="label">GIT BRANCH</span>
              <h2>{data.session.repository.branch}</h2>
              <p title={data.session.cwd}>{data.session.project}</p>
            </div>
            <span className={`changeCount ${data.session.repository.files.length ? "dirty" : "clean"}`}>
              {data.session.repository.files.length ? `${data.session.repository.files.length} uncommitted` : "Working tree clean"}
            </span>
          </div>
          {data.session.repository.files.length > 0 && (
            <div className="gitFiles">
              {data.session.repository.files.map((file) => (
                <div className="gitFile" key={`${file.status}-${file.path}`}>
                  <span className={`gitStatus ${gitStatusLabel(file.status).toLowerCase()}`}>{gitStatusLabel(file.status)}</span>
                  <code>{file.path}</code>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="panel limitsPanel" aria-label="Claude usage limits">
        <div className="limitsHeader">
          <div><span className="label">CLAUDE PLAN</span><h2>Usage limits</h2></div>
          <span className="quiet">{data.usageLimits.fetchedAt ? `Checked ${relativeTime(data.usageLimits.fetchedAt)}` : "Connecting…"}</span>
        </div>
        <div className="limitCards">
          {!data.usageLimits.available && <Empty text={data.usageLimits.error || "Usage limits are unavailable."} />}
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
      </section>

      <section className="summaryGrid" aria-label="Session summary">
        <article className="scoreCard panel">
          <div className="scoreRing" style={ringStyle}>
            <div><strong>{data.score}</strong><span>/ 100</span></div>
          </div>
          <div>
            <span className="label">FLOW SCORE</span>
            <h2>{data.score >= 85 ? "Running cleanly" : data.score >= 65 ? "Worth a look" : "Friction detected"}</h2>
            <p>Based on repeated calls, agent overlap, and waiting patterns.</p>
          </div>
        </article>

        <article className="metric panel">
          <span className="metricIcon agentsIcon">⌁</span>
          <div><span className="label">AGENTS</span><strong>{data.metrics.activeAgents}<small> / {data.metrics.agents}</small></strong></div>
          <p>active now</p>
        </article>
        <article className="metric panel">
          <span className="metricIcon toolIcon">⌘</span>
          <div><span className="label">TOOL CALLS</span><strong>{data.metrics.toolCalls}</strong></div>
          <p>in this session</p>
        </article>
        <article className="metric panel">
          <span className={`metricIcon ${data.metrics.repeatedCalls ? "warnIcon" : "clearIcon"}`}>↻</span>
          <div><span className="label">REPEATS</span><strong>{data.metrics.repeatedCalls}</strong></div>
          <p>possible loops</p>
        </article>
      </section>

      <section className="panel tokenPanel" aria-label="Live token consumption">
        <div className="tokenLead">
          <div className="pulseBars" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <div>
            <span className="label">LIVE CONTEXT USE</span>
            <strong>{compactNumber(data.metrics.tokens.total)}</strong>
            <p>latest primary-agent snapshot · +{compactNumber(data.metrics.tokens.lastMinute)} in the last 60 sec</p>
          </div>
        </div>
        <div className="tokenStat">
          <span>Current input</span>
          <strong>{compactNumber(data.metrics.tokens.input)}</strong>
        </div>
        <div className="tokenStat">
          <span>Current cache write</span>
          <strong>{compactNumber(data.metrics.tokens.cacheWrite)}</strong>
        </div>
        <div className="tokenStat">
          <span>Current cache read</span>
          <strong>{compactNumber(data.metrics.tokens.cacheRead)}</strong>
        </div>
        <div className="tokenStat outputTokens">
          <span>Current output</span>
          <strong>{compactNumber(data.metrics.tokens.output)}</strong>
        </div>
        <div className="tokenRate">
          <span>ALL-AGENT CONTEXT</span>
          <strong>{compactNumber(data.metrics.tokens.allAgents)}</strong>
          <small>sum of latest agent snapshots</small>
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
                className={`agentRow ${depth > 0 ? "childAgent" : "rootAgent"} ${agent.status}Agent`}
                key={agent.id}
                style={{ "--agent-indent": `${Math.min(depth, 8) * 20}px` } as CSSProperties}
              >
                <div className="treeRail"><span className={agent.id === "primary" ? "primaryNode" : "agentNode"} /></div>
                <div className="agentIdentity">
                  <strong>{agent.label}</strong>
                  <span>{agent.kind} · {agent.model} · {agent.effort} effort · {agent.toolCalls} tools</span>
                </div>
                <div className="agentTokens">
                  <strong>{compactNumber(agent.tokens.total)}</strong>
                  <span>current context</span>
                </div>
                <span className={`statusPill ${agent.status}`}><i />{agent.status}</span>
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
          <div><span className="label">EVENT STREAM</span><h2>Recent tool activity</h2></div>
          <button className="textButton" onClick={refresh} disabled={loading}>Refresh now</button>
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
        <span>Local-only observer · Read-only</span>
        <span>{paused ? "Updates paused" : lastRefresh ? `Updated ${relativeTime(lastRefresh.toISOString())}` : "Connecting…"}</span>
      </footer>
    </main>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty"><span>·</span>{text}</div>;
}
