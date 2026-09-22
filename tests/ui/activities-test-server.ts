import type { WorkKind } from "../../shared/monitor-contract";
import type { HistoryActivity, HistoryRequest } from "../../shared/session-history-contract";
import { snapshot } from "./requests-actions-test-fixtures";

/** A request with a stable session-wide number; agent ids are normalized ids only. */
export function historyRequest(number: number, agentId = "primary", model: string | null = "claude-opus-5"): HistoryRequest {
  return { ...snapshot(number, agentId), id: `request-${number}`, number, model };
}

export function historyCall(id: string, request: HistoryRequest | null, workKind: WorkKind, offsetSeconds: number, overrides: Partial<HistoryActivity> = {}): HistoryActivity {
  return {
    id, timestamp: new Date(Date.parse(request?.observedAt ?? "2026-08-09T12:00:00.000Z") + offsetSeconds * 1_000).toISOString(),
    actor: "Primary agent", tool: workKind === "read" ? "Read" : workKind === "shell" ? "Bash" : "Edit", workKind,
    detail: workKind === "shell" ? "Run the focused tests" : "app/components/dashboard/deep/file.tsx",
    status: null, durationMs: 1_500, requestId: request?.id ?? null, agentId: request?.agentId ?? "primary", requestNumber: request?.number ?? null,
    ...overrides,
  };
}

function matches(agentId: string | null, scope: string) {
  return scope === "all" || (scope === "primary" && agentId === "primary") || (scope === "subagents" && Boolean(agentId) && agentId !== "primary") || agentId === scope;
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * Serves `/api/session-history` like the monitor: scoped request pages (60 max, centered locate)
 * and five request groups around `selected` with bounded calls and opaque continuation cursors.
 */
export type HistoryServerState = {
  requests: HistoryRequest[]; calls: HistoryActivity[]; revision: string; callLimit?: number; extra?: Record<string, unknown>; overview?: boolean;
  /** Grouped activity answers: a hydrating body, an HTTP status failure or a network failure. */
  activity?: "loading" | "network" | number;
  /** Request-page (chart) answers: a hydrating body or an HTTP status failure, before any page ever loads. */
  requestsStatus?: "loading" | number;
  /** Per-request-number field overrides applied only to a group's own `request`, for exercising the
   * defensive "truly absent" token-count path without disturbing the chart's own request page. */
  requestGroupOverrides?: Record<number, Partial<HistoryRequest>>;
};

export function historyServer(state: HistoryServerState) {
  const calls: URLSearchParams[] = [];
  const deferred: Array<{ params: URLSearchParams; resolve: () => void }> = [];
  let hold: ((params: URLSearchParams) => boolean) | null = null;
  const respond = (params: URLSearchParams): Response => {
    if (params.get("revision") && params.get("revision") === state.revision) return new Response(null, { status: 204 });
    const scope = params.get("scope") || "all";
    const requests = state.requests.filter((item) => matches(item.agentId, scope));
    if (params.get("kind") === "requests") {
      if (state.requestsStatus === "loading") return json({ kind: "requests", status: "loading", revision: state.revision, total: 0, offset: 0, linkedCount: 0, items: [] });
      if (typeof state.requestsStatus === "number") return new Response(null, { status: state.requestsStatus });
      const total = requests.length;
      const limit = Math.min(60, Number(params.get("limit")) || 60);
      let offset = params.get("offset") === "latest" ? Math.max(0, total - limit) : Math.max(0, Number(params.get("offset")) || 0);
      const target = params.get("requestId");
      const index = target ? requests.findIndex((item) => item.id === target) : -1;
      if (index >= 0) offset = Math.max(0, index - Math.floor(limit / 2));
      offset = Math.min(offset, Math.max(0, total - 1));
      return json({ kind: "requests", status: "ready", revision: state.revision, total, offset, linkedCount: 0,
        items: requests.slice(offset, offset + limit),
        // Without an overview the browser has no complete map to preload, so navigation always fetches.
        ...(state.overview === false || params.get("overview") === "0" ? {} : { overview: requests.map((item) => [item.uncachedInputTokens, item.cacheWriteTokens, item.cacheReadTokens, item.outputTokens]) }) });
    }
    if (state.activity === "loading") return json({ kind: "activity", status: "loading", revision: state.revision, total: 0, offset: 0, linkedCount: 0, items: [] });
    if (typeof state.activity === "number") return new Response(null, { status: state.activity });
    const cursor = params.get("continuation")?.split(":").map(Number) ?? null;
    const selected = Number(params.get("selected")) || cursor?.[0] || null;
    const preferred = selected === null ? requests.length - 1 : requests.findIndex((item) => item.number === selected);
    const center = preferred < 0 ? requests.length - 1 : preferred;
    const start = Math.max(0, Math.min(center - 2, Math.max(0, requests.length - 5)));
    const headers = requests.slice(start, start + 5);
    const scopedCalls = state.calls.filter((item) => matches(item.agentId, scope));
    const limit = state.callLimit ?? 50;
    const requestGroups = headers.map((request) => {
      const matched = scopedCalls.filter((item) => item.requestId === request.id)
        .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id));
      const offset = cursor && cursor[0] === request.number ? cursor[1] : 0;
      const shown = matched.slice(offset, offset + limit);
      const remaining = matched.length - offset - shown.length;
      const override = state.requestGroupOverrides?.[request.number];
      return { request: override ? { ...request, ...override } : request, calls: shown.map((call) => ({ ...call, ...state.extra })), noMatchingCalls: matched.length === 0,
        continuation: remaining > 0 ? { cursor: `${request.number}:${offset + shown.length}`, remaining } : null };
    });
    const kinds = [...new Set(scopedCalls.map((item) => item.workKind))];
    return json({ kind: "activity", status: "ready", revision: state.revision, total: 0, offset: 0, linkedCount: 0, items: [],
      requestGroups, range: { from: headers[0]?.number ?? 0, to: headers.at(-1)?.number ?? 0 },
      requestTotal: requests.length, callTotal: requestGroups.reduce((sum, group) => sum + group.calls.length, 0),
      byKind: kinds.map((kind) => ({ kind, count: scopedCalls.filter((item) => item.workKind === kind).length, medianDurationMs: 1_500 })),
      shellTasks: { total: scopedCalls.filter((item) => item.workKind === "shell").length, failed: scopedCalls.filter((item) => item.workKind === "shell" && item.status === "failed").length } });
  };
  const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname !== "/api/session-history") return Promise.resolve(new Response(null, { status: 404 }));
    const params = url.searchParams;
    calls.push(params);
    if (params.get("kind") !== "requests" && state.activity === "network") return Promise.reject(new TypeError("Failed to fetch"));
    if (hold?.(params)) {
      return new Promise((resolve, reject) => {
        const entry = { params, resolve: () => resolve(respond(params)) };
        deferred.push(entry);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }
    return Promise.resolve(respond(params));
  };
  return {
    fetcher, calls, deferred,
    holdWhen(predicate: ((params: URLSearchParams) => boolean) | null) { hold = predicate; },
    /** Foreground queries only; background request-page preloads (overview=0) are excluded. */
    of(kind: "requests" | "activity") { return calls.filter((params) => params.get("kind") === kind && params.get("overview") !== "0"); },
  };
}
