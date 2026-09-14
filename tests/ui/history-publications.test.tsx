import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeHistoryPublications } from "../../app/history-publications";
import { useActivityHistory } from "../../app/components/dashboard/useActivityHistory";
import { useSessionRequestSelection } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import { agent } from "./dashboard-test-fixtures";
import { requestFeed, snapshot } from "./requests-actions-test-fixtures";
import type { ActivityHistoryPage, RequestHistoryPage } from "../../shared/session-history-contract";

class HistoryEventSource {
  static instances: HistoryEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    HistoryEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (typeof listener !== "function") return;
    const current = this.listeners.get(type) || new Set();
    current.add(listener as (event: MessageEvent<string>) => void);
    this.listeners.set(type, current);
  }

  emit(value: unknown) {
    const event = new MessageEvent("history", { data: JSON.stringify(value) });
    for (const listener of this.listeners.get("history") || []) listener(event);
  }

  emitError() {
    const event = new Event("error");
    for (const listener of this.listeners.get("error") || []) listener(event as MessageEvent<string>);
  }

  close() { this.closed = true; }
}

function activityPage(total: number, revision = String(total), offset = Math.floor(Math.max(0, total - 1) / 8) * 8): ActivityHistoryPage {
  return {
    kind: "activity", status: "ready", revision, offset, total, linkedCount: 0,
    items: Array.from({ length: Math.min(8, total - offset) }, (_, index) => ({
      id: `event-${offset + index}`, timestamp: "2026-09-10T12:00:00.000Z", actor: "Primary agent", agentId: "primary",
      tool: "Assistant replied", detail: "", workKind: "report", status: null, durationMs: null,
      requestId: null, requestNumber: null,
    })),
  };
}

const subscriptions: Array<() => void> = [];
const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
function setHidden(hidden: boolean) { Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden }); }

afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  HistoryEventSource.instances = [];
  if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
});

describe("history publication notifications", () => {
  it("shares one stream, validates session-scoped payloads, and dedupes repeats", () => {
    vi.stubGlobal("EventSource", HistoryEventSource);
    vi.spyOn(performance, "now").mockReturnValue(1234);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeHistoryPublications(first);
    const unsubscribeSecond = subscribeHistoryPublications(second);
    subscriptions.push(unsubscribeFirst, unsubscribeSecond);
    expect(HistoryEventSource.instances).toHaveLength(1);
    const source = HistoryEventSource.instances[0];
    source.emit({ domain: "sessions", revision: 1 });
    source.emit({ domain: "history", sessionId: "bad", revision: 2 });
    source.emit({ domain: "history", sessionId: "claude:one", revision: -1 });
    source.emit({ domain: "history", sessionId: "claude:one", revision: 1.5 });
    source.emit({ domain: "history", sessionId: "claude:one", revision: "2" });
    source.emit({ domain: "history", sessionId: "claude:one", revision: 2 });
    source.emit({ domain: "history", sessionId: "claude:one", revision: 2 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith({ domain: "history", revision: 2 });
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    expect(source.closed).toBe(false);
    unsubscribeSecond();
    expect(source.closed).toBe(true);
  });

  it("reconnects into a fresh revision epoch and ignores late events from the old stream", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", HistoryEventSource);
    const listener = vi.fn();
    const unsubscribe = subscribeHistoryPublications(listener);
    subscriptions.push(unsubscribe);
    const first = HistoryEventSource.instances[0];
    first.emit({ domain: "history", sessionId: "claude:one", revision: 8 });
    expect(listener).toHaveBeenCalledTimes(1);

    first.emitError();
    first.emit({ domain: "history", sessionId: "claude:one", revision: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(HistoryEventSource.instances).toHaveLength(2);
    const second = HistoryEventSource.instances[1];
    second.emit({ domain: "history", sessionId: "claude:one", revision: 1 });
    expect(listener).toHaveBeenCalledTimes(2);
    first.emit({ domain: "history", sessionId: "claude:one", revision: 2 });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(second.closed).toBe(true);
  });

  it("refreshes Activity from the event without a timer or chart revision", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", HistoryEventSource);
    let total = 8;
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const offset = params.get("offset") === "latest" ? Math.floor(Math.max(0, total - 1) / 8) * 8 : Number(params.get("offset"));
      return { ok: true, json: async () => activityPage(total, String(total), offset) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory({ enabled: true, sessionId: "claude:history-events", scope: "all", filterRequestId: null, navigation: null }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const calls = fetcher.mock.calls.length;
    total = 9;
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:history-events", revision: 1 }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.page?.total).toBe(9);
    expect(fetcher).toHaveBeenCalledTimes(calls + 2);
    const afterFirst = fetcher.mock.calls.length;
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:history-events", revision: 1 }));
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(afterFirst);
  });

  it("refreshes unpinned latest Requests immediately while sharing the stream", async () => {
    vi.stubGlobal("EventSource", HistoryEventSource);
    let total = 2;
    const requests = [snapshot(1), snapshot(2)];
    const fetcher = vi.fn(async () => {
      const items = Array.from({ length: total }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }));
      const page: RequestHistoryPage = { kind: "requests", status: "ready", revision: String(total), total, offset: 0, linkedCount: 0, items, overview: items.map((item) => [item.uncachedInputTokens, item.cacheWriteTokens, item.cacheReadTokens, item.outputTokens]) };
      return { ok: true, json: async () => page };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed(requests), contextBoundaries: [], historical: false, sessionId: "claude:request-events", historyEnabled: true }));
    await waitFor(() => expect(result.current.history.status).toBe("ready"));
    const calls = fetcher.mock.calls.length;
    total = 3;
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:request-events", revision: 3 }));
    await waitFor(() => expect(result.current.history.total).toBe(3));
    expect(fetcher).toHaveBeenCalledTimes(calls + 1);
    const afterFirst = fetcher.mock.calls.length;
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:request-events", revision: 3 }));
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(afterFirst);
  });

  it("suppresses hidden history events and revalidates the mounted request page on foreground", async () => {
    vi.stubGlobal("EventSource", HistoryEventSource);
    const fetcher = vi.fn(async () => {
      const page: RequestHistoryPage = { kind: "requests", status: "ready", revision: "2", total: 1, offset: 0, linkedCount: 0,
        items: [{ ...snapshot(1), number: 1 }], overview: [[1, 2, 3, 4]] };
      return { ok: true, json: async () => page };
    });
    vi.stubGlobal("fetch", fetcher);
    const sessionId = "claude:hidden-history";
    renderHook(() => useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed([]), contextBoundaries: [], historical: false, sessionId, historyEnabled: true }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    setHidden(true);
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId, revision: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    setHidden(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("keeps receiving publications after cached request-window navigation", async () => {
    vi.stubGlobal("EventSource", HistoryEventSource);
    const pageFor = (offset: number, revision: string): RequestHistoryPage => {
      const total = 120;
      const items = Array.from({ length: 60 }, (_, index) => ({ ...snapshot(offset + index + 1), number: offset + index + 1 }));
      return { kind: "requests", status: "ready", revision, total, offset, linkedCount: 0, items,
        overview: Array.from({ length: total }, (_, index) => [index + 1, 2, 3, 4]) };
    };
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const offset = params.get("offset") === "latest" ? 60 : Number(params.get("offset"));
      return { ok: true, json: async () => pageFor(offset, "2") };
    });
    vi.stubGlobal("fetch", fetcher);
    const sessionId = "claude:cached-window";
    const { result } = renderHook(() => useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed([]), contextBoundaries: [], historical: false, sessionId, historyEnabled: true }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    act(() => result.current.history.first());
    await waitFor(() => expect(result.current.history.offset).toBe(0));
    expect(fetcher).toHaveBeenCalledTimes(2);
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId, revision: 2 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    const params = new URL(fetcher.mock.calls[2][0], "http://localhost").searchParams;
    expect(params.get("offset")).toBe("0");
    expect(params.get("overview")).not.toBe("0");
  });

  it("settles a historical request overview on its committed-history publication without following later revisions", async () => {
    vi.stubGlobal("EventSource", HistoryEventSource);
    const ready: RequestHistoryPage = { kind: "requests", status: "ready", revision: "2", total: 1, offset: 0, linkedCount: 0,
      items: [{ ...snapshot(1), number: 1 }], overview: [[snapshot(1).uncachedInputTokens, snapshot(1).cacheWriteTokens, snapshot(1).cacheReadTokens, snapshot(1).outputTokens]] };
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ kind: "requests", status: "ready", revision: "1", total: 1, offset: 0, linkedCount: 0, items: [{ ...snapshot(1), number: 1 }] }) })
      .mockResolvedValue({ ok: true, json: async () => ready });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed([snapshot(1)]), contextBoundaries: [], historical: true, sessionId: "claude:recorded-hydration", historyEnabled: true }));
    await waitFor(() => expect(result.current.history.status).toBe("ready"));
    expect(result.current.history.overview).toBeNull();
    expect(HistoryEventSource.instances).toHaveLength(1);

    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:recorded-hydration", revision: 2 }));
    await waitFor(() => expect(result.current.history.overview).toEqual(ready.overview));
    expect(fetcher).toHaveBeenCalledTimes(2);

    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:recorded-hydration", revision: 3 }));
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("retries an unavailable %s request history page when its next publication arrives", async (historical) => {
    vi.stubGlobal("EventSource", HistoryEventSource);
    const ready: RequestHistoryPage = { kind: "requests", status: "ready", revision: "2", total: 1, offset: 0, linkedCount: 0,
      items: [{ ...snapshot(1), number: 1 }], overview: [[1, 2, 3, 4]] };
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ kind: "requests", status: "unavailable", revision: "1", total: 0, offset: 0, linkedCount: 0, items: [] }) })
      .mockResolvedValue({ ok: true, json: async () => ready });
    vi.stubGlobal("fetch", fetcher);
    const sessionId = historical ? "claude:recorded-unavailable" : "claude:live-unavailable";
    const { result } = renderHook(() => useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed([]), contextBoundaries: [], historical, sessionId, historyEnabled: true }));
    await waitFor(() => expect(result.current.history.status).toBe("unavailable"));
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId, revision: 2 }));
    await waitFor(() => expect(result.current.history.revision).toBe("2"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("coalesces historical publications behind an in-flight hydration request", async () => {
    vi.stubGlobal("EventSource", HistoryEventSource);
    let firstSignal: AbortSignal | undefined;
    let firstRequest!: (value: unknown) => void;
    const ready: RequestHistoryPage = { kind: "requests", status: "ready", revision: "2", total: 1, offset: 0, linkedCount: 0,
      items: [{ ...snapshot(1), number: 1 }], overview: [[snapshot(1).uncachedInputTokens, snapshot(1).cacheWriteTokens, snapshot(1).cacheReadTokens, snapshot(1).outputTokens]] };
    const fetcher = vi.fn((_: string, options?: RequestInit) => {
      if (!firstSignal) {
        firstSignal = options?.signal as AbortSignal;
        return new Promise((resolve) => { firstRequest = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => ready });
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed([snapshot(1)]), contextBoundaries: [], historical: true, sessionId: "claude:recorded-in-flight", historyEnabled: true }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    act(() => {
      HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:recorded-in-flight", revision: 2 });
      HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:recorded-in-flight", revision: 3 });
      HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:recorded-in-flight", revision: 4 });
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(firstSignal?.aborted).toBe(false);
    firstRequest({ ok: true, json: async () => ({ kind: "requests", status: "ready", revision: "1", total: 1, offset: 0, linkedCount: 0, items: [{ ...snapshot(1), number: 1 }] }) });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.history.overview).toEqual(ready.overview));
  });

  it("replays one in-flight publication for a pinned older request page without moving its selection", async () => {
    vi.stubGlobal("EventSource", HistoryEventSource);
    const pageFor = (revision: string, total: number): RequestHistoryPage => {
      const offset = 0;
      const items = Array.from({ length: 60 }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }));
      return { kind: "requests", status: "ready", revision, total, offset, linkedCount: 0, items,
        overview: Array.from({ length: total }, (_, index) => [index + 1, 2, 3, 4]) };
    };
    let settleRefresh!: (value: unknown) => void;
    const fetcher = vi.fn((_: string) => {
      const call = fetcher.mock.calls.length;
      if (call === 1) {
        const initial = { ...pageFor("1", 120), offset: 60 };
        delete initial.overview;
        return Promise.resolve({ ok: true, json: async () => initial });
      }
      if (call === 2) return Promise.resolve({ ok: true, json: async () => pageFor("1", 120) });
      if (call === 3) return new Promise((resolve) => { settleRefresh = resolve; });
      return Promise.resolve({ ok: true, json: async () => pageFor("2", 121) });
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed([]), contextBoundaries: [], historical: false, sessionId: "claude:pinned-in-flight", historyEnabled: true }));
    await waitFor(() => expect(result.current.history.offset).toBe(60));
    act(() => result.current.locate("request-not-resident"));
    await waitFor(() => expect(result.current.history.offset).toBe(0));
    act(() => result.current.select(result.current.rows[12]));
    const selected = result.current.selected?.id;
    act(() => result.current.locate("request-still-absent"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:pinned-in-flight", revision: 2, total: 121 }));
    settleRefresh({ ok: true, json: async () => pageFor("1", 120) });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => !String(url).includes("overview=0"))).toHaveLength(4));
    await waitFor(() => expect(result.current.history.revision).toBe("2"));
    expect(result.current.history.total).toBe(121);
    expect(result.current.history.offset).toBe(0);
    expect(result.current.selected?.id).toBe(selected);
  });

  it("does not replay a queued historical publication after cancellation", async () => {
    vi.stubGlobal("EventSource", HistoryEventSource);
    let firstRequest!: (value: unknown) => void;
    const fetcher = vi.fn((_: string, options?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) {
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        return new Promise((resolve) => { firstRequest = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => ({ kind: "requests", status: "ready", revision: "1", total: 0, offset: 0, linkedCount: 0, items: [], overview: [] }) });
    });
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed([snapshot(1)]), contextBoundaries: [], historical: true, sessionId: "claude:recorded-cancelled", historyEnabled: true }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    act(() => {
      HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:recorded-cancelled", revision: 2 });
      HistoryEventSource.instances[0].emit({ domain: "history", sessionId: "claude:recorded-cancelled", revision: 3 });
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    hook.unmount();
    firstRequest({ ok: true, json: async () => ({ kind: "requests", status: "ready", revision: "1", total: 0, offset: 0, linkedCount: 0, items: [], overview: [] }) });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
