import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Activity, ExecutionTask } from "../../shared/monitor-contract";
import { ExecutionTaskRow } from "../../app/components/ExecutionTaskRow";
import { ActivityPanel } from "../../app/components/dashboard/ActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

describe("work-kind icons", () => {
  it("renders the normalized purpose in recorded activity without replacing the label", () => {
    const activity: Activity[] = [{
      id: "push-1",
      timestamp: "2026-08-28T12:00:00.000Z",
      actor: "Primary agent",
      tool: "Shell",
      workKind: "git_push",
      detail: "Push branch",
      status: null,
    }];
    const { container, getByText } = render(<ActivityPanel activity={activity} historical loading={false} onRefresh={() => {}} />);
    expect(getByText("Shell")).toBeInTheDocument();
    expect(container.querySelector('.activityAction .workKindIcon[data-work-kind="git_push"]')).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps task purpose and completion state as separate visual layers", () => {
    const task: ExecutionTask = {
      id: "test-1",
      label: "Run tests",
      kind: "shell",
      workKind: "test",
      status: "completed",
      background: false,
      backgroundId: null,
      startedAt: "2026-08-28T12:00:00.000Z",
      finishedAt: "2026-08-28T12:00:05.000Z",
      exitCode: 0,
      failureCause: null,
      signal: null,
    };
    const { container } = render(<LiveClockProvider running={false}><ExecutionTaskRow task={task} /></LiveClockProvider>);
    expect(container.querySelector('.executionTaskMark .workKindIcon[data-work-kind="test"]')).toBeInTheDocument();
    expect(container.querySelector(".executionTaskStatusBadge svg")).toBeInTheDocument();
  });
});
