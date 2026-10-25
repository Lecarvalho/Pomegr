import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
const agents = vi.hoisted(() => ({ runs: [] as Array<{ source: string; model: string | null }> }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: agents.runs }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { review: null,
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const reviewTask = task(12, {
  text: "Add a private task store.",
  run: { provider: "claude", model: "model-a", effort: "high" },
  completeWhen: { checks: ["pr_open", "tree_clean"], own: "Tests pass." },
  state: "needs_review",
  session: { id: "claude:abc123", title: "Task store and privacy rules", state: "idle", observedModel: "model-b", observedEffort: null },
  report: { at: "2026-10-08T11:42:00.000Z", results: [{ check: "pr_open", passed: false }, { check: "tree_clean", passed: true }], blockReason: null },
});

function setBoard(tasks: Task[]) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks, queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } };
  useTasks.mockReturnValue({ board, refresh });
  return board;
}
function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

beforeEach(() => {
  agents.runs = [{ source: "Claude Code", model: "model-a" }, { source: "Claude Code", model: "model-b" }];
  taskAction.mockResolvedValue({ ok: true });
  setBridge({ taskAction });
  setBoard([reviewTask, task(13)]);
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// The modal's dialog is named by its h2 alone ("Task"); the task ID is a sibling span in the header.
const panel = () => screen.queryByRole("dialog", { name: "Task" });
const card = (title: string) => screen.getByRole("button", { name: title });
// The Sessions rows repeat the started session's title and state, so the header and the title line are read by their own element.
const header = () => within(document.querySelector(".taskModalHeader") as HTMLElement);
const save = (dialog: ReturnType<typeof within>) => dialog.getByRole("button", { name: "Save" });
// A Run settings row of a started task: the value beside its label.
const rowValue = (dialog: ReturnType<typeof within>, label: string) => dialog.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
async function openReviewPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(card("Task store and privacy rules"));
  return within(screen.getByRole("dialog", { name: "Task" }));
}
// A started task is read-only, so the edit tests open the same task before any session started.
const draftTask = task(12, { text: reviewTask.text, run: reviewTask.run, completeWhen: reviewTask.completeWhen });
async function openDraftPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(card("Add a private task store."));
  return within(screen.getByRole("dialog", { name: "Task" }));
}
const updateCalls = () => taskAction.mock.calls.filter((call) => call[1] === "update");

describe("task cards", () => {
  it("show the planned run line, naming the provider only for its default model, and no Complete when line", () => {
    setBoard([
      task(1, { run: { provider: "claude", model: "model-a", effort: "high" }, completeWhen: { checks: ["pr_open", "ci_passed"], own: null } }),
      task(2, { run: { provider: "codex", model: null, effort: null }, completeWhen: { checks: ["tree_clean"], own: "Looks right" } }),
      task(3, { run: { provider: null, model: null, effort: "low" } }),
      task(4),
    ]);
    render(<TaskBoardView board={useTasks().board} />);
    const cards = screen.getAllByRole("listitem");
    // The run line is the planned text in the data font. A model names its provider, so there is no provider chip.
    expect(cards[0].querySelector(".taskCardPlanned")).toHaveTextContent(/^model-a · high$/);
    expect(within(cards[0]).queryByText("Claude Code")).not.toBeInTheDocument();
    // The provider's default model does not, so the line leads with the provider.
    expect(cards[1].querySelector(".taskCardPlanned")).toHaveTextContent(/^Codex$/);
    expect(cards[2].querySelector(".taskCardPlanned")).toHaveTextContent(/^low$/);
    expect(cards[3].querySelector(".taskCardPlanned")).toBeNull();
    // No card draws a Complete when line: the task modal shows it.
    for (const item of cards) {
      expect(item).not.toHaveTextContent(/Complete when/);
      expect(item.querySelector(".providerBadge")).toBeNull();
    }
  });

  it("are plain text, not controls, without the desktop bridge", () => {
    setBridge(undefined);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "Task store and privacy rules" })).not.toBeInTheDocument();
    expect(screen.getByText("Task store and privacy rules")).toBeInTheDocument();
  });
});

describe("Task modal, mode edit", () => {
  it("opens from a card and shows the stored values", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(panel()).not.toBeInTheDocument();
    const dialog = await openReviewPanel(user);
    expect(dialog.getByText("T-12")).toBeInTheDocument();
    expect(dialog.getByText("Needs review")).toHaveClass("commandChip");
    expect(dialog.getByRole("heading", { level: 2, name: "Task" })).toBeInTheDocument();
    expect(dialog.getByText("Task store and privacy rules", { selector: ".taskModalSessionTitle" })).toBeInTheDocument();
    expect(dialog.getByText(/Title from the session/)).toBeInTheDocument();
    // In mode edit the subtitle is the repository alone: the column is no longer named there.
    expect(header().queryByText(/in Backlog/)).not.toBeInTheDocument();
    expect(document.querySelector(".taskModalSubtitle")).toHaveTextContent(/^$/);
    expect(dialog.getByRole("link", { name: "Open session" })).toHaveAttribute("href", expect.stringMatching(/^\/sessions\//));
    // A task that has started is read, not edited: the text, then the settings as values, and no control.
    expect(dialog.getByRole("region", { name: "Task" })).toHaveTextContent("Add a private task store.");
    expect(dialog.getByText("Add a private task store.", { selector: ".taskReadTitle" })).toBeInTheDocument();
    expect(dialog.queryByRole("textbox")).not.toBeInTheDocument();
    expect(rowValue(dialog, "Run on")).toHaveTextContent("Claude Code · model-a");
    expect(rowValue(dialog, "Effort")).toHaveTextContent("High");
    expect(rowValue(dialog, "Feature")).toHaveTextContent("No feature");
    expect(dialog.queryByRole("combobox")).not.toBeInTheDocument();
    expect(dialog.queryByRole("checkbox")).not.toBeInTheDocument();
    // The conditions are listed with their results in the Review panel, so the Run settings do not list them again.
    const conditions = within(dialog.getByRole("list", { name: "Complete when" }));
    expect(conditions.getByText("PR open")).toBeInTheDocument();
    expect(conditions.queryByText("CI passed")).not.toBeInTheDocument();
    expect(conditions.getByText("Tests pass.")).toBeInTheDocument();
    expect(dialog.queryByText("Complete when", { selector: "dt" })).not.toBeInTheDocument();
    expect(dialog.queryByText("25 / 4,000")).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Close" })).toHaveClass("commandIconAction");
    expect(dialog.getByRole("button", { name: "Delete task" })).toHaveClass("commandQuietAction");
    expect(dialog.queryByRole("combobox", { name: "Step" })).not.toBeInTheDocument();
    // Nothing is written by opening the modal.
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("shows per-check results, the report line and the observed-model notice only when they exist", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    expect(dialog.getByText("Not passed")).toHaveClass("isFailed");
    expect(dialog.getByText("Passed")).toHaveClass("isPassed");
    expect(dialog.getByText("Agent-reported")).toBeInTheDocument();
    expect(dialog.getByText(/Agent reported complete/)).toBeInTheDocument();
    // The time is parenthesized so a locale time ending in a period never doubles the sentence's own.
    expect(dialog.getByText(/Agent reported complete/).textContent).toMatch(/^Agent reported complete \(.+\)\.$/u);
    expect(dialog.getByText("Observed model differs")).toBeInTheDocument();
    expect(dialog.getByText("model-b")).toBeInTheDocument();
    expect(dialog.queryByText("The agent judges Validated with the user and your own condition.")).not.toBeInTheDocument();
  });

  it("omits results, the report line and the notice for a task with no report and no differing model", async () => {
    setBoard([task(5, { text: "Plain task", run: { provider: "claude", model: "model-a", effort: null }, completeWhen: { checks: ["pr_open"], own: null }, session: { id: "s", title: null, state: "working", observedModel: "model-a", observedEffort: null } })]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Plain task"));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByText("Plain task", { selector: ".taskReadTitle" })).toBeInTheDocument();
    expect(dialog.queryByText(/Title from the session/)).not.toBeInTheDocument();
    expect(dialog.queryByText(/^Passed$|Not passed|Agent reported/)).not.toBeInTheDocument();
    expect(dialog.queryByText("Observed model differs")).not.toBeInTheDocument();
    // No report means no Review panel: the conditions are one row of the settings, and the form's helper is not drawn.
    expect(dialog.queryByRole("heading", { name: "Ready for your review" })).not.toBeInTheDocument();
    expect(rowValue(dialog, "Complete when")).toHaveTextContent("PR open");
    expect(dialog.queryByText("The agent judges Validated with the user and your own condition.")).not.toBeInTheDocument();
  });

  it("words the observed-model notice from the contract", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    const notice = dialog.getByText("Observed model differs").closest(".taskModelNotice");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent("Observed model differs Planned model-a, latest recorded request used model-b.");
    expect(dialog.getByText("model-a", { selector: "code" })).toBeInTheDocument();
    expect(dialog.getByText("model-b", { selector: "code" })).toBeInTheDocument();
  });

  it.each<[string, string | null, string | null]>([
    ["a planned alias inside the observed identifier", "opus", "claude-opus-4-1"],
    ["equal ignoring case", "Model-A", "model-a"],
    ["Default model planned", null, "model-b"],
    ["no observed model yet", "model-a", null],
  ])("shows no notice when the models match or cannot be compared: %s", async (_name, plannedModel, observedModel) => {
    setBoard([task(5, { text: "Plain task", run: { provider: "claude", model: plannedModel, effort: null }, session: { id: "claude:s5", title: "Plain session", state: "working", observedModel, observedEffort: null } })]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Plain session"));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.queryByText("Observed model differs")).not.toBeInTheDocument();
    expect(dialog.queryByText(/latest recorded request used/)).not.toBeInTheDocument();
  });

  it("names the session as the title source only when the title is borrowed, and links to it either way", async () => {
    setBoard([
      task(5, { text: "Borrowed title", session: { id: "claude:s5", title: "Session title", state: "idle", observedModel: null, observedEffort: null } }),
      task(6, { text: "Own title", session: { id: "codex:s6", title: null, state: "idle", observedModel: null, observedEffort: null } }),
    ]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Session title"));
    let dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByText("Session title", { selector: ".taskModalSessionTitle" })).toBeInTheDocument();
    expect(dialog.getByText(/^Title from the session ·$/)).toBeInTheDocument();
    expect(dialog.getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/sessions/claude-s5");
    expect(dialog.getByRole("link", { name: "Open session" })).toHaveClass("commandTextLink");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(card("Own title"));
    dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByText("Own title", { selector: ".taskReadTitle" })).toBeInTheDocument();
    expect(document.querySelector(".taskModalSessionTitle")).toBeNull();
    expect(dialog.queryByText(/Title from the session/)).not.toBeInTheDocument();
    expect(dialog.getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/sessions/codex-s6");
  });

  it("offers no session link and no title source for a task without a session", async () => {
    setBoard([task(5, { text: "Unlinked" })]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Unlinked"));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.queryByRole("link")).not.toBeInTheDocument();
    expect(dialog.queryByText(/Title from the session/)).not.toBeInTheDocument();
  });

  it("borrows the session's state in the header only while the task has no outcome and the session has facts", async () => {
    const session = (state: string) => ({ id: "claude:s5", title: "Chip session", state, observedModel: null, observedEffort: null });
    const user = userEvent.setup();
    setBoard([task(5, { state: "queued", session: session("needs_input") })]);
    const view = render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Chip session"));
    let dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(header().getByText("Needs input")).toHaveClass("commandChip", "warning");
    expect(dialog.queryByText("Queued")).not.toBeInTheDocument();
    view.unmount();

    setBoard([task(5, { state: "queued", session: session("unknown") })]);
    const unknown = render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Chip session"));
    dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(header().getByText("Queued")).toHaveClass("commandChip");
    expect(header().queryByText("Unknown")).not.toBeInTheDocument();
    unknown.unmount();

    setBoard([task(5, { state: "done", session: session("working") })]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Chip session"));
    dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(header().getByText("Done")).toHaveClass("commandChip");
    expect(header().queryByText("In progress")).not.toBeInTheDocument();
  });

  it("cannot start a session again for a task that already has one", async () => {
    const taskStart = vi.fn(async () => ({ status: "started" }));
    setBridge({ taskAction, taskStart });
    setBoard([task(5, { state: "queued", run: { provider: "claude", model: null, effort: null }, session: { id: "claude:s5", title: "Linked session", state: "working", observedModel: null, observedEffort: null } })]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Linked session"));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    // A started task never starts again: the action is not drawn, and the footer says why.
    expect(dialog.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
    expect(dialog.getByRole("status")).toHaveTextContent("A session is already linked to this task.");
    expect(taskStart).not.toHaveBeenCalled();
  });

  it("is read-only once the task has started, and says that a requeue opens it again", async () => {
    const user = userEvent.setup();
    const started: Array<[string, Partial<Task>, string]> = [
      ["Linked", { session: { id: "claude:abc123", title: null, state: "working", observedModel: null, observedEffort: null } }, "Started, so read-only. Requeue to edit."],
      ["In review", { state: "needs_review" }, "Started, so read-only. Requeue to edit."],
      ["Blocked", { state: "blocked" }, "Started, so read-only. Requeue to edit."],
      ["Stalled", { state: "stalled" }, "Started, so read-only. Requeue to edit."],
      ["Finished", { state: "done" }, "Started, so read-only."],
    ];
    for (const [text, overrides, note] of started) {
      setBoard([task(30, { text, run: { provider: "claude", model: "model-a", effort: "high" }, completeWhen: { checks: ["pr_open"], own: "Judged" }, ...overrides })]);
      const view = render(<TaskBoardPane repositoryId={repositoryId} />);
      await user.click(card(text));
      const dialog = within(screen.getByRole("dialog", { name: "Task" }));
      // The lock line sits under the Task label, with a decorative glyph beside it.
      expect(dialog.getByText(note, { exact: true }), text).toHaveClass("taskReadNote");
      expect(document.querySelector(".taskReadLock > svg"), text).toHaveAttribute("aria-hidden", "true");
      expect(dialog.getByRole("region", { name: "Task" }), text).toHaveTextContent(text);
      // Nothing is a control: no text field, no select, no segment, no checkbox, and no Save.
      for (const role of ["textbox", "combobox", "checkbox"] as const) expect(dialog.queryByRole(role), `${text} ${role}`).not.toBeInTheDocument();
      for (const name of ["Low", "High"]) expect(dialog.queryByRole("button", { name }), `${text} ${name}`).not.toBeInTheDocument();
      expect(dialog.queryByRole("button", { name: "Save" }), text).not.toBeInTheDocument();
      // The stored values still show, and the task can still be deleted.
      expect(rowValue(dialog, "Run on"), text).toHaveTextContent("Claude Code · model-a");
      expect(rowValue(dialog, "Effort"), text).toHaveTextContent("High");
      expect(rowValue(dialog, "Remote Control"), text).toHaveTextContent("Off");
      expect(rowValue(dialog, "When done"), text).toHaveTextContent("Remove worktree and branch");
      expect(rowValue(dialog, "Complete when"), text).toHaveTextContent("PR open, Judged");
      expect(dialog.getByRole("button", { name: "Delete task" })).toBeEnabled();
      view.unmount();
    }
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("stays editable, with no such line, while the task has not started", async () => {
    const user = userEvent.setup();
    for (const state of ["not_queued", "queued", "scheduled"] as const) {
      setBoard([task(31, { text: `Waiting ${state}`, state })]);
      const view = render(<TaskBoardPane repositoryId={repositoryId} />);
      await user.click(card(`Waiting ${state}`));
      const dialog = within(screen.getByRole("dialog", { name: "Task" }));
      expect(dialog.queryByText(/This task has started/), state).not.toBeInTheDocument();
      expect(dialog.getByRole("textbox", { name: "Task" }), state).not.toHaveAttribute("readonly");
      expect(dialog.getByRole("combobox", { name: "Run on" }), state).toBeEnabled();
      expect(save(dialog), state).toBeInTheDocument();
      view.unmount();
    }
  });

  it("sends nothing on change or blur, keeps Save disabled until the draft differs, and disables it again when undone", async () => {
    const user = userEvent.setup({ delay: null });
    setBoard([draftTask, task(13)]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openDraftPanel(user);
    expect(save(dialog)).toHaveClass("commandPrimaryAction");
    expect(save(dialog)).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "Low" }));
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    await user.click(dialog.getByRole("textbox", { name: "Own condition" }));
    await user.paste(" More.");
    await user.click(dialog.getByRole("textbox", { name: "Task" }));
    await user.paste(" Also this.");
    await user.tab();
    expect(save(dialog)).toBeEnabled();
    expect(taskAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    // Putting every field back to its stored value leaves nothing to save.
    await user.click(dialog.getByRole("button", { name: "High" }));
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    await user.clear(dialog.getByRole("textbox", { name: "Own condition" }));
    await user.click(dialog.getByRole("textbox", { name: "Own condition" }));
    await user.paste("Tests pass.");
    await user.clear(dialog.getByRole("textbox", { name: "Task" }));
    await user.click(dialog.getByRole("textbox", { name: "Task" }));
    await user.paste("Add a private task store.");
    expect(save(dialog)).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("saves a run change and an effort change as the complete run, and never clears either", async () => {
    const user = userEvent.setup();
    setBoard([draftTask, task(13)]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openDraftPanel(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Run on" }), "claude:model:model-b");
    await user.click(dialog.getByRole("button", { name: "Xhigh" }));
    expect(taskAction).not.toHaveBeenCalled();
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", run: { provider: "claude", model: "model-b", effort: "xhigh" } });
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(panel()).not.toBeInTheDocument());

    // Pressing the chosen effort again keeps it, and Run on offers no Not set: the draft is unchanged.
    dialog = await openDraftPanel(user);
    await user.click(dialog.getByRole("button", { name: "High" }));
    expect(dialog.getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(dialog.getByRole("combobox", { name: "Run on" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).not.toContain("Not set");
    expect(save(dialog)).toBeDisabled();
    expect(taskAction).toHaveBeenCalledTimes(1);
  });

  it("saves a checkbox change as the complete completeWhen", async () => {
    const user = userEvent.setup();
    setBoard([draftTask, task(13)]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openDraftPanel(user);
    await user.click(dialog.getByRole("checkbox", { name: "Commit on branch" }));
    expect(taskAction).not.toHaveBeenCalled();
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", completeWhen: { checks: ["pr_open", "tree_clean", "commit_on_branch"], own: "Tests pass." } });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());

    // An emptied own condition is no own condition: there is no separate checkbox for it any more.
    dialog = await openDraftPanel(user);
    await user.clear(dialog.getByRole("textbox", { name: "Own condition" }));
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", completeWhen: { checks: ["pr_open", "tree_clean"], own: null } });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());

    // A blank one counts as none too.
    dialog = await openDraftPanel(user);
    await user.clear(dialog.getByRole("textbox", { name: "Own condition" }));
    await user.type(dialog.getByRole("textbox", { name: "Own condition" }), "   ");
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(3));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", completeWhen: { checks: ["pr_open", "tree_clean"], own: null } });
  });

  it("saves the own condition and the task text on Save, in one patch holding only what changed", async () => {
    const user = userEvent.setup({ delay: null });
    setBoard([draftTask, task(13)]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openDraftPanel(user);
    const ownInput = dialog.getByRole("textbox", { name: "Own condition" });
    await user.click(ownInput);
    await user.tab();
    expect(save(dialog)).toBeDisabled();
    await user.click(ownInput);
    await user.paste(" And lint is clean.");
    await user.tab();
    // Blur sends nothing: only Save does.
    expect(taskAction).not.toHaveBeenCalled();
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", completeWhen: { checks: ["pr_open", "tree_clean"], own: "Tests pass. And lint is clean." } });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());

    dialog = await openDraftPanel(user);
    const text = dialog.getByRole("textbox", { name: "Task" });
    await user.click(text);
    await user.tab();
    expect(save(dialog)).toBeDisabled();
    await user.click(text);
    await user.paste(" Also document it.");
    await user.click(dialog.getByRole("button", { name: "Low" }));
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", text: "Add a private task store. Also document it.", run: { provider: "claude", model: "model-a", effort: "low" } });
    expect(updateCalls()).toHaveLength(2);
  });

  it("will not save a blank task text", async () => {
    const user = userEvent.setup();
    setBoard([draftTask, task(13)]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openDraftPanel(user);
    const text = dialog.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement;
    await user.clear(text);
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    expect(save(dialog)).toBeDisabled();
    await user.type(text, "   ");
    expect(save(dialog)).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
    await user.type(text, "New words");
    expect(save(dialog)).toBeEnabled();
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "update", { id: "T-12", text: "New words", completeWhen: { checks: ["pr_open", "tree_clean", "ci_passed"], own: "Tests pass." } }));
  });

  it("stays open, keeps the draft and shows one fixed message when Save fails, then saves the same patch on retry", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    setBoard([draftTask, task(13)]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openDraftPanel(user);
    await user.click(dialog.getByRole("button", { name: "Low" }));
    await user.click(save(dialog));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The change could not be saved.");
    expect(panel()).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Low" })).toHaveAttribute("aria-pressed", "true");
    expect(save(dialog)).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
    taskAction.mockResolvedValue({ ok: true });
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction.mock.calls[1]).toEqual(taskAction.mock.calls[0]);
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores a second click on Save while the first is in flight", async () => {
    let resolve!: (value: Result) => void;
    taskAction.mockReturnValue(new Promise<Result>((r) => { resolve = r; }));
    const user = userEvent.setup();
    setBoard([draftTask, task(13)]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openDraftPanel(user);
    await user.click(dialog.getByRole("button", { name: "Low" }));
    await user.dblClick(save(dialog));
    expect(taskAction).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
  });

  it("deletes only after an inline confirmation, then closes", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    await user.click(dialog.getByRole("button", { name: "Delete task" }));
    expect(taskAction).not.toHaveBeenCalled();
    const confirm = dialog.getByRole("group", { name: "Confirm delete" });
    expect(confirm).toHaveTextContent("Delete T-12? This cannot be undone.");
    expect(dialog.getByRole("button", { name: "Keep task" })).toHaveFocus();
    await user.click(dialog.getByRole("button", { name: "Keep task" }));
    expect(taskAction).not.toHaveBeenCalled();
    expect(dialog.getByRole("button", { name: "Delete task" })).toBeInTheDocument();

    await user.click(dialog.getByRole("button", { name: "Delete task" }));
    await user.click(dialog.getByRole("button", { name: "Delete T-12" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "delete", { id: "T-12" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the panel open with one fixed message when the delete fails", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "not_found" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    await user.click(dialog.getByRole("button", { name: "Delete task" }));
    await user.click(dialog.getByRole("button", { name: "Delete T-12" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The task could not be deleted.");
    expect(panel()).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    expect(dialog.getByRole("button", { name: "Delete task" })).toBeInTheDocument();
  });

  it("closes with Close or Escape without sending anything, discards the draft, and returns focus to the card", async () => {
    const user = userEvent.setup();
    setBoard([draftTask, task(13)]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openDraftPanel(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(card("Add a private task store.")).toHaveFocus();
    await user.click(card("Add a private task store."));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(card("Add a private task store.")).toHaveFocus();
    expect(taskAction).not.toHaveBeenCalled();

    // An unsaved draft is dropped on close: the next open shows the stored task again.
    const dialog = await openDraftPanel(user);
    await user.type(dialog.getByRole("textbox", { name: "Task" }), " lost");
    await user.click(dialog.getByRole("button", { name: "Low" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    const reopened = await openDraftPanel(user);
    expect((reopened.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement).value).toBe("Add a private task store.");
    expect(reopened.getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
    expect(save(reopened)).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("replaces the New task modal when a card is opened", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
    fireEvent.click(card("Task store and privacy rules"));
    expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument();
    expect(panel()).toBeInTheDocument();
  });

  it("offers a stored model that is no longer observed and only Default model when no list exists", async () => {
    agents.runs = [];
    const user = userEvent.setup();
    setBoard([draftTask, task(13)]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openDraftPanel(user);
    const trigger = dialog.getByRole("combobox", { name: "Run on" });
    expect(trigger).toHaveTextContent("Claude Code · model-a");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "model-a, Claude Code", "Default model, Claude Code", "Default model, Codex",
    ]);
  });
});

describe("Task modal resolutions", () => {
  const blockedTask = task(14, {
    state: "blocked", session: { id: "claude:def456", title: null, state: "idle", observedModel: null, observedEffort: null },
    report: { at: "2026-10-08T12:00:00.000Z", results: [], blockReason: "The schema needs a decision." },
  });
  async function open(text: string) {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: text }));
    return { user, dialog: within(screen.getByRole("dialog", { name: "Task" })) };
  }

  it("says a stalled task's session ended with no report and offers both resolutions", async () => {
    setBoard([task(15, { text: "Stalled work", state: "stalled", completeWhen: { checks: ["pr_open"], own: null },
      session: { id: "claude:abc125", title: null, state: "closed", observedModel: null, observedEffort: null } })]);
    const { user, dialog } = await open("Stalled work");
    expect(header().getByText("Stalled")).toHaveClass("commandChip", "warning");
    expect(header().queryByText("Closed")).not.toBeInTheDocument();
    // The Review panel names the state, says the session ended with no report, and lists no result.
    expect(dialog.getByRole("heading", { level: 3, name: "Stalled" })).toBeInTheDocument();
    expect(dialog.getByText("The session ended with no report.")).toBeInTheDocument();
    expect(dialog.queryByRole("list", { name: "Complete when" })).not.toBeInTheDocument();
    expect(rowValue(dialog, "Complete when")).toHaveTextContent("PR open");
    expect(dialog.queryByText(/Agent reported/u)).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Requeue task" })).toHaveClass("commandSecondaryAction");
    expect(dialog.getByRole("button", { name: "Mark done and resume queue" })).toHaveClass("commandPrimaryAction");
    await user.click(dialog.getByRole("button", { name: "Mark done and resume queue" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-15" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());
  });

  it("draws the footer of a task in review as one row: Delete, then Requeue, then Mark done as the one primary", async () => {
    const { user, dialog } = await open("Task store and privacy rules");
    // A task in review holds no queue, so the action does not speak of resuming one.
    const done = dialog.getByRole("button", { name: "Mark done" });
    expect(dialog.queryByRole("button", { name: "Mark done and resume queue" })).not.toBeInTheDocument();
    const requeue = dialog.getByRole("button", { name: "Requeue task" });
    const remove = dialog.getByRole("button", { name: "Delete task" });
    // Mark done is the one primary, Requeue is secondary, and a started task has nothing to save.
    expect(done).toHaveClass("commandPrimaryAction");
    expect(requeue).toHaveClass("commandSecondaryAction");
    expect(dialog.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(remove).toHaveClass("commandQuietAction");
    expect(remove.compareDocumentPosition(requeue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requeue.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(done.closest(".taskModalFooter")).toBe(remove.closest(".taskModalFooter"));
    expect(document.querySelector(".taskModalResolve")).toBeNull();
    expect(dialog.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
    await user.click(done);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-12" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());
  });

  it("requeues a task the agent blocked and shows its reason", async () => {
    setBoard([reviewTask, blockedTask]);
    const { user, dialog } = await open("Task text 14");
    expect(header().getByText("Blocked by agent")).toHaveClass("commandChip");
    expect(dialog.getByRole("heading", { level: 3, name: "Blocked by agent" })).toBeInTheDocument();
    expect(dialog.getByText(/Agent reported it cannot continue/).textContent).toMatch(/^Agent reported it cannot continue \(.+\):$/u);
    expect(dialog.getByText("The schema needs a decision.").closest(".taskReportNotice")).not.toBeNull();
    await user.click(dialog.getByRole("button", { name: "Requeue task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_requeue", { id: "T-14" }));
    // A requeued task can be edited again, so its modal stays.
    await waitFor(() => expect(dialog.getByRole("button", { name: "Requeue task" })).toBeEnabled());
    expect(screen.getByRole("dialog", { name: "Task" })).toBeInTheDocument();
  });

  it("offers the resolutions for a stalled task and for no other state", async () => {
    setBoard([task(15, { state: "stalled" }), task(16, { state: "done" }), task(17, { state: "queued" }), task(18)]);
    const first = await open("Task text 15");
    expect(first.dialog.getByRole("button", { name: "Mark done and resume queue" })).toBeInTheDocument();
    for (const [text] of [["Task text 16", "T-16"], ["Task text 17", "T-17"], ["Task text 18", "T-18"]]) {
      await first.user.click(screen.getByRole("button", { name: text }));
      const dialog = within(screen.getByRole("dialog", { name: "Task" }));
      expect(dialog.queryByRole("button", { name: "Mark done and resume queue" })).not.toBeInTheDocument();
      expect(dialog.queryByRole("button", { name: "Requeue task" })).not.toBeInTheDocument();
    }
  });

  it("offers Mark done and Requeue for a linked task whose session has not reported, and says neither stops the session", async () => {
    const session = { id: "claude:abc126", title: "Working session", state: "working", observedModel: null, observedEffort: null };
    setBoard([task(20, { text: "In flight", state: "queued", session })]);
    const { user, dialog } = await open("Working session");
    const done = dialog.getByRole("button", { name: "Mark done" });
    const requeue = dialog.getByRole("button", { name: "Requeue task" });
    // The session's own state stays on the chip; both exits are secondary so Start session keeps the one primary role.
    expect(header().getByText("In progress")).toHaveClass("commandChip");
    // The task does not need the user yet, so both exits are secondary and the view has no primary action.
    expect(done).toHaveClass("commandSecondaryAction");
    expect(requeue).toHaveClass("commandSecondaryAction");
    expect(dialog.getAllByRole("button").some((button) => button.classList.contains("commandPrimaryAction"))).toBe(false);
    expect(dialog.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Mark done and resume queue" })).not.toBeInTheDocument();
    expect(dialog.getByText("The session has not reported. Mark done and Requeue do not stop it.")).toHaveClass("taskModalNote");
    expect(dialog.getByRole("button", { name: "Delete task" }).compareDocumentPosition(requeue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requeue.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(requeue);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_requeue", { id: "T-20" }));
    await waitFor(() => expect(done).toBeEnabled());
    await user.click(done);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-20" }));
    expect(taskAction).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());
  });

  it("offers those two exits for every waiting state with a linked session, and for no task without one or with an outcome", async () => {
    const session = { id: "claude:abc127", title: null, state: "unknown", observedModel: null, observedEffort: null };
    setBoard([
      task(21, { state: "not_queued", session }), task(22, { state: "scheduled", scheduledAt: "2026-10-09T10:00:00.000Z", session }),
      task(23, { state: "queued" }), task(24, { state: "done", session }),
    ]);
    const first = await open("Task text 21");
    expect(first.dialog.getByRole("button", { name: "Mark done" })).toBeInTheDocument();
    for (const [text, , offered] of [["Task text 22", "T-22", true], ["Task text 23", "T-23", false], ["Task text 24", "T-24", false]] as const) {
      await first.user.click(screen.getByRole("button", { name: text }));
      const dialog = within(screen.getByRole("dialog", { name: "Task" }));
      expect(dialog.queryByRole("button", { name: "Mark done" }) !== null).toBe(offered);
      expect(dialog.queryByRole("button", { name: "Requeue task" }) !== null).toBe(offered);
      expect(dialog.queryByText(/do not stop it/u) !== null).toBe(offered);
    }
  });

  it("hides the exits of a task awaiting a report while the delete confirmation is open", async () => {
    setBoard([task(20, { text: "In flight", state: "queued", session: { id: "claude:abc126", title: "Working session", state: "working", observedModel: null, observedEffort: null } })]);
    const { user, dialog } = await open("Working session");
    await user.click(dialog.getByRole("button", { name: "Delete task" }));
    expect(dialog.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Requeue task" })).not.toBeInTheDocument();
    expect(dialog.queryByText(/do not stop it/u)).not.toBeInTheDocument();
  });

  it("shows one fixed line when the monitor refuses a resolution", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const { user, dialog } = await open("Task store and privacy rules");
    await user.click(dialog.getByRole("button", { name: "Mark done" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The task could not be marked done.");
    await user.click(dialog.getByRole("button", { name: "Requeue task" }));
    await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent("The task could not be requeued."));
  });

  it("hides the resolutions while the delete confirmation is open", async () => {
    const { user, dialog } = await open("Task store and privacy rules");
    await user.click(dialog.getByRole("button", { name: "Delete task" }));
    expect(dialog.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Requeue task" })).not.toBeInTheDocument();
  });

  it("shows the agent's attention line as the agent's own words, for a task every check of which passed", async () => {
    setBoard([task(19, { text: "Finished with a note", state: "needs_review", completeWhen: { checks: ["pr_open"], own: null },
      session: { id: "claude:abc129", title: null, state: "closed", observedModel: null, observedEffort: null },
      report: { at: "2026-10-08T12:00:00.000Z", results: [{ check: "pr_open", passed: true }], blockReason: null, attention: "The retry limit of **five** is a guess; confirm `RETRY_LIMIT` and [the PR](https://example.test)." } })]);
    const { dialog } = await open("Finished with a note");
    expect(dialog.getByText("Needs review")).toHaveClass("commandChip", "warning");
    expect(dialog.getByText("Passed")).toHaveClass("isPassed");
    const line = dialog.getByText(/Agent reported complete/u);
    expect(line.textContent).toMatch(/^Agent reported complete \(.+\) and asks for your attention:$/u);
    // The agent's words stand apart in the notice, with bold and inline code formatted and a link left as written.
    const notice = line.parentElement!.querySelector(".taskReportNotice") as HTMLElement;
    expect(notice).toHaveTextContent("The retry limit of five is a guess; confirm RETRY_LIMIT and [the PR](https://example.test).");
    expect(within(notice).getByText("five").tagName).toBe("STRONG");
    expect(within(notice).getByText("RETRY_LIMIT")).toHaveClass("agentChatInlineCode");
    expect(notice.querySelector("a")).toBeNull();
    expect(dialog.getByRole("button", { name: "Mark done" })).toBeInTheDocument();
  });

  it("shows a CI condition's result like any other check", async () => {
    setBoard([task(19, {
      state: "needs_review", completeWhen: { checks: ["pr_open", "ci_passed"], own: null },
      report: { at: "2026-10-08T11:42:00.000Z", results: [{ check: "pr_open", passed: true }, { check: "ci_passed", passed: false }], blockReason: null },
    })]);
    const { dialog } = await open("Task text 19");
    expect(dialog.getByText("Not passed")).toHaveClass("isFailed");
    expect(dialog.getByText("Passed")).toHaveClass("isPassed");
    expect(dialog.queryByText("Not available yet")).not.toBeInTheDocument();
  });
});

describe("task field styles", () => {
  const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.[\]":()+>*-]/g, "\\$&");
    const match = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    expect(match, `${selector} rule`).not.toBeNull();
    return match![1];
  };

  it("maps the Run on, Effort, Complete when and Task modal contract lines to tokens", () => {
    expect(rule(".taskRow")).toMatch(/grid-template-columns: 148px minmax\(0, 1fr\);[^}]*min-height: 40px;[^}]*border-top: 1px solid var\(--command-line\)/);
    expect(rule(".taskRow > dt")).toMatch(/color: var\(--command-muted\);[^}]*400 var\(--text-xs\)/);
    expect(styles).toMatch(/\.taskEffort > button \{ min-height: var\(--control-height\); \}/);
    expect(rule(".taskModelNotice")).toMatch(/border: 1px solid var\(--command-amber\)[^}]*border-radius: var\(--control-radius\)[^}]*background: var\(--color-amber-soft\)/);
    expect(rule(".taskReportNotice")).toMatch(/border: 1px solid var\(--command-amber\)[^}]*background: var\(--color-amber-soft\)[^}]*color: var\(--command-ink\)[^}]*400 var\(--text-sm\)/);
    expect(rule(".taskChecks")).toMatch(/display: flex; flex-wrap: wrap; gap: var\(--space-1\) var\(--space-4\)/);
    expect(rule(".taskCheckRow")).toMatch(/display: inline-flex;[^}]*gap: var\(--space-2\);[^}]*min-height: 28px/);
    expect(rule('.taskCheckRow input[type="checkbox"]')).toMatch(/width: 16px; height: 16px;[^}]*accent-color: var\(--command-brand\)/);
    expect(rule(".taskOwnInput")).toMatch(/min-height: var\(--control-compact\);[^}]*border: 1px solid var\(--command-line-strong\)[^}]*border-radius: var\(--control-radius\)/);
    expect(rule(".taskCompleteWhen .taskOwnInput")).toMatch(/min-height: var\(--control-height\)/);
    expect(rule(".taskCheckResult.isPassed")).toMatch(/var\(--command-green\)/);
    expect(rule(".taskCheckResult.isFailed")).toMatch(/var\(--command-error\)/);
    expect(rule(".taskTextCounter")).toMatch(/align-self: flex-end;[^}]*var\(--font-data\)/);
    expect(rule(".taskModalTitleGroup h2")).toMatch(/650 var\(--text-heading\)\/1\.35 var\(--font-ui\)/);
    expect(rule(".taskModal")).toMatch(/max-width: 640px[^}]*border-radius: var\(--panel-radius\)/);
    expect(styles).toMatch(/\.taskModalFooter :is\(\.commandPrimaryAction, \.commandSecondaryAction, \.commandQuietAction\) \{ min-height: var\(--control-height\); \}/);
  });
});
