import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositorySummary } from "../../shared/monitor-contract";
import { GitHubSettingsSection } from "../../app/components/design-system/DesignSystemGitHubSettingsSample";
import SettingsRoute from "../../app/settings/page";
import { SettingsPage } from "../../app/settings/SettingsPage";

// The repository list is committed inventory state; each test sets what the store would hand out.
const inventory = vi.hoisted(() => ({
  view: null as unknown as { snapshot: { revision: number; readiness: string; repositories: unknown[] }; loading: boolean; connected: boolean; refresh: () => Promise<void> },
  hook: vi.fn(),
}));
vi.mock("../../app/repository-inventory-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/repository-inventory-client")>();
  return { ...actual, useRepositoryInventory: inventory.hook };
});

const idOf = (index: number) => `repo-${String(index + 1).padStart(24, "0")}`;
const entry = (index: number, displayName = `project-${index + 1}`): RepositorySummary => ({
  id: idOf(index), name: displayName, displayName, sessionCount: 1, liveCount: 0, historyCount: 1, providerCount: 1, updatedAt: null,
  providers: [{ provider: "claude", source: "Claude Code", sessionCount: 1, supported: false, status: "unavailable", failureKind: null, currentRevision: null, revisions: [] }],
});

function setInventory(repositories: RepositorySummary[], loading = false) {
  inventory.view = { snapshot: { revision: repositories.length, readiness: "ready", repositories }, loading, connected: true, refresh: vi.fn(async () => {}) };
}

type Access = { visibility: string; capabilities: string[] } | null;
const status = (connection: string, repository: Access = null) => ({ ok: true, connection, repository });
const connected = (visibility = "private", capabilities: string[] = ["read_issues", "create_issues"]) => status("connected", { visibility, capabilities });

type Answer = (repositoryId: string, operation: string) => unknown;
/** Fakes the desktop preload's `taskIssues`: `answer` decides what each call gets. */
function setBridge(answer: Answer) {
  const taskIssues = vi.fn(async (repositoryId: string, operation: string, payload: Record<string, unknown>) => { void payload; return answer(repositoryId, operation); });
  Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { taskIssues } });
  return taskIssues;
}
const statusCalls = (taskIssues: ReturnType<typeof setBridge>) => taskIssues.mock.calls.filter(([, operation]) => operation === "status");

const checkAgain = () => screen.getByRole("button", { name: "Check again" });
const rows = () => within(screen.getByRole("list", { name: "Repositories" })).getAllByRole("listitem");

beforeEach(() => {
  setInventory([entry(0, "pomegr"), entry(1, "catalogus")]);
  inventory.hook.mockImplementation(() => inventory.view);
});
afterEach(() => {
  Reflect.deleteProperty(window, "pomegrDesktop");
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Settings, GitHub section", () => {
  it("is listed after Providers, always, and opens from the section parameter", async () => {
    render(<SettingsPage />);
    const names = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(names.indexOf("GitHub")).toBe(names.indexOf("Providers") + 1);
    expect(names.indexOf("Storage")).toBe(names.indexOf("GitHub") + 1);
    const element = await SettingsRoute({ searchParams: Promise.resolve({ section: "github" }) });
    expect(element.props).toMatchObject({ initialSection: "github" });
    expect((await SettingsRoute({ searchParams: Promise.resolve({ section: "elsewhere" }) })).props).toMatchObject({ initialSection: "appearance" });
  });

  it("reads nothing in a browser and shows one desktop only row", async () => {
    const fetchStub = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchStub);
    render(<SettingsPage initialSection="github" />);
    expect(await screen.findByRole("heading", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByText("Pomegr uses your own GitHub CLI session and never reads or stores a GitHub token.")).toBeInTheDocument();
    expect(screen.getByText("GitHub is connected in the Pomegr desktop app.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub CLI" })).not.toBeInTheDocument();
    expect(inventory.hook).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reads once on open, one repository after another, and again only on Check again", async () => {
    const gates = new Map<string, (answer: unknown) => void>();
    const taskIssues = setBridge((repositoryId) => new Promise((resolve) => { gates.set(repositoryId, resolve); }));
    const { rerender } = render(<SettingsPage initialSection="github" />);
    const section = screen.getByRole("region", { name: "GitHub" });
    await waitFor(() => expect(taskIssues).toHaveBeenCalledTimes(1));
    expect(taskIssues).toHaveBeenLastCalledWith(idOf(0), "status", {});
    expect(section).toHaveAttribute("aria-busy", "true");
    expect(checkAgain()).toBeDisabled();

    const release = async (repositoryId: string, answer: unknown) => {
      await waitFor(() => expect(gates.has(repositoryId)).toBe(true));
      await act(async () => { gates.get(repositoryId)?.(answer); });
      gates.delete(repositoryId);
    };
    // The second repository is asked only after the first one answered.
    expect(gates.has(idOf(1))).toBe(false);
    await release(idOf(0), connected());
    await waitFor(() => expect(taskIssues).toHaveBeenCalledTimes(2));
    expect(taskIssues).toHaveBeenLastCalledWith(idOf(1), "status", {});
    await release(idOf(1), connected("public"));
    await waitFor(() => expect(section).toHaveAttribute("aria-busy", "false"));
    expect(checkAgain()).toBeEnabled();

    // A new inventory revision, focus, and the page becoming visible do not read.
    setInventory([entry(0, "pomegr"), entry(1, "catalogus"), entry(2, "clapline")]);
    rerender(<SettingsPage initialSection="github" />);
    fireEvent.focus(window);
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await Promise.resolve(); });
    expect(taskIssues).toHaveBeenCalledTimes(2);

    await userEvent.click(checkAgain());
    await waitFor(() => expect(taskIssues).toHaveBeenCalledTimes(3));
    expect(taskIssues).toHaveBeenLastCalledWith(idOf(0), "status", {});
    expect(section).toHaveAttribute("aria-busy", "true");
    // The previous rows stay while the new read runs.
    expect(rows()).toHaveLength(2);
    await release(idOf(0), connected());
    await release(idOf(1), connected());
    await release(idOf(2), connected());
    await waitFor(() => expect(section).toHaveAttribute("aria-busy", "false"));
    expect(statusCalls(taskIssues)).toHaveLength(5);
    expect(rows()).toHaveLength(3);
  });

  it("shows the connected state with a row for each repository and the fixed capability words", async () => {
    setBridge((repositoryId) => repositoryId === idOf(0) ? connected("private", ["read_issues", "create_issues"]) : connected("public", ["read_issues"]));
    render(<SettingsPage initialSection="github" />);
    expect(await screen.findByText("Connected through GitHub CLI")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub CLI" })).not.toBeInTheDocument();
    const [first, second] = rows();
    expect(first).toHaveTextContent("pomegr");
    expect(within(first).getByText("Private")).toBeInTheDocument();
    expect(within(first).getByText("Can read issues")).toBeInTheDocument();
    expect(within(first).getByText("Can create issues")).toBeInTheDocument();
    expect(second).toHaveTextContent("catalogus");
    expect(within(second).getByText("Public")).toBeInTheDocument();
    expect(within(second).getByText("Can read issues")).toBeInTheDocument();
    expect(within(second).queryByText("Can create issues")).not.toBeInTheDocument();
  });

  it("words issues turned off and no access, draws no chip for unknown visibility, and marks a repository that could not be checked", async () => {
    setInventory([entry(0, "alpha"), entry(1, "beta"), entry(2, "gamma"), entry(3, "delta")]);
    setBridge((repositoryId) => {
      if (repositoryId === idOf(0)) return connected("private", ["issues_disabled"]);
      if (repositoryId === idOf(1)) return connected("unknown", ["no_access"]);
      if (repositoryId === idOf(2)) return { ok: false, error: "unavailable" };
      return status("connected", null);
    });
    render(<SettingsPage initialSection="github" />);
    await screen.findByText("Connected through GitHub CLI");
    const [alpha, beta, gamma, delta] = rows();
    expect(within(alpha).getByText("Issues are turned off")).toBeInTheDocument();
    expect(within(alpha).getByText("Private")).toBeInTheDocument();
    expect(within(beta).getByText("No access")).toBeInTheDocument();
    expect(within(beta).queryByText(/^(Private|Public)$/)).not.toBeInTheDocument();
    expect(within(gamma).getByText("Could not be checked.")).toBeInTheDocument();
    expect(within(delta).getByText("Could not be checked.")).toBeInTheDocument();
  });

  it("stops after the first call when GitHub is not signed in and offers the sign-in", async () => {
    const taskIssues = setBridge(() => status("not_signed_in"));
    render(<SettingsPage initialSection="github" />);
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with GitHub CLI" })).toBeEnabled();
    expect(screen.queryByRole("list", { name: "Repositories" })).not.toBeInTheDocument();
    expect(screen.queryByText("Repositories")).not.toBeInTheDocument();
    expect(taskIssues).toHaveBeenCalledTimes(1);
  });

  it("stops after the first call when the GitHub CLI is not installed and offers no action but Check again", async () => {
    const taskIssues = setBridge(() => status("cli_missing"));
    render(<SettingsPage initialSection="github" />);
    expect(await screen.findByText("GitHub CLI not installed")).toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub CLI" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(checkAgain()).toBeEnabled();
    expect(taskIssues).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["opened", "Finish signing in in the terminal, then choose Check again."],
    ["cli_missing", "The GitHub CLI was not found on this computer."],
    ["unsupported_platform", "Signing in from Pomegr is available on Windows."],
    ["unavailable", "Pomegr could not open the GitHub CLI sign-in. Try again."],
  ])("signs in through the first repository and says one fixed line for %s", async (signInStatus, line) => {
    const taskIssues = setBridge((_repositoryId, operation) => operation === "sign_in" ? { ok: true, status: signInStatus } : status("not_signed_in"));
    render(<SettingsPage initialSection="github" />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub CLI" }));
    expect(await screen.findByRole("status")).toHaveTextContent(line);
    expect(taskIssues).toHaveBeenLastCalledWith(idOf(0), "sign_in", {});
    expect(statusCalls(taskIssues)).toHaveLength(1);
  });

  it("says nothing after a cancelled sign-in and clears the line on the next check", async () => {
    let answer = "cancelled";
    const taskIssues = setBridge((_repositoryId, operation) => operation === "sign_in" ? { ok: true, status: answer } : status("not_signed_in"));
    render(<SettingsPage initialSection="github" />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub CLI" }));
    await waitFor(() => expect(taskIssues).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    answer = "opened";
    await userEvent.click(screen.getByRole("button", { name: "Sign in with GitHub CLI" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Finish signing in");
    await userEvent.click(checkAgain());
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("disables the sign-in while the native confirmation is open", async () => {
    let finish!: (answer: unknown) => void;
    setBridge((_repositoryId, operation) => operation === "sign_in" ? new Promise((resolve) => { finish = resolve; }) : status("not_signed_in"));
    render(<SettingsPage initialSection="github" />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub CLI" }));
    expect(screen.getByRole("button", { name: "Sign in with GitHub CLI" })).toBeDisabled();
    await act(async () => finish({ ok: true, status: "cancelled" }));
    expect(screen.getByRole("button", { name: "Sign in with GitHub CLI" })).toBeEnabled();
  });

  it("reads at most the first 16 repositories and says so in a quiet line", async () => {
    setInventory(Array.from({ length: 20 }, (_, index) => entry(index)));
    const taskIssues = setBridge(() => connected());
    render(<SettingsPage initialSection="github" />);
    expect(await screen.findByText("Showing the first 16 of 20 repositories.")).toBeInTheDocument();
    expect(rows()).toHaveLength(16);
    expect(statusCalls(taskIssues).map(([repositoryId]) => repositoryId)).toEqual(Array.from({ length: 16 }, (_, index) => idOf(index)));
  });

  it("says no repository is known and reads nothing until the inventory names one", async () => {
    setInventory([]);
    const taskIssues = setBridge(() => connected());
    const { rerender } = render(<SettingsPage initialSection="github" />);
    expect(await screen.findByText("No repository is known yet, so the connection cannot be read.")).toBeInTheDocument();
    expect(checkAgain()).toBeDisabled();
    expect(taskIssues).not.toHaveBeenCalled();
    setInventory([entry(0, "pomegr")]);
    rerender(<SettingsPage initialSection="github" />);
    expect(await screen.findByText("Connected through GitHub CLI")).toBeInTheDocument();
    expect(taskIssues).toHaveBeenCalledTimes(1);
  });

  it("waits for the inventory to load before it reads", async () => {
    setInventory([entry(0, "pomegr")], true);
    const taskIssues = setBridge(() => connected());
    const { rerender } = render(<SettingsPage initialSection="github" />);
    expect(screen.getByText("Checking the GitHub CLI…")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "GitHub" })).toHaveAttribute("aria-busy", "true");
    expect(taskIssues).not.toHaveBeenCalled();
    setInventory([entry(0, "pomegr")]);
    rerender(<SettingsPage initialSection="github" />);
    await screen.findByText("Connected through GitHub CLI");
    expect(taskIssues).toHaveBeenCalledTimes(1);
  });

  it("stops and says so when the first call fails, and recovers on Check again", async () => {
    let healthy = false;
    const taskIssues = setBridge(() => healthy ? connected() : { ok: false, error: "unavailable" });
    render(<SettingsPage initialSection="github" />);
    expect(await screen.findByText("The connection could not be checked. Choose Check again.")).toBeInTheDocument();
    expect(taskIssues).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("list", { name: "Repositories" })).not.toBeInTheDocument();
    healthy = true;
    await userEvent.click(checkAgain());
    expect(await screen.findByText("Connected through GitHub CLI")).toBeInTheDocument();
  });

  it("shows fixed statuses only, never a username, path, URL or error text", async () => {
    setBridge((repositoryId) => repositoryId === idOf(0)
      ? { ok: true, connection: "connected", login: "octocat", account: "https://github.com/octocat", repository: { visibility: "private", capabilities: ["read_issues"], path: "C:\\Users\\octocat\\pomegr", url: "https://github.com/octocat/pomegr" } }
      : { ok: false, error: "C:\\Users\\octocat\\token ghp_secret" });
    render(<SettingsPage initialSection="github" />);
    await screen.findByText("Connected through GitHub CLI");
    const text = screen.getByRole("region", { name: "GitHub" }).textContent ?? "";
    expect(text).not.toMatch(/octocat|ghp_|github\.com|C:\\/);
    expect(rows()[1]).toHaveTextContent("Could not be checked.");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders the design-system section from static data without the bridge", () => {
    const taskIssues = setBridge(() => connected());
    render(<GitHubSettingsSection />);
    const [connectedPane, limitPane, signedOutPane, missingPane, readingPane, browserPane] = screen.getAllByRole("region", { name: "GitHub" });
    expect(within(connectedPane).getByText("Connected")).toBeInTheDocument();
    expect(within(connectedPane).getAllByRole("listitem")).toHaveLength(5);
    expect(within(limitPane).getByText("Showing the first 16 of 20 repositories.")).toBeInTheDocument();
    expect(within(signedOutPane).getByText("Not signed in")).toBeInTheDocument();
    expect(within(signedOutPane).getByRole("button", { name: "Sign in with GitHub CLI" })).toBeInTheDocument();
    expect(within(missingPane).getByText("GitHub CLI not installed")).toBeInTheDocument();
    expect(readingPane).toHaveAttribute("aria-busy", "true");
    expect(within(readingPane).getByRole("button", { name: "Check again" })).toBeDisabled();
    expect(within(browserPane).getByText("GitHub is connected in the Pomegr desktop app.")).toBeInTheDocument();
    expect(taskIssues).not.toHaveBeenCalled();
    expect(inventory.hook).not.toHaveBeenCalled();
  });
});
