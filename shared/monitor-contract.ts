export type ReportedSignal = {
  label: string;
  tone: "neutral" | "info" | "positive" | "warning" | "negative";
  reportedAt: string | null;
};

export type AgentReportedSignal = ReportedSignal & {
  description?: string;
};

export type SessionReportedSignal = ReportedSignal & {
  description?: string;
};

/** Transient provider-authored activity heading for an open agent turn. */
export type AgentCurrentActivity = {
  label: string;
  observedAt: string;
};

export type ExecutionTask = {
  id: string;
  label: string;
  kind: "shell";
  status: "running" | "completed" | "failed" | "stopped";
  background: boolean;
  backgroundId: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  failureCause: "command_not_found" | "invalid_path" | "network_error" | "not_found" | "non_zero_exit" | "permission_denied" | "provider_error" | "syntax_error" | "tests_failed" | "timed_out" | null;
  signal: ReportedSignal | null;
};

export type Agent = {
  id: string;
  parentId: string | null;
  label: string;
  kind: string;
  model: string;
  effort: string;
  status: "active" | "waiting" | "needs_input" | "warm" | "finished" | "stopped" | "idle";
  liveness?: {
    source: "owning_app_server" | "lifecycle_bridge" | "rollout_activity_heuristic";
    observedAt: string;
  } | null;
  signal: AgentReportedSignal | null;
  currentActivity?: AgentCurrentActivity | null;
  toolCalls: number;
  skills: Array<{ name: string; calls: number; lastUsed: string | null }>;
  executionTasks?: ExecutionTask[];
  lastSeen: string;
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  tokens: {
    total: number;
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    reasoningOutput?: number;
    modelContextWindow?: number | null;
  };
};

export type Activity = {
  id: string;
  timestamp: string;
  actor: string;
  tool: string;
  detail: string;
  status: "failed" | null;
};

export type PlanTask = {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  blocks: string[];
  blockedBy: string[];
};

export type ContextGrowthBucket = {
  start: string;
  end: string;
  total: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

export type ContextMachinery = {
  observedAt: string | null;
  model: string;
  total: { used: string; limit: string; percentage: number } | null;
  machineryTokens: number;
  categories: Array<{ name: string; tokens: string; percentage: number }>;
  groups: Array<{
    id: string;
    label: string;
    items: Array<{ name: string; detail: string; tokens: string }>;
  }>;
};

export type ResourceUsageUnavailableReason =
  | "unsupported_platform"
  | "missing_owner"
  | "shared_owner"
  | "owner_not_found"
  | "owner_identity_mismatch"
  | "collection_failed";

export type ResourceUsageSample = {
  timestamp: string;
  cpuCores: number | null;
  cpuMachinePercent: number | null;
  memoryBytes: number | null;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
};

/** Live process-tree telemetry. Process identity and sampling internals stay monitor-private. */
export type ResourceUsage = {
  status: "collecting" | "ready" | "unavailable";
  reason: ResourceUsageUnavailableReason | null;
  current: {
    cpuCores: number | null;
    cpuMachinePercent: number | null;
    memoryBytes: number;
    readBytesPerSecond: number | null;
    writeBytesPerSecond: number | null;
  } | null;
  observedPeak: { memoryBytes: number } | null;
  samples: ResourceUsageSample[];
};

export type Insight = { id: string; level: "info" | "warning"; title: string; detail: string };
export type LoopPattern = { id: string; agent: string; tool: string; detail: string; calls: number; repeats: number };
export type ToolPattern = { id: string; agent: string; tool: string; detail: string; calls: number };
export type SessionSummary = {
  id: string;
  provider: ProviderId;
  source: ProviderSource;
  title: string;
  project: string;
  updatedAt: string;
  isLive: boolean;
  needsInput: boolean;
};

export type PullRequest = {
  host: "github";
  repository: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed" | "unknown";
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  additions: number | null;
  deletions: number | null;
  updatedAt: string | null;
  association: "session" | "branch";
};

export type ProviderId = "claude" | "codex";
export type ProviderSource = "Claude Code" | "Codex";

/** Optional provider features; false means unsupported rather than a zero value. */
export type ProviderCapabilities = {
  approvalMode: boolean;
  automaticCompactions: boolean;
  contextMachinery: boolean;
  estimatedCost: boolean;
  liveSessions: boolean;
  needsInput: boolean;
  planTasks: boolean;
  cacheUsageClassification: boolean;
  sessionSummary: boolean;
  signals: boolean;
  usageLimits: boolean;
};

export type SessionApprovalMode = {
  id:
    | "auto"
    | "accept_edits"
    | "manual"
    | "default"
    | "plan"
    | "dont_ask"
    | "bypass_permissions"
    | "untrusted"
    | "on_request"
    | "granular"
    | "never";
  label: string;
  observedAt: string | null;
  source: "provider";
};

export type UsageLimits = {
  available: boolean;
  fetchedAt: string | null;
  attemptedAt: string | null;
  error?: string;
  limits: Array<{
    id: string;
    label: string;
    window: string;
    percent: number;
    resetsAt: string | null;
    severity: string;
    active: boolean;
  }>;
};

export type MonitorState = {
  connected: boolean;
  source: ProviderSource;
  capabilities: ProviderCapabilities;
  view: "live" | "history";
  session: {
    id: string;
    title: string;
    project: string;
    cwd: string;
    repository: {
      available: boolean;
      branch: string;
      files: Array<{ status: string; path: string }>;
      historical: boolean;
      isMain: boolean;
      comparison: {
        branch: string;
        kind: "base" | "upstream";
        ahead: number;
        behind: number;
        integrated: boolean;
      } | null;
      commits: Array<{
        hash: string;
        subject: string;
        committedAt: string | null;
      }>;
      remote: {
        status: "checking" | "ready" | "unavailable";
        checkedAt: string | null;
      };
    };
    pullRequests: {
      status: "ready" | "unavailable";
      checkedAt: string | null;
      items: PullRequest[];
    };
    startedAt: string | null;
    updatedAt: string | null;
    durationMs: number;
    cost: {
      amount: number;
      currency: "USD";
      type: "estimated";
      observedAt: string;
    } | null;
    approvalMode: SessionApprovalMode | null;
    contextMachinery: ContextMachinery | null;
    summary: { text: string; observedAt: string | null; source: "provider" } | null;
    signal: SessionReportedSignal | null;
  } | null;
  score: number;
  metrics: {
    agents: number;
    activeAgents: number;
    toolCalls: number;
    repeatedCalls: number;
    resources: ResourceUsage | null;
    tokens: {
      allAgents: number;
      input: number;
      output: number;
      cacheWrite: number;
      cacheRead: number;
      contextGrowthTimeline: { bucketMs: number; buckets: ContextGrowthBucket[] };
    };
  };
  agents: Agent[];
  toolPatterns: ToolPattern[];
  loops: LoopPattern[];
  activity: Activity[];
  executionTasks: ExecutionTask[];
  planTasks: PlanTask[];
  insights: Insight[];
  usageLimits: UsageLimits;
  error?: string;
};
