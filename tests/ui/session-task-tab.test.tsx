import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTaskReference } from "../../shared/session-catalog-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));

import { SessionTaskTab } from "../../app/components/dashboard/SessionTaskTab";
import { checkRows, queueBlockedNote } from "../../app/components/tasks/session-task-model";

const repositoryId = "repo-0123456789abcdef01234567";
const boardHref = `/tasks?repository=${repositoryId}`;
const sessionId = "claude:this-session";

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const reference: SessionTaskReference = { id: "T-14", repositoryId, state: null, featureId: "feat-1", feature: "Task board v1", step: 2 };

const mine = task(14, {
  text: "Add the complete_task and block_task tools.\nBind each call to the session.",
  featureId: "feat-1", step: 2, state: "queued",
  run: { provider: "claude", model: "opus", effort: "high" },
  doneWhen: { checks: ["pr_open", "tree_clean"], own: "Both tools validate their input." },
  session: { id: sessionId, title: "Wire the tools", state: "working", observedModel: "opus" },
});

const siblings = [
  task(12, { featureId: "feat-1", step: 1, state: "done", text: "Store and privacy rules" }),
  task(13, { featureId: "feat-1", step: 2, state: "needs_review", text: "Queue gate", session: { id: "claude:other", title: "Queue auto-advance", state: "idle", observedModel: null } }),
  task(15, { featureId: "feat-1", step: 3, state: "queued", text: "Run plan" }),
  task(16, { featureId: "feat-1", step: 4, text: "Fourth step" }),
  task(17, { featureId: "feat-1", step: 3, state: "done", text: "Parallel next" }),
];

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return {
    version: 1, readiness: "ready", repositoryId, columns: [{ id: "col-1", name: "Backlog", position: 0 }],
    features: [{ id: "feat-1", name: "Task board v1", done: false }],
    tasks: [mine, ...siblings], queue: { status: "running", blockedBy: null, pauseReason: null, order: [] }, ...overrides,
  };
}

function setBoard(next: TaskBoard) {
  useTasks.mockReturnValue({ board: next, refresh: vi.fn() });
}

beforeEach(() => {
  vi.clearAllMocks();
  setBoard(board());
});

describe("SessionTaskTab", () => {
  it("draws the task panel: heading, start line, board link, text, planned and observed", () => {
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(within(panel).getByRole("heading", { name: "Task T-14" })).toBeInTheDocument();
    expect(panel).toHaveTextContent("Started by Pomegr");
    expect(within(panel).getByRole("link", { name: "Open on board" })).toHaveAttribute("href", boardHref);
    expect(within(panel).getByRole("link", { name: "Open on board" })).toHaveClass("commandSecondaryAction");
    expect(panel).toHaveTextContent("Add the complete_task and block_task tools.");
    expect(panel).toHaveTextContent("PlannedClaude Code · opus · high");
    expect(panel).toHaveTextContent("Observedopus as the latest recorded for the main agent");
  });

  it("is read only: no button, form field or IPC call", () => {
    const taskAction = vi.fn();
    const bridge = window as unknown as { pomegrDesktop?: unknown };
    bridge.pomegrDesktop = { taskAction };
    const { container } = render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(container.querySelector("button, input, textarea, select, form")).toBeNull();
    expect(taskAction).not.toHaveBeenCalled();
    bridge.pomegrDesktop = undefined;
  });

  it("shows the agent-judged condition as agent-reported, not yet reported, and every check waiting", () => {
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(panel).toHaveTextContent("Definition of done");
    expect(panel).toHaveTextContent("Both tools validate their input.");
    expect(panel).toHaveTextContent("Agent-reported. Not yet reported.");
    const rows = within(panel).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Pull request openWaiting for report", "Working tree cleanWaiting for report"]);
  });

  it("omits the Definition of done when there is no own condition, and the checks when none are set", () => {
    setBoard(board({ tasks: [{ ...mine, doneWhen: { checks: [], own: null } }, ...siblings] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(panel).not.toHaveTextContent("Definition of done");
    expect(panel).not.toHaveTextContent("Checks when the agent reports complete");
  });

  it("shows each check result, the failed count outcome and a block reason as plain text", () => {
    const reported = { ...mine, state: "needs_review" as const, report: { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: false }], blockReason: "Cannot reach the remote." } };
    setBoard(board({ tasks: [reported, ...siblings] }));
    render(<SessionTaskTab task={{ ...reference, state: "needs_review" }} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(within(panel).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Pull request openPassed", "Working tree cleanDid not pass"]);
    expect(panel).toHaveTextContent("Agent-reported. The agent reported it cannot continue.");
    expect(panel).toHaveTextContent("Cannot reach the remote.");
  });

  it("shows the monitor's reading of each check while the task waits for its report", () => {
    const session = { id: sessionId, title: null, state: "working", observedModel: null, checks: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: false }] };
    setBoard(board({ tasks: [{ ...mine, session }, ...siblings] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(within(panel).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Pull request openHolds now", "Working tree cleanNot yet"]);
  });

  it("keeps a reading out of a task that has an outcome or a report", () => {
    const session = { id: sessionId, title: null, state: "closed", observedModel: null, checks: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: true }] };
    expect(checkRows({ ...mine, session, state: "stalled" }).map((row) => row.result)).toEqual(["No report", "No report"]);
    const report = { at: "2026-10-09T10:00:00.000Z", results: [{ check: "pr_open" as const, passed: false }], blockReason: null };
    expect(checkRows({ ...mine, session, state: "needs_review", report }).map((row) => row.result)).toEqual(["Did not pass", "Not checked"]);
  });

  it("does not wait forever for a report that will not come", () => {
    expect(checkRows({ ...mine, state: "stalled" }).map((row) => row.result)).toEqual(["No report", "No report"]);
  });

  it("lists the feature with its progress, the same-step tasks and the next-step tasks", () => {
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const side = screen.getByRole("complementary", { name: "Feature" });
    expect(within(side).getByRole("link", { name: "Task board v1" })).toHaveAttribute("href", boardHref);
    expect(side).toHaveTextContent("2 of 6 done");
    expect(side).toHaveTextContent("Same step as this session");
    const sameStep = within(side).getAllByRole("list")[0];
    expect(within(sameStep).getAllByRole("listitem").map((row) => row.getAttribute("data-task-id"))).toEqual(["T-13"]);
    expect(within(sameStep).getByRole("link", { name: "Queue auto-advance" })).toHaveAttribute("href", "/sessions/claude-other");
    expect(within(sameStep).getByText("Needs review")).toHaveClass("commandChip");
    const next = within(side).getAllByRole("list")[1];
    expect(within(next).getAllByRole("listitem").map((row) => row.getAttribute("data-task-id"))).toEqual(["T-15", "T-17"]);
    expect(within(next).getByRole("link", { name: "Run plan" })).toHaveAttribute("href", boardHref);
    expect(within(next).getByText("Done")).toHaveClass("commandChip");
    expect(side.querySelector(".sessionTaskBlockedNote")).toBeNull();
  });

  it("explains a blocked queue under the Next rows", () => {
    setBoard(board({ queue: { status: "blocked", blockedBy: "T-12", pauseReason: null, order: [] } }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(screen.getByRole("complementary", { name: "Feature" })).toHaveTextContent("Queue blocked by T-12. T-15, T-17 will not start when this session completes.");
  });

  it("words the blocked note for the cases where this task is the blocker or already done", () => {
    const base = { task: mine, nextStep: [siblings[2]], queue: { blocked: true, by: "T-14" } };
    expect(queueBlockedNote(base)).toBe("This task blocks the queue. T-15 will not start until it is resolved.");
    expect(queueBlockedNote({ ...base, task: { ...mine, state: "done" }, queue: { blocked: true, by: "T-12" } })).toBe("Queue blocked by T-12. T-15 will not start until it is resolved.");
    expect(queueBlockedNote({ ...base, nextStep: [], queue: { blocked: true, by: "T-12" } })).toBe("Queue blocked by T-12.");
  });

  it("draws no feature panel for a task without a feature", () => {
    setBoard(board({ tasks: [{ ...mine, featureId: null, step: null }] }));
    render(<SessionTaskTab task={{ ...reference, featureId: null, feature: null, step: null }} sessionId={sessionId} />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("shows the Not set planned run, and no observed model before one is recorded", () => {
    setBoard(board({ tasks: [{ ...mine, run: { provider: null, model: null, effort: null }, session: { ...mine.session!, observedModel: null } }] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(panel).toHaveTextContent("PlannedNot set");
    expect(panel).toHaveTextContent("ObservedNot recorded yet");
  });

  it("flags an observed model that differs from the planned one", () => {
    setBoard(board({ tasks: [{ ...mine, session: { ...mine.session!, observedModel: "sonnet" } }] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(screen.getByRole("region", { name: "Task T-14" })).toHaveTextContent("sonnet as the latest recorded for the main agent, differs from planned");
  });

  it.each([
    ["desktop_only", "Task details are shown in the Pomegr desktop app or a browser on the same computer."],
    ["unavailable", "Pomegr could not read the task board."],
  ] as const)("reduces to the reference when the board is %s, with no task text", (readiness, sentence) => {
    setBoard(board({ readiness, tasks: [] }));
    render(<SessionTaskTab task={{ ...reference, state: "done" }} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(panel).toHaveTextContent(sentence);
    expect(panel).toHaveTextContent("Done");
    expect(panel).toHaveTextContent("Task board v1 · step 2");
    expect(panel).not.toHaveTextContent("Planned");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Open on board" })).toHaveAttribute("href", boardHref);
  });

  it("draws only the reference and no sentence while the board loads", () => {
    setBoard(board({ readiness: "loading", tasks: [] }));
    const { container } = render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(container.querySelector(".sessionTaskNote")).toBeNull();
    expect(container).toHaveTextContent("Task board v1 · step 2");
    expect(container).not.toHaveTextContent("Add the complete_task");
  });
});
