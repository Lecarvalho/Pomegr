import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors the real module's contract: `subscribeLiveEvents` synchronously delivers one
// connection snapshot to a new listener (see app/live-events.ts), which LegacySessionTab's
// `initialConnection` guard must swallow without scheduling anything.
const live = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>(), state: "connected" as "connected" | "reconnecting" }));
vi.mock("../../app/live-events", () => ({
  subscribeLiveEvents: (listener: (event: unknown) => void) => {
    live.listeners.add(listener);
    listener({ type: "connection", state: live.state, epoch: 0 });
    return () => live.listeners.delete(listener);
  },
}));

import { LegacySessionTab } from "../../app/components/dashboard/LegacySessionTab";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import type { MonitorState, SessionReadiness } from "../../shared/monitor-contract";
import { repositorySession } from "./dashboard-test-fixtures";

function emit(event: unknown) { for (const listener of live.listeners) listener(event); }
function json(body: object) { return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }
// Flushes the microtask queue enough times for a `fetch -> json() -> setState` chain to settle.
async function flush() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }
function readiness(overrides: Partial<SessionReadiness> = {}): SessionReadiness {
  return { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: "ready", usageLimits: "ready", ...overrides };
}
const noop = () => {};

function baseState(sessionId: string, overrides: Partial<MonitorState> = {}): MonitorState {
  const state = createEmptyMonitorState({ connected: true });
  return {
    ...state,
    session: {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      id: sessionId,
      title: "Session",
      project: "Pomegr",
    },
    ...overrides,
  };
}

function detailedState(sessionId: string, options: {
  historical?: boolean;
  branch?: string;
  files?: Array<{ status: string; path: string }>;
  usageAvailable?: boolean;
  codex?: boolean;
} = {}): MonitorState {
  const historical = options.historical ?? false;
  const state = baseState(sessionId);
  return {
    ...state,
    source: options.codex ? "Codex" : "Claude Code",
    capabilities: { ...state.capabilities, usageLimits: true, estimatedCost: true, contextMachinery: !options.codex },
    usageLimits: {
      available: options.usageAvailable ?? true,
      fetchedAt: "2026-08-11T12:01:00.000Z",
      attemptedAt: "2026-08-11T12:01:00.000Z",
      limits: options.usageAvailable === false ? [] : [
        { id: "short", label: "Short window", window: "5 hours", percent: 40, resetsAt: null, severity: "normal", active: true },
      ],
    },
    session: state.session ? {
      ...state.session,
      repository: {
        ...state.session.repository,
        available: true,
        historical,
        branch: options.branch ?? "feature/session-tabs",
        files: options.files ?? [{ status: "M", path: "app/Dashboard.tsx" }],
        commits: [{ hash: "abcdef1234567890", subject: "Do the thing", committedAt: "2026-08-11T11:00:00.000Z" }],
      },
    } : null,
  };
}

function tabElement(props: Partial<Parameters<typeof LegacySessionTab>[0]> & { sessionId: string; tab: "repository" | "resources" | "details" }) {
  return <LiveClockProvider running={false}><LegacySessionTab historical={false} paused={false} showEstimatedCost onNavigateAgent={noop} {...props} /></LiveClockProvider>;
}
function renderTab(props: Partial<Parameters<typeof LegacySessionTab>[0]> & { sessionId: string; tab: "repository" | "resources" | "details" }) {
  return render(tabElement(props));
}

beforeEach(() => {
  live.listeners.clear();
  live.state = "connected";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.removeItem("pomegr-disclosure-repository");
  window.localStorage.removeItem("pomegr-session-details-open");
});

describe("LegacySessionTab polling lifecycle", () => {
  it("fetches without a revision on first mount and renders the panel once data arrives", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(detailedState("claude:s1")));
    renderTab({ tab: "repository", sessionId: "claude:s1" });
    await screen.findByText("Repository");
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/state?sessionId=claude%3As1");
  });

  it("treats an initial 204 with no retained body as unavailable rather than a silent placeholder", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    renderTab({ tab: "repository", sessionId: "claude:s1" });
    await waitFor(() => expect(screen.getByText("This session panel is temporarily unavailable.")).toBeInTheDocument());
  });

  it("shows Loading, not 'temporarily unavailable', for a well-formed monitor loading placeholder on a cold first fetch", async () => {
    vi.useFakeTimers();
    const loadingPlaceholder = { ...detailedState("claude:s1"), session: null, readiness: readiness({
      core: "loading", agentEvidence: "loading", contextEvidence: "loading", activityEvidence: "loading",
      repository: "loading", resources: "loading", usageLimits: "loading",
    }) };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(loadingPlaceholder))
      .mockResolvedValueOnce(json(detailedState("claude:s1")));
    renderTab({ tab: "repository", sessionId: "claude:s1" });
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading repository…")).toBeInTheDocument();
    expect(screen.queryByText("This session panel is temporarily unavailable.")).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1_000); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Repository")).toBeInTheDocument();
  });

  it("rejects a loading placeholder whose catalogIdentity names a different session", async () => {
    const wrongSessionPlaceholder = { ...detailedState("claude:s1"), session: null, catalogIdentity: { id: "claude:other" }, readiness: readiness({
      core: "loading", agentEvidence: "loading", contextEvidence: "loading", activityEvidence: "loading",
      repository: "loading", resources: "loading", usageLimits: "loading",
    }) };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(wrongSessionPlaceholder));
    renderTab({ tab: "repository", sessionId: "claude:s1" });
    await waitFor(() => expect(screen.getByText("This session panel is temporarily unavailable.")).toBeInTheDocument());
  });

  it("keeps the retained panel visible with an update-failed notice when a later poll fails", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(detailedState("claude:s1")))
      .mockRejectedValueOnce(new Error("network"));
    renderTab({ tab: "repository", sessionId: "claude:s1" });
    await act(async () => { await flush(); });
    expect(screen.getByText("Repository")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(30_000); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Update failed. Showing the last recorded panel state.")).toBeInTheDocument();
    expect(screen.getByText("Repository")).toBeInTheDocument();
  });

  it("polls every second while retained readiness is loading, then settles to a thirty-second cadence once ready", async () => {
    vi.useFakeTimers();
    const loading = detailedState("claude:s1");
    loading.readiness = readiness({ repository: "loading" });
    const ready = detailedState("claude:s1");
    ready.readiness = readiness();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(loading))
      .mockResolvedValueOnce(json(ready))
      .mockResolvedValue(json(ready));
    renderTab({ tab: "repository", sessionId: "claude:s1" });
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1_000); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Retained readiness is now fully "ready": the fast one-second cadence must stop.
    await act(async () => { vi.advanceTimersByTime(1_000); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second poll's own thirty-second timer was scheduled starting from t=1_000, so it
    // fires at t=31_000; only 29_000ms remain after the t=2_000 checkpoint above.
    await act(async () => { vi.advanceTimersByTime(29_000); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries five seconds after a failed poll", async () => {
    vi.useFakeTimers();
    const ready = detailedState("claude:s1");
    ready.readiness = readiness();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(ready))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(json(ready));
    renderTab({ tab: "repository", sessionId: "claude:s1" });
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(30_000); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Update failed/)).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(4_999); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Update failed/)).not.toBeInTheDocument();
  });

  it("a reconnecting connection event reschedules the pending refresh five seconds out", async () => {
    vi.useFakeTimers();
    const ready = detailedState("claude:s1");
    ready.readiness = readiness();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ready));
    renderTab({ tab: "repository", sessionId: "claude:s1" });
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => emit({ type: "connection", state: "reconnecting" }));
    await act(async () => { vi.advanceTimersByTime(4_999); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("holds the cadence to thirty seconds while the tab is hidden, suppresses hidden live events, and resumes on foreground", async () => {
    vi.useFakeTimers();
    const original = Object.getOwnPropertyDescriptor(document, "hidden");
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    try {
      const loading = detailedState("claude:s1");
      loading.readiness = readiness({ repository: "loading" });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(loading));
      renderTab({ tab: "repository", sessionId: "claude:s1" });
      await act(async () => { await flush(); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      act(() => emit({ type: "revision", domain: "repository", sessionId: "claude:s1", revision: 2, epoch: 0 }));
      await act(async () => { await flush(); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Retained readiness is still "loading" (normally a one-second cadence), but hidden forces thirty.
      await act(async () => { vi.advanceTimersByTime(999); await flush(); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      hidden = false;
      act(() => window.dispatchEvent(new Event("focus")));
      await act(async () => { await flush(); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(document, "hidden", original);
    }
  });

  it("coalesces a live event received mid-flight into a single follow-up fetch instead of an extra concurrent one", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstPromise = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(json(detailedState("claude:s1")));
    renderTab({ tab: "repository", sessionId: "claude:s1" });
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => emit({ type: "revision", domain: "repository", sessionId: "claude:s1", revision: 2, epoch: 0 }));
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { resolveFirst(json(detailedState("claude:s1"))); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resets revision and retained state on a session change so the new request carries no revision and nothing stale is shown", async () => {
    const stateA = detailedState("claude:s1", { branch: "feature/session-a" });
    const stateB = detailedState("claude:s2", { branch: "feature/session-b" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("claude%3As1")) return json(stateA);
      if (url.includes("claude%3As2")) return json(stateB);
      return new Response(null, { status: 404 });
    });
    const view = renderTab({ tab: "repository", sessionId: "claude:s1" });
    await waitFor(() => expect(screen.getAllByText("feature/session-a").length).toBeGreaterThan(0));
    view.rerender(tabElement({ tab: "repository", sessionId: "claude:s2" }));
    // Old session's evidence (both the collapsed chip and the always-rendered <details> body)
    // must not remain visible during the reset/reload.
    expect(screen.queryByText("feature/session-a")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("feature/session-b").length).toBeGreaterThan(0));
    const secondSessionCall = fetchMock.mock.calls.find(([input]) => String(input).includes("claude%3As2"));
    expect(String(secondSessionCall?.[0])).not.toContain("revision=");
  });

  it("ignores a late response from an aborted in-flight request when the polling effect restarts", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstPromise = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(json(detailedState("claude:s1", { branch: "feature/second-poll" })));
    const view = renderTab({ tab: "repository", sessionId: "claude:s1" });
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Toggling `historical` re-runs the polling effect: its cleanup aborts the first, still-
    // in-flight controller and a fresh poll begins immediately for the same session.
    view.rerender(tabElement({ tab: "repository", sessionId: "claude:s1", historical: true }));
    await waitFor(() => expect(screen.getAllByText("feature/second-poll").length).toBeGreaterThan(0));
    await act(async () => { resolveFirst(json(detailedState("claude:s1", { branch: "feature/first-poll-stale" }))); await flush(); });
    expect(screen.queryByText("feature/first-poll-stale")).not.toBeInTheDocument();
    expect(screen.getAllByText("feature/second-poll").length).toBeGreaterThan(0);
  });
});

describe("LegacySessionTab historical retry cadence", () => {
  it("retries an unresolved historical placeholder five seconds later", async () => {
    vi.useFakeTimers();
    const loadingPlaceholder = { ...detailedState("claude:s1"), session: null, readiness: readiness({
      core: "loading", agentEvidence: "loading", contextEvidence: "loading", activityEvidence: "loading",
      repository: "loading", resources: "loading", usageLimits: "loading",
    }) };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(loadingPlaceholder))
      .mockResolvedValueOnce(json(detailedState("claude:s1")));
    renderTab({ tab: "repository", sessionId: "claude:s1", historical: true });
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading repository…")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(4_999); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Repository")).toBeInTheDocument();
  });

  it("retries a failed historical poll five seconds later", async () => {
    vi.useFakeTimers();
    const ready = detailedState("claude:s1");
    ready.readiness = readiness();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(json(ready));
    renderTab({ tab: "repository", sessionId: "claude:s1", historical: true });
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("This session panel is temporarily unavailable.")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(4_999); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Repository")).toBeInTheDocument();
  });

  it("schedules no further timer once a historical poll fully resolves", async () => {
    vi.useFakeTimers();
    const ready = detailedState("claude:s1");
    ready.readiness = readiness();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ready));
    renderTab({ tab: "repository", sessionId: "claude:s1", historical: true });
    await act(async () => { await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(60_000); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("LegacySessionTab privacy and historical isolation (ported from deleted dashboard suites)", () => {
  it("summarizes repository evidence without paths or hashes, and reveals full evidence once expanded", async () => {
    const data = detailedState("claude:s1", {
      branch: "feature/a-very-long-branch-name-that-must-truncate-without-losing-its-title",
      files: [
        { status: "M", path: "app/Dashboard.tsx" },
        { status: "A", path: "tests/ui/dashboard-components.test.tsx" },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(data));
    const { container } = renderTab({ tab: "repository", sessionId: "claude:s1" });
    const details = await waitFor(() => {
      const element = container.querySelector("details.sessionRepository");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const summary = details.querySelector("summary")!;
    const compact = summary.querySelector(".sessionEvidenceSummary");
    expect(details).not.toHaveAttribute("open");
    expect(compact).toHaveTextContent(/feature\/a-very-long-branch-name-that-must-truncate-without-losing-its-title · 1 commits · 2 files changed · working tree/);
    expect(compact).not.toHaveTextContent(/C:\\|app\/Dashboard|sha|hash/i);
    await userEvent.click(screen.getByText("Repository"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByRole("region", { name: "Git branch overview" })).toBeInTheDocument();
  });

  it("labels a historical repository summary as recorded state, using a distinct region label", async () => {
    const data = detailedState("claude:s1", { historical: true, files: [] });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(data));
    const { container } = renderTab({ tab: "repository", sessionId: "claude:s1", historical: true });
    const summary = await waitFor(() => {
      const element = container.querySelector(".sessionRepository .sessionEvidenceSummary");
      expect(element).toBeInTheDocument();
      return element!;
    });
    expect(summary).toHaveTextContent("recorded state");
    await userEvent.click(screen.getByText("Repository"));
    expect(screen.getByRole("region", { name: "Recorded Git branch" })).toBeInTheDocument();
  });

  it("hides Usage limits from a historical Session details tab even when the capability is enabled", async () => {
    const data = detailedState("claude:s1", { historical: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(data));
    renderTab({ tab: "details", sessionId: "claude:s1", historical: true });
    await screen.findByText("Session details");
    await userEvent.click(screen.getByText("Session details"));
    expect(screen.queryByRole("heading", { name: "Usage limits" })).not.toBeInTheDocument();
  });

  it("shows a sanitized Codex usage failure message instead of the raw upstream error text", async () => {
    const data = detailedState("claude:s1", { codex: true, usageAvailable: false });
    data.usageLimits.error = "raw upstream failure detail that must never reach the browser";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(data));
    renderTab({ tab: "details", sessionId: "claude:s1" });
    await screen.findByText("Session details");
    await userEvent.click(screen.getByText("Session details"));
    expect(screen.getByRole("heading", { name: "Usage limits" })).toBeInTheDocument();
    expect(screen.getByText("The last usage check failed. Pomegr will retry automatically.")).toBeInTheDocument();
    expect(screen.queryByText(/raw upstream failure detail/)).not.toBeInTheDocument();
  });

  it("omits Codex usage UI when the provider capability is disabled", async () => {
    const data = detailedState("claude:s1", { codex: true });
    data.capabilities.usageLimits = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(data));
    renderTab({ tab: "details", sessionId: "claude:s1" });
    await screen.findByText("Session details");
    await userEvent.click(screen.getByText("Session details"));
    expect(screen.queryByRole("heading", { name: "Usage limits" })).not.toBeInTheDocument();
  });

  it("omits current Usage and missing Loaded values from a historical collapsed summary", async () => {
    const data = detailedState("claude:s1", { historical: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(data));
    const { container } = renderTab({ tab: "details", sessionId: "claude:s1", historical: true });
    const compact = await waitFor(() => {
      const element = container.querySelector(".sessionDetails .sessionEvidenceSummary");
      expect(element).toBeInTheDocument();
      return element!;
    });
    expect(compact).not.toHaveTextContent("Usage");
    expect(compact).not.toHaveTextContent("Loaded");
  });

  it("omits Loaded context inventory entirely when the selected provider does not support it", async () => {
    const data = detailedState("claude:s1");
    data.capabilities.contextMachinery = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(data));
    const { container } = renderTab({ tab: "details", sessionId: "claude:s1" });
    await screen.findByText("Session details");
    await userEvent.click(screen.getByText("Session details"));
    expect(container.querySelector(".sessionDetails .cachePanel")).not.toBeInTheDocument();
    expect(container.querySelector(".sessionDetails")).not.toHaveTextContent("Loaded context inventory");
    expect(container.querySelector(".sessionDetails")).not.toHaveTextContent("/context");
  });

  it("falls back to the generic evidence summary when no optional details evidence is available", async () => {
    const data = baseState("claude:s1");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(data));
    const { container } = renderTab({ tab: "details", sessionId: "claude:s1" });
    const summary = await waitFor(() => {
      const element = container.querySelector(".sessionDetails .sessionEvidenceSummary");
      expect(element).toBeInTheDocument();
      return element!;
    });
    expect(summary).toHaveTextContent("Approval mode, usage limits, machinery");
  });
});
