import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { DisplayPreferencesProvider, DISPLAY_PREFERENCES_STORAGE_KEY } from "../../app/hooks/DisplayPreferencesContext";
import type { MonitorState, SessionSummary } from "../../shared/monitor-contract";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function liveState(id: string, title: string): MonitorState {
  return {
    ...createEmptyMonitorState({ connected: true }),
    session: {
      id,
      title,
      project: "Pomegr",
      cwd: "C:\\Workspace\\repos\\pomegr",
      repository: { available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } },
      pullRequests: { status: "unavailable", checkedAt: null, items: [] },
      startedAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:01:00.000Z",
      durationMs: 60_000,
      cost: null,
      approvalMode: null,
      contextMachinery: null,
      summary: null,
      signal: null,
      progress: null,
      pomegrPlugin: null,
    },
  };
}

function historicalState(id: string, title: string): MonitorState {
  const state = liveState(id, title);
  return {
    ...state,
    view: "history",
    session: state.session ? {
      ...state.session,
      repository: { ...state.session.repository, historical: true },
    } : null,
  };
}

function detailedState(options: {
  historical?: boolean;
  contextSupported?: boolean;
  withContext?: boolean;
  usageAvailable?: boolean;
  files?: Array<{ status: string; path: string }>;
} = {}): MonitorState {
  const historical = options.historical ?? false;
  const state = historical
    ? historicalState("claude:details-history", "Historical details")
    : liveState("claude:details-live", "Live details");
  return {
    ...state,
    source: options.contextSupported === false ? "Codex" : "Claude Code",
    capabilities: {
      ...state.capabilities,
      contextMachinery: options.contextSupported !== false,
      usageLimits: true,
    },
    usageLimits: {
      available: options.usageAvailable ?? true,
      fetchedAt: "2026-08-11T12:01:00.000Z",
      attemptedAt: "2026-08-11T12:01:00.000Z",
      limits: options.usageAvailable === false ? [] : [
        { id: "short", label: "Short window", window: "5 hours", percent: 64.4, resetsAt: null, severity: "normal", active: true },
        { id: "weekly", label: "Weekly window", window: "7 days", percent: 81.6, resetsAt: null, severity: "warning", active: false },
      ],
    },
    session: state.session ? {
      ...state.session,
      repository: {
        ...state.session.repository,
        available: true,
        branch: "feature/a-very-long-branch-name-that-must-truncate-without-losing-its-title",
        files: options.files ?? [
          { status: "M", path: "app/Dashboard.tsx" },
          { status: "A", path: "tests/ui/dashboard-components.test.tsx" },
        ],
      },
      contextMachinery: options.withContext === false || options.contextSupported === false ? null : {
        observedAt: "2026-08-11T12:01:00.000Z",
        model: "claude-test",
        total: { used: "12.3k", limit: "200k", percentage: 6 },
        machineryTokens: 12_345,
        categories: [{ name: "System prompt", tokens: "12.3k", percentage: 6 }],
        groups: [],
      },
    } : null,
  };
}

function catalogSession(state: MonitorState, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: state.session?.id ?? "claude:unknown",
    provider: state.source === "Codex" ? "codex" : "claude",
    source: state.source,
    title: state.session?.title ?? "Unknown session",
    project: state.session?.project ?? "Pomegr",
    updatedAt: state.session?.updatedAt ?? "2026-08-11T12:01:00.000Z",
    isLive: state.view !== "history",
    needsInput: false,
    activityStatus: "working",
    summaryReadiness: "ready",
    agentCount: state.metrics.agents,
    activeAgentCount: state.metrics.activeAgents,
    latestContextTotal: state.metrics.tokens.allAgents,
    progress: state.session?.progress ?? null,
    currentActivity: null,
    ...overrides,
  };
}

function renderDashboard(sessions: SessionSummary[] = []) {
  return render(
    <DisplayPreferencesProvider>
      <SessionCatalogProvider sessions={sessions}>
        <Dashboard />
      </SessionCatalogProvider>
    </DisplayPreferencesProvider>,
  );
}

function mockDashboardState(state: MonitorState) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/state" || url.startsWith("/api/state?sessionId=")) return Promise.resolve(jsonResponse(state));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  window.localStorage.removeItem("pomegr-resource-panel-open");
  window.localStorage.removeItem("pomegr-disclosure-repository");
  window.localStorage.removeItem("pomegr-session-details-open");
  window.localStorage.removeItem(DISPLAY_PREFERENCES_STORAGE_KEY);
});

describe("dashboard session navigation", () => {
  it("keeps refreshing an Open task after it leaves Live, but stops for a historical row", async () => {
    vi.useFakeTimers();
    const state = liveState("codex:quiet-open", "Quiet open task");
    const fetchMock = mockDashboardState(state);
    const row = catalogSession(state, { activityStatus: "open" });
    const view = renderDashboard([row]);
    await act(async () => {});
    const renderRow = (session: SessionSummary) => view.rerender(
      <DisplayPreferencesProvider><SessionCatalogProvider sessions={[session]}><Dashboard /></SessionCatalogProvider></DisplayPreferencesProvider>,
    );
    renderRow({ ...row, isLive: false });
    await act(async () => {});
    const stateCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/state")).length;
    const beforeOpenPoll = stateCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(stateCalls()).toBeGreaterThan(beforeOpenPoll);
    expect(screen.getByLabelText("Session status")).toHaveTextContent("Live session · Open");
    expect(screen.queryByLabelText("Session state: Open")).not.toBeInTheDocument();
    renderRow({ ...row, isLive: false, activityStatus: "idle" });
    await act(async () => {});
    const beforeHistory = stateCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(stateCalls()).toBe(beforeHistory);
    view.unmount();
  });

  it("orders KPIs, requests and cache evidence, summary cards, agents, resources, repository and details", async () => {
    const state = liveState("claude:live-1", "Live resource session");
    state.capabilities.cacheWriteUsage = true;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/state" || url === "/api/state?sessionId=claude%3Alive-1") return Promise.resolve(jsonResponse(state));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    const { container } = renderDashboard([catalogSession(state)]);

    const resourcePanel = (await screen.findByText("Resource use")).closest("details");
    const repository = screen.getByText("Repository").closest("details");
    const sessionDetails = screen.getByText("Session details").closest("details");

    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Session status")).toHaveTextContent("Live session · In progress");
    expect(screen.queryByLabelText("Session state: In progress")).not.toBeInTheDocument();
    const actionsPanel = screen.getByRole("region", { name: "Requests & actions" });
    expect(container.querySelector(".sessionKpiStrip")?.nextElementSibling).toBe(actionsPanel);
    const cacheDisclosure = actionsPanel.nextElementSibling;
    expect(cacheDisclosure).toHaveClass("cacheEvidenceDisclosure");
    expect(cacheDisclosure).not.toHaveAttribute("open");
    expect(cacheDisclosure?.nextElementSibling).toBe(container.querySelector(".sessionSummaryCards"));
    expect(screen.queryByRole("heading", { name: "Context history" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Request snapshots" })).not.toBeInTheDocument();
    expect(container.querySelector(".sessionSummaryCards")?.nextElementSibling).toBe(container.querySelector(".contentGrid"));
    expect(container.querySelector(".contentGrid")?.nextElementSibling).toBe(resourcePanel);
    expect(resourcePanel?.nextElementSibling).toBe(repository);
    expect(repository?.nextElementSibling).toBe(sessionDetails);
    expect(sessionDetails?.nextElementSibling).toBeNull();
    expect(resourcePanel).toHaveClass("dashboardDisclosurePanel", "panel");
    expect(sessionDetails).toHaveClass("dashboardDisclosurePanel", "panel");
    expect(resourcePanel?.querySelector(":scope > .dashboardDisclosurePanelBody")).toHaveClass("resourceUsageBody");
    expect(sessionDetails?.querySelector(":scope > .dashboardDisclosurePanelBody")).toHaveClass("sessionDetailsBody");
    expect(resourcePanel?.querySelector(":scope > summary .dashboardDisclosureIcon")).toBeInTheDocument();
    expect(repository).toHaveClass("dashboardDisclosurePanel", "panel", "sessionRepository", "sessionEvidenceDisclosure");
    expect(repository?.querySelector(":scope > summary .dashboardDisclosureIcon")).toBeInTheDocument();
    expect(sessionDetails?.querySelector(":scope > summary .dashboardDisclosureIcon")).toBeInTheDocument();
  });

  it("omits resource use from historical sessions", async () => {
    const state = historicalState("claude:history-1", "Historical session");
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/state" || url === "/api/state?sessionId=claude%3Ahistory-1") return Promise.resolve(jsonResponse(state));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    const { container } = renderDashboard([catalogSession(state)]);

    expect(await screen.findByRole("heading", { name: "Historical session" })).toBeInTheDocument();
    const repository = screen.getByText("Repository").closest("details");
    const sessionDetails = screen.getByText("Session details").closest("details");

    expect(screen.queryByText("Resource use")).not.toBeInTheDocument();
    expect(container.querySelector(".contentGrid")?.nextElementSibling).toBe(repository);
    expect(repository?.nextElementSibling).toBe(sessionDetails);
  });

  it("hides optional evidence without changing neighboring session regions", async () => {
    window.localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY, JSON.stringify({ contextHistory: false, estimatedCost: false }));
    const state = liveState("claude:hidden-evidence", "Focused session");
    state.capabilities = { ...state.capabilities, estimatedCost: true };
    state.session = state.session ? {
      ...state.session,
      cost: { amount: 1.25, currency: "USD", type: "estimated", observedAt: "2026-08-11T12:01:00.000Z" },
    } : null;
    mockDashboardState(state);
    renderDashboard([catalogSession(state)]);

    expect(await screen.findByRole("heading", { name: "Focused session" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Requests & actions" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Context history" })).not.toBeInTheDocument();
    expect(screen.getByText("Resource use")).toBeInTheDocument();
    expect(screen.getByText("Session details")).toBeInTheDocument();
    expect(screen.queryByText(/Estimated cost/)).not.toBeInTheDocument();
    expect(screen.queryAllByText("$1.25")).toHaveLength(0);
  });

  it("summarizes repository evidence without paths or hashes, and keeps both rows closed", async () => {
    mockDashboardState(detailedState());

    const { container } = renderDashboard([catalogSession(detailedState())]);

    const details = await waitFor(() => {
      const element = container.querySelector("details.sessionRepository");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const summary = details.querySelector("summary")!;
    const compact = summary.querySelector(".sessionEvidenceSummary");
    expect(details).not.toHaveAttribute("open");
    expect(compact).toHaveTextContent(/feature\/a-very-long-branch-name-that-must-truncate-without-losing-its-title · 0 commits · 2 files changed · working tree/);
    expect(compact).not.toHaveTextContent(/C:\\|app\/Dashboard|sha|hash/i);
    expect(compact).not.toHaveTextContent(/Usage|Loaded|activity/i);

    const sessionDetails = container.querySelector("details.sessionDetails")!;
    expect(sessionDetails).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("Repository"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByRole("region", { name: "Git branch overview" })).toBeInTheDocument();
  });

  it("persists Repository, Resource use, and Session details independently across remounts", async () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    window.localStorage.setItem("pomegr-disclosure-repository", "false");
    window.localStorage.setItem("pomegr-session-details-open", "false");
    mockDashboardState(detailedState({ files: [] }));
    const user = userEvent.setup();
    const first = renderDashboard([catalogSession(detailedState({ files: [] }))]);

    const resource = await waitFor(() => {
      const element = first.container.querySelector("details.resourceUsagePanel");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const session = first.container.querySelector("details.sessionDetails")!;
    const repository = first.container.querySelector("details.sessionRepository")!;
    expect(resource).toHaveAttribute("open");
    expect(repository).not.toHaveAttribute("open");
    expect(session).not.toHaveAttribute("open");

    await user.click(screen.getByText("Repository"));
    expect(repository).toHaveAttribute("open");
    await user.click(screen.getByText("Session details"));
    expect(resource).toHaveAttribute("open");
    expect(session).toHaveAttribute("open");
    await user.click(screen.getByText("Resource use"));
    expect(resource).not.toHaveAttribute("open");
    expect(session).toHaveAttribute("open");
    expect(window.localStorage.getItem("pomegr-resource-panel-open")).toBe("false");
    expect(window.localStorage.getItem("pomegr-disclosure-repository")).toBe("true");
    expect(window.localStorage.getItem("pomegr-session-details-open")).toBe("true");

    first.unmount();
    const restored = renderDashboard([catalogSession(detailedState({ files: [] }))]).container;
    await waitFor(() => expect(restored.querySelector("details.resourceUsagePanel")).toBeInTheDocument());
    expect(restored.querySelector("details.resourceUsagePanel")).not.toHaveAttribute("open");
    expect(restored.querySelector("details.sessionRepository")).toHaveAttribute("open");
    expect(restored.querySelector("details.sessionDetails")).toHaveAttribute("open");
  });

  it("shows sanitized unavailable Codex usage when the capability remains enabled", async () => {
    window.localStorage.setItem("pomegr-session-details-open", "false");
    const state = detailedState({ withContext: false, usageAvailable: false });
    state.source = "Codex";
    state.usageLimits.error = "Codex usage limits are temporarily unavailable.";
    mockDashboardState(state);
    const { container } = renderDashboard([catalogSession(state)]);
    await screen.findByText("Session details");
    await userEvent.click(screen.getByText("Session details"));
    expect(screen.getByRole("heading", { name: "Usage limits" })).toBeInTheDocument();
    expect(screen.getByText("The last usage check failed. Pomegr will retry automatically.")).toBeInTheDocument();
  });

  it("omits Codex usage UI when the provider capability is disabled", async () => {
    window.localStorage.setItem("pomegr-session-details-open", "false");
    const state = detailedState({ contextSupported: false });
    state.capabilities.usageLimits = false;
    mockDashboardState(state);
    const { container } = renderDashboard([catalogSession(state)]);
    const details = await waitFor(() => {
      const element = container.querySelector("details.sessionDetails");
      expect(element).toBeInTheDocument();
      return element!;
    });
    await userEvent.click(screen.getByText("Session details"));
    expect(screen.queryByRole("heading", { name: "Usage limits" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Git branch overview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent activity" })).toBeInTheDocument();
  });

  it("omits current Usage and missing Loaded values from a historical collapsed summary", async () => {
    const state = detailedState({ historical: true, withContext: false });
    mockDashboardState(state);
    const { container } = renderDashboard([catalogSession(state)]);
    const compact = await waitFor(() => {
      const element = container.querySelector(".sessionDetails .sessionEvidenceSummary");
      expect(element).toBeInTheDocument();
      return element!;
    });
    expect(compact).not.toHaveTextContent("Usage");
    expect(compact).not.toHaveTextContent("Loaded");
  });

  it("omits Loaded context inventory entirely when the selected provider does not support it", async () => {
    window.localStorage.setItem("pomegr-session-details-open", "true");
    mockDashboardState(detailedState({ contextSupported: false }));
    const { container } = renderDashboard([catalogSession(detailedState({ contextSupported: false }))]);
    await screen.findByText("Session details");
    expect(container.querySelector(".sessionDetails .cachePanel")).not.toBeInTheDocument();
    expect(container.querySelector(".sessionDetails")).not.toHaveTextContent("Loaded context inventory");
    expect(container.querySelector(".sessionDetails")).not.toHaveTextContent("/context");
  });

  it("uses the fallback details summary when no optional evidence is available", async () => {
    const state = liveState("claude:no-evidence", "No evidence");
    mockDashboardState(state);
    const { container } = renderDashboard([catalogSession(state)]);
    const summary = await waitFor(() => {
      const element = container.querySelector(".sessionDetails .sessionEvidenceSummary");
      expect(element).toBeInTheDocument();
      return element!;
    });
    expect(summary).toHaveTextContent("Approval mode, usage limits, machinery, activity");
  });

  it("uses the recorded state label for historical repository evidence", async () => {
    const state = detailedState({ historical: true, files: [] });
    mockDashboardState(state);
    const { container } = renderDashboard([catalogSession(state)]);
    const summary = await waitFor(() => {
      const element = container.querySelector(".sessionRepository .sessionEvidenceSummary");
      expect(element).toBeInTheDocument();
      return element!;
    });
    expect(summary).toHaveTextContent("recorded state");
    expect(summary).toHaveTextContent("0 commits");
    expect(summary).toHaveTextContent("0 files changed");
  });

  it("pins the first displayed session so live polling cannot navigate elsewhere", async () => {
    const firstSession = { ...liveState("claude:live-1", "First live session"), revision: 7 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/state") return Promise.resolve(jsonResponse(firstSession));
      if (url === "/api/state?sessionId=claude%3Alive-1") return Promise.resolve(jsonResponse(firstSession));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    renderDashboard([catalogSession(firstSession)]);

    expect(await screen.findByText("First live session")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain("/api/sessions");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/state?sessionId=claude%3Alive-1",
      expect.objectContaining({ cache: "no-store" }),
    ));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      "/api/state?sessionId=claude%3Alive-1&revision=7",
    );
  });

  it("selects only a normalized session ID from native notification navigation", async () => {
    window.history.replaceState(null, "", "/?sessionId=codex%3Anotified-1");
    const notified = liveState("codex:notified-1", "Notified session");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/state?sessionId=codex%3Anotified-1") return Promise.resolve(jsonResponse(notified));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    renderDashboard([catalogSession(notified)]);
    expect(await screen.findByText("Notified session")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/state?sessionId=codex%3Anotified-1",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(window.location.search).toBe("");
  });

  it("ignores unsafe notification navigation values", async () => {
    window.history.replaceState(null, "", "/?sessionId=codex%3A..%2Fprivate");
    const first = liveState("claude:live-1", "First live session");
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/state") return Promise.resolve(jsonResponse(first));
      if (url === "/api/state?sessionId=claude%3Alive-1") return Promise.resolve(jsonResponse(first));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    renderDashboard([catalogSession(first)]);
    expect(await screen.findByText("First live session")).toBeInTheDocument();
  });
});
