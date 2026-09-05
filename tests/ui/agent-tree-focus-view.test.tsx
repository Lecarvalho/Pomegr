import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTreeView } from "../../app/components/dashboard/agent-tree/AgentTreeView";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import type { Agent, Insight, Workflow } from "../../shared/monitor-contract";

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
    effort: "medium",
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

function renderTree({ agents, focusId, historical = false, insights = [], mode, sessionId = "focus-view", workflows = [] }: {
  agents: Agent[];
  focusId: string;
  historical?: boolean;
  insights?: Insight[];
  mode?: "ancestors" | "session";
  sessionId?: string;
  workflows?: Workflow[];
}) {
  return render(<LiveClockProvider running={false}><AgentTreeView agents={agents} focusId={focusId} historical={historical} insights={insights} mode={mode} sessionId={sessionId} workflows={workflows} /></LiveClockProvider>);
}

function nodeFor(container: HTMLElement, agentId: string) {
  const node = container.querySelector<HTMLElement>(`[data-agent-id="${agentId}"]`);
  if (!node) throw new Error(`missing ${agentId}`);
  return node;
}

function focusFixture() {
  return [
    agent("primary", null, "2026-09-05T12:00:00.000Z", { label: "Primary", role: "orchestrator" }),
    agent("branch", "primary", "2026-09-05T12:01:00.000Z", { label: "Branch" }),
    agent("focus", "branch", "2026-09-05T12:02:00.000Z", { label: "Focused worker", role: "workflow-worker", workflowId: "workflow-1", workflowPhaseId: "review" }),
    agent("focus-sibling", "branch", "2026-09-05T12:03:00.000Z", { label: "Focus sibling" }),
    agent("primary-side-a", "primary", "2026-09-05T12:04:00.000Z", { label: "Side A" }),
    agent("primary-side-b", "primary", "2026-09-05T12:05:00.000Z", { label: "Side B" }),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("focused agent tree view", () => {
  it("starts focused clusters closed and the canonical focus path open, ignoring historical and stored session folds", async () => {
    const agents = focusFixture();
    window.localStorage.setItem("pomegr-agent-tree-folds-focus-history", JSON.stringify(["primary", "branch"]));
    const { container } = renderTree({ agents, focusId: "focus", historical: true, sessionId: "focus-history" });

    const cluster = await screen.findByText("Primary · 2 more");
    expect(cluster.closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "false");
    expect(nodeFor(container, "primary")).toHaveAttribute("aria-expanded", "true");
    expect(nodeFor(container, "branch")).toHaveAttribute("aria-expanded", "true");
    expect(nodeFor(container, "focus")).toBeInTheDocument();
    expect(nodeFor(container, "focus-sibling")).toBeInTheDocument();
    expect(container.querySelector('[data-agent-id="primary-side-a"]')).not.toBeInTheDocument();
  });

  it("focuses and highlights the target, marks its warning, draws hot ancestry connectors, and renders footer provenance", async () => {
    const agents = focusFixture();
    const workflows: Workflow[] = [{ id: "workflow-1", name: "Audit workflow", summary: null, status: "running", metadataStatus: "ready", startedAt: null, updatedAt: null, durationMs: 0, agentIds: ["focus"], phases: [{ id: "review", label: "Review", agentIds: ["focus"] }] }];
    const insights: Insight[] = [{ id: "warning", level: "warning", title: "Needs review", detail: "Bounded evidence", agentId: "focus" }];
    const { container } = renderTree({ agents, focusId: "focus", insights, workflows });

    const target = await waitFor(() => {
      const node = nodeFor(container, "focus");
      expect(document.activeElement).toBe(node);
      return node;
    });
    expect(target.querySelector(".agentTreeCard")).toHaveClass("isFocus", "isAttention");
    expect(container.querySelectorAll(".agentTreeConnectors path.isHot")).toHaveLength(2);
    expect(screen.getByText("Focus path: Primary › Branch › Audit workflow › Review › Focused worker")).toBeInTheDocument();
    expect(screen.getByText("Layout follows provider evidence order · numbers are latest snapshots")).toBeInTheDocument();
  });

  it("keeps a cluster expansion when polling replaces agents with equivalent records", async () => {
    const user = userEvent.setup();
    const agents = focusFixture();
    const view = renderTree({ agents, focusId: "focus" });
    const cluster = await screen.findByText("Primary · 2 more");
    const clusterNode = cluster.closest<HTMLElement>('[role="treeitem"]')!;

    await user.click(clusterNode);
    expect(clusterNode).toHaveAttribute("aria-expanded", "true");
    expect(nodeFor(view.container, "primary-side-a")).toBeInTheDocument();

    view.rerender(<LiveClockProvider running={false}><AgentTreeView agents={agents.map((item) => ({ ...item, tokens: { ...item.tokens } }))} focusId="focus" historical={false} sessionId="focus-view" workflows={[]} /></LiveClockProvider>);
    await waitFor(() => expect(nodeFor(view.container, "primary-side-a")).toBeInTheDocument());
    expect(screen.getByText("Primary · 2 more").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
  });

  it("expands the focused target's existing same-label cluster in Whole session mode", async () => {
    const user = userEvent.setup();
    const agents = [
      agent("primary", null, "2026-09-05T12:00:00.000Z", { label: "Primary", role: "orchestrator" }),
      agent("branch", "primary", "2026-09-05T12:01:00.000Z", { label: "Branch" }),
      ...Array.from({ length: 5 }, (_, index) => agent(`worker-${index}`, "branch", `2026-09-05T12:0${index + 2}:00.000Z`, { label: "Worker" })),
    ];
    const { container } = renderTree({ agents, focusId: "worker-0" });

    await user.click(await screen.findByRole("button", { name: "Whole session" }));
    await waitFor(() => expect(nodeFor(container, "worker-0")).toBeInTheDocument());
    expect(screen.getByText("Worker ×5").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
  });

  it("uses the rail form on phone and omits scope and camera controls", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const { container } = renderTree({ agents: focusFixture(), focusId: "focus" });

    await waitFor(() => expect(container.querySelector(".agentTreeView-rail")).toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "Tree scope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Whole session" })).not.toBeInTheDocument();
    expect(container.querySelector(".agentTreeCameraControls")).not.toBeInTheDocument();
    expect(nodeFor(container, "focus").querySelector(".agentTreeCard")).toHaveClass("isFocus");
  });
});
