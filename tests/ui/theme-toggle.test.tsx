import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "../../app/components/ThemeToggle";

describe("color theme toggle", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    window.localStorage.clear();
    delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  });

  it("switches to dark mode and persists the preference", async () => {
    document.documentElement.dataset.theme = "light";
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const toggle = await screen.findByRole("button", { name: "Switch to dark mode" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem("pomegr-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches back to light mode", async () => {
    document.documentElement.dataset.theme = "dark";
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(await screen.findByRole("button", { name: "Switch to light mode" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("pomegr-theme")).toBe("light");
  });

  it("synchronizes initial and changed themes with the bounded desktop bridge", async () => {
    const setNativeTheme = vi.fn().mockResolvedValue(true);
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { setNativeTheme };
    document.documentElement.dataset.theme = "light";
    const user = userEvent.setup();
    render(<ThemeToggle />);

    expect(await screen.findByRole("button", { name: "Switch to dark mode" })).toBeVisible();
    expect(setNativeTheme).toHaveBeenCalledWith("light");
    await user.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(setNativeTheme).toHaveBeenLastCalledWith("dark");
    expect(setNativeTheme).toHaveBeenCalledTimes(2);
  });
});
