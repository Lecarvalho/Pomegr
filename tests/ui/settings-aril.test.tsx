import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

  it("shows the cards in its own tab, in order: the top card, then memory, with no per-repository card, and no dialog", () => {
    render(<SettingsPage initialSection="aril" />);
    expect(screen.getByRole("tab", { name: "Aril" })).toHaveAttribute("aria-selected", "true");
    const headings = within(section()).getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings[0]).toBe("Aril");
    expect(headings.indexOf("Memory")).toBeGreaterThan(0);
    expect(headings).not.toContain("Per repository");
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
    for (const heading of ["Grant", "Actions under a grant", "Limits", "Work rules", "Reviewer", "Per repository"]) {
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

describe("Settings, Aril section: no per-repository settings card", () => {
  it("draws no repository choice, no Reviewer, no 'different provider' switch, and no Paired devices row, and never writes Aril's settings", async () => {
    asDesktop();
    render(<SettingsPage initialSection="aril" />);
    await waitFor(() => expect(arilControl).toHaveBeenCalledWith("aril_switch", {}));
    const page = section();
    expect(within(page).queryByRole("heading", { name: "Per repository" })).toBeNull();
    expect(within(page).queryByRole("combobox", { name: "Repository" })).toBeNull();
    expect(within(page).queryByRole("combobox", { name: "Reviewer provider" })).toBeNull();
    expect(within(page).queryByRole("textbox", { name: "Reviewer model" })).toBeNull();
    expect(within(page).queryByRole("switch", { name: "Use a different provider than the builder" })).toBeNull();
    expect(within(page).queryByText(/Paired devices|Reviewer|Different provider/u)).toBeNull();
    expect(within(page).queryByText(/Reading repositories|No repositories observed yet|Aril settings are unavailable|Reading Aril settings/u)).toBeNull();
    // The repository a link names still opens that repository's memory, and nothing wrote a setting.
    cleanup();
    render(<SettingsPage initialSection="aril" initialRepositoryId={current.board.repositoryId} />);
    expect(await within(section()).findByRole("textbox", { name: "pomegr memory" })).toBeInTheDocument();
    expect(taskAction.mock.calls.filter(([, action]) => action === "aril_settings_set")).toEqual([]);
    expect(window.localStorage.length).toBe(0);
  });

  it("reads a repository's memory while its board loads, and says so when the board holds no Aril data", () => {
    asDesktop();
    current.board = { ...current.board, aril: undefined } as TaskBoard;
    render(<SettingsPage initialSection="aril" initialRepositoryId={current.board.repositoryId} />);
    expect(within(section()).getByText("Memory is unavailable.")).toBeInTheDocument();
    cleanup();
    current.board = { ...BOARD_RUNNING, readiness: "loading" } as TaskBoard;
    render(<SettingsPage initialSection="aril" initialRepositoryId={current.board.repositoryId} />);
    expect(within(section()).getAllByRole("status").map((node) => node.textContent)).toContain("Reading memory…");
  });
});
