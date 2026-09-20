"use client";

import type { AgentRole } from "../../../shared/monitor-contract";
import type { SessionSummaryDomain } from "../../../shared/session-domain-contract";
import { compactNumber, formatDuration, sessionListTime, sessionRelativeTime } from "../../dashboard-utils";
import { roleFamilyPresentation } from "../../role-family";
import { DottedInfoPopover } from "../DottedInfoPopover";
import { PanelHeadingLink } from "../PanelHeadingLink";
import type { SessionRouteQuery } from "./session-route";

const REQUEST_STRIP_SLOTS = 48;

function Unavailable({ readiness, label }: { readiness: "loading" | "ready" | "unavailable"; label: string }) {
  return <p className="sessionOverviewEmpty" role={readiness === "loading" ? "status" : undefined}>{readiness === "loading" ? `Loading ${label}…` : `${label} unavailable.`}</p>;
}

function roleLabel(role: AgentRole) {
  return role === "general-purpose" ? "General" : role === "workflow-worker" ? "Workflow" : role.replaceAll("_", " ");
}

export function SessionOverview({ summary, showEstimatedCost, onNavigate }: {
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
  const freshTokens = (request: (typeof requests)[number]) => request.uncachedInputTokens + request.cacheWriteTokens + request.outputTokens;
  const maximumFreshTokens = Math.max(...requests.map(freshTokens), 1);
  const emptySlots = Math.max(0, REQUEST_STRIP_SLOTS - requests.length);
  const requestCountLabel = requests.length >= REQUEST_STRIP_SLOTS ? `last ${REQUEST_STRIP_SLOTS}` : `${requests.length} so far`;
  const hasPlanTasks = summary.planTasks.length > 0;
  const showProgress = activityReady !== "ready" || Boolean(progress) || hasPlanTasks;
  const showWork = activityReady !== "ready" || summary.activity.byKind.length > 0;
  const showCost = Boolean(cost);

  return <div className="sessionOverview" data-density={summary.rightNow.length <= 2 ? "sparse" : "full"} aria-label="Session overview">
    <section className="sessionOverviewPanel sessionRightNow" data-empty={agentReady === "ready" && summary.rightNow.length === 0 ? "true" : undefined} aria-labelledby="session-right-now">
      <div className="sessionOverviewHeading"><PanelHeadingLink id="session-right-now" onOpen={() => onNavigate({ tab: "agents" })}>Right now</PanelHeadingLink></div>
      {agentReady !== "ready" ? <Unavailable readiness={agentReady} label="Agent evidence" /> : summary.rightNow.length === 0
        ? <p className="sessionOverviewEmpty">No agent activity is currently recorded.</p>
        : <ul>{summary.rightNow.slice(0, 5).map((agent) => <li key={agent.id}>
          <span className={`sessionAgentStatus status-${agent.status}`} aria-hidden="true" />
          <span className="sessionAgentIdentity"><button className="commandTextLink" type="button" onClick={() => onNavigate({ tab: "agents", agent: agent.id })}>{agent.label}</button><small>{roleLabel(agent.role)} · {agent.model}</small></span>
          <span className="sessionAgentActivity"><i className={`sessionCurrentActivityMark${agent.status === "active" && agent.currentActivity ? " isCurrent" : ""}`} aria-hidden="true" /><span className="sessionAgentActivityLabel">{agent.currentActivity?.label || agent.status.replaceAll("_", " ")}</span></span>
          <strong>{compactNumber(agent.tokens.total)}</strong>
          <time dateTime={agent.lastSeen}>{sessionRelativeTime(agent.lastSeen)}</time>
        </li>)}</ul>}
    </section>

    <section className="sessionOverviewPanel sessionSignals" aria-labelledby="session-signals">
      <div className="sessionOverviewHeading"><PanelHeadingLink id="session-signals" onOpen={() => onNavigate({ tab: "signals" })}>Efficiency signals</PanelHeadingLink></div>
      {activityReady !== "ready" ? <Unavailable readiness={activityReady} label="Signal evidence" /> : summary.topSignals.length === 0
        ? <p className="sessionOverviewEmpty">No efficiency signals recorded.</p>
        : <><ul>{summary.topSignals.map((signal) => <li key={signal.id}><strong><DottedInfoPopover ariaLabel={`About ${signal.title}`} content={signal.detail}>{signal.title}</DottedInfoPopover></strong>{signal.agentId && <button type="button" className="commandQuietAction" onClick={() => onNavigate({ tab: "agents", agent: signal.agentId! })}>Show agent</button>}</li>)}</ul><p className="sessionOverviewNote">Deterministic signals · not a quality assessment</p></>}
    </section>

    <section className="sessionOverviewPanel sessionRepositoryOneLine" aria-labelledby="session-repository">
      <div className="sessionOverviewHeading"><PanelHeadingLink id="session-repository" onOpen={() => onNavigate({ tab: "repository" })}>Repository</PanelHeadingLink></div>
      {repositoryReady !== "ready" ? <Unavailable readiness={repositoryReady} label="Repository evidence" /> : !summary.repository.available
        ? <p className="sessionOverviewEmpty">No repository detected.</p>
        : <p><strong>{summary.repository.branch || "Branch unavailable"}</strong><span>{summary.repository.changedFiles ?? "—"} changed files · {summary.repository.pullRequestCount ?? "—"} pull requests</span></p>}
    </section>

    <section className="sessionOverviewPanel sessionRequestStrip" aria-labelledby="session-requests">
      <div className="sessionOverviewHeading sessionRequestHeading">
        <div className="sessionRequestHeadingMain"><PanelHeadingLink id="session-requests" onOpen={() => onNavigate({ tab: "activities" })}>Requests</PanelHeadingLink><span className="sessionRequestSummary">one bar per model request · fresh tokens · {requestCountLabel}</span></div>
        {requests.length > 0 && <div className="requestsActionsLegend sessionRequestValueLegend" aria-label="Fresh token categories; cache reads are excluded"><span><i className="requestsActionsSwatch write" aria-hidden="true" />Cache write</span><span><i className="requestsActionsSwatch uncached" aria-hidden="true" />Uncached input</span><span><i className="requestsActionsSwatch output" aria-hidden="true" />Output</span></div>}
      </div>
      {summary.requestSnapshots.status !== "ready" ? <Unavailable readiness="unavailable" label="Request evidence" /> : requests.length === 0
        ? <p className="sessionOverviewEmpty">No request snapshots recorded.</p>
        : <>
          <div className="sessionRequestTracks" aria-label="Recent request-local fresh token totals">
            {requests.map((request) => <button type="button" key={request.id} title={`${request.agentLabel}: ${freshTokens(request).toLocaleString()} fresh tokens`}
              className={`commandIconAction ${roleFamilyPresentation(request.agentRole).className}`} onClick={() => onNavigate({ tab: "activities", request: request.id })}>
              <span className="sessionFreshStack" style={{ height: `${Math.max(12, Math.round(freshTokens(request) / maximumFreshTokens * 100))}%` }}><i className="requestsActionsSegment uncached" style={{ flex: request.uncachedInputTokens }} /><i className="requestsActionsSegment write" style={{ flex: request.cacheWriteTokens }} /><i className="requestsActionsSegment output" style={{ flex: request.outputTokens }} /></span><i className="sessionRoleTrack" />
            </button>)}
            {Array.from({ length: emptySlots }, (_, index) => <span className="sessionRequestSlot" key={`empty-${index}`} aria-hidden="true"><i className="sessionRoleTrack" /></span>)}
          </div>
          <div className="sessionRoleLegend" aria-label="Agent role legend">{[...roleCounts].map(([role, agents]) => <span key={role}><i className={roleFamilyPresentation(role).className} aria-hidden="true" />{roleLabel(role)} ×{agents.size}</span>)}</div>
        </>}
    </section>

    {(showProgress || showWork || showCost) && <div className="sessionOverviewBottom">
    {showProgress && <section className="sessionOverviewPanel sessionProgressOverview" aria-labelledby="session-progress">
      <div className="sessionOverviewHeading"><h2 id="session-progress">Progress</h2></div>
      {activityReady !== "ready" ? <Unavailable readiness={activityReady} label="Progress evidence" /> : progress ? <>
        <strong className="sessionOverviewValue">{progress.percent}%</strong><span>{progress.phase.replaceAll("_", " ")}</span>
        <div className="sessionOverviewMeter"><span style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div>
        <small>{summary.planTasks.length ? `${completedTasks}/${summary.planTasks.length} agent-maintained plan tasks · ` : "Agent-maintained estimate · "}{progress.confidence} confidence</small>
      </> : <><span>Plan tasks · {completedTasks} of {summary.planTasks.length} done</span><div className="sessionOverviewMeter"><span style={{ width: `${Math.round(completedTasks / summary.planTasks.length * 100)}%` }} /></div><small>Agent-maintained checklist, may be stale. No agent estimate recorded.</small></>}
    </section>}

    {showWork && <section className="sessionOverviewPanel sessionWorkOverview" aria-labelledby="session-work">
      <div className="sessionOverviewHeading"><h2 id="session-work">Work by kind</h2></div>
      {activityReady !== "ready" ? <Unavailable readiness={activityReady} label="Activity evidence" /> : summary.activity.byKind.length === 0
        ? <p className="sessionOverviewEmpty">No classified work recorded.</p>
        : <dl>{summary.activity.byKind.slice(0, 6).map((item) => <div key={item.kind}><dt>{item.kind.replaceAll("_", " ")}</dt><dd>{item.count.toLocaleString()}{item.medianDurationMs === null || item.medianDurationMs < 60_000 ? "" : ` · ${formatDuration(item.medianDurationMs)} median`}</dd></div>)}</dl>}
    </section>}

    {showCost && <section className="sessionOverviewPanel sessionCostOverview" aria-labelledby="session-cost">
      <div className="sessionOverviewHeading"><h2 id="session-cost">Cost</h2></div>
      <><strong className="sessionOverviewValue">{new Intl.NumberFormat("en-US", { style: "currency", currency: cost!.currency }).format(cost!.amount)}</strong><span>{summary.source} estimate</span><small>Estimate, not a bill · observed {sessionListTime(cost!.observedAt)}</small></>
    </section>}
    </div>}
  </div>;
}
