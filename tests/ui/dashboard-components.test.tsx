import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ExecutionTask, MonitorState, SessionSummary } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { SessionSidebar } from "../../app/components/dashboard/SessionSidebar";
import { UsageLimitsPanel } from "../../app/components/dashboard/UsageLimitsPanel";
import { ContextGrowthTimeline } from "../../app/components/dashboard/ContextGrowthTimeline";
import { RepositoryPanel } from "../../app/components/dashboard/RepositoryPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

const task: ExecutionTask = {
  id: "task-1",
  label: "Run verification",
  kind: "shell",
  status: "completed",
  background: true,
  backgroundId: "7",
  startedAt: "2026-08-08T12:00:00.000Z",
  finishedAt: "2026-08-08T12:00:05.000Z",
  exitCode: 0,
  signal: null,
};

const agent: Agent = {
  id: "primary",
  parentId: null,
  label: "Primary agent",
  kind: "primary",
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
  tokens: { total: 1200, input: 100, output: 100, cacheWrite: 500, cacheRead: 500 },
};

function repositorySession(
  repository: NonNullable<MonitorState["session"]>["repository"],
  pullRequests: NonNullable<MonitorState["session"]>["pullRequests"] = { status: "ready", checkedAt: null, items: [] },
) {
  return {
    id: "session-1",
    title: "Repository work",
    project: "threadlight",
    cwd: "C:\\Workspace\\repos\\threadlight",
    repository,
    pullRequests,
    startedAt: null,
    updatedAt: null,
    durationMs: 0,
    cost: null,
    contextMachinery: null,
    summary: null,
    signal: null,
  } satisfies NonNullable<MonitorState["session"]>;
}

describe("repository branch overview", () => {
  it("shows recent commits and upstream status on the main branch", () => {
    const session = repositorySession({
      available: true,
      branch: "main",
      files: [],
      historical: false,
      isMain: true,
      comparison: { branch: "origin/main", kind: "upstream", ahead: 1, behind: 0, integrated: false },
      commits: [{ hash: "abc1234", subject: "Add commit history", committedAt: "2026-08-09T12:00:00.000Z" }],
      remote: { status: "ready", checkedAt: "2026-08-09T12:01:00.000Z" },
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByRole("region", { name: "Git branch overview" })).toHaveTextContent("RECENT COMMITS");
    expect(screen.getByText("1 ahead vs origin/main")).toBeInTheDocument();
    expect(screen.getByText("Add commit history")).toBeInTheDocument();
    expect(screen.getByText("No local changes.")).toBeInTheDocument();
    expect(screen.queryByText("Working tree clean")).not.toBeInTheDocument();
  });

  it("shows branch-only commits relative to the default branch", () => {
    const session = repositorySession({
      available: true,
      branch: "feature/commits",
      files: [{ status: " M", path: "app/Dashboard.tsx" }],
      historical: false,
      isMain: false,
      comparison: { branch: "origin/main", kind: "base", ahead: 2, behind: 1, integrated: false },
      commits: [{ hash: "def5678", subject: "Consolidate branch state", committedAt: null }],
      remote: { status: "ready", checkedAt: "2026-08-09T12:01:00.000Z" },
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByText("COMMITS SINCE ORIGIN/MAIN")).toBeInTheDocument();
    expect(screen.getByText("2 ahead · 1 behind relative to origin/main")).toBeInTheDocument();
    expect(screen.getByText("Consolidate branch state")).toBeInTheDocument();
    expect(screen.getByText("Dashboard.tsx")).toBeInTheDocument();
    expect(screen.queryByText("1 uncommitted")).not.toBeInTheDocument();
  });

  it("shows remote progress without using stale comparison data", () => {
    const session = repositorySession({
      available: true,
      branch: "feature/commits",
      files: [],
      historical: false,
      isMain: false,
      comparison: null,
      commits: [],
      remote: { status: "checking", checkedAt: null },
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByText("Checking remote…")).toBeInTheDocument();
    expect(screen.getByText("Checking the remote default branch…")).toBeInTheDocument();
    expect(screen.queryByText(/relative to/)).not.toBeInTheDocument();
  });

  it("labels squash-merged changes as integrated", () => {
    const session = repositorySession({
      available: true,
      branch: "feature/squash-merged",
      files: [],
      historical: false,
      isMain: false,
      comparison: { branch: "origin/main", kind: "base", ahead: 0, behind: 1, integrated: true },
      commits: [],
      remote: { status: "ready", checkedAt: "2026-08-09T12:01:00.000Z" },
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByText("Changes integrated into origin/main")).toBeInTheDocument();
    expect(screen.getByText("UNMERGED BRANCH COMMITS")).toBeInTheDocument();
    expect(screen.getByText("Branch changes are already integrated into origin/main.")).toBeInTheDocument();
    expect(screen.queryByText(/ahead/)).not.toBeInTheDocument();
  });

  it("lets a matching merged pull request replace the integrated comparison badge", () => {
    const session = repositorySession({
      available: true,
      branch: "feature/merged-pr",
      files: [],
      historical: false,
      isMain: false,
      comparison: { branch: "origin/main", kind: "base", ahead: 0, behind: 1, integrated: true },
      commits: [],
      remote: { status: "ready", checkedAt: "2026-08-10T12:01:00.000Z" },
    }, {
      status: "ready",
      checkedAt: "2026-08-10T12:02:00.000Z",
      items: [{
        host: "github",
        repository: "ThreadlightHQ/threadlight",
        number: 42,
        title: "Merge the completed feature",
        url: "https://github.com/ThreadlightHQ/threadlight/pull/42",
        state: "merged",
        draft: false,
        headBranch: "feature/merged-pr",
        baseBranch: "main",
        additions: 20,
        deletions: 4,
        updatedAt: "2026-08-10T12:00:00.000Z",
        association: "session",
      }],
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByRole("button", { name: "merged PR #42" })).toBeInTheDocument();
    expect(screen.queryByText("Changes integrated into origin/main")).not.toBeInTheDocument();
  });

  it("opens a dismissible pull-request view from the repository header", async () => {
    const user = userEvent.setup();
    const session = repositorySession({
      available: true,
      branch: "feature/pr-drawer",
      files: [],
      historical: false,
      isMain: false,
      comparison: { branch: "origin/main", kind: "base", ahead: 1, behind: 0, integrated: false },
      commits: [],
      remote: { status: "ready", checkedAt: "2026-08-10T12:01:00.000Z" },
    }, {
      status: "ready",
      checkedAt: "2026-08-10T12:02:00.000Z",
      items: [{
        host: "github",
        repository: "ThreadlightHQ/threadlight",
        number: 42,
        title: "Add session pull-request view",
        url: "https://github.com/ThreadlightHQ/threadlight/pull/42",
        state: "open",
        draft: false,
        headBranch: "feature/pr-drawer",
        baseBranch: "main",
        additions: 447,
        deletions: 22,
        updatedAt: "2026-08-10T12:00:00.000Z",
        association: "session",
      }],
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    await user.click(screen.getByRole("button", { name: "open PR #42" }));
    const dialog = screen.getByRole("dialog", { name: "Pull requests linked to this session" });
    expect(dialog).toHaveTextContent("Add session pull-request view");
    expect(dialog).toHaveTextContent("ThreadlightHQ/threadlight · #42 · recorded in session");
    expect(dialog).toHaveTextContent("feature/pr-drawer → main");
    expect(dialog).toHaveTextContent("+447");
    expect(dialog).toHaveTextContent("−22");
    expect(screen.getByRole("link", { name: /Add session pull-request view/ })).toHaveAttribute("href", "https://github.com/ThreadlightHQ/threadlight/pull/42");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Pull requests linked to this session" })).not.toBeInTheDocument();
  });
});

describe("agent detail popovers", () => {
  it("keeps detail popovers mutually exclusive and dismisses them", async () => {
    const user = userEvent.setup();
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[agent]} executionTasks={[]} planTasks={[{ id: "plan-1", subject: "Refactor dashboard", status: "in_progress", blocks: [], blockedBy: [] }]} historical={false} /></LiveClockProvider>);

    await user.click(screen.getByRole("button", { name: "1 skill" }));
    expect(screen.getByRole("dialog", { name: "Skills used by Primary agent" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "1 shell tasks" }));
    expect(screen.queryByRole("dialog", { name: "Skills used by Primary agent" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Background tasks for Primary agent" })).toHaveTextContent("Run verification");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "1 plan items" }));
    const planDialog = screen.getByRole("dialog", { name: "Claude plan checklist" });
    fireEvent.pointerDown(planDialog);
    expect(planDialog).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ticks live wall time in the browser and freezes when monitoring stops", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:00:05.000Z");
    const activeAgent = { ...agent, status: "active" as const, durationMs: 1_000 };
    const livePanel = (running: boolean) => <LiveClockProvider running={running}><AgentActivityPanel agents={[activeAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>;
    const { rerender } = render(livePanel(true));

    expect(screen.getByText("5s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("6s")).toBeInTheDocument();

    rerender(livePanel(false));
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByText("6s")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("session sidebar", () => {
  const sessions: SessionSummary[] = [
    { id: "live-1", title: "Live work", project: "Threadlight", updatedAt: "2026-08-08T12:00:00.000Z", isLive: true, needsInput: true },
    { id: "old-1", title: "Older work", project: "Threadlight", updatedAt: "2026-08-07T12:00:00.000Z", isLive: false, needsInput: false },
  ];

  it("selects sessions, expands history, and closes on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<LiveClockProvider running={false}><SessionSidebar open sessions={sessions} selectedSessionId={null} currentSessionId="live-1" viewingHistory={false} onClose={onClose} onSelect={onSelect} /></LiveClockProvider>);

    await user.click(screen.getByRole("button", { name: /Live work/ }));
    expect(onSelect).toHaveBeenCalledWith(sessions[0]);

    await user.click(screen.getByRole("button", { name: /^Threadlight1$/ }));
    await user.click(screen.getByRole("button", { name: /Older work/ }));
    expect(onSelect).toHaveBeenLastCalledWith(sessions[1]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("usage-limit clock", () => {
  it("counts down from the shared frontend clock and freezes with it", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:00:00.000Z");
    const usageLimits = {
      available: true,
      fetchedAt: "2026-08-08T12:00:00.000Z",
      attemptedAt: "2026-08-08T12:00:00.000Z",
      limits: [{ id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: "2026-08-08T12:02:00.000Z", severity: "normal", active: true }],
    };
    const panelRender = vi.fn();
    const UsagePanelProbe = () => {
      panelRender();
      return <UsageLimitsPanel usageLimits={usageLimits} />;
    };
    const panel = (running: boolean) => <LiveClockProvider running={running}><UsagePanelProbe /></LiveClockProvider>;
    const { rerender } = render(panel(true));

    expect(screen.getByText("Resets in 2m")).toBeInTheDocument();
    expect(screen.getByText(/Last updated:/)).toHaveTextContent("Last updated: just now");
    expect(screen.queryByText(/Checked|Refresh failed|retrying|\d+s ago/i)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Resets in 1m")).toBeInTheDocument();
    expect(screen.getByText(/Last updated:/)).toHaveTextContent("Last updated: 1 minute ago");
    expect(panelRender).toHaveBeenCalledTimes(1);

    rerender(panel(false));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Resets in 1m")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("estimated session cost", () => {
  it("shows the estimate beneath current context", () => {
    render(<ContextGrowthTimeline
      timeline={{ bucketMs: 0, buckets: [] }}
      currentTokens={{ allAgents: 1_200, input: 100, output: 100, cacheWrite: 500, cacheRead: 500, contextGrowthTimeline: { bucketMs: 0, buckets: [] } }}
      cost={{ amount: 1.2345, currency: "USD", type: "estimated", observedAt: "2026-08-09T12:00:00.000Z" }}
      historical={false}
    />);

    expect(screen.getByText("current context")).toBeInTheDocument();
    expect(screen.getByText("Est. cost $1.23")).toBeInTheDocument();
  });

  it("omits the estimate when Claude Code has not supplied one", () => {
    render(<ContextGrowthTimeline
      timeline={{ bucketMs: 0, buckets: [] }}
      currentTokens={{ allAgents: 1_200, input: 100, output: 100, cacheWrite: 500, cacheRead: 500, contextGrowthTimeline: { bucketMs: 0, buckets: [] } }}
      cost={null}
      historical={false}
    />);

    expect(screen.queryByText(/Est\. cost/)).not.toBeInTheDocument();
  });
});
