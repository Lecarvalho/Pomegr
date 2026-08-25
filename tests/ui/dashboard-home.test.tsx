import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      contextHistory: { bucketMs: 60_000, buckets: [{ start: "2026-08-23T11:58:00.000Z", end: "2026-08-23T11:59:00.000Z", total: 5000, agents: [] }, { start: "2026-08-23T11:59:00.000Z", end: "2026-08-23T12:00:00.000Z", total: 12000, agents: [] }], boundaries: [] },
      resources: { status: "ready", reason: null, current: { cpuCores: 1, cpuMachinePercent: 42, memoryBytes: 64 * 1024 * 1024, readBytesPerSecond: 0, writeBytesPerSecond: 0 }, observedPeak: { memoryBytes: 64 * 1024 * 1024 }, samples: [{ timestamp: "2026-08-23T11:58:00.000Z", cpuCores: 1, cpuMachinePercent: 20, memoryBytes: 32 * 1024 * 1024, readBytesPerSecond: 0, writeBytesPerSecond: 0 }, { timestamp: "2026-08-23T12:00:00.000Z", cpuCores: 1, cpuMachinePercent: 42, memoryBytes: 64 * 1024 * 1024, readBytesPerSecond: 0, writeBytesPerSecond: 0 }] },
    }],
    history: { windowDays: 7, completed: 3, medianWallTimeMs: 300_000, medianFinalContext: 8000, finalContexts: [{ endedAt: "2026-08-22T11:00:00.000Z", total: 7000 }, { endedAt: "2026-08-23T10:00:00.000Z", total: 9000 }] },
  }],
} satisfies HomeSnapshot;

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem("pomegr-home-limit-activity-open");
});

describe("home dashboard", () => {
  it("folds limit activity into aligned window and session summaries without repeated details", async () => {
    window.localStorage.setItem("pomegr-home-limit-activity-open", "false");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(snapshot));
    const { container } = render(<HomeDashboard />);

    const details = (await screen.findByText("Limit activity")).closest("details");
    const summary = details?.querySelector(":scope > summary .homeLimitActivitySummary");
    expect(details).not.toHaveAttribute("open");
    expect(summary).toHaveTextContent("Claude Code 5h");
    expect(summary).toHaveTextContent("2 sessions");
    expect(summary).not.toHaveTextContent("observed");
    expect(summary).not.toHaveTextContent("Partial evidence");
    expect(summary).not.toHaveTextContent(/movement|pts/i);
    expect(summary).not.toHaveTextContent("31%");
    expect(summary?.querySelectorAll(".homeLimitActivitySummaryItem > span")).toHaveLength(2);
    expect(summary?.querySelector(".homeLimitActivitySummarySessions")).toHaveTextContent("2 sessions");

    await userEvent.click(screen.getByText("Limit activity"));
    expect(details).toHaveAttribute("open");
    expect(details?.querySelector(":scope > summary .homeLimitActivitySummary")).not.toBeInTheDocument();
    expect(container.querySelector(".homeLimitActivityDescription")).toHaveTextContent("Local session requests within selected account windows");
  });

  it("omits an unhelpful movement placeholder while account observations are collecting", async () => {
    window.localStorage.setItem("pomegr-home-limit-activity-open", "false");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      limitActivities: snapshot.limitActivities.map((activity) => ({ ...activity, status: "collecting" as const, movements: [] })),
    }));
    const { container } = render(<HomeDashboard />);

    await screen.findByText("Limit activity");
    const summary = container.querySelector(".homeLimitActivitySummary");
    expect(summary).toHaveTextContent("Claude Code 5h");
    expect(summary).toHaveTextContent("2 sessions");
    expect(summary).not.toHaveTextContent("observed");
    expect(summary).not.toHaveTextContent(/collecting|movement history|no movement/i);
  });

  it("shows only supplied live project/session content with always-visible seven-day metrics", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(snapshot));
    const { container } = render(<HomeDashboard />);
    expect(await screen.findByRole("heading", { name: "pomegr" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "7-day history" })).toBeInTheDocument();
    expect(screen.getByText("3", { selector: ".homeHistoryMetrics b" })).toBeInTheDocument();
    expect(screen.getByText("Build home")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Usage limits" })).toBeInTheDocument();
    expect(container.querySelectorAll(".homeProviderLimit")).toHaveLength(2);
    expect(container.querySelector('.homeLimitRow[aria-label="Current session, 5 hours, 31% used"]')).toBeInTheDocument();
    expect(container.querySelector('.homeLimitRow.warning[aria-label="Codex, 7 days, 82% used"]')).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Pomegr home" })).toHaveLength(1);
    expect(screen.queryByText(/recent|completed session/i)).not.toBeInTheDocument();
    expect(container.querySelector('a[href="/sessions/codex-live.one_2"]')).toBeInTheDocument();

    const limits = container.querySelector(".homeLimits");
    const activity = container.querySelector(".homeLimitActivity");
    const folio = container.querySelector(".homeFolio");
    expect(limits).toBeInTheDocument();
    expect(activity).toBeInTheDocument();
    expect(folio).toBeInTheDocument();
    expect(limits!.compareDocumentPosition(activity!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity!.compareDocumentPosition(folio!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity).toHaveTextContent("Claude Code");
    expect(activity).toHaveTextContent("Current session");
    expect(activity).toHaveTextContent("31%");
    expect(activity).toHaveTextContent(/Reset/i);
    expect(activity).toHaveTextContent("Partial coverage");
    expect(activity).toHaveTextContent("pomegr · live");
    expect(activity).toHaveTextContent("other-repo · closed");
    expect(activity!.querySelectorAll(".homeLimitActivitySession > i b")).toHaveLength(2);
    expect(activity!.querySelector(".homeLimitActivityScaleLabels")).toHaveTextContent("0100%");
    expect(activity!.querySelector(".homeLimitActivityScaleTimes")).toHaveTextContent(/^Started .+/);
    expect(activity!.querySelector(".homeLimitActivityScaleTrack b")).not.toBeInTheDocument();
    expect(activity!.querySelector(".homeLimitActivityTimeline svg, .homeLimitActivityObservation, .homeLimitActivityWindowStart, .homeLimitActivityRejection")).not.toBeInTheDocument();
    expect(activity).not.toHaveTextContent(/First rejection|Newest observed movements|No observed movements/i);
    expect(activity).not.toHaveTextContent(/token totals?|share|drainer/i);
  });

  it("shows one terminal mark when a provider observation reaches 100%", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      limitActivities: snapshot.limitActivities.map((activity) => ({
        ...activity,
        percent: 100,
        observations: [...activity.observations, { observedAt: "2026-08-23T12:05:00.000Z", percent: 100 }],
      })),
    }));
    const { container } = render(<HomeDashboard />);
    await screen.findByText("Limit activity");
    const activity = container.querySelector(".homeLimitActivity");
    expect(activity).toBeInTheDocument();
    expect(activity!.querySelectorAll(".homeLimitActivityScaleTrack b")).toHaveLength(1);
    expect(activity!.querySelector(".homeLimitActivityScaleTimes")).toHaveTextContent(/Reached 100% at .+/);
    expect(activity!.querySelector(".homeLimitActivityScale")?.getAttribute("aria-label")).toMatch(/Reached 100% at .+/);
  });

  it("keeps the exact start time when the provider omits resetsAt", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      limitActivities: snapshot.limitActivities.map((activity) => ({ ...activity, resetsAt: null, windowStartsAtExact: true })),
    }));
    const { container } = render(<HomeDashboard />);
    await screen.findByText("Limit activity");
    expect(container.querySelector(".homeLimitActivityScaleTimes")).toHaveTextContent(/^Started .+/);
  });

  it("labels a selected seven-day activity window without five-hour copy", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      limitActivities: snapshot.limitActivities.map((activity) => ({
        ...activity,
        limitId: "codex-secondary",
        label: "Codex",
        window: "7 days",
        windowStartsAt: "2026-08-16T12:00:00.000Z",
        firstRejectedAt: null,
      })),
    }));
    const { container } = render(<HomeDashboard />);
    await screen.findByText("Limit activity");
    expect(container.querySelector(".homeLimitActivityScaleTimes")).toHaveTextContent(/^Started .+/);
    expect(container.querySelector(".homeLimitActivity")).not.toHaveTextContent("5-hour limit activity");
  });

  it("keeps live cards available while recorded history warms", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      projects: snapshot.projects.map((project) => ({ ...project, history: { ...project.history, status: "loading" as const } })),
    }));
    render(<HomeDashboard />);
    expect(await screen.findByText("Build home")).toBeInTheDocument();
    expect(screen.getByText("Loading recorded sessions…")).toBeInTheDocument();
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

  it("renders stepped context and separate CPU/memory resource paths with current values", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(snapshot));
    const { container } = render(<HomeDashboard />);
    await screen.findByRole("heading", { name: "pomegr" });
    expect(container.querySelector(".homeChartLine")?.getAttribute("d")).toMatch(/L[\d.]+ [\d.]+L[\d.]+ [\d.]+/);
    expect(container.querySelector(".homeChartCpu")).toBeInTheDocument();
    expect(container.querySelector(".homeChartMemory")).toBeInTheDocument();
    expect(screen.getByText("42% · 64 MB")).toBeInTheDocument();
    expect(screen.queryByText("20m ago")).not.toBeInTheDocument();
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
