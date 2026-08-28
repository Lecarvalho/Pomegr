import type { Agent, ExecutionTask, MonitorState } from "../../shared/monitor-contract";

export const claudeCapabilities = {
  approvalMode: true,
  automaticCompactions: true,
  contextMachinery: true,
  estimatedCost: true,
  liveSessions: true,
  needsInput: true,
  planTasks: true,
  cacheWriteUsage: true,
  cacheUsageClassification: true,
  sessionSummary: true,
  signals: true,
  usageLimits: true,
  workflows: true,
} as const;

export const codexCapabilities = {
  ...claudeCapabilities,
  contextMachinery: false,
  estimatedCost: false,
  cacheWriteUsage: false,
  cacheUsageClassification: false,
  sessionSummary: false,
  workflows: false,
} as const;

export const task: ExecutionTask = {
  id: "task-1",
  label: "Run verification",
  kind: "shell",
  status: "completed",
  background: true,
  backgroundId: "7",
  startedAt: "2026-08-08T12:00:00.000Z",
  finishedAt: "2026-08-08T12:00:05.000Z",
  exitCode: 0,
  failureCause: null,
  signal: null,
};

export const agent: Agent = {
  id: "primary",
  parentId: null,
  workflowId: null,
  workflowPhaseId: null,
  workflowOrder: null,
  workflowState: null,
  label: "Primary agent",
  role: "orchestrator",
  model: "test-model",
  effort: "medium",
  status: "finished",
  signal: null,
  toolCalls: 4,
  skills: [{ name: "documents", calls: 2, lastUsed: "2026-08-08T12:00:05.000Z" }],
  executionTasks: [task],
  lastSeen: "2026-08-08T12:00:05.000Z",
  startedAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:05.000Z",
  durationMs: 5_000,
  cacheLifetime: "1h",
  tokens: { total: 1200, input: 100, output: 100, cacheWrite: 500, cacheRead: 500 },
};

export function repositorySession(
  repository: NonNullable<MonitorState["session"]>["repository"],
  pullRequests: NonNullable<MonitorState["session"]>["pullRequests"] = { status: "ready", checkedAt: null, items: [] },
) {
  return {
    id: "session-1",
    title: "Repository work",
    project: "pomegr",
    cwd: "C:\\Workspace\\repos\\pomegr",
    repository,
    pullRequests,
    startedAt: null,
    updatedAt: null,
    durationMs: 0,
    cost: null,
    approvalMode: null,
    contextMachinery: null,
    summary: null,
    signal: null,
    progress: null,
    pomegrPlugin: null,
  } satisfies NonNullable<MonitorState["session"]>;
}
