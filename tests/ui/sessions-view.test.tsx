import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionsView } from "../../app/components/command-center/CommandViews";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { SessionSummary } from "../../shared/monitor-contract";

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

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

function directorySnapshot(rows: SessionSummary[], overrides: Record<string, unknown> = {}) {
  return {
    sessions: rows,
    revision: "catalog-1",
    readiness: { catalog: "ready" as const },
    coverage: { status: "complete" as const, knownCount: 52, exactTotal: 52, observedAt: "2026-09-27T12:00:00.000Z", lastCompletedTotal: 52, lastCompletedAt: "2026-09-27T12:00:00.000Z" },
    matchedCount: 52,
    counts: { all: 52, live: 4, needs: 1 },
    pageSize: 25,
    nextCursor: null,
    ...overrides,
  };
}

describe("Sessions view", () => {
  it("defaults to Live when the committed catalog has live sessions and preserves an explicit filter", async () => {
    const live = { ...session(1), isLive: true, activityStatus: "working" as const };
    const fetchMock = vi.fn((url: string) => {
      const rows = String(url).includes("filter=live") ? [live] : [live, session(2)];
      return Promise.resolve(new Response(JSON.stringify(directorySnapshot(rows, { matchedCount: rows.length })), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = render(<SessionCatalogProvider sessions={[]} loading readiness={{ catalog: "loading" }}><SessionsView /></SessionCatalogProvider>);

    view.rerender(<SessionCatalogProvider sessions={[live]} readiness={{ catalog: "ready" }}><SessionsView /></SessionCatalogProvider>);

    await waitFor(() => expect(screen.getByRole("button", { name: /^Live/ })).toHaveAttribute("aria-pressed", "true"));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("filter=live"))).toBe(true);

    await user.click(screen.getByRole("button", { name: /All sessions/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /All sessions/ })).toHaveAttribute("aria-pressed", "true"));
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("filter=all");
  });

  it("shows a live summary spinner until committed metrics are available", async () => {
    const loading = {
      ...session(1),
      isLive: true,
      activityStatus: "open" as const,
      summaryReadiness: "loading" as const,
      agentCount: null,
      activeAgentCount: null,
      latestContextTotal: null,
      progress: null,
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(directorySnapshot([loading], { matchedCount: 1 })), { status: 200 }))));
    const view = render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);

    expect(await screen.findByRole("status", { name: "Loading metrics for Session 1" })).toBeInTheDocument();
    const row = screen.getByText("Session 1").closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("—");

    const ready = {
      ...loading,
      activityStatus: "working" as const,
      summaryReadiness: "ready" as const,
      agentCount: 3,
      activeAgentCount: 1,
      latestContextTotal: 123_000,
      progress: { phase: "implementing" as const, percent: 42, confidence: "high" as const, reportedAt: loading.updatedAt },
    };
    view.rerender(<SessionCatalogProvider sessions={[ready]}><SessionsView /></SessionCatalogProvider>);

    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading metrics for Session 1" })).not.toBeInTheDocument());
    const readyRow = screen.getByText("Session 1").closest("tr");
    expect(readyRow).toHaveTextContent("1/3");
    expect(readyRow).toHaveTextContent("123k");
    expect(readyRow).toHaveTextContent("42%");
  });

  it("uses committed directory pages with newest-first ordering and cursor navigation", async () => {
    const first = directorySnapshot([session(25)], { nextCursor: "cursor-2" });
    const second = directorySnapshot([session(24)], { nextCursor: null });
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(String(url).includes("/api/sessions?mode=directory") ? (String(url).includes("cursor=cursor-2") ? second : first) : {}), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SessionCatalogProvider sessions={[session(1)]}><SessionsView /></SessionCatalogProvider>);

    await waitFor(() => expect(screen.getByText("Session 25")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "All sessions, 52 discovered" })).toBeInTheDocument();
    expect(screen.queryByText(/sessions in the complete catalog/)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Sort sessions" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByText("Session 24")).toBeInTheDocument());
    const requested = fetchMock.mock.calls.map(([url]) => String(url));
    const directoryRequests = requested.filter((url) => url.includes("/api/sessions?mode=directory"));
    expect(directoryRequests[0]).toContain("filter=all");
    expect(directoryRequests.some((url) => url.includes("sort=") || url.includes("revision="))).toBe(false);
    expect(directoryRequests.at(-1)).toContain("cursor=cursor-2");
  });

  it("shows an incomplete catalog as a rounded-down lower bound in the All filter", async () => {
    const partial = directorySnapshot([], {
      coverage: { status: "partial", knownCount: 1447, exactTotal: null, observedAt: null, lastCompletedTotal: 1432, lastCompletedAt: "2026-09-26T12:00:00.000Z" },
      matchedCount: 1447,
      counts: { all: 1447, live: 0, needs: 0 },
    });
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(String(url).includes("/api/sessions?mode=directory") ? partial : {}), { status: 200 }))));
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);

    await waitFor(() => expect(screen.getByRole("button", { name: "All sessions, at least 1,400 discovered" })).toHaveTextContent("All1,400+"));
    expect(screen.queryByText(/discovery is partial/)).not.toBeInTheDocument();
  });

  it("shows a complete catalog as a rounded magnitude in the All filter", async () => {
    const complete = directorySnapshot([], {
      coverage: { status: "complete", knownCount: 1447, exactTotal: 1447, observedAt: "2026-09-27T12:00:00.000Z", lastCompletedTotal: 1447, lastCompletedAt: "2026-09-27T12:00:00.000Z" },
      matchedCount: 1447,
      counts: { all: 1447, live: 0, needs: 0 },
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(complete), { status: 200 }))));
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);

    await waitFor(() => expect(screen.getByRole("button", { name: "All sessions, approximately 1,400" })).toHaveTextContent("All~1,400"));
  });

  it("discards a late page for an old search and accepts only the current committed query", async () => {
    let resolveFirst: (response: Response) => void = () => { throw new Error("Initial directory request did not start"); };
    const current = directorySnapshot([{ ...session(2), title: "Current match" }], { matchedCount: 1 });
    const fetchMock = vi.fn((url: string) => {
      if (!String(url).includes("/api/sessions?mode=directory")) return Promise.resolve(new Response("{}", { status: 200 }));
      if (String(url).includes("query=current")) return Promise.resolve(new Response(JSON.stringify(current), { status: 200 }));
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);
    await user.type(screen.getByRole("searchbox", { name: "Filter sessions" }), "current");
    await waitFor(() => expect(screen.getByText("Current match")).toBeInTheDocument());
    resolveFirst(new Response(JSON.stringify(directorySnapshot([{ ...session(1), title: "Stale match" }])), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale match")).not.toBeInTheDocument();
  });

  it("resets a stale cursor to the returned first page", async () => {
    const first = directorySnapshot([{ ...session(2), title: "First page" }], { nextCursor: "old-cursor" });
    const reset = directorySnapshot([{ ...session(1), title: "Reset page" }], { cursorReset: true, nextCursor: null, revision: "catalog-2" });
    let resetSeen = false;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("cursor=old-cursor")) resetSeen = true;
      return Promise.resolve(new Response(JSON.stringify(resetSeen ? reset : first), { status: 200 }));
    }));
    const user = userEvent.setup();
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);
    await waitFor(() => expect(screen.getByText("First page")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Reset page")).toBeInTheDocument());
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("refreshes a discovering directory page on the fallback cadence", async () => {
    vi.useFakeTimers();
    const discovering = directorySnapshot([], {
      coverage: { status: "discovering", knownCount: 3, exactTotal: null, observedAt: null, lastCompletedTotal: null, lastCompletedAt: null },
      matchedCount: 3,
    });
    const complete = directorySnapshot([{ ...session(3), title: "Discovered session" }]);
    let completeNow = false;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(completeNow ? complete : discovering), { status: 200 }))));
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "All sessions, 3 discovered" })).toBeInTheDocument();
    completeNow = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText("Discovered session")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("keeps page navigation enabled while a background refresh is in flight", async () => {
    vi.useFakeTimers();
    const first = directorySnapshot([{ ...session(2), title: "First page" }], { nextCursor: "cursor-2" });
    let refreshing = false;
    vi.stubGlobal("fetch", vi.fn(() => refreshing ? new Promise<Response>(() => {}) : Promise.resolve(new Response(JSON.stringify(first), { status: 200 }))));
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    refreshing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText("First page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    vi.useRealTimers();
  });

  it("sections the recent list by creation day and collapses a section", async () => {
    const today = { ...session(2), title: "Fresh session", createdAt: new Date().toISOString() };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(directorySnapshot([today, session(1)])), { status: 200 }))));
    const user = userEvent.setup();
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);

    const earlier = await screen.findByRole("button", { name: "Started earlier" });
    expect(screen.getByRole("button", { name: "Recent" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Started today" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Fresh session").closest("tr")).toHaveTextContent("Pomegr · Codex");
    await user.click(earlier);
    expect(earlier).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
    expect(screen.getByText("Fresh session")).toBeInTheDocument();
  });

  it("groups by repository from the monitor, remembers the choice, and narrows to a group's full list", async () => {
    const grouped = directorySnapshot([], {
      groupBy: "project", groupCount: 2,
      groups: [
        { key: "Pomegr", label: "Pomegr", count: 7, live: 2, needs: 1, latestUpdatedAt: "2026-08-29T12:00:00.000Z", sessions: [session(3), session(2)] },
        { key: "Other", label: "Other", count: 1, live: 0, needs: 0, latestUpdatedAt: null, sessions: [{ ...session(4), project: "Other" }] },
      ],
    });
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(String(url).includes("group=project") ? grouped : directorySnapshot([session(1)])), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);
    await screen.findByText("Session 1");

    await user.click(screen.getByRole("button", { name: "Repository" }));
    const header = await screen.findByRole("button", { name: /^Pomegr/ });
    expect(header).toHaveTextContent("7 sessions");
    expect(header).toHaveTextContent("2 live");
    expect(header).toHaveTextContent("1 needs input");
    expect(screen.getByRole("button", { name: /^Other/ })).toHaveTextContent("1 session");
    // The group header names the repository, so the row keeps only the provider.
    expect(screen.getByText("Session 3").closest("tr")).not.toHaveTextContent("Pomegr");
    expect(screen.getByText("2 repositories · 52 sessions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).not.toContain("cursor=");
    expect(window.localStorage.getItem("pomegr-sessions-group-by")).toBe("project");

    // The Live scope already says every counted session is live.
    await user.click(screen.getByRole("button", { name: /^Live/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Pomegr/ })).not.toHaveTextContent("2 live"));
    expect(screen.getByRole("button", { name: /^Pomegr/ })).toHaveTextContent("1 needs input");
    await user.click(screen.getByRole("button", { name: /^Needs input/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Pomegr/ })).not.toHaveTextContent("1 needs input"));
    expect(screen.getByRole("button", { name: /^Pomegr/ })).toHaveTextContent("2 live");

    await user.click(screen.getByRole("button", { name: "Show all 7 in Pomegr" }));
    await screen.findByRole("button", { name: "Clear repository filter: Pomegr" });
    const narrowed = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(narrowed).toContain("project=Pomegr");
    expect(narrowed).not.toContain("group=");
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();

    view.unmount();
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getByRole("button", { name: "Repository" })).toHaveAttribute("aria-pressed", "true");
    await screen.findByRole("button", { name: /^Pomegr/ });
  });

  it("groups by provider and narrows with a provider scope", async () => {
    window.localStorage.setItem("pomegr-sessions-group-by", "provider");
    const grouped = directorySnapshot([], {
      groupBy: "provider", groupCount: 1,
      groups: [{ key: "codex", label: "Codex", count: 9, live: 0, needs: 0, latestUpdatedAt: "2026-08-29T12:00:00.000Z", sessions: [session(3)] }],
    });
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(String(url).includes("group=provider") ? grouped : directorySnapshot([session(1)])), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);

    await screen.findByRole("button", { name: /^Codex/ });
    const row = screen.getByText("Session 3").closest("tr");
    expect(row).toHaveTextContent("Pomegr");
    expect(row).not.toHaveTextContent("Codex");
    await user.click(screen.getByRole("button", { name: "Show all 9 in Codex" }));
    await screen.findByRole("button", { name: "Clear provider filter: Codex" });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("provider=codex");
    await user.click(screen.getByRole("button", { name: "Clear provider filter: Codex" }));
    await screen.findByRole("button", { name: "Show all 9 in Codex" });
  });
});
