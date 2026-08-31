import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "../../app/HomeDashboard";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { HOME_PREFERENCES_STORAGE_KEY, HOME_UPDATE_ID } from "../../app/hooks/useHomePreferences";
import { SessionsView } from "../../app/components/command-center/CommandViews";
import SessionsPage from "../../app/sessions/page";
import type { SessionSummary } from "../../shared/monitor-contract";

const sessions: SessionSummary[] = [
  { id: "codex:build-home", provider: "codex", source: "Codex", title: "Build Home", project: "Pomegr", updatedAt: "2026-08-30T12:00:00Z", isLive: true, needsInput: false, activityStatus: "working", summaryReadiness: "ready", agentCount: 2, activeAgentCount: 1, latestContextTotal: 12345, progress: null, currentActivity: null },
  { id: "claude:report", provider: "claude", source: "Claude Code", title: "Review report", project: "Other project", updatedAt: "2026-08-29T12:00:00Z", isLive: false, needsInput: false, activityStatus: "unknown", summaryReadiness: "ready", agentCount: 1, activeAgentCount: 0, latestContextTotal: 67890, progress: null, currentActivity: null },
];

function seed(pins: object[] = [], lastViewedSessionId: string | null = null) {
  window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins, lastViewedSessionId }));
}
function home(rows = sessions, state: { loading?: boolean; connected?: boolean } = {}) {
  return render(<SessionCatalogProvider sessions={rows} {...state}><HomeDashboard /></SessionCatalogProvider>);
}

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

describe("personal Home", () => {
  it("dismisses the prominent update without losing navigation preferences", async () => {
    seed([{ kind: "session", id: sessions[0].id }], sessions[1].id);
    const user = userEvent.setup();
    const view = home();
    const update = screen.getByRole("complementary", { name: "What’s new" });
    const navigation = screen.getByRole("region", { name: "Sessions" });
    expect(update.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss this update" }));
    expect(screen.queryByRole("heading", { name: "What’s new" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse sessions" })).toHaveFocus();
    expect(JSON.parse(window.localStorage.getItem(HOME_PREFERENCES_STORAGE_KEY)!)).toEqual({
      version: 1, pins: [{ kind: "session", id: sessions[0].id }],
      lastViewedSessionId: sessions[1].id, dismissedUpdateId: HOME_UPDATE_ID,
    });
    view.unmount();
    home();
    expect(screen.queryByRole("button", { name: "Dismiss this update" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Build Home · Pomegr · Codex" })).toBeInTheDocument();
    act(() => {
      window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({
        version: 1, pins: [], lastViewedSessionId: null, dismissedUpdateId: "older-update",
      }));
      window.dispatchEvent(new StorageEvent("storage", { key: HOME_PREFERENCES_STORAGE_KEY }));
    });
    expect(screen.getByRole("heading", { name: "What’s new" })).toBeInTheDocument();
  });

  it("offers navigation with a compact local provider-status exception", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Local test monitor unavailable"));
    const { container } = home();
    expect(screen.getByRole("heading", { name: "Welcome to Pomegr" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Sessions" })).getByRole("heading", { name: "Pinned destinations", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What’s new" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose a session" })).toHaveAttribute("href", "/sessions");
    for (const name of ["Usage & activity", "Active now", "Open · Idle", "All-agent context", "Active agents"]) expect(screen.queryByText(name)).not.toBeInTheDocument();
    expect(container.querySelector("progress")).not.toBeInTheDocument();
    expect(screen.queryByText("12,345")).not.toBeInTheDocument();
    expect(screen.queryByText("Build Home")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Session coach" })).toHaveTextContent("Coming soon");
    expect(screen.getByRole("region", { name: "Session coach" })).toHaveTextContent("opt-in");
    expect(within(screen.getByRole("region", { name: "Session coach" })).queryByRole("button")).not.toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Provider status" })).getByRole("heading", { name: "Provider status", level: 2 })).toBeInTheDocument();
    await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(fetchMock).toHaveBeenCalled();
    for (const [input] of fetchMock.mock.calls) expect(String(input)).toMatch(/^\/api\/provider-status(?:\?revision=\d+)?$/);
  });

  it("pins a selected session, persists only its identity, and can unpin it", async () => {
    const user = userEvent.setup();
    const view = home();
    await user.click(screen.getByText("Add pins"));
    await user.click(screen.getByRole("button", { name: "Pin Build Home" }));
    expect(screen.getByRole("list", { name: "Pinned destinations" })).toHaveTextContent("Build Home");
    expect(JSON.parse(window.localStorage.getItem(HOME_PREFERENCES_STORAGE_KEY)!)).toEqual({ version: 1, pins: [{ kind: "session", id: "codex:build-home" }], lastViewedSessionId: null });
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Add pins")).toHaveFocus();
    view.unmount();
    home();
    expect(screen.getByRole("link", { name: "Build Home · Pomegr · Codex" })).toHaveAttribute("href", "/sessions/codex-build-home");
    await user.click(screen.getByRole("button", { name: "Unpin Build Home" }));
    expect(screen.queryByRole("list", { name: "Pinned destinations" })).not.toBeInTheDocument();
    expect(screen.getByText("Add pins")).toHaveFocus();
  });

  it("pins a project to an exact project-filtered session destination", async () => {
    const user = userEvent.setup();
    home();
    await user.click(screen.getByText("Add pins"));
    await user.selectOptions(screen.getByLabelText("Destination type"), "project");
    await user.click(screen.getByRole("button", { name: "Pin Other project" }));
    expect(screen.getByRole("link", { name: "Other project · Project sessions" })).toHaveAttribute("href", "/sessions?project=Other%20project");
  });

  it("keeps views pinnable without a catalog and does not claim no sessions while loading", async () => {
    const user = userEvent.setup();
    home([], { loading: true });
    expect(screen.getByRole("heading", { name: "Session coach" })).toBeInTheDocument();
    await user.click(screen.getByText("Add pins"));
    expect(screen.getByText("Loading destinations from the local monitor…")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Destination type"), "view");
    await user.click(screen.getByRole("button", { name: "Pin Usage limits" }));
    expect(screen.getByRole("link", { name: "Usage limits · Provider account windows" })).toHaveAttribute("href", "/usage-limits");
    expect(screen.queryByText("No open sessions yet.")).not.toBeInTheDocument();
  });

  it("retains unavailable pins through catalog failure and restores their labels on recovery", () => {
    seed([{ kind: "session", id: sessions[0].id }], sessions[0].id);
    const view = home([], { connected: false });
    expect(screen.getByText("Not in the current catalog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpin Pinned session 1" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: /Open last viewed/ })).not.toBeInTheDocument();
    view.rerender(<SessionCatalogProvider sessions={sessions}><HomeDashboard /></SessionCatalogProvider>);
    expect(screen.getByRole("link", { name: "Open last viewed session: Build Home" })).toHaveAttribute("href", "/sessions/codex-build-home");
    expect(screen.getByRole("button", { name: "Unpin Build Home" })).toBeInTheDocument();
  });

  it("uses last-viewed history rather than newest or currently active work", () => {
    seed([], sessions[1].id);
    home();
    expect(screen.getByRole("link", { name: "Open last viewed session: Review report" })).toHaveAttribute("href", "/sessions/claude-report");
    expect(screen.queryByRole("link", { name: /Open last viewed session Build Home/ })).not.toBeInTheDocument();
  });

  it("reflects updated catalog labels without changing saved identities", () => {
    seed([{ kind: "session", id: sessions[0].id }]);
    const view = home();
    view.rerender(<SessionCatalogProvider sessions={[{ ...sessions[0], title: "Renamed work" }]}><HomeDashboard /></SessionCatalogProvider>);
    expect(screen.getByRole("link", { name: "Renamed work · Pomegr · Codex" })).toHaveAttribute("href", "/sessions/codex-build-home");
    expect(window.localStorage.getItem(HOME_PREFERENCES_STORAGE_KEY)).not.toContain("Renamed work");
  });

  it("opens project pins with an exact, removable filter", async () => {
    const page = await SessionsPage({ searchParams: Promise.resolve({ project: "Pomegr" }) });
    render(<SessionCatalogProvider sessions={sessions}>{page}</SessionCatalogProvider>);
    expect(screen.getByText("Build Home")).toBeInTheDocument();
    expect(screen.queryByText("Review report")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear project filter: Pomegr" }));
    expect(screen.getByText("Review report")).toBeInTheDocument();
  });

  it("does not use session-title matches when filtering a pinned project", () => {
    render(<SessionCatalogProvider sessions={[...sessions, { ...sessions[1], id: "claude:other", title: "Pomegr work" }]}><SessionsView initialProject="Pomegr" /></SessionCatalogProvider>);
    expect(screen.getByText("Build Home")).toBeInTheDocument();
    expect(screen.queryByText("Pomegr work")).not.toBeInTheDocument();
  });
});
