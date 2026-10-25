import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArilSettings, TaskBoard } from "../../shared/task-contract";
import { BOARD_RUNNING } from "../../app/components/design-system/DesignSystemTaskSampleData";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";

const { refresh, access } = vi.hoisted(() => ({ refresh: vi.fn(async () => {}), access: { mode: "local" } }));
vi.mock("../../app/tasks-store", () => ({ useTasks: () => ({ refresh }) }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => access, clientAccessMode: () => access.mode }));
const defaults = (): ArilSettings => ({
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false },
  limits: { hours: null, starts: null, concurrent: null, sendBacks: null, allowancePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false,
});
let board: TaskBoard;
const taskAction = vi.fn<(repository: string, action: string, payload: unknown) => Promise<{ ok: boolean }>>();
const setBridge = (value: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = value; };
beforeEach(() => {
  board = { ...BOARD_RUNNING, aril: { settings: defaults(), memory: [] } };
  access.mode = "local"; setBridge({ taskAction }); taskAction.mockResolvedValue({ ok: true });
});
afterEach(() => { setBridge(undefined); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const action = () => screen.getByRole("button", { name: "Aril settings" });
const save = () => screen.getByRole("button", { name: "Save" });
async function open() {
  const view = render(<TaskBoardView board={board} readTaskLog={async () => ({ ok: false })} />);
  await userEvent.click(action());
  return view;
}
async function choose(label: string, option: string) {
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("combobox", { name: label }));
  await userEvent.click(screen.getByRole("option", { name: option }));
}

describe("Aril settings panel", () => {
  it("opens the Queue settings frame before Log, renders defaults and returns focus on Cancel and Escape", async () => {
    await open();
    expect(action()).toHaveClass("commandQuietAction", "taskQueueSettingsAction");
    expect(action()).toHaveAttribute("aria-haspopup", "dialog");
    expect(action().nextElementSibling).toHaveTextContent("Log");
    const dialog = screen.getByRole("dialog", { name: "Aril settings" });
    expect(dialog).toHaveClass("taskQueueSettingsScrim");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(within(dialog).getAllByRole("switch")).toHaveLength(7);
    for (const control of within(dialog).getAllByRole("switch")) expect(control).not.toBeChecked();
    for (const label of ["Hours", "Starts", "Concurrent sessions", "Send-backs per task", "Provider allowance %"]) {
      expect(screen.getByRole("combobox", { name: label })).toHaveTextContent("Not settled: Aril will ask");
    }
    expect(screen.getByText("0 of 100")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(action()).toHaveFocus();
    await userEvent.click(action());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(action()).toHaveFocus();
  });

  it("saves only changed top-level fields, with complete nested values and an explicit unset limit", async () => {
    board.aril!.settings.limits.hours = 2;
    await open();
    await userEvent.click(screen.getByRole("switch", { name: "Start tasks" }));
    await choose("Hours", "Not settled: Aril will ask");
    await choose("Send-backs per task", "0");
    await userEvent.click(save());
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(board.repositoryId, "aril_settings_set", { settings: {
      actions: { ...defaults().actions, start: true }, limits: { ...defaults().limits, sendBacks: 0 },
    } }));
    expect(refresh).toHaveBeenCalled();
  });

  it.each([["Tag", "backend"], ["Text", "Fix imports"], ["Feature", ""], ["Tasks", ""]])("adds a %s rule", async (kind, input) => {
    await open(); await choose("Rule kind", kind);
    const value = kind === "Tasks" ? board.tasks[0].id : input;
    if (kind === "Feature") await choose("Feature", board.features[0].name);
    else fireEvent.change(screen.getByRole("textbox", { name: "Rule value" }), { target: { value } });
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getByRole("button", { name: `Remove ${kind} rule` })).toBeInTheDocument();
    await userEvent.click(save());
    const rule = { kind: kind.toLowerCase(), value: kind === "Feature" ? board.features[0].id : kind === "Tasks" ? [value] : value };
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { workRules: [rule] } });
  });

  it("removes existing rules of every kind and validates task IDs and tags", async () => {
    board.aril!.settings.workRules = [{ kind: "tag", value: "backend" }, { kind: "text", value: "Fix imports" }, { kind: "feature", value: board.features[0].id }, { kind: "tasks", value: [board.tasks[0].id] }];
    await open();
    for (const kind of ["Tag", "Text", "Feature", "Tasks"]) await userEvent.click(screen.getByRole("button", { name: `Remove ${kind} rule` }));
    await choose("Rule kind", "Tasks");
    fireEvent.change(screen.getByRole("textbox", { name: "Rule value" }), { target: { value: "T-99999999" } });
    expect(screen.getByRole("button", { name: "Add rule" })).toBeDisabled();
    await choose("Rule kind", "Tag");
    fireEvent.change(screen.getByRole("textbox", { name: "Rule value" }), { target: { value: "image" } });
    expect(screen.getByRole("button", { name: "Add rule" })).toBeDisabled();
    await userEvent.click(save());
    expect(taskAction).toHaveBeenCalledWith(board.repositoryId, "aril_settings_set", { settings: { workRules: [] } });
  });

  it("validates and saves reviewer fields", async () => {
    await open(); await choose("Reviewer provider", "Codex");
    const model = screen.getByRole("textbox", { name: "Reviewer model" });
    fireEvent.change(model, { target: { value: "invalid model" } }); expect(save()).toBeDisabled();
    fireEvent.change(model, { target: { value: "gpt-5" } });
    await userEvent.click(screen.getByRole("switch", { name: "Use a different provider than the builder" }));
    await userEvent.click(save());
    expect(taskAction).toHaveBeenCalledWith(board.repositoryId, "aril_settings_set", { settings: { reviewer: { provider: "codex", model: "gpt-5", differentFromBuilder: true } } });
  });

  it("keeps a paired device read-only until allowed", async () => {
    access.mode = "lan"; setBridge(undefined); await open();
    expect(screen.queryByRole("switch")).toBeNull(); expect(within(screen.getByRole("dialog")).queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("Paired devices cannot change Aril settings and memory.")).toBeInTheDocument();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("keeps read-only settings current when the board refreshes", async () => {
    access.mode = "lan"; setBridge(undefined);
    const view = await open();
    board = { ...board, aril: { ...board.aril!, settings: { ...defaults(), limits: { ...defaults().limits, hours: 12 }, reviewer: { provider: "codex", model: "gpt-5", differentFromBuilder: true } } } };
    view.rerender(<TaskBoardView board={board} />);
    expect(within(screen.getByRole("dialog")).getByText("12")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("gpt-5")).toBeInTheDocument();
  });

  it("sends paired settings through POST without exposing or sending the permission switch", async () => {
    access.mode = "lan"; setBridge(undefined); board.aril!.settings.pairedDevices = true;
    const fetcher = vi.fn(async () => ({ json: async () => ({ ok: true }) })); vi.stubGlobal("fetch", fetcher);
    await open();
    expect(screen.queryByRole("switch", { name: "Allow paired devices to change Aril settings and memory" })).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "Merge on green" })); await userEvent.click(save());
    expect(fetcher).toHaveBeenCalledWith("/api/tasks/action", expect.objectContaining({ method: "POST", body: JSON.stringify({ repositoryId: board.repositoryId, action: "aril_settings_set", payload: { settings: { actions: { ...defaults().actions, merge: true } } } }) }));
  });

  it("offers exactly the phase 3a limit bounds", async () => {
    await open();
    for (const [label, min, max] of [["Hours", 1, 72], ["Starts", 1, 100], ["Concurrent sessions", 1, 10], ["Send-backs per task", 0, 10], ["Provider allowance %", 1, 100]] as const) {
      await userEvent.click(screen.getByRole("combobox", { name: label }));
      const options = screen.getAllByRole("option").map((option) => option.textContent);
      expect(options).toEqual(["Not settled: Aril will ask", ...Array.from({ length: max - min + 1 }, (_, index) => String(index + min))]);
      await userEvent.click(screen.getByRole("option", { name: String(max) }));
    }
  });

  it("updates memory and its counter from the refreshed board while retaining the settings draft", async () => {
    const view = await open();
    await userEvent.click(screen.getByRole("switch", { name: "Start tasks" }));
    refresh.mockImplementationOnce(async () => {
      board = { ...board, aril: { ...board.aril!, memory: [{ id: 1, text: "Run checks", createdAt: 1, updatedAt: 1 }] } };
      view.rerender(<TaskBoardView board={board} />);
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Add entry" }), { target: { value: "Run checks" } });
    await userEvent.click(screen.getByRole("button", { name: "Add entry" }));
    expect(await screen.findByText("1 of 100")).toBeInTheDocument();
    expect(screen.getByText("Run checks")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Start tasks" })).toBeChecked();
  });

  it("sends paired memory actions and removes editing immediately when permission is revoked", async () => {
    access.mode = "lan"; setBridge(undefined); board.aril!.settings.pairedDevices = true;
    board.aril!.memory = [{ id: 1, text: "Existing habit", createdAt: 1, updatedAt: 1 }];
    const fetcher = vi.fn(async () => ({ json: async () => ({ ok: true }) })); vi.stubGlobal("fetch", fetcher);
    const view = await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Add entry" }), { target: { value: "New habit" } });
    await userEvent.click(screen.getByRole("button", { name: "Add entry" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit entry" }), { target: { value: "Edited habit" } });
    await userEvent.click(screen.getByRole("button", { name: "Save entry" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    expect(fetcher.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string))).toEqual([
      { repositoryId: board.repositoryId, action: "aril_memory_add", payload: { text: "New habit" } },
      { repositoryId: board.repositoryId, action: "aril_memory_update", payload: { id: 1, text: "Edited habit" } },
      { repositoryId: board.repositoryId, action: "aril_memory_remove", payload: { id: 1 } },
    ]);
    board = { ...board, aril: { ...board.aril!, settings: { ...board.aril!.settings, pairedDevices: false } } };
    view.rerender(<TaskBoardView board={board} />);
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull(); expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("adds, edits and confirms deletion of memory inside the panel", async () => {
    board.aril!.memory = [{ id: 1, text: "Use small commits", createdAt: 1, updatedAt: 1 }];
    await open(); expect(screen.getByText("1 of 100")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Add entry" }), { target: { value: "Run checks" } });
    await userEvent.click(screen.getByRole("button", { name: "Add entry" }));
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_memory_add", { text: "Run checks" });
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const edit = screen.getByRole("textbox", { name: "Edit entry" }); expect(edit).toHaveAttribute("maxlength", "300");
    fireEvent.change(edit, { target: { value: "Use focused commits" } });
    await userEvent.click(screen.getByRole("button", { name: "Save entry" }));
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_memory_update", { id: 1, text: "Use focused commits" });
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(taskAction).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "Keep entry" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_memory_remove", { id: 1 });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("renders memory oldest first and disables adding at the limit", async () => {
    board.aril!.memory = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, text: `Entry ${index + 1}`, createdAt: index, updatedAt: 100 - index }));
    await open(); expect(screen.getByText("100 of 100")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add entry" })).toBeDisabled();
    expect(screen.getByText("Entry 1").compareDocumentPosition(screen.getByText("Entry 100")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps drafts on settings and memory failures, showing only fixed error text", async () => {
    taskAction.mockRejectedValue(new Error("private failure")); await open();
    await userEvent.click(screen.getByRole("switch", { name: "Start tasks" })); await userEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Aril settings could not be saved. Try again.");
    expect(screen.getByRole("switch", { name: "Start tasks" })).toBeChecked();
    fireEvent.change(screen.getByRole("textbox", { name: "Add entry" }), { target: { value: "Keep this draft" } });
    await userEvent.click(screen.getByRole("button", { name: "Add entry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Memory could not be saved. Try again.");
    expect(screen.getByRole("textbox", { name: "Add entry" })).toHaveValue("Keep this draft");
    expect(screen.queryByText("private failure")).toBeNull();
  });
});
