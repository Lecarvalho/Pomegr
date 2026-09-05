import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../app/Dashboard";
import { AgentActivityPanel } from "../../app/components/dashboard/AgentActivityPanel";
import { AgentHistoryIndicators, cacheRefillDescription, summarizeCacheRefillOccurrences } from "../../app/components/dashboard/AgentHistoryIndicators";
import { WorkflowActivityPanel } from "../../app/components/dashboard/WorkflowActivityPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import type { Agent, CacheReadDropCount, CacheRefillCount, ContextHistoryBoundary, MonitorState, Workflow } from "../../shared/monitor-contract";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";

function worker(overrides: Partial<Agent> = {}): Agent {
  return { id: "workflow-agent-1", parentId: "primary", workflowId: "workflow-1", workflowPhaseId: "implement", workflowOrder: 0, workflowState: "running", label: "Backend investigator", role: "workflow-worker", model: "test-model", effort: "medium", status: "active", signal: null, toolCalls: 3, skills: [], executionTasks: [], lastSeen: "2026-08-15T12:03:00.000Z", startedAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:03:00.000Z", durationMs: 180_000, cacheLifetime: "1h", tokens: { total: 83_000, input: 1_000, output: 2_000, cacheWrite: 40_000, cacheRead: 40_000 }, ...overrides };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return { id: "workflow-1", name: "quickwin-batch", summary: "Two implementation tracks.", status: "running", startedAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:03:00.000Z", durationMs: 180_000, agentIds: ["workflow-agent-1"], metadataStatus: "ready", phases: [{ id: "implement", label: "Implement", agentIds: ["workflow-agent-1"] }], ...overrides };
}

function dashboardState(): MonitorState {
  return { ...createEmptyMonitorState({ connected: true }), capabilities: { ...createEmptyMonitorState().capabilities, workflows: true }, session: { id: "claude:tree-preference", title: "Tree preference", project: "Pomegr", cwd: "C:\\Workspace\\repos\\pomegr", repository: { available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }, pullRequests: { status: "unavailable", checkedAt: null, items: [] }, startedAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:03:00.000Z", durationMs: 180_000, cost: null, approvalMode: null, contextMachinery: null, summary: null, signal: null, progress: null, pomegrPlugin: null }, agents: [worker({ id: "primary", parentId: null, label: "Primary agent", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowOrder: null, workflowState: null }), worker()], workflows: [workflow()] };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); window.localStorage.clear(); });

describe("workflow activity and agent tree view", () => {
  it.each(["list", "tree"] as const)("shows per-agent cache minimums in %s without inline documentation", (viewMode) => {
    const agents = [
      worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator", cacheLifetime: "30m+" }),
      worker({ id: "child", label: "Child", cacheLifetime: "30m+" }),
      worker({ id: "unknown", label: "Unknown", cacheLifetime: null }),
      worker({ id: "claude", label: "Recorded", cacheLifetime: "1h" }),
    ].map((agent) => ({ ...agent, workflowId: null, workflowPhaseId: null, workflowOrder: null, workflowState: null }));
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={agents} executionTasks={[]} historical={false} planTasks={[]} sessionId="codex:ttl" viewMode={viewMode} workflows={[]} /></LiveClockProvider>);
    const labels = screen.getAllByText("cache TTL ≥30m");
    expect(labels).toHaveLength(2);
    labels.forEach((label) => expect(label).not.toHaveAttribute("title"));
    expect(screen.getByText("cache TTL unavailable")).toBeInTheDocument();
    expect(screen.getByText("cache TTL 1h")).toBeInTheDocument();
    const rowRole = viewMode === "list" ? "listitem" : "treeitem";
    expect(screen.getByRole(rowRole, { name: /Primary.*cache TTL ≥30m/ })).toBeInTheDocument();
    expect(screen.getByRole(rowRole, { name: /Child.*cache TTL ≥30m/ })).toBeInTheDocument();
  });

  it("places the workflow summary card before agent activity", async () => {
    const state = dashboardState();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => Promise.resolve(new Response(JSON.stringify(String(input) === "/api/sessions" ? { sessions: [] } : state), { status: 200 })));
    const { container } = render(<Dashboard />);
    const panel = await waitFor(() => { const element = container.querySelector(".sessionSummaryCards"); expect(element).toBeInTheDocument(); return element!; });
    expect(panel.nextElementSibling).toBe(container.querySelector(".contentGrid"));
    expect(panel).toHaveTextContent("quickwin-batch");
    expect(panel.querySelector('a[href="#agent-activity"]')).toBeInTheDocument();
    expect(container.querySelector("details.workflowActivityPanel")).not.toBeInTheDocument();
    expect(panel.querySelector(".workflowWorkerRows, .workflowWorkerRow, .workflowWorkerGroup")).not.toBeInTheDocument();
  });

  it("shows workflow identity, lifecycle, context, wall time, metadata, and phase progress without worker rows", () => {
    const unrelated = worker({ id: "other-workflow-agent", workflowId: "workflow-2", workflowPhaseId: "implement", workflowState: "done", status: "finished" });
    render(<LiveClockProvider running={false}><WorkflowActivityPanel agents={[worker(), unrelated]} historical sessionId="claude:workflow" workflows={[workflow({ phases: [{ id: "implement", label: "Implement", agentIds: ["workflow-agent-1", "other-workflow-agent"] }] })]} /></LiveClockProvider>);
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("1 observed agent");
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("83K context");
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("3m wall time");
    expect(screen.getByLabelText("quickwin-batch phase progress")).toHaveTextContent("Active");
    expect(screen.getByLabelText("quickwin-batch phase progress")).toHaveTextContent("0/1 finished");
    expect(screen.queryByRole("list", { name: "Workflow workers" })).not.toBeInTheDocument();
  });

  it("uses the session-scoped List default, persists Tree choice, and gives Tree the full grid width", async () => {
    const state = dashboardState();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => Promise.resolve(new Response(JSON.stringify(String(input) === "/api/sessions" ? { sessions: [] } : state), { status: 200 })));
    const user = userEvent.setup();
    const { container, unmount } = render(<Dashboard />);
    await screen.findByRole("button", { name: "Tree" });
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Tree" }));
    expect(container.querySelector(".contentGrid")).toHaveAttribute("id", "agent-activity");
    expect(container.querySelector(".agentsPanel")).toHaveClass("agentsPanel-tree");
    expect(window.localStorage.getItem("pomegr-agent-activity-view-claude:tree-preference")).toBe("tree");
    unmount();
    render(<Dashboard />);
    expect((await screen.findByRole("button", { name: "Tree" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("lists every agent exactly once, including workflow agents, and accepts legacy missing roles", () => {
    const primary = worker({ id: "primary", parentId: null, label: "Primary agent", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowOrder: null, workflowState: null });
    const legacy = { ...worker({ id: "legacy", label: "Legacy agent", workflowId: null, workflowPhaseId: null }), role: undefined } as unknown as Agent;
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, worker(), legacy]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:list" viewMode="list" onViewModeChange={() => {}} workflows={[workflow()]} /></LiveClockProvider>);
    const rows = within(screen.getByRole("list", { name: "Session agents" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Workflow agents/ })).not.toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("shows symbol-only compaction counts independently for each agent", async () => {
    const user = userEvent.setup();
    const primary = worker({ id: "primary", parentId: null, label: "Primary agent", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowOrder: null, workflowState: null });
    const child = worker({ id: "child", parentId: "primary", label: "Child agent", workflowId: null, workflowPhaseId: null });
    const quiet = worker({ id: "quiet", parentId: "primary", label: "Quiet agent", workflowId: null, workflowPhaseId: null });
    const contextBoundaries: ContextHistoryBoundary[] = [
      { id: "auto-primary", agentId: "primary", timestamp: "2026-08-15T12:01:00.000Z", kind: "automatic_compaction", preTokens: 80_000 },
      { id: "manual-primary", agentId: "primary", timestamp: "2026-08-15T12:02:00.000Z", kind: "manual_compaction", preTokens: null },
      { id: "manual-child", agentId: "child", timestamp: "2026-08-15T12:02:30.000Z", kind: "manual_compaction", preTokens: 70_000 },
      { id: "drop-quiet", agentId: "quiet", timestamp: "2026-08-15T12:02:45.000Z", kind: "snapshot_drop", preTokens: 65_000 },
    ];
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, child, quiet]} contextBoundaries={contextBoundaries} executionTasks={[]} historical={false} planTasks={[]} sessionId="codex:compactions" viewMode="list" workflows={[]} /></LiveClockProvider>);

    const primaryRow = screen.getByRole("listitem", { name: /Primary agent agent, cache TTL 1h, 2 compactions/ });
    const childRow = screen.getByRole("listitem", { name: /Child agent agent, cache TTL 1h, 1 compaction/ });
    const quietRow = screen.getByRole("listitem", { name: /Quiet agent agent, cache TTL 1h/ });
    const primaryMark = within(primaryRow).getByRole("button", { name: "2 compactions · 1 automatic · 1 manual." });
    expect(primaryMark.querySelector("svg.agentHistoryIcon")).toBeInTheDocument();
    expect(primaryMark.querySelector(".agentHistoryDot")).not.toBeInTheDocument();
    expect(primaryMark).toHaveTextContent("2");
    expect(within(childRow).getByRole("button", { name: "1 compaction · 1 manual." })).toHaveTextContent("1");
    expect(within(quietRow).queryByRole("button", { name: /compaction/ })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".agentHistoryIndicator")).toHaveLength(2);
    expect(screen.queryByText(/compaction/i)).not.toBeInTheDocument();

    await user.hover(primaryMark);
    expect(screen.getByRole("tooltip")).toHaveTextContent("2 compactions · 1 automatic · 1 manual.");
  });

  it("aggregates compaction counts only for agents represented by a Tree cluster", () => {
    const primary = worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator", workflowId: null, workflowPhaseId: null });
    const clustered = Array.from({ length: 5 }, (_, index) => worker({ id: `clustered-${index}`, parentId: "primary", label: "Repeated worker", workflowId: null, workflowPhaseId: null }));
    const contextBoundaries: ContextHistoryBoundary[] = [
      { id: "cluster-auto", agentId: "clustered-0", timestamp: "2026-08-15T12:01:00.000Z", kind: "automatic_compaction", preTokens: 80_000 },
      { id: "cluster-manual", agentId: "clustered-3", timestamp: "2026-08-15T12:02:00.000Z", kind: "manual_compaction", preTokens: null },
      { id: "primary-manual", agentId: "primary", timestamp: "2026-08-15T12:02:30.000Z", kind: "manual_compaction", preTokens: null },
    ];
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, ...clustered]} contextBoundaries={contextBoundaries} executionTasks={[]} historical={false} planTasks={[]} sessionId="codex:cluster-compactions" viewMode="tree" workflows={[]} /></LiveClockProvider>);

    const cluster = screen.getByRole("treeitem", { name: /Repeated worker ×5, 5 matching agents, 2 compactions/ });
    expect(within(cluster).getByRole("button", { name: "2 compactions across 5 agents · 1 automatic · 1 manual." })).toHaveTextContent("2");
    expect(screen.getByRole("treeitem", { name: /Primary, orchestrator, active, cache TTL 1h, 1 compaction/ })).toBeInTheDocument();
  });

  it("shows a counted stack-refill mark only for possible full cache refills", async () => {
    const user = userEvent.setup();
    const primary = worker({ id: "primary", parentId: null, label: "Primary agent", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowOrder: null, workflowState: null });
    const child = worker({ id: "child", parentId: "primary", label: "Child agent", workflowId: null, workflowPhaseId: null });
    const cacheRefills: CacheRefillCount[] = [{
      agentId: "primary",
      count: 2,
      occurrences: [{
        observedAt: "2026-08-15T12:01:00.000Z",
        reason: "tools_changed",
        providerStatus: null,
        cacheLifetimeInference: null,
        messageChangeSequence: null,
        toolChangeAttribution: {
          cause: "remote_control_connected",
          changes: [
            { tool: "RemoteTrigger", kind: "added" },
            { tool: "PushNotification", kind: "added" },
            { tool: "ListAgents", kind: "definition_changed" },
          ],
        },
      }, {
        observedAt: "2026-08-15T12:02:00.000Z",
        reason: "messages_changed",
        providerStatus: null,
        cacheLifetimeInference: null,
        messageChangeSequence: "post_tool_task_notification_resume",
        toolChangeAttribution: null,
      }],
      reasons: [{ reason: "tools_changed", count: 1 }, { reason: "messages_changed", count: 1 }],
      toolChangeAttributions: [{
        cause: "remote_control_connected",
        count: 1,
        changes: [
          { tool: "RemoteTrigger", kind: "added" },
          { tool: "PushNotification", kind: "added" },
          { tool: "ListAgents", kind: "definition_changed" },
        ],
      }],
    }];
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, child]} cacheRefills={cacheRefills} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:cache-refills" viewMode="list" workflows={[]} /></LiveClockProvider>);

    const primaryRow = screen.getByRole("listitem", { name: /Primary agent agent, cache TTL 1h, 2 possible full cache refills/ });
    const childRow = screen.getByRole("listitem", { name: /Child agent agent, cache TTL 1h/ });
    expect(within(primaryRow).getByText("cache TTL 1h")).toBeInTheDocument();
    const refillDescription = "Possible full cache refill observed 2 times. Provider diagnostic: tool definitions changed · message history changed. Inference: Remote Control connected; likely changed RemoteTrigger (added), PushNotification (added), ListAgents (definition changed).";
    const refillMark = within(primaryRow).getByRole("button", { name: refillDescription });
    expect(refillMark).toHaveTextContent("2");
    expect(refillMark.querySelector("svg.agentCacheRefillIcon")).toBeInTheDocument();
    expect(within(childRow).queryByRole("button", { name: /cache refill/i })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".agentCacheRefillIndicator")).toHaveLength(1);

    await user.click(refillMark);
    const popover = screen.getByRole("dialog", { name: "Cache refill evidence" });
    expect(popover).toHaveTextContent("Possible full cache refill observed 2 times.");
    expect(within(popover).getAllByRole("listitem")).toHaveLength(2);
    const occurrences = within(popover).getAllByRole("listitem");
    expect(occurrences[0]).toHaveTextContent("Provider");
    expect(occurrences[0]).toHaveTextContent("tool definitions changed");
    expect(occurrences[0].querySelector("time")).toHaveAttribute("datetime", "2026-08-15T12:01:00.000Z");
    expect(occurrences[0]).toHaveTextContent("Claude reported changed tool definitions, and Pomegr matched the fixed Remote Control connection transition.");
    expect(occurrences[0]).toHaveTextContent("cache.tools_changed.remote_control_connected");
    expect(within(occurrences[0]).getByRole("link", { name: "Open signal definition (opens in a new tab)" })).toHaveAttribute("href", "https://github.com/Lecarvalho/pomegr/blob/main/docs/SIGNAL_DICTIONARY.md#cache-tools-changed-remote-control-connected");
    expect(occurrences[1]).toHaveTextContent("message history changed");
    expect(occurrences[1].querySelector("time")).toHaveAttribute("datetime", "2026-08-15T12:02:00.000Z");
    expect(occurrences[1]).toHaveTextContent("Tool use and its result were followed by a provider task notification and the directly resumed request.");
    expect(occurrences[1]).toHaveTextContent("cache.messages_changed.post_tool_notification_resume");
    expect(within(occurrences[1]).getByRole("link", { name: "Open signal definition (opens in a new tab)" })).toHaveAttribute("href", "https://github.com/Lecarvalho/pomegr/blob/main/docs/SIGNAL_DICTIONARY.md#cache-messages-changed-post-tool-notification-resume");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Cache refill evidence" })).not.toBeInTheDocument();
  });

  it.each(["list", "tree"] as const)("shows scoped inferred cache-refill evidence in %s and preserves the amber refill icon", async (viewMode) => {
    const user = userEvent.setup();
    const primary = worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator", workflowId: null, workflowPhaseId: null });
    const clustered = Array.from({ length: 5 }, (_, index) => worker({ id: `clustered-${index}`, parentId: "primary", label: "Repeated worker", workflowId: null, workflowPhaseId: null }));
    const cacheReadDrops: CacheReadDropCount[] = [{
      agentId: "clustered-0",
      count: 2,
      occurrences: [
        { id: "drop-1", observedAt: "2026-08-15T12:01:00.000Z", previousCacheReadPercent: 92, cacheReadPercent: 4, gapMs: 60_000 },
        { id: "drop-2", observedAt: "2026-08-15T12:02:00.000Z", previousCacheReadPercent: 85, cacheReadPercent: 9, gapMs: 90_000 },
      ],
    }, {
      agentId: "clustered-3",
      count: 1,
      occurrences: [{ id: "drop-3", observedAt: "2026-08-15T12:03:00.000Z", previousCacheReadPercent: 88, cacheReadPercent: 3, gapMs: 120_000 }],
    }];
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, ...clustered]} cacheReadDrops={cacheReadDrops} executionTasks={[]} historical={false} planTasks={[]} sessionId="codex:cache-read-drops" viewMode={viewMode} workflows={[]} /></LiveClockProvider>);

    const rowRole = viewMode === "list" ? "listitem" : "treeitem";
    const target = viewMode === "list"
      ? screen.getByRole(rowRole, { name: /Repeated worker agent .*cache TTL 1h, 2 possible cache refills/ })
      : screen.getByRole(rowRole, { name: /Repeated worker ×5, 5 matching agents, 3 possible cache refills/ });
    const trigger = within(target).getByRole("button", { name: viewMode === "list" ? "Possible cache refill inferred 2 times." : "Possible cache refill inferred 3 times across 5 agents." });
    expect(trigger).toHaveTextContent(viewMode === "list" ? "2" : "3");
    expect(trigger.querySelector("svg.agentCacheRefillIcon")).toBeInTheDocument();

    await user.click(trigger);
    const popover = screen.getByRole("dialog", { name: "Possible cache refill evidence" });
    expect(popover).toHaveTextContent("Possible cache refill");
    expect(popover).toHaveTextContent("92% → 4% cache read");
    expect(popover).toHaveTextContent("InferencePossible cache refill.");
    expect(popover).toHaveTextContent("No positive cache-write evidence, so a refill and its cause cannot be confirmed.");
    within(popover).getAllByRole("link", { name: "Open signal definition (opens in a new tab)" }).forEach((link) => expect(link).toHaveAttribute("href", "https://github.com/Lecarvalho/pomegr/blob/main/docs/SIGNAL_DICTIONARY.md#cache-read-reuse-dropped"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Possible cache refill evidence" })).not.toBeInTheDocument();
  });

  it.each([undefined, [] as CacheReadDropCount[]])("omits inferred cache-refill evidence when the separate feed is %s", (cacheReadDrops) => {
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator", workflowId: null, workflowPhaseId: null })]} cacheReadDrops={cacheReadDrops} executionTasks={[]} historical={false} planTasks={[]} sessionId="codex:no-cache-read-drops" viewMode="list" workflows={[]} /></LiveClockProvider>);
    expect(screen.queryByRole("button", { name: /Possible cache refill inferred/ })).not.toBeInTheDocument();
  });

  it("caps an inferred cache-refill indicator at 99+ while retaining its full accessible count", () => {
    render(<AgentHistoryIndicators agentIds={["primary"]} boundaries={[]} cacheReadDrops={[{
      agentId: "primary",
      count: 100,
      occurrences: [{ id: "drop-overflow", observedAt: "2026-08-15T12:01:00.000Z", previousCacheReadPercent: 92, cacheReadPercent: 4, gapMs: 60_000 }],
    }]} />);
    expect(screen.getByRole("button", { name: "Possible cache refill inferred 100 times." })).toHaveTextContent("99+");
  });

  it("bounds the accessible cache-refill summary independently of occurrence count", () => {
    const occurrences = Array.from({ length: 999 }, (_, index) => ({
      observedAt: "2026-08-15T12:02:00.000Z",
      reason: null,
      providerStatus: "previous_cache_entry_unavailable" as const,
      cacheLifetimeInference: { cause: "cache_lifetime_elapsed" as const, cacheLifetime: "1h" as const, elapsedMs: (61 + index) * 60_000 },
      messageChangeSequence: null,
      toolChangeAttribution: null,
    }));
    const summarized = summarizeCacheRefillOccurrences([{
      agentId: "primary",
      count: occurrences.length,
      occurrences,
      reasons: [],
      toolChangeAttributions: [],
    }], ["primary"]);
    const description = cacheRefillDescription(occurrences.length, 1, [], [], summarized);

    expect(description).toContain("previous cache entry unavailable (999)");
    expect(description).toContain("996 additional inference categories");
    expect(description.length).toBeLessThan(500);
  });

  it("links an unavailable previous cache entry to its public definition while preserving the expiry inference", async () => {
    const user = userEvent.setup();
    render(<AgentHistoryIndicators agentIds={["primary"]} boundaries={[]} cacheRefills={[{
      agentId: "primary",
      count: 1,
      occurrences: [{
        observedAt: "2026-08-15T12:02:00.000Z",
        reason: null,
        providerStatus: "previous_cache_entry_unavailable",
        cacheLifetimeInference: { cause: "cache_lifetime_elapsed", cacheLifetime: "1h", elapsedMs: 61 * 60_000 },
        messageChangeSequence: null,
        toolChangeAttribution: null,
      }],
      reasons: [],
      toolChangeAttributions: [],
    }]} />);

    await user.click(screen.getByRole("button", { name: /Possible full cache refill observed 1 time/ }));
    const popover = screen.getByRole("dialog", { name: "Cache refill evidence" });
    expect(popover).toHaveTextContent("cache.previous_cache_entry_unavailable");
    expect(popover).toHaveTextContent("Pomegr normalized Claude's diagnostic as the previous cache entry being unavailable.");
    expect(popover).toHaveTextContent("InferenceOne-hour cache likely expired; 1h 1m elapsed since the preceding request.");
    expect(within(popover).getByRole("link", { name: "Open signal definition (opens in a new tab)" })).toHaveAttribute(
      "href",
      "https://github.com/Lecarvalho/pomegr/blob/main/docs/SIGNAL_DICTIONARY.md#cache-previous-cache-entry-unavailable",
    );
  });

  it("aggregates possible full cache refills only across agents represented by a Tree cluster", () => {
    const primary = worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator", workflowId: null, workflowPhaseId: null });
    const clustered = Array.from({ length: 5 }, (_, index) => worker({ id: `clustered-${index}`, parentId: "primary", label: "Repeated worker", workflowId: null, workflowPhaseId: null }));
    const cacheRefills: CacheRefillCount[] = [
      { agentId: "clustered-0", count: 1, occurrences: [{ observedAt: "2026-08-15T12:01:00.000Z", reason: "system_changed", providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null }], reasons: [{ reason: "system_changed", count: 1 }], toolChangeAttributions: [] },
      { agentId: "clustered-3", count: 1, occurrences: [{ observedAt: "2026-08-15T12:02:00.000Z", reason: "tools_changed", providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null }], reasons: [{ reason: "tools_changed", count: 1 }], toolChangeAttributions: [] },
      { agentId: "primary", count: 1, occurrences: [{ observedAt: "2026-08-15T12:03:00.000Z", reason: null, providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null }], reasons: [], toolChangeAttributions: [] },
    ];
    render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, ...clustered]} cacheRefills={cacheRefills} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:cluster-cache-refills" viewMode="tree" workflows={[]} /></LiveClockProvider>);

    const cluster = screen.getByRole("treeitem", { name: /Repeated worker ×5, 5 matching agents, 2 possible full cache refills/ });
    expect(within(cluster).getByRole("button", { name: "Possible full cache refill observed 2 times across 5 agents. Provider diagnostic: system instructions changed · tool definitions changed." })).toHaveTextContent("2");
    expect(screen.getByRole("treeitem", { name: /Primary, orchestrator, active, cache TTL 1h, 1 possible full cache refill/ })).toBeInTheDocument();
    expect(screen.getAllByText("cache TTL 1h").length).toBeGreaterThan(0);
  });

  it("toggles terminal subagents in List and Tree and remembers the choice per session", async () => {
    const user = userEvent.setup();
    const agents = [
      worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator" }),
      worker({ id: "finished-parent", parentId: "primary", label: "Finished parent", status: "finished" }),
      worker({ id: "active-child", parentId: "finished-parent", label: "Active child" }),
      worker({ id: "finished-leaf", parentId: "primary", label: "Finished leaf", status: "finished" }),
      worker({ id: "stopped-leaf", parentId: "primary", label: "Stopped leaf", status: "stopped" }),
    ];
    const panel = (sessionId: string, viewMode: "list" | "tree") => <LiveClockProvider running={false}><AgentActivityPanel agents={agents} executionTasks={[]} historical={false} planTasks={[]} sessionId={sessionId} viewMode={viewMode} workflows={[]} /></LiveClockProvider>;
    const { rerender } = render(panel("claude:finished-a", "list"));
    const finishedToggle = screen.getByRole("button", { name: "Show finished (3)" });

    expect(finishedToggle).toHaveAttribute("aria-pressed", "true");
    await user.click(finishedToggle);
    expect(window.localStorage.getItem("pomegr-agent-activity-show-finished-claude:finished-a")).toBe("false");
    expect(screen.getByRole("list", { name: "Session agents" })).toHaveTextContent("Finished parent");
    expect(screen.getByRole("list", { name: "Session agents" })).toHaveTextContent("Active child");
    expect(screen.queryByText("Finished leaf")).not.toBeInTheDocument();
    expect(screen.queryByText("Stopped leaf")).not.toBeInTheDocument();

    rerender(panel("claude:finished-a", "tree"));
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    expect(screen.getByRole("treeitem", { name: /Finished parent/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Finished leaf/ })).not.toBeInTheDocument();

    rerender(panel("claude:finished-b", "list"));
    expect(screen.getByRole("button", { name: "Show finished (3)" })).toHaveAttribute("aria-pressed", "true");
    rerender(panel("claude:finished-a", "list"));
    expect(screen.getByRole("button", { name: "Show finished (3)" })).toHaveAttribute("aria-pressed", "false");
  });

  it("renders the top-down tree, vertical connectors, provenance, and the List-view detail note", () => {
    const primary = worker({ id: "primary", parentId: null, label: "Primary agent", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowOrder: null, workflowState: null });
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, worker()]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:tree" viewMode="tree" onViewModeChange={() => {}} workflows={[workflow()]} /></LiveClockProvider>);
    expect(screen.getByRole("tree", { name: "Agent spawn hierarchy" })).toBeInTheDocument();
    expect(container.querySelectorAll(".agentTreeCard svg.agentTreeRoleGlyph")).toHaveLength(2);
    expect(container.querySelector(".agentTreeNode")?.getAttribute("style")).toContain("--tree-x");
    expect(container.querySelector(".agentTreeConnectors path")?.getAttribute("d")).toMatch(/^M[^V]+V[^H]+H[^V]+V/);
    expect(container.querySelector(".agentTreeCard.activeAgent .agentTreeRole")).toBeInTheDocument();
    expect(screen.getByText("Workflow: quickwin-batch · Implement")).toBeInTheDocument();
    expect(screen.getByText("Tasks, skills, execution, and plan details are available in List view.")).toBeInTheDocument();
  });

  it("advances only live running workflow wall time", () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-08-15T12:03:00.000Z");
    render(<LiveClockProvider running><WorkflowActivityPanel agents={[]} historical={false} sessionId="claude:timer" workflows={[workflow({ agentIds: [], phases: [] })]} /></LiveClockProvider>);
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("3m wall time");
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByLabelText("quickwin-batch workflow measurements")).toHaveTextContent("5m wall time");
  });

  it("uses observed container width for rail/columns and preserves a stored column camera", async () => {
    let measuredWidth = 390;
    const callbacks: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];
    class MockResizeObserver { constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) { callbacks.push(callback); } observe() { callbacks.at(-1)?.([{ contentRect: { width: measuredWidth } }]); } disconnect() {} }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    window.localStorage.setItem("pomegr-agent-tree-camera-claude:responsive", JSON.stringify({ x: 12, y: 24, scale: 1.5 }));
    const { container, rerender } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={dashboardState().agents} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:responsive" viewMode="tree" workflows={[workflow()]} /></LiveClockProvider>);
    await waitFor(() => expect(container.querySelector(".agentTreeView-rail")).toBeInTheDocument());
    expect(container.querySelector(".agentTreeCameraControls")).not.toBeInTheDocument();
    measuredWidth = 640; act(() => callbacks.at(-1)?.([{ contentRect: { width: measuredWidth } }]));
    await waitFor(() => expect(container.querySelector(".agentTreeView-columns")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Fit 150%" })).toBeInTheDocument());
    measuredWidth = 1200; act(() => callbacks.at(-1)?.([{ contentRect: { width: measuredWidth } }]));
    expect(container.querySelector(".agentTreeView-columns")).toBeInTheDocument();
    rerender(<LiveClockProvider running={false}><AgentActivityPanel agents={dashboardState().agents} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:responsive" viewMode="tree" workflows={[workflow()]} /></LiveClockProvider>);
    expect(window.localStorage.getItem("pomegr-agent-tree-camera-claude:responsive")).toContain("1.5");
  });

  it("fits every tree card inside the canvas and centers the complete bounds", async () => {
    class MockResizeObserver { constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) { callback([{ contentRect: { width: 1_000 } }]); } observe() {} disconnect() {} }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(520);
    const agents = [
      worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator" }),
      worker({ id: "branch", parentId: "primary", label: "Branch" }),
      worker({ id: "top", parentId: "branch", label: "Top" }),
      worker({ id: "middle", parentId: "branch", label: "Middle" }),
      worker({ id: "bottom", parentId: "branch", label: "Bottom" }),
    ];
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={agents} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:fit" viewMode="tree" workflows={[]} /></LiveClockProvider>);
    await userEvent.click(await screen.findByRole("button", { name: /Fit/ }));
    const surface = container.querySelector(".agentTreeSurface") as HTMLDivElement;
    const scale = Number(surface.style.getPropertyValue("--tree-camera-scale"));
    const cameraX = Number.parseFloat(surface.style.getPropertyValue("--tree-camera-x"));
    const cameraY = Number.parseFloat(surface.style.getPropertyValue("--tree-camera-y"));
    const nodes = [...container.querySelectorAll<HTMLElement>(".agentTreeNode")];
    const left = Math.min(...nodes.map((node) => Number.parseFloat(node.style.getPropertyValue("--tree-x"))));
    const right = Math.max(...nodes.map((node) => Number.parseFloat(node.style.getPropertyValue("--tree-x")) + Number.parseFloat(node.style.getPropertyValue("--tree-w"))));
    const top = Math.min(...nodes.map((node) => Number.parseFloat(node.style.getPropertyValue("--tree-y"))));
    const bottom = Math.max(...nodes.map((node) => Number.parseFloat(node.style.getPropertyValue("--tree-y")) + Number.parseFloat(node.style.getPropertyValue("--tree-h"))));
    const screenLeft = left * scale + cameraX;
    const screenRight = right * scale + cameraX;
    const screenTop = top * scale + cameraY;
    const screenBottom = bottom * scale + cameraY;
    expect(screenLeft).toBeGreaterThanOrEqual(24);
    expect(screenRight).toBeLessThanOrEqual(976);
    expect((screenLeft + screenRight) / 2).toBeCloseTo(500);
    expect(screenTop).toBeGreaterThanOrEqual(24);
    expect(screenBottom).toBeLessThanOrEqual(496);
    expect((screenTop + screenBottom) / 2).toBeCloseTo(260);
  });

  it("supports roving tree keys, drag separation, and phase membership without Tree phase rows", () => {
    const primary = worker({ id: "primary", parentId: null, label: "Primary", role: "orchestrator", workflowId: null, workflowPhaseId: null, workflowState: null });
    const child = worker({ id: "child", parentId: "primary", workflowId: "workflow-1", workflowPhaseId: "implement" });
    const { container } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[primary, child]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:keys" viewMode="tree" workflows={[workflow({ updatedAt: null as unknown as string, agentIds: [], phases: [{ id: "implement", label: "Implement", agentIds: [] }] })]} /></LiveClockProvider>);
    const root = screen.getByRole("treeitem", { name: /Primary/ });
    root.focus(); fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(screen.queryByRole("treeitem", { name: /Backend investigator/ })).not.toBeInTheDocument();
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: /Backend investigator/ })).toBeInTheDocument();
    expect(root).toHaveAccessibleName(/1 descendants:/);
    expect(root).not.toHaveAccessibleName(/hidden descendants/);
    const canvas = container.querySelector(".agentTreeCanvas") as HTMLDivElement;
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() });
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 }); fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 30, clientY: 10 }); fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 30, clientY: 10 });
    expect(canvas.setPointerCapture).toHaveBeenCalled();
    window.localStorage.setItem("pomegr-workflow-panel-open-claude:tree-workflow", "false");
    render(<LiveClockProvider running={false}><WorkflowActivityPanel agents={[child]} historical={false} sessionId="claude:tree-workflow" viewMode="tree" workflows={[workflow({ updatedAt: null as unknown as string, agentIds: [], phases: [{ id: "implement", label: "Implement", agentIds: [] }] })]} /></LiveClockProvider>);
    expect(screen.getByText("Workflow activity").closest("summary")).toHaveTextContent("1 agent");
    expect(screen.queryByLabelText("quickwin-batch phase progress")).not.toBeInTheDocument();
  });

  it("degrades without ResizeObserver and handles empty, historical, long RTL, large, and unavailable-storage trees", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const root = worker({ id: "root", parentId: null, label: "عنوان طويل جداً للعامل الرئيسي مع تفاصيل إضافية" });
    const child = worker({ id: "child", parentId: "root", label: "Child" });
    const grandchild = worker({ id: "grandchild", parentId: "child", label: "Grandchild" });
    const many = Array.from({ length: 42 }, (_, index) => worker({ id: `agent-${index}`, parentId: null, label: `Agent ${index}` }));
    const { container, rerender } = render(<LiveClockProvider running={false}><AgentActivityPanel agents={[root, child, grandchild, ...many]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:hardening" viewMode="tree" workflows={[]} /></LiveClockProvider>);
    expect(container.querySelector(".agentTreeView-columns")).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")).toHaveLength(45);
    expect(screen.getByRole("treeitem", { name: /عنوان طويل/ })).toBeInTheDocument();
    rerender(<LiveClockProvider running={false}><AgentActivityPanel agents={[root, child, grandchild]} executionTasks={[]} historical planTasks={[]} sessionId="claude:historical" viewMode="tree" workflows={[]} /></LiveClockProvider>);
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /Grandchild/ })).not.toBeInTheDocument());
    rerender(<LiveClockProvider running={false}><AgentActivityPanel agents={[]} executionTasks={[]} historical={false} planTasks={[]} sessionId="claude:empty" viewMode="tree" workflows={[]} /></LiveClockProvider>);
    expect(screen.getByText("No agents have appeared in this session yet.")).toBeInTheDocument();
    expect(screen.getByText("Tasks, skills, execution, and plan details are available in List view.")).toBeInTheDocument();
  });
});
