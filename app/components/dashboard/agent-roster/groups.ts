import type { Agent, AgentRole, Workflow } from "../../../../shared/monitor-contract";
import { liveWallTimeMs } from "../../../formatting.mjs";

export type RosterGroup = {
  id: string;
  kind: "primary" | "direct" | "workflow";
  title: string;
  subtitle: string | null;
  agents: Agent[];
  rollup: {
    agents: number;
    context: number;
    wallMs: number;
    toolCalls: number;
    statuses: Record<Agent["status"], number>;
  };
  workflow: Workflow | null;
};

export type RosterGroupingOptions = {
  /** Historical snapshots never advance an agent's recorded duration. */
  historical?: boolean;
  /** Injected clock for deterministic live wall-time rollups and tests. */
  now?: number;
};

const STATUS_VALUES: Agent["status"][] = [
  "active",
  "waiting",
  "needs_input",
  "warm",
  "finished",
  "stopped",
  "idle",
  "unknown",
];

function emptyStatuses(): Record<Agent["status"], number> {
  return Object.fromEntries(STATUS_VALUES.map((status) => [status, 0])) as Record<Agent["status"], number>;
}

function contextOf(agent: Agent) {
  return Number.isFinite(agent.tokens?.total) && agent.tokens.total > 0 ? agent.tokens.total : 0;
}

function isLive(agent: Agent) {
  return agent.status === "active" || agent.status === "waiting";
}

function compareAgentOrder(left: { agent: Agent; index: number }, right: { agent: Agent; index: number }) {
  const leftOrder = left.agent.workflowOrder;
  const rightOrder = right.agent.workflowOrder;
  const leftRank = typeof leftOrder === "number" && Number.isFinite(leftOrder) ? leftOrder : Number.POSITIVE_INFINITY;
  const rightRank = typeof rightOrder === "number" && Number.isFinite(rightOrder) ? rightOrder : Number.POSITIVE_INFINITY;
  return leftRank - rightRank
    || left.agent.label.localeCompare(right.agent.label)
    || left.index - right.index;
}

function directDescendant(agent: Agent, byId: Map<string, Agent>) {
  const visited = new Set<string>();
  let current: Agent | undefined = agent;
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.parentId === "primary") return true;
    current = byId.get(current.parentId);
  }
  return false;
}

function directSubtitle(agents: Agent[]) {
  if (agents.length === 0) return null;
  const names = agents.slice(0, 2).map((agent) => agent.label);
  if (agents.length <= 2) return names.join(" and ");
  return `${names.join(", ")} and ${agents.length - 2} more`;
}

function workflowSubtitle(workflow: Workflow, agents: Agent[]) {
  const agentIds = new Set(agents.map((agent) => agent.id));
  for (let index = workflow.phases.length - 1; index >= 0; index -= 1) {
    const phase = workflow.phases[index];
    if (phase.agentIds.some((id) => agentIds.has(id)) || agents.some((agent) => agent.workflowPhaseId === phase.id)) {
      return `phase ${phase.label}`;
    }
  }
  return null;
}

function rollup(agents: Agent[], options: RosterGroupingOptions): RosterGroup["rollup"] {
  const statuses = emptyStatuses();
  let context = 0;
  let wallMs = 0;
  let toolCalls = 0;
  for (const agent of agents) {
    statuses[agent.status] += 1;
    context += contextOf(agent);
    wallMs += liveWallTimeMs(agent.durationMs, agent.startedAt, !options.historical && isLive(agent), options.now ?? Date.now());
    toolCalls += Number.isFinite(agent.toolCalls) && agent.toolCalls > 0 ? agent.toolCalls : 0;
  }
  return { agents: agents.length, context, wallMs, toolCalls, statuses };
}

function createGroup(
  id: string,
  kind: RosterGroup["kind"],
  title: string,
  agents: Agent[],
  workflow: Workflow | null,
  options: RosterGroupingOptions,
): RosterGroup {
  return {
    id,
    kind,
    title,
    subtitle: kind === "direct" ? directSubtitle(agents) : workflow ? workflowSubtitle(workflow, agents) : null,
    agents,
    rollup: rollup(agents, options),
    workflow,
  };
}

/** Build the bounded roster's stable primary, direct, and workflow groups. */
export function buildRosterGroups(
  agents: Agent[],
  workflows: Workflow[],
  options: RosterGroupingOptions = {},
): RosterGroup[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const buckets = new Map<string, { kind: RosterGroup["kind"]; title: string; workflow: Workflow | null; members: Array<{ agent: Agent; index: number }> }>();

  const add = (id: string, kind: RosterGroup["kind"], title: string, workflow: Workflow | null, agent: Agent, index: number) => {
    const bucket = buckets.get(id) || { kind, title, workflow, members: [] };
    bucket.members.push({ agent, index });
    buckets.set(id, bucket);
  };

  agents.forEach((agent, index) => {
    if (agent.id === "primary") {
      add("primary", "primary", "Primary agent", null, agent, index);
      return;
    }
    if (agent.workflowId) {
      const workflow = workflowById.get(agent.workflowId);
      add(
        workflow ? `workflow:${workflow.id}` : "workflow:unknown",
        "workflow",
        workflow?.name || "Unassigned workflow",
        workflow || null,
        agent,
        index,
      );
      return;
    }
    // Null-workflow descendants of a direct child remain in Direct subagents.
    // Orphaned null-workflow agents are retained there as a safe roster fallback.
    if (agent.parentId === "primary" || directDescendant(agent, byId) || !agent.parentId) {
      add("direct", "direct", "Direct subagents", null, agent, index);
      return;
    }
    add("direct", "direct", "Direct subagents", null, agent, index);
  });

  const order: string[] = [];
  if (buckets.has("primary")) order.push("primary");
  if (buckets.has("direct")) order.push("direct");
  for (const workflow of workflows) if (buckets.has(`workflow:${workflow.id}`)) order.push(`workflow:${workflow.id}`);
  if (buckets.has("workflow:unknown")) order.push("workflow:unknown");

  return order.map((id) => {
    const bucket = buckets.get(id)!;
    const members = [...bucket.members].sort(compareAgentOrder).map(({ agent }) => agent);
    return createGroup(id, bucket.kind, bucket.title, members, bucket.workflow, options);
  });
}

export function statusTally(agents: Agent[]) {
  const tally = { finished: 0, idle: 0, active: 0, stopped: 0, other: 0 };
  for (const agent of agents) {
    if (agent.status === "finished") tally.finished += 1;
    else if (agent.status === "stopped") tally.stopped += 1;
    else if (agent.status === "active") tally.active += 1;
    else if (agent.status === "idle" || agent.status === "waiting" || agent.status === "warm" || agent.status === "needs_input") tally.idle += 1;
    else tally.other += 1;
  }
  return tally;
}

export function roleTally(agents: Agent[]): Array<{ role: AgentRole; count: number }> {
  const counts = new Map<AgentRole, number>();
  for (const agent of agents) { const role = agent.role || "unknown"; counts.set(role, (counts.get(role) || 0) + 1); }
  return [...counts.entries()]
    .map(([role, count]) => ({ role, count }))
    .sort((left, right) => right.count - left.count || left.role.localeCompare(right.role));
}
