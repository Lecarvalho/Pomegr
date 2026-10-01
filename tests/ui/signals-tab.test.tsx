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
    sectionReadiness: { activityEvidence: "ready", contextEvidence: "ready" },
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

  it("reads the live signals domain for a live session", () => {
    useSessionDomain.mockReturnValue(result(domain()));
    render(<SignalsTab sessionId="claude:signals" historical={false} paused={false} onNavigateAgent={() => undefined} />);
    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "claude:signals", domain: "signals" }, { historical: false, enabled: true });
  });

  it("keeps historical mode out of live polling and supports agent navigation", async () => {
    const onNavigateAgent = vi.fn();
    useSessionDomain.mockReturnValue(result(domain()));
    render(<SignalsTab sessionId="claude:signals" historical paused={false} onNavigateAgent={onNavigateAgent} />);
    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: "claude:signals", domain: "signals" }, { historical: true, enabled: true });
    await userEvent.setup().click(screen.getByRole("button", { name: "Show agent" }));
    expect(onNavigateAgent).toHaveBeenCalledWith("primary");
  });
});
