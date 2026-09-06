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

describe("repository context inventory", () => {
  it("keeps capture under provider rows and uses the repository row as the only top-level disclosure", async () => {
    const capture = vi.fn().mockResolvedValue("completed");
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { captureRepositoryContextInventory: capture } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/repositories")) return new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.startsWith("/api/repository-inventory")) return new Response(JSON.stringify({ repositoryId, provider: "claude", ...snapshot.repositories[0].providers[0].currentRevision,
        categories: [{ name: "System prompt", tokens: "1.2k", percentage: 12 }], groups: [{ id: "inventory-0", label: "Tools", items: [{ name: "Read", detail: "provider tool", tokens: "200" }] }] }), { status: 200 });
      return new Response(null, { status: 404 });
    });
    render(<RepositoriesView />);
    const row = await screen.findByRole("button", { name: /^Pomegr/i });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Capture again" })).not.toBeInTheDocument();
    expect(screen.queryByText("Git details coming soon")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Detailed repository evidence is coming soon" })).toBeInTheDocument();
    expect(screen.getByText(/Branch, working-tree, commit, and pull-request aggregation/i)).toBeInTheDocument();
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("CURRENT")).toBeInTheDocument();
    expect(screen.getByText("UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText("Git details coming soon")).toBeInTheDocument();
    expect(screen.getByText(/will not combine or approximate Claude Code evidence/i)).toBeInTheDocument();
    expect(screen.queryByText(/Hide evidence/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByText("Context inventory", { selector: "summary" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Capture again" }));
    const confirmation = screen.getByRole("group", { name: /Confirm Claude Code inventory capture/i });
    expect(within(confirmation).getByText(/Run a Claude Code diagnostic for Pomegr/i)).toBeInTheDocument();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Run diagnostic" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith(repositoryId, "claude"));
  });

  it("presents desktop-only capture as quiet guidance on other clients", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/repositories")) return new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.startsWith("/api/repository-inventory")) return new Response(null, { status: 404 });
      return new Response(null, { status: 404 });
    });
    render(<RepositoriesView />);
    await userEvent.click(await screen.findByRole("button", { name: /^Pomegr/i }));
    await userEvent.click(screen.getAllByText("Context inventory", { selector: "summary" })[0]);
    expect(screen.getByText("Capture available in Pomegr desktop")).toHaveClass("repositoryProviderRemoteHint");
    expect(screen.getAllByText("View setup instructions")).toHaveLength(2);
    await userEvent.click(screen.getAllByText("View setup instructions")[0]);
    expect(screen.getByText(/Add the Pomegr marketplace and plugin in Claude Code/i)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Read the plugin instructions" })[0]).toHaveAttribute("href", "https://github.com/Lecarvalho/pomegr/blob/main/docs/PLUGINS.md");
    expect(screen.queryByRole("button", { name: /Pomegr desktop/i })).not.toBeInTheDocument();
  });

  it("runs native plugin actions without an optimistic installation result and keeps reporting guidance local", async () => {
    const capture = vi.fn().mockResolvedValue("completed");
    const pluginAction = vi.fn().mockResolvedValue("completed");
    Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: { captureRepositoryContextInventory: capture, repositoryPluginAction: pluginAction } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/repositories")) return new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(null, { status: 404 });
    });
    render(<RepositoriesView />);
    await userEvent.click(await screen.findByRole("button", { name: /^Pomegr/i }));
    expect(screen.getByText("v0.5.0")).toBeInTheDocument();
    expect(screen.getByText(/Update v0\.6\.0/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    await waitFor(() => expect(pluginAction).toHaveBeenCalledWith(repositoryId, "codex", "install"));
    expect(await screen.findByText(/Restart Codex, review hook trust/i)).toHaveClass("repositorySetupFeedback");
    expect(screen.queryByText("v0.6.0", { selector: ".repositorySetupTitle code" })).not.toBeInTheDocument();
    pluginAction.mockResolvedValueOnce("timed_out");
    await userEvent.click(screen.getAllByRole("button", { name: "Recheck" })[1]);
    expect(await screen.findByText(/timed out. Recheck the local setup/i)).toHaveClass("repositorySetupFeedback");
    expect(screen.queryByText(/Restart Codex, review hook trust/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Configure reporting" }));
    expect(screen.getByText("/pomegr:init", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("$pomegr:init", { selector: "code" })).toBeInTheDocument();
  });

  it("shows an in-progress setup check while retaining its last checked version", async () => {
    const checking = structuredClone(snapshot);
    const pluginSetup = checking.repositories[0].providers[0].pluginSetup!;
    pluginSetup.readiness = "loading";
    pluginSetup.installation = "unknown";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).startsWith("/api/repositories")
      ? new Response(JSON.stringify(checking), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response(null, { status: 404 }));
    const { container } = render(<RepositoriesView />);
    await userEvent.click(await screen.findByRole("button", { name: /^Pomegr/i }));
    expect(screen.getByText("Checking plugin setup")).toBeInTheDocument();
    expect(screen.getByText("v0.5.0")).toBeInTheDocument();
    expect(container.querySelector(".repositorySetupChecked")).toHaveTextContent("Checked");
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
