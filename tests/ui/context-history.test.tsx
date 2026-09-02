import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../shared/monitor-contract";
import { ContextHistoryPanel } from "../../app/components/dashboard/ContextHistoryPanel";
import { agent } from "./dashboard-test-fixtures";

describe("context history", () => {
  const childAgent: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder", tokens: { ...agent.tokens, total: 220_000 } };
  const buckets = [
    { start: "2026-08-09T12:00:00.000Z", end: "2026-08-09T12:01:00.000Z", total: 100_000, agents: [{ agentId: "primary", total: 100_000 }] },
    { start: "2026-08-09T12:01:00.000Z", end: "2026-08-09T12:02:00.000Z", total: 300_000, agents: [{ agentId: "child", total: 220_000 }, { agentId: "primary", total: 80_000 }] },
  ];
  const tokens = {
    allAgents: 300_000,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    contextHistory: { bucketMs: 60_000, buckets, boundaries: [{ id: "boundary-1", agentId: "primary", timestamp: "2026-08-09T12:01:30.000Z", kind: "snapshot_drop" as const, preTokens: 100_000 }] },
    cacheEvents: { status: "ready" as const, items: [], possibleFullRefills: [] },
    cacheReadDrops: { status: "unavailable" as const, items: [] },
    requestSnapshots: { status: "ready" as const, items: [] },
  };

  it("defaults to primary context levels and keeps one fixed scale across scopes", async () => {
    const user = userEvent.setup();
    const { container } = render(<ContextHistoryPanel agents={[agent, childAgent]} tokens={tokens} historical={false} />);

    expect(screen.getByText("Latest request snapshot over time for Primary agent. Not cumulative token use.")).toBeInTheDocument();
    expect(container.querySelector(".contextHistoryLine")?.getAttribute("d")).toMatch(/^M /);
    expect(container.querySelector(".contextHistoryLine")?.getAttribute("d")).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector(".contextHistoryScale span")).toHaveTextContent("500K");
    expect(container.querySelectorAll(".contextBoundary.snapshot_drop")).toHaveLength(1);
    expect(screen.getAllByText("Snapshot decrease").length).toBeGreaterThan(0);
    expect(screen.getByText("Snapshot decrease · 100K before")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Context scope"), "all-agents");
    expect(screen.getByText(/Sum of each agent’s latest carried-forward snapshot/)).toBeInTheDocument();
    expect(screen.getByText("300K context")).toBeInTheDocument();
    expect(container.querySelector(".contextHistoryScale span")).toHaveTextContent("500K");
  });

  it("uses one keyboard-inspectable chart surface with arrow, Home, and End navigation", () => {
    const { container } = render(<ContextHistoryPanel agents={[agent, childAgent]} tokens={tokens} historical={false} />);
    const chart = screen.getByRole("group", { name: /Primary agent context history/ });

    expect(chart).toHaveAttribute("tabindex", "0");
    expect(container.querySelectorAll('.contextHistoryChart [tabindex="0"]')).toHaveLength(0);
    fireEvent.keyDown(chart, { key: "Home" });
    expect(container.querySelector(".contextHistoryAnnouncement")).toHaveTextContent("100,000 context");
    expect(screen.getByRole("button", { name: "Latest" })).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "End" });
    expect(container.querySelector(".contextHistoryAnnouncement")).toHaveTextContent("80,000 context");
    expect(screen.queryByRole("button", { name: "Latest" })).not.toBeInTheDocument();
  });

  it("has no cache evidence content and uses factual history empty states", () => {
    const emptyTokens = { ...tokens, contextHistory: { bucketMs: 0, buckets: [], boundaries: [] } };
    const { rerender } = render(<ContextHistoryPanel agents={[agent]} tokens={emptyTokens} historical={false} />);
    expect(screen.getByText("Context history will appear after the first model response.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cache evidence" })).not.toBeInTheDocument();

    rerender(<ContextHistoryPanel agents={[agent]} tokens={emptyTokens} historical />);
    expect(screen.getByText("No context snapshots were recorded for Primary agent.")).toBeInTheDocument();
  });
});
