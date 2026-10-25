import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDetailsPanel } from "../../app/components/dashboard/SessionDetailsPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import type { MonitorState } from "../../shared/monitor-contract";
import { agent, claudeCapabilities, repositorySession } from "./dashboard-test-fixtures";

const access = vi.hoisted(() => ({ canCopyTranscriptPath: true }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => access }));

function detailsState(): MonitorState {
  return {
    ...createEmptyMonitorState({ connected: true, source: "Claude Code", capabilities: claudeCapabilities }),
    agents: [{ ...agent, transcriptAvailable: true }],
    session: {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      id: "claude:session-1", startedAt: "2026-10-25T12:00:00.000Z",
      approvalMode: { id: "auto", label: "Auto", observedAt: null, source: "provider" },
      contextMachinery: {
        observedAt: "2026-10-25T12:00:00.000Z", model: "test-model", total: null, machineryTokens: 1600,
        contextAllocation: { initialTokens: 1000, deferredTokens: 400, reservedTokens: 200 },
        categories: [
          { name: "System prompt", tokens: "1,000", percentage: 62.5, kind: "initial" },
          { name: "Deferred tool definitions", tokens: "400", percentage: 25, kind: "deferred" },
          { name: "Autocompact buffer", tokens: "200", percentage: 12.5, kind: "reserved" },
        ],
        groups: [{ id: "tools", label: "MCP servers", items: [{ name: "pomegr", detail: "Reporting tools", tokens: "400" }] }],
      },
      contextInventoryRef: { repositoryId: "repo-1", provider: "claude", revisionId: "ctx-001", capturedAt: "2026-10-24T12:00:00.000Z", model: "test-model", machineryTokens: 1000, contextAllocation: { initialTokens: 1000, deferredTokens: 0, reservedTokens: 0 }, categoryCount: 1, itemCount: 1, detailRetained: true },
    },
  };
}

function renderDetails(state = detailsState(), historical = false) {
  return render(<LiveClockProvider running={false}><SessionDetailsPanel state={state} historical={historical} /></LiveClockProvider>);
}

afterEach(() => { access.canCopyTranscriptPath = true; vi.restoreAllMocks(); });

describe("Details tab", () => {
  it.each([false, true])("shows session facts without a disclosure, limits, flow score or audience chip (historical=%s)", (historical) => {
    renderDetails(detailsState(), historical);
    const facts = screen.getByRole("region", { name: "Session" });
    expect(within(facts).getByRole("heading", { name: "Session" })).toBeVisible();
    for (const value of ["Provider", "Claude Code", "Session ID", "claude:session-1", "Project", "pomegr", "Started", "Approval mode", "Auto"]) {
      expect(within(facts).getByText(value)).toBeVisible();
    }
    expect(facts.closest("details")).toBeNull();
    expect(screen.queryByText(/Usage limits|Flow score|Expert/)).not.toBeInTheDocument();
  });

  it("shows allocation and category evidence inline, with expandable groups and the recorded revision link", async () => {
    const user = userEvent.setup();
    renderDetails();
    const inventory = screen.getByRole("region", { name: "Context inventory" });
    for (const label of ["Loaded initially", "Deferred until needed", "Reserved capacity"]) expect(within(inventory).getByText(label)).toBeVisible();
    const table = within(inventory).getByRole("table", { name: "Estimated context categories" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Category", "Tokens", "Share", "Kind"]);
    expect(within(table).getByText("System prompt")).toBeVisible();
    expect(within(table).getByText("62.5%")).toBeVisible();
    expect(within(table).getAllByText("—")).toHaveLength(2);
    expect(within(inventory).queryByRole("button", { name: /View inventory breakdown/ })).not.toBeInTheDocument();
    await user.click(within(inventory).getByText("Groups · 1"));
    await user.click(within(inventory).getByText("MCP servers"));
    expect(within(inventory).getByText("Reporting tools")).toBeVisible();
    expect(within(inventory).getByRole("link", { name: "Repository inventory revision ctx-001" })).toHaveAttribute("href", "/repositories/repo-1?tab=inventory&provider=claude&revision=ctx-001");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the immutable repository reference when in-session inventory is absent", () => {
    const state = detailsState();
    state.session!.contextMachinery = null;
    state.session!.contextInventoryRef!.detailRetained = false;
    renderDetails(state, true);
    expect(screen.getByRole("link", { name: /Repository inventory revision ctx-001/ })).toBeVisible();
    expect(screen.getByText("Detailed evidence is no longer retained.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("copies the primary transcript only on demand and never renders the path", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ path: "C:\\private\\session.jsonl" })));
    const { container } = renderDetails();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Copy transcript path/ }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("C:\\private\\session.jsonl"));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/transcript-path?sessionId=claude%3Asession-1&agentId=primary", { cache: "no-store" });
    expect(container.innerHTML).not.toContain("private");
    expect(localStorage.length).toBe(0);
  });

  it("retains access and transcript-availability gates", () => {
    access.canCopyTranscriptPath = false;
    const { unmount } = renderDetails();
    expect(screen.queryByRole("button", { name: /transcript path/ })).not.toBeInTheDocument();
    unmount();
    access.canCopyTranscriptPath = true;
    const state = detailsState();
    state.agents[0].transcriptAvailable = false;
    renderDetails(state);
    expect(screen.queryByRole("button", { name: /transcript path/ })).not.toBeInTheDocument();
  });

  it("shows a generic copy failure without disclosing the returned error", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("C:\\private\\session.jsonl"));
    const { container } = renderDetails();
    await user.click(screen.getByRole("button", { name: /Copy transcript path/ }));
    expect(await screen.findByRole("button", { name: /Retry copying transcript path/ })).toBeVisible();
    expect(container.innerHTML).not.toContain("private");
  });
});
