import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ExecutionTask, SessionSummary } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { SessionSidebar } from "../../app/components/dashboard/SessionSidebar";
import { UsageLimitsPanel } from "../../app/components/dashboard/UsageLimitsPanel";
import { ContextGrowthTimeline } from "../../app/components/dashboard/ContextGrowthTimeline";
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
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Resets in 1m")).toBeInTheDocument();
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
