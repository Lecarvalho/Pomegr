import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Workflow } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent } from "./dashboard-test-fixtures";

const child = (id: string, overrides: Partial<Agent> = {}): Agent => ({ ...agent, id, label: id, parentId: "primary", workflowId: null, assignment: null, ...overrides });
const workflow: Workflow = { id: "run", name: "Verification", status: "completed", agentIds: ["worker"], phases: [{ id: "check", label: "Check", agentIds: ["worker"] }], metadataStatus: "ready", startedAt: null, updatedAt: null, durationMs: 1000, summary: null };
function panel(agents: Agent[], props: Partial<React.ComponentProps<typeof AgentActivityPanel>> = {}) { return <LiveClockProvider running={false}><AgentActivityPanel agents={agents} executionTasks={[]} planTasks={[]} historical sessionId="roster-test" {...props} /></LiveClockProvider>; }
const roster = () => screen.getByRole("region", { name: "Agent roster" });
const rows = () => within(roster()).queryAllByRole("row");

beforeEach(() => window.localStorage.clear());

describe("grouped agent roster", () => {
  it("bounds 49 agents, pins primary and group headers, expands eight then reveals the rest", async () => {
    const user = userEvent.setup();
    const agents = [agent, ...Array.from({ length: 48 }, (_, index) => child(`Child ${String(index).padStart(2, "0")}`))];
    const { container } = render(panel(agents));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveClass("rosterPrimary");
    expect(roster()).toHaveClass("rosterRegion", "rosterHasPrimary");
    expect(container.querySelector(".rosterGroupHeading")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Direct subagents/ }));
    expect(rows()).toHaveLength(9);
    expect(screen.getByText("49 observed · showing 9")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show 40 more in Direct subagents" }));
    expect(rows()).toHaveLength(49);
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(rows()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Expand all 49" }));
    expect(rows()).toHaveLength(49);
    expect(screen.queryByRole("button", { name: "Tree" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /shell tasks|plan items|skills$/ })).not.toBeInTheDocument();
  });

  it("combines search, status, model and hide-finished, sorts within stable workflow groups", async () => {
    const user = userEvent.setup();
    const agents = [agent, child("low", { assignment: "MATCH review", model: "a", status: "active", toolCalls: 2 }), child("high", { assignment: "match build", model: "a", status: "active", toolCalls: 12 }), child("wrong model", { assignment: "match", model: "b", status: "active" }), child("finished", { assignment: "match", model: "a" }), child("worker", { assignment: "match workflow", model: "a", status: "active", workflowId: "run", workflowPhaseId: "check" })];
    render(panel(agents, { workflows: [workflow] }));
    await user.click(screen.getByRole("button", { name: "Expand all 6" }));
    await user.type(screen.getByRole("searchbox", { name: "Filter agents" }), "match");
    await user.selectOptions(screen.getByRole("combobox", { name: "Agent status" }), "active");
    await user.selectOptions(screen.getByRole("combobox", { name: "Agent model" }), "a");
    await user.click(screen.getByRole("button", { name: "Hide finished" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort agents" }), "calls");
    expect(rows()).toHaveLength(3);
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([expect.stringContaining("high"), expect.stringContaining("low"), expect.stringContaining("worker")]);
    expect(screen.getByRole("list", { name: "Verification phase progress" })).toHaveTextContent("Check");
    expect(screen.getByRole("button", { name: /Direct subagents/ })).toHaveTextContent("4 agents");
    expect(screen.getByRole("button", { name: /Direct subagents/ })).toHaveTextContent("context");
  });

  it("preserves finished ancestors, saves visibility and groups per session, and resets unsaved filters", async () => {
    const user = userEvent.setup();
    const agents = [agent, child("Finished parent"), child("Active child", { parentId: "Finished parent", status: "active" }), child("Finished leaf")];
    const { rerender, unmount } = render(panel(agents));
    await user.click(screen.getByRole("button", { name: /Direct subagents/ }));
    await user.click(screen.getByRole("button", { name: "Hide finished" }));
    expect(rows()).toHaveLength(3);
    expect(rows().map((row) => row.textContent).join(" ")).toContain("Finished parent");
    expect(window.localStorage.getItem("pomegr-agent-activity-show-finished-roster-test")).toBe("false");
    rerender(panel(agents, { sessionId: "other" }));
    expect(screen.getByRole("button", { name: "Hide finished" })).toHaveAttribute("aria-pressed", "false");
    expect(rows()).toHaveLength(1);
    unmount();
    render(panel(agents));
    expect(rows()).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Direct subagents/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps flat provider tree order and selects by keyboard without nesting buttons", async () => {
    const user = userEvent.setup();
    const selected = vi.fn();
    const agents = [agent, child("parent", { startedAt: "2026-08-01T00:00:00Z" }), child("nested", { parentId: "parent" })];
    const { container } = render(panel(agents, { onSelectAgent: selected }));
    await user.click(screen.getByRole("button", { name: "Group by workflow" }));
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([expect.stringContaining("Primary"), expect.stringContaining("parent"), expect.stringContaining("nested")]);
    screen.getByRole("button", { name: "Select nested" }).focus();
    await user.keyboard("{Enter}");
    expect(selected).toHaveBeenCalledWith("nested");
    expect(rows()[2]).toHaveClass("rosterSelected");
    expect(container.querySelector("button button")).toBeNull();
  });

  it("opens the selected or requested workflow beyond the initial eight and supports Grid handoff", async () => {
    const user = userEvent.setup();
    const agents = [agent, ...Array.from({ length: 12 }, (_, index) => child(`worker ${index}`, { workflowId: "run" }))];
    const onMode = vi.fn();
    const { rerender } = render(panel(agents, { workflows: [workflow], selectedAgentId: "worker 11", onViewModeChange: onMode }));
    expect(rows()).toHaveLength(13);
    await user.click(screen.getByRole("button", { name: "Grid" }));
    expect(onMode).toHaveBeenCalledWith("grid");
    rerender(panel(agents, { viewMode: "grid" }));
    expect(within(roster()).getAllByRole("button", { name: /^Select / })).toHaveLength(13);
    rerender(panel(agents, { workflows: [workflow], workflowNavigation: { id: "run", request: 1 } }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Workflow · Verification/ })).toHaveAttribute("aria-expanded", "true"));
  });

  it("shares the phone filter sheet controls and returns focus when Done closes it", () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
    render(panel([agent]));
    const trigger = screen.getByRole("button", { name: "Filters 0" });
    fireEvent.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Agent filters" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Hide finished" }));
    expect(screen.getByRole("button", { name: "Filters 1" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("workflow navigation reveals its target despite a prior selection and excluding filters", async () => {
    const user = userEvent.setup();
    const agents = [agent, child("direct"), child("worker", { workflowId: "run", model: "workflow-model" })];
    const { rerender } = render(panel(agents, { workflows: [workflow] }));
    await user.click(screen.getByRole("button", { name: "Expand all 3" }));
    await user.click(screen.getByRole("button", { name: "Select direct" }));
    await user.type(screen.getByRole("searchbox", { name: "Filter agents" }), "missing");
    await user.click(screen.getByRole("button", { name: "Hide finished" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Agent status" }), "active");
    await user.selectOptions(screen.getByRole("combobox", { name: "Agent model" }), "test-model");
    await user.click(screen.getByRole("button", { name: "Group by workflow" }));
    rerender(panel(agents, { workflows: [workflow], workflowNavigation: { id: "run", request: 1 } }));
    expect(screen.getByRole("searchbox", { name: "Filter agents" })).toHaveValue("");
    expect(screen.getByRole("button", { name: /Workflow · Verification/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Select worker" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide finished" })).toHaveAttribute("aria-pressed", "false");
  });

  it("restores a valid saved selection, reveals its collapsed group, and discards a stale selection", async () => {
    window.localStorage.setItem("pomegr-agent-roster-selected-roster-test", "worker");
    const agents = [agent, child("worker", { workflowId: "run" })];
    const { rerender } = render(panel(agents, { workflows: [workflow] }));
    expect(await screen.findByRole("button", { name: "Select worker" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Workflow · Verification/ })).toHaveAttribute("aria-expanded", "true");
    window.localStorage.setItem("pomegr-agent-roster-selected-other", "missing-agent");
    rerender(panel(agents, { sessionId: "other", workflows: [workflow] }));
    expect(screen.getByRole("button", { name: "Select Primary agent" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens an insight-requested agent despite filters that excluded it", async () => {
    const user = userEvent.setup();
    const agents = [agent, child("direct"), child("worker", { workflowId: "run", model: "workflow-model" })];
    const { rerender } = render(panel(agents, { workflows: [workflow] }));
    await user.type(screen.getByRole("searchbox", { name: "Filter agents" }), "does-not-match");
    rerender(panel(agents, { workflows: [workflow], agentNavigation: { id: "worker", request: 1 } }));
    expect(screen.getByRole("searchbox", { name: "Filter agents" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Select worker" })).toHaveAttribute("aria-pressed", "true");
    const group = screen.getByRole("button", { name: /Workflow · Verification/ });
    expect(group).toHaveAttribute("aria-expanded", "true");
    await user.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
    rerender(panel(agents, { workflows: [workflow], agentNavigation: { id: "worker", request: 2 } }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Workflow · Verification/ })).toHaveAttribute("aria-expanded", "true"));
  });

  it("opens the inspector sheet only after a phone row selection", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(panel([agent, child("worker")]));
    expect(screen.queryByRole("dialog", { name: /Primary/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Direct subagents/ }));
    await user.click(screen.getByRole("button", { name: "Select worker" }));
    const inspector = screen.getByRole("dialog", { name: /worker/ });
    expect(inspector).toBeInTheDocument();
    await user.click(within(inspector).getAllByRole("button", { name: "Open in tree" })[0]);
    expect(screen.getByRole("tree", { name: "Agent spawn hierarchy" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    const restoredInspector = screen.getByRole("dialog", { name: /worker/ });
    expect(within(restoredInspector).getByRole("button", { name: "Back" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /worker/ })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Select worker" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps the roster mounted while the inspector opens the temporary tree", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(panel([agent, child("worker")]));
    await user.type(screen.getByRole("searchbox", { name: "Filter agents" }), "primary");
    await user.click(screen.getByRole("button", { name: "Open in tree" }));
    expect(screen.getByRole("region", { name: "Agent roster", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to agent activity" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to agent activity" }));
    expect(screen.getByRole("searchbox", { name: "Filter agents" })).toHaveValue("primary");
    expect(screen.getByRole("button", { name: "Select Primary agent" })).toHaveAttribute("aria-pressed", "true");
  });
});
