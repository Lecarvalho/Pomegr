import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAgentWallTime, formatExecutionTaskWallTime, formatWallTime, liveWallTimeMs } from "../../app/formatting.mjs";
import { proxyMonitorJson } from "../../app/api/monitor-proxy";
import { minuteRelativeTime, relativeTime, resetCountdown, sessionNeedingAttention } from "../../app/dashboard-utils";
import type { SessionSummary } from "../../shared/monitor-contract";
import { createEmptyMonitorState, createEmptyUsageLimits } from "../../shared/monitor-state.mjs";

describe("shared monitor defaults", () => {
  it("creates fresh state and applies explicit safe overrides", () => {
    const first = createEmptyMonitorState();
    const second = createEmptyMonitorState({ connected: true, view: "history", error: "Unavailable" });
    first.agents.push({} as never);
    expect(second.agents).toEqual([]);
    expect(second).toMatchObject({ connected: true, view: "history", error: "Unavailable" });
    expect(createEmptyUsageLimits({ error: "No credentials" })).toMatchObject({ available: false, error: "No credentials" });
  });
});

describe("wall-time formatting", () => {
  it("shares stable hour, minute, and second formatting", () => {
    expect(formatWallTime(5_000)).toBe("5s");
    expect(formatWallTime(65_000)).toBe("1m 5s");
    expect(formatWallTime(3_665_000)).toBe("1h 1m");
    expect(formatAgentWallTime({ startedAt: "2026-08-08T12:00:00.000Z", status: "active", durationMs: 1_000 }, Date.parse("2026-08-08T12:00:05.000Z"))).toBe("5s");
    expect(formatExecutionTaskWallTime({ startedAt: "2026-08-08T12:00:00.000Z", finishedAt: "2026-08-08T12:00:07.000Z" })).toBe("7s");
    expect(liveWallTimeMs(1_000, "2026-08-08T12:00:00.000Z", true, Date.parse("2026-08-08T12:00:05.000Z"))).toBe(5_000);
    expect(liveWallTimeMs(1_000, "2026-08-08T12:00:00.000Z", false, Date.parse("2026-08-08T12:00:05.000Z"))).toBe(1_000);
    expect(liveWallTimeMs(1_000, null, true, Date.parse("2026-08-08T12:00:05.000Z"))).toBe(1_000);
    expect(relativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:00:12.000Z"))).toBe("12s ago");
    expect(minuteRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:00:05.000Z"))).toBe("just now");
    expect(minuteRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:00:30.000Z"))).toBe("less than a minute ago");
    expect(minuteRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:01:00.000Z"))).toBe("1 minute ago");
    expect(minuteRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:03:00.000Z"))).toBe("3 minutes ago");
    expect(resetCountdown("2026-08-08T12:02:00.000Z", Date.parse("2026-08-08T12:01:00.000Z"))).toBe("Resets in 1m");
  });
});

describe("session attention", () => {
  const sessions: SessionSummary[] = [
    { id: "waiting", title: "Waiting session", project: "Threadlight", updatedAt: "2026-08-10T12:00:00.000Z", isLive: true, needsInput: true },
    { id: "working", title: "Working session", project: "Threadlight", updatedAt: "2026-08-10T12:00:00.000Z", isLive: true, needsInput: false },
  ];

  it("shows attention only while viewing the live session that needs input", () => {
    expect(sessionNeedingAttention(sessions, "waiting", false)).toEqual(sessions[0]);
    expect(sessionNeedingAttention(sessions, "working", false)).toBeNull();
    expect(sessionNeedingAttention(sessions, "waiting", true)).toBeNull();
  });
});

describe("monitor proxy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards successful JSON with no-store headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxyMonitorJson({ path: "/api/sessions", timeoutMs: 4000, unavailableBody: {} });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:4317/api/sessions");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns the sanitized fallback when the monitor fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret detail")));
    const response = await proxyMonitorJson({ path: "/api/state", timeoutMs: 1500, unavailableBody: { connected: false, error: "Monitor unavailable" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ connected: false, error: "Monitor unavailable" });
  });
});
