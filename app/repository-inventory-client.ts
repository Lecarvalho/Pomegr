"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextInventoryRevisionDetail, ProviderId, RepositoryInventorySnapshot } from "../shared/monitor-contract";
import type { RepositoryPluginAction, RepositoryPluginActionStatus } from "../shared/repository-plugin-contract";

const EMPTY: RepositoryInventorySnapshot = { revision: null, readiness: "loading", repositories: [] };

export type RepositoryInventoryCaptureStatus = "completed" | "cancelled" | "busy" | "unavailable" | "timed_out" | "failed";

type RepositoryInventoryDesktopBridge = {
  captureRepositoryContextInventory(repositoryId: string, provider: ProviderId): Promise<RepositoryInventoryCaptureStatus>;
  repositoryPluginAction(repositoryId: string, provider: ProviderId, action: RepositoryPluginAction): Promise<RepositoryPluginActionStatus>;
};

export function repositoryInventoryDesktopBridge() {
  return (window as Window & { pomegrDesktop?: RepositoryInventoryDesktopBridge }).pomegrDesktop;
}

export function useRepositoryInventory() {
  const [snapshot, setSnapshot] = useState<RepositoryInventorySnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const revision = useRef<number | string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const disposed = useRef(false);

  const refresh = useCallback(async (force = false): Promise<void> => {
    const current = inFlight.current;
    if (current) {
      await current;
      if (!force) return;
    }
    if (disposed.current) return;
    if (inFlight.current) return inFlight.current;
    const controller = new AbortController();
    requestController.current = controller;
    const pending = (async () => {
      try {
        const query = revision.current === null ? "" : `?revision=${encodeURIComponent(String(revision.current))}`;
        const response = await fetch(`/api/repositories${query}`, { cache: "no-store", signal: controller.signal });
        if (disposed.current || controller.signal.aborted) return;
        if (response.status === 204) { setConnected(true); return; }
        if (!response.ok) throw new Error("unavailable");
        const next = await response.json() as RepositoryInventorySnapshot;
        if (disposed.current || controller.signal.aborted) return;
        if (!Array.isArray(next.repositories)) throw new Error("invalid");
        revision.current = next.revision ?? response.headers.get("x-pomegr-revision");
        setSnapshot(next);
        setConnected(true);
      } catch {
        if (!disposed.current && !controller.signal.aborted) setConnected(false);
      } finally {
        if (!disposed.current && !controller.signal.aborted) setLoading(false);
        if (requestController.current === controller) {
          requestController.current = null;
          inFlight.current = null;
        }
      }
    })();
    inFlight.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    let stopped = false;
    disposed.current = false;
    const schedule = (delay = document.hidden ? 30_000 : 5_000) => {
      if (stopped || timer !== null) return;
      timer = window.setTimeout(() => { timer = null; void poll(); }, delay);
    };
    const poll = async () => {
      await refresh();
      if (!stopped) schedule();
    };
    const wake = () => {
      if (document.hidden || stopped) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      void poll();
    };
    schedule(0);
    const events = typeof EventSource === "function" ? new EventSource("/api/events") : null;
    events?.addEventListener("repositories", (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data);
        if (event.domain === "repositories" && String(event.revision) !== String(revision.current ?? "")) void refresh();
      } catch { /* malformed notifications cannot alter state */ }
    });
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      stopped = true;
      disposed.current = true;
      if (timer !== null) window.clearTimeout(timer);
      requestController.current?.abort();
      events?.close();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [refresh]);

  return { snapshot, loading, connected, refresh };
}

export async function fetchRepositoryInventoryDetail(repositoryId: string, provider: ProviderId, revisionId: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ repositoryId, provider, revisionId });
  const response = await fetch(`/api/repository-inventory?${params}`, { cache: "no-store", signal });
  if (!response.ok) return null;
  return await response.json() as ContextInventoryRevisionDetail;
}
