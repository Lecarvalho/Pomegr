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
  fileHistory: { readiness: "unavailable"; items: [] };
};

export type ResourcesDomain = SessionDomainBase & {
  domain: "resources";
  live: MonitorState["metrics"]["resources"];
  retained: { readiness: "unavailable"; reason: "producer_not_implemented"; minutes: []; peaks: []; peakSamples: [] };
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
