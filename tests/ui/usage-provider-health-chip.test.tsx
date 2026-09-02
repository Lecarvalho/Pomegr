import { fireEvent, render, screen, within } from "@testing-library/react";
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

describe("usage provider health chip", () => {
  it("places health beside the provider name and keeps status details accessible", () => {
    const { container } = render(<UsageLimitsView />);
    const panel = container.querySelector(".commandUsageProvider");
    const header = panel?.querySelector(".commandUsageProviderHead");
    const trigger = within(header as HTMLElement).getByRole("button", { name: "Codex provider service status details: Reported healthy" });

    expect(screen.getByRole("heading", { name: "Codex", level: 2 }).nextElementSibling).toContainElement(trigger);
    expect(header).toHaveTextContent("Updated ");
    expect(trigger).toHaveTextContent("Reported healthy");
    expect(panel?.querySelector(":scope > footer")).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.focus(trigger);
    const popover = screen.getByRole("dialog");
    expect(popover).toHaveTextContent("Last checked");
    expect(popover).toHaveTextContent("Provider update");
    expect(within(popover).getByRole("link", { name: "View status page; opens in a new tab" })).toHaveAttribute("href", "https://status.openai.com/");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
