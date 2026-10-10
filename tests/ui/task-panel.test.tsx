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
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const reviewTask = task(12, {
  text: "Add a private task store.",
  run: { provider: "claude", model: "model-a", effort: "high" },
  doneWhen: { checks: ["pr_open", "tree_clean"], own: "Tests pass." },
  state: "needs_review",
  session: { id: "claude:abc123", title: "Task store and privacy rules", state: "idle", observedModel: "model-b" },
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
const save = (dialog: ReturnType<typeof within>) => dialog.getByRole("button", { name: "Save" });
async function openReviewPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(card("Task store and privacy rules"));
  return within(screen.getByRole("dialog", { name: "Task" }));
}
const updateCalls = () => taskAction.mock.calls.filter((call) => call[1] === "update");

describe("task cards", () => {
  it("show the provider chip, model, effort and Done when summary only when set", () => {
    setBoard([
      task(1, { run: { provider: "claude", model: "model-a", effort: "high" }, doneWhen: { checks: ["pr_open", "ci_passed"], own: null } }),
      task(2, { run: { provider: "codex", model: null, effort: null }, doneWhen: { checks: ["tree_clean"], own: "Looks right" } }),
      task(3, { run: { provider: null, model: null, effort: "low" } }),
      task(4),
    ]);
    render(<TaskBoardView board={useTasks().board} />);
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]).getByText("Claude Code")).toHaveClass("commandChip");
    expect(within(cards[0]).getByText("model-a · high")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Done when: 2 checks + agent report")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Codex")).toBeInTheDocument();
    expect(within(cards[1]).queryByText(/·/, { selector: ".taskCardPlanned" })).not.toBeInTheDocument();
    expect(within(cards[1]).getByText("Done when: 1 check + own condition + agent report")).toBeInTheDocument();
    expect(cards[2]).toHaveTextContent("low");
    expect(within(cards[2]).queryByText("Claude Code")).not.toBeInTheDocument();
    expect(within(cards[2]).queryByText(/Done when/)).not.toBeInTheDocument();
    expect(cards[3]).not.toHaveTextContent(/Claude Code|Codex|Done when/);
    expect(cards[3].querySelector(".taskCardRun")).toBeNull();
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
    expect(dialog.getByText("Task store and privacy rules")).toHaveClass("taskModalSessionTitle");
    expect(dialog.getByText(/Title from the session/)).toBeInTheDocument();
    expect(dialog.getByText("in Backlog")).toHaveClass("taskModalSubtitle");
    expect(dialog.getByRole("link", { name: "Open session" })).toHaveAttribute("href", expect.stringMatching(/^\/sessions\//));
    expect((dialog.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement).value).toBe("Add a private task store.");
    expect(dialog.getByRole("combobox", { name: "Run on" })).toHaveTextContent("Claude Code · model-a");
    expect(dialog.getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
    expect(dialog.getByRole("button", { name: "Low" })).toHaveAttribute("aria-pressed", "false");
    expect(dialog.getByRole("checkbox", { name: "PR open" })).toBeChecked();
    expect(dialog.getByRole("checkbox", { name: "CI passed" })).not.toBeChecked();
    expect((dialog.getByRole("textbox", { name: "Own condition" }) as HTMLInputElement).value).toBe("Tests pass.");
    expect(dialog.queryByRole("checkbox", { name: "Use your own condition" })).not.toBeInTheDocument();
    expect(dialog.getByText("25 / 4,000")).toHaveClass("taskTextCounter");
    expect(dialog.getByRole("button", { name: "Close" })).toHaveClass("commandIconAction");
    expect(dialog.getByRole("button", { name: "Delete task" })).toHaveClass("commandQuietAction");
    expect(dialog.getByRole("combobox", { name: "Feature" })).toHaveTextContent("No feature");
    expect(dialog.getByRole("combobox", { name: "Step" })).toBeDisabled();
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
    expect(dialog.queryByText("Pomegr verifies the listed conditions. Your own condition is judged by the agent.")).not.toBeInTheDocument();
  });

  it("omits results, the report line and the notice for a task with no report and no differing model", async () => {
    setBoard([task(5, { text: "Plain task", run: { provider: "claude", model: "model-a", effort: null }, doneWhen: { checks: ["pr_open"], own: null }, session: { id: "s", title: null, state: "working", observedModel: "model-a" } })]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Plain task"));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect((dialog.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement).value).toBe("Plain task");
    expect(dialog.queryByText(/Title from the session/)).not.toBeInTheDocument();
    expect(dialog.queryByText(/^Passed$|Not passed|Agent reported/)).not.toBeInTheDocument();
    expect(dialog.queryByText("Observed model differs")).not.toBeInTheDocument();
    expect(dialog.getByText("Pomegr verifies the listed conditions. Your own condition is judged by the agent.")).toBeInTheDocument();
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
    setBoard([task(5, { text: "Plain task", run: { provider: "claude", model: plannedModel, effort: null }, session: { id: "claude:s5", title: "Plain session", state: "working", observedModel } })]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Plain session"));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.queryByText("Observed model differs")).not.toBeInTheDocument();
    expect(dialog.queryByText(/latest recorded request used/)).not.toBeInTheDocument();
  });

  it("names the session as the title source only when the title is borrowed, and links to it either way", async () => {
    setBoard([
      task(5, { text: "Borrowed title", session: { id: "claude:s5", title: "Session title", state: "idle", observedModel: null } }),
      task(6, { text: "Own title", session: { id: "codex:s6", title: null, state: "idle", observedModel: null } }),
    ]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Session title"));
    let dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByText("Session title")).toHaveClass("taskModalSessionTitle");
    expect(dialog.getByText(/^Title from the session ·$/)).toBeInTheDocument();
    expect(dialog.getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/sessions/claude-s5");
    expect(dialog.getByRole("link", { name: "Open session" })).toHaveClass("commandTextLink");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(card("Own title"));
    dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect((dialog.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement).value).toBe("Own title");
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
    const session = (state: string) => ({ id: "claude:s5", title: "Chip session", state, observedModel: null });
    const user = userEvent.setup();
    setBoard([task(5, { state: "queued", session: session("needs_input") })]);
    const view = render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Chip session"));
    let dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByText("Needs input")).toHaveClass("commandChip", "warning");
    expect(dialog.queryByText("Queued")).not.toBeInTheDocument();
    view.unmount();

    setBoard([task(5, { state: "queued", session: session("unknown") })]);
    const unknown = render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Chip session"));
    dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByText("Queued")).toHaveClass("commandChip");
    expect(dialog.queryByText("Unknown")).not.toBeInTheDocument();
    unknown.unmount();

    setBoard([task(5, { state: "done", session: session("working") })]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Chip session"));
    dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByText("Done")).toHaveClass("commandChip");
    expect(dialog.queryByText("In progress")).not.toBeInTheDocument();
  });

  it("cannot start a session again for a task that already has one", async () => {
    const taskStart = vi.fn(async () => ({ status: "started" }));
    setBridge({ taskAction, taskStart });
    setBoard([task(5, { state: "queued", run: { provider: "claude", model: null, effort: null }, session: { id: "claude:s5", title: "Linked session", state: "working", observedModel: null } })]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Linked session"));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog.getByRole("status")).toHaveTextContent("A session is already linked to this task.");
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    expect(taskStart).not.toHaveBeenCalled();
  });

  it("sends nothing on change or blur, keeps Save disabled until the draft differs, and disables it again when undone", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    expect(save(dialog)).toHaveClass("commandPrimaryAction");
    expect(save(dialog)).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "Low" }));
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    await user.type(dialog.getByRole("textbox", { name: "Own condition" }), " More.");
    await user.type(dialog.getByRole("textbox", { name: "Task" }), " Also this.");
    await user.tab();
    expect(save(dialog)).toBeEnabled();
    expect(taskAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    // Putting every field back to its stored value leaves nothing to save.
    await user.click(dialog.getByRole("button", { name: "High" }));
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    await user.clear(dialog.getByRole("textbox", { name: "Own condition" }));
    await user.type(dialog.getByRole("textbox", { name: "Own condition" }), "Tests pass.");
    await user.clear(dialog.getByRole("textbox", { name: "Task" }));
    await user.type(dialog.getByRole("textbox", { name: "Task" }), "Add a private task store.");
    expect(save(dialog)).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("saves a run change and an effort change as the complete run, and clears effort", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openReviewPanel(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Run on" }), "claude:model:model-b");
    await user.click(dialog.getByRole("button", { name: "Xhigh" }));
    expect(taskAction).not.toHaveBeenCalled();
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", run: { provider: "claude", model: "model-b", effort: "xhigh" } });
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(panel()).not.toBeInTheDocument());

    // Pressing the chosen effort again clears it.
    dialog = await openReviewPanel(user);
    await user.click(dialog.getByRole("button", { name: "High" }));
    expect(dialog.getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "false");
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", run: { provider: "claude", model: "model-a", effort: null } });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());

    dialog = await openReviewPanel(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Run on" }), "");
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(3));
    // Not set clears the provider and model; the effort is its own control and stays.
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", run: { provider: null, model: null, effort: "high" } });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("saves a checkbox change as the complete doneWhen", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openReviewPanel(user);
    await user.click(dialog.getByRole("checkbox", { name: "Commit on branch" }));
    expect(taskAction).not.toHaveBeenCalled();
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", doneWhen: { checks: ["pr_open", "tree_clean", "commit_on_branch"], own: "Tests pass." } });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());

    // An emptied own condition is no own condition: there is no separate checkbox for it any more.
    dialog = await openReviewPanel(user);
    await user.clear(dialog.getByRole("textbox", { name: "Own condition" }));
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", doneWhen: { checks: ["pr_open", "tree_clean"], own: null } });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());

    // A blank one counts as none too.
    dialog = await openReviewPanel(user);
    await user.clear(dialog.getByRole("textbox", { name: "Own condition" }));
    await user.type(dialog.getByRole("textbox", { name: "Own condition" }), "   ");
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(3));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", doneWhen: { checks: ["pr_open", "tree_clean"], own: null } });
  });

  it("saves the own condition and the task text on Save, in one patch holding only what changed", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openReviewPanel(user);
    const ownInput = dialog.getByRole("textbox", { name: "Own condition" });
    await user.click(ownInput);
    await user.tab();
    expect(save(dialog)).toBeDisabled();
    await user.click(ownInput);
    await user.type(ownInput, " And lint is clean.");
    await user.tab();
    // Blur sends nothing: only Save does.
    expect(taskAction).not.toHaveBeenCalled();
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", doneWhen: { checks: ["pr_open", "tree_clean"], own: "Tests pass. And lint is clean." } });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());

    dialog = await openReviewPanel(user);
    const text = dialog.getByRole("textbox", { name: "Task" });
    await user.click(text);
    await user.tab();
    expect(save(dialog)).toBeDisabled();
    await user.click(text);
    await user.type(text, " Also document it.");
    await user.click(dialog.getByRole("button", { name: "Low" }));
    await user.click(save(dialog));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", text: "Add a private task store. Also document it.", run: { provider: "claude", model: "model-a", effort: "low" } });
    expect(updateCalls()).toHaveLength(2);
  });

  it("will not save a blank task text", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
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
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "update", { id: "T-12", text: "New words", doneWhen: { checks: ["pr_open", "tree_clean", "ci_passed"], own: "Tests pass." } }));
  });

  it("stays open, keeps the draft and shows one fixed message when Save fails, then saves the same patch on retry", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
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
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
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
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openReviewPanel(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(card("Task store and privacy rules")).toHaveFocus();
    await user.click(card("Task store and privacy rules"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(card("Task store and privacy rules")).toHaveFocus();
    expect(taskAction).not.toHaveBeenCalled();

    // An unsaved draft is dropped on close: the next open shows the stored task again.
    const dialog = await openReviewPanel(user);
    await user.type(dialog.getByRole("textbox", { name: "Task" }), " lost");
    await user.click(dialog.getByRole("button", { name: "Low" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    const reopened = await openReviewPanel(user);
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
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    const trigger = dialog.getByRole("combobox", { name: "Run on" });
    expect(trigger).toHaveTextContent("Claude Code · model-a");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Not set", "model-a, Claude Code", "Default model, Claude Code", "Default model, Codex",
    ]);
  });
});

describe("Task modal resolutions", () => {
  const blockedTask = task(14, {
    state: "blocked", session: { id: "claude:def456", title: null, state: "idle", observedModel: null },
    report: { at: "2026-10-08T12:00:00.000Z", results: [], blockReason: "The schema needs a decision." },
  });
  async function open(text: string) {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: text }));
    return { user, dialog: within(screen.getByRole("dialog", { name: "Task" })) };
  }

  it("says a stalled task's session ended with no report and offers both resolutions", async () => {
    setBoard([task(15, { text: "Stalled work", state: "stalled", doneWhen: { checks: ["pr_open"], own: null },
      session: { id: "claude:abc125", title: null, state: "closed", observedModel: null } })]);
    const { user, dialog } = await open("Stalled work");
    expect(dialog.getByText("Stalled")).toHaveClass("commandChip", "warning");
    expect(dialog.queryByText("Closed")).not.toBeInTheDocument();
    expect(dialog.getByText("The session ended with no report.")).toBeInTheDocument();
    expect(dialog.queryByText(/Agent reported/u)).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Requeue task" })).toHaveClass("commandSecondaryAction");
    await user.click(dialog.getByRole("button", { name: "Mark done and resume queue" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-15" }));
  });

  it("leads the footer of a task in review with Mark done and Requeue, before Delete", async () => {
    const { user, dialog } = await open("Task store and privacy rules");
    const done = dialog.getByRole("button", { name: "Mark done and resume queue" });
    const requeue = dialog.getByRole("button", { name: "Requeue task" });
    const remove = dialog.getByRole("button", { name: "Delete task" });
    // Save is the one primary action of the modal; the resolutions are secondary and sit above the footer row.
    expect(done).toHaveClass("commandSecondaryAction");
    expect(requeue).toHaveClass("commandSecondaryAction");
    expect(save(dialog)).toHaveClass("commandPrimaryAction");
    expect(remove).toHaveClass("commandQuietAction");
    expect(done.compareDocumentPosition(requeue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requeue.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
    await user.click(done);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-12" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("requeues a task the agent blocked and shows its reason", async () => {
    setBoard([reviewTask, blockedTask]);
    const { user, dialog } = await open("Task text 14");
    expect(dialog.getByText("Blocked by agent")).toHaveClass("commandChip");
    expect(dialog.getByText(/Agent reported it cannot continue/)).toHaveTextContent("The schema needs a decision.");
    await user.click(dialog.getByRole("button", { name: "Requeue task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_requeue", { id: "T-14" }));
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
    const session = { id: "claude:abc126", title: "Working session", state: "working", observedModel: null };
    setBoard([task(20, { text: "In flight", state: "queued", session })]);
    const { user, dialog } = await open("Working session");
    const done = dialog.getByRole("button", { name: "Mark done" });
    const requeue = dialog.getByRole("button", { name: "Requeue task" });
    // The session's own state stays on the chip; both exits are secondary so Start session keeps the one primary role.
    expect(dialog.getByText("In progress")).toHaveClass("commandChip");
    expect(done).toHaveClass("commandSecondaryAction");
    expect(requeue).toHaveClass("commandSecondaryAction");
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog.queryByRole("button", { name: "Mark done and resume queue" })).not.toBeInTheDocument();
    expect(dialog.getByText("The session has not reported. Mark done and Requeue do not stop it.")).toHaveClass("taskModalNote");
    expect(done.compareDocumentPosition(dialog.getByRole("button", { name: "Delete task" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(done);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-20" }));
    await user.click(requeue);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_requeue", { id: "T-20" }));
    expect(taskAction).toHaveBeenCalledTimes(2);
  });

  it("offers those two exits for every waiting state with a linked session, and for no task without one or with an outcome", async () => {
    const session = { id: "claude:abc127", title: null, state: "unknown", observedModel: null };
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
    setBoard([task(20, { text: "In flight", state: "queued", session: { id: "claude:abc126", title: "Working session", state: "working", observedModel: null } })]);
    const { user, dialog } = await open("Working session");
    await user.click(dialog.getByRole("button", { name: "Delete task" }));
    expect(dialog.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Requeue task" })).not.toBeInTheDocument();
    expect(dialog.queryByText(/do not stop it/u)).not.toBeInTheDocument();
  });

  it("shows one fixed line when the monitor refuses a resolution", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const { user, dialog } = await open("Task store and privacy rules");
    await user.click(dialog.getByRole("button", { name: "Mark done and resume queue" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The task could not be marked done.");
    await user.click(dialog.getByRole("button", { name: "Requeue task" }));
    await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent("The task could not be requeued."));
  });

  it("hides the resolutions while the delete confirmation is open", async () => {
    const { user, dialog } = await open("Task store and privacy rules");
    await user.click(dialog.getByRole("button", { name: "Delete task" }));
    expect(dialog.queryByRole("button", { name: "Mark done and resume queue" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Requeue task" })).not.toBeInTheDocument();
  });

  it("shows a CI condition's result like any other check", async () => {
    setBoard([task(19, {
      state: "needs_review", doneWhen: { checks: ["pr_open", "ci_passed"], own: null },
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

  it("maps the Run on, Effort, Done when and Task modal contract lines to tokens", () => {
    expect(rule(".taskRunRow")).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*align-items: end;[^}]*gap: var\(--space-4\)/);
    expect(styles).toMatch(/\.taskEffort > button \{ min-height: var\(--control-height\); \}/);
    expect(rule(".taskModelNotice")).toMatch(/border: 1px solid var\(--command-amber\)[^}]*border-radius: var\(--control-radius\)[^}]*background: var\(--color-amber-soft\)/);
    expect(rule(".taskChecks")).toMatch(/display: flex; flex-wrap: wrap; gap: var\(--space-1\) var\(--space-4\)/);
    expect(rule(".taskCheckRow")).toMatch(/display: inline-flex;[^}]*gap: var\(--space-2\);[^}]*min-height: 28px/);
    expect(rule('.taskCheckRow input[type="checkbox"]')).toMatch(/width: 16px; height: 16px;[^}]*accent-color: var\(--command-brand\)/);
    expect(rule(".taskOwnInput")).toMatch(/min-height: var\(--control-compact\);[^}]*border: 1px solid var\(--command-line-strong\)[^}]*border-radius: var\(--control-radius\)/);
    expect(rule(".taskDoneWhen .taskOwnInput")).toMatch(/min-height: var\(--control-height\)/);
    expect(rule(".taskCheckResult.isPassed")).toMatch(/var\(--command-green\)/);
    expect(rule(".taskCheckResult.isFailed")).toMatch(/var\(--command-error\)/);
    expect(rule(".taskTextCounter")).toMatch(/align-self: flex-end;[^}]*var\(--font-data\)/);
    expect(rule(".taskModalTitleGroup h2")).toMatch(/650 var\(--text-heading\)\/1\.35 var\(--font-ui\)/);
    expect(rule(".taskModal")).toMatch(/max-width: 640px[^}]*border-radius: var\(--panel-radius\)/);
    expect(styles).toMatch(/\.taskModalFooter :is\(\.commandPrimaryAction, \.commandSecondaryAction, \.commandQuietAction\) \{ min-height: var\(--control-height\); \}/);
  });
});
