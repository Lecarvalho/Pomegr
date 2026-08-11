import type {
  Activity,
  Agent,
  ContextMachinery,
  ExecutionTask,
  MonitorState,
  PlanTask,
  ProviderId,
  ProviderSource,
  ReportedSignal,
  SessionApprovalMode,
  UsageLimits,
} from "../../shared/monitor-contract";

/**
 * Optional provider features. Core session discovery, normalized agents,
 * sanitized activity, and latest context snapshots are required by every
 * adapter and therefore are not capability-gated.
 */
export type ProviderCapabilities = {
  approvalMode: boolean;
  automaticCompactions: boolean;
  contextMachinery: boolean;
  estimatedCost: boolean;
  liveSessions: boolean;
  needsInput: boolean;
  planTasks: boolean;
  sessionSummary: boolean;
  signals: boolean;
  usageLimits: boolean;
};

/** Provider-local catalog item. The monitor qualifies `localId` before exposing it. */
export type ProviderSessionReference = {
  localId: string;
  title: string;
  project: string;
  updatedAt: string;
  isLive: boolean;
  needsInput: boolean;
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

export type ProviderAgentEvidence = Omit<Agent, "tokens" | "executionTasks"> & {
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
    signal: ReportedSignal | null;
  };
  agents: ProviderAgentEvidence[];
  usageSnapshots: ProviderUsageSnapshot[];
  toolCalls: ProviderToolCallEvidence[];
  activity: Activity[];
  planTasks: PlanTask[];
  compactions: ProviderCompactionEvidence[];
  /** Canonical successful PR-creation results only; no command or tool output crosses the boundary. */
  pullRequestUrls: string[];
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
