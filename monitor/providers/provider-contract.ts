import type {
  Activity,
  Agent,
  ContextMachinery,
  ExecutionTask,
  MonitorState,
  PlanTask,
  ProviderCapabilities,
  ProviderId,
  ProviderSource,
  SessionApprovalMode,
  SessionReportedSignal,
  UsageLimits,
} from "../../shared/monitor-contract";

/** Provider-local catalog item. The monitor qualifies `localId` before exposing it. */
export type ProviderSessionReference = {
  localId: string;
  title: string;
  project: string;
  updatedAt: string;
  isLive: boolean;
  needsInput: boolean;
  /** Monitor-private verified process identity. Never expose it in browser session catalogs. */
  resourceOwner?: {
    pid: number;
    processStartIdentity: string;
  } | null;
};

/** Latest non-zero provider context snapshot for one agent at one point in time. */
export type ProviderUsageSnapshot = {
  dedupeId: string;
  actorId: string;
  timestamp: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Generated reasoning is already included in `output`; this is informational only. */
  reasoningOutput?: number;
  /** Provider-reported total for this latest snapshot, never cumulative transcript usage. */
  totalTokens?: number;
  modelContextWindow?: number | null;
  /** Bounded model identity at this observation; used only for same-model comparisons. */
  model?: string;
  /** Changes when recognized missing/malformed usage makes adjacent comparison unsafe. */
  comparisonGroup?: number;
};

/**
 * Safe tool-call evidence passed to shared metrics. Complete provider inputs,
 * commands, prompts, results, and output must remain inside the adapter.
 */
export type ProviderToolCallEvidence = {
  id: string;
  timestamp: string;
  actor: { id: string; label: string };
  tool: string;
  detail: string;
  status: "running" | "completed" | "failed" | null;
  repetitionSignature: string;
  mutation: {
    display: string;
    scopes: string[];
  } | null;
};

/** Only recognized automatic/manual evidence may cross the provider boundary. */
export type ProviderCompactionEvidence = {
  actorId: string;
  timestamp: string;
  trigger: "auto" | "manual";
  preTokens: number | null;
};

/** Successful provider-local PR creation with all raw command/result content discarded. */
export type ProviderPullRequestCreationEvidence = {
  id: string;
  actorId: string;
  timestamp: string | null;
  url: string;
};

/** Explicit availability gates for rules whose absence of events is meaningful. */
export type ProviderEfficiencyRuleEvidence = {
  repetition: boolean;
  concurrentMutation: boolean;
  unsharedContext: boolean;
  healthyFallback: boolean;
  cacheUsageClassification: boolean;
};

export type ProviderAgentEvidence = Omit<Agent, "tokens" | "executionTasks"> & {
  /** Live provider-authored heading only; never reasoning prose or a task association. */
  currentActivity?: Agent["currentActivity"];
  executionTasks: ExecutionTask[];
};

type SessionCost = NonNullable<NonNullable<MonitorState["session"]>["cost"]>;
type SessionSummary = NonNullable<NonNullable<MonitorState["session"]>["summary"]>;

/**
 * Fully sanitized provider evidence. Shared analysis may aggregate or filter
 * these fields, but must never receive a provider's raw transcript records.
 */
export type ProviderSessionEvidence = {
  localId: string;
  historical: boolean;
  session: {
    title: string;
    project: string;
    cwd: string;
    startedAt: string | null;
    updatedAt: string | null;
    recordedGitBranch: string;
    cost: SessionCost | null;
    approvalMode: SessionApprovalMode | null;
    contextMachinery: ContextMachinery | null;
    summary: SessionSummary | null;
    signal: SessionReportedSignal | null;
  };
  agents: ProviderAgentEvidence[];
  usageSnapshots: ProviderUsageSnapshot[];
  toolCalls: ProviderToolCallEvidence[];
  activity: Activity[];
  planTasks: PlanTask[];
  compactions: ProviderCompactionEvidence[];
  efficiencyRuleEvidence: ProviderEfficiencyRuleEvidence;
  /** Canonical successful PR-creation events only; no command or tool output crosses the boundary. */
  pullRequestCreations: ProviderPullRequestCreationEvidence[];
};

export type ProviderReadOptions = {
  historical: boolean;
};

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly source: ProviderSource;
  readonly capabilities: Readonly<ProviderCapabilities>;
  readonly watchTargets?: readonly string[];
  listSessions(): Promise<ProviderSessionReference[]>;
  readSession(localSessionId: string, options: ProviderReadOptions): Promise<ProviderSessionEvidence | null>;
  readUsageLimits?(): Promise<UsageLimits>;
  unavailableMessage?(localSessionId: string): string;
}
