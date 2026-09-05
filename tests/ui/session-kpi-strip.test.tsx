import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { render as renderUi, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Agent, MonitorState } from "../../shared/monitor-contract";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import { SessionKpiStrip } from "../../app/components/dashboard/SessionKpiStrip";
import { SessionHero } from "../../app/components/dashboard/SessionHero";
import { agent, claudeCapabilities, repositorySession } from "./dashboard-test-fixtures";

function render(ui: React.ReactNode) { return renderUi(ui, { wrapper: ({ children }) => <LiveClockProvider running={false}>{children}</LiveClockProvider> }); }

function state(): MonitorState {
  const initial = createEmptyMonitorState();
  const statuses: Agent["status"][] = ["active", "idle", "waiting", "warm", "finished", "stopped", "needs_input"];
  return {
    ...initial,
    session: { ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }), durationMs: 120_000 },
    agents: statuses.map((status, index) => ({ ...agent, id: `agent-${index}`, status })),
    metrics: { ...initial.metrics, agents: statuses.length, toolCalls: 12345, repeatedCalls: 12, tokens: { ...initial.metrics.tokens, allAgents: 250_000 } },
  };
}

describe("session KPI strip", () => {
  it("shows observed agents, status tallies and request-independent measurements", () => {
    const { container } = render(<SessionKpiStrip state={state()} historical />);
    const strip = screen.getByRole("region", { name: "Session totals" });
    expect(strip).toHaveTextContent("1 active · 3 idle · 2 finished");
    expect(screen.getByText("1 active")).toHaveClass("sessionPositive");
    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("12 repeated")).toBeInTheDocument();
    expect(screen.getByText("Sum of latest snapshots · not spend")).toBeInTheDocument();
    expect(screen.getByText("Recorded wall time")).toBeInTheDocument();
    expect(screen.getByText("No estimate recorded").parentElement).toHaveTextContent("—");
    expect(container.querySelector(".summaryStrip")).toBeNull();
    expect(within(strip).queryByText("Flow score")).not.toBeInTheDocument();
  });

  it("keeps core wall time and ready siblings visible while evidence loads", () => {
    const data = state();
    data.readiness = { core: "ready", agentEvidence: "loading", contextEvidence: "ready", activityEvidence: "loading", repository: "loading", resources: "loading", usageLimits: "loading" };
    render(<SessionKpiStrip state={data} historical />);
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.getByText("250K")).toBeInTheDocument();
    expect(screen.getByText("2m")).toBeInTheDocument();
    expect(screen.queryByText("12,345")).not.toBeInTheDocument();
    expect(screen.queryByText("No estimate recorded")).not.toBeInTheDocument();
  });

  it("waits for core evidence and distinguishes unavailable evidence from zero", () => {
    const data = state();
    data.readiness = { core: "loading", agentEvidence: "unavailable", contextEvidence: "unavailable", activityEvidence: "unavailable", repository: "unavailable", resources: "unavailable", usageLimits: "unavailable" };
    const { container, rerender } = render(<SessionKpiStrip state={data} historical />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SessionKpiStrip state={{ ...data, readiness: { ...data.readiness, core: "ready" } }} historical />);
    expect(screen.getAllByText("Evidence unavailable")).toHaveLength(4);
    expect(screen.getByText("2m")).toBeInTheDocument();
  });

  it("renders the transcript estimate with phase, range and confidence", () => {
    const data = state();
    data.session!.progress = { phase: "verifying", percent: 65, remainingMinutesMin: 5, remainingMinutesMax: 15, confidence: "low", reportedAt: "2026-09-05T12:00:00Z" };
    render(<SessionKpiStrip state={data} historical={false} />);
    expect(screen.getByText("65%")).toHaveClass("sessionPositive");
    expect(screen.getByText("Verifying · 5–15 min · low confidence")).toBeInTheDocument();
    expect(screen.getByText("Wall time")).toBeInTheDocument();
  });
});

describe("session hero status", () => {
  it.each([
    ["working", false, "Live session · active"],
    ["idle", false, "Live session · idle"],
    ["needs_input", false, "Live session · needs your input"],
    ["unknown", false, "Live session · unknown"],
    ["working", true, "Recorded session · ended"],
  ] as const)("renders %s with historical=%s", (activityStatus, historical, label) => {
    render(<SessionHero session={state().session} source="Claude Code" capabilities={claudeCapabilities} historical={historical} activityStatus={activityStatus} />);
    expect(screen.getByLabelText("Session status")).toHaveTextContent(label);
    expect(screen.getByText(historical ? "Historical snapshot" : "Live session")).toHaveClass("commandBadge");
    expect(screen.getByLabelText("Session status")).toHaveTextContent("Time unavailable");
  });
});
