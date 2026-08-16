import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    workflowOrder: 0,
    workflowState: "running",
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
    metadataStatus: "pending",
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

  it("opens pending workflow activity by default and shows uniquely ordered workers", () => {
    const agents = [
      worker({ workflowOrder: 1 }),
      worker({ id: "workflow-agent-2", label: "واجهة أمامية", workflowOrder: 0, tokens: { total: 79_000, input: 2_000, output: 1_000, cacheWrite: 38_000, cacheRead: 38_000 } }),
    ];

    const { container } = renderWorkflowActivity({ agents, historical: false, sessionId: "claude:workflow-live", workflows: [workflow()] });

    const details = container.querySelector("details.workflowActivityPanel");
    expect(details).toHaveAttribute("open");
    expect(details?.querySelector(".workflowStatus")).toHaveTextContent("Running");
    expect(screen.getByText("Claude Code has not published phase details for this running workflow yet.")).toBeInTheDocument();
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("2 observed agents");
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("162K context");
    expect(screen.getByText("واجهة أمامية")).toHaveAttribute("dir", "auto");
    const rows = within(screen.getByRole("list", { name: "Workflow workers" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("واجهة أمامية");
    expect(rows[1]).toHaveTextContent("Backend investigator");
    expect(details?.querySelector("summary .workflowDisclosureSummary")).not.toBeInTheDocument();
  });

  it("persists a collapsed historical summary per session", () => {
    window.localStorage.setItem("pomegr-workflow-panel-open-claude:workflow-history", "false");
    const agents = [worker({ status: "finished" })];
    const completed = workflow({ status: "completed", metadataStatus: "unavailable", agentIds: [agents[0].id] });

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
      metadataStatus: "unavailable",
      phases: [],
      updatedAt: "2026-08-15T11:00:00.000Z",
    });
    const active = workflow({
      metadataStatus: "ready",
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
    const phases = runs[0].querySelectorAll("details.workflowPhase");
    expect(phases).toHaveLength(2);
    expect(phases[0]).toHaveTextContent("実装");
    expect(phases[0]).toHaveTextContent("Backend investigator");
    expect(phases[0]).toHaveAttribute("open");
    expect(phases[1]).toHaveTextContent("Verify the responsive interface");
    expect(phases[1]).toHaveAttribute("open");
    expect(screen.queryByText("Claude Code has not published phase details for this running workflow yet.")).not.toBeInTheDocument();
  });

  it("keeps workflow resource rows collapsed and uses static provenance when expanded", () => {
    const verifiedWorker = worker({ workflowPhaseId: "phase-implement" });
    const active = workflow({ metadataStatus: "ready", phases: [{ id: "phase-implement", label: "Implement", agentIds: [verifiedWorker.id] }] });

    render(
      <LiveClockProvider running={false}>
        <AgentActivityPanel agents={[verifiedWorker]} executionTasks={[]} planTasks={[]} workflows={[active]} historical={false} />
      </LiveClockProvider>,
    );

    const disclosure = screen.getByRole("button", { name: /Workflow agents/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Workflow agent resource details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workflow" })).not.toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("quickwin-batch · Implement")).toBeInTheDocument();
    expect(screen.getAllByText("83K")).toHaveLength(1);
    expect(screen.getAllByText("wall time")).toHaveLength(1);
  });

  it("renders completed and upcoming phases collapsed with explicit progress", () => {
    const agents = [
      worker({ workflowPhaseId: "consult", workflowState: "done" }),
      worker({ id: "workflow-agent-2", workflowOrder: 1, workflowPhaseId: "implement", workflowState: "unknown" }),
    ];
    const ready = workflow({
      metadataStatus: "ready",
      phases: [
        { id: "consult", label: "Consult", agentIds: [agents[0].id] },
        { id: "implement", label: "Implement", agentIds: [agents[1].id] },
        { id: "verify", label: "Verify", agentIds: [] },
      ],
    });

    const { container } = renderWorkflowActivity({ agents, historical: false, sessionId: "claude:workflow-progress", workflows: [ready] });
    const phases = container.querySelectorAll("details.workflowPhase");
    expect(phases[0]).not.toHaveAttribute("open");
    expect(phases[0].querySelector("summary")).toHaveTextContent("1/1 finished");
    expect(phases[1]).not.toHaveAttribute("open");
    expect(phases[1].querySelector("summary")).toHaveTextContent("0/1 finished");
    expect(phases[2]).not.toHaveAttribute("open");
    expect(phases[2].querySelector("summary")).toHaveTextContent("No workers observed");
  });

  it("keeps unmatched and duplicate-label workers identifiable", () => {
    const longLabel = "مراجع الواجهة الدولية ".repeat(8).trim();
    const agents = [
      worker({ label: longLabel, workflowPhaseId: null, workflowState: "unknown" }),
      worker({ id: "workflow-agent-2", label: longLabel, workflowOrder: 1, workflowPhaseId: "implement", workflowState: "running" }),
    ];
    const ready = workflow({ metadataStatus: "ready", phases: [{ id: "implement", label: "تنفيذ", agentIds: [agents[1].id] }] });

    renderWorkflowActivity({ agents, historical: false, sessionId: "claude:workflow-identities", workflows: [ready] });

    expect(screen.getByRole("heading", { name: "Unassigned workers" })).toBeInTheDocument();
    const workerRows = screen.getAllByRole("listitem", { name: /worker/ });
    expect(workerRows).toHaveLength(2);
    expect(workerRows[0]).toHaveAccessibleName(/gent-2/);
    expect(workerRows[1]).toHaveAccessibleName(/gent-1/);
  });

  it("distinguishes unavailable metadata from a phase-less workflow", () => {
    renderWorkflowActivity({
      agents: [worker({ status: "finished", workflowState: "done" })],
      historical: true,
      sessionId: "claude:workflow-unavailable",
      workflows: [workflow({ status: "completed", metadataStatus: "unavailable", agentIds: ["workflow-agent-1"] })],
    });

    expect(screen.getByText("Detailed workflow metadata was not published for this run. Worker activity remains available.")).toBeInTheDocument();
    expect(screen.queryByText(/no phases/i)).not.toBeInTheDocument();
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
    expect(styles).toMatch(/\.workflowActivityPanel\s*\{[^}]*--workflow-green-fg:\s*color-mix\([^;]+var\(--ink\)\);[^}]*--workflow-amber-fg:\s*color-mix\([^;]+var\(--ink\)\);/s);
    expect(styles).toMatch(/\.workflowPhaseState,\s*\.workflowPhaseCount\s*\{[^}]*font:\s*11px\/1\.3/);
    expect(styles).toMatch(/\.workflowWorkerIdentity span\s*\{[^}]*font-size:\s*11px;/);
    expect(styles).toMatch(/\.workflowWorkerMeasure span\s*\{[^}]*font-size:\s*11px;/);
    expect(styles).toMatch(/\.workflowPhase-active > summary\s*\{[^}]*background:\s*color-mix\([^;]+var\(--panel\)\);/);
    expect(styles).toMatch(/\.workflowPhase-active \.workflowPhaseState\s*\{[^}]*color:\s*var\(--workflow-green-fg\);/);
    expect(styles).toMatch(/\.workflowPhase-upcoming \.workflowPhaseState,\s*\.workflowPhase-unknown \.workflowPhaseState\s*\{[^}]*color:\s*var\(--workflow-amber-fg\);/);
    expect(styles).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.workflowRunHeader\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(styles).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.workflowPhaseState\s*\{[^}]*grid-column:\s*2;/);
    expect(styles).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.workflowWorkerIdentity\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/);
  });
});
