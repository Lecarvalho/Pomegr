import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useActivityHistory } from "../../app/components/dashboard/useActivityHistory";
import type { ActivityHistoryPage } from "../../shared/session-history-contract";

function page(offset = 0, total = 40, revision = "1"): ActivityHistoryPage {
  return { kind: "activity", status: "ready", revision, offset, total, linkedCount: 2,
    items: Array.from({ length: Math.min(8, total - offset) }, (_, index) => ({
      id: `event-${offset + index}`, timestamp: "2026-09-09T12:00:00Z", actor: "Primary agent", agentId: "primary",
      tool: "Assistant replied", detail: "", workKind: "report", status: null, durationMs: null,
      requestId: `request-${String(73 + offset).padStart(16, "0")}`, requestNumber: 73 + offset,
    })) };
}
function requestedOffset(params: URLSearchParams, total = 40) {
  return params.get("offset") === "latest" ? Math.floor((total - 1) / 8) * 8 : Number(params.get("offset"));
}
const inputs = { enabled: true, sessionId: "claude:one", scope: "all", filterRequestId: null, navigation: null };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Activity history paging", () => {
  it("resumes following across page boundaries when request selection carries live intent", async () => {
    vi.useFakeTimers();
    let total = 40;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const request = params.get("requestId");
      const anchor = params.get("anchor");
      const offset = request ? Math.floor((Number(request.slice(8)) - 73) / 8) * 8
        : anchor ? Number(anchor.slice(6)) : requestedOffset(params, total);
      return { ok: true, json: async () => page(offset, total, String(total)) };
    }));
    const { result, rerender } = renderHook(({ navigation }) => useActivityHistory({ ...inputs, navigation }), {
      initialProps: { navigation: null as { id: string; followLatest: boolean } | null },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    rerender({ navigation: { id: "request-0000000000000073", followLatest: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    total = 41;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.page?.offset).toBe(0);
    expect(result.current.newEvents).toBe(1);

    rerender({ navigation: { id: "request-0000000000000113", followLatest: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.page?.offset).toBe(40);
    total = 49;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.page?.offset).toBe(48);
    expect(result.current.page?.items[0].id).toBe("event-48");
    expect(result.current.newEvents).toBe(0);
  });

  it("reveals a resident linked page without a lookup or loading frame", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      return { ok: true, json: async () => page(params.has("requestId") ? 16 : requestedOffset(params)) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory(inputs));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    act(() => result.current.locate("request-0000000000000105"));
    expect(result.current.loading).toBe(false);
    expect(result.current.page?.offset).toBe(32);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A partial resident page cannot establish a request's full linked count.
    expect(result.current.linkedCount).toBeNull();
  });

  it("does not let polling cancel a slow request lookup or lose its target during hydration", async () => {
    vi.useFakeTimers();
    let resolveLookup!: (value: unknown) => void;
    let lookupCount = 0;
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      if (params.has("requestId") && ++lookupCount === 1) return new Promise((resolve) => { resolveLookup = resolve; });
      return { ok: true, json: async () => page(params.has("requestId") ? 16 : requestedOffset(params)) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory(inputs));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => result.current.locate("request-0000000000000090"));
    act(() => result.current.locate("request-0000000000000090"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(lookupCount).toBe(1);
    await act(async () => { resolveLookup({ ok: true, json: async () => ({ ...page(), status: "loading", items: [] }) }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(749); });
    expect(lookupCount).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(lookupCount).toBe(2);
    expect(result.current.page?.offset).toBe(16);
  });

  it("prefetches neighbors, displays eight rows, and reuses them when navigating", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      return { ok: true, json: async () => page(requestedOffset(params)) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory(inputs));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(result.current.page?.offset).toBe(32);
    expect(result.current.page?.items).toHaveLength(8);
    act(() => result.current.goToPage(2));
    await waitFor(() => expect(result.current.page?.offset).toBe(8));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
    act(() => result.current.goToPage(1));
    await waitFor(() => expect(result.current.page?.offset).toBe(0));
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("locates an unloaded request and retains its stable number", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const result = page(params.has("requestId") ? 16 : requestedOffset(params));
      if (params.has("requestId")) {
        result.items[1].requestId = "request-0000000000000090";
        result.items[1].requestNumber = 90;
      }
      return { ok: true, json: async () => result };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ navigation }) => useActivityHistory({ ...inputs, navigation }), { initialProps: { navigation: null as { id: string } | null } });
    await waitFor(() => expect(result.current.page?.offset).toBe(32));
    rerender({ navigation: { id: "request-0000000000000090" } });
    await waitFor(() => expect(result.current.page?.offset).toBe(16));
    expect(result.current.page?.items).toEqual(expect.arrayContaining([expect.objectContaining({ requestNumber: 90 })]));
    expect(result.current.linkedCount).toBe(2);
  });

  it("uses only the target lookup when scope and navigation change together", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      return { ok: true, json: async () => page(params.has("requestId") ? 16 : requestedOffset(params)) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ scope, navigation }) => useActivityHistory({ ...inputs, scope, navigation }), {
      initialProps: { scope: "all", navigation: null as { id: string } | null },
    });
    await waitFor(() => expect(result.current.page?.offset).toBe(32));
    const before = fetcher.mock.calls.length;
    rerender({ scope: "primary", navigation: { id: "request-0000000000000090" } });
    await waitFor(() => expect(result.current.page?.offset).toBe(16));
    const newCalls = fetcher.mock.calls.slice(before).map(([url]) => new URL(url, "http://localhost").searchParams);
    expect(newCalls[0]?.get("requestId")).toBe("request-0000000000000090");
    expect(newCalls.some((params) => !params.has("requestId") && params.get("offset") === "latest")).toBe(false);
  });

  it("keeps the newest navigation when an older aborted lookup resolves later", async () => {
    const pending = new Map<string, (value: unknown) => void>();
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const requestId = params.get("requestId");
      if (requestId) return new Promise((resolve) => pending.set(requestId, resolve));
      return { ok: true, json: async () => page(requestedOffset(params)) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ navigation }) => useActivityHistory({ ...inputs, navigation }), {
      initialProps: { navigation: null as { id: string } | null },
    });
    await waitFor(() => expect(result.current.page?.offset).toBe(32));
    const first = "request-0000000000000090";
    const second = "request-0000000000000091";
    rerender({ navigation: { id: first } });
    await waitFor(() => expect(pending.has(first)).toBe(true));
    rerender({ navigation: { id: second } });
    await waitFor(() => expect(pending.has(second)).toBe(true));
    await act(async () => { pending.get(second)!({ ok: true, json: async () => page(16) }); });
    await waitFor(() => expect(result.current.page?.offset).toBe(16));
    await act(async () => { pending.get(first)!({ ok: true, json: async () => page(24) }); });
    expect(result.current.page?.offset).toBe(16);
  });

  it("keeps rows visible during silent polling but marks foreground refresh loading", async () => {
    vi.useFakeTimers();
    let refreshResolve!: (value: unknown) => void;
    let calls = 0;
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      if (++calls === 3) return new Promise((resolve) => { refreshResolve = resolve; });
      return { ok: true, json: async () => page(requestedOffset(params)) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory(inputs));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.page?.items).toHaveLength(8);
    const rows = result.current.page?.items;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.loading).toBe(false);
    expect(result.current.page?.items).toEqual(rows);
    await act(async () => { refreshResolve({ ok: true, json: async () => page(32, 40, "2") }); });
    act(() => result.current.refresh());
    expect(result.current.loading).toBe(true);
  });

  it("follows latest until an explicit lookup pins it, then latest resumes following", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      return { ok: true, json: async () => page(params.has("requestId") ? 32 : requestedOffset(params)) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory(inputs));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(new URL(fetcher.mock.calls[0][0], "http://localhost").searchParams.get("offset")).toBe("latest");

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(new URL(fetcher.mock.calls.at(-1)![0], "http://localhost").searchParams.get("offset")).toBe("latest");

    act(() => result.current.locate("request-0000000000000090"));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const pinnedRefresh = new URL(fetcher.mock.calls.at(-1)![0], "http://localhost").searchParams;
    expect(pinnedRefresh.get("anchor")).toBe("event-32");

    act(() => result.current.latest());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(new URL(fetcher.mock.calls.at(-1)![0], "http://localhost").searchParams.get("offset")).toBe("latest");
  });

  it("preserves the visible page on failure and does not leak it across sessions", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (fail) throw new Error("offline");
      return { ok: true, json: async () => page() };
    }));
    const { result, rerender } = renderHook(({ sessionId }) => useActivityHistory({ ...inputs, sessionId }), { initialProps: { sessionId: "claude:one" } });
    await waitFor(() => expect(result.current.page?.items).toHaveLength(8));
    fail = true;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.page?.items).toHaveLength(8);
    rerender({ sessionId: "claude:two" });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.page).toBeNull();
  });

  it("refreshes an older page by anchor and offers new events without moving the rows", async () => {
    let total = 40;
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const offset = params.has("anchor") ? 8 : requestedOffset(params, total);
      const result = page(offset, total, String(total));
      if (params.has("anchor")) result.items[0].id = params.get("anchor")!;
      return { ok: true, json: async () => result };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory(inputs));
    await waitFor(() => expect(result.current.page?.offset).toBe(32));
    act(() => result.current.goToPage(2));
    await waitFor(() => expect(result.current.page?.offset).toBe(8));
    const first = result.current.page?.items[0].id;
    total = 42;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.newEvents).toBe(2));
    expect(result.current.page?.items[0].id).toBe(first);
    expect(fetcher.mock.calls.some(([url]) => url.includes(`anchor=${first}`))).toBe(true);
    act(() => result.current.latest());
    await waitFor(() => expect(result.current.page?.offset).toBe(40));
    expect(result.current.newEvents).toBe(0);
  });
});
