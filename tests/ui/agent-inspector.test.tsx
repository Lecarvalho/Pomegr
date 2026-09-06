import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, ExecutionTask, Workflow } from "../../shared/monitor-contract";
import { AgentInspector } from "../../app/components/dashboard/agent-roster/AgentInspector";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent, task } from "./dashboard-test-fixtures";

const access = vi.hoisted(() => ({ canCopyTranscriptPath: true }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => access }));

function renderInspector(props: Partial<React.ComponentProps<typeof AgentInspector>> & { agent?: Agent | null } = {}) {
  return render(<LiveClockProvider running={false}><AgentInspector agent={agent} agents={[agent]} onOpenTree={vi.fn()} {...props} /></LiveClockProvider>);
}

function shellTask(id: string, status: ExecutionTask["status"], startedAt: string): ExecutionTask {
  return { ...task, id, label: `Task ${id}`, status, startedAt, finishedAt: status === "running" ? null : startedAt, exitCode: status === "failed" ? 1 : status === "running" ? null : 0 };
}

describe("agent inspector", () => {
  it("copies a subagent transcript path only after an explicit action, without rendering it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ path: "C:\\Users\\Leandro\\.codex\\sessions\\child.jsonl" }) });
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.stubGlobal("fetch", fetchMock);
    const child = { ...agent, id: "agent-child", parentId: "primary", label: "Builder", transcriptAvailable: true, executionTasks: [] };
    try {
      renderInspector({ agent: child, agents: [agent, child], sessionId: "claude:session-1" });
      const inspector = screen.getByRole("region", { name: "Agent inspector for Builder" });
      await user.click(screen.getByRole("button", { name: "Copy transcript path for Builder" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("C:\\Users\\Leandro\\.codex\\sessions\\child.jsonl"));
      expect(fetchMock).toHaveBeenCalledWith("/api/transcript-path?sessionId=claude%3Asession-1&agentId=agent-child", { cache: "no-store" });
      expect(screen.getByRole("button", { name: "Transcript path copied for Builder" })).toHaveClass("copied");
      expect(inspector).not.toHaveTextContent("C:\\Users\\Leandro\\.codex\\sessions\\child.jsonl");
    } finally {
      vi.unstubAllGlobals();
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
    }
  });

  it("keeps transcript copying behind client access gating", () => {
    access.canCopyTranscriptPath = false;
    const child = { ...agent, id: "agent-gated", parentId: "primary", label: "Gated builder", transcriptAvailable: true };
    try {
      renderInspector({ agent: child, agents: [agent, child] });
      expect(screen.queryByRole("button", { name: /Copy transcript path/ })).not.toBeInTheDocument();
    } finally { access.canCopyTranscriptPath = true; }
  });

  it("retains approval metadata and current activity separately from safe shell failure details", async () => {
    const user = userEvent.setup();
    const reviewer: Agent = {
      ...agent, id: "agent-reviewer", parentId: "primary", label: "Approval reviewer", role: "reviewer", model: "codex-auto-review", effort: "low", skills: [], status: "active",
      currentActivity: { label: "Inspecting the workspace", observedAt: "2026-08-08T12:00:04.000Z" },
      executionTasks: [{ ...shellTask("failed", "failed", "2026-08-08T12:00:03.000Z"), label: "Shell command", failureCause: "permission_denied" }],
      reviewDecisions: { total: 2, allowed: 1, denied: 1, truncated: false, items: [
        { action: "build_or_test", outcome: "allowed", risk: "medium", durationMs: 4_250, reviewedAt: "2026-08-08T12:00:03.000Z" },
        { action: "file_change", outcome: "denied", risk: "unknown", durationMs: 875, reviewedAt: "2026-08-08T12:00:05.000Z" },
      ] },
    };
    renderInspector({ agent: reviewer, agents: [agent, reviewer] });
    const inspector = screen.getByRole("region", { name: "Agent inspector for Approval reviewer" });
    expect(screen.getByRole("region", { name: "Current provider-reported activity" })).toHaveTextContent("Inspecting the workspace");
    expect(screen.getByRole("region", { name: "Completed approval reviews" })).toHaveTextContent("Review decisions (2)");
    expect(inspector).toHaveTextContent("Build or test");
    expect(inspector).toHaveTextContent("File change");
    expect(inspector).toHaveTextContent("Allowed");
    expect(inspector).toHaveTextContent("Denied");
    expect(inspector).toHaveTextContent("medium risk");
    expect(inspector).toHaveTextContent("risk unavailable");
    expect(inspector).toHaveTextContent("reviewed in 4.3s");
    expect(inspector).toHaveTextContent("reviewed in under 1s");
    await user.hover(screen.getByRole("button", { name: /Show failure cause/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("The command was blocked by a permissions or sandbox restriction. Exit code 1.");
    expect(inspector).not.toHaveTextContent(/prompt|stdout|stderr|rationale/i);
  });

  it("uses bounded skills and shell rows, then expands each retained list", async () => {
    const user = userEvent.setup();
    const tasks = [
      shellTask("completed-old", "completed", "2026-08-08T12:00:00.000Z"),
      shellTask("running-old", "running", "2026-08-08T12:00:01.000Z"),
      shellTask("running-new", "running", "2026-08-08T12:00:05.000Z"),
      shellTask("completed-new", "completed", "2026-08-08T12:00:06.000Z"),
      shellTask("completed-latest", "completed", "2026-08-08T12:00:07.000Z"),
    ];
    const detailed = { ...agent, executionTasks: tasks, skills: Array.from({ length: 7 }, (_, index) => ({ name: `skill-${index + 1}`, calls: index + 1, lastUsed: "2026-08-08T12:00:05.000Z" })) };
    renderInspector({ agent: detailed });
    const skills = screen.getByRole("region", { name: "Skills used" });
    const shell = screen.getByRole("region", { name: "Shell tasks" });
    expect(within(skills).getAllByText(/skill-/)).toHaveLength(6);
    expect(within(shell).getAllByText(/Task /)).toHaveLength(4);
    expect(within(shell).getByText("Task running-new").compareDocumentPosition(within(shell).getByText("Task completed-latest")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(skills).getByRole("button", { name: "All" }));
    expect(within(skills).getAllByText(/skill-/)).toHaveLength(7);
    await user.click(within(shell).getByRole("button", { name: "All" }));
    expect(within(shell).getAllByText(/Task /)).toHaveLength(5);
  });

  it("shows only three shell rows in the phone sheet before expanding", async () => {
    const user = userEvent.setup();
    const detailed = { ...agent, executionTasks: [shellTask("one", "running", "2026-08-08T12:00:01.000Z"), shellTask("two", "completed", "2026-08-08T12:00:02.000Z"), shellTask("three", "completed", "2026-08-08T12:00:03.000Z"), shellTask("four", "completed", "2026-08-08T12:00:04.000Z")] };
    renderInspector({ agent: detailed, presentation: "sheet" });
    const sheet = screen.getByRole("dialog", { name: "Primary agent" });
    const shell = within(sheet).getByRole("region", { name: "Shell tasks" });
    expect(within(shell).getAllByText(/Task /)).toHaveLength(3);
    await user.click(within(shell).getByRole("button", { name: "All" }));
    expect(within(shell).getAllByText(/Task /)).toHaveLength(4);
  });

  it("renders nested lineage, workflow rollups, and the primary plan caution", () => {
    const parent = { ...agent, id: "parent", parentId: "primary", label: "Parent", tokens: { ...agent.tokens, total: 100 } };
    const child = { ...agent, id: "child", parentId: "parent", label: "Child", workflowId: "workflow-1", workflowPhaseId: "phase-1", tokens: { ...agent.tokens, total: 200 } };
    const sibling = { ...agent, id: "sibling", parentId: "primary", label: "Sibling", workflowId: "workflow-1", workflowPhaseId: "phase-1", tokens: { ...agent.tokens, total: 300 } };
    const workflow: Workflow = { id: "workflow-1", name: "Audit", summary: null, status: "running", metadataStatus: "ready", agentIds: ["child", "sibling"], phases: [{ id: "phase-1", label: "Review", agentIds: ["child", "sibling"] }], startedAt: null, updatedAt: null, durationMs: 0 };
    const onOpenTree = vi.fn();
    const { rerender } = renderInspector({ agent: child, agents: [agent, parent, child, sibling], workflows: [workflow], onOpenTree });
    const lineage = screen.getByRole("list", { name: "Agent lineage" });
    expect(lineage).toHaveTextContent("Primary agent");
    expect(lineage).toHaveTextContent("Parent");
    expect(lineage).toHaveTextContent("Workflow Audit · 2 agents");
    expect(lineage).toHaveTextContent("Phase Review · 1 siblings");
    expect(lineage).toHaveTextContent("500");
    expect(lineage).toHaveTextContent("Child · no children");
    screen.getByRole("button", { name: "Open in tree" }).click();
    expect(onOpenTree).toHaveBeenCalledWith("child");

    rerender(<LiveClockProvider running={false}><AgentInspector agent={agent} agents={[agent]} onOpenTree={vi.fn()} planTasks={[{ id: "plan-1", subject: "Refactor dashboard", status: "in_progress", blocks: [], blockedBy: [] }]} /></LiveClockProvider>);
    expect(screen.getByRole("region", { name: "Agent plan checklist" })).toHaveTextContent("Agent-maintained checklist");
    expect(screen.getByRole("region", { name: "Agent plan checklist" })).toHaveTextContent("may be stale");
  });

  it("bounds malformed cyclic parent evidence while retaining the selected agent", () => {
    const first = { ...agent, id: "cycle-first", parentId: "cycle-second", label: "First" };
    const second = { ...agent, id: "cycle-second", parentId: "cycle-first", label: "Second" };
    renderInspector({ agent: second, agents: [first, second] });
    const rows = within(screen.getByRole("list", { name: "Agent lineage" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("First");
    expect(rows[1]).toHaveTextContent("Second · 1 child");
  });
});
