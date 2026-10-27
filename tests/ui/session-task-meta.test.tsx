import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTaskReference } from "../../shared/session-catalog-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));

import { SessionTaskMeta } from "../../app/components/dashboard/SessionTaskMeta";
import { sessionTaskModel } from "../../app/components/tasks/session-task-model";

const repositoryId = "repo-0123456789abcdef01234567";
const taskHref = "/sessions/claude%3Aabc?tab=task";

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { review: null,
    id: `T-${id}`, text: `Secret task text ${id}`, columnId: "col-1", position: id, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const reference: SessionTaskReference = { id: "T-14", repositoryId, state: null, featureId: "feat-1", feature: "Task board v1" };

const mine = task(14, {
  featureId: "feat-1", state: "queued",
  run: { provider: "claude", model: "opus", effort: "high" },
  completeWhen: { checks: ["pr_open", "tree_clean"], own: "Tests pass." },
  session: { id: "claude:abc", title: "Wire the tools", state: "working", observedModel: "opus", observedEffort: null },
});

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return {
    version: 1, readiness: "ready", repositoryId, columns: [{ id: "col-1", name: "Backlog", position: 0 }],
    features: [{ id: "feat-1", name: "Task board v1", done: false }],
    tasks: [task(12, { featureId: "feat-1", state: "done" }), mine, task(15, { featureId: "feat-1", state: "queued" }), task(16, { featureId: "feat-1" })],
    queue: { status: "running", blockedBy: null, pauseReason: null, order: [] }, ...overrides,
  };
}

function setBoard(next: TaskBoard) {
  useTasks.mockReturnValue({ board: next, refresh: vi.fn() });
}

beforeEach(() => {
  vi.clearAllMocks();
  setBoard(board());
});

describe("session task model", () => {
  it("reduces to the reference when the board is not ready or lacks the task", () => {
    for (const readiness of ["loading", "unavailable", "desktop_only"] as const) {
      expect(sessionTaskModel(board({ readiness, tasks: [] }), reference)).toMatchObject({ kind: "reduced", reason: readiness });
    }
    expect(sessionTaskModel(board({ tasks: [task(99)] }), reference)).toMatchObject({ kind: "reduced", reason: "missing" });
  });
});

describe("SessionTaskMeta", () => {
  it("links the ID to the Task tab, names the feature and nothing after it", () => {
    render(<SessionTaskMeta task={reference} taskHref={taskHref} />);
    expect(screen.getByRole("link", { name: "T-14" })).toHaveAttribute("href", taskHref);
    expect(screen.getByRole("link", { name: "Task board v1" })).toHaveAttribute("href", `/tasks?repository=${repositoryId}`);
    expect(screen.getByText("Task board v1").parentElement).toHaveTextContent(/^·FeatureTask board v1$/);
  });

  it("names a reviewer session's task as its Review", () => {
    render(<SessionTaskMeta task={{ ...reference, role: "review" }} taskHref={taskHref} />);
    expect(screen.getByRole("link", { name: "T-14" }).parentElement).toHaveTextContent(/^ReviewT-14$/);
    expect(screen.queryByText("Task")).not.toBeInTheDocument();
  });

  it("draws the ID as plain text on the Task tab itself", () => {
    render(<SessionTaskMeta task={reference} taskHref={null} />);
    expect(screen.queryByRole("link", { name: "T-14" })).not.toBeInTheDocument();
    expect(screen.getByText("T-14")).toBeInTheDocument();
  });

  it("names no step, and shows nothing about a feature a task lacks", () => {
    setBoard(board({ readiness: "loading", tasks: [] }));
    const { unmount } = render(<SessionTaskMeta task={reference} taskHref={taskHref} />);
    expect(screen.getByText("Task board v1")).toBeInTheDocument();
    unmount();
    render(<SessionTaskMeta task={{ ...reference, featureId: null, feature: null }} taskHref={taskHref} />);
    expect(screen.queryByText("Feature")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "T-14" })).toBeInTheDocument();
  });
});
