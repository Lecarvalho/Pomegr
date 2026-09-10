import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityHistoryPage } from "../../../shared/session-history-contract";

export const ACTIVITY_PAGE_SIZE = 8;
type LoadOptions = { requestId?: string; anchor?: string; refresh?: boolean; silent?: boolean };

/** Keep just the current page and its two neighbors; background arrivals preserve the anchor. */
export function useActivityHistory({ enabled, sessionId, scope, filterRequestId, navigation }: {
  enabled: boolean; sessionId: string; scope: string; filterRequestId: string | null; navigation: { id: string } | null;
}) {
  const [state, setState] = useState<{ key: string; page: ActivityHistoryPage | null; loading: boolean; failed: boolean; newEvents: number; linkedCount: number | null }>({ key: "", page: null, loading: false, failed: false, newEvents: 0, linkedCount: null });
  const key = `${sessionId}:${scope}:${filterRequestId ?? ""}`;
  const cache = useRef(new Map<number, ActivityHistoryPage>());
  const current = useRef<ActivityHistoryPage | null>(null);
  const sequence = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const baseline = useRef(0);
  const lastNavigation = useRef(navigation);
  const pending = useRef<{ offset: number; options: LoadOptions } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async function loadPage(offset: number, options: LoadOptions = {}): Promise<void> {
    if (!enabled) return;
    if (options.requestId && pending.current?.options.requestId === options.requestId && controllers.current.size) return;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    const generation = ++sequence.current;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    pending.current = { offset, options };
    const fetchPage = async (start: number, extra: typeof options = {}): Promise<ActivityHistoryPage> => {
      const params = new URLSearchParams({ sessionId, kind: "activity", scope, offset: String(start), limit: String(ACTIVITY_PAGE_SIZE) });
      if (filterRequestId) params.set("filterRequestId", filterRequestId);
      if (extra.requestId) params.set("requestId", extra.requestId);
      if (extra.anchor) params.set("anchor", extra.anchor);
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const response = await fetch(`/api/session-history?${params}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("History unavailable");
        const page = await response.json() as ActivityHistoryPage;
        if (page.kind !== "activity" || !Array.isArray(page.items)) throw new Error("Invalid history page");
        return page;
      } finally { controllers.current.delete(controller); }
    };
    // Any resident linked row can reveal this request; no server lookup is needed.
    const cached = !options.anchor && !options.refresh
      ? options.requestId
        ? [current.current, ...cache.current.values()].find((page) => page?.items.some((item) => item.requestId === options.requestId))
        : cache.current.get(offset)
      : null;
    if (!cached) setState((previous) => ({ key, page: previous.key === key ? previous.page : null, newEvents: previous.key === key ? previous.newEvents : 0, linkedCount: options.requestId ? null : previous.linkedCount, loading: !options.silent, failed: false }));
    try {
      const page = cached || await fetchPage(offset, options);
      if (sequence.current !== generation) return;
      if (page.status !== "ready") {
        setState((previous) => ({ ...previous, key, loading: page.status === "loading" && !options.silent, failed: page.status === "unavailable" }));
        if (page.status === "loading" && !options.silent) {
          retryTimer.current = setTimeout(() => { void loadPage(offset, options); }, 750);
        }
        return;
      }
      pending.current = null;
      if (current.current?.revision !== page.revision) cache.current.clear();
      if (!current.current || page.offset === 0) baseline.current = page.total;
      current.current = page;
      cache.current.set(page.offset, page);
      const neighbors = [page.offset - ACTIVITY_PAGE_SIZE, page.offset, page.offset + ACTIVITY_PAGE_SIZE].filter((start) => start >= 0 && start < page.total);
      for (const start of cache.current.keys()) if (!neighbors.includes(start)) cache.current.delete(start);
      setState((previous) => ({ key, page, loading: false, failed: false, newEvents: Math.max(0, page.total - baseline.current), linkedCount: options.requestId ? cached ? null : page.linkedCount : filterRequestId ? page.linkedCount : previous.key === key ? previous.linkedCount : null }));
      await Promise.allSettled(neighbors.filter((start) => start !== page.offset && !cache.current.has(start)).map(async (start) => {
        const neighbor = await fetchPage(start);
        if (sequence.current === generation && neighbor.status === "ready" && neighbor.revision === page.revision) cache.current.set(start, neighbor);
      }));
    } catch {
      if (sequence.current === generation) setState((previous) => ({ ...previous, key, loading: false, failed: true }));
    }
  }, [enabled, sessionId, scope, filterRequestId, key]);

  useEffect(() => {
    current.current = null;
    cache.current.clear();
    baseline.current = 0;
    const target = navigation !== lastNavigation.current ? navigation : null;
    if (target) lastNavigation.current = navigation;
    void load(0, target ? { requestId: target.id } : {});
    const activeControllers = controllers.current;
    return () => {
      sequence.current += 1;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      pending.current = null;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
    };
  // Scope/session initialization consumes a simultaneous navigation once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    if (navigation === lastNavigation.current) return;
    lastNavigation.current = navigation;
    if (navigation) void load(0, { requestId: navigation.id });
  }, [navigation, load]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (controllers.current.size || retryTimer.current) return;
      if (pending.current) { void load(pending.current.offset, pending.current.options); return; }
      const page = current.current;
      void load(page?.offset ?? 0, { refresh: true, silent: Boolean(page), anchor: page && page.offset > 0 ? page.items[0]?.id : undefined });
    }, 10_000);
    return () => clearInterval(timer);
  }, [enabled, load]);

  const page = state.key === key ? state.page : null;
  return {
    page,
    loading: enabled && (state.key !== key || state.loading),
    failed: state.key === key && state.failed,
    newEvents: state.key === key ? state.newEvents : 0,
    linkedCount: state.key === key ? state.linkedCount : null,
    goToPage: (number: number) => void load(Math.max(0, number - 1) * ACTIVITY_PAGE_SIZE),
    locate: (id: string) => void load(0, { requestId: id }),
    refresh: () => void load(page?.offset ?? 0, { refresh: true, anchor: page && page.offset > 0 ? page.items[0]?.id : undefined }),
    latest: () => void load(0, { refresh: true }),
  };
}
