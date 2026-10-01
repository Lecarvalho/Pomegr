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
  it("preserves tasks-only behavior and never shows stale activity in history", () => {
    const { rerender } = render(detail({ ...baseAgent, executionTasks: [task] }));
    expect(screen.getByRole("region", { name: "Agent inspector for Primary agent" })).not.toHaveTextContent("Current activity");

    rerender(detail({ ...baseAgent, currentActivity: activity }, true));
    expect(screen.getByRole("region", { name: "Agent inspector for Primary agent" })).not.toHaveTextContent("Current activity");
  });

  it("renders a running task once when it is the current activity", () => {
    const running = { ...task, label: activity.label };
    render(detail({ ...baseAgent, currentActivity: activity, executionTasks: [running, { ...task, id: "shell-2", label: "Other shell work" }] }));
    expect(screen.getAllByText(activity.label)).toHaveLength(1);
    expect(screen.getByText("Other shell work")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Shell tasks" })).toHaveTextContent("Shell tasks · 1");
  });

  it("labels retained activity as last observed when lifecycle state is uncertain", () => {
    render(detail({ ...baseAgent, status: "unknown", currentActivity: activity, liveness: {
      source: "structured_lifecycle",
      observedAt: activity.observedAt,
      evidence: "unavailable",
      freshness: "stale",
      reason: "legacy_snapshot",
    } }));
    const retainedActivity = screen.getByRole("region", { name: "Last observed provider-reported activity" });
    expect(retainedActivity).toHaveTextContent("Last observed activity");
    expect(retainedActivity).toHaveTextContent(activity.label);
    expect(retainedActivity.querySelector("strong")).not.toHaveClass("currentActivityShimmer");
    expect(retainedActivity.querySelector("strong")).not.toHaveAttribute("data-text");
  });
});
