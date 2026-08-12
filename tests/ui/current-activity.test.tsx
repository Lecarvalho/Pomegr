import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Agent, ExecutionTask } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

const activity = {
  label: "Planning detailed shell stage logging",
  observedAt: "2026-08-12T12:00:05.000Z",
};

const baseAgent: Agent = {
  id: "primary",
  parentId: null,
  label: "Primary agent",
  kind: "orchestrator",
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
  tokens: { total: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
};

const task: ExecutionTask = {
  id: "shell-1",
  label: "Run verification",
  kind: "shell",
  status: "running",
  background: false,
  backgroundId: null,
  startedAt: "2026-08-12T12:00:02.000Z",
  finishedAt: null,
  exitCode: null,
  failureCause: null,
  signal: null,
};

function panel(agent: Agent, historical = false) {
  return <LiveClockProvider running={false}><AgentActivityPanel agents={[agent]} executionTasks={[]} planTasks={[]} historical={historical} /></LiveClockProvider>;
}

describe("current agent activity", () => {
  it("keeps Activity & Execution available with only provider-reported current activity", async () => {
    const user = userEvent.setup();
    render(panel({ ...baseAgent, currentActivity: activity }));

    const trigger = screen.getByRole("button", { name: "Current activity" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Activity and execution for Primary agent" });
    expect(dialog).toHaveTextContent("ACTIVITY & EXECUTION");
    expect(screen.getByRole("region", { name: "Current provider-reported activity" })).toHaveTextContent(activity.label);
    expect(dialog).toHaveTextContent("Provider-reported");
    expect(dialog).toHaveTextContent("0 running · 0 finished");
    expect(dialog).not.toHaveTextContent("Shell");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows current activity above shell execution without changing execution counts or labels", async () => {
    const user = userEvent.setup();
    render(panel({ ...baseAgent, currentActivity: activity, executionTasks: [task] }));

    await user.click(screen.getByRole("button", { name: "1 running" }));
    const dialog = screen.getByRole("dialog", { name: "Activity and execution for Primary agent" });
    expect(dialog).toHaveTextContent("1 running · 0 finished");
    expect(dialog).toHaveTextContent(activity.label);
    expect(dialog).toHaveTextContent("Run verification");
    const sections = dialog.querySelectorAll(".executionTaskSection");
    expect(sections[0]).toHaveTextContent("Current activity");
    expect(sections[1]).toHaveTextContent("Running");
  });

  it("preserves tasks-only behavior and never shows stale activity in history", async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel({ ...baseAgent, executionTasks: [task] }));
    await user.click(screen.getByRole("button", { name: "1 running" }));
    expect(screen.getByRole("dialog", { name: "Activity and execution for Primary agent" })).not.toHaveTextContent("Current activity");

    rerender(panel({ ...baseAgent, currentActivity: activity }, true));
    expect(screen.queryByRole("button", { name: "Current activity" })).not.toBeInTheDocument();
  });

  it("renders a bounded long RTL, CJK, and emoji label as text without truncating its meaning", async () => {
    const user = userEvent.setup();
    const label = "تخطيط مرحلة التنفيذ التفصيلية · 詳細な実行段階を計画中 · 🔍".repeat(2);
    render(panel({ ...baseAgent, currentActivity: { ...activity, label } }));
    await user.click(screen.getByRole("button", { name: "Current activity" }));

    expect(screen.getByRole("region", { name: "Current provider-reported activity" })).toHaveTextContent(label);
  });
});
