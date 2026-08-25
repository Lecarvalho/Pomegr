"use client";

import { useAppNavigation } from "./app-navigation";

export function NavigationMenuButton({ label = "Open session navigation" }: { label?: string }) {
  const navigation = useAppNavigation();
  return (
    <button
      className="sessionMenuButton"
      type="button"
      onClick={navigation.openNavigation}
      aria-label={label}
      aria-expanded={navigation.open}
      aria-controls="session-navigation"
      title={label}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
    </button>
  );
}
