"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { HomeLimitActivity, HomeProviderUsageLimits, HomeSessionSummary, HomeSnapshot } from "../shared/monitor-contract";
import { encodeSessionRoute } from "../shared/session-route.mjs";
import { usageLimitSeverity } from "../shared/usage-limit-severity.mjs";
import { NavigationMenuButton } from "./components/NavigationMenuButton";
import { PomegrBrand } from "./components/PomegrBrand";
import { ProviderBadge } from "./components/ProviderBadge";
import { MinuteRelativeTimeText, SessionRelativeTimeText } from "./components/LiveTime";
import { ThemeToggle } from "./components/ThemeToggle";
import { LiveClockProvider } from "./hooks/LiveClockContext";

const EMPTY: HomeSnapshot = { generatedAt: null, providerLimits: [], limitActivities: [], projects: [] };

function number(value: number | null) { if (!Number.isFinite(value)) return "—"; return new Intl.NumberFormat(undefined, { notation: value! >= 10_000 ? "compact" : "standard", maximumFractionDigits: 0 }).format(value!); }
function agentSummary(session: HomeSessionSummary) {
  if (session.agentCount === null) return "agents unavailable";
  if (session.activeAgentCount === null) return `${session.agentCount} ${session.agentCount === 1 ? "agent" : "agents"}`;
  return `${session.activeAgentCount}/${session.agentCount} agents`;
}

function limitTime(value: string | null) {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return "time unavailable";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function projectRequestGroups(sessions: HomeLimitActivity["sessions"]) {
  const projects = new Map<string, {
    project: string;
    requestObservations: Array<HomeLimitActivity["sessions"][number]["requestObservations"][number] & { sessionId: string }>;
    hasLiveWork: boolean;
  }>();

  for (const session of sessions) {
    const existing = projects.get(session.project) || { project: session.project, requestObservations: [], hasLiveWork: false };
    existing.hasLiveWork ||= session.isLive;
    existing.requestObservations.push(...session.requestObservations.map((observation) => ({ ...observation, sessionId: session.id })));
    projects.set(session.project, existing);
  }

  return [...projects.values()]
    .filter((project) => project.requestObservations.length > 0)
    .sort((left, right) => left.project.localeCompare(right.project));
}

function LimitRequestTicks({ activity }: { activity: HomeLimitActivity }) {
  const projects = projectRequestGroups(activity.sessions || []);
  const requests = projects.flatMap((project) => project.requestObservations.map((observation) => ({ ...observation, project: project.project })));
  const observedSessionIds = new Set(requests.map((observation) => observation.sessionId));
  const coverageReasons = [
    activity.partialCoverage ? "observations may begin after the window started" : null,
    activity.eventsTruncated ? "session activity evidence is bounded to a recent window" : null,
  ].filter((reason): reason is string => Boolean(reason));
  if (!requests.length && !coverageReasons.length) return null;

  const startMs = Date.parse(activity.windowStartsAt);
  const resetMs = activity.resetsAt ? Date.parse(activity.resetsAt) : NaN;
  const generatedMs = Date.parse(activity.generatedAt);
  const endMs = Number.isFinite(resetMs) && resetMs > startMs ? resetMs : generatedMs;
  const rangeMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? endMs - startMs : 0;
  const position = (observedAt: string) => {
    const observedMs = Date.parse(observedAt);
    if (!rangeMs || !Number.isFinite(observedMs)) return 0.4;
    return Math.min(99.6, Math.max(0.4, ((observedMs - startMs) / rangeMs) * 100));
  };
  const projectLabel = `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
  const observationLabel = `${requests.length} activity ${requests.length === 1 ? "observation" : "observations"}`;
  const sessionLabel = `${observedSessionIds.size} ${observedSessionIds.size === 1 ? "session" : "sessions"}`;
  const detailsLabel = requests.length ? projectLabel : "About activity";
  const observedShare = (count: number) => {
    const percent = (count / observedSessionIds.size) * 100;
    return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
  };

  return (
    <>
      {requests.length > 0 && <span className="homeLimitRequestTicks" role="img" aria-label={`Local session activity for ${activity.label}, ${activity.window}: ${observationLabel} across ${sessionLabel} and ${projectLabel}.`}>
        {requests.map((observation) => <b aria-hidden="true" key={`${observation.sessionId}-${observation.id}`} style={{ left: `${position(observation.observedAt)}%` }} title={`${observation.project} · session activity observed at ${limitTime(observation.observedAt)}`} />)}
      </span>}
      <details className="homeLimitProjects">
        <summary aria-label={requests.length ? `Show ${projectLabel} observed during the ${activity.window} window` : `Show observation details for the ${activity.window} window`}>{detailsLabel}</summary>
        <div className="homeLimitProjectsPanel" role="group" aria-label={requests.length ? `Observed project sessions for ${activity.label}, ${activity.window}` : `Session activity details for ${activity.label}, ${activity.window}`}>
          <strong className="homeLimitProjectsTitle">{requests.length ? "Observed project sessions" : "About session activity"}</strong>
          {requests.length > 0 && <ul>
            {projects.map((project) => {
              const sessionCount = new Set(project.requestObservations.map((observation) => observation.sessionId)).size;
              return <li key={project.project}>
                <strong>{project.project}</strong>
                <span>{sessionCount} {sessionCount === 1 ? "session" : "sessions"} · {observedShare(sessionCount)}</span>
              </li>;
            })}
          </ul>}
          <p>
            Usage is account-level; session activity is correlation evidence, not attribution or billing.
            {coverageReasons.length > 0 && <> Coverage is partial: {coverageReasons.join(", and ")}.</>}
          </p>
        </div>
      </details>
    </>
  );
}

function HomeUsageLimits({ providers, activities }: { providers: HomeProviderUsageLimits[]; activities: HomeLimitActivity[] }) {
  if (!providers.length) return null;
  return (
    <section className="homeLimits" aria-labelledby="home-limits-heading">
      <header className="homeLimitsHeader">
        <h2 id="home-limits-heading">Usage &amp; activity</h2>
        <span>Provider-reported usage · local session activity</span>
      </header>
      <div className="homeProviderLimits">
        {providers.map(({ provider, source, usageLimits }) => {
          const needsSignIn = /returned 401\b/i.test(usageLimits.error || "");
          return (
            <article className="homeProviderLimit" key={provider}>
              <header>
                <ProviderBadge source={source} />
                <small>{needsSignIn
                  ? "Sign-in needed"
                  : usageLimits.available && usageLimits.error
                    ? "Refresh delayed"
                    : usageLimits.fetchedAt
                      ? <>Updated <MinuteRelativeTimeText value={usageLimits.fetchedAt} /></>
                      : "Unavailable"}</small>
              </header>
              {usageLimits.limits.length ? (
                <div className="homeLimitList">
                  {usageLimits.limits.map((limit) => {
                    const percent = Math.min(100, Math.max(0, limit.percent));
                    const activity = activities.find((item) => item.provider === provider && item.limitId === limit.id);
                    const showCollectingStatus = activity?.status === "collecting";
                    return (
                      <div className="homeLimitEntry" key={limit.id}>
                        <div className={`homeLimitRow ${usageLimitSeverity(percent)}`} aria-label={`${limit.label}, ${limit.window}, ${Math.round(limit.percent)}% used${limit.active ? ", active limit" : ""}`}>
                          <span><strong>{limit.label}</strong><small>{limit.window}{limit.active ? " · active" : ""}</small></span>
                          <div className="homeLimitTrackStack">
                            <i className="homeLimitTrack" aria-hidden="true"><b style={{ width: `${percent}%` }} /></i>
                            {activity && <LimitRequestTicks activity={activity} />}
                          </div>
                          <em>{Math.round(limit.percent)}%</em>
                        </div>
                        {showCollectingStatus && <div className="homeLimitActivityInline">
                          <p className="homeLimitActivityStatus" role="status">Collecting account observations.</p>
                        </div>}
                      </div>
                    );
                  })}
                </div>
              ) : <p>{needsSignIn ? `Sign in to ${source} again to refresh limits.` : usageLimits.error || "Plan usage is not available."}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function sessionHref(session: HomeSessionSummary) { try { return `/sessions/${encodeSessionRoute(session.id.includes(":") ? session.id : `${session.provider}:${session.id}`)}`; } catch { return "/"; } }

function SessionCard({ session }: { session: HomeSessionSummary }) {
  const progress = session.progress;
  const showEta = progress && !session.needsInput && progress.phase !== "blocked" && progress.phase !== "complete" && progress.remainingMinutesMin !== undefined;
  const eta = showEta ? `ETA ${progress.remainingMinutesMin}${progress.remainingMinutesMax !== undefined && progress.remainingMinutesMax !== progress.remainingMinutesMin ? `–${progress.remainingMinutesMax}` : ""} min` : null;
  return <div className="homeSessionCard"><Link className="homeSessionRow" href={sessionHref(session)} aria-label={`Open ${session.title} · ${session.project} · ${session.source}`}><span className={`homeLiveDot${session.needsInput ? " needsInput" : ""}`} /><span className="homeSessionCopy"><strong>{session.title}</strong><small><span className="homeSessionProject">{session.project}</span> · <ProviderBadge source={session.source} compact /> · {agentSummary(session)} · <SessionRelativeTimeText value={session.updatedAt} /></small></span><span className={`homeSessionStatus${session.needsInput ? " needsInput" : ""}`}>{session.needsInput ? "Needs input" : "Active"}</span><span className="homeSessionMetrics"><b>{number(session.latestContextTotal)}</b><small>context</small></span></Link>{progress && <div className={`homeSessionProgress homeSessionProgress-${progress.phase}`}><div><strong>{progress.phase}</strong><b>{progress.percent}%</b></div><progress max={100} value={progress.percent} aria-label="Agent-reported session progress" aria-valuetext={`${progress.percent}% complete · ${progress.phase}`} />{eta && <small>{eta}</small>}</div>}</div>;
}

export function HomeDashboard() {
  const [snapshot, setSnapshot] = useState<HomeSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const sessions = useMemo(() => (snapshot.projects || []).flatMap((project) => project.sessions || []), [snapshot.projects]);

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

  return (
    <LiveClockProvider running={connected}>
      <main className="shell homeApp" id="top">
          <header className="topbar">
            <div className="topbarLead">
              <NavigationMenuButton />
              <PomegrBrand href="/" />
            </div>
            <div className="topActions"><span className={`connection ${loading ? "connecting" : connected ? "online" : "offline"}`}><i />{loading ? "Connecting to monitor" : connected ? "Monitor connected" : "Monitor offline"}</span><ThemeToggle /></div>
          </header>
          <section className="homeContent" aria-labelledby="home-heading">
            <div className="homeIntro"><h1 id="home-heading">Running sessions</h1><p>Active work across every project.</p></div>
            {loading && <p className="homeStatus" role="status">Loading the local monitor…</p>}
            {!loading && !connected && <p className="homeStatus" role="status">Home overview is unavailable. Pomegr will reconnect automatically.</p>}
            {!loading && connected && sessions.length === 0 && <p className="homeStatus" role="status">No running sessions yet.</p>}
            {!loading && connected && <HomeUsageLimits providers={snapshot.providerLimits || []} activities={snapshot.limitActivities || []} />}
            {!loading && connected && sessions.length > 0 && <section className="homeLiveGrid" aria-labelledby="home-live-heading"><div className="homeSectionHeader"><h2 id="home-live-heading">Running now</h2><span>{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</span></div><div className="homeSessionGrid">{sessions.map((session) => <SessionCard key={session.id} session={session} />)}</div></section>}
          </section>
          <footer><span>Local observer · Read-only · <a href="https://github.com/Lecarvalho/pomegr" target="_blank" rel="noreferrer">Source</a> · <Link href="/about#license">AGPL-3.0-only</Link></span><span>{connected ? "Live updates · 5s" : "Monitor unavailable"}</span></footer>
      </main>
    </LiveClockProvider>
  );
}
