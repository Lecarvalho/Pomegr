"use client";

import type { ReactNode } from "react";
import type { AgentRole } from "../../../shared/monitor-contract";
import type { SessionSummaryDomain } from "../../../shared/session-domain-contract";
import { compactNumber, formatDuration, sessionListTime, sessionRelativeTime } from "../../dashboard-utils";
import { roleFamilyPresentation } from "../../role-family";
import { DottedInfoPopover } from "../DottedInfoPopover";
import type { SessionRouteQuery } from "./session-route";

function Unavailable({ readiness, label }: { readiness: "loading" | "ready" | "unavailable"; label: string }) {
  return <p className="sessionOverviewEmpty" role={readiness === "loading" ? "status" : undefined}>{readiness === "loading" ? `Loading ${label}…` : `${label} unavailable.`}</p>;
}

function routeLink(query: SessionRouteQuery, changes: Partial<SessionRouteQuery>, onNavigate: (changes: Partial<SessionRouteQuery>) => void, children: ReactNode) {
  return <button type="button" className="commandTextLink" onClick={() => onNavigate(changes)}>{children}</button>;
}

function roleLabel(role: AgentRole) {
  return role === "general-purpose" ? "General" : role === "workflow-worker" ? "Workflow" : role.replaceAll("_", " ");
}

export function SessionOverview({ summary, query, showEstimatedCost, onNavigate }: {
  summary: SessionSummaryDomain;
  query: SessionRouteQuery;
  showEstimatedCost: boolean;
  onNavigate: (changes: Partial<SessionRouteQuery>) => void;
}) {
  const agentReady = summary.sectionReadiness.agentEvidence;
  const activityReady = summary.sectionReadiness.activityEvidence;
  const repositoryReady = summary.repository.readiness;
  const requests = summary.requestSnapshots.items;
  const roleCounts = new Map<AgentRole, Set<string>>();
  for (const request of requests) {
    const agents = roleCounts.get(request.agentRole) || new Set<string>();
    agents.add(request.agentLabel);
    roleCounts.set(request.agentRole, agents);
  }
  const progress = summary.session?.progress;
  const completedTasks = summary.planTasks.filter((task) => task.status === "completed").length;
  const cost = showEstimatedCost && summary.capabilities.estimatedCost ? summary.session?.cost : null;

  return <div className="sessionOverview" aria-label="Session overview">
    <section className="sessionOverviewPanel sessionRightNow" aria-labelledby="session-right-now">
      <div className="sessionOverviewHeading"><h2 id="session-right-now">Right now</h2>{routeLink(query, { tab: "agents" }, onNavigate, "All agents")}</div>
      {agentReady !== "ready" ? <Unavailable readiness={agentReady} label="Agent evidence" /> : summary.rightNow.length === 0
        ? <p className="sessionOverviewEmpty">No agent activity is currently recorded.</p>
        : <ul>{summary.rightNow.slice(0, 5).map((agent) => <li key={agent.id}>
          <span className={`sessionAgentStatus status-${agent.status}`} aria-hidden="true" />
          <span className="sessionAgentIdentity"><button className="commandTextLink" type="button" onClick={() => onNavigate({ tab: "agents", agent: agent.id })}>{agent.label}</button><small>{roleLabel(agent.role)} · {agent.model}</small></span>
          <span>{agent.currentActivity?.label || agent.status.replaceAll("_", " ")}</span>
          <strong>{compactNumber(agent.tokens.total)}</strong>
          <time dateTime={agent.lastSeen}>{sessionRelativeTime(agent.lastSeen)}</time>
        </li>)}</ul>}
    </section>

    <section className="sessionOverviewPanel sessionSignals" aria-labelledby="session-signals">
      <div className="sessionOverviewHeading"><h2 id="session-signals">Efficiency signals</h2>{routeLink(query, { tab: "signals" }, onNavigate, "View signals")}</div>
      {activityReady !== "ready" ? <Unavailable readiness={activityReady} label="Signal evidence" /> : summary.topSignals.length === 0
        ? <p className="sessionOverviewEmpty">No efficiency signals recorded.</p>
        : <><ul>{summary.topSignals.map((signal) => <li key={signal.id}><strong><DottedInfoPopover ariaLabel={`About ${signal.title}`} content={signal.detail}>{signal.title}</DottedInfoPopover></strong>{signal.agentId ? routeLink(query, { tab: "agents", agent: signal.agentId }, onNavigate, "Show agent") : routeLink(query, { tab: "signals" }, onNavigate, "View evidence")}</li>)}</ul><p className="sessionOverviewNote">Deterministic signals · not a quality assessment</p></>}
    </section>

    <section className="sessionOverviewPanel sessionRepositoryOneLine" aria-labelledby="session-repository">
      <div className="sessionOverviewHeading"><h2 id="session-repository">Repository</h2>{routeLink(query, { tab: "repository" }, onNavigate, "Open repository")}</div>
      {repositoryReady !== "ready" ? <Unavailable readiness={repositoryReady} label="Repository evidence" /> : !summary.repository.available
        ? <p className="sessionOverviewEmpty">No repository detected.</p>
        : <p><strong>{summary.repository.branch || "Branch unavailable"}</strong><span>{summary.repository.changedFiles ?? "—"} changed files · {summary.repository.pullRequestCount ?? "—"} pull requests</span></p>}
    </section>

    <section className="sessionOverviewPanel sessionRequestStrip" aria-labelledby="session-requests">
      <div className="sessionOverviewHeading"><h2 id="session-requests">Requests</h2>{routeLink(query, { tab: "activities" }, onNavigate, "Open activities")}</div>
      {summary.requestSnapshots.status !== "ready" ? <Unavailable readiness="unavailable" label="Request evidence" /> : requests.length === 0
        ? <p className="sessionOverviewEmpty">No request snapshots recorded.</p>
        : <>
          <div className="sessionRequestTracks" aria-label="Recent request-local fresh token totals">
            {requests.map((request) => { const freshTokens = request.uncachedInputTokens + request.cacheWriteTokens + request.outputTokens; const maximum = Math.max(...requests.map((item) => item.uncachedInputTokens + item.cacheWriteTokens + item.outputTokens), 1); return <button type="button" key={request.id} title={`${request.agentLabel}: ${freshTokens.toLocaleString()} fresh tokens`}
              className={`commandIconAction ${roleFamilyPresentation(request.agentRole).className}`} onClick={() => onNavigate({ tab: "activities", request: request.id })}>
              <span className="sessionFreshStack" style={{ height: `${Math.max(12, Math.round(freshTokens / maximum * 100))}%` }}><i className="requestsActionsSegment uncached" style={{ flex: request.uncachedInputTokens }} /><i className="requestsActionsSegment write" style={{ flex: request.cacheWriteTokens }} /><i className="requestsActionsSegment output" style={{ flex: request.outputTokens }} /></span><i className="sessionRoleTrack" />
            </button>; })}
          </div>
          <div className="sessionRoleLegend" aria-label="Agent role legend">{[...roleCounts].map(([role, agents]) => <span key={role}><i className={roleFamilyPresentation(role).className} aria-hidden="true" />{roleLabel(role)} ×{agents.size}</span>)}</div>
          <p className="sessionOverviewNote">Fresh tokens per request: uncached input, cache write, and output. Cache reads are excluded.</p>
        </>}
    </section>

    <section className="sessionOverviewPanel sessionProgressOverview" aria-labelledby="session-progress">
      <div className="sessionOverviewHeading"><h2 id="session-progress">Progress</h2></div>
      {activityReady !== "ready" ? <Unavailable readiness={activityReady} label="Progress evidence" /> : progress ? <>
        <strong className="sessionOverviewValue">{progress.percent}%</strong><span>{progress.phase.replaceAll("_", " ")}</span>
        <div className="sessionOverviewMeter"><span style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div>
        <small>{summary.planTasks.length ? `${completedTasks}/${summary.planTasks.length} agent-maintained plan tasks · ` : "Agent-maintained estimate · "}{progress.confidence} confidence</small>
      </> : <p className="sessionOverviewEmpty">No progress estimate recorded.</p>}
    </section>

    <section className="sessionOverviewPanel sessionWorkOverview" aria-labelledby="session-work">
      <div className="sessionOverviewHeading"><h2 id="session-work">Work by kind</h2></div>
      {activityReady !== "ready" ? <Unavailable readiness={activityReady} label="Activity evidence" /> : summary.activity.byKind.length === 0
        ? <p className="sessionOverviewEmpty">No classified work recorded.</p>
        : <dl>{summary.activity.byKind.slice(0, 6).map((item) => <div key={item.kind}><dt>{item.kind.replaceAll("_", " ")}</dt><dd>{item.count.toLocaleString()}{item.medianDurationMs === null ? "" : ` · ${formatDuration(item.medianDurationMs)} median`}</dd></div>)}</dl>}
    </section>

    <section className="sessionOverviewPanel sessionCostOverview" aria-labelledby="session-cost">
      <div className="sessionOverviewHeading"><h2 id="session-cost">Cost</h2></div>
      {!showEstimatedCost ? <p className="sessionOverviewEmpty">Estimated cost is hidden in Settings.</p> : !summary.capabilities.estimatedCost ? <p className="sessionOverviewEmpty">Cost estimates are unavailable for this provider.</p> : !cost
        ? <p className="sessionOverviewEmpty">No cost estimate recorded.</p>
        : <><strong className="sessionOverviewValue">{new Intl.NumberFormat("en-US", { style: "currency", currency: cost.currency }).format(cost.amount)}</strong><span>{summary.source} estimate</span><small>Estimate, not a bill · observed {sessionListTime(cost.observedAt)}</small></>}
    </section>
  </div>;
}
