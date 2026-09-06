import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MonitorState } from "../../shared/monitor-contract";
import { SessionDetailsPanel } from "../../app/components/dashboard/SessionDetailsPanel";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import { codexCapabilities, repositorySession } from "./dashboard-test-fixtures";

describe("Pomegr plugin metadata", () => {
  function detailsState(session: NonNullable<MonitorState["session"]>) {
    return {
      ...createEmptyMonitorState({ connected: true, source: "Codex", capabilities: codexCapabilities }),
      session,
    } satisfies MonitorState;
  }

  it("omits integration UI when no trusted observation exists", () => {
    const session = repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } });
    const { container } = render(<SessionDetailsPanel state={detailsState(session)} historical={false} loading={false} onRefresh={vi.fn()} />);

    expect(container.querySelector(".sessionPomegrIntegration")).not.toBeInTheDocument();
    expect(container.querySelector(".sessionEvidenceSummary")).toHaveTextContent("Approval mode, usage limits, machinery, activity");
    expect(container.querySelector(".sessionEvidenceSummary")).not.toHaveTextContent(/plugin|policy/i);
  });

  it("shows the active plugin and valid policy in summary and details", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      pomegrPlugin: { status: "active" as const, version: "0.4.1", policyStatus: "valid" as const, policyVersion: 7, observedAt: "2026-08-26T12:00:00.000Z" },
    };
    render(<SessionDetailsPanel state={detailsState(session)} historical={false} loading={false} onRefresh={vi.fn()} />);

    expect(document.querySelector(".sessionEvidenceSummary")).toHaveTextContent("plugin v0.4.1 · policy v7");
    expect(screen.getByRole("region", { name: "Pomegr integration" })).toHaveTextContent("Pluginv0.4.1PolicyValid · v7");
    expect(screen.getByText("Observed at session start")).toBeInTheDocument();
    expect(screen.getByText("Valid · v7").closest(".sessionPomegrPolicy")).toHaveClass("sessionPomegrPolicy-valid");
  });

  it("preserves recorded invalid policy state in historical sessions", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      pomegrPlugin: { status: "active" as const, version: null, policyStatus: "invalid" as const, policyVersion: 7, observedAt: "2026-08-26T12:00:00.000Z" },
    };
    render(<SessionDetailsPanel state={detailsState(session)} historical loading={false} onRefresh={vi.fn()} />);

    expect(document.querySelector(".sessionEvidenceSummary")).toHaveTextContent(/policy v7/i);
    expect(screen.getByText("Invalid — needs attention · v7")).toBeInTheDocument();
    expect(screen.getByText("Recorded for this session")).toBeInTheDocument();
  });
});
