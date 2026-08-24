import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { WorkflowActivityPanel } from "../../app/components/dashboard/WorkflowActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import type { Agent, MonitorState, Workflow } from "../../shared/monitor-contract";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";

function worker(overrides: Partial<Agent> = {}): Agent {
  return { id: "workflow-agent-1", parentId: "primary", workflowId: "workflow-1", workflowPhaseId: "implement", workflowOrder: 0, workflowState: "running", label: "Backend investigator", role: "workflow-worker", model: "test-model", effort: "medium", status: "active", signal: null, toolCalls: 3, skills: [], executionTasks: [], lastSeen: "2026-08-15T12:03:00.000Z", startedAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:03:00.000Z", durationMs: 180_000, tokens: { total: 83_000, input: 1_000, output: 2_000, cacheWrite: 40_000, cacheRead: 40_000 }, ...overrides };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return { id: "workflow-1", name: "quickwin-batch", summary: "Two implementation tracks.", status: "running", startedAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:03:00.000Z", durationMs: 180_000, agentIds: ["workflow-agent-1"], metadataStatus: "ready", phases: [{ id: "implement", label: "Implement", agentIds: ["workflow-agent-1"] }], ...overrides };
}

function dashboardState(): MonitorState {
  return { ...createEmptyMonitorState({ connected: true }), capabilities: { ...createEmptyMonitorState().capabilities, workflows: true }, session: { id: "claude:tree-preference", title: "Tree preference", project: "Pomegr", cwd: "C:\\Workspace\\repos\\pomegr", repository: { available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }, pullRequests: { status: "unavailable", checkedAt: null, items: [] }, startedAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:03:00.000Z", durationMs: 180_000, cost: null, approvalMode: null, contextMachinery: null, summary: null, signal: null }, agents: [worker({ id: "primary", parentId: null, label: "Primary agent", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowOrder: null, workflowState: null }), worker()], workflows: [workflow()] };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); window.localStorage.clear(); });

describe("workflow activity and agent tree view", () => {
  it("keeps workflow activity before the dashboard grid and summary-only", async () => {
    const state = dashboardState();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => Promise.resolve(new Response(JSON.stringify(String(input) === "/api/sessions" ? { sessions: [] } : state), { status: 200 })));
    const { container } = render(<Dashboard />);
    const panel = await waitFor(() => { const element = container.querySelector("details.workflowActivityPanel"); expect(element).toBeInTheDocument(); return element!; });
    expect(panel.nextElementSibling).toBe(container.querySelector(".contentGrid"));
    expect(panel).toHaveTextContent("Phase metadata ready");
    expect(panel).toHaveTextContent("Implement");
    expect(panel.querySelector(".workflowWorkerRows, .workflowWorkerRow, .workflowWorkerGroup")).not.toBeInTheDocument();
  });

  it("shows workflow identity, lifecycle, context, wall time, metadata, and phase progress without worker rows", () => {
    const unrelated = worker({ id: "other-workflow-agent", workflowId: "workflow-2", workflowPhaseId: "implement", workflowState: "done", status: "finished" });
    render(<LiveClockProvider running={false}><WorkflowActivityPanel agents={[worker(), unrelated]} historical sessionId="claude:workflow" workflows={[workflow({ phases: [{ id: "implement", label: "Implement", agentIds: ["workflow-agent-1", "other-workflow-agent"] }] })]} /></LiveClockProvider>);
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("1 observed agent");
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("83K context");
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("3m wall time");
    expect(screen.getByLabelText("quickwin-batch phase progress")).toHaveTextContent("Active");
    expect(screen.getByLabelText("quickwin-batch phase progress")).toHaveTextContent("0/1 finished");
    expect(screen.queryByRole("list", { name: "Workflow workers" })).not.toBeInTheDocument();
  });

  it("uses the session-scoped List default, persists Tree choice, and gives Tree the full grid width", async () => {
    const state = dashboardState();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => Promise.resolve(new Response(JSON.stringify(String(input) === "/api/sessions" ? { sessions: [] } : state), { status: 200 })));
    const user = userEvent.setup();
    const { container, unmount } = render(<Dashboard />);
    await screen.findByRole("button", { name: "Tree" });
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Tree" }));
    expect(container.querySelector(".contentGrid")).toHaveClass("contentGrid-tree");
    expect(container.querySelector(".agentsPanel")).toHaveClass("agentsPanel-tree");
    expect(window.localStorage.getItem("pomegr-agent-activity-view-claude:tree-preference")).toBe("tree");
    unmount();
    render(<Dashboard />);
    expect((await screen.findByRole("button", { name: "Tree" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("lists every agent exactly once, including workflow agents, and accepts legacy missing roles", () => {
    const primary = worker({ id: "primary", parentId: null, label: "Primary agent", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowOrder: null, workflowState: null });
    const legacy = { ...worker({ id: "legacy", label: "Legacy agent", workflowId: null, workflowPhaseId: null }), role: undefined } as unknown as Agent;
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, worker(), legacy]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:list" viewMode="list" onViewModeChange={() => {}} workflows={[workflow()]} /></LiveClockProvider>);
    const rows = within(screen.getByRole("list", { name: "Session agents" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Workflow agents/ })).not.toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("renders the top-down tree, vertical connectors, provenance, and the List-view detail note", () => {
    const primary = worker({ id: "primary", parentId: null, label: "Primary agent", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowOrder: null, workflowState: null });
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, worker()]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:tree" viewMode="tree" onViewModeChange={() => {}} workflows={[workflow()]} /></LiveClockProvider>);
    expect(screen.getByRole("tree", { name: "Agent spawn hierarchy" })).toBeInTheDocument();
    expect(container.querySelectorAll(".agentTreeCard svg.agentTreeRoleGlyph")).toHaveLength(2);
    expect(container.querySelector(".agentTreeNode")?.getAttribute("style")).toContain("--tree-x");
    expect(container.querySelector(".agentTreeConnectors path")?.getAttribute("d")).toMatch(/^M[^V]+V[^H]+H[^V]+V/);
    expect(container.querySelector(".agentTreeCard.activeAgent .agentTreeRole")).toBeInTheDocument();
    expect(screen.getByText("Workflow: quickwin-batch · Implement")).toBeInTheDocument();
    expect(screen.getByText("Tasks, skills, execution, and plan details are available in List view.")).toBeInTheDocument();
  });

  it("advances only live running workflow wall time", () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-08-15T12:03:00.000Z");
    render(<LiveClockProvider running><WorkflowActivityPanel agents={[]} historical={false} sessionId="claude:timer" workflows={[workflow({ agentIds: [], phases: [] })]} /></LiveClockProvider>);
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("3m wall time");
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("5m wall time");
  });

  it("uses observed container width for rail/columns and preserves a stored column camera", async () => {
    let measuredWidth = 390;
    const callbacks: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];
    class MockResizeObserver { constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) { callbacks.push(callback); } observe() { callbacks.at(-1)?.([{ contentRect: { width: measuredWidth } }]); } disconnect() {} }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    window.localStorage.setItem("pomegr-agent-tree-camera-claude:responsive", JSON.stringify({ x: 12, y: 24, scale: 1.5 }));
    const { container, rerender } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={dashboardState().agents} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:responsive" viewMode="tree" workflows={[workflow()]} /></LiveClockProvider>);
    await waitFor(() => expect(container.querySelector(".agentTreeView-rail")).toBeInTheDocument());
    expect(container.querySelector(".agentTreeCameraControls")).not.toBeInTheDocument();
    measuredWidth = 640; act(() => callbacks.at(-1)?.([{ contentRect: { width: measuredWidth } }]));
    await waitFor(() => expect(container.querySelector(".agentTreeView-columns")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Fit 150%" })).toBeInTheDocument());
    measuredWidth = 1200; act(() => callbacks.at(-1)?.([{ contentRect: { width: measuredWidth } }]));
    expect(container.querySelector(".agentTreeView-columns")).toBeInTheDocument();
    rerender(<LiveClockProvider running={false}><AgentActivityPanel agents={dashboardState().agents} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:responsive" viewMode="tree" workflows={[workflow()]} /></LiveClockProvider>);
    expect(window.localStorage.getItem("pomegr-agent-tree-camera-claude:responsive")).toContain("1.5");
  });

  it("fits every tree card inside the canvas and centers the complete bounds", async () => {
    class MockResizeObserver { constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) { callback([{ contentRect: { width: 1_000 } }]); } observe() {} disconnect() {} }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(520);
    const agents = [
      worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator" }),
      worker({ id: "branch", parentId: "primary", label: "Branch" }),
      worker({ id: "top", parentId: "branch", label: "Top" }),
      worker({ id: "middle", parentId: "branch", label: "Middle" }),
      worker({ id: "bottom", parentId: "branch", label: "Bottom" }),
    ];
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={agents} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:fit" viewMode="tree" workflows={[]} /></LiveClockProvider>);
    await userEvent.click(await screen.findByRole("button", { name: /Fit/ }));
    const surface = container.querySelector(".agentTreeSurface") as HTMLDivElement;
    const scale = Number(surface.style.getPropertyValue("--tree-camera-scale"));
    const cameraX = Number.parseFloat(surface.style.getPropertyValue("--tree-camera-x"));
    const cameraY = Number.parseFloat(surface.style.getPropertyValue("--tree-camera-y"));
    const nodes = [...container.querySelectorAll<HTMLElement>(".agentTreeNode")];
    const left = Math.min(...nodes.map((node) => Number.parseFloat(node.style.getPropertyValue("--tree-x"))));
    const right = Math.max(...nodes.map((node) => Number.parseFloat(node.style.getPropertyValue("--tree-x")) + Number.parseFloat(node.style.getPropertyValue("--tree-w"))));
    const top = Math.min(...nodes.map((node) => Number.parseFloat(node.style.getPropertyValue("--tree-y"))));
    const bottom = Math.max(...nodes.map((node) => Number.parseFloat(node.style.getPropertyValue("--tree-y")) + Number.parseFloat(node.style.getPropertyValue("--tree-h"))));
    const screenLeft = left * scale + cameraX;
    const screenRight = right * scale + cameraX;
    const screenTop = top * scale + cameraY;
    const screenBottom = bottom * scale + cameraY;
    expect(screenLeft).toBeGreaterThanOrEqual(24);
    expect(screenRight).toBeLessThanOrEqual(976);
    expect((screenLeft + screenRight) / 2).toBeCloseTo(500);
    expect(screenTop).toBeGreaterThanOrEqual(24);
    expect(screenBottom).toBeLessThanOrEqual(496);
    expect((screenTop + screenBottom) / 2).toBeCloseTo(260);
  });

  it("supports roving tree keys, drag separation, and phase membership without Tree phase rows", () => {
    const primary = worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowState: null });
    const child = worker({ id: "child", parentId: "primary", workflowId: "workflow-1", workflowPhaseId: "implement" });
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, child]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:keys" viewMode="tree" workflows={[workflow({ updatedAt: null as unknown as string, agentIds: [], phases: [{ id: "implement", label: "Implement", agentIds: [] }] })]} /></LiveClockProvider>);
    const root = screen.getByRole("treeitem", { name: /Primary/ });
    root.focus(); fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(screen.queryByRole("treeitem", { name: /Backend investigator/ })).not.toBeInTheDocument();
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: /Backend investigator/ })).toBeInTheDocument();
    expect(root).toHaveAccessibleName(/1 descendants:/);
    expect(root).not.toHaveAccessibleName(/hidden descendants/);
    const canvas = container.querySelector(".agentTreeCanvas") as HTMLDivElement;
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() });
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 }); fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 30, clientY: 10 }); fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 30, clientY: 10 });
    expect(canvas.setPointerCapture).toHaveBeenCalled();
    window.localStorage.setItem("pomegr-workflow-panel-open-claude:tree-workflow", "false");
    render(<LiveClockProvider running={false}><WorkflowActivityPanel agents={[child]} historical={false} sessionId="claude:tree-workflow" viewMode="tree" workflows={[workflow({ updatedAt: null as unknown as string, agentIds: [], phases: [{ id: "implement", label: "Implement", agentIds: [] }] })]} /></LiveClockProvider>);
    expect(screen.getByText("Workflow activity").closest("summary")).toHaveTextContent("1 agent");
    expect(screen.queryByLabelText("quickwin-batch phase progress")).not.toBeInTheDocument();
  });

  it("degrades without ResizeObserver and handles empty, historical, long RTL, large, and unavailable-storage trees", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const root = worker({ id: "root", parentId: null, label: "عنوان طويل جداً للعامل الرئيسي مع تفاصيل إضافية" });
    const child = worker({ id: "child", parentId: "root", label: "Child" });
    const grandchild = worker({ id: "grandchild", parentId: "child", label: "Grandchild" });
    const many = Array.from({ length: 42 }, (_, index) => worker({ id: `agent-${index}`, parentId: null, label: `Agent ${index}` }));
    const { container, rerender } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[root, child, grandchild, ...many]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:hardening" viewMode="tree" workflows={[]} /></LiveClockProvider>);
    expect(container.querySelector(".agentTreeView-columns")).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")).toHaveLength(45);
    expect(screen.getByRole("treeitem", { name: /عنوان طويل/ })).toBeInTheDocument();
    rerender(<LiveClockProvider running={false}><AgentActivityPanel agents={[root, child, grandchild]} executionTasks={[]} historical planTasks={[]} sessionId="claude:historical" viewMode="tree" workflows={[]} /></LiveClockProvider>);
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /Grandchild/ })).not.toBeInTheDocument());
    rerender(<LiveClockProvider running={false}><AgentActivityPanel agents={[]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:empty" viewMode="tree" workflows={[]} /></LiveClockProvider>);
    expect(screen.getByText("No agents have appeared in this session yet.")).toBeInTheDocument();
    expect(screen.getByText("Tasks, skills, execution, and plan details are available in List view.")).toBeInTheDocument();
  });
});
