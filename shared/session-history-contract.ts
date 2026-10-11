import type { Activity, ActivityFeed, RequestSnapshot } from "./monitor-contract";

// Public normalized history pages; source identities and content stay private.
export type HistoryActivity = Activity & { agentId: string | null; requestNumber: number | null };
export type HistoryRequest = RequestSnapshot & { number: number; model: string | null };
// One independent request per tuple, in scoped chronological order; never bucketed or summed across requests.
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
  noMatchingCalls: boolean;
  continuation: { cursor: string; remaining: number } | null;
};
export type ActivityHistoryPage = HistoryPageBase & {
  kind: "activity";
  items: HistoryActivity[];
  requestGroups?: ActivityRequestGroup[];
  range?: { from: number; to: number };
  requestTotal?: number;
  callTotal?: number;
  unassociatedTotal?: number;
  byKind?: ActivityFeed["byKind"];
  shellTasks?: { total: number; failed: number };
};
export type RequestHistoryPage = HistoryPageBase & {
  kind: "requests"; items: HistoryRequest[];
  overview?: RequestOverviewPoint[] | null;
};
export type SessionHistoryPage = ActivityHistoryPage | RequestHistoryPage;

export type ActivityHistoryQuery = {
  scope?: "all" | "primary" | "subagents" | string;
  from?: number;
  to?: number;
  selected?: number;
  continuation?: string;
};
