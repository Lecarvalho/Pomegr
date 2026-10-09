import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: navigation.replace }) }));

// Wraps the real AgentsTab with one extra button that invokes its `onOpenActivities` prop with
// both `agentId` and `request` set. AgentsTab itself only ever passes `{ agentId }` (see
// AgentsTab.tsx:69); Dashboard.tsx's own onOpenActivities wrapper is what adds `request: null`
// before calling `navigate`. No current AgentsTab control invokes onOpenActivities with a
// *different* agent than the one already selected, so this is the only way to exercise
// Dashboard.tsx's own `navigate` guard for "an explicit request survives an agent change"
// without touching the owned AgentsTab.tsx file.
vi.mock("../../app/components/dashboard/AgentsTab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/components/dashboard/AgentsTab")>();
  return {
    ...actual,
    AgentsTab: (props: Parameters<typeof actual.AgentsTab>[0]) => <>
      <actual.AgentsTab {...props} />
      <button type="button" onClick={() => props.onOpenActivities({ agentId: "secondary", request: "request-9" })}>Open secondary activities with an explicit request</button>
    </>,
  };
});

// Wraps the real ActivitiesTab with one button that invokes its `onOpenAgent` prop directly, so
// Dashboard.tsx's own `navigate({ tab: "agents", agent, request: null })` wiring (the explicit
// clear, not the `navigate` auto-clear guard already covered above) is exercised without needing
// a full session-history fixture.
vi.mock("../../app/components/dashboard/ActivitiesTab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/components/dashboard/ActivitiesTab")>();
  return {
    ...actual,
    ActivitiesTab: (props: Parameters<typeof actual.ActivitiesTab>[0]) =>
      <button type="button" onClick={() => props.onOpenAgent("primary")}>Open primary from Activities</button>,
  };
});

import { Dashboard } from "../../app/Dashboard";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { DisplayPreferencesProvider } from "../../app/hooks/DisplayPreferencesContext";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { resetSessionDomainStoreForTests } from "../../app/session-domain-store";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import type { MonitorState, SessionSummary } from "../../shared/monitor-contract";
import type { SignalsDomain } from "../../shared/session-domain-contract";
import { repositorySession } from "./dashboard-test-fixtures";
import { sessionSummaryFixture } from "./session-summary-test-fixture";

const SESSION_ID = "claude:summary-fixture";
function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function catalog(overrides: Partial<SessionSummary> = {}): SessionSummary { return { id: SESSION_ID, provider: "claude", source: "Claude Code", title: "Recorded implementation session", project: "Pomegr", updatedAt: "2026-09-14T12:00:00.000Z", isLive: false, needsInput: false, activityStatus: "closed", summaryReadiness: "ready", agentCount: 2, activeAgentCount: 1, latestContextTotal: 12_400, progress: null, currentActivity: null, ...overrides }; }
function composedState(overrides: Partial<MonitorState> = {}): MonitorState {
  const state = createEmptyMonitorState({ connected: true, view: "history" });
  state.revision = 3;
  state.session = { ...repositorySession({ available: true, branch: "feature/session-tabs", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }), id: SESSION_ID, title: "Recorded implementation session", project: "Pomegr" };
  return { ...state, ...overrides };
}
function signalsDomain(state: MonitorState): SignalsDomain {
  return {
    domain: "signals",
    sessionId: SESSION_ID,
    revision: typeof state.revision === "number" ? state.revision : 0,
    readiness: "ready",
    observedAt: "2026-09-14T12:00:00.000Z",
    sectionReadiness: { activityEvidence: "ready", contextEvidence: "ready" },
    insights: state.insights,
    loops: state.loops,
    toolPatterns: state.toolPatterns,
    sessionSignal: state.session?.signal || null,
    agents: state.agents.map(({ id, label, cacheLifetime, signal }) => ({ id, label, cacheLifetime, signal })),
    cacheEvents: state.metrics.tokens.cacheEvents,
    cacheReadDrops: state.metrics.tokens.cacheReadDrops,
  };
}
function mount(query = {}, summary = sessionSummaryFixture(), state = composedState(), catalogSessions = [catalog()]) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/session-domain") && url.includes("domain=signals")) return json(signalsDomain(state));
    if (url.startsWith("/api/session-domain")) return json(summary);
    if (url.startsWith("/api/state")) return json(state);
    return new Response(null, { status: 404 });
  });
  const view = render(<LiveClockProvider running={false}><DisplayPreferencesProvider><SessionCatalogProvider sessions={catalogSessions}><Dashboard initialSessionId={SESSION_ID} initialQuery={query} /></SessionCatalogProvider></DisplayPreferencesProvider></LiveClockProvider>);
  return { ...view, fetchMock };
}

afterEach(() => { resetSessionDomainStoreForTests(); navigation.replace.mockReset(); vi.restoreAllMocks(); vi.useRealTimers(); delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop; });

describe("T04 session workspace", () => {
  it("shows the header branch chip only after repository evidence is ready", async () => {
    const base = sessionSummaryFixture();
    const pending = mount({}, sessionSummaryFixture({ sectionReadiness: { ...base.sectionReadiness, repository: "loading" },
      repository: { ...base.repository, available: false, branch: "Not a Git repository" } }));
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    expect(pending.container.querySelector(".sessionHeaderMeta .sessionBranchChip")).toBeNull();
    pending.unmount();
    const ready = mount();
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    expect(ready.container.querySelector(".sessionHeaderMeta .sessionBranchChip")).toHaveTextContent("feature/session-tabs");
  });

  it("renders persistent summary-only chrome and falls back unknown tabs to Overview", async () => {
    const { fetchMock, container } = mount({ tab: "made-up", agent: "primary", request: "request-1", path: "app/Dashboard.tsx" });
    expect(await screen.findByRole("heading", { name: "Recorded implementation session" })).toBeInTheDocument();
    expect(container.querySelector(".sessionStartedMeta time")).toHaveAttribute("datetime", "2026-09-14T11:00:00.000Z");
    expect(screen.getByLabelText("Session totals")).toHaveTextContent("Agents");
    expect(screen.getByLabelText("Session totals")).toHaveTextContent("All-agent context");
    expect(screen.getByLabelText("Session totals")).toHaveTextContent("Calls");
    expect(screen.getByLabelText("Session overview")).toBeInTheDocument();
    expect(screen.getByTitle("Primary agent: 35 fresh tokens")).toBeInTheDocument();
    expect(container.querySelector(".sessionRequestRoleSegment")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/state"))).toBe(false);
  });

  it.each([undefined, "other"])("opens a request bar with its owning agent and request from scope %s", async (agent) => {
    const summary = sessionSummaryFixture();
    const request = summary.requestSnapshots.items[0];
    mount({ tab: "overview", agent, request: "stale" }, summary);
    await userEvent.setup().click(await screen.findByTitle("Primary agent: 35 fresh tokens"));
    const url = new URL(String(navigation.replace.mock.calls.at(-1)?.[0]), "http://localhost");
    expect(url.searchParams.get("tab")).toBe("activities");
    expect(url.searchParams.get("agent")).toBe(request.agentId);
    expect(url.searchParams.get("request")).toBe(request.id);
  });

  it("orders desktop tabs and preserves deep links on simple tab changes", async () => {
    mount({ tab: "overview", agent: "primary", request: "request-1", path: "app/Dashboard.tsx" });
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    const tabs = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+/g, ""))).toEqual(["Overview", "Agents", "Activities", "Repository", "Signals", "Resources", "Details"]);
    await userEvent.setup().click(within(tabs).getByRole("tab", { name: /^Repository/ }));
    expect(navigation.replace).toHaveBeenCalledWith(expect.stringMatching(/tab=repository.*agent=primary.*request=request-1.*path=app%2FDashboard.tsx/), { scroll: false });
  });

  it("clears a stale request when agent scope changes while retaining other scope", async () => {
    mount({ tab: "overview", agent: "other", request: "stale", path: "app/Dashboard.tsx" });
    await userEvent.setup().click((await screen.findAllByRole("button", { name: "Primary agent" }))[0]);
    const url = String(navigation.replace.mock.calls.at(-1)?.[0]);
    expect(url).toContain("agent=primary"); expect(url).toContain("path=app%2FDashboard.tsx"); expect(url).not.toContain("request=");
  });

  it("keeps an explicitly supplied request when the agent changes together, unlike an agent-only change", async () => {
    // AgentsTab's onOpenActivities passes only `{ agentId }` (see AgentsTab.tsx:69); Dashboard.tsx
    // adds `request: null` itself. The mocked AgentsTab above supplies an explicit request instead,
    // so the auto-clear guard in `navigate` must not fire when a request is explicitly present,
    // even though it fires for an agent-only change (previous test).
    mount({ tab: "agents", agent: "primary", request: "request-1", path: "app/Dashboard.tsx" });
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open secondary activities with an explicit request" }));
    const url = String(navigation.replace.mock.calls.at(-1)?.[0]);
    expect(url).toContain("agent=secondary");
    expect(url).toContain("request=request-9");
  });

  it("drops a stale request explicitly when an agent is opened from the Activities feed", async () => {
    mount({ tab: "activities", agent: "primary", request: "12", path: "app/Dashboard.tsx" });
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open primary from Activities" }));
    const url = String(navigation.replace.mock.calls.at(-1)?.[0]);
    expect(url).toContain("agent=primary");
    expect(url).not.toContain("request=");
  });

  it("hides Resources only after summary evidence confirms no data", async () => {
    mount({}, sessionSummaryFixture({ resourceAvailability: { readiness: "ready", hasData: false } }));
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    const tabs = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    expect(within(tabs).queryByRole("tab", { name: "Resources" })).not.toBeInTheDocument();
  });

  it("fetches composed state only after a transitional tab mounts", async () => {
    const { fetchMock } = mount({ tab: "details" });
    expect(await screen.findByText("Session details")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/state"))).toBe(true);
  });

  it("keeps a detected session's identity while its provider has recorded nothing yet", async () => {
    const detected = catalog({ isLive: true, activityStatus: "open", summaryReadiness: "unavailable", title: "Fresh session" });
    mount({}, sessionSummaryFixture({ readiness: "unavailable", session: null }), composedState(), [detected]);
    expect(await screen.findByRole("heading", { name: "Fresh session" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No recorded activity yet");
    expect(screen.queryByRole("heading", { name: "Session unavailable" })).not.toBeInTheDocument();
  });

  it("keeps a loading summary envelope distinct from unavailable evidence", async () => {
    const loading = sessionSummaryFixture({ readiness: "loading", session: null });
    mount({}, loading);
    expect(await screen.findByRole("heading", { name: "Loading session…" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Session unavailable" })).not.toBeInTheDocument();
  });

  it("surfaces the connection notice alongside a retained loading summary, and clears it once a later poll succeeds", async () => {
    // A retained `readiness: "loading"` body with no session yet is still evidence that a
    // request once completed. If a later poll fails, Dashboard.tsx must surface the connection
    // notice alongside "Loading session…" rather than showing it silently with no explanation.
    vi.useFakeTimers();
    const loading = sessionSummaryFixture({ readiness: "loading", session: null, view: "live" });
    let succeed = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("/api/session-domain")) return succeed ? json(loading) : new Response(null, { status: 503 });
      return new Response(null, { status: 404 });
    });
    render(<LiveClockProvider running={false}><DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog({ isLive: true, activityStatus: "working" })]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider></LiveClockProvider>);
    // `findByRole` polls on a real timeout internally, which never fires under fake timers, so
    // flush pending microtasks manually instead (matching the other fake-timer tests below).
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(screen.getByRole("heading", { name: "Loading session…" })).toBeInTheDocument();
    expect(screen.queryByText("Session evidence is temporarily unavailable. Pomegr will retry from the last recorded state.")).not.toBeInTheDocument();
    succeed = false;
    await act(async () => { vi.advanceTimersByTime(1_000); for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(screen.getByRole("heading", { name: "Loading session…" })).toBeInTheDocument();
    expect(screen.getByText("Session evidence is temporarily unavailable. Pomegr will retry from the last recorded state.")).toBeInTheDocument();
    // Recovery needs no local retry bookkeeping: the next successful poll simply clears
    // `summaryResult.error`, and the retained loading state keeps rendering underneath it.
    succeed = true;
    await act(async () => { vi.advanceTimersByTime(1_000); for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    expect(screen.getByRole("heading", { name: "Loading session…" })).toBeInTheDocument();
    expect(screen.queryByText("Session evidence is temporarily unavailable. Pomegr will retry from the last recorded state.")).not.toBeInTheDocument();
  });

  it("loads composed report evidence only after the explicit download action", async () => {
    const saveReport = vi.fn().mockResolvedValue({ status: "saved" });
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { saveReport, getDesktopState: async () => null, onDesktopStateChanged: () => () => {} };
    const { fetchMock } = mount();
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/state"))).toHaveLength(0);
    await userEvent.setup().click(screen.getByRole("button", { name: "Download report" }));
    await waitFor(() => expect(saveReport).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/state"))).toHaveLength(1);
  });

  it("surfaces a retryable notice and skips the desktop save when the fresh report fetch is unavailable", async () => {
    const saveReport = vi.fn().mockResolvedValue({ status: "saved" });
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { saveReport, getDesktopState: async () => null, onDesktopStateChanged: () => () => {} };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).startsWith("/api/session-domain") ? json(sessionSummaryFixture()) : String(input).startsWith("/api/state") ? new Response(null, { status: 503 }) : new Response(null, { status: 404 }));
    render(<LiveClockProvider running={false}><DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog()]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider></LiveClockProvider>);
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Download report" }));
    await waitFor(() => expect(screen.getByText("The report could not be prepared from the latest committed session evidence.")).toBeInTheDocument());
    expect(saveReport).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download report" })).not.toBeDisabled();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/state"))).toHaveLength(1);
    // The failure is retryable: a second click issues a fresh fetch rather than being latched.
    await userEvent.setup().click(screen.getByRole("button", { name: "Download report" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/state"))).toHaveLength(2));
  });

  it("does not export a session returned by a stale /api/state refresh that no longer matches the routed session", async () => {
    const saveReport = vi.fn().mockResolvedValue({ status: "saved" });
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { saveReport, getDesktopState: async () => null, onDesktopStateChanged: () => () => {} };
    const mismatchedState = composedState({ session: { ...composedState().session!, id: "claude:a-different-session" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).startsWith("/api/session-domain") ? json(sessionSummaryFixture()) : String(input).startsWith("/api/state") ? json(mismatchedState) : new Response(null, { status: 404 }));
    render(<LiveClockProvider running={false}><DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog()]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider></LiveClockProvider>);
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Download report" }));
    await waitFor(() => expect(screen.getByText("The report could not be prepared from the latest committed session evidence.")).toBeInTheDocument());
    expect(saveReport).not.toHaveBeenCalled();
  });

  it("keeps the last-known-good summary visible with a notice when a later live poll fails", async () => {
    vi.useFakeTimers();
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      private handlers = new Map<string, Set<(event: unknown) => void>>();
      constructor(readonly url: string) { FakeEventSource.instances.push(this); }
      addEventListener(type: string, listener: (event: unknown) => void) {
        const set = this.handlers.get(type) || new Set();
        set.add(listener);
        this.handlers.set(type, set);
      }
      open() { for (const listener of this.handlers.get("open") || []) listener(new Event("open")); }
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const liveEvents = await import("../../app/live-events");
    const keepAlive = liveEvents.subscribeLiveEvents(() => {});
    FakeEventSource.instances[0]!.open();
    let fail = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("/api/session-domain")) return fail ? new Response(null, { status: 503 }) : json(sessionSummaryFixture({ view: "live" }));
      return new Response(null, { status: 404 });
    });
    try {
      render(<LiveClockProvider running={false}><DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog({ isLive: true, activityStatus: "working" })]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider></LiveClockProvider>);
      await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
      expect(screen.getByRole("heading", { name: "Recorded implementation session" })).toBeInTheDocument();
      fail = true;
      await act(async () => { vi.advanceTimersByTime(30_000); for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
      expect(screen.getByText("Session evidence is temporarily unavailable. Pomegr will retry from the last recorded state.")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Recorded implementation session" })).toBeInTheDocument();
      expect(screen.getByLabelText("Session totals")).toHaveTextContent("Agents");
    } finally {
      keepAlive();
      vi.unstubAllGlobals();
    }
  });

  it("sends exactly one initial request when subscribing to an already-connected singleton", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      private handlers = new Map<string, Set<(event: unknown) => void>>();
      constructor(readonly url: string) { FakeEventSource.instances.push(this); }
      addEventListener(type: string, listener: (event: unknown) => void) {
        const set = this.handlers.get(type) || new Set();
        set.add(listener);
        this.handlers.set(type, set);
      }
      open() { for (const listener of this.handlers.get("open") || []) listener(new Event("open")); }
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const liveEvents = await import("../../app/live-events");
    // A pre-existing subscriber keeps the shared singleton connected before
    // LegacySessionTab's own subscribeLiveEvents call, matching the real app
    // where multiple consumers share the one live-events singleton.
    const keepAlive = liveEvents.subscribeLiveEvents(() => {});
    FakeEventSource.instances[0]!.open();
    try {
      const { fetchMock } = mount({ tab: "details" });
      await screen.findByText("Session details");
      expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/state"))).toHaveLength(1);
    } finally {
      keepAlive();
      vi.unstubAllGlobals();
    }
  });

  it("halts a mounted transitional tab when desktop Pause arrives", async () => {
    vi.useFakeTimers();
    // The desktop bridge is a single global: DisplayPreferencesProvider and Dashboard each
    // register their own onDesktopStateChanged callback against it, so the stub must deliver
    // a Pause notification to every registered listener, not just whichever mounted last.
    const listeners: Array<(state: { paused: boolean }) => void> = [];
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = {
      saveReport: vi.fn(),
      getDesktopState: async () => ({ paused: false }),
      onDesktopStateChanged: (callback: (state: { paused: boolean }) => void) => { listeners.push(callback); return () => {}; },
    };
    // A recorded/historical session never schedules a live poll at all, so it cannot prove
    // Pause stops one. Use a live session on a transitional tab instead.
    const { fetchMock } = mount(
      { tab: "details" },
      sessionSummaryFixture({ view: "live", lifecycle: { isLive: true, needsInput: false, activityStatus: "working", currentActivity: null, activityFallback: null } }),
      composedState({ view: "live" }),
      [catalog({ isLive: true, activityStatus: "working" })],
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const initialCount = fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/state")).length;
    expect(initialCount).toBeGreaterThan(0);
    expect(listeners.length).toBeGreaterThan(0);
    // Prove the live polling loop is actually running before Pause is asserted to stop it.
    await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); await Promise.resolve(); });
    const grownCount = fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/state")).length;
    expect(grownCount).toBeGreaterThan(initialCount);
    act(() => { for (const listener of listeners) listener({ paused: true }); });
    await act(async () => { await Promise.resolve(); });
    const count = fetchMock.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("stops periodic summary polling once fetched evidence confirms a historical session, even without a matching catalog row", async () => {
    vi.useFakeTimers();
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      private handlers = new Map<string, Set<(event: unknown) => void>>();
      constructor(readonly url: string) { FakeEventSource.instances.push(this); }
      addEventListener(type: string, listener: (event: unknown) => void) {
        const set = this.handlers.get(type) || new Set();
        set.add(listener);
        this.handlers.set(type, set);
      }
      open() { for (const listener of this.handlers.get("open") || []) listener(new Event("open")); }
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const liveEvents = await import("../../app/live-events");
    const keepAlive = liveEvents.subscribeLiveEvents(() => {});
    FakeEventSource.instances[0]!.open();
    try {
      // Missing catalog row: the catalog cannot say this session is historical, only the
      // fetched summary (`view: "history"`) can.
      const { fetchMock } = mount({}, sessionSummaryFixture(), composedState(), []);
      await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
      const summaryFetches = () => fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session-domain")).length;
      await act(async () => { vi.advanceTimersByTime(60_000); for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
      const settled = summaryFetches();
      expect(settled).toBeGreaterThan(0);
      // A still-buggy `catalogHistorical`-only cadence keeps polling every 30s indefinitely
      // (1 -> 5 fetches over 120s); once the fetched summary's `view: "history"` is honored,
      // the count must stop growing.
      await act(async () => { vi.advanceTimersByTime(120_000); for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
      expect(summaryFetches()).toBe(settled);
    } finally {
      keepAlive();
      vi.unstubAllGlobals();
    }
  });

  it("shows an honest error instead of loading forever when the first summary request fails, and recovers once a request succeeds", async () => {
    let succeed = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("/api/session-domain")) return succeed ? json(sessionSummaryFixture()) : new Response(null, { status: 503 });
      return new Response(null, { status: 404 });
    });
    render(<LiveClockProvider running={false}><DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog()]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider></LiveClockProvider>);
    expect(await screen.findByRole("heading", { name: "Session evidence unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Loading session…" })).not.toBeInTheDocument();
    // Recovery does not depend on any local retry state here: the next successful response
    // (triggered here by the store's existing window-focus revalidation) simply makes
    // `summaryResult.data` non-null again, and the honest error branch above stops matching.
    succeed = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByRole("heading", { name: "Recorded implementation session" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Session evidence unavailable" })).not.toBeInTheDocument();
  });

  it("opens the Agents tab with that agent selected when Signals \"Show agent\" is clicked", async () => {
    mount(
      { tab: "signals" },
      sessionSummaryFixture(),
      composedState({ insights: [{ id: "insight-1", level: "warning", title: "Repeated reads", detail: "The same target was read repeatedly.", agentId: "primary" }] }),
    );
    expect(await screen.findByText("Repeated reads")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show agent" }));
    const url = String(navigation.replace.mock.calls.at(-1)?.[0]);
    expect(url).toMatch(/tab=agents/);
    expect(url).toMatch(/agent=primary/);
  });

  it.each([["Right now", "agents"], ["Repository", "repository"], ["Requests", "activities"]])("opens the matching tab from the Overview heading %s", async (name, tab) => {
    mount({ tab: "overview" });
    const overview = await screen.findByLabelText("Session overview");
    for (const label of ["All agents", "View signals", "View evidence", "Open repository", "Open activities"]) expect(within(overview).queryByRole("button", { name: label })).not.toBeInTheDocument();
    await userEvent.setup().click(within(overview).getByRole("button", { name }));
    expect(String(navigation.replace.mock.calls.at(-1)?.[0])).toMatch(new RegExp(`tab=${tab}`));
  });

  it("lays Overview out as a main column, the Events rail, and one bottom row, with no sparse Work-by-kind special case", async () => {
    // One agent in Right now used to pull Tool calls by kind up beside it; the bottom row now owns it at every density.
    mount({ tab: "overview" });
    const overview = await screen.findByLabelText("Session overview");
    expect(overview).not.toHaveAttribute("data-work");
    expect(overview).not.toHaveAttribute("data-density");
    const [main, events, bottom] = [...overview.children];
    expect(overview.children).toHaveLength(3);
    expect(main).toHaveClass("sessionOverviewMain");
    expect(events).toHaveClass("sessionEventsPanel");
    expect(bottom).toHaveClass("sessionOverviewBottom");
    expect([...main!.children].map((panel) => panel.getAttribute("aria-labelledby"))).toEqual(["session-right-now", "session-requests"]);
    expect([...bottom!.children].map((panel) => panel.getAttribute("aria-labelledby"))).toEqual(["session-repository", "session-progress", "session-work", "session-cost"]);
  });

  it("keeps Repository in the bottom row as a compact tile: branch and comparison chip, then a muted meta line", async () => {
    const base = sessionSummaryFixture();
    const { container } = mount({ tab: "overview" }, sessionSummaryFixture({ repository: { ...base.repository, comparison: { branch: "main", kind: "base", ahead: 2, behind: 0, integrated: false } } }));
    const tile = (await screen.findByRole("button", { name: "Repository" })).closest("section") as HTMLElement;
    expect(tile.parentElement).toHaveClass("sessionOverviewBottom");
    expect(tile.querySelector(".sessionRepositoryLineMain")).toHaveTextContent("feature/session-tabs2 commits ahead relative to main");
    expect(tile.querySelector(".sessionRepositoryLineMain .commandChip")).not.toHaveClass("positive");
    expect(tile.querySelector(".sessionRepositoryLineMeta")).toHaveTextContent("4 changed files · 1 pull request");
    expect(container.querySelectorAll(".sessionRepositoryOneLine")).toHaveLength(1);
  });

  it("renders the Events rail from the summary and opens the tab each row continues", async () => {
    const at = new Date(2026, 8, 14, 11, 21).toISOString();
    const items = [
      { id: "e2", kind: "agent_finished" as const, at, agentId: "primary", agentLabel: "Primary agent", durationMs: 240_000, signal: null, progress: null, resource: null, pullRequestNumber: null, refill: null, compaction: null },
      { id: "e1", kind: "commit_observed" as const, at, agentId: null, agentLabel: null, durationMs: null, signal: null, progress: null, resource: null, pullRequestNumber: null, refill: null, compaction: null },
    ];
    mount({ tab: "overview" }, sessionSummaryFixture({ events: { readiness: "ready", items, total: 2 } }));
    const rail = await screen.findByRole("region", { name: "Events · newest first" });
    const user = userEvent.setup();
    await user.click(within(rail).getByRole("button", { name: "Agent finished, Primary agent · 4m wall, 11:21" }));
    expect(String(navigation.replace.mock.calls.at(-1)?.[0])).toMatch(/tab=agents.*agent=primary/);
    await user.click(within(rail).getByRole("button", { name: "Commit observed, Git-observed, 11:21" }));
    expect(String(navigation.replace.mock.calls.at(-1)?.[0])).toMatch(/tab=repository/);
    expect(within(rail).getByText("2 events")).toBeInTheDocument();
  });

  it("shows the Events rail as unavailable, keeping its place, when the monitor sends no events feed", async () => {
    const summary = sessionSummaryFixture();
    delete (summary as Partial<typeof summary>).events;
    mount({ tab: "overview" }, summary);
    const rail = await screen.findByRole("region", { name: "Events · newest first" });
    expect(within(rail).getByText("Event evidence unavailable.")).toBeInTheDocument();
  });

  it("shows five grouped Events rows on phone with an expander for the rest", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    try {
      const at = new Date(2026, 8, 14, 11, 21).toISOString();
      const items = Array.from({ length: 8 }, (_, index) => ({ id: `e${index}`, kind: index % 2 ? "user_message" as const : "commit_observed" as const, at, agentId: null, agentLabel: null, durationMs: null, signal: null, progress: null, resource: null, pullRequestNumber: null, refill: null, compaction: null }));
      items.splice(1, 0, { ...items[0]!, id: "repeat-1" }, { ...items[0]!, id: "repeat-2" });
      mount({ tab: "overview" }, sessionSummaryFixture({ events: { readiness: "ready", items, total: items.length } }));
      const rail = await screen.findByRole("region", { name: "Events · newest first" });
      expect(within(within(rail).getByRole("list")).getAllByRole("button")).toHaveLength(5);
      expect(within(rail).getByText("×3")).toBeInTheDocument();
      expect(within(rail).getByText("10 events")).toBeInTheDocument();
      await userEvent.setup().click(within(rail).getByRole("button", { name: "Show 3 earlier" }));
      expect(within(within(rail).getByRole("list")).getAllByRole("button")).toHaveLength(8);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("draws only the latest 24 request slots on phone", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    try {
      const base = sessionSummaryFixture();
      const items = Array.from({ length: 30 }, (_, index) => ({ ...base.requestSnapshots.items[0]!, id: `request-${index + 1}` }));
      const { container } = mount({ tab: "overview" }, sessionSummaryFixture({ requestSnapshots: { status: "ready", items } }));
      await screen.findByRole("button", { name: "Requests" });
      expect(container.querySelector(".sessionRequestStrip .sessionRequestSummary")).toHaveTextContent("fresh tokens · last 24");
      const tracks = container.querySelector(".sessionRequestTracks")!;
      expect(tracks.querySelectorAll("button")).toHaveLength(24);
      expect(tracks.querySelectorAll(".sessionRequestBarSlot")).toHaveLength(0);
      expect(container.querySelectorAll(".sessionRequestRoleSegment")).toHaveLength(24);
      await userEvent.setup().click(tracks.querySelector("button")!);
      expect(String(navigation.replace.mock.calls.at(-1)?.[0])).toMatch(/request=request-7(&|$)/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses an agent fallback after provider activity, and leaves last observed work static", async () => {
    const base = sessionSummaryFixture();
    const fallback = { label: "Searching", state: "current" as const, observedAt: "2026-09-14T12:00:00.000Z", source: "execution_task" as const, actor: "primary" as const };
    const current = mount({ tab: "overview" }, sessionSummaryFixture({ rightNow: [{ ...base.rightNow[0]!, currentActivity: null, activityFallback: fallback }] }));
    expect(await screen.findByText("Searching")).toBeInTheDocument();
    expect(current.container.querySelector(".sessionCurrentActivityMark")).toHaveClass("isCurrent");
    expect(current.container.querySelector(".sessionAgentActivityLabel")).toHaveClass("currentActivityShimmer");
    current.unmount();

    const provider = mount({ tab: "overview" }, sessionSummaryFixture({ rightNow: [{ ...base.rightNow[0]!, currentActivity: { label: "Provider heading", observedAt: fallback.observedAt }, activityFallback: fallback }] }));
    expect(await screen.findByText("Provider heading")).toBeInTheDocument();
    expect(screen.queryByText("Searching")).not.toBeInTheDocument();
    provider.unmount();

    const previous = mount({ tab: "overview" }, sessionSummaryFixture({ rightNow: [{ ...base.rightNow[0]!, currentActivity: null, activityFallback: { ...fallback, state: "last_observed" } }] }));
    expect(await screen.findByText("Searching")).toBeInTheDocument();
    expect(previous.container.querySelector(".sessionCurrentActivityMark")).not.toHaveClass("isCurrent");
    expect(previous.container.querySelector(".sessionAgentActivityLabel")).not.toHaveClass("currentActivityShimmer");
    previous.unmount();

    mount({ tab: "overview" }, sessionSummaryFixture({ rightNow: [{ ...base.rightNow[0]!, currentActivity: null, activityFallback: null }] }));
    expect(await screen.findByText("active")).toBeInTheDocument();
  });

  it("never renders forbidden content seeded into summary fields Overview and the header must not display", async () => {
    // These fixture fields exist on SessionSummaryDomain but neither SessionOverview nor the
    // Dashboard header ever read them for display text. Seeding each with a distinct sentinel
    // and asserting none of them appear anywhere in the rendered markup (including attributes,
    // via innerHTML) is a regression guard for the privacy bounds in AGENTS.md: raw prompts,
    // responses, tool output, credentials, and local paths must never reach the browser.
    // Note: `repository.comparison` is deliberately excluded from this sentinel set. Overview's
    // Repository row now legitimately reads and renders `comparisonLabel(repository.comparison)`
    // (a normalized branch-comparison sentence built from git evidence, not a local path), so
    // `session.pomegrPlugin.version` — never read by Overview — stands in for the "local path
    // never leaks" case instead.
    const base = sessionSummaryFixture();
    const sentinels = {
      prompt: "sentinel-prompt-2f91a7-forbidden",
      response: "sentinel-response-6c3d5e-forbidden",
      toolOutput: "sentinel-tooloutput-88b1aa-forbidden",
      credential: "sentinel-credential-041cde-forbidden",
      localPath: "sentinel-localpath-C--Users-secret-transcript-jsonl-forbidden",
    };
    const summary = sessionSummaryFixture({
      session: {
        ...base.session!,
        summary: { text: sentinels.prompt, observedAt: "2026-09-14T12:00:00.000Z", source: "provider" },
        pomegrPlugin: { status: "active", version: sentinels.localPath, policyStatus: "valid", policyVersion: 1, observedAt: "2026-09-14T12:00:00.000Z" },
      },
      planTasks: [{ id: "task-1", subject: sentinels.response, status: "completed", blocks: [], blockedBy: [] }],
      rightNow: [{ ...base.rightNow[0]!, customType: sentinels.toolOutput }],
      requestSnapshots: { status: "ready", items: [{ ...base.requestSnapshots.items[0]!, id: sentinels.credential }] },
    });
    const { container } = mount({}, summary);
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    const html = container.innerHTML;
    for (const value of Object.values(sentinels)) expect(html).not.toContain(value);
  });
});
