import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("offers browser-only help without creating a native launcher or request", async () => {
    render(<ClaudeUsageControls usageLimits={rejected} />);
    expect(screen.queryByRole("button", { name: "Reconnect Claude Code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable local usage" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Usage connection help"));
    expect(screen.getByText(/Use Pomegr Desktop to enable local usage/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Setup guide (opens in a new tab)" })).toHaveAttribute("href", "https://github.com/Lecarvalho/pomegr/blob/main/docs/CONFIGURATION.md#claude-local-usage-feed");
  });

  it("waits for an explicit click and prevents duplicate sign-in actions", async () => {
    let complete!: (value: { status: string }) => void;
    const startClaudeSignIn = vi.fn(() => new Promise<{ status: string }>((resolve) => { complete = resolve; }));
    desktop({ startClaudeSignIn, getClaudeUsageIntegration: async () => ({ status: "disabled" }) });
    render(<ClaudeUsageControls usageLimits={rejected} />);
    const button = await screen.findByRole("button", { name: "Reconnect Claude Code" });
    expect(startClaudeSignIn).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(startClaudeSignIn).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
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
