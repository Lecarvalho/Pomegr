import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArilSettings, TaskBoard } from "../../shared/task-contract";
import { BOARD_RUNNING } from "../../app/components/design-system/DesignSystemTaskSampleData";
import { ArilSettingsSection } from "../../app/settings/ArilSettings";

const { refresh, access, current } = vi.hoisted(() => ({ refresh: vi.fn(async () => {}), access: { mode: "local" }, current: { board: null as unknown as TaskBoard } }));
vi.mock("../../app/tasks-store", () => ({ useTasks: () => ({ board: current.board, refresh }) }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: { repositories: [{ id: current.board.repositoryId, displayName: "Pomegr" }] }, loading: false }) }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => access, clientAccessMode: () => access.mode }));

const SECRET = "jev-secret-key-0123456789";
const defaults = (): ArilSettings => ({
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true,
});

let board: TaskBoard;
const taskAction = vi.fn(async () => ({ ok: true }));
type Answer = { ok: true; state: "set" | "unset" | "unavailable" } | { ok: false; error: string };
// The desktop's key store, as the bridge answers it: it keeps whether a key is set, and never answers the key.
let stored: "set" | "unset" | "unavailable" = "unset";
let received: string[] = [];
const agentChatJev = vi.fn(async (operation: string, payload?: { key: string }): Promise<Answer> => {
  if (operation === "set") { if (stored === "unavailable") return { ok: false, error: "unavailable" }; received.push(payload!.key); stored = "set"; }
  if (operation === "remove") stored = "unset";
  return { ok: true, state: stored };
});
const setBridge = (value: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = value; };

beforeEach(() => {
  board = { ...BOARD_RUNNING, aril: { settings: defaults(), memory: [] } };
  access.mode = "local"; stored = "unset"; received = [];
  setBridge({ taskAction, agentChatJev });
});
afterEach(() => { cleanup(); setBridge(undefined); vi.clearAllMocks(); });

async function open() {
  current.board = board;
  render(<ArilSettingsSection />);
  return screen.getByRole("region", { name: "Aril" });
}
const field = (dialog: HTMLElement) => within(dialog).getByLabelText("Jev key") as HTMLInputElement;

describe("Aril settings: effort routing key", () => {
  it("shows whether a key is set, takes a masked key, and empties the field once it is saved", async () => {
    const dialog = await open();
    expect(await within(dialog).findByText("No key set")).toHaveClass("taskGatesCaption");
    expect(within(dialog).getByRole("heading", { name: "Effort routing" })).toBeInTheDocument();
    expect(within(dialog).getByText(/Aril may lower the effort you chose for simple replies, never raise it/u)).toBeInTheDocument();
    expect(field(dialog)).toHaveAttribute("type", "password");
    expect(field(dialog)).toHaveAttribute("autocomplete", "off");
    expect(within(dialog).queryByRole("button", { name: "Remove key" })).toBeNull();
    const submit = within(dialog).getByRole("button", { name: "Save key" });
    expect(submit).toBeDisabled();
    await userEvent.type(field(dialog), "short");
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText("Use 8 to 512 characters without spaces.")).toHaveClass("newTaskError");
    await userEvent.clear(field(dialog));
    await userEvent.type(field(dialog), SECRET);
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(await within(dialog).findByText("Key set")).toBeInTheDocument();
    expect(received).toEqual([SECRET]);
    expect(agentChatJev).toHaveBeenCalledWith("set", { key: SECRET });
    expect(field(dialog).value).toBe("");
    // The page shows "set" and nothing of the key.
    expect(dialog.textContent?.includes(SECRET)).toBe(false);
    expect(dialog.innerHTML.includes(SECRET)).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Remove key" })).toBeInTheDocument();
  });

  it("removes a key that is set", async () => {
    stored = "set";
    const dialog = await open();
    expect(await within(dialog).findByText("Key set")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));
    expect(agentChatJev).toHaveBeenLastCalledWith("remove", undefined);
    expect(await within(dialog).findByText("No key set")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove key" })).toBeNull();
  });

  it("says so, with a fixed line, when the key could not be saved, and keeps what was typed", async () => {
    stored = "unavailable";
    agentChatJev.mockImplementationOnce(async () => ({ ok: true, state: "unset" }));
    const dialog = await open();
    expect(await within(dialog).findByText("No key set")).toBeInTheDocument();
    await userEvent.type(field(dialog), SECRET);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The key could not be saved. Try again.");
    expect(field(dialog).value).toBe(SECRET);
  });

  it("offers nothing to type where the computer cannot store the key safely", async () => {
    stored = "unavailable";
    const dialog = await open();
    expect(await within(dialog).findByText("This computer cannot store the key safely.")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Jev key")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Save key" })).toBeNull();
  });

  it("is not drawn on a paired device, which has no bridge to the key, nor where the bridge is missing", async () => {
    access.mode = "lan"; board.aril!.settings.pairedDevices = true; setBridge(undefined);
    const dialog = await open();
    expect(within(dialog).getByRole("heading", { name: "Aril", level: 2 })).toBeInTheDocument();
    expect(within(dialog).queryByRole("heading", { name: "Effort routing" })).toBeNull();
    expect(within(dialog).queryByText(/Jev/u)).toBeNull();
    expect(agentChatJev).not.toHaveBeenCalled();
    cleanup();
    // The desktop window of an older build, with no key bridge, shows nothing either.
    access.mode = "local"; setBridge({ taskAction });
    const older = await open();
    expect(within(older).queryByRole("heading", { name: "Effort routing" })).toBeNull();
  });
});
