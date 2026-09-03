import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageLimitsView } from "../../app/components/command-center/CommandViews";

import type { ProviderServiceStatus } from "../../shared/monitor-contract";

const providerState = vi.hoisted(() => ({ providers: [] as ProviderServiceStatus[] }));
vi.mock("../../app/provider-status-client", () => ({
  useProviderStatus: () => ({ revision: 1, generatedAt: null, providers: providerState.providers }),
}));

function service(provider: "claude" | "codex", overrides: Partial<ProviderServiceStatus> = {}): ProviderServiceStatus {
  const source = provider === "claude" ? "Claude Code" : "Codex";
  const statusPageUrl = provider === "claude" ? "https://status.claude.com/" : "https://status.openai.com/";
  return {
    provider, source, statusPageUrl, status: "degraded", readiness: "ready", freshness: "fresh",
    checkedAt: "2026-09-03T12:00:00.000Z", updatedAt: "2026-09-03T11:55:00.000Z",
    incidentKey: provider + "-incident-1",
    incidents: [{ id: "incident-1", label: "Elevated errors for multiple models", status: "investigating", impact: "minor", updatedAt: null, url: statusPageUrl + "incidents/incident-1" }],
    ...overrides,
  };
}

beforeEach(() => { providerState.providers = []; });

vi.mock("../../app/usage-limits-client", () => ({
  useUsageLimits: () => ({
    revision: null,
    generatedAt: null,
    providers: [],
    readiness: { claude: "loading", codex: "loading" },
  }),
}));

describe("usage limits view", () => {
  it("shows automatic observation state without an inactive manual refresh action", () => {
    const { container } = render(<UsageLimitsView />);

    expect(screen.getByRole("heading", { name: "Usage limits", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Usage limits are loading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh limits" })).not.toBeInTheDocument();
    expect(container.querySelector(".commandViewActions")).not.toBeInTheDocument();
  });
});


describe("usage limits service notices", () => {
  it("shows and dismisses each provider warning independently even while usage is loading", () => {
    providerState.providers = [service("claude"), service("codex")];
    render(<UsageLimitsView />);
    const claudeNotice = screen.getByRole("status", { name: "Claude Code provider service notice" });
    expect(claudeNotice).toHaveTextContent("Elevated errors for multiple models. Requests may be delayed or fail.");
    expect(claudeNotice).toHaveTextContent("Last checked");
    expect(claudeNotice).toHaveTextContent("Provider update");
    expect(within(claudeNotice).getByRole("link", { name: /View incident/ })).toHaveAttribute("href", "https://status.claude.com/incidents/incident-1");
    fireEvent.click(within(claudeNotice).getByRole("button", { name: "Dismiss provider service notice" }));
    expect(screen.queryByRole("status", { name: "Claude Code provider service notice" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Codex provider service notice" })).toBeInTheDocument();
    expect(screen.getByText("Usage limits are loading")).toBeInTheDocument();
  });

  it("keeps an incident dismissed across polls and reopens for worsening or a new incident", () => {
    providerState.providers = [service("claude")];
    const view = render(<UsageLimitsView />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss provider service notice" }));
    providerState.providers = [service("claude", { checkedAt: "2026-09-03T12:01:00.000Z" })];
    view.rerender(<UsageLimitsView />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    providerState.providers = [service("claude", { status: "outage" })];
    view.rerender(<UsageLimitsView />);
    expect(screen.getByRole("status")).toHaveTextContent("Claude Code reports service issues");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss provider service notice" }));
    providerState.providers = [service("claude", { incidentKey: "incident-2" })];
    view.rerender(<UsageLimitsView />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("hides stale and resolved incidents and preserves delayed-refresh wording", () => {
    providerState.providers = [service("claude", { freshness: "stale" }), service("codex", { status: "operational", incidentKey: null, incidents: [] })];
    const view = render(<UsageLimitsView />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    providerState.providers = [service("claude", { readiness: "unavailable" })];
    view.rerender(<UsageLimitsView />);
    expect(screen.getByRole("status")).toHaveTextContent("this is the last confirmed report");
    providerState.providers = [service("claude", { status: "operational", incidentKey: null, incidents: [] })];
    view.rerender(<UsageLimitsView />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
