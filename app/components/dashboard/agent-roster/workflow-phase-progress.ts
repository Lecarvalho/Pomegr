import type { Agent, Workflow } from "../../../../shared/monitor-contract";

export function phaseProgress(workflow: Workflow, agentsById: Map<string, Agent>) {
  const workflowAgentIds = new Set(workflow.agentIds);
  return workflow.phases.map((phase) => {
    const ids = new Set(phase.agentIds);
    for (const agent of agentsById.values()) {
      if (agent.workflowId === workflow.id && agent.workflowPhaseId === phase.id) ids.add(agent.id);
    }
    const members = [...ids].flatMap((id) => {
      const agent = agentsById.get(id);
      return agent && (agent.workflowId === workflow.id || workflowAgentIds.has(id)) ? [agent] : [];
    });
    const finished = members.filter((agent) => agent.workflowState === "done" || agent.workflowState === "error").length;
    const state = members.length === 0
      ? "No agents observed"
      : members.some((agent) => agent.workflowState === "running")
        ? "Active"
        : finished === members.length
          ? "Complete"
          : "In progress";
    return { phase, finished, observed: members.length, state };
  });
}
