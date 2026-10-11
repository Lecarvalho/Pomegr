"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SessionDomain, SessionDomainResponse } from "../shared/session-domain-contract";
import { subscribeLiveEvents, type LiveConnectionEvent, type LiveEvent } from "./live-events";

type DomainResponse<D extends SessionDomain> = Extract<SessionDomainResponse, { domain: D }>;

export type SessionDomainQuery<D extends SessionDomain = SessionDomain> = {
  sessionId: string;
  domain: D;
  agentId?: D extends "agent" ? string : never;
};

export type SessionDomainSnapshot<D extends SessionDomain> = {
  data: DomainResponse<D> | null;
  fetching: boolean;
  connected: boolean;
  error: string | null;
  unavailable: boolean;
};

type Listener = () => void;
type Subscription = { historical: boolean };
type Entry = {
  key: string;
  query: SessionDomainQuery;
  snapshot: SessionDomainSnapshot<SessionDomain>;
  listeners: Map<Listener, Subscription>;
  controller: AbortController | null;
  timer: number | null;
  refreshAfterFlight: boolean;
  invalidatedRevision: number | null;
  pendingSubscription: boolean;
  survivedPrune: boolean;
  dataEpoch: number | null;
};

const MAX_RETAINED_SESSIONS = 3;
const entries = new Map<string, Entry>();
const recentSessions: string[] = [];
let releaseEvents: (() => void) | null = null;
let connectionState: LiveConnectionEvent["state"] = "reconnecting";
let focusListening = false;
let establishingEvents = false;
let currentEpoch = 0;

function queryKey(query: SessionDomainQuery) {
  return `${query.sessionId}|${query.domain}|${query.domain === "agent" ? query.agentId || "" : ""}`;
}

function retainedRevision(entry: Entry) {
  return entry.snapshot.data && entry.dataEpoch === currentEpoch ? entry.snapshot.data.revision : null;
}

function endpoint(entry: Entry) {
  const params = new URLSearchParams({ sessionId: entry.query.sessionId, domain: entry.query.domain });
  if (entry.query.domain === "agent" && entry.query.agentId) params.set("agentId", entry.query.agentId);
  const revision = retainedRevision(entry);
  if (revision !== null) params.set("revision", String(revision));
  return `/api/session-domain?${params}`;
}

function emit(entry: Entry) {
  for (const listener of entry.listeners.keys()) listener();
}

function update(entry: Entry, patch: Partial<SessionDomainSnapshot<SessionDomain>>) {
  entry.snapshot = Object.freeze({ ...entry.snapshot, ...patch });
  emit(entry);
}

function hasLiveSubscriber(entry: Entry) {
  return [...entry.listeners.values()].some((subscriber) => !subscriber.historical);
}

function schedule(entry: Entry, delay: number, { retry = false }: { retry?: boolean } = {}) {
  if (!entry.listeners.size || (!retry && !hasLiveSubscriber(entry)) || typeof window === "undefined") return;
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => {
    entry.timer = null;
    void refreshEntry(entry);
  }, delay);
}

async function refreshEntry(entry: Entry) {
  if (!entry.listeners.size) return;
  if (entry.controller) {
    entry.refreshAfterFlight = true;
    return;
  }
  const controller = new AbortController();
  entry.controller = controller;
  if (!entry.snapshot.data) update(entry, { fetching: true });
  let succeeded = false;
  let rebuildPending = false;
  let definitivelyUnavailable = false;
  try {
    const response = await fetch(endpoint(entry), { cache: "no-store", signal: controller.signal });
    if (controller.signal.aborted) return;
    if (response.status === 204) {
      if (!entry.snapshot.data) throw new Error("Missing retained session evidence");
      entry.invalidatedRevision = null;
      update(entry, { fetching: false, connected: true, error: null, unavailable: false });
      succeeded = true;
      return;
    }
    if (response.status === 404) {
      entry.invalidatedRevision = null;
      const retained = entry.snapshot.data;
      update(entry, {
        data: retained && retained.readiness !== "loading" ? retained : null,
        fetching: false,
        connected: true,
        error: null,
        unavailable: true,
      });
      succeeded = true;
      definitivelyUnavailable = true;
      return;
    }
    if (!response.ok) throw new Error("Session evidence unavailable");
    const value = await response.json() as SessionDomainResponse;
    if (controller.signal.aborted) return;
    if (value.domain !== entry.query.domain || value.sessionId !== entry.query.sessionId
      || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Invalid session evidence");
    if (entry.query.domain === "agent" && (value.domain !== "agent" || value.agentId !== entry.query.agentId)) throw new Error("Invalid agent evidence");
    const retained = entry.snapshot.data;
    const withinSameEpoch = entry.dataEpoch !== null && entry.dataEpoch === currentEpoch;
    const regressesRetainedData = retained && retained.readiness !== "loading"
      && (value.readiness === "loading" || (withinSameEpoch && value.revision < retained.revision));
    if (regressesRetainedData) {
      entry.invalidatedRevision = null;
      update(entry, { fetching: false, connected: true, error: null, unavailable: false });
      succeeded = true;
      rebuildPending = true;
      return;
    }
    entry.invalidatedRevision = null;
    entry.dataEpoch = currentEpoch;
    update(entry, { data: value, fetching: false, connected: true, error: null, unavailable: false });
    succeeded = true;
  } catch {
    if (!controller.signal.aborted) {
      // A replayed event for the revision that just failed must still be able to revalidate.
      entry.invalidatedRevision = null;
      update(entry, {
        fetching: false,
        connected: false,
        unavailable: false,
        error: "Session evidence is temporarily unavailable. Pomegr will retry from the last recorded state.",
      });
    }
  } finally {
    if (entry.controller === controller) entry.controller = null;
    if (controller.signal.aborted || !entry.listeners.size) return;
    if (entry.refreshAfterFlight) {
      entry.refreshAfterFlight = false;
      void refreshEntry(entry);
      return;
    }
    if (definitivelyUnavailable) return;
    if (!hasLiveSubscriber(entry)) {
      // Resolved historical entries have no periodic timer.
      if (succeeded && !rebuildPending && entry.snapshot.data && entry.snapshot.data.readiness !== "loading") return;
      schedule(entry, typeof document !== "undefined" && document.hidden ? 30_000 : 5_000, { retry: true });
      return;
    }
    const unresolved = rebuildPending || !entry.snapshot.data || entry.snapshot.data.readiness === "loading";
    schedule(entry, typeof document !== "undefined" && document.hidden ? 30_000
      : unresolved ? 1_000
        : succeeded && connectionState === "connected" ? 30_000 : 5_000);
  }
}

function pruneUnretainedEntries({ subscribing }: { subscribing: boolean }) {
  const retained = new Set(recentSessions);
  for (const [key, entry] of entries) {
    if (retained.has(entry.query.sessionId) || entry.listeners.size) continue;
    if (entry.pendingSubscription && !entry.survivedPrune) {
      if (subscribing) entry.survivedPrune = true;
      continue;
    }
    entry.controller?.abort();
    if (entry.timer !== null && typeof window !== "undefined") window.clearTimeout(entry.timer);
    entries.delete(key);
  }
}

function touchSession(sessionId: string) {
  const existing = recentSessions.indexOf(sessionId);
  if (existing >= 0) recentSessions.splice(existing, 1);
  recentSessions.unshift(sessionId);
  recentSessions.splice(MAX_RETAINED_SESSIONS);
  pruneUnretainedEntries({ subscribing: true });
}

function onLiveEvent(event: LiveEvent) {
  // Every live event (connection or revision) carries the stream's current epoch.
  if (Number.isSafeInteger(event.epoch) && event.epoch >= 0) currentEpoch = event.epoch;
  if (event.type === "connection") {
    const recovered = connectionState !== "connected" && event.state === "connected";
    connectionState = event.state;
    for (const entry of entries.values()) {
      if (!entry.listeners.size) continue;
      update(entry, { connected: event.state === "connected" });
      if (establishingEvents) continue;
      if (recovered && (typeof document === "undefined" || !document.hidden)) void refreshEntry(entry);
      else if (hasLiveSubscriber(entry)) schedule(entry, typeof document !== "undefined" && document.hidden ? 30_000 : event.state === "connected" ? 30_000 : 5_000);
    }
    return;
  }
  for (const entry of entries.values()) {
    if (!entry.listeners.size || event.sessionId !== entry.query.sessionId || event.domain !== entry.query.domain) continue;
    if (retainedRevision(entry) === event.revision || entry.invalidatedRevision === event.revision) continue;
    entry.invalidatedRevision = event.revision;
    if (typeof document !== "undefined" && document.hidden) {
      if (hasLiveSubscriber(entry)) schedule(entry, 30_000);
    } else void refreshEntry(entry);
  }
}

function ensureGlobalListeners() {
  if (!releaseEvents) {
    establishingEvents = true;
    try { releaseEvents = subscribeLiveEvents(onLiveEvent); }
    finally { establishingEvents = false; }
  }
  if (focusListening || typeof window === "undefined") return;
  const revalidateMounted = () => {
    if (document.hidden) return;
    for (const entry of entries.values()) if (entry.listeners.size) void refreshEntry(entry);
  };
  window.addEventListener("focus", revalidateMounted);
  document.addEventListener("visibilitychange", revalidateMounted);
  focusListening = true;
  globalCleanup = () => {
    window.removeEventListener("focus", revalidateMounted);
    document.removeEventListener("visibilitychange", revalidateMounted);
    focusListening = false;
  };
}

let globalCleanup: (() => void) | null = null;

function releaseGlobalListenersIfIdle() {
  if ([...entries.values()].some((entry) => entry.listeners.size)) return;
  releaseEvents?.();
  releaseEvents = null;
  globalCleanup?.();
  globalCleanup = null;
  connectionState = "reconnecting";
  establishingEvents = false;
}

function getEntry(query: SessionDomainQuery): Entry {
  const key = queryKey(query);
  const current = entries.get(key);
  if (current) return current;
  const entry: Entry = {
    key,
    query,
    snapshot: Object.freeze({ data: null, fetching: false, connected: connectionState === "connected", error: null, unavailable: false }),
    listeners: new Map(),
    controller: null,
    timer: null,
    refreshAfterFlight: false,
    invalidatedRevision: null,
    // Protects this entry from a concurrent unmount's pruning until its own subscribe effect runs.
    pendingSubscription: true,
    survivedPrune: false,
    dataEpoch: null,
  };
  entries.set(key, entry);
  return entry;
}

// Runs from a consumer's own subscribe effect.
function attachSubscriber(entry: Entry, listener: Listener | null, subscription: Subscription) {
  entry.pendingSubscription = false;
  if (!listener) return false;
  if (!entries.has(entry.key)) entries.set(entry.key, entry);
  const firstSubscriber = entry.listeners.size === 0;
  entry.listeners.set(listener, subscription);
  touchSession(entry.query.sessionId);
  ensureGlobalListeners();
  return firstSubscriber;
}

function detachSubscriber(entry: Entry, listener: Listener) {
  entry.listeners.delete(listener);
  if (!entry.listeners.size) {
    entry.controller?.abort();
    entry.controller = null;
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = null;
    pruneUnretainedEntries({ subscribing: false });
  }
  releaseGlobalListenersIfIdle();
}

function createServerEntry(query: SessionDomainQuery): Entry {
  return {
    key: queryKey(query), query,
    snapshot: Object.freeze({ data: null, fetching: false, connected: false, error: null, unavailable: false }),
    listeners: new Map(), controller: null, timer: null, refreshAfterFlight: false, invalidatedRevision: null,
    pendingSubscription: false, survivedPrune: false, dataEpoch: null,
  };
}

export function useSessionDomain<D extends SessionDomain>(query: SessionDomainQuery<D>, options: {
  historical: boolean;
  enabled?: boolean;
}): SessionDomainSnapshot<D> & { revalidate: () => void } {
  const enabled = options.enabled !== false;
  const key = queryKey(query);
  const entry = useMemo(() => typeof window === "undefined" ? createServerEntry(query) : getEntry(query), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const subscribe = useCallback((listener: Listener) => {
    const firstSubscriber = attachSubscriber(entry, enabled ? listener : null, { historical: options.historical });
    if (!enabled) return () => {};
    if (firstSubscriber) void refreshEntry(entry);
    return () => detachSubscriber(entry, listener);
  }, [enabled, entry, options.historical]);
  const getSnapshot = useCallback(() => entry.snapshot, [entry]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as unknown as SessionDomainSnapshot<D>;
  const revalidate = useCallback(() => { if (enabled) void refreshEntry(entry); }, [enabled, entry]);
  return useMemo(() => ({ ...snapshot, revalidate }), [revalidate, snapshot]);
}

export function resetSessionDomainStoreForTests() {
  for (const entry of entries.values()) {
    entry.controller?.abort();
    if (entry.timer !== null && typeof window !== "undefined") window.clearTimeout(entry.timer);
  }
  entries.clear();
  recentSessions.splice(0);
  releaseEvents?.();
  releaseEvents = null;
  globalCleanup?.();
  globalCleanup = null;
  connectionState = "reconnecting";
  currentEpoch = 0;
}

export function sessionDomainStoreDiagnosticsForTests() {
  return { keys: [...entries.keys()], recentSessions: [...recentSessions] };
}
