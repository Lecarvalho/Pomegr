import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { inspectDesktopTaskSessions } from "../../app/components/tasks/task-desktop";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const taskSessions = vi.fn<(repositoryId: string, taskId: string, operation: string, endWorking?: boolean) => Promise<unknown>>();
const refresh = vi.fn(async () => {});

const columns = [
  { id: "col-1", name: "Backlog", position: 0 }, { id: "col-2", name: "Ready", position: 1 },
  { id: "col-3", name: "In progress", position: 2, role: "in_progress" as const }, { id: "col-4", name: "Review", position: 3, role: "review" as const },
  { id: "col-5", name: "Done", position: 4, role: "done" as const },
];

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { review: null,
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const inReview = task(12, {
  text: "Add a private task store.", columnId: "col-4", position: 0, state: "needs_review",
  session: { id: "claude:abc123", title: "Task store and privacy rules", state: "idle", observedModel: null, observedEffort: null },
  report: { at: "2026-10-08T11:42:00.000Z", results: [], blockReason: null },
});

function setBoard(tasks: Task[], queue: Partial<TaskBoard["queue"]> = {}) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks, queue: { status: "idle", blockedBy: null, pauseReason: null, order: [], ...queue } };
  useTasks.mockReturnValue({ board, refresh });
}
function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}
beforeEach(() => {
  taskAction.mockResolvedValue({ ok: true });
  taskSessions.mockImplementation(async (_repository, _task, operation) => operation === "inspect" ? { status: "ok", live: 0, working: 0 } : { status: "ok", ended: 0, working: 0 });
  setBridge({ taskAction, taskSessions });
  setBoard([inReview, task(13)]);
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const QUESTION = "Its session is still working. End it?";
const working = (count = 1) => taskSessions.mockImplementation(async (_repository, _task, operation) => operation === "inspect" ? { status: "ok", live: count, working: count } : { status: "ok", ended: 0, working: 0 });
const settles = () => taskSessions.mock.calls.filter((call) => call[2] === "settle");

async function openModal() {
  const user = userEvent.setup();
  render(<TaskBoardPane repositoryId={repositoryId} />);
  await user.click(screen.getByRole("button", { name: "Task store and privacy rules" }));
  return { user, dialog: within(screen.getByRole("dialog", { name: "Task" })) };
}

describe("the task modal's Mark done", () => {
  it("asks the desktop first and settles the task's sessions after, and asks the owner nothing when none works", async () => {
    const { user, dialog } = await openModal();
    await user.click(dialog.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-12" }));
    await waitFor(() => expect(settles()).toEqual([[repositoryId, "T-12", "settle", false]]));
    expect(taskSessions.mock.calls[0]).toEqual([repositoryId, "T-12", "inspect"]);
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    // The order is the question, the Done action, then the settle.
    expect(taskSessions.mock.invocationCallOrder[0]).toBeLessThan(taskAction.mock.invocationCallOrder[0]);
    expect(taskAction.mock.invocationCallOrder[0]).toBeLessThan(taskSessions.mock.invocationCallOrder[1]);
  });

  it("asks before the task is marked Done when a session works, and End session ends it", async () => {
    working();
    const { user, dialog } = await openModal();
    await user.click(dialog.getByRole("button", { name: "Mark done" }));
    const question = await screen.findByRole("group", { name: "End the session" });
    expect(within(question).getByText(QUESTION)).toHaveClass("taskModalNote");
    expect(within(question).getByRole("button", { name: "End session" })).toHaveClass("commandSecondaryAction");
    expect(within(question).getByRole("button", { name: "Keep it running" })).toHaveClass("commandQuietAction");
    expect(within(question).getByRole("button", { name: "Keep it running" })).toHaveFocus();
    // Nothing is marked Done, and the footer offers no other action, while the question is open.
    expect(taskAction).not.toHaveBeenCalled();
    expect(dialog.queryByRole("button", { name: "Requeue task" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Delete task" })).not.toBeInTheDocument();
    await user.click(within(question).getByRole("button", { name: "End session" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-12" }));
    await waitFor(() => expect(settles()).toEqual([[repositoryId, "T-12", "settle", true]]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());
  });

  it("marks the task Done and leaves a working session running when the owner keeps it", async () => {
    working();
    const { user, dialog } = await openModal();
    await user.click(dialog.getByRole("button", { name: "Mark done" }));
    await user.click(within(await screen.findByRole("group", { name: "End the session" })).getByRole("button", { name: "Keep it running" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-12" }));
    await waitFor(() => expect(settles()).toEqual([[repositoryId, "T-12", "settle", false]]));
  });

  it("says plurally when two sessions work, and settles nothing when the Done action is refused", async () => {
    working(2);
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const { user, dialog } = await openModal();
    await user.click(dialog.getByRole("button", { name: "Mark done" }));
    const question = await screen.findByRole("group", { name: "End the session" });
    expect(within(question).getByText("Its sessions are still working. End them?")).toBeInTheDocument();
    await user.click(within(question).getByRole("button", { name: "End session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be marked done.");
    expect(settles()).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Task" })).toBeInTheDocument();
  });

  it("does not ask or settle without the desktop's answer, and requeue never asks", async () => {
    taskSessions.mockResolvedValue({ status: "unavailable" });
    const { user, dialog } = await openModal();
    await user.click(dialog.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-12" }));
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    expect(settles()).toEqual([]);
  });

  it("works as before without the sessions bridge", async () => {
    setBridge({ taskAction });
    const { user, dialog } = await openModal();
    await user.click(dialog.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-12" }));
    expect(taskSessions).not.toHaveBeenCalled();
  });

  it("never asks for a requeue", async () => {
    working();
    const { user, dialog } = await openModal();
    await user.click(dialog.getByRole("button", { name: "Requeue task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_requeue", { id: "T-12" }));
    expect(taskSessions).not.toHaveBeenCalled();
  });
});

describe("the desktop's answer", () => {
  it("is given up on after five seconds, so a silent desktop never holds a Done action", async () => {
    vi.useFakeTimers();
    try {
      taskSessions.mockReturnValue(new Promise(() => {}));
      const pending = inspectDesktopTaskSessions(repositoryId, "T-12");
      await vi.advanceTimersByTimeAsync(4_999);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeNull();
      // A prompt answer leaves no timer behind.
      taskSessions.mockResolvedValue({ status: "ok", live: 1, working: 0 });
      await expect(inspectDesktopTaskSessions(repositoryId, "T-12")).resolves.toEqual({ live: 1, working: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is read only as two counts: any other shape is no answer", async () => {
    for (const answer of [{ status: "unavailable" }, { status: "ok", live: "1", working: 0 }, { status: "ok", live: 1 }, null, "ok"]) {
      taskSessions.mockResolvedValue(answer);
      await expect(inspectDesktopTaskSessions(repositoryId, "T-12")).resolves.toBeNull();
    }
  });
});

describe("the board's Done actions", () => {
  it("asks on the board before a card moves into the Done column, and sends the move after the answer", async () => {
    working();
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Move T-12 to the next column" }));
    const question = await screen.findByRole("group", { name: "End the session" });
    expect(question).toHaveClass("taskBoardConfirm");
    // The card stays where it is until the owner answers, so nothing is shown and then taken back.
    expect(taskAction).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "Review" })).getByRole("button", { name: "Task store and privacy rules" })).toBeInTheDocument();
    await user.click(within(question).getByRole("button", { name: "End session" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", expect.objectContaining({ id: "T-12", columnId: "col-5" })));
    await waitFor(() => expect(settles()).toEqual([[repositoryId, "T-12", "settle", true]]));
    expect(screen.queryByRole("group", { name: "End the session" })).not.toBeInTheDocument();
  });

  it("moves at once and settles when no session works, and a move to another column never asks", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Move T-12 to the next column" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", expect.objectContaining({ id: "T-12", columnId: "col-5" })));
    await waitFor(() => expect(settles()).toEqual([[repositoryId, "T-12", "settle", false]]));
    taskSessions.mockClear();
    await user.click(screen.getByRole("button", { name: "Move T-13 to the next column" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", expect.objectContaining({ id: "T-13", columnId: "col-2" })));
    expect(taskSessions).not.toHaveBeenCalled();
  });

  it("asks before the Queue banner's Mark done and resume", async () => {
    working();
    setBoard([inReview, task(13, { columnId: "col-3", state: "stalled", completeWhen: { checks: ["pr_open"], own: null },
      session: { id: "claude:abc125", title: "Stalled work", state: "closed", observedModel: null, observedEffort: null } })], { status: "blocked", blockedBy: "T-13" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(within(screen.getByRole("region", { name: "Queue status" })).getByRole("button", { name: "Mark done and resume" }));
    const question = await screen.findByRole("group", { name: "End the session" });
    expect(taskAction).not.toHaveBeenCalled();
    // The banner's other action waits for the answer, so a requeue cannot overtake the Done action.
    expect(within(screen.getByRole("region", { name: "Queue status" })).getByRole("button", { name: "Requeue T-13" })).toBeDisabled();
    await user.click(within(question).getByRole("button", { name: "Keep it running" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-13" }));
    await waitFor(() => expect(settles()).toEqual([[repositoryId, "T-13", "settle", false]]));
  });

  it("keeps a second Done action waiting until the first question is answered", async () => {
    working();
    setBoard([inReview, { ...inReview, id: "T-14", text: "Second", position: 1, session: { id: "claude:def456", title: "Second work", state: "idle", observedModel: null, observedEffort: null } }]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Move T-12 to the next column" }));
    await screen.findByRole("group", { name: "End the session" });
    await user.click(screen.getByRole("button", { name: "Move T-14 to the next column" }));
    expect(screen.getAllByRole("group", { name: "End the session" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Keep it running" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", expect.objectContaining({ id: "T-12" })));
    await user.click(await screen.findByRole("button", { name: "End session" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", expect.objectContaining({ id: "T-14" })));
    expect(settles()).toEqual([[repositoryId, "T-12", "settle", false], [repositoryId, "T-14", "settle", true]]);
  });
});
