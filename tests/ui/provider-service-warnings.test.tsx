import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderServiceStatus, ProviderStatusSnapshot, SessionSummary } from "../../shared/monitor-contract";

const providerState = vi.hoisted(() => ({ current: { revision: 1, generatedAt: null, providers: [] } as ProviderStatusSnapshot }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../app/provider-status-client", async () => ({
  ...(await vi.importActual<typeof import("../../app/provider-status-client")>("../../app/provider-status-client")),
  useProviderStatus: () => providerState.current,
}));

import { CommandCenterShell } from "../../app/components/command-center/CommandCenterShell";
import { SessionsView } from "../../app/components/command-center/CommandViews";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";

const checkedAt = "2026-09-02T12:00:00.000Z";

function provider(provider: "claude" | "codex", overrides: Partial<ProviderServiceStatus> = {}): ProviderServiceStatus {
  const isClaude = provider === "claude";
  return {
    provider,
    source: isClaude ? "Claude Code" : "Codex",
    status: "degraded",
    readiness: "ready",
    freshness: "fresh",
    checkedAt,
    updatedAt: checkedAt,
    statusPageUrl: isClaude ? "https://status.claude.com/" : "https://status.openai.com/",
    incidentKey: `${provider}-incident-1`,
    incidents: [{ id: `${provider}-incident-1`, label: "Elevated errors", status: "investigating", impact: "minor", updatedAt: null, url: `${isClaude ? "https://status.claude.com" : "https://status.openai.com"}/incidents/${provider}-incident-1` }],
    ...overrides,
  };
}

function snapshot(statuses: ProviderServiceStatus[], revision = 1): ProviderStatusSnapshot {
  return { revision, generatedAt: checkedAt, providers: statuses };
}

function session(providerId: "claude" | "codex", isLive = true): SessionSummary {
  return {
    id: `${providerId}:${isLive ? "live" : "history"}-1`, provider: providerId, source: providerId === "claude" ? "Claude Code" : "Codex",
    title: `${providerId} ${isLive ? "live" : "history"} session`, project: "Pomegr", createdAt: checkedAt, updatedAt: checkedAt, isLive,
    needsInput: false, activityStatus: isLive ? "working" : "idle", summaryReadiness: "ready", agentCount: 1,
    activeAgentCount: isLive ? 1 : 0, latestContextTotal: 1000, progress: null, currentActivity: null, activityFallback: null,
  };
}

function shell(sessions: SessionSummary[] = []) {
  return <CommandCenterShell pathname="/" sessions={sessions} connected loading={false}><main>Content</main></CommandCenterShell>;
}

afterEach(() => {
  providerState.current = { revision: 1, generatedAt: null, providers: [] };
  vi.restoreAllMocks();
});

describe("provider service warnings", () => {
  it.each(["claude", "codex"] as const)("shows only the matching fresh provider warning on live %s rows", async (providerId) => {
    const other = providerId === "claude" ? "codex" : "claude";
    providerState.current = snapshot([provider(providerId), provider(other, { status: "operational", incidentKey: null, incidents: [] })]);
    const live = session(providerId, true);
    const historical = session(providerId, false);
    const unrelated = session(other, true);
    const view = render(<SessionCatalogProvider sessions={[live, historical, unrelated]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.getAllByText("Degraded service")).toHaveLength(1);
    expect(within(screen.getByText(`${providerId} live session`).closest("tr")!).getByText("Degraded service")).toBeInTheDocument();
    expect(within(screen.getByText(`${other} live session`).closest("tr")!).queryByText("Degraded service")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^All/ }));
    expect(screen.getByText(`${providerId} live session`)).toBeInTheDocument();
    expect(screen.getByText(`${providerId} history session`)).toBeInTheDocument();
    expect(screen.getByText(`${other} live session`)).toBeInTheDocument();
    expect(screen.getAllByText("Degraded service")).toHaveLength(1);
    view.rerender(<SessionCatalogProvider sessions={[historical]}><SessionsView /></SessionCatalogProvider>);
    expect(screen.queryByText("Degraded service")).toBeNull();
  });

  it.each(["stale", "unknown", "loading", "operational"] as const)("excludes %s status from live row and notification warnings", (scenario) => {
    const status = scenario === "unknown" ? "unknown" : scenario === "operational" ? "operational" : "degraded";
    providerState.current = snapshot([provider("codex", { status, freshness: scenario === "stale" ? "stale" : "fresh", readiness: scenario === "loading" ? "loading" : "ready", incidentKey: scenario === "operational" ? null : "codex-incident-1", incidents: scenario === "operational" ? [] : provider("codex").incidents }), provider("claude", { status: "operational", incidentKey: null, incidents: [] })]);
    render(<SessionCatalogProvider sessions={[session("codex")] }><SessionsView /></SessionCatalogProvider>);
    expect(screen.queryByText("Degraded service")).toBeNull();
    render(shell([session("codex")]));
    expect(screen.getByRole("button", { name: "Notifications" })).not.toHaveAccessibleName(/attention available/);
  });

  it("shows a fresh last-known unavailable report with delayed-refresh wording", async () => {
    providerState.current = snapshot([provider("codex", { readiness: "unavailable" }), provider("claude", { status: "operational", incidentKey: null, incidents: [] })]);
    const user = userEvent.setup();
    render(shell([session("codex")]));
    await user.click(screen.getByRole("button", { name: "Notifications, attention available" }));
    const tray = screen.getByRole("complementary", { name: "Notifications" });
    expect(tray).toHaveTextContent("Status refresh is delayed; this is the last confirmed report.");
  });

  it("shows one independently linked notification for each affected provider", async () => {
    const user = userEvent.setup();
    providerState.current = snapshot([provider("codex"), provider("claude")]);
    render(shell([session("codex"), session("claude")]));
    await user.click(screen.getByRole("button", { name: "Notifications, attention available" }));
    const group = screen.getByRole("region", { name: "Provider service" });
    expect(within(group).getAllByText(/reports service issues/)).toHaveLength(2);
    const links = within(group).getAllByRole("link", { name: "View incident (opens in a new tab)" });
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(expect.arrayContaining(["https://status.openai.com/incidents/codex-incident-1", "https://status.claude.com/incidents/claude-incident-1"]));
  });

  it("deduplicates repeated snapshots, preserves acknowledgement across close/reopen, and reopens for recurrence or worsening", async () => {
    const user = userEvent.setup();
    providerState.current = snapshot([provider("codex"), provider("claude", { status: "operational", incidentKey: null, incidents: [] })]);
    const view = render(shell([session("codex")]));
    const open = () => user.click(screen.getByRole("button", { name: /Notifications/ }));
    await open();
    expect(screen.getByRole("region", { name: "Provider service" })).toHaveTextContent("Codex reports service issues");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("2 unread notifications");
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(screen.getByRole("contentinfo")).toHaveTextContent("You are all caught up");
    await user.click(screen.getByRole("button", { name: "Close notifications" }));
    await open();
    expect(screen.getByRole("contentinfo")).toHaveTextContent("You are all caught up");
    providerState.current = snapshot([provider("codex", { checkedAt: "2026-09-02T12:01:00.000Z" }), provider("claude", { status: "operational", incidentKey: null, incidents: [] })], 2);
    view.rerender(shell([session("codex")]));
    expect(screen.getByRole("region", { name: "Provider service" })).toHaveTextContent("Codex reports service issues");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("You are all caught up");
    providerState.current = snapshot([provider("codex", { incidentKey: "codex-incident-2" }), provider("claude", { status: "operational", incidentKey: null, incidents: [] })], 3);
    view.rerender(shell([session("codex")]));
    expect(screen.getByRole("contentinfo")).toHaveTextContent("1 unread notification");
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    providerState.current = snapshot([provider("codex", { status: "outage", incidentKey: "codex-incident-2", incidents: [{ ...provider("codex").incidents[0], id: "codex-incident-2", impact: "major" }] }), provider("claude", { status: "operational", incidentKey: null, incidents: [] })], 4);
    view.rerender(shell([session("codex")]));
    expect(screen.getByRole("contentinfo")).toHaveTextContent("1 unread notification");
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    providerState.current = snapshot([provider("codex", { status: "degraded", incidentKey: "codex-incident-2", incidents: [{ ...provider("codex").incidents[0], id: "codex-incident-2", impact: "minor" }] }), provider("claude", { status: "operational", incidentKey: null, incidents: [] })], 5);
    view.rerender(shell([session("codex")]));
    expect(screen.getByRole("contentinfo")).toHaveTextContent("You are all caught up");
    providerState.current = snapshot([provider("codex", { status: "operational", incidentKey: null, incidents: [] }), provider("claude", { status: "operational", incidentKey: null, incidents: [] })], 6);
    view.rerender(shell([session("codex")]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Provider service" })).toBeNull());
    providerState.current = snapshot([provider("codex"), provider("claude", { status: "operational", incidentKey: null, incidents: [] })], 7);
    view.rerender(shell([session("codex")]));
    expect(screen.getByRole("contentinfo")).toHaveTextContent("1 unread notification");
  });
});
