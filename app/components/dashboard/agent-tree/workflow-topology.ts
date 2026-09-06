import type { Agent, Workflow } from "../../../../shared/monitor-contract";
import {
  buildVisualForest,
  focusVisualForest,
  type AgentTreeCluster,
  type AgentTreeForest,
  type AgentTreeRollup,
  type AgentTreeVisualForest,
  type AgentTreeVisualNode,
} from "./topology";

export type WorkflowTreeMode = "session" | "ancestors";
export type WorkflowVisualNode = AgentTreeVisualNode | AgentTreeCluster;

function emptyRollup(): AgentTreeRollup {
  return { needsInput: 0, live: 0, finished: 0, contextSum: 0 };
}

function addRollup(left: AgentTreeRollup, right: AgentTreeRollup): AgentTreeRollup {
  return {
    needsInput: left.needsInput + right.needsInput,
    live: left.live + right.live,
    finished: left.finished + right.finished,
    contextSum: left.contextSum + right.contextSum,
  };
}

function agentIds(node: WorkflowVisualNode): string[] {
  if (!node.isCluster) return [node.agent.id, ...node.children.flatMap(agentIds)];
  return node.children.flatMap(agentIds);
}

function uniqueAgentIds(nodes: WorkflowVisualNode[]): string[] {
  return [...new Set(nodes.flatMap(agentIds))];
}

function aggregate(nodes: WorkflowVisualNode[]) {
  const rollup = nodes.reduce((sum, node) => addRollup(sum, node.rollup), emptyRollup());
  return {
    rollup,
    descendantCount: nodes.reduce((sum, node) => sum + node.descendantCount + (node.isCluster ? 0 : 1), 0),
    clusterIds: uniqueAgentIds(nodes),
  };
}

function workflowMember(agent: Agent, workflow: Workflow | undefined) {
  return Boolean(workflow && agent.workflowId === workflow.id && workflow.agentIds.includes(agent.id));
}

function phaseMember(agent: Agent, workflow: Workflow, phaseId: string) {
  const phase = workflow.phases.find((item) => item.id === phaseId);
  if (!phase || !workflowMember(agent, workflow) || !phase.agentIds.includes(agent.id)) return false;
  return !agent.workflowPhaseId || agent.workflowPhaseId === phase.id;
}

/**
 * Build workflow and phase groups from canonical sibling sets. Every group is a
 * presentation node whose `parentId` names the recorded parent; `visualParentId`
 * is the only edge used to draw the projected view.
 */
export function buildWorkflowVisualForest(
  forest: AgentTreeForest,
  workflows: Workflow[],
  focusId: string | null = null,
  mode: WorkflowTreeMode = "ancestors",
): AgentTreeVisualForest {
  if (!workflows.length) return mode === "ancestors" && focusId ? focusVisualForest(forest, focusId) : buildVisualForest(forest);

  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const byId = new Map<string, WorkflowVisualNode>();
  const nodes: WorkflowVisualNode[] = [];

  const renderAgent = (node: AgentTreeForest["nodes"][number], visualParentId: string | null): AgentTreeVisualNode => {
    const visualNode: AgentTreeVisualNode = { ...node, visualParentId, children: [] };
    byId.set(node.id, visualNode);
    nodes.push(visualNode);
    visualNode.children = groupedChildren(node);
    return visualNode;
  };

  const makeGroup = (
    kind: "workflow" | "phase" | "direct",
    label: string,
    parent: AgentTreeForest["nodes"][number],
    children: WorkflowVisualNode[],
    workflow: Workflow | null = null,
    phaseId: string | null = null,
  ): AgentTreeCluster => {
    const id = `group:${kind}:${parent.id}:${workflow?.id || "direct"}:${phaseId || "all"}`;
    const aggregateValue = aggregate(children);
    const group: AgentTreeCluster = {
      id,
      agent: null,
      // This is the recorded parent for the grouped sibling set, not a new edge.
      parentId: parent.id,
      canonicalParentId: null,
      visualParentId: parent.id,
      children,
      depth: parent.depth + 1,
      workflowId: workflow?.id || null,
      workflowPhaseId: phaseId,
      directChildCount: children.length,
      descendantCount: aggregateValue.descendantCount,
      rollup: aggregateValue.rollup,
      descendantRollup: aggregateValue.rollup,
      isCycleRoot: false,
      isCluster: true,
      clusterCount: aggregateValue.clusterIds.length,
      clusterIds: aggregateValue.clusterIds,
      label,
      groupKind: kind,
      groupStatus: kind === "workflow" ? workflow?.status : undefined,
      groupPhaseCount: kind === "workflow" ? workflow?.phases.length : undefined,
      groupWallTimeMs: kind === "workflow" ? workflow?.durationMs : undefined,
    };
    byId.set(id, group);
    nodes.push(group);
    return group;
  };

  const makePhaseChildren = (parent: AgentTreeForest["nodes"][number], workflow: Workflow, members: AgentTreeForest["nodes"][number][]) => {
    const children: WorkflowVisualNode[] = [];
    const consumed = new Set<string>();
    for (const child of members) {
      if (consumed.has(child.id)) continue;
      const phase = workflow.phases.find((item) => phaseMember(child.agent, workflow, item.id));
      if (!phase) {
        consumed.add(child.id);
        children.push(renderAgent(child, "pending-workflow-group"));
        continue;
      }
      const phaseMembers = members.filter((item) => phaseMember(item.agent, workflow, phase.id));
      phaseMembers.forEach((item) => consumed.add(item.id));
      const phaseChildren = phaseMembers.map((item) => renderAgent(item, "pending-phase-group"));
      const phaseGroup = makeGroup("phase", phase.label, parent, phaseChildren, workflow, phase.id);
      for (const item of phaseChildren) item.visualParentId = phaseGroup.id;
      children.push(phaseGroup);
    }
    return children;
  };

  const groupedChildren = (parent: AgentTreeForest["nodes"][number]): WorkflowVisualNode[] => {
    const children: WorkflowVisualNode[] = [];
    const consumed = new Set<string>();
    for (const child of parent.children) {
      if (consumed.has(child.id)) continue;
      const workflow = child.agent.workflowId ? workflowsById.get(child.agent.workflowId) : undefined;
      if (workflowMember(child.agent, workflow)) {
        const members = parent.children.filter((item) => workflowMember(item.agent, workflow));
        members.forEach((item) => consumed.add(item.id));
        const workflowChildren = makePhaseChildren(parent, workflow!, members);
        // Replace temporary visual parents now that the group ID is known.
        const group = makeGroup("workflow", workflow!.name, parent, workflowChildren, workflow!);
        for (const item of workflowChildren) item.visualParentId = group.id;
        children.push(group);
        continue;
      }
      const direct = parent.children.filter((item) => !consumed.has(item.id) && !workflowMember(item.agent, item.agent.workflowId ? workflowsById.get(item.agent.workflowId) : undefined));
      if (direct.length > 1) {
        direct.forEach((item) => consumed.add(item.id));
        const directChildren = direct.map((item) => renderAgent(item, parent.id));
        const directGroup = makeGroup("direct", "Direct subagents", parent, directChildren);
        for (const item of directChildren) item.visualParentId = directGroup.id;
        children.push(directGroup);
      } else {
        consumed.add(child.id);
        children.push(renderAgent(child, parent.id));
      }
    }
    return children;
  };

  // The closures above are mutually recursive; their declarations are hoisted
  // by the function body before roots are rendered.
  const roots = forest.roots.map((root) => renderAgent(root, null));
  const full: AgentTreeVisualForest = { roots, nodes, byId };
  if (mode === "session" || !focusId || !byId.has(focusId)) return full;
  return focusWorkflowForest(full, focusId);
}

function focusWorkflowForest(full: AgentTreeVisualForest, focusId: string): AgentTreeVisualForest {
  const focus = full.byId.get(focusId);
  if (!focus) return full;
  const pathIds = new Set<string>();
  let current: WorkflowVisualNode | undefined = focus;
  while (current && !pathIds.has(current.id)) {
    pathIds.add(current.id);
    current = current.visualParentId ? full.byId.get(current.visualParentId) : undefined;
  }
  const focusParentId = focus.visualParentId;
  const byId = new Map<string, WorkflowVisualNode>();
  const nodes: WorkflowVisualNode[] = [];

  const clone = (source: WorkflowVisualNode, visualParentId: string | null): WorkflowVisualNode => {
    const copy = { ...source, visualParentId, children: [] } as WorkflowVisualNode;
    byId.set(copy.id, copy);
    nodes.push(copy);
    copy.children = selectedChildren(source, copy.id);
    return copy;
  };

  const makeCluster = (items: WorkflowVisualNode[], parent: WorkflowVisualNode | null, visualParentId: string | null) => {
    const id = `cluster:workflow-focus:${parent?.id || "roots"}`;
    const aggregateValue = aggregate(items);
    const cluster: AgentTreeCluster = {
      id,
      agent: null,
      parentId: parent && !parent.isCluster ? parent.id : parent?.parentId || null,
      canonicalParentId: null,
      visualParentId,
      children: [],
      depth: parent ? parent.depth + 1 : 0,
      workflowId: null,
      workflowPhaseId: null,
      directChildCount: items.length,
      descendantCount: aggregateValue.descendantCount,
      rollup: aggregateValue.rollup,
      descendantRollup: aggregateValue.rollup,
      isCycleRoot: false,
      isCluster: true,
      clusterCount: aggregateValue.clusterIds.length,
      clusterIds: aggregateValue.clusterIds,
      label: `${parent ? (parent.isCluster ? parent.label : parent.agent.label) : "Other roots"} · ${items.length} more`,
    };
    byId.set(id, cluster);
    nodes.push(cluster);
    cluster.children = items.map((item) => clone(item, id));
    return cluster;
  };

  const selectedChildren = (source: WorkflowVisualNode, sourceId: string): WorkflowVisualNode[] => {
    const children = source.children;
    if (!children.length) return [];
    // Off-path groups are retained whole and start collapsed in the view. This
    // lets expanding a workflow/phase group reveal its original evidence order.
    if (!pathIds.has(source.id)) return children.map((child) => clone(child, sourceId));
    if (source.id === focusId) {
      // The focused agent's direct children are the detail surface. Unwrap a
      // presentation-only direct group so every recorded child remains visible.
      return children.flatMap((child) => child.isCluster && child.groupKind === "direct"
        ? child.children.map((grandchild) => clone(grandchild, sourceId))
        : [clone(child, sourceId)]);
    }
    const pathChild = children.find((child) => pathIds.has(child.id));
    if (!pathChild) return children.map((child) => clone(child, sourceId));

    if (source.id === focusParentId && !pathChild.isCluster) {
      const siblings = children.filter((child) => child.id !== pathChild.id);
      if (siblings.length <= 1) return children.map((child) => clone(child, sourceId));
      const pathIndex = children.findIndex((child) => child.id === pathChild.id);
      const keep = siblings[pathIndex > 0 ? pathIndex - 1 : 0];
      const remainder = siblings.filter((child) => child.id !== keep.id);
      const cluster = makeCluster(remainder, source, sourceId);
      return children.map((child) => child.id === pathChild.id || child.id === keep.id ? clone(child, sourceId) : child.id === remainder[0].id ? cluster : null).filter(Boolean) as WorkflowVisualNode[];
    }

    // Workflow and phase groups on the focus path stay as explicit topology;
    // their off-path groups are shown as collapsed group cards.
    if (source.isCluster && source.groupKind) return children.map((child) => clone(child, sourceId));
    const offPath = children.filter((child) => child.id !== pathChild.id);
    if (!offPath.length) return [clone(pathChild, sourceId)];
    let genericCluster: WorkflowVisualNode | null = null;
    const selected: WorkflowVisualNode[] = [];
    for (const child of children) {
      if (child.id === pathChild.id) selected.push(clone(child, sourceId));
      else if (child.isCluster && child.groupKind) selected.push(clone(child, sourceId));
      else if (!genericCluster) {
        const raw = offPath.filter((item) => !item.isCluster || !item.groupKind);
        if (raw.length) {
          genericCluster = makeCluster(raw, source, sourceId);
          selected.push(genericCluster);
        }
      }
    }
    return selected;
  };

  const roots: WorkflowVisualNode[] = [];
  const pathRoot = full.roots.find((root) => pathIds.has(root.id));
  if (pathRoot) {
    roots.push(clone(pathRoot, null));
    const otherRoots = full.roots.filter((root) => root.id !== pathRoot.id);
    if (otherRoots.length) roots.push(makeCluster(otherRoots, null, null));
  } else {
    roots.push(...full.roots.map((root) => clone(root, null)));
  }
  return { roots, nodes, byId };
}

export { buildVisualForest, focusVisualForest };
