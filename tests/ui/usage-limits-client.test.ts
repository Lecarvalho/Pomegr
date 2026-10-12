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

it("sign-in refresh waits for a stale in-flight poll and reads the newly committed revision", async () => {
  let finishPoll!: (response: Response) => void;
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockReturnValueOnce(new Promise<Response>((resolve) => { finishPoll = resolve; }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, revision: 8,
      readiness: { claude: "ready", codex: "ready" },
      providers: [{ ...snapshot.providers[0], readiness: "ready", usageLimits: {
        available: true, fetchedAt: "2026-10-12T18:00:00.000Z", attemptedAt: "2026-10-12T18:00:00.000Z",
        failureKind: null, limits: [{ id: "codex-primary", percent: 25 }],
      } }],
    }), { status: 200 }));
  const store = new UsageLimitsStore();
  const poll = store.refresh();
  const recovery = store.refreshAfterSignIn();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  finishPoll(new Response(JSON.stringify(snapshot), { status: 200 }));
  await poll;
  expect(await recovery).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][0]).toBe("/api/usage-limits?revision=7");
  expect(store.getSnapshot().revision).toBe(8);
  expect(store.getSnapshot().providers[0].usageLimits.available).toBe(true);
});
