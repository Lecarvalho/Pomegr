import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";

const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn(), push: vi.fn(), notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }), redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }) }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
  notFound: navigation.notFound, redirect: navigation.redirect,
}));
vi.mock("../../app/provider-status-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/provider-status-client")>();
  return { ...actual, useProviderStatus: () => actual.EMPTY_PROVIDER_STATUS };
});

import { RepositoryDetailView } from "../../app/components/repositories/RepositoryDetailView";
import { CommandCenterShell } from "../../app/components/command-center/CommandCenterShell";
import RepositoryPage from "../../app/repositories/[repositoryId]/page";
import RepositoriesPage from "../../app/repositories/page";
import SessionsPage from "../../app/sessions/page";

const repositoryId = "repo-0123456789abcdef01234567";
const snapshot: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [{
  id: repositoryId, name: "Example project", displayName: "Example project", sessionCount: 3, liveCount: 1, historyCount: 2, providerCount: 1, updatedAt: null,
  providers: [{ provider: "codex", source: "Codex", sessionCount: 3, supported: false, status: "unavailable", failureKind: null, currentRevision: null, revisions: [] }],
}] };

const setupSnapshot: RepositoryInventorySnapshot = { revision: 2, readiness: "ready", repositories: [{
  id: repositoryId, name: "Example project", displayName: "Example project", sessionCount: 3, liveCount: 1, historyCount: 2, providerCount: 2, updatedAt: "2026-09-04T10:00:00.000Z",
  reporting: { status: "missing", version: null, checkedAt: "2026-09-04T10:00:00.000Z" },
  providers: [
    { provider: "claude", source: "Claude Code", sessionCount: 2, supported: true, status: "current", failureKind: null,
      pluginSetup: { readiness: "ready", installation: "installed", version: "0.5.0", enabled: true, scope: "project", checkedAt: "2026-09-04T10:00:00.000Z", update: { status: "available", version: "0.6.0", checkedAt: "2026-09-04T10:00:00.000Z" }, canInstall: false, canUpdate: true },
      currentRevision: { id: "ctx-001", capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200, categoryCount: 1, itemCount: 1, change: { state: "first_capture", previousRevisionId: null } },
      revisions: [{ id: "ctx-001", capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200, categoryCount: 1, itemCount: 1, change: { state: "first_capture", previousRevisionId: null } }] },
    { provider: "codex", source: "Codex", sessionCount: 1, supported: true, status: "not_captured", failureKind: null,
      pluginSetup: { readiness: "ready", installation: "not_installed", version: null, enabled: null, scope: null, checkedAt: "2026-09-04T10:00:00.000Z", update: { status: "unknown", version: null, checkedAt: null }, canInstall: true, canUpdate: false },
      currentRevision: null, revisions: [] },
  ],
}] };

beforeEach(() => { navigation.search = ""; vi.clearAllMocks(); });
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "pomegrDesktop");
});
function serve(body = snapshot) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
}

describe("repository detail shell", () => {
  it("renders the header, observed providers, five tabs, and View sessions link", async () => {
    serve();
    render(<RepositoryDetailView repositoryId={repositoryId} />);
    expect(await screen.findByRole("heading", { name: "Example project" })).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View sessions" })).toHaveAttribute("href", `/sessions?repository=${repositoryId}`);
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toHaveAttribute("id", "repository-panel-overview");
  });

  it("retains loading until the committed inventory is ready", async () => {
    serve({ ...snapshot, readiness: "loading", repositories: [] });
    render(<RepositoryDetailView repositoryId={repositoryId} />);
    expect(await screen.findByLabelText("Loading repository")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Repository" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Repository not observed")).not.toBeInTheDocument();
  });

  it("explains an unobserved repository and links back to the index", async () => {
    serve({ ...snapshot, repositories: [] });
    render(<RepositoryDetailView repositoryId={repositoryId} />);
    expect(await screen.findByRole("heading", { name: "Repository not observed" })).toBeInTheDocument();
    expect(screen.getByText("This repository has no observed sessions on this machine.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to repositories" })).toHaveAttribute("href", "/repositories");
  });

  it("uses sanitized unavailable copy when the monitor fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("private diagnostic"));
    render(<RepositoryDetailView repositoryId={repositoryId} />);
    expect(await screen.findByRole("heading", { name: "Repository inventory unavailable" })).toBeInTheDocument();
    expect(screen.queryByText(/private diagnostic/)).not.toBeInTheDocument();
  });

  it("switches URL tabs preserving inventory selection and other query parameters", async () => {
    serve();
    navigation.search = "tab=inventory&provider=claude&revision=ctx-001&logo=outline";
    const view = render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" />);
    await screen.findByRole("heading", { name: "Example project" });
    expect(screen.getByRole("tab", { name: "Context inventory" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Git Soon" }));
    expect(navigation.replace).toHaveBeenCalledWith(`/repositories/${repositoryId}?tab=git&provider=claude&revision=ctx-001&logo=outline`, { scroll: false });
    navigation.search = "tab=git&provider=claude&revision=ctx-001&logo=outline";
    view.rerender(<RepositoryDetailView repositoryId={repositoryId} initialTab="git" />);
    expect(screen.getByRole("heading", { name: "Detailed repository evidence is coming soon" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Git Soon" })).toHaveAttribute("aria-selected", "true");
    navigation.search = "";
    view.rerender(<RepositoryDetailView repositoryId={repositoryId} initialTab="overview" />);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  });

  it("supports keyboard movement and associates tabs with their panel", async () => {
    serve();
    render(<RepositoryDetailView repositoryId={repositoryId} />);
    await screen.findByRole("heading", { name: "Example project" });
    screen.getByRole("tab", { name: "Overview" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Setup" })).toHaveFocus();
    expect(navigation.replace).toHaveBeenLastCalledWith(`/repositories/${repositoryId}?tab=setup`, { scroll: false });
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Git Soon" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-controls", screen.getByRole("tabpanel").id);
  });

  it("uses the session breadcrumb markup and current navigation on repository routes", async () => {
    serve();
    const { container } = render(<CommandCenterShell pathname={`/repositories/${repositoryId}`} sessions={[]} connected loading={false}><div /></CommandCenterShell>);
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toHaveClass("sessionBreadcrumb");
    expect(await within(breadcrumb).findByText("Example project")).toHaveAttribute("aria-current", "page");
    expect(within(breadcrumb).getByRole("link", { name: "Repositories" })).toHaveAttribute("href", "/repositories");
    expect(container.querySelector(".commandHeader")).toHaveClass("hasBreadcrumb");
    expect(container.querySelector('.commandNavItem[href="/repositories"]')).toHaveAttribute("aria-current", "page");
  });
});

describe("repository detail setup", () => {
  it("renders each provider's plugin and inventory rows and one shared reporting row", async () => {
    serve(setupSnapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    expect(await screen.findByRole("heading", { name: "Setup" })).toBeInTheDocument();
    const pane = screen.getByRole("tabpanel", { name: "Setup" });
    expect(within(pane).getByText("Claude Code")).toBeInTheDocument();
    expect(within(pane).getByText("Codex")).toBeInTheDocument();
    expect(within(pane).getAllByText("Pomegr plugin")).toHaveLength(2);
    expect(within(pane).getAllByText("Context inventory")).toHaveLength(2);
    expect(within(pane).getByText("Shared by both providers")).toBeInTheDocument();
    expect(within(pane).getAllByText("Repository reporting")).toHaveLength(1);
    expect(within(pane).getByText(/Raw configuration never leaves this machine/i)).toBeInTheDocument();
  });

  it("uses desktop plugin actions through the bridge and keeps outcomes sanitized", async () => {
    const pluginAction = vi.fn().mockResolvedValue("completed");
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { repositoryPluginAction: pluginAction } });
    serve(setupSnapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    await userEvent.click(screen.getByRole("button", { name: "Update plugin" }));
    await waitFor(() => expect(pluginAction).toHaveBeenCalledWith(repositoryId, "claude", "update"));
    expect(await screen.findByText(/Reload Claude Code before starting a new session/i)).toBeInTheDocument();
    pluginAction.mockResolvedValueOnce("timed_out");
    await userEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    await waitFor(() => expect(pluginAction).toHaveBeenCalledWith(repositoryId, "codex", "install"));
    expect(await screen.findByText(/timed out. Recheck the local setup/i)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Recheck" })[1]);
    await waitFor(() => expect(pluginAction).toHaveBeenCalledWith(repositoryId, "codex", "recheck"));
  });

  it("confirms, cancels, and runs a desktop inventory capture inline", async () => {
    const capture = vi.fn().mockResolvedValue("completed");
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { captureRepositoryContextInventory: capture } });
    serve(setupSnapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    await userEvent.click(screen.getByRole("button", { name: "Capture again" }));
    const confirmation = screen.getByRole("group", { name: /Confirm Claude Code inventory capture/i });
    await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: /Confirm Claude Code inventory capture/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Capture again" }));
    await userEvent.click(within(screen.getByRole("group", { name: /Confirm Claude Code inventory capture/i })).getByRole("button", { name: "Run diagnostic" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith(repositoryId, "claude"));
    expect(await screen.findByText("Claude Code inventory captured.")).toBeInTheDocument();
  });

  it("offers instructions and no primary plugin or capture actions away from desktop", async () => {
    serve(setupSnapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    expect(screen.getAllByText("View setup instructions")).toHaveLength(2);
    expect(screen.getAllByText("Capture available in Pomegr desktop")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Install plugin|Update plugin|Capture inventory|Capture again|Retry diagnostic/i })).not.toBeInTheDocument();
  });

  it("opens a provider inventory without retaining a stale revision and keeps feedback across tab switches", async () => {
    const pluginAction = vi.fn().mockResolvedValue("completed");
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { repositoryPluginAction: pluginAction } });
    serve(setupSnapshot);
    navigation.search = "tab=setup&provider=codex&revision=ctx-999";
    const view = render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    await userEvent.click(screen.getByRole("button", { name: "Open inventory" }));
    expect(navigation.replace).toHaveBeenLastCalledWith(`/repositories/${repositoryId}?tab=inventory&provider=claude`, { scroll: false });
    await userEvent.click(screen.getByRole("button", { name: "Update plugin" }));
    expect(await screen.findByText(/Reload Claude Code before starting a new session/i)).toBeInTheDocument();
    navigation.search = "tab=inventory&provider=claude";
    view.rerender(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" />);
    navigation.search = "tab=setup";
    view.rerender(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    expect(screen.getByText(/Reload Claude Code before starting a new session/i)).toBeInTheDocument();
  });

  it.each([
    ["cancelled", "No plugin changes were made."],
    ["busy", "A plugin action is already running."],
    ["timed_out", "The plugin action timed out. Recheck the local setup before trying again."],
    ["failed", "The plugin action could not finish. Recheck the local setup before trying again."],
    ["unavailable", "This plugin action is unavailable in the current Pomegr desktop version."],
  ] as const)("keeps the %s plugin outcome bounded", async (status, message) => {
    const pluginAction = vi.fn().mockResolvedValue(status);
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { repositoryPluginAction: pluginAction } });
    serve(setupSnapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    await userEvent.click(screen.getByRole("button", { name: "Update plugin" }));
    await waitFor(() => expect(pluginAction).toHaveBeenCalledWith(repositoryId, "claude", "update"));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("sanitizes a rejected inventory capture", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("private provider output"));
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { captureRepositoryContextInventory: capture } });
    serve(setupSnapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    await userEvent.click(screen.getByRole("button", { name: "Capture again" }));
    await userEvent.click(within(screen.getByRole("group", { name: /Confirm Claude Code inventory capture/i })).getByRole("button", { name: "Run diagnostic" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith(repositoryId, "claude"));
    expect(await screen.findByText("Claude Code inventory capture failed.")).toBeInTheDocument();
    expect(screen.queryByText(/private provider output/i)).not.toBeInTheDocument();
  });

  it("shows a retained revision while capture is in progress", async () => {
    const capturing = structuredClone(setupSnapshot);
    capturing.repositories[0].providers[0].status = "capturing";
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { captureRepositoryContextInventory: vi.fn() } });
    serve(capturing);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    expect(screen.getByText("Capturing")).toBeInTheDocument();
    expect(screen.getByText("Previous revision remains available until commit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture again" })).toBeDisabled();
  });

  it("shows a sanitized failed inventory state even when the previous revision remains retained", async () => {
    const failed = structuredClone(setupSnapshot);
    failed.repositories[0].providers[0].status = "failed";
    failed.repositories[0].providers[0].failureKind = "timed_out";
    serve(failed);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("The diagnostic timed out · no data saved")).toBeInTheDocument();
  });

  it("toggles the local reporting setup help", async () => {
    serve(setupSnapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    const help = screen.getByRole("button", { name: "How reporting works" });
    expect(help).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(help);
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("/pomegr:init", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("$pomegr:init", { selector: "code" })).toBeInTheDocument();
  });
});

describe("repository routes", () => {
  it.each(["x", "repo-0123456789abcdef0123456", "repo-0123456789abcdef0123456g", "../settings", `${repositoryId}/extra`])("rejects invalid detail id %s", async (id) => {
    await expect(RepositoryPage({ params: Promise.resolve({ repositoryId: id }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  });
  it("passes validated detail selections and discards invalid or repeated parameters", async () => {
    const page = await RepositoryPage({ params: Promise.resolve({ repositoryId }), searchParams: Promise.resolve({ tab: "inventory", provider: "claude", revision: "ctx-001" }) });
    expect(page.props).toMatchObject({ repositoryId, initialTab: "inventory", initialProvider: "claude", initialRevisionId: "ctx-001" });
    const invalid = await RepositoryPage({ params: Promise.resolve({ repositoryId }), searchParams: Promise.resolve({ tab: ["git"], provider: "other", revision: "ctx-12" }) });
    expect(invalid.props).toMatchObject({ initialTab: "overview", initialProvider: undefined, initialRevisionId: undefined });
  });
  it("redirects legacy links to inventory with only validated parameters", async () => {
    await expect(RepositoriesPage({ searchParams: Promise.resolve({ repository: repositoryId, provider: "codex", revision: "ctx-123" }) })).rejects.toThrow(`REDIRECT:/repositories/${repositoryId}?tab=inventory&provider=codex&revision=ctx-123`);
    await expect(RepositoriesPage({ searchParams: Promise.resolve({ repository: repositoryId, provider: ["codex"], revision: "ctx-0000000000" }) })).rejects.toThrow(`REDIRECT:/repositories/${repositoryId}?tab=inventory`);
    await RepositoriesPage({ searchParams: Promise.resolve({ repository: "../settings" }) });
    expect(navigation.redirect).toHaveBeenCalledTimes(2);
  });
  it("validates the Sessions repository filter independently of the project", async () => {
    const page = await SessionsPage({ searchParams: Promise.resolve({ repository: repositoryId, project: "Example" }) });
    expect(page.props).toMatchObject({ initialRepositoryId: repositoryId, initialProject: "Example" });
    const invalid = await SessionsPage({ searchParams: Promise.resolve({ repository: [repositoryId] }) });
    expect(invalid.props.initialRepositoryId).toBeUndefined();
  });
});
