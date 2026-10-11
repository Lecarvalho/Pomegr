import type { AgentRole, ProviderSource, Readiness, WorkKind } from "./monitor-contract";

// A bounded run summary derived only from a retained normalized session snapshot.
export type AgentsRun = {
  id: string;
  agentId: string;
  sessionId: string;
  source: ProviderSource;
  project: string;
  sessionTitle: string;
  label: string;
  assignment: string | null;
  role: AgentRole;
  // Bounded provider type label retained only for an otherwise unknown role.
  customType?: string | null;
  // Latest retained agent-level model report; it is not a whole-run history.
  model: string | null;
  modelEvidence: "latest_reported" | "unavailable";
  scope: "main" | "delegated";
  parentId: string | null;
  depth: number;
  status: "active" | "waiting" | "needs_input" | "warm" | "finished" | "stopped" | "idle" | "unknown";
  startedAt: string | null;
  lastSeen: string | null;
  // Latest normalized agent context snapshot, never cumulative throughput.
  latestContextTotal: number | null;
  toolCalls: number | null;
  executionTaskCount: number | null;
  // Only normalized execution-task work kinds attributable to this agent.
  work: Array<{ workKind: WorkKind; count: number }>;
};

export type AgentsCoverage = {
  retainedSessions: number;
  eligibleSessions: number;
  missingSessions: number;
  retainedRuns: number;
  truncated: boolean;
  earliestStartedAt: string | null;
};

export type AgentsModelAggregate = {
  model: string | null;
  runCount: number;
  mainRunCount: number;
  delegatedRunCount: number;
  roles: Array<{ role: AgentRole; runCount: number }>;
};

export type AgentsAnalyticsSnapshot = {
  revision: number;
  readiness: Readiness;
  refreshReadiness?: "ready" | "unavailable";
  generatedAt: string | null;
  coverage: AgentsCoverage;
  filters: {
    project: string | "all";
    days: 7 | 30 | 90;
    scope: "all" | "main" | "delegated";
    projects: string[];
  };
  summary: {
    runCount: number;
    sessionCount: number;
    modelCount: number;
    mainRunCount: number;
    delegatedRunCount: number;
  };
  models: AgentsModelAggregate[];
  // Attributable normalized execution-task work only; absent evidence is omitted.
  work: Array<{ workKind: WorkKind; count: number }>;
  runs: AgentsRun[];
  roster: AgentsRun[];
};
