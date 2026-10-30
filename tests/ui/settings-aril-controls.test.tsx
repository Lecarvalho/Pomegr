import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "../../shared/task-contract";
import { BOARD_RUNNING } from "../../app/components/design-system/DesignSystemTaskSampleData";
import { SettingsPage } from "../../app/settings/SettingsPage";

const { access, current, inventory } = vi.hoisted(() => ({
  access: { mode: "local" },
  current: { board: null as unknown as TaskBoard },
  inventory: { repositories: [] as { id: string; displayName: string }[] },
}));
vi.mock("../../app/tasks-store", () => ({ useTasks: () => ({ board: current.board, refresh: async () => {} }) }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => access, clientAccessMode: () => access.mode }));
vi.mock("../../app/repository-inventory-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/repository-inventory-client")>();
  return { ...actual, useRepositoryInventory: () => ({ snapshot: { revision: 1, readiness: "ready", repositories: inventory.repositories }, loading: false, connected: true, refresh: async () => {} }) };
});

const settings = {
  actions: { start: true, review: false, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: 2, tasks: 5, tasksAtATime: 2, sendBacks: null, usagePercent: 80 },
  workRules: [{ kind: "tag", value: "backend" }], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true,
};
const OTHER = "repo-fedcba9876543210fedcba98";
type Entry = { id: number; text: string; createdAt: number; updatedAt: number };
type Json = Record<string, unknown>;

// What the desktop holds, and every call the page made to it.
const desktop = {
  state: { on: false, pairedOn: false }, memory: [] as Entry[], space: [] as { repositoryId: string; bytes: number; messages: number }[],
  flush: { ok: true, messages: 20, conversations: 1, images: 2, freed: 700 * 1024 } as Json,
  failNext: new Set<string>(), gate: null as Promise<void> | null, calls: [] as { operation: string; payload: Json }[],
};

async function answer(operation: string, payload: Json): Promise<Json> {
  desktop.calls.push({ operation, payload });
  if (desktop.gate && operation === "aril_switch") await desktop.gate;
  if (desktop.failNext.delete(operation)) return { ok: false, error: "unavailable" };
  switch (operation) {
    case "aril_switch": return { ok: true, ...desktop.state };
    case "aril_switch_set": if (access.mode === "lan" && payload.on && !desktop.state.pairedOn) return { ok: false, error: "desktop_only" }; desktop.state.on = payload.on === true; return { ok: true, on: desktop.state.on };
    case "aril_paired_on_set": desktop.state.pairedOn = payload.allowed === true; return { ok: true, pairedOn: desktop.state.pairedOn };
    case "owner_memory": return { ok: true, entries: desktop.memory };
    case "owner_memory_add": desktop.memory.push({ id: desktop.memory.length + 1, text: String(payload.text), createdAt: desktop.memory.length, updatedAt: desktop.memory.length }); return { ok: true };
    case "owner_memory_update": desktop.memory = desktop.memory.map((entry) => (entry.id === payload.id ? { ...entry, text: String(payload.text) } : entry)); return { ok: true };
    case "owner_memory_remove": desktop.memory = desktop.memory.filter((entry) => entry.id !== payload.id); return { ok: true };
    case "thread_space": return { ok: true, repositories: desktop.space };
    case "thread_flush": return desktop.flush;
    default: return { ok: false, error: "invalid" };
  }
}

const setBridge = (value: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = value; };
const asDesktop = () => setBridge({ taskAction: vi.fn(async () => ({ ok: true })), arilControl: vi.fn((operation: string, payload: Json) => answer(operation, payload)) });
const asPhone = () => {
  access.mode = "lan"; setBridge(undefined);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { operation: string; payload: Json };
    return new Response(JSON.stringify(await answer(body.operation, body.payload)), { status: 200, headers: { "content-type": "application/json" } });
  }));
};
const calls = (operation: string) => desktop.calls.filter((call) => call.operation === operation);

beforeEach(() => {
  current.board = { ...BOARD_RUNNING, aril: { settings, memory: [] } } as TaskBoard;
  inventory.repositories = [{ id: current.board.repositoryId, displayName: "pomegr" }, { id: OTHER, displayName: "clapline" }];
  access.mode = "local"; setBridge(undefined); window.localStorage.clear();
  Object.assign(desktop, { state: { on: false, pairedOn: false }, memory: [], space: [], gate: null, calls: [], failNext: new Set(),
    flush: { ok: true, messages: 20, conversations: 1, images: 2, freed: 700 * 1024 } });
});
afterEach(() => { cleanup(); setBridge(undefined); vi.unstubAllGlobals(); });

const section = () => screen.getByRole("tabpanel", { name: "Aril" });
const panelOf = (heading: string) => within(section()).getByRole("heading", { name: heading, level: 3 }).closest("section") as HTMLElement;
const open = async () => { render(<SettingsPage initialSection="aril" />); await waitFor(() => expect(calls("aril_switch").length).toBeGreaterThan(0)); };

describe("Settings › Aril: the switch", () => {
  it("is the first thing in the section, reads Off on a fresh desktop, and turns Aril on and off at once", async () => {
    asDesktop();
    await open();
    const row = await within(section()).findByRole("switch", { name: "Aril" });
    expect(row).not.toBeChecked();
    expect(within(section()).getByText("Off")).toHaveClass("commandChip");
    // The switch's panel is the first panel of the section, before every other section.
    const panel = row.closest(".arilSettingsPanel") as HTMLElement;
    expect(section().querySelector(".arilSettingsPanel")).toBe(panel);
    expect(panel.compareDocumentPosition(panelOf("Your memory")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(panelOf("Grant")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Aril takes no action of its own. The chat still answers when you write.")).toBeInTheDocument();
    await userEvent.click(row);
    await waitFor(() => expect(row).toBeChecked());
    expect(calls("aril_switch_set")).toEqual([{ operation: "aril_switch_set", payload: { on: true } }]);
    expect(within(section()).getByText("On")).toHaveClass("commandChip", "positive");
    expect(screen.getByText(/Turning it off stops its actions at once; running sessions continue\./u)).toBeInTheDocument();
    await userEvent.click(row);
    await waitFor(() => expect(row).not.toBeChecked());
    expect(calls("aril_switch_set").at(-1)).toEqual({ operation: "aril_switch_set", payload: { on: false } });
  });

  it("shows no state until the desktop answers, then the state it holds", async () => {
    asDesktop();
    let release!: () => void;
    desktop.gate = new Promise<void>((resolve) => { release = resolve; });
    desktop.state.on = true;
    render(<SettingsPage initialSection="aril" />);
    expect(await within(section()).findByText("Reading Aril…")).toHaveAttribute("role", "status");
    expect(within(section()).queryByText("Off")).toBeNull();
    expect(within(section()).queryByRole("switch", { name: "Aril" })).toBeNull();
    release();
    expect(await within(section()).findByRole("switch", { name: "Aril" })).toBeChecked();
  });

  it("tells the Grant section when Aril is Off, and its Start grant waits for On", async () => {
    asDesktop();
    await open();
    await within(section()).findByRole("switch", { name: "Aril" });
    expect(within(panelOf("Grant")).getByText("Aril is off. A grant does nothing until you turn it on above.")).toHaveClass("taskGatesCaption");
    expect(within(panelOf("Grant")).getByRole("button", { name: "Start grant" })).toBeDisabled();
    await userEvent.click(within(section()).getByRole("switch", { name: "Aril" }));
    await waitFor(() => expect(within(panelOf("Grant")).queryByText(/Aril is off/u)).toBeNull());
    expect(within(panelOf("Grant")).getByRole("button", { name: "Start grant" })).toBeEnabled();
  });

  it("keeps the state it knew and says so when a change fails", async () => {
    asDesktop();
    await open();
    const row = await within(section()).findByRole("switch", { name: "Aril" });
    desktop.failNext.add("aril_switch_set");
    await userEvent.click(row);
    expect(await within(section()).findByRole("alert")).toHaveTextContent("Aril could not be changed. Try again.");
    expect(row).not.toBeChecked();
    expect(within(section()).getByText("Off")).toBeInTheDocument();
  });

  it("lets the desktop app allow a paired device to turn Aril on, and says that a paired device can always turn it off", async () => {
    asDesktop();
    await open();
    const permission = await within(section()).findByRole("switch", { name: "Let a paired device turn Aril on" });
    expect(permission).not.toBeChecked();
    expect(screen.getByText("Let a paired device turn Aril on. A paired device can always turn it off.")).toBeInTheDocument();
    await userEvent.click(permission);
    await waitFor(() => expect(permission).toBeChecked());
    expect(calls("aril_paired_on_set")).toEqual([{ operation: "aril_paired_on_set", payload: { allowed: true } }]);
  });

  it("on a paired device: Off with no permission cannot be turned on, and says where to", async () => {
    asPhone();
    await open();
    const row = await within(section()).findByRole("switch", { name: "Aril" });
    expect(row).toBeDisabled();
    expect(within(section()).getByText("Turning Aril on needs the desktop app.")).toBeInTheDocument();
    expect(within(section()).queryByRole("switch", { name: "Let a paired device turn Aril on" })).toBeNull();
    expect(calls("aril_paired_on_set")).toEqual([]);
  });

  it("on a paired device with the permission: turns Aril on, and can always turn it off", async () => {
    asPhone();
    desktop.state.pairedOn = true;
    await open();
    const row = await within(section()).findByRole("switch", { name: "Aril" });
    expect(row).toBeEnabled();
    await userEvent.click(row);
    await waitFor(() => expect(row).toBeChecked());
    desktop.state.pairedOn = false;
    await userEvent.click(row);
    await waitFor(() => expect(row).not.toBeChecked());
    expect(calls("aril_switch_set").map((call) => call.payload)).toEqual([{ on: true }, { on: false }]);
    expect(within(section()).queryByText("Turning Aril on needs the desktop app.")).not.toBeNull();
  });

  it("in a plain browser it asks nothing and says where the switch is", async () => {
    render(<SettingsPage initialSection="aril" />);
    expect(await within(section()).findByText("Turn Aril on or off in the desktop app or on a paired device.")).toBeInTheDocument();
    expect(desktop.calls).toEqual([]);
    expect(within(section()).queryByRole("switch", { name: "Aril" })).toBeNull();
    expect(within(section()).queryByRole("heading", { name: "Your memory" })).toBeNull();
    expect(within(section()).queryByRole("heading", { name: "Thread space" })).toBeNull();
  });
});

describe("Settings › Aril: your memory", () => {
  it("adds, edits, and deletes the owner's lines on the desktop, apart from the repository's memory", async () => {
    asDesktop();
    desktop.memory = [{ id: 1, text: "Answer briefly.", createdAt: 1, updatedAt: 1 }];
    await open();
    const memory = await waitFor(() => { const panel = panelOf("Your memory"); expect(within(panel).getByText("Answer briefly.")).toBeInTheDocument(); return panel; });
    expect(within(memory).getByText("1 of 100")).toBeInTheDocument();
    expect(within(memory).getByText(/How you like to work with Aril in every repository\./u)).toBeInTheDocument();
    await userEvent.type(within(memory).getByRole("textbox", { name: "Add your entry" }), "Ask before a release.");
    await userEvent.click(within(memory).getByRole("button", { name: "Add entry" }));
    await within(memory).findByText("Ask before a release.");
    expect(calls("owner_memory_add")).toEqual([{ operation: "owner_memory_add", payload: { text: "Ask before a release." } }]);
    await userEvent.click(within(memory).getAllByRole("button", { name: "Edit" })[0]);
    const edit = within(memory).getByRole("textbox", { name: "Edit your entry" });
    await userEvent.clear(edit);
    await userEvent.type(edit, "Answer in one line.");
    await userEvent.click(within(memory).getByRole("button", { name: "Save entry" }));
    await within(memory).findByText("Answer in one line.");
    expect(calls("owner_memory_update")[0].payload).toEqual({ id: 1, text: "Answer in one line." });
    await userEvent.click(within(memory).getAllByRole("button", { name: "Delete" })[0]);
    await userEvent.click(within(memory).getByRole("button", { name: "Delete entry" }));
    await waitFor(() => expect(within(memory).queryByText("Answer in one line.")).toBeNull());
    expect(calls("owner_memory_remove")[0].payload).toEqual({ id: 1 });
    // The repository's memory is its own section, with its own fields.
    expect(within(panelOf("Memory")).queryByText("Ask before a release.")).toBeNull();
  });

  it("keeps what was typed and says so when the desktop does not accept a line", async () => {
    asDesktop();
    await open();
    const memory = await waitFor(() => { const panel = panelOf("Your memory"); expect(within(panel).getByText("0 of 100")).toBeInTheDocument(); return panel; });
    await userEvent.type(within(memory).getByRole("textbox", { name: "Add your entry" }), "A line");
    desktop.failNext.add("owner_memory_add");
    await userEvent.click(within(memory).getByRole("button", { name: "Add entry" }));
    expect(await within(memory).findByRole("alert")).toHaveTextContent("Memory could not be saved. Try again.");
    expect(within(memory).getByRole("textbox", { name: "Add your entry" })).toHaveValue("A line");
  });

  it("says how many older lines do not fit Aril's 6,000 characters", async () => {
    asDesktop();
    desktop.memory = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, text: `${index + 1}`.padEnd(300, "x"), createdAt: index, updatedAt: index }));
    await open();
    const memory = await waitFor(() => { const panel = panelOf("Your memory"); expect(within(panel).getByText("25 of 100")).toBeInTheDocument(); return panel; });
    expect(within(memory).getByText("Aril reads the newest 20 lines. The 5 older lines do not fit its limit of 6,000 characters.")).toHaveClass("taskGatesCaption");
  });

  it("is read-only on a paired device: the lines, and no way to change them", async () => {
    asPhone();
    desktop.memory = [{ id: 1, text: "Answer briefly.", createdAt: 1, updatedAt: 1 }];
    await open();
    const memory = await waitFor(() => { const panel = panelOf("Your memory"); expect(within(panel).getByText("Answer briefly.")).toBeInTheDocument(); return panel; });
    expect(within(memory).queryByRole("textbox")).toBeNull();
    expect(within(memory).queryByRole("button")).toBeNull();
  });
});

describe("Settings › Aril: thread space", () => {
  const space = (messages: number, bytes = 1.5 * 1024 * 1024, repositoryId = current.board.repositoryId) => ({ repositoryId, bytes, messages });

  it("lists each repository's thread with its size and messages, and never an unknown repository or an empty thread", async () => {
    asDesktop();
    desktop.space = [space(40), space(0, 0, OTHER), space(3, 900, "repo-0000000000000000aaaaaaaa")];
    await open();
    const panel = await waitFor(() => panelOf("Thread space"));
    expect(within(panel).getByText(/1\.5 MB · 40 messages/u)).toBeInTheDocument();
    expect(within(panel).getByText("pomegr")).toHaveClass("commandMonoValue");
    expect(within(panel).queryByText("clapline")).toBeNull();
    expect(panel.textContent).not.toMatch(/repo-0000/u);
    expect(within(panel).getByText(/Flushing removes the oldest half of its messages and their images\. Aril keeps its summary and the newest messages\./u)).toBeInTheDocument();
  });

  it("asks before it flushes, says what it removes, and reports what it freed", async () => {
    asDesktop();
    desktop.space = [space(40)];
    await open();
    const panel = await waitFor(() => panelOf("Thread space"));
    await userEvent.click(within(panel).getByRole("button", { name: "Flush oldest messages of pomegr" }));
    expect(within(panel).getByText("Remove the oldest 20 of 40 messages and their images?")).toBeInTheDocument();
    expect(calls("thread_flush")).toEqual([]);
    await userEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).queryByText(/Remove the oldest/u)).toBeNull();
    expect(calls("thread_flush")).toEqual([]);
    await userEvent.click(within(panel).getByRole("button", { name: "Flush oldest messages of pomegr" }));
    desktop.space = [space(20, 800 * 1024)];
    await userEvent.click(within(panel).getByRole("button", { name: "Flush messages" }));
    expect(await within(panel).findByText("Removed 20 messages and freed 700 KB.")).toHaveAttribute("role", "status");
    expect(calls("thread_flush")).toEqual([{ operation: "thread_flush", payload: { repositoryId: current.board.repositoryId } }]);
    expect(within(panel).getByText(/800 KB · 20 messages/u)).toBeInTheDocument();
  });

  it("says when Aril is answering in that repository, and when the flush failed", async () => {
    asDesktop();
    desktop.space = [space(40)];
    await open();
    const panel = await waitFor(() => panelOf("Thread space"));
    desktop.flush = { ok: false, error: "busy" };
    await userEvent.click(within(panel).getByRole("button", { name: "Flush oldest messages of pomegr" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Flush messages" }));
    expect(await within(panel).findByText("Aril is answering in this repository. Try again when it is done.")).toBeInTheDocument();
    desktop.flush = { ok: false, error: "unavailable" };
    await userEvent.click(within(panel).getByRole("button", { name: "Flush oldest messages of pomegr" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Flush messages" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("The messages could not be flushed. Try again.");
  });

  it("offers no flush for a thread of one message, and none at all on a paired device", async () => {
    asDesktop();
    desktop.space = [space(1, 2048)];
    await open();
    const panel = await waitFor(() => panelOf("Thread space"));
    expect(within(panel).getByText(/2 KB · 1 message/u)).toBeInTheDocument();
    expect(within(panel).queryByRole("button")).toBeNull();
    cleanup();
    asPhone();
    desktop.space = [space(40)];
    desktop.calls = [];
    await open();
    expect(within(section()).queryByRole("heading", { name: "Thread space" })).toBeNull();
    expect(calls("thread_space")).toEqual([]);
  });
});
