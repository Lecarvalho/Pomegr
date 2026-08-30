import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOME_PIN_LIMIT,
  HOME_PREFERENCES_STORAGE_KEY,
  normalizeHomePin,
  useHomePreferences,
} from "../../app/hooks/useHomePreferences";

function notifyStorage(key: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

afterEach(() => {
  window.localStorage.clear();
  notifyStorage(null);
  vi.restoreAllMocks();
});

describe("Home preferences", () => {
  it("hydrates pins and the last viewed session, then restores them on remount", async () => {
    const initial = {
      version: 1,
      pins: [{ kind: "view", id: "sessions" }],
      lastViewedSessionId: "codex:previous",
    };
    window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify(initial));

    const first = renderHook(() => useHomePreferences());
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    expect(first.result.current.pins).toEqual([{ kind: "view", id: "sessions" }]);
    expect(first.result.current.lastViewedSessionId).toBe("codex:previous");
    expect(first.result.current.persistent).toBe(true);

    act(() => first.result.current.togglePin({ kind: "project", id: "Pomegr" }));
    act(() => first.result.current.rememberSession("claude:current"));
    first.unmount();

    const second = renderHook(() => useHomePreferences());
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(second.result.current.pins).toEqual([
      { kind: "view", id: "sessions" },
      { kind: "project", id: "Pomegr" },
    ]);
    expect(second.result.current.lastViewedSessionId).toBe("claude:current");
  });

  it("applies cross-tab updates and a storage clear", async () => {
    const view = renderHook(() => useHomePreferences());
    await waitFor(() => expect(view.result.current.ready).toBe(true));

    act(() => {
      window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({
        version: 1,
        pins: [{ kind: "view", id: "repositories" }],
        lastViewedSessionId: "codex:other",
      }));
      notifyStorage(HOME_PREFERENCES_STORAGE_KEY);
    });
    await waitFor(() => expect(view.result.current.pins).toEqual([{ kind: "view", id: "repositories" }]));
    expect(view.result.current.lastViewedSessionId).toBe("codex:other");

    act(() => {
      window.localStorage.clear();
      notifyStorage(null);
    });
    await waitFor(() => expect(view.result.current.pins).toEqual([]));
    expect(view.result.current.lastViewedSessionId).toBeNull();
  });

  it("drops corrupt, unsafe, oversized, and unknown data while retaining bounded safe pins", async () => {
    const safePins = [
      { kind: "session", id: "codex:one", metadata: "omit" },
      { kind: "session", id: "claude:two" },
      { kind: "project", id: "Pomegr" },
      { kind: "view", id: "agents" },
      { kind: "view", id: "usage-limits" },
      { kind: "view", id: "repositories" },
      { kind: "view", id: "dashboards" },
    ];
    window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      pins: [
        ...safePins,
        { kind: "session", id: "codex:bad/value" },
        { kind: "project", id: "C:\\workspace\\private" },
        { kind: "project", id: "\u0000unsafe" },
        { kind: "view", id: "external" },
      ],
      lastViewedSessionId: "codex:bad/value",
      rawPrompt: "must never persist",
    }));

    const view = renderHook(() => useHomePreferences());
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.pins).toEqual(safePins.slice(0, HOME_PIN_LIMIT).map(({ kind, id }) => ({ kind, id })));
    expect(view.result.current.lastViewedSessionId).toBeNull();

    window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, "x".repeat(16_385));
    act(() => notifyStorage(HOME_PREFERENCES_STORAGE_KEY));
    await waitFor(() => expect(view.result.current.pins).toEqual([]));
  });

  it("persists only the bounded schema and uses latest state for successive updates", async () => {
    const view = renderHook(() => useHomePreferences());
    await waitFor(() => expect(view.result.current.ready).toBe(true));

    act(() => {
      view.result.current.togglePin({ kind: "view", id: "sessions" });
      view.result.current.togglePin({ kind: "project", id: "Pomegr" });
      view.result.current.rememberSession("codex:remembered");
    });
    expect(JSON.parse(window.localStorage.getItem(HOME_PREFERENCES_STORAGE_KEY) || "null")).toEqual({
      version: 1,
      pins: [
        { kind: "view", id: "sessions" },
        { kind: "project", id: "Pomegr" },
      ],
      lastViewedSessionId: "codex:remembered",
    });

    act(() => {
      view.result.current.togglePin({ kind: "project", id: "C:\\workspace\\private" });
      view.result.current.togglePin({ kind: "view", id: "external" });
    });
    expect(view.result.current.pins).toHaveLength(2);
  });

  it("keeps existing pins when all six slots are occupied", async () => {
    const view = renderHook(() => useHomePreferences());
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    const existing = [
      { kind: "view" as const, id: "sessions" },
      { kind: "view" as const, id: "agents" },
      { kind: "view" as const, id: "usage-limits" },
      { kind: "view" as const, id: "repositories" },
      { kind: "view" as const, id: "dashboards" },
      { kind: "session" as const, id: "codex:one" },
    ];
    act(() => existing.forEach((pin) => view.result.current.togglePin(pin)));
    act(() => view.result.current.togglePin({ kind: "project", id: "Pomegr" }));
    expect(view.result.current.pins).toEqual(existing);
  });

  it("retains memory state across a denied write and remount", async () => {
    window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [], lastViewedSessionId: null }));
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("write denied"); });
    const view = renderHook(() => useHomePreferences());
    await waitFor(() => expect(view.result.current.ready).toBe(true));

    act(() => {
      view.result.current.togglePin({ kind: "view", id: "dashboards" });
      view.result.current.rememberSession("codex:remembered");
    });
    expect(view.result.current.pins).toEqual([{ kind: "view", id: "dashboards" }]);
    expect(view.result.current.lastViewedSessionId).toBe("codex:remembered");
    expect(view.result.current.persistent).toBe(false);
    view.unmount();

    const remounted = renderHook(() => useHomePreferences());
    await waitFor(() => expect(remounted.result.current.ready).toBe(true));
    expect(remounted.result.current.pins).toEqual([{ kind: "view", id: "dashboards" }]);
    expect(remounted.result.current.lastViewedSessionId).toBe("codex:remembered");
    expect(setItem).toHaveBeenCalled();

    setItem.mockRestore();
    act(() => remounted.result.current.togglePin({ kind: "view", id: "dashboards" }));
  });

  it("remains usable in memory when browser storage is unavailable", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    const view = renderHook(() => useHomePreferences());
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.persistent).toBe(false);

    act(() => view.result.current.togglePin({ kind: "view", id: "dashboards" }));
    expect(view.result.current.pins).toEqual([{ kind: "view", id: "dashboards" }]);
    expect(view.result.current.persistent).toBe(false);
    expect(getItem).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalled();
  });

  it("shares one pin normalizer with destination callers and strips metadata", () => {
    expect(normalizeHomePin({ kind: "project", id: "Pomegr", title: "Private metadata" })).toEqual({ kind: "project", id: "Pomegr" });
    expect(normalizeHomePin({ kind: "project", id: " Pomegr" })).toBeNull();
    expect(normalizeHomePin({ kind: "view", id: "external", href: "https://example.test" })).toBeNull();
  });
});
