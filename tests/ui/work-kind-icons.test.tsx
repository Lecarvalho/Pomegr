import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ActivityFeed, ExecutionTask } from "../../shared/monitor-contract";
import { ExecutionTaskRow } from "../../app/components/ExecutionTaskRow";
import { ActivityPanel } from "../../app/components/dashboard/ActivityPanel";
import { useSessionRequestSelection } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent } from "./dashboard-test-fixtures";

function ActivityWithSelection({ activity, historical }: { activity: ActivityFeed; historical: boolean }) {
  const selection = useSessionRequestSelection({ agents: [agent], requestSnapshots: { status: "ready", items: [] }, contextBoundaries: [], historical, sessionId: "work-kind-icons" });
  return <ActivityPanel activity={activity} historical={historical} loading={false} onRefresh={() => {}} selection={selection} sessionId="work-kind-icons" />;
}

describe("work-kind icons", () => {
  it.each([false, true])("renders reply and summary metadata in activity (historical: %s)", (historical) => {
    const activity: ActivityFeed = {
      items: [
        { id: "summary", timestamp: "2026-08-28T12:04:00.000Z", actor: "System", tool: "Summary updated", workKind: "report", detail: "", status: null, durationMs: null, requestId: null },
        { id: "reply", timestamp: "2026-08-28T12:00:00.000Z", actor: "Primary agent", tool: "Assistant replied", workKind: "report", detail: "", status: null, durationMs: null, requestId: null },
      ],
      total: 2,
      toolCalls: 0,
      byKind: [],
      messages: 2,
      failed: 0,
    };
    const { container, getByText } = render(<ActivityWithSelection activity={activity} historical={historical} />);
    expect(getByText("Activity")).toBeInTheDocument();
    expect([...container.querySelectorAll(".activityAction strong")].map((node) => node.textContent)).toEqual(["Summary updated", "Assistant replied"]);
    expect([...container.querySelectorAll(".target")].map((node) => node.textContent)).toEqual(["—", "—"]);
    expect(getByText("System")).toBeInTheDocument();
    expect(getByText("Primary agent")).toBeInTheDocument();
  });

  it("renders the normalized purpose in recorded activity without replacing the label", () => {
    const activity: ActivityFeed = {
      items: [{
      id: "push-1",
      timestamp: "2026-08-28T12:00:00.000Z",
      actor: "Primary agent",
      tool: "Shell",
      workKind: "git_push",
      detail: "Push branch",
      status: null,
      durationMs: null,
      requestId: null,
      }],
      total: 1,
      toolCalls: 0,
      byKind: [],
      messages: 1,
      failed: 0,
    };
    const { container, getByText } = render(<ActivityWithSelection activity={activity} historical />);
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
