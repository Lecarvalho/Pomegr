import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionsView } from "../../app/components/command-center/CommandViews";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { SessionSummary } from "../../shared/monitor-contract";

afterEach(() => vi.unstubAllGlobals());

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
    expect(row).toHaveTextContent("1/3");
    expect(row).toHaveTextContent("123k");
    expect(row).toHaveTextContent("42%");
  });

  it("uses committed directory pages with newest-first ordering and cursor navigation", async () => {
    const first = directorySnapshot([session(25)], { nextCursor: "cursor-2" });
    const second = directorySnapshot([session(24)], { nextCursor: null });
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(String(url).includes("/api/sessions?mode=directory") ? (String(url).includes("cursor=cursor-2") ? second : first) : {}), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SessionCatalogProvider sessions={[session(1)]}><SessionsView /></SessionCatalogProvider>);

    await waitFor(() => expect(screen.getByText("Session 25")).toBeInTheDocument());
    expect(screen.getByText(/^52 sessions in the complete catalog\./)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Sort sessions" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByText("Session 24")).toBeInTheDocument());
    const requested = fetchMock.mock.calls.map(([url]) => String(url));
    const directoryRequests = requested.filter((url) => url.includes("/api/sessions?mode=directory"));
    expect(directoryRequests[0]).toContain("filter=all");
    expect(directoryRequests.every((url) => url.includes("sort=newest"))).toBe(true);
    expect(directoryRequests.at(-1)).toContain("cursor=cursor-2");
  });

  it("keeps known count honest while discovery is incomplete and preserves its completed fact", async () => {
    const partial = directorySnapshot([], {
      coverage: { status: "partial", knownCount: 0, exactTotal: null, observedAt: null, lastCompletedTotal: 49, lastCompletedAt: "2026-09-26T12:00:00.000Z" },
      matchedCount: 0,
      counts: { all: 0, live: 0, needs: 0 },
    });
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(String(url).includes("/api/sessions?mode=directory") ? partial : {}), { status: 200 }))));
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);

    await waitFor(() => expect(screen.getByText(/0 known sessions while discovery is partial/)).toBeInTheDocument());
    expect(screen.getByText(/Last complete catalog: 49 completed/)).toBeInTheDocument();
    expect(screen.queryByText(/0 sessions in the complete catalog/)).not.toBeInTheDocument();
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
    expect(screen.getByText(/3 known sessions while discovery is discovering/)).toBeInTheDocument();
    completeNow = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText("Discovered session")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
