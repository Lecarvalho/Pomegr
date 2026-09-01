import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../app/settings/SettingsPage";
import { DisplayPreferencesProvider, DISPLAY_PREFERENCES_STORAGE_KEY } from "../../app/hooks/DisplayPreferencesContext";

function renderSettings() {
  return render(<DisplayPreferencesProvider><SettingsPage /></DisplayPreferencesProvider>);
}

async function openDataDisplay(user = userEvent.setup()) {
  await user.click(screen.getByRole("tab", { name: "Data display" }));
}

afterEach(() => {
  window.localStorage.clear();
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  vi.restoreAllMocks();
});

describe("display preferences", () => {
  it("links settings tabs to panels and supports arrow-key navigation", async () => {
    const user = userEvent.setup();
    renderSettings();
    const appearance = screen.getByRole("tab", { name: "Appearance" });
    appearance.focus();
    expect(appearance).toHaveAttribute("aria-controls", "settings-panel-appearance");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "settings-tab-appearance");
    await user.keyboard("{ArrowDown}");
    const notifications = screen.getByRole("tab", { name: "Notifications" });
    expect(notifications).toHaveFocus();
    expect(notifications).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "settings-tab-notifications");
  });

  it("presents the About identity with the painted Pomegr mark beside its copy", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("tab", { name: "About" }));

    expect(screen.getByRole("heading", { name: "About Pomegr" })).toBeInTheDocument();
    expect(screen.getByText("A local-first, read-only observer for coding-agent sessions.")).toBeInTheDocument();
    expect(document.querySelector(".commandAboutIdentity .commandAboutIdentityMark.pomegrMark-divided")).toBeInTheDocument();
  });

  it("defaults both session displays on, persists changes, and restores defaults", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    await openDataDisplay(user);
    const contextHistory = screen.getByRole("switch", { name: /Context history/ });
    const estimatedCost = screen.getByRole("switch", { name: /API list-rate estimate/ });
    const restore = screen.getByRole("button", { name: "Restore defaults" });

    expect(contextHistory).toBeChecked();
    expect(estimatedCost).toBeChecked();
    expect(restore).toBeDisabled();

    await user.click(contextHistory);
    expect(contextHistory).not.toBeChecked();
    expect(JSON.parse(window.localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY) || "null")).toEqual({ contextHistory: false, estimatedCost: true });
    expect(restore).toBeEnabled();

    view.unmount();
    renderSettings();
    await openDataDisplay(user);
    expect(screen.getByRole("switch", { name: /Context history/ })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(screen.getByRole("switch", { name: /Context history/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /API list-rate estimate/ })).toBeChecked();
    expect(JSON.parse(window.localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY) || "null")).toEqual({ contextHistory: true, estimatedCost: true });
  });

  it("fails malformed or incomplete browser preferences closed to visible defaults", async () => {
    for (const value of ["malformed", JSON.stringify({ contextHistory: false }), JSON.stringify([false, false])]) {
      window.localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY, value);
      const view = renderSettings();
      await openDataDisplay();
      expect(screen.getByRole("switch", { name: /Context history/ })).toBeChecked();
      expect(screen.getByRole("switch", { name: /API list-rate estimate/ })).toBeChecked();
      view.unmount();
    }
  });

  it("uses the bounded desktop bridge instead of renderer storage", async () => {
    const user = userEvent.setup();
    const stored = JSON.stringify({ contextHistory: true, estimatedCost: false });
    window.localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY, stored);
    let state = { displayPreferences: { contextHistory: false, estimatedCost: true } };
    let listener: ((next: typeof state) => void) | undefined;
    const setDisplayPreference = vi.fn(async (key: "contextHistory" | "estimatedCost", visible: boolean) => {
      state = { displayPreferences: { ...state.displayPreferences, [key]: visible } };
      listener?.(state);
      return state;
    });
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = {
      getDesktopState: async () => state,
      setDisplayPreference,
      onDesktopStateChanged(callback: (next: typeof state) => void) { listener = callback; return () => { listener = undefined; }; },
    };

    renderSettings();
    await openDataDisplay(user);
    await waitFor(() => expect(screen.getByRole("switch", { name: /Context history/ })).not.toBeChecked());
    expect(screen.getByRole("switch", { name: /API list-rate estimate/ })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: /Context history/ }));
    expect(setDisplayPreference).toHaveBeenCalledWith("contextHistory", true);
    expect(window.localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY)).toBe(stored);
  });
});
