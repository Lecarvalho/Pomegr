import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Agent, ExecutionTask } from "../../shared/monitor-contract";
import { AgentInspector } from "../../app/components/dashboard/agent-roster/AgentInspector";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

const activity = {
  label: "Planning detailed shell stage logging",
  observedAt: "2026-08-12T12:00:05.000Z",
};

const baseAgent: Agent = {
  id: "primary",
  parentId: null,
  workflowId: null,
  workflowPhaseId: null,
  workflowOrder: null,
  workflowState: null,
  label: "Primary agent",
  role: "orchestrator",
  model: "gpt-synthetic",
  effort: "high",
  status: "active",
  signal: null,
  toolCalls: 0,
  skills: [],
  executionTasks: [],
  lastSeen: "2026-08-12T12:00:05.000Z",
  startedAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:05.000Z",
  durationMs: 5_000,
  cacheLifetime: null,
  tokens: { total: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
};

const task: ExecutionTask = {
  id: "shell-1",
  label: "Run verification",
  kind: "shell",
  workKind: "test",
  status: "running",
  background: false,
  backgroundId: null,
  startedAt: "2026-08-12T12:00:02.000Z",
  finishedAt: null,
  exitCode: null,
  failureCause: null,
  signal: null,
};

function detail(agent: Agent, historical = false) {
  return <LiveClockProvider running={false}><AgentInspector agent={agent} agents={[agent]} historical={historical} onOpenTree={() => {}} /></LiveClockProvider>;
}

describe("current agent activity", () => {
  it("keeps Activity & Execution available with only provider-reported current activity", () => {
    render(detail({ ...baseAgent, currentActivity: activity }));

    const inspector = screen.getByRole("region", { name: "Agent inspector for Primary agent" });
    expect(screen.getByRole("region", { name: "Current provider-reported activity" })).toHaveTextContent(activity.label);
    expect(inspector).toHaveTextContent("Provider-reported");
    expect(inspector).toHaveTextContent("Shell tasks0");
  });

  it("shows current activity above shell execution without changing execution counts or labels", () => {
    render(detail({ ...baseAgent, currentActivity: activity, executionTasks: [task] }));

    const inspector = screen.getByRole("region", { name: "Agent inspector for Primary agent" });
    expect(inspector).toHaveTextContent(activity.label);
    expect(inspector).toHaveTextContent("Run verification");
    const sections = inspector.querySelectorAll(".executionTaskSection");
    expect(sections[0]).toHaveTextContent("Current activity");
    expect(sections[1]).toHaveTextContent("Shell tasks");
  });

  it("preserves tasks-only behavior and never shows stale activity in history", () => {
    const { rerender } = render(detail({ ...baseAgent, executionTasks: [task] }));
    expect(screen.getByRole("region", { name: "Agent inspector for Primary agent" })).not.toHaveTextContent("Current activity");

    rerender(detail({ ...baseAgent, currentActivity: activity }, true));
    expect(screen.getByRole("region", { name: "Agent inspector for Primary agent" })).not.toHaveTextContent("Current activity");
  });

  it("renders a bounded long RTL, CJK, and emoji label as text without truncating its meaning", () => {
    const label = "تخطيط مرحلة التنفيذ التفصيلية · 詳細な実行段階を計画中 · 🔍".repeat(2);
    render(detail({ ...baseAgent, currentActivity: { ...activity, label } }));

    expect(screen.getByRole("region", { name: "Current provider-reported activity" })).toHaveTextContent(label);
  });

  it("labels retained activity as last observed when lifecycle state is uncertain", () => {
    render(detail({ ...baseAgent, status: "unknown", currentActivity: activity, liveness: {
      source: "structured_lifecycle",
      observedAt: activity.observedAt,
      evidence: "unavailable",
      freshness: "stale",
      reason: "legacy_snapshot",
    } }));
    expect(screen.getByRole("region", { name: "Last observed provider-reported activity" })).toHaveTextContent("Last observed activity");
    expect(screen.getByRole("region", { name: "Last observed provider-reported activity" })).toHaveTextContent(activity.label);
  });
});
