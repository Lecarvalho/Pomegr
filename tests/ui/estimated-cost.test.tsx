import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MonitorState } from "../../shared/monitor-contract";
import { SessionDetailsPanel } from "../../app/components/dashboard/SessionDetailsPanel";
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

  it("shows a captured provider estimate in session details", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 1.2345, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-09T12:00:00.000Z" },
    };

    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical={false} /></LiveClockProvider>);

    expect(screen.getByRole("heading", { name: "Cost estimate" })).toBeVisible();
    expect(screen.getByText("Claude Code API list-rate estimate")).toBeInTheDocument();
    expect(within(document.querySelector(".sessionCostDetail")!).getByText("$1.23")).toBeInTheDocument();
    expect(screen.getByText(/Reference only — not a bill or subscription spend\. Observed/)).toBeInTheDocument();
  });

  it("keeps sub-cent precision for a historical estimate", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 0.0042, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-09T12:00:00.000Z" },
    };

    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical /></LiveClockProvider>);

    expect(screen.getByRole("heading", { name: "Cost estimate" })).toBeVisible();
    expect(within(document.querySelector(".sessionCostDetail")!).getByText("$0.0042")).toBeInTheDocument();
  });

  it("hides only the estimate when the display preference is off", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 1.25, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-09T12:00:00.000Z" },
    };
    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical={false} showEstimatedCost={false} /></LiveClockProvider>);
    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cost estimate" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Session details" })).toBeInTheDocument();
  });

  it("omits unobserved and unrecorded placeholder estimates", () => {
    const session = { ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }), updatedAt: "2026-08-09T12:00:00.000Z" };
    const { rerender } = render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical={false} /></LiveClockProvider>);

    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cost estimate" })).not.toBeInTheDocument();
    rerender(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Claude Code", claudeCapabilities)} historical /></LiveClockProvider>);
    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByText(/estimate/i)).not.toBeInTheDocument();
  });

  it("omits unsupported estimates and ignores any inapplicable cost value", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      cost: { amount: 9, currency: "USD" as const, type: "estimated" as const, observedAt: "2026-08-11T12:00:00.000Z" },
    };
    render(<LiveClockProvider running={false}><SessionDetailsPanel state={detailsState(session, "Codex", codexCapabilities)} historical={false} /></LiveClockProvider>);

    expect(document.querySelector(".sessionCostDetail")).not.toBeInTheDocument();
    expect(screen.queryByText("$9.00")).not.toBeInTheDocument();
    expect(screen.queryByText(/estimate/i)).not.toBeInTheDocument();
  });
});
