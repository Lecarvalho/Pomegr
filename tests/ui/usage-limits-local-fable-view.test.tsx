import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageLimitsView } from "../../app/components/command-center/CommandViews";
import { useUsageLimits } from "../../app/usage-limits-client";

vi.mock("../../app/usage-limits-client", () => ({
  useUsageLimits: vi.fn(() => ({
    revision: 1,
    generatedAt: "2026-08-08T12:00:00.000Z",
    readiness: { claude: "ready", codex: "ready" },
    providers: [{
      provider: "claude",
      source: "Claude Code",
      readiness: "ready",
      usageLimits: {
        available: true,
        origin: "local_observation",
        freshness: "fresh",
        fetchedAt: "2026-08-08T12:00:00.000Z",
        attemptedAt: "2026-08-08T12:00:00.000Z",
        limits: [
          { id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: null, severity: "normal", active: false },
          { id: "all-models", label: "All models", window: "7 days", percent: 40, resetsAt: null, severity: "normal", active: false },
        ],
        retainedLimits: {
          fetchedAt: "2026-08-08T11:00:00.000Z",
          limits: [{ id: "model-fable", label: "Fable", window: "7 days", percent: 60, resetsAt: null, severity: "normal", active: true }],
        },
      },
    }],
  })),
}));

vi.mock("../../app/provider-status-client", () => ({
  useProviderStatus: () => ({ revision: 1, generatedAt: null, providers: [] }),
}));

describe("local Fable usage in the command center", () => {
  it.each([
    [null, "Checking…", "Waiting for account check"],
    ["unavailable", "Unavailable", "Account check failed; retrying automatically"],
  ] as const)("uses quiet status typography for %s without de-emphasizing percentages", (failureKind, label, detail) => {
    const snapshot = useUsageLimits();
    vi.mocked(useUsageLimits).mockReturnValueOnce({
      ...snapshot,
      providers: snapshot.providers.map((entry) => ({
        ...entry,
        usageLimits: { ...entry.usageLimits, retainedLimits: undefined, attemptedAt: null, failureKind },
      })),
    });
    render(<UsageLimitsView />);

    expect(screen.getByText(label)).toHaveClass("commandUsageStatus");
    expect(screen.getByText(label).tagName).toBe("SPAN");
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.getByText("20%").tagName).toBe("B");
    expect(screen.getByText("40%").tagName).toBe("B");
  });

  it("keeps the retained API value supplemental and distinct from the local observation", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:00:00.000Z");
    const { container } = render(<UsageLimitsView />);

    expect(container.querySelectorAll(".commandUsageWindow")).toHaveLength(3);
    expect(screen.getAllByText("Fable")).toHaveLength(1);
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText(/Last API value 1h ago/)).toBeInTheDocument();
    expect(screen.getByText(/^Last observed/)).toHaveTextContent("Last observed just now");
    expect(screen.queryByText("Active limit")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
