"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ContextInventoryRevisionDetail, ProviderId, RepositoryInventorySnapshot } from "../shared/monitor-contract";
import type { RepositoryPluginAction, RepositoryPluginActionStatus } from "../shared/repository-plugin-contract";
import { subscribeLiveEvents } from "./live-events";

const EMPTY: RepositoryInventorySnapshot = { revision: null, readiness: "loading", repositories: [] };

export type RepositoryInventoryCaptureStatus = "completed" | "cancelled" | "busy" | "unavailable" | "timed_out" | "failed";

type RepositoryInventoryDesktopBridge = {
  captureRepositoryContextInventory(repositoryId: string, provider: ProviderId): Promise<RepositoryInventoryCaptureStatus>;
  repositoryPluginAction(repositoryId: string, provider: ProviderId, action: RepositoryPluginAction): Promise<RepositoryPluginActionStatus>;
};

export function repositoryInventoryDesktopBridge() {
  return (window as Window & { pomegrDesktop?: RepositoryInventoryDesktopBridge }).pomegrDesktop;
}

/** One tab-scoped repository cache. A shared read avoids duplicate shell/detail polling. */
export class RepositoryInventoryStore {
  private snapshot: RepositoryInventorySnapshot = EMPTY;
  private loading = true;
  private connected = true;
  private listeners = new Set<() => void>();
  private consumers = 0;
  private pauseOwners = new Set<symbol>();
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private request: Promise<void> | null = null;
  private dirty = false;
  private reconnecting = true;
  private generation = 0;
  private unsubscribeEvents: (() => void) | null = null;
  private view!: { snapshot: RepositoryInventorySnapshot; loading: boolean; connected: boolean; refresh: (force?: boolean) => Promise<void> };

  constructor() { this.view = { snapshot: this.snapshot, loading: this.loading, connected: this.connected, refresh: this.refresh }; }
  getSnapshot = () => this.view;
  getServerSnapshot = () => this.view;
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
  private publish() {
    this.view = { snapshot: this.snapshot, loading: this.loading, connected: this.connected, refresh: this.refresh };
    for (const listener of this.listeners) listener();
  }
  private schedule(delay = document.hidden ? 30_000 : this.reconnecting ? 5_000 : 30_000) {
    if (!this.consumers || this.pauseOwners.size || this.timer !== null) return;
    this.timer = window.setTimeout(() => { this.timer = null; void this.poll(); }, delay);
  }
  private async poll() {
    if (!this.consumers || this.pauseOwners.size) return;
    await this.refresh();
    this.schedule();
  }
  refresh = async (force = false): Promise<void> => {
    if (this.request) {
      if (force) this.dirty = true;
      return this.request;
    }
    if (!this.consumers || this.pauseOwners.size) return;
    const generation = this.generation;
    const controller = this.controller ?? new AbortController();
    const query = this.snapshot.revision === null ? "" : `?revision=${encodeURIComponent(String(this.snapshot.revision))}`;
    const request = this.request = (async () => {
      try {
        const response = await fetch(`/api/repositories${query}`, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted || generation !== this.generation) return;
        if (response.status === 204) { this.connected = true; return; }
        if (!response.ok) throw new Error("unavailable");
        const next = await response.json() as RepositoryInventorySnapshot;
        if (controller.signal.aborted || generation !== this.generation || !Array.isArray(next.repositories)) return;
        this.snapshot = next;
        this.connected = true;
      } catch {
        if (!controller.signal.aborted && generation === this.generation) this.connected = false;
      } finally {
        if (!controller.signal.aborted && generation === this.generation) {
          this.loading = false;
          this.publish();
        }
      }
    })();
    await request;
    if (this.request !== request) return;
    this.request = null;
    if (this.dirty && this.consumers && !this.pauseOwners.size) {
      this.dirty = false;
      await this.refresh();
    }
  };
  private start() {
    if (typeof window === "undefined" || this.pauseOwners.size) return;
    this.generation += 1;
    this.controller = new AbortController();
    this.loading = true;
    this.publish();
    const generation = this.generation;
    this.unsubscribeEvents = subscribeLiveEvents((event) => {
      if (generation !== this.generation) return;
      if (event.type === "connection") {
        this.reconnecting = event.state === "reconnecting";
        if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; this.schedule(); }
      } else if (!document.hidden && event.domain === "repositories" && String(event.revision) !== String(this.snapshot.revision ?? "")) {
        void this.refresh(true);
      }
    });
    document.addEventListener("visibilitychange", this.wake);
    window.addEventListener("focus", this.wake);
    // Start before a synchronous connection-state notification can replace the
    // initial request with the reconnect fallback timer.
    void this.poll();
  }
  private stop() {
    this.generation += 1;
    this.controller?.abort(); this.controller = null;
    this.request = null;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null; this.dirty = false;
    this.unsubscribeEvents?.(); this.unsubscribeEvents = null;
    document.removeEventListener("visibilitychange", this.wake);
    window.removeEventListener("focus", this.wake);
  }
  private wake = () => {
    if (document.hidden || !this.consumers || this.pauseOwners.size) return;
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    void this.poll();
  };
}

let sharedStore: RepositoryInventoryStore | null = null;
export function getRepositoryInventoryStore() { if (!sharedStore) sharedStore = new RepositoryInventoryStore(); return sharedStore; }
export function useRepositoryInventory() {
  const store = getRepositoryInventoryStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
export function useRepositoryInventoryPollingPause(paused: boolean) {
  const store = getRepositoryInventoryStore();
  const owner = useRef(Symbol("repository-inventory-pause-owner"));
  useEffect(() => { const pauseOwner = owner.current; store.setPaused(pauseOwner, paused); return () => store.setPaused(pauseOwner, false); }, [paused, store]);
}

export async function fetchRepositoryInventoryDetail(repositoryId: string, provider: ProviderId, revisionId: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ repositoryId, provider, revisionId });
  const response = await fetch(`/api/repository-inventory?${params}`, { cache: "no-store", signal });
  if (!response.ok) return null;
  return await response.json() as ContextInventoryRevisionDetail;
}
