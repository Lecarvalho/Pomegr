"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ProviderId, UsageLimitsSnapshot } from "../shared/monitor-contract";

const RETRY_DELAYS = [2_000, 5_000, 10_000, 30_000];
const INITIAL_POLL_MS = 1_000;
const READY_POLL_MS = 60_000;
const HIDDEN_POLL_MS = 30_000;

export const EMPTY_USAGE_LIMITS: UsageLimitsSnapshot = {
  revision: null,
  generatedAt: null,
  providers: [],
  readiness: { claude: "loading", codex: "loading" },
};

function providerReadiness(value: unknown): UsageLimitsSnapshot["readiness"] {
  if (!value || typeof value !== "object") return { ...EMPTY_USAGE_LIMITS.readiness };
  const input = value as Record<string, unknown>;
  const result: UsageLimitsSnapshot["readiness"] = { ...EMPTY_USAGE_LIMITS.readiness };
  for (const provider of ["claude", "codex"] as const) {
    const status = input[provider];
    if (status === "loading" || status === "ready" || status === "unavailable") result[provider] = status;
  }
  return result;
}

function normalizeSnapshot(input: unknown): UsageLimitsSnapshot {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const providers = Array.isArray(body.providers)
    ? body.providers
    : Array.isArray(body.providerLimits) ? body.providerLimits : [];
  const nextReadiness = providerReadiness(body.readiness);
  for (const entry of providers) {
    if (!entry || typeof entry !== "object") continue;
    const providerEntry = entry as Record<string, unknown>;
    const provider = providerEntry.provider;
    const readiness = providerEntry.readiness;
    if (provider !== "claude" && provider !== "codex") continue;
    if (readiness === "loading" || readiness === "ready" || readiness === "unavailable") {
      nextReadiness[provider] = readiness;
    } else if ("usageLimits" in providerEntry) {
      // Transitional cached responses did not carry per-provider readiness.
      // A committed provider value is sufficient evidence that this row is ready.
      nextReadiness[provider] = "ready";
    }
  }
  return {
    revision: typeof body.revision === "number" || typeof body.revision === "string" ? body.revision : null,
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : null,
    providers: providers as UsageLimitsSnapshot["providers"],
    readiness: nextReadiness,
  };
}

/** A single application-level provider usage cache with serialized polling. */
export class UsageLimitsStore {
  private snapshot: UsageLimitsSnapshot = EMPTY_USAGE_LIMITS;
  private listeners = new Set<() => void>();
  private consumers = 0;
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private requestInFlight = false;
  private retryAttempt = 0;
  private focusListener: (() => void) | null = null;
  private visibilityListener: (() => void) | null = null;
  private pauseOwners = new Set<symbol>();

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => EMPTY_USAGE_LIMITS;

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
    if (paused) this.pauseOwners.add(owner);
    else this.pauseOwners.delete(owner);
    const isPaused = this.pauseOwners.size > 0;
    if (wasPaused === isPaused) return;
    if (isPaused) this.stop();
    else if (this.consumers) this.start();
  }

  publish(snapshot: UsageLimitsSnapshot) {
    this.snapshot = Object.freeze({
      ...snapshot,
      providers: [...(snapshot.providers || [])],
      readiness: { ...(snapshot.readiness || {}) },
    });
    for (const listener of this.listeners) listener();
  }

  async refresh(signal?: AbortSignal) {
    if (this.requestInFlight) return false;
    this.requestInFlight = true;
    const requestController = signal ? null : new AbortController();
    const requestSignal = signal || requestController!.signal;
    try {
      const revision = this.snapshot.revision;
      const query = revision === null || revision === undefined ? "" : `?revision=${encodeURIComponent(String(revision))}`;
      const response = await fetch(`/api/usage-limits${query}`, { cache: "no-store", signal: requestSignal });
      if (requestSignal.aborted) return false;
      if (response.status === 204) {
        this.retryAttempt = 0;
        return true;
      }
      if (!response.ok) throw new Error("Usage limits unavailable");
      const next = normalizeSnapshot(await response.json());
      this.publish(next);
      this.retryAttempt = 0;
      return true;
    } catch {
      if (!requestSignal.aborted) {
        const readiness = { ...this.snapshot.readiness };
        for (const provider of ["claude", "codex"] as ProviderId[]) {
          if (!this.snapshot.providers.some((item) => item.provider === provider)) readiness[provider] = "unavailable";
        }
        this.publish({ ...this.snapshot, readiness });
      }
      return false;
    } finally {
      this.requestInFlight = false;
      requestController?.abort();
    }
  }

  private start() {
    if (typeof window === "undefined" || this.pauseOwners.size) return;
    this.controller = new AbortController();
    this.focusListener = () => { if (!document.hidden) void this.poll(true); };
    this.visibilityListener = () => { if (!document.hidden) void this.poll(true); };
    window.addEventListener("focus", this.focusListener);
    document.addEventListener("visibilitychange", this.visibilityListener);
    void this.poll(false);
  }

  private stop() {
    this.controller?.abort();
    this.controller = null;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.focusListener) window.removeEventListener("focus", this.focusListener);
    if (this.visibilityListener) document.removeEventListener("visibilitychange", this.visibilityListener);
    this.focusListener = null;
    this.visibilityListener = null;
  }

  private hasUnresolvedProvider() {
    return Object.values(this.snapshot.readiness).some((status) => status === "loading");
  }

  private schedule(delay: number) {
    if (this.controller?.signal.aborted || !this.consumers || this.pauseOwners.size) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.poll(false); }, delay);
  }

  private async poll(immediate: boolean) {
    if (this.controller?.signal.aborted || !this.consumers || this.pauseOwners.size || this.requestInFlight) return;
    const succeeded = await this.refresh(this.controller?.signal);
    if (this.controller?.signal.aborted || !this.consumers) return;
    if (!succeeded) {
      const delay = RETRY_DELAYS[Math.min(this.retryAttempt, RETRY_DELAYS.length - 1)];
      this.retryAttempt += 1;
      this.schedule(delay);
      return;
    }
    this.retryAttempt = 0;
    if (immediate) return this.schedule(document.hidden ? HIDDEN_POLL_MS : this.hasUnresolvedProvider() ? INITIAL_POLL_MS : READY_POLL_MS);
    this.schedule(document.hidden ? HIDDEN_POLL_MS : this.hasUnresolvedProvider() ? INITIAL_POLL_MS : READY_POLL_MS);
  }
}

let sharedStore: UsageLimitsStore | null = null;
export function getUsageLimitsStore() {
  if (!sharedStore) sharedStore = new UsageLimitsStore();
  return sharedStore;
}

export function useUsageLimits() {
  const store = getUsageLimitsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/** Suspend the shared provider-usage poller while any application owner is paused. */
export function useUsageLimitsPollingPause(paused: boolean) {
  const store = getUsageLimitsStore();
  const owner = useRef(Symbol("usage-limits-pause-owner"));
  useEffect(() => {
    const pauseOwner = owner.current;
    store.setPaused(pauseOwner, paused);
    return () => store.setPaused(pauseOwner, false);
  }, [paused, store]);
}
