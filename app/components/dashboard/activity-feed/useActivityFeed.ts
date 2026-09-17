import { useEffect, useRef, useState } from "react";
import type { ActivityFeed, WorkKind } from "../../../../shared/monitor-contract";
import type { ActivityRequestGroup, HistoryActivity } from "../../../../shared/session-history-contract";
import { mergeCalls, parseActivityFeedPage, type ActivityFeedPage } from "./feed-model";

export type ActivityFeedQuery = {
  sessionId: string;
  /** History scope: `all`, `primary`, or a normalized agent id. */
  scope: string;
  /** Null only while selection follows latest without a stable number. */
  selected: number | null;
  workKind: WorkKind | null;
};

export type ActivityFeedView = {
  status: "idle" | "loading" | "ready" | "unavailable";
  /** The shown groups were fetched for exactly the current query and request-page revision. */
  correlated: boolean;
  /** Continuation calls merged in, deduped by call id, chronological. */
  groups: ActivityRequestGroup[];
  byKind: ActivityFeed["byKind"];
  shellTasks: { total: number; failed: number };
  requestTotal: number;
  callTotal: number;
  revision: string;
  loadMore: (requestNumber: number) => void;
  loadingMore: number | null;
  retry: () => void;
};

type Body = { queryKey: string; scopeKey: string; historyRevision: string; page: ActivityFeedPage };
type Failure = { queryKey: string; historyRevision: string; retry: number; status: "loading" | "unavailable" };
type More = { queryKey: string; revision: string; groups: Record<number, { calls: HistoryActivity[]; continuation: ActivityRequestGroup["continuation"] }> };

const EMPTY_SHELL = { total: 0, failed: 0 };

function feedParams(query: ActivityFeedQuery) {
  const params = new URLSearchParams({ sessionId: query.sessionId, kind: "activity", scope: query.scope, offset: "latest", limit: "1" });
  if (query.selected !== null) params.set("selected", String(query.selected));
  if (query.workKind) params.set("workKind", query.workKind);
  return params;
}

/**
 * Five request groups around the shared selection. There is no own event subscription or timer:
 * a changed request-page revision (already SSE-primary with its fallbacks) revalidates the exact
 * query, and a historical session fetches once per query.
 */
export function useActivityFeed({ enabled, query, historyRevision }: { enabled: boolean; query: ActivityFeedQuery; historyRevision: string }): ActivityFeedView {
  const { sessionId, scope, selected, workKind } = query;
  const queryKey = JSON.stringify([sessionId, scope, selected, workKind]);
  // The selected number only slides the five-group window, so a retained body still describes the
  // right requests while the next page loads. Scope and kind change which requests exist at all,
  // and the feed is disabled while the chart previews, so a body from another scope would sit
  // there unlabelled until history recovered. It is dropped instead.
  const scopeKey = JSON.stringify([sessionId, scope, workKind]);
  const [body, setBody] = useState<Body | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [more, setMore] = useState<More | null>(null);
  const [loadingMore, setLoadingMore] = useState<{ queryKey: string; number: number } | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const bodyRef = useRef<Body | null>(null);
  const failureRef = useRef<Failure | null>(null);
  const serial = useRef(0);
  const moreRequest = useRef<{ controller: AbortController; number: number } | null>(null);
  const interruptedMore = useRef<number | null>(null);
  const loadMoreRef = useRef<(requestNumber: number) => void>(() => {});

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const retained = bodyRef.current;
    const sameQuery = retained?.queryKey === queryKey;
    if (sameQuery && retained.historyRevision === historyRevision) return;
    const failed = failureRef.current;
    if (failed && failed.queryKey === queryKey && failed.historyRevision === historyRevision && failed.retry === retryVersion) return;
    const requestSerial = ++serial.current;
    const controller = new AbortController();
    const current = (): boolean => !controller.signal.aborted && requestSerial === serial.current;
    const fail = (status: Failure["status"]) => {
      const next = { queryKey, historyRevision, retry: retryVersion, status };
      failureRef.current = next;
      setFailure(next);
    };
    const params = feedParams({ sessionId, scope, selected, workKind });
    // Only an exact retained query may ask for a bodyless unchanged-revision response.
    if (sameQuery && retained.page.revision) params.set("revision", retained.page.revision);
    fetch(`/api/session-history?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!current()) return;
        if (response.status === 204) {
          if (!sameQuery) return fail("unavailable");
          const next = { ...retained, historyRevision };
          bodyRef.current = next;
          failureRef.current = null;
          setBody(next);
          setFailure(null);
          return;
        }
        const page = response.ok ? parseActivityFeedPage(await response.json()) : null;
        if (!current()) return;
        if (!page || page.status !== "ready") return fail(page?.status === "loading" ? "loading" : "unavailable");
        failureRef.current = null;
        const next = { queryKey, scopeKey, historyRevision, page };
        bodyRef.current = next;
        setBody(next);
        setFailure(null);
      })
      .catch(() => { if (current()) fail("unavailable"); });
    return () => controller.abort();
  }, [enabled, historyRevision, queryKey, retryVersion, scope, scopeKey, selected, sessionId, workKind]);

  const shown = body && body.scopeKey === scopeKey ? body : null;
  const current = shown?.queryKey === queryKey;
  const correlated = enabled && current && shown.historyRevision === historyRevision;
  const failed = failure && failure.queryKey === queryKey && failure.historyRevision === historyRevision ? failure.status : null;
  const status: ActivityFeedView["status"] = !enabled ? "idle" : failed ?? (correlated ? "ready" : "loading");
  // Merged continuation calls belong to one query and one served revision only.
  const merged = shown && more && more.queryKey === shown.queryKey && more.revision === shown.page.revision ? more.groups : null;
  const groups = shown ? shown.page.groups.map((group) => {
    const extra = merged?.[group.request.number];
    return extra ? { ...group, calls: extra.calls, continuation: extra.continuation } : group;
  }) : [];

  const loadMore = (requestNumber: number) => {
    const retained = bodyRef.current;
    if (!enabled || !retained || retained.queryKey !== queryKey) return;
    const group = groups.find((item) => item.request.number === requestNumber);
    if (!group?.continuation) return;
    moreRequest.current?.controller.abort();
    const controller = new AbortController();
    moreRequest.current = { controller, number: requestNumber };
    setLoadingMore({ queryKey, number: requestNumber });
    const params = feedParams({ sessionId, scope, selected, workKind });
    params.set("continuation", group.continuation.cursor);
    const finish = () => {
      if (moreRequest.current?.controller !== controller) return;
      moreRequest.current = null;
      setLoadingMore(null);
    };
    fetch(`/api/session-history?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok && response.status !== 204 ? parseActivityFeedPage(await response.json()) : null)
      .then((page) => {
        if (controller.signal.aborted) return;
        const latest = bodyRef.current;
        const served = page?.status === "ready" ? page.groups.find((item) => item.request.number === requestNumber) : null;
        // A continuation from another revision or query would mix evidence; drop it.
        if (served && latest && latest.queryKey === queryKey && page?.revision === latest.page.revision) {
          setMore((previous) => {
            const base = previous && previous.queryKey === queryKey && previous.revision === latest.page.revision ? previous.groups : {};
            return { queryKey, revision: latest.page.revision, groups: { ...base, [requestNumber]: { calls: mergeCalls(group.calls, served.calls), continuation: served.continuation } } };
          });
        }
        finish();
      })
      .catch(() => { if (!controller.signal.aborted) finish(); });
  };

  useEffect(() => { loadMoreRef.current = loadMore; });
  useEffect(() => {
    // Unmounting aborts a continuation read; a remount of the same instance (StrictMode replay)
    // resumes it instead of leaving "Loading calls…" stranded.
    const resume = interruptedMore.current;
    interruptedMore.current = null;
    if (resume !== null) loadMoreRef.current(resume);
    return () => {
      const active = moreRequest.current;
      if (!active) return;
      interruptedMore.current = active.number;
      active.controller.abort();
      moreRequest.current = null;
    };
  }, []);

  return {
    status,
    correlated,
    groups,
    byKind: shown?.page.byKind ?? [],
    shellTasks: shown?.page.shellTasks ?? EMPTY_SHELL,
    requestTotal: shown?.page.requestTotal ?? 0,
    callTotal: shown?.page.callTotal ?? 0,
    revision: shown?.page.revision ?? "",
    loadMore,
    loadingMore: loadingMore?.queryKey === queryKey ? loadingMore.number : null,
    retry: () => setRetryVersion((value) => value + 1),
  };
}
