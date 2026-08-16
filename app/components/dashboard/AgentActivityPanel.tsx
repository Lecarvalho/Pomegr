"use client";

import { useCallback, useRef, useState, type CSSProperties } from "react";
import type { Agent, ExecutionTask, PlanTask, Workflow } from "../../../shared/monitor-contract";
import { agentTreeRows, compactNumber } from "../../dashboard-utils";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { AgentChip } from "../AgentChip";
import { EmptyState } from "../EmptyState";
import { ExecutionTaskRow } from "../ExecutionTaskRow";
import { AgentWallTimeText, CoarseRelativeTimeText, RelativeTimeText } from "../LiveTime";
import { PanelHeader } from "../PanelHeader";
import { PopoverFrame } from "../PopoverFrame";

type OpenAgentPopover = { kind: "skills" | "execution" | "plan"; agentId: string } | null;

export function AgentActivityPanel({ agents, executionTasks, planTasks, workflows = [], historical }: {
  agents: Agent[];
  executionTasks: ExecutionTask[];
  planTasks: PlanTask[];
  workflows?: Workflow[];
  historical: boolean;
}) {
  const [openPopover, setOpenPopover] = useState<OpenAgentPopover>(null);
  const [workflowAgentsOpen, setWorkflowAgentsOpen] = useState(false);
  const popoverAnchorRef = useRef<HTMLDivElement | null>(null);
  const closePopover = useCallback(() => setOpenPopover(null), []);
  useDismissibleLayer(Boolean(openPopover), popoverAnchorRef, closePopover);
  const agentRows = agentTreeRows(agents);
  const executionTasksByAgent = new Map(agents.map((agent) => [agent.id, agent.executionTasks || (agent.id === "primary" ? executionTasks : [])]));
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const phasesByWorkflowId = new Map(workflows.map((workflow) => [workflow.id, new Map(workflow.phases.map((phase) => [phase.id, phase]))]));
  const labelCounts = new Map<string, number>();
  for (const agent of agents) labelCounts.set(agent.label, (labelCounts.get(agent.label) || 0) + 1);
  const workflowRows = agentRows
    .filter(({ agent }) => Boolean(agent.workflowId && workflowsById.has(agent.workflowId)))
    .sort((left, right) => {
      const byWorkflow = (left.agent.workflowId || "").localeCompare(right.agent.workflowId || "");
      if (byWorkflow !== 0) return byWorkflow;
      const leftOrder = left.agent.workflowOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.agent.workflowOrder ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.agent.id.localeCompare(right.agent.id);
    });
  const standardRows = agentRows.filter(({ agent }) => !agent.workflowId || !workflowsById.has(agent.workflowId));
  const completedPlanTasks = planTasks.filter((task) => task.status === "completed").length;
  const activePlanTasks = planTasks.filter((task) => task.status === "in_progress").length;
  const openPlanTasks = planTasks.length - completedPlanTasks - activePlanTasks;
  const isOpen = (kind: NonNullable<OpenAgentPopover>["kind"], agentId: string) => openPopover?.kind === kind && openPopover.agentId === agentId;
  const toggle = (kind: NonNullable<OpenAgentPopover>["kind"], agentId: string) => setOpenPopover((current) => current?.kind === kind && current.agentId === agentId ? null : { kind, agentId });

  const renderAgentRow = ({ agent, depth }: { agent: Agent; depth: number }) => {
    const tasks = executionTasksByAgent.get(agent.id) || [];
    const runningTasks = tasks.filter((task) => task.status === "running");
    const finishedTasks = tasks.filter((task) => task.status !== "running");
    const currentActivity = historical ? null : agent.currentActivity;
    const rowPopoverOpen = openPopover?.agentId === agent.id;
    const workflow = agent.workflowId ? workflowsById.get(agent.workflowId) : null;
    const phase = agent.workflowId && agent.workflowPhaseId ? phasesByWorkflowId.get(agent.workflowId)?.get(agent.workflowPhaseId) : null;
    const accessibleLabel = (labelCounts.get(agent.label) || 0) > 1
      ? `${agent.label} agent ${agent.id.slice(-6)}`
      : `${agent.label} agent`;

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
            <strong dir="auto">{agent.label}</strong>
            {agent.signal && <AgentChip className={`agentSignal ${agent.signal.tone}`} title={agent.signal.description || "Reported by this agent through the Pomegr MCP tool"}>{agent.signal.label}</AgentChip>}
            {agent.skills.length > 0 && (
              <div className="agentPopoverAnchor skillPopoverAnchor" ref={isOpen("skills", agent.id) ? popoverAnchorRef : undefined}>
                <AgentChip as="button" className="skillPopoverTrigger" onClick={() => toggle("skills", agent.id)} expanded={isOpen("skills", agent.id)} controls={`agent-skills-${agent.id}`}>{agent.skills.length} {agent.skills.length === 1 ? "skill" : "skills"}</AgentChip>
                {isOpen("skills", agent.id) && (
                  <PopoverFrame id={`agent-skills-${agent.id}`} ariaLabel={`Skills used by ${agent.label}`} eyebrow="SKILL USAGE" title={agent.label} closeLabel="Close skill usage" onClose={closePopover} summary={`${agent.skills.length} recorded ${agent.skills.length === 1 ? "skill" : "skills"} · metadata only`} className="skillPopover">
                    <div className="skillPopoverList">{agent.skills.map((skill) => <div className="skillPopoverRow" key={skill.name}><div><strong>{skill.name}</strong><small>{skill.lastUsed ? <>Last used <RelativeTimeText value={skill.lastUsed} /></> : "Use time unavailable"}</small></div><div><strong>{skill.calls}</strong><small>{skill.calls === 1 ? "use" : "uses"}</small></div></div>)}</div>
                  </PopoverFrame>
                )}
              </div>
            )}
            {(tasks.length > 0 || currentActivity) && (
              <div className="agentPopoverAnchor executionTaskAnchor" ref={isOpen("execution", agent.id) ? popoverAnchorRef : undefined}>
                <AgentChip as="button" className="executionTaskTrigger" onClick={() => toggle("execution", agent.id)} expanded={isOpen("execution", agent.id)} controls={`agent-execution-tasks-${agent.id}`}>{tasks.length > 0 ? (runningTasks.length > 0 ? `${runningTasks.length} running` : `${finishedTasks.length} shell ${finishedTasks.length === 1 ? "task" : "tasks"}`) : "Current activity"}</AgentChip>
                {isOpen("execution", agent.id) && (
                  <PopoverFrame id={`agent-execution-tasks-${agent.id}`} ariaLabel={`Activity and execution for ${agent.label}`} eyebrow="ACTIVITY & EXECUTION" title={agent.label} closeLabel="Close activity and execution" onClose={closePopover} summary={`${runningTasks.length} running · ${finishedTasks.length} finished`} className="executionTaskPopover">
                    <div className="executionTaskList">
                      {currentActivity && <section className="executionTaskSection currentActivitySection" aria-label="Current provider-reported activity"><h3>Current activity</h3><div className="currentActivityRow"><span className="currentActivityMark" aria-hidden="true" /><div><strong>{currentActivity.label}</strong><small>Provider-reported · observed <RelativeTimeText value={currentActivity.observedAt} /></small></div></div></section>}
                      {runningTasks.length > 0 && <section className="executionTaskSection" aria-label="Running execution tasks"><h3>Running</h3>{runningTasks.map((task) => <ExecutionTaskRow task={task} key={task.id} />)}</section>}
                      {finishedTasks.length > 0 && <section className="executionTaskSection" aria-label="Finished execution tasks"><h3>Recently finished ({finishedTasks.length})</h3>{finishedTasks.map((task) => <ExecutionTaskRow task={task} key={task.id} />)}</section>}
                    </div>
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
            {workflow && <span className="workflowProvenance" dir="auto">{workflow.name}{phase ? ` · ${phase.label}` : ""}</span>}
            <span className="agentMetaKind">{agent.kind}</span><span className="agentMetaRuntime">{agent.model} · {agent.effort} effort</span><span className="agentMetaTools">{agent.toolCalls} tool {agent.toolCalls === 1 ? "call" : "calls"}</span>
          </div>
        </div>
        <div className="agentTokens" title="Latest non-zero provider usage snapshot for this agent; not cumulative token use."><strong>{compactNumber(agent.tokens.total)}</strong><span>{historical ? "final context" : "latest context"}</span></div>
        <div className="agentDuration"><strong><AgentWallTimeText agent={agent} /></strong><span>wall time</span></div>
        <div className="agentState">
          <span className={`statusPill ${agent.status}`}><i />{agent.status === "needs_input" ? "needs input" : agent.status}</span>
          <time dateTime={agent.lastSeen || undefined}>updated <CoarseRelativeTimeText value={agent.lastSeen} /></time>
        </div>
      </div>
    );
  };

  return (
    <article className={`panel agentsPanel ${openPopover ? "hasOpenPopover" : ""}`.trim()}>
      <PanelHeader title="Agent activity" trailing={<span className="quiet">{agents.length} observed</span>} />
      <div className="agentList">
        {agents.length === 0 && <EmptyState text="No agents have appeared in this session yet." />}
        {standardRows.length > 0 && <div className="agentRows" role="list" aria-label="Session agents">{standardRows.map(renderAgentRow)}</div>}
        {workflowRows.length > 0 && (
          <div className={`workflowAgentGroup ${workflowAgentsOpen ? "open" : ""}`}>
            <button aria-controls="workflow-agent-resource-details" aria-expanded={workflowAgentsOpen} className="workflowAgentGroupSummary" onClick={() => setWorkflowAgentsOpen((open) => !open)} type="button">
              <span className="workflowAgentGroupIcon" aria-hidden="true" />
              <strong>Workflow agents</strong>
              <span>{workflowRows.length} {workflowRows.length === 1 ? "resource row" : "resource rows"}</span>
            </button>
            {workflowAgentsOpen && <div className="workflowAgentRows" id="workflow-agent-resource-details" role="list" aria-label="Workflow agent resource details">{workflowRows.map(renderAgentRow)}</div>}
          </div>
        )}
      </div>
    </article>
  );
}
