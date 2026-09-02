import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeUsageControls } from "../../app/components/ClaudeUsageControls";
import type { UsageLimits } from "../../shared/monitor-contract";

const rejected: UsageLimits = {
  available: false,
  fetchedAt: null,
  attemptedAt: null,
  failureKind: "authentication_required",
  limits: [],
};

function desktop(bridge: Record<string, unknown>) {
  Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: bridge });
}

afterEach(() => {
  Reflect.deleteProperty(window, "pomegrDesktop");
});

describe("Claude usage recovery", () => {
  it("keeps recovery actions compact, wrapping, and touch-friendly", () => {
    const styles = readFileSync(join(process.cwd(), "app/styles/evidence.css"), "utf8");
    expect(styles).toMatch(/\.claudeUsageActions\s*\{[^}]*flex-wrap: wrap;[^}]*align-items: center/);
    expect(styles).toMatch(/\.claudeUsageActions \.commandSecondaryAction\s*\{[^}]*min-height: var\(--control-compact\);[^}]*max-width: 100%;[^}]*font-size: var\(--text-xs\)/);
    expect(styles).not.toMatch(/\.usageConnectionHelp button\s*\{[^}]*margin-top/);
    expect(styles).toMatch(/@media \(max-width: 560px\), \(pointer: coarse\)\s*\{\s*\.claudeUsageActions \.commandSecondaryAction, \.claudeUsageActions a\s*\{ min-height: 44px/);
  });

  it.each([
    ["provider_api", null],
    ["local_observation", null],
  ] as const)("hides recovery when %s usage is available without a failure (%s)", async (origin, failureKind) => {
    const getClaudeUsageIntegration = vi.fn(async () => ({ status: "disabled" }));
    desktop({ getClaudeUsageIntegration, enableClaudeUsageIntegration: vi.fn(), startClaudeSignIn: vi.fn() });
    render(<ClaudeUsageControls usageLimits={{ ...rejected, available: true, origin, freshness: "stale", failureKind }} />);
    await waitFor(() => expect(getClaudeUsageIntegration).toHaveBeenCalled());
    expect(screen.queryByText("Usage connection help")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(Boolean(screen.queryByText(/Usage reported by Claude Code/))).toBe(origin === "local_observation");
  });

  it.each([
    ["disabled", null],
    ["enabled", null],
  ] as const)("does not offer recovery for %s integration during %s", async (status, failureKind) => {
    const getClaudeUsageIntegration = vi.fn(async () => ({ status }));
    desktop({ getClaudeUsageIntegration, enableClaudeUsageIntegration: vi.fn(), startClaudeSignIn: vi.fn() });
    render(<ClaudeUsageControls usageLimits={{ ...rejected, failureKind }} />);
    await waitFor(() => expect(getClaudeUsageIntegration).toHaveBeenCalled());
    expect(screen.queryByText("Usage connection help")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers setup when loading failed and the local feed is not configured", async () => {
    desktop({ getClaudeUsageIntegration: async () => ({ status: "disabled" }), enableClaudeUsageIntegration: vi.fn() });
    render(<ClaudeUsageControls usageLimits={{ ...rejected, failureKind: "unavailable" }} />);
    expect(await screen.findByRole("button", { name: "Enable local usage" })).toBeInTheDocument();
    expect(screen.getByText("Usage connection help")).toBeInTheDocument();
  });

  it("shows help for missing credentials and removes it when usage arrives", () => {
    const { rerender } = render(<ClaudeUsageControls usageLimits={{ ...rejected, failureKind: "unavailable", error: "Claude usage credentials are unavailable." }} />);
    expect(screen.getByText("Usage connection help")).toBeInTheDocument();
    rerender(<ClaudeUsageControls usageLimits={{ ...rejected, available: true, origin: "local_observation", failureKind: null }} />);
    expect(screen.queryByText("Usage connection help")).not.toBeInTheDocument();
    expect(screen.getByText(/Usage reported by Claude Code/)).toBeInTheDocument();
  });

  it.each([false, true])("expands browser sign-in help when access is rejected with available=%s", (available) => {
    const { container } = render(<ClaudeUsageControls usageLimits={{ ...rejected, available }} showObservationNote={false} />);
    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(screen.getByText("claude auth login --claudeai")).toBeVisible();
    expect(screen.getByText(/On the computer running Pomegr/)).toBeVisible();
    expect(screen.getByText(/The Reconnect button is available in Pomegr Desktop/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reconnect Claude Code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable local usage" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Setup guide (opens in a new tab)" })).toHaveAttribute("href", "https://github.com/Lecarvalho/pomegr/blob/main/docs/CONFIGURATION.md#claude-local-usage-feed");
  });

  it.each(["provider_api", "local_observation"] as const)("keeps desktop reconnect available when %s figures survive an authentication failure", async (origin) => {
    const startClaudeSignIn = vi.fn();
    desktop({ startClaudeSignIn, getClaudeUsageIntegration: async () => ({ status: "disabled" }), enableClaudeUsageIntegration: vi.fn() });
    const { container, rerender } = render(<ClaudeUsageControls usageLimits={{ ...rejected, available: true, origin }} />);
    expect(await screen.findByRole("button", { name: "Reconnect Claude Code" })).toBeVisible();
    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(screen.queryByRole("button", { name: "Enable local usage" })).not.toBeInTheDocument();
    expect(startClaudeSignIn).not.toHaveBeenCalled();
    rerender(<ClaudeUsageControls usageLimits={{ ...rejected, available: true, origin, failureKind: null }} />);
    expect(screen.queryByText("Usage connection help")).not.toBeInTheDocument();
    rerender(<ClaudeUsageControls usageLimits={{ ...rejected, available: true, origin }} />);
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  it.each([
    ["rate_limited", /Wait for the retry countdown/],
    ["unavailable", /Check your internet connection/],
  ] as const)("expands %s help despite retained readings without suggesting a sign-in action", async (failureKind, guidance) => {
    const getClaudeUsageIntegration = vi.fn(async () => ({ status: "disabled" }));
    const startClaudeSignIn = vi.fn();
    desktop({ startClaudeSignIn, getClaudeUsageIntegration, enableClaudeUsageIntegration: vi.fn() });
    const { container } = render(<ClaudeUsageControls usageLimits={{ ...rejected, available: true, failureKind }} />);
    await waitFor(() => expect(getClaudeUsageIntegration).toHaveBeenCalled());
    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(screen.getByText(guidance)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("claude auth login --claudeai")).not.toBeInTheDocument();
    expect(startClaudeSignIn).not.toHaveBeenCalled();
  });

  it("waits for an explicit click and prevents duplicate sign-in actions", async () => {
    let complete!: (value: { status: string }) => void;
    const startClaudeSignIn = vi.fn(() => new Promise<{ status: string }>((resolve) => { complete = resolve; }));
    desktop({ startClaudeSignIn, getClaudeUsageIntegration: async () => ({ status: "disabled" }) });
    render(<ClaudeUsageControls usageLimits={rejected} />);
    const button = await screen.findByRole("button", { name: "Reconnect Claude Code" });
    const actions = button.closest(".claudeUsageActions");
    expect(actions).toContainElement(screen.getByRole("link", { name: "Setup guide (opens in a new tab)" }));
    expect(startClaudeSignIn).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(startClaudeSignIn).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Waiting for sign-in…");
    expect(actions).not.toContainElement(screen.getByRole("status"));
    await act(async () => complete({ status: "completed" }));
    expect(screen.getByRole("status")).toHaveTextContent("Claude Code sign-in completed.");
    expect(button).toBeEnabled();
  });

  it.each([
    ["cancelled", "Sign-in cancelled"],
    ["failed", "could not complete sign-in"],
    ["unavailable", "could not be found"],
    ["busy", "already open"],
    ["timed_out", "Sign-in timed out"],
  ])("shows the bounded %s sign-in outcome", async (status, text) => {
    desktop({ startClaudeSignIn: async () => ({ status }) });
    render(<ClaudeUsageControls usageLimits={rejected} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect Claude Code" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(text));
  });

  it("sanitizes rejected IPC errors and allows another attempt", async () => {
    const startClaudeSignIn = vi.fn().mockRejectedValue(new Error("PRIVATE_TOKEN PRIVATE_PATH"));
    desktop({ startClaudeSignIn });
    render(<ClaudeUsageControls usageLimits={rejected} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect Claude Code" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("could not complete sign-in"));
    expect(document.body.textContent).not.toMatch(/PRIVATE_TOKEN|PRIVATE_PATH/);
    expect(screen.getByRole("button", { name: "Reconnect Claude Code" })).toBeEnabled();
  });

  it("enables the local feed through the narrow desktop action", async () => {
    const enableClaudeUsageIntegration = vi.fn(async () => ({ status: "enabled" }));
    desktop({
      getClaudeUsageIntegration: async () => ({ status: "disabled" }),
      enableClaudeUsageIntegration,
    });
    render(<ClaudeUsageControls usageLimits={rejected} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable local usage" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Local usage feed enabled"));
    expect(enableClaudeUsageIntegration).toHaveBeenCalledWith();
    expect(screen.queryByRole("button", { name: "Enable local usage" })).not.toBeInTheDocument();
  });

  it("keeps cancelled setup available and never exposes native error details", async () => {
    desktop({
      getClaudeUsageIntegration: async () => ({ status: "disabled" }),
      enableClaudeUsageIntegration: async () => ({ status: "cancelled" }),
    });
    render(<ClaudeUsageControls usageLimits={rejected} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable local usage" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Setup cancelled"));
    expect(screen.getByRole("button", { name: "Enable local usage" })).toBeEnabled();
  });
});
