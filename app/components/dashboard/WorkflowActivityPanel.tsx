"use client";

import { useState, type SyntheticEvent } from "react";
import type { Agent, Workflow, WorkflowPhase } from "../../../shared/monitor-contract";
import { compactNumber, formatDuration } from "../../dashboard-utils";
import { liveWallTimeMs } from "../../formatting.mjs";
import { useLiveNow } from "../../hooks/LiveClockContext";
import { AgentWallTimeText } from "../LiveTime";
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

function workerStateLabel(state: Agent["workflowState"]) {
  if (state === "running") return "Running";
  if (state === "done") return "Done";
  if (state === "error") return "Error";
  return "State unknown";
}

function wallTimeLabel(durationMs: number) {
  return durationMs < 60_000 ? "Less than 1m" : formatDuration(durationMs);
}

function compareWorkers(left: Agent, right: Agent, fallbackOrder: Map<string, number>) {
  const leftOrder = left.workflowOrder;
  const rightOrder = right.workflowOrder;
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) return leftOrder - rightOrder;
  if (leftOrder !== null && rightOrder === null) return -1;
  if (leftOrder === null && rightOrder !== null) return 1;
  const byFallback = (fallbackOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (fallbackOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
  if (byFallback !== 0) return byFallback;
  const byStart = (left.startedAt || "").localeCompare(right.startedAt || "");
  return byStart || left.id.localeCompare(right.id);
}

function linkedAgents(workflow: Workflow, agentsById: Map<string, Agent>) {
  const fallbackOrder = new Map(workflow.agentIds.map((id, index) => [id, index]));
  return [...new Set(workflow.agentIds)].flatMap((id) => {
    const agent = agentsById.get(id);
    return agent ? [agent] : [];
  }).sort((left, right) => compareWorkers(left, right, fallbackOrder));
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

function displayLabels(workers: Agent[]) {
  const counts = new Map<string, number>();
  for (const worker of workers) counts.set(worker.label, (counts.get(worker.label) || 0) + 1);
  return new Map(workers.map((worker) => [
    worker.id,
    (counts.get(worker.label) || 0) > 1 ? `${worker.label} · ${worker.id.slice(-6)}` : worker.label,
  ]));
}

function phaseWorkers(phase: WorkflowPhase, workers: Agent[]) {
  const memberIds = new Set(phase.agentIds);
  return workers.filter((worker) => memberIds.has(worker.id) || worker.workflowPhaseId === phase.id);
}

function phaseProgress(workers: Agent[]) {
  const finished = workers.filter((worker) => worker.workflowState === "done" || worker.workflowState === "error").length;
  const running = workers.some((worker) => worker.workflowState === "running");
  const state = workers.length === 0
    ? "upcoming"
    : finished === workers.length
      ? "completed"
      : running
        ? "active"
        : "unknown";
  return { finished, observed: workers.length, state } as const;
}

function WorkerList({ labels, title, workers }: { labels: Map<string, string>; title?: string; workers: Agent[] }) {
  if (workers.length === 0) return null;
  return (
    <div className="workflowWorkerGroup">
      {title && <h5>{title}</h5>}
      <ul className="workflowWorkerRows" aria-label={title || "Workflow workers"}>
        {workers.map((worker) => {
          const label = labels.get(worker.id) || worker.label;
          return (
            <li className={`workflowWorkerRow workflowWorkerState-${worker.workflowState || "unknown"}`} aria-label={`${label} worker ${worker.id.slice(-6)}`} key={worker.id}>
              <div className="workflowWorkerIdentity">
                <strong dir="auto">{label}</strong>
                <span>{workerStateLabel(worker.workflowState)}</span>
              </div>
              <div className="workflowWorkerMeasure" title="Latest non-zero provider usage snapshot for this agent; not cumulative token use.">
                <strong>{compactNumber(worker.tokens.total)}</strong>
                <span>latest context</span>
              </div>
              <div className="workflowWorkerMeasure">
                <strong><AgentWallTimeText agent={worker} /></strong>
                <span>wall time</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WorkflowPhaseDisclosure({ labels, phase, workers }: {
  labels: Map<string, string>;
  phase: WorkflowPhase;
  workers: Agent[];
}) {
  const progress = phaseProgress(workers);
  const [open, setOpen] = useState(progress.state === "active");
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open);
  const stateLabel = progress.state === "active"
    ? "Active"
    : progress.state === "completed"
      ? "Completed"
      : progress.state === "upcoming"
        ? "No workers observed"
        : "State unknown";

  return (
    <li>
      <details className={`workflowPhase workflowPhase-${progress.state}`} open={open} onToggle={handleToggle}>
        <summary aria-label={`${phase.label} phase, ${stateLabel}, ${progress.finished} of ${progress.observed} finished`}>
          <span className="workflowPhaseDisclosureIcon" aria-hidden="true" />
          <strong dir="auto">{phase.label}</strong>
          <span className="workflowPhaseState">{stateLabel}</span>
          <span className="workflowPhaseCount"><b>{progress.finished}/{progress.observed}</b> finished</span>
        </summary>
        {workers.length > 0
          ? <WorkerList labels={labels} workers={workers} />
          : <p className="workflowPhaseEmpty">No workers have been observed in this phase.</p>}
      </details>
    </li>
  );
}

function WorkflowReadyState({ labels, workflow, workers }: { labels: Map<string, string>; workflow: Workflow; workers: Agent[] }) {
  const assignedIds = new Set(workflow.phases.flatMap((phase) => [
    ...phase.agentIds,
    ...workers.filter((worker) => worker.workflowPhaseId === phase.id).map((worker) => worker.id),
  ]));
  const unassigned = workers.filter((worker) => !assignedIds.has(worker.id));
  const progress = workflow.phases.map((phase) => ({ phase, workers: phaseWorkers(phase, workers) }));
  const finished = workers.filter((worker) => worker.workflowState === "done" || worker.workflowState === "error").length;

  return (
    <div className="workflowPhases">
      <p className="visuallyHidden" aria-live="polite" aria-atomic="true">
        {workflow.name} workflow progress: {finished} of {workers.length} observed workers finished.
      </p>
      <h4>Phases</h4>
      {progress.length > 0 && (
        <ol>
          {progress.map(({ phase, workers: workersInPhase }) => (
            <WorkflowPhaseDisclosure labels={labels} phase={phase} workers={workersInPhase} key={phase.id} />
          ))}
        </ol>
      )}
      {unassigned.length > 0 && <WorkerList labels={labels} title="Unassigned workers" workers={unassigned} />}
      {progress.length === 0 && unassigned.length === 0 && <p className="workflowPhaseEmpty">No workflow workers were recorded.</p>}
    </div>
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
          const labels = displayLabels(workers);
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

              {workflow.metadataStatus === "ready" ? (
                <WorkflowReadyState labels={labels} workflow={workflow} workers={workers} />
              ) : (
                <div className="workflowMetadataFallback">
                  <p className="workflowPhaseUnavailable">
                    {workflow.metadataStatus === "pending"
                      ? "Claude Code has not published phase details for this running workflow yet."
                      : "Detailed workflow metadata was not published for this run. Worker activity remains available."}
                  </p>
                  <WorkerList labels={labels} workers={workers} />
                </div>
              )}
            </section>
          );
        })}
      </div>
    </DashboardDisclosurePanel>
  );
}
