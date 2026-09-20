import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ExecutionTask } from "../../shared/monitor-contract";
import type { ActivityRequestGroup } from "../../shared/session-history-contract";
import { ExecutionTaskRow } from "../../app/components/ExecutionTaskRow";
import { ActivityFeedPanel } from "../../app/components/dashboard/activity-feed/ActivityFeedPanel";
import type { ActivityFeedView } from "../../app/components/dashboard/activity-feed/useActivityFeed";
import { useSessionRequestSelection } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent } from "./dashboard-test-fixtures";
import { historyCall, historyRequest } from "./activities-test-server";

function feedView(groups: ActivityRequestGroup[]): ActivityFeedView {
  return {
    status: "ready", correlated: true, groups, byKind: [], shellTasks: { total: 0, failed: 0 },
    requestTotal: groups.length, callTotal: groups.reduce((sum, group) => sum + group.calls.length, 0),
    revision: "1", loadMore: () => {}, loadingMore: null, retry: () => {},
  };
}

function ActivityWithSelection({ groups }: { groups: ActivityRequestGroup[] }) {
  const selection = useSessionRequestSelection({ agents: [agent], requestSnapshots: { status: "ready", items: [] }, contextBoundaries: [], historical: false, sessionId: "work-kind-icons" });
  return <ActivityFeedPanel selection={selection} feed={feedView(groups)} agents={[agent]} busy={false} cacheWriteAvailable onOpenAgent={() => {}} />;
}

describe("work-kind icons", () => {
  it("renders reply and summary metadata in a request group", () => {
    const request = historyRequest(1);
    const calls = [
      historyCall("call-reply", request, "report", 1, { tool: "Assistant replied", detail: "" }),
      historyCall("call-summary", request, "report", 2, { tool: "Summary updated", detail: "" }),
    ];
    const group: ActivityRequestGroup = { request, calls, noMatchingCalls: false, continuation: null };
    const { container, getByText } = render(<LiveClockProvider running={false}><ActivityWithSelection groups={[group]} /></LiveClockProvider>);
    expect(getByText("Activity feed")).toBeInTheDocument();
    expect([...container.querySelectorAll(".activityActionLabel")].map((node) => node.textContent)).toEqual(["Assistant replied", "Summary updated"]);
    expect([...container.querySelectorAll(".target")].map((node) => node.textContent)).toEqual(["—", "—"]);
    expect(getByText("Primary agent")).toBeInTheDocument();
  });

  it("renders the normalized purpose in recorded activity without replacing the label", () => {
    const request = historyRequest(1);
    const call = historyCall("call-push", request, "git_push", 1, { tool: "Shell", detail: "Push branch" });
    const group: ActivityRequestGroup = { request, calls: [call], noMatchingCalls: false, continuation: null };
    const { container, getByText } = render(<LiveClockProvider running={false}><ActivityWithSelection groups={[group]} /></LiveClockProvider>);
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
