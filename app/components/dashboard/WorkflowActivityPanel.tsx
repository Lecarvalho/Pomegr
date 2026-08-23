"use client";

import type { Agent, Workflow } from "../../../shared/monitor-contract";
import { compactNumber, formatDuration } from "../../dashboard-utils";
import { liveWallTimeMs } from "../../formatting.mjs";
import { useLiveNow } from "../../hooks/LiveClockContext";
import { DashboardDisclosurePanel } from "./DashboardDisclosurePanel";

const workflowOrder: Record<Workflow["status"], number> = { running: 0, unknown: 1, completed: 2 };

function statusLabel(status: Workflow["status"]) {
  return status === "running" ? "Running" : status === "completed" ? "Completed" : "Status unknown";
}

function wallTimeLabel(durationMs: number) {
  return durationMs < 60_000 ? "Less than 1m" : formatDuration(durationMs);
}

function workflowWallTime(workflow: Workflow, historical: boolean, now: number) {
  return liveWallTimeMs(workflow.durationMs, workflow.startedAt, !historical && workflow.status === "running", now);
}

function linkedAgents(workflow: Workflow, agentsById: Map<string, Agent>) {
  const ids = new Set(workflow.agentIds);
  for (const agent of agentsById.values()) if (agent.workflowId === workflow.id) ids.add(agent.id);
  return [...ids].flatMap((id) => agentsById.has(id) ? [agentsById.get(id)!] : []);
}

function phaseProgress(workflow: Workflow, agentsById: Map<string, Agent>) {
  const workflowAgentIds = new Set(workflow.agentIds);
  return workflow.phases.map((phase) => {
    const ids = new Set(phase.agentIds);
    for (const agent of agentsById.values()) if (agent.workflowId === workflow.id && agent.workflowPhaseId === phase.id) ids.add(agent.id);
    const members = [...ids].flatMap((id) => {
      const agent = agentsById.get(id);
      return agent && (agent.workflowId === workflow.id || workflowAgentIds.has(id)) ? [agent] : [];
    });
    const finished = members.filter((agent) => agent.workflowState === "done" || agent.workflowState === "error").length;
    const state = members.length === 0 ? "No agents observed" : members.some((agent) => agent.workflowState === "running") ? "Active" : finished === members.length ? "Complete" : "In progress";
    return { phase, finished, observed: members.length, state };
  });
}

function metadataLabel(workflow: Workflow) {
  return workflow.metadataStatus === "ready" ? "Phase metadata ready" : workflow.metadataStatus === "pending" ? "Phase metadata pending" : "Phase metadata unavailable";
}

function compactSummary(workflows: Workflow[], agentsById: Map<string, Agent>, historical: boolean, now: number) {
  const observed = [...new Map(
    workflows.flatMap((workflow) => linkedAgents(workflow, agentsById)).map((agent) => [agent.id, agent]),
  ).values()];
  const context = observed.reduce((sum, agent) => sum + agent.tokens.total, 0);
  const running = workflows.filter((workflow) => workflow.status === "running").length;
  const duration = Math.max(0, ...workflows.map((workflow) => workflowWallTime(workflow, historical, now)));
  return <span className="disclosureSummaryMetrics workflowDisclosureSummary"><span><b>{workflows.length}</b> workflows</span><span>{running ? `${running} running` : "Completed"}</span><span>{observed.length} {observed.length === 1 ? "agent" : "agents"}</span><span>{wallTimeLabel(duration)} wall time</span><span><b>{compactNumber(context)}</b> context</span></span>;
}

export function WorkflowActivityPanel({ agents, historical, sessionId, workflows, viewMode = "list" }: {
  agents: Agent[];
  historical: boolean;
  sessionId: string;
  workflows: Workflow[];
  viewMode?: "list" | "tree";
}) {
  const now = useLiveNow();
  if (workflows.length === 0) return null;
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const ordered = [...workflows].sort((left, right) => workflowOrder[left.status] - workflowOrder[right.status] || (right.updatedAt || "").localeCompare(left.updatedAt || "") || left.id.localeCompare(right.id));
  return <DashboardDisclosurePanel className="workflowActivityPanel" bodyClassName="workflowActivityBody" defaultOpen={!historical} storageKey={`pomegr-workflow-panel-open-${sessionId}`} summary={compactSummary(ordered, agentsById, historical, now)} title="Workflow activity">
    <div className="workflowRunList">
      {ordered.map((workflow) => {
        const observed = linkedAgents(workflow, agentsById);
        const context = observed.reduce((sum, agent) => sum + agent.tokens.total, 0);
        const phases = phaseProgress(workflow, agentsById);
        return <section className="workflowRun workflowRunSummary" aria-label={`${workflow.name} workflow`} key={workflow.id}>
          <header className="workflowRunHeader"><div className="workflowRunIdentity"><h3 dir="auto">{workflow.name}</h3>{workflow.summary && <p dir="auto">{workflow.summary}</p>}</div><span className={`workflowStatus workflowStatus-${workflow.status}`}><i aria-hidden="true" />{statusLabel(workflow.status)}</span></header>
          <div className="workflowRunMetrics" aria-label={`${workflow.name} workflow measurements`}><span><strong>{observed.length}</strong>{observed.length === 1 ? " observed agent" : " observed agents"}</span><span><strong>{compactNumber(context)}</strong> context</span><span><strong>{wallTimeLabel(workflowWallTime(workflow, historical, now))}</strong> wall time</span><span>{metadataLabel(workflow)}</span></div>
          {viewMode === "list" && (phases.length > 0 ? <ol className="workflowPhaseProgress" aria-label={`${workflow.name} phase progress`}>{phases.map(({ phase, finished, observed: phaseObserved, state }) => <li key={phase.id}><strong dir="auto">{phase.label}</strong><span>{state}</span><span>{finished}/{phaseObserved} finished</span></li>)}</ol> : <p className="workflowPhaseUnavailable">{workflow.metadataStatus === "pending" ? "Phase details have not been published for this running workflow yet." : workflow.metadataStatus === "unavailable" ? "Detailed workflow metadata was not published for this run." : "No workflow phases were recorded."}</p>)}
        </section>;
      })}
    </div>
  </DashboardDisclosurePanel>;
}
