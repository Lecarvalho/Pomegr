"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { PROVIDER_STATUS_SOURCES, PROVIDER_STATUS_STALE_MS, createEmptyProviderStatusSnapshot } from "../shared/provider-status.mjs";
import type { ProviderId, ProviderServiceIncident, ProviderServiceStatus, ProviderStatusSnapshot } from "../shared/monitor-contract";

const POLL_MS = 30_000;
const PROVIDERS: ProviderId[] = ["claude", "codex"];
const MAX_INCIDENTS = 8;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 240;
const SAFE_INCIDENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const EMPTY_PROVIDER_STATUS: ProviderStatusSnapshot = createEmptyProviderStatusSnapshot();

function isTimestamp(value: unknown): value is string { return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)); }
function isOptionalTimestamp(value: unknown): value is string | null { return value === null || isTimestamp(value); }
function boundedText(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function incidentUrlIsSafe(value: unknown, source: { statusPageUrl: string }) {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value); const page = new URL(source.statusPageUrl);
    const match = /^\/incidents\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    return url.protocol === "https:" && url.origin === page.origin && !url.username && !url.password && Boolean(match) && !url.search && !url.hash;
  } catch { return false; }
}

function normalizeIncident(value: unknown, source: { statusPageUrl: string }): ProviderServiceIncident | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id = input.id;
  const label = input.label;
  if (!boundedText(id, MAX_ID_LENGTH) || !SAFE_INCIDENT_ID.test(id) || !boundedText(label, MAX_LABEL_LENGTH)
    || !["investigating", "identified", "monitoring", "maintenance"].includes(String(input.status))
    || !["none", "minor", "major", "critical"].includes(String(input.impact))
    || !isOptionalTimestamp(input.updatedAt) || !incidentUrlIsSafe(input.url, source)) return null;
  return { id, label, status: input.status as ProviderServiceIncident["status"], impact: input.impact as ProviderServiceIncident["impact"], updatedAt: input.updatedAt, url: input.url as string };
}

function normalizeProvider(value: unknown): ProviderServiceStatus | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const expected = PROVIDER_STATUS_SOURCES.find((source) => source.provider === input.provider);
  const incidentKey = input.incidentKey;
  if (!expected || input.source !== expected.source || input.statusPageUrl !== expected.statusPageUrl
    || !["operational", "degraded", "outage", "maintenance", "unknown"].includes(String(input.status))
    || !["loading", "ready", "unavailable"].includes(String(input.readiness))
    || !["fresh", "stale", "unknown"].includes(String(input.freshness))
    || !isOptionalTimestamp(input.checkedAt) || !isOptionalTimestamp(input.updatedAt)
    || !(incidentKey === null || (boundedText(incidentKey, MAX_ID_LENGTH) && SAFE_INCIDENT_ID.test(incidentKey)))
    || !Array.isArray(input.incidents) || input.incidents.length > MAX_INCIDENTS) return null;
  const incidents = input.incidents.map((incident) => normalizeIncident(incident, expected));
  if (incidents.some((incident) => incident === null)) return null;
  return { provider: expected.provider, source: expected.source, statusPageUrl: expected.statusPageUrl, status: input.status as ProviderServiceStatus["status"], readiness: input.readiness as ProviderServiceStatus["readiness"], freshness: input.freshness as ProviderServiceStatus["freshness"], checkedAt: input.checkedAt, updatedAt: input.updatedAt, incidentKey, incidents: incidents as ProviderServiceIncident[] };
}

function resolvedFreshness(provider: ProviderServiceStatus, now = Date.now()): ProviderServiceStatus["freshness"] {
  if (!provider.checkedAt) return provider.freshness === "stale" ? "stale" : "unknown";
  return now - Date.parse(provider.checkedAt) >= PROVIDER_STATUS_STALE_MS ? "stale" : provider.freshness;
}
function withCurrentFreshness(snapshot: ProviderStatusSnapshot): ProviderStatusSnapshot { return { ...snapshot, providers: snapshot.providers.map((provider) => ({ ...provider, freshness: resolvedFreshness(provider) })) }; }
function unavailableSnapshot(snapshot: ProviderStatusSnapshot): ProviderStatusSnapshot {
  if (!snapshot.providers.some((provider) => provider.checkedAt !== null)) return createEmptyProviderStatusSnapshot("unavailable");
  const current = withCurrentFreshness(snapshot);
  return { ...current, providers: current.providers.map((provider) => ({ ...provider, readiness: "unavailable" })) };
}

export function normalizeProviderStatusSnapshot(input: unknown): ProviderStatusSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const body = input as Record<string, unknown>;
  if (!(body.revision === null || (typeof body.revision === "number" && Number.isSafeInteger(body.revision) && body.revision >= 0)) || !isOptionalTimestamp(body.generatedAt) || !Array.isArray(body.providers)) return null;
  const providers = body.providers.map(normalizeProvider);
  if (providers.some((provider) => provider === null)) return null;
  const normalized = providers as ProviderServiceStatus[];
  if (normalized.length !== PROVIDERS.length || new Set(normalized.map((provider) => provider.provider)).size !== PROVIDERS.length || PROVIDERS.some((provider) => !normalized.some((entry) => entry.provider === provider))) return null;
  return withCurrentFreshness({ revision: body.revision, generatedAt: body.generatedAt, providers: normalized });
}

/** A single local-cache poller shared by every provider-status consumer. */
export class ProviderStatusStore {
  private snapshot: ProviderStatusSnapshot = EMPTY_PROVIDER_STATUS;
  private receivedSnapshot: ProviderStatusSnapshot = EMPTY_PROVIDER_STATUS;
  private listeners = new Set<() => void>();
  private consumers = 0;
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private inFlight = false;
  private pauseOwners = new Set<symbol>();
  private generation = 0;
  private restartWhenIdle: number | null = null;

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => EMPTY_PROVIDER_STATUS;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener); this.consumers += 1;
    if (this.consumers === 1 && !this.pauseOwners.size) this.start();
    return () => { this.listeners.delete(listener); this.consumers = Math.max(0, this.consumers - 1); if (!this.consumers) this.stop(); };
  };
  setPaused(owner: symbol, paused: boolean) {
    const wasPaused = this.pauseOwners.size > 0;
    if (paused) this.pauseOwners.add(owner); else this.pauseOwners.delete(owner);
    if (wasPaused === (this.pauseOwners.size > 0)) return;
    if (this.pauseOwners.size) this.stop(); else if (this.consumers) this.start();
  }
  private publish(snapshot: ProviderStatusSnapshot) {
    this.snapshot = Object.freeze({ ...snapshot, providers: snapshot.providers.map((provider) => Object.freeze({ ...provider, incidents: [...provider.incidents] })) });
    for (const listener of this.listeners) listener();
  }
  async refresh(signal?: AbortSignal, generation = this.generation) {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      const query = this.snapshot.revision === null ? "" : `?revision=${encodeURIComponent(String(this.snapshot.revision))}`;
      const response = await fetch(`/api/provider-status${query}`, { cache: "no-store", signal });
      if (signal?.aborted || generation !== this.generation) return false;
      if (response.status === 204) { this.publish(withCurrentFreshness(this.receivedSnapshot)); return true; }
      if (!response.ok) throw new Error("Provider status unavailable");
      const next = normalizeProviderStatusSnapshot(await response.json());
      if (signal?.aborted || generation !== this.generation) return false;
      if (!next) throw new Error("Malformed provider status");
      this.receivedSnapshot = next;
      this.publish(next); return true;
    } catch {
      if (!signal?.aborted && generation === this.generation) this.publish(unavailableSnapshot(this.snapshot));
      return false;
    } finally {
      this.inFlight = false;
      const restart = this.restartWhenIdle;
      this.restartWhenIdle = null;
      if (restart !== null && restart === this.generation) void this.poll(restart);
    }
  }
  private start() {
    if (typeof window === "undefined" || this.pauseOwners.size) return;
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.publish(withCurrentFreshness(this.snapshot));
    window.addEventListener("focus", this.refreshOnFocus);
    document.addEventListener("visibilitychange", this.refreshOnVisibility);
    if (!document.hidden) { if (this.inFlight) this.restartWhenIdle = generation; else void this.poll(generation); }
  }
  private stop() {
    ++this.generation; this.controller?.abort(); this.controller = null;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    window.removeEventListener("focus", this.refreshOnFocus);
    document.removeEventListener("visibilitychange", this.refreshOnVisibility);
  }
  private refreshOnFocus = () => { if (!document.hidden) { this.publish(withCurrentFreshness(this.snapshot)); void this.poll(this.generation); } };
  private refreshOnVisibility = () => {
    if (document.hidden) { if (this.timer !== null) window.clearTimeout(this.timer); this.timer = null; }
    else { this.publish(withCurrentFreshness(this.snapshot)); void this.poll(this.generation); }
  };
  private schedule(generation: number) {
    if (generation !== this.generation || this.controller?.signal.aborted || !this.consumers || this.pauseOwners.size || document.hidden) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.poll(generation); }, POLL_MS);
  }
  private async poll(generation: number) {
    if (!this.controller || generation !== this.generation || this.controller.signal.aborted || !this.consumers || this.pauseOwners.size || document.hidden) return;
    if (this.inFlight) { this.restartWhenIdle = generation; return; }
    const controller = this.controller;
    await this.refresh(controller.signal, generation);
    if (!controller.signal.aborted && generation === this.generation) this.schedule(generation);
  }
}

let sharedStore: ProviderStatusStore | null = null;
export function getProviderStatusStore() { if (!sharedStore) sharedStore = new ProviderStatusStore(); return sharedStore; }
export function useProviderStatus() { const store = getProviderStatusStore(); return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot); }
export function useProviderStatusPollingPause(paused: boolean) {
  const store = getProviderStatusStore();
  const owner = useRef(Symbol("provider-status-pause-owner"));
  useEffect(() => { const pauseOwner = owner.current; store.setPaused(pauseOwner, paused); return () => store.setPaused(pauseOwner, false); }, [paused, store]);
}
