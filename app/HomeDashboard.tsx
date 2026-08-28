"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HomeAggregateSnapshot, HomeLimitActivity, HomeProviderUsageLimits, LiveSessionSummary, Readiness } from "../shared/monitor-contract";
import { encodeSessionRoute } from "../shared/session-route.mjs";
import { usageLimitSeverity } from "../shared/usage-limit-severity.mjs";
import { NavigationMenuButton } from "./components/NavigationMenuButton";
import { AnimatedProgressBar, useAnimatedProgressValue } from "./components/AnimatedProgress";
import { PomegrBrand } from "./components/PomegrBrand";
import { ProviderBadge } from "./components/ProviderBadge";
import { MinuteRelativeTimeText, SessionRelativeTimeText } from "./components/LiveTime";
import { ThemeToggle } from "./components/ThemeToggle";
import { LiveClockProvider } from "./hooks/LiveClockContext";
import { useSessionCatalog } from "./hooks/SessionCatalogContext";
import { useUsageLimits } from "./usage-limits-client";

const EMPTY: HomeAggregateSnapshot = { generatedAt: null, providerLimits: [], limitActivities: [] };
const HOME_AGGREGATE_POLL_MS = 30_000;

function number(value: number | null) { if (!Number.isFinite(value)) return "—"; return new Intl.NumberFormat(undefined, { notation: value! >= 10_000 ? "compact" : "standard", maximumFractionDigits: 0 }).format(value!); }
function agentSummary(session: LiveSessionSummary) {
  if (session.agentCount === null) return "agents unavailable";
  if (session.activeAgentCount === null) return `${session.agentCount} ${session.agentCount === 1 ? "agent" : "agents"}`;
  return `${session.activeAgentCount}/${session.agentCount} agents`;
}

function InlineSkeleton({ className = "" }: { className?: string }) {
  return <span className={`uiSkeleton ${className}`.trim()} aria-hidden="true" />;
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

function LimitRequestTicks({ activity, percent }: { activity: HomeLimitActivity; percent: number }) {
  const projects = projectRequestGroups(activity.sessions || []);
  const requests = projects.flatMap((project) => project.requestObservations.map((observation) => ({ ...observation, project: project.project })));
  const observedSessionIds = new Set(requests.map((observation) => observation.sessionId));
  const modelScoped = activity.scope === "model";
  const coverageReasons = [
    activity.partialCoverage ? "observations may begin after the window started" : null,
    activity.eventsTruncated ? `${modelScoped ? "request" : "session"} activity evidence is bounded to a recent window` : null,
  ].filter((reason): reason is string => Boolean(reason));
  const showDetails = requests.length > 0 || coverageReasons.length > 0;
  if (!showDetails) return null;

  const startMs = Date.parse(activity.windowStartsAt);
  const generatedMs = Date.parse(activity.generatedAt);
  const rangeMs = Number.isFinite(startMs) && Number.isFinite(generatedMs) && generatedMs > startMs ? generatedMs - startMs : 0;
  const position = (observedAt: string) => {
    const observedMs = Date.parse(observedAt);
    if (!rangeMs || !Number.isFinite(observedMs)) return 0.4;
    return Math.min(99.6, Math.max(0.4, ((observedMs - startMs) / rangeMs) * 100));
  };
  const projectLabel = `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
  const observationLabel = modelScoped
    ? `${requests.length} request ${requests.length === 1 ? "observation" : "observations"}`
    : `${requests.length} activity ${requests.length === 1 ? "observation" : "observations"}`;
  const sessionLabel = `${observedSessionIds.size} ${observedSessionIds.size === 1 ? "session" : "sessions"}`;
  const detailsLabel = requests.length ? projectLabel : "About activity";
  const activityDescription = modelScoped
    ? `Local request activity for ${activity.label}, ${activity.window}: ${observationLabel} across ${projectLabel}.`
    : `Local session activity for ${activity.label}, ${activity.window}: ${observationLabel} across ${sessionLabel} and ${projectLabel}.`;

  return (
    <>
      {requests.length > 0 && <span className="homeLimitRequestTicks" role="img" aria-label={activityDescription}>
        <span className="homeLimitRequestTimeline" style={{ width: `${percent}%` }}>
          {requests.map((observation) => <b aria-hidden="true" key={`${observation.sessionId}-${observation.id}`} style={{ left: `${position(observation.observedAt)}%` }} title={modelScoped ? `${observation.project} · ${activity.label} request observed at ${limitTime(observation.observedAt)}` : `${observation.project} · session activity observed at ${limitTime(observation.observedAt)}`} />)}
        </span>
      </span>}
      <details className="homeLimitProjects">
        <summary aria-label={requests.length ? `Show ${projectLabel} observed during the ${activity.window} window` : `Show observation details for the ${activity.window} window`}>{detailsLabel}</summary>
        <div className="homeLimitProjectsPanel" role="group" aria-label={requests.length ? (modelScoped ? `Observed ${activity.label} activity by project, ${activity.window}` : `Observed project sessions for ${activity.label}, ${activity.window}`) : `${modelScoped ? activity.label : "Session"} activity details for ${activity.window}`}>
          <strong className="homeLimitProjectsTitle">{requests.length ? (modelScoped ? `Observed ${activity.label} activity` : "Observed project sessions") : `About ${modelScoped ? activity.label : "session"} activity`}</strong>
          {requests.length > 0 && <ul>
            {projects.map((project) => {
              const sessionCount = new Set(project.requestObservations.map((observation) => observation.sessionId)).size;
              const observedCount = modelScoped ? project.requestObservations.length : sessionCount;
              const observedUnit = modelScoped ? (observedCount === 1 ? "request" : "requests") : (observedCount === 1 ? "session" : "sessions");
              return <li key={project.project}>
                <strong>{project.project}</strong>
                <span>{observedCount} {observedUnit}</span>
              </li>;
            })}
          </ul>}
          <p>
            {modelScoped ? `${activity.label} usage is account-level; request activity is correlation evidence, not attribution or billing.` : "Usage is account-level; session activity is correlation evidence, not attribution or billing."}
            {coverageReasons.length > 0 && <> Coverage is partial: {coverageReasons.join(", and ")}.</>}
          </p>
        </div>
      </details>
    </>
  );
}

function HomeUsageLimits({ providers, activities, readiness }: { providers: HomeProviderUsageLimits[]; activities: HomeLimitActivity[]; readiness?: HomeAggregateSnapshot["readiness"] }) {
  const loadingProviders = (Object.entries(readiness?.providerLimits || {}) as Array<[string, Readiness]>).filter(([, status]) => status === "loading").map(([provider]) => provider);
  if (!providers.length && !loadingProviders.length) return null;
  return (
    <section className="homeLimits" aria-labelledby="home-limits-heading" aria-busy={loadingProviders.length > 0}>
      <header className="homeLimitsHeader">
        <h2 id="home-limits-heading">Usage &amp; activity</h2>
        <span>Provider-reported usage · local session activity</span>
      </header>
      <div className="homeProviderLimits">
        {loadingProviders.map((provider) => <article className="homeProviderLimit homeProviderLimit-loading" key={`loading-${provider}`} aria-hidden="true"><header><InlineSkeleton className="skeletonProvider" /><InlineSkeleton className="skeletonMeta" /></header><div className="homeLimitList"><div className="homeLimitRow"><span><InlineSkeleton className="skeletonLabel" /><InlineSkeleton className="skeletonSubLabel" /></span><span className="homeLimitTrackStack"><InlineSkeleton className="skeletonTrack" /><InlineSkeleton className="skeletonActivity" /></span><InlineSkeleton className="skeletonPercent" /></div></div></article>)}
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
                    const activityLoading = readiness?.limitActivity[`${provider}:${limit.id}`] === "loading";
                    return (
                      <div className="homeLimitEntry" key={limit.id}>
                        <div className={`homeLimitRow ${usageLimitSeverity(percent)}`} aria-label={`${limit.label}, ${limit.window}, ${Math.round(limit.percent)}% used${limit.active ? ", active limit" : ""}`}>
                          <span><strong>{limit.label}</strong><small>{limit.window}{limit.active ? " · active" : ""}</small></span>
                          <div className="homeLimitTrackStack">
                            <i className="homeLimitTrack" aria-hidden="true"><b style={{ width: `${percent}%` }} /></i>
                            {activity ? <LimitRequestTicks activity={activity} percent={percent} /> : activityLoading ? <span className="homeLimitActivitySkeleton" aria-hidden="true"><InlineSkeleton className="skeletonActivity" /></span> : null}
                          </div>
                          <em>{Math.round(limit.percent)}%</em>
                        </div>
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

function sessionHref(session: LiveSessionSummary) { try { return `/sessions/${encodeSessionRoute(session.id.includes(":") ? session.id : `${session.provider}:${session.id}`)}`; } catch { return "/"; } }

function sessionActivity(session: LiveSessionSummary) {
  if (session.needsInput || session.activityStatus === "needs_input") return { label: "Needs input", className: "needsInput" };
  if (session.activityStatus === "working") return { label: "Working now", className: "working" };
  if (session.activityStatus === "idle") return { label: "Idle", className: "idle" };
  return { label: "Open", className: "unknown" };
}

function isActiveSession(session: LiveSessionSummary) {
  return session.needsInput || session.activityStatus === "needs_input" || session.activityStatus === "working";
}

function HomeSessionProgress({ session, progress }: { session: LiveSessionSummary; progress: NonNullable<LiveSessionSummary["progress"]> }) {
  const displayedPercent = useAnimatedProgressValue(progress.percent, "compact");
  const showEta = !session.needsInput && progress.phase !== "blocked" && progress.phase !== "complete" && progress.remainingMinutesMin !== undefined;
  const eta = showEta ? `ETA ${progress.remainingMinutesMin}${progress.remainingMinutesMax !== undefined && progress.remainingMinutesMax !== progress.remainingMinutesMin ? `–${progress.remainingMinutesMax}` : ""} min` : null;

  return (
    <div className={`homeSessionProgress homeSessionProgress-${progress.phase}`}>
      <div>
        <strong>{progress.phase}</strong>
        <b aria-hidden="true">{Math.round(displayedPercent)}%</b>
      </div>
      <AnimatedProgressBar
        value={progress.percent}
        displayedValue={displayedPercent}
        label="Agent-reported session progress"
        valueText={`${progress.percent}% complete · ${progress.phase}`}
        motion="compact"
        blocked={progress.phase === "blocked"}
      />
      {eta && <small>{eta}</small>}
    </div>
  );
}

function SessionCard({ session, readiness }: { session: LiveSessionSummary; readiness?: Readiness }) {
  const progress = session.progress;
  const activity = sessionActivity(session);
  const summaryLoading = readiness === "loading";
  return <div className={`homeSessionCard ${activity.className}`}><Link className="homeSessionRow" href={sessionHref(session)} aria-label={`Open ${session.title} · ${session.project} · ${session.source} · ${activity.label}`}><span className={`homeLiveDot ${activity.className}`} /><span className="homeSessionCopy"><strong>{session.title}</strong><small><span className="homeSessionProject">{session.project}</span> · <ProviderBadge source={session.source} compact /> · {summaryLoading && session.agentCount === null ? <InlineSkeleton className="skeletonTiny" /> : agentSummary(session)} · <SessionRelativeTimeText value={session.updatedAt} /></small></span><span className={`homeSessionStatus ${activity.className}`}>{activity.label}</span><span className="homeSessionMetrics"><b>{summaryLoading && session.latestContextTotal === null ? <InlineSkeleton className="skeletonMetric" /> : number(session.latestContextTotal)}</b><small>context</small></span></Link>{progress && <HomeSessionProgress session={session} progress={progress} />}</div>;
}

function SessionSection({ id, title, sessions, readiness }: { id: string; title: string; sessions: LiveSessionSummary[]; readiness?: Record<string, Readiness> }) {
  if (!sessions.length) return null;
  return <section className="homeLiveGrid" aria-labelledby={id}><div className="homeSectionHeader"><h2 id={id}>{title}</h2><span>{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</span></div><div className="homeSessionGrid">{sessions.map((session) => <SessionCard key={session.id} session={session} readiness={readiness?.[session.id]} />)}</div></section>;
}

function HomeCatalogSkeleton() {
  return <div className="homeSessionGrid homeCatalogSkeleton" aria-hidden="true">{[0, 1, 2, 3, 4].map((key) => <div className="homeSessionCard" key={key}><div className="homeSessionSkeletonTitle"><InlineSkeleton /></div><InlineSkeleton className="homeSessionSkeletonMeta" /><InlineSkeleton className="homeSessionSkeletonStatus" /><div className="homeSessionSkeletonMetric"><InlineSkeleton /></div></div>)}</div>;
}

export function HomeDashboard() {
  const [snapshot, setSnapshot] = useState<HomeAggregateSnapshot>(EMPTY);
  const [aggregateLoading, setAggregateLoading] = useState(true);
  const [aggregateConnected, setAggregateConnected] = useState(true);
  const [aggregateReadiness, setAggregateReadiness] = useState<HomeAggregateSnapshot["readiness"]>();
  const sharedUsage = useUsageLimits();
  const { liveSessions, loading: catalogLoading, connected: catalogConnected } = useSessionCatalog();
  const sessions = liveSessions;
  const sessionCountRef = useRef(sessions.length);
  useEffect(() => { sessionCountRef.current = sessions.length; }, [sessions.length]);
  const activeSessions = useMemo(() => sessions.filter(isActiveSession), [sessions]);
  const idleSessions = useMemo(() => sessions.filter((session) => !isActiveSession(session)), [sessions]);
  const usageRevisionMatches = snapshot.providerLimitRevision === null
    || snapshot.providerLimitRevision === undefined
    || String(snapshot.providerLimitRevision) === String(sharedUsage.revision);
  const usageReadiness = {
    ...(aggregateReadiness || {
      catalog: catalogLoading ? "loading" as const : "ready" as const,
      providerLimits: {},
      limitActivity: {},
      sessionSummaries: {},
    }),
    providerLimits: sharedUsage.readiness,
    limitActivity: usageRevisionMatches
      ? aggregateReadiness?.limitActivity || {}
      : Object.fromEntries(sharedUsage.providers.flatMap((entry) => entry.usageLimits.limits.map((limit) => [
        `${entry.provider}:${limit.id}`,
        "loading" as const,
      ]))),
  };

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;
    let inFlight = false;
    let retryAttempt = 0;
    let focusListener: (() => void) | null = null;
    let visibilityListener: (() => void) | null = null;
    const revisionRef = { current: null as number | string | null };
    const readinessRef = { current: undefined as HomeAggregateSnapshot["readiness"] };
    const explicitReadinessRef = { current: false };
    const schedule = (delay: number) => { if (controller.signal.aborted) return; if (timer !== null) window.clearTimeout(timer); timer = window.setTimeout(() => { timer = null; void poll(); }, delay); };

    const poll = async () => {
      if (controller.signal.aborted || inFlight) return;
      inFlight = true;
      let succeeded = false;
      try {
        const query = revisionRef.current === null ? "" : `?revision=${encodeURIComponent(String(revisionRef.current))}`;
        const response = await fetch(`/api/home${query}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("offline");
        if (response.status === 204) { succeeded = true; return; }
        const next = await response.json() as HomeAggregateSnapshot;
        if (!controller.signal.aborted) {
          setSnapshot(next);
          const nextReadiness = next.readiness;
          explicitReadinessRef.current = Boolean(nextReadiness);
          readinessRef.current = nextReadiness;
          if (nextReadiness) setAggregateReadiness(nextReadiness);
          const headerRevision = response.headers?.get?.("x-pomegr-revision");
          if (typeof next.revision === "number" || typeof next.revision === "string") revisionRef.current = next.revision;
          else if (headerRevision) revisionRef.current = headerRevision;
          setAggregateConnected(true);
          setAggregateLoading(false);
          succeeded = true;
        }
      } catch {
        if (!controller.signal.aborted) {
          setAggregateConnected(false);
          setAggregateLoading(false);
        }
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) {
          if (succeeded) retryAttempt = 0;
          const readiness = readinessRef.current;
          const unresolved = readiness
            ? [
                ...Object.values(readiness.providerLimits || {}),
                ...Object.values(readiness.limitActivity || {}),
                ...Object.values(readiness.sessionSummaries || {}),
                readiness.catalog,
              ].some((value) => value === "loading")
            : false;
          const delay = succeeded
            ? (document.hidden ? 30_000 : explicitReadinessRef.current ? (unresolved ? 1_000 : sessionCountRef.current ? 5_000 : 30_000) : HOME_AGGREGATE_POLL_MS)
            : [2_000, 5_000, 10_000, 30_000][Math.min(retryAttempt++, 3)];
          schedule(delay);
        }
      }
    };

    focusListener = () => { if (!document.hidden) void poll(); };
    visibilityListener = () => { if (!document.hidden) void poll(); };
    window.addEventListener("focus", focusListener);
    document.addEventListener("visibilitychange", visibilityListener);
    void poll();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
      if (focusListener) window.removeEventListener("focus", focusListener);
      if (visibilityListener) document.removeEventListener("visibilitychange", visibilityListener);
    };
  }, []);

  return (
    <LiveClockProvider running={catalogConnected}>
      <main className="shell homeApp" id="top">
          <header className="topbar">
            <div className="topbarLead">
              <NavigationMenuButton />
              <PomegrBrand href="/" />
            </div>
            <div className="topActions"><span className={`connection ${catalogLoading ? "connecting" : catalogConnected ? "online" : "offline"}`}><i />{catalogLoading ? "Connecting to monitor" : catalogConnected ? "Monitor connected" : "Monitor offline"}</span><ThemeToggle /></div>
          </header>
          <section className="homeContent" aria-labelledby="home-heading" aria-busy={catalogLoading || aggregateLoading}>
            <div className="homeIntro"><h1 id="home-heading">Open sessions</h1><p>Current agent work and open sessions across every project.</p></div>
            {catalogLoading && !sessions.length && <p className="srOnly" role="status">Loading open sessions from the local monitor.</p>}
            {catalogLoading && !sessions.length && <HomeCatalogSkeleton />}
            {!catalogLoading && !catalogConnected && <p className="homeStatus" role="status">Open sessions are unavailable. Pomegr will reconnect automatically.</p>}
            {!catalogLoading && catalogConnected && sessions.length === 0 && <p className="homeStatus" role="status">No open sessions yet.</p>}
            {!aggregateLoading && !aggregateConnected && <p className="homeStatus" role="status">Usage and activity overview is unavailable. Pomegr will retry automatically.</p>}
            <HomeUsageLimits providers={sharedUsage.providers} activities={usageRevisionMatches ? snapshot.limitActivities || [] : []} readiness={usageReadiness} />
            {!catalogLoading && sessions.length > 0 && <><SessionSection id="home-active-heading" title="Active now" sessions={activeSessions} readiness={aggregateReadiness?.sessionSummaries} /><SessionSection id="home-idle-heading" title="Open · Idle" sessions={idleSessions} readiness={aggregateReadiness?.sessionSummaries} /></>}
          </section>
          <footer><span>Local observer · Read-only · <a href="https://github.com/Lecarvalho/pomegr" target="_blank" rel="noreferrer">Source</a> · <Link href="/about#license">AGPL-3.0-only</Link></span><span>{catalogLoading ? "Connecting…" : catalogConnected ? "Live updates · 5s" : "Monitor unavailable"}</span></footer>
      </main>
    </LiveClockProvider>
  );
}
