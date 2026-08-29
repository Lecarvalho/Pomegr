import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAgentRowWallTime, formatAgentWallTime, formatExecutionTaskWallTime, formatWallTime, liveWallTimeMs } from "../../app/formatting.mjs";
import { proxyMonitorEventStream, proxyMonitorJson } from "../../app/api/monitor-proxy";
import { agentsWithFinishedVisibility, agentTreeRows, coarseRelativeTime, minuteRelativeTime, newestSessionsFirst, relativeTime, resetCountdown, sessionNeedingAttention, sessionRelativeTime } from "../../app/dashboard-utils";
import type { Agent, SessionSummary } from "../../shared/monitor-contract";
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
    expect(formatAgentRowWallTime({ startedAt: "2026-08-08T12:00:00.000Z", status: "active", durationMs: 1_000 }, Date.parse("2026-08-08T12:00:05.000Z"))).toBe("<1m");
    expect(formatAgentRowWallTime({ startedAt: "2026-08-08T12:00:00.000Z", status: "active", durationMs: 1_000 }, Date.parse("2026-08-08T12:01:05.000Z"))).toBe("1m");
    expect(formatExecutionTaskWallTime({ startedAt: "2026-08-08T12:00:00.000Z", finishedAt: "2026-08-08T12:00:07.000Z" })).toBe("7s");
    expect(liveWallTimeMs(1_000, "2026-08-08T12:00:00.000Z", true, Date.parse("2026-08-08T12:00:05.000Z"))).toBe(5_000);
    expect(liveWallTimeMs(1_000, "2026-08-08T12:00:00.000Z", false, Date.parse("2026-08-08T12:00:05.000Z"))).toBe(1_000);
    expect(liveWallTimeMs(1_000, null, true, Date.parse("2026-08-08T12:00:05.000Z"))).toBe(1_000);
    expect(relativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:00:12.000Z"))).toBe("<1m ago");
    expect(minuteRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:00:05.000Z"))).toBe("just now");
    expect(minuteRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:00:30.000Z"))).toBe("less than a minute ago");
    expect(minuteRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:01:00.000Z"))).toBe("1 minute ago");
    expect(minuteRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:03:00.000Z"))).toBe("3 minutes ago");
    expect(coarseRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:00:30.000Z"))).toBe("just now");
    expect(coarseRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:03:00.000Z"))).toBe("3m ago");
    expect(coarseRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T14:03:00.000Z"))).toBe("2h ago");
    expect(sessionRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:00:05.000Z"))).toBe("just now");
    expect(sessionRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:00:30.000Z"))).toBe("<1m");
    expect(sessionRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T12:03:00.000Z"))).toBe("3m ago");
    expect(sessionRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-08T14:03:00.000Z"))).toBe("2h ago");
    expect(sessionRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-08-11T12:00:00.000Z"))).toBe("3d ago");
    expect(sessionRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2026-10-07T12:00:00.000Z"))).toBe("2mo ago");
    expect(sessionRelativeTime("2026-08-08T12:00:00.000Z", Date.parse("2028-08-07T12:00:00.000Z"))).toBe("2y ago");
    expect(resetCountdown("2026-08-08T12:02:00.000Z", Date.parse("2026-08-08T12:01:00.000Z"))).toBe("Resets in 1m");
  });

  it("never counts seconds in relative timestamps", () => {
    const timestamp = "2026-08-08T12:00:00.000Z";
    const now = Date.parse("2026-08-08T12:00:30.000Z");
    const labels = [
      relativeTime(timestamp, now),
      minuteRelativeTime(timestamp, now),
      coarseRelativeTime(timestamp, now),
      sessionRelativeTime(timestamp, now),
    ];

    expect(labels).toEqual(["<1m ago", "less than a minute ago", "just now", "<1m"]);
    expect(labels.join(" ")).not.toMatch(/\b\d+s(?:econds?)?\b/i);
  });
});

describe("session attention", () => {
  const sessions: SessionSummary[] = [
    { id: "waiting", provider: "claude", source: "Claude Code", title: "Waiting session", project: "Pomegr", updatedAt: "2026-08-10T12:00:00.000Z", isLive: true, needsInput: true, activityStatus: "needs_input" },
    { id: "working", provider: "claude", source: "Claude Code", title: "Working session", project: "Pomegr", updatedAt: "2026-08-10T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working" },
  ];

  it("shows attention only while viewing the live session that needs input", () => {
    expect(sessionNeedingAttention(sessions, "waiting", false)).toEqual(sessions[0]);
    expect(sessionNeedingAttention(sessions, "working", false)).toBeNull();
    expect(sessionNeedingAttention(sessions, "waiting", true)).toBeNull();
  });
});

describe("session catalog order", () => {
  const session = (id: string, createdAt: string, updatedAt = createdAt): SessionSummary => ({
    id,
    provider: "claude",
    source: "Claude Code",
    title: id,
    project: "Pomegr",
    createdAt,
    updatedAt,
    isLive: true,
    needsInput: false,
    activityStatus: "working",
  });

  it("orders rows by creation time descending without letting later activity move them", () => {
    const ordered = newestSessionsFirst([
      session("older-active", "2026-08-11T12:00:00.000Z", "2026-08-11T12:05:00.000Z"),
      session("newest", "2026-08-11T12:03:00.000Z"),
      session("middle", "2026-08-11T12:01:00.000Z", "2026-08-11T12:04:00.000Z"),
    ]);

    expect(ordered.map(({ id }) => id)).toEqual(["newest", "middle", "older-active"]);
  });
});

describe("agent tree order", () => {
  const agent = (id: string, parentId: string | null, startedAt: string): Agent => ({
    id,
    parentId,
    workflowId: null,
    workflowPhaseId: null,
    workflowOrder: null,
    workflowState: null,
    label: id,
    role: id === "primary" ? "orchestrator" : "unknown",
    model: "test-model",
    effort: "high",
    status: "active",
    signal: null,
    toolCalls: 0,
    skills: [],
    executionTasks: [],
    lastSeen: startedAt,
    startedAt,
    updatedAt: startedAt,
    durationMs: 0,
    cacheLifetime: null,
    tokens: { total: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  });

  it("keeps parents attached and sorts siblings newest-created first regardless of API order", () => {
    const agents = [
      agent("older", "primary", "2026-08-11T12:01:00.000Z"),
      agent("nested", "newer", "2026-08-11T12:04:00.000Z"),
      agent("primary", null, "2026-08-11T12:00:00.000Z"),
      agent("newer", "primary", "2026-08-11T12:03:00.000Z"),
      agent("middle", "primary", "2026-08-11T12:02:00.000Z"),
    ];

    const expected = ["primary", "newer", "nested", "middle", "older"];
    expect(agentTreeRows(agents).map(({ agent: row }) => row.id)).toEqual(expected);
    expect(agentTreeRows([...agents].reverse()).map(({ agent: row }) => row.id)).toEqual(expected);
  });

  it("hides terminal subagents while retaining terminal ancestors of visible work", () => {
    const agents = [
      agent("primary", null, "2026-08-11T12:00:00.000Z"),
      { ...agent("finished-parent", "primary", "2026-08-11T12:01:00.000Z"), status: "finished" as const },
      agent("active-child", "finished-parent", "2026-08-11T12:02:00.000Z"),
      { ...agent("finished-leaf", "primary", "2026-08-11T12:03:00.000Z"), status: "finished" as const },
      { ...agent("stopped-leaf", "primary", "2026-08-11T12:04:00.000Z"), status: "stopped" as const },
    ];

    expect(agentsWithFinishedVisibility(agents, true)).toBe(agents);
    expect(agentsWithFinishedVisibility(agents, false).map(({ id }) => id)).toEqual([
      "primary",
      "finished-parent",
      "active-child",
    ]);
  });
});

describe("monitor proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

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
    const response = await proxyMonitorJson({ path: "/api/sessions", timeoutMs: 1500, unavailableBody: { sessions: [], liveSessions: [], error: "Monitor unavailable" } });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ sessions: [], liveSessions: [], error: "Monitor unavailable" });
    expect(body.sessions).toEqual([]);
    expect(body.liveSessions).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("secret detail");
  });

  it("never proxies an ambient non-loopback monitor origin", async () => {
    vi.stubEnv("POMEGR_MONITOR_ORIGIN", "https://private.example.invalid:8443/metadata");
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await proxyMonitorJson({ path: "/api/sessions", timeoutMs: 4000, unavailableBody: {} });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:4317/api/sessions");
  });

  it("streams only the monitor event body through the loopback proxy", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: catalog\ndata: {"domain":"sessions","revision":3}\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyMonitorEventStream();
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:4317/api/events");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('event: catalog\ndata: {"domain":"sessions","revision":3}\n\n');
  });
});
