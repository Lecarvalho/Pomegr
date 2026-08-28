import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import { HomeDashboard } from "../../app/HomeDashboard";
import { SessionSidebar } from "../../app/components/dashboard/SessionSidebar";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { SessionSummary } from "../../shared/monitor-contract";

const target: SessionSummary = {
  id: "codex:target",
  provider: "codex",
  source: "Codex",
  title: "Target session",
  project: "Pomegr",
  updatedAt: "2026-08-28T12:00:00.000Z",
  isLive: true,
  needsInput: false,
  activityStatus: "working",
};
const targetLive = { ...target, agentCount: null, activeAgentCount: null, latestContextTotal: null, progress: null };

afterEach(() => vi.restoreAllMocks());

describe("progressive readiness", () => {
  it("uses a bounded cold-start Home grid while catalog readiness is loading", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    const { container } = render(<SessionCatalogProvider sessions={[]} liveSessions={[]} loading readiness={{ catalog: "loading", sessionSummaries: {} }}><HomeDashboard /></SessionCatalogProvider>);
    expect(container.querySelectorAll(".homeCatalogSkeleton .homeSessionCard")).toHaveLength(5);
    expect(container.querySelector(".homeContent")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading open sessions");
  });

  it("keeps sidebar counts unknown and rows geometry-stable during a cold catalog", () => {
    render(<LiveClockProvider running={false}><SessionSidebar open sessions={[]} selectedSessionId={null} currentSessionId={null} viewingHistory={false} readiness={{ catalog: "loading", sessionSummaries: {} }} onClose={vi.fn()} onSelect={vi.fn()} /></LiveClockProvider>);
    expect(screen.getByRole("navigation")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByLabelText("Session count loading")).toHaveLength(3);
    expect(document.querySelectorAll(".sidebarSkeletonRow")).toHaveLength(4);
    expect(screen.queryByText("No open sessions")).not.toBeInTheDocument();
  });

  it("does not leave the previous session visible while a selected route hydrates", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    render(<SessionCatalogProvider sessions={[target]} liveSessions={[targetLive]}><Dashboard initialSessionId={target.id} /></SessionCatalogProvider>);
    expect(screen.getByRole("heading", { name: "Target session" })).toBeInTheDocument();
    expect(screen.queryByText("Previous session")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Loading Target session" })).toHaveAttribute("aria-busy", "true");
  });
});
