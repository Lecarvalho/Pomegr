import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent as primary } from "./dashboard-test-fixtures";

const worker = (id = "worker", overrides: Partial<Agent> = {}): Agent => ({ ...primary, id, label: id, parentId: "primary", assignment: null, ...overrides });

function panel(agents: Agent[], props: Partial<React.ComponentProps<typeof AgentActivityPanel>> = {}) {
  return <LiveClockProvider running={false}><AgentActivityPanel agents={agents} executionTasks={[]} planTasks={[]} historical sessionId="tree-focus-test" {...props} /></LiveClockProvider>;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("focused agent tree integration", () => {
  it("replaces the desktop roster with an agent-focused tree and restores the inspector opener on Back or Escape", async () => {
    const user = userEvent.setup();
    render(panel([primary, worker()]));
    const opener = within(screen.getByRole("region", { name: "Agent inspector for Primary agent" })).getByRole("button", { name: "Open in tree" });
    await user.click(opener);
    expect(screen.getByRole("heading", { name: "Tree · focused on Primary agent" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent roster", hidden: true })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to agent activity" }));
    expect(opener).toHaveFocus();
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("opens a group at its first evidence-order agent without changing the desktop roster selection", async () => {
    const user = userEvent.setup();
    const first = worker("first", { workflowOrder: 2 });
    const evidenceFirst = worker("evidence-first", { workflowOrder: 1 });
    render(panel([primary, first, evidenceFirst]));
    const roster = screen.getByRole("region", { name: "Agent roster" });
    const opener = within(roster).getByRole("button", { name: "Open in tree" });
    await user.click(opener);
    expect(screen.getByRole("heading", { name: "Tree · focused on evidence-first" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to agent activity" }));
    expect(opener).toHaveFocus();
    expect(screen.getByRole("button", { name: "Select Primary agent" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the first agent from a grid workflow lane", async () => {
    const user = userEvent.setup();
    const workflowWorker = worker("workflow-worker", { workflowId: "workflow", workflowOrder: 1 });
    render(panel([primary, workflowWorker], { viewMode: "grid" }));
    const openers = within(screen.getByRole("region", { name: "Agent roster" })).getAllByRole("button", { name: "Open in tree" });
    await user.click(openers.at(-1)!);
    expect(screen.getByRole("heading", { name: "Tree · focused on workflow-worker" })).toBeInTheDocument();
  });

  it("returns from the phone tree to the inspector, then to its original row", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(panel([primary, worker()]));
    await user.click(screen.getByRole("button", { name: /Direct subagents/ }));
    const row = screen.getByRole("button", { name: "Select worker" });
    await user.click(row);
    const inspector = screen.getByRole("dialog", { name: "worker" });
    await user.click(within(inspector).getAllByRole("button", { name: "Open in tree" })[0]);
    expect(screen.getByRole("dialog", { name: "Tree · worker" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "worker" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "worker" })).not.toBeInTheDocument());
    expect(row).toHaveFocus();
  });

  it("returns to the focused phone inspector from a group entry even while selection is controlled", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const onSelectAgent = vi.fn();
    render(panel([primary, worker()], { selectedAgentId: "primary", onSelectAgent }));
    const opener = within(screen.getByRole("region", { name: "Agent roster" })).getByRole("button", { name: "Open in tree" });
    await user.click(opener);
    expect(onSelectAgent).toHaveBeenCalledWith("worker");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "worker" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("safely returns to the roster if a focused agent disappears in a live update", async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel([primary, worker()]));
    await user.click(within(screen.getByRole("region", { name: "Agent roster" })).getByRole("button", { name: "Open in tree" }));
    rerender(panel([primary]));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Tree · focused on/ })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Agent roster" })).toBeInTheDocument();
  });
});
