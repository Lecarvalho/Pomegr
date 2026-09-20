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
    score: state.score,
    flowScore: {
      score: state.score,
      repeatedCalls: state.metrics.repeatedCalls ?? null,
      overlappingTargets: state.metrics.overlappingTargets ?? null,
    },
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
  const view = render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={catalogSessions}><Dashboard initialSessionId={SESSION_ID} initialQuery={query} /></SessionCatalogProvider></DisplayPreferencesProvider>);
  return { ...view, fetchMock };
}

afterEach(() => { resetSessionDomainStoreForTests(); navigation.replace.mockReset(); vi.restoreAllMocks(); vi.useRealTimers(); delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop; });

describe("T04 session workspace", () => {
  it("renders persistent summary-only chrome and falls back unknown tabs to Overview", async () => {
    const { fetchMock, container } = mount({ tab: "made-up", agent: "primary", request: "request-1", path: "app/Dashboard.tsx" });
    expect(await screen.findByRole("heading", { name: "Recorded implementation session" })).toBeInTheDocument();
    expect(screen.getByLabelText("Session totals")).toHaveTextContent("Agents");
    expect(screen.getByLabelText("Session totals")).toHaveTextContent("All-agent context");
    expect(screen.getByLabelText("Session totals")).toHaveTextContent("Calls");
    expect(screen.getByLabelText("Session overview")).toBeInTheDocument();
    expect(screen.getByTitle("Primary agent: 35 fresh tokens")).toBeInTheDocument();
    expect(container.querySelector(".sessionRoleTrack")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/state"))).toBe(false);
  });

  it("orders desktop tabs and preserves deep links on simple tab changes", async () => {
    mount({ tab: "overview", agent: "primary", request: "request-1", path: "app/Dashboard.tsx" });
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    const tabs = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+/g, ""))).toEqual(["Overview", "Agents", "Activities", "Repository", "Signals", "Resources", "Details"]);
    await userEvent.setup().click(within(tabs).getByRole("tab", { name: "Repository" }));
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
    const { fetchMock } = mount({ tab: "repository" });
    expect(await screen.findByText("feature/session-tabs")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/state"))).toBe(true);
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
    render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog({ isLive: true, activityStatus: "working" })]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
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
    render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog()]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
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
    render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog()]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
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
      render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog({ isLive: true, activityStatus: "working" })]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
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
      const { fetchMock } = mount({ tab: "repository" });
      await screen.findByText("feature/session-tabs");
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
      { tab: "repository" },
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
    render(<DisplayPreferencesProvider><SessionCatalogProvider sessions={[catalog()]}><Dashboard initialSessionId={SESSION_ID} initialQuery={{}} /></SessionCatalogProvider></DisplayPreferencesProvider>);
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

  it("navigates to the Agents tab with that agent selected when Overview's Efficiency signals Show agent is clicked", async () => {
    // sessionSummaryFixture()'s default topSignals entry already carries agentId "primary"
    // (see session-summary-test-fixture.ts), so the default fixture exercises this directly.
    mount({ tab: "overview" });
    expect(await screen.findByText("Repeated reads")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show agent" }));
    const url = String(navigation.replace.mock.calls.at(-1)?.[0]);
    expect(url).toMatch(/tab=agents/);
    expect(url).toMatch(/agent=primary/);
  });

  it("never renders forbidden content seeded into summary fields Overview and the header must not display", async () => {
    // These fixture fields exist on SessionSummaryDomain but neither SessionOverview nor the
    // Dashboard header ever read them for display text. Seeding each with a distinct sentinel
    // and asserting none of them appear anywhere in the rendered markup (including attributes,
    // via innerHTML) is a regression guard for the privacy bounds in AGENTS.md: raw prompts,
    // responses, tool output, credentials, and local paths must never reach the browser.
    const base = sessionSummaryFixture();
    const sentinels = {
      prompt: "sentinel-prompt-2f91a7-forbidden",
      response: "sentinel-response-6c3d5e-forbidden",
      toolOutput: "sentinel-tooloutput-88b1aa-forbidden",
      credential: "sentinel-credential-041cde-forbidden",
      localPath: "sentinel-localpath-C--Users-secret-transcript-jsonl-forbidden",
    };
    const summary = sessionSummaryFixture({
      session: { ...base.session!, summary: { text: sentinels.prompt, observedAt: "2026-09-14T12:00:00.000Z", source: "provider" } },
      planTasks: [{ id: "task-1", subject: sentinels.response, status: "completed", blocks: [], blockedBy: [] }],
      rightNow: [{ ...base.rightNow[0]!, customType: sentinels.toolOutput }],
      requestSnapshots: { status: "ready", items: [{ ...base.requestSnapshots.items[0]!, id: sentinels.credential }] },
      repository: { ...base.repository, comparison: { branch: sentinels.localPath, kind: "base", ahead: 0, behind: 0, integrated: false } },
    });
    const { container } = mount({}, summary);
    await screen.findByRole("heading", { name: "Recorded implementation session" });
    const html = container.innerHTML;
    for (const value of Object.values(sentinels)) expect(html).not.toContain(value);
  });
});
