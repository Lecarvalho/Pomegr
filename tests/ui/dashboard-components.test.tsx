import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ExecutionTask, MonitorState, SessionSummary } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { SessionSidebar } from "../../app/components/dashboard/SessionSidebar";
import { UsageLimitsPanel } from "../../app/components/dashboard/UsageLimitsPanel";
import { ContextGrowthTimeline } from "../../app/components/dashboard/ContextGrowthTimeline";
import { ResourceUsagePanel } from "../../app/components/dashboard/ResourceUsagePanel";
import { RepositoryPanel } from "../../app/components/dashboard/RepositoryPanel";
import { SessionHero } from "../../app/components/dashboard/SessionHero";
import { MachineryPanel } from "../../app/components/dashboard/MachineryPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

const claudeCapabilities = {
  approvalMode: true,
  automaticCompactions: true,
  contextMachinery: true,
  estimatedCost: true,
  liveSessions: true,
  needsInput: true,
  planTasks: true,
  sessionSummary: true,
  signals: true,
  usageLimits: true,
} as const;

const codexCapabilities = {
  ...claudeCapabilities,
  contextMachinery: false,
  estimatedCost: false,
  sessionSummary: false,
} as const;

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
  failureCause: null,
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
  } satisfies NonNullable<MonitorState["session"]>;
}

describe("session approval mode", () => {
  it("uses coarse early-session timing without redundant last-event copy", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-11T12:00:14.000Z");
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      startedAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("Less than 1m")).toBeInTheDocument();
    expect(screen.queryByText(/Last event/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\b(?:0m|14s ago)\b/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows the current provider-reported approval mode without a redundant observation age", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      approvalMode: { id: "auto", label: "Auto mode", observedAt: "2026-08-10T12:00:00.000Z", source: "provider" },
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("APPROVAL MODE")).toBeInTheDocument();
    const approvalMode = screen.getByText("Auto mode");
    expect(approvalMode).toHaveAttribute("title", "Latest recognized provider-reported mode.");
    expect(approvalMode.tagName).toBe("STRONG");
    expect(approvalMode).toHaveClass("sessionApprovalModeValue");
    expect(screen.queryByText(/Observed/)).not.toBeInTheDocument();
  });

  it("keeps the approval-mode slot visible until the provider reports a mode", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      approvalMode: null,
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("APPROVAL MODE")).toBeInTheDocument();
    expect(screen.getByText("Not reported yet")).toHaveAttribute("title", "Waiting for the provider to report an approval mode for this session.");
  });

  it("labels historical approval state as the last recorded mode", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      updatedAt: "2026-08-10T12:05:00.000Z",
      approvalMode: { id: "accept_edits", label: "Accept edits", observedAt: null, source: "provider" },
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical /></LiveClockProvider>);

    expect(screen.getByText("LAST APPROVAL MODE")).toBeInTheDocument();
    expect(screen.getByText("Accept edits")).toHaveAttribute("title", "Last provider-reported mode recorded for this session.");
  });

  it.each([
    ["untrusted", "Untrusted"],
    ["on_request", "On request"],
    ["granular", "Granular"],
    ["never", "Never"],
  ] as const)("renders the Codex %s approval policy through the exhaustive contract", (id, label) => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      approvalMode: { id, label, observedAt: "2026-08-11T12:00:00.000Z", source: "provider" },
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Codex" capabilities={codexCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

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
    expect(screen.getByText("1 commit ahead compared with origin/main")).toBeInTheDocument();
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
    expect(screen.getByText("2 commits ahead · 1 commit behind relative to origin/main")).toBeInTheDocument();
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
        repository: "PomegrHQ/pomegr",
        number: 42,
        title: "Merge the completed feature",
        url: "https://github.com/PomegrHQ/pomegr/pull/42",
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
        repository: "PomegrHQ/pomegr",
        number: 42,
        title: "Add session pull-request view",
        url: "https://github.com/PomegrHQ/pomegr/pull/42",
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
    expect(dialog).toHaveTextContent("PomegrHQ/pomegr · #42 · recorded in session");
    expect(dialog).toHaveTextContent("feature/pr-drawer → main");
    expect(dialog).toHaveTextContent("+447");
    expect(dialog).toHaveTextContent("−22");
    expect(screen.getByRole("link", { name: /Add session pull-request view/ })).toHaveAttribute("href", "https://github.com/PomegrHQ/pomegr/pull/42");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Pull requests linked to this session" })).not.toBeInTheDocument();
  });
});

describe("reported signal tooltips", () => {
  it("shows a session signal description on desktop hover", async () => {
    const user = userEvent.setup();
    const signaledSession = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      signal: {
        label: "Review complete",
        tone: "positive" as const,
        reportedAt: "2026-08-08T12:00:05.000Z",
        description: "All requested checks passed.",
      },
    };

    render(<LiveClockProvider running={false}><SessionHero session={signaledSession} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    const trigger = screen.getByRole("button", { name: "Review complete" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(trigger);
    expect(screen.getByRole("tooltip")).toHaveClass("tooltipPopover", "signalTooltip");
    expect(screen.getByRole("tooltip")).toHaveTextContent("All requested checks passed.");
    await user.unhover(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("toggles an agent signal description on touch and dismisses it", () => {
    const signaledAgent = {
      ...agent,
      signal: {
        label: "Approved",
        tone: "positive" as const,
        reportedAt: "2026-08-08T12:00:05.000Z",
        description: "All requested checks passed.",
      },
    };

    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[signaledAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    const trigger = screen.getByRole("button", { name: "Approved" });
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.pointerUp(trigger, { pointerType: "touch" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("All requested checks passed.");
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});

describe("agent detail popovers", () => {
  it("shows a privacy-safe cause tooltip for a failed shell task", async () => {
    const user = userEvent.setup();
    const failedTask: ExecutionTask = {
      ...task,
      id: "task-failed",
      label: "Shell command",
      status: "failed",
      exitCode: 1,
      failureCause: "permission_denied",
    };
    const failedAgent = { ...agent, executionTasks: [failedTask] };
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[failedAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    await user.click(screen.getByRole("button", { name: "1 shell task" }));
    const causeTrigger = screen.getByRole("button", { name: /Show failure cause/ });
    await user.hover(causeTrigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent("The command was blocked by a permissions or sandbox restriction. Exit code 1.");
  });

  it("keeps detail popovers mutually exclusive and dismisses them", async () => {
    const user = userEvent.setup();
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[agent]} executionTasks={[]} planTasks={[{ id: "plan-1", subject: "Refactor dashboard", status: "in_progress", blocks: [], blockedBy: [] }]} historical={false} /></LiveClockProvider>);

    await user.click(screen.getByRole("button", { name: "1 skill" }));
    const skillsDialog = screen.getByRole("dialog", { name: "Skills used by Primary agent" });
    expect(skillsDialog).toBeInTheDocument();
    expect(skillsDialog.closest(".agentsPanel")).toHaveClass("hasOpenPopover");

    await user.click(screen.getByRole("button", { name: "1 shell task" }));
    expect(screen.queryByRole("dialog", { name: "Skills used by Primary agent" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Activity and execution for Primary agent" })).toHaveTextContent("Run verification");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector(".agentsPanel")).not.toHaveClass("hasOpenPopover");

    await user.click(screen.getByRole("button", { name: "1 plan item" }));
    const planDialog = screen.getByRole("dialog", { name: "Agent plan checklist" });
    fireEvent.pointerDown(planDialog);
    expect(planDialog).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("labels the live snapshot as context and keeps its last-updated time", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:03:05.000Z");
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[agent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("context")).toBeInTheDocument();
    expect(container.querySelector(".agentRow time")).toHaveTextContent("updated 3m ago");
    expect(container.querySelector(".agentRow time")).toHaveAttribute("dateTime", agent.lastSeen);
    vi.useRealTimers();
  });

  it("ticks live wall time by the minute and freezes when monitoring stops", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:00:59.000Z");
    const activeAgent = { ...agent, status: "active" as const, durationMs: 1_000 };
    const livePanel = (running: boolean) => <LiveClockProvider running={running}><AgentActivityPanel agents={[activeAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>;
    const { rerender } = render(livePanel(true));

    expect(screen.getByText("<1m")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("1m")).toBeInTheDocument();

    rerender(livePanel(false));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("1m")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("session sidebar", () => {
  const sessions: SessionSummary[] = [
    { id: "live-1", provider: "claude", source: "Claude Code", title: "Live work", project: "Pomegr", updatedAt: "2026-08-08T12:00:00.000Z", isLive: true, needsInput: true },
    { id: "old-1", provider: "claude", source: "Claude Code", title: "Older work", project: "Pomegr", updatedAt: "2026-08-07T12:00:00.000Z", isLive: false, needsInput: false },
  ];

  it("selects sessions, expands history, and closes on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<LiveClockProvider running={false}><SessionSidebar open sessions={sessions} selectedSessionId={null} currentSessionId="live-1" viewingHistory={false} onClose={onClose} onSelect={onSelect} /></LiveClockProvider>);

    await user.click(screen.getByRole("button", { name: /Live work/ }));
    expect(onSelect).toHaveBeenCalledWith(sessions[0]);

    await user.click(screen.getByRole("button", { name: /^Pomegr1$/ }));
    await user.click(screen.getByRole("button", { name: /Older work/ }));
    expect(onSelect).toHaveBeenLastCalledWith(sessions[1]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("disambiguates mixed-provider live and historical sessions", async () => {
    const user = userEvent.setup();
    const mixedSessions: SessionSummary[] = [
      sessions[0],
      { id: "codex:live-2", provider: "codex", source: "Codex", title: "Live work", project: "Pomegr", updatedAt: "2026-08-11T12:00:00.000Z", isLive: true, needsInput: false },
      sessions[1],
      { id: "codex:old-2", provider: "codex", source: "Codex", title: "Older work", project: "Pomegr", updatedAt: "2026-08-06T12:00:00.000Z", isLive: false, needsInput: false },
    ];

    render(<LiveClockProvider running={false}><SessionSidebar open sessions={mixedSessions} selectedSessionId={null} currentSessionId={null} viewingHistory={false} onClose={vi.fn()} onSelect={vi.fn()} /></LiveClockProvider>);

    expect(screen.getByRole("button", { name: /Live workClaude Code/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Live workCodex/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Pomegr2$/ }));
    expect(screen.getAllByText("Claude Code")).toHaveLength(2);
    expect(screen.getAllByText("Claude Code").every((label) => label.classList.contains("providerTag") && Boolean(label.querySelector('[data-mark="claude"]')))).toBe(true);
    expect(screen.getAllByText("Codex")).toHaveLength(2);
    expect(screen.getAllByText("Codex").every((label) => label.classList.contains("providerTag") && Boolean(label.querySelector('[data-mark="openai"]')))).toBe(true);
    expect(screen.getAllByRole("button", { name: /Live work/ })).toHaveLength(2);
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
    expect(screen.getByText(/^Updated/)).toHaveTextContent("Updated just now");
    expect(screen.queryByText(/Checked|Refresh failed|retrying|\d+s ago/i)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Resets in 1m")).toBeInTheDocument();
    expect(screen.getByText(/^Updated/)).toHaveTextContent("Updated 1 minute ago");
    expect(panelRender).toHaveBeenCalledTimes(1);

    rerender(panel(false));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Resets in 1m")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("context growth area chart", () => {
  const currentTokens = {
    allAgents: 120,
    input: 30,
    output: 30,
    cacheWrite: 30,
    cacheRead: 30,
    contextGrowthTimeline: { bucketMs: 60_000, buckets: [] },
  };
  const bucket = (start: string, total: number) => ({
    start,
    end: new Date(new Date(start).getTime() + 60_000).toISOString(),
    total,
    input: total / 4,
    cacheWrite: total / 4,
    cacheRead: total / 4,
    output: total / 4,
  });
  const cubicSegments = (path: SVGPathElement) => {
    const curve = path.getAttribute("d")?.split(" L ")[0] || "";
    const values = [...curve.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map(([value]) => Number(value));
    const segments: Array<[number, number, number, number]> = [];
    let startY = values[1];
    for (let index = 2; index + 5 < values.length; index += 6) {
      segments.push([startY, values[index + 1], values[index + 3], values[index + 5]]);
      startY = values[index + 5];
    }
    return segments;
  };
  const cubicValue = ([start, firstControl, secondControl, end]: [number, number, number, number], t: number) => {
    const inverse = 1 - t;
    return inverse ** 3 * start
      + 3 * inverse ** 2 * t * firstControl
      + 3 * inverse * t ** 2 * secondControl
      + t ** 3 * end;
  };

  it.each([
    ["zero", [bucket("2026-08-09T12:00:00.000Z", 0)]],
    ["single", [bucket("2026-08-09T12:00:00.000Z", 120)]],
    ["repeated", [bucket("2026-08-09T12:00:00.000Z", 120), bucket("2026-08-09T12:01:00.000Z", 120), bucket("2026-08-09T12:02:00.000Z", 120)]],
  ])("renders finite %s-value paths", (_, buckets) => {
    const { container } = render(<ContextGrowthTimeline
      timeline={{ bucketMs: 60_000, buckets }}
      currentTokens={{ ...currentTokens, contextGrowthTimeline: { bucketMs: 60_000, buckets } }}
      cost={null}
      estimatedCostSupported={false}
      historical={false}
    />);

    const paths = [...container.querySelectorAll<SVGPathElement>(".contextAreaChart path")];
    expect(paths).toHaveLength(8);
    for (const path of paths) {
      expect(path.getAttribute("d")).not.toMatch(/NaN|Infinity/);
      expect(path.getAttribute("d")).toMatch(/^M 0 /);
    }
    expect([...container.querySelectorAll<SVGPathElement>(".contextArea")].every((path) => path.getAttribute("d")?.includes("L 1000 140"))).toBe(true);
    expect([...container.querySelectorAll<SVGPathElement>(".contextSeriesLine")].every((path) => !path.getAttribute("d")?.includes("L 1000 140"))).toBe(true);
  });

  it("keeps one focusable list item and complete accessible copy per bucket", () => {
    const buckets = [bucket("2026-08-09T12:00:00.000Z", 120), bucket("2026-08-09T12:01:00.000Z", 80)];
    render(<ContextGrowthTimeline
      timeline={{ bucketMs: 60_000, buckets }}
      currentTokens={{ ...currentTokens, contextGrowthTimeline: { bucketMs: 60_000, buckets } }}
      cost={null}
      estimatedCostSupported={false}
      historical={false}
    />);

    const list = screen.getByRole("list", { name: "2 chronological context-growth buckets" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("tabindex", "0");
    expect(items[0]).toHaveAccessibleName(/30 attributed to uncached input, 30 attributed to cache write, 30 attributed to cache read, 30 attributed to generated output/);
    expect(within(items[0]).getByRole("tooltip")).toHaveClass("tooltipPopover", "histogramTooltip");
    expect(screen.getAllByText("120 context added")).toHaveLength(1);
  });

  it("lets the legend toggle each context area independently", async () => {
    const user = userEvent.setup();
    const buckets = [bucket("2026-08-09T12:00:00.000Z", 120)];
    const { container } = render(<ContextGrowthTimeline
      timeline={{ bucketMs: 60_000, buckets }}
      currentTokens={{ ...currentTokens, contextGrowthTimeline: { bucketMs: 60_000, buckets } }}
      cost={null}
      estimatedCostSupported={false}
      historical={false}
    />);

    const inputToggle = screen.getByRole("switch", { name: /Uncached input/ });
    const inputArea = container.querySelector<SVGPathElement>('[data-series="input"]');
    const inputLine = container.querySelector<SVGPathElement>('[data-series-line="input"]');
    const inputPoints = [...container.querySelectorAll<SVGElement>('[data-series-point="input"]')];
    expect(inputToggle).toHaveAttribute("aria-checked", "true");
    expect(inputArea).not.toHaveClass("isHidden");
    expect(inputLine).not.toHaveClass("isHidden");
    expect(inputPoints).toHaveLength(1);
    expect(inputPoints[0]).not.toHaveClass("isHidden");

    await user.click(inputToggle);
    expect(inputToggle).toHaveAttribute("aria-checked", "false");
    expect(inputArea).toHaveClass("isHidden");
    expect(inputLine).toHaveClass("isHidden");
    expect(inputPoints[0]).toHaveClass("isHidden");

    await user.click(inputToggle);
    expect(inputToggle).toHaveAttribute("aria-checked", "true");
    expect(inputArea).not.toHaveClass("isHidden");
    expect(inputLine).not.toHaveClass("isHidden");
    expect(inputPoints[0]).not.toHaveClass("isHidden");
  });

  it("derives the scale and tooltip summary from only the selected metrics", async () => {
    const user = userEvent.setup();
    const buckets = [{
      start: "2026-08-09T12:00:00.000Z",
      end: "2026-08-09T12:01:00.000Z",
      total: 117_000,
      input: 2,
      cacheWrite: 4_229,
      cacheRead: 107_206,
      output: 5_563,
    }];
    const { container } = render(<ContextGrowthTimeline
      timeline={{ bucketMs: 60_000, buckets }}
      currentTokens={{ ...currentTokens, contextGrowthTimeline: { bucketMs: 60_000, buckets } }}
      cost={null}
      estimatedCostSupported={false}
      historical={false}
    />);

    await user.click(screen.getByRole("switch", { name: /Uncached input/ }));
    await user.click(screen.getByRole("switch", { name: /Cache write/ }));
    await user.click(screen.getByRole("switch", { name: /Cache read/ }));

    expect(container.querySelector(".histogramScale span")).toHaveTextContent("5,563");
    expect(screen.getByText("5,563 generated output")).toBeInTheDocument();
    expect(screen.queryByText("117k context added")).not.toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveAccessibleName(/5,563 attributed to generated output/);
  });

  it("keeps adversarial metric lines bounded throughout every curve", () => {
    const inputs = [28, 72, 57, 48];
    const writes = [2, 6, 90, 75];
    const reads = [60, 1, 4, 40];
    const outputs = [5, 80, 2, 20];
    const buckets = inputs.map((input, index) => ({
      start: new Date(Date.parse("2026-08-09T12:00:00.000Z") + index * 60_000).toISOString(),
      end: new Date(Date.parse("2026-08-09T12:01:00.000Z") + index * 60_000).toISOString(),
      input,
      cacheWrite: writes[index],
      cacheRead: reads[index],
      output: outputs[index],
      total: input + writes[index] + reads[index] + outputs[index],
    }));
    const { container } = render(<ContextGrowthTimeline
      timeline={{ bucketMs: 60_000, buckets }}
      currentTokens={{ ...currentTokens, contextGrowthTimeline: { bucketMs: 60_000, buckets } }}
      cost={null}
      estimatedCostSupported={false}
      historical={false}
    />);

    const paths = ["output", "cacheRead", "cacheWrite", "input"].map((series) => (
      container.querySelector<SVGPathElement>(`.contextAreaChart [data-series-line="${series}"]`)!
    ));
    const curves = paths.map(cubicSegments);
    expect(curves.every((curve) => curve.length === curves[0].length)).toBe(true);
    for (const curve of curves) {
      for (const segment of curve) {
        const lowerBound = Math.min(segment[0], segment[3]);
        const upperBound = Math.max(segment[0], segment[3]);
        for (let sample = 0; sample <= 100; sample += 1) {
          const y = cubicValue(segment, sample / 100);
          expect(y).toBeGreaterThanOrEqual(lowerBound - 1e-8);
          expect(y).toBeLessThanOrEqual(upperBound + 1e-8);
        }
      }
    }
  });
});

describe("live resource usage panel", () => {
  const gibibyte = 1024 ** 3;
  const mebibyte = 1024 ** 2;
  const readyResources = {
    status: "ready",
    reason: null,
    current: {
      cpuCores: 1.75,
      cpuMachinePercent: 10.94,
      memoryBytes: 3 * gibibyte,
      readBytesPerSecond: 2 * mebibyte,
      writeBytesPerSecond: mebibyte,
    },
    observedPeak: { memoryBytes: 4.25 * gibibyte },
    samples: [
      { timestamp: "2026-08-14T12:00:00.000Z", cpuCores: 0.5, cpuMachinePercent: 3.1, memoryBytes: 2 * gibibyte, readBytesPerSecond: 0, writeBytesPerSecond: 256 * 1024 },
      { timestamp: "2026-08-14T12:01:00.000Z", cpuCores: null, cpuMachinePercent: null, memoryBytes: 2.5 * gibibyte, readBytesPerSecond: null, writeBytesPerSecond: null },
      { timestamp: "2026-08-14T12:02:00.000Z", cpuCores: 1.75, cpuMachinePercent: 10.94, memoryBytes: 3 * gibibyte, readBytesPerSecond: 2 * mebibyte, writeBytesPerSecond: mebibyte },
    ],
  } satisfies NonNullable<MonitorState["metrics"]["resources"]>;

  it("renders current values, observed memory peak, and separate read/write telemetry", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    render(<ResourceUsagePanel resources={readyResources} />);

    expect(screen.getAllByText("1.8 cores")).toHaveLength(3);
    expect(screen.getByText("11% of machine")).toBeInTheDocument();
    expect(screen.getAllByText("3.0 GiB")).toHaveLength(3);
    expect(screen.getByText("Observed peak 4.3 GiB")).toBeInTheDocument();
    expect(screen.getAllByText("3.0 MiB/s")).toHaveLength(2);
    expect(screen.getByText(/2.0 MiB\/s read/)).toHaveTextContent(/1.0 MiB\/s write/);
    expect(screen.getAllByText("Read")).toHaveLength(2);
    expect(screen.getAllByText("Write")).toHaveLength(2);
  });

  it("keeps sampling frequency and measurement age out of the interface", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    render(<ResourceUsagePanel resources={readyResources} />);

    expect(screen.queryByText(/measured|sampled|sampling frequency|every \d|\d+s ago/i)).not.toBeInTheDocument();
  });

  it("shows explicit collecting and unavailable states without fabricated zeroes", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { rerender } = render(<ResourceUsagePanel resources={{
      status: "collecting",
      reason: null,
      current: null,
      observedPeak: null,
      samples: [],
    }} />);

    expect(screen.getByRole("status")).toHaveTextContent("Collecting resource samples");
    expect(screen.queryByText(/0\.0 cores|0 B\/s/)).not.toBeInTheDocument();

    rerender(<ResourceUsagePanel resources={{
      status: "unavailable",
      reason: "shared_owner",
      current: null,
      observedPeak: null,
      samples: [],
    }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Resource use unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("shares a process owner");
    expect(screen.queryByText(/0\.0 cores|0 B\/s/)).not.toBeInTheDocument();
  });

  it("starts open, stores collapse preference, and restores it on remount", async () => {
    window.localStorage.removeItem("pomegr-resource-panel-open");
    const user = userEvent.setup();
    const { container, unmount } = render(<ResourceUsagePanel resources={readyResources} />);
    const disclosure = container.querySelector("details.resourceUsagePanel");

    expect(disclosure).toHaveAttribute("open");
    await user.click(screen.getByText("Resource use"));
    expect(disclosure).not.toHaveAttribute("open");
    expect(window.localStorage.getItem("pomegr-resource-panel-open")).toBe("false");

    unmount();
    const restored = render(<ResourceUsagePanel resources={readyResources} />).container.querySelector("details.resourceUsagePanel");
    expect(restored).not.toHaveAttribute("open");
  });

  it("uses one chart tab stop and navigates all lanes with arrow keys", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { container } = render(<ResourceUsagePanel resources={readyResources} />);
    const charts = screen.getByRole("group", { name: /Resource use over the last 15 minutes/ });
    const announcement = container.querySelector(".resourceChartAnnouncement");
    const readout = container.querySelector(".resourceChartReadout");

    expect(charts).toHaveAttribute("tabindex", "0");
    expect(charts.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(announcement).toHaveTextContent("CPU 1.8 cores");
    expect(readout).toHaveTextContent("CPU 1.8 cores");
    expect(readout?.querySelector("time")).toHaveAttribute("dateTime", "2026-08-14T12:02:00.000Z");

    fireEvent.keyDown(charts, { key: "ArrowLeft" });
    expect(announcement).toHaveTextContent("CPU Unavailable");
    expect(announcement).toHaveTextContent("Memory 2.5 GiB");
    expect(readout).toHaveTextContent("CPU Unavailable");
    expect(readout).toHaveTextContent("Memory 2.5 GiB");

    fireEvent.keyDown(charts, { key: "Home" });
    expect(announcement).toHaveTextContent("CPU 0.5 cores");

    fireEvent.keyDown(charts, { key: "End" });
    expect(announcement).toHaveTextContent("CPU 1.8 cores");
  });

  it("synchronizes the visible chart readout to pointer position", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { container } = render(<ResourceUsagePanel resources={readyResources} />);
    const charts = screen.getByRole("group", { name: /Resource use over the last 15 minutes/ });
    const readout = container.querySelector(".resourceChartReadout");
    const cpuChart = container.querySelector<SVGSVGElement>(".resourceChartSvg")!;
    vi.spyOn(cpuChart, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 300,
      top: 0,
      width: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerMove(cpuChart, { clientX: 0 });
    expect(readout).toHaveTextContent("CPU 0.5 cores");
    expect(readout?.querySelector("time")).toHaveAttribute("dateTime", "2026-08-14T12:00:00.000Z");

    fireEvent.pointerLeave(charts);
    expect(readout).toHaveTextContent("CPU 1.8 cores");
  });

  it("renders finite straight paths and gaps missing measurements", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { container } = render(<ResourceUsagePanel resources={readyResources} />);
    const paths = [...container.querySelectorAll<SVGPathElement>(".resourceChartLine")];

    expect(paths).toHaveLength(4);
    for (const path of paths) {
      expect(path.getAttribute("d")).not.toMatch(/NaN|Infinity/);
    }
    expect(container.querySelector(".resourceCpuLine")?.getAttribute("d")?.match(/\bM\b/g)).toHaveLength(2);
    expect(container.querySelector(".resourceReadLine")?.getAttribute("d")?.match(/\bM\b/g)).toHaveLength(2);
    expect(container.querySelector(".resourceWriteLine")?.getAttribute("d")?.match(/\bM\b/g)).toHaveLength(2);
  });
});

describe("estimated session cost", () => {
  it("shows the estimate beneath context", () => {
    render(<ContextGrowthTimeline
      timeline={{ bucketMs: 0, buckets: [] }}
      currentTokens={{ allAgents: 1_200, input: 100, output: 100, cacheWrite: 500, cacheRead: 500, contextGrowthTimeline: { bucketMs: 0, buckets: [] } }}
      cost={{ amount: 1.2345, currency: "USD", type: "estimated", observedAt: "2026-08-09T12:00:00.000Z" }}
      estimatedCostSupported
      historical={false}
    />);

    expect(screen.getByText("context")).toBeInTheDocument();
    expect(screen.getByText("Claude Code estimate $1.23")).toBeInTheDocument();
  });

  it("omits the estimate when Claude Code has not supplied one", () => {
    render(<ContextGrowthTimeline
      timeline={{ bucketMs: 0, buckets: [] }}
      currentTokens={{ allAgents: 1_200, input: 100, output: 100, cacheWrite: 500, cacheRead: 500, contextGrowthTimeline: { bucketMs: 0, buckets: [] } }}
      cost={null}
      estimatedCostSupported
      historical={false}
    />);

    expect(screen.queryByText(/Est\. cost/)).not.toBeInTheDocument();
  });

  it("does not show Claude estimate copy when the selected provider lacks cost support", () => {
    render(<ContextGrowthTimeline
      timeline={{ bucketMs: 0, buckets: [] }}
      currentTokens={{ allAgents: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, contextGrowthTimeline: { bucketMs: 0, buckets: [] } }}
      cost={{ amount: 0, currency: "USD", type: "estimated", observedAt: "2026-08-11T12:00:00.000Z" }}
      estimatedCostSupported={false}
      historical={false}
    />);

    expect(screen.queryByText(/Claude Code estimate|status-line|API cost/i)).not.toBeInTheDocument();
  });
});

describe("provider capability gates", () => {
  it.each([
    ["Claude Code", claudeCapabilities, "claude:999b3d6b-24d5-4d66-93b1-38f502f5f811"],
    ["Codex", codexCapabilities, "codex:019ff0fa-1f93-7032-bc0d-ddec9cf3a7e4"],
  ] as const)("shows the full project and local %s session ID without repeating the provider", (source, capabilities, id) => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      id,
      project: "pomegr-observability-dashboard",
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source={source} capabilities={capabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("pomegr-observability-dashboard")).toBeInTheDocument();
    expect(screen.getByText(id.slice(id.indexOf(":") + 1))).toBeInTheDocument();
    expect(screen.queryByText(id)).not.toBeInTheDocument();
  });

  it("labels Codex provenance and uses a provider-neutral unsupported summary state", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      summary: { text: "Unsupported summary must stay hidden", observedAt: null, source: "provider" },
    } satisfies NonNullable<MonitorState["session"]>;
    render(<LiveClockProvider running={false}><SessionHero session={session} source="Codex" capabilities={codexCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("Codex")).toHaveClass("providerTag");
    expect(screen.getByText("Codex").closest(".providerBadge")?.querySelector('[data-mark="openai"]')).toBeInTheDocument();
    expect(screen.getByText("Session summaries are not available for this provider.")).toBeInTheDocument();
    expect(screen.queryByText("Unsupported summary must stay hidden")).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the provider/)).not.toBeInTheDocument();
  });

  it("uses the Claude mark for Claude Code sessions", () => {
    const session = repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } });
    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("Claude Code").closest(".providerBadge")?.querySelector('[data-mark="claude"]')).toBeInTheDocument();
  });

  it("never gives an unsupported provider the Claude /context instruction", () => {
    render(<MachineryPanel machinery={null} supported={false} historical={false} />);

    expect(screen.getByText("Loaded context details are not available for this provider")).toBeInTheDocument();
    expect(screen.queryByText(/\/context/)).not.toBeInTheDocument();
  });

  it("preserves the Claude /context setup copy when the capability is supported", () => {
    render(<MachineryPanel machinery={null} supported historical={false} />);

    expect(screen.getByText("Run /context in the active session to measure the loaded context")).toBeInTheDocument();
  });
});
