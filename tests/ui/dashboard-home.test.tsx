import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "../../app/HomeDashboard";
import type { HomeSnapshot } from "../../shared/monitor-contract";

function response(body: object, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const snapshot = {
  generatedAt: "2026-08-23T12:00:00.000Z",
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

afterEach(() => vi.restoreAllMocks());

describe("home dashboard", () => {
  it("shows only supplied live project/session content with always-visible seven-day metrics", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(snapshot));
    const { container } = render(<HomeDashboard />);
    expect(await screen.findByRole("heading", { name: "pomegr" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "7-day history" })).toBeInTheDocument();
    expect(screen.getByText("3", { selector: ".homeHistoryMetrics b" })).toBeInTheDocument();
    expect(screen.getAllByText("Build home")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Pomegr home" })).toHaveLength(1);
    expect(screen.queryByText(/recent|completed session/i)).not.toBeInTheDocument();
    expect(container.querySelector('a[href="/sessions/codex-live.one_2"]')).toBeInTheDocument();
  });

  it("keeps live cards available while recorded history warms", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({
      ...snapshot,
      projects: snapshot.projects.map((project) => ({ ...project, history: { ...project.history, status: "loading" as const } })),
    }));
    render(<HomeDashboard />);
    expect(await screen.findAllByText("Build home")).toHaveLength(2);
    expect(screen.getByText("Loading recorded sessions…")).toBeInTheDocument();
    expect(screen.queryByText("median wall time")).not.toBeInTheDocument();
  });

  it("renders stepped context and separate CPU/memory resource paths with current values", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(snapshot));
    const { container } = render(<HomeDashboard />);
    await screen.findByRole("heading", { name: "pomegr" });
    expect(container.querySelector(".homeChartLine")?.getAttribute("d")).toMatch(/L[\d.]+ [\d.]+L[\d.]+ [\d.]+/);
    expect(container.querySelector(".homeChartCpu")).toBeInTheDocument();
    expect(container.querySelector(".homeChartMemory")).toBeInTheDocument();
    expect(screen.getByText("42% · 64 MB")).toBeInTheDocument();
  });

  it("shows no-live and offline states without hanging polling", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ generatedAt: "2026-08-23T12:00:00.000Z", projects: [] }));
    render(<HomeDashboard />);
    expect(await screen.findByText("No running sessions yet.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/home", expect.objectContaining({ cache: "no-store" }));

    fetchMock.mockImplementation(() => response({}, 503));
    render(<HomeDashboard />);
    expect(await screen.findByText("Home overview is unavailable. Pomegr will reconnect automatically.")).toBeInTheDocument();
  });
});
