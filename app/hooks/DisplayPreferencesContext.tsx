"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

export type DisplayPreferences = {
  contextHistory: boolean;
  estimatedCost: boolean;
};

type DesktopPreferenceState = {
  displayPreferences?: Partial<DisplayPreferences>;
};

type DesktopPreferenceBridge = {
  getDesktopState(): Promise<DesktopPreferenceState | null>;
  setDisplayPreference?(key: keyof DisplayPreferences, visible: boolean): Promise<DesktopPreferenceState | null>;
  onDesktopStateChanged(callback: (state: DesktopPreferenceState) => void): () => void;
};

type DisplayPreferencesContextValue = {
  preferences: DisplayPreferences;
  setPreference: (key: keyof DisplayPreferences, visible: boolean) => void;
  resetPreferences: () => void;
};

export const DEFAULT_DISPLAY_PREFERENCES: Readonly<DisplayPreferences> = Object.freeze({
  contextHistory: true,
  estimatedCost: true,
});

export const DISPLAY_PREFERENCES_STORAGE_KEY = "pomegr-display-preferences-v1";
const DISPLAY_PREFERENCES_EVENT = "pomegr:display-preferences-change";
let inMemorySerializedPreferences = JSON.stringify(DEFAULT_DISPLAY_PREFERENCES);
let inMemoryOnlyPreferences = false;

function normalizePreferences(value: unknown): DisplayPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_DISPLAY_PREFERENCES };
  const source = value as Partial<DisplayPreferences>;
  if (typeof source.contextHistory !== "boolean" || typeof source.estimatedCost !== "boolean") return { ...DEFAULT_DISPLAY_PREFERENCES };
  return { contextHistory: source.contextHistory, estimatedCost: source.estimatedCost };
}

function serializedPreferences(value: unknown) {
  return JSON.stringify(normalizePreferences(value));
}

function readWebPreferences() {
  try {
    const stored = window.localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY);
    if (stored !== null) {
      try { inMemorySerializedPreferences = serializedPreferences(JSON.parse(stored)); } catch { inMemorySerializedPreferences = JSON.stringify(DEFAULT_DISPLAY_PREFERENCES); }
      inMemoryOnlyPreferences = false;
    } else if (!inMemoryOnlyPreferences) {
      inMemorySerializedPreferences = JSON.stringify(DEFAULT_DISPLAY_PREFERENCES);
    }
  } catch { /* The in-memory preference remains usable when browser storage is unavailable. */ }
  return inMemorySerializedPreferences;
}

function subscribeToWebPreferences(onChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === DISPLAY_PREFERENCES_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(DISPLAY_PREFERENCES_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(DISPLAY_PREFERENCES_EVENT, onChange);
  };
}

function writeWebPreferences(preferences: DisplayPreferences) {
  inMemorySerializedPreferences = serializedPreferences(preferences);
  try {
    window.localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY, inMemorySerializedPreferences);
    inMemoryOnlyPreferences = false;
  } catch {
    inMemoryOnlyPreferences = true;
  }
  window.dispatchEvent(new Event(DISPLAY_PREFERENCES_EVENT));
}

function desktopBridge() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pomegrDesktop?: DesktopPreferenceBridge }).pomegrDesktop;
}

const DisplayPreferencesContext = createContext<DisplayPreferencesContextValue>({
  preferences: DEFAULT_DISPLAY_PREFERENCES,
  setPreference() {},
  resetPreferences() {},
});

export function DisplayPreferencesProvider({ children }: { children: ReactNode }) {
  const webSnapshot = useSyncExternalStore(subscribeToWebPreferences, readWebPreferences, () => JSON.stringify(DEFAULT_DISPLAY_PREFERENCES));
  const webPreferences = useMemo(() => normalizePreferences(JSON.parse(webSnapshot)), [webSnapshot]);
  const [desktopPreferences, setDesktopPreferences] = useState<DisplayPreferences | null>(null);
  const bridgeAvailable = Boolean(desktopBridge());

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let active = true;
    const apply = (state: DesktopPreferenceState | null) => {
      if (active && state) setDesktopPreferences(normalizePreferences(state.displayPreferences));
    };
    void bridge.getDesktopState().then(apply, () => {});
    const unsubscribe = bridge.onDesktopStateChanged(apply);
    return () => { active = false; unsubscribe(); };
  }, []);

  const preferences = useMemo(
    () => bridgeAvailable ? desktopPreferences || { ...DEFAULT_DISPLAY_PREFERENCES } : webPreferences,
    [bridgeAvailable, desktopPreferences, webPreferences],
  );
  const persistWebPreferences = useCallback((next: DisplayPreferences) => {
    const bridge = desktopBridge();
    if (!bridge?.setDisplayPreference) writeWebPreferences(next);
  }, []);

  const setPreference = useCallback((key: keyof DisplayPreferences, visible: boolean) => {
    const next = { ...preferences, [key]: visible };
    const bridge = desktopBridge();
    if (!bridge?.setDisplayPreference) {
      persistWebPreferences(next);
      return;
    }
    setDesktopPreferences(next);
    void bridge.setDisplayPreference(key, visible).then((state) => {
      if (state) setDesktopPreferences(normalizePreferences(state.displayPreferences));
    }, () => {
      void bridge.getDesktopState().then((state) => {
        if (state) setDesktopPreferences(normalizePreferences(state.displayPreferences));
      }, () => {});
    });
  }, [persistWebPreferences, preferences]);
  const resetPreferences = useCallback(() => {
    const defaults = { ...DEFAULT_DISPLAY_PREFERENCES };
    const bridge = desktopBridge();
    const setDesktopPreference = bridge?.setDisplayPreference;
    if (!setDesktopPreference) {
      persistWebPreferences(defaults);
      return;
    }
    setDesktopPreferences(defaults);
    void Promise.all((Object.keys(defaults) as Array<keyof DisplayPreferences>)
      .map((key) => setDesktopPreference.call(bridge, key, defaults[key])))
      .then((states) => {
        const state = states[states.length - 1];
        if (state) setDesktopPreferences(normalizePreferences(state.displayPreferences));
      }, () => {
        void bridge.getDesktopState().then((state) => {
          if (state) setDesktopPreferences(normalizePreferences(state.displayPreferences));
        }, () => {});
      });
  }, [persistWebPreferences]);
  const value = useMemo(() => ({ preferences, setPreference, resetPreferences }), [preferences, resetPreferences, setPreference]);

  return <DisplayPreferencesContext.Provider value={value}>{children}</DisplayPreferencesContext.Provider>;
}

export function useDisplayPreferences() {
  return useContext(DisplayPreferencesContext);
}
