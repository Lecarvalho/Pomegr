"use client";

import { useCallback, useSyncExternalStore, type ReactNode, type SyntheticEvent } from "react";

const PREFERENCE_EVENT = "pomegr-disclosure-preference";
const inMemoryPreferences = new Map<string, boolean>();
const inMemoryOnlyPreferences = new Set<string>();

function readPreference(storageKey: string, defaultOpen: boolean) {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "true" || stored === "false") {
      const open = stored === "true";
      inMemoryPreferences.set(storageKey, open);
      inMemoryOnlyPreferences.delete(storageKey);
      return open;
    }
    if (inMemoryOnlyPreferences.has(storageKey) && inMemoryPreferences.has(storageKey)) {
      return inMemoryPreferences.get(storageKey) ?? defaultOpen;
    }
    inMemoryPreferences.set(storageKey, defaultOpen);
    return defaultOpen;
  } catch {
    if (!inMemoryPreferences.has(storageKey)) inMemoryPreferences.set(storageKey, defaultOpen);
    return inMemoryPreferences.get(storageKey) ?? defaultOpen;
  }
}

function useDisclosurePreference(storageKey: string, defaultOpen: boolean) {
  const snapshot = useCallback(() => readPreference(storageKey, defaultOpen), [defaultOpen, storageKey]);
  const serverSnapshot = useCallback(() => defaultOpen, [defaultOpen]);
  const subscribe = useCallback((onChange: () => void) => {
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === storageKey) onChange();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(PREFERENCE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(PREFERENCE_EVENT, onChange);
    };
  }, [storageKey]);
  const open = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const setOpen = useCallback((nextOpen: boolean) => {
    inMemoryPreferences.set(storageKey, nextOpen);
    try {
      window.localStorage.setItem(storageKey, String(nextOpen));
      inMemoryOnlyPreferences.delete(storageKey);
    } catch {
      inMemoryOnlyPreferences.add(storageKey);
    }
    window.dispatchEvent(new Event(PREFERENCE_EVENT));
  }, [storageKey]);
  return [open, setOpen] as const;
}

export function DashboardDisclosurePanel({
  bodyClassName = "",
  children,
  className = "",
  defaultOpen,
  storageKey,
  summary,
  title,
}: {
  bodyClassName?: string;
  children: ReactNode;
  className?: string;
  defaultOpen: boolean;
  storageKey: string;
  summary?: ReactNode;
  title: string;
}) {
  const [open, setOpen] = useDisclosurePreference(storageKey, defaultOpen);
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open);

  return (
    <details className={`dashboardDisclosurePanel panel ${className}`.trim()} open={open} onToggle={handleToggle}>
      <summary>
        <svg className="dashboardDisclosureIcon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 12h12" />
          <path className="dashboardDisclosureIconVertical" d="M12 6v12" />
        </svg>
        <span className="dashboardDisclosureTitle">{title}</span>
        {!open && summary}
      </summary>
      <div className={`dashboardDisclosurePanelBody ${bodyClassName}`.trim()}>{children}</div>
    </details>
  );
}
