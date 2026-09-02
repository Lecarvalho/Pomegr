import { afterEach, expect, it, vi } from "vitest";
import { UsageLimitsStore } from "../../app/usage-limits-client";

const snapshot = {
  revision: 7, generatedAt: "2026-09-02T12:00:00.000Z",
  readiness: { claude: "ready", codex: "unavailable" },
  providers: [{ provider: "codex", source: "Codex", readiness: "unavailable", usageLimits: {
    available: false, fetchedAt: null, attemptedAt: null, failureKind: "runtime_unavailable", limits: [],
  } }],
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("settles missing-runtime usage to the normal polling cadence and retains its revision on 204", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  const store = new UsageLimitsStore();
  const unsubscribe = store.subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().readiness.codex).toBe("unavailable");
    expect(store.getSnapshot().providers[0].usageLimits.failureKind).toBe("runtime_unavailable");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/usage-limits?revision=7");
    expect(store.getSnapshot().revision).toBe(7);
    expect(store.getSnapshot().readiness.codex).toBe("unavailable");
  } finally { unsubscribe(); }
});
