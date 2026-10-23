import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";

vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [{ source: "Claude Code", model: "model-a" }] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));

import { TaskModal } from "../../app/components/tasks/TaskModal";

// The calm task modal (owner-approved design, 2026-10-20): mode edit for a task that has not started, one that needs review, and one that
// runs; the subtitle; the Run settings rows; the read view of a started task; and the footer order of each state.

const repositoryId = "repo-0123456789abcdef01234567";
const IMAGE = "img-0123456789ab";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const features = [{ id: "feature-a", name: "Upload reliability", done: false }];
const taskAction = vi.fn(async () => ({ ok: true }));
const taskImage = vi.fn();
const refresh = vi.fn(async () => {});
const onClose = vi.fn();

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-20", text: "Retry failed uploads.", columnId: "col-1", position: 1, featureId: null, group: null,
    run: { provider: "claude", model: "model-a", effort: "high" }, completeWhen: { checks: ["pr_open", "tree_clean"], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const session = { id: "claude:abc123", title: "Retry the uploads", state: "idle", observedModel: "model-a", observedEffort: null };
const report = { at: "2026-10-08T11:42:00.000Z", results: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: false }], blockReason: null };

function boardOf(...tasks: Task[]): Pick<TaskBoard, "columns" | "features" | "tasks"> & { queue: TaskBoard["queue"] } {
  return { columns, features, tasks, queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } };
}

const open = (value: Task, name: string | null = "pomegr") => render(<TaskModal mode="edit" repositoryId={repositoryId} repositoryName={name} task={value} board={boardOf(value)}
  refresh={refresh} onChanged={vi.fn()} onDeleted={vi.fn()} onClose={onClose} />);
const dialog = () => within(screen.getByRole("dialog", { name: "Task" }));
const rowLabels = () => [...document.querySelectorAll(".taskRows > .taskRow > dt")].map((label) => label.textContent);
// A label of a control is a real label inside its dt, so the row is found by the dt's whole text.
const row = (label: string) => [...document.querySelectorAll("dt")].find((term) => term.textContent === label)?.closest(".taskRow") as HTMLElement;
const footerButtons = () => [...document.querySelectorAll(".taskModalFooter button")].map((button) => button.textContent);
const before = (left: Node, right: Node) => Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:pomegr/1"), revokeObjectURL: vi.fn() }));
  taskImage.mockImplementation(async (_repository: string, operation: string) => (operation === "read" ? { ok: true, type: "png", bytes: PNG } : { ok: true }));
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { taskAction, taskImage };
});
afterEach(() => {
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  vi.clearAllMocks();
});

describe("the header of the task modal", () => {
  it("reads the repository name alone in mode edit, and keeps repository · in Backlog in mode new", () => {
    const { unmount } = open(task());
    expect(document.querySelector(".taskModalSubtitle")).toHaveTextContent(/^pomegr$/);
    expect(screen.queryByText(/in Backlog/)).not.toBeInTheDocument();
    unmount();
    render(<TaskModal mode="new" repositoryId={repositoryId} repositoryName="pomegr" board={boardOf()} refresh={refresh} onCreated={vi.fn()} onClose={onClose} />);
    expect(document.querySelector(".taskModalSubtitle")).toHaveTextContent(/^pomegr · in Backlog$/);
  });
});

describe("a task that has not started", () => {
  it("draws the Run settings as rows with controls in place, in order, and Runs after and Start at as its last rows", () => {
    open(task({ featureId: "feature-a" }));
    expect(screen.getByRole("heading", { level: 3, name: "Run settings" })).toBeInTheDocument();
    expect(rowLabels()).toEqual(["Feature", "Run on", "Effort", "Remote Control", "When done", "Complete when", "GitHub issue", "Runs after", "Start at"]);
    expect(row("Feature").querySelector(".commandSelect")).toHaveClass("taskValueSelect");
    expect(row("Run on").querySelector(".commandSelect")).toHaveClass("taskValueSelect");
    expect(within(row("Feature")).getByRole("combobox", { name: "Feature" })).toHaveTextContent("Upload reliability");
    expect(within(row("Run on")).getByRole("combobox", { name: "Run on" })).toHaveTextContent("Claude Code · model-a");
    expect(within(row("Effort")).getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
    // The checkbox row of Remote Control and When done, each with its muted hint.
    const remote = within(row("Remote Control")).getByRole("checkbox", { name: "Remote Control" });
    expect(remote).not.toBeChecked();
    expect(remote).toHaveAccessibleDescription("Open the session on your phone too");
    const remove = within(row("When done")).getByRole("checkbox", { name: "Remove worktree and branch" });
    expect(remove).toBeChecked();
    expect(remove).toHaveAccessibleDescription("Unpushed work is kept");
    // Complete when holds the six checks, the own condition, and the helper in one group named by its label.
    const group = within(row("Complete when")).getByRole("group", { name: "Complete when" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(6);
    expect(within(group).getByRole("textbox", { name: "Own condition" })).toBeInTheDocument();
    expect(within(group).getByText("The agent judges Validated with the user and your own condition.")).toHaveClass("newTaskHelper");
    expect(within(row("GitHub issue")).getByText("None")).toBeInTheDocument();
    // The Source block and the text field's helper paragraph about images are gone.
    expect(document.querySelector(".taskIssueSource, .taskSourceLabel")).toBeNull();
    expect(screen.queryByText(/Paste or drop an image/)).not.toBeInTheDocument();
  });

  it("hides Remote Control for Codex and shows it again, unchecked, for Claude Code", async () => {
    const user = userEvent.setup();
    open(task());
    await user.click(within(row("Remote Control")).getByRole("checkbox"));
    expect(within(row("Remote Control")).getByRole("checkbox")).toBeChecked();
    chooseCommandOption(within(row("Run on")).getByRole("combobox", { name: "Run on" }), "codex:default");
    expect(rowLabels()).toEqual(["Feature", "Run on", "Effort", "When done", "Complete when", "GitHub issue", "Runs after", "Start at"]);
    expect(document.querySelector(".taskRemoteControl")).toBeNull();
    chooseCommandOption(within(row("Run on")).getByRole("combobox", { name: "Run on" }), "claude:default");
    expect(within(row("Remote Control")).getByRole("checkbox")).not.toBeChecked();
  });

  it("holds the draft in the rows: Save is the one primary, and Add to queue and Start session wait for it", async () => {
    const user = userEvent.setup();
    open(task());
    expect(footerButtons()).toEqual(["Delete task", "Add to queue", "Start session", "Save"]);
    expect(document.querySelectorAll(".taskModalFooter .commandPrimaryAction")).toHaveLength(1);
    expect(dialog().getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(within(row("Effort")).getByRole("button", { name: "Low" }));
    expect(dialog().getByRole("button", { name: "Save" })).toBeEnabled();
    expect(dialog().getByRole("button", { name: "Add to queue" })).toBeDisabled();
    expect(dialog().getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog().getByRole("status")).toHaveTextContent("Save your changes first.");
    // The notes share the footer row with the actions, after Delete task.
    const notes = document.querySelector(".taskModalNotes") as HTMLElement;
    expect(notes.closest(".taskModalFooter")).toBe(dialog().getByRole("button", { name: "Delete task" }).closest(".taskModalFooter"));
    expect(before(dialog().getByRole("button", { name: "Delete task" }), notes)).toBe(true);
    expect(before(notes, dialog().getByRole("button", { name: "Add to queue" }))).toBe(true);
  });

  it("draws the observed-model notice in the Run on value", () => {
    open(task({ state: "queued", run: { provider: "claude", model: "model-a", effort: "high" }, session: { ...session, observedModel: "model-z", observedEffort: null } }));
    expect(within(row("Run on")).getByText("Observed model differs")).toBeInTheDocument();
    expect(within(row("Run on")).getByText("model-z", { selector: "code" })).toBeInTheDocument();
  });
});

describe("a task that needs review", () => {
  const reviewed = (overrides: Partial<Task> = {}) => task({
    state: "needs_review", session, report, completeWhen: { checks: ["pr_open", "tree_clean", "user_validated"], own: "Tests pass." },
    text: "[ backend ] [bug] Retry failed uploads\nThe job retried `upload_file` at 2026-10-20 20:59 UTC.\n\n1. Cap the back-off.\n2. Cover it with a test.\n- A follow-up.", ...overrides,
  });

  it("opens with the Review panel, then the read view, then the Run settings as values", () => {
    open(reviewed());
    const panel = document.querySelector(".taskReview") as HTMLElement;
    const read = document.querySelector(".taskRead") as HTMLElement;
    const settings = document.querySelector(".taskRunSettings") as HTMLElement;
    expect(before(panel, read)).toBe(true);
    expect(before(read, settings)).toBe(true);
    expect(within(panel).getByRole("heading", { level: 3, name: "Ready for your review" })).toBeInTheDocument();
    expect(within(panel).getByText(/Agent reported complete/)).toBeInTheDocument();
    const results = within(within(panel).getByRole("list", { name: "Complete when" }));
    expect(results.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["PR openPassed", "Tree cleanNot passed", "Validated with the userAgent-reported", "Tests pass.Agent-reported"]);
    expect(results.getByText("Passed")).toHaveClass("taskCheckResult", "isPassed");
    expect(results.getByText("Not passed")).toHaveClass("taskCheckResult", "isFailed");
    // The glyphs are decorative; the words carry the results.
    for (const glyph of panel.querySelectorAll(".taskReviewCheck > svg")) expect(glyph).toHaveAttribute("aria-hidden", "true");
    // The session title closes the panel.
    expect(panel.querySelector(".taskModalSession")).toHaveTextContent("Retry the uploadsTitle from the session · Open session");
    // The settings are values, and the conditions are not listed twice.
    expect(rowLabels()).toEqual(["Feature", "Run on", "Effort", "Remote Control", "When done", "GitHub issue", "Sessions"]);
    expect(within(row("Run on")).getByText("Claude Code · model-a")).toBeInTheDocument();
    expect(within(row("GitHub issue")).getByText("None")).toBeInTheDocument();
  });

  it("draws the text as a read-only document: tags, a 16px title, paragraphs, lists, code, and dates, as React text", () => {
    open(reviewed());
    const read = within(document.querySelector(".taskRead") as HTMLElement);
    expect(document.querySelector(".taskRead")).toHaveAttribute("aria-labelledby");
    expect(read.getByRole("group", { name: "Tags" }).querySelectorAll(".commandChip.taskTag")).toHaveLength(2);
    expect(read.getByRole("heading", { level: 3 })).toHaveTextContent(/^Retry failed uploads$/);
    expect(read.getByText("upload_file")).toHaveClass("taskDocCode");
    expect(read.getByText("2026-10-20 20:59 UTC")).toHaveClass("taskDocData");
    const lists = document.querySelectorAll(".taskDocument ol, .taskDocument ul");
    expect([...lists].map((list) => list.tagName)).toEqual(["OL", "UL"]);
    expect([...document.querySelectorAll(".taskDocument ol > li")].map((item) => item.textContent)).toEqual(["Cap the back-off.", "Cover it with a test."]);
    expect(document.querySelectorAll(".taskDocument p")).toHaveLength(1);
    // The lock line sits beside a decorative glyph, and nothing is editable.
    expect(read.getByText("Started, so read-only. Requeue to edit.")).toHaveClass("taskReadNote");
    expect(read.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach image" })).not.toBeInTheDocument();
    expect(screen.queryByText(/\/ 4,000/)).not.toBeInTheDocument();
  });

  it("never draws the text as markup, a link, or an image", () => {
    const written = "<b>bold</b> [a link](javascript:alert(1)) <img src=x onerror=alert(1)>";
    open(reviewed({ text: `Title\n${written}` }));
    const read = document.querySelector(".taskRead") as HTMLElement;
    expect(read.querySelector("b, a, script, img")).toBeNull();
    expect(read).toHaveTextContent(written);
  });

  it("draws an inline image where the text names it, once its bytes are read", async () => {
    open(reviewed({ text: `Match this\nSee [image:${IMAGE}] here`, images: [{ id: IMAGE, type: "png", bytes: PNG.length }] }));
    const picture = document.querySelector(".taskRead .taskInlineImage") as HTMLImageElement;
    expect(picture).toHaveAttribute("alt", "Image 1");
    expect(picture.parentElement).toHaveTextContent("See here");
    await waitFor(() => expect(picture).toHaveAttribute("src", "blob:pomegr/1"));
    expect(picture).not.toHaveClass("isPending");
  });

  it("draws the footer as one row: Delete task, Requeue task, and Mark done as the one primary", () => {
    open(reviewed());
    expect(footerButtons()).toEqual(["Delete task", "Requeue task", "Mark done"]);
    expect([...document.querySelectorAll(".taskModalFooter .commandPrimaryAction")].map((button) => button.textContent)).toEqual(["Mark done"]);
    expect(document.querySelector(".taskModalFooter")?.children).toHaveLength(4);
  });

  it("names the resolution Mark done and resume queue while the queue still names the block", () => {
    const blocked = task({ state: "blocked", session, report: { at: report.at, results: [], blockReason: "The schema needs a decision." } });
    render(<TaskModal mode="edit" repositoryId={repositoryId} repositoryName="pomegr" task={blocked} refresh={refresh} onChanged={vi.fn()} onDeleted={vi.fn()} onClose={onClose}
      board={{ ...boardOf(blocked), queue: { status: "blocked", blockedBy: "T-20", order: [] } }} />);
    expect(footerButtons()).toEqual(["Delete task", "Requeue task", "Mark done and resume queue"]);
    expect(screen.getByRole("heading", { level: 3, name: "Blocked by agent" })).toBeInTheDocument();
  });
});

describe("a started task with no report", () => {
  const running = () => task({ state: "queued", session, completeWhen: { checks: ["pr_open"], own: null }, run: { provider: "codex", model: null, effort: null } });

  it("leads with the session line, not a panel, and reads its conditions in one row", () => {
    open(running());
    expect(document.querySelector(".taskReview")).toBeNull();
    const line = document.querySelector(".taskModalSession") as HTMLElement;
    expect(before(line, document.querySelector(".taskRead") as HTMLElement)).toBe(true);
    // Codex has no Remote Control row, and the unset effort reads muted.
    expect(rowLabels()).toEqual(["Feature", "Run on", "Effort", "When done", "Complete when", "GitHub issue", "Sessions"]);
    expect(within(row("Effort")).getByText("Not set")).toHaveClass("taskRowNone");
    expect(within(row("Feature")).getByText("No feature")).toHaveClass("taskRowNone");
    expect(within(row("Complete when")).getByText("PR open")).toBeInTheDocument();
  });

  it("draws one footer row with the notes between Delete and the exits, both exits Secondary, and no primary", () => {
    open(running());
    expect(footerButtons()).toEqual(["Delete task", "Requeue task", "Mark done"]);
    expect(document.querySelectorAll(".taskModalFooter .commandPrimaryAction")).toHaveLength(0);
    const notes = within(document.querySelector(".taskModalNotes") as HTMLElement);
    expect(notes.getByText("A session is already linked to this task.")).toBeInTheDocument();
    expect(notes.getByText("The session has not reported. Mark done and Requeue do not stop it.")).toBeInTheDocument();
  });

  it("keeps Add to queue for a Not queued task whose session started by hand", () => {
    open(task({ state: "not_queued", session }));
    expect(footerButtons()).toEqual(["Delete task", "Add to queue", "Requeue task", "Mark done"]);
    expect(dialog().getByRole("button", { name: "Add to queue" })).toBeEnabled();
  });

  it("turns into the form once Requeue clears the session", async () => {
    const user = userEvent.setup();
    const view = open(running());
    await user.click(dialog().getByRole("button", { name: "Requeue task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_requeue", { id: "T-20" }));
    const next = task({ state: "queued" });
    view.rerender(<TaskModal mode="edit" repositoryId={repositoryId} repositoryName="pomegr" task={next} board={boardOf(next)} refresh={refresh}
      onChanged={vi.fn()} onDeleted={vi.fn()} onClose={onClose} />);
    expect(dialog().getByRole("textbox", { name: "Task" })).toBeInTheDocument();
    expect(dialog().getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(document.querySelector(".taskRead")).toBeNull();
  });
});

describe("a task that starts while its modal holds unsaved edits", () => {
  const running = () => task({ state: "queued", session });
  const render2 = (value: Task) => <TaskModal mode="edit" repositoryId={repositoryId} repositoryName="pomegr" task={value} board={boardOf(value)} refresh={refresh}
    onChanged={vi.fn()} onDeleted={vi.fn()} onClose={onClose} />;

  it("drops the edits at once, says so in the footer, and leaves the modal clean: scrim close and Create issue… work", async () => {
    const taskIssues = vi.fn(async () => ({ ok: true, connection: "connected", repository: { visibility: "private", capabilities: ["create_issues"] } }));
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { taskAction, taskImage, taskIssues };
    const user = userEvent.setup();
    const view = open(task());
    await user.click(within(row("Effort")).getByRole("button", { name: "Low" }));
    expect(dialog().getByRole("button", { name: "Create issue…" })).toBeDisabled();
    expect(dialog().getByRole("status")).toHaveTextContent("Save your changes first.");
    view.rerender(render2(running()));
    // The read view draws the stored values, and the draft is gone with no moment in between.
    expect(within(row("Effort")).getByText("High")).toBeInTheDocument();
    expect(screen.queryByText("Save your changes first.")).not.toBeInTheDocument();
    expect(dialog().getByText("This task started before your changes were saved.")).toHaveAttribute("role", "status");
    expect(dialog().getByRole("button", { name: "Create issue…" })).toBeEnabled();
    expect(dialog().queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    const scrim = screen.getByRole("dialog", { name: "Task" });
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A requeue returns the form with the stored values, and the note goes.
    view.rerender(render2(task({ state: "queued" })));
    expect(screen.queryByText("This task started before your changes were saved.")).not.toBeInTheDocument();
    expect(within(row("Effort")).getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
    expect(dialog().getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("says nothing when the task starts with no edits", () => {
    const view = open(task());
    view.rerender(render2(running()));
    expect(screen.queryByText("This task started before your changes were saved.")).not.toBeInTheDocument();
  });
});

describe("a task that is done", () => {
  it("shows the lock line without the requeue sentence, its report as a panel, and only Delete task in the footer", () => {
    open(task({ state: "done", session, report }));
    expect(screen.getByText("Started, so read-only.", { selector: ".taskReadNote" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Agent report" })).toBeInTheDocument();
    expect(footerButtons()).toEqual(["Delete task"]);
    expect(screen.getByRole("status")).toHaveTextContent("This task is done.");
  });
});

describe("the Complete when row in New task", () => {
  it("is the shared row with the helper, and the GitHub issue row is the checkbox's alone", () => {
    render(<TaskModal mode="new" repositoryId={repositoryId} repositoryName="pomegr" board={boardOf()} refresh={refresh} onCreated={vi.fn()} onClose={onClose} />);
    expect(rowLabels()).toEqual(["Feature", "Run on", "Effort", "Remote Control", "When done", "Complete when"]);
    expect(within(row("Complete when")).getByText("The agent judges Validated with the user and your own condition.")).toBeInTheDocument();
    fireEvent.click(within(row("When done")).getByRole("checkbox"));
    expect(within(row("When done")).getByRole("checkbox")).not.toBeChecked();
  });
});
