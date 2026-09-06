import { describe, expect, it } from "vitest";
import type { Agent, Workflow } from "../../shared/monitor-contract";
import { buildAgentForest } from "../../app/components/dashboard/agent-tree/topology";
import { buildWorkflowVisualForest, type WorkflowVisualNode } from "../../app/components/dashboard/agent-tree/workflow-topology";

function agent(id: string, parentId: string | null, startedAt: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    parentId,
    workflowId: null,
    workflowPhaseId: null,
    workflowOrder: null,
    workflowState: null,
    label: id,
    role: "general-purpose",
    model: "test",
    effort: "high",
    status: "active",
    signal: null,
    toolCalls: 0,
    skills: [],
    executionTasks: [],
    lastSeen: startedAt,
    startedAt,
    updatedAt: startedAt,
    durationMs: 0,
    cacheLifetime: null,
    tokens: { total: 10, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    ...overrides,
  };
}

function workflow(): Workflow {
  return {
    id: "wf-build",
    name: "Build",
    summary: null,
    status: "running",
    metadataStatus: "ready",
    startedAt: "2026-09-05T12:00:00.000Z",
    updatedAt: "2026-09-05T12:05:00.000Z",
    durationMs: 300_000,
    agentIds: ["worker-a", "worker-b", "focused", "nested"],
    phases: [
      { id: "plan", label: "Plan", agentIds: ["worker-a"] },
      { id: "implement", label: "Implement", agentIds: ["worker-b", "focused", "nested"] },
    ],
  };
}

function children(node: WorkflowVisualNode) {
  return node.children;
}

function clusters(nodes: WorkflowVisualNode[]) {
  return nodes.filter((node): node is Extract<WorkflowVisualNode, { isCluster: true }> => Boolean(node.isCluster));
}

describe("buildWorkflowVisualForest", () => {
  it("adds workflow and phase groups only around valid canonical siblings", () => {
    const agents = [
      agent("primary", null, "2026-09-05T12:00:00.000Z"),
      agent("direct-a", "primary", "2026-09-05T12:01:00.000Z"),
      agent("worker-a", "primary", "2026-09-05T12:02:00.000Z", { workflowId: "wf-build", workflowPhaseId: "plan" }),
      agent("worker-b", "primary", "2026-09-05T12:03:00.000Z", { workflowId: "wf-build", workflowPhaseId: "implement" }),
      agent("focused", "primary", "2026-09-05T12:04:00.000Z", { workflowId: "wf-build", workflowPhaseId: "implement" }),
      // Same workflow metadata under a different recorded parent must remain
      // in that parent's group and cannot be merged with primary's siblings.
      agent("nested", "worker-a", "2026-09-05T12:05:00.000Z", { workflowId: "wf-build", workflowPhaseId: "implement" }),
      // The agent claims a workflow that does not include it; it stays direct.
      agent("unmatched", "primary", "2026-09-05T12:06:00.000Z", { workflowId: "missing", workflowPhaseId: "unknown" }),
    ];
    const forest = buildAgentForest(agents);
    const visual = buildWorkflowVisualForest(forest, [workflow()], null, "session");
    const primary = visual.byId.get("primary")!;
    const groups = clusters(children(primary));
    expect(groups.map((node) => node.groupKind)).toEqual(["direct", "workflow"]);
    const wfGroup = groups.find((node) => node.groupKind === "workflow")!;
    expect(wfGroup.label).toBe("Build");
    expect(wfGroup.workflowId).toBe("wf-build");
    expect(wfGroup.clusterIds).toEqual(["focused", "worker-b", "worker-a", "nested"]);
    expect(clusters(wfGroup.children).map((node) => node.label)).toEqual(["Implement", "Plan"]);
    expect(visual.byId.get("nested")?.visualParentId).toMatch(/^group:phase:worker-a:/);
    const directGroup = groups.find((node) => node.groupKind === "direct")!;
    expect(directGroup.children.some((node) => !node.isCluster && node.id === "unmatched")).toBe(true);
    expect(forest.byId.get("nested")?.canonicalParentId).toBe("worker-a");
    expect(visual.byId.get("nested")?.canonicalParentId).toBe("worker-a");
  });

  it("keeps the workflow and phase path expanded while bounding focus siblings", () => {
    const agents = [
      agent("primary", null, "2026-09-05T12:00:00.000Z"),
      agent("focused", "primary", "2026-09-05T12:01:00.000Z", { workflowId: "wf-build", workflowPhaseId: "implement" }),
      agent("neighbor", "primary", "2026-09-05T12:02:00.000Z", { workflowId: "wf-build", workflowPhaseId: "implement" }),
      agent("other-a", "primary", "2026-09-05T12:03:00.000Z", { workflowId: "wf-build", workflowPhaseId: "implement" }),
      agent("other-b", "primary", "2026-09-05T12:04:00.000Z", { workflowId: "wf-build", workflowPhaseId: "implement" }),
      agent("child-a", "focused", "2026-09-05T12:05:00.000Z"),
      agent("child-b", "focused", "2026-09-05T12:06:00.000Z"),
    ];
    const build = workflow();
    build.agentIds = ["focused", "neighbor", "other-a", "other-b"];
    build.phases[1].agentIds = ["focused", "neighbor", "other-a", "other-b"];
    const visual = buildWorkflowVisualForest(buildAgentForest(agents), [build], "focused", "ancestors");
    const workflowGroup = clusters(visual.nodes).find((node) => node.groupKind === "workflow")!;
    const phase = clusters(workflowGroup.children).find((node) => node.workflowPhaseId === "implement")!;
    const path = ["primary", workflowGroup.id, phase.id, "focused"];
    expect(path.every((id) => visual.byId.has(id))).toBe(true);
    const phaseInView = visual.byId.get(path[2])!;
    expect(phaseInView.children.map((node) => node.id)).toEqual([`cluster:workflow-focus:${phase.id}`, "neighbor", "focused"]);
    const siblingCluster = phaseInView.children.find((node) => node.isCluster && !node.groupKind)!;
    expect(siblingCluster.clusterIds).toEqual(["other-b", "other-a"]);
    expect(visual.byId.get("focused")?.children.map((node) => node.id)).toEqual(["child-b", "child-a"]);
    expect(visual.byId.get("focused")?.visualParentId).toBe(phase.id);
  });
});
