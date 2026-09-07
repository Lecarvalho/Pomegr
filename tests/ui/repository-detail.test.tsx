import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextInventoryRevisionDetail, RepositoryInventorySnapshot, SessionSummary } from "../../shared/monitor-contract";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { encodeSessionRoute } from "../../shared/session-route.mjs";

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
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/repository-inventory")) {
      const params = new URL(url, "http://localhost").searchParams;
      const revisionId = params.get("revisionId") || "ctx-001";
      const detail = inventoryDetails[revisionId] || inventoryDetails["ctx-001"];
      return new Response(JSON.stringify(detail), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
}

const inventoryDetails: Record<string, ContextInventoryRevisionDetail> = {
  "ctx-001": { repositoryId, provider: "claude", id: "ctx-001", capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200, categoryCount: 2, itemCount: 2, change: { state: "changed", previousRevisionId: "ctx-000" }, categories: [{ name: "System prompt", tokens: "900", percentage: 75 }, { name: "Tools", tokens: "300", percentage: 25 }], groups: [{ id: "tools", label: "Tools", items: [{ name: "Read", detail: "provider tool", tokens: "300" }] }] },
  "ctx-002": { repositoryId, provider: "claude", id: "ctx-002", capturedAt: "2026-09-05T09:00:00.000Z", model: "claude-test", machineryTokens: 1500, categoryCount: 3, itemCount: 4, change: { state: "changed", previousRevisionId: "ctx-001" }, categories: [{ name: "System prompt", tokens: "1.1k", percentage: 73 }, { name: "Tools", tokens: "300", percentage: 20 }, { name: "Hooks", tokens: "100", percentage: 7 }], groups: [{ id: "tools", label: "Tools", items: [{ name: "Read", detail: "provider tool", tokens: "300" }, { name: "Write", detail: "provider tool", tokens: "200" }] }] },
};

describe("repository detail shell", () => {
  it("renders the header, observed providers, five tabs, and View sessions link", async () => {
    serve();
    render(<RepositoryDetailView repositoryId={repositoryId} />);
    expect(await screen.findByRole("heading", { name: "Example project" })).toBeInTheDocument();
    expect(within(screen.getByRole("heading", { name: "Example project" }).closest("header")!).getByText("Codex")).toBeInTheDocument();
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
    expect(screen.getByText("Branch, working-tree, commit, and pull-request aggregation will be added when the monitor can provide a bounded repository summary. Current rows reflect session associations only.")).toBeInTheDocument();
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

describe("repository detail overview", () => {
  const session = (index: number, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
    id: `codex:overview-${index}`, provider: "codex", source: "Codex", title: `Synthetic session ${index}`, project: "Example project", repositoryId,
    createdAt: `2026-09-0${index}T10:00:00.000Z`, updatedAt: `2026-09-0${index}T10:00:00.000Z`, isLive: false, needsInput: false, activityStatus: "closed", summaryReadiness: "ready",
    agentCount: index, activeAgentCount: 0, latestContextTotal: 987654, progress: null, currentActivity: null, ...overrides,
  });
  const overview = () => within(screen.getByRole("tabpanel", { name: "Overview" }));
  function renderOverview(sessions: SessionSummary[] = [], options: { loading?: boolean; connected?: boolean } = {}) {
    return render(<SessionCatalogProvider sessions={sessions} {...options}><RepositoryDetailView repositoryId={repositoryId} /></SessionCatalogProvider>);
  }

  it("shows snapshot facts and linked setup summaries without session token aggregation", async () => {
    serve(setupSnapshot);
    renderOverview([session(1)]);
    await screen.findByRole("heading", { name: "Overview" });
    const pane = overview();
    const facts = pane.getByLabelText("Repository facts");
    expect(within(facts).getByText("Live sessions").nextElementSibling).toHaveTextContent("1");
    expect(within(facts).getByText("History").nextElementSibling).toHaveTextContent("2");
    expect(within(facts).getByText("Providers").nextElementSibling).toHaveTextContent("Claude CodeCodex");
    expect(pane.getByText("Plugin update available")).toHaveClass("warning");
    expect(pane.getByText("Not configured")).toHaveClass("neutral");
    expect(pane.getByText("ctx-001 saved")).toBeInTheDocument();
    expect(pane.getByText(/estimated tokens/)).toHaveTextContent("1,200 estimated tokens");
    expect(pane.getByRole("link", { name: "Open Setup" })).toHaveAttribute("href", `/repositories/${repositoryId}?tab=setup`);
    expect(pane.getByRole("link", { name: "Open reporting" })).toHaveAttribute("href", `/repositories/${repositoryId}?tab=reporting`);
    expect(pane.getByRole("link", { name: "Open inventory" })).toHaveAttribute("href", `/repositories/${repositoryId}?tab=inventory&provider=claude`);
    expect(pane.queryByText(/987654|987.7k|tokens\/|throughput/i)).not.toBeInTheDocument();
  });

  it("shows the best installed plugin and configured policy versions while naming unobserved provider setup", async () => {
    const body = structuredClone(setupSnapshot);
    body.repositories[0].providers[0].pluginSetup!.canUpdate = false;
    body.repositories[0].providers[1].sessionCount = 0;
    body.repositories[0].reporting = { status: "configured", version: 7, checkedAt: null };
    serve(body);
    renderOverview();
    await screen.findByRole("heading", { name: "Overview" });
    expect(overview().getByText("v0.5.0").parentElement).toHaveTextContent("Enabled · v0.5.0");
    expect(overview().getByText("v7").parentElement).toHaveTextContent("Configured · v7");
    expect(overview().getByText("Claude Code: enabled · Codex: not installed")).toBeInTheDocument();
  });

  it.each([
    ["loading", "Checking setup"], ["missing", "Plugin not installed"], ["disabled", "Plugin disabled"], ["unavailable", "Setup unverified"],
  ])("keeps %s plugin summary consistent with the Setup tab", async (kind, label) => {
    const body = structuredClone(setupSnapshot);
    const provider = body.repositories[0].providers[0];
    provider.pluginSetup!.canUpdate = false;
    body.repositories[0].providers = [provider];
    if (kind === "loading") provider.pluginSetup!.readiness = "loading";
    if (kind === "missing") { provider.pluginSetup!.installation = "not_installed"; provider.pluginSetup!.enabled = null; }
    if (kind === "disabled") provider.pluginSetup!.enabled = false;
    if (kind === "unavailable") { provider.pluginSetup!.readiness = "unavailable"; body.repositories[0].reporting = { status: "configured", version: 7, checkedAt: null }; }
    serve(body);
    const view = renderOverview();
    await screen.findByRole("heading", { name: "Overview" });
    expect(overview().getByText(label)).toBeInTheDocument();
    navigation.search = "tab=setup";
    view.rerender(<RepositoryDetailView repositoryId={repositoryId} />);
    expect(within(await screen.findByRole("tabpanel", { name: "Setup" })).getByText(label)).toBeInTheDocument();
  });

  it("keeps missing observations unavailable and failed capture status visible with retained evidence", async () => {
    const body = structuredClone(snapshot);
    body.repositories[0].providers[0].sessionCount = 0;
    serve(body);
    const view = renderOverview();
    await screen.findByRole("heading", { name: "Overview" });
    expect(overview().getByText("None observed")).toBeInTheDocument();
    expect(overview().getByText("Last activity").nextElementSibling).toHaveTextContent("—");
    view.unmount();
    const retained = structuredClone(setupSnapshot);
    retained.repositories[0].providers[0].status = "failed";
    serve(retained);
    renderOverview();
    await screen.findByRole("heading", { name: "Overview" });
    expect(overview().getByText("Failed")).toHaveClass("negative");
    expect(overview().getByText(/estimated tokens/)).toHaveTextContent("1,200 estimated tokens");
  });

  it("filters strictly by repository ID, sorts newest first, limits to five, and encodes session routes", async () => {
    serve();
    renderOverview([session(2), session(4), session(1), session(6), session(5), session(3), session(7, { repositoryId: "repo-ffffffffffffffffffffffff" }), session(8, { repositoryId: undefined })]);
    await screen.findByRole("heading", { name: "Overview" });
    const rows = overview().getAllByRole("link", { name: /Synthetic session/ });
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.textContent?.match(/Synthetic session \d/)?.[0])).toEqual([6, 5, 4, 3, 2].map((index) => `Synthetic session ${index}`));
    expect(rows[0]).toHaveAttribute("href", `/sessions/${encodeSessionRoute("codex:overview-6")}`);
    expect(overview().getByRole("link", { name: "View all 3" })).toHaveAttribute("href", `/sessions?repository=${repositoryId}`);
  });

  it("uses shared activity labels and treats a missing agent count as unavailable", async () => {
    serve();
    renderOverview([session(1, { activityStatus: "working", isLive: true, agentCount: null }), session(2, { activityStatus: "needs_input", isLive: true }), session(3, { activityStatus: "idle", isLive: true }), session(4)]);
    await screen.findByRole("heading", { name: "Overview" });
    expect(overview().getByText("In progress")).toHaveClass("positive");
    expect(overview().getByText("Needs input")).toHaveClass("warning");
    expect(overview().getByText("Idle")).toHaveClass("neutral");
    expect(overview().getByText("Closed")).toHaveClass("neutral");
    expect(overview().getByText("Agent count unavailable · Codex")).toBeInTheDocument();
  });

  it.each([
    ["legacy", "Sessions for this repository are listed once the monitor reports repository associations."],
    ["other", "No sessions for this repository in the current catalog."],
    ["loading", "Loading recent sessions…"],
    ["unavailable", "Session catalog unavailable. Pomegr will retry the local monitor automatically."],
  ])("explains the %s catalog state without guessing a repository association", async (kind, message) => {
    serve();
    renderOverview([session(1, { repositoryId: kind === "other" ? "repo-ffffffffffffffffffffffff" : undefined })], { loading: kind === "loading", connected: kind !== "unavailable" });
    await screen.findByRole("heading", { name: "Overview" });
    expect(overview().getByText(message)).toBeInTheDocument();
    expect(overview().queryByRole("link", { name: /Synthetic session/ })).not.toBeInTheDocument();
  });
});

describe("repository detail reporting", () => {
  it.each([
    { status: "configured", version: 7, label: "Configured", detail: "Shared repository policy · Version 7", action: "Review policy" },
    { status: "configured", version: null, label: "Configured", detail: "Shared repository reporting policy", action: "Review policy" },
    { status: "missing", version: null, label: "Not configured", detail: "Choose what agents report · Shared by Claude Code and Codex", action: "Configure reporting" },
    { status: "invalid", version: null, label: "Invalid", detail: "Review the repository reporting policy with your coding agent.", action: "Configure reporting" },
    { status: "unknown", version: null, label: "Unavailable", detail: "Reporting setup could not be verified.", action: "Configure reporting" },
    { status: undefined, version: null, label: "Unavailable", detail: "Reporting setup could not be verified.", action: "Configure reporting" },
  ] as const)("shares $status reporting status and version $version between tabs", async ({ status, version, label, detail, action }) => {
    const body = structuredClone(setupSnapshot);
    body.repositories[0].reporting = status ? { status, version, checkedAt: null } : undefined;
    serve(body);
    navigation.search = "tab=setup";
    const view = render(<RepositoryDetailView repositoryId={repositoryId} />);
    const setupRow = await screen.findByRole("region", { name: "Shared repository reporting" });
    expect(within(setupRow).getByText(label)).toBeInTheDocument();
    expect(within(setupRow).getByText(detail)).toBeInTheDocument();
    expect(within(setupRow).queryByText("Set up reporting in your coding agent")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Reporting" }));
    expect(navigation.replace).toHaveBeenLastCalledWith(`/repositories/${repositoryId}?tab=reporting`, { scroll: false });
    navigation.search = "tab=reporting";
    view.rerender(<RepositoryDetailView repositoryId={repositoryId} />);
    const reportingRow = screen.getByRole("region", { name: "Shared repository reporting" });
    expect(screen.getByRole("heading", { name: "Repository reporting" })).toBeInTheDocument();
    expect(within(reportingRow).getByText(label)).toBeInTheDocument();
    expect(within(reportingRow).getByText(detail)).toBeInTheDocument();
    expect(within(reportingRow).queryByRole("button", { name: "How reporting works" })).not.toBeInTheDocument();
    const help = within(reportingRow).getByText("Set up reporting in your coding agent").parentElement!;
    expect(help).toHaveTextContent("/pomegr:init");
    expect(help).toHaveTextContent("$pomegr:init");
    expect(within(help).getByRole("link", { name: "Read the plugin instructions" })).toHaveAttribute("href", "https://github.com/Lecarvalho/pomegr/blob/main/docs/PLUGINS.md");
    await userEvent.click(within(reportingRow).getByRole("button", { name: action }));
    expect(help).toHaveFocus();
    expect(help).toBeVisible();

    navigation.search = "tab=setup";
    view.rerender(<RepositoryDetailView repositoryId={repositoryId} />);
    const returnedRow = screen.getByRole("region", { name: "Shared repository reporting" });
    expect(within(returnedRow).getByText(label)).toBeInTheDocument();
    await userEvent.click(within(returnedRow).getByRole("button", { name: "How reporting works" }));
    expect(within(returnedRow).getByText("Set up reporting in your coding agent")).toBeVisible();
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
    await waitFor(() => expect(screen.getByRole("tab", { name: "Setup" })).toHaveFocus());
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
    expect(screen.getByRole("tab", { name: "Setup" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Capture again" }));
    await userEvent.click(within(screen.getByRole("group", { name: /Confirm Claude Code inventory capture/i })).getByRole("button", { name: "Run diagnostic" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith(repositoryId, "claude"));
    expect(await screen.findByText("Claude Code inventory captured.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Setup" })).toHaveFocus());
  });

  it("preserves focus moved elsewhere while a native action is pending", async () => {
    let finish!: (status: string) => void;
    const pluginAction = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { repositoryPluginAction: pluginAction } });
    serve(setupSnapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="setup" />);
    await screen.findByRole("heading", { name: "Setup" });
    await userEvent.click(screen.getByRole("button", { name: "Update plugin" }));
    screen.getByRole("link", { name: "View sessions" }).focus();
    await act(async () => { finish("completed"); });
    expect(await screen.findByText(/Reload Claude Code before starting a new session/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View sessions" })).toHaveFocus();
  });

  it("restores focus to the destination tab after Open inventory removes its action", async () => {
    serve(setupSnapshot);
    navigation.search = "tab=setup";
    const view = render(<RepositoryDetailView repositoryId={repositoryId} />);
    await screen.findByRole("heading", { name: "Setup" });
    await userEvent.click(screen.getByRole("button", { name: "Open inventory" }));
    navigation.search = "tab=inventory&provider=claude";
    view.rerender(<RepositoryDetailView repositoryId={repositoryId} />);
    expect(screen.getByRole("tab", { name: "Context inventory" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("tabpanel", { name: "Context inventory" })).toHaveFocus();
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

describe("repository context inventory", () => {
  function withRevisions() {
    const value = structuredClone(setupSnapshot);
    const provider = value.repositories[0].providers[0];
    provider.currentRevision = { ...provider.currentRevision!, id: "ctx-002", machineryTokens: 1500, categoryCount: 3, itemCount: 4, change: { state: "changed", previousRevisionId: "ctx-001" } };
    provider.revisions = [
      { ...provider.currentRevision, id: "ctx-002" },
      { ...provider.currentRevision, id: "ctx-001", machineryTokens: 1200, categoryCount: 2, itemCount: 2, change: { state: "changed", previousRevisionId: "ctx-000" } },
    ];
    return value;
  }

  it("opens a deep-linked provider and revision, scrolls it into view, and renders normalized evidence", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);
    navigation.search = "tab=inventory&provider=claude&revision=ctx-001";
    serve(withRevisions());
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="claude" initialRevisionId="ctx-001" />);
    expect(await screen.findByText("Revision", { selector: ".repositoryInventorySummary span" })).toBeInTheDocument();
    expect(screen.getByText("ctx-001", { selector: ".repositoryInventorySummary strong" })).toBeInTheDocument();
    expect(screen.getByText("System prompt")).toBeInTheDocument();
    expect(screen.getByText("Inspect 2 listed items")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(scroll).toHaveBeenCalled();
  });

  it("compares revisions, changes both revision selects, and preserves the selected URL state", async () => {
    navigation.search = "tab=inventory&provider=claude&revision=ctx-002";
    serve(withRevisions());
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="claude" initialRevisionId="ctx-002" />);
    await screen.findByText("Revision", { selector: ".repositoryInventorySummary span" });
    const selects = screen.getAllByLabelText("Revision");
    expect(selects).toHaveLength(2);
    await userEvent.selectOptions(selects[0], "ctx-001");
    expect(navigation.replace).toHaveBeenLastCalledWith(`/repositories/${repositoryId}?tab=inventory&provider=claude&revision=ctx-001`, { scroll: false });
    expect(await screen.findByText("-300 vs current")).toBeInTheDocument();
    expect(screen.getByText("-1 vs current")).toBeInTheDocument();
    expect(screen.getByText("-2 vs current")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Compare revisions", { selector: "summary" }));
    const comparisonSelects = screen.getAllByLabelText("Revision");
    expect(comparisonSelects).toHaveLength(2);
    await userEvent.selectOptions(comparisonSelects[1], "ctx-002");
    expect(navigation.replace).toHaveBeenLastCalledWith(`/repositories/${repositoryId}?tab=inventory&provider=claude&revision=ctx-002`, { scroll: false });
    expect(await screen.findByText("ctx-002", { selector: ".repositoryInventorySummary strong" })).toBeInTheDocument();
  });

  it.each([
    ["not_captured", "Not captured", "Native provider diagnostic"],
    ["capturing", "Capturing", "Previous revision remains available until commit"],
    ["unavailable", "Unavailable", "Pomegr will not combine or approximate Claude Code evidence."],
    ["failed", "Failed", "The diagnostic timed out · no data saved"],
  ] as const)("renders sanitized %s state", async (status, label, detail) => {
    const value = structuredClone(setupSnapshot);
    const provider = value.repositories[0].providers[0];
    provider.status = status;
    if (status === "failed") provider.failureKind = "timed_out";
    if (status !== "failed") provider.failureKind = null;
    serve(value);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="claude" />);
    expect(await screen.findAllByText(label)).not.toHaveLength(0);
    expect(screen.getAllByText(detail)).not.toHaveLength(0);
    expect(screen.queryByText(/private|stdout|stderr/i)).not.toBeInTheDocument();
  });

  it.each([
    ["executable_unavailable", "Claude Code executable unavailable"],
    ["timed_out", "The diagnostic timed out"],
    ["invalid_output", "Claude Code returned an unsupported diagnostic format"],
    ["runtime_unavailable", "The local diagnostic could not run"],
  ] as const)("maps %s to bounded failure text", async (kind, message) => {
    const value = structuredClone(setupSnapshot);
    value.repositories[0].providers[0].status = "failed";
    value.repositories[0].providers[0].failureKind = kind;
    serve(value);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="claude" />);
    expect(await screen.findByText(`${message} · no data saved`)).toBeInTheDocument();
  });

  it("handles pending, retained-missing, and rejected detail fetches without leaking errors", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).startsWith("/api/repository-inventory") ? pending : new Response(JSON.stringify(setupSnapshot)));
    const { unmount } = render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="claude" />);
    expect(await screen.findByText("Loading saved inventory…")).toBeInTheDocument();
    resolve(new Response(null, { status: 404 }));
    expect(await screen.findByText("Detailed evidence is no longer retained for this revision.")).toBeInTheDocument();
    unmount();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).startsWith("/api/repository-inventory") ? Promise.reject(new Error("private provider output")) : new Response(JSON.stringify(setupSnapshot)));
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="claude" />);
    expect(await screen.findByText("Detailed evidence is no longer retained for this revision.")).toBeInTheDocument();
    expect(screen.queryByText(/private provider output/)).not.toBeInTheDocument();
  });

  it("captures the selected provider inline on desktop and gives browser clients a hint", async () => {
    const capture = vi.fn().mockResolvedValue("completed");
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { captureRepositoryContextInventory: capture } });
    serve(setupSnapshot);
    const desktopView = render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="claude" />);
    await screen.findByText("Context inventory", { selector: "h2" });
    await userEvent.click(screen.getByRole("button", { name: "Capture again" }));
    await userEvent.click(screen.getByRole("button", { name: "Run diagnostic" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith(repositoryId, "claude"));
    expect(await screen.findByText("Claude Code inventory captured.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Capture provider"), "codex");
    expect(navigation.replace).toHaveBeenLastCalledWith(`/repositories/${repositoryId}?tab=inventory&provider=codex`, { scroll: false });
    navigation.search = "tab=inventory&provider=codex";
    desktopView.rerender(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="codex" />);
    await userEvent.click(screen.getByRole("button", { name: "Capture inventory" }));
    await userEvent.click(screen.getByRole("button", { name: "Run diagnostic" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith(repositoryId, "codex"));
    desktopView.unmount();
    Reflect.deleteProperty(window, "pomegrDesktop");
    serve(setupSnapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="claude" />);
    expect(await screen.findByText("Capture available in Pomegr desktop")).toBeInTheDocument();
  });

  it("falls back an unretained deep-link revision to current and ignores an aborted old detail response", async () => {
    const value = withRevisions();
    let firstResolve!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { firstResolve = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/repository-inventory")) return url.includes("ctx-002") ? first : new Response(JSON.stringify(inventoryDetails["ctx-001"]));
      return new Response(JSON.stringify(value));
    });
    navigation.search = "tab=inventory&provider=claude&revision=ctx-999";
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" initialProvider="claude" initialRevisionId="ctx-999" />);
    expect(await screen.findByText("Loading saved inventory…")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Revision")[0]).toHaveValue("ctx-002");
    await userEvent.selectOptions(screen.getAllByLabelText("Revision")[0], "ctx-001");
    expect(await screen.findByText("ctx-001", { selector: ".repositoryInventorySummary strong" })).toBeInTheDocument();
    firstResolve(new Response(JSON.stringify(inventoryDetails["ctx-002"])));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("ctx-001", { selector: ".repositoryInventorySummary strong" })).toBeInTheDocument();
  });

  it("filters unsupported providers from the inventory tab", async () => {
    serve(snapshot);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="inventory" />);
    expect(await screen.findByText("Context inventory is unavailable for the observed providers.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Codex context inventory" })).not.toBeInTheDocument();
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
