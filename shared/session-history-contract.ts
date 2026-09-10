import type { Activity, RequestSnapshot } from "./monitor-contract";

/** Public normalized history pages; source identities and content stay private. */
export type HistoryActivity = Activity & { agentId: string | null; requestNumber: number | null };
export type HistoryRequest = RequestSnapshot & { number: number };
/** One independent request per tuple, in scoped chronological order; never bucketed or summed across requests. */
export type RequestOverviewPoint = [uncachedInput: number, cacheWrite: number, cacheRead: number, output: number];
type HistoryPageBase = {
  status: "ready" | "loading" | "unavailable";
  revision: string;
  total: number;
  offset: number;
  linkedCount: number;
};
/** Oldest-first rows and offsets; latest selects the aligned final activity page. */
export type ActivityHistoryPage = HistoryPageBase & { kind: "activity"; items: HistoryActivity[] };
export type RequestHistoryPage = HistoryPageBase & {
  kind: "requests"; items: HistoryRequest[];
  /** Full scoped minimap at this page's revision; absent on older monitors/indexes. */
  overview?: RequestOverviewPoint[] | null;
};
export type SessionHistoryPage = ActivityHistoryPage | RequestHistoryPage;
