import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps } from "react";
import type { Agent, MonitorState, Workflow } from "../../shared/monitor-contract";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import { Dashboard } from "../../app/Dashboard";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { WorkflowActivityPanel } from "../../app/components/dashboard/WorkflowActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

function worker(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "workflow-agent-1",
    parentId: "primary",
    label: "Backend investigator",
    kind: "workflow-subagent",
    model: "test-model",
    effort: "medium",
    status: "active",
    signal: null,
    toolCalls: 3,
    skills: [],
    lastSeen: "2026-08-15T12:03:00.000Z",
    startedAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:03:00.000Z",
    durationMs: 180_000,
    workflowId: "workflow-1",
    workflowPhaseId: null,
    tokens: { total: 83_000, input: 1_000, output: 2_000, cacheWrite: 40_000, cacheRead: 40_000 },
    ...overrides,
  };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow-1",
    name: "quickwin-batch",
    summary: "Two implementation tracks with a structured verification pass.",
    status: "running",
    startedAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:03:00.000Z",
    durationMs: 180_000,
    agentIds: ["workflow-agent-1", "workflow-agent-2"],
    phases: [],
    ...overrides,
  };
}

function renderWorkflowActivity(props: ComponentProps<typeof WorkflowActivityPanel>, clockRunning = false) {
  return render(<LiveClockProvider running={clockRunning}><WorkflowActivityPanel {...props} /></LiveClockProvider>);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.removeItem("pomegr-workflow-panel-open-claude:workflow-live");
  window.localStorage.removeItem("pomegr-workflow-panel-open-claude:workflow-history");
  window.localStorage.removeItem("pomegr-workflow-panel-open-claude:workflow-sorted");
  window.localStorage.removeItem("pomegr-workflow-panel-open-claude:workflow-timer");
});

describe("workflow activity", () => {
  it("places verified workflow activity before the two-column dashboard grid", async () => {
    const state: MonitorState = {
      ...createEmptyMonitorState({ connected: true }),
      capabilities: { ...createEmptyMonitorState().capabilities, workflows: true },
      session: {
        id: "claude:workflow-live",
        title: "Workflow session",
        project: "Pomegr",
        cwd: "C:\\Workspace\\repos\\pomegr",
        repository: { available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } },
        pullRequests: { status: "unavailable", checkedAt: null, items: [] },
        startedAt: "2026-08-15T12:00:00.000Z",
        updatedAt: "2026-08-15T12:03:00.000Z",
        durationMs: 180_000,
        cost: null,
        approvalMode: null,
        contextMachinery: null,
        summary: null,
        signal: null,
      },
      agents: [worker()],
      workflows: [workflow({ agentIds: ["workflow-agent-1"] })],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input) === "/api/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(state), { status: 200 }));
    });

    const { container } = render(<Dashboard />);
    const panel = await waitFor(() => {
      const element = container.querySelector("details.workflowActivityPanel");
      expect(element).toBeInTheDocument();
      return element!;
    });

    expect(panel.nextElementSibling).toBe(container.querySelector(".contentGrid"));
  });

  it("omits the disclosure when no workflow evidence exists", () => {
    const { container } = renderWorkflowActivity({ agents: [], historical: false, sessionId: "claude:none", workflows: [] });

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Workflow activity")).not.toBeInTheDocument();
  });

  it("opens a running workflow by default and reports verified live measurements", () => {
    const agents = [
      worker(),
      worker({ id: "workflow-agent-2", label: "واجهة أمامية", tokens: { total: 79_000, input: 2_000, output: 1_000, cacheWrite: 38_000, cacheRead: 38_000 } }),
    ];

    const { container } = renderWorkflowActivity({ agents, historical: false, sessionId: "claude:workflow-live", workflows: [workflow()] });

    const details = container.querySelector("details.workflowActivityPanel");
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Live phase detail unavailable.")).toBeInTheDocument();
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("2 observed agents");
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("162K context");
    expect(screen.getByText("واجهة أمامية")).toHaveAttribute("dir", "auto");
    expect(details?.querySelector("summary .workflowDisclosureSummary")).not.toBeInTheDocument();
  });

  it("persists a collapsed historical summary per session", () => {
    window.localStorage.setItem("pomegr-workflow-panel-open-claude:workflow-history", "false");
    const agents = [worker({ status: "finished" })];
    const completed = workflow({ status: "completed", agentIds: [agents[0].id] });

    const { container } = renderWorkflowActivity({ agents, historical: true, sessionId: "claude:workflow-history", workflows: [completed] });

    const details = container.querySelector("details.workflowActivityPanel")!;
    const summary = details.querySelector("summary")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(summary).getByText("quickwin-batch")).toBeInTheDocument();
    expect(summary).toHaveTextContent("Completed");
    expect(summary).toHaveTextContent("1 agent");
    expect(summary).toHaveTextContent("3m wall time");
    expect(summary).toHaveTextContent("83K context");
  });

  it("sorts active evidence first and renders ordered verified phases", () => {
    const agents = [
      worker({ workflowPhaseId: "phase-implement" }),
      worker({ id: "workflow-agent-2", label: "Frontend builder", workflowPhaseId: "phase-verify" }),
    ];
    const completed = workflow({
      id: "workflow-completed",
      name: "Earlier audit",
      status: "completed",
      agentIds: [],
      phases: [],
      updatedAt: "2026-08-15T11:00:00.000Z",
    });
    const active = workflow({
      phases: [
        { id: "phase-implement", label: "実装", agentIds: ["workflow-agent-1"] },
        { id: "phase-verify", label: "Verify the responsive interface", agentIds: ["workflow-agent-2"] },
      ],
    });

    const { container } = renderWorkflowActivity({ agents, historical: false, sessionId: "claude:workflow-sorted", workflows: [completed, active] });

    const runs = container.querySelectorAll(".workflowRun");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveAccessibleName("quickwin-batch workflow");
    expect(runs[1]).toHaveAccessibleName("Earlier audit workflow");
    const phases = within(runs[0] as HTMLElement).getAllByRole("listitem");
    expect(phases[0]).toHaveTextContent("実装");
    expect(phases[0]).toHaveTextContent("Backend investigator");
    expect(phases[1]).toHaveTextContent("Verify the responsive interface");
    expect(screen.queryByText("Live phase detail unavailable.")).not.toBeInTheDocument();
  });

  it("marks workflow workers in Agent activity without duplicating their measurements", () => {
    const verifiedWorker = worker({ workflowPhaseId: "phase-implement" });
    const active = workflow({ phases: [{ id: "phase-implement", label: "Implement", agentIds: [verifiedWorker.id] }] });

    render(
      <LiveClockProvider running={false}>
        <AgentActivityPanel agents={[verifiedWorker]} executionTasks={[]} planTasks={[]} workflows={[active]} historical={false} />
      </LiveClockProvider>,
    );

    expect(screen.getByRole("button", { name: "Workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Implement" })).toBeInTheDocument();
    expect(screen.getAllByText("83K")).toHaveLength(1);
    expect(screen.getAllByText("wall time")).toHaveLength(1);
  });

  it("advances only live running workflow wall time", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:03:00.000Z");
    const running = workflow({ id: "running", name: "Live runner", agentIds: [], durationMs: 180_000 });
    const completed = workflow({ id: "completed", name: "Terminal run", status: "completed", agentIds: [], durationMs: 120_000 });
    const unknown = workflow({ id: "unknown", name: "Unconfirmed run", status: "unknown", agentIds: [], durationMs: 60_000 });

    const view = renderWorkflowActivity({
      agents: [],
      historical: false,
      sessionId: "claude:workflow-timer",
      workflows: [running, completed, unknown],
    }, true);

    expect(screen.getByLabelText("Live runner workflow measurements")).toHaveTextContent("3m wall time");
    expect(screen.getByLabelText("Terminal run workflow measurements")).toHaveTextContent("2m wall time");
    expect(screen.getByLabelText("Unconfirmed run workflow measurements")).toHaveTextContent("1m wall time");

    act(() => vi.advanceTimersByTime(120_000));

    expect(screen.getByLabelText("Live runner workflow measurements")).toHaveTextContent("5m wall time");
    expect(screen.getByLabelText("Terminal run workflow measurements")).toHaveTextContent("2m wall time");
    expect(screen.getByLabelText("Unconfirmed run workflow measurements")).toHaveTextContent("1m wall time");

    view.rerender(
      <LiveClockProvider running>
        <WorkflowActivityPanel agents={[]} historical sessionId="claude:workflow-timer" workflows={[running]} />
      </LiveClockProvider>,
    );
    expect(screen.getByLabelText("Live runner workflow measurements")).toHaveTextContent("3m wall time");

    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByLabelText("Live runner workflow measurements")).toHaveTextContent("3m wall time");
  });

  it("keeps workflow copy resilient and phases stacked at the mobile breakpoint", () => {
    const styles = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

    expect(styles).toMatch(/\.workflowRunIdentity h3\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*unicode-bidi:\s*plaintext;/s);
    expect(styles).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.workflowRunHeader\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(styles).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.workflowPhaseAgents\s*\{[^}]*grid-column:\s*2;[^}]*justify-content:\s*flex-start;/);
  });
});
