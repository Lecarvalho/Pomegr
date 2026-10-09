import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard, TaskGateReason, TaskGates, TaskQueue } from "../../shared/task-contract";
import { waitingLine } from "../../app/components/tasks/task-gates-model";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TasksTab } from "../../app/components/tasks/TasksTab";

const repositoryId = "repo-0123456789abcdef01234567";
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<{ ok: true }>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const gates = (overrides: Partial<TaskGates> = {}): TaskGates => ({
  threshold: 85,
  usage: { claude: { status: "ok", fiveHourPercent: 62, sevenDayPercent: 31 }, codex: { status: "ok", fiveHourPercent: 18, sevenDayPercent: 9 } },
  providerStatus: { claude: "ok", codex: "ok" },
  workingTree: "clean",
  next: { taskId: "T-15", provider: "claude", blockedBy: null, reasons: [] },
  ...overrides,
});

function setBoard(queue: Partial<TaskQueue> = {}) {
  const board: TaskBoard = {
    version: 1, readiness: "ready", repositoryId, columns, features: [],
    tasks: [task(15, "Advance", { state: "queued" }), task(16, "Adapter", { state: "queued" })],
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-15", "T-16"], gates: gates(), ...queue },
  };
  useTasks.mockReturnValue({ board, refresh });
}
const setBridge = (bridge: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge; };

beforeEach(() => { taskAction.mockResolvedValue({ ok: true }); setBridge({ taskAction }); setBoard(); });
afterEach(() => { setBridge(undefined); vi.clearAllMocks(); });

async function showQueue() {
  render(<TasksTab repositoryId={repositoryId} />);
  await userEvent.click(within(screen.getByRole("group", { name: "Tasks view" })).getByRole("button", { name: "Queue" }));
}
const panel = () => screen.getByRole("region", { name: "Start gates" });
const row = (label: string) => within(panel()).getByText(label).closest("div") as HTMLElement;

describe("the Start gates panel", () => {
  it("lists the five gates with their readings", async () => {
    await showQueue();
    expect(within(panel()).getByRole("heading", { name: "Start gates" })).toBeTruthy();
    expect(within(panel()).getByText("Checked before every session Pomegr starts.")).toBeTruthy();
    expect(row("Previous step done").textContent).toContain("Done");
    expect(row("Claude Code capacity").textContent).toContain("5h 62% · 7d 31%");
    expect(row("Codex capacity").textContent).toContain("5h 18% · 7d 9%");
    expect(row("Provider status").textContent).toContain("No incident");
    expect(row("Working tree").textContent).toContain("Clean");
  });

  it("words each failing or unknown gate", async () => {
    setBoard({ gates: gates({
      usage: { claude: { status: "over", fiveHourPercent: 90, sevenDayPercent: null }, codex: { status: "unknown", fiveHourPercent: null, sevenDayPercent: null } },
      providerStatus: { claude: "incident", codex: "incident" }, workingTree: "dirty",
      next: { taskId: "T-15", provider: "claude", blockedBy: "T-12", reasons: ["previous_step"] },
    }) });
    await showQueue();
    expect(row("Previous step done").textContent).toContain("Blocked by T-12");
    expect(row("Claude Code capacity").textContent).toContain("5h 90% · 7d – · above threshold");
    expect(row("Codex capacity").textContent).toContain("Unknown");
    expect(row("Provider status").textContent).toContain("Incident: Claude Code, Codex");
    expect(row("Working tree").textContent).toContain("Uncommitted changes");
  });

  it("shows unknown provider status and no queued task as muted words", async () => {
    setBoard({ gates: gates({ providerStatus: { claude: "ok", codex: "unknown" }, workingTree: "unknown", next: null }) });
    await showQueue();
    expect(row("Provider status").textContent).toContain("Unknown");
    expect(row("Working tree").textContent).toContain("Unknown");
    expect(row("Previous step done").textContent).toContain("No task queued");
  });

  it("says the gates are not available when the board sent none", async () => {
    setBoard({ gates: undefined });
    await showQueue();
    expect(within(panel()).getByText("Start gates are not available yet.")).toBeTruthy();
    expect(within(panel()).queryByText("Working tree")).toBeNull();
  });

  it("changes the threshold through queue_settings in the desktop app", async () => {
    await showQueue();
    await userEvent.click(within(panel()).getByRole("combobox", { name: "Do not start above" }));
    await userEvent.click(screen.getByRole("option", { name: "95% of the five-hour window" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_settings", { threshold: 95 }));
  });

  it("shows the threshold as text without the desktop app", async () => {
    setBridge(undefined);
    await showQueue();
    expect(within(panel()).queryByRole("combobox")).toBeNull();
    expect(within(panel()).getByText("85% of the five-hour window")).toBeTruthy();
  });
});

describe("the capacity strip", () => {
  it("sits on the Board view with both readings and the rule", () => {
    render(<TasksTab repositoryId={repositoryId} />);
    const strip = screen.getByRole("region", { name: "Provider capacity" });
    expect(strip.textContent).toContain("Start gates");
    expect(strip.textContent).toContain("Claude Code 5h 62% · 7d 31%");
    expect(strip.textContent).toContain("Codex 5h 18% · 7d 9%");
    expect(strip.textContent).toContain("A task starts only when its provider has capacity.");
  });

  it("is omitted without gates", () => {
    setBoard({ gates: undefined });
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.queryByRole("region", { name: "Provider capacity" })).toBeNull();
  });
});

describe("the waiting line", () => {
  const held = gates({ next: { taskId: "T-15", provider: "codex", blockedBy: null, reasons: ["usage_over", "tree_dirty"] } });

  it("shows on the held next task while the queue runs", async () => {
    setBoard({ status: "running", gates: held });
    await showQueue();
    const text = "Waiting: Codex is above 85% of the five-hour window; the working tree has uncommitted changes";
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(document.querySelector('[data-task-id="T-16"]')?.textContent).not.toContain("Waiting");
  });

  it("does not show while the queue is not running", async () => {
    setBoard({ status: "idle", gates: held });
    await showQueue();
    expect(screen.queryByText(/^Waiting:/)).toBeNull();
  });
});

describe("waitingLine", () => {
  const queue = (status: TaskQueue["status"], next: NonNullable<TaskGates["next"]>): TaskQueue =>
    ({ status, blockedBy: null, pauseReason: null, order: [next.taskId], gates: gates({ threshold: 70, next }) });

  it("words every reason", () => {
    const reasons: TaskGateReason[] = ["previous_step", "usage_over", "usage_unknown", "provider_incident", "provider_status_unknown", "tree_dirty", "tree_unknown"];
    const next = { taskId: "T-1", provider: "claude" as const, blockedBy: "T-12", reasons };
    expect(waitingLine(queue("running", next), "T-1")).toBe("Waiting: step before it is not done (T-12); Claude Code is above 70% of the five-hour window; Claude Code usage is not known; Claude Code reports an incident; Claude Code status is not known; the working tree has uncommitted changes; the working tree state is not known");
  });

  it("is null for another task, no reasons, or a queue that is not running", () => {
    const next = { taskId: "T-1", provider: "codex" as const, blockedBy: null, reasons: [] as TaskGateReason[] };
    expect(waitingLine(queue("running", next), "T-1")).toBeNull();
    expect(waitingLine(queue("running", { ...next, reasons: ["tree_dirty"] }), "T-2")).toBeNull();
    expect(waitingLine(queue("paused", { ...next, reasons: ["tree_dirty"] }), "T-1")).toBeNull();
  });
});
