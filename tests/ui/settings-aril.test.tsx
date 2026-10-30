import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArilGrant, TaskBoard } from "../../shared/task-contract";
import { BOARD_RUNNING } from "../../app/components/design-system/DesignSystemTaskSampleData";
import { timeOfDay } from "../../app/components/tasks/task-schedule";
import SettingsRoute from "../../app/settings/page";
import { SettingsPage } from "../../app/settings/SettingsPage";

const { access, current, refresh } = vi.hoisted(() => ({ access: { mode: "local" }, current: { board: null as unknown as TaskBoard }, refresh: vi.fn(async () => {}) }));
vi.mock("../../app/tasks-store", () => ({ useTasks: () => ({ board: current.board, refresh }) }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => access, clientAccessMode: () => access.mode }));
vi.mock("../../app/repository-inventory-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/repository-inventory-client")>();
  return { ...actual, useRepositoryInventory: () => ({ snapshot: { revision: 1, readiness: "ready", repositories: [{ id: current.board.repositoryId, displayName: "pomegr" }] }, loading: false, connected: true, refresh: async () => {} }) };
});

const settings = {
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true,
};
const memory = { text: "", previous: null, updatedAt: null, updatedBy: null };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
const arilControl = vi.fn(async (operation: string) => (operation === "aril_switch" ? { ok: true, on: true, pairedOn: false } : { ok: false, error: "unavailable" }));
const setBridge = (value: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = value; };
const asDesktop = () => setBridge({ taskAction, arilControl });
const grant = (): ArilGrant => ({ active: true, startedAt: Date.now(), endsAt: Date.now() + 2 * 3_600_000, startsUsed: 2, actions: { ...settings.actions }, limits: { ...settings.limits } });
const section = () => screen.getByRole("tabpanel", { name: "Aril" });
const repositoryCard = () => within(section()).getByRole("heading", { name: "Per repository", level: 3 }).closest("section") as HTMLElement;

beforeEach(() => {
  current.board = { ...BOARD_RUNNING, aril: { settings: structuredClone(settings), memory, grant: null } } as TaskBoard;
  access.mode = "local"; setBridge(undefined); window.localStorage.clear();
  taskAction.mockClear(); arilControl.mockClear(); refresh.mockClear();
});
afterEach(() => { cleanup(); setBridge(undefined); vi.unstubAllGlobals(); });

describe("Settings, Aril section", () => {
  it("is listed after GitHub and before Storage, and opens from the section and repository parameters", async () => {
    render(<SettingsPage />);
    const names = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(names.indexOf("Aril")).toBe(names.indexOf("GitHub") + 1);
    expect(names.indexOf("Storage")).toBe(names.indexOf("Aril") + 1);
    const repository = "repo-0123456789abcdef01234567";
    const element = await SettingsRoute({ searchParams: Promise.resolve({ section: "aril", repository }) });
    expect(element.props).toMatchObject({ initialSection: "aril", initialRepositoryId: repository });
    // A repository that is no repository ID, or is named twice, is no choice; a link for another section carries none.
    for (const bad of ["repo-short", "../x", ["repo-0123456789abcdef01234567", "repo-0123456789abcdef01234568"], undefined]) {
      expect((await SettingsRoute({ searchParams: Promise.resolve({ section: "aril", repository: bad }) })).props).toMatchObject({ initialSection: "aril", initialRepositoryId: null });
    }
    expect((await SettingsRoute({ searchParams: Promise.resolve({ section: "elsewhere" }) })).props).toMatchObject({ initialSection: "appearance" });
  });

  it("shows the cards in its own tab, in order: the top card, memory, and the repository's settings, and no dialog", () => {
    render(<SettingsPage initialSection="aril" />);
    expect(screen.getByRole("tab", { name: "Aril" })).toHaveAttribute("aria-selected", "true");
    const headings = within(section()).getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings[0]).toBe("Aril");
    expect(headings.indexOf("Memory")).toBeGreaterThan(0);
    expect(headings.indexOf("Per repository")).toBeGreaterThan(headings.indexOf("Memory"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Aril", level: 2 })).toBeInTheDocument();
  });

  it("opens memory on the repository a link names, and a browser with one repository has no tabs", async () => {
    const repository = current.board.repositoryId;
    render(<SettingsPage initialSection="aril" initialRepositoryId={repository} />);
    expect(await within(section()).findByRole("textbox", { name: "pomegr memory" })).toHaveAttribute("readonly");
    expect(within(section()).queryByRole("tablist")).toBeNull();
  });

  it("leaves a grant's sections to phase 5 and keeps one line for a grant that is still running", () => {
    for (const heading of ["Grant", "Actions under a grant", "Limits", "Work rules", "Reviewer"]) {
      render(<SettingsPage initialSection="aril" />);
      expect(within(section()).queryByRole("heading", { name: heading })).toBeNull();
      cleanup();
    }
    asDesktop();
    current.board.aril!.grant = grant();
    render(<SettingsPage initialSection="aril" />);
    const line = section().querySelector(".arilGrantLine") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain(`A grant in pomegr is active until ${timeOfDay(new Date(current.board.aril!.grant!.active ? (current.board.aril!.grant as { endsAt: number }).endsAt : 0).toISOString())}.`);
    expect(within(line).getByRole("button", { name: "Stop grant in pomegr" })).toHaveClass("commandSecondaryAction");
  });
});

describe("Settings, Aril section: a grant that is still running", () => {
  it("stops it with Stop grant, in the desktop app and on a paired device, and a browser can only read the line", async () => {
    asDesktop();
    current.board.aril!.grant = grant();
    render(<SettingsPage initialSection="aril" />);
    await userEvent.click(within(section()).getByRole("button", { name: "Stop grant in pomegr" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(current.board.repositoryId, "grant_stop", {}));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    cleanup();
    // A paired device may always stop a grant.
    setBridge(undefined); access.mode = "lan";
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchStub);
    render(<SettingsPage initialSection="aril" />);
    await userEvent.click(within(section()).getByRole("button", { name: "Stop grant in pomegr" }));
    await waitFor(() => expect(fetchStub.mock.calls.some((call) => String((call as unknown[])[0]).includes("/api/tasks/action"))).toBe(true));
    cleanup();
    vi.unstubAllGlobals();
    access.mode = "local";
    render(<SettingsPage initialSection="aril" />);
    expect(section().querySelector(".arilGrantLine")).not.toBeNull();
    expect(within(section()).queryByRole("button", { name: /Stop grant/u })).toBeNull();
  });

  it("says that Aril is off, so the grant does nothing, and says so with a fixed line when it could not be stopped", async () => {
    setBridge({ taskAction: vi.fn(async () => ({ ok: false, error: "unavailable" })), arilControl: vi.fn(async (operation: string) => (operation === "aril_switch" ? { ok: true, on: false, pairedOn: false } : { ok: false, error: "unavailable" })) });
    current.board.aril!.grant = grant();
    render(<SettingsPage initialSection="aril" />);
    await waitFor(() => expect((section().querySelector(".arilGrantLine") as HTMLElement).textContent).toContain("Aril is off, so it does nothing."));
    await userEvent.click(within(section()).getByRole("button", { name: "Stop grant in pomegr" }));
    expect(await within(section()).findByText("The grant could not be stopped. Try again.")).toHaveAttribute("role", "alert");
  });

  it("draws no line for a grant that has ended or was never started", () => {
    asDesktop();
    render(<SettingsPage initialSection="aril" />);
    expect(section().querySelector(".arilGrantLine")).toBeNull();
    cleanup();
    current.board.aril!.grant = { ...grant(), active: false, endedAt: Date.now(), endReason: "expired" } as ArilGrant;
    render(<SettingsPage initialSection="aril" />);
    expect(section().querySelector(".arilGrantLine")).toBeNull();
  });
});

describe("Settings, Aril section: the settings of one repository that a grant does not own", () => {
  it("saves each control at once: the reviewer's provider and model, whether a different provider reviews, and the paired-device permission", async () => {
    asDesktop();
    render(<SettingsPage initialSection="aril" />);
    const card = repositoryCard();
    await waitFor(() => expect(within(card).getByRole("textbox", { name: "Reviewer model" })).toBeEnabled());
    expect(within(card).getByText("pomegr")).toHaveClass("commandMonoValue");
    await userEvent.click(within(card).getByRole("combobox", { name: "Reviewer provider" }));
    await userEvent.click(screen.getByRole("option", { name: "Codex" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(current.board.repositoryId, "aril_settings_set", { settings: { reviewer: { provider: "codex", model: null, differentFromBuilder: false } } }));
    const model = within(card).getByRole("textbox", { name: "Reviewer model" });
    await userEvent.type(model, "gpt-6-sol");
    expect(taskAction).toHaveBeenCalledTimes(1);
    fireEvent.blur(model);
    await waitFor(() => expect(taskAction).toHaveBeenLastCalledWith(current.board.repositoryId, "aril_settings_set", { settings: { reviewer: { provider: null, model: "gpt-6-sol", differentFromBuilder: false } } }));
    await userEvent.click(within(card).getByRole("switch", { name: "Use a different provider than the builder" }));
    await waitFor(() => expect(taskAction).toHaveBeenLastCalledWith(current.board.repositoryId, "aril_settings_set", { settings: { reviewer: { provider: null, model: null, differentFromBuilder: true } } }));
    await userEvent.click(within(card).getByRole("switch", { name: "Allow paired devices to change Aril settings and memory" }));
    await waitFor(() => expect(taskAction).toHaveBeenLastCalledWith(current.board.repositoryId, "aril_settings_set", { settings: { pairedDevices: true } }));
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("refuses a model identifier that is not one, and says when a change could not be saved", async () => {
    setBridge({ taskAction: vi.fn(async () => ({ ok: false, error: "unavailable" })), arilControl });
    render(<SettingsPage initialSection="aril" />);
    const card = repositoryCard();
    const model = within(card).getByRole("textbox", { name: "Reviewer model" });
    await waitFor(() => expect(model).toBeEnabled());
    await userEvent.type(model, "bad/model");
    expect(within(card).getByText("Use a model identifier of at most 120 characters, without spaces or paths.")).toHaveClass("newTaskError");
    fireEvent.blur(model);
    expect(model).toHaveAttribute("aria-invalid", "true");
    await userEvent.clear(model);
    await userEvent.click(within(card).getByRole("switch", { name: "Allow paired devices to change Aril settings and memory" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("Aril settings could not be saved. Try again.");
  });

  it("is read-only on a paired device without the permission, and edits what the desktop allowed, without the permission switch", async () => {
    access.mode = "lan";
    // Aril is on, so the page is not locked: the paired device's switch answers On.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, on: true, pairedOn: false }), { status: 200, headers: { "content-type": "application/json" } })));
    render(<SettingsPage initialSection="aril" />);
    await waitFor(() => expect(within(section()).getByRole("switch", { name: "Let Aril act" })).toBeChecked());
    let card = repositoryCard();
    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(within(card).queryByRole("switch")).toBeNull();
    expect(within(card).getByText("Not allowed")).toBeInTheDocument();
    cleanup();
    current.board.aril!.settings.pairedDevices = true;
    render(<SettingsPage initialSection="aril" />);
    await waitFor(() => expect(within(section()).getByRole("switch", { name: "Let Aril act" })).toBeChecked());
    card = repositoryCard();
    expect(within(card).getByRole("textbox", { name: "Reviewer model" })).toBeEnabled();
    expect(within(card).getByRole("switch", { name: "Use a different provider than the builder" })).toBeEnabled();
    expect(within(card).queryByRole("switch", { name: "Allow paired devices to change Aril settings and memory" })).toBeNull();
    expect(within(card).getByText("Allowed")).toBeInTheDocument();
  });

  it("says the settings are unavailable when the board holds none, and reads while the board loads", () => {
    asDesktop();
    current.board = { ...current.board, aril: undefined } as TaskBoard;
    render(<SettingsPage initialSection="aril" />);
    expect(within(section()).getByText("Aril settings are unavailable.")).toBeInTheDocument();
    expect(within(section()).queryByRole("heading", { name: "Per repository" })).toBeNull();
    cleanup();
    current.board = { ...BOARD_RUNNING, readiness: "loading" } as TaskBoard;
    render(<SettingsPage initialSection="aril" />);
    expect(within(section()).getAllByRole("status").map((node) => node.textContent)).toContain("Reading Aril settings…");
  });
});
