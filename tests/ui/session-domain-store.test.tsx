import { act, render, renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>(), subscriptions: 0 }));
vi.mock("../../app/live-events", () => ({
  subscribeLiveEvents: (listener: (event: unknown) => void) => { live.subscriptions += 1; live.listeners.add(listener); return () => live.listeners.delete(listener); },
}));

import { resetSessionDomainStoreForTests, sessionDomainStoreDiagnosticsForTests, useSessionDomain } from "../../app/session-domain-store";

function domain(domain = "session-summary", sessionId = "claude:s1", revision = 1, extra = {}) {
  return { domain, sessionId, revision, readiness: "ready", observedAt: "2026-09-14T12:00:00.000Z", ...extra };
}
function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function emit(event: unknown) { for (const listener of live.listeners) listener(event); }

describe("session domain browser store", () => {
  beforeEach(() => { resetSessionDomainStoreForTests(); live.listeners.clear(); live.subscriptions = 0; vi.restoreAllMocks(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });
  afterEach(() => { vi.useRealTimers(); resetSessionDomainStoreForTests(); vi.restoreAllMocks(); });

  it("sends a revision only after retaining the exact query body and keeps it on 204", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(domain())).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(1));
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("revision=");
    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain("revision=1");
    expect(hook.result.current.data?.revision).toBe(1);
    hook.unmount();
  });

  it("shares one live-event subscription across mounted exact queries", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).includes("domain=agents") ? json(domain("agents", "claude:s1", 1, { agents: [], workflows: [] })) : json(domain()));
    const first = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    const second = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "agents" }, { historical: true }));
    await waitFor(() => expect(second.result.current.data?.domain).toBe("agents"));
    expect(live.subscriptions).toBe(1);
    first.unmount(); second.unmount();
  });

  it("does not periodically poll historical queries but revalidates matching events", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(domain()));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(120_000); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { emit({ type: "revision", domain: "session-summary", sessionId: "claude:s1", revision: 2, epoch: 1 }); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("retries a failed historical refresh after five seconds and clears the error once it resolves", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(json(domain()));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hook.result.current.error).toMatch(/temporarily unavailable/);
    await act(async () => { vi.advanceTimersByTime(4_999); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.data?.revision).toBe(1);
    hook.unmount();
  });

  it("revalidates a historical entry when the event for its failed revision is replayed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 1)))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 2)));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(1));
    act(() => emit({ type: "revision", domain: "session-summary", sessionId: "claude:s1", revision: 2, epoch: 1 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.error).toMatch(/temporarily unavailable/));
    // The failed refresh must clear the pending invalidated revision, so a replayed event for
    // the same revision still triggers a refresh instead of being skipped as already-pending.
    act(() => emit({ type: "revision", domain: "session-summary", sessionId: "claude:s1", revision: 2, epoch: 1 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(2));
    hook.unmount();
  });

  it("coalesces a hidden live invalidation until the hidden fallback", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(domain()));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: false }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => emit({ type: "revision", domain: "session-summary", sessionId: "claude:s1", revision: 2, epoch: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("coalesces an invalidation received during an active request", async () => {
    let finish!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { finish = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(first).mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 2)));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    act(() => emit({ type: "revision", domain: "session-summary", sessionId: "claude:s1", revision: 2, epoch: 1 }));
    await act(async () => finish(json(domain())));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    hook.unmount();
  });

  it("aborts an unmounted request and starts a clean remount", async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => { signals.push(init!.signal as AbortSignal); return new Promise(() => {}); });
    const first = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    first.unmount();
    expect(signals[0].aborted).toBe(true);
    const second = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    expect(signals).toHaveLength(2);
    second.unmount();
  });

  it("prunes an old still-mounted session after its later cleanup", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => { const id = new URL(String(input), "http://local").searchParams.get("sessionId")!; return json(domain("session-summary", id)); });
    const hooks = ["s1", "s2", "s3", "s4"].map((id) => renderHook(() => useSessionDomain({ sessionId: `claude:${id}`, domain: "session-summary" }, { historical: true })));
    await waitFor(() => expect(sessionDomainStoreDiagnosticsForTests().keys).toHaveLength(4));
    hooks[0].unmount();
    expect(sessionDomainStoreDiagnosticsForTests().keys.some((key) => key.startsWith("claude:s1|"))).toBe(false);
    hooks.slice(1).forEach((hook) => hook.unmount());
  });

  it("rejects a mismatched selected-agent response without retaining its revision", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(domain("agent", "claude:s1", 4, { agentId: "other", agent: null })));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "agent", agentId: "wanted" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.error).toMatch(/temporarily unavailable/));
    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("revision=");
    hook.unmount();
  });

  it("does not retain module-global entries during server rendering", () => {
    vi.stubGlobal("window", undefined);
    function ServerProbe() { useSessionDomain({ sessionId: "claude:ssr", domain: "session-summary" }, { historical: true }); return null; }
    expect(renderToString(<ServerProbe />)).toBe("");
    expect(sessionDomainStoreDiagnosticsForTests().keys).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("sets an error and keeps data null when a 204 arrives without a retained body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.error).toMatch(/temporarily unavailable/));
    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.connected).toBe(false);
    hook.unmount();
  });

  it("keeps ready retained data when a later response regresses to a loading, revision-0 envelope", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 5)))
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 0, { readiness: "loading", observedAt: null })));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(5));
    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(hook.result.current.data?.revision).toBe(5);
    expect(hook.result.current.data?.readiness).toBe("ready");
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.error).toBeNull();
    hook.unmount();
  });

  it("keeps ready retained data when a later response reports a lower revision", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 9)))
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 3)));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(9));
    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(hook.result.current.data?.revision).toBe(9);
    hook.unmount();
  });

  it("still rejects a lower revision within the same epoch even after the connection cycles", async () => {
    // A same-state connection event (still "reconnecting") carries the same epoch: it must not
    // by itself excuse a regression, only an epoch change may.
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 76105)))
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 5)));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(76105));
    // Epoch 0 is the store's untouched default: this event changes connection *state* without
    // changing the epoch, so it must not excuse the regression below.
    act(() => emit({ type: "connection", state: "reconnecting", epoch: 0 }));
    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(hook.result.current.data?.revision).toBe(76105);
    hook.unmount();
  });

  it("keeps retained ready data through a new epoch's loading rebuild, then accepts the new epoch's first ready body even with a lower revision", async () => {
    // Simulates a monitor restart: the store's own regression guard must not freeze the page,
    // the way a fresh monitor process's revision clocks restarting at 0 otherwise would.
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 76105)))
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 0, { readiness: "loading", observedAt: null })))
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 5)))
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 3)));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(76105));

    // The live-event epoch advances (a restart or a reconnect that proves a new monitor process).
    act(() => emit({ type: "connection", state: "reconnecting", epoch: 2 }));
    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The new epoch's still-loading rebuild does not erase the retained ready body.
    expect(hook.result.current.data?.revision).toBe(76105);
    expect(hook.result.current.data?.readiness).toBe("ready");
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.error).toBeNull();

    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    // The new epoch's first ready body is accepted even though its revision regressed.
    expect(hook.result.current.data?.revision).toBe(5);
    expect(hook.result.current.data?.readiness).toBe("ready");

    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    // Back within the (now current) epoch, the ordinary regression guard applies again.
    expect(hook.result.current.data?.revision).toBe(5);
    hook.unmount();
  });

  it("polls at the fast one-second cadence, not the slow steady-state one, while a monitor-restart rebuild is still in flight", async () => {
    // Regression test: after a monitor restart the stream reconnects at a new epoch and the
    // domain's first rebuilt response is a "loading" envelope that must not regress the retained
    // ready data (see the epoch test above). That preserved-but-stale state must not be mistaken
    // for a resolved steady state either -- the entry has to keep polling every second until the
    // rebuild actually completes, the same way it would if `entry.snapshot.data` had never been
    // set at all. Before the fix this fell back to the thirty-second cadence instead.
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 76105)))
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 0, { readiness: "loading", observedAt: null })))
      .mockResolvedValue(json(domain("session-summary", "claude:s1", 5)));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: false }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hook.result.current.data?.revision).toBe(76105);
    // The stream drops and reconnects at a new epoch, proving a new monitor process.
    act(() => emit({ type: "connection", state: "reconnecting", epoch: 2 }));
    act(() => emit({ type: "connection", state: "connected", epoch: 2 }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The rebuild-in-progress body is not committed: retained ready data is untouched.
    expect(hook.result.current.data?.revision).toBe(76105);
    expect(hook.result.current.data?.readiness).toBe("ready");
    await act(async () => { vi.advanceTimersByTime(999); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(hook.result.current.data?.revision).toBe(5);
    hook.unmount();
  });

  it("accepts a loading envelope while retained data is itself still loading", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 1, { readiness: "loading" })))
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 2, { readiness: "loading" })));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(1));
    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(hook.result.current.data?.revision).toBe(2);
    hook.unmount();
  });

  it("keeps retained data when a later request fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain()))
      .mockRejectedValueOnce(new Error("network"));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(1));
    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(hook.result.current.error).toMatch(/temporarily unavailable/));
    expect(hook.result.current.data?.revision).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("keeps the one-second cadence while retained data stays loading through 204 refreshes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 1, { readiness: "loading" })))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: false }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hook.result.current.data?.readiness).toBe("loading");
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    hook.unmount();
  });

  it("retries five seconds after a failed refresh", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(domain()))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(json(domain("session-summary", "claude:s1", 1)));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: false }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.revalidate());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hook.result.current.error).toMatch(/temporarily unavailable/);
    await act(async () => { vi.advanceTimersByTime(4_999); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    hook.unmount();
  });

  it("a reconnecting connection event schedules the next refresh five seconds out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(domain()));
    const hook = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: false }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A reconnecting event (re)schedules the pending refresh through the connection
    // branch of onLiveEvent, independent of the retained data's own readiness.
    act(() => emit({ type: "connection", state: "reconnecting" }));
    await act(async () => { vi.advanceTimersByTime(4_999); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("sends no revision for a freshly mounted session even with another session's retained body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const id = new URL(String(input), "http://local").searchParams.get("sessionId")!;
      return json(domain("session-summary", id, 1));
    });
    const first = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(first.result.current.data?.revision).toBe(1));
    const second = renderHook(() => useSessionDomain({ sessionId: "claude:s2", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(second.result.current.data?.revision).toBe(1));
    const secondCall = fetchMock.mock.calls.find(([input]) => String(input).includes("claude:s2"));
    expect(String(secondCall?.[0])).not.toContain("revision=");
    first.unmount(); second.unmount();
  });

  it("ignores a late response for an aborted refresh after unmount and remount", async () => {
    let resolveFirst!: (value: Response) => void;
    const firstPromise = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(json(domain("session-summary", "claude:s1", 5)));
    const first = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    first.unmount();
    const second = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(second.result.current.data?.revision).toBe(5));
    await act(async () => { resolveFirst(json(domain("session-summary", "claude:s1", 1))); await Promise.resolve(); await Promise.resolve(); });
    expect(second.result.current.data?.revision).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it("enabled:false subscribes nothing and fetches nothing, and disabling mid-flight aborts and clears timers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const disabled = renderHook(() => useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true, enabled: false }));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(live.subscriptions).toBe(0);
    disabled.unmount();

    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_input, init) => { signals.push(init!.signal as AbortSignal); return new Promise(() => {}); });
    const hook = renderHook(({ enabled }: { enabled: boolean }) => useSessionDomain({ sessionId: "claude:s2", domain: "session-summary" }, { historical: true, enabled }), { initialProps: { enabled: true } });
    await act(async () => { await Promise.resolve(); });
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    hook.rerender({ enabled: false });
    expect(signals[0].aborted).toBe(true);
    hook.unmount();
  });

  it("keeps a key-swapped session's entry registered so a live revision event refetches it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const id = new URL(String(input), "http://local").searchParams.get("sessionId")!;
      return json(domain("session-summary", id, 1));
    });
    function Probe({ sessionId }: { sessionId: string }) {
      useSessionDomain({ sessionId, domain: "session-summary" }, { historical: false });
      return null;
    }
    const { rerender, unmount } = render(<Probe key="claude:a" sessionId="claude:a" />);
    expect(sessionDomainStoreDiagnosticsForTests().keys).toContain("claude:a|session-summary|");
    // A keyed navigation unmounts the old consumer and mounts the new one in the same
    // commit: React runs the old consumer's unsubscribe cleanup (which prunes
    // unretained entries) before the new consumer's own subscribe effect runs.
    rerender(<Probe key="claude:d" sessionId="claude:d" />);
    expect(sessionDomainStoreDiagnosticsForTests().keys).toContain("claude:d|session-summary|");
    const before = fetchMock.mock.calls.length;
    act(() => emit({ type: "revision", domain: "session-summary", sessionId: "claude:d", revision: 2, epoch: 1 }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    unmount();
  });

  it("prunes an entry left behind by a render that creates it and then throws before committing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(domain()));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      render() { return this.state.failed ? null : this.props.children; }
    }
    function Bomb(): ReactNode {
      // Creates the entry (via useMemo, inside useSessionDomain) during render, then aborts the
      // render before it commits, so this component's own subscribe effect never runs and
      // `pendingSubscription` is never cleared -- the abandoned-render case the nit describes.
      useSessionDomain({ sessionId: "claude:doomed", domain: "session-summary" }, { historical: true });
      throw new Error("render aborted after the entry was created");
    }
    render(<Boundary><Bomb /></Boundary>);
    expect(sessionDomainStoreDiagnosticsForTests().keys).toContain("claude:doomed|session-summary|");

    // One ordinary, unrelated mount+unmount elsewhere produces the two prune passes needed to
    // age it out: the first (its mount, via touchSession) protects it exactly like the keyed-swap
    // case above; the second (its unmount cleanup) sees it is still unsubscribed and removes it.
    const other = renderHook(() => useSessionDomain({ sessionId: "claude:other", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(sessionDomainStoreDiagnosticsForTests().keys).toContain("claude:other|session-summary|"));
    other.unmount();

    expect(sessionDomainStoreDiagnosticsForTests().keys).not.toContain("claude:doomed|session-summary|");
    consoleError.mockRestore();
  });
});

describe("session domain browser store against the real live-event singleton", () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    private handlers = new Map<string, Set<(event: unknown) => void>>();
    constructor(readonly url: string) { FakeEventSource.instances.push(this); }
    addEventListener(type: string, listener: (event: unknown) => void) {
      const set = this.handlers.get(type) || new Set();
      set.add(listener);
      this.handlers.set(type, set);
    }
    open() { for (const listener of this.handlers.get("open") || []) listener(new Event("open")); }
    close() {}
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.doMock("../../app/live-events", () => ({
      subscribeLiveEvents: (listener: (event: unknown) => void) => { live.subscriptions += 1; live.listeners.add(listener); return () => live.listeners.delete(listener); },
    }));
    vi.resetModules();
    FakeEventSource.instances = [];
  });

  it("sends exactly one initial request when subscribing to an already-connected singleton", async () => {
    vi.doUnmock("../../app/live-events");
    vi.resetModules();
    vi.stubGlobal("EventSource", FakeEventSource);
    const liveEvents = await import("../../app/live-events");
    const store = await import("../../app/session-domain-store");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(domain()));
    // A pre-existing subscriber keeps the shared singleton connected before this
    // consumer's own subscribeLiveEvents call, matching the real app where
    // multiple consumers (AppShell, history-publications, this store) share it.
    const keepAlive = liveEvents.subscribeLiveEvents(() => {});
    FakeEventSource.instances[0]!.open();
    const hook = renderHook(() => store.useSessionDomain({ sessionId: "claude:s1", domain: "session-summary" }, { historical: true }));
    await waitFor(() => expect(hook.result.current.data?.revision).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    hook.unmount();
    keepAlive();
    store.resetSessionDomainStoreForTests();
  });
});
