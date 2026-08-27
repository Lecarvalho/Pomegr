import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ExecutionTask, MonitorState, SessionSummary } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { SessionSidebar } from "../../app/components/dashboard/SessionSidebar";
import { UsageLimitsPanel } from "../../app/components/dashboard/UsageLimitsPanel";
import { ContextHistoryPanel } from "../../app/components/dashboard/ContextHistoryPanel";
import { monotonePath, RequestSnapshotsPanel, snapshotEventKey } from "../../app/components/dashboard/RequestSnapshotsPanel";
import { ResourceUsagePanel } from "../../app/components/dashboard/ResourceUsagePanel";
import { RepositoryPanel } from "../../app/components/dashboard/RepositoryPanel";
import { SessionDetailsPanel } from "../../app/components/dashboard/SessionDetailsPanel";
import { SessionHero } from "../../app/components/dashboard/SessionHero";
import { SessionProgressPanel } from "../../app/components/dashboard/SessionProgressPanel";
import { MachineryPanel } from "../../app/components/dashboard/MachineryPanel";
import { InsightsPanel } from "../../app/components/dashboard/InsightsPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";

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
  workflowId: null,
  workflowPhaseId: null,
  workflowOrder: null,
  workflowState: null,
  label: "Primary agent",
  role: "orchestrator",
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

describe("efficiency signal semantics", () => {
  it("uses a warning triangle instead of a positive check for warning signals", () => {
    const { container } = render(<InsightsPanel insights={[{
      id: "automatic-compaction-primary",
      level: "warning",
      title: "Primary agent context was automatically compacted",
      detail: "Earlier conversation detail was summarized.",
    }]} />);

    expect(container.querySelector(".insight.warning .insightWarningIcon")).toBeInTheDocument();
    expect(container.querySelector(".insight.warning .insightCheckIcon")).not.toBeInTheDocument();
  });
});

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
    progress: null,
    pomegrPlugin: null,
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

describe("agent assignment hierarchy", () => {
  it("shows the assignment first and preserves the codename as secondary identity", () => {
    const assignedAgent: Agent = {
      ...agent,
      id: "agent-erdos",
      parentId: "primary",
      assignment: "Trace cli title",
      label: "Erdos",
      role: "explore",
    };

    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[assignedAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    const row = screen.getByRole("listitem", { name: "Trace cli title — Erdos agent" });
    expect(within(row).getByText("Trace cli title").tagName).toBe("STRONG");
    expect(within(row).getByText("Erdos")).toHaveClass("agentMetaIdentity");
    expect(within(row).getByText("explore")).toHaveClass("agentMetaKind");
  });

  it("does not repeat an assignment that matches the codename", () => {
    const duplicateAgent: Agent = { ...agent, assignment: "Primary agent" };

    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[duplicateAgent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    expect(screen.getAllByText("Primary agent")).toHaveLength(1);
    expect(document.querySelector(".agentMetaIdentity")).not.toBeInTheDocument();
  });
});

describe("agent detail popovers", () => {
  it("copies a subagent transcript path on demand without rendering the path", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path: "C:\\Users\\Leandro\\.codex\\sessions\\child.jsonl" }),
    });
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.stubGlobal("fetch", fetchMock);
    const childAgent: Agent = {
      ...agent,
      id: "agent-child",
      parentId: "primary",
      label: "Builder",
      transcriptAvailable: true,
    };

    try {
      render(<LiveClockProvider running={false}><AgentActivityPanel agents={[childAgent]} executionTasks={[]} planTasks={[]} historical={false} sessionId="claude:session-1" /></LiveClockProvider>);
      await user.click(screen.getByRole("button", { name: "1 shell task" }));
      const dialog = screen.getByRole("dialog", { name: "Agent activity for Builder" });
      const copyButton = screen.getByRole("button", { name: "Copy transcript path for Builder" });

      await user.click(copyButton);

      await waitFor(() => expect(writeText).toHaveBeenCalledWith("C:\\Users\\Leandro\\.codex\\sessions\\child.jsonl"));
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/transcript-path?sessionId=claude%3Asession-1&agentId=agent-child",
        { cache: "no-store" },
      );
      expect(screen.getByRole("button", { name: "Transcript path copied for Builder" })).toHaveClass("copied");
      expect(screen.getByRole("status")).toHaveTextContent("Transcript path for Builder copied.");
      expect(dialog).not.toHaveTextContent("C:\\Users\\Leandro\\.codex\\sessions\\child.jsonl");
    } finally {
      vi.unstubAllGlobals();
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    }
  });

  it("offers transcript details even when a subagent has no recorded activity rows", async () => {
    const user = userEvent.setup();
    const transcriptOnlyAgent: Agent = {
      ...agent,
      id: "agent-transcript-only",
      parentId: "primary",
      label: "Investigator",
      transcriptAvailable: true,
      executionTasks: [],
      skills: [],
    };
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[transcriptOnlyAgent]} executionTasks={[]} planTasks={[]} historical={false} sessionId="codex:session-2" /></LiveClockProvider>);

    await user.click(screen.getByRole("button", { name: "Agent details" }));

    const dialog = screen.getByRole("dialog", { name: "Agent activity for Investigator" });
    expect(dialog).toHaveTextContent("0 running · 0 finished");
    expect(screen.getByRole("button", { name: "Copy transcript path for Investigator" })).toBeInTheDocument();
  });

  it("shows approval reviews separately from shell execution", async () => {
    const user = userEvent.setup();
    const reviewer: Agent = {
      ...agent,
      id: "agent-reviewer",
      parentId: "primary",
      label: "Approval reviewer",
      role: "reviewer",
      model: "codex-auto-review",
      effort: "low",
      toolCalls: 0,
      skills: [],
      executionTasks: [],
      reviewDecisions: {
        total: 2,
        allowed: 1,
        denied: 1,
        items: [
          { action: "build_or_test", outcome: "allowed", risk: "medium", durationMs: 4_250, reviewedAt: "2026-08-08T12:00:03.000Z" },
          { action: "file_change", outcome: "denied", risk: "unknown", durationMs: 875, reviewedAt: "2026-08-08T12:00:05.000Z" },
        ],
        truncated: false,
      },
    };
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[reviewer]} executionTasks={[]} planTasks={[]} historical={false} sessionId="codex:guardian" /></LiveClockProvider>);

    await user.click(screen.getByRole("button", { name: "2 reviews" }));

    const dialog = screen.getByRole("dialog", { name: "Agent activity for Approval reviewer" });
    expect(dialog).toHaveTextContent("AGENT ACTIVITY");
    expect(dialog).toHaveTextContent("1 allowed · 1 denied · 0 shell tasks");
    expect(screen.getByRole("region", { name: "Completed approval reviews" })).toHaveTextContent("Review decisions (2)");
    expect(dialog).toHaveTextContent("Allowed");
    expect(dialog).toHaveTextContent("Denied");
    expect(dialog).toHaveTextContent("Build or test");
    expect(dialog).toHaveTextContent("File change");
    expect(dialog).toHaveTextContent("medium risk");
    expect(dialog).toHaveTextContent("risk unavailable");
    expect(dialog).toHaveTextContent("Pomegr category · provider-assessed");
    expect(dialog).toHaveTextContent("reviewed in 4.3s");
    expect(dialog).toHaveTextContent("reviewed in under 1s");
    expect(dialog).not.toHaveTextContent(/command|prompt|rationale/i);
  });

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
    expect(screen.getByRole("dialog", { name: "Agent activity for Primary agent" })).toHaveTextContent("Run verification");

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

  it("labels the live snapshot as latest context and keeps its provenance and last-updated time", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:03:05.000Z");
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[agent]} executionTasks={[]} planTasks={[]} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("latest context")).toBeInTheDocument();
    expect(container.querySelector(".agentTokens")).toHaveAttribute("title", "Latest non-zero provider usage snapshot for this agent; not cumulative token use.");
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
    { id: "live-1", provider: "claude", source: "Claude Code", title: "Live work", project: "Pomegr", updatedAt: "2026-08-08T12:00:00.000Z", isLive: true, needsInput: true, activityStatus: "needs_input" },
    { id: "old-1", provider: "claude", source: "Claude Code", title: "Older work", project: "Pomegr", updatedAt: "2026-08-07T12:00:00.000Z", isLive: false, needsInput: false, activityStatus: "unknown" },
  ];

  it("selects sessions, expands history, and closes on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<LiveClockProvider running={false}><SessionSidebar open sessions={sessions} selectedSessionId={null} currentSessionId="live-1" viewingHistory={false} onClose={onClose} onSelect={onSelect} /></LiveClockProvider>);

    expect(screen.getByRole("link", { name: "Home — open sessions" })).toHaveAttribute("href", "/");
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
      { id: "codex:live-2", provider: "codex", source: "Codex", title: "Live work", project: "Pomegr", updatedAt: "2026-08-11T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working" },
      sessions[1],
      { id: "codex:old-2", provider: "codex", source: "Codex", title: "Older work", project: "Pomegr", updatedAt: "2026-08-06T12:00:00.000Z", isLive: false, needsInput: false, activityStatus: "unknown" },
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
      limits: [{ id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: "2026-08-08T12:02:00.000Z", severity: "normal" as const, active: true }],
    };
    const panelRender = vi.fn();
    const UsagePanelProbe = () => {
      panelRender();
      return <UsageLimitsPanel source="Claude Code" usageLimits={usageLimits} />;
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

  it("asks for provider re-authentication when a retained snapshot refresh receives 401", () => {
    render(<LiveClockProvider running><UsageLimitsPanel
      source="Claude Code"
      usageLimits={{
        available: true,
        fetchedAt: "2026-08-08T05:00:00.000Z",
        attemptedAt: "2026-08-08T12:00:00.000Z",
        error: "Anthropic usage endpoint returned 401",
        limits: [{ id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: null, severity: "normal", active: false }],
      }}
    /></LiveClockProvider>);

    expect(screen.getByRole("status")).toHaveTextContent("Re-authentication needed");
    expect(screen.getByRole("status")).toHaveTextContent("Sign in to Claude Code again. Pomegr will retry automatically.");
    expect(screen.getByText("20%")).toBeInTheDocument();
  });

  it("renders arbitrary usage buckets and critical reached styling", () => {
    const limits = [
      { id: "one", label: "One", window: "1 hour", percent: 100, resetsAt: null, severity: "critical" as const, active: true },
      { id: "two", label: "Two", window: "5 hours", percent: 92, resetsAt: null, severity: "warning" as const, active: false },
      { id: "three", label: "Three", window: "7 days", percent: 40, resetsAt: null, severity: "normal" as const, active: false },
      { id: "four", label: "Four", window: "30 days", percent: 10, resetsAt: null, severity: "normal" as const, active: false },
    ];

    const { container } = render(<LiveClockProvider running><UsageLimitsPanel
      source="Codex"
      usageLimits={{ available: true, fetchedAt: null, attemptedAt: null, limits }}
    /></LiveClockProvider>);

    expect(container.querySelectorAll(".limitCard")).toHaveLength(4);
    expect(container.querySelector(".limitCard.critical")).toHaveTextContent("Active limit");
    expect(container.querySelectorAll(".limitCard.critical")).toHaveLength(2);
    expect(container.querySelectorAll(".limitCard.warning")).toHaveLength(0);
    expect(container.querySelectorAll(".limitCard.normal")).toHaveLength(2);
  });
});

describe("context history", () => {
  const childAgent: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder", tokens: { ...agent.tokens, total: 220_000 } };
  const buckets = [
    { start: "2026-08-09T12:00:00.000Z", end: "2026-08-09T12:01:00.000Z", total: 100_000, agents: [{ agentId: "primary", total: 100_000 }] },
    { start: "2026-08-09T12:01:00.000Z", end: "2026-08-09T12:02:00.000Z", total: 300_000, agents: [{ agentId: "child", total: 220_000 }, { agentId: "primary", total: 80_000 }] },
  ];
  const tokens = {
    allAgents: 300_000,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    contextHistory: { bucketMs: 60_000, buckets, boundaries: [{ id: "boundary-1", agentId: "primary", timestamp: "2026-08-09T12:01:30.000Z", kind: "snapshot_drop" as const, preTokens: 100_000 }] },
    cacheEvents: { status: "ready" as const, items: [] },
    requestSnapshots: { status: "ready" as const, items: [] },
  };

  it("defaults to primary context levels and keeps one fixed scale across scopes", async () => {
    const user = userEvent.setup();
    const { container } = render(<ContextHistoryPanel agents={[agent, childAgent]} tokens={tokens} historical={false} />);

    expect(screen.getByText("Latest request snapshot over time for Primary agent. Not cumulative token use.")).toBeInTheDocument();
    expect(container.querySelector(".contextHistoryLine")?.getAttribute("d")).toMatch(/^M /);
    expect(container.querySelector(".contextHistoryLine")?.getAttribute("d")).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector(".contextHistoryScale span")).toHaveTextContent("500K");
    expect(container.querySelectorAll(".contextBoundary.snapshot_drop")).toHaveLength(1);
    expect(screen.getAllByText("Snapshot decrease").length).toBeGreaterThan(0);
    expect(screen.getByText("Snapshot decrease · 100K before")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Context scope"), "all-agents");
    expect(screen.getByText(/Sum of each agent’s latest carried-forward snapshot/)).toBeInTheDocument();
    expect(screen.getByText("300K context")).toBeInTheDocument();
    expect(container.querySelector(".contextHistoryScale span")).toHaveTextContent("500K");
  });

  it("uses one keyboard-inspectable chart surface with arrow, Home, and End navigation", () => {
    const { container } = render(<ContextHistoryPanel agents={[agent, childAgent]} tokens={tokens} historical={false} />);
    const chart = screen.getByRole("group", { name: /Primary agent context history/ });

    expect(chart).toHaveAttribute("tabindex", "0");
    expect(container.querySelectorAll('.contextHistoryChart [tabindex="0"]')).toHaveLength(0);
    fireEvent.keyDown(chart, { key: "Home" });
    expect(container.querySelector(".contextHistoryAnnouncement")).toHaveTextContent("100,000 context");
    expect(screen.getByRole("button", { name: "Latest" })).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "End" });
    expect(container.querySelector(".contextHistoryAnnouncement")).toHaveTextContent("80,000 context");
    expect(screen.queryByRole("button", { name: "Latest" })).not.toBeInTheDocument();
  });

  it("has no cache evidence content and uses factual history empty states", () => {
    const emptyTokens = { ...tokens, contextHistory: { bucketMs: 0, buckets: [], boundaries: [] } };
    const { rerender } = render(<ContextHistoryPanel agents={[agent]} tokens={emptyTokens} historical={false} />);
    expect(screen.getByText("Context history will appear after the first model response.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cache evidence" })).not.toBeInTheDocument();

    rerender(<ContextHistoryPanel agents={[agent]} tokens={emptyTokens} historical />);
    expect(screen.getByText("No context snapshots were recorded for Primary agent.")).toBeInTheDocument();
  });
});

describe("request snapshots and cache evidence", () => {
  const childAgent: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder", tokens: { ...agent.tokens, total: 5_000 } };
  const snapshots = [
    { id: "snapshot-write", agentId: "primary", observedAt: "2026-08-09T12:03:00.000Z", uncachedInputTokens: 1_000, cacheWriteTokens: 146_282, cacheReadTokens: 0, outputTokens: 2_000, totalTokens: 149_282 },
    { id: "snapshot-read", agentId: "primary", observedAt: "2026-08-09T12:04:00.000Z", uncachedInputTokens: 1_000, cacheWriteTokens: 759, cacheReadTokens: 146_282, outputTokens: 2_000, totalTokens: 150_041 },
    { id: "snapshot-child", agentId: "child", observedAt: "2026-08-09T12:05:00.000Z", uncachedInputTokens: 4_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1_000, totalTokens: 5_000 },
  ];
  const cacheEvent = (index: number) => ({
    id: `cache-${index}`,
    agentId: "primary",
    kind: index === 0 ? "miss_refill" as const : index === 1 ? "reuse" as const : "refill" as const,
    observedAt: index === 1
      ? "2026-08-09T08:04:00.000-04:00"
      : new Date(Date.parse("2026-08-09T12:03:00.000Z") + index * 60_000).toISOString(),
    promptInputTokens: 147_282 + index,
    cacheReadPercent: index === 0 ? 5 : 90,
    cacheWriteTokens: index === 0 ? 146_282 : index === 1 ? 759 : 8_500,
    previousCacheReadPercent: index === 0 ? 90 : null,
    gapMs: index <= 1 ? 30 * 60_000 : null,
    relatedEventId: index === 1 ? "cache-0" : null,
  });
  const requestSnapshots = { status: "ready" as const, items: snapshots };
  const cacheEvents = { status: "ready" as const, items: Array.from({ length: 7 }, (_, index) => cacheEvent(index)) };

  it("canonicalizes equivalent timestamp offsets and rejects invalid join keys", () => {
    expect(snapshotEventKey("primary", "2026-08-09T08:04:00.000-04:00")).toBe(
      snapshotEventKey("primary", "2026-08-09T12:04:00.000Z"),
    );
    expect(snapshotEventKey("primary", "not-a-timestamp")).toBeNull();
    expect(snapshotEventKey("primary", "not-a-timestamp")).not.toBe(
      snapshotEventKey("primary", "2026-08-09T12:04:00.000Z"),
    );
  });

  it("keeps monotone request curves inside each pair of recorded values", () => {
    const recorded = [120, 10, 115, 15];
    const path = monotonePath(recorded.map((y, index) => ({ x: index * 100, y })));
    const segments = [...path.matchAll(/C [-\d.]+ ([-\d.]+), [-\d.]+ ([-\d.]+), [-\d.]+ ([-\d.]+)/g)];

    expect(segments).toHaveLength(recorded.length - 1);
    segments.forEach((segment, index) => {
      const lower = Math.min(recorded[index], recorded[index + 1]);
      const upper = Math.max(recorded[index], recorded[index + 1]);
      expect(Number(segment[1])).toBeGreaterThanOrEqual(lower);
      expect(Number(segment[1])).toBeLessThanOrEqual(upper);
      expect(Number(segment[2])).toBeGreaterThanOrEqual(lower);
      expect(Number(segment[2])).toBeLessThanOrEqual(upper);
      expect(Number(segment[3])).toBe(recorded[index + 1]);
    });
  });

  it("renders independent equal-spaced request waves with exact non-cumulative values and a fixed scale", async () => {
    const user = userEvent.setup();
    const { container } = render(<RequestSnapshotsPanel agents={[agent, childAgent]} requestSnapshots={requestSnapshots} cacheEvents={cacheEvents} cacheWriteAvailable historical={false} />);

    expect(screen.getByText("Each point is one provider usage snapshot. Equal spacing; curves only connect recorded points. Not cumulative.")).toBeInTheDocument();
    expect(container.querySelectorAll(".contextArea")).toHaveLength(4);
    expect(container.querySelectorAll(".contextSeriesLine")).toHaveLength(4);
    for (const line of container.querySelectorAll(".contextSeriesLine")) {
      expect(line.getAttribute("d")).toContain(" C ");
      expect(line.getAttribute("d")).not.toContain("NaN");
    }
    expect(container.querySelectorAll(".requestSnapshotPointColumn")).toHaveLength(2);
    expect(container.querySelectorAll(".contextChartPoint")).toHaveLength(8);
    expect(container.querySelector(".requestSnapshotBar")).not.toBeInTheDocument();
    expect(container.querySelector(".requestSnapshotStack")).not.toBeInTheDocument();
    expect(container.querySelector(".requestSnapshotScale span")).toHaveTextContent("200K");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("150,041 total");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("146,282");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("759");
    expect(container.querySelector(".requestSnapshotLegend")).toHaveTextContent("Uncached inputCache writeCache readOutput");
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    const cacheReadSwitch = screen.getByRole("switch", { name: "Cache read" });
    expect(cacheReadSwitch).toHaveAttribute("aria-checked", "true");
    cacheReadSwitch.focus();
    await user.keyboard(" ");
    expect(cacheReadSwitch).toHaveAttribute("aria-checked", "false");
    expect(container.querySelector(".cacheReadLine")).toHaveClass("isHidden");
    expect(container.querySelectorAll(".cacheReadChartPoint.isHidden")).toHaveLength(2);
    expect(container.querySelector(".requestSnapshotScale span")).toHaveTextContent("200K");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("146,282");
    await user.click(screen.getByRole("switch", { name: "Uncached input" }));
    await user.click(screen.getByRole("switch", { name: "Cache write" }));
    await user.click(screen.getByRole("switch", { name: "Output" }));
    expect(screen.getByText("All series hidden. Use the legend to show a metric.")).toBeInTheDocument();
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("150,041 total");

    await user.selectOptions(screen.getByLabelText("Request scope"), "child");
    expect(container.querySelectorAll(".requestSnapshotPointColumn")).toHaveLength(1);
    expect(container.querySelectorAll(".contextChartPoint")).toHaveLength(4);
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("Builder");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("5,000 total");
    expect(container.querySelector(".requestSnapshotScale span")).toHaveTextContent("200K");

    await user.selectOptions(screen.getByLabelText("Request scope"), "all-agents");
    expect(container.querySelectorAll(".requestSnapshotPointColumn")).toHaveLength(3);
    expect(container.querySelectorAll(".contextChartPoint")).toHaveLength(12);
  });

  it("links chart inspection and exact agent-timestamp cache evidence in both directions", async () => {
    const user = userEvent.setup();
    const { container } = render(<RequestSnapshotsPanel agents={[agent, childAgent]} requestSnapshots={requestSnapshots} cacheEvents={cacheEvents} cacheWriteAvailable historical={false} />);
    const chart = screen.getByRole("group", { name: /Primary agent request snapshots/ });

    expect(chart).toHaveAttribute("tabindex", "0");
    expect(container.querySelectorAll('.requestSnapshotChart [tabindex="0"]')).toHaveLength(0);
    expect(container.querySelector(".requestSnapshotEventMarker")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show 2 earlier events" }));
    const missRow = screen.getByRole("button", { name: /Locate Possible cache miss/ });
    const reuseRow = screen.getByRole("button", { name: /Locate Cache reuse/ });
    expect(reuseRow).toHaveClass("active");
    expect(missRow).not.toHaveClass("active");

    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({ left: 0, right: 200, top: 0, bottom: 156, width: 200, height: 156, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(chart, { clientX: 0 });
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("146,282 cache write, 0 cache read");
    expect(missRow).toHaveClass("active");
    expect(reuseRow).not.toHaveClass("active");
    fireEvent.pointerMove(chart, { clientX: 200 });
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("759 cache write, 146,282 cache read");
    expect(reuseRow).toHaveClass("active");

    fireEvent.pointerEnter(missRow);
    expect(container.querySelector('[data-snapshot-id="snapshot-write"]')).toHaveClass("active");
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent(/Possible cache miss.*refill/);
    fireEvent.pointerLeave(missRow);
    expect(container.querySelector('[data-snapshot-id="snapshot-read"]')).toHaveClass("active");

    fireEvent.focus(missRow);
    fireEvent.keyDown(missRow, { key: "Enter" });
    fireEvent.blur(missRow);
    expect(missRow).toHaveAttribute("aria-pressed", "true");
    expect(missRow).toHaveClass("active");
    expect(container.querySelector('[data-snapshot-id="snapshot-write"]')).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Latest" })).toBeInTheDocument();

    fireEvent.pointerMove(chart, { clientX: 200 });
    fireEvent.click(chart, { clientX: 200 });
    fireEvent.pointerLeave(chart);
    expect(reuseRow).toHaveAttribute("aria-pressed", "true");
    expect(reuseRow).toHaveClass("active");
    expect(screen.queryByRole("button", { name: "Latest" })).not.toBeInTheDocument();

    fireEvent.keyDown(chart, { key: "Home" });
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("146,282 cache write, 0 cache read");
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("Possible cache miss · refill");
    expect(screen.getByRole("button", { name: "Latest" })).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "End" });
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("759 cache write, 146,282 cache read");
    expect(screen.queryByRole("button", { name: "Latest" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Request scope"), "all-agents");
    expect(container.querySelectorAll(".requestSnapshotPointColumn")).toHaveLength(3);
    expect(container.querySelector(".requestSnapshotEventMarker")).not.toBeInTheDocument();
  });

  it("keeps cache evidence rows compact without repeating chart values", async () => {
    const user = userEvent.setup();
    render(<RequestSnapshotsPanel agents={[agent, childAgent]} requestSnapshots={requestSnapshots} cacheEvents={cacheEvents} cacheWriteAvailable historical={false} />);

    const list = screen.getByRole("list");
    expect(screen.getByRole("heading", { name: "Cache evidence" })).toBeInTheDocument();
    expect(screen.getByText("Transitions from provider-reported token counts. Not cost.")).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: "Show 2 earlier events" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
    const evidenceRows = within(list).getAllByRole("button");
    expect(evidenceRows[0]).toHaveTextContent("5% read");
    expect(evidenceRows[1]).toHaveTextContent("90% read");
    expect(list.querySelector("time")).not.toBeInTheDocument();
    expect(within(list).queryByText("Cache read")).not.toBeInTheDocument();
    expect(within(list).queryByText("Cache write")).not.toBeInTheDocument();
    expect(within(list).queryByText("Prompt input")).not.toBeInTheDocument();
    expect(within(list).queryByText(/Pomegr/)).not.toBeInTheDocument();
    expect(within(list).queryByText(/large cache/i)).not.toBeInTheDocument();
    expect(within(list).queryByText("Primary agent")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show recent 5" })).toHaveAttribute("aria-expanded", "true");

    await user.selectOptions(screen.getByLabelText("Request scope"), "all-agents");
    expect(within(screen.getByRole("list")).getAllByText("Primary agent").length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByLabelText("Request scope"), "child");
    expect(screen.getByText("Watching for meaningful cache transitions for Builder…")).toBeInTheDocument();
  });

  it("omits unsupported cache-write metrics and classifications for Codex", () => {
    const { container } = render(<RequestSnapshotsPanel
      agents={[agent, childAgent]}
      requestSnapshots={requestSnapshots}
      cacheEvents={cacheEvents}
      cacheWriteAvailable={false}
      historical={false}
    />);

    expect(container.querySelectorAll(".contextSeriesLine")).toHaveLength(3);
    expect(container.querySelectorAll(".contextChartPoint")).toHaveLength(6);
    expect(container.querySelector(".requestSnapshotLegend")).toHaveTextContent("Uncached inputCache readOutput");
    expect(screen.queryByRole("switch", { name: "Cache write" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cache evidence" })).not.toBeInTheDocument();
    expect(container.querySelector(".instrumentAnnouncement")).not.toHaveTextContent("cache write");
  });

  it("uses factual request and cache empty states in live and recorded views", () => {
    const emptySnapshots = { status: "unavailable" as const, items: [] };
    const emptyEvents = { status: "unavailable" as const, items: [] };
    const { rerender } = render(<RequestSnapshotsPanel agents={[agent]} requestSnapshots={emptySnapshots} cacheEvents={emptyEvents} cacheWriteAvailable historical={false} />);
    expect(screen.getByText("Independent request snapshots are not available yet for this session.")).toBeInTheDocument();
    expect(screen.getByText("Comparable cache snapshots are not available yet for this session.")).toBeInTheDocument();

    rerender(<RequestSnapshotsPanel agents={[agent]} requestSnapshots={emptySnapshots} cacheEvents={emptyEvents} cacheWriteAvailable historical />);
    expect(screen.getByText("No independent request snapshots were recorded for this session.")).toBeInTheDocument();
    expect(screen.getByText("No comparable cache snapshots were recorded for this session.")).toBeInTheDocument();
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
    const { container } = render(<ResourceUsagePanel resources={readyResources} />);

    expect(container.querySelector(".disclosureSummaryMetrics")).not.toBeInTheDocument();
    expect(screen.getAllByText("11%")).toHaveLength(2);
    expect(screen.getByText("Overall share across all logical processors")).toBeInTheDocument();
    expect(screen.getAllByText("3.0 GiB")).toHaveLength(2);
    expect(screen.getByText("Observed peak 4.3 GiB")).toBeInTheDocument();
    expect(screen.getAllByText("3.0 MiB/s")).toHaveLength(1);
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
    expect(screen.queryByText(/\b0(?:\.0+)?%|0 B\/s/)).not.toBeInTheDocument();

    rerender(<ResourceUsagePanel resources={{
      status: "unavailable",
      reason: "shared_owner",
      current: null,
      observedPeak: null,
      samples: [],
    }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Resource use unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("shares a process owner");
    expect(screen.queryByText(/\b0(?:\.0+)?%|0 B\/s/)).not.toBeInTheDocument();
  });

  it("starts open, stores collapse preference, and restores it on remount", async () => {
    window.localStorage.removeItem("pomegr-resource-panel-open");
    const user = userEvent.setup();
    const { container, unmount } = render(<ResourceUsagePanel resources={readyResources} />);
    const disclosure = container.querySelector("details.resourceUsagePanel");

    expect(disclosure).toHaveAttribute("open");
    expect(disclosure?.querySelector(".disclosureSummaryMetrics")).not.toBeInTheDocument();
    await user.click(screen.getByText("Resource use"));
    expect(disclosure).not.toHaveAttribute("open");
    const compactSummary = disclosure?.querySelector(".disclosureSummaryMetrics");
    expect(compactSummary).toHaveTextContent("CPU 11%");
    expect(compactSummary).toHaveTextContent("Memory 3.0 GiB");
    expect(compactSummary).toHaveTextContent("I/O 3.0 MiB/s");
    expect(window.localStorage.getItem("pomegr-resource-panel-open")).toBe("false");

    unmount();
    const restored = render(<ResourceUsagePanel resources={readyResources} />).container.querySelector("details.resourceUsagePanel");
    expect(restored).not.toHaveAttribute("open");
    expect(restored?.querySelector(".disclosureSummaryMetrics")).toHaveTextContent("CPU 11%");
  });

  it("retains disclosure changes in memory when preference storage rejects writes", async () => {
    window.localStorage.removeItem("pomegr-resource-panel-open");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    });
    const user = userEvent.setup();
    const first = render(<ResourceUsagePanel resources={readyResources} />);

    expect(first.container.querySelector("details.resourceUsagePanel")).toHaveAttribute("open");
    await user.click(screen.getByText("Resource use"));
    expect(first.container.querySelector("details.resourceUsagePanel")).not.toHaveAttribute("open");

    first.unmount();
    const restored = render(<ResourceUsagePanel resources={readyResources} />);
    expect(restored.container.querySelector("details.resourceUsagePanel")).not.toHaveAttribute("open");
    setItem.mockRestore();
  });

  it("uses one chart tab stop and navigates all lanes with arrow keys", () => {
    window.localStorage.setItem("pomegr-resource-panel-open", "true");
    const { container } = render(<ResourceUsagePanel resources={readyResources} />);
    const charts = screen.getByRole("group", { name: /Resource use over the last 15 minutes/ });
    const announcement = container.querySelector(".resourceChartAnnouncement");
    const readout = container.querySelector(".resourceChartReadout");

    expect(charts).toHaveAttribute("tabindex", "0");
    expect(charts.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(announcement).toHaveTextContent("CPU 11% overall across all logical processors");
    expect(readout).toHaveTextContent("CPU 11%");
    expect(readout?.querySelector("time")).toHaveAttribute("dateTime", "2026-08-14T12:02:00.000Z");

    fireEvent.keyDown(charts, { key: "ArrowLeft" });
    expect(announcement).toHaveTextContent("CPU Unavailable");
    expect(announcement).toHaveTextContent("Memory 2.5 GiB");
    expect(readout).toHaveTextContent("CPU Unavailable");
    expect(readout).toHaveTextContent("Memory 2.5 GiB");

    fireEvent.keyDown(charts, { key: "Home" });
    expect(announcement).toHaveTextContent("CPU 3.1% overall across all logical processors");

    fireEvent.keyDown(charts, { key: "End" });
    expect(announcement).toHaveTextContent("CPU 11% overall across all logical processors");
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
    expect(readout).toHaveTextContent("CPU 3.1%");
    expect(readout?.querySelector("time")).toHaveAttribute("dateTime", "2026-08-14T12:00:00.000Z");

    fireEvent.pointerLeave(charts);
    expect(readout).toHaveTextContent("CPU 11%");
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

describe("session progress estimate", () => {
  const reportedAt = "2026-08-11T12:00:00.000Z";
  const progress = {
    phase: "implementing" as const,
    percent: 42,
    remainingMinutesMin: 10,
    remainingMinutesMax: 20,
    confidence: "medium" as const,
    reportedAt,
  };

  function progressAgent(status: Agent["status"] = "active", updatedAt = reportedAt) {
    return { ...agent, id: "primary", status, updatedAt, lastSeen: updatedAt };
  }

  it("keeps the panel hidden when progress is absent", () => {
    const { container } = render(<LiveClockProvider running={false}><SessionProgressPanel progress={null} /></LiveClockProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the bounded report as a semantic, visible progress instrument", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:05:00.000Z"));
    const { container } = render(<LiveClockProvider running={false}><SessionProgressPanel progress={progress} agents={[progressAgent()]} connected /></LiveClockProvider>);

    expect(screen.getByText("Agent estimate")).toBeInTheDocument();
    expect(screen.getAllByText("Implementing")).toHaveLength(2);
    expect(screen.getByText("10–20 min")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "42% complete · Implementing");
    expect(container.querySelector("progress")).toHaveValue(42);
    vi.useRealTimers();
  });

  it("pauses ETA for input and does not mark a retained report stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:20:00.000Z"));
    render(<LiveClockProvider running={false}><SessionProgressPanel progress={progress} agents={[progressAgent("needs_input", "2026-08-11T12:19:00.000Z")]} connected needsInput /></LiveClockProvider>);

    expect(screen.getByText("ETA paused — needs input")).toBeInTheDocument();
    expect(screen.queryByText(/may be stale/i)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("marks an old report stale only after later primary activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:11:00.000Z"));
    const primary = progressAgent("active", reportedAt);
    const { container } = render(<LiveClockProvider running={false}><SessionProgressPanel progress={progress} agents={[primary]} activity={[{ id: "activity-1", timestamp: "2026-08-11T12:10:30.000Z", actor: "primary", tool: "Read", detail: "bounded", status: null }]} connected /></LiveClockProvider>);

    expect(screen.getByText(/May be stale/)).toBeInTheDocument();
    expect(screen.getAllByText(/may be stale/i)).toHaveLength(1);
    expect(container.querySelector(".sessionProgressNote")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("uses an absolute timestamp for historical progress and omits ETA at completion", () => {
    const historical = { ...progress, phase: "complete" as const, percent: 100, remainingMinutesMin: undefined, remainingMinutesMax: undefined };
    render(<LiveClockProvider running={false}><SessionProgressPanel progress={historical} historical /></LiveClockProvider>);

    expect(screen.getAllByText(/Recorded agent estimate/)).toHaveLength(2);
    expect(screen.queryByText("REMAINING")).not.toBeInTheDocument();
  });
});

describe("estimated session cost", () => {
  function detailsState(session: NonNullable<MonitorState["session"]>, source: "Claude Code" | "Codex", capabilities: typeof claudeCapabilities | typeof codexCapabilities) {
    return {
      ...createEmptyMonitorState({ connected: true, source, capabilities }),
      session,
    } satisfies MonitorState;
  }

  it("moves a captured provider estimate out of the hero and into session details", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 1.2345, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-09T12:00:00.000Z" },
    };
    const hero = render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(hero.container).not.toHaveTextContent("$1.23");
    expect(hero.container).not.toHaveTextContent(/cost estimate/i);
    hero.unmount();

    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical={false} loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);

    expect(screen.getByText("Claude Code API list-rate estimate")).toBeInTheDocument();
    expect(screen.getByText("$1.23")).toBeInTheDocument();
    expect(screen.getByText(/Reference only — not a bill or subscription spend\. Observed/)).toBeInTheDocument();
  });

  it("shows the recorded observation time for a historical estimate", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 0.0042, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-09T12:00:00.000Z" },
    };

    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);

    expect(screen.getByText("$0.0042")).toBeInTheDocument();
    expect(screen.getByText(/Recorded Aug 9/)).toBeInTheDocument();
  });

  it("omits unobserved and unrecorded placeholder estimates", () => {
    const session = { ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }), updatedAt: "2026-08-09T12:00:00.000Z" };
    const { rerender } = render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical={false} loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);

    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByText(/estimate/i)).not.toBeInTheDocument();
    rerender(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);
    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByText(/estimate/i)).not.toBeInTheDocument();
  });

  it("omits unsupported estimates and ignores any inapplicable cost value", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 9, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-11T12:00:00.000Z" },
    };
    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Codex", codexCapabilities)} historical={false} loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);

    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByText("$9.00")).not.toBeInTheDocument();
    expect(screen.queryByText(/estimate/i)).not.toBeInTheDocument();
  });
});

describe("Pomegr plugin metadata", () => {
  function detailsState(session: NonNullable<MonitorState["session"]>) {
    return {
      ...createEmptyMonitorState({ connected: true, source: "Codex", capabilities: codexCapabilities }),
      session,
    } satisfies MonitorState;
  }

  it("omits integration UI when no trusted observation exists", () => {
    const session = repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } });
    const { container } = render(<SessionDetailsPanel state={detailsState(session)} historical={false} loading={false} onRefresh={vi.fn()} />);

    expect(container.querySelector(".sessionPomegrIntegration")).not.toBeInTheDocument();
    expect(container.querySelector(".sessionPomegrSummary")).not.toBeInTheDocument();
  });

  it("shows the active plugin and valid policy in summary and details", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      pomegrPlugin: { status: "active" as const, version: "0.4.1", policyStatus: "valid" as const, policyVersion: 7, observedAt: "2026-08-26T12:00:00.000Z" },
    };
    render(<SessionDetailsPanel state={detailsState(session)} historical={false} loading={false} onRefresh={vi.fn()} />);

    expect(document.querySelector(".sessionPomegrSummary")).toHaveTextContent("Pomegr v0.4.1 · Policy v7");
    expect(screen.getByRole("region", { name: "Pomegr integration" })).toHaveTextContent("Pluginv0.4.1PolicyValid · v7");
    expect(screen.getByText("Observed at session start")).toBeInTheDocument();
    expect(screen.getByText("Valid · v7").closest(".sessionPomegrPolicy")).toHaveClass("sessionPomegrPolicy-valid");
  });

  it("preserves recorded invalid policy state in historical sessions", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      pomegrPlugin: { status: "active" as const, version: null, policyStatus: "invalid" as const, policyVersion: 7, observedAt: "2026-08-26T12:00:00.000Z" },
    };
    render(<SessionDetailsPanel state={detailsState(session)} historical loading={false} onRefresh={vi.fn()} />);

    expect(document.querySelector(".sessionPomegrSummary")).toHaveTextContent("Pomegr Version unavailable · Policy needs attention");
    expect(screen.getByText("Invalid — needs attention · v7")).toBeInTheDocument();
    expect(screen.getByText("Recorded for this session")).toBeInTheDocument();
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

  it("labels Codex provenance and shows its agent-reported session summary", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      summary: { text: "Unsupported summary must stay hidden", observedAt: null, source: "provider" },
      signal: { label: "Awaiting merge", tone: "info", reportedAt: "2026-08-24T12:00:00.000Z", description: "Implementation is complete. Next: merge the approved pull request." },
    } satisfies NonNullable<MonitorState["session"]>;
    render(<LiveClockProvider running={false}><SessionHero session={session} source="Codex" capabilities={codexCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("Codex")).toHaveClass("providerTag");
    expect(screen.getByText("Codex").closest(".providerBadge")?.querySelector('[data-mark="openai"]')).toBeInTheDocument();
    expect(screen.getByText("Implementation is complete. Next: merge the approved pull request.")).toHaveAttribute("title", "Agent-reported session summary from the Pomegr MCP tool");
    expect(screen.getByText("Agent-reported summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Awaiting merge" })).toBeInTheDocument();
    expect(screen.queryByText("Unsupported summary must stay hidden")).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the provider/)).not.toBeInTheDocument();
  });

  it("asks Codex agents for a report instead of claiming summaries are unsupported", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      updatedAt: "2026-08-24T12:00:00.000Z",
    };

    const { rerender } = render(<LiveClockProvider running={false}><SessionHero session={session} source="Codex" capabilities={codexCapabilities} historical={false} /></LiveClockProvider>);
    expect(screen.getByText("Waiting for an agent to report a session summary through Pomegr.")).toBeInTheDocument();
    expect(screen.queryByText(/not available for this provider/i)).not.toBeInTheDocument();

    rerender(<LiveClockProvider running={false}><SessionHero session={session} source="Codex" capabilities={codexCapabilities} historical /></LiveClockProvider>);
    expect(screen.getByText("No agent-reported summary was recorded for this session.")).toBeInTheDocument();
  });

  it("uses the Claude mark for Claude Code sessions", () => {
    const session = repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } });
    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("Claude Code").closest(".providerBadge")?.querySelector('[data-mark="claude"]')).toBeInTheDocument();
  });

  it("never gives an unsupported provider the Claude /context instruction", () => {
    const { container } = render(<MachineryPanel machinery={null} supported={false} historical={false} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/\/context/)).not.toBeInTheDocument();
  });

  it("replaces a missing live context panel with one actionable inline notice", () => {
    const { container } = render(<MachineryPanel machinery={null} supported historical={false} />);

    expect(container.querySelector(".machineryNotice")).toHaveTextContent("Run /context in this session to capture a diagnostic inventory.");
    expect(container.querySelector(".cachePanel")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("—");
  });

  it("uses a factual inline notice when a historical context snapshot was not recorded", () => {
    const { container } = render(<MachineryPanel machinery={null} supported historical />);

    expect(container.querySelector(".machineryNotice")).toHaveTextContent("No /context inventory was recorded for this session.");
    expect(container.querySelector(".cachePanel")).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("—");
  });
});
