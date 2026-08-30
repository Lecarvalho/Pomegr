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

export type SessionProgress = {
  phase: "planning" | "implementing" | "verifying" | "blocked" | "complete";
  percent: number;
  remainingMinutesMin?: number;
  remainingMinutesMax?: number;
  confidence: "low" | "medium" | "high";
  reportedAt: string;
};

export type PomegrPluginMetadata = {
  status: "active";
  version: string | null;
  policyStatus: "valid" | "invalid" | "missing";
  policyVersion: number | null;
  observedAt: string | null;
};

/** Transient provider-authored activity heading for an open agent turn. */
export type AgentCurrentActivity = {
  label: string;
  observedAt: string;
};

/**
 * Bounded, provider-neutral display role. Provider-specific agent types stay
 * inside the monitor and are resolved before state reaches the browser.
 */
export type AgentRole =
  | "orchestrator"
  | "explore"
  | "plan"
  | "builder"
  | "reviewer"
  | "tester"
  | "researcher"
  | "general-purpose"
  | "workflow-worker"
  | "fork"
  | "compaction"
  | "unknown";

/** Provider-recorded prompt-cache lifetime evidence, normalized monitor-side. */
export type CacheLifetime = "5m" | "1h" | "mixed";

/** Readiness describes the publication state of normalized evidence, not support. */
export type Readiness = "loading" | "ready" | "unavailable";

/** Bounded monitor-derived purpose. Raw commands and provider-native tool schemas stay private. */
export type WorkKind = "shell" | "search" | "read" | "write" | "test" | "build" | "git" | "git_push" | "pull_request" | "process" | "web" | "image" | "input" | "transfer" | "skill" | "report" | "agent" | "integration" | "wait";

export type HomeReadiness = {
  catalog: Readiness;
  providerLimits: Record<ProviderId, Readiness>;
  /** Qualified provider + limit identity, for example `claude:current-session`. */
  limitActivity: Record<string, Readiness>;
  /** Qualified session identity, for example `codex:abc123`. */
  sessionSummaries: Record<string, Readiness>;
};

export type SessionReadiness = {
  core: Readiness;
  agentEvidence: Readiness;
  contextEvidence: Readiness;
  activityEvidence: Readiness;
  repository: Readiness;
  resources: Readiness;
  usageLimits: Readiness;
};

export type ExecutionTask = {
  id: string;
  label: string;
  kind: "shell";
  workKind: WorkKind;
  status: "running" | "completed" | "failed" | "stopped";
  background: boolean;
  backgroundId: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  failureCause: "command_not_found" | "invalid_path" | "network_error" | "not_found" | "non_zero_exit" | "permission_denied" | "provider_error" | "syntax_error" | "tests_failed" | "timed_out" | null;
  signal: ReportedSignal | null;
};

export type ReviewDecision = {
  /** Deterministic bounded category derived monitor-side from the reviewed request. */
  action: "build_or_test" | "browser_interaction" | "dependency_change" | "file_change" | "filesystem_action" | "local_process" | "network_access" | "version_control" | "shell_command" | "privileged_action";
  outcome: "allowed" | "denied";
  /** Bounded provider-reported assessment; never inferred by Pomegr. */
  risk: "low" | "medium" | "high" | "unknown";
  /** Provider-reported review duration, capped monitor-side. */
  durationMs: number | null;
  reviewedAt: string;
};

export type ReviewDecisionFeed = {
  total: number;
  allowed: number;
  denied: number;
  items: ReviewDecision[];
  truncated: boolean;
};

export type Agent = {
  id: string;
  parentId: string | null;
  /** Whether an explicit one-shot request can resolve this agent's local transcript path. */
  transcriptAvailable?: boolean;
  /** Normalized workflow association. Provider task IDs never cross this boundary. */
  workflowId: string | null;
  /** Present only when a structured provider artifact verifies the phase association. */
  workflowPhaseId: string | null;
  /** Stable provider-evidence order within the owning workflow. */
  workflowOrder: number | null;
  /** Workflow lifecycle evidence; independent from transcript-recency status. */
  workflowState: "running" | "done" | "error" | "unknown" | null;
  /** Bounded provider-reported work assignment when distinct from the agent identity. */
  assignment?: string | null;
  label: string;
  role: AgentRole;
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
  /** Bounded normalized approval outcomes. Reviewed content and rationale remain monitor-private. */
  reviewDecisions?: ReviewDecisionFeed;
  lastSeen: string;
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  /** Aggregate of every resolved request cache lifetime observed for this agent. */
  cacheLifetime: CacheLifetime | null;
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
  workKind: WorkKind;
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

export type ContextHistoryBucket = {
  start: string;
  end: string;
  total: number;
  agents: Array<{ agentId: string; total: number }>;
};

export type ContextHistoryBoundary = {
  id: string;
  agentId: string;
  timestamp: string;
  kind: "automatic_compaction" | "manual_compaction" | "snapshot_drop";
  preTokens: number | null;
};

export type CacheEvent = {
  id: string;
  agentId: string;
  kind: "miss_refill" | "refill" | "reuse";
  observedAt: string;
  promptInputTokens: number;
  cacheReadPercent: number;
  cacheWriteTokens: number;
  previousCacheReadPercent: number | null;
  gapMs: number | null;
  /** A reuse points to the tracked refill or miss-refill it follows. */
  relatedEventId: string | null;
};

export type CacheRefillReason = "model_changed" | "system_changed" | "tools_changed" | "messages_changed";
export type CacheRefillProviderStatus = "previous_cache_entry_unavailable";
export type CacheMessageChangeSequence = "post_tool_task_notification_resume";

export type CacheLifetimeInference = {
  cause: "cache_lifetime_elapsed";
  /** Lifetime recorded on the preceding comparable request. */
  cacheLifetime: CacheLifetime;
  elapsedMs: number;
};

export type CacheRefillReasonCount = {
  reason: CacheRefillReason;
  count: number;
};

export type CacheToolDefinitionChange = {
  tool: "RemoteTrigger" | "PushNotification" | "ListAgents";
  kind: "added" | "definition_changed";
};

export type CacheToolChangeAttributionCount = {
  cause: "remote_control_connected";
  count: number;
  /** Fixed monitor-derived tool delta; provider schemas remain private. */
  changes: CacheToolDefinitionChange[];
};

export type CacheRefillOccurrence = {
  observedAt: string;
  /** Provider-diagnosed cause when recognized; otherwise unavailable. */
  reason: CacheRefillReason | null;
  /** Bounded provider status; raw diagnostics remain monitor-private. */
  providerStatus: CacheRefillProviderStatus | null;
  /** Deterministic inference from the preceding request's resolved lifetime. */
  cacheLifetimeInference: CacheLifetimeInference | null;
  /** Bounded transcript sequence observed around a messages-changed request. */
  messageChangeSequence: CacheMessageChangeSequence | null;
  /** Inference tied to this occurrence's recognized lifecycle evidence. */
  toolChangeAttribution: Omit<CacheToolChangeAttributionCount, "count"> | null;
};

export type CacheRefillCount = {
  agentId: string;
  count: number;
  /** Chronological, bounded details for each counted refill. */
  occurrences: CacheRefillOccurrence[];
  /** Provider-diagnosed causes for a bounded subset of these refills. */
  reasons: CacheRefillReasonCount[];
  /** Bounded Pomegr inferences tied to recognized provider lifecycle evidence. */
  toolChangeAttributions: CacheToolChangeAttributionCount[];
};

export type CacheEventFeed = {
  status: "ready" | "unavailable";
  items: CacheEvent[];
  /** Bounded per-agent counts of comparable high-read to low-read large rewrites. */
  possibleFullRefills: CacheRefillCount[];
};

export type RequestSnapshot = {
  id: string;
  agentId: string;
  observedAt: string;
  cacheLifetime: CacheLifetime | null;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type RequestSnapshotFeed = {
  status: "ready" | "unavailable";
  items: RequestSnapshot[];
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

export type WorkflowPhase = {
  id: string;
  label: string;
  agentIds: string[];
};

/** Sanitized provider-authored workflow metadata; no executable or transcript content. */
export type Workflow = {
  id: string;
  name: string;
  summary: string | null;
  status: "running" | "completed" | "unknown";
  /** Whether exact structured phase and worker metadata has been published. */
  metadataStatus: "pending" | "ready" | "unavailable";
  startedAt: string | null;
  updatedAt: string | null;
  durationMs: number;
  agentIds: string[];
  phases: WorkflowPhase[];
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
/** Bounded current work state. Provider-native lifecycle values stay monitor-private. */
export type SessionActivityStatus = "working" | "needs_input" | "idle" | "unknown";
/** Bounded session-directory row derived from committed normalized evidence. */
export type SessionSummary = {
  id: string;
  provider: ProviderId;
  source: ProviderSource;
  title: string;
  project: string;
  createdAt?: string | null;
  updatedAt: string;
  isLive: boolean;
  needsInput: boolean;
  activityStatus: SessionActivityStatus;
  summaryReadiness: Readiness;
  agentCount: number | null;
  activeAgentCount: number | null;
  latestContextTotal: number | null;
  progress: SessionProgress | null;
  /** Latest bounded provider-authored heading from the normalized primary agent; live sessions only. */
  currentActivity: AgentCurrentActivity | null;
};

export type SessionCatalogSnapshot = {
  sessions: SessionSummary[];
  /** Optional during migration; absent means legacy catalog semantics. */
  revision?: number | string | null;
  readiness?: Pick<HomeReadiness, "catalog">;
};

export type HomeContextHistory = {
  bucketMs: number;
  buckets: ContextHistoryBucket[];
  boundaries: ContextHistoryBoundary[];
};

export type HomeSessionSummary = {
  id: string;
  provider: ProviderId;
  source: ProviderSource;
  title: string;
  project: string;
  updatedAt: string;
  needsInput: boolean;
  activityStatus: SessionActivityStatus;
  agentCount: number | null;
  activeAgentCount: number | null;
  latestContextTotal: number | null;
  contextHistory: HomeContextHistory | null;
  progress: SessionProgress | null;
  resources: ResourceUsage | null;
};

export type HomeProjectHistory = {
  status?: "loading" | "ready";
  windowDays: 7;
  completed: number;
  medianWallTimeMs: number | null;
  medianFinalContext: number | null;
  finalContexts: Array<{ endedAt: string; total: number }>;
};

export type HomeProjectSummary = {
  project: string;
  updatedAt: string;
  liveCount: number;
  sessions: HomeSessionSummary[];
  history: HomeProjectHistory;
};

export type HomeProviderUsageLimits = {
  provider: ProviderId;
  source: ProviderSource;
  readiness?: Readiness;
  usageLimits: UsageLimits;
};

/** One bounded request-time observation used only to correlate provider-reported limit movement. */
export type HomeLimitRequestObservation = {
  id: string;
  observedAt: string;
};

export type HomeLimitActivitySession = {
  id: string;
  title: string;
  project: string;
  isLive: boolean;
  requestObservations: HomeLimitRequestObservation[];
};

export type HomeLimitMovement = {
  id: string;
  from: string;
  to: string;
  changePoints: number;
  correlation: "single" | "shared" | "unobserved";
  sessionIds: string[];
};

/**
 * Provider-reported plan movement aligned with local request timestamps. This is
 * correlation evidence, never proportional session attribution or billing.
 */
export type HomeLimitActivity = {
  provider: ProviderId;
  source: ProviderSource;
  limitId: string;
  label: string;
  window: string;
  /** Whether local activity is correlated to the whole account limit or one model-scoped limit. */
  scope: "account" | "model";
  percent: number;
  resetsAt: string | null;
  windowStartsAt: string;
  windowStartsAtExact: boolean;
  generatedAt: string;
  observedFrom: string;
  /** Earliest locally recorded provider rejection in this reset window. */
  firstRejectedAt: string | null;
  status: "collecting" | "ready";
  partialCoverage: boolean;
  eventsTruncated: boolean;
  observations: Array<{ observedAt: string; percent: number }>;
  sessions: HomeLimitActivitySession[];
  movements: HomeLimitMovement[];
};

export type HomeSnapshot = {
  generatedAt: string | null;
  revision?: number | string | null;
  providerLimitRevision?: number | string | null;
  readiness?: HomeReadiness;
  providerLimits: HomeProviderUsageLimits[];
  limitActivities: HomeLimitActivity[];
  projects: HomeProjectSummary[];
  error?: string;
};

/** Home data that is independent from project and live-session presentation. */
export type HomeAggregateSnapshot = {
  generatedAt: string | null;
  revision?: number | string | null;
  providerLimitRevision?: number | string | null;
  readiness?: HomeReadiness;
  providerLimits: HomeProviderUsageLimits[];
  limitActivities: HomeLimitActivity[];
  error?: string;
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
  cacheWriteUsage: boolean;
  cacheUsageClassification: boolean;
  sessionSummary: boolean;
  signals: boolean;
  usageLimits: boolean;
  workflows: boolean;
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
  /** Bounded monitor-side classification of the latest failed refresh. */
  failureKind?: "authentication_required" | "rate_limited" | "unavailable" | null;
  /** Earliest local retry eligibility after the latest failed refresh. */
  retryAt?: string | null;
  error?: string;
  limits: Array<{
    id: string;
    label: string;
    window: string;
    percent: number;
    resetsAt: string | null;
    severity: "normal" | "warning" | "critical";
    active: boolean;
  }>;
};

/** Provider/account-scoped usage cache shared by Home and session surfaces. */
export type UsageLimitsSnapshot = {
  revision: number | string | null;
  generatedAt: string | null;
  providers: HomeProviderUsageLimits[];
  readiness: Record<ProviderId, Readiness>;
};

export type MonitorState = {
  revision?: number | string | null;
  readiness?: SessionReadiness;
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
    progress: SessionProgress | null;
    pomegrPlugin: PomegrPluginMetadata | null;
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
      contextHistory: {
        bucketMs: number;
        buckets: ContextHistoryBucket[];
        boundaries: ContextHistoryBoundary[];
      };
      cacheEvents: CacheEventFeed;
      requestSnapshots: RequestSnapshotFeed;
    };
  };
  agents: Agent[];
  workflows: Workflow[];
  toolPatterns: ToolPattern[];
  loops: LoopPattern[];
  activity: Activity[];
  executionTasks: ExecutionTask[];
  planTasks: PlanTask[];
  insights: Insight[];
  usageLimits: UsageLimits;
  error?: string;
};
