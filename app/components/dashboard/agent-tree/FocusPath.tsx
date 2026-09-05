import type { Agent, Workflow } from "../../../../shared/monitor-contract";
import { agentDisplayName } from "../../../dashboard-utils";
import type { AgentTreeVisualForest } from "./topology";

export function focusPathIds(forest: AgentTreeVisualForest, focusId: string | null) {
  const path = new Set<string>();
  let node = focusId ? forest.byId.get(focusId) : undefined;
  while (node && !path.has(node.id)) {
    path.add(node.id);
    node = node.visualParentId ? forest.byId.get(node.visualParentId) : undefined;
  }
  return path;
}

export function FocusPath({ agents, workflows, focusId }: { agents: Agent[]; workflows: Workflow[]; focusId: string }) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const focus = byId.get(focusId);
  if (!focus) return null;
  const path: Agent[] = [];
  const seen = new Set<string>();
  let current: Agent | undefined = focus;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  const workflow = workflows.find((item) => item.id === focus.workflowId);
  const phase = workflow?.phases.find((item) => item.id === focus.workflowPhaseId);
  const names = path.slice(0, -1).map((agent) => agent.id === "primary" ? "Primary" : agentDisplayName(agent));
  if (workflow) names.push(workflow.name);
  if (phase) names.push(phase.label);
  names.push(focus.id === "primary" ? "Primary" : agentDisplayName(focus));
  return <footer className="agentTreeFocusFooter"><span dir="auto">Focus path: {names.join(" › ")}</span><span>Layout follows provider evidence order · numbers are latest snapshots</span></footer>;
}
