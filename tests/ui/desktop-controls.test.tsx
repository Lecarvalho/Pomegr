import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import type { DesktopState } from "../../app/components/DesktopControls";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";

function response(body: object) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => {
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("desktop controls", () => {
  it("keeps session pause accessible without desktop settings in the session toolbar", async () => {
    const user = userEvent.setup();
    let state: DesktopState = { paused: false, launchAtLogin: false, launchAtLoginAvailable: true, closeBehavior: "ask", notifications: true, notificationQuietUntil: null, displayPreferences: { contextHistory: true, estimatedCost: true } };
    let stateListener: ((next: DesktopState) => void) | undefined;
    const setPaused = vi.fn(async (value: boolean) => (state = { ...state, paused: value }));
    const setLaunchAtLogin = vi.fn(async (value: boolean) => (state = { ...state, launchAtLogin: value }));
    const setCloseBehavior = vi.fn(async (value: DesktopState["closeBehavior"]) => (state = { ...state, closeBehavior: value }));
    const setNotifications = vi.fn(async (value: boolean) => (state = { ...state, notifications: value }));
    const setNotificationQuiet = vi.fn(async (value: boolean) => (state = { ...state, notificationQuietUntil: value ? "2026-08-12T13:00:00.000Z" : null }));
    const quit = vi.fn(async () => true);
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = {
      saveReport: vi.fn(),
      getDesktopState: async () => state,
      setPaused,
      setLaunchAtLogin,
      setCloseBehavior,
      setNotifications,
      setNotificationQuiet,
      quit,
      onDesktopStateChanged(callback: (next: DesktopState) => void) { stateListener = callback; return () => { stateListener = undefined; }; },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => String(input).startsWith("/api/sessions")
      ? response({ sessions: [] })
      : response(createEmptyMonitorState({ connected: true })));

    render(<Dashboard />);
    await screen.findByLabelText("Session state: Unknown");
    expect(screen.queryByText("Desktop")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Desktop controls" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause updates" }));
    expect(setPaused).toHaveBeenCalledWith(true);
    expect(await screen.findByRole("button", { name: "Resume updates" })).toBeInTheDocument();
    expect(screen.getByLabelText("Session state: Unknown")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume updates" }));
    expect(setPaused).toHaveBeenLastCalledWith(false);
    expect(setLaunchAtLogin).not.toHaveBeenCalled();
    expect(setCloseBehavior).not.toHaveBeenCalled();
    expect(setNotifications).not.toHaveBeenCalled();
    expect(setNotificationQuiet).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    act(() => stateListener?.({ ...state, paused: false }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause updates" })).toBeInTheDocument());
  });

  it("tray pause stops both state and session-catalog polling without invoking provider controls", async () => {
    vi.useFakeTimers();
    let listener: ((next: DesktopState) => void) | undefined;
    const state: DesktopState = { paused: false, launchAtLogin: false, launchAtLoginAvailable: true, closeBehavior: "ask", notifications: true, notificationQuietUntil: null, displayPreferences: { contextHistory: true, estimatedCost: true } };
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = {
      saveReport: vi.fn(),
      getDesktopState: async () => state,
      setPaused: vi.fn(),
      setLaunchAtLogin: vi.fn(),
      setCloseBehavior: vi.fn(),
      setNotifications: vi.fn(),
      setNotificationQuiet: vi.fn(),
      quit: vi.fn(),
      onDesktopStateChanged(callback: (next: DesktopState) => void) { listener = callback; return () => { listener = undefined; }; },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => String(input).startsWith("/api/sessions")
      ? response({ sessions: [] })
      : response(createEmptyMonitorState({ connected: true })));

    render(<Dashboard />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => listener?.({ ...state, paused: true }));
    await act(async () => { await Promise.resolve(); });
    const pausedRequestCount = fetchMock.mock.calls.length;
    act(() => vi.advanceTimersByTime(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(pausedRequestCount);
    expect(JSON.stringify((window as Window & { pomegrDesktop?: unknown }).pomegrDesktop)).not.toMatch(/provider|command|prompt|response/i);
  });

});
