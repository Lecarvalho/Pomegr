import { describe, expect, it } from "vitest";
import type { Agent, Workflow } from "../../shared/monitor-contract";
import { buildRosterGroups, roleTally, statusTally } from "../../app/components/dashboard/agent-roster/groups";

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    parentId: "primary",
    workflowId: null,
    workflowPhaseId: null,
    workflowOrder: null,
    workflowState: null,
    label: id,
    role: "builder",
    model: "test-model",
    effort: "medium",
    status: "active",
    signal: null,
    toolCalls: 1,
    skills: [],
    executionTasks: [],
    lastSeen: "2026-09-05T12:00:00.000Z",
    startedAt: "2026-09-05T11:59:00.000Z",
    updatedAt: "2026-09-05T12:00:00.000Z",
    durationMs: 1_000,
    cacheLifetime: null,
    tokens: { total: 100, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    ...overrides,
  };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow-1",
    name: "Build workflow",
    summary: null,
    status: "running",
    metadataStatus: "ready",
    startedAt: "2026-09-05T11:00:00.000Z",
    updatedAt: "2026-09-05T12:00:00.000Z",
    durationMs: 60_000,
    agentIds: [],
    phases: [
      { id: "plan", label: "Plan", agentIds: [] },
      { id: "implement", label: "Implement", agentIds: ["worker-2"] },
    ],
    ...overrides,
  };
}

describe("agent roster grouping model", () => {
  it("builds primary, direct, and workflow groups with workflow ordering and phase subtitle", () => {
    const agents = [
      agent("worker-2", { workflowId: "workflow-1", workflowOrder: 2, workflowPhaseId: "implement", label: "Second" }),
      agent("primary", { parentId: null, role: "orchestrator", tokens: { total: 500, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
      agent("direct-parent", { label: "A parent", durationMs: 3_000 }),
      agent("nested", { parentId: "direct-parent", label: "B nested", durationMs: 2_000 }),
      agent("worker-1", { workflowId: "workflow-1", workflowOrder: 1, workflowPhaseId: "plan", label: "First" }),
    ];
    const groups = buildRosterGroups(agents, [workflow()], { historical: true, now: Date.parse("2026-09-05T12:01:00.000Z") });

    expect(groups.map((group) => group.id)).toEqual(["primary", "direct", "workflow:workflow-1"]);
    expect(groups[0].agents.map(({ id }) => id)).toEqual(["primary"]);
    expect(groups[1].agents.map(({ id }) => id)).toEqual(["direct-parent", "nested"]);
    expect(groups[1].subtitle).toBe("A parent and B nested");
    expect(groups[2].agents.map(({ id }) => id)).toEqual(["worker-1", "worker-2"]);
    expect(groups[2].subtitle).toBe("phase Implement");
    expect(groups[1].rollup).toMatchObject({ agents: 2, context: 200, wallMs: 5_000, toolCalls: 2 });
  });

  it("places unknown workflow agents in one trailing unassigned group and excludes primary from it", () => {
    const groups = buildRosterGroups([
      agent("primary", { parentId: null, workflowId: "missing" }),
      agent("unknown-a", { workflowId: "missing", workflowOrder: 2 }),
      agent("unknown-b", { workflowId: "also-missing", workflowOrder: 1 }),
    ], [], { historical: true });

    expect(groups.map((group) => group.id)).toEqual(["primary", "workflow:unknown"]);
    expect(groups[0].agents.map(({ id }) => id)).toEqual(["primary"]);
    expect(groups[1]).toMatchObject({ title: "Unassigned workflow", workflow: null });
    expect(groups[1].agents.map(({ id }) => id)).toEqual(["unknown-b", "unknown-a"]);
  });

  it("tallies status buckets and roles deterministically", () => {
    const agents = [
      agent("a", { status: "finished", role: "builder" }),
      agent("b", { status: "stopped", role: "builder" }),
      agent("c", { status: "needs_input", role: "reviewer" }),
      agent("d", { status: "waiting", role: "reviewer" }),
      agent("e", { status: "warm", role: "unknown" }),
      agent("f", { status: "idle", role: "explore" }),
      agent("g", { status: "active", role: "explore" }),
      agent("h", { status: "unknown", role: "unknown" }),
    ];

    expect(statusTally(agents)).toEqual({ finished: 1, idle: 4, active: 1, stopped: 1, other: 1 });
    expect(roleTally(agents)).toEqual([
      { role: "unknown", count: 2 },
      { role: "builder", count: 2 },
      { role: "explore", count: 2 },
      { role: "reviewer", count: 2 },
    ].sort((left, right) => left.role.localeCompare(right.role)));
  });
});
