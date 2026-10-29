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
    "id" | "title" | "project" | "startedAt" | "updatedAt" | "durationMs" | "cost" | "summary" | "signal" | "progress" | "pomegrPlugin"> | null;
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
    unavailableReason: RepositoryUnavailableReason | null;
    changedFiles: number | null;
    touchedFiles: number | null;
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
  events: SessionEventFeed;
};

export const SESSION_EVENT_KINDS = [
  "agent_started",
  "agent_finished",
  "agent_stopped",
  "signal_reported",
  "estimate_updated",
  "user_message",
  "resource_peak",
  "commit_observed",
  "pull_request_opened",
  "cache_refill",
  "context_compacted",
  "task_added",
  "task_removed",
  "task_completed",
  "task_blocked",
  "task_updated",
] as const;

export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

export const SESSION_EVENT_LIMIT = 50;

// One high-level transition derived monitor-side from already-normalized evidence.
// The four task kinds are the agent's own Pomegr task tool calls recorded in the session, never a reading of the task board.
export type SessionEvent = {
  id: string; // opaque digest, stable while the underlying evidence is unchanged
  kind: SessionEventKind;
  at: string; // ISO timestamp recorded with the evidence, never the projection time
  agentId: string | null; // agent_started, agent_finished, agent_stopped, agent-scoped signal_reported, cache_refill, context_compacted, and the four task kinds
  agentLabel: string | null;
  durationMs: number | null; // agent_finished and agent_stopped wall time
  signal: Pick<Agent["signal"] & object, "label" | "tone"> | null; // signal_reported, agent-reported
  progress: Pick<NonNullable<NonNullable<MonitorState["session"]>["progress"]>, "percent" | "phase"> | null; // estimate_updated
  resource: ResourceField | null; // resource_peak: the retained session high for that resource
  pullRequestNumber: number | null; // pull_request_opened, when the recorded creation matches a listed pull request
  refill: "possible_full" | "provider_diagnosed" | "lifetime_elapsed" | null;
  compaction: "automatic" | "manual" | null; // context_compacted: the recorded compaction trigger
};

export type SessionEventFeed = {
  readiness: Readiness;
  items: SessionEvent[]; // newest first, at most SESSION_EVENT_LIMIT
  total: number;
};

export type AgentsDomain = SessionDomainBase & {
  domain: "agents";
  agents: Agent[];
  workflows: Workflow[];
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
  insights: Insight[];
  loops: LoopPattern[];
  toolPatterns: ToolPattern[];
  sessionSignal: NonNullable<MonitorState["session"]>["signal"] | null;
  agents: Array<Pick<Agent, "id" | "label" | "cacheLifetime" | "signal">>;
  cacheEvents: MonitorState["metrics"]["tokens"]["cacheEvents"];
  cacheReadDrops: MonitorState["metrics"]["tokens"]["cacheReadDrops"];
};

// Why a live view shows no repository: the session's branch changed, Git confirmed the folder is
// not a repository, or the Git read failed (timed out, Git missing, refused by safe.directory, other).
export type RepositoryUnavailableReason = "branch_changed" | "not_repository" | "timeout" | "git_missing" | "refused" | "failed";

export type RepositoryDomain = SessionDomainBase & {
  domain: "repository";
  repositoryId: string | null;
  contextInventoryRef: NonNullable<MonitorState["session"]>["contextInventoryRef"] | null;
  repository: NonNullable<MonitorState["session"]>["repository"] | null;
  unavailableReason: RepositoryUnavailableReason | null;
  pullRequests: NonNullable<MonitorState["session"]>["pullRequests"] | null;
  recordedAt: string | null;
  commitsInSession: number | null;
  gitTasks: { total: number; failed: number } | null;
  // The Repository tab's Touched here list, built monitor-side from recorded evidence only.
  touchedFiles: SessionTouchedFiles;
};

// One file this session touched.
export type SessionTouchedFile =
  | {
      path: string; // safe repository-relative path, same root as repository.files
      // A recorded tool change, from the committed file-history cache (never a GET-time read).
      source: "recorded";
      fileId: string; // opaque `f<integer>`, see shared/repository-files-contract.ts
      kind: "created" | "edited" | "deleted" | "moved"; // newest kind in this session
      changeCount: number;
      lastObservedAt: string; // ISO
      // Agents a recorded tool call proves changed this file in this session, newest first, at most 12.
      agents: Array<{ id: string; label: string | null; assignment: string | null; model: string | null; changeCount: number }>;
    }
  | {
      path: string; // safe repository-relative path, same root as repository.files
      source: "committed";
      // Net Git change across the matched commits; null when not recorded.
      change: "added" | "modified" | "deleted" | null;
    };

export type SessionTouchedFiles = {
  readiness: "loading" | "ready" | "unavailable" | "rebuilding"; // recorded history readiness
  files: SessionTouchedFile[]; // sorted by path; a path appears once
  truncated: boolean; // either source was cut at its cap
};

export type ResourceField = "cpu_cores" | "memory_bytes" | "read_bps" | "write_bps";

export type ResourceRetentionReason =
  | "age_retention" // removed by the retention-days setting
  | "size_cleanup" // removed by the soft size threshold cleanup
  | "not_recorded"; // no curve rows and no recorded removal (session predates the store, or the store was rebuilt)

export type ResourceMinuteAggregate = { min: number; avg: number; max: number; maxAt: string };

export type ResourceMinute = {
  minuteStart: string; // ISO
  cpuCores: ResourceMinuteAggregate | null;
  cpuMachinePercent: ResourceMinuteAggregate | null; // the same samples as a share of all logical processors, 0–100
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
  cpuMachinePercent: number | null;
  tasks: ResourcePeakTask[]; // matched tasks resolved from committed normalized task metadata; unresolved IDs dropped
  matchedTaskCount: number; // count of matched task IDs, including unresolved ones
  request: { number: number; uncachedInputTokens: number | null } | null; // always null in this part (see below)
  window: {
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
