import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "../../app/HomeDashboard";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { HomeAggregateSnapshot, HomeSnapshot, LiveSessionSummary } from "../../shared/monitor-contract";

function response(body: object, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function pollResponse(body: object, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, json: async () => body } as Response);
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
    scope: "account",
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
    scope: "account",
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
      activityStatus: "working",
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
      activityStatus: "needs_input",
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
      activityStatus: "idle",
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

const liveSessions = snapshot.projects.flatMap((project) => project.sessions.map((session) => {
  const liveSession = { ...session, isLive: true };
  Reflect.deleteProperty(liveSession, "contextHistory");
  Reflect.deleteProperty(liveSession, "resources");
  return liveSession;
})) satisfies LiveSessionSummary[];

function homeAggregate(overrides: Partial<HomeAggregateSnapshot> = {}): HomeAggregateSnapshot {
  return {
    generatedAt: snapshot.generatedAt,
    providerLimits: snapshot.providerLimits,
    limitActivities: snapshot.limitActivities,
    ...overrides,
  };
}

function renderHome(live = liveSessions, lifecycle: { loading?: boolean; connected?: boolean } = {}) {
  return render(<SessionCatalogProvider sessions={[]} liveSessions={live} {...lifecycle}><HomeDashboard /></SessionCatalogProvider>);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("home dashboard", () => {
  it("shows one quiet cross-project session grid with bounded progress details", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate()));
    const { container } = renderHome();

    expect(await screen.findByRole("heading", { name: "Open sessions" })).toBeInTheDocument();
    const activeRegion = screen.getByRole("region", { name: "Active now" });
    const idleRegion = screen.getByRole("region", { name: "Open · Idle" });
    expect(within(activeRegion).getByText("Working now")).toBeInTheDocument();
    expect(within(activeRegion).getByText("Needs input")).toBeInTheDocument();
    expect(within(activeRegion).queryByText("Idle")).not.toBeInTheDocument();
    expect(within(idleRegion).getByText("Idle")).toBeInTheDocument();
    expect(container.querySelectorAll(".homeSessionCard")).toHaveLength(3);
    expect(container.querySelector(".homeSessionGrid")).toBeInTheDocument();
    expect(screen.getAllByText("pomegr").length).toBeGreaterThan(0);
    expect(screen.getAllByText("other-repo").length).toBeGreaterThan(0);
    expect(screen.getAllByText("implementing")).toHaveLength(1);
    expect(screen.getByText("ETA 3–6 min")).toBeInTheDocument();
    expect(screen.queryByText("ETA 2–4 min")).not.toBeInTheDocument();
    expect(container.querySelectorAll('progress[aria-label="Agent-reported session progress"]')).toHaveLength(2);
    expect(container.querySelector('a[aria-label="Open Review report · other-repo · Claude Code · Needs input"]')?.closest(".homeSessionCard")?.querySelector(".homeSessionProgress")).not.toBeInTheDocument();
    expect(container.querySelector(".homeFolio")).not.toBeInTheDocument();
    expect(screen.queryByText("Resource use · live samples")).not.toBeInTheDocument();
  });

  it("updates a live card from the shared catalog without another home response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate()));
    const view = renderHome();

    expect(await screen.findByRole("link", { name: "Open Build home · pomegr · Codex · Working now" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const updatedLiveSessions = liveSessions.map((session) => session.id === "codex:live.one_2"
      ? { ...session, activityStatus: "idle" as const, progress: { ...session.progress!, phase: "complete" as const, percent: 100 } }
      : session);
    view.rerender(<SessionCatalogProvider sessions={[]} liveSessions={updatedLiveSessions}><HomeDashboard /></SessionCatalogProvider>);

    expect(await screen.findByRole("link", { name: "Open Build home · pomegr · Codex · Idle" })).toBeInTheDocument();
    expect(screen.getByText("complete")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls aggregate usage on a 30-second cadence while catalog cards update immediately", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate()));
    const view = renderHome();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const updatedLiveSessions = liveSessions.map((session) => session.id === "codex:live.one_2"
      ? { ...session, activityStatus: "idle" as const, progress: { ...session.progress!, phase: "complete" as const, percent: 100 } }
      : session);
    view.rerender(<SessionCatalogProvider sessions={[]} liveSessions={updatedLiveSessions}><HomeDashboard /></SessionCatalogProvider>);
    expect(screen.getByRole("link", { name: "Open Build home · pomegr · Codex · Idle" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps live cards visible when aggregate usage polling fails", async () => {
    let resolveInitial!: (next: Response) => void;
    let scheduledPoll: (() => void) | null = null;
    const nativeSetTimeout = window.setTimeout;
    vi.spyOn(window, "setTimeout").mockImplementation(((handler, timeout, ...args) => {
      if (timeout === 30_000 && typeof handler === "function") {
        scheduledPoll = () => handler(...args);
        return 0;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveInitial = resolve; }))
      .mockImplementationOnce(() => pollResponse({}, 503));
    renderHome();
    resolveInitial(await pollResponse(homeAggregate()));
    expect(await screen.findByRole("heading", { name: "Usage & activity" })).toBeInTheDocument();

    await act(async () => { scheduledPoll?.(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link", { name: "Open Build home · pomegr · Codex · Working now" })).toBeInTheDocument();
    expect(screen.getByText("Usage and activity overview is unavailable. Pomegr will retry automatically.")).toBeInTheDocument();
    expect(screen.getByText("Monitor connected")).toBeInTheDocument();
  });

  it("joins usage limits and provider-local limit activity", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate()));
    const { container } = renderHome();
    expect(await screen.findByRole("heading", { name: "Open sessions" })).toBeInTheDocument();
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
    expect(screen.getByRole("img", { name: "Local session activity for Current session, 5 hours: 3 activity observations across 3 sessions and 2 projects." })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Local session activity for Codex, 7 days: 1 activity observation across 1 session and 1 project." })).toBeInTheDocument();
    expect(limits!.querySelector(".homeLimitActivityTimeline, .homeLimitActivityScale")).not.toBeInTheDocument();
    expect(limits!.querySelector('[title^="pomegr · session activity observed at"]')).toBeInTheDocument();
    expect(limits!.querySelector('[title^="other-repo · session activity observed at"]')).toBeInTheDocument();
    expect(limits!.querySelector(".homeLimitsNote")).not.toBeInTheDocument();

    const claudeProjects = screen.getByText("2 projects").closest("details");
    expect(claudeProjects).not.toHaveAttribute("open");
    fireEvent.click(claudeProjects!.querySelector("summary")!);
    expect(claudeProjects).toHaveAttribute("open");
    expect(within(claudeProjects!).getByText("pomegr")).toBeInTheDocument();
    expect(within(claudeProjects!).getByText("2 sessions")).toBeInTheDocument();
    expect(within(claudeProjects!).getByText("other-repo")).toBeInTheDocument();
    expect(within(claudeProjects!).getByText("1 session")).toBeInTheDocument();
    expect(within(claudeProjects!).queryByText(/\d+(?:\.\d+)?%/)).not.toBeInTheDocument();
    expect(within(claudeProjects!).getByText("correlation evidence, not attribution or billing", { exact: false })).toBeInTheDocument();
    expect(within(claudeProjects!).getByText("Coverage is partial: observations may begin after the window started.", { exact: false })).toBeInTheDocument();
    const codexProjects = screen.getByText("1 project").closest("details");
    expect(within(codexProjects!).getByText("1 session")).toBeInTheDocument();
  });

  it("shows the observed-project disclosure below Claude's seven-day all-models bar", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate({
      providerLimits: snapshot.providerLimits.map((entry, index) => index === 0
        ? {
            ...entry,
            usageLimits: {
              ...entry.usageLimits,
              limits: [
                ...entry.usageLimits.limits,
                { id: "all-models", label: "All models", window: "7 days", percent: 85, resetsAt: "2026-08-29T12:00:00.000Z", severity: "warning" as const, active: false },
              ],
            },
          }
        : entry),
      limitActivities: [
        ...snapshot.limitActivities,
        {
          ...snapshot.limitActivities[0],
          limitId: "all-models",
          label: "All models",
          window: "7 days",
          percent: 85,
          resetsAt: "2026-08-29T12:00:00.000Z",
          windowStartsAt: "2026-08-22T12:00:00.000Z",
          windowStartsAtExact: true,
          partialCoverage: false,
        },
      ],
    })));
    const { container } = renderHome();
    await screen.findByRole("heading", { name: "Usage & activity" });

    const weeklyRow = container.querySelector('.homeLimitRow.critical[aria-label="All models, 7 days, 85% used"]')!;
    const disclosure = weeklyRow.querySelector("details.homeLimitProjects")!;
    expect(disclosure).toBeInTheDocument();
    expect(disclosure.querySelector("summary")).toHaveAttribute("aria-label", "Show 2 projects observed during the 7 days window");
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(disclosure).toHaveAttribute("open");
    expect(within(disclosure).getByText("Observed project sessions")).toBeInTheDocument();
  });

  it("shows model-scoped request ticks and project activity below Fable's seven-day bar", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate({
      providerLimits: snapshot.providerLimits.map((entry, index) => index === 0
        ? {
            ...entry,
            usageLimits: {
              ...entry.usageLimits,
              limits: [
                ...entry.usageLimits.limits,
                { id: "model-fable", label: "Fable", window: "7 days", percent: 19, resetsAt: "2026-08-29T12:00:00.000Z", severity: "normal" as const, active: false },
              ],
            },
          }
        : entry),
      limitActivities: [
        ...snapshot.limitActivities,
        {
          ...snapshot.limitActivities[0],
          limitId: "model-fable",
          label: "Fable",
          window: "7 days",
          scope: "model" as const,
          percent: 19,
          resetsAt: "2026-08-29T12:00:00.000Z",
          windowStartsAt: "2026-08-22T12:00:00.000Z",
          windowStartsAtExact: true,
          partialCoverage: false,
        },
      ],
    })));
    const { container } = renderHome();
    await screen.findByRole("heading", { name: "Usage & activity" });

    const fableRow = container.querySelector('.homeLimitRow[aria-label="Fable, 7 days, 19% used"]')!;
    const ticks = within(fableRow).getByRole("img", { name: "Local request activity for Fable, 7 days: 3 request observations across 2 projects." });
    expect(ticks.querySelectorAll("b")).toHaveLength(3);
    expect(ticks.querySelector('[title^="pomegr · Fable request observed at"]')).toBeInTheDocument();
    expect(ticks.querySelector('[title^="other-repo · Fable request observed at"]')).toBeInTheDocument();

    const disclosure = fableRow.querySelector("details.homeLimitProjects")!;
    expect(disclosure.querySelector("summary")).toHaveTextContent("2 projects");
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(within(disclosure).getByText("Observed Fable activity")).toBeInTheDocument();
    expect(within(disclosure).getByText("2 requests")).toBeInTheDocument();
    expect(within(disclosure).getByText("1 request")).toBeInTheDocument();
    expect(within(disclosure).queryByText(/\d+(?:\.\d+)?%/)).not.toBeInTheDocument();
    expect(within(disclosure).getByText("Fable usage is account-level; request activity is correlation evidence, not attribution or billing.")).toBeInTheDocument();
    expect(within(disclosure).queryByText("Observed project sessions")).not.toBeInTheDocument();
  });

  it("does not surface the internal account-observation collection state", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate({
      limitActivities: snapshot.limitActivities.map((activity, index) => index === 0
        ? { ...activity, status: "collecting" as const }
        : activity),
    })));
    const { container } = renderHome();
    await screen.findByRole("heading", { name: "Usage & activity" });

    expect(screen.queryByText("Collecting account observations.")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Building activity baseline for Current session, 5 hours." })).not.toBeInTheDocument();
    expect(container.querySelector(".homeLimitCollecting")).not.toBeInTheDocument();
  });

  it("consolidates bounded coverage notices inside the project popover", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate({
      limitActivities: snapshot.limitActivities.map((activity, index) => index === 0
        ? { ...activity, partialCoverage: true, eventsTruncated: true }
        : activity),
    })));
    const { container } = renderHome();
    await screen.findByRole("heading", { name: "Usage & activity" });

    const claudeProjects = screen.getByText("2 projects").closest("details")!;
    const consolidatedNotice = "Usage is account-level; session activity is correlation evidence, not attribution or billing. Coverage is partial: observations may begin after the window started, and session activity evidence is bounded to a recent window.";
    expect(within(claudeProjects).getByText(consolidatedNotice)).toBeInTheDocument();
    expect(container.querySelector(".homeLimitActivityCoverage")).not.toBeInTheDocument();
  });

  it("scales session activity timing inside the filled usage width", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate()));
    const { container } = renderHome();
    await screen.findByRole("heading", { name: "Usage & activity" });
    const claudeTicks = screen.getByRole("img", { name: /Local session activity for Current session, 5 hours/ });
    expect(claudeTicks.querySelectorAll("b")).toHaveLength(3);
    expect(claudeTicks.querySelector(".homeLimitRequestTimeline")).toHaveStyle({ width: "31%" });
    const positions = [...claudeTicks.querySelectorAll("b")].map((tick) => parseFloat((tick as HTMLElement).style.left));
    expect(Math.min(...positions)).toBeCloseTo(83.3, 1);
    expect(Math.max(...positions)).toBeCloseTo(91.7, 1);
    expect(container.querySelector(".homeLimitActivityScale")).not.toBeInTheDocument();
  });

  it("keeps elapsed-window tick spacing when the provider omits resetsAt", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate({
      limitActivities: snapshot.limitActivities.map((activity) => ({ ...activity, resetsAt: null, windowStartsAtExact: true })),
    })));
    renderHome();
    await screen.findByRole("heading", { name: "Usage & activity" });
    const claudeTicks = screen.getByRole("img", { name: /Local session activity for Current session, 5 hours/ });
    const positions = [...claudeTicks.querySelectorAll("b")].map((tick) => parseFloat((tick as HTMLElement).style.left));
    expect(Math.min(...positions)).toBeCloseTo(83.3, 1);
  });

  it("positions Codex activity ticks across the elapsed part of its seven-day window", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate()));
    renderHome();
    await screen.findByRole("heading", { name: "Usage & activity" });
    const codexTicks = screen.getByRole("img", { name: /Local session activity for Codex, 7 days/ });
    expect(codexTicks.querySelector(".homeLimitRequestTimeline")).toHaveStyle({ width: "82%" });
    expect(parseFloat((codexTicks.querySelector("b") as HTMLElement).style.left)).toBeCloseTo(99.3, 1);
  });

  it("keeps live cards available while recorded history warms", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate()));
    renderHome();
    expect(await screen.findByText("Build home")).toBeInTheDocument();
    expect(screen.queryByText("Loading recorded sessions…")).not.toBeInTheDocument();
    expect(screen.queryByText("median wall time")).not.toBeInTheDocument();
  });

  it("flags retained Claude limits when the provider needs sign-in", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate({
      limitActivities: [],
      providerLimits: [{
        ...snapshot.providerLimits[0],
        usageLimits: { ...snapshot.providerLimits[0].usageLimits, error: "Anthropic usage endpoint returned 401" },
      }],
    })));
    renderHome();
    expect(await screen.findByText("Sign-in needed")).toBeInTheDocument();
    expect(screen.getByText("31%")).toBeInTheDocument();
  });

  it("keeps resource telemetry quiet on the home surface", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(homeAggregate()));
    const { container } = renderHome();
    await screen.findByRole("heading", { name: "Open sessions" });
    expect(container.querySelector(".homeChartLine, .homeChartCpu, .homeChartMemory")).not.toBeInTheDocument();
    expect(screen.queryByText("Resource use · live samples")).not.toBeInTheDocument();
    expect(screen.queryByText("42% · 64 MB")).not.toBeInTheDocument();
  });

  it("shows no-live and offline states without hanging polling", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ generatedAt: "2026-08-23T12:00:00.000Z", providerLimits: [], limitActivities: [] }));
    const noLive = renderHome([]);
    expect(await screen.findByText("No open sessions yet.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/home", expect.objectContaining({ cache: "no-store" }));

    noLive.unmount();
    fetchMock.mockImplementation(() => response({}, 503));
    renderHome([]);
    expect(await screen.findByText("Usage and activity overview is unavailable. Pomegr will retry automatically.")).toBeInTheDocument();
  });
});
