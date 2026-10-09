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

import { TasksTab } from "../../app/components/tasks/TasksTab";

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
const anotherButton = () => screen.getByRole("button", { name: "Create and add another" });

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(newTaskButton());
  return field();
}

describe("without the desktop bridge", () => {
  it("draws no New task action and explains where tasks are created, on the first render", () => {
    setBridge(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.getByText("Tasks are created and edited in the Pomegr desktop app.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a bridge without taskAction as no bridge", () => {
    setBridge({ getDesktopState: vi.fn() });
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.getByText("Tasks are created and edited in the Pomegr desktop app.")).toBeInTheDocument();
  });

  it("draws neither the action nor the note in the server pass, so nothing is shown and then removed", () => {
    expect(renderToString(<TasksTab repositoryId={repositoryId} />)).not.toMatch(/New task|created and edited in the Pomegr desktop app/);
  });
});

describe("with the desktop bridge", () => {
  it("draws the New task primary action on the first render and no explanation", () => {
    render(<TasksTab repositoryId={repositoryId} />);
    expect(newTaskButton()).toHaveClass("commandPrimaryAction");
    expect(screen.queryByText(/created and edited in the Pomegr desktop app/)).not.toBeInTheDocument();
    expect(panel()).not.toBeInTheDocument();
  });

  it("opens the panel with the Task field focused, its helper, and the Backlog note", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const textarea = await openPanel(user);
    const dialog = screen.getByRole("dialog", { name: "New task" });
    expect(dialog).toBeInTheDocument();
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveAttribute("placeholder", "What should the session do?");
    expect(textarea).toHaveAttribute("rows", "5");
    expect(textarea).toHaveAttribute("maxlength", String(TASK_BOUNDS.textLength));
    expect(TASK_BOUNDS.textLength).toBe(4000);
    expect(textarea).toHaveAccessibleDescription("The card shows this text until the session has a title.");
    expect(screen.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Example project");
    expect(dialog).toHaveTextContent("Goes to Backlog, not queued");
    expect(createButton()).toHaveClass("commandPrimaryAction");
    expect(anotherButton()).toHaveClass("commandSecondaryAction");
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("commandIconAction");
    expect(dialog).toHaveTextContent("Run on");
    expect(dialog).toHaveTextContent("Effort");
    expect(dialog).toHaveTextContent("Done when");
    expect(screen.getByRole("combobox", { name: "Feature" })).toHaveTextContent("No feature");
    expect(screen.getByRole("combobox", { name: "Step in feature" })).toBeDisabled();
  });

  it("disables both create buttons while the text is empty or only whitespace", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const textarea = await openPanel(user);
    expect(createButton()).toBeDisabled();
    expect(anotherButton()).toBeDisabled();
    await user.type(textarea, "   ");
    expect(createButton()).toBeDisabled();
    expect(anotherButton()).toBeDisabled();
    await user.type(textarea, "Write the guide");
    expect(createButton()).toBeEnabled();
    expect(anotherButton()).toBeEnabled();
    await user.clear(textarea);
    expect(createButton()).toBeDisabled();
    expect(anotherButton()).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("creates the task once through the bridge, refreshes the board, closes, and returns focus to New task", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "  Write the guide  ");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Write the guide", doneWhen: DEFAULT_DONE_WHEN }));
  });

  it("keeps the panel open with an empty, focused field after Create and add another", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "First task");
    await user.click(anotherButton());
    await waitFor(() => expect(field().value).toBe(""));
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "First task", doneWhen: DEFAULT_DONE_WHEN });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(panel()).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(createButton()).toBeDisabled();
    expect(anotherButton()).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(field(), "Second task");
    await user.click(anotherButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "create", { text: "Second task", doneWhen: DEFAULT_DONE_WHEN });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps the panel and the text when the board is full, with the fixed message", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "limit" });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "One too many");
    await user.click(createButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("The board is full: it holds 500 tasks.");
    expect(panel()).toBeInTheDocument();
    expect(field().value).toBe("One too many");
    expect(field()).toHaveFocus();
    expect(field()).toHaveAccessibleDescription(/The board is full/);
    expect(refresh).not.toHaveBeenCalled();
    expect(createButton()).toBeEnabled();
    expect(anotherButton()).toBeEnabled();
  });

  it.each(["unavailable", "invalid", "not_found", "conflict", "unsupported"])("keeps the panel and the text on %s, with one generic message", async (error) => {
    taskAction.mockResolvedValue({ ok: false, error });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Keep this text");
    await user.click(anotherButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be saved.");
    expect(screen.getByRole("alert").textContent).not.toMatch(/full|500/);
    expect(panel()).toBeInTheDocument();
    expect(field().value).toBe("Keep this text");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("treats a rejected or malformed bridge answer as unavailable and clears the message on the next attempt", async () => {
    taskAction.mockRejectedValueOnce(new Error("ipc failed")).mockResolvedValueOnce({ nonsense: true } as unknown as Result).mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
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

  it("allows one create at a time and disables both buttons while it is in flight", async () => {
    let resolve!: (result: Result) => void;
    taskAction.mockReturnValue(new Promise<Result>((done) => { resolve = done; }));
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Slow task");
    await user.click(createButton());
    expect(createButton()).toBeDisabled();
    expect(anotherButton()).toBeDisabled();
    await user.click(createButton());
    await user.click(anotherButton());
    expect(taskAction).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ok: true }); });
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and returns focus to New task without creating anything", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
    await openPanel(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(newTaskButton()).toHaveFocus();
  });

  it("leaves Escape to a control that already handled it", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const textarea = await openPanel(user);
    textarea.addEventListener("keydown", (event) => { if (event.key === "Escape") event.preventDefault(); });
    await user.keyboard("{Escape}");
    expect(panel()).toBeInTheDocument();
  });

  it("never posts from the browser: the bridge is the only mutation path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Through the bridge");
    await user.click(createButton());
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
    const source = ["NewTaskPanel.tsx", "TaskPanel.tsx", "TaskFields.tsx", "TaskCard.tsx", "TasksTab.tsx", "task-desktop.ts", "task-fields.ts", "task-panel-hooks.ts"].map((file) => readFileSync(join(process.cwd(), "app", "components", "tasks", file), "utf8")).join("\n");
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage/);
  });
});

describe("Run on, Effort and Done when", () => {
  const runOn = () => screen.getByRole("combobox", { name: "Run on" });
  const effort = (name: string) => screen.getByRole("button", { name });
  const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
  const own = () => screen.getByRole("textbox", { name: "Your own condition, judged by the agent" }) as HTMLInputElement;
  const optionLabels = () => {
    fireEvent.click(runOn());
    const labels = screen.getAllByRole("option").map((option) => option.textContent);
    fireEvent.click(runOn());
    return labels;
  };

  it("starts with nothing in Run on and Effort and the two default checks", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await openPanel(user);
    expect(runOn()).toHaveTextContent("Not set");
    for (const name of ["Low", "Medium", "High", "Xhigh"]) expect(effort(name)).toHaveAttribute("aria-pressed", "false");
    expect(checkbox("Pull request open")).toBeChecked();
    expect(checkbox("Working tree clean")).toBeChecked();
    for (const name of ["Commit on task branch", "Pull request merged", "CI passed", "Use your own condition"]) expect(checkbox(name)).not.toBeChecked();
    expect(own()).toHaveAttribute("maxlength", String(TASK_BOUNDS.ownConditionLength));
    expect(own()).toHaveAttribute("placeholder", "Your own condition");
    expect(screen.getByText("Pomegr verifies the listed conditions. Your own condition is judged by the agent.")).toBeInTheDocument();
  });

  it("groups the options by provider from the served model list and always offers Default model", async () => {
    agents.runs = [
      { source: "Claude Code", model: "model-b" }, { source: "Claude Code", model: "model-a" }, { source: "Claude Code", model: "model-a" },
      { source: "Codex", model: "model-c" }, { source: "Codex", model: null }, { source: "Claude Code", model: "C:\\not\\a\\model" },
    ];
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await openPanel(user);
    expect(optionLabels()).toEqual([
      "Not set", "model-a, Claude Code", "model-b, Claude Code", "Default model, Claude Code", "model-c, Codex", "Default model, Codex",
    ]);
  });

  it("offers only Default model when no model list is available", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await openPanel(user);
    expect(optionLabels()).toEqual(["Not set", "Default model, Claude Code", "Default model, Codex"]);
  });

  it("sends the chosen run, effort, checks and own condition", async () => {
    agents.runs = [{ source: "Codex", model: "model-c" }];
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Ship it");
    chooseCommandOption(runOn(), "codex:model:model-c");
    expect(runOn()).toHaveTextContent("Codex · model-c");
    await user.click(effort("Xhigh"));
    expect(effort("Xhigh")).toHaveAttribute("aria-pressed", "true");
    await user.click(checkbox("Working tree clean"));
    await user.click(checkbox("CI passed"));
    await user.click(checkbox("Pull request merged"));
    await user.click(checkbox("Use your own condition"));
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
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Use the default");
    chooseCommandOption(runOn(), "claude:default");
    expect(runOn()).toHaveTextContent("Claude Code · Default model");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Use the default", run: { provider: "claude", model: null, effort: null }, doneWhen: DEFAULT_DONE_WHEN });
  });

  it("clears Effort by pressing the pressed segment and Run on by choosing Not set", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Effort only");
    await user.click(effort("Low"));
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Effort only", run: { provider: null, model: null, effort: "low" }, doneWhen: DEFAULT_DONE_WHEN });
  });

  it("omits doneWhen when nothing is checked", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "No conditions");
    await user.click(checkbox("Pull request open"));
    await user.click(checkbox("Working tree clean"));
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "No conditions" });
  });

  it("sends the own condition only while its checkbox is checked and its text is not blank", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "Text without the checkbox");
    await user.type(own(), "Looks right");
    await user.click(anotherButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "create", { text: "Text without the checkbox", doneWhen: DEFAULT_DONE_WHEN });
    // The checkbox with only whitespace in the field.
    await user.type(field(), "Checkbox without text");
    await user.clear(own());
    await user.type(own(), "   ");
    await user.click(checkbox("Use your own condition"));
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "create", { text: "Checkbox without text", doneWhen: DEFAULT_DONE_WHEN });
  });
});

describe("new task panel styles", () => {
  const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
  const rule = (selector: string) => {
    const match = styles.match(new RegExp(`(?:^|\\n)${selector.replace(/[.\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    expect(match, `${selector} rule`).not.toBeNull();
    return match![1];
  };

  it("maps the NewTask contract lines to tokens", () => {
    expect(rule(".newTaskPanel")).toMatch(/width: min\(640px, 100%\)[^}]*border-left: 1px solid var\(--command-line\)[^}]*background: var\(--command-panel\)/);
    expect(rule(".newTaskPanelHeader")).toMatch(/gap: var\(--space-3\);[^}]*padding: var\(--space-1\) var\(--space-3\) var\(--space-1\) var\(--space-6\);[^}]*border-bottom: 1px solid var\(--command-line\)/);
    expect(rule(".newTaskPanelHeader h2")).toMatch(/650 var\(--text-heading\)\/1\.35 var\(--font-ui\)/);
    expect(rule(".newTaskPanelRepository")).toMatch(/color: var\(--command-muted\)[^}]*400 var\(--text-xs\)/);
    expect(rule(".newTaskPanelBody")).toMatch(/padding: var\(--space-6\)[^}]*gap: var\(--space-6\)/);
    expect(rule(".newTaskField")).toMatch(/gap: var\(--space-1\)/);
    expect(rule(".newTaskField label")).toMatch(/500 var\(--text-xs\)/);
    expect(rule(".newTaskField textarea")).toMatch(/padding: var\(--space-2\)[^}]*border: 1px solid var\(--command-line-strong\)[^}]*border-radius: var\(--control-radius\)[^}]*400 var\(--text-base\)\/1\.5 var\(--font-ui\)[^}]*resize: vertical/);
    expect(rule(".newTaskPanelFooter")).toMatch(/gap: var\(--space-2\)[^}]*padding: var\(--space-3\) var\(--space-6\)[^}]*border-top: 1px solid var\(--command-line\)[^}]*background: var\(--command-ground\)/);
    expect(styles).toMatch(/\.newTaskPanelFooter \.commandSecondaryAction\s*\{[^}]*min-height: var\(--control-height\)[^}]*border-color: var\(--command-line-strong\)[^}]*background: var\(--command-panel\)/);
    expect(styles).toMatch(/\.newTaskPanelHeader \.commandIconAction\s*\{[^}]*width: 44px; height: 44px/);
  });
});
