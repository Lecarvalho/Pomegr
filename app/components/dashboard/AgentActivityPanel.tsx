"use client";

import { useCallback, useRef, useState, type CSSProperties } from "react";
import type { Agent, ExecutionTask, PlanTask } from "../../../shared/monitor-contract";
import { agentTreeRows, compactNumber, relativeTime } from "../../dashboard-utils";
import { formatAgentWallTime } from "../../formatting.mjs";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { AgentChip } from "../AgentChip";
import { EmptyState } from "../EmptyState";
import { ExecutionTaskRow } from "../ExecutionTaskRow";
import { PanelHeader } from "../PanelHeader";
import { PopoverFrame } from "../PopoverFrame";

type OpenAgentPopover = { kind: "skills" | "execution" | "plan"; agentId: string } | null;

export function AgentActivityPanel({ agents, executionTasks, planTasks, historical }: {
  agents: Agent[];
  executionTasks: ExecutionTask[];
  planTasks: PlanTask[];
  historical: boolean;
}) {
  const [openPopover, setOpenPopover] = useState<OpenAgentPopover>(null);
  const popoverAnchorRef = useRef<HTMLDivElement | null>(null);
  const closePopover = useCallback(() => setOpenPopover(null), []);
  useDismissibleLayer(Boolean(openPopover), popoverAnchorRef, closePopover);
  const agentRows = agentTreeRows(agents);
  const executionTasksByAgent = new Map(agents.map((agent) => [agent.id, agent.executionTasks || (agent.id === "primary" ? executionTasks : [])]));
  const completedPlanTasks = planTasks.filter((task) => task.status === "completed").length;
  const activePlanTasks = planTasks.filter((task) => task.status === "in_progress").length;
  const openPlanTasks = planTasks.length - completedPlanTasks - activePlanTasks;
  const isOpen = (kind: NonNullable<OpenAgentPopover>["kind"], agentId: string) => openPopover?.kind === kind && openPopover.agentId === agentId;
  const toggle = (kind: NonNullable<OpenAgentPopover>["kind"], agentId: string) => setOpenPopover((current) => current?.kind === kind && current.agentId === agentId ? null : { kind, agentId });

  return (
    <article className="panel agentsPanel">
      <PanelHeader eyebrow="ORCHESTRATION" title="Agent activity" trailing={<span className="quiet">{agents.length} observed</span>} />
      <div className="agentList">
        {agents.length === 0 && <EmptyState text="No Claude Code agents detected yet." />}
        {agentRows.map(({ agent, depth }) => {
          const tasks = executionTasksByAgent.get(agent.id) || [];
          const runningTasks = tasks.filter((task) => task.status === "running");
          const finishedTasks = tasks.filter((task) => task.status !== "running");
          const rowPopoverOpen = openPopover?.agentId === agent.id;
          return (
            <div className={`agentRow ${depth > 0 ? "childAgent" : "rootAgent"} ${agent.status}Agent ${rowPopoverOpen ? "agentPopoverOpen" : ""}`} key={agent.id} style={{ "--agent-indent": `${Math.min(depth, 8) * 20}px` } as CSSProperties}>
              <div className="treeRail"><span className={agent.id === "primary" ? "primaryNode" : "agentNode"} /></div>
              <div className="agentIdentity">
                <div className="agentTitleLine">
                  <strong>{agent.label}</strong>
                  {agent.signal && <AgentChip className={`agentSignal ${agent.signal.tone}`} title="Reported by this agent through the Threadlight MCP tool">{agent.signal.label}</AgentChip>}
                  {agent.skills.length > 0 && (
                    <div className="agentPopoverAnchor skillPopoverAnchor" ref={isOpen("skills", agent.id) ? popoverAnchorRef : undefined}>
                      <AgentChip as="button" className="skillPopoverTrigger" onClick={() => toggle("skills", agent.id)} expanded={isOpen("skills", agent.id)} controls={`agent-skills-${agent.id}`}>{agent.skills.length} {agent.skills.length === 1 ? "skill" : "skills"}</AgentChip>
                      {isOpen("skills", agent.id) && (
                        <PopoverFrame id={`agent-skills-${agent.id}`} ariaLabel={`Skills used by ${agent.label}`} eyebrow="SKILL USAGE" title={agent.label} closeLabel="Close skill usage" onClose={closePopover} summary={`${agent.skills.length} ${agent.skills.length === 1 ? "skill" : "skills"} invoked · normalized metadata only`} className="skillPopover">
                          <div className="skillPopoverList">{agent.skills.map((skill) => <div className="skillPopoverRow" key={skill.name}><div><strong>{skill.name}</strong><small>{skill.lastUsed ? `Last used ${relativeTime(skill.lastUsed)}` : "Use time unavailable"}</small></div><div><strong>{skill.calls}</strong><small>{skill.calls === 1 ? "use" : "uses"}</small></div></div>)}</div>
                        </PopoverFrame>
                      )}
                    </div>
                  )}
                  {tasks.length > 0 && (
                    <div className="agentPopoverAnchor executionTaskAnchor" ref={isOpen("execution", agent.id) ? popoverAnchorRef : undefined}>
                      <AgentChip as="button" className="executionTaskTrigger" onClick={() => toggle("execution", agent.id)} expanded={isOpen("execution", agent.id)} controls={`agent-execution-tasks-${agent.id}`}>{runningTasks.length > 0 ? `${runningTasks.length} running` : `${finishedTasks.length} shell tasks`}</AgentChip>
                      {isOpen("execution", agent.id) && (
                        <PopoverFrame id={`agent-execution-tasks-${agent.id}`} ariaLabel={`Background tasks for ${agent.label}`} eyebrow="EXECUTION TASKS" title={agent.label} closeLabel="Close execution tasks" onClose={closePopover} summary={`${runningTasks.length} running · ${finishedTasks.length} recently finished`} className="executionTaskPopover">
                          <div className="executionTaskList">
                            {runningTasks.length > 0 && <section className="executionTaskSection" aria-label="Running execution tasks"><h3>Running</h3>{runningTasks.map((task) => <ExecutionTaskRow task={task} key={task.id} />)}</section>}
                            {finishedTasks.length > 0 && <section className="executionTaskSection" aria-label="Finished execution tasks"><h3>Recent finished {finishedTasks.length}</h3>{finishedTasks.map((task) => <ExecutionTaskRow task={task} key={task.id} />)}</section>}
                          </div>
                        </PopoverFrame>
                      )}
                    </div>
                  )}
                  {agent.id === "primary" && planTasks.length > 0 && (
                    <div className="agentPopoverAnchor planTaskAnchor" ref={isOpen("plan", agent.id) ? popoverAnchorRef : undefined}>
                      <AgentChip as="button" className="planTaskTrigger" onClick={() => toggle("plan", agent.id)} expanded={isOpen("plan", agent.id)} controls="primary-agent-plan-tasks">{planTasks.length} plan items</AgentChip>
                      {isOpen("plan", agent.id) && (
                        <PopoverFrame id="primary-agent-plan-tasks" ariaLabel="Claude plan checklist" eyebrow="CLAUDE PLAN" title="Plan checklist" closeLabel="Close plan checklist" onClose={closePopover} summary={`${completedPlanTasks} done · ${activePlanTasks} in progress · ${openPlanTasks} open`} className="planTaskPopover">
                          <div className="planTaskList">{planTasks.map((task) => <div className={`planTaskRow ${task.status}`} key={task.id}><span className="planTaskState" aria-hidden="true">{task.status === "completed" ? "✓" : task.status === "in_progress" ? "■" : "□"}</span><div><strong>{task.subject}</strong>{task.blockedBy.length > 0 && <small>Blocked by {task.blockedBy.join(", ")}</small>}</div></div>)}</div>
                          <div className="planTaskCaution"><strong>Agent-maintained checklist</strong><span>Static until Claude updates it. Claude may forget, so do not treat this as live execution truth.</span></div>
                        </PopoverFrame>
                      )}
                    </div>
                  )}
                </div>
                <div className="agentMeta"><span className="agentMetaKind">{agent.kind}</span><span className="agentMetaRuntime">{agent.model} · {agent.effort} effort</span><span className="agentMetaTools">{agent.toolCalls} tools</span></div>
              </div>
              <div className="agentTokens"><strong>{compactNumber(agent.tokens.total)}</strong><span>{historical ? "recorded context" : "current context"}</span></div>
              <div className="agentDuration"><strong>{formatAgentWallTime(agent)}</strong><span>wall time</span></div>
              <span className={`statusPill ${agent.status}`}><i />{agent.status === "needs_input" ? "needs input" : agent.status}</span>
              <time>{relativeTime(agent.lastSeen)}</time>
            </div>
          );
        })}
      </div>
    </article>
  );
}
