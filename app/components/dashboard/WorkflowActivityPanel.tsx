"use client";

import type { Agent, Workflow } from "../../../shared/monitor-contract";
import { compactNumber, formatDuration } from "../../dashboard-utils";
import { liveWallTimeMs } from "../../formatting.mjs";
import { useLiveNow } from "../../hooks/LiveClockContext";
import { DashboardDisclosurePanel } from "./DashboardDisclosurePanel";

const workflowOrder: Record<Workflow["status"], number> = {
  running: 0,
  unknown: 1,
  completed: 2,
};

function statusLabel(status: Workflow["status"]) {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  return "Status unknown";
}

function wallTimeLabel(durationMs: number) {
  return durationMs < 60_000 ? "Less than 1m" : formatDuration(durationMs);
}

function linkedAgents(workflow: Workflow, agentsById: Map<string, Agent>) {
  return [...new Set(workflow.agentIds)].flatMap((id) => {
    const agent = agentsById.get(id);
    return agent ? [agent] : [];
  });
}

function phaseAgents(phaseAgentIds: string[], agentsById: Map<string, Agent>) {
  return [...new Set(phaseAgentIds)].flatMap((id) => {
    const agent = agentsById.get(id);
    return agent ? [agent] : [];
  });
}

function workflowContext(workflow: Workflow, agentsById: Map<string, Agent>) {
  return linkedAgents(workflow, agentsById).reduce((total, agent) => total + agent.tokens.total, 0);
}

function workflowWallTime(workflow: Workflow, historical: boolean, now: number) {
  return liveWallTimeMs(workflow.durationMs, workflow.startedAt, !historical && workflow.status === "running", now);
}

function compactSummary(workflows: Workflow[], agentsById: Map<string, Agent>, historical: boolean, now: number) {
  const agentIds = new Set(workflows.flatMap((workflow) => workflow.agentIds));
  const observedAgents = [...agentIds].flatMap((id) => {
    const agent = agentsById.get(id);
    return agent ? [agent] : [];
  });
  const context = observedAgents.reduce((total, agent) => total + agent.tokens.total, 0);
  const running = workflows.filter((workflow) => workflow.status === "running").length;
  const unknown = workflows.filter((workflow) => workflow.status === "unknown").length;
  const longestDuration = Math.max(0, ...workflows.map((workflow) => workflowWallTime(workflow, historical, now)));
  const status = workflows.length === 1
    ? statusLabel(workflows[0].status)
    : running > 0
      ? `${running} running`
      : unknown > 0
        ? `${unknown} unknown`
        : "Completed";

  return (
    <span className="disclosureSummaryMetrics workflowDisclosureSummary">
      <span><b dir="auto">{workflows.length === 1 ? workflows[0].name : `${workflows.length} workflows`}</b></span>
      <span>{status}</span>
      <span>{observedAgents.length}{observedAgents.length === 1 ? " agent" : " agents"}</span>
      <span>{wallTimeLabel(longestDuration)} {workflows.length > 1 ? "max wall time" : "wall time"}</span>
      <span><b>{compactNumber(context)}</b> context</span>
    </span>
  );
}

export function WorkflowActivityPanel({ agents, historical, sessionId, workflows }: {
  agents: Agent[];
  historical: boolean;
  sessionId: string;
  workflows: Workflow[];
}) {
  if (workflows.length === 0) return null;

  return <WorkflowActivityContent agents={agents} historical={historical} sessionId={sessionId} workflows={workflows} />;
}

function WorkflowActivityContent({ agents, historical, sessionId, workflows }: {
  agents: Agent[];
  historical: boolean;
  sessionId: string;
  workflows: Workflow[];
}) {
  const now = useLiveNow();

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const orderedWorkflows = [...workflows].sort((left, right) => {
    const byStatus = workflowOrder[left.status] - workflowOrder[right.status];
    if (byStatus !== 0) return byStatus;
    return (right.updatedAt || right.startedAt || "").localeCompare(left.updatedAt || left.startedAt || "");
  });
  const defaultOpen = !historical && workflows.some((workflow) => workflow.status === "running");

  return (
    <DashboardDisclosurePanel
      className="workflowActivityPanel"
      bodyClassName="workflowActivityBody"
      defaultOpen={defaultOpen}
      storageKey={`pomegr-workflow-panel-open-${sessionId}`}
      summary={compactSummary(workflows, agentsById, historical, now)}
      title="Workflow activity"
    >
      <div className="workflowRunList">
        {orderedWorkflows.map((workflow) => {
          const workers = linkedAgents(workflow, agentsById);
          const context = workflowContext(workflow, agentsById);
          return (
            <section className="workflowRun" aria-label={`${workflow.name} workflow`} key={workflow.id}>
              <header className="workflowRunHeader">
                <div className="workflowRunIdentity">
                  <h3 dir="auto">{workflow.name}</h3>
                  {workflow.summary && <p dir="auto">{workflow.summary}</p>}
                </div>
                <span className={`workflowStatus workflowStatus-${workflow.status}`}><i aria-hidden="true" />{statusLabel(workflow.status)}</span>
              </header>

              <div className="workflowRunMetrics" aria-label={`${workflow.name} workflow measurements`}>
                <span><strong>{workers.length}</strong>{workers.length === 1 ? " observed agent" : " observed agents"}</span>
                <span><strong>{compactNumber(context)}</strong> context</span>
                <span><strong>{wallTimeLabel(workflowWallTime(workflow, historical, now))}</strong> wall time</span>
              </div>

              {workers.length > 0 && (
                <div className="workflowWorkers">
                  <h4>Observed workers</h4>
                  <div className="workflowWorkerList">
                    {workers.map((worker) => <span dir="auto" key={worker.id}>{worker.label}</span>)}
                  </div>
                </div>
              )}

              {workflow.phases.length > 0 ? (
                <div className="workflowPhases">
                  <h4>Verified phases</h4>
                  <ol>
                    {workflow.phases.map((phase) => {
                      const workersInPhase = phaseAgents(phase.agentIds, agentsById);
                      return (
                        <li key={phase.id}>
                          <span className="workflowPhaseIndex" aria-hidden="true" />
                          <strong dir="auto">{phase.label}</strong>
                          <span className="workflowPhaseAgents">
                            {workersInPhase.length > 0
                              ? workersInPhase.map((worker) => <span dir="auto" key={worker.id}>{worker.label}</span>)
                              : <em>No agents recorded</em>}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ) : (
                <p className="workflowPhaseUnavailable">
                  {workflow.status === "running"
                    ? "Live phase detail unavailable."
                    : "No structured phase detail was recorded."}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </DashboardDisclosurePanel>
  );
}
