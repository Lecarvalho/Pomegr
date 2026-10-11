import { cleanup, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTaskReference } from "../../shared/session-catalog-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));

import { SessionTaskMeta, SessionTaskSummary } from "../../app/components/dashboard/SessionTaskSummary";
import { sessionTaskModel, stepLabel, summaryCompleteWhen } from "../../app/components/tasks/session-task-model";

const repositoryId = "repo-0123456789abcdef01234567";
const taskHref = "/sessions/claude%3Aabc?tab=task";

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Secret task text ${id}`, columnId: "col-1", position: id, featureId: null,
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
  session: { id: "claude:abc", title: "Wire the tools", state: "working", observedModel: "opus" },
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
  it("reads the step from the order of the feature's cards on a ready board only", () => {
    expect(sessionTaskModel(board(), reference)).toMatchObject({ kind: "full", step: { step: 2, total: 4 } });
    expect(sessionTaskModel(board({ tasks: [task(14, { state: "queued" })] }), reference)).toMatchObject({ kind: "full", step: null });
    expect(sessionTaskModel(board({ readiness: "loading", tasks: [] }), reference)).toMatchObject({ kind: "reduced", step: null });
    expect(stepLabel({ step: 2, total: 4 })).toBe("step 2 of 4");
  });

  it("words Complete when without a Running state", () => {
    expect(summaryCompleteWhen(mine)).toBe("2 checks + own condition + agent report · not yet reported");
    expect(summaryCompleteWhen(task(1, { completeWhen: { checks: ["pr_open", "tree_clean"], own: null } }))).toBe("2 checks + agent report · not yet reported");
    expect(summaryCompleteWhen(task(1))).toBe("agent report · not yet reported");
    expect(summaryCompleteWhen(task(1, { state: "done", completeWhen: { checks: ["pr_open"], own: null } }))).toBe("1 check + agent report · Done");
    const review = task(1, { state: "needs_review", completeWhen: { checks: ["pr_open", "tree_clean"], own: null }, report: { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open", passed: false }, { check: "tree_clean", passed: true }], blockReason: null } });
    expect(summaryCompleteWhen(review)).toBe("2 checks + agent report · Needs review, 1 check did not pass");
    const noted = task(1, { state: "needs_review", completeWhen: { checks: ["pr_open"], own: null }, report: { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open", passed: true }], blockReason: null, attention: "Confirm the retry limit." } });
    expect(summaryCompleteWhen(noted)).toBe("1 check + agent report · Needs review, the agent asks for your attention");
    // A report always needs review: with every check passed and no note, the words say so.
    const passed = task(1, { state: "needs_review", completeWhen: { checks: ["pr_open"], own: null }, report: { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open", passed: true }], blockReason: null, attention: null } });
    expect(summaryCompleteWhen(passed)).toBe("1 check + agent report · Needs review, every check passed");
    expect(summaryCompleteWhen(task(1, { state: "needs_review", report: { at: "2026-10-08T11:00:00.000Z", results: [], blockReason: null, attention: null } }))).toBe("agent report · Needs review");
    expect(summaryCompleteWhen(task(1, { state: "blocked" }))).toBe("agent report · Blocked by agent");
  });

  it("reduces to the reference when the board is not ready or lacks the task", () => {
    for (const readiness of ["loading", "unavailable", "desktop_only"] as const) {
      expect(sessionTaskModel(board({ readiness, tasks: [] }), reference)).toMatchObject({ kind: "reduced", reason: readiness });
    }
    expect(sessionTaskModel(board({ tasks: [task(99)] }), reference)).toMatchObject({ kind: "reduced", reason: "missing" });
  });
});

describe("SessionTaskMeta", () => {
  it("links the ID to the Task tab, names the feature and shows the step of the total", () => {
    render(<SessionTaskMeta task={reference} taskHref={taskHref} />);
    expect(useTasks).toHaveBeenCalledWith(repositoryId);
    expect(screen.getByRole("link", { name: "T-14" })).toHaveAttribute("href", taskHref);
    expect(screen.getByRole("link", { name: "Task board v1" })).toHaveAttribute("href", `/tasks?repository=${repositoryId}`);
    expect(screen.getByText("step 2 of 4")).toBeInTheDocument();
  });

  it("draws the ID as plain text on the Task tab itself", () => {
    render(<SessionTaskMeta task={reference} taskHref={null} />);
    expect(screen.queryByRole("link", { name: "T-14" })).not.toBeInTheDocument();
    expect(screen.getByText("T-14")).toBeInTheDocument();
  });

  it("shows no step while the board is not ready, and nothing about a feature a task lacks", () => {
    setBoard(board({ readiness: "loading", tasks: [] }));
    const { unmount } = render(<SessionTaskMeta task={reference} taskHref={taskHref} />);
    expect(screen.getByRole("link", { name: "Task board v1" })).toBeInTheDocument();
    expect(document.querySelector(".sessionTaskMetaStep")).toBeNull();
    unmount();
    render(<SessionTaskMeta task={{ ...reference, featureId: null, feature: null }} taskHref={taskHref} />);
    expect(screen.queryByText("Feature")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "T-14" })).toBeInTheDocument();
  });
});

describe("SessionTaskSummary", () => {
  it("draws the heading link to the Task tab with the Feature, Complete when, Model and Next cells", () => {
    render(<SessionTaskSummary task={reference} taskHref={taskHref} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    const heading = within(panel).getByRole("link", { name: "Task T-14" });
    expect(heading).toHaveAttribute("href", taskHref);
    expect(heading.querySelector("svg")).not.toBeNull();
    expect(panel).toHaveTextContent("Task board v1 · step 2 of 4");
    expect(panel).toHaveTextContent("2 checks + own condition + agent report · not yet reported");
    expect(panel).toHaveTextContent("Planned opus · observed opus");
    expect(panel).toHaveTextContent("NextT-15");
    expect(panel).not.toHaveTextContent("Secret task text");
    expect(panel.textContent).not.toMatch(/Running/);
    expect(panel.textContent).not.toContain("—");
  });

  it("adds a Source cell with the #N chip and GitHub issue for a task promoted from an issue", () => {
    setBoard(board({ tasks: [{ ...mine, source: { kind: "github_issue", number: 142 } }] }));
    render(<SessionTaskSummary task={reference} taskHref={taskHref} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    const cell = [...panel.querySelectorAll(".sessionTaskCell")].find((entry) => entry.querySelector(".sessionTaskEyebrow")?.textContent === "Source") as HTMLElement;
    expect(cell).toBeDefined();
    expect(cell).toHaveTextContent("Source#142GitHub issue");
    expect(within(cell).getByRole("img", { name: "GitHub issue #142" })).toHaveClass("commandChip", "taskIssueChip");
    expect(cell.querySelector("a, button")).toBeNull();
    expect(panel.querySelectorAll(".taskIssueChip")).toHaveLength(1);
  });

  it("has no Source cell without a source, and none in the reduced form", () => {
    render(<SessionTaskSummary task={reference} taskHref={taskHref} />);
    expect(screen.getByRole("region", { name: "Task T-14" })).not.toHaveTextContent("Source");
    cleanup();
    setBoard(board({ readiness: "loading", tasks: [] }));
    render(<SessionTaskSummary task={reference} taskHref={taskHref} />);
    expect(document.querySelector(".taskIssueChip")).toBeNull();
  });

  it("says default and not recorded rather than inventing a model", () => {
    setBoard(board({ tasks: [{ ...mine, run: { provider: "codex", model: null, effort: null }, session: { ...mine.session!, observedModel: null } }] }));
    render(<SessionTaskSummary task={reference} taskHref={taskHref} />);
    expect(screen.getByRole("region", { name: "Task T-14" })).toHaveTextContent("Planned default model · observed not recorded");
  });

  it("names the blocked queue in the Next cell instead of the next task", () => {
    setBoard(board({ queue: { status: "blocked", blockedBy: "T-12", pauseReason: null, order: [] } }));
    render(<SessionTaskSummary task={reference} taskHref={taskHref} />);
    const blocked = screen.getByText("Queue blocked by T-12");
    expect(blocked).toHaveClass("sessionTaskBlocked");
    expect(screen.queryByText("T-15")).not.toBeInTheDocument();
  });

  it("shows a dash when no step follows", () => {
    setBoard(board({ tasks: [mine] }));
    render(<SessionTaskSummary task={reference} taskHref={taskHref} />);
    expect(within(screen.getByRole("region", { name: "Task T-14" })).getByText("—")).toBeInTheDocument();
  });

  it("shows the outcome once the task has one", () => {
    setBoard(board({ tasks: [{ ...mine, state: "done", completeWhen: { checks: ["pr_open"], own: null } }] }));
    render(<SessionTaskSummary task={{ ...reference, state: "done" }} taskHref={taskHref} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(panel).toHaveTextContent("1 check + agent report · Done");
    expect(panel.querySelector(".commandChip")).toHaveTextContent("Done");
  });

  it.each([
    ["desktop_only", "Task details are shown in the Pomegr desktop app or a browser on the same computer."],
    ["unavailable", "Pomegr could not read the task board."],
  ] as const)("reduces to the reference with one sentence when the board is %s", (readiness, sentence) => {
    setBoard({ ...board({ readiness, tasks: [] }) });
    render(<SessionTaskSummary task={{ ...reference, state: "stalled" }} taskHref={taskHref} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(panel).toHaveTextContent(sentence);
    expect(panel).toHaveTextContent("Stalled");
    expect(panel).toHaveTextContent("Task board v1");
    expect(panel).not.toHaveTextContent("step");
    expect(panel).not.toHaveTextContent("Complete when");
    expect(panel).not.toHaveTextContent("Secret task text");
  });

  it("adds no sentence while the board loads", () => {
    setBoard(board({ readiness: "loading", tasks: [] }));
    render(<SessionTaskSummary task={reference} taskHref={taskHref} />);
    expect(screen.getByRole("region", { name: "Task T-14" }).querySelector(".sessionTaskNote")).toBeNull();
  });

  it("reduces, with a sentence, when the ready board does not hold the task", () => {
    setBoard(board({ tasks: [task(99)] }));
    render(<SessionTaskSummary task={reference} taskHref={taskHref} />);
    expect(screen.getByRole("region", { name: "Task T-14" })).toHaveTextContent("This task is not on the board.");
  });
});
