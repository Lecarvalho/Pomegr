import { render, screen, within } from "@testing-library/react";
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

beforeEach(() => { navigation.search = ""; vi.clearAllMocks(); });
afterEach(() => vi.restoreAllMocks());
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
