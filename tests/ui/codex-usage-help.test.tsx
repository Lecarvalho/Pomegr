import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageLimitsView } from "../../app/components/command-center/CommandViews";
import { UsageLimitsPanel } from "../../app/components/dashboard/UsageLimitsPanel";
import { useUsageLimits } from "../../app/usage-limits-client";
import type { UsageLimits, UsageLimitsSnapshot } from "../../shared/monitor-contract";

vi.mock("../../app/usage-limits-client", () => ({ useUsageLimits: vi.fn() }));
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
    expect(codex.getByRole("link", { name: "Setup guide (opens in a new tab)" })).toHaveAttribute("href", "https://github.com/Lecarvalho/pomegr/blob/main/docs/CONFIGURATION.md#codex");
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

  it("offers account help when a successful response supplies no usage windows", () => {
    publish({ ...ready, available: false, limits: [] }, "ready");
    render(<UsageLimitsView />);
    expect(screen.getByText("codex login status")).toBeVisible();
    expect(screen.queryByText("Waiting for provider usage")).not.toBeInTheDocument();
  });

  it("explains throttling without suggesting a sign-in workaround", () => {
    publish({ ...missing, failureKind: "rate_limited" });
    render(<UsageLimitsView />);
    expect(screen.getByText(/Wait for the retry countdown/)).toBeVisible();
    expect(screen.queryByText("codex login")).not.toBeInTheDocument();
  });

  it("uses the same helper in session-level usage panels without a desktop launcher", () => {
    render(<UsageLimitsPanel source="Codex" usageLimits={{ ...missing, failureKind: "unavailable" }} />);
    expect(screen.getByText("codex login status")).toBeVisible();
    expect(screen.getByText("Usage connection help").closest("details")).toHaveAttribute("open");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
  });
});
