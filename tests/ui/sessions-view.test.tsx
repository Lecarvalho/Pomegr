import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SessionsView } from "../../app/components/command-center/CommandViews";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { SessionSummary } from "../../shared/monitor-contract";

function session(index: number): SessionSummary {
  const createdAt = new Date(Date.UTC(2026, 7, 1, 12, index)).toISOString();
  return {
    id: `codex:session-${index}`,
    provider: "codex",
    source: "Codex",
    title: `Session ${index}`,
    project: "Pomegr",
    createdAt,
    updatedAt: index === 1 ? "2026-08-29T12:00:00.000Z" : createdAt,
    isLive: false,
    needsInput: false,
    activityStatus: "unknown",
    summaryReadiness: "ready",
    agentCount: index,
    activeAgentCount: 0,
    latestContextTotal: index * 1_000,
    progress: { phase: "complete", percent: 100, confidence: "high", reportedAt: createdAt },
    currentActivity: null,
  };
}

function visibleSessionTitles() {
  const table = screen.getByRole("table", { name: "Observed Pomegr sessions" });
  return Array.from(table.querySelectorAll("tbody .commandTablePrimary strong"), (node) => node.textContent);
}

describe("Sessions view", () => {
  it("orders by creation time descending and paginates ten rows at a time", async () => {
    const user = userEvent.setup();
    const sessions = Array.from({ length: 12 }, (_, index) => session(index + 1));
    render(<SessionCatalogProvider sessions={sessions}><SessionsView /></SessionCatalogProvider>);

    expect(visibleSessionTitles()).toEqual(Array.from({ length: 10 }, (_, index) => `Session ${12 - index}`));
    expect(screen.getByText("Showing 1–10 of 12")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Current activity" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Go to page 1" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(visibleSessionTitles()).toEqual(["Session 2", "Session 1"]);
    expect(screen.getByText("Showing 11–12 of 12")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(8);
    const completedRow = screen.getByText("Session 1").closest("tr");
    expect(completedRow).not.toBeNull();
    expect(within(completedRow!).getByText("0/1").closest("td")).toHaveAttribute("data-label", "Agents");
    expect(within(completedRow!).getByText("1k").closest("td")).toHaveAttribute("data-label", "Context");
    expect(within(completedRow!).getByTitle("Agent-reported session progress")).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.type(screen.getByRole("searchbox", { name: "Filter sessions" }), "Session 12");
    expect(visibleSessionTitles()).toEqual(["Session 12"]);
    expect(screen.queryByRole("navigation", { name: "Session pages" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("toolbar", { name: "Filters" })).getByText("1 matches")).toBeInTheDocument();
  });
});
