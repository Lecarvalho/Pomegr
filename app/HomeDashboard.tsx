"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { HomeProjectSummary, HomeSessionSummary, HomeSnapshot } from "../shared/monitor-contract";
import { encodeSessionRoute } from "../shared/session-route.mjs";
import { CloseButton } from "./components/CloseButton";
import { PomegrBrand } from "./components/PomegrBrand";
import { ProviderBadge } from "./components/ProviderBadge";
import { SessionRelativeTimeText } from "./components/LiveTime";
import { ThemeToggle } from "./components/ThemeToggle";
import { LiveClockProvider } from "./hooks/LiveClockContext";

const EMPTY: HomeSnapshot = { generatedAt: null, projects: [] };

function number(value: number | null) { if (!Number.isFinite(value)) return "—"; return new Intl.NumberFormat(undefined, { notation: value! >= 10_000 ? "compact" : "standard", maximumFractionDigits: 0 }).format(value!); }
function duration(value: number | null) { if (!Number.isFinite(value)) return "—"; const minutes = Math.floor(value! / 60_000); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
function chartPath(values: number[], options: { width?: number; top?: number; bottom?: number; left?: number; right?: number; stepped?: boolean } = {}) {
  if (values.length < 2) return "";
  const { width = 360, top = 4, bottom = 68, left = 0, right = width, stepped = false } = options;
  const max = Math.max(...values, 1); const coords = values.map((value, index) => ({ x: left + (index / Math.max(values.length - 1, 1)) * (right - left), y: bottom - (Math.max(0, value) / max) * (bottom - top) }));
  return coords.map((point, index) => { if (index === 0) return `M${point.x.toFixed(1)} ${point.y.toFixed(1)}`; const previous = coords[index - 1]; return stepped ? `L${point.x.toFixed(1)} ${previous.y.toFixed(1)}L${point.x.toFixed(1)} ${point.y.toFixed(1)}` : `L${point.x.toFixed(1)} ${point.y.toFixed(1)}`; }).join(" ");
}

function agentSummary(session: HomeSessionSummary) {
  if (session.agentCount === null) return "agents unavailable";
  if (session.activeAgentCount === null) return `${session.agentCount} ${session.agentCount === 1 ? "agent" : "agents"}`;
  return `${session.activeAgentCount}/${session.agentCount} agents`;
}

function domId(value: string) { return value.replace(/[^a-zA-Z0-9_-]/g, "-"); }

function ContextFigure({ history, id }: { history: HomeSessionSummary["contextHistory"]; id: string }) {
  const buckets = history?.buckets?.filter((bucket) => Number.isFinite(bucket.total)).slice(-48) || [];
  if (buckets.length < 2) return <p className="homeUnavailable">Context history unavailable</p>;
  const titleId = `context-title-${id}`; const descId = `context-desc-${id}`;
  return <figure className="homeFigure"><figcaption><span>Context history</span><strong>{number(buckets.at(-1)?.total ?? null)} latest</strong></figcaption><svg viewBox="0 0 360 72" role="img" aria-labelledby={`${titleId} ${descId}`} preserveAspectRatio="none"><title id={titleId}>Stepped context history</title><desc id={descId}>Actual latest all-agent context level across observed buckets.</desc><path className="homeChartGuide" d="M0 68H360" /><path className="homeChartLine" d={chartPath(buckets.map((bucket) => bucket.total), { stepped: true })} /></svg><div className="homeChartTime"><span>20m ago</span><span>now</span></div></figure>;
}

function ResourceFigure({ session, id }: { session: HomeSessionSummary; id: string }) {
  const samples = session.resources?.samples?.slice(-48) || []; const cpu = samples.map((sample) => sample.cpuMachinePercent).filter((value): value is number => Number.isFinite(value)); const memory = samples.map((sample) => sample.memoryBytes).filter((value): value is number => Number.isFinite(value));
  if (cpu.length < 2 && memory.length < 2) return <p className="homeUnavailable">Resource samples unavailable</p>;
  const titleId = `resource-title-${id}`; const descId = `resource-desc-${id}`; const currentCpu = session.resources?.current?.cpuMachinePercent; const currentMemory = session.resources?.current?.memoryBytes;
  return <figure className="homeFigure homeResourceFigure"><figcaption><span>Resource use · live samples</span><strong>{Number.isFinite(currentCpu) ? `${Math.round(currentCpu!)}%` : "—"} · {Number.isFinite(currentMemory) ? `${Math.round(currentMemory! / 1024 / 1024)} MB` : "—"}</strong></figcaption><svg viewBox="0 0 360 92" role="img" aria-labelledby={`${titleId} ${descId}`} preserveAspectRatio="none"><title id={titleId}>CPU and memory samples</title><desc id={descId}>Separate labeled resource lanes for this live session.</desc><text className="homeChartLabel" x="0" y="22">CPU</text><text className="homeChartLabel" x="0" y="62">MEM</text><path className="homeChartGuide" d="M38 34H360M38 76H360" />{cpu.length > 1 && <path className="homeChartCpu" d={chartPath(cpu, { top: 5, bottom: 30, left: 38, right: 360 })} />}{memory.length > 1 && <path className="homeChartMemory" d={chartPath(memory, { top: 43, bottom: 72, left: 38, right: 360 })} />}</svg><div className="homeChartTime homeResourceTime"><span>20m ago</span><span>now</span></div></figure>;
}

function sessionHref(session: HomeSessionSummary) { try { return `/sessions/${encodeSessionRoute(session.id.includes(":") ? session.id : `${session.provider}:${session.id}`)}`; } catch { return "/"; } }

function SessionCard({ session, index }: { session: HomeSessionSummary; index: number }) {
  const id = `${session.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${index}`;
  return <div className="homeSessionCard"><Link className="homeSessionRow" href={sessionHref(session)} aria-label={`Open ${session.title}`}><span className={`homeLiveDot${session.needsInput ? " needsInput" : ""}`} /><span className="homeSessionCopy"><strong>{session.title}</strong><small><ProviderBadge source={session.source} compact /> · {agentSummary(session)} · <SessionRelativeTimeText value={session.updatedAt} /></small></span><span className={`homeSessionStatus${session.needsInput ? " needsInput" : ""}`}>{session.needsInput ? "Needs input" : "Active"}</span><span className="homeSessionMetrics"><b>{number(session.latestContextTotal)}</b><small>context</small></span></Link><div className="homeSessionGraphs"><ContextFigure history={session.contextHistory} id={id} /><ResourceFigure session={session} id={id} /></div></div>;
}

function ProjectFolio({ project }: { project: HomeProjectSummary }) {
  const sessions = project.sessions || [];
  const projectId = domId(project.project);
  const historyLoading = project.history.status === "loading";
  return (
    <article className="homeFolio">
      <header className="homeFolioHeader"><div><h2>{project.project}</h2><small>Updated <SessionRelativeTimeText value={project.updatedAt} /></small></div><span className="homeLiveCount">{project.liveCount} live</span></header>
      <div className="homeFolioBody">
        <section className="homeLiveSection" aria-labelledby={`live-${projectId}`}>
          <div className="homeSectionHeader"><h3 id={`live-${projectId}`}>Running now</h3><span>{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</span></div>
          {sessions.length ? sessions.map((session, index) => <SessionCard key={session.id} session={session} index={index} />) : <p className="homeUnavailable">No running sessions</p>}
        </section>
        <section className="homeHistory" aria-labelledby={`history-${projectId}`} aria-busy={historyLoading || undefined}>
          <div className="homeSectionHeader"><h3 id={`history-${projectId}`}>7-day history</h3><span>Recorded sessions</span></div>
          {historyLoading
            ? <p className="homeUnavailable" role="status">Loading recorded sessions…</p>
            : <>
              <div className="homeHistoryMetrics"><span><b>{project.history.completed}</b><small>completed</small></span><span><b>{duration(project.history.medianWallTimeMs)}</b><small>median wall time</small></span><span><b>{number(project.history.medianFinalContext)}</b><small>median final context</small></span></div>
              {project.history.finalContexts.length > 1 ? <figure className="homeFigure homeHistoryFigure"><figcaption><span>Final context by session</span><strong>Latest {project.history.finalContexts.length}</strong></figcaption><svg viewBox="0 0 360 72" role="img" aria-label="Final context over the last 7 days" preserveAspectRatio="none"><path className="homeChartGuide" d="M0 68H360" /><path className="homeChartLine" d={chartPath(project.history.finalContexts.map((point) => point.total))} /></svg><div className="homeChartTime"><span>7d ago</span><span>latest</span></div></figure> : <p className="homeUnavailable">Not enough recorded context snapshots</p>}
            </>}
        </section>
      </div>
    </article>
  );
}

export function HomeDashboard() {
  const [snapshot, setSnapshot] = useState<HomeSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const projects = useMemo(() => snapshot.projects || [], [snapshot.projects]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;

    const poll = async () => {
      try {
        const response = await fetch("/api/home", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("offline");
        const next = await response.json() as HomeSnapshot;
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setConnected(true);
          setLoading(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setConnected(false);
          setLoading(false);
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 5_000);
      }
    };

    void poll();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  const liveSessions = projects.flatMap((project) => project.sessions || []);
  return (
    <LiveClockProvider running={connected}>
      <div className="appFrame homeApp">
        {sidebarOpen && <button className="sidebarBackdrop" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close home navigation" />}
        <aside id="home-navigation" className={`sessionSidebar homeSidebar${sidebarOpen ? " open" : ""}`}>
          <div className="sidebarHeader homeSidebarHeader"><CloseButton label="Close home navigation" onClick={() => setSidebarOpen(false)} /></div>
          <nav className="sessionNav">
            <div className="liveHeading"><span>HOME</span><small>{projects.length}</small></div>
            <Link className="liveSessionLink selected" href="/" aria-current="page" onClick={() => setSidebarOpen(false)}>
              <i /><span><strong>Running sessions</strong><small>{liveSessions.length} live across projects</small></span>
            </Link>
            <div className="historyHeading"><span>LIVE SESSIONS</span><small>{liveSessions.length}</small></div>
            <div className="liveSessionList">
              {liveSessions.map((session) => <Link className="liveSessionLink" data-needs-input={session.needsInput || undefined} key={session.id} href={sessionHref(session)} onClick={() => setSidebarOpen(false)}><i /><span><strong>{session.title}</strong><small><ProviderBadge source={session.source} compact /> · {session.project}</small></span></Link>)}
            </div>
          </nav>
        </aside>
        <main className="shell" id="top">
          <header className="topbar">
            <div className="topbarLead">
              <button className="sessionMenuButton" type="button" onClick={() => setSidebarOpen(true)} aria-label="Open home navigation" aria-expanded={sidebarOpen} aria-controls="home-navigation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
              <PomegrBrand href="/" />
            </div>
            <div className="topActions"><span className={`connection ${loading ? "connecting" : connected ? "online" : "offline"}`}><i />{loading ? "Connecting to monitor" : connected ? "Monitor connected" : "Monitor offline"}</span><ThemeToggle /></div>
          </header>
          <section className="homeContent" aria-labelledby="home-heading">
            <div className="homeIntro"><h1 id="home-heading">Running sessions</h1><p>Active work and seven-day history, grouped by project.</p></div>
            {loading && <p className="homeStatus" role="status">Loading the local monitor…</p>}
            {!loading && !connected && <p className="homeStatus" role="status">Home overview is unavailable. Pomegr will reconnect automatically.</p>}
            {!loading && connected && projects.length === 0 && <p className="homeStatus" role="status">No running sessions yet.</p>}
            {projects.map((project) => <ProjectFolio key={project.project} project={project} />)}
          </section>
          <footer><span>Local observer · Read-only · <a href="https://github.com/Lecarvalho/pomegr" target="_blank" rel="noreferrer">Source</a> · <Link href="/about#license">AGPL-3.0-only</Link></span><span>{connected ? "Live updates · 5s" : "Monitor unavailable"}</span></footer>
        </main>
      </div>
    </LiveClockProvider>
  );
}
