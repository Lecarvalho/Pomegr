import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageLimitsPanel } from "../../app/components/dashboard/UsageLimitsPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

describe("usage-limit clock", () => {
  it("counts down from the shared frontend clock and freezes with it", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:00:00.000Z");
    const usageLimits = {
      available: true,
      fetchedAt: "2026-08-08T12:00:00.000Z",
      attemptedAt: "2026-08-08T12:00:00.000Z",
      limits: [{ id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: "2026-08-08T12:02:00.000Z", severity: "normal" as const, active: true }],
    };
    const panelRender = vi.fn();
    const UsagePanelProbe = () => {
      panelRender();
      return <UsageLimitsPanel source="Claude Code" usageLimits={usageLimits} />;
    };
    const panel = (running: boolean) => <LiveClockProvider running={running}><UsagePanelProbe /></LiveClockProvider>;
    const { rerender } = render(panel(true));

    expect(screen.getByText("Resets in 2m")).toBeInTheDocument();
    expect(screen.getByText(/^Updated/)).toHaveTextContent("Updated just now");
    expect(screen.queryByText(/Checked|Refresh failed|retrying|\d+s ago/i)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Resets in 1m")).toBeInTheDocument();
    expect(screen.getByText(/^Updated/)).toHaveTextContent("Updated 1 minute ago");
    expect(panelRender).toHaveBeenCalledTimes(1);

    rerender(panel(false));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Resets in 1m")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("asks for provider re-authentication when a retained snapshot refresh receives 401", () => {
    render(<LiveClockProvider running><UsageLimitsPanel
      source="Claude Code"
      usageLimits={{
        available: true,
        fetchedAt: "2026-08-08T05:00:00.000Z",
        attemptedAt: "2026-08-08T12:00:00.000Z",
        error: "Anthropic usage endpoint returned 401",
        limits: [{ id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: null, severity: "normal", active: false }],
      }}
    /></LiveClockProvider>);

    expect(screen.getByRole("status")).toHaveTextContent("Re-authentication needed");
    expect(screen.getByRole("status")).toHaveTextContent("Sign in to Claude Code again. Pomegr will retry automatically.");
    expect(screen.getByText("20%")).toBeInTheDocument();
  });

  it("renders arbitrary usage buckets and critical reached styling", () => {
    const limits = [
      { id: "one", label: "One", window: "1 hour", percent: 100, resetsAt: null, severity: "critical" as const, active: true },
      { id: "two", label: "Two", window: "5 hours", percent: 92, resetsAt: null, severity: "warning" as const, active: false },
      { id: "three", label: "Three", window: "7 days", percent: 40, resetsAt: null, severity: "normal" as const, active: false },
      { id: "four", label: "Four", window: "30 days", percent: 10, resetsAt: null, severity: "normal" as const, active: false },
    ];

    const { container } = render(<LiveClockProvider running><UsageLimitsPanel
      source="Codex"
      usageLimits={{ available: true, fetchedAt: null, attemptedAt: null, limits }}
    /></LiveClockProvider>);

    expect(container.querySelectorAll(".limitCard")).toHaveLength(4);
    expect(container.querySelector(".limitCard.critical")).toHaveTextContent("Active limit");
    expect(container.querySelectorAll(".limitCard.critical")).toHaveLength(2);
    expect(container.querySelectorAll(".limitCard.warning")).toHaveLength(0);
    expect(container.querySelectorAll(".limitCard.normal")).toHaveLength(2);
  });
});
