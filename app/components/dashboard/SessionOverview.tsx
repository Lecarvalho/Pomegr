"use client";

import type { AgentRole } from "../../../shared/monitor-contract";
import type { SessionSummaryDomain } from "../../../shared/session-domain-contract";
import { WORK_LABELS } from "../agents/agent-presentation";
import { compactNumber, formatDuration, sessionRelativeTime } from "../../dashboard-utils";
import { usePhoneLayout } from "../../hooks/usePhoneLayout";
import { roleFamilyPresentation } from "../../role-family";
import { PanelHeadingLink } from "../PanelHeadingLink";
import { comparisonLabel } from "./RepositoryPanel";
import type { SessionRouteQuery } from "./session-route";

const REQUEST_STRIP_SLOTS = 48;
// Phone draws half the window so each bar stays wide enough to read and tap.
const PHONE_REQUEST_STRIP_SLOTS = 24;

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
  const stripSlots = usePhoneLayout() ? PHONE_REQUEST_STRIP_SLOTS : REQUEST_STRIP_SLOTS;
  const requests = summary.requestSnapshots.items.slice(-stripSlots);
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
  const emptySlots = Math.max(0, stripSlots - requests.length);
  const requestCountLabel = requests.length >= stripSlots ? `last ${stripSlots}` : `${requests.length} so far`;
  const hasPlanTasks = summary.planTasks.length > 0;
  const showProgress = activityReady !== "ready" || Boolean(progress) || hasPlanTasks;
  const showWork = activityReady !== "ready" || summary.activity.byKind.length > 0;
  const showCost = Boolean(cost);

  const repositoryComparison = summary.repository.comparison;
  const repositoryComparisonText = comparisonLabel(repositoryComparison);
  const repositoryComparisonTone = repositoryComparison && (repositoryComparison.integrated || (repositoryComparison.ahead === 0 && repositoryComparison.behind === 0)) ? "positive" : undefined;
  const repositoryChangedFiles = summary.repository.changedFiles;
  const repositoryChangesLabel = repositoryChangedFiles === null ? "—" : repositoryChangedFiles === 0 ? "No local changes" : `${repositoryChangedFiles} changed file${repositoryChangedFiles === 1 ? "" : "s"}`;
  const repositoryPullRequestCount = summary.repository.pullRequestCount;
  const repositoryPullRequestsLabel = repositoryPullRequestCount === null ? "—" : `${repositoryPullRequestCount} pull request${repositoryPullRequestCount === 1 ? "" : "s"}`;
  const sparse = summary.rightNow.length <= 2;
  // A sparse Right now leaves most of its row empty, so Work by kind shares that row instead of the bottom one.
  const workBeside = sparse && showWork;

  const workSection = <section className="sessionOverviewPanel sessionWorkOverview" aria-labelledby="session-work">
    <div className="sessionOverviewHeading"><h2 id="session-work" className="sessionEyebrow">Work by kind · session</h2></div>
    {activityReady !== "ready" ? <Unavailable readiness={activityReady} label="Activity evidence" /> : summary.activity.byKind.length === 0
      ? <p className="sessionOverviewEmpty">No classified work recorded.</p>
      : <>
        <div className="sessionWorkRow">{summary.activity.byKind.slice(0, 6).map((item) => <span key={item.kind}>{WORK_LABELS[item.kind]} <b>{item.count.toLocaleString()}</b>{item.medianDurationMs === null || item.medianDurationMs < 60_000 ? "" : ` · ${formatDuration(item.medianDurationMs)} median`}</span>)}</div>
        <p className="sessionOverviewNote">Counts describe recorded tool calls, not quality.</p>
      </>}
  </section>;

  return <div className="sessionOverview" data-density={sparse ? "sparse" : "full"} data-work={workBeside ? "beside" : undefined} aria-label="Session overview">
    <section className="sessionOverviewPanel sessionRightNow" data-empty={agentReady === "ready" && summary.rightNow.length === 0 ? "true" : undefined} aria-labelledby="session-right-now">
      <div className="sessionOverviewHeading"><div className="sessionRequestHeadingMain"><PanelHeadingLink id="session-right-now" onOpen={() => onNavigate({ tab: "agents" })}>Right now</PanelHeadingLink><span className="sessionRequestSummary">latest action per active agent</span></div></div>
      {agentReady !== "ready" ? <Unavailable readiness={agentReady} label="Agent evidence" /> : summary.rightNow.length === 0
        ? <p className="sessionOverviewEmpty">No agent activity is currently recorded.</p>
        : <ul>{summary.rightNow.slice(0, 5).map((agent) => {
          const activityLabel = agent.currentActivity?.label || agent.status.replaceAll("_", " ");
          const activityIsCurrent = agent.status === "active" && Boolean(agent.currentActivity);
          return <li key={agent.id}>
            <span className={`sessionAgentStatus status-${agent.status}`} aria-hidden="true" />
            <span className="sessionAgentIdentity"><button className="commandTextLink" type="button" title={agent.label} onClick={() => onNavigate({ tab: "agents", agent: agent.id })}>{agent.label}</button><small>{roleLabel(agent.role)} · {agent.model}</small></span>
            <span className="sessionAgentActivity"><i className={`sessionCurrentActivityMark${activityIsCurrent ? " isCurrent" : ""}`} aria-hidden="true" /><span className={`sessionAgentActivityLabel${activityIsCurrent ? " currentActivityShimmer" : ""}`} data-text={activityIsCurrent ? activityLabel : undefined}>{activityLabel}</span></span>
            <span className="sessionRightNowTokens"><span className="sessionRightNowTokensLabel">Latest context</span><strong>{compactNumber(agent.tokens.total)}</strong></span>
            <time dateTime={agent.lastSeen}>{sessionRelativeTime(agent.lastSeen)}</time>
          </li>;
        })}</ul>}
    </section>

    {workBeside && workSection}

    <section className="sessionOverviewPanel sessionRequestStrip" aria-labelledby="session-requests">
      <div className="sessionOverviewHeading sessionRequestHeading">
        <div className="sessionRequestHeadingMain"><PanelHeadingLink id="session-requests" onOpen={() => onNavigate({ tab: "activities" })}>Requests</PanelHeadingLink><span className="sessionRequestSummary"><span className="sessionRequestSummaryLead">one bar per model request · </span>fresh tokens · {requestCountLabel}</span></div>
        {requests.length > 0 && <div className="requestsActionsLegend sessionRequestValueLegend" aria-label="Fresh token categories; cache reads are excluded"><span><i className="requestsActionsSwatch write" aria-hidden="true" />Cache write</span><span><i className="requestsActionsSwatch uncached" aria-hidden="true" />Uncached input</span><span><i className="requestsActionsSwatch output" aria-hidden="true" />Output</span></div>}
      </div>
      {summary.requestSnapshots.status !== "ready" ? <Unavailable readiness="unavailable" label="Request evidence" /> : requests.length === 0
        ? <p className="sessionOverviewEmpty">No request snapshots recorded.</p>
        : <>
          <div className="sessionRequestTracks" aria-label="Recent request-local fresh token totals">
            {requests.map((request) => <button type="button" key={request.id} title={`${request.agentLabel}: ${freshTokens(request).toLocaleString()} fresh tokens`}
              className={`commandIconAction ${roleFamilyPresentation(request.agentRole).className}`} onClick={() => onNavigate({ tab: "activities", request: request.id })}>
              <span className="sessionFreshStack" style={{ height: `${Math.max(12, Math.round(freshTokens(request) / maximumFreshTokens * 100))}%` }}><i className="requestsActionsSegment uncached" style={{ flex: request.uncachedInputTokens }} /><i className="requestsActionsSegment write" style={{ flex: request.cacheWriteTokens }} /><i className="requestsActionsSegment output" style={{ flex: request.outputTokens }} /></span>
            </button>)}
            {Array.from({ length: emptySlots }, (_, index) => <span className="sessionRequestBarSlot" key={`empty-${index}`} aria-hidden="true" />)}
          </div>
          <div className="sessionRequestRoleRow" aria-hidden="true">
            {requests.map((request) => <i key={request.id} className={`sessionRequestRoleSegment ${roleFamilyPresentation(request.agentRole).className}`} />)}
            {Array.from({ length: emptySlots }, (_, index) => <i className="sessionRequestRoleSegment isEmpty" key={`empty-role-${index}`} />)}
          </div>
          <div className="sessionRoleLegend" aria-label="Agent role legend"><span className="sessionEyebrow">Agent role</span>{[...roleCounts].map(([role, agents]) => <span key={role}><i className={roleFamilyPresentation(role).className} aria-hidden="true" />{roleLabel(role)}{agents.size > 1 ? ` ×${agents.size}` : ""}</span>)}</div>
        </>}
    </section>

    <section className="sessionOverviewPanel sessionRepositoryOneLine" aria-labelledby="session-repository">
      <div className="sessionOverviewHeading"><PanelHeadingLink id="session-repository" onOpen={() => onNavigate({ tab: "repository" })}>Repository</PanelHeadingLink></div>
      {repositoryReady !== "ready" ? <Unavailable readiness={repositoryReady} label="Repository evidence" /> : !summary.repository.available
        ? <p className="sessionOverviewEmpty">No repository detected.</p>
        : <p className="sessionRepositoryLine">
          <span className="sessionRepositoryLineBranch">{summary.repository.branch || "Branch unavailable"}</span>
          {repositoryComparisonText && <span className={`commandChip${repositoryComparisonTone ? ` ${repositoryComparisonTone}` : ""}`}>{repositoryComparisonText}</span>}
          <span className="sessionRepositoryLineMeta">{repositoryChangesLabel}<span className="sessionRepositoryPullRequests"> · {repositoryPullRequestsLabel}</span></span>
        </p>}
    </section>

    {(showProgress || (showWork && !workBeside) || showCost) && <div className="sessionOverviewBottom">
    {showProgress && <section className="sessionOverviewPanel sessionProgressOverview" aria-labelledby="session-progress">
      <div className="sessionOverviewHeading"><h2 id="session-progress" className="sessionEyebrow">Progress</h2></div>
      {activityReady !== "ready" ? <Unavailable readiness={activityReady} label="Progress evidence" /> : progress ? <>
        <div className="sessionOverviewProgressHeadline"><strong className="sessionOverviewValue">{progress.percent}%</strong><span>{progress.phase.replaceAll("_", " ")}</span></div>
        <div className="sessionOverviewMeter"><span style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div>
        <small>{summary.planTasks.length ? `${completedTasks}/${summary.planTasks.length} agent-maintained plan tasks · ` : "Agent-maintained estimate · "}{progress.confidence} confidence</small>
      </> : <><div className="sessionProgressTasksRow"><span>Plan tasks</span><span>{completedTasks} of {summary.planTasks.length} done</span></div><div className="sessionOverviewMeter"><span style={{ width: `${Math.round(completedTasks / summary.planTasks.length * 100)}%` }} /></div><small>Agent-maintained checklist, may be stale. No agent estimate recorded.</small></>}
    </section>}

    {showWork && !workBeside && workSection}

    {showCost && <section className="sessionOverviewPanel sessionCostOverview" aria-labelledby="session-cost">
      <div className="sessionOverviewHeading"><h2 id="session-cost" className="sessionEyebrow">Cost</h2></div>
      <div className="sessionCostRow"><span>{summary.source} API list-rate estimate</span><strong className="sessionCostAmount">{new Intl.NumberFormat("en-US", { style: "currency", currency: cost!.currency }).format(cost!.amount)}</strong></div>
      <p className="sessionOverviewNote">Estimate, not a bill. Observed {sessionRelativeTime(cost!.observedAt)}.</p>
    </section>}
    </div>}
  </div>;
}
