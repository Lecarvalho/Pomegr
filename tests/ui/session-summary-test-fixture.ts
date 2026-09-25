import type { SessionSummaryDomain } from "../../shared/session-domain-contract";
import { createEmptyProviderCapabilities } from "../../shared/monitor-state.mjs";

export function sessionSummaryFixture(overrides: Partial<SessionSummaryDomain> = {}): SessionSummaryDomain {
  const sessionId = overrides.sessionId || "claude:summary-fixture";
  return {
    domain: "session-summary", sessionId, revision: 1, readiness: "ready", observedAt: "2026-09-14T12:10:00.000Z",
    source: "Claude Code", capabilities: { ...createEmptyProviderCapabilities(), estimatedCost: true, cacheWriteUsage: true }, view: "history",
    sectionReadiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready" },
    session: {
      id: sessionId, title: "Recorded implementation session", project: "Pomegr", startedAt: "2026-09-14T11:00:00.000Z", updatedAt: "2026-09-14T12:00:00.000Z", durationMs: 3_600_000,
      cost: { amount: 2.5, currency: "USD", type: "estimated", observedAt: "2026-09-14T12:00:00.000Z" }, summary: null,
      progress: { phase: "implementing", percent: 60, confidence: "medium", reportedAt: "2026-09-14T12:00:00.000Z" }, pomegrPlugin: null,
    },
    metrics: { agents: 2, activeAgents: 1, idleAgents: 1, finishedAgents: 0, toolCalls: 14, repeatedCalls: 2 },
    activity: { total: 20, toolCalls: 14, byKind: [{ kind: "read", count: 8, medianDurationMs: 900 }, { kind: "write", count: 6, medianDurationMs: 1200 }], messages: 6, failed: 0 },
    allAgentContext: 12_400,
    lifecycle: { isLive: false, needsInput: false, activityStatus: "closed", currentActivity: null, activityFallback: null },
    rightNow: [{ id: "primary", label: "Primary agent", role: "orchestrator", customType: null, model: "claude-sonnet", status: "active", currentActivity: { label: "Implementing session tabs", observedAt: "2026-09-14T12:00:00.000Z" }, tokens: { total: 9_000 }, lastSeen: "2026-09-14T12:00:00.000Z", updatedAt: "2026-09-14T12:00:00.000Z" }],
    topSignals: [{ id: "signal-1", level: "warning", title: "Repeated reads", detail: "The same target was read repeatedly.", agentId: "primary" }],
    repository: { readiness: "ready", available: true, branch: "feature/session-tabs", changedFiles: 4, touchedFiles: 6, pullRequestCount: 1, comparison: null },
    resourceAvailability: { readiness: "ready", hasData: true },
    requestSnapshots: { status: "ready", items: [{ id: "request-1", agentId: "primary", agentRole: "orchestrator", agentLabel: "Primary agent", observedAt: "2026-09-14T12:00:00.000Z", cacheLifetime: null, uncachedInputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 100, outputTokens: 5, totalTokens: 135, precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null }] },
    planTasks: [{ id: "task-1", subject: "Build tabs", status: "completed", blocks: [], blockedBy: [] }],
    ...overrides,
  };
}
