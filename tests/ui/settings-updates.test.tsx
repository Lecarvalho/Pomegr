import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../../app/components/DesktopControls";
import { SettingsPage } from "../../app/settings/SettingsPage";

const initial: DesktopState = {
  applicationVersion: "0.2.2",
  paused: false, launchAtLogin: false, launchAtLoginAvailable: true,
  closeBehavior: "ask", notifications: true, notificationQuietUntil: null,
  displayPreferences: { contextHistory: true, estimatedCost: true },
  update: { status: "idle", version: null, lastCheckedAt: null },
};

function setupDesktop(state = initial) {
  const listeners = new Set<(next: DesktopState) => void>();
  const bridge = {
    getDesktopState: vi.fn(async (): Promise<DesktopState | null> => state),
    checkForUpdates: vi.fn(async (): Promise<DesktopState | null> => state),
    installUpdate: vi.fn(async (): Promise<DesktopState | null> => ({ ...state, update: { status: "installing", version: "0.2.3" } })),
    onDesktopStateChanged(callback: (next: DesktopState) => void) {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  };
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
  return { bridge, listeners, publish: (next: DesktopState) => act(() => { for (const listener of listeners) listener(next); }) };
}

async function openAbout() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: /^About/ }));
  return user;
}

afterEach(() => {
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  vi.restoreAllMocks();
});

describe("Settings desktop updates", () => {
  it("keeps native version and update controls out of browser settings", async () => {
    render(<SettingsPage />);
    await openAbout();
    expect(screen.getByRole("heading", { name: "About Pomegr" })).toBeInTheDocument();
    expect(screen.queryByText("Application version")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
    expect(screen.queryByText("v0.2.0")).not.toBeInTheDocument();
  });

  it("checks only on demand, shows the installed version and successful check time, and prevents repeated clicks", async () => {
    const { bridge } = setupDesktop();
    let finish!: (value: DesktopState) => void;
    bridge.checkForUpdates.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<SettingsPage />);
    const user = await openAbout();
    expect(screen.getByText("v0.2.2")).toBeInTheDocument();
    expect(screen.queryByText("You’re up to date.")).not.toBeInTheDocument();
    expect(bridge.checkForUpdates).not.toHaveBeenCalled();
    await user.dblClick(screen.getByRole("button", { name: "Check for updates" }));
    expect(bridge.checkForUpdates).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await act(async () => finish({ ...initial, update: { status: "idle", version: null, lastCheckedAt: "2026-09-04T14:00:00.000Z" } }));
    expect(screen.getByRole("status")).toHaveTextContent("You’re up to date.");
    expect(document.querySelector("time")).toHaveAttribute("datetime", "2026-09-04T14:00:00.000Z");
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("announces background download and ready states, badges About, and installs only on explicit activation", async () => {
    const { bridge, publish, listeners } = setupDesktop();
    const view = render(<SettingsPage />);
    await waitFor(() => expect(listeners.size).toBe(1));
    publish({ ...initial, update: { status: "ready", version: "0.2.3" } });
    expect(screen.getByRole("img", { name: "Update ready to install" })).toBeInTheDocument();
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    const user = await openAbout();
    expect(screen.getByRole("status")).toHaveTextContent("v0.2.3 is ready to install. Pomegr will restart.");
    await user.click(screen.getByRole("button", { name: "Restart and install" }));
    expect(bridge.installUpdate).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole("button", { name: "Restarting…" })).toBeDisabled();
    expect(screen.queryByRole("img", { name: "Update ready to install" })).not.toBeInTheDocument();
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it.each([
    ["checking", "Checking…", "Checking for updates…"],
    ["downloading", "Downloading…", "Downloading v0.2.3…"],
    ["disabled", "Check for updates", "Updates are unavailable in this app configuration."],
  ] as const)("disables actions while %s", async (status, button, message) => {
    const { bridge } = setupDesktop({ ...initial, update: { status, version: "0.2.3" } });
    render(<SettingsPage />);
    const user = await openAbout();
    expect(screen.getByRole("status")).toHaveTextContent(message);
    await user.click(screen.getByRole("button", { name: button }));
    expect(screen.getByRole("button", { name: button })).toBeDisabled();
    expect(bridge.checkForUpdates).not.toHaveBeenCalled();
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("offers retry on native failure without displaying raw error details", async () => {
    const { bridge } = setupDesktop();
    bridge.checkForUpdates.mockRejectedValueOnce(new Error("private path and remote response"));
    render(<SettingsPage />);
    const user = await openAbout();
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(screen.getByRole("status")).toHaveTextContent("Couldn’t check for updates. Try again.");
    expect(screen.queryByText(/private path/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridge.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Check for a newer version of Pomegr.");
  });

  it("renders a failed updater snapshot and retries through checking to downloading", async () => {
    const { bridge, publish } = setupDesktop({ ...initial, update: { status: "failed", version: null } });
    let finish!: (value: DesktopState) => void;
    bridge.checkForUpdates.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<SettingsPage />);
    const user = await openAbout();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn’t check for updates or finish the download.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridge.checkForUpdates).toHaveBeenCalledExactlyOnceWith();
    publish({ ...initial, update: { status: "checking", version: null } });
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    const downloading: DesktopState = { ...initial, update: { status: "downloading", version: "0.2.3" } };
    publish(downloading);
    await act(async () => finish(downloading));
    expect(screen.getByRole("status")).toHaveTextContent("Downloading v0.2.3…");
    expect(screen.getByRole("button", { name: "Downloading…" })).toBeDisabled();
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("recovers a failed install without losing the ready update", async () => {
    const ready: DesktopState = { ...initial, update: { status: "ready", version: "0.2.3" } };
    const { bridge } = setupDesktop(ready);
    bridge.installUpdate.mockResolvedValueOnce(ready);
    render(<SettingsPage />);
    const user = await openAbout();
    await user.click(screen.getByRole("button", { name: "Restart and install" }));
    expect(screen.getByRole("status")).toHaveTextContent("Couldn’t restart to install the update. Try again.");
    expect(screen.getByRole("button", { name: "Restart and install" })).toBeEnabled();
  });

  it("does not let a late initial snapshot replace a newer native update event", async () => {
    const { bridge, publish } = setupDesktop();
    let finish!: (value: DesktopState) => void;
    bridge.getDesktopState.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<SettingsPage />);
    await openAbout();
    publish({ ...initial, update: { status: "ready", version: "0.2.3" } });
    await act(async () => finish(initial));
    expect(screen.getByRole("button", { name: "Restart and install" })).toBeEnabled();
  });

  it("lets a user recover when the first state read fails", async () => {
    const { bridge } = setupDesktop();
    bridge.getDesktopState.mockRejectedValueOnce(new Error("private failure"));
    render(<SettingsPage />);
    const user = await openAbout();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(bridge.checkForUpdates).toHaveBeenCalledOnce();
    expect(screen.getByText("v0.2.2")).toBeInTheDocument();
  });
});
