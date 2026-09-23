import type {
  ActivityFeed,
  Agent,
  CacheReadDropCount,
  CacheRefillCount,
  ContextHistoryBoundary,
  Insight,
  LoopPattern,
  MonitorState,
  Readiness,
  SessionActivityFallback,
  SessionActivityStatus,
  SessionCurrentActivity,
  SessionReadiness,
  ToolPattern,
  WorkKind,
  Workflow,
} from "./monitor-contract";
import type { RequestSnapshot, RequestSnapshotFeed } from "./request-snapshot-contract";

export const SESSION_DOMAINS = [
  "session-summary",
  "agents",
  "agent",
  "signals",
  "repository",
  "resources",
  "details",
] as const;

export type SessionDomain = (typeof SESSION_DOMAINS)[number];

export type SessionDomainBase = {
  domain: SessionDomain;
  sessionId: string;
  revision: number;
  readiness: Readiness;
  observedAt: string | null;
};

export type SessionDomainSectionReadiness<K extends keyof SessionReadiness> = Pick<SessionReadiness, K>;

export type SessionSummaryDomain = SessionDomainBase & {
  domain: "session-summary";
  source: MonitorState["source"];
  capabilities: MonitorState["capabilities"];
  view: MonitorState["view"];
  sectionReadiness: SessionDomainSectionReadiness<"core" | "agentEvidence" | "contextEvidence" | "activityEvidence" | "repository">;
  session: Pick<NonNullable<MonitorState["session"]>,
    "id" | "title" | "project" | "startedAt" | "updatedAt" | "durationMs" | "cost" | "summary" | "progress" | "pomegrPlugin"> | null;
  metrics: Pick<MonitorState["metrics"], "agents" | "activeAgents" | "toolCalls" | "repeatedCalls"> & {
    idleAgents: number | null;
    finishedAgents: number | null;
  };
  activity: Omit<ActivityFeed, "items">;
  allAgentContext: number;
  lifecycle: {
    isLive: boolean;
    needsInput: boolean;
    activityStatus: SessionActivityStatus;
    currentActivity: SessionCurrentActivity | null;
    activityFallback: SessionActivityFallback | null;
  };
  rightNow: Array<Pick<Agent,
    "id" | "label" | "role" | "customType" | "model" | "status" | "currentActivity" | "lastSeen" | "updatedAt"> & {
      activityFallback?: SessionActivityFallback | null;
      tokens: Pick<Agent["tokens"], "total">;
    }>;
  topSignals: Insight[];
  repository: {
    readiness: Readiness;
    available: boolean;
    branch: string | null;
    changedFiles: number | null;
    pullRequestCount: number | null;
    comparison: NonNullable<MonitorState["session"]>["repository"]["comparison"] | null;
  };
  resourceAvailability: {
    readiness: Readiness;
    hasData: boolean | null;
  };
  requestSnapshots: {
    status: RequestSnapshotFeed["status"];
    items: Array<RequestSnapshot & { agentRole: Agent["role"]; agentLabel: string }>;
  };
  planTasks: MonitorState["planTasks"];
};

export type AgentsDomain = SessionDomainBase & {
  domain: "agents";
  agents: Agent[];
  workflows: Workflow[];
  /** Roster-row and focused-tree history marks; the selected-agent inspector keeps its own bounded copy. */
  insights: Insight[];
  loops: LoopPattern[];
  cacheRefills: CacheRefillCount[];
  cacheReadDrops: CacheReadDropCount[];
  contextBoundaries: ContextHistoryBoundary[];
};

export type AgentDomain = SessionDomainBase & {
  domain: "agent";
  sectionReadiness: SessionDomainSectionReadiness<"agentEvidence" | "contextEvidence" | "activityEvidence">;
  agentId: string | null;
  agent: Agent | null;
  ancestors: Agent[];
  descendants: Agent[];
  workflow: Workflow | null;
  contextBoundaries: ContextHistoryBoundary[];
  requestSnapshots: RequestSnapshotFeed;
  insights: Insight[];
  cacheEvents: MonitorState["metrics"]["tokens"]["cacheEvents"];
  cacheReadDrops: MonitorState["metrics"]["tokens"]["cacheReadDrops"];
  planTasks: MonitorState["planTasks"];
};

export type SignalsDomain = SessionDomainBase & {
  domain: "signals";
  sectionReadiness: SessionDomainSectionReadiness<"activityEvidence" | "contextEvidence">;
  score: number;
  flowScore: { score: number; repeatedCalls: number | null; overlappingTargets: number | null };
  insights: Insight[];
  loops: LoopPattern[];
  toolPatterns: ToolPattern[];
  sessionSignal: NonNullable<MonitorState["session"]>["signal"] | null;
  agents: Array<Pick<Agent, "id" | "label" | "cacheLifetime" | "signal">>;
  cacheEvents: MonitorState["metrics"]["tokens"]["cacheEvents"];
  cacheReadDrops: MonitorState["metrics"]["tokens"]["cacheReadDrops"];
};

export type RepositoryDomain = SessionDomainBase & {
  domain: "repository";
  repositoryId: string | null;
  contextInventoryRef: NonNullable<MonitorState["session"]>["contextInventoryRef"] | null;
  repository: NonNullable<MonitorState["session"]>["repository"] | null;
  pullRequests: NonNullable<MonitorState["session"]>["pullRequests"] | null;
  /** ISO time of the live check a historical view is served from; null for live views and
   *  for historical sessions without a recorded snapshot. */
  recordedAt: string | null;
  /** Commits whose committer time lies inside the session wall-time window on the session's
   *  branch, measured at the (last) live check; null when not measured. */
  commitsInSession: number | null;
  /** Execution tasks whose workKind is git, git_push or pull_request; null until activity
   *  evidence is ready. */
  gitTasks: { total: number; failed: number } | null;
  fileHistory: { readiness: "unavailable"; items: [] };
};

/** Display fields. cpu_machine_percent stays in live samples only; peaks and curves use these four. */
export type ResourceField = "cpu_cores" | "memory_bytes" | "read_bps" | "write_bps";

/** Why stored minute curves are absent or incomplete for this session. */
export type ResourceRetentionReason =
  | "age_retention" // removed by the retention-days setting
  | "size_cleanup" // removed by the soft size threshold cleanup
  | "not_recorded"; // no curve rows and no recorded removal (session predates the store, or the store was rebuilt)

export type ResourceMinuteAggregate = { min: number; avg: number; max: number; maxAt: string };

export type ResourceMinute = {
  minuteStart: string; // ISO
  // For each field: min/avg/max and ISO timestamp of the max sample; null when no sample in that minute.
  cpuCores: ResourceMinuteAggregate | null;
  memoryBytes: ResourceMinuteAggregate | null;
  readBytesPerSecond: ResourceMinuteAggregate | null;
  writeBytesPerSecond: ResourceMinuteAggregate | null;
};

export type ResourcePeakTask = {
  id: string; // normalized execution-task ID
  workKind: WorkKind;
  label: string; // the normalized ExecutionTask.label (Bash description), already browser-safe
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null; // wall duration; null while running
};

export type ResourcePeak = {
  id: string; // opaque, `p<integer>` from resource_peaks.id
  field: ResourceField;
  observedAt: string; // ISO, second-level instant of the peak sample
  value: number;
  tasks: ResourcePeakTask[]; // matched tasks resolved from committed normalized task metadata; unresolved IDs dropped
  matchedTaskCount: number; // count of matched task IDs, including unresolved ones
  request: { number: number; uncachedInputTokens: number | null } | null; // always null in this part (see below)
  window: {
    // retained full-resolution samples of this peak's field, 2 min each side
    status: "retained" | "not_retained";
    samples: Array<{ at: string; value: number | null }>; // empty when not_retained
    minute: ResourceMinute | null; // the minute row containing the peak, for the not_retained fallback
  };
};

export type ResourcesDomain = SessionDomainBase & {
  domain: "resources";
  live: MonitorState["metrics"]["resources"];
  retained: {
    readiness: "loading" | "ready" | "unavailable" | "rebuilding";
    minutes: ResourceMinute[]; // ascending, newest 1440 at most
    minutesTruncated: boolean; // true when older minutes exist beyond the bound
    curveRemoval: { reason: ResourceRetentionReason; removedAt: string | null } | null;
    // non-null when minutes are empty but peaks exist, or when a recorded removal exists
    peaks: ResourcePeak[]; // top 3 per ResourceField by value (12 max), sorted by observedAt desc
  };
};

export type DetailsDomain = SessionDomainBase & {
  domain: "details";
  sectionReadiness: SessionDomainSectionReadiness<"core" | "contextEvidence">;
  source: MonitorState["source"];
  capabilities: MonitorState["capabilities"];
  view: MonitorState["view"];
  session: Omit<NonNullable<MonitorState["session"]>, "cwd" | "repository" | "pullRequests" | "signal" | "progress"> | null;
  context: MonitorState["metrics"]["tokens"]["contextHistory"];
};

export type SessionDomainResponse =
  | SessionSummaryDomain
  | AgentsDomain
  | AgentDomain
  | SignalsDomain
  | RepositoryDomain
  | ResourcesDomain
  | DetailsDomain;
