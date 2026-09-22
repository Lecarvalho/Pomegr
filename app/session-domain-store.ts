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
  /**
   * True after the monitor definitively answered that this exact query has no recorded evidence
   * (HTTP 404 once hydration proved the session absent). Unlike `error`, it is not retried on a
   * timer: a matching revision event, a reconnect, focus, or an explicit `revalidate` re-checks it.
   */
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
  /** True from render-time creation until this entry's own `subscribe` effect runs; see `getEntry`. */
  pendingSubscription: boolean;
  /** True once a subscribe-time prune pass (`touchSession`) has seen this entry still pending; see `pruneUnretainedEntries`. */
  survivedPrune: boolean;
  /** The live-event epoch active when `snapshot.data` was last accepted, or `null` before any data has been accepted. */
  dataEpoch: number | null;
};

const MAX_RETAINED_SESSIONS = 3;
const entries = new Map<string, Entry>();
const recentSessions: string[] = [];
let releaseEvents: (() => void) | null = null;
let connectionState: LiveConnectionEvent["state"] = "reconnecting";
let focusListening = false;
let establishingEvents = false;
// The live-event stream's connection epoch (see `app/live-events.ts`). It advances whenever the
// stream (re)connects, including after a monitor restart, so it proves a new monitor process
// independently of the domain revision the restarted monitor happens to report first.
let currentEpoch = 0;

function queryKey(query: SessionDomainQuery) {
  return `${query.sessionId}|${query.domain}|${query.domain === "agent" ? query.agentId || "" : ""}`;
}

/**
 * A retained revision identifies its body only within the live-event epoch that accepted it: a
 * restarted monitor's revision clocks restart, so an equal number from a later epoch can name
 * different evidence.
 */
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
  // Set when a response is deliberately not committed because it would regress last-known-good
  // evidence (see `regressesRetainedData` below) -- most notably a monitor-restart rebuild still
  // in flight. `entry.snapshot.data` keeps showing the old, already-resolved body in that case,
  // so the steady-state cadence below would otherwise mistake it for "nothing left to refresh"
  // and fall back to the slow 30s poll instead of finishing the recovery quickly.
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
      // A definitive answer, not a transient failure: the monitor answers 404 only once its own
      // hydration proved the session absent, and the proxy passes that through for this route
      // only. A retained "loading" placeholder is not evidence and is dropped; resolved
      // last-known-good data is kept. No retry timer is scheduled (see `finally`).
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
    // A retained resolved (non-"loading") body is last-known-good evidence: AGENTS.md requires
    // preserving it until a *complete* replacement validates. A "loading" response never
    // replaces it (a rebuild in progress, for example after a monitor restart, is never a
    // complete replacement), and within the same live-event epoch a lower-revision response is
    // an incomplete or stale rebuild (for example a monitor eviction cycle) rather than a real
    // update. Once the epoch has advanced -- proving a new monitor process, whose revision
    // clocks restart at 0 -- a resolved body is accepted even if its revision regresses, so an
    // open page does not freeze on stale data forever. See AGENTS.md and `app/live-events.ts`.
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
    // A definitive "unavailable" answer is re-checked only by a matching revision event, a
    // reconnect, focus, or an explicit revalidate -- never by a polling loop against an absent session.
    if (definitivelyUnavailable) return;
    if (!hasLiveSubscriber(entry)) {
      // Resolved historical entries have no periodic timer. A failed request, a rebuild still in
      // flight, or an unresolved body must retry, because no later revision event is guaranteed.
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
    // A just-created entry that has not yet reached its own subscribe effect has no listener and
    // its session may not be registered in `recentSessions` yet, but it must survive every
    // unmount cleanup of the commit that mounts it (see `getEntry`). A keyed navigation can
    // unmount several consumers at once (for example leaving an Agents tab), and React runs all
    // of those cleanups before any subscribe effect of the new tree, so a cleanup pass never ages
    // a pending entry. Only a subscribe-time pass (`touchSession`) ages it: subscribe effects run
    // after every cleanup of their commit, so an entry still pending once a pass has aged it was
    // abandoned before it ever subscribed (for example a discarded render), and the next pass of
    // either kind prunes it instead of letting it linger forever.
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
  // Every live event (connection or revision) carries the stream's current epoch. Track it
  // unconditionally so a restart or reconnect is recognized even before it changes the
  // connection *state* (for example a fast reconnect that never visibly drops "connected").
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
    // Protects this entry from a concurrent unmount's pruning until its own subscribe effect
    // runs; see the comment on `pendingSubscription` and in `pruneUnretainedEntries`. This is a
    // local flag on the fresh object only — creating it here does not mutate `recentSessions` or
    // scan/evict other entries, so getEntry stays free of module-wide side effects during render.
    // On a keyed session navigation React tears down the previous consumer's effect (which calls
    // pruneUnretainedEntries) before this new consumer's own subscribe effect runs, so without
    // this flag the freshly created, still-unsubscribed entry above could be pruned out of
    // `entries` between render and mount, leaving the mounted consumer holding a detached Entry
    // that never receives live-event invalidation or reconnect refreshes.
    pendingSubscription: true,
    survivedPrune: false,
    dataEpoch: null,
  };
  entries.set(key, entry);
  return entry;
}

// Runs from a consumer's own subscribe effect. Entry mutation lives in module functions rather than
// inline in the hook, so the memoized render-time value stays immutable under React's hook rules.
// It clears the render-time protection whether or not a listener attaches (enabled:false never
// attaches one), so a disabled entry still becomes eligible for normal LRU pruning. When a listener
// does attach to an entry that is no longer registered (for example one removed while a concurrent
// render yielded), the entry is registered again, so a mounted consumer never holds a detached
// entry that live events, reconnect recovery, and focus revalidation cannot reach.
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
