import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentsAnalyticsSnapshot, AgentsRun } from "../../shared/agents-contract";
import { AgentsView } from "../../app/components/agents/AgentsView";

const { useAgents } = vi.hoisted(() => ({ useAgents: vi.fn() }));
vi.mock("../../app/agents-client", () => ({ useAgents }));

function run(overrides: Partial<AgentsRun> = {}): AgentsRun {
  return {
    id: "run-main", agentId: "primary", sessionId: "codex:agents", source: "Codex", project: "Pomegr", sessionTitle: "Agent evidence", label: "Coordinate work", assignment: "Coordinate work", role: "orchestrator", model: "GPT-5.6 Terra", modelEvidence: "latest_reported", scope: "main", parentId: null, depth: 0, status: "active", startedAt: "2026-09-01T12:00:00.000Z", lastSeen: "2026-09-01T12:05:00.000Z", latestContextTotal: 18_000, toolCalls: 5, executionTaskCount: 2, work: [{ workKind: "read", count: 1 }, { workKind: "build", count: 1 }], ...overrides,
  };
}

function snapshot(): AgentsAnalyticsSnapshot {
  const main = run();
  const child = run({ id: "run-child", agentId: "worker", label: "Implement changes", assignment: "Implement changes", role: "builder", model: "GPT-5.6 Luna", scope: "delegated", parentId: "primary", depth: 1, status: "needs_input", latestContextTotal: 37_000 });
  return {
    revision: 1, readiness: "ready", generatedAt: "2026-09-01T12:05:00.000Z",
    coverage: { retainedSessions: 1, eligibleSessions: 1, missingSessions: 0, retainedRuns: 2, truncated: false, earliestStartedAt: "2026-09-01T12:00:00.000Z" },
    filters: { project: "all", days: 30, scope: "all", projects: ["Pomegr", "Atlas"] },
    summary: { runCount: 2, sessionCount: 1, modelCount: 2, mainRunCount: 1, delegatedRunCount: 1 },
    models: [
      { model: "GPT-5.6 Terra", runCount: 1, mainRunCount: 1, delegatedRunCount: 0, roles: [{ role: "orchestrator", runCount: 1 }] },
      { model: "GPT-5.6 Luna", runCount: 1, mainRunCount: 0, delegatedRunCount: 1, roles: [{ role: "builder", runCount: 1 }] },
    ],
    work: [{ workKind: "read", count: 1 }, { workKind: "build", count: 1 }], runs: [main, child], roster: [main, child],
  };
}

describe("Agents view", () => {
  beforeEach(() => { useAgents.mockReset(); useAgents.mockReturnValue({ data: snapshot(), loading: false, refreshing: false, connected: true, checkedAt: "2026-09-01T12:05:00.000Z" }); });

  it("renders precomputed model and work evidence, then opens bounded run evidence", async () => {
    const user = userEvent.setup();
    render(<AgentsView />);
    expect(screen.getByText("Latest reported model per agent run")).toBeInTheDocument();
    expect(screen.getByText("Recorded execution tasks across the selected agent runs")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "GPT-5.6 Terra, Coordinate, 1 runs" }));
    expect(screen.getByRole("dialog", { name: "GPT-5.6 Terra · Coordinate evidence" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Why is the model unreported?" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open parent session/ })).toHaveAttribute("href", expect.stringContaining("/sessions/"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains the unreported model group once and dismisses its popover before the panel", async () => {
    const user = userEvent.setup();
    const unreported = snapshot();
    unreported.runs = unreported.runs.map((entry) => ({ ...entry, model: null, modelEvidence: "unavailable" }));
    unreported.models = [{ model: null, runCount: 2, mainRunCount: 1, delegatedRunCount: 1, roles: [{ role: "orchestrator", runCount: 1 }, { role: "builder", runCount: 1 }] }];
    unreported.summary.modelCount = 0;
    useAgents.mockReturnValue({ data: unreported, loading: false, refreshing: false, connected: true, checkedAt: "2026-09-01T12:05:00.000Z" });
    render(<AgentsView />);

    await user.click(screen.getByRole("button", { name: "Unreported model" }));
    const panel = screen.getByRole("dialog", { name: "Unreported model evidence" });
    const [trigger] = within(panel).getAllByRole("button", { name: "Why is the model unreported?" });
    expect(within(panel).getAllByRole("button", { name: "Why is the model unreported?" })).toHaveLength(1);
    expect(within(panel).getAllByText(/Model unavailable/)).toHaveLength(2);
    expect(trigger).toHaveClass("dottedInfoPopoverTrigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.tab();
    expect(trigger).toHaveFocus();
    const popover = screen.getByRole("dialog", { name: "Why is the model unreported?" });
    expect(popover).toHaveTextContent("even without a model response");
    expect(popover).toHaveTextContent("only an API error");
    expect(popover).toHaveTextContent("model metadata was not captured by Pomegr");
    expect(popover).toHaveTextContent("A requested model does not confirm which model actually ran.");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Why is the model unreported?" })).not.toBeInTheDocument();
    expect(panel).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the live roster in backend order without sortable headers", async () => {
    const user = userEvent.setup();
    render(<AgentsView />);
    await user.click(screen.getByRole("tab", { name: /Live agents/ }));
    const table = screen.getByRole("table", { name: "Observed live agents" });
    expect(within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual([expect.stringContaining("Coordinate work"), expect.stringContaining("Implement changes")]);
    for (const header of within(table).getAllByRole("columnheader")) {
      expect(header).not.toHaveAttribute("aria-sort");
      expect(within(header).queryByRole("button")).toBeNull();
    }
    await user.selectOptions(screen.getByRole("combobox", { name: "Agent state" }), "needs_input");
    expect(within(table).getByText("Implement changes")).toBeInTheDocument();
    expect(within(table).queryByText("Coordinate work")).not.toBeInTheDocument();
  });

  it("requests an independent selected filter and preserves an honest unavailable state", async () => {
    const user = userEvent.setup();
    const view = render(<AgentsView />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "Atlas");
    expect(useAgents).toHaveBeenLastCalledWith({ project: "Atlas", days: 30, scope: "all" });
    useAgents.mockReturnValue({ data: null, loading: false, refreshing: false, connected: false, checkedAt: null });
    view.unmount();
    render(<AgentsView />);
    expect(screen.getByText("Agent summary unavailable")).toBeInTheDocument();
  });

  it("discloses partial retained coverage and the counting method", () => {
    const partial = snapshot();
    partial.coverage = { ...partial.coverage, missingSessions: 1, truncated: true };
    useAgents.mockReturnValue({ data: partial, loading: false, refreshing: false, connected: true, checkedAt: "2026-09-01T12:05:00.000Z" });
    render(<AgentsView />);
    expect(screen.getByText(/Partial coverage/)).toBeInTheDocument();
    expect(screen.getByText("How are these numbers counted?")).toBeInTheDocument();
  });

  it("explains initial loading and keeps committed evidence visible during refresh", () => {
    useAgents.mockReturnValue({ data: null, loading: true, refreshing: false, connected: true, checkedAt: null });
    const view = render(<AgentsView />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading agent information. You can leave this page and check back later; it refreshes automatically when you return.");
    expect(screen.getByLabelText("Loading agent summary")).toBeInTheDocument();
    expect(screen.queryByText("No agents in this selection")).not.toBeInTheDocument();

    useAgents.mockReturnValue({ data: snapshot(), loading: false, refreshing: true, connected: true, checkedAt: "2026-09-01T12:05:00.000Z" });
    view.rerender(<AgentsView />);
    expect(screen.queryByLabelText("Loading agent summary")).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading agent information/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Summary observed")).toBeInTheDocument();
    expect(screen.getByText("Latest reported model per agent run")).toBeInTheDocument();
  });

  it("distinguishes missing agent information from a complete empty selection", () => {
    const empty = snapshot();
    empty.summary = { runCount: 0, sessionCount: 0, modelCount: 0, mainRunCount: 0, delegatedRunCount: 0 };
    empty.models = []; empty.work = []; empty.runs = []; empty.roster = [];
    empty.coverage = { retainedSessions: 0, eligibleSessions: 50, missingSessions: 50, retainedRuns: 0, truncated: false, earliestStartedAt: null };
    useAgents.mockReturnValue({ data: empty, loading: false, refreshing: false, connected: true, checkedAt: "2026-09-01T12:05:00.000Z" });
    const view = render(<AgentsView />);
    expect(screen.getByRole("heading", { name: "Waiting for agent information" })).toBeInTheDocument();
    expect(screen.getByText("Check back later. This page updates automatically.")).toBeInTheDocument();
    expect(screen.getByText("Some past sessions may remain unavailable.").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("Try another project, time range, or agent scope.")).not.toBeInTheDocument();
    expect(screen.queryByText("agent runs", { exact: false, selector: "span" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Loading agent summary")).not.toBeInTheDocument();

    useAgents.mockReturnValue({ data: { ...empty, coverage: { ...empty.coverage, eligibleSessions: 0, missingSessions: 0 } }, loading: false, refreshing: false, connected: true, checkedAt: "2026-09-01T12:05:00.000Z" });
    view.rerender(<AgentsView />);
    expect(screen.getByRole("heading", { name: "No agents in this selection" })).toBeInTheDocument();
    expect(screen.getByText("Try another project, time range, or agent scope.")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for agent information")).not.toBeInTheDocument();
  });

  it("uses role-based patterns and drills into the exact model and role", async () => {
    const user = userEvent.setup();
    render(<AgentsView />);
    expect(screen.getByText("GPT-5.6 Luna appears in 1 of 1 Build run.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Inspect build runs/ }));
    const evidence = screen.getByRole("dialog", { name: "GPT-5.6 Luna · Build evidence" });
    expect(within(evidence).getByText("Implement changes")).toBeInTheDocument();
    expect(within(evidence).queryByText("Coordinate work")).not.toBeInTheDocument();
  });

  it("distinguishes recorded zero tasks from partial or unavailable work evidence", () => {
    const zero = snapshot();
    zero.runs = zero.runs.map((entry) => ({ ...entry, executionTaskCount: 0, work: [] }));
    zero.work = [];
    useAgents.mockReturnValue({ data: zero, loading: false, refreshing: false, connected: true, checkedAt: "2026-09-01T12:05:00.000Z" });
    const view = render(<AgentsView />);
    expect(screen.getByText("No recorded execution tasks in this selection.")).toBeInTheDocument();
    view.unmount();

    const partial = snapshot();
    partial.runs = partial.runs.map((entry) => entry.id === "run-child" ? { ...entry, executionTaskCount: null, work: [] } : entry);
    useAgents.mockReturnValue({ data: partial, loading: false, refreshing: false, connected: true, checkedAt: "2026-09-01T12:05:00.000Z" });
    render(<AgentsView />);
    expect(screen.getByText("Some selected runs have no recorded execution-task data; displayed counts include available evidence only.")).toBeInTheDocument();
  });
});
