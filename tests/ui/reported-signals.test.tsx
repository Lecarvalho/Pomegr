import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SignalsDomain } from "../../shared/session-domain-contract";
import { SignalsReportedSection } from "../../app/components/dashboard/signals/SignalsReportedSection";

const agents: SignalsDomain["agents"] = [{ id: "primary", label: "Primary agent", cacheLifetime: "1h", signal: { label: "Tests passed", tone: "positive", reportedAt: "2026-09-19T12:00:00.000Z", description: "Focused checks completed." } }];

describe("Signals reported section", () => {
  it("distinguishes bounded session and agent-reported signals with tones and descriptions", () => {
    render(<SignalsReportedSection historical={false} agents={agents} sessionSignal={{ label: "Review complete", tone: "info", reportedAt: "2026-09-19T12:01:00.000Z", description: "Review was submitted." }} />);
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows[0]).toHaveClass("info"); expect(rows[0]).toHaveTextContent("Session · agent-reported"); expect(rows[0]).toHaveTextContent("Review was submitted.");
    expect(rows[1]).toHaveClass("positive"); expect(rows[1]).toHaveTextContent("Agent · agent-reported · Primary agent"); expect(rows[1]).toHaveTextContent("Focused checks completed.");
    expect(screen.getByText("Signals are agent-reported, may be stale, and are not Pomegr judgments.")).toBeInTheDocument();
  });
  it("uses an honest live empty state", () => {
    render(<SignalsReportedSection historical={false} agents={[{ ...agents[0], signal: null }]} sessionSignal={null} />);
    expect(screen.getByText("No reported signals yet.")).toBeInTheDocument();
  });
  it("preserves recorded wording for historical signals and empty history", () => {
    const { rerender } = render(<SignalsReportedSection historical agents={agents} sessionSignal={null} />);
    expect(screen.getByText("Recorded agent-reported signals for this session.")).toBeInTheDocument();
    rerender(<SignalsReportedSection historical agents={[{ ...agents[0], signal: null }]} sessionSignal={null} />);
    expect(screen.getByText("No reported signals were recorded for this session.")).toBeInTheDocument();
  });
});
