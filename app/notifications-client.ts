"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { NotificationRecord, NotificationSnapshot, NotificationSourceReadiness } from "../shared/notification-contract";
import { subscribeLiveEvents } from "./live-events";
import { isUsageNotificationKind, normalizeUsageNotificationData, usageNotificationPolicy } from "../shared/usage-notification.mjs";

const POLL_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const READINESS = new Set<NotificationSourceReadiness>(["loading", "ready", "partial", "stale", "unavailable"]);
const ACTIONS = new Set(["open_session", "open_sessions", "open_providers", "open_workspace", "open_usage_limits"]);
const CATEGORIES = new Set(["attention", "provider_service", "system", "usage", "provider_news"]);
const SEVERITIES = new Set(["info", "warning", "critical"]);
const ID = /^[a-f0-9]{32}$/u;
const SESSION_ID = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_TEXT = /^[^<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/u;

export const EMPTY_NOTIFICATION_SNAPSHOT: NotificationSnapshot = {
  version: 1, revision: 0, generatedAt: null,
  readiness: { catalog: "loading", providerStatus: "loading" },
  occurrences: [], activeSessionOverflow: 0,
};

export type NotificationClientState = Readonly<{ snapshot: NotificationSnapshot; status: "loading" | "ready" | "unavailable" }>;
const EMPTY_STATE: NotificationClientState = Object.freeze({ snapshot: EMPTY_NOTIFICATION_SNAPSHOT, status: "loading" });

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && SAFE_TEXT.test(value);
}
function sourceReadiness(value: unknown): value is NotificationSourceReadiness {
  return READINESS.has(value as NotificationSourceReadiness);
}
function member(value: unknown, choices: ReadonlySet<string>): value is string {
  return typeof value === "string" && choices.has(value);
}

function normalizeRecord(value: unknown): NotificationRecord | null {
  const row = object(value);
  if (!row || typeof row.id !== "string" || !ID.test(row.id) || !member(row.category, CATEGORIES) || !member(row.severity, SEVERITIES)
    || !member(row.action, ACTIONS) || (row.lifecycle !== "active" && row.lifecycle !== "resolved")
    || !Number.isInteger(row.priority) || Number(row.priority) < 0 || Number(row.priority) > 100
    || !timestamp(row.occurredAt) || (row.timeBasis !== "recorded" && row.timeBasis !== "observed")
    || typeof row.deliveryEligible !== "boolean") return null;
  const data = object(row.data);
  if (!data) return null;
  const base = {
    id: row.id as string,
    category: row.category as NotificationRecord["category"],
    severity: row.severity as NotificationRecord["severity"],
    lifecycle: row.lifecycle as NotificationRecord["lifecycle"],
    priority: row.priority as number,
    occurredAt: row.occurredAt as string,
    timeBasis: row.timeBasis as NotificationRecord["timeBasis"],
    deliveryEligible: row.deliveryEligible as boolean,
    action: row.action as NotificationRecord["action"],
  };
  if (isUsageNotificationKind(row.kind)) {
    const usageData = normalizeUsageNotificationData(row.kind, row.provider, data);
    const policy = usageNotificationPolicy(row.kind);
    if (!usageData || row.category !== policy.category || row.action !== "open_usage_limits" || row.priority !== policy.priority
      || row.lifecycle !== "resolved" || row.severity !== policy.severity || row.timeBasis !== "observed") return null;
    return { ...base, kind: row.kind, provider: row.provider, data: usageData } as NotificationRecord;
  }
  if (row.kind === "needs_input" && (row.provider === "claude" || row.provider === "codex")
    && typeof data.sessionId === "string" && SESSION_ID.test(data.sessionId) && bounded(data.sessionTitle, 96)) {
    return { ...base, kind: "needs_input", provider: row.provider, data: { sessionId: data.sessionId as string, sessionTitle: data.sessionTitle } };
  }
  if (row.kind === "provider_incident" && (row.provider === "claude" || row.provider === "codex")
    && typeof data.status === "string" && ["degraded", "outage", "maintenance"].includes(data.status)) {
    return { ...base, kind: "provider_incident", provider: row.provider, data: { status: data.status as "degraded" | "outage" | "maintenance" } };
  }
  if (row.kind === "provider_recovery" && (row.provider === "claude" || row.provider === "codex") && data.status === "operational") {
    return { ...base, kind: "provider_recovery", provider: row.provider, data: { status: "operational" } };
  }
  // The monitor cannot publish its own transport failure. This kind is client-local only.
  return null;
}

/** Rebuild the public allowlist; no unknown upstream field enters React state. */
export function normalizeNotificationSnapshot(input: unknown): NotificationSnapshot | null {
  const source = object(input);
  const readiness = object(source?.readiness);
  if (!source || source.version !== 1 || !Number.isSafeInteger(source.revision) || Number(source.revision) < 0
    || !(source.generatedAt === null || timestamp(source.generatedAt))
    || !readiness || !sourceReadiness(readiness.catalog) || !sourceReadiness(readiness.providerStatus)
    || !Array.isArray(source.occurrences) || source.occurrences.length > 200
    || !Number.isSafeInteger(source.activeSessionOverflow) || Number(source.activeSessionOverflow) < 0
    || Number(source.activeSessionOverflow) > 1_000_000) return null;
  const occurrences = source.occurrences.map(normalizeRecord);
  if (occurrences.some((entry) => entry === null) || new Set(occurrences.map((entry) => entry?.id)).size !== occurrences.length) return null;
  return {
    version: 1, revision: source.revision as number, generatedAt: source.generatedAt as string | null,
    readiness: { catalog: readiness.catalog as NotificationSourceReadiness, providerStatus: readiness.providerStatus as NotificationSourceReadiness },
    occurrences: occurrences as NotificationRecord[], activeSessionOverflow: source.activeSessionOverflow as number,
  };
}

/** One tab-scoped cache consumer; GETs never derive provider/session conditions. */
export class NotificationStore {
  private state: NotificationClientState = EMPTY_STATE;
  private listeners = new Set<() => void>();
  private pauseOwners = new Set<symbol>();
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private inFlight = false;
  private pendingRevision: number | null = null;
  private restartWhenIdle: number | null = null;
  private eventEpoch: number | null = null;
  private rebaselinePending = false;
  private generation = 0;
  private consumers = 0;

  getSnapshot = () => this.state;
  getServerSnapshot = () => EMPTY_STATE;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.consumers += 1;
    if (this.consumers === 1 && !this.pauseOwners.size) this.start();
    return () => {
      this.listeners.delete(listener);
      this.consumers = Math.max(0, this.consumers - 1);
      if (!this.consumers) this.stop();
    };
  };
  setPaused(owner: symbol, paused: boolean) {
    const wasPaused = this.pauseOwners.size > 0;
    if (paused) this.pauseOwners.add(owner); else this.pauseOwners.delete(owner);
    if (wasPaused === (this.pauseOwners.size > 0)) return;
    if (this.pauseOwners.size) this.stop(); else if (this.consumers) this.start();
  }
  private publish(next: NotificationClientState) {
    if (this.state.snapshot === next.snapshot && this.state.status === next.status) return;
    this.state = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }
  private start() {
    if (typeof window === "undefined" || this.pauseOwners.size) return;
    const generation = ++this.generation;
    this.controller = new AbortController();
    window.addEventListener("focus", this.refreshOnFocus);
    document.addEventListener("visibilitychange", this.refreshOnVisibility);
    this.unsubscribeEvents = subscribeLiveEvents((event) => {
      if (this.eventEpoch !== event.epoch) {
        if (this.eventEpoch !== null && this.state.status !== "loading") this.rebaselinePending = true;
        this.eventEpoch = event.epoch;
        if (this.rebaselinePending && !document.hidden) void this.poll(generation);
      }
      if (event.type !== "revision" || event.domain !== "notifications"
        || (!this.rebaselinePending && event.revision <= this.state.snapshot.revision)) return;
      this.pendingRevision = event.revision;
      if (!document.hidden) void this.poll(generation);
    });
    if (!document.hidden) void this.poll(generation);
  }
  private stop() {
    ++this.generation;
    this.controller?.abort(); this.controller = null;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pendingRevision = null;
    this.unsubscribeEvents?.(); this.unsubscribeEvents = null;
    window.removeEventListener("focus", this.refreshOnFocus);
    document.removeEventListener("visibilitychange", this.refreshOnVisibility);
  }
  private refreshOnFocus = () => { if (!document.hidden) void this.poll(this.generation); };
  private refreshOnVisibility = () => {
    if (document.hidden) { if (this.timer !== null) window.clearTimeout(this.timer); this.timer = null; }
    else void this.poll(this.generation);
  };
  private schedule(generation: number, delay: number) {
    if (generation !== this.generation || this.controller?.signal.aborted || !this.consumers || this.pauseOwners.size || document.hidden) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.poll(generation); }, delay);
  }
  private async poll(generation: number) {
    if (!this.controller || this.controller.signal.aborted || generation !== this.generation || this.pauseOwners.size || !this.consumers || document.hidden) return;
    if (this.inFlight) { this.restartWhenIdle = generation; return; }
    this.inFlight = true;
    const signal = this.controller.signal;
    const requestEpoch = this.eventEpoch;
    let success = false;
    try {
      const rebaselineRequest = this.rebaselinePending;
      const query = this.state.status === "loading" || rebaselineRequest ? "" : `?revision=${this.state.snapshot.revision}`;
      const response = await fetch(`/api/notifications${query}`, { cache: "no-store", signal });
      if (signal.aborted || generation !== this.generation || requestEpoch !== this.eventEpoch) return;
      if (response.status === 204) {
        if (rebaselineRequest) throw new Error("Unconditional notification baseline missing");
        this.publish({ snapshot: this.state.snapshot, status: "ready" });
        success = true;
      } else {
        if (!response.ok) throw new Error("Notifications unavailable");
        const body = await response.text();
        if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw new Error("Notification response too large");
        const snapshot = normalizeNotificationSnapshot(JSON.parse(body));
        if (!snapshot) throw new Error("Invalid notification snapshot");
        if (signal.aborted || generation !== this.generation) return;
        if (requestEpoch !== this.eventEpoch) return;
        if (rebaselineRequest || snapshot.revision >= this.state.snapshot.revision) {
          this.publish({ snapshot, status: "ready" });
          if (rebaselineRequest) this.rebaselinePending = false;
        }
        success = true;
      }
    } catch {
      if (!signal.aborted && generation === this.generation && requestEpoch === this.eventEpoch) this.publish({ snapshot: this.state.snapshot, status: "unavailable" });
    } finally {
      this.inFlight = false;
      if (!signal.aborted && generation === this.generation) {
        const pending = this.pendingRevision;
        this.pendingRevision = null;
        this.schedule(generation, pending !== null && pending > this.state.snapshot.revision ? 0 : success ? POLL_MS : 5_000);
      }
      const restart = this.restartWhenIdle;
      this.restartWhenIdle = null;
      if (restart !== null && restart === this.generation) this.schedule(restart, 0);
    }
  }
}

let sharedStore: NotificationStore | null = null;
export function getNotificationStore() { if (!sharedStore) sharedStore = new NotificationStore(); return sharedStore; }
export function useNotificationSnapshot() {
  const store = getNotificationStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
export function useNotificationPollingPause(paused: boolean) {
  const store = getNotificationStore();
  const owner = useRef(Symbol("notification-pause-owner"));
  useEffect(() => { const pauseOwner = owner.current; store.setPaused(pauseOwner, paused); return () => store.setPaused(pauseOwner, false); }, [paused, store]);
}
