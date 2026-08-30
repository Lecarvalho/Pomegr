import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionsView } from "../../app/components/command-center/CommandViews";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { SessionSummary } from "../../shared/monitor-contract";

const sessions = [
  { id: "codex:progress", provider: "codex", source: "Codex", title: "Progress available", project: "Pomegr", updatedAt: "2026-08-29T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working", summaryReadiness: "ready", agentCount: 2, activeAgentCount: 1, latestContextTotal: 12_000, progress: { phase: "implementing", percent: 42, remainingMinutesMin: 3, remainingMinutesMax: 6, confidence: "medium", reportedAt: "2026-08-29T12:00:00.000Z" }, currentActivity: { label: "Preparing tab4 for header measurement", observedAt: "2026-08-29T12:00:00.000Z" } },
  { id: "claude:no-progress", provider: "claude", source: "Claude Code", title: "Progress unavailable", project: "Pomegr", updatedAt: "2026-08-29T11:59:00.000Z", isLive: true, needsInput: false, activityStatus: "idle", summaryReadiness: "ready", agentCount: 1, activeAgentCount: 0, latestContextTotal: 8_000, progress: null, currentActivity: null },
] satisfies SessionSummary[];

describe("sessions table", () => {
  it("shows agent-reported progress percentages when any visible session has them", () => {
    render(<SessionCatalogProvider sessions={sessions}><SessionsView /></SessionCatalogProvider>);

    const table = screen.getByRole("table", { name: "Observed Pomegr sessions" });
    expect(within(table).getByRole("columnheader", { name: "Progress" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Current activity" })).toBeInTheDocument();

    const progressRow = within(table).getByText("Progress available").closest("tr");
    const unavailableRow = within(table).getByText("Progress unavailable").closest("tr");
    expect(progressRow).not.toBeNull();
    expect(unavailableRow).not.toBeNull();
    expect(within(progressRow!).getByText("Active").closest("td")).toHaveAttribute("data-label", "State");
    expect(within(progressRow!).getByText("1/2").closest("td")).toHaveAttribute("data-label", "Agents");
    expect(within(progressRow!).getByText("12k").closest("td")).toHaveAttribute("data-label", "Context");
    expect(within(progressRow!).getByTitle("Agent-reported session progress")).toHaveTextContent("42%");
    expect(within(progressRow!).getByTitle("Agent-reported session progress").closest("td")).toHaveAttribute("data-label", "Progress");
    expect(within(unavailableRow!).getByTitle("Agent-reported session progress is unavailable")).toHaveTextContent("—");
    expect(within(progressRow!).getAllByText("Preparing tab4 for header measurement")).toHaveLength(2);
    expect(within(progressRow!).getAllByTitle(/Provider-reported · observed/)).toHaveLength(2);
    expect(within(unavailableRow!).getByTitle("Current provider-reported activity is unavailable")).toHaveTextContent("—");
  });

  it("keeps the progress column stable when no visible session reports progress", () => {
    render(<SessionCatalogProvider sessions={sessions.map((session) => ({ ...session, progress: null }))}><SessionsView /></SessionCatalogProvider>);

    expect(screen.getByRole("columnheader", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getAllByTitle("Agent-reported session progress is unavailable")).toHaveLength(2);
  });
});
