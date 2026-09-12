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

afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  HistoryEventSource.instances = [];
});

describe("history publication notifications", () => {
  it("shares one stream, validates the identity-free numeric payload, and dedupes repeats", () => {
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
    source.emit({ domain: "history", revision: -1 });
    source.emit({ domain: "history", revision: 1.5 });
    source.emit({ domain: "history", revision: "2" });
    source.emit({ domain: "history", revision: 2 });
    source.emit({ domain: "history", revision: 2 });
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
    first.emit({ domain: "history", revision: 8 });
    expect(listener).toHaveBeenCalledTimes(1);

    first.emitError();
    first.emit({ domain: "history", revision: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(HistoryEventSource.instances).toHaveLength(2);
    const second = HistoryEventSource.instances[1];
    second.emit({ domain: "history", revision: 1 });
    expect(listener).toHaveBeenCalledTimes(2);
    first.emit({ domain: "history", revision: 2 });
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
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", revision: 1 }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.page?.total).toBe(9);
    expect(fetcher).toHaveBeenCalledTimes(calls + 2);
    const afterFirst = fetcher.mock.calls.length;
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", revision: 1 }));
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
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", revision: 3 }));
    await waitFor(() => expect(result.current.history.total).toBe(3));
    expect(fetcher).toHaveBeenCalledTimes(calls + 1);
    const afterFirst = fetcher.mock.calls.length;
    act(() => HistoryEventSource.instances[0].emit({ domain: "history", revision: 3 }));
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(afterFirst);
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

    act(() => HistoryEventSource.instances[0].emit({ domain: "history", revision: 2 }));
    await waitFor(() => expect(result.current.history.overview).toEqual(ready.overview));
    expect(fetcher).toHaveBeenCalledTimes(2);

    act(() => HistoryEventSource.instances[0].emit({ domain: "history", revision: 3 }));
    await act(async () => { await Promise.resolve(); });
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
      HistoryEventSource.instances[0].emit({ domain: "history", revision: 2 });
      HistoryEventSource.instances[0].emit({ domain: "history", revision: 3 });
      HistoryEventSource.instances[0].emit({ domain: "history", revision: 4 });
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(firstSignal?.aborted).toBe(false);
    firstRequest({ ok: true, json: async () => ({ kind: "requests", status: "ready", revision: "1", total: 1, offset: 0, linkedCount: 0, items: [{ ...snapshot(1), number: 1 }] }) });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.history.overview).toEqual(ready.overview));
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
      HistoryEventSource.instances[0].emit({ domain: "history", revision: 2 });
      HistoryEventSource.instances[0].emit({ domain: "history", revision: 3 });
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    hook.unmount();
    firstRequest({ ok: true, json: async () => ({ kind: "requests", status: "ready", revision: "1", total: 0, offset: 0, linkedCount: 0, items: [], overview: [] }) });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
