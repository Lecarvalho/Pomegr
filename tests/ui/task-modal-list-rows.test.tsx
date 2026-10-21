import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "../../shared/task-contract";

vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [{ source: "Claude Code", model: "model-a" }] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));

import { TaskModal } from "../../app/components/tasks/TaskModal";
import { AFTER_HELPER } from "../../app/components/tasks/task-after-model";
import { ASSIGN_HELPER } from "../../app/components/tasks/TaskSessionsField";
import { START_AT_HINT } from "../../app/components/tasks/TaskStartTimeField";

// Runs after, Sessions, and Start at are rows of the same Run settings list as the settings above them (owner follow-up, 2026-10-21): the
// label column, the ruled rows, the borderless value select with the Secondary action beside it, and one short muted hint.

const repositoryId = "repo-0123456789abcdef01234567";
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const taskAction = vi.fn(async () => ({ ok: true }));
const refresh = vi.fn(async () => {});

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, text: `Text of ${id}`, columnId: "col-1", position: 1, featureId: null, group: null,
    run: { provider: "claude", model: "model-a", effort: "high" }, completeWhen: { checks: ["pr_open"], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const done = task("T-13", { state: "done", columnId: "col-5" });
const waiting = task("T-14");
const other = task("T-15");
const session = { id: "claude:abc123", title: "Retry the uploads", state: "idle", observedModel: "model-a" };

function open(value: Task) {
  const tasks = [value, done, waiting, other];
  const board: Pick<TaskBoard, "columns" | "features" | "tasks"> & { queue: TaskBoard["queue"] } = {
    columns, features: [], tasks, queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] },
  };
  return render(<TaskModal mode="edit" repositoryId={repositoryId} repositoryName="pomegr" task={value} board={board} refresh={refresh}
    onChanged={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()} />);
}

const rowLabels = () => [...document.querySelectorAll(".taskRows > .taskRow > dt")].map((label) => label.textContent);
const row = (label: string) => [...document.querySelectorAll("dt")].find((term) => term.textContent === label)?.closest(".taskRow") as HTMLElement;
const sessions = (...rows: Array<{ id: string; title: string; activityStatus: string }>) => vi.fn(async () => ({ ok: true, json: async () => ({ sessions: rows }) }));

beforeEach(() => {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { taskAction };
  vi.stubGlobal("fetch", sessions({ id: "claude:c1", title: "Candidate one", activityStatus: "working" }));
});
afterEach(() => {
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a task that has not started", () => {
  it("closes the Run settings list with Runs after, Sessions, and Start at, and draws no fieldset or legend", async () => {
    open(task("T-20", { after: ["T-13", "T-14"] }));
    await waitFor(() => expect(rowLabels()).toContain("Sessions"));
    expect(rowLabels()).toEqual(["Feature", "Run on", "Effort", "Remote Control", "When done", "Complete when", "GitHub issue", "Runs after", "Sessions", "Start at"]);
    expect(document.querySelector(".taskModalBody fieldset, .taskModalBody legend")).toBeNull();
    // All the rows are one list: one heading and one dl.
    expect(document.querySelectorAll(".taskRunSettings")).toHaveLength(1);
    expect(document.querySelectorAll(".taskModalBody dl")).toHaveLength(1);
  });

  it("draws Runs after as items, then one add line with the borderless select and the Secondary Add, then one hint", () => {
    open(task("T-20", { after: ["T-13", "T-14"] }));
    const value = within(row("Runs after"));
    const group = value.getByRole("group", { name: "Runs after" });
    expect(within(group).getAllByRole("listitem")).toHaveLength(2);
    expect(within(group).getByRole("button", { name: "Remove T-13" })).toHaveClass("commandQuietAction");
    expect(within(group).getByText("T-13")).toHaveClass("taskAfterId");
    const add = group.querySelector(".taskSessionsAssign") as HTMLElement;
    expect(within(add).getByRole("combobox", { name: "Task this one runs after" }).closest(".commandSelect")).toHaveClass("taskValueSelect");
    expect(within(add).getByRole("combobox", { name: "Task this one runs after" })).toHaveTextContent("Choose a task");
    expect(within(add).getByRole("button", { name: "Add" })).toHaveClass("commandSecondaryAction");
    expect(within(add).getByRole("button", { name: "Add" })).toBeDisabled();
    expect(AFTER_HELPER).toBe("Starts only when every task here is Done or deleted.");
    expect(within(group).getByText(AFTER_HELPER)).toHaveClass("newTaskHelper");
    expect(within(add).getByRole("button", { name: "Add" })).toHaveAccessibleDescription(AFTER_HELPER);
    // The hint is one short line: no second sentence about what Pomegr starts or stops.
    expect(group).not.toHaveTextContent(/starts and stops nothing/i);
  });

  it("draws Sessions as the same row, with its add line named Assign session and its one hint", async () => {
    open(task("T-20"));
    await waitFor(() => expect(rowLabels()).toContain("Sessions"));
    const group = within(row("Sessions")).getByRole("group", { name: "Sessions" });
    expect(group.querySelector(".taskSessionsList")).toBeNull();
    const add = group.querySelector(".taskSessionsAssign") as HTMLElement;
    expect(within(add).getByRole("combobox", { name: "Session to assign" }).closest(".commandSelect")).toHaveClass("taskValueSelect");
    expect(within(add).getByRole("combobox", { name: "Session to assign" })).toHaveTextContent("Choose a session");
    expect(within(add).getByRole("button", { name: "Assign session" })).toHaveClass("commandSecondaryAction");
    expect(ASSIGN_HELPER).toBe("An assigned session can report this task complete or blocked.");
    expect(within(group).getByText(ASSIGN_HELPER)).toHaveClass("newTaskHelper");
    expect(within(add).getByRole("button", { name: "Assign session" })).toHaveAccessibleDescription(ASSIGN_HELPER);
  });

  it("draws Start at as a compact date-and-time field with its hint under it, named by the row's label", () => {
    open(task("T-20"));
    const field = screen.getByLabelText("Start at") as HTMLInputElement;
    expect(field).toHaveAttribute("type", "datetime-local");
    expect(field).toHaveClass("taskTimeInput");
    expect(field.closest(".taskRow")).toHaveClass("taskStartTimeField");
    expect(field.closest("dd")).toBe(within(row("Start at")).getByText(START_AT_HINT).closest("dd"));
    expect(START_AT_HINT).toBe("Starts at this time or later; setting it queues the task.");
    // The field and the hint share one wrapping line, which the 640px modal's value column wraps: the hint sits under the field.
    expect(field.parentElement).toHaveClass("taskRowInline");
    expect(within(row("Start at")).getByText(START_AT_HINT)).toHaveClass("newTaskHelper");
    expect(field).toHaveAccessibleDescription(START_AT_HINT);
  });

  it("draws Start at only for a task that still waits for a session", () => {
    open(task("T-20", { state: "done", session }));
    expect(screen.queryByLabelText("Start at")).not.toBeInTheDocument();
  });

  it("closes Complete when with one short hint about what the agent judges", () => {
    open(task("T-20"));
    const hints = within(row("Complete when")).getAllByText(/^The agent judges/);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toHaveTextContent("The agent judges Validated with the user and your own condition.");
    expect(hints[0]).toHaveClass("newTaskHelper");
  });
});

describe("a task that has started", () => {
  const started = (overrides: Partial<Task> = {}) => task("T-20", { state: "queued", session, after: ["T-13"], ...overrides });

  it("ends its read-only list with Runs after and Sessions, in the same rows", async () => {
    open(started());
    await waitFor(() => expect(rowLabels()).toContain("Sessions"));
    expect(rowLabels()).toEqual(["Feature", "Run on", "Effort", "Remote Control", "When done", "Complete when", "GitHub issue", "Runs after", "Sessions"]);
    expect(document.querySelectorAll(".taskModalBody dl")).toHaveLength(1);
    expect(document.querySelector(".taskModalBody fieldset, .taskModalBody legend")).toBeNull();
  });

  it("draws Runs after as items only, with no Remove, no select, no Add, and no hint", () => {
    open(started());
    const group = within(row("Runs after")).getByRole("group", { name: "Runs after" });
    expect(within(group).getAllByRole("listitem")).toHaveLength(1);
    expect(group).toHaveTextContent("T-13 · Done");
    expect(within(group).queryByRole("button")).not.toBeInTheDocument();
    expect(within(group).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(group).queryByText(AFTER_HELPER)).not.toBeInTheDocument();
  });

  it("draws no Runs after row for a started task that runs after none", () => {
    open(started({ after: undefined }));
    expect(rowLabels()).not.toContain("Runs after");
  });

  it("keeps Assign working on a started task: the started session first, then the add line and its hint", async () => {
    open(started());
    await waitFor(() => expect(within(row("Sessions")).queryByRole("combobox", { name: "Session to assign" })).toBeInTheDocument());
    const group = within(row("Sessions")).getByRole("group", { name: "Sessions" });
    expect(within(group).getAllByRole("listitem")).toHaveLength(1);
    expect(within(group).getByText("Started by Pomegr")).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Assign session" })).toBeDisabled();
    expect(within(group).getByText(ASSIGN_HELPER)).toBeInTheDocument();
  });

  it("draws no Start at row", () => {
    open(started());
    expect(screen.queryByLabelText("Start at")).not.toBeInTheDocument();
  });
});
