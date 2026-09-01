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

  it("describes rejected access without asserting that a new login is required", () => {
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

    expect(screen.getByRole("status")).toHaveTextContent("Usage access interrupted");
    expect(screen.getByRole("status")).toHaveTextContent("Claude Code’s saved access was rejected. Pomegr will retry automatically; reconnect if this continues.");
    expect(screen.getByText("20%")).toBeInTheDocument();
  });

  it("labels retained local usage with its observation time and stale status", () => {
    render(<LiveClockProvider running><UsageLimitsPanel
      source="Claude Code"
      usageLimits={{
        available: true,
        origin: "local_observation",
        freshness: "stale",
        fetchedAt: "2026-08-08T05:00:00.000Z",
        attemptedAt: "2026-08-08T12:00:00.000Z",
        limits: [{ id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: null, severity: "normal", active: false }],
      }}
    /></LiveClockProvider>);
    expect(screen.getByText(/^Last observed/)).toBeInTheDocument();
    expect(screen.getByText("Showing the last observation. Current usage may have changed.")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.queryByText(/^Updated/)).not.toBeInTheDocument();
  });

  it("shows a retained Fable API value once, with its own timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:00:00.000Z");
    const { container } = render(<LiveClockProvider running><UsageLimitsPanel
      source="Claude Code"
      usageLimits={{
        available: true,
        origin: "local_observation",
        freshness: "fresh",
        fetchedAt: "2026-08-08T12:00:00.000Z",
        attemptedAt: "2026-08-08T12:00:00.000Z",
        limits: [
          { id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: null, severity: "normal", active: false },
          { id: "all-models", label: "All models", window: "7 days", percent: 40, resetsAt: null, severity: "normal", active: false },
          { id: "model-fable", label: "Fable", window: "7 days", percent: 0, resetsAt: null, severity: "normal", active: false },
        ],
        retainedLimits: {
          fetchedAt: "2026-08-08T11:58:00.000Z",
          limits: [{ id: "model-fable", label: "Fable", window: "7 days", percent: 60, resetsAt: "2026-08-09T12:00:00.000Z", severity: "normal", active: true }],
        },
      }}
    /></LiveClockProvider>);

    expect(container.querySelectorAll(".limitCard")).toHaveLength(3);
    expect(screen.getAllByText("Fable")).toHaveLength(1);
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("Last API value 2 minutes ago")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText("Active limit")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("marks Fable unavailable when a local feed has no retained API value", () => {
    render(<LiveClockProvider running><UsageLimitsPanel
      source="Claude Code"
      usageLimits={{
        available: true,
        origin: "local_observation",
        freshness: "fresh",
        fetchedAt: "2026-08-08T12:00:00.000Z",
        attemptedAt: "2026-08-08T12:00:00.000Z",
        limits: [{ id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: null, severity: "normal", active: false }],
      }}
    /></LiveClockProvider>);

    expect(screen.getByText("Fable")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Not reported by Claude")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it.each([
    [null, "Checking…", "Waiting for account check"],
    ["authentication_required", "Unavailable", "Claude Code sign-in needs attention"],
    ["rate_limited", "Unavailable", "Account check rate-limited; retrying automatically"],
    ["unavailable", "Unavailable", "Account check failed; retrying automatically"],
  ] as const)("distinguishes Fable's pending check from %s failures", (failureKind, label, detail) => {
    render(<LiveClockProvider running={false}><UsageLimitsPanel source="Claude Code" usageLimits={{
      available: true, origin: "local_observation", freshness: "fresh",
      fetchedAt: "2026-08-08T12:00:00.000Z", attemptedAt: null, failureKind,
      limits: [{ id: "five-hour", label: "Five-hour limit", window: "5 hours", percent: 20, resetsAt: null, severity: "normal", active: false }],
    }} /></LiveClockProvider>);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.queryByText("Not reported by local feed")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("presents a cached 429 as the last failed refresh with its local retry boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T12:00:00.000Z");
    render(<LiveClockProvider running><UsageLimitsPanel
      source="Claude Code"
      usageLimits={{
        available: false,
        fetchedAt: null,
        attemptedAt: "2026-08-08T12:00:00.000Z",
        failureKind: "rate_limited",
        retryAt: "2026-08-08T12:10:00.000Z",
        error: "Anthropic usage endpoint returned 429",
        limits: [],
      }}
    /></LiveClockProvider>);

    expect(screen.getByText(/^Checked/)).toHaveTextContent("Checked just now");
    expect(screen.getByRole("status")).toHaveTextContent("Refresh rate-limited");
    expect(screen.getByRole("status")).toHaveTextContent("The last usage check was rate-limited. Pomegr will retry automatically. Next retry in 10m.");
    expect(screen.queryByText(/returned 429/i)).not.toBeInTheDocument();
    vi.useRealTimers();
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
