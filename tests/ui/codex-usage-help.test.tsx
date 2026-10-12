import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageLimitsView } from "../../app/components/command-center/CommandViews";
import { useUsageLimits } from "../../app/usage-limits-client";
import { getUsageLimitsStore } from "../../app/usage-limits-client";
import { CodexUsageHelp } from "../../app/components/CodexUsageHelp";
import type { UsageLimits, UsageLimitsSnapshot } from "../../shared/monitor-contract";

vi.mock("../../app/usage-limits-client", () => ({ useUsageLimits: vi.fn(), getUsageLimitsStore: vi.fn() }));
vi.mock("../../app/provider-status-client", () => ({
  useProviderStatus: () => ({ revision: 1, generatedAt: null, providers: [] }),
}));

const missing: UsageLimits = {
  available: false, fetchedAt: null, attemptedAt: null, retryAt: null,
  failureKind: "runtime_unavailable", error: "Usage limits runtime is unavailable.", limits: [],
};
const ready: UsageLimits = {
  available: true, fetchedAt: "2026-09-02T12:00:00.000Z", attemptedAt: "2026-09-02T12:00:00.000Z",
  failureKind: null, limits: [{ id: "codex-primary", label: "Codex", window: "5 hours", percent: 23, resetsAt: null, severity: "normal", active: false }],
};
function publish(usageLimits: UsageLimits, readiness: "ready" | "unavailable" | "loading" = "unavailable") {
  const snapshot: UsageLimitsSnapshot = {
    revision: 1, generatedAt: null, readiness: { claude: "ready", codex: readiness },
    providers: [
      { provider: "claude", source: "Claude Code", readiness: "ready", usageLimits: { ...ready, limits: [{ ...ready.limits[0], id: "all-models", label: "All models", percent: 42 }] } },
      { provider: "codex", source: "Codex", readiness, usageLimits },
    ],
  };
  vi.mocked(useUsageLimits).mockReturnValue(snapshot);
}
beforeEach(() => publish(missing));

const authRequired: UsageLimits = { ...ready, available: false, failureKind: "authentication_required", error: "Authentication required" };
function setDesktopBridge(bridge?: { startCodexSignIn?: () => Promise<{ status: string }> }) {
  Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: bridge });
}

describe("Codex usage troubleshooting", () => {
  it("replaces endless loading with missing-CLI guidance while Claude stays available", () => {
    render(<UsageLimitsView />);
    const codex = within(screen.getByRole("region", { name: "Codex" }));
    expect(codex.getByText("Codex CLI required for usage limits")).toBeVisible();
    expect(codex.queryByText("Waiting for provider usage")).not.toBeInTheDocument();
    expect(codex.getByText("Usage connection help").closest("details")).toHaveAttribute("open");
    expect(codex.getByText(/install or update the native Codex CLI/)).toBeVisible();
    expect(codex.getByText("codex login")).toBeVisible();
    expect(codex.getByText(/Fully quit and reopen Pomegr/)).toBeVisible();
    expect(codex.getByRole("link", { name: "Setup guide (opens in a new tab)" })).toHaveAttribute("href", "https://pomegr.com/docs/concepts/usage-limits#if-a-window-is-missing");
    expect(codex.queryByRole("button")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Claude Code" })).getByText("42%")).toBeVisible();
  });

  it("shows account troubleshooting without exposing failures or discarding retained values", () => {
    publish({ ...ready, failureKind: "unavailable", error: "PRIVATE_ACCOUNT_ERROR" }, "ready");
    render(<UsageLimitsView />);
    const codex = within(screen.getByRole("region", { name: "Codex" }));
    expect(codex.getByText("23%")).toBeVisible();
    expect(codex.getByText("codex login status")).toBeVisible();
    expect(codex.getByText(/If signed out or using an API key/)).toBeVisible();
    expect(codex.getByText("Usage connection help").closest("details")).toHaveAttribute("open");
    expect(screen.queryByText(/PRIVATE_ACCOUNT_ERROR/)).not.toBeInTheDocument();
    expect(screen.queryByText("Codex CLI required for usage limits")).not.toBeInTheDocument();
  });

  it("removes the helper when usage recovers", () => {
    const { rerender } = render(<UsageLimitsView />);
    expect(screen.getByText("Usage connection help")).toBeVisible();
    publish(ready, "ready");
    rerender(<UsageLimitsView />);
    expect(screen.queryByText("Usage connection help")).not.toBeInTheDocument();
    expect(screen.getByText("23%")).toBeVisible();
  });

  it("keeps actual pending acquisition in loading without premature setup advice", () => {
    publish({ ...missing, failureKind: null, error: "" }, "loading");
    render(<UsageLimitsView />);
    expect(screen.getByText("Waiting for provider usage")).toBeVisible();
    expect(screen.queryByText("Usage connection help")).not.toBeInTheDocument();
  });

  it("shows a desktop reconnect action only for authentication failures, including signed out/API key", async () => {
    setDesktopBridge({ startCodexSignIn: vi.fn().mockResolvedValue({ status: "cancelled" }) });
    render(<CodexUsageHelp usageLimits={authRequired} />);
    expect(await screen.findByRole("button", { name: "Reconnect Codex" })).toBeVisible();
    expect(screen.queryByText("codex login status")).not.toBeInTheDocument();
  });

  it("hides reconnect in the browser and during cooldown", async () => {
    setDesktopBridge({ startCodexSignIn: vi.fn().mockResolvedValue({ status: "cancelled" }) });
    const { unmount } = render(<CodexUsageHelp usageLimits={authRequired} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect Codex" })).toBeVisible());
    unmount();
    setDesktopBridge();
    render(<CodexUsageHelp usageLimits={authRequired} />);
    expect(screen.queryByRole("button", { name: "Reconnect Codex" })).not.toBeInTheDocument();
    unmount();
    setDesktopBridge({ startCodexSignIn: vi.fn().mockResolvedValue({ status: "cancelled" }) });
    render(<CodexUsageHelp usageLimits={{ ...authRequired, failureKind: "rate_limited" }} />);
    expect(await screen.findByText(/respects the provider’s cooldown/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reconnect Codex" })).not.toBeInTheDocument();
  });

  it.each([
    ["sanitized unavailable", { ...authRequired, failureKind: "unavailable" as const, error: "Usage request failed" }],
    ["missing CLI", missing],
    ["valid response with no windows", { ...authRequired, available: false, failureKind: null, error: "", fetchedAt: "2026-09-02T12:00:00.000Z" }],
  ])("offers desktop reconnect for %s", async (_label, usageLimits) => {
    setDesktopBridge({ startCodexSignIn: vi.fn().mockResolvedValue({ status: "cancelled" }) });
    render(<CodexUsageHelp usageLimits={usageLimits} />);
    expect(await screen.findByRole("button", { name: "Reconnect Codex" })).toBeVisible();
  });

  it("keeps fixed manual guidance for browser failures and hides controls without an issue", async () => {
    setDesktopBridge();
    const { rerender } = render(<CodexUsageHelp usageLimits={{ ...authRequired, failureKind: "unavailable" }} />);
    expect(screen.getByText("codex login status")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reconnect Codex" })).not.toBeInTheDocument();
    rerender(<CodexUsageHelp usageLimits={{ ...authRequired, available: false, failureKind: null, error: "", fetchedAt: null }} />);
    expect(screen.queryByText("Usage connection help")).not.toBeInTheDocument();
  });

  it("guards pending sign-in and reports bounded status messages", async () => {
    let finish!: (value: { status: string }) => void;
    const startCodexSignIn = vi.fn(() => new Promise<{ status: string }>((resolve) => { finish = resolve; }));
    setDesktopBridge({ startCodexSignIn });
    render(<CodexUsageHelp usageLimits={authRequired} />);
    const button = await screen.findByRole("button", { name: "Reconnect Codex" });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Waiting for sign-in…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Waiting for sign-in…" }));
    expect(startCodexSignIn).toHaveBeenCalledTimes(1);
    finish({ status: "busy" });
    expect(await screen.findByRole("status")).toHaveTextContent("A Codex sign-in is already open. Finish it in your browser.");
  });

  it.each([
    ["cancelled", "Sign-in cancelled."],
    ["failed", "Codex could not complete sign-in."],
    ["unavailable", "Codex could not be found."],
    ["busy", "A Codex sign-in is already open."],
    ["timed_out", "Sign-in timed out."],
  ])("shows sanitized %s status", async (status, message) => {
    setDesktopBridge({ startCodexSignIn: vi.fn().mockResolvedValue({ status }) });
    render(<CodexUsageHelp usageLimits={authRequired} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect Codex" }));
    expect(await screen.findByRole("status")).toHaveTextContent(message);
    expect(screen.queryByText(/PRIVATE|token|credential/i)).not.toBeInTheDocument();
  });

  it("shows progress immediately after CLI completion and then reports a failed browser refresh", async () => {
    let finishRefresh!: (success: boolean) => void;
    const refreshAfterSignIn = vi.fn(() => new Promise<boolean>((resolve) => { finishRefresh = resolve; }));
    vi.mocked(getUsageLimitsStore).mockReturnValue({ refreshAfterSignIn } as never);
    setDesktopBridge({ startCodexSignIn: vi.fn().mockResolvedValue({ status: "completed" }) });
    render(<CodexUsageHelp usageLimits={authRequired} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect Codex" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Codex sign-in completed. Checking usage…");
    expect(refreshAfterSignIn).toHaveBeenCalledTimes(1);
    finishRefresh(false);
    expect(await screen.findByRole("status")).toHaveTextContent("Pomegr could not refresh usage");
    expect(screen.getByRole("status")).toHaveTextContent("retry automatically");
  });

  it.each([
    ["missing CLI", true, missing, "Codex CLI could not be verified"],
    ["other unavailable result", true, { ...ready, available: false, failureKind: "unavailable", error: "private" }, "Usage is still unavailable"],
    ["no windows", true, { ...ready, available: false, failureKind: null, limits: [] }, "Usage is still unavailable"],
    ["recovered usage", true, ready, "Usage refreshed."],
  ])("classifies the refreshed snapshot after %s", async (_label, refreshResult, codexUsage, message) => {
    const refreshAfterSignIn = vi.fn().mockResolvedValue(refreshResult);
    const getSnapshot = vi.fn().mockReturnValue({ providers: [{ provider: "codex", usageLimits: codexUsage }] });
    vi.mocked(getUsageLimitsStore).mockReturnValue({ refreshAfterSignIn, getSnapshot } as never);
    setDesktopBridge({ startCodexSignIn: vi.fn().mockResolvedValue({ status: "completed" }) });
    render(<CodexUsageHelp usageLimits={authRequired} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect Codex" }));
    expect(await screen.findByRole("status")).toHaveTextContent(message);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/private/i)).not.toBeInTheDocument();
  });

  it("sanitizes native exceptions and does not expose their text", async () => {
    setDesktopBridge({ startCodexSignIn: vi.fn().mockRejectedValue(new Error("PRIVATE_NATIVE_TOKEN")) });
    render(<CodexUsageHelp usageLimits={authRequired} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect Codex" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Codex could not complete sign-in.");
    expect(screen.queryByText(/PRIVATE_NATIVE_TOKEN/)).not.toBeInTheDocument();
  });
});
