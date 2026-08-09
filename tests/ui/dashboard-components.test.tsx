import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ExecutionTask, SessionSummary } from "../../shared/monitor-contract";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { SessionSidebar } from "../../app/components/dashboard/SessionSidebar";

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
    render(<AgentActivityPanel agents={[agent]} executionTasks={[]} planTasks={[{ id: "plan-1", subject: "Refactor dashboard", status: "in_progress", blocks: [], blockedBy: [] }]} historical={false} />);

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
    render(<SessionSidebar open sessions={sessions} selectedSessionId={null} currentSessionId="live-1" viewingHistory={false} onClose={onClose} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /Live work/ }));
    expect(onSelect).toHaveBeenCalledWith(sessions[0]);

    await user.click(screen.getByRole("button", { name: /^Threadlight1$/ }));
    await user.click(screen.getByRole("button", { name: /Older work/ }));
    expect(onSelect).toHaveBeenLastCalledWith(sessions[1]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
