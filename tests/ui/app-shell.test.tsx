import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Link from "next/link";

const navigation = vi.hoisted(() => ({ pathname: "/", push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}));

// Catalog tests isolate the independent provider-status feed.
vi.mock("../../app/provider-status-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/provider-status-client")>();
  return { ...actual, useProviderStatus: () => actual.EMPTY_PROVIDER_STATUS };
});

import { HOME_PREFERENCES_STORAGE_KEY } from "../../app/hooks/useHomePreferences";
import { AppShell } from "../../app/components/AppShell";
import { ClientAccessProvider } from "../../app/hooks/ClientAccessContext";
import { SessionsView } from "../../app/components/command-center/CommandViews";
import { CommandPageHeader } from "../../app/components/command-center/CommandPage";
import { pomegrMarkVariantForSearch, shortcutHintForPlatform, sidebarLimitsForCatalog } from "../../app/components/command-center/CommandCenterShell";
import type { DesktopState } from "../../app/components/DesktopControls";
import { useSessionCatalog } from "../../app/hooks/SessionCatalogContext";
import pomegrPackageManifest from "../../package.json";
import pomegrPluginManifest from "../../plugins/pomegr/.codex-plugin/plugin.json";
import type { HomeProviderUsageLimits, SessionSummary } from "../../shared/monitor-contract";

function response(body: object) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

const sessions = [
  { id: "claude:live-1", provider: "claude", source: "Claude Code", title: "Live work", project: "Pomegr", updatedAt: "2026-08-24T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working", summaryReadiness: "ready", agentCount: 2, activeAgentCount: 1, latestContextTotal: 12_000, progress: { phase: "implementing", percent: 42, remainingMinutesMin: 3, remainingMinutesMax: 6, confidence: "medium", reportedAt: "2026-08-24T12:00:00.000Z" }, currentActivity: null },
  { id: "codex:input-1", provider: "codex", source: "Codex", title: "Awaiting approval", project: "Pomegr", updatedAt: "2026-08-24T11:59:00.000Z", isLive: true, needsInput: true, activityStatus: "needs_input", summaryReadiness: "ready", agentCount: 1, activeAgentCount: 0, latestContextTotal: 8_000, progress: null, currentActivity: null },
  { id: "codex:history-1", provider: "codex", source: "Codex", title: "Recorded work", project: "Pomegr", updatedAt: "2026-08-23T12:00:00.000Z", isLive: false, needsInput: false, activityStatus: "unknown", summaryReadiness: "ready", agentCount: 1, activeAgentCount: 0, latestContextTotal: 6_000, progress: { phase: "complete", percent: 100, confidence: "high", reportedAt: "2026-08-23T12:00:00.000Z" }, currentActivity: null },
] satisfies SessionSummary[];

function LiveSessionConsumer() {
  const { sessions } = useSessionCatalog();
  return <output aria-label="Shared live sessions">{sessions.filter((session) => session.isLive).map((session) => `${session.title} ${session.progress?.percent ?? 0}%`).join(", ")}</output>;
}

class CatalogEventSource {
  static instances: CatalogEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    CatalogEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (typeof listener !== "function") return;
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener as (event: MessageEvent<string>) => void);
    this.listeners.set(type, listeners);
  }

  emitCatalog(value: object) {
    const event = new MessageEvent("catalog", { data: JSON.stringify(value) });
    for (const listener of this.listeners.get("catalog") || []) listener(event);
  }

  emitOpen() {
    const event = new Event("open");
    for (const listener of this.listeners.get("open") || []) listener(event as MessageEvent<string>);
  }

  close() { this.closed = true; }
}

afterEach(() => {
  vi.useRealTimers();
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  navigation.pathname = "/";
  navigation.push.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Command Center app shell", () => {
  it("keeps route breadcrumbs inside the shared page header", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
    render(<AppShell><CommandPageHeader title="Pomegr" breadcrumb={<><Link href="/sessions">Sessions</Link><span aria-current="page">Pomegr</span></>} /></AppShell>);
    const breadcrumb = screen.getAllByText("Sessions").find((element) => element.closest(".commandPageBreadcrumb"))?.closest(".commandPageBreadcrumb") as HTMLElement | null;
    expect(breadcrumb).toBeInTheDocument();
    if (!breadcrumb) throw new Error("Shared page breadcrumb is missing");
    expect(breadcrumb.closest("header")).toHaveClass("commandPageHeader");
    expect(breadcrumb.closest("header")).not.toHaveClass("commandHeader");
    expect(within(breadcrumb).getByRole("link", { name: "Sessions" })).toHaveAttribute("href", "/sessions");
    expect(within(breadcrumb).getByText("Pomegr")).toHaveAttribute("aria-current", "page");
  });

  it("uses the platform-appropriate global search hint", () => {
    expect(shortcutHintForPlatform("Win32")).toBe("Ctrl K");
    expect(shortcutHintForPlatform("Linux x86_64")).toBe("Ctrl K");
    expect(shortcutHintForPlatform("MacIntel Macintosh")).toBe("⌘ K");
    expect(shortcutHintForPlatform(undefined)).toMatch(/^(Ctrl K|⌘ K)$/);
  });

  it("renders the route rail, bundled MCP version, and live session count", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
    render(<AppShell><h1>Workspace content</h1></AppShell>);
    expect(await screen.findByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("link", { name: "Sessions, 2 live" })).toHaveAttribute("href", "/sessions");
    expect(screen.getByRole("link", { name: "Usage limits" })).toHaveAttribute("href", "/usage-limits");
    expect(screen.getByText(`Pomegr v${pomegrPackageManifest.version}`)).toBeInTheDocument();
    expect(screen.getByText(`MCP v${pomegrPluginManifest.version}`)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Workspace content" })).toBeInTheDocument();
  });

  it("opens a bounded notification tray and marks its entries read", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
    render(<AppShell><main>Home content</main></AppShell>);
    await user.click(await screen.findByRole("button", { name: /Notifications/ }));
    const tray = screen.getByRole("complementary", { name: "Notifications" });
    expect(tray).toHaveTextContent("Awaiting approval");
    expect(tray).toHaveTextContent("Session-reported state may be stale");
    expect(tray).not.toHaveTextContent(/prompt|response|command/i);
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(tray).toHaveTextContent("You are all caught up");
  });

  it("marks real application destinations from the current pathname", async () => {
    navigation.pathname = "/settings";
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions: [] }));
    render(<AppShell><main>Settings content</main></AppShell>);
    expect(await screen.findByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("opens and dismisses the foldable primary menu", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
    render(<AppShell><main>Home content</main></AppShell>);

    const menu = await screen.findByRole("button", { name: "Open primary menu" });
    await user.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Primary navigation" })).toHaveClass("isOpen");

    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Open primary menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the palette, retains focus, and restores the trigger on escape", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
    render(<AppShell><main>Home content</main></AppShell>);

    const openSearch = await screen.findByRole("button", { name: "Search Pomegr" });
    await user.click(openSearch);
    const dialog = screen.getByRole("dialog", { name: "Search Pomegr" });
    const search = screen.getByRole("combobox", { name: "Search Pomegr" });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-controls", "command-palette-results");
    expect(screen.getByRole("listbox", { name: "Search results" })).toBeInTheDocument();
    await user.tab();
    expect(search).toHaveFocus();
    await user.tab({ shift: true });
    expect(search).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    expect(openSearch).toHaveFocus();
  });

  it("opens the profile placeholder and routes global search to known destinations", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
    render(<AppShell><main>Home content</main></AppShell>);
    await user.click(await screen.findByRole("button", { name: /Local profile/ }));
    expect(screen.getByText("Workspace identity and preferences are coming soon.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open settings" })).toHaveAttribute("href", "/settings");

    await user.click(screen.getByRole("button", { name: "Search Pomegr" }));
    const search = screen.getByRole("combobox", { name: "Search Pomegr" });
    await user.type(search, "repositories{enter}");
    expect(navigation.push).toHaveBeenCalledWith("/repositories");
    expect(screen.queryByRole("dialog", { name: "Search Pomegr" })).not.toBeInTheDocument();
  });

  it("uses the palette opener for Ctrl K and closes other shell layers", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
    render(<AppShell><main>Home content</main></AppShell>);
    const notification = await screen.findByRole("button", { name: /Notifications/ });
    await user.click(notification);
    expect(screen.getByRole("complementary", { name: "Notifications" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("complementary", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Search Pomegr" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Open primary menu" }));
    expect(screen.getByRole("complementary", { name: "Primary navigation" })).toHaveClass("isOpen");
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.getByRole("complementary", { name: "Primary navigation" })).not.toHaveClass("isOpen");
  });

  it("shows the tightest available window for every recently observed provider", () => {
    const recent = [
      { ...sessions[0], createdAt: "2026-08-24T12:00:00.000Z" },
      { ...sessions[1], createdAt: "2026-08-24T11:59:00.000Z" },
    ];
    const providers = [
      { provider: "claude", source: "Claude Code", readiness: "ready", usageLimits: { available: true, fetchedAt: null, attemptedAt: null, limits: [
        { id: "five-hour", label: "Five hour", window: "5 hours", percent: 74, resetsAt: null, severity: "normal", active: true },
        { id: "seven-day", label: "Seven day", window: "7 days", percent: 85, resetsAt: null, severity: "critical", active: false },
      ] } },
      { provider: "codex", source: "Codex", readiness: "ready", usageLimits: { available: true, fetchedAt: null, attemptedAt: null, limits: [
        { id: "codex-primary", label: "Codex", window: "5 hours", percent: 64, resetsAt: null, severity: "normal", active: false },
        { id: "codex-secondary", label: "Codex", window: "7 days", percent: 78, resetsAt: null, severity: "warning", active: false },
      ] } },
    ] satisfies HomeProviderUsageLimits[];

    expect(sidebarLimitsForCatalog(recent, providers, Date.parse("2026-08-24T13:00:00.000Z"))).toEqual([
      { provider: "Claude Code", percent: 85, label: "7 days" },
      { provider: "Codex", percent: 78, label: "7 days" },
    ]);
    expect(sidebarLimitsForCatalog(recent, [{ ...providers[1], usageLimits: { ...providers[1].usageLimits, limits: [] } }], Date.parse("2026-08-24T13:00:00.000Z"))).toEqual([]);
  });

  it("keeps the desktop update offer in the persistent rail", async () => {
    const user = userEvent.setup();
    const state: DesktopState = { paused: false, launchAtLogin: false, launchAtLoginAvailable: true, closeBehavior: "ask", notifications: true, notificationQuietUntil: null, displayPreferences: { estimatedCost: true }, update: { status: "ready", version: "1.2.3" } };
    const installUpdate = vi.fn(async () => ({ ...state, update: { status: "installing" as const, version: "1.2.3" } }));
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { getDesktopState: async () => state, installUpdate, onDesktopStateChanged: () => () => {} };
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions: [] }));
    render(<AppShell><main>Home content</main></AppShell>);
    const action = await screen.findByRole("button", { name: "Restart Pomegr to update to version 1.2.3" });
    expect(action.closest(".commandSidebarFoot")).toBeInTheDocument();
    await user.click(action);
    expect(installUpdate).toHaveBeenCalledOnce();
  });

  it("halts session-catalog polling while desktop Pause is active and resumes it once Pause clears", async () => {
    vi.useFakeTimers();
    const desktopState: DesktopState = { paused: false, launchAtLogin: false, launchAtLoginAvailable: true, closeBehavior: "ask", notifications: true, notificationQuietUntil: null, displayPreferences: { estimatedCost: true }, update: { status: "idle", version: null } };
    let notify!: (next: DesktopState) => void;
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = {
      getDesktopState: async () => desktopState,
      installUpdate: vi.fn(),
      onDesktopStateChanged: (callback: (next: DesktopState) => void) => { notify = callback; return () => {}; },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
    const catalogCalls = () => fetchMock.mock.calls.filter(([input]) => input === "/api/sessions").length;
    render(<AppShell><main>Home content</main></AppShell>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    const baseline = catalogCalls();
    expect(baseline).toBeGreaterThan(0);
    act(() => notify({ ...desktopState, paused: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const pausedCount = catalogCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(catalogCalls()).toBe(pausedCount);
    act(() => notify({ ...desktopState, paused: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(catalogCalls()).toBeGreaterThan(pausedCount);
  });

  it("shares one catalog poll with route consumers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
    render(<AppShell><LiveSessionConsumer /></AppShell>);
    await waitFor(() => expect(screen.getByRole("status", { name: "Shared live sessions" })).toHaveTextContent("Live work 42%, Awaiting approval 0%"));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => input === "/api/sessions")).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({ cache: "no-store" }));
  });

  it("refreshes the catalog immediately when a safe revision event arrives", async () => {
    CatalogEventSource.instances = [];
    vi.stubGlobal("EventSource", CatalogEventSource);
    const added = {
      ...sessions[0],
      id: "codex:live-2",
      title: "New live work",
      createdAt: "2026-08-24T12:01:00.000Z",
      updatedAt: "2026-08-24T12:01:00.000Z",
    };
    let sessionRequest = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).startsWith("/api/sessions")) return response(sessionRequest++ ? { revision: 2, sessions: [...sessions, added] } : { revision: 1, sessions });
      return response({ providers: [], repositories: [] });
    });
    const view = render(<AppShell><LiveSessionConsumer /></AppShell>);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/sessions")).length).toBe(1));
    expect(CatalogEventSource.instances).toHaveLength(1);
    expect(CatalogEventSource.instances[0].url).toBe("/api/events");

    act(() => CatalogEventSource.instances[0].emitCatalog({ domain: "sessions", revision: 2 }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Shared live sessions" })).toHaveTextContent("New live work 42%"));
    const sessionCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/sessions"));
    expect(sessionCalls).toHaveLength(2);
    expect(sessionCalls[1][0]).toBe("/api/sessions?revision=1");

    view.unmount();
    expect(CatalogEventSource.instances[0].closed).toBe(true);
  });

  it("clears current activity on the catalog revision event without waiting for recovery polling", async () => {
    CatalogEventSource.instances = [];
    vi.stubGlobal("EventSource", CatalogEventSource);
    const current: SessionSummary = { ...sessions[0], currentActivity: {
      label: "Verifying current work", observedAt: sessions[0].updatedAt, state: "current",
    } };
    let sessionRequest = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).startsWith("/api/sessions")) return response(sessionRequest++ ? { revision: 2, sessions: [{ ...current, activityStatus: "idle", currentActivity: null }] } : { revision: 1, sessions: [current] });
      return response({ providers: [], repositories: [] });
    });
    const view = render(<AppShell><SessionsView /></AppShell>);
    expect(await screen.findAllByLabelText(/^Current activity:/)).toHaveLength(2);
    act(() => CatalogEventSource.instances[0].emitCatalog({ domain: "sessions", revision: 2 }));
    await waitFor(() => expect(screen.queryByLabelText(/^Current activity:/)).not.toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Activity is unavailable" })).toHaveLength(2);
    expect(view.container.querySelector(".commandTableActivityMark")).toBeNull();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/sessions"))).toHaveLength(2);
    view.unmount();
  });

  it("offers paired LAN viewers a recovery path after an authenticated request is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (input === "/api/client-access") return response({ mode: "lan", canCopyTranscriptPath: false });
      return Promise.resolve(new Response(JSON.stringify({ error: "Pairing required" }), { status: 401 }));
    });
    render(<ClientAccessProvider><AppShell><main>Home content</main></AppShell></ClientAccessProvider>);
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Phone access expired");
    expect(screen.getByRole("link", { name: "Scan a new code on your computer" })).toHaveAttribute("href", "/__pomegr/pair");
  });

  it("supports both compact product-mark variants for live comparison", () => {
    expect(pomegrMarkVariantForSearch("?logo=divided")).toBe("divided");
    expect(pomegrMarkVariantForSearch("?logo=outline")).toBe("outline");
    expect(pomegrMarkVariantForSearch("?view=home")).toBe("divided");
  });

  it("keeps live sessions ordered by creation time descending across refreshed activity", async () => {
    vi.useFakeTimers();
    CatalogEventSource.instances = [];
    vi.stubGlobal("EventSource", CatalogEventSource);
    const first = { ...sessions[0], id: "codex:first", title: "Created first", createdAt: "2026-08-24T11:58:00.000Z", updatedAt: "2026-08-24T11:58:00.000Z" };
    const second = { ...sessions[0], id: "codex:second", title: "Created second", createdAt: "2026-08-24T11:59:00.000Z", updatedAt: "2026-08-24T11:59:00.000Z" };
    const refreshedSecond = { ...second, updatedAt: "2026-08-24T12:01:00.000Z", activityStatus: "idle" as const, progress: { ...second.progress!, percent: 100 } };
    let sessionRequest = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).startsWith("/api/sessions")) return response(sessionRequest++ ? { sessions: [refreshedSecond, first] } : { sessions: [first, second] });
      return response({ providers: [], repositories: [] });
    });
    render(<AppShell><LiveSessionConsumer /></AppShell>);
    act(() => CatalogEventSource.instances[0].emitOpen());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status", { name: "Shared live sessions" })).toHaveTextContent("Created second 42%, Created first 42%");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/sessions"))).toHaveLength(2);
    expect(screen.getByRole("status", { name: "Shared live sessions" })).toHaveTextContent("Created second 100%, Created first 42%");
  });

  it("retains the catalog and restores its online state when a real 204 follows a transient failure", async () => {
    vi.useFakeTimers();
    let sessionRequest = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (!String(input).startsWith("/api/sessions")) return response({ providers: [], repositories: [] });
      const status = sessionRequest++;
      if (status === 0) return Promise.resolve(new Response(JSON.stringify({ revision: 1, sessions }), { status: 200, headers: { "Content-Type": "application/json" } }));
      return Promise.resolve(new Response(null, { status: status === 1 ? 503 : 204 }));
    });
    render(<AppShell><LiveSessionConsumer /></AppShell>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status", { name: "Shared live sessions" })).toHaveTextContent("Live work 42%");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("Monitor offline")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("Local monitor")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Shared live sessions" })).toHaveTextContent("Live work 42%");
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/sessions"))).toHaveLength(3);
  });
});

it("records only visited, catalog-backed session IDs for the Home return shortcut", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions }));
  navigation.pathname = "/sessions/claude-live-1";
  const view = render(<AppShell><div>Session detail</div></AppShell>);
  await waitFor(() => expect(JSON.parse(window.localStorage.getItem(HOME_PREFERENCES_STORAGE_KEY) || "null")?.lastViewedSessionId).toBe("claude:live-1"));
  navigation.pathname = "/sessions/codex-history-1";
  view.rerender(<AppShell><div>Historical detail</div></AppShell>);
  await waitFor(() => expect(JSON.parse(window.localStorage.getItem(HOME_PREFERENCES_STORAGE_KEY) || "null")?.lastViewedSessionId).toBe("codex:history-1"));
  navigation.pathname = "/sessions/codex-missing";
  view.rerender(<AppShell><div>Missing detail</div></AppShell>);
  expect(JSON.parse(window.localStorage.getItem(HOME_PREFERENCES_STORAGE_KEY)!).lastViewedSessionId).toBe("codex:history-1");
  expect(window.localStorage.getItem(HOME_PREFERENCES_STORAGE_KEY)).not.toMatch(/Recorded work|Live work|Pomegr/);
});
