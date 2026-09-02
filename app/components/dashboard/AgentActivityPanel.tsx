"use client";

import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Agent, CacheReadDropCount, CacheRefillCount, ContextHistoryBoundary, ExecutionTask, PlanTask, RequestSnapshotFeed, ReviewDecision, Workflow } from "../../../shared/monitor-contract";
import { agentAssignment, agentDisplayLabel, agentDisplayName, agentsWithFinishedVisibility, agentTreeRows, cacheLifetimeLabel, compactNumber } from "../../dashboard-utils";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { AgentChip } from "../AgentChip";
import { CopyTranscriptButton } from "../CopyTranscriptButton";
import { EmptyState } from "../EmptyState";
import { ExecutionTaskRow } from "../ExecutionTaskRow";
import { AgentWallTimeText, RelativeTimeText } from "../LiveTime";
import { PanelHeader } from "../PanelHeader";
import { PopoverFrame } from "../PopoverFrame";
import { AgentHistoryIndicators, summarizeCacheReadDrops, summarizeCacheRefills, summarizeCompactions } from "./AgentHistoryIndicators";
import { AgentTurnCacheTiming } from "./AgentTurnCacheTiming";
import { AgentTreeView } from "./agent-tree/AgentTreeView";

export type AgentActivityViewMode = "list" | "tree";

type OpenAgentPopover = { kind: "skills" | "execution" | "plan"; agentId: string } | null;
type FinishedAgentPreference = { sessionId: string; showFinished: boolean };

const REVIEW_ACTION_LABELS: Record<ReviewDecision["action"], string> = {
  build_or_test: "Build or test",
  browser_interaction: "Browser interaction",
  dependency_change: "Dependency change",
  file_change: "File change",
  filesystem_action: "Filesystem action",
  local_process: "Local process or server",
  network_access: "Network access",
  version_control: "Version-control action",
  shell_command: "Shell command",
  privileged_action: "Privileged action",
};

const EMPTY_REQUEST_SNAPSHOTS: RequestSnapshotFeed = { status: "unavailable", items: [] };

function storedFinishedAgentVisibility(sessionId: string) {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(`pomegr-agent-activity-show-finished-${sessionId}`) !== "false";
  } catch {
    return true;
  }
}

function activityIsCurrent(agent: Agent) {
  return agent.status !== "unknown"
    && agent.liveness?.freshness !== "stale"
    && agent.liveness?.evidence !== "unavailable";
}

export function AgentActivityPanel({ agents, cacheRefills = [], cacheReadDrops = [], contextBoundaries = [], executionTasks, planTasks, requestSnapshots = EMPTY_REQUEST_SNAPSHOTS, workflows = [], historical, sessionId = "agent-activity", viewMode = "list", onViewModeChange = () => {} }: {
  agents: Agent[];
  cacheRefills?: CacheRefillCount[];
  cacheReadDrops?: CacheReadDropCount[];
  contextBoundaries?: ContextHistoryBoundary[];
  executionTasks: ExecutionTask[];
  planTasks: PlanTask[];
  requestSnapshots?: RequestSnapshotFeed;
  workflows?: Workflow[];
  historical: boolean;
  sessionId?: string;
  viewMode?: AgentActivityViewMode;
  onViewModeChange?: (viewMode: AgentActivityViewMode) => void;
}) {
  const [openPopover, setOpenPopover] = useState<OpenAgentPopover>(null);
  const [finishedPreference, setFinishedPreference] = useState<FinishedAgentPreference | null>(null);
  const popoverAnchorRef = useRef<HTMLDivElement | null>(null);
  const closePopover = useCallback(() => setOpenPopover(null), []);
  useDismissibleLayer(Boolean(openPopover), popoverAnchorRef, closePopover);
  const showFinished = finishedPreference?.sessionId === sessionId
    ? finishedPreference.showFinished
    : storedFinishedAgentVisibility(sessionId);
  const visibleAgents = useMemo(() => agentsWithFinishedVisibility(agents, showFinished), [agents, showFinished]);
  const agentRows = agentTreeRows(visibleAgents);
  const finishedAgentCount = agents.filter((agent) => agent.id !== "primary" && (agent.status === "finished" || agent.status === "stopped")).length;
  const executionTasksByAgent = new Map(agents.map((agent) => [agent.id, agent.executionTasks || (agent.id === "primary" ? executionTasks : [])]));
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const phasesByWorkflowId = new Map(workflows.map((workflow) => [workflow.id, new Map(workflow.phases.map((phase) => [phase.id, phase]))]));
  const labelCounts = new Map<string, number>();
  for (const agent of visibleAgents) {
    const displayLabel = agentDisplayLabel(agent);
    labelCounts.set(displayLabel, (labelCounts.get(displayLabel) || 0) + 1);
  }
  const completedPlanTasks = planTasks.filter((task) => task.status === "completed").length;
  const activePlanTasks = planTasks.filter((task) => task.status === "in_progress").length;
  const openPlanTasks = planTasks.length - completedPlanTasks - activePlanTasks;
  const isOpen = (kind: NonNullable<OpenAgentPopover>["kind"], agentId: string) => openPopover?.kind === kind && openPopover.agentId === agentId;
  const toggle = (kind: NonNullable<OpenAgentPopover>["kind"], agentId: string) => setOpenPopover((current) => current?.kind === kind && current.agentId === agentId ? null : { kind, agentId });
  const toggleFinishedAgents = () => {
    const next = !showFinished;
    setOpenPopover(null);
    setFinishedPreference({ sessionId, showFinished: next });
    try {
      window.localStorage.setItem(`pomegr-agent-activity-show-finished-${sessionId}`, String(next));
    } catch {
      // The in-memory preference remains usable when browser storage is unavailable.
    }
  };

  const renderAgentRow = ({ agent, depth }: { agent: Agent; depth: number }) => {
    const tasks = executionTasksByAgent.get(agent.id) || [];
    const runningTasks = tasks.filter((task) => task.status === "running");
    const finishedTasks = tasks.filter((task) => task.status !== "running");
    const reviewDecisions = agent.reviewDecisions || { total: 0, allowed: 0, denied: 0, items: [], truncated: false };
    const visibleReviewDecisions = [...reviewDecisions.items].reverse();
    const currentActivity = historical ? null : agent.currentActivity;
    const currentActivityIsCurrent = currentActivity ? activityIsCurrent(agent) : false;
    const transcriptAvailable = agent.id !== "primary" && agent.transcriptAvailable === true;
    const rowPopoverOpen = openPopover?.agentId === agent.id;
    const workflow = agent.workflowId ? workflowsById.get(agent.workflowId) : null;
    const phase = agent.workflowId && agent.workflowPhaseId ? phasesByWorkflowId.get(agent.workflowId)?.get(agent.workflowPhaseId) : null;
    const assignment = agentAssignment(agent);
    const displayName = agentDisplayName(agent);
    const displayLabel = agentDisplayLabel(agent);
    const identityLabel = (labelCounts.get(displayLabel) || 0) > 1
      ? `${displayLabel} agent ${agent.id.slice(-6)}`
      : `${displayLabel} agent`;
    const compactions = summarizeCompactions(contextBoundaries, [agent.id]);
    const cacheRefillCount = summarizeCacheRefills(cacheRefills, [agent.id]);
    const cacheReadDropCount = summarizeCacheReadDrops(cacheReadDrops, [agent.id]);
    const accessibleLabel = `${identityLabel}, ${cacheLifetimeLabel(agent.cacheLifetime)}${compactions.total > 0 ? `, ${compactions.total} ${compactions.total === 1 ? "compaction" : "compactions"}` : ""}${cacheRefillCount > 0 ? `, ${cacheRefillCount} possible full cache ${cacheRefillCount === 1 ? "refill" : "refills"}` : ""}${cacheReadDropCount > 0 ? `, ${cacheReadDropCount} possible cache ${cacheReadDropCount === 1 ? "refill" : "refills"}` : ""}`;

    return (
      <div
        aria-label={accessibleLabel}
        className={`agentRow ${depth > 0 ? "childAgent" : "rootAgent"} ${agent.status}Agent ${rowPopoverOpen ? "agentPopoverOpen" : ""}`}
        key={agent.id}
        role="listitem"
        style={{ "--agent-indent": `${Math.min(depth, 8) * 20}px` } as CSSProperties}
      >
        <div className="treeRail"><span className={agent.id === "primary" ? "primaryNode" : "agentNode"} /></div>
        <div className="agentIdentity">
          <div className="agentTitleLine">
            <strong dir="auto">{displayName}</strong>
            <AgentHistoryIndicators agentIds={[agent.id]} boundaries={contextBoundaries} cacheRefills={cacheRefills} cacheReadDrops={cacheReadDrops} />
            {agent.signal && <AgentChip className={`agentSignal ${agent.signal.tone}`} title={agent.signal.description || "Reported by this agent through the Pomegr MCP tool"}>{agent.signal.label}</AgentChip>}
            {agent.skills.length > 0 && (
              <div className="agentPopoverAnchor skillPopoverAnchor" ref={isOpen("skills", agent.id) ? popoverAnchorRef : undefined}>
                <AgentChip as="button" className="skillPopoverTrigger" onClick={() => toggle("skills", agent.id)} expanded={isOpen("skills", agent.id)} controls={`agent-skills-${agent.id}`}>{agent.skills.length} {agent.skills.length === 1 ? "skill" : "skills"}</AgentChip>
                {isOpen("skills", agent.id) && (
                  <PopoverFrame id={`agent-skills-${agent.id}`} ariaLabel={`Skills used by ${displayLabel}`} eyebrow="SKILL USAGE" title={displayLabel} closeLabel="Close skill usage" onClose={closePopover} summary={`${agent.skills.length} recorded ${agent.skills.length === 1 ? "skill" : "skills"} · metadata only`} className="skillPopover">
                    <div className="skillPopoverList">{agent.skills.map((skill) => <div className="skillPopoverRow" key={skill.name}><div><strong>{skill.name}</strong><small>{skill.lastUsed ? <>Last used <RelativeTimeText value={skill.lastUsed} /></> : "Use time unavailable"}</small></div><div><strong>{skill.calls}</strong><small>{skill.calls === 1 ? "use" : "uses"}</small></div></div>)}</div>
                  </PopoverFrame>
                )}
              </div>
            )}
            {(tasks.length > 0 || reviewDecisions.total > 0 || currentActivity || transcriptAvailable) && (
              <div className="agentPopoverAnchor executionTaskAnchor" ref={isOpen("execution", agent.id) ? popoverAnchorRef : undefined}>
                <AgentChip as="button" className="executionTaskTrigger" onClick={() => toggle("execution", agent.id)} expanded={isOpen("execution", agent.id)} controls={`agent-execution-tasks-${agent.id}`}>{tasks.length > 0 ? (runningTasks.length > 0 ? `${runningTasks.length} running` : `${finishedTasks.length} shell ${finishedTasks.length === 1 ? "task" : "tasks"}`) : reviewDecisions.total > 0 ? `${reviewDecisions.total} ${reviewDecisions.total === 1 ? "review" : "reviews"}` : currentActivity ? (currentActivityIsCurrent ? "Current activity" : "Last observed activity") : "Agent details"}</AgentChip>
                {isOpen("execution", agent.id) && (
                  <PopoverFrame id={`agent-execution-tasks-${agent.id}`} ariaLabel={`Agent activity for ${displayLabel}`} eyebrow="AGENT ACTIVITY" title={displayLabel} closeLabel="Close agent activity" onClose={closePopover} summary={reviewDecisions.total > 0 ? `${reviewDecisions.allowed} allowed · ${reviewDecisions.denied} denied · ${tasks.length} shell ${tasks.length === 1 ? "task" : "tasks"}` : `${runningTasks.length} running · ${finishedTasks.length} finished`} actions={transcriptAvailable ? <CopyTranscriptButton sessionId={sessionId} agentId={agent.id} agentLabel={displayLabel} /> : undefined} className="executionTaskPopover">
                    {(currentActivity || visibleReviewDecisions.length > 0 || runningTasks.length > 0 || finishedTasks.length > 0) && <div className="executionTaskList">
                      {currentActivity && <section className="executionTaskSection currentActivitySection" aria-label={currentActivityIsCurrent ? "Current provider-reported activity" : "Last observed provider-reported activity"}><h3>{currentActivityIsCurrent ? "Current activity" : "Last observed activity"}</h3><div className={`currentActivityRow ${currentActivityIsCurrent ? "" : "staleActivity"}`}><span className="currentActivityMark" aria-hidden="true" /><div><strong>{currentActivity.label}</strong><small>Provider-reported · observed <RelativeTimeText value={currentActivity.observedAt} /></small></div></div></section>}
                      {visibleReviewDecisions.length > 0 && <section className="executionTaskSection reviewDecisionSection" aria-label="Completed approval reviews"><h3>Review decisions ({reviewDecisions.total})</h3>{visibleReviewDecisions.map((decision, index) => {
                        const actionLabel = REVIEW_ACTION_LABELS[decision.action] || REVIEW_ACTION_LABELS.privileged_action;
                        const riskLabel = decision.risk === "unknown" ? "risk unavailable" : `${decision.risk} risk`;
                        const durationLabel = decision.durationMs === null ? null : decision.durationMs < 1_000 ? "under 1s" : decision.durationMs < 10_000 ? `${(decision.durationMs / 1_000).toFixed(1).replace(/\.0$/, "")}s` : `${Math.round(decision.durationMs / 1_000)}s`;
                        return <div className={`reviewDecisionRow ${decision.outcome}`} key={`${decision.reviewedAt}-${decision.outcome}-${index}`}><span className="reviewDecisionMark" aria-hidden="true" /><div><div className="reviewDecisionHeading"><strong>{actionLabel}</strong><span className="reviewDecisionOutcome">{decision.outcome === "allowed" ? "Allowed" : "Denied"}</span></div><small>Pomegr category · provider-assessed {riskLabel} · completed <RelativeTimeText value={decision.reviewedAt} />{durationLabel ? ` · reviewed in ${durationLabel}` : ""}</small></div></div>;
                      })}{reviewDecisions.truncated && <p className="reviewDecisionLimit">Showing the latest {visibleReviewDecisions.length} decisions.</p>}</section>}
                      {runningTasks.length > 0 && <section className="executionTaskSection" aria-label="Running execution tasks"><h3>Running</h3>{runningTasks.map((task) => <ExecutionTaskRow task={task} key={task.id} />)}</section>}
                      {finishedTasks.length > 0 && <section className="executionTaskSection" aria-label="Finished execution tasks"><h3>Recently finished ({finishedTasks.length})</h3>{finishedTasks.map((task) => <ExecutionTaskRow task={task} key={task.id} />)}</section>}
                    </div>}
                  </PopoverFrame>
                )}
              </div>
            )}
            {agent.id === "primary" && planTasks.length > 0 && (
              <div className="agentPopoverAnchor planTaskAnchor" ref={isOpen("plan", agent.id) ? popoverAnchorRef : undefined}>
                <AgentChip as="button" className="planTaskTrigger" onClick={() => toggle("plan", agent.id)} expanded={isOpen("plan", agent.id)} controls="primary-agent-plan-tasks">{planTasks.length} plan {planTasks.length === 1 ? "item" : "items"}</AgentChip>
                {isOpen("plan", agent.id) && (
                  <PopoverFrame id="primary-agent-plan-tasks" ariaLabel="Agent plan checklist" eyebrow="AGENT PLAN" title="Plan checklist" closeLabel="Close plan checklist" onClose={closePopover} summary={`${completedPlanTasks} done · ${activePlanTasks} in progress · ${openPlanTasks} open`} className="planTaskPopover">
                    <div className="planTaskList">{planTasks.map((task) => <div className={`planTaskRow ${task.status}`} key={task.id}><span className="planTaskState" aria-hidden="true">{task.status === "completed" ? "✓" : task.status === "in_progress" ? "■" : "□"}</span><div><strong>{task.subject}</strong>{task.blockedBy.length > 0 && <small>Blocked by {task.blockedBy.join(", ")}</small>}</div></div>)}</div>
                    <div className="planTaskCaution"><strong>Agent-maintained checklist</strong><span>Updates only when the agent changes it. It may be stale and does not represent live execution.</span></div>
                  </PopoverFrame>
                )}
              </div>
            )}
          </div>
          <div className="agentMeta">
            {assignment && <span className="agentMetaIdentity" dir="auto">{agent.label}</span>}
            {workflow && <span className="workflowProvenance" dir="auto">{workflow.name}{phase ? ` · ${phase.label}` : ""}</span>}
            <span className="agentMetaKind">{agent.role || "unknown"}</span><span className="agentMetaRuntime">{agent.model} · {agent.effort} effort</span><span className="agentMetaCacheLifetime">{cacheLifetimeLabel(agent.cacheLifetime)}</span><span className="agentMetaTools">{agent.toolCalls} tool {agent.toolCalls === 1 ? "call" : "calls"}</span>
          </div>
        </div>
        <div className="agentTokens" title="Latest non-zero provider usage snapshot for this agent; not cumulative token use."><strong>{compactNumber(agent.tokens.total)}</strong><span>{historical ? "final context" : "latest context"}</span></div>
        <div className="agentDuration"><strong><AgentWallTimeText agent={agent} /></strong><span>wall time</span></div>
        <div className="agentState">
          <span className={`statusPill ${agent.status}`}>{agent.status !== "idle" && agent.status !== "finished" && <i />}{agent.status === "needs_input" ? "needs input" : agent.status}</span>
          <AgentTurnCacheTiming agentId={agent.id} historical={historical} requestSnapshots={requestSnapshots} />
        </div>
      </div>
    );
  };

  return (
    <article className={`panel agentsPanel agentsPanel-${viewMode} ${openPopover ? "hasOpenPopover" : ""}`.trim()} data-session-id={sessionId}>
      <PanelHeader
        title="Agent activity"
        trailing={<div className="agentViewControls" aria-label="Agent activity controls" role="group"><span className="quiet">{agents.length} observed</span>{finishedAgentCount > 0 && <button aria-pressed={showFinished} className="agentFinishedToggle" onClick={toggleFinishedAgents} title={showFinished ? "Hide finished and stopped subagents. Ancestors of visible agents remain shown." : "Show finished and stopped subagents."} type="button"><span className="agentFinishedToggleMark" aria-hidden="true" />Show finished <span className="agentFinishedCount">({finishedAgentCount})</span></button>}<span className="agentViewMode" aria-label="Agent activity view" role="group"><button aria-pressed={viewMode === "list"} className="agentViewButton" onClick={() => onViewModeChange("list")} type="button">List</button><button aria-pressed={viewMode === "tree"} className="agentViewButton" onClick={() => onViewModeChange("tree")} type="button">Tree</button></span></div>}
      />
      {viewMode === "list" ? <div className="agentList">
        {agents.length === 0 && <EmptyState text="No agents have appeared in this session yet." />}
        {agentRows.length > 0 && <div className="agentRows" role="list" aria-label="Session agents">{agentRows.map(renderAgentRow)}</div>}
      </div> : <AgentTreeView agents={visibleAgents} cacheRefills={cacheRefills} cacheReadDrops={cacheReadDrops} contextBoundaries={contextBoundaries} historical={historical} requestSnapshots={requestSnapshots} sessionId={sessionId} workflows={workflows} />}
    </article>
  );
}
