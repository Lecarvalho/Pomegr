import { RequestsActionsPanel, snapshot, requestFeed, overviewPoint, fullRefill, renderPanel, HistoryLocateHarness, chart, axisLabels, setPhone } from "./requests-actions-test-fixtures";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, CacheEvent, CacheEventFeed, CacheReadDropFeed, RequestSnapshot, RequestSnapshotFeed } from "../../shared/monitor-contract";
import { StrictMode } from "react";
import { snapshotEventKey } from "../../app/components/dashboard/requests-actions/model";
import { RequestMinimap } from "../../app/components/dashboard/requests-actions/RequestMinimap";
import { scopedRows } from "../../app/components/dashboard/requests-actions/model";
import type { RequestOverviewPoint } from "../../shared/session-history-contract";
import { agent } from "./dashboard-test-fixtures";
import { claudeCacheRefillFeeds } from "../helpers/claude-cache-refill.mjs";

const childAgent: Agent = { ...agent, id: 'child', parentId: 'primary', label: 'Builder' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.removeItem("pomegr-disclosure-cache-evidence");
});

describe("RequestsActionsPanel", () => {
  it("restarts an aborted initial history load during StrictMode effect replay", async () => {
    const fetchPage = vi.fn(async () => ({ ok: true, json: async () => ({
      status: "ready", kind: "requests", revision: "1", total: 1, offset: 0, linkedCount: 0,
      items: [{ ...snapshot(1), number: 999 }],
    }) }));
    vi.stubGlobal("fetch", fetchPage);
    render(<StrictMode><HistoryLocateHarness sessionId="strict-loading" requests={[snapshot(1)]} /></StrictMode>);
    expect(await screen.findByRole("heading", { name: "Request #999" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Request map loading" })).toBeInTheDocument();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("renders recent snapshots before history arrives without inventing stable numbers (phone: %s)", async (phone) => {
    setPhone(phone);
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
    const requests = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const { container } = render(<HistoryLocateHarness sessionId="preview" requests={requests} />);
    const bars = container.querySelectorAll(".requestsActionsBar");
    expect(bars).toHaveLength(phone ? 20 : 60);
    expect(screen.getByText(/Showing recent requests by time while full history loads/)).toBeInTheDocument();
    const loadingMinimap = screen.getByRole("img", { name: "Request map loading" });
    expect(loadingMinimap).toHaveAttribute("aria-busy", "true");
    expect(loadingMinimap.querySelectorAll(".requestsActionsMiniBar")).toHaveLength(phone ? 20 : 60);
    expect(screen.queryByRole("button", { name: /^Request #/ })).not.toBeInTheDocument();
    fireEvent.click(bars[0]);
    const first = phone ? 81 : 41;
    await act(async () => resolve({ ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "1", total: 100, offset: first - 1, linkedCount: 0,
      items: requests.slice(first - 1).map((row, index) => ({ ...row, number: 1000 + first + index })), overview: requests.map(overviewPoint),
    }) }));
    expect(screen.getByRole("heading", { name: `Request #${1000 + first}` })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Request window" })).toBeInTheDocument();
    expect(screen.queryByText(/Showing recent requests by time/)).not.toBeInTheDocument();
  });

  it("keeps recent bars visible through failed history loads and retries", async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, json: async () => ({
      status: "ready", kind: "requests", revision: "1", total: 1, offset: 0, linkedCount: 0, items: [{ ...snapshot(1), number: 99 }],
    }) });
    vi.stubGlobal("fetch", fetchPage);
    const { container } = render(<HistoryLocateHarness sessionId="preview-retry" requests={[snapshot(1)]} />);
    await act(async () => {});
    expect(container.querySelectorAll(".requestsActionsBar")).toHaveLength(1);
    expect(screen.getByText(/Full history is unavailable; retrying/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByRole("heading", { name: "Request #99" })).toBeInTheDocument();
  });

  it("distinguishes loading history from a session with no observations", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<HistoryLocateHarness sessionId="empty-loading" requests={[]} />);
    expect(screen.getByText("Loading request history…")).toBeInTheDocument();
    expect(screen.queryByText("No request observations for this session yet.")).not.toBeInTheDocument();
  });

  it("resumes history polling and selection after an older bar then the latest bar is clicked", async () => {
    vi.useFakeTimers();
    let count = 3;
    const fetchPage = vi.fn(async () => ({ ok: true, json: async () => ({
      status: "ready", kind: "requests", revision: String(count), total: count, offset: 0, linkedCount: 0,
      items: Array.from({ length: count }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 })),
    }) }));
    vi.stubGlobal("fetch", fetchPage);
    await act(async () => { render(<HistoryLocateHarness sessionId="resume-follow" requests={[]} />); });
    fireEvent.click(screen.getByRole("button", { name: /^Request #1,/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^Request #3,/ }));
    count = 4;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Request #4" })).toBeInTheDocument();
  });

  it.each([false, true])("slides preloaded history immediately during a held pointer without network requests (phone: %s)", async (phone) => {
    setPhone(phone);
    const total = 180;
    const size = phone ? 20 : 60;
    const request = (position: number) => snapshot(position, "primary", position === 1 ? { uncachedInputTokens: 9_000_000 } : {});
    const overview = Array.from({ length: total }, (_, index) => overviewPoint(request(index + 1)));
    const fetchPage = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const limit = Number(params.get("limit"));
      const offset = params.get("offset") === "latest" ? total - limit : Number(params.get("offset"));
      return { ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "preloaded", total, offset, linkedCount: 0,
        ...(params.get("overview") !== "0" ? { overview } : {}),
        items: Array.from({ length: Math.min(limit, total - offset) }, (_, index) => ({ ...request(offset + index + 1), number: (offset + index + 1) * 10 })),
      }) };
    });
    vi.stubGlobal("fetch", fetchPage);
    const { container } = render(<HistoryLocateHarness sessionId="preload-drag" requests={[]} />);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(phone ? 4 : 3));
    const calls = fetchPage.mock.calls.length;
    expect(screen.getByText("0–12M tokens")).toBeInTheDocument();
    if (phone) {
      const svg = chart(container);
      vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, right: 334, top: 0, bottom: 196, width: 334, height: 196, x: 0, y: 0, toJSON: () => ({}) });
      fireEvent.pointerDown(svg, { button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 100 });
      const slot = (330 - 34 + 2.8) / size;
      fireEvent.pointerMove(svg, { pointerId: 1, clientX: (total - size) * slot, clientY: 100 });
      expect(axisLabels(container)).toEqual(["#10", "#200"]);
      fireEvent.pointerMove(svg, { pointerId: 1, clientX: (total - size - 10) * slot, clientY: 100 });
      expect(axisLabels(container)).toEqual(["#110", "#300"]);
      fireEvent.pointerMove(svg, { pointerId: 1, clientX: 0, clientY: 100 });
      expect(axisLabels(container)).toEqual(["#1610", "#1800"]);
      expect(screen.getByText("0–12M tokens")).toBeInTheDocument();
      expect(fetchPage).toHaveBeenCalledTimes(calls);
      fireEvent.pointerUp(svg, { pointerId: 1 });
      return;
    }
    const minimap = screen.getByRole("slider", { name: "Request window" });
    vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({ left: 0, right: 180, top: 0, bottom: 44, width: 180, height: 44, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(minimap, { button: 0, isPrimary: true, pointerId: 1, clientX: 179, clientY: 20 });
    fireEvent.pointerMove(minimap, { pointerId: 1, clientX: 0, clientY: 20 });
    expect(axisLabels(container)).toEqual(["#10", `#${size * 10}`]);
    expect(screen.getByText("0–12M tokens")).toBeInTheDocument();
    fireEvent.pointerMove(minimap, { pointerId: 1, clientX: size + 9, clientY: 20 });
    expect(axisLabels(container)).toEqual(["#110", `#${(size + 10) * 10}`]);
    fireEvent.pointerMove(minimap, { pointerId: 1, clientX: 180, clientY: 20 });
    expect(axisLabels(container)).toEqual([`#${(total - size + 1) * 10}`, "#1800"]);
    expect(fetchPage).toHaveBeenCalledTimes(calls);
    fireEvent.pointerUp(minimap, { pointerId: 1 });
    fireEvent.keyDown(minimap, { key: "Home" });
    expect(axisLabels(container)).toEqual(["#10", `#${size * 10}`]);
    expect(fetchPage).toHaveBeenCalledTimes(calls);
  });

  it("waits for slow navigation and retries the same request while history hydrates", async () => {
    vi.useFakeTimers();
    let resolveNavigation!: (value: unknown) => void;
    const response = (items: RequestSnapshot[], status = "ready") => ({ ok: true, json: async () => ({ status, kind: "requests", revision: "r1", total: 100, offset: 0, linkedCount: 0, items }) });
    const fetchPage = vi.fn().mockResolvedValueOnce(response([{ ...snapshot(100), number: 100 } as RequestSnapshot]))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNavigation = resolve; }))
      .mockResolvedValueOnce(response([{ ...snapshot(10), number: 10 } as RequestSnapshot]));
    vi.stubGlobal("fetch", fetchPage);
    await act(async () => { render(<HistoryLocateHarness sessionId="slow-history" requests={[]} />); });
    fireEvent.click(screen.getByRole("button", { name: "Locate absent request" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await act(async () => { resolveNavigation(response([], "loading")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[2][0]).toContain("requestId=request-10");
    expect(screen.getByRole("heading", { name: "Request #10" })).toBeInTheDocument();
  });

  it("keeps persistent request labels across pages and loads an absent selection around its stable id", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      const query = new URL(url, "http://localhost").searchParams;
      const selected = query.get("requestId");
      const items = selected
        ? Array.from({ length: 20 }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }))
        : Array.from({ length: 20 }, (_, index) => ({ ...snapshot(index + 81), number: index + 81 }));
      return { ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "history-r1", total: 100, offset: selected ? 0 : 80, linkedCount: 0, items }) };
    }));
    const { container } = render(<HistoryLocateHarness sessionId="history-one" requests={Array.from({ length: 100 }, (_, index) => snapshot(index + 1))} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #100" })).toBeInTheDocument());
    expect(axisLabels(container)).toEqual(["#81", "#100"]);
    await user.click(screen.getByRole("button", { name: "Locate absent request" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #10" })).toBeInTheDocument());
    expect(axisLabels(container)).toEqual(["#1", "#20"]);
    expect(calls.at(-1)).toContain("requestId=request-10");
    expect(screen.queryByText("Request numbers are stable labels within this session, not provider ids.", { exact: false })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "About request links" }));
    expect(screen.getByRole("dialog", { name: "About request links" })).toHaveTextContent("Request numbers are stable labels within this session, not provider ids.");
  });

  it("discards an earlier session-history response after the viewed session changes", async () => {
    const deferred: Array<(value: { ok: boolean; json: () => Promise<unknown> }) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => deferred.push(resolve))));
    const requests = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const { rerender } = render(<HistoryLocateHarness sessionId="history-one" requests={requests} />);
    await waitFor(() => expect(deferred).toHaveLength(1));
    rerender(<HistoryLocateHarness sessionId="history-two" requests={requests} />);
    await waitFor(() => expect(deferred).toHaveLength(2));
    deferred[1]({ ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "two", total: 1, offset: 0, linkedCount: 0, items: [{ ...snapshot(200), number: 200 }] }) });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #200" })).toBeInTheDocument());
    deferred[0]({ ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "one", total: 1, offset: 0, linkedCount: 0, items: [{ ...snapshot(1), number: 1 }] }) });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #200" })).toBeInTheDocument());
  });

  it("uses detail Prev and Next across pages even when stable labels have gaps", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const offset = new URL(url, "http://localhost").searchParams.get("offset");
      const start = offset === "0" ? 1 : 41;
      return { ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "history-r1", total: 100, offset: start - 1, linkedCount: 0, items: Array.from({ length: 60 }, (_, index) => ({ ...snapshot(start + index), number: (start + index) * 2 })) }) };
    }));
    const { container } = render(<HistoryLocateHarness sessionId="history-steps" requests={Array.from({ length: 100 }, (_, index) => snapshot(index + 1))} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #200" })).toBeInTheDocument());
    await user.click(within(container).getByRole("button", { name: /^Request #82,/ }));
    await user.click(screen.getByRole("button", { name: "Prev" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #80" })).toBeInTheDocument());
    await user.click(within(container).getByRole("button", { name: /^Request #120,/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #122" })).toBeInTheDocument());
  });

  it("navigates the global history minimap across unloaded pages and keeps its last page while a newer move wins", async () => {
    const total = 180;
    let resolveFirstPageMove: ((value: { ok: boolean; json: () => Promise<unknown> }) => void) | null = null;
    let delayFirstPageMove = true;
    const page = (offset: number) => ({
      ok: true,
      json: async () => ({
        status: "ready", kind: "requests", revision: "global-history", total, offset, linkedCount: 0,
        overview: Array.from({ length: total }, (_, index) => overviewPoint(snapshot(index + 1))),
        items: Array.from({ length: 60 }, (_, index) => {
          const position = offset + index + 1;
          return { ...snapshot(position), number: position * 10 };
        }),
      }),
    });
    const fetchPage = vi.fn((url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      // Exercise navigation while the background preload is still unavailable.
      if (params.get("overview") === "0") return Promise.resolve({ ok: true, json: async () => ({ status: "loading", kind: "requests", items: [] }) });
      const offsetValue = params.get("offset");
      const offset = offsetValue === "latest" ? total - 60 : Number(offsetValue);
      if (offset === 0 && delayFirstPageMove) {
        delayFirstPageMove = false;
        return new Promise((resolve) => { resolveFirstPageMove = resolve; });
      }
      return Promise.resolve(page(offset));
    });
    vi.stubGlobal("fetch", fetchPage);
    const { container } = render(<HistoryLocateHarness sessionId="global-minimap" requests={[]} />);
    await waitFor(() => expect(screen.getByRole("slider", { name: "Request window" })).toHaveAttribute("aria-valuetext", "Request positions 121 to 180 of 180"));
    const minimap = screen.getByRole("slider", { name: "Request window" });
    vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({ left: 0, right: 100, top: 0, bottom: 26, width: 100, height: 26, x: 0, y: 0, toJSON: () => ({}) });
    expect(axisLabels(container)).toEqual(["#1210", "#1800"]);
    expect(container.querySelectorAll(".requestsActionsMiniBar")).toHaveLength(total);
    expect(container.querySelector(".requestsActionsMiniBar")?.getAttribute("x")).toBeCloseTo(.97, 1);
    const overviewBefore = minimap.querySelectorAll(".requestsActionsMiniBar");
    const heightsBefore = Array.from(overviewBefore, (bar) => bar.getAttribute("height"));

    fireEvent.keyDown(minimap, { key: "Home" });
    await waitFor(() => expect(fetchPage.mock.calls.filter(([url]) => !url.includes("overview=0"))).toHaveLength(2));
    expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 1 to 60 of 180");
    expect(axisLabels(container)).toEqual(["#1210", "#1800"]);
    expect(Array.from(minimap.querySelectorAll(".requestsActionsMiniBar"), (bar) => bar.getAttribute("height"))).toEqual(heightsBefore);
    fireEvent.keyDown(minimap, { key: "End" });
    await waitFor(() => expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 121 to 180 of 180"));
    resolveFirstPageMove!(page(0));
    await waitFor(() => expect(axisLabels(container)).toEqual(["#1210", "#1800"]));

    fireEvent.keyDown(minimap, { key: "ArrowLeft" });
    await waitFor(() => expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 120 to 179 of 180"));
    expect(fetchPage.mock.calls.at(-1)?.[0]).toContain("offset=119");
    fireEvent.keyDown(minimap, { key: "ArrowRight" });
    await waitFor(() => expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 121 to 180 of 180"));
    fireEvent.keyDown(minimap, { key: "PageUp" });
    await waitFor(() => expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 61 to 120 of 180"));
    fireEvent.keyDown(minimap, { key: "PageDown" });
    await waitFor(() => expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 121 to 180 of 180"));

    fireEvent.pointerDown(minimap, { button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 10 });
    fireEvent.pointerUp(minimap, { pointerId: 1, clientX: 0, clientY: 10 });
    await waitFor(() => expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 1 to 60 of 180"));
    expect(axisLabels(container)).toEqual(["#10", "#600"]);
    expect(Array.from(minimap.querySelectorAll(".requestsActionsMiniBar"), (bar) => bar.getAttribute("height"))).toEqual(heightsBefore);
    fireEvent.pointerDown(minimap, { button: 0, isPrimary: true, pointerId: 2, clientX: 100, clientY: 10 });
    fireEvent.pointerUp(minimap, { pointerId: 2, clientX: 100, clientY: 10 });
    await waitFor(() => expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 121 to 180 of 180"));
    expect(axisLabels(container)).toEqual(["#1210", "#1800"]);
  });
  it("retains request 44's refill marker through parsing and detail-feed trimming after a synthetic message", () => {
    const feeds = claudeCacheRefillFeeds();
    const requests = feeds.requestSnapshots as RequestSnapshotFeed;
    const events = feeds.cacheEvents as CacheEventFeed;
    expect(requests.items).toHaveLength(66);
    expect(events.items).toHaveLength(20);
    expect(events.items.some((event) => event.observedAt === requests.items[43].observedAt)).toBe(false);
    const { container } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requests}
      contextBoundaries={[]} cacheWriteAvailable historical cacheEvents={events} />);
    const marker = container.querySelector(".requestsActionsRefill")!;
    expect(marker).toBeInTheDocument();
    expect(marker.querySelector("title")).toHaveTextContent("Possible full refill · request #44");
    expect(container.querySelectorAll(".requestsActionsMiniRefill")).toHaveLength(1);
    fireEvent.click(marker.closest(".requestsActionsBar")!);
    expect(screen.getByRole("heading", { name: "Request #44" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Request cache evidence" })).toHaveTextContent("Possible full refill");
  });

  it.each([
    { phone: false, count: 33, ordinals: [1, 17, 33] },
    { phone: false, count: 5, ordinals: [1, 5] },
    { phone: false, count: 1, ordinals: [1] },
    { phone: false, count: 2, ordinals: [2] },
    { phone: false, count: 1_000, ordinals: [941, 971, 1000] },
    { phone: true, count: 10, ordinals: [1, 10] },
    { phone: true, count: 1, ordinals: [1] },
    { phone: true, count: 2, ordinals: [2] },
    { phone: true, count: 100, ordinals: [81, 100] },
  ])("anchors readable axis labels to bars for $count requests (phone: $phone)", ({ phone, count, ordinals }) => {
    setPhone(phone);
    const { container } = renderPanel(Array.from({ length: count }, (_, index) => snapshot(index + 1)));
    const svg = chart(container);
    const labels = Array.from(svg.querySelectorAll(".requestsActionsAxis:last-child text"));
    expect(labels.map((label) => Number(label.textContent?.match(/^#(\d+)/)?.[1]))).toEqual(ordinals);
    labels.forEach((label, index) => {
      const bar = within(container).getByRole("button", { name: new RegExp(`^Request #${ordinals[index]},`) });
      const segment = bar.querySelector(".requestsActionsSegment")!;
      const center = Number(segment.getAttribute("x")) + Number(segment.getAttribute("width")) / 2;
      expect(Number(label.getAttribute("x"))).toBeCloseTo(center);
    });
    if (count === 33) {
      expect(labels[1]).toHaveTextContent(/^#17 · /);
      expect(Number(labels.at(-1)!.getAttribute("x"))).toBeLessThan(700);
    }
  });

  it("advances the last axis label with an appended request while keeping existing bars stationary", () => {
    const items = Array.from({ length: 33 }, (_, index) => snapshot(index + 1));
    const { container, rerender } = renderPanel(items);
    const positions = Array.from(container.querySelectorAll(".requestsActionsSegment.uncached"), (bar) => bar.getAttribute("x"));
    const previousLastX = Number(chart(container).querySelector(".requestsActionsAxis:last-child text:last-child")!.getAttribute("x"));
    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([...items, snapshot(34)])} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(Array.from(container.querySelectorAll(".requestsActionsSegment.uncached"), (bar) => bar.getAttribute("x")).slice(0, 33)).toEqual(positions);
    const lastLabel = chart(container).querySelector(".requestsActionsAxis:last-child text:last-child")!;
    const lastBar = container.querySelectorAll(".requestsActionsSegment.uncached")[33];
    expect(lastLabel).toHaveTextContent("#34");
    expect(Number(lastLabel.getAttribute("x"))).toBeGreaterThan(previousLastX);
    expect(Number(lastLabel.getAttribute("x"))).toBeCloseTo(Number(lastBar.getAttribute("x")) + Number(lastBar.getAttribute("width")) / 2);
  });

  it("renders a 60-request desktop window from a 1,000-row retained feed", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(Array.from({ length: 1_000 }, (_, index) => snapshot(index + 1)));
    expect(container.querySelectorAll(".requestsActionsBar")).toHaveLength(60);
    expect(axisLabels(container)).toEqual(["#941", "#1000"]);
    expect(screen.getByRole("heading", { name: "Request #1000" })).toBeInTheDocument();
    expect(screen.queryByText(/Request numbers are positions/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "About request links" }));
    expect(screen.getByRole("dialog", { name: "About request links" })).toHaveTextContent("Request numbers are positions in the retained feed (latest 100 per agent), not provider ids. Before and Issued come from transcript adjacency and recorded links; they do not establish token cost per operation.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "About request links" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing \d/)).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Request history pages" })).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Request window" }).parentElement).not.toHaveTextContent(/Loaded|All \d/);
  });

  it("changes scope to the newest row and keeps a chart click in the current window", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 10 }, (_, index) => snapshot(index + 1, index % 2 ? "child" : "primary"));
    const { container } = renderPanel(items, { agents: [agent, childAgent] });
    await user.selectOptions(screen.getByLabelText("Agent scope"), "primary");
    expect(screen.getByRole("heading", { name: "Request #5" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#1", "#5"]);

    const bars = container.querySelectorAll(".requestsActionsBar");
    fireEvent.click(bars[2]);
    expect(screen.getByRole("heading", { name: "Request #3" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#1", "#5"]);
    expect(bars[2]).toHaveClass("isSelected");
    expect(bars[2].querySelector(".requestsActionsSelection")).toBeInTheDocument();
  });

  it("recenters the window when a Largest requests row is selected", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    const largest = screen.getByRole("button", { name: /Locate request #1,/ });
    largest.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Request #1" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#1", "#60"]);
  });

  it("keeps the largest-request rail compact and scoped", () => {
    const { container } = renderPanel(Array.from({ length: 10 }, (_, index) => snapshot(index + 1)));
    const largest = screen.getByRole("region", { name: "Largest requests" });
    expect(largest).toHaveTextContent("Largest requests · All agents");
    expect(largest).not.toHaveTextContent(/before:|Show 20|Individual request measurements/);
    expect(largest.querySelectorAll(".requestsActionsLargestRow")).toHaveLength(5);
    expect(largest.querySelector(".requestsActionsLargestIdentity")).toBeNull();
    expect(largest.querySelectorAll(".requestsActionsLargestBar")).toHaveLength(5);
    expect(container.querySelector(".requestsActionsLargest footer")).toBeNull();
  });

  it("moves selection and the window by one at the boundary with Prev and ArrowLeft", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[0]);
    expect(screen.getByRole("heading", { name: "Request #41" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prev" }));
    expect(screen.getByRole("heading", { name: "Request #40" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#40", "#99"]);

    fireEvent.keyDown(chart(container), { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Request #39" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#39", "#98"]);
  });

  it("keeps focus on the newly selected bar across repeated ArrowLeft steps", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    const first = container.querySelectorAll(".requestsActionsBar")[0] as SVGGElement;
    fireEvent.click(first);
    chart(container).focus();
    fireEvent.keyDown(chart(container), { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Request #40" })).toBeInTheDocument();
    expect(document.activeElement).toHaveClass("requestsActionsBar");
    expect(document.activeElement).toHaveAttribute("aria-label", expect.stringContaining("Request #40"));

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("heading", { name: "Request #39" })).toBeInTheDocument();
    expect(document.activeElement).toHaveClass("requestsActionsBar");
    expect(document.activeElement).toHaveAttribute("aria-label", expect.stringContaining("Request #39"));
    expect(axisLabels(container)).toEqual(["#39", "#98"]);
  });

  it("keeps selection and window while changing mode and draws the appropriate stacks", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1, "primary", {
      uncachedInputTokens: 1_000, cacheReadTokens: 90_000,
    })));
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[9]);
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    const labels = axisLabels(container);
    expect(container.querySelectorAll(".requestsActionsSegment.read")).toHaveLength(0);
    expect(container.querySelectorAll(".requestsActionsOutline")).toHaveLength(0);
    expect(screen.getByText("0–8,000 tokens")).toBeInTheDocument();
    expect(screen.getByText("Rescaled · cache reads excluded")).toBeInTheDocument();
    expect(screen.getByText("Full prompt").parentElement).toHaveTextContent("93,000 tokens");
    const freshHeight = Number(container.querySelector(".requestsActionsSelection")!.getAttribute("height"));
    expect(freshHeight).toBeCloseTo(171.5);
    const selectedBar = container.querySelector(".requestsActionsBar.isSelected .requestsActionsSegment")!;
    const selectedLabel = container.querySelector(".requestsActionsSelectedLabel")!;
    expect(Number(selectedLabel.getAttribute("x"))).toBeCloseTo(
      Number(selectedBar.getAttribute("x")) + Number(selectedBar.getAttribute("width")) / 2,
    );
    expect(Number(selectedLabel.getAttribute("y"))).toBeCloseTo(70.5);

    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(labels);
    expect(container.querySelectorAll(".requestsActionsSegment.read")).toHaveLength(60);
    expect(container.querySelectorAll(".requestsActionsOutline")).toHaveLength(0);
    expect(screen.getByText("0–120K tokens")).toBeInTheDocument();
    expect(screen.getByText("All input + output")).toBeInTheDocument();
    expect(screen.getByText("Full prompt").parentElement).toHaveTextContent("93,000 tokens");

    await user.click(screen.getByRole("button", { name: "Fresh tokens" }));
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(labels);
    expect(Number(container.querySelector(".requestsActionsSelection")!.getAttribute("height"))).toBe(freshHeight);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Request window" }), { key: "Home" });
    expect(screen.getByText("0–8,000 tokens")).toBeInTheDocument();
  });

  it("includes output when comparing full-breakdown requests in the minimap", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel([
      snapshot(1, "primary", { uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900, outputTokens: 9_000 }),
      snapshot(2, "primary", { uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900, outputTokens: 1_000 }),
    ]);
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    const heights = Array.from(container.querySelectorAll(".requestsActionsMiniBar"), (bar) => Number(bar.getAttribute("height")));
    expect(heights[0]).toBeCloseTo(22);
    expect(heights[1]).toBeCloseTo(4.4);
  });

  it("rescales on phones while preserving prompt size and selection", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const { container } = renderPanel([snapshot(1, "primary", {
      uncachedInputTokens: 2_000, cacheWriteTokens: 0, cacheReadTokens: 90_000, outputTokens: 1_000,
    })], { cacheWriteAvailable: false });
    expect(screen.getByText("0–3,000 tokens")).toBeInTheDocument();
    expect(screen.getByText("Full prompt").parentElement).toHaveTextContent("92,000 tokens");
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(screen.getByText("0–120K tokens")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Request #1" })).toBeInTheDocument();
    expect(screen.getByText("Full prompt").parentElement).toHaveTextContent("92,000 tokens");
    expect(container.querySelectorAll(".requestsActionsOutline")).toHaveLength(0);
    expect(screen.queryByText("Cache write")).not.toBeInTheDocument();
  });

  it("hides cache-write evidence for Codex and keeps zero-valued geometry finite", () => {
    const { container } = renderPanel([snapshot(1, "primary", {
      uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0,
    })], { cacheWriteAvailable: false });
    expect(screen.queryByText("Cache write")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".requestsActionsSegment.write")).toHaveLength(0);
    expect(container.querySelectorAll(".requestsActionsStat.write")).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("renders bounded action associations and explicit empty states", () => {
    const actionRow = snapshot(1, "primary", {
      precedingWork: [{ kind: "read", count: 2 }, { kind: "test", count: 1 }],
      precedingAssociation: "transcript_adjacency",
      issuedWork: [{ kind: "write", count: 1 }],
      issuedAssociation: "recorded_link",
    });
    const { rerender } = renderPanel([actionRow]);
    const detail = screen.getByRole("region", { name: "Selected request" });
    expect(within(detail).getByText("Before")).toBeInTheDocument();
    expect(within(detail).getByText("Issued")).toBeInTheDocument();
    expect(screen.getByText("Reading ×2")).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("Editing")).toBeInTheDocument();

    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([snapshot(2)])} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getAllByText("None recorded")).toHaveLength(2);
  });

  it("renders older monitor snapshots without action fields as no recorded work", () => {
    const legacySnapshot = snapshot(1);
    for (const field of ["precedingWork", "precedingAssociation", "issuedWork", "issuedAssociation"]) Reflect.deleteProperty(legacySnapshot, field);
    renderPanel([legacySnapshot]);
    expect(screen.getByRole("region", { name: "Selected request" })).toBeInTheDocument();
    expect(screen.getAllByText("None recorded")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Locate request #1, 1,999,000 uncached input" })).toBeInTheDocument();
  });

  it("shows the unavailable and ready-empty states without rendering a chart", () => {
    const { container, rerender } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([], "unavailable")} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getByText("No request observations for this session yet.")).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsChart")).not.toBeInTheDocument();
    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([])} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getByText("No request observations for this session yet.")).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsChart")).not.toBeInTheDocument();
  });

  it("remounts cleanly for a new session key", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const props = { agents: [agent], requestSnapshots: requestFeed(items), contextBoundaries: [], cacheWriteAvailable: true, historical: false };
    const { container, rerender } = render(<RequestsActionsPanel key="session-one" {...props} />);
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[0]);
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(screen.getByRole("heading", { name: "Request #41" })).toBeInTheDocument();
    rerender(<RequestsActionsPanel key="session-two" {...props} />);
    expect(screen.getByRole("heading", { name: "Request #100" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fresh tokens" })).toHaveAttribute("aria-pressed", "true");
    expect(axisLabels(container)).toEqual(["#41", "#100"]);
  });

  it("follows a live tail append only when the newest request was selected and retains identity otherwise", () => {
    const initial = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const { container, rerender } = renderPanel(initial);
    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([...initial, snapshot(101)])} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getByRole("heading", { name: "Request #101" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#42", "#101"]);

    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[8]);
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    const retained = [...initial.slice(1), snapshot(102)];
    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed(retained)} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getByRole("heading", { name: "Request #49" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Request #49" }).closest("section")).toBeInTheDocument();
  });

  it("moves the minimap window without moving the selected request", () => {
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    const minimap = screen.getByRole("slider", { name: "Request window" });
    vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({ left: 0, right: 100, top: 0, bottom: 26, width: 100, height: 26, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(minimap, { button: 0, isPrimary: true, pointerId: 1, clientX: 50, clientY: 10 });
    fireEvent.pointerMove(minimap, { pointerId: 1, clientX: 60, clientY: 10 });
    fireEvent.pointerUp(minimap, { pointerId: 1, clientX: 60, clientY: 10 });
    expect(screen.getByRole("heading", { name: "Request #100" })).toBeInTheDocument();
    expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 41 to 100 of 100");

    fireEvent.pointerDown(minimap, { button: 0, isPrimary: true, pointerId: 2, clientX: 0, clientY: 10 });
    expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 1 to 60 of 100");
    expect(container.querySelector(".requestsActionsDetail")).toHaveTextContent("Request #100");
  });

  it("canonicalizes equivalent cache timestamps and rejects invalid join keys", () => {
    expect(snapshotEventKey("primary", "2026-08-09T08:04:00.000-04:00")).toBe(snapshotEventKey("primary", "2026-08-09T12:04:00.000Z"));
    expect(snapshotEventKey("primary", "not-a-timestamp")).toBeNull();
    expect(snapshotEventKey("primary", "2026-08-09T12:04:00.000Z")).not.toBe(snapshotEventKey("child", "2026-08-09T12:04:00.000Z"));
  });

  it("keeps ordinary cache writes in bars and details without refill lines", () => {
    const target = snapshot(1, "primary", { uncachedInputTokens: 2, cacheWriteTokens: 40415, cacheReadTokens: 0 });
    const event: CacheEvent = { id: "initial", agentId: "primary", kind: "refill", observedAt: target.observedAt, promptInputTokens: 40417, cacheReadPercent: 0, cacheWriteTokens: 40415, previousCacheReadPercent: null, gapMs: null, relatedEventId: null };
    const { container } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([target])} contextBoundaries={[]} cacheWriteAvailable historical cacheEvents={{ status: "ready", items: [event], possibleFullRefills: [] }} />);
    expect(container.querySelector(".requestsActionsRefill")).toBeNull();
    expect(container.querySelector(".requestsActionsMiniRefill")).toBeNull();
    expect(container.querySelector(".requestsActionsSegment.write")).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsStat.write")).toHaveTextContent("40,415");
    expect(screen.queryByRole("region", { name: "Request cache evidence" })).not.toBeInTheDocument();
  });

  it("marks recorded and inferred refills, selects their request, and preserves markers across modes", async () => {
    const user = userEvent.setup();
    const target = snapshot(2);
    const event: CacheEvent = {
      id: "refill-2", agentId: "primary", kind: "refill", observedAt: target.observedAt,
      promptInputTokens: 5_000, cacheReadPercent: 5, cacheWriteTokens: 5_000,
      previousCacheReadPercent: 90, gapMs: 1_000, relatedEventId: null,
    };
    const { container } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([snapshot(1), target])} contextBoundaries={[]} cacheWriteAvailable historical={false}
      cacheEvents={{ status: "ready", items: [event], possibleFullRefills: fullRefill("primary", target.observedAt) }}
      cacheReadDrops={{ status: "ready", items: [] }} />);
    const marker = container.querySelector(".requestsActionsRefill")!;
    expect(marker.querySelector("title")).toHaveTextContent("Possible full refill · request #2");
    expect(marker.querySelector(".cacheRefillIcon")).toHaveAttribute("width", "16");
    expect(marker.querySelector(".cacheRefillIcon")).toHaveAttribute("height", "16");
    const bar = marker.closest(".requestsActionsBar")!;
    expect(bar).toHaveAttribute("aria-label", expect.stringContaining("Possible full refill"));
    expect(marker).not.toHaveClass("isInferred");
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Request #2" })).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsBar.isSelected .requestsActionsRefill")).toBeInTheDocument();
    fireEvent.click(marker);
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(container.querySelector(".requestsActionsRefill")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Request cache evidence" })).toHaveTextContent("Possible full refill");
    expect(screen.getByRole("region", { name: "Request cache evidence" })).toHaveTextContent("90% → 5%");
    expect(container.querySelector(".requestsActionsBar.isSelected")).toHaveAttribute("aria-label", expect.stringContaining("Possible full refill"));
  });

  it("renders read-drop evidence as an inferred marker and keeps it usable on phone", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const target = snapshot(2);
    const cacheReadDrops: CacheReadDropFeed = { status: "ready", items: [{ agentId: "primary", count: 1, occurrences: [{ id: "drop-2", observedAt: target.observedAt, previousCacheReadPercent: 90, cacheReadPercent: 5, gapMs: 1_000 }] }] };
    const { container } = renderPanel([snapshot(1), target], { cacheReadDrops });
    const marker = container.querySelector(".requestsActionsRefill.isInferred")!;
    expect(marker.querySelector("title")).toHaveTextContent("Possible refill · request #2");
    expect(marker.closest(".requestsActionsBar")).toHaveAttribute("aria-label", expect.stringContaining("Possible refill"));
    expect(container.querySelector(".requestsActionsMiniRefill.isInferred")).toBeInTheDocument();
    fireEvent.click(marker);
    expect(screen.getByRole("heading", { name: "Request #2" })).toBeInTheDocument();
    const evidence = screen.getByRole("region", { name: "Request cache evidence" });
    expect(evidence).toHaveTextContent("Possible refill");
    expect(evidence).toHaveTextContent(/Inference/i);
    expect(evidence).toHaveTextContent("90% → 5%");
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(container.querySelector(".requestsActionsRefill.isInferred")).toBeInTheDocument();
  });

  it("renders compaction and refill markers together and refreshes selected evidence", () => {
    const first = snapshot(1);
    const target = snapshot(2);
    const event: CacheEvent = {
      id: "refill-refresh", agentId: "primary", kind: "refill", observedAt: target.observedAt,
      promptInputTokens: 5_000, cacheReadPercent: 5, cacheWriteTokens: 5_000,
      previousCacheReadPercent: 90, gapMs: 1_000, relatedEventId: null,
    };
    const props = { agents: [agent], requestSnapshots: requestFeed([first, target]), contextBoundaries: [{
      id: "compact", agentId: "primary", timestamp: "2026-08-09T12:01:30.000Z", kind: "automatic_compaction" as const, preTokens: null,
    }], cacheWriteAvailable: true, historical: false };
    const { container, rerender } = render(<RequestsActionsPanel {...props} />);
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[1]);
    expect(container.querySelector(".requestsActionsBar.isSelected .requestsActionsCompaction")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Request cache evidence" })).not.toBeInTheDocument();
    rerender(<RequestsActionsPanel {...props} cacheEvents={{ status: "ready", items: [event], possibleFullRefills: fullRefill("primary", target.observedAt) }} />);
    expect(container.querySelector(".requestsActionsBar.isSelected .requestsActionsCompaction")).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsBar.isSelected .requestsActionsRefill")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Request cache evidence" })).toHaveTextContent("Possible full refill");
  });

  it("keeps a tappable phone minimap without Prev/Next or the ranking rail", () => {
    setPhone(true);
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    expect(container.querySelectorAll(".requestsActionsBar")).toHaveLength(20);
    expect(axisLabels(container)).toEqual(["#81", "#100"]);
    const minimap = screen.getByRole("slider", { name: "Request window" });
    expect(minimap.querySelectorAll(".requestsActionsMiniBar")).toHaveLength(100);
    vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({ left: 0, right: 300, top: 0, bottom: 44, width: 300, height: 44, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(minimap, { button: 0, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: 75, clientY: 22 });
    fireEvent.pointerUp(minimap, { pointerId: 1, pointerType: "touch" });
    expect(axisLabels(container)).toEqual(["#16", "#35"]);
    expect(screen.queryByRole("button", { name: "Prev" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Largest requests" })).not.toBeInTheDocument();
  });

  it("drags the phone chart in both directions across history pages and releases cancelled gestures", async () => {
    setPhone(true);
    const fetchPage = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const offset = params.get("offset") === "latest" ? 80 : Number(params.get("offset"));
      expect(params.get("limit")).toBe("20");
      return { ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "phone", total: 100, offset, linkedCount: 0,
        overview: Array.from({ length: 100 }, (_, index) => overviewPoint(snapshot(index + 1))),
        items: Array.from({ length: 20 }, (_, index) => ({ ...snapshot(offset + index + 1), number: offset + index + 1 })),
      }) };
    });
    vi.stubGlobal("fetch", fetchPage);
    const { container } = render(<HistoryLocateHarness sessionId="phone-minimap" requests={[]} />);
    await waitFor(() => expect(axisLabels(container)).toEqual(["#81", "#100"]));
    const svg = chart(container);
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, right: 334, top: 0, bottom: 196, width: 334, height: 196, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(svg, { button: 0, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: 34, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: "touch", clientX: 333, clientY: 100 });
    await waitFor(() => expect(axisLabels(container)).toEqual(["#61", "#80"]));
    expect(screen.getByRole("slider", { name: "Request window" })).toHaveAttribute("aria-valuetext", "Request positions 61 to 80 of 100");
    fireEvent.pointerDown(svg, { button: 0, isPrimary: true, pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 100 });
    expect(axisLabels(container)).toEqual(["#61", "#80"]);
    fireEvent.pointerCancel(svg, { pointerId: 1, pointerType: "touch" });
    const calls = fetchPage.mock.calls.length;
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 100 });
    expect(fetchPage).toHaveBeenCalledTimes(calls);
    fireEvent.pointerDown(svg, { button: 0, isPrimary: true, pointerId: 3, pointerType: "touch", clientX: 333, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 3, pointerType: "touch", clientX: 34, clientY: 100 });
    fireEvent.pointerUp(svg, { pointerId: 3, pointerType: "touch", clientX: 34, clientY: 100 });
    await waitFor(() => expect(axisLabels(container)).toEqual(["#81", "#100"]));
    expect(screen.queryByRole("button", { name: "Prev" })).not.toBeInTheDocument();
  });

  it("keeps taps and keyboard selection while ignoring vertical gestures and drag clicks", () => {
    setPhone(true);
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    const svg = chart(container);
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, right: 334, top: 0, bottom: 196, width: 334, height: 196, x: 0, y: 0, toJSON: () => ({}) });
    const bar = screen.getByRole("button", { name: /^Request #90,/ });
    fireEvent.pointerDown(bar, { button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(bar, { pointerId: 1 });
    fireEvent.click(bar, { detail: 1 });
    expect(bar).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerDown(svg, { button: 0, isPrimary: true, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 2, clientX: 102, clientY: 140 });
    fireEvent.pointerMove(svg, { pointerId: 2, clientX: 300, clientY: 140 });
    expect(axisLabels(container)).toEqual(["#81", "#100"]);
    fireEvent.pointerDown(bar, { button: 0, isPrimary: true, pointerId: 3, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(bar, { pointerId: 3, clientX: 160, clientY: 100 });
    fireEvent.lostPointerCapture(bar, { pointerId: 3 });
    fireEvent.pointerMove(svg, { pointerId: 3, clientX: 175, clientY: 100 });
    expect(axisLabels(container)).toEqual(["#76", "#95"]);
    fireEvent.pointerUp(svg, { pointerId: 3 });
    const otherBar = screen.getByRole("button", { name: /^Request #85,/ });
    fireEvent.click(otherBar, { detail: 1 });
    expect(bar).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(otherBar, { key: "Enter" });
    expect(otherBar).toHaveAttribute("aria-pressed", "true");
    // Large drags clamp to the available history, then a fresh tap works normally.
    fireEvent.pointerDown(svg, { button: 0, isPrimary: true, pointerId: 4, clientX: 0, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 4, clientX: 2000, clientY: 100 });
    fireEvent.pointerUp(svg, { pointerId: 4 });
    expect(axisLabels(container)).toEqual(["#1", "#20"]);
    const first = screen.getByRole("button", { name: /^Request #1,/ });
    fireEvent.pointerDown(first, { button: 0, isPrimary: true, pointerId: 5, clientX: 40, clientY: 100 });
    fireEvent.pointerUp(first, { pointerId: 5 });
    fireEvent.click(first, { detail: 1 });
    expect(first).toHaveAttribute("aria-pressed", "true");
  });
});

describe("committed request minimap overview", () => {
  it("uses request-local categories across the whole history for both modes and provider capabilities", () => {
    const rows = scopedRows(requestFeed([snapshot(2)]), [], "all");
    const overview: RequestOverviewPoint[] = [[10, 90, 900, 100], [100, 0, 0, 0]];
    const props = { rows, overview, start: 2, end: 2, total: 2, offset: 1, onMove: vi.fn(), cacheWriteAvailable: true };
    const { container, rerender } = render(<RequestMinimap {...props} mode="fresh" />);
    const heights = () => Array.from(container.querySelectorAll(".requestsActionsMiniBar"), (bar) => Number(bar.getAttribute("height")));
    expect(heights()).toEqual([22, 11]);
    rerender(<RequestMinimap {...props} mode="full" />);
    expect(heights()).toEqual([22, 2]);
    rerender(<RequestMinimap {...props} mode="fresh" cacheWriteAvailable={false} />);
    expect(heights()[1]).toBeCloseTo(20);
    rerender(<RequestMinimap {...props} mode="full" cacheWriteAvailable={false} />);
    expect(heights()[1]).toBeCloseTo(100 / 1010 * 22);
  });

  it.each([null, [[1, 2, 3, 4]], [[1, 2, 3, 4], [1, -2, 3, 4]]])("keeps actual loaded positions when an overview is missing or invalid: %j", (overview) => {
    const rows = scopedRows(requestFeed([snapshot(2)]), [], "all");
    const { container } = render(<RequestMinimap rows={rows} overview={overview as RequestOverviewPoint[] | null} start={2} end={2} total={2} offset={1} onMove={vi.fn()} mode="fresh" cacheWriteAvailable />);
    expect(container.querySelectorAll(".requestsActionsMiniBar")).toHaveLength(1);
    expect(Number(container.querySelector(".requestsActionsMiniBar")?.getAttribute("x"))).toBeGreaterThan(500);
  });
});
