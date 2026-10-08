import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import { TASK_BOUNDS, createEmptyTaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
const inventory = vi.hoisted(() => ({ snapshot: { revision: 1, readiness: "ready", repositories: [] } as RepositoryInventorySnapshot }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory.snapshot, loading: false, connected: true, refresh: vi.fn() }) }));

import { TasksTab } from "../../app/components/tasks/TasksTab";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});

function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

beforeEach(() => {
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
    // Run on, Done when, Feature and Step are part 4.
    expect(screen.queryByText(/Run on|Done when|Feature|Step in feature/)).not.toBeInTheDocument();
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
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Write the guide" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(newTaskButton()).toHaveFocus();
  });

  it("sends the text without leading or trailing whitespace", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "  Write the guide  ");
    await user.click(createButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "Write the guide" }));
  });

  it("keeps the panel open with an empty, focused field after Create and add another", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.type(await openPanel(user), "First task");
    await user.click(anotherButton());
    await waitFor(() => expect(field().value).toBe(""));
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", { text: "First task" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(panel()).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(createButton()).toBeDisabled();
    expect(anotherButton()).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(field(), "Second task");
    await user.click(anotherButton());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "create", { text: "Second task" });
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
    const source = ["NewTaskPanel.tsx", "TasksTab.tsx", "task-desktop.ts"].map((file) => readFileSync(join(process.cwd(), "app", "components", "tasks", file), "utf8")).join("\n");
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage/);
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
