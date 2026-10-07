import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderServiceStatus, ProviderStatusSnapshot, SessionSummary } from "../../shared/monitor-contract";
import type { NotificationRecord, NotificationSnapshot } from "../../shared/notification-contract";

const providerState = vi.hoisted(() => ({ current: { revision: 1, generatedAt: null, providers: [] } as ProviderStatusSnapshot }));
const notificationState = vi.hoisted(() => ({ current: { snapshot: { version: 1, revision: 0, generatedAt: null,
  readiness: { catalog: "ready", providerStatus: "ready" }, occurrences: [], activeSessionOverflow: 0 }, status: "ready" } as {
    snapshot: NotificationSnapshot; status: "ready" | "loading" | "unavailable";
  } }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../app/provider-status-client", async () => ({
  ...(await vi.importActual<typeof import("../../app/provider-status-client")>("../../app/provider-status-client")),
  useProviderStatus: () => providerState.current,
}));
vi.mock("../../app/notifications-client", () => ({ useNotificationSnapshot: () => notificationState.current }));

import { CommandCenterShell } from "../../app/components/command-center/CommandCenterShell";
import { SessionsView } from "../../app/components/command-center/CommandViews";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { installDirectoryFixture } from "./session-directory-test-fixture";

const checkedAt = "2026-09-02T12:00:00.000Z";
function occurrence(kind: "provider_incident" | "provider_recovery", providerId: "claude" | "codex", id: string): NotificationRecord {
  const common = { id, category: "provider_service" as const, severity: kind === "provider_recovery" ? "info" as const : "warning" as const,
    lifecycle: kind === "provider_recovery" ? "resolved" as const : "active" as const, priority: 70,
    occurredAt: checkedAt, timeBasis: "observed" as const, deliveryEligible: true, action: "open_providers" as const };
  return kind === "provider_incident" ? { ...common, kind, provider: providerId, data: { status: "degraded" } }
    : { ...common, kind, provider: providerId, data: { status: "operational" } };
}
function setNotifications(occurrences: NotificationRecord[], revision = 1, status: "ready" | "loading" | "unavailable" = "ready") {
  notificationState.current = { status, snapshot: { version: 1, revision, generatedAt: checkedAt,
    readiness: { catalog: "ready", providerStatus: "ready" }, occurrences, activeSessionOverflow: 0 } };
}

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
  setNotifications([], 0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("provider service warnings", () => {
  it.each(["claude", "codex"] as const)("shows only the matching fresh provider warning on live %s rows", async (providerId) => {
    const other = providerId === "claude" ? "codex" : "claude";
    providerState.current = snapshot([provider(providerId), provider(other, { status: "operational", incidentKey: null, incidents: [] })]);
    const live = session(providerId, true);
    const historical = session(providerId, false);
    const unrelated = session(other, true);
    installDirectoryFixture([live, historical, unrelated]);
    const view = render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);
    await screen.findByText(`${providerId} live session`);
    expect(screen.getAllByText("Degraded service")).toHaveLength(1);
    expect(within(screen.getByText(`${providerId} live session`).closest("tr")!).getByText("Degraded service")).toBeInTheDocument();
    expect(within(screen.getByText(`${other} live session`).closest("tr")!).queryByText("Degraded service")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^All/ }));
    expect(screen.getByText(`${providerId} live session`)).toBeInTheDocument();
    expect(screen.getByText(`${providerId} history session`)).toBeInTheDocument();
    expect(screen.getByText(`${other} live session`)).toBeInTheDocument();
    expect(screen.getAllByText("Degraded service")).toHaveLength(1);
    view.unmount();
    installDirectoryFixture([historical]);
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);
    await screen.findByText(`${providerId} history session`);
    expect(screen.queryByText("Degraded service")).toBeNull();
  });

  it.each(["stale", "unknown", "loading", "operational"] as const)("excludes %s status from live row and notification warnings", async (scenario) => {
    const status = scenario === "unknown" ? "unknown" : scenario === "operational" ? "operational" : "degraded";
    providerState.current = snapshot([provider("codex", { status, freshness: scenario === "stale" ? "stale" : "fresh", readiness: scenario === "loading" ? "loading" : "ready", incidentKey: scenario === "operational" ? null : "codex-incident-1", incidents: scenario === "operational" ? [] : provider("codex").incidents }), provider("claude", { status: "operational", incidentKey: null, incidents: [] })]);
    installDirectoryFixture([session("codex")]);
    render(<SessionCatalogProvider sessions={[]}><SessionsView /></SessionCatalogProvider>);
    await screen.findByText("codex live session");
    expect(screen.queryByText("Degraded service")).toBeNull();
    render(shell([session("codex")]));
    expect(screen.getByRole("button", { name: "Notifications" })).not.toHaveAccessibleName(/attention available/);
  });

  it("keeps the last committed issue visible while notification refresh is delayed", async () => {
    setNotifications([occurrence("provider_incident", "codex", "a".repeat(32))], 1, "unavailable");
    const user = userEvent.setup();
    render(shell([session("codex")]));
    await user.click(screen.getByRole("button", { name: "Notifications, attention available" }));
    const tray = screen.getByTestId("notification-center");
    expect(tray).toHaveTextContent("Notification updates are delayed. Showing last known state.");
    expect(tray).toHaveTextContent("Codex reports service issues");
  });

  it("shows independent normalized provider incidents with only a fixed internal action", async () => {
    const user = userEvent.setup();
    providerState.current = snapshot([provider("codex"), provider("claude")]);
    setNotifications([occurrence("provider_incident", "codex", "a".repeat(32)), occurrence("provider_incident", "claude", "b".repeat(32))]);
    render(shell([session("codex"), session("claude")]));
    await user.click(screen.getByRole("button", { name: "Notifications, attention available" }));
    const group = screen.getByTestId("notification-center");
    expect(within(group).getAllByText(/reports service issues/)).toHaveLength(2);
    expect(within(group).getAllByText("Provider service")).toHaveLength(2);
    expect(within(group).getAllByRole("link", { name: "View providers" }).map((link) => link.getAttribute("href"))).toEqual(["/usage-limits", "/usage-limits"]);
    expect(group).not.toHaveTextContent("Elevated errors");
  });

  it("keeps acknowledgement for one occurrence and shows recovery and recurrence separately", async () => {
    const user = userEvent.setup();
    setNotifications([occurrence("provider_incident", "codex", "a".repeat(32))]);
    const view = render(shell([session("codex")]));
    const open = () => user.click(screen.getByRole("button", { name: /Notifications/ }));
    await open();
    expect(screen.getByRole("contentinfo")).toHaveTextContent("1 unread notification");
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await user.click(screen.getByRole("button", { name: "Close notifications" }));
    await open();
    expect(screen.getByRole("contentinfo")).toHaveTextContent("You are all caught up");
    setNotifications([occurrence("provider_incident", "codex", "a".repeat(32))], 2);
    view.rerender(shell([session("codex")]));
    expect(screen.getByRole("contentinfo")).toHaveTextContent("You are all caught up");
    setNotifications([occurrence("provider_recovery", "codex", "b".repeat(32))], 3);
    view.rerender(shell([session("codex")]));
    expect(screen.getByTestId("notification-provider_recovery")).toHaveTextContent("service restored");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("1 unread notification");
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    setNotifications([occurrence("provider_recovery", "codex", "b".repeat(32)), occurrence("provider_incident", "codex", "c".repeat(32))], 4);
    view.rerender(shell([session("codex")]));
    expect(screen.getByRole("contentinfo")).toHaveTextContent("1 unread notification");
  });
});
