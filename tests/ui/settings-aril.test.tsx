import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "../../shared/task-contract";
import { BOARD_RUNNING } from "../../app/components/design-system/DesignSystemTaskSampleData";
import SettingsRoute from "../../app/settings/page";
import { SettingsPage } from "../../app/settings/SettingsPage";

const { access, current } = vi.hoisted(() => ({ access: { mode: "local" }, current: { board: null as unknown as TaskBoard } }));
vi.mock("../../app/tasks-store", () => ({ useTasks: () => ({ board: current.board, refresh: async () => {} }) }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => access, clientAccessMode: () => access.mode }));
vi.mock("../../app/repository-inventory-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/repository-inventory-client")>();
  return { ...actual, useRepositoryInventory: () => ({ snapshot: { revision: 1, readiness: "ready", repositories: [{ id: current.board.repositoryId, displayName: "pomegr" }] }, loading: false, connected: true, refresh: async () => {} }) };
});

const SECRET = "jev-secret-key-0123456789";
const settings = {
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true,
};
const setBridge = (value: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = value; };

beforeEach(() => {
  current.board = { ...BOARD_RUNNING, aril: { settings, memory: [] } } as TaskBoard;
  access.mode = "local"; setBridge(undefined); window.localStorage.clear();
});
afterEach(() => { cleanup(); setBridge(undefined); });

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

  it("shows the whole panel in its own tab, with the repository, and no dialog", () => {
    render(<SettingsPage initialSection="aril" />);
    expect(screen.getByRole("tab", { name: "Aril" })).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: "Aril" });
    expect(within(panel).getByRole("heading", { name: "Aril", level: 2 })).toBeInTheDocument();
    expect(within(panel).getByText("pomegr")).toBeInTheDocument();
    for (const heading of ["Grant", "Actions under a grant", "Limits", "Work rules", "Reviewer", "Paired devices", "Memory"]) {
      expect(within(panel).getByRole("heading", { name: heading, level: 3 })).toBeInTheDocument();
    }
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the Jev key to the desktop app: a paired device shows no key control and asks nothing", () => {
    const agentChatJev = vi.fn(async () => ({ ok: true, state: "unset" }));
    // A paired device has no desktop bridge at all.
    access.mode = "lan"; current.board.aril!.settings.pairedDevices = true;
    render(<SettingsPage initialSection="aril" />);
    expect(screen.getByRole("tabpanel", { name: "Aril" })).toBeInTheDocument();
    expect(screen.queryByText(/Jev/u)).toBeNull();
    expect(screen.queryByLabelText("Jev key")).toBeNull();
    cleanup();
    // The desktop window shows it.
    access.mode = "local"; setBridge({ taskAction: vi.fn(async () => ({ ok: true })), agentChatJev });
    render(<SettingsPage initialSection="aril" />);
    expect(screen.getByRole("heading", { name: "Effort routing", level: 3 })).toBeInTheDocument();
    expect(agentChatJev).toHaveBeenCalledWith("status");
    expect(document.body.textContent?.includes(SECRET)).toBe(false);
  });
});
