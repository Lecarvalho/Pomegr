import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    const { container } = render(<SessionDetailsPanel state={detailsState(session)} historical={false} />);

    expect(container.querySelector(".sessionPomegrIntegration")).not.toBeInTheDocument();
    expect(container.querySelector(".sessionEvidenceSummary")).toHaveTextContent("Approval mode, usage limits, machinery");
    expect(container.querySelector(".sessionEvidenceSummary")).not.toHaveTextContent(/plugin|policy/i);
  });

  it("preserves recorded invalid policy state in historical sessions", () => {
    const session = {
      ...repositorySession({ available: false, branch: "", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
      pomegrPlugin: { status: "active" as const, version: null, policyStatus: "invalid" as const, policyVersion: 7, observedAt: "2026-08-26T12:00:00.000Z" },
    };
    render(<SessionDetailsPanel state={detailsState(session)} historical />);

    expect(document.querySelector(".sessionEvidenceSummary")).toHaveTextContent(/policy v7/i);
    expect(screen.getByText("Invalid — needs attention · v7")).toBeInTheDocument();
    expect(screen.getByText("Recorded for this session")).toBeInTheDocument();
  });
});
