import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsTab } from "../../app/components/dashboard/AgentsTab";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent as dashboardAgent } from "./dashboard-test-fixtures";

const { useSessionDomain } = vi.hoisted(() => ({ useSessionDomain: vi.fn() }));
vi.mock("../../app/session-domain-store", () => ({ useSessionDomain }));

const primary = { ...dashboardAgent, status: "active" as const };

function domain(domain: string, value: object) {
  return { data: { domain, sessionId: "codex:test", revision: 1, readiness: "ready", observedAt: null, ...value }, fetching: false, connected: true, error: null, revalidate: vi.fn() };
}

describe("Agents tab", () => {
  beforeEach(() => {
    useSessionDomain.mockImplementation((query: { domain: string; agentId?: string }) => query.domain === "agents"
      ? domain("agents", { agents: [primary], workflows: [], insights: [], loops: [], cacheRefills: [], cacheReadDrops: [], contextBoundaries: [] })
      : domain("agent", { agentId: query.agentId, agent: primary, ancestors: [], descendants: [], workflow: null, contextBoundaries: [], requestSnapshots: { status: "unavailable", items: [] }, insights: [], cacheEvents: { status: "unavailable", items: [], possibleFullRefills: [] }, cacheReadDrops: { status: "unavailable", items: [] }, planTasks: [], sectionReadiness: { agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready" } }));
    window.localStorage.clear();
  });

  it("coerces a stored Tree view to List and persists the Grid choice per session", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("pomegr-agent-activity-view-claude:tree-preference", "tree");
    const { unmount } = render(<LiveClockProvider running={false}><AgentsTab sessionId="claude:tree-preference" historical={false} selectedAgentId={null} onSelectAgent={vi.fn()} onOpenActivities={vi.fn()} /></LiveClockProvider>);
    await screen.findByRole("button", { name: "Grid" });
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Grid" }));
    expect(screen.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("pomegr-agent-activity-view-claude:tree-preference")).toBe("grid");
    unmount();
    render(<LiveClockProvider running={false}><AgentsTab sessionId="claude:tree-preference" historical={false} selectedAgentId={null} onSelectAgent={vi.fn()} onOpenActivities={vi.fn()} /></LiveClockProvider>);
    expect((await screen.findByRole("button", { name: "Grid" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("loads only agents plus the selected agent domain, then scopes Activities from the inspector", async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    const openActivities = vi.fn();
    render(<LiveClockProvider running={false}><AgentsTab sessionId="codex:test" historical={false} selectedAgentId="primary" onSelectAgent={select} onOpenActivities={openActivities} /></LiveClockProvider>);
    await waitFor(() => expect(screen.getByRole("region", { name: "Agent roster" })).toBeInTheDocument());
    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "codex:test", domain: "agents" }, { historical: false, enabled: true });
    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "codex:test", domain: "agent", agentId: "primary" }, { historical: false, enabled: true });
    await user.click(screen.getByRole("button", { name: "Activities for this agent" }));
    expect(openActivities).toHaveBeenCalledWith({ agentId: "primary" });
  });

  it("handles a loading envelope without an agents payload and pauses both domain subscriptions", () => {
    useSessionDomain.mockImplementation((query: { domain: string }) => query.domain === "agents"
      ? { data: { domain: "agents", sessionId: "codex:test", revision: 0, readiness: "loading", observedAt: null }, fetching: true, connected: true, error: null, revalidate: vi.fn() }
      : { data: null, fetching: false, connected: true, error: null, revalidate: vi.fn() });
    render(<LiveClockProvider running={false}><AgentsTab sessionId="codex:test" historical={false} selectedAgentId={null} onSelectAgent={vi.fn()} onOpenActivities={vi.fn()} paused /></LiveClockProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Loading agent evidence");
    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "codex:test", domain: "agents" }, { historical: false, enabled: false });
    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "codex:test", domain: "agent", agentId: "" }, { historical: false, enabled: false });
  });

  it("opens the default inspector for an unknown agent link without rewriting it, then resolves it once the agent arrives", async () => {
    const select = vi.fn();
    const child = { ...primary, id: "child", parentId: "primary", label: "Child agent", status: "idle" as const };
    const view = render(<LiveClockProvider running={false}><AgentsTab sessionId="codex:test" historical={false} selectedAgentId="child" onSelectAgent={select} onOpenActivities={vi.fn()} /></LiveClockProvider>);
    await screen.findByRole("region", { name: "Agent roster" });
    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "codex:test", domain: "agent", agentId: "primary" }, { historical: false, enabled: true });
    expect(screen.getByRole("button", { name: "Select Primary agent" })).toHaveAttribute("aria-pressed", "true");
    // A retained agents list can predate a newly spawned agent, so the link itself is kept.
    expect(select).not.toHaveBeenCalled();

    useSessionDomain.mockImplementation((query: { domain: string; agentId?: string }) => query.domain === "agents"
      ? domain("agents", { agents: [primary, child], workflows: [], insights: [], loops: [], cacheRefills: [], cacheReadDrops: [], contextBoundaries: [] })
      : domain("agent", { agentId: query.agentId, agent: child, ancestors: [primary], descendants: [], workflow: null, contextBoundaries: [], requestSnapshots: { status: "unavailable", items: [] }, insights: [], cacheEvents: { status: "unavailable", items: [], possibleFullRefills: [] }, cacheReadDrops: { status: "unavailable", items: [] }, planTasks: [], sectionReadiness: { agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready" } }));
    view.rerender(<LiveClockProvider running={false}><AgentsTab sessionId="codex:test" historical={false} selectedAgentId="child" onSelectAgent={select} onOpenActivities={vi.fn()} /></LiveClockProvider>);
    await waitFor(() => expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "codex:test", domain: "agent", agentId: "child" }, { historical: false, enabled: true }));
    expect(select).not.toHaveBeenCalled();
  });

  it("selects idempotently: choosing the already selected agent keeps it selected", async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    render(<LiveClockProvider running={false}><AgentsTab sessionId="codex:test" historical={false} selectedAgentId="primary" onSelectAgent={select} onOpenActivities={vi.fn()} /></LiveClockProvider>);
    await user.click(await screen.findByRole("button", { name: "Select Primary agent" }));
    expect(select).toHaveBeenCalledWith("primary");
    expect(select).not.toHaveBeenCalledWith(null);
  });

  it("marks roster rows with the agents domain's per-agent history", async () => {
    useSessionDomain.mockImplementation((query: { domain: string; agentId?: string }) => query.domain === "agents"
      ? domain("agents", { agents: [primary], workflows: [], insights: [], cacheRefills: [], cacheReadDrops: [], contextBoundaries: [],
        loops: [{ id: "loop-primary-0", agent: primary.label, agentId: "primary", tool: "Read", detail: "file", calls: 4, repeats: 3 }] })
      : domain("agent", { agentId: query.agentId, agent: primary, ancestors: [], descendants: [], workflow: null, contextBoundaries: [], requestSnapshots: { status: "unavailable", items: [] }, insights: [], cacheEvents: { status: "unavailable", items: [], possibleFullRefills: [] }, cacheReadDrops: { status: "unavailable", items: [] }, planTasks: [], sectionReadiness: { agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready" } }));
    const { container } = render(<LiveClockProvider running={false}><AgentsTab sessionId="codex:test" historical={false} selectedAgentId={null} onSelectAgent={vi.fn()} onOpenActivities={vi.fn()} /></LiveClockProvider>);
    await screen.findByRole("region", { name: "Agent roster" });
    expect(container.querySelector(".rosterRepeat")).toHaveTextContent("repeat ×3");
  });
});
