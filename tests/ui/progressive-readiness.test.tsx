import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import { HomeDashboard } from "../../app/HomeDashboard";
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
  summaryReadiness: "loading",
  agentCount: null,
  activeAgentCount: null,
  latestContextTotal: null,
  progress: null,
  currentActivity: null,
};

afterEach(() => vi.restoreAllMocks());

describe("progressive readiness", () => {
  it("uses a bounded cold-start Home grid while catalog readiness is loading", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    const { container } = render(<SessionCatalogProvider sessions={[]} loading readiness={{ catalog: "loading" }}><HomeDashboard /></SessionCatalogProvider>);
    expect(container.querySelectorAll(".homeCatalogSkeleton .homeSessionCard")).toHaveLength(5);
    expect(container.querySelector(".commandHome")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading open sessions");
  });

  it("does not leave the previous session visible while a selected route hydrates", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    render(<SessionCatalogProvider sessions={[target]}><Dashboard initialSessionId={target.id} /></SessionCatalogProvider>);
    expect(screen.getByRole("heading", { name: "Target session" })).toBeInTheDocument();
    expect(screen.queryByText("Previous session")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Loading Target session" })).toHaveAttribute("aria-busy", "true");
  });
});
