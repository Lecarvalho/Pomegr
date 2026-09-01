import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsStore, normalizeAgentsSnapshot, AGENTS_POLL_MS } from "../../app/agents-client";
import type { AgentsAnalyticsSnapshot } from "../../shared/agents-contract";

const filters = { project: "all", days: 30, scope: "all" } as const;
function snapshot(overrides: Partial<AgentsAnalyticsSnapshot> = {}): AgentsAnalyticsSnapshot {
  return {
    revision: 4, readiness: "ready", generatedAt: "2026-09-01T12:00:00.000Z",
    coverage: { retainedSessions: 0, eligibleSessions: 0, missingSessions: 0, retainedRuns: 0, truncated: false, earliestStartedAt: null },
    filters: { ...filters, projects: ["Pomegr"] },
    summary: { runCount: 0, sessionCount: 0, modelCount: 0, mainRunCount: 0, delegatedRunCount: 0 },
    models: [], work: [], runs: [], roster: [], ...overrides,
  };
}
const response = (body = snapshot()) => new Response(JSON.stringify(body), { status: 200 });
const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (hidden) Object.defineProperty(document, "hidden", hidden);
});
function setHidden(value: boolean) { Object.defineProperty(document, "hidden", { configurable: true, get: () => value }); }

describe("Agents cache client", () => {
  it("fails closed for malformed or unexpected browser fields", () => {
    expect(normalizeAgentsSnapshot(snapshot())).toEqual(snapshot());
    expect(normalizeAgentsSnapshot({ ...snapshot(), transcriptPath: "PRIVATE_PATH" })).toBeNull();
    expect(normalizeAgentsSnapshot(snapshot({ revision: -1 }))).toBeNull();
    expect(normalizeAgentsSnapshot(snapshot({ generatedAt: "bad-time" }))).toBeNull();
    expect(normalizeAgentsSnapshot({ ...snapshot(), work: [{ workKind: "unrecognized", count: 1 }] })).toBeNull();
    expect(normalizeAgentsSnapshot({ ...snapshot(), runs: [{ prompt: "PRIVATE_PROMPT" }] })).toBeNull();
    expect(normalizeAgentsSnapshot({ ...snapshot(), models: [{ model: "x", runCount: 1, mainRunCount: 1, delegatedRunCount: 0, roles: [{ role: "provider-private-kind", runCount: 1 }] }] })).toBeNull();
  });

  it("retains the last summary through 204, failure, and unchanged recovery", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error("PRIVATE_UPSTREAM_FAILURE"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const store = new AgentsStore(filters);
    await store.refresh();
    const first = store.getSnapshot().data;
    await store.refresh();
    expect(store.getSnapshot().data).toBe(first);
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ data: first, loading: false, connected: false, refreshing: false });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ data: first, connected: true });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/agents?project=all&days=30&scope=all",
      ...Array(3).fill("/api/agents?project=all&days=30&scope=all&revision=4"),
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });

  it("keeps a delayed retained summary marked delayed after unchanged polls", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(snapshot({ refreshReadiness: "unavailable" })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response(snapshot({ revision: 5, refreshReadiness: "ready" })));
    const store = new AgentsStore(filters);
    await store.refresh();
    const retained = store.getSnapshot().data;
    expect(store.getSnapshot().connected).toBe(false);
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ data: retained, connected: false });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ connected: true });
  });
  it("never replaces committed data with loading or unavailable responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(snapshot({ readiness: "loading", revision: 5 })))
      .mockResolvedValueOnce(response(snapshot({ readiness: "unavailable", revision: 6 })));
    const store = new AgentsStore(filters);
    await store.refresh();
    const prior = store.getSnapshot().data;
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ data: prior, loading: false, connected: true });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ data: prior, loading: false, connected: false });
  });

  it("keeps startup loading and unavailable distinct from an observed empty summary", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(snapshot({ readiness: "loading", generatedAt: null })))
      .mockResolvedValueOnce(response(snapshot({ readiness: "unavailable", generatedAt: null })))
      .mockResolvedValueOnce(response());
    const store = new AgentsStore(filters);
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ data: null, loading: true });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ data: null, loading: false, connected: false });
    await store.refresh();
    expect(store.getSnapshot().data?.summary.runCount).toBe(0);
  });

  it("rejects a response for a different filter and accepts a monitor revision reset", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(snapshot({ filters: { ...filters, project: "Other", projects: ["Other"] } })))
      .mockResolvedValueOnce(response(snapshot({ revision: 1 })));
    const store = new AgentsStore(filters);
    await store.refresh();
    await store.refresh();
    expect(store.getSnapshot().data?.filters.project).toBe("all");
    expect(store.getSnapshot().connected).toBe(false);
    await store.refresh();
    expect(store.getSnapshot().data?.revision).toBe(1);
  });

  it("shares one minute-based polling lane and pauses while hidden", async () => {
    vi.useFakeTimers(); setHidden(false);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
    const store = new AgentsStore(filters);
    const one = store.subscribe(vi.fn()), two = store.subscribe(vi.fn());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(AGENTS_POLL_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    setHidden(true); document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(AGENTS_POLL_MS * 2); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    setHidden(false); document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    one(); two();
    await act(async () => { await vi.advanceTimersByTimeAsync(AGENTS_POLL_MS * 2); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ignores abandoned responses and restarts after an in-flight unmount", async () => {
    setHidden(false);
    let resolveFirst!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(pending).mockResolvedValueOnce(response(snapshot({ revision: 8 })));
    const store = new AgentsStore(filters);
    const stop = store.subscribe(vi.fn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
    const restarted = store.subscribe(vi.fn());
    resolveFirst(response(snapshot({ revision: 99 })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().data?.revision).toBe(8);
    restarted();
  });

  it("aborts a stalled poll and exposes unavailable without fabricated data", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const store = new AgentsStore(filters);
    const request = store.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    await request;
    expect(store.getSnapshot()).toMatchObject({ data: null, loading: false, refreshing: false, connected: false });
  });
});
