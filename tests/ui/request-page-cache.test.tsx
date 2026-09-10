import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRequestPageCache } from "../../app/components/dashboard/requests-actions/useRequestPageCache";
import type { RequestHistoryPage } from "../../shared/session-history-contract";

function page(revision: string, offset = 120, total = 180): RequestHistoryPage {
  return { status: "ready", kind: "requests", revision, total, offset, linkedCount: 0,
    overview: Array.from({ length: total }, () => [1, 2, 3, 4]),
    items: Array.from({ length: Math.min(60, total - offset) }, (_, index) => ({
      id: `request-${revision}-${offset + index}`, number: offset + index + 1, agentId: "primary",
      observedAt: "2026-09-10T12:00:00Z", cacheLifetime: null,
      uncachedInputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, totalTokens: 10,
      precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null,
    })),
  };
}
const response = (value: RequestHistoryPage) => ({ ok: true, json: async () => value });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("discards old revision preload responses and keeps one complete revision", async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
  const { result, rerender } = renderHook(({ seed }) => useRequestPageCache("session:all:60", "session", "all", seed), { initialProps: { seed: page("1") } });
  expect(result.current.window(0, 60)).toBeNull();
  expect(result.current.window(120, 60)?.revision).toBe("1");
  expect(result.current.locate("request-1-125", 60)?.offset).toBe(120);
  rerender({ seed: page("2", 0, 60) });
  await act(async () => { resolve(response(page("1", 0))); });
  expect(result.current.page?.revision).toBe("2");
  expect(result.current.locate("request-1-125", 60)).toBeNull();
  expect(result.current.locate("request-2-30", 20)?.items).toHaveLength(20);
  expect(result.current.window(0, 60)?.items[0].id).toBe("request-2-0");
  expect(result.current.page?.overview).toHaveLength(60);
});

it.each(["other-session:all:60", "session:child:60", "session:all:20"])("isolates the cache when its session, scope or viewport changes to %s", async (nextKey) => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
  const { result, rerender } = renderHook(({ key, seed }) => useRequestPageCache(key, "session", "all", seed), { initialProps: { key: "session:all:60", seed: page("1") as RequestHistoryPage | null } });
  const old = result.current;
  rerender({ key: nextKey, seed: null });
  await act(async () => { resolve(response(page("1", 0))); });
  expect(result.current).not.toBe(old);
  expect(result.current.window(120, 60)).toBeNull();
  expect(result.current.locate("request-1-125", 60)).toBeNull();
  expect(result.current.page).toBeNull();
});

it("retries a failed preload without replacing loaded evidence or repeating successful pages", async () => {
  vi.useFakeTimers();
  const fetchPage = vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(response(page("1", 0)))
    .mockResolvedValueOnce(response(page("1", 60)));
  vi.stubGlobal("fetch", fetchPage);
  const { result } = renderHook(() => useRequestPageCache("session:all:60", "session", "all", seed));
  await act(async () => {});
  expect(result.current.window(120, 60)?.items).toHaveLength(60);
  expect(result.current.window(0, 60)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(fetchPage).toHaveBeenCalledTimes(3);
  expect(result.current.window(30, 60)?.items).toHaveLength(60);
  expect(result.current.locate("request-1-60", 60)?.offset).toBe(30);
  expect(result.current.firstMissing()).toBeNull();
});
const seed = page("1");

it("refuses a mismatched preload revision until foreground refresh adopts it", async () => {
  const fetchPage = vi.fn().mockResolvedValue(response(page("2", 0)));
  vi.stubGlobal("fetch", fetchPage);
  const { result } = renderHook(() => useRequestPageCache("session:all:60", "session", "all", seed));
  await waitFor(() => expect(fetchPage).toHaveBeenCalledOnce());
  expect(result.current.window(0, 60)).toBeNull();
  expect(result.current.window(120, 60)?.revision).toBe("1");
});
