import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "../../shared/task-contract";
import { BOARD_RUNNING } from "../../app/components/design-system/DesignSystemTaskSampleData";
import { SettingsPage } from "../../app/settings/SettingsPage";

const { access, current, inventory } = vi.hoisted(() => ({
  access: { mode: "local" },
  current: { board: null as unknown as TaskBoard, boards: {} as Record<string, TaskBoard> },
  inventory: { repositories: [] as { id: string; displayName: string }[] },
}));
vi.mock("../../app/tasks-store", () => ({ useTasks: (id: string) => ({ board: current.boards[id] ?? current.board, refresh: async () => {} }) }));
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
const HOUR = 3_600_000;
type Json = Record<string, unknown>;
type Memory = { text: string; previous: string | null; updatedAt: number | null; updatedBy: "owner" | "aril" | null };
const none: Memory = { text: "", previous: null, updatedAt: null, updatedBy: null };

// What the desktop holds, and every call the page made to it.
const desktop = {
  state: { on: false, pairedOn: false }, memory: { ...none } as Memory, space: [] as { repositoryId: string; bytes: number; messages: number }[], limit: 5,
  flush: { ok: true, messages: 20, conversations: 1, images: 2, freed: 700 * 1024 } as Json,
  failNext: new Set<string>(), gate: null as Promise<void> | null, calls: [] as { operation: string; payload: Json }[], taskCalls: [] as { repositoryId: string; action: string; payload: Json }[],
};

async function answer(operation: string, payload: Json): Promise<Json> {
  desktop.calls.push({ operation, payload });
  if (desktop.gate && operation === "aril_switch") await desktop.gate;
  if (desktop.failNext.delete(operation)) return { ok: false, error: "unavailable" };
  switch (operation) {
    case "aril_switch": return { ok: true, ...desktop.state };
    case "aril_switch_set": if (access.mode === "lan" && payload.on && !desktop.state.pairedOn) return { ok: false, error: "desktop_only" }; desktop.state.on = payload.on === true; return { ok: true, on: desktop.state.on };
    case "aril_paired_on_set": desktop.state.pairedOn = payload.allowed === true; return { ok: true, pairedOn: desktop.state.pairedOn };
    case "owner_memory": return { ok: true, memory: desktop.memory };
    case "owner_memory_set": desktop.memory = { text: String(payload.text), previous: desktop.memory.text, updatedAt: Date.now(), updatedBy: "owner" }; return { ok: true, memory: desktop.memory };
    case "thread_space": return { ok: true, repositories: desktop.space, limit: desktop.limit };
    case "thread_limit_set": desktop.limit = Number(payload.megabytes); return { ok: true, limit: desktop.limit };
    case "thread_flush": return desktop.flush;
    default: return { ok: false, error: "invalid" };
  }
}

const setBridge = (value: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = value; };
const asDesktop = () => setBridge({
  taskAction: vi.fn(async (repositoryId: string, action: string, payload: Json) => { desktop.taskCalls.push({ repositoryId, action, payload }); return { ok: true }; }),
  arilControl: vi.fn((operation: string, payload: Json) => answer(operation, payload)),
  agentChatJev: vi.fn(async () => ({ ok: true, state: "unset" })),
});
const asPhone = () => {
  access.mode = "lan"; setBridge(undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { operation?: string; payload: Json };
    if (String(url).includes("/api/tasks/action")) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(await answer(body.operation!, body.payload)), { status: 200, headers: { "content-type": "application/json" } });
  }));
};
const calls = (operation: string) => desktop.calls.filter((call) => call.operation === operation);

beforeEach(() => {
  current.board = { ...BOARD_RUNNING, aril: { settings, memory: { text: "- Docs in English.", previous: null, updatedAt: Date.now() - 3 * 24 * HOUR, updatedBy: "owner" }, grant: null } } as TaskBoard;
  current.boards = { [OTHER]: { ...BOARD_RUNNING, repositoryId: OTHER, aril: { settings, memory: { ...none }, grant: null } } as TaskBoard };
  inventory.repositories = [{ id: current.board.repositoryId, displayName: "pomegr" }, { id: OTHER, displayName: "clapline" }];
  access.mode = "local"; setBridge(undefined); window.localStorage.clear();
  Object.assign(desktop, { state: { on: false, pairedOn: false }, memory: { ...none }, space: [], limit: 5, gate: null, calls: [], taskCalls: [], failNext: new Set(),
    flush: { ok: true, messages: 20, conversations: 1, images: 2, freed: 700 * 1024 } });
});
afterEach(() => { cleanup(); setBridge(undefined); vi.unstubAllGlobals(); });

const section = () => screen.getByRole("tabpanel", { name: "Aril" });
const card = (heading: string) => within(section()).getByRole("heading", { name: heading, level: 3 }).closest("section") as HTMLElement;
const open = async () => { render(<SettingsPage initialSection="aril" />); await waitFor(() => expect(calls("aril_switch").length).toBeGreaterThan(0)); };
const hero = () => section().querySelector(".arilHero") as HTMLElement;

describe("Settings › Aril: the top card", () => {
  it("is the page heading, the only Aril on the page, with one state line and a real switch that acts at once", async () => {
    asDesktop();
    await open();
    const row = await within(section()).findByRole("switch", { name: "Let Aril act" });
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(row).toHaveClass("commandSwitch");
    expect(within(hero()).getByRole("heading", { name: "Aril", level: 2 })).toBeInTheDocument();
    expect(within(section()).getAllByText("Aril")).toHaveLength(1);
    expect(section().querySelector(".arilSettings")?.firstElementChild).toBe(hero());
    expect(within(hero()).getByText("Off")).toHaveClass("arilHeroState");
    expect(within(hero()).getByText("Takes no action of its own. The chat still answers when you write.")).toBeInTheDocument();
    expect(hero()).not.toHaveClass("isOn");
    await userEvent.click(row);
    await waitFor(() => expect(row).toBeChecked());
    expect(calls("aril_switch_set")).toEqual([{ operation: "aril_switch_set", payload: { on: true } }]);
    expect(hero()).toHaveClass("isOn");
    expect(hero().querySelector(".arilHeroGlow")).not.toBeNull();
    expect(within(hero()).getByText("On")).toHaveClass("arilHeroState");
    expect(within(hero()).getByText(/Turn off to stop every action at once; running sessions keep going\./u)).toBeInTheDocument();
    await userEvent.click(row);
    await waitFor(() => expect(row).not.toBeChecked());
    expect(calls("aril_switch_set").at(-1)).toEqual({ operation: "aril_switch_set", payload: { on: false } });
    expect(hero()).not.toHaveClass("isOn");
  });

  it("draws nothing of the state until the desktop answers, then the state it holds", async () => {
    asDesktop();
    let release!: () => void;
    desktop.gate = new Promise<void>((resolve) => { release = resolve; });
    desktop.state.on = true;
    render(<SettingsPage initialSection="aril" />);
    expect(await within(section()).findByText("Reading Aril…")).toHaveAttribute("role", "status");
    expect(within(hero()).queryByText("Off")).toBeNull();
    expect(within(hero()).queryByText("On")).toBeNull();
    expect(within(hero()).queryByRole("switch")).toBeNull();
    expect(hero()).not.toHaveClass("isOn");
    release();
    expect(await within(section()).findByRole("switch", { name: "Let Aril act" })).toBeChecked();
    expect(hero()).toHaveClass("isOn");
  });

  it("keeps the state it knew and says so when a change fails", async () => {
    asDesktop();
    await open();
    const row = await within(section()).findByRole("switch", { name: "Let Aril act" });
    desktop.failNext.add("aril_switch_set");
    await userEvent.click(row);
    expect(await within(section()).findByRole("alert")).toHaveTextContent("Aril could not be changed. Try again.");
    expect(row).not.toBeChecked();
    expect(within(hero()).getByText("Off")).toBeInTheDocument();
  });

  it("holds the paired-device permission in a row under it, with a small switch", async () => {
    asDesktop();
    await open();
    const permission = await within(section()).findByRole("switch", { name: "A paired phone can always turn Aril off. Let it turn Aril on too" });
    expect(permission).toHaveClass("isSmall");
    expect(permission).not.toBeChecked();
    expect(hero().contains(permission)).toBe(true);
    await userEvent.click(permission);
    await waitFor(() => expect(permission).toBeChecked());
    expect(calls("aril_paired_on_set")).toEqual([{ operation: "aril_paired_on_set", payload: { allowed: true } }]);
  });

  it("on a paired device: Off with no permission cannot be turned on, and says where to", async () => {
    asPhone();
    await open();
    const row = await within(section()).findByRole("switch", { name: "Let Aril act" });
    expect(row).toBeDisabled();
    expect(within(section()).getByText("Turning Aril on needs the desktop app.")).toBeInTheDocument();
    expect(within(section()).getAllByRole("switch")).toHaveLength(1);
    expect(calls("aril_paired_on_set")).toEqual([]);
  });

  it("on a paired device with the permission: turns Aril on, and can always turn it off", async () => {
    asPhone();
    desktop.state.pairedOn = true;
    await open();
    const row = await within(section()).findByRole("switch", { name: "Let Aril act" });
    expect(row).toBeEnabled();
    await userEvent.click(row);
    await waitFor(() => expect(row).toBeChecked());
    desktop.state.pairedOn = false;
    await userEvent.click(row);
    await waitFor(() => expect(row).not.toBeChecked());
    expect(calls("aril_switch_set").map((call) => call.payload)).toEqual([{ on: true }, { on: false }]);
  });

  it("in a plain browser it asks nothing and says where the switch is", async () => {
    render(<SettingsPage initialSection="aril" />);
    expect(await within(section()).findByText("Turn Aril on or off in the desktop app or on a paired device.")).toBeInTheDocument();
    expect(desktop.calls).toEqual([]);
    expect(within(section()).queryByRole("switch")).toBeNull();
    expect(within(section()).queryByRole("tab", { name: "You" })).toBeNull();
    expect(within(section()).queryByRole("heading", { name: "Conversation space" })).toBeNull();
  });

  it("no longer holds a grant's sections: no Grant, Actions under a grant, Limits, Work rules, or Start grant", async () => {
    asDesktop();
    await open();
    await within(section()).findByRole("switch", { name: "Let Aril act" });
    for (const heading of ["Grant", "Actions under a grant", "Limits", "Work rules"]) expect(within(section()).queryByRole("heading", { name: heading })).toBeNull();
    expect(within(section()).queryByRole("button", { name: "Start grant" })).toBeNull();
    expect(within(section()).queryByText(/grants? (and|belong)/iu)).toBeNull();
  });
});

describe("Settings › Aril: memory", () => {
  // Memory is edited while Aril is on: with it off the whole page below the switch is read only (see the last describe).
  beforeEach(() => { desktop.state.on = true; });
  it("opens on yours, then one tab for each repository, with captions that read as context and not permission", async () => {
    asDesktop();
    await open();
    const memory = await waitFor(() => card("Memory"));
    const tabs = within(memory).getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["You", "pomegr", "clapline"]);
    expect(within(memory).getByRole("tab", { name: "You" })).toHaveAttribute("aria-selected", "true");
    expect(within(memory).getByText("How you like things done, in every repository. Context for Aril, not permission: it lets Aril do nothing new. Aril keeps it current; edit anything.")).toBeInTheDocument();
    await userEvent.click(within(memory).getByRole("tab", { name: "pomegr" }));
    expect(within(memory).getByText("How things are done in pomegr. Context for Aril, not permission. Aril keeps it current; edit anything.")).toBeInTheDocument();
    expect(await within(memory).findByRole("textbox", { name: "pomegr memory" })).toHaveValue("- Docs in English.");
    await userEvent.click(within(memory).getByRole("tab", { name: "clapline" }));
    expect(within(memory).getByText("How things are done in clapline. Context for Aril, not permission. Aril keeps it current; edit anything.")).toBeInTheDocument();
  });

  it("saves yours when the owner leaves the field, with a live count against 6,000, and says who changed it", async () => {
    asDesktop();
    desktop.memory = { text: "- Reply briefly.", previous: "- Reply at length.", updatedAt: Date.now() - 2 * HOUR, updatedBy: "aril" };
    await open();
    const field = await within(section()).findByRole("textbox", { name: "Your memory" });
    expect(field).toHaveValue("- Reply briefly.");
    expect(field).not.toHaveAttribute("readonly");
    expect(within(section()).getByText("16 / 6,000")).toBeInTheDocument();
    expect(within(section()).getByText("Aril updated this 2 h ago")).toBeInTheDocument();
    await userEvent.click(field);
    await userEvent.type(field, "{enter}- Never print a key.");
    expect(within(section()).getByText("Saves when you leave the field")).toBeInTheDocument();
    expect(within(section()).getByText("37 / 6,000")).toBeInTheDocument();
    expect(calls("owner_memory_set")).toEqual([]);
    fireEvent.blur(field);
    await waitFor(() => expect(calls("owner_memory_set")).toEqual([{ operation: "owner_memory_set", payload: { text: "- Reply briefly.\n- Never print a key." } }]));
    expect(await within(section()).findByText("You edited this just now")).toBeInTheDocument();
    expect(field).toHaveValue("- Reply briefly.\n- Never print a key.");
    expect(field).toHaveAttribute("maxlength", "6000");
  });

  it("shows the text before the last change beside the text now", async () => {
    asDesktop();
    desktop.memory = { text: "- Reply briefly.\n- Merge myself.", previous: "- Reply briefly.", updatedAt: Date.now() - 2 * HOUR, updatedBy: "aril" };
    await open();
    expect(await within(section()).findByText("Aril added a line 2 h ago")).toBeInTheDocument();
    expect(within(section()).queryByRole("group", { name: "Change to Your memory" })).toBeNull();
    await userEvent.click(within(section()).getByRole("button", { name: "Show change" }));
    const change = within(section()).getByRole("group", { name: "Change to Your memory" });
    expect(within(change).getByRole("heading", { name: "Before" })).toBeInTheDocument();
    expect(within(change).getByRole("heading", { name: "Now" })).toBeInTheDocument();
    expect(change.querySelectorAll(".isChanged")).toHaveLength(1);
    expect(within(change).getAllByText("- Reply briefly.")).toHaveLength(2);
    await userEvent.click(within(section()).getByRole("button", { name: "Hide change" }));
    expect(within(section()).queryByRole("group", { name: "Change to Your memory" })).toBeNull();
  });

  it("keeps what was typed and says so when the desktop does not keep the text", async () => {
    asDesktop();
    await open();
    const field = await within(section()).findByRole("textbox", { name: "Your memory" });
    await userEvent.type(field, "A line");
    desktop.failNext.add("owner_memory_set");
    fireEvent.blur(field);
    expect(await within(section()).findByRole("alert")).toHaveTextContent("Memory could not be saved. Try again.");
    expect(field).toHaveValue("A line");
  });

  it("saves a repository's memory through the fixed action", async () => {
    asDesktop();
    await open();
    await userEvent.click(await within(section()).findByRole("tab", { name: "pomegr" }));
    const field = await within(section()).findByRole("textbox", { name: "pomegr memory" });
    await userEvent.type(field, "{enter}- Plan-only pull requests merge at once.");
    fireEvent.blur(field);
    await waitFor(() => expect(desktop.taskCalls).toEqual([{ repositoryId: current.board.repositoryId, action: "aril_memory_set", payload: { text: "- Docs in English.\n- Plan-only pull requests merge at once." } }]));
  });

  it("is read-only on a paired device: yours, and a repository's unless the desktop allowed it", async () => {
    asPhone();
    desktop.memory = { text: "- Answer briefly.", previous: null, updatedAt: Date.now() - HOUR, updatedBy: "owner" };
    await open();
    const field = await within(section()).findByRole("textbox", { name: "Your memory" });
    expect(field).toHaveAttribute("readonly");
    await userEvent.click(within(section()).getByRole("tab", { name: "pomegr" }));
    expect(await within(section()).findByRole("textbox", { name: "pomegr memory" })).toHaveAttribute("readonly");
    cleanup();
    current.board = { ...current.board, aril: { ...current.board.aril!, settings: { ...settings, pairedDevices: true } } } as TaskBoard;
    await open();
    await userEvent.click(await within(section()).findByRole("tab", { name: "pomegr" }));
    expect(await within(section()).findByRole("textbox", { name: "pomegr memory" })).not.toHaveAttribute("readonly");
  });
});

describe("Settings › Aril: conversation space", () => {
  beforeEach(() => { desktop.state.on = true; });
  const space = (messages: number, bytes: number, repositoryId = current.board.repositoryId) => ({ repositoryId, bytes, messages });
  const MB = 1024 * 1024;

  it("draws a bar of each thread against the limit, with a tick, and the fill turns coral from 80%", async () => {
    asDesktop();
    desktop.space = [space(1, 900, OTHER), space(401, 4.3 * MB), space(0, 0, "repo-0000000000000000aaaaaaaa")];
    await open();
    const panel = await waitFor(() => card("Conversation space"));
    const rows = Array.from(panel.querySelectorAll(".arilSpaceRow"));
    expect(rows.map((row) => row.querySelector(".arilSpaceName")?.textContent)).toEqual(["pomegr", "clapline"]);
    expect(panel.querySelector(".arilSpaceSize")?.textContent).toBe("4.3 MB · 401 messages");
    const bars = within(panel).getAllByRole("meter");
    expect(bars[0]).toHaveAccessibleName("pomegr conversation size");
    expect(bars[0]).toHaveAttribute("aria-valuetext", "4.3 MB of 5 MB");
    expect(bars[0].querySelector(".arilSpaceFill")).toHaveClass("isNear");
    expect(bars[0].querySelector(".arilSpaceFill")).toHaveStyle({ width: "86.0%" });
    expect(bars[1].querySelector(".arilSpaceFill")).not.toHaveClass("isNear");
    expect(bars[0].querySelector(".arilSpaceTick")).not.toBeNull();
    expect(panel.textContent).not.toMatch(/repo-0000/u);
    expect(within(panel).getByText(/At 5 MB, Aril removes a conversation's oldest messages and their images, down to 75% of that\. Its summary and newest message stay\./u)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Flush oldest messages of pomegr" })).toHaveTextContent("Flush oldest");
    expect(within(panel).getByRole("button", { name: "clapline: nothing to flush" })).toBeDisabled();
  });

  it("changes Flush oldest at to 2, 5, 10, or 25 MB, or Never, and draws no tick for Never", async () => {
    asDesktop();
    desktop.space = [space(401, 4.3 * MB)];
    await open();
    const panel = await waitFor(() => card("Conversation space"));
    const select = within(panel).getByRole("combobox", { name: "Flush oldest at" });
    expect(select).toHaveTextContent("5 MB");
    await userEvent.click(select);
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((option) => option.textContent)).toEqual(["2 MB", "5 MB", "10 MB", "25 MB", "Never"]);
    await userEvent.click(screen.getByRole("option", { name: "10 MB" }));
    await waitFor(() => expect(calls("thread_limit_set")).toEqual([{ operation: "thread_limit_set", payload: { megabytes: 10 } }]));
    await waitFor(() => expect(within(card("Conversation space")).getByRole("combobox", { name: "Flush oldest at" })).toHaveTextContent("10 MB"));
    await userEvent.click(within(card("Conversation space")).getByRole("combobox", { name: "Flush oldest at" }));
    await userEvent.click(screen.getByRole("option", { name: "Never" }));
    await waitFor(() => expect(calls("thread_limit_set").at(-1)).toEqual({ operation: "thread_limit_set", payload: { megabytes: 0 } }));
    await waitFor(() => expect(card("Conversation space").querySelector(".arilSpaceTick")).toBeNull());
    expect(within(card("Conversation space")).getByText(/Nothing is removed unless you flush it\./u)).toBeInTheDocument();
  });

  it("says so when the limit could not be changed", async () => {
    asDesktop();
    desktop.space = [space(401, 4.3 * MB)];
    await open();
    const panel = await waitFor(() => card("Conversation space"));
    desktop.failNext.add("thread_limit_set");
    await userEvent.click(within(panel).getByRole("combobox", { name: "Flush oldest at" }));
    await userEvent.click(screen.getByRole("option", { name: "25 MB" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("The limit could not be changed. Try again.");
  });

  it("asks before it flushes, says what it removes, and reports what it freed", async () => {
    asDesktop();
    desktop.space = [space(40, 1.5 * MB)];
    await open();
    const panel = await waitFor(() => card("Conversation space"));
    await userEvent.click(within(panel).getByRole("button", { name: "Flush oldest messages of pomegr" }));
    expect(within(panel).getByText("Remove the oldest 20 of 40 messages and their images?")).toBeInTheDocument();
    expect(calls("thread_flush")).toEqual([]);
    await userEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).queryByText(/Remove the oldest/u)).toBeNull();
    await userEvent.click(within(panel).getByRole("button", { name: "Flush oldest messages of pomegr" }));
    desktop.space = [space(20, 800 * 1024)];
    await userEvent.click(within(panel).getByRole("button", { name: "Flush messages" }));
    expect(await within(panel).findByText("Removed 20 messages and freed 700 KB.")).toHaveAttribute("role", "status");
    expect(calls("thread_flush")).toEqual([{ operation: "thread_flush", payload: { repositoryId: current.board.repositoryId } }]);
    expect(panel.querySelector(".arilSpaceSize")?.textContent).toBe("800 KB · 20 messages");
  });

  it("says when Aril is answering in that repository, and when the flush failed", async () => {
    asDesktop();
    desktop.space = [space(40, 1.5 * MB)];
    await open();
    const panel = await waitFor(() => card("Conversation space"));
    desktop.flush = { ok: false, error: "busy" };
    await userEvent.click(within(panel).getByRole("button", { name: "Flush oldest messages of pomegr" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Flush messages" }));
    expect(await within(panel).findByText("Aril is answering in this repository. Try again when it is done.")).toBeInTheDocument();
    desktop.flush = { ok: false, error: "unavailable" };
    await userEvent.click(within(panel).getByRole("button", { name: "Flush oldest messages of pomegr" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Flush messages" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("The messages could not be flushed. Try again.");
  });

  it("is drawn only in the desktop app: a paired device shows nothing and asks nothing", async () => {
    asPhone();
    desktop.space = [space(40, 1.5 * MB)];
    await open();
    expect(within(section()).queryByRole("heading", { name: "Conversation space" })).toBeNull();
    expect(calls("thread_space")).toEqual([]);
    expect(calls("thread_limit_set")).toEqual([]);
  });
});

describe("Settings › Aril: effort routing", () => {
  beforeEach(() => { desktop.state.on = true; });
  const SECRET = "jev-secret-key-0123456789";

  function jevBridge(initial: "set" | "unset" | "unavailable") {
    let stored = initial;
    const received: string[] = [];
    const agentChatJev = vi.fn(async (operation: string, payload?: { key: string }) => {
      if (operation === "set") { received.push(payload!.key); stored = "set"; }
      if (operation === "remove") stored = "unset";
      return { ok: true, state: stored };
    });
    setBridge({ taskAction: vi.fn(async () => ({ ok: true })), arilControl: vi.fn((operation: string, payload: Json) => answer(operation, payload)), agentChatJev });
    return { received, agentChatJev };
  }

  it("is one compact row with the Jev key status, Replace key, and a quiet Remove", async () => {
    jevBridge("set");
    await open();
    const row = await waitFor(() => card("Effort routing"));
    expect(within(row).getByText("Jev key set")).toBeInTheDocument();
    expect(within(row).getByText(/Jev may lower the effort you chose for simple replies, never raise it\. It sees your message and the end of Aril's last answer\./u)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Replace key" })).toHaveClass("commandSecondaryAction");
    expect(within(row).getByRole("button", { name: "Remove Jev key" })).toHaveClass("commandQuietAction");
    expect(within(row).queryByLabelText("Jev key")).toBeNull();
  });

  it("takes a masked key, sends it once, and empties the field once it is saved; the page never holds the key", async () => {
    const { received, agentChatJev } = jevBridge("unset");
    await open();
    const row = await waitFor(() => card("Effort routing"));
    expect(await within(row).findByText("No Jev key")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Remove Jev key" })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Add key" }));
    const field = within(row).getByLabelText("Jev key") as HTMLInputElement;
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    const save = within(row).getByRole("button", { name: "Save key" });
    expect(save).toBeDisabled();
    await userEvent.type(field, "short");
    expect(save).toBeDisabled();
    expect(within(row).getByText("Use 8 to 512 characters without spaces.")).toHaveClass("newTaskError");
    await userEvent.clear(field);
    await userEvent.type(field, SECRET);
    await userEvent.click(save);
    expect(await within(row).findByText("Jev key set")).toBeInTheDocument();
    expect(received).toEqual([SECRET]);
    expect(agentChatJev).toHaveBeenCalledWith("set", { key: SECRET });
    expect(within(row).queryByLabelText("Jev key")).toBeNull();
    expect(row.innerHTML.includes(SECRET)).toBe(false);
    expect(document.body.textContent?.includes(SECRET)).toBe(false);
  });

  it("removes a key that is set, and says so with a fixed line when a key could not be saved", async () => {
    const { agentChatJev } = jevBridge("set");
    await open();
    const row = await waitFor(() => card("Effort routing"));
    await userEvent.click(await within(row).findByRole("button", { name: "Remove Jev key" }));
    expect(agentChatJev).toHaveBeenLastCalledWith("remove", undefined);
    expect(await within(row).findByText("No Jev key")).toBeInTheDocument();
    agentChatJev.mockImplementationOnce(async () => ({ ok: false, error: "unavailable" } as never));
    await userEvent.click(within(row).getByRole("button", { name: "Add key" }));
    await userEvent.type(within(row).getByLabelText("Jev key"), SECRET);
    await userEvent.click(within(row).getByRole("button", { name: "Save key" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("The key could not be saved. Try again.");
    expect((within(row).getByLabelText("Jev key") as HTMLInputElement).value).toBe(SECRET);
  });

  it("offers nothing to type where the computer cannot store the key safely", async () => {
    jevBridge("unavailable");
    await open();
    const row = await waitFor(() => card("Effort routing"));
    expect(await within(row).findByText("This computer cannot store the key safely")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Add key" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Replace key" })).toBeNull();
  });

  it("is not drawn on a paired device, which has no bridge to the key", async () => {
    asPhone();
    await open();
    expect(within(section()).queryByRole("heading", { name: "Effort routing" })).toBeNull();
    expect(within(section()).queryByText(/Jev/u)).toBeNull();
  });
});

describe("Settings › Aril: while Aril is off", () => {
  const MB = 1024 * 1024;
  const openOff = async () => {
    asDesktop();
    desktop.state.on = false;
    desktop.memory = { text: "- Reply briefly.", previous: null, updatedAt: Date.now() - HOUR, updatedBy: "owner" };
    desktop.space = [{ repositoryId: current.board.repositoryId, bytes: 4.3 * MB, messages: 40 }];
    await open();
    await within(section()).findByRole("switch", { name: "Let Aril act" });
  };
  const below = () => section().querySelector(".arilBelow") as HTMLElement;

  it("shows a neutral notice with a lock above everything below the switch card, which is gray, dimmed, and aria-disabled", async () => {
    await openOff();
    const notice = within(section()).getByText("Aril is off, so everything below is read only. Turn Aril on to change it.");
    expect(notice).toHaveClass("arilOffNotice");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice.querySelector("svg")).not.toBeNull();
    expect(below()).toHaveClass("isLocked");
    expect(below()).toHaveAttribute("aria-disabled", "true");
    // The notice sits between the switch card and the gray cards.
    expect(hero().compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(below()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hero().contains(notice)).toBe(false);
    expect(below().contains(hero())).toBe(false);
  });

  it("disables every real control under it: both memory tabs, the limit and the flushes, the effort routing, and the repository's settings", async () => {
    const agentChatJev = vi.fn(async () => ({ ok: true, state: "set" }));
    asDesktop();
    setBridge({ ...(window as Window & { pomegrDesktop?: Json }).pomegrDesktop, agentChatJev });
    desktop.state.on = false;
    desktop.memory = { text: "- Reply briefly.", previous: "- Reply at length.", updatedAt: Date.now() - HOUR, updatedBy: "aril" };
    desktop.space = [{ repositoryId: current.board.repositoryId, bytes: 4.3 * MB, messages: 40 }];
    await open();
    await within(section()).findByRole("switch", { name: "Let Aril act" });
    const memory = await waitFor(() => card("Memory"));
    expect(await within(memory).findByRole("textbox", { name: "Your memory" })).toBeDisabled();
    expect(within(memory).getByRole("textbox", { name: "Your memory" })).toHaveAttribute("readonly");
    for (const tab of within(memory).getAllByRole("tab")) expect(tab).toBeDisabled();
    expect(within(memory).getByRole("button", { name: "Show change" })).toBeDisabled();
    expect(within(card("Conversation space")).getByRole("combobox", { name: "Flush oldest at" })).toBeDisabled();
    expect(within(card("Conversation space")).getByRole("button", { name: "Flush oldest messages of pomegr" })).toBeDisabled();
    const effort = await waitFor(() => card("Effort routing"));
    expect(await within(effort).findByRole("button", { name: "Replace key" })).toBeDisabled();
    expect(within(effort).getByRole("button", { name: "Remove Jev key" })).toBeDisabled();
    const repository = card("Per repository");
    expect(within(repository).getByRole("combobox", { name: "Repository" })).toBeDisabled();
    expect(within(repository).getByRole("combobox", { name: "Reviewer provider" })).toBeDisabled();
    expect(within(repository).getByRole("textbox", { name: "Reviewer model" })).toBeDisabled();
    for (const toggle of within(repository).getAllByRole("switch")) expect(toggle).toBeDisabled();
    await userEvent.click(within(memory).getByRole("tab", { name: "pomegr" }), { pointerEventsCheck: 0 });
    expect(within(memory).getByRole("tab", { name: "You" })).toHaveAttribute("aria-selected", "true");
    // The switch card stays active: the main switch and its paired-device row.
    expect(within(hero()).getByRole("switch", { name: "Let Aril act" })).toBeEnabled();
    expect(within(hero()).getByRole("switch", { name: "A paired phone can always turn Aril off. Let it turn Aril on too" })).toBeEnabled();
    // A repository's memory is read only too.
    const repositoryMemory = within(section()).queryByRole("textbox", { name: "pomegr memory" });
    expect(repositoryMemory === null || (repositoryMemory as HTMLTextAreaElement).disabled).toBe(true);
    expect(desktop.calls.filter((call) => call.operation === "owner_memory_set")).toEqual([]);
  });

  it("makes no write while it is off, and every control works again when Aril is turned on", async () => {
    await openOff();
    const memory = await waitFor(() => card("Memory"));
    const field = await within(memory).findByRole("textbox", { name: "Your memory" });
    fireEvent.change(field, { target: { value: "- Changed." } });
    fireEvent.blur(field);
    expect(desktop.calls.filter((call) => call.operation === "owner_memory_set")).toEqual([]);
    expect(desktop.taskCalls).toEqual([]);
    await userEvent.click(within(hero()).getByRole("switch", { name: "Let Aril act" }));
    await waitFor(() => expect(below()).not.toHaveClass("isLocked"));
    expect(within(section()).queryByText(/Aril is off, so everything below is read only/u)).toBeNull();
    expect(below()).not.toHaveAttribute("aria-disabled");
    await waitFor(() => expect(within(memory).getByRole("textbox", { name: "Your memory" })).toBeEnabled());
    expect(within(memory).getAllByRole("tab").every((tab) => !(tab as HTMLButtonElement).disabled)).toBe(true);
    expect(within(card("Conversation space")).getByRole("combobox", { name: "Flush oldest at" })).toBeEnabled();
    expect(within(card("Per repository")).getByRole("textbox", { name: "Reviewer model" })).toBeEnabled();
  });

  it("closes any open edit when Aril is turned off: a flush question, the key field, a memory draft, and the reviewer's model", async () => {
    const agentChatJev = vi.fn(async () => ({ ok: true, state: "set" }));
    asDesktop();
    setBridge({ ...(window as Window & { pomegrDesktop?: Json }).pomegrDesktop, agentChatJev });
    desktop.state.on = true;
    desktop.memory = { text: "- Reply briefly.", previous: null, updatedAt: Date.now() - HOUR, updatedBy: "owner" };
    desktop.space = [{ repositoryId: current.board.repositoryId, bytes: 4.3 * MB, messages: 40 }];
    await open();
    const memory = await waitFor(() => card("Memory"));
    const field = await within(memory).findByRole("textbox", { name: "Your memory" });
    await waitFor(() => expect(field).toBeEnabled());
    // Moving to another field saves the one that was left, so the edits are opened in an order that leaves the memory draft open last.
    await userEvent.click(within(card("Conversation space")).getByRole("button", { name: "Flush oldest messages of pomegr" }));
    expect(within(card("Conversation space")).getByText("Remove the oldest 20 of 40 messages and their images?")).toBeInTheDocument();
    const effort = await waitFor(() => card("Effort routing"));
    await userEvent.click(await within(effort).findByRole("button", { name: "Replace key" }));
    await userEvent.type(within(effort).getByLabelText("Jev key"), "jev-secret-key-0123456789");
    await userEvent.type(field, " More.");
    expect(within(memory).getByText("Saves when you leave the field")).toBeInTheDocument();
    // A click that moves no focus, so no field is left (and saved) on the way: the switch alone turns Aril off.
    fireEvent.click(within(hero()).getByRole("switch", { name: "Let Aril act" }));
    await waitFor(() => expect(below()).toHaveClass("isLocked"));
    await waitFor(() => expect(within(memory).getByRole("textbox", { name: "Your memory" })).toHaveValue("- Reply briefly."));
    expect(within(memory).queryByText("Saves when you leave the field")).toBeNull();
    expect(within(card("Conversation space")).queryByText(/Remove the oldest/u)).toBeNull();
    expect(within(effort).queryByLabelText("Jev key")).toBeNull();
    expect(desktop.calls.filter((call) => call.operation === "owner_memory_set")).toEqual([]);
    expect(agentChatJev).not.toHaveBeenCalledWith("set", expect.anything());
    // The reviewer's model draft is closed the same way.
    fireEvent.click(within(hero()).getByRole("switch", { name: "Let Aril act" }));
    await waitFor(() => expect(below()).not.toHaveClass("isLocked"));
    const model = within(card("Per repository")).getByRole("textbox", { name: "Reviewer model" });
    await waitFor(() => expect(model).toBeEnabled());
    await userEvent.type(model, "gpt-6");
    fireEvent.click(within(hero()).getByRole("switch", { name: "Let Aril act" }));
    await waitFor(() => expect(below()).toHaveClass("isLocked"));
    expect(within(card("Per repository")).getByRole("textbox", { name: "Reviewer model" })).toHaveValue("");
    expect(JSON.stringify(desktop.taskCalls)).not.toContain("gpt-6");
  });

  it("reads as locked, with no notice, until the desktop has answered, and is not locked in a plain browser", async () => {
    asDesktop();
    let release!: () => void;
    desktop.gate = new Promise<void>((resolve) => { release = resolve; });
    desktop.state.on = true;
    render(<SettingsPage initialSection="aril" />);
    await waitFor(() => expect(below()).toHaveClass("isLocked"));
    expect(within(section()).queryByText(/Aril is off, so everything below is read only/u)).toBeNull();
    release();
    await waitFor(() => expect(below()).not.toHaveClass("isLocked"));
    cleanup();
    setBridge(undefined);
    render(<SettingsPage initialSection="aril" />);
    expect(below()).not.toHaveClass("isLocked");
    expect(within(section()).queryByText(/Aril is off, so everything below is read only/u)).toBeNull();
  });

  it("locks a paired device's page the same way, and leaves its Stop and its switch active", async () => {
    asPhone();
    desktop.state.on = false;
    desktop.memory = { text: "- Answer briefly.", previous: null, updatedAt: Date.now() - HOUR, updatedBy: "owner" };
    await open();
    await within(section()).findByRole("switch", { name: "Let Aril act" });
    expect(within(section()).getByText("Aril is off, so everything below is read only. Turn Aril on to change it.")).toBeInTheDocument();
    expect(below()).toHaveClass("isLocked");
    expect(await within(section()).findByRole("textbox", { name: "Your memory" })).toBeDisabled();
  });
});
