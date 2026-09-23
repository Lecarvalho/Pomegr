"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  createLoadingFileHistory,
  createLoadingRepositoryFiles,
  type FileHistoryResponse,
  type FileHistoryReadiness,
  type RepositoryFilesResponse,
} from "../shared/repository-files-contract";

export type FileHistoryTarget = { fileId: string } | { path: string };

type Loadable = { readiness: FileHistoryReadiness };

const LOADING_DELAY_MS = 1_500;
const LOADING_BACKOFF_MS = 5_000;
const READY_DELAY_MS = 15_000;

function isVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * One URL-keyed committed cache with reference-counted subscribers. Polls the monitor's
 * committed file-history cache (never triggers acquisition itself): 1.5s while loading or
 * rebuilding, backing off to 5s if that persists; 15s once ready and the tab is visible; it
 * stops scheduling while hidden, paused, or unsubscribed, and wakes on visibilitychange.
 * A failed fetch keeps the last resolved (non-"loading") body -- only a still-loading
 * placeholder downgrades to "unavailable" so the UI does not spin forever.
 */
class KeyedFilesStore<T extends Loadable> {
  private data: T;
  private readonly listeners = new Set<() => void>();
  private consumers = 0;
  private readonly pauseOwners = new Set<symbol>();
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private request: Promise<void> | null = null;
  private loadingStreak = 0;
  private visibilityWake: (() => void) | null = null;

  constructor(private readonly url: string, initial: T) { this.data = initial; }

  getSnapshot = () => this.data;
  getServerSnapshot = () => this.data;

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

  dispose() { this.listeners.clear(); this.consumers = 0; this.pauseOwners.clear(); this.stop(); }

  private publish() { for (const listener of this.listeners) listener(); }

  private nextDelay(): number | null {
    if (!isVisible()) return null;
    if (this.data.readiness === "loading" || this.data.readiness === "rebuilding") {
      this.loadingStreak += 1;
      return this.loadingStreak <= 1 ? LOADING_DELAY_MS : LOADING_BACKOFF_MS;
    }
    this.loadingStreak = 0;
    return READY_DELAY_MS;
  }

  private schedule() {
    if (!this.consumers || this.pauseOwners.size || typeof window === "undefined") return;
    const delay = this.nextDelay();
    if (delay === null) { this.armVisibilityWake(); return; }
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => { this.timer = null; void this.poll(); }, delay);
  }

  private armVisibilityWake() {
    if (this.visibilityWake || typeof document === "undefined") return;
    this.visibilityWake = () => {
      if (!isVisible() || !this.consumers || this.pauseOwners.size) return;
      document.removeEventListener("visibilitychange", this.visibilityWake!);
      this.visibilityWake = null;
      void this.poll();
    };
    document.addEventListener("visibilitychange", this.visibilityWake);
  }

  private async poll() {
    if (!this.consumers || this.pauseOwners.size) return;
    await this.refresh();
    this.schedule();
  }

  refresh = async (): Promise<void> => {
    if (this.request) return this.request;
    if (!this.consumers || this.pauseOwners.size) return;
    const controller = new AbortController();
    this.controller = controller;
    const request = this.request = (async () => {
      try {
        const response = await fetch(this.url, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        const next = (await response.json().catch(() => null)) as T | null;
        if (controller.signal.aborted) return;
        if (!next || typeof next.readiness !== "string") throw new Error("invalid file-history response");
        this.data = next;
        this.publish();
      } catch {
        if (!controller.signal.aborted && this.data.readiness === "loading") {
          this.data = { ...this.data, readiness: "unavailable" };
          this.publish();
        }
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    })();
    await request;
    if (this.request === request) this.request = null;
  };

  private start() {
    if (typeof window === "undefined" || this.pauseOwners.size) return;
    this.loadingStreak = 0;
    void this.poll();
  }

  private stop() {
    this.controller?.abort();
    this.controller = null;
    this.request = null;
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    if (this.visibilityWake && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityWake);
      this.visibilityWake = null;
    }
  }
}

const stores = new Map<string, KeyedFilesStore<Loadable>>();

function getStore<T extends Loadable>(url: string, initial: () => T): KeyedFilesStore<T> {
  const existing = stores.get(url);
  if (existing) return existing as KeyedFilesStore<T>;
  const store = new KeyedFilesStore<T>(url, initial());
  stores.set(url, store as KeyedFilesStore<Loadable>);
  return store;
}

function useKeyedFiles<T extends Loadable>(url: string | null, initial: () => T, paused: boolean): T | null {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by url only; a new key gets a fresh store
  const store = useMemo(() => (url ? getStore(url, initial) : null), [url]);
  const owner = useRef<symbol>(Symbol("repository-files-pause"));
  useEffect(() => {
    const pauseOwner = owner.current;
    store?.setPaused(pauseOwner, paused);
    return () => store?.setPaused(pauseOwner, false);
  }, [store, paused]);
  const subscribe = useMemo(() => (store ? store.subscribe : () => () => {}), [store]);
  const getSnapshot = useMemo(() => (store ? store.getSnapshot : () => null), [store]);
  const getServerSnapshot = useMemo(() => (store ? store.getServerSnapshot : () => null), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Committed repository file listing; null until the first response arrives. */
export function useRepositoryFiles(repositoryId: string | null, options: { paused?: boolean } = {}): RepositoryFilesResponse | null {
  const url = repositoryId ? `/api/repository-files?${new URLSearchParams({ repositoryId })}` : null;
  return useKeyedFiles<RepositoryFilesResponse>(url, () => createLoadingRepositoryFiles(repositoryId || ""), options.paused === true);
}

function fileHistoryUrl(repositoryId: string, target: FileHistoryTarget) {
  const params = new URLSearchParams({ repositoryId });
  if ("fileId" in target) params.set("fileId", target.fileId); else params.set("path", target.path);
  return `/api/repository-files?${params}`;
}

/** Committed per-file session history; null while no target is selected or before the first response. */
export function useFileHistory(repositoryId: string | null, target: FileHistoryTarget | null, options: { paused?: boolean } = {}): FileHistoryResponse | null {
  const path = target && "path" in target ? target.path : null;
  const url = repositoryId && target ? fileHistoryUrl(repositoryId, target) : null;
  return useKeyedFiles<FileHistoryResponse>(url, () => createLoadingFileHistory(repositoryId || "", path), options.paused === true);
}

export function resetRepositoryFilesStoreForTests() {
  for (const store of stores.values()) store.dispose();
  stores.clear();
}
