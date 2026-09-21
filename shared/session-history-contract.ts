import type { Activity, ActivityFeed, RequestSnapshot, WorkKind } from "./monitor-contract";

/** Public normalized history pages; source identities and content stay private. */
export type HistoryActivity = Activity & { agentId: string | null; requestNumber: number | null };
/**
 * `model` is the bounded model identifier recorded for this one request, or null when it was not
 * reported (including history committed before models were retained). History pages only: the
 * state request-snapshot feed, cache evidence and reports never carry it.
 */
export type HistoryRequest = RequestSnapshot & { number: number; model: string | null };
/** One independent request per tuple, in scoped chronological order; never bucketed or summed across requests. */
export type RequestOverviewPoint = [uncachedInput: number, cacheWrite: number, cacheRead: number, output: number];
type HistoryPageBase = {
  status: "ready" | "loading" | "unavailable";
  revision: string;
  total: number;
  offset: number;
  linkedCount: number;
};
export type ActivityRequestGroup = {
  request: HistoryRequest;
  calls: HistoryActivity[];
  /** True when the selected work-kind filter leaves this retained request header without calls. */
  noMatchingCalls: boolean;
  continuation: { cursor: string; remaining: number } | null;
};
/** Oldest-first rows and offsets; latest selects the aligned final activity page. */
export type ActivityHistoryPage = HistoryPageBase & {
  kind: "activity";
  items: HistoryActivity[];
  /** Present on T02 monitors; optional while older browser fixtures remain supported. */
  requestGroups?: ActivityRequestGroup[];
  range?: { from: number; to: number };
  requestTotal?: number;
  callTotal?: number;
  byKind?: ActivityFeed["byKind"];
  shellTasks?: { total: number; failed: number };
};
export type RequestHistoryPage = HistoryPageBase & {
  kind: "requests"; items: HistoryRequest[];
  /** Full scoped minimap at this page's revision; absent on older monitors/indexes. */
  overview?: RequestOverviewPoint[] | null;
};
export type SessionHistoryPage = ActivityHistoryPage | RequestHistoryPage;

export type ActivityHistoryQuery = {
  scope?: "all" | "primary" | "subagents" | string;
  from?: number;
  to?: number;
  selected?: number;
  workKind?: WorkKind;
  continuation?: string;
};
