"use client";

import { Fragment } from "react";
import type { Agent, MonitorState, Workflow } from "../../../shared/monitor-contract";
import { compactNumber, formatDuration } from "../../dashboard-utils";
import { InsightsPanel } from "./InsightsPanel";
import { SessionProgressPanel } from "./SessionProgressPanel";

function workflowStatus(workflows: Workflow[]) {
  if (workflows.some((workflow) => workflow.status === "running")) return "running" as const;
  if (workflows.length > 0 && workflows.every((workflow) => workflow.status === "completed")) return "completed" as const;
  return "unknown" as const;
}

function workflowStatusLabel(status: ReturnType<typeof workflowStatus>) {
  return status === "running" ? "Running" : status === "completed" ? "Completed" : "Unknown";
}

function workflowAgentIds(workflows: Workflow[], agents: Agent[]) {
  const ids = new Set<string>();
  for (const workflow of workflows) {
    for (const agentId of workflow.agentIds) ids.add(agentId);
    for (const agent of agents) if (agent.workflowId === workflow.id) ids.add(agent.id);
  }
  return ids;
}

function workflowWallTime(workflows: Workflow[]) {
  return workflows.reduce((total, workflow) => total + Math.max(0, workflow.durationMs), 0);
}

function WorkflowSummaryCard({ state }: { state: MonitorState }) {
  const workflows = state.workflows || [];
  const agents = state.agents || [];
  const ids = workflowAgentIds(workflows, agents);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const context = [...ids].reduce((total, id) => total + (agentsById.get(id)?.tokens.total || 0), 0);
  const duration = workflowWallTime(workflows);
  const status = workflowStatus(workflows);
  const agentEvidence = state.readiness?.agentEvidence;
  const contextEvidence = state.readiness?.contextEvidence;
  const agentEvidenceAvailable = agentEvidence === undefined || agentEvidence === "ready";
  const contextEvidenceAvailable = contextEvidence === undefined || contextEvidence === "ready";
  const loading = workflows.length === 0 && agentEvidence === "loading";
  const unavailable = workflows.length === 0 && agentEvidence === "unavailable";

  return <article className="sessionSummaryCard sessionWorkflowCard panel">
    <div className="sessionSummaryCardHeader">
      <span className="sessionEyebrow">Workflows</span>
      {workflows.length > 0 && <span className={`sessionSummaryChip sessionWorkflowStatus sessionWorkflowStatus-${status}`}><i aria-hidden="true" />{workflowStatusLabel(status)}</span>}
    </div>
    <div className="sessionSummaryHeadline">
      <strong className="sessionSummaryNumber">{loading || unavailable ? "—" : workflows.length}</strong>
      {workflows.length > 0 && <span>{agentEvidenceAvailable ? ids.size : "—"} agents · <span className="sessionSummaryData">{formatDuration(duration)}</span> wall · <span className="sessionSummaryData">{contextEvidenceAvailable ? compactNumber(context) : "—"}</span> context</span>}
    </div>
    {loading
      ? <p className="sessionSummaryLoading" role="status">Loading workflow evidence…</p>
      : unavailable
        ? <p className="sessionSummaryUnavailable">Workflow evidence unavailable.</p>
        : workflows.length === 0
        ? <p className="sessionSummaryEmpty">No workflows recorded for this session.</p>
        : <>
          <dl className="sessionKv sessionWorkflowList">
            {workflows.slice(0, 3).map((workflow) => <Fragment key={workflow.id}><dt dir="auto">{workflow.name}</dt><dd>{agentEvidenceAvailable ? workflow.agentIds.length : "—"} agents · {formatDuration(workflow.durationMs)}</dd></Fragment>)}
          </dl>
          <a className="sessionSummaryLink" href="#agent-activity">Open workflow detail</a>
        </>}
  </article>;
}

type SessionSummaryCardsProps = {
  state: MonitorState;
  historical: boolean;
  paused: boolean;
  needsInput: boolean;
};

export function SessionSummaryCards(props: SessionSummaryCardsProps) {
  const { state, historical, paused, needsInput } = props;
  const progress = state.session?.progress;

  return <section className="sessionSummaryCards" aria-label="Session summary">
    <SessionProgressPanel
      progress={progress}
      agents={state.agents}
      activity={state.activity}
      connected={state.connected}
      paused={paused}
      historical={historical}
      needsInput={needsInput}
      variant="compact"
    />
    <WorkflowSummaryCard state={state} />
    <InsightsPanel insights={state.insights} variant="compact" />
  </section>;
}
