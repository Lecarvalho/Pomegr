import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useActivityHistory } from "../../app/components/dashboard/useActivityHistory";
import type { ActivityHistoryPage } from "../../shared/session-history-contract";

function page(offset = 0, total = 40, revision = "1"): ActivityHistoryPage {
  return { kind: "activity", status: "ready", revision, offset, total, linkedCount: 2,
    items: Array.from({ length: Math.min(8, total - offset) }, (_, index) => ({
      id: `event-${offset + index}`, timestamp: "2026-09-09T12:00:00Z", actor: "Primary agent", agentId: "primary",
      tool: "Assistant replied", detail: "", workKind: "report", status: null, durationMs: null,
      requestId: "request-0000000000000073", requestNumber: 73,
    })) };
}
const inputs = { enabled: true, sessionId: "claude:one", scope: "all", filterRequestId: null, navigation: null };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Activity history paging", () => {
  it("does not let polling cancel a slow request lookup or lose its target during hydration", async () => {
    vi.useFakeTimers();
    let resolveLookup!: (value: unknown) => void;
    let lookupCount = 0;
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      if (params.has("requestId") && ++lookupCount === 1) return new Promise((resolve) => { resolveLookup = resolve; });
      return { ok: true, json: async () => page(params.has("requestId") ? 24 : Number(params.get("offset"))) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory(inputs));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => result.current.locate("request-0000000000000073"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(lookupCount).toBe(1);
    await act(async () => { resolveLookup({ ok: true, json: async () => ({ ...page(), status: "loading", items: [] }) }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(lookupCount).toBe(2);
    expect(result.current.page?.offset).toBe(24);
  });

  it("prefetches neighbors, displays eight rows, and reuses them when navigating", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      return { ok: true, json: async () => page(Number(params.get("offset"))) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory(inputs));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(result.current.page?.items).toHaveLength(8);
    act(() => result.current.goToPage(2));
    await waitFor(() => expect(result.current.page?.offset).toBe(8));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    act(() => result.current.goToPage(1));
    await waitFor(() => expect(result.current.page?.offset).toBe(0));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("locates an unloaded request and retains its stable number", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      return { ok: true, json: async () => page(params.has("requestId") ? 24 : Number(params.get("offset"))) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ navigation }) => useActivityHistory({ ...inputs, navigation }), { initialProps: { navigation: null as { id: string } | null } });
    await waitFor(() => expect(result.current.page?.offset).toBe(0));
    rerender({ navigation: { id: "request-0000000000000073" } });
    await waitFor(() => expect(result.current.page?.offset).toBe(24));
    expect(result.current.page?.items[0].requestNumber).toBe(73);
    expect(result.current.linkedCount).toBe(2);
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
      const offset = params.has("anchor") ? 10 : Number(params.get("offset"));
      const result = page(offset, total, String(total));
      if (params.has("anchor")) result.items[0].id = params.get("anchor")!;
      return { ok: true, json: async () => result };
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useActivityHistory(inputs));
    await waitFor(() => expect(result.current.page?.offset).toBe(0));
    act(() => result.current.goToPage(2));
    await waitFor(() => expect(result.current.page?.offset).toBe(8));
    const first = result.current.page?.items[0].id;
    total = 42;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.newEvents).toBe(2));
    expect(result.current.page?.items[0].id).toBe(first);
    expect(fetcher.mock.calls.some(([url]) => url.includes(`anchor=${first}`))).toBe(true);
  });
});
