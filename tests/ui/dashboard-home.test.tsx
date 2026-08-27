import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "../../app/HomeDashboard";
import type { HomeSnapshot } from "../../shared/monitor-contract";

function response(body: object, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const snapshot = {
  generatedAt: "2026-08-23T12:00:00.000Z",
  providerLimits: [{
    provider: "claude",
    source: "Claude Code",
    usageLimits: { available: true, fetchedAt: "2026-08-23T11:58:00.000Z", attemptedAt: "2026-08-23T11:58:00.000Z", limits: [{ id: "current-session", label: "Current session", window: "5 hours", percent: 31, resetsAt: "2026-08-23T15:00:00.000Z", severity: "normal", active: false }] },
  }, {
    provider: "codex",
    source: "Codex",
    usageLimits: { available: true, fetchedAt: "2026-08-23T11:59:00.000Z", attemptedAt: "2026-08-23T11:59:00.000Z", limits: [{ id: "codex-secondary", label: "Codex", window: "7 days", percent: 82, resetsAt: "2026-08-29T12:00:00.000Z", severity: "warning", active: false }] },
  }],
  limitActivities: [{
    provider: "claude",
    source: "Claude Code",
    limitId: "current-session",
    label: "Current session",
    window: "5 hours",
    percent: 31,
    resetsAt: "2026-08-23T15:00:00.000Z",
    windowStartsAt: "2026-08-23T09:00:00.000Z",
    windowStartsAtExact: true,
    generatedAt: "2026-08-23T12:00:00.000Z",
    observedFrom: "2026-08-23T11:30:00.000Z",
    firstRejectedAt: "2026-08-23T11:30:00.000Z",
    status: "ready",
    partialCoverage: true,
    eventsTruncated: false,
    observations: [
      { observedAt: "2026-08-23T11:30:00.000Z", percent: 18 },
      { observedAt: "2026-08-23T12:00:00.000Z", percent: 31 },
    ],
    sessions: [{
      id: "claude:pomegr-home",
      title: "Pomegr home",
      project: "pomegr",
      isLive: true,
      requestObservations: [{ id: "request-live", observedAt: "2026-08-23T11:30:00.000Z" }],
    }, {
      id: "claude:pomegr-closed",
      title: "Pomegr closed work",
      project: "pomegr",
      isLive: false,
      requestObservations: [{ id: "request-same-project", observedAt: "2026-08-23T11:40:00.000Z" }],
    }, {
      id: "claude:closed.other-repo",
      title: "Review report",
      project: "other-repo",
      isLive: false,
      requestObservations: [{ id: "request-closed", observedAt: "2026-08-23T11:45:00.000Z" }],
    }],
    movements: [{
      id: "movement-1",
      from: "2026-08-23T11:30:00.000Z",
      to: "2026-08-23T12:00:00.000Z",
      changePoints: 13,
      correlation: "single",
      sessionIds: ["claude:pomegr-home"],
    }],
  }, {
    provider: "codex",
    source: "Codex",
    limitId: "codex-secondary",
    label: "Codex",
    window: "7 days",
    percent: 82,
    resetsAt: "2026-08-29T12:00:00.000Z",
    windowStartsAt: "2026-08-22T12:00:00.000Z",
    windowStartsAtExact: true,
    generatedAt: "2026-08-23T12:00:00.000Z",
    observedFrom: "2026-08-22T12:00:00.000Z",
    firstRejectedAt: null,
    status: "ready",
    partialCoverage: false,
    eventsTruncated: false,
    observations: [
      { observedAt: "2026-08-22T12:00:00.000Z", percent: 72 },
      { observedAt: "2026-08-23T12:00:00.000Z", percent: 82 },
    ],
    sessions: [{
      id: "codex:live.one_2",
      title: "Build home",
      project: "pomegr",
      isLive: true,
      requestObservations: [{ id: "request-codex", observedAt: "2026-08-23T11:50:00.000Z" }],
    }],
    movements: [],
  }],
  projects: [{
    project: "pomegr",
    updatedAt: "2026-08-23T12:00:00.000Z",
    liveCount: 1,
    sessions: [{
      id: "codex:live.one_2",
      provider: "codex",
      source: "Codex",
      title: "Build home",
      project: "pomegr",
      updatedAt: "2026-08-23T12:00:00.000Z",
      needsInput: false,
      agentCount: 2,
      activeAgentCount: 1,
      latestContextTotal: 12000,
      progress: { phase: "implementing", percent: 42, remainingMinutesMin: 3, remainingMinutesMax: 6, confidence: "medium", reportedAt: "2026-08-23T11:59:00.000Z" },
      contextHistory: { bucketMs: 60_000, buckets: [{ start: "2026-08-23T11:58:00.000Z", end: "2026-08-23T11:59:00.000Z", total: 5000, agents: [] }, { start: "2026-08-23T11:59:00.000Z", end: "2026-08-23T12:00:00.000Z", total: 12000, agents: [] }], boundaries: [] },
      resources: { status: "ready", reason: null, current: { cpuCores: 1, cpuMachinePercent: 42, memoryBytes: 64 * 1024 * 1024, readBytesPerSecond: 0, writeBytesPerSecond: 0 }, observedPeak: { memoryBytes: 64 * 1024 * 1024 }, samples: [{ timestamp: "2026-08-23T11:58:00.000Z", cpuCores: 1, cpuMachinePercent: 20, memoryBytes: 32 * 1024 * 1024, readBytesPerSecond: 0, writeBytesPerSecond: 0 }, { timestamp: "2026-08-23T12:00:00.000Z", cpuCores: 1, cpuMachinePercent: 42, memoryBytes: 64 * 1024 * 1024, readBytesPerSecond: 0, writeBytesPerSecond: 0 }] },
    }],
    history: { windowDays: 7, completed: 3, medianWallTimeMs: 300_000, medianFinalContext: 8000, finalContexts: [{ endedAt: "2026-08-22T11:00:00.000Z", total: 7000 }, { endedAt: "2026-08-23T10:00:00.000Z", total: 9000 }] },
  }, {
    project: "other-repo",
    updatedAt: "2026-08-23T11:57:00.000Z",
    liveCount: 2,
    sessions: [{
      id: "claude:live.two_3",
      provider: "claude",
      source: "Claude Code",
      title: "Review report",
      project: "other-repo",
      updatedAt: "2026-08-23T11:57:00.000Z",
      needsInput: true,
      agentCount: 1,
      activeAgentCount: 1,
      latestContextTotal: 8000,
      contextHistory: null,
      progress: null,
      resources: { status: "ready", reason: null, current: null, observedPeak: null, samples: [] },
    }, {
      id: "codex:blocked.three_4",
      provider: "codex",
      source: "Codex",
      title: "Waiting on input",
      project: "other-repo",
      updatedAt: "2026-08-23T11:55:00.000Z",
      needsInput: false,
      agentCount: 1,
      activeAgentCount: 1,
      latestContextTotal: 4000,
      contextHistory: null,
      progress: { phase: "blocked", percent: 68, remainingMinutesMin: 2, remainingMinutesMax: 4, confidence: "low", reportedAt: "2026-08-23T11:55:00.000Z" },
      resources: { status: "ready", reason: null, current: null, observedPeak: null, samples: [] },
    }],
    history: { windowDays: 7, completed: 0, medianWallTimeMs: null, medianFinalContext: null, finalContexts: [] },
  }],
} satisfies HomeSnapshot;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("home dashboard", () => {
  it("shows one quiet cross-project session grid with bounded progress details", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(snapshot));
    const { container } = render(<HomeDashboard />);

    expect(await screen.findByRole("heading", { name: "Running sessions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Running now" })).toBeInTheDocument();
    expect(container.querySelectorAll(".homeSessionCard")).toHaveLength(3);
    expect(container.querySelector(".homeSessionGrid")).toBeInTheDocument();
    expect(screen.getAllByText("pomegr").length).toBeGreaterThan(0);
    expect(screen.getAllByText("other-repo").length).toBeGreaterThan(0);
    expect(screen.getAllByText("implementing")).toHaveLength(1);
    expect(screen.getByText("ETA 3–6 min")).toBeInTheDocument();
    expect(screen.queryByText("ETA 2–4 min")).not.toBeInTheDocument();
    expect(container.querySelectorAll('progress[aria-label="Agent-reported session progress"]')).toHaveLength(2);
    expect(container.querySelector('a[aria-label="Open Review report · other-repo · Claude Code"]')?.closest(".homeSessionCard")?.querySelector(".homeSessionProgress")).not.toBeInTheDocument();
    expect(container.querySelector(".homeFolio")).not.toBeInTheDocument();
    expect(screen.queryByText("Resource use · live samples")).not.toBeInTheDocument();
  });

  it("joins usage limits and provider-local limit activity", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(snapshot));
    const { container } = render(<HomeDashboard />);
    expect(await screen.findByRole("heading", { name: "Running sessions" })).toBeInTheDocument();
    expect(screen.getByText("Build home")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Usage & activity" })).toBeInTheDocument();
    expect(container.querySelectorAll(".homeProviderLimit")).toHaveLength(2);
    expect(container.querySelector('.homeLimitRow[aria-label="Current session, 5 hours, 31% used"]')).toBeInTheDocument();
    expect(container.querySelector('.homeLimitRow.warning[aria-label="Codex, 7 days, 82% used"]')).toBeInTheDocument();
    expect(container.querySelector('a[href="/sessions/codex-live.one_2"]')).toBeInTheDocument();

    const limits = container.querySelector(".homeLimits");
    const activity = container.querySelector(".homeLimitActivity");
    const folio = container.querySelector(".homeFolio");
    expect(limits).toBeInTheDocument();
    expect(activity).not.toBeInTheDocument();
    expect(folio).not.toBeInTheDocument();
    expect(limits).not.toHaveTextContent("18 → 31% observed");
    expect(limits).not.toHaveTextContent("72 → 82% observed");
    expect(limits!.querySelectorAll(".homeLimitRequestTicks")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Local request timing for Current session, 5 hours: 3 request observations across 2 projects." })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Local request timing for Codex, 7 days: 1 request observation across 1 project." })).toBeInTheDocument();
    expect(limits!.querySelector(".homeLimitActivityTimeline, .homeLimitActivityScale")).not.toBeInTheDocument();
    expect(limits!.querySelector('[title^="pomegr · request observed at"]')).toBeInTheDocument();
    expect(limits!.querySelector('[title^="other-repo · request observed at"]')).toBeInTheDocument();
    expect(limits!.querySelector(".homeLimitsNote")).not.toBeInTheDocument();

    const claudeProjects = screen.getByText("2 projects").closest("details");
    expect(claudeProjects).not.toHaveAttribute("open");
    fireEvent.click(claudeProjects!.querySelector("summary")!);
    expect(claudeProjects).toHaveAttribute("open");
    expect(within(claudeProjects!).getByText("pomegr")).toBeInTheDocument();
    expect(within(claudeProjects!).getByText("2 requests · 66.7% of observed requests")).toBeInTheDocument();
    expect(within(claudeProjects!).getByText("other-repo")).toBeInTheDocument();
    expect(within(claudeProjects!).getByText("1 request · 33.3% of observed requests")).toBeInTheDocument();
    expect(within(claudeProjects!).getByText("correlation evidence, not attribution or billing", { exact: false })).toBeInTheDocument();

    const codexProjects = screen.getByText("1 project").closest("details");
    expect(within(codexProjects!).getByText("1 request · 100% of observed requests")).toBeInTheDocument();
  });

  it("keeps request timing independent from quota percentage and omits the duplicate scale", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      limitActivities: snapshot.limitActivities.map((activity) => ({
        ...activity,
        percent: 100,
        observations: [...activity.observations, { observedAt: "2026-08-23T12:05:00.000Z", percent: 100 }],
      })),
    }));
    const { container } = render(<HomeDashboard />);
    await screen.findByRole("heading", { name: "Usage & activity" });
    const claudeTicks = screen.getByRole("img", { name: /Local request timing for Current session, 5 hours/ });
    expect(claudeTicks.querySelectorAll("b")).toHaveLength(3);
    const positions = [...claudeTicks.querySelectorAll("b")].map((tick) => parseFloat((tick as HTMLElement).style.left));
    expect(Math.min(...positions)).toBeCloseTo(41.7, 1);
    expect(container.querySelector(".homeLimitActivityScale")).not.toBeInTheDocument();
  });

  it("falls back to the observed interval when the provider omits resetsAt", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      limitActivities: snapshot.limitActivities.map((activity) => ({ ...activity, resetsAt: null, windowStartsAtExact: true })),
    }));
    render(<HomeDashboard />);
    await screen.findByRole("heading", { name: "Usage & activity" });
    const claudeTicks = screen.getByRole("img", { name: /Local request timing for Current session, 5 hours/ });
    const positions = [...claudeTicks.querySelectorAll("b")].map((tick) => parseFloat((tick as HTMLElement).style.left));
    expect(Math.min(...positions)).toBeCloseTo(83.3, 1);
  });

  it("positions Codex request ticks across the selected seven-day reset window", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(snapshot));
    render(<HomeDashboard />);
    await screen.findByRole("heading", { name: "Usage & activity" });
    const codexTicks = screen.getByRole("img", { name: /Local request timing for Codex, 7 days/ });
    expect(parseFloat((codexTicks.querySelector("b") as HTMLElement).style.left)).toBeCloseTo(14.2, 1);
  });

  it("keeps live cards available while recorded history warms", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      projects: snapshot.projects.map((project) => ({ ...project, history: { ...project.history, status: "loading" as const } })),
    }));
    render(<HomeDashboard />);
    expect(await screen.findByText("Build home")).toBeInTheDocument();
    expect(screen.queryByText("Loading recorded sessions…")).not.toBeInTheDocument();
    expect(screen.queryByText("median wall time")).not.toBeInTheDocument();
  });

  it("flags retained Claude limits when the provider needs sign-in", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      projects: [],
      limitActivities: [],
      providerLimits: [{
        ...snapshot.providerLimits[0],
        usageLimits: { ...snapshot.providerLimits[0].usageLimits, error: "Anthropic usage endpoint returned 401" },
      }],
    }));
    render(<HomeDashboard />);
    expect(await screen.findByText("Sign-in needed")).toBeInTheDocument();
    expect(screen.getByText("31%")).toBeInTheDocument();
  });

  it("keeps resource telemetry quiet on the home surface", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(snapshot));
    const { container } = render(<HomeDashboard />);
    await screen.findByRole("heading", { name: "Running sessions" });
    expect(container.querySelector(".homeChartLine, .homeChartCpu, .homeChartMemory")).not.toBeInTheDocument();
    expect(screen.queryByText("Resource use · live samples")).not.toBeInTheDocument();
    expect(screen.queryByText("42% · 64 MB")).not.toBeInTheDocument();
  });

  it("shows no-live and offline states without hanging polling", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ generatedAt: "2026-08-23T12:00:00.000Z", providerLimits: [], limitActivities: [], projects: [] }));
    render(<HomeDashboard />);
    expect(await screen.findByText("No running sessions yet.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/home", expect.objectContaining({ cache: "no-store" }));

    fetchMock.mockImplementation(() => response({}, 503));
    render(<HomeDashboard />);
    expect(await screen.findByText("Home overview is unavailable. Pomegr will reconnect automatically.")).toBeInTheDocument();
  });
});
