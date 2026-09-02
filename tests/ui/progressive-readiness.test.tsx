import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import { HomeDashboard } from "../../app/HomeDashboard";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { SessionSummary } from "../../shared/monitor-contract";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";

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
  it("keeps Home discovery usable while catalog readiness is loading", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    const { container } = render(<SessionCatalogProvider sessions={[]} loading readiness={{ catalog: "loading" }}><HomeDashboard /></SessionCatalogProvider>);
    expect(container.querySelector(".homeCatalogSkeleton")).not.toBeInTheDocument();
    expect(container.querySelector(".commandHome")).not.toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { name: "Session coach" })).toBeInTheDocument();
  });

  it("does not leave the previous session visible while a selected route hydrates", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    render(<SessionCatalogProvider sessions={[target]}><Dashboard initialSessionId={target.id} /></SessionCatalogProvider>);
    expect(screen.getByRole("heading", { name: "Target session" })).toBeInTheDocument();
    expect(screen.queryByText("Previous session")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Loading Target session" })).toHaveAttribute("aria-busy", "true");
  });

  it.each([true, false])("shows settled pre-prompt detail without fabricated metrics (catalog arrived: %s)", async (catalogArrived) => {
    const session = { ...target, activityStatus: "open" as const, summaryReadiness: "unavailable" as const };
    const state = { ...createEmptyMonitorState({ connected: true }), catalogIdentity: session,
      readiness: { core: "unavailable", agentEvidence: "unavailable", contextEvidence: "unavailable", activityEvidence: "unavailable", repository: "unavailable", resources: "unavailable", usageLimits: "unavailable" } };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).includes("/api/state")
      ? new Response(JSON.stringify(state), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify({ providers: [], readiness: {} }), { status: 200 }));
    const { container } = render(<SessionCatalogProvider sessions={catalogArrived ? [session] : []}><Dashboard initialSessionId={session.id} /></SessionCatalogProvider>);
    expect(await screen.findByText("No recorded activity yet")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: session.title })).toBeInTheDocument();
    expect(container.querySelector(".uiSkeleton")).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
    expect(screen.queryByText("Loading session evidence", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText("All-agent context")).not.toBeInTheDocument();
    expect(screen.queryByText("Primary agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /report/i })).not.toBeInTheDocument();
  });
});
