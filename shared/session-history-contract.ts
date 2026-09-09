import type { Activity, RequestSnapshot } from "./monitor-contract";

/** Public normalized history pages; source identities and content stay private. */
export type HistoryActivity = Activity & { agentId: string | null; requestNumber: number | null };
export type HistoryRequest = RequestSnapshot & { number: number };
type HistoryPageBase = {
  status: "ready" | "loading" | "unavailable";
  revision: string;
  total: number;
  offset: number;
  linkedCount: number;
};
export type ActivityHistoryPage = HistoryPageBase & { kind: "activity"; items: HistoryActivity[] };
export type RequestHistoryPage = HistoryPageBase & { kind: "requests"; items: HistoryRequest[] };
export type SessionHistoryPage = ActivityHistoryPage | RequestHistoryPage;
