import type { Agent, Workflow } from "../../../../shared/monitor-contract";
import { agentDisplayName, compactNumber } from "../../../dashboard-utils";

export function agentLineage(agent: Agent, agents: Agent[], workflows: Workflow[]) {
  const byId = new Map(agents.map((item) => [item.id, item]));
  const seen = new Set([agent.id]);
  const ancestors: Agent[] = [];
  let parent = agent.parentId ? byId.get(agent.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    ancestors.unshift(parent);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  const rows = ancestors.map((item) => ({ id: item.id, label: item.id === "primary" ? "Primary agent" : agentDisplayName(item), context: item.tokens.total, kind: item.id === "primary" ? "primary" : "ancestor" }));
  const workflow = workflows.find((item) => item.id === agent.workflowId);
  const phase = workflow?.phases.find((item) => item.id === agent.workflowPhaseId);
  const rollup = (ids: string[]) => [...new Set(ids)].reduce((sum, id) => sum + (byId.get(id)?.tokens.total || 0), 0);
  if (workflow) rows.push({ id: `workflow:${workflow.id}`, label: `Workflow ${workflow.name} · ${workflow.agentIds.length} agents`, context: rollup(workflow.agentIds), kind: "workflow" });
  if (phase) rows.push({ id: `phase:${phase.id}`, label: `Phase ${phase.label} · ${phase.agentIds.filter((id) => id !== agent.id).length} siblings`, context: rollup(phase.agentIds), kind: "phase" });
  const children = agents.filter((item) => item.parentId === agent.id && item.id !== agent.id).length;
  rows.push({ id: agent.id, label: `${agent.id === "primary" ? "Primary agent" : agentDisplayName(agent)} · ${children ? `${children} ${children === 1 ? "child" : "children"}` : "no children"}`, context: agent.tokens.total, kind: "selected" });
  return rows;
}

export function AgentLineage({ agent, agents, workflows }: { agent: Agent; agents: Agent[]; workflows: Workflow[] }) {
  return <ol className="inspectorLineage" aria-label="Agent lineage">{agentLineage(agent, agents, workflows).map((row) => <li className={`inspectorLineage-${row.kind}`} key={row.id}><i aria-hidden="true" /><span>{row.label}</span><b title="Latest context snapshot or sum of latest snapshots">{compactNumber(row.context)}</b></li>)}</ol>;
}
