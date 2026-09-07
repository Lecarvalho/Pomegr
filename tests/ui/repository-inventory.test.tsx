import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepositoriesView } from "../../app/components/command-center/CommandViews";
import { MachineryPanel } from "../../app/components/dashboard/MachineryPanel";
import { useRepositoryInventory } from "../../app/repository-inventory-client";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";

const repositoryId = "repo-0123456789abcdef01234567";
const snapshot: RepositoryInventorySnapshot = {
  revision: 1,
  readiness: "ready",
  repositories: [{
    id: repositoryId, name: "Pomegr", displayName: "Pomegr", sessionCount: 3, liveCount: 1, historyCount: 2,
    providerCount: 2, updatedAt: "2026-09-04T10:00:00.000Z",
    reporting: { status: "missing", version: null, checkedAt: "2026-09-04T10:00:00.000Z" },
    providers: [{ provider: "claude", source: "Claude Code", sessionCount: 2, supported: true, status: "current", failureKind: null,
      pluginSetup: { readiness: "ready", installation: "installed", version: "0.5.0", enabled: true, scope: "user", checkedAt: "2026-09-04T10:00:00.000Z", update: { status: "available", version: "0.6.0", checkedAt: "2026-09-04T10:00:00.000Z" }, canInstall: false, canUpdate: true },
      currentRevision: { id: "ctx-001", capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200,
        categoryCount: 1, itemCount: 1, change: { state: "first_capture", previousRevisionId: null } },
      revisions: [{ id: "ctx-001", capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200,
        categoryCount: 1, itemCount: 1, change: { state: "first_capture", previousRevisionId: null } }] },
    { provider: "codex", source: "Codex", sessionCount: 1, supported: false, status: "unavailable", failureKind: null,
      pluginSetup: { readiness: "ready", installation: "not_installed", version: null, enabled: null, scope: null, checkedAt: "2026-09-04T10:00:00.000Z", update: { status: "unknown", version: null, checkedAt: null }, canInstall: true, canUpdate: false },
      currentRevision: null, revisions: [] }],
  }],
};

function RefreshProbe({ onReady }: { onReady: (refresh: (force?: boolean) => Promise<void>) => void }) {
  const { refresh } = useRepositoryInventory();
  useEffect(() => onReady(refresh), [onReady, refresh]);
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "pomegrDesktop");
});

describe("repository index", () => {
  function serve(repositories = snapshot.repositories) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).startsWith("/api/repositories")
      ? new Response(JSON.stringify({ ...snapshot, repositories }), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response(null, { status: 404 }));
  }

  function readyRepository() {
    const repository = structuredClone(snapshot.repositories[0]);
    repository.id = "repo-aaaaaaaaaaaaaaaaaaaaaaaa";
    repository.name = repository.displayName = "Example library";
    repository.liveCount = 0;
    repository.historyCount = repository.sessionCount;
    repository.reporting = { status: "configured", version: 1, checkedAt: null };
    for (const provider of repository.providers) {
      provider.pluginSetup = { ...provider.pluginSetup!, installation: "installed", enabled: true, canUpdate: false };
    }
    return repository;
  }

  it("renders named repository links, observed providers, counts and setup chips without disclosures or native actions", async () => {
    serve([snapshot.repositories[0], readyRepository()]);
    const { container } = render(<RepositoriesView />);
    const row = await screen.findByRole("link", { name: "Pomegr, Plugin update available" });
    expect(row).toHaveAttribute("href", `/repositories/${repositoryId}`);
    expect(row).not.toHaveAttribute("aria-expanded");
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(within(row).getByText("Plugin update available")).toHaveClass("commandChip", "warning");
    expect(within(row).getByText("Claude Code")).toBeInTheDocument();
    expect(within(row).getByText("Codex")).toBeInTheDocument();
    expect(row.querySelector(".commandRepositorySessions")).toHaveTextContent("1 live·2 history");
    expect(within(screen.getByRole("link", { name: "Example library, Ready" })).getByText("Ready")).toHaveClass("positive");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("2 repositories · 1 needs attention")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Capture|Install|Update plugin/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Rows reflect session associations only/)).toHaveClass("commandRepositoryFootnote");
    expect(screen.queryByRole("heading", { name: /coming soon/i })).not.toBeInTheDocument();
  });

  it("composes search with attention and live filters and restores All", async () => {
    const live = readyRepository();
    live.id = "repo-bbbbbbbbbbbbbbbbbbbbbbbb";
    live.name = live.displayName = "Example live";
    live.liveCount = 1;
    serve([snapshot.repositories[0], readyRepository(), live]);
    render(<RepositoriesView />);
    await screen.findByRole("link", { name: "Pomegr, Plugin update available" });
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Needs attention" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Live now" }));
    expect(screen.getAllByRole("link")).toHaveLength(2);
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter repositories" }), " example ");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Example live, Ready" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("link")).toHaveLength(2);
    await userEvent.clear(screen.getByRole("searchbox"));
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("explains empty filters and a search with no matches", async () => {
    serve([readyRepository()]);
    render(<RepositoriesView />);
    await screen.findByRole("link", { name: "Example library, Ready" });
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getByRole("heading", { name: "No repositories need attention" })).toBeInTheDocument();
    expect(screen.getByText("Clear the filter to see all 1 repositories.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Live now" }));
    expect(screen.getByRole("heading", { name: "No repositories are live now" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "absent");
    expect(screen.getByRole("heading", { name: "No repositories match" })).toBeInTheDocument();
  });

  it("preserves the empty observed state", async () => {
    serve([]);
    render(<RepositoriesView />);
    expect(await screen.findByRole("heading", { name: "No repositories observed" })).toBeInTheDocument();
  });

  it("preserves the monitor unavailable state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    render(<RepositoriesView />);
    expect(await screen.findByRole("heading", { name: "Repository inventory unavailable" })).toBeInTheDocument();
  });

  it("shows loading before data arrives", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    render(<RepositoriesView />);
    expect(screen.getByRole("region", { name: "Repositories" })).toHaveAttribute("aria-busy", "true");
  });
  it("serializes a forced refresh behind an in-flight poll", async () => {
    const replies: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => replies.push(resolve)));
    let refresh: ((force?: boolean) => Promise<void>) | null = null;
    render(<RefreshProbe onReady={(next) => { refresh = next; }} />);
    await waitFor(() => expect(refresh).not.toBeNull());
    await waitFor(() => expect(replies).toHaveLength(1));
    const forced = refresh!(true);
    replies.shift()!(new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(replies).toHaveLength(1));
    replies.shift()!(new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } }));
    await forced;
  });

  it("renders a compact immutable session reference and never asks for /context", () => {
    render(<MachineryPanel machinery={null} supported historical={false} inventoryRef={{ repositoryId, provider: "claude", revisionId: "ctx-001",
      capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200, categoryCount: 1, itemCount: 1, detailRetained: true }} />);
    expect(screen.getByText(/available when this session started/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open ctx-001" })).toHaveAttribute("href", expect.stringContaining("/repositories?"));
    expect(screen.queryByText(/Run \/context/i)).not.toBeInTheDocument();
  });
});
