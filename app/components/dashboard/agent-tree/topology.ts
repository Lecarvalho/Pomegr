import type { Agent } from "../../../../shared/monitor-contract";

export type AgentTreeRollup = {
  needsInput: number;
  live: number;
  finished: number;
  contextSum: number;
};

export type AgentTreeNode = {
  id: string;
  agent: Agent;
  /** The recorded parent, retained even when the edge is invalid. */
  parentId: string | null;
  /** A valid parent edge used by this forest, or null for an independent root. */
  canonicalParentId: string | null;
  children: AgentTreeNode[];
  depth: number;
  workflowId: string | null;
  workflowPhaseId: string | null;
  directChildCount: number;
  descendantCount: number;
  rollup: AgentTreeRollup;
  descendantRollup: AgentTreeRollup;
  isCycleRoot: boolean;
};

export type AgentTreeForest = {
  roots: AgentTreeNode[];
  nodes: AgentTreeNode[];
  byId: Map<string, AgentTreeNode>;
};

export type AgentTreeContextOptions = {
  contextOf?: (agent: Agent) => number;
};

export type AgentTreeVisualNode = Omit<AgentTreeNode, "children"> & {
  /** Presentation-only ancestry: may point to a sibling cluster without altering recorded truth. */
  visualParentId: string | null;
  children: Array<AgentTreeVisualNode | AgentTreeCluster>;
  isCluster?: false;
  clusterCount?: undefined;
  clusterIds?: undefined;
};

export type AgentTreeCluster = {
  id: string;
  agent: null;
  parentId: string | null;
  canonicalParentId: null;
  visualParentId: string | null;
  /** Materialized presentation children; each child retains canonical parent truth. */
  children: AgentTreeVisualNode[];
  depth: number;
  workflowId: null;
  workflowPhaseId: null;
  directChildCount: number;
  descendantCount: number;
  rollup: AgentTreeRollup;
  descendantRollup: AgentTreeRollup;
  isCycleRoot: false;
  isCluster: true;
  clusterCount: number;
  clusterIds: string[];
  label: string;
};

export type AgentTreeVisualForest = {
  roots: Array<AgentTreeVisualNode | AgentTreeCluster>;
  nodes: Array<AgentTreeVisualNode | AgentTreeCluster>;
  byId: Map<string, AgentTreeVisualNode | AgentTreeCluster>;
};

const LIVE_STATUSES = new Set<Agent["status"]>(["active", "waiting", "needs_input", "warm"]);
const FINISHED_STATUSES = new Set<Agent["status"]>(["finished", "stopped"]);

function compareCreation(left: Agent, right: Agent) {
  const leftTimestamp = Date.parse(left.startedAt || "");
  const rightTimestamp = Date.parse(right.startedAt || "");
  const leftValue = Number.isFinite(leftTimestamp) ? leftTimestamp : Number.NEGATIVE_INFINITY;
  const rightValue = Number.isFinite(rightTimestamp) ? rightTimestamp : Number.NEGATIVE_INFINITY;
  return rightValue - leftValue || left.id.localeCompare(right.id);
}

function compareRoots(left: Agent, right: Agent) {
  if (left.id === "primary") return -1;
  if (right.id === "primary") return 1;
  return compareCreation(left, right);
}

function contextValue(agent: Agent, contextOf?: (agent: Agent) => number) {
  const value = contextOf ? contextOf(agent) : agent.tokens?.total;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function ownRollup(agent: Agent, contextOf?: (agent: Agent) => number): AgentTreeRollup {
  return {
    needsInput: agent.status === "needs_input" ? 1 : 0,
    live: LIVE_STATUSES.has(agent.status) ? 1 : 0,
    finished: FINISHED_STATUSES.has(agent.status) ? 1 : 0,
    contextSum: contextValue(agent, contextOf),
  };
}

function addRollup(left: AgentTreeRollup, right: AgentTreeRollup): AgentTreeRollup {
  return {
    needsInput: left.needsInput + right.needsInput,
    live: left.live + right.live,
    finished: left.finished + right.finished,
    contextSum: left.contextSum + right.contextSum,
  };
}

function cycleMembers(agentsById: Map<string, Agent>) {
  const members = new Set<string>();
  for (const agent of agentsById.values()) {
    const path: string[] = [];
    const indexById = new Map<string, number>();
    let current: Agent | undefined = agent;
    while (current?.parentId && agentsById.has(current.parentId)) {
      const index = indexById.get(current.id);
      if (index !== undefined) {
        for (const id of path.slice(index)) members.add(id);
        break;
      }
      indexById.set(current.id, path.length);
      path.push(current.id);
      current = agentsById.get(current.parentId);
    }
  }
  return members;
}

/** Build the recorded spawn forest without inventing ancestry for bad parent links. */
export function buildAgentForest(agents: Agent[], options: AgentTreeContextOptions = {}): AgentTreeForest {
  const orderedAgents = [...agents];
  const byAgentId = new Map(orderedAgents.map((agent) => [agent.id, agent]));
  const cycles = cycleMembers(byAgentId);
  const childrenByParent = new Map<string, Agent[]>();
  const roots: Agent[] = [];

  for (const agent of orderedAgents) {
    const parentId = agent.parentId;
    const validParent = Boolean(parentId)
      && parentId !== agent.id
      && byAgentId.has(parentId as string)
      // A member of a detected cycle is detached, but its ordinary children
      // still belong beneath that now-independent root.
      && !cycles.has(agent.id);
    if (validParent) {
      const siblings = childrenByParent.get(parentId as string) || [];
      siblings.push(agent);
      childrenByParent.set(parentId as string, siblings);
    } else {
      roots.push(agent);
    }
  }

  for (const siblings of childrenByParent.values()) siblings.sort(compareCreation);
  roots.sort(compareRoots);
  const byId = new Map<string, AgentTreeNode>();
  for (const agent of orderedAgents) {
    byId.set(agent.id, {
      id: agent.id,
      agent,
      parentId: agent.parentId,
      canonicalParentId: null,
      children: [],
      depth: 0,
      workflowId: agent.workflowId,
      workflowPhaseId: agent.workflowPhaseId,
      directChildCount: 0,
      descendantCount: 0,
      rollup: ownRollup(agent, options.contextOf),
      descendantRollup: { needsInput: 0, live: 0, finished: 0, contextSum: 0 },
      isCycleRoot: cycles.has(agent.id),
    });
  }

  for (const [parentId, childAgents] of childrenByParent) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    parent.children = childAgents.map((child) => byId.get(child.id) as AgentTreeNode);
    parent.directChildCount = parent.children.length;
    for (const child of parent.children) child.canonicalParentId = parent.id;
  }

  const visit = (node: AgentTreeNode, depth: number): AgentTreeRollup => {
    node.depth = depth;
    let rollup = ownRollup(node.agent, options.contextOf);
    let descendants = { needsInput: 0, live: 0, finished: 0, contextSum: 0 };
    for (const child of node.children) {
      const childRollup = visit(child, depth + 1);
      rollup = addRollup(rollup, childRollup);
      descendants = addRollup(descendants, childRollup);
    }
    node.rollup = rollup;
    node.descendantRollup = descendants;
    node.descendantCount = node.children.reduce((count, child) => count + child.descendantCount + 1, 0);
    return rollup;
  };
  for (const root of roots) visit(byId.get(root.id) as AgentTreeNode, 0);
  // Defensive fallback: every input remains visible even if future edge validation changes.
  for (const node of byId.values()) if (node.depth === 0 && !roots.some((root) => root.id === node.id)) roots.push(node.agent);
  const rootNodes = roots.map((agent) => byId.get(agent.id) as AgentTreeNode);
  const nodes: AgentTreeNode[] = [];
  const flatten = (node: AgentTreeNode) => {
    nodes.push(node);
    for (const child of node.children) flatten(child);
  };
  for (const root of rootNodes) flatten(root);
  return { roots: rootNodes, nodes, byId };
}

/**
 * Add presentation-only sibling clusters. `forest` and each clustered agent retain
 * their recorded parent relationship; clusters are never written back to the data model.
 */
export function buildVisualForest(forest: AgentTreeForest, threshold = 4): AgentTreeVisualForest {
  const byId = new Map<string, AgentTreeVisualNode | AgentTreeCluster>();
  const nodes: Array<AgentTreeVisualNode | AgentTreeCluster> = [];
  let clusterIndex = 0;
  const add = (node: AgentTreeNode, visualParentId: string | null): AgentTreeVisualNode => {
    const siblingsByLabel = new Map<string, AgentTreeNode[]>();
    for (const child of node.children) siblingsByLabel.set(child.agent.label, [...(siblingsByLabel.get(child.agent.label) || []), child]);
    const visualChildren: Array<AgentTreeVisualNode | AgentTreeCluster> = [];
    const seen = new Set<string>();
    for (const child of node.children) {
      if (seen.has(child.id)) continue;
      const sameLabel = siblingsByLabel.get(child.agent.label) || [];
      if (sameLabel.length > threshold) {
        const clusterId = `cluster:${node.id}:${clusterIndex++}`;
        const rollup = sameLabel.reduce((sum, item) => addRollup(sum, item.rollup), { needsInput: 0, live: 0, finished: 0, contextSum: 0 });
        const descendantRollup = sameLabel.reduce((sum, item) => addRollup(sum, item.descendantRollup), { needsInput: 0, live: 0, finished: 0, contextSum: 0 });
        const materializedChildren = sameLabel.map((item) => add(item, clusterId));
        const cluster: AgentTreeCluster = {
          id: clusterId,
          agent: null,
          parentId: node.id,
          canonicalParentId: null,
          visualParentId: node.id,
          children: materializedChildren,
          depth: node.depth + 1,
          workflowId: null,
          workflowPhaseId: null,
          directChildCount: sameLabel.length,
          descendantCount: sameLabel.reduce((sum, item) => sum + item.descendantCount + 1, 0),
          rollup,
          descendantRollup,
          isCycleRoot: false,
          isCluster: true,
          clusterCount: sameLabel.length,
          clusterIds: sameLabel.map((item) => item.id),
          label: `${child.agent.label} ×${sameLabel.length}`,
        };
        visualChildren.push(cluster);
        byId.set(cluster.id, cluster);
        nodes.push(cluster);
        for (const item of sameLabel) seen.add(item.id);
      } else {
        seen.add(child.id);
        visualChildren.push(add(child, node.id));
      }
    }
    // Clone the node so presentation-only clusters never mutate canonical ancestry.
    const visualNode: AgentTreeVisualNode = { ...node, visualParentId, children: visualChildren };
    byId.set(node.id, visualNode);
    nodes.push(visualNode);
    return visualNode;
  };
  const roots = forest.roots.map((root) => add(root, null));
  return { roots, nodes, byId };
}

/**
 * Build a bounded, presentation-only view around one recorded agent.  The spawn
 * tree remains the source of truth: workflow fields stay on their original
 * agents and clusters only replace visual sibling sets.
 */
export function focusVisualForest(forest: AgentTreeForest, focusId: string): AgentTreeVisualForest {
  const focus = forest.byId.get(focusId);
  if (!focus) return buildVisualForest(forest);

  const pathIds = new Set<string>();
  let pathNode: AgentTreeNode | undefined = focus;
  while (pathNode && !pathIds.has(pathNode.id)) {
    pathIds.add(pathNode.id);
    pathNode = pathNode.canonicalParentId ? forest.byId.get(pathNode.canonicalParentId) : undefined;
  }

  const byId = new Map<string, AgentTreeVisualNode | AgentTreeCluster>();
  const nodes: Array<AgentTreeVisualNode | AgentTreeCluster> = [];
  const emptyRollup = (): AgentTreeRollup => ({ needsInput: 0, live: 0, finished: 0, contextSum: 0 });
  const focusParentId = focus.canonicalParentId;
  const clusterIdFor = (parent: AgentTreeNode | null) => parent ? `cluster:focus:${parent.id}` : "cluster:focus:roots";

  const add = (node: AgentTreeNode, visualParentId: string | null): AgentTreeVisualNode => {
    const visualNode: AgentTreeVisualNode = { ...node, visualParentId, children: visualChildrenFor(node) };
    byId.set(node.id, visualNode);
    nodes.push(visualNode);
    return visualNode;
  };

  const cluster = (items: AgentTreeNode[], parent: AgentTreeNode | null, visualParentId: string | null): AgentTreeCluster => {
    const id = clusterIdFor(parent);
    const rollup = items.reduce((sum, item) => addRollup(sum, item.rollup), emptyRollup());
    const materializedChildren = items.map((item) => add(item, id));
    const label = parent ? `${parent.agent.label} · ${items.length} more` : `Other roots · ${items.length} more`;
    const visualCluster: AgentTreeCluster = {
      id,
      agent: null,
      parentId: parent?.id ?? null,
      canonicalParentId: null,
      visualParentId,
      children: materializedChildren,
      depth: parent ? parent.depth + 1 : 0,
      workflowId: null,
      workflowPhaseId: null,
      directChildCount: items.length,
      descendantCount: items.reduce((count, item) => count + item.descendantCount + 1, 0),
      // A cluster has no own agent; all of its rollup belongs to descendants.
      rollup,
      descendantRollup: rollup,
      isCycleRoot: false,
      isCluster: true,
      clusterCount: items.length,
      clusterIds: items.map((item) => item.id),
      label,
    };
    byId.set(id, visualCluster);
    nodes.push(visualCluster);
    return visualCluster;
  };

  const visualChildrenFor = (node: AgentTreeNode): Array<AgentTreeVisualNode | AgentTreeCluster> => {
    if (!node.children.length) return [];
    // The focused agent and its parent are the two places where every direct
    // child stays visible: focus children and focus siblings, respectively.
    if (node.id === focus.id || node.id === focusParentId) return node.children.map((child) => add(child, node.id));

    const pathChild = node.children.find((child) => pathIds.has(child.id));
    if (!pathChild) return [cluster(node.children, node, node.id)];

    const visualChildren: Array<AgentTreeVisualNode | AgentTreeCluster> = [];
    let addedCluster = false;
    for (const child of node.children) {
      if (child.id === pathChild.id) visualChildren.push(add(child, node.id));
      else if (!addedCluster) {
        visualChildren.push(cluster(node.children.filter((item) => item.id !== pathChild.id), node, node.id));
        addedCluster = true;
      }
    }
    return visualChildren;
  };

  const focusRootId = [...pathIds].find((id) => !forest.byId.get(id)?.canonicalParentId) as string;
  const roots: Array<AgentTreeVisualNode | AgentTreeCluster> = [];
  let addedRootCluster = false;
  for (const root of forest.roots) {
    if (root.id === focusRootId) roots.push(add(root, null));
    else if (!addedRootCluster) {
      roots.push(cluster(forest.roots.filter((item) => item.id !== focusRootId), null, null));
      addedRootCluster = true;
    }
  }
  return { roots, nodes, byId };
}

export const buildAgentTree = buildAgentForest;
export const createAgentForest = buildAgentForest;
export const createVisualForest = buildVisualForest;
