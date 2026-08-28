"use client";

import { useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark";
type DesktopThemeBridge = { setNativeTheme?: (source: Theme) => Promise<unknown> };

const THEME_STORAGE_KEY = "pomegr-theme";
const THEME_CHANGE_EVENT = "pomegr:theme-change";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
      window.addEventListener("storage", onStoreChange);
      return () => {
        window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
        window.removeEventListener("storage", onStoreChange);
      };
    },
    currentTheme,
    () => "light" as Theme,
  );

  useEffect(() => {
    const bridge = (window as Window & { pomegrDesktop?: DesktopThemeBridge }).pomegrDesktop;
    void bridge?.setNativeTheme?.(theme).catch(() => {});
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  };

  const action = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button className="themeToggle" type="button" onClick={toggleTheme} aria-label={action} aria-pressed={theme === "dark"} title={action}>
      <svg className="themeIcon moonIcon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M19 15.3A8 8 0 0 1 8.7 5a7.4 7.4 0 1 0 10.3 10.3Z" />
      </svg>
      <svg className="themeIcon sunIcon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
      </svg>
    </button>
  );
}
