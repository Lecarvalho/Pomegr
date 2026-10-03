import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationStore, normalizeNotificationSnapshot } from "../../app/notifications-client";
import { NotificationReadStore } from "../../app/notification-read-state";
import type { NotificationSnapshot } from "../../shared/notification-contract";

const observedAt = "2026-10-03T12:00:00.000Z";
function snapshot(revision: number, title?: string): NotificationSnapshot {
  return { version: 1, revision, generatedAt: observedAt,
    readiness: { catalog: "ready", providerStatus: "ready" },
    occurrences: title ? [{ id: "a".repeat(32), kind: "needs_input", category: "attention", severity: "warning",
      lifecycle: "active", priority: 100, occurredAt: observedAt, timeBasis: "recorded", deliveryEligible: false,
      action: "open_session", provider: "codex", data: { sessionId: "codex:input-1", sessionTitle: title } }] : [],
    activeSessionOverflow: 0 };
}
function response(value: NotificationSnapshot) { return Promise.resolve(new Response(JSON.stringify(value), { status: 200 })); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class NotificationEventSource {
  static instances: NotificationEventSource[] = [];
  private listeners = new Map<string, Set<EventListener>>();
  constructor() { NotificationEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (typeof listener !== "function") return;
    const listeners = this.listeners.get(type) || new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string, value?: object) {
    const event = value ? new MessageEvent(type, { data: JSON.stringify(value) }) : new Event(type);
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
  close() {}
}

beforeEach(() => {
  NotificationEventSource.instances = [];
  vi.stubGlobal("EventSource", NotificationEventSource);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("notification client store", () => {
  it("rejects array-valued identifiers and enums instead of coercing them, retaining the last good snapshot", async () => {
    const valid = snapshot(3, "Valid session");
    for (const field of ["id", "category", "severity", "action", "lifecycle", "timeBasis"]) {
      const malformed = structuredClone(valid);
      const row = malformed.occurrences[0] as unknown as Record<string, unknown>;
      row[field] = [row[field]];
      expect(normalizeNotificationSnapshot(malformed)).toBeNull();
    }
    const malformed = { ...valid, revision: 4, occurrences: [{ ...valid.occurrences[0],
      data: { sessionId: ["codex:input-1"], sessionTitle: "Bad array" } }] };
    expect(normalizeNotificationSnapshot(malformed)).toBeNull();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => response(valid))
      .mockResolvedValueOnce(new Response(JSON.stringify(malformed), { status: 200 }));
    const store = new NotificationStore();
    const unsubscribe = store.subscribe(() => {});
    try {
      await waitFor(() => expect(store.getSnapshot().snapshot.revision).toBe(3));
      NotificationEventSource.instances[0].emit("notifications", { domain: "notifications", revision: 4 });
      await waitFor(() => expect(store.getSnapshot().status).toBe("unavailable"));
      expect(store.getSnapshot().snapshot).toEqual(valid);
    } finally { unsubscribe(); }
  });

  it.each([0, 50])("ignores an older same-epoch event and rebaselines to revision %i after reconnect", async (restartRevision) => {
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response(snapshot(50, "Before restart")))
      .mockImplementationOnce(() => response(snapshot(restartRevision, "After restart")));
    const store = new NotificationStore();
    const unsubscribe = store.subscribe(() => {});
    try {
      await waitFor(() => expect(store.getSnapshot().snapshot.revision).toBe(50));
      NotificationEventSource.instances[0].emit("notifications", { domain: "notifications", revision: 0 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      NotificationEventSource.instances[0].emit("error");
      await waitFor(() => expect(NotificationEventSource.instances).toHaveLength(2));
      NotificationEventSource.instances[1].emit("open");
      await waitFor(() => expect(store.getSnapshot().snapshot).toMatchObject({ revision: restartRevision,
        occurrences: [{ data: { sessionTitle: "After restart" } }] }));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1][0]).toBe("/api/notifications");
    } finally { unsubscribe(); }
  });

  it.each(["pause", "remount"] as const)("restarts a poll after %s while an aborted request is still pending", async (mode) => {
    const first = deferred<Response>();
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => response(snapshot(2)));
    const store = new NotificationStore();
    let unsubscribe = store.subscribe(() => {});
    const pauseOwner = Symbol("test-pause");
    try {
      expect(fetcher).toHaveBeenCalledTimes(1);
      if (mode === "pause") {
        store.setPaused(pauseOwner, true);
        store.setPaused(pauseOwner, false);
      } else {
        unsubscribe();
        unsubscribe = store.subscribe(() => {});
      }
      first.resolve(new Response(JSON.stringify(snapshot(1)), { status: 200 }));
      await waitFor(() => expect(store.getSnapshot().snapshot.revision).toBe(2));
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });

  it("does not let a delayed prior-epoch rebaseline overwrite or consume a newer restart", async () => {
    const obsolete = deferred<Response>();
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response(snapshot(50, "Original")))
      .mockImplementationOnce(() => obsolete.promise)
      .mockImplementationOnce(() => response(snapshot(0, "Newest monitor")));
    const store = new NotificationStore();
    const published: NotificationSnapshot[] = [];
    const unsubscribe = store.subscribe(() => published.push(store.getSnapshot().snapshot));
    try {
      await waitFor(() => expect(store.getSnapshot().snapshot.revision).toBe(50));
      NotificationEventSource.instances[0].emit("error");
      await waitFor(() => expect(NotificationEventSource.instances).toHaveLength(2));
      NotificationEventSource.instances[1].emit("open");
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      NotificationEventSource.instances[1].emit("error");
      await waitFor(() => expect(NotificationEventSource.instances).toHaveLength(3));
      NotificationEventSource.instances[2].emit("open");
      obsolete.resolve(new Response(JSON.stringify(snapshot(40, "Obsolete monitor")), { status: 200 }));
      await waitFor(() => expect(store.getSnapshot().snapshot).toMatchObject({ revision: 0,
        occurrences: [{ data: { sessionTitle: "Newest monitor" } }] }));
      expect(fetcher.mock.calls[2][0]).toBe("/api/notifications");
      expect(published.some((value) => value.revision === 40)).toBe(false);
    } finally { unsubscribe(); }
  });

  it("keeps the last known-good snapshot on a transient failure and accepts the next committed revision", async () => {
    const next = deferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response(snapshot(3)))
      .mockRejectedValueOnce(new Error("transient"))
      .mockImplementationOnce(() => next.promise);
    const store = new NotificationStore();
    const unsubscribe = store.subscribe(() => {});
    try {
      await waitFor(() => expect(store.getSnapshot().snapshot.revision).toBe(3));
      NotificationEventSource.instances[0].emit("notifications", { domain: "notifications", revision: 4 });
      await waitFor(() => expect(store.getSnapshot().status).toBe("unavailable"));
      expect(store.getSnapshot().snapshot.revision).toBe(3);
      next.resolve(new Response(JSON.stringify(snapshot(4)), { status: 200 }));
      await waitFor(() => expect(store.getSnapshot()).toMatchObject({ status: "ready", snapshot: { revision: 4 } }));
    } finally { unsubscribe(); }
  });
});

describe("browser-local notification read markers", () => {
  const first = "a".repeat(32);
  const recurrence = "b".repeat(32);
  const now = Date.parse("2026-10-03T12:00:00.000Z");

  it("stores only opaque IDs and times, survives a second consumer, and leaves a recurrence unread", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const store = new NotificationReadStore({ storage, now: () => now });
    const unsubscribe = store.subscribe(() => {});
    store.markRead([first, "client:monitor_unreachable", "codex:private-session"]);
    unsubscribe();
    expect(store.getSnapshot().has(first)).toBe(true);
    expect(store.getSnapshot().has(recurrence)).toBe(false);
    const persisted = [...values.values()][0];
    expect(JSON.parse(persisted)).toEqual({ version: 1, entries: [[first, now]] });
    expect(persisted).not.toMatch(/session|title|provider|source|client:/i);
    const second = new NotificationReadStore({ storage, now: () => now });
    second.subscribe(() => {})();
    expect(second.getSnapshot().has(first)).toBe(true);
    expect(second.getSnapshot().has(recurrence)).toBe(false);
  });

  it("prunes after 30 days and caps the entire stored marker set", () => {
    let clock = now;
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const store = new NotificationReadStore({ storage, now: () => clock });
    store.markRead([first]);
    clock += 31 * 24 * 60 * 60_000;
    store.markRead(Array.from({ length: 450 }, (_, index) => index.toString(16).padStart(32, "0")));
    expect(store.getSnapshot().size).toBe(400);
    expect(store.getSnapshot().has(first)).toBe(false);
    expect(JSON.parse([...values.values()][0]).entries).toHaveLength(400);
    expect([...values.values()][0].length).toBeLessThan(32 * 1024);
  });

  it("does not overwrite malformed or newer stores and works in memory when storage is denied", () => {
    for (const initial of ["{bad", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [[[first], now]] })]) {
      let writes = 0;
      const storage = { getItem: () => initial, setItem: () => { writes += 1; } };
      const store = new NotificationReadStore({ storage, now: () => now });
      store.markRead([first]);
      expect(store.getSnapshot().has(first)).toBe(true);
      expect(writes).toBe(0);
    }
    const denied = new NotificationReadStore({ storage: { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } }, now: () => now });
    denied.markRead([first]);
    expect(denied.getSnapshot().has(first)).toBe(true);
  });
});
