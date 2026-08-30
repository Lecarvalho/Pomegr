"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { encodeSessionRoute } from "../../shared/session-route.mjs";

export const HOME_PREFERENCES_STORAGE_KEY = "pomegr-home-v1";
export const HOME_PIN_LIMIT = 6;
export const HOME_UPDATE_ID = "home-shortcuts-v1";

const HOME_PREFERENCES_EVENT = "pomegr:home-preferences-change";
const MAX_STORED_LENGTH = 16_384;
const MAX_STORED_PINS_TO_SCAN = 256;
const HOME_VIEW_IDS = new Set(["sessions", "agents", "usage-limits", "repositories", "dashboards"]);

export type HomePin = {
  kind: "session" | "project" | "view";
  id: string;
};

export type HomePreferences = {
  pins: HomePin[];
  lastViewedSessionId: string | null;
  ready: boolean;
  persistent: boolean;
  togglePin(pin: HomePin): void;
  rememberSession(id: string): void;
  updateDismissed: boolean;
  dismissUpdate(): void;
};

type StoredHomePreferences = {
  dismissedUpdateId?: string;
  version: 1;
  pins: HomePin[];
  lastViewedSessionId: string | null;
};

type HomeStoreSnapshot = StoredHomePreferences & {
  ready: boolean;
  persistent: boolean;
};

const EMPTY_STORED_PREFERENCES: StoredHomePreferences = Object.freeze({
  version: 1,
  pins: [],
  lastViewedSessionId: null,
});

const SERVER_SNAPSHOT: HomeStoreSnapshot = Object.freeze({
  ...EMPTY_STORED_PREFERENCES,
  ready: false,
  persistent: true,
});

let snapshot: HomeStoreSnapshot = {
  ...EMPTY_STORED_PREFERENCES,
  pins: [],
  ready: false,
  persistent: true,
};
let hydrated = false;
let inMemoryOnly = false;
const listeners = new Set<() => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    encodeSessionRoute(value);
    return value;
  } catch {
    return null;
  }
}

function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value || value !== value.trim() || value.length > 128) return null;
  if (/[\\/\u0000-\u001F\u007F-\u009F]/u.test(value)) return null;
  if (value === "." || value === "..") return null;
  if (/^[A-Za-z]:/.test(value) || value.includes("://")) return null;
  return value;
}

export function normalizeHomePin(value: unknown): HomePin | null {
  if (!isRecord(value) || (value.kind !== "session" && value.kind !== "project" && value.kind !== "view")) return null;
  if (value.kind === "session") {
    const id = normalizeSessionId(value.id);
    return id ? { kind: "session", id } : null;
  }
  if (value.kind === "project") {
    const id = normalizeProjectId(value.id);
    return id ? { kind: "project", id } : null;
  }
  return typeof value.id === "string" && HOME_VIEW_IDS.has(value.id)
    ? { kind: "view", id: value.id }
    : null;
}

function pinKey(pin: HomePin) {
  return `${pin.kind}:${pin.id}`;
}

function normalizePins(value: unknown): HomePin[] {
  if (!Array.isArray(value)) return [];
  const pins: HomePin[] = [];
  const seen = new Set<string>();
  const scanLimit = Math.min(value.length, MAX_STORED_PINS_TO_SCAN);
  for (let index = 0; index < scanLimit && pins.length < HOME_PIN_LIMIT; index += 1) {
    const pin = normalizeHomePin(value[index]);
    if (!pin) continue;
    const key = pinKey(pin);
    if (seen.has(key)) continue;
    seen.add(key);
    pins.push(pin);
  }
  return pins;
}

function normalizeStored(value: unknown): StoredHomePreferences {
  if (!isRecord(value) || value.version !== 1) return { ...EMPTY_STORED_PREFERENCES, pins: [] };
  return {
    version: 1,
    pins: normalizePins(value.pins),
    lastViewedSessionId: normalizeSessionId(value.lastViewedSessionId),
    ...(value.dismissedUpdateId === HOME_UPDATE_ID ? { dismissedUpdateId: HOME_UPDATE_ID } : {}),
  };
}

function serializeStored(value: StoredHomePreferences) {
  return JSON.stringify({
    version: 1,
    pins: value.pins,
    lastViewedSessionId: value.lastViewedSessionId,
    ...(value.dismissedUpdateId === HOME_UPDATE_ID ? { dismissedUpdateId: HOME_UPDATE_ID } : {}),
  });
}

function notify() {
  for (const listener of listeners) listener();
}

function readStored(): { value: StoredHomePreferences; persistent: boolean; serialized: string | null } {
  try {
    const stored = window.localStorage.getItem(HOME_PREFERENCES_STORAGE_KEY);
    if (stored === null || stored.length > MAX_STORED_LENGTH) {
      return { value: { ...EMPTY_STORED_PREFERENCES, pins: [] }, persistent: true, serialized: stored };
    }
    try {
      return { value: normalizeStored(JSON.parse(stored) as unknown), persistent: true, serialized: stored };
    } catch {
      return { value: { ...EMPTY_STORED_PREFERENCES, pins: [] }, persistent: true, serialized: stored };
    }
  } catch {
    return { value: { ...EMPTY_STORED_PREFERENCES, pins: [] }, persistent: false, serialized: null };
  }
}

function applyStoredValue() {
  if (inMemoryOnly && hydrated) return;
  const stored = readStored();
  if (!stored.persistent && hydrated) {
    snapshot = { ...snapshot, ready: true, persistent: false };
    notify();
    return;
  }
  if (stored.serialized !== null) {
    try {
      const canonical = serializeStored(stored.value);
      if (stored.serialized !== canonical) window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, canonical);
    } catch {
      stored.persistent = false;
      inMemoryOnly = true;
    }
  }
  snapshot = { ...stored.value, ready: true, persistent: stored.persistent };
  hydrated = true;
  notify();
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  applyStoredValue();
}

function refreshOnMount() {
  if (typeof window === "undefined") return;
  if (!hydrated) hydrate();
  else applyStoredValue();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (typeof window === "undefined") return () => listeners.delete(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === HOME_PREFERENCES_STORAGE_KEY) applyStoredValue();
  };
  const handleLocalChange = () => applyStoredValue();
  window.addEventListener("storage", handleStorage);
  window.addEventListener(HOME_PREFERENCES_EVENT, handleLocalChange);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(HOME_PREFERENCES_EVENT, handleLocalChange);
  };
}

function commit(next: StoredHomePreferences) {
  const serialized = serializeStored(next);
  let persistent = snapshot.persistent;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, serialized);
      persistent = true;
      inMemoryOnly = false;
    } catch {
      persistent = false;
      inMemoryOnly = true;
    }
  }
  snapshot = { ...next, ready: true, persistent };
  hydrated = true;
  notify();
  if (typeof window !== "undefined") {
    try { window.dispatchEvent(new Event(HOME_PREFERENCES_EVENT)); } catch { /* The memory state remains usable. */ }
  }
}

function update(updateFn: (current: StoredHomePreferences) => StoredHomePreferences) {
  const current: StoredHomePreferences = {
    version: 1,
    pins: snapshot.pins,
    lastViewedSessionId: snapshot.lastViewedSessionId,
    dismissedUpdateId: snapshot.dismissedUpdateId,
  };
  const next = updateFn(current);
  if (next.pins === current.pins && next.lastViewedSessionId === current.lastViewedSessionId && next.dismissedUpdateId === current.dismissedUpdateId) return;
  commit(next);
}

export function useHomePreferences(): HomePreferences {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT);
  useEffect(() => { refreshOnMount(); }, []);

  const togglePin = useCallback((value: HomePin) => {
    const pin = normalizeHomePin(value);
    if (!pin) return;
    update((state) => {
      const key = pinKey(pin);
      const existing = state.pins.some((candidate) => pinKey(candidate) === key);
      if (existing) return { ...state, pins: state.pins.filter((candidate) => pinKey(candidate) !== key) };
      if (state.pins.length >= HOME_PIN_LIMIT) return state;
      return { ...state, pins: [...state.pins, pin] };
    });
  }, []);

  const rememberSession = useCallback((id: string) => {
    const normalized = normalizeSessionId(id);
    if (!normalized) return;
    update((state) => state.lastViewedSessionId === normalized ? state : { ...state, lastViewedSessionId: normalized });
  }, []);

  const dismissUpdate = useCallback(() => {
    update((state) => ({ ...state, dismissedUpdateId: HOME_UPDATE_ID }));
  }, []);

  return {
    pins: current.pins,
    lastViewedSessionId: current.lastViewedSessionId,
    ready: current.ready,
    persistent: current.persistent,
    togglePin,
    rememberSession,
    updateDismissed: current.dismissedUpdateId === HOME_UPDATE_ID,
    dismissUpdate,
  };
}
