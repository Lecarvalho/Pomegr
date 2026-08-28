import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MonitorState } from "../../shared/monitor-contract";
import { SessionDetailsPanel } from "../../app/components/dashboard/SessionDetailsPanel";
import { SessionHero } from "../../app/components/dashboard/SessionHero";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import { claudeCapabilities, codexCapabilities, repositorySession } from "./dashboard-test-fixtures";

describe("estimated session cost", () => {
  function detailsState(session: NonNullable<MonitorState["session"]>, source: "Claude Code" | "Codex", capabilities: typeof claudeCapabilities | typeof codexCapabilities) {
    return {
      ...createEmptyMonitorState({ connected: true, source, capabilities }),
      session,
    } satisfies MonitorState;
  }

  it("moves a captured provider estimate out of the hero and into session details", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 1.2345, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-09T12:00:00.000Z" },
    };
    const hero = render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(hero.container).not.toHaveTextContent("$1.23");
    expect(hero.container).not.toHaveTextContent(/cost estimate/i);
    hero.unmount();

    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical={false} loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);

    expect(screen.getByText("Claude Code API list-rate estimate")).toBeInTheDocument();
    expect(screen.getByText("$1.23")).toBeInTheDocument();
    expect(screen.getByText(/Reference only — not a bill or subscription spend\. Observed/)).toBeInTheDocument();
  });

  it("shows the recorded observation time for a historical estimate", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 0.0042, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-09T12:00:00.000Z" },
    };

    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);

    expect(screen.getByText("$0.0042")).toBeInTheDocument();
    expect(screen.getByText(/Recorded Aug 9/)).toBeInTheDocument();
  });

  it("omits unobserved and unrecorded placeholder estimates", () => {
    const session = { ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }), updatedAt: "2026-08-09T12:00:00.000Z" };
    const { rerender } = render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical={false} loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);

    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByText(/estimate/i)).not.toBeInTheDocument();
    rerender(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);
    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByText(/estimate/i)).not.toBeInTheDocument();
  });

  it("omits unsupported estimates and ignores any inapplicable cost value", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 9, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-11T12:00:00.000Z" },
    };
    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Codex", codexCapabilities)} historical={false} loading={false} onRefresh={vi.fn()} /></LiveClockProvider>);

    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByText("$9.00")).not.toBeInTheDocument();
    expect(screen.queryByText(/estimate/i)).not.toBeInTheDocument();
  });
});
