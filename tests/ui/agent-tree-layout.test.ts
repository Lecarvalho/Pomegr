import { describe, expect, it } from "vitest";
import type { Agent } from "../../shared/monitor-contract";
import { fitCamera, pinCard, revealChildren, zoomAt } from "../../app/components/dashboard/agent-tree/camera";
import { contentBounds, layoutColumns, layoutRail, layoutTopDown } from "../../app/components/dashboard/agent-tree/layout";
import { buildAgentForest, buildVisualForest } from "../../app/components/dashboard/agent-tree/topology";

function agent(id: string, parentId: string | null, startedAt = "2026-08-23T12:00:00.000Z", overrides: Partial<Agent> = {}): Agent {
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

describe("agent tree topology", () => {
  it("preserves primary-first, newest-first depth-first ordering", () => {
    const forest = buildAgentForest([
      agent("older", "primary", "2026-08-23T12:01:00.000Z"),
      agent("primary", null, "2026-08-23T12:00:00.000Z"),
      agent("newer", "primary", "2026-08-23T12:03:00.000Z"),
      agent("nested", "newer", "2026-08-23T12:04:00.000Z"),
    ]);
    expect(forest.nodes.map(({ id }) => id)).toEqual(["primary", "newer", "nested", "older"]);
  });

  it("makes missing, self-referential, and cyclic parents independent roots", () => {
    const forest = buildAgentForest([
      agent("primary", null),
      agent("orphan", "missing"),
      agent("self", "self"),
      agent("cycle-a", "cycle-b"),
      agent("cycle-b", "cycle-a"),
      agent("cycle-child", "cycle-a"),
    ]);
    expect(forest.roots.map(({ id }) => id)).toEqual(["primary", "cycle-a", "cycle-b", "orphan", "self"]);
    expect(forest.byId.get("cycle-a")?.children.map(({ id }) => id)).toEqual(["cycle-child"]);
    expect(forest.byId.get("cycle-child")?.canonicalParentId).toBe("cycle-a");
  });

  it("lays out detached cycle roots and their ordinary descendants", () => {
    const forest = buildAgentForest([
      agent("primary", null),
      agent("cycle-a", "cycle-b"),
      agent("cycle-b", "cycle-a"),
      agent("cycle-child", "cycle-a"),
      agent("orphan", "missing"),
    ]);
    const layout = layoutColumns(forest);
    for (const id of ["cycle-a", "cycle-b", "cycle-child", "orphan"]) expect(layout.get(id)).toBeDefined();
  });

  it("computes full subtree rollups and keeps workflow data as provenance", () => {
    const forest = buildAgentForest([
      agent("primary", null, "2026-08-23T12:00:00.000Z", { status: "idle", tokens: { total: 4, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
      agent("waiting", "primary", "2026-08-23T12:01:00.000Z", { status: "waiting", workflowId: "workflow-1", workflowPhaseId: "phase-1", tokens: { total: 5, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
      agent("needs", "waiting", "2026-08-23T12:02:00.000Z", { status: "needs_input", tokens: { total: 6, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
      agent("done", "waiting", "2026-08-23T12:03:00.000Z", { status: "finished", tokens: { total: 7, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
    ]);
    const waiting = forest.byId.get("waiting")!;
    expect(waiting.descendantCount).toBe(2);
    expect(waiting.rollup).toMatchObject({ needsInput: 1, live: 2, finished: 1, contextSum: 18 });
    expect(waiting.descendantRollup).toMatchObject({ needsInput: 1, live: 1, finished: 1, contextSum: 13 });
    expect(waiting.workflowId).toBe("workflow-1");
    expect(waiting.workflowPhaseId).toBe("phase-1");
  });

  it("creates presentation-only clusters for more than four same-label siblings", () => {
    const agents = [agent("primary", null), ...Array.from({ length: 5 }, (_, index) => agent(`worker-${index}`, "primary", `2026-08-23T12:0${index}:00.000Z`, { label: "Worker" }))];
    const forest = buildAgentForest(agents);
    const visual = buildVisualForest(forest);
    const primary = visual.roots[0];
    expect(primary.children).toHaveLength(1);
    expect(primary.children[0]).toMatchObject({ isCluster: true, clusterCount: 5 });
    expect(forest.byId.get("worker-0")?.parentId).toBe("primary");

    const visualPrimary = visual.roots[0];
    const cluster = visualPrimary.children[0];
    if (!cluster.isCluster) throw new Error("expected a visual cluster");
    expect(cluster.visualParentId).toBe("primary");
    expect(cluster.children.every((child) => child.visualParentId === cluster.id)).toBe(true);
    const expandedLayout = layoutColumns(visual, { collapsedIds: ["primary"] });
    expect(expandedLayout.get(cluster.id)).toBeUndefined();
    const clusterLayout = layoutColumns(visual);
    expect(clusterLayout.get(cluster.id)).toBeDefined();
    expect([...clusterLayout.keys()].filter((id) => id.startsWith("cluster:")).length).toBe(1);
    for (let index = 0; index < 5; index += 1) expect(clusterLayout.get(`worker-${index}`)).toBeDefined();
  });
});

describe("agent tree layout", () => {
  it("centers parents above horizontal children and supports deep chains", () => {
    const chain: Agent[] = [agent("root", null)];
    for (let index = 1; index < 7; index += 1) chain.push(agent(`level-${index}`, index === 1 ? "root" : `level-${index - 1}`));
    const wide = [agent("wide-root", null), ...Array.from({ length: 8 }, (_, index) => agent(`wide-${index}`, "wide-root", `2026-08-23T12:0${index}:00.000Z`))];
    const chainForest = buildAgentForest(chain);
    const wideForest = buildAgentForest(wide);
    const chainLayout = layoutTopDown(chainForest);
    const wideLayout = layoutTopDown(wideForest);
    expect(chainLayout.get("level-6")?.depth).toBe(6);
    expect(chainLayout.get("level-6")!.y).toBeGreaterThan(chainLayout.get("root")!.y);
    expect(chainLayout.get("level-6")!.x).toBe(chainLayout.get("root")!.x);
    const wideRoot = wideLayout.get("wide-root")!;
    const children = wideForest.byId.get("wide-root")!.children.map((child) => wideLayout.get(child.id)!);
    expect(children.at(-1)!.x).toBeGreaterThan(children[0].x);
    expect(wideRoot.x + wideRoot.w / 2).toBeCloseTo((children[0].x + children.at(-1)!.x + children.at(-1)!.w) / 2);
    expect(wideLayout.bounds.width).toBeGreaterThan(wideLayout.bounds.height);
    expect(chainLayout.bounds.height).toBeGreaterThan(chainLayout.bounds.width);
  });

  it("uses fixed-height rows and caps rail indentation", () => {
    const nodes = [agent("root", null), agent("child", "root"), agent("deep", "child"), agent("deeper", "deep")];
    const rail = layoutRail(buildAgentForest(nodes), { width: 390 });
    expect(rail.get("root")?.h).toBe(48);
    expect(rail.get("deeper")?.x).toBe(45);
    expect(rail.get("deeper")?.w).toBe(345);
    expect(rail.get("deeper")?.y).toBe(144);
  });

  it("reports empty and non-empty content bounds", () => {
    expect(contentBounds([])).toMatchObject({ x: 0, y: 0, width: 0, height: 0 });
    expect(contentBounds([{ x: 10, y: 20, w: 30, h: 40, width: 30, height: 40, depth: 0 }])).toMatchObject({ left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 });
  });
});

describe("agent tree camera", () => {
  const bounds = { x: 24, y: 24, width: 1_000, height: 2_000, left: 24, top: 24, right: 1_024, bottom: 2_024 };

  it("fits and centers the complete tree on both axes", () => {
    const camera = fitCamera(bounds, { width: 800, height: 500 }, "columns");
    expect(camera.scale).toBeCloseTo(0.226);
    expect(bounds.x * camera.scale + camera.x).toBeCloseTo(287);
    expect((bounds.x + bounds.width) * camera.scale + camera.x).toBeCloseTo(513);
    expect(bounds.y * camera.scale + camera.y).toBeCloseTo(24);
    expect((bounds.y + bounds.height) * camera.scale + camera.y).toBeCloseTo(476);
    expect(fitCamera({ ...bounds, width: 10, height: 10, right: 34, bottom: 34 }, { width: 800, height: 500 }).scale).toBe(1);
    expect(fitCamera({ ...bounds, width: 10_000, right: 10_024 }, { width: 800, height: 500 }).scale).toBeCloseTo(0.0752);
    expect(fitCamera({ ...bounds, height: 1_000_000, bottom: 1_000_024 }, { width: 800, height: 500 }).scale).toBeCloseTo(0.000452);
  });

  it("zooms around a point and clamps both directions", () => {
    const camera = { x: 10, y: 20, scale: 1 };
    expect(zoomAt(camera, { x: 100, y: 100 }, 2)).toEqual({ x: -80, y: -60, scale: 2 });
    expect(zoomAt(camera, { x: 100, y: 100 }, 0.01).scale).toBe(0.25);
    expect(zoomAt(camera, { x: 100, y: 100 }, 99).scale).toBe(3);
  });

  it("pinning and revealing translate without changing scale", () => {
    const camera = { x: 10, y: 20, scale: 0.8 };
    const pinned = pinCard(camera, { x: 20, y: 30 }, { x: 100, y: 130 });
    expect(pinned.scale).toBe(camera.scale);
    expect(pinned).toEqual({ x: -54, y: -60, scale: 0.8 });
    const revealed = revealChildren(camera, [{ x: 1_100, y: 100, w: 100, h: 100, width: 100, height: 100, depth: 0 }], { width: 800, height: 500 });
    expect(revealed.scale).toBe(camera.scale);
    expect(revealed.x).toBeLessThan(camera.x);
  });
});
