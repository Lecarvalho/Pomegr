import { render, screen, waitFor, within } from "@testing-library/react";
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
    activityFallback: null,
  };
}

function visibleSessionTitles() {
  const table = screen.getByRole("table", { name: "Observed Pomegr sessions" });
  return Array.from(table.querySelectorAll("tbody .commandTablePrimary strong"), (node) => node.textContent);
}

describe("Sessions view", () => {
  it.each(["claude", "codex"] as const)("keeps a confirmed open %s session in Live between turns", async (provider) => {
    const user = userEvent.setup();
    const running: SessionSummary = { ...session(1), id: provider + ":session-1", provider, isLive: true, activityStatus: "working" };
    const view = render(<SessionCatalogProvider sessions={[running]}><SessionsView /></SessionCatalogProvider>);
    await user.click(screen.getByRole("button", { name: /^Live/ }));
    expect(screen.getByText("In progress")).toBeInTheDocument();

    const open: SessionSummary = { ...running, activityStatus: "open", activeAgentCount: 0 };
    view.rerender(<SessionCatalogProvider sessions={[open]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getByRole("button", { name: /^Live/ })).toHaveAttribute("aria-pressed", "true");
    expect(visibleSessionTitles()).toEqual(["Session 1"]);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^History/ }));
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Live/ }));
    view.rerender(<SessionCatalogProvider sessions={[running]}><SessionsView /></SessionCatalogProvider>);
    expect(visibleSessionTitles()).toEqual(["Session 1"]);
    expect(screen.getByText("In progress")).toBeInTheDocument();

    view.rerender(<SessionCatalogProvider sessions={[{ ...open, isLive: false, activityStatus: "idle" }]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^History/ }));
    expect(visibleSessionTitles()).toEqual(["Session 1"]);
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it.each(["Agents", "Context", "Progress", "Updated"])("toggles %s numerically and keeps unavailable values last", async (column) => {
    const user = userEvent.setup();
    const values = column === "Updated" ? [10, 2, 0] : [10, 2, 0, null];
    const missing = column === "Updated" ? [] : ["Session 4"];
    const sessions = values.map((value, index): SessionSummary => ({
      ...session(index + 1),
      agentCount: value,
      activeAgentCount: value === null ? null : 0,
      latestContextTotal: value === null ? null : 100_000 + value,
      progress: value === null ? null : { phase: "implementing", percent: value, confidence: "high", reportedAt: session(index + 1).updatedAt },
      updatedAt: value === null ? session(index + 1).updatedAt : new Date(Date.UTC(2026, 7, 1, 12, value)).toISOString(),
    }));
    const before = structuredClone(sessions);
    render(<SessionCatalogProvider sessions={sessions}><SessionsView /></SessionCatalogProvider>);
    const button = screen.getByRole("button", { name: column });
    const header = screen.getByRole("columnheader", { name: column });
    await user.click(button);
    expect(visibleSessionTitles()).toEqual(["Session 1", "Session 2", "Session 3", ...missing]);
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(visibleSessionTitles()).toEqual(["Session 3", "Session 2", "Session 1", ...missing]);
    expect(header).toHaveAttribute("aria-sort", "ascending");
    await user.keyboard(" ");
    expect(visibleSessionTitles()).toEqual(["Session 1", "Session 2", "Session 3", ...missing]);
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(sessions).toEqual(before);
  });

  it("sorts all matches before paging, resets the page, and keeps the sort on catalog updates", async () => {
    const user = userEvent.setup();
    const sessions = Array.from({ length: 12 }, (_, index) => session(index + 1));
    const view = render(<SessionCatalogProvider sessions={sessions}><SessionsView /></SessionCatalogProvider>);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Agents" }));
    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(visibleSessionTitles()).toEqual(Array.from({ length: 10 }, (_, index) => "Session " + (index + 1)));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(visibleSessionTitles()).toEqual(["Session 11", "Session 12"]);
    await user.click(screen.getByRole("button", { name: "Updated" }));
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(visibleSessionTitles()[0]).toBe("Session 1");
    expect(screen.getByRole("columnheader", { name: "Agents" })).not.toHaveAttribute("aria-sort");
    expect(screen.getByRole("columnheader", { name: "Updated" })).toHaveAttribute("aria-sort", "descending");
    await user.type(screen.getByRole("searchbox", { name: "Filter sessions" }), "Session 1");
    expect(visibleSessionTitles()).toEqual(["Session 1", "Session 12", "Session 11", "Session 10"]);
    view.rerender(<SessionCatalogProvider sessions={sessions.map((item) => item.id === "codex:session-10" ? { ...item, updatedAt: "2026-09-01T12:00:00.000Z" } : item)}><SessionsView /></SessionCatalogProvider>);
    expect(visibleSessionTitles()).toEqual(["Session 10", "Session 1", "Session 12", "Session 11"]);
  });

  it("defaults to Live as the catalog loads and preserves a manually selected filter", async () => {
    const user = userEvent.setup();
    const liveUnknown = { ...session(1), title: "Live unknown", isLive: true, activityStatus: "unknown" as const };
    const quietOpen = { ...session(2), title: "Quiet open", isLive: false, activityStatus: "open" as const };
    const view = render(<SessionCatalogProvider sessions={[]} loading><SessionsView /></SessionCatalogProvider>);
    view.rerender(<SessionCatalogProvider sessions={[liveUnknown, quietOpen]}><SessionsView /></SessionCatalogProvider>);

    expect(screen.getByRole("button", { name: /^Live/ })).toHaveAttribute("aria-pressed", "true");

    expect(visibleSessionTitles()).toEqual(["Live unknown"]);
    const liveRow = screen.getByText("Live unknown").closest("tr");
    expect(liveRow).not.toBeNull();
    expect(within(liveRow!).getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Quiet open")).not.toBeInTheDocument();

    view.rerender(<SessionCatalogProvider sessions={[quietOpen]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
    expect(visibleSessionTitles()).toEqual(["Quiet open"]);

    await user.click(screen.getByRole("button", { name: /^All/ }));
    view.rerender(<SessionCatalogProvider sessions={[liveUnknown, quietOpen]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
    expect(visibleSessionTitles()).toEqual(["Quiet open", "Live unknown"]);
  });

  it("orders by creation time descending and paginates ten rows at a time", async () => {
    const user = userEvent.setup();
    const sessions = Array.from({ length: 12 }, (_, index) => session(index + 1));
    render(<SessionCatalogProvider sessions={sessions}><SessionsView /></SessionCatalogProvider>);

    expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
    expect(visibleSessionTitles()).toEqual(Array.from({ length: 10 }, (_, index) => `Session ${12 - index}`));
    expect(screen.getByText("Showing 1–10 of 12")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Last activity" })).toBeInTheDocument();
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

  it("shows normalized fallback activity with visible provenance while retaining the current mark", async () => {
    const observedAt = "2026-08-01T12:00:00.000Z";
    const current = {
      ...session(1), isLive: true, activityStatus: "working" as const,
      activityFallback: { label: "Running tests", observedAt, state: "current" as const, source: "execution_task" as const, actor: "subagent" as const },
    };
    const view = render(<SessionCatalogProvider sessions={[current]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getAllByText("Running tests")).toHaveLength(2);
    expect(screen.getAllByText(/Subagent/)).toHaveLength(2);
    expect(view.container.querySelectorAll(".commandTableActivityMark")).toHaveLength(2);
    expect(view.container.querySelectorAll(".commandTableActivityLast")).toHaveLength(0);

    const last = { ...current, isLive: false, activityStatus: "idle" as const, activityFallback: { ...current.activityFallback, label: "test run", state: "last_observed" as const, actor: "primary" as const } };
    view.rerender(<SessionCatalogProvider sessions={[last]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getAllByText("test run")).toHaveLength(2);
    expect(screen.queryByText(/Primary agent/)).not.toBeInTheDocument();
    expect(view.container.querySelectorAll(".commandTableActivityMark")).toHaveLength(2);
    expect(view.container.querySelectorAll(".commandTableActivityLast")).toHaveLength(2);
    expect(view.container.querySelectorAll(".commandTableActivityLabelChanged")).toHaveLength(2);
    const activity = screen.getAllByLabelText(/^Previous activity:/)[0];
    activity.focus();
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Execution task"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Primary agent");
    const label = view.container.querySelector(".commandTableActivityLabel");

    view.rerender(<SessionCatalogProvider sessions={[{ ...last, activityFallback: { ...last.activityFallback, observedAt: "2026-08-01T12:01:00.000Z" } }]}><SessionsView /></SessionCatalogProvider>);
    expect(view.container.querySelector(".commandTableActivityLabel")).toBe(label);
  });

  it("suppresses stale fallback current work and keeps an unavailable em dash", () => {
    const stale = {
      ...session(1), isLive: false, activityStatus: "idle" as const,
      activityFallback: { label: "Running tests", observedAt: "2026-08-01T12:00:00.000Z", state: "current" as const, source: "tool" as const, actor: "primary" as const },
    };
    const view = render(<SessionCatalogProvider sessions={[stale]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.queryByText("Running tests")).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(view.container.querySelector(".commandTableActivityMark")).toBeNull();
  });

  it("keeps provider-reported current activity ahead of a fallback", () => {
    const current = {
      ...session(1), isLive: true, activityStatus: "working" as const,
      currentActivity: { label: "Provider heading", observedAt: "2026-08-01T12:00:00.000Z", state: "current" as const },
      activityFallback: { label: "Running tests", observedAt: "2026-08-01T12:00:00.000Z", state: "current" as const, source: "execution_task" as const, actor: "multiple" as const },
    };
    render(<SessionCatalogProvider sessions={[current]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getAllByText("Provider heading")).toHaveLength(2);
    expect(screen.queryByText("Running tests")).not.toBeInTheDocument();
  });
});
