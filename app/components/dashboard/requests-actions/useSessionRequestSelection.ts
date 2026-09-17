import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, CacheEventFeed, CacheReadDropFeed, ContextHistoryBoundary, RequestSnapshotFeed, WorkKind } from "../../../../shared/monitor-contract";
import type { RequestHistoryPage } from "../../../../shared/session-history-contract";
import { subscribeLiveEvents } from "../../../live-events";
import { usePhoneLayout } from "../../../hooks/usePhoneLayout";
import { parseActivityFeedPage } from "../activity-feed/feed-model";
import { isCompleteRequestOverview, scopedRows, type RequestRow } from "./model";
import { advanceOnGrowth, modeFor, selectionAfterCommit, stepTarget, transferOnViewportMove, type SelectedRequest, type SelectionMode } from "./selection-viewport";
import { useRequestSelection } from "./useRequestSelection";
import { useRequestPageCache } from "./useRequestPageCache";

/** The Activities deep-link scope: `agent` is a normalized agent id; `request` a number or opaque request id. */
export type RequestSelectionRoute = { agent: string | null; request: string | null };

export type SessionRequestInputs = {
  agents: Agent[]; requestSnapshots: RequestSnapshotFeed; contextBoundaries: ContextHistoryBoundary[];
  historical: boolean; cacheEvents?: CacheEventFeed; cacheReadDrops?: CacheReadDropFeed; sessionId?: string;
  /** Opt-in only while the monitor exposes the paged session-history endpoint. */
  historyEnabled?: boolean;
  route?: RequestSelectionRoute;
  onRouteChange?: (next: RequestSelectionRoute) => void;
};

type HistoryState = { key: string; page: RequestHistoryPage | null; loading: boolean; unavailable: boolean; retryable: boolean; requestedOffset?: number };
type HistoryQuery = {
  offset?: number | "latest"; requestId?: string; scope?: string; refresh?: boolean;
  /** A refresh must keep this selected bar; a page without it is never committed silently. */
  keep?: SelectedRequest;
  /** Track mode: anchor at the selected bar before committing growth that would push it out. */
  track?: boolean;
  /** A route lookup whose absence resolves to the latest request and clears the URL request. */
  route?: boolean;
  /** A user or route lookup; pinned lookups never follow appends. */
  pin?: boolean;
  /** The explicit transfer, step or jump target this page commits. */
  select?: number | "latest";
};
type PendingLocate = { id: string; scope: string; pin: boolean } | null;
type PendingPageSelection = { key: string; offset: number | "latest"; index: number | "latest" | null } | null;
/**
 * Refresh inputs, written synchronously when a page commits or the user selects (never by a
 * post-render effect), so a queued publication always refreshes the selection that is current.
 */
type Publication = {
  committedKey: string; revision: string; mode: SelectionMode; keep: SelectedRequest | null; offset: number;
  loading: boolean; unavailable: boolean; overviewPending: boolean;
};
type RouteRetry = { route: RequestSelectionRoute; revision: string; connected: number };

const REQUEST_NUMBER = /^[1-9]\d{0,15}$/u;
const RECENT_WRITES = 8;
/** URL write-back waits for a drag or repeated key steps to settle, so one gesture writes once. */
const ROUTE_WRITE_SETTLE_MS = 300;

function historyScope(scope: string, agents: Agent[]): string {
  if (scope === "all") return "all";
  const primary = agents.find((agent) => agent.parentId === null)?.id;
  return scope === primary ? "primary" : scope;
}

function pageKey(sessionId: string, scope: string, size: number) {
  return `${sessionId}:${scope}:${size}`;
}

function routeKey(route: RequestSelectionRoute) {
  return JSON.stringify([route.agent, route.request]);
}

/** The refreshed page still holds the selected request at its recorded absolute position. */
function keepsSelection(page: RequestHistoryPage, keep: SelectedRequest) {
  return page.items[keep.index - page.offset]?.id === keep.id;
}

function isRequestPage(value: unknown): value is RequestHistoryPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<RequestHistoryPage>;
  return page.kind === "requests" && (page.status === "ready" || page.status === "loading" || page.status === "unavailable") && Array.isArray(page.items);
}

/** One selection for the chart, its evidence links, and the activity feed. */
export function useSessionRequestSelection({ agents, requestSnapshots, contextBoundaries, historical, cacheEvents, cacheReadDrops, sessionId = "", historyEnabled = false, route, onRouteChange }: SessionRequestInputs) {
  const phone = usePhoneLayout();
  const size = phone ? 20 : 60;
  const [preference, setPreference] = useState({ sessionId, scope: "all" });
  const scope = preference.sessionId === sessionId ? preference.scope : "all";
  const resolvedScope = scope === "all" || agents.some((agent) => agent.id === scope) ? scope : "all";
  const key = pageKey(sessionId, resolvedScope, size);
  const [history, setHistory] = useState<HistoryState>({ key, page: null, loading: false, unavailable: false, retryable: false });
  const page = historyEnabled && history.key === key ? history.page : null;
  const pageCache = useRequestPageCache(key, sessionId, historyScope(resolvedScope, agents), page);
  const request = useRef<{ controller: AbortController; serial: number; refresh: boolean } | null>(null);
  const serial = useRef(0);
  const requestedKey = useRef("");
  const lastQuery = useRef<{ key: string; options: HistoryQuery } | null>(null);
  const interrupted = useRef<HistoryQuery | null>(null);
  const [pendingLocate, setPendingLocate] = useState<PendingLocate>(null);
  const [pendingPageSelection, setPendingPageSelection] = useState<PendingPageSelection>(null);
  const [workKind, setWorkKind] = useState<WorkKind | null>(null);
  const [retry, setRetry] = useState(0);
  const queuedPublication = useRef<{ revision: number } | null>(null);
  const hiddenPublication = useRef(false);
  const publication = useRef<Publication>({ committedKey: "", revision: "", mode: "follow", keep: null, offset: 0, loading: false, unavailable: false, overviewPending: false });
  const loadHistoryRef = useRef<(options?: HistoryQuery) => Promise<RequestHistoryPage | null>>(() => Promise.resolve(null));
  const reconnecting = useRef(true);
  const connectedCount = useRef(0);
  const [transportVersion, setTransportVersion] = useState(0);
  // URL write-back happens only after user actions (and explicit unresolved/absent corrections).
  const [writeRequest, setWriteRequest] = useState(0);
  const handledWrite = useRef(0);
  const recentWrites = useRef<string[]>([]);
  const handledRoute = useRef<string | null>(null);
  const routeRef = useRef(route);
  const onRouteChangeRef = useRef(onRouteChange);
  const [routeResolving, setRouteResolving] = useState(false);
  const routeLookup = useRef<AbortController | null>(null);
  const routeRetry = useRef<RouteRetry | null>(null);
  const applyRouteRef = useRef<(next: RequestSelectionRoute) => void>(() => {});
  const routeActions = useRef<{ locateIn: (id: string, targetScope: string | null, options: { pin: boolean; route: boolean }) => void; jumpToLatestIn: (targetScope: string) => void }>({ locateIn: () => {}, jumpToLatestIn: () => {} });
  /** A user action (or a proven route correction) supersedes any deep-link retry and writes back once settled. */
  const requestWrite = () => {
    routeRetry.current = null;
    setWriteRequest((value) => value + 1);
  };
  const hydrating = (current: Publication) => current.loading || current.committedKey !== requestedKey.current || current.overviewPending;

  const loadHistory = useCallback((options: HistoryQuery = {}): Promise<RequestHistoryPage | null> => {
    if (!historyEnabled || !sessionId) return Promise.resolve(null);
    const nextScope = options.scope ?? resolvedScope;
    const nextKey = pageKey(sessionId, nextScope, size);
    const query = { ...options, scope: nextScope };
    requestedKey.current = nextKey;
    lastQuery.current = { key: nextKey, options: query };
    request.current?.controller.abort();
    const requestSerial = ++serial.current;
    const requestedOffset = typeof options.offset === "number" ? options.offset : undefined;
    const commit = (value: RequestHistoryPage, fetched: boolean) => {
      if (fetched && nextKey === key) pageCache.add(value);
      setHistory({ key: nextKey, page: value, loading: false, unavailable: false, retryable: false });
      const current = publication.current;
      const previous = current.committedKey === nextKey ? current : { mode: "follow" as const, keep: null };
      publication.current = {
        ...selectionAfterCommit({
          ids: value.items.map((item) => item.id), offset: value.offset, total: value.total, size, historical, previous,
          target: { select: query.select, requestId: query.requestId, pin: query.pin, keep: query.keep, absentToLatest: Boolean(query.keep || query.route) },
        }),
        committedKey: nextKey, revision: value.revision, loading: false, unavailable: false,
        overviewPending: value.total > 0 && !isCompleteRequestOverview(value.overview, value.total),
      };
    };
    const fail = (loading: boolean) => {
      publication.current = { ...publication.current, loading, unavailable: !loading };
      setHistory((current) => ({ key: nextKey, page: current.key === nextKey ? current.page : null, loading, unavailable: !loading, retryable: true, requestedOffset: loading ? requestedOffset : undefined }));
    };
    const cached = nextKey === key
      ? options.requestId ? pageCache.locate(options.requestId, size)
        : requestedOffset !== undefined ? pageCache.window(requestedOffset, size) : null
      : null;
    if (cached && !options.refresh && (!options.keep || keepsSelection(cached, options.keep))) {
      request.current = null;
      commit(cached, false);
      return Promise.resolve(cached);
    }
    const controller = new AbortController();
    request.current = { controller, serial: requestSerial, refresh: Boolean(options.refresh) };
    publication.current = { ...publication.current, loading: true, unavailable: false };
    setHistory((current) => ({ key: nextKey, page: current.key === nextKey ? current.page : null, loading: true, unavailable: false, retryable: false, requestedOffset }));
    const params = new URLSearchParams({ sessionId, kind: "requests", scope: historyScope(nextScope, agents), limit: String(size), offset: String(options.offset ?? "latest") });
    if (options.requestId) params.set("requestId", options.requestId);
    return fetch(`/api/session-history?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        // Navigation and range queries cannot carry a page-level revision: the
        // monitor's revision is domain-wide, not a proof this exact query is
        // resident. Cached exact windows return before fetch above.
        if (response.status === 204) return null;
        if (!response.ok) return null;
        return response.json();
      })
      .then((value: unknown) => {
        if (controller.signal.aborted || requestSerial !== serial.current) {
          return null;
        }
        if (!isRequestPage(value)) {
          fail(false);
          return null;
        }
        if (value.status !== "ready") {
          fail(value.status === "loading");
          return null;
        }
        const keep = options.keep;
        if (keep && options.track) {
          // Growth that would push the selected bar out anchors it at the left edge instead;
          // fetch that window before committing anything.
          const next = advanceOnGrowth({ total: value.total, size, selectedIndex: keep.index, mode: "track" });
          if (next.mode === "anchored" && next.offset !== null && next.offset !== value.offset) {
            return loadHistoryRef.current({ ...options, offset: next.offset, track: false });
          }
        }
        if (keep && !options.requestId && !keepsSelection(value, keep)) {
          // Never keep a detail at a false position: verify the bar by position, else locate it by identity.
          return loadHistoryRef.current({ scope: nextScope, requestId: keep.id, keep, refresh: true });
        }
        if (options.requestId && !value.items.some((item) => item.id === options.requestId)) {
          setPendingLocate(null);
          if (keep || options.route) {
            // Absent from this scope: follow the latest request and clear the URL request.
            setPendingPageSelection({ key: nextKey, offset: "latest", index: "latest" });
            requestWrite();
          }
        }
        commit(value, true);
        return value;
      })
      .catch(() => {
        if (!controller.signal.aborted && requestSerial === serial.current) fail(false);
        return null;
      })
      .finally(() => {
        if (request.current?.serial !== requestSerial) return;
        request.current = null;
        if (controller.signal.aborted || !queuedPublication.current) return;
        queuedPublication.current = null;
        // A revision can arrive while a navigation or refresh is resolving. Re-read once with the
        // selection that commit just produced, so totals advance without undoing that navigation.
        const queued = historical
          ? (lastQuery.current?.key === nextKey ? { ...lastQuery.current.options, refresh: true } : { offset: "latest" as const, refresh: true })
          : refreshQuery();
        void loadHistoryRef.current(queued);
      });
  }, [agents, historical, historyEnabled, key, pageCache, resolvedScope, sessionId, size]);
  useEffect(() => { loadHistoryRef.current = loadHistory; }, [loadHistory]);

  useEffect(() => {
    // An interrupted read (StrictMode or offscreen remount) is resumed by the effect below instead.
    if (!historyEnabled || interrupted.current) return;
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

  useEffect(() => {
    // Unmounting aborts in-flight reads. A remount of the same instance (StrictMode replay or an
    // offscreen boundary) resumes the interrupted history read and replays an interrupted route
    // lookup through the route effect, so no deep link or navigation is stranded.
    const resume = interrupted.current;
    interrupted.current = null;
    if (resume) void loadHistoryRef.current(resume);
    return () => {
      const active = request.current;
      if (active) {
        interrupted.current = lastQuery.current?.options ?? {};
        active.controller.abort();
        request.current = null;
        requestedKey.current = "";
      }
      if (routeLookup.current) {
        routeLookup.current.abort();
        routeLookup.current = null;
        handledRoute.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!historyEnabled || history.key !== key || !history.retryable) return;
    if (historical) return;
    const timer = window.setTimeout(() => {
      requestedKey.current = "";
      setRetry((value) => value + 1);
    }, document.hidden ? 30_000 : history.unavailable ? 5_000 : 1_000);
    return () => window.clearTimeout(timer);
  }, [historical, history.unavailable, history.key, history.retryable, historyEnabled, key]);

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
  const locateTarget = pendingLocate?.scope === resolvedScope ? pendingLocate : null;
  const atLatest = !page || page.offset + page.items.length >= page.total;
  const selection = useRequestSelection(rows, scopeKey(resolvedScope), size, historical, atLatest);
  // A summary preview cannot establish whether the linked request is newest.
  const locatedRow = locateTarget && page ? rows.find((row) => row.id === locateTarget.id) : null;
  if (locateTarget && locatedRow) {
    selection.select(locatedRow, true, locateTarget.pin);
    setPendingLocate(null);
  }
  if (pendingPageSelection?.key === key && page && (pendingPageSelection.offset === "latest" ? atLatest : page.offset === pendingPageSelection.offset)) {
    // Window navigation transfers to an explicit visible index; keyboard and range steps have explicit targets.
    const index = pendingPageSelection.index;
    const target = index === null ? selection.selected : index === "latest" ? rows.at(-1) : rows[index - page.offset];
    if (target) selection.select(target, true);
    setPendingPageSelection(null);
  }

  const pageOffset = page?.offset ?? 0;
  const total = page ? page.total : rows.length;
  const viewportOffset = pageOffset + selection.start - 1;
  const selectedIndex = selection.selected ? pageOffset + selection.selected.ordinal - 1 : null;
  const selectedNumber = typeof selection.selected?.number === "number" ? selection.selected.number : null;
  const mode: SelectionMode = selectedIndex === null ? "follow" : modeFor({
    selectedIndex, offset: viewportOffset, size, total,
    explicitLatest: historical ? selectedIndex >= total - 1 : !selection.pinned,
  });
  const pending = historyEnabled && (routeResolving || (history.loading && (pendingPageSelection?.key === key || pendingLocate !== null)));

  /** Live refresh by mode: follow reads latest; track reads latest and anchors before commit; anchored rereads its window. */
  function refreshQuery(): HistoryQuery {
    const current = publication.current;
    if (current.mode === "anchored" && current.keep) return { offset: current.offset, refresh: true, keep: current.keep };
    if (current.mode === "track" && current.keep) return { offset: "latest", refresh: true, keep: current.keep, track: true };
    return { offset: "latest", refresh: true };
  }

  useEffect(() => {
    if (!historyEnabled) return;
    return subscribeLiveEvents((event) => {
      if (event.type === "connection") {
        reconnecting.current = event.state === "reconnecting";
        if (event.state === "connected") connectedCount.current += 1;
        setTransportVersion((value) => value + 1);
        if (event.state === "connected" && historical && hydrating(publication.current) && !request.current) void loadHistoryRef.current({ offset: "latest" });
        return;
      }
      if (event.domain !== "history" || event.sessionId !== sessionId) return;
      if (document.hidden) {
        hiddenPublication.current = true;
        return;
      }
      const { revision } = event;
      const current = publication.current;
      // Recorded sessions do not follow settled revisions, but their first
      // history page may still be waiting for an asynchronous commit.
      if (historical) {
        if (!hydrating(current) && !current.unavailable) return;
        if (request.current) {
          if (!queuedPublication.current || revision >= queuedPublication.current.revision) queuedPublication.current = { revision };
          return;
        }
        void loadHistoryRef.current({ offset: "latest" });
        return;
      }
      if (current.loading || request.current) {
        if (!queuedPublication.current || revision >= queuedPublication.current.revision) queuedPublication.current = { revision };
        return;
      }
      // An anchored window retains its selection while its committed revision and
      // minimap overview advance; it must not suppress new history evidence.
      void loadHistoryRef.current(refreshQuery());
    });
  }, [historical, historyEnabled, sessionId]);

  useEffect(() => {
    if (!historyEnabled) return;
    const foreground = () => {
      if (document.hidden) return;
      if (request.current) {
        if (hiddenPublication.current && !queuedPublication.current) queuedPublication.current = { revision: Number.MAX_SAFE_INTEGER };
        return;
      }
      hiddenPublication.current = false;
      void loadHistoryRef.current(refreshQuery());
    };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [historyEnabled]);

  useEffect(() => {
    if (!historyEnabled || historical || history.loading) return;
    const delay = document.hidden ? 30_000 : reconnecting.current ? 5_000 : 30_000;
    const timer = window.setTimeout(() => {
      if (request.current) return;
      void loadHistoryRef.current(refreshQuery());
    }, delay);
    return () => window.clearTimeout(timer);
  }, [historical, history.loading, history.key, historyEnabled, transportVersion]);

  /** Scope changes clear the kind filter: the new scope's kinds may not include it. */
  const setPreferredScope = (value: string) => {
    if (value !== resolvedScope) setWorkKind(null);
    setPreference({ sessionId, scope: value });
  };
  const cancelHistoryNavigation = () => {
    routeLookup.current?.abort();
    routeLookup.current = null;
    if (routeResolving) setRouteResolving(false);
    if (!pendingLocate && !pendingPageSelection) return;
    request.current?.controller.abort();
    request.current = null;
    serial.current += 1;
    publication.current = { ...publication.current, loading: false, unavailable: false };
    setPendingLocate(null);
    setPendingPageSelection(null);
    setHistory((current) => ({ ...current, loading: false, retryable: false, unavailable: false, requestedOffset: undefined }));
  };
  /** A user selection updates refresh inputs at once and supersedes an in-flight or queued refresh. */
  const selectRow = (row: RequestRow, center: boolean, pin = false) => {
    selection.select(row, center, pin);
    if (!page) return;
    const index = page.offset + row.ordinal - 1;
    const explicitLatest = historical ? index >= page.total - 1 : !pin && atLatest && row.id === rows.at(-1)?.id;
    publication.current = {
      ...publication.current, keep: { id: row.id, index }, offset: page.offset,
      mode: modeFor({ selectedIndex: index, offset: page.offset, size, total: page.total, explicitLatest }),
    };
    if (historical || !(request.current?.refresh || (!request.current && queuedPublication.current))) return;
    queuedPublication.current = null;
    void loadHistory(refreshQuery());
  };
  /** A null target scope keeps a visible row in the current scope and otherwise looks it up across all agents. */
  const locateIn = (id: string, targetScope: string | null, options: { pin: boolean; route: boolean }) => {
    cancelHistoryNavigation();
    const row = targetScope === null || targetScope === resolvedScope ? rows.find((item) => item.id === id) : null;
    if (row && (!historyEnabled || page)) return selectRow(row, true, options.pin);
    const lookupScope = targetScope ?? "all";
    if (!historyEnabled) {
      const allRows = scopedRows(requestSnapshots, contextBoundaries, "all", cacheEvents, cacheReadDrops);
      const allRow = allRows.find((item) => item.id === id);
      if (!allRow) return;
      setPreferredScope("all");
      return selection.selectScope(allRows, scopeKey("all"), allRow);
    }
    setPendingLocate({ id, scope: lookupScope, pin: options.pin });
    setPreferredScope(lookupScope);
    void loadHistory({ scope: lookupScope, requestId: id, route: options.route, pin: options.pin });
  };
  const select = (row: RequestRow, center = false) => {
    requestWrite();
    if (historyEnabled && !page) return locateIn(row.id, null, { pin: false, route: false });
    cancelHistoryNavigation();
    selectRow(row, center);
  };
  /** Select a request by opaque id, within the target scope when given (a feed header), else across all agents. */
  const locate = (id: string, targetScope?: string) => {
    requestWrite();
    locateIn(id, targetScope ?? null, { pin: false, route: false });
  };
  const selectScope = (nextRows: RequestRow[], nextScope: string, row: RequestRow) => {
    cancelHistoryNavigation();
    requestWrite();
    setPreferredScope(nextScope);
    selection.selectScope(nextRows, scopeKey(nextScope), row);
  };
  const moveHistoryWindow = (start: number) => {
    if (!page || !Number.isFinite(start)) return;
    const offset = Math.max(0, Math.min(Math.round(start) - 1, Math.max(0, page.total - size)));
    if (offset === (history.requestedOffset ?? page.offset)) return;
    requestWrite();
    routeLookup.current?.abort();
    routeLookup.current = null;
    if (routeResolving) setRouteResolving(false);
    setPendingLocate(null);
    // Dragging away transfers the selection to the nearest visible bar of the new window.
    const index = selectedIndex === null ? null : transferOnViewportMove({ selectedIndex, offset, size });
    setPendingPageSelection({ key, offset, index });
    void loadHistory(index === null ? { offset } : { offset, select: index });
  };
  const moveWindow = (start: number) => {
    requestWrite();
    selection.moveWindow(start);
  };
  const stepBy = (delta: number) => {
    cancelHistoryNavigation();
    requestWrite();
    if (!historyEnabled || !page || !selection.selected || selectedIndex === null) return selection.step(delta);
    const target = stepTarget({ selectedIndex, delta, total: page.total, offset: viewportOffset, size });
    if (target.offset === null) {
      const row = rows[target.index - page.offset];
      if (row && row.id !== selection.selected.id) selectRow(row, false);
      return;
    }
    setPendingPageSelection({ key, offset: target.offset, index: target.index });
    void loadHistory({ offset: target.offset, select: target.index });
  };
  const jumpToLatestIn = (targetScope: string) => {
    cancelHistoryNavigation();
    requestWrite();
    if (targetScope === resolvedScope && (!historyEnabled || (page && atLatest && !history.loading))) {
      const latestRow = rows.at(-1);
      if (latestRow) selectRow(latestRow, true);
      return;
    }
    if (!historyEnabled) return;
    setPreferredScope(targetScope);
    setPendingPageSelection({ key: pageKey(sessionId, targetScope, size), offset: "latest", index: "latest" });
    void loadHistory({ offset: "latest", scope: targetScope, select: "latest" });
  };
  const jumpToLatest = () => jumpToLatestIn(resolvedScope);
  const setScope = (value: string) => {
    requestWrite();
    const current = selection.selected;
    if (historyEnabled && page && current && mode !== "follow" && (value === "all" || current.agentId === value)) {
      // The selected request belongs to the new scope: locate it there and keep its mode.
      return locateIn(current.id, value, { pin: true, route: false });
    }
    cancelHistoryNavigation();
    setPreferredScope(value);
  };

  const resolveRequestNumber = (next: RequestSelectionRoute, number: number, targetScope: string) => {
    routeLookup.current?.abort();
    const controller = new AbortController();
    routeLookup.current = controller;
    routeRetry.current = null;
    setRouteResolving(true);
    const params = new URLSearchParams({ sessionId, kind: "activity", scope: historyScope(targetScope, agents), offset: "latest", limit: "1", selected: String(number) });
    const settle = () => {
      if (routeLookup.current === controller) routeLookup.current = null;
      setRouteResolving(false);
    };
    // Only a ready grouped response proves the number absent. Hydration, HTTP and network failures
    // keep the deep link and retry on the next committed request-page revision or reconnect.
    const retryLater = () => {
      settle();
      routeRetry.current = { route: next, revision: publication.current.revision, connected: connectedCount.current };
    };
    fetch(`/api/session-history?${params}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok && response.status !== 204 ? response.json() : null)
      .then((value: unknown) => {
        if (controller.signal.aborted) return;
        const feed = parseActivityFeedPage(value);
        if (feed?.status !== "ready") return retryLater();
        settle();
        const id = feed.groups.find((group) => group.request.number === number)?.request.id;
        if (!id) return routeActions.current.jumpToLatestIn(targetScope);
        requestWrite();
        routeActions.current.locateIn(id, targetScope, { pin: true, route: true });
      })
      .catch(() => { if (!controller.signal.aborted) retryLater(); });
  };
  const applyRoute = (next: RequestSelectionRoute) => {
    const known = next.agent === null || agents.some((agent) => agent.id === next.agent);
    const targetScope = next.agent !== null && known ? next.agent : "all";
    if (!known) writeRoute({ agent: null, request: next.request });
    routeRetry.current = null;
    if (next.request === null) {
      if (targetScope !== resolvedScope) {
        cancelHistoryNavigation();
        setPreferredScope(targetScope);
      } else if (mode !== "follow" && page) jumpToLatestIn(targetScope);
      return;
    }
    if (REQUEST_NUMBER.test(next.request)) {
      if (!historyEnabled) return;
      if (targetScope !== resolvedScope) setPreferredScope(targetScope);
      return resolveRequestNumber(next, Number(next.request), targetScope);
    }
    requestWrite();
    locateIn(next.request, targetScope, { pin: true, route: true });
  };
  useEffect(() => {
    applyRouteRef.current = applyRoute;
    routeActions.current = { locateIn, jumpToLatestIn };
    routeRef.current = route;
    onRouteChangeRef.current = onRouteChange;
  });

  function writeRoute(next: RequestSelectionRoute) {
    const write = onRouteChangeRef.current;
    if (!write) return;
    const value = routeKey(next);
    recentWrites.current = [...recentWrites.current.filter((item) => item !== value), value].slice(-RECENT_WRITES);
    write(next);
  }

  const routeAgent = route?.agent ?? null;
  const routeRequest = route?.request ?? null;
  const hasRoute = Boolean(route);
  useEffect(() => {
    if (!hasRoute) return;
    const next = { agent: routeAgent, request: routeRequest };
    const value = routeKey(next);
    if (handledRoute.current === value) return;
    const initial = handledRoute.current === null;
    handledRoute.current = value;
    // A route this hook wrote is already reflected in the selection (no write/read loop).
    if (recentWrites.current.includes(value)) return;
    if (initial && next.agent === null && next.request === null) return;
    applyRouteRef.current(next);
  }, [hasRoute, routeAgent, routeRequest]);

  // An unresolved route request retries once per newly committed request-page revision or reconnect.
  const pageRevision = page?.revision ?? "";
  useEffect(() => {
    const pendingRetry = routeRetry.current;
    if (!pendingRetry || !pageRevision || routeResolving || pendingLocate) return;
    if (pendingRetry.revision === pageRevision && pendingRetry.connected === connectedCount.current) return;
    applyRouteRef.current(pendingRetry.route);
  }, [pageRevision, pendingLocate, routeResolving, transportVersion]);

  const desiredAgent = resolvedScope === "all" ? null : resolvedScope;
  const desiredRequest = mode === "follow" || selectedNumber === null ? null : String(selectedNumber);
  const canWrite = Boolean(onRouteChange) && hasRoute;
  useEffect(() => {
    if (!canWrite || writeRequest === handledWrite.current || pending || pendingLocate || preview) return;
    const timer = window.setTimeout(() => {
      handledWrite.current = writeRequest;
      const current = routeRef.current;
      if (!current || (desiredAgent === current.agent && desiredRequest === current.request)) return;
      writeRoute({ agent: desiredAgent, request: desiredRequest });
    }, ROUTE_WRITE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [canWrite, desiredAgent, desiredRequest, pending, pendingLocate, preview, writeRequest]);

  // Legacy paging transfers the selection like any other viewport move.
  const older = () => { if (page && !history.loading && page.offset > 0) moveHistoryWindow(Math.max(0, page.offset - size) + 1); };
  const newer = () => { if (page && !history.loading && page.offset + page.items.length < page.total) moveHistoryWindow(page.offset + size + 1); };
  const first = () => moveHistoryWindow(1);
  const latest = () => { if (page) moveHistoryWindow(page.total - size + 1); };
  return {
    ...selection, select, step: stepBy, selectScope, rows, allRows, agents, scope: resolvedScope, setScope, phone, size, locate,
    moveWindow,
    mode, selectedNumber, selectedIndex, workKind, setWorkKind,
    /** The value to send as the history `scope` parameter. */
    historyScope: historyScope(resolvedScope, agents),
    pending,
    previousRange: () => stepBy(-5),
    nextRange: () => stepBy(5),
    jumpToLatest,
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
