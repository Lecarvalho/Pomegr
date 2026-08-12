import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ExecutionTask, MonitorState, SessionSummary } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { SessionSidebar } from "../../app/components/dashboard/SessionSidebar";
import { UsageLimitsPanel } from "../../app/components/dashboard/UsageLimitsPanel";
import { ContextGrowthTimeline } from "../../app/components/dashboard/ContextGrowthTimeline";
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
    approvalMode: null,
    contextMachinery: null,
    summary: null,
    signal: null,
  } satisfies NonNullable<MonitorState["session"]>;
}

describe("session approval mode", () => {
  it("uses coarse early-session timing instead of zero minutes or a seconds counter", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-11T12:00:14.000Z");
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      startedAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("Less than 1m")).toBeInTheDocument();
    expect(screen.getByText("Last event less than a minute ago")).toBeInTheDocument();
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
    expect(screen.getByText("Auto mode")).toHaveAttribute("title", "Latest recognized provider-reported mode.");
    expect(screen.queryByText(/Observed/)).not.toBeInTheDocument();
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
  it("shows an agent signal description as the tag tooltip", () => {
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

    expect(screen.getByText("Approved")).toHaveAttribute("title", "All requested checks passed.");
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
    { id: "live-1", provider: "claude", source: "Claude Code", title: "Live work", project: "Threadlight", updatedAt: "2026-08-08T12:00:00.000Z", isLive: true, needsInput: true },
    { id: "old-1", provider: "claude", source: "Claude Code", title: "Older work", project: "Threadlight", updatedAt: "2026-08-07T12:00:00.000Z", isLive: false, needsInput: false },
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

  it("disambiguates mixed-provider live and historical sessions", async () => {
    const user = userEvent.setup();
    const mixedSessions: SessionSummary[] = [
      sessions[0],
      { id: "codex:live-2", provider: "codex", source: "Codex", title: "Live work", project: "Threadlight", updatedAt: "2026-08-11T12:00:00.000Z", isLive: true, needsInput: false },
      sessions[1],
      { id: "codex:old-2", provider: "codex", source: "Codex", title: "Older work", project: "Threadlight", updatedAt: "2026-08-06T12:00:00.000Z", isLive: false, needsInput: false },
    ];

    render(<LiveClockProvider running={false}><SessionSidebar open sessions={mixedSessions} selectedSessionId={null} currentSessionId={null} viewingHistory={false} onClose={vi.fn()} onSelect={vi.fn()} /></LiveClockProvider>);

    expect(screen.getByRole("button", { name: /Live workClaude Code/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Live workCodex/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Threadlight2$/ }));
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

describe("estimated session cost", () => {
  it("shows the estimate beneath current context", () => {
    render(<ContextGrowthTimeline
      timeline={{ bucketMs: 0, buckets: [] }}
      currentTokens={{ allAgents: 1_200, input: 100, output: 100, cacheWrite: 500, cacheRead: 500, contextGrowthTimeline: { bucketMs: 0, buckets: [] } }}
      cost={{ amount: 1.2345, currency: "USD", type: "estimated", observedAt: "2026-08-09T12:00:00.000Z" }}
      estimatedCostSupported
      historical={false}
    />);

    expect(screen.getByText("current context")).toBeInTheDocument();
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
      project: "threadlight-observability-dashboard",
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source={source} capabilities={capabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("threadlight-observability-dashboard")).toBeInTheDocument();
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
