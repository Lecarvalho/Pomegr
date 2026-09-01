import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageLimitsView } from "../../app/components/command-center/CommandViews";

vi.mock("../../app/usage-limits-client", () => ({
  useUsageLimits: () => ({
    revision: 1,
    generatedAt: "2026-09-01T12:00:00.000Z",
    readiness: { claude: "ready", codex: "ready" },
    providers: [{
      provider: "codex",
      source: "Codex",
      readiness: "ready",
      usageLimits: {
        available: true,
        fetchedAt: "2026-09-01T12:00:00.000Z",
        attemptedAt: "2026-09-01T12:00:00.000Z",
        limits: [{ id: "codex-primary", label: "Codex", window: "7 days", percent: 20, resetsAt: null, severity: "normal", active: false }],
        error: "",
      },
    }],
  }),
}));

vi.mock("../../app/provider-status-client", () => ({
  useProviderStatus: () => ({
    revision: 1,
    generatedAt: "2026-09-01T12:00:00.000Z",
    providers: [{
      provider: "codex",
      source: "Codex",
      statusPageUrl: "https://status.openai.com/",
      status: "operational",
      readiness: "ready",
      freshness: "fresh",
      checkedAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T11:55:00.000Z",
      incidentKey: null,
      incidents: [],
    }],
  }),
}));

describe("usage provider health footer", () => {
  it("keeps the account update in the header and moves provider health into a semantic footer", () => {
    const { container } = render(<UsageLimitsView />);
    const panel = container.querySelector(".commandUsageProvider");
    const header = panel?.querySelector(".commandUsageProviderHead");
    const footer = panel?.querySelector(".commandUsageProviderHealth");

    expect(header).toHaveTextContent(/^CodexUpdated /);
    expect(header?.querySelector("details")).toBeNull();
    expect(footer).toHaveAttribute("data-health", "okay");
    expect(footer).toHaveTextContent("Provider health");
    expect(footer).toHaveTextContent("No reported issues");
    expect(screen.getByLabelText("Codex provider service status details")).toBeInTheDocument();
  });
});
