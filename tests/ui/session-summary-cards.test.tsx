import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import type { MonitorState } from "../../shared/monitor-contract";
import { SessionSummaryCards } from "../../app/components/dashboard/SessionSummaryCards";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent } from "./dashboard-test-fixtures";

function stateWith(overrides: Partial<MonitorState> = {}) {
  return { ...createEmptyMonitorState({ connected: true }), ...overrides } as MonitorState;
}

describe("session summary cards", () => {
  it("aggregates workflow members once and uses the workflow duration sum", () => {
    const state = stateWith({
      agents: [
        { ...agent, id: "worker-1", workflowId: "one", tokens: { ...agent.tokens, total: 100 } },
        { ...agent, id: "worker-2", workflowId: "two", tokens: { ...agent.tokens, total: 200 } },
      ],
      workflows: [
        { id: "one", name: "one", summary: null, status: "running", metadataStatus: "ready", startedAt: null, updatedAt: null, durationMs: 120_000, agentIds: ["worker-1"], phases: [] },
        { id: "two", name: "two", summary: null, status: "completed", metadataStatus: "ready", startedAt: null, updatedAt: null, durationMs: 180_000, agentIds: ["worker-2", "worker-1"], phases: [] },
      ],
    });

    render(<LiveClockProvider running={false}><SessionSummaryCards state={state} historical={false} paused={false} needsInput={false} /></LiveClockProvider>);

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(document.querySelector(".sessionSummaryHeadline")).toHaveTextContent("2 agents");
    expect(screen.getByText("5m")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(document.querySelector(".sessionWorkflowList")?.textContent).toContain("2 agents · 3m");
  });

  it("shows the recorded empty workflow state", () => {
    const state = stateWith();
    render(<LiveClockProvider running={false}><SessionSummaryCards state={state} historical={true} paused={false} needsInput={false} /></LiveClockProvider>);

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("No workflows recorded for this session.")).toBeInTheDocument();
    expect(document.querySelector(".sessionSummaryCards")?.children).toHaveLength(3);
    expect(screen.getByText("No estimate recorded")).toBeInTheDocument();
  });

  it("limits compact signals to two and expands them with agent links", async () => {
    const user = userEvent.setup();
    const state = stateWith({ insights: [
      { id: "a", level: "warning", title: "Warning one", detail: "Detail one", agentId: "worker-1" },
      { id: "b", level: "info", title: "Info two", detail: "Detail two" },
      { id: "c", level: "warning", title: "Warning three", detail: "Detail three", agentId: "worker-3" },
    ]});
    render(<LiveClockProvider running={false}><SessionSummaryCards state={state} historical={false} paused={false} needsInput={false} /></LiveClockProvider>);

    expect(screen.getByText("2 attention")).toBeInTheDocument();
    expect(screen.getByText("Warning one")).toBeInTheDocument();
    expect(screen.queryByText("Warning three")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show all 3" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Show agent" })[0]).toHaveAttribute("href", "#agent-activity");
    await user.click(screen.getByRole("link", { name: "Show all 3" }));
    expect(screen.getByText("Warning three")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Show agent" })).toHaveLength(2);
    await user.click(screen.getByRole("link", { name: "Show fewer" }));
    expect(screen.queryByText("Warning three")).not.toBeInTheDocument();
  });
});
