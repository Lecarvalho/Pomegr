import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../shared/monitor-contract";
import { SessionProgressPanel } from "../../app/components/dashboard/SessionProgressPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { agent } from "./dashboard-test-fixtures";

describe("session progress estimate", () => {
  const reportedAt = "2026-08-11T12:00:00.000Z";
  const progress = {
    phase: "implementing" as const,
    percent: 42,
    remainingMinutesMin: 10,
    remainingMinutesMax: 20,
    confidence: "medium" as const,
    reportedAt,
  };

  function progressAgent(status: Agent["status"] = "active", updatedAt = reportedAt) {
    return { ...agent, id: "primary", status, updatedAt, lastSeen: updatedAt };
  }

  it("keeps the panel hidden when progress is absent", () => {
    const { container } = render(<LiveClockProvider running={false}><SessionProgressPanel progress={null} /></LiveClockProvider>);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the bounded report as a semantic, visible progress instrument", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:05:00.000Z"));
    const { container } = render(<LiveClockProvider running={false}><SessionProgressPanel progress={progress} agents={[progressAgent()]} connected /></LiveClockProvider>);

    expect(screen.getByText("Agent estimate")).toBeInTheDocument();
    expect(screen.getAllByText("Implementing")).toHaveLength(2);
    expect(screen.getByText("10–20 min")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "42% complete · Implementing");
    expect(container.querySelector("progress")).toHaveValue(42);
    vi.useRealTimers();
  });

  it("pauses ETA for input and does not mark a retained report stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:20:00.000Z"));
    render(<LiveClockProvider running={false}><SessionProgressPanel progress={progress} agents={[progressAgent("needs_input", "2026-08-11T12:19:00.000Z")]} connected needsInput /></LiveClockProvider>);

    expect(screen.getByText("ETA paused — needs input")).toBeInTheDocument();
    expect(screen.queryByText(/may be stale/i)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("marks an old report stale only after later primary activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:11:00.000Z"));
    const primary = progressAgent("active", reportedAt);
    const { container } = render(<LiveClockProvider running={false}><SessionProgressPanel progress={progress} agents={[primary]} activity={[{ id: "activity-1", timestamp: "2026-08-11T12:10:30.000Z", actor: "primary", tool: "Read", workKind: "read", detail: "bounded", status: null }]} connected /></LiveClockProvider>);

    expect(screen.getByText(/May be stale/)).toBeInTheDocument();
    expect(screen.getAllByText(/may be stale/i)).toHaveLength(1);
    expect(container.querySelector(".sessionProgressNote")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("uses an absolute timestamp for historical progress and omits ETA at completion", () => {
    const historical = { ...progress, phase: "complete" as const, percent: 100, remainingMinutesMin: undefined, remainingMinutesMax: undefined };
    render(<LiveClockProvider running={false}><SessionProgressPanel progress={historical} historical /></LiveClockProvider>);

    expect(screen.getAllByText(/Recorded agent estimate/)).toHaveLength(2);
    expect(screen.queryByText("REMAINING")).not.toBeInTheDocument();
  });
});
