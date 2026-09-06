import { describe, expect, it } from "vitest";
import type { Agent } from "../../shared/monitor-contract";
import { layoutRail } from "../../app/components/dashboard/agent-tree/layout";
import { buildAgentForest, focusVisualForest, type AgentTreeCluster } from "../../app/components/dashboard/agent-tree/topology";

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

function clusters(forest: ReturnType<typeof focusVisualForest>) {
  return forest.nodes.filter((node): node is AgentTreeCluster => node.isCluster === true);
}

function visibleNodeIds(forest: ReturnType<typeof focusVisualForest>, collapsedIds: Iterable<string>) {
  return [...layoutRail(forest, { collapsedIds }).keys()];
}

describe("focusVisualForest", () => {
  it("keeps a leaf path and its siblings while clustering off-path sibling sets in evidence order", () => {
    const forest = buildAgentForest([
      agent("primary", null, "2026-09-05T12:00:00.000Z", { label: "Primary" }),
      agent("workflow-parent", "primary", "2026-09-05T12:01:00.000Z", { label: "Build workflow" }),
      agent("leaf", "workflow-parent", "2026-09-05T12:02:00.000Z"),
      agent("leaf-sibling", "workflow-parent", "2026-09-05T12:03:00.000Z"),
      agent("off-path-a", "primary", "2026-09-05T12:04:00.000Z", { tokens: { total: 11, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
      agent("off-path-b", "primary", "2026-09-05T12:05:00.000Z", { tokens: { total: 12, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
      agent("off-path-descendant", "off-path-a", "2026-09-05T12:06:00.000Z", { tokens: { total: 13, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
    ]);
    const canonicalChildren = forest.nodes.map((node) => [node.id, node.children.map((child) => child.id)]);

    const visual = focusVisualForest(forest, "leaf");
    const primary = visual.byId.get("primary")!;
    const parent = visual.byId.get("workflow-parent")!;
    const offPath = clusters(visual).find((node) => node.parentId === "primary")!;

    expect(primary.children.map((child) => child.id)).toEqual(["cluster:focus:primary", "workflow-parent"]);
    expect(parent.children.map((child) => child.id)).toEqual(forest.byId.get("workflow-parent")!.children.map((child) => child.id));
    expect(offPath.clusterIds).toEqual(forest.byId.get("primary")!.children.filter((child) => child.id !== "workflow-parent").map((child) => child.id));
    expect(offPath.label).toBe("Primary · 2 more");
    expect(offPath.rollup.contextSum).toBe(36);
    expect(offPath.descendantRollup).toEqual(offPath.rollup);
    expect(visual.byId.get("leaf")?.visualParentId).toBe("workflow-parent");
    expect(visual.byId.get("off-path-a")?.visualParentId).toBe(offPath.id);
    expect(forest.byId.get("off-path-a")?.canonicalParentId).toBe("primary");
    expect(forest.nodes.map((node) => [node.id, node.children.map((child) => child.id)])).toEqual(canonicalChildren);
  });

  it("keeps every direct child when the primary is focused and does not turn workflow provenance into hierarchy", () => {
    const forest = buildAgentForest([
      agent("primary", null, "2026-09-05T12:00:00.000Z"),
      agent("workflow-worker", "primary", "2026-09-05T12:01:00.000Z", { role: "workflow-worker", workflowId: "workflow-1", workflowPhaseId: "phase-1" }),
      agent("worker-child", "workflow-worker", "2026-09-05T12:02:00.000Z"),
      agent("other-child", "primary", "2026-09-05T12:03:00.000Z", { workflowId: "workflow-1", workflowPhaseId: "phase-2" }),
    ]);

    const visual = focusVisualForest(forest, "primary");
    const primary = visual.byId.get("primary")!;
    const worker = visual.byId.get("workflow-worker")!;

    expect(primary.children.map((child) => child.id)).toEqual(forest.byId.get("primary")!.children.map((child) => child.id));
    expect(worker.visualParentId).toBe("primary");
    expect(worker.workflowId).toBe("workflow-1");
    expect(worker.workflowPhaseId).toBe("phase-1");
    expect(worker.children).toMatchObject([{ isCluster: true, parentId: "workflow-worker", clusterIds: ["worker-child"] }]);
  });

  it("bounds a 49-agent leaf focus, retains every agent below expandable clusters, and falls back safely", () => {
    const agents: Agent[] = [
      agent("primary", null, "2026-09-05T12:00:00.000Z"),
      agent("path-a", "primary", "2026-09-05T12:01:00.000Z"),
      agent("path-b", "path-a", "2026-09-05T12:02:00.000Z"),
      agent("focus", "path-b", "2026-09-05T12:03:00.000Z", { role: "workflow-worker", workflowId: "workflow-1", workflowPhaseId: "phase-1" }),
    ];
    for (let index = 0; index < 16; index += 1) agents.push(agent(`primary-side-${index}`, "primary", `2026-09-05T12:${10 + index}:00.000Z`));
    for (let index = 0; index < 16; index += 1) agents.push(agent(`path-a-side-${index}`, "path-a", `2026-09-05T12:${30 + index}:00.000Z`));
    for (let index = 0; index < 13; index += 1) agents.push(agent(`focus-sibling-${index}`, "path-b", `2026-09-05T13:${10 + index}:00.000Z`));
    const forest = buildAgentForest(agents);
    const visual = focusVisualForest(forest, "focus");
    const allClusters = clusters(visual);

    expect(agents).toHaveLength(49);
    expect(visual.nodes.filter((node) => !node.isCluster).map((node) => node.id).sort()).toEqual(agents.map((item) => item.id).sort());
    expect(visibleNodeIds(visual, allClusters.map((node) => node.id)).length).toBeLessThanOrEqual(20);
    expect(agents.every((item) => visibleNodeIds(visual, []).includes(item.id))).toBe(true);
    for (const cluster of allClusters) {
      const expanded = visibleNodeIds(visual, allClusters.filter((item) => item.id !== cluster.id).map((item) => item.id));
      expect(cluster.clusterIds.every((id) => expanded.includes(id))).toBe(true);
    }

    const fallback = focusVisualForest(forest, "missing-agent");
    expect(fallback.byId.has("focus")).toBe(true);
    expect(fallback.nodes.filter((node) => !node.isCluster)).toHaveLength(49);
  });
});
