import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, CacheEventFeed, CacheReadDropFeed, ContextHistoryBoundary, RequestSnapshotFeed } from "../../../../shared/monitor-contract";
import type { RequestHistoryPage } from "../../../../shared/session-history-contract";
import { subscribeHistoryPublications } from "../../../history-publications";
import { usePhoneLayout } from "../../../hooks/usePhoneLayout";
import { isCompleteRequestOverview, scopedRows, type RequestRow } from "./model";
import { useRequestSelection } from "./useRequestSelection";
import { useRequestPageCache } from "./useRequestPageCache";

export type SessionRequestInputs = {
  agents: Agent[]; requestSnapshots: RequestSnapshotFeed; contextBoundaries: ContextHistoryBoundary[];
  historical: boolean; cacheEvents?: CacheEventFeed; cacheReadDrops?: CacheReadDropFeed; sessionId?: string;
  /** Opt-in only while the monitor exposes the paged session-history endpoint. */
  historyEnabled?: boolean;
};

type HistoryState = { key: string; page: RequestHistoryPage | null; loading: boolean; unavailable: boolean; retryable: boolean; requestedOffset?: number };
type HistoryQuery = { offset?: number | "latest"; requestId?: string; scope?: string };
type PendingLocate = { id: string; scope: string } | null;
type PendingPageSelection = { key: string; offset: number; index: number | null } | null;

function historyScope(scope: string, agents: Agent[]): string {
  if (scope === "all") return "all";
  const primary = agents.find((agent) => agent.parentId === null)?.id;
  return scope === primary ? "primary" : scope;
}

function pageKey(sessionId: string, scope: string, size: number) {
  return `${sessionId}:${scope}:${size}`;
}

function isRequestPage(value: unknown): value is RequestHistoryPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<RequestHistoryPage>;
  return page.kind === "requests" && (page.status === "ready" || page.status === "loading" || page.status === "unavailable") && Array.isArray(page.items);
}

/** One selection for the chart, its evidence links, and the activity feed. */
export function useSessionRequestSelection({ agents, requestSnapshots, contextBoundaries, historical, cacheEvents, cacheReadDrops, sessionId = "", historyEnabled = false }: SessionRequestInputs) {
  const phone = usePhoneLayout();
  const size = phone ? 20 : 60;
  const [preference, setPreference] = useState({ sessionId, scope: "all" });
  const scope = preference.sessionId === sessionId ? preference.scope : "all";
  const resolvedScope = scope === "all" || agents.some((agent) => agent.id === scope) ? scope : "all";
  const key = pageKey(sessionId, resolvedScope, size);
  const [history, setHistory] = useState<HistoryState>({ key, page: null, loading: false, unavailable: false, retryable: false });
  const page = historyEnabled && history.key === key ? history.page : null;
  const pageCache = useRequestPageCache(key, sessionId, historyScope(resolvedScope, agents), page);
  const request = useRef<{ controller: AbortController; serial: number } | null>(null);
  const serial = useRef(0);
  const requestedKey = useRef("");
  const lastQuery = useRef<{ key: string; options: HistoryQuery } | null>(null);
  const [pendingLocate, setPendingLocate] = useState<PendingLocate>(null);
  const [pendingPageSelection, setPendingPageSelection] = useState<PendingPageSelection>(null);
  const [retry, setRetry] = useState(0);
  const queuedPublication = useRef<{ revision: number } | null>(null);
  const publicationState = useRef({ pinned: false, atLatest: true, loading: false, unavailable: false, hydrating: true });
  const loadHistoryRef = useRef<(options?: HistoryQuery) => Promise<RequestHistoryPage | null>>(() => Promise.resolve(null));

  const loadHistory = useCallback((options: HistoryQuery = {}) => {
    if (!historyEnabled || !sessionId) return Promise.resolve(null);
    const nextScope = options.scope ?? resolvedScope;
    const nextKey = pageKey(sessionId, nextScope, size);
    requestedKey.current = nextKey;
    lastQuery.current = { key: nextKey, options };
    request.current?.controller.abort();
    const controller = new AbortController();
    const requestSerial = ++serial.current;
    request.current = { controller, serial: requestSerial };
    const requestedOffset = typeof options.offset === "number" ? options.offset : undefined;
    const cached = nextKey === key
      ? options.requestId ? pageCache.locate(options.requestId, size)
        : requestedOffset !== undefined ? pageCache.window(requestedOffset, size) : null
      : null;
    if (cached) {
      setHistory({ key: nextKey, page: cached, loading: false, unavailable: false, retryable: false });
      return Promise.resolve(cached);
    }
    setHistory((current) => ({ key: nextKey, page: current.key === nextKey ? current.page : null, loading: true, unavailable: false, retryable: false, requestedOffset }));
    const params = new URLSearchParams({ sessionId, kind: "requests", scope: historyScope(nextScope, agents), limit: String(size), offset: String(options.offset ?? "latest") });
    if (options.requestId) params.set("requestId", options.requestId);
    return fetch(`/api/session-history?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((value: unknown) => {
        if (controller.signal.aborted || requestSerial !== serial.current) {
          return null;
        }
        if (!isRequestPage(value)) {
          setHistory((current) => ({ key: nextKey, page: current.key === nextKey ? current.page : null, loading: false, unavailable: true, retryable: true }));
          return null;
        }
        if (value.status === "ready") {
          if (nextKey === key) pageCache.add(value);
          setHistory({ key: nextKey, page: value, loading: false, unavailable: false, retryable: false });
        }
        else {
          if (value.status === "loading") setHistory((current) => ({ key: nextKey, page: current.key === nextKey ? current.page : null, loading: true, unavailable: false, retryable: true, requestedOffset }));
          else setHistory((current) => ({ key: nextKey, page: current.key === nextKey ? current.page : null, loading: false, unavailable: true, retryable: true }));
        }
        return value.status === "ready" ? value : null;
      })
      .catch(() => {
        if (!controller.signal.aborted && requestSerial === serial.current) setHistory((current) => ({ key: nextKey, page: current.key === nextKey ? current.page : null, loading: false, unavailable: true, retryable: true }));
        return null;
      })
      .finally(() => {
        if (request.current?.serial !== requestSerial) return;
        request.current = null;
        if (!controller.signal.aborted && historical && queuedPublication.current) {
          queuedPublication.current = null;
          const queued = lastQuery.current?.key === nextKey ? lastQuery.current.options : { offset: "latest" as const };
          void loadHistoryRef.current(queued);
        }
      });
  }, [agents, historical, historyEnabled, key, pageCache, resolvedScope, sessionId, size]);
  useEffect(() => { loadHistoryRef.current = loadHistory; }, [loadHistory]);

  useEffect(() => {
    if (!historyEnabled) return;
    if (requestedKey.current === key) return;
    void loadHistory(lastQuery.current?.key === key ? lastQuery.current.options : undefined);
    const requestSerial = serial.current;
    return () => {
      // A locate action can start the next request before this effect cleans up.
      if (request.current?.serial === requestSerial) {
        request.current.controller.abort();
        requestedKey.current = "";
      }
    };
  // History loads only when the session, filter, or chart capacity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyEnabled, key, retry]);

  useEffect(() => () => { request.current?.controller.abort(); }, []);

  useEffect(() => {
    if (!historyEnabled || history.key !== key || !history.retryable) return;
    const timer = window.setTimeout(() => {
      requestedKey.current = "";
      setRetry((value) => value + 1);
    }, history.unavailable ? 5_000 : 750);
    return () => window.clearTimeout(timer);
  }, [history.unavailable, history.key, history.retryable, historyEnabled, key]);

  const preview = historyEnabled && !page;
  const historyFeed = useMemo<RequestSnapshotFeed>(() => page ? { status: "ready", items: page.items } : requestSnapshots, [page, requestSnapshots]);
  const allRows = useMemo(() => scopedRows(historyFeed, contextBoundaries, "all", cacheEvents, cacheReadDrops), [historyFeed, contextBoundaries, cacheEvents, cacheReadDrops]);
  // History pages are already scoped server-side. Summary previews still need
  // local scoping, and do not have stable history numbers until the page arrives.
  const rows = useMemo(() => {
    const scoped = page || resolvedScope === "all" ? allRows
      : scopedRows(requestSnapshots, contextBoundaries, resolvedScope, cacheEvents, cacheReadDrops);
    // Preview only the latest chart window. History owns stable numbering and
    // full-session navigation; summary positions must never impersonate it.
    return preview ? scoped.slice(-size).map((row, index) => ({ ...row, ordinal: index + 1, number: undefined, numberPending: true })) : scoped;
  }, [allRows, cacheEvents, cacheReadDrops, contextBoundaries, page, preview, requestSnapshots, resolvedScope, size]);
  const scopeKey = (value: string) => `${sessionId}:${value}`;
  const locateTarget = pendingLocate?.scope === resolvedScope ? pendingLocate.id : null;
  const atLatest = !page || page.offset + page.items.length >= page.total;
  const selection = useRequestSelection(rows, scopeKey(resolvedScope), size, historical, atLatest);
  useEffect(() => {
    const overviewPending = Boolean(page && page.total > 0 && !isCompleteRequestOverview(page.overview, page.total));
    publicationState.current = { pinned: selection.pinned, atLatest, loading: history.loading, unavailable: history.unavailable, hydrating: !page || history.loading || overviewPending };
  }, [atLatest, history.loading, history.unavailable, page, selection.pinned]);
  // A summary preview cannot establish whether the linked request is newest.
  const locatedRow = locateTarget && page ? rows.find((row) => row.id === locateTarget) : null;
  if (locatedRow) {
    selection.select(locatedRow, true);
    setPendingLocate(null);
  }
  if (pendingPageSelection?.key === key && page && page.offset === pendingPageSelection.offset) {
    // Window navigation accepts the reconciled chart selection; keyboard stepping has an explicit target.
    const target = pendingPageSelection.index === null ? selection.selected : rows[pendingPageSelection.index - page.offset];
    if (target) selection.select(target, true);
    setPendingPageSelection(null);
  }

  useEffect(() => {
    const atLatest = page && page.offset + page.items.length >= page.total;
    if (!historyEnabled || historical || selection.pinned || history.loading || history.unavailable || !atLatest) return;
    const timer = window.setTimeout(() => { void loadHistory({ offset: "latest" }); }, 3_000);
    return () => window.clearTimeout(timer);
  // Live refresh intentionally follows only an unpinned latest page; older and selected pages stay anchored.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historical, history.loading, history.unavailable, historyEnabled, page, selection.pinned]);

  useEffect(() => {
    if (!historyEnabled) return;
    return subscribeHistoryPublications(({ revision }) => {
      const current = publicationState.current;
      // Recorded sessions do not follow settled revisions, but their first
      // history page may still be waiting for an asynchronous commit.
      if (historical) {
        if (current.unavailable || !current.hydrating) return;
        if (request.current) {
          if (!queuedPublication.current || revision >= queuedPublication.current.revision) queuedPublication.current = { revision };
          return;
        }
        void loadHistoryRef.current({ offset: "latest" });
        return;
      }
      if (current.pinned || !current.atLatest || current.unavailable) return;
      if (current.loading || request.current) {
        if (!queuedPublication.current || revision >= queuedPublication.current.revision) queuedPublication.current = { revision };
        return;
      }
      void loadHistoryRef.current({ offset: "latest" });
    });
  }, [historical, historyEnabled]);

  useEffect(() => {
    if (!historyEnabled || historical || queuedPublication.current === null || selection.pinned || !atLatest
      || history.loading || history.unavailable || request.current) return;
    const publication = queuedPublication.current;
    if (!publication) return;
    queuedPublication.current = null;
    void loadHistory({ offset: "latest" });
  }, [atLatest, historical, history.loading, history.unavailable, historyEnabled, loadHistory, selection.pinned]);

  const setScope = (value: string) => setPreference({ sessionId, scope: value });
  const cancelHistoryNavigation = () => {
    if (!pendingLocate && !pendingPageSelection) return;
    request.current?.controller.abort();
    serial.current += 1;
    setPendingLocate(null);
    setPendingPageSelection(null);
    setHistory((current) => ({ ...current, loading: false, retryable: false, unavailable: false, requestedOffset: undefined }));
  };
  const select = (row: RequestRow, center = false) => {
    if (historyEnabled && !page) return locate(row.id);
    cancelHistoryNavigation();
    selection.select(row, center);
  };
  const locate = (id: string) => {
    cancelHistoryNavigation();
    const row = rows.find((item) => item.id === id);
    if (row && (!historyEnabled || page)) return selection.select(row, true);
    const allRow = !historyEnabled ? scopedRows(requestSnapshots, contextBoundaries, "all", cacheEvents, cacheReadDrops).find((item) => item.id === id) : null;
    if (allRow) {
      setScope("all");
      return selection.selectScope(scopedRows(requestSnapshots, contextBoundaries, "all", cacheEvents, cacheReadDrops), scopeKey("all"), allRow);
    }
    if (!historyEnabled) return;
    setPendingLocate({ id, scope: "all" });
    setScope("all");
    void loadHistory({ scope: "all", requestId: id });
  };
  const selectScope = (nextRows: RequestRow[], nextScope: string, row: RequestRow) => {
    cancelHistoryNavigation();
    setScope(nextScope);
    selection.selectScope(nextRows, scopeKey(nextScope), row);
  };
  const pageTo = (offset: number | "latest") => void loadHistory({ offset });
  const moveHistoryWindow = (start: number) => {
    if (!page || !Number.isFinite(start)) return;
    const offset = Math.max(0, Math.min(Math.round(start) - 1, Math.max(0, page.total - size)));
    if (offset === (history.requestedOffset ?? page.offset)) return;
    setPendingLocate(null);
    setPendingPageSelection({ key, offset, index: null });
    pageTo(offset);
  };
  const step = (delta: number) => {
    cancelHistoryNavigation();
    if (!historyEnabled || !page || !selection.selected) return selection.step(delta);
    if (delta < 0 && selection.selected.ordinal === 1 && page.offset > 0) {
      const offset = Math.max(0, page.offset - size);
      setPendingPageSelection({ key, offset, index: page.offset - 1 });
      return pageTo(offset);
    }
    if (delta > 0 && selection.selected.ordinal === rows.length && page.offset + page.items.length < page.total) {
      const offset = Math.min(page.offset + page.items.length, Math.max(0, page.total - size));
      setPendingPageSelection({ key, offset, index: page.offset + page.items.length });
      return pageTo(offset);
    }
    return selection.step(delta);
  };
  const older = () => { if (page && !history.loading && page.offset > 0) pageTo(Math.max(0, page.offset - size)); };
  const newer = () => { if (page && !history.loading && page.offset + page.items.length < page.total) pageTo(page.offset + size); };
  const first = () => pageTo(0);
  const latest = () => pageTo("latest");
  return {
    ...selection, select, step, selectScope, rows, allRows, agents, scope: resolvedScope, setScope, phone, size, locate,
    history: {
      enabled: historyEnabled,
      preview,
      status: history.loading ? "loading" : history.unavailable ? "unavailable" : page ? "ready" : "loading",
      // Activity row links load chart details without replacing the Activity page.
      navigating: history.loading && pendingPageSelection?.key === key,
      revision: page?.revision ?? "",
      overview: page?.overview ?? null,
      total: page?.total ?? rows.length,
      offset: page?.offset ?? 0,
      windowStart: (history.key === key ? history.requestedOffset ?? page?.offset ?? 0 : 0) + 1,
      moveWindow: moveHistoryWindow,
      linkedCount: page?.linkedCount ?? 0,
      first, latest, older, newer,
      hasOlder: Boolean(page && page.offset > 0),
      hasNewer: Boolean(page && page.offset + page.items.length < page.total),
    },
  };
}

export type SessionRequestSelection = ReturnType<typeof useSessionRequestSelection>;
