"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextInventoryRevisionDetail, ProviderId, RepositoryInventorySnapshot } from "../shared/monitor-contract";

const EMPTY: RepositoryInventorySnapshot = { revision: null, readiness: "loading", repositories: [] };

export type RepositoryInventoryCaptureStatus = "completed" | "cancelled" | "busy" | "unavailable" | "timed_out" | "failed";

type RepositoryInventoryDesktopBridge = {
  captureRepositoryContextInventory(repositoryId: string, provider: ProviderId): Promise<RepositoryInventoryCaptureStatus>;
};

export function repositoryInventoryDesktopBridge() {
  return (window as Window & { pomegrDesktop?: RepositoryInventoryDesktopBridge }).pomegrDesktop;
}

export function useRepositoryInventory() {
  const [snapshot, setSnapshot] = useState<RepositoryInventorySnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const revision = useRef<number | string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const query = revision.current === null ? "" : `?revision=${encodeURIComponent(String(revision.current))}`;
      const response = await fetch(`/api/repositories${query}`, { cache: "no-store" });
      if (response.status === 204) { setConnected(true); return; }
      if (!response.ok) throw new Error("unavailable");
      const next = await response.json() as RepositoryInventorySnapshot;
      if (!Array.isArray(next.repositories)) throw new Error("invalid");
      revision.current = next.revision ?? response.headers.get("x-pomegr-revision");
      setSnapshot(next);
      setConnected(true);
    } catch { setConnected(false); }
    finally { setLoading(false); inFlight.current = false; }
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const schedule = (delay = document.hidden ? 30_000 : 5_000) => { timer = window.setTimeout(async () => { await refresh(); schedule(); }, delay); };
    schedule(0);
    const events = typeof EventSource === "function" ? new EventSource("/api/events") : null;
    events?.addEventListener("repositories", (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data);
        if (event.domain === "repositories" && String(event.revision) !== String(revision.current ?? "")) void refresh();
      } catch { /* malformed notifications cannot alter state */ }
    });
    return () => { if (timer !== null) window.clearTimeout(timer); events?.close(); };
  }, [refresh]);

  return { snapshot, loading, connected, refresh };
}

export async function fetchRepositoryInventoryDetail(repositoryId: string, provider: ProviderId, revisionId: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ repositoryId, provider, revisionId });
  const response = await fetch(`/api/repository-inventory?${params}`, { cache: "no-store", signal });
  if (!response.ok) return null;
  return await response.json() as ContextInventoryRevisionDetail;
}
