import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ExecutionTask } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { task, agent } from "./dashboard-test-fixtures";

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
      else delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
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

  it("shows the last model turn separately from the cache touch in the timing popover", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:03:05.000Z");
    const requestSnapshots = {
      status: "ready" as const,
      items: [
        { id: "request-touch", agentId: agent.id, observedAt: "2026-08-08T11:59:05.000Z", cacheLifetime: "5m" as const, uncachedInputTokens: 20, cacheWriteTokens: 800, cacheReadTokens: 100, outputTokens: 10, totalTokens: 930 },
        { id: "request-turn", agentId: agent.id, observedAt: "2026-08-08T12:02:05.000Z", cacheLifetime: null, uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10, totalTokens: 110 },
      ],
    };
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[agent]} executionTasks={[]} planTasks={[]} historical={false} requestSnapshots={requestSnapshots} /></LiveClockProvider>);

    expect(screen.getByText("latest context")).toBeInTheDocument();
    expect(container.querySelector(".agentTokens")).toHaveAttribute("title", "Latest non-zero provider usage snapshot for this agent; not cumulative token use.");
    const timingTrigger = screen.getByRole("button", { name: "Last model turn 1m ago; show turn and cache timing" });
    expect(timingTrigger).toHaveTextContent("last turn 1m ago");
    expect(timingTrigger.querySelector("time")).toHaveAttribute("dateTime", "2026-08-08T12:02:05.000Z");
    expect(timingTrigger).toHaveClass("dottedInfoPopoverTrigger");
    expect(timingTrigger.closest(".agentTurnCacheTiming")).toHaveClass("cacheTimingNear");

    fireEvent.pointerEnter(timingTrigger, { pointerType: "mouse" });
    const popover = screen.getByRole("dialog", { name: /show turn and cache timing/i });
    expect(popover).toHaveTextContent("Last model turn1m ago");
    expect(popover).toHaveTextContent("Last cache touch4m ago");
    expect(popover).toHaveTextContent("Observed lifetime5m");
    expect(popover).toHaveTextContent("Cache lifetime nearing threshold");
    expect(popover).not.toHaveTextContent("Cache timing is based on");
    expect(screen.getByRole("link", { name: "How cache timing works; opens in a new tab" })).toHaveAttribute(
      "href",
      "https://github.com/Lecarvalho/pomegr/blob/main/docs/CACHE_TIMING.md",
    );
    vi.useRealTimers();
  });

  it("keeps ordinary timing as plain text and aligns neutral status and compaction evidence", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:01:00.000Z");
    const idleAgent = { ...agent, status: "idle" as const };
    const requestSnapshots = {
      status: "ready" as const,
      items: [{ id: "request-neutral", agentId: agent.id, observedAt: "2026-08-08T12:00:00.000Z", cacheLifetime: "1h" as const, uncachedInputTokens: 20, cacheWriteTokens: 800, cacheReadTokens: 100, outputTokens: 10, totalTokens: 930 }],
    };
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel
      agents={[idleAgent]}
      contextBoundaries={[{ id: "compact-1", agentId: agent.id, timestamp: "2026-08-08T11:59:00.000Z", kind: "automatic_compaction", preTokens: 100_000 }]}
      executionTasks={[]}
      historical={false}
      planTasks={[]}
      requestSnapshots={requestSnapshots}
    /></LiveClockProvider>);

    const plainTiming = screen.getByText("last turn 1m ago");
    expect(plainTiming.tagName).toBe("TIME");
    expect(plainTiming).toHaveClass("agentTurnCacheTimingPlain");
    expect(plainTiming.closest("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /show turn and cache timing/i })).not.toBeInTheDocument();

    const status = screen.getByText("idle");
    expect(status).toHaveClass("statusPill");
    expect(status.querySelector("i")).toBeNull();
    const titleLine = container.querySelector(".agentTitleLine");
    expect(titleLine?.children[0].tagName).toBe("STRONG");
    expect(titleLine?.children[1]).toHaveClass("agentHistoryIndicators");
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
