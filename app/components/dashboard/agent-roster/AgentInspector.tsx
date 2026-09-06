"use client";

import type { Agent, CacheReadDropCount, CacheRefillCount, ContextHistoryBoundary, Insight, PlanTask, RequestSnapshotFeed, Workflow } from "../../../../shared/monitor-contract";
import { agentDisplayLabel, agentDisplayName, cacheLifetimeLabel, compactNumber, formatDuration } from "../../../dashboard-utils";
import { CopyTranscriptButton } from "../../CopyTranscriptButton";
import { EmptyState } from "../../EmptyState";
import { AgentWallTimeText, RelativeTimeText } from "../../LiveTime";
import { AgentHistoryIndicators, summarizeCacheReadDrops, summarizeCacheRefills, summarizeCompactions } from "../AgentHistoryIndicators";
import { AgentTurnCacheTiming } from "../AgentTurnCacheTiming";
import { AgentInspectorDetails } from "./AgentInspectorDetails";
import { AgentLineage } from "./AgentLineage";
import { InspectorSheet } from "./InspectorSheet";

const EMPTY_REQUESTS: RequestSnapshotFeed = { status: "unavailable", items: [] };
export function InspectorTreeGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v5m0 0-6 5m6-5 6 5" /></svg>; }

export type AgentInspectorProps = {
  agent: Agent | null; agents?: Agent[]; workflows?: Workflow[]; sessionId?: string; historical?: boolean;
  requestSnapshots?: RequestSnapshotFeed; cacheRefills?: CacheRefillCount[]; cacheReadDrops?: CacheReadDropCount[];
  contextBoundaries?: ContextHistoryBoundary[]; insights?: Insight[]; planTasks?: PlanTask[];
  onOpenTree: (agentId: string) => void; presentation?: "inline" | "sheet"; onClose?: () => void;
};

export function AgentInspector({ agent, agents = [], workflows = [], sessionId = "agent-activity", historical = false, requestSnapshots = EMPTY_REQUESTS, cacheRefills = [], cacheReadDrops = [], contextBoundaries = [], insights = [], planTasks = [], onOpenTree, presentation = "inline", onClose = () => {} }: AgentInspectorProps) {
  if (!agent) return <aside className="agentInspector"><EmptyState text="Select an agent to inspect it." /></aside>;
  const workflow = workflows.find((item) => item.id === agent.workflowId);
  const phase = workflow?.phases.find((item) => item.id === agent.workflowPhaseId);
  const label = agentDisplayLabel(agent);
  const ownInsights = insights.filter((item) => item.agentId === agent.id);
  const hasHistory = summarizeCompactions(contextBoundaries, [agent.id]).total + summarizeCacheRefills(cacheRefills, [agent.id]) + summarizeCacheReadDrops(cacheReadDrops, [agent.id]) > 0;
  const openTree = () => onOpenTree(agent.id);
  const body = <div className={`agentInspector agentInspector-${presentation}`} key={agent.id} role="region" aria-label={`Agent inspector for ${label}`}>
    <header className="inspectorHeader">
      {presentation === "inline" && <><span className="sessionEyebrow">Selected agent</span><h3 dir="auto">{agentDisplayName(agent)}</h3></>}
      <div className="inspectorStatus"><span className={`statusPill ${agent.status}`}>{agent.status === "needs_input" ? "needs input" : agent.status === "unknown" ? "status uncertain" : agent.status}</span>{agent.signal && <span className={`agentSignal ${agent.signal.tone}`}>{agent.signal.label}</span>}</div>
      <p>{[agent.role.replaceAll("-", " "), workflow?.name, phase ? `phase ${phase.label}` : null].filter(Boolean).join(" · ")} · <code>{agent.id.slice(-6)}</code></p>
      {agent.assignment && agent.assignment !== agent.label && <p>{agent.label}</p>}
    </header>
    <section className="inspectorSection"><div className="inspectorSectionHeading"><h4 className="sessionEyebrow">Lineage</h4>{presentation === "inline" && <button type="button" onClick={openTree}><InspectorTreeGlyph />Open in tree</button>}</div><AgentLineage agent={agent} agents={agents} workflows={workflows} /></section>
    <section className="inspectorSection" aria-label="Agent facts"><dl className="sessionKv inspectorFacts">
      <dt>Model</dt><dd>{agent.model}</dd><dt>Effort</dt><dd>{agent.effort}</dd>
      <dt>{historical ? "Final context" : "Latest context"}</dt><dd className="inspectorContext" title="Latest non-zero provider usage snapshot; not cumulative token use.">{compactNumber(agent.tokens.total)}</dd>
      <dt>Wall time</dt><dd>{historical ? formatDuration(agent.durationMs) : <AgentWallTimeText agent={agent} />}</dd>
      <dt>Tool calls</dt><dd>{agent.toolCalls.toLocaleString()}</dd><dt>Shell tasks</dt><dd>{agent.executionTasks?.length || 0}</dd>
      <dt>Cache lifetime</dt><dd>{cacheLifetimeLabel(agent.cacheLifetime).replace("cache TTL ", "")}</dd>
      <dt>Last turn</dt><dd><AgentTurnCacheTiming agentId={agent.id} historical={historical} requestSnapshots={requestSnapshots} status={agent.status} plain /></dd>
      <dt>Skills</dt><dd>{agent.skills.length}</dd>
    </dl></section>
    <AgentInspectorDetails key={`skills:${agent.id}`} agent={agent} presentation={presentation} section="skills" />
    <section className="inspectorSection inspectorSignals" aria-label="Agent signals"><h4 className="sessionEyebrow">Signals</h4>
      {agent.signal && <div className={`inspectorReportedSignal ${agent.signal.tone}`}><strong>{agent.signal.label}</strong>{agent.signal.description && <p>{agent.signal.description}</p>}<small>Agent-reported · <RelativeTimeText value={agent.signal.reportedAt} /></small></div>}
      {ownInsights.map((insight) => <div className={`inspectorInsight ${insight.level}`} key={insight.id}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 22 20H2L12 3Zm0 6v5m0 3v.5" /></svg><div><strong>{insight.title}</strong><p>{insight.detail}</p></div></div>)}
      <AgentHistoryIndicators key={agent.id} agentIds={[agent.id]} boundaries={contextBoundaries} cacheRefills={cacheRefills} cacheReadDrops={cacheReadDrops} expandedRows className="inspectorHistory" />
      {!agent.signal && ownInsights.length === 0 && !hasHistory && <p>No signals</p>}
    </section>
    <AgentInspectorDetails key={agent.id} agent={agent} planTasks={planTasks} historical={historical} presentation={presentation} section="activity" />
    <footer className="inspectorActions">{agent.transcriptAvailable && <CopyTranscriptButton key={agent.id} sessionId={sessionId} agentId={agent.id} agentLabel={label} showLabel />}{presentation === "sheet" && <button type="button" onClick={openTree}>Open in tree</button>}</footer>
  </div>;
  return presentation === "sheet" ? <InspectorSheet title={agentDisplayName(agent)} subtitle={`Agent ${Math.max(1, agents.findIndex((item) => item.id === agent.id) + 1)} of ${Math.max(1, agents.length)} · ${workflow?.name || (agent.id === "primary" ? "primary agent" : "direct subagent")}`} onClose={onClose} action={<button type="button" onClick={openTree} aria-label="Open in tree"><InspectorTreeGlyph /></button>}>{body}</InspectorSheet> : body;
}
