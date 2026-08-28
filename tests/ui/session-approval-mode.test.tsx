import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MonitorState } from "../../shared/monitor-contract";
import { SessionHero } from "../../app/components/dashboard/SessionHero";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { claudeCapabilities, codexCapabilities, repositorySession } from "./dashboard-test-fixtures";

describe("session approval mode", () => {
  it("uses coarse early-session timing without redundant last-event copy", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-11T12:00:14.000Z");
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      startedAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("Less than 1m")).toBeInTheDocument();
    expect(screen.queryByText(/Last event/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\b(?:0m|14s ago)\b/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows the current provider-reported approval mode without a redundant observation age", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      approvalMode: { id: "auto", label: "Auto mode", observedAt: "2026-08-10T12:00:00.000Z", source: "provider" },
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("APPROVAL MODE")).toBeInTheDocument();
    const approvalMode = screen.getByText("Auto mode");
    expect(approvalMode).toHaveAttribute("title", "Latest recognized provider-reported mode.");
    expect(approvalMode.tagName).toBe("STRONG");
    expect(approvalMode).toHaveClass("sessionApprovalModeValue");
    expect(screen.queryByText(/Observed/)).not.toBeInTheDocument();
  });

  it("keeps the approval-mode slot visible until the provider reports a mode", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      approvalMode: null,
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText("APPROVAL MODE")).toBeInTheDocument();
    expect(screen.getByText("Not reported yet")).toHaveAttribute("title", "Waiting for the provider to report an approval mode for this session.");
  });

  it("labels historical approval state as the last recorded mode", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      updatedAt: "2026-08-10T12:05:00.000Z",
      approvalMode: { id: "accept_edits", label: "Accept edits", observedAt: null, source: "provider" },
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Claude Code" capabilities={claudeCapabilities} historical /></LiveClockProvider>);

    expect(screen.getByText("LAST APPROVAL MODE")).toBeInTheDocument();
    expect(screen.getByText("Accept edits")).toHaveAttribute("title", "Last provider-reported mode recorded for this session.");
  });

  it.each([
    ["untrusted", "Untrusted"],
    ["on_request", "On request"],
    ["granular", "Granular"],
    ["never", "Never"],
  ] as const)("renders the Codex %s approval policy through the exhaustive contract", (id, label) => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      approvalMode: { id, label, observedAt: "2026-08-11T12:00:00.000Z", source: "provider" },
    } satisfies NonNullable<MonitorState["session"]>;

    render(<LiveClockProvider running={false}><SessionHero session={session} source="Codex" capabilities={codexCapabilities} historical={false} /></LiveClockProvider>);

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
