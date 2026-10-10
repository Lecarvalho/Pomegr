import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import { TASK_BOUNDS, createEmptyTaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
const agents = vi.hoisted(() => ({ runs: [] as Array<{ source: string; model: string | null }> }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: agents.runs }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory = vi.hoisted(() => ({ snapshot: { revision: 1, readiness: "ready", repositories: [] } as RepositoryInventorySnapshot }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory.snapshot, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const DEFAULT_DONE_WHEN = { checks: ["pr_open", "tree_clean"], own: null };

function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

beforeEach(() => {
  agents.runs = [];
  inventory.snapshot = { revision: 1, readiness: "ready", repositories: [{
    id: repositoryId, name: "example", displayName: "Example project", sessionCount: 0, liveCount: 0, historyCount: 0, providerCount: 0, updatedAt: null, providers: [],
  }] };
  useTasks.mockReturnValue({ board: { ...createEmptyTaskBoard(repositoryId, "ready"), columns: [{ id: "col-1", name: "Backlog", position: 0 }] }, refresh });
  taskAction.mockResolvedValue({ ok: true });
  setBridge({ taskAction });
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const newTaskButton = () => screen.getByRole("button", { name: "New task" });
const panel = () => screen.queryByRole("dialog", { name: "New task" });
const field = () => screen.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement;
const createButton = () => screen.getByRole("button", { name: "Create task" });
const cancelButton = () => screen.getByRole("button", { name: "Cancel" });

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(newTaskButton());
  return field();
}

describe("without the desktop bridge", () => {
  it("draws no New task action and explains where tasks are created, on the first render", () => {
    setBridge(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.getByText("Tasks are created and edited in the Pomegr desktop app.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a bridge without taskAction as no bridge", () => {
    setBridge({ getDesktopState: vi.fn() });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.getByText("Tasks are created and edited in the Pomegr desktop app.")).toBeInTheDocument();
  });

  it("draws neither the action nor the note in the server pass, so nothing is shown and then removed", () => {
    expect(renderToString(<TaskBoardPane repositoryId={repositoryId} />)).not.toMatch(/New task|created and edited in the Pomegr desktop app/);
  });
});

describe("with the desktop bridge", () => {
  it("draws the quiet New task action in the first lane on the first render, with no header action and no explanation", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(newTaskButton()).toHaveClass("commandQuietAction", "taskColumnAdd");
    expect(newTaskButton()).not.toHaveClass("commandPrimaryAction");
    expect(newTaskButton()).toHaveAttribute("aria-haspopup", "dialog");
    expect(newTaskButton().closest(".taskColumn")).toHaveAttribute("data-column-id", "col-1");
    expect(document.querySelector(".commandPageHeader .commandPrimaryAction")).toBeNull();
    expect(screen.queryByText(/created and edited in the Pomegr desktop app/)).not.toBeInTheDocument();
    expect(panel()).not.toBeInTheDocument();
  });

  it("draws no New task action while the board is not ready, so there is nothing to open on a board that may not exist", () => {
    useTasks.mockReturnValue({ board: createEmptyTaskBoard(repositoryId, "unavailable"), refresh });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Tasks are unavailable.");
  });

  it("opens the modal with the Task field focused, its counter, the subtitle and the Cancel and Create task footer", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const textarea = await openPanel(user);
    const dialog = screen.getByRole("dialog", { name: "New task" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveAttribute("placeholder", "What should the session do?");
    expect(textarea).toHaveAttribute("maxlength", String(TASK_BOUNDS.textLength));
    expect(TASK_BOUNDS.textLength).toBe(4000);
    expect(textarea).toHaveAccessibleDescription("0 / 4,000");
    await user.type(textarea, "Hello");
    expect(textarea).toHaveAccessibleDescription("5 / 4,000");
    expect(screen.getByRole("heading", { level: 2, name: "New task" })).toBeInTheDocument();
    expect(dialog.querySelector(".taskModalSubtitle")).toHaveTextContent("Example project · in Backlog");
    expect(createButton()).toHaveClass("commandPrimaryAction");
    expect(cancelButton()).toHaveClass("commandQuietAction");
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("commandIconAction");
    expect(screen.queryByRole("button", { name: "Create and add another" })).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Goes to Backlog, not queued");
    expect(dialog).not.toHaveTextContent("The card shows this text until the session has a title.");
    expect(dialog).toHaveTextContent("Run on");
    expect(dialog).toHaveTextContent("Effort");
    expect(dialog).toHaveTextContent("Done when");
    expect(screen.getByRole("combobox", { name: "Feature" })).toHaveTextContent("No feature");
    expect(screen.getByRole("combobox", { name: "Step" })).toBeDisabled();
  });

  it("drops the repository from the subtitle when its name is unknown", async () => {
    inventory.snapshot = { revision: 1, readiness: "ready", repositories: [] };
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openPanel(user);
    expect(screen.getByRole("dialog", { name: "New task" }).querySelector(".taskModalSubtitle")).toHaveTextContent(/^in Backlog$/);
  });

  it("disables Create task while the text is empty or only whitespace", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const textarea = await openPanel(user);
    expect(createButton()).toBeDisabled();
    await user.type(textarea, "   ");
    expect(createButton()).toBeDisabled();
    await user.type(textarea, "Write the guide");
    expect(createButton()).toBeEnabled();
    await user.clear(textarea);
    expect(createButton()).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("creates the task once through the bridge, refreshes the board, closes, and returns focus to New task", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Write the guide");
    await user.click(createButton());
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Write the guide", doneWhen: DEFAULT_DONE_WHEN });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(newTaskButton()).toHaveFocus();
  });

  it("sends the text without leading or trailing whitespace", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "  Write the guide  ");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Write the guide", doneWhen: DEFAULT_DONE_WHEN }));
  });

  it("keeps the panel and the text when the board is full, with the fixed message", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "limit" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "One too many");
    await user.click(createButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("The board is full: it holds 500 tasks.");
    expect(panel()).toBeInTheDocument();
    expect(field().value).toBe("One too many");
    expect(field()).toHaveFocus();
    expect(field()).toHaveAccessibleDescription(/The board is full/);
    expect(refresh).not.toHaveBeenCalled();
    expect(createButton()).toBeEnabled();
  });

  it.each(["unavailable", "invalid", "not_found", "conflict", "unsupported"])("keeps the panel and the text on %s, with one generic message", async (error) => {
    taskAction.mockResolvedValue({ ok: false, error });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Keep this text");
    await user.click(createButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be saved.");
    expect(screen.getByRole("alert").textContent).not.toMatch(/full|500/);
    expect(panel()).toBeInTheDocument();
    expect(field().value).toBe("Keep this text");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("treats a rejected or malformed bridge answer as unavailable and clears the message on the next attempt", async () => {
    taskAction.mockRejectedValueOnce(new Error("ipc failed")).mockResolvedValueOnce({ nonsense: true } as unknown as Result).mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Retry me");
    await user.click(createButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be saved.");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be saved.");
    await user.click(createButton());
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(taskAction).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("allows one create at a time and disables Create task while it is in flight", async () => {
    let resolve!: (result: Result) => void;
    taskAction.mockReturnValue(new Promise<Result>((done) => { resolve = done; }));
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Slow task");
    await user.click(createButton());
    expect(createButton()).toBeDisabled();
    await user.click(createButton());
    expect(taskAction).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ok: true }); });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and returns focus to New task without creating anything", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Unsent text");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(newTaskButton()).toHaveFocus();
    expect(taskAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    // A reopened panel starts empty.
    expect((await openPanel(user)).value).toBe("");
  });

  it("closes with the Close control and returns focus to New task", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openPanel(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(newTaskButton()).toHaveFocus();
  });

  it("leaves Escape to a control that already handled it", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const textarea = await openPanel(user);
    textarea.addEventListener("keydown", (event) => { if (event.key === "Escape") event.preventDefault(); });
    await user.keyboard("{Escape}");
    expect(panel()).toBeInTheDocument();
  });

  it("never posts from the browser: the bridge is the only mutation path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Through the bridge");
    await user.click(createButton());
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
    const source = ["TaskModal.tsx", "TaskModalNew.tsx", "TaskModalEdit.tsx", "TaskModalFrame.tsx", "TaskFields.tsx", "FeatureFields.tsx", "TaskCard.tsx", "TaskBoardPane.tsx", "task-desktop.ts", "task-fields.ts", "task-panel-hooks.ts", "use-task-draft.ts"].map((file) => readFileSync(join(process.cwd(), "app", "components", "tasks", file), "utf8")).join("\n");
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage/);
  });
});

describe("Run on, Effort and Done when", () => {
  const runOn = () => screen.getByRole("combobox", { name: "Run on" });
  const effort = (name: string) => screen.getByRole("button", { name });
  const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
  const own = () => screen.getByRole("textbox", { name: "Own condition" }) as HTMLInputElement;
  const optionLabels = () => {
    fireEvent.click(runOn());
    const labels = screen.getAllByRole("option").map((option) => option.textContent);
    fireEvent.click(runOn());
    return labels;
  };

  it("starts with nothing in Run on and Effort and the two default checks", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openPanel(user);
    expect(runOn()).toHaveTextContent("Not set");
    for (const name of ["Low", "Medium", "High", "Xhigh"]) expect(effort(name)).toHaveAttribute("aria-pressed", "false");
    expect(checkbox("PR open")).toBeChecked();
    expect(checkbox("Tree clean")).toBeChecked();
    for (const name of ["Commit on branch", "PR merged", "CI passed"]) expect(checkbox(name)).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Use your own condition" })).not.toBeInTheDocument();
    expect(own()).toHaveValue("");
    expect(own()).toHaveAttribute("maxlength", String(TASK_BOUNDS.ownConditionLength));
    expect(own()).toHaveAttribute("placeholder", "Own condition, judged by the agent (optional)");
    expect(screen.getByText("Pomegr verifies the listed conditions. Your own condition is judged by the agent.")).toBeInTheDocument();
  });

  it("groups the options by provider from the served model list and always offers Default model", async () => {
    agents.runs = [
      { source: "Claude Code", model: "model-b" }, { source: "Claude Code", model: "model-a" }, { source: "Claude Code", model: "model-a" },
      { source: "Codex", model: "observed-only" }, { source: "Codex", model: null }, { source: "Claude Code", model: "C:\\not\\a\\model" },
    ];
    useTasks.mockReturnValue({ board: { ...createEmptyTaskBoard(repositoryId, "ready"), columns: [{ id: "col-1", name: "Backlog", position: 0 }], runModels: { codex: [{ id: "model-c", label: null }] } }, refresh });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openPanel(user);
    expect(optionLabels()).toEqual([
      "Not set", "model-a, Claude Code", "model-b, Claude Code", "Default model, Claude Code", "model-c, Codex", "Default model, Codex",
    ]);
  });

  it("offers only Default model when no model list is available", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openPanel(user);
    expect(optionLabels()).toEqual(["Not set", "Default model, Claude Code", "Default model, Codex"]);
  });

  it("sends the chosen run, effort, checks and own condition", async () => {
    useTasks.mockReturnValue({ board: { ...createEmptyTaskBoard(repositoryId, "ready"), columns: [{ id: "col-1", name: "Backlog", position: 0 }], runModels: { codex: [{ id: "model-c", label: null }] } }, refresh });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Ship it");
    chooseCommandOption(runOn(), "codex:model:model-c");
    expect(runOn()).toHaveTextContent("Codex · model-c");
    await user.click(effort("Xhigh"));
    expect(effort("Xhigh")).toHaveAttribute("aria-pressed", "true");
    await user.click(checkbox("Tree clean"));
    await user.click(checkbox("CI passed"));
    await user.click(checkbox("PR merged"));
    await user.type(own(), "  The migration is reversible  ");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", {
      text: "Ship it",
      run: { provider: "codex", model: "model-c", effort: "xhigh" },
      doneWhen: { checks: ["pr_open", "pr_merged", "ci_passed"], own: "The migration is reversible" },
    });
  });

  it("sends a provider with its default model as a null model", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Use the default");
    chooseCommandOption(runOn(), "claude:default");
    expect(runOn()).toHaveTextContent("Claude Code · Default model");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Use the default", run: { provider: "claude", model: null, effort: null }, doneWhen: DEFAULT_DONE_WHEN });
  });

  it("clears Effort by pressing the pressed segment and Run on by choosing Not set", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Optional fields");
    await user.click(effort("High"));
    expect(effort("High")).toHaveAttribute("aria-pressed", "true");
    await user.click(effort("High"));
    expect(effort("High")).toHaveAttribute("aria-pressed", "false");
    chooseCommandOption(runOn(), "codex:default");
    chooseCommandOption(runOn(), "");
    expect(runOn()).toHaveTextContent("Not set");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Optional fields", doneWhen: DEFAULT_DONE_WHEN });
  });

  it("keeps Effort alone as a valid run, without a provider or model", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Effort only");
    await user.click(effort("Low"));
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Effort only", run: { provider: null, model: null, effort: "low" }, doneWhen: DEFAULT_DONE_WHEN });
  });

  it("omits doneWhen when nothing is checked", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "No conditions");
    await user.click(checkbox("PR open"));
    await user.click(checkbox("Tree clean"));
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "No conditions" });
  });

  it("sends no own condition while the input is blank", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Blank own condition");
    await user.type(own(), "   ");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "create", { text: "Blank own condition", doneWhen: DEFAULT_DONE_WHEN });
  });

  it("sends the own condition alone when no check is ticked", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Own only");
    await user.click(checkbox("PR open"));
    await user.click(checkbox("Tree clean"));
    await user.type(own(), "Reads well");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Own only", doneWhen: { checks: [], own: "Reads well" } });
  });
});

describe("the task modal as a dialog (mode new)", () => {
  it("moves focus into the dialog on open, to the Task field", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(newTaskButton());
    expect(screen.getByRole("dialog", { name: "New task" }).contains(document.activeElement)).toBe(true);
    expect(field()).toHaveFocus();
  });

  it("is opened as a modal dialog, which keeps the page behind inert", async () => {
    const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, writable: true, value: showModal });
    try {
      const user = userEvent.setup();
      render(<TaskBoardPane repositoryId={repositoryId} />);
      await user.click(newTaskButton());
      expect(showModal).toHaveBeenCalledTimes(1);
      const dialog = screen.getByRole("dialog", { name: "New task" }) as HTMLDialogElement;
      expect(dialog.tagName).toBe("DIALOG");
      expect(dialog.open).toBe(true);
    } finally {
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    }
  });

  it("closes on Escape from a control and returns focus to the opener, writing nothing", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Draft text");
    await user.click(screen.getByRole("checkbox", { name: "CI passed" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(newTaskButton()).toHaveFocus();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("closes on Cancel and on Close, writing nothing, and returns focus to the opener", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Draft text");
    await user.click(cancelButton());
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(newTaskButton()).toHaveFocus();
    await openPanel(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(newTaskButton()).toHaveFocus();
    expect(taskAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not close on the Escape that an open Run on list handles, and the next Escape closes", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openPanel(user);
    await user.click(screen.getByRole("combobox", { name: "Run on" }));
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    expect(panel()).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openPanel(user);
    const dialog = screen.getByRole("dialog", { name: "New task" });
    // jsdom answers a selector list grouped by selector; sort into document order like a browser does.
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const first = items[0];
    const last = items[items.length - 1];
    expect(first).toBe(screen.getByRole("button", { name: "Close" }));
    expect(last).toBe(cancelButton());
    // Shift+Tab from the first control wraps inside. The forward wrap at the last control is the browser's native
    // modal trap: the frame's own wrap reads querySelectorAll order, which jsdom does not give for a selector list.
    first.focus();
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(first);
    first.focus();
    for (let step = 0; step < items.length - 1; step += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(last).toBeInTheDocument();
  });

  it("does not close, and keeps the text, when the scrim is clicked", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Do not lose this");
    const scrim = screen.getByRole("dialog", { name: "New task" });
    await user.click(scrim);
    fireEvent.click(scrim);
    fireEvent.mouseDown(scrim);
    expect(panel()).toBeInTheDocument();
    expect(field().value).toBe("Do not lose this");
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("shows only its own footer: Cancel and Create task, with no Save, Delete, queue or start action", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openPanel(user);
    const footer = screen.getByRole("dialog", { name: "New task" }).querySelector(".taskModalFooter")!;
    expect([...footer.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Cancel", "Create task"]);
    for (const name of ["Save", "Delete task", "Start session", "Add to queue"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  it("refreshes the board even when the dialog was closed while the create was in flight", async () => {
    let resolve!: (result: Result) => void;
    taskAction.mockReturnValue(new Promise<Result>((done) => { resolve = done; }));
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Slow and closed");
    await user.click(createButton());
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    await act(async () => { resolve({ ok: true }); });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});

describe("task modal styles (mode new)", () => {
  const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
  const rule = (selector: string) => {
    const match = styles.match(new RegExp(`(?:^|\\n)${selector.replace(/[.\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    expect(match, `${selector} rule`).not.toBeNull();
    return match![1];
  };

  it("maps the task modal contract lines to tokens", () => {
    expect(rule(".taskModalScrim")).toMatch(/background: color-mix\(in srgb, var\(--color-text\) 40%, transparent\)/);
    expect(rule(".taskModal")).toMatch(/max-width: 640px[^}]*border: 1px solid var\(--command-line\)[^}]*border-radius: var\(--panel-radius\)[^}]*background: var\(--command-panel\)/);
    expect(rule(".taskModalHeader")).toMatch(/gap: var\(--space-3\);[^}]*border-bottom: 1px solid var\(--command-line\)/);
    expect(rule(".taskModalTitleGroup h2")).toMatch(/650 var\(--text-heading\)\/1\.35 var\(--font-ui\)/);
    expect(rule(".taskModalSubtitle")).toMatch(/color: var\(--command-muted\)[^}]*400 var\(--text-xs\)/);
    expect(rule(".taskModalBody")).toMatch(/gap: var\(--space-4\); padding: var\(--space-6\)/);
    expect(rule(".taskModalFooter")).toMatch(/gap: var\(--space-2\)[^}]*padding: var\(--space-3\) var\(--space-6\)[^}]*border-top: 1px solid var\(--command-line\)/);
    expect(rule(".newTaskField")).toMatch(/gap: var\(--space-2\)/);
    expect(rule(".newTaskField label")).toMatch(/500 var\(--text-xs\)/);
    expect(rule(".newTaskField textarea")).toMatch(/min-height: 150px[^}]*border: 1px solid var\(--command-line-strong\)[^}]*border-radius: var\(--control-radius\)[^}]*resize: vertical/);
    expect(rule(".taskTextCounter")).toMatch(/align-self: flex-end[^}]*var\(--font-data\)/);
    expect(styles).toMatch(/@media \(max-width: 760px\)\s*\{[^]*\.taskModal \{[^}]*max-width: none/);
  });

  it("leaves no drawer rule behind", () => {
    expect(styles).not.toMatch(/\.newTaskPanel|\.taskPanel/);
  });
});
