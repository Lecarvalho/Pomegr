import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalsDomain } from "../../shared/session-domain-contract";
import { SignalsTab } from "../../app/components/dashboard/SignalsTab";

const { useSessionDomain } = vi.hoisted(() => ({ useSessionDomain: vi.fn() }));
vi.mock("../../app/session-domain-store", () => ({ useSessionDomain }));

function domain(overrides: Partial<SignalsDomain> = {}): SignalsDomain {
  return {
    domain: "signals", sessionId: "claude:signals", revision: 1, readiness: "ready", observedAt: "2026-09-19T12:00:00.000Z",
    sectionReadiness: { activityEvidence: "ready", contextEvidence: "ready" }, score: 80,
    flowScore: { score: 80, repeatedCalls: 2, overlappingTargets: 1 },
    insights: [{ id: "repeated", level: "warning", title: "Repeated reads", detail: "The same target was read repeatedly.", agentId: "primary" }], loops: [], toolPatterns: [],
    sessionSignal: { label: "Verification underway", tone: "info", reportedAt: "2026-09-19T12:00:00.000Z", description: "Agent status." },
    agents: [{ id: "primary", label: "Primary agent", cacheLifetime: "1h", signal: { label: "Testing", tone: "neutral", reportedAt: null, description: "Focused tests." } }],
    cacheEvents: { status: "ready", items: [{ id: "event-1", agentId: "primary", kind: "reuse", observedAt: "2026-09-19T12:00:00.000Z", promptInputTokens: 1, cacheReadPercent: 80, cacheWriteTokens: 0, previousCacheReadPercent: 80, gapMs: 20, relatedEventId: null }], possibleFullRefills: [] },
    cacheReadDrops: { status: "ready", items: [] },
    ...overrides,
  };
}

function result(data: SignalsDomain | null, error: string | null = null, unavailable = false) {
  return { data, error, fetching: false, connected: true, unavailable, revalidate: vi.fn() };
}

describe("SignalsTab", () => {
  beforeEach(() => { useSessionDomain.mockReset(); });

  it("renders committed Signals-domain groups and preserves their caveats", () => {
    useSessionDomain.mockReturnValue(result(domain()));
    render(<SignalsTab sessionId="claude:signals" historical={false} paused={false} onNavigateAgent={() => undefined} onNavigateActivities={() => undefined} />);
    expect(screen.getByText("Not a quality assessment.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Efficiency" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cache evidence" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cache lifetime" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reported signals" })).toBeInTheDocument();
    expect(screen.getByText(/Signals are agent-reported/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in Activities" })).not.toBeInTheDocument();
    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "claude:signals", domain: "signals" }, { historical: false, enabled: true });
  });

  it("keeps historical mode out of live polling and supports agent navigation", async () => {
    const onNavigateAgent = vi.fn();
    useSessionDomain.mockReturnValue(result(domain()));
    render(<SignalsTab sessionId="claude:signals" historical paused={false} onNavigateAgent={onNavigateAgent} onNavigateActivities={() => undefined} />);
    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "claude:signals", domain: "signals" }, { historical: true, enabled: true });
    await userEvent.setup().click(screen.getByRole("button", { name: "Show agent" }));
    expect(onNavigateAgent).toHaveBeenCalledWith("primary");
  });

  it("renders loading, unavailable, and retained-update-failure states honestly", () => {
    useSessionDomain.mockReturnValue(result(null));
    const { rerender } = render(<SignalsTab sessionId="claude:signals" historical={false} paused={false} onNavigateAgent={() => undefined} onNavigateActivities={() => undefined} />);
    expect(screen.getByText("Loading signal evidence…")).toBeInTheDocument();
    useSessionDomain.mockReturnValue(result(domain({ readiness: "unavailable", sectionReadiness: { activityEvidence: "unavailable", contextEvidence: "unavailable" } })));
    rerender(<SignalsTab sessionId="claude:signals" historical={false} paused={false} onNavigateAgent={() => undefined} onNavigateActivities={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Reported signals" })).toBeInTheDocument();
    expect(screen.getByText("Activity evidence is unavailable for this session.")).toBeInTheDocument();
    expect(screen.getByText("Context evidence is unavailable, so cache lifetimes are unavailable.")).toBeInTheDocument();
    useSessionDomain.mockReturnValue(result(null, null, true));
    rerender(<SignalsTab sessionId="claude:signals" historical={false} paused={false} onNavigateAgent={() => undefined} onNavigateActivities={() => undefined} />);
    expect(screen.getByText("Signal evidence is unavailable for this session.")).toBeInTheDocument();
    useSessionDomain.mockReturnValue(result(domain(), "Connection failed"));
    rerender(<SignalsTab sessionId="claude:signals" historical={false} paused={false} onNavigateAgent={() => undefined} onNavigateActivities={() => undefined} />);
    expect(screen.getByText("Update failed. Showing the last recorded signal evidence.")).toBeInTheDocument();
  });
});
