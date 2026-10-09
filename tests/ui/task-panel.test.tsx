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
import { TasksTab } from "../../app/components/tasks/TasksTab";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, report: null,
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
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks, queue: { status: "idle", blockedBy: null } };
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

const panel = () => screen.queryByRole("dialog", { name: "Task T-12" });
const card = (title: string) => screen.getByRole("button", { name: title });
async function openReviewPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(card("Task store and privacy rules"));
  return within(screen.getByRole("dialog", { name: "Task T-12" }));
}

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
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "Task store and privacy rules" })).not.toBeInTheDocument();
    expect(screen.getByText("Task store and privacy rules")).toBeInTheDocument();
  });
});

describe("Task panel", () => {
  it("opens from a card and shows the stored values", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    expect(panel()).not.toBeInTheDocument();
    const dialog = await openReviewPanel(user);
    expect(dialog.getByText("T-12")).toBeInTheDocument();
    expect(dialog.getByText("Needs review")).toHaveClass("commandChip");
    expect(dialog.getByRole("heading", { name: "Task store and privacy rules" })).toBeInTheDocument();
    expect(dialog.getByText(/Title from the session/)).toBeInTheDocument();
    expect(dialog.getByRole("link", { name: "Open session" })).toHaveAttribute("href", expect.stringMatching(/^\/sessions\//));
    expect((dialog.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement).value).toBe("Add a private task store.");
    expect(dialog.getByRole("combobox", { name: "Run on" })).toHaveTextContent("Claude Code · model-a");
    expect(dialog.getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
    expect(dialog.getByRole("button", { name: "Low" })).toHaveAttribute("aria-pressed", "false");
    expect(dialog.getByRole("checkbox", { name: "Pull request open" })).toBeChecked();
    expect(dialog.getByRole("checkbox", { name: "CI passed" })).not.toBeChecked();
    expect((dialog.getByRole("textbox", { name: "Your own condition, judged by the agent" }) as HTMLInputElement).value).toBe("Tests pass.");
    expect(dialog.getByRole("checkbox", { name: "Use your own condition" })).toBeChecked();
    expect(dialog.getByRole("button", { name: "Close task" })).toHaveClass("commandIconAction");
    expect(dialog.getByRole("button", { name: "Delete task" })).toHaveClass("commandQuietAction");
    // The feature part and the queue-resolve part are not drawn here.
    expect(dialog.queryByText(/Feature|Step in feature|Mark done|Requeue/)).not.toBeInTheDocument();
  });

  it("shows per-check results, the report line and the observed-model notice only when they exist", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    expect(dialog.getByText("Not passed")).toHaveClass("isFailed");
    expect(dialog.getByText("Passed")).toHaveClass("isPassed");
    expect(dialog.getByText("Agent-reported")).toBeInTheDocument();
    expect(dialog.getByText(/Agent reported complete/)).toBeInTheDocument();
    expect(dialog.getByText("Observed model differs")).toBeInTheDocument();
    expect(dialog.getByText("model-b")).toBeInTheDocument();
    expect(dialog.queryByText("Pomegr verifies the listed conditions. Your own condition is judged by the agent.")).not.toBeInTheDocument();
  });

  it("omits results, the report line and the notice for a task with no report and no differing model", async () => {
    setBoard([task(5, { text: "Plain task", run: { provider: "claude", model: "model-a", effort: null }, doneWhen: { checks: ["pr_open"], own: null }, session: { id: "s", title: null, state: "working", observedModel: "model-a" } })]);
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.click(card("Plain task"));
    const dialog = within(screen.getByRole("dialog", { name: "Task T-5" }));
    expect(dialog.getByRole("heading", { name: "Plain task" })).toBeInTheDocument();
    expect(dialog.queryByText(/Title from the session/)).not.toBeInTheDocument();
    expect(dialog.queryByText(/^Passed$|Not passed|Agent reported/)).not.toBeInTheDocument();
    expect(dialog.queryByText("Observed model differs")).not.toBeInTheDocument();
    expect(dialog.getByText("Pomegr verifies the listed conditions. Your own condition is judged by the agent.")).toBeInTheDocument();
  });

  it("saves a run change and an effort change as the complete run, and clears effort", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Run on" }), "claude:model:model-b");
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", run: { provider: "claude", model: "model-b", effort: "high" } });
    await user.click(dialog.getByRole("button", { name: "Xhigh" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", run: { provider: "claude", model: "model-b", effort: "xhigh" } });
    await user.click(dialog.getByRole("button", { name: "Xhigh" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(3));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", run: { provider: "claude", model: "model-b", effort: null } });
    chooseCommandOption(dialog.getByRole("combobox", { name: "Run on" }), "");
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(4));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", run: { provider: null, model: null, effort: null } });
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("saves a checkbox change as the complete doneWhen", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    await user.click(dialog.getByRole("checkbox", { name: "Commit on task branch" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", doneWhen: { checks: ["pr_open", "tree_clean", "commit_on_branch"], own: "Tests pass." } });
    await user.click(dialog.getByRole("checkbox", { name: "Use your own condition" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", doneWhen: { checks: ["pr_open", "tree_clean", "commit_on_branch"], own: null } });
    // A quick toggle back is still sent even though the board has not refreshed.
    await user.click(dialog.getByRole("checkbox", { name: "Use your own condition" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(3));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", doneWhen: { checks: ["pr_open", "tree_clean", "commit_on_branch"], own: "Tests pass." } });
  });

  it("saves the own condition and the task text on blur, and only when changed", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    const ownInput = dialog.getByRole("textbox", { name: "Your own condition, judged by the agent" });
    await user.click(ownInput);
    await user.tab();
    expect(taskAction).not.toHaveBeenCalled();
    await user.click(ownInput);
    await user.type(ownInput, " And lint is clean.");
    expect(taskAction).not.toHaveBeenCalled();
    await user.tab();
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", doneWhen: { checks: ["pr_open", "tree_clean"], own: "Tests pass. And lint is clean." } });

    const text = dialog.getByRole("textbox", { name: "Task" });
    await user.click(text);
    await user.tab();
    expect(taskAction).toHaveBeenCalledTimes(1);
    await user.click(text);
    await user.type(text, " Also document it.");
    await user.tab();
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-12", text: "Add a private task store. Also document it." });
  });

  it("refuses to blank the task text and restores it", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    const text = dialog.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement;
    await user.clear(text);
    await user.tab();
    expect(await dialog.findByRole("alert")).toHaveTextContent("The task needs some text.");
    expect(text.value).toBe("Add a private task store.");
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("reverts the field and shows one fixed message when a save fails", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    await user.click(dialog.getByRole("button", { name: "Low" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The change could not be saved.");
    expect(dialog.getByRole("button", { name: "Low" })).toHaveAttribute("aria-pressed", "false");
    expect(dialog.getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
    expect(refresh).not.toHaveBeenCalled();
    // The reverted value is what the next change builds on.
    taskAction.mockResolvedValue({ ok: true });
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("deletes only after an inline confirmation, then closes", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    await user.click(dialog.getByRole("button", { name: "Delete task" }));
    await user.click(dialog.getByRole("button", { name: "Delete T-12" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The task could not be deleted.");
    expect(panel()).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    expect(dialog.getByRole("button", { name: "Delete task" })).toBeInTheDocument();
  });

  it("closes with Close task or Escape and returns focus to the card", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await openReviewPanel(user);
    await user.click(screen.getByRole("button", { name: "Close task" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(card("Task store and privacy rules")).toHaveFocus();
    await user.click(card("Task store and privacy rules"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(card("Task store and privacy rules")).toHaveFocus();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("replaces the New task panel when a card is opened", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
    fireEvent.click(card("Task store and privacy rules"));
    expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument();
    expect(panel()).toBeInTheDocument();
  });

  it("offers a stored model that is no longer observed and only Default model when no list exists", async () => {
    agents.runs = [];
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    const trigger = dialog.getByRole("combobox", { name: "Run on" });
    expect(trigger).toHaveTextContent("Claude Code · model-a");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Not set", "model-a, Claude Code", "Default model, Claude Code", "Default model, Codex",
    ]);
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

  it("maps the Run on, Effort, Done when and Task panel contract lines to tokens", () => {
    expect(rule(".taskRunRow")).toMatch(/align-items: flex-end;[^}]*gap: var\(--space-4\)/);
    expect(rule(".taskRunOn")).toMatch(/flex: 1 1 220px/);
    expect(styles).toMatch(/\.taskEffort > button \{ min-height: var\(--control-height\); \}/);
    expect(rule(".taskModelNotice")).toMatch(/border: 1px solid var\(--command-amber\)[^}]*border-radius: var\(--control-radius\)[^}]*background: var\(--color-amber-soft\)/);
    expect(rule(".taskChecks")).toMatch(/repeat\(2, minmax\(0, 1fr\)\);[^}]*column-gap: var\(--space-4\)/);
    expect(rule(".taskCheckRow")).toMatch(/gap: var\(--space-2\);[^}]*min-height: 44px;[^}]*border-top: 1px solid var\(--command-line\)/);
    expect(rule('.taskCheckRow input[type="checkbox"]')).toMatch(/width: 16px; height: 16px;[^}]*accent-color: var\(--command-brand\)/);
    expect(rule(".taskOwnInput")).toMatch(/min-height: var\(--control-compact\);[^}]*border: 1px solid var\(--command-line-strong\)[^}]*border-radius: var\(--control-radius\)/);
    expect(rule(".taskCheckResult.isPassed")).toMatch(/var\(--command-green\)/);
    expect(rule(".taskCheckResult.isFailed")).toMatch(/var\(--command-error\)/);
    expect(rule(".taskPanelHeading")).toMatch(/650 var\(--text-heading\)\/1\.35 var\(--font-ui\)/);
    expect(styles).toMatch(/\.taskPanelFooter \.commandQuietAction \{ min-height: var\(--control-height\); \}/);
  });
});
