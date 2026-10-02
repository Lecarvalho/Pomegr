import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../../app/components/DesktopControls";
import { SettingsPage } from "../../app/settings/SettingsPage";

const initial: DesktopState = {
  applicationVersion: "0.6.0",
  paused: false, launchAtLogin: false, launchAtLoginAvailable: true,
  closeBehavior: "ask", notifications: true, notificationQuietUntil: null,
  displayPreferences: { estimatedCost: true },
  update: { status: "idle", version: null, lastCheckedAt: null },
};

function setupDesktop(start = initial) {
  let state = start;
  const bridge = {
    getDesktopState: vi.fn(async () => state),
    onDesktopStateChanged: () => () => {},
    setNotifications: vi.fn(async (value: boolean) => (state = { ...state, notifications: value, notificationQuietUntil: value ? state.notificationQuietUntil : null })),
    setNotificationQuiet: vi.fn(async (value: boolean) => (state = { ...state, notificationQuietUntil: value ? "2026-10-01T13:00:00.000Z" : null })),
    setCloseBehavior: vi.fn(async (value: DesktopState["closeBehavior"]): Promise<DesktopState | null> => (state = { ...state, closeBehavior: value })),
  };
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
  return bridge;
}

async function open(tab: string) {
  const user = userEvent.setup();
  render(<SettingsPage />);
  await user.click(screen.getByRole("tab", { name: tab }));
  return user;
}

afterEach(() => {
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  vi.restoreAllMocks();
});

describe("Settings desktop behavior", () => {
  it("keeps the browser on the desktop-managed label with no Desktop section", async () => {
    await open("Notifications");
    expect(screen.getByText("Desktop managed")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Needs-input alerts/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Desktop" })).not.toBeInTheDocument();
  });

  it("switches needs-input alerts and the one-hour quiet mode through the desktop bridge", async () => {
    const bridge = setupDesktop();
    const user = await open("Notifications");
    const alerts = screen.getByRole("switch", { name: /Needs-input alerts/ });
    const quiet = screen.getByRole("switch", { name: /Quiet for one hour/ });
    await waitFor(() => expect(alerts).toBeChecked());
    expect(quiet).not.toBeChecked();
    await user.click(quiet);
    expect(bridge.setNotificationQuiet).toHaveBeenCalledExactlyOnceWith(true);
    await waitFor(() => expect(quiet).toBeChecked());
    expect(screen.getByText(/^Alerts are paused until /)).toBeInTheDocument();
    await user.click(alerts);
    expect(bridge.setNotifications).toHaveBeenCalledExactlyOnceWith(false);
    await waitFor(() => expect(alerts).not.toBeChecked());
    expect(quiet).not.toBeChecked();
    expect(quiet).toBeDisabled();
  });

  it("sets the close behavior and reports a failed save without raw details", async () => {
    const bridge = setupDesktop({ ...initial, closeBehavior: "tray" });
    const user = await open("Desktop");
    const choice = (name: string) => screen.getByRole("button", { name });
    await waitFor(() => expect(choice("Keep in tray")).toHaveAttribute("aria-pressed", "true"));
    await user.click(choice("Ask"));
    expect(bridge.setCloseBehavior).toHaveBeenCalledExactlyOnceWith("ask");
    await waitFor(() => expect(choice("Ask")).toHaveAttribute("aria-pressed", "true"));
    bridge.setCloseBehavior.mockRejectedValueOnce(new Error("private path"));
    await user.click(choice("Quit"));
    expect(await screen.findByText("Couldn’t save this setting. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/private path/)).not.toBeInTheDocument();
    expect(choice("Ask")).toHaveAttribute("aria-pressed", "true");
  });
});
