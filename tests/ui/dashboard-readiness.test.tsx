import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

import { Dashboard } from "../../app/Dashboard";
import { HomeDashboard } from "../../app/HomeDashboard";
import { DisplayPreferencesProvider } from "../../app/hooks/DisplayPreferencesContext";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { resetSessionDomainStoreForTests } from "../../app/session-domain-store";
import type { SessionSummaryDomain } from "../../shared/session-domain-contract";
import { sessionSummaryFixture } from "./session-summary-test-fixture";

/*
 * Ports of every still-applicable assertion from the deleted `progressive-readiness.test.tsx`
 * (git show HEAD:tests/ui/progressive-readiness.test.tsx), rebuilt against the T04
 * session-domain architecture. See the fix-dashboard-coverage report for the full
 * assertion-to-location map, including the one assertion left unported (obsolete by design).
 */

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }

function mount(summary: SessionSummaryDomain) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).startsWith("/api/session-domain") ? json(summary) : new Response(null, { status: 404 }));
  const view = render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[]}><Dashboard initialSessionId={summary.sessionId} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
  return { ...view, fetchMock };
}

afterEach(() => { resetSessionDomainStoreForTests(); vi.restoreAllMocks(); });

describe("progressive readiness (ported)", () => {
  it("never fabricates a KPI total for a session section without confirmed ready evidence", async () => {
    const summary = sessionSummaryFixture({
      sectionReadiness: { core: "ready", agentEvidence: "unavailable", contextEvidence: "unavailable", activityEvidence: "unavailable", repository: "ready" },
    });
    mount(summary);
    await screen.findByRole("heading", { name: summary.session!.title });
    const kpis = screen.getByLabelText("Session totals");
    const values = [...kpis.querySelectorAll(".sessionKpi strong")].map((element) => element.textContent);
    expect(values[0]).toBe("—"); // Agents
    expect(values[1]).toBe("—"); // All-agent context
    expect(values[2]).not.toBe("—"); // Wall time still comes from the session record itself
    expect(values[3]).toBe("—"); // Calls
    expect(within(kpis).getByText("Agent status counts unavailable")).toBeInTheDocument();
    expect(within(kpis).getByText("Context evidence unavailable")).toBeInTheDocument();
    expect(within(kpis).getByText("Activity evidence unavailable")).toBeInTheDocument();
  });

  it("shows committed request snapshots in Overview while context evidence is still loading", async () => {
    const summary = sessionSummaryFixture({
      sectionReadiness: { ...sessionSummaryFixture().sectionReadiness, contextEvidence: "loading" },
    });
    mount(summary);
    await screen.findByRole("heading", { name: summary.session!.title });
    const kpis = screen.getByLabelText("Session totals");
    const values = [...kpis.querySelectorAll(".sessionKpi strong")].map((element) => element.textContent);
    expect(values[1]).toBe("—"); // context is honestly "loading", never a fabricated number
    const overview = screen.getByLabelText("Session overview");
    expect(within(overview).getByTitle(/fresh tokens/)).toBeInTheDocument();
  });

  it("keeps Home discovery usable while session-catalog readiness itself reports loading", () => {
    render(<SessionCatalogProvider sessions={[]} readiness={{ catalog: "loading" }}><HomeDashboard /></SessionCatalogProvider>);
    expect(screen.getByRole("heading", { name: "Welcome to Pomegr" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Session coach" })).toBeInTheDocument();
    expect(screen.queryByText("No open sessions yet.")).not.toBeInTheDocument();
  });

  it("shows an honest unavailable state for a definitive 404 and does not keep retrying or claim the monitor is unreachable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const sessionId = "claude:outside-catalog-window";
      const fetchMock = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json({ domain: "session-summary", sessionId, revision: 0, readiness: "loading", observedAt: null }))
        .mockResolvedValue(new Response(JSON.stringify({ domain: "session-summary", sessionId, revision: 0, readiness: "unavailable", observedAt: null }), { status: 404 }));
      render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[]}><Dashboard initialSessionId={sessionId} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
      expect(await screen.findByRole("heading", { name: "Loading session…" })).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "Session unavailable" })).toBeInTheDocument();
      expect(screen.getByText("Pomegr found no recorded evidence for this session.")).toBeInTheDocument();
      expect(screen.queryByText(/not yet reached the local monitor/u)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      const calls = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the connection notice for a transient proxy 503", async () => {
    const sessionId = "claude:monitor-down";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ domain: "session-summary", sessionId, revision: 0, readiness: "unavailable", observedAt: null }), { status: 503 }));
    render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[]}><Dashboard initialSessionId={sessionId} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
    expect(await screen.findByRole("heading", { name: "Session evidence unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Session unavailable" })).not.toBeInTheDocument();
  });

  it("does not leave the previous session visible while a newly selected route hydrates", async () => {
    const bodies: Record<string, SessionSummaryDomain> = {
      "claude:first": { ...sessionSummaryFixture({ sessionId: "claude:first" }), session: { ...sessionSummaryFixture().session!, id: "claude:first", title: "First session" } },
      "claude:second": { ...sessionSummaryFixture({ sessionId: "claude:second" }), session: { ...sessionSummaryFixture().session!, id: "claude:second", title: "Second session" } },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://local");
      return json(bodies[url.searchParams.get("sessionId") || ""]);
    });
    const view = render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[]}><Dashboard key="claude:first" initialSessionId="claude:first" initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
    expect(await screen.findByRole("heading", { name: "First session" })).toBeInTheDocument();
    // The route page keys Dashboard by sessionId (app/sessions/[sessionId]/page.tsx), so a
    // session change is a full remount, not an in-place update.
    view.rerender(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[]}><Dashboard key="claude:second" initialSessionId="claude:second" initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
    expect(screen.queryByRole("heading", { name: "First session" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Loading session…" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Second session" })).toBeInTheDocument();
  });
});
