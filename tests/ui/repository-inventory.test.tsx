import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepositoriesView } from "../../app/components/command-center/CommandViews";
import { MachineryPanel } from "../../app/components/dashboard/MachineryPanel";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";

const repositoryId = "repo-0123456789abcdef01234567";
const snapshot: RepositoryInventorySnapshot = {
  revision: 1,
  readiness: "ready",
  repositories: [{
    id: repositoryId, name: "Pomegr", displayName: "Pomegr", sessionCount: 3, liveCount: 1, historyCount: 2,
    providerCount: 2, updatedAt: "2026-09-04T10:00:00.000Z",
    providers: [{ provider: "claude", source: "Claude Code", sessionCount: 2, supported: true, status: "current", failureKind: null,
      currentRevision: { id: "ctx-001", capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200,
        categoryCount: 1, itemCount: 1, change: { state: "first_capture", previousRevisionId: null } },
      revisions: [{ id: "ctx-001", capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200,
        categoryCount: 1, itemCount: 1, change: { state: "first_capture", previousRevisionId: null } }] },
    { provider: "codex", source: "Codex", sessionCount: 1, supported: false, status: "unavailable", failureKind: null,
      currentRevision: null, revisions: [] }],
  }],
};

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
    expect(screen.getByText("Capture available in Pomegr desktop")).toHaveClass("repositoryProviderRemoteHint");
    expect(screen.queryByRole("button", { name: /Pomegr desktop/i })).not.toBeInTheDocument();
  });

  it("renders a compact immutable session reference and never asks for /context", () => {
    render(<MachineryPanel machinery={null} supported historical={false} inventoryRef={{ repositoryId, provider: "claude", revisionId: "ctx-001",
      capturedAt: "2026-09-04T09:00:00.000Z", model: "claude-test", machineryTokens: 1200, categoryCount: 1, itemCount: 1, detailRetained: true }} />);
    expect(screen.getByText(/available when this session started/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open ctx-001" })).toHaveAttribute("href", expect.stringContaining("/repositories?"));
    expect(screen.queryByText(/Run \/context/i)).not.toBeInTheDocument();
  });
});
