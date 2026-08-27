import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/about", push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}));

import { AppShell } from "../../app/components/AppShell";
import { NavigationMenuButton } from "../../app/components/NavigationMenuButton";
import type { DesktopState } from "../../app/components/DesktopControls";
import { useSessionCatalog } from "../../app/hooks/SessionCatalogContext";
import pomegrPluginManifest from "../../plugins/pomegr/.codex-plugin/plugin.json";
import type { LiveSessionSummary } from "../../shared/monitor-contract";

function response(body: object) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

const sessions = [
  { id: "claude:live-1", provider: "claude", source: "Claude Code", title: "Live work", project: "Pomegr", updatedAt: "2026-08-24T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working" },
  { id: "codex:input-1", provider: "codex", source: "Codex", title: "Awaiting approval", project: "Pomegr", updatedAt: "2026-08-24T11:59:00.000Z", isLive: true, needsInput: true, activityStatus: "needs_input" },
  { id: "claude:idle-1", provider: "claude", source: "Claude Code", title: "Open yesterday", project: "Pomegr", updatedAt: "2026-08-23T14:00:00.000Z", isLive: true, needsInput: false, activityStatus: "idle" },
  { id: "codex:open-1", provider: "codex", source: "Codex", title: "Unobserved open session", project: "Pomegr", updatedAt: "2026-08-23T13:00:00.000Z", isLive: true, needsInput: false, activityStatus: "unknown" },
  { id: "codex:history-1", provider: "codex", source: "Codex", title: "Recorded work", project: "Pomegr", updatedAt: "2026-08-23T12:00:00.000Z", isLive: false, needsInput: false, activityStatus: "unknown" },
] as const;

const liveSessions = [{
  ...sessions[0],
  agentCount: 2,
  activeAgentCount: 1,
  latestContextTotal: 12_000,
  progress: { phase: "implementing", percent: 42, remainingMinutesMin: 3, remainingMinutesMax: 6, confidence: "medium", reportedAt: "2026-08-24T12:00:00.000Z" },
}] satisfies LiveSessionSummary[];

function LiveSessionConsumer() {
  const { liveSessions } = useSessionCatalog();
  return <output aria-label="Shared live sessions">{liveSessions.map((session) => `${session.title} ${session.progress?.percent ?? 0}%`).join(", ")}</output>;
}

afterEach(() => {
  vi.useRealTimers();
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  navigation.pathname = "/about";
  navigation.push.mockReset();
  vi.restoreAllMocks();
});

describe("shared app shell", () => {
  it("shows the bundled MCP version at the bottom of the sidebar", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions: [], liveSessions: [] }));

    render(<AppShell><main>Home content</main></AppShell>);

    const version = screen.getByText("MCP version").closest(".sidebarMcpVersion");
    expect(version).toHaveTextContent(`MCP versionv${pomegrPluginManifest.version}`);
    expect(version?.parentElement).toHaveClass("sidebarFooter");
  });

  it("shows the same live and historical catalog on Home", async () => {
    navigation.pathname = "/";
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions, liveSessions: [] }));

    render(<AppShell><main><h1>Home content</h1></main></AppShell>);

    expect(await screen.findByRole("link", { name: "Home — open sessions" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("HISTORY")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Live work/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Live work.*Working now/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Awaiting approval.*Needs input/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open yesterday.*Idle/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unobserved open session.*Open/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Pomegr1$/ })).toBeInTheDocument();
  });

  it("keeps the canonical live and history navigation beside About and routes session selection", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions, liveSessions: [] }));

    render(<AppShell><main><NavigationMenuButton /><h1>About content</h1></main></AppShell>);

    expect(await screen.findByRole("complementary", { name: "Session navigation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "About content" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "About Pomegr" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("HISTORY")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Live work/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Pomegr1$/ }));
    await user.click(screen.getByRole("button", { name: /Recorded work/ }));
    expect(navigation.push).toHaveBeenCalledWith("/sessions/codex-history-1");

    await user.click(screen.getByRole("button", { name: "Open session navigation" }));
    expect(screen.getByRole("complementary", { name: "Session navigation" })).toHaveClass("open");
  });

  it("keeps the desktop update offer in the persistent sidebar", async () => {
    const user = userEvent.setup();
    let listener: ((next: DesktopState) => void) | undefined;
    const state: DesktopState = { paused: false, launchAtLogin: false, launchAtLoginAvailable: true, closeBehavior: "ask", notifications: true, notificationQuietUntil: null, update: { status: "ready", version: "1.2.3" } };
    const installUpdate = vi.fn(async () => ({ ...state, update: { status: "installing" as const, version: "1.2.3" } }));
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = {
      getDesktopState: async () => state,
      installUpdate,
      onDesktopStateChanged(callback: (next: DesktopState) => void) { listener = callback; return () => { listener = undefined; }; },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions: [], liveSessions: [] }));

    render(<AppShell><main>Home content</main></AppShell>);
    const action = await screen.findByRole("button", { name: "Restart Pomegr to update to version 1.2.3" });
    expect(action.closest(".sidebarFooter")).toBeInTheDocument();
    await user.click(action);
    expect(installUpdate).toHaveBeenCalledOnce();
    act(() => listener?.({ ...state, update: { status: "installing", version: "1.2.3" } }));
    expect(await screen.findByRole("button", { name: "Restarting Pomegr to update to version 1.2.3" })).toBeDisabled();
  });

  it("shares one catalog poll between the sidebar and live-session consumers", async () => {
    navigation.pathname = "/";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ sessions, liveSessions }));

    render(<AppShell><LiveSessionConsumer /></AppShell>);

    expect(await screen.findByRole("button", { name: /Live work.*Working now/ })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Shared live sessions" })).toHaveTextContent("Live work 42%");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({ cache: "no-store" }));
  });

  it("keeps live-session creation order when refreshed activity changes the incoming order", async () => {
    vi.useFakeTimers();
    navigation.pathname = "/";
    const first = { ...liveSessions[0], id: "codex:first", title: "Created first", updatedAt: "2026-08-24T11:58:00.000Z" };
    const second = { ...liveSessions[0], id: "codex:second", title: "Created second", updatedAt: "2026-08-24T11:59:00.000Z" };
    const refreshedSecond = { ...second, updatedAt: "2026-08-24T12:01:00.000Z", activityStatus: "idle" as const, progress: { ...second.progress!, percent: 100 } };
    const catalogSessions = (items: LiveSessionSummary[]) => items.map((session) => ({
      id: session.id,
      provider: session.provider,
      source: session.source,
      title: session.title,
      project: session.project,
      updatedAt: session.updatedAt,
      isLive: session.isLive,
      needsInput: session.needsInput,
      activityStatus: session.activityStatus,
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response({ sessions: catalogSessions([first, second]), liveSessions: [first, second] }))
      .mockImplementationOnce(() => response({ sessions: catalogSessions([refreshedSecond, first]), liveSessions: [refreshedSecond, first] }));

    render(<AppShell><LiveSessionConsumer /></AppShell>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status", { name: "Shared live sessions" })).toHaveTextContent("Created first 42%, Created second 42%");

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status", { name: "Shared live sessions" })).toHaveTextContent("Created first 42%, Created second 100%");
    expect(screen.getByRole("button", { name: /Created second.*Idle/ })).toBeInTheDocument();
  });
});
