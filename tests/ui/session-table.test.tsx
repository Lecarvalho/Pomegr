import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionsView } from "../../app/components/command-center/CommandViews";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { SessionSummary } from "../../shared/monitor-contract";

const sessions = [
  { id: "codex:progress", provider: "codex", source: "Codex", title: "Progress available", project: "Pomegr", updatedAt: "2026-08-29T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working", summaryReadiness: "ready", agentCount: 2, activeAgentCount: 1, latestContextTotal: 12_000, progress: { phase: "implementing", percent: 42, remainingMinutesMin: 3, remainingMinutesMax: 6, confidence: "medium", reportedAt: "2026-08-29T12:00:00.000Z" }, currentActivity: { label: "Preparing tab4 for header measurement", observedAt: "2026-08-29T12:00:00.000Z", state: "current" } },
  { id: "claude:no-progress", provider: "claude", source: "Claude Code", title: "Progress unavailable", project: "Pomegr", updatedAt: "2026-08-29T11:59:00.000Z", isLive: true, needsInput: false, activityStatus: "idle", summaryReadiness: "ready", agentCount: 1, activeAgentCount: 0, latestContextTotal: 8_000, progress: null, currentActivity: null },
] satisfies SessionSummary[];
const activity = sessions[0].currentActivity!;

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

  it("clears a heading in both responsive placements when an idle revision arrives", () => {
    const view = render(<SessionCatalogProvider sessions={[sessions[0]]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getAllByLabelText(/^Current activity:/)).toHaveLength(2);
    expect(view.container.querySelectorAll(".commandTableActivityMark")).toHaveLength(2);
    // Contradictory legacy payload: the row lifecycle must still suppress the old heading.
    view.rerender(<SessionCatalogProvider sessions={[{ ...sessions[0], activityStatus: "idle" }]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.queryByText(activity.label)).not.toBeInTheDocument();
    expect(view.container.querySelector(".commandTableActivityMark")).toBeNull();
    expect(screen.getByTitle("Current provider-reported activity is unavailable")).toHaveTextContent("—");
  });

  it.each(["working", "unknown", "needs_input"] as const)("shows an em dash for a legacy retained heading in %s rows", (activityStatus) => {
    const session: SessionSummary = JSON.parse(JSON.stringify({ ...sessions[0], activityStatus, currentActivity: { ...activity, state: "last_observed" } }));
    const view = render(<SessionCatalogProvider sessions={[session]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.queryByText(/Last observed/)).not.toBeInTheDocument();
    expect(screen.queryByText(activity.label)).not.toBeInTheDocument();
    expect(screen.getByTitle("Current provider-reported activity is unavailable")).toHaveTextContent("—");
    expect(screen.queryByLabelText(/^Current activity:/)).not.toBeInTheDocument();
    expect(view.container.querySelector(".commandTableActivityMark")).toBeNull();
  });

  it("shows an em dash when the catalog is uncertain", () => {
    const view = render(<SessionCatalogProvider sessions={[{ ...sessions[0], activityStatus: "unknown" }]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.queryByText(activity.label)).not.toBeInTheDocument();
    expect(screen.getByTitle("Current provider-reported activity is unavailable")).toHaveTextContent("—");
    expect(view.container.querySelector(".commandTableActivityMark")).toBeNull();
  });

  it("keeps a qualified active primary current when a child needs input", () => {
    const view = render(<SessionCatalogProvider sessions={[{ ...sessions[0], activityStatus: "needs_input" }]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getAllByLabelText(/^Current activity:/)).toHaveLength(2);
    expect(view.container.querySelectorAll(".commandTableActivityMark")).toHaveLength(2);
  });

  it("shows an em dash for missing qualification from an older monitor", () => {
    const legacy: SessionSummary = JSON.parse(JSON.stringify(sessions[0]));
    Reflect.deleteProperty(legacy.currentActivity!, "state");
    const view = render(<SessionCatalogProvider sessions={[legacy]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.queryByLabelText(/^Last observed activity:/)).not.toBeInTheDocument();
    expect(screen.queryByText(activity.label)).not.toBeInTheDocument();
    expect(screen.getByTitle("Current provider-reported activity is unavailable")).toHaveTextContent("—");
    expect(view.container.querySelector(".commandTableActivityMark")).toBeNull();
  });

  it("suppresses historical headings and renders current labels as plain text", () => {
    const view = render(<SessionCatalogProvider sessions={[{ ...sessions[0], isLive: false }]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.queryByText(activity.label)).not.toBeInTheDocument();
    const label = '<img src=x onerror="alert(1)">';
    view.rerender(<SessionCatalogProvider sessions={[{ ...sessions[0], currentActivity: { ...activity, label } }]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getAllByText(label, { exact: false })).toHaveLength(2);
    expect(view.container.querySelector(".commandTableActivity img")).toBeNull();
  });
});
