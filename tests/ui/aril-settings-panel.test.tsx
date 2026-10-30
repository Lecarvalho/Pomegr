import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArilGrant, ArilSettings, TaskBoard } from "../../shared/task-contract";
import { BOARD_RUNNING } from "../../app/components/design-system/DesignSystemTaskSampleData";
import { ArilSettingsSection } from "../../app/settings/ArilSettings";
import { timeOfDay } from "../../app/components/tasks/task-schedule";

const { refresh, access, current } = vi.hoisted(() => ({ refresh: vi.fn(async () => {}), access: { mode: "local" }, current: { board: null as unknown as TaskBoard, boards: {} as Record<string, TaskBoard>, names: null as Record<string, string> | null } }));
vi.mock("../../app/tasks-store", () => ({ useTasks: (id: string) => ({ board: current.boards[id] ?? current.board, refresh }) }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: { repositories: Object.entries(current.names ?? { [current.board.repositoryId]: "Pomegr" }).map(([id, displayName]) => ({ id, displayName })) }, loading: false }) }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => access, clientAccessMode: () => access.mode }));
const defaults = (): ArilSettings => ({
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true,
});

const ready = () => {
  const settings = board.aril!.settings;
  settings.actions.start = settings.actions.review = true;
  settings.limits = { ...settings.limits, hours: 2, tasks: 5, tasksAtATime: 2, usagePercent: 80 };
  settings.workRules = [{ kind: "tag", value: "backend" }];
};
const active = (): ArilGrant => ({ active: true, startedAt: Date.now(), endsAt: Date.now() + 7200000,
  startsUsed: 2, actions: { ...board.aril!.settings.actions }, limits: { ...board.aril!.settings.limits } });
const clockTime = (at: number) => timeOfDay(new Date(at).toISOString());
const start = () => screen.getByRole("button", { name: "Start grant" });

describe("Aril grant controls", () => {
  it.each(["hours", "tasks", "tasksAtATime", "usagePercent"] as const)("requires saved %s", async (key) => {
    ready(); board.aril!.settings.limits[key] = null; await open();
    expect(screen.getByText("Set Hours, Tasks, Tasks at a time, and Usage limit % first.")).toHaveClass("taskGatesCaption");
    expect(screen.queryByRole("button", { name: "Start grant" })).toBeNull();
  });
  it.each([false, true])("explains missing actions or rules (actions allowed: %s)", async (allowed) => {
    ready(); board.aril!.settings.actions.start = board.aril!.settings.actions.review = allowed;
    board.aril!.settings.workRules = []; await open();
    expect(screen.getByText(allowed ? "Add a work rule first: a grant starts nothing without one." : "Allow starting tasks, reviews, or merges first.")).toHaveClass("taskGatesCaption");
    expect(screen.queryByRole("button", { name: "Start grant" })).toBeNull();
  });
  it("requires a plan rule and task starting before granting plan task writing", async () => {
    ready();
    board.aril!.settings.actions.start = false;
    board.aril!.settings.actions.review = false;
    board.aril!.settings.actions.merge = false;
    board.aril!.settings.actions.writeTasks = true;
    board.aril!.settings.workRules = [{ kind: "tag", value: "backend" }];
    const view = await open();
    expect(screen.getByText("Add a plan rule first: a grant writes tasks only from named plans.")).toHaveClass("taskGatesCaption");
    expect(screen.queryByRole("button", { name: "Start grant" })).toBeNull();

    board.aril!.settings.workRules = [{ kind: "plan", value: "docs/plans/next.md" }];
    again(view);
    expect(screen.getByText("Allow starting tasks to use Write tasks from plans.")).toHaveClass("taskGatesCaption");
    expect(screen.queryByRole("button", { name: "Start grant" })).toBeNull();
  });
  it.each([[true, true, "tasks and reviews"], [true, false, "tasks"], [false, true, "reviews"]] as const)("summarizes saved allowed actions: %s %s", async (tasks, reviews, words) => {
    ready(); board.aril!.settings.actions.start = tasks; board.aril!.settings.actions.review = reviews; await open();
    expect(screen.getByText(`Starts ${words} that your work rules select, for 2 hours, at most 5 tasks, 2 at a time.`)).toBeInTheDocument();
    expect(start()).toHaveClass("commandPrimaryAction");
  });
  it("confirms inside the panel, cancels locally, and starts with an empty payload", async () => {
    ready(); vi.spyOn(Date, "now").mockReturnValue(new Date("2026-10-25T12:00:00Z").getTime()); await open();
    await userEvent.click(start()); expect(taskAction).not.toHaveBeenCalled();
    const confirm = screen.getByText(`Aril will start sessions without asking until ${clockTime(Date.now() + 7200000)} or until you stop it.`).closest("section")!;
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(panel()).toBeInTheDocument(); expect(screen.queryByText(/Aril will start sessions/)).toBeNull();
    await userEvent.click(start()); await userEvent.click(start());
    expect(taskAction).toHaveBeenCalledExactlyOnceWith(board.repositoryId, "grant_start", {});
    expect(refresh).toHaveBeenCalled(); vi.restoreAllMocks();
  });
  it("blocks unsaved edits and cancels a pending confirmation when settings change", async () => {
    ready(); await open(); await userEvent.click(start());
    await userEvent.click(screen.getByRole("switch", { name: "Start tasks" }));
    expect(screen.getByText("Save your changes first.")).toBeInTheDocument();
    expect(screen.queryByText(/Aril will start sessions/)).toBeNull(); expect(start()).toBeDisabled();
    await userEvent.click(start()); expect(taskAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Starts tasks and reviews that/)).toBeInTheDocument();
  });
  it("displays snapshotted counts, stops without confirmation, and updates from the board", async () => {
    ready(); const grant = active(); board.aril!.grant = grant; board.aril!.settings.limits.tasks = 10;
    const view = await open();
    const summary = screen.getByText(/Active until/);
    expect(summary).toHaveTextContent(`Active until ${clockTime(grant.endsAt)} · 2 of 5 tasks used`);
    expect(summary.querySelectorAll(".taskCapacityValue")).toHaveLength(3);
    expect(screen.getByText("Stopping takes effect at once. Running sessions continue.")).toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "Stop grant" }); expect(stop).toHaveClass("commandSecondaryAction");
    await userEvent.click(stop); expect(taskAction).toHaveBeenCalledExactlyOnceWith(board.repositoryId, "grant_stop", {});
    board = { ...board, aril: { ...board.aril!, grant: { ...grant, active: false, endedAt: Date.now(), endReason: "stopped" } } };
    again(view);
    expect(screen.queryByText(/Aril grant until/)).toBeNull(); expect(screen.queryByRole("button", { name: "Stop grant" })).toBeNull();
  });
  it.each([["stopped", "you stopped it"], ["expired", "its time ran out"], ["tasks_used", "it used all its tasks"], ["start_failed", "a start failed"], ["app_restart", "the app restarted"]] as const)("shows the last end reason %s", async (endReason, words) => {
    ready(); const endedAt = Date.now(); board.aril!.grant = { ...active(), active: false, endedAt, endReason }; await open();
    expect(screen.getByText(`Last grant ended ${clockTime(endedAt)}: ${words}`)).toHaveClass("taskGatesCaption");
    expect(screen.queryByText(/Aril grant until/)).toBeNull();
  });
  it("allows a paired stop even when settings are read-only", async () => {
    ready(); board.aril!.grant = active(); access.mode = "lan"; setBridge(undefined);
    const fetcher = vi.fn(async () => ({ json: async () => ({ ok: true }) })); vi.stubGlobal("fetch", fetcher);
    const view = await open(); await userEvent.click(screen.getByRole("button", { name: "Stop grant" }));
    expect(fetcher).toHaveBeenCalledWith("/api/tasks/action", expect.objectContaining({ body: JSON.stringify({ repositoryId: board.repositoryId, action: "grant_stop", payload: {} }) }));
    board = { ...board, aril: { ...board.aril!, grant: null } }; again(view);
    expect(screen.queryByRole("button", { name: "Start grant" })).toBeNull();
  });
  it("allows a paired start only with saved paired permission", async () => {
    ready(); board.aril!.settings.pairedDevices = true; access.mode = "lan"; setBridge(undefined);
    const fetcher = vi.fn(async () => ({ json: async () => ({ ok: true }) })); vi.stubGlobal("fetch", fetcher);
    await open(); await userEvent.click(start()); await userEvent.click(start());
    expect(fetcher).toHaveBeenCalledWith("/api/tasks/action", expect.objectContaining({ body: JSON.stringify({ repositoryId: board.repositoryId, action: "grant_start", payload: {} }) }));
  });
  it.each([["not_ready", "The grant is not ready. Check the saved limits, actions, and work rules."], ["conflict", "A grant is already active. Refresh the board."], ["private failure", "The grant could not be changed. Try again."]] as const)("shows a fixed line for %s", async (error, message) => {
    ready(); taskAction.mockResolvedValue({ ok: false, error } as { ok: boolean }); await open();
    await userEvent.click(start()); await userEvent.click(start());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("private failure")).toBeNull();
  });
});
let board: TaskBoard;
const taskAction = vi.fn<(repository: string, action: string, payload: unknown) => Promise<{ ok: boolean }>>();
const setBridge = (value: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = value; };
beforeEach(() => {
  board = { ...BOARD_RUNNING, aril: { settings: defaults(), memory: [] } };
  current.names = null; current.boards = {}; window.localStorage.clear();
  access.mode = "local"; setBridge({ taskAction }); taskAction.mockResolvedValue({ ok: true });
});
afterEach(() => { setBridge(undefined); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const panel = () => screen.getByRole("region", { name: "Aril" });
const save = () => screen.getByRole("button", { name: "Save" });
async function open() {
  current.board = board;
  return render(<ArilSettingsSection />);
}
// The board the store serves changed: the section reads it again.
const again = (view: ReturnType<typeof render>) => { current.board = board; view.rerender(<ArilSettingsSection />); };
async function choose(label: string, option: string) {
  await userEvent.click(within(panel()).getByRole("combobox", { name: label }));
  await userEvent.click(screen.getByRole("option", { name: option }));
}

describe("Aril settings panel", () => {
  it("offers a repository default and saves each supported merge method", async () => {
    const view = await open();
    expect(screen.getByRole("combobox", { name: "Merge method" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Merge method" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Repository default", "Squash", "Merge commit", "Rebase"]);
    await userEvent.click(screen.getByRole("option", { name: "Squash" }));
    await userEvent.click(save());
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { mergeMethod: "squash" } });
    for (const [label, method] of [["Merge commit", "merge"], ["Rebase", "rebase"]] as const) {
      board = { ...board, aril: { ...board.aril!, settings: { ...board.aril!.settings, mergeMethod: method === "merge" ? "squash" : "merge" } } };
      again(view);
      await choose("Merge method", label);
      await userEvent.click(save());
      expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { mergeMethod: method } });
    }
  });
  it("shows the follow-ups switch on by default and saves it off and on (T-183)", async () => {
    await open();
    const followUps = screen.getByRole("switch", { name: "Send follow-ups" });
    expect(followUps).toBeChecked();
    expect(screen.getByText("After grant actions, Aril adds a short line to this chat and sends a notification.")).toBeInTheDocument();
    await userEvent.click(followUps);
    await userEvent.click(save());
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { followUps: false } });
    board.aril!.settings.followUps = false;
    cleanup(); await open();
    expect(screen.getByRole("switch", { name: "Send follow-ups" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: "Send follow-ups" }));
    await userEvent.click(save());
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { followUps: true } });
  });
  it("offers merge mode and branch deletion under Actions and saves each choice", async () => {
    await open();
    const dialog = panel();
    expect(screen.getByRole("combobox", { name: "Merge mode" })).toHaveTextContent("Not set");
    expect(screen.getByRole("combobox", { name: "Delete branch after merge" })).toHaveTextContent("Repository default");
    const names = within(dialog).getAllByRole("combobox").map((box) => box.getAttribute("aria-label"));
    expect(names.slice(0, 3)).toEqual(["Merge method", "Merge mode", "Delete branch after merge"]);
    await userEvent.click(screen.getByRole("combobox", { name: "Merge mode" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Not set", "Merge when green", "Auto-merge when green"]);
    await userEvent.click(screen.getByRole("option", { name: "Merge when green" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Delete branch after merge" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Repository default", "Delete", "Keep"]);
    await userEvent.click(screen.getByRole("option", { name: "Keep" }));
    await userEvent.click(save());
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { mergeMode: "direct", deleteBranch: false } });
    for (const [label, key, value] of [["Auto-merge when green", "mergeMode", "auto"], ["Delete", "deleteBranch", true]] as const) {
      board.aril!.settings.mergeMode = key === "mergeMode" ? "direct" : "auto"; board.aril!.settings.deleteBranch = key === "deleteBranch" ? false : null;
      cleanup(); await open();
      await choose(key === "mergeMode" ? "Merge mode" : "Delete branch after merge", label);
      await userEvent.click(save());
      expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { [key]: value } });
    }
  });
  it("shows merge mode and branch deletion read-only without permission", async () => {
    board.aril!.settings.mergeMode = "auto"; board.aril!.settings.deleteBranch = true; access.mode = "lan"; setBridge(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: true }) })));
    await open();
    expect(screen.queryByRole("combobox", { name: "Merge mode" })).toBeNull();
    expect(screen.getByText("Auto-merge when green")).toHaveClass("taskGateReadOnly");
    expect(screen.getByText("Delete")).toHaveClass("taskGateReadOnly");
  });
  it("needs a saved merge mode before a grant may merge", async () => {
    ready(); board.aril!.settings.actions.merge = true;
    const view = await open();
    expect(screen.getByText("Choose how a grant merges first.")).toHaveClass("taskGatesCaption");
    expect(screen.queryByRole("button", { name: "Start grant" })).toBeNull();
    board.aril!.settings.mergeMode = "direct";
    again(view);
    expect(screen.queryByText("Choose how a grant merges first.")).toBeNull();
    expect(start()).toBeInTheDocument();
  });
  it("renders the section with its defaults, the repository, and Discard changes", async () => {
    await open();
    expect(within(panel()).getByRole("heading", { name: "Aril", level: 2 })).toBeInTheDocument();
    expect(within(panel()).getByText("Pomegr")).toHaveClass("commandMonoValue");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(panel().querySelector(".arilSettingsBody")).toHaveClass("taskQueueSettings");
    const body = panel();
    expect(within(body).getAllByRole("switch")).toHaveLength(9);
    for (const control of within(body).getAllByRole("switch")) expect((control as HTMLInputElement).checked).toBe(control === within(body).getByRole("switch", { name: "Send follow-ups" }));
    for (const label of ["Hours", "Tasks", "Tasks at a time", "Send-backs per task", "Usage limit %"]) {
      expect(screen.getByRole("combobox", { name: label })).toHaveTextContent("Not settled: Aril will ask");
    }
    expect(screen.getByText("0 of 100")).toBeInTheDocument();
    const discard = screen.getByRole("button", { name: "Discard changes" });
    expect(discard).toBeDisabled();
    expect(save()).toBeDisabled();
    await userEvent.click(screen.getByRole("switch", { name: "Send follow-ups" }));
    expect(discard).toBeEnabled(); expect(save()).toBeEnabled();
    await userEvent.click(discard);
    expect(screen.getByRole("switch", { name: "Send follow-ups" })).toBeChecked();
    expect(discard).toBeDisabled(); expect(save()).toBeDisabled();
  });
  it("is replaced by the saved settings after a save, so nothing stays unsaved, and keeps an edit the owner is making when the board moves", async () => {
    const view = await open();
    await userEvent.click(screen.getByRole("switch", { name: "Send follow-ups" }));
    await userEvent.type(screen.getByLabelText("Reviewer model"), "gpt-5");
    await userEvent.click(save());
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { followUps: false, reviewer: { provider: null, model: "gpt-5", differentFromBuilder: false } } });
    // The board is read again with the saved values: the draft is the saved settings and Save is idle.
    board = { ...board, aril: { ...board.aril!, settings: { ...board.aril!.settings, followUps: false, reviewer: { provider: null, model: "gpt-5", differentFromBuilder: false } } } };
    again(view);
    expect(screen.getByRole("switch", { name: "Send follow-ups" })).not.toBeChecked();
    expect(screen.getByLabelText("Reviewer model")).toHaveValue("gpt-5");
    expect(save()).toBeDisabled();
    // The owner starts another edit, and the saved settings change elsewhere (Aril applied a proposal): the touched field stays the owner's, the rest follows.
    await userEvent.click(screen.getByRole("switch", { name: "Send follow-ups" }));
    board = { ...board, aril: { ...board.aril!, settings: { ...board.aril!.settings, limits: { ...board.aril!.settings.limits, hours: 3 } } } };
    again(view);
    expect(screen.getByRole("combobox", { name: "Hours" })).toHaveTextContent("3");
    expect(screen.getByRole("switch", { name: "Send follow-ups" })).toBeChecked();
    await userEvent.click(save());
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { followUps: true } });
  });
  it("chooses the repository the settings belong to, reads each one's own board, remembers the choice, and opens at the one a link names", async () => {
    const other = "repo-bbbbbbbbbbbbbbbbbbbbbbbb";
    const second: TaskBoard = { ...BOARD_RUNNING, repositoryId: other, aril: { settings: { ...defaults(), limits: { ...defaults().limits, hours: 7 } }, memory: [{ id: 1, text: "Second repository habit", createdAt: 0, updatedAt: 0 }] } };
    current.names = { [board.repositoryId]: "Pomegr", [other]: "Clapline" };
    current.boards = { [board.repositoryId]: board, [other]: second };
    const view = await open();
    const select = screen.getByRole("combobox", { name: "Repository" });
    expect(select).toHaveTextContent("Pomegr");
    expect(screen.getByText("0 of 100")).toBeInTheDocument();
    await userEvent.click(select);
    await userEvent.click(screen.getByRole("option", { name: "Clapline" }));
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("Clapline");
    expect(screen.getByRole("combobox", { name: "Hours" })).toHaveTextContent("7");
    expect(screen.getByText("Second repository habit")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Send follow-ups" }));
    await userEvent.click(save());
    expect(taskAction).toHaveBeenLastCalledWith(other, "aril_settings_set", { settings: { followUps: false } });
    expect(window.localStorage.getItem("pomegr.agentChat.repository")).toBe(other);
    // A new section opens at the last one used, and at the one a link names before that.
    view.unmount();
    render(<ArilSettingsSection />);
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("Clapline");
    cleanup();
    render(<ArilSettingsSection initialRepositoryId={board.repositoryId} />);
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("Pomegr");
    cleanup();
    render(<ArilSettingsSection initialRepositoryId="repo-cccccccccccccccccccccccc" />);
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("Clapline");
  });
  it("says so when there is no repository, and when the board is not ready or has no Aril settings", async () => {
    current.names = {};
    const view = await open();
    expect(screen.getByText("No repositories observed yet.")).toBeInTheDocument();
    current.names = null;
    board = { ...board, readiness: "loading", aril: undefined };
    again(view);
    expect(screen.getByText("Reading Aril settings…")).toHaveAttribute("role", "status");
    board = { ...board, readiness: "unavailable" };
    again(view);
    expect(screen.getByText("Aril settings are unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
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

  it.each([["Tag", "backend"], ["Text", "Fix imports"], ["Feature", ""], ["Tasks", ""], ["Plan", "docs/plans/next.md"]])("adds a %s rule", async (kind, input) => {
    await open(); await choose("Rule kind", kind);
    const value = kind === "Tasks" ? board.tasks[0].id : input;
    if (kind === "Feature") await choose("Feature", board.features[0].name);
    else if (kind === "Plan") {
      expect(screen.getByText("A Markdown file in this repository, such as docs/plans/next.md")).toBeInTheDocument();
      fireEvent.change(screen.getByRole("textbox", { name: "Plan path" }), { target: { value } });
    } else fireEvent.change(screen.getByRole("textbox", { name: "Rule value" }), { target: { value } });
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getByRole("button", { name: `Remove ${kind} rule` })).toBeInTheDocument();
    await userEvent.click(save());
    const rule = { kind: kind.toLowerCase(), value: kind === "Feature" ? board.features[0].id : kind === "Tasks" ? [value] : value };
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { workRules: [rule] } });
  });

  it("accepts only repository-relative Markdown plan paths up to 200 characters", async () => {
    await open(); await choose("Rule kind", "Plan");
    const path = screen.getByRole("textbox", { name: "Plan path" });
    const add = screen.getByRole("button", { name: "Add rule" });
    for (const invalid of ["/docs/plan.md", "C:/docs/plan.md", "docs\\plan.md", "../plan.md", "docs/../plan.md", "docs/plan.txt", `${"a".repeat(198)}.md`]) {
      fireEvent.change(path, { target: { value: invalid } });
      expect(add, invalid).toBeDisabled();
    }
    const valid = `${"a".repeat(197)}.md`;
    expect(valid).toHaveLength(200);
    fireEvent.change(path, { target: { value: valid } });
    expect(add).toBeEnabled();
    await userEvent.click(add); await userEvent.click(save());
    expect(taskAction).toHaveBeenLastCalledWith(board.repositoryId, "aril_settings_set", { settings: { workRules: [{ kind: "plan", value: valid }] } });
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
    expect(screen.queryByRole("switch")).toBeNull(); expect(within(panel()).queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("Paired devices cannot change Aril settings and memory.")).toBeInTheDocument();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("keeps read-only settings current when the board refreshes", async () => {
    access.mode = "lan"; setBridge(undefined);
    const view = await open();
    board = { ...board, aril: { ...board.aril!, settings: { ...defaults(), limits: { ...defaults().limits, hours: 12 }, reviewer: { provider: "codex", model: "gpt-5", differentFromBuilder: true } } } };
    again(view);
    expect(within(panel()).getByText("12")).toBeInTheDocument();
    expect(within(panel()).getByText("gpt-5")).toBeInTheDocument();
  });

  it("sends paired settings through POST without exposing or sending the permission switch", async () => {
    access.mode = "lan"; setBridge(undefined); board.aril!.settings.pairedDevices = true;
    const fetcher = vi.fn(async () => ({ json: async () => ({ ok: true }) })); vi.stubGlobal("fetch", fetcher);
    await open();
    expect(screen.queryByRole("switch", { name: "Allow paired devices to change Aril settings and memory" })).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "Merge on green" })); await userEvent.click(save());
    expect(fetcher).toHaveBeenCalledWith("/api/tasks/action", expect.objectContaining({ method: "POST", body: JSON.stringify({ repositoryId: board.repositoryId, action: "aril_settings_set", payload: { settings: { actions: { ...defaults().actions, merge: true } } } }) }));
  });

  it("shows Mark done as its own switch, off by default, and saves it with the other actions (T-182)", async () => {
    await open();
    const markDone = screen.getByRole("switch", { name: "Mark done when acceptance passes" });
    expect(markDone).not.toBeChecked();
    await userEvent.click(markDone); await userEvent.click(save());
    expect(taskAction).toHaveBeenCalledWith(board.repositoryId, "aril_settings_set", { settings: { actions: { ...defaults().actions, markDone: true } } });
  });

  it("offers exactly the phase 3a limit bounds", async () => {
    await open();
    for (const [label, min, max] of [["Hours", 1, 72], ["Tasks", 1, 100], ["Tasks at a time", 1, 10], ["Send-backs per task", 0, 10], ["Usage limit %", 1, 100]] as const) {
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
      again(view);
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Add entry" }), { target: { value: "Run checks" } });
    await userEvent.click(screen.getByRole("button", { name: "Add entry" }));
    expect(await screen.findByText("1 of 100")).toBeInTheDocument();
    expect(screen.getByText("Run checks")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Start tasks" })).toBeChecked();
  });

  it("requires a send-back limit when grant send-backs are enabled", async () => {
    board.aril!.settings.actions.sendBack = true;
    await open();
    expect(screen.getByText("Set Send-backs per task first.")).toHaveClass("taskGatesCaption");
    expect(screen.queryByRole("button", { name: "Start grant" })).toBeNull();
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
    // The section also asks for the Aril switch and the owner's memory, which are not task actions.
    expect(fetcher.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string)).filter((body) => "action" in body)).toEqual([
      { repositoryId: board.repositoryId, action: "aril_memory_add", payload: { text: "New habit" } },
      { repositoryId: board.repositoryId, action: "aril_memory_update", payload: { id: 1, text: "Edited habit" } },
      { repositoryId: board.repositoryId, action: "aril_memory_remove", payload: { id: 1 } },
    ]);
    board = { ...board, aril: { ...board.aril!, settings: { ...board.aril!.settings, pairedDevices: false } } };
    again(view);
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
